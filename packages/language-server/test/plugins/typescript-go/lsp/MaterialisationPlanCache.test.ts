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
    RECURSIVE_DIRECTORY_MEMBERSHIP,
    materialisationPlanEngineCacheKey,
    materialisationPlanExactFileProof,
    materialisationPlanLayoutTopologyProof,
    readValidMaterialisationPlanIdentity
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
            version: '7.0.0-dev.test'
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

    it('fails closed after the interactive content-fallback budget is exhausted', () => {
        const { root, cachePath, source } = fixture();
        const second = path.join(root, 'src', 'Second.svelte');
        fs.writeFileSync(second, "import Card from './Card.svelte';\n<p>{1}</p>\n");
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const files = [source, second].map((filePath) => ({
            kind: 'source' as const,
            path: filePath,
            signature: sourceSignature(filePath)
        }));
        assert.strictEqual(
            cache.write({ complete: true, payload: {}, files, sourceSignature }).ok,
            true
        );

        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(source, future, future);
        fs.utimesSync(second, future, future);
        let signatureCalls = 0;
        const result = cache.lookup({
            sourceSignature: (filePath) => {
                signatureCalls++;
                return sourceSignature(filePath);
            },
            validationBudget: { maxContentFallbacks: 1 }
        });

        assert.strictEqual(result.hit, false);
        assert.strictEqual(result.hit ? undefined : result.reason, 'validation-budget-exceeded');
        assert.strictEqual(signatureCalls, 1);
        assert.strictEqual(cache.counters.sourceSignatureFallbacks, 1);
    });

    it('includes slow validation providers in the interactive duration budget', () => {
        const { root, cachePath } = fixture();
        const watched = path.join(root, 'workspace');
        fs.mkdirSync(watched);
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const proof = { stamp: 'stable', entryCount: 1 };
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: {},
                files: [],
                directories: [
                    cache.snapshotDirectory(
                        { path: watched, validator: 'fixture:slow:v1' },
                        () => proof
                    )
                ],
                directoryMembership: () => proof
            }).ok,
            true
        );

        const result = cache.lookup({
            directoryMembership: () => {
                const until = performance.now() + 5;
                while (performance.now() < until) {
                    // Deliberately hold this synchronous provider past the outer budget.
                }
                return proof;
            },
            validationBudget: { maxDurationMs: 1 }
        });
        assert.strictEqual(result.hit, false);
        assert.strictEqual(result.hit ? undefined : result.reason, 'validation-budget-exceeded');
    });

    it('revalidates a successful lookup from stored stat identities', () => {
        const { cachePath, source } = fixture();
        const cache = new MaterialisationPlanCache<{ roots: string[] }>(cachePath, identity());
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: { roots: [source] },
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                sourceSignature
            }).ok,
            true
        );
        assert.strictEqual(cache.lookup({ sourceSignature }).hit, true);
        assert.strictEqual(
            cache.revalidate({
                sourceSignature: () => {
                    throw new Error('unchanged input must retain the stat fast path');
                }
            }).hit,
            true
        );

        fs.writeFileSync(source, "import Button from './Button.svelte';\n<p>{2}</p>\n");
        assert.strictEqual(cache.revalidate({ sourceSignature }).hit, true);
        fs.writeFileSync(source, "import Card from './Card.svelte';\n<p>{2}</p>\n");
        assert.strictEqual(
            (cache.revalidate({ sourceSignature }) as { hit: false; reason: string }).reason,
            'source-signature-mismatch'
        );
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

    it('rejects publication when an exact input changed after discovery', () => {
        const { cachePath, root } = fixture();
        const config = path.join(root, 'tsconfig.json');
        fs.writeFileSync(config, '{"compilerOptions":{"strict":true}}');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const discoveryProof = materialisationPlanExactFileProof(config, 'config');

        fs.writeFileSync(config, '{"compilerOptions":{"strict":false}}');
        const result = cache.write({
            complete: true,
            payload: { roots: [] },
            files: [{ kind: 'config', path: config, discoveryProof }]
        });

        assert.deepStrictEqual(result, {
            ok: false,
            reason: 'source-changed-during-write',
            detail: config
        });
    });

    it('rejects publication when an absent exact input appeared after discovery', () => {
        const { cachePath, root } = fixture();
        const manifest = path.join(root, 'node_modules/optional/package.json');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const discoveryProof = materialisationPlanExactFileProof(manifest, 'manifest');
        assert.strictEqual(discoveryProof, null);

        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        fs.writeFileSync(manifest, '{"name":"optional"}');
        const result = cache.write({
            complete: true,
            payload: { roots: [] },
            files: [
                {
                    kind: 'manifest',
                    path: manifest,
                    allowMissing: true,
                    discoveryProof
                }
            ]
        });

        assert.deepStrictEqual(result, {
            ok: false,
            reason: 'source-changed-during-write',
            detail: manifest
        });
    });

    it('checks a validation-only absence at publication without storing the exact input', () => {
        const { cachePath, root } = fixture();
        const watched = path.join(root, 'src');
        const missing = path.join(watched, 'Generated.svelte');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        const directory = cache.snapshotDirectory({
            path: watched,
            validator: RECURSIVE_DIRECTORY_MEMBERSHIP
        });

        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { files: [] },
                files: [],
                validationOnlyFiles: [
                    {
                        kind: 'layout',
                        path: missing,
                        allowMissing: true,
                        discoveryProof: null
                    }
                ],
                directories: [directory]
            }),
            { ok: true, written: true }
        );
        assert.ok(
            !readEnvelope(cachePath).body.files.some(
                (input: { path: string }) => input.path === missing
            ),
            'publication-only evidence must not become a warm-lookup stat input'
        );
        assert.strictEqual(cache.lookup().hit, true);

        fs.writeFileSync(missing, '<p />');
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'directory-membership-mismatch'
        );
    });

    it('rejects a folded absence which appeared before its directory proof was captured', () => {
        const { cachePath, root } = fixture();
        const watched = path.join(root, 'src');
        const missing = path.join(watched, 'Generated.svelte');
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(materialisationPlanExactFileProof(missing, 'layout'), null);

        // Simulate discovery observing absence at A, followed by membership observing the newly
        // created file at B. Directory validation alone would accept B and persist an A payload.
        fs.writeFileSync(missing, '<p />');
        const directory = cache.snapshotDirectory({
            path: watched,
            validator: RECURSIVE_DIRECTORY_MEMBERSHIP
        });
        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { files: [] },
                files: [],
                validationOnlyFiles: [
                    {
                        kind: 'layout',
                        path: missing,
                        allowMissing: true,
                        discoveryProof: null
                    }
                ],
                directories: [directory]
            }),
            { ok: false, reason: 'source-changed-during-write', detail: missing }
        );
        assert.strictEqual(fs.existsSync(cachePath), false);
    });

    it('validates topology-only publication evidence owned by a persisted source', () => {
        const { cachePath, source } = fixture();
        const alias = path.join(path.dirname(source), 'Alias.svelte');
        fs.symlinkSync(path.basename(source), alias);
        const discoveryProof = materialisationPlanExactFileProof(alias, 'layout');
        assert.strictEqual(typeof discoveryProof, 'string');

        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { source },
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                validationOnlyFiles: [
                    {
                        kind: 'layout',
                        path: alias,
                        topologyOnly: true,
                        discoveryProof
                    }
                ],
                directories: [
                    cache.snapshotDirectory({
                        path: path.dirname(source),
                        validator: RECURSIVE_DIRECTORY_MEMBERSHIP
                    })
                ],
                sourceSignature
            }),
            { ok: true, written: true }
        );
        const storedFiles = readEnvelope(cachePath).body.files as Array<{
            kind: string;
            path: string;
        }>;
        assert.deepStrictEqual(
            storedFiles.map(({ kind, path: filePath }) => ({ kind, path: filePath })),
            [{ kind: 'source', path: source }],
            'the alias guards publication without becoming a warm-lookup file input'
        );
        assert.strictEqual(cache.lookup().hit, true);
    });

    it('rejects topology-only publication evidence without a matching persisted source', () => {
        const { cachePath, root, source } = fixture();
        const alias = path.join(path.dirname(source), 'Alias.svelte');
        fs.symlinkSync(path.basename(source), alias);
        const unrelatedSource = path.join(root, 'src', 'Other.svelte');
        fs.writeFileSync(unrelatedSource, '<p>other</p>');
        const discoveryProof = materialisationPlanExactFileProof(alias, 'layout');
        assert.strictEqual(typeof discoveryProof, 'string');

        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: {},
                files: [
                    {
                        kind: 'source',
                        path: unrelatedSource,
                        signature: sourceSignature(unrelatedSource)
                    }
                ],
                validationOnlyFiles: [
                    {
                        kind: 'layout',
                        path: alias,
                        topologyOnly: true,
                        discoveryProof
                    }
                ],
                sourceSignature
            }),
            { ok: false, reason: 'invalid-input-set' }
        );
        assert.strictEqual(fs.existsSync(cachePath), false);
    });

    it('retains an exact alias anchor for validation-only descendants', () => {
        const { cachePath, root } = fixture();
        const stores = [path.join(root, 'store-a'), path.join(root, 'store-b')];
        for (const store of stores) {
            fs.mkdirSync(store);
        }
        const current = path.join(root, 'current');
        const alias = path.join(root, 'alias');
        fs.symlinkSync(stores[0], current, 'junction');
        fs.symlinkSync('current', alias, 'junction');
        const missing = path.join(alias, 'Generated.svelte');
        const aliasProof = materialisationPlanExactFileProof(alias, 'layout');
        assert.strictEqual(typeof aliasProof, 'string');

        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: { files: [] },
                files: [
                    {
                        kind: 'layout',
                        path: alias,
                        allowMissing: true,
                        discoveryProof: aliasProof
                    }
                ],
                validationOnlyFiles: [
                    {
                        kind: 'layout',
                        path: missing,
                        allowMissing: true,
                        discoveryProof: null
                    }
                ],
                directories: [
                    cache.snapshotDirectory({
                        path: stores[0],
                        validator: RECURSIVE_DIRECTORY_MEMBERSHIP
                    })
                ]
            }).ok,
            true
        );
        assert.strictEqual(cache.lookup().hit, true);

        // The alias's raw target remains "current" and the proved store tree is unchanged. Only
        // its retained layout-v2 realpath topology observes this intermediate retarget.
        fs.unlinkSync(current);
        fs.symlinkSync(stores[1], current, 'junction');
        assert.strictEqual(
            (cache.lookup() as { hit: false; reason: string }).reason,
            'input-kind-changed'
        );
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

    it('binds file layout proofs to lexical topology, safe realpath and bytes', () => {
        const { root } = fixture();
        const stores = [path.join(root, 'store-a'), path.join(root, 'store-b')];
        for (const store of stores) {
            fs.mkdirSync(store);
            fs.writeFileSync(path.join(store, 'entry.ts'), 'export const value = 1;\n');
        }
        const direct = path.join(stores[0], 'entry.ts');
        const current = path.join(root, 'current');
        const lexical = path.join(root, 'entry.ts');
        fs.symlinkSync(stores[0], current);
        fs.symlinkSync(path.join('current', 'entry.ts'), lexical);

        const directProof = materialisationPlanExactFileProof(direct, 'layout');
        const linkedProof = materialisationPlanExactFileProof(lexical, 'layout');
        assert.notStrictEqual(
            linkedProof,
            directProof,
            'a lexical symlink must not collapse to its byte-identical target'
        );

        fs.unlinkSync(current);
        fs.symlinkSync(stores[1], current);
        const retargetedProof = materialisationPlanExactFileProof(lexical, 'layout');
        assert.notStrictEqual(
            retargetedProof,
            linkedProof,
            'a stable link text must still bind the resolved realpath'
        );

        fs.writeFileSync(path.join(stores[1], 'entry.ts'), 'export const value = 2;\n');
        assert.notStrictEqual(
            materialisationPlanExactFileProof(lexical, 'layout'),
            retargetedProof,
            'layout file bytes remain part of the exact proof'
        );
    });

    it('guards merged source layout topology without losing semantic source reuse', () => {
        const { root, cachePath } = fixture();
        const targets = [path.join(root, 'source-a.ts'), path.join(root, 'source-b.ts')];
        fs.writeFileSync(targets[0], "import './dep';\nconst value = 1; void value;\n");
        fs.writeFileSync(targets[1], "import './dep';\nconst value = 2; void value;\n");
        const source = path.join(root, 'linked-source.ts');
        fs.symlinkSync(targets[0], source);
        const topologyProof = materialisationPlanLayoutTopologyProof(
            materialisationPlanExactFileProof(source, 'layout')
        );
        assert.strictEqual(typeof topologyProof, 'string');

        fs.unlinkSync(source);
        fs.symlinkSync(targets[1], source);
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.deepStrictEqual(
            cache.write({
                complete: true,
                payload: { graph: true },
                files: [
                    {
                        kind: 'source',
                        path: source,
                        signature: sourceSignature(source),
                        layoutTopologyProof: topologyProof
                    }
                ],
                sourceSignature
            }),
            { ok: false, reason: 'source-changed-during-write', detail: source }
        );

        const currentTopologyProof = materialisationPlanLayoutTopologyProof(
            materialisationPlanExactFileProof(source, 'layout')
        );
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: { graph: true },
                files: [
                    {
                        kind: 'source',
                        path: source,
                        signature: sourceSignature(source),
                        layoutTopologyProof: currentTopologyProof
                    }
                ],
                sourceSignature
            }).ok,
            true
        );
        fs.writeFileSync(targets[1], "import './dep';\nconst value = 3; void value;\n");
        assert.strictEqual(
            cache.lookup({ sourceSignature }).hit,
            true,
            'later body-only bytes still reuse the graph-semantic source signature'
        );

        const unsafe = new MaterialisationPlanCache(
            path.join(root, '.cache', 'unsafe-plan.json'),
            identity()
        );
        assert.strictEqual(
            (
                unsafe.write({
                    complete: true,
                    payload: {},
                    files: [
                        {
                            kind: 'layout',
                            path: source,
                            topologyOnly: true,
                            discoveryProof: materialisationPlanExactFileProof(source, 'layout')
                        }
                    ]
                }) as { ok: false; reason: string }
            ).reason,
            'invalid-input-set',
            'topology-only evidence is valid only when a source input owns the same real file'
        );
    });

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

    it('rejects changed directory membership before reading changed source contents', () => {
        const { root, cachePath, source } = fixture();
        const watched = path.join(root, 'workspace');
        fs.mkdirSync(watched);
        let proof: DirectoryMembershipProof = { stamp: 'package-set-v1:a', entryCount: 1 };
        const provider = () => proof;
        const cache = new MaterialisationPlanCache(cachePath, identity());
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: {},
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                directories: [
                    cache.snapshotDirectory(
                        { path: watched, validator: 'fixture:directory-first:v1' },
                        provider
                    )
                ],
                sourceSignature,
                directoryMembership: provider
            }).ok,
            true
        );

        const future = new Date(Date.now() + 10_000);
        fs.utimesSync(source, future, future);
        proof = { stamp: 'package-set-v1:b', entryCount: 1 };
        const result = cache.lookup({
            directoryMembership: provider,
            sourceSignature: () => {
                throw new Error('directory mismatch must reject before source fallback');
            }
        });
        assert.strictEqual(result.hit, false);
        assert.strictEqual(result.hit ? undefined : result.reason, 'directory-membership-mismatch');
        assert.strictEqual(cache.counters.sourceSignatureFallbacks, 0);
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

    it('derives a path-safe key from every exact engine-identity field', () => {
        const hostile = {
            packageName: '../../effect/tsgo',
            version: '../7.0.0'
        };
        const key = materialisationPlanEngineCacheKey(hostile);

        assert.match(key, /^[0-9a-f]{64}$/);
        assert.ok(!key.includes('/') && !key.includes('\\') && !key.includes('..'));
        for (const field of ['packageName', 'version'] as const) {
            const changed = {
                ...hostile,
                [field]: 'changed'
            };
            assert.notStrictEqual(materialisationPlanEngineCacheKey(changed), key, field);
        }
    });

    it('inspects only checksum-valid regular cache files without following symlinks', () => {
        const { root, cachePath, source } = fixture();
        const expected = identity();
        const cache = new MaterialisationPlanCache(cachePath, expected);
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: {},
                files: [{ kind: 'source', path: source, signature: sourceSignature(source) }],
                sourceSignature
            }).ok,
            true
        );
        assert.deepStrictEqual(readValidMaterialisationPlanIdentity(cachePath), expected);

        const alias = path.join(root, 'plan-alias.json');
        fs.symlinkSync(cachePath, alias);
        assert.strictEqual(readValidMaterialisationPlanIdentity(alias), undefined);

        const envelope = readEnvelope(cachePath);
        envelope.body.identity.engine.version = 'tampered';
        writeEnvelope(cachePath, envelope);
        assert.strictEqual(readValidMaterialisationPlanIdentity(cachePath), undefined);
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

        const sourceDirectory = path.dirname(source);
        const directory = cache.snapshotDirectory({
            path: sourceDirectory,
            validator: RECURSIVE_DIRECTORY_MEMBERSHIP
        });
        assert.strictEqual(
            cache.write({
                complete: true,
                payload: {},
                files: [
                    {
                        kind: 'layout',
                        path: sourceDirectory,
                        discoveryProof: materialisationPlanExactFileProof(sourceDirectory, 'layout')
                    }
                ],
                directories: [directory]
            }).ok,
            true,
            'root layout topology and root membership are orthogonal persisted evidence'
        );
        assert.strictEqual(
            (
                cache.write({
                    complete: true,
                    payload: {},
                    files: [],
                    validationOnlyFiles: [
                        {
                            kind: 'layout',
                            path: sourceDirectory,
                            discoveryProof: materialisationPlanExactFileProof(
                                sourceDirectory,
                                'layout'
                            )
                        }
                    ],
                    directories: [directory]
                }) as { ok: false; reason: string }
            ).reason,
            'invalid-input-set',
            'publication-only evidence must never alias a persisted directory input'
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
