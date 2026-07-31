import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { LspClient, sleep } from './lsp-client.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const SERVER = path.join(REPO, 'packages/language-server/bin/server.js');
const SVELTE = path.join(REPO, 'packages/language-server/node_modules/svelte');
const TIMEOUT = 60_000;

const SOURCE = `<script lang="ts">
    const unicode = 'Ж😀';
    function takesNumber(value: number) { return value; }
    const broken = takesNumber('wrong');
    const valid = takesNumber(1);
</script>

<p>{unicode}{broken}{valid}</p>
`;

function positionIn(text, needle, within = 0) {
    const offset = text.indexOf(needle);
    assert.notEqual(offset, -1, `fixture marker not found: ${needle}`);
    const lines = text.slice(0, offset + within).split('\n');
    return { line: lines.length - 1, character: lines.at(-1).length };
}

function diagnosticSignature(items) {
    return items
        .map((diagnostic) => ({
            range: diagnostic.range,
            severity: diagnostic.severity ?? null,
            code: diagnostic.code ?? null,
            source: diagnostic.source ?? null,
            message: diagnostic.message,
            relatedInformation: diagnostic.relatedInformation ?? []
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeLocations(result) {
    return (result ? (Array.isArray(result) ? result : [result]) : [])
        .map((location) => ({
            uri: location.uri ?? location.targetUri,
            range: location.range ?? location.targetSelectionRange ?? location.targetRange
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function startServer(project, useTsGo) {
    const client = new LspClient(process.execPath, [SERVER, '--stdio'], {
        cwd: project,
        env: { ...process.env, SVELTE_LS_TSGO: useTsGo ? '1' : '' }
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
                    publishDiagnostics: { relatedInformation: true },
                    hover: { contentFormat: ['plaintext'] },
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
    }
    return client;
}

test('config-less Svelte workspaces use a typed inferred project', async () => {
    assert.ok(fs.existsSync(SERVER), `language server is not built: ${SERVER}`);
    assert.ok(fs.existsSync(SVELTE), `test Svelte package is missing: ${SVELTE}`);

    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-tsgo-inferred-'));
    const sourcePath = path.join(project, 'src/App.svelte');
    const sourceUri = pathToFileURL(sourcePath).href;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.writeFileSync(
        path.join(project, 'package.json'),
        JSON.stringify({ name: 'inferred-fixture', private: true, dependencies: { svelte: '*' } })
    );
    fs.writeFileSync(sourcePath, SOURCE);
    fs.symlinkSync(fs.realpathSync(SVELTE), path.join(project, 'node_modules/svelte'), 'junction');

    let classic;
    let native;
    try {
        [classic, native] = await Promise.all([
            startServer(project, false),
            startServer(project, true)
        ]);
        for (const client of [classic, native]) {
            client.notify('textDocument/didOpen', {
                textDocument: {
                    uri: sourceUri,
                    languageId: 'svelte',
                    version: 1,
                    text: SOURCE
                }
            });
        }

        const [classicReport, nativeReport] = await Promise.all(
            [classic, native].map((client) =>
                client.request(
                    'textDocument/diagnostic',
                    { textDocument: { uri: sourceUri } },
                    TIMEOUT
                )
            )
        );
        for (const [engine, report] of [
            ['classic', classicReport],
            ['tsgo', nativeReport]
        ]) {
            assert.equal(report?.kind, 'full', `${engine} returned an incomplete report`);
            const argumentError = report.items.find((item) => Number(item.code) === 2345);
            assert.ok(argumentError, `${engine} missed TS2345 in the config-less project`);
            assert.deepStrictEqual(argumentError.range.start, positionIn(SOURCE, "'wrong'"));
            assert.deepStrictEqual(
                argumentError.range.end,
                positionIn(SOURCE, "'wrong'", "'wrong'".length)
            );
        }
        assert.deepStrictEqual(
            diagnosticSignature(nativeReport.items),
            diagnosticSignature(classicReport.items)
        );

        const usage = positionIn(SOURCE, 'takesNumber(1)', 2);
        const [classicHover, nativeHover] = await Promise.all(
            [classic, native].map((client) =>
                client.request(
                    'textDocument/hover',
                    { textDocument: { uri: sourceUri }, position: usage },
                    TIMEOUT
                )
            )
        );
        assert.ok(classicHover?.range, 'classic returned no meaningful hover');
        assert.ok(nativeHover?.range, 'tsgo returned no meaningful hover');
        assert.deepStrictEqual(nativeHover.range, classicHover.range);

        const [classicDefinition, nativeDefinition] = await Promise.all(
            [classic, native].map((client) =>
                client.request(
                    'textDocument/definition',
                    { textDocument: { uri: sourceUri }, position: usage },
                    TIMEOUT
                )
            )
        );
        const expectedDefinitionStart = positionIn(SOURCE, 'takesNumber(value', 0);
        for (const [engine, locations] of [
            ['classic', normalizeLocations(classicDefinition)],
            ['tsgo', normalizeLocations(nativeDefinition)]
        ]) {
            assert.ok(
                locations.some(
                    (location) =>
                        location.uri === sourceUri &&
                        location.range.start.line === expectedDefinitionStart.line
                ),
                `${engine} returned no mapped source definition`
            );
        }
        assert.deepStrictEqual(
            normalizeLocations(nativeDefinition),
            normalizeLocations(classicDefinition)
        );
    } finally {
        classic?.dispose();
        native?.dispose();
        fs.rmSync(project, { recursive: true, force: true });
    }
});
