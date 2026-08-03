#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    getTsGoStats,
    now,
    shutdownLanguageServer,
    startLanguageServer,
    summarize
} from './perf-utils.mjs';

const root = path.resolve(import.meta.dirname, '..');
const project = path.resolve(
    process.env.SVELTE_LS_COMPLETION_PROJECT ?? path.join(root, '../reintersect/apps/dashboard')
);
const file = path.resolve(
    process.env.SVELTE_LS_COMPLETION_FILE ??
        path.join(project, 'src/lib/components/composer/Composer.svelte')
);
const packageName = process.env.SVELTE_LS_TSGO_PACKAGE ?? '@reintersect/effect-tsgo';
const rounds = positiveInteger(process.env.SVELTE_LS_COMPLETION_ROUNDS ?? '20', 'rounds');
const uri = pathToFileURL(file).href;
const serverPath = path.join(root, 'packages/language-server/bin/server.js');
const original = fs.readFileSync(file, 'utf8');

const gates = {
    coldMs: positiveNumber(process.env.SVELTE_LS_COMPLETION_COLD_MAX_MS ?? '250', 'cold max'),
    apiMemberP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_API_MEMBER_P95_MS ?? '35',
        'API member p95'
    ),
    templateMemberP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_TEMPLATE_MEMBER_P95_MS ?? '35',
        'template member p95'
    ),
    lspMemberP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_LSP_MEMBER_P95_MS ?? '125',
        'LSP member p95'
    ),
    templateP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_TEMPLATE_P95_MS ?? '40',
        'template p95'
    ),
    resolveP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_RESOLVE_P95_MS ?? '10',
        'member resolve p95'
    ),
    autoImportP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_AUTO_IMPORT_P95_MS ?? '450',
        'auto-import p95'
    ),
    unsupportedP95Ms: positiveNumber(
        process.env.SVELTE_LS_COMPLETION_UNSUPPORTED_P95_MS ?? '20',
        'unsupported p95'
    )
};

let text = original;
let version = 1;
const { client, engine } = await startLanguageServer({
    serverPath,
    project,
    useTsGo: true,
    packageName
});

function positionAt(source, offset) {
    const lines = source.slice(0, offset).split('\n');
    return { line: lines.length - 1, character: lines.at(-1).length };
}

function indexOf(needle, fromOffset = 0) {
    const offset = text.indexOf(needle, fromOffset);
    if (offset < 0) throw new Error(`fixture text not found: ${needle}`);
    return offset;
}

function replaceRange(start, end, replacement) {
    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > text.length
    ) {
        throw new Error(
            `invalid fixture edit range ${start}..${end} for ${text.length} characters`
        );
    }
    const before = text;
    client.notify('textDocument/didChange', {
        textDocument: { uri, version: ++version },
        contentChanges: [
            {
                range: { start: positionAt(before, start), end: positionAt(before, end) },
                rangeLength: end - start,
                text: replacement
            }
        ]
    });
    text = before.slice(0, start) + replacement + before.slice(end);
}

function offsetAtPosition(source, position) {
    let offset = 0;
    for (let line = 0; line < position.line; line++) {
        const next = source.indexOf('\n', offset);
        if (next < 0) throw new Error(`completion edit line ${position.line} is out of bounds`);
        offset = next + 1;
    }
    return offset + position.character;
}

function applyCompletionItem(item, defaultReplacement) {
    const before = text;
    const primaryEdit = item.textEdit
        ? [item.textEdit]
        : defaultReplacement
          ? [
                {
                    range: {
                        start: positionAt(before, defaultReplacement.start),
                        end: positionAt(before, defaultReplacement.end)
                    },
                    newText: item.insertText ?? item.label
                }
            ]
          : [];
    const edits = [...(item.additionalTextEdits ?? []), ...primaryEdit]
        .map((edit) => ({ ...edit, range: edit.range ?? edit.replace }))
        .map((edit) => {
            if (!edit.range) throw new Error('completion edit has neither range nor replace range');
            return {
                ...edit,
                start: offsetAtPosition(before, edit.range.start),
                end: offsetAtPosition(before, edit.range.end)
            };
        })
        .sort((left, right) => right.start - left.start || right.end - left.end);
    if (!edits.length) throw new Error('resolved auto-import completion returned no edits');
    let next = before;
    for (const edit of edits) {
        if (edit.start < 0 || edit.end < edit.start || edit.end > before.length) {
            throw new Error(
                `resolved completion edit is outside the source: ${JSON.stringify(edit)}`
            );
        }
        next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
    }
    client.notify('textDocument/didChange', {
        textDocument: { uri, version: ++version },
        contentChanges: [{ text: next }]
    });
    text = next;
}

async function completionAt(offset, context = { triggerKind: 1 }) {
    const started = now();
    const result = await client.request(
        'textDocument/completion',
        { textDocument: { uri }, position: positionAt(text, offset), context },
        120_000
    );
    return { ms: now() - started, result };
}

async function resolveItem(item) {
    const started = now();
    const result = await client.request('completionItem/resolve', item, 120_000);
    return { ms: now() - started, result };
}

function phaseCount(stats, phase) {
    return stats.phaseTimings?.[phase]?.count ?? 0;
}

function assertLabels(result, label, predicate) {
    const items = Array.isArray(result) ? result : result?.items;
    if (!Array.isArray(items)) {
        throw new Error(`${label} returned a malformed completion result`);
    }
    const labels = items.map((item) => item?.label);
    if (labels.some((itemLabel) => typeof itemLabel !== 'string')) {
        throw new Error(`${label} returned a completion item without a string label`);
    }
    if (!predicate(labels)) {
        throw new Error(
            `${label} returned the wrong items: ${JSON.stringify(labels.slice(0, 20))}`
        );
    }
}

function completionItems(result, label) {
    const items = Array.isArray(result) ? result : result?.items;
    if (!Array.isArray(items)) {
        throw new Error(`${label} returned a malformed completion result`);
    }
    return items;
}

function assertP95(summary, max, label) {
    if (!summary || summary.p95 > max) {
        throw new Error(`${label} p95 ${summary?.p95 ?? 'missing'}ms exceeds ${max}ms`);
    }
}

let opened = false;
try {
    client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'svelte', version, text }
    });
    opened = true;

    const memberNeedle = 'selectedTeam.current';
    const memberCharacter = indexOf(memberNeedle) + 'selectedTeam.'.length;
    const coldBefore = await getTsGoStats(client);
    const cold = await completionAt(memberCharacter + 1);
    const coldMs = cold.ms;
    assertLabels(cold.result, 'cold member completion', (labels) => labels.includes('current'));
    const coldAfter = await getTsGoStats(client);
    const coldIsolatedHits =
        (coldAfter.completionIsolatedHits ?? 0) - (coldBefore.completionIsolatedHits ?? 0);
    const coldProjectResolves =
        phaseCount(coldAfter, 'projectResolve') - phaseCount(coldBefore, 'projectResolve');
    const coldNativeRequests =
        phaseCount(coldAfter, 'completionNative') - phaseCount(coldBefore, 'completionNative');
    if (coldIsolatedHits !== 1 || coldProjectResolves !== 0 || coldNativeRequests !== 0) {
        throw new Error(
            `cold completion crossed the project boundary: ${JSON.stringify({
                coldIsolatedHits,
                coldProjectResolves,
                coldNativeRequests
            })}`
        );
    }

    // Finish project/API warmup and exercise the post-edit path before measuring the typing loop.
    await client.request('textDocument/diagnostic', { textDocument: { uri } }, 120_000);
    await completionAt(memberCharacter + 1);
    replaceRange(memberCharacter, memberCharacter + 1, 'x');
    assertLabels((await completionAt(memberCharacter + 1)).result, 'member edit warmup', (labels) =>
        labels.includes('current')
    );
    replaceRange(memberCharacter, memberCharacter + 1, 'c');
    const restoredMember = (await completionAt(memberCharacter + 1)).result;
    assertLabels(restoredMember, 'member restore warmup', (labels) => labels.includes('current'));
    // VS Code resolves the focused item while the user is still typing. Exercise that path even
    // though checker member entries are self-contained; it must preserve routing and stay local
    // rather than rebuilding the expensive native completion list on every focus change.
    const currentItem = completionItems(restoredMember, 'member restore warmup').find(
        (item) => item.label === 'current'
    );
    if (!currentItem) {
        throw new Error('member restore warmup did not retain the current completion item');
    }
    const resolvedCurrent = await client.request('completionItem/resolve', currentItem, 120_000);
    if (resolvedCurrent?.label !== 'current' || resolvedCurrent?.data?.uri !== uri) {
        throw new Error(
            `member completion resolve lost its routing identity: ${JSON.stringify(resolvedCurrent)}`
        );
    }

    const memberBefore = await getTsGoStats(client);
    const memberSamples = [];
    const memberResolveSamples = [];
    for (let index = 0; index < rounds; index++) {
        replaceRange(memberCharacter, memberCharacter + 1, index % 2 ? 'c' : 'x');
        const response = await completionAt(memberCharacter + 1);
        assertLabels(response.result, 'member completion', (labels) => labels.includes('current'));
        memberSamples.push(response.ms);
        const item = completionItems(response.result, 'member completion').find(
            (candidate) => candidate.label === 'current'
        );
        if (!item) throw new Error('member completion lost current before resolve');
        const resolved = await resolveItem(item);
        if (resolved.result?.label !== 'current') {
            throw new Error('member completion resolve changed its label');
        }
        memberResolveSamples.push(resolved.ms);
    }
    const memberAfter = await getTsGoStats(client);

    // Exercise the same member path through a generated template expression. Script-only speed
    // can hide a slow or incorrectly mapped Svelte completion path.
    const templateMemberStart = text.lastIndexOf(memberNeedle);
    if (templateMemberStart < 0 || templateMemberStart === indexOf(memberNeedle)) {
        throw new Error(`template member fixture not found: ${memberNeedle}`);
    }
    const templateMemberCharacter = templateMemberStart + 'selectedTeam.'.length;
    await completionAt(templateMemberCharacter + 1);
    replaceRange(templateMemberCharacter, templateMemberCharacter + 1, 'x');
    await completionAt(templateMemberCharacter + 1);
    replaceRange(templateMemberCharacter, templateMemberCharacter + 1, 'c');
    await completionAt(templateMemberCharacter + 1);
    const templateMemberBefore = await getTsGoStats(client);
    const templateMemberSamples = [];
    const templateMemberResolveSamples = [];
    for (let index = 0; index < rounds; index++) {
        replaceRange(templateMemberCharacter, templateMemberCharacter + 1, index % 2 ? 'c' : 'x');
        const response = await completionAt(templateMemberCharacter + 1);
        assertLabels(response.result, 'template member completion', (labels) =>
            labels.includes('current')
        );
        templateMemberSamples.push(response.ms);
        const item = completionItems(response.result, 'template member completion').find(
            (candidate) => candidate.label === 'current'
        );
        if (!item) throw new Error('template member completion lost current before resolve');
        const resolved = await resolveItem(item);
        if (resolved.result?.label !== 'current') {
            throw new Error('template member completion resolve changed its label');
        }
        templateMemberResolveSamples.push(resolved.ms);
    }
    const templateMemberAfter = await getTsGoStats(client);

    // Add one stable global-completion context, then warm it once. Subsequent changes touch only
    // the probe variable name so auto-import computation still observes a new native generation.
    const scriptTagStart = indexOf('<script');
    const scriptStart = indexOf('>', scriptTagStart) + 1;
    const probeLine = '\nconst __completion_probe_a = writ;';
    replaceRange(scriptStart, scriptStart, probeLine);
    const probeNameOffset = indexOf('__completion_probe_a') + '__completion_probe_'.length;
    const writEnd = indexOf(' = writ') + ' = writ'.length;
    const autoWarm = await completionAt(writEnd);
    assertLabels(autoWarm.result, 'auto-import warmup', (labels) => labels.includes('writable'));

    const autoSamples = [];
    let latestAutoResult;
    for (let index = 0; index < rounds; index++) {
        replaceRange(probeNameOffset, probeNameOffset + 1, index % 2 ? 'a' : 'b');
        const response = await completionAt(writEnd);
        assertLabels(response.result, 'auto-import completion', (labels) =>
            labels.includes('writable')
        );
        autoSamples.push(response.ms);
        latestAutoResult = response.result;
    }
    const writableItem = completionItems(latestAutoResult, 'auto-import completion').find(
        (item) => item.label === 'writable'
    );
    if (!writableItem) throw new Error('auto-import completion lost writable before resolve');
    const resolvedWritable = await resolveItem(writableItem);
    if (!resolvedWritable.result?.additionalTextEdits?.length) {
        throw new Error(
            `resolved writable completion returned no auto-import edit: ${JSON.stringify(resolvedWritable.result)}`
        );
    }
    applyCompletionItem(resolvedWritable.result, {
        start: writEnd - 'writ'.length,
        end: writEnd
    });
    if (!/= writable;/.test(text)) {
        throw new Error('applying the writable completion did not replace the typed identifier');
    }
    if (!/import\s*\{[^}]*\bwritable\b[^}]*\}\s*from\s*["']svelte\/store["']/.test(text)) {
        throw new Error('applying the writable completion did not add its svelte/store import');
    }

    // Warm the declaration/type cache once, then alter only attributes in the same start tag.
    const componentName = '<EmojiPicker';
    const componentStart = indexOf(componentName);
    const componentCaret = componentStart + componentName.length + 1;
    const attributeCharacter = indexOf('onSelect', componentStart);
    const templateWarm = await completionAt(componentCaret);
    assertLabels(templateWarm.result, 'component prop warmup', (labels) =>
        labels.some((label) => String(label).replace(/\?$/, '') === 'onSelect')
    );
    replaceRange(attributeCharacter, attributeCharacter + 1, 'x');
    assertLabels(
        (await completionAt(componentCaret)).result,
        'component prop edit warmup',
        (labels) => labels.some((label) => label.replace(/\?$/, '') === 'onSelect')
    );
    replaceRange(attributeCharacter, attributeCharacter + 1, 'o');
    assertLabels(
        (await completionAt(componentCaret)).result,
        'component prop restore warmup',
        (labels) => labels.some((label) => label.replace(/\?$/, '') === 'onSelect')
    );

    const templateSamples = [];
    for (let index = 0; index < rounds; index++) {
        replaceRange(attributeCharacter, attributeCharacter + 1, index % 2 ? 'o' : 'x');
        const response = await completionAt(componentCaret);
        assertLabels(response.result, 'component prop completion', (labels) =>
            labels.some((label) => label.replace(/\?$/, '') === 'onSelect')
        );
        templateSamples.push(response.ms);
    }

    // `>` is advertised to the editor for HTML/Emmet, but is intentionally unsupported by the
    // TypeScript provider. Put the caret immediately after the actual trigger character.
    const unsupportedOffset = scriptStart;
    const unsupportedBefore = await getTsGoStats(client);
    const unsupportedSamples = [];
    for (let index = 0; index < rounds; index++) {
        const response = await completionAt(unsupportedOffset, {
            triggerKind: 2,
            triggerCharacter: '>'
        });
        unsupportedSamples.push(response.ms);
    }
    const quotedAttribute = 'aria-label="Close composer"';
    const quotedAttributeOffset = indexOf(quotedAttribute) + 'aria-label="Close '.length;
    unsupportedSamples.push((await completionAt(quotedAttributeOffset)).ms);
    const comment = '<!-- eslint-disable-next-line';
    const commentOffset = indexOf(comment) + '<!-- eslint'.length;
    unsupportedSamples.push((await completionAt(commentOffset)).ms);
    const finalStats = await getTsGoStats(client);

    const summaries = {
        member: summarize(memberSamples),
        memberResolve: summarize(memberResolveSamples),
        templateMember: summarize(templateMemberSamples),
        templateMemberResolve: summarize(templateMemberResolveSamples),
        templateProps: summarize(templateSamples),
        autoImport: summarize(autoSamples),
        unsupported: summarize(unsupportedSamples)
    };
    const apiHits = memberAfter.completionApiHits - memberBefore.completionApiHits;
    const memberNativeRequests =
        phaseCount(memberAfter, 'completionNative') - phaseCount(memberBefore, 'completionNative');
    const templateMemberApiHits =
        templateMemberAfter.completionApiHits - templateMemberBefore.completionApiHits;
    const templateMemberNativeRequests =
        phaseCount(templateMemberAfter, 'completionNative') -
        phaseCount(templateMemberBefore, 'completionNative');
    const memberGate = apiHits > 0 ? gates.apiMemberP95Ms : gates.lspMemberP95Ms;
    const unsupportedNativeRequests =
        phaseCount(finalStats, 'completionNative') -
        phaseCount(unsupportedBefore, 'completionNative');

    const report = {
        engine: { ...engine, ...finalStats.engine },
        project,
        file,
        rounds,
        coldMs: +coldMs.toFixed(1),
        autoImportResolveMs: +resolvedWritable.ms.toFixed(1),
        summaries,
        samples: {
            member: memberSamples.map((value) => +value.toFixed(1)),
            memberResolve: memberResolveSamples.map((value) => +value.toFixed(1)),
            templateMember: templateMemberSamples.map((value) => +value.toFixed(1)),
            templateMemberResolve: templateMemberResolveSamples.map((value) => +value.toFixed(1)),
            templateProps: templateSamples.map((value) => +value.toFixed(1)),
            autoImport: autoSamples.map((value) => +value.toFixed(1)),
            unsupported: unsupportedSamples.map((value) => +value.toFixed(1))
        },
        phaseTimings: finalStats.phaseTimings,
        gates: { ...gates, memberP95Ms: memberGate },
        deltas: {
            coldIsolatedHits,
            coldProjectResolves,
            coldNativeRequests,
            engineGeneration: finalStats.generation - memberBefore.generation,
            memberApiHits: apiHits,
            memberNativeRequests,
            memberResolveNativeRequests:
                phaseCount(memberAfter, 'completionResolveNative') -
                phaseCount(memberBefore, 'completionResolveNative'),
            templateMemberApiHits,
            templateMemberNativeRequests,
            templateMemberResolveNativeRequests:
                phaseCount(templateMemberAfter, 'completionResolveNative') -
                phaseCount(templateMemberBefore, 'completionResolveNative'),
            syncCoalesced: finalStats.syncCoalesced,
            syncReused: finalStats.syncReused,
            nativeCompletionRequests: phaseCount(finalStats, 'completionNative'),
            unsupportedNativeRequests
        }
    };
    console.log(
        process.env.SVELTE_LS_COMPLETION_SUMMARY_ONLY
            ? JSON.stringify({
                  coldMs: report.coldMs,
                  memberP95Ms: report.summaries.member.p95,
                  templateMemberP95Ms: report.summaries.templateMember.p95,
                  autoImportP95Ms: report.summaries.autoImport.p95,
                  coldIsolatedHits,
                  coldProjectResolves,
                  coldNativeRequests
              })
            : JSON.stringify(report, null, 2)
    );

    if (memberBefore.nativeProcessId !== finalStats.nativeProcessId) {
        throw new Error(
            `native engine restarted during completion measurement ` +
                `(pid ${memberBefore.nativeProcessId}->${finalStats.nativeProcessId})`
        );
    }
    if (apiHits > 0 && (apiHits !== rounds || memberNativeRequests !== 0)) {
        throw new Error(
            `member API path was partial: ${apiHits}/${rounds} API hits and ` +
                `${memberNativeRequests} native LSP request(s)`
        );
    }
    if (report.deltas.memberResolveNativeRequests !== 0) {
        throw new Error(
            `checker-API member resolve sent ${report.deltas.memberResolveNativeRequests} native request(s)`
        );
    }
    if (apiHits === 0 && memberNativeRequests !== rounds) {
        throw new Error(
            `member LSP path sent ${memberNativeRequests} native request(s) for ${rounds} samples`
        );
    }
    if (templateMemberApiHits !== rounds || templateMemberNativeRequests !== 0) {
        throw new Error(
            `template member API path was partial: ${templateMemberApiHits}/${rounds} API hits ` +
                `and ${templateMemberNativeRequests} native LSP request(s)`
        );
    }
    if (report.deltas.templateMemberResolveNativeRequests !== 0) {
        throw new Error(
            `checker-API template member resolve sent ${report.deltas.templateMemberResolveNativeRequests} native request(s)`
        );
    }
    if (coldMs > gates.coldMs) {
        throw new Error(`cold completion ${coldMs.toFixed(1)}ms exceeds ${gates.coldMs}ms`);
    }
    assertP95(summaries.member, memberGate, 'member completion');
    assertP95(summaries.memberResolve, gates.resolveP95Ms, 'member completion resolve');
    assertP95(summaries.templateMember, gates.templateMemberP95Ms, 'template member completion');
    assertP95(
        summaries.templateMemberResolve,
        gates.resolveP95Ms,
        'template member completion resolve'
    );
    assertP95(summaries.templateProps, gates.templateP95Ms, 'component prop completion');
    assertP95(summaries.autoImport, gates.autoImportP95Ms, 'auto-import completion');
    assertP95(summaries.unsupported, gates.unsupportedP95Ms, 'unsupported completion');
    if (unsupportedNativeRequests !== 0) {
        throw new Error(
            `unsupported completion contexts sent ${unsupportedNativeRequests} native request(s)`
        );
    }
} catch (error) {
    if (client.stderr.trim()) {
        console.error(`language server stderr:\n${client.stderr.trimEnd()}`);
    }
    throw error;
} finally {
    try {
        if (opened && !client.exited) {
            client.notify('textDocument/didClose', { textDocument: { uri } });
        }
    } finally {
        await shutdownLanguageServer(client);
    }
}

function positiveNumber(value, label) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
    return parsed;
}

function positiveInteger(value, label) {
    const parsed = positiveNumber(value, label);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an integer`);
    return parsed;
}
