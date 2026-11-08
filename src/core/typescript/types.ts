import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../fs.ts';
import { Project } from '../project.ts';
import { selectTypesVersion } from './versions.ts';
import type { TypesVersionSelection } from './versions.ts';
import type { TypesAcquirer } from './acquire.ts';

/**
 * Where a project's Titanium types come from.
 *
 * An ordered list of sources rather than a hardcoded path, because there is already more than one
 * — the project's own copy, then npm — and there is likely to be a third: types published in the
 * SDK itself are being pursued upstream, and would slot in between the two without anything else
 * changing. Each source either answers or declines, and the first answer wins.
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
 * How long a recorded registry check stands before the registry is asked again.
 *
 * A day. `@types/titanium` releases are months apart, so the window costs a user at most a day of
 * not knowing about a release that only ever adds members — against one npm spawn per machine per
 * day instead of one per project per server start, which was most of the first request's cost.
 */
const CHECK_WINDOW = 24 * 60 * 60 * 1000;

/** Why the version that was chosen was chosen from where it was */
type SelectionOrigin =
	/** The registry answered, which is how a release published since is picked up */
	| 'registry'
	/** The cache answered and the registry was not asked, because it was asked recently enough */
	| 'cache'
	/** The cache answered because the registry could not be reached */
	| 'offline';

interface OriginatedSelection {
	selection: TypesVersionSelection;
	origin: SelectionOrigin;
	/** When the registry was last asked, for the message, when a `cache` origin read one */
	checked?: number;
}

/**
 * Types fetched from npm, keyed to the tiapp's `sdk-version`.
 *
 * The cache is consulted before the registry rather than after it. `npm view` costs around 280ms
 * and is paid once per project in the workspace, so a two-project workspace spent over half a
 * second of its first request establishing versions that were already sitting on disk. What makes
 * skipping it safe is the record of when the registry last answered: a cached version is taken on
 * its own only while that record is recent, and otherwise the registry is asked exactly as before.
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

		const { selection, origin, checked } = await this.select(sdkVersion);
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

		return { location, report: report(selection, origin, checked) };
	}

	/**
	 * Which version to use, and how that was arrived at.
	 *
	 * The cache first, and only when it already holds the SDK's own major: that is nearly every
	 * project, and it is the case where asking the registry can only ever turn up a release that
	 * adds members to the same major. An older major is the opposite — the rarest answer and the
	 * one most worth getting right — so it is never taken from the cache on trust, however
	 * recently the registry answered.
	 *
	 * @param sdkVersion - The tiapp's sdk-version
	 * @returns {Promise<OriginatedSelection>} The selection and where it came from
	 * @memberof AcquiredTypes
	 */
	private async select (sdkVersion: string): Promise<OriginatedSelection> {
		const checked = await this.acquirer.checked();
		// a record from the future is a clock moved back or a cache copied from another machine,
		// and is no evidence of anything
		const age = checked === undefined ? undefined : Date.now() - checked;
		if (age !== undefined && age >= 0 && age < CHECK_WINDOW) {
			const cached = selectTypesVersion(sdkVersion, await this.acquirer.cached());
			if (cached.kind === 'matched') {
				return { selection: cached, origin: 'cache', checked };
			}
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
 * What to tell the user about a version that was selected.
 *
 * The three origins say three different things and must not be collapsed into one message. A
 * registry that could not be reached is a condition the user may want to do something about; a
 * cache answered from on purpose is not, and saying the registry failed when nobody asked it would
 * send someone looking for a network problem that does not exist.
 *
 * @param selection - The version chosen and how well it matches
 * @param origin - Where it was chosen from
 * @param checked - When the registry last answered, for a `cache` origin
 * @returns {TypesReport} What to say
 */
function report (selection: TypesVersionSelection, origin: SelectionOrigin, checked?: number): TypesReport {
	const { sdkVersion, version } = selection;

	if (selection.kind === 'older-major') {
		// only ever reached for a registry or an offline origin: a cached older major is never
		// taken without asking the registry first
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
		: origin === 'cache'
			? `, from the cache; npm was last asked what is published ${since(checked)}`
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
function since (at: number|undefined): string {
	if (at === undefined) {
		return 'at an unknown time';
	}

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
