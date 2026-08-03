import assert from 'assert';
import { WorkspaceEdit } from 'vscode-languageserver';
import { pathToUrl } from '../../../../src/utils';
import { ShadowLookup } from '../../../../src/plugins/typescript-go/lsp/ProjectRegistry';
import {
    buildLegendMap,
    mapLegendModifierBits,
    mapWorkspaceEditBack
} from '../../../../src/plugins/typescript-go/lsp/mapping';

describe('typescript-go workspace edit mapping', () => {
    it('maps semantic-token modifier bits through the child legend', () => {
        const mapping = buildLegendMap(
            ['declaration', 'definition', 'readonly', 'static', 'defaultLibrary'],
            ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local']
        );
        assert.strictEqual(
            mapLegendModifierBits((1 << 0) | (1 << 2) | (1 << 4), mapping),
            (1 << 0) | (1 << 3) | (1 << 4)
        );
    });

    it('uses the live source version while preserving annotations and resource operations', () => {
        const shadow = '/workspace/.cache/Thing.svelte.tsx';
        const original = '/workspace/Thing.svelte';
        const renamedShadow = '/workspace/.cache/Renamed.svelte.tsx';
        const renamedOriginal = '/workspace/Renamed.svelte';
        const originals = new Map([
            [shadow, original],
            [renamedShadow, renamedOriginal]
        ]);
        const lookup: ShadowLookup = {
            getOriginalPath: (fileName) => originals.get(fileName),
            ensureSnapshot: () =>
                ({
                    getOriginalPosition: (position: { line: number; character: number }) => ({
                        line: position.line - 1,
                        character: position.character
                    })
                }) as any
        };
        const input: WorkspaceEdit = {
            documentChanges: [
                {
                    textDocument: { uri: pathToUrl(shadow), version: 7 },
                    edits: [
                        {
                            range: {
                                start: { line: 2, character: 3 },
                                end: { line: 2, character: 4 }
                            },
                            newText: 'renamed',
                            annotationId: 'change-1'
                        }
                    ]
                },
                {
                    kind: 'rename',
                    oldUri: pathToUrl(shadow),
                    newUri: pathToUrl(renamedShadow),
                    annotationId: 'change-1'
                },
                {
                    kind: 'create',
                    uri: pathToUrl('/workspace/new.ts')
                }
            ],
            changeAnnotations: {
                'change-1': { label: 'Update component' }
            }
        };

        const requestedVersions: string[] = [];
        assert.deepStrictEqual(
            mapWorkspaceEditBack(lookup, input, undefined, (uri) => {
                requestedVersions.push(uri);
                return 23;
            }),
            {
                documentChanges: [
                    {
                        textDocument: { uri: pathToUrl(original), version: 23 },
                        edits: [
                            {
                                range: {
                                    start: { line: 1, character: 3 },
                                    end: { line: 1, character: 4 }
                                },
                                newText: 'renamed',
                                annotationId: 'change-1'
                            }
                        ]
                    },
                    {
                        kind: 'rename',
                        oldUri: pathToUrl(original),
                        newUri: pathToUrl(renamedOriginal),
                        annotationId: 'change-1'
                    },
                    {
                        kind: 'create',
                        uri: pathToUrl('/workspace/new.ts')
                    }
                ],
                changeAnnotations: {
                    'change-1': { label: 'Update component' }
                }
            }
        );
        assert.deepStrictEqual(requestedVersions, [pathToUrl(original)]);
    });

    it('uses null when the mapped source version is unavailable or closed', () => {
        const shadow = '/workspace/.cache/Thing.svelte.tsx';
        const original = '/workspace/Thing.svelte';
        const lookup: ShadowLookup = {
            getOriginalPath: (fileName) => (fileName === shadow ? original : undefined),
            ensureSnapshot: () =>
                ({
                    getOriginalPosition: (position: { line: number; character: number }) => position
                }) as any
        };
        const input: WorkspaceEdit = {
            documentChanges: [
                {
                    textDocument: { uri: pathToUrl(shadow), version: 99 },
                    edits: [
                        {
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 1 }
                            },
                            newText: 'x'
                        }
                    ]
                }
            ]
        };

        for (const getVersion of [undefined, () => undefined, () => null]) {
            const mapped = mapWorkspaceEditBack(lookup, input, undefined, getVersion);
            assert.strictEqual(
                (mapped?.documentChanges?.[0] as { textDocument: { version: number | null } })
                    .textDocument.version,
                null
            );
        }
    });

    it('preserves versions on real TypeScript edits', () => {
        const lookup: ShadowLookup = {
            getOriginalPath: () => undefined,
            ensureSnapshot: () => undefined
        };
        const input: WorkspaceEdit = {
            documentChanges: [
                {
                    textDocument: { uri: 'file:///workspace/plain.ts', version: 11 },
                    edits: [
                        {
                            range: {
                                start: { line: 0, character: 0 },
                                end: { line: 0, character: 1 }
                            },
                            newText: 'x'
                        }
                    ]
                }
            ]
        };

        assert.deepStrictEqual(
            mapWorkspaceEditBack(lookup, input, undefined, () => 42),
            input
        );
    });

    it('keeps the changes representation for edits returned that way', () => {
        const lookup: ShadowLookup = {
            getOriginalPath: () => undefined,
            ensureSnapshot: () => undefined
        };
        const edit: WorkspaceEdit = {
            changes: {
                'file:///workspace/plain.ts': [
                    {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: 0, character: 1 }
                        },
                        newText: 'x'
                    }
                ]
            }
        };

        assert.deepStrictEqual(mapWorkspaceEditBack(lookup, edit), edit);
    });
});
