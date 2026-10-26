import { fileURLToPath } from 'node:url';

export interface TitaniumSDK {
	version: string;
	path: string;
	platforms: string[];
	githash: string;
	timestamp: string;
	fullversion?: string;
}

/**
 * The path to the server module, so an editor extension can bundle the server and spawn it
 * directly rather than requiring a global install.
 *
 * This is the same file the `titanium-language-server` command runs — the bin field points at it,
 * so there is one artifact and not two.
 *
 * This package is ESM, so a CommonJS extension host cannot always import this module to reach it —
 * `require(esm)` needs Node 20.19 or 22.12, and VS Code has shipped older. Resolution does not run
 * the module though, so such a host can get the same path from
 * `require.resolve('@titanium-sdk/language-server/server')`.
 *
 * The specifier is `.js` where every import in this package is `.ts`. It is resolved at run time
 * rather than compiled, so tsc never sees it and has nothing to rewrite — which also means this
 * only names a real file in the built output, and is why the tests that read it run there.
 */
export const serverPath = fileURLToPath(import.meta.resolve('./server.js'));
