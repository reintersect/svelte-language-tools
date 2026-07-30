/**
 * Does rsvelte's native `svelte2tsx` earn its complexity?
 *
 * Plan Phase 5 budgets the transform at ~3.3x official, not the 21x/54x/281x headline — those
 * are multithreaded batch numbers over 3,417 small fixtures. This measures the single-file,
 * in-process ratio on a real corpus, which is the shape the language server actually uses it in,
 * and reports what that ratio is worth against the two latency budgets we care about:
 *
 *   cold project load   — every component transformed once, ~1s of a ~4s start
 *   keystroke           — one component transformed, ~34ms of a ~420ms round trip
 *
 * It also checks the three things that would make the native path unusable regardless of speed:
 * whether a map comes back at all, whether the options the language server relies on are read,
 * and whether a malformed component takes the process down with it (`panic = "abort"`).
 *
 * Usage:
 *   node bench/spikes/rsvelte-transform.mjs --addon <path/to/rsvelte.node> [--project <dir>] [--files N]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = args.indexOf(name);
    return i === -1 ? dflt : args[i + 1];
};
const ADDON = argOf('--addon', null);
const PROJECT = path.resolve(argOf('--project', process.env.SVELTE_LS_BENCH_PROJECT ?? '.'));
const MAX_FILES = Number(argOf('--files', 400));

if (!ADDON) {
    console.error('need --addon <path to rsvelte .node>');
    process.exit(1);
}

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
    walk(root, 0);
    return out;
}

const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    return {
        total: +xs.reduce((a, b) => a + b, 0).toFixed(1),
        min: +s[0].toFixed(3),
        p50: +at(0.5).toFixed(3),
        p95: +at(0.95).toFixed(3),
        max: +s[s.length - 1].toFixed(3)
    };
};

const now = () => Number(process.hrtime.bigint()) / 1e6;

// ---------------------------------------------------------------- load both transforms

const addonModule = { exports: {} };
process.dlopen(addonModule, path.resolve(ADDON));
const addon = addonModule.exports;
if (typeof addon.svelte2tsx !== 'function') {
    console.error('addon has no svelte2tsx export; got:', Object.keys(addon).join(', '));
    process.exit(1);
}
const rsvelte2tsx = addon.svelte2tsx;

// svelte2tsx has to come from a checkout that has been installed and built. A worktree has
// neither, and building one there would just duplicate the main checkout's — so fall back to it.
const MAIN_REPO = REPO.includes('/.claude/worktrees/')
    ? REPO.slice(0, REPO.indexOf('/.claude/worktrees/'))
    : REPO;
const { svelte2tsx } = require(path.join(MAIN_REPO, 'packages/svelte2tsx'));
const svelteCompiler = require(path.join(PROJECT, 'node_modules/svelte/compiler'));

const files = findSvelteFiles(path.join(PROJECT, 'src'), MAX_FILES);
if (!files.length) {
    console.error(`no .svelte files under ${PROJECT}/src`);
    process.exit(1);
}
console.log(`corpus: ${files.length} components under ${path.relative(REPO, PROJECT)}\n`);

const sources = files.map((f) => ({ file: f, text: fs.readFileSync(f, 'utf-8') }));
const isTs = (text) => /<script[^>]*\blang\s*=\s*["']?(ts|typescript)/i.test(text);

// ---------------------------------------------------------------- capability checks first

console.log('=== capabilities (these gate adoption regardless of speed) ===');
const probe = sources.find((s) => isTs(s.text)) ?? sources[0];
let sample;
try {
    sample = rsvelte2tsx(probe.text, {
        filename: probe.file,
        isTsFile: isTs(probe.text),
        mode: 'ts',
        version: svelteCompiler.VERSION,
        typingsNamespace: 'svelteHTML',
        emitOnTemplateError: true,
        emitJsDoc: true
    });
} catch (e) {
    console.log(`  transform threw on a real component: ${e.message}`);
}
if (sample) {
    console.log(`  returns code ......... ${sample.code ? `yes (${sample.code.length} chars)` : 'NO'}`);
    console.log(`  returns map .......... ${sample.map ? 'yes' : 'NO  <- mapper cannot be built'}`);
    console.log(
        `  exportedNames ........ ${sample.exportedNames ? JSON.stringify(sample.exportedNames).slice(0, 60) : 'NO'}`
    );
    const js = svelte2tsx(probe.text, {
        parse: svelteCompiler.parse,
        version: svelteCompiler.VERSION,
        filename: probe.file,
        isTsFile: isTs(probe.text),
        mode: 'ts',
        typingsNamespace: 'svelteHTML',
        emitOnTemplateError: true,
        emitJsDoc: true
    });
    console.log(`  official code length . ${js.code.length}`);
    console.log(
        `  byte-identical ....... ${js.code === sample.code ? 'yes' : 'no (expected; parity is not the gate)'}`
    );
    // The language server hands svelte2tsx a `typingsNamespace`; if the options parser drops it,
    // the generated code references a namespace the shims do not declare.
    console.log(
        `  honours typingsNamespace ... ${sample.code.includes('svelteHTML') ? 'yes' : 'NO  <- option ignored'}`
    );
}

// A template that does not parse is the state the file is in on most keystrokes. Official
// svelte2tsx keeps going when emitOnTemplateError is set; if the native one aborts the process
// rather than throwing, it cannot run in-process at all.
console.log('\n  mid-edit template (`<div>` unclosed):');
try {
    const partial = rsvelte2tsx('<div>', { filename: 'x.svelte', mode: 'ts', emitOnTemplateError: true });
    console.log(`    survived, code ${partial.code ? `${partial.code.length} chars` : 'empty'}`);
} catch (e) {
    console.log(`    threw (recoverable): ${String(e.message).slice(0, 80)}`);
}

// ---------------------------------------------------------------- speed

console.log('\n=== transform speed (3 warmup passes over the corpus, then 3 measured) ===');

function run(fn, label) {
    for (let w = 0; w < 3; w++) for (const s of sources) try { fn(s); } catch {}
    let best = null;
    const per = [];
    for (let round = 0; round < 3; round++) {
        const times = [];
        let failed = 0;
        const t0 = now();
        for (const s of sources) {
            const a = now();
            try {
                fn(s);
            } catch {
                failed++;
            }
            times.push(now() - a);
        }
        const wall = now() - t0;
        if (best === null || wall < best.wall) best = { wall, times, failed };
    }
    per.push(...best.times);
    const st = stats(per);
    console.log(
        `  ${label.padEnd(10)} wall ${best.wall.toFixed(0).padStart(6)}ms   ` +
            `per-file min ${st.min} p50 ${st.p50} p95 ${st.p95} max ${st.max}` +
            (best.failed ? `   (${best.failed} failed)` : '')
    );
    return { wall: best.wall, failed: best.failed };
}

const jsRun = run(
    (s) =>
        svelte2tsx(s.text, {
            parse: svelteCompiler.parse,
            version: svelteCompiler.VERSION,
            filename: s.file,
            isTsFile: isTs(s.text),
            mode: 'ts',
            typingsNamespace: 'svelteHTML',
            emitOnTemplateError: true,
            emitJsDoc: true
        }),
    'official'
);
const rsRun = run(
    (s) =>
        rsvelte2tsx(s.text, {
            filename: s.file,
            isTsFile: isTs(s.text),
            mode: 'ts',
            version: svelteCompiler.VERSION,
            typingsNamespace: 'svelteHTML',
            emitOnTemplateError: true,
            emitJsDoc: true
        }),
    'rsvelte'
);

const ratio = jsRun.wall / rsRun.wall;
console.log(`\n  ratio: ${ratio.toFixed(2)}x`);

// ---------------------------------------------------------------- what that buys

const savedPerCorpus = jsRun.wall - rsRun.wall;
const perFileJs = jsRun.wall / sources.length;
const perFileRs = rsRun.wall / sources.length;

console.log('\n=== what that is worth against the measured budgets ===');
console.log(`  cold project load   ~4000ms, of which transform ~${jsRun.wall.toFixed(0)}ms`);
console.log(
    `    -> saves ${savedPerCorpus.toFixed(0)}ms (${((savedPerCorpus / 4000) * 100).toFixed(1)}% of cold start)`
);
console.log(`  keystroke           ~420ms, of which transform ~${perFileJs.toFixed(1)}ms`);
console.log(
    `    -> saves ${(perFileJs - perFileRs).toFixed(1)}ms (${(((perFileJs - perFileRs) / 420) * 100).toFixed(1)}% of a round trip)`
);

console.log(
    '\nNote: the language server cannot use this without a source map. If "returns map" is NO,' +
        '\nthe ratio above is the ceiling on a patched fork, not something available today.'
);
