import fs from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import ts from 'typescript';
import { internalHelpers, InternalHelpers } from 'svelte2tsx';
import { loadConfig } from '@reintersect/svelte-load-config';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { Document, getLineOffsets, offsetAt, positionAt } from '../../../lib/documents';
import { configLoader } from '../../../lib/documents/configLoader';
import { getPackageInfo, importSvelte } from '../../../importPackage';
import { Logger } from '../../../logger';
import { normalizePath, pathToUrl } from '../../../utils';
import { SvelteDocumentSnapshot, SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';
import { mapAndFilterDiagnostics } from '../../typescript/features/DiagnosticsProvider';
import { isRsvelteEnabled, preloadRsvelte } from '../rsvelte';
import {
    findProjectTsconfig,
    findWorkspaceRoot,
    invalidateTsGoWorkspaceIndex,
    KitShadow,
    ShadowManager
} from './ShadowManager';
import { ResolvedTsGoEngine, resolveTsGoEngine } from './TsGoEngine';

/**
 * A diagnostic as it comes off a batch compiler run, positioned in the *generated* file.
 * Line and character are zero-based; `length` is a span in characters.
 */
export interface GeneratedDiagnostic {
    filePath: string | null;
    line: number;
    character: number;
    length: number;
    severity: DiagnosticSeverity;
    code: number;
    message: string;
    relatedInformation?: GeneratedDiagnosticRelatedInformation[];
}

export interface GeneratedDiagnosticRelatedInformation {
    filePath: string;
    line: number;
    character: number;
    length: number;
    message: string;
}

export interface FileDiagnostics {
    filePath: string;
    text: string;
    diagnostics: Diagnostic[];
}

export interface TsGoBatchOverlayOptions {
    /** Directory the check was invoked for. Used to locate a tsconfig when none is given. */
    workspacePath: string;
    /** Absolute path to the project's tsconfig/jsconfig. */
    tsconfigPath?: string;
    /** Absolute path to a svelte.config/vite.config, when the project's isn't in the usual place. */
    configPath?: string;
    /** Suppress loader/overlay progress logs for machine-readable CLI consumers. */
    quiet?: boolean;
}

/** Where SvelteKit puts route params and hooks when svelte.config.js doesn't say otherwise. */
const defaultKitFiles: InternalHelpers.KitFilesSettings = {
    paramsPath: 'src/params',
    serverHooksPath: 'src/hooks.server',
    clientHooksPath: 'src/hooks.client',
    universalHooksPath: 'src/hooks'
};

const BATCH_STATE_VERSION = 4;

interface StoredParserError {
    range: Range;
    severity: DiagnosticSeverity;
    message: string;
    code: number;
    source: 'ts' | 'js';
}

interface StoredShadowState {
    shadowPath: string;
    /** Full module-resolution/rewrite identity used by ordinary-source mirrors. */
    rewriteIdentity?: string;
    /** Present only for copied batch mirrors; transformed Svelte shadows omit it. */
    mirrorKind?: 'script' | 'json';
    /** `null` means the transform completed and the file parsed successfully. */
    parserError: StoredParserError | null;
    /** Fast-path identity: an exact match permits reuse before reading source contents. */
    sourceStat: StoredSourceStat;
    /** Content remains authoritative when a touch/copy changed only source metadata. */
    sourceContentStamp: string;
}

interface StoredSourceStat {
    size: string;
    mtimeNs: string;
    ctimeNs: string;
}

interface BatchState {
    version: typeof BATCH_STATE_VERSION;
    entries: Record<string, StoredShadowState>;
    /** Hash of every live mirror output path after the last successful reconciliation/prune. */
    cleanupIdentity?: string;
}

async function loadKitFilesSettings(
    projectPath: string,
    configPath: string | undefined
): Promise<InternalHelpers.KitFilesSettings> {
    try {
        const result = await loadConfig(configPath ?? projectPath, { traverse: false });
        const files: any =
            result && 'config' in result ? (result.config as any).kit?.files : undefined;
        if (!files) {
            return defaultKitFiles;
        }
        return {
            paramsPath: files.params ?? defaultKitFiles.paramsPath,
            serverHooksPath: files.hooks?.server ?? defaultKitFiles.serverHooksPath,
            clientHooksPath: files.hooks?.client ?? defaultKitFiles.clientHooksPath,
            universalHooksPath: files.hooks?.universal ?? defaultKitFiles.universalHooksPath
        };
    } catch {
        return defaultKitFiles;
    }
}

/**
 * Verify that a resolved package is reachable through `fromPath`'s real node_modules ancestry.
 * Some package-runner environments add adapter lookup locations even when `require.resolve`
 * receives explicit paths. Those are valid fallbacks, but they are not user dependencies and
 * copying shims there would make their own imports resolve from the wrong package tree.
 */
function isInstalledFrom(
    packageName: string,
    fromPath: string,
    resolvedPackagePath: string
): boolean {
    let current = normalizePath(fromPath);
    let resolvedRealPath: string;
    try {
        resolvedRealPath = normalizePath(fs.realpathSync.native(resolvedPackagePath));
    } catch {
        return false;
    }
    const packageParts = packageName.split('/');
    for (;;) {
        const candidate = join(current, 'node_modules', ...packageParts);
        try {
            if (normalizePath(fs.realpathSync.native(candidate)) === resolvedRealPath) {
                return true;
            }
        } catch {
            // Keep walking through the package's normal node_modules ancestry.
        }
        const parent = dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
}

/**
 * The language server's tsgo overlay, driven as a batch instead of over LSP.
 *
 * `svelte-check` wants exactly what the editor wants — every `.svelte` file standing in for a
 * `.tsx` shadow that tsgo can resolve and check — but it wants it once, for the whole project,
 * rather than incrementally for the file under the cursor. That is a difference in *driving*,
 * not in the overlay itself, so this reuses {@link ShadowManager} verbatim: the same shadow
 * layout, the same merged `rootDirs`/`paths`/`files`, the same dependency scan.
 *
 * Sharing the overlay is the whole point. The two previous tsgo paths in svelte-check each built
 * their own, and each got module resolution subtly wrong in a way that produces no error of its
 * own — imports fall through to svelte's ambient `declare module '*.svelte'` and every component
 * silently types as `SvelteComponent<Record<string, any>, any, any>`. On a real project that was
 * 100 and 41 phantom errors against an oracle of 0.
 */
export class TsGoBatchOverlay {
    private readonly shadows: ShadowManager;
    private readonly shimFiles: string[];
    private readonly transformDiagnostics = new Map<string, Diagnostic>();
    private materialised = false;

    private constructor(
        readonly engine: ResolvedTsGoEngine,
        readonly projectPath: string,
        private readonly tsconfigPath: string | undefined,
        shadows: ShadowManager,
        shimFiles: string[]
    ) {
        this.shadows = shadows;
        this.shimFiles = shimFiles;
    }

    /** Compatibility for callers which only need to display the resolved executable path. */
    get tsgoPath(): string {
        return this.engine.binPath;
    }

    get overlayTsconfigPath(): string {
        return this.shadows.overlayTsconfigPath;
    }

    /** Clear transform-relevant config state before a checker watch-mode rebuild. */
    static invalidateConfigCache(): void {
        configLoader.invalidateConfigs();
        invalidateTsGoWorkspaceIndex();
    }

    /** Clear package/source graph indexes without reloading unchanged Svelte config modules. */
    static invalidateWorkspaceIndex(): void {
        invalidateTsGoWorkspaceIndex();
    }

    /**
     * Build an overlay for a project, or return undefined when no tsgo binary can be found —
     * in which case the caller should fall back to the JS engine rather than fail.
     */
    static async create(options: TsGoBatchOverlayOptions): Promise<TsGoBatchOverlay | undefined> {
        if (options.quiet) {
            Logger.setLogErrorsOnly(true);
        }
        const engine = resolveTsGoEngine(options.workspacePath);
        if (!engine) {
            return undefined;
        }

        const tsconfigPath = options.tsconfigPath ?? findProjectTsconfig(options.workspacePath);
        const projectPath = tsconfigPath ? dirname(tsconfigPath) : options.workspacePath;
        const sourceRoot = findWorkspaceRoot(projectPath);

        // DocumentSnapshot reads accessors, namespace, custom-element and default-language
        // settings synchronously from Document.config. Prime the shared loader before any batch
        // Documents are transformed, and give an explicit --config the same scope as SvelteCheck.
        configLoader.setExplicitConfigScope(
            options.configPath
                ? {
                      configPath: options.configPath,
                      rootDirectory: projectPath
                  }
                : undefined
        );
        if (options.configPath) {
            await configLoader.loadConfigs(projectPath);
        }
        if (!options.configPath || sourceRoot !== projectPath) {
            await configLoader.loadConfigs(sourceRoot);
        }

        // The project's own Svelte compiler, so the transform matches what it builds with.
        const svelteCompiler = importSvelte(tsconfigPath || options.workspacePath);
        // Svelte 5 + `lang="ts"` only — the Rust JSDoc emission and version-4 mode produce
        // semantically different TSX (verified against this package's own sanity fixtures).
        const rsvelte = await preloadRsvelte(isRsvelteEnabled());
        const createSnapshotOptions = (
            compiler: ReturnType<typeof importSvelte>
        ): SvelteSnapshotOptions => {
            const svelteMajor = Number((compiler?.VERSION ?? '5').split('.')[0]);
            const useRust = !!rsvelte && svelteMajor >= 5;
            return {
                parse: compiler?.parse,
                version: compiler?.VERSION,
                // Unlike the editor, a batch check has no reason to keep going on a template that
                // doesn't parse: the Svelte diagnostic source reports the parse error, and checking
                // the script-only fallback would bury it under a cascade of consequences.
                transformOnTemplateError: false,
                typingsNamespace: 'svelteHTML',
                emitJsDoc: true,
                fastTransform: useRust
                    ? (text, opts) =>
                          opts.isTsFile
                              ? rsvelte!.svelte2tsx(text, {
                                    filename: opts.filename,
                                    isTsFile: true,
                                    mode: 'ts',
                                    version: '5',
                                    namespace: opts.namespace,
                                    accessors: opts.accessors
                                })
                              : undefined
                    : undefined,
                transformFingerprint: useRust ? rsvelte!.fingerprint : undefined
            };
        };
        const snapshotOptions = createSnapshotOptions(svelteCompiler);
        const snapshotOptionsByPackage = new Map<string, SvelteSnapshotOptions>();
        const resolveSnapshotOptions = (packageRoot: string): SvelteSnapshotOptions => {
            const key = normalizePath(packageRoot);
            const cached = snapshotOptionsByPackage.get(key);
            if (cached) {
                return cached;
            }
            let compiler = svelteCompiler;
            try {
                compiler = importSvelte(key, false);
            } catch (error) {
                Logger.debug(
                    `[tsgo] no package-local Svelte compiler at ${key}; using the project compiler`,
                    error
                );
            }
            const resolved = createSnapshotOptions(compiler);
            snapshotOptionsByPackage.set(key, resolved);
            return resolved;
        };

        // The generated code references `svelteHTML`, `__sveltets_*` and friends, which live in
        // svelte2tsx's shim d.ts files.
        //
        // The last argument is load-bearing. Those shims contain `import('svelte')` type
        // references that resolve relative to whichever directory they are read from; left in
        // this package's own `dist`, they drag *our* Svelte into the user's program as a second
        // ambient `declare module 'svelte'`. When the shims sort first, that copy wins the
        // merge, `ComponentProps<T>` resolves to the Svelte 4 definition and collapses to
        // `never` for every Svelte 5 component. Passing a hidden-folder path copies them next to
        // the user's own Svelte instead, so there is only ever one.
        // Only relocate the global shims into the workspace when the workspace actually owns
        // the Svelte package they import. A first overlay creation makes `node_modules/.cache`;
        // on the next run `get_global_types` otherwise mistakes that bare node_modules directory
        // for a package installation, copies the shims there, and every `import('svelte')` inside
        // them becomes TS2307. That made identical cold and warm checks disagree in projects
        // which rely on the language server's fallback compiler.
        let resolvedProjectSvelte = true;
        let sveltePackageInfo: ReturnType<typeof getPackageInfo>;
        try {
            sveltePackageInfo = getPackageInfo('svelte', projectPath, false);
        } catch {
            resolvedProjectSvelte = false;
            sveltePackageInfo = getPackageInfo('svelte', projectPath);
        }
        const hasProjectSvelte =
            resolvedProjectSvelte && isInstalledFrom('svelte', projectPath, sveltePackageInfo.path);
        let svelteTsPath: string;
        try {
            svelteTsPath = dirname(require.resolve('svelte2tsx'));
        } catch {
            svelteTsPath = __dirname;
        }
        const shimFiles = internalHelpers.get_global_types(
            ts.sys,
            sveltePackageInfo.version.major === 3,
            sveltePackageInfo.path,
            svelteTsPath,
            hasProjectSvelte ? projectPath : undefined
        );

        const shimsByPackage = new Map<string, string[]>();
        const resolveShims = (packageRoot: string): string[] => {
            const key = normalizePath(packageRoot);
            const cached = shimsByPackage.get(key);
            if (cached) {
                return cached;
            }
            let resolved = shimFiles;
            try {
                const packageSvelte = getPackageInfo('svelte', key, false);
                if (!isInstalledFrom('svelte', key, packageSvelte.path)) {
                    throw new Error(`Svelte is not installed in ${key}'s node_modules ancestry`);
                }
                resolved = internalHelpers.get_global_types(
                    ts.sys,
                    packageSvelte.version.major === 3,
                    packageSvelte.path,
                    svelteTsPath,
                    key
                );
            } catch (error) {
                Logger.debug(
                    `[tsgo] no package-local Svelte shims at ${key}; using project shims`,
                    error
                );
            }
            shimsByPackage.set(key, resolved);
            return resolved;
        };

        const shadows = new ShadowManager({
            projectPath,
            sourceRoot,
            tsconfigPath,
            snapshotOptions,
            resolveSnapshotOptions,
            resolveShims,
            kitFiles: await loadKitFilesSettings(projectPath, options.configPath)
        });
        // Fingerprints are computed synchronously when the overlay config is written. Prime the
        // effective config for external raw-component dependencies now; otherwise their first
        // fingerprint records "no config", materialisation asynchronously installs a fallback,
        // and every second run needlessly retransforms them once more.
        await Promise.all(
            shadows.findDependencySvelteFiles().map((file) => configLoader.awaitConfig(file))
        );

        return new TsGoBatchOverlay(engine, projectPath, tsconfigPath, shadows, shimFiles);
    }

    /**
     * Write the overlay tsconfig and a `.tsx` shadow for every `.svelte` file the project can
     * reach, then forget the snapshots again.
     *
     * Snapshots are dropped deliberately. Holding one per file would keep the generated text and
     * decoded mappings for the whole project alive for the entire run, and the only files whose
     * mappings are ever needed are the ones tsgo reports a diagnostic on — typically a handful.
     * {@link mapDiagnostics} re-transforms those on demand; svelte2tsx costs about a millisecond
     * a file, and the input is byte-identical, so the mapping is the same one that was written.
     */
    async materialise(): Promise<{
        shadowCount: number;
        transformedCount: number;
        reusedCount: number;
        writtenCount: number;
        durationMs: number;
    }> {
        const started = Date.now();
        this.shadows.prepareBatchModuleMirrors();
        this.shadows.writeOverlayTsconfig(this.shimFiles);

        // parseBaseConfig is authoritative. The broad workspace scan is still needed for
        // components reached through package boundaries, but it must never be allowed to drop an
        // explicit root merely because it lives in build/, a hidden directory or very deep path.
        const declarationBackedRoots = new Set(
            this.shadows.getDeclarationBackedProjectSvelteFileNames().map(normalizePath)
        );
        const files = Array.from(
            new Set(
                [
                    ...this.shadows.getProjectSvelteFileNames(),
                    ...this.shadows.findProjectSvelteFiles(),
                    ...this.shadows.findDependencySvelteFiles(),
                    ...this.shadows.getBatchMaterializedSvelteFiles()
                ]
                    .filter((file) => !declarationBackedRoots.has(normalizePath(file)))
                    .map(normalizePath)
            )
        );

        const written = new Set<string>();
        const previousState = this.readBatchState();
        const nextState: BatchState = { version: BATCH_STATE_VERSION, entries: {} };
        const failures: Error[] = [];
        let transformedCount = 0;
        let reusedCount = 0;
        let writtenCount = 0;
        for (const filePath of files) {
            const shadowPath = normalizePath(this.shadows.getShadowPath(filePath));
            const previous = previousState.entries[filePath];
            let currentStat: StoredSourceStat | undefined;
            try {
                currentStat = readSourceStat(filePath);
            } catch {
                // The transform path below owns the deterministic per-file failure message.
            }
            const reuse = (state: StoredShadowState) => {
                written.add(shadowPath);
                nextState.entries[filePath] = state;
                if (state.parserError) {
                    this.transformDiagnostics.set(filePath, state.parserError);
                }
                reusedCount++;
            };

            // The overwhelmingly common warm path: compare nanosecond stat identity and the
            // package transform fingerprint before reading even one source byte.
            if (
                previous?.shadowPath === shadowPath &&
                previous.rewriteIdentity === this.shadows.batchRewriteIdentity &&
                currentStat &&
                sameSourceStat(previous.sourceStat, currentStat) &&
                this.shadows.isTransformFingerprintCurrent(filePath) &&
                fs.statSync(shadowPath, { throwIfNoEntry: false })?.isFile()
            ) {
                reuse(previous);
                continue;
            }

            try {
                const source = readSourceWithIdentity(filePath, currentStat);
                // A touch, checkout or copy can change metadata without changing content. The
                // content stamp proves the existing output is still authoritative, while the
                // package fingerprint prevents reuse across compiler/config/transform changes.
                if (
                    previous?.shadowPath === shadowPath &&
                    previous.rewriteIdentity === this.shadows.batchRewriteIdentity &&
                    previous.sourceContentStamp === source.contentStamp &&
                    this.shadows.isTransformFingerprintCurrent(filePath) &&
                    fs.statSync(shadowPath, { throwIfNoEntry: false })?.isFile()
                ) {
                    reuse({ ...previous, sourceStat: source.stat });
                    continue;
                }
                const document = new Document(pathToUrl(filePath), source.text);
                await document.configPromise;
                const snapshot = this.shadows.transform(document);
                const generatedText = this.shadows.rewriteBatchModuleSpecifiers(
                    snapshot.getFullText(),
                    filePath
                );
                const changed = this.shadows.writeShadow(shadowPath, generatedText);
                if (changed) {
                    writtenCount++;
                }
                if (
                    !changed &&
                    (!fs.existsSync(shadowPath) ||
                        fs.readFileSync(shadowPath, 'utf-8') !== generatedText)
                ) {
                    throw new Error(`could not write current shadow ${shadowPath}`);
                }
                if (fs.existsSync(shadowPath)) {
                    written.add(shadowPath);
                }

                const parserError: StoredParserError | null = snapshot.parserError
                    ? {
                          range: snapshot.parserError.range,
                          severity: DiagnosticSeverity.Error,
                          source: snapshot.scriptKind === ts.ScriptKind.TS ? 'ts' : 'js',
                          message: snapshot.parserError.message,
                          code: snapshot.parserError.code
                      }
                    : null;
                nextState.entries[filePath] = {
                    shadowPath,
                    rewriteIdentity: this.shadows.batchRewriteIdentity,
                    parserError,
                    sourceStat: source.stat,
                    sourceContentStamp: source.contentStamp
                };
                if (parserError) {
                    this.transformDiagnostics.set(filePath, parserError);
                }
                transformedCount++;
            } catch (e) {
                this.shadows.removeShadow(shadowPath);
                failures.push(
                    new Error(
                        `could not materialise shadow for ${filePath}: ${
                            e instanceof Error ? e.message : String(e)
                        }`
                    )
                );
            }
        }

        // When a component has an adjacent rune module, ordinary source roots and barrels must
        // enter the same mirror as the component. Otherwise native extension substitution finds
        // the real `Foo.svelte.ts` before rootDirs can route `Foo.svelte` to generated TSX.
        for (const {
            originalPath,
            mirrorPath,
            kind
        } of this.shadows.getBatchSourceMirrorEntries()) {
            const previous = previousState.entries[originalPath];
            const rewriteIdentity =
                kind === 'script' ? this.shadows.batchRewriteIdentity : undefined;
            let currentStat: StoredSourceStat | undefined;
            try {
                currentStat = readSourceStat(originalPath);
            } catch {
                // The copy path below reports the deterministic failure.
            }
            const reuse = (state: StoredShadowState) => {
                written.add(mirrorPath);
                nextState.entries[originalPath] = state;
                reusedCount++;
            };
            if (
                previous?.shadowPath === mirrorPath &&
                previous.rewriteIdentity === rewriteIdentity &&
                previous.mirrorKind === kind &&
                currentStat &&
                sameSourceStat(previous.sourceStat, currentStat) &&
                fs.statSync(mirrorPath, { throwIfNoEntry: false })?.isFile()
            ) {
                reuse(previous);
                continue;
            }

            try {
                const source = readSourceWithIdentity(originalPath, currentStat);
                if (
                    previous?.shadowPath === mirrorPath &&
                    previous.rewriteIdentity === rewriteIdentity &&
                    previous.mirrorKind === kind &&
                    previous.sourceContentStamp === source.contentStamp &&
                    fs.statSync(mirrorPath, { throwIfNoEntry: false })?.isFile()
                ) {
                    reuse({ ...previous, sourceStat: source.stat });
                    continue;
                }
                const mirroredText =
                    kind === 'script'
                        ? this.shadows.rewriteBatchModuleSpecifiers(source.text, originalPath)
                        : source.text;
                const changed = this.shadows.writeShadow(mirrorPath, mirroredText);
                if (changed) {
                    writtenCount++;
                }
                if (
                    !changed &&
                    (!fs.existsSync(mirrorPath) ||
                        fs.readFileSync(mirrorPath, 'utf8') !== mirroredText)
                ) {
                    throw new Error(`could not write current source mirror ${mirrorPath}`);
                }
                written.add(mirrorPath);
                nextState.entries[originalPath] = {
                    shadowPath: mirrorPath,
                    rewriteIdentity,
                    mirrorKind: kind,
                    parserError: null,
                    sourceStat: source.stat,
                    sourceContentStamp: source.contentStamp
                };
                transformedCount++;
            } catch (e) {
                this.shadows.removeShadow(mirrorPath);
                failures.push(
                    new Error(
                        `could not materialise source mirror for ${originalPath}: ${
                            e instanceof Error ? e.message : String(e)
                        }`
                    )
                );
            }
        }

        if (failures.length) {
            throw new AggregateError(
                failures,
                `failed to materialise ${failures.length} shadow(s):\n${failures
                    .map((failure) => `- ${failure.message}`)
                    .join('\n')}`
            );
        }

        // Stale shadows are still roots of the project, so a component that was deleted since
        // the last run would keep reporting errors from a file that no longer exists. Kit
        // shadows were written during `writeOverlayTsconfig` and are live too.
        for (const kitShadowPath of this.shadows.getKitShadowPaths()) {
            written.add(kitShadowPath);
        }
        const supportPaths = this.shadows.writeBatchMirrorPackageScopes();
        for (const supportPath of supportPaths) {
            written.add(supportPath);
        }
        nextState.cleanupIdentity = batchCleanupIdentity(written);
        const previousOwnedPaths = Object.values(previousState.entries)
            .filter((entry) => !!entry.mirrorKind || entry.rewriteIdentity !== undefined)
            .map((entry) => entry.shadowPath);
        const liveOwnedPaths = Object.values(nextState.entries)
            .filter((entry) => !!entry.mirrorKind || entry.rewriteIdentity !== undefined)
            .map((entry) => entry.shadowPath)
            .concat(supportPaths);
        // A normal warm check used to recursively readdir/stat the complete shared mirror even
        // after every source and output had proved reusable. The persisted live-path identity
        // makes that walk unnecessary when this manager owns exactly the same outputs and its
        // collision ownership record is still intact. Any deletion/rename/layout/config/source
        // change makes one of these identities differ and takes the full reconciliation path.
        const cleanupIsCurrent =
            transformedCount === 0 &&
            writtenCount === 0 &&
            previousState.cleanupIdentity === nextState.cleanupIdentity &&
            sameBatchOutputIdentities(previousState.entries, nextState.entries) &&
            this.shadows.isBatchMirrorOwnershipCurrent(liveOwnedPaths);
        if (!cleanupIsCurrent) {
            this.shadows.reconcileBatchMirrorOwnership(previousOwnedPaths, liveOwnedPaths);
            this.shadows.pruneOrphanedShadows(written);
        }
        this.writeBatchState(nextState);
        this.shadows.commitFingerprints();
        this.shadows.clearSnapshots();
        this.materialised = true;

        return {
            shadowCount: written.size,
            transformedCount,
            reusedCount,
            writtenCount,
            durationMs: Date.now() - started
        };
    }

    /**
     * The `.svelte` files this check is answerable for: the ones the user's tsconfig resolves,
     * not the ones that merely needed a shadow.
     *
     * The distinction matters as soon as the project sits in a workspace. Shadows are written
     * for every `.svelte` file under the workspace root and inside dependencies, because a
     * component imported across a package boundary still has to resolve — but reporting Svelte
     * compiler warnings for all of those would mean a check of one package printing warnings
     * for every other package in the repo.
     */
    listProjectSvelteFiles(): string[] {
        if (!this.materialised) {
            throw new Error('materialise() must run before the project file list is known');
        }
        return this.shadows.getProjectSvelteFileNames();
    }

    /**
     * Translate the compiler's own file list back into files the user recognises.
     *
     * This is what the check is really answerable for. A project's tsconfig names its roots, but
     * the program is everything those roots reach — in a workspace that includes components from
     * sibling packages, which the classic engine reports Svelte compiler warnings for and which a
     * roots-only view would silently skip.
     */
    mapProgramFiles(programFiles: string[]): { all: string[]; svelte: string[] } {
        const all: string[] = [];
        const svelte: string[] = [];
        const seen = new Set<string>();
        for (const filePath of programFiles) {
            const original = this.shadows.getOriginalPath(filePath) ?? normalizePath(filePath);
            if (seen.has(original)) {
                continue;
            }
            seen.add(original);
            all.push(original);
            if (original.endsWith('.svelte')) {
                svelte.push(original);
            }
        }
        // Native TypeScript consumes an adjacent `.d.svelte.ts` declaration instead of the raw
        // component. The raw configured root still belongs to the independent Svelte/CSS pass.
        for (const original of this.shadows.getDeclarationBackedProjectSvelteFileNames()) {
            if (seen.has(original)) {
                continue;
            }
            seen.add(original);
            all.push(original);
            svelte.push(original);
        }
        return { all, svelte };
    }

    /**
     * Translate diagnostics reported against generated files back onto the `.svelte` sources
     * they came from. Diagnostics on ordinary `.ts`/`.js` files pass through unchanged.
     */
    async mapDiagnostics(
        diagnostics: GeneratedDiagnostic[],
        fallbackPath: string,
        programFiles?: string[]
    ): Promise<FileDiagnostics[]> {
        if (!this.materialised) {
            throw new Error('materialise() must run before diagnostics can be mapped');
        }

        const byFile = new Map<string, GeneratedDiagnostic[]>();
        const mergedDiagnostics = [...diagnostics];
        const seenDiagnostics = new Set(diagnostics.map(generatedDiagnosticIdentity));
        for (const diagnostic of this.baseConfigurationDiagnostics()) {
            // Native tsgo can point through `extends` to the exact value in the user config,
            // whereas parseJsonConfigFileContent only gives our fallback diagnostic an unknown
            // 0:0 position. Prefer the native user-file copy when its semantics match.
            const nativeUserConfigCopy = diagnostics.some(
                (native) =>
                    !!native.filePath &&
                    /\.json$/i.test(native.filePath) &&
                    native.severity === diagnostic.severity &&
                    native.code === diagnostic.code &&
                    native.message === diagnostic.message
            );
            if (nativeUserConfigCopy) {
                continue;
            }
            const identity = generatedDiagnosticIdentity(diagnostic);
            if (!seenDiagnostics.has(identity)) {
                seenDiagnostics.add(identity);
                mergedDiagnostics.push(diagnostic);
            }
        }
        for (const diagnostic of mergedDiagnostics) {
            const key = normalizePath(diagnostic.filePath ?? fallbackPath);
            const existing = byFile.get(key);
            if (existing) {
                existing.push(diagnostic);
            } else {
                byFile.set(key, [diagnostic]);
            }
        }

        const includedTransformFiles = programFiles
            ? new Set(programFiles.map(normalizePath))
            : undefined;
        const results: FileDiagnostics[] = [];
        for (const [filePath, diagnostic] of this.transformDiagnostics) {
            if (includedTransformFiles && !includedTransformFiles.has(filePath)) {
                continue;
            }
            let text: string;
            try {
                text = fs.readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }
            results.push({ filePath, text, diagnostics: [diagnostic] });
        }
        for (const [filePath, fileDiagnostics] of byFile) {
            const sourceMirrorOriginal = this.shadows.getBatchSourceOriginalPath(filePath);
            if (sourceMirrorOriginal) {
                const mapped = await this.mapSourceMirrorDiagnostics(
                    sourceMirrorOriginal,
                    fileDiagnostics
                );
                if (mapped) {
                    results.push(mapped);
                }
                continue;
            }
            const kitShadow = this.shadows.getKitShadowByShadowPath(filePath);
            if (kitShadow) {
                const mapped = await this.mapKitDiagnostics(kitShadow, fileDiagnostics);
                if (mapped) {
                    results.push(mapped);
                }
                continue;
            }

            // A Kit file that has a shadow can still be dragged into the program by its own
            // generated `$types.d.ts`, which imports it by real path. Its untransformed self
            // reports exactly the implicit-`any` errors the shadow exists to prevent, so those
            // are dropped in favour of the shadow's.
            if (this.shadows.hasKitShadow(filePath)) {
                continue;
            }

            const originalPath = this.shadows.getOriginalPath(filePath);
            if (!originalPath) {
                results.push(await this.passThrough(filePath, fileDiagnostics));
                continue;
            }
            // A parser-error shadow is only a script fallback. Every native diagnostic against it
            // has a meaningless position, so the materialisation diagnostic is the whole answer.
            if (
                this.transformDiagnostics.has(originalPath) &&
                (!includedTransformFiles || includedTransformFiles.has(originalPath))
            ) {
                continue;
            }
            const mapped = await this.mapShadowDiagnostics(originalPath, fileDiagnostics);
            if (mapped) {
                results.push(mapped);
            }
        }
        return results;
    }

    /**
     * Whether native tsgo independently reported a configuration error already found while
     * parsing the user's config. The parser copy carries the exact user-file span; the native
     * copy is commonly attributed to the generated overlay and therefore only has 0:0.
     */
    matchesBaseConfigurationDiagnostic(diagnostic: GeneratedDiagnostic): boolean {
        return this.baseConfigurationDiagnostics().some(
            (base) =>
                base.severity === diagnostic.severity &&
                base.code === diagnostic.code &&
                base.message === diagnostic.message
        );
    }

    /** The matching base diagnostic is an error, not a warning/suggestion. */
    matchesBaseConfigurationError(diagnostic: GeneratedDiagnostic): boolean {
        return (
            diagnostic.severity === DiagnosticSeverity.Error &&
            this.matchesBaseConfigurationDiagnostic(diagnostic)
        );
    }

    /**
     * Map diagnostics on a SvelteKit shadow back onto the route file the user wrote.
     *
     * Kit shadows are not built by svelte2tsx and carry no source map — the transform is a list
     * of insertions, so the mapping is arithmetic: subtract everything inserted before this
     * point. Positions landing *inside* an insertion collapse to where it was inserted, which is
     * the closest thing to a truthful answer for code the user never wrote.
     */
    private async mapKitDiagnostics(
        kitShadow: KitShadow,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics | undefined> {
        let sourceText: string;
        let generatedText: string;
        try {
            sourceText = fs.readFileSync(kitShadow.originalPath, 'utf-8');
            generatedText = fs.readFileSync(kitShadow.shadowPath, 'utf-8');
        } catch {
            return undefined;
        }

        const sourceLineOffsets = getLineOffsets(sourceText);
        const generatedLineOffsets = getLineOffsets(generatedText);
        const source = /\.(ts|tsx|mts|cts)$/.test(kitShadow.originalPath) ? 'ts' : 'js';

        return {
            filePath: kitShadow.originalPath,
            text: sourceText,
            diagnostics: await Promise.all(
                fileDiagnostics.map(async (diagnostic) => {
                    const generatedOffset = offsetAt(
                        { line: diagnostic.line, character: diagnostic.character },
                        generatedText,
                        generatedLineOffsets
                    );
                    const { pos: start } = internalHelpers.toOriginalPos(
                        generatedOffset,
                        kitShadow.addedCode
                    );
                    const { pos: end } = internalHelpers.toOriginalPos(
                        generatedOffset + diagnostic.length,
                        kitShadow.addedCode
                    );
                    return {
                        range: Range.create(
                            positionAt(start, sourceText, sourceLineOffsets),
                            positionAt(end, sourceText, sourceLineOffsets)
                        ),
                        severity: diagnostic.severity,
                        code: diagnostic.code,
                        message: diagnostic.message,
                        source,
                        relatedInformation: await this.mapRelatedInformation(
                            diagnostic.relatedInformation
                        )
                    };
                })
            )
        };
    }

    private async mapShadowDiagnostics(
        originalPath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics | undefined> {
        let sourceText: string;
        try {
            sourceText = fs.readFileSync(originalPath, 'utf-8');
        } catch {
            // The file went away between the check and the report. Nothing useful to say.
            return undefined;
        }

        const document = new Document(pathToUrl(originalPath), sourceText);
        await document.configPromise;
        const snapshot = this.shadows.transform(document);
        this.shadows.deleteSnapshot(originalPath);

        // The generated code is a fallback extract of the script block, so every position in it
        // is meaningless. Report the parse error and nothing else, as the editor does.
        if (snapshot.parserError) {
            return {
                filePath: originalPath,
                text: sourceText,
                diagnostics: [
                    {
                        range: snapshot.parserError.range,
                        severity: DiagnosticSeverity.Error,
                        source: snapshot.scriptKind === ts.ScriptKind.TS ? 'ts' : 'js',
                        message: snapshot.parserError.message,
                        code: snapshot.parserError.code
                    }
                ]
            };
        }

        const tsDiagnostics = this.toTsDiagnostics(
            snapshot,
            fileDiagnostics.map((diagnostic) => ({
                ...diagnostic,
                message: this.shadows.restoreBatchModuleSpecifiers(diagnostic.message)
            }))
        );
        const diagnostics: Diagnostic[] = [];
        for (const { tsDiagnostic, generatedDiagnostic } of tsDiagnostics) {
            const mapped = mapAndFilterDiagnostics([tsDiagnostic], document, snapshot);
            const relatedInformation = await this.mapRelatedInformation(
                generatedDiagnostic.relatedInformation
            );
            diagnostics.push(
                ...mapped.map((diagnostic) => ({
                    ...diagnostic,
                    ...(relatedInformation?.length ? { relatedInformation } : {})
                }))
            );
        }
        // A native diagnostic can live entirely in svelte2tsx-generated scaffolding. The
        // classic mapper intentionally filters it, and an empty mapped entry must not make the
        // source look like a member of a program that failed configuration before construction.
        if (!diagnostics.length) {
            return undefined;
        }
        return {
            filePath: originalPath,
            text: sourceText,
            diagnostics
        };
    }

    /**
     * Ordinary TS/JS mirrors only replace equal-length module specifiers. Their line/character
     * space is therefore identical to the authored source and needs no generated-code mapper.
     */
    private async mapSourceMirrorDiagnostics(
        originalPath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics | undefined> {
        let sourceText: string;
        try {
            sourceText = fs.readFileSync(originalPath, 'utf8');
        } catch {
            return undefined;
        }
        return {
            filePath: originalPath,
            text: sourceText,
            diagnostics: await Promise.all(
                fileDiagnostics.map(async (diagnostic): Promise<Diagnostic> => {
                    const relatedInformation = await this.mapRelatedInformation(
                        diagnostic.relatedInformation
                    );
                    return {
                        range: Range.create(
                            { line: diagnostic.line, character: diagnostic.character },
                            {
                                line: diagnostic.line,
                                character: diagnostic.character + diagnostic.length
                            }
                        ),
                        severity: diagnostic.severity,
                        code: diagnostic.code,
                        message: this.shadows.restoreBatchModuleSpecifiers(diagnostic.message),
                        ...(relatedInformation?.length ? { relatedInformation } : {})
                    };
                })
            )
        };
    }

    /**
     * Rebuild `ts.Diagnostic`s against the generated text.
     *
     * `mapAndFilterDiagnostics` is the same routine the JS engine uses, and it works in offsets
     * against a `ts.SourceFile` — so the line/character pairs the compiler printed have to be
     * turned back into offsets in the generated file before any of the Svelte-aware filtering
     * (Ω-marker regions, `moveBindingErrorMessage`, the false-positive suppressions) can run.
     */
    private toTsDiagnostics(
        snapshot: SvelteDocumentSnapshot,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Array<{ tsDiagnostic: ts.Diagnostic; generatedDiagnostic: GeneratedDiagnostic }> {
        const generatedText = snapshot.getFullText();
        const sourceFile = ts.createSourceFile(
            snapshot.filePath,
            generatedText,
            ts.ScriptTarget.Latest,
            true,
            snapshot.scriptKind
        );

        const converted: Array<{
            tsDiagnostic: ts.Diagnostic;
            generatedDiagnostic: GeneratedDiagnostic;
        }> = [];
        for (const diagnostic of fileDiagnostics) {
            let start: number;
            try {
                start = sourceFile.getPositionOfLineAndCharacter(
                    diagnostic.line,
                    diagnostic.character
                );
            } catch {
                // The generated file the compiler saw and the one we just rebuilt disagree,
                // which means the source changed under us. Dropping beats a wrong squiggle.
                continue;
            }
            converted.push({
                generatedDiagnostic: diagnostic,
                tsDiagnostic: {
                    file: sourceFile,
                    start,
                    length: diagnostic.length,
                    category:
                        diagnostic.severity === DiagnosticSeverity.Warning
                            ? ts.DiagnosticCategory.Warning
                            : ts.DiagnosticCategory.Error,
                    code: diagnostic.code,
                    messageText: diagnostic.message,
                    source: 'ts'
                }
            });
        }
        return converted;
    }

    /** Map related native locations with the same source/shadow rules as primary diagnostics. */
    private async mapRelatedInformation(
        related: GeneratedDiagnosticRelatedInformation[] | undefined
    ): Promise<Diagnostic['relatedInformation'] | undefined> {
        if (!related?.length) {
            return undefined;
        }
        const mapped = await Promise.all(
            related.map(async (item) => {
                const location = await this.mapGeneratedRelatedLocation(item);
                return location
                    ? {
                          location,
                          message: this.shadows.restoreBatchModuleSpecifiers(item.message)
                      }
                    : undefined;
            })
        );
        const retained = mapped.filter((item): item is NonNullable<typeof item> => !!item);
        return retained.length ? retained : undefined;
    }

    private async mapGeneratedRelatedLocation(
        related: GeneratedDiagnosticRelatedInformation
    ): Promise<{ uri: string; range: Range } | undefined> {
        const filePath = normalizePath(related.filePath);
        const generatedRange = (text: string): Range => {
            const lineOffsets = getLineOffsets(text);
            const start = offsetAt(
                { line: related.line, character: related.character },
                text,
                lineOffsets
            );
            return Range.create(
                positionAt(start, text, lineOffsets),
                positionAt(Math.min(text.length, start + related.length), text, lineOffsets)
            );
        };

        const kitShadow = this.shadows.getKitShadowByShadowPath(filePath);
        if (kitShadow) {
            try {
                const generatedText = fs.readFileSync(kitShadow.shadowPath, 'utf8');
                const sourceText = fs.readFileSync(kitShadow.originalPath, 'utf8');
                const generated = generatedRange(generatedText);
                const generatedLineOffsets = getLineOffsets(generatedText);
                const sourceLineOffsets = getLineOffsets(sourceText);
                const start = internalHelpers.toOriginalPos(
                    offsetAt(generated.start, generatedText, generatedLineOffsets),
                    kitShadow.addedCode
                ).pos;
                const end = internalHelpers.toOriginalPos(
                    offsetAt(generated.end, generatedText, generatedLineOffsets),
                    kitShadow.addedCode
                ).pos;
                return {
                    uri: pathToUrl(kitShadow.originalPath),
                    range: Range.create(
                        positionAt(start, sourceText, sourceLineOffsets),
                        positionAt(end, sourceText, sourceLineOffsets)
                    )
                };
            } catch {
                return undefined;
            }
        }

        const sourceMirrorOriginal = this.shadows.getBatchSourceOriginalPath(filePath);
        if (sourceMirrorOriginal) {
            try {
                const sourceText = fs.readFileSync(sourceMirrorOriginal, 'utf8');
                return {
                    uri: pathToUrl(sourceMirrorOriginal),
                    range: generatedRange(sourceText)
                };
            } catch {
                return undefined;
            }
        }

        const originalPath = this.shadows.getOriginalPath(filePath);
        if (originalPath) {
            try {
                const sourceText = fs.readFileSync(originalPath, 'utf8');
                const document = new Document(pathToUrl(originalPath), sourceText);
                await document.configPromise;
                const snapshot = this.shadows.transform(document);
                const generated = generatedRange(snapshot.getFullText());
                const start = snapshot.getOriginalPosition(generated.start);
                const end = snapshot.getOriginalPosition(generated.end);
                this.shadows.deleteSnapshot(originalPath);
                if (start.line < 0 || end.line < 0) {
                    return undefined;
                }
                return {
                    uri: pathToUrl(originalPath),
                    range: Range.create(start, end)
                };
            } catch {
                this.shadows.deleteSnapshot(originalPath);
                return undefined;
            }
        }

        try {
            const text = fs.readFileSync(filePath, 'utf8');
            return { uri: pathToUrl(filePath), range: generatedRange(text) };
        } catch {
            // The file may have disappeared between native checking and mapping. Dropping a
            // stale related location is safer than leaking a generated/nonexistent URI.
            return undefined;
        }
    }

    /** Diagnostics on a real file the user wrote: reported where the compiler put them. */
    private async passThrough(
        filePath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics> {
        let text = '';
        try {
            text = fs.readFileSync(filePath, 'utf-8');
        } catch {
            // A diagnostic that names no file (config errors) lands here.
        }
        return {
            filePath,
            text,
            diagnostics: await Promise.all(
                fileDiagnostics.map(async (diagnostic): Promise<Diagnostic> => {
                    const relatedInformation = await this.mapRelatedInformation(
                        diagnostic.relatedInformation
                    );
                    return {
                        range: Range.create(
                            { line: diagnostic.line, character: diagnostic.character },
                            {
                                line: diagnostic.line,
                                character: diagnostic.character + diagnostic.length
                            }
                        ),
                        severity: diagnostic.severity,
                        code: diagnostic.code,
                        message: diagnostic.message,
                        ...(relatedInformation?.length ? { relatedInformation } : {}),
                        data: { positionUnknown: diagnostic.filePath === null }
                    };
                })
            )
        };
    }

    /** Where the overlay keeps its scaffolding, so callers can point a build info file there. */
    get overlayPath(): string {
        return this.shadows.overlayPath;
    }

    /** The tsconfig this overlay derives from, if the project had one. */
    get baseTsconfigPath(): string | undefined {
        return this.tsconfigPath;
    }

    /**
     * The overlay replaces the user's root `files` with resolved roots plus native shims. That
     * intentionally lets empty/solution configs own editor documents, but it also makes tsgo
     * stop reporting TS18002/TS18003 from a genuinely empty user config. Preserve the config
     * parser's original diagnostics and merge them with native output against the user file.
     */
    private baseConfigurationDiagnostics(): GeneratedDiagnostic[] {
        return this.shadows.getBaseConfigDiagnostics().map((diagnostic) => {
            const position =
                diagnostic.file && diagnostic.start != null
                    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
                    : { line: 0, character: 0 };
            return {
                filePath: diagnostic.file?.fileName ?? null,
                line: position.line,
                character: position.character,
                length: diagnostic.length ?? 1,
                severity: mapTsDiagnosticSeverity(diagnostic.category),
                code: diagnostic.code,
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                relatedInformation: diagnostic.relatedInformation
                    ?.filter(
                        (
                            related
                        ): related is ts.DiagnosticRelatedInformation & {
                            file: ts.SourceFile;
                            start: number;
                        } => !!related.file && related.start != null
                    )
                    .map((related) => {
                        const relatedPosition = related.file.getLineAndCharacterOfPosition(
                            related.start
                        );
                        return {
                            filePath: related.file.fileName,
                            line: relatedPosition.line,
                            character: relatedPosition.character,
                            length: related.length ?? 1,
                            message: ts.flattenDiagnosticMessageText(related.messageText, '\n')
                        };
                    })
            };
        });
    }

    private get batchStatePath(): string {
        return join(this.overlayPath, 'batch-state.json');
    }

    private readBatchState(): BatchState {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.batchStatePath, 'utf-8')) as BatchState;
            if (parsed.version === BATCH_STATE_VERSION && parsed.entries) {
                return parsed;
            }
        } catch {
            // A missing, old or interrupted state file makes shadows cold, never incorrectly fresh.
        }
        return { version: BATCH_STATE_VERSION, entries: {} };
    }

    private writeBatchState(state: BatchState): void {
        const tempPath = `${this.batchStatePath}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(dirname(this.batchStatePath), { recursive: true });
            const contents = JSON.stringify(state);
            if (
                fs.statSync(this.batchStatePath, { throwIfNoEntry: false })?.isFile() &&
                fs.readFileSync(this.batchStatePath, 'utf8') === contents
            ) {
                return;
            }
            fs.writeFileSync(tempPath, contents);
            fs.renameSync(tempPath, this.batchStatePath);
        } catch (error) {
            Logger.debug('[tsgo] could not persist batch shadow state', error);
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // Best effort; a future run treats the absent final state as cold.
            }
        }
    }
}

function readSourceStat(filePath: string): StoredSourceStat {
    const stat = fs.statSync(filePath, { bigint: true });
    return {
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}

function sameSourceStat(
    left: StoredSourceStat | undefined,
    right: StoredSourceStat | undefined
): boolean {
    return (
        !!left &&
        !!right &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function batchCleanupIdentity(paths: Iterable<string>): string {
    return createHash('sha256')
        .update([...paths].map(normalizePath).sort().join('\0'))
        .digest('base64url');
}

function sameBatchOutputIdentities(
    previous: Record<string, StoredShadowState>,
    next: Record<string, StoredShadowState>
): boolean {
    const previousSources = Object.keys(previous);
    const nextSources = Object.keys(next);
    if (previousSources.length !== nextSources.length) {
        return false;
    }
    return nextSources.every((source) => {
        const left = previous[source];
        const right = next[source];
        return (
            !!left &&
            left.shadowPath === right.shadowPath &&
            left.rewriteIdentity === right.rewriteIdentity &&
            left.mirrorKind === right.mirrorKind &&
            left.sourceContentStamp === right.sourceContentStamp
        );
    });
}

function readSourceWithIdentity(
    filePath: string,
    initialStat?: StoredSourceStat
): { text: string; stat: StoredSourceStat; contentStamp: string } {
    let before = initialStat ?? readSourceStat(filePath);
    // A formatter/save can race materialisation. Retry once so the persisted stat identity and
    // content stamp always describe the exact bytes which produced the shadow.
    for (let attempt = 0; attempt < 2; attempt++) {
        const text = fs.readFileSync(filePath, 'utf8');
        const after = readSourceStat(filePath);
        if (sameSourceStat(before, after)) {
            return {
                text,
                stat: after,
                contentStamp: createHash('sha256').update(text, 'utf8').digest('base64url')
            };
        }
        before = after;
    }
    throw new Error(`source changed repeatedly while materialising ${filePath}`);
}

function generatedDiagnosticIdentity(diagnostic: GeneratedDiagnostic): string {
    return JSON.stringify([
        diagnostic.filePath,
        diagnostic.line,
        diagnostic.character,
        diagnostic.length,
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message
    ]);
}

function mapTsDiagnosticSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Warning:
            return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Suggestion:
            return DiagnosticSeverity.Hint;
        case ts.DiagnosticCategory.Message:
            return DiagnosticSeverity.Information;
        default:
            return DiagnosticSeverity.Error;
    }
}
