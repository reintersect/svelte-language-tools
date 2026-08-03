import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, afterEach } from 'mocha';
import {
    computeBatchGraphSourceSignature,
    findWorkspaceRoot,
    invalidateTsGoWorkspaceIndex,
    ShadowManager
} from '../../../../src/plugins/typescript-go/lsp/ShadowManager';
import { configLoader } from '../../../../src/lib/documents/configLoader';
import { normalizePath } from '../../../../src/utils';

const monorepo = normalizePath(path.join(__dirname, '..', 'fixtures', 'monorepo'));
const appRoot = `${monorepo}/apps/app`;
const uiRoot = `${monorepo}/packages/ui`;
const nocfgRoot = `${monorepo}/packages/nocfg`;
const OVERLAY = 'node_modules/.cache/svelte-lsp';
const tempRoots: string[] = [];

const snapshotOptions = {
    parse: undefined,
    version: undefined,
    transformOnTemplateError: true,
    typingsNamespace: 'svelteHTML',
    emitJsDoc: true
};

function manager(projectRoot: string, tsconfigPath: string | undefined, writeConfig = true) {
    return new ShadowManager({
        projectPath: projectRoot,
        sourceRoot: monorepo,
        tsconfigPath,
        snapshotOptions,
        writeConfig
    });
}

function cleanOverlays() {
    configLoader.invalidateConfigs();
    for (const packageRoot of [monorepo, appRoot, uiRoot, nocfgRoot]) {
        fs.rmSync(path.join(packageRoot, 'node_modules'), { recursive: true, force: true });
        fs.rmSync(path.join(packageRoot, '.svelte-ls-overlay'), { recursive: true, force: true });
    }
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function tempProject() {
    const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-lsp-shadow-')));
    tempRoots.push(root);
    fs.mkdirSync(`${root}/src`, { recursive: true });
    fs.writeFileSync(`${root}/src/main.ts`, '');
    fs.writeFileSync(
        `${root}/tsconfig.json`,
        JSON.stringify({ files: ['./src/main.ts'], compilerOptions: { strict: true } })
    );
    return root;
}

function tempConfiglessProject() {
    const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-lsp-inferred-')));
    tempRoots.push(root);
    fs.mkdirSync(`${root}/src`, { recursive: true });
    return root;
}

describe('typescript-go ShadowManager', () => {
    afterEach(cleanOverlays);

    it('computes the same shadow path from every manager', () => {
        const appShadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        const uiShadows = manager(uiRoot, `${uiRoot}/tsconfig.json`);
        const fallbackShadows = manager(monorepo, undefined, false);

        const file = `${appRoot}/src/lib/Same.svelte`;
        const fromApp = appShadows.getShadowPath(file);
        assert.strictEqual(fromApp, uiShadows.getShadowPath(file));
        assert.strictEqual(fromApp, fallbackShadows.getShadowPath(file));
        // Source-root-relative inside the file's own package mirror.
        assert.strictEqual(
            fromApp,
            `${appRoot}/${OVERLAY}/svelte/apps/app/src/lib/Same.svelte.tsx`
        );
    });

    it('inverts a shadow path back to its original, even across sessions', () => {
        const shadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        const file = `${appRoot}/src/lib/Same.svelte`;
        const shadowPath = shadows.getShadowPath(file);
        assert.strictEqual(shadows.getOriginalPath(shadowPath), file);

        // A fresh manager that never computed the path (a shadow surviving from a previous
        // session) still inverts it, because the layout is deterministic.
        const fresh = manager(appRoot, `${appRoot}/tsconfig.json`);
        assert.strictEqual(fresh.getOriginalPath(shadowPath), file);
    });

    it('inverts a resource-operation target before the new source exists', () => {
        const shadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        const existing = `${appRoot}/src/lib/Same.svelte`;
        const existingShadow = shadows.getShadowPath(existing);
        const renamedShadow = existingShadow.replace('Same.svelte.tsx', 'Renamed.svelte.tsx');

        assert.ok(!fs.existsSync(`${appRoot}/src/lib/Renamed.svelte`));
        assert.strictEqual(
            shadows.getOriginalPath(renamedShadow),
            `${appRoot}/src/lib/Renamed.svelte`
        );
    });

    it('uses JSX for JavaScript shadows and TSX for every configured TypeScript form', async () => {
        const root = tempProject();
        const javascript = `${root}/src/JavaScript.svelte`;
        const explicitTypeScript = `${root}/src/ExplicitTypeScript.svelte`;
        const mixedTypeScript = `${root}/src/MixedTypeScript.svelte`;
        const configuredTypeScript = `${root}/src/ConfiguredTypeScript.svelte`;
        fs.writeFileSync(javascript, '<script>export let value;</script><p>{value}</p>');
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'import JavaScript from "./JavaScript.svelte"; void JavaScript;\n'
        );
        fs.writeFileSync(
            explicitTypeScript,
            '<script lang="ts">export let value: string;</script><p>{value}</p>'
        );
        fs.writeFileSync(
            mixedTypeScript,
            '<script module lang="ts">export const answer: number = 42;</script>' +
                '<script>export let value;</script><p>{value}{answer}</p>'
        );
        fs.mkdirSync(`${root}/configured`, { recursive: true });
        fs.writeFileSync(
            `${root}/configured/svelte.config.js`,
            'module.exports = { preprocess: { defaultLanguages: { script: "ts" } } };\n'
        );
        fs.writeFileSync(
            configuredTypeScript.replace('/src/', '/configured/'),
            '<script>export let value: string;</script><p>{value}</p>'
        );
        const configured = configuredTypeScript.replace('/src/', '/configured/');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        await shadows.refreshShadowKinds([
            javascript,
            explicitTypeScript,
            mixedTypeScript,
            configured
        ]);

        const javascriptShadow = shadows.getShadowPath(javascript);
        assert.ok(javascriptShadow.endsWith('.svelte.jsx'), javascriptShadow);
        assert.strictEqual(shadows.getOriginalPath(javascriptShadow), javascript);
        const fresh = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(fresh.getOriginalPath(javascriptShadow), javascript);
        assert.strictEqual(
            fresh.getOriginalPath(javascriptShadow.replace('.svelte.jsx', '.__svlt.jsx')),
            javascript
        );
        assert.ok(shadows.getShadowPath(explicitTypeScript).endsWith('.svelte.tsx'));
        assert.ok(shadows.getShadowPath(mixedTypeScript).endsWith('.svelte.tsx'));
        assert.ok(shadows.getShadowPath(configured).endsWith('.svelte.tsx'));

        shadows.writeOverlayTsconfig([]);
        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.strictEqual(config.compilerOptions.allowJs, true);
        assert.ok(config.files.includes(javascriptShadow));
        const tsSupport = JSON.parse(
            fs.readFileSync(`${root}/${OVERLAY}/tsconfig.ts-support.json`, 'utf8')
        );
        assert.strictEqual(tsSupport.compilerOptions.allowJs, true);
    });

    it('bounds navigation snapshots while retaining client-open snapshots', () => {
        const root = tempProject();
        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        const pinned = `${root}/src/Pinned.svelte`;
        fs.writeFileSync(pinned, '<p>pinned</p>');
        shadows.pinSnapshot(pinned);
        assert.ok(shadows.ensureSnapshot(pinned));

        for (let index = 0; index < 80; index++) {
            const file = `${root}/src/Nav${index}.svelte`;
            fs.writeFileSync(file, `<p>${index}</p>`);
            assert.ok(shadows.ensureSnapshot(file));
        }

        assert.strictEqual(shadows.snapshotCount, 64);
        assert.ok(shadows.getSnapshot(pinned), 'the open snapshot must remain pinned');
    });

    it('places a nested project shadow below its nearer tsconfig overlay', () => {
        const root = tempProject();
        const nested = `${root}/src/feature`;
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(`${nested}/tsconfig.json`, JSON.stringify({ files: ['./Comp.svelte'] }));
        fs.writeFileSync(`${nested}/Comp.svelte`, '<script>let value = 1;</script>');

        const shadows = new ShadowManager({
            projectPath: nested,
            sourceRoot: root,
            tsconfigPath: `${nested}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);
        const shadowPath = shadows.getShadowPath(`${nested}/Comp.svelte`);

        assert.ok(
            shadowPath.startsWith(`${nested}/${OVERLAY}/svelte/`),
            `nested shadow must be below the selecting config: ${shadowPath}`
        );
        assert.ok(
            shadowPath.startsWith(path.dirname(shadows.overlayTsconfigPath) + '/'),
            'tsgo must encounter the nested overlay config while walking upward from the shadow'
        );
    });

    it('materialises reachable path-alias and relative components outside include', () => {
        const root = tempProject();
        const app = `${root}/app`;
        fs.mkdirSync(`${app}/src`, { recursive: true });
        fs.mkdirSync(`${root}/ui`, { recursive: true });
        fs.mkdirSync(`${root}/shared`, { recursive: true });
        fs.mkdirSync(`${root}/unrelated`, { recursive: true });
        fs.writeFileSync(
            `${app}/src/App.svelte`,
            '<script>import Button from "@ui/Button.svelte"; import Other from "../../shared/Other.svelte";</script><Button/><Other/>'
        );
        fs.writeFileSync(`${root}/ui/Button.svelte`, '<button />');
        fs.writeFileSync(`${root}/shared/Other.svelte`, '<p />');
        fs.writeFileSync(`${root}/unrelated/Nope.svelte`, '<p />');
        fs.writeFileSync(
            `${app}/tsconfig.json`,
            JSON.stringify({
                compilerOptions: {
                    baseUrl: '.',
                    paths: { '@ui/*': ['../ui/*'] }
                },
                include: ['./src/**/*']
            })
        );
        const shadows = new ShadowManager({
            projectPath: app,
            sourceRoot: root,
            tsconfigPath: `${app}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(
            new Set(shadows.findProjectSvelteFiles()),
            new Set([
                `${app}/src/App.svelte`,
                `${root}/ui/Button.svelte`,
                `${root}/shared/Other.svelte`
            ])
        );
        assert.ok(!shadows.findProjectSvelteFiles().includes(`${root}/unrelated/Nope.svelte`));
    });

    it('traverses triple-slash path and workspace type-reference source edges', () => {
        const root = tempProject();
        fs.mkdirSync(`${root}/references`, { recursive: true });
        fs.mkdirSync(`${root}/types/custom`, { recursive: true });
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({
                files: ['./src/main.ts'],
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    typeRoots: ['./types']
                }
            })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            [
                '/// <reference path="../references/surface.d.ts" />',
                '/// <reference types="custom" />',
                'export const ready = true;'
            ].join('\n')
        );
        fs.writeFileSync(
            `${root}/references/surface.d.ts`,
            'export { default } from "../src/PathReferenced.svelte";'
        );
        fs.writeFileSync(
            `${root}/types/custom/index.d.ts`,
            'export { default } from "../../src/TypeReferenced.svelte";'
        );
        const pathComponent = `${root}/src/PathReferenced.svelte`;
        const typeComponent = `${root}/src/TypeReferenced.svelte`;
        fs.writeFileSync(pathComponent, '<p>path</p>');
        fs.writeFileSync(typeComponent, '<p>types</p>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(
            new Set(shadows.findProjectSvelteFiles()),
            new Set([pathComponent, typeComponent])
        );
        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, []);
        const plan = shadows.exportBatchGraphPlan();
        const mainEdges = new Map(plan.batchForwardSourceEdges).get(`${root}/src/main.ts`);
        assert.ok(mainEdges?.includes(`${root}/references/surface.d.ts`));
        assert.ok(mainEdges?.includes(`${root}/types/custom/index.d.ts`));
    });

    it('fails closed when a triple-slash path reference cannot be resolved', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/src/main.ts`,
            '/// <reference path="./Missing.d.ts" />\nexport const ready = true;'
        );
        const fallback = `${root}/src/Fallback.svelte`;
        fs.writeFileSync(fallback, '<p>fallback</p>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, [
            `unresolved-reference:${root}/src/main.ts:./Missing.d.ts`
        ]);
        assert.ok(shadows.findProjectSvelteFiles().includes(fallback));
    });

    it('resolves package imports with wildcard, array and conditional Svelte targets', () => {
        const root = tempProject();
        fs.mkdirSync(`${root}/src/components`, { recursive: true });
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'private-imports',
                imports: {
                    '#components/*': {
                        types: './src/components/*.d.svelte.ts',
                        svelte: './src/components/*.svelte',
                        default: './src/components/*.svelte'
                    },
                    '#raw': ['./src/missing.svelte', './src/Raw.svelte'],
                    '#declared': './src/Declared.d.svelte.ts'
                }
            })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            [
                'import Button from "#components/Button";',
                'import Raw from "#raw";',
                'import Declared from "#declared";',
                'void [Button, Raw, Declared];'
            ].join('\n')
        );
        const button = `${root}/src/components/Button.svelte`;
        const raw = `${root}/src/Raw.svelte`;
        const declared = `${root}/src/Declared.svelte`;
        fs.writeFileSync(button, '<button />');
        fs.writeFileSync(
            `${root}/src/components/Button.d.svelte.ts`,
            'export default class Button {}'
        );
        fs.writeFileSync(raw, '<p>raw</p>');
        fs.writeFileSync(declared, '<p>declared</p>');
        fs.writeFileSync(`${root}/src/Declared.d.svelte.ts`, 'export default class Declared {}');
        fs.writeFileSync(`${root}/src/Unrelated.svelte`, '<p>unrelated</p>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(new Set(shadows.findProjectSvelteFiles()), new Set([raw]));
        const graphInputs = new Set(
            shadows.exportBatchGraphPlan().sourceInputs.map(({ path }) => path)
        );
        assert.ok(graphInputs.has(button));
        assert.ok(graphInputs.has(declared));
        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, []);
    });

    it('expands literal import.meta.glob patterns without widening to the workspace', () => {
        const root = tempProject();
        fs.mkdirSync(`${root}/src/views/nested`, { recursive: true });
        fs.mkdirSync(`${root}/src/loaders`, { recursive: true });
        fs.writeFileSync(
            `${root}/src/main.ts`,
            [
                'const views = import.meta.glob(["./views/**/*.svelte", "!./views/Skip.svelte"]);',
                'const loaders = import.meta.glob("./loaders/*.ts", { eager: true });',
                'void [views, loaders];'
            ].join('\n')
        );
        const direct = `${root}/src/views/Direct.svelte`;
        const nested = `${root}/src/views/nested/Nested.svelte`;
        const lazy = `${root}/src/Lazy.svelte`;
        fs.writeFileSync(direct, '<p>direct</p>');
        fs.writeFileSync(nested, '<p>nested</p>');
        fs.writeFileSync(`${root}/src/views/Skip.svelte`, '<p>skip</p>');
        fs.writeFileSync(`${root}/src/Unrelated.svelte`, '<p>unrelated</p>');
        fs.writeFileSync(
            `${root}/src/loaders/load.ts`,
            'export { default } from "../Lazy.svelte";'
        );
        fs.writeFileSync(lazy, '<p>lazy</p>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(
            new Set(shadows.findProjectSvelteFiles()),
            new Set([direct, nested, lazy])
        );
        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, []);
    });

    it('falls back to the complete workspace corpus for computed component imports', () => {
        const root = tempProject();
        fs.mkdirSync(`${root}/build/deep`, { recursive: true });
        fs.mkdirSync(`${root}/.hidden`, { recursive: true });
        fs.mkdirSync(`${root}/.claude/worktrees/other`, { recursive: true });
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'const name = "Comp"; void import(`../build/deep/${name}.svelte`);'
        );
        fs.writeFileSync(`${root}/build/deep/Comp.svelte`, '<p />');
        fs.writeFileSync(`${root}/.hidden/Other.svelte`, '<p />');
        fs.writeFileSync(`${root}/.claude/worktrees/other/.git`, 'gitdir: /tmp/other.git');
        fs.writeFileSync(`${root}/.claude/worktrees/other/Foreign.svelte`, '<p />');
        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(
            new Set(shadows.findProjectSvelteFiles()),
            new Set([`${root}/build/deep/Comp.svelte`, `${root}/.hidden/Other.svelte`])
        );
        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, [
            `computed-import:${root}/src/main.ts`
        ]);
    });

    it('records computed glob ambiguity and resets its graph cache by generation', () => {
        const root = tempProject();
        fs.writeFileSync(`${root}/src/All.svelte`, '<p />');
        fs.writeFileSync(`${root}/src/main.ts`, 'const all = import.meta.glob("./*.svelte");');
        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);
        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, []);

        fs.writeFileSync(
            `${root}/src/main.ts`,
            'const pattern = "./*.svelte"; const all = import.meta.glob(pattern);'
        );
        shadows.invalidateStructuralCaches();
        shadows.writeOverlayTsconfig([]);
        assert.deepStrictEqual(shadows.reachabilityFallbackReasons, [
            `computed-import-meta-glob:${root}/src/main.ts`
        ]);
        assert.ok(shadows.findProjectSvelteFiles().includes(`${root}/src/All.svelte`));
    });

    it('round-trips a signed batch graph plan with split freshness evidence', () => {
        const root = tempProject();
        fs.mkdirSync(`${root}/config`, { recursive: true });
        fs.mkdirSync(`${root}/src/lib`, { recursive: true });
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'plan-app', imports: { '#lib/*': './src/lib/*' } })
        );
        fs.writeFileSync(
            `${root}/config/base.json`,
            JSON.stringify({ compilerOptions: { strict: true, resolveJsonModule: true } })
        );
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({
                extends: './config/base.json',
                include: ['./src/**/*.ts', './src/**/*.svelte']
            })
        );
        const mainText = [
            'import Button from "#lib/Button.svelte";',
            'import helper from "#lib/helper";',
            'export { Button, helper };'
        ].join('\n');
        fs.writeFileSync(`${root}/src/main.ts`, mainText);
        fs.writeFileSync(`${root}/src/lib/Button.svelte`, '<button />');
        fs.writeFileSync(`${root}/src/lib/Button.svelte.ts`, 'export const rune = true;');
        fs.writeFileSync(`${root}/src/lib/helper.ts`, 'export default 1;');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.getProjectSvelteFileNames();
        shadows.findProjectSvelteFiles();
        shadows.findDependencySvelteFiles();
        assert.strictEqual(shadows.prepareBatchModuleMirrors(), true);
        const originalStats = shadows.getBatchMirrorStats();
        const originalEntries = shadows.getBatchSourceMirrorEntries();
        const plan = shadows.exportBatchGraphPlan();

        assert.match(plan.signature, /^[0-9a-f]{64}$/);
        assert.deepStrictEqual(plan.configInputs.sort(), [
            `${root}/config/base.json`,
            `${root}/tsconfig.json`
        ]);
        assert.ok(plan.manifestInputs.includes(`${root}/package.json`));
        assert.ok(plan.directoryRoots.includes(root));
        assert.deepStrictEqual(
            plan.sourceInputs.find((input) => input.path === `${root}/src/main.ts`),
            {
                path: `${root}/src/main.ts`,
                signature: computeBatchGraphSourceSignature(mainText)
            }
        );
        assert.strictEqual(
            computeBatchGraphSourceSignature(`${mainText}\nconst bodyOnly = 1;`),
            computeBatchGraphSourceSignature(`${mainText}\nconst bodyOnly = 2;`),
            'body-only edits must not invalidate the import graph'
        );
        assert.notStrictEqual(
            computeBatchGraphSourceSignature(mainText),
            computeBatchGraphSourceSignature(`${mainText}\nimport "./new-edge";`)
        );
        assert.notStrictEqual(
            computeBatchGraphSourceSignature(mainText),
            computeBatchGraphSourceSignature(
                `/// <reference path="./new-surface.d.ts" />\n${mainText}`
            )
        );
        assert.notStrictEqual(
            computeBatchGraphSourceSignature(mainText),
            computeBatchGraphSourceSignature(
                `/// <reference types="new-ambient-package" />\n${mainText}`
            )
        );

        const restored = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(restored.restoreBatchGraphPlan(JSON.parse(JSON.stringify(plan))), true);
        assert.strictEqual(restored.getBatchGraphPlanSignature(), plan.signature);
        assert.strictEqual(restored.prepareBatchModuleMirrors(), true);
        assert.deepStrictEqual(restored.getBatchMirrorStats(), originalStats);
        assert.deepStrictEqual(restored.getBatchSourceMirrorEntries(), originalEntries);
    });

    it('rejects malformed, tampered and cross-project batch graph plans atomically', () => {
        const root = tempProject();
        fs.writeFileSync(`${root}/package.json`, JSON.stringify({ name: 'plan-app' }));
        fs.writeFileSync(`${root}/src/main.ts`, 'export const value = 1;');
        const source = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        source.writeOverlayTsconfig([]);
        const plan = source.exportBatchGraphPlan();
        const target = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });

        assert.strictEqual(target.restoreBatchGraphPlan({ version: 1 }), false);
        const tampered = JSON.parse(JSON.stringify(plan));
        tampered.batchForwardSourceEdges = [['relative.ts', []]];
        assert.strictEqual(target.restoreBatchGraphPlan(tampered), false);
        assert.strictEqual(target.restoreBatchGraphPlan(plan), true);

        const otherRoot = tempProject();
        const other = new ShadowManager({
            projectPath: otherRoot,
            sourceRoot: otherRoot,
            tsconfigPath: `${otherRoot}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(other.restoreBatchGraphPlan(plan), false);
    });

    it('writes an overlay tsconfig with shadows in files, merged rootDirs and an empty include', () => {
        const shadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        shadows.writeOverlayTsconfig([]);

        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        // An explicit empty include prevents an inherited include glob from pulling the real
        // twins of mirrored sources back into the native program.
        assert.deepStrictEqual(config.include, []);
        assert.strictEqual(config.extends, `${appRoot}/tsconfig.json`);
        assert.ok(
            config.files.includes(`${appRoot}/${OVERLAY}/svelte/apps/app/src/lib/Same.svelte.tsx`),
            'the app component shadow must be a root file'
        );

        const rootDirs: string[] = config.compilerOptions.rootDirs;
        // The base config's own entries survive (resolved absolute), first.
        assert.ok(rootDirs.includes(appRoot), 'SvelteKit ".." rootDir must survive');
        assert.ok(rootDirs.includes(`${appRoot}/.svelte-kit/types`));
        // The pairing that keeps package-relative suffixes (./$types) bridging.
        assert.ok(
            rootDirs.indexOf(`${appRoot}/${OVERLAY}/svelte/apps/app`) >
                rootDirs.indexOf(`${appRoot}/.svelte-kit/types`),
            'own-mirror pairing entry must come after the base entries'
        );
        assert.ok(rootDirs.includes(monorepo), 'the source root must be a rootDir');
        assert.ok(
            !rootDirs.includes(`${uiRoot}/${OVERLAY}/svelte`),
            'an unreachable sibling package must not widen this project'
        );
    });

    it('writes a pure-extends shim for packages without their own tsconfig', () => {
        const root = tempProject();
        const noConfigPackage = `${root}/packages/nocfg`;
        fs.mkdirSync(`${noConfigPackage}/src`, { recursive: true });
        fs.writeFileSync(
            `${noConfigPackage}/package.json`,
            JSON.stringify({ name: 'nocfg', private: true })
        );
        fs.writeFileSync(`${noConfigPackage}/src/Comp.svelte`, '<p />');
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({ include: ['./packages/nocfg/src/**/*.svelte'] })
        );
        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        const shim = JSON.parse(
            fs.readFileSync(`${noConfigPackage}/${OVERLAY}/tsconfig.json`, 'utf8')
        );
        assert.deepStrictEqual(shim, { extends: shadows.overlayTsconfigPath });
    });

    it('never writes a config as the fallback manager, nor touches an existing one', () => {
        const overlayTsconfig = `${monorepo}/${OVERLAY}/tsconfig.json`;

        const shadows = manager(monorepo, undefined, false);
        shadows.writeOverlayTsconfig([]);
        assert.ok(!fs.existsSync(overlayTsconfig), 'the fallback manager writes no config');

        // A real project can share the directory (app tsconfig at the workspace root); its
        // overlay must survive the fallback manager.
        fs.mkdirSync(path.dirname(overlayTsconfig), { recursive: true });
        fs.writeFileSync(overlayTsconfig, '{ "files": [] }');
        shadows.writeOverlayTsconfig([]);
        assert.ok(fs.existsSync(overlayTsconfig), 'an existing config is left alone');
    });

    it('writes a complete inferred overlay without clobbering configured nested packages', () => {
        const root = tempConfiglessProject();
        const app = `${root}/src/App.svelte`;
        const nestedRoot = `${root}/packages/ui`;
        const nested = `${nestedRoot}/src/Button.svelte`;
        const shim = `${root}/svelte-shims.d.ts`;
        fs.writeFileSync(app, '<script lang="ts">const value: number = "bad";</script>');
        fs.mkdirSync(path.dirname(nested), { recursive: true });
        fs.writeFileSync(`${nestedRoot}/package.json`, '{"name":"ui"}');
        fs.writeFileSync(nested, '<button />');
        fs.writeFileSync(shim, 'declare namespace svelteHTML {}');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: undefined,
            snapshotOptions,
            writeConfig: true,
            resolveShims: () => [shim],
            workspaceSvelteFiles: () => [app, nested]
        });
        shadows.writeOverlayTsconfig([shim]);

        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.strictEqual(config.extends, undefined);
        assert.ok(config.files.includes(shadows.getShadowPath(app)));
        assert.ok(config.files.includes(shadows.getShadowPath(nested)));
        assert.ok(config.files.includes(shim));
        assert.ok(config.compilerOptions.rootDirs.includes(root));

        const nestedConfig = JSON.parse(
            fs.readFileSync(`${nestedRoot}/${OVERLAY}/tsconfig.json`, 'utf8')
        );
        assert.deepStrictEqual(nestedConfig, { extends: shadows.overlayTsconfigPath });

        // A nested real project owns its own overlay and must not be replaced on the next pass.
        fs.writeFileSync(`${nestedRoot}/tsconfig.json`, '{"include":["src"]}');
        fs.writeFileSync(`${nestedRoot}/${OVERLAY}/tsconfig.json`, '{"files":["owned"]}');
        shadows.writeOverlayTsconfig([shim]);
        assert.deepStrictEqual(
            JSON.parse(fs.readFileSync(`${nestedRoot}/${OVERLAY}/tsconfig.json`, 'utf8')),
            { files: ['owned'] }
        );
    });

    it('keeps configless declaration-backed parser/CSS sources out of native shadows', () => {
        const root = tempConfiglessProject();
        const parser = `${root}/src/Parser.svelte`;
        const css = `${root}/src/Css.svelte`;
        fs.writeFileSync(parser, '{#if true}');
        fs.writeFileSync(`${root}/src/Parser.d.svelte.ts`, 'export default class Parser {}');
        fs.writeFileSync(
            css,
            '<style>p { iDunnoDisProperty: blue; }</style><p>diagnostic source</p>'
        );
        fs.writeFileSync(`${root}/src/Css.d.svelte.ts`, 'export default class Css {}');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: undefined,
            snapshotOptions,
            writeConfig: true,
            workspaceSvelteFiles: () => [parser, css]
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findProjectSvelteFiles().sort(), [css, parser].sort());
        assert.deepStrictEqual(
            shadows.getDeclarationBackedProjectSvelteFileNames().sort(),
            [css, parser].sort()
        );
        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.ok(!config.files.includes(shadows.getShadowPath(parser)));
        assert.ok(!config.files.includes(shadows.getShadowPath(css)));
    });

    it('does not promote an imported declaration-backed source to an explicit checker root', () => {
        const root = tempProject();
        const declared = `${root}/src/Declared.svelte`;
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'import Declared from "./Declared.svelte"; void Declared;'
        );
        fs.writeFileSync(declared, '<script>export let value;</script>');
        fs.writeFileSync(`${root}/src/Declared.d.svelte.ts`, 'export default class Declared {}');

        const importedOnly = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        importedOnly.writeOverlayTsconfig([]);
        assert.deepStrictEqual(importedOnly.findProjectSvelteFiles(), []);
        assert.ok(
            importedOnly
                .exportBatchGraphPlan()
                .sourceInputs.some((input) => input.path === declared),
            'the raw declaration sibling remains a graph/config input'
        );
        assert.deepStrictEqual(importedOnly.getDeclarationBackedProjectSvelteFileNames(), []);

        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({
                files: ['./src/main.ts', './src/Declared.svelte'],
                compilerOptions: { strict: true, allowArbitraryExtensions: true }
            })
        );
        const explicit = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        explicit.writeOverlayTsconfig([]);
        assert.deepStrictEqual(explicit.getDeclarationBackedProjectSvelteFileNames(), [declared]);
    });

    it('does not absorb or overwrite configured sibling workspaces during an inferred scan', () => {
        const root = tempConfiglessProject();
        const appRoot = `${root}/apps/app`;
        const app = `${appRoot}/src/App.svelte`;
        const siblingRoot = `${root}/packages/ui`;
        const sibling = `${siblingRoot}/src/Button.svelte`;
        const siblingOverlay = `${siblingRoot}/${OVERLAY}/tsconfig.json`;
        fs.mkdirSync(path.dirname(app), { recursive: true });
        fs.mkdirSync(path.dirname(sibling), { recursive: true });
        fs.mkdirSync(path.dirname(siblingOverlay), { recursive: true });
        fs.writeFileSync(`${appRoot}/package.json`, '{"name":"app"}');
        fs.writeFileSync(app, '<p />');
        fs.writeFileSync(`${siblingRoot}/package.json`, '{"name":"ui"}');
        fs.writeFileSync(`${siblingRoot}/tsconfig.json`, '{"include":["src"]}');
        fs.writeFileSync(sibling, '<button />');
        fs.writeFileSync(siblingOverlay, '{"files":["owned"]}');

        const shadows = new ShadowManager({
            projectPath: appRoot,
            sourceRoot: root,
            tsconfigPath: undefined,
            snapshotOptions,
            writeConfig: true,
            workspaceSvelteFiles: () => [app, sibling]
        });
        shadows.writeOverlayTsconfig([]);

        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.ok(config.files.includes(shadows.getShadowPath(app)));
        assert.ok(!config.files.includes(shadows.getShadowPath(sibling)));
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(siblingOverlay, 'utf8')), {
            files: ['owned']
        });
    });

    it('keeps shadows for files outside the workspace inside its own mirror', () => {
        const shadows = manager(monorepo, undefined, false);
        const outside = '/somewhere/else/repo/src/Foo.svelte';
        const shadowPath = shadows.getShadowPath(outside);
        assert.ok(
            shadowPath.startsWith(`${monorepo}/${OVERLAY}/svelte/__outside/`),
            `must not write into the foreign package: ${shadowPath}`
        );
        assert.strictEqual(shadows.getOriginalPath(shadowPath), outside);
    });

    it('skips rewriting a shadow whose content is unchanged', () => {
        const shadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        const shadowPath = shadows.getShadowPath(`${appRoot}/src/lib/Same.svelte`);
        assert.strictEqual(shadows.writeShadow(shadowPath, 'generated'), true);
        assert.strictEqual(shadows.writeShadow(shadowPath, 'generated'), false);
        assert.strictEqual(shadows.writeShadow(shadowPath, 'changed'), true);
        shadows.removeShadow(shadowPath);
        assert.strictEqual(shadows.writeShadow(shadowPath, 'changed'), true);
    });

    it('invalidates persisted freshness when collision rewrite topology changes', () => {
        const root = tempProject();
        const component = `${root}/src/Widget.svelte`;
        const rune = `${component}.ts`;
        fs.writeFileSync(`${root}/package.json`, JSON.stringify({ name: 'rewrite-fingerprint' }));
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'import Widget from "./Widget.svelte"; void Widget;'
        );
        fs.writeFileSync(component, '<p />');
        fs.writeFileSync(rune, 'export const state = true;');
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler'
                },
                include: ['src/**/*']
            })
        );

        const collision = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(collision.prepareBatchModuleMirrors(), true);
        collision.writeOverlayTsconfig([]);
        collision.commitFingerprints();
        assert.strictEqual(collision.isTransformFingerprintCurrent(component), true);

        fs.unlinkSync(rune);
        invalidateTsGoWorkspaceIndex();
        const ordinary = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(ordinary.prepareBatchModuleMirrors(), false);
        ordinary.writeOverlayTsconfig([]);
        assert.strictEqual(
            ordinary.isTransformFingerprintCurrent(component),
            false,
            'the old generated spelling must not be reusable after the collision disappears'
        );
    });

    it('indexes raw Svelte dependencies whose package.json is hidden by exports', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { 'hidden-svelte': '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "hidden-svelte/Comp.svelte";');
        const dependency = `${root}/node_modules/hidden-svelte`;
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'hidden-svelte',
                version: '1.0.0',
                exports: { './Comp.svelte': { svelte: './src/Comp.svelte' } },
                peerDependencies: { svelte: '^5.0.0' }
            })
        );
        const component = `${dependency}/src/Comp.svelte`;
        fs.writeFileSync(component, '<script>export let label: string;</script>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [component]);
        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.deepStrictEqual(config.compilerOptions.paths['hidden-svelte/Comp.svelte'], [
            shadows.getShadowPath(component)
        ]);
    });

    it('uses one authored spelling for a linked workspace dependency without ambiguous roots', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { 'linked-ui': '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "linked-ui";');

        const authoredPackage = `${root}/packages/linked-ui`;
        fs.mkdirSync(authoredPackage, { recursive: true });
        fs.writeFileSync(
            `${authoredPackage}/package.json`,
            JSON.stringify({
                name: 'linked-ui',
                version: '1.0.0',
                peerDependencies: { svelte: '*' },
                exports: { '.': './index.ts' }
            })
        );
        fs.writeFileSync(`${authoredPackage}/index.ts`, 'export { default } from "./Comp.svelte";');
        const component = `${authoredPackage}/Comp.svelte`;
        fs.writeFileSync(component, '<script>export let label;</script>');
        fs.mkdirSync(`${root}/node_modules`, { recursive: true });
        fs.symlinkSync(authoredPackage, `${root}/node_modules/linked-ui`, 'junction');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [component]);
        const shadow = shadows.getShadowPath(`${root}/node_modules/linked-ui/Comp.svelte`);
        assert.ok(!shadow.includes('/__outside/'));
        assert.strictEqual(shadows.getOriginalPath(shadow), component);

        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        const rootDirs: string[] = config.compilerOptions.rootDirs;
        assert.ok(rootDirs.includes(normalizePath(fs.realpathSync.native(root))));
        assert.ok(
            !rootDirs.includes(normalizePath(fs.realpathSync.native(authoredPackage))),
            'workspace packages use the source-root suffix space, not a colliding src/... space'
        );
        assert.ok(
            !rootDirs.includes(normalizePath(path.dirname(shadow))),
            'the package-relative mirror twin would let another package capture relative imports'
        );
    });

    it('uses exact package-import paths when wildcard aliases overlap across packages', () => {
        const root = tempProject();
        const ui = `${root}/packages/ui`;
        const tiptap = `${root}/packages/tiptap`;
        const uiComponent = `${ui}/src/lib/components/Button.svelte`;
        const nodeView = `${tiptap}/src/lib/svelte/NodeViewWrapper.svelte`;
        fs.mkdirSync(path.dirname(uiComponent), { recursive: true });
        fs.mkdirSync(path.dirname(nodeView), { recursive: true });
        fs.writeFileSync(
            `${ui}/package.json`,
            JSON.stringify({ name: 'ui', imports: { '#lib/*': './src/lib/*' } })
        );
        fs.writeFileSync(
            `${tiptap}/package.json`,
            JSON.stringify({ name: 'tiptap', imports: { '#*': './src/*' } })
        );
        fs.writeFileSync(uiComponent, '<button />');
        fs.writeFileSync(nodeView, '<div />');
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({ include: ['./src/**/*.ts', './packages/**/*.svelte'] })
        );

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.deepStrictEqual(config.compilerOptions.paths['#lib/components/Button.svelte'], [
            shadows.getShadowPath(uiComponent)
        ]);
        assert.deepStrictEqual(config.compilerOptions.paths['#lib/svelte/NodeViewWrapper.svelte'], [
            shadows.getShadowPath(nodeView)
        ]);
        assert.ok(
            config.compilerOptions.paths['#lib/*.svelte'],
            'the exact package-local entry must coexist with the wildcard fallback'
        );
    });

    it('mirrors only the reverse importer closure of a colliding component', () => {
        const root = tempProject();
        fs.mkdirSync(`${root}/src/lib`, { recursive: true });
        fs.mkdirSync(`${root}/src/unrelated`, { recursive: true });
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'collision-app', imports: { '#lib/*': './src/lib/*' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "./barrel"; import "./unrelated/File0";');
        fs.writeFileSync(`${root}/src/barrel.ts`, 'export * from "./feature";');
        fs.writeFileSync(
            `${root}/src/feature.ts`,
            [
                'import Button from "#lib/Button.svelte";',
                'import helper from "#lib/helper";',
                'import data from "./data.json";',
                'export { Button, helper, data };'
            ].join('\n')
        );
        fs.writeFileSync(`${root}/src/lib/Button.svelte`, '<button />');
        fs.writeFileSync(`${root}/src/lib/Button.svelte.ts`, 'export const rune = true;');
        fs.writeFileSync(`${root}/src/lib/helper.ts`, 'export default 1;');
        fs.writeFileSync(`${root}/src/data.json`, '{"ok":true}');
        for (let index = 0; index < 20; index++) {
            fs.writeFileSync(
                `${root}/src/unrelated/File${index}.ts`,
                index < 19 ? `import "./File${index + 1}";` : 'export const done = true;'
            );
        }

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(shadows.prepareBatchModuleMirrors(), true);

        const stats = shadows.getBatchMirrorStats();
        assert.deepStrictEqual(stats, {
            rootFiles: 1,
            sourceEdges: 25,
            reachableScripts: 24,
            legacyCandidateScripts: 25,
            reverseClosureNodes: 4,
            mirroredScripts: 5,
            mirroredJson: 1,
            collidingComponents: 1,
            fallbackReasons: []
        });
        const mirrored = new Set(
            shadows.getBatchSourceMirrorEntries().map((entry) => entry.originalPath)
        );
        assert.deepStrictEqual(
            mirrored,
            new Set([
                `${root}/src/main.ts`,
                `${root}/src/barrel.ts`,
                `${root}/src/feature.ts`,
                `${root}/src/lib/Button.svelte.ts`,
                `${root}/src/lib/helper.ts`,
                `${root}/src/data.json`
            ])
        );
        assert.ok(!mirrored.has(`${root}/src/unrelated/File0.ts`));

        const rewritten = shadows.rewriteBatchModuleSpecifiers(
            fs.readFileSync(`${root}/src/feature.ts`, 'utf8'),
            `${root}/src/feature.ts`
        );
        assert.ok(rewritten.includes('#lib/Button.__svlt'));
        shadows.writeBatchMirrorPackageScopes();
        const scope = JSON.parse(fs.readFileSync(`${root}/${OVERLAY}/svelte/package.json`, 'utf8'));
        assert.ok(scope.imports['#lib/*'].startsWith('./'));
        assert.match(scope.imports['#lib/*'], /src\/lib\/\*$/);
        assert.ok(!scope.imports['#lib/*'].includes('..'));
    });

    it('preserves bare package exports through a narrowed collision closure', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { 'raw-controls': '1.0.0' } })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'import Widget from "raw-controls/Widget.svelte"; void Widget;'
        );
        const dependency = `${root}/node_modules/raw-controls`;
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'raw-controls',
                version: '1.0.0',
                exports: { './Widget.svelte': './src/Widget.svelte' }
            })
        );
        const component = `${dependency}/src/Widget.svelte`;
        const companion = `${component}.ts`;
        fs.writeFileSync(component, '<button />');
        fs.writeFileSync(companion, 'export const rune = true;');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(shadows.prepareBatchModuleMirrors(), true);
        assert.deepStrictEqual(
            new Set(shadows.getBatchSourceMirrorEntries().map((entry) => entry.originalPath)),
            new Set([`${root}/src/main.ts`, companion])
        );
        const rewritten = shadows.rewriteBatchModuleSpecifiers(
            fs.readFileSync(`${root}/src/main.ts`, 'utf8'),
            `${root}/src/main.ts`
        );
        assert.ok(rewritten.includes('raw-controls/Widget.__svlt'));
        shadows.writeOverlayTsconfig([]);
        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.ok(config.compilerOptions.paths['raw-controls/Widget.__svlt']);
        assert.deepStrictEqual(shadows.getBatchMirrorStats().fallbackReasons, []);
    });

    it('adopts fresh foreign mirrors and schedules source-newer copies for refresh', () => {
        const root = tempProject();
        const dependency = `${root}/node_modules/facehash`;
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'consumer',
                private: true,
                dependencies: { facehash: '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler'
                },
                include: ['src/**/*']
            })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            [
                'import Widget from "./Widget.svelte";',
                'import { color } from "facehash";',
                'void Widget; void color;'
            ].join('\n')
        );
        fs.writeFileSync(`${root}/src/Widget.svelte`, '<p />');
        fs.writeFileSync(`${root}/src/Widget.svelte.ts`, 'export const rune = true;');
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'facehash',
                version: '1.0.0',
                exports: { '.': './src/index.ts' }
            })
        );
        fs.writeFileSync(
            `${dependency}/tsconfig.json`,
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler'
                },
                include: ['src/**/*']
            })
        );
        const entry = `${dependency}/src/index.ts`;
        fs.writeFileSync(entry, 'export const color = "blue";\n');
        fs.writeFileSync(`${dependency}/src/Face.svelte`, '<p />');
        fs.writeFileSync(`${dependency}/src/Face.svelte.ts`, 'export const rune = true;');
        fs.writeFileSync(
            `${dependency}/src/collision.ts`,
            'import Face from "./Face.svelte"; void Face;\n'
        );

        const owner = new ShadowManager({
            projectPath: dependency,
            sourceRoot: root,
            tsconfigPath: `${dependency}/tsconfig.json`,
            snapshotOptions
        });
        assert.strictEqual(owner.prepareBatchModuleMirrors(), true);
        const ownedEntry = {
            originalPath: entry,
            mirrorPath: normalizePath(
                path.join((owner as any).mirrorRootFor(entry), (owner as any).mirrorRelFor(entry))
            )
        };
        owner.writeShadow(ownedEntry.mirrorPath, fs.readFileSync(entry, 'utf8'));
        owner.reconcileBatchMirrorOwnership([], [ownedEntry.mirrorPath]);

        const consumer = () => {
            const shadows = new ShadowManager({
                projectPath: root,
                sourceRoot: root,
                tsconfigPath: `${root}/tsconfig.json`,
                snapshotOptions
            });
            // This manager reaches facehash's public TS entry but does not materialise its
            // unrelated Svelte component. The existing source mirror is what must keep the
            // public entry and its relative graph on one physical identity.
            shadows.findDependencySvelteFiles = () => [];
            return shadows;
        };

        const fresh = consumer();
        assert.strictEqual(fresh.prepareBatchModuleMirrors(), true);
        assert.ok(
            fresh
                .getBatchSourceMirrorEntries()
                .some((candidate) => candidate.originalPath === entry),
            'a byte-current foreign-owned source mirror should be adopted'
        );
        fresh.writeOverlayTsconfig([]);
        const config = JSON.parse(fs.readFileSync(fresh.overlayTsconfigPath, 'utf8'));
        assert.deepStrictEqual(config.compilerOptions.paths.facehash, [ownedEntry.mirrorPath]);

        fs.writeFileSync(entry, 'export const color = "red";\n');
        invalidateTsGoWorkspaceIndex();
        const stale = consumer();
        assert.strictEqual(stale.prepareBatchModuleMirrors(), true);
        const refresh = stale
            .getBatchSourceMirrorEntries()
            .find((candidate) => candidate.originalPath === entry);
        assert.ok(
            refresh,
            'a source-newer foreign mirror must become a required materialisation entry'
        );
        assert.strictEqual(
            fs.readFileSync(ownedEntry.mirrorPath, 'utf8'),
            'export const color = "blue";\n',
            'preparation itself must not publish different bytes'
        );
        stale.writeShadow(
            refresh.mirrorPath,
            stale.rewriteBatchModuleSpecifiers(fs.readFileSync(entry, 'utf8'), entry)
        );
        assert.strictEqual(
            fs.readFileSync(ownedEntry.mirrorPath, 'utf8'),
            fs.readFileSync(entry, 'utf8')
        );
        stale.writeOverlayTsconfig([]);
        const staleConfig = JSON.parse(fs.readFileSync(stale.overlayTsconfigPath, 'utf8'));
        assert.deepStrictEqual(staleConfig.compilerOptions.paths.facehash, [ownedEntry.mirrorPath]);

        fs.writeFileSync(ownedEntry.mirrorPath, 'export const color = "foreign-rewrite";\n');
        invalidateTsGoWorkspaceIndex();
        const incompatible = consumer();
        assert.strictEqual(incompatible.prepareBatchModuleMirrors(), true);
        assert.ok(
            !incompatible
                .getBatchSourceMirrorEntries()
                .some((candidate) => candidate.originalPath === entry),
            'newer bytes from incompatible mirror state must not be adopted'
        );
        incompatible.writeOverlayTsconfig([]);
        const incompatibleConfig = JSON.parse(
            fs.readFileSync(incompatible.overlayTsconfigPath, 'utf8')
        );
        assert.ok(!incompatibleConfig.compilerOptions.paths?.facehash);
    });

    it('follows ordinary-named public subpath barrels and skips modern declarations', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { controls: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "controls/button";');
        const dependency = `${root}/node_modules/controls`;
        fs.mkdirSync(`${dependency}/dist`, { recursive: true });
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'controls',
                version: '1.0.0',
                exports: {
                    './button': {
                        types: './dist/button.d.ts',
                        default: './dist/button.js'
                    },
                    './typed': {
                        types: './dist/typed.d.ts',
                        default: './dist/typed.js'
                    }
                }
            })
        );
        fs.writeFileSync(`${dependency}/dist/button.d.ts`, 'export { default } from "./controls";');
        fs.writeFileSync(
            `${dependency}/dist/controls.d.ts`,
            'export { default } from "../src/Button.svelte";'
        );
        fs.writeFileSync(
            `${dependency}/dist/typed.d.ts`,
            'export { default } from "../src/Typed.svelte";'
        );
        const button = `${dependency}/src/Button.svelte`;
        fs.writeFileSync(button, '<script>export let label: string;</script>');
        fs.writeFileSync(`${dependency}/src/Typed.svelte`, '<p/>');
        fs.writeFileSync(`${dependency}/src/Typed.d.svelte.ts`, 'export default class Typed {}');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [button]);
    });

    it('follows CommonJS import-equals declaration re-exports to raw Svelte sources', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { controls: '1.0.0' } })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'import Button = require("controls"); void Button;'
        );
        const dependency = `${root}/node_modules/controls`;
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'controls',
                version: '1.0.0',
                exports: { '.': { types: './index.d.ts', require: './index.js' } }
            })
        );
        fs.writeFileSync(
            `${dependency}/index.d.ts`,
            'import Button = require("./Button.svelte"); export = Button;\n'
        );
        fs.writeFileSync(`${dependency}/index.js`, 'module.exports = require("./Button.svelte");');
        const button = `${dependency}/Button.svelte`;
        fs.writeFileSync(
            button,
            '<script lang="ts">export let label: string;</script><button>{label}</button>'
        );

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [button]);
        assert.deepStrictEqual(shadows.getDependencyScopeStats().fallbackReasons, []);
    });

    it('scans raw Svelte dependencies deeper than twelve directory levels', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { 'deep-ui': '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "deep-ui";');
        const dependency = `${root}/node_modules/deep-ui`;
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'deep-ui',
                version: '1.0.0',
                main: './index.js',
                peerDependencies: { svelte: '^5' }
            })
        );
        fs.writeFileSync(`${dependency}/index.js`, 'exports.ready = true;');
        const deepDirectory = path.join(
            dependency,
            ...Array.from({ length: 12 }, (_, index) => `level-${index}`)
        );
        fs.mkdirSync(deepDirectory, { recursive: true });
        const component = normalizePath(path.join(deepDirectory, 'DeepButton.svelte'));
        fs.writeFileSync(component, '<button>deep</button>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });

        assert.ok(shadows.findDependencySvelteFiles().includes(component));
        assert.strictEqual(shadows.getDependencyScopeStats().svelteFiles, 1);
    });

    it('follows triple-slash references in a dependency public declaration graph', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { controls: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "controls";');
        const dependency = `${root}/node_modules/controls`;
        fs.mkdirSync(`${dependency}/dist`, { recursive: true });
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'controls',
                version: '1.0.0',
                exports: { '.': { types: './dist/index.d.ts' } }
            })
        );
        fs.writeFileSync(
            `${dependency}/dist/index.d.ts`,
            '/// <reference path="./surface.d.ts" />\n'
        );
        fs.writeFileSync(
            `${dependency}/dist/surface.d.ts`,
            'export { default } from "../src/Button.svelte";\n'
        );
        const button = `${dependency}/src/Button.svelte`;
        fs.writeFileSync(button, '<button />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [button]);
        assert.deepStrictEqual(shadows.getDependencyScopeStats().fallbackReasons, []);
    });

    it('fails closed on an unresolved dependency public path reference', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { controls: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "controls";');
        const dependency = `${root}/node_modules/controls`;
        fs.mkdirSync(`${dependency}/dist`, { recursive: true });
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'controls',
                version: '1.0.0',
                exports: { '.': { types: './dist/index.d.ts' } }
            })
        );
        const entry = `${dependency}/dist/index.d.ts`;
        fs.writeFileSync(entry, '/// <reference path="./missing.d.ts" />\n');
        const fallback = `${dependency}/src/Fallback.svelte`;
        fs.writeFileSync(fallback, '<p>fallback</p>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });

        assert.ok(shadows.findDependencySvelteFiles().includes(fallback));
        const stats = shadows.getDependencyScopeStats();
        assert.strictEqual(stats.mode, 'declared-fallback');
        assert.ok(
            stats.fallbackReasons.includes(
                `unresolved-dependency-public-reference:${entry}:./missing.d.ts`
            )
        );
    });

    it('roots reachable JavaScript shadows without rooting conservative dependency scans', async () => {
        const root = tempProject();
        const reachable = `${root}/src/Reachable.svelte`;
        fs.writeFileSync(reachable, '<script>export let value;</script>');
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { controls: '1.0.0' } })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'import Reachable from "./Reachable.svelte"; import "controls"; void Reachable;'
        );
        const dependency = `${root}/node_modules/controls`;
        fs.mkdirSync(`${dependency}/dist`, { recursive: true });
        fs.mkdirSync(`${dependency}/src`, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({
                name: 'controls',
                version: '1.0.0',
                exports: { '.': { types: './dist/index.d.ts' } }
            })
        );
        fs.writeFileSync(
            `${dependency}/dist/index.d.ts`,
            '/// <reference path="./missing.d.ts" />\n'
        );
        const conservative = `${dependency}/src/Conservative.svelte`;
        fs.writeFileSync(conservative, '<script>export let value;</script>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.ok(shadows.findDependencySvelteFiles().includes(conservative));
        assert.strictEqual(shadows.getDependencyScopeStats().mode, 'declared-fallback');

        await shadows.refreshShadowKinds([reachable, conservative]);
        shadows.writeOverlayTsconfig([]);
        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        const reachableShadow = shadows.getShadowPath(reachable);
        const conservativeShadow = shadows.getShadowPath(conservative);
        assert.ok(reachableShadow.endsWith('.svelte.jsx'));
        assert.ok(conservativeShadow.endsWith('.svelte.jsx'));
        assert.ok(config.files.includes(reachableShadow));
        assert.ok(!config.files.includes(conservativeShadow));
    });

    it('does not transform dependencies with modern .d.svelte.ts declarations', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { typed: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "typed";');
        const dependency = `${root}/node_modules/typed`;
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(
            `${dependency}/package.json`,
            JSON.stringify({ name: 'typed', version: '1.0.0', peerDependencies: { svelte: '^5' } })
        );
        fs.writeFileSync(`${dependency}/Typed.svelte`, '<p/>');
        fs.writeFileSync(`${dependency}/Typed.d.svelte.ts`, 'export default class Typed {}');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), []);
    });

    it('indexes only the reachable pnpm dependency and marker-free re-export closure', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'consumer',
                dependencies: {
                    facade: '1.0.0',
                    companion: '1.0.0',
                    'unused-svelte': '1.0.0'
                }
            })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "facade";');

        const pnpm = `${root}/node_modules/.pnpm`;
        const facade = `${pnpm}/facade@1.0.0/node_modules/facade`;
        const companion = `${pnpm}/companion@1.0.0/node_modules/companion`;
        const unused = `${pnpm}/unused-svelte@1.0.0/node_modules/unused-svelte`;
        fs.mkdirSync(facade, { recursive: true });
        fs.mkdirSync(`${companion}/src`, { recursive: true });
        fs.mkdirSync(unused, { recursive: true });
        fs.mkdirSync(`${root}/node_modules`, { recursive: true });
        fs.symlinkSync(facade, `${root}/node_modules/facade`, 'junction');
        fs.symlinkSync(companion, `${root}/node_modules/companion`, 'junction');
        fs.symlinkSync(unused, `${root}/node_modules/unused-svelte`, 'junction');

        fs.writeFileSync(
            `${facade}/package.json`,
            JSON.stringify({
                name: 'facade',
                version: '1.0.0',
                exports: { '.': { types: './index.d.ts', default: './index.js' } },
                dependencies: { companion: '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${facade}/index.d.ts`,
            'export { default } from "companion/Button.svelte";'
        );
        fs.writeFileSync(
            `${companion}/package.json`,
            JSON.stringify({
                name: 'companion',
                version: '1.0.0',
                exports: {
                    './Button.svelte': './src/Button.svelte',
                    './Typed.svelte': {
                        types: './src/Typed.d.svelte.ts',
                        default: './src/Typed.svelte'
                    }
                }
            })
        );
        const button = `${root}/node_modules/companion/src/Button.svelte`;
        fs.writeFileSync(`${companion}/src/Button.svelte`, '<button />');
        fs.writeFileSync(`${companion}/src/Typed.svelte`, '<p>typed</p>');
        fs.writeFileSync(`${companion}/src/Typed.d.svelte.ts`, 'export default class Typed {}');
        fs.writeFileSync(
            `${unused}/package.json`,
            JSON.stringify({
                name: 'unused-svelte',
                version: '1.0.0',
                peerDependencies: { svelte: '^5' }
            })
        );
        fs.writeFileSync(`${unused}/Unused.svelte`, '<p>unused</p>');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [button]);
        assert.deepStrictEqual(shadows.getDependencyScopeStats(), {
            mode: 'reachable',
            directImports: 1,
            dependencyRoots: 2,
            svelteFiles: 1,
            fallbackReasons: [],
            closureComplete: true
        });
    });

    it('follows every bounded conditional export branch when no types entry is authoritative', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { facade: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import facade = require("facade"); void facade;');
        fs.writeFileSync(
            `${root}/tsconfig.json`,
            JSON.stringify({
                files: ['./src/main.ts'],
                compilerOptions: { module: 'Node16', moduleResolution: 'Node16' }
            })
        );

        const facade = `${root}/node_modules/facade`;
        const companion = `${root}/node_modules/companion`;
        fs.mkdirSync(facade, { recursive: true });
        fs.mkdirSync(companion, { recursive: true });
        fs.writeFileSync(
            `${facade}/package.json`,
            JSON.stringify({
                name: 'facade',
                version: '1.0.0',
                exports: { '.': { import: './esm.js', require: './cjs.cjs' } },
                dependencies: { companion: '1.0.0' }
            })
        );
        fs.writeFileSync(`${facade}/esm.js`, 'export const marker = true;');
        fs.writeFileSync(`${facade}/cjs.cjs`, 'module.exports = require("companion");');
        fs.writeFileSync(
            `${companion}/package.json`,
            JSON.stringify({
                name: 'companion',
                version: '1.0.0',
                peerDependencies: { svelte: '^5' }
            })
        );
        const component = `${companion}/Component.svelte`;
        fs.writeFileSync(component, '<p />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [component]);
        assert.deepStrictEqual(shadows.getDependencyScopeStats(), {
            mode: 'reachable',
            directImports: 1,
            dependencyRoots: 2,
            svelteFiles: 1,
            fallbackReasons: [],
            closureComplete: true
        });
    });

    it('reads the source argument from an esbuild __reExport helper', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { facade: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "facade";');
        const facade = `${root}/node_modules/facade`;
        const companion = `${root}/node_modules/companion`;
        fs.mkdirSync(facade, { recursive: true });
        fs.mkdirSync(companion, { recursive: true });
        fs.writeFileSync(
            `${facade}/package.json`,
            JSON.stringify({
                name: 'facade',
                version: '1.0.0',
                main: './index.cjs',
                dependencies: { companion: '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${facade}/index.cjs`,
            [
                'var facade_exports = {};',
                '__reExport(facade_exports, require("companion"), module.exports);',
                'module.exports = __toCommonJS(facade_exports);'
            ].join('\n')
        );
        fs.writeFileSync(
            `${companion}/package.json`,
            JSON.stringify({
                name: 'companion',
                version: '1.0.0',
                peerDependencies: { svelte: '^5' }
            })
        );
        const component = `${companion}/Component.svelte`;
        fs.writeFileSync(component, '<p />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [component]);
        assert.strictEqual(shadows.getDependencyScopeStats().mode, 'reachable');
    });

    it('fails closed when a generated CommonJS export helper is unknown', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { facade: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "facade";');
        const facade = `${root}/node_modules/facade`;
        const companion = `${root}/node_modules/companion`;
        fs.mkdirSync(facade, { recursive: true });
        fs.mkdirSync(companion, { recursive: true });
        fs.writeFileSync(
            `${facade}/package.json`,
            JSON.stringify({
                name: 'facade',
                version: '1.0.0',
                main: './index.cjs',
                dependencies: { companion: '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${facade}/index.cjs`,
            '__mysteryReExport({}, require("companion"), module.exports);'
        );
        fs.writeFileSync(
            `${companion}/package.json`,
            JSON.stringify({
                name: 'companion',
                version: '1.0.0',
                peerDependencies: { svelte: '^5' }
            })
        );
        const component = `${companion}/Component.svelte`;
        fs.writeFileSync(component, '<p />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [component]);
        const stats = shadows.getDependencyScopeStats();
        assert.strictEqual(stats.mode, 'declared-fallback');
        assert.ok(
            stats.fallbackReasons.some((reason) => reason.startsWith('computed-dependency-entry:'))
        );
    });

    it('does not expand runtime and absent optional imports outside the public export graph', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'consumer',
                dependencies: {
                    facade: '1.0.0',
                    'unused-svelte': '1.0.0'
                }
            })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import { Button } from "facade"; void Button;');

        const facade = `${root}/node_modules/facade`;
        const companion = `${root}/node_modules/companion`;
        const runtime = `${root}/node_modules/runtime-heavy`;
        const unused = `${root}/node_modules/unused-svelte`;
        fs.mkdirSync(facade, { recursive: true });
        fs.mkdirSync(`${companion}/src`, { recursive: true });
        fs.mkdirSync(runtime, { recursive: true });
        fs.mkdirSync(unused, { recursive: true });
        fs.writeFileSync(
            `${facade}/package.json`,
            JSON.stringify({
                name: 'facade',
                version: '1.0.0',
                types: './index.d.ts',
                dependencies: {
                    companion: '1.0.0',
                    'runtime-heavy': '1.0.0'
                },
                optionalDependencies: { 'absent-platform-adapter': '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${facade}/index.d.ts`,
            [
                'import type { Runtime } from "runtime-heavy";',
                'export declare function useRuntime(value: Runtime): void;',
                'export { default as Button } from "companion/Button.svelte";',
                'export type { Missing } from "absent-platform-adapter";',
                'export type { OptionalAdapter } from "./missing-adapter.js";'
            ].join('\n')
        );
        fs.writeFileSync(
            `${companion}/package.json`,
            JSON.stringify({
                name: 'companion',
                version: '1.0.0',
                exports: { './Button.svelte': './src/Button.svelte' }
            })
        );
        const button = `${companion}/src/Button.svelte`;
        fs.writeFileSync(button, '<button />');
        for (const [packageRoot, name] of [
            [runtime, 'runtime-heavy'],
            [unused, 'unused-svelte']
        ] as const) {
            fs.writeFileSync(
                `${packageRoot}/package.json`,
                JSON.stringify({ name, version: '1.0.0', peerDependencies: { svelte: '^5' } })
            );
            fs.writeFileSync(`${packageRoot}/NotPublic.svelte`, '<p>not public</p>');
        }

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [button]);
        assert.deepStrictEqual(shadows.getDependencyScopeStats(), {
            mode: 'reachable',
            directImports: 1,
            dependencyRoots: 2,
            svelteFiles: 1,
            fallbackReasons: [],
            closureComplete: true
        });
    });

    it('falls back when a dependency computes its public CommonJS export target', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { facade: '1.0.0' } })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "facade";');
        const facade = `${root}/node_modules/facade`;
        const componentPackage = `${facade}/node_modules/component-package`;
        fs.mkdirSync(componentPackage, { recursive: true });
        fs.writeFileSync(
            `${facade}/package.json`,
            JSON.stringify({
                name: 'facade',
                version: '1.0.0',
                main: './index.js',
                dependencies: { 'component-package': '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${facade}/index.js`,
            'const target = "component-package"; module.exports = require(target);'
        );
        fs.writeFileSync(
            `${componentPackage}/package.json`,
            JSON.stringify({
                name: 'component-package',
                version: '1.0.0',
                peerDependencies: { svelte: '^5' }
            })
        );
        fs.writeFileSync(`${componentPackage}/Component.svelte`, '<p />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [
            `${componentPackage}/Component.svelte`
        ]);
        const stats = shadows.getDependencyScopeStats();
        assert.strictEqual(stats.mode, 'declared-fallback');
        assert.ok(
            stats.fallbackReasons.some((reason) => reason.startsWith('computed-dependency-entry:'))
        );
    });

    it('stops dependency proof work after the first ambiguity before taking the broad fallback', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'consumer',
                dependencies: { 'a-ambiguous': '1.0.0', 'z-component': '1.0.0' }
            })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'import "a-ambiguous"; import "z-component";');
        const ambiguous = `${root}/node_modules/a-ambiguous`;
        const later = `${root}/node_modules/z-component`;
        fs.mkdirSync(ambiguous, { recursive: true });
        fs.mkdirSync(later, { recursive: true });
        fs.writeFileSync(
            `${ambiguous}/package.json`,
            JSON.stringify({ name: 'a-ambiguous', version: '1.0.0', main: './index.js' })
        );
        fs.writeFileSync(
            `${ambiguous}/index.js`,
            'const target = "somewhere"; module.exports = require(target);'
        );
        fs.writeFileSync(
            `${later}/package.json`,
            JSON.stringify({
                name: 'z-component',
                version: '1.0.0',
                main: './index.js',
                peerDependencies: { svelte: '^5' }
            })
        );
        fs.writeFileSync(`${later}/index.js`, 'module.exports = {};');
        const component = `${later}/Component.svelte`;
        fs.writeFileSync(component, '<p />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(shadows.findDependencySvelteFiles(), [component]);
        const stats = shadows.getDependencyScopeStats();
        assert.strictEqual(stats.mode, 'declared-fallback');
        assert.strictEqual(
            stats.fallbackReasons.some((reason) =>
                reason.startsWith('dependency-root-closure-limit:')
            ),
            false
        );
        assert.strictEqual(
            shadows
                .getBatchGraphPlanSourceInputs()
                .some((input) => input.path === `${later}/index.js`),
            false,
            'the later public entry must not be parsed after fallback is inevitable'
        );
        assert.strictEqual(
            shadows
                .getBatchGraphPlanSourceInputs()
                .some((input) => input.path === `${ambiguous}/index.js`),
            false,
            'the failed narrow proof must not burden the authoritative fallback cache'
        );
    });

    it('retains declared dependency scanning when the project graph is ambiguous', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'consumer',
                dependencies: { 'used-svelte': '1.0.0', 'other-svelte': '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${root}/src/main.ts`,
            'const packageName = "used-svelte"; void import(packageName);'
        );
        for (const packageName of ['used-svelte', 'other-svelte']) {
            const dependency = `${root}/node_modules/${packageName}`;
            fs.mkdirSync(dependency, { recursive: true });
            fs.writeFileSync(
                `${dependency}/package.json`,
                JSON.stringify({
                    name: packageName,
                    version: '1.0.0',
                    peerDependencies: { svelte: '^5' }
                })
            );
            fs.writeFileSync(`${dependency}/${packageName}.svelte`, '<p />');
        }

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.deepStrictEqual(
            new Set(shadows.findDependencySvelteFiles()),
            new Set([
                `${root}/node_modules/used-svelte/used-svelte.svelte`,
                `${root}/node_modules/other-svelte/other-svelte.svelte`
            ])
        );
        const stats = shadows.getDependencyScopeStats();
        assert.strictEqual(stats.mode, 'declared-fallback');
        assert.ok(stats.fallbackReasons.some((reason) => reason.startsWith('computed-import:')));
    });

    it('follows public companion re-exports through included and locally-indirected peers', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({
                name: 'consumer',
                peerDependencies: { 'svelte-facade': '1.0.0', 'indirect-facade': '1.0.0' }
            })
        );
        fs.writeFileSync(`${root}/src/main.ts`, 'const name = "dynamic"; void import(name);');
        const svelteFacade = `${root}/node_modules/svelte-facade`;
        const indirectFacade = `${root}/node_modules/indirect-facade`;
        const companion = `${root}/node_modules/companion`;
        fs.mkdirSync(svelteFacade, { recursive: true });
        fs.mkdirSync(indirectFacade, { recursive: true });
        fs.mkdirSync(companion, { recursive: true });
        fs.writeFileSync(
            `${svelteFacade}/package.json`,
            JSON.stringify({
                name: 'svelte-facade',
                version: '1.0.0',
                types: './index.d.ts',
                peerDependencies: { svelte: '^5', companion: '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${svelteFacade}/index.d.ts`,
            'export { default as Button } from "companion";'
        );
        fs.writeFileSync(
            `${indirectFacade}/package.json`,
            JSON.stringify({
                name: 'indirect-facade',
                version: '1.0.0',
                types: './index.d.ts',
                peerDependencies: { companion: '1.0.0' }
            })
        );
        fs.writeFileSync(
            `${indirectFacade}/index.d.ts`,
            [
                'import Button from "companion";',
                'const make = () => Button;',
                'export { make };'
            ].join('\n')
        );
        fs.writeFileSync(
            `${companion}/package.json`,
            JSON.stringify({
                name: 'companion',
                version: '1.0.0',
                exports: { '.': './Button.svelte' }
            })
        );
        const button = `${companion}/Button.svelte`;
        fs.writeFileSync(button, '<button />');

        const shadows = new ShadowManager({
            projectPath: root,
            sourceRoot: root,
            tsconfigPath: `${root}/tsconfig.json`,
            snapshotOptions
        });
        shadows.writeOverlayTsconfig([]);

        assert.ok(shadows.findDependencySvelteFiles().includes(button));
        assert.strictEqual(shadows.getDependencyScopeStats().mode, 'declared-fallback');
    });

    it("prunes only shadows whose original is gone, keeping other managers' work", () => {
        const appShadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        appShadows.writeOverlayTsconfig([]);

        // Someone else's live shadow (same canonical path another manager would use).
        const foreign = appShadows.getShadowPath(`${uiRoot}/src/lib/Button.svelte`);
        appShadows.writeShadow(foreign, 'foreign but alive');
        // A shadow of this manager's own.
        const own = appShadows.getShadowPath(`${appRoot}/src/lib/Same.svelte`);
        appShadows.writeShadow(own, 'own');
        // A stray from the pre-canonical layout: package-relative path, no such original.
        const stray = `${appRoot}/${OVERLAY}/svelte/src/lib/Same.svelte.tsx`;
        fs.mkdirSync(path.dirname(stray), { recursive: true });
        fs.writeFileSync(stray, 'old layout');

        appShadows.pruneOrphanedShadows(new Set([own]));

        assert.ok(fs.existsSync(own), 'live shadows survive');
        assert.ok(
            fs.existsSync(foreign),
            'shadows outside the live set survive while their original exists'
        );
        assert.ok(!fs.existsSync(stray), 'old-layout strays are swept');
    });

    it('removes a legacy .svelte-ls-overlay directory it recognises as its own', () => {
        const legacy = `${appRoot}/.svelte-ls-overlay`;
        fs.mkdirSync(`${legacy}/svelte`, { recursive: true });
        fs.writeFileSync(`${legacy}/tsconfig.json`, '{}');

        manager(appRoot, `${appRoot}/tsconfig.json`);
        assert.ok(!fs.existsSync(legacy));
    });

    it('finds the workspace root from any package', () => {
        // The walk stops at the repository boundary. The fixture lives inside this repo's own
        // pnpm workspace, so give it a boundary of its own for the duration of the test — a
        // `.git` directory cannot be committed as part of the fixture.
        const gitMarker = path.join(monorepo, '.git');
        fs.mkdirSync(gitMarker, { recursive: true });
        try {
            assert.strictEqual(findWorkspaceRoot(appRoot), monorepo);
            assert.strictEqual(findWorkspaceRoot(uiRoot), monorepo);
            assert.strictEqual(findWorkspaceRoot(monorepo), monorepo);
        } finally {
            fs.rmSync(gitMarker, { recursive: true, force: true });
        }
    });
});
