import { performance } from 'perf_hooks';
import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeLens,
    Color,
    ColorInformation,
    ColorPresentation,
    CompletionContext,
    CompletionItem,
    CompletionList,
    DefinitionLink,
    Diagnostic,
    DocumentHighlight,
    FoldingRange,
    FormattingOptions,
    Hover,
    LinkedEditingRanges,
    Location,
    LSPErrorCodes,
    Position,
    Range,
    ReferenceContext,
    SelectionRange,
    SemanticTokens,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocumentContentChangeEvent,
    TextDocumentIdentifier,
    TextEdit,
    WorkspaceEdit,
    InlayHint,
    WorkspaceSymbol,
    DocumentSymbol,
    DocumentDiagnosticReport,
    ResponseError
} from 'vscode-languageserver';
import { Document, DocumentManager, getNodeIfIsInHTMLStartTag, isInTag } from '../lib/documents';
import { Logger } from '../logger';
import { isNotNullOrUndefined, regexLastIndexOf } from '../utils';
import {
    AppCompletionItem,
    FileRename,
    LSPProviderConfig,
    LSProvider,
    OnWatchFileChanges,
    OnWatchFileChangesPara,
    Plugin,
    SVELTE_PARSER_ERROR
} from './interfaces';

enum ExecuteMode {
    None,
    FirstNonNull,
    Collect
}

/** A 'smart' method is demoted to 'low' once its own measured cost exceeds this. */
const SMART_DEMOTION_THRESHOLD_MS = 500;
/**
 * How long a 'low' priority request waits before executing, so higher-priority work and
 * further document changes get a chance to land first. Kept short: it is pure added
 * latency for whichever request ends up being the last one.
 */
const LOW_PRIORITY_DEBOUNCE_MS = 250;

export class PluginHost implements LSProvider, OnWatchFileChanges {
    private plugins: Plugin[] = [];
    private pluginHostConfig: LSPProviderConfig = {
        filterIncompleteCompletions: true,
        definitionLinkSupport: false
    };
    private deferredRequests: Record<string, [number, Promise<any>]> = {};
    private requestTimings: Record<string, [time: number, lastExecuted: number]> = {};
    /** Keyed by `${uri}@${version}` so duplicate outline/sticky-scroll requests share one computation. */
    private inFlightDocumentSymbols = new Map<string, Promise<SymbolInformation[]>>();
    private disposed = false;

    constructor(private documentsManager: DocumentManager) {}

    initialize(pluginHostConfig: LSPProviderConfig) {
        this.pluginHostConfig = pluginHostConfig;
    }

    register(plugin: Plugin) {
        this.plugins.push(plugin);
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const plugin of this.plugins) {
            try {
                plugin.dispose?.();
            } catch (error) {
                Logger.error(`Failed to dispose plugin ${plugin.__name}`, error);
            }
        }
    }

    didUpdateDocument() {
        this.deferredRequests = {};
    }

    async getDiagnostics(
        textDocument: TextDocumentIdentifier,
        cancellationToken?: CancellationToken
    ): Promise<Diagnostic[]> {
        const document = this.getDocument(textDocument.uri);

        if (this.canSkipDiagnostics(document)) {
            // Don't return diagnostics for files inside node_modules. These are considered read-only (cannot be changed)
            // and in case of svelte-check they would pollute/skew the output
            return [];
        }

        return reconcileSvelteParserDiagnostics(
            (
                await this.execute<Diagnostic[]>(
                    'getDiagnostics',
                    [document, cancellationToken],
                    ExecuteMode.Collect,
                    'high'
                )
            ).flat(),
            document
        );
    }

    private canSkipDiagnostics(document: Document) {
        return (
            (document.getFilePath()?.includes('/node_modules/') ||
                document.getFilePath()?.includes('\\node_modules\\')) &&
            // Sapper convention: Put stuff inside node_modules below src
            !(
                document.getFilePath()?.includes('/src/node_modules/') ||
                document.getFilePath()?.includes('\\src\\node_modules\\')
            )
        );
    }

    async getDiagnosticsForPullMode(
        textDocument: TextDocumentIdentifier,
        previousResultId: string | undefined,
        cancellationToken?: CancellationToken
    ): Promise<DocumentDiagnosticReport> {
        const document = this.getDocument(textDocument.uri);
        let previousResultIdData: Record<string, string> = {};
        if (previousResultId) {
            try {
                previousResultIdData = JSON.parse(previousResultId);
            } catch (error) {}
        }

        if (this.canSkipDiagnostics(document)) {
            // Don't return diagnostics for files inside node_modules. These are considered read-only (cannot be changed)
            return {
                kind: 'full',
                items: []
            };
        }

        const plugins = this.plugins.filter(
            (plugin) => typeof plugin.getDiagnosticsForPullMode === 'function'
        );

        const results = await Promise.all(
            plugins.map(
                async (plugin): Promise<[string, DocumentDiagnosticReport]> => [
                    plugin.__name,
                    await this.tryExecutePlugin(
                        plugin,
                        'getDiagnosticsForPullMode',
                        [document, previousResultIdData[plugin.__name], cancellationToken],
                        { kind: 'full', items: [] },
                        true
                    )
                ]
            )
        );

        const newResultId = JSON.stringify(
            Object.fromEntries(results.map(([name, res]) => [name, res.resultId]))
        );
        const unchanged = results
            .filter(([, res]) => res.kind === 'unchanged')
            .map(([name]) => name);
        const fullResults = results.flatMap(([, res]) => (res.kind === 'full' ? res.items : []));

        if (unchanged.length === plugins.length) {
            return {
                kind: 'unchanged',
                resultId: newResultId
            };
        }
        if (unchanged.length === 0) {
            return {
                kind: 'full',
                resultId: newResultId,
                items: reconcileSvelteParserDiagnostics(fullResults, document)
            };
        }
        const unchangedPlugins = plugins.filter((plugin) => unchanged.includes(plugin.__name));
        const unchangedResults = await Promise.all(
            unchangedPlugins.map(async (plugin) => {
                const result = await this.tryExecutePlugin(
                    plugin,
                    'getDiagnostics',
                    [document, cancellationToken],
                    [],
                    true
                );
                return result;
            })
        );

        return {
            kind: 'full',
            resultId: newResultId,
            items: reconcileSvelteParserDiagnostics(
                fullResults.concat(unchangedResults.flat()),
                document
            )
        };
    }

    async doHover(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Hover | null> {
        const document = this.getDocument(textDocument.uri);

        return this.execute<Hover>(
            'doHover',
            [document, position, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async getCompletions(
        textDocument: TextDocumentIdentifier,
        position: Position,
        completionContext?: CompletionContext,
        cancellationToken?: CancellationToken
    ): Promise<CompletionList> {
        const document = this.getDocument(textDocument.uri);

        const completions = await Promise.all(
            this.plugins.map(async (plugin) => {
                const result = await this.tryExecutePlugin(
                    plugin,
                    'getCompletions',
                    [document, position, completionContext, cancellationToken],
                    null
                );
                if (result) {
                    return { result: result as CompletionList, plugin: plugin.__name };
                }
            })
        ).then((completions) => completions.filter(isNotNullOrUndefined));

        const html = completions.find((completion) => completion.plugin === 'html');
        const ts = completions.find(
            (completion) => completion.plugin === 'ts' || completion.plugin === 'tsgo'
        );
        if (html && ts && getNodeIfIsInHTMLStartTag(document.html, document.offsetAt(position))) {
            // Completion in a component or html start tag and both html and ts
            // suggest something -> filter out all duplicates from TS completions
            const htmlCompletions = new Set(html.result.items.map((item) => item.label));
            ts.result.items = ts.result.items.filter((item) => {
                const label = item.label;
                if (htmlCompletions.has(label)) {
                    return false;
                }
                if (label[0] === '"' && label[label.length - 1] === '"') {
                    // this will result in a wrong completion regardless, remove the quotes
                    item.label = item.label.slice(1, -1);
                    if (htmlCompletions.has(item.label)) {
                        // "aria-label" -> aria-label -> exists in html completions
                        return false;
                    }
                }
                if (label.startsWith('on')) {
                    if (htmlCompletions.has('on:' + label.slice(2))) {
                        // onclick -> on:click -> exists in html completions
                        return false;
                    }
                }
                // adjust sort text so it does appear after html completions
                item.sortText = 'Z' + (item.sortText || '');
                return true;
            });
        }

        let itemDefaults: CompletionList['itemDefaults'];
        if (completions.length === 1) {
            itemDefaults = completions[0]?.result.itemDefaults;
        } else {
            // don't apply items default to the result of other plugins
            for (const completion of completions) {
                const itemDefaults = completion.result.itemDefaults;
                if (!itemDefaults) {
                    continue;
                }
                completion.result.items.forEach((item) => {
                    item.commitCharacters ??= itemDefaults.commitCharacters;
                });
            }
        }

        let flattenedCompletions = completions.map((completion) => completion.result.items).flat();
        const isIncomplete = completions.reduce(
            (incomplete, completion) => incomplete || completion.result.isIncomplete,
            false as boolean
        );

        // If the result is incomplete, we need to filter the results ourselves
        // to throw out non-matching results. VSCode does filter client-side,
        // but other IDEs might not.
        if (isIncomplete && this.pluginHostConfig.filterIncompleteCompletions) {
            const offset = document.offsetAt(position);
            // Assumption for performance reasons:
            // Noone types import names longer than 20 characters and still expects perfect autocompletion.
            const text = document.getText().substring(Math.max(0, offset - 20), offset);
            const start = regexLastIndexOf(text, /[\W\s]/g) + 1;
            const filterValue = text.substring(start).toLowerCase();
            flattenedCompletions = flattenedCompletions.filter((comp) =>
                comp.label.toLowerCase().includes(filterValue)
            );
        }

        const result = CompletionList.create(flattenedCompletions, isIncomplete);
        result.itemDefaults = itemDefaults;

        return result;
    }

    async resolveCompletion(
        textDocument: TextDocumentIdentifier,
        completionItem: AppCompletionItem,
        cancellationToken: CancellationToken
    ): Promise<CompletionItem> {
        const document = this.getDocument(textDocument.uri);

        const result = await this.execute<CompletionItem>(
            'resolveCompletion',
            [document, completionItem, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );

        return result ?? completionItem;
    }

    async formatDocument(
        textDocument: TextDocumentIdentifier,
        options: FormattingOptions
    ): Promise<TextEdit[]> {
        const document = this.getDocument(textDocument.uri);

        return (
            await this.execute<TextEdit[]>(
                'formatDocument',
                [document, options],
                ExecuteMode.Collect,
                'high'
            )
        ).flat();
    }

    async doTagComplete(
        textDocument: TextDocumentIdentifier,
        position: Position
    ): Promise<string | null> {
        const document = this.getDocument(textDocument.uri);

        return this.execute<string | null>(
            'doTagComplete',
            [document, position],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async getDocumentColors(textDocument: TextDocumentIdentifier): Promise<ColorInformation[]> {
        const document = this.getDocument(textDocument.uri);

        const result = await this.execute<ColorInformation[]>(
            'getDocumentColors',
            [document],
            ExecuteMode.Collect,
            'low'
        );
        return result?.flat() ?? [];
    }

    async getColorPresentations(
        textDocument: TextDocumentIdentifier,
        range: Range,
        color: Color
    ): Promise<ColorPresentation[]> {
        const document = this.getDocument(textDocument.uri);

        return (
            await this.execute<ColorPresentation[]>(
                'getColorPresentations',
                [document, range, color],
                ExecuteMode.Collect,
                'high'
            )
        ).flat();
    }

    async getDocumentSymbols(
        textDocument: TextDocumentIdentifier,
        cancellationToken: CancellationToken
    ): Promise<SymbolInformation[]> {
        const document = this.getDocument(textDocument.uri);

        // VS Code asks for document symbols twice (outline view and sticky scroll). Coalesce
        // them: the second request joins the first instead of racing it. This used to be a
        // flat 1s sleep, which cost every request a second to work around the duplicate.
        const key = `${document.uri}@${document.version}`;
        const inFlight = this.inFlightDocumentSymbols.get(key);
        if (inFlight) {
            return inFlight;
        }

        const pending = this.execute<SymbolInformation[]>(
            'getDocumentSymbols',
            [document, cancellationToken],
            ExecuteMode.Collect,
            'high'
        )
            .then((results) => results.flat())
            .finally(() => {
                if (this.inFlightDocumentSymbols.get(key) === pending) {
                    this.inFlightDocumentSymbols.delete(key);
                }
            });

        this.inFlightDocumentSymbols.set(key, pending);
        return pending;
    }

    private comparePosition(pos1: Position, pos2: Position) {
        if (pos1.line < pos2.line) return -1;
        if (pos1.line > pos2.line) return 1;
        if (pos1.character < pos2.character) return -1;
        if (pos1.character > pos2.character) return 1;
        return 0;
    }

    private rangeContains(parent: Range, child: Range) {
        return (
            this.comparePosition(parent.start, child.start) <= 0 &&
            this.comparePosition(child.end, parent.end) <= 0
        );
    }

    async getHierarchicalDocumentSymbols(
        textDocument: TextDocumentIdentifier,
        cancellationToken: CancellationToken
    ): Promise<DocumentSymbol[]> {
        const flat = await this.getDocumentSymbols(textDocument, cancellationToken);
        const symbols = flat
            .map((s) =>
                DocumentSymbol.create(
                    s.name,
                    undefined,
                    s.kind,
                    s.location.range,
                    s.location.range,
                    []
                )
            )
            .sort((a, b) => {
                const start = this.comparePosition(a.range.start, b.range.start);
                if (start !== 0) return start;
                return this.comparePosition(b.range.end, a.range.end);
            });

        const stack: DocumentSymbol[] = [];
        const roots: DocumentSymbol[] = [];

        for (const node of symbols) {
            while (stack.length > 0 && !this.rangeContains(stack.at(-1)!.range, node.range)) {
                stack.pop();
            }

            if (stack.length > 0) {
                stack.at(-1)!.children!.push(node);
            } else {
                roots.push(node);
            }

            stack.push(node);
        }

        return roots;
    }

    async getDefinitions(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<DefinitionLink[] | Location[]> {
        const document = this.getDocument(textDocument.uri);

        const definitions = (
            await this.execute<DefinitionLink[]>(
                'getDefinitions',
                [document, position, ...(cancellationToken ? [cancellationToken] : [])],
                ExecuteMode.Collect,
                'high'
            )
        ).flat();

        if (this.pluginHostConfig.definitionLinkSupport) {
            return definitions;
        } else {
            return definitions.map(
                (def) => <Location>{ range: def.targetSelectionRange, uri: def.targetUri }
            );
        }
    }

    async getCodeActions(
        textDocument: TextDocumentIdentifier,
        range: Range,
        context: CodeActionContext,
        cancellationToken: CancellationToken
    ): Promise<CodeAction[]> {
        const document = this.getDocument(textDocument.uri);

        const actions = (
            await this.execute<CodeAction[]>(
                'getCodeActions',
                [document, range, context, cancellationToken],
                ExecuteMode.Collect,
                'high'
            )
        ).flat();
        // Sort Svelte actions below other actions as they are often less relevant
        actions.sort((a, b) => {
            const aPrio = a.title.startsWith('(svelte)') ? 1 : 0;
            const bPrio = b.title.startsWith('(svelte)') ? 1 : 0;
            return aPrio - bPrio;
        });
        return actions;
    }

    async executeCommand(
        textDocument: TextDocumentIdentifier,
        command: string,
        args?: any[]
    ): Promise<WorkspaceEdit | string | null> {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<WorkspaceEdit>(
            'executeCommand',
            [document, command, args],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async resolveCodeAction(
        textDocument: TextDocumentIdentifier,
        codeAction: CodeAction,
        cancellationToken: CancellationToken
    ): Promise<CodeAction> {
        const document = this.getDocument(textDocument.uri);

        const result = await this.execute<CodeAction>(
            'resolveCodeAction',
            [document, codeAction, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );

        return result ?? codeAction;
    }

    async updateImports(fileRename: FileRename): Promise<WorkspaceEdit | null> {
        return await this.execute<WorkspaceEdit>(
            'updateImports',
            [fileRename],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async prepareRename(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Range | null> {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<any>(
            'prepareRename',
            [document, position, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async rename(
        textDocument: TextDocumentIdentifier,
        position: Position,
        newName: string,
        cancellationToken?: CancellationToken
    ): Promise<WorkspaceEdit | null> {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<any>(
            'rename',
            [document, position, newName, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async findReferences(
        textDocument: TextDocumentIdentifier,
        position: Position,
        context: ReferenceContext,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<any>(
            'findReferences',
            [document, position, context, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async fileReferences(
        uri: string,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        return await this.execute<any>(
            'fileReferences',
            [uri, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async findComponentReferences(
        uri: string,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        return await this.execute<any>(
            'findComponentReferences',
            [uri, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async getSignatureHelp(
        textDocument: TextDocumentIdentifier,
        position: Position,
        context: SignatureHelpContext | undefined,
        cancellationToken: CancellationToken
    ): Promise<SignatureHelp | null> {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<any>(
            'getSignatureHelp',
            [document, position, context, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    /**
     * The selection range supports multiple cursors,
     * each position should return its own selection range tree like `Array.map`.
     * Quote the LSP spec
     * > A selection range in the return array is for the position in the provided parameters at the same index. Therefore positions[i] must be contained in result[i].range.
     * @see https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_selectionRange
     *
     * Making PluginHost implement the same interface would make it quite hard to get
     * the corresponding selection range of each position from different plugins.
     * Therefore the special treatment here.
     */
    async getSelectionRanges(
        textDocument: TextDocumentIdentifier,
        positions: Position[],
        cancellationToken?: CancellationToken
    ): Promise<SelectionRange[] | null> {
        const document = this.getDocument(textDocument.uri);

        try {
            return Promise.all(
                positions.map(async (position) => {
                    for (const plugin of this.plugins) {
                        const range = cancellationToken
                            ? await plugin.getSelectionRange?.(
                                  document,
                                  position,
                                  cancellationToken
                              )
                            : await plugin.getSelectionRange?.(document, position);

                        if (range) {
                            return range;
                        }
                    }
                    return SelectionRange.create(Range.create(position, position));
                })
            );
        } catch (error) {
            Logger.error(error);
            return null;
        }
    }

    async getSemanticTokens(
        textDocument: TextDocumentIdentifier,
        range?: Range,
        cancellationToken?: CancellationToken
    ) {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<SemanticTokens>(
            'getSemanticTokens',
            [document, range, cancellationToken],
            ExecuteMode.FirstNonNull,
            'smart'
        );
    }

    async getLinkedEditingRanges(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<LinkedEditingRanges | null> {
        const document = this.getDocument(textDocument.uri);

        return await this.execute<LinkedEditingRanges>(
            'getLinkedEditingRanges',
            [document, position, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    getImplementation(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const document = this.getDocument(textDocument.uri);

        return this.execute<Location[] | null>(
            'getImplementation',
            [document, position, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    getTypeDefinition(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const document = this.getDocument(textDocument.uri);

        return this.execute<Location[] | null>(
            'getTypeDefinition',
            [document, position, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    getInlayHints(
        textDocument: TextDocumentIdentifier,
        range: Range,
        cancellationToken?: CancellationToken
    ): Promise<InlayHint[] | null> {
        const document = this.getDocument(textDocument.uri);

        return this.execute<InlayHint[] | null>(
            'getInlayHints',
            [document, range, cancellationToken],
            ExecuteMode.FirstNonNull,
            'smart'
        );
    }

    prepareCallHierarchy(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<CallHierarchyItem[] | null> {
        const document = this.getDocument(textDocument.uri);

        return this.execute<CallHierarchyItem[] | null>(
            'prepareCallHierarchy',
            [document, position, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    getIncomingCalls(
        item: CallHierarchyItem,
        cancellationToken?: CancellationToken | undefined
    ): Promise<CallHierarchyIncomingCall[] | null> {
        return this.execute<CallHierarchyIncomingCall[] | null>(
            'getIncomingCalls',
            [item, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    getOutgoingCalls(
        item: CallHierarchyItem,
        cancellationToken?: CancellationToken | undefined
    ): Promise<CallHierarchyOutgoingCall[] | null> {
        return this.execute<CallHierarchyOutgoingCall[] | null>(
            'getOutgoingCalls',
            [item, cancellationToken],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    async getCodeLens(textDocument: TextDocumentIdentifier, cancellationToken?: CancellationToken) {
        const document = this.getDocument(textDocument.uri);
        if (!document) {
            throw new Error('Cannot call methods on an unopened document');
        }

        const result = await this.execute<CodeLens[]>(
            'getCodeLens',
            [document, ...(cancellationToken ? [cancellationToken] : [])],
            ExecuteMode.Collect,
            'smart'
        );
        return result?.filter(Boolean).flat();
    }

    async getFoldingRanges(
        textDocument: TextDocumentIdentifier,
        cancellationToken?: CancellationToken
    ): Promise<FoldingRange[]> {
        const document = this.getDocument(textDocument.uri);

        const result = (
            await this.execute<FoldingRange[]>(
                'getFoldingRanges',
                [document, ...(cancellationToken ? [cancellationToken] : [])],
                ExecuteMode.Collect,
                'high'
            )
        ).flat();

        return result;
    }

    async resolveCodeLens(
        textDocument: TextDocumentIdentifier,
        codeLens: CodeLens,
        cancellationToken: CancellationToken
    ) {
        const document = this.getDocument(textDocument.uri);
        if (!document) {
            throw new Error('Cannot call methods on an unopened document');
        }

        return (
            (await this.execute<CodeLens>(
                'resolveCodeLens',
                [document, codeLens, cancellationToken],
                ExecuteMode.FirstNonNull,
                'smart'
            )) ?? codeLens
        );
    }

    findDocumentHighlight(
        textDocument: TextDocumentIdentifier,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<DocumentHighlight[] | null> {
        const document = this.getDocument(textDocument.uri);
        if (!document) {
            throw new Error('Cannot call methods on an unopened document');
        }

        return (
            this.execute<DocumentHighlight[] | null>(
                'findDocumentHighlight',
                [document, position, ...(cancellationToken ? [cancellationToken] : [])],
                ExecuteMode.FirstNonNull,
                'high'
            ) ?? [] // fall back to empty array to prevent fallback to word-based highlighting
        );
    }

    async getWorkspaceSymbols(
        query: string,
        token: CancellationToken
    ): Promise<WorkspaceSymbol[] | null> {
        return await this.execute<WorkspaceSymbol[]>(
            'getWorkspaceSymbols',
            [query, token],
            ExecuteMode.FirstNonNull,
            'high'
        );
    }

    onWatchFileChanges(onWatchFileChangesParas: OnWatchFileChangesPara[]): void {
        for (const support of this.plugins) {
            support.onWatchFileChanges?.(onWatchFileChangesParas);
        }
    }

    openTsOrJsFile(fileName: string, text: string, languageId: string, version?: number): void {
        for (const support of this.plugins) {
            support.openTsOrJsFile?.(fileName, text, languageId, version);
        }
    }

    updateTsOrJsFile(
        fileName: string,
        changes: TextDocumentContentChangeEvent[],
        text?: string,
        version?: number,
        languageId?: string
    ): void {
        for (const support of this.plugins) {
            support.updateTsOrJsFile?.(fileName, changes, text, version, languageId);
        }
    }

    closeTsOrJsFile(fileName: string): void {
        for (const support of this.plugins) {
            support.closeTsOrJsFile?.(fileName);
        }
    }

    private getDocument(uri: string) {
        const document = this.documentsManager.get(uri);
        if (!document) {
            throw new Error('Cannot call methods on an unopened document');
        }
        return document;
    }

    private execute<T>(
        name: keyof LSProvider,
        args: any[],
        mode: ExecuteMode.FirstNonNull,
        priority: 'low' | 'high' | 'smart'
    ): Promise<T | null>;
    private execute<T>(
        name: keyof LSProvider,
        args: any[],
        mode: ExecuteMode.Collect,
        priority: 'low' | 'high' | 'smart'
    ): Promise<T[]>;
    private execute(
        name: keyof LSProvider,
        args: any[],
        mode: ExecuteMode.None,
        priority: 'low' | 'high' | 'smart'
    ): Promise<void>;
    private async execute<T>(
        name: keyof LSProvider,
        args: any[],
        mode: ExecuteMode,
        priority: 'low' | 'high' | 'smart'
    ): Promise<(T | null) | T[] | void> {
        const plugins = this.plugins.filter((plugin) => typeof plugin[name] === 'function');
        // Priority 'smart' approximates how expensive a method is and demotes it to 'low'
        // when it's genuinely slow. Demotion is deliberately keyed on *this* method's own
        // measured cost: the previous heuristic also demoted whenever any three methods had
        // exceeded 400ms in the last minute, which on a large project penalised fast methods
        // with a full second of debounce for unrelated slowness.
        const now = performance.now();
        if (priority === 'smart' && this.requestTimings[name]?.[0] > SMART_DEMOTION_THRESHOLD_MS) {
            Logger.debug(`Executing next invocation of "${name}" with low priority`);
            priority = 'low';
            // Decay the recorded cost so a single slow run doesn't pin the method to 'low';
            // the next real execution re-measures it.
            this.requestTimings[name][0] = this.requestTimings[name][0] / 2 + 150;
        }

        if (priority === 'low') {
            // If a request doesn't have priority, we wait a little to
            // 1. let higher priority requests get through first
            // 2. wait for possible document changes, which make the request wait again
            // Due to waiting, low priority items should preferrably be those who do not
            // rely on positions or ranges and rather on the whole document only.
            const debounce = async (): Promise<boolean> => {
                const id = Math.random();
                this.deferredRequests[name] = [
                    id,
                    new Promise<void>((resolve, reject) => {
                        setTimeout(() => {
                            if (
                                !this.deferredRequests[name] ||
                                this.deferredRequests[name][0] === id
                            ) {
                                resolve();
                            } else {
                                // We should not get into this case. According to the spec,
                                // the language client does not send another request
                                // of the same type until the previous one is answered.
                                reject();
                            }
                        }, LOW_PRIORITY_DEBOUNCE_MS);
                    })
                ];
                try {
                    await this.deferredRequests[name][1];
                    if (!this.deferredRequests[name]) {
                        return debounce();
                    }
                    return true;
                } catch (e) {
                    return false;
                }
            };
            const shouldContinue = await debounce();
            if (!shouldContinue) {
                return;
            }
        }

        const startTime = performance.now();
        const result = await this.executePlugins(name, args, mode, plugins);
        this.requestTimings[name] = [performance.now() - startTime, startTime];
        return result;
    }

    private async executePlugins(
        name: keyof LSProvider,
        args: any[],
        mode: ExecuteMode,
        plugins: Plugin[]
    ) {
        switch (mode) {
            case ExecuteMode.FirstNonNull:
                for (const plugin of plugins) {
                    const res = await this.tryExecutePlugin(plugin, name, args, null);
                    if (res != null) {
                        return res;
                    }
                }
                return null;
            case ExecuteMode.Collect:
                return Promise.all(
                    plugins.map((plugin) => this.tryExecutePlugin(plugin, name, args, []))
                );
            case ExecuteMode.None:
                await Promise.all(
                    plugins.map((plugin) => this.tryExecutePlugin(plugin, name, args, null))
                );
                return;
        }
    }

    private async tryExecutePlugin(
        plugin: any,
        fnName: string,
        args: any[],
        failValue: any,
        propagateRequestCancelled = false
    ) {
        try {
            return await plugin[fnName](...args);
        } catch (e) {
            if (isRequestCancelled(e)) {
                if (propagateRequestCancelled) {
                    throw e;
                }
                return failValue;
            }
            Logger.error(e);
            return failValue;
        }
    }
}

function isRequestCancelled(error: unknown): error is ResponseError {
    return error instanceof ResponseError && error.code === LSPErrorCodes.RequestCancelled;
}

/**
 * A failed Svelte transform is reported twice when both diagnostic plugins are active: the
 * compiler supplies the useful named/code-linked error and the generated TypeScript snapshot
 * supplies a less precise parser fallback. Prefer the compiler result, but retain one fallback
 * when users deliberately disable Svelte diagnostics and leave JS/TS diagnostics enabled.
 */
function reconcileSvelteParserDiagnostics(
    diagnostics: Diagnostic[],
    document: Document
): Diagnostic[] {
    const compilerParserErrors = diagnostics.filter(
        (diagnostic) =>
            diagnostic.source === 'svelte' &&
            diagnostic.severity === 1 &&
            diagnostic.codeDescription?.href.includes('/compiler-errors#')
    );
    const fallbackIdentities = new Set<string>();
    const result: Diagnostic[] = [];

    for (const diagnostic of diagnostics) {
        const marked = !!(diagnostic as Diagnostic & { [SVELTE_PARSER_ERROR]?: boolean })[
            SVELTE_PARSER_ERROR
        ];
        if (
            (diagnostic.source === 'ts' || diagnostic.source === 'js') &&
            (compilerParserErrors.some((parserError) =>
                rangesNarrowlyOverlap(diagnostic.range, parserError.range, document)
            ) ||
                (marked &&
                    compilerParserErrors.some(
                        (parserError) =>
                            diagnosticRegion(parserError.range.start, document) ===
                            diagnosticRegion(diagnostic.range.start, document)
                    )))
        ) {
            continue;
        }
        if (!marked) {
            result.push(diagnostic);
            continue;
        }

        const identity = JSON.stringify([
            diagnostic.range,
            diagnostic.severity,
            diagnostic.source,
            diagnostic.code,
            diagnostic.message
        ]);
        if (fallbackIdentities.has(identity)) {
            continue;
        }
        fallbackIdentities.add(identity);
        const clean = { ...diagnostic } as Diagnostic & { [SVELTE_PARSER_ERROR]?: boolean };
        delete clean[SVELTE_PARSER_ERROR];
        result.push(clean);
    }

    return result;
}

/**
 * Suppress an unmarked generated diagnostic only when it maps onto the compiler's actual
 * parser-error span. Region-level matching is reserved for explicitly marked parser fallbacks:
 * one malformed tag must not hide every unrelated template type error. Conversely a
 * whole-document diagnostic only happens to overlap the parser span and may carry independent
 * project/configuration information, so keep it.
 */
function rangesNarrowlyOverlap(generated: Range, parser: Range, document: Document): boolean {
    const generatedStart = document.offsetAt(generated.start);
    const generatedEnd = document.offsetAt(generated.end);
    if (generatedStart === 0 && generatedEnd === document.getTextLength()) {
        return false;
    }

    const parserStart = document.offsetAt(parser.start);
    const parserEnd = document.offsetAt(parser.end);
    if (generatedStart === generatedEnd) {
        return parserStart <= generatedStart && generatedStart < parserEnd;
    }
    if (parserStart === parserEnd) {
        return generatedStart <= parserStart && parserStart < generatedEnd;
    }
    return generatedStart < parserEnd && parserStart < generatedEnd;
}

function diagnosticRegion(position: Position, document: Document): 'script' | 'style' | 'template' {
    if (isInTag(position, document.scriptInfo) || isInTag(position, document.moduleScriptInfo)) {
        return 'script';
    }
    return isInTag(position, document.styleInfo) ? 'style' : 'template';
}
