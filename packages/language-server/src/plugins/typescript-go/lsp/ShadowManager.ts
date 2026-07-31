import { dirname, isAbsolute, join, relative, resolve } from 'path';
import fs from 'fs';
import ts from 'typescript';
import { internalHelpers, InternalHelpers } from 'svelte2tsx';
import { Document } from '../../../lib/documents';
import { Logger } from '../../../logger';
import { normalizePath, pathToUrl } from '../../../utils';
import { DocumentSnapshot, SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { SvelteSnapshotOptions } from '../../typescript/DocumentSnapshot';

/**
 * Directory each package gets for its generated twins, plus — in the package being checked —
 * the overlay tsconfig.
 *
 * `node_modules/.cache` is the conventional home for derived artifacts (babel, eslint and
 * friends all use it): ignored by git and search tools without any `.gitignore` of ours, and
 * swept away by a clean install. The historical "shadows in `node_modules` cannot resolve
 * dependencies" failure was an artifact of the old layout, where one overlay under the *app*
 * held every package's shadows — under pnpm a sibling package's dependencies are not in the
 * app's `node_modules`, so those shadows resolved nothing. The mirror now sits inside the
 * package it mirrors, where the upward walk finds that package's own dependencies first.
 */
const OVERLAY_DIR = 'node_modules/.cache/svelte-lsp';
/** The previous overlay location; removed when found with our fingerprint inside. */
const LEGACY_OVERLAY_DIR = '.svelte-ls-overlay';
const SHADOW_ROOT = 'svelte';
/** Bump when the shadow tree's layout changes, to invalidate every shadow on disk. */
const SHADOW_LAYOUT_VERSION = 3;
/**
 * Mirror subdirectory for the rare file that sits outside the source root entirely. A distinct
 * prefix keeps the shadow→original mapping invertible without probing the filesystem: everything
 * else in a mirror is source-root-relative.
 */
const OUTSIDE_ROOT = '__outside';

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
     * Snapshot options for a specific package, whose Svelte compiler must be that package's own.
     *
     * `importSvelte` falls back to the copy bundled with this language server when the directory
     * it is asked about has no `svelte` — and a monorepo root usually does not, only its packages
     * do. The fallback is Svelte 4, so every component in a Svelte 5 workspace was being parsed
     * by the wrong major: runes are not understood, the generated TSX is wrong, its mappings do
     * not line up, and every diagnostic maps onto nothing and is dropped. Silent, and it presents
     * as "everything is `any`".
     */
    resolveSnapshotOptions?: (packageRoot: string) => SvelteSnapshotOptions | undefined;
    /**
     * When set, SvelteKit route/hook/param files get shadows too, carrying the type annotations
     * that give `load({ params })` and friends their inferred parameter types. Without it those
     * parameters are implicitly `any` and a strict project reports an error on every one.
     *
     * Optional because the shadow has to be *materialised* for this to work, which only the
     * batch path does — an unwritten file named in `files` is TS6053.
     */
    kitFiles?: InternalHelpers.KitFilesSettings;
    /**
     * The svelte2tsx shim `.d.ts` files a given package should be checked against.
     *
     * Per package, not per workspace. The shims are written relative to whichever Svelte they are
     * resolved against, and in a monorepo the editor's root often has no `svelte` at all — only
     * the packages do. Computing them once from the root then yields shims built against nothing,
     * which does not fail loudly: `svelte-html.d.ts` is silently absent, so every intrinsic
     * element mismatches `HTMLProps<...>` and every component's props degrade to `any`.
     */
    resolveShims?: (packageRoot: string) => string[];
    /**
     * When false, this manager writes shadows but never a tsconfig — and actively removes one it
     * finds in its own overlay. For the registry's fallback manager: a file outside every project
     * still needs a shadow so navigation into it maps, but a config generated from no tsconfig
     * describes a program of nothing, and at a workspace root it also *wins* tsgo's ancestor walk
     * for any shadow whose own package has no config — which is how every such file ended up in
     * an empty three-shim project instead of a real one.
     */
    writeConfig?: boolean;
    /**
     * Shared workspace `.svelte` scan. Every manager needs the same list — the walk is over
     * `sourceRoot`, which in a monorepo is the workspace root for all of them — and without
     * sharing, opening files in N packages costs N full recursive scans of the same tree.
     */
    workspaceSvelteFiles?: () => string[];
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
    /** Stamp of the last text written per shadow, so identical rewrites can be skipped. */
    private readonly lastWritten = new Map<string, string>();
    /** False when the transform's output could have changed since the shadows were written. */
    private fingerprintValid = false;

    constructor(private readonly options: ShadowManagerOptions) {
        this.overlayPath = join(options.projectPath, OVERLAY_DIR);
        this.overlayTsconfigPath = join(this.overlayPath, 'tsconfig.json');
        this.packageRoot = findPackageRoot(options.projectPath, options.sourceRoot);
        // The project's own mirror. Named separately because it is the one the overlay tsconfig
        // sits beside, and the one the LSP writes editor-open shadows into.
        this.shadowRoot = normalizePath(join(this.packageRoot, OVERLAY_DIR, SHADOW_ROOT));
        this.mirrorRoots.set(normalizePath(this.packageRoot), this.shadowRoot);
        removeLegacyOverlay(normalizePath(options.projectPath));
        removeLegacyOverlay(normalizePath(this.packageRoot));
    }

    /** Set the per-package shim resolver after construction (it needs the manager's paths). */
    setShimResolver(resolve: (packageRoot: string) => string[]) {
        (this.options as ShadowManagerOptions).resolveShims = resolve;
    }

    /** See {@link ShadowManagerOptions.resolveSnapshotOptions}. */
    setSnapshotOptionsResolver(
        resolve: (packageRoot: string) => SvelteSnapshotOptions | undefined
    ) {
        (this.options as ShadowManagerOptions).resolveSnapshotOptions = resolve;
    }

    /** Outermost directory whose components this manager shadows. */
    get sourceRoot(): string {
        return normalizePath(this.options.sourceRoot);
    }

    /**
     * A file's position inside a mirror: its path relative to the source root.
     *
     * Deliberately a pure function of the file and the source root, and nothing about *this*
     * manager. Shadow paths used to be derived from the writing manager's tsconfig `rootDirs`,
     * which meant two managers computed two different twins for the same component, listed each
     * other's non-existent paths in their configs, and deleted each other's trees when pruning —
     * the whole reason a monorepo opened at its root fell apart. Source-root-relative paths are
     * also globally unique, so a failed relative import can never rootDirs-bridge into a
     * *different* package that happens to share the same internal layout.
     */
    private mirrorRelFor(filePath: string): string {
        const normalized = normalizePath(filePath);
        const rel = relative(this.sourceRoot, normalized);
        if (!rel.startsWith('..') && !isAbsolute(rel)) {
            return rel;
        }
        // Outside the source root entirely (a globally linked dependency, a stray open file).
        // Nest the *absolute* path under a marker directory: invertible without guessing, and
        // — combined with mirrorRootFor sending these to the manager's own mirror — nothing is
        // ever written into a repository the user did not open.
        const encoded = normalized.startsWith('/')
            ? normalized.slice(1)
            : normalized.replace(':', '');
        return join(OUTSIDE_ROOT, encoded);
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
     * aliasing at all: the walk up from `<pkg>/node_modules/.cache/svelte-lsp/svelte/...` reaches `<pkg>`
     * before anything else. The alternative — declaring these in the overlay's `paths` — cannot
     * work, because `paths` is one flat table for the whole project while `imports` is
     * per-package, so a global `#*` on one package's behalf retargets every other package's.
     */
    private mirrorRootFor(filePath: string): string {
        const normalized = normalizePath(filePath);
        const rel = relative(this.sourceRoot, normalized);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            // A file outside the workspace must not get a mirror in its own (foreign) package —
            // that would write into a repository the user never opened. It shadows into this
            // manager's own mirror under the __outside marker instead.
            return this.shadowRoot;
        }
        return this.mirrorRootIn(this.packageRootOf(filePath));
    }

    /** The mirror belonging to a package root, registering it the first time it is asked for. */
    private mirrorRootIn(packageRoot: string): string {
        packageRoot = normalizePath(packageRoot);
        let mirror = this.mirrorRoots.get(packageRoot);
        if (!mirror) {
            mirror = normalizePath(join(packageRoot, OVERLAY_DIR, SHADOW_ROOT));
            this.mirrorRoots.set(packageRoot, mirror);
            removeLegacyOverlay(packageRoot);
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
     * the mirror is the file's source-root-relative path (see {@link mirrorRelFor}), bridged back
     * to the real tree by the `sourceRoot` ↔ mirror pairing in the overlay's `rootDirs`.
     */
    getShadowPath(svelteFilePath: string): string {
        const shadowPath = normalizePath(
            join(this.mirrorRootFor(svelteFilePath), `${this.mirrorRelFor(svelteFilePath)}.tsx`)
        );
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
        // the client. The layout is invertible: rebase the mirror-relative path onto the source
        // root (or, for the __outside marker, onto the mirror's own package).
        for (const mirror of this.mirrorRoots.values()) {
            if (!normalized.startsWith(mirror + '/')) {
                continue;
            }
            const rel = normalized.slice(mirror.length + 1, -'.tsx'.length);
            const guess = this.originalForMirrorRel(mirror, rel);
            if (guess && (this.snapshots.has(guess) || fs.existsSync(guess))) {
                return guess;
            }
        }
        return undefined;
    }

    /** Invert {@link mirrorRelFor}: the original path a mirror-relative entry stands for. */
    private originalForMirrorRel(_mirror: string, rel: string): string | undefined {
        if (rel.startsWith(`${OUTSIDE_ROOT}/`)) {
            // The marker carries the absolute path (drive-letter form on Windows).
            const encoded = rel.slice(OUTSIDE_ROOT.length + 1);
            return normalizePath(
                process.platform === 'win32' ? `${encoded[0]}:${encoded.slice(1)}` : `/${encoded}`
            );
        }
        return normalizePath(join(this.sourceRoot, rel));
    }

    getSnapshot(svelteFilePath: string): SvelteDocumentSnapshot | undefined {
        return this.snapshots.get(normalizePath(svelteFilePath))?.snapshot;
    }

    /**
     * The snapshot for a file, transforming it from disk if it is not cached.
     *
     * Startup only writes shadows whose source is newer, so most files never get transformed at
     * all — which means a mapping lookup for one of them (go-to-definition landing in a component
     * nobody has opened) would otherwise find nothing and silently drop the result. Transforming
     * on demand costs well under a millisecond and only happens for files actually navigated to.
     */
    ensureSnapshot(svelteFilePath: string): SvelteDocumentSnapshot | undefined {
        const cached = this.getSnapshot(svelteFilePath);
        if (cached) {
            return cached;
        }
        try {
            const text = fs.readFileSync(svelteFilePath, 'utf8');
            return this.transform(new Document(pathToUrl(svelteFilePath), text, true));
        } catch (e) {
            Logger.debug(`[tsgo] could not transform ${svelteFilePath} on demand`, e);
            return undefined;
        }
    }

    /**
     * Whether the shadow on disk already reflects its source, so startup can skip it.
     *
     * Guarded by a fingerprint of everything that changes generated output — the Svelte and
     * svelte2tsx versions, and the layout version below. Without it, upgrading either would leave
     * a tree of stale shadows that look fresh by timestamp and produce types for code that is no
     * longer what the transform emits.
     */
    isShadowFresh(sourcePath: string, shadowPath: string): boolean {
        if (!this.fingerprintValid) {
            return false;
        }
        try {
            const shadow = fs.statSync(shadowPath, { throwIfNoEntry: false });
            if (!shadow) {
                return false;
            }
            const source = fs.statSync(sourcePath, { throwIfNoEntry: false });
            return !!source && shadow.mtimeMs >= source.mtimeMs;
        } catch {
            return false;
        }
    }

    /**
     * Compare the current transform fingerprint against the one the shadows were written with,
     * and record the new one. Everything is stale when it differs.
     *
     * Stored once per *source root*, not per project overlay: the shadow tree is canonical and
     * shared, so a per-project fingerprint would make the first manager for each additional
     * package find nothing, distrust every shadow, and re-transform the entire workspace.
     */
    private checkFingerprint(): boolean {
        const fingerprint = JSON.stringify({
            layout: SHADOW_LAYOUT_VERSION,
            svelte: this.options.snapshotOptions.version ?? 'unknown',
            options: {
                typingsNamespace: this.options.snapshotOptions.typingsNamespace,
                transformOnTemplateError: this.options.snapshotOptions.transformOnTemplateError,
                emitJsDoc: this.options.snapshotOptions.emitJsDoc
            }
        });
        const target = join(this.sourceRoot, OVERLAY_DIR, '.fingerprint');
        let matched = false;
        try {
            matched = fs.readFileSync(target, 'utf8') === fingerprint;
        } catch {
            matched = false;
        }
        if (!matched) {
            try {
                fs.mkdirSync(dirname(target), { recursive: true });
                fs.writeFileSync(target, fingerprint);
            } catch {
                // If it cannot be recorded, treat every shadow as stale rather than trusting one.
                return false;
            }
        }
        return matched;
    }

    /**
     * Snapshot for a *generated* path. Convenience for callers working in shadow space, e.g.
     * translating an LSP position on a shadow into a checker offset.
     */
    getSnapshotByShadowPath(shadowPath: string): SvelteDocumentSnapshot | undefined {
        const original = this.getOriginalPath(shadowPath);
        return original ? this.ensureSnapshot(original) : undefined;
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
        const options =
            this.options.resolveSnapshotOptions?.(this.packageRootOf(filePath)) ??
            this.options.snapshotOptions;
        const key = normalizePath(filePath);
        const text = document.getText();
        const previous = this.snapshots.get(key);
        if (previous && previous.sourceText === text) {
            return previous.snapshot;
        }

        const snapshot = DocumentSnapshot.fromDocument(document, options) as SvelteDocumentSnapshot;
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
    writeShadow(shadowPath: string, text: string): boolean {
        const key = normalizePath(shadowPath);
        // One keystroke fans out into half a dozen feature requests, and each of them syncs the
        // shadow — without this, that is half a dozen synchronous whole-file writes of identical
        // bytes per keystroke, each an mtime bump on a file tsgo is watching. The existsSync
        // keeps the stamp honest: the tree lives under node_modules/.cache, which a clean
        // install sweeps away mid-session, and a stamp for a file that is gone must not stop
        // it from being recreated.
        if (this.lastWritten.get(key) === contentStamp(text) && fs.existsSync(shadowPath)) {
            return false;
        }
        this.ensureShadowDirectory(shadowPath);
        try {
            fs.writeFileSync(shadowPath, text);
            this.lastWritten.set(key, contentStamp(text));
            return true;
        } catch (e) {
            Logger.error(`[tsgo] could not write shadow ${shadowPath}`, e);
            return false;
        }
    }

    /** Delete a single shadow, e.g. when its `.svelte` source was removed. */
    removeShadow(shadowPath: string) {
        this.lastWritten.delete(normalizePath(shadowPath));
        try {
            fs.unlinkSync(shadowPath);
        } catch {
            // Already gone, which is the desired state anyway.
        }
    }

    /**
     * Remove shadows whose `.svelte` source no longer exists, so stale roots don't error.
     *
     * A shadow outside the live set is only deleted when its reconstructed original is gone
     * too. Several managers share a package's mirror — the app's manager materialises a library
     * component's shadow and the library's own manager does the same — and each one's live set
     * covers only what *it* wrote. Deleting on set-membership alone made every manager destroy
     * the others' trees. Files from the pre-canonical layout reconstruct to originals that do
     * not exist, so this also sweeps them out.
     */
    pruneOrphanedShadows(liveShadowPaths: Set<string>) {
        const walk = (mirror: string, dir: string) => {
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
                    walk(mirror, full);
                    continue;
                }
                const normalized = normalizePath(full);
                if (liveShadowPaths.has(normalized)) {
                    continue;
                }
                const rel = normalized.slice(mirror.length + 1);
                const original = this.originalForMirrorRel(
                    mirror,
                    rel.endsWith('.tsx') ? rel.slice(0, -'.tsx'.length) : rel
                );
                if (original && fs.existsSync(original)) {
                    continue;
                }
                this.lastWritten.delete(normalized);
                try {
                    fs.unlinkSync(full);
                } catch {
                    // best effort
                }
            }
        };
        for (const mirror of this.mirrorRoots.values()) {
            walk(mirror, mirror);
        }
    }

    /**
     * Create the parent directory of a shadow. tsgo resolves a never-on-disk `.tsx` only when
     * its containing directory physically exists — same-directory and rootDirs-bridged
     * resolution both fail with TS2307 when it doesn't.
     *
     * Deliberately not memoised: a recursive mkdir on an existing directory is one cheap
     * syscall, and the tree sits under node_modules/.cache where an install can sweep it away
     * behind our back — a "this exists" cache would then block every recovery write.
     */
    ensureShadowDirectory(shadowPath: string) {
        const dir = dirname(shadowPath);
        try {
            fs.mkdirSync(dir, { recursive: true });
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
    writeOverlayTsconfig(fallbackShims: string[] = []) {
        fs.mkdirSync(this.overlayPath, { recursive: true });
        this.fingerprintValid = this.checkFingerprint();
        // Discovering the mirrors has to happen before the config is written, since every one of
        // them is a rootDirs entry.
        for (const packagePath of this.svelteOwningPackages()) {
            this.ensureMirror(this.mirrorRootIn(packagePath));
        }
        this.ensureMirror(this.shadowRoot);

        if (this.options.writeConfig === false) {
            // This manager writes shadows only — and deletes nothing. A *real* project can
            // share this directory (an app whose tsconfig sits at the workspace root gets a
            // fallback sibling the moment a dependency component is opened), and its overlay
            // tsconfig must survive.
            return;
        }

        const shimFiles = this.shimsFor(this.packageRoot, fallbackShims);
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
                rootDirs: this.overlayRootDirs(base)
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
        this.writeExtendsShims();

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
     * The overlay's `rootDirs`: the base config's own entries, a mirror twin for each of them,
     * the source root, and every mirror.
     *
     * `rootDirs` must be *merged* with the base's, not replaced. SvelteKit's generated config
     * declares its own (`["..", "./types"]`) and dropping those breaks `$app/types` and every
     * route's `./$types` import.
     *
     * Shadows are laid out source-root-relative inside each mirror, which the `sourceRoot` ↔
     * mirror pairing bridges. But TypeScript rebases a failed relative import against the
     * *longest* rootDir containing the importing file, so every base entry needs a twin inside
     * the mirror — `<mirror of B's package>/<B's path from the source root>` — or the base
     * entries' own suffix space is unreachable from a shadow. A route shadow at
     * `<mirror>/apps/app/src/routes/+page.svelte.tsx` sits in the twin of SvelteKit's `".."`
     * with suffix `src/routes/…`, which is exactly what its `./$types` import needs to land in
     * `.svelte-kit/types`. Without the twin the failed import would rebase against the whole
     * mirror instead and never pair with the base entries at all. Base entries come first: a
     * route's `./$types` has to reach `.svelte-kit/types` before anything else is tried.
     */
    private overlayRootDirs(base: { rootDirs: string[] }): string[] {
        const baseDirs = base.rootDirs.map((d) => normalizePath(d));
        const dirs = new Set<string>(baseDirs);
        for (const dir of baseDirs) {
            const rel = relative(this.sourceRoot, dir);
            if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
                continue;
            }
            const mirror = this.mirrorRootIn(findPackageRoot(dir, this.sourceRoot));
            dirs.add(normalizePath(join(mirror, rel)));
        }
        dirs.add(this.sourceRoot);
        for (const mirror of this.mirrorRoots.values()) {
            dirs.add(mirror);
        }
        return [...dirs];
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
     * { "extends": ["./.svelte-kit/tsconfig.json", "./node_modules/.cache/svelte-lsp/tsconfig.ts-support.json"] }
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
                rootDirs: this.overlayRootDirs(base),
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

    private shimsFor(packageRoot: string, fallback: string[]): string[] {
        const resolved = this.options.resolveShims?.(packageRoot);
        return resolved?.length ? resolved : fallback;
    }

    /**
     * Give a mirror whose package has *no tsconfig of its own* a config tsgo can still find.
     *
     * tsgo discovers a file's project by walking up from the opened shadow's path, and that walk
     * only passes through the shadow's own package — an overlay tsconfig sitting at a project
     * root higher up is a sibling of the walk, never on it. A package with its own tsconfig gets
     * a full overlay from its own manager the moment one of its files is opened; a package
     * without one belongs to an enclosing project, so it gets a pure-`extends` pointer at that
     * project's overlay. `files`, `rootDirs` and `paths` in the overlay are all absolute, so the
     * pointer inherits them unchanged and tsgo's containment check passes.
     *
     * Notably this replaces the old behaviour of every manager rewriting every *other* package's
     * overlay with a full config computed in its own layout — the mechanism by which two open
     * packages used to corrupt each other's projects.
     */
    private writeExtendsShims() {
        const ownTsconfig = this.options.tsconfigPath
            ? normalizePath(this.options.tsconfigPath)
            : undefined;
        if (!ownTsconfig) {
            return;
        }
        for (const packageRoot of this.svelteOwningPackages()) {
            if (
                packageRoot === normalizePath(this.packageRoot) ||
                packageRoot.includes('/node_modules/')
            ) {
                continue;
            }
            // Only packages this project is actually the nearest project *for*. A package with
            // its own tsconfig is its own project; one whose nearest config belongs to a
            // different (closer) project is that project's to describe.
            const nearest = findProjectTsconfig(packageRoot);
            if (!nearest || normalizePath(nearest) !== ownTsconfig) {
                continue;
            }

            try {
                const overlayDir = join(packageRoot, OVERLAY_DIR);
                const target = join(overlayDir, 'tsconfig.json');
                const contents = JSON.stringify({ extends: this.overlayTsconfigPath }, null, 4);
                fs.mkdirSync(overlayDir, { recursive: true });
                if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) {
                    fs.writeFileSync(target, contents);
                }
            } catch (e) {
                Logger.debug(`[tsgo] could not write an extends shim for ${packageRoot}`, e);
            }
        }
    }

    /**
     * Create a mirror directory.
     *
     * Deliberately nothing else: no package.json, no links. The mirror sits inside the package
     * it mirrors — under `node_modules/.cache`, which git and search tools already ignore — so
     * the upward walk for `node_modules` and for the nearest package.json passes straight
     * through it and lands on the real ones.
     */
    private ensureMirror(mirrorRoot: string) {
        try {
            fs.mkdirSync(mirrorRoot, { recursive: true });
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
            // Containment, not a length comparison: a path in an unrelated tree that merely
            // *is as long as* the source root must not mint a package here — that is how a
            // mirror once ended up inside a different repository.
            while ((dir === sourceRoot || dir.startsWith(sourceRoot + '/')) && !seenDirs.has(dir)) {
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
        const rel = relative(this.sourceRoot, normalized);
        if (rel.startsWith('..') || isAbsolute(rel)) {
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
        const tsconfigPath = this.options.tsconfigPath;
        const fallback = {
            rootDirs: [this.options.projectPath],
            fileNames: [] as string[],
            paths: {} as Record<string, string[]>,
            pathsBasePath: undefined as string | undefined
        };
        if (!tsconfigPath) {
            return fallback;
        }
        try {
            const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
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
                dirname(tsconfigPath)
            );

            const rootDirs = parsed.options.rootDirs?.length
                ? parsed.options.rootDirs.map((d) => normalizePath(d))
                : [this.options.projectPath];

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
            join(this.mirrorRootFor(filePath), this.mirrorRelFor(filePath))
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
        // Prefer the registry-shared scan: the walk is over the workspace root, which is the
        // same directory for every manager, and re-walking it once per opened package is the
        // bulk of a first request's latency in a monorepo.
        if (this.options.workspaceSvelteFiles) {
            return this.options.workspaceSvelteFiles();
        }
        // Memoised: the overlay config needs this list to work out which packages' subpath
        // imports to mirror, and the caller needs it again to write the shadows.
        if (this.projectSvelteFileScan) {
            return this.projectSvelteFileScan;
        }
        this.projectSvelteFileScan = scanWorkspaceSvelteFiles(this.options.sourceRoot);
        return this.projectSvelteFileScan;
    }
}

/** Every `.svelte` file under a source root. One full recursive walk — share the result. */
export function scanWorkspaceSvelteFiles(sourceRoot: string): string[] {
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
    walk(sourceRoot, 0);
    return found;
}

/**
 * Delete a package's overlay from the era when it lived at `<pkg>/.svelte-ls-overlay`.
 *
 * Guarded on the markers only this code ever created — the fingerprint file, or a `svelte`
 * mirror *directory* together with the generated tsconfig — so an unrelated directory that
 * happens to share the name survives.
 */
function removeLegacyOverlay(packageRoot: string) {
    const legacy = join(packageRoot, LEGACY_OVERLAY_DIR);
    try {
        const looksLikeOurs =
            fs.existsSync(join(legacy, '.fingerprint')) ||
            (fs.statSync(join(legacy, SHADOW_ROOT), { throwIfNoEntry: false })?.isDirectory() ===
                true &&
                fs.existsSync(join(legacy, 'tsconfig.json')));
        if (!looksLikeOurs) {
            return;
        }
        fs.rmSync(legacy, { recursive: true, force: true });
        Logger.log(`[tsgo] removed legacy overlay ${legacy}`);
    } catch (e) {
        Logger.debug(`[tsgo] could not remove legacy overlay ${legacy}`, e);
    }
}

/**
 * Cheap identity for a shadow's text: length plus an FNV-1a hash. Retaining the text itself
 * would keep the whole generated tree in memory just to skip rewrites.
 */
function contentStamp(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${hash >>> 0}`;
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
