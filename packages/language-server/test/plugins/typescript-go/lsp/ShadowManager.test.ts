import assert from 'assert';
import fs from 'fs';
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

    it('writes an overlay tsconfig with shadows in files, merged rootDirs and no include', () => {
        const shadows = manager(appRoot, `${appRoot}/tsconfig.json`);
        shadows.writeOverlayTsconfig([]);

        const config = JSON.parse(fs.readFileSync(shadows.overlayTsconfigPath, 'utf8'));
        assert.strictEqual(config.include, undefined);
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
            rootDirs.includes(`${uiRoot}/${OVERLAY}/svelte`),
            "sibling packages' mirrors must be rootDirs"
        );
    });

    it('writes a pure-extends shim for packages without their own tsconfig', () => {
        const shadows = manager(monorepo, `${monorepo}/tsconfig.json`);
        shadows.writeOverlayTsconfig([]);

        const shim = JSON.parse(fs.readFileSync(`${nocfgRoot}/${OVERLAY}/tsconfig.json`, 'utf8'));
        assert.deepStrictEqual(shim, { extends: shadows.overlayTsconfigPath });
        // Packages that own a tsconfig are their own project's responsibility.
        assert.ok(!fs.existsSync(`${uiRoot}/${OVERLAY}/tsconfig.json`));
        assert.ok(!fs.existsSync(`${appRoot}/${OVERLAY}/tsconfig.json`));
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
