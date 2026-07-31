// Svelte language server latency harness.
//
// Drives packages/language-server over stdio with a scripted editing session and reports
// p50/p95 per LSP method, plus the two numbers that actually matter to a user:
//   - cold start:            initialize -> first diagnostics for the opened file
//   - keystroke -> diagnostics: didChange -> diagnostics reflecting that change
//
// Usage:
//   node bench/harness.mjs [--project <dir>] [--file <rel.svelte>] [--iterations N]
//                          [--label NAME] [--json out.json] [--compare base.json]
//
// Point --project at a real SvelteKit app; the numbers below came from a ~800-component one.
import { LspClient, sleep } from './lsp-client.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');

function parseArgs(argv) {
    const out = {
        project: process.env.SVELTE_LS_BENCH_PROJECT ?? '',
        file: 'src/lib/components/composer/Composer.svelte',
        iterations: 12,
        warmup: 3,
        secondFile: 'src/lib/components/ui/settings/parts/developer/ApiKeysTable.svelte',
        label: 'baseline',
        json: null,
        compare: null
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') continue;
        const next = () => argv[++i];
        if (a === '--project') out.project = path.resolve(next());
        else if (a === '--file') out.file = next();
        else if (a === '--warmup') out.warmup = Number(next());
        else if (a === '--iterations') out.iterations = Number(next());
        else if (a === '--secondFile') out.secondFile = next();
        else if (a === '--label') out.label = next();
        else if (a === '--json') out.json = path.resolve(next());
        else if (a === '--compare') out.compare = path.resolve(next());
        else throw new Error(`unknown arg ${a}`);
    }
    return out;
}

const uri = (p) => pathToFileURL(p).href;
const now = () => Number(process.hrtime.bigint()) / 1e6;

function stats(samples) {
    if (!samples.length) return null;
    const s = [...samples].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const stdev = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    return {
        n: s.length,
        // `min` is the least noise-contaminated estimate of the true cost and is the number
        // to trust when comparing runs on a machine that is doing anything else.
        min: +s[0].toFixed(1),
        p50: +at(0.5).toFixed(1),
        p95: +at(0.95).toFixed(1),
        max: +s[s.length - 1].toFixed(1),
        stdev: +stdev.toFixed(1)
    };
}

const opts = parseArgs(process.argv);
const filePath = path.join(opts.project, opts.file);
if (!fs.existsSync(filePath)) {
    console.error(`benchmark file not found: ${filePath}`);
    process.exit(1);
}

const original = fs.readFileSync(filePath, 'utf8');
const fileUri = uri(filePath);
const timings = {};
const push = (k, ms) => (timings[k] ??= []).push(ms);
/** Per-iteration series, so a single slow request can be located rather than just averaged. */
const series = {};
let iteration = -1;
const record = (k, ms) => {
    push(k, ms);
    (series[k] ??= []).push({ i: iteration, ms: +ms.toFixed(1) });
};

/** Find caret offsets we can repeatedly probe, varied so we don't measure completion cache hits. */
function probePoints(text) {
    const lines = text.split('\n');
    const pts = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        // after a `.` — a member-access position, the expensive completion case
        const dot = l.indexOf('.');
        if (dot > 0 && /[A-Za-z_$]/.test(l[dot - 1] ?? ''))
            pts.push({ line: i, character: dot + 1 });
    }
    return pts.length ? pts : [{ line: 1, character: 0 }];
}

const client = new LspClient(process.execPath, [SERVER, '--stdio'], { cwd: opts.project });
// The server publishes diagnostics WITHOUT a version field, so a publish cannot be matched to
// the edit that caused it by version. Instead each edit injects a uniquely-named undefined
// identifier and we wait for the diagnostic that names it — an unambiguous correlation that a
// stale in-flight publish from the previous iteration cannot satisfy.
let diagResolve = null;
let diagWaitMarker = null;
let secondFileWaiter = null;
client.onNotification('textDocument/publishDiagnostics', (p) => {
    if (secondFileWaiter && p.uri === secondFileWaiter.uri) {
        if (process.env.BENCH_DEBUG) {
            console.log(
                `    [second file publish] n=${p.diagnostics.length} ${p.diagnostics
                    .slice(0, 3)
                    .map((d) => 'TS' + d.code)
                    .join(',')}`
            );
        }
        if (p.diagnostics.some((d) => d.message.includes(secondFileWaiter.marker))) {
            const w = secondFileWaiter;
            secondFileWaiter = null;
            w.resolve?.();
        }
        return;
    }
    if (p.uri !== fileUri || !diagResolve) return;
    if (diagWaitMarker && !p.diagnostics.some((d) => d.message.includes(diagWaitMarker))) return;
    const r = diagResolve;
    diagResolve = null;
    r(p);
});
client.onRequest('workspace/configuration', (p) => (p.items || []).map(() => ({})));
client.onRequest('client/registerCapability', () => null);
client.onRequest('window/workDoneProgress/create', () => null);

const waitForDiagnostics = (marker, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
        diagWaitMarker = marker;
        const t = setTimeout(() => {
            diagResolve = null;
            reject(
                new Error(
                    `no diagnostics${marker ? ` naming ${marker}` : ''} within ${timeoutMs}ms`
                )
            );
        }, timeoutMs);
        diagResolve = (p) => {
            clearTimeout(t);
            resolve(p);
        };
    });

/** Insert `text` immediately after the opening `<script ...>` tag so it lands in real TS. */
function injectIntoScript(source, text) {
    const m = /<script[^>]*>/.exec(source);
    if (!m) throw new Error('benchmark file has no <script> block');
    const at = m.index + m[0].length;
    return source.slice(0, at) + '\n' + text + source.slice(at);
}

let measuring = false;
const timed = async (key, fn) => {
    const t0 = now();
    let r;
    try {
        r = await fn();
    } catch (e) {
        if (measuring) record(key + ' (ERR)', now() - t0);
        return null;
    }
    if (measuring) record(key, now() - t0);
    return r;
};

let coldStartMs = null;
let secondFileOpenMs = null;
let version = 1;

try {
    const t0 = now();
    await client.request(
        'initialize',
        {
            processId: process.pid,
            rootUri: uri(opts.project),
            workspaceFolders: [{ uri: uri(opts.project), name: path.basename(opts.project) }],
            initializationOptions: {
                configuration: { svelte: {}, typescript: {}, javascript: {} },
                dontFilterIncompleteCompletions: true
            },
            capabilities: {
                workspace: { configuration: true, applyEdit: true },
                textDocument: {
                    synchronization: { dynamicRegistration: true },
                    publishDiagnostics: { versionSupport: true },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    completion: {
                        completionItem: { snippetSupport: true, documentationFormat: ['markdown'] }
                    },
                    semanticTokens: {
                        requests: { full: true, range: true },
                        tokenTypes: ['class', 'function', 'variable', 'property'],
                        tokenModifiers: [],
                        formats: ['relative']
                    },
                    codeAction: {
                        codeActionLiteralSupport: {
                            codeActionKind: { valueSet: ['quickfix', 'source'] }
                        }
                    },
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    inlayHint: {}
                }
            }
        },
        120000
    );
    client.notify('initialized', {});

    client.notify('textDocument/didOpen', {
        textDocument: { uri: fileUri, languageId: 'svelte', version, text: original }
    });
    await waitForDiagnostics(null, 180000);
    coldStartMs = now() - t0;
    console.log(`cold start (initialize -> first diagnostics): ${coldStartMs.toFixed(0)}ms\n`);

    // Probe against the *edited* text: the injected marker adds a line inside <script>, so
    // positions derived from `original` would be off by one line and land on whitespace,
    // silently turning hover/completion into measurements of nothing.
    const points = probePoints(injectIntoScript(original, '__bench_probe__;'));
    const pick = (i) => points[i % points.length];

    // Opening another file mid-session is its own cost, distinct from project load: the shadow
    // has to be transformed and handed to the engine for the first time.
    if (opts.secondFile) {
        const secondPath = path.join(opts.project, opts.secondFile);
        if (fs.existsSync(secondPath)) {
            const secondUri = uri(secondPath);
            const secondText = fs.readFileSync(secondPath, 'utf8');
            const marker = '__bench_secondfile__';
            const tSecond = now();
            secondFileWaiter = { uri: secondUri, marker, resolve: null };
            const wait = new Promise((resolve) => (secondFileWaiter.resolve = resolve));
            client.notify('textDocument/didOpen', {
                textDocument: {
                    uri: secondUri,
                    languageId: 'svelte',
                    version: 1,
                    text: injectIntoScript(secondText, `${marker};`)
                }
            });
            await Promise.race([wait, sleep(120000)]);
            secondFileOpenMs = now() - tSecond;
            console.log(`open another file -> diagnostics: ${secondFileOpenMs.toFixed(0)}ms\n`);
        }
    }

    const total = opts.warmup + opts.iterations;
    console.log(
        `running ${opts.warmup} warmup + ${opts.iterations} measured iterations against ${opts.file} ...`
    );
    for (let i = 0; i < total; i++) {
        const pt = pick(i);
        // Warmup iterations exercise the same code paths but are not recorded: the first few
        // requests pay JIT, lazy-snapshot and TS program-warming costs that skew every stat.
        measuring = i >= opts.warmup;
        iteration = i;

        // ---- keystroke -> diagnostics. The number the artificial-delay budget dominates.
        version++;
        const marker = `__bench_undefined_${i}__`;
        const t0k = now();
        client.notify('textDocument/didChange', {
            textDocument: { uri: fileUri, version },
            contentChanges: [{ text: injectIntoScript(original, `${marker};`) }]
        });
        await waitForDiagnostics(marker, 120000);
        if (measuring) record('keystroke -> diagnostics', now() - t0k);

        await timed('completion', () =>
            client.request('textDocument/completion', {
                textDocument: { uri: fileUri },
                position: pt,
                context: { triggerKind: 1 }
            })
        );
        await timed('hover', () =>
            client.request('textDocument/hover', { textDocument: { uri: fileUri }, position: pt })
        );
        await timed('definition', () =>
            client.request('textDocument/definition', {
                textDocument: { uri: fileUri },
                position: pt
            })
        );
        await timed('semanticTokens/full', () =>
            client.request('textDocument/semanticTokens/full', { textDocument: { uri: fileUri } })
        );
        await timed('documentSymbol', () =>
            client.request('textDocument/documentSymbol', { textDocument: { uri: fileUri } })
        );
        await timed('codeAction', () =>
            client.request('textDocument/codeAction', {
                textDocument: { uri: fileUri },
                range: { start: pt, end: pt },
                context: { diagnostics: [] }
            })
        );
        await timed('inlayHint', () =>
            client.request('textDocument/inlayHint', {
                textDocument: { uri: fileUri },
                range: { start: { line: 0, character: 0 }, end: pt }
            })
        );
        process.stdout.write(`  ${i + 1}/${opts.iterations}\r`);
    }
    console.log('\n');
} catch (err) {
    console.error('HARNESS ERROR:', err.message);
    console.error(client.stderr.slice(-3000));
    process.exitCode = 1;
} finally {
    client.dispose();
}

const report = {
    label: opts.label,
    project: opts.project,
    file: opts.file,
    iterations: opts.iterations,
    coldStartMs: coldStartMs === null ? null : +coldStartMs.toFixed(0),
    secondFileOpenMs: secondFileOpenMs === null ? null : +secondFileOpenMs.toFixed(0),
    series,
    methods: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stats(v)]))
};

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log(`=== ${opts.label} — ${path.basename(opts.project)} (${opts.iterations} measured) ===`);
console.log(
    `${pad('method', 28)}${lpad('min', 8)}${lpad('p50', 8)}${lpad('p95', 9)}${lpad('stdev', 8)}`
);
console.log('-'.repeat(61));
console.log(
    `${pad('COLD project load', 28)}${lpad(report.coldStartMs ?? '-', 8)}${lpad('-', 8)}${lpad('-', 9)}${lpad('-', 8)}`
);
console.log(
    `${pad('COLD open another file', 28)}${lpad(report.secondFileOpenMs ?? '-', 8)}${lpad('-', 8)}${lpad('-', 9)}${lpad('-', 8)}`
);
for (const [k, s] of Object.entries(report.methods)) {
    console.log(
        `${pad(k, 28)}${lpad(s.min, 8)}${lpad(s.p50, 8)}${lpad(s.p95, 9)}${lpad(s.stdev, 8)}`
    );
}

// Name the outliers rather than letting p95 hide them.
for (const [method, samples] of Object.entries(report.series ?? {})) {
    const stat = report.methods[method];
    if (!stat || stat.max < stat.p50 * 3 || stat.max < 50) {
        continue;
    }
    const worst = [...samples].sort((a, b) => b.ms - a.ms).slice(0, 3);
    console.log(
        `\n  outlier in ${method}: ${worst.map((w) => `iter#${w.i}=${w.ms}ms`).join(', ')}  (p50 ${stat.p50}ms)`
    );
}

if (opts.compare && fs.existsSync(opts.compare)) {
    const base = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
    console.log(`\n=== vs ${base.label} (comparing min — the noise-resistant statistic) ===`);
    console.log(
        `${pad('method', 28)}${lpad('base min', 10)}${lpad('now min', 10)}${lpad('delta', 9)}${lpad('noisy?', 9)}`
    );
    console.log('-'.repeat(66));
    const dz = (b, n) => (b ? `${(((n - b) / b) * 100).toFixed(0)}%` : '-');
    if (base.coldStartMs && report.coldStartMs) {
        console.log(
            `${pad('COLD project load', 28)}${lpad(base.coldStartMs, 10)}${lpad(report.coldStartMs, 10)}${lpad(dz(base.coldStartMs, report.coldStartMs), 9)}${lpad('n=1', 9)}`
        );
    }
    if (base.secondFileOpenMs && report.secondFileOpenMs) {
        console.log(
            `${pad('COLD open another file', 28)}${lpad(base.secondFileOpenMs, 10)}${lpad(report.secondFileOpenMs, 10)}${lpad(dz(base.secondFileOpenMs, report.secondFileOpenMs), 9)}${lpad('n=1', 9)}`
        );
    }
    for (const [k, s] of Object.entries(report.methods)) {
        const b = base.methods?.[k];
        if (!b || b.min === undefined) continue;
        // Flag comparisons where the change is small relative to run-to-run spread, so a
        // difference that is really just machine noise doesn't get read as a win.
        const delta = Math.abs(s.min - b.min);
        const noisy = delta < Math.max(s.stdev ?? 0, b.stdev ?? 0) ? 'noise' : '';
        console.log(
            `${pad(k, 28)}${lpad(b.min, 10)}${lpad(s.min, 10)}${lpad(dz(b.min, s.min), 9)}${lpad(noisy, 9)}`
        );
    }
}

if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${opts.json.replace(REPO, '<repo>')}`);
}
