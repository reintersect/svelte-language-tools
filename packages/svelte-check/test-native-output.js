// @ts-check

const assert = require('node:assert/strict');

// These are source-level parser tests. The CLI bundle intentionally exposes no parser API, so
// load just the TypeScript sources with the repository's existing ts-node development dependency.
require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'Node16',
        moduleResolution: 'Node16',
        target: 'ES2021',
        rootDir: process.cwd()
    }
});

const { DiagnosticSeverity } = require('vscode-languageserver-protocol');
const { parseDiagnostics } = require('./src/incremental.ts');
const { NativeCompilerOutputCollector, parseListedFiles } = require('./src/tsgo-overlay.ts');

let passed = 0;

/** @param {string} name @param {() => void} body */
function test(name, body) {
    try {
        body();
        passed++;
        console.log(`  PASS: ${name}`);
    } catch (error) {
        console.error(`  FAIL: ${name}`);
        throw error;
    }
}

console.log('native compiler output parser tests\n');

test('preserves multiline diagnostic chains and spans beyond four lines', () => {
    const output = [
        '/work/src/index.ts:3:7 - error TS2769: No overload matches this call.',
        "  Overload 1 of 2, '(value: string): void', gave the following error.",
        "    Argument of type 'number' is not assignable to parameter of type 'string'.",
        "  Overload 2 of 2, '(value: boolean): void', gave the following error.",
        "    Argument of type 'number' is not assignable to parameter of type 'boolean'.",
        '',
        '3 call(12345);',
        '      ~~~~~',
        '',
        '/work/src/index.ts'
    ].join('\n');

    assert.deepEqual(parseDiagnostics(output, '/work'), [
        {
            filePath: '/work/src/index.ts',
            line: 2,
            character: 6,
            length: 5,
            severity: DiagnosticSeverity.Error,
            code: 2769,
            message:
                'No overload matches this call.\n' +
                "  Overload 1 of 2, '(value: string): void', gave the following error.\n" +
                "    Argument of type 'number' is not assignable to parameter of type 'string'.\n" +
                "  Overload 2 of 2, '(value: boolean): void', gave the following error.\n" +
                "    Argument of type 'number' is not assignable to parameter of type 'boolean'."
        }
    ]);
});

test('keeps Windows absolute diagnostic paths absolute', () => {
    const [diagnostic] = parseDiagnostics(
        'C:\\repo\\src\\index.ts:12:8 - warning TS6133: value is declared but never read.',
        '/unrelated/posix/root'
    );

    assert.equal(diagnostic.filePath, 'C:\\repo\\src\\index.ts');
    assert.equal(diagnostic.line, 11);
    assert.equal(diagnostic.character, 7);
    assert.equal(diagnostic.severity, DiagnosticSeverity.Warning);
});

test('parses related locations without replacing the primary source span', () => {
    const output = [
        "/work/src/use.ts:2:16 - error TS2322: Type 'string' is not assignable to type 'number'.",
        '',
        '2 const options = { count: "x" };',
        '                 ~~~',
        '',
        "  src/types.ts:1:28 - The expected type comes from property 'count'.",
        '    1 export interface Options { count: number }',
        '                                   ~~~~~',
        '',
        '/work/src/use.ts'
    ].join('\n');

    assert.deepEqual(parseDiagnostics(output, '/work'), [
        {
            filePath: '/work/src/use.ts',
            line: 1,
            character: 15,
            length: 3,
            severity: DiagnosticSeverity.Error,
            code: 2322,
            message: "Type 'string' is not assignable to type 'number'.",
            relatedInformation: [
                {
                    filePath: '/work/src/types.ts',
                    line: 0,
                    character: 27,
                    length: 5,
                    message: "The expected type comes from property 'count'."
                }
            ]
        }
    ]);
});

test('retains non-error compiler severity', () => {
    const diagnostics = parseDiagnostics(
        [
            'suggestion TS80001: Convert CommonJS module to ES module.',
            'message TS6031: Starting compilation in watch mode.'
        ].join('\n'),
        '/work'
    );

    assert.deepEqual(
        diagnostics.map(({ severity, code }) => ({ severity, code })),
        [
            { severity: DiagnosticSeverity.Hint, code: 80001 },
            { severity: DiagnosticSeverity.Information, code: 6031 }
        ]
    );
});

test('recognizes POSIX, drive-letter and UNC program members without diagnostic headers', () => {
    const output = [
        '\u001b[32m/work/src/index.ts\u001b[0m',
        'C:\\repo\\src\\index.ts',
        '\\\\server\\share\\types.d.ts',
        'C:\\repo\\src\\index.ts',
        'C:\\repo\\src\\index.ts:1:1 - error TS1000: not a member line',
        'Found 1 error.'
    ].join('\n');

    assert.deepEqual(parseListedFiles(output), [
        '/work/src/index.ts',
        'C:\\repo\\src\\index.ts',
        '\\\\server\\share\\types.d.ts'
    ]);
});

test('streams arbitrary chunks without interleaving stdout and stderr diagnostic blocks', () => {
    const stdout = [
        '/work/src/index.ts:3:7 - error TS2769: No overload matches this call.',
        "  Overload 1 of 2, '(value: string): void', gave the following error.",
        "    Argument of type 'number' is not assignable to parameter of type 'string'.",
        "  Overload 2 of 2, '(value: boolean): void', gave the following error.",
        "    Argument of type 'number' is not assignable to parameter of type 'boolean'.",
        '',
        '3 call(12345);',
        '      ~~~~~',
        '',
        '/work/src/index.ts'
    ].join('\n');
    const stderr = [
        'C:\\repo\\src\\other.ts:1:2 - warning TS6133: value is declared but never read.',
        '',
        '1 value',
        ' ~~~~~'
    ].join('\r\n');
    const collector = new NativeCompilerOutputCollector('/work');

    // Feed the first stream one character at a time and inject the second stream while the
    // first diagnostic is incomplete. Independent stream state must prevent the diagnostic
    // chains from being spliced together by event arrival order.
    const split = Math.floor(stdout.length / 2);
    for (const character of stdout.slice(0, split)) collector.push('stdout', character);
    for (let offset = 0; offset < stderr.length; offset += 3) {
        collector.push('stderr', stderr.slice(offset, offset + 3));
    }
    for (const character of stdout.slice(split)) collector.push('stdout', character);

    const result = collector.finish();
    assert.deepEqual(
        result.diagnostics.map(({ code, severity, length }) => ({ code, severity, length })),
        [
            { code: 2769, severity: DiagnosticSeverity.Error, length: 5 },
            { code: 6133, severity: DiagnosticSeverity.Warning, length: 5 }
        ]
    );
    assert.equal(
        result.diagnostics[0].message,
        'No overload matches this call.\n' +
            "  Overload 1 of 2, '(value: string): void', gave the following error.\n" +
            "    Argument of type 'number' is not assignable to parameter of type 'string'.\n" +
            "  Overload 2 of 2, '(value: boolean): void', gave the following error.\n" +
            "    Argument of type 'number' is not assignable to parameter of type 'boolean'."
    );
    assert.deepEqual(result.files, ['/work/src/index.ts']);
});

console.log(`\n${passed} passed, 0 failed`);
