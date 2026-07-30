import fs from 'fs';
import { dirname } from 'path';
import ts from 'typescript';
import { internalHelpers, InternalHelpers } from 'svelte2tsx';
import { loadConfig } from '@sveltejs/load-config';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { Document, getLineOffsets, offsetAt, positionAt } from '../../../lib/documents';
import { getPackageInfo, importSvelte } from '../../../importPackage';
import { Logger } from '../../../logger';
import { normalizePath, pathToUrl } from '../../../utils';
import { SvelteDocumentSnapshot, SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';
import { mapAndFilterDiagnostics } from '../../typescript/features/DiagnosticsProvider';
import {
    findProjectTsconfig,
    findWorkspaceRoot,
    KitShadow,
    resolveTsGoPath,
    ShadowManager
} from './ShadowManager';

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
}

/** Where SvelteKit puts route params and hooks when svelte.config.js doesn't say otherwise. */
const defaultKitFiles: InternalHelpers.KitFilesSettings = {
    paramsPath: 'src/params',
    serverHooksPath: 'src/hooks.server',
    clientHooksPath: 'src/hooks.client',
    universalHooksPath: 'src/hooks'
};

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
    private materialised = false;

    private constructor(
        readonly tsgoPath: string,
        readonly projectPath: string,
        private readonly tsconfigPath: string | undefined,
        shadows: ShadowManager,
        shimFiles: string[]
    ) {
        this.shadows = shadows;
        this.shimFiles = shimFiles;
    }

    get overlayTsconfigPath(): string {
        return this.shadows.overlayTsconfigPath;
    }

    /**
     * Build an overlay for a project, or return undefined when no tsgo binary can be found —
     * in which case the caller should fall back to the JS engine rather than fail.
     */
    static async create(options: TsGoBatchOverlayOptions): Promise<TsGoBatchOverlay | undefined> {
        const tsgoPath = resolveTsGoPath(options.workspacePath);
        if (!tsgoPath) {
            return undefined;
        }

        const tsconfigPath = options.tsconfigPath ?? findProjectTsconfig(options.workspacePath);
        const projectPath = tsconfigPath ? dirname(tsconfigPath) : options.workspacePath;

        // The project's own Svelte compiler, so the transform matches what it builds with.
        const svelteCompiler = importSvelte(tsconfigPath || options.workspacePath);
        const snapshotOptions: SvelteSnapshotOptions = {
            parse: svelteCompiler?.parse,
            version: svelteCompiler?.VERSION,
            // Unlike the editor, a batch check has no reason to keep going on a template that
            // doesn't parse: the Svelte diagnostic source reports the parse error, and checking
            // the script-only fallback would bury it under a cascade of consequences.
            transformOnTemplateError: false,
            typingsNamespace: 'svelteHTML',
            emitJsDoc: true
        };

        const sourceRoot = findWorkspaceRoot(projectPath);
        const shadows = new ShadowManager({
            projectPath,
            sourceRoot,
            tsconfigPath,
            snapshotOptions,
            kitFiles: await loadKitFilesSettings(projectPath, options.configPath)
        });

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
        const sveltePackageInfo = getPackageInfo('svelte', tsconfigPath || options.workspacePath);
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
            tsconfigPath || options.workspacePath
        );

        return new TsGoBatchOverlay(tsgoPath, projectPath, tsconfigPath, shadows, shimFiles);
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
    materialise(): { shadowCount: number; durationMs: number } {
        const started = Date.now();
        this.shadows.writeOverlayTsconfig(this.shimFiles);

        const files = [
            ...this.shadows.findProjectSvelteFiles(),
            ...this.shadows.findDependencySvelteFiles()
        ];

        const written = new Set<string>();
        for (const filePath of files) {
            try {
                const document = new Document(
                    pathToUrl(filePath),
                    fs.readFileSync(filePath, 'utf-8'),
                    /* skipConfigLoading */ true
                );
                const snapshot = this.shadows.transform(document);
                const shadowPath = this.shadows.getShadowPath(filePath);
                this.shadows.writeShadow(shadowPath, snapshot.getFullText());
                written.add(shadowPath);
            } catch (e) {
                Logger.debug(`[tsgo] could not materialise shadow for ${filePath}`, e);
            }
        }

        // Stale shadows are still roots of the project, so a component that was deleted since
        // the last run would keep reporting errors from a file that no longer exists. Kit
        // shadows were written during `writeOverlayTsconfig` and are live too.
        for (const kitShadowPath of this.shadows.getKitShadowPaths()) {
            written.add(kitShadowPath);
        }
        this.shadows.pruneOrphanedShadows(written);
        this.shadows.clearSnapshots();
        this.materialised = true;

        return { shadowCount: written.size, durationMs: Date.now() - started };
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
        return { all, svelte };
    }

    /**
     * Translate diagnostics reported against generated files back onto the `.svelte` sources
     * they came from. Diagnostics on ordinary `.ts`/`.js` files pass through unchanged.
     */
    mapDiagnostics(diagnostics: GeneratedDiagnostic[], fallbackPath: string): FileDiagnostics[] {
        if (!this.materialised) {
            throw new Error('materialise() must run before diagnostics can be mapped');
        }

        const byFile = new Map<string, GeneratedDiagnostic[]>();
        for (const diagnostic of diagnostics) {
            const key = normalizePath(diagnostic.filePath ?? fallbackPath);
            const existing = byFile.get(key);
            if (existing) {
                existing.push(diagnostic);
            } else {
                byFile.set(key, [diagnostic]);
            }
        }

        const results: FileDiagnostics[] = [];
        for (const [filePath, fileDiagnostics] of byFile) {
            const kitShadow = this.shadows.getKitShadowByShadowPath(filePath);
            if (kitShadow) {
                const mapped = this.mapKitDiagnostics(kitShadow, fileDiagnostics);
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
                results.push(this.passThrough(filePath, fileDiagnostics));
                continue;
            }
            const mapped = this.mapShadowDiagnostics(originalPath, fileDiagnostics);
            if (mapped) {
                results.push(mapped);
            }
        }
        return results;
    }

    /**
     * Map diagnostics on a SvelteKit shadow back onto the route file the user wrote.
     *
     * Kit shadows are not built by svelte2tsx and carry no source map — the transform is a list
     * of insertions, so the mapping is arithmetic: subtract everything inserted before this
     * point. Positions landing *inside* an insertion collapse to where it was inserted, which is
     * the closest thing to a truthful answer for code the user never wrote.
     */
    private mapKitDiagnostics(
        kitShadow: KitShadow,
        fileDiagnostics: GeneratedDiagnostic[]
    ): FileDiagnostics | undefined {
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
            diagnostics: fileDiagnostics.map((diagnostic) => {
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
                    source
                };
            })
        };
    }

    private mapShadowDiagnostics(
        originalPath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): FileDiagnostics | undefined {
        let sourceText: string;
        try {
            sourceText = fs.readFileSync(originalPath, 'utf-8');
        } catch {
            // The file went away between the check and the report. Nothing useful to say.
            return undefined;
        }

        const document = new Document(
            pathToUrl(originalPath),
            sourceText,
            /* skipConfigLoading */ true
        );
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

        const tsDiagnostics = this.toTsDiagnostics(snapshot, fileDiagnostics);
        return {
            filePath: originalPath,
            text: sourceText,
            diagnostics: mapAndFilterDiagnostics(tsDiagnostics, document, snapshot)
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
    ): ts.Diagnostic[] {
        const generatedText = snapshot.getFullText();
        const sourceFile = ts.createSourceFile(
            snapshot.filePath,
            generatedText,
            ts.ScriptTarget.Latest,
            true,
            snapshot.scriptKind
        );

        const converted: ts.Diagnostic[] = [];
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
            });
        }
        return converted;
    }

    /** Diagnostics on a real file the user wrote: reported where the compiler put them. */
    private passThrough(filePath: string, fileDiagnostics: GeneratedDiagnostic[]): FileDiagnostics {
        let text = '';
        try {
            text = fs.readFileSync(filePath, 'utf-8');
        } catch {
            // A diagnostic that names no file (config errors) lands here.
        }
        const source = /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'ts' : 'js';
        return {
            filePath,
            text,
            diagnostics: fileDiagnostics.map((diagnostic) => ({
                range: Range.create(
                    { line: diagnostic.line, character: diagnostic.character },
                    { line: diagnostic.line, character: diagnostic.character + diagnostic.length }
                ),
                severity: diagnostic.severity,
                code: diagnostic.code,
                message: diagnostic.message,
                source,
                data: { positionUnknown: diagnostic.filePath === null }
            }))
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
}
