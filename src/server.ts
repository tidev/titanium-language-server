#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { TiLanguageService } from './server/service.ts';

/**
 * The server's entry point, and the module an editor extension resolves.
 *
 * There is one artifact and not two: `bin` points here, `serverPath` resolves here, and
 * `require.resolve('@titanium-sdk/language-server/server')` finds the same file. The adapter itself is
 * in server/, so this file is the shebang, the export and the decision to start.
 */
export { TiLanguageService } from './server/service.ts';

/**
 * Whether this module is the entry point of the process, rather than something another module
 * imported.
 *
 * The comparison has to go through realpath. `bin` points here, and npm links a bin into
 * `node_modules/.bin` as a symlink, so `process.argv[1]` is that link while `import.meta.filename`
 * is the file it points at — Node resolves modules through symlinks. Comparing them unresolved
 * silently answers no, and the command starts a process that listens to nothing.
 *
 * @returns {boolean} Whether the server should start itself
 */
function isEntryPoint (): boolean {
	const entry = process.argv[1];
	return Boolean(entry) && realpathSync(entry) === import.meta.filename;
}

if (isEntryPoint()) {
	new TiLanguageService().listen();
}
