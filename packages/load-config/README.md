# @reintersect/svelte-load-config

The fork-scoped Svelte configuration loader used by
`@reintersect/svelte-language-server` and `@reintersect/svelte-check`.

It discovers `svelte.config.*` and `vite.config.*`, returns the effective Svelte compiler and
preprocessor options, and supports coherent cache invalidation for long-running editor and watch
processes. Vite and SvelteKit configuration is evaluated with an explicit project root. For older
SvelteKit/Vite stacks, the loader binds a clean package-local CSS config to `vitePreprocess` and
uses async-local cwd/path dispatch, preventing PostCSS or Tailwind state from leaking between
concurrently loaded workspace packages without changing the operating-system working directory.

Most users should install the language server or checker rather than depending on this package
directly. The implementation is derived from
[`@sveltejs/load-config`](https://github.com/sveltejs/language-tools/tree/master/packages/load-config)
and is distributed under the MIT license.
