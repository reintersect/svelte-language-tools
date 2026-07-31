import { dirname } from 'path';
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
     * Build a manager for a project. `writeConfig` is false for the shared fallback manager,
     * which shadows files that belong to no project (so navigation into them still maps) but
     * must never describe a program of its own.
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
    /** Resolved tsconfig per containing directory, since the walk hits the filesystem. */
    private readonly tsconfigByDir = new Map<string, string | undefined>();
    private readonly workspaceRoots: string[];
    /**
     * One `.svelte` scan per source root, shared by every manager. The walk covers the whole
     * workspace and is identical for all of them; without sharing, the first request in each
     * newly-opened package re-walked the entire monorepo.
     */
    private readonly svelteFileScans = new Map<string, string[]>();

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
        // A real project and the config-less fallback can share a directory (a workspace root
        // with a genuine tsconfig); they must not share a manager.
        const key = tsconfigPath ? projectRoot : `fallback:${projectRoot}`;
        const existing = this.byProjectRoot.get(key);
        if (existing) {
            return existing;
        }

        Logger.log(`[tsgo] project ${projectRoot}${tsconfigPath ? '' : ' (no tsconfig)'}`);
        const shadows = this.options.createShadows(projectRoot, tsconfigPath, !!tsconfigPath);
        this.byProjectRoot.set(key, shadows);
        return shadows;
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
        return (
            this.workspaceRoots.find((root) => isWithin(root, filePath)) ??
            normalizePath(this.options.fallbackRoot)
        );
    }

    /** Search every open project for the one that owns a generated path. */
    getOriginalPath(shadowPath: string): string | undefined {
        for (const shadows of this.byProjectRoot.values()) {
            const original = shadows.getOriginalPath(shadowPath);
            if (original) {
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
        for (const shadows of this.byProjectRoot.values()) {
            const cached = shadows.getSnapshot(svelteFilePath);
            if (cached) {
                return cached;
            }
        }
        return this.forFile(svelteFilePath).ensureSnapshot(svelteFilePath);
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
