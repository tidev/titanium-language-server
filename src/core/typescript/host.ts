import path from 'node:path';
import ts from 'typescript';
import { Project } from '../project.ts';
import { alloyLibraryPath } from './alloy-library.ts';
import type { SourceCache } from '../references.ts';
import { IdentityMapping } from './mapping.ts';
import type { MappedRange, PositionMap } from './mapping.ts';
import type { TypesLocation } from './types.ts';
import type { FactoryCall } from '../definition.ts';

/**
 * The TypeScript language service, hosted over a Titanium project.
 *
 * The engine behind every JavaScript and TypeScript answer, for both project types. Two things
 * make it a host rather than a plain `createLanguageService` call.
 *
 * The **overlay**: the editor's buffer wins over what is on disk. A host that reads snapshots from
 * the file system answers about the saved file, so every result is one keystroke stale — which
 * users read as flakiness rather than as a bug. The buffers come from the same `SourceCache` the
 * rest of the analysis reads through: two overlays that can disagree is a defect that only appears
 * mid-edit, so there is only ever one.
 *
 * And **the project decides the paths**. A classic project resolves `require` against `Resources/`
 * and an Alloy one against `app/lib/`. `project.sourcePath()` answers that, and the host asks
 * rather than assuming.
 *
 * Every answer carries a position in a real file. Results are mapped through a `PositionMap`
 * before they leave, so generated content — the `$` declaration built from a view — can never
 * point an editor at a file that does not exist.
 */

export interface QuickInfo {
	/** The signature, as TypeScript renders it */
	text: string;
	/** The JSDoc, which is most of hover's value */
	documentation: string;
	/** The file the answer is about */
	path: string;
	/** Where in that file, in character offsets */
	range: { start: number; end: number };
}

/** One entry in a completion list. Documentation is resolved separately, per entry a client shows */
export interface Completion {
	name: string;
	/** TypeScript's own kind — `method`, `property`, `function` — which a client maps to its icons */
	kind: string;
	/**
	 * Where it sorts. TypeScript's own priority, which a client breaks ties in by label, except for
	 * a member of preferred generated content, which sorts ahead of everything beside it
	 */
	sortText: string;
	/** Whether its JSDoc says `@deprecated`, which a client can show struck through */
	deprecated: boolean;
}

/** What a preferred member's sort text starts with: TypeScript's priorities all start higher */
const PREFERRED = '0';

/** What the type before the dot says about its members, by name */
interface Receiver {
	/** Declared by preferred generated content, so offered first */
	preferred: ReadonlySet<string>;
	/** Declared away as `never`, so not offered at all */
	removed: ReadonlySet<string>;
}

/** The answer when there is no type before a dot to ask */
const NO_RECEIVER: Receiver = { preferred: new Set(), removed: new Set() };

/**
 * A string literal the cursor is inside, and what it is being written into.
 *
 * The property is what decides whether a literal is a path, a translation key or nothing in
 * particular, and it is absent for every literal that is not being assigned to one — an argument,
 * a bare expression. The range covers the contents and not the quotes, because it is what a client
 * replaces when a completion is accepted.
 */
export interface StringLiteralContext {
	/** The contents so far, which is a prefix while the user is typing */
	text: string;
	/** The property it is being written into, when it is being written into one */
	property: string|undefined;
	/**
	 * Whether the type of what this literal is being written into positively cannot be a string.
	 *
	 * False when there is no type to ask — a plain object literal has no contextual type, and
	 * knowing nothing about a property is not the same as knowing it is wrong. So this only ever
	 * rules a property out, never in.
	 */
	typeExcludesString: boolean;
	/** The span of the contents, in the file asked about */
	range: { start: number; end: number };
	/** The call it is an argument to, when it is one: `Alloy.createController('…')` */
	call?: FactoryCall;
}

/**
 * One member of a Titanium type, as a view or a stylesheet would write it.
 *
 * The kind is TypeScript's own — `property`, `method` — because an XML attribute is a property and
 * `add` is not, and the caller is the one that knows which it wants.
 */
export interface ApiMember {
	name: string;
	kind: string;
	/**
	 * Whether the type marks it `readonly` — something the platform reports rather than accepts,
	 * such as `rect` or `size`. A view or a stylesheet can only write, so neither offers one
	 */
	readonly: boolean;
	/** Its type as TypeScript renders it, which hover shows as the signature */
	type: string;
	documentation: string;
}

/** What a client asks for once a completion is highlighted */
export interface CompletionDetail {
	/** The signature, as TypeScript renders it */
	text: string;
	documentation: string;
}


export interface ProjectServiceOptions {
	project: Project;
	/** Where open buffers come from, shared with the rest of the analysis */
	cache: SourceCache;
	/** The resolved types, or nothing — in which case every answer here is empty */
	types: TypesLocation|undefined;
	/**
	 * Where Alloy's builtins are, `Alloy/builtins` in the Alloy the project compiles with. A
	 * `require('alloy/animation')` reads its types from there; without it, it resolves to nothing
	 */
	alloyBuiltins?: string;
}

/** What the service is asked to compile. Titanium is not a browser, but the types lean on DOM lib types */
const compilerOptions: ts.CompilerOptions = {
	allowJs: true,
	// diagnostics are not this issue's business, and turning them on would put red squiggles
	// through every Titanium project that has never seen a type checker
	checkJs: false,
	noEmit: true,
	target: ts.ScriptTarget.ES2020,
	module: ts.ModuleKind.CommonJS,
	moduleResolution: ts.ModuleResolutionKind.Node10,
	allowNonTsExtensions: true,
	// the types are supplied as a root file, so nothing should be pulled in by scanning
	// node_modules as well — that is how a project ends up with two Titanium namespaces
	types: []
};

/**
 * Where a `require` lands, the way Titanium resolves it.
 *
 * Two things differ from Node. A leading slash means the source root — `Resources/` or `app/lib/` —
 * rather than the file system's, so `require('/lib/http')` is `require('lib/http')`. And
 * `alloy/animation` and its siblings name files Alloy copies in when it compiles, so they are
 * nowhere in the project: when the project has no file of that name itself, it is read from
 * Alloy's own source, and TypeScript types it from the code and its JSDoc like any other module.
 *
 * @param name - What was required
 * @param containingFile - The file requiring it
 * @param settings - The compiler options, whose base URL is the source root
 * @param host - What resolution reads the disk through, with the editor's buffers over it
 * @param alloyBuiltins - Where Alloy's builtins are, when the project is an Alloy one and they were found
 * @returns {ts.ResolvedModuleFull|undefined} The module, or nothing
 */
function resolveRequire (name: string, containingFile: string, settings: ts.CompilerOptions, host: ts.ModuleResolutionHost, alloyBuiltins?: string): ts.ResolvedModuleFull|undefined {
	const fromRoot = name.startsWith('/') ? name.slice(1) : name;

	const resolved = ts.resolveModuleName(fromRoot, containingFile, settings, host).resolvedModule;
	if (resolved) {
		return resolved;
	}

	const builtin = /^alloy\/(.+)$/.exec(fromRoot);
	if (builtin && alloyBuiltins) {
		const file = path.join(alloyBuiltins, `${builtin[1]}.js`);
		if (host.fileExists(file)) {
			return { resolvedFileName: file, extension: ts.Extension.Js, isExternalLibraryImport: false };
		}
	}

	return undefined;
}

/**
 * What to show as an answer's documentation.
 *
 * TypeScript's own reading first. Alloy documents its builtins in JSDuck, which names a method in
 * an `@method` tag and writes the description beneath it, so TypeScript files the description as
 * that tag's text and leaves the documentation empty — the description is taken from there.
 *
 * @param documentation - What TypeScript read as the documentation
 * @param tags - The JSDoc tags it read
 * @returns {string} The documentation
 */
function documentationOf (documentation: ts.SymbolDisplayPart[]|undefined, tags: ts.JSDocTagInfo[]|undefined): string {
	const own = ts.displayPartsToString(documentation);
	if (own) {
		return own;
	}

	const method = tags?.find(tag => tag.name === 'method');
	return method ? ts.displayPartsToString(method.text).split('\n').slice(1).join('\n').trim() : '';
}

/**
 * The language service for one project.
 *
 * Built through `create` rather than `new`, because the initial file set comes off the disk while
 * everything the language service asks of its host is synchronous. That set is a starting point
 * rather than a fixed list: a file the editor opens is added when it is first asked about, so a
 * file created after the scan still answers.
 */
export class ProjectService {

	public readonly project: Project;
	public readonly types: TypesLocation|undefined;

	private cache: SourceCache;
	private service: ts.LanguageService;
	private roots: Set<string>;
	/** Generated content the service should see as a file, with the mapping back to its source */
	private virtual = new Map<string, { text: string; version: number; map: PositionMap; preferred: boolean }>();
	/** What `membersOf` has worked out, for as long as the program it was worked out from lasts */
	private members = new WeakMap<ts.Program, Map<string, readonly ApiMember[]>>();
	private built = false;

	private constructor (options: ProjectServiceOptions, sourcePath: string, roots: Set<string>) {
		this.project = options.project;
		this.cache = options.cache;
		this.types = options.types;
		this.roots = roots;

		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => [ ...this.roots ],

			getScriptVersion: fileName => {
				const file = this.ours(fileName);
				const generated = this.virtual.get(file);
				return generated ? `v${generated.version}` : this.cache.version(file);
			},

			getScriptSnapshot: fileName => {
				const file = this.ours(fileName);
				const generated = this.virtual.get(file);
				if (generated) {
					return ts.ScriptSnapshot.fromString(generated.text);
				}

				// the editor's buffer first, and only then the disk: this is the overlay, and it is
				// the whole reason for a custom host
				const open = this.cache.peek(file);
				if (open !== undefined) {
					return ts.ScriptSnapshot.fromString(open);
				}

				const text = ts.sys.readFile(file);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},

			getCurrentDirectory: () => this.project.filePath,
			getCompilationSettings: () => ({
				...compilerOptions,
				// a bare `require('lib/http')` resolves against Resources for a classic project and
				// app/lib for an Alloy one
				baseUrl: sourcePath
			}),
			getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),

			useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,

			fileExists: fileName => this.virtual.has(this.ours(fileName)) || this.cache.peek(this.ours(fileName)) !== undefined || ts.sys.fileExists(fileName),
			readFile: (fileName, encoding) => this.virtual.get(this.ours(fileName))?.text ?? this.cache.peek(this.ours(fileName)) ?? ts.sys.readFile(fileName, encoding),
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			realpath: ts.sys.realpath,

			resolveModuleNameLiterals: (literals, containingFile, _redirected, settings) => literals.map(literal => ({
				resolvedModule: resolveRequire(literal.text, containingFile, settings, host, options.alloyBuiltins)
			}))
		};

		this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	}

	/**
	 * Builds the language service for a project
	 *
	 * @param options - The project, the shared cache and the resolved types
	 * @returns {Promise<ProjectService>} The service
	 * @memberof ProjectService
	 */
	public static async create (options: ProjectServiceOptions): Promise<ProjectService> {
		const sourcePath = await options.project.sourcePath();
		const roots = new Set(await initialFiles(options.project));

		if (options.types) {
			roots.add(options.types.entry);
		}

		// the Alloy runtime declarations are a library like the Titanium types, loaded rather than
		// generated. Only for an Alloy project: classic has no `Alloy` at all, and declaring one
		// would offer the user a namespace their app does not have
		if (await options.project.type() === 'alloy') {
			roots.add(alloyLibraryPath());
		}

		return new ProjectService(options, sourcePath, roots);
	}

	/**
	 * Whether the program has been built, so the cold parse is not paid on the first keystroke
	 *
	 * @readonly
	 * @type {boolean}
	 * @memberof ProjectService
	 */
	public get warmed (): boolean {
		return this.built;
	}

	/**
	 * Builds the program now rather than on the first request
	 *
	 * @memberof ProjectService
	 */
	public warm (): void {
		// nothing to parse without the types, and building the program anyway would spend the
		// cold parse to learn only that
		if (!this.types) {
			return;
		}
		this.service.getProgram();
		this.built = true;
	}

	/**
	 * Hover at a position, or nothing when there is nothing to say
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {QuickInfo|undefined} What to show
	 * @memberof ProjectService
	 */
	public quickInfoAt (filePath: string, offset: number): QuickInfo|undefined {
		if (!this.canAnswerAbout(filePath)) {
			return;
		}

		const info = this.service.getQuickInfoAtPosition(this.ours(filePath), offset);
		if (!info) {
			return;
		}

		const mapped = this.mappingFor(filePath).range({ start: info.textSpan.start, end: info.textSpan.start + info.textSpan.length });
		if (!mapped) {
			// the answer describes generated scaffolding rather than anything the user wrote,
			// so there is nowhere honest to point
			return;
		}

		return {
			text: ts.displayPartsToString(info.displayParts),
			documentation: documentationOf(info.documentation, info.tags),
			path: mapped.path,
			range: mapped.range
		};
	}

	/**
	 * What could be written at a position
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {Completion[]} The entries, without their documentation
	 * @memberof ProjectService
	 */
	public completionsAt (filePath: string, offset: number): Completion[] {
		if (!this.canAnswerAbout(filePath)) {
			return [];
		}

		const completions = this.service.getCompletionsAtPosition(this.ours(filePath), offset, undefined);
		const { preferred, removed } = completions?.isMemberCompletion ? this.receiverAt(filePath, offset) : NO_RECEIVER;

		// entries carry no position, so nothing here needs mapping — the list is what could be
		// written, not where anything is
		return (completions?.entries ?? [])
			// in a JavaScript file TypeScript adds every identifier in scope as a `warning` entry,
			// its guess at what half-typed text might have meant. They are not members of anything
			// and they swamp the real answer — `win.` offers every local in the file beside the
			// 168 properties a Window has. A classic project is all JavaScript, so this is worst
			// exactly where the type information is thinnest. TypeScript marks them so that a
			// client can drop them, which is what this is
			.filter(entry => entry.kind !== ts.ScriptElementKind.warning)
			// a member the type declares away as `never` cannot be written, and offering it is
			// offering something the types went to the trouble of saying is not there
			.filter(entry => !removed.has(entry.name))
			.map(entry => ({
				name: entry.name,
				kind: entry.kind as string,
				sortText: preferred.has(entry.name) ? PREFERRED + entry.sortText : entry.sortText,
				deprecated: entry.kindModifiers?.split(',').includes(ts.ScriptElementKindModifier.deprecatedModifier) ?? false
			}));
	}

	/**
	 * What the members of the thing before the dot are, beyond what an entry says about itself.
	 *
	 * Asked of the receiver's type rather than of the entries, because an entry carries no symbol
	 * and asking TypeScript for one per entry repeats the whole completion each time. The type is
	 * one question however many members it has.
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {Receiver} The members preferred generated content declares, and those the type removes
	 * @memberof ProjectService
	 */
	private receiverAt (filePath: string, offset: number): Receiver {
		const program = this.service.getProgram();
		const source = program?.getSourceFile(this.ours(filePath));
		const receiver = source ? receiverOf(source, source, offset) : undefined;

		if (!program || !receiver) {
			return NO_RECEIVER;
		}

		const checker = program.getTypeChecker();
		const members = checker.getTypeAtLocation(receiver).getProperties();

		return {
			// a member of an intersection may be declared on both sides, and one of them being the
			// view's is enough: an id named like a controller method is still the view's id
			preferred: new Set(members
				.filter(member => member.declarations?.some(declaration => this.virtual.get(this.ours(declaration.getSourceFile().fileName))?.preferred))
				.map(member => member.getName())),
			removed: new Set(members
				.filter(member => (checker.getTypeOfSymbolAtLocation(member, receiver).flags & ts.TypeFlags.Never) !== 0)
				.map(member => member.getName()))
		};
	}

	/**
	 * The signature and JSDoc for one entry, which a client asks for only when it shows it
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @param name - The entry
	 * @returns {CompletionDetail|undefined} Its detail
	 * @memberof ProjectService
	 */
	public completionDetail (filePath: string, offset: number, name: string): CompletionDetail|undefined {
		if (!this.canAnswerAbout(filePath)) {
			return;
		}

		const details = this.service.getCompletionEntryDetails(this.ours(filePath), offset, name, undefined, undefined, undefined, undefined);
		if (!details) {
			return;
		}

		return {
			text: ts.displayPartsToString(details.displayParts),
			documentation: documentationOf(details.documentation, details.tags)
		};
	}

	/**
	 * The string literal at a position, and the property it is being written into.
	 *
	 * The one question here that a type cannot answer. `@types/titanium` types every image path,
	 * every icon and every asset as `string`, so what a literal means is decided by where it is
	 * written rather than by what it is — and that is a question for the syntax tree.
	 *
	 * Asked of the syntax tree rather than of the characters before the cursor, which is the whole
	 * point: an unterminated quote, a newline inside the call, an assignment rather than an object
	 * literal are all the same question to a parser and all different to a regular expression.
	 *
	 * The range is in the file that was asked about and is not mapped. Only content generated into
	 * the program maps elsewhere, and a string literal in generated content is not something a user
	 * can put a cursor in.
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {StringLiteralContext|undefined} The literal, when the cursor is in one
	 * @memberof ProjectService
	 */
	public stringLiteralAt (filePath: string, offset: number): StringLiteralContext|undefined {
		// one lookup and one guard: canAnswerAbout has already established that the file is in the
		// program, and this repeats it only because the types make every step of it optional
		const program = this.canAnswerAbout(filePath) ? this.service.getProgram() : undefined;
		const source = program?.getSourceFile(this.ours(filePath));

		if (!program || !source) {
			return;
		}

		const literal = literalAt(source, source, offset);
		if (!literal) {
			return;
		}

		// an unterminated literal has no closing quote to leave out, and it is the common case:
		// it is what the buffer holds at the moment a completion is asked for
		const closing = literal.isUnterminated ? 0 : 1;

		return {
			text: literal.text,
			property: propertyOf(literal),
			typeExcludesString: excludesString(program.getTypeChecker(), literal),
			range: { start: literal.getStart(source) + 1, end: literal.getEnd() - closing },
			call: callOf(literal, source, program.getTypeChecker())
		};
	}

	/**
	 * The tags the Titanium API can create.
	 *
	 * A tag is something Alloy can construct, which in the types is a `createX` factory — so the
	 * list is the factories of `Ti.UI` with the `create` taken off. A class with no factory is a
	 * type, not a tag.
	 *
	 * `Ti.UI` alone, and deliberately not the platform namespaces nested inside it. Alloy resolves
	 * a bare tag with `IMPLICIT_NAMESPACES[name] || 'Ti.UI'`, so a tag that is only in `Ti.UI.iOS`
	 * and not in that table compiles to `Ti.UI.<name>` and fails — offering `<Snackbar>` here would
	 * be offering something the compiler rejects. The tags that do reach another namespace are in
	 * Alloy's table, which `core/tags.ts` owns and `alloyTags` answers.
	 *
	 * Asked of the value side of each namespace rather than of its exports, which matters: the
	 * published `@types/titanium` declares the factories as `static` methods on a class merged with
	 * the namespace, and walking `symbol.exports` finds the classes and none of the factories. The
	 * value type answers for both that shape and the plain namespace functions a smaller
	 * declaration might use.
	 *
	 * This is the "which tags exist" question, and `core/tags.ts` answers the different question of
	 * what type a tag resolves to. Neither substitutes for the other — read that file's comment.
	 *
	 * @returns {string[]} The tag names, sorted and distinct
	 * @memberof ProjectService
	 */
	public titaniumTags (): string[] {
		const api = this.api();
		const ui = api && symbolFor(api, 'Titanium.UI');
		if (!api || !ui) {
			return [];
		}

		return [ ...new Set(factoriesOf(api, ui)) ].sort();
	}

	/**
	 * The members of a Titanium type, inherited ones included.
	 *
	 * Answers nothing for a name the project's types do not have. A tag can resolve to a type
	 * `@types/titanium` has never heard of — a native module's proxies are not in it at all — and
	 * that is an empty answer rather than a failure.
	 *
	 * A path reaches through properties to the type one of them holds: `[ 'font' ]` on a Label
	 * answers the members of `Font`, which is what a nested TSS property is written from. A path
	 * through something that is not there, or that holds a primitive, answers nothing.
	 *
	 * Kept until the program changes, and answered from memory until then: checking a stylesheet
	 * asks after the same few types once per element per property, which on a real project is
	 * thousands of times. The list is shared, so it is read only.
	 *
	 * @param typeName - The fully qualified type, such as `Titanium.UI.Label`
	 * @param path - The properties to follow first, outermost first
	 * @returns {readonly ApiMember[]} Its members, sorted by name
	 * @memberof ProjectService
	 */
	public membersOf (typeName: string, path: string[] = []): readonly ApiMember[] {
		const api = this.api();
		if (!api) {
			return [];
		}

		let known = this.members.get(api.program);
		if (!known) {
			known = new Map();
			this.members.set(api.program, known);
		}

		const key = [ typeName, ...path ].join('.');
		let members = known.get(key);
		if (!members) {
			members = this.readMembers(api, typeName, path);
			known.set(key, members);
		}

		return members;
	}

	/**
	 * The members of a Titanium type, read from the checker
	 *
	 * @param api - The checker and the types entry
	 * @param typeName - The fully qualified type
	 * @param path - The properties to follow first, outermost first
	 * @returns {ApiMember[]} Its members, sorted by name
	 * @memberof ProjectService
	 */
	private readMembers (api: TitaniumApi, typeName: string, path: string[]): ApiMember[] {
		let type = declaredTypeOf(api, typeName);
		if (!type) {
			return [];
		}

		const { checker } = api;
		for (const name of path) {
			const property: ts.Symbol|undefined = type.getProperty(name);
			const held: ts.Type|undefined = property && checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, api.source));

			// a string or a number has members of its own, and none of them is anything a
			// stylesheet writes
			if (!held || !(held.flags & ts.TypeFlags.Object)) {
				return [];
			}
			type = held;
		}

		// the published package documents an event on its own interface — `Label_longpress_Event`
		// — and leaves the map's member bare, so an event map reads its members' types for them
		const eventMap = path.length === 0 && typeName.endsWith('EventMap');

		return checker.getPropertiesOfType(type)
			.filter(symbol => !unavailable(api, symbol))
			.map(symbol => {
				const memberType = checker.getTypeOfSymbolAtLocation(symbol, api.source);
				const own = ts.displayPartsToString(symbol.getDocumentationComment(checker));
				const fromType = eventMap && !own ? ts.displayPartsToString(memberType.getSymbol()?.getDocumentationComment(checker)) : '';

				return {
					name: symbol.getName(),
					kind: kindOf(symbol),
					readonly: readonlyMember(symbol),
					type: checker.typeToString(memberType),
					documentation: own || fromType
				};
			})
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * The constants a namespace declares, such as `TEXT_ALIGNMENT_CENTER` on `Titanium.UI`.
	 *
	 * Read from the project's own types so that a constant is only ever offered to a project whose
	 * SDK has it. The package types each one as its value's type rather than as a literal, so this
	 * answers which constants exist, not which values a property takes — that pairing comes from
	 * `core/constants.ts`.
	 *
	 * @param namespace - The fully qualified namespace, such as `Titanium.UI`
	 * @returns {ApiMember[]} Its constants, sorted by name
	 * @memberof ProjectService
	 */
	public constantsOf (namespace: string): ApiMember[] {
		const api = this.api();
		const symbol = api && symbolFor(api, namespace);
		if (!api || !symbol?.exports) {
			return [];
		}

		const { checker } = api;
		const constants: ApiMember[] = [];

		symbol.exports.forEach(exported => {
			// consts and nothing else: the classes, the nested namespaces and the factories share
			// the same exports
			if (!(exported.flags & ts.SymbolFlags.Variable)) {
				return;
			}
			constants.push({
				name: exported.getName(),
				kind: 'const',
				readonly: true,
				type: checker.typeToString(checker.getTypeOfSymbolAtLocation(exported, api.source)),
				documentation: ts.displayPartsToString(exported.getDocumentationComment(checker))
			});
		});

		return constants.sort((left, right) => left.name.localeCompare(right.name));
	}

	/**
	 * What a Titanium type's own documentation says about it.
	 *
	 * The class comment rather than any member's, which is what hover on a tag shows. Empty for a
	 * type the project's types do not have, the same way `membersOf` answers nothing for one.
	 *
	 * @param typeName - The fully qualified type, such as `Titanium.UI.Label`
	 * @returns {string} The documentation, or nothing
	 * @memberof ProjectService
	 */
	public documentationOf (typeName: string): string {
		const api = this.api();
		const symbol = api && symbolFor(api, typeName);
		if (!api || !symbol) {
			return '';
		}

		return ts.displayPartsToString(symbol.getDocumentationComment(api.checker));
	}

	/**
	 * The events a Titanium type emits.
	 *
	 * From the `<Name>EventMap` interface beside the type, which is how the published types carry
	 * them — one per class, and the reason `addEventListener('` already offers names without this
	 * project holding any event data of its own.
	 *
	 * @param typeName - The fully qualified type, such as `Titanium.UI.Label`
	 * @returns {string[]} The event names, sorted
	 * @memberof ProjectService
	 */
	public eventsOf (typeName: string): string[] {
		const api = this.api();
		const type = api && declaredTypeOf(api, `${typeName}EventMap`);
		if (!api || !type) {
			return [];
		}

		return api.checker.getPropertiesOfType(type)
			.filter(symbol => !unavailable(api, symbol))
			.map(symbol => symbol.getName())
			.sort();
	}

	/**
	 * Where what is at a position is declared, mapped back to real files
	 *
	 * @param filePath - The file asked about
	 * @param offset - Where in it
	 * @returns {MappedRange[]} Where to jump to
	 * @memberof ProjectService
	 */
	public definitionsAt (filePath: string, offset: number): MappedRange[] {
		if (!this.canAnswerAbout(filePath)) {
			return [];
		}

		const found = this.service.getDefinitionAtPosition(this.ours(filePath), offset) ?? [];
		const mapped: MappedRange[] = [];

		for (const definition of found) {
			const range = this.mappingFor(definition.fileName).range({
				start: definition.textSpan.start,
				end: definition.textSpan.start + definition.textSpan.length
			});

			// a definition that lands in generated scaffolding rather than in anything the user
			// wrote has nowhere honest to point, so it is dropped rather than guessed at
			if (range) {
				mapped.push(range);
			}
		}

		return mapped;
	}

	/**
	 * Supplies content the service should read as a file, along with the mapping back to what it
	 * was generated from. Called again for the same path, it replaces what was there.
	 *
	 * Preferred content is what is specific to the file being asked about, and its members are
	 * offered ahead of whatever they are completed beside: a view's ids on `$` sort before the
	 * `Alloy.Controller` members every controller has.
	 *
	 * @param filePath - The path the content stands at
	 * @param text - The content
	 * @param map - How its positions map back to source
	 * @param options - Whether its members are preferred
	 * @param options.preferred - Whether they sort ahead of the rest
	 * @memberof ProjectService
	 */
	public setGenerated (filePath: string, text: string, map: PositionMap, { preferred = false } = {}): void {
		// the version has to move or the service serves what it parsed the first time, which
		// is how a regenerated declaration ends up describing the previous version of a view
		const file = this.ours(filePath);
		const version = (this.virtual.get(file)?.version ?? 0) + 1;
		this.virtual.set(file, { text, version, map, preferred });
		this.roots.add(file);
	}

	/**
	 * Drops generated content, so the service stops seeing it
	 *
	 * @param filePath - The path it stood at
	 * @memberof ProjectService
	 */
	public dropGenerated (filePath: string): void {
		this.virtual.delete(this.ours(filePath));
		this.roots.delete(this.ours(filePath));
	}

	/**
	 * Releases the parsed program
	 *
	 * @memberof ProjectService
	 */
	public dispose (): void {
		this.service.dispose();
	}

	/**
	 * The checker and the file to resolve names against, or nothing when there is nothing to ask.
	 *
	 * One accessor and one guard, because everything downstream needs both and each would
	 * otherwise carry a check that cannot fail: a type only comes back if the checker produced it.
	 *
	 * @returns The checker and the types entry, when the project has types at all
	 * @memberof ProjectService
	 */
	private api (): TitaniumApi|undefined {
		const program = this.types ? this.service.getProgram() : undefined;
		const source = program?.getSourceFile(this.types?.entry ?? '');
		const checker = program?.getTypeChecker();

		return program && source && checker ? { program, checker, source } : undefined;
	}

	/**
	 * A file name in the form this class keys its own maps on.
	 *
	 * TypeScript normalises paths its own way and hands them back that way — forward slashes, even
	 * on Windows — while the cache and the generated content are keyed on the path the caller
	 * built with `path.join`. Without this every lookup misses on Windows, and a buffer that only
	 * exists in the overlay is invisible: the file falls through to disk, is not there, and the
	 * service answers nothing.
	 *
	 * @param fileName - A path from anywhere
	 * @returns {string} The same path in the platform's own form
	 * @memberof ProjectService
	 */
	private ours (fileName: string): string {
		return path.normalize(fileName);
	}

	/**
	 * Whether the service can answer about a file at all.
	 *
	 * Asking the program about a file it does not have throws rather than answering nothing, and an
	 * editor showing "request failed" on every keystroke is worse than one showing nothing. A file
	 * the editor opened after the workspace scan is added here rather than being turned away, so a
	 * file created since the scan still answers.
	 *
	 * @param filePath - The file being asked about
	 * @returns {boolean} Whether to go on
	 * @memberof ProjectService
	 */
	private canAnswerAbout (filePath: string): boolean {
		if (!this.types) {
			return false;
		}

		this.roots.add(this.ours(filePath));

		return Boolean(this.service.getProgram()?.getSourceFile(this.ours(filePath)));
	}

	/**
	 * The mapping for a file the service knows about
	 *
	 * @param fileName - The file
	 * @returns {PositionMap} Its mapping, which is the identity for a real file
	 * @memberof ProjectService
	 */
	private mappingFor (fileName: string): PositionMap {
		return this.virtual.get(this.ours(fileName))?.map ?? new IdentityMapping(this.ours(fileName));
	}
}

/**
 * The files the project starts with.
 *
 * Its own sources rather than everything under the root: `node_modules` and `build/` are large,
 * uninteresting, and would be parsed on every warm.
 *
 * @param project - The project to scan
 * @returns {Promise<string[]>} Absolute paths
 */
async function initialFiles (project: Project): Promise<string[]> {
	const [ lib, controllers, models ] = await Promise.all([
		project.libFiles(),
		project.controllers(),
		// a model is a JavaScript file the controller's `Alloy.createModel` answers from
		project.models()
	]);

	const files = [ ...lib, ...controllers, ...models ];

	// alloy.js runs before every controller, so what it puts on Alloy.Globals is in scope for all
	// of them
	if (await project.type() === 'alloy') {
		files.push(path.join(project.filePath, 'app', 'alloy.js'));
	}

	return files;
}

/**
 * The string literal containing an offset, if there is one.
 *
 * Descends through `getChildren` rather than `forEachChild`, because `forEachChild` visits only
 * the named children of a node and never the tokens — and a string literal is a token. Walking
 * with it lands on the end of the file for every literal still being typed, which is every literal
 * a completion is ever asked about.
 *
 * @param node - The node to search
 * @param source - The file, for resolving positions
 * @param offset - The offset to find
 * @returns {ts.StringLiteralLike|undefined} The literal at that offset
 */
function literalAt (node: ts.Node, source: ts.SourceFile, offset: number): ts.StringLiteralLike|undefined {
	for (const child of node.getChildren(source)) {
		if (offset > child.getFullStart() && offset <= child.getEnd()) {
			return ts.isStringLiteralLike(child) ? child : literalAt(child, source, offset);
		}
	}

	return undefined;
}

/**
 * What the cursor is writing a member of, if anything: the `$` in `$.` and `$.la`, in `$.` on a
 * line of its own above another statement, which a parser reads as one access, and in `$['my-id']`,
 * which is the only way to write an id with a dash in it.
 *
 * The innermost access wins, so `$.label.te` is a question about `$.label` and not about `$`.
 *
 * @param node - The node to search
 * @param source - The file, for resolving positions
 * @param offset - The offset to find
 * @returns {ts.Expression|undefined} The expression whose members are being completed
 */
function receiverOf (node: ts.Node, source: ts.SourceFile, offset: number): ts.Expression|undefined {
	const child = node.getChildren(source).find(candidate => offset > candidate.getFullStart() && offset <= candidate.getEnd());
	const inner = child ? receiverOf(child, source, offset) : undefined;
	if (inner) {
		return inner;
	}

	// past the end of what is before the dot is the dot or the name, which is where a member is
	// being completed
	if (ts.isPropertyAccessExpression(node) && offset > node.expression.getEnd()) {
		return node.expression;
	}

	// a key is a member only while it is a string being typed: `$[name]` is an expression, and what
	// it completes is whatever is in scope. The quote is part of the literal and the cursor is past it
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
		&& offset > node.argumentExpression.getStart(source) && offset <= node.argumentExpression.getEnd()) {
		return node.expression;
	}

	return undefined;
}

/**
 * The call a literal is an argument to, with the callee as written and its whitespace taken out,
 * so `Alloy . createController` reads as `Alloy.createController`.
 *
 * The leftmost name is asked of the checker as well as read: a parameter or a local called `Alloy`
 * is the script's own, and its calls name nothing of Alloy's. A name declared only in a declaration
 * file, or nowhere — `Widget`, which Alloy supplies to a widget's scripts and nothing declares — is
 * the runtime's.
 *
 * @param literal - The literal
 * @param source - The file, for reading the callee's text
 * @param checker - What tells the runtime's name from one the script declares
 * @returns {FactoryCall|undefined} The call, when the literal is one of its arguments
 */
function callOf (literal: ts.StringLiteralLike, source: ts.SourceFile, checker: ts.TypeChecker): FactoryCall|undefined {
	const call = literal.parent;
	if (!ts.isCallExpression(call) || !call.arguments.includes(literal as ts.Expression)) {
		return undefined;
	}

	let root: ts.Expression = call.expression;
	while (ts.isPropertyAccessExpression(root)) {
		root = root.expression;
	}
	const declarations = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root)?.declarations ?? [] : [];
	if (declarations.some(declaration => !declaration.getSourceFile().isDeclarationFile)) {
		return undefined;
	}

	return {
		callee: call.expression.getText(source).replace(/\s+/g, ''),
		index: call.arguments.indexOf(literal as ts.Expression),
		args: call.arguments.map(argument => ts.isStringLiteralLike(argument) ? argument.text : undefined)
	};
}

/**
 * The property a literal is being written into.
 *
 * Both forms count, because both are written: `createImageView({ image: '…' })` builds the object
 * up front and `view.image = '…'` sets it afterwards, and a user doing the second would be told
 * nothing by an implementation that only understood the first.
 *
 * @param literal - The literal
 * @returns {string|undefined} The property name, when there is one
 */
function propertyOf (literal: ts.StringLiteralLike): string|undefined {
	const parent = literal.parent;

	if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
		return parent.name.text;
	}

	if (ts.isBinaryExpression(parent)
		&& parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
		&& ts.isPropertyAccessExpression(parent.left)) {
		return parent.left.name.text;
	}

	return undefined;
}

/**
 * Whether the type a literal is being written into positively cannot hold a string.
 *
 * The contextual type is what the surrounding code expects there — the declared type of the
 * property in an object literal, or of the property being assigned to. Answering from it is what
 * separates `image` from the `preventDefaultImage` beside it without a list of either.
 *
 * Deliberately conservative in three ways, because the cost is not symmetric: a false "excludes"
 * silently withholds a completion the user wanted, while a false "admits" only offers one they can
 * ignore. No contextual type at all is not an exclusion; `any` and `unknown` are not exclusions;
 * and a union is an exclusion only when no part of it admits a string.
 *
 * @param checker - The program's type checker
 * @param literal - The literal to ask about
 * @returns {boolean} Whether a string is definitely not what belongs there
 */
function excludesString (checker: ts.TypeChecker, literal: ts.StringLiteralLike): boolean {
	const contextual = checker.getContextualType(literal);
	if (!contextual) {
		return false;
	}

	const admitting = ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.TemplateLiteral
		| ts.TypeFlags.StringMapping | ts.TypeFlags.Any | ts.TypeFlags.Unknown
		| ts.TypeFlags.TypeParameter;

	const parts = contextual.isUnion() ? contextual.types : [ contextual ];

	return !parts.some(part => (part.flags & admitting) !== 0);
}

/** The checker and the file qualified names are resolved against */
interface TitaniumApi {
	program: ts.Program;
	checker: ts.TypeChecker;
	source: ts.SourceFile;
}

/**
 * The symbol a dotted name resolves to, such as `Titanium.UI`.
 *
 * Walks the exports rather than asking the checker to resolve a string: there is no public API
 * that takes a qualified name, and the export chain is what the declarations actually are.
 *
 * @param api - The checker and the file to resolve against
 * @param dotted - The qualified name
 * @returns {ts.Symbol|undefined} Its symbol, when the types declare it
 */
function symbolFor (api: TitaniumApi, dotted: string): ts.Symbol|undefined {
	const [ root, ...rest ] = dotted.split('.');
	let current = api.checker
		.getSymbolsInScope(api.source, ts.SymbolFlags.Namespace | ts.SymbolFlags.Type | ts.SymbolFlags.Variable)
		.find(symbol => symbol.getName() === root);

	for (const part of rest) {
		current = current?.exports?.get(part as ts.__String);
	}

	return current;
}

/**
 * The declared type behind a qualified name, for asking about its members
 *
 * @param api - The checker and the file to resolve against
 * @param typeName - The qualified name
 * @returns {ts.Type|undefined} Its declared type, when the types have one
 */
function declaredTypeOf (api: TitaniumApi, typeName: string): ts.Type|undefined {
	const symbol = symbolFor(api, typeName);
	return symbol ? api.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
}

/**
 * The tag names a namespace's factories construct
 *
 * @param api - The checker and the file to resolve against
 * @param namespace - The namespace symbol
 * @returns {string[]} The names, with `create` taken off
 */
function factoriesOf (api: TitaniumApi, namespace: ts.Symbol): string[] {
	return api.checker
		.getPropertiesOfType(api.checker.getTypeOfSymbolAtLocation(namespace, api.source))
		.map(member => member.getName())
		.filter(name => /^create[A-Z]/.test(name))
		.map(name => name.slice('create'.length));
}

/**
 * Whether a member is one the type has taken away.
 *
 * `@types/titanium` removes an inherited member by redeclaring it as `never` — `Titanium.UI.Label`
 * does exactly that to `View.add`, because a label has no children — and it does so 765 times
 * across the package. Without this every one of them would be offered as an attribute of the type
 * that went to the trouble of saying it does not have it.
 *
 * @param api - The checker and the file to resolve against
 * @param symbol - The member
 * @returns {boolean} Whether the type declares it away
 */
function unavailable (api: TitaniumApi, symbol: ts.Symbol): boolean {
	return (api.checker.getTypeOfSymbolAtLocation(symbol, api.source).flags & ts.TypeFlags.Never) !== 0;
}

/**
 * Whether a member is declared `readonly`.
 *
 * Read from the declaration the type resolved to, which is the most derived one — so a subclass
 * that narrows an inherited member is answered for as the subclass declares it.
 *
 * @param symbol - The member
 * @returns {boolean} Whether it can only be read
 */
function readonlyMember (symbol: ts.Symbol): boolean {
	return (symbol.declarations ?? []).some(declaration => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0);
}

/**
 * What kind of member a symbol is, in TypeScript's own vocabulary.
 *
 * Only the distinction a caller acts on: an XML attribute and a stylesheet key are properties,
 * and `add` and `addEventListener` are not either of those.
 *
 * @param symbol - The member
 * @returns {string} `method` or `property`
 */
function kindOf (symbol: ts.Symbol): string {
	return symbol.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Function) ? 'method' : 'property';
}
