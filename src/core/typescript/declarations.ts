import path from 'node:path';
import { Project } from '../project.ts';
import type { SourceCache } from '../references.ts';
import { relatedFile } from '../related.ts';
import { generateViewDeclaration } from './declaration.ts';
import { ProjectService } from './host.ts';

/**
 * Which controller's `$` the language service currently has in scope.
 *
 * `generateViewDeclaration` turns a view into a declaration; this decides when one is installed,
 * when it is regenerated, and — the part that is easy to get wrong — when the previous one is
 * taken back out. **Every declaration declares `$`**, because that is what Alloy calls it in every
 * controller, so two in the same program is a duplicate identifier and the wrong view's ids on the
 * symbol besides. Exactly one is in scope at a time: the one for the controller being asked about.
 *
 * That invariant is the whole reason this is a class rather than a function. It is state — which
 * declaration is installed — and it has to be enforced across calls that know nothing about each
 * other, since the caller is a request handler answering whatever file the user's cursor is in.
 * `ProjectService.setGenerated` is deliberately generic, knowing only "content to read as a file",
 * so the Alloy half of the knowledge lives here and the TypeScript host stays free of it.
 *
 * One of these per project, beside the service it installs into.
 */

export interface ViewDeclarationsOptions {
	/** The project whose controllers these are */
	project: Project;
	/** The service to install the declaration into */
	service: ProjectService;
	/** Where open buffers come from, shared with the rest of the analysis */
	cache: SourceCache;
}

/** The declaration currently in scope, and what it was generated from */
interface Installed {
	controller: string;
	declaration: string;
	view: string;
	/**
	 * The view text it was generated from.
	 *
	 * Compared rather than a version counted, because a version only moves for a file the client
	 * has open. A view edited on disk — a branch switched under the editor, a generated view — has
	 * the same version and different content, and the cheap half of this is the read: `read`
	 * already skips the disk on an unchanged size and mtime. The parse is what is being avoided.
	 */
	text: string;
}

export class ViewDeclarations {

	private project: Project;
	private service: ProjectService;
	private cache: SourceCache;
	private installed: Installed|undefined;

	constructor (options: ViewDeclarationsOptions) {
		this.project = options.project;
		this.service = options.service;
		this.cache = options.cache;
	}

	/**
	 * Puts the `$` for a controller in scope, and takes any other one out.
	 *
	 * Answers nothing rather than throwing for every file that has no `$` at all — a classic
	 * project, a lib file, a controller written without a view. Each of those is a normal file
	 * rather than an error, and each still has to take the previous declaration out of scope: a
	 * stale `$` answering in a file that has none is worse than no answer.
	 *
	 * @param controllerPath - The file being asked about
	 * @returns {Promise<string|undefined>} Where the declaration stands, when there is one
	 * @memberof ViewDeclarations
	 */
	public async ensure (controllerPath: string): Promise<string|undefined> {
		// relatedFile answers nothing for a classic project, so the project type is gated there
		// rather than checked again here
		const view = await relatedFile(this.project, 'view', controllerPath);
		if (!view) {
			this.drop();
			return;
		}

		const { text } = await this.cache.read(view);

		// the same controller against the same view text is the common case by far: this runs on
		// every completion, hover and definition, and regenerating would put the view parse on
		// every keystroke and bump the script version under the service each time
		if (this.installed?.controller === controllerPath && this.installed.view === view && this.installed.text === text) {
			return this.installed.declaration;
		}

		const declaration = declarationPath(controllerPath);
		const generated = generateViewDeclaration(view, text);

		// out before in, and unconditionally: replacing in place works only while the path is
		// unchanged, and moving between controllers is exactly when it is not
		this.drop();
		// preferred, because the ids are what $ is mostly used for and the only part of it that is
		// this controller's own
		this.service.setGenerated(declaration, generated.text, generated.map, { preferred: true });
		this.installed = { controller: controllerPath, declaration, view, text };

		return declaration;
	}

	/**
	 * Takes the declaration in scope back out, if there is one
	 *
	 * @memberof ViewDeclarations
	 */
	public drop (): void {
		if (!this.installed) {
			return;
		}

		this.service.dropGenerated(this.installed.declaration);
		this.installed = undefined;
	}
}

/**
 * Where a controller's declaration stands.
 *
 * A path rather than a file: nothing is written to a user's project, and the service reads it from
 * memory. It is derived from the controller rather than assembled from the project root so that a
 * widget's controller gets the declaration beside it and a controller in a subdirectory keeps its
 * subdirectory — both of which an `app/controllers/<name>.views.d.ts` template gets wrong.
 *
 * `.d.ts` because the service has to read it as a declaration file; a `.ts` would want emitting.
 *
 * @param controllerPath - The controller it belongs to
 * @returns {string} The path it stands at
 */
function declarationPath (controllerPath: string): string {
	const extension = path.extname(controllerPath);
	return `${controllerPath.slice(0, controllerPath.length - extension.length)}.views.d.ts`;
}
