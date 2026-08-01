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
> not current performance claims. The post-fix 1 August 2026 acceptance run found editor
> fresh-process p50/p95 of 6.41s/7.97s classic versus 4.59s/5.40s stock tsgo. A separate strict
> whole-project checker oracle completed in 17.3s classic versus 6.7s stock. Fail-fast dependency
> discovery reduced the native adapter phase from roughly 13-17s to 1.45s; a warm checker reused all
> 663 Svelte shadows in 148ms with zero transforms or writes.
>
> Focused fixtures are diffed against the classic engine including code, message, severity and full
> range. That is a tested invariant rather than a universal promise: TypeScript 6 and the evolving
> TypeScript 7 native compiler can intentionally differ, so engine updates still require reviewing
> the full differential oracle.
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

Published as **`@reintersect/svelte-check`**. Run it with `--tsgo` to use the native engine; without
the flag it behaves exactly like upstream.

## Using this fork

**1. Install it in place of upstream**, together with a tsgo binary. The npm alias keeps every
`svelte-check` script and tool working unchanged (in a pnpm workspace, a catalog entry does the
same for every package at once):

```bash
pnpm add -D svelte-check@npm:@reintersect/svelte-check@^4.8.6 @reintersect/effect-tsgo
```

**2. Add `--tsgo` to your check script.** It requires an explicit tsconfig:

```json
{
    "scripts": {
        "check": "svelte-kit sync && svelte-check --tsgo --tsconfig ./tsconfig.json"
    }
}
```

Generated `.tsx` twins land in `node_modules/.cache/svelte-lsp/` in each package that has
components — already ignored by git and search tools and safe to delete. The implementation uses a
transform/config fingerprint plus source freshness to reuse proven unchanged twins and regenerates
stale or unproven entries. Treat zero-transform/zero-write warm runs as an acceptance result to
measure on your project, not a blanket cache guarantee.

**Requirements:** a tsconfig/jsconfig, and `@reintersect/effect-tsgo`, `@typescript/native` or
`@typescript/native-preview` in the workspace. Commit the lockfile to pin the exact engine you have
verified; this repository's CI independently asserts its exact stock-engine package and version.
`SVELTE_LS_RSVELTE=1` opts the transform into rsvelte's Rust svelte2tsx (fast, but its source-map
bug can lose template-level diagnostics — off by default).

The checker uses **`@reintersect/svelte-load-config`** as the canonical scoped runtime for
Svelte/Vite config discovery and invalidation. It is installed transitively with the checker; the
superseded `@reintersect/load-config` package is not required.

The native compiler follows TypeScript 7 rather than the JavaScript TypeScript 6 engine. Removed or
not-yet-supported settings such as `baseUrl`, `moduleResolution: "node"`/`"node10"`, `outFile`, ES5
targets and AMD/System-style module output need to be migrated before using `--tsgo`.

**In CI**, [`reintersect/svelte-check-action`](https://github.com/reintersect/svelte-check-action)
runs this fork with `tsgo: true` and comments diagnostics on the pull request.

# Check your code with svelte-check

Provides CLI diagnostics checks for:

-   Unused CSS
-   Svelte A11y hints
-   JavaScript/TypeScript compiler errors

Requires Node 18 or later.

### Usage:

#### Local / in your project

Installation:

```sh
npm i svelte-check --save-dev
```

Package.json:

```json
{
    // ...
    "scripts": {
        "svelte-check": "svelte-check"
        // ...
    },
    // ...
    "devDependencies": {
        "svelte-check": "..."
        // ...
    }
}
```

Usage:

`npm run svelte-check`

#### Global (not recommended)

Installation:

```sh
npm i svelte-check svelte -g
```

Usage:

1. Go to folder where to start checking
2. `svelte-check`

#### TypeScript 7 supports

TypeScript 7 support currently requires the `--tsgo` or `--tsgo-experimental-api` flag. You need to install both TypeScript 7 and TypeScript 6.

You can setup both version with an npm alias:

```sh
npm install --save-dev typescript@~6 @typescript/native@npm:typescript@7
```

### Args:

| Flag                                                            | Description                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--workspace <path>`                                            | Path to your workspace. All subdirectories except node_modules and those listed in `--ignore` are checked                                                                                                                                                                                                                                                                                                |
| `--config <path>`                                               | Pass a path to a `svelte.config` or `vite.config` file. The path can be relative to the workspace path or absolute. Use this when your config file has a non-standard name or location. This also turns off discovery of Svelte config files below the given path.                                                                                                                                       |
| `--output <human\|human-verbose\|machine\|machine-verbose>`     |
| `--watch`                                                       | Will not exit after one pass but keep watching files for changes and rerun diagnostics                                                                                                                                                                                                                                                                                                                   |
| `--preserveWatchOutput`                                         | Do not clear the screen in watch mode                                                                                                                                                                                                                                                                                                                                                                    |
| `--tsconfig <path>`                                             | Pass a path to a tsconfig or jsconfig file. The path can be relative to the workspace path or absolute. Doing this means that only files matched by the files/include/exclude pattern of the config file are diagnosed. It also means that errors from TypeScript and JavaScript files are reported. If not given, will do an upwards traversal looking for the next jsconfig/tsconfig.json              |
| `--no-tsconfig`                                                 | Use this if you only want to check the Svelte files found in the current directory and below and ignore any JS/TS files (they will not be type-checked)                                                                                                                                                                                                                                                  |
| `--ignore <path1,path2>`                                        | Can only be used in conjunction with `--no-tsconfig`. Files/folders to ignore - relative to workspace root, comma-separated, inside quotes. Example: `--ignore "dist,build"`.                                                                                                                                                                                                                            |
| `--fail-on-warnings`                                            | Will also exit with error code when there are warnings                                                                                                                                                                                                                                                                                                                                                   |
| `--compiler-warnings <code1:error\|ignore,code2:error\|ignore>` | A list of Svelte compiler warning codes. Each entry defines whether that warning should be ignored or treated as an error. Warnings are comma-separated, between warning code and error level is a colon; all inside quotes. Example: `--compiler-warnings "css-unused-selector:ignore,unused-export-let:error"`                                                                                         |
| `--diagnostic-sources <js,svelte,css>`                          | A list of diagnostic sources which should run diagnostics on your code. Possible values are `js` (includes TS), `svelte`, `css`. Comma-separated, inside quotes. By default all are active. Example: `--diagnostic-sources "js,svelte"`                                                                                                                                                                  |
| `--threshold <error\|warning>`                                  | Filters the diagnostics to display. `error` will output only errors while `warning` will output warnings and errors.                                                                                                                                                                                                                                                                                     |
| `--incremental`                                                 | Opts into TypeScript's incremental build cache, which speeds up subsequent runs. Saved within `.svelte-kit` or if not available within `.svelte-check`. This might result in slightly different type check outcomes, and certain patterns are not supported. Specifically, anything that is not in the root dir of your tsconfig.json and is a Svelte file will not be properly loaded and type-checked. |
| `--tsgo`                                                        | Use TypeScript's native Go implementation through the shared Svelte overlay. Requires `@reintersect/effect-tsgo`, `@typescript/native`, or `@typescript/native-preview`, plus an explicit tsconfig/jsconfig.                                                                                                                                                                                             |

### FAQ

#### Why is there no option to only check specific files (for example only staged files)?

`svelte-check` needs to know the whole project to do valid checks. Imagine you alter a component property `export let foo` to `export let bar`, but you don't update any of the component usages. They all have errors now but you would not catch them if you only run checks on changed files.

### More docs, preprocessor setup and troubleshooting

[See here](/docs/README.md).

### Machine-Readable Output

Setting the `--output` to `machine` or `machine-verbose` will format output in a way that is easier to read
by machines, e.g. inside CI pipelines, for code quality checks, etc.

Each row corresponds to a new record. Rows are made up of columns that are separated by a
single space character. The first column of every row contains a timestamp in milliseconds
which can be used for monitoring purposes. The second column gives us the "row type", based
on which the number and types of subsequent columns may differ.

The first row is of type `START` and contains the workspace folder (wrapped in quotes).

###### Example:

```
1590680325583 START "/home/user/language-tools/packages/language-server/test/plugins/typescript/testfiles"
```

Any number of `ERROR` or `WARNING` records may follow. Their structure is identical and depends on the output argoument.

If the argument is `machine` it will tell us the filename, the starting line and column numbers, and the error message. The filename is relative to the workspace directory. The filename and the message are both wrapped in quotes.

###### Example:

```
1590680326283 ERROR "codeactions.svelte" 1:16 "Cannot find module 'blubb' or its corresponding type declarations."
1590680326778 WARNING "imported-file.svelte" 0:37 "Component has unused export property 'prop'. If it is for external reference only, please consider using `export const prop`"
```

If the argument is `machine-verbose` it will tell us the filename, the starting line and column numbers, the ending line and column numbers, the error message, the code of diagnostic, the human-friendly description of the code and the human-friendly source of the diagnostic (eg. svelte/typescript). The filename is relative to the workspace directory. Each diagnostic is represented as an [ndjson](https://en.wikipedia.org/wiki/JSON_streaming#Newline-Delimited_JSON) line prefixed by the timestamp of the log.

###### Example:

```
1590680326283 {"type":"ERROR","fn":"codeaction.svelte","start":{"line":1,"character":16},"end":{"line":1,"character":23},"message":"Cannot find module 'blubb' or its corresponding type declarations.","code":2307,"source":"js"}
1590680326778 {"type":"WARNING","filename":"imported-file.svelte","start":{"line":0,"character":37},"end":{"line":0,"character":51},"message":"Component has unused export property 'prop'. If it is for external reference only, please consider using `export
const prop`","code":"unused-export-let","source":"svelte"}
```

The output concludes with a `COMPLETED` message that summarizes total numbers of files, errors and warnings that were encountered during the check.

###### Example:

```
1590680326807 COMPLETED 20 FILES 21 ERRORS 1 WARNINGS 3 FILES_WITH_PROBLEMS
```

If the application experiences a runtime error, this error will appear as a `FAILURE` record.

###### Example:

```
1590680328921 FAILURE "Connection closed"
```

### Credits

-   Vue's [VTI](https://github.com/vuejs/vetur/tree/master/vti) which laid the foundation for `svelte-check`
