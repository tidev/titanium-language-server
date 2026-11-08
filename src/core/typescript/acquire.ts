import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathExists } from '../fs.ts';
import { runCommand } from '../command.ts';
import type { CommandRunner } from '../command.ts';
import { logger } from '../../logger.ts';

/**
 * Fetching `@types/titanium` onto the machine.
 *
 * TypeScript ships automatic type acquisition, and it cannot be reused here for four separate
 * reasons: `ts.JsTyping.discoverTypings` and `ts.server.typingsInstaller` are absent from the
 * public `typescript.d.ts`; the installer is a separate process speaking a request/response
 * protocol to tsserver, which we do not run; its discovery works from `package.json` dependencies,
 * unresolved imports and a filename safe list, none of which name Titanium, so it would never pick
 * this package up; and it versions against the TypeScript release rather than against the tiapp's
 * `sdk-version`, which is the whole substance of the resolution rule.
 *
 * What it does mechanically is worth copying, and this does: spawn npm with `--ignore-scripts`
 * into a version-keyed cache directory. Spawning npm rather than talking to the registry directly
 * is what avoids hand-rolling a tar reader, and it inherits the user's own registry and proxy
 * configuration, which is usually the difference between working and not behind a corporate proxy.
 *
 * Spawning it is also the expensive part — around 280ms a run, paid once per project in the
 * workspace — so when the registry was last asked is recorded beside the versions it answered
 * with, and `AcquiredTypes` reads that to decide whether it has to be asked again at all.
 *
 * Nothing here throws. A machine with no network, or no npm, is a normal condition for a language
 * server rather than an error — the resolver falls through to reporting that nothing resolved.
 */

/** The npm package the types come from */
const packageName = '@types/titanium';

/** The environment variable that moves the cache */
const CACHE_VARIABLE = 'TITANIUM_LANGUAGE_SERVER_TYPES_CACHE';

/**
 * The file in the cache root recording when the registry was last asked what is published.
 *
 * A dotfile so a user reading the cache sees versions and one piece of bookkeeping rather than
 * two kinds of thing, and a file rather than a directory so `cached` skips it without having to
 * know its name.
 */
const CHECKED_FILE = '.last-registry-check';

export interface TypesAcquirer {
	/** Every version published, or nothing when the registry cannot be reached */
	versions (): Promise<string[]>;
	/** Every version already fetched, which is what there is to choose from offline */
	cached (): Promise<string[]>;
	/**
	 * When the registry was last successfully asked what is published, in milliseconds since the
	 * epoch, or nothing when it never has been. What lets a cached answer be given without asking
	 * again, and what bounds how long one may be.
	 */
	checked (): Promise<number|undefined>;
	/** Fetches one version and answers where it landed, or nothing when it could not be had */
	install (version: string): Promise<string|undefined>;
}

export interface NpmAcquirerOptions {
	run?: CommandRunner;
	/** The directory holding one directory per fetched version */
	cacheRoot?: string;
}

/**
 * Where fetched copies of the types live, one directory per version.
 *
 * Under `~/.titanium`, beside the SDKs, modules and completions the rest of the Titanium tooling
 * keeps there. A platform cache directory would be the more orthodox home for something
 * re-downloadable, but a user looking for what Titanium has put on their machine looks in one
 * place, and this is that place. Named for what it holds rather than for which tool wrote it,
 * which is the convention the neighbouring directories already follow.
 *
 * Keyed on the version below this, so a workspace holding a 9.x project beside a 13.x one keeps
 * both rather than reinstalling on every switch, and so a cache warmed once keeps working offline
 * — `NpmAcquirer.cached` is what reads it back when the registry cannot be reached.
 *
 * `TITANIUM_LANGUAGE_SERVER_TYPES_CACHE` moves the whole cache. A spawned server takes no
 * constructor arguments, so the environment is the only way to point one somewhere else — which is
 * what keeps a test from installing into the home directory of whoever runs it, and what a user
 * with a read-only home directory would reach for.
 *
 * @param env - Where the override is read from
 * @returns {string} An absolute path
 */
export function typesCacheRoot (env: NodeJS.ProcessEnv = process.env): string {
	// an empty value is how a shell unsets a variable for one command, and must not mean the
	// current directory
	return env[CACHE_VARIABLE]
		? path.resolve(env[CACHE_VARIABLE])
		: path.join(os.homedir(), '.titanium', 'types');
}

/**
 * An acquirer that fetches through npm.
 *
 * Both collaborators are constructor arguments with real defaults rather than hardcoded calls:
 * the runner is the seam that keeps the suite off the network, and the cache location is what lets
 * a test install into a temporary directory.
 */
export class NpmAcquirer implements TypesAcquirer {

	private run: CommandRunner;
	private cacheRoot: string;

	constructor (options: NpmAcquirerOptions = {}) {
		this.run = options.run ?? runCommand;
		this.cacheRoot = options.cacheRoot ?? typesCacheRoot();
	}

	/**
	 * Every version of the package the registry has
	 *
	 * @returns {Promise<string[]>} The versions, or nothing when the registry could not be reached
	 * @memberof NpmAcquirer
	 */
	public async versions (): Promise<string[]> {
		let result;
		try {
			result = await this.run('npm', [ 'view', packageName, 'versions', '--json' ], {});
		} catch (error) {
			// npm not being on the PATH is a machine we cannot acquire on, not a crash
			logger.log(`Could not ask npm for ${packageName} versions: ${message(error)}`);
			return [];
		}

		if (result.code !== 0) {
			logger.log(`npm could not list ${packageName} versions: ${result.stderr.trim() || `exit ${result.code}`}`);
			return [];
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			logger.log(`npm answered with something that is not JSON when listing ${packageName} versions`);
			return [];
		}

		// recorded only for an answer, and after it: a run that failed establishes nothing about
		// what is published, and letting it stand in for a real check would pin the machine to its
		// cache on the strength of a failure
		await this.record();

		// npm unwraps a single-element list into a bare string
		return typeof parsed === 'string' ? [ parsed ] : (parsed as string[]);
	}

	/**
	 * When the registry last answered, read back from the cache
	 *
	 * @returns {Promise<number|undefined>} The time, or nothing when it has never answered here
	 * @memberof NpmAcquirer
	 */
	public async checked (): Promise<number|undefined> {
		let written;
		try {
			written = await fs.readFile(path.join(this.cacheRoot, CHECKED_FILE), 'utf-8');
		} catch {
			// never asked on this machine, or no cache at all yet
			return;
		}

		// an ISO timestamp rather than the file's own mtime: a cache directory copied or restored
		// from somewhere else carries whatever mtime the copy gave it, and what matters is when
		// the registry answered rather than when the file was last touched
		const at = Date.parse(written.trim());
		return Number.isNaN(at) ? undefined : at;
	}

	/**
	 * Records that the registry has just answered.
	 *
	 * Written as text a person can read, since this sits in a directory users do look in. A cache
	 * root that cannot be written costs the staleness check and nothing else — the versions have
	 * already been answered by the time this runs — so it is logged rather than propagated.
	 *
	 * @returns {Promise<void>} When it has been recorded, or failed to be
	 * @memberof NpmAcquirer
	 */
	private async record (): Promise<void> {
		try {
			// the first run of all asks the registry before anything has been installed, so the
			// directory this goes in may not exist yet
			await fs.mkdir(this.cacheRoot, { recursive: true });
			await fs.writeFile(path.join(this.cacheRoot, CHECKED_FILE), `${new Date().toISOString()}\n`);
		} catch (error) {
			logger.log(`Could not record that npm was asked for ${packageName} versions, so it will be asked again: ${message(error)}`);
		}
	}

	/**
	 * Every version already in the cache.
	 *
	 * Read from the disk and never from npm, because this is what the common case answers from and
	 * what there is to choose from when npm cannot reach the registry. Only a version whose package
	 * is complete counts: npm creates
	 * the prefix before it has fetched anything and the package directory before it has finished
	 * extracting, so an install that stopped part way leaves a directory named for a version it
	 * does not hold. Choosing one of those would fail later, with nothing else tried.
	 *
	 * @returns {Promise<string[]>} The versions, or nothing when there is no cache yet
	 * @memberof NpmAcquirer
	 */
	public async cached (): Promise<string[]> {
		let entries;
		try {
			entries = await fs.readdir(this.cacheRoot, { withFileTypes: true });
		} catch {
			// nothing has been fetched on this machine yet
			return [];
		}

		const versions: string[] = [];
		for (const entry of entries) {
			if (entry.isDirectory() && await isComplete(path.join(this.cacheRoot, entry.name))) {
				versions.push(entry.name);
			}
		}

		return versions;
	}

	/**
	 * Fetches one version into the cache, or answers what is already there
	 *
	 * @param version - The version to fetch
	 * @returns {Promise<string|undefined>} Where the package landed, or nothing when it could not be had
	 * @memberof NpmAcquirer
	 */
	public async install (version: string): Promise<string|undefined> {
		const prefix = path.join(this.cacheRoot, version);
		const installed = packageIn(prefix);

		// a version already fetched costs nothing and works with no network at all. A package
		// directory without its declarations is not one: that is an install that stopped part
		// way, and running npm again is what repairs it
		if (await isComplete(prefix)) {
			return installed;
		}

		const args = [
			'install',
			// a postinstall from a fetched package running inside a language server is the one
			// real risk this step carries; TypeScript's own installer passes this too
			'--ignore-scripts',
			'--no-save',
			'--no-audit',
			'--no-fund',
			'--prefix', prefix,
			`${packageName}@${version}`
		];

		let result;
		try {
			result = await this.run('npm', args, {});
		} catch (error) {
			logger.log(`Could not run npm to fetch ${packageName}@${version}: ${message(error)}`);
			return;
		}

		if (result.code !== 0) {
			logger.log(`npm could not fetch ${packageName}@${version}: ${result.stderr.trim() || `exit ${result.code}`}`);
			return;
		}

		// a zero exit is not proof the package is there, and a path that does not exist would
		// fail later and much further from the cause
		if (!await isComplete(prefix)) {
			logger.log(`npm reported success but ${packageName}@${version} is not at ${installed}`);
			return;
		}

		return installed;
	}
}

/**
 * Where npm puts the package under an install prefix
 *
 * @param prefix - The directory npm installed into
 * @returns {string} The package's directory
 */
function packageIn (prefix: string): string {
	return path.join(prefix, 'node_modules', '@types', 'titanium');
}

/**
 * Whether an install prefix holds a usable copy of the package.
 *
 * The declarations are the test rather than the directory, because npm makes the directory before
 * it has extracted anything into it. `index.d.ts` is the entry every published version names.
 *
 * @param prefix - The directory npm installed into
 * @returns {Promise<boolean>} Whether the package is there in full
 */
async function isComplete (prefix: string): Promise<boolean> {
	return pathExists(path.join(packageIn(prefix), 'index.d.ts'));
}

/**
 * An error's message, whatever was thrown
 *
 * @param error - The thrown value
 * @returns {string} Something printable
 */
function message (error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
