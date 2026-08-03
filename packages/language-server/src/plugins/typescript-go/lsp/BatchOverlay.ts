import fs from 'fs';
import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { setPriority } from 'os';
import ts from 'typescript';
import { internalHelpers, InternalHelpers } from 'svelte2tsx';
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver';
import { Document, getLineOffsets, offsetAt, positionAt } from '../../../lib/documents';
import { configLoader, ResolvedSvelteConfig } from '../../../lib/documents/configLoader';
import { getPackageInfo, importSvelte } from '../../../importPackage';
import { Logger } from '../../../logger';
import { normalizePath, pathToUrl } from '../../../utils';
import { SvelteDocumentSnapshot, SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';
import { mapAndFilterDiagnostics } from '../../typescript/features/DiagnosticsProvider';
import { isRsvelteEnabled, preloadRsvelte } from '../rsvelte';
import {
    BatchGraphPlan,
    computeBatchGraphSourceSignature,
    findProjectTsconfig,
    findWorkspaceRoot,
    invalidateTsGoWorkspaceIndex,
    KitShadow,
    ShadowManager
} from './ShadowManager';
import { ResolvedTsGoEngine, resolveTsGoEngine } from './TsGoEngine';
import {
    MaterialisationPlanCache,
    MaterialisationPlanCacheCounters,
    MaterialisationPlanEngineIdentity,
    MaterialisationPlanFileInput,
    MaterialisationPlanIdentity,
    MaterialisationPlanMissReason,
    MaterialisationPlanValidationOnlyFileInput,
    MaterialisationPlanWriteFailureReason,
    materialisationPlanEngineCacheKey,
    materialisationPlanExactFileProof,
    materialisationPlanLayoutTopologyProof,
    readValidMaterialisationPlanFile,
    readValidMaterialisationPlanIdentity
} from './MaterialisationPlanCache';
import {
    BATCH_GRAPH_DIRECTORY_VALIDATOR,
    batchGraphDirectoryMembershipCoversPath,
    batchGraphDirectoryMembership,
    createBatchGraphDirectoryMembershipBudget
} from './BatchGraphEvidence';

/**
 * A diagnostic as it comes off a batch compiler run, positioned in the *generated* file.
 * Line and character are zero-based; `length` is a span in characters.
 */
export interface GeneratedDiagnostic {
    filePath: string | null;
    line: number;
    character: number;
    /** Same-line span length, or a fallback when an explicit multiline end is present. */
    length: number;
    endLine?: number;
    endCharacter?: number;
    severity: DiagnosticSeverity;
    code: number;
    message: string;
    relatedInformation?: GeneratedDiagnosticRelatedInformation[];
}

export interface GeneratedDiagnosticRelatedInformation {
    filePath: string;
    line: number;
    character: number;
    length: number;
    endLine?: number;
    endCharacter?: number;
    message: string;
}

export interface FileDiagnostics {
    filePath: string;
    text: string;
    diagnostics: Diagnostic[];
}

export interface TsGoBatchOverlayOptions {
    /** Directory the check was invoked for. Used to locate a tsconfig when none is given. */
    workspacePath: string;
    /** Absolute path to the project's tsconfig/jsconfig. */
    tsconfigPath?: string;
    /** Absolute path to a svelte.config/vite.config, when the project's isn't in the usual place. */
    configPath?: string;
    /** Suppress loader/overlay progress logs for machine-readable CLI consumers. */
    quiet?: boolean;
}

export interface BatchMaterialisePhaseTimings {
    projectGraphMs: number;
    dependencyIndexMs: number;
    prepareMirrorsMs: number;
    writeOverlayConfigMs: number;
    collectRootsMs: number;
    readStateMs: number;
    svelteFreshnessMs: number;
    svelteReadMs: number;
    svelteTransformMs: number;
    svelteWriteMs: number;
    sourceMirrorFreshnessMs: number;
    sourceMirrorReadMs: number;
    sourceMirrorRewriteMs: number;
    sourceMirrorWriteMs: number;
    supportFilesMs: number;
    cleanupMs: number;
    writeStateMs: number;
    commitFingerprintsMs: number;
    clearSnapshotsMs: number;
    writePlanMs: number;
}

export interface BatchOverlayCreationTimings {
    resolveEngineAndProjectMs: number;
    loadExplicitConfigMs: number;
    resolveCompilerMs: number;
    resolveShimsMs: number;
    loadKitSettingsMs: number;
    constructManagerMs: number;
    lookupPlanMs: number;
    restorePlanMs: number;
    discoverProjectGraphMs: number;
    discoverDependenciesMs: number;
    primeConfigsMs: number;
    totalMs: number;
}

export interface BatchMaterialisationPlanTelemetry {
    hit: boolean;
    missReason?: MaterialisationPlanMissReason | 'restore-rejected';
    missDetail?: string;
    eligible: boolean;
    writeStatus: 'pending' | 'written' | 'unchanged' | 'skipped' | 'failed';
    writeFailureReason?: MaterialisationPlanWriteFailureReason;
    counters: MaterialisationPlanCacheCounters;
}

export interface BatchMaterialiseResult {
    shadowCount: number;
    /** Compatibility total: Svelte transforms plus newly-copied/rewritten source mirrors. */
    transformedCount: number;
    /** Compatibility total: reusable Svelte shadows plus reusable source mirrors. */
    reusedCount: number;
    writtenCount: number;
    durationMs: number;
    phases: BatchMaterialisePhaseTimings;
    svelte: {
        candidateCount: number;
        transformedCount: number;
        reusedCount: number;
        writtenCount: number;
    };
    sourceMirrors: {
        candidateCount: number;
        copiedCount: number;
        rewrittenCount: number;
        reusedCount: number;
        writtenCount: number;
    };
    supportFiles: {
        kitShadowCount: number;
        packageScopeCount: number;
    };
    cleanup: {
        skipped: boolean;
        previousOwnedCount: number;
        liveOwnedCount: number;
    };
    graph: {
        reachabilityFallbackReasons: readonly string[];
        dependencyScope: {
            mode: 'reachable' | 'declared-fallback';
            directImports: number;
            dependencyRoots: number;
            svelteFiles: number;
            fallbackReasons: readonly string[];
            closureComplete: boolean;
        };
        collisionMirrors: {
            reachableScripts: number;
            reverseClosureNodes: number;
            mirroredScripts: number;
            mirroredJson: number;
            collidingComponents: number;
            fallbackReasons: readonly string[];
        };
        materialisationPlan: BatchMaterialisationPlanTelemetry;
    };
}

/** Where SvelteKit puts route params and hooks when svelte.config.js doesn't say otherwise. */
const defaultKitFiles: InternalHelpers.KitFilesSettings = {
    paramsPath: 'src/params',
    serverHooksPath: 'src/hooks.server',
    clientHooksPath: 'src/hooks.client',
    universalHooksPath: 'src/hooks'
};

const BATCH_STATE_VERSION = 5;
const BATCH_GRAPH_ALGORITHM_VERSION = `batch-graph-v18:typescript-${ts.version}`;
const BATCH_GRAPH_PLAN_FILE_PREFIX = 'materialisation-plan';
const MAX_VALID_BATCH_GRAPH_ENGINE_CACHE_ENTRIES = 2;
const MAX_BATCH_GRAPH_DIRECTORY_ROOTS = 1_024;

interface StoredParserError {
    range: Range;
    severity: DiagnosticSeverity;
    message: string;
    code: number;
    source: 'ts' | 'js';
}

interface StoredShadowState {
    shadowPath: string;
    /** Full module-resolution/rewrite identity used by ordinary-source mirrors. */
    rewriteIdentity?: string;
    /** Present only for copied batch mirrors; transformed Svelte shadows omit it. */
    mirrorKind?: 'script' | 'json';
    /** `null` means the transform completed and the file parsed successfully. */
    parserError: StoredParserError | null;
    /** Fast-path identity: an exact match permits reuse before reading source contents. */
    sourceStat: StoredSourceStat;
    /** Content remains authoritative when a touch/copy changed only source metadata. */
    sourceContentStamp: string;
    /** Output stat is the zero-read warm fast path; content is authoritative after a touch. */
    outputStat: StoredSourceStat;
    outputContentStamp: string;
}

interface StoredSourceStat {
    size: string;
    mtimeNs: string;
    ctimeNs: string;
}

interface BatchState {
    version: typeof BATCH_STATE_VERSION;
    entries: Record<string, StoredShadowState>;
    /** Hash of every live mirror output path after the last successful reconciliation/prune. */
    cleanupIdentity?: string;
}

export interface BatchGraphPlanCacheLookup {
    hit: boolean;
    plan?: BatchGraphPlan;
    missReason?: MaterialisationPlanMissReason | 'restore-rejected';
    missDetail?: string;
    lookupMs: number;
    restoreMs: number;
}

export interface BatchGraphPlanPublication {
    readonly plan: BatchGraphPlan;
    readonly safeDirectoryRoots: readonly string[] | undefined;
    readonly directories:
        | ReturnType<MaterialisationPlanCache<BatchGraphPlan>['snapshotDirectory']>[]
        | undefined;
    readonly refreshInputStats: boolean;
    readonly shouldPublish: boolean;
    readonly discoveryCurrent: boolean;
    readonly discoveryStatus: BatchGraphDiscoveryEvidenceStatus;
}

type BatchGraphDiscoveryEvidenceStatus = 'current' | 'stale' | 'incomplete' | 'unverifiable';

interface BatchGraphPlanProcessRequest {
    engine: ResolvedTsGoEngine;
    overlayPath: string;
    project: {
        projectPath: string;
        sourceRoot: string;
        tsconfigPath: string | undefined;
        configPath?: string;
    };
    plan: BatchGraphPlan;
    collisionFallbackReasons: string[];
}

interface BatchGraphPlanPublicationJob {
    readonly key: string;
    readonly request: BatchGraphPlanProcessRequest;
    readonly approximateBytes: number;
    readonly attempt: number;
}

const pendingBatchGraphPlanPublications = new Map<string, BatchGraphPlanPublicationJob>();
const MAX_BATCH_GRAPH_PLAN_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES = 96 * 1024 * 1024;
const MAX_PENDING_BATCH_GRAPH_PLAN_PUBLICATIONS = 8;
const MAX_BATCH_GRAPH_PLAN_PUBLICATION_ATTEMPTS = 2;
const BATCH_GRAPH_PLAN_PUBLICATION_TIMEOUT_MS = 30_000;
const MAX_BATCH_GRAPH_PLAN_REQUEST_ESTIMATE_NODES = 1_000_000;
const MAX_BATCH_GRAPH_PLAN_REQUEST_ESTIMATE_DEPTH = 512;
/** Interactive cache proof must remain cheaper than rebuilding the graph it is meant to save. */
const EDITOR_GRAPH_PLAN_LOOKUP_MAX_DURATION_MS = 2_000;
const EDITOR_GRAPH_PLAN_LOOKUP_MAX_CONTENT_FALLBACKS = 64;
const EDITOR_GRAPH_PLAN_DIRECTORY_MAX_DURATION_MS = 1_500;
let batchGraphPlanPublicationTimer: NodeJS.Timeout | undefined;
let activeBatchGraphPlanPublication: BatchGraphPlanPublicationJob | undefined;
let retainedBatchGraphPlanRequestBytes = 0;

/** Coalesce project replacement bursts and run at most one low-priority publisher at a time. */
function enqueueBatchGraphPlanPublication(request: BatchGraphPlanProcessRequest): void {
    const key = `${normalizePath(request.overlayPath)}\0${batchGraphProjectIdentity(
        request.project
    )}\0${materialisationPlanEngineCacheKey(batchGraphEngineIdentity(request.engine))}`;
    if (
        activeBatchGraphPlanPublication?.key === key &&
        batchGraphPlanPublicationRequestsMatch(activeBatchGraphPlanPublication.request, request)
    ) {
        return;
    }
    const previous = pendingBatchGraphPlanPublications.get(key);
    if (previous && batchGraphPlanPublicationRequestsMatch(previous.request, request)) {
        return;
    }
    // A newer graph for the same project supersedes a queued one even when the new auxiliary
    // request is too large to retain. Publishing the known-stale request would only add I/O and
    // its final cache validation would reject it anyway.
    if (previous) {
        discardPendingBatchGraphPlanPublication(previous);
    }
    const approximateBytes = approximateBatchGraphPlanRequestBytes(request);
    if (
        approximateBytes === undefined ||
        approximateBytes > MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES
    ) {
        Logger.debug('[tsgo] dropped an unbounded graph-plan publication request');
        return;
    }
    retainPendingBatchGraphPlanPublication({
        key,
        request,
        approximateBytes,
        attempt: 0
    });
    scheduleNextBatchGraphPlanPublication();
}

function scheduleNextBatchGraphPlanPublication(): void {
    if (
        activeBatchGraphPlanPublication ||
        batchGraphPlanPublicationTimer ||
        pendingBatchGraphPlanPublications.size === 0
    ) {
        return;
    }
    batchGraphPlanPublicationTimer = setTimeout(() => {
        batchGraphPlanPublicationTimer = undefined;
        void runNextBatchGraphPlanPublication();
    }, 50);
    batchGraphPlanPublicationTimer.unref();
}

async function runNextBatchGraphPlanPublication(): Promise<void> {
    if (activeBatchGraphPlanPublication) {
        return;
    }
    const next = pendingBatchGraphPlanPublications.entries().next().value as
        | [string, BatchGraphPlanPublicationJob]
        | undefined;
    if (!next) {
        return;
    }
    const [key, job] = next;
    pendingBatchGraphPlanPublications.delete(key);
    activeBatchGraphPlanPublication = job;
    const { request } = job;
    let requestPath: string | undefined;
    const finish = (retry: boolean, detail: string) => {
        if (activeBatchGraphPlanPublication !== job) {
            return;
        }
        activeBatchGraphPlanPublication = undefined;
        retainedBatchGraphPlanRequestBytes = Math.max(
            0,
            retainedBatchGraphPlanRequestBytes - job.approximateBytes
        );
        let retryQueued = false;
        if (
            retry &&
            job.attempt + 1 < MAX_BATCH_GRAPH_PLAN_PUBLICATION_ATTEMPTS &&
            !pendingBatchGraphPlanPublications.has(job.key)
        ) {
            retryQueued = retainPendingBatchGraphPlanPublication({
                ...job,
                attempt: job.attempt + 1
            });
        }
        if (retry) {
            Logger.debug(
                `[tsgo] graph-plan publisher ${detail}; ${
                    retryQueued ? 'queued one retry' : 'dropped auxiliary publication'
                }`
            );
        }
        scheduleNextBatchGraphPlanPublication();
    };
    try {
        await fs.promises.mkdir(request.overlayPath, { recursive: true });
        requestPath = join(
            request.overlayPath,
            `.materialisation-plan-request-${process.pid}-${randomBytes(6).toString('hex')}.json`
        );
        // Serialize/write in bounded chunks. JSON.stringify on a real workspace plan can block
        // the LS event loop on tens of MiB immediately after the first completion.
        await writeJsonFileCooperatively(requestPath, request);
        const script = `
const fs = require('node:fs');
const [modulePath, requestPath] = process.argv.slice(1);
try {
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    require(modulePath).publishBatchGraphPlanInProcess(request);
} finally {
    try { fs.unlinkSync(requestPath); } catch {}
}
`;
        const execArgs = __filename.endsWith('.ts')
            ? ['--require', require.resolve('ts-node/register')]
            : [];
        const child = spawn(
            process.execPath,
            [...execArgs, '-e', script, __filename, requestPath],
            { detached: true, stdio: 'ignore', windowsHide: true }
        );
        let settled = false;
        let childTimeout: NodeJS.Timeout | undefined;
        let childError: (error: Error) => void;
        let childClose: (code: number | null, signal: NodeJS.Signals | null) => void;
        const cleanupAfterSettlement = () => {
            unlinkBatchGraphPlanProcessRequest(requestPath);
        };
        const childFinished = (retry: boolean, detail: string) => {
            // The child normally unlinks in its finally block, but it may never execute the
            // script (for example a failing --require), be killed by a signal, or time out.
            // Parent ownership makes cleanup independent of how far bootstrap progressed.
            unlinkBatchGraphPlanProcessRequest(requestPath);
            if (settled) {
                return;
            }
            settled = true;
            if (childTimeout) {
                clearTimeout(childTimeout);
                childTimeout = undefined;
            }
            // A process which ignores/does not observe the timeout must not retain the complete
            // request through these lifecycle closures. Keep only a path-sized cleanup listener.
            child.removeListener('error', childError);
            child.removeListener('close', childClose);
            child.once('error', cleanupAfterSettlement);
            child.once('close', cleanupAfterSettlement);
            finish(retry, detail);
        };
        childError = (error) => {
            childFinished(true, `failed to start (${error.message})`);
        };
        childClose = (code, signal) => {
            const failed = code !== 0 || signal !== null;
            childFinished(
                failed,
                signal ? `closed from ${signal}` : `exited with status ${String(code)}`
            );
        };
        child.once('error', childError);
        child.once('close', childClose);
        childTimeout = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                // Settlement below still releases the queue if the process cannot be signalled.
            }
            childFinished(true, 'timed out');
        }, BATCH_GRAPH_PLAN_PUBLICATION_TIMEOUT_MS);
        childTimeout.unref();
        if (child.pid) {
            try {
                setPriority(child.pid, 10);
            } catch {
                // Priority is advisory and unsupported on some hosts.
            }
        }
        child.unref();
    } catch (error) {
        unlinkBatchGraphPlanProcessRequest(requestPath);
        finish(
            true,
            `failed before child bootstrap (${error instanceof Error ? error.message : String(error)})`
        );
    }
}

function retainPendingBatchGraphPlanPublication(job: BatchGraphPlanPublicationJob): boolean {
    const activeBytes = activeBatchGraphPlanPublication?.approximateBytes ?? 0;
    if (job.approximateBytes > MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES - activeBytes) {
        return false;
    }
    while (
        pendingBatchGraphPlanPublications.size >= MAX_PENDING_BATCH_GRAPH_PLAN_PUBLICATIONS ||
        job.approximateBytes >
            MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES - retainedBatchGraphPlanRequestBytes
    ) {
        const oldest = pendingBatchGraphPlanPublications.values().next().value as
            | BatchGraphPlanPublicationJob
            | undefined;
        if (!oldest) {
            return false;
        }
        discardPendingBatchGraphPlanPublication(oldest);
    }
    pendingBatchGraphPlanPublications.set(job.key, job);
    retainedBatchGraphPlanRequestBytes += job.approximateBytes;
    return true;
}

function discardPendingBatchGraphPlanPublication(job: BatchGraphPlanPublicationJob): void {
    if (pendingBatchGraphPlanPublications.get(job.key) !== job) {
        return;
    }
    pendingBatchGraphPlanPublications.delete(job.key);
    retainedBatchGraphPlanRequestBytes = Math.max(
        0,
        retainedBatchGraphPlanRequestBytes - job.approximateBytes
    );
}

function batchGraphPlanPublicationRequestsMatch(
    left: BatchGraphPlanProcessRequest,
    right: BatchGraphPlanProcessRequest
): boolean {
    return (
        left.plan.signature === right.plan.signature &&
        left.collisionFallbackReasons.length === right.collisionFallbackReasons.length &&
        left.collisionFallbackReasons.every(
            (reason, index) => reason === right.collisionFallbackReasons[index]
        )
    );
}

/**
 * Conservatively estimate retained JS heap without stringifying the graph on the editor thread.
 * The traversal is itself bounded and rejects cycles/repeated object identities, excessive depth,
 * unsupported JSON values and plans too large for the auxiliary queue.
 */
function approximateBatchGraphPlanRequestBytes(value: unknown): number | undefined {
    const seen = new WeakSet<object>();
    let bytes = 0;
    let nodes = 0;
    const add = (amount: number): boolean => {
        if (
            !Number.isSafeInteger(amount) ||
            amount < 0 ||
            amount > MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES - bytes
        ) {
            bytes = MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES + 1;
            return false;
        }
        bytes += amount;
        return true;
    };
    const visit = (current: unknown, depth: number): boolean => {
        nodes++;
        if (
            nodes > MAX_BATCH_GRAPH_PLAN_REQUEST_ESTIMATE_NODES ||
            depth > MAX_BATCH_GRAPH_PLAN_REQUEST_ESTIMATE_DEPTH
        ) {
            return false;
        }
        if (current === null) {
            return add(8);
        }
        switch (typeof current) {
            case 'string':
                return add(current.length * 2 + 16);
            case 'number':
                return add(8);
            case 'boolean':
            case 'undefined':
                return add(4);
            case 'bigint':
            case 'function':
            case 'symbol':
                return false;
            case 'object':
                break;
        }
        const object = current as object;
        if (seen.has(object)) {
            return false;
        }
        seen.add(object);
        if (!add(Array.isArray(object) ? 24 : 48)) {
            return false;
        }
        if (Array.isArray(object)) {
            if (!add(object.length * 8)) {
                return false;
            }
            for (let index = 0; index < object.length; index++) {
                if (!visit(object[index], depth + 1)) {
                    return false;
                }
            }
            return true;
        }
        let entries: [string, unknown][];
        try {
            entries = Object.entries(object);
        } catch {
            return false;
        }
        if (!add(entries.length * 16)) {
            return false;
        }
        for (const [property, propertyValue] of entries) {
            if (!add(property.length * 2 + 16)) {
                return false;
            }
            if (!visit(propertyValue, depth + 1)) {
                return false;
            }
        }
        return true;
    };
    if (!visit(value, 0)) {
        return bytes > MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES ? bytes : undefined;
    }
    return bytes;
}

function unlinkBatchGraphPlanProcessRequest(requestPath: string | undefined): void {
    if (!requestPath) {
        return;
    }
    void fs.promises.unlink(requestPath).catch(() => undefined);
}

async function writeJsonFileCooperatively(filePath: string, value: unknown): Promise<void> {
    const handle = await fs.promises.open(filePath, 'wx', 0o600);
    let buffer = '';
    let bytesWritten = 0;
    const flush = async () => {
        if (!buffer) {
            return;
        }
        const chunk = buffer;
        buffer = '';
        const encoded = Uint8Array.from(Buffer.from(chunk, 'utf8'));
        bytesWritten += encoded.byteLength;
        if (bytesWritten > MAX_BATCH_GRAPH_PLAN_REQUEST_BYTES) {
            throw new Error('materialisation plan request exceeds the cache size limit');
        }
        let offset = 0;
        while (offset < encoded.byteLength) {
            const written = await handle.write(encoded, offset, encoded.byteLength - offset, null);
            if (written.bytesWritten <= 0) {
                throw new Error('could not make progress writing materialisation plan request');
            }
            offset += written.bytesWritten;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const append = async (text: string) => {
        buffer += text;
        if (buffer.length >= 256 * 1024) {
            await flush();
        }
    };
    const writeValue = async (input: unknown): Promise<void> => {
        if (input === null || typeof input !== 'object') {
            const encoded = JSON.stringify(input);
            await append(encoded === undefined ? 'null' : encoded);
            return;
        }
        if (Array.isArray(input)) {
            await append('[');
            for (let index = 0; index < input.length; index++) {
                if (index) {
                    await append(',');
                }
                await writeValue(input[index]);
            }
            await append(']');
            return;
        }
        await append('{');
        let first = true;
        for (const [property, propertyValue] of Object.entries(input)) {
            if (propertyValue === undefined) {
                continue;
            }
            if (!first) {
                await append(',');
            }
            first = false;
            await append(`${JSON.stringify(property)}:`);
            await writeValue(propertyValue);
        }
        await append('}');
    };
    try {
        await writeValue(value);
        await flush();
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * The single persisted BatchGraphPlan boundary shared by the checker and editor. Both consumers
 * therefore use the same engine/project identity, freshness validators, completeness proof and
 * fail-closed publication rules.
 */
export class BatchGraphPlanCache {
    private readonly cache: MaterialisationPlanCache<BatchGraphPlan>;
    private readonly cachePath: string;
    private readonly legacyCachePath: string;
    private readonly cacheIdentity: MaterialisationPlanIdentity;
    private readonly cacheProjectIdentity: string;
    private readonly cacheProjectKey: string;
    private lookup: BatchGraphPlanCacheLookup | undefined;
    private eligible = false;
    private writeStatus: BatchMaterialisationPlanTelemetry['writeStatus'] = 'pending';
    private writeFailureReason: MaterialisationPlanWriteFailureReason | undefined;
    private readonly processRequest: Omit<
        BatchGraphPlanProcessRequest,
        'plan' | 'collisionFallbackReasons'
    >;
    private readonly interactiveLookup: boolean;

    constructor(
        engine: ResolvedTsGoEngine,
        shadows: ShadowManager,
        project: {
            projectPath: string;
            sourceRoot: string;
            tsconfigPath: string | undefined;
            configPath?: string;
        }
    ) {
        const projectIdentity = batchGraphProjectIdentity(project);
        const engineIdentity = batchGraphEngineIdentity(engine);
        const projectKey = projectIdentity.slice(0, 16);
        const engineKey = materialisationPlanEngineCacheKey(engineIdentity);
        const cacheFile = `${BATCH_GRAPH_PLAN_FILE_PREFIX}-${projectKey}-${engineKey}.json`;
        this.cachePath = resolve(shadows.overlayPath, cacheFile);
        this.legacyCachePath = resolve(
            shadows.overlayPath,
            project.configPath
                ? `${BATCH_GRAPH_PLAN_FILE_PREFIX}-${projectKey}.json`
                : `${BATCH_GRAPH_PLAN_FILE_PREFIX}.json`
        );
        this.cacheIdentity = {
            engine: engineIdentity,
            algorithm: BATCH_GRAPH_ALGORITHM_VERSION,
            project: projectIdentity
        };
        this.cacheProjectIdentity = projectIdentity;
        this.cacheProjectKey = projectKey;
        this.cache = new MaterialisationPlanCache<BatchGraphPlan>(
            this.cachePath,
            this.cacheIdentity,
            { maxCacheBytes: MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES }
        );
        this.processRequest = {
            engine: { ...engine, argsPrefix: [...engine.argsPrefix] },
            overlayPath: shadows.overlayPath,
            project: { ...project }
        };
        this.interactiveLookup = project.configPath === undefined;
    }

    lookupAndRestore(shadows: ShadowManager): BatchGraphPlanCacheLookup {
        if (this.lookup) {
            return this.lookup;
        }
        let started = performance.now();
        migrateLegacyBatchGraphPlanCache({
            legacyPath: this.legacyCachePath,
            cachePath: this.cachePath,
            identity: this.cacheIdentity
        });
        const directoryBudget = createBatchGraphDirectoryMembershipBudget({
            maxEntries: 500_000,
            maxDurationMs: this.interactiveLookup
                ? EDITOR_GRAPH_PLAN_DIRECTORY_MAX_DURATION_MS
                : 3_000
        });
        const lookup = this.cache.lookup({
            sourceSignature: (filePath) =>
                computeBatchGraphSourceSignature(fs.readFileSync(filePath, 'utf8')),
            directoryMembership: (request) =>
                batchGraphDirectoryMembership({ ...request, budget: directoryBudget }),
            ...(this.interactiveLookup
                ? {
                      validationBudget: {
                          maxDurationMs: EDITOR_GRAPH_PLAN_LOOKUP_MAX_DURATION_MS,
                          maxContentFallbacks: EDITOR_GRAPH_PLAN_LOOKUP_MAX_CONTENT_FALLBACKS
                      }
                  }
                : {})
        });
        const lookupMs = performance.now() - started;
        started = performance.now();
        if (lookup.hit) {
            if (shadows.restoreBatchGraphPlan(lookup.payload)) {
                return (this.lookup = {
                    hit: true,
                    plan: lookup.payload,
                    lookupMs,
                    restoreMs: performance.now() - started
                });
            }
            invalidateTsGoWorkspaceIndex();
            return (this.lookup = {
                hit: false,
                missReason: 'restore-rejected',
                lookupMs,
                restoreMs: performance.now() - started
            });
        }
        if (batchGraphMissInvalidatesWorkspaceIndex(lookup.reason)) {
            invalidateTsGoWorkspaceIndex();
        }
        return (this.lookup = {
            hit: false,
            missReason: lookup.reason,
            ...(lookup.detail ? { missDetail: lookup.detail } : {}),
            lookupMs,
            restoreMs: performance.now() - started
        });
    }

    prepare(
        plan: BatchGraphPlan,
        collisionFallbackReasons: readonly string[],
        revalidateDiscovery = true
    ): BatchGraphPlanPublication {
        const safeDirectoryRoots = safeBatchGraphDirectoryRoots(plan);
        const discoveryComplete = batchGraphDiscoveryEvidenceIsComplete(plan);
        const discoveryStatus: BatchGraphDiscoveryEvidenceStatus = !discoveryComplete
            ? 'incomplete'
            : revalidateDiscovery
              ? batchGraphDiscoveryEvidenceStatus(plan)
              : 'current';
        const discoveryCurrent = discoveryStatus === 'current';
        const projectProofComplete = projectScopeHasCompleteCacheProof(plan, safeDirectoryRoots);
        const dependencyProofComplete = dependencyScopeHasCompleteCacheProof(
            plan,
            safeDirectoryRoots
        );
        this.eligible =
            discoveryCurrent &&
            plan.project.tsconfigPath !== null &&
            plan.configInputs.includes(plan.project.tsconfigPath) &&
            projectProofComplete &&
            dependencyProofComplete &&
            collisionFallbackReasons.length === 0 &&
            plan.baseConfigDiagnostics.length === 0 &&
            safeDirectoryRoots !== undefined &&
            safeDirectoryRoots.length > 0;
        const counters = this.cache.counters;
        const refreshInputStats =
            counters.sourceSignatureFallbacks > 0 || counters.exactContentFallbacks > 0;
        const shouldPublish =
            !this.lookup?.hit ||
            refreshInputStats ||
            (!!this.lookup.plan && this.lookup.plan.signature !== plan.signature);
        let directories: BatchGraphPlanPublication['directories'];
        if (this.eligible && safeDirectoryRoots && shouldPublish) {
            const proofs = new Map(plan.directoryProofs.map((proof) => [proof.path, proof]));
            directories = safeDirectoryRoots.map((path) => {
                const proof = proofs.get(path);
                return {
                    path,
                    validator: BATCH_GRAPH_DIRECTORY_VALIDATOR,
                    allowMissing: false,
                    discoveryProof: proof
                        ? { stamp: proof.stamp, entryCount: proof.entryCount }
                        : null
                };
            });
            if (directories.some((input) => input.discoveryProof === null)) {
                directories = undefined;
                this.eligible = false;
            }
        }
        return {
            plan,
            safeDirectoryRoots,
            directories,
            refreshInputStats,
            shouldPublish,
            discoveryCurrent,
            discoveryStatus
        };
    }

    /** Revalidate a restored hit using the cache's stored stat identities before commit. */
    revalidateHitAtCommit(
        plan: BatchGraphPlan,
        collisionFallbackReasons: readonly string[]
    ): BatchGraphPlanPublication {
        let publication = this.prepare(plan, collisionFallbackReasons, false);
        if (!this.lookup?.hit || !publication.discoveryCurrent) {
            return publication;
        }
        const directoryBudget = createBatchGraphDirectoryMembershipBudget({
            maxEntries: 500_000,
            maxDurationMs: 3_000
        });
        const validation = this.cache.revalidate({
            sourceSignature: (filePath) =>
                computeBatchGraphSourceSignature(fs.readFileSync(filePath, 'utf8')),
            directoryMembership: (request) =>
                batchGraphDirectoryMembership({ ...request, budget: directoryBudget })
        });
        // revalidate() can take a source/exact-content fallback and change the cache counters.
        // Re-prepare so refreshInputStats, shouldPublish and the guarded directory snapshots all
        // describe the post-validation decision rather than the earlier optimistic fast path.
        publication = this.prepare(plan, collisionFallbackReasons, false);
        const discoveryStatus: BatchGraphDiscoveryEvidenceStatus = validation.hit
            ? 'current'
            : validation.reason === 'directory-validator-unavailable' ||
                validation.reason === 'directory-membership-error' ||
                validation.reason === 'source-signature-unavailable' ||
                validation.reason === 'source-signature-error' ||
                validation.reason === 'exact-content-error' ||
                validation.reason === 'read-error'
              ? 'unverifiable'
              : 'stale';
        if (discoveryStatus !== 'current') {
            this.eligible = false;
        }
        return {
            ...publication,
            discoveryCurrent: discoveryStatus === 'current',
            discoveryStatus
        };
    }

    publish(publication: BatchGraphPlanPublication): void {
        const { plan, safeDirectoryRoots, directories, shouldPublish } = publication;
        if (!this.eligible || !safeDirectoryRoots) {
            this.writeStatus = 'skipped';
        } else if (!shouldPublish) {
            this.writeStatus = 'unchanged';
        } else if (!directories) {
            this.writeStatus = 'skipped';
        } else {
            const directoryBudget = createBatchGraphDirectoryMembershipBudget({
                maxEntries: 500_000,
                maxDurationMs: 3_000
            });
            const fileInputs = batchGraphPlanFileInputs(plan, safeDirectoryRoots);
            const write = this.cache.write({
                complete: true,
                payload: plan,
                files: fileInputs.files,
                validationOnlyFiles: fileInputs.validationOnlyFiles,
                directories,
                sourceSignature: (filePath) =>
                    computeBatchGraphSourceSignature(fs.readFileSync(filePath, 'utf8')),
                directoryMembership: (request) =>
                    batchGraphDirectoryMembership({ ...request, budget: directoryBudget })
            });
            if (write.ok) {
                this.writeStatus = write.written ? 'written' : 'unchanged';
                pruneBatchGraphPlanEngineCaches({
                    cachePath: this.cachePath,
                    projectIdentity: this.cacheProjectIdentity,
                    projectKey: this.cacheProjectKey
                });
            } else {
                this.writeStatus = 'failed';
                this.writeFailureReason = write.reason;
            }
        }
    }

    /**
     * Validate and persist a cold editor graph away from the language-server event loop. A large
     * workspace can carry tens of thousands of exact/source inputs; synchronously re-reading them
     * after discovery made the first completion wait for cache maintenance which benefits only a
     * later process.
     */
    publishOffProcess(plan: BatchGraphPlan, collisionFallbackReasons: readonly string[]): void {
        enqueueBatchGraphPlanPublication({
            ...this.processRequest,
            plan,
            collisionFallbackReasons: [...collisionFallbackReasons]
        });
    }

    telemetry(): BatchMaterialisationPlanTelemetry {
        return {
            hit: this.lookup?.hit ?? false,
            ...(this.lookup?.missReason ? { missReason: this.lookup.missReason } : {}),
            ...(this.lookup?.missDetail ? { missDetail: this.lookup.missDetail } : {}),
            eligible: this.eligible,
            writeStatus: this.writeStatus,
            ...(this.writeFailureReason ? { writeFailureReason: this.writeFailureReason } : {}),
            counters: this.cache.counters
        };
    }
}

interface BatchGraphPlanCacheRetentionRequest {
    cachePath: string;
    projectIdentity: string;
    projectKey: string;
}

interface LegacyBatchGraphPlanMigrationRequest {
    legacyPath: string;
    cachePath: string;
    identity: MaterialisationPlanIdentity;
}

interface ValidBatchGraphPlanCacheFile {
    path: string;
    mtimeMs: number;
    dev: number;
    ino: number;
}

interface PotentialBatchGraphPlanCacheFile extends ValidBatchGraphPlanCacheFile {
    engineKey?: string;
}

/**
 * Upgrade a checksum-valid single-file cache without publishing stale bytes over a concurrent
 * keyed writer. A hard-link from a fully-written private temp file gives us atomic
 * create-if-absent semantics; the ordinary keyed lookup still performs complete freshness checks.
 */
function migrateLegacyBatchGraphPlanCache(request: LegacyBatchGraphPlanMigrationRequest): void {
    const legacy = readValidMaterialisationPlanFile(
        request.legacyPath,
        MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES
    );
    if (!legacy || !sameBatchGraphPlanIdentity(legacy.identity, request.identity)) {
        return;
    }

    const removeLegacyIfTargetMatches = (): boolean => {
        const targetIdentity = readValidMaterialisationPlanIdentity(
            request.cachePath,
            MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES
        );
        if (!targetIdentity || !sameBatchGraphPlanIdentity(targetIdentity, request.identity)) {
            return false;
        }
        unlinkUnchangedRegularCacheFile({
            path: request.legacyPath,
            mtimeMs: 0,
            dev: legacy.dev,
            ino: legacy.ino
        });
        fsyncBatchGraphCacheDirectoryBestEffort(dirname(request.cachePath));
        return true;
    };

    if (fs.lstatSync(request.cachePath, { throwIfNoEntry: false })) {
        removeLegacyIfTargetMatches();
        return;
    }

    const tempPath = `${request.cachePath}.migrate-${process.pid}-${randomBytes(6).toString('hex')}`;
    let descriptor: number | undefined;
    try {
        fs.mkdirSync(dirname(request.cachePath), { recursive: true });
        descriptor = fs.openSync(tempPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, legacy.contents, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;

        let published = false;
        try {
            fs.linkSync(tempPath, request.cachePath);
            fsyncBatchGraphCacheDirectoryBestEffort(dirname(request.cachePath));
            published = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
        }
        if (published) {
            unlinkUnchangedRegularCacheFile({
                path: request.legacyPath,
                mtimeMs: 0,
                dev: legacy.dev,
                ino: legacy.ino
            });
        } else {
            removeLegacyIfTargetMatches();
        }
    } catch (error) {
        Logger.debug('[tsgo] could not migrate legacy materialisation-plan cache', error);
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Best effort; migration remains fail-closed.
            }
        }
        try {
            fs.unlinkSync(tempPath);
        } catch {
            // The unique temp is never considered by lookup or retention.
        }
    }
}

function fsyncBatchGraphCacheDirectoryBestEffort(directory: string): void {
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    } catch {
        // Some platforms do not support directory fsync; atomic create-if-absent still holds.
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Best effort durability only.
            }
        }
    }
}

function sameBatchGraphPlanIdentity(
    left: MaterialisationPlanIdentity,
    right: MaterialisationPlanIdentity
): boolean {
    return (
        left.algorithm === right.algorithm &&
        left.project === right.project &&
        left.engine.packageName === right.engine.packageName &&
        left.engine.version === right.engine.version
    );
}

/** Keep engine switching warm without allowing obsolete native builds to accumulate forever. */
function pruneBatchGraphPlanEngineCaches(request: BatchGraphPlanCacheRetentionRequest): void {
    const cacheDirectory = dirname(request.cachePath);
    const keyedPrefix = `${BATCH_GRAPH_PLAN_FILE_PREFIX}-${request.projectKey}-`;
    const legacyNames = new Set([
        `${BATCH_GRAPH_PLAN_FILE_PREFIX}.json`,
        `${BATCH_GRAPH_PLAN_FILE_PREFIX}-${request.projectKey}.json`
    ]);
    const keyedPotential: PotentialBatchGraphPlanCacheFile[] = [];
    const legacyPotential: PotentialBatchGraphPlanCacheFile[] = [];

    try {
        for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
            let engineKey: string | undefined;
            if (entry.name.startsWith(keyedPrefix) && entry.name.endsWith('.json')) {
                engineKey = entry.name.slice(keyedPrefix.length, -'.json'.length);
                if (!/^[0-9a-f]{64}$/.test(engineKey)) {
                    continue;
                }
            } else if (!legacyNames.has(entry.name)) {
                continue;
            }
            // Dirent and lstat checks deliberately reject symlinks. Cache retention must never
            // follow a matching-looking entry outside the overlay.
            if (!entry.isFile()) {
                continue;
            }
            const candidatePath = resolve(cacheDirectory, entry.name);
            const candidateRelative = relative(cacheDirectory, candidatePath);
            if (
                !candidateRelative ||
                candidateRelative.startsWith('..') ||
                isAbsolute(candidateRelative) ||
                dirname(candidatePath) !== resolve(cacheDirectory)
            ) {
                continue;
            }
            const stat = fs.lstatSync(candidatePath, { throwIfNoEntry: false });
            if (!stat?.isFile() || stat.isSymbolicLink()) {
                continue;
            }
            const potential = {
                path: candidatePath,
                mtimeMs: stat.mtimeMs,
                dev: stat.dev,
                ino: stat.ino,
                ...(engineKey === undefined ? {} : { engineKey })
            };
            (engineKey === undefined ? legacyPotential : keyedPotential).push(potential);
        }

        // The filename and regular-file checks are sufficient to prove the upper bound when no
        // cleanup is needed. Avoid rereading and reparsing a potentially large freshly-written
        // graph on the overwhelmingly common first- and second-engine publications.
        if (
            keyedPotential.length <= MAX_VALID_BATCH_GRAPH_ENGINE_CACHE_ENTRIES &&
            legacyPotential.length === 0
        ) {
            return;
        }

        const keyed: ValidBatchGraphPlanCacheFile[] = [];
        const legacy: ValidBatchGraphPlanCacheFile[] = [];
        for (const potential of [...keyedPotential, ...legacyPotential]) {
            const identity = readValidMaterialisationPlanIdentity(
                potential.path,
                MAX_RETAINED_BATCH_GRAPH_PLAN_REQUEST_BYTES
            );
            if (
                !identity ||
                identity.algorithm !== BATCH_GRAPH_ALGORITHM_VERSION ||
                identity.project !== request.projectIdentity ||
                (potential.engineKey !== undefined &&
                    materialisationPlanEngineCacheKey(identity.engine) !== potential.engineKey)
            ) {
                continue;
            }
            (potential.engineKey === undefined ? legacy : keyed).push(potential);
        }

        const currentPath = resolve(request.cachePath);
        keyed.sort(
            (left, right) =>
                Number(right.path === currentPath) - Number(left.path === currentPath) ||
                right.mtimeMs - left.mtimeMs ||
                left.path.localeCompare(right.path)
        );
        const currentIsValid = keyed.some((candidate) => candidate.path === currentPath);
        for (const candidate of keyed.slice(MAX_VALID_BATCH_GRAPH_ENGINE_CACHE_ENTRIES)) {
            unlinkUnchangedRegularCacheFile(candidate);
        }
        // A legacy single-file cache is redundant only once the just-written keyed replacement
        // has itself passed full envelope and identity validation.
        if (currentIsValid) {
            for (const candidate of legacy) {
                unlinkUnchangedRegularCacheFile(candidate);
            }
        }
    } catch (error) {
        Logger.debug('[tsgo] could not prune materialisation-plan engine caches', error);
    }
}

function unlinkUnchangedRegularCacheFile(candidate: ValidBatchGraphPlanCacheFile): void {
    try {
        const current = fs.lstatSync(candidate.path, { throwIfNoEntry: false });
        if (
            current?.isFile() &&
            !current.isSymbolicLink() &&
            current.dev === candidate.dev &&
            current.ino === candidate.ino
        ) {
            fs.unlinkSync(candidate.path);
        }
    } catch {
        // Retention is best-effort. A later successful publication gets another safe attempt.
    }
}

/** Child-process entry point; exported so it can reuse the production cache boundary. */
export function publishBatchGraphPlanInProcess(
    request: BatchGraphPlanProcessRequest
): BatchMaterialisationPlanTelemetry {
    const cache = new BatchGraphPlanCache(
        request.engine,
        { overlayPath: request.overlayPath } as ShadowManager,
        request.project
    );
    // MaterialisationPlanCache.write revalidates every source, exact file and directory proof.
    // Avoid doing the same complete filesystem pass twice inside the child process.
    const publication = cache.prepare(request.plan, request.collisionFallbackReasons, false);
    cache.publish(publication);
    return cache.telemetry();
}

function batchGraphMissInvalidatesWorkspaceIndex(reason: MaterialisationPlanMissReason): boolean {
    return (
        reason === 'input-missing' ||
        reason === 'input-presence-changed' ||
        reason === 'input-kind-changed' ||
        reason === 'source-signature-mismatch' ||
        reason === 'exact-content-mismatch' ||
        reason === 'validation-budget-exceeded' ||
        reason === 'directory-membership-mismatch'
    );
}

function kitFilesSettingsFromConfig(
    config: ResolvedSvelteConfig | undefined
): InternalHelpers.KitFilesSettings {
    const files: any = config?.config.kit?.files;
    if (!files) {
        return defaultKitFiles;
    }
    return {
        paramsPath: files.params ?? defaultKitFiles.paramsPath,
        serverHooksPath: files.hooks?.server ?? defaultKitFiles.serverHooksPath,
        clientHooksPath: files.hooks?.client ?? defaultKitFiles.clientHooksPath,
        universalHooksPath: files.hooks?.universal ?? defaultKitFiles.universalHooksPath
    };
}

/**
 * Verify that a resolved package is reachable through `fromPath`'s real node_modules ancestry.
 * Some package-runner environments add adapter lookup locations even when `require.resolve`
 * receives explicit paths. Those are valid fallbacks, but they are not user dependencies and
 * copying shims there would make their own imports resolve from the wrong package tree.
 */
function isInstalledFrom(
    packageName: string,
    fromPath: string,
    resolvedPackagePath: string
): boolean {
    let current = normalizePath(fromPath);
    let resolvedRealPath: string;
    try {
        resolvedRealPath = normalizePath(fs.realpathSync.native(resolvedPackagePath));
    } catch {
        return false;
    }
    const packageParts = packageName.split('/');
    for (;;) {
        const candidate = join(current, 'node_modules', ...packageParts);
        try {
            if (normalizePath(fs.realpathSync.native(candidate)) === resolvedRealPath) {
                return true;
            }
        } catch {
            // Keep walking through the package's normal node_modules ancestry.
        }
        const parent = dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
}

/**
 * The language server's tsgo overlay, driven as a batch instead of over LSP.
 *
 * `svelte-check` wants exactly what the editor wants — every `.svelte` file standing in for a
 * `.tsx` shadow that tsgo can resolve and check — but it wants it once, for the whole project,
 * rather than incrementally for the file under the cursor. That is a difference in *driving*,
 * not in the overlay itself, so this reuses {@link ShadowManager} verbatim: the same shadow
 * layout, the same merged `rootDirs`/`paths`/`files`, the same dependency scan.
 *
 * Sharing the overlay is the whole point. The two previous tsgo paths in svelte-check each built
 * their own, and each got module resolution subtly wrong in a way that produces no error of its
 * own — imports fall through to svelte's ambient `declare module '*.svelte'` and every component
 * silently types as `SvelteComponent<Record<string, any>, any, any>`. On a real project that was
 * 100 and 41 phantom errors against an oracle of 0.
 */
export class TsGoBatchOverlay {
    private readonly shadows: ShadowManager;
    private readonly shimFiles: string[];
    private readonly transformDiagnostics = new Map<string, Diagnostic>();
    private materialised = false;
    private ignoreRestoredMaterialisationPlan = false;

    private constructor(
        readonly engine: ResolvedTsGoEngine,
        readonly projectPath: string,
        private readonly tsconfigPath: string | undefined,
        shadows: ShadowManager,
        shimFiles: string[],
        readonly creationTimings: BatchOverlayCreationTimings,
        private readonly materialisationPlanCache: BatchGraphPlanCache,
        private readonly materialisationPlanLookup: BatchGraphPlanCacheLookup
    ) {
        this.shadows = shadows;
        this.shimFiles = shimFiles;
    }

    private materialisationPlanTelemetry(): BatchMaterialisationPlanTelemetry {
        return this.materialisationPlanCache.telemetry();
    }

    /** Compatibility for callers which only need to display the resolved executable path. */
    get tsgoPath(): string {
        return this.engine.binPath;
    }

    get overlayTsconfigPath(): string {
        return this.shadows.overlayTsconfigPath;
    }

    /** Clear transform-relevant config state before a checker watch-mode rebuild. */
    static invalidateConfigCache(): void {
        configLoader.invalidateConfigs();
        invalidateTsGoWorkspaceIndex();
    }

    /** Clear package/source graph indexes without reloading unchanged Svelte config modules. */
    static invalidateWorkspaceIndex(): void {
        invalidateTsGoWorkspaceIndex();
    }

    /**
     * Build an overlay for a project, or return undefined when no tsgo binary can be found —
     * in which case the caller should fall back to the JS engine rather than fail.
     */
    static async create(options: TsGoBatchOverlayOptions): Promise<TsGoBatchOverlay | undefined> {
        const now = () => performance.now();
        const creationStarted = now();
        let phaseStarted = creationStarted;
        const creationTimings: BatchOverlayCreationTimings = {
            resolveEngineAndProjectMs: 0,
            loadExplicitConfigMs: 0,
            resolveCompilerMs: 0,
            resolveShimsMs: 0,
            loadKitSettingsMs: 0,
            constructManagerMs: 0,
            lookupPlanMs: 0,
            restorePlanMs: 0,
            discoverProjectGraphMs: 0,
            discoverDependenciesMs: 0,
            primeConfigsMs: 0,
            totalMs: 0
        };
        if (options.quiet) {
            Logger.setLogErrorsOnly(true);
        }
        const engine = resolveTsGoEngine(options.workspacePath);
        if (!engine) {
            return undefined;
        }

        const tsconfigPath = options.tsconfigPath ?? findProjectTsconfig(options.workspacePath);
        const projectPath = tsconfigPath ? dirname(tsconfigPath) : options.workspacePath;
        const sourceRoot = findWorkspaceRoot(projectPath);
        creationTimings.resolveEngineAndProjectMs = now() - phaseStarted;

        // DocumentSnapshot reads accessors, namespace, custom-element and default-language
        // settings synchronously from Document.config. Prime the shared loader before any batch
        // Documents are transformed, and give an explicit --config the same scope as SvelteCheck.
        configLoader.setExplicitConfigScope(
            options.configPath
                ? {
                      configPath: options.configPath,
                      rootDirectory: projectPath
                  }
                : undefined
        );
        let projectConfig: ResolvedSvelteConfig | undefined;
        phaseStarted = now();
        if (options.configPath) {
            projectConfig = await configLoader.awaitResolvedConfigForDirectory(projectPath);
        }
        creationTimings.loadExplicitConfigMs = now() - phaseStarted;

        // The project's own Svelte compiler, so the transform matches what it builds with.
        phaseStarted = now();
        const svelteCompiler = importSvelte(tsconfigPath || options.workspacePath);
        // Svelte 5 + `lang="ts"` only — the Rust JSDoc emission and version-4 mode produce
        // semantically different TSX (verified against this package's own sanity fixtures).
        const rsvelte = await preloadRsvelte(isRsvelteEnabled());
        creationTimings.resolveCompilerMs = now() - phaseStarted;
        const createSnapshotOptions = (
            compiler: ReturnType<typeof importSvelte>
        ): SvelteSnapshotOptions => {
            const svelteMajor = Number((compiler?.VERSION ?? '5').split('.')[0]);
            const useRust = !!rsvelte && svelteMajor >= 5;
            return {
                parse: compiler?.parse,
                version: compiler?.VERSION,
                // Unlike the editor, a batch check has no reason to keep going on a template that
                // doesn't parse: the Svelte diagnostic source reports the parse error, and checking
                // the script-only fallback would bury it under a cascade of consequences.
                transformOnTemplateError: false,
                typingsNamespace: 'svelteHTML',
                emitJsDoc: true,
                fastTransform: useRust
                    ? (text, opts) =>
                          opts.isTsFile
                              ? rsvelte!.svelte2tsx(text, {
                                    filename: opts.filename,
                                    isTsFile: true,
                                    mode: 'ts',
                                    version: '5',
                                    namespace: opts.namespace,
                                    accessors: opts.accessors
                                })
                              : undefined
                    : undefined,
                transformFingerprint: useRust ? rsvelte!.fingerprint : undefined
            };
        };
        const snapshotOptions = createSnapshotOptions(svelteCompiler);
        const snapshotOptionsByPackage = new Map<string, SvelteSnapshotOptions>();
        const resolveSnapshotOptions = (packageRoot: string): SvelteSnapshotOptions => {
            const key = normalizePath(packageRoot);
            const cached = snapshotOptionsByPackage.get(key);
            if (cached) {
                return cached;
            }
            let compiler = svelteCompiler;
            try {
                compiler = importSvelte(key, false);
            } catch (error) {
                Logger.debug(
                    `[tsgo] no package-local Svelte compiler at ${key}; using the project compiler`,
                    error
                );
            }
            const resolved = createSnapshotOptions(compiler);
            snapshotOptionsByPackage.set(key, resolved);
            return resolved;
        };

        // The generated code references `svelteHTML`, `__sveltets_*` and friends, which live in
        // svelte2tsx's shim d.ts files.
        //
        // The last argument is load-bearing. Those shims contain `import('svelte')` type
        // references that resolve relative to whichever directory they are read from; left in
        // this package's own `dist`, they drag *our* Svelte into the user's program as a second
        // ambient `declare module 'svelte'`. When the shims sort first, that copy wins the
        // merge, `ComponentProps<T>` resolves to the Svelte 4 definition and collapses to
        // `never` for every Svelte 5 component. Passing a hidden-folder path copies them next to
        // the user's own Svelte instead, so there is only ever one.
        // Only relocate the global shims into the workspace when the workspace actually owns
        // the Svelte package they import. A first overlay creation makes `node_modules/.cache`;
        // on the next run `get_global_types` otherwise mistakes that bare node_modules directory
        // for a package installation, copies the shims there, and every `import('svelte')` inside
        // them becomes TS2307. That made identical cold and warm checks disagree in projects
        // which rely on the language server's fallback compiler.
        phaseStarted = now();
        let resolvedProjectSvelte = true;
        let sveltePackageInfo: ReturnType<typeof getPackageInfo>;
        try {
            sveltePackageInfo = getPackageInfo('svelte', projectPath, false);
        } catch {
            resolvedProjectSvelte = false;
            sveltePackageInfo = getPackageInfo('svelte', projectPath);
        }
        const hasProjectSvelte =
            resolvedProjectSvelte && isInstalledFrom('svelte', projectPath, sveltePackageInfo.path);
        let svelteTsPath: string;
        try {
            svelteTsPath = dirname(require.resolve('svelte2tsx'));
        } catch {
            svelteTsPath = __dirname;
        }
        const shimFiles = internalHelpers.get_global_types(
            ts.sys,
            sveltePackageInfo.version.major === 3,
            sveltePackageInfo.path,
            svelteTsPath,
            hasProjectSvelte ? projectPath : undefined
        );
        creationTimings.resolveShimsMs = now() - phaseStarted;

        const shimsByPackage = new Map<string, string[]>();
        const resolveShims = (packageRoot: string): string[] => {
            const key = normalizePath(packageRoot);
            const cached = shimsByPackage.get(key);
            if (cached) {
                return cached;
            }
            let resolved = shimFiles;
            try {
                const packageSvelte = getPackageInfo('svelte', key, false);
                if (!isInstalledFrom('svelte', key, packageSvelte.path)) {
                    throw new Error(`Svelte is not installed in ${key}'s node_modules ancestry`);
                }
                resolved = internalHelpers.get_global_types(
                    ts.sys,
                    packageSvelte.version.major === 3,
                    packageSvelte.path,
                    svelteTsPath,
                    key
                );
            } catch (error) {
                Logger.debug(
                    `[tsgo] no package-local Svelte shims at ${key}; using project shims`,
                    error
                );
            }
            shimsByPackage.set(key, resolved);
            return resolved;
        };

        phaseStarted = now();
        projectConfig ??= await configLoader.awaitResolvedConfigForDirectory(projectPath);
        const kitFiles = kitFilesSettingsFromConfig(projectConfig);
        creationTimings.loadKitSettingsMs = now() - phaseStarted;
        phaseStarted = now();
        const shadows = new ShadowManager({
            projectPath,
            sourceRoot,
            tsconfigPath,
            snapshotOptions,
            resolveSnapshotOptions,
            resolveShims,
            kitFiles
        });
        creationTimings.constructManagerMs = now() - phaseStarted;
        const materialisationPlanCache = new BatchGraphPlanCache(engine, shadows, {
            projectPath,
            sourceRoot,
            tsconfigPath,
            configPath: options.configPath
        });
        const materialisationPlanLookup = materialisationPlanCache.lookupAndRestore(shadows);
        creationTimings.lookupPlanMs = materialisationPlanLookup.lookupMs;
        creationTimings.restorePlanMs = materialisationPlanLookup.restoreMs;
        // Load only configs which own a component in the proven project/dependency graph. The
        // previous source-root crawl imported every Svelte/Vite config in a monorepo before the
        // graph was known (including unrelated applications); on an ambiguous graph,
        // findProjectSvelteFiles deliberately returns the broad fallback and preserves that
        // conservative behavior. Fingerprints are synchronous later, so prime every relevant
        // association now rather than recording a transient "no config" identity.
        phaseStarted = now();
        const projectFiles = [
            ...new Set([
                ...shadows.getProjectSvelteFileNames(),
                ...shadows.findProjectSvelteFiles()
            ])
        ];
        creationTimings.discoverProjectGraphMs = now() - phaseStarted;
        phaseStarted = now();
        const dependencyFiles = shadows.findDependencySvelteFiles();
        creationTimings.discoverDependenciesMs = now() - phaseStarted;
        phaseStarted = now();
        await Promise.all(
            [...new Set([...projectFiles, ...dependencyFiles])].map((file) =>
                configLoader.awaitConfig(file)
            )
        );
        creationTimings.primeConfigsMs = now() - phaseStarted;
        creationTimings.totalMs = now() - creationStarted;

        return new TsGoBatchOverlay(
            engine,
            projectPath,
            tsconfigPath,
            shadows,
            shimFiles,
            creationTimings,
            materialisationPlanCache,
            materialisationPlanLookup
        );
    }

    /**
     * Write the overlay tsconfig and a `.tsx` shadow for every `.svelte` file the project can
     * reach, then forget the snapshots again.
     *
     * Snapshots are dropped deliberately. Holding one per file would keep the generated text and
     * decoded mappings for the whole project alive for the entire run, and the only files whose
     * mappings are ever needed are the ones tsgo reports a diagnostic on — typically a handful.
     * {@link mapDiagnostics} re-transforms those on demand; svelte2tsx costs about a millisecond
     * a file, and the input is byte-identical, so the mapping is the same one that was written.
     */
    async materialise(): Promise<BatchMaterialiseResult> {
        return this.materialiseAttempt(true);
    }

    private async materialiseAttempt(
        retryIfCachedGraphChanges: boolean
    ): Promise<BatchMaterialiseResult> {
        const now = () => performance.now();
        const started = now();
        const phases: BatchMaterialisePhaseTimings = {
            projectGraphMs: 0,
            dependencyIndexMs: 0,
            prepareMirrorsMs: 0,
            writeOverlayConfigMs: 0,
            collectRootsMs: 0,
            readStateMs: 0,
            svelteFreshnessMs: 0,
            svelteReadMs: 0,
            svelteTransformMs: 0,
            svelteWriteMs: 0,
            sourceMirrorFreshnessMs: 0,
            sourceMirrorReadMs: 0,
            sourceMirrorRewriteMs: 0,
            sourceMirrorWriteMs: 0,
            supportFilesMs: 0,
            cleanupMs: 0,
            writeStateMs: 0,
            commitFingerprintsMs: 0,
            clearSnapshotsMs: 0,
            writePlanMs: 0
        };
        let phaseStarted = now();
        let configuredProjectFiles: string[] = [];
        let discoveredProjectFiles: string[] = [];
        let dependencyFiles: string[] = [];
        const discover = () => {
            phaseStarted = now();
            configuredProjectFiles = this.shadows.getProjectSvelteFileNames();
            discoveredProjectFiles = this.shadows.findProjectSvelteFiles();
            phases.projectGraphMs += now() - phaseStarted;
            phaseStarted = now();
            dependencyFiles = this.shadows.findDependencySvelteFiles();
            phases.dependencyIndexMs += now() - phaseStarted;
            phaseStarted = now();
            this.shadows.prepareBatchModuleMirrors();
            phases.prepareMirrorsMs += now() - phaseStarted;
        };
        discover();
        // Freeze the payload and directory membership proof before the first asynchronous
        // transform. Publication later recomputes every source signature and directory proof;
        // an edit racing materialisation therefore rejects this plan instead of pairing the old
        // graph with new input identities.
        let discoveredPlan =
            (!this.ignoreRestoredMaterialisationPlan && this.materialisationPlanLookup.plan) ||
            this.shadows.exportBatchGraphPlan();
        let planPublication = this.materialisationPlanCache.prepare(
            discoveredPlan,
            this.shadows.getBatchMirrorStats().fallbackReasons,
            !this.materialisationPlanLookup.hit
        );
        if (
            planPublication.discoveryStatus === 'stale' ||
            (this.materialisationPlanLookup.hit && !planPublication.discoveryCurrent)
        ) {
            // A structural edit raced the validated restore. Rebuild once from uncached inputs so
            // this run cannot serve the old graph; final guarded publication catches another race.
            invalidateTsGoWorkspaceIndex();
            this.ignoreRestoredMaterialisationPlan = true;
            this.shadows.invalidateStructuralCaches();
            discover();
            discoveredPlan = this.shadows.exportBatchGraphPlan();
            planPublication = this.materialisationPlanCache.prepare(
                discoveredPlan,
                this.shadows.getBatchMirrorStats().fallbackReasons
            );
        }
        const graph = {
            reachabilityFallbackReasons: [...this.shadows.reachabilityFallbackReasons],
            dependencyScope: this.shadows.getDependencyScopeStats(),
            collisionMirrors: this.shadows.getBatchMirrorStats(),
            materialisationPlan: this.materialisationPlanTelemetry()
        };

        // parseBaseConfig is authoritative. The broad workspace scan is still needed for
        // components reached through package boundaries, but it must never be allowed to drop an
        // explicit root merely because it lives in build/, a hidden directory or very deep path.
        phaseStarted = now();
        const declarationBackedRoots = new Set(
            this.shadows.getDeclarationBackedProjectSvelteFileNames().map(normalizePath)
        );
        const files = Array.from(
            new Set(
                [
                    ...configuredProjectFiles,
                    ...discoveredProjectFiles,
                    ...dependencyFiles,
                    ...this.shadows.getBatchMaterializedSvelteFiles()
                ]
                    .filter((file) => !declarationBackedRoots.has(normalizePath(file)))
                    .map(normalizePath)
            )
        );
        phases.collectRootsMs = now() - phaseStarted;

        // The generated extension is a semantic parse boundary: JS output must be `.jsx` so
        // native TypeScript consumes its JSDoc, while TS output remains `.tsx`. Resolve every
        // file's effective Svelte config before the final root list is exposed to the child.
        phaseStarted = now();
        await this.shadows.refreshShadowKinds(files);
        this.shadows.writeOverlayTsconfig(this.shimFiles);
        phases.writeOverlayConfigMs += now() - phaseStarted;

        const written = new Set<string>();
        phaseStarted = now();
        const previousState = this.readBatchState();
        phases.readStateMs = now() - phaseStarted;
        const nextState: BatchState = { version: BATCH_STATE_VERSION, entries: {} };
        const failures: Error[] = [];
        let transformedCount = 0;
        let reusedCount = 0;
        let writtenCount = 0;
        let svelteTransformedCount = 0;
        let svelteReusedCount = 0;
        let svelteWrittenCount = 0;
        let overlayConfigNeedsRewrite = false;
        for (const filePath of files) {
            phaseStarted = now();
            let shadowPath = normalizePath(this.shadows.getShadowPath(filePath));
            const previous = previousState.entries[filePath];
            let currentStat: StoredSourceStat | undefined;
            try {
                currentStat = readSourceStat(filePath);
            } catch {
                // The transform path below owns the deterministic per-file failure message.
            }
            const reuse = (state: StoredShadowState) => {
                written.add(shadowPath);
                nextState.entries[filePath] = state;
                if (state.parserError) {
                    this.transformDiagnostics.set(filePath, state.parserError);
                }
                reusedCount++;
                svelteReusedCount++;
            };
            const previousOutput =
                previous?.shadowPath === shadowPath &&
                previous.rewriteIdentity === this.shadows.batchRewriteIdentity &&
                this.shadows.isTransformFingerprintCurrent(filePath)
                    ? validateStoredOutput(previous, shadowPath)
                    : undefined;

            // The overwhelmingly common warm path: compare nanosecond stat identity and the
            // package transform fingerprint before reading even one source byte.
            if (
                previous &&
                currentStat &&
                sameSourceStat(previous.sourceStat, currentStat) &&
                previousOutput?.valid
            ) {
                reuse({ ...previous, outputStat: previousOutput.stat });
                phases.svelteFreshnessMs += now() - phaseStarted;
                continue;
            }
            phases.svelteFreshnessMs += now() - phaseStarted;

            try {
                phaseStarted = now();
                const source = readSourceWithIdentity(filePath, currentStat);
                phases.svelteReadMs += now() - phaseStarted;
                // A touch, checkout or copy can change metadata without changing content. The
                // content stamp proves the existing output is still authoritative, while the
                // package fingerprint prevents reuse across compiler/config/transform changes.
                if (
                    previous &&
                    previous.sourceContentStamp === source.contentStamp &&
                    previousOutput?.valid
                ) {
                    reuse({
                        ...previous,
                        sourceStat: source.stat,
                        outputStat: previousOutput.stat
                    });
                    continue;
                }
                phaseStarted = now();
                const document = new Document(pathToUrl(filePath), source.text);
                await document.configPromise;
                const snapshot = this.shadows.transform(document);
                const transformedShadowPath = normalizePath(this.shadows.getShadowPath(filePath));
                if (transformedShadowPath !== shadowPath) {
                    shadowPath = transformedShadowPath;
                    overlayConfigNeedsRewrite = true;
                }
                const generatedText = this.shadows.rewriteBatchModuleSpecifiers(
                    snapshot.getFullText(),
                    filePath
                );
                phases.svelteTransformMs += now() - phaseStarted;
                phaseStarted = now();
                const output = writeCurrentBatchOutput(
                    this.shadows,
                    shadowPath,
                    generatedText,
                    previousOutput?.valid === false
                );
                if (output.changed) {
                    writtenCount++;
                    svelteWrittenCount++;
                }
                if (fs.existsSync(shadowPath)) {
                    written.add(shadowPath);
                }
                phases.svelteWriteMs += now() - phaseStarted;

                const parserError: StoredParserError | null = snapshot.parserError
                    ? {
                          range: snapshot.parserError.range,
                          severity: DiagnosticSeverity.Error,
                          source: snapshot.scriptKind === ts.ScriptKind.TS ? 'ts' : 'js',
                          message: snapshot.parserError.message,
                          code: snapshot.parserError.code
                      }
                    : null;
                nextState.entries[filePath] = {
                    shadowPath,
                    rewriteIdentity: this.shadows.batchRewriteIdentity,
                    parserError,
                    sourceStat: source.stat,
                    sourceContentStamp: source.contentStamp,
                    outputStat: output.stat,
                    outputContentStamp: output.contentStamp
                };
                if (parserError) {
                    this.transformDiagnostics.set(filePath, parserError);
                }
                transformedCount++;
                svelteTransformedCount++;
            } catch (e) {
                this.shadows.removeShadow(shadowPath);
                failures.push(
                    new Error(
                        `could not materialise shadow for ${filePath}: ${
                            e instanceof Error ? e.message : String(e)
                        }`
                    )
                );
            }
        }

        if (overlayConfigNeedsRewrite) {
            phaseStarted = now();
            this.shadows.writeOverlayTsconfig(this.shimFiles);
            phases.writeOverlayConfigMs += now() - phaseStarted;
        }

        // When a component has an adjacent rune module, ordinary source roots and barrels must
        // enter the same mirror as the component. Otherwise native extension substitution finds
        // the real `Foo.svelte.ts` before rootDirs can route `Foo.svelte` to generated TSX.
        const sourceMirrorEntries = this.shadows.getBatchSourceMirrorEntries();
        let sourceMirrorCopiedCount = 0;
        let sourceMirrorRewrittenCount = 0;
        let sourceMirrorReusedCount = 0;
        let sourceMirrorWrittenCount = 0;
        for (const { originalPath, mirrorPath, kind } of sourceMirrorEntries) {
            phaseStarted = now();
            const previous = previousState.entries[originalPath];
            const rewriteIdentity =
                kind === 'script' ? this.shadows.batchRewriteIdentity : undefined;
            let currentStat: StoredSourceStat | undefined;
            try {
                currentStat = readSourceStat(originalPath);
            } catch {
                // The copy path below reports the deterministic failure.
            }
            const reuse = (state: StoredShadowState) => {
                written.add(mirrorPath);
                nextState.entries[originalPath] = state;
                reusedCount++;
                sourceMirrorReusedCount++;
            };
            const previousOutput =
                previous?.shadowPath === mirrorPath &&
                previous.rewriteIdentity === rewriteIdentity &&
                previous.mirrorKind === kind
                    ? validateStoredOutput(previous, mirrorPath)
                    : undefined;
            if (
                previous &&
                currentStat &&
                sameSourceStat(previous.sourceStat, currentStat) &&
                previousOutput?.valid
            ) {
                reuse({ ...previous, outputStat: previousOutput.stat });
                phases.sourceMirrorFreshnessMs += now() - phaseStarted;
                continue;
            }
            phases.sourceMirrorFreshnessMs += now() - phaseStarted;

            try {
                phaseStarted = now();
                const source = readSourceWithIdentity(originalPath, currentStat);
                phases.sourceMirrorReadMs += now() - phaseStarted;
                if (
                    previous &&
                    previous.sourceContentStamp === source.contentStamp &&
                    previousOutput?.valid
                ) {
                    reuse({
                        ...previous,
                        sourceStat: source.stat,
                        outputStat: previousOutput.stat
                    });
                    continue;
                }
                phaseStarted = now();
                const mirroredText =
                    kind === 'script'
                        ? this.shadows.rewriteBatchModuleSpecifiers(source.text, originalPath)
                        : source.text;
                phases.sourceMirrorRewriteMs += now() - phaseStarted;
                phaseStarted = now();
                const output = writeCurrentBatchOutput(
                    this.shadows,
                    mirrorPath,
                    mirroredText,
                    previousOutput?.valid === false
                );
                if (output.changed) {
                    writtenCount++;
                    sourceMirrorWrittenCount++;
                }
                written.add(mirrorPath);
                phases.sourceMirrorWriteMs += now() - phaseStarted;
                nextState.entries[originalPath] = {
                    shadowPath: mirrorPath,
                    rewriteIdentity,
                    mirrorKind: kind,
                    parserError: null,
                    sourceStat: source.stat,
                    sourceContentStamp: source.contentStamp,
                    outputStat: output.stat,
                    outputContentStamp: output.contentStamp
                };
                transformedCount++;
                if (kind === 'script') {
                    sourceMirrorRewrittenCount++;
                } else {
                    sourceMirrorCopiedCount++;
                }
            } catch (e) {
                this.shadows.removeShadow(mirrorPath);
                failures.push(
                    new Error(
                        `could not materialise source mirror for ${originalPath}: ${
                            e instanceof Error ? e.message : String(e)
                        }`
                    )
                );
            }
        }

        if (failures.length) {
            throw new AggregateError(
                failures,
                `failed to materialise ${failures.length} shadow(s):\n${failures
                    .map((failure) => `- ${failure.message}`)
                    .join('\n')}`
            );
        }

        if (batchGraphDiscoveryEvidenceIsComplete(discoveredPlan)) {
            // Validate the exact discovery evidence again before committing ownership/state: a
            // source, manifest, config or nested directory can change while transforms yield.
            // Restored hits reuse their stored stat identities; fresh/retry attempts revalidate
            // the complete discovery proof. Cache publication alone cannot repair diagnostics
            // already computed from a stale graph.
            const commitPublication =
                this.materialisationPlanLookup.hit && !this.ignoreRestoredMaterialisationPlan
                    ? this.materialisationPlanCache.revalidateHitAtCommit(
                          discoveredPlan,
                          this.shadows.getBatchMirrorStats().fallbackReasons
                      )
                    : this.materialisationPlanCache.prepare(
                          discoveredPlan,
                          this.shadows.getBatchMirrorStats().fallbackReasons
                      );
            if (!commitPublication.discoveryCurrent) {
                invalidateTsGoWorkspaceIndex();
                this.ignoreRestoredMaterialisationPlan = true;
                this.shadows.invalidateStructuralCaches();
                this.transformDiagnostics.clear();
                if (!retryIfCachedGraphChanges) {
                    throw new Error(
                        'project graph changed repeatedly during materialisation; retry the check'
                    );
                }
                return this.materialiseAttempt(false);
            }
            planPublication = commitPublication;
        }

        // Stale shadows are still roots of the project, so a component that was deleted since
        // the last run would keep reporting errors from a file that no longer exists. Kit
        // shadows were written during `writeOverlayTsconfig` and are live too.
        phaseStarted = now();
        const kitShadowPaths = this.shadows.getKitShadowPaths();
        for (const kitShadowPath of kitShadowPaths) {
            written.add(kitShadowPath);
        }
        const supportPaths = this.shadows.writeBatchMirrorPackageScopes();
        for (const supportPath of supportPaths) {
            written.add(supportPath);
        }
        phases.supportFilesMs = now() - phaseStarted;
        nextState.cleanupIdentity = batchCleanupIdentity(written);
        // The editor owns every materialised component shadow, not only collision mirrors. Keep
        // the checker on the same contract: `batchRewriteIdentity` is intentionally undefined in
        // projects without a collision, so using it as an ownership discriminator makes all
        // ordinary Svelte shadows disappear from this set and an editor-created owner record can
        // never become current on checker warm runs.
        const previousOwnedPaths = Object.values(previousState.entries).map(
            (entry) => entry.shadowPath
        );
        const liveOwnedPaths = Object.values(nextState.entries)
            .map((entry) => entry.shadowPath)
            .concat(supportPaths);
        // A normal warm check used to recursively readdir/stat the complete shared mirror even
        // after every source and output had proved reusable. The persisted live-path identity
        // makes that walk unnecessary when this manager owns exactly the same outputs and its
        // collision ownership record is still intact. Any deletion/rename/layout/config/source
        // change makes one of these identities differ and takes the full reconciliation path.
        const cleanupIsCurrent =
            transformedCount === 0 &&
            writtenCount === 0 &&
            previousState.cleanupIdentity === nextState.cleanupIdentity &&
            sameBatchOutputIdentities(previousState.entries, nextState.entries) &&
            this.shadows.isBatchMirrorOwnershipCurrent(liveOwnedPaths);
        phaseStarted = now();
        if (!cleanupIsCurrent) {
            this.shadows.reconcileBatchMirrorOwnership(previousOwnedPaths, liveOwnedPaths);
            this.shadows.pruneOrphanedShadows(written);
        }
        phases.cleanupMs = now() - phaseStarted;
        phaseStarted = now();
        this.writeBatchState(nextState);
        phases.writeStateMs = now() - phaseStarted;
        phaseStarted = now();
        this.shadows.commitFingerprints();
        phases.commitFingerprintsMs = now() - phaseStarted;
        phaseStarted = now();
        this.materialisationPlanCache.publish(planPublication);
        phases.writePlanMs = now() - phaseStarted;
        graph.materialisationPlan = this.materialisationPlanTelemetry();
        phaseStarted = now();
        this.shadows.clearSnapshots();
        phases.clearSnapshotsMs = now() - phaseStarted;
        this.materialised = true;

        return {
            shadowCount: written.size,
            transformedCount,
            reusedCount,
            writtenCount,
            durationMs: now() - started,
            phases,
            svelte: {
                candidateCount: files.length,
                transformedCount: svelteTransformedCount,
                reusedCount: svelteReusedCount,
                writtenCount: svelteWrittenCount
            },
            sourceMirrors: {
                candidateCount: sourceMirrorEntries.length,
                copiedCount: sourceMirrorCopiedCount,
                rewrittenCount: sourceMirrorRewrittenCount,
                reusedCount: sourceMirrorReusedCount,
                writtenCount: sourceMirrorWrittenCount
            },
            supportFiles: {
                kitShadowCount: kitShadowPaths.length,
                packageScopeCount: supportPaths.length
            },
            cleanup: {
                skipped: cleanupIsCurrent,
                previousOwnedCount: previousOwnedPaths.length,
                liveOwnedCount: liveOwnedPaths.length
            },
            graph
        };
    }

    /**
     * The `.svelte` files this check is answerable for: the ones the user's tsconfig resolves,
     * not the ones that merely needed a shadow.
     *
     * The distinction matters as soon as the project sits in a workspace. Shadows are written
     * for every `.svelte` file under the workspace root and inside dependencies, because a
     * component imported across a package boundary still has to resolve — but reporting Svelte
     * compiler warnings for all of those would mean a check of one package printing warnings
     * for every other package in the repo.
     */
    listProjectSvelteFiles(): string[] {
        if (!this.materialised) {
            throw new Error('materialise() must run before the project file list is known');
        }
        return this.shadows.getProjectSvelteFileNames();
    }

    /**
     * Translate the compiler's own file list back into files the user recognises.
     *
     * This is what the check is really answerable for. A project's tsconfig names its roots, but
     * the program is everything those roots reach — in a workspace that includes components from
     * sibling packages, which the classic engine reports Svelte compiler warnings for and which a
     * roots-only view would silently skip.
     */
    mapProgramFiles(programFiles: string[]): { all: string[]; svelte: string[] } {
        const all: string[] = [];
        const svelte: string[] = [];
        const seen = new Set<string>();
        for (const filePath of programFiles) {
            const original = this.shadows.getOriginalPath(filePath) ?? normalizePath(filePath);
            if (seen.has(original)) {
                continue;
            }
            seen.add(original);
            all.push(original);
            if (original.endsWith('.svelte')) {
                svelte.push(original);
            }
        }
        // Native TypeScript consumes an adjacent `.d.svelte.ts` declaration instead of the raw
        // component. The raw configured root still belongs to the independent Svelte/CSS pass.
        for (const original of this.shadows.getDeclarationBackedProjectSvelteFileNames()) {
            if (seen.has(original)) {
                continue;
            }
            seen.add(original);
            all.push(original);
            svelte.push(original);
        }
        return { all, svelte };
    }

    /**
     * Return generated-config roots which are absent from a native `--listFiles` result.
     *
     * A non-empty list is not by itself proof that the compiler completed program construction:
     * a killed, truncated or otherwise broken adapter can print a prefix of the program and still
     * exit successfully. The generated config's explicit `files` array is the authoritative root
     * set. Compare through the same generated→source mappings used for diagnostics so Svelte,
     * Kit and collision-mirror roots have one stable identity on both sides.
     */
    missingProgramRootFiles(programFiles: string[]): string[] {
        if (!this.materialised) {
            throw new Error('materialise() must run before program membership can be validated');
        }

        let config: unknown;
        try {
            config = JSON.parse(fs.readFileSync(this.overlayTsconfigPath, 'utf8'));
        } catch (error) {
            throw new Error(
                `could not read the materialised overlay config: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
        const files = (config as { files?: unknown }).files;
        if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
            throw new Error('materialised overlay config has no valid explicit root file list');
        }

        const identity = (filePath: string): string => {
            const absolute = isAbsolute(filePath)
                ? normalizePath(filePath)
                : normalizePath(resolve(dirname(this.overlayTsconfigPath), filePath));
            return normalizePath(
                this.shadows.getOriginalPath(absolute) ??
                    this.shadows.getBatchSourceOriginalPath(absolute) ??
                    absolute
            );
        };
        const listed = new Set(programFiles.map(identity));
        return [...new Set((files as string[]).map(identity).filter((file) => !listed.has(file)))];
    }

    /**
     * Translate diagnostics reported against generated files back onto the `.svelte` sources
     * they came from. Diagnostics on ordinary `.ts`/`.js` files pass through unchanged.
     */
    async mapDiagnostics(
        diagnostics: GeneratedDiagnostic[],
        fallbackPath: string,
        programFiles?: string[]
    ): Promise<FileDiagnostics[]> {
        if (!this.materialised) {
            throw new Error('materialise() must run before diagnostics can be mapped');
        }

        const byFile = new Map<string, GeneratedDiagnostic[]>();
        const mergedDiagnostics = [...diagnostics];
        const seenDiagnostics = new Set(diagnostics.map(generatedDiagnosticIdentity));
        for (const diagnostic of this.baseConfigurationDiagnostics()) {
            // Native tsgo can point through `extends` to the exact value in the user config,
            // whereas parseJsonConfigFileContent only gives our fallback diagnostic an unknown
            // 0:0 position. Prefer the native user-file copy when its semantics match.
            const nativeUserConfigCopy = diagnostics.some(
                (native) =>
                    !!native.filePath &&
                    /\.json$/i.test(native.filePath) &&
                    native.severity === diagnostic.severity &&
                    native.code === diagnostic.code &&
                    native.message === diagnostic.message
            );
            if (nativeUserConfigCopy) {
                continue;
            }
            const identity = generatedDiagnosticIdentity(diagnostic);
            if (!seenDiagnostics.has(identity)) {
                seenDiagnostics.add(identity);
                mergedDiagnostics.push(diagnostic);
            }
        }
        for (const diagnostic of mergedDiagnostics) {
            const key = normalizePath(diagnostic.filePath ?? fallbackPath);
            const existing = byFile.get(key);
            if (existing) {
                existing.push(diagnostic);
            } else {
                byFile.set(key, [diagnostic]);
            }
        }

        const includedTransformFiles = programFiles
            ? new Set(programFiles.map(normalizePath))
            : undefined;
        const results: FileDiagnostics[] = [];
        for (const [filePath, diagnostic] of this.transformDiagnostics) {
            if (includedTransformFiles && !includedTransformFiles.has(filePath)) {
                continue;
            }
            let text: string;
            try {
                text = fs.readFileSync(filePath, 'utf-8');
            } catch {
                continue;
            }
            results.push({ filePath, text, diagnostics: [diagnostic] });
        }
        for (const [filePath, fileDiagnostics] of byFile) {
            const sourceMirrorOriginal = this.shadows.getBatchSourceOriginalPath(filePath);
            if (sourceMirrorOriginal) {
                const mapped = await this.mapSourceMirrorDiagnostics(
                    sourceMirrorOriginal,
                    fileDiagnostics
                );
                if (mapped) {
                    results.push(mapped);
                }
                continue;
            }
            const kitShadow = this.shadows.getKitShadowByShadowPath(filePath);
            if (kitShadow) {
                const mapped = await this.mapKitDiagnostics(kitShadow, fileDiagnostics);
                if (mapped) {
                    results.push(mapped);
                }
                continue;
            }

            // A Kit file that has a shadow can still be dragged into the program by its own
            // generated `$types.d.ts`, which imports it by real path. Its untransformed self
            // reports exactly the implicit-`any` errors the shadow exists to prevent, so those
            // are dropped in favour of the shadow's.
            if (this.shadows.hasKitShadow(filePath)) {
                continue;
            }

            const originalPath = this.shadows.getOriginalPath(filePath);
            if (!originalPath) {
                results.push(await this.passThrough(filePath, fileDiagnostics));
                continue;
            }
            // A parser-error shadow is only a script fallback. Every native diagnostic against it
            // has a meaningless position, so the materialisation diagnostic is the whole answer.
            if (
                this.transformDiagnostics.has(originalPath) &&
                (!includedTransformFiles || includedTransformFiles.has(originalPath))
            ) {
                continue;
            }
            const mapped = await this.mapShadowDiagnostics(originalPath, fileDiagnostics);
            if (mapped) {
                results.push(mapped);
            }
        }
        return results;
    }

    /**
     * Map diagnostics on a SvelteKit shadow back onto the route file the user wrote.
     *
     * Kit shadows are not built by svelte2tsx and carry no source map — the transform is a list
     * of insertions, so the mapping is arithmetic: subtract everything inserted before this
     * point. Positions landing *inside* an insertion collapse to where it was inserted, which is
     * the closest thing to a truthful answer for code the user never wrote.
     */
    private async mapKitDiagnostics(
        kitShadow: KitShadow,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics | undefined> {
        let sourceText: string;
        let generatedText: string;
        try {
            sourceText = fs.readFileSync(kitShadow.originalPath, 'utf-8');
            generatedText = fs.readFileSync(kitShadow.shadowPath, 'utf-8');
        } catch {
            return undefined;
        }

        const sourceLineOffsets = getLineOffsets(sourceText);
        const generatedLineOffsets = getLineOffsets(generatedText);

        return {
            filePath: kitShadow.originalPath,
            text: sourceText,
            diagnostics: await Promise.all(
                fileDiagnostics.map(async (diagnostic) => {
                    const generatedOffset = offsetAt(
                        { line: diagnostic.line, character: diagnostic.character },
                        generatedText,
                        generatedLineOffsets
                    );
                    const start = boundedKitOriginalOffset(
                        generatedOffset,
                        kitShadow.addedCode,
                        sourceText.length
                    );
                    const mappedEnd = boundedKitOriginalOffset(
                        generatedDiagnosticEndOffset(
                            diagnostic,
                            generatedText,
                            generatedLineOffsets
                        ),
                        kitShadow.addedCode,
                        sourceText.length
                    );
                    const end = Math.max(start, mappedEnd);
                    return {
                        range: Range.create(
                            positionAt(start, sourceText, sourceLineOffsets),
                            positionAt(end, sourceText, sourceLineOffsets)
                        ),
                        severity: diagnostic.severity,
                        code: diagnostic.code,
                        message: diagnostic.message,
                        relatedInformation: await this.mapRelatedInformation(
                            diagnostic.relatedInformation,
                            diagnostic.code
                        )
                    };
                })
            )
        };
    }

    private async mapShadowDiagnostics(
        originalPath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics | undefined> {
        let sourceText: string;
        try {
            sourceText = fs.readFileSync(originalPath, 'utf-8');
        } catch {
            // The file went away between the check and the report. Nothing useful to say.
            return undefined;
        }

        const document = new Document(pathToUrl(originalPath), sourceText);
        await document.configPromise;
        const snapshot = this.shadows.transform(document);
        this.shadows.deleteSnapshot(originalPath);

        // The generated code is a fallback extract of the script block, so every position in it
        // is meaningless. Report the parse error and nothing else, as the editor does.
        if (snapshot.parserError) {
            return {
                filePath: originalPath,
                text: sourceText,
                diagnostics: [
                    {
                        range: snapshot.parserError.range,
                        severity: DiagnosticSeverity.Error,
                        source: snapshot.scriptKind === ts.ScriptKind.TS ? 'ts' : 'js',
                        message: snapshot.parserError.message,
                        code: snapshot.parserError.code
                    }
                ]
            };
        }

        const tsDiagnostics = this.toTsDiagnostics(
            snapshot,
            fileDiagnostics.map((diagnostic) => ({
                ...diagnostic,
                message: this.shadows.restoreBatchModuleSpecifiers(diagnostic.message)
            }))
        );
        const diagnostics: Diagnostic[] = [];
        for (const { tsDiagnostic, generatedDiagnostic } of tsDiagnostics) {
            const mapped = mapAndFilterDiagnostics([tsDiagnostic], document, snapshot);
            const relatedInformation = await this.mapRelatedInformation(
                generatedDiagnostic.relatedInformation,
                generatedDiagnostic.code
            );
            diagnostics.push(
                ...mapped.map((diagnostic) => ({
                    ...diagnostic,
                    ...(relatedInformation?.length ? { relatedInformation } : {})
                }))
            );
        }
        // A native diagnostic can live entirely in svelte2tsx-generated scaffolding. The
        // classic mapper intentionally filters it, and an empty mapped entry must not make the
        // source look like a member of a program that failed configuration before construction.
        if (!diagnostics.length) {
            return undefined;
        }
        return {
            filePath: originalPath,
            text: sourceText,
            diagnostics
        };
    }

    /**
     * Ordinary TS/JS mirrors only replace equal-length module specifiers. Their line/character
     * space is therefore identical to the authored source and needs no generated-code mapper.
     */
    private async mapSourceMirrorDiagnostics(
        originalPath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics | undefined> {
        let sourceText: string;
        try {
            sourceText = fs.readFileSync(originalPath, 'utf8');
        } catch {
            return undefined;
        }
        return {
            filePath: originalPath,
            text: sourceText,
            diagnostics: await Promise.all(
                fileDiagnostics.map(async (diagnostic): Promise<Diagnostic> => {
                    const relatedInformation = await this.mapRelatedInformation(
                        diagnostic.relatedInformation,
                        diagnostic.code
                    );
                    return {
                        range: Range.create(
                            { line: diagnostic.line, character: diagnostic.character },
                            generatedDiagnosticEnd(diagnostic)
                        ),
                        severity: diagnostic.severity,
                        code: diagnostic.code,
                        message: this.shadows.restoreBatchModuleSpecifiers(diagnostic.message),
                        ...(relatedInformation?.length ? { relatedInformation } : {})
                    };
                })
            )
        };
    }

    /**
     * Rebuild `ts.Diagnostic`s against the generated text.
     *
     * `mapAndFilterDiagnostics` is the same routine the JS engine uses, and it works in offsets
     * against a `ts.SourceFile` — so the line/character pairs the compiler printed have to be
     * turned back into offsets in the generated file before any of the Svelte-aware filtering
     * (Ω-marker regions, `moveBindingErrorMessage`, the false-positive suppressions) can run.
     */
    private toTsDiagnostics(
        snapshot: SvelteDocumentSnapshot,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Array<{ tsDiagnostic: ts.Diagnostic; generatedDiagnostic: GeneratedDiagnostic }> {
        const generatedText = snapshot.getFullText();
        const sourceFile = ts.createSourceFile(
            snapshot.filePath,
            generatedText,
            ts.ScriptTarget.Latest,
            true,
            snapshot.scriptKind
        );

        const converted: Array<{
            tsDiagnostic: ts.Diagnostic;
            generatedDiagnostic: GeneratedDiagnostic;
        }> = [];
        for (const diagnostic of fileDiagnostics) {
            let start: number;
            let end: number;
            try {
                start = sourceFile.getPositionOfLineAndCharacter(
                    diagnostic.line,
                    diagnostic.character
                );
                const endPosition = generatedDiagnosticEnd(diagnostic);
                end = sourceFile.getPositionOfLineAndCharacter(
                    endPosition.line,
                    endPosition.character
                );
            } catch {
                // The generated file the compiler saw and the one we just rebuilt disagree,
                // which means the source changed under us. Dropping beats a wrong squiggle.
                continue;
            }
            converted.push({
                generatedDiagnostic: diagnostic,
                tsDiagnostic: {
                    file: sourceFile,
                    start,
                    length: Math.max(1, end - start),
                    category:
                        diagnostic.severity === DiagnosticSeverity.Warning
                            ? ts.DiagnosticCategory.Warning
                            : ts.DiagnosticCategory.Error,
                    code: diagnostic.code,
                    messageText: diagnostic.message,
                    source: 'ts'
                }
            });
        }
        return converted;
    }

    /** Map related native locations with the same source/shadow rules as primary diagnostics. */
    private async mapRelatedInformation(
        related: GeneratedDiagnosticRelatedInformation[] | undefined,
        diagnosticCode?: number
    ): Promise<Diagnostic['relatedInformation'] | undefined> {
        if (!related?.length) {
            return undefined;
        }
        const mapped = await Promise.all(
            related
                .filter(
                    (item) =>
                        diagnosticCode !== 2741 || !isNativeOnlySveltePropsRelatedInformation(item)
                )
                .map(async (item) => {
                    const location = await this.mapGeneratedRelatedLocation(item);
                    return location
                        ? {
                              location,
                              message: this.shadows.restoreBatchModuleSpecifiers(item.message)
                          }
                        : undefined;
                })
        );
        const retained = mapped.filter((item): item is NonNullable<typeof item> => !!item);
        return retained.length ? retained : undefined;
    }

    private async mapGeneratedRelatedLocation(
        related: GeneratedDiagnosticRelatedInformation
    ): Promise<{ uri: string; range: Range } | undefined> {
        const filePath = normalizePath(related.filePath);
        const generatedRange = (text: string): Range => {
            const lineOffsets = getLineOffsets(text);
            const start = offsetAt(
                { line: related.line, character: related.character },
                text,
                lineOffsets
            );
            const end = offsetAt(generatedDiagnosticEnd(related), text, lineOffsets);
            return Range.create(
                positionAt(start, text, lineOffsets),
                positionAt(Math.min(text.length, Math.max(start, end)), text, lineOffsets)
            );
        };

        const kitShadow = this.shadows.getKitShadowByShadowPath(filePath);
        if (kitShadow) {
            try {
                const generatedText = fs.readFileSync(kitShadow.shadowPath, 'utf8');
                const sourceText = fs.readFileSync(kitShadow.originalPath, 'utf8');
                const generated = generatedRange(generatedText);
                const generatedLineOffsets = getLineOffsets(generatedText);
                const sourceLineOffsets = getLineOffsets(sourceText);
                const start = boundedKitOriginalOffset(
                    offsetAt(generated.start, generatedText, generatedLineOffsets),
                    kitShadow.addedCode,
                    sourceText.length
                );
                const mappedEnd = boundedKitOriginalOffset(
                    offsetAt(generated.end, generatedText, generatedLineOffsets),
                    kitShadow.addedCode,
                    sourceText.length
                );
                const end = Math.max(start, mappedEnd);
                return {
                    uri: pathToUrl(kitShadow.originalPath),
                    range: Range.create(
                        positionAt(start, sourceText, sourceLineOffsets),
                        positionAt(end, sourceText, sourceLineOffsets)
                    )
                };
            } catch {
                return undefined;
            }
        }

        const sourceMirrorOriginal = this.shadows.getBatchSourceOriginalPath(filePath);
        if (sourceMirrorOriginal) {
            try {
                const sourceText = fs.readFileSync(sourceMirrorOriginal, 'utf8');
                return {
                    uri: pathToUrl(sourceMirrorOriginal),
                    range: generatedRange(sourceText)
                };
            } catch {
                return undefined;
            }
        }

        const originalPath = this.shadows.getOriginalPath(filePath);
        if (originalPath) {
            try {
                const sourceText = fs.readFileSync(originalPath, 'utf8');
                const document = new Document(pathToUrl(originalPath), sourceText);
                await document.configPromise;
                const snapshot = this.shadows.transform(document);
                const generated = generatedRange(snapshot.getFullText());
                const start = snapshot.getOriginalPosition(generated.start);
                const end = snapshot.getOriginalPosition(generated.end);
                this.shadows.deleteSnapshot(originalPath);
                if (start.line < 0 || end.line < 0) {
                    return undefined;
                }
                return {
                    uri: pathToUrl(originalPath),
                    range: Range.create(start, end)
                };
            } catch {
                this.shadows.deleteSnapshot(originalPath);
                return undefined;
            }
        }

        try {
            const text = fs.readFileSync(filePath, 'utf8');
            return { uri: pathToUrl(filePath), range: generatedRange(text) };
        } catch {
            // The file may have disappeared between native checking and mapping. Dropping a
            // stale related location is safer than leaking a generated/nonexistent URI.
            return undefined;
        }
    }

    /** Diagnostics on a real file the user wrote: reported where the compiler put them. */
    private async passThrough(
        filePath: string,
        fileDiagnostics: GeneratedDiagnostic[]
    ): Promise<FileDiagnostics> {
        let text = '';
        try {
            text = fs.readFileSync(filePath, 'utf-8');
        } catch {
            // A diagnostic that names no file (config errors) lands here.
        }
        return {
            filePath,
            text,
            diagnostics: await Promise.all(
                fileDiagnostics.map(async (diagnostic): Promise<Diagnostic> => {
                    const relatedInformation = await this.mapRelatedInformation(
                        diagnostic.relatedInformation,
                        diagnostic.code
                    );
                    return {
                        range: Range.create(
                            { line: diagnostic.line, character: diagnostic.character },
                            generatedDiagnosticEnd(diagnostic)
                        ),
                        severity: diagnostic.severity,
                        code: diagnostic.code,
                        message: diagnostic.message,
                        ...(relatedInformation?.length ? { relatedInformation } : {}),
                        data: { positionUnknown: diagnostic.filePath === null }
                    };
                })
            )
        };
    }

    /** Where the overlay keeps its scaffolding, so callers can point a build info file there. */
    get overlayPath(): string {
        return this.shadows.overlayPath;
    }

    /** The tsconfig this overlay derives from, if the project had one. */
    get baseTsconfigPath(): string | undefined {
        return this.tsconfigPath;
    }

    /** Whether TypeScript read this file as part of the user's root/extended config graph. */
    isBaseConfigurationFile(filePath: string): boolean {
        return this.shadows.isBaseConfigInput(filePath);
    }

    /**
     * Whether the bundled config parser independently classified this native diagnostic as a
     * config-parse diagnostic. Compare code/category rather than wording because TS6 and TS7 can
     * phrase the same option error differently. This is only used for diagnostics without a file;
     * native TS7 remains the authority over whether a diagnostic exists at all.
     */
    matchesBaseConfigurationDiagnostic(diagnostic: GeneratedDiagnostic): boolean {
        return this.shadows
            .getBaseConfigDiagnostics()
            .some(
                (base) =>
                    base.code === diagnostic.code &&
                    mapTsDiagnosticSeverity(base.category) === diagnostic.severity
            );
    }

    /**
     * The overlay replaces the user's root `files` with resolved roots plus native shims. That
     * intentionally lets empty/solution configs own editor documents, but it also makes tsgo
     * stop reporting TS18002/TS18003 from a genuinely empty user config. Preserve the config
     * parser's no-input diagnostics and merge them with native output against the user file.
     * All other option/configuration diagnostics are deliberately native-only: this package's
     * bundled JavaScript TypeScript can lag the selected TS7 engine and must not reject options
     * which are valid in that engine.
     */
    private baseConfigurationDiagnostics(): GeneratedDiagnostic[] {
        return this.shadows
            .getBaseConfigDiagnostics()
            .filter((diagnostic) => diagnostic.code === 18002 || diagnostic.code === 18003)
            .map((diagnostic) => {
                const position =
                    diagnostic.file && diagnostic.start != null
                        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
                        : { line: 0, character: 0 };
                return {
                    filePath: diagnostic.file?.fileName ?? null,
                    line: position.line,
                    character: position.character,
                    length: diagnostic.length ?? 1,
                    severity: mapTsDiagnosticSeverity(diagnostic.category),
                    code: diagnostic.code,
                    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
                    relatedInformation: diagnostic.relatedInformation
                        ?.filter(
                            (
                                related
                            ): related is ts.DiagnosticRelatedInformation & {
                                file: ts.SourceFile;
                                start: number;
                            } => !!related.file && related.start != null
                        )
                        .map((related) => {
                            const relatedPosition = related.file.getLineAndCharacterOfPosition(
                                related.start
                            );
                            return {
                                filePath: related.file.fileName,
                                line: relatedPosition.line,
                                character: relatedPosition.character,
                                length: related.length ?? 1,
                                message: ts.flattenDiagnosticMessageText(related.messageText, '\n')
                            };
                        })
                };
            });
    }

    private get batchStatePath(): string {
        return join(this.overlayPath, 'batch-state.json');
    }

    private readBatchState(): BatchState {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.batchStatePath, 'utf-8')) as BatchState;
            if (parsed.version === BATCH_STATE_VERSION && parsed.entries) {
                return parsed;
            }
        } catch {
            // A missing, old or interrupted state file makes shadows cold, never incorrectly fresh.
        }
        return { version: BATCH_STATE_VERSION, entries: {} };
    }

    private writeBatchState(state: BatchState): void {
        const tempPath = `${this.batchStatePath}.${process.pid}.tmp`;
        try {
            fs.mkdirSync(dirname(this.batchStatePath), { recursive: true });
            const contents = JSON.stringify(state);
            if (
                fs.statSync(this.batchStatePath, { throwIfNoEntry: false })?.isFile() &&
                fs.readFileSync(this.batchStatePath, 'utf8') === contents
            ) {
                return;
            }
            fs.writeFileSync(tempPath, contents);
            fs.renameSync(tempPath, this.batchStatePath);
        } catch (error) {
            Logger.debug('[tsgo] could not persist batch shadow state', error);
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // Best effort; a future run treats the absent final state as cold.
            }
        }
    }
}

/**
 * TS7 adds this declaration-site note to missing component props while the classic TS6 oracle
 * does not. It carries no source-specific context beyond the primary TS2741 and is the only
 * compiler-version-only related record normalized at the adapter boundary.
 */
function isNativeOnlySveltePropsRelatedInformation(
    related: GeneratedDiagnosticRelatedInformation
): boolean {
    const filePath = normalizePath(related.filePath).toLowerCase();
    const message = related.message.toLowerCase();
    return (
        filePath.endsWith('/svelte/types/index.d.ts') &&
        message.includes("expected type comes from property 'props'") &&
        message.includes('componentconstructoroptions<')
    );
}

function batchGraphProjectIdentity(input: {
    projectPath: string;
    sourceRoot: string;
    tsconfigPath: string | undefined;
    configPath?: string;
}): string {
    return createHash('sha256')
        .update(
            JSON.stringify({
                projectPath: normalizePath(resolve(input.projectPath)),
                sourceRoot: normalizePath(resolve(input.sourceRoot)),
                tsconfigPath: input.tsconfigPath
                    ? normalizePath(resolve(input.tsconfigPath))
                    : null,
                configPath: input.configPath ? normalizePath(resolve(input.configPath)) : null
            })
        )
        .digest('base64url');
}

function batchGraphEngineIdentity(engine: ResolvedTsGoEngine): MaterialisationPlanEngineIdentity {
    // Launch commands, argument prefixes and API entries drive execution and editor-only feature
    // requests; none can change graph discovery, shadow layout or transform output. In
    // particular, standalone svelte-check can run under another Node executable and has no API
    // session, while the editor may use the verified bundled Effect API. Keeping those absolute
    // paths here gave identical package versions different cache keys and made stock + Effect
    // churn through the two-entry retention window.
    return {
        packageName: engine.packageName,
        version: engine.version
    };
}

function batchGraphLockfileInputs(plan: BatchGraphPlan): string[] {
    const names = [
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'bun.lock',
        'bun.lockb'
    ];
    const roots = new Set<string>();
    const sourceRoot = normalizePath(resolve(plan.project.sourceRoot));
    let current = normalizePath(resolve(plan.project.projectPath));
    for (;;) {
        roots.add(current);
        if (current === sourceRoot) {
            break;
        }
        const parent = normalizePath(dirname(current));
        if (parent === current || !isWithinPath(sourceRoot, parent)) {
            roots.add(sourceRoot);
            break;
        }
        current = parent;
    }
    return [...roots].flatMap((root) => names.map((name) => normalizePath(join(root, name))));
}

function batchGraphPlanFileInputs(
    plan: BatchGraphPlan,
    directoryRoots: readonly string[]
): {
    files: MaterialisationPlanFileInput[];
    validationOnlyFiles: MaterialisationPlanValidationOnlyFileInput[];
} {
    const inputs: MaterialisationPlanFileInput[] = [];
    const validationOnlyInputs = new Map<
        string,
        { input: MaterialisationPlanValidationOnlyFileInput; aliasAnchor?: string }
    >();
    const exactProofs = new Map(
        plan.exactInputProofs.map((input) => [
            `${input.kind}\0${normalizePath(resolve(input.path))}`,
            input
        ])
    );
    const layoutInputPaths = new Set(plan.layoutInputs.map((path) => normalizePath(resolve(path))));
    const sourceRealPaths = new Set<string>();
    for (const input of plan.sourceInputs) {
        try {
            sourceRealPaths.add(normalizePath(fs.realpathSync.native(resolve(input.path))));
        } catch {
            // The exact lexical source input remains authoritative when realpath is unavailable.
        }
    }
    const directoryPaths = new Set(directoryRoots.map((path) => normalizePath(resolve(path))));
    const directoryCoveragePaths = new Set(directoryPaths);
    const realDirectoryPaths = new Set<string>();
    for (const path of directoryPaths) {
        try {
            const realPath = normalizePath(fs.realpathSync.native(path));
            directoryCoveragePaths.add(realPath);
            realDirectoryPaths.add(realPath);
        } catch {
            // The lexical proof remains authoritative when a root cannot be canonicalised.
        }
    }
    const realPathByDirectory = new Map<string, string | null>();
    const coveredByDirectoryMembership = (
        filePath: string
    ): { aliasAnchor?: string } | undefined => {
        let current = normalizePath(dirname(filePath));
        for (;;) {
            if (
                directoryCoveragePaths.has(current) &&
                batchGraphDirectoryMembershipCoversPath(current, filePath)
            ) {
                return {};
            }
            let realCurrent = realPathByDirectory.get(current);
            if (realCurrent === undefined) {
                try {
                    realCurrent = normalizePath(fs.realpathSync.native(current));
                } catch {
                    realCurrent = null;
                }
                realPathByDirectory.set(current, realCurrent);
            }
            // Multiple workspace/pnpm spellings can point at the exact package root whose
            // membership was captured. Treat that alias as another root, but never infer
            // coverage merely because an arbitrary nested symlink lands somewhere below it.
            if (
                realCurrent !== null &&
                realDirectoryPaths.has(realCurrent) &&
                layoutInputPaths.has(current) &&
                typeof materialisationPlanLayoutTopologyProof(
                    exactProofs.get(`layout\0${current}`)?.proof
                ) === 'string' &&
                batchGraphDirectoryMembershipCoversPath(current, filePath)
            ) {
                return { aliasAnchor: current };
            }
            const parent = normalizePath(dirname(current));
            if (parent === current) {
                return undefined;
            }
            current = parent;
        }
    };
    const inputsByPath = new Map<string, number>();
    const add = (input: MaterialisationPlanFileInput) => {
        const path = normalizePath(resolve(input.path));
        // A recursive proof owns membership below the root, but validator v3 does not bind the
        // root's own lexical symlink spelling/kind. Retain an exact layout anchor for that root.
        if (directoryPaths.has(path) && input.kind !== 'layout') {
            return;
        }
        validationOnlyInputs.delete(path);
        const existingIndex = inputsByPath.get(path);
        if (existingIndex !== undefined) {
            const existing = inputs[existingIndex];
            if (existing.kind === 'source' && input.kind === 'layout') {
                inputs[existingIndex] = {
                    ...existing,
                    layoutTopologyProof: materialisationPlanLayoutTopologyProof(
                        input.discoveryProof
                    )
                };
            }
            return;
        }
        inputsByPath.set(path, inputs.length);
        inputs.push({ ...input, path } as MaterialisationPlanFileInput);
    };
    const addValidationOnly = (
        input: MaterialisationPlanValidationOnlyFileInput,
        aliasAnchor?: string
    ) => {
        const path = normalizePath(resolve(input.path));
        if (!inputsByPath.has(path) && !validationOnlyInputs.has(path)) {
            validationOnlyInputs.set(path, {
                input: { ...input, path },
                ...(aliasAnchor ? { aliasAnchor } : {})
            });
        }
    };
    for (const { path, signature } of plan.sourceInputs) {
        add({ kind: 'source', path, signature });
    }
    for (const path of plan.configInputs) {
        add({
            kind: 'config',
            path,
            discoveryProof: exactProofs.get(`config\0${normalizePath(resolve(path))}`)?.proof
        });
    }
    for (const path of plan.manifestInputs) {
        const normalizedPath = normalizePath(resolve(path));
        const discoveryProof = exactProofs.get(`manifest\0${normalizedPath}`)?.proof;
        // Recursive membership is a stronger and dramatically cheaper proof for an absent
        // descendant: creating the manifest necessarily changes that package-tree stamp. Keep
        // present manifests exact because their bytes, not merely their presence, shape exports.
        const coverage =
            discoveryProof === null ? coveredByDirectoryMembership(normalizedPath) : undefined;
        if (discoveryProof === null && coverage) {
            addValidationOnly(
                {
                    kind: 'manifest',
                    path: normalizedPath,
                    allowMissing: true,
                    discoveryProof
                },
                coverage.aliasAnchor
            );
            continue;
        }
        add({
            kind: 'manifest',
            path: normalizedPath,
            allowMissing: true,
            discoveryProof
        });
    }
    for (const path of batchGraphLockfileInputs(plan)) {
        add({ kind: 'lockfile', path, allowMissing: true });
    }
    for (const path of plan.layoutInputs) {
        const normalizedPath = normalizePath(resolve(path));
        const discoveryProof = exactProofs.get(`layout\0${normalizedPath}`)?.proof;
        let topologyOnly = false;
        try {
            topologyOnly = sourceRealPaths.has(
                normalizePath(fs.realpathSync.native(normalizedPath))
            );
        } catch {
            // Missing probes retain their ordinary exact/absence semantics.
        }
        // A missing descendant has no independent topology to retain: creating it necessarily
        // changes the membership stamp. A present alias of an exact source is redundant too when
        // the recursive proof sees every component below its retained root: membership proves the
        // lexical path while the source input proves the bytes. Intermediate symlinks deliberately
        // fail `coveredByDirectoryMembership` and remain exact.
        const foldable =
            discoveryProof === null || (topologyOnly && typeof discoveryProof === 'string');
        const coverage = foldable ? coveredByDirectoryMembership(normalizedPath) : undefined;
        if (foldable && coverage) {
            addValidationOnly(
                {
                    kind: 'layout',
                    path: normalizedPath,
                    allowMissing: true,
                    topologyOnly,
                    discoveryProof
                },
                coverage.aliasAnchor
            );
            continue;
        }
        add({
            kind: 'layout',
            path: normalizedPath,
            allowMissing: true,
            topologyOnly,
            discoveryProof
        });
    }
    // Alias-derived coverage is valid only while the alias itself remains an exact persisted
    // topology anchor. Fall back to an ordinary stored exact input if a future input merge or
    // filtering change fails to preserve that dependency.
    for (const [path, folded] of validationOnlyInputs) {
        if (!folded.aliasAnchor) {
            continue;
        }
        const expectedTopology = materialisationPlanLayoutTopologyProof(
            exactProofs.get(`layout\0${folded.aliasAnchor}`)?.proof
        );
        const anchorIndex = inputsByPath.get(folded.aliasAnchor);
        const anchor = anchorIndex === undefined ? undefined : inputs[anchorIndex];
        const retained =
            typeof expectedTopology === 'string' &&
            ((anchor?.kind === 'source' && anchor.layoutTopologyProof === expectedTopology) ||
                (anchor?.kind === 'layout' &&
                    materialisationPlanLayoutTopologyProof(anchor.discoveryProof) ===
                        expectedTopology));
        if (!retained) {
            validationOnlyInputs.delete(path);
            add(folded.input);
        }
    }
    return {
        files: inputs,
        validationOnlyFiles: [...validationOnlyInputs.values()].map(({ input }) => input)
    };
}

/**
 * Prove that every fact used to construct the payload carries evidence from that same discovery
 * pass. This check is intentionally filesystem-free: the detached publisher may skip a duplicate
 * read pass, but it may never fill a missing discovery proof with whatever happens to exist later.
 */
function batchGraphDiscoveryEvidenceIsComplete(plan: BatchGraphPlan): boolean {
    if (
        plan.sourceInputs.some(
            (input) =>
                typeof input.path !== 'string' ||
                input.path.length === 0 ||
                typeof input.signature !== 'string' ||
                input.signature.length === 0
        )
    ) {
        return false;
    }
    const exactProofs = new Map(
        plan.exactInputProofs.map((input) => [
            `${input.kind}\0${normalizePath(resolve(input.path))}`,
            input.proof
        ])
    );
    const sourcePaths = new Set(
        plan.sourceInputs.map((input) => normalizePath(resolve(input.path)))
    );
    const hasExactProof = (kind: 'config' | 'manifest' | 'layout', filePath: string) => {
        const path = normalizePath(resolve(filePath));
        const key = `${kind}\0${path}`;
        if (!exactProofs.has(key)) {
            return false;
        }
        const proof = exactProofs.get(key);
        if (kind !== 'layout') {
            return true;
        }
        const topologyProof = materialisationPlanLayoutTopologyProof(proof);
        return sourcePaths.has(path)
            ? typeof topologyProof === 'string'
            : proof === null || typeof topologyProof === 'string';
    };
    if (
        plan.configInputs.some((path) => !hasExactProof('config', path)) ||
        plan.manifestInputs.some((path) => !hasExactProof('manifest', path)) ||
        plan.layoutInputs.some((path) => !hasExactProof('layout', path))
    ) {
        return false;
    }
    const directoryProofs = new Set(
        plan.directoryProofs.map((proof) => normalizePath(resolve(proof.path)))
    );
    return plan.directoryRoots.every((root) => directoryProofs.has(normalizePath(resolve(root))));
}

function batchGraphDiscoveryEvidenceStatus(
    plan: BatchGraphPlan
): BatchGraphDiscoveryEvidenceStatus {
    if (!batchGraphDiscoveryEvidenceIsComplete(plan)) {
        return 'incomplete';
    }
    const fileInputs = batchGraphPlanFileInputs(plan, plan.directoryRoots);
    for (const input of fileInputs.files) {
        if (input.kind !== 'source') {
            continue;
        }
        try {
            if (
                computeBatchGraphSourceSignature(fs.readFileSync(input.path, 'utf8')) !==
                input.signature
            ) {
                return 'stale';
            }
            if (
                input.layoutTopologyProof !== undefined &&
                materialisationPlanLayoutTopologyProof(
                    materialisationPlanExactFileProof(input.path, 'layout')
                ) !== input.layoutTopologyProof
            ) {
                return 'stale';
            }
        } catch {
            return 'unverifiable';
        }
    }
    for (const input of [...fileInputs.files, ...fileInputs.validationOnlyFiles]) {
        if (input.kind === 'source' || input.kind === 'lockfile') {
            continue;
        }
        if (input.discoveryProof === undefined) {
            return 'incomplete';
        }
        try {
            if (
                materialisationPlanExactFileProof(input.path, input.kind) !== input.discoveryProof
            ) {
                return 'stale';
            }
        } catch {
            return 'unverifiable';
        }
    }
    const directoryProofs = new Map(
        plan.directoryProofs.map((proof) => [normalizePath(resolve(proof.path)), proof])
    );
    const directoryBudget = createBatchGraphDirectoryMembershipBudget({
        maxEntries: 500_000,
        maxDurationMs: 3_000
    });
    for (const root of plan.directoryRoots) {
        const path = normalizePath(resolve(root));
        const expected = directoryProofs.get(path);
        if (!expected) {
            return 'incomplete';
        }
        try {
            const current = batchGraphDirectoryMembership({
                path,
                validator: BATCH_GRAPH_DIRECTORY_VALIDATOR,
                budget: directoryBudget
            });
            if (!current) {
                return 'unverifiable';
            }
            if (current.stamp !== expected.stamp || current.entryCount !== expected.entryCount) {
                return 'stale';
            }
        } catch {
            return 'unverifiable';
        }
    }
    return 'current';
}

/**
 * A persisted plan is useful only when every membership root is narrow enough to validate on
 * each fresh checker process. Reject a root outside the workspace/dependency closure instead of
 * accidentally walking a home directory or filesystem root.
 */
function safeBatchGraphDirectoryRoots(plan: BatchGraphPlan): string[] | undefined {
    const sourceRoot = normalizePath(resolve(plan.project.sourceRoot));
    const dependencyRoots = (plan.dependencyScope?.roots ?? []).map((root) =>
        normalizePath(resolve(root))
    );
    const roots = [...new Set(plan.directoryRoots.map((root) => normalizePath(resolve(root))))];
    if (roots.length > MAX_BATCH_GRAPH_DIRECTORY_ROOTS) {
        return undefined;
    }
    for (const root of roots) {
        if (
            dirname(root) === root ||
            (!isWithinPath(sourceRoot, root) &&
                !dependencyRoots.some((dependencyRoot) => isWithinPath(dependencyRoot, root)))
        ) {
            return undefined;
        }
    }
    return roots.sort();
}

/**
 * A reachable dependency scope is cacheable from its narrow source proof. A declared fallback is
 * cacheable only when the broad closure itself completed and every package tree which supplied
 * that answer has both exact manifest/layout evidence and recursive membership evidence.
 *
 * This is deliberately redundant with ShadowManager's collector. The persisted-plan boundary is
 * where an accidentally incomplete future collector must fail closed instead of converting a
 * one-run broad correctness fallback into a durable omission.
 */
function dependencyScopeHasCompleteCacheProof(
    plan: BatchGraphPlan,
    safeDirectoryRoots: readonly string[] | undefined
): boolean {
    const scope = plan.dependencyScope;
    if (!scope || !scope.closureComplete || !safeDirectoryRoots) {
        return false;
    }
    if (scope.mode === 'reachable') {
        return scope.declaredRoot === null && scope.fallbackReasons.length === 0;
    }
    if (
        scope.declaredRoot === null ||
        scope.fallbackReasons.length === 0 ||
        plan.dependencySvelteFileScan === null
    ) {
        return false;
    }

    const declaredRoots = [scope.declaredRoot, ...scope.roots].map((root) =>
        normalizePath(resolve(root))
    );
    if (new Set(declaredRoots).size !== declaredRoots.length) {
        return false;
    }
    const directoryRoots = new Set(safeDirectoryRoots.map((root) => normalizePath(resolve(root))));
    const manifestInputs = new Set(
        plan.manifestInputs.map((input) => normalizePath(resolve(input)))
    );
    const layoutInputs = new Set(plan.layoutInputs.map((input) => normalizePath(resolve(input))));
    const sourceRoot = normalizePath(resolve(plan.project.sourceRoot));
    let realSourceRoot = sourceRoot;
    try {
        realSourceRoot = normalizePath(fs.realpathSync(sourceRoot));
    } catch {
        // The lexical source-root proof remains authoritative when realpath is unavailable.
    }
    const workspaceAuthoredRoot = (root: string): string | undefined => {
        try {
            const realRoot = normalizePath(fs.realpathSync(root));
            const ownedRelative = normalizePath(relative(realSourceRoot, realRoot));
            if (
                ownedRelative.startsWith('..') ||
                isAbsolute(ownedRelative) ||
                ownedRelative.split('/').includes('node_modules')
            ) {
                return undefined;
            }
            return normalizePath(join(sourceRoot, ownedRelative));
        } catch {
            return !root.includes('/node_modules/') && isWithinPath(sourceRoot, root)
                ? root
                : undefined;
        }
    };
    const isCoveredByDirectoryProof = (root: string) => {
        const authoredRoot = workspaceAuthoredRoot(root);
        return (
            directoryRoots.has(root) ||
            (authoredRoot !== undefined && directoryRoots.has(authoredRoot)) ||
            (authoredRoot !== undefined && directoryRoots.has(sourceRoot))
        );
    };
    for (const root of declaredRoots) {
        if (
            !isCoveredByDirectoryProof(root) ||
            !manifestInputs.has(normalizePath(join(root, 'package.json'))) ||
            !layoutInputs.has(root)
        ) {
            return false;
        }
    }

    const evidencedFiles = new Set([
        ...plan.sourceInputs.map((input) => normalizePath(resolve(input.path))),
        ...layoutInputs
    ]);
    const graphFiles = [
        ...plan.projectSvelteFiles,
        ...(plan.projectSvelteFileScan ?? []),
        ...plan.batchReachableSourceFiles,
        ...plan.batchRootSourceFiles,
        ...plan.batchForwardSourceEdges.flatMap(([source, targets]) => [source, ...targets]),
        ...plan.batchReachablePackageImports.flatMap((input) =>
            input.resolvedFile ? [input.containingFile, input.resolvedFile] : [input.containingFile]
        ),
        ...plan.dependencySvelteFileScan
    ].map((file) => normalizePath(resolve(file)));
    if (graphFiles.some((file) => !evidencedFiles.has(file))) {
        return false;
    }

    // A dependency file outside every declared package tree would have exact content evidence,
    // but no membership proof to catch a sibling create/delete which changes the broad scan.
    let realDeclaredRoots: Set<string>;
    try {
        realDeclaredRoots = new Set(
            declaredRoots.map((root) => normalizePath(fs.realpathSync(root)))
        );
    } catch {
        return false;
    }
    return plan.dependencySvelteFileScan.every((file) =>
        isWithinAnyRealRoot(file, realDeclaredRoots)
    );
}

/**
 * Source reachability ambiguity is cacheable only after the broad workspace scan completed and
 * the source root itself is recursively membership-validated. A narrow reachable graph needs no
 * such fallback corpus.
 */
function projectScopeHasCompleteCacheProof(
    plan: BatchGraphPlan,
    safeDirectoryRoots: readonly string[] | undefined
): boolean {
    if (!plan.projectReachabilityFallbackReasons.length) {
        return true;
    }
    if (plan.projectSvelteFileScan === null || !safeDirectoryRoots) {
        return false;
    }
    const sourceRoot = normalizePath(resolve(plan.project.sourceRoot));
    return safeDirectoryRoots.some((root) => normalizePath(resolve(root)) === sourceRoot);
}

function isWithinAnyRealRoot(filePath: string, realRoots: ReadonlySet<string>): boolean {
    try {
        let current = normalizePath(fs.realpathSync(filePath));
        for (;;) {
            if (realRoots.has(current)) {
                return true;
            }
            const parent = normalizePath(dirname(current));
            if (parent === current) {
                return false;
            }
            current = parent;
        }
    } catch {
        return false;
    }
}

function isWithinPath(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

/**
 * Exact name/topology proof for files that can enter a TypeScript/Svelte graph. File contents
 * are validated separately; this catches creates, deletes, renames and symlink retargeting while
 * deliberately excluding dependency/VCS trees which have their own plan inputs.
 */
function readSourceStat(filePath: string): StoredSourceStat {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
        throw new Error(`not a regular file: ${filePath}`);
    }
    return {
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString()
    };
}

function validateStoredOutput(
    previous: StoredShadowState,
    outputPath: string
): { valid: true; stat: StoredSourceStat } | { valid: false } {
    try {
        const stat = readSourceStat(outputPath);
        if (sameSourceStat(previous.outputStat, stat)) {
            return { valid: true, stat };
        }
        const output = readSourceWithIdentity(outputPath, stat);
        return output.contentStamp === previous.outputContentStamp
            ? { valid: true, stat: output.stat }
            : { valid: false };
    } catch {
        return { valid: false };
    }
}

function writeCurrentBatchOutput(
    shadows: ShadowManager,
    outputPath: string,
    text: string,
    forceRewrite: boolean
): { changed: boolean; stat: StoredSourceStat; contentStamp: string } {
    if (forceRewrite) {
        shadows.removeShadow(outputPath);
    }
    let changed = shadows.writeShadow(outputPath, text);
    if (!changed) {
        const current = readSourceWithIdentity(outputPath);
        if (current.text === text) {
            return { changed: false, stat: current.stat, contentStamp: current.contentStamp };
        }
        // `lastWritten` is process-local and an external writer can replace a file without
        // invalidating it. Clear that stamp and overwrite rather than surfacing a false failure.
        shadows.removeShadow(outputPath);
        changed = shadows.writeShadow(outputPath, text);
        if (!changed) {
            throw new Error(`could not rewrite current batch output ${outputPath}`);
        }
    }
    return {
        changed,
        stat: readSourceStat(outputPath),
        contentStamp: textContentStamp(text)
    };
}

function textContentStamp(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('base64url');
}

function sameSourceStat(
    left: StoredSourceStat | undefined,
    right: StoredSourceStat | undefined
): boolean {
    return (
        !!left &&
        !!right &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs
    );
}

function batchCleanupIdentity(paths: Iterable<string>): string {
    return createHash('sha256')
        .update([...paths].map(normalizePath).sort().join('\0'))
        .digest('base64url');
}

function sameBatchOutputIdentities(
    previous: Record<string, StoredShadowState>,
    next: Record<string, StoredShadowState>
): boolean {
    const previousSources = Object.keys(previous);
    const nextSources = Object.keys(next);
    if (previousSources.length !== nextSources.length) {
        return false;
    }
    return nextSources.every((source) => {
        const left = previous[source];
        const right = next[source];
        return (
            !!left &&
            left.shadowPath === right.shadowPath &&
            left.rewriteIdentity === right.rewriteIdentity &&
            left.mirrorKind === right.mirrorKind &&
            left.sourceContentStamp === right.sourceContentStamp &&
            left.outputContentStamp === right.outputContentStamp
        );
    });
}

function readSourceWithIdentity(
    filePath: string,
    initialStat?: StoredSourceStat
): { text: string; stat: StoredSourceStat; contentStamp: string } {
    let before = initialStat ?? readSourceStat(filePath);
    // A formatter/save can race materialisation. Retry once so the persisted stat identity and
    // content stamp always describe the exact bytes which produced the shadow.
    for (let attempt = 0; attempt < 2; attempt++) {
        const text = fs.readFileSync(filePath, 'utf8');
        const after = readSourceStat(filePath);
        if (sameSourceStat(before, after)) {
            return {
                text,
                stat: after,
                contentStamp: textContentStamp(text)
            };
        }
        before = after;
    }
    throw new Error(`source changed repeatedly while materialising ${filePath}`);
}

function generatedDiagnosticIdentity(diagnostic: GeneratedDiagnostic): string {
    return JSON.stringify([
        diagnostic.filePath,
        diagnostic.line,
        diagnostic.character,
        diagnostic.length,
        diagnostic.endLine,
        diagnostic.endCharacter,
        diagnostic.severity,
        diagnostic.code,
        diagnostic.message
    ]);
}

function generatedDiagnosticEnd(
    diagnostic: Pick<
        GeneratedDiagnostic | GeneratedDiagnosticRelatedInformation,
        'line' | 'character' | 'length' | 'endLine' | 'endCharacter'
    >
): Position {
    return diagnostic.endLine !== undefined && diagnostic.endCharacter !== undefined
        ? Position.create(diagnostic.endLine, diagnostic.endCharacter)
        : Position.create(diagnostic.line, diagnostic.character + diagnostic.length);
}

function generatedDiagnosticEndOffset(
    diagnostic: Pick<
        GeneratedDiagnostic | GeneratedDiagnosticRelatedInformation,
        'line' | 'character' | 'length' | 'endLine' | 'endCharacter'
    >,
    text: string,
    lineOffsets: number[]
): number {
    return offsetAt(generatedDiagnosticEnd(diagnostic), text, lineOffsets);
}

/**
 * Map an offset from a SvelteKit upserted file back to authored text. `toOriginalPos` treats an
 * offset exactly at an insertion's left edge as though the insertion had already been consumed;
 * that is correct for a caret after generated code but wrong for a diagnostic end immediately
 * before it (`ssr| : boolean`). Give insertion boundaries left affinity so authored token spans
 * remain ordered and complete.
 */
function boundedKitOriginalOffset(
    generatedOffset: number,
    addedCode: InternalHelpers.AddedCode[],
    sourceLength: number
): number {
    const boundary = addedCode.find((added) => added.generatedPos === generatedOffset);
    const mapped =
        boundary?.originalPos ?? internalHelpers.toOriginalPos(generatedOffset, addedCode).pos;
    return Math.min(sourceLength, Math.max(0, mapped));
}

function mapTsDiagnosticSeverity(category: ts.DiagnosticCategory): DiagnosticSeverity {
    switch (category) {
        case ts.DiagnosticCategory.Warning:
            return DiagnosticSeverity.Warning;
        case ts.DiagnosticCategory.Suggestion:
            return DiagnosticSeverity.Hint;
        case ts.DiagnosticCategory.Message:
            return DiagnosticSeverity.Information;
        default:
            return DiagnosticSeverity.Error;
    }
}
