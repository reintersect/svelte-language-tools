import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    BatchOverlayCreationTimings,
    BatchMaterialiseResult,
    FileDiagnostics,
    GeneratedDiagnostic,
    SvelteCheck,
    TsGoBatchOverlay
} from 'svelte-language-server';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { URI } from 'vscode-uri';
import { ParsedDiagnostic, parseDiagnostics } from './incremental';
import { SvelteCheckCliOptions } from './options';

/**
 * Run a whole-project check through tsgo, using the same overlay the language server uses.
 *
 * The two earlier tsgo modes each built an overlay of their own, and each got module resolution
 * wrong in a way that reports nothing: a `.svelte` import that fails to resolve is absorbed by
 * svelte's ambient `declare module '*.svelte'`, so instead of TS2307 you get a component typed
 * `SvelteComponent<Record<string, any>, any, any>` and a scattering of errors that look like
 * inference failures. Measured against the classic engine on one real package: 0 errors from the
 * oracle, 41 from `--tsgo-experimental-api`, 100 from `--tsgo`. Sharing one overlay means there
 * is one place for that to be right.
 */
export async function runTsGoCheck(opts: SvelteCheckCliOptions): Promise<FileDiagnostics[]> {
    const checkStarted = Date.now();
    if (!opts.tsconfig) {
        throw new Error('`--tsgo` requires a tsconfig/jsconfig file');
    }

    if (opts.clearConfigCache) {
        TsGoBatchOverlay.invalidateConfigCache();
    } else if (opts.clearTsGoWorkspaceIndex) {
        TsGoBatchOverlay.invalidateWorkspaceIndex();
    }
    const createStarted = Date.now();
    const overlay = await TsGoBatchOverlay.create({
        workspacePath: opts.workspaceUri.fsPath,
        tsconfigPath: opts.tsconfig,
        configPath: opts.config,
        quiet: true
    });
    if (!overlay) {
        throw new Error(
            'svelte-check --tsgo could not find a tsgo binary. Install @reintersect/effect-tsgo, ' +
                '@typescript/native, or @typescript/native-preview in the workspace.'
        );
    }

    const wantsTypeScript = opts.diagnosticSources.includes('js');
    const createDurationMs = Date.now() - createStarted;
    const materialise = await overlay.materialise();

    // Run tsgo first even when only Svelte/CSS diagnostics were asked for: its file list is how
    // we learn which components are actually in the program, and that is the set the classic
    // engine reports on. Deriving it from the tsconfig's roots instead misses every component
    // reached across a package boundary.
    const nativeStarted = Date.now();
    const { diagnostics: parsed, files } = await runTsGo(overlay, opts, wantsTypeScript);
    const nativeDurationMs = Date.now() - nativeStarted;
    const mappingStarted = Date.now();
    const remappedDiagnostics = parsed.map((original) => ({
        original,
        remapped: remapOverlayConfigDiagnostic(original, overlay)
    }));
    // Parsing the user config gives us its exact source span, while native tsgo reports the same
    // inherited error against the generated overlay (which remaps to an imprecise 0:0). Keep the
    // parser copy when both engines agree on code/message/severity. This only removes the adapter
    // duplicate; the overlay continues to extend the user's config unchanged.
    const nativeConfirmedInvalidConfig = remappedDiagnostics.some(
        ({ remapped }) =>
            isConfigurationDiagnostic(remapped) && overlay.matchesBaseConfigurationError(remapped)
    );
    const deduplicatedDiagnostics = remappedDiagnostics
        .filter(
            ({ original, remapped }) =>
                // Only discard the copy whose real path was a generated overlay config. Keep a
                // native diagnostic already attributed to the user tsconfig: unlike the parser
                // fallback, it carries the exact value span.
                original.filePath === remapped.filePath ||
                remapped.filePath !== null ||
                !overlay.matchesBaseConfigurationDiagnostic(remapped)
        )
        .map(({ remapped }) => remapped);
    // Classic TypeScript does not construct a source program after a native-confirmed fatal
    // configuration error. Do not let the overlay's explicit shadow roots manufacture one.
    const program = nativeConfirmedInvalidConfig
        ? { all: [] as string[], svelte: [] as string[] }
        : overlay.mapProgramFiles(files);
    const diagnosticsForMapping = wantsTypeScript
        ? deduplicatedDiagnostics
        : deduplicatedDiagnostics.filter(isConfigurationDiagnostic);
    // Materialisation/parser failures are owned by the overlay rather than by the native
    // TypeScript diagnostic source. mapDiagnostics merges those even when JS diagnostics are
    // disabled, so `--diagnostic-sources css` cannot accidentally turn a broken component into
    // a clean run.
    const tsDiagnostics = await overlay.mapDiagnostics(
        diagnosticsForMapping,
        opts.tsconfig,
        program.all
    );
    const mappingDurationMs = Date.now() - mappingStarted;

    const svelteFiles = nativeConfirmedInvalidConfig
        ? []
        : program.svelte.length
          ? program.svelte
          : overlay.listProjectSvelteFiles();
    const svelteStarted = Date.now();
    const svelteDiagnostics = await getSvelteAndCssDiagnostics(opts, svelteFiles);
    const svelteDurationMs = Date.now() - svelteStarted;
    const result = merge(
        program.all.length ? program.all : svelteFiles,
        svelteDiagnostics,
        tsDiagnostics
    );

    emitTsGoStats({
        schemaVersion: 1,
        engine: {
            packageName: overlay.engine.packageName,
            version: overlay.engine.version
        },
        incremental: opts.incremental,
        cacheState:
            materialise.transformedCount === 0 && materialise.writtenCount === 0
                ? 'warm'
                : materialise.reusedCount === 0
                  ? 'cold-or-invalidated'
                  : 'mixed',
        materialise,
        phases: {
            createOverlayMs: createDurationMs,
            createOverlay: overlay.creationTimings,
            nativeCheckMs: nativeDurationMs,
            mapDiagnosticsMs: mappingDurationMs,
            svelteAndCssMs: svelteDurationMs,
            totalMs: Date.now() - checkStarted
        },
        program: {
            nativeFileCount: files.length,
            sourceFileCount: program.all.length,
            svelteFileCount: svelteFiles.length
        },
        diagnostics: {
            nativeCount: parsed.length,
            mappedTypeScriptCount: tsDiagnostics.reduce(
                (count, file) => count + file.diagnostics.length,
                0
            ),
            svelteAndCssCount: svelteDiagnostics.reduce(
                (count, file) => count + file.diagnostics.length,
                0
            ),
            outputCount: result.reduce((count, file) => count + file.diagnostics.length, 0)
        }
    });

    return result;
}

interface TsGoCheckStats {
    schemaVersion: 1;
    engine: { packageName: string; version: string };
    incremental: boolean;
    cacheState: 'warm' | 'cold-or-invalidated' | 'mixed';
    materialise: BatchMaterialiseResult;
    phases: {
        createOverlayMs: number;
        createOverlay: BatchOverlayCreationTimings;
        nativeCheckMs: number;
        mapDiagnosticsMs: number;
        svelteAndCssMs: number;
        totalMs: number;
    };
    program: {
        nativeFileCount: number;
        sourceFileCount: number;
        svelteFileCount: number;
    };
    diagnostics: {
        nativeCount: number;
        mappedTypeScriptCount: number;
        svelteAndCssCount: number;
        outputCount: number;
    };
}

/**
 * Opt-in machine-readable performance counters. Machine protocol records own stdout, so the
 * console form deliberately uses stderr; a path gets one stable JSON document for automation.
 */
function emitTsGoStats(stats: TsGoCheckStats): void {
    const destination = process.env.SVELTE_LS_TSGO_STATS;
    if (!destination) {
        return;
    }
    const json = JSON.stringify(stats);
    if (destination === '1' || destination.toLowerCase() === 'stderr') {
        process.stderr.write(`[svelte-check:tsgo-stats] ${json}\n`);
        return;
    }

    const filePath = path.resolve(destination);
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(stats, null, 2)}\n`, 'utf8');
    } catch (error) {
        throw new Error(
            `could not write tsgo stats to ${filePath}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

const diagnosticHeader = /^((.+):(\d+):(\d+) - )?(error|warning|suggestion|message) TS(\d+): /;
const diagnosticSummary = /^(?:Found \d+ errors?|Errors\s+Files?)\b/i;
// eslint-disable-next-line no-control-regex
const ansiEscape = /\x1b\[[0-9;]*m/g;

interface NativeOutputParseResult {
    diagnostics: ParsedDiagnostic[];
    files: string[];
    terminalErrorCount?: number;
    outputTail: string;
}

/**
 * Incrementally parses one compiler output stream without joining arbitrary transport chunks.
 * A diagnostic block is retained only until the next header/listed file/summary, so huge
 * `--listFiles` output does not require a second full-output copy after the child closes.
 */
class NativeCompilerStreamParser {
    private pending = '';
    private block: string[] = [];
    private blockBytes = 0;
    private readonly diagnostics: ParsedDiagnostic[] = [];
    private readonly files: string[] = [];
    private readonly seenFiles = new Set<string>();
    private tail = '';
    private inSummaryTable = false;
    private terminalErrorCount: number | undefined;

    constructor(private readonly baseDir: string) {}

    push(chunk: string): void {
        this.pending += chunk;
        if (this.pending.length > 8 * 1024 * 1024 && !this.pending.includes('\n')) {
            throw new Error('native compiler emitted an output line larger than 8 MiB');
        }
        for (;;) {
            const newline = this.pending.indexOf('\n');
            if (newline < 0) break;
            let line = this.pending.slice(0, newline);
            this.pending = this.pending.slice(newline + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            this.acceptLine(line);
        }
    }

    finish(): {
        diagnostics: ParsedDiagnostic[];
        files: string[];
        terminalErrorCount?: number;
        tail: string;
    } {
        if (this.pending) {
            const line = this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending;
            this.pending = '';
            this.acceptLine(line);
        }
        this.flushDiagnostic();
        return {
            diagnostics: this.diagnostics,
            files: this.files,
            terminalErrorCount: this.terminalErrorCount,
            tail: this.tail.trimEnd()
        };
    }

    outputTail(): string {
        return `${this.tail}${this.pending}`.slice(-64 * 1024).trimEnd();
    }

    private acceptLine(raw: string): void {
        const line = raw.replace(ansiEscape, '');
        const trimmed = line.trim();
        const isHeader = diagnosticHeader.test(trimmed);
        const listed = parseListedFiles(line)[0];
        const isSummary = diagnosticSummary.test(trimmed);
        const terminalSummary = /^Found (\d+) errors?\b/i.exec(trimmed);
        const isSummaryRow = this.inSummaryTable && /^\d+\s{2,}.+:\d+$/.test(trimmed);
        if (isHeader || listed || isSummary) {
            this.flushDiagnostic();
        }
        if (isHeader || listed) {
            this.inSummaryTable = false;
        } else if (isSummary) {
            this.inSummaryTable = /^Errors\s+Files?\b/i.test(trimmed);
        }
        if (isHeader) {
            this.block = [line];
            this.blockBytes = Buffer.byteLength(line);
        } else if (listed) {
            if (this.terminalErrorCount !== undefined) {
                throw new Error(
                    `native compiler emitted a program file after its terminal summary: ${listed}`
                );
            }
            if (!this.seenFiles.has(listed)) {
                this.seenFiles.add(listed);
                this.files.push(listed);
            }
        } else if (this.block.length) {
            this.block.push(line);
            this.blockBytes += Buffer.byteLength(line) + 1;
            if (this.blockBytes > 16 * 1024 * 1024) {
                throw new Error('native compiler emitted a diagnostic block larger than 16 MiB');
            }
        } else if (trimmed && !isSummary && !isSummaryRow) {
            throw new Error(`native compiler emitted an unrecognized output line: ${trimmed}`);
        }
        if (terminalSummary) {
            const count = Number(terminalSummary[1]);
            if (this.terminalErrorCount !== undefined && this.terminalErrorCount !== count) {
                throw new Error(
                    `native compiler emitted conflicting terminal summaries: ${this.terminalErrorCount} and ${count}`
                );
            }
            this.terminalErrorCount = count;
        }
        this.tail = `${this.tail}${line}\n`.slice(-64 * 1024);
    }

    private flushDiagnostic(): void {
        if (!this.block.length) return;
        const parsed = parseDiagnostics(this.block.join('\n'), this.baseDir);
        if (parsed.length !== 1) {
            throw new Error(`could not parse a complete native diagnostic block: ${this.block[0]}`);
        }
        this.diagnostics.push(parsed[0]);
        this.block = [];
        this.blockBytes = 0;
    }
}

/**
 * stdout and stderr are independent byte streams; their `data` events have no shared ordering
 * guarantee. Parse each independently, then merge in the same stdout-before-stderr order the old
 * bounded parser used, so an interleaved stderr chunk cannot split a multiline stdout chain.
 */
export class NativeCompilerOutputCollector {
    private readonly stdout: NativeCompilerStreamParser;
    private readonly stderr: NativeCompilerStreamParser;

    constructor(baseDir: string) {
        this.stdout = new NativeCompilerStreamParser(baseDir);
        this.stderr = new NativeCompilerStreamParser(baseDir);
    }

    push(target: 'stdout' | 'stderr', chunk: string): void {
        (target === 'stdout' ? this.stdout : this.stderr).push(chunk);
    }

    outputTail(): string {
        return [this.stdout.outputTail(), this.stderr.outputTail()].filter(Boolean).join('\n');
    }

    finish(): NativeOutputParseResult {
        const stdout = this.stdout.finish();
        const stderr = this.stderr.finish();
        const seen = new Set<string>();
        const files = [...stdout.files, ...stderr.files].filter((file) => {
            if (seen.has(file)) return false;
            seen.add(file);
            return true;
        });
        const terminalCounts = [stdout.terminalErrorCount, stderr.terminalErrorCount].filter(
            (count): count is number => count !== undefined
        );
        if (new Set(terminalCounts).size > 1) {
            throw new Error(
                `native compiler streams emitted conflicting terminal summaries: ${terminalCounts.join(' and ')}`
            );
        }
        return {
            diagnostics: [...stdout.diagnostics, ...stderr.diagnostics],
            files,
            terminalErrorCount: terminalCounts[0],
            outputTail: [stdout.tail, stderr.tail].filter(Boolean).join('\n')
        };
    }
}

/**
 * Spawn tsgo over the overlay tsconfig and parse what it prints.
 *
 * A whole-project run is deliberate rather than a per-file loop over LSP: tsgo never sends
 * `publishDiagnostics` and does not implement `workspace/diagnostic`, so the LSP route costs one
 * round trip per file. `tsgo -p` checks a 300-component project in a few seconds.
 */
async function runTsGo(
    overlay: TsGoBatchOverlay,
    opts: SvelteCheckCliOptions,
    wantsTypeScript: boolean
): Promise<{ diagnostics: GeneratedDiagnostic[]; files: string[] }> {
    const cwd = opts.workspaceUri.fsPath;
    const compilerArgs = [
        '-p',
        overlay.overlayTsconfigPath,
        '--pretty',
        'true',
        '--noErrorTruncation',
        // Svelte/CSS-only runs need the program membership but not the type checker. tsgo's
        // listFilesOnly mode stops after program construction, which avoids paying for a full
        // native semantic check whose diagnostics would immediately be discarded.
        wantsTypeScript ? '--listFiles' : '--listFilesOnly'
    ];

    if (opts.incremental && wantsTypeScript) {
        compilerArgs.push('--incremental');
        compilerArgs.push('--tsBuildInfoFile', path.join(overlay.overlayPath, 'tsbuildinfo.json'));
    }
    const args = [...overlay.engine.argsPrefix, ...compilerArgs];

    const { parsed, exitCode } = await new Promise<{
        parsed: NativeOutputParseResult;
        exitCode: number;
    }>((resolve, reject) => {
        const proc = spawn(overlay.engine.command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env
        });
        const collector = new NativeCompilerOutputCollector(cwd);
        let outputBytes = 0;
        let terminalError: Error | undefined;
        let settled = false;
        let forceKill: NodeJS.Timeout | undefined;
        const outputLimit = 64 * 1024 * 1024;
        const configuredTimeout = Number(process.env.SVELTE_LS_TSGO_TIMEOUT_MS);
        const timeoutMs =
            Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? configuredTimeout
                : 5 * 60_000;
        const clearTimers = () => {
            clearTimeout(timeout);
            if (forceKill) clearTimeout(forceKill);
        };
        const rejectOnce = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimers();
            reject(error);
        };
        const rejectTerminalError = () => {
            const error = terminalError ?? new Error('native compiler terminated unexpectedly');
            rejectOnce(
                new Error(`${error.message}${formatCompilerOutput(collector.outputTail())}`)
            );
        };
        const terminate = (error: Error) => {
            if (terminalError || settled) return;
            terminalError = error;
            try {
                proc.kill('SIGTERM');
            } catch {
                // The close/error path below is still authoritative when the process already died.
            }
            // SIGTERM is catchable. Never let a broken engine defeat the checker timeout or a
            // parser/output-limit failure by retaining its pipes forever.
            forceKill = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Reject below even if the OS already reaped the child.
                }
                proc.stdout.destroy();
                proc.stderr.destroy();
                proc.unref();
                rejectTerminalError();
            }, 1_000);
        };
        const timeout = setTimeout(
            () =>
                terminate(
                    new Error(
                        `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) timed out after ${timeoutMs}ms`
                    )
                ),
            timeoutMs
        );
        const collect = (target: 'stdout' | 'stderr', data: string) => {
            if (terminalError) {
                return;
            }
            outputBytes += Buffer.byteLength(data);
            if (outputBytes > outputLimit) {
                terminate(
                    new Error(
                        `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) produced more than ${outputLimit} bytes of output`
                    )
                );
                return;
            }
            try {
                collector.push(target, data);
            } catch (error) {
                terminate(
                    error instanceof Error
                        ? error
                        : new Error(`could not parse native compiler output: ${String(error)}`)
                );
            }
        };
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');
        proc.stdout.on('data', (data: string) => collect('stdout', data));
        proc.stderr.on('data', (data: string) => collect('stderr', data));
        proc.stdout.on('error', (error) => {
            terminate(error);
        });
        proc.stderr.on('error', (error) => {
            terminate(error);
        });
        proc.on('error', (error) => {
            if (terminalError) rejectTerminalError();
            else rejectOnce(error);
        });
        proc.on('close', (code, signal) => {
            if (settled) return;
            clearTimers();
            const outputTail = collector.outputTail();
            if (terminalError) {
                rejectOnce(
                    new Error(`${terminalError.message}${formatCompilerOutput(outputTail)}`)
                );
                return;
            }
            if (signal) {
                rejectOnce(
                    new Error(
                        `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) was terminated by ${signal}${formatCompilerOutput(outputTail)}`
                    )
                );
                return;
            }
            try {
                const completed = collector.finish();
                settled = true;
                resolve({ parsed: completed, exitCode: code ?? -1 });
            } catch (error) {
                rejectOnce(
                    new Error(
                        `could not parse tsgo (${overlay.engine.packageName}@${overlay.engine.version}) output: ${
                            error instanceof Error ? error.message : String(error)
                        }${formatCompilerOutput(outputTail)}`
                    )
                );
            }
        });
    });

    const preservePathSpelling = createWorkspacePathSpellingMapper(cwd);
    const diagnostics = parsed.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        filePath: diagnostic.filePath ? preservePathSpelling(diagnostic.filePath) : null,
        relatedInformation: diagnostic.relatedInformation?.map((related) => ({
            ...related,
            filePath: preservePathSpelling(related.filePath)
        }))
    }));
    const files = parsed.files.map(preservePathSpelling);
    const errorCount = diagnostics.filter(
        (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error
    ).length;
    if (![0, 1, 2].includes(exitCode)) {
        throw new Error(
            `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) exited with invalid status ${exitCode}${formatCompilerOutput(parsed.outputTail)}`
        );
    }
    if (exitCode !== 0 && errorCount === 0) {
        throw new Error(
            `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) exited with code ${exitCode} without an error diagnostic${formatCompilerOutput(parsed.outputTail)}`
        );
    }
    if (exitCode !== 0 && parsed.terminalErrorCount === undefined) {
        throw new Error(
            `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) exited with code ${exitCode} before emitting its terminal error summary${formatCompilerOutput(parsed.outputTail)}`
        );
    }
    if (parsed.terminalErrorCount !== undefined && parsed.terminalErrorCount !== errorCount) {
        throw new Error(
            `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) terminal summary reported ${parsed.terminalErrorCount} errors but ${errorCount} complete error diagnostics were parsed${formatCompilerOutput(parsed.outputTail)}`
        );
    }
    if (
        exitCode === 0 &&
        diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)
    ) {
        throw new Error(
            `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) exited successfully after reporting errors${formatCompilerOutput(parsed.outputTail)}`
        );
    }
    if (files.length === 0) {
        throw new Error(
            `tsgo (${overlay.engine.packageName}@${overlay.engine.version}) did not produce a non-empty program file list${formatCompilerOutput(parsed.outputTail)}`
        );
    }

    return { diagnostics, files };
}

/**
 * macOS resolves `/var` to `/private/var` in a child's cwd, and symlinked workspaces have the
 * same property on every platform. Keep the user's workspace spelling for files below that
 * physical root so diagnostics and source↔shadow indexes still meet on the same path.
 */
function createWorkspacePathSpellingMapper(workspacePath: string): (filePath: string) => string {
    let physicalWorkspace: string;
    try {
        physicalWorkspace = fs.realpathSync(workspacePath);
    } catch {
        return (filePath) => filePath;
    }
    if (path.normalize(physicalWorkspace) === path.normalize(workspacePath)) {
        return (filePath) => filePath;
    }
    return (filePath) => {
        const relative = path.relative(physicalWorkspace, filePath);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
            return path.join(workspacePath, relative);
        }
        return filePath;
    };
}

function formatCompilerOutput(output: string): string {
    const clean = output.trim();
    if (!clean) {
        return '';
    }
    const lines = clean.split(/\r?\n/);
    const tail = lines.slice(-20).join('\n');
    return `:\n${tail}`;
}

/**
 * Pull the `--listFiles` paths out of the compiler's output.
 *
 * They are interleaved with the diagnostics rather than separated, so the discriminator is the
 * shape of the line: an absolute path on its own, with no leading whitespace. Diagnostic headers
 * always carry a ` - error TS…` or ` - warning TS…`, source-context lines are indented, and the
 * trailing summary is a sentence.
 */
export function parseListedFiles(output: string): string[] {
    const files: string[] = [];
    const seen = new Set<string>();
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.replace(ansi, '');
        if (
            (!path.isAbsolute(line) && !path.win32.isAbsolute(line)) ||
            / - (error|warning|suggestion|message) /.test(line) ||
            seen.has(line)
        ) {
            continue;
        }
        seen.add(line);
        files.push(line);
    }
    return files;
}

/**
 * Overlay configs are implementation details. If tsgo attributes an inherited/configuration
 * diagnostic to one of them, report it against the config the user supplied and mark the exact
 * position unknown instead of pointing into a generated file under node_modules/.cache.
 */
function remapOverlayConfigDiagnostic(
    diagnostic: GeneratedDiagnostic,
    overlay: TsGoBatchOverlay
): GeneratedDiagnostic {
    if (!diagnostic.filePath) {
        return diagnostic;
    }
    const filePath = path.normalize(diagnostic.filePath);
    const overlayPath = path.normalize(overlay.overlayPath);
    const relative = path.relative(overlayPath, filePath);
    const isOverlayConfig =
        filePath === path.normalize(overlay.overlayTsconfigPath) ||
        (((!relative.startsWith('..') && !path.isAbsolute(relative)) || relative === '') &&
            /(?:^|[/\\])tsconfig(?:\.ts-support)?\.json$/i.test(filePath)) ||
        (filePath.replace(/\\/g, '/').includes('/node_modules/.cache/svelte-lsp/') &&
            /(?:^|[/\\])tsconfig(?:\.ts-support)?\.json$/i.test(filePath));
    if (!isOverlayConfig) {
        return diagnostic;
    }
    return {
        ...diagnostic,
        filePath: null,
        line: 0,
        character: 0,
        length: 1,
        endLine: undefined,
        endCharacter: undefined
    };
}

function isConfigurationDiagnostic(diagnostic: GeneratedDiagnostic): boolean {
    return diagnostic.filePath === null || /\.json$/i.test(diagnostic.filePath);
}

/**
 * Svelte compiler warnings and CSS diagnostics, which tsgo knows nothing about.
 *
 * Deliberately constructed without a `tsconfig`: passing one makes `SvelteCheck` register the JS
 * TypeScript plugin and load the entire program a second time, which is the single most
 * expensive thing svelte-check does and is exactly the work tsgo is here to replace.
 */
async function getSvelteAndCssDiagnostics(
    opts: SvelteCheckCliOptions,
    svelteFiles: string[]
): Promise<FileDiagnostics[]> {
    const sources = opts.diagnosticSources.filter((source) => source !== 'js');
    if (!svelteFiles.length) {
        return [];
    }

    const svelteCheck = new SvelteCheck(opts.workspaceUri.fsPath, {
        compilerWarnings: opts.compilerWarnings,
        diagnosticSources: sources,
        configPath: opts.config,
        watch: false
    });

    if (!sources.length) {
        return svelteCheck.getConfigLoadDiagnostics(svelteFiles);
    }

    for (const filePath of svelteFiles) {
        try {
            svelteCheck.upsertDocument(
                { uri: URI.file(filePath).toString(), text: fs.readFileSync(filePath, 'utf-8') },
                true
            );
        } catch {
            // Deleted between the scan and now; the TypeScript side will not report it either.
        }
    }

    return svelteCheck.getDiagnostics();
}

/**
 * Fold the two diagnostic streams into one entry per file.
 *
 * Every project Svelte file gets an entry even when it is clean, so the run reports how much it
 * actually checked rather than only what was wrong.
 */
function merge(projectFiles: string[], ...streams: FileDiagnostics[][]): FileDiagnostics[] {
    const byFile = new Map<string, FileDiagnostics>();
    const key = (filePath: string) => path.normalize(filePath);

    for (const filePath of projectFiles) {
        byFile.set(key(filePath), { filePath, text: '', diagnostics: [] });
    }

    for (const stream of streams) {
        for (const entry of stream) {
            const existing = byFile.get(key(entry.filePath));
            if (!existing) {
                byFile.set(key(entry.filePath), { ...entry });
                continue;
            }
            existing.text ||= entry.text;
            // A Svelte parse failure can be observed both by SvelteCheck and while creating the
            // native shadow. Keep multiplicity within either diagnostic provider, but do not
            // print the same fact twice merely because two providers discovered it.
            const prior = new Map(
                existing.diagnostics.map((diagnostic, index) => [
                    diagnosticIdentity(diagnostic),
                    index
                ])
            );
            const additions = [] as typeof entry.diagnostics;
            for (const diagnostic of entry.diagnostics) {
                const priorIndex = prior.get(diagnosticIdentity(diagnostic));
                if (priorIndex === undefined) {
                    additions.push(diagnostic);
                    continue;
                }
                const priorDiagnostic = existing.diagnostics[priorIndex];
                if (
                    !priorDiagnostic.relatedInformation?.length &&
                    diagnostic.relatedInformation?.length
                ) {
                    // The primary fact is identical, but the native compiler retained the
                    // declaration locations. Enrich the existing item instead of either losing
                    // those locations or publishing a duplicate primary diagnostic.
                    existing.diagnostics[priorIndex] = {
                        ...priorDiagnostic,
                        relatedInformation: diagnostic.relatedInformation
                    };
                }
            }
            existing.diagnostics = existing.diagnostics.concat(additions);
        }
    }

    // A file with problems needs its text for the writer to render the source line under each
    // squiggle; a clean one never gets read.
    for (const entry of byFile.values()) {
        if (entry.diagnostics.length && !entry.text) {
            try {
                entry.text = fs.readFileSync(entry.filePath, 'utf-8');
            } catch {
                entry.text = '';
            }
        }
    }

    return Array.from(byFile.values());
}

function diagnosticIdentity(diagnostic: FileDiagnostics['diagnostics'][number]): string {
    if (
        diagnostic.code === -1 ||
        diagnostic.message.includes('https://svelte.dev/e/') ||
        (diagnostic.source === 'svelte' &&
            diagnostic.codeDescription?.href.includes('/compiler-errors#'))
    ) {
        // A failed generated snapshot can map an EOF position one UTF-16 unit past the compiler's
        // authoritative source position. Svelte 4 does not append the modern docs link to its
        // message, but the named compiler diagnostic and the snapshot's synthetic `-1` still
        // share the same text. A compiler stops at the first parser failure, so within one file
        // that stable message is sufficient to recognize the duplicate.
        return JSON.stringify([diagnostic.severity, 'svelte-parser', diagnostic.message]);
    }
    return JSON.stringify([
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message,
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.range.end.line,
        diagnostic.range.end.character
    ]);
}
