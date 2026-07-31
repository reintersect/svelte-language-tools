/**
 * This code's groundwork is taken from https://github.com/vuejs/vetur/tree/master/vti
 */

import { watch, FSWatcher } from 'chokidar';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { SvelteCheck, SvelteCheckOptions } from 'svelte-language-server';
import ts from 'typescript';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { parseOptions, SvelteCheckCliOptions } from './options';
import {
    DEFAULT_FILTER,
    DiagnosticFilter,
    HumanFriendlyWriter,
    MachineFriendlyWriter,
    Writer
} from './writers';
import {
    emitSvelteFiles,
    EmitResult,
    mapCliDiagnosticsToLsp,
    runTypeScriptDiagnostics,
    updateDiagnosticsCache,
    writeOverlayTsconfig
} from './incremental';
import { createIgnored, findFiles } from './utils';
import { runTsGoCheck } from './tsgo-overlay';

type Result = {
    fileCount: number;
    errorCount: number;
    warningCount: number;
    fileCountWithProblems: number;
};

async function openAllDocuments(
    workspaceUri: URI,
    filePathsToIgnore: string[],
    svelteCheck: SvelteCheck
) {
    const absFilePaths = await findFiles(workspaceUri.fsPath, filePathsToIgnore, (filePath) =>
        filePath.endsWith('.svelte')
    );
    await openDocuments(absFilePaths, svelteCheck);
}

async function openDocuments(filePaths: string[], svelteCheck: SvelteCheck) {
    for (const absFilePath of filePaths) {
        const text = fs.readFileSync(absFilePath, 'utf-8');
        svelteCheck.upsertDocument(
            {
                uri: URI.file(absFilePath).toString(),
                text
            },
            true
        );
    }
}

async function getDiagnostics(
    workspaceUri: URI,
    writer: Writer,
    svelteCheck: SvelteCheck
): Promise<Result | null> {
    try {
        const diagnostics = await svelteCheck.getDiagnostics();
        return writeDiagnostics(workspaceUri, writer, diagnostics);
    } catch (err: any) {
        writer.failure(err);
        return null;
    }
}

const FILE_ENDING_REGEX = /\.(svelte|d\.ts|ts|js|jsx|tsx|mjs|cjs|mts|cts)$/;
const VIRTUAL_WATCH_FILE_REGEX = /\.(svelte|json|[cm]?[jt]sx?)$/i;
const VITE_CONFIG_REGEX = /vite\.config\.(js|ts)\.timestamp-/;
const TS_OR_JS_SOURCE_REGEX = /\.[cm]?[jt]sx?$/i;
const CONFIG_FILE_NAMES = [
    'svelte.config.js',
    'svelte.config.cjs',
    'svelte.config.mjs',
    'svelte.config.ts',
    'svelte.config.cts',
    'svelte.config.mts',
    'vite.config.js',
    'vite.config.cjs',
    'vite.config.mjs',
    'vite.config.ts',
    'vite.config.cts',
    'vite.config.mts'
];

/** Only module-graph changes require rebuilding shared dependency indexes. */
function moduleGraphSignature(filePath: string): string {
    try {
        const text = fs.readFileSync(filePath, 'utf8');
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
    } catch {
        return '<unreadable>';
    }
}

function existingConfigCandidate(candidate: string): string | undefined {
    for (const filePath of [
        candidate,
        candidate.endsWith('.json') ? candidate : `${candidate}.json`,
        path.join(candidate, 'tsconfig.json')
    ]) {
        try {
            if (fs.statSync(filePath).isFile()) {
                return path.resolve(filePath);
            }
        } catch {
            // Try the next TypeScript config spelling.
        }
    }
}

function resolveExtendedConfig(specifier: string, containingConfig: string): string | undefined {
    const configDir = path.dirname(containingConfig);
    if (path.isAbsolute(specifier) || specifier.startsWith('.')) {
        const candidate = path.resolve(configDir, specifier);
        return (
            existingConfigCandidate(candidate) ??
            (path.extname(candidate) ? candidate : `${candidate}.json`)
        );
    }

    const requireFromConfig = createRequire(path.join(configDir, '__svelte_check_resolve.cjs'));
    for (const request of [specifier, `${specifier}.json`, `${specifier}/tsconfig.json`]) {
        try {
            return path.resolve(requireFromConfig.resolve(request));
        } catch {
            // Package configs are not required to expose package.json. Try the next public entry.
        }
    }
}

function collectTsconfigGraph(entryConfig: string | undefined): Set<string> {
    const configs = new Set<string>();
    const pending = entryConfig ? [path.resolve(entryConfig)] : [];
    while (pending.length) {
        const configPath = pending.pop()!;
        if (configs.has(configPath)) continue;
        configs.add(configPath);

        const read = ts.readConfigFile(configPath, ts.sys.readFile);
        if (read.error || !read.config || typeof read.config !== 'object') continue;
        const extended = Array.isArray(read.config.extends)
            ? read.config.extends
            : typeof read.config.extends === 'string'
              ? [read.config.extends]
              : [];
        for (const specifier of extended) {
            if (typeof specifier !== 'string') continue;
            const resolved = resolveExtendedConfig(specifier, configPath);
            if (resolved && !configs.has(resolved)) pending.push(resolved);
        }
        for (const reference of Array.isArray(read.config.references)
            ? read.config.references
            : []) {
            if (typeof reference?.path !== 'string') continue;
            const candidate = path.resolve(path.dirname(configPath), reference.path);
            const resolved =
                existingConfigCandidate(candidate) ??
                (path.extname(candidate) ? candidate : path.join(candidate, 'tsconfig.json'));
            if (resolved && !configs.has(resolved)) pending.push(resolved);
        }
    }
    return configs;
}

function readManifest(manifestPath: string): Record<string, any> | undefined {
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return manifest && typeof manifest === 'object' ? manifest : undefined;
    } catch {
        return undefined;
    }
}

function findWorkspaceManifests(workspacePath: string): string[] {
    const manifests: string[] = [];
    const pending = [workspacePath];
    const ignored = new Set(['node_modules', '.git', '.svelte-kit', '.svelte-check']);
    while (pending.length) {
        const directory = pending.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory() && !ignored.has(entry.name)) pending.push(entryPath);
            else if (entry.isFile() && entry.name === 'package.json') manifests.push(entryPath);
        }
    }
    return manifests;
}

function directDependencyManifest(packageRoot: string, packageName: string): string | undefined {
    const direct = path.join(
        packageRoot,
        'node_modules',
        ...packageName.split('/'),
        'package.json'
    );
    try {
        return fs.realpathSync(direct);
    } catch {
        // pnpm and exports-restricted packages may need entry-point resolution instead.
    }

    const requireFromPackage = createRequire(path.join(packageRoot, '__svelte_check_resolve.cjs'));
    let entry: string;
    try {
        entry = requireFromPackage.resolve(packageName);
    } catch {
        return;
    }
    for (let directory = path.dirname(entry); ; directory = path.dirname(directory)) {
        const manifestPath = path.join(directory, 'package.json');
        const manifest = readManifest(manifestPath);
        if (manifest?.name === packageName) return manifestPath;
        const parent = path.dirname(directory);
        if (parent === directory) return;
    }
}

function collectManifestClosure(workspacePath: string): Set<string> {
    const workspaceManifests = findWorkspaceManifests(workspacePath).map((manifestPath) =>
        path.resolve(manifestPath)
    );
    const workspaceSet = new Set(workspaceManifests);
    const manifests = new Set<string>();
    const pending = [...workspaceManifests];
    while (pending.length) {
        const manifestPath = pending.pop()!;
        if (manifests.has(manifestPath)) continue;
        manifests.add(manifestPath);
        const manifest = readManifest(manifestPath);
        if (!manifest) continue;
        const packageRoot = path.dirname(manifestPath);
        const isSveltePackage =
            workspaceSet.has(manifestPath) ||
            manifest.name === 'svelte' ||
            typeof manifest.svelte === 'string' ||
            Boolean(manifest.dependencies?.svelte || manifest.peerDependencies?.svelte) ||
            JSON.stringify(manifest.exports ?? '').includes('.svelte') ||
            CONFIG_FILE_NAMES.some((configName) =>
                fs.existsSync(path.join(packageRoot, configName))
            );
        if (!isSveltePackage) continue;
        const dependencies = {
            ...manifest.dependencies,
            ...manifest.optionalDependencies,
            ...manifest.peerDependencies,
            ...(workspaceSet.has(manifestPath) ? manifest.devDependencies : undefined)
        };
        for (const packageName of Object.keys(dependencies)) {
            const resolved = directDependencyManifest(path.dirname(manifestPath), packageName);
            if (resolved && !manifests.has(resolved)) pending.push(path.resolve(resolved));
        }
    }
    return manifests;
}

function collectVirtualWatchTargets(opts: SvelteCheckCliOptions): Set<string> {
    const targets = collectTsconfigGraph(opts.tsconfig);
    if (opts.config) targets.add(path.resolve(opts.config));
    for (const manifestPath of collectManifestClosure(opts.workspaceUri.fsPath)) {
        targets.add(manifestPath);
        const packageRoot = path.dirname(manifestPath);
        for (const configName of CONFIG_FILE_NAMES) {
            const configPath = path.join(packageRoot, configName);
            if (fs.existsSync(configPath)) targets.add(configPath);
        }
    }
    return targets;
}

class DiagnosticsWatcher {
    private updateDiagnostics: any;
    private watcher: FSWatcher;
    private currentWatchedDirs = new Set<string>();
    private userIgnored: Array<(path: string) => boolean>;
    private pendingWatcherUpdate: any;
    private fatalWatcherError = false;

    constructor(
        private workspaceUri: URI,
        private svelteCheck: SvelteCheck,
        private writer: Writer,
        filePathsToIgnore: string[],
        private ignoreInitialAdd: boolean
    ) {
        this.userIgnored = createIgnored(filePathsToIgnore);

        // Create watcher with initial paths
        this.watcher = watch([], {
            ignored: (path, stats) => {
                if (
                    path.includes('node_modules') ||
                    path.includes('.git') ||
                    stats?.isSocket() ||
                    (stats?.isFile() &&
                        (!FILE_ENDING_REGEX.test(path) || VITE_CONFIG_REGEX.test(path)))
                ) {
                    return true;
                }

                if (this.userIgnored.length !== 0) {
                    // Make path relative to workspace for user ignores
                    const workspaceRelative = path.startsWith(this.workspaceUri.fsPath)
                        ? path.slice(this.workspaceUri.fsPath.length + 1)
                        : path;
                    for (const i of this.userIgnored) {
                        if (i(workspaceRelative)) {
                            return true;
                        }
                    }
                }

                return false;
            },
            ignoreInitial: this.ignoreInitialAdd
        })
            .on('add', (path) => this.runWatcherTask(this.updateDocument(path, true)))
            .on('unlink', (path) => this.runWatcherTask(this.removeDocument(path)))
            .on('change', (path) => this.runWatcherTask(this.updateDocument(path, false)))
            .on('error', (error) => this.failWatcher(error));

        this.updateWildcardWatcher()
            .then(() => {
                // ensuring the typescript program is built after wildcard watchers are added
                // so that individual file watchers added from onFileSnapshotCreated
                // run after the wildcard ones
                if (this.ignoreInitialAdd) {
                    return getDiagnostics(this.workspaceUri, this.writer, this.svelteCheck);
                }
            })
            .catch((error) => this.failWatcher(error));
    }

    private failWatcher(error: unknown) {
        if (this.fatalWatcherError) return;
        this.fatalWatcherError = true;
        clearTimeout(this.updateDiagnostics);
        clearTimeout(this.pendingWatcherUpdate);
        this.writer.failure(error instanceof Error ? error : new Error(String(error)));
        void this.watcher.close().finally(() => exitAfterFlush(1));
    }

    private runWatcherTask(task: Promise<void>) {
        void task.catch((error) => this.failWatcher(error));
    }

    private isSubDir(candidate: string, parent: string) {
        const c = path.resolve(candidate);
        const p = path.resolve(parent);
        return c === p || c.startsWith(p + path.sep);
    }

    private minimizeDirs(dirs: string[]): string[] {
        const sorted = [...new Set(dirs.map((d) => path.resolve(d)))].sort();
        const result: string[] = [];
        for (const dir of sorted) {
            if (!result.some((p) => this.isSubDir(dir, p))) {
                result.push(dir);
            }
        }
        return result;
    }

    addWatchDirectory(dir: string) {
        if (!dir) {
            return;
        }

        // Skip if already covered by an existing watched directory
        for (const existing of this.currentWatchedDirs) {
            if (this.isSubDir(dir, existing)) {
                return;
            }
        }

        // Don't remove existing watchers, chokidar `unwatch` ignores future events from that path instead of closing the watcher in some cases
        for (const existing of this.currentWatchedDirs) {
            if (this.isSubDir(existing, dir)) {
                this.currentWatchedDirs.delete(existing);
            }
        }

        this.watcher.add(dir);
        this.currentWatchedDirs.add(dir);
    }

    private async updateWildcardWatcher() {
        const watchDirs = await this.svelteCheck.getWatchDirectories();
        const desired = this.minimizeDirs(
            (watchDirs?.map((d) => d.path) || [this.workspaceUri.fsPath]).map((p) =>
                path.resolve(p)
            )
        );

        const current = new Set([...this.currentWatchedDirs].map((p) => path.resolve(p)));

        const toAdd = desired.filter((d) => !current.has(d));
        if (toAdd.length) {
            this.watcher.add(toAdd);
        }

        this.currentWatchedDirs = new Set([...current, ...toAdd]);
    }

    private async updateDocument(path: string, isNew: boolean) {
        await this.svelteCheck.upsertDocument(
            {
                // delay reading until we actually need the text
                // prevents race conditions from crashing svelte-check when something is created and deleted immediately afterwards
                get text() {
                    return fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : '';
                },
                uri: URI.file(path).toString()
            },
            isNew
        );
        this.scheduleDiagnostics();
    }

    private async removeDocument(path: string) {
        await this.svelteCheck.removeDocument(URI.file(path).toString());
        this.scheduleDiagnostics();
    }

    updateWildcardWatchers() {
        clearTimeout(this.pendingWatcherUpdate);
        this.pendingWatcherUpdate = setTimeout(() => this.updateWildcardWatcher(), 1000);
    }

    scheduleDiagnostics() {
        clearTimeout(this.updateDiagnostics);
        this.updateDiagnostics = setTimeout(
            () => getDiagnostics(this.workspaceUri, this.writer, this.svelteCheck),
            1000
        );
    }
}

function createFilter(opts: SvelteCheckCliOptions): DiagnosticFilter {
    switch (opts.threshold) {
        case 'error':
            return (d) => d.severity === DiagnosticSeverity.Error;
        case 'warning':
            return (d) =>
                d.severity === DiagnosticSeverity.Error ||
                d.severity === DiagnosticSeverity.Warning;
        default:
            return DEFAULT_FILTER;
    }
}

function instantiateWriter(opts: SvelteCheckCliOptions): Writer {
    const filter = createFilter(opts);

    if (opts.outputFormat === 'human-verbose' || opts.outputFormat === 'human') {
        return new HumanFriendlyWriter(
            process.stdout,
            opts.outputFormat === 'human-verbose',
            opts.watch,
            !opts.preserveWatchOutput,
            filter
        );
    } else {
        return new MachineFriendlyWriter(
            process.stdout,
            opts.outputFormat === 'machine-verbose',
            filter
        );
    }
}

function writeDiagnostics(
    workspaceUri: URI,
    writer: Writer,
    diagnostics: Array<{ filePath: string; text: string; diagnostics: Diagnostic[] }>
): Result {
    writer.start(workspaceUri.fsPath);

    const result: Result = {
        fileCount: diagnostics.length,
        errorCount: 0,
        warningCount: 0,
        fileCountWithProblems: 0
    };

    for (const diagnostic of diagnostics) {
        writer.file(
            diagnostic.diagnostics,
            workspaceUri.fsPath,
            relativeToWorkspace(workspaceUri.fsPath, diagnostic.filePath),
            diagnostic.text
        );

        let fileHasProblems = false;

        diagnostic.diagnostics.forEach((d: Diagnostic) => {
            if (d.severity === DiagnosticSeverity.Error) {
                result.errorCount += 1;
                fileHasProblems = true;
            } else if (d.severity === DiagnosticSeverity.Warning) {
                result.warningCount += 1;
                fileHasProblems = true;
            }
        });

        if (fileHasProblems) {
            result.fileCountWithProblems += 1;
        }
    }

    writer.completion(
        result.fileCount,
        result.errorCount,
        result.warningCount,
        result.fileCountWithProblems
    );

    return result;
}

function relativeToWorkspace(workspacePath: string, filePath: string): string {
    const direct = path.relative(workspacePath, filePath);
    if (!isOutsideWorkspace(direct)) return direct;

    // macOS exposes /var through /private/var, and package managers frequently return the real
    // path behind a workspace symlink. Preserve the user's workspace-relative machine protocol.
    try {
        const canonical = path.relative(fs.realpathSync(workspacePath), fs.realpathSync(filePath));
        if (!isOutsideWorkspace(canonical)) return canonical;
    } catch {
        // The diagnostic may describe a config that no longer exists; keep the direct spelling.
    }
    return direct;
}

function isOutsideWorkspace(relativePath: string): boolean {
    return (
        relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    );
}

async function getSvelteDiagnosticsForIncremental(
    opts: SvelteCheckCliOptions,
    emitResult: EmitResult
): Promise<{
    diagnostics: Array<{ filePath: string; text: string; diagnostics: Diagnostic[] }>;
    compilerWarningsByFile: Map<string, Diagnostic[]>;
    cssDiagnosticsByFile: Map<string, Diagnostic[]>;
}> {
    const sources = opts.diagnosticSources;
    if (!sources.includes('svelte') && !sources.includes('css')) {
        return {
            diagnostics: [],
            compilerWarningsByFile: new Map(),
            cssDiagnosticsByFile: new Map()
        };
    }

    const diagnosticsByFile = new Map<
        string,
        { filePath: string; text: string; diagnostics: Diagnostic[] }
    >();
    const compilerWarningsByFile = new Map<string, Diagnostic[]>();
    const cssDiagnosticsByFile = new Map<string, Diagnostic[]>();
    const changedFiles = new Set(emitResult.changedFiles);
    const filesNeedingDiagnostics: string[] = [];
    const enabledSources = sources.filter((source) => source !== 'js');

    // Phase 1: Partition files into "needs fresh diagnostics" vs "use cached diagnostics"
    for (const entry of emitResult.entries) {
        const needsSvelte =
            sources.includes('svelte') &&
            (!entry.compilerWarnings || changedFiles.has(entry.sourcePath));
        const needsCss =
            sources.includes('css') &&
            (!entry.cssDiagnostics || changedFiles.has(entry.sourcePath));
        if (needsSvelte || needsCss) {
            filesNeedingDiagnostics.push(entry.sourcePath);
            continue;
        }

        if (sources.includes('svelte') && entry.compilerWarnings) {
            const text = fs.readFileSync(entry.sourcePath, 'utf-8');
            diagnosticsByFile.set(entry.sourcePath, {
                filePath: entry.sourcePath,
                text,
                diagnostics: [...entry.compilerWarnings]
            });
        }
        if (sources.includes('css') && entry.cssDiagnostics) {
            const existing = diagnosticsByFile.get(entry.sourcePath) ?? {
                filePath: entry.sourcePath,
                text: fs.readFileSync(entry.sourcePath, 'utf-8'),
                diagnostics: []
            };
            existing.diagnostics.push(...entry.cssDiagnostics);
            diagnosticsByFile.set(entry.sourcePath, existing);
        }
    }

    // Phase 2: Run fresh diagnostics for changed/uncached files via the language server
    if (enabledSources.length && filesNeedingDiagnostics.length > 0) {
        const svelteCheck = new SvelteCheck(opts.workspaceUri.fsPath, {
            compilerWarnings: opts.compilerWarnings,
            diagnosticSources: enabledSources,
            configPath: opts.config,
            watch: false
        });
        await openDocuments(filesNeedingDiagnostics, svelteCheck);
        const runDiagnostics = await svelteCheck.getDiagnostics();
        for (const entry of runDiagnostics) {
            diagnosticsByFile.set(entry.filePath, entry);
            if (sources.includes('svelte')) {
                compilerWarningsByFile.set(
                    entry.filePath,
                    entry.diagnostics.filter((diag) => diag.source === 'svelte')
                );
            }
            if (sources.includes('css')) {
                cssDiagnosticsByFile.set(
                    entry.filePath,
                    entry.diagnostics.filter((diag) => diag.source === 'css')
                );
            }
        }
        for (const filePath of filesNeedingDiagnostics) {
            if (sources.includes('svelte') && !compilerWarningsByFile.has(filePath)) {
                compilerWarningsByFile.set(filePath, []);
            }
            if (sources.includes('css') && !cssDiagnosticsByFile.has(filePath)) {
                cssDiagnosticsByFile.set(filePath, []);
            }
            if (!diagnosticsByFile.has(filePath)) {
                const text = fs.readFileSync(filePath, 'utf-8');
                const diagnostics: Diagnostic[] = [];
                if (sources.includes('svelte')) {
                    diagnostics.push(...(compilerWarningsByFile.get(filePath) ?? []));
                }
                if (sources.includes('css')) {
                    diagnostics.push(...(cssDiagnosticsByFile.get(filePath) ?? []));
                }
                diagnosticsByFile.set(filePath, {
                    filePath,
                    text,
                    diagnostics
                });
            }
        }
    }

    // Phase 3: Ensure every entry has a diagnostics record (empty if no diagnostics)
    for (const entry of emitResult.entries) {
        if (!diagnosticsByFile.has(entry.sourcePath)) {
            const text = fs.readFileSync(entry.sourcePath, 'utf-8');
            diagnosticsByFile.set(entry.sourcePath, {
                filePath: entry.sourcePath,
                text,
                diagnostics: []
            });
        }
    }

    return {
        diagnostics: Array.from(diagnosticsByFile.values()),
        compilerWarningsByFile,
        cssDiagnosticsByFile
    };
}

/**
 * `--tsgo`: check the whole project through the language server's tsgo overlay.
 *
 * Separate from {@link runWithVirtualFiles}, which is the `--incremental` (tsc) path. They used
 * to share an overlay; they no longer do, because the tsgo one has to solve module resolution
 * problems tsc does not have — see `tsgo-overlay.ts`.
 */
async function runWithTsGo(opts: SvelteCheckCliOptions, writer: Writer): Promise<Result | null> {
    const diagnostics = await runTsGoCheck(opts);
    return writeDiagnostics(opts.workspaceUri, writer, diagnostics);
}

async function runWithVirtualFiles(
    opts: SvelteCheckCliOptions,
    writer: Writer
): Promise<Result | null> {
    if (!opts.tsconfig) {
        throw new Error('`--incremental` requires a tsconfig/jsconfig file');
    }

    const emitResult = await emitSvelteFiles(
        opts.workspaceUri.fsPath,
        opts.filePathsToIgnore,
        opts.incremental,
        opts.config,
        opts.clearConfigCache
    );
    const overlayTsconfig = writeOverlayTsconfig(opts.tsconfig, emitResult, opts.incremental);
    const tsDiagnostics = mapCliDiagnosticsToLsp(
        await runTypeScriptDiagnostics(overlayTsconfig, opts.incremental, opts.workspaceUri.fsPath),
        emitResult,
        opts.tsconfig
    );

    const {
        diagnostics: svelteDiagnostics,
        compilerWarningsByFile,
        cssDiagnosticsByFile
    } = await getSvelteDiagnosticsForIncremental(opts, emitResult);
    if (opts.incremental) {
        updateDiagnosticsCache(emitResult, {
            compilerWarningsByFile,
            cssDiagnosticsByFile
        });
    }
    const diagnosticsByFile = new Map<
        string,
        { filePath: string; text: string; diagnostics: Diagnostic[] }
    >();

    for (const entry of svelteDiagnostics) {
        diagnosticsByFile.set(entry.filePath, {
            filePath: entry.filePath,
            text: entry.text,
            diagnostics: entry.diagnostics
        });
    }

    for (const entry of tsDiagnostics) {
        const existing = diagnosticsByFile.get(entry.filePath) ?? {
            filePath: entry.filePath,
            text: entry.text,
            diagnostics: []
        };
        existing.diagnostics.push(...entry.diagnostics);
        diagnosticsByFile.set(entry.filePath, existing);
    }

    return writeDiagnostics(opts.workspaceUri, writer, Array.from(diagnosticsByFile.values()));
}

async function watchWithVirtualFiles(
    opts: SvelteCheckCliOptions,
    writer: Writer,
    runOnce: (opts: SvelteCheckCliOptions, writer: Writer) => Promise<Result | null>
) {
    let pending: NodeJS.Timeout | undefined;
    let running = false;
    let rerun = false;
    let fatalWatcherError = false;
    let watchGraphDirty = false;
    let configCacheDirty = false;
    let workspaceIndexDirty = false;
    const moduleGraphSignatures = new Map<string, string>();
    const userIgnored = createIgnored(opts.filePathsToIgnore);
    const explicitTargets = collectVirtualWatchTargets(opts);

    const isExplicitTarget = (candidate: string) => explicitTargets.has(path.resolve(candidate));

    let watcher: FSWatcher;

    const refreshExplicitTargets = () => {
        const added: string[] = [];
        for (const target of collectVirtualWatchTargets(opts)) {
            if (explicitTargets.has(target)) continue;
            explicitTargets.add(target);
            added.push(target);
        }
        if (added.length) watcher.add(added);
    };

    const run = async () => {
        if (fatalWatcherError) return;
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        const clearConfigCache = configCacheDirty;
        configCacheDirty = false;
        const clearTsGoWorkspaceIndex = workspaceIndexDirty && !clearConfigCache;
        workspaceIndexDirty = false;
        try {
            await runOnce({ ...opts, clearConfigCache, clearTsGoWorkspaceIndex }, writer);
        } catch (err: any) {
            // A failed check is not a normal watch iteration. Keeping the watcher alive after a
            // spawn/config/parser failure leaves machine consumers with a FAILURE record from a
            // process that still reports success when it is eventually terminated. Make the
            // failure terminal and flush it before exiting, matching one-shot mode.
            fatalWatcherError = true;
            clearTimeout(pending);
            writer.failure(err instanceof Error ? err : new Error(String(err)));
            void watcher.close().finally(() => exitAfterFlush(1));
        } finally {
            if (fatalWatcherError) {
                running = false;
                return;
            }
            if (watchGraphDirty) {
                watchGraphDirty = false;
                refreshExplicitTargets();
            }
            running = false;
            if (rerun) {
                rerun = false;
                run();
            }
        }
    };

    const schedule = (changedPath?: string, event: 'add' | 'change' | 'unlink' = 'change') => {
        if (fatalWatcherError) return;
        if (changedPath) {
            const normalizedChangedPath = path.resolve(changedPath);
            const isTransformConfig =
                /(?:^|[/\\])(?:svelte|vite)\.config\.[cm]?[jt]s$/i.test(changedPath) ||
                (!!opts.config && normalizedChangedPath === path.resolve(opts.config));
            const isPackageManifest = path.basename(changedPath).toLowerCase() === 'package.json';
            if (changedPath.toLowerCase().endsWith('.json') || isTransformConfig) {
                watchGraphDirty = true;
            }
            if (isTransformConfig || isPackageManifest) configCacheDirty = true;

            if (changedPath.toLowerCase().endsWith('.svelte')) {
                if (event === 'unlink') {
                    moduleGraphSignatures.delete(normalizedChangedPath);
                    workspaceIndexDirty = true;
                } else {
                    const nextSignature = moduleGraphSignature(changedPath);
                    const previousSignature = moduleGraphSignatures.get(normalizedChangedPath);
                    moduleGraphSignatures.set(normalizedChangedPath, nextSignature);
                    // Svelte <script> imports participate in reachability just like a TS barrel.
                    // Template/style-only edits retain the signature and remain incremental.
                    if (event === 'add' || previousSignature !== nextSignature) {
                        workspaceIndexDirty = true;
                    }
                }
            } else if (TS_OR_JS_SOURCE_REGEX.test(changedPath)) {
                if (event === 'unlink') {
                    moduleGraphSignatures.delete(normalizedChangedPath);
                    workspaceIndexDirty = true;
                } else {
                    const nextSignature = moduleGraphSignature(changedPath);
                    const previousSignature = moduleGraphSignatures.get(normalizedChangedPath);
                    moduleGraphSignatures.set(normalizedChangedPath, nextSignature);
                    // The first observed edit is conservatively structural; after that, ordinary
                    // leaf edits whose import/re-export graph is unchanged stay incremental.
                    if (event === 'add' || previousSignature !== nextSignature) {
                        workspaceIndexDirty = true;
                    }
                }
            }
        }
        clearTimeout(pending);
        pending = setTimeout(run, 1000);
    };

    const scheduleUnlink = (changedPath: string) => {
        schedule(changedPath, 'unlink');
        // Chokidar drops a polling watch after unlink. Re-adding an authoritative graph target
        // keeps config/package deletion followed by recreation observable.
        if (explicitTargets.has(path.resolve(changedPath))) watcher.add(changedPath);
    };

    watcher = watch([], {
        ignored: (path, stats) => {
            if (isExplicitTarget(path)) return false;
            if (
                path.includes('node_modules') ||
                path.includes('.git') ||
                (stats?.isFile() &&
                    (!VIRTUAL_WATCH_FILE_REGEX.test(path) || VITE_CONFIG_REGEX.test(path)))
            ) {
                return true;
            }

            if (userIgnored.length !== 0) {
                const workspaceRelative = path.startsWith(opts.workspaceUri.fsPath)
                    ? path.slice(opts.workspaceUri.fsPath.length + 1)
                    : path;
                for (const i of userIgnored) {
                    if (i(workspaceRelative)) {
                        return true;
                    }
                }
            }

            return false;
        },
        ignoreInitial: true,
        // Useful on network filesystems and in constrained CI containers where native watcher
        // handles are unavailable. Native events remain the default.
        usePolling: process.env.SVELTE_CHECK_WATCH_POLLING === '1',
        interval: 100
    })
        .on('add', (changedPath) => schedule(changedPath, 'add'))
        .on('unlink', scheduleUnlink)
        .on('change', (changedPath) => schedule(changedPath, 'change'))
        .on('error', (error) => {
            if (fatalWatcherError) return;
            fatalWatcherError = true;
            clearTimeout(pending);
            writer.failure(error instanceof Error ? error : new Error(String(error)));
            void watcher.close().finally(() => exitAfterFlush(1));
        });
    const watcherReady = new Promise<void>((resolve) => watcher.once('ready', resolve));
    watcher.add([opts.workspaceUri.fsPath, ...explicitTargets]);
    await Promise.all([watcherReady, run()]);
}

// `process.stdout.write` is asynchronous on non-TTY pipes, and `process.exit`
// does not wait for queued writes to drain. Under heavy diagnostic load this
// caused the output to be cut short when using `--output machine-verbose`.
function exitAfterFlush(code: number): void {
    let pending = 2;
    const done = () => {
        if (--pending === 0) process.exit(code);
    };
    process.stdout.write('', done);
    process.stderr.write('', done);
}

parseOptions(async (opts) => {
    const writer = instantiateWriter(opts);
    try {
        const svelteCheckOptions: SvelteCheckOptions = {
            compilerWarnings: opts.compilerWarnings,
            diagnosticSources: opts.diagnosticSources,
            // TODO svelte-check 5: a config file next to the tsconfig or at the root of the workspace should turn off nested config file discovery
            tsconfig: opts.tsconfig,
            configPath: opts.config,
            watch: opts.watch
        };

        // `--tsgo-experimental-api` used to drive tsgo through its in-process API with an
        // overlay of its own, which mis-resolved `.svelte` imports and reported 41 phantom
        // errors on a package the classic engine finds clean. It now means `--tsgo`.
        const useTsGo = opts.tsgo || opts.tsgoExperimental;
        if (opts.tsgoExperimental && !opts.tsgo) {
            console.warn(
                '`--tsgo-experimental-api` is deprecated and now behaves exactly like `--tsgo`.'
            );
        }
        if (useTsGo && !opts.tsconfig) {
            throw new Error('`--tsgo` requires a tsconfig/jsconfig file');
        }

        const runOnce = useTsGo ? runWithTsGo : runWithVirtualFiles;
        const useVirtualFiles = opts.incremental || useTsGo;
        if (useVirtualFiles && opts.watch) {
            await watchWithVirtualFiles(opts, writer, runOnce);
        } else if (useVirtualFiles) {
            const result = await runOnce(opts, writer);
            const exitCode =
                result &&
                result.errorCount === 0 &&
                (!opts.failOnWarnings || result.warningCount === 0)
                    ? 0
                    : 1;
            exitAfterFlush(exitCode);
        } else if (opts.watch) {
            // Wire callbacks that can reference the watcher instance created below
            let watcher: DiagnosticsWatcher;
            svelteCheckOptions.onProjectReload = () => {
                watcher.updateWildcardWatchers();
                watcher.scheduleDiagnostics();
            };
            svelteCheckOptions.onFileSnapshotCreated = (filePath: string) => {
                const dirPath = path.dirname(filePath);
                watcher.addWatchDirectory(dirPath);
            };
            watcher = new DiagnosticsWatcher(
                opts.workspaceUri,
                new SvelteCheck(opts.workspaceUri.fsPath, svelteCheckOptions),
                writer,
                opts.filePathsToIgnore,
                !!opts.tsconfig
            );
        } else {
            const svelteCheck = new SvelteCheck(opts.workspaceUri.fsPath, svelteCheckOptions);

            if (!opts.tsconfig) {
                await openAllDocuments(opts.workspaceUri, opts.filePathsToIgnore, svelteCheck);
            }
            const result = await getDiagnostics(opts.workspaceUri, writer, svelteCheck);
            const exitCode =
                result &&
                result.errorCount === 0 &&
                (!opts.failOnWarnings || result.warningCount === 0)
                    ? 0
                    : 1;
            exitAfterFlush(exitCode);
        }
    } catch (err) {
        writer.failure(err instanceof Error ? err : new Error(String(err)));
        exitAfterFlush(1);
    }
});
