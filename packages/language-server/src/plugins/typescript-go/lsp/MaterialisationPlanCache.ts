import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import { basename, dirname, isAbsolute, resolve } from 'path';

/**
 * On-disk schema for the materialisation-plan cache. This is deliberately independent of the
 * shadow-layout version: callers must also put every graph/transform algorithm version in
 * `algorithm` so a change cannot accidentally resurrect an old graph.
 */
export const MATERIALISATION_PLAN_SCHEMA_VERSION = 3;

/** Built-in directory validators. Custom validators must use their own stable, versioned name. */
export const DIRECT_DIRECTORY_MEMBERSHIP = 'builtin:directory-membership:direct:v1';
export const RECURSIVE_DIRECTORY_MEMBERSHIP = 'builtin:directory-membership:recursive:v1';

/** Versioned native implementation a materialisation consumer will eventually invoke. */
export interface MaterialisationPlanEngineIdentity {
    packageName: string;
    version: string;
}

/**
 * Filesystem-safe key for the complete engine identity persisted in a materialisation plan.
 * Keep the unhashed identity in the cache body as the authority: this key only prevents two
 * independently valid engines from repeatedly overwriting the same file.
 */
export function materialisationPlanEngineCacheKey(
    engine: MaterialisationPlanEngineIdentity
): string {
    if (!isValidEngineIdentity(engine)) {
        throw new TypeError('materialisation plan engine identity must be complete and non-empty');
    }
    return createHash('sha256')
        .update(
            JSON.stringify({
                packageName: engine.packageName,
                version: engine.version
            })
        )
        .digest('hex');
}

export interface MaterialisationPlanIdentity {
    engine: MaterialisationPlanEngineIdentity;
    /** Version/hash of graph discovery, resolution, collision and rewrite algorithms. */
    algorithm: string;
    /** Exact project/config/compiler-options identity chosen by the caller. */
    project: string;
}

export type MaterialisationPlanExactFileKind = 'config' | 'manifest' | 'lockfile' | 'layout';

export type MaterialisationPlanFileInput =
    | {
          kind: 'source';
          path: string;
          /**
           * A stable signature of the source facts used to build the plan (normally imports and
           * exports), not necessarily a hash of the whole file. It is consulted only after the
           * nanosecond stat identity changes.
           */
          signature: string;
          /**
           * Topology component of the exact layout evidence captured by the discovery read for
           * this same lexical path. Source `signature` proves the graph-relevant bytes; this
           * separately guards publication across lexical/symlink/realpath changes without
           * turning later body-only edits into graph-cache misses.
           */
          layoutTopologyProof?: string | null;
      }
    | {
          kind: MaterialisationPlanExactFileKind;
          path: string;
          /** Record absence as an input so later creation invalidates the plan. */
          allowMissing?: boolean;
          /**
           * Preserve only topology when these bytes are already represented by a source input
           * resolving to the same file identity. This is accepted only when the captured realpath
           * is owned by a persisted, present source input.
           */
          topologyOnly?: boolean;
          /**
           * Exact proof observed by the read which produced the payload. When present, write()
           * refuses to pair that payload with bytes/topology which changed before publication.
           */
          discoveryProof?: string | null;
      };

/**
 * Exact discovery evidence which guards publication but is deliberately not persisted. This is
 * useful when a stronger persisted input (for example recursive directory membership) subsumes
 * lookup-time invalidation for the exact path while the original observation must still be
 * checked before the payload is committed.
 */
export type MaterialisationPlanValidationOnlyFileInput = Omit<
    Extract<MaterialisationPlanFileInput, { kind: MaterialisationPlanExactFileKind }>,
    'discoveryProof'
> & {
    discoveryProof: string | null;
};

export interface MaterialisationPlanDirectoryInput {
    path: string;
    /**
     * Use one of the exported built-ins, or a caller-owned stable/versioned validator name. A
     * custom validator is unavailable unless `directoryMembership` is supplied for both write
     * and lookup.
     */
    validator: string;
    /** Record absence as an input so later directory creation invalidates the plan. */
    allowMissing?: boolean;
    /**
     * Membership observed when the payload was discovered. `null` means the directory was
     * absent. Publication recomputes membership and rejects the payload if it no longer matches.
     */
    discoveryProof: DirectoryMembershipProof | null;
}

export interface DirectoryMembershipProof {
    /** A collision-resistant digest or an equally exact caller-owned stamp. */
    stamp: string;
    entryCount: number;
}

export interface DirectoryMembershipRequest {
    path: string;
    validator: string;
}

export type DirectoryMembershipProvider = (
    request: DirectoryMembershipRequest
) => DirectoryMembershipProof | undefined;

export type MaterialisationPlanDirectoryDiscovery = Omit<
    MaterialisationPlanDirectoryInput,
    'discoveryProof'
>;

export interface MaterialisationPlanWriteRequest<T> {
    /** Runtime-checked. Incomplete/ambiguous graphs are never persisted. */
    complete: true;
    payload: T;
    files: readonly MaterialisationPlanFileInput[];
    /** Checked against discovery evidence during write, then omitted from the stored plan. */
    validationOnlyFiles?: readonly MaterialisationPlanValidationOnlyFileInput[];
    directories?: readonly MaterialisationPlanDirectoryInput[];
    /** Recompute source graph facts at publication so old payloads cannot pair with new inputs. */
    sourceSignature?: (filePath: string) => string | undefined;
    directoryMembership?: DirectoryMembershipProvider;
}

export interface MaterialisationPlanLookupOptions {
    /** Required only when a source's exact stat identity changed. */
    sourceSignature?: (filePath: string) => string | undefined;
    /** Required for caller-owned directory validators. */
    directoryMembership?: DirectoryMembershipProvider;
    /**
     * Optional fail-closed bound for interactive callers. Exceeding either limit makes the
     * lookup a cache miss; callers then rebuild from authoritative inputs instead of keeping the
     * event loop busy proving that a metadata-churned cache is still reusable.
     */
    validationBudget?: MaterialisationPlanValidationBudget;
}

export interface MaterialisationPlanValidationBudget {
    /** Wall-clock time for the complete lookup, including cache read/parse/checksum work. */
    maxDurationMs?: number;
    /** Number of changed-stat inputs whose source/content proof may be recomputed. */
    maxContentFallbacks?: number;
}

export type MaterialisationPlanMissReason =
    | 'not-found'
    | 'read-error'
    | 'malformed'
    | 'schema-version-mismatch'
    | 'checksum-mismatch'
    | 'incomplete'
    | 'engine-mismatch'
    | 'algorithm-mismatch'
    | 'project-mismatch'
    | 'invalid-input-set'
    | 'input-missing'
    | 'input-presence-changed'
    | 'input-kind-changed'
    | 'source-signature-unavailable'
    | 'source-signature-error'
    | 'source-signature-mismatch'
    | 'exact-content-error'
    | 'exact-content-mismatch'
    | 'validation-budget-exceeded'
    | 'directory-validator-unavailable'
    | 'directory-membership-error'
    | 'directory-membership-mismatch';

export type MaterialisationPlanLookup<T> =
    | { hit: true; payload: T }
    | { hit: false; reason: MaterialisationPlanMissReason; detail?: string };

export type MaterialisationPlanWriteFailureReason =
    | 'incomplete'
    | 'invalid-payload'
    | 'invalid-input-set'
    | 'input-unavailable'
    | 'source-signature-unavailable'
    | 'source-signature-error'
    | 'source-signature-mismatch'
    | 'source-changed-during-write'
    | 'directory-validator-unavailable'
    | 'directory-membership-error'
    | 'directory-membership-mismatch'
    | 'write-error';

export type MaterialisationPlanWriteResult =
    | { ok: true; written: boolean }
    | { ok: false; reason: MaterialisationPlanWriteFailureReason; detail?: string };

export interface MaterialisationPlanCacheCounters {
    lookups: number;
    hits: number;
    misses: number;
    writes: number;
    writeSkips: number;
    writeFailures: number;
    statFastPathInputs: number;
    sourceSignatureFallbacks: number;
    exactContentFallbacks: number;
    directoryValidations: number;
    missReasons: Partial<Record<MaterialisationPlanMissReason, number>>;
    writeFailureReasons: Partial<Record<MaterialisationPlanWriteFailureReason, number>>;
}

interface StoredStat {
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    dev: string;
    ino: string;
    mode: string;
}

type StoredLexicalKind = 'file' | 'directory' | 'symlink' | 'other';
type StoredTargetKind = 'file' | 'directory' | 'missing' | 'other';

interface StoredFileInput {
    kind: 'source' | MaterialisationPlanExactFileKind;
    path: string;
    present: boolean;
    lexicalKind: StoredLexicalKind | null;
    targetKind: StoredTargetKind | null;
    linkTarget: string | null;
    realPath: string | null;
    stat: StoredStat | null;
    topologyOnly: boolean;
    /** Source signature or exact-content/layout digest. */
    proof: string | null;
}

interface StoredDirectoryInput {
    path: string;
    validator: string;
    present: boolean;
    stamp: string | null;
    entryCount: number;
}

interface StoredPlanBody {
    identity: MaterialisationPlanIdentity;
    complete: true;
    files: StoredFileInput[];
    directories: StoredDirectoryInput[];
    payload: unknown;
}

interface ObservedPath {
    lexicalKind: StoredLexicalKind;
    targetKind: StoredTargetKind;
    linkTarget: string | null;
    realPath: string | null;
    stat: StoredStat;
}

interface MaterialisationPlanValidationBudgetState {
    readonly startedAt: number;
    readonly maxDurationMs: number | undefined;
    readonly maxContentFallbacks: number | undefined;
    contentFallbacks: number;
}

const FILE_KINDS = new Set(['source', 'config', 'manifest', 'lockfile', 'layout']);
const EXACT_FILE_KINDS = new Set(['config', 'manifest', 'lockfile', 'layout']);
const LEXICAL_KINDS = new Set(['file', 'directory', 'symlink', 'other']);
const TARGET_KINDS = new Set(['file', 'directory', 'missing', 'other']);
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * A stable read of a cache file whose complete envelope and checksum passed validation. This does
 * not establish input freshness and must never be used as a lookup.
 */
export interface ValidMaterialisationPlanFile {
    identity: MaterialisationPlanIdentity;
    contents: string;
    dev: number;
    ino: number;
}

export function readValidMaterialisationPlanFile(
    cachePath: string,
    maxCacheBytes = DEFAULT_MAX_CACHE_BYTES
): ValidMaterialisationPlanFile | undefined {
    try {
        if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes <= 0) {
            return undefined;
        }
        const resolvedPath = resolve(cachePath);
        const stat = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > maxCacheBytes) {
            return undefined;
        }
        const contents = fs.readFileSync(resolvedPath, 'utf8');
        const after = fs.lstatSync(resolvedPath, { throwIfNoEntry: false });
        if (
            !after?.isFile() ||
            after.isSymbolicLink() ||
            after.dev !== stat.dev ||
            after.ino !== stat.ino ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs ||
            Buffer.byteLength(contents) > maxCacheBytes
        ) {
            return undefined;
        }
        const parsed: unknown = JSON.parse(contents);
        if (
            !isRecord(parsed) ||
            !hasExactKeys(parsed, ['body', 'checksum', 'schemaVersion']) ||
            parsed.schemaVersion !== MATERIALISATION_PLAN_SCHEMA_VERSION ||
            typeof parsed.checksum !== 'string' ||
            !isRecord(parsed.body) ||
            digest(JSON.stringify(parsed.body)) !== parsed.checksum ||
            !isStoredPlanBody(parsed.body)
        ) {
            return undefined;
        }
        return {
            identity: cloneIdentity(parsed.body.identity),
            contents,
            dev: stat.dev,
            ino: stat.ino
        };
    } catch {
        return undefined;
    }
}

/** Identity-only facade used by safe cache retention. */
export function readValidMaterialisationPlanIdentity(
    cachePath: string,
    maxCacheBytes = DEFAULT_MAX_CACHE_BYTES
): MaterialisationPlanIdentity | undefined {
    return readValidMaterialisationPlanFile(cachePath, maxCacheBytes)?.identity;
}

/**
 * A fail-closed, process-independent cache for the expensive *plan* which precedes shadow
 * materialisation. It intentionally knows nothing about ShadowManager's payload; the caller can
 * store any JSON graph after asserting that graph and its complete input set are unambiguous.
 */
export class MaterialisationPlanCache<T = unknown> {
    private readonly cachePath: string;
    private readonly identity: MaterialisationPlanIdentity;
    private readonly maxCacheBytes: number;
    private readonly mutableCounters: MaterialisationPlanCacheCounters = {
        lookups: 0,
        hits: 0,
        misses: 0,
        writes: 0,
        writeSkips: 0,
        writeFailures: 0,
        statFastPathInputs: 0,
        sourceSignatureFallbacks: 0,
        exactContentFallbacks: 0,
        directoryValidations: 0,
        missReasons: {},
        writeFailureReasons: {}
    };
    /** Parsed body whose complete input set was validated by the latest successful lookup. */
    private validatedPlan: StoredPlanBody | undefined;

    constructor(
        cachePath: string,
        identity: MaterialisationPlanIdentity,
        options: { maxCacheBytes?: number } = {}
    ) {
        this.cachePath = resolve(cachePath);
        if (!isValidIdentity(identity)) {
            throw new TypeError('materialisation plan identity must be complete and non-empty');
        }
        this.identity = cloneIdentity(identity);
        this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
        if (!Number.isSafeInteger(this.maxCacheBytes) || this.maxCacheBytes <= 0) {
            throw new TypeError('maxCacheBytes must be a positive safe integer');
        }
    }

    get counters(): MaterialisationPlanCacheCounters {
        return {
            ...this.mutableCounters,
            missReasons: { ...this.mutableCounters.missReasons },
            writeFailureReasons: { ...this.mutableCounters.writeFailureReasons }
        };
    }

    /**
     * Capture directory membership alongside graph discovery. The returned spec is later passed
     * to `write`, which recomputes the proof and refuses to publish a payload across a mutation.
     */
    snapshotDirectory(
        input: MaterialisationPlanDirectoryDiscovery,
        provider?: DirectoryMembershipProvider
    ): MaterialisationPlanDirectoryInput {
        fs.mkdirSync(dirname(this.cachePath), { recursive: true });
        const normalized = normalizeDirectorySpec({ ...input, discoveryProof: null });
        const stat = fs.statSync(normalized.path, { throwIfNoEntry: false });
        if (!stat) {
            if (!normalized.allowMissing) {
                throw new Error(`directory input is unavailable: ${normalized.path}`);
            }
            return { ...normalized, discoveryProof: null };
        }
        if (!stat.isDirectory()) {
            throw new Error(`directory input is not a directory: ${normalized.path}`);
        }
        const proof = this.directoryProof(normalized.path, normalized.validator, provider);
        if (!proof) {
            throw new Error(`directory validator is unavailable: ${normalized.validator}`);
        }
        if (!isDirectoryProof(proof)) {
            throw new Error(`directory membership proof is invalid: ${normalized.path}`);
        }
        return { ...normalized, discoveryProof: proof };
    }

    lookup(options: MaterialisationPlanLookupOptions = {}): MaterialisationPlanLookup<T> {
        const validationBudget = createValidationBudget(options.validationBudget);
        this.mutableCounters.lookups++;
        this.validatedPlan = undefined;
        let text: string;
        try {
            const stat = fs.statSync(this.cachePath, { throwIfNoEntry: false });
            if (!stat) {
                return this.miss('not-found');
            }
            if (!stat.isFile() || stat.size > this.maxCacheBytes) {
                return this.miss('read-error', 'cache is not a regular file or exceeds size limit');
            }
            text = fs.readFileSync(this.cachePath, 'utf8');
        } catch (error) {
            return this.miss('read-error', errorMessage(error));
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            return this.miss('malformed', errorMessage(error));
        }

        if (!isRecord(parsed)) {
            return this.miss('malformed', 'cache envelope is not an object');
        }
        if (parsed.schemaVersion !== MATERIALISATION_PLAN_SCHEMA_VERSION) {
            return this.miss('schema-version-mismatch');
        }
        if (!hasExactKeys(parsed, ['body', 'checksum', 'schemaVersion'])) {
            return this.miss('malformed', 'cache envelope has missing or unknown fields');
        }
        if (typeof parsed.checksum !== 'string' || !isRecord(parsed.body)) {
            return this.miss('malformed', 'cache envelope fields have invalid types');
        }
        if (digest(JSON.stringify(parsed.body)) !== parsed.checksum) {
            return this.miss('checksum-mismatch');
        }
        if (parsed.body.complete === false) {
            return this.miss('incomplete');
        }
        if (!isStoredPlanBody(parsed.body)) {
            return this.miss('malformed', 'cache body failed schema validation');
        }

        const plan = parsed.body;
        if (plan.complete !== true) {
            return this.miss('incomplete');
        }
        if (!sameEngineIdentity(plan.identity.engine, this.identity.engine)) {
            return this.miss('engine-mismatch');
        }
        if (plan.identity.algorithm !== this.identity.algorithm) {
            return this.miss('algorithm-mismatch');
        }
        if (plan.identity.project !== this.identity.project) {
            return this.miss('project-mismatch');
        }
        if (!hasUnambiguousInputSet(plan.files, plan.directories, this.cachePath)) {
            return this.miss('invalid-input-set');
        }

        // Directory membership is the cheapest broad invalidator after installs/checkouts. Check
        // it before tens of thousands of exact paths so a changed package topology fails fast.
        for (const input of plan.directories) {
            const exceeded = this.validationBudgetExceeded(validationBudget);
            if (exceeded) {
                return exceeded;
            }
            const failed = this.validateDirectoryInput(input, options.directoryMembership);
            if (failed) {
                return failed;
            }
        }
        for (const input of plan.files) {
            const exceeded = this.validationBudgetExceeded(validationBudget);
            if (exceeded) {
                return exceeded;
            }
            const failed = this.validateFileInput(input, options, validationBudget);
            if (failed) {
                return failed;
            }
        }

        const exceeded = this.validationBudgetExceeded(validationBudget);
        if (exceeded) {
            return exceeded;
        }

        this.validatedPlan = plan;
        this.mutableCounters.hits++;
        return { hit: true, payload: plan.payload as T };
    }

    /**
     * Revalidate the successful lookup in memory. File inputs retain their stored nanosecond stat
     * identities, so unchanged sources/configs avoid rereads and hashing; custom directories are
     * still checked exactly through the caller's bounded validator.
     */
    revalidate(options: MaterialisationPlanLookupOptions = {}): MaterialisationPlanLookup<T> {
        const validationBudget = createValidationBudget(options.validationBudget);
        const plan = this.validatedPlan;
        if (!plan) {
            return { hit: false, reason: 'not-found' };
        }
        for (const input of plan.directories) {
            const exceeded = this.validationBudgetExceeded(validationBudget);
            if (exceeded) {
                return exceeded;
            }
            const failed = this.validateDirectoryInput(input, options.directoryMembership);
            if (failed) {
                return failed;
            }
        }
        for (const input of plan.files) {
            const exceeded = this.validationBudgetExceeded(validationBudget);
            if (exceeded) {
                return exceeded;
            }
            const failed = this.validateFileInput(input, options, validationBudget);
            if (failed) {
                return failed;
            }
        }
        const exceeded = this.validationBudgetExceeded(validationBudget);
        if (exceeded) {
            return exceeded;
        }
        return { hit: true, payload: plan.payload as T };
    }

    write(request: MaterialisationPlanWriteRequest<T>): MaterialisationPlanWriteResult {
        if ((request as { complete?: unknown }).complete !== true) {
            return this.writeFailure('incomplete');
        }
        let validPayload = false;
        try {
            validPayload = isJsonValue(request.payload);
        } catch {
            // Accessors/proxies are not a stable JSON payload even when JSON.stringify happens
            // to succeed once.
        }
        if (!validPayload) {
            return this.writeFailure('invalid-payload');
        }

        try {
            // Creating the cache directory before membership capture prevents the cache itself
            // from manufacturing a one-time directory-creation miss.
            fs.mkdirSync(dirname(this.cachePath), { recursive: true });
        } catch (error) {
            return this.writeFailure('write-error', errorMessage(error));
        }

        const fileSpecs = [...request.files].map(normalizeFileSpec).sort(compareInputSpecs);
        const validationOnlyFileSpecs = [...(request.validationOnlyFiles ?? [])]
            .map(normalizeFileSpec)
            .sort(compareInputSpecs);
        const directorySpecs = [...(request.directories ?? [])]
            .map(normalizeDirectorySpec)
            .sort(compareInputSpecs);
        if (
            !hasUnambiguousSpecs(fileSpecs, validationOnlyFileSpecs, directorySpecs, this.cachePath)
        ) {
            return this.writeFailure('invalid-input-set');
        }

        const files: StoredFileInput[] = [];
        for (const spec of fileSpecs) {
            const captured = captureFileInput(spec, request.sourceSignature);
            if (!captured.ok) {
                return this.writeFailure(captured.reason, captured.detail);
            }
            files.push(captured.input);
        }
        const persistedSourceRealPaths = presentSourceRealPaths(files);
        if (!hasSafeMergedTopologyInputs(files, persistedSourceRealPaths)) {
            return this.writeFailure('invalid-input-set');
        }

        const directories: StoredDirectoryInput[] = [];
        for (const spec of directorySpecs) {
            const captured = this.captureDirectoryInput(spec, request.directoryMembership);
            if (!captured.ok) {
                return this.writeFailure(captured.reason, captured.detail);
            }
            directories.push(captured.input);
        }

        // Validate folded exact observations last so a directory proof captured after discovery
        // cannot legitimize a payload built from an earlier absence. These inputs intentionally do
        // not enter `files`: the persisted directory proof owns their warm-lookup invalidation.
        for (const spec of validationOnlyFileSpecs) {
            const captured = captureFileInput(spec, request.sourceSignature);
            if (!captured.ok) {
                return this.writeFailure(captured.reason, captured.detail);
            }
            if (
                captured.input.topologyOnly &&
                !hasSafeTopologyOwner(captured.input, persistedSourceRealPaths)
            ) {
                return this.writeFailure('invalid-input-set');
            }
        }

        const body: StoredPlanBody = {
            identity: cloneIdentity(this.identity),
            complete: true,
            files,
            directories,
            payload: request.payload
        };
        const bodyContents = JSON.stringify(body);
        const contents = `{"schemaVersion":${MATERIALISATION_PLAN_SCHEMA_VERSION},"body":${bodyContents},"checksum":${JSON.stringify(
            digest(bodyContents)
        )}}`;
        if (Buffer.byteLength(contents) > this.maxCacheBytes) {
            return this.writeFailure('write-error', 'cache exceeds size limit');
        }

        try {
            const previous = fs.statSync(this.cachePath, { throwIfNoEntry: false });
            if (
                previous?.isFile() &&
                previous.size === Buffer.byteLength(contents) &&
                fs.readFileSync(this.cachePath, 'utf8') === contents
            ) {
                this.mutableCounters.writeSkips++;
                return { ok: true, written: false };
            }
        } catch {
            // Failure to compare is not failure to persist; the atomic write below is decisive.
        }

        const tempPath = `${this.cachePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
        let descriptor: number | undefined;
        try {
            descriptor = fs.openSync(tempPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, contents, 'utf8');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(tempPath, this.cachePath);
            fsyncDirectoryBestEffort(dirname(this.cachePath));
            this.mutableCounters.writes++;
            return { ok: true, written: true };
        } catch (error) {
            if (descriptor !== undefined) {
                try {
                    fs.closeSync(descriptor);
                } catch {
                    // Best effort; the write has already failed closed.
                }
            }
            try {
                fs.unlinkSync(tempPath);
            } catch {
                // A future lookup ignores this unique temp file and only reads the final path.
            }
            return this.writeFailure('write-error', errorMessage(error));
        }
    }

    private validateFileInput(
        input: StoredFileInput,
        options: MaterialisationPlanLookupOptions,
        validationBudget: MaterialisationPlanValidationBudgetState | undefined
    ): MaterialisationPlanLookup<T> | undefined {
        let observed: ObservedPath | undefined;
        try {
            observed = observePath(input.path, input.kind === 'layout');
        } catch (error) {
            return this.miss('exact-content-error', `${input.path}: ${errorMessage(error)}`);
        }

        if (!observed) {
            return input.present ? this.miss('input-missing', input.path) : undefined;
        }
        if (!input.present) {
            return this.miss('input-presence-changed', input.path);
        }
        if (
            observed.lexicalKind !== input.lexicalKind ||
            observed.targetKind !== input.targetKind ||
            observed.linkTarget !== input.linkTarget ||
            observed.realPath !== input.realPath
        ) {
            return this.miss('input-kind-changed', input.path);
        }
        if (sameStat(observed.stat, input.stat)) {
            this.mutableCounters.statFastPathInputs++;
            return undefined;
        }

        if (input.kind === 'source') {
            if (!options.sourceSignature) {
                return this.miss('source-signature-unavailable', input.path);
            }
            const exceeded = this.consumeContentFallback(validationBudget);
            if (exceeded) {
                return exceeded;
            }
            let signature: string | undefined;
            this.mutableCounters.sourceSignatureFallbacks++;
            try {
                signature = options.sourceSignature(input.path);
            } catch (error) {
                return this.miss('source-signature-error', `${input.path}: ${errorMessage(error)}`);
            }
            if (typeof signature !== 'string' || signature.length === 0) {
                return this.miss('source-signature-error', input.path);
            }
            return signature === input.proof
                ? undefined
                : this.miss('source-signature-mismatch', input.path);
        }

        const exceeded = this.consumeContentFallback(validationBudget);
        if (exceeded) {
            return exceeded;
        }
        this.mutableCounters.exactContentFallbacks++;
        let proof: string;
        try {
            const exactProof = exactFileProof(input.path, input.kind, observed);
            proof = input.topologyOnly
                ? (materialisationPlanLayoutTopologyProof(exactProof) ?? '')
                : exactProof;
        } catch (error) {
            return this.miss('exact-content-error', `${input.path}: ${errorMessage(error)}`);
        }
        return proof === input.proof ? undefined : this.miss('exact-content-mismatch', input.path);
    }

    private consumeContentFallback(
        budget: MaterialisationPlanValidationBudgetState | undefined
    ): MaterialisationPlanLookup<T> | undefined {
        const exceeded = this.validationBudgetExceeded(budget);
        if (exceeded) {
            return exceeded;
        }
        if (
            budget?.maxContentFallbacks !== undefined &&
            budget.contentFallbacks >= budget.maxContentFallbacks
        ) {
            return this.miss(
                'validation-budget-exceeded',
                `content fallback limit ${budget.maxContentFallbacks} exceeded`
            );
        }
        if (budget) {
            budget.contentFallbacks++;
        }
        return undefined;
    }

    private validationBudgetExceeded(
        budget: MaterialisationPlanValidationBudgetState | undefined
    ): MaterialisationPlanLookup<T> | undefined {
        if (
            budget?.maxDurationMs !== undefined &&
            performance.now() - budget.startedAt >= budget.maxDurationMs
        ) {
            return this.miss(
                'validation-budget-exceeded',
                `duration limit ${budget.maxDurationMs}ms exceeded`
            );
        }
        return undefined;
    }

    private validateDirectoryInput(
        input: StoredDirectoryInput,
        provider: DirectoryMembershipProvider | undefined
    ): MaterialisationPlanLookup<T> | undefined {
        let exists: boolean;
        try {
            const stat = fs.statSync(input.path, { throwIfNoEntry: false });
            exists = !!stat;
            if (stat && !stat.isDirectory()) {
                return this.miss('input-kind-changed', input.path);
            }
        } catch (error) {
            return this.miss('directory-membership-error', `${input.path}: ${errorMessage(error)}`);
        }
        if (!exists) {
            return input.present ? this.miss('input-missing', input.path) : undefined;
        }
        if (!input.present) {
            return this.miss('input-presence-changed', input.path);
        }

        let proof: DirectoryMembershipProof | undefined;
        this.mutableCounters.directoryValidations++;
        try {
            proof = this.directoryProof(input.path, input.validator, provider);
        } catch (error) {
            return this.miss('directory-membership-error', `${input.path}: ${errorMessage(error)}`);
        }
        if (!proof) {
            return this.miss('directory-validator-unavailable', input.validator);
        }
        if (!isDirectoryProof(proof)) {
            return this.miss('directory-membership-error', input.path);
        }
        return proof.stamp === input.stamp && proof.entryCount === input.entryCount
            ? undefined
            : this.miss('directory-membership-mismatch', input.path);
    }

    private captureDirectoryInput(
        input: ReturnType<typeof normalizeDirectorySpec>,
        provider: DirectoryMembershipProvider | undefined
    ):
        | { ok: true; input: StoredDirectoryInput }
        | {
              ok: false;
              reason:
                  | 'input-unavailable'
                  | 'directory-validator-unavailable'
                  | 'directory-membership-error'
                  | 'directory-membership-mismatch';
              detail?: string;
          } {
        try {
            const stat = fs.statSync(input.path, { throwIfNoEntry: false });
            if (!stat) {
                if (input.discoveryProof !== null) {
                    return {
                        ok: false,
                        reason: 'directory-membership-mismatch',
                        detail: input.path
                    };
                }
                return input.allowMissing
                    ? {
                          ok: true,
                          input: {
                              path: input.path,
                              validator: input.validator,
                              present: false,
                              stamp: null,
                              entryCount: 0
                          }
                      }
                    : { ok: false, reason: 'input-unavailable', detail: input.path };
            }
            if (!stat.isDirectory()) {
                return { ok: false, reason: 'input-unavailable', detail: input.path };
            }
            if (input.discoveryProof === null) {
                return {
                    ok: false,
                    reason: 'directory-membership-mismatch',
                    detail: input.path
                };
            }
            const proof = this.directoryProof(input.path, input.validator, provider);
            if (!proof) {
                return {
                    ok: false,
                    reason: 'directory-validator-unavailable',
                    detail: input.validator
                };
            }
            if (!isDirectoryProof(proof)) {
                return {
                    ok: false,
                    reason: 'directory-membership-error',
                    detail: input.path
                };
            }
            if (
                proof.stamp !== input.discoveryProof.stamp ||
                proof.entryCount !== input.discoveryProof.entryCount
            ) {
                return {
                    ok: false,
                    reason: 'directory-membership-mismatch',
                    detail: input.path
                };
            }
            return {
                ok: true,
                input: {
                    path: input.path,
                    validator: input.validator,
                    present: true,
                    stamp: proof.stamp,
                    entryCount: proof.entryCount
                }
            };
        } catch (error) {
            return {
                ok: false,
                reason: 'directory-membership-error',
                detail: `${input.path}: ${errorMessage(error)}`
            };
        }
    }

    private directoryProof(
        directoryPath: string,
        validator: string,
        provider: DirectoryMembershipProvider | undefined
    ): DirectoryMembershipProof | undefined {
        if (validator === DIRECT_DIRECTORY_MEMBERSHIP) {
            return builtInDirectoryProof(directoryPath, false, this.cachePath);
        }
        if (validator === RECURSIVE_DIRECTORY_MEMBERSHIP) {
            return builtInDirectoryProof(directoryPath, true, this.cachePath);
        }
        return provider?.({ path: directoryPath, validator });
    }

    private miss(
        reason: MaterialisationPlanMissReason,
        detail?: string
    ): MaterialisationPlanLookup<T> {
        this.mutableCounters.misses++;
        this.mutableCounters.missReasons[reason] =
            (this.mutableCounters.missReasons[reason] ?? 0) + 1;
        return detail ? { hit: false, reason, detail } : { hit: false, reason };
    }

    private writeFailure(
        reason: MaterialisationPlanWriteFailureReason,
        detail?: string
    ): MaterialisationPlanWriteResult {
        this.mutableCounters.writeFailures++;
        this.mutableCounters.writeFailureReasons[reason] =
            (this.mutableCounters.writeFailureReasons[reason] ?? 0) + 1;
        return detail ? { ok: false, reason, detail } : { ok: false, reason };
    }
}

function captureFileInput(
    input: ReturnType<typeof normalizeFileSpec>,
    sourceSignature: ((filePath: string) => string | undefined) | undefined
):
    | { ok: true; input: StoredFileInput }
    | {
          ok: false;
          reason:
              | 'input-unavailable'
              | 'source-signature-unavailable'
              | 'source-signature-error'
              | 'source-signature-mismatch'
              | 'source-changed-during-write';
          detail: string;
      } {
    let observed: ObservedPath | undefined;
    try {
        observed = observePath(input.path, input.kind === 'layout');
    } catch (error) {
        return {
            ok: false,
            reason: 'input-unavailable',
            detail: `${input.path}: ${errorMessage(error)}`
        };
    }
    if (!observed) {
        if (input.kind !== 'source' && input.allowMissing) {
            if (input.discoveryProof !== undefined && input.discoveryProof !== null) {
                return {
                    ok: false,
                    reason: 'source-changed-during-write',
                    detail: input.path
                };
            }
            return {
                ok: true,
                input: {
                    kind: input.kind,
                    path: input.path,
                    present: false,
                    lexicalKind: null,
                    targetKind: null,
                    linkTarget: null,
                    realPath: null,
                    stat: null,
                    topologyOnly: input.topologyOnly,
                    proof: null
                }
            };
        }
        return { ok: false, reason: 'input-unavailable', detail: input.path };
    }
    if (input.kind !== 'layout' && observed.targetKind !== 'file') {
        return {
            ok: false,
            reason: 'input-unavailable',
            detail: `${input.path} is not a regular file`
        };
    }
    let proof: string;
    try {
        if (input.kind === 'source') {
            if (!sourceSignature) {
                return {
                    ok: false,
                    reason: 'source-signature-unavailable',
                    detail: input.path
                };
            }
            const currentSignature = sourceSignature(input.path);
            if (!currentSignature) {
                return {
                    ok: false,
                    reason: 'source-signature-unavailable',
                    detail: input.path
                };
            }
            if (currentSignature !== input.signature) {
                return {
                    ok: false,
                    reason: 'source-signature-mismatch',
                    detail: input.path
                };
            }
            if (input.layoutTopologyProof !== undefined) {
                const currentTopologyProof = materialisationPlanLayoutTopologyProof(
                    exactFileProof(input.path, 'layout', observed)
                );
                if (currentTopologyProof !== input.layoutTopologyProof) {
                    return {
                        ok: false,
                        reason: 'source-changed-during-write',
                        detail: input.path
                    };
                }
            }
            const after = observePath(input.path, false);
            if (
                !after ||
                after.targetKind !== 'file' ||
                after.lexicalKind !== observed.lexicalKind ||
                after.linkTarget !== observed.linkTarget ||
                after.realPath !== observed.realPath ||
                !sameStat(observed.stat, after.stat)
            ) {
                return {
                    ok: false,
                    reason: 'source-changed-during-write',
                    detail: input.path
                };
            }
            observed = after;
            proof = currentSignature;
        } else {
            const exactProof = exactFileProof(input.path, input.kind, observed);
            proof = input.topologyOnly
                ? (materialisationPlanLayoutTopologyProof(exactProof) ?? '')
                : exactProof;
            const discoveryProof = input.topologyOnly
                ? materialisationPlanLayoutTopologyProof(input.discoveryProof)
                : input.discoveryProof;
            if (input.discoveryProof !== undefined && discoveryProof !== proof) {
                return {
                    ok: false,
                    reason: 'source-changed-during-write',
                    detail: input.path
                };
            }
        }
    } catch (error) {
        return {
            ok: false,
            reason: input.kind === 'source' ? 'source-signature-error' : 'input-unavailable',
            detail: `${input.path}: ${errorMessage(error)}`
        };
    }
    if (!proof) {
        return {
            ok: false,
            reason: input.kind === 'source' ? 'source-signature-unavailable' : 'input-unavailable',
            detail: `${input.path} has an empty proof`
        };
    }
    return {
        ok: true,
        input: {
            kind: input.kind,
            path: input.path,
            present: true,
            lexicalKind: observed.lexicalKind,
            targetKind: observed.targetKind,
            linkTarget: observed.linkTarget,
            realPath: observed.realPath,
            stat: observed.stat,
            topologyOnly: input.topologyOnly,
            proof
        }
    };
}

/**
 * Capture the exact bytes/topology proof used by guarded publication. `null` represents an absent
 * optional input; callers decide whether absence is allowed for that input kind.
 */
export function materialisationPlanExactFileProof(
    filePath: string,
    kind: MaterialisationPlanExactFileKind
): string | null {
    const observed = observePath(resolve(filePath), kind === 'layout');
    return observed ? exactFileProof(resolve(filePath), kind, observed) : null;
}

function observePath(filePath: string, allowLayoutNode: boolean): ObservedPath | undefined {
    let lexical: fs.BigIntStats;
    try {
        lexical = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        if (isMissingError(error)) {
            return undefined;
        }
        throw error;
    }
    const lexicalKind = statKind(lexical);
    let linkTarget: string | null = null;
    let target = lexical;
    let targetKind = targetStatKind(lexical);
    if (lexicalKind === 'symlink') {
        linkTarget = fs.readlinkSync(filePath);
        try {
            target = fs.statSync(filePath, { bigint: true });
            targetKind = targetStatKind(target);
        } catch (error) {
            if (!allowLayoutNode || !isMissingError(error)) {
                throw error;
            }
            target = lexical;
            targetKind = 'missing';
        }
    }
    const realPath = targetKind === 'missing' ? null : safeRealpath(filePath);
    return {
        lexicalKind,
        targetKind,
        linkTarget,
        realPath,
        stat: storedStat(target)
    };
}

function exactFileProof(
    filePath: string,
    kind: MaterialisationPlanExactFileKind,
    observed: ObservedPath
): string {
    if (kind !== 'layout') {
        return digest(fs.readFileSync(filePath).toString('base64'));
    }
    // Layout files affect both resolution topology and the bytes resolved at that path. Keep the
    // topology digest separable so a source input at the same lexical path can preserve exactly
    // that provenance while retaining its graph-semantic content signature.
    const topologyProof = digest(
        [
            observed.lexicalKind,
            observed.linkTarget ?? '',
            observed.targetKind,
            observed.realPath ?? '<missing>'
        ].join('\0')
    );
    const contentProof =
        observed.targetKind === 'file'
            ? digest(fs.readFileSync(filePath).toString('base64'))
            : '<not-a-file>';
    return `layout-v2:${topologyProof}:${contentProof}`;
}

/** Extract the topology component of a current-format exact layout proof. */
export function materialisationPlanLayoutTopologyProof(
    proof: string | null | undefined
): string | null | undefined {
    if (proof === null || proof === undefined) {
        return proof;
    }
    const match = /^layout-v2:([^:]+):(?:[^:]+|<not-a-file>)$/.exec(proof);
    const topologyProof = match ? `layout-v2:${match[1]}` : undefined;
    return topologyProof && isLayoutTopologyProof(topologyProof) ? topologyProof : undefined;
}

function builtInDirectoryProof(
    root: string,
    recursive: boolean,
    cachePath: string
): DirectoryMembershipProof {
    const entries: string[] = [`@root\0${safeRealpath(root)}`];
    const cacheBase = basename(cachePath);
    const cacheDirectory = dirname(cachePath);
    const visit = (directory: string, prefix: string, ancestors: ReadonlySet<string>) => {
        const realDirectory = safeRealpath(directory);
        if (ancestors.has(realDirectory)) {
            throw new Error(`directory membership cycle at ${directory}`);
        }
        const nextAncestors = new Set(ancestors).add(realDirectory);
        const children = fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => lexicalCompare(left.name, right.name));
        for (const child of children) {
            const absolute = resolve(directory, child.name);
            if (
                absolute === cachePath ||
                (directory === cacheDirectory && child.name.startsWith(`${cacheBase}.tmp-`))
            ) {
                continue;
            }
            const name = prefix ? `${prefix}/${child.name}` : child.name;
            let kind = 'other';
            if (child.isFile()) {
                kind = 'file';
            } else if (child.isDirectory()) {
                kind = 'directory';
            } else if (child.isSymbolicLink()) {
                kind = `symlink:${fs.readlinkSync(absolute)}`;
            }
            entries.push(`${name}\0${kind}`);
            if (recursive && child.isDirectory()) {
                visit(absolute, name, nextAncestors);
            } else if (recursive && child.isSymbolicLink()) {
                // pnpm/npm workspace packages are commonly directory symlinks. A recursive
                // membership proof must observe their target membership too, while an ancestor
                // realpath set prevents cycles from escaping the fail-closed scan.
                let target: fs.Stats | undefined;
                try {
                    target = fs.statSync(absolute, { throwIfNoEntry: false });
                } catch (error) {
                    if (!isMissingError(error)) throw error;
                }
                if (target?.isDirectory()) {
                    const realTarget = safeRealpath(absolute);
                    if (nextAncestors.has(realTarget)) {
                        entries.push(`${name}\0cycle:${realTarget}`);
                    } else {
                        visit(absolute, name, nextAncestors);
                    }
                }
            }
        }
    };
    visit(root, '', new Set());
    return {
        stamp: digest(entries.join('\0')),
        entryCount: entries.length - 1
    };
}

function normalizeFileSpec(input: MaterialisationPlanFileInput) {
    return {
        ...input,
        path: resolve(input.path),
        allowMissing: input.kind === 'source' ? false : !!input.allowMissing,
        topologyOnly: input.kind === 'source' ? false : !!input.topologyOnly
    };
}

function createValidationBudget(
    input: MaterialisationPlanValidationBudget | undefined
): MaterialisationPlanValidationBudgetState | undefined {
    if (!input) {
        return undefined;
    }
    const { maxDurationMs, maxContentFallbacks } = input;
    if (maxDurationMs !== undefined && (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0)) {
        throw new TypeError('validationBudget.maxDurationMs must be a positive finite number');
    }
    if (
        maxContentFallbacks !== undefined &&
        (!Number.isSafeInteger(maxContentFallbacks) || maxContentFallbacks < 0)
    ) {
        throw new TypeError(
            'validationBudget.maxContentFallbacks must be a non-negative safe integer'
        );
    }
    return {
        startedAt: performance.now(),
        maxDurationMs,
        maxContentFallbacks,
        contentFallbacks: 0
    };
}

function normalizeDirectorySpec(input: MaterialisationPlanDirectoryInput) {
    return { ...input, path: resolve(input.path), allowMissing: !!input.allowMissing };
}

function compareInputSpecs(left: { path: string }, right: { path: string }): number {
    return lexicalCompare(left.path, right.path);
}

function hasUnambiguousSpecs(
    files: ReturnType<typeof normalizeFileSpec>[],
    validationOnlyFiles: ReturnType<typeof normalizeFileSpec>[],
    directories: ReturnType<typeof normalizeDirectorySpec>[],
    cachePath: string
): boolean {
    const seen = new Set<string>();
    const persistedFileKinds = new Map(files.map((file) => [file.path, file.kind]));
    const validationOnlyPaths = new Set(validationOnlyFiles.map((file) => file.path));
    for (const [index, file] of [...files, ...validationOnlyFiles].entries()) {
        const validationOnly = index >= files.length;
        if (
            file.path === cachePath ||
            seen.has(file.path) ||
            (file.kind === 'source' &&
                (typeof file.signature !== 'string' ||
                    file.signature.length === 0 ||
                    (file.layoutTopologyProof !== undefined &&
                        file.layoutTopologyProof !== null &&
                        !isLayoutTopologyProof(file.layoutTopologyProof)))) ||
            (file.kind !== 'source' && !EXACT_FILE_KINDS.has(file.kind)) ||
            (validationOnly &&
                (file.kind === 'source' ||
                    (file.topologyOnly && file.kind !== 'layout') ||
                    file.discoveryProof === undefined ||
                    (file.discoveryProof === null && !file.allowMissing)))
        ) {
            return false;
        }
        seen.add(file.path);
    }
    const seenDirectories = new Set<string>();
    for (const directory of directories) {
        const persistedKind = persistedFileKinds.get(directory.path);
        if (
            directory.path === cachePath ||
            seenDirectories.has(directory.path) ||
            validationOnlyPaths.has(directory.path) ||
            (persistedKind !== undefined && persistedKind !== 'layout') ||
            typeof directory.validator !== 'string' ||
            directory.validator.length === 0 ||
            (directory.discoveryProof === null
                ? !directory.allowMissing
                : !isDirectoryProof(directory.discoveryProof))
        ) {
            return false;
        }
        seenDirectories.add(directory.path);
    }
    return true;
}

function hasUnambiguousInputSet(
    files: StoredFileInput[],
    directories: StoredDirectoryInput[],
    cachePath: string
): boolean {
    const filePaths = files.map((input) => input.path);
    const directoryPaths = directories.map((input) => input.path);
    if ([...filePaths, ...directoryPaths].some((inputPath) => inputPath === cachePath)) {
        return false;
    }
    if (
        new Set(filePaths).size !== filePaths.length ||
        new Set(directoryPaths).size !== directoryPaths.length
    ) {
        return false;
    }
    const filesByPath = new Map(files.map((input) => [input.path, input]));
    if (
        directories.some((directory) => {
            const file = filesByPath.get(directory.path);
            return file !== undefined && file.kind !== 'layout';
        })
    ) {
        return false;
    }
    return isSorted(filePaths) && isSorted(directoryPaths) && hasSafeMergedTopologyInputs(files);
}

function presentSourceRealPaths(files: StoredFileInput[]): Set<string> {
    return new Set(
        files
            .filter(
                (input): input is StoredFileInput & { realPath: string } =>
                    input.kind === 'source' && input.present && typeof input.realPath === 'string'
            )
            .map((input) => input.realPath)
    );
}

function hasSafeTopologyOwner(
    input: StoredFileInput,
    sourceRealPaths: ReadonlySet<string>
): boolean {
    return (
        input.present && typeof input.realPath === 'string' && sourceRealPaths.has(input.realPath)
    );
}

function hasSafeMergedTopologyInputs(
    files: StoredFileInput[],
    sourceRealPaths: ReadonlySet<string> = presentSourceRealPaths(files)
): boolean {
    return files.every(
        (input) => !input.topologyOnly || hasSafeTopologyOwner(input, sourceRealPaths)
    );
}

function isSorted(values: string[]): boolean {
    return values.every(
        (value, index) => index === 0 || lexicalCompare(values[index - 1], value) <= 0
    );
}

function storedStat(stat: fs.BigIntStats): StoredStat {
    return {
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        mode: stat.mode.toString()
    };
}

function sameStat(left: StoredStat, right: StoredStat | null): boolean {
    return (
        !!right &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs &&
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode
    );
}

function statKind(stat: fs.BigIntStats): StoredLexicalKind {
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    if (stat.isSymbolicLink()) return 'symlink';
    return 'other';
}

function targetStatKind(stat: fs.BigIntStats): StoredTargetKind {
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
}

function isLayoutTopologyProof(value: string): boolean {
    return /^layout-v2:[^:]+$/.test(value);
}

function isStoredPlanBody(value: unknown): value is StoredPlanBody {
    if (!isRecord(value)) {
        return false;
    }
    if (!hasExactKeys(value, ['complete', 'directories', 'files', 'identity', 'payload'])) {
        return false;
    }
    if (value.complete !== true || !isValidIdentity(value.identity)) {
        return false;
    }
    if (!Array.isArray(value.files) || !value.files.every(isStoredFileInput)) {
        return false;
    }
    if (!Array.isArray(value.directories) || !value.directories.every(isStoredDirectoryInput)) {
        return false;
    }
    return isJsonValue(value.payload);
}

function isStoredFileInput(value: unknown): value is StoredFileInput {
    if (!isRecord(value)) return false;
    if (
        !hasExactKeys(value, [
            'kind',
            'lexicalKind',
            'linkTarget',
            'path',
            'present',
            'proof',
            'realPath',
            'stat',
            'targetKind',
            'topologyOnly'
        ]) ||
        !FILE_KINDS.has(value.kind as string) ||
        typeof value.path !== 'string' ||
        !isAbsolute(value.path) ||
        resolve(value.path) !== value.path ||
        typeof value.present !== 'boolean'
    ) {
        return false;
    }
    if (!value.present) {
        return (
            value.kind !== 'source' &&
            value.lexicalKind === null &&
            value.targetKind === null &&
            value.linkTarget === null &&
            value.realPath === null &&
            value.stat === null &&
            typeof value.topologyOnly === 'boolean' &&
            (!value.topologyOnly || value.kind === 'layout') &&
            value.proof === null
        );
    }
    return (
        typeof value.lexicalKind === 'string' &&
        LEXICAL_KINDS.has(value.lexicalKind) &&
        typeof value.targetKind === 'string' &&
        TARGET_KINDS.has(value.targetKind) &&
        (value.linkTarget === null || typeof value.linkTarget === 'string') &&
        (value.realPath === null ||
            (typeof value.realPath === 'string' && isAbsolute(value.realPath))) &&
        (value.targetKind === 'missing' ? value.realPath === null : value.realPath !== null) &&
        isStoredStat(value.stat) &&
        typeof value.topologyOnly === 'boolean' &&
        (!value.topologyOnly || value.kind === 'layout') &&
        typeof value.proof === 'string' &&
        value.proof.length > 0 &&
        (value.kind === 'layout' || value.targetKind === 'file')
    );
}

function isStoredDirectoryInput(value: unknown): value is StoredDirectoryInput {
    if (!isRecord(value)) return false;
    if (
        !hasExactKeys(value, ['entryCount', 'path', 'present', 'stamp', 'validator']) ||
        typeof value.path !== 'string' ||
        !isAbsolute(value.path) ||
        resolve(value.path) !== value.path ||
        typeof value.validator !== 'string' ||
        value.validator.length === 0 ||
        typeof value.present !== 'boolean' ||
        !Number.isSafeInteger(value.entryCount) ||
        (value.entryCount as number) < 0
    ) {
        return false;
    }
    return value.present
        ? typeof value.stamp === 'string' && value.stamp.length > 0
        : value.stamp === null && value.entryCount === 0;
}

function isStoredStat(value: unknown): value is StoredStat {
    return (
        isRecord(value) &&
        hasExactKeys(value, ['ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'size']) &&
        ['ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'size'].every(
            (key) => typeof value[key] === 'string' && /^\d+$/.test(value[key] as string)
        )
    );
}

function isValidIdentity(value: unknown): value is MaterialisationPlanIdentity {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ['algorithm', 'engine', 'project']) ||
        typeof value.algorithm !== 'string' ||
        value.algorithm.length === 0 ||
        typeof value.project !== 'string' ||
        value.project.length === 0
    ) {
        return false;
    }
    return isValidEngineIdentity(value.engine);
}

function isValidEngineIdentity(value: unknown): value is MaterialisationPlanEngineIdentity {
    if (!isRecord(value) || !hasExactKeys(value, ['packageName', 'version'])) {
        return false;
    }
    return (
        typeof value.packageName === 'string' &&
        value.packageName.length > 0 &&
        typeof value.version === 'string' &&
        value.version.length > 0
    );
}

function sameEngineIdentity(
    left: MaterialisationPlanEngineIdentity,
    right: MaterialisationPlanEngineIdentity
): boolean {
    return left.packageName === right.packageName && left.version === right.version;
}

function cloneIdentity(identity: MaterialisationPlanIdentity): MaterialisationPlanIdentity {
    return {
        engine: { ...identity.engine },
        algorithm: identity.algorithm,
        project: identity.project
    };
}

function isDirectoryProof(value: unknown): value is DirectoryMembershipProof {
    return (
        isRecord(value) &&
        typeof value.stamp === 'string' &&
        value.stamp.length > 0 &&
        Number.isSafeInteger(value.entryCount) &&
        (value.entryCount as number) >= 0
    );
}

function isJsonValue(value: unknown, ancestors = new Set<unknown>()): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    ancestors.add(value);
    let result: boolean;
    if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        result =
            keys.length === value.length + 1 &&
            keys[keys.length - 1] === 'length' &&
            keys
                .slice(0, -1)
                .every(
                    (key, index) => key === String(index) && isJsonValue(value[index], ancestors)
                );
    } else {
        const prototype = Object.getPrototypeOf(value);
        result =
            (prototype === Object.prototype || prototype === null) &&
            Reflect.ownKeys(value).every((key) => {
                if (typeof key !== 'string') return false;
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                return (
                    !!descriptor &&
                    descriptor.enumerable === true &&
                    'value' in descriptor &&
                    isJsonValue(descriptor.value, ancestors)
                );
            });
    }
    ancestors.delete(value);
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
        actual.length === expected.length && actual.every((key, index) => key === expected[index])
    );
}

function digest(value: string): string {
    return createHash('sha256').update(value).digest('base64url');
}

function safeRealpath(filePath: string): string {
    return fs.realpathSync.native(filePath);
}

function lexicalCompare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function fsyncDirectoryBestEffort(directory: string): void {
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    } catch {
        // Some platforms/filesystems do not permit directory fsync. The file rename remains
        // atomic; this only affects durability across a machine crash.
    } finally {
        if (descriptor !== undefined) {
            try {
                fs.closeSync(descriptor);
            } catch {
                // Best effort.
            }
        }
    }
}

function isMissingError(error: unknown): boolean {
    return (
        isRecord(error) &&
        typeof error.code === 'string' &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
