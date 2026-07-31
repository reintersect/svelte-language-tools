import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it } from 'mocha';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { TsGoBatchOverlay } from '../../../../src/plugins/typescript-go/lsp/BatchOverlay';
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
    const suffix = component.replace(/\\/g, '/') + '.tsx';
    const result = (config.files as string[]).find((file) =>
        file.replace(/\\/g, '/').endsWith(suffix)
    );
    assert.ok(result, `overlay config should contain a shadow ending in ${suffix}`);
    return result;
}

function generatedPosition(text: string, needle: string): { line: number; character: number } {
    const offset = text.indexOf(needle);
    assert.notStrictEqual(offset, -1, `generated output must contain ${needle}`);
    const before = text.slice(0, offset);
    const lines = before.split('\n');
    return { line: lines.length - 1, character: lines.at(-1)!.length };
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
        assert.strictEqual(warm.transformedCount, 0);
        assert.strictEqual(warm.reusedCount, 2);
        assert.strictEqual(fs.statSync(shadow).mtimeMs, mtime);
        assert.strictEqual(fs.statSync(dependencyShadow).mtimeMs, dependencyMtime);
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
        await first.materialise();

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
        assert.strictEqual(state.version, 4);
        assert.match(state.entries[source.replace(/\\/g, '/')].sourceContentStamp, /^[\w-]{40,}$/);
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

    it('reports invalid user configuration as diagnostics instead of failing materialisation', async () => {
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
        const diagnostics = await batch.mapDiagnostics([], tsconfig);

        assert.strictEqual(diagnostics.length, 1);
        assert.strictEqual(diagnostics[0].filePath, tsconfig);
        assert.ok(
            diagnostics[0].diagnostics.some((diagnostic) => diagnostic.code === 6046),
            JSON.stringify(diagnostics[0].diagnostics)
        );
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
                (related) => !related.location.uri.includes('.svelte.tsx')
            )
        );
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
                (related) => !related.location.uri.includes('.svelte.tsx')
            )
        );
    });
});
