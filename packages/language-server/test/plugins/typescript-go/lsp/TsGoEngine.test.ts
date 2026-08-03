import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'mocha';
import { resolveTsGoEngine } from '../../../../src/plugins/typescript-go/lsp/TsGoEngine';

const tempRoots: string[] = [];
const originalEffectChannel = process.env.ETSGO_CHANNEL;

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    if (originalEffectChannel === undefined) {
        delete process.env.ETSGO_CHANNEL;
    } else {
        process.env.ETSGO_CHANNEL = originalEffectChannel;
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

function effectPackageFixture(
    options: {
        channel?: 'tsc' | 'tsc-next';
        tsVersion?: string;
        tsGitHead?: string;
        clientVersion?: string;
        clientGitHead?: string;
        packageVersion?: string;
        platformVersion?: string;
        includeClient?: boolean;
        executable?: boolean;
    } = {}
) {
    const packageVersion = options.packageVersion ?? '0.27.3';
    const channel = options.channel ?? 'tsc';
    const tsVersion = options.tsVersion ?? '7.0.2';
    const tsGitHead = options.tsGitHead ?? '2bd066d87f5bafd315be9f40889d0a60b9e58e0b';
    const { root, packageRoot } = packageFixture(
        '@reintersect/effect-tsgo',
        '#!/usr/bin/env node\n',
        { version: packageVersion }
    );
    const platformName = `@reintersect/effect-tsgo-${process.platform}-${process.arch}`;
    const platformRoot = path.join(root, 'node_modules', ...platformName.split('/'));
    fs.mkdirSync(path.join(platformRoot, 'lib'), { recursive: true });
    fs.writeFileSync(
        path.join(platformRoot, 'package.json'),
        JSON.stringify({
            name: platformName,
            version: options.platformVersion ?? packageVersion
        })
    );
    const executable = channel + (process.platform === 'win32' ? '.exe' : '');
    const nativePath = path.join(platformRoot, 'lib', executable);
    fs.writeFileSync(nativePath, Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe]));
    if (process.platform !== 'win32' && options.executable !== false) {
        fs.chmodSync(nativePath, 0o755);
    }
    fs.writeFileSync(`${nativePath}.json`, JSON.stringify({ tsVersion, tsGitHead }));
    if (options.includeClient !== false) {
        const clientRoot = path.join(packageRoot, 'dist', 'api-clients', channel);
        fs.mkdirSync(path.join(clientRoot, 'dist/api/async'), { recursive: true });
        fs.writeFileSync(
            path.join(clientRoot, 'package.json'),
            JSON.stringify({
                name: 'typescript',
                version: options.clientVersion ?? tsVersion,
                gitHead: options.clientGitHead ?? tsGitHead
            })
        );
        fs.writeFileSync(path.join(clientRoot, 'dist/api/async/api.js'), 'export const API = {};');
    }
    return {
        root,
        packageRoot,
        nativePath: fs.realpathSync(nativePath),
        channel,
        tsVersion,
        tsGitHead
    };
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

    it('resolves the known @typescript/native npm alias without weakening package ownership', () => {
        const requestedName = '@typescript/native';
        const { root, packageRoot } = packageFixture(requestedName, '#!/usr/bin/env node\n', {
            name: 'typescript',
            version: '7.0.2',
            bin: { tsc: './bin/tsgo' }
        });
        const engine = resolveTsGoEngine(root, { packageName: requestedName });

        assert.ok(engine);
        assert.strictEqual(engine.packageName, requestedName);
        assert.strictEqual(engine.version, '7.0.2');
        assert.strictEqual(engine.packageRoot, packageRoot);
        assert.strictEqual(engine.binPath, path.join(packageRoot, 'bin/tsgo'));
        assert.strictEqual(engine.apiEntry, path.join(packageRoot, 'dist/api/async/api.js'));

        const unrelatedName = '@fixture/native-alias';
        const unrelated = packageFixture(unrelatedName, '#!/usr/bin/env node\n', {
            name: 'typescript'
        });
        assert.strictEqual(
            resolveTsGoEngine(unrelated.root, { packageName: unrelatedName }),
            undefined
        );
    });

    it("launches Effect's selected platform binary and matching packaged API directly", () => {
        delete process.env.ETSGO_CHANNEL;
        const fixture = effectPackageFixture();
        const engine = resolveTsGoEngine(fixture.root, {
            packageName: '@reintersect/effect-tsgo'
        });

        assert.ok(engine);
        assert.strictEqual(engine.binPath, fixture.nativePath);
        assert.strictEqual(engine.command, fixture.nativePath);
        assert.deepStrictEqual(engine.argsPrefix, []);
        assert.strictEqual(engine.channel, 'tsc');
        assert.strictEqual(engine.compilerVersion, fixture.tsVersion);
        assert.strictEqual(engine.compilerGitHead, fixture.tsGitHead);
        assert.strictEqual(
            engine.apiEntry,
            path.join(fixture.packageRoot, 'dist/api-clients/tsc/dist/api/async/api.js')
        );
    });

    it('freezes Effect next-channel selection and its exact API identity', () => {
        process.env.ETSGO_CHANNEL = 'next';
        const fixture = effectPackageFixture({
            channel: 'tsc-next',
            tsVersion: '7.1.0-dev.20260730.1',
            tsGitHead: '37357ae666e7af11989d4ba416a763f2da590dee'
        });
        const engine = resolveTsGoEngine(fixture.root, {
            packageName: '@reintersect/effect-tsgo'
        });

        assert.ok(engine);
        assert.strictEqual(engine.channel, 'tsc-next');
        assert.strictEqual(engine.binPath, fixture.nativePath);
        assert.ok(engine.apiEntry?.includes('api-clients/tsc-next'));
    });

    it('uses the tested bundled client for an exact older Effect binary', () => {
        delete process.env.ETSGO_CHANNEL;
        const fixture = effectPackageFixture({ includeClient: false });
        const engine = resolveTsGoEngine(fixture.root, {
            packageName: '@reintersect/effect-tsgo'
        });

        assert.ok(engine);
        assert.ok(engine.apiEntry?.endsWith('/vendor/tsgo-api/7.0.2/api.mjs'));
    });

    it('does not reuse a bundled client for an untested Effect protocol version', () => {
        delete process.env.ETSGO_CHANNEL;
        const fixture = effectPackageFixture({ packageVersion: '0.27.4', includeClient: false });
        const engine = resolveTsGoEngine(fixture.root, {
            packageName: '@reintersect/effect-tsgo'
        });

        assert.ok(engine);
        assert.strictEqual(engine.apiEntry, undefined);
    });

    it('keeps Effect usable but disables the API for a mismatched client', () => {
        delete process.env.ETSGO_CHANNEL;
        const fixture = effectPackageFixture({
            tsVersion: '7.0.9-test.1',
            tsGitHead: '1111111111111111111111111111111111111111',
            clientGitHead: '2222222222222222222222222222222222222222'
        });
        const engine = resolveTsGoEngine(fixture.root, {
            packageName: '@reintersect/effect-tsgo'
        });

        assert.ok(engine);
        assert.strictEqual(engine.apiEntry, undefined);
    });

    it('rejects a mismatched Effect platform-package version', () => {
        const fixture = effectPackageFixture({ platformVersion: '0.27.2' });
        assert.strictEqual(
            resolveTsGoEngine(fixture.root, { packageName: '@reintersect/effect-tsgo' }),
            undefined
        );
    });

    it('recovers a lost Effect native executable bit before direct launch', () => {
        if (process.platform === 'win32') {
            return;
        }
        const fixture = effectPackageFixture({ executable: false });
        const engine = resolveTsGoEngine(fixture.root, {
            packageName: '@reintersect/effect-tsgo'
        });

        assert.ok(engine);
        fs.accessSync(fixture.nativePath, fs.constants.X_OK);
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
