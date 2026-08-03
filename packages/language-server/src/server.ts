import {
    ApplyWorkspaceEditParams,
    ApplyWorkspaceEditRequest,
    CodeActionKind,
    DocumentUri,
    Connection,
    MessageType,
    RenameFile,
    RequestType,
    ShowMessageNotification,
    TextDocumentIdentifier,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    WorkspaceEdit,
    SemanticTokensRequest,
    SemanticTokensRangeRequest,
    DidChangeWatchedFilesParams,
    LinkedEditingRangeRequest,
    CallHierarchyPrepareRequest,
    CallHierarchyIncomingCallsRequest,
    CallHierarchyOutgoingCallsRequest,
    InlayHintRequest,
    SemanticTokensRefreshRequest,
    InlayHintRefreshRequest,
    DidChangeWatchedFilesNotification,
    RelativePattern,
    DocumentDiagnosticRequest,
    DocumentDiagnosticParams,
    DocumentDiagnosticReport,
    DiagnosticRefreshRequest,
    FileSystemWatcher,
    TextDocumentContentChangeEvent,
    DidOpenTextDocumentNotification,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    BulkRegistration,
    DocumentSelector
} from 'vscode-languageserver';
import { IPCMessageReader, IPCMessageWriter, createConnection } from 'vscode-languageserver/node';
import {
    DiagnosticsManager,
    PullDiagnosticsManager,
    PushDiagnosticsManager
} from './lib/DiagnosticsManager';
import { Document, DocumentManager } from './lib/documents';
import { getSemanticTokenLegends } from './lib/semanticToken/semanticTokenLegend';
import { Logger } from './logger';
import { LSConfigManager } from './ls-config';
import {
    AppCompletionItem,
    CSSPlugin,
    HTMLPlugin,
    PluginHost,
    SveltePlugin,
    TypeScriptPlugin,
    OnWatchFileChangesPara,
    LSAndTSDocResolver
} from './plugins';
import {
    createTsGoBackedPlugin,
    createTsGoPlugin,
    isRsvelteEnabled,
    isTsGoEnabled,
    preloadRsvelte
} from './plugins/typescript-go/lsp';
import { debounceThrottle, isNotNullOrUndefined, normalizeUri, urlToPath } from './utils';
import { FallbackWatcher } from './lib/FallbackWatcher';
import { configLoader } from './lib/documents/configLoader';
import { getLineOffsets, offsetAt } from './lib/documents/utils';
import { setIsTrusted } from './importPackage';
import {
    SORT_IMPORT_CODE_ACTION_KIND,
    ADD_MISSING_IMPORTS_CODE_ACTION_KIND,
    REMOVE_UNUSED_IMPORTS_CODE_ACTION_KIND
} from './plugins/typescript/features/CodeActionsProvider';
import { createLanguageServices } from './plugins/css/service';
import { FileSystemProvider } from './lib/FileSystemProvider';

namespace TagCloseRequest {
    export const type: RequestType<TextDocumentPositionParams, string | null, any> =
        new RequestType('html/tag');
}

const tsOrJsLanguageIds = new Set([
    'typescript',
    'typescriptreact',
    'javascript',
    'javascriptreact'
]);

function isTsOrJsLanguageId(languageId: string): boolean {
    return tsOrJsLanguageIds.has(languageId);
}

function applyTextDocumentChanges(text: string, changes: TextDocumentContentChangeEvent[]): string {
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

const tsOrJsDocumentSelector: DocumentSelector = Array.from(tsOrJsLanguageIds, (language) => ({
    scheme: 'file',
    language
}));

/** Dynamically extend text synchronization without claiming TS/JS language features. */
export function registerTsOrJsTextSynchronization(connection: Connection): Promise<unknown> {
    const registrations = BulkRegistration.create();
    registrations.add(DidOpenTextDocumentNotification.type, {
        documentSelector: tsOrJsDocumentSelector
    });
    registrations.add(DidChangeTextDocumentNotification.type, {
        documentSelector: tsOrJsDocumentSelector,
        syncKind: TextDocumentSyncKind.Incremental
    });
    registrations.add(DidCloseTextDocumentNotification.type, {
        documentSelector: tsOrJsDocumentSelector
    });
    return connection.client.register(registrations);
}

export interface LSOptions {
    /**
     * If you have a connection already that the ls should use, pass it in.
     * Else the connection will be created from `process`.
     */
    connection?: Connection;
    /**
     * If you want only errors getting logged.
     * Defaults to false.
     */
    logErrorsOnly?: boolean;
}

/**
 * Starts the language server.
 *
 * @param options Options to customize behavior
 */
export function startServer(options?: LSOptions) {
    let connection = options?.connection;
    if (!connection) {
        if (process.argv.includes('--stdio')) {
            console.log = (...args: any[]) => {
                console.warn(...args);
            };
            connection = createConnection(process.stdin, process.stdout);
        } else {
            connection = createConnection(
                new IPCMessageReader(process),
                new IPCMessageWriter(process)
            );
        }
    }

    if (options?.logErrorsOnly !== undefined) {
        Logger.setLogErrorsOnly(options.logErrorsOnly);
    }

    const docManager = new DocumentManager(
        (textDocument) => new Document(textDocument.uri, textDocument.text)
    );
    const configManager = new LSConfigManager();
    const pluginHost = new PluginHost(docManager);
    let sveltePlugin: SveltePlugin = undefined as any;
    let watcher: FallbackWatcher | undefined;
    let dynamicTsOrJsTextSync = false;
    let tsGoActive = false;
    let tsGoPlugin: ReturnType<typeof createTsGoPlugin>;
    let pendingWatchPatterns: RelativePattern[] = [];
    const openTsOrJsDocuments = new Map<
        string,
        {
            fileName: string;
            languageId: string;
            version?: number;
            text?: string;
            open: boolean;
        }
    >();
    let watchDirectory: (patterns: RelativePattern[]) => void = (patterns) => {
        pendingWatchPatterns = patterns;
    };

    // Include Svelte files to better deal with scenarios such as switching git branches
    // where files that are not opened in the client could change
    const watchExtensions = [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.mts',
        '.mjs',
        '.cjs',
        '.cts',
        '.json',
        '.svelte'
    ];
    const nonRecursiveWatchPattern =
        '*.{' + watchExtensions.map((ext) => ext.slice(1)).join(',') + '}';
    const recursiveWatchPattern = '**/' + nonRecursiveWatchPattern;

    function openTsOrJsFile(
        uri: string,
        fileName: string,
        text: string,
        languageId: string,
        version?: number
    ) {
        const key = normalizeUri(uri);
        const current = openTsOrJsDocuments.get(key);
        if (
            current?.open &&
            ((version !== undefined &&
                current.version !== undefined &&
                version <= current.version) ||
                (current.text === text && current.languageId === languageId))
        ) {
            return;
        }
        openTsOrJsDocuments.set(key, {
            fileName,
            languageId,
            version,
            text,
            open: true
        });
        pluginHost.openTsOrJsFile(fileName, text, languageId, version);
    }

    function updateTsOrJsFile(
        uri: string,
        fileName: string,
        changes: TextDocumentContentChangeEvent[],
        text?: string,
        version?: number,
        languageId?: string
    ) {
        const key = normalizeUri(uri);
        const current = openTsOrJsDocuments.get(key);
        // Mixed/custom clients may send standard and compatibility notifications for the same
        // version. Only the first may mutate tsgo; lower versions are stale messages in flight.
        if (version !== undefined && current?.version !== undefined && version <= current.version) {
            return;
        }
        const nextText =
            text ??
            (current?.text !== undefined
                ? applyTextDocumentChanges(current.text, changes)
                : undefined);
        if (nextText !== undefined) {
            openTsOrJsDocuments.set(key, {
                fileName,
                languageId: languageId ?? current?.languageId ?? 'typescript',
                version,
                text: nextText,
                open: true
            });
        }
        pluginHost.updateTsOrJsFile(
            fileName,
            changes,
            nextText,
            version,
            languageId ?? current?.languageId
        );
    }

    function closeTsOrJsFile(uri: string, fileName?: string) {
        const key = normalizeUri(uri);
        const current = openTsOrJsDocuments.get(key);
        if (current && !current.open) {
            return;
        }
        const resolvedFileName = current?.fileName ?? fileName;
        if (!resolvedFileName) {
            return;
        }
        openTsOrJsDocuments.set(key, {
            fileName: resolvedFileName,
            languageId: current?.languageId ?? 'typescript',
            version: current?.version,
            // Tombstones exist only to deduplicate standard + compatibility closes. Retaining
            // whole source buffers here would keep hundreds of closed TS/JS files alive.
            text: undefined,
            open: false
        });
        pluginHost.closeTsOrJsFile(resolvedFileName);
        // Bound closed-document metadata while retaining enough recent entries to deduplicate
        // the standard + compatibility close pair.
        if (openTsOrJsDocuments.size > 1_000) {
            for (const [closedUri, state] of openTsOrJsDocuments) {
                if (!state.open && closedUri !== key) {
                    openTsOrJsDocuments.delete(closedUri);
                    if (openTsOrJsDocuments.size <= 750) {
                        break;
                    }
                }
            }
        }
    }

    connection.onInitialize(async (evt) => {
        const tsGoEnabled = isTsGoEnabled(evt.initializationOptions);
        const isTrusted: boolean = evt.initializationOptions?.isTrusted ?? true;
        // The Rust transform is ESM-only and can only be loaded asynchronously, while the
        // transform call sites are synchronous — so it has to be resolved before the plugin
        // exists. Deciding the engine once per session also keeps the shadow fingerprint
        // stable; a mid-session switch would split it between engines.
        if (tsGoEnabled && isTrusted) {
            // Opt-in: `svelte.language-server.rsvelte` setting or SVELTE_LS_RSVELTE=1.
            await preloadRsvelte(isRsvelteEnabled(evt.initializationOptions));
        }
        const workspaceUris = evt.workspaceFolders?.map((folder) => folder.uri.toString()) ?? [
            evt.rootUri ?? ''
        ];
        Logger.log('Initialize language server at ', workspaceUris.join(', '));
        if (workspaceUris.length === 0) {
            Logger.error('No workspace path set');
        }

        if (!evt.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
            const workspacePaths = workspaceUris.map(urlToPath).filter(isNotNullOrUndefined);
            watcher = new FallbackWatcher(watchExtensions, workspacePaths);
            watcher.onDidChangeWatchedFiles(onDidChangeWatchedFiles);
            watcher.onErrorOccurred((error) =>
                Logger.error(
                    `[watch] external file changes will not be observed until restart: ${error.message}`
                )
            );

            watchDirectory = (patterns) => {
                watcher?.watchDirectory(patterns);
            };
        }

        configLoader.setDisabled(!isTrusted);
        setIsTrusted(isTrusted);
        configManager.updateIsTrusted(isTrusted);
        if (!isTrusted) {
            Logger.log('Workspace is not trusted, running with reduced capabilities.');
        }

        Logger.setDebug(
            (evt.initializationOptions?.configuration?.svelte ||
                evt.initializationOptions?.config)?.['language-server']?.debug
        );
        // Backwards-compatible way of setting initialization options (first `||` is the old style)
        configManager.update(
            evt.initializationOptions?.configuration?.svelte?.plugin ||
                evt.initializationOptions?.config ||
                {}
        );
        configManager.updateTsJsUserPreferences(
            evt.initializationOptions?.configuration ||
                evt.initializationOptions?.typescriptConfig ||
                {}
        );
        configManager.updateTsJsFormateConfig(
            evt.initializationOptions?.configuration ||
                evt.initializationOptions?.typescriptConfig ||
                {}
        );
        configManager.updateEmmetConfig(
            evt.initializationOptions?.configuration?.emmet ||
                evt.initializationOptions?.emmetConfig ||
                {}
        );
        configManager.updatePrettierConfig(
            evt.initializationOptions?.configuration?.prettier ||
                evt.initializationOptions?.prettierConfig ||
                {}
        );
        // no old style as these were added later
        configManager.updateCssConfig(evt.initializationOptions?.configuration?.css);
        configManager.updateScssConfig(evt.initializationOptions?.configuration?.scss);
        configManager.updateLessConfig(evt.initializationOptions?.configuration?.less);
        configManager.updateHTMLConfig(evt.initializationOptions?.configuration?.html);
        configManager.updateClientCapabilities(evt.capabilities);

        pluginHost.initialize({
            filterIncompleteCompletions:
                !evt.initializationOptions?.dontFilterIncompleteCompletions,
            definitionLinkSupport: !!evt.capabilities.textDocument?.definition?.linkSupport
        });

        const fileSystemProvider = new FileSystemProvider();
        const workspaceFolders = evt.workspaceFolders ?? [{ name: '', uri: evt.rootUri ?? '' }];
        // Order of plugin registration matters for FirstNonNull, which affects for example hover info
        pluginHost.register((sveltePlugin = new SveltePlugin(configManager)));
        pluginHost.register(
            new HTMLPlugin(docManager, configManager, fileSystemProvider, workspaceFolders)
        );

        const cssLanguageServices = createLanguageServices({
            clientCapabilities: evt.capabilities,
            fileSystemProvider: fileSystemProvider
        });
        pluginHost.register(
            new CSSPlugin(docManager, configManager, workspaceFolders, cssLanguageServices)
        );
        const normalizedWorkspaceUris = workspaceUris.map(normalizeUri);

        // Document transforms synchronously consult configLoader. Preload every trusted root
        // before tsgo materialises its first shadow, otherwise the config-less transform is
        // cached and settings such as defaultScriptLanguage stay wrong for the whole session.
        if (isTrusted && tsGoEnabled) {
            await Promise.all(
                normalizedWorkspaceUris
                    .map((uri) => urlToPath(uri))
                    .filter((path): path is string => !!path)
                    .map((path) => configLoader.loadConfigs(path))
            );
        }

        // Full tsgo: the JavaScript TypeScript engine is absent from normal startup and every
        // feature remains owned by tsgo. A completion-only classic owner is constructed lazily
        // below only when a valid first request arrives before the native project is ready.
        tsGoPlugin = tsGoEnabled
            ? createTsGoPlugin({
                  workspacePath: urlToPath(normalizedWorkspaceUris[0] ?? '') ?? process.cwd(),
                  // Every folder, not just the first: project resolution is bounded by these,
                  // and a multi-root workspace must not lose its other folders' projects.
                  workspacePaths: normalizedWorkspaceUris
                      .map((uri) => urlToPath(uri))
                      .filter((path): path is string => !!path),
                  docManager,
                  configManager,
                  isTrusted,
                  onDidRegisterWatchers: (watchers: FileSystemWatcher[]) => {
                      // The fallback watcher already observes the full supported extension
                      // superset. Dynamic clients can install tsgo's more precise registrations.
                      if (!watcher) {
                          void connection?.client.register(DidChangeWatchedFilesNotification.type, {
                              watchers
                          });
                      }
                  }
              })
            : undefined;

        if (tsGoPlugin) {
            // The classic project service is expensive enough to erase much of tsgo's startup
            // win, but valid completions must never become an empty dropdown while the first
            // native project is materialising. Construct the classic completion owner only if a
            // real cold request cannot use the bounded isolated path. It is not registered with
            // PluginHost, so diagnostics and every other TypeScript feature remain native-only.
            pluginHost.register(
                createTsGoBackedPlugin(
                    { __name: 'tsgo' },
                    tsGoPlugin,
                    createClassicCompletionFallback
                )
            );
        } else {
            pluginHost.register(createTypeScriptPlugin());
        }
        tsGoActive = !!tsGoPlugin;
        dynamicTsOrJsTextSync =
            !!tsGoPlugin && !!evt.capabilities.textDocument?.synchronization?.dynamicRegistration;

        function createTypeScriptResolver(completionOnly = false) {
            return new LSAndTSDocResolver(docManager, normalizedWorkspaceUris, configManager, {
                notifyExceedSizeLimit: notifyTsServiceExceedSizeLimit,
                onProjectReloaded: completionOnly ? undefined : refreshCrossFilesSemanticFeatures,
                watch: !completionOnly,
                nonRecursiveWatchPattern,
                watchDirectory: completionOnly ? undefined : (patterns) => watchDirectory(patterns),
                reportConfigError: completionOnly
                    ? undefined
                    : (diagnostic) => {
                          connection?.sendDiagnostics(diagnostic);
                      }
            });
        }

        function createTypeScriptPlugin(
            completionOnly = false,
            resolver = createTypeScriptResolver(completionOnly)
        ) {
            return new TypeScriptPlugin(
                configManager,
                resolver,
                normalizedWorkspaceUris,
                docManager
            );
        }

        async function createClassicCompletionFallback(document: Document) {
            // This snapshot is deliberately taken before the first await. The composition layer
            // serializes lifecycle messages which arrive after construction starts, preventing an
            // incremental edit from being applied both here and again after the factory resolves.
            const initialDirtyBuffers = [...openTsOrJsDocuments.values()].filter(
                (state) =>
                    state.open && state.text !== undefined && isTsOrJsLanguageId(state.languageId)
            );
            const resolver = createTypeScriptResolver(true);
            const plugin = createTypeScriptPlugin(true, resolver);

            try {
                // updateExistingTsOrJsFile intentionally ignores files before a project service
                // and its snapshot exist. Initialize the exact completion project first, then
                // seed each dirty source snapshot from disk before replacing it with the editor
                // buffer.
                await resolver.getLSAndTSDoc(document);
                for (const state of initialDirtyBuffers) {
                    await resolver.getOrCreateSnapshot(state.fileName);
                    await plugin.updateTsOrJsFile(state.fileName, [{ text: state.text! }]);
                }
            } catch (error) {
                plugin.dispose();
                throw error;
            }
            // Standard TS/JS synchronization is kept outside DocumentManager. Replay the exact
            // dirty buffers that predate lazy construction; subsequent lifecycle calls are
            // mirrored by createTsGoBackedPlugin once construction has started.
            return plugin;
        }

        const clientSupportApplyEditCommand = !!evt.capabilities.workspace?.applyEdit;
        const clientCodeActionCapabilities = evt.capabilities.textDocument?.codeAction;
        const clientSupportedCodeActionKinds =
            clientCodeActionCapabilities?.codeActionLiteralSupport?.codeActionKind.valueSet;

        if (evt.capabilities.textDocument?.diagnostic) {
            const refreshDiagnostics = evt.capabilities.workspace?.diagnostics?.refreshSupport;
            diagnosticsManager = new PullDiagnosticsManager(
                connection.sendDiagnostics,
                refreshDiagnostics
                    ? () => connection.sendRequest(DiagnosticRefreshRequest.method)
                    : () => {}
            );

            connection.onRequest(
                DocumentDiagnosticRequest.type,
                async (
                    evt: DocumentDiagnosticParams,
                    token
                ): Promise<DocumentDiagnosticReport | null> => {
                    if (token.isCancellationRequested) {
                        return null;
                    }
                    const diagnostics = await pluginHost.getDiagnosticsForPullMode(
                        evt.textDocument,
                        evt.previousResultId,
                        token
                    );
                    return diagnostics;
                }
            );
        } else {
            connection.onDidSaveTextDocument(
                diagnosticsManager.scheduleUpdateAll.bind(diagnosticsManager)
            );
        }

        return {
            capabilities: {
                textDocumentSync: {
                    openClose: true,
                    change: TextDocumentSyncKind.Incremental,
                    save: {
                        includeText: false
                    }
                },
                hoverProvider: true,
                completionProvider: {
                    resolveProvider: true,
                    triggerCharacters: [
                        '.',
                        '"',
                        "'",
                        '`',
                        '/',
                        '@',
                        '<',

                        // Emmet
                        '>',
                        '*',
                        '#',
                        '$',
                        '+',
                        '^',
                        '(',
                        '[',
                        '@',
                        '-',
                        // No whitespace because
                        // it makes for weird/too many completions
                        // of other completion providers

                        // Svelte
                        ':',
                        '|'
                    ],
                    completionItem: {
                        labelDetailsSupport: true
                    }
                },
                documentFormattingProvider: true,
                colorProvider: true,
                documentSymbolProvider: true,
                definitionProvider: true,
                codeActionProvider: clientCodeActionCapabilities?.codeActionLiteralSupport
                    ? {
                          codeActionKinds: [
                              CodeActionKind.QuickFix,
                              CodeActionKind.SourceOrganizeImports,
                              SORT_IMPORT_CODE_ACTION_KIND,
                              ADD_MISSING_IMPORTS_CODE_ACTION_KIND,
                              REMOVE_UNUSED_IMPORTS_CODE_ACTION_KIND,
                              ...(clientSupportApplyEditCommand ? [CodeActionKind.Refactor] : [])
                          ].filter(
                              clientSupportedCodeActionKinds &&
                                  evt.initializationOptions?.shouldFilterCodeActionKind
                                  ? (kind) => clientSupportedCodeActionKinds.includes(kind)
                                  : () => true
                          ),
                          resolveProvider: true
                      }
                    : true,
                executeCommandProvider: clientSupportApplyEditCommand
                    ? {
                          commands: [
                              'function_scope_0',
                              'function_scope_1',
                              'function_scope_2',
                              'function_scope_3',
                              'constant_scope_0',
                              'constant_scope_1',
                              'constant_scope_2',
                              'constant_scope_3',
                              'extract_to_svelte_component',
                              'migrate_to_svelte_5',
                              'Infer function return type'
                          ]
                      }
                    : undefined,
                renameProvider: evt.capabilities.textDocument?.rename?.prepareSupport
                    ? { prepareProvider: true }
                    : true,
                referencesProvider: true,
                selectionRangeProvider: true,
                signatureHelpProvider: {
                    triggerCharacters: ['(', ',', '<'],
                    retriggerCharacters: [')']
                },
                semanticTokensProvider: {
                    legend: getSemanticTokenLegends(),
                    range: true,
                    full: true
                },
                linkedEditingRangeProvider: true,
                implementationProvider: true,
                typeDefinitionProvider: true,
                inlayHintProvider: true,
                callHierarchyProvider: true,
                foldingRangeProvider: true,
                codeLensProvider: {
                    resolveProvider: true
                },
                documentHighlightProvider:
                    evt.initializationOptions?.configuration?.svelte?.plugin?.svelte
                        ?.documentHighlight?.enable ?? true,
                workspaceSymbolProvider: true,
                experimental: {
                    // The VS Code extension may synchronize TS-family buffers over standard
                    // textDocument notifications without adding them to its feature selector.
                    tsOrJsTextSync: dynamicTsOrJsTextSync
                },
                diagnosticProvider: {
                    interFileDependencies: true,
                    workspaceDiagnostics: false
                }
            }
        };
    });

    connection.onInitialized(() => {
        if (dynamicTsOrJsTextSync) {
            void registerTsOrJsTextSynchronization(connection!).catch((error) =>
                Logger.error('[tsgo] could not register TS/JS text synchronization', error)
            );
        }

        if (watcher) {
            return;
        }

        const didChangeWatchedFiles =
            configManager.getClientCapabilities()?.workspace?.didChangeWatchedFiles;

        if (!didChangeWatchedFiles?.dynamicRegistration) {
            return;
        }

        // tsgo dynamically registers its own TS/project watchers. Add only the Svelte/config
        // supplement it cannot know about; registering the old broad watcher as well caused VS
        // Code to deliver every TS/config event twice and structural changes restarted two
        // children back-to-back.
        connection?.client.register(DidChangeWatchedFilesNotification.type, {
            watchers: tsGoActive
                ? [
                      { globPattern: '**/*.svelte' },
                      { globPattern: '**/{svelte,vite}.config.{js,cjs,mjs,ts,cts,mts}' }
                  ]
                : [
                      {
                          // Editors have exclude configs, such as VSCode with
                          // `files.watcherExclude`, which makes recursive watching acceptable.
                          globPattern: recursiveWatchPattern
                      }
                  ]
        });

        if (didChangeWatchedFiles.relativePatternSupport) {
            watchDirectory = (patterns) => {
                connection?.client.register(DidChangeWatchedFilesNotification.type, {
                    watchers: patterns.map((pattern) => ({
                        globPattern: pattern
                    }))
                });
            };
            if (pendingWatchPatterns.length) {
                watchDirectory(pendingWatchPatterns);
                pendingWatchPatterns = [];
            }
        }
    });

    function notifyTsServiceExceedSizeLimit() {
        connection?.sendNotification(ShowMessageNotification.type, {
            message:
                'Svelte language server detected a large amount of JS/Svelte files. ' +
                'To enable project-wide JavaScript/TypeScript language features for Svelte files, ' +
                'exclude large folders in the tsconfig.json or jsconfig.json with source files that you do not work on.',
            type: MessageType.Warning
        });
    }

    connection.onShutdown(() => pluginHost.dispose());
    connection.onExit(() => {
        watcher?.dispose();
        pluginHost.dispose();
    });

    connection.onRenameRequest((req, token) =>
        pluginHost.rename(req.textDocument, req.position, req.newName, token)
    );
    connection.onPrepareRename((req, token) =>
        pluginHost.prepareRename(req.textDocument, req.position, token)
    );

    connection.onDidChangeConfiguration(({ settings }) => {
        configManager.update(settings.svelte?.plugin);
        configManager.updateTsJsUserPreferences(settings);
        configManager.updateTsJsFormateConfig(settings);
        configManager.updateEmmetConfig(settings.emmet);
        configManager.updatePrettierConfig(settings.prettier);
        configManager.updateCssConfig(settings.css);
        configManager.updateScssConfig(settings.scss);
        configManager.updateLessConfig(settings.less);
        configManager.updateHTMLConfig(settings.html);
        Logger.setDebug(settings.svelte?.['language-server']?.debug);
    });

    connection.onDidOpenTextDocument((evt) => {
        const fileName = urlToPath(evt.textDocument.uri);
        if (fileName && isTsOrJsLanguageId(evt.textDocument.languageId)) {
            openTsOrJsFile(
                evt.textDocument.uri,
                fileName,
                evt.textDocument.text,
                evt.textDocument.languageId,
                evt.textDocument.version
            );
            return;
        }
        const externalKey = normalizeUri(evt.textDocument.uri);
        const external = openTsOrJsDocuments.get(externalKey);
        if (external?.open) {
            pluginHost.closeTsOrJsFile(external.fileName);
        }
        // A URI can be reopened with a different language id. Do not let the closed TS/JS
        // tombstone hijack the new Svelte document's subsequent didChange/didClose events.
        openTsOrJsDocuments.delete(externalKey);
        const document = docManager.openClientDocument(evt.textDocument);
        diagnosticsManager.scheduleUpdate(document);
    });

    connection.onDidCloseTextDocument((evt) => {
        const external = openTsOrJsDocuments.get(normalizeUri(evt.textDocument.uri));
        if (external?.open) {
            closeTsOrJsFile(evt.textDocument.uri);
            refreshCrossFilesSemanticFeatures();
            return;
        }
        docManager.closeDocument(evt.textDocument.uri);
    });
    connection.onDidChangeTextDocument((evt) => {
        const external = openTsOrJsDocuments.get(normalizeUri(evt.textDocument.uri));
        if (external?.open) {
            updateTsOrJsFile(
                evt.textDocument.uri,
                external.fileName,
                evt.contentChanges,
                undefined,
                evt.textDocument.version,
                external.languageId
            );
            pluginHost.didUpdateDocument();
            refreshCrossFilesSemanticFeatures();
            return;
        }
        diagnosticsManager.cancelStarted(evt.textDocument.uri);
        docManager.updateDocument(evt.textDocument, evt.contentChanges);
        pluginHost.didUpdateDocument();
    });
    connection.onHover((evt, token) => pluginHost.doHover(evt.textDocument, evt.position, token));
    connection.onCompletion((evt, cancellationToken) =>
        pluginHost.getCompletions(evt.textDocument, evt.position, evt.context, cancellationToken)
    );
    connection.onDocumentFormatting((evt) =>
        pluginHost.formatDocument(evt.textDocument, evt.options)
    );
    connection.onRequest(TagCloseRequest.type, (evt) =>
        pluginHost.doTagComplete(evt.textDocument, evt.position)
    );
    connection.onDocumentColor((evt) => pluginHost.getDocumentColors(evt.textDocument));
    connection.onColorPresentation((evt) =>
        pluginHost.getColorPresentations(evt.textDocument, evt.range, evt.color)
    );
    connection.onDocumentSymbol((evt, cancellationToken) => {
        if (
            configManager.getClientCapabilities()?.textDocument?.documentSymbol
                ?.hierarchicalDocumentSymbolSupport
        ) {
            return pluginHost.getHierarchicalDocumentSymbols(evt.textDocument, cancellationToken);
        } else {
            return pluginHost.getDocumentSymbols(evt.textDocument, cancellationToken);
        }
    });
    connection.onDefinition((evt, token) =>
        pluginHost.getDefinitions(evt.textDocument, evt.position, token)
    );
    connection.onReferences((evt, cancellationToken) =>
        pluginHost.findReferences(evt.textDocument, evt.position, evt.context, cancellationToken)
    );

    connection.onCodeAction((evt, cancellationToken) =>
        pluginHost.getCodeActions(evt.textDocument, evt.range, evt.context, cancellationToken)
    );
    connection.onExecuteCommand(async (evt) => {
        const result = await pluginHost.executeCommand(
            { uri: evt.arguments?.[0] },
            evt.command,
            evt.arguments
        );
        if (WorkspaceEdit.is(result)) {
            const edit: ApplyWorkspaceEditParams = { edit: result };
            connection?.sendRequest(ApplyWorkspaceEditRequest.type.method, edit);
        } else if (result) {
            connection?.sendNotification(ShowMessageNotification.type.method, {
                message: result,
                type: MessageType.Error
            });
        }
    });
    connection.onCodeActionResolve((codeAction, cancellationToken) => {
        const data = codeAction.data as TextDocumentIdentifier;
        return pluginHost.resolveCodeAction(data, codeAction, cancellationToken);
    });

    connection.onCompletionResolve((completionItem, cancellationToken) => {
        const data = (completionItem as AppCompletionItem).data as TextDocumentIdentifier;

        if (!data) {
            return completionItem;
        }

        return pluginHost.resolveCompletion(data, completionItem, cancellationToken);
    });

    connection.onSignatureHelp((evt, cancellationToken) =>
        pluginHost.getSignatureHelp(evt.textDocument, evt.position, evt.context, cancellationToken)
    );

    connection.onSelectionRanges((evt, token) =>
        pluginHost.getSelectionRanges(evt.textDocument, evt.positions, token)
    );

    connection.onImplementation((evt, cancellationToken) =>
        pluginHost.getImplementation(evt.textDocument, evt.position, cancellationToken)
    );

    connection.onTypeDefinition((evt, token) =>
        pluginHost.getTypeDefinition(evt.textDocument, evt.position, token)
    );

    connection.onFoldingRanges((evt, token) =>
        pluginHost.getFoldingRanges(evt.textDocument, token)
    );

    connection.onCodeLens((evt, token) => pluginHost.getCodeLens(evt.textDocument, token));
    connection.onCodeLensResolve((codeLens, token) => {
        const data = codeLens.data as TextDocumentIdentifier;

        if (!data) {
            return codeLens;
        }

        return pluginHost.resolveCodeLens(data, codeLens, token);
    });
    connection.onDocumentHighlight((evt, token) =>
        pluginHost.findDocumentHighlight(evt.textDocument, evt.position, token)
    );

    connection.onWorkspaceSymbol((evt, token) => pluginHost.getWorkspaceSymbols(evt.query, token));

    let diagnosticsManager: DiagnosticsManager = new PushDiagnosticsManager(
        connection.sendDiagnostics,
        docManager,
        pluginHost.getDiagnostics.bind(pluginHost)
    );

    const refreshSemanticTokens = debounceThrottle(() => {
        if (configManager?.getClientCapabilities()?.workspace?.semanticTokens?.refreshSupport) {
            connection?.sendRequest(SemanticTokensRefreshRequest.method);
        }
    }, 1500);

    const refreshInlayHints = debounceThrottle(() => {
        if (configManager?.getClientCapabilities()?.workspace?.inlayHint?.refreshSupport) {
            connection?.sendRequest(InlayHintRefreshRequest.method);
        }
    }, 1500);

    const refreshCrossFilesSemanticFeatures = () => {
        diagnosticsManager.scheduleUpdateAll();
        refreshInlayHints();
        refreshSemanticTokens();
    };

    connection.onDidChangeWatchedFiles(onDidChangeWatchedFiles);
    function onDidChangeWatchedFiles(para: DidChangeWatchedFilesParams) {
        const onWatchFileChangesParas = para.changes
            .map((change) => ({
                fileName: urlToPath(change.uri),
                changeType: change.type
            }))
            .filter((change): change is OnWatchFileChangesPara => !!change.fileName);

        pluginHost.onWatchFileChanges(onWatchFileChangesParas);

        refreshCrossFilesSemanticFeatures();
    }

    connection.onNotification('$/onDidOpenTsOrJsFile', (e: any) => {
        const path = urlToPath(e.uri);
        if (path && typeof e.text === 'string') {
            openTsOrJsFile(e.uri, path, e.text, e.languageId ?? 'typescript', e.version);
        }
    });

    connection.onNotification('$/onDidChangeTsOrJsFile', (e: any) => {
        const path = urlToPath(e.uri);
        if (path) {
            // `text`, version and languageId are supplied by current clients. Keeping them
            // optional preserves the legacy diff-only notification; plugins can reconstruct
            // that first diff from the on-disk base when needed.
            updateTsOrJsFile(e.uri, path, e.changes ?? [], e.text, e.version, e.languageId);
        }

        refreshCrossFilesSemanticFeatures();
    });

    connection.onNotification('$/onDidCloseTsOrJsFile', (e: any) => {
        const path = urlToPath(e.uri);
        if (path) {
            closeTsOrJsFile(e.uri, path);
        }
        refreshCrossFilesSemanticFeatures();
    });

    connection.onRequest(SemanticTokensRequest.type, (evt, cancellationToken) =>
        pluginHost.getSemanticTokens(evt.textDocument, undefined, cancellationToken)
    );
    connection.onRequest(SemanticTokensRangeRequest.type, (evt, cancellationToken) =>
        pluginHost.getSemanticTokens(evt.textDocument, evt.range, cancellationToken)
    );

    connection.onRequest(LinkedEditingRangeRequest.type, async (evt, token) =>
        pluginHost.getLinkedEditingRanges(evt.textDocument, evt.position, token)
    );

    connection.onRequest(InlayHintRequest.type, (evt, cancellationToken) =>
        pluginHost.getInlayHints(evt.textDocument, evt.range, cancellationToken)
    );

    connection.onRequest(
        CallHierarchyPrepareRequest.type,
        async (evt, token) =>
            await pluginHost.prepareCallHierarchy(evt.textDocument, evt.position, token)
    );

    connection.onRequest(
        CallHierarchyIncomingCallsRequest.type,
        async (evt, token) => await pluginHost.getIncomingCalls(evt.item, token)
    );

    connection.onRequest(
        CallHierarchyOutgoingCallsRequest.type,
        async (evt, token) => await pluginHost.getOutgoingCalls(evt.item, token)
    );

    docManager.on('documentChange', (document) => diagnosticsManager.scheduleUpdate(document));
    docManager.on('documentClose', (document: Document) =>
        diagnosticsManager.removeDiagnostics(document)
    );

    // The language server protocol does not have a specific "did rename/move files" event,
    // so we create our own in the extension client and handle it here
    connection.onRequest('$/getEditsForFileRename', async (fileRename: RenameFile) =>
        pluginHost.updateImports(fileRename)
    );

    connection.onRequest('$/getFileReferences', async (uri: string, token) => {
        return pluginHost.fileReferences(uri, token);
    });

    connection.onRequest('$/getComponentReferences', async (uri: string, token) => {
        return pluginHost.findComponentReferences(uri, token);
    });

    // Internal, read-only telemetry used by the acceptance harness. Keeping this on an explicit
    // request means production sessions pay no sampling/logging cost and JSON-RPC serialisation
    // cannot silently erase the Map-backed counters.
    connection.onRequest('$/getTsGoStats', () => tsGoPlugin?.getStatsSnapshot() ?? null);

    connection.onRequest('$/getCompiledCode', async (uri: DocumentUri) => {
        const doc = docManager.get(uri);
        if (!doc) {
            return null;
        }

        const compiled = await sveltePlugin.getCompiledResult(doc);
        if (compiled) {
            const js = compiled.js;
            const css = compiled.css;
            return { js, css };
        } else {
            return null;
        }
    });

    connection.listen();
}
