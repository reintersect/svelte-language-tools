// End-to-end template diagnostic oracle for the real language-server processes.
//
// The checker sanity suite consumes the same manifests. Running them through pull diagnostics
// here prevents an adapter or document-overlay regression from hiding behind checker parity.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LspClient, sleep } from './lsp-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');
const CORPUS_ROOT = path.join(REPO, 'packages/svelte-check/test-template-diagnostics');
const SVELTE_MANIFEST = path.join(REPO, 'packages/svelte-check/node_modules/svelte5/package.json');
const TSGO_PACKAGE = '@typescript/native-preview';
const TSGO_MANIFEST = path.join(REPO, 'node_modules', TSGO_PACKAGE, 'package.json');
const TIMEOUT = 120_000;

function normalizeFilename(value) {
    return value.replace(/\\/g, '/');
}

function readCorpus(suite) {
    const sourceRoot = path.join(CORPUS_ROOT, suite);
    const expectations = JSON.parse(
        fs.readFileSync(path.join(sourceRoot, 'expectations.json'), 'utf8')
    );
    assert.equal(expectations.schemaVersion, 1, `${suite}: unsupported expectation schema`);

    const manifest = JSON.parse(fs.readFileSync(SVELTE_MANIFEST, 'utf8'));
    assert.equal(manifest.name, 'svelte', 'the svelte5 alias does not resolve to Svelte');
    assert.equal(
        manifest.version,
        expectations.svelteVersion,
        `${suite}: fixture and installed Svelte versions differ`
    );
    const fixtureManifest = JSON.parse(
        fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    assert.equal(
        fixtureManifest.dependencies?.svelte,
        expectations.svelteVersion,
        `${suite}: package.json must pin the oracle's exact Svelte version`
    );

    const files = fs
        .readdirSync(path.join(sourceRoot, 'src'))
        .filter((file) => file.endsWith('.svelte'))
        .map((file) => `src/${file}`)
        .sort();
    const expectedFiles = expectations.cases.map((entry) => normalizeFilename(entry.file)).sort();
    assert.deepStrictEqual(
        files,
        expectedFiles,
        `${suite}: every fixture needs one manifest entry`
    );
    assert.equal(
        new Set(expectedFiles).size,
        expectedFiles.length,
        `${suite}: duplicate case file`
    );

    for (const entry of expectations.cases) {
        assert.ok(
            Array.isArray(entry.diagnostics),
            `${suite} ${entry.file}: malformed diagnostics`
        );
        const supportFile = path.basename(entry.file).startsWith('_');
        if (!supportFile) {
            assert.ok(
                entry.diagnostics.length > 0,
                `${suite} ${entry.file}: an exercised template case must pin a diagnostic`
            );
        }
        if (suite === 'parser') {
            assert.ok(
                entry.diagnostics.every(
                    (diagnostic) =>
                        diagnostic.source === 'svelte' && typeof diagnostic.code === 'string'
                ),
                `${suite} ${entry.file}: malformed syntax must pin a Svelte parser diagnostic`
            );
        }
    }

    return { sourceRoot, expectations };
}

function createProject(corpus, engine) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `svelte-template-${engine}-`));
    const project = path.join(temporaryRoot, 'project');
    fs.cpSync(corpus.sourceRoot, project, { recursive: true });
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.symlinkSync(
        fs.realpathSync(path.dirname(SVELTE_MANIFEST)),
        path.join(project, 'node_modules/svelte'),
        process.platform === 'win32' ? 'junction' : 'dir'
    );
    return { project, temporaryRoot };
}

function normalizeRelatedUri(value, workspace) {
    let filePath;
    try {
        const url = new URL(value);
        if (url.protocol !== 'file:') return value;
        filePath = fileURLToPath(url);
    } catch {
        return normalizeFilename(value);
    }

    const relative = path.relative(workspace, filePath);
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return `workspace:${normalizeFilename(relative)}`;
    }

    const normalized = normalizeFilename(filePath);
    const svelteMarker = '/node_modules/svelte/';
    const svelteIndex = normalized.lastIndexOf(svelteMarker);
    if (svelteIndex >= 0) {
        return `dependency:svelte/${normalized.slice(svelteIndex + svelteMarker.length)}`;
    }
    if (normalized.includes('typescript') && /\/lib\/lib\.[^/]+\.d\.ts$/.test(normalized)) {
        return `typescript-lib:${path.posix.basename(normalized)}`;
    }
    return `external:${path.posix.basename(normalized)}`;
}

function sortDiagnostics(diagnostics) {
    return diagnostics.sort((left, right) =>
        JSON.stringify([left.range, left.code, left.message]).localeCompare(
            JSON.stringify([right.range, right.code, right.message])
        )
    );
}

function actualSignature(diagnostics, workspace) {
    return sortDiagnostics(
        diagnostics.map((diagnostic) => ({
            range: diagnostic.range,
            severity: diagnostic.severity ?? null,
            code: diagnostic.code ?? null,
            codeDescription: diagnostic.codeDescription ?? null,
            source: diagnostic.source ?? null,
            message: diagnostic.message,
            relatedInformation: (diagnostic.relatedInformation ?? []).map((related) => ({
                message: related.message,
                location: {
                    uri: normalizeRelatedUri(related.location.uri, workspace),
                    range: related.location.range
                }
            }))
        }))
    );
}

function expectedSignature(entry, engine) {
    return sortDiagnostics(
        entry.diagnostics.map((diagnostic) => {
            // The pinned native-preview CLI includes related spans, but its LSP transport does
            // not currently send them even when the client advertises support. Keep that
            // upstream limitation explicit per diagnostic instead of weakening every field.
            const expected = {
                ...diagnostic,
                ...(diagnostic.lsp ?? {}),
                ...(diagnostic[engine] ?? {}),
                ...(diagnostic[`${engine}Lsp`] ?? {})
            };
            const [startLine, startCharacter, endLine, endCharacter] = expected.range;
            return {
                range: {
                    start: { line: startLine, character: startCharacter },
                    end: { line: endLine, character: endCharacter }
                },
                severity: expected.severity ?? 1,
                code: expected.code,
                codeDescription: expected.codeDescription ?? null,
                source: expected.source ?? 'ts',
                message: expected.message,
                relatedInformation: (expected.relatedInformation ?? []).map((related) => {
                    const [
                        relatedStartLine,
                        relatedStartCharacter,
                        relatedEndLine,
                        relatedEndCharacter
                    ] = related.range;
                    return {
                        message: related.message,
                        location: {
                            uri: related.uri,
                            range: {
                                start: {
                                    line: relatedStartLine,
                                    character: relatedStartCharacter
                                },
                                end: {
                                    line: relatedEndLine,
                                    character: relatedEndCharacter
                                }
                            }
                        }
                    };
                })
            };
        })
    );
}

function parseEnabledEngine(stderr) {
    const match = /\[tsgo\] enabled, using (.+)@([^@\s]+) \(([^\n]+)\)/.exec(stderr);
    return match ? { packageName: match[1], version: match[2], executable: match[3] } : undefined;
}

async function startServer(project, useTsGo, expectedTsGoVersion, diagnosticSources) {
    const enabledDiagnosticSources = new Set(
        (diagnosticSources ?? 'js,svelte,css').split(',').map((source) => source.trim())
    );
    const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
        cwd: project,
        env: {
            ...process.env,
            SVELTE_LS_RSVELTE: '0',
            SVELTE_LS_TSGO: useTsGo ? '1' : '',
            SVELTE_LS_TSGO_PACKAGE: TSGO_PACKAGE
        }
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
                    diagnostic: { relatedDocumentSupport: true },
                    publishDiagnostics: { relatedInformation: true }
                }
            },
            initializationOptions: {
                isTrusted: true,
                configuration: {
                    svelte: {
                        plugin: {
                            typescript: {
                                diagnostics: { enable: enabledDiagnosticSources.has('js') }
                            },
                            svelte: {
                                diagnostics: { enable: enabledDiagnosticSources.has('svelte') }
                            },
                            css: {
                                diagnostics: { enable: enabledDiagnosticSources.has('css') }
                            }
                        }
                    }
                }
            }
        },
        TIMEOUT
    );
    assert.equal(initialize?.capabilities?.positionEncoding ?? 'utf-16', 'utf-16');
    client.notify('initialized', {});

    if (useTsGo) {
        let engine;
        for (let attempt = 0; attempt < 200 && !engine; attempt++) {
            engine = parseEnabledEngine(client.stderr);
            if (client.exited) break;
            if (!engine) await sleep(25);
        }
        assert.deepStrictEqual(
            engine && { packageName: engine.packageName, version: engine.version },
            { packageName: TSGO_PACKAGE, version: expectedTsGoVersion },
            `the exact stock tsgo engine was not enabled:\n${client.stderr}`
        );
    }
    return client;
}

async function getTsGoStats(client) {
    const stats = await client.request('$/getTsGoStats', null, 10_000);
    assert.ok(stats?.engine, `tsgo returned malformed stats: ${JSON.stringify(stats)}`);
    for (const field of [
        'generation',
        'openOverlays',
        'childOpenOverlays',
        'pendingSvelteLifecycle',
        'projectChecks',
        'fellBack',
        'cancellations'
    ]) {
        assert.ok(Number.isSafeInteger(stats[field]), `tsgo stats.${field} was malformed`);
    }
    return stats;
}

async function waitForTsGoState(client, predicate, label) {
    let latest;
    for (let attempt = 0; attempt < 800; attempt++) {
        latest = await getTsGoStats(client);
        if (predicate(latest)) return latest;
        await sleep(25);
    }
    assert.fail(`${label}; latest tsgo stats: ${JSON.stringify(latest)}`);
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
    client.notify('exit', null);
    const result = await exited;
    assert.equal(result.error, undefined, `${name}: ${result.error?.message}`);
    assert.equal(result.sig, null, `${name} exited by signal ${result.sig}`);
    assert.equal(result.code, 0, `${name} exited with ${result.code}`);
}

function assertDiagnosticReport(report, engine, entry, fixture, label = entry.file) {
    assert.equal(report?.kind, 'full', `${engine} ${label}: incomplete report`);
    assert.ok(
        typeof report.resultId === 'string' && report.resultId.length > 0,
        `${engine} ${label}: missing result id`
    );
    assert.ok(Array.isArray(report.items), `${engine} ${label}: malformed report`);
    if (entry.diagnostics.length > 0) {
        assert.ok(
            report.items.length > 0,
            `${engine} ${label}: non-empty template oracle produced no diagnostics`
        );
    }
    assert.deepStrictEqual(
        actualSignature(report.items, fixture.project),
        expectedSignature(entry, engine),
        `${engine} ${label}: template diagnostics differ from the pinned oracle`
    );
}

async function requestPairDiagnostics(
    classic,
    native,
    classicFixture,
    nativeFixture,
    entry,
    label
) {
    const [classicReport, nativeReport] = await Promise.all(
        [
            [classic, classicFixture],
            [native, nativeFixture]
        ].map(([client, fixture]) =>
            client.request(
                'textDocument/diagnostic',
                {
                    textDocument: {
                        uri: pathToFileURL(path.join(fixture.project, entry.file)).href
                    }
                },
                TIMEOUT
            )
        )
    );
    assertDiagnosticReport(classicReport, 'classic', entry, classicFixture, label);
    assertDiagnosticReport(nativeReport, 'native', entry, nativeFixture, label);
}

async function assertUnsavedTemplateLifecycle(
    corpus,
    classic,
    native,
    classicFixture,
    nativeFixture,
    baseline
) {
    const targetFile = 'src/_Button.svelte';
    const openEntry = corpus.expectations.cases.find(
        (entry) => entry.file === 'src/00-undeclared-component.svelte'
    );
    const changedEntry = corpus.expectations.cases.find(
        (entry) => entry.file === 'src/05-each-object-destructure.svelte'
    );
    assert.ok(openEntry && changedEntry, 'semantic corpus is missing lifecycle source cases');

    const fixtures = [classicFixture, nativeFixture];
    const clients = [classic, native];
    const originalText = fs.readFileSync(path.join(classicFixture.project, targetFile), 'utf8');
    const openText = fs.readFileSync(path.join(classicFixture.project, openEntry.file), 'utf8');
    const changedText = fs.readFileSync(
        path.join(classicFixture.project, changedEntry.file),
        'utf8'
    );

    for (let index = 0; index < clients.length; index++) {
        clients[index].notify('textDocument/didOpen', {
            textDocument: {
                uri: pathToFileURL(path.join(fixtures[index].project, targetFile)).href,
                languageId: 'svelte',
                version: 1,
                text: openText
            }
        });
    }
    await waitForTsGoState(
        native,
        (stats) =>
            stats.generation > baseline.generation &&
            stats.pendingSvelteLifecycle === 0 &&
            stats.openOverlays === baseline.openOverlays + 1 &&
            stats.childOpenOverlays === baseline.childOpenOverlays + 1,
        'semantic dirty didOpen did not settle'
    );
    await requestPairDiagnostics(
        classic,
        native,
        classicFixture,
        nativeFixture,
        { ...openEntry, file: targetFile },
        `${targetFile} dirty didOpen`
    );

    let previous = await getTsGoStats(native);
    for (let index = 0; index < clients.length; index++) {
        clients[index].notify('textDocument/didChange', {
            textDocument: {
                uri: pathToFileURL(path.join(fixtures[index].project, targetFile)).href,
                version: 2
            },
            contentChanges: [{ text: changedText }]
        });
    }
    await waitForTsGoState(
        native,
        (stats) => stats.generation > previous.generation && stats.pendingSvelteLifecycle === 0,
        'semantic dirty didChange did not settle'
    );
    await requestPairDiagnostics(
        classic,
        native,
        classicFixture,
        nativeFixture,
        { ...changedEntry, file: targetFile },
        `${targetFile} dirty didChange`
    );

    previous = await getTsGoStats(native);
    for (let index = 0; index < clients.length; index++) {
        clients[index].notify('textDocument/didChange', {
            textDocument: {
                uri: pathToFileURL(path.join(fixtures[index].project, targetFile)).href,
                version: 3
            },
            contentChanges: [{ text: originalText }]
        });
    }
    await waitForTsGoState(
        native,
        (stats) => stats.generation > previous.generation && stats.pendingSvelteLifecycle === 0,
        'semantic in-memory revert did not settle'
    );
    await requestPairDiagnostics(
        classic,
        native,
        classicFixture,
        nativeFixture,
        { file: targetFile, diagnostics: [] },
        `${targetFile} in-memory revert`
    );

    for (let index = 0; index < clients.length; index++) {
        clients[index].notify('textDocument/didClose', {
            textDocument: {
                uri: pathToFileURL(path.join(fixtures[index].project, targetFile)).href
            }
        });
    }
    await waitForTsGoState(
        native,
        (stats) =>
            stats.pendingSvelteLifecycle === 0 &&
            stats.openOverlays === baseline.openOverlays &&
            stats.childOpenOverlays === baseline.childOpenOverlays,
        'semantic dirty document close did not return to baseline'
    );
}

async function assertCorpusThroughLsp(suite, expectedTsGoVersion) {
    const corpus = readCorpus(suite);
    const classicFixture = createProject(corpus, 'classic');
    const nativeFixture = createProject(corpus, 'native');
    let classic;
    let native;

    try {
        [classic, native] = await Promise.all([
            startServer(
                classicFixture.project,
                false,
                expectedTsGoVersion,
                corpus.expectations.diagnosticSources
            ),
            startServer(
                nativeFixture.project,
                true,
                expectedTsGoVersion,
                corpus.expectations.diagnosticSources
            )
        ]);
        const baseline = await waitForTsGoState(
            native,
            (stats) => stats.pendingSvelteLifecycle === 0,
            `${suite}: tsgo lifecycle did not settle after initialization`
        );
        assert.deepStrictEqual(baseline.engine, {
            packageName: TSGO_PACKAGE,
            version: expectedTsGoVersion,
            apiAvailable: true
        });

        for (const entry of corpus.expectations.cases) {
            for (const [client, fixture] of [
                [classic, classicFixture],
                [native, nativeFixture]
            ]) {
                const filePath = path.join(fixture.project, entry.file);
                client.notify('textDocument/didOpen', {
                    textDocument: {
                        uri: pathToFileURL(filePath).href,
                        languageId: 'svelte',
                        version: 1,
                        text: fs.readFileSync(filePath, 'utf8')
                    }
                });
            }
            await waitForTsGoState(
                native,
                (stats) =>
                    stats.pendingSvelteLifecycle === 0 &&
                    stats.openOverlays === baseline.openOverlays + 1 &&
                    stats.childOpenOverlays === baseline.childOpenOverlays + 1,
                `${suite} ${entry.file}: open overlay did not settle`
            );

            await requestPairDiagnostics(classic, native, classicFixture, nativeFixture, entry);

            for (const [client, fixture] of [
                [classic, classicFixture],
                [native, nativeFixture]
            ]) {
                client.notify('textDocument/didClose', {
                    textDocument: {
                        uri: pathToFileURL(path.join(fixture.project, entry.file)).href
                    }
                });
            }
            await waitForTsGoState(
                native,
                (stats) =>
                    stats.pendingSvelteLifecycle === 0 &&
                    stats.openOverlays === baseline.openOverlays &&
                    stats.childOpenOverlays === baseline.childOpenOverlays,
                `${suite} ${entry.file}: closed overlay did not return to baseline`
            );
        }

        if (suite === 'semantic') {
            await assertUnsavedTemplateLifecycle(
                corpus,
                classic,
                native,
                classicFixture,
                nativeFixture,
                baseline
            );
        }

        const finalStats = await getTsGoStats(native);
        assert.equal(finalStats.fellBack, 0, `${suite}: tsgo used a fallback path`);
        assert.equal(finalStats.cancellations, 0, `${suite}: tsgo cancelled a fixture check`);
        assert.equal(
            finalStats.openOverlays,
            baseline.openOverlays,
            `${suite}: tsgo leaked an open overlay`
        );
        assert.equal(
            finalStats.childOpenOverlays,
            baseline.childOpenOverlays,
            `${suite}: the native child leaked an open overlay`
        );

        await Promise.all([
            stopServer(classic, `${suite} classic`),
            stopServer(native, `${suite} tsgo`)
        ]);
        classic = undefined;
        native = undefined;
    } finally {
        classic?.dispose();
        native?.dispose();
        fs.rmSync(classicFixture.temporaryRoot, { recursive: true, force: true });
        fs.rmSync(nativeFixture.temporaryRoot, { recursive: true, force: true });
    }
}

test('classic and tsgo pull diagnostics preserve the pinned template corpus', async () => {
    assert.ok(fs.existsSync(SERVER), `language server is not built: ${SERVER}`);
    assert.ok(
        fs.existsSync(SVELTE_MANIFEST),
        `pinned Svelte 5 package is missing: ${SVELTE_MANIFEST}`
    );
    assert.ok(fs.existsSync(TSGO_MANIFEST), `pinned native engine is missing: ${TSGO_MANIFEST}`);
    const tsGoManifest = JSON.parse(fs.readFileSync(TSGO_MANIFEST, 'utf8'));
    const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    assert.equal(tsGoManifest.name, TSGO_PACKAGE);
    assert.equal(
        rootManifest.devDependencies?.[TSGO_PACKAGE],
        tsGoManifest.version,
        'the root oracle must pin the exact installed native-engine version'
    );

    await assertCorpusThroughLsp('semantic', tsGoManifest.version);
    await assertCorpusThroughLsp('parser', tsGoManifest.version);
    await assertCorpusThroughLsp('mixed', tsGoManifest.version);
});
