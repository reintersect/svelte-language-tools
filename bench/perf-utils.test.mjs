import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCpuTime, processTreeFromPs, snapshotShadowMtimes, summarize } from './perf-utils.mjs';

test('summarize reports the acceptance quantiles', () => {
    assert.deepEqual(summarize([5, 1, 4, 2, 3]), {
        n: 5,
        min: 1,
        p50: 3,
        p95: 5,
        max: 5,
        mean: 3
    });
});

test('CPU time parsing accepts BSD and GNU process clocks', () => {
    assert.equal(parseCpuTime('00:01.25'), 1250);
    assert.equal(parseCpuTime('1:02:03'), 3_723_000);
    assert.equal(parseCpuTime('2-01:00:00'), 176_400_000);
    assert.throws(() => parseCpuTime('not-a-clock'));
});

test('process tree aggregation includes recursive native children only', () => {
    const snapshot = processTreeFromPs(
        [
            '100 1 1024 00:01.00',
            '101 100 2048 00:02.00',
            '102 101 4096 00:03.00',
            '200 1 9999 00:09.00'
        ].join('\n'),
        100
    );
    assert.deepEqual(snapshot, {
        pids: [100, 101, 102],
        rssBytes: 7168 * 1024,
        cpuMs: 6000
    });
});

test('shadow mtime scan includes build/dist roots and prunes dependencies and nested worktrees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-perf-scan-'));
    const writeShadow = (relative) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '// generated');
        return file;
    };
    try {
        const rootShadow = writeShadow('node_modules/.cache/svelte-lsp/root.svelte.tsx');
        const buildShadow = writeShadow(
            'build/pkg/node_modules/.cache/svelte-lsp/build.svelte.tsx'
        );
        const distShadow = writeShadow('dist/pkg/node_modules/.cache/svelte-lsp/dist.svelte.tsx');
        writeShadow('node_modules/dependency/node_modules/.cache/svelte-lsp/dependency.svelte.tsx');
        const nested = writeShadow(
            'nested-worktree/node_modules/.cache/svelte-lsp/nested.svelte.tsx'
        );
        fs.writeFileSync(path.join(root, 'nested-worktree', '.git'), 'gitdir: elsewhere');

        const files = [...snapshotShadowMtimes(root).keys()].sort();
        assert.deepEqual(files, [rootShadow, buildShadow, distShadow].sort());
        assert.ok(!files.includes(nested));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
