/**
 * A parser for Alloy's TSS.
 *
 * TSS is a JSON dialect: unquoted keys, optional commas between top level rules, comments, single
 * quotes, and a handful of expression forms — `Ti.UI.SIZE`, `L('key')`, `WPATH('x')`, `$.args.foo`
 * and bitwise combinations of those.
 *
 * Alloy parses it with a PEG grammar (Alloy/grammar/tss.pegjs) whose actions discard positions. We
 * cannot reuse it for two reasons, and the second is the one that matters: a PEG parser throws on
 * the first thing it cannot match, and a language server sees a half-typed document on every
 * keystroke. Our own sample.tss fixture — a property with no value, a bare word with no colon, an
 * unterminated string — would fail on its second line.
 *
 * So this is hand written to keep going. It never throws, records what it could not read as
 * diagnostics, and gives every node a source range so answers map back to what the user typed.
 */

/** Which of the three things a selector names */
export type SelectorKind = 'id' | 'class' | 'tag';

export interface Selector {
	kind: SelectorKind;
	name: string;
	/** The `[...]` qualifiers. `platform` is a list, everything else is a single value */
	queries: Record<string, string|string[]>;
}

/** A half-open span of the source text, in character offsets */
export interface TssRange {
	start: number;
	end: number;
}

export interface TssSelector {
	/** The selector without its quotes, e.g. `.container`, `#label`, `Label[platform=android]` */
	text: string;
	range: TssRange;
	/**
	 * The selectors the key names, one per comma separated part: `".heading, Button"` is two.
	 *
	 * Alloy 3.1 splits a key on its commas outside `[...]`, trims each part and skips any that is
	 * empty, then reads each as a selector of its own. A key with no comma is one part.
	 */
	parts: TssSelectorPart[];
	/**
	 * Where each character of `text` is written, and one entry more for where it ends.
	 *
	 * `text` is the key's value with its escapes read, so `\u0023a` is two characters of text and
	 * seven of source: counting from the opening quote would put everything after an escape in
	 * the wrong place. `sourceRange` reads this.
	 */
	offsets: number[];
}

/** One comma separated part of a rule's key */
export interface TssSelectorPart {
	/** The part, trimmed, as `parseSelector` reads it */
	text: string;
	/** Where the part is written */
	range: TssRange;
	/** Where the part starts in the key's `text` */
	index: number;
}

export interface TssProperty {
	name: string;
	nameRange: TssRange;
	/**
	 * Just past the colon, when there is one.
	 *
	 * What makes `color: |` a value position before any value has been typed: without it the
	 * cursor there is only whitespace inside the rule, and nothing says which property it belongs to.
	 */
	valueStart?: number;
	/** Absent while the value is still being typed */
	value?: TssValue;
	range: TssRange;
}

export type TssValue =
	| { kind: 'string'; value: string; terminated: boolean; range: TssRange }
	| { kind: 'number'; value: number; range: TssRange }
	| { kind: 'boolean'; value: boolean; range: TssRange }
	| { kind: 'null'; range: TssRange }
	| { kind: 'undefined'; range: TssRange }
	| { kind: 'object'; properties: TssProperty[]; range: TssRange }
	| { kind: 'array'; elements: TssValue[]; range: TssRange }
	| {
		kind: 'expression';
		/** What the author wrote, with comments removed */
		text: string;
		/** Alloy's own reading of it: whitespace outside strings collapsed, Locale.getString as L */
		normalised: string;
		range: TssRange;
	};

export interface TssRule {
	selector: TssSelector;
	properties: TssProperty[];
	/** The block's braces, absent when the rule has not been given one yet */
	bodyRange?: TssRange;
	range: TssRange;
}

export interface TssDiagnostic {
	message: string;
	range: TssRange;
}

/**
 * A comment, which the parser otherwise discards as trivia.
 *
 * Recorded because a position inside one is held by no rule, and so is indistinguishable from the
 * top level unless the parse says so. Working it out from the text afterwards would mean
 * re-implementing the string handling that keeps `"http://x"` from reading as a comment.
 */
export interface TssComment {
	range: TssRange;
	/**
	 * Whether the comment carries its own end. A block comment's `*` + `/` is part of it, so a
	 * cursor past that is outside; a line comment ends at a newline that is not part of it, so a
	 * cursor at its end is still inside.
	 */
	terminated: boolean;
}

export interface TssDocument {
	rules: TssRule[];
	diagnostics: TssDiagnostic[];
	comments: TssComment[];
}

/** What sits at an offset, which is what a provider asks before deciding what to offer */
export interface TssNodeAt {
	kind: 'selector' | 'propertyName' | 'value' | 'body';
	rule: TssRule;
	property?: TssProperty;
	/**
	 * The properties the one at the offset sits inside, outermost first.
	 *
	 * `fontSize` inside `font: { … }` has the path `[ 'font' ]`, which is what says it is written
	 * into a Font rather than onto the element. A top level property has an empty path.
	 */
	path: string[];
	/**
	 * The properties written beside the one at the offset — the rule's own at the top level, and
	 * the enclosing object's inside one.
	 *
	 * Found by position rather than by following the path's names, which cannot tell two objects
	 * of the same name apart.
	 */
	siblings: TssProperty[];
}

const BARE = /[a-zA-Z0-9_$]/;
const DIGIT = /[0-9]/;
const BITWISE = [ '>>>', '>>', '<<<', '<<', '&', '|', '^' ];

/**
 * Parses TSS, recovering rather than failing.
 *
 * @param text - The document contents
 * @returns {TssDocument} The rules it could read, and what it could not
 */
export function parseTss (text: string): TssDocument {
	const strict = new TssParser(text, false).parse();

	// A block that never closed swallows everything after it. That is what the text says, and it
	// is useless: the rules below a typo would answer nothing. So anything that did not read
	// cleanly is read again, treating a name back at column zero as the end of the block.
	//
	// The trigger is any diagnostic rather than an unterminated block specifically, because a
	// later stray brace can close the wrong block and leave the parse silently wrong instead of
	// visibly unfinished. A document that reads cleanly is never read twice, which is what keeps
	// valid TSS written without indentation safe from the heuristic.
	if (strict.diagnostics.length === 0) {
		return strict;
	}

	return new TssParser(text, true).parse();
}

const UNTERMINATED_BLOCK = 'Unterminated block';

class TssParser {

	private offset = 0;

	private readonly rules: TssRule[] = [];
	private readonly diagnostics: TssDiagnostic[] = [];
	private readonly comments: TssComment[] = [];

	private readonly text: string;
	private readonly dedentClosesBlocks: boolean;

	// written out rather than as constructor parameter properties: those are one of the few pieces
	// of TypeScript that cannot be erased, and the tests run the sources through Node's type
	// stripping rather than through a build
	constructor (text: string, dedentClosesBlocks: boolean) {
		this.text = text;
		this.dedentClosesBlocks = dedentClosesBlocks;
	}

	public parse (): TssDocument {
		for (;;) {
			this.skipTrivia();
			if (this.atEnd()) {
				break;
			}

			const before = this.offset;
			this.parseRule();

			// nothing consumed means an unrecognised character; step over it so the loop ends
			if (this.offset === before) {
				this.report(`Unexpected ${JSON.stringify(this.text[this.offset])}`, this.offset, this.offset + 1);
				this.offset++;
			}
		}

		return { rules: this.rules, diagnostics: this.diagnostics, comments: this.comments };
	}

	private parseRule (): void {
		const start = this.offset;
		const selector = this.parseName();
		if (!selector) {
			return;
		}

		this.skipTrivia();
		if (this.peek() === ':') {
			this.offset++;
			this.skipTrivia();
		}

		let properties: TssProperty[] = [];
		let bodyRange: TssRange|undefined;

		// a selector with no block yet is still a rule — the user is part way through writing one
		if (this.peek() === '{') {
			const bodyStart = this.offset;
			properties = this.parseBlock();
			bodyRange = { start: bodyStart, end: this.offset };
		}

		this.rules.push({
			selector: { text: selector.text, range: selector.range, offsets: selector.offsets, parts: splitSelector(selector) },
			properties,
			bodyRange,
			range: { start, end: this.offset }
		});
	}

	/**
	 * The contents of a `{ ... }` block
	 *
	 * @returns {TssProperty[]} Its properties, including any that are still being typed
	 */
	private parseBlock (): TssProperty[] {
		const open = this.offset;
		this.offset++;

		const properties: TssProperty[] = [];

		for (;;) {
			this.skipTrivia();

			if (this.atEnd()) {
				this.report(UNTERMINATED_BLOCK, open, this.offset);
				return properties;
			}

			if (this.peek() === '}') {
				this.offset++;
				return properties;
			}

			// a name back at column zero, in a document already known to be missing a brace
			if (this.dedentClosesBlocks && this.atLineStart()) {
				this.report(UNTERMINATED_BLOCK, open, this.offset);
				return properties;
			}

			const before = this.offset;
			const property = this.parseProperty();
			if (property) {
				properties.push(property);
			}

			if (this.offset === before) {
				this.report(`Unexpected ${JSON.stringify(this.text[this.offset])}`, this.offset, this.offset + 1);
				this.offset++;
			}
		}
	}

	private parseProperty (): TssProperty|undefined {
		const start = this.offset;
		const name = this.parseName();
		if (!name) {
			return;
		}

		this.skipTrivia();

		// a bare word with no colon is a property name mid-keystroke, which is exactly what a
		// completion request needs to see
		if (this.peek() !== ':') {
			return { name: name.text, nameRange: name.range, range: { start, end: name.range.end } };
		}

		this.offset++;
		const valueStart = this.offset;
		this.skipTrivia();

		// the value cannot be back at column zero on a later line: in a document already missing a
		// brace that is the next rule, not this property's value
		if (this.dedentClosesBlocks && this.atLineStart()) {
			return { name: name.text, nameRange: name.range, valueStart, range: { start, end: name.range.end } };
		}

		const value = this.parseValue();
		return {
			name: name.text,
			nameRange: name.range,
			valueStart,
			value,
			range: { start, end: value ? value.range.end : name.range.end }
		};
	}

	/**
	 * A quoted or bare name, used for both selectors and property names
	 *
	 * @returns {{ text: string, range: TssRange }|undefined} The name, or nothing if there is none here
	 */
	private parseName (): { text: string; range: TssRange; offsets: number[] }|undefined {
		const character = this.peek();

		if (character === '"' || character === "'") {
			const string = this.readString();
			return { text: string.value, range: string.range, offsets: string.offsets };
		}

		if (character && BARE.test(character)) {
			const start = this.offset;
			while (!this.atEnd() && BARE.test(this.text[this.offset])) {
				this.offset++;
			}
			// a bare name has no escapes, so each character is written where it reads
			const offsets = Array.from({ length: this.offset - start + 1 }, (_, index) => start + index);
			return { text: this.text.slice(start, this.offset), range: { start, end: this.offset }, offsets };
		}
	}

	private parseValue (): TssValue|undefined {
		const character = this.peek();
		if (!character) {
			return;
		}

		if (character === '"' || character === "'") {
			const string = this.readString();
			if (!string.terminated) {
				this.report('Unterminated string', string.range.start, string.range.end);
			}
			return this.withOperators({ kind: 'string', value: string.value, terminated: string.terminated, range: string.range });
		}

		if (character === '{') {
			const start = this.offset;
			const properties = this.parseBlock();
			return { kind: 'object', properties, range: { start, end: this.offset } };
		}

		if (character === '[') {
			return this.parseArray();
		}

		if (DIGIT.test(character) || (character === '-' && DIGIT.test(this.text[this.offset + 1] ?? ''))) {
			return this.withOperators(this.readNumber());
		}

		if (BARE.test(character)) {
			return this.withOperators(this.readWordValue());
		}
	}

	private parseArray (): TssValue {
		const start = this.offset;
		this.offset++;

		const elements: TssValue[] = [];

		for (;;) {
			this.skipTrivia();

			if (this.atEnd()) {
				this.report('Unterminated array', start, this.offset);
				break;
			}

			if (this.peek() === ']') {
				this.offset++;
				break;
			}

			const before = this.offset;
			const element = this.parseValue();
			if (element) {
				elements.push(element);
			}

			if (this.offset === before) {
				this.report(`Unexpected ${JSON.stringify(this.text[this.offset])}`, this.offset, this.offset + 1);
				this.offset++;
			}
		}

		return { kind: 'array', elements, range: { start, end: this.offset } };
	}

	/**
	 * A bare word value: a keyword, or an expression such as `Ti.UI.SIZE`, `L('key')` or `$.args.x`.
	 *
	 * Rewinds and yields nothing when the word turns out to be the next property's name — `width:`
	 * followed by `height: 10` means width has no value yet, not that its value is `height`.
	 *
	 * @returns {TssValue|undefined} The value, or nothing if the word belongs to what comes next
	 */
	private readWordValue (): TssValue|undefined {
		const start = this.offset;

		while (!this.atEnd() && (BARE.test(this.text[this.offset]) || this.text[this.offset] === '.')) {
			this.offset++;
		}

		// a call such as L('key') or WPATH('x'): take everything up to the matching close paren
		if (this.peek() === '(') {
			this.skipBalancedParens();
		}

		const end = this.offset;
		const word = this.text.slice(start, end);

		const after = this.offset;
		this.skipTrivia();
		if (this.peek() === ':') {
			this.offset = start;
			return;
		}
		this.offset = after;

		const range = { start, end };

		switch (word) {
			case 'true':
				return { kind: 'boolean', value: true, range };
			case 'false':
				return { kind: 'boolean', value: false, range };
			case 'null':
				return { kind: 'null', range };
			case 'undefined':
				return { kind: 'undefined', range };
			default:
				return expression(this.text.slice(range.start, range.end), range);
		}
	}

	/**
	 * Extends a value across bitwise operators, which Alloy allows between constants
	 *
	 * @param left - The value parsed so far
	 * @returns {TssValue} The value, widened to an expression if operators followed it
	 */
	private withOperators (left: TssValue|undefined): TssValue|undefined {
		if (!left) {
			return left;
		}

		let end = left.range.end;

		for (;;) {
			const resume = this.offset;
			this.skipTrivia();

			const operator = BITWISE.find(candidate => this.text.startsWith(candidate, this.offset));
			if (!operator) {
				this.offset = resume;
				break;
			}

			this.offset += operator.length;
			this.skipTrivia();

			const right = this.parseValue();
			if (!right) {
				this.offset = resume;
				break;
			}
			end = right.range.end;
		}

		if (end === left.range.end) {
			return left;
		}

		const range = { start: left.range.start, end };
		return expression(this.text.slice(range.start, range.end), range);
	}

	/**
	 * Reads a quoted string.
	 *
	 * An unclosed quote stops at the end of the line rather than running to the end of the file,
	 * so a string the user is part way through does not swallow the rest of the document.
	 *
	 * @returns {{ value: string, terminated: boolean, range: TssRange }} The string and whether it closed
	 */
	private readString (): { value: string; terminated: boolean; range: TssRange; offsets: number[] } {
		const start = this.offset;
		const quote = this.text[this.offset];
		this.offset++;

		let value = '';
		let terminated = false;
		// where each character of the value is written, so a position in the value can be turned
		// back into one in the source however many escapes come before it
		const offsets: number[] = [];

		while (!this.atEnd()) {
			const character = this.text[this.offset];

			if (character === '\n' || character === '\r') {
				break;
			}

			if (character === '\\' && this.offset + 1 < this.text.length) {
				// ALOY-793: Alloy doubles a run of backslashes surrounded by whitespace before
				// parsing, so its own unescaping leaves them intact. Treating such a run as literal
				// reaches the same value without a rewrite that would shift every later offset
				const run = this.backslashRun();
				if (run) {
					for (let index = 0; index < run.length; index++) {
						offsets.push(this.offset + index);
					}
					value += run;
					this.offset += run.length;
					continue;
				}

				offsets.push(this.offset);

				const next = this.text[this.offset + 1];
				if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(this.text.slice(this.offset + 2, this.offset + 6))) {
					value += String.fromCharCode(parseInt(this.text.slice(this.offset + 2, this.offset + 6), 16));
					this.offset += 6;
					continue;
				}

				value += unescape(next);
				this.offset += 2;
				continue;
			}

			if (character === quote) {
				offsets.push(this.offset);
				this.offset++;
				terminated = true;
				break;
			}

			offsets.push(this.offset);
			this.offset++;
			value += character;
		}

		// one entry past the value, for where it ends: the closing quote, or the end of the line
		if (!terminated) {
			offsets.push(this.offset);
		}

		return { value, terminated, range: { start, end: this.offset }, offsets };
	}

	/**
	 * A run of backslashes with whitespace on both sides, which Alloy treats as literal
	 *
	 * @returns {string|undefined} The run, if this is one
	 */
	private backslashRun (): string|undefined {
		const before = this.text[this.offset - 1];
		if (before !== undefined && !/\s/.test(before)) {
			return;
		}

		let end = this.offset;
		while (end < this.text.length && this.text[end] === '\\') {
			end++;
		}

		const after = this.text[end];
		return after !== undefined && /\s/.test(after) ? this.text.slice(this.offset, end) : undefined;
	}

	private readNumber (): TssValue {
		const start = this.offset;

		if (this.peek() === '-') {
			this.offset++;
		}
		while (!this.atEnd() && DIGIT.test(this.text[this.offset])) {
			this.offset++;
		}
		if (this.peek() === '.' && DIGIT.test(this.text[this.offset + 1] ?? '')) {
			this.offset++;
			while (!this.atEnd() && DIGIT.test(this.text[this.offset])) {
				this.offset++;
			}
		}
		if (this.peek() === 'e' || this.peek() === 'E') {
			const resume = this.offset;
			this.offset++;
			if (this.peek() === '+' || this.peek() === '-') {
				this.offset++;
			}
			if (DIGIT.test(this.peek() ?? '')) {
				while (!this.atEnd() && DIGIT.test(this.text[this.offset])) {
					this.offset++;
				}
			} else {
				this.offset = resume;
			}
		}

		const range = { start, end: this.offset };
		return { kind: 'number', value: Number(this.text.slice(start, this.offset)), range };
	}

	private skipBalancedParens (): void {
		let depth = 0;

		while (!this.atEnd()) {
			const character = this.text[this.offset];

			if (character === '"' || character === "'") {
				this.readString();
				continue;
			}

			this.offset++;

			if (character === '(') {
				depth++;
			} else if (character === ')') {
				depth--;
				if (depth === 0) {
					return;
				}
			}
		}
	}

	/** Whitespace, commas and comments, which separate everything and mean nothing */
	private skipTrivia (): void {
		for (;;) {
			while (!this.atEnd() && /[\s,]/.test(this.text[this.offset])) {
				this.offset++;
			}

			if (this.text.startsWith('//', this.offset)) {
				const start = this.offset;
				while (!this.atEnd() && this.text[this.offset] !== '\n') {
					this.offset++;
				}
				// the newline is not part of it, so a cursor at the end of the text is still inside
				this.comments.push({ range: { start, end: this.offset }, terminated: false });
				continue;
			}

			if (this.text.startsWith('/*', this.offset)) {
				const start = this.offset;
				const end = this.text.indexOf('*/', this.offset + 2);
				this.offset = end === -1 ? this.text.length : end + 2;
				this.comments.push({ range: { start, end: this.offset }, terminated: end !== -1 });
				continue;
			}

			return;
		}
	}

	/** Whether the cursor sits at the first column of a line */
	private atLineStart (): boolean {
		return this.offset === 0 || this.text[this.offset - 1] === '\n';
	}

	private peek (): string|undefined {
		return this.text[this.offset];
	}

	private atEnd (): boolean {
		return this.offset >= this.text.length;
	}

	private report (message: string, start: number, end: number): void {
		this.diagnostics.push({ message, range: { start, end: Math.min(end, this.text.length) } });
	}
}

/**
 * Builds an expression value, carrying both what was written and Alloy's reading of it
 *
 * @param raw - The source text the expression spans
 * @param range - Where it sits in the document
 * @returns {TssValue} The expression
 */
function expression (raw: string, range: TssRange): TssValue {
	const text = stripComments(raw);
	return { kind: 'expression', text, normalised: normalise(text), range };
}

/**
 * Removes comments, which are not part of an expression even when written inside one
 *
 * @param text - The source text
 * @returns {string} The text without its comments
 */
function stripComments (text: string): string {
	return mapOutsideStrings(text, segment => segment.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
}

/**
 * Alloy's own reading of an expression: it joins the parts of a call or a bitwise chain without
 * separators, and treats `Ti.Locale.getString` and its longer spellings as `L`
 *
 * @param text - The expression text
 * @returns {string} The normalised form
 */
function normalise (text: string): string {
	const collapsed = mapOutsideStrings(text, segment => segment.replace(/\s+/g, ''));
	return collapsed.replace(/^(?:Titanium|Ti|Alloy)\.Locale\.getString/, 'L');
}

/**
 * Applies a transform to the parts of some text that are not inside a quoted string, so that
 * rewriting never reaches into a string literal's contents
 *
 * @param text - The text to walk
 * @param transform - Applied to each run of text outside a string
 * @returns {string} The rewritten text
 */
function mapOutsideStrings (text: string, transform: (segment: string) => string): string {
	let out = '';
	let outside = '';
	let quote: string|undefined;

	for (let index = 0; index < text.length; index++) {
		const character = text[index];

		if (quote) {
			out += character;
			if (character === quote && text[index - 1] !== '\\') {
				quote = undefined;
			}
			continue;
		}

		if (character === '"' || character === "'") {
			out += transform(outside) + character;
			outside = '';
			quote = character;
			continue;
		}

		outside += character;
	}

	return out + transform(outside);
}

/**
 * Unescapes one character following a backslash
 *
 * @param character - The escaped character
 * @returns {string} What it stands for
 */
function unescape (character: string): string {
	switch (character) {
		case 'n': return '\n';
		case 'r': return '\r';
		case 't': return '\t';
		case 'b': return '\b';
		case 'f': return '\f';
		default: return character;
	}
}

/**
 * What sits at an offset in a parsed document.
 *
 * This is what replaces scanning backwards from the cursor for quote characters: a provider asks
 * where it is and gets an answer derived from the parse rather than from a regular expression.
 *
 * @param document - The parsed document
 * @param offset - A character offset into the source
 * @returns {TssNodeAt|undefined} What is there, if anything
 */
export function nodeAt (document: TssDocument, offset: number): TssNodeAt|undefined {
	for (const rule of document.rules) {
		if (!contains(rule.range, offset)) {
			continue;
		}

		if (contains(rule.selector.range, offset)) {
			return { kind: 'selector', rule, path: [], siblings: rule.properties };
		}

		const found = inProperties(rule, rule.properties, offset, [], rule.bodyRange?.end ?? rule.range.end);
		if (found) {
			return found;
		}

		return { kind: 'body', rule, path: [], siblings: rule.properties };
	}
}

/**
 * Whether an offset sits inside a comment.
 *
 * Asked alongside `nodeAt`, which answers nothing both at the top level and inside a comment: the
 * two are the same absence and want opposite answers.
 *
 * The start is exclusive, so a cursor immediately before a `//` is at the top level rather than in
 * the comment it precedes. The end follows the comment's own: a block comment's `*` + `/` belongs
 * to it, so a cursor past that is out, while a line comment's newline does not, so a cursor at the
 * end of the line is still in.
 *
 * @param document - The parsed stylesheet
 * @param offset - A character offset into the source
 * @returns {boolean} Whether it is inside a comment
 */
export function insideComment (document: TssDocument, offset: number): boolean {
	return document.comments.some(comment => offset > comment.range.start
		&& (comment.terminated ? offset < comment.range.end : offset <= comment.range.end));
}

/**
 * Searches a property list, descending into nested objects so the innermost match wins
 *
 * @param rule - The rule the properties belong to
 * @param properties - The properties to search
 * @param offset - A character offset into the source
 * @param path - The properties these sit inside, outermost first
 * @param blockEnd - Where the block holding them ends, which bounds the last one's value slot
 * @returns {TssNodeAt|undefined} What is there, if anything
 */
function inProperties (rule: TssRule, properties: TssProperty[], offset: number, path: string[], blockEnd: number): TssNodeAt|undefined {
	for (const [ index, property ] of properties.entries()) {
		if (property.value?.kind === 'object' && contains(property.value.range, offset)) {
			const nested = inProperties(rule, property.value.properties, offset, [ ...path, property.name ], property.value.range.end);
			if (nested) {
				return nested;
			}
			return { kind: 'value', rule, property, path, siblings: properties };
		}

		if (contains(property.nameRange, offset)) {
			return { kind: 'propertyName', rule, property, path, siblings: properties };
		}

		if (property.value && contains(property.value.range, offset)) {
			return { kind: 'value', rule, property, path, siblings: properties };
		}

		// a colon with nothing after it yet: the value slot runs up to whatever comes next
		const slotEnd = properties[index + 1]?.range.start ?? blockEnd;
		if (!property.value && property.valueStart !== undefined && offset >= property.valueStart && offset < slotEnd) {
			return { kind: 'value', rule, property, path, siblings: properties };
		}
	}
}

/**
 * Whether an offset falls within a range, counting the position just past its end so that a cursor
 * sitting at the end of a word is still in that word
 *
 * @param range - The range to test
 * @param offset - A character offset into the source
 * @returns {boolean} Whether it is inside
 */
function contains (range: TssRange, offset: number): boolean {
	return offset >= range.start && offset <= range.end;
}

/**
 * The comma separated parts of a key, as `splitSelectors` in Alloy's `styler.js` finds them: split
 * on a comma outside `[...]`, each part trimmed and an empty one skipped.
 *
 * @param key - The key as the parser read it, with where each character is written
 * @returns {TssSelectorPart[]} The parts, each placed where it is written
 */
function splitSelector (key: { text: string; offsets: number[] }): TssSelectorPart[] {
	const parts: TssSelectorPart[] = [];

	let depth = 0;
	let start = 0;
	const push = (end: number): void => {
		const chunk = key.text.slice(start, end);
		const trimmed = chunk.trim();
		if (trimmed) {
			const index = start + (chunk.length - chunk.trimStart().length);
			parts.push({ text: trimmed, index, range: sourceRange(key, index, index + trimmed.length) });
		}
	};

	for (let index = 0; index < key.text.length; index++) {
		const character = key.text[index];
		if (character === '[') {
			depth++;
		} else if (character === ']') {
			depth--;
		} else if (character === ',' && depth === 0) {
			push(index);
			start = index + 1;
		}
	}
	push(key.text.length);

	return parts;
}

/**
 * Where a span of a key's text is written in the source
 *
 * @param key - The key, with where each character is written
 * @param start - Where the span starts in the key's text
 * @param end - Where it ends, exclusive
 * @returns {TssRange} The span in the source
 */
export function sourceRange (key: { offsets: number[] }, start: number, end: number): TssRange {
	return { start: key.offsets[start], end: key.offsets[end] };
}

/**
 * Where in a key's text a source offset falls: the last character written at or before it
 *
 * @param key - The key, with where each character is written
 * @param offset - A character offset into the source
 * @returns {number} The index into the key's text, which is its length for the end of the key
 */
export function keyIndexAt (key: { offsets: number[] }, offset: number): number {
	let index = 0;
	while (index + 1 < key.offsets.length && key.offsets[index + 1] <= offset) {
		index++;
	}
	return index;
}

/**
 * The part of a rule's key an offset falls in
 *
 * @param rule - The rule
 * @param offset - A character offset into the source
 * @returns {TssSelectorPart|undefined} The part, when the offset is on one rather than between two
 */
export function selectorPartAt (rule: TssRule, offset: number): TssSelectorPart|undefined {
	return rule.selector.parts.find(part => contains(part.range, offset));
}

// Alloy's own selector rule, copied from Alloy/commands/compile/styler.js so that what we consider
// a selector is what the compiler considers a selector. Two of its quirks come along with it: the
// name is everything before the first `[`, and with repeated bracket groups only the last is kept.
const SELECTOR = /^\s*([#.]{0,1})([^[]+)(?:\[([^\]]+)\])*\s*$/;

/**
 * Reads a TSS selector into the thing it names and the qualifiers on it.
 *
 * Alloy dies on a selector this cannot read, and skips a bare `undefined`, so both yield nothing
 * rather than a selector nobody could have meant.
 *
 * @param text - The selector, without its quotes
 * @returns {Selector|undefined} What it names, or nothing if Alloy would not accept it
 */
export function parseSelector (text: string): Selector|undefined {
	const match = SELECTOR.exec(text);
	if (!match) {
		return;
	}

	const [ , prefix, rawName, rawQueries ] = match;
	const name = rawName.trim();

	// styler.js drops this: it is what a stray parse looks like, not a selector
	if (!name || (name === 'undefined' && !prefix)) {
		return;
	}

	const kind: SelectorKind = prefix === '#' ? 'id' : prefix === '.' ? 'class' : 'tag';
	const queries: Record<string, string|string[]> = {};

	if (rawQueries) {
		// space separated pairs, and a platform value that is itself a comma separated list
		for (const query of rawQueries.replace(/\s*,\s*/g, ',').split(/\s+/)) {
			if (!query) {
				continue;
			}
			const [ key, value ] = query.split('=');
			const trimmedKey = key.trim();
			const trimmedValue = (value ?? '').trim();
			queries[trimmedKey] = trimmedKey === 'platform' ? trimmedValue.split(',') : trimmedValue;
		}
	}

	return { kind, name, queries };
}
