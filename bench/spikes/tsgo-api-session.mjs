// Phase 2 spike, part 2 — THE decisive test.
// Can an API session attached to a live tsgo --lsp session walk the ComponentInfoProvider
// chain on a GENERIC $$IsomorphicComponent (the `ComponentProps<T>` / generic $props() case
// that upstream reaches via `(prop as any)?.links?.mappedType?.declaration`, which has no
// documented tsgo analogue)?
//
// Chain replicated from ComponentInfoProvider.create():
//   getSymbolAtPosition -> getTypeOfSymbolAtLocation -> getConstructSignatures()[0]
//   -> getReturnType() -> getProperty('$$prop_def') -> getTypeOfSymbolAtLocation
//   -> getProperties() -> typeToString each
import { LspClient, sleep } from '../lsp-client.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const WS = path.join(HERE, '.fixtures/api-session');
const LS = path.join(REPO, 'packages/language-server');
const TSGO = process.env.SPIKE_TSGO ?? path.join(LS, 'node_modules/@typescript/native-preview/bin/tsgo');
const uri = (p) => pathToFileURL(p).href;

// A self-contained mirror of real svelte2tsx Svelte-5 output: generic render fn,
// $$prop_def carrier, and the $$IsomorphicComponent construct+call signature pair.
const SHADOW = path.join(WS, '.cache/svelte/src/lib/Generic.svelte.tsx');
const SHADOW_SRC = `
function $$render<T>() {
    type $$ComponentProps = { items: T[]; selected: T; label?: string };
    let { items, selected, label }: $$ComponentProps = null as any as $$ComponentProps;
    void items; void selected; void label;
    return { props: {} as any as $$ComponentProps, exports: {}, slots: {}, events: {} };
}
class __sveltets_Render<T> {
    props(): ReturnType<typeof $$render<T>>['props'] { return null as any; }
    events(): ReturnType<typeof $$render<T>>['events'] { return null as any; }
    slots(): ReturnType<typeof $$render<T>>['slots'] { return null as any; }
}
declare class SvelteComponent<Props, Events, Slots> {
    /** Props doc marker */
    /** the props this component accepts */
    $$prop_def: Props;
    $$events_def: Events;
    $$slot_def: Slots;
}
interface $$IsomorphicComponent {
    new <T>(options: { props: ReturnType<__sveltets_Render<T>['props']> }):
        SvelteComponent<ReturnType<__sveltets_Render<T>['props']>, ReturnType<__sveltets_Render<T>['events']>, ReturnType<__sveltets_Render<T>['slots']>>;
    <T>(internal: unknown, props: ReturnType<__sveltets_Render<T>['props']> & {}): {};
}
declare const Generic: $$IsomorphicComponent;
export default Generic;
`.trimStart();

const CONSUMER_SRC = `import Generic from './lib/Generic.svelte';\nconst x = Generic;\nexport { x };\n`;

fs.mkdirSync(path.join(WS, '.cache/svelte/src/lib'), { recursive: true });
fs.mkdirSync(path.join(WS, 'src/lib'), { recursive: true });
fs.writeFileSync(
    path.join(WS, 'tsconfig.json'),
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
            include: ['src/**/*', '.cache/svelte/**/*']
        },
        null,
        2
    )
);
fs.writeFileSync(
    path.join(WS, 'src/lib/Generic.svelte'),
    '<script lang="ts" generics="T"></script>\n'
);
fs.writeFileSync(path.join(WS, 'src/consumer.ts'), CONSUMER_SRC);

const out = [];
const say = (ok, label, detail) => {
    out.push({ ok, label });
    console.log(
        `${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${label}\n      ${detail}\n`
    );
};

const client = new LspClient(TSGO, ['--lsp', '-stdio'], { cwd: WS });
client.onRequest('workspace/configuration', (p) =>
    (p.items || []).map(() => ({ preferences: {}, suggest: {}, inlayHints: {} }))
);
client.onRequest('client/registerCapability', () => null);
client.onRequest('window/workDoneProgress/create', () => null);

let api;
try {
    await client.request('initialize', {
        processId: process.pid,
        rootUri: uri(WS),
        workspaceFolders: [{ uri: uri(WS), name: 'ws2' }],
        capabilities: {
            general: { positionEncodings: ['utf-8'] },
            workspace: { configuration: true },
            textDocument: { synchronization: {}, diagnostic: {}, hover: {} }
        }
    });
    client.notify('initialized', {});

    client.notify('textDocument/didOpen', {
        textDocument: {
            uri: uri(SHADOW),
            languageId: 'typescriptreact',
            version: 1,
            text: SHADOW_SRC
        }
    });
    client.notify('textDocument/didOpen', {
        textDocument: {
            uri: uri(path.join(WS, 'src/consumer.ts')),
            languageId: 'typescript',
            version: 1,
            text: CONSUMER_SRC
        }
    });
    await sleep(900);

    const session = await client.request('custom/initializeAPISession', {});
    say(!!session?.pipe, 'API session opened on the live LSP session', JSON.stringify(session));

    // Imported by dist path rather than the `unstable/async` subpath: the language server
    // is CJS and this file is ESM, so the exports map isn't reachable from here.
    const { API, SignatureKind } = await import(
        pathToFileURL(
            path.join(LS, 'node_modules/@typescript/native-preview/dist/api/async/api.js')
        ).href
    );
    api = await API.fromLSPConnection({ pipe: session.pipe });
    say(true, 'API.fromLSPConnection attached', 'connected');

    const snapshot = await api.updateSnapshot();
    const projects = snapshot.getProjects();
    say(
        projects.length > 0,
        'snapshot exposes the LSP session projects',
        projects.map((p) => p.configFileName).join(', ') || '(none)'
    );

    const project = projects[0];
    const checker = project.checker;
    const consumerPath = path.join(WS, 'src/consumer.ts');

    // `Generic` in `const x = Generic;` -> line 2, after "const x = "
    const offset = CONSUMER_SRC.indexOf('const x = ') + 'const x = '.length;
    const sym = await checker.getSymbolAtPosition(consumerPath, offset);
    say(
        !!sym,
        'checker.getSymbolAtPosition on the consumer',
        sym ? `${sym.name} flags=${sym.flags}` : 'undefined'
    );

    const type = await checker.getTypeAtPosition(consumerPath, offset);
    say(!!type, 'checker.getTypeAtPosition', type ? await checker.typeToString(type) : 'undefined');

    const ctorSigs = await checker.getSignaturesOfType(type, SignatureKind.Construct);
    say(
        ctorSigs.length === 1,
        'getConstructSignatures() -> exactly 1 (the ComponentInfoProvider branch)',
        `count=${ctorSigs.length}`
    );

    const ret = await checker.getReturnTypeOfSignature(ctorSigs[0]);
    say(!!ret, 'getReturnTypeOfSignature', ret ? await checker.typeToString(ret) : 'undefined');

    const props = await checker.getPropertiesOfType(ret);
    const propDef = props.find((p) => p.name === '$$prop_def');
    say(
        !!propDef,
        'getPropertiesOfType(ret) contains $$prop_def',
        props.map((p) => p.name).join(', ')
    );

    const propDefType = await checker.getTypeOfSymbol(propDef);
    const actualProps = await checker.getPropertiesOfType(propDefType);
    const rendered = [];
    for (const p of actualProps) {
        const t = await checker.getTypeOfSymbol(p);
        rendered.push(`${p.name}: ${t ? await checker.typeToString(t) : '?'}`);
    }
    const names = actualProps
        .map((p) => p.name)
        .sort()
        .join(',');
    say(
        names === 'items,label,selected',
        'GENERIC component props resolved through the API session',
        rendered.join('  |  ') || '(none)'
    );

    // Docs, used by ComponentInfoProvider for prop hovers. Note the tsgo spelling
    // differs from TS and returns a plain string (no displayPartsToString needed).
    const docs = await checker.getDocumentationCommentOfSymbol(propDef);
    say(
        typeof docs === 'string',
        'checker.getDocumentationCommentOfSymbol -> string',
        JSON.stringify(docs).slice(0, 160)
    );
    const tags = await checker.getJsDocTagsOfSymbol(propDef);
    say(Array.isArray(tags), 'checker.getJsDocTagsOfSymbol', JSON.stringify(tags).slice(0, 160));

    // getPropertyOfType replaces TS's type.getProperty(name).
    const direct = await checker.getPropertyOfType(ret, '$$prop_def');
    say(
        !!direct,
        "checker.getPropertyOfType(ret, '$$prop_def')",
        direct ? direct.name : 'undefined'
    );

    // getAliasedSymbol closes the in-repo TODO at typescript-go DiagnosticsProvider.ts:1135.
    const aliased = await checker.getAliasedSymbol(sym);
    say(
        !!aliased,
        'checker.getAliasedSymbol (closes the in-repo TODO)',
        aliased ? `${aliased.name} flags=${aliased.flags}` : 'undefined'
    );
} catch (err) {
    console.error('SPIKE2 ERROR:', err.stack || err.message);
    console.error('stderr:', client.stderr.slice(0, 2000));
    process.exitCode = 1;
} finally {
    console.log('\n===== SUMMARY =====');
    for (const r of out)
        console.log(`${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'INFO'}  ${r.label}`);
    try {
        await api?.close();
    } catch {}
    client.dispose();
}
