import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient, sleep } from './lsp-client.mjs';

export const now = () => Number(process.hrtime.bigint()) / 1e6;
export const uri = (filePath) => pathToFileURL(filePath).href;

export function summarize(samples) {
    if (!samples.length) return null;
    const sorted = [...samples].sort((left, right) => left - right);
    const at = (quantile) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
    const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    return {
        n: sorted.length,
        min: +sorted[0].toFixed(1),
        p50: +at(0.5).toFixed(1),
        p95: +at(0.95).toFixed(1),
        max: +sorted.at(-1).toFixed(1),
        mean: +mean.toFixed(1)
    };
}

export const BATCH_MATERIALISE_PHASES = Object.freeze([
    'projectGraphMs',
    'dependencyIndexMs',
    'prepareMirrorsMs',
    'writeOverlayConfigMs',
    'collectRootsMs',
    'readStateMs',
    'svelteFreshnessMs',
    'svelteReadMs',
    'svelteTransformMs',
    'svelteWriteMs',
    'sourceMirrorFreshnessMs',
    'sourceMirrorReadMs',
    'sourceMirrorRewriteMs',
    'sourceMirrorWriteMs',
    'supportFilesMs',
    'cleanupMs',
    'writeStateMs',
    'commitFingerprintsMs',
    'clearSnapshotsMs',
    'writePlanMs'
]);

export const BATCH_CREATION_PHASES = Object.freeze([
    'resolveEngineAndProjectMs',
    'loadExplicitConfigMs',
    'resolveCompilerMs',
    'resolveShimsMs',
    'loadKitSettingsMs',
    'constructManagerMs',
    'lookupPlanMs',
    'restorePlanMs',
    'discoverProjectGraphMs',
    'discoverDependenciesMs',
    'primeConfigsMs',
    'totalMs'
]);

const CHECKER_PHASES = Object.freeze([
    'createOverlayMs',
    'nativeCheckMs',
    'mapDiagnosticsMs',
    'svelteAndCssMs',
    'totalMs'
]);

function requireRecord(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value;
}

function requireNonNegativeInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return value;
}

function requireNonNegativeNumber(value, field) {
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${field} must be a finite non-negative number`);
    }
    return value;
}

function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}

function requireCounters(record, fields, label) {
    for (const field of fields) {
        requireNonNegativeInteger(record[field], `${label}.${field}`);
    }
}

function requireStringArray(value, field) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
        throw new Error(`${field} must be an array of non-empty strings`);
    }
    return value;
}

/**
 * Validate the checker-facing BatchMaterialiseResult schema. Unknown fields are retained for
 * forward compatibility, but every current field is mandatory: accepting a partially-emitted
 * record would make an apparent performance improvement indistinguishable from missing work.
 */
export function validateBatchMaterialiseResult(value, label = 'materialise') {
    const result = requireRecord(value, label);
    requireCounters(
        result,
        ['shadowCount', 'transformedCount', 'reusedCount', 'writtenCount'],
        label
    );
    requireNonNegativeNumber(result.durationMs, `${label}.durationMs`);

    const phases = requireRecord(result.phases, `${label}.phases`);
    for (const phase of BATCH_MATERIALISE_PHASES) {
        requireNonNegativeNumber(phases[phase], `${label}.phases.${phase}`);
    }

    const svelte = requireRecord(result.svelte, `${label}.svelte`);
    requireCounters(
        svelte,
        ['candidateCount', 'transformedCount', 'reusedCount', 'writtenCount'],
        `${label}.svelte`
    );
    if (svelte.candidateCount !== svelte.transformedCount + svelte.reusedCount) {
        throw new Error(`${label}.svelte candidateCount must equal transformedCount + reusedCount`);
    }
    if (svelte.writtenCount > svelte.transformedCount) {
        throw new Error(`${label}.svelte writtenCount cannot exceed transformedCount`);
    }

    const sourceMirrors = requireRecord(result.sourceMirrors, `${label}.sourceMirrors`);
    requireCounters(
        sourceMirrors,
        ['candidateCount', 'copiedCount', 'rewrittenCount', 'reusedCount', 'writtenCount'],
        `${label}.sourceMirrors`
    );
    const materialisedSourceMirrors = sourceMirrors.copiedCount + sourceMirrors.rewrittenCount;
    if (sourceMirrors.candidateCount !== materialisedSourceMirrors + sourceMirrors.reusedCount) {
        throw new Error(
            `${label}.sourceMirrors candidateCount must equal copiedCount + rewrittenCount + reusedCount`
        );
    }
    if (sourceMirrors.writtenCount > materialisedSourceMirrors) {
        throw new Error(
            `${label}.sourceMirrors writtenCount cannot exceed copiedCount + rewrittenCount`
        );
    }

    const supportFiles = requireRecord(result.supportFiles, `${label}.supportFiles`);
    requireCounters(supportFiles, ['kitShadowCount', 'packageScopeCount'], `${label}.supportFiles`);

    const cleanup = requireRecord(result.cleanup, `${label}.cleanup`);
    if (typeof cleanup.skipped !== 'boolean') {
        throw new Error(`${label}.cleanup.skipped must be a boolean`);
    }
    requireCounters(cleanup, ['previousOwnedCount', 'liveOwnedCount'], `${label}.cleanup`);

    const graph = requireRecord(result.graph, `${label}.graph`);
    requireStringArray(
        graph.reachabilityFallbackReasons,
        `${label}.graph.reachabilityFallbackReasons`
    );
    const dependencyScope = requireRecord(graph.dependencyScope, `${label}.graph.dependencyScope`);
    if (!['reachable', 'declared-fallback'].includes(dependencyScope.mode)) {
        throw new Error(`${label}.graph.dependencyScope.mode is invalid`);
    }
    requireCounters(
        dependencyScope,
        ['directImports', 'dependencyRoots', 'svelteFiles'],
        `${label}.graph.dependencyScope`
    );
    requireStringArray(
        dependencyScope.fallbackReasons,
        `${label}.graph.dependencyScope.fallbackReasons`
    );
    const collisionMirrors = requireRecord(
        graph.collisionMirrors,
        `${label}.graph.collisionMirrors`
    );
    requireCounters(
        collisionMirrors,
        [
            'reachableScripts',
            'reverseClosureNodes',
            'mirroredScripts',
            'mirroredJson',
            'collidingComponents'
        ],
        `${label}.graph.collisionMirrors`
    );
    requireStringArray(
        collisionMirrors.fallbackReasons,
        `${label}.graph.collisionMirrors.fallbackReasons`
    );
    const materialisationPlan = requireRecord(
        graph.materialisationPlan,
        `${label}.graph.materialisationPlan`
    );
    if (typeof materialisationPlan.hit !== 'boolean') {
        throw new Error(`${label}.graph.materialisationPlan.hit must be a boolean`);
    }
    if (typeof materialisationPlan.eligible !== 'boolean') {
        throw new Error(`${label}.graph.materialisationPlan.eligible must be a boolean`);
    }
    if (
        !['pending', 'written', 'unchanged', 'skipped', 'failed'].includes(
            materialisationPlan.writeStatus
        )
    ) {
        throw new Error(`${label}.graph.materialisationPlan.writeStatus is invalid`);
    }
    if (
        materialisationPlan.missReason !== undefined &&
        (typeof materialisationPlan.missReason !== 'string' || !materialisationPlan.missReason)
    ) {
        throw new Error(`${label}.graph.materialisationPlan.missReason is invalid`);
    }
    if (
        materialisationPlan.missDetail !== undefined &&
        (typeof materialisationPlan.missDetail !== 'string' || !materialisationPlan.missDetail)
    ) {
        throw new Error(`${label}.graph.materialisationPlan.missDetail is invalid`);
    }
    if (
        materialisationPlan.writeFailureReason !== undefined &&
        (typeof materialisationPlan.writeFailureReason !== 'string' ||
            !materialisationPlan.writeFailureReason)
    ) {
        throw new Error(`${label}.graph.materialisationPlan.writeFailureReason is invalid`);
    }
    const planCounters = requireRecord(
        materialisationPlan.counters,
        `${label}.graph.materialisationPlan.counters`
    );
    requireCounters(
        planCounters,
        [
            'lookups',
            'hits',
            'misses',
            'writes',
            'writeSkips',
            'writeFailures',
            'statFastPathInputs',
            'sourceSignatureFallbacks',
            'exactContentFallbacks',
            'directoryValidations'
        ],
        `${label}.graph.materialisationPlan.counters`
    );
    const planMissReasons = requireRecord(
        planCounters.missReasons,
        `${label}.graph.materialisationPlan.counters.missReasons`
    );
    for (const [reason, count] of Object.entries(planMissReasons)) {
        if (!reason) {
            throw new Error(`${label}.graph.materialisationPlan has an empty miss reason`);
        }
        requireNonNegativeInteger(
            count,
            `${label}.graph.materialisationPlan.counters.missReasons.${reason}`
        );
    }

    const expectedTransformed =
        svelte.transformedCount + sourceMirrors.copiedCount + sourceMirrors.rewrittenCount;
    if (result.transformedCount !== expectedTransformed) {
        throw new Error(
            `${label}.transformedCount does not match the Svelte/source-mirror compatibility total`
        );
    }
    if (result.reusedCount !== svelte.reusedCount + sourceMirrors.reusedCount) {
        throw new Error(
            `${label}.reusedCount does not match the Svelte/source-mirror compatibility total`
        );
    }
    if (result.writtenCount !== svelte.writtenCount + sourceMirrors.writtenCount) {
        throw new Error(
            `${label}.writtenCount does not match the Svelte/source-mirror compatibility total`
        );
    }
    return result;
}

/** Validate the complete stats document written by svelte-check's tsgo path. */
export function validateCheckerStats(value, expectedPackageName) {
    const stats = requireRecord(value, 'checker stats');
    if (stats.schemaVersion !== 1) {
        throw new Error(`checker stats.schemaVersion must be 1`);
    }
    const engine = requireRecord(stats.engine, 'checker stats.engine');
    requireNonEmptyString(engine.packageName, 'checker stats.engine.packageName');
    requireNonEmptyString(engine.version, 'checker stats.engine.version');
    if (expectedPackageName && engine.packageName !== expectedPackageName) {
        throw new Error(
            `checker stats selected ${engine.packageName}, expected ${expectedPackageName}`
        );
    }
    if (typeof stats.incremental !== 'boolean') {
        throw new Error(`checker stats.incremental must be a boolean`);
    }
    if (!['warm', 'cold-or-invalidated', 'mixed'].includes(stats.cacheState)) {
        throw new Error(`checker stats.cacheState is invalid`);
    }

    const materialise = validateBatchMaterialiseResult(
        stats.materialise,
        'checker stats.materialise'
    );
    const expectedCacheState =
        materialise.transformedCount === 0 && materialise.writtenCount === 0
            ? 'warm'
            : materialise.reusedCount === 0
              ? 'cold-or-invalidated'
              : 'mixed';
    if (stats.cacheState !== expectedCacheState) {
        throw new Error(
            `checker stats.cacheState is ${stats.cacheState}, expected ${expectedCacheState} from materialisation counters`
        );
    }

    const phases = requireRecord(stats.phases, 'checker stats.phases');
    for (const phase of CHECKER_PHASES) {
        requireNonNegativeNumber(phases[phase], `checker stats.phases.${phase}`);
    }
    const creation = requireRecord(phases.createOverlay, 'checker stats.phases.createOverlay');
    for (const phase of BATCH_CREATION_PHASES) {
        requireNonNegativeNumber(creation[phase], `checker stats.phases.createOverlay.${phase}`);
    }
    const program = requireRecord(stats.program, 'checker stats.program');
    requireCounters(
        program,
        ['nativeFileCount', 'sourceFileCount', 'svelteFileCount'],
        'checker stats.program'
    );
    const diagnostics = requireRecord(stats.diagnostics, 'checker stats.diagnostics');
    requireCounters(
        diagnostics,
        ['nativeCount', 'mappedTypeScriptCount', 'svelteAndCssCount', 'outputCount'],
        'checker stats.diagnostics'
    );
    return stats;
}

/** Validate the internal LSP benchmark snapshot before deriving cache/CPU acceptance results. */
export function validateLanguageServerStats(value) {
    const stats = requireRecord(value, 'language server stats');
    const engine = requireRecord(stats.engine, 'language server stats.engine');
    requireNonEmptyString(engine.packageName, 'language server stats.engine.packageName');
    requireNonEmptyString(engine.version, 'language server stats.engine.version');
    if (
        stats.nativeProcessId !== null &&
        (!Number.isSafeInteger(stats.nativeProcessId) || stats.nativeProcessId <= 0)
    ) {
        throw new Error(`language server stats.nativeProcessId must be null or a positive integer`);
    }
    requireCounters(
        stats,
        [
            'generation',
            'served',
            'fellBack',
            'openOverlays',
            'childOpenOverlays',
            'pendingSvelteLifecycle',
            'transformedShadows',
            'reusedShadows',
            'projectChecks',
            'cancellations',
            'materialisationCleanupRuns',
            'materialisationCleanupSkips'
        ],
        'language server stats'
    );
    const fallbackReasons = requireRecord(
        stats.fallbackReasons,
        'language server stats.fallbackReasons'
    );
    for (const [reason, count] of Object.entries(fallbackReasons)) {
        if (!reason) throw new Error('language server stats.fallbackReasons has an empty reason');
        requireNonNegativeInteger(count, `language server stats.fallbackReasons.${reason}`);
    }
    const phaseTimings = requireRecord(stats.phaseTimings, 'language server stats.phaseTimings');
    for (const [phase, timingValue] of Object.entries(phaseTimings)) {
        if (!phase) throw new Error('language server stats.phaseTimings has an empty phase');
        const timing = requireRecord(timingValue, `language server stats.phaseTimings.${phase}`);
        requireNonNegativeInteger(
            timing.count,
            `language server stats.phaseTimings.${phase}.count`
        );
        requireNonNegativeNumber(
            timing.totalMs,
            `language server stats.phaseTimings.${phase}.totalMs`
        );
    }
    return stats;
}

function summarizeFields(records, fields) {
    return Object.fromEntries(
        fields.map((field) => [field, summarize(records.map((record) => record[field]))])
    );
}

/** Summarize one or more already-validated checker materialisation records. */
export function summarizeBatchMaterialiseResults(values) {
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error('at least one materialisation result is required');
    }
    const results = values.map((value, index) =>
        validateBatchMaterialiseResult(value, `materialise[${index}]`)
    );
    return {
        durationMs: summarize(results.map((result) => result.durationMs)),
        shadowCount: summarize(results.map((result) => result.shadowCount)),
        compatibility: summarizeFields(results, [
            'transformedCount',
            'reusedCount',
            'writtenCount'
        ]),
        phases: Object.fromEntries(
            BATCH_MATERIALISE_PHASES.map((phase) => [
                phase,
                summarize(results.map((result) => result.phases[phase]))
            ])
        ),
        svelte: summarizeFields(
            results.map((result) => result.svelte),
            ['candidateCount', 'transformedCount', 'reusedCount', 'writtenCount']
        ),
        sourceMirrors: summarizeFields(
            results.map((result) => ({
                ...result.sourceMirrors,
                transformedCount:
                    result.sourceMirrors.copiedCount + result.sourceMirrors.rewrittenCount
            })),
            [
                'candidateCount',
                'transformedCount',
                'copiedCount',
                'rewrittenCount',
                'reusedCount',
                'writtenCount'
            ]
        ),
        supportFiles: summarizeFields(
            results.map((result) => result.supportFiles),
            ['kitShadowCount', 'packageScopeCount']
        ),
        cleanup: {
            skippedRuns: results.filter((result) => result.cleanup.skipped).length,
            executedRuns: results.filter((result) => !result.cleanup.skipped).length,
            previousOwnedCount: summarize(
                results.map((result) => result.cleanup.previousOwnedCount)
            ),
            liveOwnedCount: summarize(results.map((result) => result.cleanup.liveOwnedCount))
        },
        graph: {
            reachabilityFallbackReasons: [
                ...new Set(results.flatMap((result) => result.graph.reachabilityFallbackReasons))
            ],
            dependencyScope: {
                modes: [...new Set(results.map((result) => result.graph.dependencyScope.mode))],
                directImports: summarize(
                    results.map((result) => result.graph.dependencyScope.directImports)
                ),
                dependencyRoots: summarize(
                    results.map((result) => result.graph.dependencyScope.dependencyRoots)
                ),
                svelteFiles: summarize(
                    results.map((result) => result.graph.dependencyScope.svelteFiles)
                ),
                fallbackReasons: [
                    ...new Set(
                        results.flatMap((result) => result.graph.dependencyScope.fallbackReasons)
                    )
                ]
            },
            collisionMirrors: {
                ...summarizeFields(
                    results.map((result) => result.graph.collisionMirrors),
                    [
                        'reachableScripts',
                        'reverseClosureNodes',
                        'mirroredScripts',
                        'mirroredJson',
                        'collidingComponents'
                    ]
                ),
                fallbackReasons: [
                    ...new Set(
                        results.flatMap((result) => result.graph.collisionMirrors.fallbackReasons)
                    )
                ]
            }
        }
    };
}

export function summarizeBatchOverlayCreationTimings(values) {
    if (!Array.isArray(values) || values.length === 0) {
        throw new Error('at least one overlay creation timing record is required');
    }
    return Object.fromEntries(
        BATCH_CREATION_PHASES.map((phase) => [
            phase,
            summarize(
                values.map((value, index) =>
                    requireNonNegativeNumber(
                        requireRecord(value, `creation[${index}]`)[phase],
                        `creation[${index}].${phase}`
                    )
                )
            )
        ])
    );
}

/** Parse BSD/GNU `ps time` values: [[days-]hours:]minutes:seconds. */
export function parseCpuTime(value) {
    const [dayPart, clock] = value.includes('-') ? value.split('-', 2) : ['0', value];
    const parts = clock.split(':').map(Number);
    if (
        !parts.length ||
        parts.length > 3 ||
        parts.some((part) => !Number.isFinite(part) || part < 0)
    ) {
        throw new Error(`invalid process CPU time: ${value}`);
    }
    const seconds =
        parts.length === 3
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : parts.length === 2
              ? parts[0] * 60 + parts[1]
              : parts[0];
    return (Number(dayPart) * 86400 + seconds) * 1000;
}

export function processTreeFromPs(output, rootPid) {
    const processes = [];
    for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 4) continue;
        const [pidText, parentText, rssText, cpuText] = fields;
        const pid = Number(pidText);
        const parentPid = Number(parentText);
        const rssKb = Number(rssText);
        if (![pid, parentPid, rssKb].every(Number.isFinite)) continue;
        try {
            processes.push({ pid, parentPid, rssKb, cpuMs: parseCpuTime(cpuText) });
        } catch {
            // One malformed/system-specific row must not hide otherwise usable process data.
        }
    }

    const included = new Set([rootPid]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const process of processes) {
            if (included.has(process.parentPid) && !included.has(process.pid)) {
                included.add(process.pid);
                changed = true;
            }
        }
    }
    const tree = processes.filter((process) => included.has(process.pid));
    return {
        pids: tree.map((process) => process.pid),
        rssBytes: tree.reduce((sum, process) => sum + process.rssKb * 1024, 0),
        cpuMs: tree.reduce((sum, process) => sum + process.cpuMs, 0)
    };
}

export function readProcessTree(rootPid) {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time='], {
        encoding: 'utf8',
        timeout: 5000
    });
    return processTreeFromPs(output, rootPid);
}

/**
 * Snapshot every authoritative generated Svelte shadow without walking dependency trees.
 * build/dist remain eligible because configs may deliberately root projects there; nested Git
 * checkouts/worktrees are separate corpora and are pruned at their boundary.
 */
export function snapshotShadowMtimes(workspaceRoot) {
    const root = path.resolve(workspaceRoot);
    const mtimes = new Map();
    const skipped = new Set(['.git', '.svelte-kit', '.turbo', 'coverage']);
    const collectCache = (directory) => {
        let entries = [];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) collectCache(full);
            else if (entry.isFile() && entry.name.endsWith('.svelte.tsx')) {
                mtimes.set(full, fs.statSync(full, { bigint: true }).mtimeNs.toString());
            }
        }
    };
    const walk = (directory) => {
        if (directory !== root && fs.existsSync(path.join(directory, '.git'))) return;
        let entries = [];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || skipped.has(entry.name)) continue;
            const full = path.join(directory, entry.name);
            if (entry.name === 'node_modules') {
                // Never descend into packages or pnpm stores: only this package root's own
                // generated overlay is relevant.
                collectCache(path.join(full, '.cache', 'svelte-lsp'));
            } else {
                walk(full);
            }
        }
    };
    walk(root);
    return mtimes;
}

export class ProcessTreeMonitor {
    constructor(rootPid, intervalMs = 100) {
        if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
            throw new Error(`invalid root process id: ${rootPid}`);
        }
        this.rootPid = rootPid;
        this.intervalMs = intervalMs;
        this.started = false;
        this.timer = undefined;
        this.firstCpuMs = undefined;
        this.maxCpuMs = 0;
        this.peakRssBytes = 0;
        this.maxProcessCount = 0;
        this.error = undefined;
    }

    sample() {
        try {
            const snapshot = readProcessTree(this.rootPid);
            if (snapshot.pids.length) {
                this.firstCpuMs ??= snapshot.cpuMs;
                this.maxCpuMs = Math.max(this.maxCpuMs, snapshot.cpuMs);
                this.peakRssBytes = Math.max(this.peakRssBytes, snapshot.rssBytes);
                this.maxProcessCount = Math.max(this.maxProcessCount, snapshot.pids.length);
            }
            return snapshot;
        } catch (error) {
            this.error = error;
            return null;
        }
    }

    start() {
        if (this.started) return;
        this.started = true;
        this.sample();
        this.timer = setInterval(() => this.sample(), this.intervalMs);
        this.timer.unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.sample();
        if (this.firstCpuMs === undefined) {
            throw new Error(
                `could not sample process tree ${this.rootPid}: ${
                    this.error instanceof Error ? this.error.message : 'process disappeared'
                }`
            );
        }
        return {
            cpuMs: +Math.max(0, this.maxCpuMs - this.firstCpuMs).toFixed(1),
            peakRssBytes: this.peakRssBytes,
            maxProcessCount: this.maxProcessCount
        };
    }
}

export function parseEnabledEngine(stderr) {
    const match = /\[tsgo\] enabled, using (.+)@([^@\s]+) \(([^\n]+)\)/.exec(stderr);
    return match ? { packageName: match[1], version: match[2], executable: match[3] } : undefined;
}

export async function startLanguageServer({
    serverPath,
    project,
    useTsGo,
    packageName,
    debounceMs,
    onSpawn
}) {
    const env = { ...process.env, SVELTE_LS_TSGO: useTsGo ? '1' : '' };
    delete env.SVELTE_LS_TIMING;
    if (packageName) env.SVELTE_LS_TSGO_PACKAGE = packageName;
    else delete env.SVELTE_LS_TSGO_PACKAGE;
    if (debounceMs !== undefined) {
        env.SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS = String(debounceMs);
    } else {
        delete env.SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS;
    }

    const client = new LspClient(process.execPath, [serverPath, '--stdio'], {
        cwd: project,
        env
    });
    onSpawn?.(client);
    client.onRequest('workspace/configuration', (params) => (params.items ?? []).map(() => ({})));
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('client/unregisterCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);
    client.onRequest('workspace/diagnostic/refresh', () => null);
    client.onRequest('workspace/semanticTokens/refresh', () => null);
    client.onRequest('workspace/inlayHint/refresh', () => null);

    const result = await client.request(
        'initialize',
        {
            processId: process.pid,
            rootUri: uri(project),
            workspaceFolders: [{ uri: uri(project), name: path.basename(project) }],
            initializationOptions: {
                configuration: { svelte: {}, typescript: {}, javascript: {} }
            },
            capabilities: {
                general: { positionEncodings: ['utf-16'] },
                workspace: {
                    configuration: true,
                    diagnostics: { refreshSupport: true },
                    didChangeWatchedFiles: { dynamicRegistration: true }
                },
                textDocument: {
                    synchronization: { dynamicRegistration: true },
                    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
                    publishDiagnostics: { versionSupport: true }
                }
            }
        },
        180_000
    );
    if (!result?.capabilities || !result.capabilities.diagnosticProvider) {
        client.dispose();
        throw new Error(`language server returned a malformed/incomplete initialize result`);
    }
    client.notify('initialized', {});

    let engine;
    if (useTsGo) {
        for (let attempt = 0; attempt < 100; attempt++) {
            engine = parseEnabledEngine(client.stderr);
            if (engine || client.exited) break;
            await sleep(25);
        }
        if (!engine) {
            const stderr = client.stderr;
            client.dispose();
            throw new Error(`tsgo did not confirm its exact engine version:\n${stderr}`);
        }
        if (packageName && engine.packageName !== packageName) {
            client.dispose();
            throw new Error(
                `requested ${packageName}, but the server selected ${engine.packageName}@${engine.version}`
            );
        }
    }
    return { client, engine };
}

export async function getTsGoStats(client) {
    const stats = await client.request('$/getTsGoStats', null, 10_000);
    try {
        return validateLanguageServerStats(stats);
    } catch (error) {
        throw new Error(`language server returned malformed tsgo stats: ${JSON.stringify(stats)}`);
    }
}

export async function shutdownLanguageServer(client) {
    if (client.exited) return;
    const exited = new Promise((resolve) => client.onExit(resolve));
    try {
        await client.request('shutdown', null, 10_000);
        client.notify('exit', null);
        await Promise.race([exited, sleep(2000)]);
    } finally {
        if (!client.exited) client.dispose();
    }
}

export function formatBytes(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
