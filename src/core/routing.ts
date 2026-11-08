import path from 'node:path';
import { Project } from './project.ts';
import { ProjectRegistry } from './registry.ts';

/**
 * What a document is, and what it does.
 *
 * Two questions, because neither answers on its own. The language id says a file is XML; the
 * project layout says whether that is a view, a tiapp.xml or a translation. A `.js` says nothing
 * at all until you know whether it sits under `app/controllers` or `Resources`.
 *
 * The id is matched case insensitively and by substring, because editors do not agree on it.
 * VS Code sends language ids (`xml`, `javascript`); Pulsar sends grammar names (`Alloy (TSS)`).
 * An editor that has no grammar for TSS at all sends something meaningless, so the extension is
 * the fallback rather than the primary source.
 */

export type FileKind = 'xml' | 'tss' | 'javascript' | 'typescript' | 'unknown';

export type FileRole =
	| 'view' | 'style' | 'controller' | 'model' | 'lib' | 'alloy'
	| 'source'
	| 'tiapp' | 'i18n'
	| 'unknown';

export interface RoutedFile {
	project: Project;
	path: string;
	kind: FileKind;
	role: FileRole;
}

/** Checked in order, so `typescript` is not read as containing `script` alone */
const ids: [ string, FileKind ][] = [
	[ 'tss', 'tss' ],
	[ 'typescript', 'typescript' ],
	[ 'javascript', 'javascript' ],
	[ 'xml', 'xml' ]
];

const extensions: Record<string, FileKind> = {
	'.xml': 'xml',
	'.tss': 'tss',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'typescript'
};

/** The directories under app/ that hold each kind of Alloy file */
const alloyDirectories: Record<string, FileRole> = {
	views: 'view',
	styles: 'style',
	controllers: 'controller',
	models: 'model',
	lib: 'lib',
	i18n: 'i18n'
};

/**
 * What language a document is written in
 *
 * @param languageId - The id or grammar name the client reported
 * @param filePath - The file's path, used when the id says nothing
 * @returns {FileKind} The language, as far as it can be told
 */
export function fileKind (languageId: string, filePath: string): FileKind {
	const id = languageId.toLowerCase();

	for (const [ needle, kind ] of ids) {
		if (id.includes(needle)) {
			return kind;
		}
	}

	return extensions[path.extname(filePath).toLowerCase()] ?? 'unknown';
}

/**
 * What a file is for, derived from where it sits in the project.
 *
 * Alloy roles are gated on the project type: a classic project with an `app/views` directory has
 * one by coincidence, and treating it as Alloy would offer completions for a compiler that will
 * never run over it.
 *
 * @param project - The project the file belongs to
 * @param filePath - An absolute path to the file
 * @returns {Promise<FileRole>} What the file does in the project
 */
export async function fileRole (project: Project, filePath: string): Promise<FileRole> {
	const relative = path.relative(project.filePath, filePath);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		return 'unknown';
	}

	const segments = relative.split(path.sep);
	if (segments.length === 1 && segments[0] === 'tiapp.xml') {
		return 'tiapp';
	}

	if (await project.type() !== 'alloy') {
		return classicRole(segments);
	}

	if (segments[0] !== 'app') {
		return 'unknown';
	}

	// a theme's stylesheets stand in for the app's and its widgets', under app/themes/<name>/ and
	// app/themes/<name>/widgets/<widget>/. Nothing else a theme carries is something this reads
	if (segments[1] === 'themes') {
		const inTheme = segments[3] === 'widgets' ? segments.slice(5) : segments.slice(3);
		return inTheme.length > 1 && inTheme[0] === 'styles' ? 'style' : 'unknown';
	}

	// a widget is the same triad nested under app/widgets/<name>/, so the directory that names the
	// role is one level deeper
	const rest = segments[1] === 'widgets' ? segments.slice(3) : segments.slice(1);

	if (rest.length === 1) {
		return rest[0] === 'alloy.js' ? 'alloy' : 'unknown';
	}

	return alloyDirectories[rest[0]] ?? 'unknown';
}

/**
 * What a file is for in a classic project, where everything executable lives under Resources
 *
 * @param segments - The file's path relative to the project, split
 * @returns {FileRole} What the file does
 */
function classicRole (segments: string[]): FileRole {
	if (segments.length < 2) {
		return 'unknown';
	}
	if (segments[0] === 'Resources') {
		return 'source';
	}
	return segments[0] === 'i18n' ? 'i18n' : 'unknown';
}

/**
 * Whether a file is a tiapp.xml, by its name alone.
 *
 * The one file routed without its project. What a tiapp.xml completes from is the machine rather
 * than the project, and a tiapp.xml the registry turned away — one without an sdk-version — is the
 * one that most needs an SDK offered.
 *
 * @param filePath - An absolute path to the file
 * @returns {boolean} Whether it is a tiapp.xml
 */
export function isTiapp (filePath: string): boolean {
	return path.basename(filePath) === 'tiapp.xml';
}

/**
 * Why a document that routed nowhere routed nowhere, in words someone can act on.
 *
 * Every handler answers nothing for a file it cannot place, and the protocol gives a client no way
 * to carry a reason with an empty answer — LSP tracing shows the empty response and never why — so
 * this is what a log line is written from. The cases are told apart rather than collapsed into one
 * message, because the thing to do about each differs: open the project's folder, move the file,
 * or look at the tiapp.xml.
 *
 * @param registry - The registered projects
 * @param filePath - The document the request named
 * @param roots - The folders the client opened
 * @returns {string} Why nothing could be answered
 */
export function noProjectReason (registry: ProjectRegistry, filePath: string, roots: string[]): string {
	const root = roots.find(candidate => contains(candidate, filePath));
	if (!root) {
		return 'it is not inside any folder the editor opened, so no Titanium project was ever looked for around it';
	}

	const registered = registry.projects.filter(project => contains(root, project.filePath));
	if (!registered.length) {
		// the likeliest case by far, and the one hardest to guess at: the scan depth is deliberate,
		// so the answer is to open the project's own folder rather than its parent
		return `No Titanium project is registered under ${root}. One is looked for in that folder and in each folder directly inside it, and only a directory with a tiapp.xml that has an sdk-version counts as one`;
	}

	return `it is not inside any of the projects registered under ${root} (${registered.map(project => project.filePath).join(', ')})`;
}

/**
 * Why a routed file is not something the view, stylesheet or script handlers can answer for.
 *
 * The role is what the layout made of the file, so this says what about the layout stopped it:
 * an Alloy file in a classic project, or a file in a directory that gives it no role.
 *
 * The role is read before the kind, because a file whose role the layout did name is in the right
 * place by definition. `app/i18n/en/strings.xml` is a `.xml` the layout calls a translation, and
 * telling its author it is a view in the wrong directory would send them to move a correct file.
 *
 * @param routed - The routed file
 * @returns {Promise<string>} Why nothing could be answered
 */
export async function noRoleReason (routed: RoutedFile): Promise<string> {
	const alloy = await routed.project.type() === 'alloy';

	if (routed.role === 'i18n') {
		return 'it is a translation file, which is read when a key is looked up rather than answered for directly';
	}

	// the two kinds that are Alloy's and nothing else's, with where Alloy reads each from
	const expected: Partial<Record<FileKind, string>> = { tss: 'app/styles', xml: 'app/views' };
	const where = expected[routed.kind];

	if (where && !alloy) {
		return `${routed.project.filePath} is a classic project, so a ${path.extname(routed.path)} file there has no Alloy role — stylesheets and views are Alloy's, and a classic project has neither`;
	}

	if (where && routed.role === 'unknown') {
		const directory = where.slice('app/'.length);
		return `it is a ${routed.kind === 'tss' ? 'stylesheet' : 'view'} outside ${where}, which is where Alloy reads them from (a widget's under app/widgets/<name>/${directory}, a theme's under app/themes/<name>/${directory})`;
	}

	return `the file is ${readable[routed.kind]} with the role "${routed.role}", and nothing is answered for that in ${alloy ? 'an Alloy' : 'a classic'} project`;
}

/** What to call each kind in a message, where the id itself would read as a typo */
const readable: Record<FileKind, string> = {
	xml: 'XML',
	tss: 'TSS',
	javascript: 'JavaScript',
	typescript: 'TypeScript',
	unknown: 'of no language the server recognises'
};

/**
 * Whether a file sits at or below a directory
 *
 * @param directory - The directory
 * @param filePath - The file
 * @returns {boolean} Whether it is inside
 */
function contains (directory: string, filePath: string): boolean {
	const relative = path.relative(directory, filePath);
	return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Routes a document to the project it belongs to and what it is there.
 *
 * A file in no registered project is not routed at all, rather than routed to a project that
 * happens to be open — answering a question about a file the server knows nothing about is how
 * the wrong SDK's completions end up in someone's editor.
 *
 * @param registry - The registered projects
 * @param filePath - An absolute path to the file
 * @param languageId - The id or grammar name the client reported
 * @returns {Promise<RoutedFile|undefined>} Where the file belongs, if anywhere
 */
export async function route (registry: ProjectRegistry, filePath: string, languageId: string): Promise<RoutedFile|undefined> {
	const project = registry.projectFor(filePath);
	if (!project) {
		return;
	}

	return {
		project,
		path: filePath,
		kind: fileKind(languageId, filePath),
		role: await fileRole(project, filePath)
	};
}
