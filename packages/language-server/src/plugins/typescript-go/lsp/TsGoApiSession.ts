import { dirname } from 'path';
import { pathToFileURL } from 'url';
import { Logger } from '../../../logger';
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
    private failed = false;

    constructor(
        private readonly server: TsGoServer,
        private readonly resolveFrom: string,
        private readonly overlayTsconfigPath: string
    ) {}

    get signatureKind() {
        return this.module?.SignatureKind;
    }

    async connect(): Promise<boolean> {
        if (this.failed) {
            return false;
        }
        this.connecting ??= this.doConnect();
        return this.connecting;
    }

    private async doConnect(): Promise<boolean> {
        try {
            // The JS API client ships with @typescript/native-preview. It is deliberately
            // resolved independently of the tsgo *binary* — a native-preview client attaches
            // fine to an effect-tsgo server, which is the combination we actually run.
            const pkgJson = require.resolve('@typescript/native-preview/package.json', {
                paths: [this.resolveFrom, __dirname]
            });
            const entry = `${dirname(pkgJson)}/dist/api/async/api.js`;
            this.module = await importESM(pathToFileURL(entry).href);

            const session = await this.server.sendRequest<{ pipe?: string }>(
                'custom/initializeAPISession',
                {}
            );
            if (!session?.pipe) {
                throw new Error('tsgo did not return an API pipe');
            }
            this.api = await this.module!.API.fromLSPConnection({ pipe: session.pipe });
            Logger.log('[tsgo] checker API session attached');
            return true;
        } catch (e) {
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
     * The project for our overlay config, refreshed against the session's current state.
     *
     * The previous snapshot is released on each refresh: they are ref-counted server-side and
     * holding every one of them leaks the whole AST cache over an editing session.
     */
    async getProject(): Promise<any | undefined> {
        if (!(await this.connect())) {
            return undefined;
        }
        try {
            const previous = this.snapshot;
            this.snapshot = await this.api.updateSnapshot();
            if (previous && previous !== this.snapshot) {
                await previous.dispose?.();
            }
            return (
                this.snapshot.getProject(this.overlayTsconfigPath) ??
                this.snapshot.getProjects()?.[0]
            );
        } catch (e) {
            Logger.debug('[tsgo] could not obtain a checker project', e);
            return undefined;
        }
    }

    async dispose() {
        try {
            await this.snapshot?.dispose?.();
        } catch {}
        try {
            await this.api?.close?.();
        } catch {}
        this.api = undefined;
        this.snapshot = undefined;
    }
}
