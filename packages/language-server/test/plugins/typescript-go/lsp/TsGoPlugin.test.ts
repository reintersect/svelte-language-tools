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

        assert.deepStrictEqual(sent, ['generated:<p>saved</p>', 'generated:<p>dirty</p>']);
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

    it('keeps the first unopened source save incremental but rebuilds for config changes', async () => {
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
            getShadowPath: (fileName: string) => `${fileName}.tsx`,
            transform: (document: Document) => ({
                getFullText: () => `generated:${document.getText()}`
            }),
            writeShadow: () => undefined,
            deleteSnapshot: () => undefined,
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

            for (const fileName of sourceFiles) {
                plugin.onWatchFileChanges([{ fileName, changeType: 2 /* Changed */ }]);
                await (plugin as any).watchWork;
            }

            assert.strictEqual(invalidations, 0, 'ordinary saves must not clear managers');
            assert.strictEqual(restarts, 0, 'ordinary saves must not restart tsgo');

            plugin.onWatchFileChanges([{ fileName: tsconfig, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;
            plugin.onWatchFileChanges([{ fileName: packageJson, changeType: 2 /* Changed */ }]);
            await (plugin as any).watchWork;

            assert.strictEqual(invalidations, 2, 'config and package changes clear managers');
            assert.strictEqual(restarts, 2, 'config and package changes restart tsgo');
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

    it('invalidates transitions into computed-import and import.meta.glob reachability', () => {
        const leaf = sourceModuleGraphSignature('const value = 1;');
        const computed = sourceModuleGraphSignature('void import(`./${name}.svelte`);');
        const requireComputed = sourceModuleGraphSignature('require(componentName);');
        const glob = sourceModuleGraphSignature(
            'const components = import.meta.glob("./*.svelte");'
        );
        const literal = sourceModuleGraphSignature('void import("./Item.svelte");');
        const spacedLiteral = sourceModuleGraphSignature('void import(  "./Item.svelte");');

        assert.notStrictEqual(computed, leaf);
        assert.notStrictEqual(requireComputed, leaf);
        assert.notStrictEqual(glob, leaf);
        assert.strictEqual(spacedLiteral, literal, 'whitespace must not make a literal ambiguous');
        // Once reachability is already ambiguous, changing only the broad mechanism does not
        // require rebuilding the same complete-workspace fallback.
        assert.strictEqual(computed, requireComputed);
        assert.strictEqual(computed, glob);
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
        firstToken.dispose();
        secondToken.dispose();
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
