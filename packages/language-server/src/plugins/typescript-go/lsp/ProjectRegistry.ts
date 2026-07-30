import { dirname } from 'path';
import ts from 'typescript';
import { Logger } from '../../../logger';
import { normalizePath } from '../../../utils';
import { SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { ShadowManager } from './ShadowManager';

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

    constructor(
        private readonly createShadows: (
            projectRoot: string,
            tsconfigPath: string | undefined
        ) => ShadowManager,
        /** Used when a file sits outside any tsconfig — normally the server's own root. */
        private readonly fallbackRoot: string
    ) {}

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
        const dir = dirname(normalizePath(filePath));
        let tsconfigPath = this.tsconfigByDir.get(dir);
        if (!this.tsconfigByDir.has(dir)) {
            tsconfigPath = findNearestTsconfig(dir);
            this.tsconfigByDir.set(dir, tsconfigPath);
        }

        const projectRoot = normalizePath(tsconfigPath ? dirname(tsconfigPath) : this.fallbackRoot);
        const existing = this.byProjectRoot.get(projectRoot);
        if (existing) {
            return existing;
        }

        Logger.log(`[tsgo] project ${projectRoot}${tsconfigPath ? '' : ' (no tsconfig)'}`);
        const shadows = this.createShadows(projectRoot, tsconfigPath);
        this.byProjectRoot.set(projectRoot, shadows);
        return shadows;
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

/**
 * Nearest `tsconfig.json`/`jsconfig.json` at or above a directory.
 *
 * `ts.findConfigFile` walks upward and stops at the first hit, which is exactly the semantics
 * wanted — but it does not stop at a package boundary, so a package without its own config
 * adopts its parent's. That matches how `tsc` itself would treat those files.
 */
function findNearestTsconfig(dir: string): string | undefined {
    const found =
        ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ??
        ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json');
    return found ? normalizePath(found) : undefined;
}
