import { basename, dirname } from 'path';
import ts from 'typescript';
import { Logger } from '../../../logger';
import { normalizePath } from '../../../utils';
import { SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { scanWorkspaceSvelteFiles, ShadowManager } from './ShadowManager';

/**
 * The subset of {@link ShadowManager} the mapping layer needs.
 *
 * Mapping is not scoped to one project: a go-to-definition inside an app can land in a component
 * belonging to a sibling package, and the response has to be translated using *that* package's
 * snapshot. So mapping takes a lookup that can search every known project rather than a single
 * manager.
 */
export interface ShadowLookup {
    getOriginalPath(shadowPath: string): string | undefined;
    ensureSnapshot(svelteFilePath: string): SvelteDocumentSnapshot | undefined;
}

export interface ProjectRegistryOptions {
    /**
     * Build a manager for a project. `writeConfig` is true for configured and workspace-owned
     * inferred projects, false for the mapping-only fallback which shadows dependency/foreign
     * files but must never describe a program of its own.
     */
    createShadows: (
        projectRoot: string,
        tsconfigPath: string | undefined,
        writeConfig: boolean
    ) => ShadowManager;
    /**
     * The directories the editor is opened on. Project resolution never leaves them: a tsconfig
     * above the workspace describes someone else's project, and following it once wrote a
     * mirror tree into an entirely different repository.
     */
    workspaceRoots: string[];
    /** Used when a file sits outside any tsconfig — normally the server's own root. */
    fallbackRoot: string;
}

export interface ProjectGraphInputs {
    /** Root and extended TypeScript configuration files read for this manager. */
    configInputs: readonly string[];
    /** Existing or absent package manifests consulted while resolving this manager's graph. */
    manifestInputs: readonly string[];
}

/**
 * One {@link ShadowManager} per TypeScript project, resolved from the file being edited.
 *
 * A language server is opened on a directory, but a workspace is not a project. Deriving one
 * project from the editor's root works only when they coincide — open a monorepo and every
 * assumption that follows from "the project" is drawn from whatever tsconfig happens to sit at
 * the top, which in practice is an empty stub, resolves no Svelte, and has no files. The JS
 * engine has always resolved this per document (`findTsConfigPath` in
 * `LSAndTSDocResolver`); this brings the tsgo engine in line.
 *
 * Projects are created lazily and keyed by the directory of their tsconfig, so a workspace with
 * thirty packages pays only for the ones actually opened.
 */
export class ProjectRegistry implements ShadowLookup {
    private readonly byProjectRoot = new Map<string, ShadowManager>();
    private readonly projectMetadata = new Map<
        ShadowManager,
        { key: string; projectRoot: string; tsconfigPath: string | undefined }
    >();
    /** Resolved tsconfig per containing directory, since the walk hits the filesystem. */
    private readonly tsconfigByDir = new Map<string, string | undefined>();
    private readonly workspaceRoots: string[];
    /**
     * One `.svelte` scan per source root, shared by every manager. The walk covers the whole
     * workspace and is identical for all of them; without sharing, the first request in each
     * newly-opened package re-walked the entire monorepo.
     */
    private readonly svelteFileScans = new Map<string, string[]>();
    /** Shared reverse index avoids scanning every manager on each mapped location/edit. */
    private readonly originalByShadowPath = new Map<string, string>();
    /** One canonical source may be materialised by several consuming projects. */
    private readonly managersByOriginalPath = new Map<string, Set<ShadowManager>>();
    /** Exact graph inputs let watcher invalidation replace consumers, not merely file owners. */
    private readonly graphInputsByManager = new Map<
        ShadowManager,
        { configInputs: Set<string>; manifestInputs: Set<string> }
    >();
    private readonly managersByConfigInput = new Map<string, Set<ShadowManager>>();
    private readonly managersByManifestInput = new Map<string, Set<ShadowManager>>();

    constructor(private readonly options: ProjectRegistryOptions) {
        this.workspaceRoots = options.workspaceRoots.map((root) => normalizePath(root));
    }

    /** Every project opened so far. */
    all(): ShadowManager[] {
        return [...this.byProjectRoot.values()];
    }

    /**
     * The project a file belongs to: the one whose tsconfig is nearest above it.
     *
     * Deliberately the *nearest*, not the outermost. In a monorepo the root config is usually a
     * stub that lists no files, and treating it as the project for everything beneath is what
     * makes an editor opened at the repo root behave differently from one opened at an app.
     */
    forFile(filePath: string): ShadowManager {
        const normalized = normalizePath(filePath);
        const dir = dirname(normalized);
        let tsconfigPath = this.tsconfigByDir.get(dir);
        if (!this.tsconfigByDir.has(dir)) {
            tsconfigPath = this.findNearestTsconfig(normalized, dir);
            this.tsconfigByDir.set(dir, tsconfigPath);
        }

        const projectRoot = normalizePath(
            tsconfigPath ? dirname(tsconfigPath) : this.fallbackRootFor(normalized)
        );
        // A workspace source with no config still needs a real inferred project: its generated
        // shadow must be checked with the Svelte shims/rootDirs rather than tsgo's bare inferred
        // defaults. Keep that manager separate from the mapping-only fallback used for
        // node_modules/outside files. Whichever one is requested first must not determine
        // whether a later workspace document gets a usable project.
        const inferred = !tsconfigPath && this.isConfiglessWorkspaceSource(normalized);
        // A real project, inferred project and mapping-only fallback can all share a directory;
        // they must not share a manager even though their canonical shadow paths do.
        const key = tsconfigPath
            ? projectRoot
            : `${inferred ? 'inferred' : 'fallback'}:${projectRoot}`;
        const existing = this.byProjectRoot.get(key);
        if (existing) {
            return existing;
        }

        Logger.log(
            `[tsgo] project ${projectRoot}${
                tsconfigPath ? '' : inferred ? ' (inferred)' : ' (mapping fallback)'
            }`
        );
        const shadows = this.options.createShadows(
            projectRoot,
            tsconfigPath,
            !!tsconfigPath || inferred
        );
        shadows.setReverseIndexRegistrar((shadowPath, originalPath) => {
            const shadow = normalizePath(shadowPath);
            const original = normalizePath(originalPath);
            this.originalByShadowPath.set(shadow, original);
            const managers = this.managersByOriginalPath.get(original) ?? new Set();
            managers.add(shadows);
            this.managersByOriginalPath.set(original, managers);
        });
        this.byProjectRoot.set(key, shadows);
        this.projectMetadata.set(shadows, { key, projectRoot, tsconfigPath });
        return shadows;
    }

    /** A source file the editor owns, as opposed to dependency/foreign navigation state. */
    private isConfiglessWorkspaceSource(filePath: string): boolean {
        if (filePath.split('/').includes('node_modules')) {
            return false;
        }
        return this.workspaceRoots.some((root) => isWithin(root, filePath));
    }

    /** The shared workspace `.svelte` scan, memoised per source root. */
    workspaceSvelteFiles(sourceRoot: string): string[] {
        const key = normalizePath(sourceRoot);
        let scan = this.svelteFileScans.get(key);
        if (!scan) {
            scan = scanWorkspaceSvelteFiles(key);
            this.svelteFileScans.set(key, scan);
        }
        return scan;
    }

    /** Forget the workspace scans, e.g. when a `.svelte` file is created or deleted. */
    invalidateWorkspaceScans() {
        this.svelteFileScans.clear();
    }

    /** Replace the exact config/manifest input index after a manager publishes a complete graph. */
    recordProjectGraphInputs(manager: ShadowManager, inputs: ProjectGraphInputs): void {
        this.forgetProjectGraphInputs(manager);
        const configInputs = new Set(inputs.configInputs.map(normalizePath));
        const manifestInputs = new Set(inputs.manifestInputs.map(normalizePath));
        this.graphInputsByManager.set(manager, { configInputs, manifestInputs });
        for (const input of configInputs) {
            addIndexedManager(this.managersByConfigInput, input, manager);
        }
        for (const input of manifestInputs) {
            addIndexedManager(this.managersByManifestInput, input, manager);
        }
    }

    /** Whether this exact path was read as a structural input by a live manager. */
    isTrackedStructuralInput(filePath: string): boolean {
        const normalized = normalizePath(filePath);
        return (
            this.managersByConfigInput.has(normalized) ||
            this.managersByManifestInput.has(normalized)
        );
    }

    /**
     * Invalidate project ownership after a file-tree change.
     *
     * A cached "no config" answer is just as significant as a cached config path: creating a
     * nearer tsconfig must move all descendants into the new project, while deleting one must
     * move them back to their parent project. Package manifests are structural too because they
     * determine package roots, dependency Svelte files and subpath-import mappings inside every
     * shadow manager.
     *
     * Completed graph inputs identify exact consumers. Previously unseen manifests deliberately
     * fall back to every live manager because a new export can make an unresolved import resolve.
     * The returned managers let the plugin forget corresponding materialisation promises.
     */
    invalidateForStructuralChange(filePath: string): ShadowManager[] {
        return this.invalidateForStructuralChanges([filePath]);
    }

    /**
     * Batch form keeps every graph-input index alive until all coalesced watcher events have
     * selected their consumers. Removing a manager after the first event must not turn a second,
     * otherwise-exact event into an unnecessary all-project fallback.
     */
    invalidateForStructuralChanges(filePaths: readonly string[]): ShadowManager[] {
        const affected = new Set<ShadowManager>();
        const addConsumersOf = (candidate: string) => {
            for (const manager of this.managersByOriginalPath.get(candidate) ?? []) {
                affected.add(manager);
            }
        };
        let invalidatesWorkspaceScan = false;

        for (const filePath of new Set(filePaths.map(normalizePath))) {
            const name = basename(filePath);
            const standardConfig = name === 'tsconfig.json' || name === 'jsconfig.json';
            const packageManifest = name === 'package.json';
            const configConsumers = this.managersByConfigInput.get(filePath);
            const manifestConsumers = this.managersByManifestInput.get(filePath);
            const trackedInput = !!configConsumers?.size || !!manifestConsumers?.size;
            const transformConfig = /^(?:svelte|vite)\.config\.(?:[cm]?[jt]s)$/.test(name);
            const sourceMembership = /\.(?:svelte|[cm]?[jt]sx?)$/.test(name);
            if (
                !standardConfig &&
                !packageManifest &&
                !trackedInput &&
                !transformConfig &&
                !sourceMembership
            ) {
                continue;
            }

            invalidatesWorkspaceScan = true;
            addConsumersOf(filePath);
            for (const manager of configConsumers ?? []) {
                affected.add(manager);
            }
            for (const manager of manifestConsumers ?? []) {
                affected.add(manager);
            }

            const containingDirectory = dirname(filePath);
            if (standardConfig) {
                // Both a cached positive answer and a cached "no config" below this directory may
                // change. Unrelated packages retain their project managers and dependency indexes.
                for (const directory of [...this.tsconfigByDir.keys()]) {
                    if (isWithin(containingDirectory, directory)) {
                        this.tsconfigByDir.delete(directory);
                    }
                }
                for (const [manager, metadata] of this.projectMetadata) {
                    if (
                        isWithin(containingDirectory, metadata.projectRoot) ||
                        isWithin(metadata.projectRoot, containingDirectory)
                    ) {
                        affected.add(manager);
                    }
                }
            } else if (packageManifest) {
                // Exact graph inputs cover manifests TypeScript/package resolution actually
                // consulted, including absent package.json candidates. If this path has never
                // appeared in a live graph, a new sibling package/export can make a previously
                // unresolved import resolve; no narrower consumer set is provable yet.
                if (!manifestConsumers?.size) {
                    for (const manager of this.byProjectRoot.values()) {
                        affected.add(manager);
                    }
                }
                for (const [original, managers] of this.managersByOriginalPath) {
                    if (!isWithin(containingDirectory, original)) {
                        continue;
                    }
                    for (const manager of managers) {
                        affected.add(manager);
                    }
                }
                for (const [manager, metadata] of this.projectMetadata) {
                    if (
                        isWithin(containingDirectory, metadata.projectRoot) ||
                        isWithin(metadata.projectRoot, containingDirectory)
                    ) {
                        affected.add(manager);
                    }
                }
            } else if (trackedInput) {
                // Arbitrarily named/package-provided extended configs invalidate only managers
                // whose completed graph recorded that exact input.
            } else if (transformConfig) {
                for (const [original, managers] of this.managersByOriginalPath) {
                    if (!isWithin(containingDirectory, original)) {
                        continue;
                    }
                    for (const manager of managers) {
                        affected.add(manager);
                    }
                }
                for (const [manager, metadata] of this.projectMetadata) {
                    if (
                        isWithin(containingDirectory, metadata.projectRoot) ||
                        isWithin(metadata.projectRoot, containingDirectory)
                    ) {
                        affected.add(manager);
                    }
                }
            } else {
                // Source graph changes affect the owning project and any project which consumed
                // the same Svelte/ordinary source through the reverse materialisation index.
                // A previously absent Svelte target has no reverse-index entry yet, though, and
                // can make an unresolved import or export resolve in any live project. Creation,
                // deletion and rename are all delivered through this structural path, so fail
                // closed unless an existing materialisation proves the exact consumers.
                const exactSourceConsumers = this.managersByOriginalPath.get(filePath);
                if (/\.svelte$/i.test(filePath) && !exactSourceConsumers?.size) {
                    for (const manager of this.byProjectRoot.values()) {
                        affected.add(manager);
                    }
                    continue;
                }
                const nearest = this.findNearestTsconfig(filePath, containingDirectory);
                for (const [manager, metadata] of this.projectMetadata) {
                    if (
                        (nearest && metadata.tsconfigPath === nearest) ||
                        (!nearest &&
                            !metadata.tsconfigPath &&
                            isWithin(metadata.projectRoot, filePath))
                    ) {
                        affected.add(manager);
                    }
                }
            }
        }

        if (invalidatesWorkspaceScan) {
            this.invalidateWorkspaceScans();
        }

        // Reusing any affected manager after clearing only its scans would retain an already
        // written overlay tsconfig with stale roots/options. Remove precisely those managers;
        // callers invalidate their local caches and lazily construct replacements.
        for (const manager of affected) {
            const metadata = this.projectMetadata.get(manager);
            if (metadata && this.byProjectRoot.get(metadata.key) === manager) {
                this.byProjectRoot.delete(metadata.key);
            }
            this.projectMetadata.delete(manager);
            this.forgetProjectGraphInputs(manager);
            for (const [original, managers] of this.managersByOriginalPath) {
                managers.delete(manager);
                if (!managers.size) {
                    this.managersByOriginalPath.delete(original);
                }
            }
        }
        return [...affected];
    }

    private forgetProjectGraphInputs(manager: ShadowManager): void {
        const previous = this.graphInputsByManager.get(manager);
        if (!previous) {
            return;
        }
        this.graphInputsByManager.delete(manager);
        for (const input of previous.configInputs) {
            removeIndexedManager(this.managersByConfigInput, input, manager);
        }
        for (const input of previous.manifestInputs) {
            removeIndexedManager(this.managersByManifestInput, input, manager);
        }
    }

    /**
     * Nearest `tsconfig.json`/`jsconfig.json` at or above a directory — bounded the same way
     * the JS engine's `findTsConfigPath` is.
     *
     * `ts.findConfigFile` walks upward without limits, and unbounded is wrong in both
     * directions: above the workspace it adopts a config from a tree the user never opened,
     * and from inside `node_modules` it lets a dependency's file mint a whole project around
     * a config that was never meant to be one.
     */
    private findNearestTsconfig(filePath: string, dir: string): string | undefined {
        const tsconfig = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ?? '';
        const jsconfig = ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json') ?? '';
        // Prefer the closest of the two.
        const found = tsconfig.length >= jsconfig.length ? tsconfig : jsconfig;
        if (!found) {
            return undefined;
        }
        const config = normalizePath(found);
        if (!this.workspaceRoots.some((root) => isWithin(root, config))) {
            return undefined;
        }
        // A config *inside* node_modules never becomes a project: dependencies routinely ship
        // their tsconfig, and minting a manager for one means writing overlays into the store.
        if (config.split('/').includes('node_modules')) {
            return undefined;
        }
        // Nor may a config be adopted *across* a node_modules boundary: a file inside
        // node_modules does not belong to the enclosing user project.
        const configDir = dirname(config);
        const below = isWithin(configDir, filePath)
            ? filePath.slice(configDir.length + 1)
            : filePath;
        if (below.split('/').includes('node_modules')) {
            return undefined;
        }
        return config;
    }

    /** The workspace root a file belongs to, for files that resolve to no project. */
    private fallbackRootFor(filePath: string): string {
        // Multi-root workspaces may contain nested folders (for example, a monorepo and one app
        // opened explicitly). The most specific folder owns a config-less file. Depending on the
        // client's workspace-folder order made the same file alternate between an app-sized and
        // repository-wide fallback project.
        let nearest: string | undefined;
        for (const root of this.workspaceRoots) {
            if (isWithin(root, filePath) && (!nearest || root.length > nearest.length)) {
                nearest = root;
            }
        }
        return nearest ?? normalizePath(this.options.fallbackRoot);
    }

    /** Search every open project for the one that owns a generated path. */
    getOriginalPath(shadowPath: string): string | undefined {
        const normalized = normalizePath(shadowPath);
        const indexed = this.originalByShadowPath.get(normalized);
        if (indexed) {
            return indexed;
        }
        for (const shadows of this.byProjectRoot.values()) {
            const original = shadows.getOriginalPath(normalized);
            if (original) {
                this.originalByShadowPath.set(normalized, original);
                const managers = this.managersByOriginalPath.get(original) ?? new Set();
                managers.add(shadows);
                this.managersByOriginalPath.set(original, managers);
                return original;
            }
        }
        return undefined;
    }

    /**
     * The snapshot for an original path, from whichever project owns it — falling back to the
     * project the path itself resolves to, so a file reached by navigation still maps even if
     * nothing from its project has been opened yet.
     */
    ensureSnapshot(svelteFilePath: string): SvelteDocumentSnapshot | undefined {
        const normalized = normalizePath(svelteFilePath);
        // A dependency consumer may have registered this source first, but the source's own
        // project is where an editor-open (and therefore potentially dirty) snapshot is pinned.
        // Never let insertion order in the reverse index replace that live buffer with a fresh
        // transform of the saved file from some other manager.
        const owner = this.forFile(normalized);
        const ownerSnapshot = owner.getSnapshot(normalized);
        if (ownerSnapshot) {
            addIndexedManager(this.managersByOriginalPath, normalized, owner);
            return ownerSnapshot;
        }

        // Another consumer can still hold the only materialised mapping snapshot. Consult every
        // cache before allowing ensureSnapshot to read from disk.
        const indexedManagers = this.managersByOriginalPath.get(normalized);
        for (const indexedManager of indexedManagers ?? []) {
            const cached = indexedManager.getSnapshot(normalized);
            if (cached) {
                return cached;
            }
        }
        for (const shadows of this.byProjectRoot.values()) {
            const cached = shadows.getSnapshot(normalized);
            if (cached) {
                addIndexedManager(this.managersByOriginalPath, normalized, shadows);
                return cached;
            }
        }

        // No live mapping exists. Transform once from disk using the source's own project and
        // remember it for later cross-project navigation.
        addIndexedManager(this.managersByOriginalPath, normalized, owner);
        return owner.ensureSnapshot(normalized);
    }

    getSnapshotByShadowPath(shadowPath: string): SvelteDocumentSnapshot | undefined {
        const original = this.getOriginalPath(shadowPath);
        return original ? this.ensureSnapshot(original) : undefined;
    }
}

/** Whether `path` is `root` or inside it. Both must be normalized. */
function isWithin(root: string, path: string): boolean {
    return path === root || path.startsWith(root + '/');
}

function addIndexedManager(
    index: Map<string, Set<ShadowManager>>,
    input: string,
    manager: ShadowManager
): void {
    const managers = index.get(input) ?? new Set<ShadowManager>();
    managers.add(manager);
    index.set(input, managers);
}

function removeIndexedManager(
    index: Map<string, Set<ShadowManager>>,
    input: string,
    manager: ShadowManager
): void {
    const managers = index.get(input);
    managers?.delete(manager);
    if (!managers?.size) {
        index.delete(input);
    }
}
