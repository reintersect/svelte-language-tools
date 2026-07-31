import sinon from 'sinon';
import {
    CompletionItem,
    DocumentSymbol,
    Location,
    LocationLink,
    Position,
    Range,
    SymbolInformation,
    SymbolKind,
    TextDocumentItem
} from 'vscode-languageserver-types';
import { DocumentManager, Document } from '../../src/lib/documents';
import {
    DiagnosticsProvider,
    LSPProviderConfig,
    markSvelteParserError,
    PluginHost,
    SVELTE_PARSER_ERROR
} from '../../src/plugins';
import {
    CompletionTriggerKind,
    CancellationToken,
    CancellationTokenSource,
    DiagnosticSeverity,
    DocumentDiagnosticReport,
    LSPErrorCodes,
    ResponseError
} from 'vscode-languageserver';
import assert from 'assert';

describe('PluginHost', () => {
    const textDocument: TextDocumentItem = {
        uri: 'file:///hello.svelte',
        version: 0,
        languageId: 'svelte',
        text: 'Hello, world!'
    };

    function setup<T>(
        pluginProviderStubs: T,
        config: LSPProviderConfig = {
            definitionLinkSupport: true,
            filterIncompleteCompletions: false
        }
    ) {
        const docManager = new DocumentManager(
            (textDocument) => new Document(textDocument.uri, textDocument.text)
        );

        const pluginHost = new PluginHost(docManager);
        const plugin = {
            ...pluginProviderStubs,
            __name: 'test'
        };

        pluginHost.initialize(config);
        pluginHost.register(plugin);

        return { docManager, pluginHost, plugin };
    }

    it('executes getDiagnostics on plugins', async () => {
        const { docManager, pluginHost, plugin } = setup({
            getDiagnostics: sinon.stub().returns([])
        });
        const document = docManager.openClientDocument(textDocument);

        await pluginHost.getDiagnostics(textDocument);

        sinon.assert.calledOnce(plugin.getDiagnostics);
        sinon.assert.calledWithExactly(plugin.getDiagnostics, document, undefined);
    });

    it('keeps request cancellation as an empty fallback for push diagnostics', async () => {
        const { docManager, pluginHost } = setup({
            getDiagnostics() {
                throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request cancelled');
            }
        });
        docManager.openClientDocument(textDocument);

        const diagnostics = await pluginHost.getDiagnostics(textDocument);

        assert.deepStrictEqual(diagnostics, []);
    });

    it('executes doHover on plugins', async () => {
        const { docManager, pluginHost, plugin } = setup({
            doHover: sinon.stub().returns(null)
        });
        const document = docManager.openClientDocument(textDocument);
        const pos = Position.create(0, 0);

        await pluginHost.doHover(textDocument, pos);

        sinon.assert.calledOnce(plugin.doHover);
        sinon.assert.calledWithExactly(plugin.doHover, document, pos);
    });

    it('executes getCompletions on plugins', async () => {
        const { docManager, pluginHost, plugin } = setup({
            getCompletions: sinon.stub().returns({ items: [] })
        });
        const document = docManager.openClientDocument(textDocument);
        const pos = Position.create(0, 0);

        await pluginHost.getCompletions(textDocument, pos, {
            triggerKind: CompletionTriggerKind.TriggerCharacter,
            triggerCharacter: '.'
        });

        sinon.assert.calledOnce(plugin.getCompletions);
        sinon.assert.calledWithExactly(
            plugin.getCompletions,
            document,
            pos,
            {
                triggerKind: CompletionTriggerKind.TriggerCharacter,
                triggerCharacter: '.'
            },
            undefined
        );
    });

    it('deduplicates tsgo completions against HTML completions in start tags', async () => {
        const documentItem: TextDocumentItem = {
            ...textDocument,
            text: '<button ></button>'
        };
        const docManager = new DocumentManager(
            (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
        );
        const pluginHost = new PluginHost(docManager);
        pluginHost.initialize({
            definitionLinkSupport: true,
            filterIncompleteCompletions: false
        });
        pluginHost.register({
            __name: 'html',
            getCompletions: () => ({
                isIncomplete: false,
                items: [{ label: 'aria-label' }, { label: 'on:click' }]
            })
        });
        pluginHost.register({
            __name: 'tsgo',
            getCompletions: () => ({
                isIncomplete: false,
                items: [
                    { label: '"aria-label"' },
                    { label: 'onclick' },
                    { label: 'customProp', sortText: '1' }
                ]
            })
        });
        docManager.openClientDocument(documentItem);

        const completions = await pluginHost.getCompletions(
            documentItem,
            Position.create(0, '<button '.length)
        );

        assert.deepStrictEqual(completions.items, [
            { label: 'aria-label' },
            { label: 'on:click' },
            { label: 'customProp', sortText: 'Z1' }
        ]);
    });

    describe('pull mode diagnostics', () => {
        it('merge pull diagnostics results', async () => {
            const { docManager, pluginHost } = setup({
                getDiagnostics() {
                    return [];
                },
                getDiagnosticsForPullMode() {
                    return {
                        kind: 'full',
                        items: [],
                        resultId: '1'
                    };
                }
            });
            const plugin2 = {
                getDiagnostics() {
                    return [];
                },
                getDiagnosticsForPullMode(): DocumentDiagnosticReport {
                    return {
                        kind: 'full',
                        items: [],
                        resultId: '2'
                    };
                },
                __name: 'test2'
            };
            pluginHost.register(plugin2);
            docManager.openClientDocument(textDocument);
            const diagnostics = await pluginHost.getDiagnosticsForPullMode(textDocument, undefined);

            assert.deepStrictEqual(diagnostics, {
                kind: 'full',
                items: [],
                resultId: JSON.stringify({ test: '1', test2: '2' })
            });
        });

        it('prefers a Svelte compiler parser error over generated TypeScript fallbacks', async () => {
            const compilerError = {
                range: Range.create(0, 0, 0, 1),
                severity: DiagnosticSeverity.Error,
                source: 'svelte',
                code: 'block_unclosed',
                codeDescription: {
                    href: 'https://svelte.dev/docs/svelte/compiler-errors#block_unclosed'
                },
                message: 'Block was left open\nhttps://svelte.dev/e/block_unclosed'
            };
            const generatedFallback = markSvelteParserError({
                range: Range.create(0, 7, 0, 8),
                severity: DiagnosticSeverity.Error,
                source: 'js',
                code: 1109,
                message: 'Expression expected.'
            });
            const docManager = new DocumentManager(
                (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
            );
            const pluginHost = new PluginHost(docManager);
            pluginHost.initialize({
                definitionLinkSupport: true,
                filterIncompleteCompletions: false
            });
            pluginHost.register({
                __name: 'svelte',
                getDiagnostics: () => [compilerError],
                getDiagnosticsForPullMode: () => ({
                    kind: 'full' as const,
                    resultId: 'svelte-1',
                    items: [compilerError]
                })
            });
            pluginHost.register({
                __name: 'ts',
                getDiagnostics: () => [generatedFallback, generatedFallback],
                getDiagnosticsForPullMode: () => ({
                    kind: 'full' as const,
                    resultId: 'ts-1',
                    items: [generatedFallback, generatedFallback]
                })
            });
            docManager.openClientDocument(textDocument);

            assert.deepStrictEqual(await pluginHost.getDiagnostics(textDocument), [compilerError]);
            assert.deepStrictEqual(
                await pluginHost.getDiagnosticsForPullMode(textDocument, undefined),
                {
                    kind: 'full',
                    resultId: JSON.stringify({ svelte: 'svelte-1', ts: 'ts-1' }),
                    items: [compilerError]
                }
            );
        });

        it('retains one clean parser fallback when Svelte diagnostics are disabled', async () => {
            const fallback = markSvelteParserError({
                range: Range.create(0, 7, 0, 8),
                severity: DiagnosticSeverity.Error,
                source: 'js',
                code: 1109,
                message: 'Expression expected.'
            });
            const { docManager, pluginHost } = setup({
                getDiagnostics: () => [fallback, fallback],
                getDiagnosticsForPullMode: () => ({
                    kind: 'full' as const,
                    resultId: '1',
                    items: [fallback, fallback]
                })
            });
            docManager.openClientDocument(textDocument);

            const expected = [{ ...fallback }];
            Reflect.deleteProperty(expected[0], SVELTE_PARSER_ERROR);
            assert.deepStrictEqual(await pluginHost.getDiagnostics(textDocument), expected);
            assert.deepStrictEqual(
                await pluginHost.getDiagnosticsForPullMode(textDocument, undefined),
                {
                    kind: 'full',
                    resultId: JSON.stringify({ test: '1' }),
                    items: expected
                }
            );
        });

        it('retains template type diagnostics beside an unrelated CSS compiler error', async () => {
            const item = {
                ...textDocument,
                text: '<style>\n. {}\n</style>\n<p>{value.missing}</p>'
            };
            const cssError = {
                range: Range.create(1, 0, 1, 1),
                severity: DiagnosticSeverity.Error,
                source: 'svelte',
                code: 'css_expected_identifier',
                codeDescription: {
                    href: 'https://svelte.dev/docs/svelte/compiler-errors#css_expected_identifier'
                },
                message: 'Expected a valid CSS identifier'
            };
            const typeError = {
                range: Range.create(3, 10, 3, 17),
                severity: DiagnosticSeverity.Error,
                source: 'ts',
                code: 2339,
                message: "Property 'missing' does not exist on type '{ ok: number; }'."
            };
            const docManager = new DocumentManager(
                (document) => new Document(document.uri, document.text, true)
            );
            const pluginHost = new PluginHost(docManager);
            pluginHost.initialize({
                definitionLinkSupport: true,
                filterIncompleteCompletions: false
            });
            pluginHost.register({
                __name: 'svelte',
                getDiagnostics: () => [cssError],
                getDiagnosticsForPullMode: () => ({
                    kind: 'full' as const,
                    resultId: 'svelte-1',
                    items: [cssError]
                })
            });
            pluginHost.register({
                __name: 'ts',
                getDiagnostics: () => [typeError],
                getDiagnosticsForPullMode: () => ({
                    kind: 'full' as const,
                    resultId: 'ts-1',
                    items: [typeError]
                })
            });
            docManager.openClientDocument(item);

            assert.deepStrictEqual(await pluginHost.getDiagnostics(item), [cssError, typeError]);
            assert.deepStrictEqual(await pluginHost.getDiagnosticsForPullMode(item, undefined), {
                kind: 'full',
                resultId: JSON.stringify({ svelte: 'svelte-1', ts: 'ts-1' }),
                items: [cssError, typeError]
            });
        });

        it('merge pull diagnostics unchanged results', async () => {
            const { docManager, pluginHost } = setup({
                getDiagnostics() {
                    return [];
                },
                getDiagnosticsForPullMode() {
                    return {
                        kind: 'unchanged',
                        resultId: '1'
                    };
                }
            });
            const plugin2 = {
                getDiagnostics() {
                    return [];
                },
                getDiagnosticsForPullMode(): DocumentDiagnosticReport {
                    return {
                        kind: 'unchanged',
                        resultId: '2'
                    };
                },
                __name: 'test2'
            };
            pluginHost.register(plugin2);
            docManager.openClientDocument(textDocument);
            const diagnostics = await pluginHost.getDiagnosticsForPullMode(textDocument, undefined);

            assert.deepStrictEqual(diagnostics, {
                kind: 'unchanged',
                resultId: JSON.stringify({ test: '1', test2: '2' })
            });
        });

        it('merge pull diagnostics when some results are unchanged', async () => {
            const { docManager, pluginHost } = setup({
                getDiagnostics() {
                    return [];
                },
                getDiagnosticsForPullMode() {
                    return {
                        kind: 'unchanged',
                        resultId: '1'
                    };
                }
            });
            const plugin2 = {
                getDiagnostics() {
                    return [];
                },
                getDiagnosticsForPullMode(): DocumentDiagnosticReport {
                    return {
                        kind: 'full',
                        items: [],
                        resultId: '2'
                    };
                },
                __name: 'test2'
            };
            pluginHost.register(plugin2);
            docManager.openClientDocument(textDocument);
            const diagnostics = await pluginHost.getDiagnosticsForPullMode(textDocument, undefined);

            assert.deepStrictEqual(diagnostics, {
                kind: 'full',
                items: [],
                resultId: JSON.stringify({ test: '1', test2: '2' })
            });
        });

        it('propagates request cancellation instead of replacing it with an empty report', async () => {
            const cancellationTokenSource = new CancellationTokenSource();
            cancellationTokenSource.cancel();
            const expectedDiagnostic = {
                range: Range.create(0, 0, 0, 1),
                message: 'recomputed'
            };
            const { docManager, pluginHost } = setup({
                getDiagnostics() {
                    return [expectedDiagnostic];
                },
                getDiagnosticsForPullMode(
                    _document: Document,
                    _previousResultId: string | undefined,
                    cancellationToken: CancellationToken | undefined
                ): DocumentDiagnosticReport {
                    if (cancellationToken?.isCancellationRequested) {
                        throw new ResponseError(
                            LSPErrorCodes.RequestCancelled,
                            'Request cancelled'
                        );
                    }
                    return {
                        kind: 'full',
                        resultId: textDocument.version.toString(),
                        items: [expectedDiagnostic]
                    };
                }
            });
            docManager.openClientDocument(textDocument);

            await assert.rejects(
                pluginHost.getDiagnosticsForPullMode(
                    textDocument,
                    undefined,
                    cancellationTokenSource.token
                ),
                (error: unknown) =>
                    error instanceof ResponseError && error.code === LSPErrorCodes.RequestCancelled
            );

            const retry = await pluginHost.getDiagnosticsForPullMode(textDocument, undefined);

            assert.deepStrictEqual(retry, {
                kind: 'full',
                resultId: JSON.stringify({ test: textDocument.version.toString() }),
                items: [expectedDiagnostic]
            });
        });
    });

    describe('getCompletions (incomplete)', () => {
        function setupGetIncompleteCompletions(filterServerSide: boolean) {
            const { docManager, pluginHost } = setup(
                {
                    getCompletions: sinon.stub().returns({
                        isIncomplete: true,
                        items: <CompletionItem[]>[{ label: 'Hello' }, { label: 'foo' }]
                    })
                },
                { definitionLinkSupport: true, filterIncompleteCompletions: filterServerSide }
            );
            docManager.openClientDocument(textDocument);
            return pluginHost;
        }

        it('filters client side', async () => {
            const pluginHost = setupGetIncompleteCompletions(false);
            const completions = await pluginHost.getCompletions(
                textDocument,
                Position.create(0, 2)
            );

            assert.deepStrictEqual(completions.items, <CompletionItem[]>[
                { label: 'Hello' },
                { label: 'foo' }
            ]);
        });

        it('filters server side', async () => {
            const pluginHost = setupGetIncompleteCompletions(true);
            const completions = await pluginHost.getCompletions(
                textDocument,
                Position.create(0, 2)
            );

            assert.deepStrictEqual(completions.items, <CompletionItem[]>[{ label: 'Hello' }]);
        });
    });

    describe('getDefinitions', () => {
        function setupGetDefinitions(linkSupport: boolean) {
            const { pluginHost, docManager } = setup(
                {
                    getDefinitions: sinon.stub().returns([
                        <LocationLink>{
                            targetRange: Range.create(Position.create(0, 0), Position.create(0, 2)),
                            targetSelectionRange: Range.create(
                                Position.create(0, 0),
                                Position.create(0, 1)
                            ),
                            targetUri: 'uri'
                        }
                    ])
                },
                { definitionLinkSupport: linkSupport, filterIncompleteCompletions: false }
            );
            docManager.openClientDocument(textDocument);
            return pluginHost;
        }

        it('uses LocationLink', async () => {
            const pluginHost = setupGetDefinitions(true);
            const definitions = await pluginHost.getDefinitions(
                textDocument,
                Position.create(0, 0)
            );

            assert.deepStrictEqual(definitions, [
                <LocationLink>{
                    targetRange: Range.create(Position.create(0, 0), Position.create(0, 2)),
                    targetSelectionRange: Range.create(
                        Position.create(0, 0),
                        Position.create(0, 1)
                    ),
                    targetUri: 'uri'
                }
            ]);
        });

        it('uses Location', async () => {
            const pluginHost = setupGetDefinitions(false);
            const definitions = await pluginHost.getDefinitions(
                textDocument,
                Position.create(0, 0)
            );

            assert.deepStrictEqual(definitions, [
                <Location>{
                    range: Range.create(Position.create(0, 0), Position.create(0, 1)),
                    uri: 'uri'
                }
            ]);
        });
    });

    describe('getHierarchicalDocumentSymbols', () => {
        it('converts flat symbols to hierarchical structure', async () => {
            const cancellation_token: CancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} })
            };

            const flat_symbols: SymbolInformation[] = [
                // Root level class (lines 0-10)
                SymbolInformation.create(
                    'MyClass',
                    SymbolKind.Class,
                    Range.create(Position.create(0, 0), Position.create(10, 0)),
                    'file:///hello.svelte'
                ),
                // Method inside class (lines 1-5)
                SymbolInformation.create(
                    'myMethod',
                    SymbolKind.Method,
                    Range.create(Position.create(1, 0), Position.create(5, 0)),
                    'file:///hello.svelte'
                ),
                // Variable inside method (lines 2-3)
                SymbolInformation.create(
                    'localVar',
                    SymbolKind.Variable,
                    Range.create(Position.create(2, 0), Position.create(3, 0)),
                    'file:///hello.svelte'
                ),
                // Another method in class (lines 6-8)
                SymbolInformation.create(
                    'anotherMethod',
                    SymbolKind.Method,
                    Range.create(Position.create(6, 0), Position.create(8, 0)),
                    'file:///hello.svelte'
                ),
                // Root level function (lines 12-15)
                SymbolInformation.create(
                    'topLevelFunction',
                    SymbolKind.Function,
                    Range.create(Position.create(12, 0), Position.create(15, 0)),
                    'file:///hello.svelte'
                )
            ];

            const { docManager, pluginHost } = setup({});
            sinon.stub(pluginHost, 'getDocumentSymbols').returns(Promise.resolve(flat_symbols));
            docManager.openClientDocument(textDocument);

            const result = await pluginHost.getHierarchicalDocumentSymbols(
                textDocument,
                cancellation_token
            );

            // Should have 2 root symbols: MyClass and topLevelFunction
            assert.strictEqual(result.length, 2);

            // Check first root symbol (MyClass)
            assert.strictEqual(result[0].name, 'MyClass');
            assert.strictEqual(result[0].kind, SymbolKind.Class);
            assert.strictEqual(result[0].children?.length, 2);

            // Check children of MyClass
            assert.strictEqual(result[0].children![0].name, 'myMethod');
            assert.strictEqual(result[0].children![0].kind, SymbolKind.Method);
            assert.strictEqual(result[0].children![0].children?.length, 1);

            // Check nested child (localVar inside myMethod)
            assert.strictEqual(result[0].children![0].children![0].name, 'localVar');
            assert.strictEqual(result[0].children![0].children![0].kind, SymbolKind.Variable);
            assert.strictEqual(result[0].children![0].children![0].children?.length, 0);

            // Check second child of MyClass
            assert.strictEqual(result[0].children![1].name, 'anotherMethod');
            assert.strictEqual(result[0].children![1].kind, SymbolKind.Method);
            assert.strictEqual(result[0].children![1].children?.length, 0);

            // Check second root symbol (topLevelFunction)
            assert.strictEqual(result[1].name, 'topLevelFunction');
            assert.strictEqual(result[1].kind, SymbolKind.Function);
            assert.strictEqual(result[1].children?.length, 0);
        });

        it('handles empty symbol list', async () => {
            const cancellation_token: CancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} })
            };

            const { docManager, pluginHost } = setup({});
            sinon.stub(pluginHost, 'getDocumentSymbols').returns(Promise.resolve([]));
            docManager.openClientDocument(textDocument);

            const result = await pluginHost.getHierarchicalDocumentSymbols(
                textDocument,
                cancellation_token
            );

            assert.deepStrictEqual(result, []);
        });

        it('handles symbols with same start position', async () => {
            const cancellation_token: CancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} })
            };

            const flat_symbols: SymbolInformation[] = [
                // Two symbols starting at same position, longer one should be parent
                SymbolInformation.create(
                    'outer',
                    SymbolKind.Class,
                    Range.create(Position.create(0, 0), Position.create(10, 0)),
                    'file:///hello.svelte'
                ),
                SymbolInformation.create(
                    'inner',
                    SymbolKind.Method,
                    Range.create(Position.create(0, 0), Position.create(5, 0)),
                    'file:///hello.svelte'
                )
            ];

            const { docManager, pluginHost } = setup({});
            sinon.stub(pluginHost, 'getDocumentSymbols').returns(Promise.resolve(flat_symbols));
            docManager.openClientDocument(textDocument);

            const result = await pluginHost.getHierarchicalDocumentSymbols(
                textDocument,
                cancellation_token
            );

            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].name, 'outer');
            assert.strictEqual(result[0].children?.length, 1);
            assert.strictEqual(result[0].children![0].name, 'inner');
        });
    });
});
