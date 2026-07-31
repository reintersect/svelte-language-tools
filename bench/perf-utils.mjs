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
    if (
        !stats ||
        !stats.engine ||
        !Number.isSafeInteger(stats.projectChecks) ||
        !Number.isSafeInteger(stats.openOverlays) ||
        !Number.isSafeInteger(stats.pendingSvelteLifecycle) ||
        typeof stats.phaseTimings !== 'object'
    ) {
        throw new Error(`language server returned malformed tsgo stats: ${JSON.stringify(stats)}`);
    }
    return stats;
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
