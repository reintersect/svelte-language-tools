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
    constructor(
        private readonly session: TsGoApiSession,
        /** Resolves a generated position to the declaration it points at, via LSP. */
        private readonly definitionAt: (
            shadowPath: string,
            offset: number
        ) => Promise<{ filePath: string; offset: number } | undefined>
    ) {}

    async getProps(shadowPath: string, generatedOffset: number): Promise<ComponentPartInfo> {
        return this.getPart(shadowPath, generatedOffset, 'props');
    }

    async getEvents(shadowPath: string, generatedOffset: number): Promise<ComponentPartInfo> {
        return this.getPart(shadowPath, generatedOffset, 'events');
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
        slot?: string
    ): Promise<ComponentPartInfo> {
        const project = await this.session.getProject();
        const kinds = this.session.signatureKind;
        if (!project || !kinds) {
            return [];
        }
        const checker = project.checker;

        try {
            const type = await this.componentTypeAt(checker, shadowPath, generatedOffset);
            if (!type) {
                return [];
            }

            const carrier = await this.resolveCarrier(checker, kinds, type, part);
            if (!carrier) {
                return [];
            }

            if (part === 'slots') {
                const slotSymbol = await checker.getPropertyOfType(carrier, slot ?? 'default');
                if (!slotSymbol) {
                    return [];
                }
                const slotType = await checker.getTypeOfSymbol(slotSymbol);
                return slotType ? this.describe(checker, slotType) : [];
            }

            return this.describe(checker, carrier);
        } catch (e) {
            Logger.debug('[tsgo] component info lookup failed', e);
            return [];
        }
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
        generatedOffset: number
    ): Promise<any | undefined> {
        // Follow go-to-definition first, exactly as the JS engine does. At the usage site the
        // symbol frequently resolves through a barrel re-export to svelte's ambient
        // `declare module '*.svelte'`, whose type is `LegacyComponentType` with a
        // `Record<string, any>` props carrier — useless for completions. The declaration lands
        // on the component's own generated shadow, where the real type lives.
        const definition = await this.definitionAt(shadowPath, generatedOffset);
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
        const out: ComponentPartInfo = [];
        for (const property of properties) {
            if (property.name.startsWith('$$')) {
                continue;
            }
            const propertyType = await checker.getTypeOfSymbol(property);
            out.push({
                name: property.name,
                type: propertyType ? await checker.typeToString(propertyType) : 'any',
                doc: await checker.getDocumentationCommentOfSymbol(property)
            });
        }
        return out;
    }
}
