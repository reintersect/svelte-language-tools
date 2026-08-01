import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    BATCH_CREATION_PHASES,
    BATCH_MATERIALISE_PHASES,
    parseCpuTime,
    processTreeFromPs,
    snapshotShadowMtimes,
    summarize,
    summarizeBatchMaterialiseResults,
    summarizeBatchOverlayCreationTimings,
    validateBatchMaterialiseResult,
    validateCheckerStats,
    validateLanguageServerStats
} from './perf-utils.mjs';

function materialiseResult({
    durationMs = 10,
    phaseMs = 1,
    svelteTransformed = 2,
    svelteReused = 3,
    svelteWritten = svelteTransformed,
    sourceCopied = 1,
    sourceRewritten = 1,
    sourceReused = 2,
    sourceWritten = sourceCopied + sourceRewritten,
    cleanupSkipped = false
} = {}) {
    return {
        shadowCount: 12,
        transformedCount: svelteTransformed + sourceCopied + sourceRewritten,
        reusedCount: svelteReused + sourceReused,
        writtenCount: svelteWritten + sourceWritten,
        durationMs,
        phases: Object.fromEntries(BATCH_MATERIALISE_PHASES.map((phase) => [phase, phaseMs])),
        svelte: {
            candidateCount: svelteTransformed + svelteReused,
            transformedCount: svelteTransformed,
            reusedCount: svelteReused,
            writtenCount: svelteWritten
        },
        sourceMirrors: {
            candidateCount: sourceCopied + sourceRewritten + sourceReused,
            copiedCount: sourceCopied,
            rewrittenCount: sourceRewritten,
            reusedCount: sourceReused,
            writtenCount: sourceWritten
        },
        supportFiles: { kitShadowCount: 2, packageScopeCount: 1 },
        cleanup: {
            skipped: cleanupSkipped,
            previousOwnedCount: 9,
            liveOwnedCount: 12
        },
        graph: {
            reachabilityFallbackReasons: [],
            dependencyScope: {
                mode: 'reachable',
                directImports: 2,
                dependencyRoots: 3,
                svelteFiles: 4,
                fallbackReasons: []
            },
            collisionMirrors: {
                reachableScripts: 8,
                reverseClosureNodes: 3,
                mirroredScripts: sourceRewritten,
                mirroredJson: sourceCopied,
                collidingComponents: 1,
                fallbackReasons: []
            },
            materialisationPlan: {
                hit: true,
                eligible: true,
                writeStatus: 'unchanged',
                counters: {
                    lookups: 1,
                    hits: 1,
                    misses: 0,
                    writes: 0,
                    writeSkips: 0,
                    writeFailures: 0,
                    statFastPathInputs: 5,
                    sourceSignatureFallbacks: 0,
                    exactContentFallbacks: 0,
                    directoryValidations: 1,
                    missReasons: {}
                }
            }
        }
    };
}

function checkerStats(materialise = materialiseResult()) {
    const cacheState =
        materialise.transformedCount === 0 && materialise.writtenCount === 0
            ? 'warm'
            : materialise.reusedCount === 0
              ? 'cold-or-invalidated'
              : 'mixed';
    return {
        schemaVersion: 1,
        engine: { packageName: '@typescript/native-preview', version: '7.0.0-dev.test' },
        incremental: true,
        cacheState,
        materialise,
        phases: {
            createOverlayMs: 1,
            createOverlay: Object.fromEntries(BATCH_CREATION_PHASES.map((phase) => [phase, 1])),
            nativeCheckMs: 2,
            mapDiagnosticsMs: 3,
            svelteAndCssMs: 4,
            totalMs: 20
        },
        program: { nativeFileCount: 10, sourceFileCount: 8, svelteFileCount: 4 },
        diagnostics: {
            nativeCount: 2,
            mappedTypeScriptCount: 2,
            svelteAndCssCount: 1,
            outputCount: 3
        }
    };
}

function languageServerStats() {
    return {
        engine: { packageName: '@typescript/native-preview', version: '7.0.0-dev.test' },
        nativeProcessId: 123,
        generation: 1,
        served: 10,
        fellBack: 0,
        fallbackReasons: {},
        openOverlays: 1,
        childOpenOverlays: 1,
        pendingSvelteLifecycle: 0,
        transformedShadows: 5,
        reusedShadows: 3,
        projectChecks: 2,
        cancellations: 1,
        materialisationCleanupRuns: 1,
        materialisationCleanupSkips: 2,
        phaseTimings: { materialise: { count: 2, totalMs: 12.5 } }
    };
}

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

test('batch materialisation validation requires every nested phase and counter', () => {
    const valid = materialiseResult();
    assert.equal(validateBatchMaterialiseResult(valid), valid);

    const missingPhase = structuredClone(valid);
    delete missingPhase.phases.svelteFreshnessMs;
    assert.throws(() => validateBatchMaterialiseResult(missingPhase), /phases\.svelteFreshnessMs/);

    const missingNestedCounter = structuredClone(valid);
    delete missingNestedCounter.sourceMirrors.reusedCount;
    assert.throws(
        () => validateBatchMaterialiseResult(missingNestedCounter),
        /sourceMirrors\.reusedCount/
    );

    const invalidCleanup = structuredClone(valid);
    invalidCleanup.cleanup.skipped = 'yes';
    assert.throws(() => validateBatchMaterialiseResult(invalidCleanup), /cleanup\.skipped/);

    const inconsistentCompatibilityTotal = structuredClone(valid);
    inconsistentCompatibilityTotal.transformedCount++;
    assert.throws(
        () => validateBatchMaterialiseResult(inconsistentCompatibilityTotal),
        /compatibility total/
    );
});

test('checker stats validation rejects malformed, incomplete and inconsistent records', () => {
    const valid = checkerStats();
    assert.equal(validateCheckerStats(valid, '@typescript/native-preview'), valid);

    const missingProgramCounter = structuredClone(valid);
    delete missingProgramCounter.program.nativeFileCount;
    assert.throws(() => validateCheckerStats(missingProgramCounter), /program\.nativeFileCount/);

    const missingEngineVersion = structuredClone(valid);
    delete missingEngineVersion.engine.version;
    assert.throws(() => validateCheckerStats(missingEngineVersion), /engine\.version/);

    const staleCacheState = structuredClone(valid);
    staleCacheState.cacheState = 'warm';
    assert.throws(() => validateCheckerStats(staleCacheState), /expected mixed/);

    assert.throws(
        () => validateCheckerStats(valid, '@reintersect/effect-tsgo'),
        /expected @reintersect\/effect-tsgo/
    );
});

test('language server stats validation rejects missing counters and malformed timings', () => {
    const valid = languageServerStats();
    assert.equal(validateLanguageServerStats(valid), valid);

    const missingCleanupCounter = structuredClone(valid);
    delete missingCleanupCounter.materialisationCleanupSkips;
    assert.throws(
        () => validateLanguageServerStats(missingCleanupCounter),
        /materialisationCleanupSkips/
    );

    const invalidPhase = structuredClone(valid);
    invalidPhase.phaseTimings.materialise.totalMs = Number.NaN;
    assert.throws(() => validateLanguageServerStats(invalidPhase), /materialise\.totalMs/);
});

test('materialisation summaries report phase and workload p50/p95 plus cleanup decisions', () => {
    const results = [
        materialiseResult({
            durationMs: 10,
            phaseMs: 1,
            svelteTransformed: 4,
            svelteReused: 1,
            sourceCopied: 2,
            sourceRewritten: 1,
            sourceReused: 0,
            cleanupSkipped: false
        }),
        materialiseResult({
            durationMs: 20,
            phaseMs: 2,
            svelteTransformed: 2,
            svelteReused: 3,
            sourceCopied: 0,
            sourceRewritten: 1,
            sourceReused: 2,
            cleanupSkipped: true
        }),
        materialiseResult({
            durationMs: 30,
            phaseMs: 3,
            svelteTransformed: 0,
            svelteReused: 5,
            svelteWritten: 0,
            sourceCopied: 0,
            sourceRewritten: 0,
            sourceReused: 3,
            sourceWritten: 0,
            cleanupSkipped: true
        })
    ];
    const summary = summarizeBatchMaterialiseResults(results);

    assert.equal(summary.durationMs.p50, 20);
    assert.equal(summary.durationMs.p95, 30);
    assert.equal(summary.phases.prepareMirrorsMs.p50, 2);
    assert.equal(summary.phases.prepareMirrorsMs.p95, 3);
    assert.equal(summary.svelte.transformedCount.p50, 2);
    assert.equal(summary.svelte.reusedCount.p95, 5);
    assert.equal(summary.sourceMirrors.transformedCount.p50, 1);
    assert.equal(summary.sourceMirrors.reusedCount.p95, 3);
    assert.deepEqual(
        { skipped: summary.cleanup.skippedRuns, executed: summary.cleanup.executedRuns },
        { skipped: 2, executed: 1 }
    );
    assert.deepEqual(summary.graph.dependencyScope.modes, ['reachable']);
    assert.equal(summary.graph.collisionMirrors.reachableScripts.p50, 8);
});

test('overlay creation summaries report every phase', () => {
    const first = Object.fromEntries(BATCH_CREATION_PHASES.map((phase) => [phase, 1]));
    const second = Object.fromEntries(BATCH_CREATION_PHASES.map((phase) => [phase, 3]));
    const summary = summarizeBatchOverlayCreationTimings([first, second]);

    assert.equal(summary.discoverProjectGraphMs.p50, 3);
    assert.equal(summary.totalMs.p95, 3);
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
