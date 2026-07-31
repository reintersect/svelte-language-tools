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
    private snapshot: any;
    /** The server generation the current snapshot reflects; see {@link getProjectForFile}. */
    private snapshotGeneration = -1;
    /** In-flight refresh, so concurrent callers share one instead of double-disposing. */
    private refreshing: Promise<void> | undefined;
    private failed = false;
    /** Invalidates every continuation still awaiting the previous child/API pipe. */
    private epoch = 0;

    constructor(
        private readonly server: TsGoServer,
        private readonly engine: ResolvedTsGoEngine
    ) {}

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
    async getProjectForFile(shadowPath: string): Promise<any | undefined> {
        if (!(await this.connect())) {
            return undefined;
        }
        const epoch = this.epoch;
        const api = this.api;
        if (!api) {
            return undefined;
        }
        try {
            while (!this.snapshot || this.server.generation !== this.snapshotGeneration) {
                // Single-flight: two feature requests racing here would each capture the same
                // `previous` and dispose it twice — the server-side refcount underflows and a
                // snapshot still in use gets released.
                if (!this.refreshing) {
                    const generation = this.server.generation;
                    const refresh = (async () => {
                        const previous = this.snapshot;
                        const next = await api.updateSnapshot();
                        if (epoch !== this.epoch || api !== this.api) {
                            await next?.dispose?.();
                            return;
                        }
                        if (!next) {
                            throw new Error('tsgo checker API returned no snapshot');
                        }
                        this.snapshot = next;
                        this.snapshotGeneration = generation;
                        if (previous && previous !== next) {
                            await previous.dispose?.();
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
            return await this.snapshot.getDefaultProjectForFile(shadowPath);
        } catch (e) {
            Logger.debug('[tsgo] could not obtain a checker project', e);
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
        this.snapshotGeneration = -1;
    }

    async dispose() {
        this.epoch++;
        this.module = undefined;
        this.connecting = undefined;
        this.refreshing = undefined;
        this.failed = false;
        this.snapshotGeneration = -1;
        await this.disposeCurrent();
    }

    private async disposeCurrent() {
        // Detach the fields *synchronously* before the async closes settle: dispose races the
        // next doConnect after a restart, and a late continuation must not null out a freshly
        // attached api.
        const api = this.api;
        const snapshot = this.snapshot;
        this.api = undefined;
        this.snapshot = undefined;
        try {
            await snapshot?.dispose?.();
        } catch {}
        try {
            await api?.close?.();
        } catch {}
    }
}
