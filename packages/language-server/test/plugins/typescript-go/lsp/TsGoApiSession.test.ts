import assert from 'assert';
import path from 'path';
import { afterEach, describe, it } from 'mocha';
import sinon from 'sinon';
import { TsGoApiSession } from '../../../../src/plugins/typescript-go/lsp/TsGoApiSession';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

const engine = {
    packageName: '@test/tsgo',
    version: '1.2.3',
    packageRoot: '/test/tsgo',
    binPath: '/test/tsgo/bin.js',
    command: '/test/node',
    argsPrefix: ['/test/tsgo/bin.js'],
    apiEntry: path.join(__dirname, '..', 'fixtures', 'fake-tsgo-api.mjs')
};

describe('typescript-go TsGoApiSession lifecycle', () => {
    afterEach(() => {
        delete (globalThis as any).__svelteTsGoTestFromLSPConnection;
    });

    it('cannot let an old API attachment replace the session after reset', async () => {
        const firstAttach = deferred<any>();
        const firstAttachStarted = deferred<void>();
        const firstApi = { close: sinon.stub().resolves() };
        const secondApi = { close: sinon.stub().resolves() };
        (globalThis as any).__svelteTsGoTestFromLSPConnection = ({ pipe }: { pipe: string }) => {
            if (pipe === 'first') {
                firstAttachStarted.resolve();
                return firstAttach.promise;
            }
            return Promise.resolve(secondApi);
        };

        let request = 0;
        const server = {
            generation: 0,
            sendRequest: sinon.stub().callsFake(async () => ({
                pipe: request++ === 0 ? 'first' : 'second'
            }))
        };
        const session = new TsGoApiSession(server as any, engine);

        const oldConnection = session.connect();
        await firstAttachStarted.promise;
        session.reset();

        assert.strictEqual(await session.connect(), true);
        assert.strictEqual((session as any).api, secondApi);

        firstAttach.resolve(firstApi);
        assert.strictEqual(await oldConnection, false);
        sinon.assert.calledOnce(firstApi.close);
        assert.strictEqual((session as any).api, secondApi);

        await session.dispose();
        sinon.assert.calledOnce(secondApi.close);
    });

    it('refreshes again when the server generation moves during a snapshot update', async () => {
        const firstSnapshot = deferred<any>();
        const firstRefreshStarted = deferred<void>();
        const stale = {
            dispose: sinon.stub().resolves(),
            getDefaultProjectForFile: sinon.stub().resolves('stale')
        };
        const fresh = {
            dispose: sinon.stub().resolves(),
            getDefaultProjectForFile: sinon.stub().resolves('fresh')
        };
        const updateSnapshot = sinon.stub();
        updateSnapshot.onFirstCall().callsFake(() => {
            firstRefreshStarted.resolve();
            return firstSnapshot.promise;
        });
        updateSnapshot.onSecondCall().resolves(fresh);
        const api = { updateSnapshot, close: sinon.stub().resolves() };
        (globalThis as any).__svelteTsGoTestFromLSPConnection = () => Promise.resolve(api);

        let generation = 1;
        const server = {
            get generation() {
                return generation;
            },
            sendRequest: sinon.stub().resolves({ pipe: 'session' })
        };
        const session = new TsGoApiSession(server as any, engine);

        const first = session.getProjectForFile('/workspace/Comp.svelte.tsx');
        await firstRefreshStarted.promise;
        generation = 2;
        const second = session.getProjectForFile('/workspace/Comp.svelte.tsx');
        firstSnapshot.resolve(stale);

        assert.deepStrictEqual(await Promise.all([first, second]), ['fresh', 'fresh']);
        sinon.assert.calledTwice(updateSnapshot);
        sinon.assert.calledOnce(stale.dispose);
        sinon.assert.notCalled(stale.getDefaultProjectForFile);
        await session.dispose();
    });
});
