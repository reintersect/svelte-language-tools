import assert from 'node:assert/strict';
import test from 'node:test';
import {
    normalizeCheckerProgramMembership,
    normalizeCheckerProgramPath
} from './checker-program-membership.mjs';

const membershipRoot = '/workspace';
const project = '/workspace/apps/dashboard';

test('reverses package-local source mirrors before excluding node_modules', () => {
    const mirror =
        '/workspace/packages/ui/node_modules/.cache/svelte-lsp/svelte/' +
        'packages/ui/src/lib/clipboard.ts';

    assert.equal(
        normalizeCheckerProgramPath(mirror, project, membershipRoot),
        'packages/ui/src/lib/clipboard.ts'
    );
    assert.deepEqual(normalizeCheckerProgramMembership([mirror], { project, membershipRoot }), {
        files: ['packages/ui/src/lib/clipboard.ts'],
        aliases: []
    });
});

test('deduplicates source membership but reports real and mirror aliases', () => {
    const source = '/workspace/packages/facehash/src/lib/core/hash.ts';
    const mirror =
        '/workspace/packages/facehash/node_modules/.cache/svelte-lsp/svelte/' +
        'packages/facehash/src/lib/core/hash.ts';

    assert.deepEqual(
        normalizeCheckerProgramMembership([source, mirror], { project, membershipRoot }),
        {
            files: ['packages/facehash/src/lib/core/hash.ts'],
            aliases: [
                {
                    source: 'packages/facehash/src/lib/core/hash.ts',
                    records: [mirror, source]
                }
            ]
        }
    );
});

test('still excludes actual dependencies after source-mirror reversal', () => {
    const dependency = '/workspace/node_modules/pkg/index.d.ts';
    const mirroredDependency =
        '/workspace/packages/ui/node_modules/.cache/svelte-lsp/svelte/' +
        'node_modules/pkg/index.d.ts';

    assert.deepEqual(
        normalizeCheckerProgramMembership([dependency, mirroredDependency], {
            project,
            membershipRoot
        }),
        { files: [], aliases: [] }
    );
});

test('honours checker implementation exclusions after normalization', () => {
    const implementation = '/language-tools/packages/svelte-check/dist/src/svelte-shims-v4.d.ts';
    assert.deepEqual(
        normalizeCheckerProgramMembership([implementation], {
            project,
            membershipRoot,
            isImplementationFile: (filename) => filename.endsWith('/svelte-shims-v4.d.ts')
        }),
        { files: [], aliases: [] }
    );
});
