import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import { basename, dirname, isAbsolute, resolve } from 'path';

/**
 * On-disk schema for the materialisation-plan cache. This is deliberately independent of the
 * shadow-layout version: callers must also put every graph/transform algorithm version in
 * `algorithm` so a change cannot accidentally resurrect an old graph.
 */
export const MATERIALISATION_PLAN_SCHEMA_VERSION = 1;

/** Built-in directory validators. Custom validators must use their own stable, versioned name. */
export const DIRECT_DIRECTORY_MEMBERSHIP = 'builtin:directory-membership:direct:v1';
export const RECURSIVE_DIRECTORY_MEMBERSHIP = 'builtin:directory-membership:recursive:v1';

export interface MaterialisationPlanEngineIdentity {
    packageName: string;
    version: string;
    command: string;
    argsPrefix: string[];
    /** `null` is significant: it means this exact engine has no matching API entry. */
    apiEntry: string | null;
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
      }
    | {
          kind: MaterialisationPlanExactFileKind;
          path: string;
          /** Record absence as an input so later creation invalidates the plan. */
          allowMissing?: boolean;
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
    stat: StoredStat | null;
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
    stat: StoredStat;
}

const FILE_KINDS = new Set(['source', 'config', 'manifest', 'lockfile', 'layout']);
const EXACT_FILE_KINDS = new Set(['config', 'manifest', 'lockfile', 'layout']);
const LEXICAL_KINDS = new Set(['file', 'directory', 'symlink', 'other']);
const TARGET_KINDS = new Set(['file', 'directory', 'missing', 'other']);
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

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
        this.mutableCounters.lookups++;
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

        for (const input of plan.files) {
            const failed = this.validateFileInput(input, options);
            if (failed) {
                return failed;
            }
        }
        for (const input of plan.directories) {
            const failed = this.validateDirectoryInput(input, options.directoryMembership);
            if (failed) {
                return failed;
            }
        }

        this.mutableCounters.hits++;
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
        const directorySpecs = [...(request.directories ?? [])]
            .map(normalizeDirectorySpec)
            .sort(compareInputSpecs);
        if (!hasUnambiguousSpecs(fileSpecs, directorySpecs, this.cachePath)) {
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

        const directories: StoredDirectoryInput[] = [];
        for (const spec of directorySpecs) {
            const captured = this.captureDirectoryInput(spec, request.directoryMembership);
            if (!captured.ok) {
                return this.writeFailure(captured.reason, captured.detail);
            }
            directories.push(captured.input);
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
        options: MaterialisationPlanLookupOptions
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
            observed.linkTarget !== input.linkTarget
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

        this.mutableCounters.exactContentFallbacks++;
        let proof: string;
        try {
            proof = exactFileProof(input.path, input.kind, observed);
        } catch (error) {
            return this.miss('exact-content-error', `${input.path}: ${errorMessage(error)}`);
        }
        return proof === input.proof ? undefined : this.miss('exact-content-mismatch', input.path);
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
            return {
                ok: true,
                input: {
                    kind: input.kind,
                    path: input.path,
                    present: false,
                    lexicalKind: null,
                    targetKind: null,
                    linkTarget: null,
                    stat: null,
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
            const after = observePath(input.path, false);
            if (
                !after ||
                after.targetKind !== 'file' ||
                after.lexicalKind !== observed.lexicalKind ||
                after.linkTarget !== observed.linkTarget ||
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
            proof = exactFileProof(input.path, input.kind, observed);
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
            stat: observed.stat,
            proof
        }
    };
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
    return {
        lexicalKind,
        targetKind,
        linkTarget,
        stat: storedStat(target)
    };
}

function exactFileProof(
    filePath: string,
    kind: MaterialisationPlanExactFileKind,
    observed: ObservedPath
): string {
    if (kind !== 'layout' || observed.targetKind === 'file') {
        return digest(fs.readFileSync(filePath).toString('base64'));
    }
    // Layout records track topology. Directory contents belong in an explicit membership input.
    return digest(
        [
            observed.lexicalKind,
            observed.targetKind,
            observed.linkTarget ?? '',
            observed.targetKind === 'missing' ? '<missing>' : safeRealpath(filePath)
        ].join('\0')
    );
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
        allowMissing: input.kind === 'source' ? false : !!input.allowMissing
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
    directories: ReturnType<typeof normalizeDirectorySpec>[],
    cachePath: string
): boolean {
    const seen = new Set<string>();
    for (const file of files) {
        if (
            file.path === cachePath ||
            seen.has(file.path) ||
            (file.kind === 'source' &&
                (typeof file.signature !== 'string' || file.signature.length === 0)) ||
            (file.kind !== 'source' && !EXACT_FILE_KINDS.has(file.kind))
        ) {
            return false;
        }
        seen.add(file.path);
    }
    for (const directory of directories) {
        if (
            seen.has(directory.path) ||
            typeof directory.validator !== 'string' ||
            directory.validator.length === 0 ||
            (directory.discoveryProof === null
                ? !directory.allowMissing
                : !isDirectoryProof(directory.discoveryProof))
        ) {
            return false;
        }
        seen.add(directory.path);
    }
    return true;
}

function hasUnambiguousInputSet(
    files: StoredFileInput[],
    directories: StoredDirectoryInput[],
    cachePath: string
): boolean {
    const paths = [...files.map((input) => input.path), ...directories.map((input) => input.path)];
    if (paths.some((inputPath) => inputPath === cachePath)) {
        return false;
    }
    if (new Set(paths).size !== paths.length) {
        return false;
    }
    return (
        isSorted(files.map((input) => input.path)) &&
        isSorted(directories.map((input) => input.path))
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
            'stat',
            'targetKind'
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
            value.stat === null &&
            value.proof === null
        );
    }
    return (
        typeof value.lexicalKind === 'string' &&
        LEXICAL_KINDS.has(value.lexicalKind) &&
        typeof value.targetKind === 'string' &&
        TARGET_KINDS.has(value.targetKind) &&
        (value.linkTarget === null || typeof value.linkTarget === 'string') &&
        isStoredStat(value.stat) &&
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
        value.project.length === 0 ||
        !isRecord(value.engine) ||
        !hasExactKeys(value.engine, ['apiEntry', 'argsPrefix', 'command', 'packageName', 'version'])
    ) {
        return false;
    }
    const engine = value.engine;
    return (
        typeof engine.packageName === 'string' &&
        engine.packageName.length > 0 &&
        typeof engine.version === 'string' &&
        engine.version.length > 0 &&
        typeof engine.command === 'string' &&
        engine.command.length > 0 &&
        Array.isArray(engine.argsPrefix) &&
        engine.argsPrefix.every((argument) => typeof argument === 'string') &&
        (engine.apiEntry === null ||
            (typeof engine.apiEntry === 'string' && engine.apiEntry.length > 0))
    );
}

function sameEngineIdentity(
    left: MaterialisationPlanEngineIdentity,
    right: MaterialisationPlanEngineIdentity
): boolean {
    return (
        left.packageName === right.packageName &&
        left.version === right.version &&
        left.command === right.command &&
        left.apiEntry === right.apiEntry &&
        left.argsPrefix.length === right.argsPrefix.length &&
        left.argsPrefix.every((argument, index) => argument === right.argsPrefix[index])
    );
}

function cloneIdentity(identity: MaterialisationPlanIdentity): MaterialisationPlanIdentity {
    return {
        engine: { ...identity.engine, argsPrefix: [...identity.engine.argsPrefix] },
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
