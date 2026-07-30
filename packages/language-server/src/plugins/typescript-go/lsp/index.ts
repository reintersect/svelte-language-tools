import { dirname, join } from 'path';
import ts from 'typescript';
import { internalHelpers } from 'svelte2tsx';
import { DocumentManager } from '../../../lib/documents';
import { getPackageInfo, importSvelte } from '../../../importPackage';
import { Logger } from '../../../logger';
import { pathToUrl, urlToPath } from '../../../utils';
import { Plugin } from '../../interfaces';
import { SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';
import {
    findProjectTsconfig,
    findWorkspaceRoot,
    resolveTsGoPath,
    ShadowManager
} from './ShadowManager';
import { ProjectRegistry } from './ProjectRegistry';
import { TsGoPlugin } from './TsGoPlugin';
import { TsGoApiSession } from './TsGoApiSession';
import { TsGoComponentInfo } from './TsGoComponentInfo';
import { TsGoServer } from './TsGoServer';

export { TsGoPlugin } from './TsGoPlugin';
export { TsGoServer } from './TsGoServer';
export {
    ShadowManager,
    resolveTsGoPath,
    findProjectTsconfig,
    findWorkspaceRoot
} from './ShadowManager';
export {
    TsGoBatchOverlay,
    FileDiagnostics,
    GeneratedDiagnostic,
    TsGoBatchOverlayOptions
} from './BatchOverlay';

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
    docManager: DocumentManager;
}

/**
 * Build the tsgo plugin for a workspace, or return undefined when tsgo isn't available — in
 * which case the caller simply keeps using the JS engine.
 */
export function createTsGoPlugin(options: TsGoSetupOptions): TsGoPlugin | undefined {
    const tsgoPath = resolveTsGoPath(options.workspacePath);
    if (!tsgoPath) {
        Logger.error(
            '[tsgo] SVELTE_LS_TSGO is set but no tsgo binary was found. ' +
                'Install @reintersect/effect-tsgo or @typescript/native-preview.'
        );
        return undefined;
    }

    const tsconfigPath = findProjectTsconfig(options.workspacePath);
    const projectPath = tsconfigPath ? dirname(tsconfigPath) : options.workspacePath;

    // Use the project's own Svelte compiler so the transform matches what the user builds with.
    const svelteCompiler = importSvelte(tsconfigPath || options.workspacePath);
    const snapshotOptions: SvelteSnapshotOptions = {
        parse: svelteCompiler?.parse,
        version: svelteCompiler?.VERSION,
        // Keep emitting usable TSX while the template is mid-edit and momentarily unbalanced;
        // without this every keystroke inside markup would blank the file's types.
        transformOnTemplateError: true,
        typingsNamespace: 'svelteHTML',
        emitJsDoc: true
    };

    const sourceRoot = findWorkspaceRoot(projectPath);
    if (sourceRoot !== projectPath) {
        Logger.log(`[tsgo] workspace root detected at ${sourceRoot}`);
    }

    let svelteTsPath: string;
    try {
        svelteTsPath = dirname(require.resolve('svelte2tsx'));
    } catch {
        svelteTsPath = __dirname;
    }

    // Shims and the Svelte compiler are both resolved per package: they are written against, and
    // must match, the Svelte that package builds with. Resolving either from the editor's root
    // silently yields the wrong one in a monorepo — the root usually has no `svelte` at all, and
    // `importSvelte` then falls back to the copy bundled with this server, which is Svelte 4.
    const shimCache = new Map<string, string[]>();
    const resolveShims = (packageRoot: string): string[] => {
        const cached = shimCache.get(packageRoot);
        if (cached) {
            return cached;
        }
        let shims: string[] = [];
        try {
            const info = getPackageInfo('svelte', packageRoot);
            shims = internalHelpers.get_global_types(
                ts.sys,
                info.version.major === 3,
                info.path,
                svelteTsPath,
                packageRoot
            );
        } catch (e) {
            Logger.debug(`[tsgo] no Svelte resolvable from ${packageRoot}`, e);
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
        const compiler = importSvelte(packageRoot);
        const resolved: SvelteSnapshotOptions = {
            parse: compiler?.parse,
            version: compiler?.VERSION,
            // Keep emitting usable TSX while the template is mid-edit and momentarily unbalanced;
            // without this every keystroke inside markup would blank the file's types.
            transformOnTemplateError: true,
            typingsNamespace: 'svelteHTML',
            emitJsDoc: true
        };
        optionsCache.set(packageRoot, resolved);
        return resolved;
    };

    // One ShadowManager per TypeScript project, built on demand for whichever project the file
    // being edited belongs to. A workspace is not a project: deriving one from the editor's root
    // only works when they happen to coincide.
    const projects = new ProjectRegistry((root: string, configPath: string | undefined) => {
        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: findWorkspaceRoot(root),
            tsconfigPath: configPath,
            snapshotOptions: resolveSnapshotOptions(root)
        });
        shadows.setShimResolver(resolveShims);
        shadows.setSnapshotOptionsResolver(resolveSnapshotOptions);
        shadows.writeOverlayTsconfig(resolveShims(root));
        return shadows;
    }, projectPath);

    const server = new TsGoServer({
        tsgoPath,
        // Root tsgo at the source root, which is the one directory guaranteed to contain every
        // mirror. Project selection is per-file — tsgo walks up from the opened file until it
        // finds a tsconfig, landing on that package's overlay — but a file *outside* the server's
        // workspace gets no project at all and therefore no diagnostics. Rooting at this
        // project's own overlay was fine while the editor was opened on a single app, and silently
        // broke everything the moment it was opened on a monorepo: every shadow then lives under
        // `<package>/.svelte-ls-overlay/`, none of which is inside `<monorepo>/.svelte-ls-overlay`.
        // The source root, which is the one directory containing every project's overlay. A file
        // outside the server's workspace gets no project and therefore no diagnostics, and with a
        // manager per project there is no single overlay that contains them all.
        workspacePath: sourceRoot,
        onRestart: () =>
            Logger.error('[tsgo] server exited; documents will be replayed on next request')
    });

    // Component props/events/slots are read off the *type*, which no LSP request exposes.
    // The session attaches a checker to the same programs tsgo is already serving.
    const apiSession = new TsGoApiSession(
        server,
        projectPath,
        projects.forFile(join(projectPath, 'x.svelte')).overlayTsconfigPath
    );
    const componentInfo = new TsGoComponentInfo(apiSession, async (shadowPath, offset) => {
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
    });

    Logger.log(`[tsgo] enabled, using ${tsgoPath}`);
    return new TsGoPlugin({ server, projects, docManager: options.docManager, componentInfo });
}
