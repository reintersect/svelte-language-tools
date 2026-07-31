import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, afterEach } from 'mocha';
import {
    findWorkspaceRoot,
    ShadowManager
} from '../../../../src/plugins/typescript-go/lsp/ShadowManager';
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

    it('indexes raw Svelte dependencies whose package.json is hidden by exports', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { 'hidden-svelte': '1.0.0' } })
        );
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

    it('follows ordinary-named public subpath barrels and skips modern declarations', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { controls: '1.0.0' } })
        );
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

    it('does not transform dependencies with modern .d.svelte.ts declarations', () => {
        const root = tempProject();
        fs.writeFileSync(
            `${root}/package.json`,
            JSON.stringify({ name: 'consumer', dependencies: { typed: '1.0.0' } })
        );
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
