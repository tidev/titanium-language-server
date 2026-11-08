import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Project } from '../../../core/project.ts';
import { AcquiredTypes, ProjectTypes, resolveTypes } from '../../../core/typescript/types.ts';
import type { TypesAcquirer } from '../../../core/typescript/acquire.ts';
import { fixturePath } from '../../fixtures.ts';

/**
 * Loads a fixture project
 *
 * @param name - The fixture directory name
 * @returns {Promise<Project>} The loaded project
 */
async function project (name: string): Promise<Project> {
	const loaded = new Project(await fixturePath(name));
	await loaded.load();
	return loaded;
}

/** The majors DefinitelyTyped publishes, per `npm view @types/titanium versions` */
const published = [ '3.5.30', '7.3.1', '8.0.5', '9.2.2', '12.0.8', '13.3.0' ];

/**
 * An acquirer that installs into a temporary directory rather than fetching anything
 *
 * @param available - The versions it should claim are published
 * @returns The acquirer and the versions it was asked to install
 */
function fakeAcquirer (available: string[] = published, cached: string[] = [], checked?: number): { acquirer: TypesAcquirer; installed: string[]; asked: () => number } {
	const installed: string[] = [];
	let asked = 0;

	return {
		installed,
		asked: () => asked,
		acquirer: {
			versions: async () => {
				asked++;
				return available;
			},
			cached: async () => cached,
			checked: async () => checked,
			install: async version => {
				installed.push(version);
				const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-types-'));
				const target = path.join(root, 'node_modules', '@types', 'titanium');
				await fs.mkdir(target, { recursive: true });
				await fs.writeFile(path.join(target, 'index.d.ts'), 'declare const Ti: unknown;');
				await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({ name: '@types/titanium', version }));
				return target;
			}
		}
	};
}

/** An acquirer that can reach nothing, which is a locked-down machine */
const offlineAcquirer: TypesAcquirer = {
	versions: async () => [],
	cached: async () => [],
	checked: async () => undefined,
	install: async () => undefined
};

/** A check recorded just now, which is a cache the registry was asked about this session */
const justNow = (): number => Date.now();

/** A check recorded two days ago, which is past the staleness window */
const longAgo = (): number => Date.now() - (2 * 24 * 60 * 60 * 1000);

describe('Resolving @types/titanium', () => {

	describe('the project\'s own types', () => {
		it('should find a copy the project has installed', async () => {
			// the build is the authority: whatever the project compiles against is what the editor
			// should answer from
			const resolved = await new ProjectTypes().locate(await project('classic-project'));

			assert.ok(resolved?.location, 'expected the fixture\'s own types to be found');
			assert.equal(resolved.location.version, '9.2.2');
			assert.ok(resolved.location.entry.endsWith('index.d.ts'));
		});

		it('should prefer the project\'s copy even when its version does not match the SDK', async () => {
			// classic-project declares sdk-version 12.4.0.GA and installs 9.2.2 types; the version
			// rule does not get a say, because the project has already made the choice
			const resolved = await new ProjectTypes().locate(await project('classic-project'));

			assert.equal(resolved?.location?.version, '9.2.2');
			assert.equal(resolved?.report.level, 'info', 'the project\'s own choice is not a fallback to warn about');
		});

		it('should find nothing when the project has not installed them', async () => {
			assert.equal(await new ProjectTypes().locate(await project('alloy-project')), undefined);
		});
	});

	describe('acquired types', () => {
		it('should acquire the newest release of the SDK\'s own major', async () => {
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.deepEqual(installed, [ '12.0.8' ], 'sdk-version 12.4.0.GA should take the newest 12.x');
			assert.equal(resolved?.report.level, 'info', 'trailing inside a major is the common case and should stay quiet');
		});

		it('should fall back across the gap and say so', async () => {
			// alloy-project declares 10.1.0.GA, and DefinitelyTyped publishes no 10.x or 11.x
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await new AcquiredTypes(acquirer).locate(await project('alloy-project'));

			assert.deepEqual(installed, [ '9.2.2' ]);
			assert.equal(resolved?.report.level, 'warning', 'crossing a major is worth telling the user about');
			assert.match(resolved.report.message, /10\.1\.0/, 'should name the sdk-version that could not be satisfied');
		});

		it('should report a failure when nothing is published at or below the SDK', async () => {
			const { acquirer, installed } = fakeAcquirer([ '13.3.0' ]);

			const resolved = await new AcquiredTypes(acquirer).locate(await project('alloy-project'));

			assert.equal(resolved, undefined, 'nothing resolved, so the next source gets a turn');
			assert.deepEqual(installed, [], 'should not install a major above the SDK');
		});

		it('should resolve nothing when the registry cannot be reached', async () => {
			assert.equal(await new AcquiredTypes(offlineAcquirer).locate(await project('alloy-project')), undefined);
		});

		it('should answer from the cache when the registry cannot be reached', async () => {
			// a machine that fetched once and has since gone offline — a laptop on a train — has
			// everything it needs on disk, and the registry's list is only how a version is chosen
			const { acquirer, installed } = fakeAcquirer([], [ '9.2.2', '12.0.8' ]);

			const resolved = await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.deepEqual(installed, [ '12.0.8' ], 'the same rule, over what is cached');
			assert.equal(resolved?.location?.version, '12.0.8');
			assert.match(resolved.report.message, /could not be reached/, 'should say why it chose from the cache');
		});

		it('should not claim a major is unpublished when it could not ask the registry', async () => {
			// alloy-project is on SDK 10.1.0.GA and only 9.2.2 is cached. Offline, whether a 10.x
			// exists is unknown, and saying none is published would be telling the user something
			// nobody checked
			const { acquirer } = fakeAcquirer([], [ '9.2.2' ]);

			const resolved = await new AcquiredTypes(acquirer).locate(await project('alloy-project'));

			assert.equal(resolved?.location?.version, '9.2.2');
			assert.equal(resolved.report.level, 'warning', 'an older major is still worth telling the user about');
			assert.match(resolved.report.message, /could not be reached/);
			assert.doesNotMatch(resolved.report.message, /is published/);
		});

		it('should prefer the registry over the cache when it can be reached', async () => {
			// a cached 12.0.2 must not stand in the way of a 12.0.8 published since
			const { acquirer, installed } = fakeAcquirer(published, [ '12.0.2' ]);

			await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.deepEqual(installed, [ '12.0.8' ]);
		});

		it('should resolve nothing offline when the cache holds nothing for the SDK', async () => {
			const { acquirer } = fakeAcquirer([], [ '13.3.0' ]);

			assert.equal(await new AcquiredTypes(acquirer).locate(await project('alloy-project')), undefined);
		});

		it('should answer from a recently checked cache without asking npm at all', async () => {
			// the measured cost of the first request: two `npm view` spawns, one per project in the
			// workspace, each establishing a version already sitting on disk
			const { acquirer, installed, asked } = fakeAcquirer(published, [ '12.0.8' ], justNow());

			const resolved = await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.equal(asked(), 0, 'the registry must not be asked when the cache was just checked');
			assert.deepEqual(installed, [ '12.0.8' ]);
			assert.equal(resolved?.location?.version, '12.0.8');
			assert.equal(resolved.report.level, 'info');
		});

		it('should not say the registry was unreachable when it was simply not asked', async () => {
			// the two conditions are different and the message must not collapse them: a fresh
			// cache answered on purpose, and an unreachable registry answered for want of anything
			// better
			const { acquirer } = fakeAcquirer(published, [ '12.0.8' ], justNow());

			const resolved = await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.doesNotMatch(resolved?.report.message ?? '', /could not be reached/);
			assert.match(resolved?.report.message ?? '', /from the cache/, 'should still say where it came from');
			assert.match(resolved?.report.message ?? '', /last asked/, 'should say when npm was last asked, so the user can see why');
		});

		it('should ask npm again once the cache has gone stale', async () => {
			// a staleness window rather than a machine pinned forever to whatever it fetched first
			const { acquirer, installed, asked } = fakeAcquirer(published, [ '12.0.2' ], longAgo());

			await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.equal(asked(), 1);
			assert.deepEqual(installed, [ '12.0.8' ], 'the newer release published since should win');
		});

		it('should ask npm when nothing has ever been checked', async () => {
			const { acquirer, asked } = fakeAcquirer(published, [ '12.0.8' ], undefined);

			await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.equal(asked(), 1, 'a cache nobody has checked says nothing about what is published');
		});

		it('should ask npm when the cache holds nothing for the SDK, however recently checked', async () => {
			const { acquirer, asked, installed } = fakeAcquirer(published, [], justNow());

			await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.equal(asked(), 1);
			assert.deepEqual(installed, [ '12.0.8' ]);
		});

		it('should ask npm rather than settle for a cached older major', async () => {
			// alloy-project is on 10.1.0.GA, and a cached 9.2.2 is the best the cache can do.
			// Crossing a major is the answer most worth getting right and the rarest, so it is
			// never taken on trust from a cache
			const { acquirer, asked } = fakeAcquirer(published, [ '9.2.2' ], justNow());

			const resolved = await new AcquiredTypes(acquirer).locate(await project('alloy-project'));

			assert.equal(asked(), 1);
			assert.match(resolved?.report.message ?? '', /is published/, 'the registry answered, so it can say so');
		});

		it('should treat a check recorded in the future as no check at all', async () => {
			// a clock moved backwards, or a cache copied from another machine
			const { acquirer, asked } = fakeAcquirer(published, [ '12.0.8' ], Date.now() + (60 * 60 * 1000));

			await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.equal(asked(), 1);
		});

		it('should still answer from the cache when a stale check cannot be refreshed', async () => {
			// the laptop on a train whose window has expired: the registry is asked, fails, and
			// the cache answers with the message that says so
			const { acquirer } = fakeAcquirer([], [ '12.0.8' ], longAgo());

			const resolved = await new AcquiredTypes(acquirer).locate(await project('classic-project'));

			assert.equal(resolved?.location?.version, '12.0.8');
			assert.match(resolved.report.message, /could not be reached/);
		});

		it('should resolve nothing when the install of a cached version fails', async () => {
			const acquirer: TypesAcquirer = {
				versions: async () => published,
				cached: async () => [ '12.0.8' ],
				checked: async () => justNow(),
				install: async () => undefined
			};

			assert.equal(await new AcquiredTypes(acquirer).locate(await project('classic-project')), undefined);
		});

		it('should resolve nothing when the install itself fails', async () => {
			const acquirer: TypesAcquirer = {
				versions: async () => published,
				cached: async () => [],
				checked: async () => undefined,
				install: async () => undefined
			};

			assert.equal(await new AcquiredTypes(acquirer).locate(await project('alloy-project')), undefined);
		});
	});

	describe('resolution order', () => {
		it('should prefer the project\'s own types over acquiring', async () => {
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await resolveTypes(await project('classic-project'), [ new ProjectTypes(), new AcquiredTypes(acquirer) ]);

			assert.equal(resolved.location?.version, '9.2.2');
			assert.deepEqual(installed, [], 'should not have reached for the network at all');
		});

		it('should acquire when the project has no types of its own', async () => {
			const { acquirer, installed } = fakeAcquirer();

			const resolved = await resolveTypes(await project('alloy-project'), [ new ProjectTypes(), new AcquiredTypes(acquirer) ]);

			assert.ok(resolved.location);
			assert.deepEqual(installed, [ '9.2.2' ]);
		});

		it('should take the first source that answers, so a new source can slot in ahead', async () => {
			// types published in the SDK itself are being pursued upstream and would sit between
			// the project's own copy and npm; nothing here should need changing when they land
			const { acquirer } = fakeAcquirer();
			const fromTheSdk = {
				name: 'the SDK',
				locate: async () => ({
					location: { packagePath: '/sdk', entry: '/sdk/index.d.ts', version: '13.4.1', source: 'the SDK' },
					report: { level: 'info' as const, message: 'from the SDK' }
				})
			};

			const resolved = await resolveTypes(await project('alloy-project'), [ new ProjectTypes(), fromTheSdk, new AcquiredTypes(acquirer) ]);

			assert.equal(resolved.location?.source, 'the SDK');
		});

		it('should report clearly when no source can answer', async () => {
			// the failure case is a feature: say which sdk-version could not be satisfied and what
			// would fix it, rather than answering from something stale
			const resolved = await resolveTypes(await project('alloy-project'), [ new ProjectTypes(), new AcquiredTypes(offlineAcquirer) ]);

			assert.equal(resolved.location, undefined);
			assert.equal(resolved.report.level, 'warning');
			assert.match(resolved.report.message, /10\.1\.0/, 'should name the sdk-version');
			assert.match(resolved.report.message, /@types\/titanium/, 'should name what would fix it');
		});

		it('should report clearly when there are no sources at all', async () => {
			const resolved = await resolveTypes(await project('alloy-project'), []);

			assert.equal(resolved.location, undefined);
			assert.equal(resolved.report.level, 'warning');
		});
	});
});
