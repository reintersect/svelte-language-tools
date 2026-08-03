import { ComponentPartInfo } from '../../typescript/ComponentInfoProvider';
import { Logger } from '../../../logger';
import { TsGoApiSession } from './TsGoApiSession';

type ComponentDefinition = { filePath: string; offset: number } | undefined;

type DefinitionLookup =
    | { ok: true; definition: ComponentDefinition }
    | { ok: false; definition?: never };

type PartLookup = {
    definition: ComponentDefinition;
    /** Only a successfully enumerated carrier is safe to memoise, including an empty one. */
    cacheable: boolean;
    parts: ComponentPartInfo;
    token?: string;
};

type InFlightPartLookup = {
    promise: Promise<PartLookup | undefined>;
    waiters: Set<() => boolean>;
};

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
    private readonly definitionCache = new Map<string, ComponentDefinition>();
    /** Concurrent requests for the same tag occurrence share its native definition request. */
    private readonly definitionLookups = new Map<string, Promise<DefinitionLookup>>();
    /** Concurrent completion and hover requests share the checker walk as well. */
    private readonly partLookups = new Map<string, InFlightPartLookup>();
    /** Prevent an in-flight request from repopulating caches after any invalidation boundary. */
    private invalidationEpoch = 0;

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
        this.invalidationEpoch++;
        this.cache.clear();
        this.definitionCache.clear();
    }

    /**
     * A dirty TS/JS overlay can retarget a barrel without touching either the Svelte usage or
     * the old/new component declaration. Definition dependencies are not exposed by tsgo, so
     * fail closed by re-resolving tag definitions while retaining declaration type descriptions.
     */
    invalidateResolutionGraph() {
        this.invalidationEpoch++;
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
    invalidateFile(filePath: string, preserveUsageDefinitions = false) {
        this.invalidationEpoch++;
        const usagePrefix = `${filePath}::`;
        for (const [key, definition] of this.definitionCache) {
            if (
                (!preserveUsageDefinitions && key.startsWith(usagePrefix)) ||
                (preserveUsageDefinitions &&
                    key.startsWith(usagePrefix) &&
                    definition === undefined) ||
                definition?.filePath === filePath
            ) {
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
        tagName?: string,
        resolutionKey?: string,
        isCurrent: () => boolean = () => true
    ): Promise<ComponentPartInfo> {
        return this.getPart(
            shadowPath,
            generatedOffset,
            'props',
            undefined,
            tagName,
            resolutionKey,
            isCurrent
        );
    }

    async getEvents(
        shadowPath: string,
        generatedOffset: number,
        tagName?: string,
        isCurrent: () => boolean = () => true
    ): Promise<ComponentPartInfo> {
        return this.getPart(
            shadowPath,
            generatedOffset,
            'events',
            undefined,
            tagName,
            undefined,
            isCurrent
        );
    }

    async getSlotLets(
        shadowPath: string,
        generatedOffset: number,
        slot = 'default',
        isCurrent: () => boolean = () => true
    ): Promise<ComponentPartInfo> {
        return this.getPart(
            shadowPath,
            generatedOffset,
            'slots',
            slot,
            undefined,
            undefined,
            isCurrent
        );
    }

    private async getPart(
        shadowPath: string,
        generatedOffset: number,
        part: 'props' | 'events' | 'slots',
        slot?: string,
        tagName?: string,
        resolutionKey?: string,
        isCurrent: () => boolean = () => true
    ): Promise<ComponentPartInfo> {
        try {
            if (!isCurrent()) {
                return [];
            }
            // Resolve the declaration first: it is both the anchor for the type walk and the
            // cache key. Memoised per (usage file, tag name) so a keystroke inside the tag
            // costs no LSP round trip at all once the component is known.
            // A component-valued identifier can be shadowed in separate template scopes. The
            // visible tag name is therefore not enough to identify its declaration: two
            // `<Button>` occurrences in one file may legitimately resolve to different symbols.
            // Include the generated usage position so each lexical occurrence retains its own
            // definition while repeated requests at that occurrence still share the lookup.
            const definitionKey = resolutionKey
                ? `${shadowPath}::${resolutionKey}`
                : tagName
                  ? `${shadowPath}::${tagName}::${generatedOffset}`
                  : undefined;
            const epoch = this.invalidationEpoch;
            const hasCachedDefinition = !!definitionKey && this.definitionCache.has(definitionKey);
            const cachedDefinition = hasCachedDefinition
                ? this.definitionCache.get(definitionKey!)
                : undefined;
            const cachedParts = this.getCachedPart(cachedDefinition, part, slot);
            if (cachedParts) {
                return cachedParts.parts;
            }

            // Starting the definition request and checker project acquisition together removes
            // an entire transport round trip from cold component completion. The two results only
            // meet inside the leased project callback, immediately before the type walk.
            const definitionLookupKey = `${epoch}:${definitionKey ?? `${shadowPath}::${generatedOffset}`}`;
            const definitionPromise = hasCachedDefinition
                ? Promise.resolve<DefinitionLookup>({
                      ok: true,
                      definition: cachedDefinition
                  })
                : this.definitionSingleFlight(definitionLookupKey, shadowPath, generatedOffset);
            // Definition identity survives attribute-only edits, but a generated offset is tied
            // to one concrete shadow text. Never make an overtaken request's checker position
            // authoritative for a newer buffer merely because both refer to the same component.
            const partLookupKey = `${definitionLookupKey}:${generatedOffset}:${part}:${slot ?? ''}`;
            const lookup = this.partSingleFlight(
                partLookupKey,
                shadowPath,
                generatedOffset,
                part,
                slot,
                definitionPromise,
                epoch,
                isCurrent
            );
            let result: PartLookup | undefined;
            try {
                result = await lookup.promise;
            } finally {
                lookup.waiters.delete(isCurrent);
            }
            if (!result || !isCurrent() || epoch !== this.invalidationEpoch) {
                return [];
            }

            if (definitionKey) {
                this.setBounded(this.definitionCache, definitionKey, result.definition);
            }
            if (result.cacheable && result.definition && result.token) {
                // An open declaration may have changed while its checker calls were in flight.
                // Only publish an answer against the exact declaration version we enumerated.
                if (result.token !== this.cacheToken(result.definition.filePath)) {
                    return [];
                }
                this.setBounded(this.cache, this.partCacheKey(result.definition, part, slot), {
                    token: result.token,
                    parts: result.parts
                });
            }
            return result.parts;
        } catch (e) {
            Logger.debug('[tsgo] component info lookup failed', e);
            return [];
        }
    }

    private definitionSingleFlight(
        key: string,
        shadowPath: string,
        generatedOffset: number
    ): Promise<DefinitionLookup> {
        const existing = this.definitionLookups.get(key);
        if (existing) {
            return existing;
        }
        const lookup = Promise.resolve()
            .then(() => this.definitionAt(shadowPath, generatedOffset))
            .then<DefinitionLookup>((definition) => ({ ok: true, definition }))
            .catch<DefinitionLookup>((error) => {
                Logger.debug('[tsgo] component definition lookup failed', error);
                return { ok: false };
            });
        const tracked = lookup.finally(() => {
            if (this.definitionLookups.get(key) === tracked) {
                this.definitionLookups.delete(key);
            }
        });
        this.definitionLookups.set(key, tracked);
        return tracked;
    }

    private partSingleFlight(
        key: string,
        shadowPath: string,
        generatedOffset: number,
        part: 'props' | 'events' | 'slots',
        slot: string | undefined,
        definitionPromise: Promise<DefinitionLookup>,
        epoch: number,
        isCurrent: () => boolean
    ): InFlightPartLookup {
        const existing = this.partLookups.get(key);
        if (existing) {
            existing.waiters.add(isCurrent);
            return existing;
        }
        const lookup: InFlightPartLookup = {
            promise: Promise.resolve(undefined),
            waiters: new Set([isCurrent])
        };
        const anyCurrent = () =>
            epoch === this.invalidationEpoch && [...lookup.waiters].some((current) => current());
        const operation = this.session.withProjectForFile(
            shadowPath,
            async (project): Promise<PartLookup | undefined> => {
                const resolvedDefinition = await definitionPromise;
                if (!resolvedDefinition.ok || !anyCurrent()) {
                    return undefined;
                }
                const definition = resolvedDefinition.definition;
                // Capture before touching the checker. If an open declaration changes during
                // the walk, the caller's post-walk token comparison rejects this old snapshot.
                const token = definition ? this.cacheToken(definition.filePath) : undefined;

                // Connecting is what populates signatureKind, so inspect it only inside the
                // leased project callback. Every checker round trip below must retain that lease:
                // refreshing/disposal midway invalidates Project handles.
                const kinds = this.session.signatureKind;
                if (!kinds) {
                    return { definition, cacheable: false, parts: [] };
                }
                const checker = project.checker;
                const type = await this.componentTypeAt(
                    checker,
                    shadowPath,
                    generatedOffset,
                    definition
                );
                if (!type) {
                    return { definition, cacheable: false, parts: [] };
                }

                const carrier = await this.resolveCarrier(checker, kinds, type, part);
                if (!carrier) {
                    return { definition, cacheable: false, parts: [] };
                }

                let parts: ComponentPartInfo;
                if (part === 'slots') {
                    const slotSymbol = await checker.getPropertyOfType(carrier, slot ?? 'default');
                    if (!slotSymbol) {
                        return { definition, cacheable: false, parts: [] };
                    }
                    const slotType = await checker.getTypeOfSymbol(slotSymbol);
                    if (!slotType) {
                        return { definition, cacheable: false, parts: [] };
                    }
                    parts = await this.describe(checker, slotType);
                } else {
                    parts = await this.describe(checker, carrier);
                }

                return {
                    definition,
                    cacheable: true,
                    parts,
                    ...(token ? { token } : {})
                };
            },
            anyCurrent
        );
        const tracked = operation.finally(() => {
            if (this.partLookups.get(key) === lookup) {
                this.partLookups.delete(key);
            }
        });
        lookup.promise = tracked;
        this.partLookups.set(key, lookup);
        return lookup;
    }

    private getCachedPart(
        definition: ComponentDefinition,
        part: 'props' | 'events' | 'slots',
        slot: string | undefined
    ): { parts: ComponentPartInfo } | undefined {
        if (!definition) {
            return undefined;
        }
        const cached = this.cache.get(this.partCacheKey(definition, part, slot));
        return cached?.token === this.cacheToken(definition.filePath) ? cached : undefined;
    }

    private partCacheKey(
        definition: Exclude<ComponentDefinition, undefined>,
        part: 'props' | 'events' | 'slots',
        slot: string | undefined
    ): string {
        return `${definition.filePath}:${definition.offset}:${part}:${slot ?? ''}`;
    }

    private setBounded<K, V>(map: Map<K, V>, key: K, value: V) {
        if (map.size >= 200 && !map.has(key)) {
            map.delete(map.keys().next().value!);
        }
        map.set(key, value);
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
