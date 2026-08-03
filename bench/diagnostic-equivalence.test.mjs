import assert from 'node:assert/strict';
import test from 'node:test';
import {
    diagnosticMessagesEquivalent,
    diagnosticMultisetDifference,
    diagnosticRecordsEquivalent
} from './diagnostic-equivalence.mjs';

const range = {
    start: { line: 1, character: 2 },
    end: { line: 1, character: 3 }
};

function diagnostic(message, overrides = {}) {
    return {
        type: 'ERROR',
        filename: 'src/App.svelte',
        range,
        message,
        severity: 1,
        code: 2339,
        source: 'ts',
        relatedInformation: [],
        ...overrides
    };
}

test('messages are exact unless classic explicitly emitted a structural elision', () => {
    assert.equal(diagnosticMessagesEquivalent('plain message', 'plain message'), true);
    assert.equal(diagnosticMessagesEquivalent('plain message', 'changed message'), false);
    assert.equal(
        diagnosticMessagesEquivalent(
            "Property 'x' does not exist on type '{ a: { ...; }; }'.",
            "Property 'x' does not exist on type '{ a: { b: { c: string; }; d: number; }; }'."
        ),
        true
    );
    assert.equal(
        diagnosticMessagesEquivalent(
            "Property 'x' does not exist on type '{ a: { ...; }; }'.",
            "Property 'y' does not exist on type '{ a: { b: string; }; }'."
        ),
        false
    );
});

test('multiple structural elisions are matched independently and symmetrically', () => {
    const elided = "Type '{ left: { ...; }; right: { ...; }; }' is not assignable.";
    const expanded =
        "Type '{ left: { deep: { value: string; }; }; right: { value: number; }; }' is not assignable.";
    assert.equal(diagnosticMessagesEquivalent(elided, expanded), true);
    assert.equal(diagnosticMessagesEquivalent(expanded, elided), true);
});

test('all non-message diagnostic and related-information fields stay exact', () => {
    const elided = diagnostic("Missing on '{ value: { ...; }; }'.", {
        relatedInformation: [
            { message: "Declared as '{ ...; }'.", location: { uri: 'file:///a', range } }
        ]
    });
    const expanded = diagnostic("Missing on '{ value: { nested: string; }; }'.", {
        relatedInformation: [
            {
                message: "Declared as '{ nested: { value: string; }; }'.",
                location: { uri: 'file:///a', range }
            }
        ]
    });
    assert.equal(diagnosticRecordsEquivalent(elided, expanded), true);
    assert.equal(diagnosticRecordsEquivalent(elided, { ...expanded, code: 2345 }), false);
    assert.equal(
        diagnosticRecordsEquivalent(elided, {
            ...expanded,
            relatedInformation: [
                { ...expanded.relatedInformation[0], location: { uri: 'file:///b', range } }
            ]
        }),
        false
    );
});

test('multiset comparison preserves duplicate diagnostic counts', () => {
    const elided = diagnostic("Missing on '{ value: { ...; }; }'.");
    const expanded = diagnostic("Missing on '{ value: { nested: string; }; }'.");
    assert.deepEqual(diagnosticMultisetDifference([elided, elided], [expanded]), {
        onlyLeft: [elided],
        onlyRight: []
    });
});
