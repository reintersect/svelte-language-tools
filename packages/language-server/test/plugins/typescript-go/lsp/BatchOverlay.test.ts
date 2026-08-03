import assert from 'assert';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sinon from 'sinon';
import ts from 'typescript';
import { afterEach, describe, it } from 'mocha';
import { DiagnosticSeverity } from 'vscode-languageserver';
import {
    TsGoBatchOverlay,
    publishBatchGraphPlanInProcess
} from '../../../../src/plugins/typescript-go/lsp/BatchOverlay';
import { pathToUrl } from '../../../../src/utils';

const temporaryProjects: string[] = [];
const bundledSvelteRoot = path.dirname(require.resolve('svelte/package.json'));

function installSvelteCompiler(root: string, version: '4.2.20' | '5.0.0'): void {
    const target = path.join(root, 'node_modules/svelte');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (version.startsWith('4.')) {
        fs.symlinkSync(bundledSvelteRoot, target, 'junction');
        return;
    }
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
        path.join(target, 'package.json'),
        JSON.stringify({ name: 'svelte', version, main: './index.js' })
    );
    // The transform only needs a parser and VERSION. Reuse the bundled parser while presenting
    // a Svelte-5 package boundary so this test stays hermetic in a Svelte-4 dev installation.
    fs.writeFileSync(
        path.join(target, 'compiler.js'),
        `module.exports = { ...require(${JSON.stringify(
            path.join(bundledSvelteRoot, 'compiler.cjs')
        )}), VERSION: ${JSON.stringify(version)} };`
    );
}

function project(files: Record<string, string>, config: Record<string, unknown>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-batch-overlay-'));
    temporaryProjects.push(root);
    fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'batch-overlay-fixture', private: true })
    );
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(config, null, 4));
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return root;
}

async function overlay(root: string, configPath?: string): Promise<TsGoBatchOverlay> {
    const result = await TsGoBatchOverlay.create({
        workspacePath: root,
        tsconfigPath: path.join(root, 'tsconfig.json'),
        configPath
    });
    assert.ok(result, 'the language-server test dependency must provide a tsgo engine');
    return result;
}

function componentShadow(batch: TsGoBatchOverlay, component: string): string {
    const config = JSON.parse(fs.readFileSync(batch.overlayTsconfigPath, 'utf-8'));
    const suffix = component.replace(/\\/g, '/');
    const result = (config.files as string[]).find((file) => {
        const normalized = file.replace(/\\/g, '/');
        return normalized.endsWith(`${suffix}.tsx`) || normalized.endsWith(`${suffix}.jsx`);
    });
    assert.ok(result, `overlay config should contain a JSX/TSX shadow for ${suffix}`);
    return result;
}

function materialisationPlanFiles(overlayPath: string): string[] {
    return fs
        .readdirSync(overlayPath)
        .filter((name) => name.startsWith('materialisation-plan') && name.endsWith('.json'))
        .map((name) => path.join(overlayPath, name));
}

function regularMaterialisationPlanFiles(overlayPath: string): string[] {
    return materialisationPlanFiles(overlayPath).filter((filePath) =>
        fs.lstatSync(filePath).isFile()
    );
}

function materialisationPlanPath(batch: TsGoBatchOverlay): string {
    const expectedEngine = {
        packageName: batch.engine.packageName,
        version: batch.engine.version
    };
    const matches = materialisationPlanFiles(batch.overlayPath).filter((filePath) => {
        try {
            const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return (
                JSON.stringify(envelope.body?.identity?.engine) === JSON.stringify(expectedEngine)
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

function rewriteMaterialisationPlan(filePath: string, mutate: (envelope: any) => void): void {
    const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    mutate(envelope);
    envelope.checksum = createHash('sha256')
        .update(JSON.stringify(envelope.body))
        .digest('base64url');
    fs.writeFileSync(filePath, JSON.stringify(envelope));
}

function generatedPosition(text: string, needle: string): { line: number; character: number } {
    const offset = text.indexOf(needle);
    assert.notStrictEqual(offset, -1, `generated output must contain ${needle}`);
    const before = text.slice(0, offset);
    const lines = before.split('\n');
    return { line: lines.length - 1, character: lines.at(-1)!.length };
}

async function waitForBatchGraphPlanPublisher(
    predicate: () => boolean,
    message: string
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(message);
}

function declaredFallbackProject(): string {
    return project(
        {
            'package.json': JSON.stringify({
                name: 'declared-fallback-fixture',
                private: true,
                dependencies: { controls: '1.0.0' }
            }),
            'src/main.ts': 'import Controls from "controls"; void Controls;\n',
            'node_modules/controls/package.json': JSON.stringify({
                name: 'controls',
                version: '1.0.0',
                main: './index.js'
            }),
            // The computed CommonJS edge makes the narrow public-source proof ambiguous. The
            // fallback must therefore scan the complete declared package tree.
            'node_modules/controls/index.js':
                'const target = "./Button.svelte"; module.exports = require(target);\n',
            'node_modules/controls/Button.svelte':
                '<script lang="ts">export let label: string;</script><button>{label}</button>'
        },
        {
            compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
            include: ['src/**/*']
        }
    );
}

describe('typescript-go BatchOverlay', () => {
    afterEach(() => {
        for (const root of temporaryProjects.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('materialises explicit tsconfig roots even when the broad scan excludes their directory', async () => {
        const root = project(
            {
                'build/Comp.svelte': '<script lang="ts">export let value: number;</script>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                files: ['build/Comp.svelte']
            }
        );
        const batch = await overlay(root);
        const result = await batch.materialise();

        assert.strictEqual(result.transformedCount, 1);
        assert.ok(fs.existsSync(componentShadow(batch, 'build/Comp.svelte')));
        assert.deepStrictEqual(batch.listProjectSvelteFiles(), [
            path.join(root, 'build/Comp.svelte').replace(/\\/g, '/')
        ]);
    });

    it('does not materialise an excluded declaration-backed import', async () => {
        const root = project(
            {
                'src/main.ts': 'import Declared from "./Declared.svelte"; void Declared;',
                'src/Declared.svelte': '<script>export let value;</script>',
                'src/Declared.d.svelte.ts': 'export default class Declared {}'
            },
            {
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    allowArbitraryExtensions: true
                },
                include: ['src/**/*'],
                exclude: ['src/Declared.svelte']
            }
        );
        const batch = await overlay(root);
        const result = await batch.materialise();
        const declaration = path.join(root, 'src/Declared.d.svelte.ts').replace(/\\/g, '/');

        assert.strictEqual(result.transformedCount, 0);
        assert.deepStrictEqual(batch.listProjectSvelteFiles(), []);
        assert.deepStrictEqual(batch.mapProgramFiles([declaration]), {
            all: [declaration],
            svelte: []
        });
        const config = JSON.parse(fs.readFileSync(batch.overlayTsconfigPath, 'utf8'));
        assert.ok(
            !(config.files as string[]).some((file) =>
                file.replace(/\\/g, '/').endsWith('/src/Declared.svelte.tsx')
            )
        );
    });

    it('reuses a fresh shadow without changing its mtime', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'batch-overlay-fixture',
                    private: true,
                    dependencies: { 'raw-ui': '1.0.0' }
                }),
                'src/Comp.svelte':
                    '<script lang="ts">import Dependency from "raw-ui";</script>\n<Dependency value="ok" />',
                'node_modules/raw-ui/package.json': JSON.stringify({
                    name: 'raw-ui',
                    version: '1.0.0',
                    // Deliberately hide package.json: dependency discovery must start from the
                    // exported entry and walk to its owning manifest.
                    exports: { '.': './index.ts' }
                }),
                'node_modules/raw-ui/index.ts': 'export { default } from "./Dependency.svelte";',
                'node_modules/raw-ui/Dependency.svelte':
                    '<script lang="ts">export let value: string;</script>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();
        const shadow = componentShadow(first, 'src/Comp.svelte');
        const mtime = fs.statSync(shadow).mtimeMs;
        const coldState = JSON.parse(
            fs.readFileSync(path.join(first.overlayPath, 'batch-state.json'), 'utf-8')
        );
        const dependencyEntry = Object.entries(coldState.entries).find(([source]) =>
            source.endsWith('/node_modules/raw-ui/Dependency.svelte')
        );
        const dependencyShadow = (dependencyEntry?.[1] as { shadowPath?: string } | undefined)
            ?.shadowPath;
        assert.ok(
            dependencyShadow,
            `raw dependency must have a materialised shadow; got ${JSON.stringify(Object.keys(coldState.entries))}`
        );
        const dependencyMtime = fs.statSync(dependencyShadow).mtimeMs;

        const second = await overlay(root);
        const warm = await second.materialise();

        assert.strictEqual(cold.transformedCount, 2);
        assert.deepStrictEqual(cold.graph.materialisationPlan, {
            hit: false,
            missReason: 'not-found',
            eligible: true,
            writeStatus: 'written',
            counters: {
                lookups: 1,
                hits: 0,
                misses: 1,
                writes: 1,
                writeSkips: 0,
                writeFailures: 0,
                statFastPathInputs: 0,
                sourceSignatureFallbacks: 0,
                exactContentFallbacks: 0,
                directoryValidations: 0,
                missReasons: { 'not-found': 1 },
                writeFailureReasons: {}
            }
        });
        assert.strictEqual(
            warm.graph.materialisationPlan.hit,
            true,
            JSON.stringify(warm.graph.materialisationPlan)
        );
        assert.strictEqual(warm.graph.materialisationPlan.eligible, true);
        assert.strictEqual(warm.graph.materialisationPlan.writeStatus, 'unchanged');
        assert.strictEqual(warm.graph.materialisationPlan.counters.hits, 1);
        assert.ok(warm.graph.materialisationPlan.counters.statFastPathInputs > 0);
        assert.deepStrictEqual(cold.svelte, {
            candidateCount: 2,
            transformedCount: 2,
            reusedCount: 0,
            writtenCount: 2
        });
        assert.deepStrictEqual(cold.sourceMirrors, {
            candidateCount: 0,
            copiedCount: 0,
            rewrittenCount: 0,
            reusedCount: 0,
            writtenCount: 0
        });
        assert.strictEqual(warm.transformedCount, 0);
        assert.strictEqual(warm.reusedCount, 2);
        assert.deepStrictEqual(warm.svelte, {
            candidateCount: 2,
            transformedCount: 0,
            reusedCount: 2,
            writtenCount: 0
        });
        assert.ok(Object.values(warm.phases).every((duration) => duration >= 0));
        assert.strictEqual(fs.statSync(shadow).mtimeMs, mtime);
        assert.strictEqual(fs.statSync(dependencyShadow).mtimeMs, dependencyMtime);
    });

    it('accepts ordinary Svelte ownership published by the editor on a checker warm run', async () => {
        const root = project(
            {
                'src/Comp.svelte': '<script lang="ts">const value = 1;</script><p>{value}</p>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        await first.materialise();
        const state = JSON.parse(
            fs.readFileSync(path.join(first.overlayPath, 'batch-state.json'), 'utf8')
        );
        const editorOwnedPaths = Object.values(state.entries).map(
            (entry: any) => entry.shadowPath as string
        );
        assert.strictEqual(editorOwnedPaths.length, 1);
        // TsGoPlugin publishes every required component shadow. Reproduce that editor-side
        // contract before starting a fresh checker process with persisted batch state.
        (first as any).shadows.reconcileBatchMirrorOwnership([], editorOwnedPaths);

        const second = await overlay(root);
        const warm = await second.materialise();

        assert.strictEqual(warm.transformedCount, 0);
        assert.strictEqual(warm.writtenCount, 0);
        assert.strictEqual(warm.cleanup.skipped, true);
    });

    it('materialises and types a CommonJS declaration re-export of a raw component', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'batch-overlay-fixture',
                    private: true,
                    dependencies: { controls: '1.0.0' }
                }),
                'src/main.ts': [
                    'import Button = require("controls");',
                    'new Button.default({ target: document.body, props: { label: 123 } });'
                ].join('\n'),
                'node_modules/controls/package.json': JSON.stringify({
                    name: 'controls',
                    version: '1.0.0',
                    exports: { '.': { types: './index.d.ts', require: './index.js' } }
                }),
                'node_modules/controls/index.d.ts':
                    'import Button = require("./Button.svelte"); export = Button;\n',
                'node_modules/controls/index.js': 'module.exports = require("./Button.svelte");\n',
                'node_modules/controls/Button.svelte':
                    '<script lang="ts">export let label: string;</script><button>{label}</button>'
            },
            {
                compilerOptions: {
                    strict: true,
                    module: 'node16',
                    moduleResolution: 'node16',
                    allowArbitraryExtensions: true,
                    noEmit: true
                },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        const result = await batch.materialise();
        const state = JSON.parse(
            fs.readFileSync(path.join(batch.overlayPath, 'batch-state.json'), 'utf8')
        );
        assert.ok(
            Object.keys(state.entries).some((source) =>
                source.endsWith('/node_modules/controls/Button.svelte')
            ),
            JSON.stringify(state.entries)
        );
        assert.strictEqual(result.svelte.transformedCount, 1);

        const config = ts.readConfigFile(batch.overlayTsconfigPath, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(
            config.config,
            ts.sys,
            path.dirname(batch.overlayTsconfigPath),
            undefined,
            batch.overlayTsconfigPath
        );
        const diagnostics = ts.getPreEmitDiagnostics(
            ts.createProgram(parsed.fileNames, parsed.options)
        );
        assert.ok(
            diagnostics.some(
                (diagnostic) =>
                    diagnostic.file?.fileName === path.join(root, 'src/main.ts') &&
                    ts
                        .flattenDiagnosticMessageText(diagnostic.messageText, '\n')
                        .includes("Type 'number' is not assignable to type 'string'")
            ),
            diagnostics
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
                .join('\n')
        );
    });

    it('reuses a persisted graph across a body-only edit and refreshes its source stat', async () => {
        const root = project(
            {
                'src/main.ts': 'import Comp from "./Comp.svelte"; void Comp;\n',
                'src/Comp.svelte':
                    '<script lang="ts">const value: number = 1;</script><p>{value}</p>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        fs.writeFileSync(
            path.join(root, 'src/main.ts'),
            'import Comp from "./Comp.svelte"; const bodyOnly = 2; void [Comp, bodyOnly];\n'
        );
        const second = await overlay(root);
        const warmGraph = await second.materialise();

        assert.strictEqual(
            warmGraph.graph.materialisationPlan.hit,
            true,
            JSON.stringify(warmGraph.graph.materialisationPlan)
        );
        assert.ok(
            warmGraph.graph.materialisationPlan.counters.sourceSignatureFallbacks >= 1,
            'the changed stat should validate only graph-relevant source semantics'
        );
        assert.strictEqual(warmGraph.graph.materialisationPlan.writeStatus, 'written');
        assert.strictEqual(warmGraph.svelte.transformedCount, 0);

        fs.writeFileSync(
            path.join(root, 'src/Comp.svelte'),
            '<script lang="ts">const value: number = 2;</script><p>{value}</p>'
        );
        const third = await overlay(root);
        const svelteBodyEdit = await third.materialise();
        assert.strictEqual(
            svelteBodyEdit.graph.materialisationPlan.hit,
            true,
            JSON.stringify(svelteBodyEdit.graph.materialisationPlan)
        );
        assert.strictEqual(svelteBodyEdit.svelte.transformedCount, 1);
    });

    it('publishes refreshed inputs when commit revalidation takes the first source fallback', async () => {
        const root = project(
            {
                'src/main.ts': 'import Comp from "./Comp.svelte"; void Comp;\n',
                'src/Comp.svelte': '<p>component</p>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        assert.strictEqual(
            (await first.materialise()).graph.materialisationPlan.writeStatus,
            'written'
        );

        // create() completes the persisted lookup. This edit is therefore first observed by the
        // commit-time revalidation, not by lookupAndRestore().
        const second = await overlay(root);
        fs.writeFileSync(
            path.join(root, 'src/main.ts'),
            'import Comp from "./Comp.svelte"; const bodyOnly = 2; void [Comp, bodyOnly];\n'
        );
        const refreshed = await second.materialise();

        assert.strictEqual(refreshed.graph.materialisationPlan.hit, true);
        assert.ok(refreshed.graph.materialisationPlan.counters.sourceSignatureFallbacks >= 1);
        assert.strictEqual(refreshed.graph.materialisationPlan.writeStatus, 'written');

        const third = await overlay(root);
        const stable = await third.materialise();
        assert.strictEqual(stable.graph.materialisationPlan.hit, true);
        assert.strictEqual(stable.graph.materialisationPlan.counters.sourceSignatureFallbacks, 0);
        assert.strictEqual(stable.graph.materialisationPlan.writeStatus, 'unchanged');
    });

    it('invalidates a persisted graph when an existing root imports a newly-created component', async () => {
        const root = project(
            {
                'src/main.ts': 'export const value = 1;\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        fs.writeFileSync(
            path.join(root, 'src/main.ts'),
            'import NewComponent from "./NewComponent.svelte"; void NewComponent;\n'
        );
        fs.writeFileSync(path.join(root, 'src/NewComponent.svelte'), '<p>new</p>');
        const second = await overlay(root);
        const rebuilt = await second.materialise();

        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
        assert.ok(
            ['source-signature-mismatch', 'directory-membership-mismatch'].includes(
                rebuilt.graph.materialisationPlan.missReason ?? ''
            )
        );
        assert.ok(fs.existsSync(componentShadow(second, 'src/NewComponent.svelte')));
        assert.ok(
            second.listProjectSvelteFiles().some((file) => file.endsWith('NewComponent.svelte'))
        );
    });

    it('invalidates a persisted graph when a previously absent public target is created', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'batch-overlay-fixture',
                    private: true,
                    dependencies: { facade: '1.0.0' }
                }),
                'src/main.ts': 'import "facade";\n',
                'node_modules/facade/package.json': JSON.stringify({
                    name: 'facade',
                    version: '1.0.0',
                    types: './index.d.ts'
                }),
                'node_modules/facade/index.d.ts': 'export * from "./optional.js";\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.dependencyScope.mode, 'reachable');
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        fs.writeFileSync(
            path.join(root, 'node_modules/facade/optional.d.ts'),
            'export { default } from "./Optional.svelte";\n'
        );
        fs.writeFileSync(
            path.join(root, 'node_modules/facade/Optional.svelte'),
            '<script lang="ts">export let value: string;</script>'
        );
        TsGoBatchOverlay.invalidateWorkspaceIndex();
        const second = await overlay(root);
        const rebuilt = await second.materialise();

        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
        assert.ok(
            ['input-presence-changed', 'layout-mismatch', 'directory-membership-mismatch'].includes(
                rebuilt.graph.materialisationPlan.missReason ?? ''
            ),
            JSON.stringify(rebuilt.graph.materialisationPlan)
        );
        assert.strictEqual(rebuilt.svelte.transformedCount, 1);
    });

    it('folds a covered absence into directory membership without dropping payload provenance', async () => {
        const root = declaredFallbackProject();
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        const envelope = JSON.parse(fs.readFileSync(materialisationPlanPath(first), 'utf8'));
        const storedPaths = new Set(
            envelope.body.files.map((input: { path: string }) => input.path)
        );
        const folded = envelope.body.payload.exactInputProofs.find(
            (input: { kind: string; path: string; proof: string | null }) =>
                (input.kind === 'manifest' || input.kind === 'layout') &&
                input.proof === null &&
                !storedPaths.has(input.path)
        );
        assert.ok(
            folded,
            'the payload must retain a directory-covered absence omitted from stored file inputs'
        );

        fs.mkdirSync(path.dirname(folded.path), { recursive: true });
        fs.writeFileSync(folded.path, folded.kind === 'manifest' ? '{}' : 'export {};\n');
        TsGoBatchOverlay.invalidateWorkspaceIndex();
        const second = await overlay(root);
        const rebuilt = await second.materialise();
        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
        assert.strictEqual(
            rebuilt.graph.materialisationPlan.missReason,
            'directory-membership-mismatch',
            JSON.stringify(rebuilt.graph.materialisationPlan)
        );
    });

    it('restores a complete declared-fallback graph on a fresh overlay', async () => {
        const root = declaredFallbackProject();
        const first = await overlay(root);
        const cold = await first.materialise();

        assert.strictEqual(cold.graph.dependencyScope.mode, 'declared-fallback');
        assert.strictEqual(cold.graph.dependencyScope.closureComplete, true);
        assert.strictEqual(
            cold.graph.materialisationPlan.eligible,
            true,
            JSON.stringify({
                graph: cold.graph,
                plan: (first as any).shadows.exportBatchGraphPlan()
            })
        );
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        const second = await overlay(root);
        (second as any).shadows.exportBatchGraphPlan = () => {
            throw new Error('a validated cache hit must reuse its restored payload');
        };
        const warm = await second.materialise();

        assert.strictEqual(warm.graph.materialisationPlan.hit, true);
        assert.strictEqual(warm.graph.materialisationPlan.eligible, true);
        assert.strictEqual(warm.graph.materialisationPlan.writeStatus, 'unchanged');
        assert.strictEqual(warm.svelte.transformedCount, 0);
        assert.strictEqual(warm.svelte.reusedCount, cold.svelte.candidateCount);
    });

    it('restores a complete broad project scan after computed-import ambiguity', async () => {
        const root = project(
            {
                'src/main.ts': 'const component = "./Button.svelte"; void import(component);\n',
                'src/Button.svelte': '<button>button</button>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();

        assert.ok(
            cold.graph.reachabilityFallbackReasons.some((reason) =>
                reason.startsWith('computed-import:')
            )
        );
        assert.strictEqual(cold.graph.dependencyScope.mode, 'declared-fallback');
        assert.strictEqual(cold.graph.dependencyScope.closureComplete, true);
        assert.strictEqual(
            cold.graph.materialisationPlan.eligible,
            true,
            JSON.stringify({
                graph: cold.graph,
                plan: (first as any).shadows.exportBatchGraphPlan()
            })
        );
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        const second = await overlay(root);
        const warm = await second.materialise();

        assert.strictEqual(
            warm.graph.materialisationPlan.hit,
            true,
            JSON.stringify(warm.graph.materialisationPlan)
        );
        assert.strictEqual(warm.graph.materialisationPlan.eligible, true);
        assert.strictEqual(warm.graph.materialisationPlan.writeStatus, 'unchanged');
    });

    it('refuses detached publication when discovery evidence is incomplete', async () => {
        const root = declaredFallbackProject();
        const batch = await overlay(root);
        await batch.materialise();
        const cachePath = materialisationPlanPath(batch);
        fs.unlinkSync(cachePath);
        const plan = (batch as any).shadows.exportBatchGraphPlan();
        plan.exactInputProofs = plan.exactInputProofs.filter(
            (input: { kind: string }) => input.kind !== 'config'
        );

        const telemetry = publishBatchGraphPlanInProcess({
            engine: batch.engine,
            overlayPath: batch.overlayPath,
            project: {
                projectPath: root,
                sourceRoot: root,
                tsconfigPath: path.join(root, 'tsconfig.json')
            },
            plan,
            collisionFallbackReasons: []
        });

        assert.strictEqual(telemetry.eligible, false);
        assert.strictEqual(telemetry.writeStatus, 'skipped');
        assert.strictEqual(fs.existsSync(cachePath), false);
    });

    it('cleans detached requests and retries signal and pre-bootstrap failures once', async () => {
        const root = declaredFallbackProject();
        const batch = await overlay(root);
        await batch.materialise();
        const plan = (batch as any).shadows.exportBatchGraphPlan();
        const cache = (batch as any).materialisationPlanCache;
        const childProcess = require('child_process') as typeof import('child_process');
        const children: EventEmitter[] = [];
        let throwBeforeBootstrap = false;
        const spawnStub = sinon.stub(childProcess, 'spawn').callsFake((() => {
            if (throwBeforeBootstrap) {
                throwBeforeBootstrap = false;
                throw new Error('test pre-bootstrap failure');
            }
            const child = Object.assign(new EventEmitter(), {
                unref() {
                    return child;
                },
                kill() {
                    return true;
                }
            });
            children.push(child);
            return child;
        }) as any);
        const requestFiles = () =>
            fs
                .readdirSync(batch.overlayPath)
                .filter((file) => file.startsWith('.materialisation-plan-request-'));
        try {
            cache.publishOffProcess(plan, []);
            await waitForBatchGraphPlanPublisher(
                () => children.length === 1 && requestFiles().length === 1,
                'the first detached publisher should start'
            );
            const signalledRequest = requestFiles()[0];
            children[0].emit('close', null, 'SIGTERM');
            await waitForBatchGraphPlanPublisher(
                () => children.length === 2 && !requestFiles().includes(signalledRequest),
                'a signalled publisher should clean its request and retry'
            );
            children[1].emit('close', 0, null);
            await waitForBatchGraphPlanPublisher(
                () => requestFiles().length === 0,
                'the successful retry should leave no request file'
            );

            throwBeforeBootstrap = true;
            cache.publishOffProcess(plan, []);
            await waitForBatchGraphPlanPublisher(
                () => spawnStub.callCount === 4 && children.length === 3,
                'a pre-bootstrap failure should retry once'
            );
            await waitForBatchGraphPlanPublisher(
                () => requestFiles().length === 1,
                'the failed bootstrap request should be removed before its retry completes'
            );
            children[2].emit('close', 0, null);
            await waitForBatchGraphPlanPublisher(
                () => requestFiles().length === 0,
                'the pre-bootstrap retry should leave no request file'
            );
        } finally {
            for (const child of children) {
                child.emit('close', 0, null);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
            for (const child of children) {
                child.emit('close', 0, null);
            }
            spawnStub.restore();
        }
    });

    it('includes raw Svelte sources supplied by a transitive peer dependency', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'peer-fallback-fixture',
                    private: true,
                    dependencies: { facade: '1.0.0' }
                }),
                'src/main.ts': 'import "facade";\n',
                'node_modules/facade/package.json': JSON.stringify({
                    name: 'facade',
                    version: '1.0.0',
                    main: './index.js',
                    peerDependencies: { 'peer-ui': '1.0.0' }
                }),
                'node_modules/facade/index.js':
                    'const target = "peer-ui"; module.exports = require(target);\n',
                'node_modules/peer-ui/package.json': JSON.stringify({
                    name: 'peer-ui',
                    version: '1.0.0',
                    svelte: './PeerButton.svelte'
                }),
                'node_modules/peer-ui/PeerButton.svelte': '<button>peer</button>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        const result = await batch.materialise();

        assert.strictEqual(result.graph.dependencyScope.mode, 'declared-fallback');
        assert.strictEqual(result.graph.dependencyScope.closureComplete, true);
        assert.ok(result.svelte.candidateCount >= 1, JSON.stringify(result.graph.dependencyScope));
        const state = JSON.parse(
            fs.readFileSync(path.join(batch.overlayPath, 'batch-state.json'), 'utf8')
        );
        assert.ok(
            Object.keys(state.entries).some((file) => file.endsWith('/peer-ui/PeerButton.svelte'))
        );
    });

    it('tracks a marker-free peer public entry without traversing irrelevant peer trees', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'peer-entry-fixture',
                    private: true,
                    dependencies: { facade: '1.0.0' }
                }),
                'src/main.ts': 'import "facade";\n',
                'node_modules/facade/package.json': JSON.stringify({
                    name: 'facade',
                    version: '1.0.0',
                    main: './index.js',
                    peerDependencies: { 'plain-peer': '1.0.0' }
                }),
                'node_modules/facade/index.js':
                    'const target = "plain-peer"; module.exports = require(target);\n',
                'node_modules/plain-peer/package.json': JSON.stringify({
                    name: 'plain-peer',
                    version: '1.0.0',
                    main: './index.js'
                }),
                'node_modules/plain-peer/index.js': 'module.exports = {};\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const peerRoot = path.join(root, 'node_modules/plain-peer');
        const peerEntry = path.join(peerRoot, 'index.js');

        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.dependencyScope.closureComplete, true);
        assert.strictEqual(cold.graph.materialisationPlan.eligible, true);
        assert.ok(
            !(first as any).shadows.exportBatchGraphPlan().dependencyScope.roots.includes(peerRoot)
        );

        const second = await overlay(root);
        const warm = await second.materialise();
        assert.strictEqual(warm.graph.materialisationPlan.hit, true);

        fs.writeFileSync(peerEntry, 'export { default } from "./PeerButton.svelte";\n');
        fs.writeFileSync(path.join(peerRoot, 'PeerButton.svelte'), '<button>peer</button>');
        const third = await overlay(root);
        const rebuilt = await third.materialise();
        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
        assert.strictEqual(
            rebuilt.graph.materialisationPlan.missReason,
            'source-signature-mismatch'
        );
        assert.ok(
            (third as any).shadows.exportBatchGraphPlan().dependencyScope.roots.includes(peerRoot)
        );
        assert.ok(rebuilt.svelte.candidateCount >= 1);
    });

    it('follows relative public barrels before classifying a marker-free peer', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'peer-barrel-fixture',
                    private: true,
                    dependencies: { facade: '1.0.0' }
                }),
                'src/main.ts': 'import "facade";\n',
                'node_modules/facade/package.json': JSON.stringify({
                    name: 'facade',
                    version: '1.0.0',
                    main: './index.js',
                    peerDependencies: { 'plain-peer': '1.0.0' }
                }),
                'node_modules/facade/index.js':
                    'const target = "plain-peer"; module.exports = require(target);\n',
                'node_modules/plain-peer/package.json': JSON.stringify({
                    name: 'plain-peer',
                    version: '1.0.0',
                    main: './index.js'
                }),
                'node_modules/plain-peer/index.js': 'export * from "./barrel.js";\n',
                'node_modules/plain-peer/barrel.js':
                    'export { default as PeerButton } from "./PeerButton.svelte";\n',
                'node_modules/plain-peer/PeerButton.svelte': '<button>peer</button>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        const result = await batch.materialise();
        const plan = (batch as any).shadows.exportBatchGraphPlan();

        assert.strictEqual(result.graph.dependencyScope.mode, 'declared-fallback');
        assert.ok(plan.dependencyScope.roots.includes(path.join(root, 'node_modules/plain-peer')));
        const state = JSON.parse(
            fs.readFileSync(path.join(batch.overlayPath, 'batch-state.json'), 'utf8')
        );
        assert.ok(Object.keys(state.entries).some((file) => file.endsWith('PeerButton.svelte')));
    });

    it('follows marker-free peer re-exports into a Svelte companion package', async () => {
        const root = project(
            {
                'package.json': JSON.stringify({
                    name: 'peer-companion-fixture',
                    private: true,
                    dependencies: { facade: '1.0.0' }
                }),
                'src/main.ts': 'import "facade";\n',
                'node_modules/facade/package.json': JSON.stringify({
                    name: 'facade',
                    version: '1.0.0',
                    main: './index.js',
                    peerDependencies: { 'plain-peer': '1.0.0' }
                }),
                'node_modules/facade/index.js':
                    'const target = "plain-peer"; module.exports = require(target);\n',
                'node_modules/plain-peer/package.json': JSON.stringify({
                    name: 'plain-peer',
                    version: '1.0.0',
                    main: './index.js'
                }),
                'node_modules/plain-peer/index.js': 'export * from "companion-components";\n',
                'node_modules/companion-components/package.json': JSON.stringify({
                    name: 'companion-components',
                    version: '1.0.0',
                    svelte: './CompanionButton.svelte'
                }),
                'node_modules/companion-components/CompanionButton.svelte':
                    '<button>companion</button>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        const result = await batch.materialise();
        const roots = (batch as any).shadows.exportBatchGraphPlan().dependencyScope.roots;

        assert.strictEqual(result.graph.dependencyScope.mode, 'declared-fallback');
        assert.ok(
            roots.includes(path.join(root, 'node_modules/companion-components')),
            JSON.stringify(roots)
        );
        assert.ok(
            !roots.includes(path.join(root, 'node_modules/plain-peer')),
            'the forwarding barrel itself should remain narrow'
        );
        const state = JSON.parse(
            fs.readFileSync(path.join(batch.overlayPath, 'batch-state.json'), 'utf8')
        );
        assert.ok(
            Object.keys(state.entries).some((file) => file.endsWith('CompanionButton.svelte'))
        );
    });

    it('replays absent dependency probes from a shared declared closure', async () => {
        const root = declaredFallbackProject();
        const manifestPath = path.join(root, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.optionalDependencies = { 'optional-controls': '1.0.0' };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));

        const first = await overlay(root);
        await first.materialise();
        fs.unlinkSync(materialisationPlanPath(first));

        const second = await overlay(root);
        const shared = await second.materialise();
        assert.strictEqual(shared.graph.materialisationPlan.writeStatus, 'written');

        const optional = path.join(root, 'node_modules/optional-controls');
        fs.mkdirSync(optional, { recursive: true });
        fs.writeFileSync(
            path.join(optional, 'package.json'),
            JSON.stringify({ name: 'optional-controls', version: '1.0.0' })
        );
        const third = await overlay(root);
        const rebuilt = await third.materialise();

        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
        assert.strictEqual(rebuilt.graph.materialisationPlan.missReason, 'input-presence-changed');
    });

    it('does not invalidate a declared graph for dependency documentation files', async () => {
        const root = declaredFallbackProject();
        const first = await overlay(root);
        await first.materialise();

        fs.writeFileSync(path.join(root, 'node_modules/controls/README.md'), '# controls\n');
        const second = await overlay(root);
        const warm = await second.materialise();

        assert.strictEqual(
            warm.graph.materialisationPlan.hit,
            true,
            JSON.stringify(warm.graph.materialisationPlan)
        );
        assert.strictEqual(warm.graph.materialisationPlan.eligible, true);
    });

    it('rebuilds when a structural edit races a validated cache hit', async () => {
        const root = project(
            { 'src/main.ts': 'export const value = 1;\n' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        await first.materialise();

        const second = await overlay(root);
        fs.writeFileSync(
            path.join(root, 'src/main.ts'),
            'import NewComponent from "./NewComponent.svelte"; void NewComponent;\n'
        );
        fs.writeFileSync(path.join(root, 'src/NewComponent.svelte'), '<p>new</p>');
        const rebuilt = await second.materialise();

        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, true);
        assert.ok(fs.existsSync(componentShadow(second, 'src/NewComponent.svelte')));
        assert.ok(
            second.listProjectSvelteFiles().some((file) => file.endsWith('NewComponent.svelte'))
        );
        assert.strictEqual(rebuilt.graph.materialisationPlan.writeStatus, 'written');
    });

    it('rebuilds when a structural edit lands during a cached transform', async () => {
        const root = project(
            {
                'src/main.ts': 'import Comp from "./Comp.svelte"; void Comp;\n',
                'src/Comp.svelte': '<p>component</p>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        await first.materialise();

        fs.writeFileSync(path.join(root, 'src/Comp.svelte'), '<p>changed body</p>');
        const second = await overlay(root);
        const shadows = (second as any).shadows;
        const originalTransform = shadows.transform.bind(shadows);
        let changed = false;
        shadows.transform = (...args: unknown[]) => {
            if (!changed) {
                changed = true;
                fs.writeFileSync(
                    path.join(root, 'src/main.ts'),
                    'import Comp from "./Comp.svelte"; import New from "./New.svelte"; void Comp; void New;\n'
                );
                fs.writeFileSync(path.join(root, 'src/New.svelte'), '<p>new</p>');
            }
            return originalTransform(...args);
        };

        const rebuilt = await second.materialise();

        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, true);
        assert.ok(fs.existsSync(componentShadow(second, 'src/New.svelte')));
        assert.ok(second.listProjectSvelteFiles().some((file) => file.endsWith('/New.svelte')));
    });

    it('retries with current evidence when config changes during materialisation', async () => {
        const root = project(
            { 'src/Comp.svelte': '<p>component</p>' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        const shadows = (batch as any).shadows;
        const originalTransform = shadows.transform.bind(shadows);
        let changed = false;
        shadows.transform = (...args: unknown[]) => {
            if (!changed) {
                changed = true;
                fs.writeFileSync(
                    path.join(root, 'tsconfig.json'),
                    JSON.stringify({
                        compilerOptions: {
                            strict: false,
                            module: 'esnext',
                            moduleResolution: 'bundler'
                        },
                        include: ['src/**/*']
                    })
                );
            }
            return originalTransform(...args);
        };

        const result = await batch.materialise();

        assert.strictEqual(result.graph.materialisationPlan.writeStatus, 'written');
        const warm = await overlay(root);
        assert.strictEqual((await warm.materialise()).graph.materialisationPlan.hit, true);
    });

    it('rejects a plan when config changes during both commit attempts', async () => {
        const root = project(
            { 'src/Comp.svelte': '<p>component</p>' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        const shadows = (batch as any).shadows;
        const originalTransform = shadows.transform.bind(shadows);
        let strict = true;
        shadows.transform = (...args: unknown[]) => {
            strict = !strict;
            fs.writeFileSync(
                path.join(root, 'tsconfig.json'),
                JSON.stringify({
                    compilerOptions: {
                        strict,
                        module: 'esnext',
                        moduleResolution: 'bundler'
                    },
                    include: ['src/**/*']
                })
            );
            return originalTransform(...args);
        };

        await assert.rejects(
            () => batch.materialise(),
            /project graph changed repeatedly during materialisation/
        );
        assert.strictEqual(materialisationPlanFiles(batch.overlayPath).length, 0);
    });

    it('keeps an explicit Svelte-config plan separate from the editor-compatible plan', async () => {
        const root = project(
            {
                'src/Comp.svelte': '<p>component</p>',
                'custom.config.cjs': 'module.exports = {};\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const ordinary = await overlay(root);
        await ordinary.materialise();
        const ordinaryPlan = materialisationPlanPath(ordinary);
        const ordinaryContents = fs.readFileSync(ordinaryPlan, 'utf8');

        const explicit = await overlay(root, path.join(root, 'custom.config.cjs'));
        await explicit.materialise();

        assert.strictEqual(fs.readFileSync(ordinaryPlan, 'utf8'), ordinaryContents);
        assert.strictEqual(
            fs
                .readdirSync(explicit.overlayPath)
                .filter((name) => name.startsWith('materialisation-plan')).length,
            2
        );
        const editorCompatible = await overlay(root);
        const warm = await editorCompatible.materialise();
        assert.strictEqual(warm.graph.materialisationPlan.hit, true);
    });

    it('atomically migrates an exact legacy plan into the engine-keyed cache before lookup', async () => {
        const root = declaredFallbackProject();
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');
        const keyedPath = materialisationPlanPath(first);
        const legacyPath = path.join(first.overlayPath, 'materialisation-plan.json');
        fs.renameSync(keyedPath, legacyPath);

        const upgraded = await overlay(root);
        const warm = await upgraded.materialise();

        assert.strictEqual(
            warm.graph.materialisationPlan.hit,
            true,
            JSON.stringify(warm.graph.materialisationPlan)
        );
        assert.strictEqual(warm.svelte.transformedCount, 0);
        assert.ok(fs.existsSync(keyedPath));
        assert.strictEqual(fs.existsSync(legacyPath), false);
        assert.ok(!fs.readdirSync(first.overlayPath).some((name) => name.includes('.migrate-')));
    });

    it('does not migrate a checksum-valid legacy plan for a different exact engine', async () => {
        const root = declaredFallbackProject();
        const first = await overlay(root);
        await first.materialise();
        const keyedPath = materialisationPlanPath(first);
        const legacyPath = path.join(first.overlayPath, 'materialisation-plan.json');
        fs.renameSync(keyedPath, legacyPath);
        rewriteMaterialisationPlan(legacyPath, (envelope) => {
            envelope.body.identity.engine.version += '-different';
        });

        const upgraded = await overlay(root);
        const lookup = (upgraded as any).materialisationPlanLookup;

        assert.strictEqual(lookup.hit, false);
        assert.strictEqual(lookup.missReason, 'not-found');
        assert.strictEqual(fs.existsSync(keyedPath), false);
        assert.ok(fs.existsSync(legacyPath));
    });

    it('does not follow a legacy cache symlink during migration', async () => {
        const root = declaredFallbackProject();
        const first = await overlay(root);
        await first.materialise();
        const keyedPath = materialisationPlanPath(first);
        const outsidePath = path.join(root, 'outside-materialisation-plan.json');
        const legacyPath = path.join(first.overlayPath, 'materialisation-plan.json');
        fs.renameSync(keyedPath, outsidePath);
        fs.symlinkSync(outsidePath, legacyPath);

        const upgraded = await overlay(root);
        const lookup = (upgraded as any).materialisationPlanLookup;

        assert.strictEqual(lookup.hit, false);
        assert.strictEqual(lookup.missReason, 'not-found');
        assert.strictEqual(fs.existsSync(keyedPath), false);
        assert.ok(fs.lstatSync(legacyPath).isSymbolicLink());
        assert.ok(fs.existsSync(outsidePath));
    });

    it('reuses stock and Effect engine plans independently and retains at most two valid engines', async () => {
        const root = declaredFallbackProject();
        const previousPackage = process.env.SVELTE_LS_TSGO_PACKAGE;
        process.env.SVELTE_LS_TSGO_PACKAGE = '@typescript/native-preview';
        try {
            const stock = await overlay(root);
            const cold = await stock.materialise();
            assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');
            const stockPlanPath = materialisationPlanPath(stock);
            const stockPlan = (stock as any).shadows.exportBatchGraphPlan();
            const projectRequest = {
                projectPath: root,
                sourceRoot: root,
                tsconfigPath: path.join(root, 'tsconfig.json')
            };
            const effectEngine = {
                ...stock.engine,
                packageName: '@reintersect/effect-tsgo',
                version: '7.0.0-effect-test',
                packageRoot: path.join(root, 'effect-tsgo'),
                binPath: path.join(root, 'effect-tsgo', 'tsgo'),
                command: path.join(root, 'effect-tsgo', 'tsgo'),
                argsPrefix: [],
                apiEntry: path.join(root, 'effect-tsgo', 'api.js')
            };

            const effect = publishBatchGraphPlanInProcess({
                engine: effectEngine,
                overlayPath: stock.overlayPath,
                project: projectRequest,
                plan: stockPlan,
                collisionFallbackReasons: []
            });
            assert.strictEqual(effect.writeStatus, 'written', JSON.stringify(effect));
            assert.strictEqual(regularMaterialisationPlanFiles(stock.overlayPath).length, 2);
            assert.ok(fs.existsSync(stockPlanPath), 'Effect publication must not overwrite stock');

            // Standalone svelte-check does not start the feature API session, while the editor
            // can use the verified bundled Effect API. That path is irrelevant to graph and
            // shadow output, so both consumers must reuse one Effect plan rather than evicting
            // stock from the two-entry retention window.
            const { apiEntry: _editorOnlyApiEntry, ...checkerEffectEngine } = effectEngine;
            const checkerEffect = publishBatchGraphPlanInProcess({
                engine: {
                    ...checkerEffectEngine,
                    command: path.join(root, 'other-node-runtime'),
                    argsPrefix: [checkerEffectEngine.binPath]
                },
                overlayPath: stock.overlayPath,
                project: projectRequest,
                plan: stockPlan,
                collisionFallbackReasons: []
            });
            assert.strictEqual(checkerEffect.writeStatus, 'unchanged');
            assert.strictEqual(regularMaterialisationPlanFiles(stock.overlayPath).length, 2);
            assert.ok(fs.existsSync(stockPlanPath));

            const stockAgain = await overlay(root);
            const warm = await stockAgain.materialise();
            assert.strictEqual(
                warm.graph.materialisationPlan.hit,
                true,
                JSON.stringify(warm.graph.materialisationPlan)
            );

            const currentName = path.basename(materialisationPlanPath(stockAgain));
            const keyedMatch = /^(materialisation-plan-.+-)[0-9a-f]{64}\.json$/.exec(currentName);
            assert.ok(keyedMatch, `unexpected cache filename: ${currentName}`);
            const outside = path.join(root, 'do-not-delete.txt');
            fs.writeFileSync(outside, 'keep');
            const symlinkPath = path.join(
                stock.overlayPath,
                `${keyedMatch[1]}${'f'.repeat(64)}.json`
            );
            fs.symlinkSync(outside, symlinkPath);

            const nextEffect = publishBatchGraphPlanInProcess({
                engine: { ...effectEngine, version: '7.0.0-effect-next' },
                overlayPath: stock.overlayPath,
                project: projectRequest,
                plan: stockPlan,
                collisionFallbackReasons: []
            });
            assert.strictEqual(nextEffect.writeStatus, 'written', JSON.stringify(nextEffect));
            assert.strictEqual(regularMaterialisationPlanFiles(stock.overlayPath).length, 2);
            assert.ok(fs.lstatSync(symlinkPath).isSymbolicLink());
            assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
        } finally {
            if (previousPackage === undefined) {
                delete process.env.SVELTE_LS_TSGO_PACKAGE;
            } else {
                process.env.SVELTE_LS_TSGO_PACKAGE = previousPackage;
            }
        }
    });

    const declaredFallbackInvalidations: Array<{
        name: string;
        prepare?: (root: string) => void;
        mutate: (root: string) => void;
        expectedReasons: string[];
    }> = [
        {
            name: 'dependency source creation',
            mutate(root: string) {
                fs.writeFileSync(
                    path.join(root, 'node_modules/controls/NewButton.svelte'),
                    '<button>new</button>'
                );
            },
            expectedReasons: ['directory-membership-mismatch']
        },
        {
            name: 'dependency source deletion',
            mutate(root: string) {
                fs.unlinkSync(path.join(root, 'node_modules/controls/Button.svelte'));
            },
            expectedReasons: ['input-missing', 'directory-membership-mismatch']
        },
        {
            name: 'project manifest mutation',
            mutate(root: string) {
                const manifestPath = path.join(root, 'package.json');
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                manifest.optionalDependencies = { optionalControls: '1.0.0' };
                fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            },
            expectedReasons: ['exact-content-mismatch']
        },
        {
            name: 'extended TypeScript configuration mutation',
            prepare(root: string) {
                fs.writeFileSync(
                    path.join(root, 'base.json'),
                    JSON.stringify({ compilerOptions: { strict: true } })
                );
                const configPath = path.join(root, 'tsconfig.json');
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                config.extends = './base.json';
                delete config.compilerOptions.strict;
                fs.writeFileSync(configPath, JSON.stringify(config));
            },
            mutate(root: string) {
                fs.writeFileSync(
                    path.join(root, 'base.json'),
                    JSON.stringify({ compilerOptions: { strict: false } })
                );
            },
            expectedReasons: ['exact-content-mismatch']
        }
    ];
    for (const scenario of declaredFallbackInvalidations) {
        it(`invalidates a declared-fallback plan after ${scenario.name}`, async () => {
            const root = declaredFallbackProject();
            scenario.prepare?.(root);
            const first = await overlay(root);
            const cold = await first.materialise();
            assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

            scenario.mutate(root);
            TsGoBatchOverlay.invalidateWorkspaceIndex();
            const second = await overlay(root);
            const rebuilt = await second.materialise();

            assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
            assert.ok(
                scenario.expectedReasons.includes(
                    rebuilt.graph.materialisationPlan.missReason ?? ''
                ),
                JSON.stringify(rebuilt.graph.materialisationPlan)
            );
        });
    }

    it('invalidates a declared-fallback plan when a package symlink is retargeted', async () => {
        const root = declaredFallbackProject();
        const installed = path.join(root, 'node_modules/controls');
        const stores = [
            path.join(root, 'node_modules/.pnpm/controls-a/node_modules/controls'),
            path.join(root, 'node_modules/.pnpm/controls-b/node_modules/controls')
        ];
        for (const store of stores) {
            fs.mkdirSync(path.dirname(store), { recursive: true });
            fs.cpSync(installed, store, { recursive: true });
        }
        fs.rmSync(installed, { recursive: true });
        fs.symlinkSync(stores[0], installed, 'junction');

        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');

        fs.unlinkSync(installed);
        fs.symlinkSync(stores[1], installed, 'junction');
        TsGoBatchOverlay.invalidateWorkspaceIndex();
        const second = await overlay(root);
        const rebuilt = await second.materialise();

        assert.strictEqual(rebuilt.graph.materialisationPlan.hit, false);
        assert.ok(
            ['input-kind-changed', 'directory-membership-mismatch'].includes(
                rebuilt.graph.materialisationPlan.missReason ?? ''
            ),
            JSON.stringify(rebuilt.graph.materialisationPlan)
        );
    });

    it('restores pnpm package-root aliases and emits the identical warm overlay', async () => {
        const root = declaredFallbackProject();
        const installed = path.join(root, 'node_modules/controls');
        const store = path.join(root, 'node_modules/.pnpm/controls@1.0.0/node_modules/controls');
        fs.mkdirSync(path.dirname(store), { recursive: true });
        fs.renameSync(installed, store);
        fs.symlinkSync(store, installed, 'junction');

        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.graph.materialisationPlan.writeStatus, 'written');
        const coldConfig = JSON.parse(fs.readFileSync(first.overlayTsconfigPath, 'utf8'));
        const realStore = fs.realpathSync.native(store).replace(/\\/g, '/');
        assert.ok(coldConfig.compilerOptions.rootDirs.includes(realStore));

        // Model the next checker/editor process: the disk plan remains, while every shared
        // discovery/realpath index starts empty.
        TsGoBatchOverlay.invalidateWorkspaceIndex();
        const second = await overlay(root);
        const warm = await second.materialise();
        const warmConfig = JSON.parse(fs.readFileSync(second.overlayTsconfigPath, 'utf8'));

        assert.strictEqual(warm.graph.materialisationPlan.hit, true);
        assert.deepStrictEqual(
            warmConfig.compilerOptions.rootDirs,
            coldConfig.compilerOptions.rootDirs
        );
        assert.deepStrictEqual(warmConfig.compilerOptions.paths, coldConfig.compilerOptions.paths);
        assert.deepStrictEqual(warmConfig.files, coldConfig.files);
    });

    it('does not persist an incomplete declared dependency closure', async () => {
        const root = declaredFallbackProject();
        const manifestPath = path.join(root, 'node_modules/controls/package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.dependencies = [];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));

        const batch = await overlay(root);
        const result = await batch.materialise();

        assert.strictEqual(result.graph.dependencyScope.mode, 'declared-fallback');
        assert.strictEqual(result.graph.dependencyScope.closureComplete, false);
        assert.ok(
            result.graph.dependencyScope.fallbackReasons.some((reason) =>
                reason.includes('invalid-declared-dependency-field:')
            )
        );
        assert.strictEqual(result.graph.materialisationPlan.eligible, false);
        assert.strictEqual(result.graph.materialisationPlan.writeStatus, 'skipped');
    });

    it('skips mirror reconciliation and pruning on an identity-perfect collision warm run', async () => {
        const root = project(
            {
                'src/Widget.svelte':
                    '<script lang="ts">import { helper } from "./Widget.svelte.js"; export let label: string;</script><p>{label}{helper}</p>',
                'src/Widget.svelte.ts': 'export const helper = "ok";\n',
                'src/index.ts':
                    'import Widget from "./Widget.svelte"; new Widget({ target: document.body, props: { label: "ok" } });\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.strictEqual(cold.svelte.candidateCount, 1);
        assert.ok(cold.sourceMirrors.candidateCount > 0);
        assert.strictEqual(
            cold.sourceMirrors.copiedCount + cold.sourceMirrors.rewrittenCount,
            cold.sourceMirrors.candidateCount
        );

        const second = await overlay(root);
        const shadows = (second as any).shadows;
        const originalReconcile = shadows.reconcileBatchMirrorOwnership.bind(shadows);
        const originalPrune = shadows.pruneOrphanedShadows.bind(shadows);
        let reconcileCalls = 0;
        let pruneCalls = 0;
        shadows.reconcileBatchMirrorOwnership = (...args: unknown[]) => {
            reconcileCalls++;
            return originalReconcile(...args);
        };
        shadows.pruneOrphanedShadows = (...args: unknown[]) => {
            pruneCalls++;
            return originalPrune(...args);
        };

        const warm = await second.materialise();

        assert.strictEqual(warm.transformedCount, 0);
        assert.strictEqual(warm.writtenCount, 0);
        assert.strictEqual(warm.sourceMirrors.reusedCount, warm.sourceMirrors.candidateCount);
        assert.strictEqual(warm.cleanup.skipped, true);
        assert.strictEqual(reconcileCalls, 0);
        assert.strictEqual(pruneCalls, 0);
    });

    it('reconciles and prunes when a previously materialised component is deleted', async () => {
        const root = project(
            {
                'src/Widget.svelte':
                    '<script lang="ts">import { helper } from "./Widget.svelte.js"; export let label: string;</script><p>{label}{helper}</p>',
                'src/Widget.svelte.ts': 'export const helper = "ok";\n',
                'src/index.ts': 'import Widget from "./Widget.svelte"; void Widget;\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        await first.materialise();
        const state = JSON.parse(
            fs.readFileSync(path.join(first.overlayPath, 'batch-state.json'), 'utf8')
        );
        const componentEntry = state.entries[path.join(root, 'src/Widget.svelte')];
        const sourceEntry = state.entries[path.join(root, 'src/index.ts')];
        assert.ok(componentEntry?.shadowPath);
        assert.ok(sourceEntry?.shadowPath);
        fs.unlinkSync(path.join(root, 'src/Widget.svelte'));

        const second = await overlay(root);
        const shadows = (second as any).shadows;
        const originalPrune = shadows.pruneOrphanedShadows.bind(shadows);
        let pruneCalls = 0;
        shadows.pruneOrphanedShadows = (...args: unknown[]) => {
            pruneCalls++;
            return originalPrune(...args);
        };

        await second.materialise();

        assert.strictEqual(pruneCalls, 1);
        assert.ok(!fs.existsSync(componentEntry.shadowPath));
        assert.ok(!fs.existsSync(sourceEntry.shadowPath));
    });

    it('does not relocate fallback Svelte shims into a cache-only node_modules', async () => {
        const root = project(
            { 'src/Comp.svelte': '<p>fallback compiler</p>' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );

        const first = await overlay(root);
        await first.materialise();
        assert.ok(fs.existsSync(path.join(root, 'node_modules', '.cache')));

        // Recreate after the overlay itself has made node_modules. This used to move the shims
        // into the fixture even though no `svelte` package was resolvable from there.
        const second = await overlay(root);
        const config = JSON.parse(fs.readFileSync(second.overlayTsconfigPath, 'utf8'));
        const shims = (config.files as string[]).filter((file) =>
            /svelte-(?:shims|native-jsx)/.test(file.replace(/\\/g, '/'))
        );
        assert.ok(shims.length > 0);
        assert.ok(
            shims.every(
                (file) =>
                    !file
                        .replace(/\\/g, '/')
                        .startsWith(`${root.replace(/\\/g, '/')}/node_modules/`)
            ),
            `fallback shims must stay beside fallback Svelte: ${JSON.stringify(shims)}`
        );
    });

    it('reuses by content stamp when only source metadata changed', async () => {
        const root = project(
            { 'src/Comp.svelte': '<script lang="ts">export let foo: number;</script>' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );
        const source = path.join(root, 'src/Comp.svelte');
        const first = await overlay(root);
        await first.materialise();
        const shadow = componentShadow(first, 'src/Comp.svelte');
        const shadowMtime = fs.statSync(shadow).mtimeMs;
        const sourceStat = fs.statSync(source);
        fs.utimesSync(source, sourceStat.atime, new Date(sourceStat.mtimeMs + 2_000));

        const second = await overlay(root);
        const warm = await second.materialise();
        const state = JSON.parse(
            fs.readFileSync(path.join(second.overlayPath, 'batch-state.json'), 'utf8')
        );

        assert.strictEqual(warm.transformedCount, 0);
        assert.strictEqual(warm.reusedCount, 1);
        assert.strictEqual(warm.writtenCount, 0);
        assert.strictEqual(fs.statSync(shadow).mtimeMs, shadowMtime);
        assert.strictEqual(state.version, 5);
        assert.match(state.entries[source.replace(/\\/g, '/')].sourceContentStamp, /^[\w-]{40,}$/);
    });

    it('reuses an output after a metadata-only touch and refreshes its persisted stat', async () => {
        const root = project(
            { 'src/Comp.svelte': '<script lang="ts">const value = 1;</script><p>{value}</p>' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        await first.materialise();
        const shadow = componentShadow(first, 'src/Comp.svelte');
        const before = fs.statSync(shadow);
        const touched = new Date(before.mtimeMs + 2_000);
        fs.utimesSync(shadow, before.atime, touched);

        const second = await overlay(root);
        const warm = await second.materialise();

        assert.strictEqual(warm.svelte.transformedCount, 0);
        assert.strictEqual(warm.svelte.reusedCount, 1);
        assert.strictEqual(warm.svelte.writtenCount, 0);
        assert.strictEqual(fs.statSync(shadow).mtimeMs, touched.getTime());
    });

    it('rewrites a shadow replaced with foreign bytes even when its source is unchanged', async () => {
        const root = project(
            { 'src/Comp.svelte': '<script lang="ts">const value = 1;</script><p>{value}</p>' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        await first.materialise();
        const shadow = componentShadow(first, 'src/Comp.svelte');
        const authoritative = fs.readFileSync(shadow, 'utf8');
        fs.writeFileSync(shadow, '/* foreign overwrite */\n');

        const second = await overlay(root);
        const repaired = await second.materialise();

        assert.strictEqual(repaired.svelte.transformedCount, 1);
        assert.strictEqual(repaired.svelte.writtenCount, 1);
        assert.strictEqual(fs.readFileSync(shadow, 'utf8'), authoritative);
    });

    it('rewrites a source mirror replaced with foreign bytes', async () => {
        const root = project(
            {
                'src/Widget.svelte':
                    '<script lang="ts">import { helper } from "./Widget.svelte.js";</script><p>{helper}</p>',
                'src/Widget.svelte.ts': 'export const helper = "ok";\n',
                'src/index.ts': 'import Widget from "./Widget.svelte"; void Widget;\n'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const first = await overlay(root);
        const cold = await first.materialise();
        assert.ok(cold.sourceMirrors.candidateCount > 0);
        const state = JSON.parse(
            fs.readFileSync(path.join(first.overlayPath, 'batch-state.json'), 'utf8')
        );
        const mirrored = Object.values(state.entries).find(
            (entry: any) => entry.mirrorKind === 'script'
        ) as { shadowPath: string } | undefined;
        assert.ok(mirrored, JSON.stringify(state.entries));
        const authoritative = fs.readFileSync(mirrored.shadowPath, 'utf8');
        fs.writeFileSync(mirrored.shadowPath, '/* foreign overwrite */\n');

        const second = await overlay(root);
        const repaired = await second.materialise();

        assert.ok(repaired.sourceMirrors.rewrittenCount >= 1);
        assert.ok(repaired.sourceMirrors.writtenCount >= 1);
        assert.strictEqual(fs.readFileSync(mirrored.shadowPath, 'utf8'), authoritative);
    });

    it('invalidates a same-size edit even when its mtime is restored', async () => {
        const original = '<script lang="ts">export let foo: number;</script>';
        const replacement = '<script lang="ts">export let bar: number;</script>';
        assert.strictEqual(original.length, replacement.length);
        const root = project(
            { 'src/Comp.svelte': original },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );
        const source = path.join(root, 'src/Comp.svelte');
        const first = await overlay(root);
        await first.materialise();
        const priorStat = fs.statSync(source);

        fs.writeFileSync(source, replacement);
        fs.utimesSync(source, priorStat.atime, priorStat.mtime);

        const second = await overlay(root);
        const changed = await second.materialise();
        const generated = fs.readFileSync(componentShadow(second, 'src/Comp.svelte'), 'utf8');

        assert.strictEqual(changed.transformedCount, 1);
        assert.strictEqual(changed.reusedCount, 0);
        assert.strictEqual(changed.writtenCount, 1);
        assert.match(generated, /let bar/);
        assert.doesNotMatch(generated, /let foo/);
    });

    it('loads an explicit Svelte config before transforming', async () => {
        const root = project(
            {
                'src/Comp.svelte': '<script lang="ts">export let foo: number;</script>',
                'custom.config.cjs': 'module.exports = { compilerOptions: { accessors: true } };'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );
        const batch = await overlay(root, path.join(root, 'custom.config.cjs'));
        await batch.materialise();

        const generated = fs.readFileSync(componentShadow(batch, 'src/Comp.svelte'), 'utf-8');
        assert.match(
            generated,
            /get foo\(\)/,
            `the accessors config must affect generated types:\n${generated}`
        );
    });

    it('shares one project config load between Kit settings and component transforms', async () => {
        const root = project(
            {
                'src/Comp.svelte': '<script lang="ts">export let foo: number;</script>',
                'src/custom-params/id.ts':
                    'export function match(value: string): boolean { return value.length > 0; }'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte', 'src/**/*.ts']
            }
        );
        const marker = path.join(root, 'config-load-count');
        fs.writeFileSync(
            path.join(root, 'svelte.config.cjs'),
            `const fs = require('fs');
const marker = ${JSON.stringify(marker)};
const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0;
fs.writeFileSync(marker, String(count + 1));
module.exports = {
    compilerOptions: { accessors: true },
    kit: { files: { params: 'src/custom-params' } }
};`
        );

        const batch = await overlay(root);
        const result = await batch.materialise();
        const generated = fs.readFileSync(componentShadow(batch, 'src/Comp.svelte'), 'utf8');

        assert.strictEqual(fs.readFileSync(marker, 'utf8'), '1');
        assert.strictEqual(result.supportFiles.kitShadowCount, 1);
        assert.match(generated, /get foo\(\)/);
    });

    it('does not execute unrelated workspace configs when reachability is complete', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-batch-config-scope-'));
        temporaryProjects.push(root);
        const checked = path.join(root, 'apps/checked');
        const unrelated = path.join(root, 'apps/unrelated');
        const marker = path.join(root, 'unrelated-config-loaded');
        fs.mkdirSync(path.join(checked, 'src'), { recursive: true });
        fs.mkdirSync(unrelated, { recursive: true });
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({ name: 'workspace', private: true, workspaces: ['apps/*'] })
        );
        fs.writeFileSync(
            path.join(checked, 'package.json'),
            JSON.stringify({ name: 'checked', private: true })
        );
        fs.writeFileSync(
            path.join(checked, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler'
                },
                include: ['src/**/*.svelte']
            })
        );
        fs.writeFileSync(path.join(checked, 'src/App.svelte'), '<p>checked</p>');
        fs.writeFileSync(
            path.join(unrelated, 'svelte.config.cjs'),
            `require('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); module.exports = {};`
        );

        const batch = await TsGoBatchOverlay.create({
            workspacePath: checked,
            tsconfigPath: path.join(checked, 'tsconfig.json')
        });
        assert.ok(batch);
        await batch.materialise();

        assert.strictEqual(fs.existsSync(marker), false);
    });

    it('applies namespace, custom-element and default-language config to batch shadows', async () => {
        const root = project(
            {
                'src/Custom.svelte':
                    '<script>export let foo: number;</script><element someAttr="value" />',
                'src/Other.svelte': '<script>export let bar: number;</script>',
                'custom.config.cjs': `module.exports = {
                    compilerOptions: {
                        namespace: 'foreign',
                        customElement: ({ filename }) => filename.endsWith('Custom.svelte')
                    },
                    preprocess: { defaultLanguages: { script: 'ts' } }
                };`
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );
        const batch = await overlay(root, path.join(root, 'custom.config.cjs'));
        await batch.materialise();

        const custom = fs.readFileSync(componentShadow(batch, 'src/Custom.svelte'), 'utf-8');
        const other = fs.readFileSync(componentShadow(batch, 'src/Other.svelte'), 'utf-8');
        assert.match(custom, /let foo: number/, 'defaultLanguages.script must select TypeScript');
        assert.match(custom, /"someAttr"/, 'the foreign namespace must preserve attribute case');
        assert.match(custom, /get foo\(\)/, 'the selected custom element must expose accessors');
        assert.doesNotMatch(
            other,
            /get bar\(\)/,
            'a customElement filename predicate must not affect other components'
        );
    });

    it('selects each workspace package Svelte major independently', async () => {
        const root = project(
            {
                'packages/legacy/package.json': JSON.stringify({ name: 'legacy' }),
                'packages/legacy/src/Legacy.svelte':
                    '<script lang="ts">export let legacy: string;</script>',
                'packages/modern/package.json': JSON.stringify({ name: 'modern' }),
                'packages/modern/src/Modern.svelte':
                    '<script lang="ts">export let modern: string;</script>'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['packages/**/*.svelte']
            }
        );
        installSvelteCompiler(root, '4.2.20');
        installSvelteCompiler(path.join(root, 'packages/legacy'), '4.2.20');
        installSvelteCompiler(path.join(root, 'packages/modern'), '5.0.0');

        const batch = await overlay(root);
        await batch.materialise();
        const legacy = fs.readFileSync(
            componentShadow(batch, 'packages/legacy/src/Legacy.svelte'),
            'utf-8'
        );
        const modern = fs.readFileSync(
            componentShadow(batch, 'packages/modern/src/Modern.svelte'),
            'utf-8'
        );

        assert.match(legacy, /export default class/, 'the Svelte-4 package needs class output');
        assert.doesNotMatch(legacy, /__sveltets_2_isomorphic_component/);
        assert.match(
            modern,
            /__sveltets_2_isomorphic_component/,
            `the Svelte-5 package needs isomorphic output:\n${modern}`
        );
        assert.match(modern, /export default Modern__SvelteComponent_/);
    });

    it('reports parser errors even when the compiler produces no diagnostic for the shadow', async () => {
        const root = project(
            { 'src/Broken.svelte': '<script lang="ts">const ok = true;</script>\n{#if ok}}' },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*.svelte']
            }
        );
        const first = await overlay(root);
        await first.materialise();
        const coldDiagnostics = await first.mapDiagnostics([], path.join(root, 'tsconfig.json'));

        assert.strictEqual(coldDiagnostics.length, 1);
        assert.strictEqual(coldDiagnostics[0].diagnostics[0].code, -1);

        // Parser-error metadata is persisted alongside the warm-shadow state; otherwise reuse
        // would make a second check incorrectly clean.
        const second = await overlay(root);
        const warm = await second.materialise();
        const warmDiagnostics = await second.mapDiagnostics([], path.join(root, 'tsconfig.json'));
        assert.strictEqual(warm.reusedCount, 1);
        assert.strictEqual(warmDiagnostics[0].diagnostics[0].code, -1);
    });

    it('reports user-config no-input diagnostics masked by overlay roots without duplicating native output', async () => {
        const root = project(
            {},
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                files: []
            }
        );
        const batch = await overlay(root);
        await batch.materialise();
        const tsconfig = path.join(root, 'tsconfig.json');
        const diagnostics = await batch.mapDiagnostics([], tsconfig);

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].filePath, tsconfig);
        assert.strictEqual(diagnostics[0].diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].diagnostics[0].code, 18002);

        const configDiagnostic = diagnostics[0].diagnostics[0];
        const duplicate = await batch.mapDiagnostics(
            [
                {
                    filePath: null,
                    line: 0,
                    character: 0,
                    length: 1,
                    severity: configDiagnostic.severity!,
                    code: 18002,
                    message: configDiagnostic.message
                }
            ],
            tsconfig
        );
        assert.strictEqual(duplicate[0].diagnostics.length, 1);
    });

    it('does not leak bundled-TypeScript errors for options accepted by the native engine', async () => {
        const root = project(
            { 'src/Comp.svelte': '<p />' },
            {
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    deduplicatePackages: true
                },
                include: ['src/**/*.svelte']
            }
        );
        const batch = await overlay(root);
        await batch.materialise();
        const diagnostics = await batch.mapDiagnostics([], path.join(root, 'tsconfig.json'));

        assert.ok(
            diagnostics.every((entry) =>
                entry.diagnostics.every((diagnostic) => diagnostic.code !== 5023)
            ),
            JSON.stringify(diagnostics)
        );
    });

    it('leaves semantic configuration validation to native diagnostics', async () => {
        const root = project(
            { 'src/Comp.svelte': '<p />' },
            {
                compilerOptions: { moduleResolution: 'definitely-not-a-resolution-mode' },
                include: ['src/**/*.svelte']
            }
        );
        const batch = await overlay(root);
        await batch.materialise();
        const tsconfig = path.join(root, 'tsconfig.json');
        const parserOnly = await batch.mapDiagnostics([], tsconfig);

        assert.ok(
            parserOnly.every((entry) =>
                entry.diagnostics.every((diagnostic) => diagnostic.code !== 6046)
            ),
            JSON.stringify(parserOnly)
        );
        const native = await batch.mapDiagnostics(
            [
                {
                    filePath: null,
                    line: 0,
                    character: 0,
                    length: 1,
                    severity: DiagnosticSeverity.Error,
                    code: 6046,
                    message: "Argument for '--moduleResolution' option must be a valid mode."
                }
            ],
            tsconfig
        );
        assert.strictEqual(native.length, 1);
        assert.strictEqual(native[0].filePath, tsconfig);
        assert.strictEqual(native[0].diagnostics[0].code, 6046);
        const generated = JSON.parse(fs.readFileSync(batch.overlayTsconfigPath, 'utf-8'));
        assert.strictEqual(generated.extends, tsconfig);
        assert.strictEqual(generated.compilerOptions.moduleResolution, undefined);
    });

    it('preserves and maps related locations from real files and other Svelte shadows', async () => {
        const root = project(
            {
                'src/Comp.svelte': '<script lang="ts">let value: number = "wrong";</script>',
                'src/Other.svelte': '<script lang="ts">export let prop: string;</script>',
                'src/types.ts': 'export interface Options { count: number }'
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        await batch.materialise();
        const component = componentShadow(batch, 'src/Comp.svelte');
        const other = componentShadow(batch, 'src/Other.svelte');
        const componentText = fs.readFileSync(component, 'utf8');
        const otherText = fs.readFileSync(other, 'utf8');
        const primary = generatedPosition(componentText, 'value: number');
        const relatedShadow = generatedPosition(otherText, 'prop: string');
        const typesPath = path.join(root, 'src/types.ts');
        const nativeSvelteTypes = path.join(root, 'vendor/node_modules/svelte/types/index.d.ts');
        fs.mkdirSync(path.dirname(nativeSvelteTypes), { recursive: true });
        fs.writeFileSync(
            nativeSvelteTypes,
            'export interface ComponentConstructorOptions<Props> { props: Props }\n'
        );

        const mapped = await batch.mapDiagnostics(
            [
                {
                    filePath: component,
                    ...primary,
                    length: 'value'.length,
                    severity: DiagnosticSeverity.Error,
                    code: 2322,
                    message: 'Synthetic assignment failure',
                    relatedInformation: [
                        {
                            filePath: typesPath,
                            line: 0,
                            character: 'export interface Options { '.length,
                            length: 'count'.length,
                            message: 'Expected type is declared here'
                        },
                        {
                            filePath: other,
                            ...relatedShadow,
                            length: 'prop'.length,
                            message: 'Related component declaration'
                        }
                    ]
                },
                {
                    filePath: component,
                    ...primary,
                    length: 'value'.length,
                    severity: DiagnosticSeverity.Error,
                    code: 2741,
                    message: "Property 'prop' is missing",
                    relatedInformation: [
                        {
                            filePath: nativeSvelteTypes,
                            line: 0,
                            character: 'export interface ComponentConstructorOptions<Props> { '
                                .length,
                            length: 'props'.length,
                            message:
                                "The expected type comes from property 'props' which is declared here on type 'ComponentConstructorOptions<Props>'"
                        }
                    ]
                }
            ],
            path.join(root, 'tsconfig.json')
        );

        const diagnostic = mapped
            .find((entry) => entry.filePath.endsWith('Comp.svelte'))
            ?.diagnostics.find((entry) => entry.code === 2322);
        assert.ok(diagnostic);
        assert.deepStrictEqual(
            diagnostic.relatedInformation?.map((related) => related.location.uri),
            [pathToUrl(typesPath), pathToUrl(path.join(root, 'src/Other.svelte'))]
        );
        assert.ok(
            diagnostic.relatedInformation?.every(
                (related) => !/\.svelte\.[jt]sx(?:$|[?#])/.test(related.location.uri)
            )
        );
        const missingProps = mapped
            .find((entry) => entry.filePath.endsWith('Comp.svelte'))
            ?.diagnostics.find((entry) => entry.code === 2741);
        assert.ok(missingProps);
        assert.strictEqual(missingProps.relatedInformation, undefined);
    });

    it('maps Svelte-shadow related locations for diagnostics whose primary is a real TS file', async () => {
        const componentSource =
            '<script lang="ts">export let relatedProp: string;</script>\n<p>{relatedProp}</p>';
        const root = project(
            {
                'src/main.ts': 'const primary: number = "wrong";',
                'src/Related.svelte': componentSource
            },
            {
                compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
                include: ['src/**/*']
            }
        );
        const batch = await overlay(root);
        await batch.materialise();
        const mainPath = path.join(root, 'src/main.ts');
        const relatedShadow = componentShadow(batch, 'src/Related.svelte');
        const relatedShadowText = fs.readFileSync(relatedShadow, 'utf8');
        const relatedPosition = generatedPosition(relatedShadowText, 'relatedProp: string');

        const mapped = await batch.mapDiagnostics(
            [
                {
                    filePath: mainPath,
                    line: 0,
                    character: 'const '.length,
                    length: 'primary'.length,
                    severity: DiagnosticSeverity.Error,
                    code: 2322,
                    message: 'Synthetic assignment failure',
                    relatedInformation: [
                        {
                            filePath: relatedShadow,
                            ...relatedPosition,
                            length: 'relatedProp'.length,
                            message: 'Related component declaration'
                        }
                    ]
                }
            ],
            path.join(root, 'tsconfig.json')
        );

        const diagnostic = mapped
            .find((entry) => entry.filePath === mainPath)
            ?.diagnostics.find((entry) => entry.code === 2322);
        assert.ok(diagnostic);
        assert.strictEqual(diagnostic.source, undefined);
        assert.deepStrictEqual(diagnostic.relatedInformation, [
            {
                location: {
                    uri: pathToUrl(path.join(root, 'src/Related.svelte')),
                    range: {
                        start: { line: 0, character: componentSource.indexOf('relatedProp') },
                        end: {
                            line: 0,
                            character: componentSource.indexOf('relatedProp') + 'relatedProp'.length
                        }
                    }
                },
                message: 'Related component declaration'
            }
        ]);
        assert.ok(
            diagnostic.relatedInformation?.every(
                (related) => !/\.svelte\.[jt]sx(?:$|[?#])/.test(related.location.uri)
            )
        );
    });
});
