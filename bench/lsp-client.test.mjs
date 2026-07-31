import assert from 'node:assert/strict';
import test from 'node:test';
import { LspClient } from './lsp-client.mjs';

test('pending requests reject immediately when the child exits', async () => {
    const client = new LspClient(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 25)']);
    const started = Date.now();
    await assert.rejects(client.request('initialize', {}, 10_000), /server exited code=7/);
    assert.ok(Date.now() - started < 2_000, 'request waited for its timeout after child exit');
    await assert.rejects(client.request('shutdown', {}, 10_000), /exited server|server exited/);
});

test('spawn errors notify exit listeners exactly once', async () => {
    const client = new LspClient('/definitely/missing/svelte-lsp-binary', []);
    const exits = await new Promise((resolve, reject) => {
        let count = 0;
        const timeout = setTimeout(() => reject(new Error('spawn error was not reported')), 2_000);
        client.onExit((_exit, error) => {
            count++;
            clearTimeout(timeout);
            setTimeout(() => resolve({ count, error }), 25);
        });
    });
    assert.equal(exits.count, 1);
    assert.match(exits.error.message, /ENOENT/);
});

test('malformed JSON-RPC output rejects pending requests immediately', async () => {
    const source =
        'process.stdout.write("Content-Length: 4\\r\\n\\r\\nnope"); setTimeout(() => {}, 10000)';
    const client = new LspClient(process.execPath, ['-e', source]);
    await assert.rejects(client.request('initialize', {}, 10_000), /malformed LSP output/);
    client.dispose();
});

test('an incomplete final frame is fatal instead of timing out', async () => {
    const source = 'process.stdout.write("Content-Length: 10\\r\\n\\r\\n{");';
    const client = new LspClient(process.execPath, ['-e', source]);
    await assert.rejects(client.request('initialize', {}, 10_000), /incomplete LSP output/);
});
