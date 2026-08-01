import assert from 'assert';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'mocha';
import {
    DIRECT_DIRECTORY_MEMBERSHIP,
    DirectoryMembershipProof,
    MaterialisationPlanCache,
    MaterialisationPlanIdentity,
    RECURSIVE_DIRECTORY_MEMBERSHIP
} from '../../../../src/plugins/typescript-go/lsp/MaterialisationPlanCache';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-materialisation-plan-'));
    tempRoots.push(root);
    const cachePath = path.join(root, '.cache', 'plan.json');
    const source = path.join(root, 'src', 'App.svelte');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "import Button from './Button.svelte';\n<p>{1}</p>\n");
    return { root, cachePath, source };
}

function identity(
    overrides: Partial<MaterialisationPlanIdentity> = {}
): MaterialisationPlanIdentity {
    const base: MaterialisationPlanIdentity = {
        engine: {
            packageName: '@typescript/native-preview',
            version: '7.0.0-dev.test',
            command: '/native/tsgo',
            argsPrefix: ['--lsp'],
            apiEntry: '/native/api.js'
        },
        algorithm: 'graph-v7',
        project: '/workspace/tsconfig.json\0compiler-options-hash'
    };
    return {
        ...base,
        ...overrides,
        engine: overrides.engine ?? base.engine
    };
}

function sourceSignature(filePath: string): string {
    return (
        fs
            .readFileSync(filePath, 'utf8')
            .split('\n')
            .filter((line) => /^\s*(?:import|export)\b/.test(line))
            .join('\n') || '<no-imports>'
    );
}

function checksum(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body)).digest('base64url');
}

function readEnvelope(cachePath: string): any {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
}

function writeEnvelope(cachePath: string, envelope: any): void {
    fs.writeFileSync(cachePath, JSON.stringify(envelope));
}

describe('typescript-go materialisation plan cache', () => {
    it('uses exact stat identity before falling back to a source semantic signature', () => {
        const { cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache<{ roots: string[] }>(cachePath, identity());
        const signature = sourceSignature(source);

        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { roots: [source] },
                files: [{ kind: 'source', path: source, signature }],
                sourceSignature
            }),
            { ok: true, written: true }
        );
        assert.deepStrictEqual(
            cache.lookup({
                sourceSignature: () => {
                    throw new Error('the stat fast path must not read source text');
                }
            }),
            { hit: true, payload: { roots: [source] } }
        );
        assert.strictEqual(cache.counters.statFastPathInputs, 1);
        assert.strictEqual(cache.counters.sourceSignatureFallbacks, 0);

        fs.writeFileSync(source, "import Button from './Button.svelte';\n<p>{2}</p>\n");
        assert.deepStrictEqual(cache.lookup({ sourceSignature }), {
            hit: true,
            payload: { roots: [source] }
        });
        assert.strictEqual(cache.counters.sourceSignatureFallbacks, 1);

        fs.writeFileSync(source, "import Card from './Card.svelte';\n<p>{2}</p>\n");
        const changed = cache.lookup({ sourceSignature });
        assert.strictEqual(changed.hit, false);
        assert.strictEqual(changed.hit ? undefined : changed.reason, 'source-signature-mismatch');
    });

    it('fails closed when changed source metadata has no usable signature provider', () => {
        const { cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: {},
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                sourceSignature
            }),
            { ok: true, written: true }
        );
        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(source, future, future);

        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'source-signature-unavailable'
        );
        assert.strictEqual(
            (
                cache.lookup({
                    sourceSignature: () => {
                        throw new Error('bad parser');
                    }
                }) as { hit: false; reason: string }
            ).reason,
            'source-signature-error'
        );
    });

    it('rejects publication when source graph facts changed after discovery', () => {
        const { cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const discoveredSignature = sourceSignature(source);
        fs.writeFileSync(source, "import Card from './Card.svelte';\n<p>{1}</p>\n");

        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { roots: ['Button.svelte'] },
                files: [{ kind: 'source', path: source, signature: discoveredSignature }],
                sourceSignature
            }),
            { ok: false, reason: 'source-signature-mismatch', detail: source }
        );
        assert.strictEqual(fs.existsSync(cachePath), false);
        assert.deepStrictEqual(cache.counters.writeFailureReasons, {
            'source-signature-mismatch': 1
        });
    });

    for (const kind of ['config', 'manifest', 'lockfile', 'layout'] as const) {
        it(`validates ${kind} inputs by exact content after the stat fast path changes`, () => {
            const { root, cachePath } = fixture();
            const exact = path.join(root, `${kind}.json`);
            fs.writeFileSync(exact, '{"value":1}\n');
            const cache = new MaterialisationPlanCache(cachePath, identity());
            assert.strictEqual(
                cache.write({
                    complete: true,
                    payload: { kind },
                    files: [{ kind, path: exact }]
                }).ok,
                true
            );

            const future = new Date(Date.now() + 10_000);
            fs.utimesSync(exact, future, future);
            assert.strictEqual(cache.lookup().hit, true, 'a metadata-only touch is reusable');
            assert.strictEqual(cache.counters.exactContentFallbacks, 1);

            fs.writeFileSync(exact, '{"value":2}\n');
            assert.strictEqual(
                (cache.lookup() as { hit: false; reason: string }).reason,
                'exact-content-mismatch'
            );
        });
    }

    it('records absent optional inputs and invalidates when they are created', () => {
        const { root, cachePath } = fixture();
        const config = path.join(root, 'svelte.config.js');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: ['no-config'],
                files: [{ kind: 'config', path: config, allowMissing: true }]
            }).ok,
            true
        );
        assert.strictEqual(cache.lookup().hit, true);
        fs.writeFileSync(config, 'export default {};\n');
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'input-presence-changed'
        );
    });

    it('detects recursive directory create, delete and rename membership changes', () => {
        const { root, cachePath } = fixture();
        const watched = path.join(root, 'packages');
        const nested = path.join(watched, 'ui', 'src');
        fs.mkdirSync(nested, { recursive: true });
        const component = path.join(nested, 'Button.svelte');
        fs.writeFileSync(component, '<button />');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: { packages: ['ui'] },
                files: [],
                directories: [
                    cache.snapshotDirectory({
                        path: watched,
                        validator: RECURSIVE_DIRECTORY_MEMBERSHIP
                    })
                ]
            }).ok,
            true
        );
        assert.strictEqual(cache.lookup().hit, true);

        const renamed = path.join(nested, 'Action.svelte');
        fs.renameSync(component, renamed);
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'directory-membership-mismatch'
        );
        fs.renameSync(renamed, component);
        assert.strictEqual(cache.lookup().hit, true);

        const created = path.join(nested, 'New.svelte');
        fs.writeFileSync(created, '<p />');
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'directory-membership-mismatch'
        );
        fs.rmSync(created);
        assert.strictEqual(cache.lookup().hit, true);

        fs.rmSync(component);
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'directory-membership-mismatch'
        );
    });

    it('rejects publication when directory membership changed after discovery', () => {
        const { root, cachePath } = fixture();
        const watched = path.join(root, 'packages');
        fs.mkdirSync(watched);
        fs.writeFileSync(path.join(watched, 'existing.svelte'), '<p />');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const directory = cache.snapshotDirectory({
            path: watched,
            validator: RECURSIVE_DIRECTORY_MEMBERSHIP
        });
        fs.writeFileSync(path.join(watched, 'created.svelte'), '<p />');

        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { files: ['existing.svelte'] },
                files: [],
                directories: [directory]
            }),
            { ok: false, reason: 'directory-membership-mismatch', detail: watched }
        );
        assert.strictEqual(fs.existsSync(cachePath), false);
        assert.deepStrictEqual(cache.counters.writeFailureReasons, {
            'directory-membership-mismatch': 1
        });
    });

    it('tracks membership beneath pnpm-style directory symlinks without following cycles', () => {
        const { root, cachePath } = fixture();
        const storePackage = path.join(root, '.pnpm', 'ui');
        const nodeModules = path.join(root, 'node_modules');
        fs.mkdirSync(storePackage, { recursive: true });
        fs.mkdirSync(nodeModules);
        fs.writeFileSync(path.join(storePackage, 'Button.svelte'), '<button />');
        fs.symlinkSync(path.relative(nodeModules, storePackage), path.join(nodeModules, 'ui'));
        // A target cycle is represented in the stamp instead of being traversed forever.
        fs.symlinkSync('.', path.join(storePackage, 'self'));

        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: { dependency: 'ui' },
                files: [{ kind: 'layout', path: path.join(nodeModules, 'ui') }],
                directories: [
                    cache.snapshotDirectory({
                        path: nodeModules,
                        validator: RECURSIVE_DIRECTORY_MEMBERSHIP
                    })
                ]
            }).ok,
            true
        );
        assert.strictEqual(cache.lookup().hit, true);
        fs.writeFileSync(path.join(storePackage, 'Card.svelte'), '<article />');
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'directory-membership-mismatch'
        );
    });

    it('supports direct and caller-owned versioned directory membership validators', () => {
        const { root, cachePath } = fixture();
        const watched = path.join(root, 'workspace');
        fs.mkdirSync(watched);
        fs.writeFileSync(path.join(watched, 'package.json'), '{}');

        const direct = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            direct.write({
                complete: true,
                payload: 'direct',
                files: [],
                directories: [
                    direct.snapshotDirectory({
                        path: watched,
                        validator: DIRECT_DIRECTORY_MEMBERSHIP
                    })
                ]
            }).ok,
            true
        );
        assert.strictEqual(direct.lookup().hit, true);

        const customPath = path.join(root, '.cache', 'custom.json');
        const custom = new MaterialisationPlanCache(customPath, identity());
        let proof: DirectoryMembershipProof = { stamp: 'package-set-v1:a', entryCount: 1 };
        const provider = () => proof;
        assert.strictEqual(
            custom.write({
                complete: true,
                payload: 'custom',
                files: [],
                directories: [
                    custom.snapshotDirectory(
                        { path: watched, validator: 'fixture:packages:v1' },
                        provider
                    )
                ],
                directoryMembership: provider
            }).ok,
            true
        );
        assert.strictEqual(
            (custom.lookup() as { hit: false; reason: string }).reason,
            'directory-validator-unavailable'
        );
        assert.strictEqual(custom.lookup({ directoryMembership: provider }).hit, true);
        proof = { stamp: 'package-set-v1:b', entryCount: 1 };
        assert.strictEqual(
            (
                custom.lookup({ directoryMembership: provider }) as {
                    hit: false;
                    reason: string;
                }
            ).reason,
            'directory-membership-mismatch'
        );
    });

    it('matches engine, algorithm and project identity exactly', () => {
        const { cachePath, source } = fixture();
        const original = identity();
        const cache = new MaterialisationPlanCache(cachePath, original);
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: { graph: true },
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                sourceSignature
            }).ok,
            true
        );

        const otherEngine = new MaterialisationPlanCache(
            cachePath,
            identity({ engine: { ...original.engine, version: 'different' } })
        );
        assert.strictEqual(
            (otherEngine.lookup() as { hit: false; reason: string }).reason,
            'engine-mismatch'
        );
        assert.strictEqual(
            (
                new MaterialisationPlanCache(
                    cachePath,
                    identity({ algorithm: 'graph-v8' })
                ).lookup() as { hit: false; reason: string }
            ).reason,
            'algorithm-mismatch'
        );
        assert.strictEqual(
            (
                new MaterialisationPlanCache(
                    cachePath,
                    identity({ project: 'other-project' })
                ).lookup() as { hit: false; reason: string }
            ).reason,
            'project-mismatch'
        );
    });

    it('rejects malformed, corrupted, partial and explicitly incomplete plans', () => {
        const { cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const persist = () =>
            cache.write({
                complete: true,
                payload: { graph: ['App.svelte'] },
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                sourceSignature
            });
        assert.strictEqual(persist().ok, true);

        fs.writeFileSync(cachePath, '{"schemaVersion":');
        assert.strictEqual((cache.lookup() as { hit: false; reason: string }).reason, 'malformed');

        assert.strictEqual(persist().ok, true);
        let envelope = readEnvelope(cachePath);
        envelope.schemaVersion++;
        writeEnvelope(cachePath, envelope);
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'schema-version-mismatch'
        );

        assert.strictEqual(persist().ok, true);
        envelope = readEnvelope(cachePath);
        envelope.body.payload.graph.push('Injected.svelte');
        writeEnvelope(cachePath, envelope);
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'checksum-mismatch'
        );

        assert.strictEqual(persist().ok, true);
        envelope = readEnvelope(cachePath);
        envelope.body.complete = false;
        envelope.checksum = checksum(envelope.body);
        writeEnvelope(cachePath, envelope);
        assert.strictEqual((cache.lookup() as { hit: false; reason: string }).reason, 'incomplete');

        assert.strictEqual(persist().ok, true);
        envelope = readEnvelope(cachePath);
        delete envelope.body.files;
        envelope.checksum = checksum(envelope.body);
        writeEnvelope(cachePath, envelope);
        assert.strictEqual((cache.lookup() as { hit: false; reason: string }).reason, 'malformed');
    });

    it('writes with a unique atomic temp file and skips a byte-identical rewrite', () => {
        const { root, cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const request = {
            complete: true as const,
            payload: { roots: [source] },
            files: [{ kind: 'source' as const, path: source, signature: sourceSignature(source) }],
            sourceSignature
        };
        assert.deepStrictEqual(cache.write(request), { ok: true, written: true });
        const first = fs.statSync(cachePath, { bigint: true }).mtimeNs;
        assert.deepStrictEqual(cache.write(request), { ok: true, written: false });
        assert.strictEqual(fs.statSync(cachePath, { bigint: true }).mtimeNs, first);
        assert.deepStrictEqual(
            fs.readdirSync(path.dirname(cachePath)).filter((name) => name.includes('.tmp-')),
            []
        );
        assert.strictEqual(cache.counters.writes, 1);
        assert.strictEqual(cache.counters.writeSkips, 1);
        assert.ok(root);
    });

    it('refuses ambiguous input sets, incomplete graphs, invalid JSON and missing inputs', () => {
        const { root, cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            (
                cache.write({
                    complete: true,
                    payload: {},
                    files: [
                        { kind: 'source', path: source, signature: sourceSignature(source) },
                        { kind: 'config', path: source }
                    ]
                }) as { ok: false; reason: string }
            ).reason,
            'invalid-input-set'
        );
        assert.strictEqual(
            (
                cache.write({
                    complete: false,
                    payload: {},
                    files: []
                } as any) as { ok: false; reason: string }
            ).reason,
            'incomplete'
        );
        const circular: any = {};
        circular.self = circular;
        assert.strictEqual(
            (
                cache.write({ complete: true, payload: circular, files: [] }) as {
                    ok: false;
                    reason: string;
                }
            ).reason,
            'invalid-payload'
        );
        assert.strictEqual(
            (
                cache.write({
                    complete: true,
                    payload: {},
                    files: [{ kind: 'manifest', path: path.join(root, 'missing.json') }]
                }) as { ok: false; reason: string }
            ).reason,
            'input-unavailable'
        );
    });

    it('reports cache hit/miss reasons and validation counters without exposing mutable state', () => {
        const { cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual((cache.lookup() as { hit: false; reason: string }).reason, 'not-found');
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: null,
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                sourceSignature
            }).ok,
            true
        );
        assert.strictEqual(cache.lookup().hit, true);
        const snapshot = cache.counters;
        snapshot.missReasons['not-found'] = 99;
        assert.strictEqual(cache.counters.missReasons['not-found'], 1);
        assert.strictEqual(cache.counters.lookups, 2);
        assert.strictEqual(cache.counters.hits, 1);
        assert.strictEqual(cache.counters.misses, 1);
    });
});
