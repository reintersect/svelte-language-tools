// Differential correctness check: JS TypeScript engine vs the tsgo engine.
//
// Runs the same requests against two language-server processes — one with SVELTE_LS_TSGO=1,
// one without — and diffs the results. This is the "does it actually work as an LSP" oracle:
// byte-parity with upstream is not the goal, but a diagnostic that moves, disappears, or lands
// on the wrong token is a real regression.
//
// Usage: node bench/compare-engines.mjs [--project <dir>] [--files N]
import { LspClient, sleep } from './lsp-client.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = args.indexOf(name);
    return i === -1 ? dflt : args[i + 1];
};
const PROJECT = path.resolve(argOf('--project', process.env.SVELTE_LS_BENCH_PROJECT ?? '.'));
const MAX_FILES = Number(argOf('--files', 15));

const uri = (p) => pathToFileURL(p).href;

function findSvelteFiles(root, limit) {
    const out = [];
    const skip = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build']);
    const walk = (dir, depth) => {
        if (out.length >= limit || depth > 10) return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (out.length >= limit) return;
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!skip.has(e.name)) walk(full, depth + 1);
            } else if (e.name.endsWith('.svelte')) {
                out.push(full);
            }
        }
    };
    walk(path.join(root, 'src'), 0);
    return out;
}

async function startServer(useTsGo) {
    const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
        cwd: PROJECT,
        env: { ...process.env, SVELTE_LS_TSGO: useTsGo ? '1' : '' }
    });
    const diagnostics = new Map();
    const waiters = new Map();
    client.onNotification('textDocument/publishDiagnostics', (p) => {
        diagnostics.set(p.uri, p.diagnostics);
        const w = waiters.get(p.uri);
        if (w) {
            waiters.delete(p.uri);
            w(p.diagnostics);
        }
    });
    client.onRequest('workspace/configuration', (p) => (p.items || []).map(() => ({})));
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);

    await client.request(
        'initialize',
        {
            processId: process.pid,
            rootUri: uri(PROJECT),
            workspaceFolders: [{ uri: uri(PROJECT), name: path.basename(PROJECT) }],
            capabilities: {
                workspace: { configuration: true },
                textDocument: {
                    synchronization: {},
                    publishDiagnostics: {},
                    hover: { contentFormat: ['plaintext'] }
                }
            }
        },
        180000
    );
    client.notify('initialized', {});

    const waitDiagnostics = (fileUri, timeoutMs = 120000) =>
        new Promise((resolve) => {
            const t = setTimeout(() => {
                waiters.delete(fileUri);
                resolve(diagnostics.get(fileUri) ?? null);
            }, timeoutMs);
            waiters.set(fileUri, (d) => {
                clearTimeout(t);
                resolve(d);
            });
        });

    return { client, waitDiagnostics };
}

/** Compact, order-insensitive representation of a diagnostic for diffing. */
const key = (d) =>
    `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character} [${d.code ?? '?'}]`;

const files = findSvelteFiles(PROJECT, MAX_FILES);
console.log(`comparing ${files.length} files under ${PROJECT}\n`);

const js = await startServer(false);
const go = await startServer(true);

let identical = 0;
const differences = [];

try {
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const fileUri = uri(file);
        const rel = path.relative(PROJECT, file);

        for (const engine of [js, go]) {
            engine.client.notify('textDocument/didOpen', {
                textDocument: { uri: fileUri, languageId: 'svelte', version: 1, text }
            });
        }
        const [a, b] = await Promise.all([
            js.waitDiagnostics(fileUri),
            go.waitDiagnostics(fileUri)
        ]);

        const setA = new Set((a ?? []).map(key));
        const setB = new Set((b ?? []).map(key));
        const onlyJs = [...setA].filter((k) => !setB.has(k));
        const onlyGo = [...setB].filter((k) => !setA.has(k));

        if (!onlyJs.length && !onlyGo.length) {
            identical++;
            console.log(`  same  ${rel}  (${setA.size} diagnostics)`);
        } else {
            differences.push({ rel, onlyJs, onlyGo, a: a ?? [], b: b ?? [] });
            console.log(`  DIFF  ${rel}  js=${setA.size} tsgo=${setB.size}`);
            for (const k of onlyJs.slice(0, 4)) console.log(`          only js  : ${k}`);
            for (const k of onlyGo.slice(0, 4)) console.log(`          only tsgo: ${k}`);
        }
    }
} finally {
    js.client.dispose();
    go.client.dispose();
}

console.log(`\n===== ${identical}/${files.length} files identical =====`);
if (differences.length) {
    console.log('\nfirst differing file in detail:');
    const d = differences[0];
    console.log(`  ${d.rel}`);
    console.log(
        '  js  :',
        JSON.stringify(
            d.a.slice(0, 5).map((x) => ({ k: key(x), m: x.message.slice(0, 90) })),
            null,
            2
        )
    );
    console.log(
        '  tsgo:',
        JSON.stringify(
            d.b.slice(0, 5).map((x) => ({ k: key(x), m: x.message.slice(0, 90) })),
            null,
            2
        )
    );
    process.exitCode = 1;
}
