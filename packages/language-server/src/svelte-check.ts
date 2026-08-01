import { isAbsolute, dirname } from 'path';
import ts from 'typescript';
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver';
import { WorkspaceFolder } from 'vscode-languageserver-protocol';
import { Document, DocumentManager } from './lib/documents';
import { configLoader } from './lib/documents/configLoader';
import { Logger } from './logger';
import { LSConfigManager } from './ls-config';
import {
    CSSPlugin,
    LSAndTSDocResolver,
    PluginHost,
    SveltePlugin,
    TypeScriptPlugin
} from './plugins';
import { FileSystemProvider } from './lib/FileSystemProvider';
import { createLanguageServices } from './plugins/css/service';
import {
    DocumentSnapshot,
    JSOrTSDocumentSnapshot,
    SvelteDocumentSnapshot,
    SvelteSnapshotOptions
} from './plugins/typescript/DocumentSnapshot';
import { isInGeneratedCode } from './plugins/typescript/features/utils';
import { mapAndFilterDiagnostics } from './plugins/typescript/features/DiagnosticsProvider';
import { convertRange, getDiagnosticTag, mapSeverity } from './plugins/typescript/utils';
import { groupBy, normalizePath, pathToUrl, urlToPath } from './utils';
import {
    getConfigLoadErrorDiagnostics,
    isSvelteConfigLoadDiagnostic
} from './plugins/svelte/features/getDiagnostics';

export function mapSvelteCheckDiagnostics(
    sourcePath: string,
    sourceText: string,
    tsDiagnostics: ts.Diagnostic[],
    options?: {
        rewriteExternalImports?: {
            workspacePath: string;
            generatedPath: string;
        };
    }
): Diagnostic[] {
    Logger.setLogErrorsOnly(true);
    const document = new Document(pathToUrl(sourcePath), sourceText, /* skipConfigLoading */ true);
    const snapshot = DocumentSnapshot.fromDocument(document, {
        parse: document.compiler?.parse,
        version: document.compiler?.VERSION,
        transformOnTemplateError: false,
        typingsNamespace: 'svelteHTML',
        emitJsDoc: true,
        rewriteExternalImports: options?.rewriteExternalImports
    } satisfies SvelteSnapshotOptions) as SvelteDocumentSnapshot;

    return mapAndFilterDiagnostics(tsDiagnostics, document, snapshot);
}

export type SvelteCheckDiagnosticSource = 'js' | 'css' | 'svelte';

export interface SvelteCheckOptions {
    compilerWarnings?: Record<string, 'ignore' | 'error'>;
    diagnosticSources?: SvelteCheckDiagnosticSource[];
    /**
     * Path has to be absolute
     */
    tsconfig?: string;
    /**
     * Path to a svelte.config or vite.config file. Path has to be absolute.
     */
    configPath?: string;
    onProjectReload?: () => void;
    watch?: boolean;
    /**
     * Optional callback invoked when a new snapshot is created.
     * Provides the absolute file path of the snapshot.
     */
    onFileSnapshotCreated?: (filePath: string) => void;
}

export interface SvelteCheckFileDiagnostics {
    filePath: string;
    text: string;
    diagnostics: Diagnostic[];
}

/**
 * Prime every Svelte config before classic whole-program diagnostics fan out across files and
 * providers. Besides keeping synchronous document transforms deterministic, this prevents a
 * lazily discovered package config from racing the first preprocess of that package.
 *
 * @internal Exported for the focused checker lifecycle regression.
 */
export async function preloadSvelteConfigsForClassicDiagnostics(
    files: readonly Pick<ts.SourceFile, 'fileName'>[],
    loadConfig: (fileName: string) => Promise<unknown> = (fileName) =>
        configLoader.awaitConfig(fileName)
): Promise<void> {
    await Promise.all(
        files
            .filter((file) => file.fileName.toLowerCase().endsWith('.svelte'))
            .map((file) => loadConfig(file.fileName))
    );
}

/**
 * Small wrapper around PluginHost's Diagnostic Capabilities
 * for svelte-check, without the overhead of the lsp.
 */
export class SvelteCheck {
    private docManager = new DocumentManager(
        (textDocument) => new Document(textDocument.uri, textDocument.text)
    );
    private configManager = new LSConfigManager();
    private pluginHost = new PluginHost(this.docManager);
    private lsAndTSDocResolver?: LSAndTSDocResolver;

    constructor(
        workspacePath: string,
        private options: SvelteCheckOptions = {}
    ) {
        rejectLegacyTsGoModuleInjection(options);
        Logger.setLogErrorsOnly(true);
        this.initialize(workspacePath, options);
    }

    private async initialize(workspacePath: string, options: SvelteCheckOptions) {
        if (options.tsconfig && !isAbsolute(options.tsconfig)) {
            throw new Error('tsconfigPath needs to be absolute, got ' + options.tsconfig);
        }
        if (options.configPath && !isAbsolute(options.configPath)) {
            throw new Error('configPath needs to be absolute, got ' + options.configPath);
        }

        configLoader.setExplicitConfigScope(
            options.configPath
                ? {
                      configPath: options.configPath,
                      rootDirectory: options.tsconfig ? dirname(options.tsconfig) : workspacePath
                  }
                : undefined
        );

        this.configManager.update({
            svelte: {
                compilerWarnings: options.compilerWarnings
            }
        });
        // No HTMLPlugin, it does not provide diagnostics
        if (shouldRegister('svelte')) {
            this.pluginHost.register(new SveltePlugin(this.configManager));
        }
        if (shouldRegister('css')) {
            const services = createLanguageServices({
                fileSystemProvider: new FileSystemProvider()
            });
            const workspaceFolders: WorkspaceFolder[] = [
                {
                    name: '',
                    uri: pathToUrl(workspacePath)
                }
            ];
            this.pluginHost.register(
                new CSSPlugin(this.docManager, this.configManager, workspaceFolders, services)
            );
        }
        if (shouldRegister('js') || options.tsconfig) {
            const workspaceUris = [pathToUrl(workspacePath)];
            this.lsAndTSDocResolver = new LSAndTSDocResolver(
                this.docManager,
                workspaceUris,
                this.configManager,
                {
                    tsconfigPath: options.tsconfig,
                    isSvelteCheck: true,
                    onProjectReloaded: options.onProjectReload,
                    watch: options.watch,
                    onFileSnapshotCreated: options.onFileSnapshotCreated
                }
            );
            this.pluginHost.register(
                new TypeScriptPlugin(
                    this.configManager,
                    this.lsAndTSDocResolver,
                    workspaceUris,
                    this.docManager
                )
            );
        }

        function shouldRegister(source: SvelteCheckDiagnosticSource) {
            return !options.diagnosticSources || options.diagnosticSources.includes(source);
        }
    }

    /**
     * Creates/updates given document
     *
     * @param doc Text and Uri of the document
     * @param isNew Whether or not this is the creation of the document
     */
    async upsertDocument(doc: { text: string; uri: string }, isNew: boolean): Promise<void> {
        const filePath = urlToPath(doc.uri) || '';
        if (this.options.tsconfig) {
            const lsContainer = await this.getLSContainer(this.options.tsconfig);
            if (!lsContainer.fileBelongsToProject(filePath, isNew)) {
                return;
            }
        }

        if (
            doc.uri.endsWith('.ts') ||
            doc.uri.endsWith('.js') ||
            doc.uri.endsWith('.tsx') ||
            doc.uri.endsWith('.jsx') ||
            doc.uri.endsWith('.mjs') ||
            doc.uri.endsWith('.cjs') ||
            doc.uri.endsWith('.mts') ||
            doc.uri.endsWith('.cts')
        ) {
            this.pluginHost.updateTsOrJsFile(filePath, [
                {
                    range: Range.create(
                        Position.create(0, 0),
                        Position.create(Number.MAX_VALUE, Number.MAX_VALUE)
                    ),
                    text: doc.text
                }
            ]);
        } else {
            this.docManager.openClientDocument({
                text: doc.text,
                uri: doc.uri
            });
        }
    }

    /**
     * Removes/closes document
     *
     * @param uri Uri of the document
     */
    async removeDocument(uri: string): Promise<void> {
        if (!this.docManager.get(uri)) {
            return;
        }

        this.docManager.closeDocument(uri);
        this.docManager.releaseDocument(uri);
        if (this.options.tsconfig) {
            const lsContainer = await this.getLSContainer(this.options.tsconfig);
            lsContainer.deleteSnapshot(urlToPath(uri) || '');
        }
    }

    /**
     * Gets the diagnostics for all currently open files.
     */
    async getDiagnostics(): Promise<SvelteCheckFileDiagnostics[]> {
        let diagnostics: SvelteCheckFileDiagnostics[];
        if (this.options.tsconfig) {
            diagnostics = await this.getDiagnosticsForTsconfig(this.options.tsconfig);
        } else {
            diagnostics = await Promise.all(
                this.docManager.getAllOpenedByClient().map(async (doc) => {
                    const uri = doc[1].uri;
                    return await this.getDiagnosticsForFile(uri);
                })
            );
        }

        return this.mergeConfigLoadDiagnostics(diagnostics);
    }

    /**
     * Resolve Svelte config failures independently from compiler/CSS/TypeScript feature gates.
     * Config execution is structural checker work: asking only for JS or CSS diagnostics must
     * not turn a broken project configuration into a clean result.
     */
    async getConfigLoadDiagnostics(
        filePaths: readonly string[]
    ): Promise<SvelteCheckFileDiagnostics[]> {
        const uniqueFiles = new Map<string, string>();
        for (const filePath of filePaths) {
            if (filePath.toLowerCase().endsWith('.svelte')) {
                uniqueFiles.set(normalizePath(filePath), filePath);
            }
        }

        const results = await Promise.all(
            [...uniqueFiles.values()].map(async (filePath) => {
                const config = await configLoader.awaitConfig(filePath);
                if (!config?.loadConfigError) {
                    return undefined;
                }
                const openDocument = this.docManager.get(pathToUrl(filePath));
                return {
                    filePath,
                    text: openDocument?.getText() ?? ts.sys.readFile(filePath) ?? '',
                    diagnostics: getConfigLoadErrorDiagnostics(
                        config.loadConfigError,
                        config.configSource
                    )
                } satisfies SvelteCheckFileDiagnostics;
            })
        );
        return results.filter(
            (result): result is SvelteCheckFileDiagnostics => result !== undefined
        );
    }

    private async mergeConfigLoadDiagnostics(
        diagnostics: SvelteCheckFileDiagnostics[]
    ): Promise<SvelteCheckFileDiagnostics[]> {
        const configDiagnostics = await this.getConfigLoadDiagnostics(
            diagnostics.map((entry) => entry.filePath)
        );
        const byFile = new Map(
            diagnostics.map((entry) => [normalizePath(entry.filePath), entry] as const)
        );
        for (const configEntry of configDiagnostics) {
            const key = normalizePath(configEntry.filePath);
            const existing = byFile.get(key);
            if (!existing) {
                diagnostics.push(configEntry);
                byFile.set(key, configEntry);
                continue;
            }
            if (!existing.diagnostics.some(isSvelteConfigLoadDiagnostic)) {
                existing.diagnostics.push(...configEntry.diagnostics);
            }
        }
        return diagnostics;
    }

    private async getDiagnosticsForTsconfig(tsconfigPath: string) {
        const lsContainer = await this.getLSContainer(tsconfigPath);
        const normalizedTsconfigPath = normalizePath(tsconfigPath);
        const map = (diagnostic: ts.Diagnostic, range?: Range): Diagnostic => {
            const file = diagnostic.file;
            range ??= file
                ? convertRange(
                      { positionAt: file.getLineAndCharacterOfPosition.bind(file) },
                      diagnostic
                  )
                : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

            return {
                range: range,
                severity: mapSeverity(diagnostic.category),
                source: diagnostic.source,
                message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                code: diagnostic.code,
                tags: getDiagnosticTag(diagnostic),
                relatedInformation: diagnostic.relatedInformation
                    ?.filter(
                        (related) =>
                            !!related.file &&
                            related.start !== undefined &&
                            related.length !== undefined
                    )
                    .map((related) => ({
                        location: {
                            uri: pathToUrl(related.file!.fileName),
                            range: convertRange(
                                {
                                    positionAt: related.file!.getLineAndCharacterOfPosition.bind(
                                        related.file
                                    )
                                },
                                related
                            )
                        },
                        message: ts.flattenDiagnosticMessageText(related.messageText, '\n')
                    })),
                data: {
                    positionUnknown:
                        diagnostic.start === undefined || diagnostic.length === undefined
                }
            };
        };

        const isErrorCategory = (diagnostic: ts.Diagnostic) =>
            diagnostic.category === ts.DiagnosticCategory.Error;

        if (lsContainer.configErrors.some(isErrorCategory)) {
            return reportConfigError(lsContainer.configErrors);
        }

        const lang = lsContainer.getService();
        if (lsContainer.configErrors.some(isErrorCategory)) {
            return reportConfigError(lsContainer.configErrors);
        }

        const program = lang.getProgram();
        const globalOrConfigFileDiagnostics = program
            ? [...program.getGlobalDiagnostics(), ...program.getOptionsDiagnostics()]
            : [];
        // TODO: enable this in svelte-check v5. For now, we report these as warnings along with other diagnostics.
        // if (globalOrConfigFileDiagnostics.some(isErrorCategory)) {
        //     return reportConfigError(globalOrConfigFileDiagnostics);
        // }

        const files = lang.getProgram()?.getSourceFiles() || [];
        const options = lang.getProgram()?.getCompilerOptions() || {};

        // Finish config discovery before Svelte style preprocessing starts in the parallel
        // diagnostics below. This also ensures synchronous document transforms see the loaded
        // package-local config on their first pass.
        await preloadSvelteConfigsForClassicDiagnostics(files);

        const diagnostics = await Promise.all(
            files.map((file) => {
                const uri = pathToUrl(file.fileName);
                const doc = this.docManager.get(uri);
                if (doc) {
                    this.docManager.markAsOpenedInClient(uri);
                    return this.getDiagnosticsForFile(uri);
                } else {
                    // This check is done inside TS mostly, too, but for some diagnostics like suggestions it
                    // doesn't apply to all code paths. That's why we do it here, too.
                    const skipDiagnosticsForFile =
                        (options.skipLibCheck && file.isDeclarationFile) ||
                        (options.skipDefaultLibCheck && file.hasNoDefaultLib) ||
                        lsContainer.isShimFiles(file.fileName) ||
                        // ignore JS files in node_modules
                        /\/node_modules\/.+\.(c|m)?js$/.test(file.fileName);
                    const snapshot = lsContainer.snapshotManager.get(file.fileName) as
                        | JSOrTSDocumentSnapshot
                        | undefined;
                    const isKitFile = snapshot?.kitFile ?? false;
                    const diagnostics: Diagnostic[] = [];
                    if (!skipDiagnosticsForFile) {
                        const diagnosticSources = [
                            'getSyntacticDiagnostics',
                            'getSuggestionDiagnostics',
                            'getSemanticDiagnostics'
                        ] as const;
                        for (const diagnosticSource of diagnosticSources) {
                            for (let diagnostic of lang[diagnosticSource](file.fileName)) {
                                if (
                                    diagnostic.start === undefined ||
                                    diagnostic.length === undefined ||
                                    !isKitFile
                                ) {
                                    diagnostics.push(map(diagnostic));
                                    continue;
                                }

                                let range: Range | undefined = undefined;
                                const inGenerated = isInGeneratedCode(
                                    file.text,
                                    diagnostic.start,
                                    diagnostic.start + diagnostic.length
                                );
                                if (inGenerated && snapshot) {
                                    const pos = snapshot.getOriginalPosition(
                                        snapshot.positionAt(diagnostic.start)
                                    );
                                    range = {
                                        start: pos,
                                        end: {
                                            line: pos.line,
                                            // adjust length so it doesn't spill over to the next line
                                            character: pos.character + 1
                                        }
                                    };
                                    // If not one of the specific error messages then filter out
                                    if (diagnostic.code === 2307) {
                                        diagnostic = {
                                            ...diagnostic,
                                            messageText:
                                                typeof diagnostic.messageText === 'string' &&
                                                diagnostic.messageText.includes('./$types')
                                                    ? diagnostic.messageText +
                                                      ` (this likely means that SvelteKit's type generation didn't run yet - try running it by executing 'npm run dev' or 'npm run build')`
                                                    : diagnostic.messageText
                                        };
                                    } else if (diagnostic.code === 2694) {
                                        diagnostic = {
                                            ...diagnostic,
                                            messageText:
                                                typeof diagnostic.messageText === 'string' &&
                                                diagnostic.messageText.includes('/$types')
                                                    ? diagnostic.messageText +
                                                      ` (this likely means that SvelteKit's generated types are out of date - try rerunning it by executing 'npm run dev' or 'npm run build')`
                                                    : diagnostic.messageText
                                        };
                                    } else if (
                                        diagnostic.code !==
                                        2355 /*  A function whose declared type is neither 'void' nor 'any' must return a value */
                                    ) {
                                        continue;
                                    }
                                }

                                diagnostics.push(map(diagnostic, range));
                            }
                        }
                    }

                    return {
                        filePath: file.fileName,
                        text: snapshot?.originalText ?? file.text,
                        diagnostics
                    };
                }
            })
        );

        const configErrors = lsContainer.configErrors
            // TODO: remove this in svelte-check v5.
            .concat(
                globalOrConfigFileDiagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    category:
                        diagnostic.category === ts.DiagnosticCategory.Error
                            ? ts.DiagnosticCategory.Warning
                            : diagnostic.category
                }))
            );
        if (configErrors.length) {
            diagnostics.push(...reportConfigError(configErrors));
        }

        return diagnostics;

        function reportConfigError(errors: readonly ts.Diagnostic[]) {
            const grouped = groupBy(
                errors,
                (error) => error.file?.fileName ?? normalizedTsconfigPath
            );
            const lspDiagnostics = errors.map((diagnostic) => map(diagnostic));

            return Object.entries(grouped).map(([filePath, errors]) => ({
                filePath,
                text: lspDiagnostics.some((diagnostic) => !diagnostic.data?.positionUnknown)
                    ? (ts.sys?.readFile(filePath) ?? '')
                    : '',
                diagnostics: lspDiagnostics
            }));
        }
    }

    private async getDiagnosticsForFile(uri: string) {
        const diagnostics = deduplicateSvelteParserDiagnostics(
            await this.pluginHost.getDiagnostics({ uri })
        );
        return {
            filePath: urlToPath(uri) || '',
            text: this.docManager.get(uri)?.getText() || '',
            diagnostics
        };
    }

    private getLSContainer(tsconfigPath: string) {
        if (!this.lsAndTSDocResolver) {
            throw new Error('Cannot run with tsconfig path without LS/TSdoc resolver');
        }
        return this.lsAndTSDocResolver.getTSService(tsconfigPath);
    }

    /**
     * Gets the watch directories based on the tsconfig include patterns.
     * Returns null if no tsconfig is specified.
     */
    async getWatchDirectories(): Promise<{ path: string; recursive: boolean }[] | null> {
        if (!this.options.tsconfig) {
            return null;
        }

        const lsContainer = await this.getLSContainer(this.options.tsconfig);
        const projectConfig: { wildcardDirectories?: Record<string, ts.WatchDirectoryFlags> } =
            lsContainer.getProjectConfig();

        if (!projectConfig.wildcardDirectories) {
            return null;
        }

        return Object.entries(projectConfig.wildcardDirectories).map(([dir, flags]) => ({
            path: dir,
            recursive: !!(flags & ts.WatchDirectoryFlags.Recursive)
        }));
    }
}

/**
 * The old programmatic tsgo route accepted two unrelated module objects supplied by the caller.
 * There was no way to prove that either module belonged to the exact package which supplied the
 * native executable, so an Effect binary could silently run against the stock API (or vice versa).
 * Keep an explicit runtime rejection for JavaScript callers compiled against an older declaration;
 * supported tsgo entry points resolve the executable and package identity through ResolvedTsGoEngine.
 */
function rejectLegacyTsGoModuleInjection(options: SvelteCheckOptions): void {
    const experimental = (options as SvelteCheckOptions & { experimental?: unknown }).experimental;
    if (
        experimental !== null &&
        (typeof experimental === 'object' || typeof experimental === 'function') &&
        'tsgo' in experimental
    ) {
        throw new Error(
            'SvelteCheckOptions.experimental.tsgo has been removed because caller-provided API ' +
                'modules cannot be matched to the resolved native engine. Use `svelte-check --tsgo` ' +
                'or `TsGoBatchOverlay.create(...)` instead.'
        );
    }
}

/**
 * A template parse failure is visible to both the Svelte compiler plugin and the generated
 * TypeScript snapshot. Prefer the compiler's named/code-linked diagnostic over the synthetic
 * TypeScript `-1` copy, while preserving multiplicity for ordinary type diagnostics.
 */
export function deduplicateSvelteParserDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    const identity = (diagnostic: Diagnostic) =>
        JSON.stringify([diagnostic.severity, diagnostic.message]);
    const isCompilerParserError = (diagnostic: Diagnostic) =>
        diagnostic.source === 'svelte' &&
        diagnostic.severity === DiagnosticSeverity.Error &&
        (diagnostic.codeDescription?.href.includes('/compiler-errors#') ||
            diagnostic.message.includes('https://svelte.dev/e/'));
    const authoritativeIdentities = new Set(
        diagnostics.filter(isCompilerParserError).map(identity)
    );
    const emitted = new Set<string>();
    const result: Diagnostic[] = [];

    for (const diagnostic of diagnostics) {
        const key = identity(diagnostic);
        if (!authoritativeIdentities.has(key)) {
            // Ordinary diagnostics retain their full multiplicity. Only a matching named
            // compiler failure proves that the TypeScript copy came from a broken shadow.
            result.push(diagnostic);
            continue;
        }
        if (isCompilerParserError(diagnostic) && !emitted.has(key)) {
            emitted.add(key);
            result.push(diagnostic);
        }
    }
    return result;
}
