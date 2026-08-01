import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    CallHierarchyItem,
    CancellationTokenSource,
    CompletionTriggerKind
} from 'vscode-languageserver';
import { Document, DocumentManager } from '../../../../src/lib/documents';
import { configLoader } from '../../../../src/lib/documents/configLoader';
import { LSConfigManager } from '../../../../src/ls-config';
import { pathToUrl } from '../../../../src/utils';
import { stub } from 'sinon';
import {
    findDefaultExportIdentifierOffset,
    sourceModuleGraphSignature,
    TsGoPlugin
} from '../../../../src/plugins/typescript-go/lsp/TsGoPlugin';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('typescript-go TsGoPlugin helpers', () => {
    it('finds the Svelte 4 generated default class', () => {
        const text = `
            function $$render() {}
            export default class Input__SvelteComponent_ extends SvelteComponent {}
        `;
        const offset = findDefaultExportIdentifierOffset(text);

        assert.notStrictEqual(offset, undefined);
        assert.strictEqual(
            text.slice(offset, offset! + 'Input__SvelteComponent_'.length),
            'Input__SvelteComponent_'
        );
    });

    it('finds the Svelte 5 generated default export identifier', () => {
        const text = `
            const Input__SvelteComponent_ = __sveltets_2_isomorphic_component($$render());
            /* generated boundary */ export default (Input__SvelteComponent_);
        `;
        const offset = findDefaultExportIdentifierOffset(text);

        assert.notStrictEqual(offset, undefined);
        assert.strictEqual(
            text.slice(offset, offset! + 'Input__SvelteComponent_'.length),
            'Input__SvelteComponent_'
        );
    });

    it('does not guess when the default export has no identifier', () => {
        assert.strictEqual(
            findDefaultExportIdentifierOffset('export default createComponent();'),
            undefined
        );
    });

    it('maps only generated Svelte default-export definitions to the source anchor', () => {
        const originalPath = '/workspace/Child.svelte';
        const shadowPath = '/workspace/.cache/Child.svelte.tsx';
        const name = 'Child__SvelteComponent_';
        for (const generated of [
            `export default class ${name} extends SvelteComponent {}`,
            `const ${name} = make(); export default (${name});`
        ]) {
            const targetStart = generated.indexOf(name);
            const snapshot = {
                getFullText: () => generated,
                offsetAt: (position: { character: number }) => position.character,
                getOriginalPosition: () => ({ line: -1, character: -1 })
            };
            const plugin = new TsGoPlugin({
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                ),
                projects: {
                    getOriginalPath: (filePath: string) =>
                        filePath === shadowPath ? originalPath : undefined,
                    ensureSnapshot: () => snapshot
                } as any,
                server: { updateConfiguration: async () => undefined } as any
            });

            assert.deepStrictEqual(
                (plugin as any).mapDefinitionTarget(pathToUrl(shadowPath), {
                    start: { line: 0, character: targetStart },
                    end: { line: 0, character: targetStart + name.length }
                }),
                {
                    uri: pathToUrl(originalPath),
                    range: {
                        start: { line: 0, character: 1 },
                        end: { line: 0, character: 1 }
                    }
                }
            );

            const helper = generated.includes('make') ? 'make' : 'SvelteComponent';
            const helperStart = generated.indexOf(helper);
            assert.strictEqual(
                (plugin as any).mapDefinitionTarget(pathToUrl(shadowPath), {
                    start: { line: 0, character: helperStart },
                    end: { line: 0, character: helperStart + helper.length }
                }),
                undefined
            );
        }
    });

    it('closes and evicts a Svelte overlay when the client document closes', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const shadowPath = '/workspace/.cache/Component.svelte.tsx';
        const deleted: string[] = [];
        const closed: string[] = [];
        const shadows = {
            findProjectSvelteFiles: () => [],
            findDependencySvelteFiles: () => [],
            pruneOrphanedShadows: () => undefined,
            getShadowPath: () => shadowPath,
            deleteSnapshot: (fileName: string) => deleted.push(fileName)
        };
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        new TsGoPlugin({
            docManager,
            projects: { forFile: () => shadows } as any,
            server: {
                closeDocument: async (fileName: string) => {
                    closed.push(fileName);
                },
                updateConfiguration: async () => undefined
            } as any
        });

        docManager.openClientDocument({ uri, text: '<p />' });
        await tick();
        docManager.closeDocument(uri);
        await tick();

        assert.deepStrictEqual(deleted, ['/workspace/Component.svelte']);
        assert.deepStrictEqual(closed, [shadowPath]);
    });

    it('checks completion feature gates before synchronising a project', async () => {
        const configManager = new LSConfigManager();
        configManager.update({ typescript: { completions: { enable: false } } });
        let resolvedProject = false;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                forFile: () => {
                    resolvedProject = true;
                    throw new Error('project should not be touched');
                }
            } as any,
            server: { updateConfiguration: async () => undefined } as any,
            configManager
        });
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>const value = 1;</script>',
            /*skipConfigLoading*/ true
        );

        const result = await plugin.getCompletions(
            document,
            { line: 0, character: 15 },
            {
                triggerKind: CompletionTriggerKind.Invoked
            }
        );

        assert.strictEqual(result, null);
        assert.strictEqual(resolvedProject, false);
    });

    it('restarts once for the latest runtime native preference change', async () => {
        const configManager = new LSConfigManager();
        configManager.updateTsJsUserPreferences({
            typescript: { inlayHints: { parameterNames: { enabled: 'all' } } }
        } as any);
        let restarts = 0;
        const plugin = new TsGoPlugin({
            configManager,
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: {
                processId: 123,
                restart: async () => void restarts++,
                updateConfiguration: async () => undefined
            } as any
        });

        // Supersede a queued disable before it can restart. Only the final configuration needs
        // replay into a replacement child.
        configManager.updateTsJsUserPreferences({
            typescript: { inlayHints: { parameterNames: { enabled: 'none' } } }
        } as any);
        configManager.updateTsJsUserPreferences({
            typescript: { inlayHints: { parameterNames: { enabled: 'literals' } } }
        } as any);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await (plugin as any).configurationWork;
        assert.strictEqual(restarts, 1);

        configManager.update({ typescript: { hover: { enable: false } } });
        await tick();
        assert.strictEqual(
            restarts,
            1,
            'wrapper-only feature gates must not restart the native child'
        );
    });

    it('routes code-action data through resolve and preserves documentChanges', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>missing</script>',
            /*skipConfigLoading*/ true
        );
        let resolvedPayload: any;
        const server = {
            sendRequest: async (method: string, payload: any) => {
                if (method === 'textDocument/codeAction') {
                    return [{ title: 'Fix it', data: { fixId: 'one' } }];
                }
                resolvedPayload = payload;
                return {
                    title: 'Fixed',
                    edit: {
                        documentChanges: [
                            {
                                textDocument: {
                                    uri: pathToUrl('/workspace/helper.ts'),
                                    version: 2
                                },
                                edits: [
                                    {
                                        range: {
                                            start: { line: 0, character: 0 },
                                            end: { line: 0, character: 0 }
                                        },
                                        newText: 'import "x";'
                                    }
                                ]
                            }
                        ]
                    }
                };
            },
            updateConfiguration: async () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                getOriginalPath: () => undefined,
                ensureSnapshot: () => undefined
            } as any,
            server: server as any
        });
        (plugin as any).syncDocument = async () => ({
            shadowPath: '/workspace/.cache/Component.svelte.tsx',
            snapshot: {
                getGeneratedPosition: (position: any) => position
            }
        });

        const [action] = await plugin.getCodeActions(
            document,
            {
                start: { line: 0, character: 8 },
                end: { line: 0, character: 15 }
            },
            { diagnostics: [], only: ['quickfix'], triggerKind: 1 }
        );
        assert.deepStrictEqual(action.data, {
            uri: document.uri,
            __tsgoData: { fixId: 'one' }
        });

        const resolved = await plugin.resolveCodeAction(document, action);
        assert.deepStrictEqual(resolvedPayload.data, { fixId: 'one' });
        assert.strictEqual(resolved.title, 'Fixed');
        assert.ok(resolved.edit?.documentChanges);
        assert.strictEqual(resolved.edit?.changes, undefined);
    });

    it('does not send unsupported markup completion triggers to tsgo', async () => {
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).syncDocument = async () => {
            throw new Error('must return before sync');
        };
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<div>',
            /*skipConfigLoading*/ true
        );

        assert.strictEqual(
            await plugin.getCompletions(
                document,
                { line: 0, character: 5 },
                {
                    triggerKind: CompletionTriggerKind.TriggerCharacter,
                    triggerCharacter: '>'
                }
            ),
            null
        );
    });

    it('does not start tsgo for invoked completion in top-level plain text', async () => {
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).syncDocument = async () => {
            throw new Error('plain text completion must return before synchronisation');
        };
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            'hello',
            /*skipConfigLoading*/ true
        );

        assert.strictEqual(
            await plugin.getCompletions(
                document,
                { line: 0, character: 5 },
                {
                    triggerKind: CompletionTriggerKind.Invoked
                }
            ),
            null
        );
    });

    it('does not start tsgo for completion inside a style block', async () => {
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).syncDocument = async () => {
            throw new Error('style completion must return before synchronisation');
        };
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<style>.item { color: re }</style>',
            /*skipConfigLoading*/ true
        );

        assert.strictEqual(
            await plugin.getCompletions(
                document,
                document.positionAt(document.getText().indexOf('re') + 2),
                { triggerKind: CompletionTriggerKind.Invoked }
            ),
            null
        );
    });

    it('eagerly forwards dirty Svelte changes before a cross-file request', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const sent: string[] = [];
        let openText: string | undefined;
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const shadows = {
            getShadowPath: () => shadowPath,
            transform: (document: Document) => ({
                getFullText: () => `generated:${document.getText()}`
            }),
            rewriteBatchModuleSpecifiers: (text: string) =>
                text.replace('generated:', 'rewritten:'),
            ensureShadowDirectory: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager,
            projects: { forFile: () => shadows } as any,
            server: {
                updateConfiguration: async () => undefined,
                getOpenText: () => openText,
                isOpen: () => openText !== undefined,
                openDocument: async (_fileName: string, text: string) => {
                    openText = text;
                    sent.push(text);
                },
                updateDocument: async (_fileName: string, _changes: any, text: string) => {
                    openText = text;
                    sent.push(text);
                }
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => undefined;

        const document = docManager.openClientDocument({ uri, text: '<p>saved</p>' });
        await (plugin as any).svelteLifecycle.get('/workspace/Component.svelte');
        document.setText('<p>dirty</p>');
        // Mirror DocumentManager.updateDocument's notification without coupling this focused
        // test to range-edit construction.
        (docManager as any).notify('documentChange', document);
        await (plugin as any).svelteLifecycle.get('/workspace/Component.svelte');

        assert.deepStrictEqual(sent, ['rewritten:<p>saved</p>', 'rewritten:<p>dirty</p>']);
    });

    it('rewrites watched Svelte saves with each materialising manager collision map', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-manager-rewrite-'));
        const sourcePath = path.join(root, 'Component.svelte');
        const firstShadow = path.join(root, 'first', 'Component.svelte.tsx');
        const secondShadow = path.join(root, 'second', 'Component.svelte.tsx');
        fs.writeFileSync(sourcePath, '<p />');

        const writes: Array<{ manager: string; path: string; text: string }> = [];
        const makeManager = (name: string, shadowPath: string, suffix: string) => ({
            getShadowPath: () => shadowPath,
            transform: (_document: Document) => ({
                getFullText: () => 'import Component from "./Component.svelte";'
            }),
            rewriteBatchModuleSpecifiers: (text: string) => text.replace('.svelte', suffix),
            writeShadow: (fileName: string, text: string) => {
                writes.push({ manager: name, path: fileName, text });
            },
            deleteSnapshot: () => undefined,
            removeShadow: () => undefined
        });
        const first = makeManager('first', firstShadow, '.__svlt');
        const second = makeManager('second', secondShadow, '.__s000');
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: { forFile: () => first } as any,
            server: {
                updateConfiguration: async () => undefined,
                notifyWatchedFiles: async () => undefined
            } as any
        });
        (plugin as any).markShadowMaterialized(sourcePath, firstShadow, first);
        (plugin as any).markShadowMaterialized(sourcePath, secondShadow, second);

        try {
            plugin.onWatchFileChanges([{ fileName: sourcePath, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;

            assert.deepStrictEqual(writes, [
                {
                    manager: 'first',
                    path: firstShadow,
                    text: 'import Component from "./Component.__svlt";'
                },
                {
                    manager: 'second',
                    path: secondShadow,
                    text: 'import Component from "./Component.__s000";'
                }
            ]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materialises the same source independently for distinct project shadow paths', async () => {
        const source = '/workspace/shared/Component.svelte';
        const checked: string[] = [];
        const makeManager = (shadowPath: string) => ({
            findProjectSvelteFiles: () => [source],
            findDependencySvelteFiles: () => [],
            getShadowPath: () => shadowPath,
            isShadowFresh: (_source: string, candidate: string) => {
                checked.push(candidate);
                return true;
            },
            deleteSnapshot: () => undefined,
            pruneOrphanedShadows: () => undefined,
            commitFingerprints: () => undefined
        });
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });

        await (plugin as any).ensureProjectOpened(makeManager('/one/Component.svelte.tsx'));
        await (plugin as any).ensureProjectOpened(makeManager('/two/Component.svelte.tsx'));

        assert.deepStrictEqual(checked, ['/one/Component.svelte.tsx', '/two/Component.svelte.tsx']);
    });

    it('indexes completed project graph config and manifest inputs', async () => {
        const graphPlan = {
            sourceInputs: [],
            configInputs: ['/workspace/config/strict-base.json'],
            manifestInputs: ['/workspace/packages/ui/package.json']
        };
        const manager = {
            findProjectSvelteFiles: () => [],
            findDependencySvelteFiles: () => [],
            pruneOrphanedShadows: () => undefined,
            commitFingerprints: () => undefined,
            exportBatchGraphPlan: () => graphPlan
        };
        let recorded: { manager: unknown; inputs: unknown } | undefined;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                recordProjectGraphInputs: (candidate: unknown, inputs: unknown) => {
                    recorded = { manager: candidate, inputs };
                }
            } as any,
            server: { updateConfiguration: async () => undefined } as any
        });

        await (plugin as any).materializeProject(manager, () => undefined);

        assert.deepStrictEqual(recorded, { manager, inputs: graphPlan });
    });

    it('serializes materialisation transactions that publish into one source-root mirror tree', async () => {
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
        const started: string[] = [];
        const makeManager = (name: string) => ({ name, sourceRoot: '/workspace' });
        const first = makeManager('first');
        const second = makeManager('second');
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).materializeProject = async (manager: { name: string }) => {
            started.push(manager.name);
            if (manager === first) {
                await firstGate;
            }
        };

        const firstRun = (plugin as any).ensureProjectOpened(first);
        await tick();
        const secondRun = (plugin as any).ensureProjectOpened(second);
        await tick();
        assert.deepStrictEqual(started, ['first']);

        releaseFirst();
        await Promise.all([firstRun, secondRun]);
        assert.deepStrictEqual(started, ['first', 'second']);
    });

    it('drains project publication tails added while startup is already waiting', async () => {
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
        const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
        const started: string[] = [];
        const first = { name: 'first', sourceRoot: '/workspace' };
        const second = { name: 'second', sourceRoot: '/workspace' };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).materializeProject = async (manager: { name: string }) => {
            started.push(manager.name);
            await (manager === first ? firstGate : secondGate);
        };

        const firstRun = (plugin as any).ensureProjectOpened(first);
        const startupBarrier = plugin.awaitProjectPublicationsBeforeStart();
        await tick();
        const secondRun = (plugin as any).ensureProjectOpened(second);
        releaseFirst();
        await firstRun;
        await tick();

        assert.deepStrictEqual(started, ['first', 'second']);
        let barrierSettled = false;
        void startupBarrier.then(() => (barrierSettled = true));
        await tick();
        assert.strictEqual(barrierSettled, false, 'a later publication tail slipped past startup');

        releaseSecond();
        await Promise.all([secondRun, startupBarrier]);
        assert.strictEqual(barrierSettled, true);
    });

    it('switches the startup barrier to a replacement structural epoch', async () => {
        let releaseObsolete!: () => void;
        let releaseReplacement!: () => void;
        const obsoleteGate = new Promise<void>((resolve) => (releaseObsolete = resolve));
        const replacementGate = new Promise<void>((resolve) => (releaseReplacement = resolve));
        const obsolete = { name: 'obsolete', sourceRoot: '/workspace' };
        const replacement = { name: 'replacement', sourceRoot: '/workspace' };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).materializeProject = async (manager: { name: string }) => {
            await (manager === obsolete ? obsoleteGate : replacementGate);
        };

        const obsoleteRun = (plugin as any).ensureProjectOpened(obsolete);
        const startupBarrier = plugin.awaitProjectPublicationsBeforeStart();
        await tick();
        (plugin as any).advanceStructuralEpoch();
        const replacementRun = (plugin as any).ensureProjectOpened(replacement);

        let barrierSettled = false;
        void startupBarrier.then(() => (barrierSettled = true));
        await tick();
        assert.strictEqual(
            barrierSettled,
            false,
            'startup ignored the replacement epoch publication'
        );

        releaseReplacement();
        await Promise.all([replacementRun, startupBarrier]);
        assert.strictEqual(
            barrierSettled,
            true,
            'the obsolete epoch kept replacement startup blocked'
        );

        // The obsolete transform may still be unwinding, but its assertCurrent guard owns the
        // publication decision. Release it only to leave no dangling test work.
        releaseObsolete();
        await obsoleteRun;
    });

    it('keeps a failed publication visible until the failed manager retries successfully', async () => {
        const failure = new Error('shadow write failed');
        const failedManager = { name: 'failed', sourceRoot: '/workspace' };
        const laterManager = { name: 'later', sourceRoot: '/workspace' };
        let failedAttempts = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).materializeProject = async (manager: { name: string }) => {
            if (manager === failedManager && failedAttempts++ === 0) {
                throw failure;
            }
        };

        const first = (plugin as any).ensureProjectOpened(failedManager);
        const later = (plugin as any).ensureProjectOpened(laterManager);
        const [firstResult, laterResult] = await Promise.allSettled([first, later]);
        assert.strictEqual(firstResult.status, 'rejected');
        assert.strictEqual((firstResult as PromiseRejectedResult).reason, failure);
        assert.strictEqual(laterResult.status, 'fulfilled');

        // The later manager's successful transaction uses the same always-settled sequence tail,
        // but must not launder the earlier manager's partial publication into startup success.
        await assert.rejects(plugin.awaitProjectPublicationsBeforeStart(), failure);
        await assert.rejects(plugin.awaitProjectPublicationsBeforeStart(), failure);

        await (plugin as any).ensureProjectOpened(failedManager);
        await plugin.awaitProjectPublicationsBeforeStart();
        assert.strictEqual(failedAttempts, 2);
    });

    it('publishes collision source mirrors, support scopes and ownership in one transaction', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-editor-mirrors-'));
        const component = path.join(root, 'Component.svelte');
        const source = path.join(root, 'index.ts');
        const componentShadow = path.join(root, '.mirror', 'Component.__svlt.tsx');
        const sourceMirror = path.join(root, '.mirror', 'index.ts');
        const support = path.join(root, '.mirror', 'package.json');
        fs.writeFileSync(component, '<p />');
        fs.writeFileSync(source, 'export * from "./Component.svelte";');

        const writes = new Map<string, string>();
        const lifecycle: string[] = [];
        let owned = new Set<string>();
        const configStub = stub(configLoader, 'awaitConfig').resolves(undefined);
        const manager = {
            sourceRoot: root,
            findProjectSvelteFiles: () => [component],
            findDependencySvelteFiles: () => [],
            getBatchMaterializedSvelteFiles: () => [],
            getShadowPath: () => componentShadow,
            isShadowFresh: () => false,
            transform: () => ({
                getFullText: () => 'import "./Component.svelte";'
            }),
            rewriteBatchModuleSpecifiers: (text: string) => text.replaceAll('.svelte', '.__svlt'),
            getBatchSourceMirrorEntries: () => [
                { originalPath: source, mirrorPath: sourceMirror, kind: 'script' as const }
            ],
            writeShadow: (fileName: string, text: string) => {
                writes.set(fileName, text);
            },
            writeBatchMirrorPackageScopes: () => {
                lifecycle.push('support');
                return [support];
            },
            reconcileBatchMirrorOwnership: (_previous: string[], live: string[]) => {
                lifecycle.push('ownership');
                owned = new Set(live);
            },
            pruneOrphanedShadows: () => lifecycle.push('prune'),
            deleteSnapshot: () => undefined,
            commitFingerprints: () => lifecycle.push('fingerprints')
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });

        try {
            await (plugin as any).ensureProjectOpened(manager);
            assert.strictEqual(writes.get(componentShadow), 'import "./Component.__svlt";');
            assert.strictEqual(writes.get(sourceMirror), 'export * from "./Component.__svlt";');
            assert.deepStrictEqual(owned, new Set([componentShadow, sourceMirror, support]));
            assert.deepStrictEqual(lifecycle, ['support', 'ownership', 'prune', 'fingerprints']);
        } finally {
            configStub.restore();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not let an invalidated materialisation overwrite its replacement generation', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-materialise-race-'));
        const sourcePath = path.join(root, 'Component.svelte');
        const shadowPath = path.join(root, '.svelte-kit', 'Component.svelte.tsx');
        fs.writeFileSync(sourcePath, '<p />');

        let releaseOldConfig!: () => void;
        let oldConfigStarted!: () => void;
        const oldConfigGate = new Promise<void>((resolve) => (releaseOldConfig = resolve));
        const oldConfigIsWaiting = new Promise<void>((resolve) => (oldConfigStarted = resolve));
        let configLoads = 0;
        const configStub = stub(configLoader, 'awaitConfig').callsFake(async () => {
            if (++configLoads === 1) {
                oldConfigStarted();
                await oldConfigGate;
            }
            return undefined;
        });

        let shadowContents: string | undefined;
        const calls = {
            old: { writes: 0, removes: 0, prunes: 0, commits: 0, invalidations: 0 },
            replacement: { writes: 0, removes: 0, prunes: 0, commits: 0, invalidations: 0 }
        };
        const manager = (generation: 'old' | 'replacement') => ({
            sourceRoot: root,
            findProjectSvelteFiles: () => [sourcePath],
            findDependencySvelteFiles: () => [],
            getShadowPath: () => shadowPath,
            isShadowFresh: () => false,
            transform: () => ({ getFullText: () => `${generation}-generation` }),
            writeShadow: (_fileName: string, text: string) => {
                calls[generation].writes++;
                shadowContents = text;
            },
            removeShadow: () => calls[generation].removes++,
            deleteSnapshot: () => undefined,
            pruneOrphanedShadows: () => calls[generation].prunes++,
            commitFingerprints: () => calls[generation].commits++,
            invalidateStructuralCaches: () => calls[generation].invalidations++
        });
        const oldManager = manager('old');
        const replacementManager = manager('replacement');
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                invalidateForStructuralChange: () => [oldManager]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                restart: async () => undefined,
                notifyWatchedFiles: async () => undefined
            } as any
        });
        let oldMaterialisation: Promise<void> | undefined;

        try {
            oldMaterialisation = (plugin as any).ensureProjectOpened(oldManager);
            await oldConfigIsWaiting;

            plugin.onWatchFileChanges([
                { fileName: path.join(root, 'tsconfig.json'), changeType: 2 /* Changed */ }
            ]);
            await (plugin as any).watchWork;

            await (plugin as any).ensureProjectOpened(replacementManager);
            assert.strictEqual(shadowContents, 'replacement-generation');

            releaseOldConfig();
            await oldMaterialisation;

            assert.deepStrictEqual(calls.old, {
                writes: 0,
                removes: 0,
                prunes: 0,
                commits: 0,
                invalidations: 1
            });
            assert.deepStrictEqual(calls.replacement, {
                writes: 1,
                removes: 0,
                prunes: 1,
                commits: 1,
                invalidations: 0
            });
            assert.strictEqual(shadowContents, 'replacement-generation');
        } finally {
            releaseOldConfig();
            await oldMaterialisation?.catch(() => undefined);
            configStub.restore();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('synchronises an unsaved component before finding project-wide references', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const document = docManager.openClientDocument({ uri, text: '<p />' });
        let syncs = 0;
        let requestedUri: string | undefined;
        const snapshot = {
            getFullText: () => 'const Component = 1; export default Component;',
            positionAt: () => ({ line: 0, character: 6 })
        };
        const plugin = new TsGoPlugin({
            docManager,
            projects: {} as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async (_method: string, params: any) => {
                    requestedUri = params.textDocument.uri;
                    return [];
                }
            } as any
        });
        (plugin as any).desiredOpenSvelte.add('/workspace/Component.svelte');
        (plugin as any).syncDocument = async (candidate: Document) => {
            assert.strictEqual(candidate, document);
            syncs++;
            return { snapshot, shadowPath, projectKey: '/workspace/.overlay/tsconfig.json' };
        };

        assert.deepStrictEqual(await plugin.findComponentReferences(uri), []);
        assert.strictEqual(syncs, 1);
        assert.strictEqual(requestedUri, pathToUrl(shadowPath));
    });

    it('skips recursive project cleanup when a child restart reuses the same graph', async () => {
        const sourcePath = '/workspace/Component.svelte';
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        let prunes = 0;
        const manager = {
            findProjectSvelteFiles: () => [sourcePath],
            findDependencySvelteFiles: () => [],
            getShadowPath: () => shadowPath,
            isShadowFresh: () => true,
            deleteSnapshot: () => undefined,
            pruneOrphanedShadows: (live: Set<string>) => {
                prunes++;
                assert.deepStrictEqual(live, new Set([shadowPath]));
            },
            commitFingerprints: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });

        await (plugin as any).ensureProjectOpened(manager);
        plugin.resetProjects();
        await (plugin as any).ensureProjectOpened(manager);

        assert.strictEqual(prunes, 1);
        assert.strictEqual(plugin.stats.materialisationCleanupRuns, 1);
        assert.strictEqual(plugin.stats.materialisationCleanupSkips, 1);
    });

    it('does not reopen a Svelte overlay when close wins during first materialisation', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        let release!: () => void;
        const materialising = new Promise<void>((resolve) => (release = resolve));
        const opened: string[] = [];
        const closed: string[] = [];
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const shadows = {
            getShadowPath: () => shadowPath,
            transform: () => ({ getFullText: () => 'generated' }),
            ensureShadowDirectory: () => undefined,
            deleteSnapshot: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager,
            projects: { forFile: () => shadows } as any,
            server: {
                updateConfiguration: async () => undefined,
                getOpenText: () => undefined,
                isOpen: () => false,
                openDocument: async (fileName: string) => void opened.push(fileName),
                closeDocument: async (fileName: string) => void closed.push(fileName)
            } as any
        });
        (plugin as any).ensureProjectOpened = () => materialising;

        docManager.openClientDocument({ uri, text: '<p />' });
        docManager.closeDocument(uri);
        release();
        await (plugin as any).svelteLifecycle.get('/workspace/Component.svelte');

        assert.deepStrictEqual(opened, []);
        assert.deepStrictEqual(closed, [shadowPath]);
    });

    it('replaces project state on TS source creation but keeps content saves incremental', async () => {
        let invalidations = 0;
        let restarts = 0;
        const manager = {
            invalidateStructuralCaches: () => invalidations++
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                invalidateForStructuralChange: () => [manager]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                restart: async () => void restarts++,
                notifyWatchedFiles: async () => undefined
            } as any
        });

        plugin.onWatchFileChanges([{ fileName: '/workspace/new.ts', changeType: 1 /* Created */ }]);
        await (plugin as any).watchWork;
        plugin.onWatchFileChanges([{ fileName: '/workspace/new.ts', changeType: 2 /* Changed */ }]);
        await (plugin as any).watchWork;

        assert.strictEqual(invalidations, 1);
        assert.strictEqual(restarts, 1);
    });

    it('retains unaffected open overlays during a targeted structural rebuild', async () => {
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const appPath = '/workspace/apps/app/App.svelte';
        const uiPath = '/workspace/packages/ui/Widget.svelte';
        const appDocument = docManager.openClientDocument({
            uri: pathToUrl(appPath),
            text: '<p>app</p>'
        });
        docManager.openClientDocument({ uri: pathToUrl(uiPath), text: '<p>ui</p>' });
        const appManager = { invalidateStructuralCaches: () => undefined };
        const uiManager = { invalidateStructuralCaches: () => undefined };
        const closed: string[] = [];
        const synced: Document[] = [];
        let restarts = 0;
        const plugin = new TsGoPlugin({
            docManager,
            projects: {
                forFile: (fileName: string) =>
                    fileName.includes('/apps/app/') ? appManager : uiManager,
                invalidateForStructuralChange: () => [appManager]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                closeDocument: async (fileName: string) => void closed.push(fileName),
                restart: async () => void restarts++,
                notifyWatchedFiles: async () => undefined
            } as any
        });
        (plugin as any).desiredOpenSvelte.add(appPath);
        (plugin as any).desiredOpenSvelte.add(uiPath);
        (plugin as any).svelteOverlayBySource.set(appPath, `${appPath}.tsx`);
        (plugin as any).svelteOverlayBySource.set(uiPath, `${uiPath}.tsx`);
        (plugin as any).ensureProjectOpened = async () => undefined;
        (plugin as any).syncDocumentNow = async (document: Document) => {
            synced.push(document);
            return null;
        };

        plugin.onWatchFileChanges([
            {
                fileName: '/workspace/apps/app/tsconfig.json',
                changeType: 2 /* Changed */
            }
        ]);
        await (plugin as any).watchWork;

        assert.strictEqual(restarts, 1);
        assert.deepStrictEqual(closed, [`${appPath}.tsx`]);
        assert.deepStrictEqual(synced, [appDocument]);
        assert.strictEqual((plugin as any).svelteOverlayBySource.has(appPath), false);
        assert.strictEqual((plugin as any).svelteOverlayBySource.get(uiPath), `${uiPath}.tsx`);
    });

    it('rebuilds a tracked extended-config consumer only after a semantic change', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-extended-config-'));
        const appPath = path.join(root, 'apps', 'app', 'App.svelte');
        const extendedConfig = path.join(root, 'config', 'strict-base.json');
        fs.mkdirSync(path.dirname(appPath), { recursive: true });
        fs.mkdirSync(path.dirname(extendedConfig), { recursive: true });
        fs.writeFileSync(appPath, '<p>app</p>');
        fs.writeFileSync(
            extendedConfig,
            '{ "compilerOptions": { "rootDirs": ["src"], "paths": { "$lib/*": ["lib/*"] } } }'
        );

        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const appDocument = docManager.openClientDocument({
            uri: pathToUrl(appPath),
            text: '<p>app</p>'
        });
        let replaced = false;
        let invalidations = 0;
        let restarts = 0;
        const opened: unknown[] = [];
        const synced: Document[] = [];
        const closed: string[] = [];
        const previous = { invalidateStructuralCaches: () => invalidations++ };
        const replacement = { invalidateStructuralCaches: () => undefined };
        const projects = {
            isTrackedStructuralInput: (fileName: string) => fileName === extendedConfig,
            forFile: () => (replaced ? replacement : previous),
            invalidateForStructuralChanges: (fileNames: string[]) => {
                assert.deepStrictEqual(fileNames, [extendedConfig]);
                replaced = true;
                return [previous];
            }
        };
        const plugin = new TsGoPlugin({
            docManager,
            projects: projects as any,
            server: {
                updateConfiguration: async () => undefined,
                closeDocument: async (fileName: string) => void closed.push(fileName),
                restart: async () => void restarts++,
                notifyWatchedFiles: async () => undefined
            } as any
        });
        (plugin as any).desiredOpenSvelte.add(appPath);
        (plugin as any).svelteOverlayBySource.set(appPath, `${appPath}.tsx`);
        (plugin as any).ensureProjectOpened = async (manager: unknown) => void opened.push(manager);
        (plugin as any).syncDocumentNow = async (document: Document) => {
            synced.push(document);
            return null;
        };
        (plugin as any).seedStructuralFileSignature(extendedConfig);

        try {
            fs.writeFileSync(
                extendedConfig,
                '{\n // formatting only\n "compilerOptions": { "paths": { "$lib/*": ["lib/*"] }, "rootDirs": ["src"] }\n}'
            );
            plugin.onWatchFileChanges([{ fileName: extendedConfig, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;
            assert.strictEqual(restarts, 0);
            assert.strictEqual(invalidations, 0);

            fs.writeFileSync(
                extendedConfig,
                '{ "include": ["src", "generated"], "compilerOptions": { "rootDirs": ["src", "generated"], "paths": { "$lib/*": ["src/lib/*"] } } }'
            );
            plugin.onWatchFileChanges([{ fileName: extendedConfig, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;

            assert.strictEqual(invalidations, 1);
            assert.strictEqual(restarts, 1);
            assert.deepStrictEqual(opened, [replacement]);
            assert.deepStrictEqual(closed, [`${appPath}.tsx`]);
            assert.deepStrictEqual(synced, [appDocument]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('seeds unopened source graphs during materialisation and rebuilds their first import change', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-first-watch-'));
        const sourceFiles = [
            path.join(root, 'ordinary.ts'),
            path.join(root, 'ordinary.js'),
            path.join(root, 'Ordinary.svelte')
        ];
        const tsconfig = path.join(root, 'tsconfig.json');
        const packageJson = path.join(root, 'package.json');
        let invalidations = 0;
        let restarts = 0;
        const manager = {
            findProjectSvelteFiles: () => [],
            findDependencySvelteFiles: () => [],
            getShadowPath: (fileName: string) => `${fileName}.tsx`,
            transform: (document: Document) => ({
                getFullText: () => `generated:${document.getText()}`
            }),
            writeShadow: () => undefined,
            deleteSnapshot: () => undefined,
            pruneOrphanedShadows: () => undefined,
            commitFingerprints: () => undefined,
            getBatchGraphPlanSourceInputs: () =>
                sourceFiles.map((fileName) => ({
                    path: fileName,
                    signature: sourceModuleGraphSignature(fs.readFileSync(fileName, 'utf8'))
                })),
            invalidateStructuralCaches: () => invalidations++
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                forFile: () => manager,
                invalidateForStructuralChange: () => [manager]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                restart: async () => void restarts++,
                notifyWatchedFiles: async () => undefined,
                closeDocument: async () => undefined
            } as any
        });

        try {
            fs.writeFileSync(sourceFiles[0], 'export const value = 1;');
            fs.writeFileSync(sourceFiles[1], 'export const value = 2;');
            fs.writeFileSync(sourceFiles[2], '<script>export const value = 3;</script>');
            fs.writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { strict: true } }));
            fs.writeFileSync(packageJson, JSON.stringify({ type: 'module' }));

            await (plugin as any).materializeProject(manager, () => undefined);

            for (const fileName of sourceFiles.slice(1)) {
                plugin.onWatchFileChanges([{ fileName, changeType: 2 /* Changed */ }]);
                await (plugin as any).watchWork;
            }

            assert.strictEqual(invalidations, 0, 'ordinary saves must not clear managers');
            assert.strictEqual(restarts, 0, 'ordinary saves must not restart tsgo');

            fs.writeFileSync(sourceFiles[0], 'import "./New.svelte"; export const value = 1;');
            plugin.onWatchFileChanges([{ fileName: sourceFiles[0], changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;

            assert.strictEqual(invalidations, 1, 'a newly-added import must clear its manager');
            assert.strictEqual(restarts, 1, 'a newly-added import must restart tsgo');

            plugin.onWatchFileChanges([{ fileName: tsconfig, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;
            plugin.onWatchFileChanges([{ fileName: packageJson, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;

            assert.strictEqual(
                invalidations,
                3,
                'source, config and package changes clear managers'
            );
            assert.strictEqual(restarts, 3, 'source, config and package changes restart tsgo');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('invalidates TS, TSX and Svelte barrel graphs without rebuilding for leaf edits', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-graph-'));
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        const classify = (fileName: string) =>
            (plugin as any).isStructuralWatchChange({
                fileName,
                changeType: 2 /* Changed */
            });

        try {
            const cases = [
                {
                    fileName: path.join(root, 'barrel.ts'),
                    initial:
                        'export { default as Button } from "./Button.svelte";\nconst leaf = 1;',
                    leaf: 'export { default as Button } from "./Button.svelte";\nconst leaf = 2;',
                    changed: 'export { default as Button } from "./Other.svelte";\nconst leaf = 2;'
                },
                {
                    fileName: path.join(root, 'barrel.tsx'),
                    initial:
                        'export { default as View } from "./View.svelte";\nconst node = <div/>;',
                    leaf: 'export { default as View } from "./View.svelte";\nconst node = <span/>;',
                    changed:
                        'export { default as View } from "./Other.svelte";\nconst node = <span/>;'
                },
                {
                    fileName: path.join(root, 'Barrel.svelte'),
                    initial:
                        '<script>export { default as Item } from "./Item.svelte"; let leaf = 1;</script>',
                    leaf: '<script>export { default as Item } from "./Item.svelte"; let leaf = 2;</script>',
                    changed:
                        '<script>export { default as Item } from "./Other.svelte"; let leaf = 2;</script>'
                }
            ];

            for (const testCase of cases) {
                fs.writeFileSync(testCase.fileName, testCase.initial);
                assert.strictEqual(
                    classify(testCase.fileName),
                    false,
                    'first observation establishes the baseline without rebuilding'
                );
                fs.writeFileSync(testCase.fileName, testCase.leaf);
                assert.strictEqual(
                    classify(testCase.fileName),
                    false,
                    `${path.extname(testCase.fileName)} leaf edit must stay incremental`
                );
                fs.writeFileSync(testCase.fileName, testCase.changed);
                assert.strictEqual(
                    classify(testCase.fileName),
                    true,
                    `${path.extname(testCase.fileName)} re-export must rebuild reachability`
                );
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps no-op structural saves incremental and rebuilds semantic changes', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-structural-watch-'));
        const tsconfig = path.join(root, 'tsconfig.json');
        const extendedConfig = path.join(root, 'config', 'strict-base.json');
        const packageJson = path.join(root, 'package.json');
        const svelteConfig = path.join(root, 'svelte.config.js');
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                isTrackedStructuralInput: (fileName: string) => fileName === extendedConfig
            } as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        const changed = (fileName: string) =>
            (plugin as any).isStructuralWatchChange({
                fileName,
                changeType: 2 /* Changed */
            });

        try {
            fs.writeFileSync(tsconfig, '{ "compilerOptions": { "strict": true } }');
            fs.mkdirSync(path.dirname(extendedConfig), { recursive: true });
            fs.writeFileSync(
                extendedConfig,
                '{ "compilerOptions": { "rootDirs": ["src"], "paths": { "$lib/*": ["lib/*"] } } }'
            );
            fs.writeFileSync(packageJson, '{ "type": "module", "exports": "./index.js" }');
            fs.writeFileSync(svelteConfig, 'export default { compilerOptions: { dev: true } };\n');
            for (const fileName of [tsconfig, extendedConfig, packageJson, svelteConfig]) {
                (plugin as any).seedStructuralFileSignature(fileName);
                assert.strictEqual(changed(fileName), false, `${path.basename(fileName)} touch`);
            }

            fs.writeFileSync(
                tsconfig,
                '{\n // formatting and comments are not semantic\n "compilerOptions": { "strict": true, },\n}'
            );
            assert.strictEqual(changed(tsconfig), false, 'JSONC-only edits stay incremental');

            fs.writeFileSync(
                extendedConfig,
                '{\n // arbitrary extended configs are JSONC too\n "compilerOptions": { "paths": { "$lib/*": ["lib/*"], }, "rootDirs": ["src"], },\n}'
            );
            assert.strictEqual(
                changed(extendedConfig),
                false,
                'comment/key-order edits in an extended config stay incremental'
            );

            fs.writeFileSync(packageJson, '{\n  "exports": "./index.js",\n  "type": "module"\n}');
            assert.strictEqual(changed(packageJson), false, 'manifest key order is not semantic');

            fs.writeFileSync(tsconfig, '{ "compilerOptions": { "strict": false } }');
            assert.strictEqual(changed(tsconfig), true, 'compiler option changes rebuild');
            fs.writeFileSync(
                extendedConfig,
                '{ "compilerOptions": { "rootDirs": ["src", "generated"], "paths": { "$lib/*": ["src/lib/*"] } } }'
            );
            assert.strictEqual(
                changed(extendedConfig),
                true,
                'paths/rootDirs changes in an extended config rebuild'
            );
            fs.writeFileSync(packageJson, '{ "exports": "./other.js", "type": "module" }');
            assert.strictEqual(changed(packageJson), true, 'export changes rebuild');
            fs.writeFileSync(svelteConfig, 'export default { compilerOptions: { dev: false } };\n');
            assert.strictEqual(changed(svelteConfig), true, 'executable config changes rebuild');

            fs.rmSync(extendedConfig);
            assert.strictEqual(
                (plugin as any).isStructuralWatchChange({
                    fileName: extendedConfig,
                    changeType: 3 /* Deleted */
                }),
                true,
                'deleting a tracked extended config rebuilds'
            );

            const newManifest = path.join(root, 'new-sibling', 'package.json');
            fs.mkdirSync(path.dirname(newManifest), { recursive: true });
            fs.writeFileSync(newManifest, '{ "name": "new-sibling", "exports": "./index.js" }');
            assert.strictEqual(
                (plugin as any).isStructuralWatchChange({
                    fileName: newManifest,
                    changeType: 1 /* Created */
                }),
                true,
                'adding a previously unseen package export rebuilds'
            );
            fs.rmSync(newManifest);
            assert.strictEqual(
                (plugin as any).isStructuralWatchChange({
                    fileName: newManifest,
                    changeType: 3 /* Deleted */
                }),
                true,
                'deleting a package export rebuilds'
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('invalidates transitions into computed-import and import.meta.glob reachability', () => {
        const leaf = sourceModuleGraphSignature('const value = 1;');
        const computed = sourceModuleGraphSignature('void import(`./${name}.svelte`);');
        const requireComputed = sourceModuleGraphSignature('require(componentName);');
        const glob = sourceModuleGraphSignature(
            'const components = import.meta.glob("./*.svelte");'
        );
        const otherGlob = sourceModuleGraphSignature(
            'const components = import.meta.glob("./routes/*.svelte");'
        );
        const computedGlob = sourceModuleGraphSignature(
            'const components = import.meta.glob(pattern);'
        );
        const literal = sourceModuleGraphSignature('void import("./Item.svelte");');
        const spacedLiteral = sourceModuleGraphSignature('void import(  "./Item.svelte");');

        assert.notStrictEqual(computed, leaf);
        assert.notStrictEqual(requireComputed, leaf);
        assert.notStrictEqual(glob, leaf);
        assert.notStrictEqual(glob, otherGlob);
        assert.notStrictEqual(glob, computed);
        assert.strictEqual(spacedLiteral, literal, 'whitespace must not make a literal ambiguous');
        // Once reachability is already ambiguous, changing only the broad mechanism does not
        // require rebuilding the same complete-workspace fallback.
        assert.strictEqual(computed, requireComputed);
        assert.strictEqual(computed, computedGlob);
    });

    it('keeps a shared diagnostic check alive while another waiter remains', async () => {
        let finish!: (value: any[]) => void;
        const result = new Promise<any[]>((resolve) => (finish = resolve));
        let nativeToken: any;
        let checks = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined
            } as any
        });
        (plugin as any).collectDiagnostics = async (_synced: any, token: any) => {
            checks++;
            nativeToken = token;
            return result;
        };
        const synced = {
            shadowPath: '/workspace/.overlay/Comp.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: {}
        };
        const firstToken = new CancellationTokenSource();
        const secondToken = new CancellationTokenSource();
        const first = (plugin as any).collectDiagnosticsSingleFlight(synced, firstToken.token, 0);
        const second = (plugin as any).collectDiagnosticsSingleFlight(synced, secondToken.token, 0);
        await tick();
        firstToken.cancel();

        assert.strictEqual(await first, null);
        assert.strictEqual(nativeToken.isCancellationRequested, false);
        finish([]);
        assert.deepStrictEqual(await second, []);
        assert.strictEqual(checks, 1);
        assert.strictEqual(plugin.stats.diagnosticCoalesced, 1);
        firstToken.dispose();
        secondToken.dispose();
    });

    it('serializes different shadow diagnostics in the same project', async () => {
        let finishFirst!: () => void;
        const firstNative = new Promise<void>((resolve) => (finishFirst = resolve));
        const calls: string[] = [];
        let active = 0;
        let maxActive = 0;
        const server = {
            generation: 1,
            updateConfiguration: async () => undefined,
            sendRequest: async (_method: string, params: any) => {
                calls.push(params.textDocument.uri);
                active++;
                maxActive = Math.max(maxActive, active);
                if (calls.length === 1) {
                    await firstNative;
                }
                active--;
                return { items: [] };
            }
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: server as any
        });
        const synced = (name: string) => ({
            document: {},
            shadowPath: `/workspace/.overlay/${name}.svelte.tsx`,
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: {
                filePath: `/workspace/${name}.svelte`,
                getFullText: () => ''
            }
        });

        const first = (plugin as any).collectDiagnosticsSingleFlight(synced('First'), undefined, 0);
        const second = (plugin as any).collectDiagnosticsSingleFlight(
            synced('Second'),
            undefined,
            0
        );
        await tick();

        assert.strictEqual(calls.length, 1, 'the second project check started concurrently');
        assert.strictEqual(plugin.stats.projectChecks, 1);
        finishFirst();
        assert.deepStrictEqual(await Promise.all([first, second]), [[], []]);
        assert.strictEqual(calls.length, 2, 'each requested document still needs its own report');
        assert.strictEqual(maxActive, 1);
        assert.strictEqual(plugin.stats.projectChecks, 2);
        assert.strictEqual(plugin.stats.diagnosticCoalesced, 0);
    });

    it('cancels active and pending stale-generation project diagnostics', async () => {
        let finishOld!: () => void;
        const oldNative = new Promise<void>((resolve) => (finishOld = resolve));
        const calls: string[] = [];
        const server = {
            generation: 1,
            updateConfiguration: async () => undefined,
            sendRequest: async (_method: string, params: any) => {
                const uri = params.textDocument.uri as string;
                calls.push(uri);
                if (uri.includes('Active')) {
                    // Deliberately ignore cancellation until the test releases the native call.
                    // Stale editor callers must still settle immediately.
                    await oldNative;
                }
                return { items: [] };
            }
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: server as any
        });
        const synced = (name: string) => ({
            document: {},
            shadowPath: `/workspace/.overlay/${name}.svelte.tsx`,
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: {
                filePath: `/workspace/${name}.svelte`,
                getFullText: () => ''
            }
        });

        const active = (plugin as any).collectDiagnosticsSingleFlight(
            synced('Active'),
            undefined,
            0
        );
        const pending = (plugin as any).collectDiagnosticsSingleFlight(
            synced('Pending'),
            undefined,
            0
        );
        await tick();
        assert.strictEqual(plugin.stats.projectChecks, 1);

        server.generation = 2;
        const latest = (plugin as any).collectDiagnosticsSingleFlight(
            synced('Latest'),
            undefined,
            0
        );
        assert.strictEqual(await active, null);
        assert.strictEqual(await pending, null);
        assert.strictEqual(plugin.stats.cancellations, 2);
        assert.strictEqual(plugin.stats.diagnosticSuperseded, 2);
        assert.strictEqual(plugin.stats.projectChecks, 1, 'the pending stale request reached tsgo');

        finishOld();
        assert.deepStrictEqual(await latest, []);
        assert.strictEqual(plugin.stats.projectChecks, 2);
        assert.strictEqual(calls.length, 2);
        assert.ok(calls[0].includes('Active'));
        assert.ok(calls[1].includes('Latest'));
    });

    it('drops a diagnostic result when the generation moves at delivery time', async () => {
        const server = {
            generation: 1,
            updateConfiguration: async () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: server as any
        });
        (plugin as any).collectDiagnostics = async () => {
            // Model a watcher/change continuation which runs after native response validation
            // but before the shared flight is delivered to its editor waiter.
            server.generation = 2;
            return [];
        };

        const result = await (plugin as any).collectDiagnosticsSingleFlight(
            {
                document: {},
                shadowPath: '/workspace/.overlay/Stale.svelte.tsx',
                projectKey: '/workspace/.overlay/tsconfig.json',
                snapshot: {}
            },
            undefined,
            0
        );

        assert.strictEqual(result, null);
    });

    it('returns the generation of the completed pull-diagnostic flight', async () => {
        const server = {
            generation: 1,
            updateConfiguration: async () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: server as any
        });
        (plugin as any).syncDocument = async () => ({
            document: {},
            shadowPath: '/workspace/.overlay/Current.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: {}
        });
        (plugin as any).collectDiagnosticsSingleFlight = async () => {
            // A second document changed after the optimistic result id was captured, then this
            // request joined the new generation's project flight.
            server.generation = 2;
            return [];
        };

        const report = await plugin.getDiagnosticsForPullMode({} as Document);

        assert.deepStrictEqual(report, { kind: 'full', resultId: 'g2', items: [] });
    });

    it('does no synchronization or child work for pre-cancelled feature requests', async () => {
        let synchronizations = 0;
        let childRequests = 0;
        let projectEnumerations = 0;
        let snapshotLookups = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                all: () => {
                    projectEnumerations++;
                    return [];
                },
                ensureSnapshot: () => {
                    snapshotLookups++;
                    return undefined;
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    childRequests++;
                    return null;
                }
            } as any
        });
        (plugin as any).syncDocument = async () => {
            synchronizations++;
            return null;
        };
        const cancellation = new CancellationTokenSource();
        cancellation.cancel();
        const document = {} as Document;
        const position = { line: 0, character: 0 };
        const range = { start: position, end: position };

        await plugin.getDefinitions(document, position, cancellation.token);
        await plugin.doHover(document, position, cancellation.token);
        await plugin.getCompletions(document, position, undefined, cancellation.token);
        await plugin.getSelectionRange(document, position, cancellation.token);
        await plugin.getSemanticTokens(document, undefined, cancellation.token);
        await plugin.getDocumentSymbols(document, cancellation.token);
        await plugin.getInlayHints(document, range, cancellation.token);
        await plugin.getFoldingRanges(document, cancellation.token);
        await plugin.getCodeActions(document, range, { diagnostics: [] }, cancellation.token);
        await plugin.getWorkspaceSymbols('', cancellation.token);
        await plugin.findComponentReferences(
            pathToUrl('/workspace/Component.svelte'),
            cancellation.token
        );
        await plugin.prepareCallHierarchy(document, position, cancellation.token);
        await plugin.getIncomingCalls(
            { uri: pathToUrl('/workspace/file.ts'), range, selectionRange: range } as any,
            cancellation.token
        );
        await plugin.getOutgoingCalls(
            { uri: pathToUrl('/workspace/file.ts'), range, selectionRange: range } as any,
            cancellation.token
        );
        await plugin.resolveCodeAction(document, {} as any, cancellation.token);
        await plugin.resolveCompletion(document, {} as any, cancellation.token);

        assert.strictEqual(synchronizations, 0);
        assert.strictEqual(childRequests, 0);
        assert.strictEqual(projectEnumerations, 0);
        assert.strictEqual(snapshotLookups, 0);
        cancellation.dispose();
    });

    it('does not map a requestAt response cancelled while the child is running', async () => {
        let finishChild!: (value: any) => void;
        const child = new Promise<any>((resolve) => (finishChild = resolve));
        let childToken: any;
        let mappingLookups = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                getOriginalPath: () => {
                    mappingLookups++;
                    return undefined;
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async (_method: string, _params: any, token: any) => {
                    childToken = token;
                    return child;
                }
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            document: {},
            shadowPath: '/workspace/.overlay/Current.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: { getGeneratedPosition: () => ({ line: 0, character: 0 }) }
        });
        const cancellation = new CancellationTokenSource();
        const pending = plugin.findReferences(
            {} as Document,
            { line: 0, character: 0 },
            { includeDeclaration: true },
            cancellation.token
        );
        await tick();
        cancellation.cancel();
        assert.strictEqual(childToken.isCancellationRequested, true);
        finishChild([
            {
                uri: pathToUrl('/workspace/target.ts'),
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 }
                }
            }
        ]);

        assert.strictEqual(await pending, null);
        assert.strictEqual(mappingLookups, 0);
        cancellation.dispose();
    });

    it('does not map a direct feature response cancelled while the child is running', async () => {
        let finishChild!: (value: any) => void;
        const child = new Promise<any>((resolve) => (finishChild = resolve));
        let mappingCalls = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => child
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            document: {},
            shadowPath: '/workspace/.overlay/Current.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: {
                getGeneratedPosition: () => ({ line: 0, character: 0 }),
                getOriginalPosition: () => {
                    mappingCalls++;
                    return { line: 0, character: 0 };
                }
            }
        });
        const cancellation = new CancellationTokenSource();
        const pending = plugin.doHover(
            {} as Document,
            { line: 0, character: 0 },
            cancellation.token
        );
        await tick();
        cancellation.cancel();
        finishChild({
            contents: 'stale',
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            }
        });

        assert.strictEqual(await pending, null);
        assert.strictEqual(mappingCalls, 0);
        cancellation.dispose();
    });

    it('stops location and workspace-edit mapping when cancellation arrives mid-loop', async () => {
        const cancellation = new CancellationTokenSource();
        let mappingLookups = 0;
        const projects = {
            getOriginalPath: () => {
                mappingLookups++;
                if (mappingLookups === 1) {
                    cancellation.cancel();
                }
                return undefined;
            }
        };
        const server: any = {
            generation: 1,
            updateConfiguration: async () => undefined,
            sendRequest: async (method: string) =>
                method === 'textDocument/references'
                    ? [
                          {
                              uri: pathToUrl('/workspace/one.ts'),
                              range: {
                                  start: { line: 0, character: 0 },
                                  end: { line: 0, character: 1 }
                              }
                          },
                          {
                              uri: pathToUrl('/workspace/two.ts'),
                              range: {
                                  start: { line: 0, character: 0 },
                                  end: { line: 0, character: 1 }
                              }
                          }
                      ]
                    : null
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: projects as any,
            server: server as any
        });
        (plugin as any).syncDocument = async () => ({
            document: {},
            shadowPath: '/workspace/.overlay/Current.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: { getGeneratedPosition: () => ({ line: 0, character: 0 }) }
        });

        const references = await plugin.findReferences(
            {} as Document,
            { line: 0, character: 0 },
            { includeDeclaration: true },
            cancellation.token
        );
        assert.deepStrictEqual(references, []);
        assert.strictEqual(mappingLookups, 1, 'location mapping continued after cancellation');

        cancellation.dispose();
        const editCancellation = new CancellationTokenSource();
        mappingLookups = 0;
        projects.getOriginalPath = () => {
            mappingLookups++;
            if (mappingLookups === 1) {
                editCancellation.cancel();
            }
            return undefined;
        };
        server.sendRequest = async () => ({
            changes: {
                [pathToUrl('/workspace/one.ts')]: [
                    {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 0 }
                        },
                        newText: 'one'
                    }
                ],
                [pathToUrl('/workspace/two.ts')]: [
                    {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 0 }
                        },
                        newText: 'two'
                    }
                ]
            }
        });
        const renamed = await plugin.rename(
            {} as Document,
            { line: 0, character: 0 },
            'renamed',
            editCancellation.token
        );
        assert.strictEqual(renamed, null);
        assert.strictEqual(
            mappingLookups,
            1,
            'workspace-edit mapping continued after cancellation'
        );
        editCancellation.dispose();
    });

    it('applies legacy incremental TS/JS updates against the open overlay text', async () => {
        let updatedText: string | undefined;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: {
                updateConfiguration: async () => undefined,
                isOpen: () => true,
                getOpenText: () => 'a😀c',
                updateDocument: async (_fileName: string, _changes: any[], text: string) => {
                    updatedText = text;
                }
            } as any
        });

        plugin.updateTsOrJsFile('/workspace/file.ts', [
            {
                range: {
                    start: { line: 0, character: 1 },
                    // LSP character offsets are UTF-16 code units, so the emoji occupies two.
                    end: { line: 0, character: 3 }
                },
                text: 'x'
            }
        ]);
        await tick();

        assert.strictEqual(updatedText, 'axc');
    });

    it('maps outgoing call ranges through the caller rather than the callee', async () => {
        const callerUri = pathToUrl('/workspace/Caller.svelte');
        const calleeUri = pathToUrl('/workspace/callee.ts');
        const callerSnapshot = {
            getGeneratedPosition: (position: any) => ({
                line: position.line + 10,
                character: position.character
            }),
            getOriginalPosition: (position: any) => ({
                line: position.line - 10,
                character: position.character
            })
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                ensureSnapshot: (fileName: string) =>
                    fileName === '/workspace/Caller.svelte' ? callerSnapshot : undefined,
                forFile: () => ({
                    getShadowPath: () => '/workspace/.cache/Caller.svelte.tsx'
                }),
                getOriginalPath: () => undefined
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async () => [
                    {
                        to: {
                            name: 'callee',
                            kind: 12,
                            uri: calleeUri,
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 6 }
                            },
                            selectionRange: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 6 }
                            }
                        },
                        fromRanges: [
                            {
                                start: { line: 12, character: 4 },
                                end: { line: 12, character: 10 }
                            }
                        ]
                    }
                ]
            } as any
        });

        const result = await plugin.getOutgoingCalls({
            name: 'caller',
            kind: 12,
            uri: callerUri,
            range: {
                start: { line: 1, character: 0 },
                end: { line: 3, character: 1 }
            },
            selectionRange: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 6 }
            }
        });

        assert.deepStrictEqual(result?.[0].fromRanges, [
            {
                start: { line: 2, character: 4 },
                end: { line: 2, character: 10 }
            }
        ]);
    });

    it('sends ordinary TypeScript call hierarchy items back without inventing a shadow', async () => {
        const item: CallHierarchyItem = {
            name: 'add',
            kind: 12,
            uri: pathToUrl('/workspace/math.ts'),
            range: {
                start: { line: 1, character: 0 },
                end: { line: 3, character: 1 }
            },
            selectionRange: {
                start: { line: 1, character: 16 },
                end: { line: 1, character: 19 }
            },
            data: { opaque: 'native-item' }
        };
        let requestedItem: unknown;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (entry) => new Document(entry.uri, entry.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                ensureSnapshot: () => {
                    throw new Error('TypeScript source must not be transformed as Svelte');
                },
                getOriginalPath: () => undefined
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async (_method: string, payload: any) => {
                    requestedItem = payload.item;
                    return [
                        {
                            from: {
                                name: 'caller',
                                kind: 12,
                                uri: pathToUrl('/workspace/caller.ts'),
                                range: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 0, character: 8 }
                                },
                                selectionRange: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 0, character: 6 }
                                }
                            },
                            fromRanges: [
                                {
                                    start: { line: 0, character: 7 },
                                    end: { line: 0, character: 10 }
                                }
                            ]
                        }
                    ];
                }
            } as any
        });

        const result = await plugin.getIncomingCalls(item);

        assert.deepStrictEqual(requestedItem, item);
        assert.strictEqual(result?.length, 1);
        assert.deepStrictEqual(result?.[0].fromRanges, [
            {
                start: { line: 0, character: 7 },
                end: { line: 0, character: 10 }
            }
        ]);
    });

    it('keeps folder renames real and maps only Svelte file renames to shadows', async () => {
        const requests: any[] = [];
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                forFile: (fileName: string) => ({
                    getShadowPath: () => `/shadow${fileName}.tsx`
                }),
                getOriginalPath: () => undefined,
                ensureSnapshot: () => undefined
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async (_method: string, payload: any) => {
                    requests.push(payload);
                    return null;
                }
            } as any
        });

        await plugin.updateImports({
            oldUri: pathToUrl('/workspace/old-folder'),
            newUri: pathToUrl('/workspace/new-folder')
        });
        await plugin.updateImports({
            oldUri: pathToUrl('/workspace/Old.svelte'),
            newUri: pathToUrl('/workspace/New.svelte')
        });

        assert.deepStrictEqual(requests[0].files, [
            {
                oldUri: pathToUrl('/workspace/old-folder'),
                newUri: pathToUrl('/workspace/new-folder')
            }
        ]);
        assert.deepStrictEqual(requests[1].files, [
            {
                oldUri: pathToUrl('/shadow/workspace/Old.svelte.tsx'),
                newUri: pathToUrl('/shadow/workspace/New.svelte.tsx')
            }
        ]);
    });
});
