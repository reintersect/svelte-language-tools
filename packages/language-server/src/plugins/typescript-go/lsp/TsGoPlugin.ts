import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeLens,
    CompletionContext,
    CompletionItem,
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity,
    DefinitionLink,
    DocumentHighlight,
    FileChangeType,
    FoldingRange,
    Hover,
    InlayHint,
    Location,
    LocationLink,
    Position,
    Range,
    ReferenceContext,
    SelectionRange,
    SemanticTokens,
    SemanticTokensBuilder,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocumentContentChangeEvent,
    TextEdit,
    WorkspaceEdit,
    WorkspaceSymbol
} from 'vscode-languageserver';
import fs from 'fs';
import {
    Document,
    DocumentManager,
    getNodeIfIsInComponentStartTag,
    isInTag,
    mapRangeToGenerated,
    mapRangeToOriginal
} from '../../../lib/documents';
import { getSemanticTokenLegends } from '../../../lib/semanticToken/semanticTokenLegend';
import { Logger } from '../../../logger';
import { isNotNullOrUndefined, isZeroLengthRange, pathToUrl, urlToPath } from '../../../utils';
import { SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { isInGeneratedCode } from '../../typescript/features/utils';
import { isInScript } from '../../typescript/utils';
import {
    AppCompletionItem,
    AppCompletionList,
    FileRename,
    OnWatchFileChangesPara,
    Plugin
} from '../../interfaces';
import {
    buildLegendMap,
    decodeSemanticTokens,
    isMapped,
    mapLocationBack,
    mapTokenRangeBack,
    mapWorkspaceEditBack
} from './mapping';
import { ShadowManager } from './ShadowManager';
import { TsGoComponentInfo } from './TsGoComponentInfo';
import { TsGoServer } from './TsGoServer';

/** How the request was served, so a "green" test run that silently fell back is detectable. */
export interface TsGoStats {
    served: number;
    fellBack: number;
    fallbackReasons: Map<string, number>;
}

interface TsGoPluginOptions {
    server: TsGoServer;
    shadows: ShadowManager;
    docManager: DocumentManager;
    componentInfo?: TsGoComponentInfo;
}

/**
 * Serves TypeScript language features for `.svelte` files by proxying a child `tsgo --lsp`
 * over generated `.tsx` shadows.
 *
 * Requests go out in *generated* coordinates and responses are mapped back here. Nothing below
 * this class knows about `.svelte` files.
 */
export class TsGoPlugin implements Plugin {
    __name = 'tsgo';

    readonly stats: TsGoStats = { served: 0, fellBack: 0, fallbackReasons: new Map() };

    private readonly server: TsGoServer;
    private readonly shadows: ShadowManager;
    private readonly docManager: DocumentManager;
    private readonly componentInfo: TsGoComponentInfo | undefined;
    private eagerOpenDone: Promise<void> | undefined;
    /** null once we've looked and found no legend to translate through. */
    private legendMap: number[] | null | undefined;

    constructor(options: TsGoPluginOptions) {
        this.server = options.server;
        this.shadows = options.shadows;
        this.docManager = options.docManager;
        this.componentInfo = options.componentInfo;
    }

    /**
     * Resolve the component whose start tag the caret sits in, if any.
     *
     * Mirrors the JS engine's `getComponentAtPosition`: skip when inside a <script>, find the
     * enclosing component start tag in the HTML AST, then look up the tag *name*'s position in
     * generated code — that is where the component's type actually lives.
     */
    private componentOffsetAt(
        document: Document,
        snapshot: SvelteDocumentSnapshot,
        position: Position
    ): number | undefined {
        if (snapshot.parserError) {
            return undefined;
        }
        if (
            isInTag(position, document.scriptInfo) ||
            isInTag(position, document.moduleScriptInfo)
        ) {
            return undefined;
        }
        const node = getNodeIfIsInComponentStartTag(
            document.html,
            document,
            document.offsetAt(position)
        );
        if (!node) {
            return undefined;
        }
        const generated = snapshot.getGeneratedPosition(document.positionAt(node.start + 1));
        if (generated.line < 0) {
            return undefined;
        }

        // The mapped offset lands on the generated block for this element, not on the component
        // identifier: svelte2tsx emits `const $$_xyz = __sveltets_2_ensureComponent(Foo);` and
        // asking for the type of `$$_xyz` yields `LegacyComponentType`, whose props carrier is a
        // bare `Record<string, any>`. Anchor to the identifier inside `ensureComponent(...)`,
        // which is where the component's declared type actually lives.
        const generatedText = snapshot.getFullText();
        const from = snapshot.offsetAt(generated);
        // The mapped offset usually lands just *after* the call: svelte2tsx emits
        // `{ const $$_x = __sveltets_2_ensureComponent(Tag); new $$_x({...}) }` and the tag's
        // source position maps onto the temp variable. So look backwards first, then forwards
        // for the cases where it lands before the call.
        const behind = generatedText.lastIndexOf(ENSURE_COMPONENT, from);
        const ahead = generatedText.indexOf(ENSURE_COMPONENT, from);
        let call = -1;
        if (behind >= 0 && from - behind <= ENSURE_COMPONENT_SEARCH_WINDOW) {
            call = behind;
        } else if (ahead >= 0 && ahead - from <= ENSURE_COMPONENT_SEARCH_WINDOW) {
            call = ahead;
        }
        if (call < 0) {
            return undefined;
        }
        const identifierStart = call + ENSURE_COMPONENT.length;
        // `<Foo.Bar>` generates `ensureComponent(Foo.Bar)`; the component type is on the last
        // segment, matching what the JS engine does with `symbolPosWithinNode`.
        const identifierEnd = generatedText.indexOf(')', identifierStart);
        const identifier = generatedText.slice(identifierStart, identifierEnd);
        const lastDot = identifier.lastIndexOf('.');
        return lastDot >= 0 ? identifierStart + lastDot + 1 : identifierStart;
    }

    private fallback(reason: string): null {
        this.stats.fellBack++;
        this.stats.fallbackReasons.set(reason, (this.stats.fallbackReasons.get(reason) ?? 0) + 1);
        return null;
    }

    /**
     * Push every project `.svelte` file's shadow into tsgo.
     *
     * This has to happen eagerly rather than on demand. A shadow only participates in module
     * resolution once it has been opened, and when it hasn't, svelte's ambient
     * `declare module '*.svelte'` absorbs the failed resolution: no TS2307, no error, just
     * every import silently typed `any`. Lazy opening cannot detect its own failure.
     */
    private async ensureProjectOpened(): Promise<void> {
        this.eagerOpenDone ??= (async () => {
            const files = [
                ...this.shadows.findProjectSvelteFiles(),
                ...this.shadows.findDependencySvelteFiles()
            ];
            Logger.log(`[tsgo] materialising ${files.length} shadows`);
            const started = Date.now();
            const written = new Set<string>();
            for (const filePath of files) {
                try {
                    const uri = pathToUrl(filePath);
                    // Reuse the client's buffer when the file is already open in the editor so
                    // an unsaved edit isn't clobbered by the on-disk text — but otherwise build
                    // a detached Document rather than registering it with the DocumentManager.
                    // Registering would emit documentOpen/documentChange, which the JS engine
                    // listens to, making *both* engines eagerly load the entire project.
                    const document =
                        this.docManager.get(uri) ??
                        new Document(uri, fs.readFileSync(filePath, 'utf8'));
                    const snapshot = this.shadows.transform(document);
                    const shadowPath = this.shadows.getShadowPath(filePath);
                    this.shadows.writeShadow(shadowPath, snapshot.getFullText());
                    written.add(shadowPath);
                } catch (e) {
                    Logger.debug(`[tsgo] could not materialise shadow for ${filePath}`, e);
                }
            }
            this.shadows.pruneOrphanedShadows(written);
            Logger.log(`[tsgo] materialised ${written.size} shadows in ${Date.now() - started}ms`);
        })();
        return this.eagerOpenDone;
    }

    /** Bring a document's shadow up to date and hand back what's needed to map positions. */
    private async syncDocument(
        document: Document
    ): Promise<{ snapshot: SvelteDocumentSnapshot; shadowPath: string } | null> {
        const filePath = document.getFilePath();
        if (!filePath || !filePath.endsWith('.svelte')) {
            return null;
        }
        await this.ensureProjectOpened();

        const snapshot = this.shadows.transform(document);
        const shadowPath = this.shadows.getShadowPath(filePath);

        // Only documents the editor actually has open become LSP overlays; everything else
        // lives on disk. Each didOpen costs tsgo a synchronous snapshot rebuild, so this stays
        // proportional to what the user is looking at rather than to project size.
        const text = snapshot.getFullText();
        if (this.server.isOpen(shadowPath)) {
            // Full-text sync for now. Ranged changes derived from computeChangeRange are a
            // later optimisation; correctness first.
            await this.server.updateDocument(shadowPath, [{ text }], text);
        } else {
            this.shadows.ensureShadowDirectory(shadowPath);
            await this.server.openDocument(shadowPath, text);
        }
        return { snapshot, shadowPath };
    }

    async getDiagnostics(
        document: Document,
        cancellationToken?: CancellationToken
    ): Promise<Diagnostic[]> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        const { snapshot, shadowPath } = synced;

        // A template that doesn't parse yields no usable generated code; report the parser
        // error rather than a cascade of nonsense from the fallback text.
        if (snapshot.parserError) {
            return [
                {
                    range: snapshot.parserError.range,
                    severity: DiagnosticSeverity.Error,
                    source: 'svelte',
                    message: snapshot.parserError.message,
                    code: snapshot.parserError.code
                }
            ];
        }

        if (cancellationToken?.isCancellationRequested) {
            return [];
        }

        let report: any;
        try {
            report = await this.server.sendRequest('textDocument/diagnostic', {
                textDocument: { uri: pathToUrl(shadowPath) }
            });
        } catch (e) {
            Logger.debug('[tsgo] diagnostic request failed', e);
            this.fallback('diagnostic-request-failed');
            return [];
        }

        const items: any[] = report?.items ?? [];
        this.stats.served++;

        const generatedText = snapshot.getFullText();

        return items
            .map((diagnostic) => {
                // svelte2tsx wraps its own scaffolding in Ω ignore markers. Diagnostics inside
                // those regions are about generated code the user never wrote — reporting them
                // is how you get "'x' is declared but never read" on an invisible variable.
                const startOffset = snapshot.offsetAt(diagnostic.range.start);
                const endOffset = snapshot.offsetAt(diagnostic.range.end);
                if (isInGeneratedCode(generatedText, startOffset, endOffset)) {
                    return null;
                }

                const range = mapRangeToOriginal(snapshot, diagnostic.range);
                // A negative line means the span lives purely in generated code with no
                // counterpart in the original file; showing it would put a squiggle on an
                // arbitrary token.
                if (range.start.line < 0 || range.end.line < 0) {
                    return null;
                }
                return {
                    ...diagnostic,
                    range,
                    source: 'ts'
                } as Diagnostic;
            })
            .filter(isNotNullOrUndefined);
    }

    async doHover(document: Document, position: Position): Promise<Hover | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const { snapshot, shadowPath } = synced;

        const componentOffset = this.componentInfo
            ? this.componentOffsetAt(document, snapshot, position)
            : undefined;
        if (componentOffset !== undefined) {
            const props = await this.componentInfo!.getProps(shadowPath, componentOffset);
            if (props.length) {
                this.stats.served++;
                const rendered = props.map((prop) => `  ${prop.name}: ${prop.type}`).join('\n');
                return {
                    contents: {
                        kind: 'markdown',
                        value: '```typescript\n{\n' + rendered + '\n}\n```'
                    }
                };
            }
        }

        const generated = snapshot.getGeneratedPosition(position);
        if (generated.line < 0) {
            return null;
        }

        const hover: any = await this.server.sendRequest('textDocument/hover', {
            textDocument: { uri: pathToUrl(shadowPath) },
            position: generated
        });
        if (!hover) {
            return null;
        }
        this.stats.served++;
        return {
            contents: hover.contents,
            range: hover.range ? mapRangeToOriginal(snapshot, hover.range) : undefined
        };
    }

    async getCompletions(
        document: Document,
        position: Position,
        completionContext?: CompletionContext,
        cancellationToken?: CancellationToken
    ): Promise<AppCompletionList | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const { snapshot, shadowPath } = synced;

        // Inside a component start tag the useful completions are the component's props, which
        // are a property of its *type* — no LSP request produces them, so this goes through the
        // attached checker session instead.
        const componentOffset = this.componentInfo
            ? this.componentOffsetAt(document, snapshot, position)
            : undefined;
        if (componentOffset !== undefined) {
            const props = await this.componentInfo!.getProps(shadowPath, componentOffset);
            if (props.length) {
                this.stats.served++;
                return {
                    isIncomplete: false,
                    items: props.map((prop) => ({
                        label: prop.name,
                        kind: CompletionItemKind.Field,
                        detail: prop.type,
                        documentation: prop.doc ? { kind: 'markdown', value: prop.doc } : undefined,
                        sortText: '0' + prop.name
                    })) as CompletionItem[]
                };
            }
        }

        const generated = snapshot.getGeneratedPosition(position);
        if (generated.line < 0 || cancellationToken?.isCancellationRequested) {
            return null;
        }

        const result: any = await this.server.sendRequest('textDocument/completion', {
            textDocument: { uri: pathToUrl(shadowPath) },
            position: generated,
            context: completionContext
        });
        if (!result) {
            return null;
        }
        this.stats.served++;

        const rawItems: any[] = Array.isArray(result) ? result : (result.items ?? []);
        const items: CompletionItem[] = rawItems.map((item) => {
            const mapped: CompletionItem = { ...item };
            // Component completions surface as `Button__SvelteComponent_`; the user wants to
            // see and insert `Button`.
            if (typeof mapped.label === 'string') {
                mapped.label = stripComponentSuffix(mapped.label);
            }
            if (typeof mapped.insertText === 'string') {
                mapped.insertText = stripComponentSuffix(mapped.insertText);
            }
            if (item.textEdit?.range) {
                const range = mapRangeToOriginal(snapshot, item.textEdit.range);
                mapped.textEdit =
                    range.start.line < 0
                        ? undefined
                        : {
                              ...item.textEdit,
                              range,
                              newText: stripComponentSuffix(item.textEdit.newText)
                          };
            }
            return mapped;
        });

        return {
            isIncomplete: Array.isArray(result) ? false : (result.isIncomplete ?? false),
            items
        };
    }

    // ---------------------------------------------------------------------------------------
    // Position-in / locations-out features. All share the same shape: map the caret into
    // generated coordinates, ask tsgo, then translate every returned location back — dropping
    // any that resolve purely into svelte2tsx scaffolding.
    // ---------------------------------------------------------------------------------------

    private async requestAt<T>(
        document: Document,
        position: Position,
        method: string,
        extra: Record<string, unknown> = {}
    ): Promise<{ result: T; snapshot: SvelteDocumentSnapshot } | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const generated = synced.snapshot.getGeneratedPosition(position);
        if (generated.line < 0) {
            return null;
        }
        try {
            const result = await this.server.sendRequest<T>(method, {
                textDocument: { uri: pathToUrl(synced.shadowPath) },
                position: generated,
                ...extra
            });
            this.stats.served++;
            return { result, snapshot: synced.snapshot };
        } catch (e) {
            Logger.debug(`[tsgo] ${method} failed`, e);
            this.fallback(method);
            return null;
        }
    }

    /** Normalise the several shapes tsgo may return for a goto-style request into Locations. */
    private toLocations(result: any): Location[] {
        if (!result) {
            return [];
        }
        const raw: any[] = Array.isArray(result) ? result : [result];
        return raw
            .map((entry) => {
                const uri: string = entry.targetUri ?? entry.uri;
                const range: Range = entry.targetSelectionRange ?? entry.targetRange ?? entry.range;
                if (!uri || !range) {
                    return undefined;
                }
                return mapLocationBack(this.shadows, uri, range);
            })
            .filter(isNotNullOrUndefined);
    }

    async getDefinitions(document: Document, position: Position): Promise<DefinitionLink[]> {
        const response = await this.requestAt<any>(document, position, 'textDocument/definition');
        if (!response) {
            return [];
        }
        return this.toLocations(response.result).map((location) =>
            LocationLink.create(location.uri, location.range, location.range)
        );
    }

    async getTypeDefinition(document: Document, position: Position): Promise<Location[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/typeDefinition'
        );
        return response ? this.toLocations(response.result) : null;
    }

    async getImplementation(document: Document, position: Position): Promise<Location[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/implementation'
        );
        return response ? this.toLocations(response.result) : null;
    }

    async findReferences(
        document: Document,
        position: Position,
        context: ReferenceContext
    ): Promise<Location[] | null> {
        const response = await this.requestAt<any>(document, position, 'textDocument/references', {
            context: { includeDeclaration: context?.includeDeclaration ?? true }
        });
        return response ? this.toLocations(response.result) : null;
    }

    async findDocumentHighlight(
        document: Document,
        position: Position
    ): Promise<DocumentHighlight[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/documentHighlight'
        );
        if (!response) {
            return null;
        }
        const highlights: any[] = response.result ?? [];
        return highlights
            .map((highlight) => {
                const range = mapRangeToOriginal(response.snapshot, highlight.range);
                return isMapped(range) ? { ...highlight, range } : undefined;
            })
            .filter(isNotNullOrUndefined);
    }

    async getSignatureHelp(
        document: Document,
        position: Position,
        context: SignatureHelpContext | undefined
    ): Promise<SignatureHelp | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/signatureHelp',
            context ? { context } : {}
        );
        return response?.result ?? null;
    }

    async getSelectionRange(
        document: Document,
        position: Position
    ): Promise<SelectionRange | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const generated = synced.snapshot.getGeneratedPosition(position);
        if (generated.line < 0) {
            return null;
        }
        const result: any = await this.server.sendRequest('textDocument/selectionRange', {
            textDocument: { uri: pathToUrl(synced.shadowPath) },
            positions: [generated]
        });
        const first = Array.isArray(result) ? result[0] : result;
        if (!first) {
            return null;
        }
        this.stats.served++;

        // Walk the parent chain, keeping only the levels that survive mapping.
        const levels: Range[] = [];
        for (let node = first; node; node = node.parent) {
            const range = mapRangeToOriginal(synced.snapshot, node.range);
            if (isMapped(range)) {
                levels.push(range);
            }
        }
        if (!levels.length) {
            return null;
        }
        return levels.reduceRight<SelectionRange | undefined>(
            (parent, range) => SelectionRange.create(range, parent),
            undefined
        )!;
    }

    // ---------------------------------------------------------------------------------------
    // Whole-document features.
    // ---------------------------------------------------------------------------------------

    async getSemanticTokens(document: Document, range?: Range): Promise<SemanticTokens | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const { snapshot, shadowPath } = synced;

        let result: any;
        try {
            // Always ask for the full document: a range request would need the *generated*
            // range, and mapping a partial range risks clipping tokens at the boundary.
            result = await this.server.sendRequest('textDocument/semanticTokens/full', {
                textDocument: { uri: pathToUrl(shadowPath) }
            });
        } catch (e) {
            Logger.debug('[tsgo] semanticTokens failed', e);
            this.fallback('semanticTokens');
            return null;
        }
        if (!result?.data?.length) {
            return { data: [] };
        }
        this.stats.served++;

        const legendMap = this.getLegendMap();
        const builder = new SemanticTokensBuilder();
        const mapped: Array<[number, number, number, number, number]> = [];

        for (const [line, char, length, type, modifiers] of decodeSemanticTokens(result.data)) {
            const tokenType = legendMap ? legendMap[type] : type;
            if (tokenType === undefined || tokenType < 0) {
                continue;
            }
            const target = mapTokenRangeBack(snapshot, line, char, length);
            if (!target) {
                continue;
            }
            if (range && (target.line < range.start.line || target.line > range.end.line)) {
                continue;
            }
            mapped.push([target.line, target.char, target.length, tokenType, modifiers]);
        }

        // The builder requires ascending order, and mapping can reorder tokens.
        mapped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const token of mapped) {
            builder.push(...token);
        }
        return builder.build();
    }

    async getDocumentSymbols(document: Document): Promise<SymbolInformation[]> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        const result: any = await this.server.sendRequest('textDocument/documentSymbol', {
            textDocument: { uri: pathToUrl(synced.shadowPath) }
        });
        if (!Array.isArray(result)) {
            return [];
        }
        this.stats.served++;

        const out: SymbolInformation[] = [];
        const generatedText = synced.snapshot.getFullText();
        const visit = (node: any, container?: string) => {
            const selection = node.selectionRange ?? node.range ?? node.location?.range;
            if (!selection) {
                return;
            }
            const mapped = mapRangeToOriginal(synced.snapshot, selection);
            // The shadow is .tsx, so every element in the generated template shows up as a JSX
            // symbol (`div.flex.items-center`, `X.size-5`, ...). Markup already has an outline
            // from the HTML plugin, so TypeScript should only contribute symbols that actually
            // live in a <script> block. Plus svelte2tsx's own scaffolding by name.
            const isSynthetic =
                SYNTHETIC_SYMBOLS.has(node.name) ||
                node.name.startsWith('__sveltets_') ||
                node.name.startsWith('$$_') ||
                isZeroLengthRange(mapped) ||
                !isInScript(mapped.start, synced.snapshot) ||
                isInGeneratedCode(
                    generatedText,
                    synced.snapshot.offsetAt(selection.start),
                    synced.snapshot.offsetAt(selection.end)
                );
            if (!isSynthetic && isMapped(mapped)) {
                out.push({
                    name: node.name,
                    kind: node.kind,
                    location: Location.create(document.uri, mapped),
                    containerName: container
                });
            }
            for (const child of node.children ?? []) {
                visit(child, isSynthetic ? container : node.name);
            }
        };
        for (const node of result) {
            visit(node);
        }
        return out;
    }

    async getInlayHints(document: Document, range: Range): Promise<InlayHint[] | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const start = synced.snapshot.getGeneratedPosition(range.start);
        const end = synced.snapshot.getGeneratedPosition(range.end);
        if (start.line < 0 || end.line < 0) {
            return null;
        }
        const result: any = await this.server.sendRequest('textDocument/inlayHint', {
            textDocument: { uri: pathToUrl(synced.shadowPath) },
            range: { start, end }
        });
        if (!Array.isArray(result)) {
            return null;
        }
        this.stats.served++;
        return result
            .map((hint) => {
                const position = synced.snapshot.getOriginalPosition(hint.position);
                if (position.line < 0) {
                    return undefined;
                }
                // Hints carry edits and location links that point into generated code; drop
                // them rather than offer an edit that would land in the wrong file.
                return { ...hint, position, textEdits: undefined, label: hint.label };
            })
            .filter(isNotNullOrUndefined);
    }

    async getFoldingRanges(document: Document): Promise<FoldingRange[]> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        const result: any = await this.server.sendRequest('textDocument/foldingRange', {
            textDocument: { uri: pathToUrl(synced.shadowPath) }
        });
        if (!Array.isArray(result)) {
            return [];
        }
        this.stats.served++;
        return result
            .map((folding) => {
                const mapped = mapRangeToOriginal(synced.snapshot, {
                    start: { line: folding.startLine, character: folding.startCharacter ?? 0 },
                    end: { line: folding.endLine, character: folding.endCharacter ?? 0 }
                });
                if (!isMapped(mapped) || mapped.end.line <= mapped.start.line) {
                    return undefined;
                }
                return FoldingRange.create(
                    mapped.start.line,
                    mapped.end.line,
                    undefined,
                    undefined,
                    folding.kind
                );
            })
            .filter(isNotNullOrUndefined);
    }

    // ---------------------------------------------------------------------------------------
    // Edit-producing features.
    // ---------------------------------------------------------------------------------------

    async prepareRename(document: Document, position: Position): Promise<Range | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/prepareRename'
        );
        if (!response?.result) {
            return null;
        }
        const raw = response.result.range ?? response.result;
        const mapped = mapRangeToOriginal(response.snapshot, raw);
        return isMapped(mapped) ? mapped : null;
    }

    async rename(
        document: Document,
        position: Position,
        newName: string
    ): Promise<WorkspaceEdit | null> {
        const response = await this.requestAt<WorkspaceEdit>(
            document,
            position,
            'textDocument/rename',
            { newName }
        );
        return response ? mapWorkspaceEditBack(this.shadows, response.result) : null;
    }

    async getCodeActions(
        document: Document,
        range: Range,
        context: CodeActionContext
    ): Promise<CodeAction[]> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        const start = synced.snapshot.getGeneratedPosition(range.start);
        const end = synced.snapshot.getGeneratedPosition(range.end);
        if (start.line < 0 || end.line < 0) {
            return [];
        }

        // Diagnostics have to travel in generated coordinates too, or tsgo won't match them to
        // the quick fixes it knows about.
        const diagnostics = (context?.diagnostics ?? [])
            .map((diagnostic) => {
                const generated = mapRangeToGenerated(synced.snapshot, diagnostic.range);
                return isMapped(generated) ? { ...diagnostic, range: generated } : undefined;
            })
            .filter(isNotNullOrUndefined);

        let result: any;
        try {
            result = await this.server.sendRequest('textDocument/codeAction', {
                textDocument: { uri: pathToUrl(synced.shadowPath) },
                range: { start, end },
                context: { diagnostics, only: context?.only }
            });
        } catch (e) {
            Logger.debug('[tsgo] codeAction failed', e);
            this.fallback('codeAction');
            return [];
        }
        if (!Array.isArray(result)) {
            return [];
        }
        this.stats.served++;

        return result
            .map((action) => {
                if (!action.edit) {
                    // Unresolved actions carry a `data` payload we hand back verbatim on resolve.
                    return action as CodeAction;
                }
                const edit = mapWorkspaceEditBack(this.shadows, action.edit);
                return edit ? { ...action, edit } : undefined;
            })
            .filter(isNotNullOrUndefined);
    }

    async resolveCodeAction(_document: Document, codeAction: CodeAction): Promise<CodeAction> {
        try {
            const resolved: any = await this.server.sendRequest('codeAction/resolve', codeAction);
            const edit = mapWorkspaceEditBack(this.shadows, resolved?.edit);
            return edit ? { ...resolved, edit } : codeAction;
        } catch (e) {
            Logger.debug('[tsgo] codeAction/resolve failed', e);
            return codeAction;
        }
    }

    async resolveCompletion(
        _document: Document,
        completionItem: AppCompletionItem
    ): Promise<AppCompletionItem> {
        try {
            const resolved: any = await this.server.sendRequest(
                'completionItem/resolve',
                completionItem
            );
            if (!resolved) {
                return completionItem;
            }
            // additionalTextEdits are auto-imports written into the generated file; they have to
            // come back to the original or they would be applied at the wrong offset.
            const additionalTextEdits = resolved.additionalTextEdits
                ? this.mapEditsForDocument(_document, resolved.additionalTextEdits)
                : undefined;
            return { ...completionItem, ...resolved, additionalTextEdits };
        } catch (e) {
            Logger.debug('[tsgo] completionItem/resolve failed', e);
            return completionItem;
        }
    }

    private mapEditsForDocument(document: Document, edits: TextEdit[]): TextEdit[] | undefined {
        const filePath = document.getFilePath();
        const snapshot = filePath ? this.shadows.getSnapshot(filePath) : undefined;
        if (!snapshot) {
            return undefined;
        }
        const mapped = edits
            .map((textEdit) => {
                const range = mapRangeToOriginal(snapshot, textEdit.range);
                return isMapped(range) ? { ...textEdit, range } : undefined;
            })
            .filter(isNotNullOrUndefined);
        return mapped.length ? mapped : undefined;
    }

    async updateImports(fileRename: FileRename): Promise<WorkspaceEdit | null> {
        // Rename the shadow, not the source: tsgo only knows about generated paths.
        const oldPath = urlToPath(fileRename.oldUri);
        const newPath = urlToPath(fileRename.newUri);
        if (!oldPath || !newPath) {
            return null;
        }
        try {
            const result: WorkspaceEdit = await this.server.sendRequest(
                'workspace/willRenameFiles',
                {
                    files: [
                        {
                            oldUri: pathToUrl(this.shadows.getShadowPath(oldPath)),
                            newUri: pathToUrl(this.shadows.getShadowPath(newPath))
                        }
                    ]
                }
            );
            return mapWorkspaceEditBack(this.shadows, result);
        } catch (e) {
            Logger.debug('[tsgo] willRenameFiles failed', e);
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Project-wide features.
    // ---------------------------------------------------------------------------------------

    async getWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[] | null> {
        await this.ensureProjectOpened();
        try {
            const result: any = await this.server.sendRequest('workspace/symbol', { query });
            if (!Array.isArray(result)) {
                return null;
            }
            this.stats.served++;
            return result
                .map((symbol) => {
                    const location = symbol.location;
                    if (!location?.range) {
                        return undefined;
                    }
                    const mappedLocation = mapLocationBack(
                        this.shadows,
                        location.uri,
                        location.range
                    );
                    return mappedLocation ? { ...symbol, location: mappedLocation } : undefined;
                })
                .filter(isNotNullOrUndefined);
        } catch (e) {
            Logger.debug('[tsgo] workspace/symbol failed', e);
            return null;
        }
    }

    async fileReferences(uri: string): Promise<Location[] | null> {
        // tsgo has no file-references request; approximate it by asking for references to the
        // component's default export, which is what the JS engine surfaces in practice.
        return this.findComponentReferences(uri);
    }

    async findComponentReferences(uri: string): Promise<Location[] | null> {
        const filePath = urlToPath(uri);
        if (!filePath) {
            return null;
        }
        await this.ensureProjectOpened();
        const snapshot = this.shadows.getSnapshot(filePath);
        if (!snapshot) {
            return null;
        }
        // The synthesized component class sits at the end of the generated file; referencing
        // its declaration is what "find component references" means.
        const generatedText = snapshot.getFullText();
        const marker = generatedText.lastIndexOf('export default class');
        if (marker < 0) {
            return null;
        }
        const position = snapshot.positionAt(marker + 'export default class '.length);
        try {
            const result: any = await this.server.sendRequest('textDocument/references', {
                textDocument: { uri: pathToUrl(this.shadows.getShadowPath(filePath)) },
                position,
                context: { includeDeclaration: false }
            });
            return this.toLocations(result);
        } catch (e) {
            Logger.debug('[tsgo] component references failed', e);
            return null;
        }
    }

    async prepareCallHierarchy(
        document: Document,
        position: Position
    ): Promise<CallHierarchyItem[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/prepareCallHierarchy'
        );
        if (!Array.isArray(response?.result)) {
            return null;
        }
        return response!.result
            .map((item: any) => this.mapCallHierarchyItem(item))
            .filter(isNotNullOrUndefined);
    }

    private mapCallHierarchyItem(item: any): CallHierarchyItem | undefined {
        const location = mapLocationBack(this.shadows, item.uri, item.selectionRange ?? item.range);
        if (!location) {
            return undefined;
        }
        const full = mapLocationBack(this.shadows, item.uri, item.range) ?? location;
        return { ...item, uri: location.uri, range: full.range, selectionRange: location.range };
    }

    async getIncomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[] | null> {
        return this.callHierarchyCalls('callHierarchy/incomingCalls', item, 'from');
    }

    async getOutgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
        return this.callHierarchyCalls('callHierarchy/outgoingCalls', item, 'to');
    }

    private async callHierarchyCalls(method: string, item: CallHierarchyItem, key: 'from' | 'to') {
        // Send the item back in generated coordinates, which is where tsgo left it.
        const filePath = urlToPath(item.uri);
        const snapshot = filePath ? this.shadows.getSnapshot(filePath) : undefined;
        const generatedItem = snapshot
            ? {
                  ...item,
                  uri: pathToUrl(this.shadows.getShadowPath(filePath!)),
                  range: mapRangeToGenerated(snapshot, item.range),
                  selectionRange: mapRangeToGenerated(snapshot, item.selectionRange)
              }
            : item;

        try {
            const result: any = await this.server.sendRequest(method, { item: generatedItem });
            if (!Array.isArray(result)) {
                return null;
            }
            return result
                .map((call: any) => {
                    const mappedItem = this.mapCallHierarchyItem(call[key]);
                    if (!mappedItem) {
                        return undefined;
                    }
                    const target = urlToPath(call[key].uri);
                    const targetOriginal = target
                        ? this.shadows.getOriginalPath(target)
                        : undefined;
                    const targetSnapshot = targetOriginal
                        ? this.shadows.getSnapshot(targetOriginal)
                        : undefined;
                    const fromRanges = (call.fromRanges ?? [])
                        .map((r: Range) =>
                            targetSnapshot ? mapRangeToOriginal(targetSnapshot, r) : r
                        )
                        .filter(isMapped);
                    return { [key]: mappedItem, fromRanges } as any;
                })
                .filter(isNotNullOrUndefined);
        } catch (e) {
            Logger.debug(`[tsgo] ${method} failed`, e);
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Lifecycle.
    // ---------------------------------------------------------------------------------------

    /** Code lens is not offered: tsgo returns null for it unless a config we don't send is set. */
    async getCodeLens(): Promise<CodeLens[] | null> {
        return null;
    }

    async resolveCodeLens(_document: Document, codeLens: CodeLens): Promise<CodeLens> {
        return codeLens;
    }

    async executeCommand(): Promise<null> {
        return null;
    }

    updateTsOrJsFile(fileName: string, changes: TextDocumentContentChangeEvent[]): void {
        // Plain .ts/.js files live on disk and tsgo watches them; only editor-open buffers need
        // forwarding, and those arrive through the document manager instead.
        void fileName;
        void changes;
    }

    onWatchFileChanges(changes: OnWatchFileChangesPara[]): void {
        for (const change of changes) {
            if (!change.fileName.endsWith('.svelte')) {
                continue;
            }
            const shadowPath = this.shadows.getShadowPath(change.fileName);
            if (change.changeType === FileChangeType.Deleted) {
                this.shadows.deleteSnapshot(change.fileName);
                this.shadows.removeShadow(shadowPath);
                void this.server.closeDocument(shadowPath);
                continue;
            }
            try {
                const text = fs.readFileSync(change.fileName, 'utf8');
                const document = new Document(pathToUrl(change.fileName), text);
                const snapshot = this.shadows.transform(document);
                this.shadows.writeShadow(shadowPath, snapshot.getFullText());
            } catch (e) {
                Logger.debug(`[tsgo] could not refresh shadow for ${change.fileName}`, e);
            }
        }
    }

    private getLegendMap(): number[] | undefined {
        if (this.legendMap === undefined) {
            const legend = this.server.getTokenLegend();
            this.legendMap = legend
                ? buildLegendMap(legend.tokenTypes, getSemanticTokenLegends().tokenTypes)
                : null;
        }
        return this.legendMap ?? undefined;
    }

    dispose() {
        this.server.dispose();
    }
}

/** Names svelte2tsx generates that should never appear in the user's outline. */
const SYNTHETIC_SYMBOLS = new Set([
    '$$render',
    '__sveltets_Render',
    '$$IsomorphicComponent',
    '$$ComponentProps',
    '$$prop_def',
    '$$events_def',
    '$$slot_def'
]);

/** svelte2tsx wraps every component usage in this call; the argument is the real component. */
const ENSURE_COMPONENT = '__sveltets_2_ensureComponent(';
/** How far past the mapped offset to look before giving up, in characters. */
const ENSURE_COMPONENT_SEARCH_WINDOW = 400;

const COMPONENT_SUFFIX = '__SvelteComponent_';

function stripComponentSuffix(text: string): string {
    return text.endsWith(COMPONENT_SUFFIX) ? text.slice(0, -COMPONENT_SUFFIX.length) : text;
}
