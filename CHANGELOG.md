# Changelog

## 0.1.1 — 2026-11-15

Documentation only.

- README: npm version badge and the npm package name as an install source.
- No runtime changes; `index.js` and `client.js` are identical to 0.1.0.

## 0.1.0 — 2026-11-14

First public release.

- Host half: serialized `DraftStore` with atomic commits to `$DSH_HOME/storages/dsh-draft/drafts.json`,
  exposed through a loopback-only `/dsh-draft/{health,get,put,delete,list}` route registered on the public
  `webServer` service.
- Client half: a `conversation.input.dock` component that mirrors the viewed Session's composer draft
  (700 ms debounce, 3 s maximum wait) and restores it with `setDraft(snapshot)`, including reference and
  command chips.
- Clearing the composer deletes the record immediately; failed sends keep it.
- Optimistic revisions with conflict detection; a newer Host copy wins on mount when nothing was typed yet.
- Plaintext storage, loopback-only access, 400-Session / 300k-character caps.
- 22 unit tests plus a headless-Chrome end-to-end script; verified on DSH 0.2.2-rc.1 and re-verified on 0.2.2-rc.3 (2026-11-14).




