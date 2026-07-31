import fs from 'fs';
import { dirname, resolve, sep } from 'path';
import * as prettier from 'prettier';
import * as svelte from 'svelte/compiler';
import { Logger } from './logger';

/**
 * Whether or not the current workspace can be trusted.
 * TODO rework this to a class which depends on the LsConfigManager
 * and inject that class into all places where it's needed (Document etc.)
 */
let isTrusted = true;
const importedSveltePackageRoots = new Set<string>();

export function setIsTrusted(_isTrusted: boolean) {
    isTrusted = _isTrusted;
}

/**
 * This function encapsulates the require call in one place
 * so we can replace its content inside rollup builds
 * so it's not transformed.
 */
function dynamicRequire(dynamicFileToRequire: string): any {
    // prettier-ignore
    return require(dynamicFileToRequire);
}

export function getPackageInfo(packageName: string, fromPath: string, use_fallback = true) {
    const paths: string[] = [];
    if (isTrusted) {
        paths.push(fromPath);
    }
    if (use_fallback) {
        paths.push(__dirname);
    }

    const packageJSONPath = require.resolve(`${packageName}/package.json`, {
        paths
    });
    // Manifests are data, not modules. Reading them directly avoids Node's require cache serving
    // the previous version after a watched package-manager update.
    const { version } = JSON.parse(fs.readFileSync(packageJSONPath, 'utf8'));
    const [major, minor, patch] = version.split('.');

    return {
        path: dirname(packageJSONPath),
        version: {
            full: version,
            major: Number(major),
            minor: Number(minor),
            patch: Number(patch)
        }
    };
}

export function importPrettier(fromPath: string): typeof prettier {
    const pkg = getPackageInfo('prettier', fromPath);
    const main = resolve(pkg.path);
    Logger.debug('Using Prettier v' + pkg.version.full, 'from', main);
    return dynamicRequire(main);
}

export function importSvelte(fromPath: string, use_fallback = true): typeof svelte {
    const pkg = getPackageInfo('svelte', fromPath, use_fallback);
    importedSveltePackageRoots.add(pkg.path);
    const main = resolve(pkg.path, 'compiler');
    Logger.debug('Using Svelte v' + pkg.version.full, 'from', main);
    if (pkg.version.major === 4) {
        return dynamicRequire(main + '.cjs');
    } else {
        return dynamicRequire(main);
    }
}

/** Forget workspace Svelte compiler modules after a package graph change. */
export function invalidateImportedSveltePackages(): void {
    for (const modulePath of Object.keys(require.cache)) {
        if (
            [...importedSveltePackageRoots].some(
                (root) => modulePath === root || modulePath.startsWith(root + sep)
            )
        ) {
            delete require.cache[modulePath];
        }
    }
    importedSveltePackageRoots.clear();
}

/** Can throw because no fallback guaranteed */
export function importSveltePreprocess(fromPath: string): any {
    const pkg = getPackageInfo(
        'svelte-preprocess',
        fromPath,
        false // svelte-language-server doesn't have a dependency on svelte-preprocess so we can't provide a fallback
    );
    const main = resolve(pkg.path);
    Logger.debug('Using svelte-preprocess v' + pkg.version.full, 'from', main);
    return dynamicRequire(main);
}
