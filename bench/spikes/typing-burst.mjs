/**
 * What a burst of typing actually costs.
 *
 * The latency harness sends one edit and waits, which flatters a short debounce: there is never a
 * second keystroke to collide with the first. Real typing is a burst, and the two settings
 * interact — with an *uncancellable* ~300ms check (measured: tsgo discards its checker on any
 * program change, and `$/cancelRequest` is a no-op), a short debounce lets every keystroke start a
 * full check that is obsolete before it finishes. The debounce is not just latency, it is also the
 * only thing currently coalescing that work.
 *
 * So this measures the number that matters: from the LAST keystroke of a burst, how long until the
 * diagnostics describing that final text arrive.
 *
 * Usage:
 *   node bench/spikes/typing-burst.mjs --project <dir> --file <rel.svelte> [--burst 6] [--gap 60]
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { LspClient } from '../lsp-client.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = args.indexOf(name);
    return i === -1 ? dflt : args[i + 1];
};
const PROJECT = path.resolve(argOf('--project', process.env.SVELTE_LS_BENCH_PROJECT ?? '.'));
const FILE = argOf('--file', null);
const BURST = Number(argOf('--burst', 6));
const GAP = Number(argOf('--gap', 60)); // ms between keystrokes; 60ms ~= 200 wpm
const ROUNDS = Number(argOf('--rounds', 6));

const uri = (p) => pathToFileURL(p).href;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFile(root) {
    const skip = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build']);
    const walk = (dir, depth) => {
        if (depth > 8) return null;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (skip.has(e.name)) continue;
                const found = walk(full, depth + 1);
                if (found) return found;
            } else if (e.name.endsWith('.svelte') && fs.statSync(full).size > 4000) {
                return full;
            }
        }
        return null;
    };
    return walk(path.join(root, 'src'), 0);
}

const file = FILE ? path.resolve(PROJECT, FILE) : findFile(PROJECT);
const original = fs.readFileSync(file, 'utf-8');

/** Put a statement at the end of the instance script, where it is guaranteed to be checked. */
function injectIntoScript(source, text) {
    const close = source.lastIndexOf('</script>');
    if (close === -1) throw new Error('no </script> in ' + file);
    return source.slice(0, close) + '\n' + text + '\n' + source.slice(close);
}

const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
    cwd: PROJECT,
    env: { ...process.env }
});

// publishDiagnostics carries no version, so the only reliable way to know which edit a report
// describes is to make each edit introduce a uniquely named undefined identifier and wait for the
// diagnostic that names it.
const pending = new Map();
client.onNotification('textDocument/publishDiagnostics', (params) => {
    for (const [marker, resolve] of [...pending]) {
        if (params.diagnostics?.some((d) => (d.message ?? '').includes(marker))) {
            pending.delete(marker);
            resolve();
        }
    }
});

const waitFor = (marker, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`timed out waiting for ${marker}`)),
            timeoutMs
        );
        pending.set(marker, () => {
            clearTimeout(timer);
            resolve();
        });
    });

await client.request('initialize', {
    processId: process.pid,
    rootUri: uri(PROJECT),
    workspaceFolders: [{ uri: uri(PROJECT), name: 'p' }],
    capabilities: { textDocument: { publishDiagnostics: {} } },
    initializationOptions: { configuration: { typescript: {}, svelte: {}, javascript: {} } }
});
client.notify('initialized', {});
client.notify('textDocument/didOpen', {
    textDocument: { uri: uri(file), languageId: 'svelte', version: 1, text: original }
});

console.log(`project  ${PROJECT}`);
console.log(`file     ${path.relative(PROJECT, file)}`);
console.log(`burst    ${BURST} keystrokes ${GAP}ms apart, ${ROUNDS} rounds`);
console.log(`debounce ${process.env.SVELTE_LS_DIAGNOSTICS_DEBOUNCE_MS ?? '120 (default)'}\n`);

// Warm up: first diagnostics build the whole program.
const warm = `__burst_warmup__`;
client.notify('textDocument/didChange', {
    textDocument: { uri: uri(file), version: 2 },
    contentChanges: [{ text: injectIntoScript(original, `${warm};`) }]
});
await waitFor(warm, 240000);

let version = 2;
const results = [];
for (let round = 0; round < ROUNDS; round++) {
    const marker = `__burst_final_${round}__`;
    // Type BURST-1 throwaway characters, then the one whose diagnostic we wait for.
    for (let k = 0; k < BURST - 1; k++) {
        version++;
        client.notify('textDocument/didChange', {
            textDocument: { uri: uri(file), version },
            contentChanges: [{ text: injectIntoScript(original, `__burst_${round}_${k}__;`) }]
        });
        await sleep(GAP);
    }
    version++;
    const t = now();
    client.notify('textDocument/didChange', {
        textDocument: { uri: uri(file), version },
        contentChanges: [{ text: injectIntoScript(original, `${marker};`) }]
    });
    await waitFor(marker);
    results.push(now() - t);
    // Settle before the next round so rounds do not bleed into each other.
    await sleep(1500);
}

const sorted = [...results].sort((a, b) => a - b);
const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
console.log(`last keystroke -> its diagnostics`);
console.log(`  samples  ${results.map((x) => x.toFixed(0)).join(', ')}ms`);
console.log(`  min ${sorted[0].toFixed(0)}ms   p50 ${at(0.5).toFixed(0)}ms   max ${sorted[sorted.length - 1].toFixed(0)}ms`);

client.dispose();
process.exit(0);
