import path from 'node:path';

const OVERLAY_MARKER = '/node_modules/.cache/svelte-lsp/svelte/';
const OUTSIDE_ROOT_MARKER = '__outside/';

/**
 * Normalize one native FILE record to the source program identity used by the checker oracle.
 *
 * Ordinary TypeScript files may be copied beside generated Svelte shadows so native module
 * resolution can distinguish `Widget.svelte` from `Widget.svelte.ts`. Those copies live below
 * a package-local `node_modules/.cache/svelte-lsp/svelte` directory. Reverse that mapping before
 * applying the normal node_modules exclusion; filtering first makes a present source file look
 * absent from the native program.
 */
export function normalizeCheckerProgramPath(filename, project, membershipRoot) {
    const absolute = normalizePath(
        path.isAbsolute(filename) ? filename : path.resolve(project, filename)
    );
    const source = sourcePathForOverlay(absolute, membershipRoot);
    const relative = normalizePath(path.relative(membershipRoot, source));
    return relative && !relative.startsWith('../') ? relative : source;
}

/**
 * Return unique source membership plus raw aliases which collapsed to one authored file.
 * Aliases remain explicit: membership comparison should not report false missing files, while a
 * real+mirror double identity must still fail the oracle because it can produce nominally
 * incompatible copies of the same exported type.
 */
export function normalizeCheckerProgramMembership(
    filenames,
    { project, membershipRoot, isImplementationFile = () => false }
) {
    const rawBySource = new Map();
    for (const filename of filenames) {
        const source = normalizeCheckerProgramPath(filename, project, membershipRoot);
        if (
            isImplementationFile(source) ||
            source.includes('/node_modules/') ||
            source.startsWith('node_modules/')
        ) {
            continue;
        }
        const raw = normalizePath(
            path.isAbsolute(filename) ? filename : path.resolve(project, filename)
        );
        const records = rawBySource.get(source);
        if (records) {
            records.add(raw);
        } else {
            rawBySource.set(source, new Set([raw]));
        }
    }

    return {
        files: [...rawBySource.keys()].sort(),
        aliases: [...rawBySource]
            .filter(([, records]) => records.size > 1)
            .map(([source, records]) => ({ source, records: [...records].sort() }))
            .sort((left, right) => left.source.localeCompare(right.source))
    };
}

function sourcePathForOverlay(absolute, membershipRoot) {
    const markerAt = absolute.indexOf(OVERLAY_MARKER);
    if (markerAt < 0) {
        return absolute;
    }
    const relative = absolute.slice(markerAt + OVERLAY_MARKER.length);
    if (relative.startsWith(OUTSIDE_ROOT_MARKER)) {
        const encoded = relative.slice(OUTSIDE_ROOT_MARKER.length);
        // The outside-root encoding removes the leading slash on POSIX and the colon from a
        // Windows drive. Preserve a useful absolute identity on both platforms.
        if (/^[A-Za-z]\//.test(encoded)) {
            return `${encoded[0]}:/${encoded.slice(2)}`;
        }
        return normalizePath(path.resolve('/', encoded));
    }
    return normalizePath(path.resolve(membershipRoot, relative));
}

function normalizePath(value) {
    return value.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
}
