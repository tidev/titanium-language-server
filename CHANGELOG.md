# Changelog

What changed in each release of `@titanium-sdk/language-server`, newest first. The numbers are the
pull requests that made each change.

A pull request that changes something a user would notice adds a line under Unreleased. A release
renames that heading to its version and date, and starts a new, empty one above it.

## Unreleased

## 0.1.1 - 2026-10-31

### Controllers and JavaScript

- `$.` offers the view's ids first, ahead of the members every controller has (#83)
- Completions follow TypeScript's own ordering: locals before globals, deprecated members last (#83)
- Mark deprecated completions, for an editor that can show them struck through (#83)
- Stop offering members a type removes, such as `add` on a `Label` (#83)

## 0.1.0 - 2026-10-28

The first release: completion, hover, go to definition, warnings and code actions for classic and
Alloy projects, in any editor that speaks the Language Server Protocol.

### Projects

- Classic and Alloy projects, found in a workspace folder or the folder directly inside it (#26)
- Pick up projects that change on disk — a new project, an edited `sdk-version`, a fixed
  `tiapp.xml` — on the next request (#59)
- Negotiate client capabilities rather than assuming them, so an editor without snippets or code
  action literals still gets what it can use (#39)

### Alloy views

- Completion of tags, attributes and events, from the project's own types (#43)
- Definitions and hover: from a class, id or tag to the rule that styles it, from a handler to the
  controller, from a `<Require>` to its file, and from a translation key to its strings (#45)
- Warn about attributes an element doesn't have (#67)

### Alloy stylesheets

- Completion of selectors and properties (#48)
- Definitions, hover and the cascade, from a rule back to the elements it styles (#49)
- Read comma separated selectors as Alloy 3.1 does (#50)
- Load platform and theme stylesheets, and `app.tss` for widgets, as Alloy does (#51)
- Warn about properties none of a rule's elements have (#67)

### Values

- Offer booleans, colour names and layouts, in stylesheets and views (#63)

### Code actions

- Generate a missing style, handler or translation as a quick fix (#53)
- Extract an element's style into a class, an id or a tag rule (#54)

### Controllers and JavaScript

- JavaScript and TypeScript features through the TypeScript language service, typed by
  `@types/titanium` (#40)
- `$` knows the ids of its view and the type each one creates (#37)
- `Alloy.CFG`, `L()` and the Alloy factory names, from the project's own files (#41)
- Resolve `require` as Titanium does, and type Alloy's builtins from source (#60)
- Follow the name given to an Alloy factory through to its files (#62)

### tiapp.xml

- Complete SDK versions, modules and common values (#56)

### Installing

- Runs on Node 20.18, the Node the editors ship (#64)
- Compiles on install, so the package can be installed from git (#61)
