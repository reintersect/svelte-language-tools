import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../dist/src/index.js';

test('clearCache reloads ESM and CommonJS Svelte config modules', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-svelte-config-'));

    try {
        for (const fixture of [
            { name: 'mjs', extension: 'mjs', esm: true },
            { name: 'cjs', extension: 'cjs', esm: false },
            { name: 'module-js', extension: 'js', esm: true, packageType: 'module' },
            { name: 'commonjs-js', extension: 'js', esm: false, packageType: 'commonjs' }
        ]) {
            const fixtureDirectory = path.join(directory, fixture.name);
            fs.mkdirSync(fixtureDirectory);
            if (fixture.packageType) {
                fs.writeFileSync(
                    path.join(fixtureDirectory, 'package.json'),
                    `${JSON.stringify({ type: fixture.packageType })}\n`
                );
            }
            const configPath = path.join(fixtureDirectory, `svelte.config.${fixture.extension}`);
            const source = (revision) =>
                fixture.esm
                    ? `export default { revision: ${revision} };\n`
                    : `module.exports = { revision: ${revision} };\n`;

            fs.writeFileSync(configPath, source(1));
            const first = await loadConfig(configPath, { clearCache: true });
            assert.equal(first?.config.revision, 1);

            fs.writeFileSync(configPath, source(2));
            const cached = await loadConfig(configPath);
            assert.equal(cached?.config.revision, 1, 'normal loads should retain the cache');

            const reloaded = await loadConfig(configPath, { clearCache: true });
            assert.equal(reloaded?.config.revision, 2);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('clearCache reports a newly malformed config instead of returning the old module', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'load-svelte-config-error-'));
    const configPath = path.join(directory, 'svelte.config.mjs');

    try {
        fs.writeFileSync(configPath, 'export default { revision: 1 };\n');
        const first = await loadConfig(configPath, { clearCache: true });
        assert.equal(first?.config.revision, 1);

        fs.writeFileSync(configPath, 'export default {\n');
        const reloaded = await loadConfig(configPath, { clearCache: true });
        assert.ok(reloaded && 'error' in reloaded);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
