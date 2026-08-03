import { isDeepStrictEqual } from 'node:util';

const STRUCTURAL_TYPE_ELISION = '{ ...; }';

/**
 * TypeScript's JavaScript and native compilers occasionally render the same diagnostic type at
 * different depths even when both are passed `--noErrorTruncation`. The JavaScript compiler marks
 * the omitted structural type with the literal `{ ...; }`. Treat only that compiler-authored
 * marker as a wildcard; every character which classic actually emitted must still match.
 */
export function diagnosticMessagesEquivalent(left, right) {
    if (left === right) return true;
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    return elidedMessageMatches(left, right) || elidedMessageMatches(right, left);
}

/** Compare the full normalized diagnostic, allowing only the explicit message elision above. */
export function diagnosticRecordsEquivalent(left, right) {
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;

    const { message: leftMessage, relatedInformation: leftRelated = [], ...leftRest } = left;
    const { message: rightMessage, relatedInformation: rightRelated = [], ...rightRest } = right;
    if (
        !isDeepStrictEqual(leftRest, rightRest) ||
        !diagnosticMessagesEquivalent(leftMessage, rightMessage) ||
        leftRelated.length !== rightRelated.length
    ) {
        return false;
    }

    return leftRelated.every((leftEntry, index) => {
        const rightEntry = rightRelated[index];
        const { message: leftRelatedMessage, ...leftRelatedRest } = leftEntry;
        const { message: rightRelatedMessage, ...rightRelatedRest } = rightEntry;
        return (
            isDeepStrictEqual(leftRelatedRest, rightRelatedRest) &&
            diagnosticMessagesEquivalent(leftRelatedMessage, rightRelatedMessage)
        );
    });
}

/** Preserve multiplicity while pairing equivalent diagnostic records. */
export function diagnosticMultisetDifference(left, right) {
    const remainingRight = [...right];
    const onlyLeft = [];
    for (const leftRecord of left) {
        const match = remainingRight.findIndex((rightRecord) =>
            diagnosticRecordsEquivalent(leftRecord, rightRecord)
        );
        if (match < 0) onlyLeft.push(leftRecord);
        else remainingRight.splice(match, 1);
    }
    return { onlyLeft, onlyRight: remainingRight };
}

function elidedMessageMatches(elided, expanded) {
    if (!elided.includes(STRUCTURAL_TYPE_ELISION)) return false;

    let pattern = '^';
    let cursor = 0;
    for (;;) {
        const marker = elided.indexOf(STRUCTURAL_TYPE_ELISION, cursor);
        if (marker < 0) break;
        pattern += escapeRegex(elided.slice(cursor, marker));
        // The anchored suffix forces this non-greedy match to consume the complete nested type,
        // including any inner braces, rather than accepting a changed diagnostic around it.
        pattern += String.raw`\{[\s\S]+?\}`;
        cursor = marker + STRUCTURAL_TYPE_ELISION.length;
    }
    pattern += escapeRegex(elided.slice(cursor)) + '$';
    return new RegExp(pattern, 'u').test(expanded);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
