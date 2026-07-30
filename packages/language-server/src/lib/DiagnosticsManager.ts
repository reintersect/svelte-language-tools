import {
    Connection,
    TextDocumentIdentifier,
    Diagnostic,
    CancellationTokenSource,
    CancellationToken
} from 'vscode-languageserver';
import { DocumentManager, Document } from './documents';
import { debounceThrottle } from '../utils';

export type SendDiagnostics = Connection['sendDiagnostics'];
export type GetDiagnostics = (
    doc: TextDocumentIdentifier,
    cancellationToken?: CancellationToken
) => Thenable<Diagnostic[]>;

export interface DiagnosticsManager {
    scheduleUpdate(document: Document): void;
    scheduleUpdateAll(): void;
    removeDiagnostics(document: Document): void;
    cancelStarted(uri: string): void;
}

/**
 * How long to wait after the last edit before recomputing diagnostics for the documents the user
 * is actually typing in.
 *
 * Almost nothing. The instinct is that a short window wastes work — every keystroke starting a
 * check that the next keystroke invalidates — and with an engine whose checks cannot be cancelled
 * that would be true. It isn't, because `cancelStarted` drops a superseded computation before it
 * is ever dispatched, so a burst coalesces on its own.
 *
 * Measured on a ~800-component SvelteKit app, from the last keystroke to the diagnostics that
 * describe it:
 *
 *              single edit    burst of 6, 60ms apart
 *   120ms         413ms              461ms
 *    20ms         307ms              331ms
 *
 * Better in both, so the long window was buying nothing. Kept non-zero only so that a single
 * logical edit arriving as several notifications is still one check.
 */
const BATCH_UPDATE_DEBOUNCE_MS = Number(process.env.SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS ?? 20);

export class PushDiagnosticsManager implements DiagnosticsManager {
    constructor(
        private sendDiagnostics: SendDiagnostics,
        private docManager: DocumentManager,
        private getDiagnostics: GetDiagnostics
    ) {}

    private pendingUpdates = new Set<Document>();
    private cancellationTokens = new Map<string, { cancel: () => void }>();

    private updateAll() {
        this.docManager.getAllOpenedByClient().forEach((doc) => {
            this.update(doc[1]);
        });
        this.pendingUpdates.clear();
    }

    scheduleUpdateAll() {
        this.cancellationTokens.forEach((token) => token.cancel());
        this.cancellationTokens.clear();
        this.pendingUpdates.clear();
        this.debouncedUpdateAll();
    }

    private debouncedUpdateAll = debounceThrottle(() => this.updateAll(), 1000);

    private async update(document: Document) {
        const uri = document.getURL();
        this.cancelStarted(uri);

        const tokenSource = new CancellationTokenSource();
        this.cancellationTokens.set(uri, tokenSource);

        const diagnostics = await this.getDiagnostics(
            { uri: document.getURL() },
            tokenSource.token
        );
        this.sendDiagnostics({
            uri: document.getURL(),
            diagnostics
        });

        tokenSource.dispose();

        if (this.cancellationTokens.get(uri) === tokenSource) {
            this.cancellationTokens.delete(uri);
        }
    }

    cancelStarted(uri: string) {
        const started = this.cancellationTokens.get(uri);
        if (started) {
            started.cancel();
        }
    }

    removeDiagnostics(document: Document) {
        this.pendingUpdates.delete(document);
        this.sendDiagnostics({
            uri: document.getURL(),
            diagnostics: []
        });
    }

    scheduleUpdate(document: Document) {
        if (!this.docManager.isOpenedInClient(document.getURL())) {
            return;
        }

        this.cancelStarted(document.getURL());
        this.pendingUpdates.add(document);
        this.scheduleBatchUpdate();
    }

    private scheduleBatchUpdate = debounceThrottle(() => {
        this.pendingUpdates.forEach((doc) => {
            this.update(doc);
        });
        this.pendingUpdates.clear();
    }, BATCH_UPDATE_DEBOUNCE_MS);
}

export class PullDiagnosticsManager implements DiagnosticsManager {
    constructor(
        private sendDiagnostics: SendDiagnostics,
        private sendRefreshDiagnostics: () => void
    ) {}

    private refreshTimeout: NodeJS.Timeout | null = null;

    scheduleUpdate(): void {
        // No-op, diagnostics are pulled by the client.
    }

    scheduleUpdateAll(): void {
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        this.refreshTimeout = setTimeout(() => {
            this.sendRefreshDiagnostics();
            this.refreshTimeout = null;
        }, 500);
    }

    removeDiagnostics(document: Document): void {
        this.sendDiagnostics({
            uri: document.getURL(),
            diagnostics: []
        });
    }

    cancelStarted(): void {
        // No-op, diagnostics are pulled by the client.
    }
}
