import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LspClient, sleep } from './lsp-client.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');
const FIXTURE = path.join(
    REPO,
    'packages/language-server/test/plugins/typescript-go/fixtures/component-definition-oracle'
);
const NATIVE_PACKAGE = '@typescript/native-preview';
const TIMEOUT = 120_000;
const require = createRequire(import.meta.url);
const { resolveTsGoEngine } = require(
    path.join(REPO, 'packages/language-server/dist/src/plugins/typescript-go/lsp/TsGoEngine.js')
);
const EXPECTED_NATIVE_VERSION = require(path.join(REPO, 'package.json')).devDependencies[
    NATIVE_PACKAGE
];

// The normal CI install exposes Svelte 4 as `svelte` and the pinned Svelte 5 alias, so both
// majors are exercised in one run. The separate Svelte-5 override job deliberately replaces the
// workspace `svelte` package; derive and de-duplicate the actual installed majors so that job
// still exercises its real compiler instead of failing a hard-coded package-name assumption.
const COMPILERS = [
    require.resolve('svelte/package.json', {
        paths: [path.join(REPO, 'packages/language-server')]
    }),
    require.resolve('svelte5/package.json', {
        paths: [path.join(REPO, 'packages/svelte-check')]
    })
]
    .map((packageJson) => {
        const version = JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
        const major = Number(version.split('.')[0]);
        assert.ok(major === 4 || major === 5, `unsupported Svelte fixture compiler ${version}`);
        return { name: `Svelte ${major}`, major, packageJson };
    })
    .filter(
        (compiler, index, all) => all.findIndex((item) => item.major === compiler.major) === index
    );

function positionIn(text, needle, within = 0) {
    const offset = text.indexOf(needle);
    assert.notEqual(offset, -1, `fixture marker not found: ${needle}`);
    const lines = text.slice(0, offset + within).split('\n');
    // JavaScript string lengths are UTF-16 code units, matching the negotiated LSP encoding.
    return { line: lines.length - 1, character: lines.at(-1).length };
}

function normalizeDefinitions(result) {
    return (result ? (Array.isArray(result) ? result : [result]) : [])
        .map((entry) => {
            const targetUri = entry.targetUri ?? entry.uri;
            const targetRange = entry.targetRange ?? entry.range;
            const targetSelectionRange = entry.targetSelectionRange ?? entry.range;
            assert.ok(targetUri && targetRange && targetSelectionRange, 'malformed definition');
            return {
                targetUri,
                targetRange,
                targetSelectionRange,
                originSelectionRange: entry.originSelectionRange ?? null
            };
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function startServer(project, useTsGo, expectedEngine) {
    const env = { ...process.env, SVELTE_LS_TSGO: useTsGo ? '1' : '' };
    delete env.SVELTE_LS_TSGO_PACKAGE;
    if (useTsGo) {
        env.SVELTE_LS_TSGO_PACKAGE = NATIVE_PACKAGE;
    }
    const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
        cwd: project,
        env
    });
    client.onRequest('workspace/configuration', (params) => (params.items ?? []).map(() => ({})));
    client.onRequest('client/registerCapability', () => null);
    client.onRequest('client/unregisterCapability', () => null);
    client.onRequest('window/workDoneProgress/create', () => null);
    client.onRequest('workspace/diagnostic/refresh', () => null);
    client.onRequest('workspace/semanticTokens/refresh', () => null);
    client.onRequest('workspace/inlayHint/refresh', () => null);

    const projectUri = pathToFileURL(project).href;
    const initialize = await client.request(
        'initialize',
        {
            processId: process.pid,
            rootUri: projectUri,
            workspaceFolders: [{ uri: projectUri, name: path.basename(project) }],
            capabilities: {
                general: { positionEncodings: ['utf-16'] },
                workspace: {
                    configuration: true,
                    diagnostics: { refreshSupport: true },
                    didChangeWatchedFiles: { dynamicRegistration: true }
                },
                textDocument: {
                    synchronization: { dynamicRegistration: true },
                    definition: { linkSupport: true }
                }
            },
            initializationOptions: {
                isTrusted: true,
                configuration: { svelte: { plugin: {} } }
            }
        },
        TIMEOUT
    );
    assert.equal(initialize?.capabilities?.positionEncoding ?? 'utf-16', 'utf-16');
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
        const stats = await client.request('$/getTsGoStats', null, TIMEOUT);
        assert.deepStrictEqual(stats.engine, {
            packageName: expectedEngine.packageName,
            version: expectedEngine.version,
            apiAvailable: !!expectedEngine.apiEntry
        });
    }
    assert.equal(client.exited, null, 'language server exited during initialization');
    return client;
}

async function stopServer(client, name) {
    assert.equal(client.exited, null, `${name} exited before shutdown`);
    const exited = new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${name} did not exit after shutdown`)),
            10_000
        );
        client.onExit((result) => {
            clearTimeout(timer);
            resolve(result);
        });
    });
    await client.request('shutdown', null, 10_000);
    client.notify('exit');
    const result = await exited;
    assert.equal(result.error, undefined, `${name}: ${result.error?.message}`);
    assert.equal(result.sig, null, `${name} exited by signal ${result.sig}`);
    assert.equal(result.code, 0, `${name} exited with code ${result.code}`);
}

async function requestDefinitions(clients, sourceUri, position) {
    const [classic, tsgo] = await Promise.all(
        clients.map((client) =>
            client.request(
                'textDocument/definition',
                { textDocument: { uri: sourceUri }, position },
                TIMEOUT
            )
        )
    );
    return {
        classic: normalizeDefinitions(classic),
        tsgo: normalizeDefinitions(tsgo)
    };
}

function assertDefinitionParity(results, expectedUri, context) {
    for (const [engine, definitions] of Object.entries(results)) {
        assert.equal(
            definitions.length,
            1,
            `${context}: ${engine} returned ${definitions.length} definition targets`
        );
        assert.equal(
            definitions[0].targetUri,
            expectedUri,
            `${context}: ${engine} resolved the wrong component`
        );
    }
    assert.deepStrictEqual(results.tsgo, results.classic, `${context}: classic-vs-stock mismatch`);
}

function completionItems(result, context) {
    const items = Array.isArray(result) ? result : result?.items;
    assert.ok(Array.isArray(items), `${context}: malformed completion response`);
    assert.ok(items.length > 0, `${context}: completion response was empty`);
    return items;
}

function completionPhaseCount(stats, phase) {
    return stats.phaseTimings?.[phase]?.count ?? 0;
}

function unsupportedCompletionCounters(stats) {
    return {
        nativeRequests: completionPhaseCount(stats, 'completionNative'),
        projectNotReadyFallbacks: stats.fallbackReasons?.['completion-project-not-ready'] ?? 0,
        apiFallbacks: stats.completionApiFallbacks ?? 0,
        isolatedFallbacks: stats.completionIsolatedFallbacks ?? 0
    };
}

async function requestCompletion(client, sourceUri, position, context = { triggerKind: 1 }) {
    return client.request(
        'textDocument/completion',
        { textDocument: { uri: sourceUri }, position, context },
        TIMEOUT
    );
}

test('fresh tsgo servers return meaningful first-request global and component-prop completions', async (t) => {
    assert.ok(fs.existsSync(SERVER), `language server is not built: ${SERVER}`);
    assert.ok(fs.existsSync(FIXTURE), `component completion fixture is missing: ${FIXTURE}`);

    const compiler = COMPILERS[0];
    for (const scenario of [
        {
            name: 'script auto-import',
            marker: 'writ',
            within: 'writ'.length,
            expectedLabel: (label) => label === 'writable'
        },
        {
            name: 'component prop',
            marker: '<Button ',
            within: '<Button '.length,
            expectedLabel: (label) => label.replace(/\?$/, '') === 'label'
        },
        {
            name: 'dirty TypeScript auto-import',
            marker: 'dirtyOnlySy',
            within: 'dirtyOnlySy'.length,
            expectedLabel: (label) => label === 'dirtyOnlySymbol',
            openDirtyTypeScript: true
        }
    ]) {
        await t.test(scenario.name, async () => {
            const temporaryRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), 'svelte-tsgo-cold-completion-')
            );
            const project = path.join(temporaryRoot, 'project');
            fs.cpSync(FIXTURE, project, { recursive: true });
            fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
            fs.symlinkSync(
                path.dirname(compiler.packageJson),
                path.join(project, 'node_modules/svelte'),
                'junction'
            );

            const expectedEngine = resolveTsGoEngine(project, { packageName: NATIVE_PACKAGE });
            assert.ok(expectedEngine, `could not resolve ${NATIVE_PACKAGE}`);
            assert.equal(expectedEngine.version, EXPECTED_NATIVE_VERSION);

            const sourcePath = path.join(project, 'src/Completion.svelte');
            const sourceUri = pathToFileURL(sourcePath).href;
            const source = fs.readFileSync(sourcePath, 'utf8');
            let native;
            try {
                native = await startServer(project, true, expectedEngine);
                if (scenario.openDirtyTypeScript) {
                    const dirtyPath = path.join(project, 'src/dirty.ts');
                    native.notify('textDocument/didOpen', {
                        textDocument: {
                            uri: pathToFileURL(dirtyPath).href,
                            languageId: 'typescript',
                            version: 1,
                            text: `${fs.readFileSync(dirtyPath, 'utf8')}\nexport const dirtyOnlySymbol = 2;\n`
                        }
                    });
                }
                native.notify('textDocument/didOpen', {
                    textDocument: {
                        uri: sourceUri,
                        languageId: 'svelte',
                        version: 1,
                        text: source
                    }
                });

                // No diagnostic or warm-up request precedes this. It is the first valid
                // completion issued against a newly opened buffer in a fresh server process.
                const first = await requestCompletion(
                    native,
                    sourceUri,
                    positionIn(source, scenario.marker, scenario.within)
                );
                const firstItems = completionItems(first, `${scenario.name} first request`);
                assert.ok(
                    firstItems.some(
                        (item) =>
                            typeof item?.label === 'string' && scenario.expectedLabel(item.label)
                    ),
                    `${scenario.name}: expected label missing from ${JSON.stringify(
                        firstItems.slice(0, 20).map((item) => item?.label)
                    )}`
                );

                // Unsupported TypeScript contexts may still be answered by CSS/HTML, but they
                // must never reach tsgo or wake the cold classic completion owner.
                const unsupportedBefore = unsupportedCompletionCounters(
                    await native.request('$/getTsGoStats', null, TIMEOUT)
                );
                const unsupportedResults = await Promise.all([
                    requestCompletion(
                        native,
                        sourceUri,
                        positionIn(source, 'color: re', 'color: re'.length)
                    ),
                    requestCompletion(
                        native,
                        sourceUri,
                        positionIn(source, 'plain completion marker', 'plain completion'.length)
                    ),
                    requestCompletion(native, sourceUri, positionIn(source, '<p>', '<p>'.length), {
                        triggerKind: 2,
                        triggerCharacter: '>'
                    })
                ]);
                const unsupportedAfter = unsupportedCompletionCounters(
                    await native.request('$/getTsGoStats', null, TIMEOUT)
                );
                assert.deepStrictEqual(
                    unsupportedAfter,
                    unsupportedBefore,
                    `${scenario.name}: unsupported contexts performed TypeScript completion work`
                );
                for (const result of unsupportedResults) {
                    const items = Array.isArray(result) ? result : (result?.items ?? []);
                    assert.ok(
                        Array.isArray(items),
                        'unsupported completion response was malformed'
                    );
                    assert.ok(
                        items.every(
                            (item) =>
                                item?.data?.__svelteCompletionOwner !== 'classic' &&
                                item?.data?.__svelteCompletionOwner !== 'tsgo'
                        ),
                        `${scenario.name}: unsupported context returned TypeScript-owned items`
                    );
                }

                await stopServer(native, `${scenario.name} tsgo`);
                native = undefined;
            } finally {
                native?.dispose();
                fs.rmSync(temporaryRoot, { recursive: true, force: true });
            }
        });
    }
});

test('component-tag definitions match classic for installed Svelte 4/5 compilers and dirty import retargets', async (t) => {
    assert.ok(fs.existsSync(SERVER), `language server is not built: ${SERVER}`);
    assert.ok(fs.existsSync(FIXTURE), `component definition fixture is missing: ${FIXTURE}`);

    for (const compiler of COMPILERS) {
        await t.test(compiler.name, async () => {
            const manifest = JSON.parse(fs.readFileSync(compiler.packageJson, 'utf8'));
            assert.equal(Number(manifest.version.split('.')[0]), compiler.major);

            const temporaryRoot = fs.mkdtempSync(
                path.join(os.tmpdir(), `svelte-tsgo-definition-${compiler.major}-`)
            );
            const project = path.join(temporaryRoot, 'project');
            fs.cpSync(FIXTURE, project, { recursive: true });
            fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
            fs.symlinkSync(
                path.dirname(compiler.packageJson),
                path.join(project, 'node_modules/svelte'),
                'junction'
            );

            const expectedEngine = resolveTsGoEngine(project, { packageName: NATIVE_PACKAGE });
            assert.ok(expectedEngine, `could not resolve ${NATIVE_PACKAGE}`);
            assert.equal(expectedEngine.packageName, NATIVE_PACKAGE);
            assert.equal(expectedEngine.version, EXPECTED_NATIVE_VERSION);

            const sourcePath = path.join(project, 'src/App.svelte');
            const sourceUri = pathToFileURL(sourcePath).href;
            const cleanText = fs.readFileSync(sourcePath, 'utf8');
            const dirtyText = cleanText.replace("'./Button.svelte'", "'./Retargeted.svelte'");
            assert.notEqual(dirtyText, cleanText, 'dirty fixture did not retarget its import');
            const tagPosition = positionIn(cleanText, '<Button', 1);

            let classic;
            let native;
            try {
                [classic, native] = await Promise.all([
                    startServer(project, false, expectedEngine),
                    startServer(project, true, expectedEngine)
                ]);
                for (const client of [classic, native]) {
                    client.notify('textDocument/didOpen', {
                        textDocument: {
                            uri: sourceUri,
                            languageId: 'svelte',
                            version: 1,
                            text: cleanText
                        }
                    });
                }

                const clean = await requestDefinitions([classic, native], sourceUri, tagPosition);
                assertDefinitionParity(
                    clean,
                    pathToFileURL(path.join(project, 'src/Button.svelte')).href,
                    `${compiler.name} clean buffer`
                );

                for (const client of [classic, native]) {
                    client.notify('textDocument/didChange', {
                        textDocument: { uri: sourceUri, version: 2 },
                        contentChanges: [{ text: dirtyText }]
                    });
                }
                const dirty = await requestDefinitions([classic, native], sourceUri, tagPosition);
                assertDefinitionParity(
                    dirty,
                    pathToFileURL(path.join(project, 'src/Retargeted.svelte')).href,
                    `${compiler.name} dirty buffer`
                );

                await Promise.all([
                    stopServer(classic, `${compiler.name} classic`),
                    stopServer(native, `${compiler.name} tsgo`)
                ]);
                classic = undefined;
                native = undefined;
            } finally {
                classic?.dispose();
                native?.dispose();
                fs.rmSync(temporaryRoot, { recursive: true, force: true });
            }
        });
    }
});
