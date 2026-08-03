import { createHash } from 'crypto';
import fs from 'fs';
import { extname, isAbsolute, join, relative, resolve } from 'path';
import { normalizePath } from '../../../utils';
import { DirectoryMembershipProof } from './MaterialisationPlanCache';

export const BATCH_GRAPH_DIRECTORY_VALIDATOR = 'tsgo:batch-graph-directory-membership:v3';

/**
 * Directory validation runs synchronously before a cached editor project can answer requests.
 * Keep the proof exact, but put a hard ceiling on the amount of filesystem work a cache hit may
 * demand. Exceeding either bound makes the validator unavailable and therefore turns the lookup
 * into a normal cache miss; it must never turn a pathological tree into an event-loop stall.
 */
export interface BatchGraphDirectoryMembershipBudget {
    readonly maxEntries: number;
    readonly maxDurationMs: number;
    /**
     * A validation pass can contain many pnpm/workspace aliases of the same physical package.
     * Their v3 proof is byte-for-byte identical because it is rooted at the canonical directory.
     * Reuse that completed proof only inside this one bounded pass; a later lookup/publication
     * receives a fresh budget and therefore re-observes the filesystem.
     */
    readonly proofsByRealRoot: Map<
        string,
        { proof: DirectoryMembershipProof; svelteRelativePaths: readonly string[] }
    >;
    deadline: number | undefined;
    entries: number;
    exhausted: boolean;
}

export function createBatchGraphDirectoryMembershipBudget(
    options: { maxEntries?: number; maxDurationMs?: number } = {}
): BatchGraphDirectoryMembershipBudget {
    return {
        maxEntries: options.maxEntries ?? 250_000,
        maxDurationMs: options.maxDurationMs ?? 750,
        proofsByRealRoot: new Map(),
        deadline: undefined,
        entries: 0,
        exhausted: false
    };
}

const GRAPH_SOURCE_EXTENSIONS = new Set([
    '.svelte',
    '.ts',
    '.tsx',
    '.mts',
    '.mtsx',
    '.cts',
    '.ctsx',
    '.js',
    '.jsx',
    '.mjs',
    '.mjsx',
    '.cjs',
    '.cjsx',
    '.json'
]);

function isGraphMembershipFile(name: string): boolean {
    const extension = extname(name).toLowerCase();
    return extension === '' || GRAPH_SOURCE_EXTENSIONS.has(extension);
}

/**
 * Whether this validator observes creation/deletion/topology at an exact descendant path.
 *
 * This mirrors the walk boundary below and is intentionally conservative. In particular, an
 * excluded dependency/generated directory, a nested repository, or a directory symlink ends
 * coverage because the membership proof does not descend through it. Missing ancestors remain
 * covered: creating the first directory necessarily changes the proof before the leaf can exist.
 */
export function batchGraphDirectoryMembershipCoversPath(
    rootPath: string,
    inputPath: string
): boolean {
    const root = normalizePath(resolve(rootPath));
    const input = normalizePath(resolve(inputPath));
    const relativeInput = normalizePath(relative(root, input));
    if (!relativeInput || relativeInput.startsWith('..') || isAbsolute(relativeInput)) {
        return false;
    }
    const parts = relativeInput.split('/');
    const excluded = new Set(['node_modules', '.git', '.hg', '.svn', '.svelte-ls-overlay']);
    if (parts.some((part) => excluded.has(part))) {
        return false;
    }

    let current = root;
    for (let index = 0; index < parts.length - 1; index++) {
        current = normalizePath(join(current, parts[index]!));
        let stat: fs.Stats | undefined;
        try {
            stat = fs.lstatSync(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return true;
            }
            return false;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            return false;
        }
        if (fs.existsSync(join(current, '.git'))) {
            return false;
        }
    }

    let leaf: fs.Stats | undefined;
    try {
        leaf = fs.lstatSync(input);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return false;
        }
    }
    return (
        !!leaf?.isSymbolicLink() ||
        !!leaf?.isDirectory() ||
        (!!leaf && !leaf.isFile()) ||
        isGraphMembershipFile(parts.at(-1)!)
    );
}

/**
 * Exact recursive topology proof for files which can participate in a TypeScript/Svelte graph.
 * Dependency/VCS/generated trees are separate graph inputs and are not followed from a workspace
 * root. Directory symlinks are followed once so pnpm/workspace retargeting remains observable.
 */
export function batchGraphDirectoryMembership(request: {
    path: string;
    validator: string;
    budget?: BatchGraphDirectoryMembershipBudget;
    /** Optional exact scan by-product used to avoid a second broad dependency walk. */
    svelteFiles?: string[];
}): DirectoryMembershipProof | undefined {
    if (request.validator !== BATCH_GRAPH_DIRECTORY_VALIDATOR) {
        return undefined;
    }
    const root = normalizePath(resolve(request.path));
    const entries: string[] = [];
    const svelteRelativePaths: string[] = [];
    const visited = new Set<string>();
    const excluded = new Set(['node_modules', '.git', '.hg', '.svn', '.svelte-ls-overlay']);
    const budget = request.budget ?? createBatchGraphDirectoryMembershipBudget();

    const consume = (count = 1) => {
        budget.deadline ??= performance.now() + budget.maxDurationMs;
        budget.entries += count;
        if (budget.entries > budget.maxEntries || performance.now() > budget.deadline) {
            budget.exhausted = true;
            throw new BatchGraphDirectoryBudgetExceeded();
        }
    };

    let realRoot: string;
    try {
        consume();
        realRoot = normalizePath(fs.realpathSync(root));
        const cached = budget.proofsByRealRoot.get(realRoot);
        if (cached) {
            for (const relativePath of cached.svelteRelativePaths) {
                request.svelteFiles?.push(normalizePath(join(root, relativePath)));
            }
            return { ...cached.proof };
        }
    } catch (error) {
        if (error instanceof BatchGraphDirectoryBudgetExceeded) {
            return undefined;
        }
        throw error;
    }

    const walk = (directory: string, prefix: string) => {
        consume();
        const beforeDirectory = directoryIdentity(directory);
        const realDirectory = normalizePath(fs.realpathSync(directory));
        const repeated = visited.has(realDirectory);
        entries.push(`@directory\0${prefix}\0${realDirectory}\0${repeated ? 'repeat' : 'first'}`);
        if (repeated) {
            return;
        }
        visited.add(realDirectory);
        if (prefix && fs.existsSync(join(directory, '.git'))) {
            entries.push(`@nested-repository\0${prefix}\0${realDirectory}`);
            if (directoryIdentity(directory) !== beforeDirectory) {
                throw new BatchGraphDirectoryConcurrentMutation();
            }
            return;
        }
        const children = fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) {
            consume();
            if (excluded.has(child.name)) {
                continue;
            }
            const absolute = normalizePath(join(directory, child.name));
            const name = prefix ? `${prefix}/${child.name}` : child.name;
            if (child.isSymbolicLink()) {
                const beforeLink = pathIdentity(absolute, true);
                const target = fs.readlinkSync(absolute);
                let targetKind = 'missing';
                try {
                    const stat = fs.statSync(absolute);
                    targetKind = stat.isDirectory()
                        ? 'directory'
                        : stat.isFile()
                          ? 'file'
                          : 'other';
                } catch {
                    // A dangling link is still exact graph topology and remains in the proof.
                }
                entries.push(`${name}\0symlink\0${target}\0${targetKind}`);
                if (targetKind === 'file' && child.name.endsWith('.svelte')) {
                    svelteRelativePaths.push(name);
                    request.svelteFiles?.push(absolute);
                }
                // The source scanners use Dirent.isDirectory()/isFile() and deliberately do not
                // follow nested symlinks. Mirror that exact boundary here: the link spelling,
                // target and target kind are proof inputs, while the external target tree is not
                // part of this root's materialisation corpus.
                if (pathIdentity(absolute, true) !== beforeLink) {
                    throw new BatchGraphDirectoryConcurrentMutation();
                }
            } else if (child.isDirectory()) {
                entries.push(`${name}\0directory`);
                walk(absolute, name);
            } else if (child.isFile()) {
                if (isGraphMembershipFile(child.name)) {
                    entries.push(`${name}\0file`);
                    if (child.name.endsWith('.svelte')) {
                        svelteRelativePaths.push(name);
                        request.svelteFiles?.push(absolute);
                    }
                }
            } else {
                entries.push(`${name}\0other`);
            }
        }
        if (directoryIdentity(directory) !== beforeDirectory) {
            throw new BatchGraphDirectoryConcurrentMutation();
        }
    };
    try {
        walk(root, '');
    } catch (error) {
        if (
            error instanceof BatchGraphDirectoryBudgetExceeded ||
            error instanceof BatchGraphDirectoryConcurrentMutation
        ) {
            return undefined;
        }
        throw error;
    }
    const proof = {
        stamp: createHash('sha256').update(entries.join('\0')).digest('base64url'),
        entryCount: entries.length
    };
    budget.proofsByRealRoot.set(realRoot, {
        proof,
        svelteRelativePaths: [...svelteRelativePaths]
    });
    return proof;
}

class BatchGraphDirectoryBudgetExceeded extends Error {}
class BatchGraphDirectoryConcurrentMutation extends Error {}

function directoryIdentity(path: string): string {
    return pathIdentity(path, false);
}

function pathIdentity(path: string, lexical: boolean): string {
    const stat = lexical
        ? fs.lstatSync(path, { bigint: true })
        : fs.statSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
