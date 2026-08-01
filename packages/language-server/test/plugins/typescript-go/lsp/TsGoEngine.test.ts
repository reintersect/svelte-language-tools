import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'mocha';
import { resolveTsGoEngine } from '../../../../src/plugins/typescript-go/lsp/TsGoEngine';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function packageFixture(
    name: string,
    binContents: string | number[],
    manifestOverrides: Record<string, unknown> = {}
) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-lsp-tsgo-engine-'));
    tempRoots.push(root);
    const packageRoot = path.join(root, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'dist/api/async'), { recursive: true });
    fs.writeFileSync(
        path.join(packageRoot, 'package.json'),
        JSON.stringify({
            name,
            version: '7.0.0-test.1',
            exports: { '.': './dist/index.js' },
            bin: { tsgo: './bin/tsgo' },
            ...manifestOverrides
        })
    );
    fs.writeFileSync(
        path.join(packageRoot, 'bin/tsgo'),
        typeof binContents === 'string' ? binContents : Uint8Array.from(binContents)
    );
    fs.writeFileSync(path.join(packageRoot, 'dist/api/async/api.js'), 'export const API = {};');
    return { root, packageRoot };
}

describe('typescript-go engine resolution', () => {
    it('resolves an exports-hidden manifest and keeps its API with its Node launcher', () => {
        const name = '@fixture/tsgo';
        const { root, packageRoot } = packageFixture(name, '#!/usr/bin/env node\n');
        const engine = resolveTsGoEngine(root, { packageName: name });

        assert.ok(engine);
        assert.strictEqual(engine.packageName, name);
        assert.strictEqual(engine.version, '7.0.0-test.1');
        assert.strictEqual(engine.packageRoot, packageRoot);
        assert.strictEqual(engine.command, process.execPath);
        assert.deepStrictEqual(engine.argsPrefix, [path.join(packageRoot, 'bin/tsgo')]);
        assert.strictEqual(engine.apiEntry, path.join(packageRoot, 'dist/api/async/api.js'));
    });

    it('launches a native executable directly', () => {
        const name = 'native-tsgo-fixture';
        const { root, packageRoot } = packageFixture(name, [0xcf, 0xfa, 0xed, 0xfe]);
        const engine = resolveTsGoEngine(root, { packageName: name });

        assert.ok(engine);
        assert.strictEqual(engine.command, path.join(packageRoot, 'bin/tsgo'));
        assert.deepStrictEqual(engine.argsPrefix, []);
    });

    it('rejects packages without an exact non-empty string version', () => {
        const name = 'invalid-version-tsgo-fixture';
        for (const [label, version] of [
            ['missing', undefined],
            ['blank', '   '],
            ['non-string', 7]
        ] as const) {
            const { root } = packageFixture(name, '#!/usr/bin/env node\n', { version });

            assert.strictEqual(
                resolveTsGoEngine(root, { packageName: name }),
                undefined,
                `${label} version unexpectedly resolved`
            );
        }
    });

    it('rejects a package.json export owned by a different package', () => {
        const requestedName = 'mismatched-name-tsgo-fixture';
        const { root } = packageFixture(requestedName, '#!/usr/bin/env node\n', {
            name: 'different-package',
            exports: { './package.json': './package.json' }
        });

        assert.strictEqual(resolveTsGoEngine(root, { packageName: requestedName }), undefined);
    });
});
