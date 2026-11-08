import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { styleCompletionsAt } from '../../core/style.ts';
import type { ViewCompletion } from '../../core/view.ts';
import { fixturePath } from '../fixtures.ts';
import { api } from './fake-api.ts';

interface Options {
	/** The stylesheet, relative to the project's app directory */
	style?: string;
	/** The view that stylesheet is paired with, as a buffer, when the test needs particular elements */
	view?: string;
	fixture?: string;
}

/**
 * The completions offered where `|` marks the cursor in a stylesheet
 *
 * @param text - The stylesheet source, with `|` marking the cursor
 * @param options - Which stylesheet it is, and the view it styles
 * @returns {Promise<ViewCompletion[]>} What is offered there
 */
async function completionsAt (text: string, options: Options = {}): Promise<ViewCompletion[]> {
	const root = await fixturePath(options.fixture ?? 'alloy-project');
	const project = new Project(root);
	await project.load();

	const cache = new SourceCache();
	if (options.view !== undefined) {
		cache.override(path.join(root, 'app', 'views', 'index.xml'), options.view);
	}

	return styleCompletionsAt({
		project,
		style: { path: path.join(root, 'app', options.style ?? path.join('styles', 'index.tss')), text: text.replace('|', '') },
		offset: text.indexOf('|'),
		api,
		cache
	});
}

/**
 * The labels offered where `|` marks the cursor
 *
 * @param text - The stylesheet source, with `|` marking the cursor
 * @param options - Which stylesheet it is, and the view it styles
 * @returns {Promise<string[]>} The labels
 */
async function labelsAt (text: string, options: Options = {}): Promise<string[]> {
	return (await completionsAt(text, options)).map(completion => completion.label);
}

describe('What can be written in a stylesheet', () => {

	describe('selectors', () => {

		it('should offer the tags, and the classes and ids of the view it styles', async () => {
			// index.tss styles index.xml: a Window with container and thirdClass, a Label with id label
			const labels = await labelsAt('"|"');

			assert.ok(labels.includes('Label'), 'a tag');
			assert.ok(labels.includes('.container'), 'a class from the view');
			assert.ok(labels.includes('#label'), 'an id from the view');
		});

		it('should not offer Alloy\'s own markup, which a stylesheet cannot style', async () => {
			const labels = await labelsAt('"|"');

			for (const markup of [ 'Require', 'Widget', 'Model', 'Alloy' ]) {
				assert.ok(!labels.includes(markup), `${markup} is not styleable`);
			}
		});

		it('should replace the whole name typed so far, however long', async () => {
			// the implementation being replaced matched a single character, so "W worked and "Win did not
			const text = '"Win|"';
			const window = (await completionsAt(text)).find(completion => completion.label === 'Window');

			assert.deepEqual(window?.range, { start: 1, end: text.indexOf('|') });
		});

		it('should answer inside a selector whose closing quote is not typed yet', async () => {
			assert.ok((await labelsAt('"Lab|')).includes('Label'));
		});

		it('should replace only the name, not the qualifier after it', async () => {
			const text = '"La|bel[platform=ios]": {}';
			const label = (await completionsAt(text)).find(completion => completion.label === 'Label');

			assert.deepEqual(label?.range, { start: 1, end: 1 + 'Label'.length });
		});

		it('should replace only the part of a comma separated key being typed', async () => {
			const text = '"#label, .con|"';
			const container = (await completionsAt(text)).find(completion => completion.label === '.container');

			assert.deepEqual(container?.range, { start: text.indexOf('.con'), end: text.indexOf('|') });
		});

		it('should replace the part being typed after an escaped one', async () => {
			const text = '"\\u0023label, .con|"';
			const container = (await completionsAt(text)).find(completion => completion.label === '.container');

			assert.deepEqual(container?.range, { start: text.indexOf('.con'), end: text.indexOf('|') });
		});

		it('should offer a fresh part after a comma', async () => {
			const text = '"#label, |"';
			const label = (await completionsAt(text)).find(completion => completion.label === 'Label');

			assert.deepEqual(label?.range, { start: text.indexOf('|'), end: text.indexOf('|') });
		});

		it('should offer selectors on a blank line between two rules', async () => {
			// the obvious way to start writing a rule: put the cursor on the blank line between two
			// and ask. Nothing holds that offset, so until this it answered nothing at all
			const labels = await labelsAt('".a": {\n\tcolor: "red"\n}\n\n|\n\n".b": {\n\tcolor: "blue"\n}\n');

			assert.ok(labels.includes('Label'), 'a tag');
			assert.ok(labels.includes('.container'), 'a class from the view');
			assert.ok(labels.includes('#label'), 'an id from the view');
		});

		it('should offer selectors on a blank line before the first rule', async () => {
			assert.ok((await labelsAt('|\n\n".a": {\n\tcolor: "red"\n}\n')).includes('Label'));
		});

		it('should offer selectors on a blank line after the last rule', async () => {
			assert.ok((await labelsAt('".a": {\n\tcolor: "red"\n}\n\n|')).includes('Label'));
		});

		it('should offer selectors in a stylesheet with nothing in it yet', async () => {
			assert.ok((await labelsAt('|')).includes('Label'));
		});

		it('should offer selectors at column zero of a selector line', async () => {
			// a rule's range starts at its opening quote, so this already answered — the cases
			// either side of it are what did not, and all three are one position to a user
			assert.ok((await labelsAt('|".a": {\n\tcolor: "red"\n}\n')).includes('Label'));
		});

		it('should insert a whole rule where there is no rule to complete into', async () => {
			// at top level there is no `"…": {}` around the cursor, so accepting a name has to
			// write one — otherwise the user is left with a bare word that Alloy will not parse
			const top = (await completionsAt('".a": {}\n\n|\n')).find(completion => completion.label === 'Label');
			const inside = (await completionsAt('"|"')).find(completion => completion.label === 'Label');

			assert.match(top?.insert?.plain ?? '', /^"Label": \{/, `got ${top?.insert?.plain}`);
			assert.match(top?.insert?.snippet ?? '', /^"Label": \{/);
			assert.equal(inside?.insert, undefined, 'inside a selector the name alone is right');
		});

		it('should replace nothing but the cursor when it writes a whole rule', async () => {
			const text = '".a": {}\n\n|\n';
			const label = (await completionsAt(text)).find(completion => completion.label === 'Label');

			assert.deepEqual(label?.range, { start: text.indexOf('|'), end: text.indexOf('|') });
		});

		it('should not offer selectors inside a rule, where properties belong', async () => {
			// the top level answer must not leak into a body, which answers properties
			const labels = await labelsAt('"Label": {\n\t|\n}\n');

			assert.ok(!labels.includes('Label'), 'a tag is not a property');
			assert.ok(labels.includes('color'), 'properties are what belong there');
		});

		it('should offer nothing at top level in a classic project', async () => {
			// a classic project has no views to read classes and ids from, and no Alloy at all
			assert.deepEqual(await labelsAt('|', { fixture: 'classic-project' }), []);
		});

		it('should offer the classes of every view in app.tss, the widgets\' included', async () => {
			// thirdClass is in index.xml, testClass in sample.xml
			const labels = await labelsAt('"|"', { style: path.join('styles', 'app.tss') });

			assert.ok(labels.includes('.thirdClass'));
			assert.ok(labels.includes('.testClass'));
			assert.ok(labels.includes('.widgetLabel'), 'a widget\'s class, since app.tss styles widgets too');
		});

		it('should offer a theme\'s stylesheet the ids of the view it stands in for', async () => {
			const labels = await labelsAt('"|"', { fixture: 'alloy-themed-project', style: path.join('themes', 'dark', 'styles', 'index.tss') });

			assert.ok(labels.includes('#title'));
			assert.ok(labels.includes('.main'));
		});

		it('should offer a widget stylesheet only the widget\'s own classes', async () => {
			const labels = await labelsAt('"|"', { style: path.join('widgets', 'widget-test', 'styles', 'widget.tss') });

			assert.ok(labels.includes('.widgetLabel'));
			assert.ok(!labels.includes('.container'), 'container belongs to an app view');
		});
	});

	describe('property names', () => {

		it('should offer a tag rule the writable properties of its type', async () => {
			const labels = await labelsAt('"Label": {\n\t|\n}');

			assert.ok(labels.includes('text'));
			assert.ok(labels.includes('font'));
			assert.ok(!labels.includes('add'), 'a method is not a property');
			assert.ok(!labels.includes('lineCount'), 'a readonly property cannot be set');
		});

		it('should offer a class rule the properties of the elements that carry the class', async () => {
			// container is on a Window, which has a title and no text
			const labels = await labelsAt('".container": {\n\t|\n}');

			assert.ok(labels.includes('title'));
			assert.ok(!labels.includes('text'));
		});

		it('should offer an id rule the properties of the element with the id', async () => {
			const labels = await labelsAt('"#label": {\n\t|\n}');

			assert.ok(labels.includes('text'));
			assert.ok(!labels.includes('title'));
		});

		it('should offer a rule for the view\'s own name the properties of the top level element it names', async () => {
			// Alloy gives a top level element with no id the view's name, so "#index" styles the Window
			const labels = await labelsAt('"#index": {\n\t|\n}', { view: '<Alloy><Window><Label/></Window></Alloy>' });

			assert.ok(labels.includes('title'));
			assert.ok(!labels.includes('text'), 'the Label is not the top level element');
		});

		it('should offer a class on several types the properties of each, naming which', async () => {
			const found = await completionsAt('".shared": {\n\t|\n}', {
				view: '<Alloy><Window><Label class="shared"/><ImageView class="shared"/></Window></Alloy>'
			});
			const byLabel = new Map(found.map(completion => [ completion.label, completion ]));

			assert.equal(byLabel.get('text')?.detail, 'string — Label');
			assert.equal(byLabel.get('image')?.detail, 'string — ImageView');
			assert.equal(byLabel.get('width')?.detail, 'string | number — Label, ImageView');
		});

		it('should give a rule that styles one type each property\'s own type, rather than repeating the one type', async () => {
			const found = await completionsAt('"Label": {\n\t|\n}');

			assert.equal(found.find(completion => completion.label === 'font')?.detail, 'Font');
		});

		it('should offer a comma separated key the properties of every part', async () => {
			// container is on a Window and label on a Label
			const labels = await labelsAt('".container, #label": {\n\t|\n}');

			assert.ok(labels.includes('title'), 'from the Window');
			assert.ok(labels.includes('text'), 'from the Label');
		});

		it('should offer nothing for a class nothing carries', async () => {
			// what a class styles is what carries it, and nothing does yet
			assert.deepEqual(await labelsAt('".nothingHasThis": {\n\t|\n}'), []);
		});

		it('should not offer a property the rule already sets, except the one being typed', async () => {
			const labels = await labelsAt('"Label": {\n\tcolor: "red",\n\t|\n}');

			assert.ok(!labels.includes('color'));
			assert.ok((await labelsAt('"Label": {\n\tco|\n}')).includes('color'));
		});

		it('should still offer a name typed in full, which is the one under the cursor rather than a duplicate', async () => {
			assert.ok((await labelsAt('"Label": {\n\tcolor|\n}')).includes('color'));
		});

		it('should replace the name being typed', async () => {
			const text = '"Label": {\n\tco|\n}';
			const color = (await completionsAt(text)).find(completion => completion.label === 'color');

			assert.deepEqual(color?.range, { start: text.indexOf('co'), end: text.indexOf('|') });
		});

		it('should insert the colon, with a snippet form for a client that has an engine', async () => {
			const color = (await completionsAt('"Label": {\n\t|\n}')).find(completion => completion.label === 'color');

			assert.deepEqual(color?.insert, { snippet: 'color: $0', plain: 'color: ' });
		});

		it('should offer the members of a nested property\'s type inside it', async () => {
			const labels = await labelsAt('"Label": {\n\tfont: {\n\t\t|\n\t}\n}');

			assert.deepEqual(labels.sort(), [ 'fontFamily', 'fontSize' ]);
		});

		it('should offer them while one is being typed', async () => {
			assert.ok((await labelsAt('"Label": {\n\tfont: {\n\t\tfo|\n\t}\n}')).includes('fontSize'));
		});

		it('should read the nested object even when an earlier property of the same name is not one', async () => {
			// a duplicate a user is midway through replacing; the object is the one being written
			// in, so what it already sets is what is not offered again
			const labels = await labelsAt('"Label": {\n\tfont: 12,\n\tfont: {\n\t\tfontFamily: "x",\n\t\tfo|\n\t}\n}');

			assert.ok(labels.includes('fontSize'));
			assert.ok(!labels.includes('fontFamily'), 'already set in this object');
		});

		it('should read the object the cursor is in when two of the same name are objects', async () => {
			// the first font sets fontSize; the second, where the cursor is, does not
			const labels = await labelsAt('"Label": {\n\tfont: {\n\t\tfontSize: 12\n\t},\n\tfont: {\n\t\tfo|\n\t}\n}');

			assert.ok(labels.includes('fontSize'));
		});

		it('should offer nothing for a rule whose selector Alloy would reject', async () => {
			// an empty name is not a selector, and Alloy dies on one rather than styling anything
			assert.deepEqual(await labelsAt('"[platform=ios]": {\n\t|\n}'), []);
		});
	});

	describe('values', () => {

		it('should offer the constants the property takes, with their documentation', async () => {
			const found = await completionsAt('"Label": {\n\ttextAlign: |\n}');
			const center = found.find(completion => completion.label === 'Ti.UI.TEXT_ALIGNMENT_CENTER');

			assert.ok(center, `expected the alignment constants, got ${found.map(completion => completion.label).join(', ')}`);
			assert.equal(center.documentation, 'Center align text.');
		});

		it('should replace a constant being typed', async () => {
			const text = '"Label": {\n\twidth: Ti.UI.S|\n}';
			const size = (await completionsAt(text)).find(completion => completion.label === 'Ti.UI.SIZE');

			assert.deepEqual(size?.range, { start: text.indexOf('Ti.UI.S'), end: text.indexOf('|') });
		});

		it('should not offer constants inside a string, where one would be text', async () => {
			assert.deepEqual(await labelsAt('"Label": {\n\ttextAlign: "|"\n}'), []);
		});

		it('should offer image paths in a property that takes one', async () => {
			const labels = await labelsAt('"ImageView": {\n\timage: "/ima|"\n}');

			assert.ok(labels.includes('/images/logo.png'));
		});

		it('should offer the translation keys inside L()', async () => {
			assert.ok((await labelsAt('"Label": {\n\ttext: L(\'|\')\n}')).includes('welcome.title'));
		});

		it('should offer the Alloy.CFG keys', async () => {
			assert.ok((await labelsAt('"Label": {\n\ttext: Alloy.CFG.|\n}')).includes('debug'));
		});

		it('should offer no constants for a nested property, which the table does not cover', async () => {
			assert.deepEqual(await labelsAt('"Label": {\n\tfont: {\n\t\tfontSize: |\n\t}\n}'), []);
		});

		it('should answer nothing for a value with nothing to offer', async () => {
			assert.deepEqual(await labelsAt('"Label": {\n\ttext: |\n}'), []);
		});

		it('should offer true and false to a property the types say is a boolean', async () => {
			assert.deepEqual(await labelsAt('"Window": {\n\tfullscreen: |\n}'), [ 'true', 'false' ]);
			// a boolean is not text, so inside a string it is nothing
			assert.deepEqual(await labelsAt('"Window": {\n\tfullscreen: "|"\n}'), []);
		});

		it('should offer true and false to a nested boolean, read at its path', async () => {
			// backgroundGradient is a Gradient, and its backfillStart is a boolean
			assert.deepEqual(await labelsAt('"Window": {\n\tbackgroundGradient: {\n\t\tbackfillStart: |\n\t}\n}'), [ 'true', 'false' ]);
			assert.deepEqual(await labelsAt('"Window": {\n\tbackgroundGradient: {\n\t\ttype: |\n\t}\n}'), []);
		});

		it('should offer the colour names to a colour, quoted as the stylesheet quotes', async () => {
			// by name: the types say string, and every colour is named for one
			const labels = await labelsAt('"Window": {\n\tbackgroundColor: |\n}');

			assert.equal(labels.length, 24);
			assert.equal(labels[0], '"transparent"');
			assert.ok(labels.includes('"red"'));
			assert.ok((await labelsAt('\'Label\': {\n\tcolor: |\n}')).includes('\'red\''), 'expected the single quotes this stylesheet writes');
		});

		it('should offer the colour names bare inside a string, replacing what is typed', async () => {
			const text = '"Window": {\n\tbackgroundColor: "re|"\n}';
			const red = (await completionsAt(text)).find(completion => completion.label === 'red');

			assert.deepEqual(red?.range, { start: text.indexOf('re|'), end: text.indexOf('|') });
		});

		it('should offer the layouts to layout, which the types only call a string', async () => {
			assert.deepEqual(await labelsAt('"Window": {\n\tlayout: |\n}'), [ '"vertical"', '"horizontal"', '"composite"' ]);
			assert.deepEqual(await labelsAt('"Window": {\n\tlayout: "|"\n}'), [ 'vertical', 'horizontal', 'composite' ]);
		});
	});

	it('should answer selectors outside any rule, which is where a new rule starts', async () => {
		// this asserted nothing was answered here until #86. Nothing holds the offset, and a
		// selector is the only thing that can be written at the top level
		const labels = await labelsAt('"Label": {}\n|');

		assert.ok(labels.includes('Window'), 'a tag');
		assert.ok(labels.includes('.container'), 'a class from the view it styles');
	});

	it('should answer nothing in a classic project, which has no stylesheets', async () => {
		assert.deepEqual(await labelsAt('"|"', { fixture: 'classic-project', style: path.join('..', 'Resources', 'app.tss') }), []);
	});
});
