import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, afterEach } from 'mocha';
import { ProjectRegistry } from '../../../../src/plugins/typescript-go/lsp/ProjectRegistry';
import { ShadowManager } from '../../../../src/plugins/typescript-go/lsp/ShadowManager';
import { normalizePath } from '../../../../src/utils';

const monorepo = normalizePath(path.join(__dirname, '..', 'fixtures', 'monorepo'));
const appRoot = `${monorepo}/apps/app`;
const uiRoot = `${monorepo}/packages/ui`;

const snapshotOptions = {
    parse: undefined,
    version: undefined,
    transformOnTemplateError: true,
    typingsNamespace: 'svelteHTML',
    emitJsDoc: true
};

interface Created {
    projectRoot: string;
    tsconfigPath: string | undefined;
    writeConfig: boolean;
}

function registry(created: Created[] = [], workspaceRoots = [monorepo]) {
    return new ProjectRegistry({
        createShadows: (projectRoot, tsconfigPath, writeConfig) => {
            created.push({ projectRoot, tsconfigPath, writeConfig });
            return new ShadowManager({
                projectPath: projectRoot,
                sourceRoot: monorepo,
                tsconfigPath,
                snapshotOptions,
                writeConfig
            });
        },
        workspaceRoots,
        fallbackRoot: workspaceRoots[0] ?? monorepo
    });
}

function cleanOverlays() {
    for (const packageRoot of [monorepo, appRoot, uiRoot, `${monorepo}/packages/nocfg`]) {
        fs.rmSync(path.join(packageRoot, 'node_modules'), { recursive: true, force: true });
    }
    fs.rmSync(`${monorepo}/packages/nocfg/tsconfig.json`, { force: true });
}

describe('typescript-go ProjectRegistry', () => {
    afterEach(cleanOverlays);

    it('resolves each file to its nearest tsconfig', () => {
        const created: Created[] = [];
        const projects = registry(created);

        const appShadows = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const uiShadows = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);

        assert.notStrictEqual(appShadows, uiShadows);
        assert.deepStrictEqual(
            created.map((entry) => entry.tsconfigPath),
            [`${appRoot}/tsconfig.json`, `${uiRoot}/tsconfig.json`]
        );
        // Same project for a second file of the same package.
        assert.strictEqual(projects.forFile(`${appRoot}/src/routes/+page.svelte`), appShadows);
    });

    it('routes files under node_modules to the config-less fallback manager', () => {
        const created: Created[] = [];
        const projects = registry(created);

        const depFile = `${monorepo}/node_modules/some-lib/Comp.svelte`;
        fs.mkdirSync(path.dirname(depFile), { recursive: true });
        fs.writeFileSync(depFile, '<p/>');
        fs.writeFileSync(`${monorepo}/node_modules/some-lib/package.json`, '{"name":"some-lib"}');

        projects.forFile(depFile);
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].tsconfigPath, undefined);
        assert.strictEqual(created[0].writeConfig, false);
        assert.strictEqual(created[0].projectRoot, monorepo);
    });

    it('keeps a config-less workspace project distinct from a mapping-only fallback', () => {
        const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-inferred-')));
        const source = `${root}/src/App.svelte`;
        const dependency = `${root}/node_modules/example/Comp.svelte`;
        fs.mkdirSync(path.dirname(source), { recursive: true });
        fs.mkdirSync(path.dirname(dependency), { recursive: true });
        const created: Created[] = [];

        try {
            const projects = registry(created, [root]);
            // Creating the mapping-only dependency manager first must not poison the later
            // workspace source's project selection.
            const fallback = projects.forFile(dependency);
            const inferred = projects.forFile(source);

            assert.notStrictEqual(fallback, inferred);
            assert.deepStrictEqual(
                created.map(({ projectRoot, tsconfigPath, writeConfig }) => ({
                    projectRoot,
                    tsconfigPath,
                    writeConfig
                })),
                [
                    { projectRoot: root, tsconfigPath: undefined, writeConfig: false },
                    { projectRoot: root, tsconfigPath: undefined, writeConfig: true }
                ]
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses the deepest matching root for a nested multi-root fallback project', () => {
        const created: Created[] = [];
        // Keep the outer root first to prove ownership does not depend on client ordering.
        const projects = registry(created, [monorepo, appRoot]);
        const depFile = `${appRoot}/node_modules/nested-lib/Comp.svelte`;
        fs.mkdirSync(path.dirname(depFile), { recursive: true });
        fs.writeFileSync(depFile, '<p/>');

        projects.forFile(depFile);

        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].tsconfigPath, undefined);
        assert.strictEqual(created[0].projectRoot, appRoot);
    });

    it('rejects configs outside every workspace root', () => {
        const created: Created[] = [];
        const projects = registry(created);

        // A file *outside* the workspace: any tsconfig above it (this repo has plenty) must
        // not be adopted; the file lands in the fallback manager instead.
        const outside = normalizePath(path.join(__dirname, 'ProjectRegistry.test.svelte'));
        projects.forFile(outside);
        assert.strictEqual(created.length, 1);
        assert.strictEqual(created[0].tsconfigPath, undefined);
        assert.strictEqual(created[0].writeConfig, false);
    });

    it('keeps the fallback manager distinct from a real project at the same root', () => {
        const created: Created[] = [];
        const projects = registry(created);

        const depFile = `${monorepo}/node_modules/other-lib/Comp.svelte`;
        fs.mkdirSync(path.dirname(depFile), { recursive: true });
        fs.writeFileSync(depFile, '<p/>');

        const fallback = projects.forFile(depFile);
        // A hypothetical file directly at the workspace root resolves to the root stub
        // tsconfig — a *real* project rooted at the same directory.
        const rooted = projects.forFile(`${monorepo}/loose.svelte`);
        assert.notStrictEqual(fallback, rooted);
        assert.deepStrictEqual(
            created.map((entry) => [entry.tsconfigPath, entry.writeConfig]),
            [
                [undefined, false],
                [`${monorepo}/tsconfig.json`, true]
            ]
        );
    });

    it('memoises the workspace scan until invalidated', () => {
        const projects = registry();
        const first = projects.workspaceSvelteFiles(monorepo);
        assert.ok(first.some((file) => file.endsWith('apps/app/src/lib/Same.svelte')));
        assert.strictEqual(projects.workspaceSvelteFiles(monorepo), first, 'must be memoised');
        projects.invalidateWorkspaceScans();
        assert.notStrictEqual(projects.workspaceSvelteFiles(monorepo), first);
    });

    it('forgets cached project ownership when a nearer config is created', () => {
        const created: Created[] = [];
        const projects = registry(created);
        const file = `${monorepo}/packages/nocfg/src/Thing.svelte`;

        const before = projects.forFile(file);
        assert.strictEqual(created[0].tsconfigPath, `${monorepo}/tsconfig.json`);

        const config = `${monorepo}/packages/nocfg/tsconfig.json`;
        fs.writeFileSync(config, '{"include":["src"]}');
        const invalidated = projects.invalidateForStructuralChange(config);

        assert.deepStrictEqual(invalidated, [before]);
        const after = projects.forFile(file);
        assert.notStrictEqual(after, before);
        assert.strictEqual(created[1].tsconfigPath, config);
    });

    it('replaces the manager but preserves ownership on source creation', () => {
        const projects = registry();
        const manager = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const firstScan = projects.workspaceSvelteFiles(monorepo);

        assert.deepStrictEqual(
            projects.invalidateForStructuralChange(`${appRoot}/src/lib/New.svelte`),
            [manager]
        );
        assert.notStrictEqual(projects.forFile(`${appRoot}/src/lib/Same.svelte`), manager);
        assert.notStrictEqual(projects.workspaceSvelteFiles(monorepo), firstScan);
    });
});
