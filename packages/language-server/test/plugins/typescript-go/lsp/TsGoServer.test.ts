import assert from 'assert';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, it } from 'mocha';
import sinon from 'sinon';
import {
    ConfigurationRequest,
    DidChangeConfigurationNotification,
    DidChangeTextDocumentNotification,
    DidChangeWatchedFilesNotification,
    DidCloseTextDocumentNotification,
    DidOpenTextDocumentNotification,
    FileChangeType,
    InitializeRequest,
    RegistrationRequest,
    TextDocumentSyncKind,
    UnregistrationRequest
} from 'vscode-languageserver-protocol';
import { registerTsOrJsTextSynchronization } from '../../../../src/server';
import { TsGoServer } from '../../../../src/plugins/typescript-go/lsp/TsGoServer';

const engine = {
    packageName: '@test/tsgo',
    version: '1.2.3',
    packageRoot: '/test/tsgo',
    binPath: '/test/tsgo/bin.js',
    command: '/test/node',
    argsPrefix: ['/test/tsgo/bin.js']
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

class FakeProcess extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;

    kill() {
        this.killed = true;
        return true;
    }
}

class FakeConnection {
    readonly notifications: Array<{ method: string; params: any }> = [];
    readonly requests: Array<{ method: string; params: any }> = [];
    readonly handlers = new Map<string, (params: any) => any>();
    disposed = false;

    constructor(
        private readonly initializeResult: any | Promise<any> = {
            capabilities: { positionEncoding: 'utf-16' }
        }
    ) {}

    onRequest(type: any, handler: (params: any) => any) {
        this.handlers.set(methodOf(type), handler);
    }

    sendRequest(type: any, params: any) {
        const method = methodOf(type);
        this.requests.push({ method, params });
        if (method === InitializeRequest.method) {
            return Promise.resolve(this.initializeResult);
        }
        return Promise.resolve(undefined);
    }

    sendNotification(type: any, params: any) {
        this.notifications.push({ method: methodOf(type), params });
    }

    listen() {}

    dispose() {
        this.disposed = true;
    }

    request(type: any, params: any) {
        const handler = this.handlers.get(methodOf(type));
        assert.ok(handler, `missing request handler for ${methodOf(type)}`);
        return handler(params);
    }
}

function methodOf(type: any): string {
    return typeof type === 'string' ? type : type.method;
}

function setup(connections: FakeConnection[], options: Record<string, unknown> = {}) {
    const processes = connections.map(() => new FakeProcess());
    let index = 0;
    const spawnProcess = sinon.stub().callsFake(() => processes[index++] as any);
    const server = new TsGoServer({
        engine,
        workspacePath: '/workspace',
        spawnProcess: spawnProcess as any,
        createConnection: (process) => connections[processes.indexOf(process as any)] as any,
        ...options
    });
    return { server, processes, spawnProcess };
}

function notifications(connection: FakeConnection, type: any) {
    return connection.notifications.filter(({ method }) => method === methodOf(type));
}

describe('typescript-go TsGoServer lifecycle', () => {
    it('registers standard incremental synchronization for every TS-family language id', async () => {
        let params: any;
        const register = sinon.stub().callsFake(async (registrations: any) => {
            params = registrations.asRegistrationParams();
            return { dispose() {} };
        });

        await registerTsOrJsTextSynchronization({ client: { register } } as any);

        sinon.assert.calledOnce(register);
        assert.deepStrictEqual(
            params.registrations.map((registration: any) => registration.method),
            [
                DidOpenTextDocumentNotification.method,
                DidChangeTextDocumentNotification.method,
                DidCloseTextDocumentNotification.method
            ]
        );
        const expectedSelector = [
            { scheme: 'file', language: 'typescript' },
            { scheme: 'file', language: 'typescriptreact' },
            { scheme: 'file', language: 'javascript' },
            { scheme: 'file', language: 'javascriptreact' }
        ];
        for (const registration of params.registrations) {
            assert.deepStrictEqual(registration.registerOptions.documentSelector, expectedSelector);
        }
        assert.strictEqual(
            params.registrations[1].registerOptions.syncKind,
            TextDocumentSyncKind.Incremental
        );
    });

    it('requires UTF-16 and bridges configuration plus watched-file registrations', async () => {
        const connection = new FakeConnection();
        const registered: any[] = [];
        const { server, spawnProcess } = setup([connection], {
            getConfiguration: () => ({
                preferences: { quoteStyle: 'single', importModuleSpecifierEnding: 'js' },
                suggest: { autoImports: false },
                inlayHints: { parameterNames: { enabled: 'all' } }
            }),
            onDidRegisterWatchers: (watchers: any[]) => registered.push(...watchers)
        });

        await server.start();

        sinon.assert.calledWithExactly(
            spawnProcess,
            '/test/node',
            ['/test/tsgo/bin.js', '--lsp', '-stdio'],
            { cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const initialize = connection.requests.find(
            ({ method }) => method === InitializeRequest.method
        );
        assert.deepStrictEqual(initialize?.params.capabilities.general.positionEncodings, [
            'utf-16'
        ]);
        assert.deepStrictEqual(initialize?.params.capabilities.textDocument.publishDiagnostics, {
            relatedInformation: true
        });
        assert.strictEqual(initialize?.params.capabilities.workspace.workspaceFolders, true);
        assert.strictEqual(initialize?.params.capabilities.window.workDoneProgress, true);
        assert.deepStrictEqual(initialize?.params.capabilities.workspace.didChangeWatchedFiles, {
            dynamicRegistration: true,
            relativePatternSupport: true
        });
        assert.deepStrictEqual(initialize?.params.capabilities.textDocument.synchronization, {
            dynamicRegistration: true,
            didSave: true
        });
        for (const capability of [
            'documentSymbol',
            'foldingRange',
            'selectionRange',
            'callHierarchy'
        ]) {
            assert.ok(
                initialize?.params.capabilities.textDocument[capability],
                `${capability} client capability was not advertised`
            );
        }

        const [configuration] = await connection.request(ConfigurationRequest.type, {
            items: [{ section: 'typescript', scopeUri: 'file:///workspace/a.ts' }]
        });
        assert.strictEqual(configuration.preferences.quoteStyle, 'single');
        assert.strictEqual(configuration.preferences.importModuleSpecifierEnding, 'js');
        assert.strictEqual(configuration.suggest.autoImports, false);
        assert.deepStrictEqual(configuration.inlayHints, {
            parameterNames: { enabled: 'all' }
        });
        const [shadowConfiguration] = await connection.request(ConfigurationRequest.type, {
            items: [
                {
                    section: 'typescript',
                    scopeUri:
                        'file:///workspace/node_modules/.cache/svelte-lsp/svelte/src/Comp.svelte.tsx'
                }
            ]
        });
        assert.strictEqual(shadowConfiguration.preferences.importModuleSpecifierEnding, 'index');

        const registration = {
            registrations: [
                {
                    id: 'watch-ts',
                    method: DidChangeWatchedFilesNotification.method,
                    registerOptions: { watchers: [{ globPattern: '**/*.ts', kind: 7 }] }
                },
                { id: 'other', method: 'workspace/other' }
            ]
        };
        await connection.request(RegistrationRequest.type, registration);
        await connection.request(RegistrationRequest.type, registration);
        assert.deepStrictEqual(registered, [{ globPattern: '**/*.ts', kind: 7 }]);

        const generation = server.generation;
        await server.notifyWatchedFiles([
            { uri: 'file:///workspace/a.ts', type: FileChangeType.Changed }
        ]);
        assert.strictEqual(server.generation, generation + 1);
        assert.deepStrictEqual(
            notifications(connection, DidChangeWatchedFilesNotification.type).at(-1)?.params,
            { changes: [{ uri: 'file:///workspace/a.ts', type: FileChangeType.Changed }] }
        );
        const watchedCount = notifications(
            connection,
            DidChangeWatchedFilesNotification.type
        ).length;
        await server.notifyWatchedFiles([
            { uri: 'file:///workspace/a.svelte', type: FileChangeType.Changed }
        ]);
        assert.strictEqual(
            notifications(connection, DidChangeWatchedFilesNotification.type).length,
            watchedCount,
            'events outside the child registration are not forwarded'
        );

        await connection.request(UnregistrationRequest.type, {
            unregisterations: [{ id: 'watch-ts', method: DidChangeWatchedFilesNotification.method }]
        });
        await server.notifyWatchedFiles([
            { uri: 'file:///workspace/a.ts', type: FileChangeType.Changed }
        ]);
        assert.strictEqual(
            notifications(connection, DidChangeWatchedFilesNotification.type).length,
            watchedCount,
            'an unregistered child watcher must stop matching outer events'
        );

        await connection.request(RegistrationRequest.type, registration);
        assert.deepStrictEqual(
            registered,
            [{ globPattern: '**/*.ts', kind: 7 }],
            're-registering an already-installed outer watcher must not duplicate it'
        );
        await server.notifyWatchedFiles([
            { uri: 'file:///workspace/a.ts', type: FileChangeType.Changed }
        ]);
        assert.strictEqual(
            notifications(connection, DidChangeWatchedFilesNotification.type).length,
            watchedCount + 1
        );

        await Promise.all([server.updateConfiguration(), server.updateConfiguration()]);
        assert.deepStrictEqual(
            notifications(connection, DidChangeConfigurationNotification.type).at(-1)?.params,
            { settings: {} }
        );
        assert.strictEqual(
            notifications(connection, DidChangeConfigurationNotification.type).length,
            1
        );
        server.dispose();
    });

    it('publishes every desired overlay in one generation after the startup barrier', async () => {
        const publication = deferred<void>();
        const connection = new FakeConnection();
        const beforeStart = sinon.stub().callsFake(() => publication.promise);
        const { server, spawnProcess } = setup([connection], { beforeStart });

        const first = server.openDocument(
            '/workspace/First.svelte.tsx',
            'export const first = true;'
        );
        const second = server.openDocument(
            '/workspace/Second.svelte.tsx',
            'export const second = true;'
        );
        await Promise.resolve();

        assert.strictEqual(spawnProcess.callCount, 0, 'the child observed a partial project graph');
        assert.strictEqual(server.openDocumentCount, 2, 'desired overlays were not retained');
        assert.strictEqual(server.childOpenDocumentCount, 0);
        assert.strictEqual(server.generation, 0);

        publication.resolve();
        await Promise.all([first, second]);

        sinon.assert.calledOnce(beforeStart);
        sinon.assert.calledOnce(spawnProcess);
        assert.strictEqual(
            server.generation,
            1,
            'the initial batch advanced more than one generation'
        );
        assert.strictEqual(server.openDocumentCount, 2);
        assert.strictEqual(server.childOpenDocumentCount, 2);
        assert.deepStrictEqual(
            notifications(connection, DidOpenTextDocumentNotification.type).map(
                ({ params }) => params.textDocument.uri
            ),
            ['file:///workspace/First.svelte.tsx', 'file:///workspace/Second.svelte.tsx']
        );
        server.dispose();
    });

    it('does not spawn after a publication failure and starts after a successful retry', async () => {
        const failure = new Error('project publication failed');
        const connection = new FakeConnection();
        let attempts = 0;
        const beforeStart = sinon.stub().callsFake(async () => {
            if (attempts++ === 0) {
                throw failure;
            }
        });
        const { server, spawnProcess } = setup([connection], { beforeStart });
        const file = '/workspace/Component.svelte.tsx';
        const text = 'export default class Component {}';

        await assert.rejects(server.openDocument(file, text), failure);
        sinon.assert.notCalled(spawnProcess);
        assert.strictEqual(server.generation, 0);
        assert.strictEqual(server.openDocumentCount, 1, 'retry intent was not retained');
        assert.strictEqual(server.childOpenDocumentCount, 0);

        await server.openDocument(file, text);
        sinon.assert.calledTwice(beforeStart);
        sinon.assert.calledOnce(spawnProcess);
        assert.strictEqual(server.generation, 1);
        assert.strictEqual(server.openDocumentCount, 1);
        assert.strictEqual(server.childOpenDocumentCount, 1);
        assert.strictEqual(
            notifications(connection, DidOpenTextDocumentNotification.type).length,
            1
        );
        server.dispose();
    });

    it('waits for active requests before restart and sends queued work to the new child', async () => {
        const first = new FakeConnection();
        const second = new FakeConnection();
        const response = deferred<{ ok: true }>();
        const sendFirst = first.sendRequest.bind(first);
        first.sendRequest = ((type: any, params: any) => {
            if (methodOf(type) === 'textDocument/hover') {
                first.requests.push({ method: methodOf(type), params });
                return response.promise;
            }
            return sendFirst(type, params);
        }) as any;
        const { server, processes } = setup([first, second]);
        await server.start();

        const active = server.sendRequest<{ ok: true }>('textDocument/hover', { position: 1 });
        await Promise.resolve();
        const restarting = server.restart();
        const queued = server.sendRequest('textDocument/definition', { position: 2 });
        await Promise.resolve();
        assert.strictEqual(processes[0].killed, false, 'active request child was killed early');
        assert.ok(
            !first.requests.some(({ method }) => method === 'textDocument/definition'),
            'new work leaked to the retiring child'
        );

        response.resolve({ ok: true });
        assert.deepStrictEqual(await active, { ok: true });
        await restarting;
        await queued;
        assert.strictEqual(processes[0].killed, true);
        assert.ok(
            second.requests.some(({ method }) => method === 'textDocument/definition'),
            'queued request did not reach the replacement child'
        );
        server.dispose();
    });

    it('rejects an unsupported child position encoding without crashing the host', async () => {
        const connection = new FakeConnection({
            capabilities: { positionEncoding: 'utf-8' }
        });
        const { server, processes } = setup([connection]);

        await assert.rejects(server.start(), /unsupported position encoding utf-8/);

        assert.strictEqual(connection.disposed, true);
        assert.strictEqual(processes[0].killed, true);
        server.dispose();
    });

    it('turns an asynchronous spawn error into a rejected start', async () => {
        const never = new Promise(() => {});
        const connection = new FakeConnection(never);
        const { server, processes } = setup([connection]);

        const starting = server.start();
        await Promise.resolve();
        const error = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
        processes[0].emit('error', error);

        await assert.rejects(starting, /spawn EACCES/);
        assert.strictEqual(connection.disposed, true);
        server.dispose();
    });

    it('cleans up a rejected initialization attempt before retrying', async () => {
        const initialize = deferred<any>();
        const first = new FakeConnection(initialize.promise);
        const second = new FakeConnection();
        const { server, processes, spawnProcess } = setup([first, second]);

        const starting = server.start();
        initialize.reject(new Error('initialize request failed'));
        await assert.rejects(starting, /initialize request failed/);

        assert.strictEqual(first.disposed, true);
        assert.strictEqual(processes[0].killed, true);
        await server.start();
        assert.strictEqual(spawnProcess.callCount, 2);
        assert.strictEqual(second.disposed, false);
        server.dispose();
    });

    it('times out a stalled initialization, terminates its child and permits retry', async () => {
        const never = new Promise(() => {});
        const first = new FakeConnection(never);
        const second = new FakeConnection();
        const { server, processes, spawnProcess } = setup([first, second], {
            initializationTimeoutMs: 20
        });

        await assert.rejects(server.start(), /initialize request timed out after 20ms/);

        assert.strictEqual(first.disposed, true);
        assert.strictEqual(processes[0].killed, true);
        await server.start();
        assert.strictEqual(spawnProcess.callCount, 2);
        assert.strictEqual(second.disposed, false);
        server.dispose();
    });

    it('rejects a malformed position encoding and cleans up the child', async () => {
        const connection = new FakeConnection({
            capabilities: { positionEncoding: { kind: 'utf-16' } }
        });
        const { server, processes } = setup([connection]);

        await assert.rejects(server.start(), /non-string position encoding/);

        assert.strictEqual(connection.disposed, true);
        assert.strictEqual(processes[0].killed, true);
        server.dispose();
    });

    it('replays a crashed document once with its language id and latest text', async () => {
        const first = new FakeConnection();
        const second = new FakeConnection();
        const { server, processes } = setup([first, second]);
        const file = '/workspace/source.ts';

        await server.openDocument(file, 'export const value = 1;', 'typescript');
        assert.strictEqual(notifications(first, DidOpenTextDocumentNotification.type).length, 1);
        assert.strictEqual(
            notifications(first, DidOpenTextDocumentNotification.type)[0].params.textDocument
                .languageId,
            'typescript'
        );

        await server.updateDocument(
            file,
            [{ text: 'export const value = 2;' }],
            'export const value = 2;'
        );
        assert.strictEqual(notifications(first, DidChangeTextDocumentNotification.type).length, 1);
        processes[0].emit('exit', 1, null);

        // This is the sync path which previously awaited replay and then sent a second didOpen.
        await server.openDocument(file, 'export const value = 2;', 'typescript');

        const replay = notifications(second, DidOpenTextDocumentNotification.type);
        assert.strictEqual(replay.length, 1);
        assert.deepStrictEqual(replay[0].params.textDocument, {
            uri: 'file:///workspace/source.ts',
            languageId: 'typescript',
            version: 1,
            text: 'export const value = 2;'
        });
        assert.strictEqual(notifications(second, DidChangeTextDocumentNotification.type).length, 0);
        server.dispose();
    });

    it('coalesces concurrent first opens to one didOpen with the newest text', async () => {
        const initialize = deferred<any>();
        const connection = new FakeConnection(initialize.promise);
        const { server } = setup([connection]);
        const file = '/workspace/source.ts';

        const stale = server.openDocument(file, 'export const value = 1;', 'typescript');
        const latest = server.openDocument(file, 'export const value = 2;', 'typescript');
        initialize.resolve({ capabilities: { positionEncoding: 'utf-16' } });
        await Promise.all([stale, latest]);

        const opened = notifications(connection, DidOpenTextDocumentNotification.type);
        assert.strictEqual(opened.length, 1);
        assert.strictEqual(opened[0].params.textDocument.text, 'export const value = 2;');
        assert.strictEqual(
            notifications(connection, DidChangeTextDocumentNotification.type).length,
            0
        );
        assert.strictEqual(server.getOpenText(file), 'export const value = 2;');
        server.dispose();
    });

    it('retains a changed language id when the text is identical', async () => {
        const connection = new FakeConnection();
        const { server } = setup([connection]);
        const file = '/workspace/source.ts';
        const text = 'export const value = 1;';

        await server.openDocument(file, text, 'typescript');
        await server.updateDocument(file, [], text, 'javascript');

        assert.strictEqual(
            notifications(connection, DidChangeTextDocumentNotification.type).length,
            0
        );
        assert.strictEqual(
            notifications(connection, DidCloseTextDocumentNotification.type).length,
            1
        );
        const opened = notifications(connection, DidOpenTextDocumentNotification.type);
        assert.strictEqual(opened.length, 2);
        assert.strictEqual(opened.at(-1)?.params.textDocument.languageId, 'javascript');
        server.dispose();
    });

    it('deliberately restarts and replays only current overlays', async () => {
        const first = new FakeConnection();
        const second = new FakeConnection();
        let restarts = 0;
        const { server, processes } = setup([first, second], {
            onRestart: () => restarts++
        });

        await server.openDocument('/workspace/open.ts', 'export const value = 1;', 'typescript');
        await server.openDocument('/workspace/closed.ts', 'old', 'typescript');
        await server.closeDocument('/workspace/closed.ts');
        await server.restart();

        assert.strictEqual(processes[0].killed, true);
        assert.strictEqual(restarts, 1);
        assert.deepStrictEqual(
            notifications(second, DidOpenTextDocumentNotification.type).map(
                ({ params }) => params.textDocument.uri
            ),
            ['file:///workspace/open.ts']
        );
        assert.strictEqual(server.openDocumentCount, 1);
        assert.strictEqual(server.childOpenDocumentCount, 1);
        server.dispose();
    });

    it('returns to the overlay baseline after 200 open-close cycles', async () => {
        const connection = new FakeConnection();
        const { server } = setup([connection]);
        await server.start();
        const baseline = server.openDocumentCount;
        const childBaseline = server.childOpenDocumentCount;

        for (let index = 0; index < 200; index++) {
            const file = `/workspace/cycle-${index}.tsx`;
            await server.openDocument(file, `export const n = ${index};`);
            await server.closeDocument(file);
        }

        assert.strictEqual(server.openDocumentCount, baseline);
        assert.strictEqual(server.childOpenDocumentCount, childBaseline);
        assert.strictEqual(
            notifications(connection, DidOpenTextDocumentNotification.type).length,
            200
        );
        assert.strictEqual(
            notifications(connection, DidCloseTextDocumentNotification.type).length,
            200
        );
        server.dispose();
    });
});
