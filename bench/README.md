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
