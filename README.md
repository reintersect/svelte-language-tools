<p>
  <a href="https://svelte.dev">
	<img alt="Cybernetically enhanced web apps: Svelte" src="https://user-images.githubusercontent.com/49038/76711598-f0b39180-66e7-11ea-9501-37f6e1edf8a6.png">
  </a>

  <a href="https://www.npmjs.com/package/svelte">
    <img src="https://img.shields.io/npm/v/svelte.svg" alt="npm version">
  </a>

  <a href="https://github.com/sveltejs/svelte/blob/master/LICENSE">
    <img src="https://img.shields.io/npm/l/svelte.svg" alt="license">
  </a>
</p>

[IDE docs and troubleshooting](docs)

> ### This is a fork
>
> [`reintersect/svelte-language-tools`](https://github.com/reintersect/svelte-language-tools), forked from
> [`sveltejs/language-tools`](https://github.com/sveltejs/language-tools). It moves TypeScript work off
> the JavaScript compiler and onto **tsgo** (TypeScript 7, native) — in the **editor language server**,
> which upstream does not do at all, and in **`svelte-check`**, replacing the two experimental tsgo
> modes that were there.
>
> Historical snapshot only: one earlier build was compared with upstream's classic engine on the
> Reintersect ~800-component SvelteKit app in its pnpm monorepo:
>
> |                                       | upstream | this fork |
> | ------------------------------------- | -------- | --------- |
> | `svelte-check` on a component library | 4.3s     | **2.3s**  |
> | `svelte-check` on a SvelteKit app     | 15.5s    | **3.9s**  |
> | editor: cold project load             | 7.7s     | **3.6s**  |
> | editor: keystroke → diagnostics       | 948ms    | **420ms** |
>
> These figures predate the current correctness and lifecycle hardening and are historical context,
> not current performance claims. The validated 2 August 2026 Reintersect run used paired fresh
> editor processes over already-materialised disk state. Pull-diagnostic p50/p95 was
> 5407ms/6490ms classic, 2960ms/3655ms stock tsgo, and 2926ms/3648ms Effect tsgo. Completion was kept
> off the project-graph critical path: stock measured 179.3ms for the first dropdown, about 15ms
> script-member p95, 14.2ms template-member p95 and 190.4ms auto-import p95; Effect measured 233.4ms,
> 16ms, 13.5ms and 196.3ms respectively.
>
> A valid completion requested before the native project is ready may lazily start a classic
> completion-only resolver so the first dropdown is useful instead of blank. It does not provide
> diagnostics or any other editor feature, unsupported completion contexts start neither engine,
> and native-ready completion stays on tsgo. Dirty TypeScript-family buffers are mirrored into this
> resolver when it exists.
>
> There is an important cold-cache tradeoff. After deleting the materialisation cache, the first
> checker run took 14.304s classic versus 33.058s stock and 35.044s Effect. The immediate warm run
> took 13.299s classic versus 8.205s stock and 8.240s Effect. Both native warm runs reused 675 Svelte
> shadows with zero transforms or writes, stable shadow mtimes, and field-for-field identical
> diagnostics to their corresponding cold run. The tested diagnostics quiescence remains 150ms:
> 80ms reduced stock p50/p95 by 14.6%/12.8% but raised CPU 24.1% and native checks 33.3%; for Effect,
> p50 improved 14.4% while p95 regressed 59.2%, CPU rose 27.3%, and checks rose 29.8%.
>
> The repository runs the strict `pnpm test:tsgo-oracle` editor-feature oracle and the whole-project
> `pnpm test:tsgo-checker-oracle -- --project <project>` checker oracle. Exact parity is an invariant
> we test, not a blanket guarantee: TypeScript 6 and the evolving TypeScript 7 native compiler can
> intentionally differ, and an engine update is accepted only after any difference is understood and
> explicitly covered.
>
> **It is also vibecoded as hell.** Essentially all of it was written by Claude in a handful of
> sessions, against real measurements rather than a design doc, and it drifts from upstream wherever
> that was faster. It is not a Svelte project, is not endorsed by the Svelte team, and comes with no
> support. It exists because it is quicker than upstream for one specific monorepo. If you are not
> that monorepo, use the real [`svelte-check`](https://www.npmjs.com/package/svelte-check) and
> [`svelte-language-server`](https://www.npmjs.com/package/svelte-language-server).
>
> Known gaps versus upstream: no `refactor` code actions (TypeScript 7 does not implement them yet),
> partial quickfix coverage, and `typescript-svelte-plugin` is untouched — it still runs on the
> JavaScript engine.
>
> ### Setup
>
> **Editor (VS Code, keeps the official extension):**
>
> ```bash
> pnpm add -D @reintersect/svelte-language-server @reintersect/effect-tsgo
> ```
>
> ```jsonc
> // .vscode/settings.json
> {
>     "svelte.language-server.ls-path": "./node_modules/@reintersect/svelte-language-server/bin/server.js",
>     "svelte.language-server.tsgo": true,
>     "svelte.enable-ts-plugin": false
> }
> ```
>
> Reload the window; **Output → Svelte** should log `[tsgo] enabled`. Monorepos work opened at the
> root — projects resolve per file from the nearest tsconfig. Full instructions, tunables and the
> experimental Rust-transform flag: [`packages/language-server`](packages/language-server/README.md).
> In an untrusted workspace the server does not resolve, import or spawn workspace-provided native
> code; it logs the reason and uses the classic engine. Commit the lockfile so the selected engine
> stays reproducible; this repository separately asserts its exact test pin in CI.
>
> **CLI / CI:**
>
> ```bash
> pnpm add -D svelte-check@npm:@reintersect/svelte-check@^4.8.7 @reintersect/effect-tsgo
> svelte-check --tsgo --tsconfig ./tsconfig.json
> ```
>
> Details: [`packages/svelte-check`](packages/svelte-check/README.md). For pull requests,
> [`reintersect/svelte-check-action`](https://github.com/reintersect/svelte-check-action) runs this
> fork with `tsgo: true` and comments the diagnostics.
>
> Both published packages use **`@reintersect/svelte-load-config`** as their scoped Svelte/Vite
> configuration runtime. The older `@reintersect/load-config` name is not the active runtime.

## What is Svelte Language Tools?

Svelte Language Tools contains a library implementing the Language Server Protocol (LSP). LSP powers the [VSCode extension](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode), which is also hosted in this repository. Additionally, LSP is capable of powering plugins for [numerous other IDEs](https://microsoft.github.io/language-server-protocol/implementors/tools/).

A `.svelte` file would look something like this:

```html
<script>
    let count = $state(1);

    let doubled = $derived(count * 2);
    let quadrupled = $derived(doubled * 2);

    function handleClick() {
        count += 1;
    }
</script>

<button onclick="{handleClick}">Count: {count}</button>

<p>{count} * 2 = {doubled}</p>
<p>{doubled} * 2 = {quadrupled}</p>
```

Which is a mix of [HTMLx](https://github.com/htmlx-org/HTMLx) and vanilla JavaScript (but with additional runtime behavior coming from the svelte compiler).

This repo contains the tools which provide editor integrations for Svelte files like this.

## Contributing

Contributions are encouraged and always welcome. [Read the contribution guide for more info](CONTRIBUTING.md) and help us out!

## Supporting Svelte

Svelte is an MIT-licensed open source project with its ongoing development made possible entirely by the support of awesome volunteers. If you'd like to support their efforts, please consider:

-   [Becoming a backer on Open Collective](https://opencollective.com/svelte).

Funds donated via Open Collective will be used for compensating expenses related to Svelte's development such as hosting costs. If sufficient donations are received, funds may also be used to support Svelte's development more directly.

## License

[MIT](LICENSE)

## Credits

-   [James Birtles](https://github.com/jamesbirtles) for creating the foundation which this language server, and the extensions are built on
-   Vue's [Vetur](https://github.com/vuejs/vetur) language server which heavily inspires this project
-   [halfnelson](https://github.com/halfnelson) for creating `svelte2tsx`
-   [jasonlyu123](https://github.com/jasonlyu123) for his ongoing work in all areas of the language-tools
