import { Logger } from '../../logger';
import { loadConfig as loadConfigFromDirectory } from '@reintersect/svelte-load-config';
import { normalizePath } from '../../utils';
// @ts-ignore
import { CompileOptions } from 'svelte/types/compiler/interfaces';
// @ts-ignore
import { PreprocessorGroup } from 'svelte/types/compiler/preprocess';
import { importSveltePreprocess } from '../../importPackage';
import { fdir } from 'fdir';
import _path from 'path';
import _fs from 'fs';
import { URL } from 'url';
import { FileMap } from './fileCollection';
import ts from 'typescript';

export type InternalPreprocessorGroup = PreprocessorGroup & {
    /**
     * svelte-preprocess has this since 4.x
     */
    defaultLanguages?: {
        markup?: string;
        script?: string;
        style?: string;
    };
};

export interface SvelteConfig {
    compilerOptions?: CompileOptions;
    preprocess?: InternalPreprocessorGroup | InternalPreprocessorGroup[];
    loadConfigError?: any;
    isFallbackConfig?: boolean;
    configSource?: 'svelte' | 'vite';
    files?: any;
}

export interface ExplicitConfigScope {
    configPath: string;
    /** Directory of the initial tsconfig or svelte-check workspace */
    rootDirectory: string;
}

export interface SvelteConfigTransformIdentity {
    /** The authored config file, omitted for the synthetic fallback config. */
    readonly configFile?: {
        readonly path: string;
        readonly stamp: string;
    };
    readonly source?: SvelteConfig['configSource'];
    readonly fallback?: true;
    readonly namespace?: CompileOptions['namespace'];
    readonly accessors?: CompileOptions['accessors'];
    readonly customElement?: CompileOptions['customElement'] | string;
    readonly defaultLanguages: readonly InternalPreprocessorGroup['defaultLanguages'][];
    readonly preprocessors: readonly {
        readonly markup?: string;
        readonly script?: string;
        readonly style?: string;
    }[];
}

/**
 * A config and the metadata used by materialisation. The transform identity is computed once
 * when the config is loaded, rather than rediscovering and rereading the config for every file.
 */
export interface ResolvedSvelteConfig {
    readonly config: SvelteConfig;
    readonly configPath: string;
    readonly revision: number;
    readonly transformIdentity: SvelteConfigTransformIdentity;
}

type LoadConfigFromDirectoryFn = typeof loadConfigFromDirectory;

const DEFAULT_OPTIONS: CompileOptions = {
    dev: true
};

const NO_GENERATE: CompileOptions = {
    generate: false
};

const SVELTE_CONFIG_EXTENSIONS = ['js', 'cjs', 'mjs'] as const;
const SVELTE_CONFIG_TS_EXTENSIONS = ['ts', 'mts'] as const;
const VITE_CONFIG_EXTENSIONS = ['js', 'mjs', 'ts', 'cjs', 'mts', 'cts'] as const;

const configRegex =
    /\/(svelte\.config\.(js|ts|cjs|mjs|mts)|vite\.config\.(js|mjs|ts|cjs|mts|cts))$/;
const configRegexWithoutTs =
    /\/(svelte\.config\.(js|cjs|mjs)|vite\.config\.(js|mjs|ts|cjs|mts|cts))$/;

/**
 * Loads vite.config.* and svelte.config.{js,ts,cjs,mjs,mts} files. Provides both
 * a synchronous and asynchronous interface to get a config file
 * because snapshots need access to it synchronously.
 * This means that another instance (the ts service host on startup) should make
 * sure that all config files are loaded before snapshots are retrieved.
 * Asynchronousity is needed because we use the dynamic `import()` statement.
 */
export class ConfigLoader {
    private configFiles = new FileMap<SvelteConfig>();
    private configFilesAsync = new FileMap<Promise<SvelteConfig>>();
    private filePathToConfigPath = new FileMap<string>();
    /** Effective loaded config for a directory. `null` is a cached negative lookup. */
    private directoryToLoadedConfigPath = new FileMap<string | null>();
    /** On-disk config discovery for a directory. `null` is a cached negative lookup. */
    private directoryToDiscoveredConfigPath = new FileMap<string | null>();
    private configTransformIdentities = new FileMap<SvelteConfigTransformIdentity>();
    /** Candidate path (for example a colocated Svelte config) to the loader's actual result. */
    private effectiveConfigPaths = new FileMap<string>();
    /** Also clear @reintersect/svelte-load-config's process-wide cache on the next real load. */
    private clearUpstreamCache = false;
    /** Prevent a config load started before invalidation from repopulating the cleared maps. */
    private configRevision = 0;
    private disabled = false;
    private loadSvelteConfigTs: boolean;
    private explicitConfigScope?: ExplicitConfigScope;

    constructor(
        private globSync: typeof fdir,
        private fs: Pick<typeof _fs, 'existsSync'> & Partial<Pick<typeof _fs, 'readFileSync'>>,
        private path: Pick<typeof _path, 'dirname' | 'relative' | 'join'>,
        processFeatures: (typeof process)['features'] & {
            typescript?: false | 'transform';
        },
        private loadFromDirectory: LoadConfigFromDirectoryFn
    ) {
        this.loadSvelteConfigTs =
            processFeatures && 'typescript' in processFeatures && !!processFeatures.typescript;
    }

    /**
     * Enable/disable loading of configs (for security reasons for example)
     */
    setDisabled(disabled: boolean): void {
        this.disabled = disabled;
    }

    /**
     * Use a specific config file path instead of searching for standard config filenames.
     * Only applies within `rootDirectory` (the initial tsconfig/workspace being checked).
     */
    setExplicitConfigScope(scope: ExplicitConfigScope | undefined): void {
        const changed =
            normalizePath(this.explicitConfigScope?.configPath ?? '') !==
                normalizePath(scope?.configPath ?? '') ||
            normalizePath(this.explicitConfigScope?.rootDirectory ?? '') !==
                normalizePath(scope?.rootDirectory ?? '');
        this.explicitConfigScope = scope;
        if (changed) {
            this.invalidateConfigs();
        }
    }

    /**
     * Forget every resolved config association after a config file is created, removed or
     * changed. Config lookup is hierarchical, so a nearer config can change the answer for an
     * arbitrary subtree; a targeted cache deletion cannot safely prove which fallback entries
     * are still valid. Structural config edits are rare, making a complete invalidation both
     * simpler and cheaper than serving a stale preprocessor/compiler configuration.
     */
    invalidateConfigs(): void {
        this.configRevision++;
        this.configFiles.clear();
        this.configFilesAsync.clear();
        this.filePathToConfigPath.clear();
        this.directoryToLoadedConfigPath.clear();
        this.directoryToDiscoveredConfigPath.clear();
        this.configTransformIdentities.clear();
        this.effectiveConfigPaths.clear();
        this.clearUpstreamCache = true;
    }

    private isInExplicitConfigScope(fileOrDirPath: string): boolean {
        if (!this.explicitConfigScope) {
            return false;
        }

        const normalized = normalizePath(fileOrDirPath);
        const root = normalizePath(this.explicitConfigScope.rootDirectory);
        return normalized === root || normalized.startsWith(root + '/');
    }

    /**
     * Tries to load all `svelte.config.js` files below given directory
     * and the first one found inside/above that directory.
     *
     * @param directory Directory where to load the configs from
     */
    async loadConfigs(directory: string): Promise<void> {
        // TODO at some point we gotta find a good way to not do this anymore. Nowadays most if not all projects have one svelte.config/vite.config file at the root of the project,
        // no need to traverse each time when there's a tsconfig.json. Something like "if Svelte 5 && tsconfig.json found then don't?"
        const targetRegex = this.loadSvelteConfigTs ? configRegex : configRegexWithoutTs;
        Logger.log('Trying to load configs for', directory);

        try {
            if (this.explicitConfigScope && this.isInExplicitConfigScope(directory)) {
                await this.loadAndCacheConfig(this.explicitConfigScope.configPath, directory);
                return;
            }

            const pathResults = new this.globSync({})
                .withPathSeparator('/')
                .exclude((_, path) => {
                    // no / at the start, path could start with node_modules
                    return path.includes('node_modules/') || path.includes('/.') || path[0] === '.';
                })
                .filter((path, isDir) => {
                    return !isDir && targetRegex.test(path);
                })
                .withRelativePaths()
                .crawl(directory)
                .sync()
                .filter((pathResult) => {
                    const configPath = this.path.join(directory, pathResult);
                    if (!isViteConfigPath(configPath)) {
                        return true;
                    }

                    // Loading both entries would resolve one package twice and mutate the same
                    // vitePreprocess callbacks twice. Keep the authored Svelte entry; loadConfig
                    // resolves it once through this package's directory when Vite is colocated,
                    // while Vite remains the entry for projects configured only through Vite.
                    return !findSvelteConfigInDirectory(
                        this.fs,
                        this.path,
                        this.path.dirname(configPath),
                        this.loadSvelteConfigTs
                    );
                });

            const someConfigIsImmediateFileInDirectory =
                pathResults.length > 0 &&
                pathResults.some((res) => {
                    const dirname = this.path.dirname(res);
                    return !dirname || dirname === '.';
                });
            if (!someConfigIsImmediateFileInDirectory) {
                const configPathUpwards = this.searchConfigPathUpwards(directory);
                if (configPathUpwards) {
                    pathResults.push(this.path.relative(directory, configPathUpwards));
                }
            }
            if (pathResults.length === 0) {
                await this.addFallbackConfig(directory);
                return;
            }

            const promises = pathResults
                .map((pathResult) => this.path.join(directory, pathResult))
                .filter((pathResult) => {
                    const config = this.configFiles.get(pathResult);
                    return !config || config.loadConfigError;
                })
                .map(async (pathResult) => {
                    await this.loadAndCacheConfig(pathResult, directory, {
                        broadDiscovery: true
                    });
                });
            await Promise.all(promises);
        } catch (e) {
            Logger.error(e);
        }
    }

    private async addFallbackConfig(directory: string) {
        const revision = this.configRevision;
        const configPath = this.searchConfigPathUpwards(directory);
        if (configPath) {
            const loadedConfigPath = await this.loadAndCacheConfig(configPath, directory);
            if (revision !== this.configRevision) {
                return;
            }
            const config = loadedConfigPath && this.configFiles.get(loadedConfigPath);
            if (config && !config.loadConfigError && !config.isFallbackConfig) {
                return;
            }
        }

        const fallback = this.useFallbackPreprocessor(
            directory,
            false,
            configPath && isViteConfigPath(configPath) ? 'vite-error' : 'none'
        );
        if (revision !== this.configRevision) {
            return;
        }
        const path = this.path.join(directory, 'svelte.config.js');
        this.configFilesAsync.set(path, Promise.resolve(fallback));
        this.cacheLoadedConfig(path, fallback);
    }

    private searchConfigPathUpwards(path: string) {
        if (this.explicitConfigScope && this.isInExplicitConfigScope(path)) {
            return this.explicitConfigScope.configPath;
        }

        const visitedDirectories: string[] = [];
        let currentDir = path;
        for (;;) {
            if (this.directoryToDiscoveredConfigPath.has(currentDir)) {
                const cached = this.directoryToDiscoveredConfigPath.get(currentDir) ?? null;
                this.cacheDirectoryResolution(
                    this.directoryToDiscoveredConfigPath,
                    visitedDirectories,
                    cached
                );
                return cached ?? undefined;
            }

            visitedDirectories.push(currentDir);
            const configPath =
                findSvelteConfigInDirectory(
                    this.fs,
                    this.path,
                    currentDir,
                    this.loadSvelteConfigTs
                ) ?? findViteConfigInDirectory(this.fs, this.path, currentDir);
            if (configPath) {
                this.cacheDirectoryResolution(
                    this.directoryToDiscoveredConfigPath,
                    visitedDirectories,
                    configPath
                );
                return configPath;
            }

            const parent = this.path.dirname(currentDir);
            if (parent === currentDir) {
                this.cacheDirectoryResolution(
                    this.directoryToDiscoveredConfigPath,
                    visitedDirectories,
                    null
                );
                return undefined;
            }
            currentDir = parent;
        }
    }

    private async loadAndCacheConfig(
        configPath: string,
        directory: string,
        options: { broadDiscovery?: boolean } = {}
    ) {
        const revision = this.configRevision;
        const loadingConfig = this.configFilesAsync.get(configPath);
        if (loadingConfig) {
            await loadingConfig;
            return configPath;
        } else {
            const newConfig = this.loadConfig(configPath, directory, options);
            this.configFilesAsync.set(
                configPath,
                newConfig.then(({ config }) => config)
            );
            const { config, configFilePath } = await newConfig;
            if (revision !== this.configRevision) {
                return configFilePath;
            }
            this.cacheLoadedConfig(configFilePath, config);
            if (configFilePath !== configPath) {
                this.configFiles.set(configPath, config);
                this.effectiveConfigPaths.set(configPath, configFilePath);
            }
            return configFilePath;
        }
    }

    private async loadConfig(
        configPath: string,
        directory: string,
        options: { broadDiscovery?: boolean }
    ) {
        const configDirectory = this.path.dirname(configPath);

        if (this.disabled) {
            return {
                config: {
                    ...this.useFallbackPreprocessor(directory, true, getConfigSource(configPath)),
                    configSource: getConfigSource(configPath),
                    compilerOptions: {
                        ...DEFAULT_OPTIONS,
                        ...NO_GENERATE
                    },
                    loadConfigError: new Error('Config loading is disabled')
                },
                configFilePath: configPath
            };
        }

        const clearCache = this.clearUpstreamCache;
        this.clearUpstreamCache = false;
        // A colocated Vite config is what binds vitePreprocess to this package's resolved root.
        // The workspace scan has already discarded the duplicate Vite entry, so resolving the
        // surviving Svelte entry through its directory performs that binding exactly once.
        const hasColocatedViteConfig =
            isSvelteConfigPath(configPath) &&
            !!findViteConfigInDirectory(this.fs, this.path, configDirectory);
        const loadTarget =
            this.explicitConfigScope &&
            configPath === this.explicitConfigScope.configPath &&
            this.isInExplicitConfigScope(directory)
                ? configPath
                : isSvelteConfigPath(configPath) && !hasColocatedViteConfig
                  ? configPath
                  : configDirectory;
        const result = await this.loadFromDirectory(loadTarget, { traverse: false, clearCache });

        if (result && 'config' in result) {
            const configSource = result.configSource;
<<<<<<< HEAD
            const loadedConfig = result.config as SvelteConfig;
=======
            if ('kit' in result.config && !('prerender' in result.config)) {
                // SvelteKit 3 puts its options at the top level, SvelteKit < 3 inside `kit`,
                // so we need to normalize it.
                result.config = {
                    ...result.config,
                    ...(result.config.kit as any)
                };
            } else {
                // Accessing `kit` emits a warning in 3 so we delete it.
                delete result.config.kit;
            }

>>>>>>> 2cfcc15b4c44dfc1128432e20ca663fe20bdd12e
            const config: SvelteConfig = {
                ...loadedConfig,
                configSource,
                compilerOptions: {
                    ...DEFAULT_OPTIONS,
                    ...(loadedConfig.compilerOptions as CompileOptions | undefined),
                    ...NO_GENERATE
                }
            };
            Logger.log('Loaded config at ', result.configFilePath);
            return {
                config,
                configFilePath: result.configFilePath
            };
        }

        const configSource = result?.configSource ?? getConfigSource(configPath);
        // A vite config that loads fine but has no Svelte plugin is not an error: in a monorepo
        // the crawler also visits packages that don't use Svelte at all. Only report loading
        // failures, which are the cases where `loadConfig` hands back an `error`.
        const loadFailed = result?.error !== undefined;
        const error =
            result?.error ??
            new Error(
                configSource === 'vite'
                    ? 'No Svelte configuration found in vite config. Is @sveltejs/vite-plugin-svelte configured?'
                    : 'No Svelte configuration found'
            );
        const errorConfigPath = result?.configFilePath ?? configPath;
<<<<<<< HEAD
        // A workspace-wide scan also encounters ordinary Vite packages which do not own any
        // Svelte files. Keep the fallback (and its loadConfigError) cached so an actual Svelte
        // document still receives a config diagnostic, but do not make successful workspace
        // checks look broken merely because such a candidate does not configure the Svelte
        // plugin. Real loader/config errors and document-driven loads remain visible.
        const isSynthesizedMissingVitePlugin = configSource === 'vite' && !result?.error;
        if (!options.broadDiscovery || !isSynthesizedMissingVitePlugin) {
            Logger.error('Error while loading config at ', errorConfigPath);
            Logger.error(error);
=======
        if (loadFailed) {
            Logger.error('Error while loading config at ', errorConfigPath);
            Logger.error(error);
        } else {
            Logger.log('No Svelte config found at ', errorConfigPath);
>>>>>>> 2cfcc15b4c44dfc1128432e20ca663fe20bdd12e
        }

        return {
            config: {
                ...this.useFallbackPreprocessor(directory, true, configSource),
                configSource,
                compilerOptions: {
                    ...DEFAULT_OPTIONS,
                    ...NO_GENERATE
                },
                loadConfigError: error
            },
            configFilePath: errorConfigPath
        };
    }

    /**
     * Returns config associated to file. If no config is found, the file
     * was called in a context where no config file search was done before,
     * which can happen
     * - if TS intellisense is turned off and the search did not run on tsconfig init
     * - if the file was opened not through the TS service crawl, but through the LSP
     *
     * @param file
     */
    getConfig(file: string): SvelteConfig | undefined {
        return this.getResolvedConfig(file)?.config;
    }

    /**
     * Return the loaded config, its effective path and its precomputed transform identity.
     * Directory associations (including misses) are memoized until `invalidateConfigs()`.
     */
    getResolvedConfig(file: string): ResolvedSvelteConfig | undefined {
        const cached = this.filePathToConfigPath.get(file);
        if (cached) {
            return this.resolvedConfigForPath(cached);
        }

        if (this.explicitConfigScope && this.isInExplicitConfigScope(file)) {
            const explicit = this.resolvedConfigForPath(this.explicitConfigScope.configPath);
            if (explicit) {
                this.filePathToConfigPath.set(file, explicit.configPath);
                return explicit;
            }
        }

        const visitedDirectories: string[] = [];
        let currentDir = this.path.dirname(file);
        for (;;) {
            if (this.directoryToLoadedConfigPath.has(currentDir)) {
                const cachedPath = this.directoryToLoadedConfigPath.get(currentDir) ?? null;
                this.cacheDirectoryResolution(
                    this.directoryToLoadedConfigPath,
                    visitedDirectories,
                    cachedPath
                );
                if (!cachedPath) {
                    return undefined;
                }
                this.filePathToConfigPath.set(file, cachedPath);
                return this.resolvedConfigForPath(cachedPath);
            }

            visitedDirectories.push(currentDir);
            const configPath = this.tryGetConfigPathForDirectory(currentDir);
            if (configPath) {
                this.cacheDirectoryResolution(
                    this.directoryToLoadedConfigPath,
                    visitedDirectories,
                    configPath
                );
                this.filePathToConfigPath.set(file, configPath);
                return this.resolvedConfigForPath(configPath);
            }

            const parent = this.path.dirname(currentDir);
            if (parent === currentDir) {
                this.cacheDirectoryResolution(
                    this.directoryToLoadedConfigPath,
                    visitedDirectories,
                    null
                );
                return undefined;
            }
            currentDir = parent;
        }
    }

    /**
     * Like `getConfig`, but will search for a config above if no config found.
     */
    async awaitConfig(file: string): Promise<SvelteConfig | undefined> {
        return (await this.awaitResolvedConfig(file))?.config;
    }

    /** Like `getResolvedConfig`, but loads/discovers the effective config on a miss. */
    async awaitResolvedConfig(file: string): Promise<ResolvedSvelteConfig | undefined> {
        const resolved = this.getResolvedConfig(file);
        if (resolved) {
            return resolved;
        }

        const fileDirectory = this.path.dirname(file);
        const configPath = this.searchConfigPathUpwards(fileDirectory);
        if (configPath) {
            await this.loadAndCacheConfig(configPath, fileDirectory);
        } else {
            await this.addFallbackConfig(fileDirectory);
        }
        return this.getResolvedConfig(file);
    }

    /**
     * Load the config authored in exactly `directory`, without walking to an ancestor and without
     * synthesizing a fallback. This is useful for project-wide settings (for example SvelteKit's
     * file locations), whose legacy lookup deliberately uses `traverse: false`.
     *
     * The result is cached in the same maps as document-driven config resolution. A caller can
     * therefore inspect project settings up front and later prime every component without
     * importing or resolving the project config through a second loader path.
     */
    async awaitResolvedConfigForDirectory(
        directory: string
    ): Promise<ResolvedSvelteConfig | undefined> {
        const configPath =
            this.explicitConfigScope && this.isInExplicitConfigScope(directory)
                ? this.explicitConfigScope.configPath
                : (findSvelteConfigInDirectory(
                      this.fs,
                      this.path,
                      directory,
                      this.loadSvelteConfigTs
                  ) ?? findViteConfigInDirectory(this.fs, this.path, directory));
        if (!configPath) {
            return undefined;
        }

        const revision = this.configRevision;
        const loadedConfigPath = await this.loadAndCacheConfig(configPath, directory);
        if (revision !== this.configRevision) {
            return undefined;
        }
        const resolved =
            this.resolvedConfigForPath(configPath) ??
            (loadedConfigPath ? this.resolvedConfigForPath(loadedConfigPath) : undefined);
        if (!resolved) {
            // The load was invalidated while it was in flight. Its replacement generation must
            // perform its own lookup instead of observing the stale result.
            return undefined;
        }

        this.directoryToDiscoveredConfigPath.set(directory, configPath);
        this.directoryToLoadedConfigPath.set(directory, resolved.configPath);
        return resolved;
    }

    private tryGetConfigPathForDirectory(fromDirectory: string): string | undefined {
        for (const ending of getSvelteConfigExtensions(this.loadSvelteConfigTs)) {
            const configPath = this.path.join(fromDirectory, `svelte.config.${ending}`);
            if (this.configFiles.has(configPath)) {
                return configPath;
            }
        }
        for (const ending of VITE_CONFIG_EXTENSIONS) {
            const configPath = this.path.join(fromDirectory, `vite.config.${ending}`);
            if (this.configFiles.has(configPath)) {
                return configPath;
            }
        }
    }

    private cacheLoadedConfig(configPath: string, config: SvelteConfig): void {
        this.configFiles.set(configPath, config);
        this.effectiveConfigPaths.set(configPath, configPath);
        this.configTransformIdentities.set(
            configPath,
            createTransformIdentity(config, configPath, this.fs)
        );
        // A newly loaded config may replace cached misses or a farther ancestor association.
        this.filePathToConfigPath.clear();
        this.directoryToLoadedConfigPath.clear();
    }

    private resolvedConfigForPath(configPath: string): ResolvedSvelteConfig | undefined {
        const effectiveConfigPath = this.effectiveConfigPaths.get(configPath) ?? configPath;
        const config =
            this.configFiles.get(configPath) ?? this.configFiles.get(effectiveConfigPath);
        if (!config) {
            return undefined;
        }
        let transformIdentity = this.configTransformIdentities.get(effectiveConfigPath);
        if (!transformIdentity) {
            transformIdentity = createTransformIdentity(config, effectiveConfigPath, this.fs);
            this.configTransformIdentities.set(effectiveConfigPath, transformIdentity);
        }
        return {
            config,
            configPath: effectiveConfigPath,
            revision: this.configRevision,
            transformIdentity
        };
    }

    private cacheDirectoryResolution(
        cache: FileMap<string | null>,
        directories: readonly string[],
        configPath: string | null
    ): void {
        for (const directory of directories) {
            cache.set(directory, configPath);
        }
    }

    private useFallbackPreprocessor(
        path: string,
        foundConfig: boolean,
        configKind: 'svelte' | 'vite' | 'vite-error' | 'none'
    ): SvelteConfig {
        try {
            const sveltePreprocess = importSveltePreprocess(path);
            Logger.log(
                getFallbackLogMessage(foundConfig, configKind) +
                    'Using https://github.com/sveltejs/svelte-preprocess as fallback'
            );
            return {
                preprocess: sveltePreprocess({
                    // 4.x does not have transpileOnly anymore, but if the user has version 3.x
                    // in his repo, that one is loaded instead, for which we still need this.
                    typescript: {
                        transpileOnly: true,
                        compilerOptions: { sourceMap: true, inlineSourceMap: false }
                    }
                }),
                isFallbackConfig: true
            };
        } catch (e) {
            // User doesn't have svelte-preprocess installed, provide a barebones TS preprocessor
            return {
                preprocess: {
                    // @ts-ignore name property exists in Svelte 4 onwards
                    name: 'svelte-language-tools-ts-fallback-preprocessor',
                    script: ({ content, attributes, filename }) => {
                        if (attributes.lang !== 'ts') return;

                        const { outputText, sourceMapText } = ts.transpileModule(content, {
                            fileName: filename,
                            compilerOptions: {
                                module: ts.ModuleKind.ESNext,
                                target: ts.ScriptTarget.ESNext,
                                sourceMap: true,
                                verbatimModuleSyntax: true
                            }
                        });
                        return { code: outputText, map: sourceMapText };
                    }
                },
                isFallbackConfig: true
            };
        }
    }
}

function getSvelteConfigExtensions(loadSvelteConfigTs: boolean) {
    return loadSvelteConfigTs
        ? [...SVELTE_CONFIG_EXTENSIONS, ...SVELTE_CONFIG_TS_EXTENSIONS]
        : SVELTE_CONFIG_EXTENSIONS;
}

function findSvelteConfigInDirectory(
    fs: Pick<typeof _fs, 'existsSync'>,
    pathUtils: Pick<typeof _path, 'join'>,
    directory: string,
    loadSvelteConfigTs: boolean
) {
    for (const ending of getSvelteConfigExtensions(loadSvelteConfigTs)) {
        const configPath = pathUtils.join(directory, `svelte.config.${ending}`);
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }
}

function findViteConfigInDirectory(
    fs: Pick<typeof _fs, 'existsSync'>,
    pathUtils: Pick<typeof _path, 'join'>,
    directory: string
) {
    for (const ending of VITE_CONFIG_EXTENSIONS) {
        const configPath = pathUtils.join(directory, `vite.config.${ending}`);
        if (fs.existsSync(configPath)) {
            return configPath;
        }
    }
}

function isViteConfigPath(configPath: string): boolean {
    return /[/\\]vite\.config\.(js|mjs|ts|cjs|mts|cts)$/.test(configPath);
}

function isSvelteConfigPath(configPath: string): boolean {
    return /[/\\]svelte\.config\.(js|mjs|ts|cjs|mts)$/.test(configPath);
}

function getConfigSource(configPath: string): 'svelte' | 'vite' {
    return isViteConfigPath(configPath) ? 'vite' : 'svelte';
}

function getFallbackLogMessage(
    foundConfig: boolean,
    configKind: 'svelte' | 'vite' | 'vite-error' | 'none'
) {
    if (foundConfig && configKind === 'svelte') {
        return 'Found svelte.config.js but there was an error loading it. ';
    }
    if (foundConfig && configKind === 'vite') {
        return 'Found vite.config but there was an error loading it. ';
    }
    if (configKind === 'vite-error') {
        return 'Found vite.config but there was an error loading Svelte options from it. ';
    }
    return 'No svelte.config.js or vite.config found. ';
}

function createTransformIdentity(
    config: SvelteConfig,
    configPath: string,
    fs: Partial<Pick<typeof _fs, 'readFileSync'>>
): SvelteConfigTransformIdentity {
    const compiler = config.compilerOptions;
    const preprocess = Array.isArray(config.preprocess) ? config.preprocess : [config.preprocess];
    const contents = readConfigContents(configPath, fs);
    return {
        configFile:
            contents === undefined
                ? undefined
                : {
                      path: normalizePath(configPath),
                      stamp: contentStamp(contents)
                  },
        source: config.configSource,
        fallback: config.isFallbackConfig ? true : undefined,
        namespace: compiler?.namespace,
        accessors: compiler?.accessors,
        customElement:
            typeof compiler?.customElement === 'function'
                ? String(compiler.customElement)
                : compiler?.customElement,
        defaultLanguages: preprocess
            .map((entry) => entry?.defaultLanguages)
            .filter(
                (entry): entry is NonNullable<InternalPreprocessorGroup['defaultLanguages']> =>
                    !!entry
            ),
        preprocessors: preprocess
            .filter((entry): entry is InternalPreprocessorGroup => !!entry)
            .map((entry) => ({
                markup: functionIdentity(entry.markup),
                script: functionIdentity(entry.script),
                style: functionIdentity(entry.style)
            }))
    };
}

function readConfigContents(
    configPath: string,
    fs: Partial<Pick<typeof _fs, 'readFileSync'>>
): string | undefined {
    try {
        const contents = fs.readFileSync?.(configPath, 'utf8');
        return typeof contents === 'string' ? contents : undefined;
    } catch {
        return undefined;
    }
}

function contentStamp(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${hash >>> 0}`;
}

function functionIdentity(value: unknown): string | undefined {
    return typeof value === 'function' ? String(value) : undefined;
}

export const configLoader = new ConfigLoader(
    fdir,
    _fs,
    _path,
    process.features,
    loadConfigFromDirectory
);
