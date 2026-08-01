import { ChildProcess, spawn } from 'child_process';
import globrex from 'globrex';
import { relative as relativePath } from 'path';
import {
    CancellationToken,
    createProtocolConnection,
    ProtocolConnection,
    StreamMessageReader,
    StreamMessageWriter
} from 'vscode-languageserver/node';
import {
    ConfigurationRequest,
    DidChangeConfigurationNotification,
    DidChangeWatchedFilesNotification,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    DidOpenTextDocumentNotification,
    FileEvent,
    FileSystemWatcher,
    InitializeRequest,
    InitializedNotification,
    RegistrationParams,
    RegistrationRequest,
    TextDocumentContentChangeEvent,
    UnregistrationParams,
    UnregistrationRequest,
    WorkDoneProgressCreateRequest
} from 'vscode-languageserver-protocol';
import { getSemanticTokenLegends } from '../../../lib/semanticToken/semanticTokenLegend';
import { normalizePath, pathToUrl, urlToPath } from '../../../utils';
import { Logger } from '../../../logger';
import { ResolvedTsGoEngine } from './TsGoEngine';

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 60_000;

/**
 * Preferences handed to tsgo. These arrive through a `workspace/configuration` *response*,
 * not `initializationOptions`, and only in VS Code's nested shape — raw TypeScript preference
 * names are ignored. Answering with an empty object wipes the settings entirely, so this must
 * never be `{}`.
 */
function tsGoConfiguration(config: any = {}, scopeUri?: string) {
    const scopePath = scopeUri ? urlToPath(scopeUri) : undefined;
    const generatedSvelteScope =
        !!scopePath &&
        /[/\\]node_modules[/\\]\.cache[/\\]svelte-lsp[/\\]svelte[/\\].*\.svelte\.tsx$/i.test(
            scopePath
        );
    // Only keys with a `config:` path in tsgo's settings unmarshalling are listed — verified
    // against the binary; `allowIncompleteCompletions`, `includePackageJsonAutoImports` and
    // `suggest.completeFunctionCalls` have none and were silently ignored.
    return {
        preferences: {
            ...(config.preferences ?? {}),
            // 'js' would leak a shadow's own extension into inserted imports
            // (`./Button.svelte.tsx`). Override only generated Svelte requests; real TS/JS
            // buffers must retain the user's configured preference.
            ...(generatedSvelteScope ? { importModuleSpecifierEnding: 'index' } : {})
        },
        suggest: {
            autoImports: true,
            ...(config.suggest ?? {})
        },
        inlayHints: config.inlayHints ?? {},
        ...(config.referencesCodeLens
            ? { referencesCodeLens: config.referencesCodeLens }
            : undefined),
        ...(config.implementationsCodeLens
            ? { implementationsCodeLens: config.implementationsCodeLens }
            : undefined)
    };
}

export interface TsGoServerOptions {
    /** The resolved launcher and matching API package for this exact tsgo build. */
    engine: ResolvedTsGoEngine;
    /** Directory the server is rooted at — normally the workspace source root. */
    workspacePath: string;
    /**
     * Additional workspace folders (a multi-root editor workspace). tsgo assigns projects only
     * to files under its workspace folders, so a folder it never hears about gets shadows but
     * no checking.
     */
    workspacePaths?: string[];
    /** Resolve the VS Code-shaped settings requested by the child. */
    getConfiguration?: (section?: string, scopeUri?: string) => unknown;
    /** Dynamic child watcher registrations which the outer LSP client should install. */
    onDidRegisterWatchers?: (watchers: FileSystemWatcher[]) => void;
    /** Called when the child dies unexpectedly, so documents can be replayed into a new one. */
    onRestart?: () => void;
    /**
     * Finish publishing the current project graph before a new child observes the filesystem.
     * This runs only for initial startup and replacement-child startup, never for an ordinary
     * didOpen against an already-running child.
     */
    beforeStart?: () => Promise<void>;
    /** @internal Process factory used by focused lifecycle tests. */
    spawnProcess?: typeof spawn;
    /** @internal Protocol factory used by focused lifecycle tests. */
    createConnection?: (process: ChildProcess) => ProtocolConnection;
    /** @internal Bounded initialize deadline, shortened by focused lifecycle tests. */
    initializationTimeoutMs?: number;
}

interface OpenDocumentState {
    languageId: string;
    text: string;
    revision: number;
}

/**
 * Owns a child `tsgo --lsp` process and speaks LSP to it.
 *
 * Everything crossing this boundary is in *generated* coordinates (offsets into the `.tsx`
 * shadow), never original `.svelte` coordinates. Mapping happens above this layer, because
 * several Svelte features — the `$store` rename repair in particular — issue requests at
 * synthesized generated offsets that have no original-file counterpart at all.
 */
export class TsGoServer {
    private proc: ChildProcess | undefined;
    private connection: ProtocolConnection | undefined;
    private starting: Promise<void> | undefined;
    private disposed = false;
    /**
     * tsgo's own semantic-token legend. Its indices are not ours, so tokens have to be
     * translated through this before being handed to the editor or every colour is wrong.
     */
    private tokenLegend: { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
    /** Documents the current child has actually seen. */
    private readonly openDocuments = new Map<string, OpenDocumentState>();
    private versions = new Map<string, number>();
    /** Latest caller intent, retained across startup and child crashes. */
    private readonly desiredDocuments = new Map<string, OpenDocumentState>();
    /** Also records closes, so continuations from older open/update calls become harmless. */
    private readonly documentRevisions = new Map<string, number>();
    /**
     * Monotonic counter of everything that can change what tsgo knows: opens, real content
     * changes, closes, watched-file rewrites, restarts. Consumers cache against it — the
     * checker API session skips its `updateSnapshot` round trip while this hasn't moved.
     */
    private generationCounter = 0;
    /** Ignore duplicate/late termination signals (`error` is commonly followed by `exit`). */
    private readonly failedProcesses = new WeakSet<ChildProcess>();
    /** LSConfigManager updates several setting groups synchronously; send one child refresh. */
    private configurationUpdateQueued = false;
    /** Child restarts repeat the same dynamic registrations; install each outer watcher once. */
    private readonly registeredWatcherKeys = new Set<string>();
    /** Active child registration id -> watchers. Installed outer watchers remain reusable. */
    private readonly watcherRegistrations = new Map<string, FileSystemWatcher[]>();
    /** A deliberate restart waits for active feature requests and gates newly arriving ones. */
    private restartWork: Promise<void> | undefined;
    private activeRequests = 0;
    private readonly requestIdleWaiters = new Set<() => void>();
    private readonly registeredWatchers: Array<{
        watcher: FileSystemWatcher;
        regex: RegExp;
        basePath?: string;
    }> = [];

    constructor(private readonly options: TsGoServerOptions) {}

    get generation(): number {
        return this.generationCounter;
    }

    /** Exact native engine selected for this session; exposed to benchmark telemetry. */
    get engineInfo(): { packageName: string; version: string } {
        return {
            packageName: this.options.engine.packageName,
            version: this.options.engine.version
        };
    }

    /** Current native child PID, if materialisation has started it. */
    get processId(): number | undefined {
        return this.proc?.pid;
    }

    /** Open overlays retained for replay; exposed for lifecycle/RSS acceptance tests. */
    get openDocumentCount(): number {
        return this.desiredDocuments.size;
    }

    /** Documents confirmed open in the current child, excluding replay intent still in flight. */
    get childOpenDocumentCount(): number {
        return this.openDocuments.size;
    }

    /** Record a change tsgo observed outside the didOpen/didChange flow (watched files). */
    noteExternalChange() {
        this.generationCounter++;
    }

    private rebuildRegisteredWatchers(): void {
        const active = new Map<string, FileSystemWatcher>();
        for (const watchers of this.watcherRegistrations.values()) {
            for (const watcher of watchers) {
                active.set(JSON.stringify(watcher), watcher);
            }
        }

        this.registeredWatchers.length = 0;
        const newlyInstalled: FileSystemWatcher[] = [];
        for (const [key, watcher] of active) {
            const globPattern = watcher.globPattern;
            const pattern = typeof globPattern === 'string' ? globPattern : globPattern.pattern;
            const baseUri = typeof globPattern === 'string' ? undefined : globPattern.baseUri;
            const basePath = baseUri
                ? urlToPath(typeof baseUri === 'string' ? baseUri : baseUri.uri)
                : undefined;
            this.registeredWatchers.push({
                watcher,
                regex: globrex(normalizePath(pattern), {
                    globstar: true,
                    extended: true
                }).regex,
                ...(basePath ? { basePath: normalizePath(basePath) } : {})
            });
            if (!this.registeredWatcherKeys.has(key)) {
                this.registeredWatcherKeys.add(key);
                newlyInstalled.push(watcher);
            }
        }
        if (newlyInstalled.length) {
            this.options.onDidRegisterWatchers?.(newlyInstalled);
        }
    }

    /** The version last sent for a document, if it is open. */
    documentVersion(filePath: string): number | undefined {
        return this.versions.get(pathToUrl(filePath));
    }

    /** Latest intended text for an open document — the diff base for queued ranged changes. */
    getOpenText(filePath: string): string | undefined {
        return this.desiredDocuments.get(pathToUrl(filePath))?.text;
    }

    async start(): Promise<void> {
        if (this.disposed) {
            throw new Error('TsGoServer has been disposed');
        }
        if (!this.starting) {
            const attempt = this.doStart();
            this.starting = attempt;
            // A failed start must not be cached forever — the next request should try again.
            attempt.catch(() => {
                if (this.starting === attempt) {
                    this.starting = undefined;
                }
            });
        }
        return this.starting;
    }

    /**
     * Deliberately replace the child after a structural project/configuration change.
     * `desiredDocuments` is left intact and is replayed by {@link start}; callers should close
     * obsolete shadow URIs before invoking this so only the atomically rebuilt overlays return.
     */
    restart(): Promise<void> {
        if (this.restartWork) {
            return this.restartWork;
        }
        const attempt = this.doRestart();
        this.restartWork = attempt;
        const clear = () => {
            if (this.restartWork === attempt) {
                this.restartWork = undefined;
            }
        };
        void attempt.then(clear, clear);
        return attempt;
    }

    private async doRestart(): Promise<void> {
        if (this.disposed) {
            throw new Error('TsGoServer has been disposed');
        }
        await this.waitForActiveRequests();
        const proc = this.proc;
        const connection = this.connection;
        if (proc) {
            // The ensuing exit is intentional and must not race handleProcessFailure into
            // clearing a newer child or logging a false crash.
            this.failedProcesses.add(proc);
        }
        this.connection = undefined;
        this.proc = undefined;
        this.starting = undefined;
        this.openDocuments.clear();
        this.versions.clear();
        this.tokenLegend = undefined;
        this.generationCounter++;
        try {
            connection?.dispose();
        } catch {}
        try {
            if (proc) terminateChildProcess(proc);
        } catch {}
        this.options.onRestart?.();
        await this.start();
    }

    private waitForActiveRequests(): Promise<void> {
        if (this.activeRequests === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.requestIdleWaiters.add(resolve));
    }

    private async doStart(): Promise<void> {
        await this.options.beforeStart?.();
        if (this.disposed) {
            throw new Error('TsGoServer has been disposed');
        }
        this.watcherRegistrations.clear();
        this.registeredWatchers.length = 0;
        // `--lsp -stdio` is deliberate: `--stdio` and `lsp -stdio` both exit 1.
        const proc = (this.options.spawnProcess ?? spawn)(
            this.options.engine.command,
            [...this.options.engine.argsPrefix, '--lsp', '-stdio'],
            {
                cwd: this.options.workspacePath,
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );
        this.proc = proc;

        // `spawn()` reports ENOENT/EACCES asynchronously. Without an error listener Node treats
        // it as an unhandled EventEmitter error and takes down the whole language server.
        let rejectSpawn: (error: Error) => void;
        const spawnFailure = new Promise<never>((_, reject) => {
            rejectSpawn = reject;
        });
        proc.once('error', (error) => {
            this.handleProcessFailure(proc, `failed to start: ${error.message}`);
            rejectSpawn(error);
        });

        // Errors, not debug. A Go panic or a fatal startup error arrives here and nowhere else,
        // and routing it to a suppressed-by-default channel turns "tsgo died" into "the request
        // never came back" — which is indistinguishable from slowness and costs hours to chase.
        proc.stderr?.on('data', (d) => {
            const text = d.toString().trimEnd();
            if (!text) {
                return;
            }
            Logger.error(`[tsgo] ${text}`);
        });
        proc.on('exit', (code, signal) =>
            this.handleProcessFailure(proc, `exited unexpectedly (code=${code} signal=${signal})`)
        );

        const connection =
            this.options.createConnection?.(proc) ??
            createProtocolConnection(
                new StreamMessageReader(proc.stdout!),
                new StreamMessageWriter(proc.stdin!)
            );
        this.connection = connection;
        try {
            // tsgo asks the client for settings; see tsGoConfiguration().
            connection.onRequest(ConfigurationRequest.type, (params) =>
                (params.items ?? []).map((item) =>
                    tsGoConfiguration(
                        this.options.getConfiguration?.(item.section, item.scopeUri ?? undefined),
                        item.scopeUri ?? undefined
                    )
                )
            );
            // Accept dynamic registrations and relay file-watch requests to the outer LSP client.
            connection.onRequest(RegistrationRequest.type, (params: RegistrationParams) => {
                for (const registration of params.registrations) {
                    if (registration.method !== DidChangeWatchedFilesNotification.method) {
                        continue;
                    }
                    this.watcherRegistrations.set(
                        registration.id,
                        ((registration.registerOptions as any)?.watchers ??
                            []) as FileSystemWatcher[]
                    );
                }
                this.rebuildRegisteredWatchers();
                return null;
            });
            connection.onRequest(UnregistrationRequest.type, (params: UnregistrationParams) => {
                for (const unregistration of params.unregisterations) {
                    if (unregistration.method === DidChangeWatchedFilesNotification.method) {
                        this.watcherRegistrations.delete(unregistration.id);
                    }
                }
                this.rebuildRegisteredWatchers();
                return null;
            });
            connection.onRequest(WorkDoneProgressCreateRequest.type, () => null);
            connection.listen();

            // Every folder of a multi-root workspace: tsgo assigns configured projects only to
            // files under its declared folders.
            const workspaceFolders = [
                this.options.workspacePath,
                ...(this.options.workspacePaths ?? [])
            ].filter((folder, index, all) => all.indexOf(folder) === index);

            const initializationTimeoutMs =
                this.options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
            let initializationTimer: ReturnType<typeof setTimeout> | undefined;
            const initializationTimeout = new Promise<never>((_, reject) => {
                initializationTimer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                `tsgo initialize request timed out after ${initializationTimeoutMs}ms`
                            )
                        ),
                    initializationTimeoutMs
                );
                initializationTimer.unref();
            });
            let initResult: unknown;
            try {
                initResult = await Promise.race([
                    connection.sendRequest(InitializeRequest.type, {
                        processId: process.pid,
                        rootUri: pathToUrl(this.options.workspacePath),
                        workspaceFolders: workspaceFolders.map((folder, index) => ({
                            uri: pathToUrl(folder),
                            name: index === 0 ? 'svelte-language-server' : `workspace-${index}`
                        })),
                        capabilities: {
                            // LSP/Document offsets are JavaScript UTF-16 code units throughout this server.
                            // Advertising UTF-8 lets tsgo select it and shifts every position after a
                            // non-ASCII character, including the ranged edits used for didChange.
                            general: { positionEncodings: ['utf-16'] },
                            workspace: {
                                configuration: true,
                                workspaceFolders: true,
                                didChangeWatchedFiles: {
                                    dynamicRegistration: true,
                                    relativePatternSupport: true
                                }
                            },
                            window: { workDoneProgress: true },
                            textDocument: {
                                synchronization: { dynamicRegistration: true, didSave: true },
                                diagnostic: { dynamicRegistration: true },
                                // Native diagnostics conditionally include their secondary source
                                // locations. Without this capability, the checker CLI retains notes
                                // such as "declared here" while editor pull diagnostics silently
                                // drop them, even though the outer VS Code client supports them.
                                publishDiagnostics: {
                                    relatedInformation: true
                                },
                                hover: { contentFormat: ['markdown', 'plaintext'] },
                                completion: {
                                    completionItem: {
                                        snippetSupport: true,
                                        documentationFormat: ['markdown', 'plaintext'],
                                        labelDetailsSupport: true,
                                        resolveSupport: {
                                            properties: [
                                                'documentation',
                                                'detail',
                                                'additionalTextEdits'
                                            ]
                                        }
                                    }
                                },
                                definition: { linkSupport: true },
                                typeDefinition: { linkSupport: true },
                                implementation: { linkSupport: true },
                                signatureHelp: {},
                                references: {},
                                documentHighlight: {},
                                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                                foldingRange: {},
                                selectionRange: {},
                                callHierarchy: {},
                                rename: { prepareSupport: true },
                                codeAction: {
                                    codeActionLiteralSupport: {
                                        codeActionKind: {
                                            valueSet: [
                                                'quickfix',
                                                'source.organizeImports',
                                                'source.fixAll'
                                            ]
                                        }
                                    },
                                    resolveSupport: { properties: ['edit'] }
                                },
                                inlayHint: { resolveSupport: { properties: ['tooltip'] } },
                                semanticTokens: {
                                    requests: { full: true, range: true },
                                    // tsgo encodes tokens against the *client's* legend, so this must be
                                    // the same legend we advertise to the editor. Sending an empty list
                                    // makes every token untypeable and the whole response is discarded.
                                    tokenTypes: getSemanticTokenLegends().tokenTypes,
                                    tokenModifiers: getSemanticTokenLegends().tokenModifiers,
                                    formats: ['relative']
                                }
                            }
                        },
                        initializationOptions: {}
                    } as any),
                    spawnFailure,
                    initializationTimeout
                ]);
            } finally {
                if (initializationTimer) {
                    clearTimeout(initializationTimer);
                }
            }

            if (
                !initResult ||
                typeof initResult !== 'object' ||
                Array.isArray(initResult) ||
                !(initResult as any).capabilities ||
                typeof (initResult as any).capabilities !== 'object' ||
                Array.isArray((initResult as any).capabilities)
            ) {
                throw new Error('tsgo returned a malformed initialize result');
            }
            const capabilities = (initResult as any).capabilities;
            const positionEncoding = capabilities.positionEncoding;
            if (positionEncoding !== undefined && typeof positionEncoding !== 'string') {
                throw new Error('tsgo returned a non-string position encoding');
            }
            if (positionEncoding !== undefined && positionEncoding.toLowerCase() !== 'utf-16') {
                throw new Error(
                    `tsgo selected unsupported position encoding ${positionEncoding}; expected utf-16`
                );
            }

            const legend = capabilities.semanticTokensProvider?.legend;
            if (legend) {
                this.tokenLegend = {
                    tokenTypes: legend.tokenTypes ?? [],
                    tokenModifiers: legend.tokenModifiers ?? []
                };
            }

            connection.sendNotification(InitializedNotification.type, {});

            // Re-open what the previous child had, so a crash costs a restart and not the session.
            const replay = this.desiredDocuments;
            if (replay.size) {
                Logger.log(`[tsgo] replaying ${replay.size} open document(s) after restart`);
                for (const [uri, state] of replay) {
                    const { languageId, text } = state;
                    this.openDocuments.set(uri, state);
                    this.versions.set(uri, 1);
                    connection.sendNotification(DidOpenTextDocumentNotification.type, {
                        textDocument: { uri, languageId, version: 1, text }
                    });
                }
                this.generationCounter++;
            }
        } catch (error) {
            const startupError =
                error instanceof Error ? error : new Error(`tsgo initialization failed: ${error}`);
            this.handleProcessFailure(proc, `initialization failed: ${startupError.message}`);
            // handleProcessFailure owns the current references, but clean these exact resources
            // as well so a superseded attempt can never tear down or leak a newer connection.
            try {
                connection.dispose();
            } catch {}
            try {
                terminateChildProcess(proc);
            } catch {}
            throw startupError;
        }
    }

    private handleProcessFailure(proc: ChildProcess, message: string) {
        if (this.disposed || this.failedProcesses.has(proc)) {
            return;
        }
        this.failedProcesses.add(proc);
        // A late exit from a superseded attempt must not dispose the current child's connection.
        if (this.proc !== proc) {
            return;
        }
        Logger.error(`[tsgo] ${message}`);
        // The new child starts with no actual overlays. desiredDocuments remains canonical and
        // will be replayed by the next start, including updates which arrived during startup.
        this.openDocuments.clear();
        this.versions.clear();
        this.generationCounter++;
        const dead = this.connection;
        this.connection = undefined;
        this.proc = undefined;
        this.starting = undefined;
        try {
            // vscode-jsonrpc only rejects pending response promises in dispose().
            dead?.dispose();
        } catch {}
        this.options.onRestart?.();
    }

    /** tsgo's semantic-token legend, available once the server has initialized. */
    getTokenLegend() {
        return this.tokenLegend;
    }

    private get conn(): ProtocolConnection {
        if (!this.connection) {
            throw new Error('tsgo connection is not running');
        }
        return this.connection;
    }

    /**
     * Open a shadow document. Shadows must be opened *eagerly* rather than on demand: a shadow
     * only joins module resolution once it has been opened, and when it hasn't, svelte's ambient
     * `declare module '*.svelte'` silently swallows the failure and every import degrades to
     * `any` with no diagnostic at all.
     */
    async openDocument(filePath: string, text: string, languageId = 'typescriptreact') {
        const uri = pathToUrl(filePath);
        const revision = this.recordDesiredDocument(uri, languageId, text);
        await this.start();
        if (this.documentRevisions.get(uri) !== revision) {
            return;
        }
        const current = this.openDocuments.get(uri);
        if (current) {
            if (current.text === text && current.languageId === languageId) {
                this.openDocuments.set(uri, { languageId, text, revision });
                return;
            }
            if (current.languageId !== languageId) {
                this.reopenDocument(uri, { languageId, text, revision });
                return;
            }
            this.changeDocument(uri, { languageId, text, revision }, [{ text }]);
            return;
        }
        this.sendOpenDocument(uri, { languageId, text, revision });
    }

    async updateDocument(
        filePath: string,
        changes: TextDocumentContentChangeEvent[],
        text: string,
        languageId?: string
    ) {
        const uri = pathToUrl(filePath);
        const resolvedLanguageId =
            languageId ??
            this.desiredDocuments.get(uri)?.languageId ??
            this.openDocuments.get(uri)?.languageId ??
            'typescriptreact';
        const revision = this.recordDesiredDocument(uri, resolvedLanguageId, text);
        await this.start();
        if (this.documentRevisions.get(uri) !== revision) {
            return;
        }
        const current = this.openDocuments.get(uri);
        if (!current) {
            this.sendOpenDocument(uri, {
                languageId: resolvedLanguageId,
                text,
                revision
            });
            return;
        }
        if (current.text === text) {
            // Retain the newest revision and real language id even when content is unchanged.
            // A language-id change requires close/open because didChange cannot carry one.
            if (current.languageId !== resolvedLanguageId) {
                this.reopenDocument(uri, {
                    languageId: resolvedLanguageId,
                    text,
                    revision
                });
            } else {
                this.openDocuments.set(uri, {
                    languageId: resolvedLanguageId,
                    text,
                    revision
                });
            }
            return;
        }
        if (current.languageId !== resolvedLanguageId) {
            this.reopenDocument(uri, { languageId: resolvedLanguageId, text, revision });
            return;
        }
        // If an older update was superseded while start() was pending, this incremental range is
        // based on text the child never saw. A full replacement is the only safe coalesced edit.
        const contentChanges =
            current.revision + 1 === revision && changes.length ? changes : [{ text }];
        this.changeDocument(
            uri,
            { languageId: resolvedLanguageId, text, revision },
            contentChanges
        );
    }

    async closeDocument(filePath: string) {
        const uri = pathToUrl(filePath);
        const revision = (this.documentRevisions.get(uri) ?? 0) + 1;
        this.documentRevisions.set(uri, revision);
        const wasDesired = this.desiredDocuments.delete(uri);
        if (!this.openDocuments.delete(uri)) {
            if (wasDesired) {
                this.generationCounter++;
            }
            return;
        }
        this.versions.delete(uri);
        this.generationCounter++;
        this.connection?.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri }
        });
    }

    isOpen(filePath: string) {
        return this.desiredDocuments.has(pathToUrl(filePath));
    }

    private recordDesiredDocument(uri: string, languageId: string, text: string): number {
        const revision = (this.documentRevisions.get(uri) ?? 0) + 1;
        const state = { languageId, text, revision };
        this.documentRevisions.set(uri, revision);
        this.desiredDocuments.set(uri, state);
        return revision;
    }

    private sendOpenDocument(uri: string, state: OpenDocumentState) {
        this.openDocuments.set(uri, state);
        this.versions.set(uri, 1);
        this.generationCounter++;
        this.conn.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: {
                uri,
                languageId: state.languageId,
                version: 1,
                text: state.text
            }
        });
    }

    private reopenDocument(uri: string, state: OpenDocumentState) {
        this.conn.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri }
        });
        this.sendOpenDocument(uri, state);
    }

    private changeDocument(
        uri: string,
        next: OpenDocumentState,
        changes: TextDocumentContentChangeEvent[]
    ) {
        this.openDocuments.set(uri, next);
        const version = (this.versions.get(uri) ?? 1) + 1;
        this.versions.set(uri, version);
        this.generationCounter++;
        this.conn.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version },
            contentChanges: changes
        });
    }

    /** Forward outer workspace file events into tsgo's dynamically registered watcher. */
    async notifyWatchedFiles(changes: FileEvent[]) {
        const matching = changes.filter((change) => this.matchesRegisteredWatcher(change));
        if (!matching.length) {
            return;
        }
        await this.start();
        this.generationCounter++;
        this.conn.sendNotification(DidChangeWatchedFilesNotification.type, {
            changes: matching
        });
    }

    private matchesRegisteredWatcher(change: FileEvent): boolean {
        const filePath = urlToPath(change.uri);
        if (!filePath) {
            return false;
        }
        const normalized = normalizePath(filePath);
        const kind = change.type === 1 ? 1 : change.type === 2 ? 2 : 4;
        return this.registeredWatchers.some(({ watcher, regex, basePath }) => {
            if (((watcher.kind ?? 7) & kind) === 0) {
                return false;
            }
            if (basePath) {
                const relative = normalizePath(relativePath(basePath, normalized));
                return !relative.startsWith('../') && regex.test(relative);
            }
            const candidates = [normalized];
            for (const workspacePath of [
                this.options.workspacePath,
                ...(this.options.workspacePaths ?? [])
            ]) {
                const relative = normalizePath(relativePath(workspacePath, normalized));
                if (!relative.startsWith('../')) {
                    candidates.push(relative);
                }
            }
            return candidates.some((candidate) => regex.test(candidate));
        });
    }

    /** Tell tsgo to request the latest VS Code-shaped configuration from us. */
    async updateConfiguration() {
        const connection = this.connection;
        if (!connection || this.configurationUpdateQueued) {
            return;
        }
        this.configurationUpdateQueued = true;
        queueMicrotask(() => {
            this.configurationUpdateQueued = false;
            if (this.connection === connection) {
                connection.sendNotification(DidChangeConfigurationNotification.type, {
                    settings: {}
                });
            }
        });
    }

    /**
     * Passing the token through is what turns an editor's cancel into a `$/cancelRequest` at
     * tsgo. Without it, every superseded completion and diagnostic run kept computing inside
     * tsgo and the request the user was actually waiting on queued behind the corpses.
     */
    async sendRequest<R>(method: string, params: unknown, token?: CancellationToken): Promise<R> {
        // A settings/project restart must not dispose a connection underneath an outstanding
        // JSON-RPC request: vscode-jsonrpc can leave that promise pending forever. Requests which
        // arrive after the restart is scheduled wait for the replacement child instead.
        while (this.restartWork) {
            await this.restartWork;
        }
        this.activeRequests++;
        try {
            await this.start();
            // The token must be *omitted*, not passed as undefined: the string overload of
            // `sendRequest` treats trailing arguments as positional params unless the last one is
            // a real token, so `(params, undefined)` goes over the wire as the array
            // `[params, null]` and tsgo rejects it ("expected object start, but encountered [").
            return await (token
                ? this.conn.sendRequest<R>(method, params, token)
                : this.conn.sendRequest<R>(method, params));
        } finally {
            this.activeRequests--;
            if (this.activeRequests === 0) {
                for (const resolve of this.requestIdleWaiters) {
                    resolve();
                }
                this.requestIdleWaiters.clear();
            }
        }
    }

    dispose() {
        this.disposed = true;
        try {
            this.connection?.dispose();
        } catch {}
        try {
            if (this.proc) terminateChildProcess(this.proc);
        } catch {}
        this.connection = undefined;
        this.proc = undefined;
        this.openDocuments.clear();
        this.versions.clear();
        this.desiredDocuments.clear();
        this.documentRevisions.clear();
    }
}

/** A catchable SIGTERM must never leave a superseded native child retaining its stdio pipes. */
function terminateChildProcess(proc: ChildProcess): void {
    const hasExited = () =>
        typeof proc.exitCode === 'number' || typeof proc.signalCode === 'string';
    if (hasExited()) {
        return;
    }
    try {
        proc.kill('SIGTERM');
    } catch {
        // The exit event or hard-kill fallback remains authoritative.
    }
    const forceKill = setTimeout(() => {
        if (!hasExited()) {
            try {
                proc.kill('SIGKILL');
            } catch {}
        }
        proc.stdin?.destroy?.();
        proc.stdout?.destroy?.();
        proc.stderr?.destroy?.();
        proc.unref?.();
    }, 1_000);
    forceKill.unref();
    proc.once('exit', () => clearTimeout(forceKill));
}
