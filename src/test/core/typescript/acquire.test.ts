import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NpmAcquirer, typesCacheRoot } from '../../../core/typescript/acquire.ts';
import type { CommandResult, CommandRunner } from '../../../core/command.ts';

/** Every npm invocation a test made, so the arguments can be asserted rather than the effect */
interface Recorded {
	command: string;
	args: string[];
}

/**
 * A command runner that answers from a script rather than spawning anything
 *
 * @param answers - What to answer, in call order
 * @returns The runner and the calls it recorded
 */
function fakeRunner (answers: CommandResult[]): { run: CommandRunner; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let next = 0;

	return {
		calls,
		run: async (command, args) => {
			calls.push({ command, args });
			return answers[next++] ?? { code: 1, stdout: '', stderr: 'no answer scripted' };
		}
	};
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

/**
 * A cache root of its own, in a temporary directory.
 *
 * Every acquirer a test builds gets one. `NpmAcquirer` defaults to `~/.titanium/types`, and
 * `versions` writes the record of its check there, so an acquirer built without one would have
 * `npm test` writing into the home directory of whoever ran it.
 *
 * @returns {Promise<string>} An empty directory
 */
async function cacheRoot (): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-acquire-'));
}

describe('Acquiring @types/titanium', () => {

	describe('the cache directory', () => {
		it('should key the cache on the version, so two projects on different SDKs coexist', async () => {
			// the same shape TypeScript's own automatic type acquisition uses
			const root = await cacheRoot();
			const { run, calls } = fakeRunner([ ok(''), ok('') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			await acquirer.install('9.2.2');
			await acquirer.install('13.3.0');

			const prefixes = calls.map(call => call.args[call.args.indexOf('--prefix') + 1]);
			assert.deepEqual(prefixes, [ path.join(root, '9.2.2'), path.join(root, '13.3.0') ]);
		});

		it('should be an absolute path', () => {
			assert.ok(path.isAbsolute(typesCacheRoot()));
		});
	});

	describe('listing published versions', () => {
		it('should read the versions npm reports', async () => {
			const { run, calls } = fakeRunner([ ok('["9.2.2","12.0.8","13.3.0"]') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: await cacheRoot() });

			assert.deepEqual(await acquirer.versions(), [ '9.2.2', '12.0.8', '13.3.0' ]);
			assert.equal(calls[0].command, 'npm');
			assert.ok(calls[0].args.includes('@types/titanium'), 'should ask npm about the types package');
			assert.ok(calls[0].args.includes('--json'), 'should ask for JSON rather than parsing npm prose');
		});

		it('should read a single version, which npm reports unwrapped', async () => {
			// `npm view <pkg> versions --json` answers with a bare string when only one exists
			const { run } = fakeRunner([ ok('"13.3.0"') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: await cacheRoot() });

			assert.deepEqual(await acquirer.versions(), [ '13.3.0' ]);
		});

		it('should answer nothing when npm cannot reach the registry', async () => {
			// a locked-down machine is not an error worth throwing over: the resolver falls through
			// to reporting that nothing resolved
			const { run } = fakeRunner([ failed('ENOTFOUND registry.npmjs.org') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: await cacheRoot() });

			assert.deepEqual(await acquirer.versions(), []);
		});

		it('should answer nothing when npm is not on the path at all', async () => {
			const acquirer = new NpmAcquirer({
				run: async () => {
					throw new Error('spawn npm ENOENT');
				},
				cacheRoot: await cacheRoot()
			});

			assert.deepEqual(await acquirer.versions(), []);
		});

		it('should answer nothing when npm prints something that is not JSON', async () => {
			const { run } = fakeRunner([ ok('npm warn deprecated something') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: await cacheRoot() });

			assert.deepEqual(await acquirer.versions(), []);
		});
	});

	describe('when the registry was last asked', () => {
		it('should answer nothing on a machine that has never asked', async () => {
			const root = await cacheRoot();

			assert.equal(await new NpmAcquirer({ cacheRoot: root }).checked(), undefined);
		});

		it('should answer nothing when there is no cache directory at all', async () => {
			const root = path.join(await cacheRoot(), 'never-created');

			assert.equal(await new NpmAcquirer({ cacheRoot: root }).checked(), undefined);
		});

		it('should record the check when npm answered', async () => {
			const root = await cacheRoot();
			const { run } = fakeRunner([ ok('["13.3.0"]') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			const before = Date.now();
			await acquirer.versions();
			const checked = await acquirer.checked();

			assert.ok(checked !== undefined, 'expected the check to have been recorded');
			assert.ok(checked >= before - 1000 && checked <= Date.now() + 1000, `${checked} is not around now`);
		});

		it('should create the cache directory to record the check in', async () => {
			// the first ever run asks the registry before anything has been installed, so there is
			// no directory yet
			const root = path.join(await cacheRoot(), 'not-yet');
			const { run } = fakeRunner([ ok('["13.3.0"]') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			await acquirer.versions();

			assert.notEqual(await acquirer.checked(), undefined);
		});

		it('should not record a check the registry could not answer', async () => {
			// a failed check establishes nothing about what is published, so letting it stand in
			// for a real one would pin the machine to its cache on the strength of a failure
			const root = await cacheRoot();
			const { run } = fakeRunner([ failed('ENOTFOUND registry.npmjs.org') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			await acquirer.versions();

			assert.equal(await acquirer.checked(), undefined);
		});

		it('should not record a check npm could not even be spawned for', async () => {
			const root = await cacheRoot();
			const acquirer = new NpmAcquirer({
				run: async () => {
					throw new Error('spawn npm ENOENT');
				},
				cacheRoot: root
			});

			await acquirer.versions();

			assert.equal(await acquirer.checked(), undefined);
		});

		it('should answer nothing when the record is not a timestamp', async () => {
			// a hand-edited or truncated file reads as never having asked, which costs one npm run
			// rather than an answer nobody can account for
			const root = await cacheRoot();
			await fs.writeFile(path.join(root, '.last-registry-check'), 'whenever');

			assert.equal(await new NpmAcquirer({ cacheRoot: root }).checked(), undefined);
		});

		it('should not let the record be read as a cached version', async () => {
			const root = await cacheRoot();
			const { run } = fakeRunner([ ok('["13.3.0"]') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			await acquirer.versions();

			assert.deepEqual(await acquirer.cached(), [], 'the record is a file, and only directories are versions');
		});

		it('should survive a cache root it cannot write to', async () => {
			// a read-only home directory costs the staleness check and nothing else
			const root = await cacheRoot();
			await fs.chmod(root, 0o500);
			const { run } = fakeRunner([ ok('["13.3.0"]') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			assert.deepEqual(await acquirer.versions(), [ '13.3.0' ], 'the versions still answer');
			assert.equal(await acquirer.checked(), undefined);

			await fs.chmod(root, 0o700);
		});
	});

	describe('installing a version', () => {
		it('should install with --ignore-scripts', async () => {
			// a postinstall script from a fetched package running inside a language server is the
			// one risk this step actually carries, and it is what TypeScript's own installer does
			const root = await cacheRoot();
			const { run, calls } = fakeRunner([ ok('') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			await acquirer.install('13.3.0');

			assert.equal(calls[0].command, 'npm');
			assert.ok(calls[0].args.includes('--ignore-scripts'), `expected --ignore-scripts, got ${calls[0].args.join(' ')}`);
			assert.ok(calls[0].args.includes('@types/titanium@13.3.0'), 'should pin the exact version');
		});

		it('should answer where the package landed', async () => {
			const root = await cacheRoot();
			const installed = path.join(root, '13.3.0', 'node_modules', '@types', 'titanium');
			const { run } = fakeRunner([ ok('') ]);
			const acquirer = new NpmAcquirer({
				run: async (command: string, args: string[], options: { cwd?: string }) => {
					// npm would have written the package; the fake has to as well
					await fs.mkdir(installed, { recursive: true });
					await fs.writeFile(path.join(installed, 'index.d.ts'), 'declare const Ti: unknown;');
					return run(command, args, options);
				},
				cacheRoot: root
			});

			assert.equal(await acquirer.install('13.3.0'), installed);
		});

		it('should not run npm again for a version already in the cache', async () => {
			// the second project on the same SDK, and every restart after the first, should cost
			// nothing and work offline
			const root = await cacheRoot();
			const installed = path.join(root, '13.3.0', 'node_modules', '@types', 'titanium');
			await fs.mkdir(installed, { recursive: true });
			await fs.writeFile(path.join(installed, 'index.d.ts'), 'declare const Ti: unknown;');

			const { run, calls } = fakeRunner([ ok('') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			assert.equal(await acquirer.install('13.3.0'), installed);
			assert.deepEqual(calls, [], 'should not have spawned npm at all');
		});

		it('should run npm again over a package that was only partly written', async () => {
			// the directory alone is not a cache hit: without its declarations it is a failed
			// install, and answering it would fail later with nothing retried
			const root = await cacheRoot();
			await fs.mkdir(path.join(root, '13.3.0', 'node_modules', '@types', 'titanium'), { recursive: true });

			const { run, calls } = fakeRunner([ ok('') ]);
			await new NpmAcquirer({ run, cacheRoot: root }).install('13.3.0');

			assert.equal(calls.length, 1, 'expected npm to be run to repair it');
		});

		it('should answer nothing when the install fails', async () => {
			const root = await cacheRoot();
			const { run } = fakeRunner([ failed('ENOTFOUND registry.npmjs.org') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			assert.equal(await acquirer.install('13.3.0'), undefined);
		});

		it('should answer nothing when npm reports success but writes no package', async () => {
			// npm exiting zero is not proof the package is there, and a path that does not exist
			// would fail later and further away
			const root = await cacheRoot();
			const { run } = fakeRunner([ ok('') ]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: root });

			assert.equal(await acquirer.install('13.3.0'), undefined);
		});

		it('should answer nothing when npm cannot be spawned', async () => {
			const root = await cacheRoot();
			const acquirer = new NpmAcquirer({
				run: async () => {
					throw new Error('spawn npm ENOENT');
				},
				cacheRoot: root
			});

			assert.equal(await acquirer.install('13.3.0'), undefined);
		});
	});

	describe('the versions already fetched', () => {
		/**
		 * A cache holding a fetched copy of each version given
		 *
		 * @param versions - The versions to lay down
		 * @returns {Promise<string>} The cache root
		 */
		async function cacheWith (...versions: string[]): Promise<string> {
			const root = await cacheRoot();
			for (const version of versions) {
				const installed = path.join(root, version, 'node_modules', '@types', 'titanium');
				await fs.mkdir(installed, { recursive: true });
				await fs.writeFile(path.join(installed, 'index.d.ts'), 'declare const Ti: unknown;');
			}
			return root;
		}

		it('should list every version in the cache, without running npm', async () => {
			const { run, calls } = fakeRunner([]);
			const acquirer = new NpmAcquirer({ run, cacheRoot: await cacheWith('9.2.2', '12.0.8') });

			assert.deepEqual((await acquirer.cached()).sort(), [ '12.0.8', '9.2.2' ]);
			assert.deepEqual(calls, [], 'reading the cache is what works offline, so it must not spawn');
		});

		it('should leave out a version whose install never finished', async () => {
			// npm creates the prefix before it has fetched anything, so a directory named for a
			// version is not proof the version is there
			const root = await cacheWith('12.0.8');
			await fs.mkdir(path.join(root, '13.3.0', 'node_modules'), { recursive: true });

			assert.deepEqual(await new NpmAcquirer({ cacheRoot: root }).cached(), [ '12.0.8' ]);
		});

		it('should leave out a version whose package was only partly written', async () => {
			// an install interrupted part way through extracting: the package directory is there,
			// its declarations are not
			const root = await cacheWith('12.0.8');
			await fs.mkdir(path.join(root, '13.3.0', 'node_modules', '@types', 'titanium'), { recursive: true });

			assert.deepEqual(await new NpmAcquirer({ cacheRoot: root }).cached(), [ '12.0.8' ]);
		});

		it('should leave out anything that is not a directory', async () => {
			const root = await cacheWith('12.0.8');
			await fs.writeFile(path.join(root, '13.3.0'), '');

			assert.deepEqual(await new NpmAcquirer({ cacheRoot: root }).cached(), [ '12.0.8' ]);
		});

		it('should answer nothing when there is no cache yet', async () => {
			const root = path.join(os.tmpdir(), 'ti-ls-acquire-never-created');

			assert.deepEqual(await new NpmAcquirer({ cacheRoot: root }).cached(), []);
		});
	});
});

describe('Where the cache lives', () => {
	it('should sit under .titanium in the home directory, with the rest of the Titanium tooling', () => {
		const cached = typesCacheRoot({});

		assert.ok(cached.startsWith(path.join(os.homedir(), '.titanium')),
			`expected a path under ~/.titanium, got ${cached}`);
	});

	it('should move under the directory TITANIUM_LANGUAGE_SERVER_TYPES_CACHE names', () => {
		// what lets a spawned server, which takes no constructor arguments, install somewhere other
		// than the home directory of whoever runs the tests
		const root = path.join(os.tmpdir(), 'elsewhere');

		assert.equal(typesCacheRoot({ TITANIUM_LANGUAGE_SERVER_TYPES_CACHE: root }), root);
	});

	it('should resolve a relative directory to an absolute one', () => {
		const cached = typesCacheRoot({ TITANIUM_LANGUAGE_SERVER_TYPES_CACHE: 'relative' });

		assert.ok(path.isAbsolute(cached), `expected an absolute path, got ${cached}`);
	});

	it('should ignore the variable when it is set to nothing', () => {
		// an empty value is how a shell unsets it for one command, and it must not mean the
		// current directory
		assert.equal(typesCacheRoot({ TITANIUM_LANGUAGE_SERVER_TYPES_CACHE: '' }), typesCacheRoot({}));
	});

	it('should read the process environment when none is given', () => {
		const saved = process.env.TITANIUM_LANGUAGE_SERVER_TYPES_CACHE;
		const root = path.join(os.tmpdir(), 'from-the-process');
		process.env.TITANIUM_LANGUAGE_SERVER_TYPES_CACHE = root;
		try {
			assert.equal(typesCacheRoot(), root);
		} finally {
			if (saved === undefined) {
				delete process.env.TITANIUM_LANGUAGE_SERVER_TYPES_CACHE;
			} else {
				process.env.TITANIUM_LANGUAGE_SERVER_TYPES_CACHE = saved;
			}
		}
	});

	it('should name what it holds, so the directory is identifiable on disk', () => {
		// the neighbouring directories — mobilesdk, modules, completions — are named for their
		// contents rather than for the tool that wrote them
		assert.ok(typesCacheRoot({}).endsWith('types'));
	});
});
