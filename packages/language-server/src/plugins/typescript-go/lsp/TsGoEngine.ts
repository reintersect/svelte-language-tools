import fs from 'fs';
import { dirname, extname, isAbsolute, join, resolve } from 'path';

/**
 * One resolved tsgo installation.
 *
 * Keeping the launcher and API entry together is important: loading the API client from a
 * different native-preview build than the child process produces failures which look like
 * ordinary missing language features.
 */
export interface ResolvedTsGoEngine {
    packageName: string;
    version: string;
    packageRoot: string;
    binPath: string;
    command: string;
    argsPrefix: string[];
    apiEntry?: string;
}

export interface ResolveTsGoEngineOptions {
    /** Override the normal Effect -> stable native -> preview preference order. */
    packageName?: string;
    /** Additional resolver roots after the workspace and language-server package. */
    searchPaths?: string[];
}

const DEFAULT_PACKAGES = [
    '@reintersect/effect-tsgo',
    '@typescript/native',
    '@typescript/native-preview'
];

/** Resolve the exact tsgo package, launcher and matching optional API client. */
export function resolveTsGoEngine(
    fromPath: string,
    options: ResolveTsGoEngineOptions = {}
): ResolvedTsGoEngine | undefined {
    const selected = options.packageName ?? process.env.SVELTE_LS_TSGO_PACKAGE;
    const candidates = selected ? [selected] : DEFAULT_PACKAGES;
    const searchPaths = [fromPath, __dirname, ...(options.searchPaths ?? [])];

    for (const packageName of candidates) {
        const manifestPath = resolvePackageManifest(packageName, searchPaths);
        if (!manifestPath) {
            continue;
        }
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            // `package.json` is normally resolved by package name, but packages may export that
            // subpath to an arbitrary JSON file. Never pair a requested engine name with a
            // launcher/API owned by a different package.
            if (manifest.name !== packageName) {
                continue;
            }
            const version = manifest.version;
            if (typeof version !== 'string' || version.trim().length === 0) {
                continue;
            }
            const bin = manifest.bin;
            const binRelative = typeof bin === 'string' ? bin : (bin?.tsgo ?? bin?.tsc);
            if (typeof binRelative !== 'string') {
                continue;
            }
            const packageRoot = dirname(manifestPath);
            const binPath = resolve(packageRoot, binRelative);
            if (!fs.existsSync(binPath)) {
                continue;
            }

            const nodeLauncher = isNodeLauncher(binPath);
            return {
                packageName,
                version,
                packageRoot,
                binPath,
                command: nodeLauncher ? process.execPath : binPath,
                argsPrefix: nodeLauncher ? [binPath] : [],
                apiEntry: resolveApiEntry(packageName, packageRoot, searchPaths)
            };
        } catch {
            // A broken candidate must not prevent trying the next supported package.
        }
    }
    return undefined;
}

/** Compatibility helper for callers which only need the executable path. */
export function resolveTsGoPath(fromPath: string): string | undefined {
    return resolveTsGoEngine(fromPath)?.binPath;
}

function resolvePackageManifest(packageName: string, searchPaths: string[]): string | undefined {
    try {
        return require.resolve(`${packageName}/package.json`, { paths: searchPaths });
    } catch {
        // Modern packages may hide package.json behind `exports`; locate it from an entry or
        // node_modules root without requiring it to be a public subpath.
    }

    try {
        const entry = require.resolve(packageName, { paths: searchPaths });
        const found = findOwningManifest(entry, packageName);
        if (found) {
            return found;
        }
    } catch {
        // A CLI-only package may not export `.`; inspect node_modules roots below.
    }

    const packageParts = packageName.split('/');
    for (const searchPath of searchPaths) {
        let current = directoryOf(searchPath);
        for (;;) {
            const candidate = join(current, 'node_modules', ...packageParts, 'package.json');
            if (isMatchingManifest(candidate, packageName)) {
                return candidate;
            }
            const parent = dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
    }
    return undefined;
}

function findOwningManifest(entry: string, packageName: string): string | undefined {
    let current = directoryOf(entry);
    for (;;) {
        const candidate = join(current, 'package.json');
        if (isMatchingManifest(candidate, packageName)) {
            return candidate;
        }
        const parent = dirname(current);
        if (parent === current) {
            return undefined;
        }
        current = parent;
    }
}

function isMatchingManifest(candidate: string, packageName: string): boolean {
    try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')).name === packageName;
    } catch {
        return false;
    }
}

function resolveApiEntry(
    packageName: string,
    packageRoot: string,
    searchPaths: string[]
): string | undefined {
    for (const subpath of ['unstable/async', 'unstable/async.js']) {
        try {
            const entry = require.resolve(`${packageName}/${subpath}`, { paths: searchPaths });
            if (isWithin(packageRoot, entry)) {
                return entry;
            }
        } catch {
            // Fall back to the current preview package layout.
        }
    }
    const legacy = join(packageRoot, 'dist', 'api', 'async', 'api.js');
    return fs.existsSync(legacy) ? legacy : undefined;
}

function isNodeLauncher(binPath: string): boolean {
    if (['.js', '.cjs', '.mjs'].includes(extname(binPath).toLowerCase())) {
        return true;
    }
    try {
        const header = fs.readFileSync(binPath).subarray(0, 160).toString('utf8');
        return /^#![^\n]*(?:node|bun)(?:\s|$)/.test(header);
    } catch {
        return false;
    }
}

function directoryOf(path: string): string {
    const absolute = isAbsolute(path) ? path : resolve(path);
    try {
        return fs.statSync(absolute).isDirectory() ? absolute : dirname(absolute);
    } catch {
        return extname(absolute) ? dirname(absolute) : absolute;
    }
}

function isWithin(root: string, path: string): boolean {
    const relative = path.startsWith(root) ? path.slice(root.length) : undefined;
    return relative === '' || relative?.startsWith('/') || relative?.startsWith('\\') || false;
}
