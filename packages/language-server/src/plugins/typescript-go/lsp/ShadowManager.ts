import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import fs from 'fs';
import { builtinModules } from 'module';
import { createHash } from 'crypto';
import ts from 'typescript';
import { internalHelpers, InternalHelpers } from 'svelte2tsx';
import { Document } from '../../../lib/documents';
import { configLoader, SvelteConfig } from '../../../lib/documents/configLoader';
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
const SHADOW_LAYOUT_VERSION = 4;
/**
 * A `.svelte` specifier and its collision-free batch spelling have exactly the same length.
 * Keeping that invariant means a copied TS/JS file and a generated TSX file retain every source
 * offset after their module specifiers are rewritten.
 */
const SVELTE_SPECIFIER_LENGTH = '.svelte'.length;
const SCRIPT_SOURCE_RE = /\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/;
const JSON_MODULE_RE = /\.json$/i;
/**
 * Mirror subdirectory for the rare file that sits outside the source root entirely. A distinct
 * prefix keeps the shadow→original mapping invertible without probing the filesystem: everything
 * else in a mirror is source-root-relative.
 */
const OUTSIDE_ROOT = '__outside';
/** Non-open mapping snapshots retained per manager for navigation. */
const MAX_NAVIGATION_SNAPSHOTS = 64;
const NODE_BUILTIN_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

/**
 * Workspace-wide indexes shared by every project manager in this process. Project managers are
 * intentionally lazy, but package manifests and dependency source trees do not change depending
 * on which tsconfig first asked for them.
 */
const sharedPackageRootsByDir = new Map<string, string>();
const sharedPackageManifests = new Map<string, any | null>();
const sharedDependencyRoots = new Map<string, string[]>();
const sharedReachableDependencyRoots = new Map<
    string,
    {
        roots: string[];
        fallbackReasons: string[];
        sourceInputs: BatchGraphSourceInput[];
        manifestInputs: string[];
        layoutInputs: string[];
        directoryRoots: string[];
    }
>();
const sharedDependencySvelteFiles = new Map<string, string[]>();
const sharedSvelteFilesByPackage = new Map<string, string[]>();
const sharedDependencyScanMode = new Map<string, 'broad' | 'direct' | 'exports'>();
/** Real package roots as TypeScript sees them -> import-visible roots under node_modules. */
const sharedLexicalPackageRootsByReal = new Map<string, string>();
const sharedCanonicalSourcePaths = new Map<string, string>();
/**
 * `realpath(2)` is surprisingly expensive on pnpm trees because every lookup walks a long
 * symlink chain. A dependency graph generation asks for the same package/source roots thousands
 * of times, so memoize successful resolutions until the workspace index is structurally
 * invalidated. Missing paths are deliberately not cached: a file created later in the same
 * process must become visible without relying on a watcher round-trip.
 */
const sharedRealPaths = new Map<string, string>();
/** Above this, a full package scan is cheaper and safer than truncating public reachability. */
const MAX_PUBLIC_EXPORT_ENTRIES = 1_000;
/** Conditional branches can multiply independently of subpath count; bound them separately. */
const MAX_PUBLIC_EXPORT_TARGETS = 4_000;

/** Clear graph/index state after a package/config/dependency structure change. */
export function invalidateTsGoWorkspaceIndex() {
    sharedPackageRootsByDir.clear();
    sharedPackageManifests.clear();
    sharedDependencyRoots.clear();
    sharedReachableDependencyRoots.clear();
    sharedDependencySvelteFiles.clear();
    sharedSvelteFilesByPackage.clear();
    sharedDependencyScanMode.clear();
    sharedLexicalPackageRootsByReal.clear();
    sharedCanonicalSourcePaths.clear();
    sharedRealPaths.clear();
}

function realPathOrSelf(filePath: string): string {
    const normalized = normalizePath(filePath);
    const cached = sharedRealPaths.get(normalized);
    if (cached) {
        return cached;
    }
    try {
        const real = normalizePath(fs.realpathSync.native(normalized));
        sharedRealPaths.set(normalized, real);
        return real;
    } catch {
        return normalized;
    }
}

function registerPackageRootAlias(packageRoot: string): string {
    const lexicalRoot = normalizePath(packageRoot);
    const realRoot = realPathOrSelf(lexicalRoot);
    if (realRoot !== lexicalRoot) {
        const previous = sharedLexicalPackageRootsByReal.get(realRoot);
        // Prefer the shortest import-visible spelling. In pnpm this is `node_modules/pkg`, not
        // `node_modules/.pnpm/pkg@version/node_modules/pkg`.
        if (!previous || lexicalRoot.length < previous.length) {
            sharedLexicalPackageRootsByReal.set(realRoot, lexicalRoot);
            sharedCanonicalSourcePaths.clear();
        }
    }
    return lexicalRoot;
}

/**
 * Collapse a realpath, a workspace symlink and its import-visible node_modules spelling onto one
 * source identity. Workspace-linked packages prefer their authored path; external/pnpm packages
 * prefer the shortest registered node_modules spelling.
 */
function canonicalSourcePath(filePath: string, sourceRoot: string): string {
    const normalized = normalizePath(filePath);
    const normalizedRoot = normalizePath(sourceRoot);
    const cacheKey = `${normalizedRoot}\0${normalized}`;
    const cached = sharedCanonicalSourcePaths.get(cacheKey);
    if (cached) {
        return cached;
    }

    const realFile = realPathOrSelf(normalized);
    const realSourceRoot = realPathOrSelf(normalizedRoot);
    const sourceRelative = relative(realSourceRoot, realFile);
    let result: string | undefined;
    if (!sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) {
        const posixRelative = normalizePath(sourceRelative);
        // A workspace package reached through node_modules realpaths back into its authored
        // packages/ directory. A pnpm store path does not: preserve its import-visible alias.
        if (
            posixRelative !== 'node_modules/.pnpm' &&
            !posixRelative.startsWith('node_modules/.pnpm/') &&
            !posixRelative.includes('/node_modules/.pnpm/')
        ) {
            result = normalizePath(join(normalizedRoot, sourceRelative));
        }
    }

    if (!result) {
        let longestRealRoot = '';
        for (const realRoot of sharedLexicalPackageRootsByReal.keys()) {
            if (
                (realFile === realRoot || realFile.startsWith(realRoot + '/')) &&
                realRoot.length > longestRealRoot.length
            ) {
                longestRealRoot = realRoot;
            }
        }
        if (longestRealRoot) {
            result = normalizePath(
                join(
                    sharedLexicalPackageRootsByReal.get(longestRealRoot)!,
                    relative(longestRealRoot, realFile)
                )
            );
        }
    }

    result ??= normalized;
    sharedCanonicalSourcePaths.set(cacheKey, result);
    return result;
}

const SVELTE2TSX_VERSION = packageVersionFor('svelte2tsx');

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
     * When false, this manager writes shadows but never a tsconfig. This is reserved for the
     * registry's mapping-only fallback: a dependency/foreign file still needs a shadow so
     * navigation into it maps, but it must not overwrite a real project at the same root.
     * Config-less workspace sources use `writeConfig: true`; their inferred overlay supplies the
     * Svelte shims/rootDirs which tsgo's built-in inferred project lacks.
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

export interface BatchGraphParsedBaseConfig {
    rootDirs: string[];
    rawFileNames: string[];
    paths: Record<string, string[]>;
    pathsBasePath: string | undefined;
}

export interface BatchGraphDiagnosticMessageChain {
    messageText: string;
    category: ts.DiagnosticCategory;
    code: number;
    next?: BatchGraphDiagnosticMessageChain[];
}

export interface BatchGraphDiagnostic {
    category: ts.DiagnosticCategory;
    code: number;
    messageText: string | BatchGraphDiagnosticMessageChain;
    fileName?: string;
    start?: number;
    length?: number;
    source?: string;
    reportsDeprecated?: boolean;
    reportsUnnecessary?: boolean;
    relatedInformation?: BatchGraphDiagnostic[];
}

export interface BatchGraphReachablePackageImport {
    specifier: string;
    packageName: string;
    containingFile: string;
    resolvedFile?: string;
}

export interface BatchGraphDependencyScope {
    mode: 'reachable' | 'declared-fallback';
    roots: string[];
    directImports: number;
    fallbackReasons: string[];
}

export interface BatchGraphSourceInput {
    path: string;
    /** Import/re-export/glob semantics only; ordinary type/body edits do not invalidate the graph. */
    signature: string;
}

/**
 * JSON-safe source/dependency graph boundary shared with the batch checker cache.
 *
 * The plan intentionally excludes collision allocations and output ownership: those depend on
 * the materialised component set and are cheap to derive again. The caller owns freshness
 * validation for every `validationInputs` path before restore; a structurally invalid,
 * cross-project or tampered plan is rejected atomically.
 */
export interface BatchGraphPlan {
    version: 1;
    signature: string;
    project: {
        projectPath: string;
        sourceRoot: string;
        tsconfigPath: string | null;
    };
    parsedBaseConfig: BatchGraphParsedBaseConfig;
    baseConfigDiagnostics: BatchGraphDiagnostic[];
    batchCompilerOptions: ts.CompilerOptions;
    batchConfigDirectory: string;
    projectSvelteFiles: string[];
    projectSvelteFileScan: string[] | null;
    batchReachableSourceFiles: string[];
    batchReachableBareImports: Array<[specifier: string, target: string]>;
    batchReachablePackageImports: BatchGraphReachablePackageImport[];
    batchRootSourceFiles: string[];
    batchForwardSourceEdges: Array<[source: string, targets: string[]]>;
    batchReverseSourceEdges: Array<[target: string, importers: string[]]>;
    batchPackagePrivateSourceEdges: Array<[importer: string, targets: string[]]>;
    projectReachabilityFallbackReasons: string[];
    dependencySvelteFileScan: string[] | null;
    dependencyScope: BatchGraphDependencyScope | null;
    /** Sources read while constructing the graph, with their semantic graph signature. */
    sourceInputs: BatchGraphSourceInput[];
    /** Root and extended tsconfig/jsconfig files read by TypeScript's config parser. */
    configInputs: string[];
    /** Existing or absent package manifests consulted during module/dependency resolution. */
    manifestInputs: string[];
    /** Resolution targets whose existence/symlink identity affects the graph. */
    layoutInputs: string[];
    /** Directory trees/glob roots whose create/delete membership affects the graph. */
    directoryRoots: string[];
}

type ParsedBaseConfig = BatchGraphParsedBaseConfig;

interface ReachabilitySourceAnalysis {
    /** Filesystem identity used to avoid rereading an unchanged source in this generation. */
    statKey: string;
    /** Content identity keeps preprocessing safe if metadata changed but bytes did not. */
    contentKey: string;
    /** Stable across body/type-only edits, but changes for every graph/fallback-relevant edit. */
    graphKey: string;
    text: string;
    preprocessed: ts.PreProcessedFileInfo;
    literalGlobPatterns: string[][];
    computedGlobCount: number;
}

/**
 * One module/source-analysis cache per materialisation generation.
 *
 * TypeScript's own cache handles package/exports lookups. The adjacent maps avoid rereading and
 * reparsing the same source while reachability, collision rewriting and JSON discovery inspect
 * the graph in succession. A structural invalidation discards the entire object.
 */
interface ReachabilityCache {
    optionsKey: string;
    configDirectory: string;
    moduleResolution: ts.ModuleResolutionCache;
    typeReferenceResolution: ts.TypeReferenceDirectiveResolutionCache;
    moduleResolutionHost: ts.ModuleResolutionHost;
    sources: Map<string, ReachabilitySourceAnalysis>;
    sourceSignatures: Map<string, string>;
    resolutions: Map<string, string | null>;
    packageRoots: Map<string, string | null>;
    manifestInputs: Set<string>;
    layoutInputs: Set<string>;
    directoryRoots: Set<string>;
}

interface ReachableBarePackageImport {
    specifier: string;
    packageName: string;
    containingFile: string;
    resolvedFile: string | undefined;
}

interface DependencyScope {
    mode: 'reachable' | 'declared-fallback';
    roots: string[];
    directImports: number;
    fallbackReasons: string[];
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
        { sourceText: string; transformIdentity: string; snapshot: SvelteDocumentSnapshot }
    >();
    /** Client-open documents are pinned; every other snapshot participates in the LRU. */
    private readonly pinnedSnapshots = new Set<string>();
    /**
     * The `.svelte` files the user's own tsconfig resolves to, as opposed to every `.svelte`
     * file that needs a shadow. The two differ by a lot: shadows are written for the whole
     * workspace and for dependencies, because anything the program can import has to resolve,
     * while only this set is the project's own responsibility to report on.
     */
    private projectSvelteFiles: string[] = [];
    private projectConfigParsed = false;
    /** Raw config/reachability result; output file names are remapped after mirrors are known. */
    private parsedBaseConfig: ParsedBaseConfig | undefined;
    private baseConfigDiagnostics: ts.Diagnostic[] = [];
    private projectSvelteFileScan: string[] | undefined;
    private dependencySvelteFileScan: string[] | undefined;
    private dependencyScope: DependencyScope | undefined;
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
    /** Batch-only mirrors of ordinary TS/JS sources and their resolved JSON modules. */
    private readonly batchSourceMirrorByOriginal = new Map<string, string>();
    private readonly batchSourceOriginalByMirror = new Map<string, string>();
    private readonly batchMirrorKindByOriginal = new Map<string, 'script' | 'json'>();
    /** Exact non-relative imports whose package/alias entry must start in the mirror. */
    private readonly batchBareImportTargets = new Map<string, string>();
    /** Set only for the batch checker when a legal `Foo.svelte.ts` would collide with Foo.svelte. */
    private readonly batchSvelteSpecifierSuffixes = new Map<string, string>();
    private batchRewriteSignature: string | undefined;
    private batchReachableSourceFiles: string[] = [];
    private batchReachableBareImports = new Map<string, string>();
    private batchReachablePackageImports: ReachableBarePackageImport[] = [];
    private batchRootSourceFiles = new Set<string>();
    private batchForwardSourceEdges = new Map<string, Set<string>>();
    private batchReverseSourceEdges = new Map<string, Set<string>>();
    private batchPackagePrivateSourceEdges = new Map<string, Set<string>>();
    private batchCompilerOptions: ts.CompilerOptions = {};
    private batchConfigDirectory: string;
    private batchConfigInputs = new Set<string>();
    private batchRestoredSourceInputs = new Map<string, string>();
    private reachabilityCache: ReachabilityCache | undefined;
    private projectReachabilityFallbackReasons: string[] = [];
    private batchCollisionFallbackReasons: string[] = [];
    private batchReverseClosureSize = 0;
    private readonly batchMaterializedSvelteFiles = new Set<string>();
    private readonly batchPrivateSvelteImports = new Map<string, string>();
    private readonly batchPublicSvelteImports = new Map<string, string>();
    private registerReverseIndex?: (shadowPath: string, originalPath: string) => void;
    /** Stamp of the last text written per shadow, so identical rewrites can be skipped. */
    private readonly lastWritten = new Map<string, string>();
    /** Whether each package's on-disk shadows match its current compiler/config transform. */
    private readonly fingerprintValidByPackage = new Map<string, boolean>();
    /** Fingerprints become authoritative only after every required shadow was materialised. */
    private readonly pendingFingerprints = new Map<string, { target: string; contents: string }>();

    constructor(private readonly options: ShadowManagerOptions) {
        this.overlayPath = join(options.projectPath, OVERLAY_DIR);
        this.overlayTsconfigPath = join(this.overlayPath, 'tsconfig.json');
        this.packageRoot = findPackageRoot(options.projectPath, options.sourceRoot);
        this.batchConfigDirectory = options.projectPath;
        // The project's own mirror. Named separately because it is the one the overlay tsconfig
        // sits beside, and the one the LSP writes editor-open shadows into.
        // The project's own shadow must live below the project config, not merely below the
        // nearest package.json. A nearer/nested tsconfig otherwise has no ancestor relationship
        // to the URI tsgo opens and can never be selected by tsgo's upward project walk.
        this.shadowRoot = normalizePath(join(options.projectPath, OVERLAY_DIR, SHADOW_ROOT));
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

    /** Register generated↔source paths in the workspace-wide O(1) reverse index. */
    setReverseIndexRegistrar(register: (shadowPath: string, originalPath: string) => void) {
        this.registerReverseIndex = register;
        for (const [shadowPath, originalPath] of this.originalByShadowPath) {
            register(shadowPath, originalPath);
        }
        for (const [shadowPath, originalPath] of this.batchSourceOriginalByMirror) {
            register(shadowPath, originalPath);
        }
        for (const entry of this.kitShadowsByShadowPath.values()) {
            register(entry.shadowPath, entry.originalPath);
        }
    }

    /** Outermost directory whose components this manager shadows. */
    get sourceRoot(): string {
        return normalizePath(this.options.sourceRoot);
    }

    /** Exact reasons the configured source graph required the broad correctness fallback. */
    get reachabilityFallbackReasons(): readonly string[] {
        return this.projectReachabilityFallbackReasons;
    }

    /** Dependency-scope proof and counts for checker/editor telemetry. */
    getDependencyScopeStats(): {
        mode: 'reachable' | 'declared-fallback';
        directImports: number;
        dependencyRoots: number;
        svelteFiles: number;
        fallbackReasons: readonly string[];
    } {
        if (this.options.tsconfigPath && !this.projectConfigParsed) {
            this.parseBaseConfig();
        }
        const roots = this.dependencyRoots();
        const files = this.findDependencySvelteFiles();
        const scope = this.dependencyScope!;
        return {
            mode: scope.mode,
            directImports: scope.directImports,
            dependencyRoots: roots.length,
            svelteFiles: files.length,
            fallbackReasons: scope.fallbackReasons
        };
    }

    /** Export the JSON-safe project graph after the caller has completed desired discovery. */
    exportBatchGraphPlan(): BatchGraphPlan {
        if (!this.parsedBaseConfig) {
            this.parseBaseConfig();
        }

        const sourceInputs = new Map(this.batchRestoredSourceInputs);
        for (const [fileName, signature] of this.reachabilityCache?.sourceSignatures ?? []) {
            sourceInputs.set(normalizePath(fileName), signature);
        }
        const manifestInputs = new Set(this.reachabilityCache?.manifestInputs ?? []);
        const layoutInputs = new Set(this.reachabilityCache?.layoutInputs ?? []);
        const directoryRoots = new Set(this.reachabilityCache?.directoryRoots ?? []);
        const addPackageEvidence = (fileName: string) => {
            const packageRoot = this.packageRootOf(fileName);
            manifestInputs.add(normalizePath(join(packageRoot, 'package.json')));
            layoutInputs.add(normalizePath(packageRoot));
            try {
                layoutInputs.add(normalizePath(fs.realpathSync(packageRoot)));
            } catch {
                // A deleted package is still represented by its lexical layout input.
            }
        };
        const evidenceFiles = unique([
            ...this.projectSvelteFiles,
            ...(this.projectSvelteFileScan ?? []),
            ...this.batchReachableSourceFiles,
            ...this.batchRootSourceFiles,
            ...this.batchForwardSourceEdges.keys(),
            ...[...this.batchForwardSourceEdges.values()].flatMap((targets) => [...targets]),
            ...this.batchReachablePackageImports.flatMap((entry) =>
                entry.resolvedFile
                    ? [entry.containingFile, entry.resolvedFile]
                    : [entry.containingFile]
            ),
            ...(this.dependencySvelteFileScan ?? [])
        ]);
        for (const fileName of evidenceFiles) {
            addPackageEvidence(fileName);
            layoutInputs.add(normalizePath(fileName));
        }
        manifestInputs.add(normalizePath(join(this.packageRoot, 'package.json')));
        for (const root of this.dependencyScope?.roots ?? []) {
            const normalized = normalizePath(root);
            manifestInputs.add(normalizePath(join(normalized, 'package.json')));
            layoutInputs.add(normalized);
            directoryRoots.add(normalized);
        }
        if (
            !this.options.tsconfigPath ||
            this.projectSvelteFileScan !== undefined ||
            this.projectReachabilityFallbackReasons.length
        ) {
            directoryRoots.add(this.sourceRoot);
        }

        const unsigned: Omit<BatchGraphPlan, 'signature'> = {
            version: 1,
            project: {
                projectPath: normalizePath(this.options.projectPath),
                sourceRoot: this.sourceRoot,
                tsconfigPath: this.options.tsconfigPath
                    ? normalizePath(this.options.tsconfigPath)
                    : null
            },
            parsedBaseConfig: cloneJsonValue(this.parsedBaseConfig!),
            baseConfigDiagnostics: this.baseConfigDiagnostics.map(serializeBatchGraphDiagnostic),
            batchCompilerOptions: cloneJsonValue(this.batchCompilerOptions),
            batchConfigDirectory: normalizePath(this.batchConfigDirectory),
            projectSvelteFiles: sortedUnique(this.projectSvelteFiles),
            projectSvelteFileScan: this.projectSvelteFileScan
                ? sortedUnique(this.projectSvelteFileScan)
                : null,
            batchReachableSourceFiles: sortedUnique(this.batchReachableSourceFiles),
            batchReachableBareImports: sortedMapEntries(this.batchReachableBareImports),
            batchReachablePackageImports: this.batchReachablePackageImports
                .map((entry) => ({ ...entry }))
                .sort((left, right) =>
                    `${left.containingFile}\0${left.specifier}`.localeCompare(
                        `${right.containingFile}\0${right.specifier}`
                    )
                ),
            batchRootSourceFiles: sortedUnique(this.batchRootSourceFiles),
            batchForwardSourceEdges: sortedSetMapEntries(this.batchForwardSourceEdges),
            batchReverseSourceEdges: sortedSetMapEntries(this.batchReverseSourceEdges),
            batchPackagePrivateSourceEdges: sortedSetMapEntries(
                this.batchPackagePrivateSourceEdges
            ),
            projectReachabilityFallbackReasons: [...this.projectReachabilityFallbackReasons].sort(),
            dependencySvelteFileScan: this.dependencySvelteFileScan
                ? sortedUnique(this.dependencySvelteFileScan)
                : null,
            dependencyScope: this.dependencyScope
                ? {
                      ...this.dependencyScope,
                      roots: sortedUnique(this.dependencyScope.roots),
                      fallbackReasons: [...this.dependencyScope.fallbackReasons].sort()
                  }
                : null,
            sourceInputs: [...sourceInputs]
                .map(([path, signature]) => ({ path: normalizePath(path), signature }))
                .sort((left, right) => left.path.localeCompare(right.path)),
            configInputs: sortedUnique(this.batchConfigInputs),
            manifestInputs: sortedUnique(manifestInputs),
            layoutInputs: sortedUnique(layoutInputs),
            directoryRoots: sortedUnique(directoryRoots)
        };
        return { ...unsigned, signature: batchGraphPlanSignature(unsigned) };
    }

    /** Semantic identity of the current serializable graph payload. */
    getBatchGraphPlanSignature(): string {
        return this.exportBatchGraphPlan().signature;
    }

    /** Source signatures that can be recomputed only after a source's cheap stat identity moves. */
    getBatchGraphPlanSourceInputs(): BatchGraphSourceInput[] {
        return this.exportBatchGraphPlan().sourceInputs;
    }

    /**
     * Atomically restore a previously exported plan. The external owner must validate freshness
     * first; this boundary validates schema, signature and project identity and fails closed.
     */
    restoreBatchGraphPlan(value: unknown): boolean {
        const plan = decodeBatchGraphPlan(value, {
            projectPath: normalizePath(this.options.projectPath),
            sourceRoot: this.sourceRoot,
            tsconfigPath: this.options.tsconfigPath
                ? normalizePath(this.options.tsconfigPath)
                : null
        });
        if (!plan) {
            return false;
        }

        this.projectSvelteFileScan = plan.projectSvelteFileScan ?? undefined;
        this.dependencySvelteFileScan = plan.dependencySvelteFileScan ?? undefined;
        this.dependencyScope = plan.dependencyScope
            ? {
                  ...plan.dependencyScope,
                  roots: [...plan.dependencyScope.roots],
                  fallbackReasons: [...plan.dependencyScope.fallbackReasons]
              }
            : undefined;
        this.owningPackages = undefined;
        this.packageRootByDir.clear();
        this.projectSvelteFiles = [...plan.projectSvelteFiles];
        this.projectConfigParsed = !!this.options.tsconfigPath;
        this.parsedBaseConfig = cloneJsonValue(plan.parsedBaseConfig);
        this.baseConfigDiagnostics = plan.baseConfigDiagnostics.map(restoreBatchGraphDiagnostic);
        this.batchCompilerOptions = cloneJsonValue(plan.batchCompilerOptions);
        this.batchConfigDirectory = plan.batchConfigDirectory;
        this.batchConfigInputs = new Set(plan.configInputs);
        this.batchRestoredSourceInputs = new Map(
            plan.sourceInputs.map((entry) => [entry.path, entry.signature])
        );
        this.batchReachableSourceFiles = [...plan.batchReachableSourceFiles];
        this.batchReachableBareImports = new Map(plan.batchReachableBareImports);
        this.batchReachablePackageImports = plan.batchReachablePackageImports.map((entry) => ({
            ...entry,
            resolvedFile: entry.resolvedFile
        }));
        this.batchRootSourceFiles = new Set(plan.batchRootSourceFiles);
        this.batchForwardSourceEdges = restoreSetMap(plan.batchForwardSourceEdges);
        this.batchReverseSourceEdges = restoreSetMap(plan.batchReverseSourceEdges);
        this.batchPackagePrivateSourceEdges = restoreSetMap(plan.batchPackagePrivateSourceEdges);
        this.projectReachabilityFallbackReasons = [...plan.projectReachabilityFallbackReasons];
        this.reachabilityCache = createReachabilityCache(
            this.batchCompilerOptions,
            this.batchConfigDirectory
        );
        for (const input of plan.sourceInputs) {
            this.reachabilityCache.sourceSignatures.set(input.path, input.signature);
        }
        for (const input of plan.manifestInputs) {
            this.reachabilityCache.manifestInputs.add(input);
        }
        for (const input of plan.layoutInputs) {
            this.reachabilityCache.layoutInputs.add(input);
        }
        for (const root of plan.directoryRoots) {
            this.reachabilityCache.directoryRoots.add(root);
        }

        // Collision allocations and output ownership are generation-local derived state.
        this.batchSourceMirrorByOriginal.clear();
        this.batchSourceOriginalByMirror.clear();
        this.batchMirrorKindByOriginal.clear();
        this.batchBareImportTargets.clear();
        this.batchSvelteSpecifierSuffixes.clear();
        this.batchRewriteSignature = undefined;
        this.batchMaterializedSvelteFiles.clear();
        this.batchPrivateSvelteImports.clear();
        this.batchPublicSvelteImports.clear();
        this.batchCollisionFallbackReasons = [];
        this.batchReverseClosureSize = 0;
        this.kitShadows.clear();
        this.kitShadowsByShadowPath.clear();
        this.fingerprintValidByPackage.clear();
        this.pendingFingerprints.clear();
        this.clearSnapshots();
        return true;
    }

    private canonicalSourcePath(filePath: string): string {
        return canonicalSourcePath(filePath, this.sourceRoot);
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
        const normalized = this.canonicalSourcePath(filePath);
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
        const normalized = this.canonicalSourcePath(filePath);
        const rel = relative(this.sourceRoot, normalized);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            // A file outside the workspace must not get a mirror in its own (foreign) package —
            // that would write into a repository the user never opened. It shadows into this
            // manager's own mirror under the __outside marker instead.
            return this.shadowRoot;
        }
        return this.mirrorRootIn(this.packageRootOf(normalized));
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
        const dir = normalizePath(dirname(this.canonicalSourcePath(filePath)));
        let cached = this.packageRootByDir.get(dir);
        if (!cached) {
            cached = sharedPackageRoot(dir, this.options.sourceRoot);
            this.packageRootByDir.set(dir, cached);
        }
        return cached;
    }

    /**
     * Prepare the batch-only ordinary-source mirror when TypeScript's extension substitution
     * would make a component and a legal rune module indistinguishable.
     *
     * Given `Widget.svelte` and `Widget.svelte.ts`, native TypeScript resolves both
     * `./Widget.svelte` and `./Widget.svelte.js` to the latter before `rootDirs` participates.
     * The CLI has no module-resolution hook, so the batch checker mirrors the reachable source
     * graph and gives component specifiers a same-length, collision-free spelling. The rune
     * module keeps its real name in the mirror and therefore remains the answer for the `.js`
     * spelling emitted by svelte2tsx.
     */
    prepareBatchModuleMirrors(): boolean {
        // Parsing records the reachable ordinary-source graph and concrete bare imports. The
        // generated config is written afterwards, once the batch mirror maps are authoritative.
        this.parseBaseConfig();
        const svelteFiles = unique([
            ...this.projectSvelteFiles,
            ...this.findProjectSvelteFiles(),
            ...this.findDependencySvelteFiles()
        ]).map((file) => this.canonicalSourcePath(file));
        // An explicit `.svelte` root still needs independent Svelte diagnostics even when an
        // adjacent declaration is authoritative for imports. Only files which actually need a
        // generated module participate in collision rewriting.
        const initialMaterializedSvelteFiles = svelteFiles.filter(needsSvelteShadow);
        const initialColliding = initialMaterializedSvelteFiles.filter(
            (file) => runeModuleCompanions(file).length > 0
        );
        if (!initialColliding.length) {
            this.batchSvelteSpecifierSuffixes.clear();
            this.batchRewriteSignature = undefined;
            this.batchSourceMirrorByOriginal.clear();
            this.batchSourceOriginalByMirror.clear();
            this.batchMirrorKindByOriginal.clear();
            this.batchBareImportTargets.clear();
            this.batchMaterializedSvelteFiles.clear();
            this.batchPrivateSvelteImports.clear();
            this.batchPublicSvelteImports.clear();
            this.batchCollisionFallbackReasons = [];
            this.batchReverseClosureSize = 0;
            return false;
        }

        const collisionPackageRoots = new Set(
            initialColliding.map((component) => this.packageRootOf(component))
        );
        const materializedSvelteFiles = new Set(initialMaterializedSvelteFiles);
        const sources = new Set<string>();
        this.batchCollisionFallbackReasons = [];

        this.batchSvelteSpecifierSuffixes.clear();
        const colliding = [...materializedSvelteFiles].filter(
            (file) => runeModuleCompanions(file).length > 0
        );
        for (const component of colliding) {
            this.batchSvelteSpecifierSuffixes.set(
                component,
                chooseBatchSvelteSpecifierSuffix([component])
            );
        }
        this.batchMaterializedSvelteFiles.clear();
        this.batchPrivateSvelteImports.clear();
        this.batchPublicSvelteImports.clear();
        const ambiguousPublicSpecifiers = new Set<string>();
        for (const file of materializedSvelteFiles) {
            const canonical = this.canonicalSourcePath(file);
            this.batchMaterializedSvelteFiles.add(canonical);
            const packageRoot = this.packageRootOf(canonical);
            const manifest = readPackageManifest(packageRoot);
            if (!manifest) {
                continue;
            }
            for (const specifier of packageImportSpecifiersForSvelteFile(
                manifest,
                packageRoot,
                canonical
            )) {
                this.batchPrivateSvelteImports.set(`${packageRoot}\0${specifier}`, canonical);
            }
            for (const specifier of publicSpecifiersForSvelteFile(
                manifest,
                packageRoot,
                canonical
            )) {
                const previous = this.batchPublicSvelteImports.get(specifier);
                if (previous && previous !== canonical) {
                    ambiguousPublicSpecifiers.add(specifier);
                    this.batchPublicSvelteImports.delete(specifier);
                } else if (!ambiguousPublicSpecifiers.has(specifier)) {
                    this.batchPublicSvelteImports.set(specifier, canonical);
                }
            }
        }

        // TypeScript may not resolve a raw exported `.svelte` specifier at all. Join those
        // observed bare edges to the authoritative public-component index before taking the
        // reverse closure, so an app root importing `pkg/Button.svelte` is retained.
        for (const imported of this.batchReachablePackageImports) {
            const target = this.batchPublicSvelteImports.get(imported.specifier);
            if (target) {
                addSourceGraphEdge(
                    this.batchForwardSourceEdges,
                    this.batchReverseSourceEdges,
                    imported.containingFile,
                    target
                );
            }
        }

        // Installed packages are intentionally not traversed by the project graph. Walk only
        // each colliding package's public entry graph to recover declaration/barrel importers.
        // If that public graph cannot be proven, preserve the old package-wide script mirror.
        for (const packageRoot of collisionPackageRoots) {
            if (!isExternalPackageRoot(packageRoot, this.sourceRoot)) {
                continue;
            }
            const graph = collectPublicPackageSourceGraph(
                packageRoot,
                this.batchCompilerOptions,
                this.batchConfigDirectory,
                this.sourceRoot,
                this.reachabilityCache,
                this.batchForwardSourceEdges,
                this.batchReverseSourceEdges,
                this.batchPackagePrivateSourceEdges
            );
            if (graph.fallbackReasons.length) {
                this.batchCollisionFallbackReasons.push(...graph.fallbackReasons);
                for (const source of scanPackageScriptFiles(packageRoot)) {
                    sources.add(this.canonicalSourcePath(source));
                }
            }
        }

        if (this.projectReachabilityFallbackReasons.length) {
            this.batchCollisionFallbackReasons.push(...this.projectReachabilityFallbackReasons);
            for (const source of this.batchReachableSourceFiles) {
                sources.add(this.canonicalSourcePath(source));
            }
            // An incomplete project graph cannot prove which package-private target a dynamic
            // edge reaches. Keep the former package-wide safety net, but constrain it to the
            // packages that actually contain a colliding component.
            for (const packageRoot of collisionPackageRoots) {
                for (const source of scanPackageScriptFiles(packageRoot)) {
                    sources.add(this.canonicalSourcePath(source));
                }
            }
        }
        const reverseClosure = collectReverseSourceClosure(colliding, this.batchReverseSourceEdges);
        this.batchReverseClosureSize = reverseClosure.size;
        for (const source of reverseClosure) {
            if (SCRIPT_SOURCE_RE.test(source)) {
                sources.add(this.canonicalSourcePath(source));
            }
        }
        // Node's package `imports` targets must remain inside their package scope. A mirrored
        // importer therefore cannot point back to an authored `#lib/*` target outside the
        // overlay. Follow only the proven package-private edges from code that will execute in
        // the mirror (including generated Svelte modules) and copy that small forward closure.
        for (const target of collectForwardSourceClosure(
            [...reverseClosure, ...materializedSvelteFiles, ...sources],
            this.batchPackagePrivateSourceEdges
        )) {
            if (SCRIPT_SOURCE_RE.test(target) || JSON_MODULE_RE.test(target)) {
                sources.add(this.canonicalSourcePath(target));
            }
        }
        for (const component of colliding) {
            for (const companion of runeModuleCompanions(component)) {
                sources.add(this.canonicalSourcePath(companion));
            }
        }
        // Package-private aliases in mirrored code now resolve inside the mirror package scope.
        // Copy only JSON modules proven by literal imports from those mirrored modules (or from
        // generated Svelte modules); never sweep a package's entire asset tree.
        for (const asset of collectResolvedJsonAssets(
            [...sources, ...materializedSvelteFiles],
            this.batchCompilerOptions,
            this.batchConfigDirectory,
            this.sourceRoot,
            this.reachabilityCache
        )) {
            sources.add(this.canonicalSourcePath(asset));
        }

        // A second project can already own ordinary mirrors in a package this project reaches.
        // Adopt those source mirrors before binding bare package entries: otherwise the entry
        // keeps resolving to its real file while one of its relative imports rootDirs-bridges
        // into the shared mirror, and native TypeScript loads both identities into the program.
        // Owner records are only candidate indexes. Every source/output pair is independently
        // checked against the bytes this manager would write. A source-newer output becomes a
        // required materialisation entry (and is refreshed before native TypeScript runs), while
        // a mirror produced under incompatible collision state is never made a resolution target.
        this.adoptFreshForeignBatchSourceMirrors(sources);

        this.batchSourceMirrorByOriginal.clear();
        this.batchSourceOriginalByMirror.clear();
        this.batchMirrorKindByOriginal.clear();
        for (const source of sources) {
            if (
                (!SCRIPT_SOURCE_RE.test(source) && !JSON_MODULE_RE.test(source)) ||
                source.includes(`/${OVERLAY_DIR}/`) ||
                this.kitShadows.has(source) ||
                !fs.statSync(source, { throwIfNoEntry: false })?.isFile()
            ) {
                continue;
            }
            const mirror = normalizePath(
                join(this.mirrorRootFor(source), this.mirrorRelFor(source))
            );
            this.batchSourceMirrorByOriginal.set(source, mirror);
            this.batchSourceOriginalByMirror.set(mirror, source);
            this.batchMirrorKindByOriginal.set(
                source,
                SCRIPT_SOURCE_RE.test(source) ? 'script' : 'json'
            );
            this.originalByShadowPath.set(mirror, source);
            this.registerReverseIndex?.(mirror, source);
        }

        this.batchBareImportTargets.clear();
        for (const [specifier, target] of this.batchReachableBareImports) {
            const canonicalTarget = this.canonicalSourcePath(target);
            if (
                !specifier.startsWith('#') &&
                this.batchSourceMirrorByOriginal.has(canonicalTarget)
            ) {
                this.batchBareImportTargets.set(specifier, canonicalTarget);
            }
        }
        this.batchRewriteSignature = batchRewriteIdentity({
            suffixes: this.batchSvelteSpecifierSuffixes,
            configDirectory: this.batchConfigDirectory,
            compilerOptions: this.batchCompilerOptions,
            materializedSvelteFiles: this.batchMaterializedSvelteFiles,
            privateImports: this.batchPrivateSvelteImports,
            publicImports: this.batchPublicSvelteImports,
            mirrors: this.batchSourceMirrorByOriginal
        });
        return true;
    }

    private adoptFreshForeignBatchSourceMirrors(sources: Set<string>): void {
        const packageRoots = new Set<string>();
        for (const target of this.batchReachableBareImports.values()) {
            const packageRoot = this.packageRootOf(target);
            const workspaceRelative = relative(this.sourceRoot, packageRoot);
            if (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative)) {
                packageRoots.add(packageRoot);
            }
        }

        const ownOwnerFile = `${this.batchMirrorOwnerId()}.json`;
        for (const packageRoot of packageRoots) {
            const mirror = this.mirrorRootIn(packageRoot);
            const ownerDirectory = join(dirname(mirror), 'batch-owners');
            let ownerFiles: string[];
            try {
                ownerFiles = fs.readdirSync(ownerDirectory);
            } catch {
                continue;
            }
            for (const ownerFile of ownerFiles) {
                if (ownerFile === ownOwnerFile || !ownerFile.endsWith('.json')) {
                    continue;
                }
                let relativePaths: string[];
                try {
                    const owner = JSON.parse(
                        fs.readFileSync(join(ownerDirectory, ownerFile), 'utf8')
                    );
                    if (
                        owner?.version !== 1 ||
                        !Array.isArray(owner.paths) ||
                        !owner.paths.every((entry: unknown) => typeof entry === 'string')
                    ) {
                        continue;
                    }
                    relativePaths = owner.paths.map((entry: string) => normalizePath(entry));
                } catch {
                    continue;
                }

                if (
                    relativePaths.some(
                        (relativePath) =>
                            !relativePath ||
                            relativePath === '.' ||
                            relativePath.startsWith('../') ||
                            isAbsolute(relativePath)
                    )
                ) {
                    continue;
                }

                const adoptableSources: string[] = [];
                let ownerIsCompatible = true;
                for (const relativePath of relativePaths) {
                    const mirrorPath = normalizePath(join(mirror, relativePath));
                    if (!mirrorPath.startsWith(`${mirror}/`)) {
                        ownerIsCompatible = false;
                        break;
                    }
                    const original = this.originalForMirrorRel(mirror, relativePath);
                    if (
                        !original ||
                        (!SCRIPT_SOURCE_RE.test(original) && !JSON_MODULE_RE.test(original))
                    ) {
                        continue;
                    }
                    const authoritativeMirror = normalizePath(
                        join(this.mirrorRootFor(original), this.mirrorRelFor(original))
                    );
                    if (authoritativeMirror !== mirrorPath) {
                        continue;
                    }
                    let sourceStat: fs.Stats;
                    try {
                        sourceStat = fs.statSync(original);
                    } catch {
                        // Generated component twins resemble ordinary `.tsx` paths after the
                        // layout is inverted, but do not have a same-spelled authored source.
                        // Every other missing source makes the owner record stale as a unit:
                        // redirecting a package entry while one of its relative mirror targets
                        // has disappeared would recreate the mixed real/mirror program.
                        if (
                            relativePath.endsWith('.svelte.tsx') ||
                            /\.(?:__svlt|__s[0-9a-z]{3})\.tsx$/.test(relativePath)
                        ) {
                            continue;
                        }
                        ownerIsCompatible = false;
                        break;
                    }
                    if (!sourceStat.isFile()) {
                        ownerIsCompatible = false;
                        break;
                    }
                    try {
                        const sourceText = fs.readFileSync(original, 'utf8');
                        const expectedText = SCRIPT_SOURCE_RE.test(original)
                            ? this.rewriteBatchModuleSpecifiers(sourceText, original)
                            : sourceText;
                        const mirrorStat = fs.statSync(mirrorPath, { throwIfNoEntry: false });
                        if (!mirrorStat?.isFile()) {
                            // The owner record and source graph are still useful: materialisation
                            // must recreate this missing output before the overlay is published.
                            adoptableSources.push(this.canonicalSourcePath(original));
                            continue;
                        }
                        if (fs.readFileSync(mirrorPath, 'utf8') === expectedText) {
                            adoptableSources.push(this.canonicalSourcePath(original));
                            continue;
                        }
                        if (
                            sourceStat.mtimeMs > mirrorStat.mtimeMs ||
                            sourceStat.ctimeMs > mirrorStat.mtimeMs
                        ) {
                            // An authored edit raced ahead of the foreign owner. Include it in
                            // this manager's required source-mirror set; batch/editor
                            // materialisation rewrites it before native TypeScript can run.
                            adoptableSources.push(this.canonicalSourcePath(original));
                        } else {
                            // Newer-but-different bytes were produced under incompatible
                            // collision state. Do not overwrite another live manager's spelling
                            // or route this project's package entry through it.
                            ownerIsCompatible = false;
                            break;
                        }
                    } catch {
                        // The owner record is only an optimisation hint. A racing edit or an
                        // unreadable candidate simply leaves native resolution on the real file.
                        ownerIsCompatible = false;
                        break;
                    }
                }
                if (ownerIsCompatible) {
                    for (const source of adoptableSources) {
                        sources.add(source);
                    }
                }
            }
        }
    }

    /** Ordinary source files copied into the batch mirror. */
    getBatchSourceMirrorEntries(): Array<{
        originalPath: string;
        mirrorPath: string;
        kind: 'script' | 'json';
    }> {
        return [...this.batchSourceMirrorByOriginal].map(([originalPath, mirrorPath]) => ({
            originalPath,
            mirrorPath,
            kind: this.batchMirrorKindByOriginal.get(originalPath) ?? 'script'
        }));
    }

    /** Before/after collision-mirror counts and conservative fallback reasons. */
    getBatchMirrorStats(): {
        rootFiles: number;
        sourceEdges: number;
        reachableScripts: number;
        legacyCandidateScripts: number;
        reverseClosureNodes: number;
        mirroredScripts: number;
        mirroredJson: number;
        collidingComponents: number;
        fallbackReasons: readonly string[];
    } {
        const entries = this.getBatchSourceMirrorEntries();
        const legacyCandidateScripts = new Set(this.batchReachableSourceFiles);
        for (const component of this.batchSvelteSpecifierSuffixes.keys()) {
            for (const companion of runeModuleCompanions(component)) {
                legacyCandidateScripts.add(companion);
            }
        }
        return {
            rootFiles: this.batchRootSourceFiles.size,
            sourceEdges: [...this.batchForwardSourceEdges.values()].reduce(
                (total, targets) => total + targets.size,
                0
            ),
            reachableScripts: this.batchReachableSourceFiles.length,
            legacyCandidateScripts: legacyCandidateScripts.size,
            reverseClosureNodes: this.batchReverseClosureSize,
            mirroredScripts: entries.filter((entry) => entry.kind === 'script').length,
            mirroredJson: entries.filter((entry) => entry.kind === 'json').length,
            collidingComponents: this.batchSvelteSpecifierSuffixes.size,
            fallbackReasons: this.batchCollisionFallbackReasons
        };
    }

    /** Stable package-wide component inventory used while collision mirroring is active. */
    getBatchMaterializedSvelteFiles(): string[] {
        return [...this.batchMaterializedSvelteFiles];
    }

    /** The source behind an ordinary TS/JS batch mirror, if this path is one. */
    getBatchSourceOriginalPath(mirrorPath: string): string | undefined {
        return this.batchSourceOriginalByMirror.get(normalizePath(mirrorPath));
    }

    /**
     * Rewrite component module specifiers without moving a single subsequent offset. Both the
     * original and replacement suffixes are seven ASCII code units.
     */
    rewriteBatchModuleSpecifiers(text: string, containingFilePath: string): string {
        if (!this.batchSvelteSpecifierSuffixes.size || !text.includes('.svelte')) {
            return text;
        }
        const replacements = analyzeReachabilitySource(
            containingFilePath,
            this.reachabilityCache,
            text
        )
            .preprocessed.importedFiles.filter((entry) => entry.fileName.endsWith('.svelte'))
            .map((entry) => {
                const target = this.resolveBatchSvelteImport(entry.fileName, containingFilePath);
                const suffix = target ? this.batchSvelteSpecifierSuffixes.get(target) : undefined;
                return {
                    start: entry.pos + 1,
                    end: entry.end + 1,
                    expected: entry.fileName,
                    replacement: suffix
                        ? `${entry.fileName.slice(0, -SVELTE_SPECIFIER_LENGTH)}${suffix}`
                        : entry.fileName,
                    target,
                    suffix
                };
            })
            .filter(
                (entry) =>
                    !!entry.target &&
                    !!entry.suffix &&
                    entry.replacement.length === entry.expected.length &&
                    text.slice(entry.start, entry.end) === entry.expected
            )
            .sort((a, b) => b.start - a.start);
        let rewritten = text;
        for (const replacement of replacements) {
            rewritten =
                rewritten.slice(0, replacement.start) +
                replacement.replacement +
                rewritten.slice(replacement.end);
        }
        return rewritten;
    }

    private resolveBatchSvelteImport(
        specifier: string,
        containingFilePath: string
    ): string | undefined {
        const containing = this.canonicalSourcePath(containingFilePath);
        if (specifier.startsWith('#')) {
            const privateTarget = this.batchPrivateSvelteImports.get(
                `${this.packageRootOf(containing)}\0${specifier}`
            );
            if (privateTarget) {
                return privateTarget;
            }
            // `#` is also a legal tsconfig `paths` prefix. A miss in package.json imports must
            // fall through to normal resolution instead of silently disabling rewriting.
        }
        const publicTarget = this.batchPublicSvelteImports.get(specifier);
        if (publicTarget) {
            return publicTarget;
        }
        const resolved = resolveReachableImport(
            specifier,
            containing,
            this.batchCompilerOptions,
            this.batchConfigDirectory,
            this.reachabilityCache
        );
        if (!resolved) {
            return undefined;
        }
        const canonical = this.canonicalSourcePath(resolved);
        if (canonical.endsWith('.svelte')) {
            return canonical;
        }
        // Native TypeScript itself may have already substituted a colliding rune module. The
        // exact component file is the semantic target of the extensionless `.svelte` spelling.
        for (const extension of ['.ts', '.js']) {
            if (canonical.endsWith(`.svelte${extension}`)) {
                const component = canonical.slice(0, -extension.length);
                if (fs.existsSync(component)) {
                    return component;
                }
            }
        }
        return undefined;
    }

    /** Persisted with ordinary-source mirror state so an alias-allocation change invalidates it. */
    get batchRewriteIdentity(): string | undefined {
        return this.batchRewriteSignature;
    }

    /** Restore the user's component spelling in a native message. */
    restoreBatchModuleSpecifiers(message: string): string {
        for (const suffix of new Set(this.batchSvelteSpecifierSuffixes.values())) {
            message = message.split(suffix).join('.svelte');
        }
        return message;
    }

    /**
     * Put a package boundary inside each active mirror. Its rewritten `imports` field keeps
     * package-private aliases (`#lib/*`) scoped to their owning package instead of flattening
     * mutually incompatible aliases into the overlay's one global `paths` table.
     */
    writeBatchMirrorPackageScopes(): string[] {
        if (!this.batchSvelteSpecifierSuffixes.size) {
            return [];
        }
        const packageRoots = new Set<string>();
        for (const original of this.batchSourceMirrorByOriginal.keys()) {
            packageRoots.add(this.packageRootOf(original));
        }
        for (const file of [
            ...this.projectSvelteFiles,
            ...this.findProjectSvelteFiles(),
            ...this.findDependencySvelteFiles()
        ]) {
            packageRoots.add(this.packageRootOf(file));
        }

        const written: string[] = [];
        for (const packageRoot of packageRoots) {
            const manifest = readPackageManifest(packageRoot);
            if (!manifest) {
                continue;
            }
            const mirror = this.mirrorRootIn(packageRoot);
            const imports = rewritePackageImportsForMirror(
                manifest.imports,
                packageRoot,
                mirror,
                (target) =>
                    normalizePath(join(this.mirrorRootFor(target), this.mirrorRelFor(target)))
            );
            const scopedImports =
                imports && typeof imports === 'object' && !Array.isArray(imports)
                    ? { ...(imports as Record<string, unknown>) }
                    : {};
            for (const [scopedSpecifier, component] of this.batchPrivateSvelteImports) {
                const separator = scopedSpecifier.indexOf('\0');
                if (scopedSpecifier.slice(0, separator) !== packageRoot) {
                    continue;
                }
                const specifier = scopedSpecifier.slice(separator + 1);
                const componentShadow = this.getShadowPath(component);
                const relativeShadow = normalizePath(relative(mirror, componentShadow));
                const scopedShadow = relativeShadow.startsWith('.')
                    ? relativeShadow
                    : `./${relativeShadow}`;
                scopedImports[specifier] = scopedShadow;
                const suffix = this.batchSvelteSpecifierSuffixes.get(component);
                if (!suffix || !specifier.endsWith('.svelte')) {
                    continue;
                }
                const rewritten = `${specifier.slice(0, -SVELTE_SPECIFIER_LENGTH)}${suffix}`;
                // Exact keys beat every wildcard shape, including `#lib/* -> ./src/*.svelte`,
                // whose substitution would otherwise append `.svelte` to the rewritten alias.
                scopedImports[rewritten] = scopedShadow;
            }
            const target = join(mirror, 'package.json');
            const sourceManifest = this.canonicalSourcePath(join(packageRoot, 'package.json'));
            const scopeIsImportedManifest =
                this.batchSourceMirrorByOriginal.get(sourceManifest) === normalizePath(target);
            const contents = JSON.stringify(
                scopeIsImportedManifest
                    ? {
                          // A source can legally import its own package.json. At a package-root
                          // sourceRoot that path is also the required mirror boundary, so retain
                          // the authored manifest shape and only rebase its resolution metadata.
                          ...manifest,
                          ...(Object.keys(scopedImports).length
                              ? { imports: scopedImports }
                              : { imports: undefined })
                      }
                    : {
                          name: `${manifest.name ?? 'svelte-lsp-mirror'}-svelte-lsp-mirror`,
                          private: true,
                          ...(manifest.type ? { type: manifest.type } : {}),
                          ...(Object.keys(scopedImports).length ? { imports: scopedImports } : {})
                      },
                null,
                4
            );
            fs.mkdirSync(mirror, { recursive: true });
            this.writeRequiredConfig(target, contents);
            written.push(normalizePath(target));
        }
        return written;
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
        const originalPath = this.canonicalSourcePath(svelteFilePath);
        const relativePath = this.mirrorRelFor(originalPath);
        const suffix = this.batchSvelteSpecifierSuffixes.get(originalPath);
        const batchRelativePath = suffix
            ? `${relativePath.slice(0, -SVELTE_SPECIFIER_LENGTH)}${suffix}`
            : relativePath;
        const shadowPath = normalizePath(
            join(this.mirrorRootFor(originalPath), `${batchRelativePath}.tsx`)
        );
        this.originalByShadowPath.set(shadowPath, originalPath);
        this.registerReverseIndex?.(shadowPath, originalPath);
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
            // The mirror layout is authoritative and invertible. A resource operation often
            // names a *new* Svelte target which cannot exist or have a snapshot yet; requiring
            // either would leak `.svelte.tsx` into the workspace edit sent to the client.
            return this.originalForMirrorRel(mirror, rel);
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
        const key = normalizePath(svelteFilePath);
        const entry = this.snapshots.get(key);
        if (!entry) {
            return undefined;
        }
        // Map insertion order is the LRU order. Refresh on navigation/mapping access.
        this.snapshots.delete(key);
        this.snapshots.set(key, entry);
        return entry.snapshot;
    }

    pinSnapshot(svelteFilePath: string) {
        this.pinnedSnapshots.add(normalizePath(svelteFilePath));
    }

    unpinSnapshot(svelteFilePath: string) {
        this.pinnedSnapshots.delete(normalizePath(svelteFilePath));
        this.evictNavigationSnapshots();
    }

    /** @internal Exposed for lifecycle/RSS regression assertions. */
    get snapshotCount(): number {
        return this.snapshots.size;
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
        if (!this.isTransformFingerprintCurrent(sourcePath)) {
            return false;
        }
        try {
            const shadow = fs.statSync(shadowPath, { throwIfNoEntry: false });
            if (!shadow) {
                return false;
            }
            const source = fs.statSync(sourcePath, { throwIfNoEntry: false });
            return (
                !!source &&
                shadow.mtimeMs >= source.mtimeMs &&
                // Git/tools can restore an old mtime after replacing content. ctime still moves
                // when the inode metadata/content changes, so a same-size preserved-mtime edit
                // cannot make stale generated text look fresh.
                shadow.mtimeMs >= source.ctimeMs
            );
        } catch {
            return false;
        }
    }

    /** Whether compiler/config/transform inputs still match the package's persisted shadows. */
    isTransformFingerprintCurrent(sourcePath: string): boolean {
        return this.fingerprintValidByPackage.get(this.packageRootOf(sourcePath)) === true;
    }

    /**
     * Compare the current transform fingerprint against the one the shadows were written with,
     * and record the new one. Everything is stale when it differs.
     *
     * Stored once per *source root*, not per project overlay: the shadow tree is canonical and
     * shared, so a per-project fingerprint would make the first manager for each additional
     * package find nothing, distrust every shadow, and re-transform the entire workspace.
     */
    private checkFingerprints(): void {
        const allSvelteFiles = [
            ...this.projectSvelteFiles,
            ...this.findProjectSvelteFiles(),
            ...this.findDependencySvelteFiles()
        ];
        const filesByPackage = new Map<string, string[]>();
        for (const file of allSvelteFiles) {
            const packageRoot = this.packageRootOf(file);
            const files = filesByPackage.get(packageRoot) ?? [];
            files.push(file);
            filesByPackage.set(packageRoot, files);
        }
        for (const packageRoot of this.svelteOwningPackages()) {
            const options =
                this.options.resolveSnapshotOptions?.(packageRoot) ?? this.options.snapshotOptions;
            const configs = unique(
                (filesByPackage.get(packageRoot) ?? []).map((file) =>
                    JSON.stringify(
                        configLoader.getResolvedConfig(file)?.transformIdentity ??
                            transformConfigIdentity(configLoader.getConfig(file))
                    )
                )
            ).sort();
            const fingerprint = JSON.stringify({
                layout: SHADOW_LAYOUT_VERSION,
                svelte2tsx: SVELTE2TSX_VERSION,
                // Editor materialisation applies the same collision-safe specifier rewriting as
                // batch mode. A topology/allocation change can alter generated bytes without
                // touching the Svelte source, so source mtimes alone cannot validate reuse.
                rewrite: this.batchRewriteSignature ?? null,
                options: snapshotOptionsIdentity(options),
                configs
            });
            const target = join(dirname(this.mirrorRootIn(packageRoot)), '.fingerprint');
            let matched = false;
            try {
                matched = fs.readFileSync(target, 'utf8') === fingerprint;
            } catch {
                matched = false;
            }
            if (matched) {
                this.pendingFingerprints.delete(packageRoot);
            } else {
                this.pendingFingerprints.set(packageRoot, { target, contents: fingerprint });
            }
            this.fingerprintValidByPackage.set(packageRoot, matched);
        }
    }

    /** Commit transform fingerprints after a complete, successful materialisation pass. */
    commitFingerprints(): void {
        for (const [packageRoot, pending] of this.pendingFingerprints) {
            try {
                fs.mkdirSync(dirname(pending.target), { recursive: true });
                fs.writeFileSync(pending.target, pending.contents);
                this.fingerprintValidByPackage.set(packageRoot, true);
                this.pendingFingerprints.delete(packageRoot);
            } catch (error) {
                // Current shadows remain usable, but the next process must conservatively rebuild
                // them when their transform identity could not be persisted.
                this.fingerprintValidByPackage.set(packageRoot, false);
                Logger.debug(`[tsgo] could not persist fingerprint ${pending.target}`, error);
            }
        }
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
        const transformIdentity = JSON.stringify({
            options: snapshotOptionsIdentity(options),
            config:
                configLoader.getResolvedConfig(filePath)?.transformIdentity ??
                transformConfigIdentity(document.config)
        });
        const previous = this.snapshots.get(key);
        if (
            previous &&
            previous.sourceText === text &&
            previous.transformIdentity === transformIdentity
        ) {
            this.snapshots.delete(key);
            this.snapshots.set(key, previous);
            return previous.snapshot;
        }

        const snapshot = DocumentSnapshot.fromDocument(document, options) as SvelteDocumentSnapshot;
        this.snapshots.set(key, { sourceText: text, transformIdentity, snapshot });
        this.evictNavigationSnapshots();
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

    private evictNavigationSnapshots() {
        const limit = Math.max(MAX_NAVIGATION_SNAPSHOTS, this.pinnedSnapshots.size);
        if (this.snapshots.size <= limit) {
            return;
        }
        for (const key of this.snapshots.keys()) {
            if (this.snapshots.size <= limit) {
                break;
            }
            if (!this.pinnedSnapshots.has(key)) {
                this.snapshots.delete(key);
            }
        }
    }

    /** Forget graph/config-derived state before rebuilding this manager's overlay. */
    invalidateStructuralCaches() {
        this.projectSvelteFileScan = undefined;
        this.dependencySvelteFileScan = undefined;
        this.dependencyScope = undefined;
        this.owningPackages = undefined;
        this.packageRootByDir.clear();
        this.projectSvelteFiles = [];
        this.projectConfigParsed = false;
        this.parsedBaseConfig = undefined;
        this.baseConfigDiagnostics = [];
        this.reachabilityCache = undefined;
        this.batchConfigInputs.clear();
        this.batchRestoredSourceInputs.clear();
        this.projectReachabilityFallbackReasons = [];
        this.batchReachableSourceFiles = [];
        this.batchReachableBareImports.clear();
        this.batchReachablePackageImports = [];
        this.batchRootSourceFiles.clear();
        this.batchForwardSourceEdges.clear();
        this.batchReverseSourceEdges.clear();
        this.batchPackagePrivateSourceEdges.clear();
        this.batchCollisionFallbackReasons = [];
        this.batchReverseClosureSize = 0;
        this.fingerprintValidByPackage.clear();
        this.pendingFingerprints.clear();
        this.clearSnapshots();
        invalidateTsGoWorkspaceIndex();
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
        const stamp = contentStamp(text);
        // One keystroke fans out into half a dozen feature requests, and each of them syncs the
        // shadow — without this, that is half a dozen synchronous whole-file writes of identical
        // bytes per keystroke, each an mtime bump on a file tsgo is watching. The existsSync
        // keeps the stamp honest: the tree lives under node_modules/.cache, which a clean
        // install sweeps away mid-session, and a stamp for a file that is gone must not stop
        // it from being recreated.
        if (this.lastWritten.get(key) === stamp && fs.existsSync(shadowPath)) {
            return false;
        }
        this.ensureShadowDirectory(shadowPath);
        try {
            fs.writeFileSync(shadowPath, text);
            this.lastWritten.set(key, stamp);
            return true;
        } catch (e) {
            Logger.error(`[tsgo] could not write shadow ${shadowPath}`, e);
            throw e;
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
     * Publish this manager's copied batch mirrors and remove only its own newly-stale outputs.
     * One owner file per mirror lets a second project manager protect an identical canonical
     * output without making the hot per-file state global or scanning the workspace.
     */
    reconcileBatchMirrorOwnership(previousPaths: string[], livePaths: string[]) {
        const previous = new Set(previousPaths.map(normalizePath));
        const live = new Set(livePaths.map(normalizePath));
        const mirrors = new Set<string>();
        for (const filePath of [...previous, ...live]) {
            const mirror = this.batchMirrorRootForPath(filePath);
            if (mirror) {
                mirrors.add(mirror);
            }
        }

        const ownerId = this.batchMirrorOwnerId();
        for (const mirror of mirrors) {
            const ownerDirectory = join(dirname(mirror), 'batch-owners');
            const ownerFile = join(ownerDirectory, `${ownerId}.json`);
            // Support package.json files are not source-state entries. Recover the complete
            // previous ownership set before replacing this manager's record so collision-off
            // can retire them without touching another manager's still-live scope.
            try {
                const priorOwner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
                if (priorOwner?.version === 1 && Array.isArray(priorOwner.paths)) {
                    for (const relativePath of priorOwner.paths) {
                        previous.add(normalizePath(join(mirror, relativePath)));
                    }
                }
            } catch {
                // First run for this manager/mirror.
            }
            const owned = [...live]
                .filter((filePath) => filePath.startsWith(mirror + '/'))
                .map((filePath) => normalizePath(relative(mirror, filePath)))
                .sort();
            if (owned.length) {
                fs.mkdirSync(ownerDirectory, { recursive: true });
                this.writeRequiredConfig(ownerFile, JSON.stringify({ version: 1, paths: owned }));
            } else {
                try {
                    fs.unlinkSync(ownerFile);
                } catch {
                    // An absent owner file already represents the desired state.
                }
            }
        }

        for (const stalePath of previous) {
            if (live.has(stalePath)) {
                continue;
            }
            const mirror = this.batchMirrorRootForPath(stalePath);
            if (!mirror || this.batchMirrorHasOwner(mirror, stalePath, ownerId)) {
                continue;
            }
            this.removeShadow(stalePath);
        }
    }

    /** Cheap warm-path proof that this manager still owns exactly the supplied mirror outputs. */
    isBatchMirrorOwnershipCurrent(livePaths: string[]): boolean {
        const ownedByMirror = new Map<string, string[]>();
        for (const filePath of livePaths.map(normalizePath)) {
            const mirror = this.batchMirrorRootForPath(filePath);
            if (!mirror) {
                return false;
            }
            const owned = ownedByMirror.get(mirror);
            const relativePath = normalizePath(relative(mirror, filePath));
            if (owned) {
                owned.push(relativePath);
            } else {
                ownedByMirror.set(mirror, [relativePath]);
            }
        }

        const ownerId = this.batchMirrorOwnerId();
        for (const mirror of new Set([...this.mirrorRoots.values(), ...ownedByMirror.keys()])) {
            const expected = unique(ownedByMirror.get(mirror) ?? []).sort();
            const ownerFile = join(dirname(mirror), 'batch-owners', `${ownerId}.json`);
            if (!expected.length) {
                if (fs.existsSync(ownerFile)) {
                    return false;
                }
                continue;
            }
            try {
                const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
                if (
                    owner?.version !== 1 ||
                    !Array.isArray(owner.paths) ||
                    owner.paths.length !== expected.length ||
                    !expected.every((relativePath, index) => owner.paths[index] === relativePath)
                ) {
                    return false;
                }
            } catch {
                return false;
            }
        }
        return true;
    }

    private batchMirrorOwnerId(): string {
        return contentStamp(
            `${normalizePath(this.options.projectPath)}\0${normalizePath(
                this.options.tsconfigPath ?? ''
            )}`
        ).replace(':', '-');
    }

    private batchMirrorRootForPath(filePath: string): string | undefined {
        const normalized = normalizePath(filePath);
        return [...this.mirrorRoots.values()]
            .filter((mirror) => normalized.startsWith(mirror + '/'))
            .sort((left, right) => right.length - left.length)[0];
    }

    private batchMirrorHasOwner(
        mirror: string,
        filePath: string,
        excludedOwnerId?: string
    ): boolean {
        const ownerDirectory = join(dirname(mirror), 'batch-owners');
        const relativePath = normalizePath(relative(mirror, filePath));
        let ownerFiles: string[];
        try {
            ownerFiles = fs.readdirSync(ownerDirectory);
        } catch {
            return false;
        }
        for (const ownerFile of ownerFiles) {
            if (
                (excludedOwnerId && ownerFile === `${excludedOwnerId}.json`) ||
                !ownerFile.endsWith('.json')
            ) {
                continue;
            }
            try {
                const owner = JSON.parse(fs.readFileSync(join(ownerDirectory, ownerFile), 'utf8'));
                if (owner?.version === 1 && owner.paths?.includes(relativePath)) {
                    return true;
                }
            } catch {
                // A malformed/stale owner record cannot prove that the output is live.
            }
        }
        return false;
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
                if (this.batchMirrorHasOwner(mirror, normalized)) {
                    continue;
                }
                const rel = normalized.slice(mirror.length + 1);
                const exactOriginal = this.originalForMirrorRel(mirror, rel);
                let componentRel = rel.endsWith('.tsx') ? rel.slice(0, -'.tsx'.length) : rel;
                for (const suffix of new Set(this.batchSvelteSpecifierSuffixes.values())) {
                    if (componentRel.endsWith(suffix)) {
                        componentRel = `${componentRel.slice(0, -suffix.length)}.svelte`;
                        break;
                    }
                }
                const original =
                    this.batchSourceOriginalByMirror.get(normalized) ??
                    this.originalByShadowPath.get(normalized) ??
                    (exactOriginal && fs.existsSync(exactOriginal)
                        ? exactOriginal
                        : this.originalForMirrorRel(mirror, componentRel));
                if (original && fs.existsSync(original)) {
                    // Keep another manager's live work only when it uses the current canonical
                    // spelling. Old realpath/symlink twins otherwise survive forever merely
                    // because both spellings still point at an existing source.
                    const authoritative = original.endsWith('.svelte')
                        ? this.getShadowPath(original)
                        : SCRIPT_SOURCE_RE.test(original) ||
                            (JSON_MODULE_RE.test(original) &&
                                normalized !== normalizePath(join(mirror, 'package.json')))
                          ? normalizePath(
                                join(this.mirrorRootFor(original), this.mirrorRelFor(original))
                            )
                          : undefined;
                    if (authoritative === normalized) {
                        continue;
                    }
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
        // Parsing first seeds the authoritative project roots, including explicit files outside
        // the broad workspace scan, so their owning package gets its own freshness fingerprint.
        const base = this.parseBaseConfig();
        this.checkFingerprints();
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
        const inferredShadowFiles = this.options.tsconfigPath
            ? []
            : this.findProjectSvelteFiles()
                  .filter((file) => {
                      if (!needsSvelteShadow(file)) {
                          return false;
                      }
                      const nearest = findProjectTsconfig(dirname(file));
                      if (!nearest) {
                          return true;
                      }
                      const fileRel = relative(this.options.projectPath, normalizePath(file));
                      const configRel = relative(this.options.projectPath, normalizePath(nearest));
                      // ProjectRegistry deliberately ignores a parent config outside an opened
                      // config-less folder, so a file *inside* that folder remains inferred.
                      // A broad source-root scan can also see a sibling workspace, though: if
                      // that sibling has its own config, its manager owns the file and including
                      // its shadow here would silently merge two independent projects.
                      const fileIsInside = !fileRel.startsWith('..') && !isAbsolute(fileRel);
                      const configIsInside = !configRel.startsWith('..') && !isAbsolute(configRel);
                      return fileIsInside && !configIsInside;
                  })
                  .map((file) => this.getShadowPath(file));

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
            files: unique([...base.fileNames, ...inferredShadowFiles, ...shimFiles]),
            // A child config inherits the base's `include` even when it declares `files`; the two
            // root sets are additive. Once ordinary sources are mirrored, inheriting `include`
            // would pull their real twins back into the same native program and reintroduce the
            // exact extension-substitution collision the mirror exists to avoid.
            include: []
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
            this.writeRequiredConfig(this.overlayTsconfigPath, contents);
        } catch (e) {
            Logger.error(`[tsgo] could not write overlay tsconfig`, e);
            throw e;
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
        const dirs = new Set<string>();
        const addRootDir = (directory: string) => {
            const normalized = normalizePath(directory);
            dirs.add(normalized);
            dirs.add(realPathOrSelf(normalized));
        };
        for (const dir of baseDirs) {
            addRootDir(dir);
        }
        for (const dir of baseDirs) {
            const rel = relative(this.sourceRoot, dir);
            if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
                continue;
            }
            const mirror = this.mirrorRootIn(findPackageRoot(dir, this.sourceRoot));
            addRootDir(join(mirror, rel));
        }
        addRootDir(this.sourceRoot);
        for (const mirror of this.mirrorRoots.values()) {
            addRootDir(mirror);
        }

        // TypeScript realpaths package entrypoints before resolving their relative imports. Pair
        // each such physical package root with the exact suffix-space inside its authoritative
        // mirror. This is required for pnpm store paths and for linked workspace packages on
        // macOS, where `/var` also becomes `/private/var` during realpath resolution.
        const owners = new Set(this.svelteOwningPackages());
        for (const [realPackageRoot, lexicalPackageRoot] of sharedLexicalPackageRootsByReal) {
            const canonicalPackageRoot = this.canonicalSourcePath(lexicalPackageRoot);
            if (!owners.has(canonicalPackageRoot)) {
                continue;
            }
            // A workspace package whose authored and physical roots are identical is already
            // bridged by sourceRoot <-> mirrorRoot. Adding the shorter packageRoot <->
            // mirrorRoot/package pair makes every package share the same `src/...` suffix
            // space. TypeScript tries rootDirs in declaration order, so `../ui` from a UI
            // shadow can then resolve to an unrelated app's `src/.../ui` barrel and silently
            // lose exports. The short pair is only needed when realpath changed the package
            // identity (pnpm store and symlinked dependency layouts).
            const rel = relative(this.sourceRoot, canonicalPackageRoot);
            if (rel.startsWith('..') || isAbsolute(rel)) {
                continue;
            }
            if (
                !normalizePath(rel).split('/').includes('node_modules') &&
                realPathOrSelf(canonicalPackageRoot) === normalizePath(realPackageRoot)
            ) {
                continue;
            }
            const mirror = this.mirrorRootIn(canonicalPackageRoot);
            addRootDir(realPackageRoot);
            addRootDir(join(mirror, rel));
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

        // Raw Svelte dependencies need a package-specifier route to their generated twin.
        // rootDirs only participates after a relative resolution failure; it cannot rescue
        // `pkg/Component.svelte`, and package exports may deliberately hide package.json.
        for (const filePath of unique([
            ...this.findProjectSvelteFiles(),
            ...this.findDependencySvelteFiles(),
            ...this.batchMaterializedSvelteFiles
        ]).filter(needsSvelteShadow)) {
            const packageRoot = this.packageRootOf(filePath);
            const manifest = readPackageManifest(packageRoot);
            if (!manifest?.name) {
                continue;
            }
            const shadowPath = this.getShadowPath(filePath);
            // package.json `imports` is scoped to the importing package, while tsconfig `paths`
            // is one flat global table. Keep the wildcard entries as a fallback for arbitrary
            // imports, but give every materialised component an exact package-scoped spelling.
            // Exact keys win TypeScript's pattern selection, preventing a narrower alias from
            // another package (`#lib/*`) from hijacking a broader local alias (`#*`).
            for (const specifier of packageImportSpecifiersForSvelteFile(
                manifest,
                packageRoot,
                filePath
            )) {
                paths[specifier] = unique([shadowPath, ...(paths[specifier] ?? [])]);
            }
            for (const specifier of publicSpecifiersForSvelteFile(
                manifest,
                packageRoot,
                filePath
            )) {
                paths[specifier] = unique([shadowPath, ...(paths[specifier] ?? [])]);
                const suffix = this.batchSvelteSpecifierSuffixes.get(filePath);
                if (suffix && specifier.endsWith('.svelte')) {
                    const rewritten = `${specifier.slice(0, -SVELTE_SPECIFIER_LENGTH)}${suffix}`;
                    paths[rewritten] = unique([shadowPath, ...(paths[rewritten] ?? [])]);
                }
            }
        }

        // A mirrored app can still enter a linked/package dependency through its bare export.
        // Route every concrete entry observed by the source-graph walk to that entry's mirror;
        // relative imports and package-private `#` imports stay scoped by the mirror layout.
        for (const [specifier, original] of this.batchBareImportTargets) {
            const mirror = this.batchSourceMirrorByOriginal.get(original);
            if (mirror) {
                paths[specifier] = unique([mirror, ...(paths[specifier] ?? [])]);
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
            this.writeRequiredConfig(target, contents);
        } catch (e) {
            Logger.error('[tsgo] could not write the .ts-support config', e);
            throw e;
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
        const inferredProject = !ownTsconfig && this.options.writeConfig !== false;
        if (!ownTsconfig && !inferredProject) {
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
            if (ownTsconfig) {
                if (!nearest || normalizePath(nearest) !== ownTsconfig) {
                    continue;
                }
            } else if (nearest) {
                // An inferred manager's broad source-root scan can see both nested configured
                // projects and configured sibling workspaces. In either case that real project
                // owns the package and, potentially, an existing overlay. Never replace it with
                // an inferred extends pointer.
                continue;
            }

            try {
                const overlayDir = join(packageRoot, OVERLAY_DIR);
                const target = join(overlayDir, 'tsconfig.json');
                const contents = JSON.stringify({ extends: this.overlayTsconfigPath }, null, 4);
                fs.mkdirSync(overlayDir, { recursive: true });
                this.writeRequiredConfig(target, contents);
            } catch (e) {
                Logger.error(`[tsgo] could not write an extends shim for ${packageRoot}`, e);
                throw e;
            }
        }
    }

    /** Write and verify authoritative config bytes, avoiding no-op watcher invalidations. */
    private writeRequiredConfig(target: string, contents: string) {
        if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents) {
            fs.writeFileSync(target, contents);
        }
        if (fs.readFileSync(target, 'utf8') !== contents) {
            throw new Error(`configuration write was incomplete: ${target}`);
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

        // Dependencies count too. A library shipping a raw `.svelte` file needs its shadow in a
        // mirror of its own, and that mirror only takes part in resolution if it is a `rootDirs`
        // entry — which means discovering it before the config is written, not while shadows are
        // being materialised afterwards.
        for (const filePath of [
            ...this.findProjectSvelteFiles(),
            ...this.findDependencySvelteFiles()
        ]) {
            const owner = this.packageRootOf(filePath);
            // `packageRootOf` is bounded when walking workspace files, but dependency files can
            // legitimately live outside the source root in a pnpm store. Only accept an actual
            // manifest so an unrelated loose file cannot cause us to create an overlay beside it.
            if (readPackageManifest(owner)) {
                roots.add(owner);
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
        if (this.parsedBaseConfig) {
            return this.mapParsedBaseConfig(this.parsedBaseConfig);
        }
        const tsconfigPath = this.options.tsconfigPath;
        const fallback: ParsedBaseConfig = {
            rootDirs: [this.options.projectPath],
            rawFileNames: [],
            paths: {},
            pathsBasePath: undefined
        };
        if (!tsconfigPath) {
            this.parsedBaseConfig = fallback;
            return this.mapParsedBaseConfig(fallback);
        }
        try {
            this.batchConfigInputs.clear();
            this.batchRestoredSourceInputs.clear();
            const parseManifestInputs = new Set<string>();
            const parseDirectoryRoots = new Set<string>();
            const readConfigInput = (fileName: string) => {
                const normalized = normalizePath(fileName);
                if (basename(normalized).toLowerCase() === 'package.json') {
                    parseManifestInputs.add(normalized);
                } else {
                    this.batchConfigInputs.add(normalized);
                }
                return ts.sys.readFile(fileName);
            };
            const read = ts.readConfigFile(tsconfigPath, readConfigInput);
            if (read.error || !read.config) {
                throw new Error(
                    `${tsconfigPath}: ${ts.flattenDiagnosticMessageText(
                        read.error?.messageText ?? 'could not read configuration',
                        '\n'
                    )}`
                );
            }
            const parsed = ts.parseJsonConfigFileContent(
                read.config,
                {
                    ...ts.sys,
                    readFile: readConfigInput,
                    // Surface .svelte files so their *shadows* can stand in for them below;
                    // tsgo itself cannot parse a .svelte file.
                    readDirectory: (rootDir, extensions, excludes, includes, depth) => {
                        parseDirectoryRoots.add(normalizePath(rootDir));
                        return ts.sys.readDirectory(
                            rootDir,
                            [...(extensions ?? []), '.svelte'],
                            excludes,
                            includes,
                            depth
                        );
                    }
                },
                dirname(tsconfigPath)
            );
            this.batchCompilerOptions = parsed.options;
            this.batchConfigDirectory = dirname(tsconfigPath);
            this.baseConfigDiagnostics = parsed.errors;
            // Empty/solution configs are valid ownership boundaries for the editor and the
            // overlay adds its own shadow/shim roots. Keep every other parser diagnostic too,
            // but do not turn it into an adapter failure: the generated config still extends
            // the exact user config, so native tsgo remains the authority for TS7-only options
            // and reports them against that file. In particular, never inject or normalize a
            // module/moduleResolution option based on the JavaScript compiler's interpretation.
            const semanticConfigErrors = parsed.errors.filter(
                (error) => error.code !== 18002 && error.code !== 18003
            );
            if (semanticConfigErrors.length) {
                Logger.log(
                    `[tsgo] ${tsconfigPath} has ${semanticConfigErrors.length} configuration ` +
                        'diagnostic(s); preserving the exact config for native validation'
                );
            }

            const rootDirs = parsed.options.rootDirs?.length
                ? parsed.options.rootDirs.map((d) => normalizePath(d))
                : [this.options.projectPath];

            this.reachabilityCache = createReachabilityCache(parsed.options, dirname(tsconfigPath));
            for (const manifest of parseManifestInputs) {
                this.reachabilityCache.manifestInputs.add(manifest);
            }
            for (const directoryRoot of parseDirectoryRoots) {
                this.reachabilityCache.directoryRoots.add(directoryRoot);
            }
            const reachable = collectReachableProjectSvelteFiles(
                parsed.fileNames,
                parsed.options,
                dirname(tsconfigPath),
                this.sourceRoot,
                this.reachabilityCache
            );
            this.batchReachableSourceFiles = reachable.sourceFiles;
            this.batchReachableBareImports = reachable.bareImports;
            this.batchReachablePackageImports = reachable.packageImports;
            this.batchRootSourceFiles = reachable.rootSourceFiles;
            this.batchForwardSourceEdges = reachable.forwardEdges;
            this.batchReverseSourceEdges = reachable.reverseEdges;
            this.batchPackagePrivateSourceEdges = reachable.packagePrivateEdges;
            this.projectReachabilityFallbackReasons = reachable.fallbackReasons;
            const configuredSvelteRoots = parsed.fileNames.filter((file) =>
                file.endsWith('.svelte')
            );
            const reachableShadowSources = reachable.files.filter(needsSvelteShadow);
            this.projectSvelteFiles = unique(
                [
                    // Explicit/configured roots remain independently checkable Svelte sources
                    // even when an adjacent declaration means imports need no generated module.
                    ...configuredSvelteRoots,
                    // A declaration-backed source is still traversed as a graph/config input,
                    // but the declaration is TypeScript's authoritative program member. Do not
                    // promote an imported (or explicitly excluded) raw sibling into the checker.
                    ...reachableShadowSources,
                    ...(!reachable.complete
                        ? scanWorkspaceSvelteFiles(this.sourceRoot).filter(needsSvelteShadow)
                        : [])
                ].map((file) => this.canonicalSourcePath(file))
            );
            if (!reachable.complete) {
                Logger.log(
                    `[tsgo] import reachability was ambiguous for ${tsconfigPath}; ` +
                        `using the broad workspace Svelte fallback (${reachable.fallbackReasons.join(
                            ', '
                        )})`
                );
            }
            this.projectConfigParsed = true;

            const base: ParsedBaseConfig = {
                rootDirs,
                rawFileNames: parsed.fileNames.map(normalizePath),
                paths: (parsed.options.paths ?? {}) as Record<string, string[]>,
                pathsBasePath:
                    (parsed.options as any).pathsBasePath ?? parsed.options.baseUrl ?? undefined
            };
            this.parsedBaseConfig = base;
            return this.mapParsedBaseConfig(base);
        } catch (e) {
            Logger.error('[tsgo] could not parse the project tsconfig', e);
            throw e;
        }
    }

    /** Apply the current batch mirror map without reparsing or rewalking the source graph. */
    private mapParsedBaseConfig(base: ParsedBaseConfig): {
        rootDirs: string[];
        fileNames: string[];
        paths: Record<string, string[]>;
        pathsBasePath: string | undefined;
    } {
        // Substitute each .svelte entry with its shadow. tsgo cannot parse the real file, and
        // shadows must be explicit roots because they did not exist when the user's include was
        // expanded. Ordinary roots are remapped only after collision mirrors have been prepared.
        const fileNames = base.rawFileNames.flatMap((fileName) => {
            const normalized = normalizePath(fileName);
            if (normalized.endsWith('.svelte')) {
                // An adjacent arbitrary-extension declaration is already TypeScript's
                // authoritative route. Keep the source in projectSvelteFiles for the independent
                // Svelte/CSS pass, but never name a shadow we will not create.
                return needsSvelteShadow(normalized) ? [this.getShadowPath(normalized)] : [];
            }
            const kitShadow = this.writeKitShadow(normalized);
            if (kitShadow) {
                return [kitShadow];
            }
            return [
                this.batchSourceMirrorByOriginal.get(this.canonicalSourcePath(normalized)) ??
                    normalized
            ];
        });
        return {
            rootDirs: base.rootDirs,
            fileNames,
            paths: base.paths,
            pathsBasePath: base.pathsBasePath
        };
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
        if (this.options.tsconfigPath && !this.projectConfigParsed) {
            this.parseBaseConfig();
        }
        const dependencyRoots = this.dependencyRoots();
        for (const packageRoot of dependencyRoots) {
            this.reachabilityCache?.directoryRoots.add(normalizePath(packageRoot));
        }
        const cacheKey = `${normalizePath(this.packageRoot)}\0${this.dependencyScope!.mode}\0${dependencyRoots
            .slice()
            .sort()
            .join('\0')}`;
        const cached = sharedDependencySvelteFiles.get(cacheKey);
        if (cached) {
            this.dependencySvelteFileScan = unique(
                cached.map((file) => this.canonicalSourcePath(file))
            );
            return this.dependencySvelteFileScan;
        }

        const found = new Set<string>();
        const sourceRoot = normalizePath(this.sourceRoot);
        let workspaceFiles: string[] | undefined;
        for (const packageRoot of dependencyRoots) {
            // Linked workspace packages are already covered by the one registry-shared workspace
            // scan. Walking their trees again was the dominant dependency-index cost in large
            // monorepos (and, in Reintersect, revisited hundreds of component files per manager).
            if (
                (packageRoot === sourceRoot || packageRoot.startsWith(sourceRoot + '/')) &&
                !packageRoot.includes('/node_modules/')
            ) {
                workspaceFiles ??= this.findProjectSvelteFiles();
                for (const file of workspaceFiles) {
                    if (
                        (file === packageRoot || file.startsWith(packageRoot + '/')) &&
                        needsSvelteShadow(file)
                    ) {
                        found.add(this.canonicalSourcePath(file));
                    }
                }
                continue;
            }
            for (const file of scanDependencySvelteFiles(packageRoot)) {
                found.add(this.canonicalSourcePath(file));
            }
        }
        const result = [...found];
        sharedDependencySvelteFiles.set(cacheKey, result);
        this.dependencySvelteFileScan = result;
        return result;
    }

    /** Reachability-proven dependency closure, or the declared closure when proof is incomplete. */
    private dependencyRoots(): string[] {
        if (this.dependencyScope) {
            return this.dependencyScope.roots;
        }

        const fallbackReasons = new Set<string>();
        const directRoots = new Set<string>();
        if (!this.options.tsconfigPath || !this.projectConfigParsed) {
            fallbackReasons.add('project-reachability-unavailable');
        }
        for (const reason of this.projectReachabilityFallbackReasons) {
            fallbackReasons.add(reason);
        }

        if (!fallbackReasons.size) {
            for (const imported of this.batchReachablePackageImports) {
                // A tsconfig path/package-local alias has already been traversed as authored
                // source and is not evidence that an installed dependency must be indexed.
                const importerRoot = this.packageRootOf(imported.containingFile);
                const declared = manifestDeclaresDependency(
                    readPackageManifest(importerRoot),
                    imported.packageName
                );
                if (
                    imported.resolvedFile &&
                    !declared &&
                    !isExternalPackageRoot(
                        this.packageRootOf(imported.resolvedFile),
                        this.sourceRoot
                    )
                ) {
                    continue;
                }
                const dependencyRoot = resolveDependencyRoot(
                    imported.packageName,
                    importerRoot,
                    this.reachabilityCache
                );
                if (!dependencyRoot) {
                    fallbackReasons.add(
                        reachabilityReason(
                            'unresolved-reachable-package',
                            imported.containingFile,
                            imported.specifier
                        )
                    );
                    continue;
                }
                directRoots.add(dependencyRoot);
            }
        }

        if (!fallbackReasons.size) {
            const reachable = collectReachableDependencyRoots(
                [...directRoots],
                this.batchCompilerOptions,
                this.batchConfigDirectory,
                this.sourceRoot,
                this.reachabilityCache
            );
            for (const reason of reachable.fallbackReasons) {
                fallbackReasons.add(reason);
            }
            if (!fallbackReasons.size) {
                this.dependencyScope = {
                    mode: 'reachable',
                    roots: reachable.roots,
                    directImports: directRoots.size,
                    fallbackReasons: []
                };
                return this.dependencyScope.roots;
            }
        }

        const roots = collectDependencyRoots(this.packageRoot, this.reachabilityCache);
        // Proof failed, so package exports are no longer a trustworthy reachability boundary.
        // Scan the declared closure authoritatively instead of repeating the same narrow public
        // walk that produced the ambiguity.
        for (const root of roots) {
            markDependencyScanMode(root, 'broad');
        }
        this.dependencyScope = {
            mode: 'declared-fallback',
            roots,
            directImports: directRoots.size,
            fallbackReasons: [...fallbackReasons]
        };
        return this.dependencyScope.roots;
    }

    /**
     * The `.svelte` files the user's tsconfig actually pulls in — the set a whole-project check
     * is answerable for. Only meaningful once {@link writeOverlayTsconfig} has run, since that
     * is what resolves the base config.
     */
    getProjectSvelteFileNames(): string[] {
        if (this.options.tsconfigPath && !this.projectConfigParsed) {
            this.parseBaseConfig();
        }
        return this.projectSvelteFiles;
    }

    /** Configured Svelte roots whose adjacent declarations replace them in the native program. */
    getDeclarationBackedProjectSvelteFileNames(): string[] {
        if (!this.options.tsconfigPath) {
            return this.findProjectSvelteFiles().filter((file) => !needsSvelteShadow(file));
        }
        this.parseBaseConfig();
        // Reachability deliberately indexes raw declaration-backed sources as dependency/config
        // inputs, but that does not make an excluded source a configured checker root. Only the
        // user's actual raw `files`/`include` expansion belongs to the independent Svelte/CSS
        // pass; imports continue to use the adjacent `.d.svelte.ts` declaration exclusively.
        return (this.parsedBaseConfig?.rawFileNames ?? [])
            .filter((file) => file.endsWith('.svelte') && !needsSvelteShadow(file))
            .map((file) => this.canonicalSourcePath(file));
    }

    /** User-config diagnostics which an overlay's replacement `files` list can otherwise mask. */
    getBaseConfigDiagnostics(): readonly ts.Diagnostic[] {
        return this.baseConfigDiagnostics;
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
        const normalizedPath = normalizePath(filePath);
        const existing = this.kitShadows.get(normalizedPath);
        if (existing) {
            return existing.shadowPath;
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
            originalPath: normalizedPath,
            shadowPath,
            addedCode: result.addedCode
        };
        this.kitShadows.set(entry.originalPath, entry);
        this.kitShadowsByShadowPath.set(shadowPath, entry);
        this.registerReverseIndex?.(entry.shadowPath, entry.originalPath);
        return shadowPath;
    }

    /** Every `.svelte` file under the source root, which all need shadows. */
    findProjectSvelteFiles(): string[] {
        if (this.options.tsconfigPath && !this.projectConfigParsed) {
            this.parseBaseConfig();
        }
        // A configured project has an authoritative root set. Scanning the entire git workspace
        // here made opening one four-component fixture transform 1,114 unrelated components.
        // Dependencies/workspace packages reachable through its manifest are indexed separately;
        // the broad scan is reserved for a config-less project where reachability is unknown.
        if (this.options.tsconfigPath && this.projectConfigParsed) {
            return this.projectSvelteFiles;
        }
        // Prefer the registry-shared scan: the walk is over the workspace root, which is the
        // same directory for every manager, and re-walking it once per opened package is the
        // bulk of a first request's latency in a monorepo.
        if (this.options.workspaceSvelteFiles) {
            return unique(
                this.options.workspaceSvelteFiles().map((file) => this.canonicalSourcePath(file))
            );
        }
        // Memoised: the overlay config needs this list to work out which packages' subpath
        // imports to mirror, and the caller needs it again to write the shadows.
        if (this.projectSvelteFileScan) {
            return this.projectSvelteFileScan;
        }
        this.projectSvelteFileScan = unique(
            scanWorkspaceSvelteFiles(this.options.sourceRoot).map((file) =>
                this.canonicalSourcePath(file)
            )
        );
        return this.projectSvelteFileScan;
    }
}

/** Every raw `.svelte` source under a root, including declaration-backed diagnostic inputs. */
export function scanWorkspaceSvelteFiles(sourceRoot: string): string[] {
    const found: string[] = [];
    const normalizedSourceRoot = normalizePath(resolve(sourceRoot));
    // This is the correctness fallback used when the import/dependency graph cannot be proven.
    // Do not apply conventional source-tree guesses here: projects can intentionally keep
    // authored components below hidden, build or dist directories. Only dependency/VCS trees
    // and our own generated overlay are categorically outside the workspace source corpus.
    const excluded = new Set(['node_modules', '.git', '.hg', '.svn', '.svelte-ls-overlay']);
    const walk = (dir: string) => {
        // A workspace can contain nested clones or linked worktrees (for example an editor's
        // `.worktrees/foo` directory). They are separate source corpora even when the parent
        // directory itself is intentionally hidden, so do not silently add their components to
        // this project's broad correctness fallback. Explicit configured/dependency roots are
        // materialized before this fallback and therefore remain eligible.
        if (
            normalizePath(resolve(dir)) !== normalizedSourceRoot &&
            fs.existsSync(join(dir, '.git'))
        ) {
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
                if (!excluded.has(entry.name)) {
                    walk(full);
                }
            } else if (entry.name.endsWith('.svelte')) {
                found.push(normalizePath(full));
            }
        }
    };
    walk(normalizedSourceRoot);
    return found;
}

const MAX_REACHABLE_SOURCE_FILES = 10_000;

function createReachabilityCache(
    compilerOptions: ts.CompilerOptions,
    configDirectory: string
): ReachabilityCache {
    const normalizedConfigDirectory = normalizePath(configDirectory);
    const manifestInputs = new Set<string>();
    const trackManifest = (fileName: string) => {
        if (basename(fileName).toLowerCase() === 'package.json') {
            manifestInputs.add(normalizePath(fileName));
        }
    };
    const moduleResolutionHost: ts.ModuleResolutionHost = {
        ...ts.sys,
        fileExists: (fileName) => {
            trackManifest(fileName);
            return ts.sys.fileExists(fileName);
        },
        readFile: (fileName) => {
            trackManifest(fileName);
            return ts.sys.readFile(fileName);
        }
    };
    const optionsKey = contentStamp(
        JSON.stringify({
            configDirectory: normalizedConfigDirectory,
            compilerOptions: stableJsonValue(compilerOptions)
        })
    );
    return {
        optionsKey,
        configDirectory: normalizedConfigDirectory,
        moduleResolution: ts.createModuleResolutionCache(
            normalizedConfigDirectory,
            ts.sys.useCaseSensitiveFileNames ? (file) => file : (file) => file.toLowerCase(),
            compilerOptions
        ),
        typeReferenceResolution: ts.createTypeReferenceDirectiveResolutionCache(
            normalizedConfigDirectory,
            ts.sys.useCaseSensitiveFileNames ? (file) => file : (file) => file.toLowerCase(),
            compilerOptions
        ),
        moduleResolutionHost,
        sources: new Map(),
        sourceSignatures: new Map(),
        resolutions: new Map(),
        packageRoots: new Map(),
        manifestInputs,
        layoutInputs: new Set(),
        directoryRoots: new Set()
    };
}

function reachabilityStatKey(fileName: string): string {
    const stat = fs.statSync(fileName, { throwIfNoEntry: false });
    return stat
        ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        : 'missing';
}

/** Read/preprocess a source once per generation, while still detecting same-path rewrites. */
function analyzeReachabilitySource(
    fileName: string,
    cache: ReachabilityCache | undefined,
    providedText?: string
): ReachabilitySourceAnalysis {
    const normalized = normalizePath(fileName);
    const statKey = reachabilityStatKey(normalized);
    const cached = cache?.sources.get(normalized);
    if (providedText === undefined && cached?.statKey === statKey) {
        return cached;
    }

    const text = providedText ?? fs.readFileSync(normalized, 'utf8');
    const contentKey = contentStamp(text);
    if (cached?.contentKey === contentKey) {
        const refreshed = { ...cached, statKey };
        cache?.sources.set(normalized, refreshed);
        return refreshed;
    }

    const globs = collectImportMetaGlobArguments(text);
    const preprocessed = ts.preProcessFile(text, true, true);
    const analysis: ReachabilitySourceAnalysis = {
        statKey,
        contentKey,
        graphKey: batchGraphSourceSignature(text, preprocessed, globs),
        text,
        preprocessed,
        literalGlobPatterns: globs.literal,
        computedGlobCount: globs.computed
    };
    cache?.sources.set(normalized, analysis);
    cache?.sourceSignatures.set(normalized, analysis.graphKey);
    return analysis;
}

/**
 * Recompute only the syntax that can change project reachability. External graph caches use this
 * after a source's stat identity changes, avoiding invalidation for body/type-only edits.
 */
export function computeBatchGraphSourceSignature(text: string): string {
    const globs = collectImportMetaGlobArguments(text);
    return batchGraphSourceSignature(text, ts.preProcessFile(text, true, true), globs);
}

function batchGraphSourceSignature(
    text: string,
    preprocessed: ts.PreProcessedFileInfo,
    globs: { literal: string[][]; computed: number }
): string {
    const ambiguous =
        /\bimport\s*\(\s*(?!['"`])\S/.test(text) ||
        /\bimport\s*\(\s*`[^`]*\$\{/.test(text) ||
        /\brequire\s*\(\s*(?!['"`])\S/.test(text) ||
        /\brequire\s*\(\s*`[^`]*\$\{/.test(text) ||
        globs.computed > 0;
    const publicExports = collectPublicExportEdges('__batch_graph_source.ts', text);
    return sha256(
        JSON.stringify({
            imports: preprocessed.importedFiles.map((entry) => entry.fileName),
            references: preprocessed.referencedFiles.map((entry) => entry.fileName),
            typeReferences: preprocessed.typeReferenceDirectives.map((entry) => entry.fileName),
            literalGlobs: globs.literal,
            ambiguous,
            publicExports: publicExports.specifiers.slice().sort(),
            computedPublicExport: publicExports.computed
        })
    );
}

/** Parse the first glob argument through TypeScript so comments/escapes and literal arrays work. */
function collectImportMetaGlobArguments(text: string): {
    literal: string[][];
    computed: number;
} {
    const literal: string[][] = [];
    let computed = 0;
    const call = /\bimport\s*\.\s*meta\s*\.\s*glob(?:Eager)?(?:\s*<[^;()]*>)?\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = call.exec(text))) {
        const openParen = call.lastIndex - 1;
        const parsed = ts.createSourceFile(
            '__svelte_import_meta_glob.ts',
            `const __patterns = ${text.slice(openParen + 1)}`,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );
        const statement = parsed.statements[0];
        const initializer =
            statement && ts.isVariableStatement(statement)
                ? statement.declarationList.declarations[0]?.initializer
                : undefined;
        if (initializer && ts.isStringLiteralLike(initializer)) {
            literal.push([initializer.text]);
            continue;
        }
        if (
            initializer &&
            ts.isArrayLiteralExpression(initializer) &&
            initializer.elements.every(ts.isStringLiteralLike)
        ) {
            literal.push(
                initializer.elements.map((element) => (element as ts.StringLiteralLike).text)
            );
            continue;
        }
        computed++;
    }
    return { literal, computed };
}

function importMetaGlobBase(
    rawPattern: string,
    containingFile: string,
    configDirectory: string
): { base: string; pattern: string } | undefined {
    const pattern = rawPattern.replace(/^!/, '');
    if (pattern.startsWith('./') || pattern.startsWith('../')) {
        return { base: normalizePath(dirname(containingFile)), pattern };
    }
    if (pattern.startsWith('/')) {
        // Vite root-absolute glob patterns are rooted at the project/config directory.
        return { base: normalizePath(configDirectory), pattern: `.${pattern}` };
    }
    return undefined;
}

function expandLiteralImportMetaGlob(
    patterns: string[],
    containingFile: string,
    configDirectory: string,
    cache?: ReachabilityCache
): { files: string[]; unsupportedPatterns: string[] } {
    const included = new Set<string>();
    const excluded = new Set<string>();
    const unsupportedPatterns: string[] = [];
    for (const rawPattern of patterns) {
        const target = importMetaGlobBase(rawPattern, containingFile, configDirectory);
        if (!target) {
            unsupportedPatterns.push(rawPattern);
            continue;
        }
        cache?.directoryRoots.add(target.base);
        const matches = ts.sys
            .readDirectory(target.base, undefined, undefined, [target.pattern])
            .map(normalizePath);
        const destination = rawPattern.startsWith('!') ? excluded : included;
        for (const file of matches) {
            destination.add(file);
        }
    }
    for (const file of excluded) {
        included.delete(file);
    }
    return { files: [...included], unsupportedPatterns };
}

function reachabilityReason(kind: string, fileName: string, detail?: string): string {
    return `${kind}:${normalizePath(fileName)}${detail === undefined ? '' : `:${detail}`}`;
}

function rawSvelteSourceForDeclaration(fileName: string): string | undefined {
    if (!fileName.endsWith('.d.svelte.ts')) {
        return undefined;
    }
    const source = fileName.slice(0, -'.d.svelte.ts'.length) + '.svelte';
    return fs.statSync(source, { throwIfNoEntry: false })?.isFile()
        ? normalizePath(source)
        : undefined;
}

function packageNameFromSpecifier(specifier: string): string | undefined {
    if (
        isRelativeModuleSpecifier(specifier) ||
        specifier.startsWith('/') ||
        specifier.startsWith('#') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('$') ||
        specifier.includes(':')
    ) {
        return undefined;
    }
    const parts = specifier.split('/');
    const packageName =
        specifier.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    return NODE_BUILTIN_MODULES.has(packageName) ? undefined : packageName;
}

function isRelativeModuleSpecifier(specifier: string): boolean {
    return (
        specifier === '.' ||
        specifier === '..' ||
        specifier.startsWith('./') ||
        specifier.startsWith('../')
    );
}

function addSourceGraphEdge(
    forward: Map<string, Set<string>>,
    reverse: Map<string, Set<string>>,
    from: string,
    to: string
) {
    let targets = forward.get(from);
    if (!targets) {
        forward.set(from, (targets = new Set()));
    }
    targets.add(to);
    let importers = reverse.get(to);
    if (!importers) {
        reverse.set(to, (importers = new Set()));
    }
    importers.add(from);
}

function collectReverseSourceClosure(
    seeds: Iterable<string>,
    reverseEdges: Map<string, Set<string>>
): Set<string> {
    const closure = new Set<string>();
    const queue = [...seeds];
    let cursor = 0;
    while (cursor < queue.length) {
        const fileName = queue[cursor++]!;
        if (closure.has(fileName)) {
            continue;
        }
        closure.add(fileName);
        for (const importer of reverseEdges.get(fileName) ?? []) {
            queue.push(importer);
        }
    }
    return closure;
}

function collectForwardSourceClosure(
    seeds: Iterable<string>,
    forwardEdges: Map<string, Set<string>>
): Set<string> {
    const closure = new Set<string>();
    const queue = [...seeds];
    let cursor = 0;
    while (cursor < queue.length) {
        const fileName = queue[cursor++]!;
        if (closure.has(fileName)) {
            continue;
        }
        closure.add(fileName);
        for (const target of forwardEdges.get(fileName) ?? []) {
            queue.push(target);
        }
    }
    return closure;
}

/**
 * Traverse the literal import/re-export graph rooted by the user's parsed config. This includes
 * same-package files outside `include`, TS barrels, package.json `imports`, literal Vite globs
 * and `paths` aliases without paying for an unrelated workspace-wide transform. Only genuinely
 * computed or unresolved Svelte-bearing edges make the result incomplete.
 */
function collectReachableProjectSvelteFiles(
    rootFiles: string[],
    compilerOptions: ts.CompilerOptions,
    configDirectory: string,
    sourceRoot: string,
    cache: ReachabilityCache
): {
    files: string[];
    sourceFiles: string[];
    bareImports: Map<string, string>;
    packageImports: ReachableBarePackageImport[];
    rootSourceFiles: Set<string>;
    forwardEdges: Map<string, Set<string>>;
    reverseEdges: Map<string, Set<string>>;
    packagePrivateEdges: Map<string, Set<string>>;
    complete: boolean;
    fallbackReasons: string[];
} {
    const queue = rootFiles.map(normalizePath);
    let cursor = 0;
    const seen = new Set<string>();
    const svelteFiles = new Set<string>();
    const sourceFiles = new Set<string>();
    const bareImports = new Map<string, string>();
    const packageImports: ReachableBarePackageImport[] = [];
    const ambiguousBareImports = new Set<string>();
    const normalizedSourceRoot = normalizePath(sourceRoot);
    const rootSourceFiles = new Set(
        rootFiles.map((file) => canonicalSourcePath(normalizePath(file), normalizedSourceRoot))
    );
    const forwardEdges = new Map<string, Set<string>>();
    const reverseEdges = new Map<string, Set<string>>();
    const packagePrivateEdges = new Map<string, Set<string>>();
    const fallbackReasons = new Set<string>();
    const recordDirectiveTarget = (
        containingFile: string,
        resolvedFile: string,
        traverseExternal: boolean
    ) => {
        const canonical = canonicalSourcePath(resolvedFile, normalizedSourceRoot);
        addSourceGraphEdge(forwardEdges, reverseEdges, containingFile, canonical);
        if (canonical.endsWith('.svelte')) {
            svelteFiles.add(canonical);
            queue.push(canonical);
            return;
        }
        const declarationSource = rawSvelteSourceForDeclaration(canonical);
        if (declarationSource) {
            svelteFiles.add(declarationSource);
            queue.push(declarationSource);
        }
        if (
            SCRIPT_SOURCE_RE.test(canonical) &&
            (traverseExternal ||
                (!canonical.includes('/node_modules/') &&
                    canonical.startsWith(normalizedSourceRoot + '/')))
        ) {
            queue.push(canonical);
        }
    };

    while (cursor < queue.length && seen.size < MAX_REACHABLE_SOURCE_FILES) {
        const fileName = canonicalSourcePath(queue[cursor++]!, normalizedSourceRoot);
        if (seen.has(fileName)) {
            continue;
        }
        seen.add(fileName);
        if (fileName.endsWith('.svelte') && needsSvelteShadow(fileName)) {
            svelteFiles.add(fileName);
        } else if (SCRIPT_SOURCE_RE.test(fileName)) {
            sourceFiles.add(fileName);
        }

        let analysis: ReachabilitySourceAnalysis;
        try {
            analysis = analyzeReachabilitySource(fileName, cache);
        } catch {
            fallbackReasons.add(reachabilityReason('unreadable-source', fileName));
            continue;
        }

        if (
            /\bimport\s*\(\s*(?!['"`])\S/.test(analysis.text) ||
            /\bimport\s*\(\s*`[^`]*\$\{/.test(analysis.text)
        ) {
            fallbackReasons.add(reachabilityReason('computed-import', fileName));
        }
        if (
            /\brequire\s*\(\s*(?!['"`])\S/.test(analysis.text) ||
            /\brequire\s*\(\s*`[^`]*\$\{/.test(analysis.text)
        ) {
            fallbackReasons.add(reachabilityReason('computed-require', fileName));
        }
        if (analysis.computedGlobCount) {
            fallbackReasons.add(reachabilityReason('computed-import-meta-glob', fileName));
        }
        for (const patterns of analysis.literalGlobPatterns) {
            const expanded = expandLiteralImportMetaGlob(
                patterns,
                fileName,
                configDirectory,
                cache
            );
            for (const pattern of expanded.unsupportedPatterns) {
                fallbackReasons.add(
                    reachabilityReason('unsupported-import-meta-glob', fileName, pattern)
                );
            }
            for (const globFile of expanded.files) {
                if (globFile.endsWith('.svelte') || SCRIPT_SOURCE_RE.test(globFile)) {
                    const canonicalGlob = canonicalSourcePath(globFile, normalizedSourceRoot);
                    addSourceGraphEdge(forwardEdges, reverseEdges, fileName, canonicalGlob);
                    queue.push(canonicalGlob);
                }
            }
        }

        for (const reference of analysis.preprocessed.referencedFiles) {
            const resolved = resolveReachablePathReference(reference, fileName, cache);
            if (!resolved) {
                fallbackReasons.add(
                    reachabilityReason('unresolved-reference', fileName, reference.fileName)
                );
                continue;
            }
            // An explicit path reference is an authoritative source edge even when it enters a
            // package-private declaration below node_modules; keep its bounded reference chain.
            recordDirectiveTarget(fileName, resolved, true);
        }
        for (const reference of analysis.preprocessed.typeReferenceDirectives) {
            const resolved = resolveReachableTypeReference(
                reference,
                fileName,
                compilerOptions,
                cache
            );
            if (!resolved) {
                // Missing ambient packages cannot contribute present workspace Svelte sources.
                // The resolver persists exact absent type-root probes so a later install still
                // invalidates the graph without forcing a broad scan for common optional types.
                continue;
            }
            // TypeScript resolves ambient packages itself. Traverse only a workspace-owned
            // declaration root here; crawling @types/node and friends is both redundant and an
            // easy way to turn one directive into the whole dependency tree.
            recordDirectiveTarget(fileName, resolved, false);
        }

        const imports = analysis.preprocessed.importedFiles.map((entry) => entry.fileName);
        for (const specifier of imports) {
            const resolvedImport = resolveReachableImport(
                specifier,
                fileName,
                compilerOptions,
                configDirectory,
                cache
            );
            const resolved = resolvedImport
                ? canonicalSourcePath(resolvedImport, normalizedSourceRoot)
                : undefined;
            const packageName = packageNameFromSpecifier(specifier);
            if (packageName) {
                packageImports.push({
                    specifier,
                    packageName,
                    containingFile: fileName,
                    resolvedFile: resolved
                });
            }
            if (!resolved) {
                if (specifier.endsWith('.svelte') || specifier.startsWith('#')) {
                    fallbackReasons.add(
                        reachabilityReason('unresolved-svelte-import', fileName, specifier)
                    );
                }
                continue;
            }
            addSourceGraphEdge(forwardEdges, reverseEdges, fileName, resolved);
            if (specifier.startsWith('#')) {
                let targets = packagePrivateEdges.get(fileName);
                if (!targets) {
                    packagePrivateEdges.set(fileName, (targets = new Set()));
                }
                targets.add(resolved);
            }
            if (
                !isRelativeModuleSpecifier(specifier) &&
                !isAbsolute(specifier) &&
                !specifier.startsWith('#')
            ) {
                const previous = bareImports.get(specifier);
                if (previous && previous !== resolved) {
                    ambiguousBareImports.add(specifier);
                    bareImports.delete(specifier);
                } else if (!ambiguousBareImports.has(specifier)) {
                    bareImports.set(specifier, resolved);
                }
            }
            if (resolved.endsWith('.svelte')) {
                // Keep declaration-backed sources in the reachable graph so their imports,
                // config and transform identity remain observable. parseBaseConfig decides
                // separately whether the raw source belongs to the checker diagnostic corpus.
                svelteFiles.add(resolved);
                queue.push(resolved);
                continue;
            }
            const declarationSource = rawSvelteSourceForDeclaration(resolved);
            if (declarationSource) {
                svelteFiles.add(declarationSource);
                queue.push(declarationSource);
            }
            // Dependency public surfaces are indexed from manifests separately. Traverse source
            // and workspace barrels, including an explicit rootDir outside the workspace, but do
            // not recursively crawl an arbitrary node_modules implementation graph.
            if (
                !resolved.includes('/node_modules/') &&
                (/\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/.test(resolved) ||
                    resolved.startsWith(normalizedSourceRoot + '/'))
            ) {
                queue.push(resolved);
            }
        }
    }
    if (cursor < queue.length) {
        fallbackReasons.add(`source-graph-limit:${MAX_REACHABLE_SOURCE_FILES}`);
    }
    return {
        files: [...svelteFiles],
        sourceFiles: [...sourceFiles],
        bareImports,
        packageImports,
        rootSourceFiles,
        forwardEdges,
        reverseEdges,
        packagePrivateEdges,
        complete: fallbackReasons.size === 0,
        fallbackReasons: [...fallbackReasons]
    };
}

function resolveReachableImport(
    specifier: string,
    containingFile: string,
    compilerOptions: ts.CompilerOptions,
    configDirectory: string,
    cache?: ReachabilityCache
): string | undefined {
    containingFile = normalizePath(containingFile);
    const resolutionKey = `${cache?.optionsKey ?? ''}\0${containingFile}\0${specifier}`;
    const cached = cache?.resolutions.get(resolutionKey);
    if (cached !== undefined) {
        return cached ?? undefined;
    }
    const rememberResolved = (fileName: string): string => {
        const normalized = normalizePath(fileName);
        cache?.layoutInputs.add(normalized);
        try {
            cache?.layoutInputs.add(normalizePath(fs.realpathSync(normalized)));
        } catch {
            // The lexical result remains the validation input if it disappears concurrently.
        }
        cache?.resolutions.set(resolutionKey, normalized);
        return normalized;
    };

    const candidates: string[] = [];
    if (specifier.startsWith('#')) {
        candidates.push(...packageImportPathCandidates(specifier, containingFile, cache));
    } else if (packageNameFromSpecifier(specifier)) {
        candidates.push(...packageExportPathCandidates(specifier, containingFile, cache));
    }
    if (isRelativeModuleSpecifier(specifier) || isAbsolute(specifier)) {
        candidates.push(
            isAbsolute(specifier)
                ? normalizePath(specifier)
                : normalizePath(resolve(dirname(containingFile), specifier))
        );
    } else {
        const pathsBase = normalizePath(
            (compilerOptions as any).pathsBasePath ?? compilerOptions.baseUrl ?? configDirectory
        );
        for (const [pattern, targets] of Object.entries(compilerOptions.paths ?? {})) {
            const match = matchPathPattern(pattern, specifier);
            if (match === undefined) {
                continue;
            }
            for (const target of targets) {
                candidates.push(normalizePath(resolve(pathsBase, target.replace('*', match))));
            }
        }
    }

    for (const candidate of candidates) {
        const resolved = resolveReachableFile(candidate);
        if (resolved) {
            return rememberResolved(resolved);
        }
    }

    const resolved = ts.resolveModuleName(
        specifier,
        containingFile,
        compilerOptions,
        cache?.moduleResolutionHost ?? ts.sys,
        cache?.moduleResolution
    ).resolvedModule?.resolvedFileName;
    const normalized = resolved ? normalizePath(resolved) : undefined;
    if (normalized) {
        return rememberResolved(normalized);
    }
    cache?.resolutions.set(resolutionKey, null);
    return undefined;
}

/** Resolve a triple-slash `path` directive using its file-relative, not module, semantics. */
function resolveReachablePathReference(
    reference: ts.FileReference,
    containingFile: string,
    cache?: ReachabilityCache
): string | undefined {
    containingFile = normalizePath(containingFile);
    const key = `${cache?.optionsKey ?? ''}\0reference-path\0${containingFile}\0${reference.fileName}`;
    const cached = cache?.resolutions.get(key);
    if (cached !== undefined) {
        return cached ?? undefined;
    }
    const candidate = isAbsolute(reference.fileName)
        ? normalizePath(reference.fileName)
        : normalizePath(resolve(dirname(containingFile), reference.fileName));
    for (const probe of reachableFileCandidates(candidate)) {
        cache?.layoutInputs.add(normalizePath(probe));
    }
    const resolved = resolveReachableFile(candidate);
    if (!resolved) {
        cache?.resolutions.set(key, null);
        return undefined;
    }
    cache?.layoutInputs.add(resolved);
    try {
        cache?.layoutInputs.add(normalizePath(fs.realpathSync(resolved)));
    } catch {
        // The lexical file remains exact validation evidence if it disappears concurrently.
    }
    cache?.resolutions.set(key, resolved);
    return resolved;
}

/** Resolve a triple-slash `types` directive through TypeScript's configured type roots. */
function resolveReachableTypeReference(
    reference: ts.FileReference,
    containingFile: string,
    compilerOptions: ts.CompilerOptions,
    cache?: ReachabilityCache
): string | undefined {
    containingFile = normalizePath(containingFile);
    const key = `${cache?.optionsKey ?? ''}\0reference-types\0${containingFile}\0${reference.fileName}\0${reference.resolutionMode ?? ''}`;
    const cached = cache?.resolutions.get(key);
    if (cached !== undefined) {
        return cached ?? undefined;
    }
    const resolved = ts.resolveTypeReferenceDirective(
        reference.fileName,
        containingFile,
        compilerOptions,
        cache?.moduleResolutionHost ?? ts.sys,
        undefined,
        cache?.typeReferenceResolution,
        reference.resolutionMode
    ).resolvedTypeReferenceDirective?.resolvedFileName;
    if (!resolved) {
        const typePackageName = reference.fileName.startsWith('@')
            ? reference.fileName.slice(1).replace('/', '__')
            : reference.fileName;
        for (const typeRoot of ts.getEffectiveTypeRoots(compilerOptions, {
            getCurrentDirectory: () => dirname(containingFile)
        }) ?? []) {
            const absoluteRoot = normalizePath(
                isAbsolute(typeRoot)
                    ? typeRoot
                    : resolve(cache?.configDirectory ?? dirname(containingFile), typeRoot)
            );
            const packageRoot = normalizePath(join(absoluteRoot, typePackageName));
            cache?.layoutInputs.add(packageRoot);
            cache?.layoutInputs.add(normalizePath(join(packageRoot, 'index.d.ts')));
            cache?.manifestInputs.add(normalizePath(join(packageRoot, 'package.json')));
        }
        cache?.resolutions.set(key, null);
        return undefined;
    }
    const normalized = normalizePath(resolved);
    cache?.layoutInputs.add(normalized);
    try {
        cache?.layoutInputs.add(normalizePath(fs.realpathSync(normalized)));
    } catch {
        // The lexical file remains exact validation evidence if it disappears concurrently.
    }
    cache?.resolutions.set(key, normalized);
    return normalized;
}

/** Resolve the nearest package scope's private imports without requiring TS to parse `.svelte`. */
function packageImportPathCandidates(
    specifier: string,
    containingFile: string,
    cache?: ReachabilityCache
): string[] {
    const packageRoot = nearestPackageRootForReachability(containingFile, cache);
    if (!packageRoot) {
        return [];
    }
    const imports = readPackageManifest(packageRoot)?.imports;
    if (!imports || typeof imports !== 'object' || Array.isArray(imports)) {
        return [];
    }

    const selected = selectPackageMapEntry(imports as Record<string, unknown>, specifier);
    if (!selected) {
        return [];
    }

    const wildcard = matchPathPattern(selected[0], specifier) ?? '';
    return (
        stringTargets(selected[1])
            .map((target) => target.replace(/\*/g, wildcard))
            // Reachability wants the authored source when both a Svelte/default condition and a
            // modern declaration condition exist. The declaration remains native TS's authority.
            .sort(
                (left, right) =>
                    packageImportTargetPriority(left) - packageImportTargetPriority(right)
            )
            .filter((target) => target.startsWith('./'))
            .map((target) => normalizePath(resolve(packageRoot, target)))
    );
}

function nearestPackageRootForReachability(
    containingFile: string,
    cache?: ReachabilityCache
): string | undefined {
    const containingDirectory = normalizePath(dirname(containingFile));
    let packageRoot = cache?.packageRoots.get(containingDirectory);
    if (packageRoot === undefined) {
        packageRoot = containingDirectory;
        for (;;) {
            const manifestPath = normalizePath(join(packageRoot, 'package.json'));
            cache?.manifestInputs.add(manifestPath);
            if (fs.existsSync(manifestPath)) {
                break;
            }
            const parent = dirname(packageRoot);
            if (parent === packageRoot) {
                packageRoot = null;
                break;
            }
            packageRoot = parent;
        }
        cache?.packageRoots.set(containingDirectory, packageRoot);
    }
    return packageRoot ?? undefined;
}

function selectPackageMapEntry(
    mappings: Record<string, unknown>,
    specifier: string
): [string, unknown] | undefined {
    const entries = Object.entries(mappings);
    return (
        entries.find(([pattern]) => pattern === specifier) ??
        entries
            .map(([pattern, value]) => ({
                pattern,
                value,
                match: matchPathPattern(pattern, specifier)
            }))
            .filter((entry) => entry.match !== undefined && entry.pattern.includes('*'))
            .sort(
                (left, right) =>
                    right.pattern.replace('*', '').length - left.pattern.replace('*', '').length
            )
            .map(({ pattern, value }) => [pattern, value] as [string, unknown])[0]
    );
}

/** Resolve raw Svelte package exports without requiring package.json to be exported. */
function packageExportPathCandidates(
    specifier: string,
    containingFile: string,
    cache?: ReachabilityCache
): string[] {
    const packageName = packageNameFromSpecifier(specifier);
    const importerRoot = nearestPackageRootForReachability(containingFile, cache);
    if (!packageName || !importerRoot) {
        return [];
    }
    const packageRoot = resolveDependencyRoot(packageName, importerRoot, cache);
    const manifest = packageRoot ? readPackageManifest(packageRoot) : undefined;
    if (!packageRoot || !manifest) {
        return [];
    }
    const subpath =
        specifier === packageName ? '.' : `./${specifier.slice(packageName.length + 1)}`;
    let selected: [string, unknown] | undefined;
    if (manifest.exports !== undefined) {
        const exportsMap =
            manifest.exports &&
            typeof manifest.exports === 'object' &&
            !Array.isArray(manifest.exports) &&
            Object.keys(manifest.exports).some((key) => key.startsWith('.'))
                ? (manifest.exports as Record<string, unknown>)
                : ({ '.': manifest.exports } as Record<string, unknown>);
        selected = selectPackageMapEntry(exportsMap, subpath);
    } else if (subpath === '.') {
        selected = [
            '.',
            [manifest.svelte, manifest.types, manifest.typings, manifest.module, manifest.main]
        ];
    } else {
        selected = [subpath, subpath];
    }
    if (!selected) {
        return [];
    }
    const wildcard = matchPathPattern(selected[0], subpath) ?? '';
    return stringTargets(selected[1])
        .filter((target) => target.startsWith('./'))
        .map((target) => target.replace(/\*/g, wildcard))
        .sort(
            (left, right) => packageImportTargetPriority(left) - packageImportTargetPriority(right)
        )
        .map((target) => normalizePath(resolve(packageRoot, target)));
}

function packageImportTargetPriority(target: string): number {
    return target.endsWith('.svelte') ? 0 : target.endsWith('.d.svelte.ts') ? 1 : 2;
}

function matchPathPattern(pattern: string, specifier: string): string | undefined {
    const wildcard = pattern.indexOf('*');
    if (wildcard < 0) {
        return pattern === specifier ? '' : undefined;
    }
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    return specifier.startsWith(prefix) && specifier.endsWith(suffix)
        ? specifier.slice(prefix.length, specifier.length - suffix.length)
        : undefined;
}

function resolveReachableFile(candidate: string): string | undefined {
    for (const file of reachableFileCandidates(candidate)) {
        try {
            if (fs.statSync(file).isFile()) {
                return normalizePath(file);
            }
        } catch {
            // Try the next extension/index candidate.
        }
    }
    return undefined;
}

function reachableFileCandidates(candidate: string): string[] {
    return unique([
        candidate,
        ...(candidate.endsWith('.svelte')
            ? [candidate.slice(0, -'.svelte'.length) + '.d.svelte.ts']
            : []),
        ...(candidate.endsWith('.js')
            ? [
                  candidate.slice(0, -'.js'.length) + '.ts',
                  candidate.slice(0, -'.js'.length) + '.tsx',
                  candidate.slice(0, -'.js'.length) + '.d.ts'
              ]
            : candidate.endsWith('.mjs')
              ? [
                    candidate.slice(0, -'.mjs'.length) + '.mts',
                    candidate.slice(0, -'.mjs'.length) + '.d.mts'
                ]
              : candidate.endsWith('.cjs')
                ? [
                      candidate.slice(0, -'.cjs'.length) + '.cts',
                      candidate.slice(0, -'.cjs'.length) + '.d.cts'
                  ]
                : []),
        ...(!/\.[^/]+$/.test(candidate)
            ? [
                  `${candidate}.ts`,
                  `${candidate}.tsx`,
                  `${candidate}.js`,
                  `${candidate}.jsx`,
                  `${candidate}.mts`,
                  `${candidate}.cts`,
                  `${candidate}.mjs`,
                  `${candidate}.cjs`,
                  `${candidate}.svelte`,
                  `${candidate}.d.svelte.ts`,
                  join(candidate, 'index.ts'),
                  join(candidate, 'index.tsx'),
                  join(candidate, 'index.js'),
                  join(candidate, 'index.svelte')
              ]
            : [])
    ]);
}

/**
 * Record a missing relative public target as exact topology evidence. If no supported candidate
 * exists, broad dependency scanning cannot discover anything more today; a later create changes
 * one of these allow-missing layout inputs and invalidates the plan. If a candidate does exist
 * but normal resolution missed it, retain the conservative fallback.
 */
function trackUnresolvedRelativePublicEdge(
    specifier: string,
    containingFile: string,
    cache?: ReachabilityCache
): boolean {
    const candidate = normalizePath(resolve(dirname(containingFile), specifier));
    const probes = reachableFileCandidates(candidate);
    for (const probe of probes) {
        cache?.layoutInputs.add(normalizePath(probe));
    }
    return probes.some((probe) => fs.statSync(probe, { throwIfNoEntry: false })?.isFile());
}

/** JSON modules directly imported by the mirrored module graph. */
function collectResolvedJsonAssets(
    sourceFiles: Iterable<string>,
    compilerOptions: ts.CompilerOptions,
    configDirectory: string,
    sourceRoot: string,
    cache?: ReachabilityCache
): string[] {
    const assets = new Set<string>();
    const normalizedSourceRoot = normalizePath(sourceRoot);
    for (const sourceFile of unique([...sourceFiles].map(normalizePath))) {
        let analysis: ReachabilitySourceAnalysis;
        try {
            analysis = analyzeReachabilitySource(sourceFile, cache);
        } catch {
            continue;
        }
        for (const imported of analysis.preprocessed.importedFiles) {
            const resolved = resolveReachableImport(
                imported.fileName,
                sourceFile,
                compilerOptions,
                configDirectory,
                cache
            );
            if (!resolved || !JSON_MODULE_RE.test(resolved)) {
                continue;
            }
            const canonical = canonicalSourcePath(resolved, normalizedSourceRoot);
            if (fs.statSync(canonical, { throwIfNoEntry: false })?.isFile()) {
                assets.add(canonical);
            }
        }
    }
    return [...assets];
}

/** Stable identity for every input which can change equal-length module rewrites. */
function batchRewriteIdentity(input: {
    suffixes: Map<string, string>;
    configDirectory: string;
    compilerOptions: ts.CompilerOptions;
    materializedSvelteFiles: Set<string>;
    privateImports: Map<string, string>;
    publicImports: Map<string, string>;
    mirrors: Map<string, string>;
}): string {
    const optionKeys: Array<keyof ts.CompilerOptions | 'pathsBasePath'> = [
        'allowArbitraryExtensions',
        'baseUrl',
        'customConditions',
        'module',
        'moduleResolution',
        'moduleSuffixes',
        'paths',
        'pathsBasePath',
        'preserveSymlinks',
        'resolveJsonModule',
        'rootDirs',
        'typeRoots',
        'types'
    ];
    const options = Object.fromEntries(
        optionKeys
            .filter((key) => (input.compilerOptions as any)[key] !== undefined)
            .map((key) => [key, stableJsonValue((input.compilerOptions as any)[key])])
    );
    const mapEntries = (map: Map<string, string>) =>
        [...map].sort(([left], [right]) => left.localeCompare(right));
    return contentStamp(
        JSON.stringify({
            suffixes: mapEntries(input.suffixes),
            configDirectory: normalizePath(input.configDirectory),
            options,
            materializedSvelteFiles: [...input.materializedSvelteFiles].sort(),
            privateImports: mapEntries(input.privateImports),
            publicImports: mapEntries(input.publicImports),
            mirrors: mapEntries(input.mirrors)
        })
    );
}

function stableJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stableJsonValue);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, entry]) => [key, stableJsonValue(entry)])
        );
    }
    return value;
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function sortedUnique(values: Iterable<string>): string[] {
    return unique([...values].map(normalizePath)).sort((left, right) => left.localeCompare(right));
}

function sortedMapEntries(map: Map<string, string>): Array<[string, string]> {
    return [...map]
        .map(([key, value]) => [key, normalizePath(value)] as [string, string])
        .sort(([left], [right]) => left.localeCompare(right));
}

function sortedSetMapEntries(map: Map<string, Set<string>>): Array<[string, string[]]> {
    return [...map]
        .map(([key, values]) => [normalizePath(key), sortedUnique(values)] as [string, string[]])
        .sort(([left], [right]) => left.localeCompare(right));
}

function restoreSetMap(entries: Array<[string, string[]]>): Map<string, Set<string>> {
    return new Map(entries.map(([key, values]) => [key, new Set(values)]));
}

function serializeBatchGraphMessageChain(
    chain: ts.DiagnosticMessageChain
): BatchGraphDiagnosticMessageChain {
    return {
        messageText: chain.messageText,
        category: chain.category,
        code: chain.code,
        ...(chain.next?.length ? { next: chain.next.map(serializeBatchGraphMessageChain) } : {})
    };
}

function serializeBatchGraphDiagnostic(
    diagnostic: ts.Diagnostic | ts.DiagnosticRelatedInformation
): BatchGraphDiagnostic {
    const fullDiagnostic = diagnostic as ts.Diagnostic;
    return {
        category: diagnostic.category,
        code: diagnostic.code,
        messageText:
            typeof diagnostic.messageText === 'string'
                ? diagnostic.messageText
                : serializeBatchGraphMessageChain(diagnostic.messageText),
        ...(diagnostic.file ? { fileName: normalizePath(diagnostic.file.fileName) } : {}),
        ...(diagnostic.start !== undefined ? { start: diagnostic.start } : {}),
        ...(diagnostic.length !== undefined ? { length: diagnostic.length } : {}),
        ...(fullDiagnostic.source !== undefined ? { source: fullDiagnostic.source } : {}),
        ...(fullDiagnostic.reportsDeprecated !== undefined ? { reportsDeprecated: true } : {}),
        ...(fullDiagnostic.reportsUnnecessary !== undefined ? { reportsUnnecessary: true } : {}),
        ...(fullDiagnostic.relatedInformation?.length
            ? {
                  relatedInformation: fullDiagnostic.relatedInformation.map(
                      serializeBatchGraphDiagnostic
                  )
              }
            : {})
    };
}

function restoreBatchGraphMessageChain(
    chain: BatchGraphDiagnosticMessageChain
): ts.DiagnosticMessageChain {
    return {
        messageText: chain.messageText,
        category: chain.category,
        code: chain.code,
        ...(chain.next?.length ? { next: chain.next.map(restoreBatchGraphMessageChain) } : {})
    };
}

function restoreBatchGraphDiagnostic(diagnostic: BatchGraphDiagnostic): ts.Diagnostic {
    let file: ts.SourceFile | undefined;
    if (diagnostic.fileName) {
        let text = '';
        try {
            text = fs.readFileSync(diagnostic.fileName, 'utf8');
        } catch {
            // The cache owner validates freshness; retaining a path still gives deterministic
            // diagnostics if the source disappears in the narrow restore/apply race.
        }
        file = ts.createSourceFile(
            diagnostic.fileName,
            text,
            ts.ScriptTarget.Latest,
            true,
            diagnostic.fileName.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS
        );
    }
    return {
        file,
        start: diagnostic.start,
        length: diagnostic.length,
        category: diagnostic.category,
        code: diagnostic.code,
        messageText:
            typeof diagnostic.messageText === 'string'
                ? diagnostic.messageText
                : restoreBatchGraphMessageChain(diagnostic.messageText),
        ...(diagnostic.source !== undefined ? { source: diagnostic.source } : {}),
        ...(diagnostic.reportsDeprecated !== undefined
            ? { reportsDeprecated: diagnostic.reportsDeprecated }
            : {}),
        ...(diagnostic.reportsUnnecessary !== undefined
            ? { reportsUnnecessary: diagnostic.reportsUnnecessary }
            : {}),
        ...(diagnostic.relatedInformation?.length
            ? {
                  relatedInformation: diagnostic.relatedInformation.map(restoreBatchGraphDiagnostic)
              }
            : {})
    };
}

function batchGraphPlanSignature(plan: Omit<BatchGraphPlan, 'signature'>): string {
    return sha256(JSON.stringify(stableJsonValue(plan)));
}

function decodeBatchGraphPlan(
    value: unknown,
    expectedProject: BatchGraphPlan['project']
): BatchGraphPlan | undefined {
    try {
        const raw = expectRecord(value);
        const signature = expectSha256(raw.signature);
        const { signature: _signature, ...unsigned } = raw;
        if (
            signature !==
            batchGraphPlanSignature(unsigned as unknown as Omit<BatchGraphPlan, 'signature'>)
        ) {
            return undefined;
        }
        if (raw.version !== 1) {
            return undefined;
        }

        const projectRaw = expectRecord(raw.project);
        const project: BatchGraphPlan['project'] = {
            projectPath: expectAbsolutePath(projectRaw.projectPath),
            sourceRoot: expectAbsolutePath(projectRaw.sourceRoot),
            tsconfigPath:
                projectRaw.tsconfigPath === null
                    ? null
                    : expectAbsolutePath(projectRaw.tsconfigPath)
        };
        if (
            project.projectPath !== expectedProject.projectPath ||
            project.sourceRoot !== expectedProject.sourceRoot ||
            project.tsconfigPath !== expectedProject.tsconfigPath
        ) {
            return undefined;
        }

        const parsedRaw = expectRecord(raw.parsedBaseConfig);
        const pathsRaw = expectRecord(parsedRaw.paths);
        const paths = Object.fromEntries(
            Object.entries(pathsRaw).map(([key, targets]) => [key, expectStringArray(targets)])
        );
        const parsedBaseConfig: BatchGraphParsedBaseConfig = {
            rootDirs: expectPathArray(parsedRaw.rootDirs),
            rawFileNames: expectPathArray(parsedRaw.rawFileNames),
            paths,
            pathsBasePath:
                parsedRaw.pathsBasePath === undefined || parsedRaw.pathsBasePath === null
                    ? undefined
                    : expectAbsolutePath(parsedRaw.pathsBasePath)
        };
        const batchConfigDirectory = expectAbsolutePath(raw.batchConfigDirectory);
        const expectedConfigDirectory = expectedProject.tsconfigPath
            ? normalizePath(dirname(expectedProject.tsconfigPath))
            : expectedProject.projectPath;
        if (batchConfigDirectory !== expectedConfigDirectory) {
            return undefined;
        }
        assertJsonValue(raw.batchCompilerOptions);
        const batchCompilerOptions = cloneJsonValue(
            expectRecord(raw.batchCompilerOptions)
        ) as ts.CompilerOptions;

        const batchReachableBareImports = expectTupleArray(raw.batchReachableBareImports).map(
            ([specifier, target]) =>
                [expectNonEmptyString(specifier), expectAbsolutePath(target)] as [string, string]
        );
        const batchReachablePackageImports = expectArray(raw.batchReachablePackageImports).map(
            (entry) => {
                const imported = expectRecord(entry);
                return {
                    specifier: expectNonEmptyString(imported.specifier),
                    packageName: expectNonEmptyString(imported.packageName),
                    containingFile: expectAbsolutePath(imported.containingFile),
                    ...(imported.resolvedFile === undefined
                        ? {}
                        : { resolvedFile: expectAbsolutePath(imported.resolvedFile) })
                };
            }
        );
        const sourceInputs = expectArray(raw.sourceInputs).map((input) => {
            const entry = expectRecord(input);
            return {
                path: expectAbsolutePath(entry.path),
                signature: expectSha256(entry.signature)
            };
        });
        const dependencyScope =
            raw.dependencyScope === null
                ? null
                : decodeBatchGraphDependencyScope(raw.dependencyScope);

        return {
            version: 1,
            signature,
            project,
            parsedBaseConfig,
            baseConfigDiagnostics: expectArray(raw.baseConfigDiagnostics).map((diagnostic) =>
                decodeBatchGraphDiagnostic(diagnostic)
            ),
            batchCompilerOptions,
            batchConfigDirectory,
            projectSvelteFiles: expectPathArray(raw.projectSvelteFiles),
            projectSvelteFileScan:
                raw.projectSvelteFileScan === null
                    ? null
                    : expectPathArray(raw.projectSvelteFileScan),
            batchReachableSourceFiles: expectPathArray(raw.batchReachableSourceFiles),
            batchReachableBareImports,
            batchReachablePackageImports,
            batchRootSourceFiles: expectPathArray(raw.batchRootSourceFiles),
            batchForwardSourceEdges: decodeBatchGraphEdges(raw.batchForwardSourceEdges),
            batchReverseSourceEdges: decodeBatchGraphEdges(raw.batchReverseSourceEdges),
            batchPackagePrivateSourceEdges: decodeBatchGraphEdges(
                raw.batchPackagePrivateSourceEdges
            ),
            projectReachabilityFallbackReasons: expectStringArray(
                raw.projectReachabilityFallbackReasons
            ),
            dependencySvelteFileScan:
                raw.dependencySvelteFileScan === null
                    ? null
                    : expectPathArray(raw.dependencySvelteFileScan),
            dependencyScope,
            sourceInputs,
            configInputs: expectPathArray(raw.configInputs),
            manifestInputs: expectPathArray(raw.manifestInputs),
            layoutInputs: expectPathArray(raw.layoutInputs),
            directoryRoots: expectPathArray(raw.directoryRoots)
        };
    } catch {
        return undefined;
    }
}

function decodeBatchGraphDependencyScope(value: unknown): BatchGraphDependencyScope {
    const raw = expectRecord(value);
    if (raw.mode !== 'reachable' && raw.mode !== 'declared-fallback') {
        throw new Error('invalid dependency graph mode');
    }
    if (!Number.isSafeInteger(raw.directImports) || (raw.directImports as number) < 0) {
        throw new Error('invalid dependency import count');
    }
    return {
        mode: raw.mode,
        roots: expectPathArray(raw.roots),
        directImports: raw.directImports as number,
        fallbackReasons: expectStringArray(raw.fallbackReasons)
    };
}

function decodeBatchGraphEdges(value: unknown): Array<[string, string[]]> {
    return expectTupleArray(value).map(([source, targets]) => [
        expectAbsolutePath(source),
        expectPathArray(targets)
    ]);
}

function decodeBatchGraphDiagnostic(value: unknown, depth = 0): BatchGraphDiagnostic {
    if (depth > 20) {
        throw new Error('diagnostic chain too deep');
    }
    const raw = expectRecord(value);
    const category = raw.category;
    if (!Number.isInteger(category) || (category as number) < 0 || (category as number) > 3) {
        throw new Error('invalid diagnostic category');
    }
    if (!Number.isSafeInteger(raw.code) || (raw.code as number) < 0) {
        throw new Error('invalid diagnostic code');
    }
    const decodeMessage = (message: unknown): string | BatchGraphDiagnosticMessageChain => {
        if (typeof message === 'string') {
            return message;
        }
        const chain = expectRecord(message);
        return {
            messageText: expectString(chain.messageText),
            category: decodeDiagnosticCategory(chain.category),
            code: expectNonNegativeInteger(chain.code),
            ...(chain.next === undefined
                ? {}
                : {
                      next: expectArray(chain.next).map(
                          (next) => decodeMessage(next) as BatchGraphDiagnosticMessageChain
                      )
                  })
        };
    };
    return {
        category: category as ts.DiagnosticCategory,
        code: raw.code as number,
        messageText: decodeMessage(raw.messageText),
        ...(raw.fileName === undefined ? {} : { fileName: expectAbsolutePath(raw.fileName) }),
        ...(raw.start === undefined ? {} : { start: expectNonNegativeInteger(raw.start) }),
        ...(raw.length === undefined ? {} : { length: expectNonNegativeInteger(raw.length) }),
        ...(raw.source === undefined ? {} : { source: expectString(raw.source) }),
        ...(raw.reportsDeprecated === undefined
            ? {}
            : { reportsDeprecated: expectBoolean(raw.reportsDeprecated) }),
        ...(raw.reportsUnnecessary === undefined
            ? {}
            : { reportsUnnecessary: expectBoolean(raw.reportsUnnecessary) }),
        ...(raw.relatedInformation === undefined
            ? {}
            : {
                  relatedInformation: expectArray(raw.relatedInformation).map((related) =>
                      decodeBatchGraphDiagnostic(related, depth + 1)
                  )
              })
    };
}

function expectRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected object');
    }
    return value as Record<string, unknown>;
}

function expectArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error('expected array');
    }
    return value;
}

function expectTupleArray(value: unknown): Array<[unknown, unknown]> {
    return expectArray(value).map((entry) => {
        if (!Array.isArray(entry) || entry.length !== 2) {
            throw new Error('expected tuple');
        }
        return [entry[0], entry[1]];
    });
}

function expectString(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('expected string');
    }
    return value;
}

function expectNonEmptyString(value: unknown): string {
    const text = expectString(value);
    if (!text || text.includes('\0')) {
        throw new Error('expected non-empty string');
    }
    return text;
}

function expectStringArray(value: unknown): string[] {
    return expectArray(value).map(expectString);
}

function expectAbsolutePath(value: unknown): string {
    const fileName = expectNonEmptyString(value);
    if (!isAbsolute(fileName)) {
        throw new Error('expected absolute path');
    }
    return normalizePath(fileName);
}

function expectPathArray(value: unknown): string[] {
    return unique(expectArray(value).map(expectAbsolutePath));
}

function expectBoolean(value: unknown): boolean {
    if (typeof value !== 'boolean') {
        throw new Error('expected boolean');
    }
    return value;
}

function expectNonNegativeInteger(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error('expected non-negative integer');
    }
    return value as number;
}

function decodeDiagnosticCategory(value: unknown): ts.DiagnosticCategory {
    const category = expectNonNegativeInteger(value);
    if (category > 3) {
        throw new Error('invalid diagnostic category');
    }
    return category;
}

function expectSha256(value: unknown): string {
    const signature = expectString(value);
    if (!/^[0-9a-f]{64}$/.test(signature)) {
        throw new Error('expected SHA-256 signature');
    }
    return signature;
}

function assertJsonValue(value: unknown, seen = new Set<object>(), depth = 0): void {
    if (depth > 100) {
        throw new Error('JSON value too deep');
    }
    if (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    ) {
        return;
    }
    if (typeof value !== 'object') {
        throw new Error('non-JSON value');
    }
    if (seen.has(value)) {
        throw new Error('cyclic JSON value');
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value) {
            assertJsonValue(entry, seen, depth + 1);
        }
    } else {
        for (const entry of Object.values(value as Record<string, unknown>)) {
            assertJsonValue(entry, seen, depth + 1);
        }
    }
    seen.delete(value);
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

function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

function packageVersionFor(packageName: string): string {
    try {
        return JSON.parse(fs.readFileSync(require.resolve(`${packageName}/package.json`), 'utf8'))
            .version;
    } catch {
        try {
            const entry = require.resolve(packageName);
            let current = dirname(entry);
            for (;;) {
                const manifest = readPackageManifest(current);
                if (manifest?.name === packageName) {
                    return String(manifest.version ?? 'unknown');
                }
                const parent = dirname(current);
                if (parent === current) {
                    break;
                }
                current = parent;
            }
        } catch {}
        return 'unknown';
    }
}

function snapshotOptionsIdentity(options: SvelteSnapshotOptions) {
    return {
        svelte: options.version ?? 'unknown',
        transform: options.transformFingerprint ?? 'js',
        typingsNamespace: options.typingsNamespace,
        transformOnTemplateError: options.transformOnTemplateError,
        emitJsDoc: options.emitJsDoc,
        rewriteExternalImports: options.rewriteExternalImports
    };
}

function transformConfigIdentity(config: SvelteConfig | undefined) {
    const compiler = config?.compilerOptions;
    const preprocess = Array.isArray(config?.preprocess)
        ? config?.preprocess
        : [config?.preprocess];
    return {
        source: config?.configSource,
        namespace: compiler?.namespace,
        accessors: compiler?.accessors,
        customElement:
            typeof compiler?.customElement === 'function'
                ? String(compiler.customElement)
                : compiler?.customElement,
        defaultLanguages: preprocess
            .map((entry) => entry?.defaultLanguages)
            .filter((entry) => !!entry),
        preprocessors: preprocess
            .filter((entry) => !!entry)
            .map((entry) => ({
                markup: functionIdentity(entry?.markup),
                script: functionIdentity(entry?.script),
                style: functionIdentity(entry?.style)
            }))
    };
}

function functionIdentity(value: unknown): string | undefined {
    return typeof value === 'function' ? String(value) : undefined;
}

function sharedPackageRoot(from: string, stopAt: string): string {
    const key = `${normalizePath(from)}\0${normalizePath(stopAt)}`;
    let root = sharedPackageRootsByDir.get(key);
    if (!root) {
        root = findPackageRoot(from, stopAt);
        sharedPackageRootsByDir.set(key, root);
    }
    return root;
}

function readPackageManifest(packageRoot: string): any | undefined {
    const key = normalizePath(packageRoot);
    if (sharedPackageManifests.has(key)) {
        return sharedPackageManifests.get(key) ?? undefined;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(join(key, 'package.json'), 'utf8'));
        sharedPackageManifests.set(key, manifest);
        return manifest;
    } catch {
        sharedPackageManifests.set(key, null);
        return undefined;
    }
}

/** Resolve the package root without assuming package.json is exported. */
function resolveDependencyRoot(
    packageName: string,
    fromRoot: string,
    cache?: ReachabilityCache
): string | undefined {
    const readTrackedManifest = (packageRoot: string) => {
        const normalized = normalizePath(packageRoot);
        cache?.manifestInputs.add(normalizePath(join(normalized, 'package.json')));
        cache?.layoutInputs.add(normalized);
        return readPackageManifest(normalized);
    };
    // The node_modules path is dramatically cheaper than two failed `require.resolve` calls for
    // export-restricted packages. Keep the import-visible lexical spelling: realpath() changes
    // `/var` to `/private/var` on macOS and moves pnpm links outside the workspace spelling,
    // breaking mirror/rootDirs ownership even though both names identify the same package.
    const parts = packageName.split('/');
    let current = normalizePath(fromRoot);
    for (;;) {
        const candidate = normalizePath(join(current, 'node_modules', ...parts));
        if (readTrackedManifest(candidate)?.name === packageName) {
            return registerPackageRootAlias(candidate);
        }
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    try {
        const manifestPath = normalizePath(
            require.resolve(`${packageName}/package.json`, { paths: [fromRoot] })
        );
        cache?.manifestInputs.add(manifestPath);
        const resolvedRoot = dirname(manifestPath);
        cache?.layoutInputs.add(resolvedRoot);
        return registerPackageRootAlias(resolvedRoot);
    } catch {
        // Continue through the public entry and direct node_modules locations.
    }
    try {
        let current = dirname(require.resolve(packageName, { paths: [fromRoot] }));
        for (;;) {
            const manifest = readTrackedManifest(current);
            if (manifest?.name === packageName) {
                return registerPackageRootAlias(current);
            }
            const parent = dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
    } catch {
        // CLI-only/export-restricted packages may not expose `.`.
    }

    return undefined;
}

function publicPackageEntryFiles(
    packageRoot: string,
    manifest: any,
    cache?: ReachabilityCache
): { files: string[]; fallbackReasons: string[] } {
    const publicEntries = relevantPublicEntryTargets(manifest?.exports);
    const publicGraphEntries = preferredPublicGraphTargets(manifest?.exports);
    const targets = unique([
        ...(typeof manifest?.types === 'string' ? [manifest.types] : []),
        ...(typeof manifest?.typings === 'string' ? [manifest.typings] : []),
        ...(typeof manifest?.svelte === 'string' ? [manifest.svelte] : []),
        ...(manifest?.exports === undefined && typeof manifest?.main === 'string'
            ? [manifest.main]
            : []),
        ...(manifest?.exports === undefined && typeof manifest?.module === 'string'
            ? [manifest.module]
            : []),
        ...(manifest?.exports === undefined && typeof manifest?.browser === 'string'
            ? [manifest.browser]
            : []),
        ...publicGraphEntries.targets,
        ...(manifest?.exports === undefined ? ['./index.d.ts', './index.js'] : [])
    ]).map(normalizeExportTarget);
    const files = new Set<string>();
    const fallbackReasons = new Set<string>();
    if (!publicEntries.complete) {
        fallbackReasons.add(`dependency-public-entry-limit:${packageRoot}`);
    }
    if (!publicGraphEntries.complete) {
        fallbackReasons.add(`dependency-public-target-limit:${packageRoot}`);
    }

    for (const target of targets) {
        if (target.includes('*')) {
            cache?.directoryRoots.add(normalizePath(packageRoot));
            const matches = ts.sys.readDirectory(packageRoot, undefined, undefined, [target]);
            // readDirectory already enumerated the complete pattern. Visiting an arbitrary first
            // 1,000 made generated icon/component exports depend on directory ordering and then
            // forced the broad declared-dependency fallback. The source-graph budget below is
            // the single deterministic safety bound and fails closed if a package exceeds it.
            // An empty pattern cannot contribute a present source; directory membership is
            // persisted so creating a match invalidates the plan.
            for (const match of matches) {
                if (SCRIPT_SOURCE_RE.test(match) || match.endsWith('.svelte')) {
                    files.add(normalizePath(match));
                }
            }
            continue;
        }

        const absolute = normalizePath(join(packageRoot, target));
        const candidates = unique([
            absolute,
            ...declarationCandidates(absolute),
            ...(/\.(?:js|mjs|cjs)$/.test(absolute)
                ? declarationCandidates(absolute.replace(/\.(?:js|mjs|cjs)$/, ''))
                : [])
        ]);
        for (const candidate of candidates) {
            if (
                fs.statSync(candidate, { throwIfNoEntry: false })?.isFile() &&
                (SCRIPT_SOURCE_RE.test(candidate) || candidate.endsWith('.svelte'))
            ) {
                files.add(candidate);
            }
        }
    }
    return { files: [...files], fallbackReasons: [...fallbackReasons] };
}

function preferredPublicGraphTargets(exportsField: unknown): {
    targets: string[];
    complete: boolean;
} {
    const values =
        exportsField &&
        typeof exportsField === 'object' &&
        !Array.isArray(exportsField) &&
        Object.keys(exportsField).some((key) => key.startsWith('.'))
            ? Object.values(exportsField as Record<string, unknown>)
            : [exportsField];
    const targets: string[] = [];
    for (const value of values) {
        targets.push(...preferredConditionalTargets(value));
        if (targets.length > MAX_PUBLIC_EXPORT_TARGETS) {
            return { targets: [], complete: false };
        }
    }
    return { targets, complete: true };
}

function preferredConditionalTargets(value: unknown): string[] {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const conditions = value as Record<string, unknown>;
        const preferred = [...stringTargets(conditions.types), ...stringTargets(conditions.svelte)];
        if (preferred.length) {
            return preferred;
        }
    }
    // Without an authoritative types/Svelte branch, the active entry depends on the importing
    // file's module mode and custom conditions. This package graph is shared across projects, so
    // conservatively visit every bounded branch instead of silently choosing object key order.
    return stringTargets(value);
}

interface PublicExportEdges {
    specifiers: string[];
    computed: boolean;
}

/**
 * Return only module edges which are part of a package file's public surface.
 *
 * `ts.preProcessFile` intentionally reports every import. That is the right primitive for a
 * user's source graph, but it is far too broad for package closure: following implementation
 * imports from public entries walks database drivers, observability adapters and every optional
 * native binding even though none of them can make a component importable from the package.
 * Package closure needs re-exports and imported values which are exported directly. Relative
 * implementation imports are still followed separately inside the current package so a public
 * source file can reach its own private Svelte components.
 */
function collectPublicExportEdges(fileName: string, text: string): PublicExportEdges {
    const specifiers = new Set<string>();
    const importedBindings = new Map<string, string>();
    let computed = false;
    const scriptKind = /\.[cm]?jsx$/i.test(fileName)
        ? ts.ScriptKind.JSX
        : /\.[cm]?js$/i.test(fileName)
          ? ts.ScriptKind.JS
          : /\.tsx$/i.test(fileName)
            ? ts.ScriptKind.TSX
            : ts.ScriptKind.TS;
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);

    const moduleSpecifier = (node: ts.Expression | undefined): string | undefined =>
        node && ts.isStringLiteralLike(node) ? node.text : undefined;
    const bindingNames = (name: ts.BindingName): string[] => {
        if (ts.isIdentifier(name)) {
            return [name.text];
        }
        return name.elements.flatMap((element) =>
            ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
        );
    };
    const requireSpecifier = (
        expression: ts.Expression | undefined,
        markComputed = true
    ): string | undefined => {
        if (!expression || !ts.isCallExpression(expression)) {
            return undefined;
        }
        if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') {
            return undefined;
        }
        const value = moduleSpecifier(expression.arguments[0]);
        if (!value && markComputed) {
            computed = true;
        }
        return value;
    };
    const unwrap = (expression: ts.Expression): ts.Expression => {
        while (
            ts.isParenthesizedExpression(expression) ||
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression) ||
            ts.isNonNullExpression(expression) ||
            ts.isSatisfiesExpression(expression)
        ) {
            expression = expression.expression;
        }
        return expression;
    };
    const collectDirectExpression = (input: ts.Expression | undefined): void => {
        if (!input) {
            return;
        }
        const expression = unwrap(input);
        if (ts.isIdentifier(expression)) {
            const imported = importedBindings.get(expression.text);
            if (imported) {
                specifiers.add(imported);
            }
            return;
        }
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
            collectDirectExpression(expression.expression);
            return;
        }
        if (ts.isCallExpression(expression)) {
            const required = requireSpecifier(expression);
            if (required) {
                specifiers.add(required);
                return;
            }
            if (
                ts.isIdentifier(expression.expression) &&
                ['__importDefault', '__importStar', '__toESM', '__toCommonJS'].includes(
                    expression.expression.text
                )
            ) {
                collectDirectExpression(expression.arguments[0]);
            }
            return;
        }
        if (ts.isConditionalExpression(expression)) {
            collectDirectExpression(expression.whenTrue);
            collectDirectExpression(expression.whenFalse);
            return;
        }
        if (
            ts.isBinaryExpression(expression) &&
            [
                ts.SyntaxKind.BarBarToken,
                ts.SyntaxKind.QuestionQuestionToken,
                ts.SyntaxKind.CommaToken
            ].includes(expression.operatorToken.kind)
        ) {
            collectDirectExpression(expression.left);
            collectDirectExpression(expression.right);
            return;
        }
        if (ts.isObjectLiteralExpression(expression)) {
            for (const property of expression.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    collectDirectExpression(property.name);
                } else if (ts.isPropertyAssignment(property)) {
                    collectDirectExpression(property.initializer);
                } else if (ts.isSpreadAssignment(property)) {
                    collectDirectExpression(property.expression);
                }
            }
        }
    };
    const collectReferencedBindings = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            const imported = importedBindings.get(node.text);
            if (imported) {
                specifiers.add(imported);
            }
        }
        ts.forEachChild(node, collectReferencedBindings);
    };
    const hasExportModifier = (node: ts.Node): boolean =>
        !!ts
            .getModifiers(node as ts.HasModifiers)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isExportsTarget = (expression: ts.Expression): boolean => {
        expression = unwrap(expression);
        if (ts.isIdentifier(expression)) {
            return expression.text === 'exports';
        }
        if (ts.isPropertyAccessExpression(expression)) {
            return (
                (ts.isIdentifier(expression.expression) &&
                    expression.expression.text === 'exports') ||
                (ts.isIdentifier(expression.expression) &&
                    expression.expression.text === 'module' &&
                    expression.name.text === 'exports')
            );
        }
        if (ts.isElementAccessExpression(expression)) {
            return isExportsTarget(expression.expression);
        }
        return false;
    };

    // Bind imports and top-level require aliases before inspecting export statements. Emitted
    // CommonJS often declares the alias after the export helper in source order.
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
            const imported = moduleSpecifier(statement.moduleSpecifier);
            if (!imported || !statement.importClause) {
                continue;
            }
            if (statement.importClause.name) {
                importedBindings.set(statement.importClause.name.text, imported);
            }
            const bindings = statement.importClause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings)) {
                importedBindings.set(bindings.name.text, imported);
            } else if (bindings) {
                for (const element of bindings.elements) {
                    importedBindings.set(element.name.text, imported);
                }
            }
            continue;
        }
        if (
            ts.isImportEqualsDeclaration(statement) &&
            ts.isExternalModuleReference(statement.moduleReference)
        ) {
            const imported = moduleSpecifier(statement.moduleReference.expression);
            if (imported) {
                importedBindings.set(statement.name.text, imported);
            }
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                let initializer = declaration.initializer;
                while (
                    initializer &&
                    ts.isCallExpression(initializer) &&
                    ts.isIdentifier(initializer.expression) &&
                    ['__importDefault', '__importStar', '__toESM'].includes(
                        initializer.expression.text
                    )
                ) {
                    initializer = initializer.arguments[0];
                }
                const imported = requireSpecifier(initializer, false);
                if (imported) {
                    for (const name of bindingNames(declaration.name)) {
                        importedBindings.set(name, imported);
                    }
                }
            }
        }
    }

    for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
            const direct = moduleSpecifier(statement.moduleSpecifier);
            if (direct) {
                specifiers.add(direct);
            } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    const local = (element.propertyName ?? element.name).text;
                    const imported = importedBindings.get(local);
                    if (imported) {
                        specifiers.add(imported);
                    }
                }
            }
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            collectDirectExpression(statement.expression);
            continue;
        }
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                collectDirectExpression(declaration.initializer);
            }
            continue;
        }
        if (ts.isClassDeclaration(statement) && hasExportModifier(statement)) {
            for (const clause of statement.heritageClauses ?? []) {
                if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                    for (const type of clause.types) {
                        collectDirectExpression(type.expression);
                    }
                }
            }
            continue;
        }
        if (!ts.isExpressionStatement(statement)) {
            continue;
        }
        const expression = unwrap(statement.expression);
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            isExportsTarget(expression.left)
        ) {
            collectDirectExpression(expression.right);
            continue;
        }
        if (!ts.isCallExpression(expression)) {
            continue;
        }
        if (ts.isIdentifier(expression.expression)) {
            const helper = expression.expression.text;
            if (helper === '__exportStar' || helper === '__reExport') {
                // TypeScript's __exportStar(source, exports) takes the source first. esbuild's
                // __reExport(target, source, secondTarget) takes it second.
                const source = expression.arguments[helper === '__reExport' ? 1 : 0];
                if (source) {
                    collectDirectExpression(source);
                } else {
                    computed = true;
                }
                continue;
            }
            // Bundlers regularly rename or replace their export helpers. Returning a proven
            // narrow graph after ignoring one is unsafe; the declared-dependency fallback is
            // slower but cannot silently omit a component package.
            if (/^_+.*export/i.test(helper)) {
                computed = true;
                continue;
            }
        }
        if (
            ts.isPropertyAccessExpression(expression.expression) &&
            /^_+.*export/i.test(expression.expression.name.text)
        ) {
            computed = true;
            continue;
        }
        if (
            ts.isPropertyAccessExpression(expression.expression) &&
            ts.isIdentifier(expression.expression.expression) &&
            expression.expression.expression.text === 'Object' &&
            expression.expression.name.text === 'defineProperty' &&
            expression.arguments[0] &&
            isExportsTarget(expression.arguments[0]) &&
            expression.arguments[2]
        ) {
            collectReferencedBindings(expression.arguments[2]);
        }
    }

    // TypeScript's parser cannot make useful statements from a complete `.svelte` document.
    // Restrict the lexical fallback to that syntax: applying it to ordinary JS matches comments,
    // generated source-code strings and template literals in large bundles as fake public edges.
    if (fileName.endsWith('.svelte')) {
        const reexport =
            /\bexport\s+(?:\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\})\s+from\s*(['"])([^'"]+)\1/g;
        let match: RegExpExecArray | null;
        while ((match = reexport.exec(text))) {
            specifiers.add(match[2]!);
        }
    }
    if (
        /(?:\bmodule\s*\.\s*exports|\bexports\s*(?:\.|\[))[^=]*=\s*(?:__[\w$]+\s*\(\s*)?require\s*\(\s*(?!['"])/.test(
            text
        ) ||
        /\b__exportStar\s*\(\s*require\s*\(\s*(?!['"])/.test(text)
    ) {
        computed = true;
    }

    return { specifiers: [...specifiers], computed };
}

/** Public package graph used both for dependency closure proof and collision importer edges. */
function collectPublicPackageSourceGraph(
    packageRoot: string,
    compilerOptions: ts.CompilerOptions = {},
    configDirectory = packageRoot,
    sourceRoot = packageRoot,
    cache = createReachabilityCache(compilerOptions, configDirectory),
    forwardEdges?: Map<string, Set<string>>,
    reverseEdges?: Map<string, Set<string>>,
    packagePrivateEdges?: Map<string, Set<string>>
): { packageNames: string[]; sourceFiles: string[]; fallbackReasons: string[] } {
    cache.manifestInputs.add(normalizePath(join(packageRoot, 'package.json')));
    cache.layoutInputs.add(normalizePath(packageRoot));
    const manifest = readPackageManifest(packageRoot);
    if (!manifest) {
        return {
            packageNames: [],
            sourceFiles: [],
            fallbackReasons: [`unreadable-dependency-manifest:${packageRoot}`]
        };
    }
    const entries = publicPackageEntryFiles(packageRoot, manifest, cache);
    const fallbackReasons = new Set(entries.fallbackReasons);
    const packageNames = new Set<string>();
    const sourceFiles = new Set<string>();
    const normalizedPackageRoot = normalizePath(packageRoot);
    const realPackageRoot = realPathOrSelf(packageRoot);
    const isInsidePackage = (fileName: string) => {
        const realFile = realPathOrSelf(fileName);
        return (
            fileName === normalizedPackageRoot ||
            fileName.startsWith(normalizedPackageRoot + '/') ||
            realFile === realPackageRoot ||
            realFile.startsWith(realPackageRoot + '/')
        );
    };
    const followDirectiveReferences = (
        fileName: string,
        analysis: ReachabilitySourceAnalysis,
        targetQueue: string[],
        phase: 'public' | 'source'
    ) => {
        for (const reference of analysis.preprocessed.referencedFiles) {
            const resolved = resolveReachablePathReference(reference, fileName, cache);
            if (!resolved) {
                fallbackReasons.add(
                    `unresolved-dependency-${phase}-reference:${fileName}:${reference.fileName}`
                );
                continue;
            }
            const canonical = canonicalSourcePath(resolved, sourceRoot);
            if (forwardEdges && reverseEdges) {
                addSourceGraphEdge(forwardEdges, reverseEdges, fileName, canonical);
            }
            if (
                isInsidePackage(canonical) &&
                (SCRIPT_SOURCE_RE.test(canonical) || canonical.endsWith('.svelte'))
            ) {
                targetQueue.push(canonical);
            }
        }
        for (const reference of analysis.preprocessed.typeReferenceDirectives) {
            const resolved = resolveReachableTypeReference(
                reference,
                fileName,
                compilerOptions,
                cache
            );
            if (!resolved) {
                // Missing ambient packages have no present source to traverse. Their exact
                // type-root probes are persisted by the resolver so a later install invalidates
                // the plan without widening every package containing `types="node"`.
                continue;
            }
            const canonical = canonicalSourcePath(resolved, sourceRoot);
            if (forwardEdges && reverseEdges) {
                addSourceGraphEdge(forwardEdges, reverseEdges, fileName, canonical);
            }
            if (
                isInsidePackage(canonical) &&
                (SCRIPT_SOURCE_RE.test(canonical) || canonical.endsWith('.svelte'))
            ) {
                targetQueue.push(canonical);
            }
        }
    };

    // First prove the package-to-package public surface. Missing bare packages are commonly
    // optional peers/platform adapters. They cannot contribute a present Svelte source, and
    // resolveDependencyRoot records every absent manifest/layout probe so a later install still
    // invalidates a persisted plan. Missing relative/private *public* edges remain ambiguous.
    const publicQueue = [...entries.files];
    const publicFiles = new Set<string>();
    let publicCursor = 0;
    while (publicCursor < publicQueue.length && publicFiles.size < MAX_REACHABLE_SOURCE_FILES) {
        const fileName = canonicalSourcePath(publicQueue[publicCursor++]!, sourceRoot);
        if (publicFiles.has(fileName)) {
            continue;
        }
        publicFiles.add(fileName);
        let analysis: ReachabilitySourceAnalysis;
        try {
            analysis = analyzeReachabilitySource(fileName, cache);
        } catch {
            fallbackReasons.add(`unreadable-dependency-entry:${fileName}`);
            continue;
        }
        followDirectiveReferences(fileName, analysis, publicQueue, 'public');
        const publicEdges = collectPublicExportEdges(fileName, analysis.text);
        if (publicEdges.computed) {
            fallbackReasons.add(`computed-dependency-entry:${fileName}`);
        }
        for (const specifier of publicEdges.specifiers) {
            const packageName = packageNameFromSpecifier(specifier);
            if (packageName) {
                packageNames.add(packageName);
                continue;
            }
            const resolved = resolveReachableImport(
                specifier,
                fileName,
                compilerOptions,
                configDirectory,
                cache
            );
            if (!resolved) {
                if (
                    specifier.startsWith('#') ||
                    (isRelativeModuleSpecifier(specifier) &&
                        trackUnresolvedRelativePublicEdge(specifier, fileName, cache))
                ) {
                    fallbackReasons.add(`unresolved-dependency-entry:${fileName}:${specifier}`);
                }
                continue;
            }
            const canonical = canonicalSourcePath(resolved, sourceRoot);
            if (forwardEdges && reverseEdges) {
                addSourceGraphEdge(forwardEdges, reverseEdges, fileName, canonical);
            }
            if (specifier.startsWith('#') && packagePrivateEdges) {
                let targets = packagePrivateEdges.get(fileName);
                if (!targets) {
                    packagePrivateEdges.set(fileName, (targets = new Set()));
                }
                targets.add(canonical);
            }
            if (
                isInsidePackage(canonical) &&
                (SCRIPT_SOURCE_RE.test(canonical) || canonical.endsWith('.svelte'))
            ) {
                publicQueue.push(canonical);
            }
        }
    }
    if (publicCursor < publicQueue.length) {
        fallbackReasons.add(`dependency-public-source-graph-limit:${packageRoot}`);
    }

    // Then follow implementation imports only while they stay inside this package. This keeps
    // private components used by a public source reachable without recursively expanding every
    // bare runtime dependency of that source.
    const queue = unique([...entries.files, ...publicFiles]);
    let cursor = 0;
    while (cursor < queue.length && sourceFiles.size < MAX_REACHABLE_SOURCE_FILES) {
        const fileName = canonicalSourcePath(queue[cursor++]!, sourceRoot);
        if (sourceFiles.has(fileName)) {
            continue;
        }
        sourceFiles.add(fileName);
        let analysis: ReachabilitySourceAnalysis;
        try {
            analysis = analyzeReachabilitySource(fileName, cache);
        } catch {
            fallbackReasons.add(`unreadable-dependency-entry:${fileName}`);
            continue;
        }
        followDirectiveReferences(fileName, analysis, queue, 'source');
        for (const imported of analysis.preprocessed.importedFiles) {
            const specifier = imported.fileName;
            if (
                !isRelativeModuleSpecifier(specifier) &&
                !specifier.startsWith('#') &&
                !isAbsolute(specifier)
            ) {
                continue;
            }
            const resolved = resolveReachableImport(
                specifier,
                fileName,
                compilerOptions,
                configDirectory,
                cache
            );
            if (!resolved) {
                continue;
            }
            const canonical = canonicalSourcePath(resolved, sourceRoot);
            if (forwardEdges && reverseEdges) {
                addSourceGraphEdge(forwardEdges, reverseEdges, fileName, canonical);
            }
            if (specifier.startsWith('#') && packagePrivateEdges) {
                let targets = packagePrivateEdges.get(fileName);
                if (!targets) {
                    packagePrivateEdges.set(fileName, (targets = new Set()));
                }
                targets.add(canonical);
            }
            if (
                isInsidePackage(canonical) &&
                (SCRIPT_SOURCE_RE.test(canonical) || canonical.endsWith('.svelte'))
            ) {
                queue.push(canonical);
            }
        }
    }
    if (cursor < queue.length) {
        fallbackReasons.add(`dependency-source-graph-limit:${packageRoot}`);
    }
    return {
        packageNames: [...packageNames],
        sourceFiles: [...sourceFiles],
        fallbackReasons: [...fallbackReasons]
    };
}

/** Traverse only packages named by reachable public entry/import edges. */
function collectReachableDependencyRoots(
    directRoots: string[],
    compilerOptions: ts.CompilerOptions = {},
    configDirectory = directRoots[0] ?? process.cwd(),
    sourceRoot = configDirectory,
    cache = createReachabilityCache(compilerOptions, configDirectory)
): {
    roots: string[];
    fallbackReasons: string[];
} {
    const normalizedDirectRoots = unique(directRoots.map(normalizePath)).sort();
    const cacheKey = `${cache.optionsKey}\0${normalizedDirectRoots.join('\0')}`;
    const cached = sharedReachableDependencyRoots.get(cacheKey);
    if (cached) {
        for (const input of cached.sourceInputs) {
            cache.sourceSignatures.set(input.path, input.signature);
        }
        for (const input of cached.manifestInputs) {
            cache.manifestInputs.add(input);
        }
        for (const input of cached.layoutInputs) {
            cache.layoutInputs.add(input);
        }
        for (const root of cached.directoryRoots) {
            cache.directoryRoots.add(root);
        }
        return { roots: cached.roots, fallbackReasons: cached.fallbackReasons };
    }
    const roots: string[] = [];
    const fallbackReasons = new Set<string>();
    const seen = new Set<string>();
    const queue = [...normalizedDirectRoots];
    let cursor = 0;
    while (cursor < queue.length && seen.size <= 1_000) {
        const current = queue[cursor++]!;
        if (seen.has(current)) {
            continue;
        }
        seen.add(current);
        roots.push(current);
        cache.manifestInputs.add(normalizePath(join(current, 'package.json')));
        cache.layoutInputs.add(normalizePath(current));
        const manifest = readPackageManifest(current);
        markDependencyScanMode(current, isLikelySveltePackage(manifest) ? 'direct' : 'exports');
        const graph = collectPublicPackageSourceGraph(
            current,
            compilerOptions,
            configDirectory,
            sourceRoot,
            cache
        );
        for (const reason of graph.fallbackReasons) {
            fallbackReasons.add(reason);
        }
        for (const packageName of graph.packageNames) {
            const root = resolveDependencyRoot(packageName, current, cache);
            // Missing optional/peer/platform packages have no present source to materialise.
            // resolveDependencyRoot records its absent manifest/layout probes, so installing one
            // later invalidates the persisted graph without turning every optional adapter in a
            // declaration barrel into a broad-workspace fallback today.
            if (root && !seen.has(root)) {
                queue.push(root);
            }
        }
    }
    if (cursor < queue.length) {
        fallbackReasons.add('dependency-root-closure-limit:1000');
    }
    const result = {
        roots,
        fallbackReasons: [...fallbackReasons],
        sourceInputs: [...cache.sourceSignatures]
            .map(([path, signature]) => ({ path, signature }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        manifestInputs: sortedUnique(cache.manifestInputs),
        layoutInputs: sortedUnique(cache.layoutInputs),
        directoryRoots: sortedUnique(cache.directoryRoots)
    };
    sharedReachableDependencyRoots.set(cacheKey, result);
    return { roots: result.roots, fallbackReasons: result.fallbackReasons };
}

/** Reachable Svelte-bearing dependency roots, cached across project managers. */
function collectDependencyRoots(packageRoot: string, cache?: ReachabilityCache): string[] {
    const key = normalizePath(packageRoot);
    const trackRoot = (root: string) => {
        const normalized = normalizePath(root);
        cache?.manifestInputs.add(normalizePath(join(normalized, 'package.json')));
        cache?.layoutInputs.add(normalized);
        cache?.directoryRoots.add(normalized);
    };
    trackRoot(key);
    const cached = sharedDependencyRoots.get(key);
    if (cached) {
        for (const root of cached) {
            trackRoot(root);
        }
        return cached;
    }

    const manifest = readPackageManifest(key);
    if (!manifest) {
        sharedDependencyRoots.set(key, []);
        return [];
    }
    const names = new Set<string>([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {})
    ]);
    const roots: string[] = [];
    const seen = new Set<string>([key]);
    const queue: string[] = [];
    for (const name of names) {
        const root = resolveDependencyRoot(name, key, cache);
        if (!root || seen.has(root)) {
            continue;
        }
        seen.add(root);
        trackRoot(root);
        const dependencyManifest = readPackageManifest(root);
        roots.push(root);
        if (isLikelySveltePackage(dependencyManifest)) {
            markDependencyScanMode(root, 'direct');
        } else {
            // A package does not need "svelte" in its name, keywords or peer dependencies to
            // publicly re-export a raw component. Inspect its public entry graph narrowly; this
            // catches exports-hidden, marker-free packages without recursively walking every
            // ordinary dependency directory.
            markDependencyScanMode(root, 'exports');
        }
        queue.push(root);
    }

    // Published Svelte packages frequently re-export components from a companion package. Walk
    // the Svelte-bearing closure (without scanning every ordinary tooling dependency) so those
    // raw sources and modern declaration conditions are indexed too.
    while (queue.length && seen.size <= 1_000) {
        const current = queue.shift()!;
        trackRoot(current);
        const currentManifest = readPackageManifest(current);
        if (!currentManifest) {
            continue;
        }
        const transitiveNames = new Set<string>([
            ...Object.keys(currentManifest.dependencies ?? {}),
            ...Object.keys(currentManifest.optionalDependencies ?? {})
        ]);
        for (const name of transitiveNames) {
            const root = resolveDependencyRoot(name, current, cache);
            if (!root || seen.has(root)) {
                continue;
            }
            seen.add(root);
            trackRoot(root);
            const dependencyManifest = readPackageManifest(root);
            roots.push(root);
            if (isLikelySveltePackage(dependencyManifest)) {
                markDependencyScanMode(root, 'direct');
            } else {
                markDependencyScanMode(root, 'exports');
            }
            queue.push(root);
        }
    }

    sharedDependencyRoots.set(key, roots);
    return roots;
}

function markDependencyScanMode(root: string, mode: 'broad' | 'direct' | 'exports') {
    const key = normalizePath(root);
    const previous = sharedDependencyScanMode.get(key);
    const priority = { exports: 0, direct: 1, broad: 2 } as const;
    if (previous === mode || (previous && priority[previous] >= priority[mode])) {
        return;
    }
    sharedDependencyScanMode.set(key, mode);
    // A package first reached transitively may later be direct for another project, or a failed
    // proof may require the broad declared-closure safety net. In either case discard the result
    // cached under the weaker scan mode.
    sharedSvelteFilesByPackage.delete(key);
}

function manifestDeclaresDependency(manifest: any, packageName: string): boolean {
    return !!(
        manifest?.dependencies?.[packageName] ??
        manifest?.optionalDependencies?.[packageName] ??
        manifest?.peerDependencies?.[packageName] ??
        manifest?.devDependencies?.[packageName]
    );
}

function isLikelySveltePackage(manifest: any): boolean {
    if (!manifest) {
        return false;
    }
    return (
        typeof manifest.svelte === 'string' ||
        String(manifest.name ?? '')
            .toLowerCase()
            .includes('svelte') ||
        !!manifest.peerDependencies?.svelte ||
        !!manifest.dependencies?.svelte ||
        JSON.stringify(manifest.exports ?? {}).includes('.svelte') ||
        (Array.isArray(manifest.keywords) ? manifest.keywords : [manifest.keywords])
            .filter((keyword: unknown) => keyword != null)
            .some((keyword: unknown) => String(keyword).toLowerCase().includes('svelte'))
    );
}

function hasExplicitSvelteSources(manifest: any): boolean {
    return (
        !!manifest &&
        (typeof manifest.svelte === 'string' ||
            JSON.stringify(manifest.exports ?? {}).includes('.svelte'))
    );
}

function scanDependencySvelteFiles(packageRoot: string): string[] {
    const key = normalizePath(packageRoot);
    const cached = sharedSvelteFilesByPackage.get(key);
    if (cached) {
        return cached;
    }

    const manifest = readPackageManifest(key);
    // An exports map is an authoritative reachability boundary. Index its raw Svelte targets and
    // the Svelte modules referenced from public declaration barrels instead of recursively
    // walking thousands of implementation/icon files which consumers cannot import directly.
    if (
        sharedDependencyScanMode.get(key) !== 'broad' &&
        (sharedDependencyScanMode.get(key) === 'exports' || manifest?.exports !== undefined)
    ) {
        const result = scanPublicSvelteFiles(key, manifest);
        sharedSvelteFilesByPackage.set(key, result);
        return result;
    }

    const found = scanDependencyDirectory(key);
    sharedSvelteFilesByPackage.set(key, found);
    return found;
}

function scanPublicSvelteFiles(packageRoot: string, manifest: any): string[] {
    const found = new Set<string>();
    const targets = [
        ...(typeof manifest?.svelte === 'string' ? [manifest.svelte] : []),
        ...stringTargets(manifest?.exports)
    ].map(normalizeExportTarget);
    const publicEntries = relevantPublicEntryTargets(manifest?.exports);
    const publicEntryTargets = [
        ...(typeof manifest?.svelte === 'string' ? [manifest.svelte] : []),
        ...(typeof manifest?.main === 'string' ? [manifest.main] : []),
        ...(typeof manifest?.module === 'string' ? [manifest.module] : []),
        ...(typeof manifest?.browser === 'string' ? [manifest.browser] : []),
        ...publicEntries.targets
    ].map(normalizeExportTarget);

    // A very large generated exports table cannot be traversed indefinitely, but silently taking
    // its first entries would make reachability depend on JSON key order. Fall back to the raw
    // package scan instead. `needsSvelteShadow` still excludes modern `.d.svelte.ts` declarations.
    if (!publicEntries.complete) {
        for (const file of scanDependencyDirectory(packageRoot)) {
            found.add(file);
        }
    }

    for (const target of targets.filter((target) => target.includes('.svelte'))) {
        if (!target.includes('*')) {
            const file = normalizePath(join(packageRoot, target));
            if (file.endsWith('.svelte') && fs.existsSync(file) && needsSvelteShadow(file)) {
                found.add(file);
            }
            continue;
        }
        const prefix = target.slice(0, target.indexOf('*'));
        const directory = normalizePath(join(packageRoot, dirname(prefix)));
        for (const file of scanDependencyDirectory(directory)) {
            const relativeFile = normalizePath(relative(packageRoot, file));
            if (matchExportTarget(target, relativeFile) !== undefined) {
                found.add(file);
            }
        }
    }

    const declarationQueue = unique([
        ...(typeof manifest?.types === 'string' ? [manifest.types] : []),
        ...(typeof manifest?.typings === 'string' ? [manifest.typings] : []),
        ...publicEntryTargets.filter(
            (target) => /\.(?:[cm]?[jt]sx?|d\.[cm]?ts)$/.test(target) && !target.includes('*')
        )
    ]).map((target) => normalizePath(join(packageRoot, target)));
    const seenDeclarations = new Set<string>();
    while (declarationQueue.length && seenDeclarations.size < 100) {
        const declaration = declarationQueue.shift()!;
        if (seenDeclarations.has(declaration)) {
            continue;
        }
        seenDeclarations.add(declaration);
        let text: string;
        try {
            text = fs.readFileSync(declaration, 'utf8');
        } catch {
            continue;
        }
        // Use the same TypeScript preprocessor as the reachability signature. Besides ordinary
        // ESM imports/exports it understands declaration-only CommonJS forms such as
        // `import Button = require('./Button.svelte')` and `export = require(...)` which the old
        // `from` regex silently omitted.
        const preprocessed = ts.preProcessFile(text, true, true);
        for (const imported of [...preprocessed.importedFiles, ...preprocessed.referencedFiles]) {
            if (!isRelativeModuleSpecifier(imported.fileName)) {
                continue;
            }
            const target = normalizePath(join(dirname(declaration), imported.fileName));
            if (target.endsWith('.svelte')) {
                if (fs.existsSync(target) && needsSvelteShadow(target)) {
                    found.add(target);
                }
                continue;
            }
            // A public entry can pass through any number of ordinarily named barrels before it
            // reaches a raw component (`./button` -> `./controls` -> `Button.svelte`). The
            // spelling is not evidence of reachability, so follow every relative declaration
            // edge. The queue budget below bounds pathological generated barrels; if it is
            // exhausted we fall back to the complete package scan instead of silently omitting
            // whichever entries happened to sort after the limit.
            for (const candidate of declarationCandidates(target)) {
                if (fs.existsSync(candidate) && !seenDeclarations.has(candidate)) {
                    declarationQueue.push(candidate);
                    break;
                }
            }
        }
    }
    if (declarationQueue.length) {
        for (const file of scanDependencyDirectory(packageRoot)) {
            found.add(file);
        }
    }
    return [...found];
}

function relevantPublicEntryTargets(exportsField: unknown): {
    targets: string[];
    complete: boolean;
} {
    if (!exportsField || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
        return { targets: stringTargets(exportsField), complete: true };
    }
    const entries = Object.entries(exportsField as Record<string, unknown>);
    if (!entries.some(([key]) => key.startsWith('.'))) {
        return { targets: stringTargets(exportsField), complete: true };
    }
    if (entries.length > MAX_PUBLIC_EXPORT_ENTRIES) {
        return { targets: [], complete: false };
    }
    // Every explicit subpath is public API, regardless of its spelling. `./button` may point at a
    // declaration or JavaScript barrel which re-exports `Button.svelte`; filtering by the word
    // "svelte" silently skipped exactly those ordinary consumer-facing names.
    return { targets: entries.flatMap(([, value]) => stringTargets(value)), complete: true };
}

function declarationCandidates(target: string): string[] {
    if (/\.d\.(?:ts|mts|cts)$/.test(target)) {
        return [target];
    }
    const withoutJs = target.replace(/\.(?:js|mjs|cjs)$/, '');
    return unique([
        `${target}.d.ts`,
        `${withoutJs}.d.ts`,
        `${withoutJs}.d.mts`,
        `${withoutJs}.d.cts`,
        join(target, 'index.d.ts'),
        join(withoutJs, 'index.d.ts')
    ]);
}

function scanDependencyDirectory(root: string): string[] {
    const found: string[] = [];
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
                if (
                    entry.name !== 'node_modules' &&
                    entry.name !== '.git' &&
                    entry.name !== '.hg' &&
                    entry.name !== '.svn' &&
                    entry.name !== '.cache' &&
                    entry.name !== LEGACY_OVERLAY_DIR
                ) {
                    // Dirent directory checks do not follow symlinks, so traversal stays inside
                    // this package and can safely cover arbitrarily deep generated source trees.
                    walk(full);
                }
                continue;
            }
            if (!entry.name.endsWith('.svelte')) {
                continue;
            }
            if (needsSvelteShadow(full)) {
                found.push(normalizePath(full));
            }
        }
    };
    walk(root);
    return found;
}

/** Legal rune-module companions which collide with TypeScript's `.svelte` substitution. */
function runeModuleCompanions(svelteFilePath: string): string[] {
    return ['.ts', '.js']
        .map((extension) => `${svelteFilePath}${extension}`)
        .filter((file) => {
            try {
                return fs.statSync(file).isFile();
            } catch {
                return false;
            }
        });
}

/**
 * Pick one seven-character suffix which cannot resolve to a user-authored file beside any
 * component. This both avoids silently overwriting a `Foo.__svlt*` file and keeps rewrites
 * offset-stable. The deterministic sequence makes warm runs reuse the same paths.
 */
function chooseBatchSvelteSpecifierSuffix(svelteFiles: string[]): string {
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.d.ts'];
    for (let index = -1; index < 36 ** 3; index++) {
        const suffix = index < 0 ? '.__svlt' : `.__s${index.toString(36).padStart(3, '0')}`;
        if (suffix.length !== SVELTE_SPECIFIER_LENGTH) {
            continue;
        }
        const collides = svelteFiles.some((file) =>
            batchSvelteSpecifierSuffixCollides(file, suffix, extensions)
        );
        if (!collides) {
            return suffix;
        }
    }
    throw new Error('could not allocate a collision-free same-length Svelte shadow suffix');
}

function batchSvelteSpecifierSuffixCollides(
    svelteFile: string,
    suffix: string,
    extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.d.ts']
): boolean {
    const target = `${svelteFile.slice(0, -SVELTE_SPECIFIER_LENGTH)}${suffix}`;
    // `allowArbitraryExtensions` also probes `Foo.d.<extension>.ts`; that declaration spelling
    // must not be allowed to capture the adapter's synthetic extension.
    const arbitraryDeclaration = `${svelteFile.slice(0, -SVELTE_SPECIFIER_LENGTH)}.d${suffix}.ts`;
    return (
        extensions.some((extension) => fs.existsSync(`${target}${extension}`)) ||
        fs.existsSync(arbitraryDeclaration)
    );
}

/** Ordinary authored sources in a package which owns a colliding component. */
function scanPackageScriptFiles(packageRoot: string): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
        if (depth > 20) {
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
                if (
                    entry.name !== 'node_modules' &&
                    entry.name !== '.git' &&
                    entry.name !== '.hg' &&
                    entry.name !== '.svn' &&
                    entry.name !== '.cache' &&
                    entry.name !== LEGACY_OVERLAY_DIR
                ) {
                    walk(full, depth + 1);
                }
            } else if (SCRIPT_SOURCE_RE.test(entry.name)) {
                found.push(normalizePath(full));
            }
        }
    };
    walk(packageRoot, 0);
    return found;
}

/** Whether a package is outside the authored source tree (including installed dependencies). */
function isExternalPackageRoot(packageRoot: string, sourceRoot: string): boolean {
    const rel = normalizePath(relative(sourceRoot, packageRoot));
    if (rel === '' || rel === '.') {
        return false;
    }
    if (rel.startsWith('../') || isAbsolute(rel)) {
        return true;
    }
    return (
        rel === 'node_modules' || rel.startsWith('node_modules/') || rel.includes('/node_modules/')
    );
}

/** Rebase every relative package-import target from the real package into its mirror. */
function rewritePackageImportsForMirror(
    value: unknown,
    packageRoot: string,
    mirrorRoot: string,
    mirrorPathFor: (sourcePath: string) => string
): unknown {
    if (typeof value === 'string') {
        if (!value.startsWith('./')) {
            return value;
        }
        const sourceTarget = normalizePath(join(packageRoot, value.slice(2)));
        const mirrorTarget = mirrorPathFor(sourceTarget);
        const relativeTarget = normalizePath(relative(mirrorRoot, mirrorTarget));
        return relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`;
    }
    if (Array.isArray(value)) {
        return value.map((entry) =>
            rewritePackageImportsForMirror(entry, packageRoot, mirrorRoot, mirrorPathFor)
        );
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                rewritePackageImportsForMirror(entry, packageRoot, mirrorRoot, mirrorPathFor)
            ])
        );
    }
    return value;
}

function needsSvelteShadow(filePath: string): boolean {
    return (
        !fs.existsSync(`${filePath}.d.ts`) &&
        !fs.existsSync(filePath.replace(/\.svelte$/, '.d.svelte.ts'))
    );
}

function publicSpecifiersForSvelteFile(
    manifest: any,
    packageRoot: string,
    filePath: string
): string[] {
    const packageName = String(manifest.name);
    const relativeFile = normalizePath(relative(packageRoot, filePath));
    const specifiers = new Set<string>();

    if (
        typeof manifest.svelte === 'string' &&
        normalizeExportTarget(manifest.svelte) === relativeFile
    ) {
        specifiers.add(packageName);
    }

    const exportsField = manifest.exports;
    if (exportsField !== undefined) {
        const entries =
            exportsField &&
            typeof exportsField === 'object' &&
            !Array.isArray(exportsField) &&
            Object.keys(exportsField).some((key) => key.startsWith('.'))
                ? Object.entries(exportsField)
                : [['.', exportsField] as [string, unknown]];
        for (const [subpath, value] of entries) {
            for (const target of stringTargets(value)) {
                const wildcard = matchExportTarget(target, relativeFile);
                if (wildcard === undefined) {
                    continue;
                }
                const exported = subpath.replace('*', wildcard);
                specifiers.add(
                    exported === '.' ? packageName : `${packageName}${exported.slice(1)}`
                );
            }
        }
    } else {
        specifiers.add(`${packageName}/${relativeFile}`);
    }
    return [...specifiers];
}

function packageImportSpecifiersForSvelteFile(
    manifest: any,
    packageRoot: string,
    filePath: string
): string[] {
    const relativeFile = normalizePath(relative(packageRoot, filePath));
    const specifiers = new Set<string>();
    for (const [pattern, value] of Object.entries(manifest.imports ?? {})) {
        for (const target of stringTargets(value)) {
            const wildcard = matchExportTarget(target, relativeFile);
            if (wildcard !== undefined) {
                specifiers.add(pattern.replace('*', wildcard));
            }
        }
    }
    return [...specifiers];
}

function stringTargets(value: unknown): string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap(stringTargets);
    }
    if (value && typeof value === 'object') {
        return Object.values(value).flatMap(stringTargets);
    }
    return [];
}

function matchExportTarget(target: string, relativeFile: string): string | undefined {
    const normalized = normalizeExportTarget(target);
    const star = normalized.indexOf('*');
    if (star < 0) {
        return normalized === relativeFile ? '' : undefined;
    }
    const prefix = normalized.slice(0, star);
    const suffix = normalized.slice(star + 1);
    if (!relativeFile.startsWith(prefix) || !relativeFile.endsWith(suffix)) {
        return undefined;
    }
    return relativeFile.slice(prefix.length, relativeFile.length - suffix.length);
}

function normalizeExportTarget(target: string): string {
    return normalizePath(target.replace(/^\.\//, ''));
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
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

// Kept as a re-export for consumers which historically imported this helper from ShadowManager.
export { resolveTsGoPath } from './TsGoEngine';

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
