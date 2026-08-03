import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import {
    createMemberCompletionSlice,
    IsolatedMemberCompletionProvider,
    resolveIsolatedCompilerOptions
} from '../../../../src/plugins/typescript-go/lsp/IsolatedMemberCompletion';

describe('IsolatedMemberCompletionProvider', () => {
    let directory: string;
    let provider: IsolatedMemberCompletionProvider;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-isolated-completion-'));
        provider = new IsolatedMemberCompletionProvider();
        fs.mkdirSync(path.join(directory, 'node_modules', 'fixture'), { recursive: true });
        fs.writeFileSync(
            path.join(directory, 'node_modules', 'fixture', 'package.json'),
            JSON.stringify({ name: 'fixture', version: '1.0.0', types: 'index.d.ts' })
        );
        fs.writeFileSync(
            path.join(directory, 'node_modules', 'fixture', 'index.d.ts'),
            [
                'export declare class Persisted<T> {',
                '  readonly current: T;',
                '  reset(): void;',
                '  update(value: T): void;',
                '}'
            ].join('\n')
        );
        fs.writeFileSync(
            path.join(directory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    strict: true,
                    module: 'esnext',
                    moduleResolution: 'bundler',
                    target: 'es2021'
                },
                include: ['src/**/*.ts']
            })
        );
    });

    afterEach(() => {
        provider.dispose();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('answers an imported generic member without loading unrelated declarations', () => {
        const generatedText = [
            `import { Persisted } from 'fixture';`,
            `import { Unused } from './does-not-exist';`,
            'function $$render() {',
            '  const auth = missingApplicationGraph();',
            '  const selected = new Persisted<string | null>(`${auth.id}`, null as any);',
            '  selected.c',
            '}'
        ].join('\n');
        const offset = generatedText.lastIndexOf('selected.c') + 'selected.c'.length;
        const compilerOptions = resolveIsolatedCompilerOptions(
            path.join(directory, 'src', 'Component.svelte')
        ).options;

        const result = provider.getCompletions({
            filePath: path.join(directory, 'src', 'Component.svelte'),
            generatedText,
            generatedOffset: offset,
            version: 1,
            compilerOptions
        });

        assert(result);
        assert(result.entries.some((entry) => entry.name === 'current'));
        assert.equal(result.prefix, 'c');
        assert.equal(result.isIncomplete, true);
        const slice = createMemberCompletionSlice(generatedText, offset);
        assert(slice);
        assert.match(slice.text, /from 'fixture'/);
        assert.doesNotMatch(slice.text, /does-not-exist/);
        assert.doesNotMatch(slice.text, /missingApplicationGraph/);
    });

    it('answers the same receiver inside generated template code', () => {
        const generatedText = [
            `import { Persisted } from 'fixture';`,
            'function $$render() {',
            '  const selected = new Persisted<string | null>(null as any);',
            '  __sveltets_2_createElement("div", { value: selected.c });',
            '}'
        ].join('\n');
        const offset = generatedText.lastIndexOf('selected.c') + 'selected.c'.length;
        const result = provider.getCompletions({
            filePath: path.join(directory, 'src', 'Component.svelte'),
            generatedText,
            generatedOffset: offset,
            version: 1,
            compilerOptions: resolveIsolatedCompilerOptions(
                path.join(directory, 'src', 'Component.svelte')
            ).options
        });

        assert(result?.entries.some((entry) => entry.name === 'current'));
    });

    it('updates the synthetic root instead of returning a stale member list', () => {
        const filePath = path.join(directory, 'src', 'Component.svelte');
        const compilerOptions = resolveIsolatedCompilerOptions(filePath).options;
        const firstText = `const value = { alpha: 1 }; value.a`;
        const first = provider.getCompletions({
            filePath,
            generatedText: firstText,
            generatedOffset: firstText.length,
            version: 1,
            compilerOptions
        });
        assert(first?.entries.some((entry) => entry.name === 'alpha'));

        const secondText = `const value = { beta: 1 }; value.b`;
        const second = provider.getCompletions({
            filePath,
            generatedText: secondText,
            generatedOffset: secondText.length,
            version: 2,
            compilerOptions
        });
        assert(second?.entries.some((entry) => entry.name === 'beta'));
        assert(!second?.entries.some((entry) => entry.name === 'alpha'));
    });

    it('never presents a declaration slice as an exhaustive member list', () => {
        const filePath = path.join(directory, 'src', 'Component.svelte');
        const generatedText = [
            'const base = { alpha: 1 };',
            'const value: { beta: number } = { ...base, beta: 2 };',
            'value.'
        ].join('\n');
        const result = provider.getCompletions({
            filePath,
            generatedText,
            generatedOffset: generatedText.length,
            version: 1,
            compilerOptions: resolveIsolatedCompilerOptions(filePath).options
        });

        assert(result?.entries.some((entry) => entry.name === 'beta'));
        assert.equal(
            result?.isIncomplete,
            true,
            'the omitted spread base means this fast list cannot be authoritative'
        );
    });

    it('does not claim global, string, or comment completion contexts', () => {
        for (const text of ['const value = glo', 'const value = "thing.x"', '// value.x']) {
            assert.equal(
                provider.getCompletions({
                    filePath: path.join(directory, 'src', 'Component.svelte'),
                    generatedText: text,
                    generatedOffset: text.length,
                    version: 1,
                    compilerOptions: {}
                }),
                undefined
            );
        }
    });

    it('parses extends and paths without enumerating include roots', () => {
        const basePath = path.join(directory, 'base.json');
        fs.writeFileSync(
            basePath,
            JSON.stringify({ compilerOptions: { paths: { '$lib/*': ['./src/lib/*'] } } })
        );
        fs.writeFileSync(
            path.join(directory, 'tsconfig.json'),
            JSON.stringify({ extends: './base.json', include: ['src/**/*'] })
        );
        let scans = 0;
        const system: ts.System = {
            ...ts.sys,
            readDirectory: (...args) => {
                scans++;
                return ts.sys.readDirectory(...args);
            }
        };

        const result = resolveIsolatedCompilerOptions(
            path.join(directory, 'src', 'Component.svelte'),
            system
        );

        assert.equal(result.errors.length, 0);
        assert.deepEqual(result.options.paths?.['$lib/*'], ['./src/lib/*']);
        assert.equal(scans, 0);
    });
});
