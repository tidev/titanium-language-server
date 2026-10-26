# Repository Guidelines

A language server for Titanium, providing language features for **both classic and Alloy**
projects, usable by any editor that speaks LSP.

## Project types

Both are supported and neither is an afterthought.

- **Classic** — JavaScript under `Resources/`. No views, no styles, no `$`.
- **Alloy** — the MVC triad under `app/`: XML views, TSS styles, JS controllers, plus widgets,
  models and `alloy.js`.

Anything Alloy-specific must be gated on project type. Path resolution differs: `require` resolves
against `Resources/` vs `app/lib/`, and i18n lives at `<project>/i18n` vs `<project>/app/i18n`.

## Hard constraints

These are expensive to rediscover. Do not relax them without reading why they exist.

### Dependency pins

- **XML is read with `vscode-html-languageservice`, not `@xmldom/xmldom`.** Alloy uses xmldom, and
  matching the compiler was the obvious choice until it was measured. Two things decided against it.

  xmldom does not throw on a half-written document, but it **drops everything after the
  malformation**: on `<Alloy><Window class="` it yields `Alloy` alone — the one element the user is
  not editing. Every completion, hover and definition happens at the cursor, so that is the whole
  job missed. `vscode-html-languageservice` keeps the element under the cursor in every case,
  including an unnamed node for a bare `<`.

  And fidelity to the compiler binds less than it appears. Alloy's tolerance is **zero**: ALOY-840
  turns xmldom's "unclosed xml attribute" warning into a fatal, and `utils.js` dies on any error. A
  malformed view is one Alloy refuses to compile, so there is nothing there to be faithful to. On
  Alloy's own 446 view files, our parser and xmldom agree on all 444 that Alloy accepts.

  0.9 is not the alternative either — it throws a fatal `ParseError` on every half-typed document,
  `onError` does not suppress it, and throwing on more cases is 0.9's stated intent rather than a
  regression.

  The cost is HTML semantics applied to XML: a lowercase tag colliding with an HTML void name
  (`input`, `link`, `source`) would misparse. Alloy's tags are PascalCase and a test covers the
  collision, but a lowercase custom tag would need care.
- **`typescript` at `^6`. Never `latest`.** `latest` on npm is 7.x — the Go port — whose CommonJS
  entry exports only `version` and `versionMajorMinor`. No `createLanguageService`, no `sys`. 6.x
  is the last JavaScript-based line and has the full compiler API.

### Dependencies

Prefer the platform. Node covers what this project needs, so there is no `fs-extra` and no
directory-walking library — `node:fs/promises` provides `cp`, `rm`, recursive `mkdir` and recursive
`readdir`, and `core/fs.ts` wraps the two patterns we actually use. There is no test framework,
assertion library, mocking library or coverage tool either — `node:test` and `node:assert/strict`
are the whole test stack. Only one XML parser: `vscode-html-languageservice` handles views,
`tiapp.xml` and `strings.xml` alike.

Before adding a dependency, check whether Node already does it.

`engines` is `>=20.18`, and that floor is set by the editors rather than by Node's own support
dates. An extension runs the server on the Node its editor ships: VS Code 1.100 is Electron 34 and
Pulsar is Electron 32, and both are Node 20.18. Asking those users to install a newer Node first
would make every editor that embeds the server harder to use, so the floor stays there until the
editors move.

Two things hold it there. **The types are Node 20's**: `@tsconfig/node20` sets the language
library to ES2023, and `@types/node` is pinned to `~20.17` — there is no 20.18 release of it — so
`Map.groupBy`, `Dirent.parentPath` before 20.12, or anything else newer is a compile error rather
than a crash in an editor. **CI starts the built server on Node 20.18** and has it answer
`initialize`, which proves what tsc emitted loads there. That is deliberately all the Node 20 job
does: the suite runs the sources through type stripping, which Node 20 does not have, so day to day
development and the test matrix stay on 22 and 24.

### Modules

The package is **ESM** (`"type": "module"`, `module: nodenext`). Relative imports carry a **`.ts`**
extension, which `rewriteRelativeImportExtensions` turns into `.js` on the way out — the emitted
JavaScript is unchanged. The `.ts` specifier is what lets Node run the sources directly, since it
does not resolve `./x.js` to `x.ts`. The one exception is `import.meta.resolve('./server.js')` in
`index.ts`: it resolves at run time rather than being compiled, so tsc never sees it.

Every runtime dependency is still CommonJS and is imported by name — Node's interop handles all of
them, `typescript` included.

ESM is what keeps the test stack current: `mocha`, `chai` and `sinon` are all ESM-only now, and
staying CommonJS meant freezing them. The platform runner made that moot, but the constraint stands
for anything else.

A CommonJS extension host cannot always `import` this package — `require(esm)` needs Node 20.19 or
22.12, and VS Code has shipped older. It does not need to: `require.resolve` does not run the
module, so `require.resolve('@titanium-sdk/language-server/server')` gets the same path as `serverPath`
on any Node.

There is **one server artifact, not two**. `bin` points straight at `out/server.js`, which carries
the shebang from `server.ts` — tsc preserves it — and starts a server when it is the process entry
point. So the command, `serverPath` and `require.resolve` all reach the same file, and npm handles
the mode bit and the Windows `.cmd` shim. A separate `bin` script would be a fourth thing to keep
working, unchecked by tsc and ESLint, and it broke twice while it existed.

### Protocol discipline

- **stdout carries JSON-RPC and nothing else.** `vscode-languageserver` does not patch the global
  console, so a single `console.log` corrupts the stream and desyncs the client. All logging goes
  through `logger`, which uses the connection's `RemoteConsole` and falls back to stderr before a
  connection exists. `no-console` is an ESLint error for this reason.
- **Zero custom protocol.** No custom requests, no client-side command handlers. Every one is a
  thing each editor must implement before anything works there. Code actions carry a
  `WorkspaceEdit` rather than a `Command`. One may carry a command as well, when the server runs
  it itself through `workspace/executeCommand` and the edit does not depend on it — extract style
  reveals its new rule that way, for a client that can show a document.
- **Gate every client capability.** Never assume `completionItem.snippetSupport`,
  `window.showDocument.support` or `codeAction.codeActionLiteralSupport`. Editors differ, and a
  missing snippet engine means literal `${1}` inserted into a user's code.

### Architecture

- **`core/` imports nothing from `vscode-languageserver`.** All analysis lives there — parsing, the
  project model, cross-referencing, declaration generation. `server/` is a thin adapter that
  translates between the protocol and core. This keeps analysis testable without a protocol
  harness.
- **Answers map back to source positions**, never to positions in generated or virtual content.
- **Routing takes two questions, not one.** The language id says what a file is written in; the
  project layout says what it does there. Neither answers alone — `.xml` is also `tiapp.xml` and
  `strings.xml`, and a `.js` means nothing until you know whether it is under `app/controllers` or
  `Resources`. Ids are matched case insensitively and by substring, because VS Code sends `xml`
  and Pulsar sends `Alloy (XML)`, and an editor with no grammar for TSS sends neither — the file
  extension is the fallback rather than the first answer. The one exception is `tiapp.xml`, known
  by its name alone: what it completes comes from the machine rather than the project, and a
  tiapp.xml without an `sdk-version` is turned away by the registry yet most needs one offered.
- **`require` resolves the way Titanium does, not the way Node does.** A leading slash means the
  source root, `Resources/` or `app/lib/`, so `require('/lib/http')` is `require('lib/http')` — and
  `alloy/animation` and its siblings, which Alloy copies in at compile time and so are nowhere in
  the project, are read from the source of the Alloy the project compiles with: installed in or
  above the project, else globally, found through `npm root -g` once per server. TypeScript types
  them from their code and JSDoc like any other module; nothing is transcribed. A file of the same
  name in the project's own source wins, and hover falls back to the text of an `@method` tag,
  which is where Alloy's JSDuck comments put the description.
- **The machine is read through `ti`, and only through commands that read.** SDKs come from
  `ti sdk list -o json`, global module directories from its `installLocations` and from
  `ti config paths.modules -o json`, and the modules themselves are read from disk by
  `core/modules.ts` following the CLI's own rules. **Never `ti module list`**: before listing
  anything it extracts every zip shaped like a module — `^.+-.+?-.+?\.zip$`, which
  `my-app-backup.zip` matches — beside each modules directory it searches, the project root
  included, and deletes the zip. A machine without `ti` gets an empty answer and one log line, not
  an error.
- **A request can arrive before the workspace has been scanned.** A client may send one the moment
  it has sent `initialized`, and notification handlers are not awaited before the next message is
  dispatched, so a handler that does not wait answers against an empty registry. Every handler
  awaits `ready` first. Removing that await fails an end-to-end test rather than being a race that
  only shows up on a slow disk.
- **The registry is checked against the disk on each request, not watched.** `ti create` inside an
  open workspace, an edited `sdk-version` and a fixed tiapp.xml are all picked up by the next
  request, through `ProjectRegistry.refresh` — a directory read per workspace folder and a `stat`
  per candidate, with a tiapp.xml read again only when its time or size moved. Watching was the
  alternative, and it needs `didChangeWatchedFiles` dynamic registration, which not every client
  has. A project whose tiapp.xml changed is replaced rather than patched, so its language service
  is rebuilt for the new SDK. The check queues behind `ready`, and folder changes queue behind it,
  so the two never register one project twice.

## Commands

- `npm run build` — compile to `out/`
- `npm run watch` — rebuild on change
- `npm run lint` — ESLint over `src/`
- `npm test` — the suite, from source, under coverage; fails below the coverage floor. No build first
- `npm run test:e2e` — the tests that reach the npm registry; needs network

## Releasing

Published to npm as `@titanium-sdk/language-server`; the command it installs is still
`titanium-language-server`. A release is a pull request that bumps `version`, then a GitHub Release
tagged `v<version>` from the merge: `publish.yml` checks the tag matches, runs lint and tests,
 and publishes through npm's trusted publishing, with provenance and no stored token.

## Testing

- **Write the test first.** Red, green, refactor: the failing test comes before the code that
  satisfies it, and a test that has never been seen to fail has not been shown to test anything.
  When a change fixes a bug, reproduce it as a failing test before fixing it.
- Tests land with the change. The test corpus is the specification — a feature without a corpus
  entry is not done.
- The test stack is `node:test` plus `node:assert/strict`. Coverage, mocking and fake timers are all
  part of it — do not reach for a library.
- **Tests run the sources, not the build output.** Node strips the types, so `npm test` needs no
  build and a stack trace names the file you are editing. Three things follow, and each is a
  compile error rather than something to remember: no TypeScript that cannot be erased — parameter
  properties, `enum`, `namespace`, parameter decorators; a type-only import must say `import type`,
  which `verbatimModuleSyntax` enforces; and relative specifiers end in `.ts`. This needs Node
  22.18 or newer, which is a floor on the development loop rather than on the published package —
  that still ships compiled JavaScript, and runs on 20.18.
- Coverage floor is 90% lines and functions, 80% branches, passed to `node --test` as thresholds so
  the run exits non-zero below them. CI enforces it.
- `node --test` collects coverage from spawned children, so the end-to-end server tests count
  towards the floor rather than needing an ignore pragma — they spawn `src/server.ts`, so it is one
  file set and one number. It only reports files something loaded, though: a module no test and no
  source file imports is invisible to the gate, which is currently true of `index.ts`.
- **`src/test/e2e/` is the one tier that reaches the network**, and `npm test` does not include it.
  It drives a spawned server through fetching the real `@types/titanium` from the registry, for
  both project types, into a temporary cache, then starts a second server offline against that
  cache. It also holds the check of the type reader against the real package, below. It has its own
  CI job, so a registry outage fails that job and not the matrix. Its first run found that a warm
  cache did not work offline — the version list came from the registry before the cache was ever
  consulted — which no test with an injected acquirer could see.

  **It runs on every OS**, because it is the only tier that runs npm for real, and running npm is
  not the same act everywhere. On Windows npm is a `.cmd` batch file, which Node refuses to start
  without a shell, and for as long as this job ran on Linux alone the types were never fetched on
  Windows — every offline server there expects npm to fail, so a spawn failure looked like success.
- **Every other spawned server is offline.** A spawned server has the real npm acquirer, so any
  fixture without types of its own — `alloy-project` is one — would reach the registry. The test
  client prevents it: each server gets an empty temporary cache through
  `TITANIUM_LANGUAGE_SERVER_TYPES_CACHE` and runs npm with `offline` against an empty npm cache, so
  every lookup fails fast and identically on every machine. Only `network: true` lifts that, and
  only the e2e tier passes it. Until this was in place, `npm test` fetched types into
  `~/.titanium/types` on all six matrix jobs.
- The protocol layer is covered by an end-to-end client that speaks LSP over stdio and **rejects
  anything that is not a `Content-Length` framed message**. That strictness is what catches stray
  writes to stdout, which are otherwise invisible until a real client desyncs.
- Both project types need coverage. An Alloy-only fixture hides real bugs in classic path
  resolution.
- **Check TSS against Alloy's own parser after changing the TSS parser.** Alloy ships a generated
  `Alloy/grammar/tss.js` and 419 `.tss` files, 246 of them regression fixtures under
  `test/apps/testing` named for the tickets that produced them. Clone `tidev/alloy`, parse every
  one with both parsers and compare selectors, property names and values. Deliberately a manual
  check rather than a dependency, so it has to be remembered.

  It is worth remembering: the first run found `\uXXXX` escapes unimplemented (ALOY-813), comments
  left inside call expressions, and that Alloy doubles a whitespace-delimited run of backslashes
  before parsing (ALOY-793) so those backslashes survive its own unescaping. None of those were
  reachable from fixtures written by hand.

  The same check applies to **views**: parse Alloy's 446 `.xml` view and widget files with both
  `core/xml.ts` and xmldom, and compare tag and id pairs. Split the result by whether Alloy would
  accept the file at all — it dies on any xmldom error — because a disagreement on a view Alloy
  rejects is not a defect. It found one, and there our answer is the better one: xmldom pulls a
  `<Label>` inside an unclosed comment back into the tree, which would offer the user a `$` member
  that does not exist.

  **Check tag resolution against Alloy's compiler after changing `core/tags.ts`.** Alloy ships 396
  test apps under `test/apps`, and the question — which ids reach `$`, and as what type — is one
  its own output answers exactly. Copy `test/projects/HarnessTemplate`, drop an app into its
  `app/` directory, run `node bin/alloy compile <harness> --config platform=ios`, and read the
  `$.__views` assignments out of `Resources/iphone/alloy/controllers/`. Repeat for android. All 422
  compiled controllers agree today, and getting there found the default id, item templates,
  collection binding, the proxy properties, the Picker renames and `ListItem`.

  **Compile them; do not read the `_generated` directories.** Those are checked-in snapshots and
  some are stale — they still say `Ti.UI.iOS.createNavigationWindow`, and they predate the widget
  unwrapping in `Alloy.Require.js`, so they disagree with the compiler that produced this clone.
  Reading them instead of compiling costs a day of chasing differences that are not there.

  **The corpus proves less than the number suggests.** A type is only compared where an element
  carries an id, because only an id reaches `$` — so a rename on an element Alloy's fixtures never
  give an id to is invisible to the check however many controllers agree. Two got through that way:
  `Ti.UI.PickerColumn.js` renames its own rows, and `Ti.UI.TextField.js` renames
  `<AttributedHintText>`, and the fixtures for both (ALOY-440, ALOY-961) write those elements
  without ids. Read the parsers for `child.nodeName = ` as well as running the corpus; agreement on
  422 controllers is evidence about the paths the fixtures reach and nothing about the rest.

  Three traps when reading the generated code. Alloy puts several statements on one line, so a
  regular expression that reads to the end of the line swallows the assignments after it — read the
  value through a lookahead and cut it at the first statement break, or a `Ti.UI.createWindow` is
  answered for by the `Alloy.createWidget` two lines down. A view under `views/<platform>/`
  overrides the one beside it, so compare against the file the controller actually came from. And
  two differences are expected rather than defects: an element gated with `platform=` is absent
  from the other platform's build, and this generator has no platform to gate on, so it offers the
  member either way; and where a view names one id twice, `$.__views` takes the last write in
  Alloy's emission order, which is not document order — a `<TabGroup>` assigns after the children
  it collects. Classify both in the checker rather than eyeballing the residue.

  **Check the cascade against Alloy's styler after changing `core/cascade.ts`.** Install the clone's
  dependencies and, for every app view under `test/apps` with a stylesheet, load `app.tss` and the
  paired stylesheet with `loadAndSortStyle`, then compare what each element ends up with. Do not
  call `generateStyleParams` — it returns code. Lift its body from the source up to `// substitutions
  for binding` and evaluate that, returning `styleCollection`, so what is compared is Alloy's own
  merge rather than a transcription of it; stub `CU.CONDITION_MAP`, which lacks platforms the
  fixtures name. Compare both halves: the entries without a condition merged in order against
  `applied`, and every conditional entry against the conditional sources in order. All 191 views,
  1675 properties and 73 conditional ones agree today.

  The same clone checks selectors on their own, and a change to how a key is read should run it:
  `sortStyles(loadStyle(file))` against `sortRules` for every `.tss` in the repository, compared as
  the sorted list of kind, name and queries. That covers comma separated keys, which Alloy 3.1
  splits into one rule per part — `test/apps/testing/multi-classes` is their fixture. All 418 files
  and 1168 selectors agree today.

  Platform folders and themes are checked the same way, one build at a time, because Alloy builds
  for one platform and loads that platform's folders alone. For each app under `test/apps` and each
  of `ios` and `android`, take `stylesheetsFor` without the other platform's files and with the
  theme `parseConfig` would pick for that build, mark them unconditional as they are to that build,
  and load the same files into Alloy with `loadAndSortStyle` and its `platform` and `theme` options.
  All 432 builds of 249 views, 34 of them in widgets — 29 with platform or theme files — agree
  today, over 3592 properties and 146 conditional ones. The test apps sit outside an `app/`
  directory, so give the checker a scratch project whose `app` is a symlink to each; use an absolute
  target, or every candidate stylesheet silently fails to exist.

  **Include the widgets.** The first versions of all three checks walked past `widgets/`, and so
  never saw that a widget gets `app.tss` too — this server said it did not, from #43 until it was
  compiled. `parseAlloyComponent` starts every component, widgets included, from
  `styler.globalStyle`; compile an app whose `app.tss` styles a class a widget's element carries and
  the rule is in the widget's generated controller. Where the source and an assumption disagree,
  compile it.

  One trap. Alloy's optimizer keeps `null` and `undefined` as expressions — `__ALLOY_EXPR__--null`
  — so normalise both sides before calling a value different; the same rule won either way.

  **The type reader is checked against the real `@types/titanium` automatically**, by
  `src/test/e2e/real-types.test.ts` in the e2e tier. The stub under
  `src/test/fixtures/classic-project` mirrors the published package's *shape* and not its edge
  cases, so a reader can be green against it and wrong against a user's project. This used to be a
  manual step; the test fetches the real package, pinned to 13.3.0, and asks the readers what a
  user's project would. **When the reader finds something new in the real package, add it there
  rather than to the stub alone** — the stub cannot be trusted to have the edge case, which is the
  whole reason the test exists. Moving the pin to a newer release is a deliberate change: read what
  the new answers are, do not just update the numbers.

  What it guards, none of it reachable from a fixture written by hand. The factories are `static`
  methods on a class merged with the namespace, so walking `symbol.exports` on `Ti.UI` finds 51
  classes and **zero** factories — ask for the value type instead. The package removes an
  inherited member by redeclaring it as **`never`**, 765 times: `Titanium.UI.Label` does it to
  `View.add`. 334 members are **`readonly`** — `rect`, `size`, `apiName` — and a view cannot write
  one. An event's documentation sits on its **own interface** (`Label_longpress_Event`), and the
  `EventMap` member that points at it is bare. And a tag is only writable bare if Alloy's
  `IMPLICIT_NAMESPACES` maps it or `Ti.UI` creates it — `<Snackbar/>` compiles to `Ti.UI.Snackbar`
  and fails.

  Whatever a completion offers, something has to be able to *write* it, so the test runs every
  offered tag back through `titaniumTypeOf` and pins the residue that resolves to a type with no
  members: `Annotation`, the `ti.map` native module, and `AdView`, `NavigationGroup` and
  `StatusBar`, removed APIs Alloy's table still carries. A tag joining that list is a finding.

  Two traps when comparing TSS. Alloy stores strings JSON-quoted and expressions behind an
  `__ALLOY_EXPR__--` prefix, so both sides need normalising into one vocabulary first — and do not
  collapse whitespace on Alloy's side, because it already emits its normalised form and a blunt
  regex reaches inside string literals. Alloy also wraps a file in braces before parsing when it is
  not already wrapped, which `styler.js` does and a comparison must do too.

## Style

TypeScript with `strict` enabled. Tabs, semicolons, single quotes. `camelCase` for functions and
variables, `PascalCase` for types. Run `npm run lint` before opening a pull request.

**Anything that holds state or collaborators is a class**, not a factory returning an object
literal. `SourceCache`, `ReferenceIndex`, `ProjectService`, `NpmAcquirer` and the `PositionMap` and
`TypesSource` implementations are all classes, and so is everything new of that shape. A function
that returns plain data — `route`, `selectTypesVersion`, `parseTss` — stays a function, because the
thing it returns is a value rather than a collaborator. Where construction has to await something,
the constructor is private and a static `create` does the awaiting: `ProjectService.create` is the
one case.

## Commits and pull requests

Conventional Commits, for example `feat(tss): …`, `fix(view): …`, `test: …`. Issue references go in
the commit body rather than the subject.

Every pull request body **closes its issues with GitHub's keyword syntax** — `Closes #9`, one per
issue — so merging shuts them automatically. `Refs #9` only links, and leaves someone to close it by
hand later; use it only for an issue the pull request genuinely does not finish.

Work on a branch and open a pull request. Nothing is pushed to `main` directly. Where several
changes are in flight, stack the branches.
