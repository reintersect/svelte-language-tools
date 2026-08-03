import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/src/index.js';

test('resolving a Vite config exposes its root only to that async call tree', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-load-config-vite-root-'));
    const vitePackage = path.join(fixture, 'node_modules', 'vite');
    const originalCwd = process.cwd();
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => (enteredResolve = resolve));
    const release = new Promise((resolve) => (releaseResolve = resolve));

    try {
        fs.mkdirSync(vitePackage, { recursive: true });
        fs.writeFileSync(path.join(fixture, 'vite.config.mjs'), 'export default {};\n');
        fs.writeFileSync(
            path.join(vitePackage, 'package.json'),
            JSON.stringify({
                name: 'vite',
                version: '0.0.0-test',
                type: 'module',
                exports: {
                    '.': './index.mjs',
                    './package.json': './package.json'
                }
            })
        );
        fs.writeFileSync(
            path.join(vitePackage, 'index.mjs'),
            [
                'export async function resolveConfig(inlineConfig) {',
                '    globalThis.__svelteLoadConfigViteGate.entered(inlineConfig);',
                '    await globalThis.__svelteLoadConfigViteGate.release;',
                '    return {',
                '        plugins: [{',
                '            name: "vite-plugin-svelte:config",',
                '            api: { options: { marker: process.cwd() } }',
                '        }]',
                '    };',
                '}',
                ''
            ].join('\n')
        );
        globalThis.__svelteLoadConfigViteGate = {
            entered: enteredResolve,
            release
        };

        const loading = loadConfig(fixture, { traverse: false, clearCache: true });
        const inlineConfig = await entered;
        const runUnrelatedPreprocessor = async () => {
            await Promise.resolve();
            return process.cwd();
        };

        assert.equal(inlineConfig.root, fixture);
        assert.equal(inlineConfig.configFile, path.join(fixture, 'vite.config.mjs'));
        assert.equal(
            await runUnrelatedPreprocessor(),
            originalCwd,
            'an unrelated transform must not observe the package being resolved as cwd'
        );

        releaseResolve();
        const result = await loading;
        assert.equal(result?.configSource, 'vite');
        assert.equal(result?.config?.marker, fixture);
        assert.equal(process.cwd(), originalCwd);
    } finally {
        releaseResolve?.();
        delete globalThis.__svelteLoadConfigViteGate;
        process.chdir(originalCwd);
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('concurrent Vite config resolutions observe their own package roots', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-load-config-vite-concurrent-'));
    const originalCwd = process.cwd();
    const projects = ['a', 'b'].map((name) => path.join(fixture, name));
    const releases = new Map();
    const enteredRoots = [];

    try {
        for (const project of projects) {
            const vitePackage = path.join(project, 'node_modules', 'vite');
            fs.mkdirSync(vitePackage, { recursive: true });
            fs.writeFileSync(path.join(project, 'vite.config.mjs'), 'export default {};\n');
            fs.writeFileSync(
                path.join(vitePackage, 'package.json'),
                JSON.stringify({
                    name: `vite-${path.basename(project)}`,
                    version: '0.0.0-test',
                    type: 'module',
                    exports: {
                        '.': './index.mjs',
                        './package.json': './package.json'
                    }
                })
            );
            fs.writeFileSync(
                path.join(vitePackage, 'index.mjs'),
                [
                    'export async function resolveConfig(inlineConfig) {',
                    '    const rootAtEntry = process.cwd();',
                    '    await globalThis.__svelteLoadConfigConcurrentGate.entered(inlineConfig.root);',
                    '    await globalThis.__svelteLoadConfigConcurrentGate.release(inlineConfig.root);',
                    '    return {',
                    '        plugins: [{',
                    '            name: "vite-plugin-svelte:config",',
                    '            api: { options: { rootAtEntry, rootAfterAwait: process.cwd() } }',
                    '        }]',
                    '    };',
                    '}',
                    ''
                ].join('\n')
            );
        }

        globalThis.__svelteLoadConfigConcurrentGate = {
            entered(root) {
                enteredRoots.push(root);
            },
            release(root) {
                return new Promise((resolve) => releases.set(root, resolve));
            }
        };

        const loading = projects.map((project, index) =>
            loadConfig(project, { traverse: false, clearCache: index === 0 })
        );
        while (enteredRoots.length !== projects.length) {
            await new Promise((resolve) => setImmediate(resolve));
        }

        assert.equal(process.cwd(), originalCwd, 'unrelated work must retain the real cwd');
        for (const project of projects) {
            releases.get(project)?.();
        }

        const results = await Promise.all(loading);
        assert.deepEqual(
            results.map((result) => result?.config),
            projects.map((project) => ({ rootAtEntry: project, rootAfterAwait: project }))
        );
        assert.equal(process.cwd(), originalCwd);
    } finally {
        for (const release of releases.values()) {
            release();
        }
        delete globalThis.__svelteLoadConfigConcurrentGate;
        process.chdir(originalCwd);
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('config resolutions sharing one Vite module do not overlap mutable plugin state', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-load-config-vite-shared-'));
    const vitePackage = path.join(fixture, 'node_modules', 'vite');
    const projects = ['a', 'b'].map((name) => path.join(fixture, name));

    try {
        fs.mkdirSync(vitePackage, { recursive: true });
        for (const project of projects) {
            fs.mkdirSync(project, { recursive: true });
            fs.writeFileSync(path.join(project, 'vite.config.mjs'), 'export default {};\n');
        }
        fs.writeFileSync(
            path.join(vitePackage, 'package.json'),
            JSON.stringify({
                name: 'vite',
                version: '0.0.0-test',
                type: 'module',
                exports: {
                    '.': './index.mjs',
                    './package.json': './package.json'
                }
            })
        );
        fs.writeFileSync(
            path.join(vitePackage, 'index.mjs'),
            [
                'let sharedPluginRoot;',
                'let active = 0;',
                'export async function resolveConfig() {',
                '    active++;',
                '    globalThis.__svelteLoadConfigSharedState.maxActive = Math.max(',
                '        globalThis.__svelteLoadConfigSharedState.maxActive,',
                '        active',
                '    );',
                '    const rootAtEntry = process.cwd();',
                '    sharedPluginRoot = rootAtEntry;',
                '    await new Promise((resolve) => setTimeout(resolve, 10));',
                '    const rootAfterAwait = process.cwd();',
                '    const pluginRoot = sharedPluginRoot;',
                '    active--;',
                '    return {',
                '        plugins: [{',
                '            name: "vite-plugin-svelte:config",',
                '            api: { options: { rootAtEntry, rootAfterAwait, pluginRoot } }',
                '        }]',
                '    };',
                '}',
                ''
            ].join('\n')
        );
        globalThis.__svelteLoadConfigSharedState = { maxActive: 0 };

        const results = await Promise.all(
            projects.map((project, index) =>
                loadConfig(project, { traverse: false, clearCache: index === 0 })
            )
        );

        assert.equal(globalThis.__svelteLoadConfigSharedState.maxActive, 1);
        assert.deepEqual(
            results.map((result) => result?.config),
            projects.map((project) => ({
                rootAtEntry: project,
                rootAfterAwait: project,
                pluginRoot: project
            }))
        );
    } finally {
        delete globalThis.__svelteLoadConfigSharedState;
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('colocated Svelte configs receive fresh package-local CSS configuration', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-load-config-css-root-'));
    const vitePackage = path.join(fixture, 'node_modules', 'vite');
    const projects = ['a', 'b'].map((name) => path.join(fixture, name));

    try {
        fs.mkdirSync(vitePackage, { recursive: true });
        for (const project of projects) {
            fs.mkdirSync(project, { recursive: true });
            const marker = path.basename(project);
            fs.writeFileSync(
                path.join(project, 'vite.config.mjs'),
                [
                    'export default {',
                    `    css: { marker: ${JSON.stringify(marker)} },`,
                    '    plugins: [{ name: "must-not-run" }]',
                    '};',
                    ''
                ].join('\n')
            );
            fs.writeFileSync(
                path.join(project, 'svelte.config.mjs'),
                [
                    'import path from "node:path";',
                    'const style = async ({ content }) => ({',
                    '    code: `${content}:${process.cwd()}:${path.resolve("tailwind.config.ts")}:${style.__resolvedConfig.root}:${style.__resolvedConfig.css.marker}`',
                    '});',
                    'style.__resolvedConfig = null;',
                    `export default { marker: ${JSON.stringify(marker)}, preprocess: { style } };`,
                    ''
                ].join('\n')
            );
        }
        fs.writeFileSync(
            path.join(vitePackage, 'package.json'),
            JSON.stringify({
                name: 'vite',
                version: '0.0.0-test',
                type: 'module',
                exports: {
                    '.': './index.mjs',
                    './package.json': './package.json'
                }
            })
        );
        fs.writeFileSync(
            path.join(vitePackage, 'index.mjs'),
            [
                'import { pathToFileURL } from "node:url";',
                'export async function loadConfigFromFile(configEnv, configFile, configRoot) {',
                '    const config = (await import(`${pathToFileURL(configFile).href}?root=${encodeURIComponent(configRoot)}`)).default;',
                '    globalThis.__svelteLoadConfigCssCalls.push({',
                '        phase: "load",',
                '        command: configEnv.command,',
                '        root: configRoot,',
                '        cwd: process.cwd()',
                '    });',
                '    return { path: configFile, config, dependencies: [] };',
                '}',
                'export async function resolveConfig(inlineConfig) {',
                '    globalThis.__svelteLoadConfigCssCalls.push({',
                '        phase: "resolve",',
                '        root: inlineConfig.root,',
                '        cwd: process.cwd(),',
                '        configFile: inlineConfig.configFile,',
                '        pluginCount: inlineConfig.plugins.length,',
                '        cssMarker: inlineConfig.css.marker',
                '    });',
                '    return { ...inlineConfig, plugins: [] };',
                '}',
                ''
            ].join('\n')
        );
        globalThis.__svelteLoadConfigCssCalls = [];

        const results = await Promise.all(
            projects.map((project, index) =>
                loadConfig(project, { traverse: false, clearCache: index === 0 })
            )
        );
        const transformed = await Promise.all(
            results.map((result) => result?.config?.preprocess?.style?.({ content: 'css' }))
        );

        assert.deepEqual(
            results.map((result) => ({
                marker: result?.config?.marker,
                source: result?.configSource,
                styleRoot: result?.config?.preprocess?.style?.__resolvedConfig?.root,
                cssMarker: result?.config?.preprocess?.style?.__resolvedConfig?.css?.marker
            })),
            projects.map((project) => ({
                marker: path.basename(project),
                source: 'vite',
                styleRoot: project,
                cssMarker: path.basename(project)
            }))
        );
        assert.deepEqual(
            transformed.map((result) => result?.code),
            projects.map(
                (project) =>
                    `css:${project}:${path.join(project, 'tailwind.config.ts')}:${project}:${path.basename(project)}`
            )
        );
        assert.deepEqual(
            globalThis.__svelteLoadConfigCssCalls,
            projects.flatMap((project) => [
                {
                    phase: 'load',
                    command: 'serve',
                    root: project,
                    cwd: project
                },
                {
                    phase: 'resolve',
                    root: project,
                    cwd: project,
                    configFile: false,
                    pluginCount: 0,
                    cssMarker: path.basename(project)
                }
            ])
        );
    } finally {
        delete globalThis.__svelteLoadConfigCssCalls;
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});

test('style transforms recover after a dependency memoizes the first virtual cwd', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-load-config-cwd-clobber-'));
    const vitePackage = path.join(fixture, 'node_modules', 'vite');
    const originalCwd = process.cwd();
    const cwdFunctionBefore = process.cwd;
    const pathResolveBefore = path.resolve;
    const firstProject = path.join(fixture, 'first');
    const laterProject = path.join(fixture, 'later');

    try {
        fs.mkdirSync(vitePackage, { recursive: true });
        for (const project of [firstProject, laterProject]) {
            fs.mkdirSync(project, { recursive: true });
            fs.writeFileSync(
                path.join(project, 'vite.config.mjs'),
                `export default { css: { marker: ${JSON.stringify(path.basename(project))} } };\n`
            );
            fs.writeFileSync(
                path.join(project, 'svelte.config.mjs'),
                [
                    'import path from "node:path";',
                    'const style = async ({ content }) => ({',
                    '    code: `${content}:${process.cwd()}:${path.resolve("tailwind.config.ts")}`',
                    '});',
                    'style.__resolvedConfig = null;',
                    'export default { preprocess: { style } };',
                    ''
                ].join('\n')
            );
        }
        fs.writeFileSync(
            path.join(vitePackage, 'package.json'),
            JSON.stringify({
                name: 'vite',
                version: '0.0.0-test',
                type: 'module',
                exports: {
                    '.': './index.mjs',
                    './package.json': './package.json'
                }
            })
        );
        fs.writeFileSync(
            path.join(vitePackage, 'index.mjs'),
            [
                'import path from "node:path";',
                'import { pathToFileURL } from "node:url";',
                'export async function loadConfigFromFile(configEnv, configFile, configRoot) {',
                '    const config = (await import(`${pathToFileURL(configFile).href}?root=${encodeURIComponent(configRoot)}`)).default;',
                '    return { path: configFile, config, dependencies: [] };',
                '}',
                'export async function resolveConfig(inlineConfig) {',
                '    if (path.basename(inlineConfig.root) === "first") {',
                '        const capturedCwd = process.cwd;',
                '        let memoizedCwd;',
                '        process.cwd = function () {',
                '            memoizedCwd ??= capturedCwd.call(process);',
                '            return memoizedCwd;',
                '        };',
                '        globalThis.__svelteLoadConfigCwdClobber = process.cwd();',
                '    }',
                '    return { ...inlineConfig, plugins: [] };',
                '}',
                ''
            ].join('\n')
        );

        // Bind the later package's style callback before a dependency replaces process.cwd.
        // This makes the transform itself responsible for restoring the stable dispatchers.
        const later = await loadConfig(laterProject, { traverse: false, clearCache: true });
        const first = await loadConfig(firstProject, { traverse: false, clearCache: true });

        assert.equal(globalThis.__svelteLoadConfigCwdClobber, firstProject);
        assert.equal(
            process.cwd(),
            firstProject,
            'the simulated graceful-fs wrapper should pin cwd to the first project'
        );

        const laterTransform = await later?.config?.preprocess?.style?.({ content: 'later' });
        assert.equal(
            laterTransform?.code,
            `later:${laterProject}:${path.join(laterProject, 'tailwind.config.ts')}`
        );
        assert.equal(
            process.cwd(),
            originalCwd,
            'outside the style async context cwd must return to the real process root'
        );

        const firstTransform = await first?.config?.preprocess?.style?.({ content: 'first' });
        assert.equal(
            firstTransform?.code,
            `first:${firstProject}:${path.join(firstProject, 'tailwind.config.ts')}`
        );
        assert.equal(process.cwd(), originalCwd);
    } finally {
        process.cwd = cwdFunctionBefore;
        path.resolve = pathResolveBefore;
        delete globalThis.__svelteLoadConfigCwdClobber;
        process.chdir(originalCwd);
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
