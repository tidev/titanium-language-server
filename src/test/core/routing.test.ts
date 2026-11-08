import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileKind, fileRole, isTiapp, noProjectReason, noRoleReason, route } from '../../core/routing.ts';
import { Project } from '../../core/project.ts';
import { ProjectRegistry } from '../../core/registry.ts';
import { fixturePath } from '../fixtures.ts';

describe('Routing', () => {

	describe('file kind', () => {
		it('should read a VS Code language id', () => {
			assert.equal(fileKind('xml', '/a/b.xml'), 'xml');
			assert.equal(fileKind('tss', '/a/b.tss'), 'tss');
			assert.equal(fileKind('javascript', '/a/b.js'), 'javascript');
			assert.equal(fileKind('typescript', '/a/b.ts'), 'typescript');
		});

		it('should read a grammar name, case insensitively', () => {
			// Pulsar reports its grammar names rather than language ids
			assert.equal(fileKind('Alloy (TSS)', '/a/b.tss'), 'tss');
			assert.equal(fileKind('Alloy (XML)', '/a/b.xml'), 'xml');
			assert.equal(fileKind('ALLOY (XML)', '/a/b.xml'), 'xml');
		});

		it('should not read a TypeScript id as JavaScript', () => {
			assert.equal(fileKind('typescriptreact', '/a/b.tsx'), 'typescript');
			assert.equal(fileKind('javascriptreact', '/a/b.jsx'), 'javascript');
		});

		it('should fall back to the extension when the id says nothing', () => {
			// an editor that has no grammar for TSS reports it as plain text
			assert.equal(fileKind('plaintext', '/a/b.tss'), 'tss');
			assert.equal(fileKind('', '/a/b.xml'), 'xml');
			assert.equal(fileKind('', '/a/b.ts'), 'typescript');
			assert.equal(fileKind('', '/a/b.js'), 'javascript');
		});

		it('should answer unknown for anything else', () => {
			assert.equal(fileKind('json', '/a/b.json'), 'unknown');
			assert.equal(fileKind('', '/a/b'), 'unknown');
		});
	});

	describe('file role in an Alloy project', () => {
		let project: Project;

		const roleOf = async (...segments: string[]): Promise<string> =>
			fileRole(project, path.join(project.filePath, ...segments));

		it('should derive the role from the layout', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await roleOf('app', 'views', 'index.xml'), 'view');
			assert.equal(await roleOf('app', 'styles', 'index.tss'), 'style');
			assert.equal(await roleOf('app', 'controllers', 'index.js'), 'controller');
			assert.equal(await roleOf('app', 'models', 'thing.js'), 'model');
			assert.equal(await roleOf('app', 'lib', 'thing.js'), 'lib');
			assert.equal(await roleOf('app', 'alloy.js'), 'alloy');
			assert.equal(await roleOf('app', 'i18n', 'en', 'strings.xml'), 'i18n');
			assert.equal(await roleOf('tiapp.xml'), 'tiapp');
		});

		it('should derive the same roles inside a widget', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'views', 'widget.xml'), 'view');
			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'styles', 'widget.tss'), 'style');
			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'controllers', 'widget.js'), 'controller');
		});

		it('should read a theme\'s stylesheets as stylesheets, the app\'s and a widget\'s alike', async () => {
			project = new Project(await fixturePath('alloy-themed-project'));
			await project.load();

			assert.equal(await roleOf('app', 'themes', 'dark', 'styles', 'index.tss'), 'style');
			assert.equal(await roleOf('app', 'themes', 'dark', 'styles', 'ios', 'app.tss'), 'style');
			assert.equal(await roleOf('app', 'themes', 'dark', 'widgets', 'badge', 'styles', 'widget.tss'), 'style');
			assert.equal(await roleOf('app', 'styles', 'ios', 'app.tss'), 'style');
			// a theme carries assets and i18n too, which are not something this reads
			assert.equal(await roleOf('app', 'themes', 'dark', 'assets', 'logo.png'), 'unknown');
			assert.equal(await roleOf('app', 'themes', 'dark', 'config.json'), 'unknown');
		});

		it('should answer unknown for a nested view directory that is not one', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await roleOf('app', 'assets', 'test.png'), 'unknown');
			assert.equal(await roleOf('build', 'views', 'index.xml'), 'unknown');
			assert.equal(await roleOf('app', 'widgets', 'widget-test', 'widget.json'), 'unknown');
		});

		it('should answer unknown for a file outside the project', async () => {
			project = new Project(await fixturePath('alloy-project'));
			await project.load();

			assert.equal(await fileRole(project, path.join(path.dirname(project.filePath), 'elsewhere.xml')), 'unknown');
		});
	});

	describe('file role in a classic project', () => {
		it('should read Resources as source, and know nothing of Alloy', async () => {
			const project = new Project(await fixturePath('classic-project'));
			await project.load();
			const roleOf = async (...segments: string[]): Promise<string> =>
				fileRole(project, path.join(project.filePath, ...segments));

			assert.equal(await roleOf('Resources', 'app.js'), 'source');
			assert.equal(await roleOf('Resources', 'lib', 'http.js'), 'source');
			assert.equal(await roleOf('i18n', 'en', 'strings.xml'), 'i18n');
			assert.equal(await roleOf('tiapp.xml'), 'tiapp');
			// a loose file at the root is not in any of them
			assert.equal(await roleOf('README.md'), 'unknown');
			// a classic project with these directories has them by coincidence, not as Alloy
			assert.equal(await roleOf('app', 'views', 'index.xml'), 'unknown');
		});
	});

	describe('routing a document', () => {
		it('should answer the project, kind and role together', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');
			await registry.add([ root ]);

			const routed = await route(registry, path.join(root, 'app', 'views', 'index.xml'), 'Alloy (XML)');

			assert.equal(routed?.project.filePath, root);
			assert.equal(routed?.kind, 'xml');
			assert.equal(routed?.role, 'view');
		});

		it('should answer nothing for a file in no registered project', async () => {
			const registry = new ProjectRegistry();

			assert.equal(await route(registry, '/somewhere/app/views/index.xml', 'xml'), undefined);
		});
	});

	describe('why a document could not be answered for', () => {
		/**
		 * A registry with the Alloy fixture in it
		 *
		 * @returns The registry and the fixture's path
		 */
		async function withAlloy (): Promise<{ registry: ProjectRegistry; root: string }> {
			const registry = new ProjectRegistry();
			const root = await fixturePath('alloy-project');
			await registry.add([ root ]);
			return { registry, root };
		}

		it('should say when the file is outside every folder the editor opened', async () => {
			const { registry, root } = await withAlloy();

			const reason = noProjectReason(registry, path.join(path.sep, 'elsewhere', 'index.tss'), [ root ]);

			assert.match(reason, /not inside any folder the editor opened/);
		});

		it('should say when the folder holds no registered project at all', async () => {
			// the scan depth is deliberate, so the answer is to open the project's own folder
			const registry = new ProjectRegistry();
			const root = await fixturePath('not-a-project');
			await registry.add([ root ]);

			const reason = noProjectReason(registry, path.join(root, 'app', 'styles', 'index.tss'), [ root ]);

			assert.match(reason, /No Titanium project is registered under/);
			assert.match(reason, /directly inside/);
			assert.match(reason, /sdk-version/);
		});

		it('should name the projects there are when the file is in none of them', async () => {
			// a workspace folder holding a project beside something that is not one
			const fixtures = path.dirname(await fixturePath('alloy-project'));
			const registry = new ProjectRegistry();
			await registry.add([ fixtures ]);

			const reason = noProjectReason(registry, path.join(fixtures, 'not-a-project', 'index.tss'), [ fixtures ]);

			assert.match(reason, /not inside any of the projects registered under/);
			assert.match(reason, /alloy-project/, 'should name what is registered, so the user can see the difference');
		});

		it('should say a classic project gives a stylesheet no Alloy role', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('classic-project');
			await registry.add([ root ]);
			const routed = await route(registry, path.join(root, 'Resources', 'app.tss'), 'tss');

			assert.match(await noRoleReason(routed!), /is a classic project/);
			assert.match(await noRoleReason(routed!), /Alloy/);
		});

		it('should say a stylesheet is outside app/styles, and where else Alloy looks', async () => {
			const { registry, root } = await withAlloy();
			const routed = await route(registry, path.join(root, 'app', 'assets', 'index.tss'), 'tss');

			const reason = await noRoleReason(routed!);

			assert.match(reason, /stylesheet outside app\/styles/);
			assert.match(reason, /app\/widgets/, 'a widget\'s stylesheets are somewhere else again');
			assert.match(reason, /app\/themes/);
		});

		it('should say a view is outside app/views', async () => {
			const { registry, root } = await withAlloy();
			const routed = await route(registry, path.join(root, 'app', 'assets', 'index.xml'), 'xml');

			assert.match(await noRoleReason(routed!), /view outside app\/views/);
		});

		it('should say a translation file is read rather than answered for', async () => {
			const { registry, root } = await withAlloy();
			const routed = await route(registry, path.join(root, 'app', 'i18n', 'en', 'strings.xml'), 'json');

			assert.equal(routed?.role, 'i18n');
			assert.match(await noRoleReason(routed), /translation file/);
		});

		it('should name the kind and the role for anything else', async () => {
			const { registry, root } = await withAlloy();
			const routed = await route(registry, path.join(root, 'app', 'assets', 'logo.png'), 'png');

			const reason = await noRoleReason(routed!);

			assert.match(reason, /no language the server recognises/, 'a png is not a language it has an id for');
			assert.match(reason, /role "unknown"/, 'should name the role rather than say nothing');
			assert.match(reason, /an Alloy project/);
		});

		it('should name the language rather than its id', async () => {
			// "a xml file" reads as a typo, and these lines are read by people
			const { registry, root } = await withAlloy();
			const routed = await route(registry, path.join(root, 'app', 'lib', 'stray.xml'), 'xml');

			const reason = await noRoleReason(routed!);

			assert.match(reason, /is XML with the role "lib"/, reason);
		});

		it('should name a classic project as one for anything else', async () => {
			const registry = new ProjectRegistry();
			const root = await fixturePath('classic-project');
			await registry.add([ root ]);
			const routed = await route(registry, path.join(root, 'build', 'something.png'), 'png');

			assert.match(await noRoleReason(routed!), /a classic project/);
		});
	});

	describe('a tiapp.xml', () => {
		it('should be known by its name alone, in a project or not', () => {
			assert.equal(isTiapp(path.join(path.sep, 'work', 'app', 'tiapp.xml')), true);
			assert.equal(isTiapp(path.join(path.sep, 'work', 'app', 'app', 'views', 'tiapp.xml.bak')), false);
			assert.equal(isTiapp(path.join(path.sep, 'work', 'app', 'app', 'views', 'index.xml')), false);
		});
	});
});
