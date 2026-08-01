# @reintersect/svelte-load-config

## 0.2.4

### Patch Changes

-   Isolate concurrent Svelte and Vite configuration loads with explicit roots and config paths instead
    of changing the process working directory. Preserve and serialize the legacy Vite environment only
    for callers which still need it.

## 0.2.3

### Patch Changes

-   Publish the config runtime under the clearer `@reintersect/svelte-load-config`
    package name.

## 0.2.2

### Patch Changes

-   Publish the loader under the Reintersect scope and make cache invalidation reload
    both ESM and CommonJS Svelte config modules.

## 0.2.1

### Patch Changes

-   fix: ensure config loading happens sequentially ([#3084](https://github.com/sveltejs/language-tools/pull/3084))

## 0.2.0

### Minor Changes

-   feat: make it possible to pass a config file path directly ([#3066](https://github.com/sveltejs/language-tools/pull/3066))

### Patch Changes

-   fix: load esm version of Vite ([#3065](https://github.com/sveltejs/language-tools/pull/3065))

## 0.1.1

### Patch Changes

-   fix: adjust paths in PKG.json ([#3046](https://github.com/sveltejs/language-tools/pull/3046))
