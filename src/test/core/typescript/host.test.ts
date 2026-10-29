import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { SourceCache } from '../../../core/references.ts';
import { ProjectService } from '../../../core/typescript/host.ts';
import { GeneratedMapping } from '../../../core/typescript/mapping.ts';
import type { PositionMap } from '../../../core/typescript/mapping.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * Loads a fixture project
 *
 * @param name - The fixture directory name
 * @returns {Promise<Project>} The loaded project
 */
async function project (name: string): Promise<Project> {
	const loaded = new Project(await fixturePath(name));
	await loaded.load();
	return loaded;
}

/**
 * The stubbed types the classic fixture installs, which both project types borrow here.
 *
 * Resolution order has its own tests; these are about the host, so the types are handed to it
 * already resolved rather than resolved again through npm.
 *
 * @returns {Promise<TypesLocation>} Where the stub lives
 */
async function stubTypes (): Promise<TypesLocation> {
	const located = await new ProjectTypes().locate(await project('classic-project'));
	assert.ok(located?.location, 'the classic fixture should carry the stubbed types');
	return located.location;
}

/**
 * A service over a fixture project
 *
 * @param name - The fixture directory name
 * @param options - Pass `withoutTypes` for the case where nothing resolved, and `alloyBuiltins`
 *   for where Alloy's builtins are
 * @returns The service and the cache behind it
 */
async function serviceFor (name: string, options: { withoutTypes?: boolean; alloyBuiltins?: string } = {}): Promise<{ service: ProjectService; cache: SourceCache; root: string }> {
	const loaded = await project(name);
	const cache = new SourceCache();
	const service = await ProjectService.create({
		project: loaded,
		cache,
		types: options.withoutTypes ? undefined : await stubTypes(),
		alloyBuiltins: options.alloyBuiltins
	});
	return { service, cache, root: loaded.filePath };
}

describe('The TypeScript language service host', () => {

	describe('a classic project', () => {
		it('should answer hover on a Titanium call', async () => {
			const { service, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			// `const window = Ti.UI.createWindow({...})` — the offset of `createWindow`
			const text = 'const window = Ti.UI.createWindow';

			const info = service.quickInfoAt(file, sourceOffset(await read(file), text) + text.length - 1);

			assert.ok(info, 'expected hover to answer');
			assert.match(info.text, /createWindow/);
			assert.match(info.text, /Window/);

			service.dispose();
		});

		it('should answer hover on a member of a local, which is the largest single gain', async () => {
			// `const win = Ti.UI.createWindow(); win.` is structurally impossible to answer without
			// a type system, and is the reason the whole engine exists
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.title';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.ok(info, 'expected hover on the member to answer');
			assert.match(info.text, /title/);
			assert.match(info.text, /string/);

			service.dispose();
		});

		it('should not offer the identifiers in the file as members of a type', async () => {
			// in a JavaScript file TypeScript adds every identifier it can see as a `warning` entry
			// — its guess at what half-typed text might have meant. They are not members, and a
			// classic project is all JavaScript, so offering them puts every local in the file in
			// front of the user on every dot
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const banana = 1;\nconst win = Ti.UI.createWindow();\nwin.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('title'), 'expected the real members');
			assert.ok(!names.includes('banana'), 'expected a local in the file not to be a member of a Window');
			assert.ok(!names.includes('win'), 'expected the variable itself not to be a member of its own type');
			assert.ok(!names.includes('Ti'), 'expected a global not to be a member of a Window');

			service.dispose();
		});

		it('should resolve a require against Resources rather than app/lib', async () => {
			// classic and Alloy differ here, and the host takes the answer from the project rather
			// than assuming one
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const http = require(\'lib/http\');\nhttp';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.ok(info, 'expected the required module to resolve');

			service.dispose();
		});
		it('should resolve a require with a leading slash against Resources too', async () => {
			// Titanium reads a leading slash as the source root rather than the file system's, and
			// classic code writes require('/lib/http') at least as often as without it
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const http = require(\'/lib/http\');\nhttp.noop';
			cache.override(file, text);

			const found = service.definitionsAt(file, text.length - 1);

			assert.deepEqual(found.map(location => location.path), [ path.join(root, 'Resources', 'lib', 'http.js') ]);

			service.dispose();
		});
	});

	describe('an Alloy project', () => {
		it('should resolve a require against app/lib rather than Resources', async () => {
			// the mirror of the classic case above, and the reason the host takes the source path
			// from the project rather than assuming one: the same specifier means a different file
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const custom = require(\'folder/custom-view\');\ncustom.createCustomView';
			cache.override(file, text);

			const found = service.definitionsAt(file, text.length - 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, path.join(root, 'app', 'lib', 'folder', 'custom-view.js'));

			service.dispose();
		});

		it('should resolve a require with a leading slash against app/lib too', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const custom = require(\'/folder/custom-view\');\ncustom.createCustomView';
			cache.override(file, text);

			const found = service.definitionsAt(file, text.length - 1);

			assert.deepEqual(found.map(location => location.path), [ path.join(root, 'app', 'lib', 'folder', 'custom-view.js') ]);

			service.dispose();
		});

		describe('Alloy\'s builtins', () => {
			// require('alloy/animation') names a file Alloy copies in at compile time, so it is
			// nowhere in the project; TypeScript reads Alloy's own source for it instead

			const builtins = async (): Promise<string> => path.join(await fixturePath('alloy-typed-project'), 'node_modules', 'alloy', 'Alloy', 'builtins');

			it('should type a builtin from Alloy\'s source, with or without the leading slash', async () => {
				const { service, cache, root } = await serviceFor('alloy-project', { alloyBuiltins: await builtins() });
				const file = path.join(root, 'app', 'controllers', 'scratch.js');

				for (const specifier of [ 'alloy/animation', '/alloy/animation' ]) {
					const text = `const animation = require('${specifier}');\nanimation.fadeIn`;
					cache.override(file, text);

					const info = service.quickInfoAt(file, text.length - 1);

					assert.match(info?.text ?? '', /fadeIn: \(to: Titanium\.UI\.View, duration: number, finishCallback\?: \(\) => any\) => void/, specifier);
					assert.deepEqual(service.completionsAt(file, text.length - 'fadeIn'.length).map(entry => entry.name).sort(), [ 'HORIZONTAL', 'fadeIn', 'flip' ], specifier);
				}

				service.dispose();
			});

			it('should resolve an import the same way, which is what Alloy\'s Babel turns into a require', async () => {
				// TypeScript resolves both through the same hook, so the slash and the builtins hold for
				// default, namespace and named imports alike
				const { service, cache, root } = await serviceFor('alloy-project', { alloyBuiltins: await builtins() });
				const file = path.join(root, 'app', 'controllers', 'scratch.js');

				for (const head of [ 'import animation from \'/alloy/animation\';', 'import * as animation from \'alloy/animation\';' ]) {
					const text = `${head}\nanimation.`;
					cache.override(file, text);

					assert.deepEqual(service.completionsAt(file, text.length).map(entry => entry.name).sort(), [ 'HORIZONTAL', 'fadeIn', 'flip' ], head);
				}

				const named = 'import { createCustomView } from \'/folder/custom-view\';\ncreateCustomView';
				cache.override(file, named);
				assert.deepEqual(service.definitionsAt(file, named.length - 1).map(location => location.path), [ path.join(root, 'app', 'lib', 'folder', 'custom-view.js') ]);

				service.dispose();
			});

			it('should show the description Alloy writes under @method', async () => {
				// JSDuck names the method in the tag and describes it beneath, which TypeScript files
				// as the tag's text and leaves the documentation empty
				const { service, cache, root } = await serviceFor('alloy-project', { alloyBuiltins: await builtins() });
				const file = path.join(root, 'app', 'controllers', 'scratch.js');
				const text = 'const animation = require(\'alloy/animation\');\nanimation.fadeIn';
				cache.override(file, text);

				assert.equal(service.quickInfoAt(file, text.length - 1)?.documentation, 'Fades in the specified view.');
				assert.equal(service.completionDetail(file, text.length - 'fadeIn'.length, 'fadeIn')?.documentation, 'Fades in the specified view.');

				service.dispose();
			});

			it('should prefer a file of the same name in the project\'s own lib', async () => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-own-alloy-'));
				await fs.cp(await fixturePath('alloy-project'), root, { recursive: true });
				await fs.mkdir(path.join(root, 'app', 'lib', 'alloy'));
				await fs.writeFile(path.join(root, 'app', 'lib', 'alloy', 'animation.js'), 'exports.mine = 1;');
				const loaded = new Project(root);
				await loaded.load();
				const cache = new SourceCache();
				const service = await ProjectService.create({ project: loaded, cache, types: await stubTypes(), alloyBuiltins: await builtins() });

				try {
					const file = path.join(root, 'app', 'controllers', 'scratch.js');
					const text = 'const animation = require(\'alloy/animation\');\nanimation.';
					cache.override(file, text);

					assert.deepEqual(service.completionsAt(file, text.length).map(entry => entry.name), [ 'mine' ]);
				} finally {
					service.dispose();
					await fs.rm(root, { recursive: true, force: true });
				}
			});

			it('should leave a builtin unresolved when there is no Alloy to read', async () => {
				const { service, cache, root } = await serviceFor('alloy-project');
				const file = path.join(root, 'app', 'controllers', 'scratch.js');
				const text = 'const animation = require(\'alloy/animation\');\nanimation.';
				cache.override(file, text);

				assert.deepEqual(service.completionsAt(file, text.length), []);

				service.dispose();
			});
		});

		it('should answer hover in a controller', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const label = Ti.UI.createLabel();\nlabel.text';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.ok(info, 'expected hover to answer in an Alloy controller');
			assert.match(info.text, /text/);

			service.dispose();
		});

		it('should carry the JSDoc through, which is what makes hover worth showing', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const label = Ti.UI.createLabel();\nlabel.text';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.match(info?.documentation ?? '', /The text to display/);

			service.dispose();
		});
	});

	describe('the overlay', () => {
		it('should answer about the buffer rather than the file on disk', async () => {
			// a host that reads getScriptSnapshot from disk answers about the saved file, so every
			// result is one keystroke stale and it reads as flakiness rather than as a bug
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			cache.override(file, 'const label = Ti.UI.createLabel();\nlabel.color');

			const info = service.quickInfoAt(file, 'const label = Ti.UI.createLabel();\nlabel.color'.length - 1);

			assert.ok(info, 'expected the buffer to be read');
			assert.match(info.text, /color/, 'app.js on disk has no `color`, so this can only have come from the buffer');

			service.dispose();
		});

		it('should answer freshly after an edit', async () => {
			// if getScriptVersion does not move when the buffer does, the service serves the first
			// answer forever
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');

			cache.override(file, 'const win = Ti.UI.createWindow();\nwin.title');
			const first = service.quickInfoAt(file, 'const win = Ti.UI.createWindow();\nwin.title'.length - 1);

			cache.override(file, 'const view = Ti.UI.createImageView();\nview.image');
			const second = service.quickInfoAt(file, 'const view = Ti.UI.createImageView();\nview.image'.length - 1);

			assert.match(first?.text ?? '', /title/);
			assert.match(second?.text ?? '', /image/, 'the second answer should describe the edited buffer');

			service.dispose();
		});

		it('should go back to the file on disk once the buffer is dropped', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			cache.override(file, 'const label = Ti.UI.createLabel();\nlabel.color');
			service.quickInfoAt(file, 10);
			cache.forget(file);

			const text = 'const window = Ti.UI.createWindow';
			const info = service.quickInfoAt(file, sourceOffset(await read(file), text) + text.length - 1);

			assert.match(info?.text ?? '', /createWindow/, 'should be answering about the saved file again');

			service.dispose();
		});
	});

	describe('answering nothing', () => {
		it('should answer nothing when no types resolved', async () => {
			// the failure case is a feature: answer nothing rather than from a stale or wrong copy
			const { service, cache, root } = await serviceFor('classic-project', { withoutTypes: true });
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.createWindow');

			assert.equal(service.quickInfoAt(file, 17), undefined);

			service.dispose();
		});

		it('should answer nothing for a position with nothing under it', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, '   \n   ');

			assert.equal(service.quickInfoAt(file, 1), undefined);

			service.dispose();
		});

		it('should survive a half-typed file rather than throwing', async () => {
			// sample.js is deliberately not valid JavaScript; a parser that gives up on it takes
			// every completion in the file with it
			const { service, root } = await serviceFor('alloy-project');

			assert.doesNotThrow(() => service.quickInfoAt(path.join(root, 'app', 'controllers', 'sample.js'), 3));

			service.dispose();
		});

		it('should answer nothing for a file outside the project', async () => {
			const { service } = await serviceFor('classic-project');

			assert.equal(service.quickInfoAt(path.join('/somewhere', 'else.js'), 0), undefined);

			service.dispose();
		});
	});

	describe('warming', () => {
		it('should build the program before the first request', async () => {
			// 623ms of cold parse landing on the first keystroke is the thing this avoids
			const { service } = await serviceFor('classic-project');

			service.warm();

			assert.equal(service.warmed, true);

			service.dispose();
		});

		it('should not warm when there are no types to parse', async () => {
			const { service } = await serviceFor('classic-project', { withoutTypes: true });

			service.warm();

			assert.equal(service.warmed, false);

			service.dispose();
		});
	});

	describe('completions', () => {
		it('should complete a namespace the types declare', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('createWindow'), 'expected createWindow among the completions');
			assert.ok(names.includes('createLabel'), 'expected createLabel among the completions');

			service.dispose();
		});

		it('should complete a member of a local, inherited members included', async () => {
			// the same reason hover on a member matters: nothing but a type system can answer it, and
			// Label gets backgroundColor from View rather than declaring it
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const label = Ti.UI.createLabel();\nlabel.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('text'), 'expected the type\'s own member');
			assert.ok(names.includes('backgroundColor'), 'expected a member inherited from View');

			service.dispose();
		});

		it('should say what kind each completion is', async () => {
			// a client renders a method and a property differently, and the name alone cannot tell
			// them apart, so the kind comes from the type
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.';
			cache.override(file, text);

			const entries = service.completionsAt(file, text.length);

			assert.equal(entries.find(entry => entry.name === 'open')?.kind, 'method');
			assert.equal(entries.find(entry => entry.name === 'title')?.kind, 'property');

			service.dispose();
		});

		it('should leave out a member the type declares away as never, for both project types', async () => {
			// Label redeclares View.add as never, because a label has no children. Offering it is
			// offering something that cannot be written, and the view's attributes already leave it out
			for (const [ fixture, directory ] of [ [ 'classic-project', 'Resources' ], [ 'alloy-project', path.join('app', 'lib') ] ] as const) {
				const { service, cache, root } = await serviceFor(fixture);
				const file = path.join(root, directory, 'scratch.js');
				const text = 'const label = Ti.UI.createLabel();\nlabel.';
				cache.override(file, text);

				const names = service.completionsAt(file, text.length).map(entry => entry.name);

				assert.ok(names.includes('text'), `expected the rest of the members in ${fixture}`);
				assert.ok(!names.includes('add'), `expected add to be left out in ${fixture}`);

				service.dispose();
			}
		});

		it('should say which completions are deprecated', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.';
			cache.override(file, text);

			const entries = service.completionsAt(file, text.length);

			assert.equal(entries.find(entry => entry.name === 'ATTRIBUTE_LINE_BREAK')?.deprecated, true);
			assert.equal(entries.find(entry => entry.name === 'SIZE')?.deprecated, false);

			service.dispose();
		});

		it('should answer the JSDoc for one completion, rather than for all of them', async () => {
			// a client asks for this when an item is highlighted, so resolving every entry up front
			// would pay for documentation nobody reads
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.';
			cache.override(file, text);

			const detail = service.completionDetail(file, text.length, 'createLabel');

			assert.match(detail?.documentation ?? '', /Creates a label/);
			assert.match(detail?.text ?? '', /createLabel/);

			service.dispose();
		});

		it('should answer no detail for an entry that is not in the list', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.');

			assert.equal(service.completionDetail(file, 6, 'noSuchEntry'), undefined);

			service.dispose();
		});

		it('should complete in an Alloy controller', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.';
			cache.override(file, text);

			const names = service.completionsAt(file, text.length).map(entry => entry.name);

			assert.ok(names.includes('open'), 'expected the Window members in a controller');

			service.dispose();
		});

		it('should answer nothing when no types resolved', async () => {
			const { service, cache, root } = await serviceFor('classic-project', { withoutTypes: true });
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.');

			assert.deepEqual(service.completionsAt(file, 6), []);
			assert.equal(service.completionDetail(file, 6, 'createLabel'), undefined);

			service.dispose();
		});

		it('should answer nothing for a file outside the project', async () => {
			const { service } = await serviceFor('classic-project');

			assert.deepEqual(service.completionsAt(path.join(path.sep, 'nowhere', 'x.js'), 0), []);

			service.dispose();
		});

		it('should survive a half-typed file rather than throwing', async () => {
			// this is the state every completion is actually requested in
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'const win = Ti.UI.createWindow(\nwin.');

			assert.doesNotThrow(() => service.completionsAt(file, 36));

			service.dispose();
		});
	});

	describe('definitions', () => {
		it('should find a local declaration in the same file', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.open();';
			cache.override(file, text);

			const found = service.definitionsAt(file, sourceOffset(text, 'win.open') + 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, file);
			assert.equal(text.slice(found[0].range.start, found[0].range.end), 'win');

			service.dispose();
		});

		it('should cross a require boundary, resolved the way the project resolves it', async () => {
			// classic resolves against Resources, so this lands in Resources/lib/http.js
			const { service, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			const source = await read(file);

			const found = service.definitionsAt(file, sourceOffset(source, 'http.noop') + 'http.'.length + 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, path.join(root, 'Resources', 'lib', 'http.js'));

			service.dispose();
		});

		it('should point into the type definitions for a Titanium API', async () => {
			const { service, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			const source = await read(file);

			const found = service.definitionsAt(file, sourceOffset(source, 'Ti.UI.createWindow') + 'Ti.UI.'.length + 1);

			assert.equal(found.length, 1);
			assert.match(found[0].path, /@types[\\/]titanium[\\/]index\.d\.ts$/);

			service.dispose();
		});

		it('should answer nothing when no types resolved', async () => {
			const { service, root } = await serviceFor('classic-project', { withoutTypes: true });

			assert.deepEqual(service.definitionsAt(path.join(root, 'Resources', 'app.js'), 0), []);

			service.dispose();
		});

		it('should answer nothing where there is nothing to point at', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, '// just a comment\n');

			assert.deepEqual(service.definitionsAt(file, 3), []);

			service.dispose();
		});
	});

	describe('file names', () => {
		it('should answer about a file however its path is spelled', async () => {
			// TypeScript normalises paths internally and hands them back its way — forward slashes,
			// even on Windows — while the cache is keyed on the path the caller built. Every lookup
			// in the host has to normalise or a buffer that exists only in the overlay is invisible,
			// which is a Windows-only failure the suite would otherwise never see.
			const { service, cache, root } = await serviceFor('classic-project');
			const canonical = path.join(root, 'Resources', 'scratch.js');
			// forward slashes, which is exactly what TypeScript hands back. On POSIX this is the
			// same string and the test is vacuous; on Windows it is the failure, so CI is where it
			// asserts anything — the same posture as the npm symlink test.
			const spelled = canonical.split(path.sep).join('/');
			cache.override(canonical, 'const win = Ti.UI.createWindow();\nwin.title');

			assert.ok(service.quickInfoAt(spelled, 42), 'expected the same file to answer either way');

			service.dispose();
		});

		it('should answer paths in the platform\'s own form', async () => {
			// what comes back is compared against paths a caller built with path.join, and on
			// Windows TypeScript would answer with forward slashes
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.open();';
			cache.override(file, text);

			const found = service.definitionsAt(file, sourceOffset(text, 'win.open') + 1);

			assert.equal(found[0]?.path, file);

			service.dispose();
		});
	});

	describe('generated content', () => {
		/**
		 * A `$` declaration of the shape a view generates, with `label` mapped back to where the
		 * view declares that id and everything else deliberately mapping nowhere
		 *
		 * @param root - The project root
		 * @returns The generated file's path, its text and the mapping back to the view
		 */
		async function declaration (root: string): Promise<{ file: string; text: string; map: PositionMap; view: string }> {
			const view = path.join(root, 'app', 'views', 'index.xml');
			const text = 'interface IndexViews {\n\tlabel: Titanium.UI.Label;\n}\ndeclare const $: IndexViews;\n';

			return {
				file: path.join(root, 'app', 'controllers', 'index.views.d.ts'),
				text,
				view,
				map: new GeneratedMapping(view, [ {
					generated: { start: sourceOffset(text, 'label'), length: 'label'.length },
					source: { start: sourceOffset(await read(view), 'label') }
				} ])
			};
		}

		it('should point at the view rather than at the file it generated', async () => {
			// the payoff for the whole mapping design: an editor lands in index.xml on the id, not in
			// a .d.ts that exists nowhere on disk
			const { service, cache, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			const source = '$.label;';
			cache.override(controller, source);

			const found = service.definitionsAt(controller, sourceOffset(source, 'label') + 1);

			assert.equal(found.length, 1);
			assert.equal(found[0].path, generated.view);
			assert.equal((await read(generated.view)).slice(found[0].range.start, found[0].range.end), 'label');

			service.dispose();
		});

		it('should answer nothing rather than pointing inside the scaffolding', async () => {
			// `interface IndexViews {` came from nowhere the user wrote, so there is no honest answer.
			// Nothing should ask about the generated file, and if something does it must not be told
			// a position in it.
			const { service, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const info = service.quickInfoAt(generated.file, sourceOffset(generated.text, 'IndexViews') + 1);

			assert.equal(info, undefined);

			service.dispose();
		});

		it('should read the replacement after the content is generated again', async () => {
			// a view changes, the declaration is regenerated, and the service must not serve the old one
			const { service, cache, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.');
			assert.ok(service.completionsAt(controller, 2).some(entry => entry.name === 'label'));

			const renamed = 'interface IndexViews {\n\theading: Titanium.UI.Label;\n}\ndeclare const $: IndexViews;\n';
			service.setGenerated(generated.file, renamed, new GeneratedMapping(generated.view, []));

			const names = service.completionsAt(controller, 2).map(entry => entry.name);
			assert.ok(names.includes('heading'), 'expected the regenerated member');
			assert.ok(!names.includes('label'), 'expected the old member to be gone');

			service.dispose();
		});

		it('should stop answering once the generated content is dropped', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const generated = await declaration(root);
			service.setGenerated(generated.file, generated.text, generated.map);

			const controller = path.join(root, 'app', 'controllers', 'scratch.js');
			cache.override(controller, '$.');
			assert.ok(service.completionsAt(controller, 2).some(entry => entry.name === 'label'));

			service.dropGenerated(generated.file);

			assert.ok(!service.completionsAt(controller, 2).some(entry => entry.name === 'label'));

			service.dispose();
		});
	});

	describe('positions', () => {
		it('should answer a range in the source file', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();\nwin.title';
			cache.override(file, text);

			const info = service.quickInfoAt(file, text.length - 1);

			assert.equal(info?.path, file);
			assert.equal(text.slice(info?.range.start, info?.range.end), 'title');

			service.dispose();
		});
	});

	describe('the Titanium API it can describe', () => {

		// what a view needs to offer tag and attribute completions, asked of the project's own
		// types rather than of a separate data file. The stub declares its factories as namespace
		// functions and the real package declares them as statics on a merged class; the lookup
		// asks for the value type either way, so neither shape needs its own path here

		it('should name the tags the Titanium API can create', async () => {
			const { service } = await serviceFor('classic-project');

			const tags = service.titaniumTags();

			assert.ok(tags.includes('Label'), 'expected a tag from a createX factory');
			assert.ok(tags.includes('Window'));
			assert.ok(!tags.includes('View') === false, 'expected View, which has a factory too');
			service.dispose();
		});

		it('should not name a tag that only a nested platform namespace can create', async () => {
			// Alloy resolves a bare tag with IMPLICIT_NAMESPACES[name] || 'Ti.UI', so a tag that is
			// only in Ti.UI.iPad compiles to Ti.UI.<name> and fails. The tags that do reach another
			// namespace are in Alloy's own table, which alloyTags answers — offering them from here
			// would be offering markup the compiler rejects
			const { service } = await serviceFor('classic-project');

			assert.ok(!service.titaniumTags().includes('SplitWindow'), 'Ti.UI.iPad is not the default namespace');
			service.dispose();
		});

		it('should not name a class that has no factory', async () => {
			// a tag is something Alloy can construct. ListItem and Clipboard are real Titanium types
			// that no createX builds — the published package has six such classes in Ti.UI alone
			const { service } = await serviceFor('classic-project');

			const tags = service.titaniumTags();

			assert.ok(!tags.includes('ListItem'), 'a type with no factory is not a tag');
			assert.ok(!tags.includes('Clipboard'));
			service.dispose();
		});

		it('should name every tag after something, rather than after a sliced prefix', async () => {
			// the guard on the rule above: taking `create` off a name that never had it yields a
			// truncation, and an empty string for anything shorter than the prefix
			const { service } = await serviceFor('classic-project');

			const tags = service.titaniumTags();

			assert.ok(tags.length > 0, 'expected some tags to check');
			assert.ok(tags.every(tag => /^[A-Z]/.test(tag)), `expected every tag to be a type name, got ${tags.join(', ')}`);
			service.dispose();
		});

		it('should answer the members of a type, with inherited ones', async () => {
			const { service } = await serviceFor('classic-project');

			const members = service.membersOf('Titanium.UI.Label');
			const names = members.map(member => member.name);

			assert.ok(names.includes('text'), 'expected its own property');
			assert.ok(names.includes('backgroundColor'), 'expected one inherited from View');
			service.dispose();
		});

		it('should leave out a member the type declares away', async () => {
			// @types/titanium removes an inherited member by redeclaring it as never — Label does
			// this to View.add, because a label has no children, and the package does it 765 times.
			// Offering it would be offering an attribute of the one type that says it has none
			const { service } = await serviceFor('classic-project');

			const names = service.membersOf('Titanium.UI.Label').map(member => member.name);

			assert.ok(!names.includes('add'), 'Label declares add: never');
			assert.ok(names.includes('backgroundColor'), 'an inherited member it keeps is still there');
			service.dispose();
		});

		it('should say what kind each member is, so a property is told from a method', async () => {
			// an XML attribute is a property; `add` and `addEventListener` are not attributes
			const { service } = await serviceFor('classic-project');

			const members = service.membersOf('Titanium.UI.Label');
			const text = members.find(member => member.name === 'text');
			const listener = members.find(member => member.name === 'addEventListener');

			assert.equal(text?.kind, 'property');
			assert.equal(listener?.kind, 'method');
			service.dispose();
		});

		it('should say which members are read only, which a view cannot write', async () => {
			const { service } = await serviceFor('classic-project');

			const members = service.membersOf('Titanium.UI.Label');

			assert.equal(members.find(member => member.name === 'lineCount')?.readonly, true);
			assert.equal(members.find(member => member.name === 'text')?.readonly, false);
			service.dispose();
		});

		it('should render each member\'s type, which hover shows as its signature', async () => {
			const { service } = await serviceFor('classic-project');

			const members = service.membersOf('Titanium.UI.Label');

			assert.equal(members.find(member => member.name === 'text')?.type, 'string');
			assert.equal(members.find(member => member.name === 'lineCount')?.type, 'number');
			service.dispose();
		});

		it('should answer the members of a property\'s own type, for a nested TSS property', async () => {
			// `font: { fontSize }` — the members of Font, reached through Label.font
			const { service } = await serviceFor('classic-project');

			const members = service.membersOf('Titanium.UI.Label', [ 'font' ]);

			assert.deepEqual(members.map(member => member.name), [ 'fontFamily', 'fontSize' ]);
			assert.match(members[1].documentation, /Font size/);
			service.dispose();
		});

		it('should answer nothing for a path through a property that is not there, or not an object', async () => {
			const { service } = await serviceFor('classic-project');

			assert.deepEqual(service.membersOf('Titanium.UI.Label', [ 'nothing' ]), []);
			// a string has members of its own, and none of them is a TSS property
			assert.deepEqual(service.membersOf('Titanium.UI.Label', [ 'text' ]), []);
			service.dispose();
		});

		it('should answer a type asked about again from what it worked out the first time', async () => {
			// a stylesheet is checked against every element it styles, which asks after the same
			// few types thousands of times on a real project
			const { service } = await serviceFor('classic-project');

			assert.equal(service.membersOf('Titanium.UI.Label'), service.membersOf('Titanium.UI.Label'));
			assert.equal(service.membersOf('Titanium.UI.Label', [ 'font' ]), service.membersOf('Titanium.UI.Label', [ 'font' ]));
			assert.notEqual(service.membersOf('Titanium.UI.Label'), service.membersOf('Titanium.UI.Label', [ 'font' ]));
			service.dispose();
		});

		it('should work a type out again once the program has changed', async () => {
			// what a type has can change with the program, so nothing is kept past it
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'app.js');
			const before = service.membersOf('Titanium.UI.Label');

			cache.override(file, `${await read(file)}\nconst changed = 1;\n`);
			const after = service.membersOf('Titanium.UI.Label');

			assert.notEqual(after, before);
			assert.deepEqual(after, before);
			service.dispose();
		});

		it('should answer the constants a namespace declares, with their documentation', async () => {
			const { service } = await serviceFor('classic-project');

			const constants = service.constantsOf('Titanium.UI');

			assert.ok(constants.some(constant => constant.name === 'TEXT_ALIGNMENT_CENTER' && /Center align/.test(constant.documentation)));
			assert.ok(constants.some(constant => constant.name === 'SIZE'));
			assert.ok(!constants.some(constant => constant.name === 'Label'), 'a class is not a constant');
			assert.ok(!constants.some(constant => constant.name === 'createLabel'), 'nor is a factory');
			service.dispose();
		});

		it('should answer no constants for a namespace the types do not have', async () => {
			const { service } = await serviceFor('classic-project');

			assert.deepEqual(service.constantsOf('Titanium.Nothing'), []);
			service.dispose();
		});

		it('should answer the documentation of a type itself', async () => {
			const { service } = await serviceFor('classic-project');

			assert.match(service.documentationOf('Titanium.UI.Label'), /A text label/);
			service.dispose();
		});

		it('should answer no documentation for a type the project does not have', async () => {
			const { service } = await serviceFor('classic-project');

			assert.equal(service.documentationOf('Titanium.Map.Annotation'), '');
			service.dispose();
		});

		it('should answer the members of an event map, so an event carries its documentation', async () => {
			// the same reader over the interface eventsOf lists the names of — nothing new to hold
			const { service } = await serviceFor('classic-project');

			const click = service.membersOf('Titanium.UI.LabelEventMap').find(member => member.name === 'click');

			assert.match(click?.documentation ?? '', /Fired when the device detects a click/);
			service.dispose();
		});

		it('should take an event\'s documentation from its own interface, where the package puts it', async () => {
			const { service } = await serviceFor('classic-project');

			const longpress = service.membersOf('Titanium.UI.LabelEventMap').find(member => member.name === 'longpress');

			assert.equal(longpress?.documentation, 'Fired when the device detects a long press.');
			service.dispose();
		});

		it('should not take a property\'s documentation from its type', async () => {
			// only an event map's members do this: a property's type describes the type, not it
			const { service } = await serviceFor('classic-project');

			// masterView is typed View, which is documented, and has no comment of its own
			const master = service.membersOf('Titanium.UI.iPad.SplitWindow').find(member => member.name === 'masterView');

			assert.equal(master?.type, 'View');
			assert.equal(master?.documentation, '');
			service.dispose();
		});

		it('should carry the documentation, which is most of what hover and detail show', async () => {
			const { service } = await serviceFor('classic-project');

			const text = service.membersOf('Titanium.UI.Label').find(member => member.name === 'text');

			assert.match(text?.documentation ?? '', /The text to display/);
			service.dispose();
		});

		it('should answer the events of a type from its event map', async () => {
			// the same mechanism that makes addEventListener('' offer names: one EventMap per class
			const { service } = await serviceFor('classic-project');

			const events = service.eventsOf('Titanium.UI.Label');

			assert.ok(events.includes('click'));
			assert.ok(events.includes('longpress'));
			service.dispose();
		});

		it('should answer nothing for a type the project\'s types do not have', async () => {
			// a tag can name a type @types/titanium has never heard of — ti.map's proxies are not
			// in it at all — and that is an empty answer rather than a crash
			const { service } = await serviceFor('classic-project');

			assert.deepEqual(service.membersOf('Titanium.Map.Annotation'), []);
			assert.deepEqual(service.eventsOf('Titanium.Map.Annotation'), []);
			service.dispose();
		});

		it('should answer nothing at all when no types resolved', async () => {
			const { service } = await serviceFor('classic-project', { withoutTypes: true });

			assert.deepEqual(service.titaniumTags(), []);
			assert.deepEqual(service.membersOf('Titanium.UI.Label'), []);
			assert.deepEqual(service.eventsOf('Titanium.UI.Label'), []);
			assert.equal(service.documentationOf('Titanium.UI.Label'), '');
			service.dispose();
		});
	});

	describe('the string literal at a position', () => {

		it('should name the property a literal is being written into', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'\' });';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.indexOf('\'\'') + 1);

			assert.equal(found?.property, 'image');
		});

		it('should name the call a literal is an argument to, and which argument', async () => {
			// what a definition needs to follow Alloy.createWidget('w', 'controller') to a file
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'Alloy . createWidget(\'widget-test\', \'test\', { id: 1 });';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.indexOf('\'test\'') + 2);

			assert.deepEqual(found?.call, { callee: 'Alloy.createWidget', index: 1, args: [ 'widget-test', 'test', undefined ] });
		});

		it('should name no factory call when Alloy is the script\'s own name for something else', async () => {
			// a parameter called Alloy is not Alloy, however its calls are spelled
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'function load (Alloy) { Alloy.createController(\'existing-file\'); }\nAlloy.createController(\'existing-file\');';
			cache.override(file, text);

			assert.equal(service.stringLiteralAt(file, text.indexOf('existing-file') + 1)?.call, undefined);
			assert.equal(service.stringLiteralAt(file, text.lastIndexOf('existing-file') + 1)?.call?.callee, 'Alloy.createController');
		});

		it('should name no call for a literal that is not an argument', async () => {
			const { service, cache, root } = await serviceFor('alloy-project');
			const file = path.join(root, 'app', 'controllers', 'scratch.js');
			const text = 'const name = \'test\';';
			cache.override(file, text);

			assert.equal(service.stringLiteralAt(file, text.indexOf('test'))?.call, undefined);
		});

		it('should name the property of an assignment', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const v = Ti.UI.createImageView();\nv.backgroundImage = \'\';';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.lastIndexOf('\'\'') + 1);

			assert.equal(found?.property, 'backgroundImage');
		});

		it('should answer for a literal that is still being typed', async () => {
			// the unterminated quote is the normal case: it is what the buffer holds at the moment
			// the completion is asked for, and an answer only for finished strings is no answer
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'/im';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.length);

			assert.equal(found?.property, 'image');
			assert.equal(found?.text, '/im');
		});

		it('should cover the contents of the literal and not its quotes', async () => {
			// what the client replaces when the completion is accepted. A path carries slashes and
			// dots, which a client will not treat as one word, so the range has to be explicit
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'/images/lo\' });';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.indexOf('/images'));

			assert.equal(text.slice(found?.range.start, found?.range.end), '/images/lo');
		});

		it('should cover the contents of an unterminated literal up to where typing stopped', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'/im';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.length);

			assert.equal(text.slice(found?.range.start, found?.range.end), '/im');
		});

		it('should answer for a double quoted literal too', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: "/im" });';
			cache.override(file, text);

			assert.equal(service.stringLiteralAt(file, text.indexOf('/im'))?.property, 'image');
		});

		it('should say when the property\'s type cannot hold a string', async () => {
			// the stub puts preventDefaultImage: boolean on ImageView beside image, the way the real
			// package does. The name says image; the type is what says otherwise
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ preventDefaultImage: \'\' });';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.indexOf('\'\'') + 1);

			assert.equal(found?.property, 'preventDefaultImage');
			assert.equal(found?.typeExcludesString, true);
		});

		it('should say nothing of the sort where a string is what belongs', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'\' });';
			cache.override(file, text);

			assert.equal(service.stringLiteralAt(file, text.indexOf('\'\'') + 1)?.typeExcludesString, false);
		});

		it('should not call a property with no type at all an exclusion', async () => {
			// a plain object literal built up and handed over later has no contextual type, and
			// knowing nothing is not knowing it is wrong
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const options = { heroImage: \'\' };';
			cache.override(file, text);

			assert.equal(service.stringLiteralAt(file, text.indexOf('\'\'') + 1)?.typeExcludesString, false);
		});

		it('should answer with no property for a literal that is an argument', async () => {
			// require('…') is the obvious one, and offering image paths there would be nonsense
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'require(\'/http\');';
			cache.override(file, text);

			const found = service.stringLiteralAt(file, text.indexOf('/http'));

			assert.equal(found?.property, undefined);
			assert.equal(found?.text, '/http');
		});

		it('should answer nothing where the cursor is not in a literal at all', async () => {
			const { service, cache, root } = await serviceFor('classic-project');
			const file = path.join(root, 'Resources', 'scratch.js');
			const text = 'const win = Ti.UI.createWindow();';
			cache.override(file, text);

			assert.equal(service.stringLiteralAt(file, 3), undefined);
		});

		it('should answer nothing for a file it cannot answer about', async () => {
			const { service, cache, root } = await serviceFor('classic-project', { withoutTypes: true });
			const file = path.join(root, 'Resources', 'scratch.js');
			cache.override(file, 'Ti.UI.createImageView({ image: \'\' });');

			assert.equal(service.stringLiteralAt(file, 32), undefined);
		});
	});
});

/**
 * Reads a file the way the test needs it, without going through the cache under test
 *
 * @param file - The file to read
 * @returns {Promise<string>} Its contents
 */
async function read (file: string): Promise<string> {
	const { readFile } = await import('node:fs/promises');
	return readFile(file, 'utf-8');
}

/**
 * Where a snippet sits in some text, failing loudly rather than returning -1
 *
 * @param text - The text to search
 * @param needle - What to find
 * @returns {number} The offset
 */
function sourceOffset (text: string, needle: string): number {
	const offset = text.indexOf(needle);
	assert.notEqual(offset, -1, `expected to find ${JSON.stringify(needle)} in the fixture`);
	return offset;
}
