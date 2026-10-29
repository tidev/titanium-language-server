import * as vls from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { styleActionsAt, viewActionsAt } from '../core/actions.ts';
import type { GeneratedEdit } from '../core/actions.ts';
import { findingsInStyle, findingsInView, replacementFor } from '../core/check.ts';
import type { Finding } from '../core/check.ts';
import { extractActionsAt } from '../core/extract.ts';
import type { ExtractAction } from '../core/extract.ts';
import { imagePathsFor } from '../core/assets.ts';
import { factoryDefinition, selectorDefinitionAt, viewDefinitionAt } from '../core/definition.ts';
import { styleHoverAt, viewHoverAt } from '../core/hover.ts';
import { SourceCache } from '../core/references.ts';
import { Project } from '../core/project.ts';
import { ProjectRegistry } from '../core/registry.ts';
import { ProjectServices } from '../core/typescript/services.ts';
import { AcquiredTypes, ProjectTypes } from '../core/typescript/types.ts';
import type { TypesSource } from '../core/typescript/types.ts';
import { NpmAcquirer } from '../core/typescript/acquire.ts';
import { typesCoverSdk } from '../core/typescript/versions.ts';
import { isTiapp, route } from '../core/routing.ts';
import { styleCompletionsAt } from '../core/style.ts';
import { tiappCompletionsAt } from '../core/tiapp.ts';
import type { InstalledSource } from '../core/tiapp.ts';
import { TitaniumCli } from '../core/titanium.ts';
import { viewCompletionsAt } from '../core/view.ts';
import type { ViewCompletion } from '../core/view.ts';
import type { RoutedFile } from '../core/routing.ts';
import type { ProjectService } from '../core/typescript/host.ts';
import { logger } from '../logger.ts';
import { ClientCapabilities } from './capabilities.ts';
import { DIAGNOSTIC_SOURCE, offsetAt, toCompletionItem, toCompletionKind, toDiagnostic, toLocation, toMarkup, toPath, toRange, toUri, toViewHoverMarkup, toWorkspaceEdit } from './convert.ts';
import { safely } from './guard.ts';

/**
 * The command an extraction carries to show its new rule. Named for the server rather than for
 * Titanium, so it cannot collide with a command an editor's own Titanium extension registers
 */
const REVEAL_COMMAND = 'titanium-language-server.reveal';

/**
 * How long after the last edit the open documents are checked. Long enough that a name half
 * typed is not underlined at every keystroke, and short enough that a mistake shows while the
 * author is still looking at it
 */
const DIAGNOSTIC_DELAY = 300;

/**
 * The Titanium language server's adapter onto the protocol.
 *
 * Everything here is translation and lifecycle: connect, negotiate, keep track of which projects
 * are open and which documents are being edited, route a request to the analysis that answers it,
 * and turn the answer back into the protocol's terms. The analysis itself is in core/, which knows
 * nothing about any of this.
 */
export class TiLanguageService {

	public connection: vls.Connection;
	public documents: vls.TextDocuments<TextDocument>;

	/** The projects this server answers for */
	public registry = new ProjectRegistry();

	/** One language service per project, warmed when the project is registered */
	public services: ProjectServices;

	/**
	 * What the client can do, negotiated at initialize.
	 *
	 * Starts out assuming nothing, so a request that somehow arrives first is answered carefully
	 * rather than against undefined.
	 */
	public capabilities = new ClientCapabilities({});

	private cache: SourceCache = new SourceCache();
	/** What the Titanium CLI says is installed, which is what a tiapp.xml completes from */
	private titanium: InstalledSource;
	/** Resolves once the workspace has been scanned, so a request that beats it does not miss */
	private ready: Promise<unknown> = Promise.resolve();
	/** A check of the disk for changed projects, queued or running, which requests share */
	private refreshing: Promise<unknown>|undefined;
	private roots: string[] = [];
	/** How long to wait after an edit before checking, which a test sets to nothing */
	private delay: number;
	/** The check waiting for typing to stop, when one is */
	private timer: ReturnType<typeof setTimeout>|undefined;
	/** The check under way, which the next one queues behind so two never interleave */
	private diagnosing: Promise<unknown> = Promise.resolve();
	/** The documents that have had diagnostics published, so closing one knows to clear them */
	private diagnosed = new Set<string>();
	/** The projects already told their types are too old to warn from, so it is said once */
	private explained = new Set<string>();

	/**
	 * @param connection - The connection to serve on
	 * @param typesSources - Where `@types/titanium` comes from, in preference order. Defaults to
	 *   the project's own copy, then npm. A test supplies its own rather than reaching the network.
	 * @param titanium - What is installed on the machine. Defaults to asking the Titanium CLI; a
	 *   test supplies its own rather than reading whatever the machine running it has installed.
	 * @param delay - How long after an edit the open documents are checked, in milliseconds
	 */
	constructor (
		connection = vls.createConnection(vls.ProposedFeatures.all),
		typesSources: TypesSource[] = [ new ProjectTypes(), new AcquiredTypes(new NpmAcquirer()) ],
		titanium: InstalledSource = new TitaniumCli(),
		delay = DIAGNOSTIC_DELAY
	) {
		this.connection = connection;
		this.titanium = titanium;
		this.delay = delay;
		logger.attach(this.connection.console);

		this.documents = new vls.TextDocuments(TextDocument);
		this.services = new ProjectServices({ cache: this.cache, sources: typesSources });

		this.connection.onInitialize(this.onInitialize.bind(this));
		this.connection.onInitialized(this.onInitialized.bind(this));
		this.connection.onDefinition(this.onDefinition.bind(this));
		this.connection.onCompletion(this.onCompletion.bind(this));
		this.connection.onCompletionResolve(this.onCompletionResolve.bind(this));
		this.connection.onHover(this.onHover.bind(this));
		this.connection.onCodeAction(this.onCodeAction.bind(this));
		this.connection.onExecuteCommand(this.onExecuteCommand.bind(this));

		// an open document is the one thing on disk that is out of date, so the buffer is fed
		// straight to the cache every analysis reads through
		this.documents.onDidChangeContent(change => {
			this.cache.override(toPath(change.document.uri), change.document.getText());
			this.scheduleDiagnostics();
		});
		this.documents.onDidClose(closed => {
			this.cache.forget(toPath(closed.document.uri));
			this.clearDiagnostics(closed.document.uri);
			// the file reads as it was saved again, which can change what its neighbours get wrong
			this.scheduleDiagnostics();
		});
	}

	/**
	 * Starts the connection and document listeners
	 */
	public listen (): void {
		this.documents.listen(this.connection);
		this.connection.listen();
	}

	private onInitialize (params: vls.InitializeParams): vls.InitializeResult {
		logger.log('Received initialize');

		this.capabilities = new ClientCapabilities(params.capabilities);
		this.roots = rootsOf(params);

		const result: vls.InitializeResult = {
			capabilities: {
				textDocumentSync: vls.TextDocumentSyncKind.Incremental,
				definitionProvider: true,
				hoverProvider: true,
				completionProvider: {
					// the detail for every entry in a list of several hundred is most of the cost
					// of answering, and a client shows one at a time
					resolveProvider: true,
					// a dot is what asks for members; the quotes and the separator are what asks
					// for a module path, which the language service answers inside a string
					triggerCharacters: [ '.', '\'', '"', '/' ]
				}
			}
		};

		// a client that cannot take a CodeAction literal would need a Command, and a command needs a
		// handler on the client: this server offers nothing rather than custom protocol
		if (this.capabilities.codeActionLiterals) {
			result.capabilities.codeActionProvider = { codeActionKinds: [ vls.CodeActionKind.QuickFix, vls.CodeActionKind.RefactorExtract ] };
		}

		// the command only reveals, so a client that cannot show a document is never sent it
		if (this.capabilities.showDocument) {
			result.capabilities.executeCommandProvider = { commands: [ REVEAL_COMMAND ] };
		}

		if (this.capabilities.workspaceFolders) {
			result.capabilities.workspace = {
				workspaceFolders: { supported: true, changeNotifications: true }
			};
		}

		return result;
	}

	/**
	 * Finds the projects in the folders the client opened.
	 *
	 * Deliberately here rather than in `onInitialize`: reading every folder is slow enough that a
	 * client would be waiting on the handshake for it, and nothing can be asked of the server until
	 * this notification has been sent anyway.
	 */
	private async onInitialized (): Promise<void> {
		// assigned before it is awaited, so a request arriving while the scan is still running
		// waits for it rather than being answered against an empty registry. A client is free to
		// send one the moment it has sent this notification, and does.
		this.ready = safely('registering the workspace', undefined, () => this.openProjects(this.roots));

		if (this.capabilities.workspaceFolders) {
			// declared in the initialize result rather than registered dynamically, so this needs
			// nothing of the client beyond the capability it already reported
			this.connection.workspace.onDidChangeWorkspaceFolders(event => this.onWorkspaceFoldersChanged(event));
		}

		await this.ready;
	}

	/**
	 * Registers the projects in folders that were added and forgets those in folders that were
	 * removed, in that order — a project both a new folder and an old one contain stays
	 *
	 * @param event - The folders added and removed
	 * @returns {Promise<void>} When the registry has caught up
	 */
	private async onWorkspaceFoldersChanged (event: vls.WorkspaceFoldersChangeEvent): Promise<void> {
		// queued behind whatever is under way, so a check of the disk and a folder being added never
		// read the same directory at once and register one project twice
		this.ready = this.ready.then(() => safely('changing the workspace', undefined, async () => {
			await this.openProjects(event.added.map(folder => toPath(folder.uri)));

			for (const dropped of this.registry.remove(event.removed.map(folder => toPath(folder.uri)))) {
				this.services.close(dropped);
			}
		}));

		await this.ready;
	}

	/**
	 * Registers the projects under the given roots and builds a warmed language service for each.
	 *
	 * The service is built even when no types resolved. It answers nothing then, but a project
	 * without a type package is not an invalid project — every other feature still works, and the
	 * user is told why the JavaScript ones do not.
	 *
	 * @param roots - The directories to scan
	 * @returns {Promise<void>} When every project found has a service
	 */
	private async openProjects (roots: string[]): Promise<void> {
		await this.openServices(await this.registry.add(roots));
	}

	/**
	 * Builds a warmed language service for each of the given projects, reporting where its types
	 * came from
	 *
	 * @param projects - Projects the registry has just added
	 * @returns {Promise<void>} When every one of them that can be served has a service
	 */
	private async openServices (projects: Project[]): Promise<void> {
		for (const project of projects) {
			// contained per project: resolving types can reach the network, and one project that
			// cannot be served is not a reason to abandon the others in the same workspace
			const opened = await safely(`opening ${project.filePath}`, undefined, () => this.services.open(project));
			if (!opened) {
				continue;
			}

			// info is logged and a warning is shown: the types trail the SDK on nearly every
			// project, so reporting that as an interruption would train the user to ignore it
			if (opened.report.level === 'warning') {
				this.connection.window.showWarningMessage(opened.report.message);
			}
			logger.log(opened.report.message);
		}
	}

	/**
	 * Answers go to definition, from whichever half of the project the cursor is in.
	 *
	 * A view jumps to whatever defines what is under the cursor — the stylesheet rule for a class,
	 * an id or a tag, the controller's handler for an event, the string for a translation key, the
	 * file a `src` or a `module` names. A stylesheet jumps from a selector to the elements it styles
	 * in the views it applies to. A controller or a classic source file jumps to wherever
	 * TypeScript says the symbol is declared — which, for an id on `$`, is the view element the
	 * declaration was generated from.
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.Location[]|null>} Where to jump to, or nothing
	 */
	private async onDefinition (params: vls.DefinitionParams): Promise<vls.Location[]|null> {
		return safely(`finding a definition in ${params.textDocument.uri}`, null, async () => {
			const routed = await this.routeOf(params.textDocument.uri);

			const script = await this.scriptFor(routed);
			if (script && routed) {
				const offset = offsetAt(script.text, params.position);

				// the name handed to an Alloy factory is a string to TypeScript, and a file to Alloy
				const call = script.service.stringLiteralAt(script.path, offset)?.call;
				const named = call ? await factoryDefinition(routed.project, script.path, call) : [];
				if (named.length) {
					return Promise.all(named.map(async location => toLocation((await this.cache.read(location.path)).text, location)));
				}

				const found = script.service.definitionsAt(script.path, offset);

				// every answer already carries a real file and a source offset: the host maps
				// anything that landed in the generated declaration back to the view, and drops
				// what came from scaffolding the user never wrote
				return found.length
					? Promise.all(found.map(async location => toLocation((await this.cache.read(location.path)).text, location)))
					: null;
			}

			const view = routed?.kind === 'xml' && routed.role === 'view';
			const style = routed?.kind === 'tss' && routed.role === 'style';
			if (!routed || (!view && !style)) {
				return null;
			}

			const source = await this.cache.read(routed.path);
			const offset = offsetAt(source.text, params.position);
			const found = view
				? await viewDefinitionAt(routed.project, source, offset, this.cache)
				: await selectorDefinitionAt(routed.project, source, offset, this.cache);
			if (!found.length) {
				return null;
			}

			return Promise.all(found.map(async location => toLocation((await this.cache.read(location.path)).text, location)));
		});
	}

	/**
	 * Answers code actions: the quick fixes that write what a view or a stylesheet names and
	 * nothing defines yet, and the refactorings that extract an element's style into a rule.
	 *
	 * Each carries its edit rather than a command, so a client needs nothing of its own to apply
	 * one. One that would create a file is left out for a client that cannot create one, rather
	 * than sent for the client to reject. An extraction also carries the reveal for a client that
	 * can show a document — a command the server runs itself, through `workspace/executeCommand`,
	 * after the client has applied the edit.
	 *
	 * @param params - The document, the range and what kinds of action are wanted
	 * @returns {Promise<vls.CodeAction[]|null>} The actions, or nothing
	 */
	private async onCodeAction (params: vls.CodeActionParams): Promise<vls.CodeAction[]|null> {
		return safely(`finding code actions in ${params.textDocument.uri}`, null, async () => {
			if (!this.capabilities.codeActionLiterals) {
				return null;
			}

			const routed = await this.routeOf(params.textDocument.uri);
			const view = routed?.kind === 'xml' && routed.role === 'view';
			const style = routed?.kind === 'tss' && routed.role === 'style';
			if (!routed || (!view && !style)) {
				return null;
			}

			const file = await this.cache.read(routed.path);
			const context = {
				project: routed.project,
				file,
				offset: offsetAt(file.text, params.range.start),
				cache: this.cache
			};
			const creatable = (edits: GeneratedEdit[]): boolean => this.capabilities.createFiles || !edits.some(edit => edit.create);

			const actions: vls.CodeAction[] = [];

			if (wants(params.context.only, vls.CodeActionKind.QuickFix)) {
				actions.push(...await this.propertyFixes(routed, file.text, params));

				for (const action of view ? await viewActionsAt(context) : await styleActionsAt(context)) {
					if (creatable([ action.edit ])) {
						actions.push({ title: action.title, kind: vls.CodeActionKind.QuickFix, edit: await this.workspaceEdit([ action.edit ]) });
					}
				}
			}

			if (view && wants(params.context.only, vls.CodeActionKind.RefactorExtract)) {
				const extractions = await extractActionsAt({ ...context, end: offsetAt(file.text, params.range.end) });
				for (const action of extractions.filter(extraction => creatable(extraction.edits))) {
					actions.push({
						title: action.title,
						kind: vls.CodeActionKind.RefactorExtract,
						edit: await this.workspaceEdit(action.edits),
						command: this.capabilities.showDocument ? await this.revealCommand(action) : undefined
					});
				}
			}

			return actions.length ? actions : null;
		});
	}

	/**
	 * The quick fixes that rename a property to the one it was probably meant to be.
	 *
	 * Worked out again from the file rather than read back from the diagnostic the client sends:
	 * carrying data on a diagnostic needs a capability not every client has, and the check is the
	 * same one that published it. Each fix names the diagnostic it answers when the client sent
	 * it, which is how an editor shows the fix beside the warning.
	 *
	 * @param routed - The view or stylesheet
	 * @param text - What it holds
	 * @param params - The range asked about and the diagnostics the client has there
	 * @returns {Promise<vls.CodeAction[]>} The fixes
	 */
	private async propertyFixes (routed: RoutedFile, text: string, params: vls.CodeActionParams): Promise<vls.CodeAction[]> {
		const start = offsetAt(text, params.range.start);
		const end = offsetAt(text, params.range.end);
		const fixes: vls.CodeAction[] = [];

		for (const finding of await this.findingsIn(routed) ?? []) {
			const replacement = replacementFor(finding, text);
			if (!replacement || finding.range.start > end || finding.range.end < start) {
				continue;
			}

			const range = toRange(text, finding.range);
			const answers = params.context.diagnostics.filter(diagnostic => diagnostic.source === DIAGNOSTIC_SOURCE
				&& diagnostic.range.start.line === range.start.line && diagnostic.range.start.character === range.start.character);

			fixes.push({
				title: `Change to '${replacement.text}'`,
				kind: vls.CodeActionKind.QuickFix,
				isPreferred: true,
				diagnostics: answers.length ? answers : undefined,
				edit: await this.workspaceEdit([ { path: routed.path, create: false, offset: replacement.range.start, end: replacement.range.end, text: replacement.text } ])
			});
		}

		return fixes;
	}

	/**
	 * Checks the open documents once typing has stopped for a moment.
	 *
	 * Every open view and stylesheet is checked rather than the one that changed: what a stylesheet
	 * gets wrong depends on the views it styles, so an edit to a view can add or take away a
	 * warning in a stylesheet open beside it, and the reverse.
	 */
	private scheduleDiagnostics (): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.diagnosing = this.diagnosing.then(() => this.diagnoseOpenDocuments());
		}, this.delay);
	}

	/**
	 * Publishes what each open view and stylesheet writes that its elements do not have.
	 *
	 * A document that changed or closed while it was being checked is left alone: the check was of
	 * text that is no longer there, and the change has already queued another.
	 *
	 * @returns {Promise<void>} When every open document has been checked
	 */
	private async diagnoseOpenDocuments (): Promise<void> {
		for (const document of this.documents.all()) {
			// contained per document, so one that cannot be checked does not stop the rest
			await safely(`checking ${document.uri}`, undefined, async () => {
				const { uri, version } = document;
				const routed = await this.routeOf(uri);
				const findings = routed && await this.findingsIn(routed);

				if (this.documents.get(uri)?.version !== version) {
					return;
				}
				if (!routed || !findings) {
					this.clearDiagnostics(uri);
					return;
				}

				const text = (await this.cache.read(routed.path)).text;
				this.diagnosed.add(uri);
				await this.connection.sendDiagnostics({ uri, version, diagnostics: findings.map(finding => toDiagnostic(finding, text)) });
			});
		}
	}

	/**
	 * Takes back the diagnostics published for a document, if any were
	 *
	 * @param uri - The document
	 */
	private clearDiagnostics (uri: string): void {
		if (this.diagnosed.delete(uri)) {
			void this.connection.sendDiagnostics({ uri, diagnostics: [] });
		}
	}

	/**
	 * What a view or a stylesheet writes that its elements do not have.
	 *
	 * Answers nothing for any other file, which is how a caller tells a file that has no findings
	 * from one that is never checked. A project whose types did not resolve is checked and finds
	 * nothing, because there is nothing to check a name against.
	 *
	 * Nor does one whose types are an older major than its SDK, which is every project on SDK 10 or
	 * 11: DefinitelyTyped published no types for either, and the 9.x they fall back to does not
	 * know the properties those SDKs added. Each would read as a mistake, and the suggested fix
	 * would be a name that is wrong. So the project is told why once, and warned about nothing.
	 *
	 * @param routed - The file
	 * @returns {Promise<Finding[]|undefined>} The findings, for a view or a stylesheet
	 */
	private async findingsIn (routed: RoutedFile): Promise<Finding[]|undefined> {
		const view = routed.kind === 'xml' && routed.role === 'view';
		const style = routed.kind === 'tss' && routed.role === 'style';
		const api = this.services.get(routed.project);
		if ((!view && !style) || !api) {
			return;
		}

		const sdkVersion = routed.project.sdkVersion();
		if (api.types && !typesCoverSdk(api.types.version, sdkVersion)) {
			const key = `${routed.project.filePath}\u0000${api.types.version}`;
			if (!this.explained.has(key)) {
				this.explained.add(key);
				logger.log(`Not warning about unknown properties in ${routed.project.filePath}: its @types/titanium ${api.types.version ?? 'of unknown version'} is older than Titanium SDK ${sdkVersion}, so properties added since would be reported as mistakes.`);
			}
			return [];
		}

		const file = await this.cache.read(routed.path);
		const context = { project: routed.project, api, cache: this.cache };

		return view ? findingsInView({ ...context, view: file }) : findingsInStyle({ ...context, style: file });
	}

	/**
	 * Generated edits as the protocol's, with each file read for its positions
	 *
	 * @param edits - The edits
	 * @returns {Promise<vls.WorkspaceEdit>} The edit to send
	 */
	private async workspaceEdit (edits: GeneratedEdit[]): Promise<vls.WorkspaceEdit> {
		const texts = new Map<string, string>();
		for (const edit of edits) {
			texts.set(edit.path, (await this.cache.read(edit.path)).text);
		}
		return toWorkspaceEdit(edits, filePath => texts.get(filePath) ?? '');
	}

	/**
	 * The command that shows an extracted rule once its edit is made.
	 *
	 * The position is worked out now, against the stylesheet as the edit leaves it, because the
	 * command runs after the client has applied the edit and the server is not told what it applied.
	 *
	 * @param action - The extraction
	 * @returns {Promise<vls.Command>} The command
	 */
	private async revealCommand (action: ExtractAction): Promise<vls.Command> {
		const { path: target, offset } = action.reveal;
		const current = (await this.cache.read(target)).text;
		const after = action.edits
			.filter(edit => edit.path === target)
			.reduce((text, edit) => text.slice(0, edit.offset) + edit.text + text.slice(edit.end ?? edit.offset), current);

		return {
			title: 'Show the new rule',
			command: REVEAL_COMMAND,
			arguments: [ toUri(target), toRange(after, { start: offset, end: offset }).start ]
		};
	}

	/**
	 * Shows the document a command names, at the position it names, without selecting anything.
	 *
	 * The one command this server answers, and only ever one of its own code actions sends it. A
	 * selection would invite typing over the rule's name, which is also written in the view, and
	 * break the link between them; renaming is what keeps both in step.
	 *
	 * @param params - The command and its arguments
	 * @returns {Promise<void>} When the client has been asked
	 */
	private async onExecuteCommand (params: vls.ExecuteCommandParams): Promise<void> {
		await safely(`running ${params.command}`, undefined, async () => {
			const [ uri, position ] = params.arguments ?? [];
			if (params.command !== REVEAL_COMMAND || typeof uri !== 'string' || !isPosition(position)) {
				return;
			}
			await this.connection.window.showDocument({ uri, selection: { start: position, end: position } });
		});
	}

	/**
	 * Answers completion in a controller, a library or a classic source file, a view, a stylesheet,
	 * or a tiapp.xml.
	 *
	 * The entries arrive without their documentation, which is resolved per entry the client
	 * actually shows — see `onCompletionResolve`. Each carries where it was asked for, because
	 * resolving needs the same position again and the protocol gives the server nothing else to
	 * find it by.
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.CompletionItem[]|null>} What could be written there
	 */
	private async onCompletion (params: vls.CompletionParams): Promise<vls.CompletionItem[]|null> {
		return safely(`completing in ${params.textDocument.uri}`, null, async () => {
			const routed = await this.routeOf(params.textDocument.uri);

			// by its name rather than by its route: a tiapp.xml without an sdk-version belongs to no
			// registered project, and is the one that most needs an SDK offered
			const filePath = toPath(params.textDocument.uri);
			if (isTiapp(filePath)) {
				return this.tiappCompletions(filePath, params.position);
			}

			// a view is answered by the analysis rather than by the language service: there is no
			// script to ask, and what belongs at a position in XML is a question about the markup
			if (routed?.kind === 'xml' && routed.role === 'view') {
				return this.viewCompletions(routed.project, routed.path, params.position);
			}

			if (routed?.kind === 'tss' && routed.role === 'style') {
				return this.styleCompletions(routed.project, routed.path, params.position);
			}

			const script = await this.scriptFor(routed);
			if (!script) {
				return null;
			}

			const offset = offsetAt(script.text, params.position);

			const items = script.service.completionsAt(script.path, offset).map(entry => {
				// no insert forms: TypeScript's entries are names, and the client inserting the
				// label is exactly right for every one of them
				const item = toCompletionItem({ label: entry.name, sortText: entry.sortText }, this.capabilities.snippets);

				item.kind = toCompletionKind(entry.kind, this.capabilities.completionItemKinds);
				item.data = { uri: params.textDocument.uri, offset };

				if (entry.deprecated && this.capabilities.completionDeprecation === 'tag') {
					item.tags = [ vls.CompletionItemTag.Deprecated ];
				} else if (entry.deprecated && this.capabilities.completionDeprecation === 'property') {
					item.deprecated = true;
				}

				return item;
			});

			// merged rather than instead of: a string literal is still somewhere TypeScript may
			// know something, and an image property is the only thing it cannot answer for itself
			return [ ...items, ...await this.imagesAt(script, offset) ];
		});
	}

	/**
	 * What could be written at a position in a view.
	 *
	 * The types come from the project's own service, which is the same `@types/titanium` every
	 * other answer is drawn from — so a view and a controller never disagree about what a Label
	 * has. A project whose types did not resolve answers Alloy's own attributes and no more, which
	 * is a smaller answer rather than an error.
	 *
	 * @param project - The project the view belongs to
	 * @param filePath - The view
	 * @param position - Where in it
	 * @returns {Promise<vls.CompletionItem[]|null>} What belongs there
	 */
	private async viewCompletions (project: Project, filePath: string, position: vls.Position): Promise<vls.CompletionItem[]|null> {
		const service = this.services.get(project);
		if (!service) {
			return null;
		}

		// the buffer when the document is open, which is what makes the answer current rather than
		// one keystroke stale
		const view = await this.cache.read(filePath);

		const found = await viewCompletionsAt({
			project,
			view,
			offset: offsetAt(view.text, position),
			api: service,
			cache: this.cache
		});

		// documentation up front, where a script completion defers it to `onCompletionResolve`. The
		// two are different sizes of problem: TypeScript's list at a bare cursor is the whole scope
		// and its detail dwarfs the names, while this is one element's properties — measured at
		// 6.8KB for a Label and 8.9KB for a Window, a few KB on one message. Deferring would buy
		// that back at the price of re-parsing the view and re-reading its stylesheets per entry
		// the client highlights, and these items carry no position for a resolve to work from
		return found.length ? found.map(completion => this.toViewItem(completion, view.text)) : null;
	}

	/**
	 * What could be written at a position in a stylesheet.
	 *
	 * The same service as a view, for the same reason: a stylesheet, its view and its controller
	 * never disagree about what a Label has. Documentation travels with each item rather than being
	 * resolved later, as it does for a view.
	 *
	 * @param project - The project the stylesheet belongs to
	 * @param filePath - The stylesheet
	 * @param position - Where in it
	 * @returns {Promise<vls.CompletionItem[]|null>} What belongs there
	 */
	private async styleCompletions (project: Project, filePath: string, position: vls.Position): Promise<vls.CompletionItem[]|null> {
		const service = this.services.get(project);
		if (!service) {
			return null;
		}

		const style = await this.cache.read(filePath);

		const found = await styleCompletionsAt({
			project,
			style,
			offset: offsetAt(style.text, position),
			api: service,
			cache: this.cache
		});

		return found.length ? found.map(completion => this.toViewItem(completion, style.text)) : null;
	}

	/**
	 * What could be written at a position in a tiapp.xml.
	 *
	 * Answered from the machine — the SDKs and modules installed — rather than from the project's
	 * types, so it needs no service and no registered project.
	 *
	 * @param filePath - The tiapp.xml
	 * @param position - Where in it
	 * @returns {Promise<vls.CompletionItem[]|null>} What belongs there
	 */
	private async tiappCompletions (filePath: string, position: vls.Position): Promise<vls.CompletionItem[]|null> {
		const tiapp = await this.cache.read(filePath);

		const found = await tiappCompletionsAt({ tiapp, offset: offsetAt(tiapp.text, position), titanium: this.titanium });

		return found.length ? found.map(completion => this.toViewItem(completion, tiapp.text)) : null;
	}

	/**
	 * One view, stylesheet or tiapp.xml completion in the protocol's terms.
	 *
	 * The span is sent as an explicit edit wherever core supplied one. A client left to work out
	 * what to replace from its own idea of a word turns accepting `/images/lo` into
	 * `/images//images/logo.png`, and an attribute name half typed as `col` into `colcolor`.
	 *
	 * @param completion - What core answered
	 * @param text - The view, for turning offsets into positions
	 * @returns {vls.CompletionItem} The item to send
	 */
	private toViewItem (completion: ViewCompletion, text: string): vls.CompletionItem {
		const item = toCompletionItem(completion, this.capabilities.snippets);

		item.kind = toCompletionKind(completion.kind, this.capabilities.completionItemKinds);

		if (completion.range) {
			item.textEdit = {
				range: toRange(text, completion.range),
				// the insert form when there is one, so a snippet still replaces the right span
				newText: (this.capabilities.snippets ? completion.insert?.snippet : completion.insert?.plain) ?? completion.label
			};
		}

		return item;
	}

	/**
	 * The image paths that could be written at a position, if it is somewhere one belongs.
	 *
	 * The only completion in this server that is not resolved by the language service, because it
	 * is the only one that cannot be: `@types/titanium` types every image path as `string`, and a
	 * property that already exists cannot be narrowed by declaring it again. What a string literal
	 * means is decided by the property it is written into — which the syntax tree answers, so this
	 * still never matches against the characters before the cursor.
	 *
	 * Each item carries an explicit replacement range. A path is full of slashes and dots, and a
	 * client left to work out what to replace from its own idea of a word would turn accepting a
	 * completion on `/images/lo` into `/images//images/logo.png`.
	 *
	 * @param script - The service, path and text for the file being asked about
	 * @param offset - Where in it
	 * @returns {Promise<vls.CompletionItem[]>} The paths, or none
	 */
	private async imagesAt (script: { service: ProjectService; path: string; text: string }, offset: number): Promise<vls.CompletionItem[]> {
		const literal = script.service.stringLiteralAt(script.path, offset);
		if (!literal) {
			return [];
		}

		// answers nothing for every property that does not take an image, so the decision about
		// what a property means stays in core with the rest of the analysis
		const paths = await imagePathsFor(script.service.project, literal.property, literal.typeExcludesString);
		const range = toRange(script.text, literal.range);

		return paths.map(image => ({
			...toCompletionItem({ label: image }, this.capabilities.snippets),
			kind: vls.CompletionItemKind.File,
			textEdit: { range, newText: image }
		}));
	}

	/**
	 * Fills in the signature and documentation for the one entry a client is showing.
	 *
	 * An item this server cannot place comes back unchanged rather than empty: a client may resolve
	 * something it kept from an earlier list, and an item without its documentation is a better
	 * answer than a failed request.
	 *
	 * @param item - The item to resolve
	 * @returns {Promise<vls.CompletionItem>} The same item, with its detail when there is one
	 */
	private async onCompletionResolve (item: vls.CompletionItem): Promise<vls.CompletionItem> {
		return safely(`resolving the completion ${item.label}`, item, async () => {
			const asked = item.data as { uri?: string; offset?: number }|undefined;
			if (typeof asked?.uri !== 'string' || typeof asked.offset !== 'number') {
				return item;
			}

			const script = await this.scriptFor(await this.routeOf(asked.uri));
			const detail = script?.service.completionDetail(script.path, asked.offset, item.label);
			if (!detail) {
				return item;
			}

			return { ...item, detail: detail.text, documentation: detail.documentation };
		});
	}

	/**
	 * Answers hover: in a view or a stylesheet from the analysis, and elsewhere with the type TypeScript has for
	 * what is under the cursor.
	 *
	 * @param params - The document and position asked about
	 * @returns {Promise<vls.Hover|null>} What to show, or nothing
	 */
	private async onHover (params: vls.HoverParams): Promise<vls.Hover|null> {
		return safely(`hovering in ${params.textDocument.uri}`, null, async () => {
			const routed = await this.routeOf(params.textDocument.uri);

			if (routed?.kind === 'xml' && routed.role === 'view') {
				return this.viewHover(routed.project, routed.path, params.position);
			}

			if (routed?.kind === 'tss' && routed.role === 'style') {
				return this.styleHover(routed.project, routed.path, params.position);
			}

			const script = await this.scriptFor(routed);
			if (!script) {
				return null;
			}

			const info = script.service.quickInfoAt(script.path, offsetAt(script.text, params.position));
			if (!info) {
				return null;
			}

			// the range is always in the document that was asked about: quick info describes the
			// token under the cursor, so its span is in that file, and the mapping for a real file
			// is the identity. Only content generated into the program maps elsewhere, and nothing
			// here ever asks about that
			return {
				contents: toMarkup(info, this.capabilities.hoverMarkdown),
				range: toRange(script.text, info.range)
			};
		});
	}

	/**
	 * What to show for a position in a view.
	 *
	 * Answers without the project's types too, just with less: a project whose types did not
	 * resolve still has a service, which answers nothing about tags and attributes, while a
	 * translation, an image and Alloy's own markup need no types at all.
	 *
	 * @param project - The project the view belongs to
	 * @param filePath - The view
	 * @param position - Where in it
	 * @returns {Promise<vls.Hover|null>} What to show, or nothing
	 */
	private async viewHover (project: Project, filePath: string, position: vls.Position): Promise<vls.Hover|null> {
		const service = this.services.get(project);
		if (!service) {
			return null;
		}

		const view = await this.cache.read(filePath);

		const found = await viewHoverAt({
			project,
			view,
			offset: offsetAt(view.text, position),
			api: service,
			cache: this.cache
		});

		return found
			? { contents: toViewHoverMarkup(found, this.capabilities.hoverMarkdown), range: toRange(view.text, found.range) }
			: null;
	}

	/**
	 * What to show for a position in a stylesheet.
	 *
	 * The same answer as a view's, drawn from the other side of the pair: the types a rule styles,
	 * the elements it styles them on, and where the cascade gives a property to another rule.
	 *
	 * @param project - The project the stylesheet belongs to
	 * @param filePath - The stylesheet
	 * @param position - Where in it
	 * @returns {Promise<vls.Hover|null>} What to show, or nothing
	 */
	private async styleHover (project: Project, filePath: string, position: vls.Position): Promise<vls.Hover|null> {
		const service = this.services.get(project);
		if (!service) {
			return null;
		}

		const style = await this.cache.read(filePath);

		const found = await styleHoverAt({
			project,
			style,
			offset: offsetAt(style.text, position),
			api: service,
			cache: this.cache
		});

		return found
			? { contents: toViewHoverMarkup(found, this.capabilities.hoverMarkdown), range: toRange(style.text, found.range) }
			: null;
	}

	/**
	 * What a request is about, once the workspace has been scanned.
	 *
	 * The await is the point rather than a formality: a client may send a request the moment it has
	 * sent `initialized`, and notification handlers are not awaited before the next message is
	 * dispatched, so a handler that skipped this would answer against an empty registry.
	 *
	 * @param uri - The document the request names
	 * @returns {Promise<RoutedFile|undefined>} What it is, when it is in a project at all
	 */
	private async routeOf (uri: string): Promise<RoutedFile|undefined> {
		// behind the scan, and then a look at whether the disk has moved since
		await this.refresh();

		// the language id says what the file is written in and the layout says what it does there;
		// a document the client never opened has no id, and the extension answers instead
		return route(this.registry, toPath(uri), this.documents.get(uri)?.languageId ?? '');
	}

	/**
	 * Brings the registry, and the language services built for it, up to date with the disk.
	 *
	 * Run before each request rather than on a watcher: watching needs a capability not every client
	 * has, and the check is a directory read per folder and a `stat` per candidate. A project that
	 * appeared or changed gets a service — which can mean fetching types, so the request that
	 * notices waits for it, as the first request after start up does. One that changed or went away
	 * has its service closed. Requests arriving together share one check, unless a folder change
	 * has been queued behind it since.
	 *
	 * @returns {Promise<unknown>} When the registry has caught up
	 */
	private refresh (): Promise<unknown> {
		// shared only while it is the last thing queued: a folder change queued behind it has to be
		// waited for too, so a request arriving after one starts a check of its own behind it
		if (this.refreshing && this.ready === this.refreshing) {
			return this.refreshing;
		}

		const refreshing: Promise<unknown> = this.ready.then(() => safely('checking the workspace for changes', undefined, async () => {
			const { added, dropped } = await this.registry.refresh();
			for (const project of dropped) {
				this.services.close(project);
			}
			await this.openServices(added);
		})).finally(() => {
			// an older check finishing must not forget a newer one queued behind it
			if (this.refreshing === refreshing) {
				this.refreshing = undefined;
			}
		});

		this.refreshing = refreshing;
		this.ready = refreshing;
		return refreshing;
	}

	/**
	 * The language service for a routed file, with the right `$` in scope, and the text its
	 * positions are measured against.
	 *
	 * Answers nothing for everything that is not JavaScript or TypeScript, which is how each
	 * handler tells a file it can answer for from one it cannot.
	 *
	 * @param routed - What the request is about
	 * @returns The service, the path and the text, when the file is a script in an open project
	 */
	private async scriptFor (routed: RoutedFile|undefined): Promise<{ service: ProjectService; path: string; text: string }|undefined> {
		if (routed?.kind !== 'javascript' && routed?.kind !== 'typescript') {
			return;
		}

		// never `services.get`: preparing is what settles which controller's `$` the program holds,
		// and only one may be in scope at a time
		const service = await this.services.prepare(routed.project, routed.path);
		if (!service) {
			return;
		}

		// the buffer when the document is open, which is the whole point of the shared cache:
		// reading disk is wrong by one keystroke
		return { service, path: routed.path, text: (await this.cache.read(routed.path)).text };
	}
}

/**
 * Whether a command's argument is a position
 *
 * @param value - The argument, which came back from the client
 * @returns {boolean} Whether it is a line and a character
 */
function isPosition (value: unknown): value is vls.Position {
	const position = value as Partial<vls.Position>|undefined;
	return typeof position?.line === 'number' && typeof position.character === 'number';
}

/**
 * Whether a request for code actions wants those of a kind.
 *
 * Kinds are hierarchical — `refactor.extract` is a `refactor` — so a kind is wanted when the
 * client asked for it or for one it falls under, and every kind is wanted when it named none.
 *
 * @param only - The kinds the client asked for
 * @param kind - The kind of the actions on offer
 * @returns {boolean} Whether to answer with them
 */
function wants (only: string[]|undefined, kind: string): boolean {
	return !only || only.some(asked => kind === asked || kind.startsWith(`${asked}.`));
}

/**
 * The directories the client opened.
 *
 * `workspaceFolders` is what a client that has them sends, and it is null rather than absent on
 * one that does not, so `rootUri` is the fallback. `rootPath` is deprecated and not read: every
 * client that sends it sends `rootUri` too.
 *
 * @param params - The initialize parameters
 * @returns {string[]} Absolute paths, which may be none at all when no folder is open
 */
function rootsOf (params: vls.InitializeParams): string[] {
	if (params.workspaceFolders?.length) {
		return params.workspaceFolders.map(folder => toPath(folder.uri));
	}
	return params.rootUri ? [ toPath(params.rootUri) ] : [];
}
