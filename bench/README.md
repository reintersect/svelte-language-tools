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

The post-fix full uncontended run used warm disk state, 10 alternating fresh-process pairs, 20 edit
rounds at each required gap, and 200 open/change/close cycles with stock
`@typescript/native-preview@7.0.0-dev.20260703.1`.

-   Editor cold p50/p95 was 6.41s/7.97s classic versus 4.59s/5.40s native (1.4x at p50).
-   A separate strict whole-project checker oracle completed in 17.3s classic versus 6.7s stock,
    with field-identical diagnostics and normalized source-program membership.
-   Dependency discovery fell from roughly 13-17s to 1.45s by stopping at the first ambiguity and
    immediately taking the same conservative declared-package fallback.
-   The warm incremental checker reused 663 Svelte shadows in 148ms with zero transforms or writes,
    identical diagnostics, and stable shadow mtimes.
-   After 200 lifecycle cycles, open overlays returned 0 -> 0 and plateau RSS grew 3.9%.
-   The 80ms candidate failed the resource gate: p50/p95 improved 10.2%/11.6%, but CPU rose 31.4%
    and native checks rose 46.7%. The default therefore remains 150ms.
-   The Effect engine passed the separate source-program comparison with only diagnostic codes
    377021 and 377025 explicitly allowlisted as its intentional Effect checks.

The native compiler phase is roughly 1.0-1.2s on this corpus. The remaining adapter cost is mainly
project/config graph setup and the bounded dependency proof before fallback, not shadow
transformation or native TypeScript execution.
