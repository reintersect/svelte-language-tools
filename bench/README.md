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

## Reintersect acceptance, 1 August 2026

The full uncontended run used warm disk state, 10 alternating fresh-process pairs, 20 edit rounds at
each required gap, and 200 open/change/close cycles per native engine.

-   Stock `@typescript/native-preview@7.0.0-dev.20260703.1`: classic p50/p95 5.65s/5.97s;
    native 16.31s/16.89s. Lifecycle overlays returned 0 -> 0 and plateau RSS grew 2.5%.
-   `@reintersect/effect-tsgo@0.27.3`: classic p50/p95 5.71s/6.17s; native
    16.32s/17.17s. Lifecycle overlays returned 0 -> 0 and plateau RSS grew 2.7%.
-   Both warm checker runs produced field-identical records, left 924 shadow mtimes stable, and
    reused 663 Svelte shadows with zero transforms or writes.
-   The 80ms candidate failed the resource gate. Stock improved p50/p95 latency by 14.9%/10.7% but
    raised CPU 26.8% and checks 34.6%; Effect raised CPU 25.0%, checks 25.6%, and regressed p95
    51.6%. The default therefore remains 150ms.

The cold native regression is dominated by dependency discovery (roughly 13-13.5s), not shadow
transformation. This corpus falls back to the declared dependency closure after computed dependency
entries make exact reachability unprovable. Treat the older speedup snapshots as historical until
that graph work is reduced without changing source-program membership.
