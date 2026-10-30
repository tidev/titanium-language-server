import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { CONSTANT_RULES } from '../../core/constants.ts';
import { styleHoverAt } from '../../core/hover.ts';
import { styleCompletionsAt } from '../../core/style.ts';
import { alloyTags, titaniumTypeOf } from '../../core/tags.ts';
import { NpmAcquirer } from '../../core/typescript/acquire.ts';
import { ProjectService } from '../../core/typescript/host.ts';
import { viewCompletionsAt } from '../../core/view.ts';
import { parseXml } from '../../core/xml.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * The type reader against the real `@types/titanium`, rather than the stub.
 *
 * The stub under `classic-project` mirrors the published package's shape and not its edge cases,
 * so a reader can be green against it and wrong against a user's project. Every item below is
 * something no fixture written by hand could reach. It lives in the e2e tier because it fetches
 * the package from the registry.
 *
 * Pinned to one release rather than the newest, so that an upstream publish changes what this
 * checks only when someone moves the pin — and reads the new answers when they do.
 */
const VERSION = '13.3.0';

/** Fetching and parsing a 2.3MB declaration file is slow on a cold runner */
const TIMEOUT = 180_000;

/**
 * Tags that resolve to a type the package does not have, each for a reason that is not a defect.
 *
 * `Annotation` is the `ti.map` native module, which ships its own types. `AdView`,
 * `NavigationGroup` and `StatusBar` are APIs Titanium removed that Alloy's namespace table still
 * carries. A tag joining this list is a tag the server offers and nothing can describe, so the
 * list is pinned: a new entry is a finding, not noise.
 */
const UNDESCRIBED = [ 'AdView', 'Annotation', 'NavigationGroup', 'StatusBar' ];

describe(`The type reader against the real @types/titanium ${VERSION}`, { timeout: TIMEOUT }, () => {

	let cacheRoot: string;
	let service: ProjectService;
	let project: Project;
	let cache: SourceCache;

	before(async () => {
		cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-e2e-real-types-'));

		const packagePath = await new NpmAcquirer({ cacheRoot }).install(VERSION);
		assert.ok(packagePath, `could not fetch @types/titanium@${VERSION}`);

		project = new Project(await fixturePath('alloy-project'));
		await project.load();

		cache = new SourceCache();
		service = await ProjectService.create({
			project,
			cache,
			types: { packagePath, entry: path.join(packagePath, 'index.d.ts'), version: VERSION, source: 'npm' }
		});
	});

	after(async () => {
		service?.dispose();
		await fs.rm(cacheRoot, { recursive: true, force: true });
	});

	/**
	 * The attributes offered on an element written as `<Alloy><tag |/></Alloy>`
	 *
	 * @param tag - The tag
	 * @returns {Promise<string[]>} The attribute names
	 */
	async function attributesOf (tag: string): Promise<string[]> {
		const text = `<Alloy><${tag} /></Alloy>`;
		const found = await viewCompletionsAt({
			project,
			view: { path: path.join(project.filePath, 'app', 'views', 'scratch.xml'), text },
			// after the space, in the attribute area rather than at the end of the name
			offset: text.indexOf(' /') + 1,
			api: service,
			cache: new SourceCache()
		});

		// an empty answer would make every "should not offer" assertion pass without testing
		// anything, which is how this helper once passed with the cursor in the wrong place
		assert.ok(found.length > 0, `expected attributes for <${tag}>`);

		return found.map(completion => completion.label);
	}

	describe('tags', () => {
		it('should find the factories, which are static methods on the value side rather than exports', () => {
			// walking symbol.exports on Ti.UI finds the classes and none of the factories
			const tags = service.titaniumTags();

			assert.ok(tags.length > 40, `expected the Ti.UI factories, got ${tags.length}`);
			for (const tag of [ 'Label', 'Window', 'ListView', 'TableView', 'ImageView' ]) {
				assert.ok(tags.includes(tag), `expected ${tag}`);
			}
		});

		it('should not offer a tag from a nested namespace that Alloy cannot write bare', () => {
			// <Snackbar/> compiles to Ti.UI.Snackbar and fails; it lives under Ti.UI.Android
			assert.ok(!service.titaniumTags().includes('Snackbar'));
		});

		it('should offer only tags that resolve to a type with members, bar the known exceptions', () => {
			// whatever a completion offers, something has to be able to write it
			const tags = [ ...new Set([ ...service.titaniumTags(), ...alloyTags() ]) ];
			const undescribed = tags.filter(tag => {
				const type = titaniumTypeOf(parseXml(`<Alloy><${tag}/></Alloy>`).elements[1]);
				return type !== undefined && service.membersOf(type).length === 0;
			});

			assert.deepEqual(undescribed.sort(), UNDESCRIBED);
		});

		it('should carry each type\'s own documentation', () => {
			assert.match(service.documentationOf('Titanium.UI.Label'), /text label/i);
		});
	});

	describe('attributes', () => {
		it('should offer a type\'s writable properties and its events', async () => {
			const attributes = await attributesOf('Label');

			assert.ok(attributes.includes('text'));
			assert.ok(attributes.includes('color'));
			assert.ok(attributes.includes('onClick'));
			assert.ok(attributes.includes('onLongpress'));
		});

		it('should leave out a member the package declares away as never', async () => {
			// Label redeclares View.add as never — 765 such redeclarations in the package
			assert.ok(!service.membersOf('Titanium.UI.Label').some(member => member.name === 'add'));
			assert.ok(!(await attributesOf('Label')).includes('add'));
		});

		it('should leave out what the platform reports rather than accepts', async () => {
			// 334 members are readonly in 13.3.0, rect and size on every view among them
			const attributes = await attributesOf('Label');

			for (const reported of [ 'rect', 'size', 'apiName', 'lineCount', 'visibleText' ]) {
				assert.ok(!attributes.includes(reported), `${reported} is readonly and should not be offered`);
			}
		});

		it('should still know a readonly member is one, for hover to say so', () => {
			const size = service.membersOf('Titanium.UI.Label').find(member => member.name === 'size');

			assert.equal(size?.readonly, true);
		});
	});

	describe('events', () => {
		it('should read a type\'s events from its event map', () => {
			const events = service.eventsOf('Titanium.UI.Label');

			assert.ok(events.includes('click'));
			assert.ok(events.includes('longpress'));
		});

		it('should document an event from its own interface, where the package puts it', () => {
			// the EventMap member is bare; Label_longpress_Event carries the comment
			const longpress = service.membersOf('Titanium.UI.LabelEventMap').find(member => member.name === 'longpress');

			assert.match(longpress?.documentation ?? '', /long press/i);
		});
	});

	describe('stylesheets', () => {
		/**
		 * The labels offered where `|` marks the cursor in `app/styles/index.tss`
		 *
		 * @param text - The stylesheet, with `|` marking the cursor
		 * @returns {Promise<string[]>} The labels
		 */
		async function styleLabelsAt (text: string): Promise<string[]> {
			const found = await styleCompletionsAt({
				project,
				style: { path: path.join(project.filePath, 'app', 'styles', 'index.tss'), text: text.replace('|', '') },
				offset: text.indexOf('|'),
				api: service,
				cache: new SourceCache()
			});
			return found.map(completion => completion.label);
		}

		it('should expand every family in the constants table to something the package declares', () => {
			// the table is transcribed by hand from the SDK's apidoc, so this is what says it has not drifted
			for (const rule of CONSTANT_RULES) {
				for (const constant of rule.constants) {
					const dot = constant.lastIndexOf('.');
					const name = constant.slice(dot + 1);
					const declared = service.constantsOf(constant.slice(0, dot)).map(member => member.name);
					const matched = name.endsWith('*')
						? declared.filter(candidate => candidate.startsWith(name.slice(0, -1)))
						: declared.filter(candidate => candidate === name);

					assert.ok(matched.length > 0, `${rule.property}: ${constant} matches nothing in ${VERSION}`);
				}
			}
		});

		it('should name only types that have the property a type-restricted rule is for', () => {
			for (const rule of CONSTANT_RULES.filter(candidate => candidate.types)) {
				for (const type of rule.types ?? []) {
					assert.ok(service.membersOf(type).some(member => member.name === rule.property), `${type} has no ${rule.property}`);
				}
			}
		});

		it('should offer a rule its type\'s writable properties, and the members of a nested one', async () => {
			const properties = await styleLabelsAt('"Label": {\n\t|\n}');
			assert.ok(properties.includes('text'));
			assert.ok(properties.includes('font'));
			assert.ok(!properties.includes('size'), 'readonly');

			const font = await styleLabelsAt('"Label": {\n\tfont: {\n\t\t|\n\t}\n}');
			assert.ok(font.includes('fontSize'));
			assert.ok(font.includes('fontFamily'));
		});

		it('should describe a property, a nested one and a constant on hover', async () => {
			const hover = async (text: string): Promise<string|undefined> => (await styleHoverAt({
				project,
				style: { path: path.join(project.filePath, 'app', 'styles', 'index.tss'), text: text.replace('|', '') },
				offset: text.indexOf('|'),
				api: service,
				cache: new SourceCache()
			}))?.signature;

			assert.equal(await hover('"Label": { co|lor: "red" }'), '(property) Titanium.UI.Label.color: string | Color');
			assert.match(await hover('"Label": { font: { font|Size: 12 } }') ?? '', /^\(property\) Titanium\.UI\.Label\.font\.fontSize: /);
			assert.equal(await hover('"Label": { width: Ti.UI.SI|ZE }'), '(constant) Titanium.UI.SIZE');
		});

		it('should offer a property the constants the apidoc says it takes', async () => {
			const values = await styleLabelsAt('"TextField": {\n\tkeyboardType: |\n}');

			assert.ok(values.includes('Ti.UI.KEYBOARD_TYPE_EMAIL'));
			assert.ok(!values.some(value => value.startsWith('Ti.UI.KEYBOARD_APPEARANCE_')));
		});
	});

	describe('script completions', () => {
		/**
		 * The entries a script offers at the end of some text
		 *
		 * @param text - What the script says, with the cursor at its end
		 * @returns The entries
		 */
		function completionsAfter (text: string): ReturnType<ProjectService['completionsAt']> {
			const file = path.join(project.filePath, 'app', 'lib', 'scratch.js');
			cache.override(file, text);
			return service.completionsAt(file, text.length);
		}

		it('should leave out every member a type declares away as never', () => {
			// five of them on Label, which has no children, and the reason the view's attributes
			// already leave them out
			const names = completionsAfter('const label = Ti.UI.createLabel();\nlabel.').map(entry => entry.name);

			assert.ok(names.includes('text'));
			for (const removed of [ 'add', 'children', 'remove', 'removeAllChildren', 'replaceAt' ]) {
				assert.ok(!names.includes(removed), `${removed} is never on Label and should not be offered`);
			}
		});

		it('should mark what the package deprecates', () => {
			const entries = completionsAfter('Ti.UI.');

			assert.equal(entries.find(entry => entry.name === 'ATTRIBUTE_LINE_BREAK')?.deprecated, true);
			assert.equal(entries.find(entry => entry.name === 'SIZE')?.deprecated, false);
		});
	});
});
