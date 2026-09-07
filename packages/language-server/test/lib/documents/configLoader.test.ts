import { ConfigLoader } from '../../../src/lib/documents/configLoader';
<<<<<<< HEAD
import fs from 'fs';
import os from 'os';
=======
import { Logger } from '../../../src/logger';
>>>>>>> 2cfcc15b4c44dfc1128432e20ca663fe20bdd12e
import path from 'path';
import { pathToFileURL, URL } from 'url';
import assert from 'assert';
import { spy, stub } from 'sinon';
import { preprocess } from 'svelte/compiler';
import { Logger } from '../../../src/logger';

describe('ConfigLoader', () => {
    function configFrom(path: string, configSource: 'svelte' | 'vite' = 'svelte') {
        return {
            compilerOptions: {
                dev: true,
                generate: false
            },
            preprocess: pathToFileURL(path).toString(),
            configSource
        };
    }

    function viteConfig() {
        return {
            compilerOptions: {
                dev: true,
                generate: false
            },
            preprocess: { name: 'vite-preprocess' },
            configSource: 'vite' as const
        };
    }

    function normalizePath(filePath: string): string {
        return path.join(...filePath.split('/'));
    }

    function mockFdir(results: string[] | (() => string[])): any {
        return class {
            withPathSeparator() {
                return this;
            }
            exclude() {
                return this;
            }
            filter() {
                return this;
            }
            withRelativePaths() {
                return this;
            }
            crawl() {
                return this;
            }
            sync() {
                return typeof results === 'function' ? results() : results;
            }
        };
    }

    function createConfigLoader(
        globSync: any,
        fs: Pick<typeof import('fs'), 'existsSync'> &
            Partial<Pick<typeof import('fs'), 'readFileSync'>>,
        moduleLoader: (module: URL) => Promise<any>,
        processFeatures: (typeof process)['features'] & { typescript?: false | 'transform' },
        loadFromVite?: (root: string) => Promise<any>
    ) {
        return new ConfigLoader(globSync, fs, path, processFeatures, async (dirOrFile) => {
            if (isConfigFilePath(dirOrFile)) {
                if (/[/\\]svelte\.config\./.test(dirOrFile)) {
                    return loadConfigFile(dirOrFile);
                }
                if (loadFromVite) {
                    const config = await loadFromVite(path.dirname(dirOrFile));
                    if (config) {
                        return { config, configFilePath: dirOrFile, configSource: 'vite' };
                    }
                }
                return loadConfigFile(dirOrFile);
            }

            const viteConfigPath = findConfig(dirOrFile, 'vite.config', [
                'js',
                'mjs',
                'ts',
                'cjs',
                'mts',
                'cts'
            ]);
            if (viteConfigPath && loadFromVite) {
                const config = await loadFromVite(dirOrFile);
                if (config) {
                    return { config, configFilePath: viteConfigPath, configSource: 'vite' };
                }
            }

            const svelteConfigPath = findConfig(
                dirOrFile,
                'svelte.config',
                processFeatures && 'typescript' in processFeatures && processFeatures.typescript
                    ? ['js', 'cjs', 'mjs', 'ts', 'mts']
                    : ['js', 'cjs', 'mjs']
            );
            if (!svelteConfigPath) {
                return undefined;
            }

            return loadConfigFile(svelteConfigPath);

            function isConfigFilePath(filePath: string) {
                return /\.(js|cjs|mjs|ts|mts|cts)$/.test(path.basename(filePath));
            }

            async function loadConfigFile(configFilePath: string) {
                try {
                    const config = (await moduleLoader(pathToFileURL(configFilePath)))?.default;
                    if (!config) {
                        throw new Error('Missing exports in the config.');
                    }
                    return { config, configFilePath, configSource: 'svelte' as const };
                } catch (error) {
                    return {
                        error,
                        configFilePath,
                        configSource: 'svelte' as const
                    };
                }
            }

            function findConfig(
                directory: string,
                basename: 'svelte.config' | 'vite.config',
                extensions: string[]
            ) {
                for (const extension of extensions) {
                    const configPath = path.join(directory, `${basename}.${extension}`);
                    if (fs.existsSync(configPath)) {
                        return configPath;
                    }
                }
            }
        });
    }

    async function assertFindsConfig(
        configLoader: ConfigLoader,
        filePath: string,
        configPath: string
    ) {
        filePath = normalizePath(filePath);
        configPath = normalizePath(configPath);
        assert.deepStrictEqual(configLoader.getConfig(filePath), configFrom(configPath));
        assert.deepStrictEqual(await configLoader.awaitConfig(filePath), configFrom(configPath));
    }

    it('should load all config files below and the one inside/above given directory', async () => {
        const configLoader = createConfigLoader(
            mockFdir(['svelte.config.js', 'below/svelte.config.js']),
            { existsSync: () => true },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            process.features
        );
        await configLoader.loadConfigs(normalizePath('/some/path'));

        await assertFindsConfig(
            configLoader,
            '/some/path/comp.svelte',
            '/some/path/svelte.config.js'
        );
        await assertFindsConfig(
            configLoader,
            '/some/path/aside/comp.svelte',
            '/some/path/svelte.config.js'
        );
        await assertFindsConfig(
            configLoader,
            '/some/path/below/comp.svelte',
            '/some/path/below/svelte.config.js'
        );
        await assertFindsConfig(
            configLoader,
            '/some/path/below/further/comp.svelte',
            '/some/path/below/svelte.config.js'
        );
    });

    it('finds first above if none found inside/below directory', async () => {
        const configLoader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (p) =>
                    typeof p === 'string' && p.endsWith(path.join('some', 'svelte.config.js'))
            },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            process.features
        );
        await configLoader.loadConfigs(normalizePath('/some/path'));

        await assertFindsConfig(configLoader, '/some/path/comp.svelte', '/some/svelte.config.js');
    });

    it('adds fallback if no config found', async () => {
        const configLoader = createConfigLoader(
            mockFdir([]),
            { existsSync: () => false },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            process.features
        );
        await configLoader.loadConfigs(normalizePath('/some/path'));

        assert.deepStrictEqual(
            // Can't do the equal-check directly, instead check if it's the expected object props
            Object.keys(
                configLoader.getConfig(normalizePath('/some/path/comp.svelte'))?.preprocess || {}
            ).sort(),
            ['name', 'script'].sort()
        );
    });

    it('will not load config multiple times if config loading started in parallel', async () => {
        let firstGlobCall = true;
        let nrImportCalls = 0;
        const configLoader = createConfigLoader(
            mockFdir(() => {
                if (firstGlobCall) {
                    firstGlobCall = false;
                    return ['svelte.config.js'];
                } else {
                    return [];
                }
            }),
            {
                existsSync: (p) =>
                    typeof p === 'string' &&
                    p.endsWith(path.join('some', 'path', 'svelte.config.js'))
            },
            (module: URL) => {
                nrImportCalls++;
                return new Promise((resolve) => {
                    setTimeout(() => resolve({ default: { preprocess: module.toString() } }), 500);
                });
            },
            process.features
        );
        await Promise.all([
            configLoader.loadConfigs(normalizePath('/some/path')),
            configLoader.loadConfigs(normalizePath('/some/path/sub')),
            configLoader.awaitConfig(normalizePath('/some/path/file.svelte'))
        ]);

        await assertFindsConfig(
            configLoader,
            '/some/path/comp.svelte',
            '/some/path/svelte.config.js'
        );
        await assertFindsConfig(
            configLoader,
            '/some/path/sub/comp.svelte',
            '/some/path/svelte.config.js'
        );
        assert.deepStrictEqual(nrImportCalls, 1);
    });

    it('can deal with missing config', () => {
        const configLoader = createConfigLoader(
            mockFdir([]),
            { existsSync: () => false },
            () => Promise.resolve('unimportant'),
            process.features
        );
        assert.deepStrictEqual(
            configLoader.getConfig(normalizePath('/some/file.svelte')),
            undefined
        );
    });

    it('should await config', async () => {
        const configLoader = createConfigLoader(
            mockFdir([]),
            { existsSync: () => true },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            process.features
        );
        assert.deepStrictEqual(
            await configLoader.awaitConfig(normalizePath('some/file.svelte')),
            configFrom(normalizePath('some/svelte.config.js'))
        );
    });

    it('should not load config when disabled', async () => {
        const moduleLoader = spy();
        const configLoader = createConfigLoader(
            mockFdir([]),
            { existsSync: () => true },
            moduleLoader,
            process.features
        );
        configLoader.setDisabled(true);
        await configLoader.awaitConfig(normalizePath('some/file.svelte'));
        assert.deepStrictEqual(moduleLoader.notCalled, true);
    });

    it('loads config from vite.config when no svelte.config found', async () => {
        const viteConfigDir = normalizePath('/some/path');
        const viteConfigPath = path.join(viteConfigDir, 'vite.config.js');
        const configLoader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (p) => typeof p === 'string' && p.endsWith(viteConfigPath)
            },
            () => Promise.resolve({ default: {} }),
            process.features,
            async (root) => {
                assert.equal(root, viteConfigDir);
                return viteConfig();
            }
        );
        await configLoader.loadConfigs(viteConfigDir);

        assert.deepStrictEqual(
            configLoader.getConfig(normalizePath('/some/path/comp.svelte')),
            viteConfig()
        );
    });

    it('resolves colocated svelte and Vite configs exactly once through Vite', async () => {
        const root = normalizePath('/some/path');
        const svelteConfigPath = normalizePath('/some/path/svelte.config.js');
        const viteConfigPath = normalizePath('/some/path/vite.config.js');
        const loadFromVite = spy(async () => viteConfig());
        const moduleLoader = spy(async (module: URL) => ({
            default: { preprocess: module.toString() }
        }));
        const configLoader = createConfigLoader(
            mockFdir(['svelte.config.js', 'vite.config.js']),
            {
                existsSync: (p) =>
                    typeof p === 'string' &&
                    (p.endsWith(svelteConfigPath) || p.endsWith(viteConfigPath))
            },
            moduleLoader,
            process.features,
            loadFromVite
        );
        await configLoader.loadConfigs(root);

        const component = normalizePath('/some/path/comp.svelte');
        assert.deepStrictEqual(configLoader.getConfig(component), viteConfig());
        assert.deepStrictEqual(await configLoader.awaitConfig(component), viteConfig());
        assert.strictEqual(configLoader.getResolvedConfig(component)?.configPath, viteConfigPath);
        assert.deepStrictEqual(loadFromVite.calledOnce, true);
        assert.deepStrictEqual(loadFromVite.firstCall.args, [root]);
        assert.deepStrictEqual(moduleLoader.notCalled, true);
    });

    it('keeps nested package PostCSS roots isolated across consecutive Vite resolutions', async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-config-roots-'));
        const firstRoot = path.join(workspace, 'packages', 'first');
        const secondRoot = path.join(workspace, 'packages', 'second');
        const moduleLoader = spy(async () => ({ default: {} }));

        try {
            for (const [root, marker] of [
                [firstRoot, 'first-package'],
                [secondRoot, 'second-package']
            ]) {
                fs.mkdirSync(root, { recursive: true });
                fs.writeFileSync(path.join(root, 'svelte.config.js'), 'export default {};\n');
                fs.writeFileSync(path.join(root, 'vite.config.js'), 'export default {};\n');
                fs.writeFileSync(
                    path.join(root, 'postcss.config.cjs'),
                    `module.exports = { marker: '${marker}' };\n`
                );
            }

            const loadFromVite = spy(async (root: string) => {
                type RootedStyle = ((input: { content: string }) => Promise<{ code: string }>) & {
                    __resolvedConfig: { root: string };
                };
                const style = (async ({ content }: { content: string }) => {
                    const postcssConfig = require(
                        path.join(style.__resolvedConfig.root, 'postcss.config.cjs')
                    ) as { marker: string };
                    return { code: `${content}/* ${postcssConfig.marker} */` };
                }) as RootedStyle;
                // vite-plugin-svelte binds vitePreprocess this way after resolving Vite.
                style.__resolvedConfig = { root };
                return { preprocess: { name: 'vite-preprocess', style } };
            });
            const configLoader = createConfigLoader(
                mockFdir(['svelte.config.js', 'vite.config.js']),
                fs,
                moduleLoader,
                process.features,
                loadFromVite
            );

            await configLoader.loadConfigs(firstRoot);
            const firstConfig = configLoader.getConfig(path.join(firstRoot, 'Component.svelte'));
            assert.ok(firstConfig?.preprocess);

            await configLoader.loadConfigs(secondRoot);
            const secondConfig = configLoader.getConfig(path.join(secondRoot, 'Component.svelte'));
            assert.ok(secondConfig?.preprocess);

            const source = '<style>.component { color: red; }</style>';
            const [first, second] = await Promise.all([
                preprocess(source, firstConfig.preprocess, {
                    filename: path.join(firstRoot, 'Component.svelte')
                }),
                preprocess(source, secondConfig.preprocess, {
                    filename: path.join(secondRoot, 'Component.svelte')
                })
            ]);

            assert.match(first.code, /first-package/);
            assert.doesNotMatch(first.code, /second-package/);
            assert.match(second.code, /second-package/);
            assert.deepStrictEqual(
                loadFromVite.args.map(([root]) => root),
                [firstRoot, secondRoot]
            );
            assert.deepStrictEqual(moduleLoader.notCalled, true);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('falls back to preprocessors when vite config has no svelte plugin options', async () => {
        const viteConfigPath = normalizePath('/some/path/vite.config.ts');
        const configLoader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (p) => typeof p === 'string' && p.endsWith(viteConfigPath)
            },
            () => Promise.resolve({ default: {} }),
            process.features,
            async () => undefined
        );
        await configLoader.loadConfigs(normalizePath('/some/path'));

        assert.deepStrictEqual(
            Object.keys(
                configLoader.getConfig(normalizePath('/some/path/comp.svelte'))?.preprocess || {}
            ).sort(),
            ['name', 'script'].sort()
        );
    });

<<<<<<< HEAD
    it('silences only synthesized missing-plugin errors from broadly discovered Vite configs', async () => {
        const workspace = normalizePath('/workspace');
        const packageRoot = path.join(workspace, 'packages', 'effect');
        const viteConfigPath = path.join(packageRoot, 'vite.config.ts');
        const loggerError = stub(Logger, 'error');
        const configLoader = createConfigLoader(
            mockFdir([normalizePath('packages/effect/vite.config.ts')]),
            {
                existsSync: (candidate) =>
                    typeof candidate === 'string' && candidate.endsWith(viteConfigPath)
            },
            () => Promise.resolve({ default: {} }),
            process.features,
            async () => undefined
        );

        try {
            await configLoader.loadConfigs(workspace);

            assert.strictEqual(loggerError.notCalled, true);
            const config = configLoader.getConfig(path.join(packageRoot, 'Component.svelte'));
            assert.ok(config?.loadConfigError instanceof Error);
            assert.match(config.loadConfigError.message, /No Svelte configuration found/);
        } finally {
            loggerError.restore();
        }
    });

    it('logs synthesized missing-plugin errors for a document-owned Vite config', async () => {
        const packageRoot = normalizePath('/workspace/packages/app');
        const viteConfigPath = path.join(packageRoot, 'vite.config.ts');
        const loggerError = stub(Logger, 'error');
        const configLoader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) =>
                    typeof candidate === 'string' && candidate.endsWith(viteConfigPath)
            },
            () => Promise.resolve({ default: {} }),
            process.features,
            async () => undefined
        );

        try {
            const config = await configLoader.awaitConfig(
                path.join(packageRoot, 'Component.svelte')
            );

            assert.strictEqual(loggerError.callCount, 2);
            assert.ok(config?.loadConfigError instanceof Error);
            assert.match(config.loadConfigError.message, /No Svelte configuration found/);
        } finally {
            loggerError.restore();
        }
    });

    it('logs real Vite loader errors found during broad discovery', async () => {
        const workspace = normalizePath('/workspace');
        const viteConfigPath = path.join(workspace, 'vite.config.ts');
        const configError = new Error('Invalid Vite configuration');
        const loggerError = stub(Logger, 'error');
        const configLoader = new ConfigLoader(
            mockFdir(['vite.config.ts']),
            {
                existsSync: (candidate) =>
                    typeof candidate === 'string' && candidate.endsWith(viteConfigPath)
            },
            path,
            process.features,
            async () => ({
                error: configError,
                configFilePath: viteConfigPath,
                configSource: 'vite'
            })
        );

        try {
            await configLoader.loadConfigs(workspace);

            assert.strictEqual(loggerError.callCount, 2);
            assert.strictEqual(loggerError.secondCall.args[0], configError);
        } finally {
            loggerError.restore();
=======
    it('does not log an error when vite config has no svelte plugin', async () => {
        const errorSpy = spy(Logger, 'error');
        try {
            const viteConfigPath = normalizePath('/some/path/vite.config.ts');
            const configLoader = createConfigLoader(
                mockFdir([]),
                {
                    existsSync: (p) => typeof p === 'string' && p.endsWith(viteConfigPath)
                },
                () => Promise.resolve({ default: {} }),
                process.features,
                async () => undefined
            );
            await configLoader.loadConfigs(normalizePath('/some/path'));

            assert.deepStrictEqual(errorSpy.called, false);
        } finally {
            errorSpy.restore();
        }
    });

    it('logs an error when the vite config itself fails to load', async () => {
        const errorSpy = spy(Logger, 'error');
        try {
            const viteConfigPath = normalizePath('/some/path/vite.config.ts');
            // Built directly instead of through createConfigLoader, which always wraps the
            // result in `{ config }` and so cannot express a failed load.
            const configLoader = new ConfigLoader(
                mockFdir([]),
                {
                    existsSync: (p: any) => typeof p === 'string' && p.endsWith(viteConfigPath)
                } as any,
                path,
                process.features,
                async () =>
                    ({
                        error: new Error('kaboom'),
                        configFilePath: viteConfigPath,
                        configSource: 'vite'
                    }) as any
            );
            await configLoader.loadConfigs(normalizePath('/some/path'));

            assert.deepStrictEqual(errorSpy.called, true);
        } finally {
            errorSpy.restore();
>>>>>>> 2cfcc15b4c44dfc1128432e20ca663fe20bdd12e
        }
    });

    it('can scan svelte.config.ts', async () => {
        const configLoader = createConfigLoader(
            mockFdir(['svelte.config.ts']),
            {
                existsSync: (p) =>
                    typeof p === 'string' &&
                    p.endsWith(path.join('some', 'path', 'svelte.config.ts'))
            },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            { ...process.features, typescript: 'transform' }
        );
        await configLoader.loadConfigs(normalizePath('/some/path'));

        await assertFindsConfig(
            configLoader,
            '/some/path/comp.svelte',
            '/some/path/svelte.config.ts'
        );
    });

    it('can skips svelte.config.ts loading', async () => {
        const configLoader = createConfigLoader(
            mockFdir(['svelte.config.ts', 'svelte.config.cjs']),
            {
                existsSync: (p) =>
                    typeof p === 'string' &&
                    (p.endsWith(path.join('some', 'path', 'svelte.config.ts')) ||
                        p.endsWith(path.join('some', 'path', 'svelte.config.cjs')))
            },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            { ...process.features, typescript: false }
        );
        await configLoader.loadConfigs(normalizePath('/some/path'));

        await assertFindsConfig(
            configLoader,
            '/some/path/comp.svelte',
            '/some/path/svelte.config.cjs'
        );
    });

    it('reloads hierarchical config after structural invalidation', async () => {
        let revision = 1;
        let loads = 0;
        const configPath = normalizePath('/some/path/svelte.config.js');
        const loader = createConfigLoader(
            mockFdir(['svelte.config.js']),
            {
                existsSync: (candidate) =>
                    typeof candidate === 'string' && candidate.endsWith(configPath)
            },
            async () => {
                loads++;
                return { default: { compilerOptions: { customElement: revision === 2 } } };
            },
            process.features
        );
        const component = normalizePath('/some/path/Comp.svelte');

        await loader.loadConfigs(normalizePath('/some/path'));
        assert.strictEqual(loader.getConfig(component)?.compilerOptions?.customElement, false);
        revision = 2;
        loader.invalidateConfigs();
        await loader.awaitConfig(component);

        assert.strictEqual(loader.getConfig(component)?.compilerOptions?.customElement, true);
        assert.strictEqual(loads, 2);
    });

    it('returns cached config metadata and reads the authored config once', async () => {
        const configPath = normalizePath('/workspace/svelte.config.js');
        let existsCalls = 0;
        let readCalls = 0;
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => {
                    existsCalls++;
                    return candidate === configPath;
                },
                readFileSync: ((candidate: fs.PathOrFileDescriptor) => {
                    assert.strictEqual(candidate, configPath);
                    readCalls++;
                    return 'export default { compilerOptions: { namespace: "svg" } };';
                }) as typeof fs.readFileSync
            },
            async () => ({
                default: {
                    compilerOptions: { namespace: 'svg' },
                    preprocess: { script: () => ({ code: '' }) }
                }
            }),
            process.features
        );

        const first = await loader.awaitResolvedConfig(
            normalizePath('/workspace/src/deep/First.svelte')
        );
        const existsAfterFirstLookup = existsCalls;
        const second = loader.getResolvedConfig(normalizePath('/workspace/src/deep/Second.svelte'));

        assert.strictEqual(first?.configPath, configPath);
        assert.strictEqual(second?.configPath, configPath);
        assert.strictEqual(first?.transformIdentity, second?.transformIdentity);
        assert.deepStrictEqual(first?.transformIdentity.configFile, {
            path: configPath,
            stamp: '57:2460512063'
        });
        assert.strictEqual(first?.transformIdentity.namespace, 'svg');
        assert.strictEqual(first?.transformIdentity.preprocessors.length, 1);
        assert.strictEqual(readCalls, 1);
        assert.strictEqual(existsCalls, existsAfterFirstLookup);
    });

    it('shares an exact-directory project config with later document resolution', async () => {
        const configPath = normalizePath('/workspace/app/svelte.config.js');
        let loads = 0;
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => candidate === configPath,
                readFileSync: (() =>
                    'export default { kit: { files: { params: "params" } } };') as unknown as typeof fs.readFileSync
            },
            async () => {
                loads++;
                return { default: { kit: { files: { params: 'params' } } } };
            },
            process.features
        );

        const projectConfig = await loader.awaitResolvedConfigForDirectory(
            normalizePath('/workspace/app')
        );
        const documentConfig = await loader.awaitResolvedConfig(
            normalizePath('/workspace/app/src/Component.svelte')
        );

        assert.strictEqual(projectConfig?.configPath, configPath);
        assert.strictEqual(projectConfig?.config.kit?.files.params, 'params');
        assert.strictEqual(documentConfig?.config, projectConfig?.config);
        assert.strictEqual(documentConfig?.transformIdentity, projectConfig?.transformIdentity);
        assert.strictEqual(loads, 1);
    });

    it('keeps exact-directory misses separate from document ancestor traversal', async () => {
        const configPath = normalizePath('/workspace/svelte.config.js');
        let loads = 0;
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => candidate === configPath,
                readFileSync: (() =>
                    'export default { compilerOptions: { accessors: true } };') as unknown as typeof fs.readFileSync
            },
            async () => {
                loads++;
                return { default: { compilerOptions: { accessors: true } } };
            },
            process.features
        );

        assert.strictEqual(
            await loader.awaitResolvedConfigForDirectory(normalizePath('/workspace/app')),
            undefined
        );
        const documentConfig = await loader.awaitResolvedConfig(
            normalizePath('/workspace/app/src/Component.svelte')
        );

        assert.strictEqual(documentConfig?.configPath, configPath);
        assert.strictEqual(documentConfig?.config.compilerOptions?.accessors, true);
        assert.strictEqual(loads, 1);
    });

    it('loads an explicit project config once through the exact-directory path', async () => {
        const projectRoot = normalizePath('/workspace/app');
        const explicitConfigPath = normalizePath('/workspace/config/custom.config.cjs');
        let loads = 0;
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => candidate === explicitConfigPath,
                readFileSync: (() =>
                    'module.exports = { kit: { files: { params: "custom" } } };') as unknown as typeof fs.readFileSync
            },
            async () => {
                loads++;
                return { default: { kit: { files: { params: 'custom' } } } };
            },
            process.features
        );
        loader.setExplicitConfigScope({
            configPath: explicitConfigPath,
            rootDirectory: projectRoot
        });

        const projectConfig = await loader.awaitResolvedConfigForDirectory(projectRoot);
        const documentConfig = await loader.awaitResolvedConfig(
            path.join(projectRoot, 'src/Component.svelte')
        );

        assert.strictEqual(projectConfig?.configPath, explicitConfigPath);
        assert.strictEqual(projectConfig?.config.kit?.files.params, 'custom');
        assert.strictEqual(documentConfig?.config, projectConfig?.config);
        assert.strictEqual(loads, 1);
    });

    it('does not publish an invalidated exact-directory load', async () => {
        const directory = normalizePath('/workspace/app');
        const configPath = path.join(directory, 'svelte.config.js');
        let load = 0;
        let releaseOld!: () => void;
        let oldLoadStarted!: () => void;
        const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
        const oldStarted = new Promise<void>((resolve) => (oldLoadStarted = resolve));
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => candidate === configPath,
                readFileSync: (() => 'export default {};') as unknown as typeof fs.readFileSync
            },
            async () => {
                load++;
                if (load === 1) {
                    oldLoadStarted();
                    await oldGate;
                    return { default: { compilerOptions: { accessors: false } } };
                }
                return { default: { compilerOptions: { accessors: true } } };
            },
            process.features
        );

        const staleLoad = loader.awaitResolvedConfigForDirectory(directory);
        await oldStarted;
        loader.invalidateConfigs();
        const current = await loader.awaitResolvedConfigForDirectory(directory);
        releaseOld();
        const stale = await staleLoad;

        assert.strictEqual(stale, undefined);
        assert.strictEqual(current?.config.compilerOptions?.accessors, true);
        assert.strictEqual(
            loader.getResolvedConfig(path.join(directory, 'Component.svelte'))?.config,
            current?.config
        );
        assert.strictEqual(load, 2);
    });

    it('invalidates cached negative config discovery when a config is created', async () => {
        const configPath = normalizePath('/workspace/svelte.config.js');
        let hasConfig = false;
        let existsCalls = 0;
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => {
                    existsCalls++;
                    return hasConfig && candidate === configPath;
                },
                readFileSync: ((candidate: fs.PathOrFileDescriptor) => {
                    if (!hasConfig || candidate !== configPath) {
                        throw new Error('ENOENT');
                    }
                    return 'export default {};';
                }) as typeof fs.readFileSync
            },
            async () => ({ default: {} }),
            process.features
        );
        const component = normalizePath('/workspace/src/Component.svelte');

        const fallback = await loader.awaitResolvedConfig(component);
        const callsAfterNegativeLookup = existsCalls;
        assert.strictEqual(fallback?.transformIdentity.fallback, true);
        assert.strictEqual(fallback?.transformIdentity.configFile, undefined);

        const cachedFallback = loader.getResolvedConfig(component);
        assert.strictEqual(cachedFallback?.config, fallback?.config);
        assert.strictEqual(cachedFallback?.transformIdentity, fallback?.transformIdentity);
        assert.strictEqual(existsCalls, callsAfterNegativeLookup);

        hasConfig = true;
        loader.invalidateConfigs();
        const authored = await loader.awaitResolvedConfig(component);

        assert.strictEqual(authored?.configPath, configPath);
        assert.ok(authored?.transformIdentity.configFile?.stamp);
        assert.ok((authored?.revision ?? 0) > (fallback?.revision ?? 0));
        assert.ok(existsCalls > callsAfterNegativeLookup);
    });

    it('invalidates positive directory associations on nearer config creation and deletion', async () => {
        const rootConfig = normalizePath('/workspace/svelte.config.js');
        const nearConfig = normalizePath('/workspace/packages/app/svelte.config.js');
        const configs = new Map([
            [rootConfig, 'export default { compilerOptions: { accessors: false } };']
        ]);
        const loader = createConfigLoader(
            mockFdir([]),
            {
                existsSync: (candidate) => typeof candidate === 'string' && configs.has(candidate),
                readFileSync: ((candidate: fs.PathOrFileDescriptor) =>
                    configs.get(String(candidate))!) as typeof fs.readFileSync
            },
            async (module) => ({
                default: {
                    compilerOptions: {
                        accessors: module.pathname.includes('/packages/app/')
                    }
                }
            }),
            process.features
        );
        const component = normalizePath('/workspace/packages/app/src/Component.svelte');

        const initial = await loader.awaitResolvedConfig(component);
        assert.strictEqual(initial?.configPath, rootConfig);
        assert.strictEqual(initial?.transformIdentity.accessors, false);

        configs.set(nearConfig, 'export default { compilerOptions: { accessors: true } };');
        loader.invalidateConfigs();
        const nearer = await loader.awaitResolvedConfig(component);
        assert.strictEqual(nearer?.configPath, nearConfig);
        assert.strictEqual(nearer?.transformIdentity.accessors, true);
        assert.notStrictEqual(
            nearer?.transformIdentity.configFile?.stamp,
            initial?.transformIdentity.configFile?.stamp
        );

        configs.delete(nearConfig);
        loader.invalidateConfigs();
        const restored = await loader.awaitResolvedConfig(component);
        assert.strictEqual(restored?.configPath, rootConfig);
        assert.strictEqual(restored?.transformIdentity.accessors, false);
        assert.deepStrictEqual(
            restored?.transformIdentity.configFile,
            initial?.transformIdentity.configFile
        );
    });

    it('does not let an invalidated in-flight config overwrite the replacement', async () => {
        let load = 0;
        let releaseOld!: () => void;
        let oldLoadStarted!: () => void;
        const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
        const oldStarted = new Promise<void>((resolve) => (oldLoadStarted = resolve));
        const configPath = normalizePath('/some/path/svelte.config.js');
        const loader = createConfigLoader(
            mockFdir(['svelte.config.js']),
            {
                existsSync: (candidate) =>
                    typeof candidate === 'string' && candidate.endsWith(configPath)
            },
            async () => {
                load++;
                if (load === 1) {
                    oldLoadStarted();
                    await oldGate;
                    return { default: { compilerOptions: { customElement: false } } };
                }
                return { default: { compilerOptions: { customElement: true } } };
            },
            process.features
        );
        const directory = normalizePath('/some/path');
        const component = normalizePath('/some/path/Comp.svelte');

        const staleLoad = loader.loadConfigs(directory);
        await oldStarted;
        loader.invalidateConfigs();
        const current = await loader.awaitConfig(component);
        assert.strictEqual(current?.compilerOptions?.customElement, true);

        releaseOld();
        await staleLoad;
        assert.strictEqual(loader.getConfig(component)?.compilerOptions?.customElement, true);
        assert.strictEqual(load, 2);
    });

    it('uses explicit config only within the scoped root directory', async () => {
        const appRoot = normalizePath('/monorepo/packages/app');
        const libRoot = normalizePath('/monorepo/packages/lib');
        const explicitConfigPath = path.join(appRoot, 'vite.custom.config.js');
        const libConfigPath = path.join(libRoot, 'svelte.config.js');

        const configLoader = createConfigLoader(
            mockFdir(['svelte.config.js']),
            {
                existsSync: (p) =>
                    typeof p === 'string' &&
                    (p.endsWith(explicitConfigPath) ||
                        p.endsWith(libConfigPath) ||
                        p.endsWith(path.join(libRoot, 'vite.config.js')))
            },
            (module: URL) => Promise.resolve({ default: { preprocess: module.toString() } }),
            process.features,
            async (root) => {
                if (root === appRoot) {
                    return viteConfig();
                }
                return undefined;
            }
        );

        configLoader.setExplicitConfigScope({
            configPath: explicitConfigPath,
            rootDirectory: appRoot
        });

        await configLoader.loadConfigs(appRoot);
        await configLoader.loadConfigs(libRoot);

        assert.deepStrictEqual(
            configLoader.getConfig(normalizePath('/monorepo/packages/app/comp.svelte')),
            viteConfig()
        );
        await assertFindsConfig(configLoader, '/monorepo/packages/lib/comp.svelte', libConfigPath);
    });
});
