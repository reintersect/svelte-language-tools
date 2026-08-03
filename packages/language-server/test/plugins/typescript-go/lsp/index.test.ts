import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stub } from 'sinon';
import { Document, DocumentManager } from '../../../../src/lib/documents';
import { Logger } from '../../../../src/logger';
import { pathToUrl } from '../../../../src/utils';
import {
    createTsGoBackedPlugin,
    createTsGoPlugin,
    TsGoBatchOverlay
} from '../../../../src/plugins/typescript-go/lsp';
import { invalidateTsGoWorkspaceIndex } from '../../../../src/plugins/typescript-go/lsp/ShadowManager';
import { TSGO_COMPLETION_DEFERRED } from '../../../../src/plugins/typescript-go/lsp/TsGoPlugin';

const bundledSvelteRoot = path.dirname(require.resolve('svelte/package.json'));

describe('typescript-go completion composition', () => {
    it('uses classic only while tsgo is materialising and routes resolve to its owner', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        let classicCompletions = 0;
        let classicResolves = 0;
        let tsGoResolves = 0;
        const classic = {
            __name: 'ts',
            async getCompletions() {
                classicCompletions++;
                return {
                    isIncomplete: false,
                    items: [{ label: 'value', data: { uri: document.uri, name: 'value' } }]
                };
            },
            async resolveCompletion(_document: Document, item: any) {
                classicResolves++;
                assert.deepStrictEqual(item.data, { uri: document.uri, name: 'value' });
                return { ...item, detail: 'classic detail' };
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            async getCompletionsIfReady() {
                return TSGO_COMPLETION_DEFERRED;
            },
            async resolveCompletion() {
                tsGoResolves++;
                throw new Error('classic completion must not resolve through tsgo');
            }
        } as any;
        const plugin = createTsGoBackedPlugin(classic, tsgo);

        const list = await plugin.getCompletions!(document, document.positionAt(12));
        assert.strictEqual(plugin.__name, 'tsgo');
        assert.strictEqual(classicCompletions, 1);
        assert.strictEqual((list!.items[0].data as any).__svelteCompletionOwner, 'classic');

        const resolved = await plugin.resolveCompletion!(document, list!.items[0]);
        assert.strictEqual(resolved.detail, 'classic detail');
        assert.strictEqual(classicResolves, 1);
        assert.strictEqual(tsGoResolves, 0);
        assert.strictEqual((resolved.data as any).__svelteCompletionOwner, 'classic');
    });

    it('does not resolve classic or tsgo completion items after their source revision changes', async () => {
        for (const owner of ['classic', 'tsgo'] as const) {
            for (const mutation of ['version', 'fingerprint'] as const) {
                const uri = pathToUrl(`/workspace/${owner}-${mutation}.svelte`);
                const documents = new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                );
                const document = documents.openClientDocument({
                    uri,
                    text: '<script>const value = targ;</script>'
                });
                let classicResolves = 0;
                let tsgoResolves = 0;
                const classic = {
                    __name: 'ts',
                    async getCompletions() {
                        return { items: [{ label: 'target', data: { classic: true } }] };
                    },
                    async resolveCompletion() {
                        classicResolves++;
                        return { label: 'stale classic edit' };
                    }
                } as any;
                const tsgo = {
                    __name: 'tsgo',
                    stats: {},
                    async getCompletionsIfReady() {
                        return owner === 'classic'
                            ? TSGO_COMPLETION_DEFERRED
                            : { items: [{ label: 'target', data: { tsgo: true } }] };
                    },
                    async resolveCompletion() {
                        tsgoResolves++;
                        return { label: 'stale tsgo edit' };
                    }
                } as any;
                const plugin = createTsGoBackedPlugin(classic, tsgo);
                const listed = await plugin.getCompletions!(
                    document,
                    document.positionAt(document.getText().indexOf('targ') + 4)
                );
                const item = listed!.items[0];

                if (mutation === 'version') {
                    documents.updateDocument({ uri, version: 2 }, [
                        { text: '<script>const changed = target;</script>' }
                    ]);
                } else {
                    const version = document.version;
                    // Simulate a host which mutates its buffer without advancing the optional LSP
                    // version. The content fingerprint is an independent fail-closed guard.
                    document.content = '<script>const changed = target;</script>';
                    assert.strictEqual(document.version, version, 'fixture must isolate text hash');
                }

                assert.strictEqual(await plugin.resolveCompletion!(document, item), item);
                assert.strictEqual(classicResolves, 0, `${owner}/${mutation} reached classic`);
                assert.strictEqual(tsgoResolves, 0, `${owner}/${mutation} reached tsgo`);
                plugin.dispose?.();
            }
        }
    });

    it('drops a classic resolve result when the document changes during the request', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/DeferredClassic.svelte'),
            '<script>const value = targ;</script>'
        );
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => (resolveStarted = resolve));
        let finishResolve!: (value: any) => void;
        const nativeResolve = new Promise<any>((resolve) => (finishResolve = resolve));
        const classic = {
            __name: 'ts',
            async getCompletions() {
                return { items: [{ label: 'target', data: { name: 'target' } }] };
            },
            async resolveCompletion() {
                resolveStarted();
                return nativeResolve;
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            async getCompletionsIfReady() {
                return TSGO_COMPLETION_DEFERRED;
            }
        } as any;
        const plugin = createTsGoBackedPlugin(classic, tsgo);
        const listed = await plugin.getCompletions!(
            document,
            document.positionAt(document.getText().indexOf('targ') + 4)
        );
        const item = listed!.items[0];

        const pending = plugin.resolveCompletion!(document, item);
        await started;
        document.setText('<script>const changed = target;</script>');
        finishResolve({
            label: 'target',
            additionalTextEdits: [
                {
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 0 }
                    },
                    newText: 'import { target } from "./target";\n'
                }
            ]
        });

        assert.strictEqual(await pending, item);
        plugin.dispose?.();
    });

    it('does not wake classic for unsupported or tsgo-ready completion contexts', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        let classicCompletions = 0;
        const classic = {
            __name: 'ts',
            async getCompletions() {
                classicCompletions++;
                return { isIncomplete: false, items: [{ label: 'classic' }] };
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            result: null as any,
            async getCompletionsIfReady() {
                return this.result;
            }
        } as any;
        const plugin = createTsGoBackedPlugin(classic, tsgo);

        assert.strictEqual(
            await plugin.getCompletions!(document, document.positionAt(12)),
            null,
            'a cheap unsupported-context null must stay null'
        );
        tsgo.result = { isIncomplete: false, items: [{ label: 'value' }] };
        const list = await plugin.getCompletions!(document, document.positionAt(12));
        assert.strictEqual(list!.items[0].label, 'value');
        assert.strictEqual((list!.items[0].data as any).__svelteCompletionOwner, 'tsgo');
        assert.strictEqual(classicCompletions, 0);
    });

    it('constructs a lazy classic owner only for a valid cold deferral and reuses it', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        let factoryCalls = 0;
        let classicCompletions = 0;
        const classic = {
            __name: 'ts',
            async getCompletions() {
                classicCompletions++;
                return { isIncomplete: false, items: [{ label: 'classic' }] };
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            result: null as any,
            async getCompletionsIfReady() {
                return this.result;
            }
        } as any;
        const plugin = createTsGoBackedPlugin({ __name: 'tsgo' }, tsgo, async () => {
            factoryCalls++;
            await Promise.resolve();
            return classic;
        });

        assert.strictEqual(await plugin.getCompletions!(document, document.positionAt(12)), null);
        assert.strictEqual(factoryCalls, 0, 'unsupported contexts must remain zero-fallback work');
        tsgo.result = { isIncomplete: false, items: [{ label: 'native' }] };
        assert.strictEqual(
            (await plugin.getCompletions!(document, document.positionAt(12)))!.items[0].label,
            'native'
        );
        assert.strictEqual(factoryCalls, 0, 'native-ready contexts must not construct classic');

        tsgo.result = TSGO_COMPLETION_DEFERRED;
        for (let index = 0; index < 2; index++) {
            const list = await plugin.getCompletions!(document, document.positionAt(12));
            assert.strictEqual(list!.items[0].label, 'classic');
        }
        assert.strictEqual(factoryCalls, 1);
        assert.strictEqual(classicCompletions, 2);
    });

    it('drops lazy classic lists when the source changes during construction or completion', async () => {
        for (const stage of ['factory', 'completion'] as const) {
            const document = Document.createForTest(
                pathToUrl(`/workspace/Lazy-${stage}.svelte`),
                '<script>const value = targ;</script>'
            );
            let stageStarted!: () => void;
            const started = new Promise<void>((resolve) => (stageStarted = resolve));
            let finishStage!: () => void;
            const gate = new Promise<void>((resolve) => (finishStage = resolve));
            let classicCompletions = 0;
            const classic = {
                __name: 'ts',
                async getCompletions() {
                    classicCompletions++;
                    if (stage === 'completion') {
                        stageStarted();
                        await gate;
                    }
                    return { isIncomplete: false, items: [{ label: 'stale-classic' }] };
                }
            } as any;
            const tsgo = {
                __name: 'tsgo',
                stats: {},
                async getCompletionsIfReady() {
                    return TSGO_COMPLETION_DEFERRED;
                }
            } as any;
            const plugin = createTsGoBackedPlugin({ __name: 'tsgo' }, tsgo, async () => {
                if (stage === 'factory') {
                    stageStarted();
                    await gate;
                }
                return classic;
            });

            const pending = plugin.getCompletions!(
                document,
                document.positionAt(document.getText().indexOf('targ') + 4)
            );
            await started;
            document.setText('<script>const replacement = target;</script>');
            finishStage();

            assert.strictEqual(
                await pending,
                null,
                `${stage} must not stamp an old request with the post-edit identity`
            );
            assert.strictEqual(
                classicCompletions,
                stage === 'factory' ? 0 : 1,
                `${stage} should stop at the first stale boundary`
            );
            plugin.dispose?.();
        }
    });

    it('forwards native text lifecycle synchronously and serializes classic mirroring', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        const nativeEvents: string[] = [];
        const classicEvents: string[] = [];
        let factoryStarted!: () => void;
        let finishFactory!: () => void;
        const started = new Promise<void>((resolve) => (factoryStarted = resolve));
        const factoryGate = new Promise<void>((resolve) => (finishFactory = resolve));
        const classic = {
            __name: 'ts',
            async updateTsOrJsFile(fileName: string, changes: any[]) {
                await Promise.resolve();
                classicEvents.push(`update:${fileName}:${changes[0].text}`);
            },
            async closeTsOrJsFile(fileName: string) {
                await Promise.resolve();
                classicEvents.push(`close:${fileName}`);
            },
            async onWatchFileChanges() {
                await Promise.resolve();
                classicEvents.push('watch');
            },
            async getCompletions() {
                classicEvents.push('completion');
                return { isIncomplete: false, items: [{ label: 'classic' }] };
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            async getCompletionsIfReady() {
                return TSGO_COMPLETION_DEFERRED;
            },
            openTsOrJsFile(fileName: string) {
                nativeEvents.push(`open:${fileName}`);
            },
            updateTsOrJsFile(fileName: string) {
                nativeEvents.push(`update:${fileName}`);
            },
            closeTsOrJsFile(fileName: string) {
                nativeEvents.push(`close:${fileName}`);
            },
            onWatchFileChanges() {
                nativeEvents.push('watch');
            }
        } as any;
        const plugin = createTsGoBackedPlugin({ __name: 'tsgo' }, tsgo, async () => {
            factoryStarted();
            await factoryGate;
            return classic;
        });

        const completion = plugin.getCompletions!(document, document.positionAt(12));
        await started;
        plugin.openTsOrJsFile!('/workspace/model.ts', 'one', 'typescript', 1);
        plugin.updateTsOrJsFile!('/workspace/model.ts', [{ text: 'two' }], 'two', 2, 'typescript');
        plugin.closeTsOrJsFile!('/workspace/model.ts');
        plugin.onWatchFileChanges!([]);

        assert.deepStrictEqual(nativeEvents, [
            'open:/workspace/model.ts',
            'update:/workspace/model.ts',
            'close:/workspace/model.ts',
            'watch'
        ]);
        assert.deepStrictEqual(
            classicEvents,
            [],
            'void PluginHost fanout must never block on fallback construction'
        );

        finishFactory();
        const result = await completion;
        assert.strictEqual(result!.items[0].label, 'classic');
        assert.deepStrictEqual(classicEvents, [
            'update:/workspace/model.ts:one',
            'update:/workspace/model.ts:two',
            'close:/workspace/model.ts',
            'watch',
            'completion'
        ]);
    });

    it('disposes a late fallback without serving it after shutdown', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        let nativeDisposals = 0;
        let classicDisposals = 0;
        let classicCompletions = 0;
        let factoryStarted!: () => void;
        let finishFactory!: () => void;
        const started = new Promise<void>((resolve) => (factoryStarted = resolve));
        const factoryGate = new Promise<void>((resolve) => (finishFactory = resolve));
        const classic = {
            __name: 'ts',
            dispose() {
                classicDisposals++;
            },
            async getCompletions() {
                classicCompletions++;
                return { isIncomplete: false, items: [{ label: 'too late' }] };
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            dispose() {
                nativeDisposals++;
            },
            async getCompletionsIfReady() {
                return TSGO_COMPLETION_DEFERRED;
            }
        } as any;
        const plugin = createTsGoBackedPlugin({ __name: 'tsgo' }, tsgo, async () => {
            factoryStarted();
            await factoryGate;
            return classic;
        });

        const completion = plugin.getCompletions!(document, document.positionAt(12));
        await started;
        plugin.dispose!();
        plugin.dispose!();
        finishFactory();

        assert.strictEqual(await completion, null);
        assert.strictEqual(nativeDisposals, 1);
        assert.strictEqual(classicDisposals, 1);
        assert.strictEqual(classicCompletions, 0);
    });

    it('returns an incomplete retry when a caller explicitly disables cold fallback', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        let classicCompletions = 0;
        let activeLeases = 0;
        const classic = {
            __name: 'ts',
            async getCompletions() {
                classicCompletions++;
                throw new Error('the disabled classic project must stay asleep');
            }
        } as any;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            acquireCompletionPriority() {
                activeLeases++;
                return () => activeLeases--;
            },
            async getCompletionsIfReady() {
                return TSGO_COMPLETION_DEFERRED;
            }
        } as any;
        const plugin = createTsGoBackedPlugin(classic, tsgo, null);

        assert.deepStrictEqual(await plugin.getCompletions!(document, document.positionAt(12)), {
            isIncomplete: true,
            items: []
        });
        assert.strictEqual(classicCompletions, 0);
        assert.strictEqual(activeLeases, 0);
    });

    it('releases completion priority when a completion request fails', async () => {
        const document = Document.createForTest(
            pathToUrl('/workspace/Component.svelte'),
            '<p>{model.va}</p>'
        );
        let activeLeases = 0;
        const tsgo = {
            __name: 'tsgo',
            stats: {},
            acquireCompletionPriority() {
                activeLeases++;
                return () => activeLeases--;
            },
            async getCompletionsIfReady() {
                throw new Error('completion failed');
            }
        } as any;
        const plugin = createTsGoBackedPlugin({ __name: 'unused' }, tsgo, null);

        await assert.rejects(
            async () => plugin.getCompletions!(document, document.positionAt(12)),
            /completion failed/
        );
        assert.strictEqual(activeLeases, 0);
    });
});

describe('typescript-go setup', () => {
    it('does not resolve or read a workspace engine when the workspace is untrusted', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-untrusted-tsgo-'));
        const packageRoot = path.join(root, 'node_modules', '@malicious', 'workspace-tsgo');
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'package.json'),
            JSON.stringify({
                name: '@malicious/workspace-tsgo',
                version: '1.0.0',
                bin: { tsgo: './steal-workspace-data.js' }
            })
        );
        fs.writeFileSync(path.join(packageRoot, 'steal-workspace-data.js'), 'throw new Error();');

        const previousPackage = process.env.SVELTE_LS_TSGO_PACKAGE;
        process.env.SVELTE_LS_TSGO_PACKAGE = '@malicious/workspace-tsgo';
        const originalReadFileSync = fs.readFileSync;
        const workspaceReads: string[] = [];
        const readStub = stub(fs, 'readFileSync').callsFake(((
            fileName: fs.PathLike,
            ...args: any[]
        ) => {
            const candidate = String(fileName);
            if (candidate.startsWith(root)) {
                workspaceReads.push(candidate);
            }
            return (originalReadFileSync as any)(fileName, ...args);
        }) as typeof fs.readFileSync);
        const errorStub = stub(Logger, 'error');

        try {
            const result = createTsGoPlugin({
                workspacePath: root,
                isTrusted: false,
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                )
            });

            assert.strictEqual(result, undefined);
            assert.deepStrictEqual(workspaceReads, []);
            assert.match(String(errorStub.firstCall?.args[0]), /untrusted workspace/);
        } finally {
            readStub.restore();
            errorStub.restore();
            if (previousPackage === undefined) {
                delete process.env.SVELTE_LS_TSGO_PACKAGE;
            } else {
                process.env.SVELTE_LS_TSGO_PACKAGE = previousPackage;
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('shares the checker graph-plan boundary with editor project creation', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-ls-editor-plan-'));
        const source = path.join(root, 'src/main.ts');
        const controls = path.join(root, 'node_modules/controls');
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.mkdirSync(controls, { recursive: true });
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({
                name: 'editor-plan-fixture',
                private: true,
                dependencies: { controls: '1.0.0' }
            })
        );
        fs.writeFileSync(
            path.join(root, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler'
                },
                include: ['src/**/*']
            })
        );
        fs.writeFileSync(source, 'import Controls from "controls"; void Controls;\n');
        fs.writeFileSync(
            path.join(controls, 'package.json'),
            JSON.stringify({ name: 'controls', version: '1.0.0', main: './index.js' })
        );
        fs.writeFileSync(
            path.join(controls, 'index.js'),
            'const target = "./Button.svelte"; module.exports = require(target);\n'
        );
        fs.writeFileSync(path.join(controls, 'Button.svelte'), '<button>button</button>');
        fs.symlinkSync(bundledSvelteRoot, path.join(root, 'node_modules/svelte'), 'junction');

        const previousPackage = process.env.SVELTE_LS_TSGO_PACKAGE;
        process.env.SVELTE_LS_TSGO_PACKAGE = '@typescript/native-preview';
        const plugins: Array<{ dispose(): void }> = [];
        const create = () => {
            const plugin = createTsGoPlugin({
                workspacePath: root,
                docManager: new DocumentManager(
                    (item) => new Document(item.uri, item.text, /*skipConfigLoading*/ true)
                )
            });
            assert.ok(plugin, 'the test dependency must provide the native-preview engine');
            plugins.push(plugin);
            return plugin as any;
        };

        try {
            const checker = await TsGoBatchOverlay.create({
                workspacePath: root,
                tsconfigPath: path.join(root, 'tsconfig.json')
            });
            assert.ok(checker);
            const checkerCold = await checker.materialise();
            assert.strictEqual(checkerCold.graph.materialisationPlan.writeStatus, 'written');
            const planPath = materialisationPlanPath(checker);
            const initialSignature = readPlanSignature(planPath);

            const first = create();
            const firstManager = first.projects.forFile(source);
            assert.ok(
                (firstManager as any).restoredBatchGraphPlan,
                'the editor must restore the checker-published plan before discovery'
            );

            fs.writeFileSync(path.join(controls, 'NewButton.svelte'), '<button>new</button>');
            invalidateTsGoWorkspaceIndex();
            const second = create();
            const secondManager = second.projects.forFile(source);
            assert.strictEqual(
                (secondManager as any).restoredBatchGraphPlan,
                undefined,
                'package membership changes must invalidate the editor cache hit'
            );
            await second.ensureProjectOpened(secondManager);
            await waitForPlanChange(planPath, initialSignature);

            const checkerWarm = await TsGoBatchOverlay.create({
                workspacePath: root,
                tsconfigPath: path.join(root, 'tsconfig.json')
            });
            assert.ok(checkerWarm);
            const warm = await checkerWarm.materialise();
            assert.strictEqual(
                warm.graph.materialisationPlan.hit,
                true,
                'the checker must restore the editor-published replacement plan'
            );
        } finally {
            for (const plugin of plugins) {
                plugin.dispose();
            }
            invalidateTsGoWorkspaceIndex();
            if (previousPackage === undefined) {
                delete process.env.SVELTE_LS_TSGO_PACKAGE;
            } else {
                process.env.SVELTE_LS_TSGO_PACKAGE = previousPackage;
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    }).timeout(10_000);
});

async function waitForPlanChange(
    filePath: string,
    previousSignature: string,
    timeoutMs = 5_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath) && readPlanSignature(filePath) !== previousSignature) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

function readPlanSignature(filePath: string): string {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')).body.payload.signature;
}

function materialisationPlanPath(batch: TsGoBatchOverlay): string {
    const expectedEngine = {
        packageName: batch.engine.packageName,
        version: batch.engine.version
    };
    const matches = fs
        .readdirSync(batch.overlayPath)
        .filter((name) => name.startsWith('materialisation-plan') && name.endsWith('.json'))
        .map((name) => path.join(batch.overlayPath, name))
        .filter((filePath) => {
            try {
                const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return (
                    JSON.stringify(envelope.body?.identity?.engine) ===
                    JSON.stringify(expectedEngine)
                );
            } catch {
                return false;
            }
        });
    assert.strictEqual(
        matches.length,
        1,
        `expected one plan for ${JSON.stringify(expectedEngine)}`
    );
    return matches[0];
}
