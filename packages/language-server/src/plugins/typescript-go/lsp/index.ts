import { dirname } from 'path';
import ts from 'typescript';
import { internalHelpers } from 'svelte2tsx';
import { DocumentManager } from '../../../lib/documents';
import {
    getPackageInfo,
    importSvelte,
    invalidateImportedSveltePackages
} from '../../../importPackage';
import { Logger } from '../../../logger';
import { LSConfigManager } from '../../../ls-config';
import { pathToUrl, urlToPath } from '../../../utils';
import { Plugin } from '../../interfaces';
import { SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';
import { getRsvelte } from '../rsvelte';
import { findWorkspaceRoot, ShadowManager } from './ShadowManager';
import { resolveTsGoEngine } from './TsGoEngine';

export { isRsvelteEnabled, preloadRsvelte } from '../rsvelte';
import { ProjectRegistry } from './ProjectRegistry';
import { TsGoPlugin } from './TsGoPlugin';
import { TsGoApiSession } from './TsGoApiSession';
import { TsGoComponentInfo } from './TsGoComponentInfo';
import { TsGoServer } from './TsGoServer';
import { FileSystemWatcher } from 'vscode-languageserver-protocol';

export { TsGoPlugin } from './TsGoPlugin';
export { TsGoServer } from './TsGoServer';
export {
    ResolvedTsGoEngine,
    ResolveTsGoEngineOptions,
    resolveTsGoEngine,
    resolveTsGoPath
} from './TsGoEngine';
export { ShadowManager, findProjectTsconfig, findWorkspaceRoot } from './ShadowManager';
export {
    BatchMaterialisationPlanTelemetry,
    BatchMaterialisePhaseTimings,
    BatchMaterialiseResult,
    BatchOverlayCreationTimings,
    TsGoBatchOverlay,
    FileDiagnostics,
    GeneratedDiagnostic,
    TsGoBatchOverlayOptions
} from './BatchOverlay';
export {
    MATERIALISATION_PLAN_SCHEMA_VERSION,
    MaterialisationPlanCache,
    MaterialisationPlanCacheCounters,
    MaterialisationPlanIdentity,
    MaterialisationPlanLookup,
    MaterialisationPlanMissReason,
    MaterialisationPlanWriteResult
} from './MaterialisationPlanCache';

/**
 * Feature flag for the tsgo engine, off by default.
 *
 * Reads `svelte.language-server.tsgo` from the client's initialization options first, falling back
 * to `SVELTE_LS_TSGO` in the environment. The setting exists because the environment variable
 * alone is unusable from an editor: VS Code gives no way to set one for the extension host, so
 * turning the engine on would mean launching the whole editor from a shell that has it. The
 * variable stays for `svelte-check`, benchmarks and CI, where it is the natural interface.
 */
export function isTsGoEnabled(initializationOptions?: any): boolean {
    const fromClient =
        initializationOptions?.configuration?.svelte?.['language-server']?.tsgo ??
        initializationOptions?.config?.['language-server']?.tsgo;
    if (typeof fromClient === 'boolean') {
        return fromClient;
    }
    const value = process.env.SVELTE_LS_TSGO;
    return value === '1' || value === 'true';
}

/**
 * Compose the tsgo plugin over the existing TypeScript plugin.
 *
 * Returns a proxy that serves a request from tsgo when the tsgo plugin implements it and falls
 * through to the JS engine otherwise. Registering the two plugins side by side would not work:
 * `getDiagnostics` runs in `Collect` mode, so both would answer and every diagnostic would
 * appear twice.
 */
export function createTsGoBackedPlugin(jsPlugin: Plugin, tsGoPlugin: TsGoPlugin): Plugin {
    return new Proxy(jsPlugin, {
        get(target, property, receiver) {
            // Keep the JS plugin's identity: PluginHost keys pull-diagnostic result ids off it.
            if (property === '__name') {
                return Reflect.get(target, property, receiver);
            }
            if (property === 'tsGoStats') {
                return tsGoPlugin.stats;
            }
            const candidate = (tsGoPlugin as any)[property];
            if (typeof candidate === 'function') {
                return candidate.bind(tsGoPlugin);
            }
            const fallback = Reflect.get(target, property, receiver);
            return typeof fallback === 'function' ? fallback.bind(target) : fallback;
        }
    });
}

export interface TsGoSetupOptions {
    workspacePath: string;
    /** Every workspace folder the editor has open; project resolution never leaves them. */
    workspacePaths?: string[];
    docManager: DocumentManager;
    configManager?: LSConfigManager;
    isTrusted?: boolean;
    onDidRegisterWatchers?: (watchers: FileSystemWatcher[]) => void;
}

/**
 * Build the tsgo plugin for a workspace, or return undefined when tsgo isn't available — in
 * which case the caller simply keeps using the JS engine.
 */
export function createTsGoPlugin(options: TsGoSetupOptions): TsGoPlugin | undefined {
    if (options.isTrusted === false || options.configManager?.getIsTrusted() === false) {
        Logger.error('[tsgo] disabled in an untrusted workspace; using the classic engine');
        return undefined;
    }
    const engine = resolveTsGoEngine(options.workspacePath);
    if (!engine) {
        Logger.error(
            '[tsgo] SVELTE_LS_TSGO is set but no tsgo binary was found. ' +
                'Install @reintersect/effect-tsgo, @typescript/native, or @typescript/native-preview.'
        );
        return undefined;
    }

    const sourceRoot = findWorkspaceRoot(options.workspacePath);
    if (sourceRoot !== options.workspacePath) {
        Logger.log(`[tsgo] workspace root detected at ${sourceRoot}`);
    }

    let svelteTsPath: string;
    try {
        svelteTsPath = dirname(require.resolve('svelte2tsx'));
    } catch {
        svelteTsPath = __dirname;
    }

    // Where a package's Svelte actually lives. Resolved strictly — never the copy bundled with
    // this server: that one is Svelte 4, and Svelte-4 shims or parsing poison a Svelte-5
    // workspace silently. A package with no `svelte` of its own (a pnpm monorepo root never has
    // one) borrows the resolution of the nearest component-owning package beneath it.
    const svelteHomeCache = new Map<string, string | undefined>();
    const svelteHomeFor = (packageRoot: string): string | undefined => {
        if (svelteHomeCache.has(packageRoot)) {
            return svelteHomeCache.get(packageRoot);
        }
        let home: string | undefined;
        try {
            getPackageInfo('svelte', packageRoot, false);
            home = packageRoot;
        } catch {
            const beneath = projects
                .workspaceSvelteFiles(sourceRoot)
                .find((file) => file.startsWith(packageRoot + '/'));
            if (beneath) {
                try {
                    getPackageInfo('svelte', dirname(beneath), false);
                    home = dirname(beneath);
                } catch {
                    // No svelte there either; fall through to the log below.
                }
            }
            if (home) {
                Logger.log(`[tsgo] ${packageRoot} has no svelte of its own; using ${home}'s`);
            } else {
                Logger.error(
                    `[tsgo] no Svelte is resolvable for ${packageRoot}; ` +
                        'component typings will be limited'
                );
            }
        }
        svelteHomeCache.set(packageRoot, home);
        return home;
    };

    // Shims and the Svelte compiler are both resolved per package: they are written against, and
    // must match, the Svelte that package builds with.
    const shimCache = new Map<string, string[]>();
    const resolveShims = (packageRoot: string): string[] => {
        const cached = shimCache.get(packageRoot);
        if (cached) {
            return cached;
        }
        let shims: string[] = [];
        const home = svelteHomeFor(packageRoot);
        if (home) {
            try {
                const info = getPackageInfo('svelte', home, false);
                shims = internalHelpers.get_global_types(
                    ts.sys,
                    info.version.major === 3,
                    info.path,
                    svelteTsPath,
                    home
                );
            } catch (e) {
                Logger.debug(`[tsgo] could not build shims from ${home}`, e);
            }
        }
        shimCache.set(packageRoot, shims);
        return shims;
    };

    const optionsCache = new Map<string, SvelteSnapshotOptions>();
    const resolveSnapshotOptions = (packageRoot: string): SvelteSnapshotOptions => {
        const cached = optionsCache.get(packageRoot);
        if (cached) {
            return cached;
        }
        const home = svelteHomeFor(packageRoot);
        let compiler: ReturnType<typeof importSvelte> | undefined;
        if (home) {
            try {
                compiler = importSvelte(home, false);
            } catch (e) {
                Logger.debug(`[tsgo] could not import the Svelte compiler from ${home}`, e);
            }
        }
        // The Rust transform, when it was preloaded (server.ts awaits that before building
        // this plugin, so the decision is fixed for the session — a mid-session switch would
        // split the shared fingerprint between engines). Svelte 5 + `lang="ts"` only: the
        // Rust JSDoc emission and version-4 mode both produce semantically different TSX
        // (verified against the svelte-check fixtures), and per-file engine choice stays
        // deterministic so the shared fingerprint remains sound.
        const rsvelte = getRsvelte();
        const svelteMajor = Number((compiler?.VERSION ?? '5').split('.')[0]);
        const useRust = !!rsvelte && svelteMajor >= 5;
        const resolved: SvelteSnapshotOptions = {
            parse: compiler?.parse,
            version: compiler?.VERSION,
            // Keep emitting usable TSX while the template is mid-edit and momentarily unbalanced;
            // without this every keystroke inside markup would blank the file's types.
            transformOnTemplateError: true,
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
        optionsCache.set(packageRoot, resolved);
        return resolved;
    };

    // One ShadowManager per TypeScript project, built on demand for whichever project the file
    // being edited belongs to. A workspace is not a project: deriving one from the editor's root
    // only works when they happen to coincide.
    const projects: ProjectRegistry = new ProjectRegistry({
        createShadows: (root, configPath, writeConfig) => {
            const shadows = new ShadowManager({
                projectPath: root,
                sourceRoot: findWorkspaceRoot(root),
                tsconfigPath: configPath,
                snapshotOptions: resolveSnapshotOptions(root),
                writeConfig,
                workspaceSvelteFiles: () => projects.workspaceSvelteFiles(findWorkspaceRoot(root))
            });
            shadows.setShimResolver(resolveShims);
            shadows.setSnapshotOptionsResolver(resolveSnapshotOptions);
            // Shared checker mirrors can affect native extension substitution in the editor too.
            // Discover/adopt their source graph before paths/rootDirs are frozen into the config;
            // TsGoPlugin publishes every resulting output in one source-root transaction.
            shadows.prepareBatchModuleMirrors();
            shadows.writeOverlayTsconfig(resolveShims(root));
            return shadows;
        },
        workspaceRoots: options.workspacePaths?.length
            ? options.workspacePaths
            : [options.workspacePath],
        fallbackRoot: options.workspacePath
    });

    const server: TsGoServer = new TsGoServer({
        engine,
        // Root tsgo at the source root, which is the one directory guaranteed to contain every
        // mirror. Project selection is per-file — tsgo walks up from the opened file until it
        // finds a tsconfig that contains it, landing on that package's overlay — but a file
        // *outside* the server's workspace gets no project at all and therefore no diagnostics,
        // and with a manager per project there is no single overlay that contains them all.
        workspacePath: sourceRoot,
        // The other folders of a multi-root workspace, each widened to its own source root.
        workspacePaths: (options.workspacePaths ?? []).map((folder) => findWorkspaceRoot(folder)),
        getConfiguration: (section, scopeUri) => {
            const scopePath = scopeUri ? urlToPath(scopeUri) : undefined;
            const javascript =
                section?.toLowerCase().includes('javascript') ||
                !!scopePath?.match(/\.(?:js|jsx|mjs|cjs)$/i);
            return (
                options.configManager?.getClientTsUserConfig(
                    javascript ? 'javascript' : 'typescript'
                ) ?? {}
            );
        },
        onDidRegisterWatchers: options.onDidRegisterWatchers,
        beforeStart: (): Promise<void> =>
            plugin?.awaitProjectPublicationsBeforeStart() ?? Promise.resolve(),
        onRestart: () => {
            Logger.error('[tsgo] server exited; a new one will replay the open documents');
            // Everything attached to the dead process has to let go of it: the checker pipe,
            // the memoised component info, and the plugin's materialised-project markers.
            apiSession.reset();
            componentInfo.clearCache();
            plugin?.resetProjects();
        }
    });

    // Component props/events/slots are read off the *type*, which no LSP request exposes.
    // The session attaches a checker to the same programs tsgo is already serving; the project
    // is picked per file, exactly like the LSP side does.
    const apiSession = new TsGoApiSession(server, engine);
    const componentInfo = new TsGoComponentInfo(
        apiSession,
        async (shadowPath, offset) => {
            // Ask the LSP side where the identifier is declared, then translate that back into a
            // (file, offset) the checker can be queried at.
            try {
                const snapshot = projects.getSnapshotByShadowPath(shadowPath);
                const position = snapshot?.positionAt(offset);
                if (!position) {
                    return undefined;
                }
                const result: any = await server.sendRequest('textDocument/definition', {
                    textDocument: { uri: pathToUrl(shadowPath) },
                    position
                });
                const entry = Array.isArray(result) ? result[0] : result;
                if (!entry) {
                    return undefined;
                }
                const targetUri: string = entry.targetUri ?? entry.uri;
                const targetRange = entry.targetSelectionRange ?? entry.targetRange ?? entry.range;
                const filePath = urlToPath(targetUri);
                if (!filePath || !targetRange) {
                    return undefined;
                }
                const targetSnapshot = projects.getSnapshotByShadowPath(filePath);
                if (!targetSnapshot) {
                    return undefined;
                }
                return { filePath, offset: targetSnapshot.offsetAt(targetRange.start) };
            } catch {
                return undefined;
            }
        },
        (filePath) => server.documentVersion(filePath)
    );

    Logger.log(`[tsgo] enabled, using ${engine.packageName}@${engine.version} (${engine.binPath})`);
    const plugin: TsGoPlugin = new TsGoPlugin({
        server,
        projects,
        docManager: options.docManager,
        componentInfo,
        invalidateEngineCaches: () => {
            invalidateImportedSveltePackages();
            svelteHomeCache.clear();
            shimCache.clear();
            optionsCache.clear();
        },
        ...(options.configManager ? { configManager: options.configManager } : {})
    });
    return plugin;
}
