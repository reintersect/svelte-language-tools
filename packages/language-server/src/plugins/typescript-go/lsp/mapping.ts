import { Location, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { mapRangeToOriginal } from '../../../lib/documents';
import { pathToUrl, urlToPath } from '../../../utils';
import { SvelteDocumentSnapshot } from '../../typescript/DocumentSnapshot';
import { ShadowLookup } from './ProjectRegistry';

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
    shadows: ShadowLookup,
    uri: string,
    range: Range
): Location | undefined {
    const filePath = urlToPath(uri);
    const originalPath = filePath ? shadows.getOriginalPath(filePath) : undefined;
    if (!originalPath) {
        return Location.create(uri, range);
    }

    const snapshot = shadows.ensureSnapshot(originalPath);
    if (!snapshot) {
        return undefined;
    }
    const mapped = mapRangeToOriginal(snapshot, range);
    if (!isMapped(mapped)) {
        return undefined;
    }
    return Location.create(pathToUrl(originalPath), mapped);
}

/**
 * Map a whole workspace edit back to original files without changing its representation.
 *
 * In particular, `documentChanges` cannot be flattened into `changes`: the VS Code extension
 * consumes `documentChanges` for file-rename edits, and flattening also discards document
 * versions, change annotations and resource operations.
 */
export function mapWorkspaceEditBack(
    shadows: ShadowLookup,
    edit: WorkspaceEdit | null | undefined
): WorkspaceEdit | null {
    if (!edit) {
        return null;
    }

    const mapUri = (uri: string): string => {
        const filePath = urlToPath(uri);
        const originalPath = filePath ? shadows.getOriginalPath(filePath) : undefined;
        return originalPath ? pathToUrl(originalPath) : uri;
    };

    const mapEdits = (
        uri: string,
        edits: TextEdit[]
    ): { uri: string; edits: TextEdit[] } | undefined => {
        const filePath = urlToPath(uri);
        const originalPath = filePath ? shadows.getOriginalPath(filePath) : undefined;
        if (!originalPath) {
            return { uri, edits };
        }
        const snapshot = shadows.ensureSnapshot(originalPath);
        if (!snapshot) {
            return undefined;
        }
        const mapped = edits
            .map((textEdit) => {
                const range = mapRangeToOriginal(snapshot, textEdit.range);
                return isMapped(range) ? { ...textEdit, range } : undefined;
            })
            .filter((e): e is TextEdit => !!e);
        return { uri: pathToUrl(originalPath), edits: mapped };
    };

    const changes: Record<string, TextEdit[]> = {};
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
        const mapped = mapEdits(uri, edits);
        if (mapped?.edits.length) {
            changes[mapped.uri] = (changes[mapped.uri] ?? []).concat(mapped.edits);
        }
    }

    const documentChanges: NonNullable<WorkspaceEdit['documentChanges']> = [];
    for (const change of edit.documentChanges ?? []) {
        if ('textDocument' in change && Array.isArray(change.edits)) {
            const mapped = mapEdits(change.textDocument.uri, change.edits as TextEdit[]);
            if (mapped?.edits.length) {
                documentChanges.push({
                    ...change,
                    textDocument: { ...change.textDocument, uri: mapped.uri },
                    edits: mapped.edits
                });
            }
            continue;
        }

        // Resource operations can target either a real TypeScript file or a generated Svelte
        // shadow. Preserve them in both cases, translating only the shadow URI(s).
        if ('kind' in change) {
            if (change.kind === 'rename') {
                documentChanges.push({
                    ...change,
                    oldUri: mapUri(change.oldUri),
                    newUri: mapUri(change.newUri)
                });
            } else if (change.kind === 'create' || change.kind === 'delete') {
                documentChanges.push({ ...change, uri: mapUri(change.uri) });
            }
        }
    }

    if (!Object.keys(changes).length && !documentChanges.length) {
        return null;
    }
    return {
        ...(Object.keys(changes).length ? { changes } : {}),
        ...(documentChanges.length ? { documentChanges } : {}),
        ...(edit.changeAnnotations ? { changeAnnotations: edit.changeAnnotations } : {})
    };
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

/** Translate a semantic-token modifier bitset between two differently ordered legends. */
export function mapLegendModifierBits(bits: number, legendMap: number[]): number {
    let mapped = 0;
    for (let source = 0; source < legendMap.length && source < 31; source++) {
        if ((bits & (1 << source)) === 0) {
            continue;
        }
        const target = legendMap[source];
        if (target >= 0 && target < 31) {
            mapped |= 1 << target;
        }
    }
    return mapped;
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
