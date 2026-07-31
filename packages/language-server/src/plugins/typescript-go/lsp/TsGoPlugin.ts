import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CancellationToken,
    CancellationTokenSource,
    CodeAction,
    CodeActionContext,
    CodeLens,
    CompletionContext,
    CompletionItem,
    CompletionItemKind,
    CompletionTriggerKind,
    Diagnostic,
    DiagnosticSeverity,
    DefinitionLink,
    DocumentDiagnosticReport,
    DocumentHighlight,
    FileChangeType,
    FoldingRange,
    Hover,
    InlayHint,
    InlayHintKind,
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
    SymbolKind,
    SymbolInformation,
    TextDocumentContentChangeEvent,
    TextEdit,
    WorkspaceEdit,
    WorkspaceSymbol
} from 'vscode-languageserver';
import fs from 'fs';
import { basename } from 'path';
import { internalHelpers } from 'svelte2tsx';
import ts from 'typescript';
import {
    Document,
    DocumentManager,
    getLineOffsets,
    getNodeIfIsInComponentStartTag,
    isInTag,
    mapRangeToGenerated,
    mapRangeToOriginal,
    offsetAt,
    positionAt
} from '../../../lib/documents';
import { configLoader } from '../../../lib/documents/configLoader';
import { getSemanticTokenLegends, TokenType } from '../../../lib/semanticToken/semanticTokenLegend';
import { LSConfigManager, LSTypescriptConfig } from '../../../ls-config';
import { Logger } from '../../../logger';
import { isNotNullOrUndefined, isZeroLengthRange, pathToUrl, urlToPath } from '../../../utils';
import { computeChangeRange, SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { mapAndFilterDiagnostics } from '../../typescript/features/DiagnosticsProvider';
import { findContainingNode } from '../../typescript/features/utils';
import { isGeneratedSvelteComponentName, isInScript } from '../../typescript/utils';
import {
    AppCompletionItem,
    AppCompletionList,
    FileRename,
    markSvelteParserError,
    OnWatchFileChangesPara,
    Plugin
} from '../../interfaces';
import {
    buildLegendMap,
    decodeSemanticTokens,
    isMapped,
    mapLegendModifierBits,
    mapLocationBack,
    mapTokenRangeBack,
    mapWorkspaceEditBack
} from './mapping';
import { ShadowManager } from './ShadowManager';
import { ProjectRegistry } from './ProjectRegistry';
import { TsGoComponentInfo } from './TsGoComponentInfo';
import { TsGoServer } from './TsGoServer';

/** How the request was served, so a "green" test run that silently fell back is detectable. */
export interface TsGoStats {
    served: number;
    fellBack: number;
    fallbackReasons: Map<string, number>;
    openOverlays: number;
    childOpenOverlays: number;
    transformedShadows: number;
    reusedShadows: number;
    projectChecks: number;
    cancellations: number;
    phaseTimings: Map<string, { count: number; totalMs: number }>;
}

interface SyncedDocument {
    document: Document;
    snapshot: SvelteDocumentSnapshot;
    shadowPath: string;
    projectKey: string;
}

interface DiagnosticFlight {
    promise: Promise<Diagnostic[] | null>;
    cancellation: CancellationTokenSource;
    waiters: number;
    finished: boolean;
}

interface TsGoPluginOptions {
    server: TsGoServer;
    projects: ProjectRegistry;
    docManager: DocumentManager;
    componentInfo?: TsGoComponentInfo;
    /** Optional for direct tests; editor setup always supplies it. */
    configManager?: LSConfigManager;
    /** Clears setup-level compiler/shim resolution after package graph changes. */
    invalidateEngineCaches?: () => void;
}

/** Internal control flow: an obsolete materialisation exits quietly instead of becoming a failure. */
const MATERIALIZATION_INVALIDATED = Symbol('tsgo-materialization-invalidated');

/**
 * Serves TypeScript language features for `.svelte` files by proxying a child `tsgo --lsp`
 * over generated `.tsx` shadows.
 *
 * Requests go out in *generated* coordinates and responses are mapped back here. Nothing below
 * this class knows about `.svelte` files.
 */
export class TsGoPlugin implements Plugin {
    __name = 'tsgo';

    readonly stats: TsGoStats;

    private readonly server: TsGoServer;
    /** One ShadowManager per TypeScript project, resolved from the file being edited. */
    private readonly projects: ProjectRegistry;
    private readonly docManager: DocumentManager;
    private readonly componentInfo: TsGoComponentInfo | undefined;
    private readonly configManager: LSConfigManager | undefined;
    private readonly invalidateEngineCaches: (() => void) | undefined;
    /** Materialisation is per project: opening a second app must not skip its own shadows. */
    private readonly opened = new Map<ShadowManager, Promise<void>>();
    /** Manager-dependent shadow paths already materialised for each source. */
    private readonly materializedShadowsBySource = new Map<string, Set<string>>();
    /** The exact generated overlay opened for each client-open Svelte source. */
    private readonly svelteOverlayBySource = new Map<string, string>();
    /** Coalesce duplicate checks for the same document and tsgo generation. */
    private readonly diagnosticsInFlight = new Map<string, DiagnosticFlight>();
    /** At most one native diagnostic check executes per project at a time. */
    private readonly diagnosticProjectTails = new Map<string, Promise<void>>();
    private readonly activeDiagnosticChecks = new Map<
        string,
        { generation: number; cancellation: CancellationTokenSource }
    >();
    /** Complete Svelte-buffer lifecycle, serialized per source URI. */
    private readonly svelteLifecycle = new Map<string, Promise<void>>();
    /** Client intent, updated synchronously so a close wins over a slow first materialisation. */
    private readonly desiredOpenSvelte = new Set<string>();
    /** Watched changes are processed in order; feature requests wait for the latest rebuild. */
    private watchWork: Promise<void> = Promise.resolve();
    /** Suppress duplicate notifications produced by overlapping outer watcher registrations. */
    private readonly lastWatchIdentity = new Map<string, string>();
    /** Import/re-export graph last observed for each saved source file. */
    private readonly sourceGraphSignatures = new Map<string, string>();
    /** Invalidates transforms which began against an older project/config graph. */
    private structuralEpoch = 0;
    /** null once we've looked and found no legend to translate through. */
    private legendMap: number[] | null | undefined;
    private legendModifierMap: number[] | null | undefined;

    constructor(options: TsGoPluginOptions) {
        this.server = options.server;
        this.projects = options.projects;
        this.docManager = options.docManager;
        this.componentInfo = options.componentInfo;
        this.configManager = options.configManager;
        this.invalidateEngineCaches = options.invalidateEngineCaches;
        this.stats = {
            served: 0,
            fellBack: 0,
            fallbackReasons: new Map(),
            openOverlays: 0,
            childOpenOverlays: 0,
            transformedShadows: 0,
            reusedShadows: 0,
            projectChecks: 0,
            cancellations: 0,
            phaseTimings: new Map()
        };
        Object.defineProperty(this.stats, 'openOverlays', {
            enumerable: true,
            get: () => this.server.openDocumentCount
        });
        Object.defineProperty(this.stats, 'childOpenOverlays', {
            enumerable: true,
            get: () => this.server.childOpenDocumentCount
        });

        // Warm the project as soon as a file is opened, instead of making the first completion
        // pay for materialising it. `ensureProjectOpened` memoises its promise, so the request
        // that does come in awaits the already-running pass rather than starting another.
        this.docManager.on('documentOpen', (document: Document) => {
            const filePath = document.getFilePath();
            if (!document.openedByClient || !filePath || !filePath.endsWith('.svelte')) {
                return;
            }
            this.recordSavedSourceGraphBaseline(filePath, document.getText());
            this.desiredOpenSvelte.add(filePath);
            this.enqueueSvelteLifecycle(filePath, async () => {
                await this.syncDocument(document);
            });
        });

        // Cross-file features must observe a dirty component even before a request is made in
        // that component. Eagerly forwarding changes keeps tsgo's project graph aligned with
        // the editor buffer while the on-disk shadow remains the saved baseline.
        this.docManager.on('documentChange', (document: Document) => {
            const filePath = document.getFilePath();
            if (!document.openedByClient || !filePath || !filePath.endsWith('.svelte')) {
                return;
            }
            this.desiredOpenSvelte.add(filePath);
            this.enqueueSvelteLifecycle(filePath, async () => {
                await this.syncDocument(document);
            });
        });

        // A client close must close the generated overlay too. Without this, tsgo and the
        // wrapper both retained every Svelte document ever opened for the lifetime of the
        // editor process.
        this.docManager.on('documentClose', (document: Document) => {
            const filePath = document.getFilePath();
            if (!document.openedByClient || !filePath || !filePath.endsWith('.svelte')) {
                return;
            }
            this.desiredOpenSvelte.delete(filePath);
            this.enqueueSvelteLifecycle(filePath, async () => {
                try {
                    const shadows = this.projects.forFile(filePath);
                    const shadowPath =
                        this.svelteOverlayBySource.get(filePath) ?? shadows.getShadowPath(filePath);
                    this.svelteOverlayBySource.delete(filePath);
                    shadows.unpinSnapshot?.(filePath);
                    shadows.deleteSnapshot(filePath);
                    this.componentInfo?.invalidateFile(shadowPath);
                    await this.server.closeDocument(shadowPath);
                } catch (e) {
                    Logger.debug('[tsgo] could not close Svelte overlay', e);
                }
            });
        });

        this.configManager?.onChange(() => {
            this.componentInfo?.clearCache();
            void this.server
                .updateConfiguration()
                .catch((e) => Logger.debug('[tsgo] could not update configuration', e));
        });
    }

    private enqueueSvelteLifecycle(filePath: string, operation: () => Promise<void>): void {
        const previous = this.svelteLifecycle.get(filePath) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(operation)
            .catch((error) => {
                Logger.debug(`[tsgo] Svelte lifecycle failed for ${filePath}`, error);
            });
        this.svelteLifecycle.set(filePath, next);
        void next.finally(() => {
            if (this.svelteLifecycle.get(filePath) === next) {
                this.svelteLifecycle.delete(filePath);
            }
        });
    }

    private featureEnabled(feature: Exclude<keyof LSTypescriptConfig, 'enable'>): boolean {
        return (
            !this.configManager ||
            (this.configManager.enabled('typescript.enable') &&
                this.configManager.enabled(`typescript.${feature}.enable`))
        );
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
    ): { offset: number; tag: string | undefined } | undefined {
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
        return {
            offset: lastDot >= 0 ? identifierStart + lastDot + 1 : identifierStart,
            tag: typeof (node as any).tag === 'string' ? (node as any).tag : undefined
        };
    }

    private fallback(reason: string): null {
        this.stats.fellBack++;
        this.stats.fallbackReasons.set(reason, (this.stats.fallbackReasons.get(reason) ?? 0) + 1);
        return null;
    }

    private recordPhase(phase: string, durationMs: number) {
        const current = this.stats.phaseTimings.get(phase) ?? { count: 0, totalMs: 0 };
        current.count++;
        current.totalMs += Math.max(0, durationMs);
        this.stats.phaseTimings.set(phase, current);
    }

    /** JSON-safe snapshot for the internal benchmark request. */
    getStatsSnapshot() {
        return {
            engine: this.server.engineInfo,
            nativeProcessId: this.server.processId ?? null,
            generation: this.server.generation,
            served: this.stats.served,
            fellBack: this.stats.fellBack,
            fallbackReasons: Object.fromEntries(this.stats.fallbackReasons),
            openOverlays: this.stats.openOverlays,
            childOpenOverlays: this.stats.childOpenOverlays,
            pendingSvelteLifecycle: this.svelteLifecycle.size,
            transformedShadows: this.stats.transformedShadows,
            reusedShadows: this.stats.reusedShadows,
            projectChecks: this.stats.projectChecks,
            cancellations: this.stats.cancellations,
            phaseTimings: Object.fromEntries(this.stats.phaseTimings)
        };
    }

    private markShadowMaterialized(sourcePath: string, shadowPath: string) {
        const paths = this.materializedShadowsBySource.get(sourcePath) ?? new Set<string>();
        paths.add(shadowPath);
        this.materializedShadowsBySource.set(sourcePath, paths);
    }

    /**
     * Push every project `.svelte` file's shadow into tsgo.
     *
     * This has to happen eagerly rather than on demand. A shadow only participates in module
     * resolution once it has been opened, and when it hasn't, svelte's ambient
     * `declare module '*.svelte'` absorbs the failed resolution: no TS2307, no error, just
     * every import silently typed `any`. Lazy opening cannot detect its own failure.
     */
    private async ensureProjectOpened(shadows: ShadowManager): Promise<void> {
        let done = this.opened.get(shadows);
        if (!done) {
            const expectedStructuralEpoch = this.structuralEpoch;
            const assertCurrent = () => {
                if (expectedStructuralEpoch !== this.structuralEpoch) {
                    throw MATERIALIZATION_INVALIDATED;
                }
            };
            const attempt = this.materializeProject(shadows, assertCurrent);
            done = attempt.catch((error) => {
                if (this.opened.get(shadows) === done) {
                    this.opened.delete(shadows);
                }
                if (error === MATERIALIZATION_INVALIDATED) {
                    return;
                }
                throw error;
            });
            this.opened.set(shadows, done);
        }
        return done;
    }

    private async materializeProject(
        shadows: ShadowManager,
        assertCurrent: () => void
    ): Promise<void> {
        // Project/package discovery records manager-local scope and pending fingerprints. Never
        // let a pass which started against an older graph continue into that mutable state.
        assertCurrent();
        const requiredFiles = [
            ...new Set([
                ...shadows.findProjectSvelteFiles(),
                ...shadows.findDependencySvelteFiles()
            ])
        ];
        assertCurrent();
        const files = requiredFiles.filter((file) => {
            const shadowPath = shadows.getShadowPath(file);
            return !this.materializedShadowsBySource.get(file)?.has(shadowPath);
        });
        Logger.log(`[tsgo] materialising ${files.length}/${requiredFiles.length} new shadows`);
        const started = Date.now();
        const written = new Set<string>();
        let reused = 0;
        let failures = 0;
        let sinceYield = 0;
        for (const filePath of files) {
            // The loop is synchronous fs work end to end; without yielding it blocks the event
            // loop for the whole pass and every LSP request queues behind it. Recheck immediately
            // after every yield so a structural watcher always wins before the next transform.
            if (++sinceYield >= 50) {
                sinceYield = 0;
                await new Promise(setImmediate);
            }
            assertCurrent();
            try {
                const shadowPathIfFresh = shadows.getShadowPath(filePath);
                // A shadow newer than its source is already what the transform would produce, so
                // re-deriving it is pure startup cost. Correctness comes from the fingerprint: a
                // Svelte or svelte2tsx upgrade invalidates all of them.
                const isFresh =
                    !this.docManager.get(pathToUrl(filePath)) &&
                    shadows.isShadowFresh(filePath, shadowPathIfFresh);
                assertCurrent();
                if (isFresh) {
                    written.add(shadowPathIfFresh);
                    this.markShadowMaterialized(filePath, shadowPathIfFresh);
                    reused++;
                    this.stats.reusedShadows++;
                    continue;
                }
                const uri = pathToUrl(filePath);
                // Materialised shadows are the saved baseline. A dirty client buffer is layered
                // over it with didOpen/didChange in syncDocument; use a detached document so no
                // DocumentManager listeners fire and no unsaved text reaches disk.
                let sourceText: string;
                try {
                    sourceText = fs.readFileSync(filePath, 'utf8');
                } catch (error) {
                    if (this.docManager.get(uri)?.openedByClient) {
                        assertCurrent();
                        shadows.removeShadow(shadowPathIfFresh);
                        continue;
                    }
                    throw error;
                }
                const document = new Document(uri, sourceText);
                await document.configPromise;
                assertCurrent();
                const snapshot = shadows.transform(document);
                const shadowPath = shadows.getShadowPath(filePath);
                const generatedText = snapshot.getFullText();
                assertCurrent();
                shadows.writeShadow(shadowPath, generatedText);
                assertCurrent();
                written.add(shadowPath);
                this.markShadowMaterialized(filePath, shadowPath);
                this.stats.transformedShadows++;
            } catch (error) {
                if (error === MATERIALIZATION_INVALIDATED) {
                    throw error;
                }
                // A synchronous test double can trigger invalidation from transform/write. The
                // same guard also keeps that path from deleting a replacement generation's file.
                assertCurrent();
                failures++;
                shadows.removeShadow(shadows.getShadowPath(filePath));
                Logger.debug(`[tsgo] could not materialise shadow for ${filePath}`, error);
            }
        }

        assertCurrent();
        // Materialisation needs generated text only long enough to write the shadow. Client-open
        // documents stay hot; navigation can regenerate any other snapshot on demand.
        for (const filePath of files) {
            assertCurrent();
            if (!this.docManager.get(pathToUrl(filePath))?.openedByClient) {
                shadows.deleteSnapshot(filePath);
            }
        }
        if (failures) {
            throw new Error(`failed to materialise ${failures} shadow(s)`);
        }
        assertCurrent();
        shadows.pruneOrphanedShadows(written);
        assertCurrent();
        shadows.commitFingerprints();
        assertCurrent();
        Logger.log(
            `[tsgo] materialised ${written.size} shadows in ${Date.now() - started}ms ` +
                `(${reused} reused from disk)`
        );
        this.recordPhase('materialise', Date.now() - started);
    }

    /** Bring a document's shadow up to date and hand back what's needed to map positions. */
    private async syncDocument(document: Document): Promise<SyncedDocument | null> {
        await this.watchWork;
        return this.syncDocumentNow(document, this.structuralEpoch);
    }

    /** Internal form used by the structural rebuild itself, which must not await its own task. */
    private async syncDocumentNow(
        document: Document,
        expectedStructuralEpoch: number
    ): Promise<SyncedDocument | null> {
        const filePath = document.getFilePath();
        if (!filePath || !filePath.endsWith('.svelte')) {
            return null;
        }
        const shadows = this.projects.forFile(filePath);
        await this.ensureProjectOpened(shadows);
        await document.configPromise;
        if (expectedStructuralEpoch !== this.structuralEpoch) {
            return null;
        }

        const t0 = Date.now();
        if (document.openedByClient && this.desiredOpenSvelte.has(filePath)) {
            shadows.pinSnapshot?.(filePath);
        }
        const snapshot = shadows.transform(document);
        const t1 = Date.now();
        const shadowPath = shadows.getShadowPath(filePath);
        const previousShadowPath = this.svelteOverlayBySource.get(filePath);
        if (previousShadowPath && previousShadowPath !== shadowPath) {
            this.componentInfo?.invalidateFile(previousShadowPath);
            await this.server.closeDocument(previousShadowPath);
        }
        // Only documents the editor actually has open become LSP overlays; everything else
        // lives on disk. Each didOpen costs tsgo a synchronous snapshot rebuild, so this stays
        // proportional to what the user is looking at rather than to project size.
        //
        // No disk write here: the on-disk shadow only feeds the editor's *TypeScript* server
        // (ts-support config), whose freshness is documented as save-granular — the watcher
        // path rewrites it on save. Writing per request meant several syncs per keystroke.
        if (document.openedByClient && this.desiredOpenSvelte.has(filePath)) {
            this.svelteOverlayBySource.set(filePath, shadowPath);
            const text = snapshot.getFullText();
            const previous = this.server.getOpenText(shadowPath);
            if (previous !== text) {
                this.componentInfo?.invalidateFile(shadowPath);
            }
            if (this.server.isOpen(shadowPath)) {
                await this.server.updateDocument(
                    shadowPath,
                    incrementalChanges(previous, text),
                    text
                );
            } else {
                shadows.ensureShadowDirectory(shadowPath);
                await this.server.openDocument(shadowPath, text);
            }
            // A close or structural change which happened during child startup wins. Queueing
            // lifecycle operations normally closes this immediately, while this guard covers a
            // feature request which was not itself in that queue.
            if (
                expectedStructuralEpoch !== this.structuralEpoch ||
                !this.desiredOpenSvelte.has(filePath)
            ) {
                this.svelteOverlayBySource.delete(filePath);
                await this.server.closeDocument(shadowPath);
                return null;
            }
        }

        if (TIMING) {
            timing('transform', t1 - t0);
            timing('sync', Date.now() - t1);
        }
        this.recordPhase('transform', t1 - t0);
        this.recordPhase('sync', Date.now() - t1);
        return { document, snapshot, shadowPath, projectKey: shadows.overlayTsconfigPath };
    }

    async getDiagnostics(
        document: Document,
        cancellationToken?: CancellationToken
    ): Promise<Diagnostic[]> {
        if (!this.featureEnabled('diagnostics')) {
            return [];
        }
        const tStart = TIMING ? Date.now() : 0;
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        return (await this.collectDiagnosticsSingleFlight(synced, cancellationToken, tStart)) ?? [];
    }

    /**
     * The pull-mode counterpart. This is not optional plumbing: whenever the client supports
     * pull diagnostics — every current VS Code does — the server routes *all* diagnostics
     * through here, and a plugin without this method simply contributes none. The push-mode
     * `getDiagnostics` above then never runs, which is how tsgo diagnostics were absent from
     * the editor while working fine in svelte-check.
     */
    async getDiagnosticsForPullMode(
        document: Document,
        previousResultId?: string,
        cancellationToken?: CancellationToken
    ): Promise<DocumentDiagnosticReport> {
        if (!this.featureEnabled('diagnostics')) {
            return { kind: 'full', items: [] };
        }
        const tStart = TIMING ? Date.now() : 0;
        const synced = await this.syncDocument(document);
        if (!synced) {
            return { kind: 'full', items: [] };
        }
        // The mapped result is a function of the shadow text and of everything else tsgo
        // knows, all of which move the server generation (the sync above just bumped it if
        // this document changed). Same generation ⇒ same answer, without asking tsgo.
        const resultId = `g${this.server.generation}`;
        if (previousResultId === resultId) {
            return { kind: 'unchanged', resultId };
        }

        // Wait for the typing burst to settle before paying for a program check: tsgo has no
        // incremental checking, so every pull it serves costs a full re-check of the project.
        // A pull overtaken while waiting (cancelled by the client, or the generation moved)
        // keeps whatever is on screen; the client re-pulls when things calm down.
        if (PULL_QUIESCENCE_MS > 0) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    disposable?.dispose();
                    resolve();
                }, PULL_QUIESCENCE_MS);
                const disposable = cancellationToken?.onCancellationRequested(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            if (
                cancellationToken?.isCancellationRequested ||
                `g${this.server.generation}` !== resultId
            ) {
                return previousResultId
                    ? { kind: 'unchanged', resultId: previousResultId }
                    : { kind: 'full', items: [] };
            }
        }

        const items = await this.collectDiagnosticsSingleFlight(synced, cancellationToken, tStart);
        if (items === null) {
            // Cancelled or failed: never a full report with this generation's resultId — the
            // next pull's `unchanged` short-circuit would freeze the accidental blank answer in
            // place of the real diagnostics. Keep whatever the client already shows instead.
            return previousResultId
                ? { kind: 'unchanged', resultId: previousResultId }
                : { kind: 'full', items: [] };
        }
        return { kind: 'full', resultId, items };
    }

    private collectDiagnosticsSingleFlight(
        synced: SyncedDocument,
        cancellationToken: CancellationToken | undefined,
        tStart: number
    ): Promise<Diagnostic[] | null> {
        const generation = this.server.generation;
        const key = `${generation}:${synced.shadowPath}`;
        const existing = this.diagnosticsInFlight.get(key);
        if (existing) {
            return this.waitForDiagnosticFlight(key, existing, cancellationToken);
        }

        const active = this.activeDiagnosticChecks.get(synced.projectKey);
        if (active && active.generation !== generation) {
            active.cancellation.cancel();
            this.stats.cancellations++;
        }
        const previous = this.diagnosticProjectTails.get(synced.projectKey);
        const internalCancellation = new CancellationTokenSource();
        const entry: DiagnosticFlight = {
            promise: undefined as unknown as Promise<Diagnostic[] | null>,
            cancellation: internalCancellation,
            waiters: 0,
            finished: false
        };
        const promise = (async () => {
            await previous?.catch(() => undefined);
            if (this.server.generation !== generation) {
                return null;
            }
            this.activeDiagnosticChecks.set(synced.projectKey, {
                generation,
                cancellation: internalCancellation
            });
            return this.collectDiagnostics(synced, internalCancellation.token, tStart, generation);
        })().finally(() => {
            entry.finished = true;
            internalCancellation.dispose();
            if (
                this.activeDiagnosticChecks.get(synced.projectKey)?.cancellation ===
                internalCancellation
            ) {
                this.activeDiagnosticChecks.delete(synced.projectKey);
            }
            if (this.diagnosticsInFlight.get(key) === entry && entry.waiters === 0) {
                this.diagnosticsInFlight.delete(key);
            }
        });
        entry.promise = promise;
        const tail = promise.then(
            () => undefined,
            () => undefined
        );
        this.diagnosticProjectTails.set(synced.projectKey, tail);
        void tail.finally(() => {
            if (this.diagnosticProjectTails.get(synced.projectKey) === tail) {
                this.diagnosticProjectTails.delete(synced.projectKey);
            }
        });
        this.diagnosticsInFlight.set(key, entry);
        return this.waitForDiagnosticFlight(key, entry, cancellationToken);
    }

    private waitForDiagnosticFlight(
        key: string,
        flight: DiagnosticFlight,
        cancellationToken: CancellationToken | undefined
    ): Promise<Diagnostic[] | null> {
        if (cancellationToken?.isCancellationRequested) {
            return Promise.resolve(null);
        }
        flight.waiters++;
        return new Promise<Diagnostic[] | null>((resolve, reject) => {
            let settled = false;
            let disposable: { dispose(): void } | undefined;
            const release = () => {
                if (settled) {
                    return;
                }
                settled = true;
                disposable?.dispose();
                flight.waiters--;
                if (!flight.finished && flight.waiters === 0) {
                    flight.cancellation.cancel();
                    this.stats.cancellations++;
                    if (this.diagnosticsInFlight.get(key) === flight) {
                        this.diagnosticsInFlight.delete(key);
                    }
                } else if (
                    flight.finished &&
                    flight.waiters === 0 &&
                    this.diagnosticsInFlight.get(key) === flight
                ) {
                    this.diagnosticsInFlight.delete(key);
                }
            };
            disposable = cancellationToken?.onCancellationRequested(() => {
                release();
                resolve(null);
            });
            flight.promise.then(
                (result) => {
                    if (!settled) {
                        release();
                        resolve(cancellationToken?.isCancellationRequested ? null : result);
                    }
                },
                (error) => {
                    if (!settled) {
                        release();
                        reject(error);
                    }
                }
            );
        });
    }

    /** The mapped diagnostics, or null when the answer is unusable (cancelled, tsgo error). */
    private async collectDiagnostics(
        synced: SyncedDocument,
        cancellationToken: CancellationToken | undefined,
        tStart: number,
        expectedGeneration: number
    ): Promise<Diagnostic[] | null> {
        const { document, snapshot, shadowPath } = synced;

        // A template that doesn't parse yields no usable generated code. The Svelte plugin is
        // the editor's authoritative parser-diagnostic provider; emitting the snapshot error
        // here as well produces two squiggles for the same unclosed element. BatchOverlay keeps
        // its independent parser stream because checker diagnostic-source selection differs.
        if (snapshot.parserError) {
            return [];
        }

        if (cancellationToken?.isCancellationRequested) {
            return null;
        }

        let report: any;
        const tCheck = TIMING ? Date.now() : 0;
        try {
            this.stats.projectChecks++;
            report = await this.server.sendRequest(
                'textDocument/diagnostic',
                {
                    textDocument: { uri: pathToUrl(shadowPath) }
                },
                cancellationToken
            );
        } catch (e) {
            Logger.debug('[tsgo] diagnostic request failed', e);
            this.fallback('diagnostic-request-failed');
            return null;
        }

        // A different document, watcher event, or crash can change the program while the native
        // checker is running. Its response then belongs to the old program even if this file's
        // own text did not change, so publishing it would overwrite newer diagnostics.
        if (
            cancellationToken?.isCancellationRequested ||
            this.server.generation !== expectedGeneration
        ) {
            return null;
        }

        const items: any[] = report?.items ?? [];
        this.stats.served++;
        const tMap = TIMING ? Date.now() : 0;

        if (TIMING) {
            // Severity 1=Error 2=Warning 3=Information 4=Hint. Anything above 2 is a suggestion:
            // tsgo computed it and the squiggle path throws it away, so it is latency we are
            // paying for output nobody reads.
            for (const item of items) {
                timing(`sev${item.severity ?? 0}`, 1);
            }
            timing('items', items.length);
        }

        const sourceFile = ts.createSourceFile(
            snapshot.filePath,
            snapshot.getFullText(),
            ts.ScriptTarget.Latest,
            true,
            snapshot.scriptKind
        );
        const mapped = items.flatMap((diagnostic) => {
            if (!diagnostic?.range?.start || !diagnostic?.range?.end) {
                throw new Error('tsgo returned a diagnostic without a complete range');
            }
            const code = Number(diagnostic.code);
            if (!Number.isSafeInteger(code)) {
                throw new Error(`tsgo returned an invalid diagnostic code: ${diagnostic.code}`);
            }
            const start = snapshot.offsetAt(diagnostic.range.start);
            const end = snapshot.offsetAt(diagnostic.range.end);
            const tsDiagnostic: ts.Diagnostic = {
                file: sourceFile,
                start,
                length: Math.max(0, end - start),
                category: diagnosticCategory(diagnostic.severity),
                code,
                messageText: diagnostic.message,
                source: 'ts'
            };
            if (isSyntacticDiagnosticCode(code)) {
                markSvelteParserError(tsDiagnostic);
            }
            const relatedInformation = diagnostic.relatedInformation
                ?.map((information: any) => {
                    if (!information.location?.uri || !information.location?.range) {
                        return undefined;
                    }
                    const location = mapLocationBack(
                        this.projects,
                        information.location.uri,
                        information.location.range
                    );
                    return location ? { ...information, location } : undefined;
                })
                .filter(isNotNullOrUndefined);

            // Keep the native transport boundary in generated coordinates, then use the same
            // Svelte-aware filtering and remapping as the classic engine. A plain source-map
            // lookup drops intentional generated diagnostics such as the $$Props assignability
            // check, whose useful range is recovered by `moveBindingErrorMessage`.
            return mapAndFilterDiagnostics([tsDiagnostic], document, snapshot).map((mapped) => {
                const withRelatedInformation = {
                    ...mapped,
                    ...(diagnostic.relatedInformation
                        ? { relatedInformation: relatedInformation ?? [] }
                        : {})
                };
                return isSyntacticDiagnosticCode(code)
                    ? markSvelteParserError(withRelatedInformation)
                    : withRelatedInformation;
            });
        });

        if (TIMING) {
            timing('tsgo', tMap - tCheck);
            timing('mapback', Date.now() - tMap);
            timing('total', Date.now() - tStart);
        }
        return mapped;
    }

    async doHover(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Hover | null> {
        if (!this.featureEnabled('hover') || cancellationToken?.isCancellationRequested) {
            return null;
        }
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const { snapshot, shadowPath } = synced;

        const componentOffset = this.componentInfo
            ? this.componentOffsetAt(document, snapshot, position)
            : undefined;
        if (componentOffset !== undefined) {
            const props = await this.componentInfo!.getProps(
                shadowPath,
                componentOffset.offset,
                componentOffset.tag
            );
            if (cancellationToken?.isCancellationRequested) {
                return null;
            }
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

        const hover: any = await this.server.sendRequest(
            'textDocument/hover',
            {
                textDocument: { uri: pathToUrl(shadowPath) },
                position: generated
            },
            cancellationToken
        );
        if (!hover) {
            return null;
        }
        const hoverRange = hover.range ? mapRangeToOriginal(snapshot, hover.range) : undefined;
        this.stats.served++;
        return {
            contents: hover.contents,
            // Generated helper spans have no source counterpart. Omitting the optional range
            // lets the client anchor the hover at the requested source position instead of
            // receiving a negative/generated coordinate.
            range: isMapped(hoverRange) ? hoverRange : undefined
        };
    }

    async getCompletions(
        document: Document,
        position: Position,
        completionContext?: CompletionContext,
        cancellationToken?: CancellationToken
    ): Promise<AppCompletionList | null> {
        if (
            !this.featureEnabled('completions') ||
            cancellationToken?.isCancellationRequested ||
            isInTag(position, document.styleInfo)
        ) {
            return null;
        }

        // The outer server advertises markup trigger characters for its HTML/Svelte providers.
        // Sending one tsgo does not support either panics the child or turns a cheap markup
        // completion into a global TypeScript completion list.
        if (
            completionContext?.triggerKind === CompletionTriggerKind.TriggerCharacter &&
            !TSGO_TRIGGER_CHARACTERS.has(completionContext.triggerCharacter ?? '')
        ) {
            return null;
        }

        const originalOffset = document.offsetAt(position);
        const originalText = document.getText();
        if (
            originalText.substring(originalOffset - 1, originalOffset + 2) === '></' ||
            (!isInTag(position, document.scriptInfo) &&
                !isInTag(position, document.moduleScriptInfo) &&
                (isClearlyPlainMarkup(originalText, originalOffset) ||
                    /\{[#@:/][\w-]*$/.test(
                        originalText.slice(Math.max(0, originalOffset - 100), originalOffset)
                    )))
        ) {
            return null;
        }

        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const { snapshot, shadowPath } = synced;

        const svelteNode = snapshot.svelteNodeAt(originalOffset);
        if (
            (svelteNode?.type === 'Text' &&
                [
                    'Element',
                    'InlineComponent',
                    'Fragment',
                    'SlotTemplate',
                    'SnippetBlock',
                    'IfBlock',
                    'EachBlock',
                    'AwaitBlock',
                    'Style'
                ].includes(svelteNode.parent?.type as any)) ||
            (!isInScript(position, snapshot) &&
                /\{[#@:/][\w-]*$/.test(
                    originalText.slice(Math.max(0, originalOffset - 100), originalOffset)
                ))
        ) {
            return null;
        }

        // Inside a component start tag the useful completions are the component's props, which
        // are a property of its *type* — no LSP request produces them, so this goes through the
        // attached checker session instead.
        const componentOffset = this.componentInfo
            ? this.componentOffsetAt(document, snapshot, position)
            : undefined;
        if (componentOffset !== undefined) {
            const props = await this.componentInfo!.getProps(
                shadowPath,
                componentOffset.offset,
                componentOffset.tag
            );
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

        const result: any = await this.server.sendRequest(
            'textDocument/completion',
            {
                textDocument: { uri: pathToUrl(shadowPath) },
                position: generated,
                context: completionContext
            },
            cancellationToken
        );
        if (!result) {
            return null;
        }
        this.stats.served++;

        const items: any[] = Array.isArray(result) ? result : (result.items ?? []);
        const uri = document.uri;
        // Mutated in place: a global completion is thousands of items, and cloning each one
        // just to attach `data` dominated the post-request time.
        for (const item of items) {
            // `connection.onCompletionResolve` reads `item.data` as a TextDocumentIdentifier to
            // find the document the item belongs to, so an item whose data is tsgo's own payload
            // resolves against `undefined` and throws "Cannot call methods on an unopened
            // document". That is not cosmetic: `additionalTextEdits` — the auto-import statement —
            // only arrive from resolve, so every auto-import silently did nothing.
            //
            // tsgo's payload is nested rather than merged, so it round-trips back to tsgo exactly
            // as issued rather than with an extra key it never emitted.
            item.data = { uri, [TSGO_DATA]: item.data };
            // Component completions surface as `Button__SvelteComponent_`; the user wants to
            // see and insert `Button`.
            if (typeof item.label === 'string' && item.label.endsWith(COMPONENT_SUFFIX)) {
                item.label = stripComponentSuffix(item.label);
            }
            if (typeof item.insertText === 'string' && item.insertText.endsWith(COMPONENT_SUFFIX)) {
                item.insertText = stripComponentSuffix(item.insertText);
            }
            // Rare under our capabilities (tsgo mostly omits edits), but when present it comes
            // in either the plain `{range}` or the insert/replace shape — both in generated
            // coordinates that must not leak to the editor.
            if (item.textEdit) {
                const mappedEdit = mapCompletionEdit(snapshot, item.textEdit);
                if (mappedEdit) {
                    mappedEdit.newText = stripComponentSuffix(mappedEdit.newText);
                }
                item.textEdit = mappedEdit;
            }
        }

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
        extra: Record<string, unknown> = {},
        token?: CancellationToken,
        generatedPosition?: (synced: SyncedDocument) => Position | undefined
    ): Promise<{ result: T; snapshot: SvelteDocumentSnapshot } | null> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const generated =
            generatedPosition?.(synced) ?? synced.snapshot.getGeneratedPosition(position);
        if (generated.line < 0) {
            return null;
        }
        try {
            const result = await this.server.sendRequest<T>(
                method,
                {
                    textDocument: { uri: pathToUrl(synced.shadowPath) },
                    position: generated,
                    ...extra
                },
                token
            );
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
                return mapLocationBack(this.projects, uri, range);
            })
            .filter(isNotNullOrUndefined);
    }

    async getDefinitions(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<DefinitionLink[]> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/definition',
            {},
            cancellationToken,
            ({ snapshot }) => {
                const component = this.componentOffsetAt(document, snapshot, position);
                return component ? snapshot.positionAt(component.offset) : undefined;
            }
        );
        if (!response) {
            return [];
        }
        const entries: any[] = Array.isArray(response.result)
            ? response.result
            : response.result
              ? [response.result]
              : [];
        return entries
            .map((entry) => {
                const targetUri = entry.targetUri ?? entry.uri;
                const targetSelectionRange = entry.targetSelectionRange ?? entry.range;
                if (!targetUri || !targetSelectionRange) {
                    return undefined;
                }
                const selection = this.mapDefinitionTarget(targetUri, targetSelectionRange);
                if (!selection) {
                    return undefined;
                }
                const full = entry.targetRange
                    ? this.mapDefinitionTarget(targetUri, entry.targetRange)
                    : selection;
                const origin = entry.originSelectionRange
                    ? mapRangeToOriginal(response.snapshot, entry.originSelectionRange)
                    : undefined;
                return LocationLink.create(
                    selection.uri,
                    full?.range ?? selection.range,
                    selection.range,
                    isMapped(origin) ? origin : undefined
                );
            })
            .filter(isNotNullOrUndefined);
    }

    /**
     * Component definitions point at the synthetic default-export identifier in a Svelte
     * shadow. That identifier intentionally has no source-map segment, so the generic location
     * mapper drops it. Recognise only that generated default export and use the same stable
     * source-file anchor as the classic TypeScript provider; all other generated-only ranges
     * remain filtered out.
     */
    private mapDefinitionTarget(uri: string, range: Range): Location | undefined {
        const mapped = mapLocationBack(this.projects, uri, range);
        if (mapped) {
            return mapped;
        }

        const shadowPath = urlToPath(uri);
        const originalPath = shadowPath ? this.projects.getOriginalPath(shadowPath) : undefined;
        if (!originalPath) {
            return undefined;
        }
        const snapshot = this.projects.ensureSnapshot(originalPath);
        if (!snapshot) {
            return undefined;
        }

        const text = snapshot.getFullText();
        const selectionStart = snapshot.offsetAt(range.start);
        const selectionEnd = snapshot.offsetAt(range.end);
        const selected = text.slice(selectionStart, selectionEnd);
        if (!isGeneratedSvelteComponentName(selected)) {
            return undefined;
        }
        const defaultExportOffset = findDefaultExportIdentifierOffset(text);
        if (
            defaultExportOffset === undefined ||
            text.slice(defaultExportOffset, defaultExportOffset + selected.length) !== selected
        ) {
            return undefined;
        }

        const sourceStart = Position.create(0, 1);
        return Location.create(pathToUrl(originalPath), Range.create(sourceStart, sourceStart));
    }

    async getTypeDefinition(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/typeDefinition',
            {},
            cancellationToken
        );
        return response ? this.toLocations(response.result) : null;
    }

    async getImplementation(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/implementation',
            {},
            cancellationToken
        );
        return response ? this.toLocations(response.result) : null;
    }

    async findReferences(
        document: Document,
        position: Position,
        context: ReferenceContext,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/references',
            { context: { includeDeclaration: context?.includeDeclaration ?? true } },
            cancellationToken
        );
        return response ? this.toLocations(response.result) : null;
    }

    async findDocumentHighlight(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<DocumentHighlight[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/documentHighlight',
            {},
            cancellationToken
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
        context: SignatureHelpContext | undefined,
        cancellationToken?: CancellationToken
    ): Promise<SignatureHelp | null> {
        if (!this.featureEnabled('signatureHelp')) {
            return null;
        }
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/signatureHelp',
            context ? { context } : {},
            cancellationToken
        );
        return response?.result ?? null;
    }

    async getSelectionRange(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<SelectionRange | null> {
        if (!this.featureEnabled('selectionRange')) {
            return null;
        }
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const generated = synced.snapshot.getGeneratedPosition(position);
        if (generated.line < 0) {
            return null;
        }
        const result: any = await this.server.sendRequest(
            'textDocument/selectionRange',
            {
                textDocument: { uri: pathToUrl(synced.shadowPath) },
                positions: [generated]
            },
            cancellationToken
        );
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

    async getSemanticTokens(
        document: Document,
        range?: Range,
        cancellationToken?: CancellationToken
    ): Promise<SemanticTokens | null> {
        if (!this.featureEnabled('semanticTokens')) {
            return { data: [] };
        }
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const { snapshot, shadowPath } = synced;

        // A range request (the editor asks viewport-sized ones) maps to the generated range
        // and lets tsgo skip most of the file — decoding and per-token mapping shrink with it.
        // Ranges that don't survive mapping fall back to the full document. The generated range
        // is padded a line either way so tokens at the boundary aren't clipped.
        let generatedRange: Range | undefined;
        if (range) {
            const start = snapshot.getGeneratedPosition(range.start);
            const end = snapshot.getGeneratedPosition(range.end);
            if (start.line >= 0 && end.line >= 0) {
                const [low, high] =
                    start.line <= end.line ? [start.line, end.line] : [end.line, start.line];
                generatedRange = {
                    start: { line: Math.max(0, low - 1), character: 0 },
                    end: { line: high + 2, character: 0 }
                };
            }
        }

        let result: any;
        try {
            result = await this.server.sendRequest(
                generatedRange
                    ? 'textDocument/semanticTokens/range'
                    : 'textDocument/semanticTokens/full',
                {
                    textDocument: { uri: pathToUrl(shadowPath) },
                    ...(generatedRange ? { range: generatedRange } : {})
                },
                cancellationToken
            );
        } catch (e) {
            Logger.debug('[tsgo] semanticTokens failed', e);
            this.fallback('semanticTokens');
            return null;
        }
        if (!result?.data?.length) {
            return { data: [] };
        }
        this.stats.served++;

        const { types: legendMap, modifiers: legendModifierMap } = this.getLegendMaps();
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
            if (
                range &&
                (target.line < range.start.line ||
                    target.line > range.end.line ||
                    (target.line === range.start.line &&
                        target.char + target.length <= range.start.character) ||
                    (target.line === range.end.line && target.char >= range.end.character))
            ) {
                continue;
            }
            // Match the classic provider: generated component identifiers map onto the start-tag
            // name but should not receive TypeScript semantic highlighting in markup.
            const targetOffset = document.offsetAt({
                line: target.line,
                character: target.char
            });
            if (
                (tokenType === TokenType.class ||
                    tokenType === TokenType.type ||
                    tokenType === TokenType.parameter ||
                    tokenType === TokenType.variable ||
                    tokenType === TokenType.function) &&
                (document.getText().charCodeAt(targetOffset - 1) === 60 ||
                    document.getText().charCodeAt(targetOffset - 1) === 47) &&
                snapshot.svelteNodeAt(targetOffset)?.type === 'InlineComponent'
            ) {
                continue;
            }
            mapped.push([
                target.line,
                target.char,
                target.length,
                tokenType,
                legendModifierMap ? mapLegendModifierBits(modifiers, legendModifierMap) : modifiers
            ]);
        }

        // The builder requires ascending order, and mapping can reorder tokens.
        mapped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const token of mapped) {
            builder.push(...token);
        }
        return builder.build();
    }

    async getDocumentSymbols(
        document: Document,
        cancellationToken?: CancellationToken
    ): Promise<SymbolInformation[]> {
        if (!this.featureEnabled('documentSymbols')) {
            return [];
        }
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        const result: any = await this.server.sendRequest(
            'textDocument/documentSymbol',
            {
                textDocument: { uri: pathToUrl(synced.shadowPath) }
            },
            cancellationToken
        );
        if (!Array.isArray(result)) {
            return [];
        }
        this.stats.served++;

        const out: SymbolInformation[] = [];
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
                inGeneratedRegion(synced.snapshot, synced.snapshot.offsetAt(selection.start));
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

    async getInlayHints(
        document: Document,
        range: Range,
        cancellationToken?: CancellationToken
    ): Promise<InlayHint[] | null> {
        if (this.configManager && !this.configManager.enabled('typescript.enable')) {
            return null;
        }
        const synced = await this.syncDocument(document);
        if (!synced) {
            return null;
        }
        const mappedStart = synced.snapshot.getGeneratedPosition(range.start);
        const mappedEnd = synced.snapshot.getGeneratedPosition(range.end);
        // Viewport ranges commonly begin or end in markup, which has no direct generated
        // position. The classic provider widens an unmapped boundary to the generated document
        // edge; returning null here made a normal whole-document request produce zero hints.
        const start = mappedStart.line < 0 ? synced.snapshot.positionAt(0) : mappedStart;
        const end =
            mappedEnd.line < 0
                ? synced.snapshot.positionAt(synced.snapshot.getLength())
                : mappedEnd;
        const result: any = await this.server.sendRequest(
            'textDocument/inlayHint',
            {
                textDocument: { uri: pathToUrl(synced.shadowPath) },
                range: { start, end }
            },
            cancellationToken
        );
        if (!Array.isArray(result)) {
            return null;
        }
        this.stats.served++;
        const generatedSourceFile = ts.createSourceFile(
            synced.shadowPath,
            synced.snapshot.getFullText(),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX
        );
        return result
            .map((hint) => {
                if (
                    !hint?.position ||
                    inGeneratedRegion(synced.snapshot, synced.snapshot.offsetAt(hint.position)) ||
                    isGeneratedParameterInlayHint(generatedSourceFile, synced.snapshot, hint)
                ) {
                    return undefined;
                }
                const position = synced.snapshot.getOriginalPosition(hint.position);
                if (position.line < 0) {
                    return undefined;
                }
                const label = Array.isArray(hint.label)
                    ? hint.label.map((part: any) => {
                          if (!part.location) {
                              return part;
                          }
                          const location = mapLocationBack(
                              this.projects,
                              part.location.uri,
                              part.location.range
                          );
                          // Keep the visible label even when its optional navigation target is
                          // generated-only; never leak the generated URI/range to the client.
                          const { location: _generatedLocation, ...withoutLocation } = part;
                          return location ? { ...withoutLocation, location } : withoutLocation;
                      })
                    : hint.label;
                const textEdits = hint.textEdits
                    ? this.mapEditsForDocument(document, hint.textEdits)
                    : undefined;
                return { ...hint, position, textEdits, label };
            })
            .filter(isNotNullOrUndefined);
    }

    async getFoldingRanges(
        document: Document,
        cancellationToken?: CancellationToken
    ): Promise<FoldingRange[]> {
        const synced = await this.syncDocument(document);
        if (!synced) {
            return [];
        }
        const result: any = await this.server.sendRequest(
            'textDocument/foldingRange',
            {
                textDocument: { uri: pathToUrl(synced.shadowPath) }
            },
            cancellationToken
        );
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

    async prepareRename(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<Range | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/prepareRename',
            {},
            cancellationToken
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
        newName: string,
        cancellationToken?: CancellationToken
    ): Promise<WorkspaceEdit | null> {
        const response = await this.requestAt<WorkspaceEdit>(
            document,
            position,
            'textDocument/rename',
            { newName },
            cancellationToken
        );
        return response ? mapWorkspaceEditBack(this.projects, response.result) : null;
    }

    async getCodeActions(
        document: Document,
        range: Range,
        context: CodeActionContext,
        cancellationToken?: CancellationToken
    ): Promise<CodeAction[]> {
        if (!this.featureEnabled('codeActions')) {
            return [];
        }
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
            result = await this.server.sendRequest(
                'textDocument/codeAction',
                {
                    textDocument: { uri: pathToUrl(synced.shadowPath) },
                    range: { start, end },
                    context: { diagnostics, only: context?.only }
                },
                cancellationToken
            );
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
                const data =
                    action.data === undefined
                        ? undefined
                        : { uri: document.uri, [TSGO_DATA]: action.data };
                if (!action.edit) {
                    // The outer resolve callback uses `data.uri` to recover the document. Keep
                    // tsgo's opaque payload nested alongside it, exactly as for completions.
                    return { ...action, ...(data ? { data } : {}) } as CodeAction;
                }
                const edit = mapWorkspaceEditBack(this.projects, action.edit);
                return edit ? { ...action, ...(data ? { data } : {}), edit } : undefined;
            })
            .filter(isNotNullOrUndefined);
    }

    async resolveCodeAction(
        _document: Document,
        codeAction: CodeAction,
        cancellationToken?: CancellationToken
    ): Promise<CodeAction> {
        if (!this.featureEnabled('codeActions')) {
            return codeAction;
        }
        try {
            const data: any = codeAction.data;
            if (!data || typeof data !== 'object' || !(TSGO_DATA in data)) {
                return codeAction;
            }
            const forwarded = { ...codeAction, data: data[TSGO_DATA] };
            const resolved: any = await this.server.sendRequest(
                'codeAction/resolve',
                forwarded,
                cancellationToken
            );
            if (!resolved) {
                return codeAction;
            }
            const edit = mapWorkspaceEditBack(this.projects, resolved?.edit);
            const { edit: _generatedEdit, ...resolvedWithoutEdit } = resolved;
            return {
                ...codeAction,
                ...resolvedWithoutEdit,
                data: codeAction.data,
                ...(edit ? { edit } : {})
            };
        } catch (e) {
            Logger.debug('[tsgo] codeAction/resolve failed', e);
            return codeAction;
        }
    }

    async resolveCompletion(
        _document: Document,
        completionItem: AppCompletionItem,
        cancellationToken?: CancellationToken
    ): Promise<AppCompletionItem> {
        try {
            const data: any = completionItem.data;
            const forwarded =
                data && typeof data === 'object' && TSGO_DATA in data
                    ? { ...completionItem, data: data[TSGO_DATA] }
                    : completionItem;
            const resolved: any = await this.server.sendRequest(
                'completionItem/resolve',
                forwarded,
                cancellationToken
            );
            if (!resolved) {
                return completionItem;
            }
            // additionalTextEdits are auto-imports written into the generated file; they have to
            // come back to the original or they would be applied at the wrong offset.
            const additionalTextEdits = resolved.additionalTextEdits
                ? this.mapEditsForDocument(_document, resolved.additionalTextEdits)
                : undefined;
            // Keep our own `data` so a second resolve of the same item still finds the document.
            return {
                ...completionItem,
                ...resolved,
                data: completionItem.data,
                additionalTextEdits
            };
        } catch (e) {
            Logger.debug('[tsgo] completionItem/resolve failed', e);
            return completionItem;
        }
    }

    private mapEditsForDocument(document: Document, edits: TextEdit[]): TextEdit[] | undefined {
        const filePath = document.getFilePath();
        const snapshot = filePath ? this.projects.ensureSnapshot(filePath) : undefined;
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
        if (
            this.configManager &&
            !(
                this.configManager.enabled('svelte.enable') &&
                this.configManager.enabled('svelte.rename.enable')
            )
        ) {
            return null;
        }

        const oldPath = urlToPath(fileRename.oldUri);
        const newPath = urlToPath(fileRename.newUri);
        if (!oldPath || !newPath) {
            return null;
        }
        // Only a Svelte *file* is represented solely by a shadow. TS/JS files and folder
        // renames remain real paths in tsgo's program and must be sent verbatim.
        const isSvelteFile = oldPath.endsWith('.svelte') && newPath.endsWith('.svelte');
        const oldUri = isSvelteFile
            ? pathToUrl(this.projects.forFile(oldPath).getShadowPath(oldPath))
            : fileRename.oldUri;
        const newUri = isSvelteFile
            ? pathToUrl(this.projects.forFile(newPath).getShadowPath(newPath))
            : fileRename.newUri;
        try {
            const result: WorkspaceEdit = await this.server.sendRequest(
                'workspace/willRenameFiles',
                {
                    files: [{ oldUri, newUri }]
                }
            );
            return mapWorkspaceEditBack(this.projects, result);
        } catch (e) {
            Logger.debug('[tsgo] willRenameFiles failed', e);
            return null;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Project-wide features.
    // ---------------------------------------------------------------------------------------

    async getWorkspaceSymbols(
        query: string,
        cancellationToken?: CancellationToken
    ): Promise<WorkspaceSymbol[] | null> {
        if (!this.featureEnabled('workspaceSymbols')) {
            return null;
        }
        // Workspace-wide, so every project opened so far has to have been materialised. Projects
        // nobody has touched are not searched, which matches what the JS engine does.
        await Promise.all(this.projects.all().map((s) => this.ensureProjectOpened(s)));
        try {
            const result: any = await this.server.sendRequest(
                'workspace/symbol',
                { query },
                cancellationToken
            );
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
                        this.projects,
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

    async fileReferences(
        uri: string,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        // tsgo has no file-references request; approximate it by asking for references to the
        // component's default export, which is what the JS engine surfaces in practice.
        return this.findComponentReferences(uri, cancellationToken);
    }

    async findComponentReferences(
        uri: string,
        cancellationToken?: CancellationToken
    ): Promise<Location[] | null> {
        const filePath = urlToPath(uri);
        if (!filePath) {
            return null;
        }
        await this.watchWork;
        const managedDocument = this.docManager.get(uri);
        let snapshot: SvelteDocumentSnapshot | undefined;
        let shadowPath: string;
        if (managedDocument?.openedByClient) {
            // Cross-file component references are requested through a custom method rather than
            // one of the ordinary textDocument handlers. Wait for any eager didOpen/didChange
            // work, then explicitly synchronize the current buffer so a request made in the
            // same turn as an edit cannot observe the previous disk-backed component export.
            await this.svelteLifecycle.get(filePath)?.catch(() => undefined);
            const synced = await this.syncDocument(managedDocument);
            if (!synced) {
                return null;
            }
            snapshot = synced.snapshot;
            shadowPath = synced.shadowPath;
        } else {
            const shadows = this.projects.forFile(filePath);
            await this.ensureProjectOpened(shadows);
            snapshot = this.projects.ensureSnapshot(filePath);
            shadowPath = shadows.getShadowPath(filePath);
        }
        if (!snapshot) {
            return null;
        }
        // Svelte 4 emits `export default class Name`; Svelte 5 emits
        // `const Name = ...; export default Name`. Resolve the identifier structurally so both
        // forms, comments and formatting changes stay supported.
        const offset = findDefaultExportIdentifierOffset(snapshot.getFullText());
        if (offset === undefined) {
            return null;
        }
        const position = snapshot.positionAt(offset);
        try {
            const result: any = await this.server.sendRequest(
                'textDocument/references',
                {
                    textDocument: {
                        uri: pathToUrl(shadowPath)
                    },
                    position,
                    context: { includeDeclaration: false }
                },
                cancellationToken
            );
            return this.toLocations(result);
        } catch (e) {
            Logger.debug('[tsgo] component references failed', e);
            return null;
        }
    }

    async prepareCallHierarchy(
        document: Document,
        position: Position,
        cancellationToken?: CancellationToken
    ): Promise<CallHierarchyItem[] | null> {
        const response = await this.requestAt<any>(
            document,
            position,
            'textDocument/prepareCallHierarchy',
            {},
            cancellationToken
        );
        if (!Array.isArray(response?.result)) {
            return null;
        }
        return response!.result
            .map((item: any) => this.mapCallHierarchyItem(item))
            .filter(isNotNullOrUndefined);
    }

    private mapCallHierarchyItem(item: any): CallHierarchyItem | undefined {
        const filePath = urlToPath(item.uri);
        const originalPath = filePath ? this.projects.getOriginalPath(filePath) : undefined;
        if (
            originalPath &&
            (item.name === internalHelpers.renderName || isGeneratedSvelteComponentName(item.name))
        ) {
            const snapshot = this.projects.ensureSnapshot(originalPath);
            if (!snapshot) {
                return undefined;
            }
            const start = Position.create(0, 0);
            return {
                ...item,
                name: basename(originalPath),
                kind: SymbolKind.Module,
                uri: pathToUrl(originalPath),
                range: Range.create(
                    start,
                    snapshot.parent.positionAt(snapshot.parent.getTextLength())
                ),
                selectionRange: Range.create(start, start)
            };
        }
        const location = mapLocationBack(
            this.projects,
            item.uri,
            item.selectionRange ?? item.range
        );
        if (!location) {
            return undefined;
        }
        const full = mapLocationBack(this.projects, item.uri, item.range) ?? location;
        return { ...item, uri: location.uri, range: full.range, selectionRange: location.range };
    }

    async getIncomingCalls(
        item: CallHierarchyItem,
        cancellationToken?: CancellationToken
    ): Promise<CallHierarchyIncomingCall[] | null> {
        return this.callHierarchyCalls(
            'callHierarchy/incomingCalls',
            item,
            'from',
            cancellationToken
        );
    }

    async getOutgoingCalls(
        item: CallHierarchyItem,
        cancellationToken?: CancellationToken
    ): Promise<CallHierarchyOutgoingCall[] | null> {
        return this.callHierarchyCalls(
            'callHierarchy/outgoingCalls',
            item,
            'to',
            cancellationToken
        );
    }

    private async callHierarchyCalls(
        method: string,
        item: CallHierarchyItem,
        key: 'from' | 'to',
        cancellationToken?: CancellationToken
    ) {
        // Send the item back in generated coordinates, which is where tsgo left it.
        const filePath = urlToPath(item.uri);
        // Ordinary TS/JS items are already in the coordinates tsgo expects. Calling
        // `ensureSnapshot` for them attempts to run the Svelte transform on TypeScript source
        // and manufactures a non-existent shadow URI, which makes incoming calls disappear.
        const snapshot = filePath?.endsWith('.svelte')
            ? this.projects.ensureSnapshot(filePath)
            : undefined;
        const generatedItem = snapshot
            ? {
                  ...item,
                  uri: pathToUrl(this.projects.forFile(filePath!).getShadowPath(filePath!)),
                  range: mapRangeToGenerated(snapshot, item.range),
                  selectionRange: mapRangeToGenerated(snapshot, item.selectionRange)
              }
            : item;

        try {
            const result: any = await this.server.sendRequest(
                method,
                { item: generatedItem },
                cancellationToken
            );
            if (!Array.isArray(result)) {
                return null;
            }
            return result
                .map((call: any) => {
                    const mappedItem = this.mapCallHierarchyItem(call[key]);
                    if (!mappedItem) {
                        return undefined;
                    }
                    const rangeSnapshot =
                        key === 'to'
                            ? snapshot
                            : (() => {
                                  const target = urlToPath(call[key].uri);
                                  const targetOriginal = target
                                      ? this.projects.getOriginalPath(target)
                                      : undefined;
                                  return targetOriginal
                                      ? this.projects.ensureSnapshot(targetOriginal)
                                      : undefined;
                              })();
                    const fromRanges = (call.fromRanges ?? [])
                        .map((r: Range) =>
                            rangeSnapshot ? mapRangeToOriginal(rangeSnapshot, r) : r
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

    openTsOrJsFile(fileName: string, text: string, languageId: string, _version?: number): void {
        this.recordSavedSourceGraphBaseline(fileName, text);
        this.componentInfo?.invalidateFile(fileName);
        void this.server
            .openDocument(fileName, text, languageId || languageIdForFile(fileName))
            .catch((e) => Logger.debug(`[tsgo] could not open ${fileName}`, e));
    }

    updateTsOrJsFile(
        fileName: string,
        changes: TextDocumentContentChangeEvent[],
        text?: string,
        _version?: number,
        languageId?: string
    ): void {
        let nextText = text;
        if (nextText === undefined) {
            // Backwards compatibility for the extension's legacy custom notification, which
            // carried only incremental edits. Prefer the overlay as the base; if this is the
            // first event, the saved file is the best available baseline.
            let previous = this.server.getOpenText(fileName);
            if (previous === undefined) {
                try {
                    previous = fs.readFileSync(fileName, 'utf8');
                } catch (e) {
                    Logger.debug(`[tsgo] could not read changed file ${fileName}`, e);
                    return;
                }
            }
            nextText = applyContentChanges(previous, changes);
        }

        this.componentInfo?.invalidateFile(fileName);
        const update = this.server.isOpen(fileName)
            ? this.server.updateDocument(fileName, changes, nextText, languageId)
            : this.server.openDocument(
                  fileName,
                  nextText,
                  languageId || languageIdForFile(fileName)
              );
        void update.catch((e) => Logger.debug(`[tsgo] could not update ${fileName}`, e));
    }

    closeTsOrJsFile(fileName: string): void {
        this.componentInfo?.invalidateFile(fileName);
        void this.server
            .closeDocument(fileName)
            .catch((e) => Logger.debug(`[tsgo] could not close ${fileName}`, e));
    }

    onWatchFileChanges(changes: OnWatchFileChangesPara[]): void {
        changes = changes.filter((change) => {
            const fileName = normalizeWatchPath(change.fileName);
            const identity = watchEventIdentity(change);
            if (this.lastWatchIdentity.get(fileName) === identity) {
                return false;
            }
            this.lastWatchIdentity.delete(fileName);
            this.lastWatchIdentity.set(fileName, identity);
            if (this.lastWatchIdentity.size > 2_048) {
                this.lastWatchIdentity.delete(this.lastWatchIdentity.keys().next().value!);
            }
            return true;
        });
        if (!changes.length) {
            return;
        }

        this.componentInfo?.clearCache();
        // Classify once. Source classification records the new import-graph baseline, so calling
        // it in `some()` and then again during the rebuild would turn the change which triggered
        // that rebuild into a false negative. Filtering also evaluates every coalesced event;
        // `some()` would stop after the first structural one and leave later baselines stale.
        const structuralChanges = changes.filter((change) => this.isStructuralWatchChange(change));
        const epoch = structuralChanges.length ? ++this.structuralEpoch : this.structuralEpoch;
        const task = this.watchWork
            .catch(() => undefined)
            .then(() => this.processWatchFileChanges(changes, structuralChanges, epoch));
        // Keep the rejected task observable by feature requests (so they cannot proceed against
        // a half-rebuilt graph), while attaching a handler to avoid an unhandled rejection.
        void task.catch((error) => Logger.error('[tsgo] watched-file rebuild failed', error));
        this.watchWork = task;
    }

    private async processWatchFileChanges(
        changes: OnWatchFileChangesPara[],
        structuralChanges: OnWatchFileChangesPara[],
        epoch: number
    ): Promise<void> {
        const structural = structuralChanges.length > 0;
        const previousOverlays = new Map(this.svelteOverlayBySource);

        if (structural) {
            if (changes.some((change) => /(?:^|[/\\])package\.json$/.test(change.fileName))) {
                this.invalidateEngineCaches?.();
            }
            this.materializedShadowsBySource.clear();
            const invalidated = new Set<ShadowManager>();
            for (const change of structuralChanges) {
                for (const project of this.projects.invalidateForStructuralChange(
                    change.fileName
                )) {
                    invalidated.add(project);
                }
            }
            for (const project of invalidated) {
                project.invalidateStructuralCaches();
                this.opened.delete(project);
            }

            // Remove obsolete shadow intent before restarting. Real TS/JS overlays remain in
            // TsGoServer.desiredDocuments and are replayed into the replacement child.
            await Promise.all(
                [...new Set(previousOverlays.values())].map((shadowPath) =>
                    this.server.closeDocument(shadowPath)
                )
            );
            this.svelteOverlayBySource.clear();

            if (
                changes.some(
                    (change) =>
                        isSvelteConfigFile(change.fileName) ||
                        /(?:^|[/\\])package\.json$/.test(change.fileName)
                )
            ) {
                configLoader.invalidateConfigs();
                await Promise.all(
                    this.docManager
                        .getAllOpenedByClient()
                        .map(([, document]) => document.reloadConfig())
                );
            }

            // Rebuild every open document's saved project baseline before the replacement child
            // starts. A nearer tsconfig may assign each document to a different new manager.
            const openSvelteDocuments = this.docManager
                .getAllOpenedByClient()
                .map(([, document]) => document)
                .filter(
                    (document) =>
                        !!document.getFilePath()?.endsWith('.svelte') &&
                        this.desiredOpenSvelte.has(document.getFilePath()!)
                );
            await Promise.all(
                [...new Set(openSvelteDocuments.map((document) => document.getFilePath()!))].map(
                    (filePath) => this.ensureProjectOpened(this.projects.forFile(filePath))
                )
            );
            await this.server.restart();
            await Promise.all(
                openSvelteDocuments.map((document) => this.syncDocumentNow(document, epoch))
            );
        }

        const forwarded: Array<{ uri: string; type: FileChangeType }> = [];
        for (const change of changes) {
            if (!change.fileName.endsWith('.svelte')) {
                forwarded.push({ uri: pathToUrl(change.fileName), type: change.changeType });
                continue;
            }
            const shadows = this.projects.forFile(change.fileName);
            const currentOverlay = this.svelteOverlayBySource.get(change.fileName);
            const shadowPath =
                change.changeType === FileChangeType.Deleted
                    ? (currentOverlay ??
                      previousOverlays.get(change.fileName) ??
                      shadows.getShadowPath(change.fileName))
                    : shadows.getShadowPath(change.fileName);
            const managedDocument = this.docManager.get(pathToUrl(change.fileName));
            const materializedPaths = new Set(
                this.materializedShadowsBySource.get(change.fileName) ?? []
            );
            materializedPaths.add(shadowPath);
            if (change.changeType === FileChangeType.Deleted) {
                this.materializedShadowsBySource.delete(change.fileName);
                for (const materializedPath of materializedPaths) {
                    shadows.removeShadow(materializedPath);
                    forwarded.push({
                        uri: pathToUrl(materializedPath),
                        type: change.changeType
                    });
                }
                // Keep an editor-open buffer alive even when its backing file is deleted. It is
                // still a valid LSP overlay until didClose, matching TypeScript's behavior.
                if (managedDocument?.openedByClient) {
                    continue;
                }
                shadows.deleteSnapshot(change.fileName);
                shadows.unpinSnapshot?.(change.fileName);
                this.svelteOverlayBySource.delete(change.fileName);
                await Promise.all(
                    [...materializedPaths].map((materializedPath) =>
                        this.server.closeDocument(materializedPath)
                    )
                );
                continue;
            }
            // Structural materialisation already regenerated this shadow with the new graph and
            // config. Re-transforming here only retains another snapshot and repeats work.
            if (structural) {
                forwarded.push({ uri: pathToUrl(shadowPath), type: change.changeType });
                continue;
            }
            this.materializedShadowsBySource.delete(change.fileName);
            try {
                // Watched-file materialisation is always the saved baseline. A client-open
                // document may be dirty (or hot-exit restored); writing it here would make a
                // later close/discard expose unsaved text as if it came from disk.
                const document = new Document(
                    pathToUrl(change.fileName),
                    fs.readFileSync(change.fileName, 'utf8')
                );
                await document.configPromise;
                const snapshot = shadows.transform(document);
                const generatedText = snapshot.getFullText();
                for (const materializedPath of materializedPaths) {
                    shadows.writeShadow(materializedPath, generatedText);
                    this.markShadowMaterialized(change.fileName, materializedPath);
                    this.componentInfo?.invalidateFile(materializedPath);
                    forwarded.push({
                        uri: pathToUrl(materializedPath),
                        type: change.changeType
                    });
                }
                if (!managedDocument?.openedByClient) {
                    shadows.deleteSnapshot(change.fileName);
                } else {
                    // Restore the mapping snapshot for the dirty overlay; the server already has
                    // its latest generated text from the documentChange lifecycle.
                    await managedDocument.configPromise;
                    shadows.transform(managedDocument);
                }
            } catch (e) {
                Logger.debug(`[tsgo] could not refresh shadow for ${change.fileName}`, e);
            }
        }
        await this.server.notifyWatchedFiles(forwarded);
    }

    /** Whether a watched save changes project/config membership or source reachability. */
    private isStructuralWatchChange(change: OnWatchFileChangesPara): boolean {
        const fileName = change.fileName;
        if (
            /(?:^|[/\\])(?:tsconfig|jsconfig)\.json$/.test(fileName) ||
            /(?:^|[/\\])package\.json$/.test(fileName) ||
            isSvelteConfigFile(fileName)
        ) {
            return true;
        }
        if (!/\.(?:svelte|[cm]?[jt]sx?)$/i.test(fileName)) {
            return false;
        }

        const key = normalizeWatchPath(fileName);
        if (change.changeType === FileChangeType.Deleted) {
            this.sourceGraphSignatures.delete(key);
            return true;
        }

        const signature = sourceModuleGraphSignatureFromFile(fileName);
        const previous = this.sourceGraphSignatures.get(key);
        this.sourceGraphSignatures.set(key, signature);

        // Creation changes membership even for a leaf. A Changed event, however, means the file
        // already belongs to the watched program. When no baseline exists yet, record this first
        // observation without rebuilding: treating every unopened file's first save as structural
        // cleared every project manager and restarted tsgo during ordinary editing. Subsequent
        // import/re-export graph changes are still detected against the recorded signature.
        return (
            change.changeType === FileChangeType.Created ||
            (previous !== undefined && previous !== signature)
        );
    }

    /** Seed normal editor saves without rereading every project source during warm startup. */
    private recordSavedSourceGraphBaseline(fileName: string, fallbackText: string): void {
        const key = normalizeWatchPath(fileName);
        if (this.sourceGraphSignatures.has(key)) {
            return;
        }
        try {
            this.sourceGraphSignatures.set(
                key,
                sourceModuleGraphSignature(fs.readFileSync(fileName, 'utf8'))
            );
        } catch {
            // A newly-created/virtual file has no disk baseline; its opened buffer is the only
            // authoritative starting graph until the creation event arrives.
            this.sourceGraphSignatures.set(key, sourceModuleGraphSignature(fallbackText));
        }
    }

    /**
     * Forget which projects were materialised — after a tsgo restart the new process needs the
     * didOpen/materialisation pass again. Cheap to re-run: the shadows on disk are current, so
     * the pass mostly stat()s them and moves on.
     */
    resetProjects() {
        this.opened.clear();
        // A child restart does not invalidate the canonical on-disk shadows. Keep the shared
        // materialisation set so replaying a new child does not re-stat the monorepo.
        const cancellations = new Set([
            ...[...this.diagnosticsInFlight.values()].map((flight) => flight.cancellation),
            ...[...this.activeDiagnosticChecks.values()].map((check) => check.cancellation)
        ]);
        this.diagnosticsInFlight.clear();
        for (const cancellation of cancellations) {
            cancellation.cancel();
            this.stats.cancellations++;
        }
        this.activeDiagnosticChecks.clear();
        this.diagnosticProjectTails.clear();
        this.legendMap = undefined;
        this.legendModifierMap = undefined;
        this.componentInfo?.clearCache();
    }

    private getLegendMaps(): { types: number[] | undefined; modifiers: number[] | undefined } {
        if (this.legendMap === undefined) {
            const legend = this.server.getTokenLegend();
            const target = getSemanticTokenLegends();
            this.legendMap = legend ? buildLegendMap(legend.tokenTypes, target.tokenTypes) : null;
            this.legendModifierMap = legend
                ? buildLegendMap(legend.tokenModifiers, target.tokenModifiers)
                : null;
        }
        return {
            types: this.legendMap ?? undefined,
            modifiers: this.legendModifierMap ?? undefined
        };
    }

    dispose() {
        this.desiredOpenSvelte.clear();
        this.svelteLifecycle.clear();
        const cancellations = new Set([
            ...[...this.diagnosticsInFlight.values()].map((flight) => flight.cancellation),
            ...[...this.activeDiagnosticChecks.values()].map((check) => check.cancellation)
        ]);
        for (const cancellation of cancellations) {
            cancellation.cancel();
        }
        this.diagnosticsInFlight.clear();
        this.activeDiagnosticChecks.clear();
        void this.componentInfo?.dispose();
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
/**
 * Phase timings for the keystroke path, behind SVELTE_LS_TIMING=1.
 *
 * The interesting question about a 400ms round trip is which of the four things it does owns it,
 * and that is not answerable from the outside: the client only sees didChange in and
 * publishDiagnostics out. Off by default — reading Date.now() twice per request is cheap, but
 * accumulating and printing it is not free either.
 */
const TIMING_FILE = process.env.SVELTE_LS_TIMING;
const TIMING = !!TIMING_FILE;
const timings = new Map<string, number[]>();
function timing(phase: string, ms: number) {
    const xs = timings.get(phase) ?? [];
    xs.push(ms);
    timings.set(phase, xs);
    if (phase === 'total' && xs.length % 5 === 0) {
        const line = [...timings.entries()]
            .map(([name, values]) => {
                if (name.startsWith('sev') || name === 'items') {
                    return `${name}=${values.reduce((a, b) => a + b, 0)}`;
                }
                const sorted = [...values].sort((a, b) => a - b);
                return `${name} ${sorted[Math.floor(sorted.length / 2)]}ms`;
            })
            .join('  ');
        // Not the Logger: on an stdio server that either goes nowhere useful or into the
        // protocol stream. A file is boring and always readable.
        try {
            fs.appendFileSync(TIMING_FILE!, `n=${xs.length}  ${line}\n`);
        } catch {}
    }
}

/**
 * One ranged change from the previous overlay text to the next, or a full-text change when
 * there is no usable base. tsgo has no incremental re-parse — this saves serializing the whole
 * generated file (often 100KB+) across the pipe twice per keystroke, not tsgo CPU.
 */
function incrementalChanges(
    previous: string | undefined,
    text: string
): TextDocumentContentChangeEvent[] {
    if (previous === undefined || previous === text) {
        return [{ text }];
    }
    const change = computeChangeRange(previous, text);
    // A rewrite touching most of the document isn't worth the position bookkeeping.
    if (change.span.length > previous.length * 0.7) {
        return [{ text }];
    }
    const lineOffsets = getLineOffsets(previous);
    return [
        {
            range: {
                start: positionAt(change.span.start, previous, lineOffsets),
                end: positionAt(change.span.start + change.span.length, previous, lineOffsets)
            },
            text: text.slice(change.span.start, change.span.start + change.newLength)
        }
    ];
}

/**
 * Ω-ignore regions of a generated text, computed once per snapshot instead of three full-text
 * scans per diagnostic (`isInGeneratedCode`); a document's diagnostics run is O(items · log
 * regions) against this.
 */
const generatedRegionsCache = new WeakMap<SvelteDocumentSnapshot, Array<[number, number]>>();
const IGNORE_START = '/*Ωignore_startΩ*/';
const IGNORE_END = '/*Ωignore_endΩ*/';

function generatedRegionsOf(snapshot: SvelteDocumentSnapshot): Array<[number, number]> {
    let regions = generatedRegionsCache.get(snapshot);
    if (!regions) {
        regions = [];
        const text = snapshot.getFullText();
        let from = 0;
        for (;;) {
            const start = text.indexOf(IGNORE_START, from);
            if (start < 0) {
                break;
            }
            const end = text.indexOf(IGNORE_END, start);
            if (end < 0) {
                regions.push([start, text.length]);
                break;
            }
            regions.push([start, end + IGNORE_END.length]);
            from = end + IGNORE_END.length;
        }
        generatedRegionsCache.set(snapshot, regions);
    }
    return regions;
}

/**
 * Whether a span starts inside an Ω-ignore region. Mirrors `isInGeneratedCode`, which also
 * keys off where the span *starts*.
 */
function inGeneratedRegion(snapshot: SvelteDocumentSnapshot, start: number): boolean {
    const regions = generatedRegionsOf(snapshot);
    let low = 0;
    let high = regions.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const [regionStart, regionEnd] = regions[mid];
        if (start >= regionEnd) {
            low = mid + 1;
        } else if (start < regionStart) {
            high = mid - 1;
        } else {
            return true;
        }
    }
    return false;
}

/** Match the classic provider's cheap filter for svelte2tsx helper-call parameter hints. */
function isGeneratedParameterInlayHint(
    sourceFile: ts.SourceFile,
    snapshot: SvelteDocumentSnapshot,
    hint: InlayHint
): boolean {
    if (hint.kind !== InlayHintKind.Parameter) {
        return false;
    }
    const offset = snapshot.offsetAt(hint.position);
    const call = findContainingNode(
        sourceFile,
        { start: offset, length: 0 },
        (node): node is ts.CallExpression | ts.NewExpression =>
            ts.isCallOrNewExpression(node) &&
            !!node.arguments?.some((argument) => argument.getStart(sourceFile) === offset)
    );
    if (!call) {
        return false;
    }
    const expression = call.expression.getText(sourceFile);
    return (
        expression.includes('.$on') ||
        expression.includes('.createElement') ||
        expression.includes('__sveltets_') ||
        expression.startsWith('$$_')
    );
}

/**
 * Map a completion edit — plain `{range}` or the LSP `{insert, replace}` shape — back to
 * original coordinates. Undefined when any involved range lives purely in generated code.
 */
function mapCompletionEdit(snapshot: SvelteDocumentSnapshot, edit: any): any | undefined {
    if (edit.range) {
        const range = mapRangeToOriginal(snapshot, edit.range);
        return isMapped(range) ? { ...edit, range } : undefined;
    }
    if (edit.insert && edit.replace) {
        const insert = mapRangeToOriginal(snapshot, edit.insert);
        const replace = mapRangeToOriginal(snapshot, edit.replace);
        return isMapped(insert) && isMapped(replace) ? { ...edit, insert, replace } : undefined;
    }
    return undefined;
}

/**
 * How long a diagnostics pull waits for the typing burst to settle. Tunable for benchmarks via
 * the same env the (dead) push path used.
 */
const PULL_QUIESCENCE_MS = process.env.SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS
    ? Number(process.env.SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS)
    : 150;

/** Where tsgo's own completion payload is parked while `data` carries the document uri. */
const TSGO_DATA = '__tsgoData';

/** Trigger characters tsgo will accept on `textDocument/completion`. */
const TSGO_TRIGGER_CHARACTERS = new Set(['.', '"', "'", '`', '/', '@', '<', '#', ' ']);

const ENSURE_COMPONENT = '__sveltets_2_ensureComponent(';
/** How far past the mapped offset to look before giving up, in characters. */
const ENSURE_COMPONENT_SEARCH_WINDOW = 400;

const COMPONENT_SUFFIX = '__SvelteComponent_';

function stripComponentSuffix(text: string): string {
    return text.endsWith(COMPONENT_SUFFIX) ? text.slice(0, -COMPONENT_SUFFIX.length) : text;
}

/** @internal Exported for a focused Svelte 4/5 transform regression test. */
export function findDefaultExportIdentifierOffset(text: string): number | undefined {
    const source = ts.createSourceFile(
        'component.svelte.tsx',
        text,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TSX
    );

    for (let index = source.statements.length - 1; index >= 0; index--) {
        const statement = source.statements[index];
        if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
            let expression = statement.expression;
            while (ts.isParenthesizedExpression(expression)) {
                expression = expression.expression;
            }
            if (ts.isIdentifier(expression)) {
                return expression.getStart(source);
            }
        }

        if (ts.isClassDeclaration(statement) && statement.name) {
            const modifiers = ts.canHaveModifiers(statement)
                ? ts.getModifiers(statement)
                : undefined;
            if (
                modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
                modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
            ) {
                return statement.name.getStart(source);
            }
        }
    }
    return undefined;
}

function languageIdForFile(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.tsx')) {
        return 'typescriptreact';
    }
    if (lower.endsWith('.jsx')) {
        return 'javascriptreact';
    }
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
        return 'javascript';
    }
    return 'typescript';
}

/** Native LSP does not label a diagnostic's compiler phase; these are TS parser/grammar bands. */
function isSyntacticDiagnosticCode(code: number): boolean {
    return (code >= 1000 && code < 2000) || (code >= 17000 && code < 18000);
}

function diagnosticCategory(severity: DiagnosticSeverity | undefined): ts.DiagnosticCategory {
    switch (severity) {
        case DiagnosticSeverity.Warning:
            return ts.DiagnosticCategory.Warning;
        case DiagnosticSeverity.Information:
            return ts.DiagnosticCategory.Message;
        case DiagnosticSeverity.Hint:
            return ts.DiagnosticCategory.Suggestion;
        default:
            return ts.DiagnosticCategory.Error;
    }
}

function isSvelteConfigFile(fileName: string): boolean {
    return /(?:^|[/\\])(?:svelte|vite)\.config\.(?:[cm]?[jt]s)$/.test(fileName);
}

/**
 * Stable identity of the module-graph facts ShadowManager uses for reachability.
 *
 * This intentionally ignores ordinary source text, so a leaf edit remains incremental. The
 * ambiguity bit is equally important as the literal imports: adding `import.meta.glob` or a
 * computed dynamic import changes reachability from provable/narrow to the broad fallback even
 * though TypeScript's preprocessor reports no new literal import.
 */
export function sourceModuleGraphSignature(text: string): string {
    const info = ts.preProcessFile(text, true, true);
    const names = (entries: readonly ts.FileReference[]) =>
        entries.map((entry) => entry.fileName).sort();
    return JSON.stringify({
        imports: names(info.importedFiles),
        references: names(info.referencedFiles),
        types: names(info.typeReferenceDirectives),
        libs: names(info.libReferenceDirectives),
        ambiguous:
            /\b(?:import|require)\s*\(\s*(?!['"`])\S/.test(text) ||
            /\b(?:import|require)\s*\(\s*`[^`]*\$\{/.test(text) ||
            /\bimport\.meta\.glob(?:Eager)?\s*\(/.test(text)
    });
}

function sourceModuleGraphSignatureFromFile(fileName: string): string {
    try {
        return sourceModuleGraphSignature(fs.readFileSync(fileName, 'utf8'));
    } catch {
        return '<unreadable>';
    }
}

function normalizeWatchPath(fileName: string): string {
    return fileName.replace(/\\/g, '/');
}

function watchEventIdentity(change: OnWatchFileChangesPara): string {
    try {
        const stat = fs.statSync(change.fileName);
        return `${change.changeType}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {
        return `${change.changeType}:missing`;
    }
}

/** A conservative pre-transform exit for ordinary markup text completion. */
function isClearlyPlainMarkup(text: string, offset: number): boolean {
    const before = text.slice(0, offset);
    const lastLt = before.lastIndexOf('<');
    const lastGt = before.lastIndexOf('>');
    const lastOpenExpression = before.lastIndexOf('{');
    const lastCloseExpression = before.lastIndexOf('}');
    const boundary = Math.max(lastLt, lastGt, lastOpenExpression, lastCloseExpression);
    if (boundary < 0) {
        return true;
    }
    if (boundary !== lastGt && boundary !== lastCloseExpression) {
        return false;
    }
    // A quote after the boundary can only belong to malformed/incomplete markup; let tsgo and
    // the post-transform AST check decide instead of suppressing a potentially useful result.
    const fragment = before.slice(boundary + 1);
    return !/[<'"`{]/.test(fragment);
}

function applyContentChanges(text: string, changes: TextDocumentContentChangeEvent[]): string {
    for (const change of changes) {
        if (!('range' in change)) {
            text = change.text;
            continue;
        }
        const lineOffsets = getLineOffsets(text);
        const start = offsetAt(change.range.start, text, lineOffsets);
        const end = offsetAt(change.range.end, text, lineOffsets);
        text = text.slice(0, start) + change.text + text.slice(end);
    }
    return text;
}
