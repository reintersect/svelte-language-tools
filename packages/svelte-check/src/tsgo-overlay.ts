import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
    FileDiagnostics,
    GeneratedDiagnostic,
    SvelteCheck,
    TsGoBatchOverlay
} from 'svelte-language-server';
import { URI } from 'vscode-uri';
import { parseDiagnostics } from './incremental';
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
    if (!opts.tsconfig) {
        throw new Error('`--tsgo` requires a tsconfig/jsconfig file');
    }

    const overlay = await TsGoBatchOverlay.create({
        workspacePath: opts.workspaceUri.fsPath,
        tsconfigPath: opts.tsconfig,
        configPath: opts.config
    });
    if (!overlay) {
        throw new Error(
            'svelte-check --tsgo could not find a tsgo binary. Install @reintersect/effect-tsgo ' +
                'or @typescript/native-preview in the workspace.'
        );
    }

    overlay.materialise();

    const wantsTypeScript = opts.diagnosticSources.includes('js');

    // Run tsgo first even when only Svelte/CSS diagnostics were asked for: its file list is how
    // we learn which components are actually in the program, and that is the set the classic
    // engine reports on. Deriving it from the tsconfig's roots instead misses every component
    // reached across a package boundary.
    const { diagnostics: parsed, files } = await runTsGo(overlay, opts);
    const program = overlay.mapProgramFiles(files);
    const tsDiagnostics = wantsTypeScript
        ? overlay.mapDiagnostics(parsed, opts.tsconfig)
        : ([] as FileDiagnostics[]);

    const svelteFiles = program.svelte.length ? program.svelte : overlay.listProjectSvelteFiles();
    const svelteDiagnostics = await getSvelteAndCssDiagnostics(opts, svelteFiles);

    return merge(program.all.length ? program.all : svelteFiles, svelteDiagnostics, tsDiagnostics);
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
    opts: SvelteCheckCliOptions
): Promise<{ diagnostics: GeneratedDiagnostic[]; files: string[] }> {
    const cwd = opts.workspaceUri.fsPath;
    const args = [
        overlay.tsgoPath,
        '-p',
        overlay.overlayTsconfigPath,
        '--pretty',
        'true',
        '--noErrorTruncation',
        // Costs nothing to ask for and is the only way to know what the program actually
        // contains — see the note in runTsGoCheck.
        '--listFiles'
    ];

    if (opts.incremental) {
        args.push('--incremental');
        args.push('--tsBuildInfoFile', path.join(overlay.overlayPath, 'tsbuildinfo.json'));
    }

    const output = await new Promise<string>((resolve, reject) => {
        const proc = spawn(process.execPath, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.setEncoding('utf-8');
        proc.stderr.setEncoding('utf-8');
        proc.stdout.on('data', (data: string) => (stdout += data));
        proc.stderr.on('data', (data: string) => (stderr += data));
        proc.on('error', reject);
        proc.on('close', () => resolve(`${stdout}\n${stderr}`));
    });

    return { diagnostics: parseDiagnostics(output, cwd), files: parseListedFiles(output) };
}

/**
 * Pull the `--listFiles` paths out of the compiler's output.
 *
 * They are interleaved with the diagnostics rather than separated, so the discriminator is the
 * shape of the line: an absolute path on its own, with no leading whitespace. Diagnostic headers
 * always carry a ` - error TS…` or ` - warning TS…`, source-context lines are indented, and the
 * trailing summary is a sentence.
 */
function parseListedFiles(output: string): string[] {
    const files: string[] = [];
    // eslint-disable-next-line no-control-regex
    const ansi = /\x1b\[[0-9;]*m/g;
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.replace(ansi, '');
        if (!path.isAbsolute(line) || / - (error|warning|suggestion|message) /.test(line)) {
            continue;
        }
        files.push(line);
    }
    return files;
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
    if (!sources.length || !svelteFiles.length) {
        return [];
    }

    const svelteCheck = new SvelteCheck(opts.workspaceUri.fsPath, {
        compilerWarnings: opts.compilerWarnings,
        diagnosticSources: sources,
        configPath: opts.config,
        watch: false
    });

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
            existing.diagnostics = existing.diagnostics.concat(entry.diagnostics);
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
