// Strict whole-project checker oracle: classic TypeScript vs stock tsgo, then Effect tsgo.
//
// Unlike the editor comparator this runs one bounded project process per engine. It validates
// the machine protocol before comparing full diagnostic multiplicity and user-source program
// membership, so a child crash, truncated result or empty program cannot look like a speed win.
//
// Usage:
//   node bench/compare-checker-engines.mjs --project ../reintersect/apps/dashboard \
//     --tsconfig tsconfig.json [--effect-allow-source effect] [--effect-allow-code CODE]
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { runBoundedProcess } from './bounded-process.mjs';
import { normalizeCheckerProgramMembership } from './checker-program-membership.mjs';

if (process.argv.includes('--help')) {
    console.log(
        'Usage: node bench/compare-checker-engines.mjs --project <dir> [--tsconfig file] ' +
            '[--skip-effect] [--effect-allow-source name] [--effect-allow-code code]'
    );
    process.exit(0);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '..');
const CLI = path.join(REPO, 'packages/svelte-check/bin/svelte-check');
const require = createRequire(import.meta.url);
const { resolveTsGoEngine } = require(
    path.join(REPO, 'packages/language-server/dist/src/plugins/typescript-go/lsp/TsGoEngine.js')
);

function parseArgs(argv) {
    const result = {
        project: process.env.SVELTE_LS_BENCH_PROJECT ?? '',
        tsconfig: 'tsconfig.json',
        timeoutMs: 10 * 60_000,
        outputLimit: 256 * 1024 * 1024,
        membershipRoot: '',
        skipEffect: false,
        effectAllowSources: [],
        effectAllowCodes: []
    };
    const append = (target, value) => target.push(...value.split(',').filter(Boolean));
    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        // pnpm preserves the conventional option separator when forwarding script arguments.
        if (arg === '--') continue;
        const next = () => {
            const value = argv[++index];
            if (!value) throw new Error(`${arg} requires a value`);
            return value;
        };
        if (arg === '--project') result.project = path.resolve(next());
        else if (arg === '--tsconfig') result.tsconfig = next();
        else if (arg === '--timeout') result.timeoutMs = Number(next());
        else if (arg === '--output-limit') result.outputLimit = Number(next());
        else if (arg === '--membership-root') result.membershipRoot = path.resolve(next());
        else if (arg === '--skip-effect') result.skipEffect = true;
        else if (arg === '--effect-allow-source') append(result.effectAllowSources, next());
        else if (arg === '--effect-allow-code') append(result.effectAllowCodes, next());
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (!result.project) throw new Error('--project is required');
    if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds');
    }
    if (!Number.isSafeInteger(result.outputLimit) || result.outputLimit <= 0) {
        throw new Error('--output-limit must be a positive integer');
    }
    result.tsconfig = path.isAbsolute(result.tsconfig)
        ? result.tsconfig
        : path.join(result.project, result.tsconfig);
    result.membershipRoot ||= findWorkspaceRoot(result.project);
    return result;
}

function findWorkspaceRoot(from) {
    let current = from;
    for (;;) {
        if (
            fs.existsSync(path.join(current, 'pnpm-workspace.yaml')) ||
            fs.existsSync(path.join(current, '.git'))
        ) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return from;
        current = parent;
    }
}

function isPosition(value) {
    return (
        value &&
        Number.isSafeInteger(value.line) &&
        value.line >= 0 &&
        Number.isSafeInteger(value.character) &&
        value.character >= 0
    );
}

function validateJsonRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.type === 'FILE') return typeof record.filename === 'string';
    if (record.type !== 'ERROR' && record.type !== 'WARNING') return false;
    return (
        typeof record.filename === 'string' &&
        typeof record.message === 'string' &&
        isPosition(record.start) &&
        isPosition(record.end) &&
        Number.isSafeInteger(record.severity) &&
        record.severity === (record.type === 'ERROR' ? 1 : 2) &&
        (record.relatedInformation ?? []).every(
            (related) =>
                related &&
                typeof related.message === 'string' &&
                typeof related.location?.uri === 'string' &&
                isPosition(related.location.range?.start) &&
                isPosition(related.location.range?.end)
        )
    );
}

function parseMachineOutput(output) {
    const records = [];
    const malformed = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line) continue;
        const prefix = /^(\d+) (.+)$/.exec(line);
        if (!prefix) {
            malformed.push(line);
            continue;
        }
        const payload = prefix[2];
        if (payload.startsWith('{')) {
            try {
                const record = JSON.parse(payload);
                if (!validateJsonRecord(record)) throw new Error('invalid record shape');
                records.push(record);
            } catch {
                malformed.push(line);
            }
            continue;
        }
        const completion =
            /^COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS (\d+) FILES_WITH_PROBLEMS$/.exec(
                payload
            );
        if (completion) {
            records.push({
                type: 'COMPLETED',
                fileCount: Number(completion[1]),
                errorCount: Number(completion[2]),
                warningCount: Number(completion[3]),
                fileCountWithProblems: Number(completion[4])
            });
            continue;
        }
        const start = /^START (.+)$/.exec(payload);
        const failure = /^FAILURE (.+)$/.exec(payload);
        try {
            if (start && typeof JSON.parse(start[1]) === 'string') {
                records.push({ type: 'START', workspace: JSON.parse(start[1]) });
            } else if (failure && typeof JSON.parse(failure[1]) === 'string') {
                records.push({ type: 'FAILURE', message: JSON.parse(failure[1]) });
            } else {
                malformed.push(line);
            }
        } catch {
            malformed.push(line);
        }
    }
    return { records, malformed };
}

async function runEngine(options, engine) {
    const args = [
        CLI,
        '--workspace',
        options.project,
        '--tsconfig',
        options.tsconfig,
        '--output',
        'machine-verbose'
    ];
    if (engine.packageName) args.push('--tsgo');
    const env = { ...process.env };
    if (engine.packageName) env.SVELTE_LS_TSGO_PACKAGE = engine.packageName;
    else delete env.SVELTE_LS_TSGO_PACKAGE;

    const started = performance.now();
    const result = await runBoundedProcess(process.execPath, args, {
        cwd: options.project,
        env,
        timeoutMs: options.timeoutMs,
        outputLimit: options.outputLimit,
        label: engine.label
    });
    const parsed = parseMachineOutput(result.stdout);
    const run = {
        ...engine,
        ...result,
        ...parsed,
        durationMs: performance.now() - started
    };
    validateRun(run);
    return run;
}

function validateRun(run) {
    const starts = run.records.filter((record) => record.type === 'START');
    const completions = run.records.filter((record) => record.type === 'COMPLETED');
    const failures = run.records.filter((record) => record.type === 'FAILURE');
    const files = run.records.filter((record) => record.type === 'FILE');
    const errors = run.records.filter((record) => record.type === 'ERROR');
    const warnings = run.records.filter((record) => record.type === 'WARNING');
    const issues = [];
    if (run.signal) issues.push(`terminated by ${run.signal}`);
    if (run.malformed.length) issues.push(`${run.malformed.length} malformed output line(s)`);
    if (starts.length !== 1) issues.push(`expected 1 START, got ${starts.length}`);
    if (failures.length)
        issues.push(`emitted FAILURE: ${failures.map((x) => x.message).join('; ')}`);
    if (completions.length !== 1) issues.push(`expected 1 COMPLETED, got ${completions.length}`);
    const completion = completions[0];
    if (completion) {
        if (completion.fileCount <= 0) issues.push('completed with zero files');
        if (completion.fileCount !== files.length) {
            issues.push(`reported ${completion.fileCount} files but emitted ${files.length}`);
        }
        if (new Set(files.map((file) => file.filename)).size !== files.length) {
            issues.push('emitted duplicate FILE records');
        }
        if (completion.errorCount !== errors.length) {
            issues.push(`reported ${completion.errorCount} errors but emitted ${errors.length}`);
        }
        if (completion.warningCount !== warnings.length) {
            issues.push(
                `reported ${completion.warningCount} warnings but emitted ${warnings.length}`
            );
        }
        const filesWithProblems = new Set(
            [...errors, ...warnings].map((record) => normalizeUri(record.filename))
        );
        if (completion.fileCountWithProblems !== filesWithProblems.size) {
            issues.push(
                `reported ${completion.fileCountWithProblems} files with problems but emitted ` +
                    `diagnostics for ${filesWithProblems.size}`
            );
        }
        const expectedExit = errors.length ? 1 : 0;
        if (run.code !== expectedExit)
            issues.push(`expected exit ${expectedExit}, got ${run.code}`);
    }
    if (issues.length) {
        throw new Error(
            `${run.label} machine protocol failed:\n- ${issues.join('\n- ')}\n${run.stderr.slice(-4000)}`
        );
    }
}

function normalizeUri(value) {
    return value
        .replace(/\\/g, '/')
        .replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`);
}

function normalizedFilename(value, options) {
    const absolute = path.isAbsolute(value) ? value : path.resolve(options.project, value);
    const relative = path.relative(options.membershipRoot, absolute).replace(/\\/g, '/');
    return relative && !relative.startsWith('../') ? relative : normalizeUri(absolute);
}

function diagnostics(run, options) {
    return run.records
        .filter((record) => record.type === 'ERROR' || record.type === 'WARNING')
        .map((record) => ({
            type: record.type,
            filename: normalizedFilename(record.filename, options),
            start: record.start,
            end: record.end,
            message: record.message,
            severity: record.severity,
            code: record.code ?? null,
            codeDescription: record.codeDescription
                ? { ...record.codeDescription, href: normalizeUri(record.codeDescription.href) }
                : null,
            source: record.source ?? null,
            relatedInformation: (record.relatedInformation ?? []).map((related) => ({
                message: related.message,
                location: {
                    uri: normalizeUri(related.location.uri),
                    range: related.location.range
                }
            }))
        }))
        .sort(compareStable);
}

function program(run, options) {
    return normalizeCheckerProgramMembership(
        run.records.filter((record) => record.type === 'FILE').map((record) => record.filename),
        {
            project: options.project,
            membershipRoot: options.membershipRoot,
            isImplementationFile: isCheckerImplementationFile
        }
    );
}

function isCheckerImplementationFile(filename) {
    return [
        '/packages/svelte-check/dist/src/svelte-native-jsx.d.ts',
        '/packages/svelte-check/dist/src/svelte-shims-v4.d.ts'
    ].some((suffix) => filename.endsWith(suffix));
}

function compareStable(left, right) {
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function multisetDifference(left, right) {
    const counts = new Map();
    for (const value of right) {
        const key = JSON.stringify(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const remaining = [];
    for (const value of left) {
        const key = JSON.stringify(value);
        const count = counts.get(key) ?? 0;
        if (count) counts.set(key, count - 1);
        else remaining.push(value);
    }
    return remaining;
}

function printRun(run) {
    const completion = run.records.find((record) => record.type === 'COMPLETED');
    const resolved = run.packageName
        ? resolveTsGoEngine(opts.project, { packageName: run.packageName })
        : undefined;
    console.log(
        `${run.label.padEnd(8)} ${run.durationMs.toFixed(0).padStart(7)}ms  ` +
            `${completion.fileCount} files  ${completion.errorCount} errors  ` +
            `${completion.warningCount} warnings` +
            (resolved ? `  ${resolved.packageName}@${resolved.version}` : '')
    );
}

function printDifference(label, left, right) {
    const onlyLeft = multisetDifference(left, right);
    const onlyRight = multisetDifference(right, left);
    if (!onlyLeft.length && !onlyRight.length) {
        console.log(`PASS ${label}`);
        return true;
    }
    console.error(`FAIL ${label}: only-left=${onlyLeft.length}, only-right=${onlyRight.length}`);
    if (onlyLeft.length) console.error('only left:', JSON.stringify(onlyLeft.slice(0, 8), null, 2));
    if (onlyRight.length)
        console.error('only right:', JSON.stringify(onlyRight.slice(0, 8), null, 2));
    return false;
}

function printProgramAliases(run, membership) {
    if (!membership.aliases.length) {
        console.log(`PASS ${run.label} source program has no real/shadow aliases`);
        return true;
    }
    console.error(
        `FAIL ${run.label} source program has ${membership.aliases.length} real/shadow alias(es)`
    );
    console.error('aliases:', JSON.stringify(membership.aliases.slice(0, 8), null, 2));
    return false;
}

const opts = parseArgs(process.argv);
if (!fs.existsSync(CLI)) throw new Error(`checker is not built: ${CLI}`);
if (!fs.existsSync(opts.tsconfig)) throw new Error(`tsconfig not found: ${opts.tsconfig}`);

const table = [{ label: 'classic' }, { label: 'stock', packageName: '@typescript/native-preview' }];
if (!opts.skipEffect) table.push({ label: 'effect', packageName: '@reintersect/effect-tsgo' });

const runs = [];
for (const engine of table) {
    console.log(`running ${engine.label} ...`);
    const run = await runEngine(opts, engine);
    runs.push(run);
    printRun(run);
}

let passed = true;
const classic = runs.find((run) => run.label === 'classic');
const stock = runs.find((run) => run.label === 'stock');
const programByRun = new Map(runs.map((run) => [run, program(run, opts)]));
for (const run of runs) {
    passed = printProgramAliases(run, programByRun.get(run)) && passed;
}
passed =
    printDifference(
        'classic vs stock diagnostics',
        diagnostics(classic, opts),
        diagnostics(stock, opts)
    ) && passed;
passed =
    printDifference(
        'classic vs stock source program',
        programByRun.get(classic).files,
        programByRun.get(stock).files
    ) && passed;

const effect = runs.find((run) => run.label === 'effect');
if (effect) {
    const stockDiagnostics = diagnostics(stock, opts);
    const effectDiagnostics = diagnostics(effect, opts);
    const onlyStock = multisetDifference(stockDiagnostics, effectDiagnostics);
    const onlyEffect = multisetDifference(effectDiagnostics, stockDiagnostics);
    const sourceAllow = new Set(opts.effectAllowSources.map((value) => value.toLowerCase()));
    const codeAllow = new Set(opts.effectAllowCodes.map(String));
    const unexpectedEffect = onlyEffect.filter(
        (diagnostic) =>
            !sourceAllow.has(String(diagnostic.source ?? '').toLowerCase()) &&
            !codeAllow.has(String(diagnostic.code ?? ''))
    );
    if (onlyStock.length || unexpectedEffect.length) {
        passed = false;
        console.error(
            `FAIL stock vs effect diagnostics: missing=${onlyStock.length}, ` +
                `unexpected-effect=${unexpectedEffect.length}, allowed-effect=${onlyEffect.length - unexpectedEffect.length}`
        );
        if (onlyStock.length)
            console.error('missing from effect:', JSON.stringify(onlyStock.slice(0, 8), null, 2));
        if (unexpectedEffect.length) {
            console.error(
                'unexpected effect:',
                JSON.stringify(unexpectedEffect.slice(0, 8), null, 2)
            );
        }
    } else {
        console.log(`PASS stock vs effect diagnostics (${onlyEffect.length} explicitly allowed)`);
    }
    passed =
        printDifference(
            'stock vs effect source program',
            programByRun.get(stock).files,
            programByRun.get(effect).files
        ) && passed;
}

if (!passed) process.exitCode = 1;
