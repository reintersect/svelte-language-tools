import assert from 'assert';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
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
    isComponentAttributeNamePosition,
    isMemberAccessCompletion,
    nativeSvelteModuleSpecifierAt7016,
    sourceModuleGraphSignature,
    TsGoPlugin
} from '../../../../src/plugins/typescript-go/lsp/TsGoPlugin';
import { TsGoServer } from '../../../../src/plugins/typescript-go/lsp/TsGoServer';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function textOffsetAt(source: string, position: { line: number; character: number }): number {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
        const next = source.indexOf('\n', offset);
        if (next < 0) {
            throw new Error(`line ${position.line} is outside test source`);
        }
        offset = next + 1;
    }
    return offset + position.character;
}

function applyCompletionEdits(source: string, completion: any): string {
    const edits = [
        ...(completion.additionalTextEdits ?? []),
        ...(completion.textEdit ? [completion.textEdit] : [])
    ].map((edit: any) => ({ ...edit, range: edit.range ?? edit.replace }));
    const withOffsets = edits
        .map((edit: any) => ({
            ...edit,
            start: textOffsetAt(source, edit.range.start),
            end: textOffsetAt(source, edit.range.end)
        }))
        .sort((left: any, right: any) => right.start - left.start || right.end - left.end);
    let result = source;
    for (const edit of withOffsets) {
        result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    }
    return result;
}

function nativeCompletionOwner(document: Document, nativeGeneration?: number) {
    return {
        __tsgoCompletionOwner: {
            uri: document.uri,
            documentVersion: document.version,
            sourceFingerprint: createHash('sha256')
                .update(document.getText(), 'utf8')
                .digest('base64url'),
            nativeGeneration
        }
    };
}

describe('typescript-go TsGoPlugin helpers', () => {
    it('classifies real member completions without matching strings, comments or spread syntax', () => {
        for (const source of ['model.', 'model.va', 'model?.va']) {
            const text = `<script>${source}</script>`;
            const document = new Document(
                pathToUrl('/workspace/Component.svelte'),
                text,
                /*skipConfigLoading*/ true
            );
            const offset = text.indexOf('</script>');
            assert.strictEqual(isMemberAccessCompletion(document, text, offset), true, source);
        }
        for (const source of [
            '...',
            '...rest',
            '.',
            '1.',
            'const value = "model."',
            '// model.',
            '/* model. */',
            'const pattern = /model.va/;',
            'const pattern = /model.va/u;',
            'const pattern = /x[}]{1}model.va/;'
        ]) {
            const text = `<script>${source}</script>`;
            const document = new Document(
                pathToUrl('/workspace/Component.svelte'),
                text,
                /*skipConfigLoading*/ true
            );
            const lexicalCaret = source.includes('model.')
                ? text.indexOf('model.') + 'model.'.length
                : text.indexOf('</script>');
            assert.strictEqual(
                isMemberAccessCompletion(document, text, lexicalCaret),
                false,
                source
            );
        }
        const template = '<p>{model.va}</p>';
        const templateDocument = new Document(
            pathToUrl('/workspace/Component.svelte'),
            template,
            /*skipConfigLoading*/ true
        );
        assert.strictEqual(
            isMemberAccessCompletion(
                templateDocument,
                template,
                template.indexOf('model.va') + 'model.va'.length
            ),
            true
        );
        for (const rawMarkup of [
            '<div title="model.va"></div>',
            '<Button title="model.va" />',
            '<!-- model.va -->',
            '<!-- { model.va -->',
            '<div title=model.va></div>',
            '<p>{"{"}</p><div title="model.va"></div>'
        ]) {
            const document = new Document(
                pathToUrl('/workspace/Component.svelte'),
                rawMarkup,
                /*skipConfigLoading*/ true
            );
            const caret = rawMarkup.indexOf('model.va') + 'model.va'.length;
            assert.strictEqual(
                isMemberAccessCompletion(document, rawMarkup, caret),
                false,
                rawMarkup
            );
        }
        const nestedTemplate = '<p>{items.map((item) => ({ value: item.va }).value)}</p>';
        const nestedDocument = new Document(
            pathToUrl('/workspace/Component.svelte'),
            nestedTemplate,
            /*skipConfigLoading*/ true
        );
        assert.strictEqual(
            isMemberAccessCompletion(
                nestedDocument,
                nestedTemplate,
                nestedTemplate.indexOf('item.va') + 'item.va'.length
            ),
            true
        );
        const interpolatedAttribute = '<div title="prefix {model.va}"></div>';
        const interpolatedDocument = new Document(
            pathToUrl('/workspace/Component.svelte'),
            interpolatedAttribute,
            /*skipConfigLoading*/ true
        );
        assert.strictEqual(
            isMemberAccessCompletion(
                interpolatedDocument,
                interpolatedAttribute,
                interpolatedAttribute.indexOf('model.va') + 'model.va'.length
            ),
            true,
            'Svelte expressions inside quoted attributes still need member suggestions'
        );
    });

    it('gives component props only attribute-name positions, not attribute expressions', () => {
        const cases = [
            { text: '<Button |>', expected: true },
            { text: '<Button onSel|>', expected: true },
            { text: '<Button foo= |>', expected: false },
            { text: '<Button foo = |>', expected: false },
            { text: '<Button value={model.|}>', expected: false },
            { text: '<Button value="model.|">', expected: false },
            { text: '<Button {...model.|}>', expected: false },
            { text: '<Button value={model} |>', expected: true },
            { text: '<Button value="model" |>', expected: true },
            { text: '<Button value=model |>', expected: true },
            { text: '<Button /|>', expected: false },
            { text: '<But|>', expected: false }
        ];
        for (const testCase of cases) {
            const offset = testCase.text.indexOf('|');
            const text = testCase.text.replace('|', '');
            assert.strictEqual(
                isComponentAttributeNamePosition(
                    text,
                    { start: 0, tag: text.slice(1).match(/^\w+/)![0] },
                    offset
                ),
                testCase.expected,
                testCase.text
            );
        }
    });

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

    it('drops only the native LSP TS7016 for an owned generated JSX module', () => {
        const generated = [
            `import Button from './Button.svelte';`,
            `import plain from './plain.js';`,
            `const label = './Other.svelte';`
        ].join('\n');
        const sourceFile = ts.createSourceFile(
            'Component.svelte.jsx',
            generated,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.JSX
        );
        const span = (text: string) => ({ start: generated.indexOf(text), length: text.length });
        const svelteSpan = span(`'./Button.svelte'`);
        const jsSpan = span(`'./plain.js'`);
        const stringSpan = span(`'./Other.svelte'`);

        assert.strictEqual(
            nativeSvelteModuleSpecifierAt7016(
                sourceFile,
                svelteSpan.start,
                svelteSpan.length,
                7016
            ),
            './Button.svelte'
        );
        assert.strictEqual(
            nativeSvelteModuleSpecifierAt7016(sourceFile, jsSpan.start, jsSpan.length, 7016),
            undefined,
            'ordinary JavaScript imports must retain TS7016'
        );
        assert.strictEqual(
            nativeSvelteModuleSpecifierAt7016(
                sourceFile,
                stringSpan.start,
                stringSpan.length,
                7016
            ),
            undefined,
            'a coincidental .svelte string is not a module specifier'
        );

        const originalPath = '/workspace/Button.svelte';
        const shadowPath = '/workspace/node_modules/.cache/svelte-lsp/svelte/src/Button.svelte.jsx';
        const manager = {};
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                getOriginalPath: (filePath: string) =>
                    filePath === shadowPath ? originalPath : undefined
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                dispose: () => undefined
            } as any
        });
        (plugin as any).materializedShadowsBySource.set(
            originalPath,
            new Map([[manager, new Set([shadowPath])]])
        );
        const nativeMessage =
            `Could not find a declaration file for module './Button.svelte'. ` +
            `'${shadowPath}' implicitly has an 'any' type.`;

        assert.strictEqual(
            (plugin as any).isNativeOnlyMaterializedSvelteJs7016(
                sourceFile,
                svelteSpan.start,
                svelteSpan.length,
                7016,
                nativeMessage
            ),
            true
        );
        assert.strictEqual(
            (plugin as any).isNativeOnlyMaterializedSvelteJs7016(
                sourceFile,
                jsSpan.start,
                jsSpan.length,
                7016,
                `Could not find a declaration file for module './plain.js'. ` +
                    `'/workspace/node_modules/plain/index.js' implicitly has an 'any' type.`
            ),
            false
        );
        (plugin as any).materializedShadowsBySource.clear();
        assert.strictEqual(
            (plugin as any).isNativeOnlyMaterializedSvelteJs7016(
                sourceFile,
                svelteSpan.start,
                svelteSpan.length,
                7016,
                nativeMessage
            ),
            false,
            'a stale or foreign generated file must retain TS7016'
        );
        plugin.dispose();
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

    it('deduplicates Svelte 5 component definitions which map to one source anchor', async () => {
        const sourceRange = {
            start: { line: 0, character: 1 },
            end: { line: 0, character: 1 }
        };
        const generatedRange = {
            start: { line: 4, character: 10 },
            end: { line: 4, character: 34 }
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined } as any
        });
        (plugin as any).requestAt = async () => ({
            result: [
                {
                    targetUri: 'file:///workspace/Child.svelte.tsx',
                    targetSelectionRange: generatedRange
                },
                {
                    targetUri: 'file:///workspace/Child.svelte.tsx',
                    targetSelectionRange: generatedRange
                }
            ],
            snapshot: {}
        });
        (plugin as any).mapDefinitionTarget = () => ({
            uri: 'file:///workspace/Child.svelte',
            range: sourceRange
        });

        const definitions = await plugin.getDefinitions({} as Document, { line: 0, character: 1 });

        assert.deepStrictEqual(definitions, [
            {
                targetUri: 'file:///workspace/Child.svelte',
                targetRange: sourceRange,
                targetSelectionRange: sourceRange,
                originSelectionRange: undefined
            }
        ]);
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

    it('preserves list-time mapped completion edits through native resolve', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>\nconst answer = targ;\n</script>',
            /*skipConfigLoading*/ true
        );
        const position = document.positionAt(document.getText().indexOf('targ') + 4);
        const textRange = {
            start: document.positionAt(document.getText().indexOf('targ')),
            end: position
        };
        const importPosition = { line: 1, character: 0 };
        const snapshot = {
            scriptInfo: document.scriptInfo,
            moduleScriptInfo: document.moduleScriptInfo,
            svelteNodeAt: () => undefined,
            getGeneratedPosition: () => ({ line: 30, character: 0 }),
            getOriginalPosition: (generated: { line: number; character: number }) => {
                if (generated.line === 20) {
                    return generated.character === 0 ? textRange.start : textRange.end;
                }
                if (generated.line === 21) {
                    return importPosition;
                }
                return { line: -1, character: -1 };
            }
        };
        let resolvePayload: any;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: { ensureSnapshot: () => snapshot } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async (method: string, payload: any) => {
                    if (method === 'textDocument/completion') {
                        return {
                            isIncomplete: false,
                            items: [
                                {
                                    label: 'target',
                                    data: { native: 'target' },
                                    textEdit: {
                                        range: {
                                            start: { line: 20, character: 0 },
                                            end: { line: 20, character: 4 }
                                        },
                                        newText: 'target'
                                    },
                                    additionalTextEdits: [
                                        {
                                            range: {
                                                start: { line: 21, character: 0 },
                                                end: { line: 21, character: 0 }
                                            },
                                            newText: 'import { helper } from "./helper";\n'
                                        }
                                    ]
                                }
                            ]
                        };
                    }
                    resolvePayload = payload;
                    return { documentation: { kind: 'markdown', value: 'resolved' } };
                }
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            shadowPath: '/workspace/.overlay/Component.svelte.tsx',
            snapshot
        });

        const listed = await plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });
        const item = listed!.items[0];
        assert.deepStrictEqual((item.textEdit as any).range, textRange);
        assert.deepStrictEqual(item.additionalTextEdits, [
            {
                range: { start: importPosition, end: importPosition },
                newText: 'import { helper } from "./helper";\n'
            }
        ]);

        const resolved = await plugin.resolveCompletion(document, item);
        assert.strictEqual(resolvePayload.data.native, 'target');
        assert.strictEqual(resolvePayload.textEdit, undefined);
        assert.strictEqual(resolvePayload.additionalTextEdits, undefined);
        assert.deepStrictEqual(resolved.textEdit, item.textEdit);
        assert.deepStrictEqual(resolved.additionalTextEdits, item.additionalTextEdits);
        assert.strictEqual((resolved.documentation as any).value, 'resolved');
    });

    it('does not map completion resolve edits after the source changes', async () => {
        const uri = pathToUrl('/workspace/StaleCompletion.svelte');
        const documents = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const document = documents.openClientDocument({
            uri,
            text: '<script>const answer = targ;</script>'
        });
        const position = document.positionAt(document.getText().indexOf('targ') + 4);
        const resolveNative = deferred<any>();
        let resolveStarted = false;
        let outputMappings = 0;
        const snapshot = {
            scriptInfo: document.scriptInfo,
            moduleScriptInfo: document.moduleScriptInfo,
            svelteNodeAt: () => undefined,
            getGeneratedPosition: () => ({ line: 20, character: 4 }),
            getOriginalPosition: (generated: { line: number; character: number }) => {
                outputMappings++;
                return generated;
            }
        };
        const plugin = new TsGoPlugin({
            docManager: documents,
            backgroundSyncDelayMs: 60_000,
            projects: {
                ensureSnapshot: () => snapshot
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async (method: string) => {
                    if (method === 'textDocument/completion') {
                        return { items: [{ label: 'target', data: { native: true } }] };
                    }
                    resolveStarted = true;
                    return resolveNative.promise;
                },
                dispose: () => undefined
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            document,
            shadowPath: '/workspace/.overlay/StaleCompletion.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot
        });

        const listed = await plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });
        const item = listed!.items[0];
        const pending = plugin.resolveCompletion(document, item);
        await tick();
        assert.strictEqual(resolveStarted, true);
        documents.updateDocument({ uri, version: 2 }, [
            { text: '<script>const changed = target;</script>' }
        ]);
        resolveNative.resolve({
            textEdit: {
                range: {
                    start: { line: 20, character: 0 },
                    end: { line: 20, character: 4 }
                },
                newText: 'target'
            },
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    newText: 'import { target } from "./target";\n'
                }
            ]
        });

        assert.strictEqual(await pending, item);
        assert.strictEqual(outputMappings, 0, 'stale resolve reached generated edit mapping');
        plugin.dispose();
    });

    it('does not map completion resolve edits after a native restart', async () => {
        const document = new Document(
            pathToUrl('/workspace/RestartedCompletion.svelte'),
            '<script>const answer = targ;</script>',
            /*skipConfigLoading*/ true
        );
        const position = document.positionAt(document.getText().indexOf('targ') + 4);
        const resolveNative = deferred<any>();
        let resolveStarted = false;
        let outputMappings = 0;
        const snapshot = {
            scriptInfo: document.scriptInfo,
            moduleScriptInfo: document.moduleScriptInfo,
            svelteNodeAt: () => undefined,
            getGeneratedPosition: () => ({ line: 20, character: 4 }),
            getOriginalPosition: (position: any) => {
                outputMappings++;
                return position;
            }
        };
        const server = {
            generation: 1,
            updateConfiguration: async () => undefined,
            sendRequest: async (method: string) => {
                if (method === 'textDocument/completion') {
                    return { items: [{ label: 'target', data: { native: true } }] };
                }
                resolveStarted = true;
                return resolveNative.promise;
            },
            dispose: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: { ensureSnapshot: () => snapshot } as any,
            server: server as any
        });
        (plugin as any).syncDocument = async () => ({
            document,
            shadowPath: '/workspace/.overlay/RestartedCompletion.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot
        });

        const listed = await plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });
        const item = listed!.items[0];
        const pending = plugin.resolveCompletion(document, item);
        await tick();
        assert.strictEqual(resolveStarted, true);
        server.generation++;
        resolveNative.resolve({
            textEdit: {
                range: {
                    start: { line: 20, character: 0 },
                    end: { line: 20, character: 4 }
                },
                newText: 'target'
            }
        });

        assert.strictEqual(await pending, item);
        assert.strictEqual(outputMappings, 0);
        plugin.dispose();
    });

    it('maps resolved auto-import and replacement edits into an existing script', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>\nconst store = writ;\n</script>',
            /*skipConfigLoading*/ true
        );
        const wordStart = document.getText().indexOf('writ');
        const triggerPosition = document.positionAt(wordStart + 4);
        const snapshot = {
            scriptInfo: document.scriptInfo,
            moduleScriptInfo: document.moduleScriptInfo,
            getOriginalPosition: (generated: { line: number; character: number }) => {
                if (generated.line === 20) {
                    return document.positionAt(wordStart + generated.character);
                }
                return { line: -1, character: -1 };
            }
        };
        let resolvePayload: any;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: { ensureSnapshot: () => snapshot } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async (_method: string, payload: any) => {
                    resolvePayload = payload;
                    return {
                        textEdit: {
                            range: {
                                start: { line: 20, character: 0 },
                                end: { line: 20, character: 4 }
                            },
                            newText: 'writable'
                        },
                        additionalTextEdits: [
                            {
                                range: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 0, character: 0 }
                                },
                                newText: 'import { writable } from "svelte/store";\n\n'
                            }
                        ]
                    };
                }
            } as any
        });

        const resolved = await plugin.resolveCompletion(document, {
            label: 'writable',
            data: {
                uri: document.uri,
                __tsgoData: { native: 'writable' },
                __tsgoCompletionPosition: triggerPosition,
                ...nativeCompletionOwner(document)
            }
        });

        assert.deepStrictEqual(resolvePayload.data, { native: 'writable' });
        assert.strictEqual(resolvePayload.textEdit, undefined);
        const applied = applyCompletionEdits(document.getText(), resolved);
        assert.strictEqual(
            applied,
            '<script>\nimport { writable } from "svelte/store";\n\nconst store = writable;\n</script>'
        );
    });

    it('creates the configured script for a resolved template component auto-import', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<But />',
            /*skipConfigLoading*/ true
        );
        const configManager = new LSConfigManager();
        configManager.update({ svelte: { defaultScriptLanguage: 'ts' } });
        const triggerPosition = document.positionAt('<But'.length);
        const snapshot = {
            scriptInfo: document.scriptInfo,
            moduleScriptInfo: document.moduleScriptInfo,
            getOriginalPosition: (generated: { line: number; character: number }) => {
                if (generated.line === 20) {
                    return { line: 0, character: generated.character + 1 };
                }
                return { line: -1, character: -1 };
            }
        };
        const plugin = new TsGoPlugin({
            configManager,
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: { ensureSnapshot: () => snapshot } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async () => ({
                    textEdit: {
                        range: {
                            start: { line: 20, character: 0 },
                            end: { line: 20, character: 3 }
                        },
                        newText: 'Button__SvelteComponent_'
                    },
                    additionalTextEdits: [
                        {
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 0 }
                            },
                            newText:
                                'import type Button__SvelteComponent_ from "./Button.svelte";\n\n'
                        }
                    ]
                })
            } as any
        });

        const resolved = await plugin.resolveCompletion(document, {
            label: 'Button',
            data: {
                uri: document.uri,
                __tsgoData: { native: 'Button' },
                __tsgoCompletionPosition: triggerPosition,
                ...nativeCompletionOwner(document)
            }
        });
        const applied = applyCompletionEdits(document.getText(), resolved);

        assert.strictEqual(
            applied,
            '<script lang="ts">\nimport Button from "./Button.svelte";\n\n</script>\n<Button />'
        );
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

    it('releases document and configuration subscriptions exactly once on dispose', async () => {
        const uri = pathToUrl('/workspace/Disposed.svelte');
        const documents = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const configManager = new LSConfigManager();
        let restarts = 0;
        let serverDisposals = 0;
        let scheduledSynchronizations = 0;
        const plugin = new TsGoPlugin({
            configManager,
            docManager: documents,
            projects: {} as any,
            server: {
                processId: 123,
                restart: async () => void restarts++,
                updateConfiguration: async () => undefined,
                dispose: () => void serverDisposals++
            } as any
        });
        (plugin as any).scheduleBackgroundSvelteSync = () => scheduledSynchronizations++;

        plugin.dispose();
        plugin.dispose();
        const document = documents.openClientDocument({ uri, text: '<p>one</p>' });
        documents.updateDocument({ uri, version: 2 }, [{ text: '<p>two</p>' }]);
        documents.closeDocument(document.uri);
        configManager.updateTsJsUserPreferences({
            typescript: { inlayHints: { parameterNames: { enabled: 'all' } } }
        } as any);
        await tick();
        await (plugin as any).configurationWork;

        assert.strictEqual(scheduledSynchronizations, 0);
        assert.strictEqual(restarts, 0);
        assert.strictEqual(serverDisposals, 1);
        assert.deepStrictEqual((plugin as any).subscriptions, []);
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

    it('drops code-action responses when the document changes without cancellation', async () => {
        const fetchNative = deferred<any[]>();
        const fetchUri = pathToUrl('/workspace/CodeActionFetch.svelte');
        const fetchDocuments = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let fetchStarted = false;
        const fetchPlugin = new TsGoPlugin({
            docManager: fetchDocuments,
            projects: {} as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    fetchStarted = true;
                    return fetchNative.promise;
                },
                dispose: () => undefined
            } as any
        });
        (fetchPlugin as any).syncDocument = async (document: Document) => ({
            document,
            shadowPath: '/workspace/.overlay/CodeActionFetch.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: { getGeneratedPosition: (position: any) => position }
        });
        const fetchDocument = fetchDocuments.openClientDocument({
            uri: fetchUri,
            text: '<script>const value = missing;</script>'
        });
        const range = {
            start: { line: 0, character: 22 },
            end: { line: 0, character: 29 }
        };

        const pendingFetch = fetchPlugin.getCodeActions(fetchDocument, range, {
            diagnostics: []
        });
        await tick();
        assert.strictEqual(fetchStarted, true);
        fetchDocuments.updateDocument({ uri: fetchUri, version: 2 }, [
            { text: '<script>const value = fixed;</script>' }
        ]);
        fetchNative.resolve([{ title: 'Stale fix', data: { fixId: 'stale' } }]);
        assert.deepStrictEqual(await pendingFetch, []);
        fetchPlugin.dispose();

        const resolveNative = deferred<any>();
        const resolveUri = pathToUrl('/workspace/CodeActionResolve.svelte');
        const resolveDocuments = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let resolveStarted = false;
        const resolvePlugin = new TsGoPlugin({
            docManager: resolveDocuments,
            projects: {} as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    resolveStarted = true;
                    return resolveNative.promise;
                },
                dispose: () => undefined
            } as any
        });
        const resolveDocument = resolveDocuments.openClientDocument({
            uri: resolveUri,
            text: '<script>const value = missing;</script>'
        });
        const staleAction = {
            title: 'Resolve me',
            data: { uri: resolveUri, __tsgoData: { fixId: 'stale' } }
        } as any;

        const pendingResolve = resolvePlugin.resolveCodeAction(resolveDocument, staleAction);
        await tick();
        assert.strictEqual(resolveStarted, true);
        resolveDocuments.updateDocument({ uri: resolveUri, version: 2 }, [
            { text: '<script>const value = fixed;</script>' }
        ]);
        resolveNative.resolve({ title: 'Stale resolved fix' });
        assert.strictEqual(await pendingResolve, staleAction);
        resolvePlugin.dispose();
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

    it('does not synchronise quoted markup or comments for invoked completion', async () => {
        for (const source of [
            '<div title="foo|"></div>',
            '<div class="foo|"></div>',
            '<div title=foo|></div>',
            '<!-- foo| -->'
        ]) {
            const plugin = new TsGoPlugin({
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                ),
                projects: {} as any,
                server: { updateConfiguration: async () => undefined } as any
            });
            let syncs = 0;
            (plugin as any).syncDocument = async () => {
                syncs++;
                return null;
            };
            const offset = source.indexOf('|');
            const text = source.replace('|', '');
            const document = new Document(
                pathToUrl('/workspace/Component.svelte'),
                text,
                /*skipConfigLoading*/ true
            );

            assert.strictEqual(
                await plugin.getCompletions(document, document.positionAt(offset), {
                    triggerKind: CompletionTriggerKind.Invoked
                }),
                null
            );
            assert.strictEqual(syncs, 0, source);
        }
    });

    it('does not mistake comparison or arrow syntax for plain template markup', async () => {
        for (const testCase of [
            { text: '<p>{foo > ba}</p>', caret: 'ba}' },
            { text: '<p>{items.map((item) => item.va)}</p>', caret: 'va)' },
            { text: '<div title="prefix {model.va}"></div>', caret: 'va}' }
        ]) {
            const plugin = new TsGoPlugin({
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                ),
                projects: {} as any,
                server: { updateConfiguration: async () => undefined } as any
            });
            let syncs = 0;
            (plugin as any).syncDocument = async () => {
                syncs++;
                return null;
            };
            const document = new Document(
                pathToUrl('/workspace/Component.svelte'),
                testCase.text,
                /*skipConfigLoading*/ true
            );
            const caret = testCase.text.indexOf(testCase.caret) + 2;

            assert.strictEqual(
                await plugin.getCompletions(document, document.positionAt(caret), {
                    triggerKind: CompletionTriggerKind.Invoked
                }),
                null
            );
            assert.strictEqual(syncs, 1, testCase.text);
        }
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

    it('serves member completions through the attached checker without an LSP request', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>const model = { value: 1 }; model.va</script>',
            /*skipConfigLoading*/ true
        );
        const position = document.positionAt(document.getText().indexOf('model.va') + 8);
        let apiOffset: number | undefined;
        const nativeMethods: string[] = [];
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            apiSession: {
                available: true,
                getCompletionsAtPosition: async (_fileName: string, offset: number) => {
                    apiOffset = offset;
                    return {
                        isIncomplete: false,
                        entries: [
                            {
                                name: 'value',
                                kind: 10,
                                sortText: '11',
                                detail: '(property) value: number'
                            }
                        ]
                    };
                }
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async (method: string) => {
                    nativeMethods.push(method);
                    if (method === 'textDocument/completion') {
                        return {
                            isIncomplete: false,
                            items: [
                                {
                                    label: 'value',
                                    kind: 10,
                                    sortText: '11',
                                    data: { native: true }
                                }
                            ]
                        };
                    }
                    if (method === 'completionItem/resolve') {
                        return {
                            label: 'value',
                            kind: 10,
                            documentation: { kind: 'markdown', value: 'Resolved docs' }
                        };
                    }
                    throw new Error(`unexpected native request: ${method}`);
                }
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            shadowPath: '/workspace/.overlay/Component.svelte.tsx',
            snapshot: {
                scriptInfo: document.scriptInfo,
                moduleScriptInfo: document.moduleScriptInfo,
                svelteNodeAt: () => undefined,
                getGeneratedPosition: () => position,
                offsetAt: () => 42
            }
        });

        const result = await plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });

        assert.strictEqual(apiOffset, 42);
        assert.deepStrictEqual(
            result?.items.map((item) => item.label),
            ['value']
        );
        assert.deepStrictEqual(result?.items[0].commitCharacters, ['.', ',', ';', '(']);
        assert.strictEqual(plugin.stats.completionApiHits, 1);
        assert.deepStrictEqual(nativeMethods, []);
        const resolved = await plugin.resolveCompletion(document, result!.items[0]);
        assert.strictEqual(resolved.detail, '(property) value: number');
        assert.deepStrictEqual(nativeMethods, []);
    });

    it('drops checker member completions when another file advances the native generation', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>const model = { value: 1 }; model.va</script>',
            /*skipConfigLoading*/ true
        );
        const position = document.positionAt(document.getText().indexOf('model.va') + 8);
        const checkerStarted = deferred<void>();
        const checkerResult = deferred<any>();
        let generation = 1;
        let nativeRequests = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            apiSession: {
                available: true,
                getCompletionsAtPosition: async () => {
                    checkerStarted.resolve();
                    return checkerResult.promise;
                }
            } as any,
            server: {
                get generation() {
                    return generation;
                },
                updateConfiguration: async () => undefined,
                dispose: () => undefined,
                sendRequest: async () => {
                    nativeRequests++;
                    return { isIncomplete: false, items: [{ label: 'new-generation' }] };
                }
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            shadowPath: '/workspace/.overlay/Component.svelte.tsx',
            snapshot: {
                scriptInfo: document.scriptInfo,
                moduleScriptInfo: document.moduleScriptInfo,
                svelteNodeAt: () => undefined,
                getGeneratedPosition: () => position,
                offsetAt: () => 42
            }
        });

        const pending = plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });
        await checkerStarted.promise;
        // Models an imported TS/Svelte edit: the requesting buffer is unchanged, but its member
        // type can have changed and the leased checker snapshot is no longer authoritative.
        generation = 2;
        checkerResult.resolve({
            isIncomplete: false,
            entries: [{ name: 'value', kind: 10, sortText: '11' }],
            timings: { projectMs: 1, checkerMs: 1 }
        });

        assert.strictEqual(await pending, null);
        assert.strictEqual(nativeRequests, 0, 'must not continue with the old mapped snapshot');
        assert.strictEqual(plugin.stats.completionApiHits, 0);
        plugin.dispose();
    });

    it('falls back to LSP when the checker has no member completions', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<script>value.missing</script>',
            /*skipConfigLoading*/ true
        );
        const position = document.positionAt(document.getText().indexOf('missing') + 7);
        let nativeRequests = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            apiSession: {
                available: true,
                getCompletionsAtPosition: async () => ({ isIncomplete: false, entries: [] })
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    nativeRequests++;
                    return { isIncomplete: false, items: [{ label: 'fallback' }] };
                }
            } as any
        });
        (plugin as any).syncDocument = async () => ({
            shadowPath: '/workspace/.overlay/Component.svelte.tsx',
            snapshot: {
                scriptInfo: document.scriptInfo,
                moduleScriptInfo: document.moduleScriptInfo,
                svelteNodeAt: () => undefined,
                getGeneratedPosition: () => position,
                offsetAt: () => 42
            }
        });

        const result = await plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });

        assert.deepStrictEqual(
            result?.items.map((item) => item.label),
            ['fallback']
        );
        assert.strictEqual(plugin.stats.completionApiFallbacks, 1);
        assert.strictEqual(nativeRequests, 1);
    });

    it('filters huge component globals only at attribute-name whitespace', async () => {
        const cases = [
            { text: '<But>', caret: '<But'.length, filtered: false },
            {
                text: '<Unknown value={glob}>',
                caret: '<Unknown value={glob'.length,
                filtered: false
            },
            { text: '<Unknown  >', caret: '<Unknown '.length, filtered: true }
        ];
        for (const testCase of cases) {
            const document = new Document(
                pathToUrl('/workspace/Component.svelte'),
                testCase.text,
                /*skipConfigLoading*/ true
            );
            const position = document.positionAt(testCase.caret);
            const plugin = new TsGoPlugin({
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                ),
                projects: {} as any,
                componentInfo: { getProps: async () => [] } as any,
                server: {
                    updateConfiguration: async () => undefined,
                    sendRequest: async () => ({
                        isIncomplete: false,
                        items: Array.from({ length: 501 }, (_, index) => ({
                            label: `global${index}`,
                            kind: 3
                        }))
                    })
                } as any
            });
            (plugin as any).componentOffsetAt = () => ({ offset: 1, tag: 'Unknown' });
            (plugin as any).syncDocument = async () => ({
                shadowPath: '/workspace/.overlay/Component.svelte.tsx',
                snapshot: {
                    svelteNodeAt: () => ({ type: 'InlineComponent' }),
                    getGeneratedPosition: () => position,
                    offsetAt: () => 1
                }
            });

            const result = await plugin.getCompletions(document, position, {
                triggerKind: CompletionTriggerKind.Invoked
            });
            assert.strictEqual(
                result === null,
                testCase.filtered,
                `unexpected filtering for ${testCase.text}`
            );
        }
    });

    it('holds background work until every concurrent completion lease releases', async () => {
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: { updateConfiguration: async () => undefined, dispose: () => undefined } as any
        });
        const releaseFirst = plugin.acquireCompletionPriority();
        const releaseSecond = plugin.acquireCompletionPriority();
        let permitted = false;
        const waiting = (plugin as any).awaitBackgroundPermit().then(() => void (permitted = true));

        await tick();
        assert.strictEqual(permitted, false);
        releaseFirst();
        await tick();
        assert.strictEqual(permitted, false);
        releaseSecond();
        await waiting;
        assert.strictEqual(permitted, true);
        plugin.dispose();
    });

    it('lets completion priority preempt a newly dirty first overlay', async () => {
        const uri = pathToUrl('/workspace/DirtyPriority.svelte');
        const filePath = '/workspace/DirtyPriority.svelte';
        const documents = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let synchronizations = 0;
        const plugin = new TsGoPlugin({
            docManager: documents,
            backgroundSyncDelayMs: 60_000,
            projects: {} as any,
            server: {
                updateConfiguration: async () => undefined,
                dispose: () => undefined
            } as any
        });
        (plugin as any).syncDocumentNow = async () => {
            synchronizations++;
            return null;
        };

        const document = documents.openClientDocument({ uri, text: '<p>saved</p>' });
        documents.updateDocument({ uri, version: 2 }, [{ text: '<p>dirty</p>' }]);
        const release = plugin.acquireCompletionPriority(document);
        await tick();
        await tick();
        assert.strictEqual(synchronizations, 0, 'dirty overlay overtook foreground completion');

        release();
        await (plugin as any).svelteLifecycle.get(filePath);
        assert.strictEqual(synchronizations, 1);
        plugin.dispose();
    });

    it('lets an immediate completion outrun delayed first-project synchronization', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const plugin = new TsGoPlugin({
            docManager,
            backgroundSyncDelayMs: 10,
            projects: {} as any,
            server: { updateConfiguration: async () => undefined, dispose: () => undefined } as any
        });
        let syncs = 0;
        (plugin as any).syncDocument = async () => {
            syncs++;
            return null;
        };

        const document = docManager.openClientDocument({ uri, text: '<p>{model.va}</p>' });
        const release = plugin.acquireCompletionPriority(document);
        await wait(25);
        assert.strictEqual(syncs, 0, 'didOpen graph work overtook the completion');
        release();
        await wait(10);
        assert.strictEqual(syncs, 1);
        plugin.dispose();
    });

    it('cancels a delayed first-project synchronization when the document closes', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const plugin = new TsGoPlugin({
            docManager,
            backgroundSyncDelayMs: 10,
            projects: {} as any,
            server: {
                updateConfiguration: async () => undefined,
                closeDocument: async () => undefined,
                dispose: () => undefined
            } as any
        });
        let syncs = 0;
        (plugin as any).syncDocument = async () => {
            syncs++;
            return null;
        };

        docManager.openClientDocument({ uri, text: '<p />' });
        docManager.closeDocument(uri);
        await wait(25);
        assert.strictEqual(syncs, 0);
        plugin.dispose();
    });

    it('pauses a materialization pass at its next time-budget yield for completion', async () => {
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const plugin = new TsGoPlugin({
            docManager,
            projects: {} as any,
            server: { updateConfiguration: async () => undefined, dispose: () => undefined } as any
        });
        let release!: () => void;
        let freshnessChecks = 0;
        const manager = {
            sourceRoot: '/workspace',
            findProjectSvelteFiles: () => ['/workspace/First.svelte', '/workspace/Second.svelte'],
            findDependencySvelteFiles: () => [],
            getShadowPath: (filePath: string) => `${filePath}.tsx`,
            isShadowFresh: () => {
                freshnessChecks++;
                if (freshnessChecks === 1) {
                    release = plugin.acquireCompletionPriority();
                }
                return true;
            },
            deleteSnapshot: () => undefined,
            pruneOrphanedShadows: () => undefined,
            commitFingerprints: () => undefined
        };
        let settled = false;
        const materializing = (plugin as any)
            .materializeProject(manager, () => undefined)
            .finally(() => void (settled = true));

        await tick();
        await tick();
        assert.strictEqual(freshnessChecks, 1);
        assert.strictEqual(settled, false);
        release();
        await materializing;
        assert.strictEqual(freshnessChecks, 2);
        plugin.dispose();
    });

    it('coalesces eager and feature sync for the same Svelte buffer revision', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let releaseProject!: () => void;
        const projectReady = new Promise<void>((resolve) => (releaseProject = resolve));
        let transforms = 0;
        let openText: string | undefined;
        const shadows = {
            overlayTsconfigPath: '/workspace/.overlay/tsconfig.json',
            getShadowPath: () => shadowPath,
            transform: (current: Document) => {
                transforms++;
                return { getFullText: () => `generated:${current.getText()}` };
            },
            ensureShadowDirectory: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager,
            backgroundSyncDelayMs: 0,
            projects: { forFile: () => shadows } as any,
            server: {
                updateConfiguration: async () => undefined,
                getOpenText: () => openText,
                isOpen: () => openText !== undefined,
                openDocument: async (_fileName: string, text: string) => void (openText = text),
                updateDocument: async (_fileName: string, _changes: any, text: string) =>
                    void (openText = text)
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => projectReady;

        const document = docManager.openClientDocument({ uri, text: '<p>{value}</p>' });
        const featureSync = (plugin as any).syncDocument(document);
        releaseProject();
        await featureSync;
        await (plugin as any).svelteLifecycle.get('/workspace/Component.svelte');
        await (plugin as any).syncDocument(document);

        assert.strictEqual(transforms, 1);
        assert.ok(plugin.stats.syncCoalesced >= 1);
        assert.ok(plugin.stats.syncReused >= 1);
    });

    it('warms the checker only after the first pull response has reached an idle turn', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const filePath = '/workspace/Component.svelte';
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let openText: string | undefined;
        let warmCalls = 0;
        let releaseWarm!: () => void;
        const warmBlocked = new Promise<void>((resolve) => (releaseWarm = resolve));
        let diagnosticsStarted!: () => void;
        const diagnosticRunning = new Promise<void>((resolve) => (diagnosticsStarted = resolve));
        let releaseDiagnostics!: () => void;
        const diagnosticsBlocked = new Promise<void>((resolve) => (releaseDiagnostics = resolve));
        const shadows = {
            overlayTsconfigPath: '/workspace/.overlay/tsconfig.json',
            getShadowPath: () => shadowPath,
            transform: (current: Document) => ({
                getFullText: () => `generated:${current.getText()}`
            }),
            ensureShadowDirectory: () => undefined,
            pinSnapshot: () => undefined,
            unpinSnapshot: () => undefined,
            deleteSnapshot: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager,
            backgroundSyncDelayMs: 0,
            projects: { forFile: () => shadows } as any,
            apiSession: {
                available: true,
                warmProjectForFile: async (fileName: string) => {
                    assert.strictEqual(fileName, shadowPath);
                    warmCalls++;
                    await warmBlocked;
                    return true;
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                getOpenText: () => openText,
                isOpen: () => openText !== undefined,
                openDocument: async (_fileName: string, value: string) => void (openText = value),
                updateDocument: async (_fileName: string, _changes: any, value: string) =>
                    void (openText = value),
                closeDocument: async () => void (openText = undefined)
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => undefined;
        (plugin as any).collectDiagnosticsSingleFlight = async () => {
            diagnosticsStarted();
            await diagnosticsBlocked;
            return [];
        };

        const document = docManager.openClientDocument({ uri, text: '<p>{value}</p>' });
        await (plugin as any).svelteLifecycle.get(filePath);
        await tick();
        assert.strictEqual(warmCalls, 0, 'didOpen started checker API warmup');

        const firstPull = plugin.getDiagnosticsForPullMode(document);
        await diagnosticRunning;
        assert.strictEqual(warmCalls, 0, 'checker API warmup contended with first diagnostics');
        releaseDiagnostics();
        assert.deepStrictEqual(await firstPull, { kind: 'full', resultId: 'g1', items: [] });
        assert.strictEqual(
            warmCalls,
            0,
            'checker API warmup ran before the pull response returned'
        );
        await tick();
        assert.strictEqual(warmCalls, 1, 'post-response idle did not warm the checker API');

        docManager.closeDocument(uri);
        await (plugin as any).svelteLifecycle.get(filePath);
        assert.strictEqual(openText, undefined, 'close waited for the background checker warmup');

        const reopened = docManager.openClientDocument({ uri, text: '<p>{next}</p>' });
        await (plugin as any).svelteLifecycle.get(filePath);
        await plugin.getDiagnosticsForPullMode(reopened);
        await tick();
        assert.strictEqual(warmCalls, 1, 'same project was warmed more than once');
        releaseWarm();
        await tick();
    });

    it('does not start a stale checker warmup after the document closes', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const filePath = '/workspace/Component.svelte';
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let openText: string | undefined;
        let warmCalls = 0;
        const shadows = {
            overlayTsconfigPath: '/workspace/.overlay/tsconfig.json',
            getShadowPath: () => shadowPath,
            transform: (current: Document) => ({
                getFullText: () => `generated:${current.getText()}`
            }),
            ensureShadowDirectory: () => undefined,
            unpinSnapshot: () => undefined,
            deleteSnapshot: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager,
            backgroundSyncDelayMs: 0,
            projects: { forFile: () => shadows } as any,
            apiSession: {
                available: true,
                warmProjectForFile: async () => {
                    warmCalls++;
                    return true;
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                getOpenText: () => openText,
                isOpen: () => openText !== undefined,
                openDocument: async (_fileName: string, value: string) => void (openText = value),
                updateDocument: async (_fileName: string, _changes: any, value: string) =>
                    void (openText = value),
                closeDocument: async () => void (openText = undefined)
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => undefined;
        (plugin as any).collectDiagnosticsSingleFlight = async () => [];

        const document = docManager.openClientDocument({ uri, text: '<p>{value}</p>' });
        await (plugin as any).svelteLifecycle.get(filePath);
        await plugin.getDiagnosticsForPullMode(document);
        assert.strictEqual(warmCalls, 0, 'warmup ran before the pull response returned');
        docManager.closeDocument(uri);
        await tick();
        await (plugin as any).svelteLifecycle.get(filePath);
        await tick();

        assert.strictEqual(warmCalls, 0);
    });

    it('serves an immediate component feature before any diagnostic-triggered warmup', async () => {
        const document = new Document(
            pathToUrl('/workspace/Component.svelte'),
            '<Button >',
            /*skipConfigLoading*/ true
        );
        const position = document.positionAt('<Button '.length);
        let propsCalls = 0;
        let backgroundWarmCalls = 0;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            apiSession: {
                available: true,
                warmProjectForFile: async () => {
                    backgroundWarmCalls++;
                    return true;
                }
            } as any,
            componentInfo: {
                getProps: async () => {
                    propsCalls++;
                    return [{ name: 'label', type: 'string' }];
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    throw new Error('component props should not fall back to the child LSP');
                }
            } as any
        });
        (plugin as any).componentOffsetAt = () => ({ offset: 7, tag: 'Button' });
        (plugin as any).syncDocument = async () => ({
            document,
            shadowPath: '/workspace/.overlay/Component.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: { svelteNodeAt: () => undefined }
        });

        const result = await plugin.getCompletions(document, position, {
            triggerKind: CompletionTriggerKind.Invoked
        });

        assert.strictEqual(propsCalls, 1);
        assert.strictEqual(backgroundWarmCalls, 0);
        assert.deepStrictEqual(
            result?.items.map((item) => item.label),
            ['label']
        );
    });

    it('does not reuse an older cache while an edit-and-undo sync is publishing', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const filePath = '/workspace/Component.svelte';
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let openText: string | undefined;
        let releaseB!: () => void;
        let startedB!: () => void;
        const bStarted = new Promise<void>((resolve) => (startedB = resolve));
        const bBlocked = new Promise<void>((resolve) => (releaseB = resolve));
        const shadows = {
            overlayTsconfigPath: '/workspace/.overlay/tsconfig.json',
            getShadowPath: () => shadowPath,
            transform: (current: Document) => ({
                getFullText: () => `generated:${current.getText()}`
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
                openDocument: async (_fileName: string, text: string) => void (openText = text),
                updateDocument: async (_fileName: string, _changes: any, text: string) => {
                    if (text === 'generated:B') {
                        startedB();
                        await bBlocked;
                    }
                    openText = text;
                }
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => undefined;

        const document = docManager.openClientDocument({ uri, text: 'A' });
        await (plugin as any).svelteLifecycle.get(filePath);
        await (plugin as any).syncDocument(document);

        docManager.updateDocument({ uri, version: 2 }, [{ text: 'B' }]);
        await bStarted;
        docManager.updateDocument({ uri, version: 3 }, [{ text: 'A' }]);
        let featureSettled = false;
        const featureSync = (plugin as any)
            .syncDocument(document)
            .finally(() => (featureSettled = true));
        await tick();
        assert.strictEqual(featureSettled, false, 'A cache bypassed the in-flight B revision');

        releaseB();
        await featureSync;
        await (plugin as any).svelteLifecycle.get(filePath);
        assert.strictEqual(openText, 'generated:A');
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
            backgroundSyncDelayMs: 0,
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

    it('flushes a newly dirty component before another document asks for semantics', async () => {
        const aPath = '/workspace/A.svelte';
        const bPath = '/workspace/B.svelte';
        const aUri = pathToUrl(aPath);
        const bUri = pathToUrl(bPath);
        const documents = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const openText = new Map<string, string>();
        const shadowPath = (filePath: string) =>
            `/workspace/.overlay/${path.basename(filePath)}.tsx`;
        const shadows = {
            overlayTsconfigPath: '/workspace/.overlay/tsconfig.json',
            getShadowPath: shadowPath,
            transform: (document: Document) => ({
                getFullText: () => `generated:${document.getText()}`,
                getGeneratedPosition: (position: any) => position,
                getOriginalPosition: (position: any) => position
            }),
            ensureShadowDirectory: () => undefined,
            pinSnapshot: () => undefined
        };
        let semanticRequests = 0;
        const plugin = new TsGoPlugin({
            docManager: documents,
            // This reproduces the cold-open grace period which previously hid A's first edit.
            backgroundSyncDelayMs: 60_000,
            projects: {
                forFile: () => shadows,
                getOriginalPath: () => undefined
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                getOpenText: (fileName: string) => openText.get(fileName),
                isOpen: (fileName: string) => openText.has(fileName),
                openDocument: async (fileName: string, text: string) => {
                    openText.set(fileName, text);
                },
                updateDocument: async (_fileName: string, _changes: any, text: string) => {
                    openText.set(_fileName, text);
                },
                sendRequest: async () => {
                    semanticRequests++;
                    assert.strictEqual(
                        openText.get(shadowPath(aPath)),
                        `generated:${documents.get(aUri)!.getText()}`,
                        "cross-file request observed A's saved shadow"
                    );
                    return [];
                },
                dispose: () => undefined
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => undefined;

        const b = documents.openClientDocument({
            uri: bUri,
            text: '<script>const value = 1;</script>'
        });
        await (plugin as any).syncDocument(b);
        documents.openClientDocument({ uri: aUri, text: '<p>saved</p>' });
        documents.updateDocument({ uri: aUri, version: 2 }, [{ text: '<p>dirty one</p>' }]);

        await plugin.getDefinitions(b, { line: 0, character: 15 });

        documents.updateDocument({ uri: aUri, version: 3 }, [{ text: '<p>dirty two</p>' }]);
        await plugin.findReferences(b, { line: 0, character: 15 }, { includeDeclaration: true });

        assert.strictEqual(semanticRequests, 2);
        plugin.dispose();
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
        assert.strictEqual((plugin as any).syncedSvelte.size, 0);
        assert.strictEqual((plugin as any).svelteSyncs.size, 0);
    });

    it('does not let a delayed close evict a newly reopened Svelte overlay', async () => {
        const uri = pathToUrl('/workspace/Component.svelte');
        const filePath = '/workspace/Component.svelte';
        const shadowPath = '/workspace/.overlay/Component.svelte.tsx';
        const deleted: string[] = [];
        const unpinned: string[] = [];
        const closed: string[] = [];
        let openText: string | undefined;
        let transforms = 0;
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const shadows = {
            overlayTsconfigPath: '/workspace/.overlay/tsconfig.json',
            getShadowPath: () => shadowPath,
            transform: (document: Document) => {
                transforms++;
                return { getFullText: () => `generated:${document.getText()}` };
            },
            ensureShadowDirectory: () => undefined,
            pinSnapshot: () => undefined,
            unpinSnapshot: (source: string) => void unpinned.push(source),
            deleteSnapshot: (source: string) => void deleted.push(source)
        };
        const plugin = new TsGoPlugin({
            docManager,
            backgroundSyncDelayMs: 0,
            projects: { forFile: () => shadows } as any,
            server: {
                updateConfiguration: async () => undefined,
                getOpenText: () => openText,
                isOpen: () => openText !== undefined,
                openDocument: async (_fileName: string, text: string) => void (openText = text),
                updateDocument: async (_fileName: string, _changes: any, text: string) =>
                    void (openText = text),
                closeDocument: async (fileName: string) => {
                    closed.push(fileName);
                    openText = undefined;
                }
            } as any
        });
        (plugin as any).ensureProjectOpened = async () => undefined;

        docManager.openClientDocument({ uri, text: '<p>first</p>' });
        await (plugin as any).svelteLifecycle.get(filePath);
        assert.strictEqual(openText, 'generated:<p>first</p>');

        let releaseLifecycle!: () => void;
        const lifecycleBlocked = new Promise<void>((resolve) => (releaseLifecycle = resolve));
        (plugin as any).svelteLifecycle.set(filePath, lifecycleBlocked);

        docManager.closeDocument(uri);
        const reopened = docManager.openClientDocument({ uri, text: '<p>reopened</p>' });
        let featureSettled = false;
        const featureSync = (plugin as any)
            .syncDocument(reopened)
            .finally(() => void (featureSettled = true));

        await tick();
        assert.strictEqual(
            featureSettled,
            false,
            'feature bypassed the lifecycle close/reopen tail'
        );
        assert.strictEqual(openText, 'generated:<p>first</p>');

        releaseLifecycle();
        const synced = await featureSync;
        await (plugin as any).svelteLifecycle.get(filePath);

        assert.strictEqual(synced?.document, reopened);
        assert.strictEqual(openText, 'generated:<p>reopened</p>');
        assert.deepStrictEqual(closed, []);
        assert.deepStrictEqual(unpinned, []);
        assert.deepStrictEqual(deleted, []);
        assert.strictEqual(transforms, 2);
        assert.strictEqual((plugin as any).svelteOverlayBySource.get(filePath), shadowPath);
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
        const appProjectKey = '/workspace/apps/app/.overlay/tsconfig.json';
        const uiProjectKey = '/workspace/packages/ui/.overlay/tsconfig.json';
        const appManager = {
            overlayTsconfigPath: appProjectKey,
            invalidateStructuralCaches: () => undefined
        };
        const uiManager = {
            overlayTsconfigPath: uiProjectKey,
            invalidateStructuralCaches: () => undefined
        };
        const closed: string[] = [];
        const synced: Document[] = [];
        const changedDiagnosticProjects: string[][] = [];
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
                notifyWatchedFiles: async () => undefined,
                noteProjectChanges: (keys: Iterable<string>) =>
                    changedDiagnosticProjects.push([...keys])
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
        assert.deepStrictEqual(changedDiagnosticProjects, [[appProjectKey]]);
        assert.strictEqual((plugin as any).svelteOverlayBySource.has(appPath), false);
        assert.strictEqual((plugin as any).svelteOverlayBySource.get(uiPath), `${uiPath}.tsx`);
    });

    it('includes known reverse consumers in structural diagnostic invalidation', async () => {
        const sourceProject = {
            overlayTsconfigPath: '/workspace/packages/ui/.overlay/tsconfig.json',
            invalidateStructuralCaches: () => undefined
        };
        const consumerProject = {
            overlayTsconfigPath: '/workspace/apps/app/.overlay/tsconfig.json',
            invalidateStructuralCaches: () => undefined
        };
        const unrelatedProjectKey = '/workspace/apps/other/.overlay/tsconfig.json';
        const changedDiagnosticProjects: string[][] = [];
        let invalidatedAll = false;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                invalidateForStructuralChanges: () => [sourceProject, consumerProject]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                restart: async () => undefined,
                notifyWatchedFiles: async () => undefined,
                noteProjectChanges: (keys: Iterable<string>) =>
                    changedDiagnosticProjects.push([...keys]),
                noteAllProjectsChanged: () => void (invalidatedAll = true),
                projectGeneration: (key: string) => (key === unrelatedProjectKey ? 99 : 1)
            } as any
        });

        plugin.onWatchFileChanges([
            { fileName: '/workspace/packages/ui/package.json', changeType: 2 /* Changed */ }
        ]);
        await (plugin as any).watchWork;

        assert.deepStrictEqual(changedDiagnosticProjects, [
            [sourceProject.overlayTsconfigPath, consumerProject.overlayTsconfigPath]
        ]);
        assert.strictEqual(invalidatedAll, false);
        assert.strictEqual(
            (plugin as any).diagnosticProjectGeneration(unrelatedProjectKey),
            99,
            'an unrelated configured project was invalidated'
        );
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

    it('keeps an independent project result id and native check stable after editing a sibling', async () => {
        const projectA = '/workspace/a/.svelte-kit/tsconfig.json';
        const projectB = '/workspace/b/.svelte-kit/tsconfig.json';
        const documentA = { project: 'a' } as unknown as Document;
        const documentB = { project: 'b' } as unknown as Document;
        const server = new TsGoServer({
            engine: {
                packageName: '@test/tsgo',
                version: '1.2.3',
                packageRoot: '/test/tsgo',
                binPath: '/test/tsgo/bin.js',
                command: '/test/node',
                argsPrefix: ['/test/tsgo/bin.js']
            },
            workspacePath: '/workspace'
        });
        const checks = new Map<string, number>();
        (server as any).sendRequest = async (_method: string, params: any) => {
            const uri = params.textDocument.uri as string;
            const project = uri.includes('/a/') ? projectA : projectB;
            checks.set(project, (checks.get(project) ?? 0) + 1);
            return { items: [] };
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server
        });
        (plugin as any).syncDocument = async (document: Document) => {
            const a = document === documentA;
            return {
                document,
                shadowPath: `/workspace/${a ? 'a' : 'b'}/.overlay/Component.svelte.tsx`,
                projectKey: a ? projectA : projectB,
                snapshot: {
                    filePath: `/workspace/${a ? 'a' : 'b'}/Component.svelte`,
                    getFullText: () => ''
                }
            };
        };

        const firstA = await plugin.getDiagnosticsForPullMode(documentA);
        const firstB = await plugin.getDiagnosticsForPullMode(documentB);
        const firstAResultId = (firstA as any).resultId as string;
        const firstBResultId = (firstB as any).resultId as string;
        assert.strictEqual(checks.get(projectA), 1);
        assert.strictEqual(checks.get(projectB), 1);

        // The TS/Svelte lifecycle calls this same server boundary when project A is edited.
        server.noteProjectChanges([projectA]);

        assert.deepStrictEqual(await plugin.getDiagnosticsForPullMode(documentB, firstBResultId), {
            kind: 'unchanged',
            resultId: firstBResultId
        });
        assert.strictEqual(checks.get(projectB), 1, 'project B paid for an unrelated native check');

        const secondA = await plugin.getDiagnosticsForPullMode(documentA, firstAResultId);
        assert.strictEqual((secondA as any).kind, 'full');
        assert.notStrictEqual((secondA as any).resultId, firstAResultId);
        assert.strictEqual(checks.get(projectA), 2);
        assert.strictEqual(plugin.stats.projectChecks, 3);
        plugin.dispose();
    });

    it('invalidates every proven TS/JS consumer across open, update, and close', async () => {
        const source = '/workspace/shared/state.ts';
        const projectA = '/workspace/a/.overlay/tsconfig.json';
        const projectB = '/workspace/b/.overlay/tsconfig.json';
        const managerA = { overlayTsconfigPath: projectA };
        const managerB = { overlayTsconfigPath: projectB };

        for (const lifecycle of ['open', 'update', 'close'] as const) {
            const generations = new Map([
                [projectA, 0],
                [projectB, 0]
            ]);
            const noteProjectChanges = (keys: Iterable<string>) => {
                for (const key of keys) {
                    generations.set(key, (generations.get(key) ?? 0) + 1);
                }
            };
            const server = {
                updateConfiguration: async () => undefined,
                noteProjectChanges,
                noteAllProjectsChanged: () => {
                    throw new Error(
                        'exact source ownership unexpectedly fell back to all projects'
                    );
                },
                isOpen: () => true,
                openDocument: async (
                    _fileName: string,
                    _text: string,
                    _languageId: string,
                    projectKey: string
                ) => noteProjectChanges([projectKey]),
                updateDocument: async (
                    _fileName: string,
                    _changes: any,
                    _text: string,
                    _languageId: string,
                    projectKey: string
                ) => noteProjectChanges([projectKey]),
                closeDocument: async () => noteProjectChanges([projectA]),
                dispose: () => undefined
            };
            const plugin = new TsGoPlugin({
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                ),
                projects: {
                    forFile: () => managerA,
                    consumersForSourceChange: () => [managerA, managerB],
                    all: () => [managerA, managerB]
                } as any,
                server: server as any
            });

            if (lifecycle === 'open') {
                plugin.openTsOrJsFile(source, 'export const value = 1;', 'typescript');
            } else if (lifecycle === 'update') {
                plugin.updateTsOrJsFile(
                    source,
                    [{ text: 'export const value = 2;' }],
                    'export const value = 2;',
                    2,
                    'typescript'
                );
            } else {
                plugin.closeTsOrJsFile(source);
            }
            await tick();

            assert.deepStrictEqual(
                Object.fromEntries(generations),
                { [projectA]: 1, [projectB]: 1 },
                lifecycle
            );
            plugin.dispose();
        }
    });

    it('invalidates all known TS/JS projects when source ownership is incomplete', async () => {
        const projectA = { overlayTsconfigPath: '/workspace/a/.overlay/tsconfig.json' };
        const projectB = { overlayTsconfigPath: '/workspace/b/.overlay/tsconfig.json' };
        const projectC = { overlayTsconfigPath: '/workspace/c/.overlay/tsconfig.json' };
        const changed = new Set<string>();
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                forFile: () => projectA,
                consumersForSourceChange: () => undefined,
                all: () => [projectA, projectB, projectC]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                isOpen: () => true,
                updateDocument: async (
                    _fileName: string,
                    _changes: any,
                    _text: string,
                    _languageId: string,
                    projectKey: string
                ) => void changed.add(projectKey),
                noteProjectChanges: (keys: Iterable<string>) => {
                    for (const key of keys) {
                        changed.add(key);
                    }
                },
                dispose: () => undefined
            } as any
        });

        plugin.updateTsOrJsFile(
            '/workspace/shared/state.ts',
            [{ text: 'export const value = 2;' }],
            'export const value = 2;',
            2,
            'typescript'
        );
        await tick();

        assert.deepStrictEqual(
            changed,
            new Set([
                projectA.overlayTsconfigPath,
                projectB.overlayTsconfigPath,
                projectC.overlayTsconfigPath
            ])
        );
        plugin.dispose();
    });

    it('forwards watched TS/JS saves with every proven consumer generation', async () => {
        const projectA = { overlayTsconfigPath: '/workspace/a/.overlay/tsconfig.json' };
        const projectB = { overlayTsconfigPath: '/workspace/b/.overlay/tsconfig.json' };
        let notifiedProjects: string[] | undefined;
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {
                consumersForSourceChange: () => [projectA, projectB]
            } as any,
            server: {
                updateConfiguration: async () => undefined,
                notifyWatchedFiles: async (_changes: any, projects?: Iterable<string>) => {
                    notifiedProjects = projects ? [...projects] : undefined;
                },
                dispose: () => undefined
            } as any
        });
        (plugin as any).isStructuralWatchChange = () => false;

        plugin.onWatchFileChanges([
            { fileName: '/workspace/shared/state.ts', changeType: 2 /* Changed */ }
        ]);
        await (plugin as any).watchWork;

        assert.deepStrictEqual(
            new Set(notifiedProjects),
            new Set([projectA.overlayTsconfigPath, projectB.overlayTsconfigPath])
        );
        plugin.dispose();
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

    it('drops a requestAt response when the document changes without cancellation', async () => {
        const native = deferred<any[]>();
        const uri = pathToUrl('/workspace/Current.svelte');
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        let nativeStarted = false;
        let mappingLookups = 0;
        const plugin = new TsGoPlugin({
            docManager,
            projects: {
                getOriginalPath: () => {
                    mappingLookups++;
                    return undefined;
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    nativeStarted = true;
                    return native.promise;
                },
                dispose: () => undefined
            } as any
        });
        (plugin as any).syncDocument = async (document: Document) => ({
            document,
            shadowPath: '/workspace/.overlay/Current.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: { getGeneratedPosition: () => ({ line: 0, character: 0 }) }
        });
        const document = docManager.openClientDocument({
            uri,
            text: '<script>const value = 1;</script>'
        });

        const pending = plugin.findReferences(
            document,
            { line: 0, character: 15 },
            { includeDeclaration: true }
        );
        await tick();
        assert.strictEqual(nativeStarted, true);
        docManager.updateDocument({ uri, version: 2 }, [
            { text: '<script>const changed = 2;</script>' }
        ]);
        native.resolve([
            {
                uri: pathToUrl('/workspace/target.ts'),
                range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 }
                }
            }
        ]);

        assert.strictEqual(await pending, null);
        assert.strictEqual(mappingLookups, 0, 'stale requestAt response reached location mapping');
        plugin.dispose();
    });

    it('drops direct feature responses when the document changes without cancellation', async () => {
        const range = {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 }
        };
        const cases: Array<{
            name: string;
            response: any;
            invoke: (plugin: TsGoPlugin, document: Document) => Promise<any>;
            expected: any;
        }> = [
            {
                name: 'hover',
                response: { contents: 'stale', range },
                invoke: (plugin, document) => plugin.doHover(document, range.start),
                expected: null
            },
            {
                name: 'selection range',
                response: [{ range }],
                invoke: (plugin, document) => plugin.getSelectionRange(document, range.start),
                expected: null
            },
            {
                name: 'semantic tokens',
                response: { data: [0, 0, 1, 0, 0] },
                invoke: (plugin, document) => plugin.getSemanticTokens(document),
                expected: null
            },
            {
                name: 'document symbols',
                response: [{ name: 'value', kind: 13, range, selectionRange: range }],
                invoke: (plugin, document) => plugin.getDocumentSymbols(document),
                expected: []
            },
            {
                name: 'inlay hints',
                response: [{ position: range.start, label: 'stale' }],
                invoke: (plugin, document) => plugin.getInlayHints(document, range),
                expected: null
            },
            {
                name: 'folding ranges',
                response: [
                    {
                        startLine: 0,
                        startCharacter: 0,
                        endLine: 1,
                        endCharacter: 0
                    }
                ],
                invoke: (plugin, document) => plugin.getFoldingRanges(document),
                expected: []
            }
        ];

        for (const testCase of cases) {
            const native = deferred<any>();
            const uri = pathToUrl(`/workspace/${testCase.name.replaceAll(' ', '-')}.svelte`);
            const docManager = new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            );
            let nativeStarted = false;
            let outputMappings = 0;
            const snapshot = {
                getGeneratedPosition: (position: any) => position,
                getOriginalPosition: (position: any) => {
                    outputMappings++;
                    return position;
                },
                positionAt: () => ({ line: 0, character: 0 }),
                offsetAt: () => 0,
                getLength: () => 32,
                getFullText: () => 'const value = 1;',
                svelteNodeAt: () => undefined
            };
            const plugin = new TsGoPlugin({
                docManager,
                projects: {} as any,
                server: {
                    generation: 1,
                    updateConfiguration: async () => undefined,
                    sendRequest: async () => {
                        nativeStarted = true;
                        return native.promise;
                    },
                    dispose: () => undefined
                } as any
            });
            (plugin as any).syncDocument = async (document: Document) => ({
                document,
                shadowPath: '/workspace/.overlay/Current.svelte.tsx',
                projectKey: '/workspace/.overlay/tsconfig.json',
                snapshot
            });
            const document = docManager.openClientDocument({
                uri,
                text: '<script>const value = 1;</script>'
            });

            const pending = testCase.invoke(plugin, document);
            await tick();
            assert.strictEqual(nativeStarted, true, `${testCase.name} did not reach native`);
            docManager.updateDocument({ uri, version: 2 }, [
                { text: '<script>const changed = 2;</script>' }
            ]);
            native.resolve(testCase.response);

            assert.deepStrictEqual(await pending, testCase.expected, testCase.name);
            assert.strictEqual(
                outputMappings,
                0,
                `${testCase.name} mapped a stale native response`
            );
            plugin.dispose();
        }
    });

    it('drops component-reference responses after an edit or native restart', async () => {
        for (const invalidation of ['document', 'native'] as const) {
            const native = deferred<any[]>();
            const uri = pathToUrl(`/workspace/Component-${invalidation}.svelte`);
            const documents = new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            );
            let nativeStarted = false;
            let mappingLookups = 0;
            const snapshot = {
                getFullText: () => 'const Component = {}; export default Component;',
                positionAt: () => ({ line: 0, character: 6 })
            };
            const server = {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => {
                    nativeStarted = true;
                    return native.promise;
                },
                dispose: () => undefined
            };
            const plugin = new TsGoPlugin({
                docManager: documents,
                backgroundSyncDelayMs: 60_000,
                projects: {
                    getOriginalPath: () => {
                        mappingLookups++;
                        return undefined;
                    }
                } as any,
                server: server as any
            });
            (plugin as any).syncDocument = async (document: Document) => ({
                document,
                shadowPath: '/workspace/.overlay/Component.svelte.tsx',
                projectKey: '/workspace/.overlay/tsconfig.json',
                snapshot
            });
            const document = documents.openClientDocument({
                uri,
                text: '<script>export let value;</script>'
            });

            const pending = plugin.findComponentReferences(uri);
            await tick();
            assert.strictEqual(nativeStarted, true);
            if (invalidation === 'document') {
                documents.updateDocument({ uri, version: 2 }, [
                    { text: '<script>export let changed;</script>' }
                ]);
            } else {
                server.generation++;
            }
            native.resolve([
                {
                    uri: pathToUrl('/workspace/Use.svelte.tsx'),
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 1 }
                    }
                }
            ]);

            assert.strictEqual(await pending, null, invalidation);
            assert.strictEqual(mappingLookups, 0, `${invalidation} reached location mapping`);
            assert.strictEqual(document.openedByClient, true);
            plugin.dispose();
        }
    });

    it('drops folding ranges when the native generation restarts', async () => {
        const native = deferred<any[]>();
        const document = new Document(
            pathToUrl('/workspace/FoldingRestart.svelte'),
            '<script>\nif (true) {\n}\n</script>',
            /*skipConfigLoading*/ true
        );
        let outputMappings = 0;
        const server = {
            generation: 1,
            updateConfiguration: async () => undefined,
            sendRequest: async () => native.promise,
            dispose: () => undefined
        };
        const plugin = new TsGoPlugin({
            docManager: new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            ),
            projects: {} as any,
            server: server as any
        });
        (plugin as any).syncDocument = async () => ({
            document,
            shadowPath: '/workspace/.overlay/FoldingRestart.svelte.tsx',
            projectKey: '/workspace/.overlay/tsconfig.json',
            snapshot: {
                getOriginalPosition: (position: any) => {
                    outputMappings++;
                    return position;
                }
            }
        });

        const pending = plugin.getFoldingRanges(document);
        await tick();
        server.generation++;
        native.resolve([
            {
                startLine: 0,
                startCharacter: 0,
                endLine: 2,
                endCharacter: 1
            }
        ]);

        assert.deepStrictEqual(await pending, []);
        assert.strictEqual(outputMappings, 0);
        plugin.dispose();
    });

    it('drops call-hierarchy responses when their open Svelte item changes', async () => {
        const native = deferred<any[]>();
        const uri = pathToUrl('/workspace/Caller.svelte');
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const range = {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 }
        };
        let mappingLookups = 0;
        const snapshot = {
            getGeneratedPosition: (position: any) => position,
            getOriginalPosition: (position: any) => position
        };
        const plugin = new TsGoPlugin({
            docManager,
            projects: {
                ensureSnapshot: () => snapshot,
                forFile: () => ({
                    getShadowPath: () => '/workspace/.overlay/Caller.svelte.tsx'
                }),
                getOriginalPath: () => {
                    mappingLookups++;
                    return undefined;
                }
            } as any,
            server: {
                generation: 1,
                updateConfiguration: async () => undefined,
                sendRequest: async () => native.promise,
                dispose: () => undefined
            } as any
        });
        docManager.openClientDocument({ uri, text: '<script>function caller() {}</script>' });
        const item = {
            name: 'caller',
            kind: 12,
            uri,
            range,
            selectionRange: range
        } as CallHierarchyItem;

        const pending = plugin.getOutgoingCalls(item);
        await tick();
        docManager.updateDocument({ uri, version: 2 }, [
            { text: '<script>function changed() {}</script>' }
        ]);
        native.resolve([
            {
                to: {
                    name: 'callee',
                    kind: 12,
                    uri: pathToUrl('/workspace/callee.ts'),
                    range,
                    selectionRange: range
                },
                fromRanges: [range]
            }
        ]);

        assert.strictEqual(await pending, null);
        assert.strictEqual(mappingLookups, 0, 'stale call hierarchy response reached mapping');
        plugin.dispose();
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
        const document = {
            version: 0,
            getText: () => '<h1 />'
        } as Document;
        const pending = plugin.doHover(document, { line: 0, character: 0 }, cancellation.token);
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
