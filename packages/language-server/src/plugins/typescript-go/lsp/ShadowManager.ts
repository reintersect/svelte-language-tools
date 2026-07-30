import { dirname, join, relative, resolve } from 'path';
import fs from 'fs';
import ts from 'typescript';
import { Document } from '../../../lib/documents';
import { Logger } from '../../../logger';
import { normalizePath } from '../../../utils';
import { DocumentSnapshot, SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';

/**
 * Directory holding the only two things that must physically exist for the overlay to work:
 * the overlay tsconfig, and an empty directory skeleton mirroring the source tree.
 *
 * The generated `.tsx` shadows themselves are never written — tsgo accepts them via `didOpen`
 * and they participate fully in module resolution, *provided their parent directory exists on
 * disk*. That directory requirement is why the skeleton exists at all.
 *
 * Deliberately a dot-directory at the project root rather than somewhere under `node_modules`:
 * TypeScript treats anything inside `node_modules` as an external library source, and shadows
 * placed there fail to resolve ordinary dependencies (`Cannot find module 'runed'`). This
 * mirrors what `.svelte-kit` already does, so it is a familiar thing to see and to gitignore.
 */
const OVERLAY_DIR = '.svelte-ls-overlay';
const SHADOW_ROOT = 'svelte';

export interface ShadowManagerOptions {
    /** Directory of the user's tsconfig — the project root for our purposes. */
    projectPath: string;
    /**
     * Outermost directory whose `.svelte` files can end up in this project's program. In a
     * monorepo that is the workspace root, not the app directory: components imported from a
     * linked workspace package (`packages/ui`) are reached through node_modules symlinks and
     * never appear in the app's tsconfig, so basing shadows on the app directory leaves them
     * with no shadow at all — and svelte's ambient `declare module '*.svelte'` then quietly
     * types every one of them `any`.
     */
    sourceRoot: string;
    /** Absolute path to the user's tsconfig/jsconfig, if there is one. */
    tsconfigPath: string | undefined;
    snapshotOptions: SvelteSnapshotOptions;
}

/**
 * Owns the mapping between a real `.svelte` file and the generated `.tsx` shadow that tsgo
 * type-checks, plus the on-disk scaffolding the overlay needs.
 */
export class ShadowManager {
    readonly overlayPath: string;
    readonly shadowRoot: string;
    readonly overlayTsconfigPath: string;

    private readonly snapshots = new Map<
        string,
        { sourceText: string; snapshot: SvelteDocumentSnapshot }
    >();
    private readonly ensuredDirs = new Set<string>();
    /**
     * Source roots, longest first. TypeScript re-bases a failed relative resolution using the
     * *longest* matching `rootDirs` entry, so shadow paths have to be built the same way or the
     * lookup lands in the wrong place and silently falls back to `declare module '*.svelte'`.
     */
    private rootDirsLongestFirst: string[] = [];

    constructor(private readonly options: ShadowManagerOptions) {
        this.overlayPath = join(options.projectPath, OVERLAY_DIR);
        this.shadowRoot = join(this.overlayPath, SHADOW_ROOT);
        this.overlayTsconfigPath = join(this.overlayPath, 'tsconfig.json');
        this.rootDirsLongestFirst = [normalizePath(options.sourceRoot)];
    }

    /** The rootDir a file resolves against: the longest one that contains it. */
    private rootDirFor(filePath: string): string {
        const normalized = normalizePath(filePath);
        for (const root of this.rootDirsLongestFirst) {
            if (normalized === root || normalized.startsWith(root + '/')) {
                return root;
            }
        }
        return normalizePath(this.options.sourceRoot);
    }

    /**
     * Where a `.svelte` file's generated twin lives.
     *
     * Deliberately *not* alongside the original: project selection in tsgo is decided purely by
     * the path of the opened file, so a shadow sitting in the user's own source tree would be
     * assigned to the user's tsconfig — where `.svelte` imports fall back to the ambient
     * `declare module '*.svelte'` and every component's props degrade to `any`.
     */
    getShadowPath(svelteFilePath: string): string {
        const rel = relative(this.rootDirFor(svelteFilePath), svelteFilePath);
        return normalizePath(join(this.shadowRoot, `${rel}.tsx`));
    }

    /** Inverse of {@link getShadowPath}. Returns undefined for paths that aren't shadows. */
    getOriginalPath(shadowPath: string): string | undefined {
        const normalized = normalizePath(shadowPath);
        const root = normalizePath(this.shadowRoot);
        if (!normalized.startsWith(root + '/') || !normalized.endsWith('.tsx')) {
            return undefined;
        }
        const rel = normalized.slice(root.length + 1, -'.tsx'.length);
        // Try each source root; the shadow tree is flat across them, so the first one that has
        // the file on disk is the right owner.
        for (const candidate of this.rootDirsLongestFirst) {
            const guess = normalizePath(join(candidate, rel));
            if (this.snapshots.has(guess) || fs.existsSync(guess)) {
                return guess;
            }
        }
        return normalizePath(join(this.options.sourceRoot, rel));
    }

    getSnapshot(svelteFilePath: string): SvelteDocumentSnapshot | undefined {
        return this.snapshots.get(normalizePath(svelteFilePath))?.snapshot;
    }

    /**
     * Snapshot for a *generated* path. Convenience for callers working in shadow space, e.g.
     * translating an LSP position on a shadow into a checker offset.
     */
    getSnapshotByShadowPath(shadowPath: string): SvelteDocumentSnapshot | undefined {
        const original = this.getOriginalPath(shadowPath);
        return original ? this.getSnapshot(original) : undefined;
    }

    /**
     * Transform a document to its generated form, reusing the previous snapshot when the text
     * is unchanged.
     *
     * The cache is keyed on the source *text*, not on `document.version`. Version is per
     * `Document` instance and always starts at 1, so two different instances for the same path
     * — the detached one built while materialising the project at startup, and the one the
     * editor creates when the user opens that file — collide at version 1 and the second one
     * silently gets the first one's generated code. That presents as edits being ignored until
     * the second keystroke. Comparing text also makes undo/redo and revisits free.
     */
    transform(document: Document): SvelteDocumentSnapshot {
        const filePath = document.getFilePath();
        if (!filePath) {
            throw new Error('cannot create a shadow for a document without a file path');
        }
        const key = normalizePath(filePath);
        const text = document.getText();
        const previous = this.snapshots.get(key);
        if (previous && previous.sourceText === text) {
            return previous.snapshot;
        }

        const snapshot = DocumentSnapshot.fromDocument(
            document,
            this.options.snapshotOptions
        ) as SvelteDocumentSnapshot;
        this.snapshots.set(key, { sourceText: text, snapshot });
        return snapshot;
    }

    deleteSnapshot(svelteFilePath: string) {
        this.snapshots.delete(normalizePath(svelteFilePath));
    }

    /**
     * Write a shadow to disk.
     *
     * Shadows *can* be delivered purely as `didOpen` overlays — that was the original design,
     * and it works — but every `didOpen` forces a synchronous snapshot rebuild inside tsgo, so
     * pushing a whole project through that path costs roughly 75ms per file. On a 300-component
     * project that was ~23s of startup against ~3.7s for tsgo to read the identical program off
     * disk. Materialising them is dramatically cheaper (~360ms for 303 files) and, as a bonus,
     * removes the silent-`any` hazard entirely: a shadow on disk is found whether or not anyone
     * remembered to open it. Only editor-open documents become overlays, where they correctly
     * shadow the on-disk copy.
     */
    writeShadow(shadowPath: string, text: string) {
        this.ensureShadowDirectory(shadowPath);
        try {
            fs.writeFileSync(shadowPath, text);
        } catch (e) {
            Logger.error(`[tsgo] could not write shadow ${shadowPath}`, e);
        }
    }

    /** Delete a single shadow, e.g. when its `.svelte` source was removed. */
    removeShadow(shadowPath: string) {
        try {
            fs.unlinkSync(shadowPath);
        } catch {
            // Already gone, which is the desired state anyway.
        }
    }

    /** Remove shadows whose `.svelte` source no longer exists, so stale roots don't error. */
    pruneOrphanedShadows(liveShadowPaths: Set<string>) {
        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (
                    entry.name.endsWith('.tsx') &&
                    !liveShadowPaths.has(normalizePath(full))
                ) {
                    try {
                        fs.unlinkSync(full);
                    } catch {
                        // best effort
                    }
                }
            }
        };
        walk(this.shadowRoot);
    }

    /**
     * Create the parent directory of a shadow. tsgo resolves a never-on-disk `.tsx` only when
     * its containing directory physically exists — same-directory and rootDirs-bridged
     * resolution both fail with TS2307 when it doesn't.
     */
    ensureShadowDirectory(shadowPath: string) {
        const dir = dirname(shadowPath);
        if (this.ensuredDirs.has(dir)) {
            return;
        }
        try {
            fs.mkdirSync(dir, { recursive: true });
            this.ensuredDirs.add(dir);
        } catch (e) {
            Logger.error(`[tsgo] could not create shadow directory ${dir}`, e);
        }
    }

    /**
     * Write the overlay tsconfig. It extends the user's config so their compilerOptions, paths
     * and lib settings all apply, then adds exactly what the shadow scheme needs:
     * `rootDirs` to bridge `src/Foo.svelte` to `<overlay>/svelte/src/Foo.svelte.tsx`, and
     * `allowArbitraryExtensions` so the `.svelte.tsx` twin is a legal resolution target.
     *
     * Note there is deliberately no `.d.ts` re-export shim: over LSP, rootDirs plus
     * allowArbitraryExtensions resolve `./Foo.svelte` straight to the `.tsx`.
     */
    writeOverlayTsconfig(shimFiles: string[]) {
        fs.mkdirSync(this.shadowRoot, { recursive: true });
        // Self-ignoring, so no project has to remember to add this to its own .gitignore.
        try {
            fs.writeFileSync(join(this.overlayPath, '.gitignore'), '*\n');
        } catch {
            // Not being able to write the ignore file is not worth failing over.
        }

        const base = this.parseBaseConfig();

        const config: any = {
            compilerOptions: {
                allowArbitraryExtensions: true,
                allowImportingTsExtensions: true,
                noEmit: true,
                // The shadows are .tsx, so JSX has to be on or every `.svelte` import reports
                // TS6142 ("resolved to a .tsx file, but --jsx is not set"). `preserve` is what
                // the JS engine's snapshots are checked under too.
                jsx: 'preserve',
                // `rootDirs` must be *merged*, not replaced. SvelteKit's generated config
                // declares its own (`["..", "./types"]`) and dropping those breaks `$app/types`
                // and every route's `./$types` import.
                rootDirs: [...base.rootDirs, this.options.sourceRoot, this.shadowRoot]
            },
            // `files` and `include` are unioned by TypeScript. The base's resolved file list
            // goes in `files` because a derived config's `include` *replaces* the base's rather
            // than extending it — writing our own glob would silently drop `.svelte-kit`'s
            // ambient declarations ($env/static/public and friends).
            files: [...base.fileNames, ...shimFiles],
            include: [`${this.shadowRoot}/**/*`]
        };

        if (this.options.tsconfigPath) {
            config.extends = this.options.tsconfigPath;
        }

        const contents = JSON.stringify(config, null, 4);
        try {
            // Avoid rewriting an identical file: tsgo watches it, and a no-op write would
            // invalidate the project for nothing.
            if (
                !fs.existsSync(this.overlayTsconfigPath) ||
                fs.readFileSync(this.overlayTsconfigPath, 'utf8') !== contents
            ) {
                fs.writeFileSync(this.overlayTsconfigPath, contents);
            }
        } catch (e) {
            Logger.error(`[tsgo] could not write overlay tsconfig`, e);
        }
    }

    /**
     * Resolve the user's config far enough to know which files it pulls in and what its
     * `rootDirs` are, so the overlay can extend both rather than overwrite them.
     */
    private parseBaseConfig(): { rootDirs: string[]; fileNames: string[] } {
        const fallback = { rootDirs: [this.options.projectPath], fileNames: [] as string[] };
        if (!this.options.tsconfigPath) {
            return fallback;
        }
        try {
            const read = ts.readConfigFile(this.options.tsconfigPath, ts.sys.readFile);
            if (read.error || !read.config) {
                return fallback;
            }
            const parsed = ts.parseJsonConfigFileContent(
                read.config,
                {
                    ...ts.sys,
                    // Surface .svelte files so their *shadows* can stand in for them below;
                    // tsgo itself cannot parse a .svelte file.
                    readDirectory: (rootDir, extensions, excludes, includes, depth) =>
                        ts.sys.readDirectory(
                            rootDir,
                            [...(extensions ?? []), '.svelte'],
                            excludes,
                            includes,
                            depth
                        )
                },
                dirname(this.options.tsconfigPath)
            );

            const rootDirs = parsed.options.rootDirs?.length
                ? parsed.options.rootDirs.map((d) => normalizePath(d))
                : [this.options.projectPath];

            // Must be set before the fileNames below are mapped: getShadowPath depends on it,
            // or the `files` list would name shadows at paths we never write to.
            this.rootDirsLongestFirst = [
                ...new Set([...rootDirs, normalizePath(this.options.sourceRoot)])
            ].sort((a, b) => b.length - a.length);

            // Substitute each .svelte entry with its shadow. tsgo cannot parse the real file,
            // and the shadows must be listed explicitly: they never exist on disk, so an
            // `include` glob cannot match them, and a component that nothing imports would
            // otherwise fall outside the project entirely — landing in an inferred project
            // where the svelte2tsx shims, `jsx` and `rootDirs` all stop applying, which shows
            // up as "Cannot find name 'svelteHTML'" on every such file.
            const fileNames = parsed.fileNames.map((f) =>
                f.endsWith('.svelte') ? this.getShadowPath(normalizePath(f)) : normalizePath(f)
            );

            return { rootDirs, fileNames };
        } catch (e) {
            Logger.error('[tsgo] could not parse the project tsconfig; using defaults', e);
            return fallback;
        }
    }

    /** Every `.svelte` file in the project, which all need eagerly-opened shadows. */
    findProjectSvelteFiles(): string[] {
        const found: string[] = [];
        const excluded = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build']);
        const walk = (dir: string, depth: number) => {
            if (depth > 12) {
                return;
            }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.') && entry.name !== '.svelte-kit') {
                    continue;
                }
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!excluded.has(entry.name)) {
                        walk(full, depth + 1);
                    }
                } else if (entry.name.endsWith('.svelte')) {
                    found.push(normalizePath(full));
                }
            }
        };
        walk(this.options.sourceRoot, 0);
        return found;
    }
}

/** Resolve the tsgo executable from the project, preferring effect-tsgo when present. */
export function resolveTsGoPath(fromPath: string): string | undefined {
    // SVELTE_LS_TSGO_PACKAGE pins a specific build, which is mainly useful for A/B-ing
    // effect-tsgo (which additionally runs the Effect language service) against stock tsgo.
    const pinned = process.env.SVELTE_LS_TSGO_PACKAGE;
    const candidates = pinned
        ? [pinned]
        : ['@reintersect/effect-tsgo', '@typescript/native', '@typescript/native-preview'];
    for (const moduleName of candidates) {
        try {
            const pkgPath = require.resolve(`${moduleName}/package.json`, {
                paths: [fromPath, __dirname]
            });
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const bin = pkg.bin;
            const binRel = typeof bin === 'string' ? bin : (bin?.tsgo ?? bin?.tsc);
            if (!binRel) {
                continue;
            }
            const binPath = resolve(dirname(pkgPath), binRel);
            if (fs.existsSync(binPath)) {
                return binPath;
            }
        } catch {
            // try the next candidate
        }
    }
    return undefined;
}

/**
 * Walk up from the project looking for a workspace root, so components in linked workspace
 * packages get shadows too. Stops at the git root (or the filesystem root) to avoid pulling in
 * the user's entire home directory when a project isn't part of a workspace.
 */
export function findWorkspaceRoot(projectPath: string): string {
    let current = normalizePath(projectPath);
    let best = current;
    for (let depth = 0; depth < 8; depth++) {
        const parent = dirname(current);
        if (!parent || parent === current) {
            break;
        }
        const isWorkspaceRoot =
            fs.existsSync(join(current, 'pnpm-workspace.yaml')) ||
            fs.existsSync(join(current, 'lerna.json')) ||
            hasWorkspacesField(join(current, 'package.json'));
        if (isWorkspaceRoot) {
            best = current;
        }
        if (fs.existsSync(join(current, '.git'))) {
            // The repository boundary is as far as we are willing to go.
            return best === current ? current : best;
        }
        current = parent;
    }
    return best;
}

function hasWorkspacesField(packageJsonPath: string): boolean {
    try {
        return !!JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).workspaces;
    } catch {
        return false;
    }
}

/** Read the user's tsconfig just far enough to know where the project root is. */
export function findProjectTsconfig(fromPath: string): string | undefined {
    return (
        ts.findConfigFile(fromPath, ts.sys.fileExists, 'tsconfig.json') ??
        ts.findConfigFile(fromPath, ts.sys.fileExists, 'jsconfig.json')
    );
}
