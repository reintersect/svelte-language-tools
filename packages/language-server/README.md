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
> not current performance claims. In the validated 2 August 2026 Reintersect run, paired fresh
> editor processes over already-materialised disk state measured pull-diagnostic p50/p95 of
> 5407ms/6490ms classic, 2960ms/3655ms stock tsgo, and 2926ms/3648ms Effect tsgo. First-dropdown
> completion was 179.3ms stock and 233.4ms Effect; script and template member p95 stayed at 13-16ms.
> See the measured cold-cache cost and full methodology below rather than treating those warm-disk
> editor numbers as a universal startup claim.
>
> `pnpm test:tsgo-oracle` compares meaningful editor features against the classic engine, and the
> whole-project checker oracle compares diagnostics plus normalized program membership. Exact parity
> is an invariant under test, not a blanket guarantee: TypeScript 6 and the evolving TypeScript 7
> native compiler can intentionally differ, and updates require reviewing that diff.
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

Published as **`@reintersect/svelte-language-server`**. Point your editor at it with
`svelte.language-server.ls-path`, and set `"svelte.language-server.tsgo": true` to turn the tsgo
engine on — without it the fork behaves exactly like upstream.

# Svelte Language Server

A language server (implementing the [language server protocol](https://microsoft.github.io/language-server-protocol/))
for Svelte.

Requires Node 18 or later.

## Using this fork in VS Code

The official **Svelte for VS Code** extension can be pointed at a different language server binary,
so there is nothing to build or sideload — keep the extension you already have and redirect it.

**1. Install the server and a tsgo binary** as dev dependencies of the workspace you edit:

```bash
pnpm add -D @reintersect/svelte-language-server @reintersect/effect-tsgo
```

(`@typescript/native` or `@typescript/native-preview` works in place of
`@reintersect/effect-tsgo`; the server resolves the binary and matching API from the project. In a
pnpm workspace, install both at the root and commit the lockfile so every developer runs the tested
engine version.)

**2. Point the extension at it and turn the engine on**, in the workspace's
`.vscode/settings.json`:

```jsonc
{
    "svelte.language-server.ls-path": "./node_modules/@reintersect/svelte-language-server/bin/server.js",
    "svelte.language-server.tsgo": true,
    // This separate plugin still runs the JavaScript engine; keep it out of the way.
    "svelte.enable-ts-plugin": false
}
```

A global install with an absolute `ls-path` works too; the per-workspace install just keeps the
server version pinned with the repo. (`SVELTE_LS_TSGO=1` in the environment does the same as the
setting, for CI and benchmarks where there is no settings.json.)

**3. Restart the extension host** — `Developer: Reload Window`. Confirm it took by opening
**Output → Svelte**; the log says `[tsgo] enabled, using <path>`, names the project it resolved
(`[tsgo] project <dir>`), and reports `[tsgo] materialised N shadows` on the first request.

**Monorepos work opened at the root.** Projects are resolved per file from the nearest tsconfig —
open the workspace root and every app and package gets its own program, its own Svelte version and
its own shims. You do not need to open individual apps as workspace folders.

Open/change/close state for imported `.ts`, `.tsx`, `.js` and `.jsx` files is forwarded to the same
tsgo child, so template diagnostics and navigation observe unsaved dependency edits. VS Code still
uses its built-in TypeScript service for the UI of a plain TS/JS tab; this does not migrate the
separate `typescript-svelte-plugin`.

### Experimental: the Rust transform

With `@rsvelte/svelte2tsx` installed, `"svelte.language-server.rsvelte": true` (or
`SVELTE_LS_RSVELTE=1`) transforms Svelte 5 `lang="ts"` components through
[rsvelte](https://github.com/baseballyama/rsvelte)'s native svelte2tsx — several times faster than
the JS transform. **Off by default**: rsvelte's source maps currently ship a generated-column bug,
and even repaired they lose template-level positions, so diagnostics on markup (an unimported
`<Component>`, a bad prop) can silently disappear. Turn it on only if that trade is acceptable;
the default JS transform reports everything.

### Validated performance context

The 2 August 2026 Reintersect acceptance used 10 paired fresh editor processes per engine over
already-materialised disk state. Lower is better:

| Fresh-process editor pull | Classic TypeScript | Stock tsgo | Effect tsgo |
| ------------------------- | -----------------: | ---------: | ----------: |
| p50                       |             5407ms |     2960ms |      2926ms |
| p95                       |             6490ms |     3655ms |      3648ms |

Completion has a separate latency budget because a dropdown should not wait for whole-project
materialisation:

| Completion measurement | Stock tsgo | Effect tsgo |
| ---------------------- | ---------: | ----------: |
| First dropdown         |    179.3ms |     233.4ms |
| Script member p95      |      ~15ms |        16ms |
| Template member p95    |     14.2ms |      13.5ms |
| Auto-import p95        |    190.4ms |     196.3ms |

A valid completion requested before the native project is ready may lazily start a classic
completion-only resolver so the first dropdown is useful instead of blank. It does not provide
diagnostics or any other editor feature, unsupported completion contexts start neither engine, and
native-ready completion stays on tsgo. Dirty TypeScript-family buffers are mirrored into this
resolver when it exists.

Those editor numbers are warm-disk, not clean-cache startup results. A checker run after deleting
the materialisation cache took 14.304s classic, 33.058s stock and 35.044s Effect. The immediate warm
rerun took 13.299s classic, 8.205s stock and 8.240s Effect. Each native warm rerun reused 675 Svelte
shadows with zero transforms or writes, kept every shadow mtime stable, and returned field-for-field
the same diagnostics as its corresponding cold run.

The warm native profile still spent about 1.62s in materialisation. The dominant recorded work was
about 0.90s looking up a persisted plan across 20,510 stat inputs, 0.57s loading SvelteKit state,
0.185s loading configs and 0.099s restoring the plan. These timings are rounded and nested rather
than additive. Actual source freshness checks took only 7-8ms, so hashing or transforming unchanged
Svelte files is not the remaining bottleneck.

The tested pull-diagnostic quiescence remains 150ms. At 80ms, stock p50/p95 improved 14.6%/12.8%,
but process-tree CPU rose 24.1% and native-check count rose 33.3%. Effect p50 improved 14.4%, but p95
regressed 59.2%, CPU rose 27.3%, and checks rose 29.8%. Hover, completion, go-to-definition and
rename are routed through tsgo when the engine is enabled.

### What to expect that is different

-   **No refactorings.** TypeScript 7 does not implement `refactor` code actions yet, so "Extract to
    function", "Move to file" and friends are absent. Quickfixes work, but not all of them.
-   **A `node_modules/.cache/svelte-lsp` directory** appears in each package that has components. It
    holds generated `.tsx` twins for TypeScript components and `.jsx` twins for JavaScript
    components; being under `node_modules/.cache` it is
    already ignored by git and search tools. Deleting it is always safe. (Older builds used a
    visible `.svelte-ls-overlay` directory instead — the server removes those on sight.)
-   **The separate TypeScript plugin is unchanged.** `typescript-svelte-plugin` has no tsgo
    migration path. The language server nevertheless forwards the full TS/TSX/JS/JSX buffer
    lifecycle to tsgo so Svelte features see dirty imported modules.

### Turning it off

Remove `ls-path` to go back to the extension's bundled server, or drop `SVELTE_LS_TSGO=1` to keep
this build but run it on the upstream JavaScript engine. Both are one-line reverts, which is the
point — the flag was kept so a bad day is a settings change rather than a reinstall.

### Requirements

`@reintersect/effect-tsgo` (preferred), `@typescript/native` or `@typescript/native-preview`
installed in the workspace being edited. The server resolves the binary from the project, not from
itself, so each project controls its exact installed version; `SVELTE_LS_TSGO_PACKAGE` selects one
package for A/B runs. Repository CI asserts that the root, language-server and checker manifests all
name the same exact stock-engine version and verifies the resolved package and version. With no
supported engine present it logs an error and falls back to the JavaScript engine. Fast
component/member completions additionally need a checker API client matching that exact native
engine. Stock packages provide their own entry; tested Effect builds use the bundled official API
client only after package version, TypeScript version, git identity and bundle hash all match. A
mismatch fails closed to ordinary LSP completion instead of borrowing another engine's API.

In an untrusted workspace the native path is disabled before package resolution: workspace engine
code and configuration are neither imported nor spawned, and the server logs that it is using the
classic engine with reduced capabilities.

The published server depends on **`@reintersect/svelte-load-config`**, the canonical scoped runtime
for Svelte/Vite config discovery and invalidation. Do not add the superseded
`@reintersect/load-config` package to a workspace.

### Tunables

| environment variable                | effect                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| `SVELTE_LS_TSGO=1`                  | turn the tsgo engine on without the editor setting                   |
| `SVELTE_LS_TSGO_PACKAGE`            | pin which package provides the tsgo binary                           |
| `SVELTE_LS_RSVELTE=1`               | opt into the Rust transform (see above)                              |
| `SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS` | how long a diagnostics pull waits for typing to settle (default 150) |
| `SVELTE_LS_TIMING=<file>`           | append per-phase keystroke timings to a file                         |

## What is a language server?

From https://microsoft.github.io/language-server-protocol/overview

> The idea behind a Language Server is to provide the language-specific smarts inside a server that can communicate with development tooling over a protocol that enables inter-process communication.

In simpler terms, this allows editor and addon devs to add support for svelte specific 'smarts' (e.g. diagnostics, autocomplete, etc) to any editor without reinventing the wheel.

## Features

Svelte language server is under development and the list of features will surely grow over time.

Currently Supported:

-   Svelte
    -   Diagnostic messages for warnings and errors
    -   Svelte specific formatting (via [prettier-plugin-svelte](https://github.com/UnwrittenFun/prettier-plugin-svelte))
-   HTML (via [vscode-html-languageservice](https://github.com/Microsoft/vscode-html-languageservice))
    -   Hover info
    -   Autocompletions
    -   [Emmet](https://emmet.io/)
    -   Symbols in Outline panel
-   CSS / SCSS / LESS (via [vscode-css-languageservice](https://github.com/Microsoft/vscode-css-languageservice))
    -   Diagnostic messages for syntax and lint errors
    -   Hover info
    -   Autocompletions
    -   Formatting (via [prettier](https://github.com/prettier/prettier))
    -   [Emmet](https://emmet.io/)
    -   Color highlighting and color picker
    -   Symbols in Outline panel
-   TypeScript / JavaScript (via TypeScript)
    -   Diagnostics messages for syntax errors, semantic errors, and suggestions
    -   Hover info
    -   Formatting (via [prettier](https://github.com/prettier/prettier))
    -   Symbols in Outline panel
    -   Autocompletions
    -   Go to definition
    -   Code Actions

## How can I use it?

Install a plugin for your editor:

-   [VS Code](../svelte-vscode)

## Settings

The language server has quite a few settings to toggle features. They are listed below. When using the VS Code extension, you can set these through the settings UI or in the `settings.json` using the keys mentioned below.

When using the language server directly, put the settings as JSON inside `initializationOptions.configuration` for the [initialize command](https://microsoft.github.io/language-server-protocol/specification#initialize). When using the [didChangeConfiguration command](https://microsoft.github.io/language-server-protocol/specification#workspace_didChangeConfiguration), pass the JSON directly. The language server also accepts configuration for Emmet (key: `emmet`; [settings reference](https://github.com/microsoft/vscode/blob/main/extensions/emmet/package.json#L26)), Prettier (key: `prettier`), CSS (key: `css` / `less` / `scss`; [settings reference](https://github.com/microsoft/vscode/blob/main/extensions/css-language-features/package.json#L36)) and TypeScript (keys: `javascript` and `typescript` for JS/TS config; [settings reference](https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/package.json#L141)).

Example:

Init:

```js
{
    initializationOptions: {
        configuration: {
            svelte: {
                plugin: {
                    css: { enable: false },
                    // ...
                }
            },
            typescript: { /* .. */ },
            javascript: { /* .. */ },
            prettier: { /* .. */ },
            // ...
        }
    }
}
```

Update:

```js
{
    svelte: {
        plugin: {
            css: { enable: false },
            // ...
        }
    },
    typescript: { /* .. */ },
    javascript: { /* .. */ },
    prettier: { /* .. */ },
    // ...
    }
}
```

### List of settings

##### `svelte.plugin.typescript.enable`

Enable the TypeScript plugin. _Default_: `true`

##### `svelte.plugin.typescript.diagnostics.enable`

Enable diagnostic messages for TypeScript. _Default_: `true`

##### `svelte.plugin.typescript.hover.enable`

Enable hover info for TypeScript. _Default_: `true`

##### `svelte.plugin.typescript.documentSymbols.enable`

Enable document symbols for TypeScript. _Default_: `true`

##### `svelte.plugin.typescript.completions.enable`

Enable completions for TypeScript. _Default_: `true`

##### `svelte.plugin.typescript.codeActions.enable`

Enable code actions for TypeScript. _Default_: `true`

##### `svelte.plugin.typescript.selectionRange.enable`

Enable selection range for TypeScript. _Default_: `true`

##### `svelte.plugin.typescript.signatureHelp.enable`

Enable signature help (parameter hints) for JS/TS. _Default_: `true`

##### `svelte.plugin.typescript.semanticTokens.enable`

Enable semantic tokens (semantic highlight) for TypeScript. _Default_: `true`

#### `svelte.plugin.typescript.workspaceSymbols.enable`

Enable workspace symbols for TypeScript. You can disable this if the language server client you're using doesn't deduplicate results from the TSServer. _Default_: `true`.

##### `svelte.plugin.css.enable`

Enable the CSS plugin. _Default_: `true`

##### `svelte.plugin.css.globals`

Which css files should be checked for global variables (`--global-var: value;`). These variables are added to the css completions. String of comma-separated file paths or globs relative to workspace root.

##### `svelte.plugin.css.diagnostics.enable`

Enable diagnostic messages for CSS. _Default_: `true`

##### `svelte.plugin.css.hover.enable`

Enable hover info for CSS. _Default_: `true`

##### `svelte.plugin.css.completions.enable`

Enable auto completions for CSS. _Default_: `true`

##### `svelte.plugin.css.completions.emmet`

Enable emmet auto completions for CSS. _Default_: `true`
If you want to disable emmet completely everywhere (not just Svelte), you can also set `"emmet.showExpandedAbbreviation": "never"` in your settings.

##### `svelte.plugin.css.documentColors.enable`

Enable document colors for CSS. _Default_: `true`

##### `svelte.plugin.css.colorPresentations.enable`

Enable color picker for CSS. _Default_: `true`

##### `svelte.plugin.css.documentSymbols.enable`

Enable document symbols for CSS. _Default_: `true`

##### `svelte.plugin.css.selectionRange.enable`

Enable selection range for CSS. _Default_: `true`

##### `svelte.plugin.html.enable`

Enable the HTML plugin. _Default_: `true`

##### `svelte.plugin.html.hover.enable`

Enable hover info for HTML. _Default_: `true`

##### `svelte.plugin.html.completions.enable`

Enable auto completions for HTML. _Default_: `true`

##### `svelte.plugin.html.completions.emmet`

Enable emmet auto completions for HTML. _Default_: `true`
If you want to disable emmet completely everywhere (not just Svelte), you can also set `"emmet.showExpandedAbbreviation": "never"` in your settings.

##### `svelte.plugin.html.tagComplete.enable`

Enable HTML tag auto closing. _Default_: `true`

##### `svelte.plugin.html.documentSymbols.enable`

Enable document symbols for HTML. _Default_: `true`

##### `svelte.plugin.html.linkedEditing.enable`

Enable Linked Editing for HTML. _Default_: `true`

##### `svelte.plugin.svelte.enable`

Enable the Svelte plugin. _Default_: `true`

##### `svelte.plugin.svelte.diagnostics.enable`

Enable diagnostic messages for Svelte. _Default_: `true`

##### `svelte.plugin.svelte.compilerWarnings`

Svelte compiler warning codes to ignore or to treat as errors. Example: { 'css-unused-selector': 'ignore', 'unused-export-let': 'error'}

##### `svelte.plugin.svelte.format.enable`

Enable formatting for Svelte (includes css & js) using [prettier-plugin-svelte](https://github.com/sveltejs/prettier-plugin-svelte). _Default_: `true`

You can set some formatting options through this extension. They will be ignored if there's any kind of configuration file, for example a `.prettierrc` file. Read more about Prettier's configuration file [here](https://prettier.io/docs/en/configuration.html).

##### `svelte.plugin.svelte.format.config.svelteSortOrder`

Format: join the keys `options`, `scripts`, `markup`, `styles` with a `-` in the order you want. _Default_: `options-scripts-markup-styles`

This option is ignored if there's any kind of configuration file, for example a `.prettierrc` file.

##### `svelte.plugin.svelte.format.config.svelteStrictMode`

More strict HTML syntax. _Default_: `false`

This option is ignored if there's any kind of configuration file, for example a `.prettierrc` file.

##### `svelte.plugin.svelte.format.config.svelteAllowShorthand`

Option to enable/disable component attribute shorthand if attribute name and expression are the same. _Default_: `true`

This option is ignored if there's any kind of configuration file, for example a `.prettierrc` file.

##### `svelte.plugin.svelte.format.config.svelteBracketNewLine`

Put the `>` of a multiline element on a new line. _Default_: `true`

This option is ignored if there's any kind of configuration file, for example a `.prettierrc` file.

##### `svelte.plugin.svelte.format.config.svelteIndentScriptAndStyle`

Whether or not to indent code inside `<script>` and `<style>` tags. _Default_: `true`

This option is ignored if there's any kind of configuration file, for example a `.prettierrc` file.

##### `svelte.plugin.svelte.format.config.printWidth`

Maximum line width after which code is tried to be broken up. This is a Prettier core option. If you have the Prettier extension installed, this option is ignored and the corresponding option of that extension is used instead. This option is also ignored if there's any kind of configuration file, for example a `.prettierrc` file. _Default_: `80`

##### `svelte.plugin.svelte.format.config.singleQuote`

Use single quotes instead of double quotes, where possible. This is a Prettier core option. If you have the Prettier extension installed, this option is ignored and the corresponding option of that extension is used instead. This option is also ignored if there's any kind of configuration file, for example a `.prettierrc` file. _Default_: `false`

##### `svelte.plugin.svelte.hover.enable`

Enable hover info for Svelte (for tags like #if/#each). _Default_: `true`

##### `svelte.plugin.svelte.completions.enable`

Enable autocompletion for Svelte (for tags like #if/#each). _Default_: `true`

##### `svelte.plugin.svelte.rename.enable`

Enable rename/move Svelte files functionality. _Default_: `true`

##### `svelte.plugin.svelte.codeActions.enable`

Enable code actions for Svelte. _Default_: `true`

##### `svelte.plugin.svelte.selectionRange.enable`

Enable selection range for Svelte. _Default_: `true`

##### `svelte.plugin.svelte.runesLegacyModeCodeLens.enable`

Whether or not to show a code lens at the top of Svelte files indicating if they are in runes mode or legacy mode. Only visible in Svelte 5 projects. _Default_: `true`

##### `svelte.plugin.svelte.defaultScriptLanguage`

The default language to use when generating new script tags in Svelte. _Default_: `none`

#### `svelte.plugin.svelte.documentHighlight.enable`

Enable document highlight support. Requires a restart. _Default_: `true`

## Credits

-   [James Birtles](https://github.com/jamesbirtles) for creating the foundation which this language server is built on
-   Vue's [Vetur](https://github.com/vuejs/vetur) language server which heavily inspires this project
