import assert from 'assert';
import { TsGoComponentInfo } from '../../../../src/plugins/typescript-go/lsp/TsGoComponentInfo';

describe('typescript-go TsGoComponentInfo cache invalidation', () => {
    it('does not conflate same-named component tags in different lexical scopes', async () => {
        let definitionCalls = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async (type: any) => type.text ?? 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) =>
                symbol.carrierPath ? { filePath: symbol.carrierPath } : { text: 'string' },
            getPropertiesOfType: async (type: any) => [
                { name: type.filePath.includes('First') ? 'firstProp' : 'secondProp' }
            ],
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const session = {
            signatureKind: { Call: 0, Construct: 1 },
            getProjectForFile: async () => ({ checker })
        };
        const info = new TsGoComponentInfo(session as any, async (_shadowPath, offset) => {
            definitionCalls++;
            return {
                filePath:
                    offset === 10 ? '/workspace/First.svelte.tsx' : '/workspace/Second.svelte.tsx',
                offset: 1
            };
        });

        const first = await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button');
        const second = await info.getProps('/workspace/Usage.svelte.tsx', 20, 'Button');
        // The same occurrence still gets the normal cache hit.
        await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button');

        assert.deepStrictEqual(
            first.map((part) => part.name),
            ['firstProp']
        );
        assert.deepStrictEqual(
            second.map((part) => part.name),
            ['secondProp']
        );
        assert.strictEqual(definitionCalls, 2);
    });

    it('re-resolves a component after an unsaved TypeScript barrel retarget', async () => {
        let target = '/workspace/First.svelte.tsx';
        let definitionCalls = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async () => 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) => ({ filePath: symbol.carrierPath }),
            getPropertiesOfType: async (type: any) => [
                { name: type.filePath.includes('First') ? 'firstProp' : 'secondProp' }
            ],
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const info = new TsGoComponentInfo(
            {
                signatureKind: { Call: 0, Construct: 1 },
                getProjectForFile: async () => ({ checker })
            } as any,
            async () => {
                definitionCalls++;
                return { filePath: target, offset: 1 };
            }
        );

        const first = await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button');
        target = '/workspace/Second.svelte.tsx';
        assert.deepStrictEqual(
            (await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button')).map(
                (part) => part.name
            ),
            ['firstProp'],
            'the fixture must demonstrate the cached usage definition before invalidation'
        );

        info.invalidateResolutionGraph();
        const second = await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button');

        assert.deepStrictEqual(
            first.map((part) => part.name),
            ['firstProp']
        );
        assert.deepStrictEqual(
            second.map((part) => part.name),
            ['secondProp']
        );
        assert.strictEqual(definitionCalls, 2);
    });

    it('invalidates both usage definitions and declaration type information', () => {
        const info = new TsGoComponentInfo({} as any, async () => undefined);
        const cache = (info as any).cache as Map<string, unknown>;
        const definitions = (info as any).definitionCache as Map<string, unknown>;
        cache.set('/workspace/Button.svelte.tsx:10:props:', {});
        cache.set('/workspace/Other.svelte.tsx:10:props:', {});
        definitions.set('/workspace/Usage.svelte.tsx::Button', {
            filePath: '/workspace/Button.svelte.tsx',
            offset: 10
        });
        definitions.set('/workspace/Usage.svelte.tsx::Other', {
            filePath: '/workspace/Other.svelte.tsx',
            offset: 10
        });

        info.invalidateFile('/workspace/Button.svelte.tsx');

        assert.deepStrictEqual([...cache.keys()], ['/workspace/Other.svelte.tsx:10:props:']);
        assert.deepStrictEqual([...definitions.keys()], ['/workspace/Usage.svelte.tsx::Other']);
    });

    it('invalidates all tag definitions for a changed usage file', () => {
        const info = new TsGoComponentInfo({} as any, async () => undefined);
        const definitions = (info as any).definitionCache as Map<string, unknown>;
        definitions.set('/workspace/Usage.svelte.tsx::Button', undefined);
        definitions.set('/workspace/Other.svelte.tsx::Button', undefined);

        info.invalidateFile('/workspace/Usage.svelte.tsx');

        assert.deepStrictEqual([...definitions.keys()], ['/workspace/Other.svelte.tsx::Button']);
    });
});
