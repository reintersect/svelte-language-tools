import { basename, dirname, join, normalize, resolve } from 'path';
import ts from 'typescript';

const MAX_SESSIONS = 32;

/**
 * The minimum project context needed to ask TypeScript for a member list.
 *
 * This is deliberately not a second project service. It owns one synthetic root per open Svelte
 * file and lets TypeScript follow only the imports referenced by the receiver's declaration. A
 * full generated Svelte file is a bad cold-completion root: constructing its program eagerly
 * resolves every import in the component, which took about two seconds for Reintersect's
 * Composer. The declaration slice for `selectedTeam.current` follows only `runed` and took about
 * 60ms in the same fresh-process measurement.
 */
export interface IsolatedMemberCompletionInput {
    /** Original `.svelte` path. The synthetic root stays beside it so relative imports resolve. */
    filePath: string;
    /** Current svelte2tsx output. */
    generatedText: string;
    /** UTF-16 offset in {@link generatedText}. */
    generatedOffset: number;
    /** Changes whenever the current source buffer changes. */
    version: number;
    /** Compiler options read without enumerating the project's include roots. */
    compilerOptions: ts.CompilerOptions;
}

export interface IsolatedMemberCompletionResult {
    entries: readonly ts.CompletionEntry[];
    isIncomplete: boolean;
    /** Text already present after the member-access dot. */
    prefix: string;
    timings: {
        sliceMs: number;
        checkerMs: number;
    };
}

export interface IsolatedCompilerOptionsResult {
    configPath: string | undefined;
    options: ts.CompilerOptions;
    errors: readonly ts.Diagnostic[];
}

interface CompletionSlice {
    text: string;
    offset: number;
    prefix: string;
}

interface Session {
    readonly virtualPath: string;
    service: ts.LanguageService;
    text: string;
    version: number;
    projectVersion: number;
    compilerOptions: ts.CompilerOptions;
    compilerOptionsIdentity: string;
}

export interface IsolatedMemberCompletionOptions {
    system?: ts.System;
    /** Shared registry keeps dependency ASTs reusable without retaining full project programs. */
    documentRegistry?: ts.DocumentRegistry;
}

/**
 * A bounded, current-file member completion service for the period before tsgo is ready.
 *
 * It intentionally handles only property access. Global/auto-import completion needs the real
 * project graph and its resolve payload, and pretending otherwise would make a fast but incomplete
 * dropdown look authoritative. Returning undefined lets the caller defer to tsgo/classic there.
 */
export class IsolatedMemberCompletionProvider {
    private readonly system: ts.System;
    private readonly documentRegistry: ts.DocumentRegistry;
    private readonly sessions = new Map<string, Session>();

    constructor(options: IsolatedMemberCompletionOptions = {}) {
        this.system = options.system ?? ts.sys;
        this.documentRegistry =
            options.documentRegistry ??
            ts.createDocumentRegistry(this.system.useCaseSensitiveFileNames, process.cwd());
    }

    getCompletions(
        input: IsolatedMemberCompletionInput
    ): IsolatedMemberCompletionResult | undefined {
        const sliceStarted = performance.now();
        const slice = createMemberCompletionSlice(
            input.generatedText,
            input.generatedOffset,
            input.filePath
        );
        if (!slice) {
            return undefined;
        }
        const sliceMs = performance.now() - sliceStarted;
        const session = this.sessionFor(input, slice.text);
        const checkerStarted = performance.now();
        const completion = session.service.getCompletionsAtPosition(
            session.virtualPath,
            slice.offset,
            {
                includeCompletionsForModuleExports: false,
                includeCompletionsForImportStatements: false,
                includeCompletionsWithInsertText: true,
                includeCompletionsWithSnippetText: true,
                includeAutomaticOptionalChainCompletions: true
            }
        );
        const checkerMs = performance.now() - checkerStarted;
        if (!completion?.entries.length) {
            return undefined;
        }
        return {
            entries: completion.entries,
            // The declaration slice intentionally omits some value dependencies to keep this
            // cold path bounded. TypeScript can therefore produce useful members without proving
            // that the list is exhaustive (for example, an object spread whose base declaration
            // was omitted). Always request a follow-up; once the native project is ready it owns
            // the authoritative list.
            isIncomplete: true,
            prefix: slice.prefix,
            timings: { sliceMs, checkerMs }
        };
    }

    invalidate(filePath?: string): void {
        if (filePath) {
            this.disposeSession(normalize(filePath));
            return;
        }
        this.dispose();
    }

    dispose(): void {
        for (const session of this.sessions.values()) {
            session.service.dispose();
        }
        this.sessions.clear();
    }

    private sessionFor(input: IsolatedMemberCompletionInput, text: string): Session {
        const key = normalize(input.filePath);
        const compilerOptions = isolatedCompilerOptions(input.compilerOptions);
        const compilerOptionsIdentity = stableCompilerOptionsIdentity(compilerOptions);
        let session = this.sessions.get(key);
        if (session && session.compilerOptionsIdentity !== compilerOptionsIdentity) {
            this.disposeSession(key);
            session = undefined;
        }
        if (!session) {
            session = this.createSession(input.filePath, compilerOptions, compilerOptionsIdentity);
            this.setBounded(key, session);
        }
        if (session.text !== text || session.version !== input.version) {
            session.text = text;
            session.version = input.version;
            session.projectVersion++;
        }
        return session;
    }

    private createSession(
        sourcePath: string,
        compilerOptions: ts.CompilerOptions,
        compilerOptionsIdentity: string
    ): Session {
        // A real-looking TypeScript filename is important for Node/package and relative import
        // resolution, but it is never written to disk.
        const virtualPath = join(
            dirname(sourcePath),
            `.__svelte_isolated_${basename(sourcePath).replace(/[^A-Za-z0-9_.-]/g, '_')}.ts`
        );
        const session: Session = {
            virtualPath,
            service: undefined as unknown as ts.LanguageService,
            text: '',
            version: -1,
            projectVersion: 0,
            compilerOptions,
            compilerOptionsIdentity
        };
        const system = this.system;
        const host: ts.LanguageServiceHost = {
            getCompilationSettings: () => session.compilerOptions,
            getScriptFileNames: () => [virtualPath],
            getScriptVersion: (fileName) =>
                fileName === virtualPath ? String(session.version) : 'disk',
            getScriptSnapshot: (fileName) => {
                if (fileName === virtualPath) {
                    return ts.ScriptSnapshot.fromString(session.text);
                }
                const text = system.readFile(fileName);
                return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getProjectVersion: () => String(session.projectVersion),
            getCurrentDirectory: () => dirname(sourcePath),
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: (fileName) => fileName === virtualPath || system.fileExists(fileName),
            readFile: (fileName) =>
                fileName === virtualPath ? session.text : system.readFile(fileName),
            readDirectory: system.readDirectory,
            directoryExists: system.directoryExists,
            getDirectories: system.getDirectories,
            realpath: system.realpath,
            useCaseSensitiveFileNames: () => system.useCaseSensitiveFileNames,
            getNewLine: () => system.newLine
        };
        session.service = ts.createLanguageService(host, this.documentRegistry);
        return session;
    }

    private disposeSession(key: string): void {
        const session = this.sessions.get(key);
        if (!session) {
            return;
        }
        this.sessions.delete(key);
        session.service.dispose();
    }

    private setBounded(key: string, session: Session): void {
        if (this.sessions.size >= MAX_SESSIONS && !this.sessions.has(key)) {
            const oldest = this.sessions.keys().next().value;
            if (oldest !== undefined) {
                this.disposeSession(oldest);
            }
        }
        this.sessions.set(key, session);
    }
}

/**
 * Read the nearest config's compiler options without paying for its include/exclude expansion.
 * `readDirectory` is deliberately empty: completion slices are the only roots in this service.
 */
export function resolveIsolatedCompilerOptions(
    filePath: string,
    system: ts.System = ts.sys
): IsolatedCompilerOptionsResult {
    const configPath = findNearestConfig(filePath, system);
    if (!configPath) {
        return {
            configPath: undefined,
            options: inferredCompilerOptions(),
            errors: []
        };
    }
    const errors: ts.Diagnostic[] = [];
    const host: ts.ParseConfigFileHost = {
        ...system,
        readDirectory: () => [],
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => errors.push(diagnostic)
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
    return {
        configPath,
        options: parsed?.options ?? inferredCompilerOptions(),
        // TS18003 (no inputs) is the expected consequence of the intentionally empty
        // readDirectory. Every other config diagnostic is still surfaced to the caller.
        errors: [...errors, ...(parsed?.errors ?? [])].filter(
            (diagnostic) => diagnostic.code !== 18003
        )
    };
}

function findNearestConfig(filePath: string, system: ts.System): string | undefined {
    let directory = dirname(resolve(filePath));
    for (;;) {
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const candidate = join(directory, name);
            if (system.fileExists(candidate)) {
                return candidate;
            }
        }
        const parent = dirname(directory);
        if (parent === directory) {
            return undefined;
        }
        directory = parent;
    }
}

function inferredCompilerOptions(): ts.CompilerOptions {
    return {
        allowJs: true,
        allowNonTsExtensions: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2021
    };
}

function isolatedCompilerOptions(options: ts.CompilerOptions): ts.CompilerOptions {
    return {
        ...options,
        allowJs: true,
        allowNonTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        // ES5 covers primitive/array/function members while avoiding the long reference chain of
        // a project's full `lib` set. If a receiver genuinely needs a newer ambient carrier and
        // this fast path returns no useful entries, the caller simply falls through to tsgo.
        lib: options.noLib ? undefined : ['lib.es5.d.ts'],
        types: []
    };
}

function stableCompilerOptionsIdentity(options: ts.CompilerOptions): string {
    return JSON.stringify(
        Object.entries(options)
            .filter(([, value]) => value !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
    );
}

/** @internal Exported for focused regression tests. */
export function createMemberCompletionSlice(
    generatedText: string,
    generatedOffset: number,
    filePath = 'Component.svelte'
): CompletionSlice | undefined {
    if (generatedOffset < 0 || generatedOffset > generatedText.length) {
        return undefined;
    }
    const source = ts.createSourceFile(
        `${filePath}.tsx`,
        generatedText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
    );
    const access = deepestPropertyAccessAt(source, generatedOffset);
    if (!access || !ts.isIdentifier(access.expression)) {
        return undefined;
    }
    const receiver = access.expression.text;
    const prefixLength = Math.max(
        0,
        Math.min(
            access.name.end - access.name.getStart(source),
            generatedOffset - access.name.getStart(source)
        )
    );
    const prefix = access.name.getText(source).slice(0, prefixLength);
    const importByBinding = new Map<string, ts.ImportDeclaration>();
    const declarationByBinding = new Map<string, ts.Statement>();
    for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
            for (const name of importBindingNames(statement)) {
                importByBinding.set(name, statement);
            }
            continue;
        }
        for (const name of statementBindingNames(statement)) {
            declarationByBinding.set(name, statement);
        }
    }

    // Instance-script declarations live inside svelte2tsx's render function rather than among
    // SourceFile.statements. Index every statement-sized declaration as a second tier.
    const nestedDeclarations = new Map<string, ts.Statement>();
    walk(source, (node) => {
        if (!ts.isStatement(node) || node.parent === source) {
            return;
        }
        for (const name of statementBindingNames(node)) {
            nestedDeclarations.set(name, node);
        }
    });

    const initial =
        declarationByBinding.get(receiver) ??
        nestedDeclarations.get(receiver) ??
        importByBinding.get(receiver);
    if (!initial) {
        return undefined;
    }
    const imports = new Set<ts.ImportDeclaration>();
    const declarations = new Set<ts.Statement>();
    const pending: ts.Statement[] = [initial];
    const visitedNames = new Set<string>();
    while (pending.length) {
        const statement = pending.shift()!;
        if (ts.isImportDeclaration(statement)) {
            imports.add(statement);
            continue;
        }
        if (declarations.has(statement)) {
            continue;
        }
        declarations.add(statement);
        for (const name of referencedIdentifiers(statement)) {
            if (visitedNames.has(name)) {
                continue;
            }
            visitedNames.add(name);
            const imported = importByBinding.get(name);
            if (imported) {
                pending.push(imported);
                continue;
            }
            const declared = declarationByBinding.get(name) ?? nestedDeclarations.get(name);
            // Pull type/function/class declarations into the slice, but deliberately leave
            // unrelated value declarations unresolved. For example, the constructor arguments
            // of `new PersistedState<T>(`${auth.id}`, null)` do not affect its explicit result
            // type; following `auth` would drag the entire application graph into a member
            // dropdown. An unresolved value is `any`, while the imported constructor and its
            // type arguments still determine the receiver exactly.
            if (declared && declared !== statement && !ts.isVariableStatement(declared)) {
                pending.push(declared);
            }
        }
    }
    const orderedImports = [...imports].sort((left, right) => left.pos - right.pos);
    const orderedDeclarations = [...declarations].sort((left, right) => left.pos - right.pos);
    const pieces = [
        ...orderedImports.map((node) => node.getText(source)),
        ...orderedDeclarations.map((node) => node.getText(source)),
        `${receiver}.${prefix}`
    ];
    const text = pieces.join('\n');
    return { text, offset: text.length, prefix };
}

function deepestPropertyAccessAt(
    source: ts.SourceFile,
    offset: number
): ts.PropertyAccessExpression | undefined {
    let result: ts.PropertyAccessExpression | undefined;
    walk(source, (node) => {
        if (
            ts.isPropertyAccessExpression(node) &&
            node.expression.getStart(source) <= offset &&
            node.end >= offset &&
            node.name.getStart(source) <= offset
        ) {
            result = node;
        }
    });
    return result;
}

function importBindingNames(node: ts.ImportDeclaration): string[] {
    const result: string[] = [];
    const clause = node.importClause;
    if (!clause) {
        return result;
    }
    if (clause.name) {
        result.push(clause.name.text);
    }
    if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
            result.push(clause.namedBindings.name.text);
        } else {
            result.push(...clause.namedBindings.elements.map((element) => element.name.text));
        }
    }
    return result;
}

function statementBindingNames(statement: ts.Statement): string[] {
    const result = new Set<string>();
    if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
            collectBindingNames(declaration.name, result);
        }
    } else if (
        (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
        statement.name
    ) {
        result.add(statement.name.text);
    }
    return [...result];
}

function collectBindingNames(name: ts.BindingName, result: Set<string>): void {
    if (ts.isIdentifier(name)) {
        result.add(name.text);
        return;
    }
    for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
            collectBindingNames(element.name, result);
        }
    }
}

function referencedIdentifiers(node: ts.Node): Set<string> {
    const result = new Set<string>();
    walk(node, (child) => {
        if (!ts.isIdentifier(child) || isDeclarationName(child) || isPropertyName(child)) {
            return;
        }
        result.add(child.text);
    });
    return result;
}

function isDeclarationName(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (
        ((ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isBindingElement(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isInterfaceDeclaration(parent) ||
            ts.isTypeAliasDeclaration(parent) ||
            ts.isEnumDeclaration(parent)) &&
            parent.name === node) ||
        (ts.isImportClause(parent) && parent.name === node) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent)
    );
}

function isPropertyName(node: ts.Identifier): boolean {
    const parent = node.parent;
    return (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isPropertySignature(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isMethodSignature(parent)) &&
            parent.name === node &&
            !ts.isComputedPropertyName(parent.name))
    );
}

function walk(node: ts.Node, visitor: (node: ts.Node) => void): void {
    visitor(node);
    ts.forEachChild(node, (child) => walk(child, visitor));
}
