/**
 * Pull-diagnostic typing-burst benchmark.
 *
 * A request is issued after every keystroke, just as a pull-diagnostic editor does. That is
 * essential: the tsgo quiescence budget is only on the pull path, and a benchmark which waits
 * until the final edit (or uses legacy publishDiagnostics) cannot measure redundant native
 * checks at all.
 *
 * Usage:
 *   node bench/spikes/typing-burst.mjs --project <dir> --file <rel.svelte> \
 *     [--package @typescript/native-preview] [--debounce 150] [--gap 60] [--rounds 20]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ProcessTreeMonitor,
    formatBytes,
    getTsGoStats,
    now,
    shutdownLanguageServer,
    startLanguageServer,
    summarize,
    uri
} from '../perf-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const DEFAULT_SERVER = path.join(REPO, 'packages/language-server/bin/server.js');

function findFile(root) {
    const skip = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build']);
    const walk = (directory, depth) => {
        if (depth > 8) return null;
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && !skip.has(entry.name)) {
                    const found = walk(full, depth + 1);
                    if (found) return found;
                }
            } else if (entry.name.endsWith('.svelte') && fs.statSync(full).size > 1000) {
                return full;
            }
        }
        return null;
    };
    return walk(path.join(root, 'src'), 0);
}

/** Put a statement at the start of an instance/module script, where TypeScript must check it. */
function injectIntoScript(source, text, filePath) {
    const opening = /<script(?:\s[^>]*)?>/.exec(source);
    if (!opening) throw new Error(`benchmark file has no <script> block: ${filePath}`);
    const offset = opening.index + opening[0].length;
    return source.slice(0, offset) + `\n${text}\n` + source.slice(offset);
}

function validateReport(report, marker, context) {
    if (!report || report.kind !== 'full' || !Array.isArray(report.items)) {
        throw new Error(`${context} returned malformed diagnostics: ${JSON.stringify(report)}`);
    }
    if (!report.items.some((diagnostic) => String(diagnostic.message ?? '').includes(marker))) {
        throw new Error(`${context} completed without the ${marker} diagnostic`);
    }
}

export async function runBurstTrial({
    project,
    file,
    packageName = '@typescript/native-preview',
    debounceMs = 150,
    gapMs = 60,
    rounds = 20,
    burst = 6,
    timeoutMs = 180_000,
    settleMs = 75,
    serverPath = DEFAULT_SERVER
}) {
    if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error('rounds must be positive');
    if (!Number.isSafeInteger(burst) || burst < 2) throw new Error('burst must be at least 2');
    if (![debounceMs, gapMs, settleMs].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error('debounce, gap and settle must be non-negative numbers');
    }
    const absoluteProject = path.resolve(project);
    const absoluteFile = file ? path.resolve(absoluteProject, file) : findFile(absoluteProject);
    if (!absoluteFile || !fs.existsSync(absoluteFile)) {
        throw new Error(`benchmark file not found: ${absoluteFile ?? '(auto-discovery failed)'}`);
    }
    const original = fs.readFileSync(absoluteFile, 'utf8');
    const fileUri = uri(absoluteFile);
    const { client, engine } = await startLanguageServer({
        serverPath,
        project: absoluteProject,
        useTsGo: true,
        packageName,
        debounceMs
    });

    let version = 1;
    let monitor;
    try {
        const warmMarker = '__burst_warmup__';
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: fileUri,
                languageId: 'svelte',
                version,
                text: injectIntoScript(original, `${warmMarker};`, absoluteFile)
            }
        });
        const warmReport = await client.request(
            'textDocument/diagnostic',
            { textDocument: { uri: fileUri } },
            timeoutMs
        );
        validateReport(warmReport, warmMarker, 'warmup');

        const before = await getTsGoStats(client);
        monitor = new ProcessTreeMonitor(client.proc.pid);
        monitor.start();

        const latencies = [];
        const roundChecks = [];
        for (let round = 0; round < rounds; round++) {
            const checksBefore = (await getTsGoStats(client)).projectChecks;
            const pulls = [];
            let finalMarker;
            let finalStarted;
            for (let key = 0; key < burst; key++) {
                const marker = `__burst_${round}_${key}__`;
                version++;
                const final = key === burst - 1;
                if (final) {
                    finalMarker = marker;
                    finalStarted = now();
                }
                client.notify('textDocument/didChange', {
                    textDocument: { uri: fileUri, version },
                    contentChanges: [
                        { text: injectIntoScript(original, `${marker};`, absoluteFile) }
                    ]
                });
                const promise = client.request(
                    'textDocument/diagnostic',
                    { textDocument: { uri: fileUri } },
                    timeoutMs
                );
                pulls.push({ marker, final, promise });
                if (!final) await new Promise((resolve) => setTimeout(resolve, gapMs));
            }

            const finalReport = await pulls.at(-1).promise;
            validateReport(finalReport, finalMarker, `round ${round + 1}`);
            latencies.push(now() - finalStarted);

            const settled = await Promise.allSettled(pulls.map((pull) => pull.promise));
            const rejected = settled.find((result) => result.status === 'rejected');
            if (rejected) throw rejected.reason;
            for (const result of settled) {
                if (
                    !result.value ||
                    !['full', 'unchanged'].includes(result.value.kind) ||
                    (result.value.kind === 'full' && !Array.isArray(result.value.items))
                ) {
                    throw new Error(
                        `round ${round + 1} returned malformed superseded diagnostics: ${JSON.stringify(result.value)}`
                    );
                }
            }
            const checksAfter = (await getTsGoStats(client)).projectChecks;
            roundChecks.push(checksAfter - checksBefore);
            if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
        }

        const after = await getTsGoStats(client);
        const resources = monitor.stop();
        monitor = undefined;
        client.notify('textDocument/didClose', { textDocument: { uri: fileUri } });

        return {
            engine,
            project: absoluteProject,
            file: path.relative(absoluteProject, absoluteFile),
            cacheState:
                before.transformedShadows === 0
                    ? before.reusedShadows > 0
                        ? 'warm'
                        : 'empty'
                    : before.reusedShadows > 0
                      ? 'mixed'
                      : 'cold-or-invalidated',
            debounceMs,
            gapMs,
            burst,
            rounds,
            latenciesMs: latencies.map((value) => +value.toFixed(1)),
            latency: summarize(latencies),
            nativeChecks: after.projectChecks - before.projectChecks,
            nativeChecksPerRound: roundChecks,
            cancellations: after.cancellations - before.cancellations,
            cpuMs: resources.cpuMs,
            peakRssBytes: resources.peakRssBytes,
            maxProcessCount: resources.maxProcessCount,
            phaseTimings: after.phaseTimings
        };
    } finally {
        if (monitor) {
            try {
                monitor.stop();
            } catch {}
        }
        await shutdownLanguageServer(client);
    }
}

function parseArgs(argv) {
    const options = {
        project: process.env.SVELTE_LS_BENCH_PROJECT ?? '',
        file: undefined,
        packageName: process.env.SVELTE_LS_TSGO_PACKAGE ?? '@typescript/native-preview',
        debounceMs: 150,
        gapMs: 60,
        rounds: 20,
        burst: 6,
        json: undefined
    };
    for (let index = 2; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--') continue;
        const next = () => {
            const value = argv[++index];
            if (value === undefined) throw new Error(`${argument} requires a value`);
            return value;
        };
        if (argument === '--project') options.project = path.resolve(next());
        else if (argument === '--file') options.file = next();
        else if (argument === '--package') options.packageName = next();
        else if (argument === '--debounce') options.debounceMs = Number(next());
        else if (argument === '--gap') options.gapMs = Number(next());
        else if (argument === '--rounds') options.rounds = Number(next());
        else if (argument === '--burst') options.burst = Number(next());
        else if (argument === '--json') options.json = next();
        else if (argument === '--smoke') options.rounds = 2;
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (!options.project) throw new Error('--project is required');
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.includes('--help')) {
            console.log(
                'Usage: node bench/spikes/typing-burst.mjs --project <dir> [--file rel.svelte] ' +
                    '[--package name] [--debounce 150] [--gap 60] [--rounds 20] ' +
                    '[--burst 6] [--json file|-] [--smoke]'
            );
            process.exit(0);
        }
        const options = parseArgs(process.argv);
        const result = await runBurstTrial(options);
        console.log(
            `${result.engine.packageName}@${result.engine.version}  ` +
                `debounce=${result.debounceMs}ms gap=${result.gapMs}ms ` +
                `rounds=${result.rounds} burst=${result.burst}`
        );
        console.log(
            `last key -> diagnostics: p50 ${result.latency.p50}ms, p95 ${result.latency.p95}ms; ` +
                `${result.nativeChecks} native checks; CPU ${result.cpuMs}ms; ` +
                `peak RSS ${formatBytes(result.peakRssBytes)}; cache ${result.cacheState}`
        );
        if (options.json) {
            const json = `${JSON.stringify(result, null, 2)}\n`;
            if (options.json === '-') process.stdout.write(json);
            else fs.writeFileSync(path.resolve(options.json), json, 'utf8');
        }
    } catch (error) {
        console.error(error instanceof Error ? error.stack : error);
        process.exitCode = 1;
    }
}
