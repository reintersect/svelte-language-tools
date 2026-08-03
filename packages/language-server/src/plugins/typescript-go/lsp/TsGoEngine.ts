import fs from 'fs';
import { createHash } from 'crypto';
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
    /** Native TypeScript identity when the npm wrapper carries more than one compiler channel. */
    compilerVersion?: string;
    compilerGitHead?: string;
    channel?: 'tsc' | 'tsc-next';
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

/** Public package identities which npm may install as aliases of TypeScript's native package. */
const TYPESCRIPT_NATIVE_ALIASES = new Set(['@typescript/native', '@typescript/native-preview']);

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
            if (!manifestNameMatchesRequest(manifest.name, packageName)) {
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
            if (packageName === '@reintersect/effect-tsgo') {
                const native = resolveEffectNativeEngine(packageRoot, version, searchPaths);
                if (!native) {
                    continue;
                }
                return {
                    packageName,
                    version,
                    packageRoot,
                    binPath: native.binPath,
                    command: native.binPath,
                    argsPrefix: [],
                    apiEntry: resolveEffectApiEntry(packageRoot, version, native),
                    compilerVersion: native.tsVersion,
                    compilerGitHead: native.tsGitHead,
                    channel: native.channel
                };
            }
            const binPath = resolve(packageRoot, binRelative);
            if (
                !isWithin(packageRoot, binPath) ||
                !fs.statSync(binPath, { throwIfNoEntry: false })?.isFile()
            ) {
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

interface EffectNativeEngine {
    channel: 'tsc' | 'tsc-next';
    binPath: string;
    tsVersion: string;
    tsGitHead: string;
}

/** Resolve the exact platform binary selected by Effect's launcher, freezing the channel now. */
function resolveEffectNativeEngine(
    packageRoot: string,
    packageVersion: string,
    searchPaths: string[]
): EffectNativeEngine | undefined {
    const channel = process.env.ETSGO_CHANNEL === 'next' ? 'tsc-next' : 'tsc';
    const platformPackage = `@reintersect/effect-tsgo-${process.platform}-${process.arch}`;
    const manifestPath = resolvePackageManifest(platformPackage, [packageRoot, ...searchPaths]);
    if (!manifestPath) {
        return undefined;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.name !== platformPackage || manifest.version !== packageVersion) {
            return undefined;
        }
        const platformRoot = dirname(manifestPath);
        const executable = channel + (process.platform === 'win32' ? '.exe' : '');
        const binPath = join(platformRoot, 'lib', executable);
        if (!fs.statSync(binPath, { throwIfNoEntry: false })?.isFile()) {
            return undefined;
        }
        if (process.platform !== 'win32') {
            try {
                fs.accessSync(binPath, fs.constants.X_OK);
            } catch {
                // Match Effect's launcher recovery before bypassing it. Package extraction can
                // lose executable bits; fixing this trusted installed binary is both narrower
                // and safer than launching a mismatched channel through the mutable JS wrapper.
                try {
                    fs.chmodSync(binPath, 0o755);
                    fs.accessSync(binPath, fs.constants.X_OK);
                } catch {
                    return undefined;
                }
            }
        }
        const metadataPath = [`${binPath}.json`, join(platformRoot, 'lib', `${channel}.json`)].find(
            (candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()
        );
        if (!metadataPath) {
            return undefined;
        }
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (
            typeof metadata.tsVersion !== 'string' ||
            metadata.tsVersion.trim().length === 0 ||
            typeof metadata.tsGitHead !== 'string' ||
            !/^[0-9a-f]{40}$/i.test(metadata.tsGitHead)
        ) {
            return undefined;
        }
        return {
            channel,
            binPath,
            tsVersion: metadata.tsVersion,
            tsGitHead: metadata.tsGitHead.toLowerCase()
        };
    } catch {
        return undefined;
    }
}

/**
 * Resolve only a client proven to match the selected Effect binary.
 *
 * New Effect packages can carry the intact upstream package themselves. Older stable releases
 * use the language server's tested bundle. Deliberately do not inspect workspace `typescript`:
 * an almost-matching preview client can attach and then fail nondeterministically mid-request.
 */
function resolveEffectApiEntry(
    effectPackageRoot: string,
    effectPackageVersion: string,
    native: EffectNativeEngine
): string | undefined {
    for (const root of [
        join(effectPackageRoot, 'dist', 'api-clients', native.channel),
        join(effectPackageRoot, 'dist', 'api-clients', native.channel, 'package')
    ]) {
        const entry = matchingUpstreamApiEntry(root, native);
        if (entry) {
            return entry;
        }
    }

    const languageServerManifest = findOwningManifest(
        __filename,
        '@reintersect/svelte-language-server'
    );
    if (!languageServerManifest) {
        return undefined;
    }
    const versionRoot = join(
        dirname(languageServerManifest),
        'vendor',
        'tsgo-api',
        native.tsVersion
    );
    const metadataPath = join(versionRoot, 'metadata.json');
    const entry = join(versionRoot, 'api.mjs');
    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        if (
            metadata.sourcePackage !== 'typescript' ||
            metadata.effectPackage !== '@reintersect/effect-tsgo' ||
            !Array.isArray(metadata.effectPackageVersions) ||
            !metadata.effectPackageVersions.includes(effectPackageVersion) ||
            metadata.tsVersion !== native.tsVersion ||
            String(metadata.tsGitHead).toLowerCase() !== native.tsGitHead ||
            typeof metadata.bundleSha256 !== 'string' ||
            createHash('sha256')
                .update(fs.readFileSync(entry).toString('latin1'), 'latin1')
                .digest('hex') !== metadata.bundleSha256
        ) {
            return undefined;
        }
        return entry;
    } catch {
        return undefined;
    }
}

function matchingUpstreamApiEntry(
    packageRoot: string,
    native: EffectNativeEngine
): string | undefined {
    const manifestPath = join(packageRoot, 'package.json');
    const entry = join(packageRoot, 'dist', 'api', 'async', 'api.js');
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return manifest.name === 'typescript' &&
            manifest.version === native.tsVersion &&
            String(manifest.gitHead).toLowerCase() === native.tsGitHead &&
            fs.statSync(entry, { throwIfNoEntry: false })?.isFile()
            ? entry
            : undefined;
    } catch {
        return undefined;
    }
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
        return manifestNameMatchesRequest(
            JSON.parse(fs.readFileSync(candidate, 'utf8')).name,
            packageName
        );
    } catch {
        return false;
    }
}

/**
 * npm aliases retain the requested node_modules key while exposing the target package's own
 * manifest. TypeScript 7's native package is named `typescript`, including when installed as
 * `@typescript/native`; no other requested package identity may borrow that exception.
 */
function manifestNameMatchesRequest(manifestName: unknown, packageName: string): boolean {
    return (
        manifestName === packageName ||
        (manifestName === 'typescript' && TYPESCRIPT_NATIVE_ALIASES.has(packageName))
    );
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
