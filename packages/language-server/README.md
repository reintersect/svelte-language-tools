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

Published as **`@reintersect/svelte-language-server`**. Point your editor at it with
`svelte.language-server.ls-path`, and set `"svelte.language-server.tsgo": true` to turn the tsgo
engine on — without it the fork behaves exactly like upstream.

# Svelte Language Server

A language server (implementing the [language server protocol](https://microsoft.github.io/language-server-protocol/))
for Svelte.

Requires Node 12 or later.


## Using this fork in VS Code

The official **Svelte for VS Code** extension can be pointed at a different language server binary,
so there is nothing to build or sideload — keep the extension you already have and redirect it.

**1. Install the server and a tsgo binary** as dev dependencies of the workspace you edit:

```bash
pnpm add -D @reintersect/svelte-language-server @reintersect/effect-tsgo
```

(`@typescript/native` works in place of `@reintersect/effect-tsgo`; the server resolves the binary
from the project, so each project pins its own. In a pnpm workspace, install both at the root.)

**2. Point the extension at it and turn the engine on**, in the workspace's
`.vscode/settings.json`:

```jsonc
{
    "svelte.language-server.ls-path": "./node_modules/@reintersect/svelte-language-server/bin/server.js",
    "svelte.language-server.tsgo": true,
    // The classic TS plugin still runs the JavaScript engine; keep it out of the way.
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

### Experimental: the Rust transform

With `@rsvelte/svelte2tsx` installed, `"svelte.language-server.rsvelte": true` (or
`SVELTE_LS_RSVELTE=1`) transforms Svelte 5 `lang="ts"` components through
[rsvelte](https://github.com/baseballyama/rsvelte)'s native svelte2tsx — several times faster than
the JS transform. **Off by default**: rsvelte's source maps currently ship a generated-column bug,
and even repaired they lose template-level positions, so diagnostics on markup (an unimported
`<Component>`, a bad prop) can silently disappear. Turn it on only if that trade is acceptable;
the default JS transform reports everything.

### What you should notice

Diagnostics after a keystroke land in roughly 400ms instead of roughly 950ms, and opening a large
project takes about 3.5s instead of about 7.5s. Hover, completion, go-to-definition and rename all
go through tsgo too.

### What to expect that is different

- **No refactorings.** TypeScript 7 does not implement `refactor` code actions yet, so "Extract to
  function", "Move to file" and friends are absent. Quickfixes work, but not all of them.
- **A `node_modules/.cache/svelte-lsp` directory** appears in each package that has components. It
  holds the generated `.tsx` twins tsgo type-checks; being under `node_modules/.cache` it is
  already ignored by git and search tools. Deleting it is always safe. (Older builds used a
  visible `.svelte-ls-overlay` directory instead — the server removes those on sight.)
- **`.ts` files still use the JavaScript engine.** `typescript-svelte-plugin` has no tsgo migration
  path, so Svelte intellisense inside plain `.ts` files is unchanged from upstream.

### Turning it off

Remove `ls-path` to go back to the extension's bundled server, or drop `SVELTE_LS_TSGO=1` to keep
this build but run it on the upstream JavaScript engine. Both are one-line reverts, which is the
point — the flag was kept so a bad day is a settings change rather than a reinstall.

### Requirements

`@reintersect/effect-tsgo` (preferred), `@typescript/native` or `@typescript/native-preview`
installed in the workspace being edited. The server resolves the binary from the project, not from
itself, so each project can pin its own; `SVELTE_LS_TSGO_PACKAGE` pins a specific one for A/B runs.
With none present it logs an error and falls back to the JavaScript engine. Component-props
completions additionally need the checker API client (`dist/api/async/api.js`), which ships with
`@typescript/native`; without it the server logs that component-level features are limited and
everything else keeps working.

### Tunables

| environment variable | effect |
|---|---|
| `SVELTE_LS_TSGO=1` | turn the tsgo engine on without the editor setting |
| `SVELTE_LS_TSGO_PACKAGE` | pin which package provides the tsgo binary |
| `SVELTE_LS_RSVELTE=1` | opt into the Rust transform (see above) |
| `SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS` | how long a diagnostics pull waits for typing to settle (default 150) |
| `SVELTE_LS_TIMING=<file>` | append per-phase keystroke timings to a file |

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
