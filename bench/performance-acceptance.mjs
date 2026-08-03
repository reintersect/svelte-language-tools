/**
 * Reproducible tsgo performance acceptance runner.
 *
 * This is intentionally separate from the differential correctness oracles. Run those first:
 * performance numbers are not acceptance evidence while diagnostics or program membership differ.
 *
 * Full Reintersect run:
 *   node bench/performance-acceptance.mjs \
 *     --project ../reintersect/apps/dashboard --file src/lib/components/composer/Composer.svelte \
 *     --tsconfig tsconfig.json --json bench/results/reintersect-performance.json
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BATCH_MATERIALISE_PHASES,
    BATCH_CREATION_PHASES,
    ProcessTreeMonitor,
    formatBytes,
    getTsGoStats,
    now,
    readProcessTree,
    shutdownLanguageServer,
    snapshotShadowMtimes,
    startLanguageServer,
    summarize,
    summarizeBatchMaterialiseResults,
    summarizeBatchOverlayCreationTimings,
    uri,
    validateCheckerStats
} from './perf-utils.mjs';
import { runBurstTrial } from './spikes/typing-burst.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');
const CHECKER = path.join(REPO, 'packages/svelte-check/bin/svelte-check');
const PLUGIN_SOURCE = path.join(
    REPO,
    'packages/language-server/src/plugins/typescript-go/lsp/TsGoPlugin.ts'
);
const require = createRequire(import.meta.url);
const CLASSIC_TYPESCRIPT_VERSION = require('typescript').version;

if (process.argv.includes('--help')) {
    console.log(`Usage:
  node bench/performance-acceptance.mjs --project <svelte-project> [options]

Required for a full acceptance run:
  --project <dir>        Svelte project/corpus (for Reintersect: ../reintersect/apps/dashboard)

Corpus and engines:
  --file <relative>      Edited Svelte file (default: src/lib/components/composer/Composer.svelte)
  --tsconfig <relative>  Project config (default: tsconfig.json)
  --engine <package>     Native package; repeat to compare several in order
  --engines <a,b>        Comma-separated alternative to repeated --engine
                         (default: @typescript/native-preview,@reintersect/effect-tsgo)
  --cache-state <label>  Declare external cache preparation in the JSON report

Acceptance sampling:
  --cold-pairs <n>       Alternating classic/native fresh-process pairs (minimum/default: 10)
  --rounds <n>           Typing rounds per gap and debounce (minimum/default: 20)
  --burst <n>            Keystrokes per round (default: 6)
  --gaps <ms,...>        Inter-key gaps (required/default: 30,60,120,250)
  --settle <ms>          Pause after a completed round (default: 75)
  --lifecycle-cycles <n> Open/change/close cycles (minimum/default: 200)
  --timeout <ms>         Per request/process timeout (default: 600000)

Output and focused validation:
  --json <file>          Write the complete machine-readable report
  --skip-checker         Skip the two-run warm incremental checker assertion
  --no-enforce           Report but do not fail on a debounce/default mismatch
  --smoke                Harness validation only: 1 cold pair, 2 rounds, 60ms gap
  --help                 Show this text

Full Reintersect example:
  node bench/performance-acceptance.mjs \\
    --project ../reintersect/apps/dashboard \\
    --file src/lib/components/composer/Composer.svelte \\
    --tsconfig tsconfig.json \\
    --json bench/results/reintersect-performance.json

Run the differential editor/checker oracles first. Performance output is not correctness evidence.`);
    process.exit(0);
}

function parseArgs(argv) {
    const options = {
        project: process.env.SVELTE_LS_BENCH_PROJECT ?? '',
        file: 'src/lib/components/composer/Composer.svelte',
        tsconfig: 'tsconfig.json',
        engines: ['@typescript/native-preview', '@reintersect/effect-tsgo'],
        coldPairs: 10,
        rounds: 20,
        burst: 6,
        gaps: [30, 60, 120, 250],
        debounceCandidates: [150, 80],
        settleMs: 75,
        lifecycleCycles: 200,
        timeoutMs: 10 * 60_000,
        cacheState: 'warm-disk (not cleared)',
        checker: true,
        enforce: true,
        smoke: false,
        json: undefined
    };
    let replacedEngines = false;
    for (let index = 2; index < argv.length; index++) {
        const argument = argv[index];
        // pnpm preserves the conventional option separator when forwarding script arguments.
        if (argument === '--') continue;
        const next = () => {
            const value = argv[++index];
            if (value === undefined) throw new Error(`${argument} requires a value`);
            return value;
        };
        if (argument === '--project') options.project = path.resolve(next());
        else if (argument === '--file') options.file = next();
        else if (argument === '--tsconfig') options.tsconfig = next();
        else if (argument === '--engine') {
            if (!replacedEngines) options.engines = [];
            options.engines.push(next());
            replacedEngines = true;
        } else if (argument === '--engines') {
            options.engines = next().split(',').filter(Boolean);
            replacedEngines = true;
        } else if (argument === '--cold-pairs') options.coldPairs = Number(next());
        else if (argument === '--rounds') options.rounds = Number(next());
        else if (argument === '--burst') options.burst = Number(next());
        else if (argument === '--gaps') options.gaps = next().split(',').map(Number);
        else if (argument === '--settle') options.settleMs = Number(next());
        else if (argument === '--lifecycle-cycles') options.lifecycleCycles = Number(next());
        else if (argument === '--timeout') options.timeoutMs = Number(next());
        else if (argument === '--cache-state') options.cacheState = next();
        else if (argument === '--json') options.json = path.resolve(next());
        else if (argument === '--skip-checker') options.checker = false;
        else if (argument === '--no-enforce') options.enforce = false;
        else if (argument === '--smoke') options.smoke = true;
        else throw new Error(`unknown argument: ${argument}`);
    }
    if (options.smoke) {
        options.coldPairs = 1;
        options.rounds = 2;
        options.gaps = [60];
        options.lifecycleCycles = 10;
    }
    if (!options.project) throw new Error('--project is required');
    if (!options.engines.length) throw new Error('at least one --engine is required');
    for (const [name, value] of [
        ['cold-pairs', options.coldPairs],
        ['rounds', options.rounds],
        ['burst', options.burst],
        ['lifecycle-cycles', options.lifecycleCycles]
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`--${name} must be a positive integer`);
        }
    }
    if (!options.smoke && options.coldPairs < 10) {
        throw new Error('performance acceptance requires at least 10 cold pairs (or --smoke)');
    }
    if (!options.smoke && options.rounds < 20) {
        throw new Error('performance acceptance requires at least 20 burst rounds (or --smoke)');
    }
    if (!options.smoke && options.lifecycleCycles < 200) {
        throw new Error(
            'performance acceptance requires at least 200 lifecycle cycles (or --smoke)'
        );
    }
    if (!options.smoke && [30, 60, 120, 250].some((required) => !options.gaps.includes(required))) {
        throw new Error('performance acceptance requires 30,60,120,250ms burst gaps');
    }
    if (
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.gaps.some((value) => !Number.isFinite(value) || value < 0)
    ) {
        throw new Error('timeouts and gaps must be finite non-negative numbers');
    }
    options.project = path.resolve(options.project);
    options.file = path.resolve(options.project, options.file);
    options.tsconfig = path.resolve(options.project, options.tsconfig);
    return options;
}

function injectMarker(source, marker, filePath) {
    const opening = /<script(?:\s[^>]*)?>/.exec(source);
    if (!opening) throw new Error(`benchmark file has no <script> block: ${filePath}`);
    const offset = opening.index + opening[0].length;
    return source.slice(0, offset) + `\n${marker};\n` + source.slice(offset);
}

function validateDiagnosticReport(report, marker, label) {
    if (!report || report.kind !== 'full' || !Array.isArray(report.items)) {
        throw new Error(`${label} returned malformed diagnostics: ${JSON.stringify(report)}`);
    }
    if (!report.items.some((diagnostic) => String(diagnostic.message ?? '').includes(marker))) {
        throw new Error(`${label} completed without the ${marker} diagnostic`);
    }
}

function cacheStateFromStats(stats) {
    if (!stats) return 'not-applicable';
    if (stats.transformedShadows === 0) return stats.reusedShadows ? 'warm' : 'empty';
    return stats.reusedShadows ? 'mixed' : 'cold-or-invalidated';
}

async function runColdTrial(options, packageName, pair, useTsGo) {
    const source = fs.readFileSync(options.file, 'utf8');
    const marker = `__cold_${pair}_${useTsGo ? 'native' : 'classic'}__`;
    let client;
    let monitor;
    const started = now();
    try {
        const session = await startLanguageServer({
            serverPath: SERVER,
            project: options.project,
            useTsGo,
            packageName: useTsGo ? packageName : undefined,
            onSpawn(spawned) {
                client = spawned;
                monitor = new ProcessTreeMonitor(spawned.proc.pid);
                monitor.start();
            }
        });
        client = session.client;
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: uri(options.file),
                languageId: 'svelte',
                version: 1,
                text: injectMarker(source, marker, options.file)
            }
        });
        const report = await client.request(
            'textDocument/diagnostic',
            { textDocument: { uri: uri(options.file) } },
            options.timeoutMs
        );
        validateDiagnosticReport(report, marker, useTsGo ? packageName : 'classic');
        const stats = useTsGo ? await getTsGoStats(client) : null;
        const durationMs = now() - started;
        const resources = monitor.stop();
        monitor = undefined;
        client.notify('textDocument/didClose', { textDocument: { uri: uri(options.file) } });
        return {
            pair,
            engine: session.engine ?? {
                packageName: 'typescript',
                version: CLASSIC_TYPESCRIPT_VERSION
            },
            durationMs: +durationMs.toFixed(1),
            cpuMs: resources.cpuMs,
            peakRssBytes: resources.peakRssBytes,
            maxProcessCount: resources.maxProcessCount,
            nativeChecks: stats?.projectChecks ?? 0,
            cacheState: cacheStateFromStats(stats),
            transformedShadows: stats?.transformedShadows ?? 0,
            reusedShadows: stats?.reusedShadows ?? 0,
            materialisationCleanupRuns: stats?.materialisationCleanupRuns ?? 0,
            materialisationCleanupSkips: stats?.materialisationCleanupSkips ?? 0,
            phaseTimings: stats?.phaseTimings ?? {}
        };
    } finally {
        if (monitor) {
            try {
                monitor.stop();
            } catch {}
        }
        if (client) await shutdownLanguageServer(client);
    }
}

async function runColdPairs(options, packageName) {
    const classic = [];
    const native = [];
    for (let pair = 0; pair < options.coldPairs; pair++) {
        const order = pair % 2 === 0 ? [false, true] : [true, false];
        for (const useTsGo of order) {
            console.log(
                `  cold pair ${pair + 1}/${options.coldPairs}: ${useTsGo ? packageName : 'classic'}`
            );
            const result = await runColdTrial(options, packageName, pair, useTsGo);
            (useTsGo ? native : classic).push(result);
        }
    }
    const summaryFor = (runs) => ({
        durationMs: summarize(runs.map((run) => run.durationMs)),
        cpuMs: summarize(runs.map((run) => run.cpuMs)),
        peakRssBytes: summarize(runs.map((run) => run.peakRssBytes)),
        nativeChecks: summarize(runs.map((run) => run.nativeChecks)),
        transformedShadows: summarize(runs.map((run) => run.transformedShadows)),
        reusedShadows: summarize(runs.map((run) => run.reusedShadows)),
        materialisationCleanupRuns: summarize(runs.map((run) => run.materialisationCleanupRuns)),
        materialisationCleanupSkips: summarize(runs.map((run) => run.materialisationCleanupSkips)),
        engineVersions: [
            ...new Set(runs.map((run) => `${run.engine.packageName}@${run.engine.version}`))
        ],
        cacheStates: [...new Set(runs.map((run) => run.cacheState))]
    });
    const classicSummary = summaryFor(classic);
    const nativeSummary = summaryFor(native);
    return {
        packageName,
        pairs: options.coldPairs,
        classic,
        native,
        summary: {
            classic: classicSummary,
            native: nativeSummary,
            p50Speedup: +(classicSummary.durationMs.p50 / nativeSummary.durationMs.p50).toFixed(2),
            pairedRatios: classic.map(
                (run, index) => +(run.durationMs / native[index].durationMs).toFixed(2)
            )
        }
    };
}

function findLifecycleFiles(project, preferredFile) {
    const root = path.resolve(project);
    const files = [];
    const skipped = new Set(['node_modules', '.git', '.svelte-kit', '.turbo', 'coverage']);
    const walk = (directory) => {
        // A nested `.git` file is a worktree boundary and a nested `.git` directory is another
        // repository. Neither belongs to this corpus, even when it lives under an authored
        // directory such as build/dist that we deliberately do scan.
        if (directory !== root && fs.existsSync(path.join(directory, '.git'))) return;
        let entries = [];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!skipped.has(entry.name)) walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.svelte')) {
                files.push(full);
            }
        }
    };
    walk(root);
    files.sort();
    const preferredIndex = files.indexOf(preferredFile);
    if (preferredIndex > 0) {
        files.splice(preferredIndex, 1);
        files.unshift(preferredFile);
    }
    if (!files.length) throw new Error(`no lifecycle .svelte files found under ${project}`);
    return files;
}

async function waitForOverlayCount(client, expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let stats;
    do {
        stats = await getTsGoStats(client);
        if (stats.openOverlays === expected && stats.pendingSvelteLifecycle === 0) return stats;
        await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(
        `open-overlay count did not return to ${expected}; last value ${stats?.openOverlays}`
    );
}

async function runLifecycleAcceptance(options, packageName) {
    const files = findLifecycleFiles(options.project, options.file);
    const primaryText = fs.readFileSync(options.file, 'utf8');
    let client;
    let monitor;
    try {
        const session = await startLanguageServer({
            serverPath: SERVER,
            project: options.project,
            useTsGo: true,
            packageName,
            onSpawn(spawned) {
                client = spawned;
            }
        });
        client = session.client;

        // Seed project materialisation before taking the baseline. The cycle measurement then
        // isolates lifecycle retention instead of conflating it with one-time project startup.
        const marker = '__lifecycle_warmup__';
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: uri(options.file),
                languageId: 'svelte',
                version: 1,
                text: injectMarker(primaryText, marker, options.file)
            }
        });
        const report = await client.request(
            'textDocument/diagnostic',
            { textDocument: { uri: uri(options.file) } },
            options.timeoutMs
        );
        validateDiagnosticReport(report, marker, `${packageName} lifecycle warmup`);
        client.notify('textDocument/didClose', { textDocument: { uri: uri(options.file) } });
        await waitForOverlayCount(client, 0, options.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const baselineStats = await getTsGoStats(client);
        const baselineResources = readProcessTree(client.proc.pid);
        if (!baselineResources.pids.length || baselineResources.rssBytes <= 0) {
            throw new Error('could not sample the lifecycle baseline process tree');
        }
        monitor = new ProcessTreeMonitor(client.proc.pid);
        monitor.start();
        const rssSamples = [{ cycle: 0, rssBytes: baselineResources.rssBytes }];
        const batchSize = 20;
        // The snapshot LRU is allowed to fill and the native process is allowed to JIT before
        // judging whether memory has plateaued. In the full 200-cycle run this establishes the
        // first plateau sample after 64 cycles; short smoke runs use their midpoint.
        const lruWarmupCycle = Math.min(
            Math.max(1, options.lifecycleCycles - 1),
            options.lifecycleCycles >= 128
                ? 64
                : Math.max(1, Math.floor(options.lifecycleCycles / 2))
        );
        const plateauWindowStartCycle = Math.max(
            lruWarmupCycle,
            Math.floor(options.lifecycleCycles / 2)
        );

        for (let cycle = 0; cycle < options.lifecycleCycles; cycle++) {
            const file = files[cycle % files.length];
            const text = fs.readFileSync(file, 'utf8');
            const fileUri = uri(file);
            client.notify('textDocument/didOpen', {
                textDocument: {
                    uri: fileUri,
                    languageId: 'svelte',
                    version: 1,
                    text
                }
            });
            client.notify('textDocument/didChange', {
                textDocument: { uri: fileUri, version: 2 },
                contentChanges: [{ text: `${text}\n` }]
            });
            // Do not queue close immediately: the serialized desired-state machine may legally
            // coalesce open/change/close into a no-op. Observe the dirty overlay first so this
            // phase actually exercises allocation and release on every cycle.
            await waitForOverlayCount(client, baselineStats.openOverlays + 1, options.timeoutMs);
            client.notify('textDocument/didClose', { textDocument: { uri: fileUri } });
            await waitForOverlayCount(client, baselineStats.openOverlays, options.timeoutMs);

            const completedCycles = cycle + 1;
            if (
                completedCycles === lruWarmupCycle ||
                completedCycles % batchSize === 0 ||
                completedCycles === options.lifecycleCycles
            ) {
                await waitForOverlayCount(client, baselineStats.openOverlays, options.timeoutMs);
                const sample = readProcessTree(client.proc.pid);
                if (!sample.pids.length) throw new Error('lifecycle process tree disappeared');
                rssSamples.push({ cycle: completedCycles, rssBytes: sample.rssBytes });
            }
        }

        await waitForOverlayCount(client, baselineStats.openOverlays, options.timeoutMs);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const finalStats = await getTsGoStats(client);
        const finalResources = readProcessTree(client.proc.pid);
        const finalSample = { cycle: options.lifecycleCycles, rssBytes: finalResources.rssBytes };
        if (rssSamples.at(-1)?.cycle === options.lifecycleCycles) {
            rssSamples[rssSamples.length - 1] = finalSample;
        } else {
            rssSamples.push(finalSample);
        }
        const measured = monitor.stop();
        monitor = undefined;
        const plateauCandidates = rssSamples
            .filter(
                (sample) =>
                    sample.cycle >= plateauWindowStartCycle &&
                    sample.cycle < options.lifecycleCycles
            )
            .map((sample) => sample.rssBytes);
        if (!plateauCandidates.length) {
            const warmupSample = rssSamples.find((sample) => sample.cycle === lruWarmupCycle);
            if (!warmupSample) throw new Error('could not sample lifecycle RSS after LRU warmup');
            plateauCandidates.push(warmupSample.rssBytes);
        }
        const plateauBaselineRssBytes = summarize(plateauCandidates).p50;
        const rssGrowth =
            (finalResources.rssBytes - plateauBaselineRssBytes) / plateauBaselineRssBytes;
        const problems = [];
        if (finalStats.openOverlays !== baselineStats.openOverlays) {
            problems.push(
                `open overlays ended at ${finalStats.openOverlays}, baseline ${baselineStats.openOverlays}`
            );
        }
        // Smoke mode intentionally runs only ten cycles, before the 64-entry snapshot LRU can
        // warm and establish a meaningful plateau. It still proves that every overlay closes,
        // while the release acceptance's required 200-cycle run owns the 15% RSS gate.
        if (!options.smoke && rssGrowth > 0.15) {
            problems.push(`RSS grew ${(rssGrowth * 100).toFixed(1)}%, limit 15%`);
        }
        if (problems.length) {
            throw new Error(
                `${packageName} lifecycle acceptance failed:\n- ${problems.join('\n- ')}`
            );
        }

        return {
            packageName,
            engine: session.engine,
            cycles: options.lifecycleCycles,
            distinctFiles: Math.min(files.length, options.lifecycleCycles),
            baselineOpenOverlays: baselineStats.openOverlays,
            finalOpenOverlays: finalStats.openOverlays,
            initialRssBytes: baselineResources.rssBytes,
            lruWarmupCycle,
            plateauWindowStartCycle,
            plateauBaselineRssBytes,
            finalRssBytes: finalResources.rssBytes,
            rssGrowth: +rssGrowth.toFixed(4),
            rssPlateauEnforced: !options.smoke,
            rssSamples,
            peakRssBytes: measured.peakRssBytes,
            cpuMs: measured.cpuMs,
            passed: true
        };
    } finally {
        if (monitor) {
            try {
                monitor.stop();
            } catch {}
        }
        if (client) await shutdownLanguageServer(client);
    }
}

function isMachinePosition(value) {
    return (
        value &&
        Number.isSafeInteger(value.line) &&
        value.line >= 0 &&
        Number.isSafeInteger(value.character) &&
        value.character >= 0
    );
}

function isMachineJsonRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.type === 'FILE') return typeof record.filename === 'string';
    if (record.type !== 'ERROR' && record.type !== 'WARNING') return false;
    return (
        typeof record.filename === 'string' &&
        typeof record.message === 'string' &&
        isMachinePosition(record.start) &&
        isMachinePosition(record.end) &&
        Number.isSafeInteger(record.severity) &&
        record.severity === (record.type === 'ERROR' ? 1 : 2) &&
        (record.relatedInformation ?? []).every(
            (related) =>
                related &&
                typeof related.message === 'string' &&
                typeof related.location?.uri === 'string' &&
                isMachinePosition(related.location.range?.start) &&
                isMachinePosition(related.location.range?.end)
        )
    );
}

function parseMachineOutput(stdout, label) {
    const records = [];
    const malformed = [];
    for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue;
        const match = /^\d+ (.+)$/.exec(line);
        if (!match) {
            malformed.push(line);
            continue;
        }
        const payload = match[1];
        if (payload.startsWith('{')) {
            try {
                const record = JSON.parse(payload);
                if (!isMachineJsonRecord(record)) throw new Error('invalid record shape');
                records.push(record);
            } catch {
                malformed.push(line);
            }
            continue;
        }
        const completion =
            /^COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS (\d+) FILES_WITH_PROBLEMS$/.exec(
                payload
            );
        const start = /^START (.+)$/.exec(payload);
        const failure = /^FAILURE (.+)$/.exec(payload);
        try {
            if (completion) {
                records.push({
                    type: 'COMPLETED',
                    fileCount: Number(completion[1]),
                    errorCount: Number(completion[2]),
                    warningCount: Number(completion[3]),
                    fileCountWithProblems: Number(completion[4])
                });
            } else if (start && typeof JSON.parse(start[1]) === 'string') {
                records.push({ type: 'START', workspace: JSON.parse(start[1]) });
            } else if (failure && typeof JSON.parse(failure[1]) === 'string') {
                records.push({ type: 'FAILURE', message: JSON.parse(failure[1]) });
            } else {
                malformed.push(line);
            }
        } catch {
            malformed.push(line);
        }
    }
    if (malformed.length) {
        throw new Error(
            `${label} emitted malformed machine output:\n${malformed.slice(0, 8).join('\n')}`
        );
    }
    return records;
}

async function runProcess(command, args, { cwd, env, timeoutMs, outputLimit = 256 << 20 }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const monitor = new ProcessTreeMonitor(child.pid);
        monitor.start();
        let stdout = '';
        let stderr = '';
        let bytes = 0;
        let terminalError;
        let settled = false;
        let forceKill;
        let monitorStopped = false;
        const stopMonitor = () => {
            if (monitorStopped) return undefined;
            monitorStopped = true;
            return monitor.stop();
        };
        const clearTimers = () => {
            clearTimeout(timer);
            if (forceKill) clearTimeout(forceKill);
        };
        const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            clearTimers();
            try {
                stopMonitor();
            } catch {}
            reject(error);
        };
        const terminate = (error) => {
            if (terminalError || settled) return;
            terminalError = error;
            try {
                child.kill('SIGTERM');
            } catch {
                // The close/error path remains authoritative when the process already exited.
            }
            forceKill = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Reject below even if the operating system already reaped the child.
                }
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                rejectOnce(error);
            }, 1_000);
        };
        const timer = setTimeout(
            () => terminate(new Error(`process timed out after ${timeoutMs}ms`)),
            timeoutMs
        );
        const collect = (target, chunk) => {
            if (terminalError) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > outputLimit) {
                terminate(new Error(`process exceeded ${outputLimit} output bytes`));
                return;
            }
            if (target === 'stdout') stdout += chunk;
            else stderr += chunk;
        };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => collect('stdout', chunk));
        child.stderr.on('data', (chunk) => collect('stderr', chunk));
        child.stdout.on('error', terminate);
        child.stderr.on('error', terminate);
        child.on('error', (error) => {
            if (terminalError) rejectOnce(terminalError);
            else rejectOnce(error);
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            clearTimers();
            let resources;
            try {
                resources = stopMonitor();
            } catch (error) {
                rejectOnce(error);
                return;
            }
            if (terminalError) {
                rejectOnce(terminalError);
                return;
            }
            settled = true;
            resolve({ code, signal, stdout, stderr, resources });
        });
    });
}

function validateMachineRun(run, label) {
    const starts = run.records.filter((record) => record.type === 'START');
    const completions = run.records.filter((record) => record.type === 'COMPLETED');
    const failures = run.records.filter((record) => record.type === 'FAILURE');
    const files = run.records.filter((record) => record.type === 'FILE');
    const errors = run.records.filter((record) => record.type === 'ERROR');
    const warnings = run.records.filter((record) => record.type === 'WARNING');
    const issues = [];
    if (run.signal) issues.push(`terminated by ${run.signal}`);
    if (starts.length !== 1) issues.push(`expected one START, got ${starts.length}`);
    if (completions.length !== 1) issues.push(`expected one COMPLETED, got ${completions.length}`);
    if (failures.length) issues.push(`emitted FAILURE: ${failures[0].message}`);
    const completion = completions[0];
    if (completion) {
        if (completion.fileCount <= 0) issues.push('completed with zero files');
        if (completion.fileCount !== files.length) {
            issues.push(`reported ${completion.fileCount} files but emitted ${files.length}`);
        }
        if (new Set(files.map((record) => record.filename)).size !== files.length) {
            issues.push('emitted duplicate FILE records');
        }
        if (completion.errorCount !== errors.length) {
            issues.push(`reported ${completion.errorCount} errors but emitted ${errors.length}`);
        }
        if (completion.warningCount !== warnings.length) {
            issues.push(
                `reported ${completion.warningCount} warnings but emitted ${warnings.length}`
            );
        }
        const filesWithProblems = new Set(
            [...errors, ...warnings].map((record) => record.filename.replace(/\\/g, '/'))
        );
        if (completion.fileCountWithProblems !== filesWithProblems.size) {
            issues.push(
                `reported ${completion.fileCountWithProblems} files with problems but emitted ` +
                    `diagnostics for ${filesWithProblems.size}`
            );
        }
        const expectedExit = completion.errorCount ? 1 : 0;
        if (run.code !== expectedExit)
            issues.push(`expected exit ${expectedExit}, got ${run.code}`);
    }
    if (issues.length) {
        throw new Error(`${label} failed:\n- ${issues.join('\n- ')}\n${run.stderr.slice(-4000)}`);
    }
}

function findWorkspaceRoot(from) {
    let current = from;
    for (;;) {
        if (
            fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) ||
            fs.existsSync(path.join(current, '.git'))
        ) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return from;
        current = parent;
    }
}

function compareMtimes(before, after) {
    const missing = [...before.keys()].filter((file) => !after.has(file));
    const added = [...after.keys()].filter((file) => !before.has(file));
    const changed = [...before]
        .filter(([file, mtime]) => after.get(file) !== mtime)
        .map(([file]) => file);
    return { missing, added, changed };
}

async function runCheckerOnce(options, packageName, statsPath) {
    const args = [
        CHECKER,
        '--workspace',
        options.project,
        '--tsconfig',
        options.tsconfig,
        '--tsgo',
        '--incremental',
        '--output',
        'machine-verbose',
        '--no-color'
    ];
    const started = now();
    const run = await runProcess(process.execPath, args, {
        cwd: options.project,
        timeoutMs: options.timeoutMs,
        env: {
            ...process.env,
            SVELTE_LS_TSGO_PACKAGE: packageName,
            SVELTE_LS_TSGO_STATS: statsPath
        }
    });
    run.durationMs = +(now() - started).toFixed(1);
    run.records = parseMachineOutput(run.stdout, `${packageName} checker`);
    validateMachineRun(run, `${packageName} checker`);
    if (!fs.existsSync(statsPath)) throw new Error(`${packageName} checker did not write stats`);
    try {
        run.stats = validateCheckerStats(
            JSON.parse(fs.readFileSync(statsPath, 'utf8')),
            packageName
        );
    } catch (error) {
        throw new Error(`${packageName} checker wrote malformed stats`, { cause: error });
    }
    return run;
}

async function runCheckerWarmAcceptance(options, packageName) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-tsgo-perf-'));
    const statsPath = path.join(temporary, 'stats.json');
    try {
        console.log(`  checker cold/seed: ${packageName}`);
        const first = await runCheckerOnce(options, packageName, statsPath);
        const workspaceRoot = findWorkspaceRoot(options.project);
        const beforeMtimes = snapshotShadowMtimes(workspaceRoot);
        console.log(`  checker warm:     ${packageName}`);
        const second = await runCheckerOnce(options, packageName, statsPath);
        const afterMtimes = snapshotShadowMtimes(workspaceRoot);
        const mtimeChanges = compareMtimes(beforeMtimes, afterMtimes);
        const firstProtocol = JSON.stringify(first.records);
        const secondProtocol = JSON.stringify(second.records);
        const problems = [];
        if (second.stats.materialise.transformedCount !== 0) {
            problems.push(
                `warm run transformed ${second.stats.materialise.transformedCount} shadows`
            );
        }
        if (second.stats.materialise.writtenCount !== 0) {
            problems.push(`warm run wrote ${second.stats.materialise.writtenCount} shadows`);
        }
        if (!second.stats.materialise.cleanup.skipped) {
            problems.push('warm run repeated cleanup reconciliation');
        }
        if (firstProtocol !== secondProtocol) {
            problems.push('warm diagnostics/program records were not field-for-field identical');
        }
        if (
            mtimeChanges.missing.length ||
            mtimeChanges.added.length ||
            mtimeChanges.changed.length
        ) {
            problems.push(
                `shadow mtimes changed (missing=${mtimeChanges.missing.length}, ` +
                    `added=${mtimeChanges.added.length}, changed=${mtimeChanges.changed.length})`
            );
        }
        if (problems.length) {
            throw new Error(
                `${packageName} warm checker acceptance failed:\n- ${problems.join('\n- ')}`
            );
        }
        const compact = (run) => ({
            durationMs: run.durationMs,
            cpuMs: run.resources.cpuMs,
            peakRssBytes: run.resources.peakRssBytes,
            stats: run.stats
        });
        const compactRuns = [compact(first), compact(second)];
        return {
            packageName,
            workspaceRoot,
            first: compactRuns[0],
            warm: compactRuns[1],
            summary: {
                durationMs: summarize(compactRuns.map((run) => run.durationMs)),
                cpuMs: summarize(compactRuns.map((run) => run.cpuMs)),
                peakRssBytes: summarize(compactRuns.map((run) => run.peakRssBytes)),
                nativeChecks: {
                    total: compactRuns.length,
                    perRun: summarize(compactRuns.map(() => 1))
                },
                engineVersions: [
                    ...new Set(
                        compactRuns.map(
                            (run) => `${run.stats.engine.packageName}@${run.stats.engine.version}`
                        )
                    )
                ],
                cacheStates: [...new Set(compactRuns.map((run) => run.stats.cacheState))],
                materialise: summarizeBatchMaterialiseResults(
                    compactRuns.map((run) => run.stats.materialise)
                ),
                createOverlay: summarizeBatchOverlayCreationTimings(
                    compactRuns.map((run) => run.stats.phases.createOverlay)
                )
            },
            shadowMtimeCount: afterMtimes.size,
            diagnosticsIdentical: true,
            shadowMtimesStable: true
        };
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

function burstGate(packageName, runs) {
    const baseline = runs.filter((run) => run.debounceMs === 150);
    const candidate = runs.filter((run) => run.debounceMs === 80);
    const baselineLatency = summarize(baseline.flatMap((run) => run.latenciesMs));
    const candidateLatency = summarize(candidate.flatMap((run) => run.latenciesMs));
    const baselineCpu = baseline.reduce((sum, run) => sum + run.cpuMs, 0);
    const candidateCpu = candidate.reduce((sum, run) => sum + run.cpuMs, 0);
    const baselineChecks = baseline.reduce((sum, run) => sum + run.nativeChecks, 0);
    const candidateChecks = candidate.reduce((sum, run) => sum + run.nativeChecks, 0);
    const p50Improvement = (baselineLatency.p50 - candidateLatency.p50) / baselineLatency.p50;
    const p95Improvement = (baselineLatency.p95 - candidateLatency.p95) / baselineLatency.p95;
    const cpuIncrease = baselineCpu ? (candidateCpu - baselineCpu) / baselineCpu : Infinity;
    const checkIncrease = baselineChecks
        ? (candidateChecks - baselineChecks) / baselineChecks
        : Infinity;
    const passes =
        p50Improvement >= 0.1 &&
        p95Improvement >= 0.1 &&
        cpuIncrease <= 0.05 &&
        checkIncrease <= 0.05;
    return {
        packageName,
        baseline: { latency: baselineLatency, cpuMs: baselineCpu, nativeChecks: baselineChecks },
        candidate: {
            latency: candidateLatency,
            cpuMs: candidateCpu,
            nativeChecks: candidateChecks
        },
        p50Improvement: +p50Improvement.toFixed(4),
        p95Improvement: +p95Improvement.toFixed(4),
        cpuIncrease: +cpuIncrease.toFixed(4),
        nativeCheckIncrease: +checkIncrease.toFixed(4),
        passes,
        recommendation: passes ? 80 : 150
    };
}

function configuredDefaultDebounce() {
    const source = fs.readFileSync(PLUGIN_SOURCE, 'utf8');
    const match = /const PULL_QUIESCENCE_MS =[\s\S]{0,240}?\n\s*: (\d+);/.exec(source);
    if (!match) throw new Error('could not determine the configured pull-diagnostic debounce');
    return Number(match[1]);
}

function printCold(cold) {
    const { classic, native } = cold.summary;
    console.log(
        `  p50/p95 cold: classic ${classic.durationMs.p50}/${classic.durationMs.p95}ms; ` +
            `${cold.packageName} ${native.durationMs.p50}/${native.durationMs.p95}ms; ` +
            `${cold.summary.p50Speedup}x`
    );
    console.log(
        `  native CPU p50 ${native.cpuMs.p50}ms; RSS p95 ${formatBytes(native.peakRssBytes.p95)}; ` +
            `checks p50 ${native.nativeChecks.p50}; engine ${native.engineVersions.join(',')}; ` +
            `cache ${native.cacheStates.join(',')}`
    );
    console.log(
        `  editor shadows transformed/reused p50 ${native.transformedShadows.p50}/${native.reusedShadows.p50}; ` +
            `cleanup ran/skipped p50 ${native.materialisationCleanupRuns.p50}/${native.materialisationCleanupSkips.p50}`
    );
}

function printChecker(checker) {
    const summary = checker.summary;
    const materialise = summary.materialise;
    console.log(
        `  process p50/p95 ${summary.durationMs.p50}/${summary.durationMs.p95}ms; ` +
            `CPU ${summary.cpuMs.p50}/${summary.cpuMs.p95}ms; ` +
            `RSS ${formatBytes(summary.peakRssBytes.p50)}/${formatBytes(summary.peakRssBytes.p95)}; ` +
            `native checks ${summary.nativeChecks.total}; engine ${summary.engineVersions.join(',')}; ` +
            `cache ${summary.cacheStates.join(',')}`
    );
    console.log(
        `  materialise p50/p95 ${materialise.durationMs.p50}/${materialise.durationMs.p95}ms; ` +
            `Svelte transformed ${materialise.svelte.transformedCount.p50}/${materialise.svelte.transformedCount.p95}, ` +
            `reused ${materialise.svelte.reusedCount.p50}/${materialise.svelte.reusedCount.p95}; ` +
            `source mirrors transformed ${materialise.sourceMirrors.transformedCount.p50}/${materialise.sourceMirrors.transformedCount.p95}, ` +
            `reused ${materialise.sourceMirrors.reusedCount.p50}/${materialise.sourceMirrors.reusedCount.p95}; ` +
            `cleanup skipped ${materialise.cleanup.skippedRuns}, ran ${materialise.cleanup.executedRuns}`
    );
    for (const phase of BATCH_MATERIALISE_PHASES) {
        const timing = materialise.phases[phase];
        console.log(`    ${phase}: p50/p95 ${timing.p50}/${timing.p95}ms`);
    }
    console.log('  overlay creation phases:');
    for (const phase of BATCH_CREATION_PHASES) {
        const timing = summary.createOverlay[phase];
        console.log(`    ${phase}: p50/p95 ${timing.p50}/${timing.p95}ms`);
    }
    console.log(
        `  graph dependency mode ${materialise.graph.dependencyScope.modes.join(',')}; ` +
            `roots p50/p95 ${materialise.graph.dependencyScope.dependencyRoots.p50}/${materialise.graph.dependencyScope.dependencyRoots.p95}; ` +
            `reachability fallbacks ${materialise.graph.reachabilityFallbackReasons.length}; ` +
            `collision fallbacks ${materialise.graph.collisionMirrors.fallbackReasons.length}`
    );
}

function printGate(gate) {
    const percent = (value) => `${(value * 100).toFixed(1)}%`;
    console.log(
        `  ${gate.packageName}: p50 ${percent(gate.p50Improvement)}, ` +
            `p95 ${percent(gate.p95Improvement)}, CPU ${percent(gate.cpuIncrease)}, ` +
            `checks ${percent(gate.nativeCheckIncrease)} => keep ${gate.recommendation}ms`
    );
}

const options = parseArgs(process.argv);
for (const required of [SERVER, options.file, options.tsconfig]) {
    if (!fs.existsSync(required)) throw new Error(`required path does not exist: ${required}`);
}
if (options.checker && !fs.existsSync(CHECKER)) {
    throw new Error(`svelte-check is not built: ${CHECKER}`);
}

const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: options.project,
    file: path.relative(options.project, options.file),
    tsconfig: path.relative(options.project, options.tsconfig),
    declaredCacheState: options.cacheState,
    configuration: {
        coldPairs: options.coldPairs,
        burstRoundsPerGap: options.rounds,
        burstSize: options.burst,
        gapsMs: options.gaps,
        lifecycleCycles: options.lifecycleCycles,
        debounceCandidatesMs: options.debounceCandidates,
        smoke: options.smoke
    },
    cold: [],
    bursts: [],
    lifecycle: [],
    checker: [],
    gate: undefined
};

for (const packageName of options.engines) {
    console.log(`\n=== paired fresh-process cold starts: ${packageName} ===`);
    const cold = await runColdPairs(options, packageName);
    report.cold.push(cold);
    printCold(cold);

    console.log(`\n=== pull-diagnostic bursts: ${packageName} ===`);
    const engineRuns = [];
    for (let gapIndex = 0; gapIndex < options.gaps.length; gapIndex++) {
        const gapMs = options.gaps[gapIndex];
        const order = gapIndex % 2 === 0 ? [150, 80] : [80, 150];
        for (const debounceMs of order) {
            console.log(`  debounce ${debounceMs}ms, gap ${gapMs}ms, ${options.rounds} rounds ...`);
            const run = await runBurstTrial({
                project: options.project,
                file: path.relative(options.project, options.file),
                packageName,
                debounceMs,
                gapMs,
                rounds: options.rounds,
                burst: options.burst,
                timeoutMs: options.timeoutMs,
                settleMs: options.settleMs,
                serverPath: SERVER
            });
            engineRuns.push(run);
            report.bursts.push(run);
            console.log(
                `    p50/p95 ${run.latency.p50}/${run.latency.p95}ms; ` +
                    `${run.nativeChecks} checks; CPU ${run.cpuMs}ms; ` +
                    `RSS ${formatBytes(run.peakRssBytes)}`
            );
        }
    }

    console.log(`\n=== document lifecycle/RSS plateau: ${packageName} ===`);
    const lifecycle = await runLifecycleAcceptance(options, packageName);
    report.lifecycle.push(lifecycle);
    console.log(
        `  ${lifecycle.cycles} cycles across ${lifecycle.distinctFiles} files; overlays ` +
            `${lifecycle.baselineOpenOverlays} -> ${lifecycle.finalOpenOverlays}; ` +
            `RSS ${(lifecycle.rssGrowth * 100).toFixed(1)}% ` +
            `(plateau ${formatBytes(lifecycle.plateauBaselineRssBytes)} -> ` +
            `${formatBytes(lifecycle.finalRssBytes)})`
    );

    if (options.checker) {
        console.log(`\n=== warm incremental checker: ${packageName} ===`);
        const checker = await runCheckerWarmAcceptance(options, packageName);
        report.checker.push(checker);
        printChecker(checker);
    }
}

const gates = options.engines.map((packageName) =>
    burstGate(
        packageName,
        report.bursts.filter((run) => run.engine.packageName === packageName)
    )
);
const recommendedDebounceMs = gates.every((gate) => gate.passes) ? 80 : 150;
const configuredDebounceMs = configuredDefaultDebounce();
report.gate = {
    engines: gates,
    recommendedDebounceMs,
    configuredDebounceMs,
    defaultMatchesEvidence: recommendedDebounceMs === configuredDebounceMs
};

console.log('\n=== 80ms vs 150ms gate ===');
for (const gate of gates) printGate(gate);
console.log(
    `  recommendation ${recommendedDebounceMs}ms; configured ${configuredDebounceMs}ms; ` +
        `${report.gate.defaultMatchesEvidence ? 'PASS' : 'FAIL'}`
);

if (options.json) {
    fs.mkdirSync(path.dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nwrote ${options.json}`);
}

if (options.enforce && !report.gate.defaultMatchesEvidence) {
    throw new Error(
        `pull-diagnostic default is ${configuredDebounceMs}ms, but paired evidence requires ${recommendedDebounceMs}ms`
    );
}
