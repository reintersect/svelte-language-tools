import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, afterEach } from 'mocha';
import { ProjectRegistry } from '../../../../src/plugins/typescript-go/lsp/ProjectRegistry';
import { ShadowManager } from '../../../../src/plugins/typescript-go/lsp/ShadowManager';
import { mapLocationBack } from '../../../../src/plugins/typescript-go/lsp/mapping';
import { Document } from '../../../../src/lib/documents';
import { normalizePath, pathToUrl } from '../../../../src/utils';

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

    it('retains unrelated project managers after a source graph change', () => {
        const projects = registry();
        const app = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const ui = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);

        assert.deepStrictEqual(
            projects.invalidateForStructuralChange(`${appRoot}/src/lib/New.ts`),
            [app]
        );
        assert.notStrictEqual(projects.forFile(`${appRoot}/src/lib/Same.svelte`), app);
        assert.strictEqual(projects.forFile(`${uiRoot}/src/lib/Same.svelte`), ui);
    });

    it('keeps indexed Svelte source invalidation scoped to its proven managers', () => {
        const projects = registry();
        const source = `${appRoot}/src/lib/Same.svelte`;
        const app = projects.forFile(source);
        const ui = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);
        app.getShadowPath(source);

        assert.deepStrictEqual(projects.invalidateForStructuralChange(source), [app]);
        assert.notStrictEqual(projects.forFile(source), app);
        assert.strictEqual(projects.forFile(`${uiRoot}/src/lib/Same.svelte`), ui);
    });

    it('rebuilds a live consumer when a previously missing sibling component is created', () => {
        const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-new-sibling-')));
        const app = `${root}/apps/app`;
        const ui = `${root}/packages/ui`;
        const appSource = `${app}/src/main.ts`;
        const component = `${ui}/src/New.svelte`;

        try {
            fs.mkdirSync(path.dirname(appSource), { recursive: true });
            fs.mkdirSync(path.dirname(component), { recursive: true });
            fs.writeFileSync(
                appSource,
                "export { default as New } from '../../../packages/ui/src/New.svelte';\n"
            );
            fs.writeFileSync(`${app}/package.json`, '{"name":"fixture-app"}');
            fs.writeFileSync(
                `${app}/tsconfig.json`,
                '{"files":["./src/main.ts"],"compilerOptions":{"allowArbitraryExtensions":true}}'
            );
            fs.writeFileSync(`${ui}/package.json`, '{"name":"fixture-ui"}');
            fs.writeFileSync(`${ui}/tsconfig.json`, '{"include":["src"]}');

            const projects = new ProjectRegistry({
                createShadows: (projectRoot, tsconfigPath, writeConfig) =>
                    new ShadowManager({
                        projectPath: projectRoot,
                        sourceRoot: root,
                        tsconfigPath,
                        snapshotOptions,
                        writeConfig
                    }),
                workspaceRoots: [root],
                fallbackRoot: root
            });
            const before = projects.forFile(appSource);
            before.writeOverlayTsconfig([]);
            assert.ok(
                !before
                    .exportBatchGraphPlan()
                    .sourceInputs.some((input) => input.path === component),
                'the absent target unexpectedly entered the initial graph'
            );
            assert.deepStrictEqual(
                projects.all(),
                [before],
                'the sibling owner must remain unseen'
            );

            fs.writeFileSync(component, '<button>new</button>\n');
            assert.deepStrictEqual(projects.invalidateForStructuralChange(component), [before]);

            const after = projects.forFile(appSource);
            assert.notStrictEqual(after, before);
            after.writeOverlayTsconfig([]);
            assert.ok(
                after.exportBatchGraphPlan().sourceInputs.some((input) => input.path === component),
                'the replacement consumer did not resolve the new sibling component'
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('replaces only managers which consumed an arbitrarily named extended config', () => {
        const projects = registry();
        const app = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const ui = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);
        const sharedBase = `${monorepo}/config/strict-base.json`;
        projects.recordProjectGraphInputs(app, {
            configInputs: [`${appRoot}/tsconfig.json`, sharedBase],
            manifestInputs: []
        });
        projects.recordProjectGraphInputs(ui, {
            configInputs: [`${uiRoot}/tsconfig.json`],
            manifestInputs: []
        });

        assert.strictEqual(projects.isTrackedStructuralInput(sharedBase), true);
        assert.deepStrictEqual(projects.invalidateForStructuralChange(sharedBase), [app]);
        assert.notStrictEqual(projects.forFile(`${appRoot}/src/lib/Same.svelte`), app);
        assert.strictEqual(projects.forFile(`${uiRoot}/src/lib/Same.svelte`), ui);
        assert.strictEqual(projects.isTrackedStructuralInput(sharedBase), false);
    });

    it('uses manifest graph inputs to invalidate a sibling package consumer exactly', () => {
        const projects = registry();
        const app = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const ui = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);
        const siblingManifest = `${monorepo}/packages/shared/package.json`;
        projects.recordProjectGraphInputs(app, {
            configInputs: [`${appRoot}/tsconfig.json`],
            manifestInputs: [siblingManifest]
        });
        projects.recordProjectGraphInputs(ui, {
            configInputs: [`${uiRoot}/tsconfig.json`],
            manifestInputs: [`${uiRoot}/package.json`]
        });

        assert.deepStrictEqual(projects.invalidateForStructuralChange(siblingManifest), [app]);
        assert.notStrictEqual(projects.forFile(`${appRoot}/src/lib/Same.svelte`), app);
        assert.strictEqual(projects.forFile(`${uiRoot}/src/lib/Same.svelte`), ui);
    });

    it("maps a consumer shadow through the owner's dirty pinned snapshot", () => {
        const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-owner-map-')));
        const app = `${root}/apps/app`;
        const ui = `${root}/packages/ui`;
        const appSource = `${app}/src/main.ts`;
        const component = `${ui}/src/Button.svelte`;
        const saved = '<p>{savedValue}</p>\n';
        const dirty =
            '<script>let dirtyValue = 1;</script>\n<section>\n  {dirtyValue}\n</section>\n';

        try {
            fs.mkdirSync(path.dirname(appSource), { recursive: true });
            fs.mkdirSync(path.dirname(component), { recursive: true });
            fs.writeFileSync(
                appSource,
                "import Button from '../../../packages/ui/src/Button.svelte';\n"
            );
            fs.writeFileSync(component, saved);
            fs.writeFileSync(`${app}/tsconfig.json`, '{"include":["src"]}');
            fs.writeFileSync(`${ui}/tsconfig.json`, '{"include":["src"]}');

            const projects = new ProjectRegistry({
                createShadows: (projectRoot, tsconfigPath, writeConfig) =>
                    new ShadowManager({
                        projectPath: projectRoot,
                        sourceRoot: root,
                        tsconfigPath,
                        snapshotOptions,
                        writeConfig
                    }),
                workspaceRoots: [root],
                fallbackRoot: root
            });
            const consumer = projects.forFile(appSource);
            assert.ok(
                consumer.ensureSnapshot(component),
                'consumer did not materialise saved source'
            );
            const consumerShadow = consumer.getShadowPath(component);

            const owner = projects.forFile(component);
            const dirtyDocument = Document.createForTest(pathToUrl(component), dirty);
            dirtyDocument.openedByClient = true;
            owner.pinSnapshot(component);
            const dirtySnapshot = owner.transform(dirtyDocument);
            const dirtyOffset = dirty.lastIndexOf('dirtyValue');
            const expectedRange = {
                start: dirtyDocument.positionAt(dirtyOffset),
                end: dirtyDocument.positionAt(dirtyOffset + 'dirtyValue'.length)
            };
            const generatedRange = {
                start: dirtySnapshot.getGeneratedPosition(expectedRange.start),
                end: dirtySnapshot.getGeneratedPosition(expectedRange.end)
            };

            assert.deepStrictEqual(
                mapLocationBack(projects, pathToUrl(consumerShadow), generatedRange),
                { uri: pathToUrl(component), range: expectedRange }
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('invalidates every live manager for a previously unseen sibling manifest', () => {
        const projects = registry();
        const app = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const ui = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);
        projects.recordProjectGraphInputs(app, {
            configInputs: [`${appRoot}/tsconfig.json`],
            manifestInputs: [`${appRoot}/package.json`]
        });
        projects.recordProjectGraphInputs(ui, {
            configInputs: [`${uiRoot}/tsconfig.json`],
            manifestInputs: [`${uiRoot}/package.json`]
        });

        assert.deepStrictEqual(
            new Set(
                projects.invalidateForStructuralChange(
                    `${monorepo}/packages/new-sibling/package.json`
                )
            ),
            new Set([app, ui])
        );
    });

    it('invalidates a package and projects which consumed its sources', () => {
        const projects = registry();
        const app = projects.forFile(`${appRoot}/src/lib/Same.svelte`);
        const ui = projects.forFile(`${uiRoot}/src/lib/Same.svelte`);
        // Register that the app manager has materialised a UI component. The production path
        // does this whenever getShadowPath records the shared reverse index.
        app.getShadowPath(`${uiRoot}/src/lib/Same.svelte`);

        const invalidated = new Set(
            projects.invalidateForStructuralChange(`${uiRoot}/package.json`)
        );
        assert.deepStrictEqual(invalidated, new Set([app, ui]));
        assert.notStrictEqual(projects.forFile(`${appRoot}/src/lib/Same.svelte`), app);
        assert.notStrictEqual(projects.forFile(`${uiRoot}/src/lib/Same.svelte`), ui);
    });
});
