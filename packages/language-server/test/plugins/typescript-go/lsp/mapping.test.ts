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

    it('preserves document changes, versions, annotations and resource operations', () => {
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

        assert.deepStrictEqual(mapWorkspaceEditBack(lookup, input), {
            documentChanges: [
                {
                    textDocument: { uri: pathToUrl(original), version: 7 },
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
        });
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
