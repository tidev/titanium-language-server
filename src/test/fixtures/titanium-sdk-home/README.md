A Titanium install location, as the CLI lays one out: `mobilesdk/<host>/<sdk-version>`, where
`<host>` is `osx`, `linux` or `win32`. All three are present with the same contents so the one
fixture answers on every machine the suite runs on, and so the host mapping itself is under test
rather than stubbed.

- `12.4.0.GA` carries the declarations in `types/`, as the SDK is expected to ship them: its own
  `package.json` naming the entry and the SDK's version, `index.d.ts`, and the three
  hand-maintained files it references — `base.d.ts`, `globals.d.ts` and `console.d.ts`. The
  generator hardcodes the reference to `base.d.ts` and never emits it, so a copy holding only
  `index.d.ts` would describe something that cannot type-check.
- `9.3.2.GA` has no `types/` at all, which is every SDK shipped so far. Its root `package.json` is
  titanium_mobile's own, with no `types` field — the reason the declarations belong in a
  subdirectory with a manifest of their own rather than at the SDK root.
- `10.1.0.GA` has a `types/` with no `index.d.ts` in it, which is an interrupted or partial
  install. It must fall through to the next source rather than be answered as a types package.
