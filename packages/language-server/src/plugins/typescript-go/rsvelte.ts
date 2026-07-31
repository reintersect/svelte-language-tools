import { decode, encode } from '@jridgewell/sourcemap-codec';
import { Logger } from '../../logger';

/**
 * `import()` that survives TypeScript's CJS emit — same trick as the tsgo API session:
 * the compiler rewrites a bare `await import()` into `require()`, which cannot load an
 * ESM-only package.
 */
const importESM: (specifier: string) => Promise<any> = new Function(
    'specifier',
    'return import(specifier)'
) as any;

export interface RsvelteModule {
    /** The Rust transform: `svelte2tsx(source, { filename, isTsFile, mode, version })`. */
    svelte2tsx: (
        source: string,
        options: {
            filename?: string;
            isTsFile?: boolean;
            mode?: 'ts' | 'dts';
            version?: '4' | '5';
            accessors?: boolean;
            namespace?: string;
        }
    ) => { code: string; map: any; exportedNames: { has(name: string): boolean } };
    /**
     * Identity of the transform's *behavior*, mixed into the shadow fingerprint. Derived from
     * the transform's own output on a probe input rather than a package version: shadows on
     * disk must be invalidated exactly when the generated code would differ, and the two
     * engines (and any two rsvelte builds) differ in whitespace alone.
     */
    fingerprint: string;
}

let state: RsvelteModule | undefined;
let loading: Promise<RsvelteModule | undefined> | undefined;

/**
 * Repair rsvelte 0.2.x source maps in place.
 *
 * The Rust emitter writes one segment per *copied character* with the original column advancing
 * correctly — but never advances the generated column, so every segment in a line sits at
 * generated column 0 and any position query collapses to the line's last segment (verified
 * against the raw VLQ: every segment is `AAAC`). Because every mapped character is copied
 * verbatim, the intended columns are recoverable: group segments into runs of consecutively
 * copied original text and align each run's text against the generated line, left to right.
 * A run whose text cannot be found leaves its zeros untouched rather than guessing.
 *
 * Validated empirically (see the corpus harness in the session that introduced this): repaired
 * maps round-trip script and template-expression characters exactly, matching the JS transform.
 */
export function repairRsvelteMap(
    originalText: string,
    generatedText: string,
    map: { mappings: string }
): void {
    const decoded = decode(map.mappings);
    const originalLines = originalText.split('\n');
    const generatedLines = generatedText.split('\n');

    for (let lineIndex = 0; lineIndex < decoded.length; lineIndex++) {
        const segments = decoded[lineIndex];
        // Only the degenerate pattern is touched: every segment claiming column 0.
        if (!segments.length || segments.some((segment) => segment[0] !== 0)) {
            continue;
        }
        if (segments.length === 1) {
            // A lone line-anchor. Column 0 is legitimate when the original anchor is a line
            // start too (the JS transform emits the same structural segments); an anchor into
            // the middle of an original line at generated column 0 is the encoder bug again —
            // keep it only when the characters actually agree.
            const [, , origLine, origCol] = segments[0];
            if (
                (origCol ?? 0) !== 0 &&
                (generatedLines[lineIndex] ?? '')[0] !==
                    (originalLines[origLine ?? 0] ?? '')[origCol ?? 0]
            ) {
                decoded[lineIndex] = [];
            }
            continue;
        }
        const generatedLine = generatedLines[lineIndex] ?? '';
        // Repaired column per segment index; -1 marks "not anchored yet".
        const placed = new Array<number>(segments.length).fill(-1);
        let searchFrom = 0;
        let runStart = 0;

        // Segments arrive in emission (= generated) order, so a monotonic cursor is sound.
        // A run is contiguous in *original* space but may be fragmented in the generated line
        // (an element's tag, attribute names and values land in separate holes of the
        // createElement scaffolding), so alignment anchors on the run's word tokens — the
        // characters editor positions actually target — with an identifier-boundary check so
        // `Sticker` cannot land inside `$$_rekcitS1C`. Each anchored token then extends over
        // exactly-matching neighbour characters.
        const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
        const alignRun = (from: number, to: number) => {
            const first = segments[from];
            const origLine = originalLines[first[2] ?? 0] ?? '';
            const startCol = first[3] ?? 0;
            const runText = origLine.slice(startCol, startCol + (to - from));
            if (!runText) {
                return;
            }

            // Fast path: the whole run appears verbatim (script chunks, expressions).
            const whole = generatedLine.indexOf(runText, searchFrom);
            if (whole >= 0) {
                for (let i = from; i < to; i++) {
                    placed[i] = whole + (i - from);
                }
                searchFrom = whole + runText.length;
                return;
            }

            // Fragmented: anchor word tokens one by one.
            for (const token of runText.matchAll(/[A-Za-z0-9_$]+/g)) {
                let at = generatedLine.indexOf(token[0], searchFrom);
                while (
                    at >= 0 &&
                    (isWordChar(generatedLine[at - 1]) ||
                        isWordChar(generatedLine[at + token[0].length]))
                ) {
                    at = generatedLine.indexOf(token[0], at + 1);
                }
                if (at < 0) {
                    continue;
                }
                for (let k = 0; k < token[0].length; k++) {
                    placed[from + token.index + k] = at + k;
                }
                // Extend over identical neighbours (quotes, dots, operators copied verbatim).
                for (
                    let left = token.index - 1, genLeft = at - 1;
                    left >= 0 &&
                    placed[from + left] < 0 &&
                    generatedLine[genLeft] === runText[left];
                    left--, genLeft--
                ) {
                    placed[from + left] = genLeft;
                }
                for (
                    let right = token.index + token[0].length, genRight = at + token[0].length;
                    right < runText.length &&
                    placed[from + right] < 0 &&
                    generatedLine[genRight] === runText[right];
                    right++, genRight++
                ) {
                    placed[from + right] = genRight;
                }
                searchFrom = at + token[0].length;
            }
        };

        for (let i = 1; i <= segments.length; i++) {
            const prev = segments[i - 1];
            const curr = segments[i];
            const continues =
                curr !== undefined &&
                curr[1] === prev[1] &&
                curr[2] === prev[2] &&
                (curr[3] ?? 0) === (prev[3] ?? 0) + 1;
            if (continues) {
                continue;
            }
            alignRun(runStart, i);
            runStart = i;
        }

        // Park what could not be anchored (rewritten syntax — tag punctuation, directives) at
        // the nearest anchored neighbour, so those original positions stay *line-correct*
        // instead of vanishing: the component-props path, for one, resolves the tag from the
        // mapped position of the `<` before the tag name. A line with no anchors at all is
        // dropped rather than guessed at.
        if (placed.every((col) => col < 0)) {
            decoded[lineIndex] = [];
            continue;
        }
        for (let i = 0; i < placed.length; i++) {
            if (placed[i] >= 0) {
                continue;
            }
            let left = i - 1;
            while (left >= 0 && placed[left] < 0) {
                left--;
            }
            let right = i + 1;
            while (right < placed.length && placed[right] < 0) {
                right++;
            }
            placed[i] = left >= 0 ? placed[left] : placed[right];
        }

        const kept: typeof segments = segments.map((segment, i) => {
            const copy = segment.slice() as (typeof segments)[number];
            copy[0] = placed[i];
            return copy;
        });
        kept.sort((a, b) => a[0] - b[0]);
        decoded[lineIndex] = kept;
    }

    map.mappings = encode(decoded);
}

/**
 * Whether the Rust transform is opted into. **Off by default**: the repaired maps are exact
 * for script content but still lose template-level positions — a diagnostic on an unimported
 * `<Component>` maps to nothing and silently disappears. Until the upstream generated-column
 * bug is fixed (at which point the maps need no repair at all), rsvelte is an experiment you
 * turn on, not a default you trust.
 */
export function isRsvelteEnabled(initializationOptions?: any): boolean {
    const fromClient =
        initializationOptions?.configuration?.svelte?.['language-server']?.rsvelte ??
        initializationOptions?.config?.['language-server']?.rsvelte;
    if (typeof fromClient === 'boolean') {
        return fromClient;
    }
    const value = process.env.SVELTE_LS_RSVELTE;
    return value === '1' || value === 'true';
}

/**
 * Load the Rust svelte2tsx if it is installed and opted into. Await this once at startup
 * (initialize / batch-overlay creation); after that {@link getRsvelte} is synchronous, which
 * matters because the transform itself runs inside synchronous snapshot code.
 */
export function preloadRsvelte(enabled: boolean): Promise<RsvelteModule | undefined> {
    if (!enabled) {
        return Promise.resolve(undefined);
    }
    loading ??= (async () => {
        try {
            const mod = await importESM('@rsvelte/svelte2tsx');
            const transform: RsvelteModule['svelte2tsx'] = (source, options) => {
                const result = mod.svelte2tsx(source, options);
                if (result?.map?.mappings) {
                    repairRsvelteMap(source, result.code, result.map);
                }
                return result;
            };
            const probe = transform('<script lang="ts">let a: number = 1;</script><p>{a}</p>', {
                filename: 'probe.svelte',
                isTsFile: true,
                mode: 'ts',
                version: '5'
            });
            if (typeof probe?.code !== 'string' || !probe?.map?.mappings) {
                throw new Error('probe transform returned an unexpected shape');
            }
            state = {
                svelte2tsx: transform,
                fingerprint: `rsvelte:${fnv1a(probe.code + '|' + probe.map.mappings)}`
            };
            Logger.log('[tsgo] rsvelte transform loaded');
            return state;
        } catch (e) {
            Logger.log(`[tsgo] rsvelte not available, using the JS transform (${e})`);
            return undefined;
        }
    })();
    return loading;
}

/** The loaded Rust transform, or undefined when unavailable or not yet preloaded. */
export function getRsvelte(): RsvelteModule | undefined {
    return state;
}

function fnv1a(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}
