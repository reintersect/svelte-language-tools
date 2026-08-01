// Strict live LSP differential oracle for the classic TypeScript service and tsgo adapter.
//
// This intentionally uses real language-server child processes and a fixture containing both
// BMP and astral characters before every queried token. A test passes only when both engines
// return a meaningful result and agree on the source-level operation after normalization.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LspClient, sleep } from './lsp-client.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');
const PROJECT = path.resolve(
    process.env.SVELTE_LS_LSP_ORACLE_PROJECT ??
        path.join(REPO, 'packages/language-server/test/plugins/typescript-go/fixtures/lsp-oracle')
);
const APP = path.join(PROJECT, 'src/App.svelte');
const APP_URI = pathToFileURL(APP).href;
const TEXT = fs.readFileSync(APP, 'utf8');
const MATH = path.join(PROJECT, 'src/math.ts');
const MATH_URI = pathToFileURL(MATH).href;
const MATH_TEXT = fs.readFileSync(MATH, 'utf8');
const DIRTY_MATH_TEXT = `// unsaved Ж😀\n${MATH_TEXT}`;
const TIMEOUT = Number(process.env.SVELTE_LS_LSP_ORACLE_TIMEOUT_MS ?? 120_000);
const GENERATED_OVERLAY = path.join(PROJECT, 'node_modules/.cache/svelte-lsp');
const CLEAN_GENERATED_FIXTURE = !process.env.SVELTE_LS_LSP_ORACLE_PROJECT;
const EFFECT_MODE = process.argv.includes('--effect');
const NATIVE_PACKAGE = EFFECT_MODE ? '@reintersect/effect-tsgo' : '@typescript/native-preview';
const EFFECT_DIAGNOSTIC_ALLOWLIST = new Set([377021]);
const require = createRequire(import.meta.url);
const { resolveTsGoEngine } = require(
    path.join(REPO, 'packages/language-server/dist/src/plugins/typescript-go/lsp/TsGoEngine.js')
);

if (process.argv.includes('--help')) {
    console.log(`Usage: node bench/compare-lsp-features.mjs [--effect]

Without arguments the native row is pinned to @typescript/native-preview. --effect runs the
same oracle explicitly against @reintersect/effect-tsgo and allows only diagnostic code 377021
in addition to the stock/classic result.`);
    process.exit(0);
}
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--effect');
if (unknownArguments.length) {
    throw new Error(`unknown argument(s): ${unknownArguments.join(', ')}`);
}
const EXPECTED_ENGINE = resolveTsGoEngine(PROJECT, { packageName: NATIVE_PACKAGE });
if (!EXPECTED_ENGINE) {
    throw new Error(`could not resolve the explicitly selected engine ${NATIVE_PACKAGE}`);
}
if (!EFFECT_MODE) {
    const pinnedVersion = require(path.join(REPO, 'package.json')).devDependencies?.[
        NATIVE_PACKAGE
    ];
    assert.equal(
        EXPECTED_ENGINE.version,
        pinnedVersion,
        `resolved ${NATIVE_PACKAGE}@${EXPECTED_ENGINE.version}, expected the repository pin ${pinnedVersion}`
    );
} else if (process.env.EXPECTED_TSGO_VERSION) {
    assert.equal(
        EXPECTED_ENGINE.version,
        process.env.EXPECTED_TSGO_VERSION,
        `resolved ${NATIVE_PACKAGE}@${EXPECTED_ENGINE.version}, expected updater candidate ${process.env.EXPECTED_TSGO_VERSION}`
    );
}

if (CLEAN_GENERATED_FIXTURE) {
    fs.rmSync(GENERATED_OVERLAY, { recursive: true, force: true });
}

if (!fs.existsSync(SERVER)) {
    throw new Error(`language server is not built: ${SERVER}`);
}

const uri = (fileName) => pathToFileURL(fileName).href;

function positionIn(text, needle, within = 0) {
    const offset = text.indexOf(needle);
    assert.notEqual(offset, -1, `fixture marker not found: ${needle}`);
    const before = text.slice(0, offset + within);
    const lines = before.split('\n');
    // JavaScript string length is UTF-16 code units, which is exactly the LSP encoding the
    // wrapper and native child negotiate. This catches code-point/byte based shifts.
    return { line: lines.length - 1, character: lines.at(-1).length };
}

const positionOf = (needle, within = 0) => positionIn(TEXT, needle, within);

function fullRange(text) {
    const lines = text.split('\n');
    return {
        start: { line: 0, character: 0 },
        end: { line: lines.length - 1, character: lines.at(-1).length }
    };
}

function normalizeUri(value) {
    if (!value) return value;
    return value.replace(/\\/g, '/').replace(/^file:\/\/\/[A-Z]:/, (drive) => drive.toLowerCase());
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, stable(entry)])
    );
}

function diagnosticSignature(items) {
    return items
        .map((diagnostic) => ({
            range: diagnostic.range,
            severity: diagnostic.severity ?? null,
            code: diagnostic.code ?? null,
            source: diagnostic.source ?? null,
            message: diagnostic.message,
            relatedInformation: (diagnostic.relatedInformation ?? []).map((related) => ({
                message: related.message,
                location: {
                    uri: normalizeUri(related.location.uri),
                    range: related.location.range
                }
            }))
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compareDiagnostics(classicItems, nativeItems) {
    const classic = diagnosticSignature(classicItems);
    const native = diagnosticSignature(nativeItems);
    if (!EFFECT_MODE) {
        compare('pull diagnostics (full fields, multiplicity and UTF-16 ranges)', classic, native);
        return;
    }

    const allowed = native.filter((diagnostic) =>
        EFFECT_DIAGNOSTIC_ALLOWLIST.has(Number(diagnostic.code))
    );
    const stockCompatible = native.filter(
        (diagnostic) => !EFFECT_DIAGNOSTIC_ALLOWLIST.has(Number(diagnostic.code))
    );
    compare('pull diagnostics (Effect intentional diagnostics removed)', classic, stockCompatible);
    assert.ok(
        allowed.every((diagnostic) => Number(diagnostic.code) === 377021),
        'Effect diagnostic allowlist admitted a code other than 377021'
    );
    console.log(`  PASS Effect diagnostic allowlist (${allowed.length} code 377021 item(s))`);
}

function completionItems(result) {
    if (Array.isArray(result)) return result;
    assert.ok(result && Array.isArray(result.items), 'completion response was malformed');
    return result.items;
}

function hoverText(result) {
    const contents = result?.contents;
    const values = Array.isArray(contents) ? contents : [contents];
    return values
        .filter(Boolean)
        .map((part) => (typeof part === 'string' ? part : (part.value ?? part.language ?? '')))
        .join('\n')
        .replace(/```(?:typescript|ts)?/g, '')
        .replace(/```/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeLocations(result) {
    const locations = result ? (Array.isArray(result) ? result : [result]) : [];
    return locations
        .map((location) =>
            location.targetUri
                ? {
                      kind: 'link',
                      targetUri: normalizeUri(location.targetUri),
                      targetRange: location.targetRange,
                      targetSelectionRange: location.targetSelectionRange,
                      originSelectionRange: location.originSelectionRange ?? null
                  }
                : {
                      kind: 'location',
                      uri: normalizeUri(location.uri),
                      range: location.range
                  }
        )
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const normalizedLocationUri = (location) => location.uri ?? location.targetUri;
const normalizedLocationRange = (location) =>
    location.range ?? location.targetSelectionRange ?? location.targetRange;

function normalizeWorkspaceEdit(edit) {
    const edits = [];
    const resources = [];
    for (const [editUri, textEdits] of Object.entries(edit?.changes ?? {})) {
        for (const textEdit of textEdits) {
            edits.push({
                uri: normalizeUri(editUri),
                version: null,
                range: textEdit.range,
                newText: textEdit.newText,
                annotationId: textEdit.annotationId ?? null
            });
        }
    }
    for (const change of edit?.documentChanges ?? []) {
        if (change.textDocument) {
            for (const textEdit of change.edits ?? []) {
                edits.push({
                    uri: normalizeUri(change.textDocument.uri),
                    version: change.textDocument.version ?? null,
                    range: textEdit.range,
                    newText: textEdit.newText,
                    annotationId: textEdit.annotationId ?? null
                });
            }
        } else {
            resources.push(
                stable({
                    kind: change.kind,
                    uri: normalizeUri(change.uri),
                    oldUri: normalizeUri(change.oldUri),
                    newUri: normalizeUri(change.newUri),
                    options: change.options,
                    annotationId: change.annotationId ?? null
                })
            );
        }
    }
    edits.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    resources.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
        edits,
        resources,
        changeAnnotations: stable(edit?.changeAnnotations ?? {})
    };
}

function labelText(label) {
    return typeof label === 'string'
        ? label
        : (label ?? []).map((part) => (typeof part === 'string' ? part : part.value)).join('');
}

function normalizeInlayLabel(label) {
    if (typeof label === 'string') return label;
    return (label ?? []).map((part) => ({
        value: part.value,
        tooltip: stable(part.tooltip ?? null),
        location: part.location
            ? {
                  uri: normalizeUri(part.location.uri),
                  range: part.location.range
              }
            : null,
        command: stable(part.command ?? null)
    }));
}

function normalizeInlayHints(result) {
    return (result ?? [])
        .map((hint) => ({
            position: hint.position,
            kind: hint.kind ?? null,
            labelText: labelText(hint.label),
            label: normalizeInlayLabel(hint.label),
            textEdits: stable(hint.textEdits ?? []),
            tooltip: stable(hint.tooltip ?? null),
            paddingLeft: hint.paddingLeft ?? false,
            paddingRight: hint.paddingRight ?? false
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const OUTER_WATCHER_SUPPLEMENT = new Set([
    '**/*.svelte',
    '**/{svelte,vite}.config.{js,cjs,mjs,ts,cts,mts}'
]);

function watcherPattern(watcher) {
    return typeof watcher.globPattern === 'string'
        ? watcher.globPattern
        : watcher.globPattern?.pattern;
}

function childDerivedWatchers(server) {
    return server.registrations
        .filter((registration) => registration.method === 'workspace/didChangeWatchedFiles')
        .flatMap((registration) => registration.registerOptions?.watchers ?? [])
        .filter((watcher) => !OUTER_WATCHER_SUPPLEMENT.has(watcherPattern(watcher)));
}

async function assertDynamicCapabilities(server, { tsFamilySync, childWatcherBridge = false }) {
    const deadline = Date.now() + TIMEOUT;
    const expectedSync = [
        'textDocument/didOpen',
        'textDocument/didChange',
        'textDocument/didClose'
    ];
    for (;;) {
        const methods = new Set(server.registrations.map((registration) => registration.method));
        const hasWatcher = methods.has('workspace/didChangeWatchedFiles');
        const hasSync = !tsFamilySync || expectedSync.every((method) => methods.has(method));
        const hasChildWatcher = !childWatcherBridge || childDerivedWatchers(server).length > 0;
        if (hasWatcher && hasSync && hasChildWatcher) break;
        assert.ok(
            Date.now() < deadline,
            `${server.name} omitted dynamic registrations: ${[...methods]}`
        );
        await sleep(25);
    }

    const watcherRegistrations = server.registrations.filter(
        (registration) => registration.method === 'workspace/didChangeWatchedFiles'
    );
    assert.ok(
        watcherRegistrations.some(
            (registration) => registration.registerOptions?.watchers?.length > 0
        ),
        `${server.name} registered an empty watched-file capability`
    );
    if (childWatcherBridge) {
        assert.ok(
            childDerivedWatchers(server).length > 0,
            `${server.name} exposed only the outer Svelte/config watcher supplement`
        );
    }

    if (tsFamilySync) {
        assert.equal(server.initialize.capabilities.experimental?.tsOrJsTextSync, true);
        for (const method of expectedSync) {
            const registration = server.registrations.find((entry) => entry.method === method);
            const languages = new Set(
                (registration?.registerOptions?.documentSelector ?? []).map(
                    (selector) => selector.language
                )
            );
            assert.deepEqual(
                [...languages].sort(),
                ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
                `${server.name} ${method} selector omitted a TS-family language`
            );
        }
    }
}

async function getTsGoStats(server) {
    const stats = await server.client.request('$/getTsGoStats', null, TIMEOUT);
    assert.ok(stats && typeof stats === 'object', `${server.name} returned no tsgo stats`);
    assert.deepEqual(
        stats.engine,
        {
            packageName: EXPECTED_ENGINE.packageName,
            version: EXPECTED_ENGINE.version
        },
        `${server.name} ran a different native engine than the oracle selected`
    );
    assert.ok(Number.isSafeInteger(stats.generation), `${server.name} omitted its generation`);
    return stats;
}

async function waitForGenerationAfter(server, previous, context) {
    const deadline = Date.now() + TIMEOUT;
    let stats;
    do {
        stats = await getTsGoStats(server);
        if (stats.generation > previous) return stats;
        await sleep(25);
    } while (Date.now() < deadline);
    throw new Error(
        `${server.name} did not observe ${context}; generation remained ${stats?.generation}`
    );
}

async function assertWatchedTypeScriptBridge(classic, native) {
    const marker = '\n// live watcher bridge probe Ж😀\n';
    const original = fs.readFileSync(MATH, 'utf8');
    assert.equal(original, MATH_TEXT, 'math fixture changed before the watcher probe');
    const before = await getTsGoStats(native);
    let changedOnDisk = false;
    try {
        fs.writeFileSync(MATH, original + marker, 'utf8');
        changedOnDisk = true;
        for (const server of [classic, native]) {
            server.client.notify('workspace/didChangeWatchedFiles', {
                changes: [{ uri: MATH_URI, type: 2 }]
            });
        }
        await waitForGenerationAfter(native, before.generation, 'the watched TypeScript change');
    } finally {
        if (changedOnDisk) {
            const beforeRestore = await getTsGoStats(native);
            fs.writeFileSync(MATH, original, 'utf8');
            for (const server of [classic, native]) {
                server.client.notify('workspace/didChangeWatchedFiles', {
                    changes: [{ uri: MATH_URI, type: 2 }]
                });
            }
            await waitForGenerationAfter(
                native,
                beforeRestore.generation,
                'the watched TypeScript restore'
            );
        }
    }
    assert.equal(fs.readFileSync(MATH, 'utf8'), original, 'watcher probe did not restore math.ts');
    console.log('  PASS child watcher bridge forwards real TypeScript changes');
}

function normalizeHierarchyItems(result) {
    return (result ?? [])
        .map((item) => ({
            name: item.name,
            kind: item.kind,
            uri: normalizeUri(item.uri),
            range: item.range,
            selectionRange: item.selectionRange
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizeCalls(result, direction) {
    return (result ?? [])
        .map((call) => ({
            item: normalizeHierarchyItems([direction === 'outgoing' ? call.to : call.from])[0],
            ranges: [...(call.fromRanges ?? [])].sort((a, b) =>
                JSON.stringify(a).localeCompare(JSON.stringify(b))
            )
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function decodeSemanticTokens(result) {
    assert.ok(result && Array.isArray(result.data), 'semantic token response was malformed');
    assert.equal(result.data.length % 5, 0, 'semantic token data was truncated');
    const decoded = [];
    let line = 0;
    let character = 0;
    for (let index = 0; index < result.data.length; index += 5) {
        const [deltaLine, deltaStart, length, tokenType, tokenModifiers] = result.data.slice(
            index,
            index + 5
        );
        line += deltaLine;
        character = deltaLine === 0 ? character + deltaStart : deltaStart;
        decoded.push({ line, character, length, tokenType, tokenModifiers });
    }
    return decoded;
}

async function startServer(name, useTsGo) {
    const registrations = [];
    const env = { ...process.env, SVELTE_LS_TSGO: useTsGo ? '1' : '' };
    // The live stock oracle must not inherit a caller's Effect override (or vice versa).
    delete env.SVELTE_LS_TSGO_PACKAGE;
    if (useTsGo) env.SVELTE_LS_TSGO_PACKAGE = NATIVE_PACKAGE;
    const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
        cwd: PROJECT,
        env
    });
    client.onRequest('workspace/configuration', (params) => (params.items ?? []).map(() => ({})));
    client.onRequest('client/registerCapability', (params) => {
        registrations.push(...(params.registrations ?? []));
        return null;
    });
    client.onRequest('client/unregisterCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);
    client.onRequest('workspace/diagnostic/refresh', () => null);
    client.onRequest('workspace/semanticTokens/refresh', () => null);
    client.onRequest('workspace/inlayHint/refresh', () => null);

    const initialize = await client.request(
        'initialize',
        {
            processId: process.pid,
            rootUri: uri(PROJECT),
            workspaceFolders: [{ uri: uri(PROJECT), name: path.basename(PROJECT) }],
            capabilities: {
                general: { positionEncodings: ['utf-16'] },
                workspace: {
                    configuration: true,
                    applyEdit: true,
                    diagnostics: { refreshSupport: true },
                    didChangeWatchedFiles: {
                        dynamicRegistration: true,
                        relativePatternSupport: true
                    },
                    workspaceEdit: {
                        documentChanges: true,
                        resourceOperations: ['create', 'rename', 'delete'],
                        changeAnnotationSupport: { groupsOnLabel: true }
                    },
                    semanticTokens: { refreshSupport: true },
                    inlayHint: { refreshSupport: true }
                },
                textDocument: {
                    synchronization: { dynamicRegistration: true, didSave: true },
                    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
                    publishDiagnostics: { relatedInformation: true },
                    completion: {
                        completionItem: {
                            snippetSupport: true,
                            insertReplaceSupport: true,
                            resolveSupport: {
                                properties: ['documentation', 'detail', 'additionalTextEdits']
                            }
                        }
                    },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    definition: { linkSupport: true },
                    references: {},
                    rename: { prepareSupport: true },
                    codeAction: {
                        dataSupport: true,
                        resolveSupport: { properties: ['edit'] },
                        codeActionLiteralSupport: {
                            codeActionKind: { valueSet: ['quickfix', 'source'] }
                        }
                    },
                    semanticTokens: {
                        requests: { range: true, full: true },
                        tokenTypes: [
                            'namespace',
                            'type',
                            'class',
                            'enum',
                            'interface',
                            'struct',
                            'typeParameter',
                            'parameter',
                            'variable',
                            'property',
                            'enumMember',
                            'event',
                            'function',
                            'method',
                            'macro',
                            'label',
                            'comment',
                            'string',
                            'keyword',
                            'number',
                            'regexp',
                            'operator',
                            'decorator'
                        ],
                        tokenModifiers: [
                            'declaration',
                            'definition',
                            'readonly',
                            'static',
                            'deprecated',
                            'abstract',
                            'async',
                            'modification',
                            'documentation',
                            'defaultLibrary'
                        ],
                        formats: ['relative']
                    },
                    inlayHint: {
                        resolveSupport: {
                            properties: [
                                'tooltip',
                                'textEdits',
                                'label.tooltip',
                                'label.location',
                                'label.command'
                            ]
                        }
                    },
                    callHierarchy: {}
                }
            },
            initializationOptions: {
                isTrusted: true,
                configuration: {
                    svelte: { plugin: {} },
                    typescript: {
                        inlayHints: {
                            parameterNames: {
                                enabled: 'all',
                                suppressWhenArgumentMatchesName: false
                            }
                        }
                    }
                }
            }
        },
        TIMEOUT
    );
    assert.equal(initialize?.capabilities?.positionEncoding ?? 'utf-16', 'utf-16');
    assert.ok(initialize?.capabilities?.diagnosticProvider, `${name} omitted pull diagnostics`);
    client.notify('initialized', {});

    if (useTsGo) {
        for (
            let attempt = 0;
            attempt < 100 && !client.stderr.includes('[tsgo] enabled');
            attempt++
        ) {
            if (client.exited) break;
            await sleep(25);
        }
        assert.match(client.stderr, /\[tsgo\] enabled/, `tsgo was not enabled:\n${client.stderr}`);
        await getTsGoStats({ name, client });
    }
    assert.equal(client.exited, null, `${name} exited during initialization`);
    client.notify('textDocument/didOpen', {
        textDocument: { uri: APP_URI, languageId: 'svelte', version: 1, text: TEXT }
    });
    client.notify('textDocument/didOpen', {
        textDocument: { uri: MATH_URI, languageId: 'typescript', version: 1, text: MATH_TEXT }
    });
    return { name, client, registrations, initialize };
}

async function stopServer(server) {
    if (server.client.exited) {
        throw server.client.exited.error ?? new Error(`${server.name} exited before shutdown`);
    }
    const exit = new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${server.name} did not exit after shutdown`)),
            10_000
        );
        server.client.onExit((result) => {
            clearTimeout(timer);
            resolve(result);
        });
    });
    await server.client.request('shutdown', null, 10_000);
    server.client.notify('exit');
    const result = await exit;
    assert.equal(result.error, undefined, `${server.name}: ${result.error?.message}`);
    assert.equal(result.sig, null, `${server.name} exited by signal ${result.sig}`);
    assert.equal(result.code, 0, `${server.name} exited with ${result.code}`);
}

async function requestBoth(classic, native, method, params) {
    const [left, right] = await Promise.all([
        classic.client.request(method, params, TIMEOUT),
        native.client.request(method, params, TIMEOUT)
    ]);
    return { classic: left, tsgo: right };
}

function compare(name, classic, tsgo) {
    assert.deepEqual(tsgo, classic, `${name} parity mismatch`);
    console.log(`  PASS ${name}`);
}

let classic;
let native;
let completed = 0;
try {
    [classic, native] = await Promise.all([
        startServer('classic', false),
        startServer('tsgo', true)
    ]);

    const diagnostics = await requestBoth(classic, native, 'textDocument/diagnostic', {
        textDocument: { uri: APP_URI }
    });
    for (const [engine, result] of Object.entries(diagnostics)) {
        assert.equal(result?.kind, 'full', `${engine} diagnostic report was incomplete`);
        assert.ok(Array.isArray(result.items), `${engine} diagnostic items were malformed`);
        assert.ok(
            result.items.length >= 2,
            `${engine} returned an empty/partial diagnostic corpus`
        );
    }
    await Promise.all([
        assertDynamicCapabilities(classic, { tsFamilySync: false }),
        assertDynamicCapabilities(native, { tsFamilySync: true, childWatcherBridge: true })
    ]);
    console.log('  PASS dynamic watcher and TS-family synchronization capabilities');
    compareDiagnostics(diagnostics.classic.items, diagnostics.tsgo.items);
    await assertWatchedTypeScriptBridge(classic, native);
    completed++;

    // Warm project creation precedes the edit so the classic service and tsgo both exercise
    // their real open -> update path instead of treating this as an initial disk snapshot.
    for (const server of [classic, native]) {
        server.client.notify('textDocument/didChange', {
            textDocument: { uri: MATH_URI, version: 2 },
            contentChanges: [{ text: DIRTY_MATH_TEXT }]
        });
    }

    const completionPosition = positionOf('formatter.format', 'formatter.'.length);
    const completions = await requestBoth(classic, native, 'textDocument/completion', {
        textDocument: { uri: APP_URI },
        position: completionPosition,
        context: { triggerKind: 1 }
    });
    const completionTargets = {};
    for (const [engine, result] of Object.entries(completions)) {
        const items = completionItems(result);
        assert.ok(items.length, `${engine} returned no completions`);
        const target = items.find((item) => item.label === 'format');
        assert.ok(target, `${engine} omitted the format completion`);
        completionTargets[engine] = stable({
            label: target.label,
            kind: target.kind,
            textEdit: target.textEdit,
            insertText: target.insertText
        });
    }
    compare('completion', completionTargets.classic, completionTargets.tsgo);
    completed++;

    const definitionPosition = positionOf('add(1, 2)', 1);
    const hovers = await requestBoth(classic, native, 'textDocument/hover', {
        textDocument: { uri: APP_URI },
        position: definitionPosition
    });
    for (const [engine, result] of Object.entries(hovers)) {
        assert.ok(result?.range, `${engine} returned a hover without a range`);
        assert.match(hoverText(result), /add.*number/i, `${engine} hover was not meaningful`);
    }
    compare('hover range', stable(hovers.classic.range), stable(hovers.tsgo.range));
    completed++;

    const definitions = await requestBoth(classic, native, 'textDocument/definition', {
        textDocument: { uri: APP_URI },
        position: definitionPosition
    });
    const normalizedDefinitions = {
        classic: normalizeLocations(definitions.classic),
        tsgo: normalizeLocations(definitions.tsgo)
    };
    for (const [engine, locations] of Object.entries(normalizedDefinitions)) {
        assert.ok(locations.length, `${engine} returned no definition`);
        assert.ok(
            locations.some((location) => normalizedLocationUri(location).endsWith('/src/math.ts'))
        );
        assert.ok(
            locations.some(
                (location) =>
                    normalizedLocationUri(location).endsWith('/src/math.ts') &&
                    normalizedLocationRange(location).start.line === 1
            ),
            `${engine} did not use the unsaved TypeScript buffer`
        );
    }
    compare('definition', normalizedDefinitions.classic, normalizedDefinitions.tsgo);
    completed++;

    const componentDefinitionPosition = positionOf('<Child', 1);
    const componentDefinitions = await requestBoth(classic, native, 'textDocument/definition', {
        textDocument: { uri: APP_URI },
        position: componentDefinitionPosition
    });
    const normalizedComponentDefinitions = {
        classic: normalizeLocations(componentDefinitions.classic),
        tsgo: normalizeLocations(componentDefinitions.tsgo)
    };
    for (const [engine, locations] of Object.entries(normalizedComponentDefinitions)) {
        assert.ok(locations.length, `${engine} returned no component-tag definition`);
        assert.ok(
            locations.some((location) =>
                normalizedLocationUri(location).endsWith('/src/Child.svelte')
            ),
            `${engine} component-tag definition did not resolve to Child.svelte`
        );
    }
    compare(
        'component-tag definition',
        normalizedComponentDefinitions.classic,
        normalizedComponentDefinitions.tsgo
    );
    completed++;

    const renamePosition = positionOf('let message', 'let '.length + 1);
    const renames = await requestBoth(classic, native, 'textDocument/rename', {
        textDocument: { uri: APP_URI },
        position: renamePosition,
        newName: 'renamedMessage'
    });
    const normalizedRenames = {
        classic: normalizeWorkspaceEdit(renames.classic),
        tsgo: normalizeWorkspaceEdit(renames.tsgo)
    };
    for (const [engine, edit] of Object.entries(normalizedRenames)) {
        assert.ok(edit.edits.length >= 3, `${engine} rename returned too few edits`);
        assert.ok(edit.edits.every((entry) => entry.newText === 'renamedMessage'));
    }
    compare('rename workspace edit', normalizedRenames.classic, normalizedRenames.tsgo);
    completed++;

    const references = await requestBoth(classic, native, 'textDocument/references', {
        textDocument: { uri: APP_URI },
        position: definitionPosition,
        context: { includeDeclaration: true }
    });
    const normalizedReferences = {
        classic: normalizeLocations(references.classic),
        tsgo: normalizeLocations(references.tsgo)
    };
    for (const [engine, locations] of Object.entries(normalizedReferences)) {
        assert.ok(locations.length >= 3, `${engine} returned too few references`);
    }
    compare('references', normalizedReferences.classic, normalizedReferences.tsgo);
    completed++;

    const missingDiagnostic = diagnostics.classic.items.find(
        (diagnostic) => Number(diagnostic.code) === 2304 && /helperValue/.test(diagnostic.message)
    );
    assert.ok(missingDiagnostic, 'classic oracle did not produce the auto-import diagnostic');
    const actions = await requestBoth(classic, native, 'textDocument/codeAction', {
        textDocument: { uri: APP_URI },
        range: missingDiagnostic.range,
        context: { diagnostics: [missingDiagnostic], only: ['quickfix'], triggerKind: 1 }
    });
    const selectedActions = {};
    for (const [engine, result] of Object.entries(actions)) {
        assert.ok(Array.isArray(result) && result.length, `${engine} returned no code actions`);
        const action = result.find((candidate) => /import/i.test(candidate.title));
        assert.ok(
            action,
            `${engine} returned no import action: ${JSON.stringify(
                result.map(({ title, kind, data, edit }) => ({
                    title,
                    kind,
                    data: !!data,
                    edit: !!edit
                }))
            )}`
        );
        selectedActions[engine] = action;
    }
    compare(
        'code-action identity',
        stable({ title: selectedActions.classic.title, kind: selectedActions.classic.kind }),
        stable({ title: selectedActions.tsgo.title, kind: selectedActions.tsgo.kind })
    );
    assert.ok(
        selectedActions.tsgo.data || selectedActions.tsgo.edit,
        'tsgo import action was neither resolved nor resolvable'
    );
    const resolveAction = (server, action) =>
        action.edit
            ? Promise.resolve(action)
            : server.client.request('codeAction/resolve', action, TIMEOUT);
    const resolvedActions = await Promise.all([
        resolveAction(classic, selectedActions.classic),
        resolveAction(native, selectedActions.tsgo)
    ]);
    const normalizedResolvedActions = resolvedActions.map((action) =>
        normalizeWorkspaceEdit(action.edit)
    );
    assert.ok(normalizedResolvedActions[0].edits.length, 'classic action resolved without edits');
    assert.ok(normalizedResolvedActions[1].edits.length, 'tsgo action resolved without edits');
    compare('resolved code action', normalizedResolvedActions[0], normalizedResolvedActions[1]);
    completed++;

    const tokens = await requestBoth(classic, native, 'textDocument/semanticTokens/full', {
        textDocument: { uri: APP_URI }
    });
    const decodedTokens = {
        classic: decodeSemanticTokens(tokens.classic),
        tsgo: decodeSemanticTokens(tokens.tsgo)
    };
    for (const [engine, decoded] of Object.entries(decodedTokens)) {
        assert.ok(decoded.length, `${engine} returned no semantic tokens`);
        for (const token of decoded) {
            const line = TEXT.split('\n')[token.line];
            assert.ok(line, `${engine} token escaped the document`);
            assert.ok(
                token.character + token.length <= line.length,
                `${engine} token used non-UTF-16 coordinates: ${JSON.stringify(token)}`
            );
        }
    }
    compare('semantic tokens', decodedTokens.classic, decodedTokens.tsgo);
    completed++;

    const hints = await requestBoth(classic, native, 'textDocument/inlayHint', {
        textDocument: { uri: APP_URI },
        range: fullRange(TEXT)
    });
    const normalizedHints = {
        classic: normalizeInlayHints(hints.classic),
        tsgo: normalizeInlayHints(hints.tsgo)
    };
    for (const [engine, result] of Object.entries(normalizedHints)) {
        assert.ok(
            result.length >= 2,
            `${engine} returned no meaningful inlay hints: ${JSON.stringify(result)}`
        );
    }
    compare('inlay hints', normalizedHints.classic, normalizedHints.tsgo);
    completed++;

    for (const server of [classic, native]) {
        server.client.notify('workspace/didChangeConfiguration', {
            settings: {
                svelte: { plugin: {} },
                typescript: {
                    inlayHints: {
                        parameterNames: {
                            enabled: 'none',
                            suppressWhenArgumentMatchesName: true
                        }
                    }
                }
            }
        });
    }
    let disabledHints;
    const disabledHintDeadline = Date.now() + TIMEOUT;
    do {
        disabledHints = await requestBoth(classic, native, 'textDocument/inlayHint', {
            textDocument: { uri: APP_URI },
            range: fullRange(TEXT)
        });
        if (Object.values(disabledHints).every((result) => !(result ?? []).length)) break;
        await sleep(25);
    } while (Date.now() < disabledHintDeadline);
    assert.deepEqual(disabledHints.classic ?? [], [], 'classic ignored the runtime inlay setting');
    assert.deepEqual(disabledHints.tsgo ?? [], [], 'tsgo ignored the runtime inlay setting');

    for (const server of [classic, native]) {
        server.client.notify('workspace/didChangeConfiguration', {
            settings: {
                svelte: { plugin: {} },
                typescript: {
                    inlayHints: {
                        parameterNames: {
                            enabled: 'all',
                            suppressWhenArgumentMatchesName: false
                        }
                    }
                }
            }
        });
    }
    let restoredHints;
    const restoredHintDeadline = Date.now() + TIMEOUT;
    do {
        restoredHints = await requestBoth(classic, native, 'textDocument/inlayHint', {
            textDocument: { uri: APP_URI },
            range: fullRange(TEXT)
        });
        if (Object.values(restoredHints).every((result) => (result ?? []).length >= 2)) break;
        await sleep(25);
    } while (Date.now() < restoredHintDeadline);
    compare(
        'runtime inlay preference toggle',
        normalizeInlayHints(restoredHints.classic),
        normalizeInlayHints(restoredHints.tsgo)
    );
    completed++;

    const hierarchyPosition = positionOf('function localCall', 'function '.length + 1);
    const prepared = await requestBoth(classic, native, 'textDocument/prepareCallHierarchy', {
        textDocument: { uri: APP_URI },
        position: hierarchyPosition
    });
    const normalizedPrepared = {
        classic: normalizeHierarchyItems(prepared.classic),
        tsgo: normalizeHierarchyItems(prepared.tsgo)
    };
    assert.ok(normalizedPrepared.classic.length, 'classic returned no call-hierarchy item');
    assert.ok(normalizedPrepared.tsgo.length, 'tsgo returned no call-hierarchy item');
    compare('call hierarchy prepare', normalizedPrepared.classic, normalizedPrepared.tsgo);
    const outgoing = await Promise.all([
        classic.client.request(
            'callHierarchy/outgoingCalls',
            { item: prepared.classic[0] },
            TIMEOUT
        ),
        native.client.request('callHierarchy/outgoingCalls', { item: prepared.tsgo[0] }, TIMEOUT)
    ]);
    const normalizedOutgoing = {
        classic: normalizeCalls(outgoing[0], 'outgoing'),
        tsgo: normalizeCalls(outgoing[1], 'outgoing')
    };
    assert.ok(normalizedOutgoing.classic.length, 'classic returned no outgoing calls');
    assert.ok(normalizedOutgoing.tsgo.length, 'tsgo returned no outgoing calls');
    compare('call hierarchy outgoing', normalizedOutgoing.classic, normalizedOutgoing.tsgo);

    const incomingPrepared = await requestBoth(
        classic,
        native,
        'textDocument/prepareCallHierarchy',
        {
            textDocument: { uri: APP_URI },
            position: definitionPosition
        }
    );
    const normalizedIncomingPrepared = {
        classic: normalizeHierarchyItems(incomingPrepared.classic),
        tsgo: normalizeHierarchyItems(incomingPrepared.tsgo)
    };
    assert.ok(normalizedIncomingPrepared.classic.length, 'classic returned no incoming item');
    assert.ok(normalizedIncomingPrepared.tsgo.length, 'tsgo returned no incoming item');
    compare(
        'call hierarchy prepare through dirty TypeScript definition',
        normalizedIncomingPrepared.classic,
        normalizedIncomingPrepared.tsgo
    );
    for (const [engine, items] of Object.entries(normalizedIncomingPrepared)) {
        assert.ok(
            items.some(
                (item) => item.uri.endsWith('/src/math.ts') && item.selectionRange.start.line === 1
            ),
            `${engine} did not prepare the dirty TypeScript target`
        );
    }
    const incoming = await Promise.all([
        classic.client.request(
            'callHierarchy/incomingCalls',
            { item: incomingPrepared.classic[0] },
            TIMEOUT
        ),
        native.client.request(
            'callHierarchy/incomingCalls',
            { item: incomingPrepared.tsgo[0] },
            TIMEOUT
        )
    ]);
    const normalizedIncoming = {
        classic: normalizeCalls(incoming[0], 'incoming'),
        tsgo: normalizeCalls(incoming[1], 'incoming')
    };
    assert.ok(normalizedIncoming.classic.length, 'classic returned no incoming calls');
    assert.ok(normalizedIncoming.tsgo.length, 'tsgo returned no incoming calls');
    for (const [engine, calls] of Object.entries(normalizedIncoming)) {
        assert.ok(
            calls.every((call) => call.item.uri.endsWith('/src/App.svelte')) &&
                calls.reduce((count, call) => count + call.ranges.length, 0) >= 2,
            `${engine} omitted the cross-file Svelte caller`
        );
    }
    compare('call hierarchy incoming', normalizedIncoming.classic, normalizedIncoming.tsgo);
    completed++;

    classic.client.notify('textDocument/didClose', { textDocument: { uri: MATH_URI } });
    native.client.notify('textDocument/didClose', { textDocument: { uri: MATH_URI } });
    let revertedDefinitions;
    const revertDeadline = Date.now() + TIMEOUT;
    do {
        revertedDefinitions = await requestBoth(classic, native, 'textDocument/definition', {
            textDocument: { uri: APP_URI },
            position: definitionPosition
        });
        const reverted = Object.values(revertedDefinitions).every((result) =>
            normalizeLocations(result).some(
                (location) =>
                    normalizedLocationUri(location).endsWith('/src/math.ts') &&
                    normalizedLocationRange(location).start.line === 0
            )
        );
        if (reverted) break;
        await sleep(25);
    } while (Date.now() < revertDeadline);
    const normalizedRevertedDefinitions = {
        classic: normalizeLocations(revertedDefinitions.classic),
        tsgo: normalizeLocations(revertedDefinitions.tsgo)
    };
    for (const [engine, locations] of Object.entries(normalizedRevertedDefinitions)) {
        assert.ok(
            locations.some(
                (location) =>
                    normalizedLocationUri(location).endsWith('/src/math.ts') &&
                    normalizedLocationRange(location).start.line === 0
            ),
            `${engine} kept the closed dirty TypeScript overlay`
        );
    }
    compare(
        'TypeScript close reverts to disk',
        normalizedRevertedDefinitions.classic,
        normalizedRevertedDefinitions.tsgo
    );

    await Promise.all([stopServer(classic), stopServer(native)]);
    classic = undefined;
    native = undefined;
} finally {
    classic?.client.dispose();
    native?.client.dispose();
    if (CLEAN_GENERATED_FIXTURE) {
        fs.rmSync(GENERATED_OVERLAY, { recursive: true, force: true });
    }
}

assert.equal(completed, 12, `oracle completed only ${completed}/12 feature groups`);
console.log(`\nCOMPLETED ${completed} LIVE LSP FEATURE GROUPS`);
console.log(
    `ENGINE ${EXPECTED_ENGINE.packageName}@${EXPECTED_ENGINE.version}` +
        (EFFECT_MODE ? ' (Effect code 377021 allowlisted)' : ' (stock, exact repository pin)')
);
