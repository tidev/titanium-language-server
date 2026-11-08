import { quoteOf } from './actions.ts';
import { imagePathsFor, isImageProperty } from './assets.ts';
import { styledElements, styles } from './cascade.ts';
import { readAlloyConfig } from './config.ts';
import { constantsFor, literalValuesFor } from './constants.ts';
import { Project } from './project.ts';
import { ReferenceIndex } from './references.ts';
import type { SourceCache, SourceFile } from './references.ts';
import { viewsStyledBy } from './related.ts';
import { alloyTags, titaniumTypeOf } from './tags.ts';
import { keyIndexAt, nodeAt, parseSelector, parseTss, sourceRange } from './tss.ts';
import type { TssProperty, TssRange, TssRule } from './tss.ts';
import type { ApiMember } from './typescript/host.ts';
import { named, translationsIn } from './view.ts';
import type { ApiSource, ViewCompletion } from './view.ts';
import { parseXml } from './xml.ts';

/**
 * What can be written at a position in an Alloy stylesheet.
 *
 * The same shape as `core/view.ts`, the other half of the triad: the parse says where the cursor
 * is, and this decides what belongs there. Nothing is read from the characters before the cursor
 * except inside an expression the parser hands over whole, which is where `L('` and `Alloy.CFG.`
 * are written.
 *
 * What a rule can set depends on what it styles, and that is the question this answers carefully.
 * A tag names its type outright. A class or an id names elements, so what it can set is what the
 * elements carrying it can set — read from the views the stylesheet applies to, and from nowhere
 * else, because a class of the same name in an unrelated screen styles nothing here. A class
 * nothing carries yet can set nothing, and is offered nothing rather than a guess.
 */

/** What a completion in a stylesheet is worked out from */
export interface StyleCompletionContext {
	/** The project the stylesheet belongs to */
	project: Project;
	/** The stylesheet, as text rather than as a path, so an unsaved buffer answers */
	style: SourceFile;
	/** Where the cursor is */
	offset: number;
	/** What the project's types can be asked */
	api: ApiSource;
	/** Where the views, translations and configuration are read from */
	cache: SourceCache;
}

/**
 * What could be written at an offset in a stylesheet.
 *
 * Never throws, and answers nothing rather than everything when there is nothing sensible to say.
 *
 * @param context - The stylesheet, the position and everything an answer is drawn from
 * @returns {Promise<ViewCompletion[]>} What belongs there
 */
export async function styleCompletionsAt (context: StyleCompletionContext): Promise<ViewCompletion[]> {
	if (await context.project.type() !== 'alloy') {
		return [];
	}

	const at = nodeAt(parseTss(context.style.text), context.offset);

	// no rule holds the cursor, so it is at the top level: between two rules, above the first,
	// below the last, or in a stylesheet with nothing in it yet. A selector is the only thing
	// that can be written there, and standing on the blank line between two rules and asking is
	// the obvious way to start writing a new one
	if (!at) {
		return selectorCompletions(context);
	}

	if (at.kind === 'selector') {
		return selectorCompletions(context, at.rule);
	}

	const types = await typesStyledBy(context, at.rule);

	if (at.kind === 'body') {
		return propertyNames(context.api, types, [], at.siblings);
	}

	const property = at.property as TssProperty;

	if (at.kind === 'propertyName') {
		return propertyNames(context.api, types, at.path, at.siblings, property);
	}

	// the whitespace inside a nested object is where its own properties go
	if (property.value?.kind === 'object') {
		return propertyNames(context.api, types, [ ...at.path, property.name ], property.value.properties);
	}

	return valueCompletions(context, property, at.path, types);
}

/**
 * The selectors that could be written: the tags a stylesheet can style, and the classes and ids
 * of the views it applies to.
 *
 * Without a rule the cursor is at the top level, where there is no `"…": {}` around it for a name
 * to be accepted into — so each entry writes the whole rule instead, replacing nothing but the
 * cursor. A bare name written there is something Alloy will not parse.
 *
 * @param context - The stylesheet and its readers
 * @param rule - The rule whose selector is being written, when the cursor is in one
 * @returns {Promise<ViewCompletion[]>} The selectors
 */
async function selectorCompletions (context: StyleCompletionContext, rule?: TssRule): Promise<ViewCompletion[]> {
	// only a tag that creates a Titanium type can be styled: Alloy's own markup has no proxy for
	// a style to be applied to
	const tags = [ ...new Set([ ...context.api.titaniumTags(), ...alloyTags() ]) ]
		.filter(tag => typeOfTag(tag) !== undefined)
		.sort();

	const index = new ReferenceIndex({ views: await viewsStyledBy(context.project, context.style.path, context.cache), styles: [] });
	const distinct = (kind: 'class'|'id'): string[] =>
		[ ...new Set(index.usages.filter(usage => usage.kind === kind).map(usage => usage.name)) ].sort();

	const range = rule ? selectorNameRange(rule, context.offset) : { start: context.offset, end: context.offset };

	const entries = [
		...named(tags, 'class', range),
		...named(distinct('class').map(name => `.${name}`), 'class', range),
		...named(distinct('id').map(name => `#${name}`), 'property', range)
	];

	return rule ? entries : entries.map(entry => ({ ...entry, insert: wholeRule(entry.label, context.style.text) }));
}

/**
 * A selector as the whole rule it needs to become, in the quote the stylesheet already uses.
 *
 * The snippet leaves the cursor in the body, which is where the next thing written goes. A client
 * with no snippet engine gets the same text without it — `named` is what picks between the two.
 *
 * @param selector - The selector name
 * @param text - The stylesheet, to read which quote it writes
 * @returns The two forms of the insertion
 */
function wholeRule (selector: string, text: string): { snippet: string; plain: string } {
	const quote = quoteOf(text);
	return {
		snippet: `${quote}${selector}${quote}: {\n\t$0\n}`,
		plain: `${quote}${selector}${quote}: {\n\t\n}`
	};
}

/**
 * Where the selector being typed sits: the comma separated part of the key the cursor is in, from
 * its first character to any `[...]` qualifier, which is what accepting a completion replaces.
 *
 * Worked out from the key's text rather than from its parts, because the part being typed may be
 * empty — `"#label, |"` has one part and a place for a second.
 *
 * @param rule - The rule
 * @param offset - Where the cursor is
 * @returns {TssRange} The span of the name
 */
function selectorNameRange (rule: TssRule, offset: number): TssRange {
	const key = rule.selector.text;
	// worked out in the key's text, where the parts are, and turned back into source positions:
	// an escape earlier in the key makes the two differ
	const at = keyIndexAt(rule.selector, offset);

	let start = 0;
	let end = key.length;
	let depth = 0;
	for (let index = 0; index < key.length; index++) {
		const character = key[index];
		depth += character === '[' ? 1 : character === ']' ? -1 : 0;
		if (character === ',' && depth === 0) {
			if (index < at) {
				start = index + 1;
			} else {
				end = index;
				break;
			}
		}
	}

	while (start < end && /\s/.test(key[start])) {
		start++;
	}

	const chunk = key.slice(start, end);
	const qualifier = chunk.indexOf('[');
	return sourceRange(rule.selector, start, start + (qualifier < 0 ? chunk.trimEnd().length : qualifier));
}

/**
 * The Titanium types a rule styles.
 *
 * A tag is its own type. A class or an id is every element in the views the stylesheet applies to
 * that carries it, each typed the way `core/view.ts` types an element — with its ancestors, so a
 * `<Row>` inside a `<Picker>` is a PickerRow — and an id also names the top level element a view
 * gives its own name. A comma separated key styles what every one of its parts does.
 *
 * @param context - The stylesheet and its readers
 * @param rule - The rule
 * @returns {Promise<string[]>} The type names, tags first and then in the order the elements were found, each once
 */
export async function typesStyledBy (context: StyleCompletionContext, rule: TssRule): Promise<string[]> {
	// every part of a comma separated key, each a selector of its own
	const selectors = rule.selector.parts.flatMap(part => parseSelector(part.text) ?? []);
	const types = new Set<string>();

	for (const selector of selectors.filter(candidate => candidate.kind === 'tag')) {
		const type = typeOfTag(selector.name);
		if (type) {
			types.add(type);
		}
	}

	const identifying = selectors.filter(candidate => candidate.kind !== 'tag');
	if (identifying.length) {
		// matched as the cascade matches, so an id also finds the top level element its view names
		for (const view of await viewsStyledBy(context.project, context.style.path, context.cache)) {
			for (const element of styledElements(view).filter(candidate => identifying.some(selector => styles(selector, candidate)))) {
				types.add(element.type);
			}
		}
	}

	return [ ...types ];
}

/**
 * The type a tag creates when written on its own
 *
 * @param tag - The tag
 * @returns {string|undefined} The type, or nothing for markup that creates none
 */
export function typeOfTag (tag: string): string|undefined {
	return titaniumTypeOf(parseXml(`<Alloy><${tag}/></Alloy>`).elements[1]);
}

/**
 * The properties a rule can set, across every type it styles.
 *
 * Each carries its own type as its detail, and also names the types that have it when the rule
 * styles more than one, because a class on a Label and an ImageView can set `image`, and only the
 * ImageView will take it.
 *
 * @param api - What the project's types can be asked
 * @param types - The types the rule styles
 * @param path - The properties being written inside, outermost first
 * @param siblings - What is already written beside the one being typed
 * @param typing - The property whose name is being typed, when one is
 * @returns {ViewCompletion[]} The property names
 */
function propertyNames (api: ApiSource, types: string[], path: string[], siblings: TssProperty[], typing?: TssProperty): ViewCompletion[] {
	const already = new Set(siblings.filter(sibling => sibling !== typing).map(sibling => sibling.name));
	const found = new Map<string, { member: ApiMember; types: string[] }>();

	for (const type of types) {
		for (const member of api.membersOf(type, path)) {
			// a method is something a controller calls, and a readonly property is one the
			// platform reports: neither is something a style can set
			if (member.kind !== 'property' || member.readonly || already.has(member.name)) {
				continue;
			}

			const entry = found.get(member.name) ?? { member, types: [] };
			entry.types.push(shortName(type));
			found.set(member.name, entry);
		}
	}

	return [ ...found.values() ].map(({ member, types: having }) => {
		const completion: ViewCompletion = {
			label: member.name,
			kind: 'property',
			// the property's type, as TypeScript's own completions show it — and, only when the rule
			// styles more than one type, which of them take it
			detail: types.length > 1 ? `${member.type} — ${having.join(', ')}` : member.type,
			insert: { snippet: `${member.name}: $0`, plain: `${member.name}: ` }
		};
		if (member.documentation) {
			completion.documentation = member.documentation;
		}
		if (typing) {
			completion.range = typing.nameRange;
		}
		return completion;
	});
}

/**
 * What could be written as a property's value.
 *
 * Five sources, the types only for telling a boolean apart: a translation key inside `L()`, a
 * configuration key after `Alloy.CFG.`, an image path in a string, the constants Titanium's apidoc
 * says the property takes, and the fixed values beside them — a colour's names, `layout`'s three,
 * and `true` and `false` for a boolean. Colours and layouts are strings, so they are offered bare
 * inside quotes and quoted outside them, in the quote the stylesheet writes.
 *
 * @param context - The stylesheet and its readers
 * @param property - The property whose value is being written
 * @param path - The properties it sits inside
 * @param types - The types the rule styles
 * @returns {Promise<ViewCompletion[]>} The values
 */
async function valueCompletions (context: StyleCompletionContext, property: TssProperty, path: string[], types: string[]): Promise<ViewCompletion[]> {
	const { project, cache, offset, style } = context;

	const translations = await translationsIn({ project, view: style, offset, api: context.api, cache });
	if (translations) {
		return translations;
	}

	const valueStart = property.value?.range.start ?? property.valueStart ?? offset;
	const config = /Alloy\.CFG\.([A-Za-z0-9_$]*)$/.exec(style.text.slice(valueStart, offset));
	if (config) {
		const read = await readAlloyConfig(project, cache);
		return named(Object.keys(read?.values ?? {}).sort(), 'property', { start: offset - config[1].length, end: offset });
	}

	const value = property.value;
	// read at its path, so a boolean inside backgroundGradient is as much a boolean as one outside
	const boolean = types.some(type => context.api.membersOf(type, path).some(member => member.name === property.name && member.type === 'boolean'));
	const literal = literalValuesFor(property.name, boolean);

	// inside quotes a constant would be text: a string names a path, a colour or a layout
	if (value?.kind === 'string') {
		const contents = { start: value.range.start + 1, end: value.range.end - (value.terminated ? 1 : 0) };
		if (literal?.strings) {
			return ordered(literal.values, contents);
		}
		if (!isImageProperty(property.name, false)) {
			return [];
		}
		return named(await imagePathsFor(project, property.name, false), 'script', contents);
	}

	if (value && value.kind !== 'expression') {
		return [];
	}

	const documentation = new Map<string, string>();
	const available = (namespace: string): string[] => context.api.constantsOf(namespace).map(constant => {
		documentation.set(`${namespace.replace(/^Titanium\b/, 'Ti')}.${constant.name}`, constant.documentation);
		return constant.name;
	});

	const range = value ? value.range : { start: offset, end: offset };

	// a nested property takes no constants of its own that the table knows of
	const constants = (path.length ? [] : constantsFor(property.name, types, available)).map(name => {
		const completion: ViewCompletion = { label: name, kind: 'const', range };
		if (documentation.get(name)) {
			completion.documentation = documentation.get(name);
		}
		return completion;
	});

	if (!literal) {
		return constants;
	}

	const quote = quoteOf(style.text);
	return [ ...constants, ...ordered(literal.strings ? literal.values.map(name => `${quote}${name}${quote}`) : literal.values, range) ];
}

/**
 * Fixed values as completions, in the order given rather than a client's alphabetical one
 *
 * @param values - The values, as they are written
 * @param range - What each replaces
 * @returns {ViewCompletion[]} The completions
 */
function ordered (values: string[], range: TssRange): ViewCompletion[] {
	return values.map((value, index) => ({ label: value, kind: 'enum member', range, sortText: String(index).padStart(4, '0') }));
}

/**
 * A type's last name, which is how the detail names it
 *
 * @param type - A fully qualified type
 * @returns {string} Its last segment
 */
function shortName (type: string): string {
	return type.slice(type.lastIndexOf('.') + 1);
}
