import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../fs.ts';
import { Project } from '../project.ts';
import { mobileSdkHost, sdkDirectories } from '../titanium.ts';
import { selectTypesVersion } from './versions.ts';
import type { TypesVersionSelection } from './versions.ts';
import type { TypesAcquirer } from './acquire.ts';

/**
 * Where a project's Titanium types come from.
 *
 * An ordered list of sources rather than a hardcoded path: the project's own copy, then the
 * declarations the SDK ships, then npm. Each source either answers or declines, and the first
 * answer wins. The order is a preference for describing the program that is actually being built —
 * what the project compiles against, then what its SDK was generated from, then the nearest
 * published release.
 *
 * Nothing is bundled with this server. Shipping a third-party type package inside a language
 * server is the unusual move: VS Code's automatic type acquisition fetches `@types` into a cache
 * rather than shipping them, and TypeScript bundles only its own `lib.d.ts`. When nothing
 * resolves, the features that need types answer nothing and the user is told which `sdk-version`
 * could not be satisfied — a wrong-version answer given confidently is worse than no answer.
 */

export interface TypesLocation {
	/** The package directory */
	packagePath: string;
	/** The entry `.d.ts` the language service loads */
	entry: string;
	version: string|undefined;
	/** Which source answered, so a message can say where the types came from */
	source: string;
}

/**
 * What to tell the user about how this resolved.
 *
 * Two levels rather than a single log line, because the cases genuinely differ. The types trail
 * the SDK even on a supported major — SDK 13.4.1.GA against types 13.3.0 — so nearly every project
 * falls back a little and a message about it would be noise. Crossing a major, or resolving
 * nothing at all, changes what the editor can tell the user and is worth interrupting for.
 */
export interface TypesReport {
	level: 'info'|'warning';
	message: string;
}

export interface TypesResolution {
	location: TypesLocation|undefined;
	report: TypesReport;
}

/** A place types might come from. Answering `undefined` means "not here", and the next source runs */
export interface TypesSource {
	readonly name: string;
	locate (project: Project): Promise<TypesResolution|undefined>;
}

/**
 * The types the project has installed itself.
 *
 * Always preferred, and never reported as a fallback whatever version it is: the project compiles
 * against this copy, so answering from anything else would describe a different program than the
 * one being built.
 */
export class ProjectTypes implements TypesSource {

	public readonly name = 'the project';

	/**
	 * Looks for `@types/titanium` in the project's own node_modules
	 *
	 * @param project - The project to look in
	 * @returns {Promise<TypesResolution|undefined>} What was found, or nothing so the next source runs
	 * @memberof ProjectTypes
	 */
	public async locate (project: Project): Promise<TypesResolution|undefined> {
		const packagePath = path.join(project.filePath, 'node_modules', '@types', 'titanium');

		const location = await describe(packagePath, this.name);
		if (!location) {
			return;
		}

		return {
			location,
			report: {
				level: 'info',
				message: `Using @types/titanium ${location.version ?? 'of unknown version'} from the project's own node_modules`
			}
		};
	}
}

/**
 * The declarations the Titanium SDK itself ships.
 *
 * Preferred over npm and not over the project's own copy: they are generated from the very SDK
 * being built against, so they describe it exactly rather than trailing it the way a DefinitelyTyped
 * release does — but a project that installed `@types/titanium` itself has already made the choice,
 * and that is what its build compiles against.
 *
 * Read from the disk and from nowhere else: no `ti` spawn and no registry. That is what makes it
 * free to put ahead of npm, and `core/titanium.ts` has the paths the CLI installs to for the same
 * reason.
 *
 * They are looked for in a `types/` directory inside the SDK rather than at its root, because the
 * SDK root already carries titanium_mobile's own `package.json`, which has no `types` field: a
 * lookup there would fall back to `index.d.ts` and appear to work while reporting the SDK's version
 * as the types version. A directory with a manifest of its own gives the report a real version to
 * name.
 *
 * No SDK ships them yet — the build generates them and the packager copies only `api.jsca` into
 * the zip — so on every machine today this declines and npm answers. That is why npm stays the
 * fallback rather than being replaced.
 */
export class SdkTypes implements TypesSource {

	public readonly name = 'the Titanium SDK';

	private locations: string[]|undefined;

	/**
	 * @param locations - The install locations to search, defaulting to the ones the CLI uses on
	 *   this platform. A test supplies its own rather than reading whatever the machine running it
	 *   has installed.
	 */
	constructor (locations?: string[]) {
		this.locations = locations;
	}

	/**
	 * Looks for a `types/` directory inside the project's own SDK
	 *
	 * @param project - The project to resolve for
	 * @returns {Promise<TypesResolution|undefined>} What was found, or nothing so the next source runs
	 * @memberof SdkTypes
	 */
	public async locate (project: Project): Promise<TypesResolution|undefined> {
		if (!project.isValid) {
			return;
		}

		const sdkVersion = project.sdkVersion();

		for (const directory of sdkDirectoriesFor(sdkVersion, this.locations)) {
			const location = await describe(path.join(directory, 'types'), this.name);
			if (!location) {
				continue;
			}

			return {
				location,
				report: {
					level: 'info',
					message: `Using @types/titanium ${location.version ?? 'of unknown version'} from Titanium SDK ${sdkVersion}`
				}
			};
		}
	}
}

/**
 * Where to look for an SDK, honouring install locations a caller supplied
 *
 * @param sdkVersion - The version to look for
 * @param locations - The install locations, or nothing to use this machine's
 * @returns {string[]} The SDK directories to try, in order
 */
function sdkDirectoriesFor (sdkVersion: string, locations: string[]|undefined): string[] {
	if (!locations) {
		return sdkDirectories(sdkVersion);
	}

	// the same shape the defaults have, so a fixture is laid out as a real install location is
	const host = mobileSdkHost();
	return locations.map(location => path.join(location, 'mobilesdk', host, sdkVersion));
}

/**
 * How long a recorded registry check stands before the registry is asked again.
 *
 * A day. `@types/titanium` releases are months apart, so the window costs a user at most a day of
 * not knowing about a release that only ever adds members — against one npm spawn per machine per
 * day instead of one per project per server start, which was most of the first request's cost.
 */
const CHECK_WINDOW = 24 * 60 * 60 * 1000;

/**
 * A selection and why it was chosen from where it was.
 *
 * `registry` is the registry having answered, which is how a release published since is picked up;
 * `cache` is the registry not having been asked, because it was asked recently enough; `offline` is
 * the cache answering because the registry could not be reached. A union rather than an optional
 * `checked`, so the one origin whose message needs the time the registry last answered is the one
 * origin that carries it.
 */
type OriginatedSelection =
	| { selection: TypesVersionSelection; origin: 'registry'|'offline' }
	| { selection: TypesVersionSelection; origin: 'cache'; checked: number };

/**
 * Types fetched from npm, keyed to the tiapp's `sdk-version`.
 *
 * The registry's last answer is consulted before asking it again. `npm view` costs around 280ms
 * and is paid once per project in the workspace, so a two-project workspace spent over half a
 * second of its first request establishing versions that were already sitting on disk. What makes
 * skipping it safe is that the answer itself is recorded, versions and all, so the same rule runs
 * over the same kind of list; only while that record is recent, and otherwise the registry is
 * asked exactly as before.
 */
export class AcquiredTypes implements TypesSource {

	public readonly name = 'npm';

	private acquirer: TypesAcquirer;

	constructor (acquirer: TypesAcquirer) {
		this.acquirer = acquirer;
	}

	/**
	 * Selects a version for the project's SDK and fetches it
	 *
	 * @param project - The project to resolve for
	 * @returns {Promise<TypesResolution|undefined>} What was fetched, or nothing so the next source runs
	 * @memberof AcquiredTypes
	 */
	public async locate (project: Project): Promise<TypesResolution|undefined> {
		const sdkVersion = project.sdkVersion();

		const found = await this.select(sdkVersion);
		const { selection } = found;
		if (!selection.version) {
			// nothing published at or below this SDK, or the registry could not be reached;
			// either way this source has no answer and the next one gets a turn
			return;
		}

		const packagePath = await this.acquirer.install(selection.version);
		if (!packagePath) {
			return;
		}

		const location = await describe(packagePath, this.name);
		if (!location) {
			return;
		}

		// the acquirer was asked for an exact version, so trust that over a missing or odd
		// package.json in what it fetched
		location.version = selection.version;

		return { location, report: report(found) };
	}

	/**
	 * Which version to use, and how that was arrived at.
	 *
	 * The recorded answer first, when the registry gave one recently enough. The rule runs over
	 * that recorded list rather than over what happens to be installed, which is the difference
	 * between a sound shortcut and a machine pinned to its own cache: the record is machine-wide
	 * while a workspace holds one project per SDK, so a 13.x project refreshing it must leave a
	 * 12.x project beside it able to see that 12.0.8 is published even though only 12.0.2 is on
	 * disk. Selecting from a real registry answer is as sound as selecting from a live one,
	 * crossing a major included — the only thing given up is a release published inside the window.
	 *
	 * @param sdkVersion - The tiapp's sdk-version
	 * @returns {Promise<OriginatedSelection>} The selection and where it came from
	 * @memberof AcquiredTypes
	 */
	private async select (sdkVersion: string): Promise<OriginatedSelection> {
		const recorded = await this.acquirer.listing();
		if (recorded?.versions.length && isRecent(recorded.at)) {
			return { selection: selectTypesVersion(sdkVersion, recorded.versions), origin: 'cache', checked: recorded.at };
		}

		// the registry's list when it can be had, so a newer release is picked up as soon as it is
		// published. Without it, what was fetched before is still a complete answer: the list is
		// only how a version is chosen, and the rule is the same over either
		const published = await this.acquirer.versions();
		if (published.length) {
			return { selection: selectTypesVersion(sdkVersion, published), origin: 'registry' };
		}

		return { selection: selectTypesVersion(sdkVersion, await this.acquirer.cached()), origin: 'offline' };
	}
}

/**
 * Whether a recorded check is recent enough to answer from the cache on.
 *
 * A record from the future is a clock moved back or a cache copied from another machine, and is no
 * evidence of anything, so it counts as no record at all rather than as one that never expires.
 *
 * @param checked - When the registry last answered, in milliseconds since the epoch
 * @returns {boolean} Whether the registry can be left unasked
 */
function isRecent (checked: number): boolean {
	const age = Date.now() - checked;
	return age >= 0 && age < CHECK_WINDOW;
}

/**
 * What to tell the user about a version that was selected.
 *
 * The three origins say three different things and must not be collapsed into one message. A
 * registry that could not be reached is a condition the user may want to do something about; a
 * cache answered from on purpose is not, and saying the registry failed when nobody asked it would
 * send someone looking for a network problem that does not exist.
 *
 * @param found - The version chosen and where it was chosen from
 * @returns {TypesReport} What to say
 */
function report (found: OriginatedSelection): TypesReport {
	const { selection, origin } = found;
	const { sdkVersion, version } = selection;

	if (selection.kind === 'older-major') {
		return {
			level: 'warning',
			// offline, a missing major means only that none was cached, and whether one is
			// published is unknown — so the message says what was actually found out
			message: (origin === 'offline'
				? `The npm registry could not be reached and no @types/titanium for Titanium SDK ${sdkVersion} is cached, so the cached ${version} is being used instead. `
				: `No @types/titanium is published for Titanium SDK ${sdkVersion}, so ${version} is being used instead. `)
				+ 'Members added since then will not be offered. Installing @types/titanium in the project will override this.'
		};
	}

	const where = origin === 'offline'
		? ', from the cache because the npm registry could not be reached'
		: found.origin === 'cache'
			? `, from the cache; npm was last asked what is published ${since(found.checked)}`
			: '';

	return { level: 'info', message: `Using @types/titanium ${version} for Titanium SDK ${sdkVersion}${where}` };
}

/**
 * How long ago something happened, in the roundest terms that are still true — the point is to
 * say that the answer is current rather than to be precise about it
 *
 * @param at - When it happened, in milliseconds since the epoch
 * @returns {string} Something to put after "last asked"
 */
function since (at: number): string {
	const minutes = Math.floor((Date.now() - at) / 60000);
	if (minutes < 1) {
		return 'just now';
	}
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	}

	const hours = Math.floor(minutes / 60);
	return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * Walks the sources in order and takes the first answer.
 *
 * @param project - The project to resolve for
 * @param sources - Where to look, in preference order
 * @returns {Promise<TypesResolution>} What was found, or a report saying why nothing was
 */
export async function resolveTypes (project: Project, sources: TypesSource[]): Promise<TypesResolution> {
	for (const source of sources) {
		const resolved = await source.locate(project);
		if (resolved?.location) {
			return resolved;
		}
	}

	const sdkVersion = project.isValid ? project.sdkVersion() : 'unknown';

	return {
		location: undefined,
		report: {
			level: 'warning',
			message: `No @types/titanium could be resolved for Titanium SDK ${sdkVersion}, so JavaScript and TypeScript features are unavailable in ${project.filePath}. `
				+ 'Running `npm install --save-dev @types/titanium` in the project will fix it.'
		}
	};
}

/**
 * Reads a package directory into a location.
 *
 * The entry comes from the package's own `types` or `typings` field rather than being assumed to
 * be `index.d.ts` — that is what it is for `@types/titanium` today, and reading the manifest costs
 * nothing and does not depend on it staying that way.
 *
 * @param packagePath - The package directory
 * @param source - Which source found it
 * @returns {Promise<TypesLocation|undefined>} The location, or nothing when there is no usable package there
 */
async function describe (packagePath: string, source: string): Promise<TypesLocation|undefined> {
	if (!await pathExists(packagePath)) {
		return;
	}

	let manifest: { version?: string; types?: string; typings?: string } = {};
	try {
		manifest = JSON.parse(await fs.readFile(path.join(packagePath, 'package.json'), 'utf-8'));
	} catch {
		// a package with no readable manifest still has types if index.d.ts is there
	}

	const entry = path.join(packagePath, manifest.types ?? manifest.typings ?? 'index.d.ts');
	if (!await pathExists(entry)) {
		return;
	}

	return { packagePath, entry, version: manifest.version, source };
}
