import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CompletionItem, InitializeResult } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { LspTestClient } from '../server/lsp-client.ts';
import { fixturePath } from '../fixtures.ts';

/**
 * Fetching `@types/titanium` for real, the way a user without it installed meets the server.
 *
 * Every other tier keeps the server off the registry, so this is the one place the acquisition
 * path runs as shipped: a spawned server, the real npm, the real registry and the real package,
 * with nothing injected but where the cache lives. It is its own tier with its own CI job so that
 * a registry outage fails this job alone rather than every job in the matrix.
 *
 * The tests share one cache and run in order: the later ones depend on what the earlier ones
 * fetched, which is the point — a second run against a warm cache is the behaviour being tested.
 */

/** Fetching and parsing a 2.3MB declaration file is slow on a cold runner */
const TIMEOUT = 180_000;

/**
 * A server with a workspace open on one project, ready to be asked
 *
 * @param fixture - The fixture directory name
 * @param typesCache - The shared cache
 * @param network - Whether npm may reach the registry
 * @returns The client and the project root
 */
async function serverOn (fixture: string, typesCache: string, network: boolean): Promise<{ client: LspTestClient; root: string }> {
	const root = await fixturePath(fixture);
	const client = new LspTestClient(undefined, undefined, { network, typesCache, timeout: TIMEOUT });

	await client.sendRequest<InitializeResult>('initialize', {
		processId: process.pid,
		rootUri: null,
		capabilities: { workspace: { workspaceFolders: true } },
		workspaceFolders: [ { uri: URI.file(root).toString(), name: fixture } ]
	});
	client.sendNotification('initialized', {});

	return { client, root };
}

/**
 * The completion labels where `|` marks the cursor in a document opened for the purpose
 *
 * @param client - The server
 * @param file - The document's path
 * @param languageId - What it is written in
 * @param text - Its contents, with `|` marking the cursor on the last line
 * @returns {Promise<string[]>} What is offered there
 */
async function labelsAt (client: LspTestClient, file: string, languageId: string, text: string): Promise<string[]> {
	const uri = URI.file(file).toString();
	const lines = text.split('\n');

	client.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text: text.replace('|', '') } });

	const items = await client.sendRequest<CompletionItem[]|null>('textDocument/completion', {
		textDocument: { uri },
		position: { line: lines.length - 1, character: lines[lines.length - 1].indexOf('|') }
	});

	return (items ?? []).map(item => item.label);
}

/**
 * The version the server said it is using, from its log
 *
 * @param client - The server
 * @returns {string|undefined} The version, when the server logged one
 */
function versionUsed (client: LspTestClient): string|undefined {
	for (const message of client.notifications) {
		const text = (message.params as { message?: string }|undefined)?.message ?? '';
		const used = /Using @types\/titanium (\S+) for Titanium SDK/.exec(text);
		if (used) {
			return used[1];
		}
	}
}

/**
 * Everything the server logged, which is where it says what it resolved and how
 *
 * @param client - The server
 * @returns {string[]} The messages, in the order they arrived
 */
function logged (client: LspTestClient): string[] {
	return client.notifications.map(message => (message.params as { message?: string }|undefined)?.message ?? '');
}

describe('Acquiring @types/titanium from npm, end to end', { timeout: TIMEOUT * 4 }, () => {

	let typesCache: string;

	before(async () => {
		typesCache = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-ls-e2e-types-'));
	});

	after(async () => {
		await fs.rm(typesCache, { recursive: true, force: true });
	});

	describe('a classic project with no types of its own', () => {
		let client: LspTestClient;
		let root: string;

		before(async () => {
			({ client, root } = await serverOn('classic-untyped-project', typesCache, true));
		});

		after(async () => client.dispose());

		it('should offer members that only the fetched types can know', async () => {
			const labels = await labelsAt(client, path.join(root, 'Resources', 'scratch.js'), 'javascript', 'const label = Ti.UI.createLabel();\nlabel.|');

			assert.ok(labels.includes('text'), `expected Label's members, got ${labels.slice(0, 20).join(', ')}`);
		});

		it('should pick a 12.x release for a 12.x SDK, and say so', () => {
			assert.match(versionUsed(client) ?? '', /^12\./);
		});

		it('should install into the cache it was pointed at, and nowhere else', async () => {
			const manifest = path.join(typesCache, versionUsed(client) ?? '', 'node_modules', '@types', 'titanium', 'package.json');
			const { version } = JSON.parse(await fs.readFile(manifest, 'utf-8')) as { version: string };

			assert.equal(version, versionUsed(client));
		});
	});

	describe('an Alloy project with no types of its own', () => {
		let client: LspTestClient;
		let root: string;

		before(async () => {
			({ client, root } = await serverOn('alloy-project', typesCache, true));
		});

		after(async () => client.dispose());

		it('should offer a view element the attributes of its type', async () => {
			// alloy-project targets SDK 10.1.0.GA, so this also runs version selection for an older
			// SDK against the real list of published versions
			const labels = await labelsAt(client, path.join(root, 'app', 'views', 'scratch.xml'), 'xml', '<Alloy>\n<Label |/>');

			assert.ok(labels.includes('text'), `expected Label's attributes, got ${labels.slice(0, 20).join(', ')}`);
		});

		it('should have fetched a separate version beside the first', async () => {
			const versions = (await fs.readdir(typesCache)).filter(entry => /^\d/.test(entry));

			assert.equal(versions.length, 2, `expected two versions in the cache, got ${versions.join(', ')}`);
		});
	});

	describe('a second run against a cache the registry was just asked about', () => {
		let client: LspTestClient;
		let root: string;

		before(async () => {
			// npm can reach nothing here, and must not be asked at all: the runs above left a
			// record of the registry answering moments ago, which is what lets the cache answer
			// on its own
			({ client, root } = await serverOn('classic-untyped-project', typesCache, false));
		});

		after(async () => client.dispose());

		it('should still offer what the fetched types know', async () => {
			const labels = await labelsAt(client, path.join(root, 'Resources', 'scratch.js'), 'javascript', 'const label = Ti.UI.createLabel();\nlabel.|');

			assert.ok(labels.includes('text'), `expected Label's members from the cache, got ${labels.slice(0, 20).join(', ')}`);
		});

		it('should not have asked npm anything', () => {
			// the whole saving: npm is not spawned per project to establish a version already on
			// disk. Offline, an attempt would have logged that it could not be made
			assert.ok(!logged(client).some(text => /Could not ask npm for @types\/titanium versions/.test(text)),
				`expected no npm lookup at all, got:\n${logged(client).join('\n')}`);
		});

		it('should say it answered from the cache, and when npm was last asked', () => {
			assert.ok(logged(client).some(text => /from the cache; npm was last asked what is published/.test(text)),
				`expected the log to say when the cache was last checked, got:\n${logged(client).join('\n')}`);
		});

		it('should not claim the registry could not be reached, since nobody asked it', () => {
			// it could not be, as it happens — but that is not why the cache answered, and saying
			// so would send a user looking for a network problem that had no part in this
			assert.ok(!logged(client).some(text => /could not be reached/.test(text)),
				`expected no unreachable-registry message, got:\n${logged(client).join('\n')}`);
		});
	});

	describe('a second run, offline, against a cache nobody has checked lately', () => {
		let client: LspTestClient;
		let root: string;

		before(async () => {
			// back-dated past the staleness window, so the registry is asked for real — and
			// fails, which is the condition the message below is about. The name is the acquirer's
			// own record, which lives beside the version directories
			await fs.writeFile(path.join(typesCache, '.last-registry-check'), new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString());

			({ client, root } = await serverOn('classic-untyped-project', typesCache, false));
		});

		after(async () => client.dispose());

		it('should still offer what the fetched types know', async () => {
			// the finding this tier was written for: a warm cache has to work with no registry at
			// all, which it did not when the version list was fetched before the cache was read
			const labels = await labelsAt(client, path.join(root, 'Resources', 'scratch.js'), 'javascript', 'const label = Ti.UI.createLabel();\nlabel.|');

			assert.ok(labels.includes('text'), `expected Label's members from the cache, got ${labels.slice(0, 20).join(', ')}`);
		});

		it('should say it chose from the cache, and why', () => {
			assert.ok(logged(client).some(text => /from the cache because the npm registry could not be reached/.test(text)),
				`expected the log to say why the registry was not consulted, got:\n${logged(client).join('\n')}`);
		});

		it('should not have recorded a check the registry never answered', async () => {
			// a failed lookup establishes nothing about what is published, so it must not stand in
			// for a real check and pin the machine to its cache
			const recorded = await fs.readFile(path.join(typesCache, '.last-registry-check'), 'utf-8');

			assert.ok(Date.now() - Date.parse(recorded.trim()) > 24 * 60 * 60 * 1000,
				`expected the stale record to be left alone, got ${recorded.trim()}`);
		});
	});
});
