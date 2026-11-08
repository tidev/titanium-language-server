import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { TitaniumCli, mobileSdkHost, sdkDirectories, sdkInstallLocations } from '../../core/titanium.ts';
import type { CommandResult, CommandRunner } from '../../core/command.ts';
import { logger } from '../../logger.ts';

/** `ti sdk list -o json` as titanium 9.1.0 prints it, trimmed to the fields that matter */
function sdkList (installed: Record<string, string>, installLocations: string[] = [ '/home/me/.titanium' ]): string {
	return JSON.stringify({
		branch: {},
		branches: { defaultBranch: 'main', branches: [] },
		defaultInstallLocation: installLocations[0],
		installLocations,
		installed,
		releases: {},
		sdks: Object.fromEntries(Object.entries(installed).map(([ version, sdkPath ]) => [ version, { name: version, path: sdkPath }]))
	}, null, '\t');
}

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });

interface Call {
	command: string;
	args: string[];
	timeout?: number;
}

/**
 * A runner that answers `ti sdk list` and `ti config` from whatever the test has set, and counts
 * how often it was asked
 *
 * @param answer - What each subcommand answers, or a rejection for a CLI that is not there
 * @returns The runner and its calls
 */
function fakeTi (answer: { sdk: () => Promise<CommandResult>; config?: () => Promise<CommandResult> }): { run: CommandRunner; calls: Call[] } {
	const calls: Call[] = [];

	return {
		calls,
		run: async (command, args, options) => {
			calls.push({ command, args, timeout: options.timeout });
			return args[0] === 'sdk' ? answer.sdk() : (answer.config ?? (async () => ok('[]')))();
		}
	};
}

/** Lets a background refresh that has been answered finish settling */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const missing = async (): Promise<CommandResult> => {
	throw Object.assign(new Error('spawn ti ENOENT'), { code: 'ENOENT' });
};

describe('The Titanium CLI', () => {

	afterEach(() => logger.detach());

	it('should ask for the installed SDKs and the configured module paths as JSON', async () => {
		const { run, calls } = fakeTi({ sdk: async () => ok(sdkList({})) });

		await new TitaniumCli({ run }).installed();

		assert.deepEqual(calls.map(call => [ call.command, ...call.args ]).sort(), [
			[ 'ti', 'config', 'paths.modules', '-o', 'json' ],
			[ 'ti', 'sdk', 'list', '-o', 'json' ]
		]);
		assert.ok(calls.every(call => call.timeout && call.timeout > 0), 'a hung CLI must not hang a completion');
	});

	it('should answer the installed SDKs in the order the CLI gives them, newest first', async () => {
		const { run } = fakeTi({ sdk: async () => ok(sdkList({ '13.0.0.GA': '/sdk/13.0.0.GA', '12.4.0.GA': '/sdk/12.4.0.GA', '9.3.2.GA': '/sdk/9.3.2.GA' })) });

		const found = await new TitaniumCli({ run }).installed();

		assert.deepEqual(found.sdks, [
			{ version: '13.0.0.GA', path: '/sdk/13.0.0.GA' },
			{ version: '12.4.0.GA', path: '/sdk/12.4.0.GA' },
			{ version: '9.3.2.GA', path: '/sdk/9.3.2.GA' }
		]);
	});

	it('should find the global modules under each install location, and in the configured paths', async () => {
		const { run } = fakeTi({
			sdk: async () => ok(sdkList({}, [ '/home/me/.titanium', '/opt/titanium' ])),
			config: async () => ok(JSON.stringify([ '/work/shared-modules' ]))
		});

		const found = await new TitaniumCli({ run }).installed();

		assert.deepEqual(found.moduleDirectories, [
			path.join('/home/me/.titanium', 'modules'),
			path.join('/opt/titanium', 'modules'),
			path.resolve('/work/shared-modules')
		]);
	});

	it('should expand a configured path that starts with a tilde, as the CLI does', async () => {
		const { run } = fakeTi({ sdk: async () => ok(sdkList({}, [])), config: async () => ok(JSON.stringify('~/modules')) });

		const found = await new TitaniumCli({ run }).installed();

		assert.deepEqual(found.moduleDirectories, [ path.join(os.homedir(), 'modules') ]);
	});

	it('should answer nothing, and say so once, when ti is not on the PATH', async () => {
		const { run } = fakeTi({ sdk: missing, config: missing });
		const logs: string[] = [];
		logger.attach({ log: (message: string) => logs.push(message), error: (message: string) => logs.push(message) });
		const cli = new TitaniumCli({ run });

		assert.deepEqual(await cli.installed(), { sdks: [], moduleDirectories: [] });
		await cli.installed();
		await settle();
		await cli.installed();
		await settle();

		assert.equal(logs.filter(line => line.includes('ti')).length, 1, `expected one line, got ${JSON.stringify(logs)}`);
	});

	it('should answer nothing when the CLI fails or prints something that is not JSON', async () => {
		const failing = fakeTi({ sdk: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
		const garbled = fakeTi({ sdk: async () => ok('A new version of titanium is available') });

		assert.deepEqual((await new TitaniumCli({ run: failing.run }).installed()).sdks, []);
		assert.deepEqual((await new TitaniumCli({ run: garbled.run }).installed()).sdks, []);
	});

	it('should keep the SDKs when only the module paths could not be read', async () => {
		const { run } = fakeTi({ sdk: async () => ok(sdkList({ '12.4.0.GA': '/sdk/12.4.0.GA' }, [])), config: missing });

		const found = await new TitaniumCli({ run }).installed();

		assert.deepEqual(found.sdks.map(sdk => sdk.version), [ '12.4.0.GA' ]);
	});

	it('should say so when only the module paths could not be read', async () => {
		// the CLI's defaults set paths.modules to an empty list, so it answering at all is normal
		// and its failing is a problem worth a line: the global modules it names go missing
		const { run } = fakeTi({ sdk: async () => ok(sdkList({ '12.4.0.GA': '/sdk/12.4.0.GA' }, [])), config: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
		const logs: string[] = [];
		logger.attach({ log: (message: string) => logs.push(message), error: (message: string) => logs.push(message) });

		await new TitaniumCli({ run }).installed();

		assert.equal(logs.filter(line => line.includes('paths.modules')).length, 1, `expected one line, got ${JSON.stringify(logs)}`);
	});

	it('should ignore the parts of the answer that are not the shape it expects', async () => {
		const { run } = fakeTi({
			sdk: async () => ok(JSON.stringify({ installed: { '12.4.0.GA': 12, '13.0.0.GA': '/sdk/13' }, installLocations: 'not a list' })),
			config: async () => ok(JSON.stringify({ not: 'a path' }))
		});

		assert.deepEqual(await new TitaniumCli({ run }).installed(), { sdks: [ { version: '13.0.0.GA', path: '/sdk/13' } ], moduleDirectories: [] });
	});

	describe('caching', () => {
		it('should answer from the cache at once and refresh it in the background', async () => {
			// an SDK list changes on install rather than on keystroke, so nothing waits on the CLI
			// once it has answered once — but an SDK installed mid-session still shows up
			let current = sdkList({ '12.4.0.GA': '/sdk/12.4.0.GA' });
			const { run, calls } = fakeTi({ sdk: async () => ok(current) });
			const cli = new TitaniumCli({ run });

			assert.deepEqual((await cli.installed()).sdks.map(sdk => sdk.version), [ '12.4.0.GA' ]);

			current = sdkList({ '13.0.0.GA': '/sdk/13.0.0.GA', '12.4.0.GA': '/sdk/12.4.0.GA' });
			assert.deepEqual((await cli.installed()).sdks.map(sdk => sdk.version), [ '12.4.0.GA' ], 'the cached answer, at once');

			await settle();
			assert.deepEqual((await cli.installed()).sdks.map(sdk => sdk.version), [ '13.0.0.GA', '12.4.0.GA' ], 'the refreshed answer');
			assert.ok(calls.filter(call => call.args[0] === 'sdk').length >= 2);
		});

		it('should run one refresh at a time however many completions ask', async () => {
			let release: (() => void)|undefined;
			const { run, calls } = fakeTi({
				sdk: () => new Promise(resolve => {
					release = () => resolve(ok(sdkList({})));
				})
			});
			const cli = new TitaniumCli({ run });

			const first = Promise.all([ cli.installed(), cli.installed(), cli.installed() ]);
			await settle();
			(release as () => void)();
			await first;

			assert.equal(calls.filter(call => call.args[0] === 'sdk').length, 1);
		});

		it('should notice ti once it has been installed', async () => {
			let sdk = missing;
			const { run } = fakeTi({ sdk: () => sdk() });
			const cli = new TitaniumCli({ run });

			assert.deepEqual((await cli.installed()).sdks, []);

			sdk = async () => ok(sdkList({ '13.0.0.GA': '/sdk/13.0.0.GA' }));
			await cli.installed();
			await settle();

			assert.deepEqual((await cli.installed()).sdks.map(found => found.version), [ '13.0.0.GA' ]);
		});
	});
});

describe('Where SDKs are installed', () => {

	it('should name the mobilesdk host directory the way the CLI does', () => {
		// `mobilesdk/<host>` is the CLI's own `process.platform === 'darwin' ? 'osx' : platform`,
		// so darwin is the one that differs from Node's name for it
		assert.equal(mobileSdkHost('darwin'), 'osx');
		assert.equal(mobileSdkHost('linux'), 'linux');
		assert.equal(mobileSdkHost('win32'), 'win32');
	});

	it('should treat an unsupported platform as linux, which is what its layout looks like', () => {
		assert.equal(mobileSdkHost('freebsd'), 'linux');
	});

	it('should look under the home directory and the machine on macOS, in that order', () => {
		// the CLI prefers the user's own install over the shared one, and so must this
		const locations = sdkInstallLocations('darwin', {}, '/Users/me');

		assert.deepEqual(locations, [
			path.join('/Users/me', 'Library', 'Application Support', 'Titanium'),
			path.join('/', 'Library', 'Application Support', 'Titanium')
		]);
	});

	it('should look under ~/.titanium on Linux', () => {
		assert.deepEqual(sdkInstallLocations('linux', {}, '/home/me'), [ path.join('/home/me', '.titanium') ]);
	});

	it('should read the Windows locations from the environment, as the CLI expands them', () => {
		const locations = sdkInstallLocations('win32', { ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me');

		assert.deepEqual(locations, [
			path.join('C:\\ProgramData', 'Titanium'),
			path.join('C:\\Users\\me\\AppData\\Roaming', 'Titanium')
		]);
	});

	it('should leave out a Windows location the environment does not set', () => {
		// a variable that is not set must not become a relative path rooted at the server's cwd
		assert.deepEqual(sdkInstallLocations('win32', { ProgramData: 'C:\\ProgramData' }, 'C:\\Users\\me'), [ path.join('C:\\ProgramData', 'Titanium') ]);
	});

	it('should answer where a version would be installed, under each location', () => {
		const directories = sdkDirectories('12.4.0.GA', 'linux', {}, '/home/me');

		assert.deepEqual(directories, [ path.join('/home/me', '.titanium', 'mobilesdk', 'linux', '12.4.0.GA') ]);
	});

	it('should not read the machine when it is given a version that is not one', () => {
		// a tiapp with a blank or junk sdk-version must not turn into a path into the SDK root
		assert.deepEqual(sdkDirectories('', 'linux', {}, '/home/me'), []);
		assert.deepEqual(sdkDirectories('../../etc', 'linux', {}, '/home/me'), []);
		assert.deepEqual(sdkDirectories('13.2.0.GA/..', 'linux', {}, '/home/me'), []);
	});

	it('should default to this machine, so a caller need not know the platform', () => {
		const directories = sdkDirectories('12.4.0.GA');

		assert.ok(directories.length, 'every supported platform has at least one location');
		assert.ok(directories.every(directory => path.isAbsolute(directory)));
		assert.ok(directories.every(directory => directory.endsWith(path.join('mobilesdk', mobileSdkHost(), '12.4.0.GA'))));
	});
});
