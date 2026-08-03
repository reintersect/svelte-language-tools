import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, URL } from 'node:url';

const VITE_CONFIG_EXTENSIONS = ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'] as const;
const SVELTE_CONFIG_EXTENSIONS = ['js', 'cjs', 'mjs'] as const;
const SVELTE_CONFIG_TS_EXTENSIONS = ['ts', 'mts'] as const;

type ConfigSource = 'svelte' | 'vite';

interface SvelteConfig {
    compilerOptions?: Record<string, unknown>;
    preprocess?: unknown;
    extensions?: string[];
    kit?: unknown;
    vitePlugin?: unknown;
    [key: string]: unknown;
}

interface LoadedConfig {
    config: SvelteConfig;
    configFilePath: string;
    configSource: ConfigSource;
}

interface FailedConfig {
    error: unknown;
    configFilePath: string;
    configSource: ConfigSource;
}

type LoadConfigResult = LoadedConfig | FailedConfig | undefined;

interface ViteModule {
    loadConfigFromFile?(
        configEnv: { command: 'build' | 'serve'; mode: string },
        configFile?: string,
        configRoot?: string,
        logLevel?: string
    ): Promise<{ config: Record<string, unknown> } | null>;
    resolveConfig(
        inlineConfig: Record<string, unknown> & {
            root: string;
            configFile: string | false;
            logLevel?: string;
        },
        command: 'build' | 'serve'
    ): Promise<{
        root?: string;
        plugins: Array<{ name?: string; api?: { options?: SvelteConfig } }>;
        [key: string]: unknown;
    }>;
}

const cache = new Map<string, Promise<LoadConfigResult>>();
/**
 * Node caches ESM modules by URL independently from this package's result cache. Incrementing
 * this epoch gives every direct Svelte-config import after `clearCache` a new URL. Keeping one
 * epoch for the whole invalidation also means configs discovered later in the same rebuild use
 * the same coherent generation.
 */
let configImportEpoch = 0;
/** Avoid evicting the same CommonJS module repeatedly during one coherent reload generation. */
const importedConfigEpochByPath = new Map<string, number>();

/**
 * SvelteKit versions before its Vite plugin became root-aware load `svelte.config` from
 * `process.cwd()` while Vite is evaluating `vite.config`. Vite's `root` option is therefore too
 * late for nested workspace packages. Changing the real cwd would make concurrent package loads
 * race with one another (and with unrelated preprocessors), so expose the requested root only to
 * the async call tree that is resolving that package's Vite config.
 *
 * The dispatcher remains installed for the lifetime of this module because config evaluation can
 * start asynchronous work. Outside a resolution context it delegates to Node's original cwd
 * implementation and is therefore behaviorally transparent.
 */
const viteConfigRoot = new AsyncLocalStorage<string>();
const originalCwd = process.cwd.bind(process);
const originalPathResolve = path.resolve.bind(path);
/**
 * Vite and its plugins may keep config-resolution state at module scope. In particular, older
 * SvelteKit Vite plugins capture cwd when their module is first evaluated. Serialize projects
 * which resolve through the same imported Vite module while still allowing independently
 * installed Vite toolchains to load in parallel.
 */
const viteResolveQueues = new WeakMap<ViteModule, Promise<void>>();

function withViteConfigRoot<T>(root: string, resolve: () => Promise<T>): Promise<T> {
    installVirtualRootDispatchers();
    return viteConfigRoot.run(root, resolve);
}

function virtualCwd(): string {
    return viteConfigRoot.getStore() ?? originalCwd();
}

function virtualPathResolve(...segments: string[]): string {
    const root = viteConfigRoot.getStore();
    return root ? originalPathResolve(root, ...segments) : originalPathResolve(...segments);
}

function installVirtualRootDispatchers(): void {
    // graceful-fs replaces process.cwd while Vite evaluates a config, captures our dispatcher,
    // and memoizes the first async-local result it observes. Reassert both stable dispatchers for
    // every rooted operation so that replacement cannot pin all later packages to the first one.
    if (process.cwd !== virtualCwd) {
        process.cwd = virtualCwd;
    }
    // Tailwind 3 resolves its default `tailwind.config` through the public path helper at style
    // transform time. Dispatch it through the same async-local root as process.cwd. Absolute path
    // arguments retain normal `path.resolve` semantics, and callers outside config/preprocess
    // resolution continue to use the real cwd.
    if (path.resolve !== virtualPathResolve) {
        path.resolve = virtualPathResolve;
    }
}

function serializeViteResolve<T>(vite: ViteModule, resolve: () => Promise<T>): Promise<T> {
    const previous = viteResolveQueues.get(vite) ?? Promise.resolve();
    const current = previous.then(resolve, resolve);
    viteResolveQueues.set(
        vite,
        current.then(
            () => undefined,
            () => undefined
        )
    );
    return current;
}

/**
 * This function encapsulates the import call in a way
 * that TypeScript does not transpile `import()`.
 * https://github.com/microsoft/TypeScript/issues/43329
 */
const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (
    modulePath: URL | string
) => Promise<any>;

/**
 * Loads the Svelte configuration by searching for `vite.config` and `svelte.config` files.
 *
 * If `dirOrFile` is a file path, that config file is loaded directly.
 *
 * If `dirOrFile` is a directory and `traverse` is true, it starts from the provided directory and traverses up the directory tree until it finds a config or reaches the root.
 * Else it only checks the provided directory.
 *
 * `vite.config` with either vite-plugin-svelte or the SvelteKit plugin providing options is preferred over `svelte.config`.
 *
 * The results are cached to optimize subsequent calls.
 */
export function loadConfig(
    dirOrFile: string,
    { traverse = true, clearCache = false }: { traverse?: boolean; clearCache?: boolean } = {}
): Promise<LoadConfigResult> {
    if (clearCache) {
        cache.clear();
        configImportEpoch++;
    }

    const resolved = path.resolve(dirOrFile);
    const cached = cache.get(resolved);
    if (cached) {
        return cached;
    }

    const epoch = configImportEpoch;
    const loading = isFile(resolved)
        ? loadConfigFromFile(resolved, epoch)
        : loadConfigUncached(resolved, traverse, epoch);
    cache.set(resolved, loading);
    return loading;
}

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

async function loadConfigFromFile(
    configFilePath: string,
    epoch: number
): Promise<LoadConfigResult> {
    const basename = path.basename(configFilePath);
    const root = path.dirname(configFilePath);

    if (/^svelte\.config\./.test(basename)) {
        return (await loadSvelteConfig(configFilePath, epoch)) ?? undefined;
    }

    const viteResult = await loadSvelteConfigFromVite(root, configFilePath, epoch);
    if (viteResult !== undefined) {
        return viteResult;
    }

    return loadSvelteConfig(configFilePath, epoch);
}

async function loadConfigUncached(
    dir: string,
    traverse: boolean,
    epoch: number
): Promise<LoadConfigResult> {
    let currentDir = dir;
    const dirs = [dir];

    while (true) {
        const result = await loadConfigFromDirectory(currentDir, epoch);
        if (result) {
            if (isLoadedConfig(result) && epoch === configImportEpoch) {
                // Cache the loaded config for all traversed directories
                for (const d of dirs) {
                    cache.set(d, Promise.resolve(result));
                }
            } else if (epoch === configImportEpoch) {
                cache.delete(dir);
            }
            return result;
        }

        if (!traverse) {
            return undefined;
        }

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) {
            return undefined;
        }
        currentDir = parentDir;
        dirs.push(currentDir);
    }
}

async function loadConfigFromDirectory(dir: string, epoch: number): Promise<LoadConfigResult> {
    const viteConfigPath = findConfigInDirectory(dir, 'vite.config', VITE_CONFIG_EXTENSIONS);
    let viteError: FailedConfig | undefined;

    if (viteConfigPath) {
        const result = await loadSvelteConfigFromVite(dir, viteConfigPath, epoch);
        if (isLoadedConfig(result)) {
            return result;
        }
        if (result?.error) {
            viteError = result;
        }
    }

    const svelteConfigPath = findConfigInDirectory(
        dir,
        'svelte.config',
        getSvelteConfigExtensions()
    );
    if (!svelteConfigPath) {
        return viteError;
    }

    return (await loadSvelteConfig(svelteConfigPath, epoch)) ?? viteError;
}

async function loadSvelteConfigFromVite(
    root: string,
    configFilePath: string,
    epoch: number
): Promise<LoadConfigResult> {
    const vite = await tryImportVite(root);
    if (!vite) {
        return undefined;
    }

    try {
        const svelteConfigPath = findConfigInDirectory(
            root,
            'svelte.config',
            getSvelteConfigExtensions()
        );
        if (svelteConfigPath && vite.loadConfigFromFile) {
            const authored = await withViteConfigRoot(root, () =>
                loadSvelteConfig(svelteConfigPath, epoch)
            );
            if (!isLoadedConfig(authored)) {
                return authored;
            }

            const cleanCssConfig = await serializeViteResolve(vite, async () => {
                const loadedViteConfig = await withViteConfigRoot(root, () =>
                    vite.loadConfigFromFile!(
                        { command: 'serve', mode: 'development' },
                        configFilePath,
                        root,
                        'error'
                    )
                );
                if (!loadedViteConfig) {
                    return undefined;
                }
                const authoredCss =
                    loadedViteConfig.config.css && typeof loadedViteConfig.config.css === 'object'
                        ? (loadedViteConfig.config.css as Record<string, unknown>)
                        : {};
                // Vite's file loader evaluates config functions but does not run plugin hooks.
                // Resolve only its authored CSS options so an old SvelteKit plugin cannot replace
                // the package root, and no arbitrary Vite plugin state enters the checker.
                const resolved = await withViteConfigRoot(root, () =>
                    vite.resolveConfig(
                        {
                            root,
                            configFile: false,
                            logLevel: 'error',
                            plugins: [],
                            css: {
                                ...authoredCss,
                                // This is Vite's default search path made explicit. PostCSS loaders
                                // otherwise fall back through process cwd while several workspace
                                // configs are being initialized concurrently.
                                postcss: authoredCss.postcss ?? root
                            }
                        },
                        'serve'
                    )
                );
                return resolved;
            });

            if (cleanCssConfig) {
                bindVitePreprocessConfig(authored.config, cleanCssConfig, root);
                return {
                    config: authored.config,
                    configFilePath,
                    configSource: 'vite'
                };
            }
        }

        // Preserve the original Vite-only and old-Vite compatibility path. Older SvelteKit
        // releases consult process.cwd() while vite.config is evaluated, so virtualize that lookup
        // per async resolution without changing the process-wide OS cwd.
        const resolved = await serializeViteResolve(vite, () =>
            withViteConfigRoot(root, () =>
                vite.resolveConfig({ root, configFile: configFilePath, logLevel: 'error' }, 'serve')
            )
        );
        const kitPlugin = resolved.plugins.find(
            (plugin) => plugin.name === 'vite-plugin-sveltekit-setup'
        );
        const kitOptions = kitPlugin?.api?.options;
        if (kitOptions) {
            const { preprocess, compilerOptions, extensions, vitePlugin, ...kit } = kitOptions;
            return {
                config: { preprocess, compilerOptions, extensions, vitePlugin, kit },
                configFilePath,
                configSource: 'vite'
            };
        }

        const sveltePlugin = resolved.plugins.find(
            (plugin) => plugin.name === 'vite-plugin-svelte:config'
        );
        const options = sveltePlugin?.api?.options;
        if (options) {
            return {
                config: options,
                configFilePath,
                configSource: 'vite'
            };
        }
    } catch (error) {
        return {
            error,
            configFilePath,
            configSource: 'vite'
        };
    }
}

function bindVitePreprocessConfig(
    config: SvelteConfig,
    resolved: Awaited<ReturnType<ViteModule['resolveConfig']>>,
    root: string
): Array<(...args: unknown[]) => Promise<unknown>> {
    const styles: Array<(...args: unknown[]) => Promise<unknown>> = [];
    const preprocessors = Array.isArray(config.preprocess)
        ? config.preprocess
        : [config.preprocess];
    for (const preprocessor of preprocessors) {
        const group = preprocessor as {
            style?: ((...args: unknown[]) => unknown) & { __resolvedConfig?: unknown };
        };
        const style = group?.style;
        if (style && '__resolvedConfig' in style) {
            style.__resolvedConfig = resolved;
            const packageLocalStyle = function (this: unknown, ...args: unknown[]) {
                return withViteConfigRoot(root, () => Promise.resolve(style.apply(this, args)));
            } as typeof style;
            Object.assign(packageLocalStyle, style);
            packageLocalStyle.__resolvedConfig = resolved;
            group.style = packageLocalStyle;
            styles.push(packageLocalStyle as (...args: unknown[]) => Promise<unknown>);
        }
    }
    return styles;
}

async function loadSvelteConfig(configFilePath: string, epoch: number): Promise<LoadConfigResult> {
    try {
        const moduleUrl = pathToFileURL(configFilePath);
        if (epoch > 0) {
            moduleUrl.searchParams.set('svelte-load-config', String(epoch));
            // A query makes ESM imports fresh, but CommonJS modules have a second cache behind
            // their ESM wrapper. Clear the exact resolved config there as well. This is harmless
            // for ESM configs, which do not have a `require.cache` entry.
            if (importedConfigEpochByPath.get(configFilePath) !== epoch) {
                importedConfigEpochByPath.set(configFilePath, epoch);
                try {
                    delete require.cache[require.resolve(configFilePath)];
                } catch {
                    // Resolution/import below will report the useful error.
                }
            }
        }

        const config = (await dynamicImport(moduleUrl.href))?.default;
        if (!config) {
            throw new Error(
                'Missing exports in the config. Make sure to include "export default config" or "module.exports = config"'
            );
        }

        return {
            config,
            configFilePath,
            configSource: 'svelte'
        };
    } catch (error) {
        return {
            error,
            configFilePath,
            configSource: 'svelte'
        };
    }
}

async function tryImportVite(fromPath: string): Promise<ViteModule | undefined> {
    try {
        const importPath = getViteImportPath(fromPath);
        if (importPath) {
            return await dynamicImport(pathToFileURL(importPath).href);
        }
    } catch {
        // fall through to legacy import
    }

    return importViteLegacy(fromPath);
}

function getViteImportPath(fromPath: string): string | undefined {
    const pkgPath = require.resolve('vite/package.json', { paths: [fromPath] });
    const pkgDir = path.dirname(pkgPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        exports?: Record<string, unknown>;
        module?: string;
        main?: string;
    };

    const entry = resolvePackageImportExport(pkg.exports?.['.']);
    if (entry) {
        return path.join(pkgDir, entry);
    }

    const fallback = pkg.module ?? pkg.main;
    return fallback ? path.join(pkgDir, fallback) : undefined;
}

function resolvePackageImportExport(exportEntry: unknown): string | undefined {
    if (typeof exportEntry === 'string') {
        return exportEntry;
    }

    if (!exportEntry || typeof exportEntry !== 'object') {
        return undefined;
    }

    const entry = exportEntry as Record<string, unknown>;
    const importEntry = entry.import;

    if (typeof importEntry === 'string') {
        return importEntry;
    }

    if (importEntry && typeof importEntry === 'object') {
        const defaultEntry = (importEntry as Record<string, unknown>).default;
        if (typeof defaultEntry === 'string') {
            return defaultEntry;
        }
    }

    if (typeof entry.default === 'string') {
        return entry.default;
    }

    return undefined;
}

// Importing old Vite releases requires a process-wide warning flag. Serialize only this tiny
// compatibility path so concurrent projects cannot restore one another's environment value;
// modern resolveConfig calls remain concurrent and no code changes process.cwd().
let legacyViteImportQueue: Promise<void> = Promise.resolve();

async function importViteLegacy(fromPath: string): Promise<ViteModule | undefined> {
    const loading = legacyViteImportQueue.then(async () => {
        try {
            const main = require.resolve('vite', { paths: [fromPath] });
            // require.resolve will use the cjs version
            const previous = process.env.VITE_CJS_IGNORE_WARNING;
            process.env.VITE_CJS_IGNORE_WARNING = 'true';
            try {
                return await dynamicImport(pathToFileURL(main).href);
            } finally {
                if (previous === undefined) {
                    delete process.env.VITE_CJS_IGNORE_WARNING;
                } else {
                    process.env.VITE_CJS_IGNORE_WARNING = previous;
                }
            }
        } catch {
            return undefined;
        }
    });
    legacyViteImportQueue = loading.then(
        () => undefined,
        () => undefined
    );
    return loading;
}

function findConfigInDirectory(
    dir: string,
    basename: 'svelte.config' | 'vite.config',
    extensions: readonly string[]
): string | undefined {
    for (const extension of extensions) {
        const configPath = path.join(dir, `${basename}.${extension}`);
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }
}

function getSvelteConfigExtensions() {
    return process.features && 'typescript' in process.features && process.features.typescript
        ? [...SVELTE_CONFIG_EXTENSIONS, ...SVELTE_CONFIG_TS_EXTENSIONS]
        : SVELTE_CONFIG_EXTENSIONS;
}

function isLoadedConfig(result: LoadConfigResult): result is LoadedConfig {
    return !!result && 'config' in result;
}
