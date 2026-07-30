import { Location, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { mapRangeToOriginal } from '../../../lib/documents';
import { pathToUrl, urlToPath } from '../../../utils';
import { SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { ShadowManager } from './ShadowManager';

/** A range that failed to map has a negative line; see SourceMapDocumentMapper. */
export function isMapped(range: Range | undefined | null): range is Range {
    return !!range && range.start.line >= 0 && range.end.line >= 0;
}

/**
 * Translate a location that may point into a generated shadow back to the `.svelte` file it
 * stands for. Locations in ordinary `.ts`/`.d.ts` files pass through untouched.
 *
 * Returns undefined when the target maps entirely into generated scaffolding, which is the
 * signal to drop the result rather than send the user somewhere arbitrary.
 */
export function mapLocationBack(
    shadows: ShadowManager,
    uri: string,
    range: Range
): Location | undefined {
    const filePath = urlToPath(uri);
    const originalPath = filePath ? shadows.getOriginalPath(filePath) : undefined;
    if (!originalPath) {
        return Location.create(uri, range);
    }

    const snapshot = shadows.getSnapshot(originalPath);
    if (!snapshot) {
        return undefined;
    }
    const mapped = mapRangeToOriginal(snapshot, range);
    if (!isMapped(mapped)) {
        return undefined;
    }
    return Location.create(pathToUrl(originalPath), mapped);
}

/** Map a whole WorkspaceEdit's `changes` back to original files, dropping unmappable edits. */
export function mapWorkspaceEditBack(
    shadows: ShadowManager,
    edit: WorkspaceEdit | null | undefined
): WorkspaceEdit | null {
    if (!edit) {
        return null;
    }

    const changes: Record<string, TextEdit[]> = {};
    const add = (uri: string, edits: TextEdit[]) => {
        if (!edits.length) {
            return;
        }
        changes[uri] = (changes[uri] ?? []).concat(edits);
    };

    const mapEdits = (uri: string, edits: TextEdit[]) => {
        const filePath = urlToPath(uri);
        const originalPath = filePath ? shadows.getOriginalPath(filePath) : undefined;
        if (!originalPath) {
            add(uri, edits);
            return;
        }
        const snapshot = shadows.getSnapshot(originalPath);
        if (!snapshot) {
            return;
        }
        const mapped = edits
            .map((textEdit) => {
                const range = mapRangeToOriginal(snapshot, textEdit.range);
                return isMapped(range) ? { ...textEdit, range } : undefined;
            })
            .filter((e): e is TextEdit => !!e);
        add(pathToUrl(originalPath), mapped);
    };

    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
        mapEdits(uri, edits);
    }
    for (const change of edit.documentChanges ?? []) {
        // Only plain text edits are translated; create/rename/delete file operations refer to
        // shadows and have no meaningful counterpart in the user's tree.
        if ('textDocument' in change && Array.isArray(change.edits)) {
            mapEdits(change.textDocument.uri, change.edits as TextEdit[]);
        }
    }

    return Object.keys(changes).length ? { changes } : null;
}

/**
 * Decode LSP's relative semantic-token encoding into absolute tuples.
 * Each token is [deltaLine, deltaStartChar, length, tokenType, tokenModifiers].
 */
export function decodeSemanticTokens(
    data: number[]
): Array<[line: number, char: number, length: number, type: number, modifiers: number]> {
    const out: Array<[number, number, number, number, number]> = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
        const deltaLine = data[i];
        const deltaChar = data[i + 1];
        line += deltaLine;
        char = deltaLine === 0 ? char + deltaChar : deltaChar;
        out.push([line, char, data[i + 2], data[i + 3], data[i + 4]]);
    }
    return out;
}

/** Build a translation table from tsgo's token legend into ours. */
export function buildLegendMap(from: string[], to: string[]): number[] {
    const target = new Map(to.map((name, index) => [name, index]));
    return from.map((name) => target.get(name) ?? -1);
}

export function mapTokenRangeBack(
    snapshot: SvelteDocumentSnapshot,
    line: number,
    char: number,
    length: number
): { line: number; char: number; length: number } | undefined {
    const start = { line, character: char };
    const end = { line, character: char + length };
    const mapped = mapRangeToOriginal(snapshot, { start, end });
    if (!isMapped(mapped)) {
        return undefined;
    }
    // Tokens that collapse (or invert) mapped onto generated scaffolding rather than real
    // source — the svelte2tsx render function wrapper is the usual culprit.
    if (mapped.start.line !== mapped.end.line) {
        return undefined;
    }
    const mappedLength = mapped.end.character - mapped.start.character;
    if (mappedLength <= 0) {
        return undefined;
    }
    return { line: mapped.start.line, char: mapped.start.character, length: mappedLength };
}
