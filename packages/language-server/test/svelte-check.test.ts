import assert from 'assert';
import { DiagnosticSeverity, Range } from 'vscode-languageserver';
import {
    deduplicateSvelteParserDiagnostics,
    preloadSvelteConfigsForClassicDiagnostics,
    SvelteCheck,
    SvelteCheckOptions
} from '../src/svelte-check';

function typecheckRemovedTsGoInjection(): void {
    const options: SvelteCheckOptions = {
        // @ts-expect-error The executable and API package identity must be resolved together.
        experimental: { tsgo: { apiModule: {}, astModule: {} } }
    };
    void options;
}

void typecheckRemovedTsGoInjection;

describe('SvelteCheck config lifecycle', () => {
    it('rejects legacy runtime tsgo module injection', () => {
        const legacyOptions = {
            experimental: {
                tsgo: {
                    apiModule: { API: class {} },
                    astModule: { ScriptKind: {} }
                }
            }
        } as unknown as SvelteCheckOptions;

        assert.throws(
            () => new SvelteCheck('/workspace', legacyOptions),
            /caller-provided API modules cannot be matched to the resolved native engine/
        );
    });

    it('settles every Svelte config before classic diagnostics may continue', async () => {
        const started: string[] = [];
        const finished: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));

        const preloading = preloadSvelteConfigsForClassicDiagnostics(
            [
                { fileName: '/workspace/app/Component.svelte' },
                { fileName: '/workspace/package/Dependency.svelte' },
                { fileName: '/workspace/app/helper.ts' }
            ],
            async (fileName) => {
                started.push(fileName);
                await gate;
                finished.push(fileName);
            }
        );

        await Promise.resolve();
        assert.deepStrictEqual(started, [
            '/workspace/app/Component.svelte',
            '/workspace/package/Dependency.svelte'
        ]);
        assert.deepStrictEqual(finished, []);

        release();
        await preloading;
        assert.deepStrictEqual(finished, started);
    });

    it('surfaces a Svelte config failure instead of starting diagnostics', async () => {
        const failure = new Error('broken package config');

        await assert.rejects(
            preloadSvelteConfigsForClassicDiagnostics(
                [{ fileName: '/workspace/app/Component.svelte' }],
                async () => {
                    throw failure;
                }
            ),
            failure
        );
    });

    it('prefers a named Svelte 4 compiler error over its generated TypeScript copy', () => {
        const compilerError = {
            range: Range.create(1, 0, 1, 0),
            severity: DiagnosticSeverity.Error,
            source: 'svelte',
            code: 'unclosed-block',
            codeDescription: {
                href: 'https://svelte.dev/docs/svelte/compiler-errors#unclosed_block'
            },
            message: 'Block was left open'
        };
        const generatedCopy = {
            range: Range.create(1, 0, 1, 0),
            severity: DiagnosticSeverity.Error,
            source: 'ts',
            code: -1,
            message: 'Block was left open'
        };

        assert.deepStrictEqual(deduplicateSvelteParserDiagnostics([generatedCopy, compilerError]), [
            compilerError
        ]);
    });

    it('preserves multiplicity for ordinary diagnostics with the same message', () => {
        const diagnostic = {
            range: Range.create(0, 0, 0, 1),
            severity: DiagnosticSeverity.Error,
            source: 'ts',
            code: 2304,
            message: "Cannot find name 'Button'."
        };

        assert.deepStrictEqual(deduplicateSvelteParserDiagnostics([diagnostic, diagnostic]), [
            diagnostic,
            diagnostic
        ]);
    });
});
