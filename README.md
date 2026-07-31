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
> Measured against upstream's classic engine as the oracle, on a ~800-component SvelteKit app in a
> pnpm monorepo:
>
> | | upstream | this fork |
> |---|---|---|
> | `svelte-check` on a component library | 4.3s | **2.3s** |
> | `svelte-check` on a SvelteKit app | 15.5s | **3.9s** |
> | editor: cold project load | 7.7s | **3.6s** |
> | editor: keystroke → diagnostics | 948ms | **420ms** |
>
> Same diagnostics in every case — the check is diffed against the classic engine file by file, and
> converges on it exactly.
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
>
> **CLI / CI:**
>
> ```bash
> pnpm add -D svelte-check@npm:@reintersect/svelte-check@^4.8.1 @reintersect/effect-tsgo
> svelte-check --tsgo --tsconfig ./tsconfig.json
> ```
>
> Details: [`packages/svelte-check`](packages/svelte-check/README.md). For pull requests,
> [`reintersect/svelte-check-action`](https://github.com/reintersect/svelte-check-action) runs this
> fork with `tsgo: true` and comments the diagnostics.


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
