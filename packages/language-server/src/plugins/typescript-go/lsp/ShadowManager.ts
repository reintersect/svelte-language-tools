import { dirname, isAbsolute, join, relative, resolve } from 'path';
import fs from 'fs';
import ts from 'typescript';
import { internalHelpers, InternalHelpers } from 'svelte2tsx';
import { Document } from '../../../lib/documents';
import { Logger } from '../../../logger';
import { normalizePath } from '../../../utils';
import { DocumentSnapshot, SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';

/**
 * Directory each package gets for its generated twins, plus — in the package being checked —
 * the overlay tsconfig.
 *
 * A dot-directory at the package root, deliberately not somewhere under `node_modules`:
 * TypeScript treats anything inside `node_modules` as an external library source, and shadows
 * placed there fail to resolve ordinary dependencies (`Cannot find module 'runed'`). This
 * mirrors what `.svelte-kit` already does, so it is a familiar thing to see and to gitignore —
 * and it writes its own `.gitignore` regardless.
 */
const OVERLAY_DIR = '.svelte-ls-overlay';
const SHADOW_ROOT = 'svelte';

export interface ShadowManagerOptions {
    /** Directory of the user's tsconfig — the project root for our purposes. */
    projectPath: string;
    /**
     * Outermost directory whose `.svelte` files can end up in this project's program. In a
     * monorepo that is the workspace root, not the app directory: components imported from a
     * linked workspace package are reached through node_modules symlinks and
     * never appear in the app's tsconfig, so basing shadows on the app directory leaves them
     * with no shadow at all — and svelte's ambient `declare module '*.svelte'` then quietly
     * types every one of them `any`.
     */
    sourceRoot: string;
    /** Absolute path to the user's tsconfig/jsconfig, if there is one. */
    tsconfigPath: string | undefined;
    snapshotOptions: SvelteSnapshotOptions;
    /**
     * When set, SvelteKit route/hook/param files get shadows too, carrying the type annotations
     * that give `load({ params })` and friends their inferred parameter types. Without it those
     * parameters are implicitly `any` and a strict project reports an error on every one.
     *
     * Optional because the shadow has to be *materialised* for this to work, which only the
     * batch path does — an unwritten file named in `files` is TS6053.
     */
    kitFiles?: InternalHelpers.KitFilesSettings;
}

/** A SvelteKit file's generated twin, with what's needed to map positions back. */
export interface KitShadow {
    originalPath: string;
    shadowPath: string;
    addedCode: InternalHelpers.AddedCode[];
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
    /**
     * The `.svelte` files the user's own tsconfig resolves to, as opposed to every `.svelte`
     * file that needs a shadow. The two differ by a lot: shadows are written for the whole
     * workspace and for dependencies, because anything the program can import has to resolve,
     * while only this set is the project's own responsibility to report on.
     */
    private projectSvelteFiles: string[] = [];
    private projectSvelteFileScan: string[] | undefined;
    private dependencySvelteFileScan: string[] | undefined;
    private owningPackages: string[] | undefined;
    /** Kit shadows by original path, and the reverse lookup by shadow path. */
    private readonly kitShadows = new Map<string, KitShadow>();
    private readonly kitShadowsByShadowPath = new Map<string, KitShadow>();

    /**
     * Nearest directory at or above the project that has a package.json.
     *
     * Not the same as `projectPath`, which is wherever the tsconfig happens to live —
     * `svelte-check --tsconfig ./.svelte-kit/tsconfig.json` is the documented way to check a
     * SvelteKit project, and `.svelte-kit` has no package.json. Reading dependencies and subpath
     * imports from there yields nothing at all, which shows up as every component from a
     * dependency silently typing as `any`.
     */
    private readonly packageRoot: string;
    /** Mirror directory per package root, and the package root per directory that feeds it. */
    private readonly mirrorRoots = new Map<string, string>();
    private readonly packageRootByDir = new Map<string, string>();
    private readonly originalByShadowPath = new Map<string, string>();

    constructor(private readonly options: ShadowManagerOptions) {
        this.overlayPath = join(options.projectPath, OVERLAY_DIR);
        this.overlayTsconfigPath = join(this.overlayPath, 'tsconfig.json');
        this.rootDirsLongestFirst = [normalizePath(options.sourceRoot)];
        this.packageRoot = findPackageRoot(options.projectPath, options.sourceRoot);
        // The project's own mirror. Named separately because it is the one the overlay tsconfig
        // sits beside, and the one the LSP writes editor-open shadows into.
        this.shadowRoot = normalizePath(join(this.packageRoot, OVERLAY_DIR, SHADOW_ROOT));
        this.mirrorRoots.set(normalizePath(this.packageRoot), this.shadowRoot);
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
     * The mirror a given file's shadow belongs in: one per package, inside that package.
     *
     * Two things about a module specifier depend on where the *importing file* physically sits,
     * and both silently break if a component is type-checked from somewhere else:
     *
     * - **Bare specifiers** walk up looking for `node_modules`. A component in a sibling
     *   package finds that package's own dependencies in its `node_modules`; from a mirror
     *   under the app being checked, the walk reaches only the app's — which under pnpm holds
     *   none of another package's dependencies. That alone was 239 `Cannot find module` errors
     *   for packages that are installed and resolve perfectly well in the editor.
     * - **Subpath imports** (`#lib/*`) resolve against the nearest package.json, which from a
     *   foreign mirror is the app's, and it has never heard of `#lib`. Another 356.
     *
     * Putting each package's mirror *inside that package* makes both resolve natively, with no
     * aliasing at all: the walk up from `<pkg>/.svelte-ls-overlay/svelte/...` reaches `<pkg>`
     * before anything else. The alternative — declaring these in the overlay's `paths` — cannot
     * work, because `paths` is one flat table for the whole project while `imports` is
     * per-package, so a global `#*` on one package's behalf retargets every other package's.
     */
    private mirrorRootFor(filePath: string): string {
        return this.mirrorRootIn(this.packageRootOf(filePath));
    }

    /** The mirror belonging to a package root, registering it the first time it is asked for. */
    private mirrorRootIn(packageRoot: string): string {
        packageRoot = normalizePath(packageRoot);
        let mirror = this.mirrorRoots.get(packageRoot);
        if (!mirror) {
            mirror = normalizePath(join(packageRoot, OVERLAY_DIR, SHADOW_ROOT));
            this.mirrorRoots.set(packageRoot, mirror);
        }
        return mirror;
    }

    private packageRootOf(filePath: string): string {
        const dir = normalizePath(dirname(filePath));
        let cached = this.packageRootByDir.get(dir);
        if (!cached) {
            cached = findPackageRoot(dir, this.options.sourceRoot);
            this.packageRootByDir.set(dir, cached);
        }
        return cached;
    }

    /**
     * Where a `.svelte` file's generated twin lives.
     *
     * Deliberately *not* alongside the original: project selection in tsgo is decided purely by
     * the path of the opened file, so a shadow sitting in the user's own source tree would be
     * assigned to the user's tsconfig — where `.svelte` imports fall back to the ambient
     * `declare module '*.svelte'` and every component's props degrade to `any`. The path within
     * the mirror is relative to the file's `rootDirs` entry, which is what lets a failed relative
     * import bridge back to the real tree.
     */
    getShadowPath(svelteFilePath: string): string {
        const rel = relative(this.rootDirFor(svelteFilePath), svelteFilePath);
        const shadowPath = normalizePath(join(this.mirrorRootFor(svelteFilePath), `${rel}.tsx`));
        this.originalByShadowPath.set(shadowPath, normalizePath(svelteFilePath));
        return shadowPath;
    }

    /** Inverse of {@link getShadowPath}. Returns undefined for paths that aren't shadows. */
    getOriginalPath(shadowPath: string): string | undefined {
        const normalized = normalizePath(shadowPath);
        const kit = this.kitShadowsByShadowPath.get(normalized);
        if (kit) {
            return kit.originalPath;
        }
        const known = this.originalByShadowPath.get(normalized);
        if (known) {
            return known;
        }
        if (!normalized.endsWith('.tsx')) {
            return undefined;
        }
        // Not seen this run — a shadow left over from a previous one, or a path arriving from
        // the client. Work it back out from whichever mirror contains it.
        for (const mirror of this.mirrorRoots.values()) {
            if (!normalized.startsWith(mirror + '/')) {
                continue;
            }
            const rel = normalized.slice(mirror.length + 1, -'.tsx'.length);
            for (const candidate of this.rootDirsLongestFirst) {
                const guess = normalizePath(join(candidate, rel));
                if (this.snapshots.has(guess) || fs.existsSync(guess)) {
                    return guess;
                }
            }
        }
        return undefined;
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
     * Drop every cached snapshot.
     *
     * For a batch check the cache is a liability rather than a help: transforming a whole
     * monorepo populates one entry per file and each holds generated text plus decoded mappings,
     * none of which is needed again unless the compiler reports something on that file.
     * Re-transforming those few costs about a millisecond each.
     */
    clearSnapshots() {
        this.snapshots.clear();
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
                if (entry.isSymbolicLink()) {
                    continue;
                }
                if (entry.isDirectory()) {
                    walk(full);
                } else if (!liveShadowPaths.has(normalizePath(full))) {
                    try {
                        fs.unlinkSync(full);
                    } catch {
                        // best effort
                    }
                }
            }
        };
        for (const mirror of this.mirrorRoots.values()) {
            walk(mirror);
        }
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
        fs.mkdirSync(this.overlayPath, { recursive: true });
        // Discovering the mirrors has to happen before the config is written, since every one of
        // them is a rootDirs entry.
        for (const packagePath of this.svelteOwningPackages()) {
            this.ensureMirror(this.mirrorRootIn(packagePath));
        }
        this.ensureMirror(this.shadowRoot);

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
                // Each mirror is paired with the real tree by the same relative path, so a
                // failed relative import inside a shadow bridges straight back. Base entries
                // come first: SvelteKit declares its own (`["..", "./types"]`) and a route's
                // `./$types` has to reach `.svelte-kit/types` before anything else is tried.
                rootDirs: [
                    ...base.rootDirs,
                    this.options.sourceRoot,
                    ...new Set(this.mirrorRoots.values())
                ]
            },
            // `files` carries the base's resolved file list with each .svelte entry replaced
            // by its shadow. Deliberately no `include` glob over the shadow root: in a monorepo
            // the shadow tree holds components from every workspace package, and globbing them
            // all in makes them roots of *this* project — where their own `$lib`/`#lib` aliases
            // and workspace deps do not resolve. On one such package that turned 18 real errors into
            // 1277. Shadows for other packages still resolve when imported, because they exist
            // on disk and rootDirs bridges to them; they just are not roots.
            files: [...base.fileNames, ...shimFiles]
        };

        // `rootDirs` only ever rescues a *relative* specifier that failed to resolve. An alias —
        // `$lib/Foo.svelte`, `#lib/Foo.svelte` — is resolved through `paths` or through
        // package.json's `imports` field instead, never reaches the rootDirs fallback, and so
        // bypasses the shadow tree entirely. Svelte's ambient `declare module '*.svelte'` then
        // absorbs the failure and the component types as `SvelteComponent<Record<string, any>>`
        // with no error of any kind. `$lib` being the canonical SvelteKit import, that alone is
        // enough to silently disable prop checking across an entire project.
        //
        // So every alias gets a shadow-tree target ahead of its real one.
        const paths = this.overlayPaths(base);
        if (Object.keys(paths).length) {
            config.compilerOptions.paths = paths;
        }

        this.writeTsSupportConfig(base, shimFiles, paths);

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
     * The overlay's `paths`: every alias the project already had, each pointing at the shadow
     * tree before it points at the real one, plus the project's package.json `imports`.
     *
     * This has to carry the base config's own mappings verbatim as well, because — like
     * `include` and `rootDirs` — a derived config's `paths` REPLACES the base's rather than
     * merging with it. Dropping SvelteKit's `$lib`/`$app`/`$env` entries breaks the project
     * outright, which at least fails loudly; getting the rewriting wrong does not.
     */
    private overlayPaths(base: {
        paths: Record<string, string[]>;
        pathsBasePath: string | undefined;
    }): Record<string, string[]> {
        const paths: Record<string, string[]> = {};

        // The base's own mappings, carried over untouched apart from being made absolute: they
        // are relative to whichever config declared them and would otherwise be re-read relative
        // to this one. `baseUrl` used to express that, but TypeScript 7 removed it (TS5102).
        for (const [pattern, targets] of Object.entries(base.paths)) {
            const expanded: string[] = [];
            for (const target of targets) {
                const absolute =
                    base.pathsBasePath && !isAbsolute(target)
                        ? normalizePath(resolve(base.pathsBasePath, target))
                        : target;
                // The mirror first, so `$lib/Foo.svelte` finds the shadow; the real path after,
                // so everything else resolves as it always did. Extending the pattern the
                // project already has, rather than adding a `.svelte`-specific sibling, because
                // TypeScript breaks ties between patterns on *prefix* length alone — `$lib/*`
                // and `$lib/*.svelte` tie, and the winner is then whichever was declared first.
                const shadowed = this.shadowEquivalent(absolute);
                if (shadowed) {
                    expanded.push(shadowed);
                }
                expanded.push(absolute);
            }
            paths[pattern] = expanded;
        }

        // A package's own `.ts` files import its components through its subpath imports too —
        // a barrel doing `import GroupLabel from '#lib/.../label.svelte'` sits at its real
        // location, resolves `#lib` against its real package.json, and lands on the real
        // `.svelte` file, which is not something TypeScript can read. Subpath imports get no
        // `rootDirs` fallback, so without an entry here that import quietly becomes `any` and
        // takes the component's whole props type with it.
        //
        // Only the `.svelte`-suffixed form is injected; see {@link addSvelteVariant}. Everything
        // else resolves natively, because each mirror sits inside the package it mirrors.
        for (const packagePath of this.svelteOwningPackages()) {
            let pkg: any;
            try {
                pkg = JSON.parse(fs.readFileSync(join(packagePath, 'package.json'), 'utf8'));
            } catch {
                continue;
            }
            for (const [pattern, target] of Object.entries(pkg.imports ?? {})) {
                const resolved = firstStringTarget(target);
                if (resolved?.startsWith('./')) {
                    this.addSvelteVariant(paths, pattern, [
                        normalizePath(join(packagePath, resolved.slice(2)))
                    ]);
                }
            }
        }

        return paths;
    }

    /**
     * Add a `.svelte`-only sibling of an alias pattern, resolving to the shadow tree.
     *
     * Restricting the injected entry to specifiers that end in `.svelte` is what keeps this from
     * doing damage. `paths` is a single flat table for the whole project, while package.json
     * `imports` is per-package — so injecting a bare `#*` on one package's behalf silently
     * retargets every *other* package's `#*` at it, and TypeScript reports the resulting
     * wrong-module errors as missing exports. A pattern like `#*.svelte` cannot match anything
     * but a component import, so every other specifier keeps resolving exactly as it did.
     *
     * The real path is repeated as a fallback because TypeScript commits to one pattern and does
     * not reconsider: a target list that misses means the ambient `declare module '*.svelte'`
     * takes over, silently.
     *
     * This is only safe where no bare form of the same pattern is also emitted. Ties between
     * patterns are broken on prefix length alone, so `#lib/*` and `#lib/*.svelte` would tie and
     * the winner would be whichever happened to be declared first.
     */
    private addSvelteVariant(paths: Record<string, string[]>, pattern: string, targets: string[]) {
        if (!pattern.includes('*')) {
            return;
        }
        const svelteTargets: string[] = [];
        for (const target of targets) {
            if (!target.includes('*')) {
                continue;
            }
            const shadowed = this.shadowEquivalent(target);
            if (shadowed) {
                svelteTargets.push(`${shadowed}.svelte`);
            }
            svelteTargets.push(`${target}.svelte`);
        }
        if (!svelteTargets.length) {
            return;
        }
        const key = `${pattern}.svelte`;
        // Two packages can define the same pattern (`#lib/*` is popular). Both target sets go in
        // and TypeScript takes the first that exists on disk.
        paths[key] = [...(paths[key] ?? []), ...svelteTargets];
    }

    /**
     * Emit a config fragment that lets the user's *own* TypeScript project resolve `.svelte`
     * imports from `.ts` and `.js` files.
     *
     * This is what `typescript-svelte-plugin` does, without the plugin. That plugin exists
     * because TypeScript cannot read `.svelte` — but it never needed to, it needed to find
     * *something* type-checkable at that specifier, and the shadow tree is exactly that. Four
     * compiler options connect the two, and then a plain `.ts` file gets a component's real props
     * type: verified end to end against unpatched tsgo, where `label: 123` on a `label: string`
     * prop reports TS2322 rather than passing silently.
     *
     * Worth preferring over patching the compiler. It needs no fork, survives tsgo's daily churn,
     * and works identically on stock TypeScript 6 — whereas teaching a Go compiler about Svelte
     * means a parser *and* the svelte2tsx projection in Go.
     *
     * Add to the project's tsconfig (TypeScript 5+ takes an array, so a SvelteKit project keeps
     * its generated config):
     *
     * ```jsonc
     * { "extends": ["./.svelte-kit/tsconfig.json", "./.svelte-ls-overlay/tsconfig.ts-support.json"] }
     * ```
     *
     * Freshness is save-granular: shadows are rewritten when a file changes on disk, so a `.ts`
     * file sees a component's props as of its last save.
     */
    private writeTsSupportConfig(
        base: { rootDirs: string[] },
        shimFiles: string[],
        paths: Record<string, string[]>
    ) {
        const config = {
            compilerOptions: {
                // Everything here is additive. `extends` merges compilerOptions key by key, so
                // anything the project already sets and this does not is untouched.
                allowArbitraryExtensions: true,
                allowImportingTsExtensions: true,
                jsx: 'preserve',
                // Replaces rather than merges, hence carrying the project's own entries through.
                rootDirs: [
                    ...base.rootDirs,
                    this.options.sourceRoot,
                    ...new Set(this.mirrorRoots.values())
                ],
                ...(Object.keys(paths).length ? { paths } : {})
            },
            // The svelte2tsx shims. `files` and `include` are independent, so a project that
            // declares `include` still gets these as extra roots rather than losing its sources.
            //
            // Resolved from the *project's* node_modules, never this package's: the shims contain
            // `import('svelte')` type references, and a second copy of Svelte in the program means
            // two ambient `declare module 'svelte'` blocks. Svelte 4's `ComponentProps` wins that
            // merge and collapses every Svelte 5 component to `never`.
            files: shimFiles
        };

        const target = join(this.overlayPath, 'tsconfig.ts-support.json');
        const contents = JSON.stringify(config, null, 4);
        try {
            if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) {
                fs.writeFileSync(target, contents);
            }
        } catch (e) {
            Logger.debug('[tsgo] could not write the .ts-support config', e);
        }
    }

    /**
     * Create a mirror directory and mark it ignored.
     *
     * Deliberately nothing else: no package.json, no links. The mirror sits inside the package
     * it mirrors, so the upward walk for `node_modules` and for the nearest package.json passes
     * straight through it and lands on the real ones.
     */
    private ensureMirror(mirrorRoot: string) {
        try {
            fs.mkdirSync(mirrorRoot, { recursive: true });
            // Self-ignoring, so no package has to remember to add this to its own .gitignore.
            const ignore = join(dirname(mirrorRoot), '.gitignore');
            if (!fs.existsSync(ignore)) {
                fs.writeFileSync(ignore, '*\n');
            }
        } catch (e) {
            Logger.debug(`[tsgo] could not create mirror ${mirrorRoot}`, e);
        }
    }

    /**
     * Packages that own at least one of the `.svelte` files being shadowed, nearest package.json
     * first, with the project itself always included.
     *
     * These are the packages whose subpath imports have to be mirrored. A component's `#lib/*`
     * import normally resolves against the package.json above it on disk — but its shadow lives
     * in this project's overlay tree, where the package.json above it is *this* project's, so
     * the import resolves to nothing and the ambient `declare module '*.svelte'` swallows it.
     *
     * Deliberately restricted to packages that actually contribute components rather than every
     * package.json in the workspace: a monorepo where nine packages each define `#*` differently
     * would otherwise turn one flat `paths` table into a lottery.
     */
    private svelteOwningPackages(): string[] {
        if (this.owningPackages) {
            return this.owningPackages;
        }
        const roots = new Set<string>([normalizePath(this.packageRoot)]);
        const sourceRoot = normalizePath(this.options.sourceRoot);
        const seenDirs = new Set<string>();

        // Dependencies count too. A library shipping a raw `.svelte` file needs its shadow in a
        // mirror of its own, and that mirror only takes part in resolution if it is a `rootDirs`
        // entry — which means discovering it before the config is written, not while shadows are
        // being materialised afterwards.
        for (const filePath of [
            ...this.findProjectSvelteFiles(),
            ...this.findDependencySvelteFiles()
        ]) {
            let dir = dirname(filePath);
            while (dir.length >= sourceRoot.length && !seenDirs.has(dir)) {
                seenDirs.add(dir);
                if (fs.existsSync(join(dir, 'package.json'))) {
                    roots.add(normalizePath(dir));
                    break;
                }
                const parent = dirname(dir);
                if (parent === dir) {
                    break;
                }
                dir = parent;
            }
        }
        this.owningPackages = [...roots];
        return this.owningPackages;
    }

    /**
     * Where an aliased path would live in the shadow tree, or undefined when it points outside
     * every source root and so has no shadow. Wildcards survive: this is plain path arithmetic,
     * so `<root>/src/lib/*` maps to `<shadowRoot>/src/lib/*`.
     */
    private shadowEquivalent(absolutePath: string): string | undefined {
        if (!isAbsolute(absolutePath)) {
            return undefined;
        }
        const normalized = normalizePath(absolutePath);
        if (normalized.includes(`/${OVERLAY_DIR}/`)) {
            return undefined;
        }
        const rel = relative(this.rootDirFor(normalized), normalized);
        if (rel.startsWith('..')) {
            return undefined;
        }
        return normalizePath(join(this.mirrorRootFor(normalized), rel));
    }

    /**
     * Resolve the user's config far enough to know which files it pulls in and what its
     * `rootDirs` are, so the overlay can extend both rather than overwrite them.
     */
    private parseBaseConfig(): {
        rootDirs: string[];
        fileNames: string[];
        paths: Record<string, string[]>;
        pathsBasePath: string | undefined;
    } {
        const fallback = {
            rootDirs: [this.options.projectPath],
            fileNames: [] as string[],
            paths: {} as Record<string, string[]>,
            pathsBasePath: undefined as string | undefined
        };
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
            // Kit shadows are written here rather than later because the file list has to name
            // them, and only the transform knows which files actually produced one.
            const fileNames = parsed.fileNames.map((f) => {
                const normalized = normalizePath(f);
                return f.endsWith('.svelte')
                    ? this.getShadowPath(normalized)
                    : (this.writeKitShadow(normalized) ?? normalized);
            });

            this.projectSvelteFiles = parsed.fileNames
                .filter((f) => f.endsWith('.svelte'))
                .map((f) => normalizePath(f));

            return {
                rootDirs,
                fileNames,
                paths: (parsed.options.paths ?? {}) as Record<string, string[]>,
                pathsBasePath:
                    (parsed.options as any).pathsBasePath ?? parsed.options.baseUrl ?? undefined
            };
        } catch (e) {
            Logger.error('[tsgo] could not parse the project tsconfig; using defaults', e);
            return fallback;
        }
    }

    /**
     * `.svelte` files shipped inside dependencies that need a shadow.
     *
     * Most published Svelte libraries emit a `Foo.svelte.d.ts` next to `Foo.svelte`, which
     * TypeScript resolves on its own. A minority (virtua, parts of SvelteKit and Storybook)
     * ship the raw component with differently-named typings, and those fall through to the
     * ambient `declare module '*.svelte'` — the component then types as
     * `SvelteComponent<Record<string, any>, any, any>` and every prop check against it fails.
     * Only files missing that sibling are transformed, which on a large monorepo is ~180 of
     * ~2000 rather than all of them.
     */
    findDependencySvelteFiles(): string[] {
        if (this.dependencySvelteFileScan) {
            return this.dependencySvelteFileScan;
        }
        const found: string[] = [];
        const seen = new Set<string>();

        // Walk only the packages this project actually depends on. Scanning node_modules
        // wholesale takes minutes on a large pnpm monorepo — most of it is transitive
        // dependencies with no Svelte in them at all.
        for (const packageRoot of this.dependencyRoots()) {
            const walk = (dir: string, depth: number) => {
                if (depth > 6) {
                    return;
                }
                let entries: fs.Dirent[];
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch {
                    return;
                }
                for (const entry of entries) {
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
                            walk(full, depth + 1);
                        }
                    } else if (entry.name.endsWith('.svelte') && !fs.existsSync(`${full}.d.ts`)) {
                        const normalized = normalizePath(full);
                        if (!seen.has(normalized)) {
                            seen.add(normalized);
                            found.push(normalized);
                        }
                    }
                }
            };
            walk(packageRoot, 0);
        }
        this.dependencySvelteFileScan = found;
        return found;
    }

    /** Resolved directories of the project's declared dependencies. */
    private dependencyRoots(): string[] {
        let pkg: any;
        try {
            pkg = JSON.parse(fs.readFileSync(join(this.packageRoot, 'package.json'), 'utf8'));
        } catch {
            return [];
        }
        const names = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
            ...Object.keys(pkg.peerDependencies ?? {})
        ];
        const roots: string[] = [];
        for (const name of names) {
            try {
                const manifest = require.resolve(`${name}/package.json`, {
                    paths: [this.packageRoot]
                });
                roots.push(dirname(manifest));
            } catch {
                // Not every dependency exposes its package.json, and that is fine — those
                // either have no Svelte in them or ship their own typings.
            }
        }
        return roots;
    }

    /**
     * The `.svelte` files the user's tsconfig actually pulls in — the set a whole-project check
     * is answerable for. Only meaningful once {@link writeOverlayTsconfig} has run, since that
     * is what resolves the base config.
     */
    getProjectSvelteFileNames(): string[] {
        return this.projectSvelteFiles;
    }

    /** The kit shadow standing in for a generated path, if that path is one. */
    getKitShadowByShadowPath(shadowPath: string): KitShadow | undefined {
        return this.kitShadowsByShadowPath.get(normalizePath(shadowPath));
    }

    /** Whether a real file has been replaced by a kit shadow in this project. */
    hasKitShadow(filePath: string): boolean {
        return this.kitShadows.has(normalizePath(filePath));
    }

    /** Paths of all kit shadows written so far, so pruning doesn't delete them. */
    getKitShadowPaths(): string[] {
        return [...this.kitShadowsByShadowPath.keys()];
    }

    /**
     * Transform a SvelteKit route, hook or params file into its shadow and write it, returning
     * the shadow's path — or undefined when the file needs no transformation.
     *
     * SvelteKit's "zero-effort types" work by the language tooling *rewriting* these files:
     * `export function load({ params })` gets a `satisfies` annotation naming the generated
     * `./$types`, which is what gives `params` a type at all. A project checked without that
     * rewriting reports an implicit-`any` error on every destructured argument of every load
     * function and request handler — errors that do not exist in the user's editor and cannot be
     * fixed in their source.
     */
    private writeKitShadow(filePath: string): string | undefined {
        const kitFiles = this.options.kitFiles;
        if (!kitFiles || !internalHelpers.isKitFile(filePath, kitFiles)) {
            return undefined;
        }

        let text: string;
        try {
            text = fs.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }

        const result = internalHelpers.upsertKitFile(ts, filePath, kitFiles, () =>
            ts.createSourceFile(
                filePath,
                text,
                ts.ScriptTarget.Latest,
                true,
                filePath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
            )
        );
        // A file that matches the naming convention but exports nothing Kit cares about.
        if (!result) {
            return undefined;
        }

        // Same layout as a `.svelte` shadow, minus the added extension — the name has to stay
        // `+page.ts` because `upsertKitFile` keys its behaviour off the basename.
        const shadowPath = normalizePath(
            join(this.mirrorRootFor(filePath), relative(this.rootDirFor(filePath), filePath))
        );
        this.writeShadow(shadowPath, result.text);

        const entry: KitShadow = {
            originalPath: normalizePath(filePath),
            shadowPath,
            addedCode: result.addedCode
        };
        this.kitShadows.set(entry.originalPath, entry);
        this.kitShadowsByShadowPath.set(shadowPath, entry);
        return shadowPath;
    }

    /** Every `.svelte` file under the source root, which all need shadows. */
    findProjectSvelteFiles(): string[] {
        // Memoised: the overlay config needs this list to work out which packages' subpath
        // imports to mirror, and the caller needs it again to write the shadows.
        if (this.projectSvelteFileScan) {
            return this.projectSvelteFileScan;
        }
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
        this.projectSvelteFileScan = found;
        return found;
    }
}

/** Nearest ancestor of `from` (inclusive) holding a package.json, bounded by `stopAt`. */
function findPackageRoot(from: string, stopAt: string): string {
    let current = normalizePath(from);
    const boundary = normalizePath(stopAt);
    for (;;) {
        if (fs.existsSync(join(current, 'package.json'))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current || current === boundary) {
            return normalizePath(from);
        }
        current = parent;
    }
}

/** First string in a possibly-nested package.json conditional-exports value. */
function firstStringTarget(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = firstStringTarget(entry);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    if (value && typeof value === 'object') {
        for (const entry of Object.values(value)) {
            const found = firstStringTarget(entry);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
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
