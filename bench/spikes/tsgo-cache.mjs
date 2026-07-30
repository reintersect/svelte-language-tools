/**
 * Is tsgo caching anything between diagnostic requests?
 *
 * A `textDocument/diagnostic` on a big project measures ~300ms, and the two explanations have
 * opposite fixes. If an *unchanged* second request is also ~300ms, the cost is per-request and we
 * are asking for something wasteful. If it is ~0ms, the program and checker are cached fine and
 * the whole 300ms is the price of invalidating them — which is TypeScript's documented behaviour
 * (any program change discards the checker outright) and means the lever is doing fewer, later,
 * cancellable checks rather than cheaper ones.
 *
 * Talks to tsgo directly rather than through the language server, so nothing of ours is in the
 * measurement — no debounce, no transform, no mapping.
 *
 * Usage: node bench/spikes/tsgo-cache.mjs --project <dir> [--tsgo-package <name>]
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { LspClient } from '../lsp-client.mjs';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = args.indexOf(name);
    return i === -1 ? dflt : args[i + 1];
};
const PROJECT = path.resolve(argOf('--project', process.env.SVELTE_LS_BENCH_PROJECT ?? '.'));
const TSGO_PACKAGE = argOf('--tsgo-package', '@typescript/native-preview');

const uri = (p) => pathToFileURL(p).href;
const now = () => Number(process.hrtime.bigint()) / 1e6;


// Resolve the binary the same way ShadowManager does.
const { createRequire } = await import('module');
const req = createRequire(import.meta.url);
const pkgJson = req.resolve(`${TSGO_PACKAGE}/package.json`, {
    paths: [PROJECT, path.resolve('.')]
});
const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.tsgo ?? pkg.bin?.tsc);
const TSGO = path.resolve(path.dirname(pkgJson), binRel);

// The overlay the language server already generated for this project.
const overlayDir = path.join(PROJECT, '.svelte-ls-overlay');
const overlayTsconfig = path.join(overlayDir, 'tsconfig.json');
if (!fs.existsSync(overlayTsconfig)) {
    console.error(
        `no overlay at ${overlayTsconfig} — run the language server against this project once first`
    );
    process.exit(1);
}
// Pick a shadow to poke at: a real component's generated twin.
const shadowRoot = path.join(overlayDir, 'svelte');
const findShadow = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            const found = findShadow(full);
            if (found) return found;
        } else if (e.name.endsWith('.svelte.tsx') && fs.statSync(full).size > 2000) {
            return full;
        }
    }
    return null;
};
const wanted = argOf('--shadow', null);
const shadow = wanted
    ? path.join(shadowRoot, wanted)
    : findShadow(shadowRoot);
if (!shadow) {
    console.error('no shadow found under ' + shadowRoot);
    process.exit(1);
}

console.log(`tsgo      ${TSGO_PACKAGE}`);
console.log(`project   ${PROJECT}`);
console.log(`file      ${path.relative(shadowRoot, shadow)}\n`);

const client = new LspClient(TSGO, ['--lsp', '-stdio'], { cwd: overlayDir });
client.onRequest('workspace/configuration', (params) =>
    (params.items ?? [{}]).map(() => ({
        preferences: { importModuleSpecifierEnding: 'index' },
        suggest: {},
        inlayHints: {}
    }))
);

await client.request('initialize', {
    processId: process.pid,
    rootUri: uri(overlayDir),
    workspaceFolders: [{ uri: uri(overlayDir), name: 'overlay' }],
    capabilities: {
        textDocument: { diagnostic: { dynamicRegistration: false } },
        workspace: { configuration: true }
    }
});
client.notify('initialized', {});

const text = fs.readFileSync(shadow, 'utf-8');
client.notify('textDocument/didOpen', {
    textDocument: { uri: uri(shadow), languageId: 'typescriptreact', version: 1, text }
});

const diagnose = async () => {
    const t = now();
    await client.request('textDocument/diagnostic', { textDocument: { uri: uri(shadow) } });
    return now() - t;
};

// Warm: the very first request builds the program, which is not what we are asking about.
const first = await diagnose();
console.log(`first request (builds the program)      ${first.toFixed(0)}ms`);

const unchanged = [];
for (let i = 0; i < 5; i++) unchanged.push(await diagnose());
console.log(
    `repeat, no edit                         ${unchanged.map((x) => x.toFixed(0)).join(', ')}ms`
);

// Now edit and re-ask, five times, to see the steady-state per-edit cost.
const afterEdit = [];
const afterEditRepeat = [];
let version = 1;
for (let i = 0; i < 5; i++) {
    version++;
    client.notify('textDocument/didChange', {
        textDocument: { uri: uri(shadow), version },
        contentChanges: [{ text: text.replace('function render()', `function render/*${i}*/()`) }]
    });
    afterEdit.push(await diagnose());
    afterEditRepeat.push(await diagnose());
}
console.log(
    `after an edit                           ${afterEdit.map((x) => x.toFixed(0)).join(', ')}ms`
);
console.log(
    `immediately again, same text            ${afterEditRepeat.map((x) => x.toFixed(0)).join(', ')}ms`
);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log('\n---');
console.log(`unchanged repeat   ${med(unchanged).toFixed(0)}ms`);
console.log(`per edit           ${med(afterEdit).toFixed(0)}ms`);
if (med(unchanged) < med(afterEdit) / 4) {
    console.log(
        '\n=> The program and checker ARE cached. The cost is invalidation on edit, which is\n' +
            '   TypeScript semantics (a program change discards the checker). Nothing to "turn on";\n' +
            '   the levers are cancelling obsolete checks and shrinking the program.'
    );
} else {
    console.log(
        '\n=> Repeat requests cost the same as edits, so something is invalidating per REQUEST.\n' +
            '   That is ours to fix, not tsgo semantics.'
    );
}

await client.request('shutdown');
client.dispose();
