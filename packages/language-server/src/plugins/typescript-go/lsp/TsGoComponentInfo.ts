import { ComponentPartInfo } from '../../typescript/ComponentInfoProvider';
import { Logger } from '../../../logger';
import { TsGoApiSession } from './TsGoApiSession';

/**
 * Port of `ComponentInfoProvider` onto tsgo's checker.
 *
 * The shape of the walk is identical to the JS engine's: resolve the component's type, find the
 * carrier for its props/events/slots, then enumerate that type's properties. Only the API
 * spellings differ — tsgo has `getPropertyOfType(type, name)` rather than `type.getProperty()`,
 * `getSignaturesOfType(type, kind)` rather than `type.getConstructSignatures()`, and
 * `getDocumentationCommentOfSymbol` returns a plain string, so there is no
 * `displayPartsToString` step.
 */
export class TsGoComponentInfo {
    /**
     * Memoised part descriptions, keyed on the component's *declaration* — where the type
     * lives — not on the usage site. Typing inside `<Button …>` re-asks for Button's props on
     * every keystroke, but every keystroke is in the *usage* file; the declaration hasn't
     * moved, so the walk (one `updateSnapshot`, then several checker round trips per property)
     * would be repaid with an identical answer each time.
     */
    private readonly cache = new Map<string, { token: string; parts: ComponentPartInfo }>();
    /**
     * Where a tag name in a given usage file declares its component. The identity of `<Button>`
     * inside one file only changes when imports change — a watched-file event — while the
     * definition lookup is an LSP round trip paid on every keystroke inside the tag otherwise.
     */
    private readonly definitionCache = new Map<
        string,
        { filePath: string; offset: number } | undefined
    >();

    constructor(
        private readonly session: TsGoApiSession,
        /** Resolves a generated position to the declaration it points at, via LSP. */
        private readonly definitionAt: (
            shadowPath: string,
            offset: number
        ) => Promise<{ filePath: string; offset: number } | undefined>,
        /**
         * The overlay version of a shadow document, when it is open in tsgo. Cache validity:
         * an open declaration changes through didChange (version moves), a closed one only
         * through watched-file events (the plugin calls {@link clearCache} for those).
         */
        private readonly documentVersion: (filePath: string) => number | undefined = () => undefined
    ) {}

    /** Drop every memoised answer — a watched file changed, or tsgo restarted. */
    clearCache() {
        this.cache.clear();
        this.definitionCache.clear();
    }

    async dispose() {
        this.clearCache();
        await this.session.dispose();
    }

    /**
     * Invalidate answers affected by one changed overlay.
     *
     * The usage-side definition cache is especially important here: an unsaved import edit can
     * make the same `<Button>` tag resolve to a different declaration without producing a watched
     * file event. Declaration-side entries are removed as well so open TS/Svelte edits cannot
     * leave stale prop types behind.
     */
    invalidateFile(filePath: string) {
        const usagePrefix = `${filePath}::`;
        for (const [key, definition] of this.definitionCache) {
            if (key.startsWith(usagePrefix) || definition?.filePath === filePath) {
                this.definitionCache.delete(key);
            }
        }
        const declarationPrefix = `${filePath}:`;
        for (const key of this.cache.keys()) {
            if (key.startsWith(declarationPrefix)) {
                this.cache.delete(key);
            }
        }
    }

    async getProps(
        shadowPath: string,
        generatedOffset: number,
        tagName?: string
    ): Promise<ComponentPartInfo> {
        return this.getPart(shadowPath, generatedOffset, 'props', undefined, tagName);
    }

    async getEvents(
        shadowPath: string,
        generatedOffset: number,
        tagName?: string
    ): Promise<ComponentPartInfo> {
        return this.getPart(shadowPath, generatedOffset, 'events', undefined, tagName);
    }

    async getSlotLets(
        shadowPath: string,
        generatedOffset: number,
        slot = 'default'
    ): Promise<ComponentPartInfo> {
        return this.getPart(shadowPath, generatedOffset, 'slots', slot);
    }

    private async getPart(
        shadowPath: string,
        generatedOffset: number,
        part: 'props' | 'events' | 'slots',
        slot?: string,
        tagName?: string
    ): Promise<ComponentPartInfo> {
        try {
            // Resolve the declaration first: it is both the anchor for the type walk and the
            // cache key. Memoised per (usage file, tag name) so a keystroke inside the tag
            // costs no LSP round trip at all once the component is known.
            // A component-valued identifier can be shadowed in separate template scopes. The
            // visible tag name is therefore not enough to identify its declaration: two
            // `<Button>` occurrences in one file may legitimately resolve to different symbols.
            // Include the generated usage position so each lexical occurrence retains its own
            // definition while repeated requests at that occurrence still share the lookup.
            const definitionKey = tagName
                ? `${shadowPath}::${tagName}::${generatedOffset}`
                : undefined;
            let definition = definitionKey ? this.definitionCache.get(definitionKey) : undefined;
            if (
                definition === undefined &&
                (!definitionKey || !this.definitionCache.has(definitionKey))
            ) {
                definition = await this.definitionAt(shadowPath, generatedOffset);
                if (definitionKey) {
                    if (this.definitionCache.size >= 200) {
                        this.definitionCache.delete(this.definitionCache.keys().next().value!);
                    }
                    this.definitionCache.set(definitionKey, definition);
                }
            }
            const cacheKey = definition
                ? `${definition.filePath}:${definition.offset}:${part}:${slot ?? ''}`
                : undefined;
            if (cacheKey) {
                const cached = this.cache.get(cacheKey);
                if (cached && cached.token === this.cacheToken(definition!.filePath)) {
                    return cached.parts;
                }
            }

            // Connecting (inside getProjectForFile) is what populates `signatureKind`, so the
            // kinds check has to come after it — not before, where it would always be empty on
            // the very first lookup and silently disable the feature.
            const project = await this.session.getProjectForFile(shadowPath);
            const kinds = this.session.signatureKind;
            if (!project || !kinds) {
                return [];
            }
            const checker = project.checker;

            const type = await this.componentTypeAt(
                checker,
                shadowPath,
                generatedOffset,
                definition
            );
            if (!type) {
                return [];
            }

            const carrier = await this.resolveCarrier(checker, kinds, type, part);
            if (!carrier) {
                return [];
            }

            let parts: ComponentPartInfo;
            if (part === 'slots') {
                const slotSymbol = await checker.getPropertyOfType(carrier, slot ?? 'default');
                if (!slotSymbol) {
                    return [];
                }
                const slotType = await checker.getTypeOfSymbol(slotSymbol);
                parts = slotType ? await this.describe(checker, slotType) : [];
            } else {
                parts = await this.describe(checker, carrier);
            }

            if (cacheKey && parts.length) {
                if (this.cache.size >= 200) {
                    this.cache.delete(this.cache.keys().next().value!);
                }
                this.cache.set(cacheKey, {
                    token: this.cacheToken(definition!.filePath),
                    parts
                });
            }
            return parts;
        } catch (e) {
            Logger.debug('[tsgo] component info lookup failed', e);
            return [];
        }
    }

    private cacheToken(declarationPath: string): string {
        return `v${this.documentVersion(declarationPath) ?? 'disk'}`;
    }

    /**
     * Resolve the component's *declared* type from a usage site.
     *
     * Taking the type directly at the tag position is not enough: svelte2tsx wraps components
     * at the point of use, so the type there comes back as `LegacyComponentType`, whose props
     * carrier is a bare `Record<string, any>` with no declared members. The JS engine sidesteps
     * this by running go-to-definition first; the equivalent here is to resolve the symbol and
     * follow its import alias, which lands on the real component type.
     */
    private async componentTypeAt(
        checker: any,
        shadowPath: string,
        generatedOffset: number,
        definition: { filePath: string; offset: number } | undefined
    ): Promise<any | undefined> {
        // Follow go-to-definition first, exactly as the JS engine does. At the usage site the
        // symbol frequently resolves through a barrel re-export to svelte's ambient
        // `declare module '*.svelte'`, whose type is `LegacyComponentType` with a
        // `Record<string, any>` props carrier — useless for completions. The declaration lands
        // on the component's own generated shadow, where the real type lives.
        if (definition) {
            const atDefinition = await checker.getTypeAtPosition(
                definition.filePath,
                definition.offset
            );
            if (atDefinition && !(await this.isOpaque(checker, atDefinition))) {
                return atDefinition;
            }
        }
        return checker.getTypeAtPosition(shadowPath, generatedOffset);
    }

    /** `LegacyComponentType` and friends carry no usable prop information. */
    private async isOpaque(checker: any, type: any): Promise<boolean> {
        const name = await checker.typeToString(type);
        return name === 'LegacyComponentType' || name === 'any';
    }

    /**
     * Find the type carrying a component's props/events/slots.
     *
     * Svelte 4 components are classes with `$$prop_def`; Svelte 5 emits an isomorphic component
     * with both a construct and a call signature. The construct signature returns a
     * `SvelteComponent` that still carries the `$$*_def` members, so it is preferred; the call
     * signature's second parameter is the fallback for runes-only components.
     */
    private async resolveCarrier(
        checker: any,
        kinds: { Call: number; Construct: number },
        type: any,
        part: 'props' | 'events' | 'slots'
    ): Promise<any | undefined> {
        const defName =
            part === 'props' ? '$$prop_def' : part === 'events' ? '$$events_def' : '$$slot_def';

        const direct = await this.memberType(checker, type, defName);
        if (direct) {
            return direct;
        }

        const constructSignatures = await checker.getSignaturesOfType(type, kinds.Construct);
        if (constructSignatures?.length === 1) {
            const returned = await checker.getReturnTypeOfSignature(constructSignatures[0]);
            const fromInstance = returned && (await this.memberType(checker, returned, defName));
            if (fromInstance) {
                return fromInstance;
            }
        }

        // Runes-only components: `(internal, props) => ...`, so props is parameter index 1 and
        // there is no `$$prop_def` anywhere. Events and slots have no counterpart in that shape.
        if (part !== 'props') {
            return undefined;
        }
        const callSignatures = await checker.getSignaturesOfType(type, kinds.Call);
        if (callSignatures?.length !== 1) {
            return undefined;
        }
        return checker.getParameterType(callSignatures[0], 1);
    }

    private async memberType(checker: any, type: any, name: string): Promise<any | undefined> {
        const symbol = await checker.getPropertyOfType(type, name);
        return symbol ? checker.getTypeOfSymbol(symbol) : undefined;
    }

    private async describe(checker: any, type: any): Promise<ComponentPartInfo> {
        const properties = await checker.getPropertiesOfType(type);
        if (!properties?.length) {
            return [];
        }
        // Every checker call is an IPC round trip over the API pipe. Serially, a 30-prop
        // component was ~90 of them back to back — the dominant cost of the first completion
        // inside its tag. In parallel the wall time is one round trip deep per layer.
        const described = await Promise.all(
            properties
                .filter((property: any) => !property.name.startsWith('$$'))
                .map(async (property: any) => {
                    const [propertyType, doc] = await Promise.all([
                        checker.getTypeOfSymbol(property),
                        checker.getDocumentationCommentOfSymbol(property)
                    ]);
                    return {
                        name: property.name,
                        type: propertyType ? await checker.typeToString(propertyType) : 'any',
                        doc
                    };
                })
        );
        return described;
    }
}
