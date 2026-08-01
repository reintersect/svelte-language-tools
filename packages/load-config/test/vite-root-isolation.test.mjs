import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/src/index.js';

test('resolving a Vite config does not expose its root through process.cwd()', async () => {
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
                '            api: { options: { marker: inlineConfig.root } }',
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
