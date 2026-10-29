import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionItemKind, CompletionItemTag, MarkupKind } from 'vscode-languageserver';
import { ClientCapabilities } from '../../server/capabilities.ts';

describe('server/capabilities', () => {

	describe('snippets', () => {

		it('should be supported when the client says so', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { snippetSupport: true } } }
			});

			assert.equal(capabilities.snippets, true);
		});

		it('should not be supported when the client says nothing at all', () => {
			// the case that matters: a client that never mentions completions is not one that
			// quietly supports snippets, and assuming otherwise puts literal ${1} in a user's file
			assert.equal(new ClientCapabilities({}).snippets, false);
		});

		it('should not be supported when the client answers the question with false', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { snippetSupport: false } } }
			});

			assert.equal(capabilities.snippets, false);
		});

		it('should not be supported when the client stops part way down the chain', () => {
			// each level is optional in the protocol, so a client may declare completions without
			// declaring anything about the items in them
			assert.equal(new ClientCapabilities({ textDocument: {} }).snippets, false);
			assert.equal(new ClientCapabilities({ textDocument: { completion: {} } }).snippets, false);
			assert.equal(new ClientCapabilities({ textDocument: { completion: { completionItem: {} } } }).snippets, false);
		});
	});

	describe('showDocument', () => {

		it('should be supported when the client says so', () => {
			assert.equal(new ClientCapabilities({ window: { showDocument: { support: true } } }).showDocument, true);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).showDocument, false);
			assert.equal(new ClientCapabilities({ window: {} }).showDocument, false);
		});
	});

	describe('code action literals', () => {

		it('should be supported when the client declares the option', () => {
			// presence is the signal: the protocol carries the supported kinds inside it rather
			// than a boolean beside it
			const capabilities = new ClientCapabilities({
				textDocument: { codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } } }
			});

			assert.equal(capabilities.codeActionLiterals, true);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).codeActionLiterals, false);
			assert.equal(new ClientCapabilities({ textDocument: { codeAction: {} } }).codeActionLiterals, false);
		});
	});

	describe('workspace folders', () => {

		it('should be supported when the client says so', () => {
			assert.equal(new ClientCapabilities({ workspace: { workspaceFolders: true } }).workspaceFolders, true);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).workspaceFolders, false);
		});
	});

	describe('creating files', () => {

		it('should be supported when the client takes document changes and create operations', () => {
			const capabilities = new ClientCapabilities({
				workspace: { workspaceEdit: { documentChanges: true, resourceOperations: [ 'create', 'rename' ] } }
			});

			assert.equal(capabilities.createFiles, true);
		});

		it('should not be supported without both', () => {
			// a create operation only travels in documentChanges, so one without the other is an
			// edit the client rejects
			assert.equal(new ClientCapabilities({ workspace: { workspaceEdit: { documentChanges: true } } }).createFiles, false);
			assert.equal(new ClientCapabilities({ workspace: { workspaceEdit: { resourceOperations: [ 'create' ] } } }).createFiles, false);
			assert.equal(new ClientCapabilities({ workspace: { workspaceEdit: { documentChanges: true, resourceOperations: [ 'rename' ] } } }).createFiles, false);
			assert.equal(new ClientCapabilities({}).createFiles, false);
		});
	});

	describe('hover markdown', () => {

		it('should be supported when the client lists it among the formats it renders', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { hover: { contentFormat: [ MarkupKind.Markdown, MarkupKind.PlainText ] } }
			});

			assert.equal(capabilities.hoverMarkdown, true);
		});

		it('should not be supported when the client lists only plain text', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { hover: { contentFormat: [ MarkupKind.PlainText ] } }
			});

			assert.equal(capabilities.hoverMarkdown, false);
		});

		it('should not be supported when the client says nothing', () => {
			assert.equal(new ClientCapabilities({}).hoverMarkdown, false);
			assert.equal(new ClientCapabilities({ textDocument: { hover: {} } }).hoverMarkdown, false);
		});
	});

	describe('completion deprecation', () => {

		it('should be a tag when the client lists the deprecated tag', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { tagSupport: { valueSet: [ CompletionItemTag.Deprecated ] } } } }
			});

			assert.equal(capabilities.completionDeprecation, 'tag');
		});

		it('should be a tag rather than the older property when the client has both', () => {
			// the property is deprecated in the protocol in favour of the tag, and one is enough
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { deprecatedSupport: true, tagSupport: { valueSet: [ CompletionItemTag.Deprecated ] } } } }
			});

			assert.equal(capabilities.completionDeprecation, 'tag');
		});

		it('should be the older property for a client that only has that', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItem: { deprecatedSupport: true } } }
			});

			assert.equal(capabilities.completionDeprecation, 'property');
		});

		it('should be nothing when the client says nothing, or lists tags without this one', () => {
			assert.equal(new ClientCapabilities({}).completionDeprecation, undefined);
			assert.equal(new ClientCapabilities({
				textDocument: { completion: { completionItem: { tagSupport: { valueSet: [] } } } }
			}).completionDeprecation, undefined);
		});
	});

	describe('completion item kinds', () => {

		it('should be the set the client declared', () => {
			const capabilities = new ClientCapabilities({
				textDocument: { completion: { completionItemKind: { valueSet: [ CompletionItemKind.Text, CompletionItemKind.Constant ] } } }
			});

			assert.deepEqual([ ...capabilities.completionItemKinds ], [ CompletionItemKind.Text, CompletionItemKind.Constant ]);
		});

		it('should be the kinds the protocol has always had when the client declares none', () => {
			// the protocol's own rule for a client with no value set, rather than a guess: it
			// "only supports the kinds from Text to Reference"
			const kinds = new ClientCapabilities({}).completionItemKinds;

			assert.ok(kinds.has(CompletionItemKind.Text), 'expected the first of the original kinds');
			assert.ok(kinds.has(CompletionItemKind.Reference), 'expected the last of the original kinds');
			assert.ok(!kinds.has(CompletionItemKind.Constant), 'expected nothing added after Reference');
		});
	});
});
