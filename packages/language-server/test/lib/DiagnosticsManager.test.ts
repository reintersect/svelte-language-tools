import assert from 'assert';
import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { PushDiagnosticsManager } from '../../src/lib/DiagnosticsManager';
import { Document, DocumentManager } from '../../src/lib/documents';

describe('PushDiagnosticsManager', () => {
    it('does not publish a superseded provider result', async () => {
        const documents = new DocumentManager(
            (textDocument) => new Document(textDocument.uri, textDocument.text)
        );
        const document = documents.openClientDocument({
            uri: 'file:///workspace/Component.svelte',
            text: '<p />'
        });
        const pending: Array<{
            token: CancellationToken;
            resolve: (diagnostics: Diagnostic[]) => void;
        }> = [];
        const published: Diagnostic[][] = [];
        const manager = new PushDiagnosticsManager(
            ((params: { diagnostics: Diagnostic[] }) => published.push(params.diagnostics)) as any,
            documents,
            (_identifier, token = CancellationToken.None) =>
                new Promise<Diagnostic[]>((resolve) => pending.push({ token, resolve }))
        );
        const waitForPending = async (count: number) => {
            const deadline = Date.now() + 1_000;
            while (pending.length < count && Date.now() < deadline) {
                await new Promise<void>((resolve) => setTimeout(resolve, 5));
            }
            assert.strictEqual(pending.length, count);
        };
        const diagnostic = (message: string): Diagnostic => ({
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            },
            severity: DiagnosticSeverity.Error,
            message
        });

        manager.scheduleUpdate(document);
        await waitForPending(1);

        manager.scheduleUpdate(document);
        assert.strictEqual(pending[0].token.isCancellationRequested, true);
        pending[0].resolve([diagnostic('stale')]);
        await waitForPending(2);
        pending[1].resolve([diagnostic('current')]);
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.deepStrictEqual(
            published.map((items) => items.map((item) => item.message)),
            [['current']]
        );
    });
});
