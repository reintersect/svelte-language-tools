import { ChildProcess, spawn } from 'child_process';
import {
    CancellationToken,
    createProtocolConnection,
    ProtocolConnection,
    StreamMessageReader,
    StreamMessageWriter
} from 'vscode-languageserver/node';
import {
    ConfigurationRequest,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    DidOpenTextDocumentNotification,
    InitializeRequest,
    InitializedNotification,
    RegistrationRequest,
    TextDocumentContentChangeEvent,
    WorkDoneProgressCreateRequest
} from 'vscode-languageserver-protocol';
import { getSemanticTokenLegends } from '../../../lib/semanticToken/semanticTokenLegend';
import { pathToUrl } from '../../../utils';
import { Logger } from '../../../logger';

/**
 * Preferences handed to tsgo. These arrive through a `workspace/configuration` *response*,
 * not `initializationOptions`, and only in VS Code's nested shape — raw TypeScript preference
 * names are ignored. Answering with an empty object wipes the settings entirely, so this must
 * never be `{}`.
 */
function tsGoConfiguration() {
    // Only keys with a `config:` path in tsgo's settings unmarshalling are listed — verified
    // against the binary; `allowIncompleteCompletions`, `includePackageJsonAutoImports` and
    // `suggest.completeFunctionCalls` have none and were silently ignored.
    return {
        preferences: {
            // 'js' would leak the shadow's own extension into inserted imports
            // (`./Button.svelte.tsx`); 'index' keeps them as `./Button.svelte`.
            importModuleSpecifierEnding: 'index'
        },
        suggest: {
            autoImports: true
        },
        inlayHints: {}
    };
}

export interface TsGoServerOptions {
    /** Absolute path to the tsgo executable. */
    tsgoPath: string;
    /** Directory the server is rooted at — normally the workspace source root. */
    workspacePath: string;
    /**
     * Additional workspace folders (a multi-root editor workspace). tsgo assigns projects only
     * to files under its workspace folders, so a folder it never hears about gets shadows but
     * no checking.
     */
    workspacePaths?: string[];
    /** Called when the child dies unexpectedly, so documents can be replayed into a new one. */
    onRestart?: () => void;
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
    /** Documents we've opened, so they can be replayed if the child crashes. */
    private readonly openDocuments = new Map<string, { languageId: string; text: string }>();
    private versions = new Map<string, number>();
    /** Documents the previous child had open, waiting to be replayed into the next one. */
    private pendingReplay: Map<string, { languageId: string; text: string }> | undefined;
    /**
     * Monotonic counter of everything that can change what tsgo knows: opens, real content
     * changes, closes, watched-file rewrites, restarts. Consumers cache against it — the
     * checker API session skips its `updateSnapshot` round trip while this hasn't moved.
     */
    private generationCounter = 0;

    constructor(private readonly options: TsGoServerOptions) {}

    get generation(): number {
        return this.generationCounter;
    }

    /** Record a change tsgo observed outside the didOpen/didChange flow (watched files). */
    noteExternalChange() {
        this.generationCounter++;
    }

    /** The version last sent for a document, if it is open. */
    documentVersion(filePath: string): number | undefined {
        return this.versions.get(pathToUrl(filePath));
    }

    /** The text last sent for a document, if it is open — the diff base for ranged changes. */
    getOpenText(filePath: string): string | undefined {
        return this.openDocuments.get(pathToUrl(filePath))?.text;
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

    private async doStart(): Promise<void> {
        // `--lsp -stdio` is deliberate: `--stdio` and `lsp -stdio` both exit 1.
        const proc = spawn(this.options.tsgoPath, ['--lsp', '-stdio'], {
            cwd: this.options.workspacePath,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.proc = proc;

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
        proc.on('exit', (code, signal) => {
            if (this.disposed) {
                return;
            }
            Logger.error(`[tsgo] exited unexpectedly (code=${code} signal=${signal})`);
            // The new child starts with no documents: queue the old overlay set for replay and
            // clear the bookkeeping, or `updateDocument` keeps "updating" documents the child
            // has never seen — the early-return on identical text then replays nothing at all.
            // Merged, not replaced: a second crash before the replay ran must not wipe the
            // queue with the (empty) live map.
            this.pendingReplay = new Map([...(this.pendingReplay ?? []), ...this.openDocuments]);
            this.openDocuments.clear();
            this.versions.clear();
            this.generationCounter++;
            const dead = this.connection;
            this.connection = undefined;
            this.proc = undefined;
            this.starting = undefined;
            try {
                // vscode-jsonrpc only rejects pending response promises in dispose() — a
                // stream that merely closes leaves every in-flight request hanging forever,
                // which surfaces as a permanently stuck editor request.
                dead?.dispose();
            } catch {}
            this.options.onRestart?.();
        });

        const connection = createProtocolConnection(
            new StreamMessageReader(proc.stdout!),
            new StreamMessageWriter(proc.stdin!)
        );
        this.connection = connection;

        // tsgo asks the client for settings; see tsGoConfiguration().
        connection.onRequest(ConfigurationRequest.type, (params) =>
            (params.items ?? []).map(() => tsGoConfiguration())
        );
        // Accept dynamic registrations and progress creation rather than erroring on them.
        connection.onRequest(RegistrationRequest.type, () => null);
        connection.onRequest(WorkDoneProgressCreateRequest.type, () => null);
        connection.listen();

        // Every folder of a multi-root workspace: tsgo assigns configured projects only to
        // files under its declared folders.
        const workspaceFolders = [
            this.options.workspacePath,
            ...(this.options.workspacePaths ?? [])
        ].filter((folder, index, all) => all.indexOf(folder) === index);

        const initResult = await connection.sendRequest(InitializeRequest.type, {
            processId: process.pid,
            rootUri: pathToUrl(this.options.workspacePath),
            workspaceFolders: workspaceFolders.map((folder, index) => ({
                uri: pathToUrl(folder),
                name: index === 0 ? 'svelte-language-server' : `workspace-${index}`
            })),
            capabilities: {
                // utf-8 makes tsgo's offsets line up with ours; we convert only at the
                // editor boundary.
                general: { positionEncodings: ['utf-8', 'utf-16'] },
                workspace: {
                    configuration: true,
                    didChangeWatchedFiles: { dynamicRegistration: true }
                },
                textDocument: {
                    synchronization: { dynamicRegistration: true },
                    diagnostic: { dynamicRegistration: true },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    completion: {
                        completionItem: {
                            snippetSupport: true,
                            documentationFormat: ['markdown', 'plaintext'],
                            labelDetailsSupport: true,
                            resolveSupport: {
                                properties: ['documentation', 'detail', 'additionalTextEdits']
                            }
                        }
                    },
                    definition: { linkSupport: true },
                    typeDefinition: { linkSupport: true },
                    implementation: { linkSupport: true },
                    signatureHelp: {},
                    references: {},
                    documentHighlight: {},
                    rename: { prepareSupport: true },
                    codeAction: {
                        codeActionLiteralSupport: {
                            codeActionKind: {
                                valueSet: ['quickfix', 'source.organizeImports', 'source.fixAll']
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
        } as any);

        const legend = (initResult as any)?.capabilities?.semanticTokensProvider?.legend;
        if (legend) {
            this.tokenLegend = {
                tokenTypes: legend.tokenTypes ?? [],
                tokenModifiers: legend.tokenModifiers ?? []
            };
        }

        connection.sendNotification(InitializedNotification.type, {});

        // Re-open what the previous child had, so a crash costs a restart and not the session.
        const replay = this.pendingReplay;
        this.pendingReplay = undefined;
        if (replay?.size) {
            Logger.log(`[tsgo] replaying ${replay.size} open document(s) after restart`);
            for (const [uri, { languageId, text }] of replay) {
                this.openDocuments.set(uri, { languageId, text });
                this.versions.set(uri, 1);
                connection.sendNotification(DidOpenTextDocumentNotification.type, {
                    textDocument: { uri, languageId, version: 1, text }
                });
            }
            this.generationCounter++;
        }
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
        await this.start();
        const uri = pathToUrl(filePath);
        // A fresh open supersedes anything queued for replay from before a crash.
        this.pendingReplay?.delete(uri);
        this.openDocuments.set(uri, { languageId, text });
        this.versions.set(uri, 1);
        this.generationCounter++;
        this.conn.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId, version: 1, text }
        });
    }

    async updateDocument(
        filePath: string,
        changes: TextDocumentContentChangeEvent[],
        text: string
    ) {
        await this.start();
        const uri = pathToUrl(filePath);
        const current = this.openDocuments.get(uri);
        if (!current) {
            return this.openDocument(filePath, text);
        }
        if (current.text === text) {
            // Nothing changed. A didChange here would still make tsgo re-parse and re-check the
            // file, which is most of the cost of a request — and one editor interaction fans out
            // into many requests against identical content.
            return;
        }
        this.openDocuments.set(uri, { languageId: 'typescriptreact', text });
        const version = (this.versions.get(uri) ?? 1) + 1;
        this.versions.set(uri, version);
        this.generationCounter++;
        this.conn.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version },
            contentChanges: changes
        });
    }

    async closeDocument(filePath: string) {
        const uri = pathToUrl(filePath);
        // Also drop it from a queued replay: a document closed (or deleted) between a crash
        // and the next start must not be resurrected as an overlay in the new child.
        this.pendingReplay?.delete(uri);
        if (!this.openDocuments.delete(uri)) {
            return;
        }
        this.versions.delete(uri);
        this.generationCounter++;
        this.connection?.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri }
        });
    }

    isOpen(filePath: string) {
        return this.openDocuments.has(pathToUrl(filePath));
    }

    /**
     * Passing the token through is what turns an editor's cancel into a `$/cancelRequest` at
     * tsgo. Without it, every superseded completion and diagnostic run kept computing inside
     * tsgo and the request the user was actually waiting on queued behind the corpses.
     */
    async sendRequest<R>(method: string, params: unknown, token?: CancellationToken): Promise<R> {
        await this.start();
        // The token must be *omitted*, not passed as undefined: the string overload of
        // `sendRequest` treats trailing arguments as positional params unless the last one is
        // a real token, so `(params, undefined)` goes over the wire as the array
        // `[params, null]` and tsgo rejects it ("expected object start, but encountered [").
        return token
            ? this.conn.sendRequest<R>(method, params, token)
            : this.conn.sendRequest<R>(method, params);
    }

    dispose() {
        this.disposed = true;
        try {
            this.connection?.dispose();
        } catch {}
        try {
            this.proc?.kill();
        } catch {}
        this.connection = undefined;
        this.proc = undefined;
        this.openDocuments.clear();
        this.versions.clear();
        this.pendingReplay = undefined;
    }
}
