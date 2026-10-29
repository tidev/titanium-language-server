import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CompletionItemKind, CompletionItemTag, DiagnosticSeverity, TextEdit } from 'vscode-languageserver';
import type { ClientCapabilities, ClientCompletionItemOptions, CodeAction, CompletionItem } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { TiLanguageService } from '../../server/service.ts';
import { Project } from '../../core/project.ts';
import { SourceCache } from '../../core/references.ts';
import { ProjectTypes } from '../../core/typescript/types.ts';
import type { TypesSource } from '../../core/typescript/types.ts';
import type { InstalledSource } from '../../core/tiapp.ts';
import { logger } from '../../logger.ts';
import { FakeConnection } from './fake-connection.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * A source that lends every project the stub the classic fixture installs.
 *
 * The Alloy fixture deliberately carries no node_modules — that `ProjectTypes` answers nothing for
 * it is asserted elsewhere, and the warning it produces is tested here — so a test that needs an
 * Alloy project with types resolved says so rather than installing types into the fixture.
 */
const lentTypes: TypesSource = {
	name: 'the stub',
	locate: async () => new ProjectTypes().locate(new Project(await fixturePath('classic-project')))
};

/**
 * The same stub, said to be a 10.x release.
 *
 * The Alloy fixtures are on SDK 10.1.0 and the stub is 9.2.2, which is the gap DefinitelyTyped
 * leaves — and with an older major the server warns about nothing, since every property added since
 * would read as unknown. So a test of the warnings themselves needs types that cover the SDK.
 */
const matchedTypes: TypesSource = {
	name: 'the stub, as 10.x',
	locate: async project => {
		const resolved = await lentTypes.locate(project);
		return resolved?.location && { ...resolved, location: { ...resolved.location, version: '10.1.0' } };
	}
};

describe('The language service adapter', () => {

	let connection: FakeConnection;
	let service: TiLanguageService;
	let root: string;

	const uriFor = (...segments: string[]): string => URI.file(path.join(root, ...segments)).toString();

	beforeEach(async () => {
		root = await fixturePath('alloy-project');
		connection = new FakeConnection();
		// the project's own types only: the default list ends in the npm acquirer, and a test suite
		// must not reach the network to find out what it resolves
		service = new TiLanguageService(connection.asConnection(), [ new ProjectTypes() ]);
		service.listen();
	});

	afterEach(() => logger.detach());

	describe('initialize', () => {
		it('should advertise what it can do', async () => {
			const result = await connection.initialize();

			assert.equal(result.capabilities.definitionProvider, true);
			assert.notEqual(result.capabilities.textDocumentSync, undefined);
		});

		it('should record what the client can do', async () => {
			await connection.initialize({
				capabilities: {
					textDocument: {
						completion: { completionItem: { snippetSupport: true } },
						codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } }
					},
					window: { showDocument: { support: true } },
					workspace: { workspaceFolders: true }
				}
			});

			assert.equal(service.capabilities.snippets, true);
			assert.equal(service.capabilities.showDocument, true);
			assert.equal(service.capabilities.codeActionLiterals, true);
			assert.equal(service.capabilities.workspaceFolders, true);
		});

		it('should assume nothing of a client that declares nothing', async () => {
			// an editor that sends an empty capability set gets the careful path, not the VS Code
			// one — this is the case that broke the implementation being replaced
			await connection.initialize({ capabilities: {} });

			assert.equal(service.capabilities.snippets, false);
			assert.equal(service.capabilities.showDocument, false);
			assert.equal(service.capabilities.codeActionLiterals, false);
			assert.equal(service.capabilities.workspaceFolders, false);
		});

		it('should have answers before a client has said anything', async () => {
			// a request can arrive before initialize in a misbehaving client, and reading a
			// capability then must be false rather than a crash on undefined
			assert.equal(service.capabilities.snippets, false);
			assert.equal(service.capabilities.workspaceFolders, false);
		});

		it('should register the projects in the workspace folders', async () => {
			await connection.initialize({
				capabilities: { workspace: { workspaceFolders: true } },
				workspaceFolders: [ { uri: URI.file(root).toString(), name: 'alloy-project' } ]
			});

			assert.deepEqual(service.registry.projects.map(project => project.filePath), [ root ]);
		});

		it('should fall back to rootUri for a client that has no workspace folders', async () => {
			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.deepEqual(service.registry.projects.map(project => project.filePath), [ root ]);
			assert.equal(service.registry.projects.length, 1);
		});

		it('should register nothing when the client opens no folder at all', async () => {
			await connection.initialize();

			assert.deepEqual(service.registry.projects, []);
		});

		it('should start the connection and the document manager when told to listen', () => {
			assert.equal(connection.listening, true);
		});
	});

	describe('workspace folder changes', () => {
		beforeEach(async () => {
			await connection.initialize({ capabilities: { workspace: { workspaceFolders: true } } });
		});

		it('should register a folder that is added', async () => {
			await connection.changeWorkspaceFolders({ added: [ { uri: URI.file(root).toString(), name: 'alloy' } ], removed: [] });

			assert.deepEqual(service.registry.projects.map(project => project.filePath), [ root ]);
		});

		it('should forget a folder that is removed', async () => {
			const folder = { uri: URI.file(root).toString(), name: 'alloy' };

			await connection.changeWorkspaceFolders({ added: [ folder ], removed: [] });
			await connection.changeWorkspaceFolders({ added: [], removed: [ folder ] });

			assert.deepEqual(service.registry.projects, []);
		});
	});

	describe('code actions', () => {
		const literals = { textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [ 'quickfix' ] } } } } };
		const creates = { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: [ 'create' as const ] } } };

		/** The edit a quick fix makes, as the one file and the text it inserts */
		const insertion = (action: CodeAction): { uri: string; text: string } => {
			const [ [ uri, [ edit ] ] ] = Object.entries(action.edit?.changes ?? {});
			return { uri, text: edit.newText };
		};

		it('should advertise quick fixes to a client that takes code action literals', async () => {
			const result = await connection.initialize({ capabilities: literals });

			assert.deepEqual(result.capabilities.codeActionProvider, { codeActionKinds: [ 'quickfix', 'refactor.extract' ] });
		});

		it('should not advertise them to a client that would need a command', async () => {
			// a Command needs a handler registered on the client, which is custom protocol
			const result = await connection.initialize({ capabilities: {} });

			assert.equal(result.capabilities.codeActionProvider, undefined);
		});

		it('should answer nothing to a client that would need a command, if it asks anyway', async () => {
			await connection.initialize({ capabilities: {}, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="fresh"/>\n</Alloy>');

			assert.equal(await connection.codeAction(uri, 1, 17), null);
		});

		it('should offer a style for a class nothing styles, as an edit rather than a command', async () => {
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="fresh"/>\n</Alloy>');

			const [ action, ...rest ] = await connection.codeAction(uri, 1, 17) ?? [];

			assert.deepEqual(rest, []);
			assert.equal(action.title, 'Generate style for .fresh in styles/index.tss');
			assert.equal(action.kind, 'quickfix');
			assert.equal(action.command, undefined);
			assert.deepEqual(insertion(action), { uri: uriFor('app', 'styles', 'index.tss'), text: '\n".fresh": {\n}\n' });
		});

		it('should offer a handler the controller does not declare', async () => {
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window onOpen="onOpen"/>\n</Alloy>');

			const [ action ] = await connection.codeAction(uri, 1, 18) ?? [];

			assert.equal(insertion(action).uri, uriFor('app', 'controllers', 'index.js'));
			assert.match(insertion(action).text, /function onOpen\(e\) \{\n\}\n$/);
		});

		it('should not offer to create a file to a client that cannot create one', async () => {
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'unstyled.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="fresh"/>\n</Alloy>');

			assert.equal(await connection.codeAction(uri, 1, 17), null);
		});

		it('should create the file for a client that can', async () => {
			await connection.initialize({ capabilities: { ...literals, ...creates }, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'unstyled.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="fresh"/>\n</Alloy>');

			const [ action ] = await connection.codeAction(uri, 1, 17) ?? [];

			assert.deepEqual(action.edit?.documentChanges?.[0], { kind: 'create', uri: uriFor('app', 'styles', 'unstyled.tss') });
		});

		it('should honour a request for other kinds of action', async () => {
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="fresh"/>\n</Alloy>');

			assert.equal(await connection.codeAction(uri, 1, 17, [ 'refactor' ]), null);
			assert.equal((await connection.codeAction(uri, 1, 17, [ 'quickfix' ]))?.length, 1);
		});

		it('should offer a string for a key in a stylesheet', async () => {
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '"Label": { text: L(\'brandnew\') }');

			const [ action ] = await connection.codeAction(uri, 0, 22) ?? [];

			assert.equal(insertion(action).uri, uriFor('app', 'i18n', 'en', 'strings.xml'));
		});

		describe('extracting style', () => {
			const view = '<Alloy>\n\t<Window>\n\t\t<Label color="red"/>\n\t</Window>\n</Alloy>';

			/** The extractions for the Label in `view`, from a client with the capabilities given */
			const extractions = async (capabilities: ClientCapabilities, file = 'index.xml', only?: string[]): Promise<CodeAction[]> => {
				await connection.initialize({ capabilities, rootUri: URI.file(root).toString() });
				const uri = uriFor('app', 'views', file);
				connection.open(uri, 'xml', view);
				return (await connection.codeAction(uri, 2, 5, only) ?? []).filter(action => action.kind === 'refactor.extract');
			};

			it('should offer each kind as a refactoring that edits the view and the stylesheet together', async () => {
				const [ toClass ] = await extractions(literals);

				assert.equal(toClass.title, 'Extract style to .label in styles/index.tss');
				assert.deepEqual(Object.keys(toClass.edit?.changes ?? {}).sort(), [ uriFor('app', 'styles', 'index.tss'), uriFor('app', 'views', 'index.xml') ].sort());
				assert.deepEqual(toClass.edit?.changes?.[uriFor('app', 'views', 'index.xml')], [ {
					range: { start: { line: 2, character: 2 }, end: { line: 2, character: 22 } },
					newText: '<Label class="label"/>'
				} ]);
			});

			it('should carry no command for a client that cannot show a document', async () => {
				// the edit is the whole of the refactoring; revealing the rule is a nicety
				const actions = await extractions(literals);

				assert.ok(actions.length);
				assert.ok(actions.every(action => action.command === undefined));
			});

			it('should reveal the new rule, without selecting it, for a client that can', async () => {
				const [ toClass ] = await extractions({ ...literals, window: { showDocument: { support: true } } });
				assert.ok(toClass.command, 'expected the reveal');

				await connection.executeCommand({ command: toClass.command.command, arguments: toClass.command.arguments });

				// the stylesheet on disk is three lines of rule and a blank line before the new one
				const stylesheet = (await new SourceCache().read(path.join(root, 'app', 'styles', 'index.tss'))).text;
				const line = stylesheet.split('\n').length + (stylesheet.endsWith('\n') ? 0 : 1);
				assert.deepEqual(connection.shown, [ {
					uri: uriFor('app', 'styles', 'index.tss'),
					selection: { start: { line, character: 0 }, end: { line, character: 0 } }
				} ]);
			});

			it('should advertise the command only to a client that can show a document', async () => {
				assert.equal((await connection.initialize({ capabilities: literals })).capabilities.executeCommandProvider, undefined);
			});

			it('should ignore a command it does not know, or one without a place to show', async () => {
				await connection.initialize({ capabilities: { ...literals, window: { showDocument: { support: true } } } });

				await connection.executeCommand({ command: 'something.else', arguments: [] });
				await connection.executeCommand({ command: 'titanium-language-server.reveal', arguments: [ 'not a uri' ] });

				assert.deepEqual(connection.shown, []);
			});

			it('should honour a request for refactorings alone, or quick fixes alone', async () => {
				// a class and a new id: index.tss on disk already has a Label rule, which a tag rule would duplicate
				assert.equal((await extractions(literals, 'index.xml', [ 'refactor' ])).length, 2);
				assert.equal((await extractions(literals, 'index.xml', [ 'quickfix' ])).length, 0);
			});

			it('should create a missing stylesheet only for a client that can', async () => {
				assert.deepEqual(await extractions(literals, 'unstyled.xml'), []);

				const [ toClass ] = await extractions({ ...literals, ...creates }, 'unstyled.xml');
				// the stylesheet first, so a create that fails stops the edit before the view loses anything
				assert.deepEqual(toClass.edit?.documentChanges?.map(change => 'kind' in change ? change.kind : change.textDocument.uri), [
					'create',
					uriFor('app', 'styles', 'unstyled.tss'),
					uriFor('app', 'views', 'unstyled.xml')
				]);
			});
		});

		it('should answer nothing in a file that is neither a view nor a stylesheet', async () => {
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', 'L(\'fresh\')');

			assert.equal(await connection.codeAction(uri, 0, 4), null);
		});
	});

	describe('language services', () => {
		it('should hold a warmed service for each registered project', async () => {
			// warming at registration is the point: the cold parse of the Titanium types is 623ms and
			// must not land on the first keystroke. The classic fixture is the one carrying types.
			const classic = await fixturePath('classic-project');

			await connection.initialize({ rootUri: URI.file(classic).toString() });

			const project = service.registry.projects[0];
			assert.equal(service.services.get(project)?.warmed, true);
		});

		it('should tell the client where the types came from', async () => {
			const classic = await fixturePath('classic-project');

			await connection.initialize({ rootUri: URI.file(classic).toString() });

			assert.ok(connection.logs.some(message => /@types\/titanium/.test(message)),
				'expected the types resolution to be reported');
		});

		it('should warn through the client when no types resolved', async () => {
			// a warning is worth interrupting for: the JavaScript features are simply unavailable, and
			// silence would read as the server being broken. Info is only logged — the types trail
			// the SDK on nearly every project and a message about that would be noise.
			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.ok(connection.warnings.some(message => /No @types\/titanium could be resolved/.test(message)),
				'expected a warning naming the unresolved SDK');
		});

		it('should carry on with the other projects when one cannot be opened', async () => {
			// resolving types can reach the network, and one project that cannot be served is not a
			// reason to leave the rest of the workspace without a registry
			service.services.open = (): never => {
				throw new Error('npm is not answering');
			};

			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.equal(service.registry.projects.length, 1);
			assert.ok(connection.errors.some(message => message.includes('npm is not answering')));
		});

		it('should dispose the service for a folder that is removed', async () => {
			await connection.initialize({ capabilities: { workspace: { workspaceFolders: true } } });
			const folder = { uri: URI.file(root).toString(), name: 'alloy' };
			await connection.changeWorkspaceFolders({ added: [ folder ], removed: [] });
			const project = service.registry.projects[0];
			assert.ok(service.services.get(project), 'expected a service to have been opened');

			await connection.changeWorkspaceFolders({ added: [], removed: [ folder ] });

			assert.equal(service.services.get(project), undefined);
		});

		describe('when the projects on disk change', () => {
			// checked on the request rather than watched, so each test changes the disk and then asks

			let workspace: string;

			beforeEach(async () => {
				workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-changed-'));
			});

			afterEach(async () => {
				await fs.rm(workspace, { recursive: true, force: true });
			});

			/**
			 * Copies the Alloy fixture into the workspace
			 *
			 * @returns {Promise<string>} Where the copy is
			 */
			async function copyProject (): Promise<string> {
				const copy = path.join(workspace, 'app-one');
				await fs.cp(root, copy, { recursive: true });
				return copy;
			}

			/**
			 * Changes a project's tiapp.xml, with a modification time no earlier write could share
			 *
			 * @param project - The project directory
			 * @param change - What to do to its contents
			 */
			async function editTiapp (project: string, change: (text: string) => string): Promise<void> {
				const file = path.join(project, 'tiapp.xml');
				await fs.writeFile(file, change(await fs.readFile(file, 'utf-8')));
				const later = Date.now() / 1000 + 60;
				await fs.utimes(file, later, later);
			}

			/**
			 * Asks for the definition of a class in the copy's view, which any request would do
			 *
			 * @param project - The project directory
			 * @returns The answer
			 */
			async function ask (project: string): Promise<unknown> {
				const uri = URI.file(path.join(project, 'app', 'views', 'index.xml')).toString();
				connection.open(uri, 'xml', '<Alloy>\n\t<Window class="container"/>\n</Alloy>');
				return connection.definition(uri, 1, 17);
			}

			it('should answer for a project created in a folder already open', async () => {
				// ti create inside an open workspace, without the editor being restarted
				await connection.initialize({ rootUri: URI.file(workspace).toString() });
				assert.deepEqual(service.registry.projects, []);

				const created = await copyProject();
				const found = await ask(created);

				assert.equal((found as unknown[] | null)?.length, 1);
				const project = service.registry.projectFor(created);
				assert.ok(project && service.services.get(project), 'expected the new project to have a service');
			});

			it('should rebuild the service of a project whose sdk-version changed', async () => {
				const copy = await copyProject();
				await connection.initialize({ rootUri: URI.file(workspace).toString() });
				const built = service.services.get(service.registry.projects[0]);
				assert.ok(built);

				await editTiapp(copy, text => text.replace(/<sdk-version>[^<]*<\/sdk-version>/, '<sdk-version>99.0.0.GA</sdk-version>'));
				await ask(copy);

				// services are kept by directory, so the question is whether the one there is new
				const after = service.registry.projectFor(copy);
				assert.equal(after?.sdkVersion(), '99.0.0.GA');
				const rebuilt = after && service.services.get(after);
				assert.ok(rebuilt, 'expected a service for the new version');
				assert.notEqual(rebuilt, built);
			});

			it('should not answer a request before a folder added while a check was running', async () => {
				// the check and the folder change queue together, and a request that shares a check
				// already under way must still wait for a change queued behind it
				await connection.initialize({ capabilities: { workspace: { workspaceFolders: true } }, rootUri: URI.file(root).toString() });

				let release = (): void => {};
				const gate = new Promise<void>(resolve => {
					release = resolve;
				});
				const refresh = service.registry.refresh.bind(service.registry);
				service.registry.refresh = async () => {
					await gate;
					return refresh();
				};

				const first = ask(root);
				const copy = await copyProject();
				const changed = connection.changeWorkspaceFolders({ added: [ { uri: URI.file(workspace).toString(), name: 'workspace' } ], removed: [] });
				const second = ask(copy);
				release();

				await Promise.all([ first, changed ]);
				assert.equal((await second as unknown[] | null)?.length, 1);
			});

			it('should let go of a project that is no longer one', async () => {
				const copy = await copyProject();
				await connection.initialize({ rootUri: URI.file(workspace).toString() });
				const before = service.registry.projects[0];

				await editTiapp(copy, text => text.replace(/<sdk-version>[^<]*<\/sdk-version>/, ''));

				assert.equal(await ask(copy), null);
				assert.deepEqual(service.registry.projects, []);
				assert.equal(service.services.get(before), undefined);
			});
		});

		it('should register the project even when its types cannot be resolved', async () => {
			// a missing type package makes the JavaScript features unavailable; it does not make the
			// project invalid, and every other feature still has to work
			await connection.initialize({ rootUri: URI.file(root).toString() });

			assert.equal(service.registry.projects.length, 1);
			assert.equal(service.services.get(service.registry.projects[0])?.types, undefined);
		});
	});

	describe('definition', () => {
		beforeEach(async () => {
			await connection.initialize({ rootUri: URI.file(root).toString() });
		});

		it('should answer with the rule that styles the class under the cursor', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="container"/>\n</Alloy>');

			const found = await connection.definition(uri, 1, 17);

			assert.equal(found?.length, 1);
			assert.equal(found?.[0].uri, uriFor('app', 'styles', 'index.tss'));
			// the rule sits on the first line of the stylesheet
			assert.deepEqual(found?.[0].range.start, { line: 0, character: 0 });
			assert.deepEqual(found?.[0].range.end, { line: 0, character: 12 });
		});

		it('should answer from the buffer being edited rather than the file on disk', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy/>');
			connection.change(uri, '<Alloy>\n\t<Window class="container"/>\n</Alloy>');

			assert.equal((await connection.definition(uri, 1, 17))?.length, 1);
		});

		it('should read from disk again once the document is closed', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy/>');
			connection.close(uri);

			// index.xml on disk styles a container, the buffer that replaced it did not
			assert.equal((await connection.definition(uri, 1, 17))?.length, 1);
		});

		it('should answer nothing for a document in no project', async () => {
			const outside = URI.file(path.join(path.dirname(root), 'elsewhere', 'app', 'views', 'index.xml')).toString();
			connection.open(outside, 'xml', '<Alloy><Window class="container"/></Alloy>');

			assert.equal(await connection.definition(outside, 0, 24), null);
		});

		it('should answer from a stylesheet with the elements its selector styles', async () => {
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '".container": {}');

			const found = await connection.definition(uri, 0, 4);

			assert.equal(found?.length, 1);
			assert.equal(found?.[0].uri, uriFor('app', 'views', 'index.xml'));
			// index.xml on disk writes `\t<Window class="container thirdClass">` on its second line
			assert.deepEqual(found?.[0].range, { start: { line: 1, character: 16 }, end: { line: 1, character: 25 } });
		});

		it('should answer nothing in a stylesheet where the selector styles nothing', async () => {
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '".nothingHasThis": {}');

			assert.equal(await connection.definition(uri, 0, 4), null);
		});

		it('should answer nothing for a file that is neither a view nor a stylesheet', async () => {
			const uri = uriFor('tiapp.xml');
			connection.open(uri, 'xml', '<ti:app><id>com.example</id></ti:app>');

			assert.equal(await connection.definition(uri, 0, 10), null);
		});

		it('should answer nothing where there is no rule to point at', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Window class="nothingStylesThis"/>\n</Alloy>');

			assert.equal(await connection.definition(uri, 1, 17), null);
		});

		it('should answer an event handler with the function in the controller', async () => {
			const uri = uriFor('app', 'views', 'sample.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Label onClick="doClick"/>\n</Alloy>');

			const found = await connection.definition(uri, 1, 20);

			assert.equal(found?.[0].uri, uriFor('app', 'controllers', 'sample.js'));
			// `function doClick` in sample.js, name only
			assert.equal(found?.[0].range.start.character, 9);
			assert.equal(found?.[0].range.end.character, 16);
		});

		it('should answer a Require with the files it names, at their start', async () => {
			const uri = uriFor('app', 'views', 'sample.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Require src="existing-file"/>\n</Alloy>');

			const found = await connection.definition(uri, 1, 18);

			assert.deepEqual(found?.map(location => location.uri), [
				uriFor('app', 'controllers', 'existing-file.js'),
				uriFor('app', 'views', 'existing-file.xml')
			]);
			assert.deepEqual(found?.[0].range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
		});

		it('should answer a translation key with the strings that declare it', async () => {
			const uri = uriFor('app', 'views', 'sample.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Label text="L(\'test\')"/>\n</Alloy>');

			const found = await connection.definition(uri, 1, 19);

			assert.equal(found?.length, 2);
			assert.ok(found?.every(location => location.uri.endsWith('/strings.xml')));
		});

		it('should route on a grammar name as well as a language id', async () => {
			// Pulsar reports the grammar rather than a VS Code language id
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'Alloy (XML)', '<Alloy>\n\t<Window class="container"/>\n</Alloy>');

			assert.equal((await connection.definition(uri, 1, 17))?.length, 1);
		});
	});

	describe('when a provider throws', () => {
		beforeEach(async () => {
			await connection.initialize({ rootUri: URI.file(root).toString() });
		});

		it('should answer nothing and log it, rather than failing the request', async () => {
			service.registry.projectFor = (): never => {
				throw new Error('the sky fell in');
			};
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy><Window class="container"/></Alloy>');

			assert.equal(await connection.definition(uri, 0, 24), null);
			assert.ok(connection.errors.some(message => message.includes('the sky fell in')));
		});
	});

	/**
	 * A server over a fixture project with types resolved, ready to be asked.
	 *
	 * Replaces the one the outer setup built rather than adding a second, so the logger stays
	 * attached to exactly one connection and `afterEach` still detaches it.
	 *
	 * @param fixture - The fixture directory name
	 * @returns {Promise<string>} The project root
	 */
	async function serverOn (fixture: string, capabilities?: ClientCapabilities): Promise<string> {
		const projectRoot = await fixturePath(fixture);

		connection = new FakeConnection();
		service = new TiLanguageService(connection.asConnection(), [ lentTypes ]);
		service.listen();
		await connection.initialize({ rootUri: URI.file(projectRoot).toString(), ...capabilities ? { capabilities } : {} });

		return projectRoot;
	}

	/**
	 * The URI for a path inside a project
	 *
	 * @param projectRoot - The project directory
	 * @param segments - The path within it
	 * @returns {string} The URI
	 */
	function uriIn (projectRoot: string, ...segments: string[]): string {
		return URI.file(path.join(projectRoot, ...segments)).toString();
	}

	describe('completion', () => {
		it('should be advertised, with resolve and the characters that start a completion', async () => {
			const result = await connection.initialize();

			assert.equal(result.capabilities.completionProvider?.resolveProvider, true);
			assert.ok(result.capabilities.completionProvider?.triggerCharacters?.includes('.'),
				'expected a dot to start a completion');
		});

		it('should offer the Titanium API in a classic project', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			const items = await connection.completion(uri, 0, 'Ti.UI.'.length);

			assert.ok(items?.some(item => item.label === 'createWindow'), 'expected the Titanium API');
		});

		it('should offer tag names in a view', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><La</Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><La'.length);

			assert.ok(items?.some(item => item.label === 'Label'), 'expected a tag from the types');
			assert.ok(items?.some(item => item.label === 'Require'), 'expected one from Alloy\'s table');
		});

		it('should offer attribute names in a view, from the element\'s own type', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><Label /></Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><Label '.length);

			assert.ok(items?.some(item => item.label === 'text'), 'expected a Label property');
			assert.ok(items?.some(item => item.label === 'onClick'), 'expected an event');
			assert.ok(items?.some(item => item.label === 'id'), 'expected one of Alloy\'s own');
		});

		it('should answer from the buffer rather than the file on disk', async () => {
			// index.xml on disk holds a Window and a Label; the buffer holds neither, and a
			// completion computed from the saved file is wrong by one keystroke every time
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy><ImageView image="" /></Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><ImageView image="'.length);

			assert.ok(items?.some(item => item.label === '/images/logo.png'), 'expected the buffer to decide');
		});

		it('should replace the value rather than leaving the client to guess the span', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><ImageView image="/images/lo" /></Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><ImageView image="/images/lo'.length);
			const edit = items?.find(item => item.label === '/images/logo.png')?.textEdit;

			assert.ok(edit && TextEdit.is(edit), 'expected an explicit edit');
			assert.equal(edit.range.start.character, '<Alloy><ImageView image="'.length);
			assert.equal(edit.range.end.character, '<Alloy><ImageView image="/images/lo'.length);
		});

		it('should not send tab stops to a client with no snippet engine', async () => {
			// accepting `text="$1"$0` in a client without an engine puts those characters in the
			// user's view
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><Label /></Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><Label '.length);

			assert.equal(items?.find(item => item.label === 'text')?.insertText, 'text="');
		});

		it('should send the snippet form to a client that has one', async () => {
			const projectRoot = await serverOn('alloy-project', {
				textDocument: { completion: { completionItem: { snippetSupport: true } } }
			});
			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><Label /></Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><Label '.length);

			assert.equal(items?.find(item => item.label === 'text')?.insertText, 'text="$1"$0');
		});

		it('should return a view completion unchanged when the client resolves it', async () => {
			// a view item carries no position, because its documentation is already on it. Resolve
			// has to hand it back rather than fail the request
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><Label /></Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><Label '.length);
			const text = items?.find(item => item.label === 'text');

			assert.ok(text?.documentation, 'expected the documentation to be there already');
			assert.deepEqual(await connection.resolveCompletion(text), text);
		});

		it('should offer selectors in a stylesheet, from the view it styles', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '""');

			const items = await connection.completion(uri, 0, 1);

			assert.ok(items?.some(item => item.label === 'Label'), 'expected a tag');
			assert.ok(items?.some(item => item.label === '.container'), 'expected a class from index.xml');
		});

		it('should offer selectors in a theme\'s stylesheet, which is routed as one', async () => {
			const projectRoot = await serverOn('alloy-themed-project');
			const uri = uriIn(projectRoot, 'app', 'themes', 'dark', 'styles', 'index.tss');
			connection.open(uri, 'tss', '""');

			const items = await connection.completion(uri, 0, 1);

			assert.ok(items?.some(item => item.label === '#title'), 'expected an id from index.xml');
		});

		it('should offer property names in a stylesheet, with a plain insert for a client with no snippets', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '"Label": {\n\t\n}');

			const items = await connection.completion(uri, 1, 1);

			assert.equal(items?.find(item => item.label === 'text')?.insertText, 'text: ');
		});

		it('should send the snippet form of a property name to a client that has an engine', async () => {
			const projectRoot = await serverOn('alloy-project', {
				textDocument: { completion: { completionItem: { snippetSupport: true } } }
			});
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '"Label": {\n\t\n}');

			const items = await connection.completion(uri, 1, 1);

			assert.equal(items?.find(item => item.label === 'text')?.insertText, 'text: $0');
		});

		it('should offer the constants a property takes, replacing what has been typed', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '"Label": {\n\ttextAlign: Ti.UI.TE\n}');

			const items = await connection.completion(uri, 1, '\ttextAlign: Ti.UI.TE'.length);
			const edit = items?.find(item => item.label === 'Ti.UI.TEXT_ALIGNMENT_CENTER')?.textEdit;

			assert.ok(edit && TextEdit.is(edit), 'expected an explicit edit');
			assert.equal(edit.range.start.character, '\ttextAlign: '.length);
		});

		it('should answer nothing in a view of a project whose service could not be opened', async () => {
			// a project that failed to open stays in the registry — one bad project is not a reason
			// to abandon the others in the same workspace — so a request can still be routed to it,
			// and the answer is nothing rather than a failed request
			const projectRoot = await fixturePath('alloy-project');

			connection = new FakeConnection();
			service = new TiLanguageService(connection.asConnection(), [ {
				name: 'a source that cannot answer',
				locate: () => Promise.reject(new Error('no types today'))
			} ]);
			service.listen();
			await connection.initialize({ rootUri: URI.file(projectRoot).toString() });

			const uri = uriIn(projectRoot, 'app', 'views', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><La</Alloy>');

			assert.equal(await connection.completion(uri, 0, '<Alloy><La'.length), null);

			const style = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(style, 'tss', '"Label": {\n\t\n}');

			assert.equal(await connection.completion(style, 1, 1), null, 'nor in a stylesheet');
		});

		it('should answer nothing in a view of a classic project, which has none', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.xml');
			connection.open(uri, 'xml', '<Alloy><La</Alloy>');

			const items = await connection.completion(uri, 0, '<Alloy><La'.length);

			assert.ok(!items?.length, 'a classic project has no views');
		});

		it('should offer members on a local, for both project types', async () => {
			// the single biggest gain over the implementation being replaced, which could only
			// match an expression against a table of api names and so had nothing to say here
			for (const [ fixture, directory ] of [ [ 'classic-project', 'Resources' ], [ 'alloy-project', path.join('app', 'lib') ] ] as const) {
				const projectRoot = await serverOn(fixture);
				const uri = uriIn(projectRoot, directory, 'scratch.js');
				connection.open(uri, 'javascript', 'const win = Ti.UI.createWindow();\nwin.');

				const items = await connection.completion(uri, 1, 'win.'.length);

				assert.ok(items?.some(item => item.label === 'title'), `expected members on a local in ${fixture}`);
				assert.ok(items?.some(item => item.label === 'open'), `expected inherited members in ${fixture}`);
			}
		});

		it('should offer the ids of a controller\'s view on $', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.');

			const items = await connection.completion(uri, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'label'), 'expected the view id to reach $');
		});

		it('should mark a deprecated entry the way the client asked for', async () => {
			const cases: [ ClientCompletionItemOptions, Pick<CompletionItem, 'tags'|'deprecated'> ][] = [
				[ { tagSupport: { valueSet: [ CompletionItemTag.Deprecated ] } }, { tags: [ CompletionItemTag.Deprecated ], deprecated: undefined } ],
				[ { deprecatedSupport: true }, { tags: undefined, deprecated: true } ],
				[ {}, { tags: undefined, deprecated: undefined } ]
			];

			for (const [ completionItem, expected ] of cases) {
				const projectRoot = await serverOn('classic-project', { textDocument: { completion: { completionItem } } });
				const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
				connection.open(uri, 'javascript', 'Ti.UI.');

				const items = await connection.completion(uri, 0, 'Ti.UI.'.length) ?? [];
				const deprecated = items.find(item => item.label === 'ATTRIBUTE_LINE_BREAK');
				const current = items.find(item => item.label === 'SIZE');

				assert.deepEqual({ tags: deprecated?.tags, deprecated: deprecated?.deprecated }, expected, JSON.stringify(completionItem));
				assert.deepEqual({ tags: current?.tags, deprecated: current?.deprecated }, { tags: undefined, deprecated: undefined });
			}
		});

		it('should send the ids on $ with a sort text that puts them first', async () => {
			// with no sort text a client sorts by label, and the ids land among Alloy.Controller's
			// members — the twenty or so names every controller has, and the ones a user wants least
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.');

			const items = await connection.completion(uri, 0, '$.'.length) ?? [];
			const rank = items.find(item => item.label === 'label')?.sortText;

			assert.ok(rank, 'expected the id to carry a sort text');
			assert.ok(
				items.every(item => [ 'label', 'index' ].includes(item.label) || rank < (item.sortText ?? item.label)),
				'expected every other member to sort after the ids'
			);
		});

		it('should offer the members of an id on $', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label.');

			const items = await connection.completion(uri, 0, '$.label.'.length);

			assert.ok(items?.some(item => item.label === 'text'), 'expected the members of the tag the id resolves to');
		});

		it('should not leak one controller\'s ids into the next', async () => {
			// every declaration declares $, so asking about a second controller has to take the
			// first back out rather than leave both in the program
			const projectRoot = await serverOn('alloy-project');
			const index = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			const sample = uriIn(projectRoot, 'app', 'controllers', 'sample.js');

			connection.open(index, 'javascript', '$.');
			connection.open(sample, 'javascript', '$.');
			await connection.completion(index, 0, '$.'.length);
			const items = await connection.completion(sample, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'scrollView'), 'expected the ids of the controller asked about');
			assert.ok(!items?.some(item => item.label === 'label'), 'expected the other controller\'s ids to be gone');
		});

		it('should answer from the buffer rather than from what is on disk', async () => {
			// reading disk is wrong by one keystroke, which is every keystroke a user makes
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			connection.open(controller, 'javascript', '$.');
			connection.open(uri, 'xml', '<Alloy><Window id="renamed"/></Alloy>');
			const items = await connection.completion(controller, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'renamed'), 'expected the unsaved view');
			assert.ok(!items?.some(item => item.label === 'label'), 'expected what the view no longer says to be gone');
		});

		it('should answer nothing for a file the language service has nothing to say about', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'i18n', 'en', 'strings.xml');
			connection.open(uri, 'xml', '<resources><string name="a">b</string></resources>');

			assert.equal(await connection.completion(uri, 0, 14), null);
		});

		it('should answer nothing for a file in no registered project', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = URI.file(path.join(path.dirname(projectRoot), 'not-a-project', 'stray.js')).toString();
			connection.open(uri, 'javascript', 'Ti.');

			assert.equal(await connection.completion(uri, 0, 3), null);
		});

		it('should answer nothing in a project whose service could not be opened', async () => {
			// the project is registered and every other feature still works; the JavaScript ones
			// have nothing behind them, and that is an empty answer rather than a failed request
			const projectRoot = await fixturePath('classic-project');
			connection = new FakeConnection();
			service = new TiLanguageService(connection.asConnection(), [ lentTypes ]);
			service.services.open = (): never => {
				throw new Error('npm is not answering');
			};
			service.listen();
			await connection.initialize({ rootUri: URI.file(projectRoot).toString() });

			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			assert.equal(await connection.completion(uri, 0, 'Ti.UI.'.length), null);
		});
	});

	describe('completion in tiapp.xml', () => {

		/** What a machine with two SDKs and the fixture's global modules says through the CLI */
		const titanium: InstalledSource = {
			installed: async () => ({
				sdks: [ { version: '13.0.0.GA', path: '/sdk/13.0.0.GA' }, { version: '9.3.2.GA', path: '/sdk/9.3.2.GA' } ],
				moduleDirectories: [ path.join(await fixturePath('titanium-home'), 'modules') ]
			})
		};

		/**
		 * A server on a fixture whose CLI answers from the table above
		 *
		 * @param fixture - The project to open
		 * @returns {Promise<string>} The project's root
		 */
		async function tiappServerOn (fixture: string): Promise<string> {
			const projectRoot = await fixturePath(fixture);

			connection = new FakeConnection();
			service = new TiLanguageService(connection.asConnection(), [ lentTypes ], titanium);
			service.listen();
			await connection.initialize({ rootUri: URI.file(projectRoot).toString() });

			return projectRoot;
		}

		it('should offer the installed SDKs in sdk-version, in order, replacing what is written', async () => {
			const projectRoot = await tiappServerOn('alloy-project');
			const uri = uriIn(projectRoot, 'tiapp.xml');
			connection.open(uri, 'xml', '<ti:app>\n<sdk-version>9.3</sdk-version>\n</ti:app>');

			const items = await connection.completion(uri, 1, '<sdk-version>9.'.length);

			assert.deepEqual(items?.map(item => item.label), [ '13.0.0.GA', '9.3.2.GA' ]);
			assert.deepEqual(items?.map(item => item.sortText), [ '0000', '0001' ]);
			assert.deepEqual(items?.[1].textEdit, {
				range: { start: { line: 1, character: '<sdk-version>'.length }, end: { line: 1, character: '<sdk-version>9.3'.length } },
				newText: '9.3.2.GA'
			});
		});

		it('should offer SDKs in a tiapp.xml the registry turned away for having none', async () => {
			// the project with no sdk-version is the one that most needs one offered, and it is not
			// registered, because nothing keyed off its SDK can answer
			const projectRoot = await tiappServerOn('no-sdk-project');
			assert.deepEqual(service.registry.projects, []);
			const uri = uriIn(projectRoot, 'tiapp.xml');
			connection.open(uri, 'xml', '<ti:app><sdk-version></sdk-version></ti:app>');

			const items = await connection.completion(uri, 0, '<ti:app><sdk-version>'.length);

			assert.deepEqual(items?.map(item => item.label), [ '13.0.0.GA', '9.3.2.GA' ]);
		});

		it('should offer the project\'s and the global modules in a classic project', async () => {
			const projectRoot = await tiappServerOn('classic-project');
			const uri = uriIn(projectRoot, 'tiapp.xml');
			connection.open(uri, 'xml', '<ti:app><modules><module></module></modules></ti:app>');

			const items = await connection.completion(uri, 0, '<ti:app><modules><module>'.length);

			assert.deepEqual(items?.map(item => item.label), [ 'ti.classic', 'ti.cloud', 'ti.map' ]);
			assert.equal(items?.[0].kind, CompletionItemKind.Module);
		});

		it('should offer the values of an element the build reads, in order, replacing what is written', async () => {
			const projectRoot = await tiappServerOn('alloy-project');
			const uri = uriIn(projectRoot, 'tiapp.xml');
			connection.open(uri, 'xml', '<ti:app>\n<property name="a" type="in">1</property>\n</ti:app>');

			const items = await connection.completion(uri, 1, '<property name="a" type="i'.length);

			assert.deepEqual(items?.map(item => item.label), [ 'string', 'bool', 'int', 'double' ]);
			assert.deepEqual(items?.map(item => item.sortText), [ '0000', '0001', '0002', '0003' ]);
			assert.deepEqual(items?.[2].textEdit, {
				range: { start: { line: 1, character: '<property name="a" type="'.length }, end: { line: 1, character: '<property name="a" type="in'.length } },
				newText: 'int'
			});
		});

		it('should answer nothing elsewhere in the tiapp.xml', async () => {
			const projectRoot = await tiappServerOn('alloy-project');
			const uri = uriIn(projectRoot, 'tiapp.xml');
			connection.open(uri, 'xml', '<ti:app><name></name></ti:app>');

			assert.equal(await connection.completion(uri, 0, '<ti:app><name>'.length), null);
		});
	});

	describe('completion resolve', () => {
		it('should fill in the detail only when the client asks for it', async () => {
			// documentation per entry is the expensive half, and a client asks for it once, for the
			// one entry it is showing
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			const items = await connection.completion(uri, 0, 'Ti.UI.'.length);
			const item = items?.find(entry => entry.label === 'createLabel');
			assert.ok(item, 'expected the entry to resolve the detail of');
			assert.equal(item.documentation, undefined);

			const resolved = await connection.resolveCompletion(item);

			assert.match(String(resolved.documentation), /Creates a label/);
			assert.ok(resolved.detail, 'expected the signature');
		});

		it('should hand back an item it cannot place unchanged', async () => {
			// a client may resolve an item this server never sent, and an item with no detail is a
			// better answer than a failed request
			await serverOn('classic-project');

			assert.deepEqual(await connection.resolveCompletion({ label: 'whatever' }), { label: 'whatever' });
		});

		it('should hand back an item whose detail the language service has nothing for', async () => {
			// the position is real and the entry is not: a stale list, or a buffer that has moved on
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.');

			const item = { label: 'noSuchMember', data: { uri, offset: 'Ti.UI.'.length } };

			assert.deepEqual(await connection.resolveCompletion(item), item);
		});
	});

	describe('hover', () => {
		it('should be advertised', async () => {
			assert.equal((await connection.initialize()).capabilities.hoverProvider, true);
		});

		it('should carry the real type of a local, with its documentation', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'const win = Ti.UI.createLabel();\nwin.text');

			const hover = await connection.hover(uri, 1, 5);

			assert.match(JSON.stringify(hover?.contents), /The text to display/);
		});

		it('should say what an id on $ is', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label');

			const hover = await connection.hover(uri, 0, 4);

			assert.match(JSON.stringify(hover?.contents), /Label/);
		});

		it('should answer nothing where there is nothing to say', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', '\n\n');

			assert.equal(await connection.hover(uri, 0, 0), null);
		});

		it('should describe a tag in a view from the project\'s types', async () => {
			const projectRoot = await serverOn('alloy-project', { textDocument: { hover: { contentFormat: [ 'markdown' ] } } });
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Label text="Hi"/>\n</Alloy>');

			const hover = await connection.hover(uri, 1, 3);

			const value = (hover?.contents as { value: string }).value;

			assert.ok(value.startsWith('```typescript\nTitanium.UI.Label\n```\n\nA text label, with an optional background image.'), value);
			// index.tss on disk colours every Label, and the element sets its own text
			assert.match(value, /\*\*Styles\*\*\n\n(.*\n)*- `color: "#000"` from `Label` in styles\/index\.tss/);
			assert.match(value, /- `text: Hi` from its own attribute/);
			assert.deepEqual(hover?.range, { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } });
		});

		it('should embed an image in a view for a client that renders markdown', async () => {
			const projectRoot = await serverOn('alloy-project', { textDocument: { hover: { contentFormat: [ 'markdown' ] } } });
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<ImageView image="/images/logo.png"/>\n</Alloy>');

			const hover = await connection.hover(uri, 1, 22);

			assert.match(JSON.stringify(hover?.contents), /!\[logo\.png\]\(data:image\/png;base64,/);
		});

		it('should describe it in words for a client that declared no markdown', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<ImageView image="/images/logo.png"/>\n</Alloy>');

			const hover = await connection.hover(uri, 1, 22);

			assert.deepEqual(hover?.contents, { kind: 'plaintext', value: 'Image: 3 × 2 · 73 B' });
		});

		it('should still answer in a view of a project whose types did not resolve', async () => {
			// the Alloy fixture has no types of its own, and a translation needs none
			const uri = uriFor('app', 'views', 'index.xml');
			await connection.initialize({ rootUri: URI.file(root).toString() });
			connection.open(uri, 'xml', '<Alloy>\n\t<Label text="L(\'test\')"/>\n</Alloy>');

			const hover = await connection.hover(uri, 1, 19);

			assert.match(JSON.stringify(hover?.contents), /Une chaîne de test/);
		});

		it('should answer nothing in a view where there is nothing to say', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy>\n\t<Label>Hello</Label>\n</Alloy>');

			assert.equal(await connection.hover(uri, 1, 10), null);
		});

		it('should describe a property in a stylesheet from the types of what the rule styles', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '"Label": {\n\ttext: "Hi"\n}');

			const hover = await connection.hover(uri, 1, 2);

			assert.match(JSON.stringify(hover?.contents), /\(property\) Titanium\.UI\.Label\.text: string/);
			assert.deepEqual(hover?.range, { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } });
		});

		it('should answer nothing in a stylesheet where there is nothing to say', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'styles', 'index.tss');
			connection.open(uri, 'tss', '".container": {}\n\n');

			assert.equal(await connection.hover(uri, 1, 0), null);
		});

		it('should answer nothing for a file that is not a view, a stylesheet or a script', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'tiapp.xml');
			connection.open(uri, 'xml', '<ti:app><id>com.example</id></ti:app>');

			assert.equal(await connection.hover(uri, 0, 10), null);
		});
	});

	describe('definition in JavaScript', () => {
		it('should jump from an id on $ into the view that declares it', async () => {
			// the answer maps back to the view the user wrote, never into the generated declaration
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label.text');

			const found = await connection.definition(uri, 0, 4);

			assert.equal(found?.length, 1);
			assert.equal(found?.[0].uri, uriIn(projectRoot, 'app', 'views', 'index.xml'));
		});

		it('should jump from the name an Alloy factory is given to the files it names', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			const text = 'Alloy.createController(\'existing-file\');\nAlloy.Collections.instance(\'test\');\nAlloy.createWidget(\'widget-test\');';
			connection.open(uri, 'javascript', text);

			const at = async (line: number, character: number): Promise<string[]> => (await connection.definition(uri, line, character))?.map(found => found.uri) ?? [];

			assert.deepEqual(await at(0, 26), [ uriIn(projectRoot, 'app', 'controllers', 'existing-file.js'), uriIn(projectRoot, 'app', 'views', 'existing-file.xml') ]);
			assert.deepEqual(await at(1, 30), [ uriIn(projectRoot, 'app', 'models', 'test.js') ]);
			assert.deepEqual(await at(2, 22), [ uriIn(projectRoot, 'app', 'widgets', 'widget-test', 'controllers', 'widget.js'), uriIn(projectRoot, 'app', 'widgets', 'widget-test', 'views', 'widget.xml') ]);
			const [ first ] = await connection.definition(uri, 0, 26) ?? [];
			assert.deepEqual(first?.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
		});

		it('should jump to a local declaration in a classic project', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'const win = Ti.UI.createWindow();\nwin.open();');

			const found = await connection.definition(uri, 1, 1);

			assert.equal(found?.[0].uri, uri);
			assert.deepEqual(found?.[0].range.start, { line: 0, character: 6 });
		});

		it('should answer nothing where nothing is declared', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', '\n\n');

			assert.equal(await connection.definition(uri, 0, 0), null);
		});

		it('should cross a require the way each project type resolves it', async () => {
			// the same specifier names a different file in each: classic resolves against
			// Resources, Alloy against app/lib. An Alloy-only fixture hides the classic half
			const cases = [
				{ fixture: 'classic-project', from: [ 'Resources', 'scratch.js' ], specifier: 'lib/http', target: [ 'Resources', 'lib', 'http.js' ], member: 'noop' },
				{ fixture: 'alloy-project', from: [ 'app', 'controllers', 'scratch.js' ], specifier: 'folder/custom-view', target: [ 'app', 'lib', 'folder', 'custom-view.js' ], member: 'createCustomView' }
			] as const;

			for (const { fixture, from, specifier, target, member } of cases) {
				const projectRoot = await serverOn(fixture);
				const uri = uriIn(projectRoot, ...from);
				const text = `const required = require('${specifier}');\nrequired.${member}`;
				connection.open(uri, 'javascript', text);

				const found = await connection.definition(uri, 1, `required.${member}`.length - 1);

				assert.equal(found?.length, 1, `expected ${specifier} to resolve in ${fixture}`);
				assert.equal(found?.[0].uri, uriIn(projectRoot, ...target));
			}
		});
	});

	describe('regressions from the implementation being replaced', () => {
		// Each of these was a real bug, found once and fixed once. The approach that produced them
		// matched the text before the cursor against a table of api names with regular expressions;
		// answering through the language service makes most of them structurally impossible rather
		// than merely fixed. They are asserted anyway, because "impossible" is a claim about the
		// current design and the next one has to keep them true.

		it('should complete an id on $ that contains the letters of a Titanium prefix', async () => {
			// the `Ti|Titanium` branch ran before the `$.` branches and its expression was
			// unanchored and case insensitive, so it swallowed any id containing "ti" and
			// `$.activityIndicator` answered nothing at all
			const projectRoot = await serverOn('alloy-project');
			const view = uriIn(projectRoot, 'app', 'views', 'index.xml');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			connection.open(view, 'xml', '<Alloy><ActivityIndicator id="activityIndicator"/></Alloy>');
			connection.open(controller, 'javascript', '$.activityIndicator.');

			const items = await connection.completion(controller, 0, '$.activityIndicator.'.length);

			assert.ok(items?.some(item => item.label === 'message'), 'expected the members of the id');
		});

		it('should complete an api name that is not at the start of the line', async () => {
			// the name was derived by splitting the whole line, so an assignment or any indentation
			// at all put something in front of it and the answer came back empty
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');

			for (const line of [ 'const win = Ti.UI.', '  Ti.UI.', '\t\tTi.UI.', 'foo(Ti.UI.' ]) {
				connection.open(uri, 'javascript', line);

				const items = await connection.completion(uri, 0, line.length);

				assert.ok(items?.some(item => item.label === 'createWindow'), `expected completions after ${JSON.stringify(line)}`);
			}
		});

		it('should complete inside the platform namespaces', async () => {
			// Ti.UI.iOS and Ti.UI.iPad had to be folded in by hand and were not, so `Ti.UI.iOS.`
			// answered nothing. Through the language service they are namespaces like any other
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');

			for (const [ expression, expected ] of [ [ 'Ti.UI.iOS.', 'createNavigationWindow' ], [ 'Ti.UI.iPad.', 'createSplitWindow' ] ] as const) {
				connection.open(uri, 'javascript', expression);

				const items = await connection.completion(uri, 0, expression.length);

				assert.ok(items?.some(item => item.label === expected), `expected ${expected} after ${expression}`);
			}
		});

		it('should answer for a tag whose type the types do not have, without taking $ down with it', async () => {
			// reading `types[apiName].events` unguarded crashed the whole answer: 42 tags in the
			// 10.1.0 data have an apiName with no matching type
			const projectRoot = await serverOn('alloy-project');
			const view = uriIn(projectRoot, 'app', 'views', 'index.xml');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			connection.open(view, 'xml', '<Alloy><Window id="win"><Annotation id="pin"/><Label id="label"/></Window></Alloy>');
			connection.open(controller, 'javascript', '$.');

			const items = await connection.completion(controller, 0, '$.'.length);

			assert.ok(items?.some(item => item.label === 'pin'), 'expected the id whose type is unknown');
			assert.ok(items?.some(item => item.label === 'label'), 'expected the ids beside it');
		});

		it('should point a definition at a path rather than at a URI with one inside it', async () => {
			// `path.dirname` on a `file://` URI produced targets like `/file:/home/...`, which no
			// editor can open. Core deals in paths, and the URI is built back at the very edge
			const projectRoot = await serverOn('alloy-project');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(controller, 'javascript', '$.label.text');

			const found = await connection.definition(controller, 0, 4);

			assert.ok(found?.length, 'expected somewhere to jump to');
			for (const location of found) {
				assert.ok(location.uri.startsWith('file:///'), `${location.uri} should be a file URI`);
				assert.doesNotMatch(location.uri, /file%3A|\/file:/, `${location.uri} carries a URI inside a path`);
			}
		});
	});

	describe('what the project declares about itself', () => {

		it('should offer the configured keys on Alloy.CFG', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', 'Alloy.CFG.');

			const items = await connection.completion(uri, 0, 'Alloy.CFG.'.length);

			assert.ok(items?.some(item => item.label === 'test'), 'expected a key from config.json');
		});

		it('should offer the project\'s own names to the Alloy factories', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');

			for (const [ expression, expected ] of [
				[ 'Alloy.createController(\'', 'sample' ],
				[ 'Alloy.createWidget(\'', 'widget-test' ]
			] as const) {
				connection.open(uri, 'javascript', expression);

				const items = await connection.completion(uri, 0, expression.length);

				assert.ok(items?.some(item => item.label === expected), `expected ${expected} after ${expression}`);
			}
		});

		it('should offer the translation keys to L in both project types', async () => {
			// L is a Titanium global rather than an Alloy one, and classic keeps its i18n beside
			// tiapp.xml rather than under app/ — an Alloy-only implementation answers nothing here
			for (const [ fixture, directory, expected ] of [
				[ 'alloy-project', [ 'app', 'controllers' ], 'welcome.title' ],
				[ 'classic-project', [ 'Resources' ], 'classicOnly' ]
			] as const) {
				const projectRoot = await serverOn(fixture);
				const uri = uriIn(projectRoot, ...directory, 'scratch.js');
				connection.open(uri, 'javascript', 'L(\'');

				const items = await connection.completion(uri, 0, 'L(\''.length);

				assert.ok(items?.some(item => item.label === expected), `expected ${expected} in ${fixture}`);
			}
		});

		it('should pick up a key added to config.json without reopening the project', async () => {
			// the file feeding the declaration is one the user edits while writing the code that
			// reads it, so the answer has to follow the buffer
			const projectRoot = await serverOn('alloy-project');
			const controller = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			const config = uriIn(projectRoot, 'app', 'config.json');

			connection.open(controller, 'javascript', 'Alloy.CFG.');
			connection.open(config, 'json', '{ "global": { "justTyped": true } }');

			const items = await connection.completion(controller, 0, 'Alloy.CFG.'.length);

			assert.ok(items?.some(item => item.label === 'justTyped'), 'expected the unsaved key');
		});

		it('should offer the event names of the type an id on $ resolved to', async () => {
			// no reader and no data file behind this: @types/titanium keys addEventListener on an
			// EventMap per class, so naming the id's type is all it takes
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', '$.label.addEventListener(\'');

			const items = await connection.completion(uri, 0, '$.label.addEventListener(\''.length);

			assert.ok(items?.some(item => item.label === 'click'), 'expected the events of a Label');
			assert.ok(items?.some(item => item.label === 'longpress'), 'expected all of them');
		});

		it('should not offer an Alloy namespace in a classic project', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Allo');

			const items = await connection.completion(uri, 0, 'Allo'.length);

			assert.ok(!items?.some(item => item.label === 'Alloy'), 'classic has no Alloy at all');
		});
	});

	describe('image paths', () => {

		it('should offer the project\'s images in an image property', async () => {
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', 'Ti.UI.createImageView({ image: \'\' });');

			const items = await connection.completion(uri, 0, 'Ti.UI.createImageView({ image: \''.length);

			assert.ok(items?.some(item => item.label === '/images/logo.png'), 'expected an image path');
		});

		it('should offer them in a classic project, from Resources', async () => {
			// classic has no app/assets at all, so the paths come from Resources
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.createImageView({ image: \'\' });');

			const items = await connection.completion(uri, 0, 'Ti.UI.createImageView({ image: \''.length);

			assert.ok(items?.some(item => item.label === '/images/icon.png'), 'expected a classic image path');
		});

		it('should offer them for an assignment as well as an object literal', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			const text = 'const v = Ti.UI.createImageView();\nv.backgroundImage = \'\';';
			connection.open(uri, 'javascript', text);

			const items = await connection.completion(uri, 1, 'v.backgroundImage = \''.length);

			assert.ok(items?.some(item => item.label === '/images/logo.png'));
		});

		it('should replace the whole path rather than the last word of it', async () => {
			// a path carries slashes and dots, and a client works out what to replace from its own
			// idea of a word. Without an explicit range, accepting a completion on `/images/lo`
			// leaves `/images//images/logo.png` in the user's file
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'/images/lo\' });';
			connection.open(uri, 'javascript', text);

			const items = await connection.completion(uri, 0, text.indexOf('\' });'));
			const item = items?.find(entry => entry.label === '/images/logo.png');

			assert.ok(item?.textEdit, 'expected an explicit replacement range');
			const range = (item.textEdit as { range: { start: { character: number }; end: { character: number } } }).range;
			assert.equal(range.start.character, text.indexOf('/images/lo'));
			assert.equal(range.end.character, text.indexOf('\' });'));
		});

		it('should replace an unterminated path up to where typing stopped', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			const text = 'Ti.UI.createImageView({ image: \'/images/lo';
			connection.open(uri, 'javascript', text);

			const items = await connection.completion(uri, 0, text.length);
			const item = items?.find(entry => entry.label === '/images/logo.png');

			assert.ok(item?.textEdit, 'expected an explicit replacement range');
			const range = (item.textEdit as { range: { start: { character: number }; end: { character: number } } }).range;
			assert.equal(range.start.character, text.indexOf('/images/lo'));
			assert.equal(range.end.character, text.length);
		});

		it('should not offer them where the property cannot hold a string', async () => {
			// the name ends in Image and the type is a boolean. A rule that read only the name
			// would offer paths here — @types/titanium declares this one on ImageView, beside image
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.createImageView({ preventDefaultImage: \'\' });');

			const items = await connection.completion(uri, 0, 'Ti.UI.createImageView({ preventDefaultImage: \''.length);

			assert.ok(!items?.some(item => item.label?.endsWith('.png')), 'a boolean is not an image');
		});

		it('should offer them for a property name nothing has a list of', async () => {
			// an options object built up and handed over later: no contextual type, a name this
			// project has never heard of, and image paths are still the right answer
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'const options = { heroImage: \'\' };');

			const items = await connection.completion(uri, 0, 'const options = { heroImage: \''.length);

			assert.ok(items?.some(item => item.label === '/images/logo.png'), 'expected the suffix to carry it');
		});

		it('should not offer them in a property that does not take one', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'Ti.UI.createLabel({ text: \'\' });');

			const items = await connection.completion(uri, 0, 'Ti.UI.createLabel({ text: \''.length);

			assert.ok(!items?.some(item => item.label?.endsWith('.png')), 'a title is not an image');
		});

		it('should not offer them inside a require', async () => {
			const projectRoot = await serverOn('classic-project');
			const uri = uriIn(projectRoot, 'Resources', 'scratch.js');
			connection.open(uri, 'javascript', 'require(\'\');');

			const items = await connection.completion(uri, 0, 'require(\''.length);

			assert.ok(!items?.some(item => item.label?.endsWith('.png')), 'a module path is not an image');
		});

		it('should keep whatever the language service had to say as well', async () => {
			// the two answers are merged rather than one replacing the other: a string literal is
			// still a place TypeScript may know something about
			const projectRoot = await serverOn('alloy-project');
			const uri = uriIn(projectRoot, 'app', 'controllers', 'index.js');
			connection.open(uri, 'javascript', 'L(\'');

			const items = await connection.completion(uri, 0, 'L(\''.length);

			assert.ok(items?.some(item => item.label === 'welcome.title'), 'expected the translation keys still');
		});
	});

	describe('diagnostics', () => {
		const literals = { textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [ 'quickfix' ] } } } } };

		beforeEach(async () => {
			// no delay, so a test waits on what is published rather than on a timer
			service = new TiLanguageService(connection.asConnection(), [ matchedTypes ], undefined, 0);
			service.listen();
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
		});

		it('should warn about an attribute the element does not have, where it is written', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			const published = connection.nextDiagnostics(uri);
			connection.open(uri, 'xml', '<Alloy>\n\t<Label colr="red"/>\n</Alloy>');

			const [ diagnostic, ...rest ] = await published;

			assert.deepEqual(rest, []);
			assert.equal(diagnostic.severity, DiagnosticSeverity.Warning);
			assert.equal(diagnostic.message, 'Ti.UI.Label has no property \'colr\'. Did you mean \'color\'?');
			assert.equal(diagnostic.source, 'titanium');
			assert.deepEqual(diagnostic.range, { start: { line: 1, character: 8 }, end: { line: 1, character: 12 } });
		});

		it('should take the warning back once the attribute is fixed', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			const first = connection.nextDiagnostics(uri);
			connection.open(uri, 'xml', '<Alloy>\n\t<Label colr="red"/>\n</Alloy>');
			assert.equal((await first).length, 1);

			const second = connection.nextDiagnostics(uri);
			connection.change(uri, '<Alloy>\n\t<Label color="red"/>\n</Alloy>');

			assert.deepEqual(await second, []);
		});

		it('should warn about a stylesheet property no element it styles has', async () => {
			connection.open(uriFor('app', 'views', 'index.xml'), 'xml', '<Alloy><Label/></Alloy>');
			const uri = uriFor('app', 'styles', 'index.tss');
			const published = connection.nextDiagnostics(uri);
			connection.open(uri, 'tss', '"Label": {\n\tcolr: "red"\n}');

			const [ diagnostic ] = await published;

			assert.equal(diagnostic.message, 'Ti.UI.Label has no property \'colr\'. Did you mean \'color\'?');
			assert.deepEqual(diagnostic.range, { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } });
		});

		it('should check an open stylesheet again when the view it styles changes', async () => {
			// a Label has no title and a Window does, so what the rule gets wrong is the view's to decide
			const view = uriFor('app', 'views', 'index.xml');
			const style = uriFor('app', 'styles', 'index.tss');
			connection.open(view, 'xml', '<Alloy><Label class="c"/></Alloy>');
			const first = connection.nextDiagnostics(style);
			connection.open(style, 'tss', '".c": { title: "a" }');
			assert.equal((await first).length, 1);

			const second = connection.nextDiagnostics(style);
			connection.change(view, '<Alloy><Window class="c"/></Alloy>');

			assert.deepEqual(await second, []);
		});

		it('should not publish what it found in text that has since changed', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy><Label colr="red"/></Alloy>');
			// the check has started, and is waiting on the disk, when the document changes under it
			await new Promise(resolve => setTimeout(resolve, 0));
			const published = connection.nextDiagnostics(uri);
			connection.change(uri, '<Alloy><Label color="red"/></Alloy>');

			assert.deepEqual(await published, []);
			assert.deepEqual(connection.published.filter(params => params.uri === uri).map(params => params.version), [ 2 ]);
		});

		it('should clear a document\'s warnings when it is closed', async () => {
			const uri = uriFor('app', 'views', 'index.xml');
			const first = connection.nextDiagnostics(uri);
			connection.open(uri, 'xml', '<Alloy><Label colr="red"/></Alloy>');
			await first;

			const cleared = connection.nextDiagnostics(uri);
			connection.close(uri);

			assert.deepEqual(await cleared, []);
		});

		it('should publish nothing for a controller', async () => {
			const controller = uriFor('app', 'controllers', 'index.js');
			const view = uriFor('app', 'views', 'index.xml');
			connection.open(controller, 'javascript', 'const x = 1;');
			const published = connection.nextDiagnostics(view);
			connection.open(view, 'xml', '<Alloy><Label/></Alloy>');
			await published;

			assert.ok(!connection.published.some(params => params.uri === controller));
		});

		it('should offer the name it was probably meant to be as a quick fix', async () => {
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uriFor('app', 'views', 'index.xml'), 'xml', '<Alloy><Label/></Alloy>');
			connection.open(uri, 'tss', '"Label": { "colr": "red" }');

			const [ action, ...rest ] = (await connection.codeAction(uri, 0, 13, [ 'quickfix' ]))?.filter(candidate => candidate.title.startsWith('Change')) ?? [];

			assert.deepEqual(rest, []);
			assert.equal(action.title, 'Change to \'color\'');
			assert.equal(action.kind, 'quickfix');
			assert.equal(action.isPreferred, true);
			assert.deepEqual(action.edit?.changes?.[uri], [ TextEdit.replace({ start: { line: 0, character: 12 }, end: { line: 0, character: 16 } }, 'color') ]);
		});

		it('should name the warning a fix answers, so an editor can show the two together', async () => {
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uriFor('app', 'views', 'index.xml'), 'xml', '<Alloy><Label/></Alloy>');
			const published = connection.nextDiagnostics(uri);
			connection.open(uri, 'tss', '"Label": { "colr": "red" }');
			const [ warning ] = await published;
			// another server's diagnostic in the same place is not this fix's to answer
			const other = { ...warning, source: 'eslint' };

			const actions = await connection.codeAction(uri, 0, 13, [ 'quickfix' ], undefined, [ warning, other ]) ?? [];

			assert.deepEqual(actions.find(action => action.title.startsWith('Change'))?.diagnostics, [ warning ]);
		});

		it('should offer no fix away from a finding', async () => {
			const uri = uriFor('app', 'styles', 'index.tss');
			connection.open(uriFor('app', 'views', 'index.xml'), 'xml', '<Alloy><Label/></Alloy>');
			connection.open(uri, 'tss', '"Label": { "colr": "red", text: "a" }');

			const actions = await connection.codeAction(uri, 0, 28, [ 'quickfix' ]) ?? [];

			assert.ok(!actions.some(action => action.title.startsWith('Change')));
		});
	});

	describe('diagnostics with types older than the SDK', () => {
		const literals = { textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [ 'quickfix' ] } } } } };

		it('should warn about nothing, and say why once', async () => {
			// 9.2.2 for an SDK 10 project: a property SDK 10 added is real, and would read as unknown
			service = new TiLanguageService(connection.asConnection(), [ lentTypes ], undefined, 0);
			service.listen();
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			const first = connection.nextDiagnostics(uri);
			connection.open(uri, 'xml', '<Alloy><Label colr="red"/></Alloy>');
			assert.deepEqual(await first, []);

			const second = connection.nextDiagnostics(uri);
			connection.change(uri, '<Alloy><Label colr="blue"/></Alloy>');
			assert.deepEqual(await second, []);

			const explained = connection.logs.filter(line => line.includes('older than'));
			assert.equal(explained.length, 1);
			assert.match(explained[0], /@types\/titanium 9\.2\.2 .* Titanium SDK 10\.1\.0\.GA/);
		});

		it('should offer no fix for what it does not warn about', async () => {
			service = new TiLanguageService(connection.asConnection(), [ lentTypes ], undefined, 0);
			service.listen();
			await connection.initialize({ capabilities: literals, rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			connection.open(uri, 'xml', '<Alloy><Label colr="red"/></Alloy>');

			const actions = await connection.codeAction(uri, 0, 16, [ 'quickfix' ]) ?? [];

			assert.ok(!actions.some(action => action.title.startsWith('Change')));
		});
	});

	describe('diagnostics without types', () => {

		it('should warn about nothing, since there is nothing to check against', async () => {
			service = new TiLanguageService(connection.asConnection(), [ new ProjectTypes() ], undefined, 0);
			service.listen();
			await connection.initialize({ rootUri: URI.file(root).toString() });
			const uri = uriFor('app', 'views', 'index.xml');
			const published = connection.nextDiagnostics(uri);
			connection.open(uri, 'xml', '<Alloy><Label colr="red"/></Alloy>');

			assert.deepEqual(await published, []);
		});
	});
});
