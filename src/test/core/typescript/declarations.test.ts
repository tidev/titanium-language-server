import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { SourceCache } from '../../../core/references.ts';
import { ViewDeclarations } from '../../../core/typescript/declarations.ts';
import { ProjectService } from '../../../core/typescript/host.ts';
import { ProjectDeclaration } from '../../../core/typescript/project-scope.ts';
import { ProjectTypes } from '../../../core/typescript/types.ts';
import type { TypesLocation } from '../../../core/typescript/types.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * The stubbed types the classic fixture installs, which both project types borrow here.
 *
 * Resolution has its own tests; these are about the declaration lifecycle, so the types arrive
 * already resolved rather than through npm.
 *
 * @returns {Promise<TypesLocation>} Where the stub lives
 */
async function stubTypes (): Promise<TypesLocation> {
	const project = new Project(await fixturePath('classic-project'));
	await project.load();

	const located = await new ProjectTypes().locate(project);
	assert.ok(located?.location, 'the classic fixture should carry the stubbed types');

	return located.location;
}

/**
 * A declarations owner over a fixture project
 *
 * @param name - The fixture directory name
 * @returns The owner, the service behind it, the cache they share and the project root
 */
async function owner (name: string): Promise<{
	declarations: ViewDeclarations;
	service: ProjectService;
	cache: SourceCache;
	root: string;
}> {
	const project = new Project(await fixturePath(name));
	await project.load();

	const cache = new SourceCache();
	const service = await ProjectService.create({ project, cache, types: await stubTypes() });

	// the project declaration carries the Alloy namespace `$` is typed against, so it is in scope
	// here for the same reason ProjectServices.open puts it there: without it `$` resolves to
	// nothing and these tests would be asserting against an error type
	await new ProjectDeclaration({ project, service, cache }).ensure();

	return { declarations: new ViewDeclarations({ project, service, cache }), service, cache, root: project.filePath };
}

/**
 * The names a `$.` completion offers in a controller
 *
 * @param service - The service to ask
 * @param controller - The controller to ask in
 * @param cache - The cache holding its buffer
 * @param source - What the controller says
 * @returns {string[]} The member names
 */
function membersOfDollar (service: ProjectService, controller: string, cache: SourceCache, source = '$.'): string[] {
	cache.override(controller, source);
	return service.completionsAt(controller, source.length).map(entry => entry.name);
}

/**
 * The names a completion offers, in the order a client shows them: by sort text, and by label
 * where two sort texts are the same — which is how TypeScript's own priorities are meant to be read
 *
 * @param service - The service to ask
 * @param controller - The controller to ask in
 * @param cache - The cache holding its buffer
 * @param source - What the controller says up to the cursor
 * @param after - What it says after it
 * @returns {string[]} The names, in order
 */
function inClientOrder (service: ProjectService, controller: string, cache: SourceCache, source: string, after = ''): string[] {
	cache.override(controller, source + after);
	return service.completionsAt(controller, source.length)
		.sort((a, b) => a.sortText.localeCompare(b.sortText) || a.name.localeCompare(b.name))
		.map(entry => entry.name);
}

describe('The generated $ declaration, per controller', () => {

	it('should stand the declaration at the controller path with its extension swapped', async () => {
		// the path is what every other call has to name to drop or replace it, so it is derived
		// rather than remembered
		const { declarations, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');

		assert.equal(await declarations.ensure(controller), path.join(root, 'app', 'controllers', 'index.views.d.ts'));
	});

	it('should put the view ids of that controller on $', async () => {
		const { declarations, service, cache, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');

		await declarations.ensure(controller);

		assert.ok(membersOfDollar(service, controller, cache).includes('label'), 'expected the view id to reach $');
	});

	it('should keep only one declaration in scope, so two never declare $ at once', async () => {
		// each declaration declares $, so the previous one is dropped rather than added beside:
		// two is a duplicate identifier, and the ids of the wrong view on $ besides
		const { declarations, service, cache, root } = await owner('alloy-project');
		const index = path.join(root, 'app', 'controllers', 'index.js');
		const sample = path.join(root, 'app', 'controllers', 'sample.js');

		await declarations.ensure(index);
		await declarations.ensure(sample);

		const members = membersOfDollar(service, sample, cache);

		assert.ok(members.includes('scrollView'), 'expected the ids of the controller being asked about');
		assert.ok(!members.includes('label'), 'expected the previous controller\'s ids to be gone');
	});

	it('should regenerate when the view changes rather than serving the version it first parsed', async () => {
		const { declarations, service, cache, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');
		const view = path.join(root, 'app', 'views', 'index.xml');

		await declarations.ensure(controller);
		cache.override(view, '<Alloy><Window id="renamed"/></Alloy>');
		await declarations.ensure(controller);

		const members = membersOfDollar(service, controller, cache);

		assert.ok(members.includes('renamed'), 'expected the edited view\'s ids');
		assert.ok(!members.includes('label'), 'expected the ids it no longer has to be gone');
	});

	it('should not regenerate when the view has not moved', async () => {
		// this runs on every completion, hover and definition in a controller. Regenerating puts
		// the view parse on every keystroke, and bumps the script version so TypeScript re-parses
		// the declaration behind it
		const { declarations, service, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');

		await declarations.ensure(controller);

		const generated = mock.method(service, 'setGenerated');
		await declarations.ensure(controller);

		assert.equal(generated.mock.callCount(), 0);
	});

	it('should answer nothing for a classic project, which has no $', async () => {
		const { declarations, root } = await owner('classic-project');

		assert.equal(await declarations.ensure(path.join(root, 'Resources', 'app.js')), undefined);
	});

	it('should answer nothing for a controller with no view', async () => {
		// a controller is allowed to have no view, and a declaration for a view that is not there
		// would put an empty $ in scope rather than no $ at all
		const { declarations, root } = await owner('alloy-project');

		assert.equal(await declarations.ensure(path.join(root, 'app', 'controllers', 'no-view.js')), undefined);
	});

	it('should drop the declaration in scope when it moves to a controller that has no view', async () => {
		// otherwise the previous controller's $ answers for a file it says nothing about
		const { declarations, service, cache, root } = await owner('alloy-project');
		const index = path.join(root, 'app', 'controllers', 'index.js');
		const viewless = path.join(root, 'app', 'controllers', 'no-view.js');

		await declarations.ensure(index);
		assert.equal(await declarations.ensure(viewless), undefined);

		assert.ok(!membersOfDollar(service, viewless, cache).includes('label'), 'expected the stale declaration to be gone');
	});

	it('should stand a widget controller\'s declaration beside it rather than in app/controllers', async () => {
		const { declarations, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'widgets', 'widget-test', 'controllers', 'widget.js');

		assert.equal(
			await declarations.ensure(controller),
			path.join(root, 'app', 'widgets', 'widget-test', 'controllers', 'widget.views.d.ts')
		);
	});

	it('should rank the view\'s ids ahead of what every controller has', async () => {
		// the ids are what $ is mostly for, and the only part of it specific to this controller.
		// Both sides of the intersection share TypeScript's priority, so left to it the ids sort
		// alphabetically among Alloy.Controller's members — `label` after `addClass`, `destroy`
		// and twenty others
		const { declarations, service, cache, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'sample.js');

		await declarations.ensure(controller);

		const ids = [ 'androidView', 'container', 'noexistid', 'notificationLabel', 'scrollView' ];
		const ordered = inClientOrder(service, controller, cache, '$.');

		assert.deepEqual(ordered.slice(0, ids.length), ids);
		assert.ok(ordered.includes('addClass'), 'expected Alloy.Controller\'s members after them');
	});

	it('should rank the default id the same as the ids the view writes', async () => {
		// `$.index` is the view's top level element, and as much this controller's own as any id
		const { declarations, service, cache, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');

		await declarations.ensure(controller);

		assert.deepEqual(inClientOrder(service, controller, cache, '$.').slice(0, 2), [ 'index', 'label' ]);
	});

	it('should rank them with code after the cursor, which a parser reads as part of the access', async () => {
		// `$.` above another line is `$.$` to the parser, and `$.la` is a name half typed — both
		// are still a question about the members of $
		const { declarations, service, cache, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');

		await declarations.ensure(controller);

		for (const [ before, after ] of [ [ '$.', '\n$.label.text = \'hi\';' ], [ 'foo($.la', ');' ] ]) {
			const ordered = inClientOrder(service, controller, cache, before, after);

			assert.deepEqual(ordered.slice(0, 2), [ 'index', 'label' ], `expected the ids first in ${JSON.stringify(before + after)}`);
		}
	});

	it('should leave the members of anything but $ in TypeScript\'s own order', async () => {
		// an id's members are the library's, and nothing about this controller ranks one of them
		const { declarations, service, cache, root } = await owner('alloy-project');
		const controller = path.join(root, 'app', 'controllers', 'index.js');

		await declarations.ensure(controller);
		cache.override(controller, '$.label.');

		const entries = service.completionsAt(controller, '$.label.'.length);

		assert.ok(entries.length > 0, 'expected the members of the id');
		assert.deepEqual(new Set(entries.map(entry => entry.sortText)), new Set([ entries[0].sortText ]));
		assert.ok(entries[0].sortText, 'expected TypeScript\'s sort text to be carried through');
	});
});
