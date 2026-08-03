import { pathToFileURL } from 'url';
import { Logger } from '../../../logger';
import { ResolvedTsGoEngine } from './TsGoEngine';
import { TsGoServer } from './TsGoServer';

/**
 * `import()` that survives TypeScript's CJS emit.
 *
 * The language server compiles to CommonJS, where `await import(x)` is rewritten to a
 * `require()` and blows up on an ESM-only package. Going through `new Function` keeps a real
 * dynamic import in the output.
 */
const importESM: (specifier: string) => Promise<any> = new Function(
    'specifier',
    'return import(specifier)'
) as any;

/** Shape we rely on from `@typescript/native-preview/unstable/async`. */
interface TsGoApiModule {
    API: {
        fromLSPConnection(options: { pipe: string }): Promise<any>;
    };
    SignatureKind: { Call: number; Construct: number };
    SymbolFlags: Record<string, number>;
    TypeFlags: Record<string, number>;
}

/** The stable, serialisable subset returned by the preview checker's completion API. */
export interface TsGoApiCompletionEntry {
    name: string;
    kind?: number;
    sortText?: string;
    insertText?: string;
    filterText?: string;
    detail?: string;
    labelDetails?: { detail?: string; description?: string };
    commitCharacters?: string[];
}

export interface TsGoApiCompletionInfo {
    isIncomplete: boolean;
    isNewIdentifierLocation?: boolean;
    defaultCommitCharacters?: string[];
    entries: TsGoApiCompletionEntry[];
    timings: { projectMs: number; checkerMs: number };
}

interface SnapshotState {
    snapshot: any;
    generation: number;
    leases: number;
    retired: boolean;
    projectsByFile: Map<string, Promise<any | undefined>>;
    disposePromise?: Promise<void>;
    releaseDrain?: () => void;
}

/**
 * An in-process TypeScript **checker** attached to the same programs the LSP session is using.
 *
 * A handful of Svelte features cannot be expressed as LSP requests at all — working out a
 * component's props means walking `$$prop_def` on its type, not asking for a hover. tsgo
 * exposes exactly that through `custom/initializeAPISession`, which hands back a pipe that an
 * API client can attach to, sharing the LSP session's projects rather than building its own.
 *
 * Only the async client can do this, and everything here is best-effort: if the API package
 * isn't present or the handshake fails, callers fall back to plain LSP responses.
 */
export class TsGoApiSession {
    private api: any;
    private module: TsGoApiModule | undefined;
    private connecting: Promise<boolean> | undefined;
    private snapshotState: SnapshotState | undefined;
    /** In-flight refresh, so concurrent callers share one instead of double-disposing. */
    private refreshing: Promise<void> | undefined;
    /** Retired snapshots stay alive until every checker operation which leased them finishes. */
    private readonly snapshotDisposals = new Set<Promise<void>>();
    private failed = false;
    /** Invalidates every continuation still awaiting the previous child/API pipe. */
    private epoch = 0;

    constructor(
        private readonly server: TsGoServer,
        private readonly engine: ResolvedTsGoEngine
    ) {}

    /** Whether this exact engine package shipped its matching async client. */
    get available(): boolean {
        return !!this.engine.apiEntry;
    }

    get signatureKind() {
        return this.module?.SignatureKind;
    }

    async connect(): Promise<boolean> {
        if (this.failed) {
            return false;
        }
        const epoch = this.epoch;
        this.connecting ??= this.doConnect(epoch);
        return this.connecting;
    }

    private async doConnect(epoch: number): Promise<boolean> {
        let attachedApi: any;
        try {
            // Use only the API entry resolved with the running engine. Mixing the binary from
            // one native-preview build with a transitive API client from another produces
            // nondeterministic protocol failures and also bypasses trusted-workspace gating.
            const entry = this.engine.apiEntry;
            if (!entry) {
                throw new Error(
                    `${this.engine.packageName}@${this.engine.version} does not provide the async API client`
                );
            }
            const module: TsGoApiModule = await importESM(pathToFileURL(entry).href);
            if (epoch !== this.epoch) {
                return false;
            }

            const session = await this.server.sendRequest<{ pipe?: string }>(
                'custom/initializeAPISession',
                {}
            );
            if (epoch !== this.epoch) {
                return false;
            }
            if (!session?.pipe) {
                throw new Error('tsgo did not return an API pipe');
            }
            attachedApi = await module.API.fromLSPConnection({ pipe: session.pipe });
            if (epoch !== this.epoch) {
                await attachedApi?.close?.();
                return false;
            }
            this.module = module;
            this.api = attachedApi;
            Logger.log('[tsgo] checker API session attached');
            return true;
        } catch (e) {
            if (epoch !== this.epoch) {
                try {
                    await attachedApi?.close?.();
                } catch {}
                return false;
            }
            Logger.error(
                '[tsgo] could not attach the checker API session; component-level features ' +
                    'will be limited',
                e
            );
            this.failed = true;
            return false;
        }
    }

    /**
     * The project a *file* belongs to, refreshed against the session's current state.
     *
     * Per file, exactly like the LSP side's project selection — this used to be pinned to one
     * overlay tsconfig chosen from the editor's root, which in a monorepo was the workspace
     * stub: an empty three-shim program, with `getProjects()[0]` as an arbitrary-project
     * fallback. Every component-props lookup then ran against a program that had never heard
     * of the component. No fallback here on purpose: an empty answer degrades to plain LSP
     * behaviour, a wrong-project answer looks correct and lies.
     *
     * The snapshot is reused until the server's generation moves — `updateSnapshot` is a full
     * IPC round trip and this gets called on every keystroke inside a component tag. The
     * previous snapshot is released on each refresh: they are ref-counted server-side and
     * holding every one of them leaks the whole AST cache over an editing session.
     */
    private async acquireSnapshot(): Promise<SnapshotState | undefined> {
        if (!(await this.connect())) {
            return undefined;
        }
        const epoch = this.epoch;
        const api = this.api;
        if (!api) {
            return undefined;
        }
        try {
            while (
                !this.snapshotState ||
                this.snapshotState.retired ||
                this.server.generation !== this.snapshotState.generation
            ) {
                // Single-flight: two feature requests racing here would each capture the same
                // previous state. The old snapshot is retired atomically and disposed only after
                // its active checker leases drain.
                if (!this.refreshing) {
                    const generation = this.server.generation;
                    const refresh = (async () => {
                        const next = await api.updateSnapshot();
                        if (epoch !== this.epoch || api !== this.api) {
                            await next?.dispose?.();
                            return;
                        }
                        if (!next) {
                            throw new Error('tsgo checker API returned no snapshot');
                        }
                        const previous = this.snapshotState;
                        this.snapshotState = {
                            snapshot: next,
                            generation,
                            leases: 0,
                            retired: false,
                            projectsByFile: new Map()
                        };
                        if (previous && previous.snapshot !== next) {
                            this.retireSnapshot(previous);
                        }
                    })();
                    const tracked = refresh.finally(() => {
                        if (this.refreshing === tracked) {
                            this.refreshing = undefined;
                        }
                    });
                    this.refreshing = tracked;
                }
                await this.refreshing;
                if (epoch !== this.epoch || api !== this.api) {
                    return undefined;
                }
            }
            const state = this.snapshotState;
            if (!state || state.retired) {
                return undefined;
            }
            // No await between selecting and leasing: a refresh cannot retire/dispose this state
            // in the middle of acquisition.
            state.leases++;
            return state;
        } catch (e) {
            Logger.debug('[tsgo] could not obtain a checker snapshot', e);
            return undefined;
        }
    }

    /**
     * Run an entire checker operation against one leased snapshot.
     *
     * A newer native generation may publish concurrently. It cannot dispose this operation's
     * Project/Checker handles until the callback settles, but its result is no longer valid: an
     * edit in another file can change the member/type answer without changing the requesting
     * document. Project lookup is also single-flight per snapshot so eager warmup and the first
     * foreground completion join the same request.
     */
    async withProjectForFile<T>(
        shadowPath: string,
        operation: (project: any) => T | Promise<T>,
        isCurrent: () => boolean = () => true
    ): Promise<T | undefined> {
        if (!isCurrent()) {
            return undefined;
        }
        const state = await this.acquireSnapshot();
        if (!state) {
            return undefined;
        }
        const isSnapshotCurrent = () =>
            !state.retired && state.generation === this.server.generation && isCurrent();
        try {
            if (!isSnapshotCurrent()) {
                return undefined;
            }
            let project = state.projectsByFile.get(shadowPath);
            if (!project) {
                project = Promise.resolve(state.snapshot.getDefaultProjectForFile(shadowPath));
                state.projectsByFile.set(shadowPath, project);
            }
            const resolved = await project;
            if (!resolved || !isSnapshotCurrent()) {
                return undefined;
            }
            const result = await operation(resolved);
            return isSnapshotCurrent() ? result : undefined;
        } catch (e) {
            Logger.debug('[tsgo] checker project operation failed', e);
            return undefined;
        } finally {
            this.releaseSnapshot(state);
        }
    }

    async warmProjectForFile(shadowPath: string): Promise<boolean> {
        return (await this.withProjectForFile(shadowPath, () => true)) === true;
    }

    /**
     * Ask the checker attached to the running LSP process for lightweight completions.
     *
     * The API deliberately does not expose completion-entry resolution or auto-import edits, so
     * callers must reserve this for contexts (currently member access) where the entry itself is
     * the complete answer. It is dramatically cheaper there because it avoids the LSP server's
     * completion-list construction and opaque resolve payloads while sharing the exact program.
     */
    async getCompletionsAtPosition(
        shadowPath: string,
        offset: number,
        triggerCharacter?: string,
        isCurrent: () => boolean = () => true
    ): Promise<TsGoApiCompletionInfo | undefined> {
        try {
            const projectStarted = performance.now();
            let projectMs = 0;
            let checkerMs = 0;
            const result = await this.withProjectForFile(
                shadowPath,
                async (project) => {
                    projectMs = performance.now() - projectStarted;
                    const checkerStarted = performance.now();
                    const completion = await project.checker?.getCompletionsAtPosition(
                        shadowPath,
                        offset,
                        triggerCharacter ? { triggerCharacter } : undefined
                    );
                    checkerMs = performance.now() - checkerStarted;
                    return completion;
                },
                isCurrent
            );
            if (
                !isRecord(result) ||
                typeof result.isIncomplete !== 'boolean' ||
                !Array.isArray(result.entries) ||
                !result.entries.every(isTsGoApiCompletionEntry) ||
                !optionalBoolean(result.isNewIdentifierLocation) ||
                !optionalStringArray(result.defaultCommitCharacters)
            ) {
                Logger.debug('[tsgo] checker API returned a malformed completion entry');
                return undefined;
            }
            return {
                isIncomplete: result.isIncomplete,
                ...(result.isNewIdentifierLocation !== undefined
                    ? { isNewIdentifierLocation: result.isNewIdentifierLocation }
                    : {}),
                ...(result.defaultCommitCharacters
                    ? { defaultCommitCharacters: [...result.defaultCommitCharacters] }
                    : {}),
                entries: result.entries.map(copyTsGoApiCompletionEntry),
                timings: { projectMs, checkerMs }
            };
        } catch (e) {
            // The LSP completion route remains the fail-closed fallback for a preview API which
            // can disappear or reject a context between native builds.
            Logger.debug('[tsgo] checker API completion failed', e);
            return undefined;
        }
    }

    /**
     * Forget the attachment after the tsgo child died, so the next call reconnects to the new
     * process instead of talking to a dead pipe forever.
     */
    reset() {
        this.epoch++;
        void this.disposeCurrent();
        this.module = undefined;
        this.connecting = undefined;
        this.refreshing = undefined;
        this.failed = false;
    }

    async dispose() {
        this.epoch++;
        this.module = undefined;
        this.connecting = undefined;
        this.refreshing = undefined;
        this.failed = false;
        await this.disposeCurrent();
    }

    private releaseSnapshot(state: SnapshotState): void {
        state.leases = Math.max(0, state.leases - 1);
        if (state.leases === 0) {
            state.releaseDrain?.();
            state.releaseDrain = undefined;
        }
    }

    private retireSnapshot(state: SnapshotState): Promise<void> {
        state.retired = true;
        if (!state.disposePromise) {
            const dispose = (async () => {
                if (state.leases > 0) {
                    await new Promise<void>((resolve) => (state.releaseDrain = resolve));
                }
                try {
                    await state.snapshot?.dispose?.();
                } catch {}
            })();
            const tracked = dispose.finally(() => this.snapshotDisposals.delete(tracked));
            state.disposePromise = tracked;
            this.snapshotDisposals.add(tracked);
        }
        return state.disposePromise;
    }

    private async disposeCurrent() {
        // Detach the fields *synchronously* before the async closes settle: dispose races the
        // next doConnect after a restart, and a late continuation must not null out a freshly
        // attached api.
        const api = this.api;
        const snapshotState = this.snapshotState;
        this.api = undefined;
        this.snapshotState = undefined;
        if (snapshotState) {
            this.retireSnapshot(snapshotState);
        }
        await Promise.all([...this.snapshotDisposals]);
        try {
            await api?.close?.();
        } catch {}
    }
}

function isTsGoApiCompletionEntry(entry: unknown): entry is TsGoApiCompletionEntry {
    if (!isRecord(entry)) {
        return false;
    }
    const value = entry;
    if (
        typeof value.name !== 'string' ||
        !optionalCompletionItemKind(value.kind) ||
        !optionalString(value.sortText) ||
        !optionalString(value.insertText) ||
        !optionalString(value.filterText) ||
        !optionalString(value.detail) ||
        !optionalStringArray(value.commitCharacters)
    ) {
        return false;
    }
    if (value.labelDetails !== undefined) {
        if (!isRecord(value.labelDetails)) {
            return false;
        }
        const details = value.labelDetails;
        if (!optionalString(details.detail) || !optionalString(details.description)) {
            return false;
        }
    }
    return true;
}

function copyTsGoApiCompletionEntry(entry: TsGoApiCompletionEntry): TsGoApiCompletionEntry {
    return {
        name: entry.name,
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
        ...(entry.sortText !== undefined ? { sortText: entry.sortText } : {}),
        ...(entry.insertText !== undefined ? { insertText: entry.insertText } : {}),
        ...(entry.filterText !== undefined ? { filterText: entry.filterText } : {}),
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
        ...(entry.labelDetails !== undefined
            ? {
                  labelDetails: {
                      ...(entry.labelDetails.detail !== undefined
                          ? { detail: entry.labelDetails.detail }
                          : {}),
                      ...(entry.labelDetails.description !== undefined
                          ? { description: entry.labelDetails.description }
                          : {})
                  }
              }
            : {}),
        ...(entry.commitCharacters !== undefined
            ? { commitCharacters: [...entry.commitCharacters] }
            : {})
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function optionalCompletionItemKind(value: unknown): value is number | undefined {
    // LSP 3.17 CompletionItemKind: Text (1) through TypeParameter (25).
    return (
        value === undefined ||
        (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 25)
    );
}

function optionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

function optionalStringArray(value: unknown): value is string[] | undefined {
    return (
        value === undefined ||
        (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    );
}
