import { ChildProcess, spawn } from 'child_process';
import {
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
    return {
        preferences: {
            // 'js' would leak the shadow's own extension into inserted imports
            // (`./Button.svelte.tsx`); 'index' keeps them as `./Button.svelte`.
            importModuleSpecifierEnding: 'index',
            includePackageJsonAutoImports: 'auto',
            allowIncompleteCompletions: true
        },
        suggest: {
            autoImports: true,
            completeFunctionCalls: false
        },
        inlayHints: {}
    };
}

export interface TsGoServerOptions {
    /** Absolute path to the tsgo executable. */
    tsgoPath: string;
    /** Directory the server is rooted at — normally the tsconfig's directory. */
    workspacePath: string;
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

    constructor(private readonly options: TsGoServerOptions) {}

    async start(): Promise<void> {
        if (this.disposed) {
            throw new Error('TsGoServer has been disposed');
        }
        this.starting ??= this.doStart();
        return this.starting;
    }

    private async doStart(): Promise<void> {
        // `--lsp -stdio` is deliberate: `--stdio` and `lsp -stdio` both exit 1.
        const proc = spawn(this.options.tsgoPath, ['--lsp', '-stdio'], {
            cwd: this.options.workspacePath,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.proc = proc;

        proc.stderr?.on('data', (d) => Logger.debug(`[tsgo] ${d.toString().trimEnd()}`));
        proc.on('exit', (code, signal) => {
            if (this.disposed) {
                return;
            }
            Logger.error(`[tsgo] exited unexpectedly (code=${code} signal=${signal})`);
            this.connection = undefined;
            this.proc = undefined;
            this.starting = undefined;
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

        const initResult = await connection.sendRequest(InitializeRequest.type, {
            processId: process.pid,
            rootUri: pathToUrl(this.options.workspacePath),
            workspaceFolders: [
                { uri: pathToUrl(this.options.workspacePath), name: 'svelte-language-server' }
            ],
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
        this.openDocuments.set(uri, { languageId, text });
        this.versions.set(uri, 1);
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
        this.conn.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version },
            contentChanges: changes
        });
    }

    async closeDocument(filePath: string) {
        const uri = pathToUrl(filePath);
        if (!this.openDocuments.delete(uri)) {
            return;
        }
        this.versions.delete(uri);
        this.connection?.sendNotification(DidCloseTextDocumentNotification.type, {
            textDocument: { uri }
        });
    }

    isOpen(filePath: string) {
        return this.openDocuments.has(pathToUrl(filePath));
    }

    async sendRequest<R>(method: string, params: unknown): Promise<R> {
        await this.start();
        return this.conn.sendRequest<R>(method, params);
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
    }
}
