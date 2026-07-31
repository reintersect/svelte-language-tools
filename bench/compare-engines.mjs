// Differential correctness check: JS TypeScript engine vs the tsgo engine.
//
// Runs the same requests against two language-server processes — one with SVELTE_LS_TSGO=1,
// one without — and diffs the results. This is the "does it actually work as an LSP" oracle:
// byte-parity with upstream is not the goal, but a diagnostic that moves, disappears, or lands
// on the wrong token is a real regression.
//
// Usage: node bench/compare-engines.mjs [--project <dir>] [--files N | --all]
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
const requestedLimit = argOf('--files', undefined);
const MAX_FILES = args.includes('--all') ? Number.POSITIVE_INFINITY : Number(requestedLimit ?? 25);
const DIAGNOSTIC_TIMEOUT_MS = Number(argOf('--timeout', 120000));
if (
    MAX_FILES !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(MAX_FILES) || MAX_FILES <= 0)
) {
    throw new Error('--files must be a positive integer');
}
if (!Number.isFinite(DIAGNOSTIC_TIMEOUT_MS) || DIAGNOSTIC_TIMEOUT_MS <= 0) {
    throw new Error('--timeout must be a positive number of milliseconds');
}

const uri = (p) => pathToFileURL(p).href;

function findSvelteFiles(root) {
    const out = [];
    const skip = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build']);
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!skip.has(e.name)) walk(full);
            } else if (e.name.endsWith('.svelte')) {
                out.push(full);
            }
        }
    };
    walk(root);
    return out;
}

/** A bounded deterministic cross-section, rather than the first package in lexical order. */
function sampleEvenly(files, limit) {
    if (files.length <= limit || limit === Number.POSITIVE_INFINITY) return files;
    if (limit === 1) return [files[Math.floor(files.length / 2)]];
    return Array.from(
        { length: limit },
        (_, index) => files[Math.floor((index * (files.length - 1)) / (limit - 1))]
    );
}

async function startServer(useTsGo) {
    const label = useTsGo ? 'tsgo' : 'classic';
    const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
        cwd: PROJECT,
        env: { ...process.env, SVELTE_LS_TSGO: useTsGo ? '1' : '' }
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
                workspace: {
                    configuration: true,
                    diagnostics: { refreshSupport: true }
                },
                textDocument: {
                    synchronization: {},
                    diagnostic: {
                        dynamicRegistration: false,
                        relatedDocumentSupport: true
                    },
                    hover: { contentFormat: ['plaintext'] }
                }
            }
        },
        180000
    );
    client.notify('initialized', {});

    if (useTsGo) {
        for (let i = 0; i < 40 && !client.stderr.includes('[tsgo] enabled'); i++) {
            if (client.exited) break;
            await sleep(50);
        }
        if (!client.stderr.includes('[tsgo] enabled')) {
            client.dispose();
            throw new Error(
                `tsgo server did not confirm that the native engine was enabled:\n${client.stderr}`
            );
        }
    }
    if (client.exited) {
        throw new Error(`server exited during initialization: ${JSON.stringify(client.exited)}`);
    }

    const pullDiagnostics = async (fileUri, timeoutMs = DIAGNOSTIC_TIMEOUT_MS) => {
        let report;
        try {
            report = await client.request(
                'textDocument/diagnostic',
                { textDocument: { uri: fileUri } },
                timeoutMs
            );
        } catch (error) {
            throw new Error(
                `${label} diagnostics failed for ${fileUri}: ${
                    error instanceof Error ? error.message : error
                }${client.stderr ? `\n${client.stderr}` : ''}`
            );
        }
        if (!report || report.kind !== 'full' || !Array.isArray(report.items)) {
            throw new Error(
                `${label} returned an incomplete/malformed first diagnostic report for ${fileUri}: ` +
                    JSON.stringify(report)
            );
        }
        return report.items;
    };

    return { client, pullDiagnostics, label };
}

/** Full stable representation: positions alone hide message/severity regressions and duplicates. */
const key = (d) =>
    JSON.stringify({
        range: d.range,
        severity: d.severity ?? null,
        code: d.code ?? null,
        source: d.source ?? null,
        message: d.message,
        tags: d.tags ?? [],
        relatedInformation: d.relatedInformation ?? []
    });

const multiset = (diagnostics) => {
    const result = new Map();
    for (const diagnostic of diagnostics) {
        const k = key(diagnostic);
        result.set(k, (result.get(k) ?? 0) + 1);
    }
    return result;
};

const subtract = (left, right) => {
    const result = [];
    for (const [k, count] of left) {
        for (let i = 0; i < count - (right.get(k) ?? 0); i++) result.push(k);
    }
    return result;
};

const discoveredFiles = findSvelteFiles(PROJECT);
const files = sampleEvenly(discoveredFiles, MAX_FILES);
if (!discoveredFiles.length) {
    throw new Error(`no .svelte files found under ${PROJECT}`);
}
console.log(
    `comparing ${files.length}/${discoveredFiles.length} files under ${PROJECT}` +
        (files.length < discoveredFiles.length
            ? ' (deterministic sample; use --all for the complete corpus)'
            : '') +
        '\n'
);

let identical = 0;
const differences = [];
let js;
let go;

try {
    js = await startServer(false);
    go = await startServer(true);
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
            js.pullDiagnostics(fileUri),
            go.pullDiagnostics(fileUri)
        ]);
        for (const engine of [js, go]) {
            engine.client.notify('textDocument/didClose', {
                textDocument: { uri: fileUri }
            });
        }

        const setA = multiset(a);
        const setB = multiset(b);
        const onlyJs = subtract(setA, setB);
        const onlyGo = subtract(setB, setA);

        if (!onlyJs.length && !onlyGo.length) {
            identical++;
            console.log(`  same  ${rel}  (${a.length} diagnostics)`);
        } else {
            differences.push({ rel, onlyJs, onlyGo, a, b });
            console.log(`  DIFF  ${rel}  js=${a.length} tsgo=${b.length}`);
            for (const k of onlyJs.slice(0, 4)) console.log(`          only js  : ${k}`);
            for (const k of onlyGo.slice(0, 4)) console.log(`          only tsgo: ${k}`);
        }
    }
} finally {
    js?.client.dispose();
    go?.client.dispose();
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
