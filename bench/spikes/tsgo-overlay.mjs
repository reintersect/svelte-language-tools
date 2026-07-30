// Spike: validate the diskless-overlay document model against a real tsgo --lsp.
//
// Questions (mirroring baseballyama's rsvelte#1764 spike, re-run on our engine):
//   Q1 a virtual .tsx that never touches disk is parsed and type-checked
//   Q2 `import './Foo.svelte'` resolves to the shadow via rootDirs + allowArbitraryExtensions,
//      with NO .d.ts re-export shim
//   Q3 the silent-`any` degradation mode: a failed shadow resolve swallowed by svelte's
//      ambient `declare module '*.svelte'`
//   Q4 refactor code actions are unavailable on TS7 (a scope cut, not a bug)
//
// Run: node bench/spikes/tsgo-overlay.mjs
import { LspClient, sleep } from '../lsp-client.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const LS = path.join(REPO, 'packages/language-server');
const TSGO = path.join(LS, 'node_modules/@typescript/native-preview/bin/tsgo');
const uri = (p) => pathToFileURL(p).href;

const results = [];
const say = (ok, label, detail) => {
    results.push({ ok, label });
    console.log(
        `${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${label}\n      ${detail}\n`
    );
};

const CONSUMER_SRC = `import Foo from './lib/Foo.svelte';\nconst x = Foo;\nexport { x };\n`;
const SHADOW_REL = '.cache/svelte/src/lib/Foo.svelte.tsx';
const SHADOW_SRC = `export default function Foo(__props: { name: string }) {\n    return __props.name;\n}\n`;

/** @param {{ambient: boolean}} opts whether to include svelte's `declare module '*.svelte'` */
function buildWorkspace({ ambient }) {
    const ws = path.join(HERE, `.fixtures/overlay-${ambient ? 'ambient' : 'plain'}`);
    fs.rmSync(ws, { recursive: true, force: true });
    // The shadow's parent directory must exist on disk even though the shadow never does.
    fs.mkdirSync(path.join(ws, '.cache/svelte/src/lib'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'src/lib'), { recursive: true });

    fs.writeFileSync(
        path.join(ws, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'ESNext',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                    strict: true,
                    noEmit: true,
                    jsx: 'preserve',
                    skipLibCheck: true,
                    allowArbitraryExtensions: true,
                    allowImportingTsExtensions: true,
                    rootDirs: ['.', './.cache/svelte']
                },
                include: ['src/**/*', '.cache/svelte/**/*', 'ambient.d.ts']
            },
            null,
            2
        )
    );
    fs.writeFileSync(path.join(ws, 'src/lib/Foo.svelte'), '<script lang="ts"></script>\n');
    fs.writeFileSync(path.join(ws, 'src/consumer.ts'), CONSUMER_SRC);
    if (ambient) {
        fs.writeFileSync(
            path.join(ws, 'ambient.d.ts'),
            "declare module '*.svelte' {\n    const c: any;\n    export default c;\n}\n"
        );
    }
    return ws;
}

async function connect(ws) {
    const client = new LspClient(TSGO, ['--lsp', '-stdio'], { cwd: ws });
    client.onRequest('workspace/configuration', (p) =>
        (p.items || []).map(() => ({
            // Must never be empty: answering `{}` wipes tsgo's preferences.
            preferences: { importModuleSpecifierEnding: 'index' },
            suggest: { autoImports: true },
            inlayHints: {}
        }))
    );
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);

    const init = await client.request('initialize', {
        processId: process.pid,
        rootUri: uri(ws),
        workspaceFolders: [{ uri: uri(ws), name: path.basename(ws) }],
        capabilities: {
            general: { positionEncodings: ['utf-8', 'utf-16'] },
            workspace: { configuration: true },
            textDocument: { synchronization: {}, diagnostic: {}, hover: {}, completion: {} }
        }
    });
    client.notify('initialized', {});
    return { client, init };
}

const diagnosticsFor = async (client, fileUri) => {
    const r = await client.request('textDocument/diagnostic', { textDocument: { uri: fileUri } });
    const items = r?.items ?? [];
    return Array.isArray(items) ? items : [];
};

const clients = [];
try {
    // ---------- workspace A: no ambient declaration ----------
    const ws = buildWorkspace({ ambient: false });
    const { client, init } = await connect(ws);
    clients.push(client);

    say(
        init.capabilities?.positionEncoding === 'utf-8',
        'Q0 positionEncoding negotiates utf-8',
        JSON.stringify(init.capabilities?.positionEncoding)
    );
    const kinds = init.capabilities?.codeActionProvider?.codeActionKinds ?? [];
    say(
        !kinds.some((k) => k.startsWith('refactor')),
        'Q4 no `refactor` kinds on TS7 (confirms the scope cut)',
        JSON.stringify(kinds)
    );

    const consumerUri = uri(path.join(ws, 'src/consumer.ts'));
    client.notify('textDocument/didOpen', {
        textDocument: { uri: consumerUri, languageId: 'typescript', version: 1, text: CONSUMER_SRC }
    });
    await sleep(600);

    const before = await diagnosticsFor(client, consumerUri);
    say(
        before.some((d) => d.code === 2307),
        'Q3a without the ambient decl, an unopened shadow errors LOUDLY (TS2307)',
        before.map((d) => `TS${d.code}`).join(',') || 'none'
    );

    const shadowAbs = path.join(ws, SHADOW_REL);
    say(
        !fs.existsSync(shadowAbs),
        'Q1a shadow does not exist on disk',
        shadowAbs.replace(REPO, '<repo>')
    );
    client.notify('textDocument/didOpen', {
        textDocument: {
            uri: uri(shadowAbs),
            languageId: 'typescriptreact',
            version: 1,
            text: SHADOW_SRC
        }
    });
    await sleep(800);

    const shadowDiags = await diagnosticsFor(client, uri(shadowAbs));
    say(
        shadowDiags.length === 0,
        'Q1b diskless .tsx type-checks clean',
        shadowDiags.map((d) => `TS${d.code}: ${d.message}`).join(' | ') || 'clean'
    );

    const shadowHover = await client.request('textDocument/hover', {
        textDocument: { uri: uri(shadowAbs) },
        position: { line: 1, character: 22 } // `name` in `__props.name`
    });
    const shadowHoverText = JSON.stringify(shadowHover?.contents ?? null);
    say(
        shadowHoverText.includes('string'),
        'Q1c hover works inside the diskless .tsx',
        shadowHoverText.slice(0, 160)
    );

    const hoverAfter = await client.request('textDocument/hover', {
        textDocument: { uri: consumerUri },
        position: { line: 1, character: 11 } // `Foo` in `const x = Foo;`
    });
    const hoverAfterText = JSON.stringify(hoverAfter?.contents ?? null);
    say(
        hoverAfterText.includes('__props'),
        'Q2a .svelte import resolves to the shadow via rootDirs (no .d.ts shim)',
        hoverAfterText.slice(0, 200)
    );

    const defs = await client.request('textDocument/definition', {
        textDocument: { uri: consumerUri },
        position: { line: 1, character: 11 }
    });
    say(
        JSON.stringify(defs ?? '').includes('.cache/svelte'),
        'Q2b go-to-definition lands on the diskless shadow',
        JSON.stringify(defs ?? null).slice(0, 200)
    );

    // ---------- workspace B: WITH the ambient declaration ----------
    // The dangerous mode. The shadow is never opened, so the import falls through to
    // `declare module '*.svelte'` and silently becomes `any` with no diagnostic at all.
    const wsAmb = buildWorkspace({ ambient: true });
    const { client: ambClient } = await connect(wsAmb);
    clients.push(ambClient);
    const ambConsumerUri = uri(path.join(wsAmb, 'src/consumer.ts'));
    ambClient.notify('textDocument/didOpen', {
        textDocument: {
            uri: ambConsumerUri,
            languageId: 'typescript',
            version: 1,
            text: CONSUMER_SRC
        }
    });
    await sleep(700);
    const ambDiags = await diagnosticsFor(ambClient, ambConsumerUri);
    const ambHover = await ambClient.request('textDocument/hover', {
        textDocument: { uri: ambConsumerUri },
        position: { line: 1, character: 11 }
    });
    const ambHoverText = JSON.stringify(ambHover?.contents ?? null);
    const degraded = ambDiags.length === 0 && ambHoverText.includes('any');
    say(
        degraded,
        'Q3b WITH the ambient decl, an unopened shadow degrades SILENTLY to `any`',
        `diags=${ambDiags.map((d) => 'TS' + d.code).join(',') || 'none'} hover=${ambHoverText.slice(0, 120)}` +
            (degraded ? '   <-- this is why eager shadow opening is mandatory' : '')
    );
} catch (err) {
    console.error('SPIKE ERROR:', err.stack || err.message);
    for (const c of clients) console.error('stderr:', c.stderr.slice(0, 1500));
    process.exitCode = 1;
} finally {
    console.log('\n===== SUMMARY =====');
    for (const r of results)
        console.log(`${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'INFO'}  ${r.label}`);
    if (results.some((r) => r.ok === false)) process.exitCode = 1;
    for (const c of clients) c.dispose();
}
