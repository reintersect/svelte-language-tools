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

async function getCheckerCompletions(result: unknown) {
    const checker = {
        getCompletionsAtPosition: sinon.stub().resolves(result)
    };
    const session = new TsGoApiSession({} as any, engine);
    sinon
        .stub(session, 'withProjectForFile')
        .callsFake(async (_fileName: string, operation: (project: any) => unknown) =>
            operation({ checker })
        );

    return session.getCompletionsAtPosition('/workspace/Comp.svelte.tsx', 1);
}

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

        const first = session.warmProjectForFile('/workspace/Comp.svelte.tsx');
        await firstRefreshStarted.promise;
        generation = 2;
        const second = session.warmProjectForFile('/workspace/Comp.svelte.tsx');
        firstSnapshot.resolve(stale);

        assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
        sinon.assert.calledTwice(updateSnapshot);
        sinon.assert.calledOnce(stale.dispose);
        sinon.assert.notCalled(stale.getDefaultProjectForFile);
        sinon.assert.calledOnce(fresh.getDefaultProjectForFile);
        await session.dispose();
    });

    it('keeps a leased snapshot alive but drops its result after the native generation moves', async () => {
        const releaseChecker = deferred<void>();
        const checkerStarted = deferred<void>();
        const firstProject = { checker: {} };
        const secondProject = { checker: {} };
        const firstSnapshot = {
            dispose: sinon.stub().resolves(),
            getDefaultProjectForFile: sinon.stub().resolves(firstProject)
        };
        const secondSnapshot = {
            dispose: sinon.stub().resolves(),
            getDefaultProjectForFile: sinon.stub().resolves(secondProject)
        };
        const updateSnapshot = sinon.stub();
        updateSnapshot.onFirstCall().resolves(firstSnapshot);
        updateSnapshot.onSecondCall().resolves(secondSnapshot);
        const api = { updateSnapshot, close: sinon.stub().resolves() };
        (globalThis as any).__svelteTsGoTestFromLSPConnection = () => Promise.resolve(api);
        let generation = 1;
        const session = new TsGoApiSession(
            {
                get generation() {
                    return generation;
                },
                sendRequest: sinon.stub().resolves({ pipe: 'session' })
            } as any,
            engine
        );

        const first = session.withProjectForFile('/workspace/Comp.svelte.tsx', async (project) => {
            assert.strictEqual(project, firstProject);
            checkerStarted.resolve();
            await releaseChecker.promise;
            return 'first';
        });
        await checkerStarted.promise;
        generation = 2;
        assert.strictEqual(await session.warmProjectForFile('/workspace/Comp.svelte.tsx'), true);
        sinon.assert.notCalled(firstSnapshot.dispose);

        releaseChecker.resolve();
        assert.strictEqual(
            await first,
            undefined,
            'a cross-file generation change must not publish the old checker answer'
        );
        await Promise.resolve();
        sinon.assert.calledOnce(firstSnapshot.dispose);
        await session.dispose();
    });

    it('falls back atomically when any checker completion entry is malformed', async () => {
        assert.strictEqual(
            await getCheckerCompletions({
                isIncomplete: false,
                entries: [
                    { name: 'valid', kind: 10, sortText: '11' },
                    { name: 'broken', kind: 10, sortText: 11 }
                ]
            }),
            undefined
        );
    });

    for (const [name, completion] of [
        ['missing isIncomplete', { entries: [] }],
        ['non-boolean isIncomplete', { isIncomplete: 'false', entries: [] }],
        [
            'array-shaped completion response',
            Object.assign([], { isIncomplete: false, entries: [] })
        ],
        [
            'array-shaped label details',
            { isIncomplete: false, entries: [{ name: 'value', labelDetails: [] }] }
        ],
        [
            'kind below the LSP range',
            { isIncomplete: false, entries: [{ name: 'value', kind: 0 }] }
        ],
        [
            'kind above the LSP range',
            { isIncomplete: false, entries: [{ name: 'value', kind: 26 }] }
        ],
        [
            'non-integral completion kind',
            { isIncomplete: false, entries: [{ name: 'value', kind: 1.5 }] }
        ]
    ] as const) {
        it(`rejects ${name}`, async () => {
            assert.strictEqual(await getCheckerCompletions(completion), undefined);
        });
    }

    it('accepts the complete serialisable subset and LSP kind boundaries', async () => {
        const result = await getCheckerCompletions({
            isIncomplete: true,
            isNewIdentifierLocation: false,
            defaultCommitCharacters: ['.'],
            entries: [
                {
                    name: 'first',
                    kind: 1,
                    sortText: '10',
                    labelDetails: { detail: ' detail', description: 'source' },
                    commitCharacters: ['.'],
                    ignoredNativeHandle: { id: 1 }
                },
                { name: 'last', kind: 25 }
            ]
        });

        assert.deepStrictEqual(result, {
            isIncomplete: true,
            isNewIdentifierLocation: false,
            defaultCommitCharacters: ['.'],
            entries: [
                {
                    name: 'first',
                    kind: 1,
                    sortText: '10',
                    labelDetails: { detail: ' detail', description: 'source' },
                    commitCharacters: ['.']
                },
                { name: 'last', kind: 25 }
            ],
            timings: {
                projectMs: result?.timings.projectMs,
                checkerMs: result?.timings.checkerMs
            }
        });
    });
});
