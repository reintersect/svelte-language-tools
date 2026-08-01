import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { runBoundedProcess } from './bounded-process.mjs';

test('timeout force-kills a child which ignores SIGTERM', async () => {
    const started = performance.now();
    await assert.rejects(
        runBoundedProcess(
            process.execPath,
            [
                '-e',
                'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'
            ],
            {
                timeoutMs: 500,
                outputLimit: 1024,
                label: 'SIGTERM fixture'
            }
        ),
        /SIGTERM fixture timed out after 500ms/
    );
    const durationMs = performance.now() - started;
    assert.ok(durationMs >= 1_000, `child exited before the force-kill grace: ${durationMs}ms`);
    assert.ok(durationMs < 4_000, `timeout teardown was not bounded: ${durationMs}ms`);
});
