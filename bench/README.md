# tsgo benchmark and acceptance tools

Run the differential correctness oracles before accepting performance results. A faster run with
different diagnostics or source-program membership is a correctness failure, not a speedup.

The full performance acceptance run uses 10 alternating classic/native fresh-process pairs and 20
pull-diagnostic typing rounds at each 30/60/120/250ms gap. It runs stock tsgo first and Effect tsgo
separately, reports p50/p95 latency, process-tree CPU, peak RSS, native-check count, exact engine
version, and observed cache state. It also enforces a 200-cycle open/change/close overlay baseline
and 15% RSS plateau, then applies the 80ms-versus-150ms quiescence gate.

```sh
pnpm test:tsgo-oracle
pnpm test:tsgo-checker-oracle -- --project ../reintersect/apps/dashboard
pnpm bench:tsgo-performance -- \
  --project ../reintersect/apps/dashboard \
  --file src/lib/components/composer/Composer.svelte \
  --tsconfig tsconfig.json \
  --json bench/results/reintersect-performance.json
```

Use `--smoke --engine @typescript/native-preview --skip-checker` only to validate the harness itself. A
smoke result does not meet the sample-size acceptance criteria.

`svelte-check --tsgo` exposes an opt-in stats channel through `SVELTE_LS_TSGO_STATS`. Set it to a
file path for a stable JSON document, or to `stderr`/`1` for one prefixed JSON line on stderr.
Machine protocol stdout is never mixed with telemetry. The report includes materialised,
transformed, reused, and written shadow counts plus phase timings and the exact native version.

## Reintersect acceptance, 2 August 2026

The final uncontended run used 10 alternating fresh editor processes per engine over
already-materialised disk state, 20 edit rounds at each required gap, and 200 open/change/close
cycles. Stock was `@typescript/native-preview@7.0.0-dev.20260703.1`; Effect was measured separately
and compared against stock with only its intentional Effect diagnostics allowlisted.

### Editor fresh-process pulls

| Engine             |    p50 |    p95 |
| ------------------ | -----: | -----: |
| Classic TypeScript | 5407ms | 6490ms |
| Stock tsgo         | 2960ms | 3655ms |
| Effect tsgo        | 2926ms | 3648ms |

These are fresh processes with warm materialisation state, not clean-disk first-project numbers.

### Completion latency

| Measurement         | Stock tsgo | Effect tsgo |
| ------------------- | ---------: | ----------: |
| First dropdown      |    179.3ms |     233.4ms |
| Script member p95   |      ~15ms |        16ms |
| Template member p95 |     14.2ms |      13.5ms |
| Auto-import p95     |    190.4ms |     196.3ms |

The member-completion fast path does not wait for full project synchronisation. Unsupported
contexts also remain subject to the zero-child-request acceptance check.

### Checker cold-cache cost and warm reuse

| Checker state                    | Classic TypeScript | Stock tsgo | Effect tsgo |
| -------------------------------- | -----------------: | ---------: | ----------: |
| Clean-disk first materialisation |            14.304s |    33.058s |     35.044s |
| Immediate warm rerun             |            13.299s |     8.205s |      8.240s |

The clean native path is currently slower than classic. It includes first-time graph discovery,
plan publication and shadow materialisation; the warm result must not be presented as cold-start
performance. On the immediate warm run, both native engines reused 675 Svelte shadows, transformed
and wrote zero, kept every shadow mtime stable, and returned field-for-field identical diagnostics
to their corresponding cold run.

Warm materialisation was still about 1.62s. The profile recorded roughly 0.90s for plan lookup
across 20,510 stat inputs, 0.57s for `loadKit`, 0.185s for config loading and 0.099s for restore.
These rounded phase timings are nested rather than additive. Actual source freshness checks cost
only 7-8ms, so the remaining target is project/config and persisted-plan setup, not unchanged Svelte
transforms.

### 80ms versus 150ms quiescence gate

| Engine      |  p50 at 80ms |  p95 at 80ms |        CPU | Native checks |
| ----------- | -----------: | -----------: | ---------: | ------------: |
| Stock tsgo  | 14.6% better | 12.8% better | 24.1% more |    33.3% more |
| Effect tsgo | 14.4% better |  59.2% worse | 27.3% more |    29.8% more |

The 80ms candidate failed the resource gate for both engines, and Effect also regressed p95
materially. The tested default therefore remains 150ms.
