import assert from 'assert';
import { TsGoComponentInfo } from '../../../../src/plugins/typescript-go/lsp/TsGoComponentInfo';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

const sessionFor = (checker: any) => ({
    signatureKind: { Call: 0, Construct: 1 },
    withProjectForFile: async (
        _fileName: string,
        operation: (project: { checker: any }) => unknown
    ) => operation({ checker })
});

describe('typescript-go TsGoComponentInfo cache invalidation', () => {
    it('overlaps and single-flights concurrent first definition and prop lookups', async () => {
        const releaseDefinition = deferred<{ filePath: string; offset: number } | undefined>();
        const releaseProject = deferred<void>();
        let definitionCalls = 0;
        let projectCalls = 0;
        let propertyWalks = 0;
        let definitionStarted = false;
        let projectStarted = false;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async (type: any) => type.text ?? 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) =>
                symbol.carrierPath ? { filePath: symbol.carrierPath } : { text: 'string' },
            getPropertiesOfType: async () => {
                propertyWalks++;
                return [{ name: 'size' }];
            },
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const session = {
            signatureKind: { Call: 0, Construct: 1 },
            withProjectForFile: async (
                _fileName: string,
                operation: (project: { checker: any }) => unknown,
                isCurrent: () => boolean
            ) => {
                projectCalls++;
                projectStarted = true;
                await releaseProject.promise;
                return isCurrent() ? operation({ checker }) : undefined;
            }
        };
        const info = new TsGoComponentInfo(session as any, async () => {
            definitionCalls++;
            definitionStarted = true;
            return releaseDefinition.promise;
        });

        const first = info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button', 'same-context');
        const second = info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button', 'same-context');
        await Promise.resolve();

        assert.strictEqual(projectStarted, true, 'project acquisition must start immediately');
        assert.strictEqual(definitionStarted, true, 'definition resolution must start immediately');
        assert.strictEqual(projectCalls, 1);
        assert.strictEqual(definitionCalls, 1);

        releaseDefinition.resolve({ filePath: '/workspace/Button.svelte.tsx', offset: 1 });
        releaseProject.resolve();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        assert.deepStrictEqual(firstResult, secondResult);
        assert.deepStrictEqual(
            firstResult.map((part) => part.name),
            ['size']
        );
        assert.strictEqual(propertyWalks, 1);
    });

    it('memoises an authoritative empty prop carrier until its declaration version changes', async () => {
        let declarationVersion = 1;
        let definitionCalls = 0;
        let projectCalls = 0;
        let propertyWalks = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async () => 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) => ({ filePath: symbol.carrierPath }),
            getPropertiesOfType: async () => {
                propertyWalks++;
                return [];
            },
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const session = {
            ...sessionFor(checker),
            withProjectForFile: async (
                _fileName: string,
                operation: (project: { checker: any }) => unknown
            ) => {
                projectCalls++;
                return operation({ checker });
            }
        };
        const info = new TsGoComponentInfo(
            session as any,
            async () => {
                definitionCalls++;
                return { filePath: '/workspace/Button.svelte.tsx', offset: 1 };
            },
            () => declarationVersion
        );

        assert.deepStrictEqual(
            await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button'),
            []
        );
        assert.deepStrictEqual(
            await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button'),
            []
        );
        assert.strictEqual(definitionCalls, 1);
        assert.strictEqual(projectCalls, 1);
        assert.strictEqual(propertyWalks, 1);

        declarationVersion++;
        assert.deepStrictEqual(
            await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button'),
            []
        );
        assert.strictEqual(definitionCalls, 1, 'the declaration identity itself remains valid');
        assert.strictEqual(projectCalls, 2);
        assert.strictEqual(propertyWalks, 2);
    });

    it('does not publish or cache a type walk overtaken by a declaration edit', async () => {
        const propertyWalkStarted = deferred<void>();
        const releasePropertyWalk = deferred<void>();
        let declarationVersion = 1;
        let propertyWalks = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async (type: any) => type.text ?? 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) =>
                symbol.carrierPath ? { filePath: symbol.carrierPath } : { text: 'string' },
            getPropertiesOfType: async () => {
                propertyWalks++;
                if (propertyWalks === 1) {
                    propertyWalkStarted.resolve();
                    await releasePropertyWalk.promise;
                }
                return [{ name: 'size' }];
            },
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const info = new TsGoComponentInfo(
            sessionFor(checker) as any,
            async () => ({ filePath: '/workspace/Button.svelte.tsx', offset: 1 }),
            () => declarationVersion
        );

        const stale = info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button');
        await propertyWalkStarted.promise;
        declarationVersion++;
        releasePropertyWalk.resolve();

        assert.deepStrictEqual(await stale, []);
        assert.deepStrictEqual(
            (await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button')).map(
                (part) => part.name
            ),
            ['size']
        );
        assert.strictEqual(propertyWalks, 2);
    });

    it('does not let a cancelled concurrent caller cancel or consume another caller result', async () => {
        const releaseDefinition = deferred<{ filePath: string; offset: number } | undefined>();
        let firstCurrent = true;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async () => 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) =>
                symbol.carrierPath ? { filePath: symbol.carrierPath } : { text: 'string' },
            getPropertiesOfType: async () => [{ name: 'size' }],
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const info = new TsGoComponentInfo(sessionFor(checker) as any, () => {
            return releaseDefinition.promise;
        });

        const cancelled = info.getProps(
            '/workspace/Usage.svelte.tsx',
            10,
            'Button',
            'same-context',
            () => firstCurrent
        );
        const current = info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button', 'same-context');
        firstCurrent = false;
        releaseDefinition.resolve({ filePath: '/workspace/Button.svelte.tsx', offset: 1 });

        assert.deepStrictEqual(await cancelled, []);
        assert.deepStrictEqual(
            (await current).map((part) => part.name),
            ['size']
        );
    });

    it('retries rather than caching a failed definition lookup', async () => {
        let definitionCalls = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async () => 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) =>
                symbol.carrierPath ? { filePath: symbol.carrierPath } : { text: 'string' },
            getPropertiesOfType: async () => [{ name: 'size' }],
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const info = new TsGoComponentInfo(sessionFor(checker) as any, async () => {
            definitionCalls++;
            if (definitionCalls === 1) {
                throw new Error('transient definition failure');
            }
            return { filePath: '/workspace/Button.svelte.tsx', offset: 1 };
        });

        assert.deepStrictEqual(
            await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button'),
            []
        );
        assert.deepStrictEqual(
            (await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button')).map(
                (part) => part.name
            ),
            ['size']
        );
        assert.strictEqual(definitionCalls, 2);
    });

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
        const session = sessionFor(checker);
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
        const info = new TsGoComponentInfo(sessionFor(checker) as any, async () => {
            definitionCalls++;
            return { filePath: target, offset: 1 };
        });

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

    it('retains a semantic usage definition while only component attributes change', async () => {
        let definitionCalls = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async () => 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) => ({ filePath: symbol.carrierPath }),
            getPropertiesOfType: async () => [{ name: 'size' }],
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const info = new TsGoComponentInfo(sessionFor(checker) as any, async () => {
            definitionCalls++;
            return { filePath: '/workspace/Button.svelte.tsx', offset: 1 };
        });

        await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button', 'same-context');
        info.invalidateFile('/workspace/Usage.svelte.tsx', true);
        await info.getProps('/workspace/Usage.svelte.tsx', 40, 'Button', 'same-context');
        assert.strictEqual(definitionCalls, 1);

        info.invalidateFile('/workspace/Usage.svelte.tsx');
        await info.getProps('/workspace/Usage.svelte.tsx', 40, 'Button', 'same-context');
        assert.strictEqual(definitionCalls, 2);
    });

    it('retries a transient negative definition after an attribute edit', async () => {
        let definitionCalls = 0;
        const checker = {
            getTypeAtPosition: async (filePath: string) => ({ filePath }),
            typeToString: async () => 'component',
            getPropertyOfType: async (type: any, name: string) =>
                name === '$$prop_def' ? { carrierPath: type.filePath } : undefined,
            getTypeOfSymbol: async (symbol: any) => ({ filePath: symbol.carrierPath }),
            getPropertiesOfType: async () => [{ name: 'size' }],
            getDocumentationCommentOfSymbol: async () => '',
            getSignaturesOfType: async () => []
        };
        const info = new TsGoComponentInfo(sessionFor(checker) as any, async () => {
            definitionCalls++;
            return definitionCalls === 1
                ? undefined
                : { filePath: '/workspace/Button.svelte.tsx', offset: 1 };
        });

        await info.getProps('/workspace/Usage.svelte.tsx', 10, 'Button', 'same-context');
        info.invalidateFile('/workspace/Usage.svelte.tsx', true);
        const props = await info.getProps(
            '/workspace/Usage.svelte.tsx',
            10,
            'Button',
            'same-context'
        );

        assert.strictEqual(definitionCalls, 2);
        assert.deepStrictEqual(
            props.map((prop) => prop.name),
            ['size']
        );
    });
});
