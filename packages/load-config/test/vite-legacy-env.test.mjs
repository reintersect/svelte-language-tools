import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/src/index.js';

function legacyViteFixture(parent, name) {
    const root = path.join(parent, name);
    const vitePackage = path.join(root, 'node_modules', 'vite');
    fs.mkdirSync(vitePackage, { recursive: true });
    fs.writeFileSync(path.join(root, 'vite.config.mjs'), 'export default {};\n');
    fs.writeFileSync(
        path.join(vitePackage, 'package.json'),
        JSON.stringify({
            name: 'vite',
            version: '0.0.0-test',
            type: 'module',
            // Hiding package.json forces the legacy loader while `.` remains resolvable.
            exports: { '.': './index.mjs' }
        })
    );
    fs.writeFileSync(
        path.join(vitePackage, 'index.mjs'),
        [
            `globalThis.__svelteLoadConfigLegacyGate.entered(${JSON.stringify(name)}, process.env.VITE_CJS_IGNORE_WARNING);`,
            `await globalThis.__svelteLoadConfigLegacyGate.releases[${JSON.stringify(name)}];`,
            'export async function resolveConfig(inlineConfig) {',
            '    return {',
            '        plugins: [{',
            '            name: "vite-plugin-svelte:config",',
            `            api: { options: { marker: ${JSON.stringify(name)}, root: inlineConfig.root } }`,
            '        }]',
            '    };',
            '}',
            ''
        ].join('\n')
    );
    return root;
}

test('legacy Vite imports serialize and restore VITE_CJS_IGNORE_WARNING', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-load-config-vite-legacy-'));
    const previous = process.env.VITE_CJS_IGNORE_WARNING;
    const releases = {};
    const release = {};
    const entered = [];
    let notifyEntered;
    let nextEntered = new Promise((resolve) => (notifyEntered = resolve));

    try {
        const first = legacyViteFixture(fixture, 'first');
        const second = legacyViteFixture(fixture, 'second');
        for (const name of ['first', 'second']) {
            releases[name] = new Promise((resolve) => (release[name] = resolve));
        }
        globalThis.__svelteLoadConfigLegacyGate = {
            releases,
            entered(name, warningValue) {
                entered.push({ name, warningValue });
                notifyEntered();
                nextEntered = new Promise((resolve) => (notifyEntered = resolve));
            }
        };
        process.env.VITE_CJS_IGNORE_WARNING = 'original-value';

        const firstLoading = loadConfig(first, { traverse: false, clearCache: true });
        const secondLoading = loadConfig(second, { traverse: false });
        await nextEntered;
        assert.deepStrictEqual(entered, [{ name: 'first', warningValue: 'true' }]);

        // Even after another event-loop turn, the second module must not observe or overwrite
        // the first import's temporary process-wide value.
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(entered.length, 1);

        release.first();
        await nextEntered;
        assert.deepStrictEqual(entered, [
            { name: 'first', warningValue: 'true' },
            { name: 'second', warningValue: 'true' }
        ]);
        release.second();

        const [firstResult, secondResult] = await Promise.all([firstLoading, secondLoading]);
        assert.equal(firstResult?.config?.marker, 'first');
        assert.equal(secondResult?.config?.marker, 'second');
        assert.equal(process.env.VITE_CJS_IGNORE_WARNING, 'original-value');
    } finally {
        release.first?.();
        release.second?.();
        delete globalThis.__svelteLoadConfigLegacyGate;
        if (previous === undefined) {
            delete process.env.VITE_CJS_IGNORE_WARNING;
        } else {
            process.env.VITE_CJS_IGNORE_WARNING = previous;
        }
        fs.rmSync(fixture, { recursive: true, force: true });
    }
});
