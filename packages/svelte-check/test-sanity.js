// @ts-check
/**
 * End-to-end sanity and differential tests for svelte-check.
 *
 * The machine protocol is part of the contract: a compiler crash must be a non-zero FAILURE,
 * while ordinary diagnostics must end in COMPLETED with the matching process status. The small
 * table-driven projects below also make the classic engine an executable oracle for the tsgo
 * overlay's config, parser and explicit-root behavior.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URI } = require('vscode-uri');

const CLI = path.join(__dirname, 'dist', 'src', 'index.js');
const REPO_ROOT = path.resolve(__dirname, '../..');
const TSGO_PACKAGE = '@typescript/native-preview';
const TSGO_MANIFEST = path.join(REPO_ROOT, 'node_modules', TSGO_PACKAGE, 'package.json');
const ROOT_MANIFEST = path.join(REPO_ROOT, 'package.json');
const installedTsGo = JSON.parse(fs.readFileSync(TSGO_MANIFEST, 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(ROOT_MANIFEST, 'utf8'));
if (
    installedTsGo.name !== TSGO_PACKAGE ||
    rootPackage.devDependencies?.[TSGO_PACKAGE] !== installedTsGo.version
) {
    throw new Error(
        `checker oracle requires an exact root pin for ${TSGO_PACKAGE}@${installedTsGo.version}`
    );
}
const parityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-check-parity-'));

let passed = 0;
let failed = 0;

/**
 * @typedef {object} ExpectedError
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {number} code
 */

/**
 * @typedef {object} RunOptions
 * @property {string} workspace
 * @property {string} tsconfig
 * @property {string} [config]
 * @property {string} [diagnosticSources]
 * @property {boolean} [incremental]
 * @property {boolean} [tsgoExp]
 * @property {boolean} [tsgo]
 * @property {ExpectedError[]} [errors]
 * @property {number} [status]
 * @property {boolean} [expectFailure]
 * @property {boolean} [expectCompleted]
 * @property {boolean} [requireRelatedInformation]
 * @property {boolean} [requireDiagnostic]
 * @property {number} [expectedDiagnosticCount]
 * @property {string} [requiredDiagnosticSubstring]
 * @property {number} [maxDurationMs]
 * @property {'machine' | 'machine-verbose'} [output]
 * @property {NodeJS.ProcessEnv} [env]
 */

/** @param {RunOptions} opts */
function runCli(opts) {
    const started = Date.now();
    const args = [
        CLI,
        '--workspace',
        opts.workspace,
        '--tsconfig',
        opts.tsconfig,
        '--output',
        opts.output ?? 'machine-verbose'
    ];
    if (opts.config) args.push('--config', opts.config);
    if (opts.diagnosticSources) args.push('--diagnostic-sources', opts.diagnosticSources);
    if (opts.incremental) args.push('--incremental');
    if (opts.tsgoExp) args.push('--tsgo-experimental-api');
    if (opts.tsgo) args.push('--tsgo');

    const result = spawnSync(process.execPath, args, {
        cwd: __dirname,
        encoding: 'utf-8',
        timeout: 60_000,
        env: {
            ...process.env,
            ...(opts.tsgo || opts.tsgoExp ? { SVELTE_LS_TSGO_PACKAGE: TSGO_PACKAGE } : {}),
            ...opts.env
        }
    });
    return {
        ...result,
        durationMs: Date.now() - started,
        records: parseMachineOutput(result.stdout || '')
    };
}

/** @param {string} output */
function parseMachineOutput(output) {
    /** @type {any[]} */
    const records = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line) continue;
        if (!/^\d+ /.test(line)) {
            records.push({ type: 'UNKNOWN', raw: line });
            continue;
        }
        const payload = line.slice(line.indexOf(' ') + 1);
        if (!payload || payload === line) {
            records.push({ type: 'MALFORMED', raw: line });
            continue;
        }
        if (payload.startsWith('{')) {
            try {
                const record = JSON.parse(payload);
                records.push(
                    validateJsonRecord(record) ? record : { type: 'MALFORMED', raw: payload }
                );
            } catch {
                records.push({ type: 'MALFORMED', raw: payload });
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
                fileCountWithProblems: Number(completion[4]),
                raw: payload
            });
            continue;
        }
        const start = /^START (.+)$/.exec(payload);
        if (start && isJsonString(start[1])) {
            records.push({ type: 'START', workspace: JSON.parse(start[1]), raw: payload });
            continue;
        }
        const failure = /^FAILURE (.+)$/.exec(payload);
        if (failure && isJsonString(failure[1])) {
            records.push({ type: 'FAILURE', message: JSON.parse(failure[1]), raw: payload });
            continue;
        }
        records.push({ type: 'MALFORMED', raw: payload });
    }
    return records;
}

/** @param {string} value */
function isJsonString(value) {
    try {
        return typeof JSON.parse(value) === 'string';
    } catch {
        return false;
    }
}

/** @param {any} value */
function isPosition(value) {
    return (
        value &&
        Number.isSafeInteger(value.line) &&
        value.line >= 0 &&
        Number.isSafeInteger(value.character) &&
        value.character >= 0
    );
}

/** @param {any} record */
function validateJsonRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (record.type === 'FILE') return typeof record.filename === 'string';
    if (record.type !== 'ERROR' && record.type !== 'WARNING') return false;
    if (
        typeof record.filename !== 'string' ||
        typeof record.message !== 'string' ||
        !isPosition(record.start) ||
        !isPosition(record.end) ||
        !Number.isSafeInteger(record.severity) ||
        record.severity !== (record.type === 'ERROR' ? 1 : 2)
    ) {
        return false;
    }
    return (record.relatedInformation ?? []).every(
        (related) =>
            related &&
            typeof related.message === 'string' &&
            related.location &&
            typeof related.location.uri === 'string' &&
            isPosition(related.location.range?.start) &&
            isPosition(related.location.range?.end)
    );
}

/** @param {ReturnType<typeof runCli>} run @param {RunOptions} opts */
function protocolIssues(run, opts) {
    const issues = [];
    const errors = run.records.filter((record) => record.type === 'ERROR');
    const failures = run.records.filter((record) => record.type === 'FAILURE');
    const completions = run.records.filter((record) => record.type === 'COMPLETED');
    const starts = run.records.filter((record) => record.type === 'START');
    const expectedErrors = opts.errors || [];
    const expectedStatus = opts.status ?? (expectedErrors.length ? 1 : 0);
    const expectFailure = opts.expectFailure ?? false;
    const expectCompleted = opts.expectCompleted ?? !expectFailure;

    if (run.error) issues.push(`process error: ${run.error.message}`);
    if (run.signal) issues.push(`terminated by ${run.signal}`);
    if (opts.maxDurationMs !== undefined && run.durationMs > opts.maxDurationMs) {
        issues.push(`expected completion within ${opts.maxDurationMs}ms, took ${run.durationMs}ms`);
    }
    if (run.status !== expectedStatus) {
        issues.push(`expected exit ${expectedStatus}, got ${run.status}`);
    }
    if (failures.length !== (expectFailure ? 1 : 0)) {
        issues.push(`expected ${expectFailure ? 1 : 0} FAILURE records, got ${failures.length}`);
    }
    if (completions.length !== (expectCompleted ? 1 : 0)) {
        issues.push(
            `expected ${expectCompleted ? 1 : 0} COMPLETED records, got ${completions.length}`
        );
    }
    if (expectCompleted && completions.length === 1) {
        const [completion] = completions;
        const files = run.records.filter((record) => record.type === 'FILE');
        const uniqueFiles = new Set(files.map((record) => normalizeFilename(record.filename)));
        if (!Number.isSafeInteger(completion.fileCount) || completion.fileCount <= 0) {
            issues.push(
                `expected a non-empty completed program, got ${completion.fileCount} files`
            );
        }
        if (files.length !== completion.fileCount) {
            issues.push(
                `completion reported ${completion.fileCount} files but emitted ${files.length} FILE records`
            );
        }
        if (uniqueFiles.size !== files.length) {
            issues.push('machine output emitted duplicate FILE records');
        }
        if (completion.errorCount !== errors.length) {
            issues.push(
                `completion reported ${completion.errorCount} errors but emitted ${errors.length}`
            );
        }
        const warnings = run.records.filter((record) => record.type === 'WARNING');
        if (completion.warningCount !== warnings.length) {
            issues.push(
                `completion reported ${completion.warningCount} warnings but emitted ${warnings.length}`
            );
        }
        const filesWithProblems = new Set(
            [...errors, ...warnings].map((record) => normalizeFilename(record.filename))
        );
        if (
            !Number.isSafeInteger(completion.fileCountWithProblems) ||
            completion.fileCountWithProblems !== filesWithProblems.size
        ) {
            issues.push(
                `completion reported ${completion.fileCountWithProblems} files with problems but emitted diagnostics for ${filesWithProblems.size}`
            );
        }
    }
    if (!expectFailure && starts.length !== 1) {
        issues.push(`expected 1 START record, got ${starts.length}`);
    }
    if (run.records.some((record) => ['MALFORMED', 'UNKNOWN'].includes(record.type))) {
        issues.push('machine output contained a malformed or non-protocol line');
    }
    return { issues, errors };
}

/** @param {string} filename */
function normalizeFilename(filename) {
    return filename.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** @param {string} name @param {RunOptions} opts */
function test(name, opts) {
    const run = runCli(opts);
    const { issues, errors } = protocolIssues(run, opts);
    const expectedErrors = opts.errors || [];

    if (errors.length !== expectedErrors.length) {
        issues.push(`expected ${expectedErrors.length} errors, got ${errors.length}`);
    }

    if (expectedErrors.length > 0) {
        const actual = errors.map((entry) => ({
            file: entry.filename.replace(/\\/g, '/'),
            line: entry.start.line,
            column: entry.start.character,
            code: entry.code
        }));
        const sortErrors = (a, b) =>
            a.file.localeCompare(b.file) ||
            a.line - b.line ||
            a.column - b.column ||
            a.code - b.code;
        const sortedExpected = [...expectedErrors].sort(sortErrors);
        const sortedActual = actual.sort(sortErrors);
        if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
            issues.push(
                `expected errors:\n${JSON.stringify(sortedExpected, null, 2)}\n` +
                    `got errors:\n${JSON.stringify(sortedActual, null, 2)}`
            );
        }
    }

    finish(name, issues, run);
}

/**
 * @param {string} name
 * @param {RunOptions} opts
 * @param {(records: any[], issues: string[]) => void} inspect
 */
function inspect(name, opts, inspect) {
    const run = runCli(opts);
    const { issues } = protocolIssues(run, opts);
    try {
        inspect(run.records, issues);
    } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
    }
    finish(name, issues, run);
}

/** @param {string} name @param {string[]} issues @param {ReturnType<typeof runCli>} run */
function finish(name, issues, run) {
    if (issues.length) {
        failed++;
        console.log(`  FAIL: ${name}`);
        for (const issue of issues) console.log(`        ${issue}`);
        if (run.stderr) console.log(`        stderr: ${run.stderr.trim()}`);
        if (run.stdout) console.log(`        stdout: ${run.stdout.trim()}`);
    } else {
        passed++;
        console.log(`  PASS: ${name}`);
    }
}

/** @param {any[]} records */
function diagnosticSignature(records) {
    return records
        .filter((record) => record.type === 'ERROR' || record.type === 'WARNING')
        .map(
            ({
                type,
                filename,
                start,
                end,
                message,
                severity,
                code,
                codeDescription,
                source,
                relatedInformation
            }) => ({
                type,
                filename: normalizeFilename(filename),
                start,
                end,
                message,
                severity,
                code: code ?? null,
                codeDescription: codeDescription
                    ? { ...codeDescription, href: normalizeUri(codeDescription.href) }
                    : null,
                source: source ?? null,
                relatedInformation: (relatedInformation ?? []).map((related) => ({
                    message: related.message,
                    location: {
                        uri: normalizeUri(related.location.uri),
                        range: related.location.range
                    }
                }))
            })
        )
        .sort((a, b) =>
            JSON.stringify([a.filename, a.start, a.end, a.code, a.message]).localeCompare(
                JSON.stringify([b.filename, b.start, b.end, b.code, b.message])
            )
        );
}

/** @param {string} value */
function normalizeUri(value) {
    return value
        .replace(/\\/g, '/')
        .replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`);
}

/** @param {any[]} records */
function programSignature(records) {
    return (
        records
            .filter((record) => record.type === 'FILE')
            .map((record) => normalizeFilename(record.filename))
            // Compiler libraries, package-manager layouts, and the two engines' shim locations are
            // implementation details. The oracle guards membership of user source files.
            .filter(
                (filename) =>
                    filename !== '..' &&
                    !filename.startsWith('../') &&
                    !filename.startsWith('node_modules/') &&
                    !filename.includes('/node_modules/') &&
                    !filename.startsWith('.svelte-check/') &&
                    !filename.includes('/.svelte-check/') &&
                    !filename.includes('/node_modules/.cache/svelte-lsp/')
            )
            .sort()
    );
}

/** @param {string} name @param {Omit<RunOptions, 'tsgo'>} opts */
function parity(name, opts) {
    const classic = runCli({ ...opts, tsgo: false });
    const native = runCli({ ...opts, tsgo: true });
    const classicProtocol = protocolIssues(classic, {
        ...opts,
        status: classic.records.some((record) => record.type === 'ERROR') ? 1 : 0
    });
    const nativeProtocol = protocolIssues(native, {
        ...opts,
        status: native.records.some((record) => record.type === 'ERROR') ? 1 : 0
    });
    const issues = [
        ...classicProtocol.issues.map((issue) => `classic: ${issue}`),
        ...nativeProtocol.issues.map((issue) => `tsgo: ${issue}`)
    ];
    const expected = diagnosticSignature(classic.records);
    const actual = diagnosticSignature(native.records);
    if (opts.requireDiagnostic && expected.length === 0) {
        issues.push('classic oracle did not produce the required diagnostic');
    }
    if (
        opts.expectedDiagnosticCount !== undefined &&
        expected.length !== opts.expectedDiagnosticCount
    ) {
        issues.push(
            `classic oracle produced ${expected.length} diagnostics, expected ${opts.expectedDiagnosticCount}`
        );
    }
    if (
        opts.requiredDiagnosticSubstring &&
        !expected.some((diagnostic) =>
            diagnostic.message.includes(opts.requiredDiagnosticSubstring)
        )
    ) {
        issues.push(
            `classic oracle did not include diagnostic text ${JSON.stringify(opts.requiredDiagnosticSubstring)}`
        );
    }
    if (
        opts.requireRelatedInformation &&
        !expected.some((diagnostic) => diagnostic.relatedInformation.length > 0)
    ) {
        issues.push('classic oracle did not produce the expected related diagnostic location');
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        issues.push(
            `diagnostic parity mismatch\nclassic: ${JSON.stringify(expected, null, 2)}\n` +
                `tsgo: ${JSON.stringify(actual, null, 2)}`
        );
    }
    const expectedProgram = programSignature(classic.records);
    const actualProgram = programSignature(native.records);
    if (JSON.stringify(actualProgram) !== JSON.stringify(expectedProgram)) {
        issues.push(
            `source-program parity mismatch\nclassic: ${JSON.stringify(expectedProgram, null, 2)}\n` +
                `tsgo: ${JSON.stringify(actualProgram, null, 2)}`
        );
    }
    finish(name, issues, native);
}

/**
 * @param {string} name
 * @param {Record<string, string>} files
 * @param {Record<string, unknown>} tsconfig
 */
function createProject(name, files, tsconfig) {
    const root = path.join(parityRoot, name);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, private: true }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 4));
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return root;
}

/** @param {string} suite @param {string} sveltePackage */
function createTemplateFixtureProject(suite, sveltePackage) {
    const sourceRoot = path.join(__dirname, 'test-template-diagnostics', suite);
    const expectations = JSON.parse(
        fs.readFileSync(path.join(sourceRoot, 'expectations.json'), 'utf8')
    );
    if (
        expectations.schemaVersion !== 1 ||
        typeof expectations.svelteVersion !== 'string' ||
        !expectations.svelteVersion
    ) {
        throw new Error(`${suite}: unsupported template expectation schema/compiler version`);
    }

    const svelteManifestPath = require.resolve(`${sveltePackage}/package.json`);
    const svelteManifest = JSON.parse(fs.readFileSync(svelteManifestPath, 'utf8'));
    if (svelteManifest.name !== 'svelte' || svelteManifest.version !== expectations.svelteVersion) {
        throw new Error(
            `${suite}: expected svelte@${expectations.svelteVersion}, resolved ` +
                `${svelteManifest.name}@${svelteManifest.version}`
        );
    }
    const fixtureManifest = JSON.parse(
        fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')
    );
    if (fixtureManifest.dependencies?.svelte !== expectations.svelteVersion) {
        throw new Error(`${suite}: fixture package does not pin the oracle's Svelte version`);
    }

    const root = path.join(parityRoot, `template-${suite}`);
    fs.cpSync(sourceRoot, root, { recursive: true });
    const nodeModules = path.join(root, 'node_modules');
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.symlinkSync(
        fs.realpathSync(path.dirname(svelteManifestPath)),
        path.join(nodeModules, 'svelte'),
        process.platform === 'win32' ? 'junction' : 'dir'
    );

    const expectedFiles = expectations.cases.map((entry) => normalizeFilename(entry.file)).sort();
    if (expectedFiles.length === 0) {
        throw new Error(`${suite}: template fixture oracle must contain at least one source file`);
    }
    if (new Set(expectedFiles).size !== expectedFiles.length) {
        throw new Error(`${suite}: expectation manifest contains duplicate case files`);
    }
    const fixtureFiles = listFiles(path.join(root, 'src'))
        .filter((file) => file.endsWith('.svelte'))
        .map((file) => normalizeFilename(path.relative(root, file)))
        .sort();
    if (JSON.stringify(fixtureFiles) !== JSON.stringify(expectedFiles)) {
        throw new Error(
            `${suite}: every Svelte fixture must have exactly one expectation entry\n` +
                `files: ${JSON.stringify(fixtureFiles)}\nexpected: ${JSON.stringify(expectedFiles)}`
        );
    }
    validateExpectedRanges(root, expectations);
    return { root, expectations, expectedFiles };
}

/** @param {string} suite */
function createSvelte5FixtureProject(suite) {
    return createTemplateFixtureProject(suite, 'svelte5');
}

/** @param {string} suite */
function createSvelte4FixtureProject(suite) {
    return createTemplateFixtureProject(suite, 'svelte');
}

/** @param {string} root */
function listFiles(root) {
    const files = [];
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(entryPath);
            else if (entry.isFile()) files.push(entryPath);
        }
    }
    return files;
}

/** @param {string} root @param {any} expectations */
function validateExpectedRanges(root, expectations) {
    for (const entry of expectations.cases) {
        const lines = fs.readFileSync(path.join(root, entry.file), 'utf8').split(/\r?\n/);
        for (const diagnostic of entry.diagnostics) {
            if (
                !Array.isArray(diagnostic.range) ||
                diagnostic.range.length !== 4 ||
                diagnostic.range.some((value) => !Number.isSafeInteger(value) || value < 0)
            ) {
                throw new Error(`${entry.file}: expected diagnostic has an invalid range`);
            }
            const [startLine, startCharacter, endLine, endCharacter] = diagnostic.range;
            if (
                startLine >= lines.length ||
                endLine >= lines.length ||
                startCharacter > lines[startLine].length ||
                endCharacter > lines[endLine].length ||
                endLine < startLine ||
                (endLine === startLine && endCharacter < startCharacter)
            ) {
                throw new Error(
                    `${entry.file}: expected range ${diagnostic.range.join(':')} is outside the source`
                );
            }
        }
    }
}

/** @param {string} value @param {string} workspace */
function normalizeCorpusRelatedUri(value, workspace) {
    let filePath;
    try {
        const uri = URI.parse(value);
        if (uri.scheme !== 'file') return normalizeUri(value);
        filePath = uri.fsPath;
    } catch {
        return normalizeUri(value);
    }
    const workspaceRelative = path.relative(workspace, filePath);
    if (
        workspaceRelative !== '..' &&
        !workspaceRelative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(workspaceRelative)
    ) {
        return `workspace:${normalizeFilename(workspaceRelative)}`;
    }
    const normalized = filePath.replace(/\\/g, '/');
    const svelteMarker = '/node_modules/svelte/';
    const svelteIndex = normalized.lastIndexOf(svelteMarker);
    if (svelteIndex >= 0) {
        return `dependency:svelte/${normalized.slice(svelteIndex + svelteMarker.length)}`;
    }
    if (normalized.includes('typescript') && /\/lib\/lib\.[^/]+\.d\.ts$/.test(normalized)) {
        return `typescript-lib:${path.posix.basename(normalized)}`;
    }
    return `external:${path.posix.basename(normalized)}`;
}

/** @param {any[]} records @param {string} workspace */
function corpusDiagnosticSignature(records, workspace) {
    return sortCorpusDiagnostics(
        records
            .filter((record) => record.type === 'ERROR' || record.type === 'WARNING')
            .map((record) => ({
                type: record.type,
                filename: normalizeFilename(record.filename),
                start: record.start,
                end: record.end,
                message: record.message,
                severity: record.severity,
                code: record.code ?? null,
                codeDescription: record.codeDescription ?? null,
                source: record.source ?? null,
                relatedInformation: (record.relatedInformation ?? []).map((related) => ({
                    message: related.message,
                    location: {
                        uri: normalizeCorpusRelatedUri(related.location.uri, workspace),
                        range: related.location.range
                    }
                }))
            }))
    );
}

/** @param {any} expectations @param {'classic' | 'native'} engine */
function expectedCorpusDiagnosticSignature(expectations, engine) {
    const result = [];
    for (const entry of expectations.cases) {
        for (const diagnostic of entry.diagnostics) {
            const expected = { ...diagnostic, ...(diagnostic[engine] ?? {}) };
            const [startLine, startCharacter, endLine, endCharacter] = expected.range;
            result.push({
                type: expected.type ?? 'ERROR',
                filename: normalizeFilename(entry.file),
                start: { line: startLine, character: startCharacter },
                end: { line: endLine, character: endCharacter },
                message: expected.message,
                severity: expected.severity ?? 1,
                code: expected.code,
                codeDescription: expected.codeDescription ?? null,
                source: expected.source ?? 'ts',
                relatedInformation: (expected.relatedInformation ?? []).map((related) => {
                    const [
                        relatedStartLine,
                        relatedStartCharacter,
                        relatedEndLine,
                        relatedEndCharacter
                    ] = related.range;
                    return {
                        message: related.message,
                        location: {
                            uri: related.uri,
                            range: {
                                start: {
                                    line: relatedStartLine,
                                    character: relatedStartCharacter
                                },
                                end: { line: relatedEndLine, character: relatedEndCharacter }
                            }
                        }
                    };
                })
            });
        }
    }
    return sortCorpusDiagnostics(result);
}

/** @param {any[]} diagnostics */
function sortCorpusDiagnostics(diagnostics) {
    return diagnostics.sort((a, b) =>
        JSON.stringify([a.filename, a.start, a.end, a.code, a.message]).localeCompare(
            JSON.stringify([b.filename, b.start, b.end, b.code, b.message])
        )
    );
}

/** @param {string} name @param {ReturnType<typeof createTemplateFixtureProject>} fixture */
function templateCorpus(name, fixture) {
    const statsPath = path.join(
        parityRoot,
        `template-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-tsgo-stats.json`
    );
    const baseOptions = {
        workspace: fixture.root,
        tsconfig: './tsconfig.json',
        diagnosticSources: fixture.expectations.diagnosticSources,
        env: { SVELTE_LS_RSVELTE: '0' },
        status: 1
    };
    const classic = runCli({ ...baseOptions, tsgo: false });
    const native = runCli({
        ...baseOptions,
        tsgo: true,
        env: { ...baseOptions.env, SVELTE_LS_TSGO_STATS: statsPath }
    });
    const classicProtocol = protocolIssues(classic, baseOptions);
    const nativeProtocol = protocolIssues(native, baseOptions);
    const issues = [
        ...classicProtocol.issues.map((issue) => `classic: ${issue}`),
        ...nativeProtocol.issues.map((issue) => `tsgo: ${issue}`)
    ];
    const pinnedDiagnostics = expectedCorpusDiagnosticSignature(fixture.expectations, 'classic');
    if (pinnedDiagnostics.length === 0) {
        issues.push('template fixture diagnostic oracle is empty');
    }
    try {
        const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        if (
            stats.schemaVersion !== 1 ||
            stats.engine?.packageName !== TSGO_PACKAGE ||
            stats.engine?.version !== installedTsGo.version
        ) {
            issues.push(`tsgo used an unexpected engine: ${JSON.stringify(stats.engine)}`);
        }
    } catch (error) {
        issues.push(
            `tsgo did not emit valid engine stats: ${error instanceof Error ? error.message : error}`
        );
    }
    for (const [label, run] of [
        ['classic', classic],
        ['native', native]
    ]) {
        const actual = corpusDiagnosticSignature(run.records, fixture.root);
        const expected = expectedCorpusDiagnosticSignature(fixture.expectations, label);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            issues.push(
                `${label} template diagnostics did not match the pinned oracle\n` +
                    `expected: ${JSON.stringify(expected, null, 2)}\n` +
                    `actual: ${JSON.stringify(actual, null, 2)}`
            );
        }
        const actualProgram = programSignature(run.records);
        if (JSON.stringify(actualProgram) !== JSON.stringify(fixture.expectedFiles)) {
            issues.push(
                `${label} template source-program mismatch\n` +
                    `expected: ${JSON.stringify(fixture.expectedFiles)}\n` +
                    `actual: ${JSON.stringify(actualProgram)}`
            );
        }
        if (run.stderr?.trim()) {
            issues.push(`${label} wrote unexpected stderr: ${run.stderr.trim()}`);
        }
    }
    finish(name, issues, native);
}

console.log('svelte-check sanity tests\n');

test('clean project', {
    workspace: './test-success',
    tsconfig: './tsconfig.json'
});

test('clean project --tsgo-experimental-api', {
    workspace: './test-success',
    tsconfig: './tsconfig.json',
    tsgoExp: true
});

fs.rmSync('./test-success/.svelte-check', { recursive: true, force: true });
test('clean project (incremental, cold cache)', {
    workspace: './test-success',
    tsconfig: './tsconfig.json',
    incremental: true
});

test('clean project (incremental, warm cache)', {
    workspace: './test-success',
    tsconfig: './tsconfig.json',
    incremental: true
});

test('clean project --tsgo', {
    workspace: './test-success',
    tsconfig: './tsconfig.json',
    tsgo: true
});

const errors = [
    { file: 'Index.svelte', line: 3, column: 21, code: 2307 },
    { file: 'Index.svelte', line: 5, column: 8, code: 2322 },
    { file: 'Index.svelte', line: 8, column: 4, code: 2367 },
    { file: 'Index.svelte', line: 11, column: 4, code: 2367 },
    { file: 'Index.svelte', line: 15, column: 1, code: 2741 },
    { file: 'Jsdoc.svelte', line: 9, column: 23, code: 2322 },
    { file: 'src/routes/+page.ts', line: 0, column: 13, code: 2322 }
];

test('project with errors', {
    workspace: './test-error',
    tsconfig: './tsconfig.json',
    errors
});

test('project with errors --tsgo-experimental-api', {
    workspace: './test-error',
    tsconfig: './tsconfig.json',
    tsgoExp: true,
    errors
});

fs.rmSync('./test-error/.svelte-check', { recursive: true, force: true });
test('project with errors (incremental, cold cache)', {
    workspace: './test-error',
    tsconfig: './tsconfig.json',
    incremental: true,
    errors
});

test('project with errors (incremental, warm cache)', {
    workspace: './test-error',
    tsconfig: './tsconfig.json',
    incremental: true,
    errors
});

test('project with errors --tsgo', {
    workspace: './test-error',
    tsconfig: './tsconfig.json',
    tsgo: true,
    errors
});

console.log('\nclassic ↔ tsgo parity fixtures\n');

console.log('Svelte 5 in-template diagnostic corpus\n');
templateCorpus('valid-but-wrong template syntax', createSvelte5FixtureProject('semantic'));
templateCorpus('malformed template syntax', createSvelte5FixtureProject('parser'));
templateCorpus('mixed compiler and template type errors', createSvelte5FixtureProject('mixed'));

console.log('\nSvelte 4 in-template diagnostic corpus\n');
templateCorpus('Svelte 4 niche template type syntax', createSvelte4FixtureProject('svelte4'));
templateCorpus('Svelte 4 malformed template syntax', createSvelte4FixtureProject('svelte4-parser'));

console.log('\nSvelte config transform corpus\n');
templateCorpus(
    'Svelte config namespace, custom-element and default-language behavior',
    createSvelte4FixtureProject('config-transform')
);

console.log('\nclassic ↔ tsgo focused parity fixtures\n');

const propProject = createProject(
    'component-prop',
    {
        'src/Comp.svelte': '<script lang="ts">export let foo: string;</script>',
        'src/App.svelte':
            '<script lang="ts">import Comp from "./Comp.svelte";</script>\n<Comp foo={123} />'
    },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        include: ['src/**/*']
    }
);
parity('component prop diagnostics', {
    workspace: propProject,
    tsconfig: './tsconfig.json'
});

const runeModuleCollisionProject = createProject(
    'same-basename-rune-module',
    {
        'package.json': JSON.stringify({
            name: 'same-basename-rune-module',
            private: true,
            type: 'module',
            dependencies: { 'virtua-like': '1.0.0' },
            imports: {
                '#lib/*': './src/*',
                '#widgets/*': './src/*',
                '#components/*': './src/*.svelte'
            }
        }),
        'src/Widget.svelte.ts': 'export function useWidget() { return "widget" as const; }\n',
        'src/Widget.svelte':
            '<script lang="ts">\n' +
            '  import { useWidget } from "./Widget.svelte.js";\n' +
            '  export let label: string;\n' +
            '  const helperValue: "widget" = useWidget();\n' +
            '</script>\n' +
            '<p>{label}: {helperValue}</p>',
        // Exercises generated Svelte/TSX imports of the colliding component, not only TS roots.
        'src/Consumer.svelte':
            '<script lang="ts">\n' +
            '  import Widget from "./Widget.svelte";\n' +
            '  import PackageWidget from "#widgets/Widget.svelte";\n' +
            '  import AliasWidget from "#components/Widget";\n' +
            '  import PathsWidget from "#path/Widget.svelte";\n' +
            '  import emojiData from "#lib/emojiData.json";\n' +
            '  import { Virtualizer } from "virtua-like";\n' +
            '  import Declared from "./Declared.svelte";\n' +
            '</script>\n' +
            '<Widget label={123} /><PackageWidget label="rewritten-package-import" />' +
            '<AliasWidget label="package-import" />' +
            '<PathsWidget label={emojiData[0].label} />' +
            '<Virtualizer items={["dependency"]} />' +
            '<Declared value="declaration-backed" />',
        // This component is intentionally declaration-backed and is not materialized. A batch
        // rewrite activated by Widget must leave its specifier alone.
        'src/Declared.svelte': '<script lang="ts">export let value: string;</script>',
        'src/Declared.d.svelte.ts':
            'import { SvelteComponent } from "svelte";\n' +
            'export default class Declared extends SvelteComponent<{ value: string }> {}\n',
        'src/emojiData.json': '[{"label":"emoji"}]\n',
        'node_modules/virtua-like/package.json': JSON.stringify({
            name: 'virtua-like',
            version: '1.0.0',
            type: 'module',
            peerDependencies: { svelte: '^4.0.0 || ^5.0.0' },
            exports: { '.': { types: './lib/svelte/index.d.ts', default: './lib/svelte/index.js' } }
        }),
        'node_modules/virtua-like/lib/svelte/index.d.ts':
            'export { default as Virtualizer } from "./Virtualizer.svelte";\n',
        'node_modules/virtua-like/lib/svelte/Virtualizer.svelte':
            '<script lang="ts">export let items: string[];</script>\n{#each items as item}<p>{item}</p>{/each}',
        'src/index.ts':
            'import Widget from "./Widget.svelte";\n' +
            'import PackageWidget from "#widgets/Widget.svelte";\n' +
            'import AliasWidget from "#components/Widget";\n' +
            'import PathsWidget from "#path/Widget.svelte";\n' +
            'import emojiData from "#lib/emojiData.json";\n' +
            'import { Virtualizer } from "virtua-like";\n' +
            'import Declared from "./Declared.svelte";\n' +
            'import { useWidget } from "./Widget.svelte.js";\n' +
            'new Widget({ target: document.body, props: { label: 123 } });\n' +
            'new PackageWidget({ target: document.body, props: { label: "ok" } });\n' +
            'new AliasWidget({ target: document.body, props: { label: "ok" } });\n' +
            'new PathsWidget({ target: document.body, props: { label: emojiData[0].label } });\n' +
            'new Virtualizer({ target: document.body, props: { items: ["dependency"] } });\n' +
            'new Declared({ target: document.body, props: { value: "ok" } });\n' +
            'const helperValue: number = useWidget();\n',
        // Neither a normal module nor TypeScript's arbitrary-extension declaration spelling may
        // capture the adapter's deterministic alias candidates.
        'src/Widget.d.__svlt.ts': 'export const userOwnedDeclarationAlias = true;\n',
        'src/Widget.__s000.ts': 'export const userOwnedAlias = true;\n',
        // A collision must mirror the reachable source graph, not every generated/cache file in
        // the owning workspace package. These would all have been swept by a package-wide scan.
        '.svelte-kit/generated/unreachable.ts': 'export const generated = true;\n',
        'dist/unreachable.ts': 'export const built = true;\n',
        '.fast-check/unreachable.ts': 'export const cached = true;\n'
    },
    {
        compilerOptions: {
            strict: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            allowArbitraryExtensions: true,
            resolveJsonModule: true,
            paths: { '#path/*': ['./src/*'] },
            noEmit: true
        },
        include: ['src/**/*'],
        exclude: ['src/Declared.svelte']
    }
);
parity('component and same-basename rune-module resolution', {
    workspace: runeModuleCollisionProject,
    tsconfig: './tsconfig.json',
    requireDiagnostic: true
});

const collisionMirrorRoot = path.join(
    runeModuleCollisionProject,
    'node_modules',
    '.cache',
    'svelte-lsp',
    'svelte'
);
const collisionJsonMirror = path.join(collisionMirrorRoot, 'src', 'emojiData.json');
const collisionSourceMirror = path.join(collisionMirrorRoot, 'src', 'index.ts');
const collisionShadow = path.join(collisionMirrorRoot, 'src', 'Widget.__s001.tsx');
const warmStatsPath = path.join(runeModuleCollisionProject, 'warm-stats.json');
const jsonMtimeBeforeWarm = fs.existsSync(collisionJsonMirror)
    ? fs.statSync(collisionJsonMirror, { bigint: true }).mtimeNs
    : null;
const sourceMtimeBeforeWarm = fs.existsSync(collisionSourceMirror)
    ? fs.statSync(collisionSourceMirror, { bigint: true }).mtimeNs
    : null;
inspect(
    'warm collision mirrors reuse JSON and source bytes without writes',
    {
        workspace: runeModuleCollisionProject,
        tsconfig: './tsconfig.json',
        tsgo: true,
        status: 1,
        env: { SVELTE_LS_TSGO_STATS: warmStatsPath }
    },
    (_records, issues) => {
        if (jsonMtimeBeforeWarm === null || sourceMtimeBeforeWarm === null) {
            issues.push('the cold collision run did not materialize its source/JSON mirrors');
            return;
        }
        for (const unrelated of [
            '.svelte-kit/generated/unreachable.ts',
            'dist/unreachable.ts',
            '.fast-check/unreachable.ts'
        ]) {
            if (fs.existsSync(path.join(collisionMirrorRoot, unrelated))) {
                issues.push(`unreachable generated source was mirrored: ${unrelated}`);
            }
        }
        const stats = JSON.parse(fs.readFileSync(warmStatsPath, 'utf8'));
        if (stats.materialise.transformedCount !== 0 || stats.materialise.writtenCount !== 0) {
            issues.push(`expected a zero-write warm run, got ${JSON.stringify(stats.materialise)}`);
        }
        if (
            fs.statSync(collisionJsonMirror, { bigint: true }).mtimeNs !== jsonMtimeBeforeWarm ||
            fs.statSync(collisionSourceMirror, { bigint: true }).mtimeNs !== sourceMtimeBeforeWarm
        ) {
            issues.push('an unchanged warm run changed a source or JSON mirror mtime');
        }
    }
);

// Removing the final collision must retire this manager's copied graph. Real source files then
// resolve normally, and another manager's canonical outputs remain protected by ownership state.
fs.unlinkSync(path.join(runeModuleCollisionProject, 'src', 'Widget.svelte.ts'));
fs.writeFileSync(
    path.join(runeModuleCollisionProject, 'src', 'Widget.svelte'),
    '<script lang="ts">export let label: string;</script>\n<p>{label}</p>'
);
fs.writeFileSync(
    path.join(runeModuleCollisionProject, 'src', 'index.ts'),
    'import Widget from "./Widget.svelte";\n' +
        'import emojiData from "#lib/emojiData.json";\n' +
        'new Widget({ target: document.body, props: { label: 123 } });\n' +
        'const emojiLabel: string = emojiData[0].label;\n'
);
inspect(
    'collision removal prunes this manager source and JSON mirrors',
    {
        workspace: runeModuleCollisionProject,
        tsconfig: './tsconfig.json',
        tsgo: true,
        status: 1
    },
    (_records, issues) => {
        for (const stale of [collisionJsonMirror, collisionSourceMirror, collisionShadow]) {
            if (fs.existsSync(stale)) {
                issues.push(`stale collision output survived: ${stale}`);
            }
        }
        for (const source of ['src/emojiData.json', 'src/index.ts', 'src/Widget.svelte']) {
            if (!fs.existsSync(path.join(runeModuleCollisionProject, source))) {
                issues.push(`source was removed while pruning its mirror: ${source}`);
            }
        }
    }
);

const multiManagerRoot = path.join(parityRoot, 'same-package-multi-manager');
const multiManagerFiles = {
    'package.json': JSON.stringify({
        name: 'same-package-multi-manager',
        private: true,
        workspaces: ['apps/*', 'packages/*']
    }),
    'apps/a/package.json': JSON.stringify({ name: 'app-a', private: true, type: 'module' }),
    'apps/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
            strict: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            paths: { '@shared/ui': ['../../packages/ui/src/index.ts'] }
        },
        include: ['src/**/*']
    }),
    'apps/a/src/main.ts':
        'import Widget from "@shared/ui";\n' +
        'import Local from "./Local.svelte";\n' +
        'new Widget({ target: document.body, props: { label: "shared" } });\n' +
        'new Local({ target: document.body, props: { label: "a" } });\n',
    'apps/a/src/Local.svelte':
        '<script lang="ts">import { local } from "./Local.svelte.js"; export let label: string;</script><p>{label}{local}</p>',
    'apps/a/src/Local.svelte.ts': 'export const local = "a";\n',
    'apps/a/src/Local.d.__svlt.ts': 'export const blocksDefault = true;\n',
    'apps/b/package.json': JSON.stringify({ name: 'app-b', private: true, type: 'module' }),
    'apps/b/tsconfig.json': JSON.stringify({
        compilerOptions: {
            strict: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            paths: { '@shared/ui': ['../../packages/ui/src/index.ts'] }
        },
        include: ['src/**/*']
    }),
    'apps/b/src/main.ts':
        'import Widget from "@shared/ui";\n' +
        'import Other from "./Other.svelte";\n' +
        'new Widget({ target: document.body, props: { label: "shared" } });\n' +
        'new Other({ target: document.body, props: { label: "b" } });\n',
    'apps/b/src/Other.svelte':
        '<script lang="ts">import { other } from "./Other.svelte.js"; export let label: string;</script><p>{label}{other}</p>',
    'apps/b/src/Other.svelte.ts': 'export const other = "b";\n',
    'apps/c/package.json': JSON.stringify({ name: 'app-c', private: true, type: 'module' }),
    'apps/c/tsconfig.json': JSON.stringify({
        compilerOptions: {
            strict: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            paths: { '@shared/safe': ['../../packages/ui/src/Safe.svelte'] }
        },
        include: ['src/**/*']
    }),
    'apps/c/src/main.ts':
        'import Safe from "@shared/safe";\n' +
        'new Safe({ target: document.body, props: { label: "non-collision" } });\n',
    'packages/ui/package.json': JSON.stringify({
        name: '@shared/ui',
        private: true,
        type: 'module',
        exports: { '.': './src/index.ts' }
    }),
    'packages/ui/src/index.ts': 'export { default } from "./Widget.svelte";\n',
    'packages/ui/src/Widget.svelte':
        '<script lang="ts">import { widget } from "./Widget.svelte.js"; export let label: string;</script><p>{label}{widget}</p>',
    'packages/ui/src/Widget.svelte.ts': 'export const widget = "shared";\n',
    'packages/ui/src/Safe.svelte':
        '<script lang="ts">export let label: string;</script><p>{label}</p>',
    // These live in the same collision-owning package, but no project can reach them. The
    // package-wide collision inventory must not turn them into native roots.
    'packages/ui/.svelte-kit/generated/Unreachable.svelte': '<p>generated</p>\n',
    'packages/ui/dist/Unreachable.svelte': '<p>built</p>\n',
    'packages/ui/.fast-check/Unreachable.svelte': '<p>cached</p>\n'
};
for (const [relativePath, contents] of Object.entries(multiManagerFiles)) {
    const target = path.join(multiManagerRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}
const multiManagerSpecs = ['apps/a', 'apps/b', 'apps/c', 'apps/a'].map((workspace) => ({
    workspace: path.join(multiManagerRoot, workspace),
    tsconfig: './tsconfig.json',
    tsgo: true
}));
const multiManagerRuns = multiManagerSpecs.map(runCli);
const multiManagerIssues = multiManagerRuns.flatMap((run, index) =>
    protocolIssues(run, {
        workspace: multiManagerSpecs[index].workspace,
        tsconfig: './tsconfig.json',
        tsgo: true
    }).issues.map((issue) => `run ${index + 1}: ${issue}`)
);
const sharedMirrorRoot = path.join(
    multiManagerRoot,
    'packages/ui/node_modules/.cache/svelte-lsp/svelte'
);
const sharedSourceMirror = path.join(sharedMirrorRoot, 'packages/ui/src/index.ts');
const sharedShadow = path.join(sharedMirrorRoot, 'packages/ui/src/Widget.__svlt.tsx');
const wrongSharedShadow = path.join(sharedMirrorRoot, 'packages/ui/src/Widget.__s000.tsx');
const sharedScope = path.join(sharedMirrorRoot, 'package.json');
if (!fs.existsSync(sharedSourceMirror)) {
    multiManagerIssues.push('shared package source mirror was pruned');
} else if (!fs.readFileSync(sharedSourceMirror, 'utf8').includes('./Widget.__svlt')) {
    multiManagerIssues.push('project-local alias blockers changed shared package source bytes');
}
if (!fs.existsSync(sharedShadow)) {
    multiManagerIssues.push('shared component shadow was pruned');
}
if (fs.existsSync(wrongSharedShadow)) {
    multiManagerIssues.push('shared component retained a manager-local suffix twin');
}
if (!fs.existsSync(sharedScope)) {
    multiManagerIssues.push('shared mirror package scope was pruned');
}
for (const unrelated of [
    'packages/ui/.svelte-kit/generated/Unreachable.svelte.tsx',
    'packages/ui/dist/Unreachable.svelte.tsx',
    'packages/ui/.fast-check/Unreachable.svelte.tsx'
]) {
    if (fs.existsSync(path.join(sharedMirrorRoot, unrelated))) {
        multiManagerIssues.push(`unreachable package component was materialized: ${unrelated}`);
    }
}
finish(
    'two project managers share target-specific collision mirrors safely',
    multiManagerIssues,
    multiManagerRuns[multiManagerRuns.length - 1]
);

const declarationRootProject = createProject(
    'declaration-backed-explicit-root',
    {
        'src/Declared.svelte': '<script lang="ts">export let value: string;</script>',
        'src/Declared.d.svelte.ts':
            'import { SvelteComponent } from "svelte";\n' +
            'export default class Declared extends SvelteComponent<{ value: string }> {}\n'
    },
    {
        compilerOptions: {
            strict: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            allowArbitraryExtensions: true,
            noEmit: true
        },
        files: ['src/Declared.svelte', 'src/Declared.d.svelte.ts']
    }
);
inspect(
    'declaration-backed explicit Svelte roots keep independent Svelte diagnostics',
    {
        workspace: declarationRootProject,
        tsconfig: './tsconfig.json',
        tsgo: true
    },
    (records, issues) => {
        const errors = records.filter((record) => record.type === 'ERROR');
        const warnings = records.filter(
            (record) =>
                record.type === 'WARNING' &&
                normalizeFilename(record.filename) === 'src/Declared.svelte'
        );
        const files = new Set(
            records
                .filter((record) => record.type === 'FILE')
                .map((record) => normalizeFilename(record.filename))
        );
        if (errors.length) {
            issues.push(`expected no native errors, got ${JSON.stringify(errors, null, 2)}`);
        }
        if (warnings.length !== 1 || warnings[0].code !== 'unused-export-let') {
            issues.push('expected the raw explicit root to retain its Svelte compiler warning');
        }
        if (!files.has('src/Declared.svelte') || !files.has('src/Declared.d.svelte.ts')) {
            issues.push(
                'expected both the raw Svelte root and its declaration in the source program'
            );
        }
    }
);

const relatedInfoProject = createProject(
    'related-information',
    {
        'src/Comp.svelte': '<p>related-info fixture</p>',
        'src/types.ts': 'export interface Shape { required: string }\n',
        'src/use.ts': 'import type { Shape } from "./types";\nconst value: Shape = {};\n'
    },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        include: ['src/**/*']
    }
);
parity('related diagnostic locations', {
    workspace: relatedInfoProject,
    tsconfig: './tsconfig.json',
    requireRelatedInformation: true
});

const parserProject = createProject(
    'parser-error',
    { 'src/Broken.svelte': '<script lang="ts">const ok = true;</script>\n{#if ok}}' },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        include: ['src/**/*']
    }
);
for (const [label, diagnosticSources] of [
    ['all/default', undefined],
    ['JS-only', 'js'],
    ['CSS-only', 'css'],
    ['Svelte-only', 'svelte'],
    ['JS+CSS', 'js,css'],
    ['JS+Svelte', 'js,svelte'],
    ['CSS+Svelte', 'css,svelte']
]) {
    parity(`parser errors with ${label} diagnostics`, {
        workspace: parserProject,
        tsconfig: './tsconfig.json',
        diagnosticSources,
        requireDiagnostic: true
    });
}

const explicitRootProject = createProject(
    'explicit-root',
    { 'build/Comp.svelte': '<script lang="ts">const count: number = "bad";</script>' },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        files: ['build/Comp.svelte']
    }
);
parity('explicit roots under scan-excluded directories', {
    workspace: explicitRootProject,
    tsconfig: './tsconfig.json'
});

const configProject = createProject(
    'explicit-config',
    {
        'src/Comp.svelte': '<script lang="ts">export let foo: number;</script>',
        'src/use.ts':
            'import Comp from "./Comp.svelte";\n' +
            'const component = new Comp({ target: document.body, props: { foo: 1 } });\n' +
            'component.foo = "bad";',
        'custom.config.cjs': 'module.exports = { compilerOptions: { accessors: true } };'
    },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        files: ['src/Comp.svelte', 'src/use.ts']
    }
);
parity('explicit Svelte config affects generated component types', {
    workspace: configProject,
    tsconfig: './tsconfig.json',
    config: './custom.config.cjs'
});

const invalidUserConfigProject = createProject(
    'invalid-user-config',
    { 'src/Comp.svelte': '<p>invalid config</p>' },
    {
        compilerOptions: {
            strict: true,
            module: 'esnext',
            moduleResolution: 'definitely-not-a-module-resolution-mode'
        },
        include: ['src/**/*']
    }
);
parity('invalid user TypeScript config', {
    workspace: invalidUserConfigProject,
    tsconfig: './tsconfig.json',
    requireDiagnostic: true
});

const invalidSvelteConfigProject = createProject(
    'invalid-svelte-config',
    {
        'src/Comp.svelte': '<p>config failure</p>',
        'svelte.config.cjs': 'throw new Error("intentional Svelte config load failure");'
    },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        include: ['src/**/*']
    }
);
for (const [label, diagnosticSources] of [
    ['all/default', undefined],
    ['JS-only', 'js'],
    ['CSS-only', 'css'],
    ['Svelte-only', 'svelte'],
    ['JS+CSS', 'js,css'],
    ['JS+Svelte', 'js,svelte'],
    ['CSS+Svelte', 'css,svelte']
]) {
    parity(`Svelte config errors with ${label} diagnostics`, {
        workspace: invalidSvelteConfigProject,
        tsconfig: './tsconfig.json',
        diagnosticSources,
        requireDiagnostic: true,
        expectedDiagnosticCount: 1,
        requiredDiagnosticSubstring: 'intentional Svelte config load failure'
    });
    inspect(
        `incremental Svelte config errors with ${label} diagnostics`,
        {
            workspace: invalidSvelteConfigProject,
            tsconfig: './tsconfig.json',
            diagnosticSources,
            incremental: true,
            status: 1
        },
        (records, issues) => {
            const matchingErrors = records.filter(
                (record) =>
                    record.type === 'ERROR' &&
                    record.message.includes('intentional Svelte config load failure')
            );
            if (matchingErrors.length !== 1) {
                issues.push(
                    `expected exactly one config-load diagnostic, got ${matchingErrors.length}`
                );
            }
        }
    );
}

console.log('\nsubprocess failure protocol\n');

test('missing tsgo package is a machine FAILURE', {
    workspace: './test-success',
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'definitely-not-installed' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

const brokenEngineProject = createProject(
    'broken-engine',
    {
        'src/Comp.svelte': '<script lang="ts">const value = 1;</script>',
        'src/plain.ts': 'const target = 1;\n',
        'src/multiline.ts': 'let x = <number>{\n a:1\n};\n'
    },
    {
        compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' },
        include: ['src/**/*']
    }
);
const fakePackage = path.join(brokenEngineProject, 'node_modules', 'fake-tsgo');
fs.mkdirSync(fakePackage, { recursive: true });
fs.writeFileSync(
    path.join(fakePackage, 'package.json'),
    JSON.stringify({ name: 'fake-tsgo', version: '1.0.0', bin: 'bin.js' })
);
fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const fs = require("fs");',
        'if (!process.argv.includes("--listFilesOnly") || process.argv.includes("--listFiles")) process.exit(9);',
        'const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("-p") + 1], "utf8"));',
        'console.log(config.files.find((file) => file.endsWith(".svelte.tsx")));'
    ].join('\n')
);
test('Svelte-only checks ask tsgo for files without type-checking', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    diagnosticSources: 'svelte',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' }
});

fs.writeFileSync(path.join(fakePackage, 'bin.js'), 'process.exit(7);');
test('nonzero child exit without diagnostics is a machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "plain.ts");',
        'console.log(`${file}:1:1 - warning TS9999: warning-only partial result`);',
        'console.log(file);',
        'process.exitCode = 1;'
    ].join('\n')
);
test('nonzero child exit with only warnings is a machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "plain.ts");',
        'console.log(`${file}:1:7 - error TS2769: No overload matches this call.`);',
        "console.log(`  Overload 1 of 2, '(value: string): void', gave the following error.`);",
        "console.log(`    Argument of type 'number' is not assignable to parameter of type 'string'.`);",
        "console.log(`  Overload 2 of 2, '(value: boolean): void', gave the following error.`);",
        "console.log(`    Argument of type 'number' is not assignable to parameter of type 'boolean'.`);",
        'console.log();',
        'console.log("1 const target = 1;");',
        'console.log("      ~~~~~");',
        'console.log(file);',
        'console.log("Found 1 error.");',
        'process.exitCode = 1;'
    ].join('\n')
);
inspect(
    'expected diagnostic exit preserves multiline chains and source spans',
    {
        workspace: brokenEngineProject,
        tsconfig: './tsconfig.json',
        tsgo: true,
        env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
        status: 1
    },
    (records, issues) => {
        const errors = records.filter((record) => record.type === 'ERROR');
        if (errors.length !== 1) {
            issues.push(`expected one parsed native diagnostic, got ${errors.length}`);
            return;
        }
        const [error] = errors;
        const expectedMessage =
            'No overload matches this call.\n' +
            "  Overload 1 of 2, '(value: string): void', gave the following error.\n" +
            "    Argument of type 'number' is not assignable to parameter of type 'string'.\n" +
            "  Overload 2 of 2, '(value: boolean): void', gave the following error.\n" +
            "    Argument of type 'number' is not assignable to parameter of type 'boolean'.";
        if (error.filename.replace(/\\/g, '/') !== 'src/plain.ts') {
            issues.push(`diagnostic mapped to ${error.filename}, expected src/plain.ts`);
        }
        if (error.message !== expectedMessage) {
            issues.push(`multiline diagnostic message was not preserved: ${error.message}`);
        }
        if (
            error.start.line !== 0 ||
            error.start.character !== 6 ||
            error.end.line !== 0 ||
            error.end.character !== 11
        ) {
            issues.push(
                `expected range 0:6-0:11, got ${JSON.stringify({ start: error.start, end: error.end })}`
            );
        }
    }
);

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "multiline.ts");',
        'console.log(`${file}:1:9 - error TS2352: Conversion may be a mistake.`);',
        'console.log();',
        'console.log("1 let x = <number>{");',
        'console.log("          ~~~~~~~~~");',
        'console.log("2  a:1");',
        'console.log("  ~~~~");',
        'console.log("3 };");',
        'console.log("  ~");',
        'console.log(file);',
        'console.log("Found 1 error.");',
        'process.exitCode = 1;'
    ].join('\n')
);
inspect(
    'machine output preserves a multiline native source range',
    {
        workspace: brokenEngineProject,
        tsconfig: './tsconfig.json',
        tsgo: true,
        env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
        status: 1
    },
    (records, issues) => {
        const errors = records.filter((record) => record.type === 'ERROR');
        if (errors.length !== 1) {
            issues.push(`expected one multiline diagnostic, got ${errors.length}`);
            return;
        }
        const [error] = errors;
        if (
            error.start.line !== 0 ||
            error.start.character !== 8 ||
            error.end.line !== 2 ||
            error.end.character !== 1
        ) {
            issues.push(
                `expected range 0:8-2:1, got ${JSON.stringify({ start: error.start, end: error.end })}`
            );
        }
    }
);

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "plain.ts");',
        'console.log(`${file}:1:1 - error TS9999: truncated after file list`);',
        'console.log(file);',
        'process.exitCode = 1;'
    ].join('\n')
);
test('expected diagnostic status without a terminal summary is a machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "plain.ts");',
        'console.log(`${file}:1:1 - error TS9999: fatal-looking diagnostic`);',
        'console.log(file);',
        'process.exitCode = 7;'
    ].join('\n')
);
test('unexpected child status is fatal even with diagnostics and a file list', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "plain.ts");',
        'console.log(`${file}:1:1 - error TS9999: diagnostic without completion`);',
        'process.exitCode = 1;'
    ].join('\n')
);
test('diagnostics without a program file list are a machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const fs = require("fs");',
        'const overlay = process.argv[process.argv.indexOf("-p") + 1];',
        'const config = JSON.parse(fs.readFileSync(overlay, "utf8"));',
        'console.log(`${overlay}:1:1 - error TS5023: Unknown compiler option.`);',
        'console.log(config.files.find((file) => file.endsWith(".svelte.tsx")));',
        'console.log("Found 1 error.");',
        'process.exitCode = 1;'
    ].join('\n')
);
test('generated overlay config diagnostics point to the user config', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    errors: [{ file: 'tsconfig.json', line: 0, column: 0, code: 5023 }]
});

fs.writeFileSync(path.join(fakePackage, 'bin.js'), 'process.kill(process.pid, "SIGTERM");');
test('killed native child is a machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
);
test('SIGTERM-ignoring native child timeout is a bounded machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo', SVELTE_LS_TSGO_TIMEOUT_MS: '50' },
    status: 1,
    expectFailure: true,
    expectCompleted: false,
    maxDurationMs: 3_000
});

fs.writeFileSync(path.join(fakePackage, 'bin.js'), 'console.log("not compiler output");');
test('successful child with malformed output is a machine FAILURE', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.writeFileSync(
    path.join(fakePackage, 'bin.js'),
    [
        'const path = require("path");',
        'const file = path.join(process.cwd(), "src", "plain.ts");',
        'console.log("garbage before otherwise valid output");',
        'console.log(`${file}:1:1 - error TS9999: valid-looking diagnostic`);',
        'console.log(file);',
        'process.exitCode = 1;'
    ].join('\n')
);
test('non-verbose machine output rejects mixed valid and malformed native output', {
    workspace: brokenEngineProject,
    tsconfig: './tsconfig.json',
    tsgo: true,
    output: 'machine',
    env: { SVELTE_LS_TSGO_PACKAGE: 'fake-tsgo' },
    status: 1,
    expectFailure: true,
    expectCompleted: false
});

fs.rmSync(parityRoot, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
