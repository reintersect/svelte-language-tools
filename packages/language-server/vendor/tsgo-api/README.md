# Bundled tsgo API clients

The Effect tsgo npm package currently ships the native binaries but not TypeScript-Go's matching
JavaScript API client. The language server needs that client to attach to
`custom/initializeAPISession`; without it, member and component-prop completions must use the much
slower LSP completion route.

Each version directory contains an esbuild bundle of the official `typescript` package's
`unstable/async` entry, its exact TypeScript-Go commit identity, and the upstream license/notice.
`TsGoEngine` exposes a bundle only when the Effect package version, TypeScript version and git
commit all match the tested combination. A mismatch fails closed to ordinary LSP requests.

The 7.0.2 bundle was produced from `typescript@7.0.2` with esbuild 0.25.6:

```sh
esbuild dist/api/async/api.js \
  --bundle --platform=node --format=esm --target=node18 \
  --banner:js='import { createRequire as __tsgoCreateRequire } from "node:module"; const require = __tsgoCreateRequire(import.meta.url);' \
  --outfile=api.mjs --legal-comments=inline
```

The `createRequire` banner preserves the vendored `vscode-jsonrpc` CommonJS modules while ESM keeps
the upstream client's `import.meta.url` behavior intact.
