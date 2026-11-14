# dsh-draft-persistence

[![CI](https://github.com/ShawThua/dsh-draft-persistence/actions/workflows/ci.yml/badge.svg)](https://github.com/ShawThua/dsh-draft-persistence/actions/workflows/ci.yml)

Keep unsent composer drafts per Session on the **DSH Host**, so they survive a page reload, a Session switch, a Host restart, or opening the same Session from another device.

English | [中文](README.zh-CN.md)

## Why this exists

DSH already keeps a composer draft — but only in browser `localStorage`, under `dsh.conversation.<sessionId>`. `localStorage` is **origin-scoped**:

- the Desktop host picks a random port on every launch, so each launch is a new origin;
- a phone or a second browser has its own copy;
- clearing site data, private mode, or a cleanup tool drops it.

That is how a long unsent draft can disappear while the Session log is perfectly intact. This plugin adds the missing **Host-side copy**: one file under `$DSH_HOME`, shared by every browser connected to that Host.

## What it does

- Watches the viewed Session's composer state and saves the draft, debounced **700 ms** (at most 3 s while typing continues).
- Stores the semantic draft snapshot: text, file/Session reference chips, a claimed slash-command chip, and text quotes.
- Restores into the composer when the Session is opened, via the composer's public `setDraft(snapshot)`.
- Deletes the record the moment the composer becomes empty — a **successful send** or a manual clear. A failed or refused send leaves the text in place, so the record stays.
- Never blocks typing: all saving is asynchronous, failures degrade to a console warning and a log line.

## Requirements

- DSH with the **Web** profile (`dsh web --profile web`); built and verified against **0.2.2-rc.1**.
- Node `^22.19.0 || >=24.0.0` (the Host half runs inside DSH; there is no separate process).
- No runtime dependencies and no build step: both halves are plain ESM/JS.

## Install

Install it through DSH's plugin manager — do not hand-edit the profile's `package.json` or `cordis.patch.yml`; the manager owns those files.

1. **From this repository** (plugin manager, Settings → Plugins, or the `plugin_manager` agent tool):
   - repository spec: `ShawThua/dsh-draft-persistence`
   - or a local checkout: `link:<absolute path to the checkout>`
2. The manager adds the dependency, selects the bundle, and restarts that plugin row. Profile configuration HMR usually applies it immediately (look for `application: "applied"`); otherwise restart the Host.
3. **Verify**:

   ```bash
   # Host half is alive (prints {"ok":true,"drafts":N,...})
   curl http://127.0.0.1:7979/dsh-draft/health
   ```

   Then open any Session, type something without sending, wait one second, and refresh the page — the text comes back.

## How it works

```
SessionInputShell (client)
   │  state.subscribe → { draft, draftRev }
   ▼
client.js  createKeeper      debounce 700 ms / max 3 s
   │  POST /dsh-draft/put { sessionId, draft, baseRev, writer }
   ▼
index.js   DraftStore        →  $DSH_HOME/storages/dsh-draft/drafts.json
   ▲                             (temp file + rename, serialized commits)
   │  GET /dsh-draft/get?sessionId=…
   │  → shell.setDraft(snapshot)   on mount
```

- `conversation.input.dock` is a Session-scoped slot, so a keeper exists **only for the Session that is currently open**. Cold Sessions are never read, and no Lexical editor is created for them.
- The Host route is registered through the public `webServer` service (`ctx.webServer.register`), and the Client only uses `require('react')` — no `@deepseek-ai/*` imports on either side.

### HTTP API (loopback only)

| Method and path | Body | Response |
|---|---|---|
| `GET /dsh-draft/health` | – | `{ ok, drafts, chars, file }` |
| `GET /dsh-draft/get?sessionId=` | – | `{ ok, record \| null }` |
| `POST /dsh-draft/put` | `{ sessionId, draft, baseRev, writer, force? }` | `{ ok, rev, updatedAt }` or `{ ok, conflict, record }` |
| `POST /dsh-draft/delete` | `{ sessionId }` | `{ ok, deleted }` |
| `GET /dsh-draft/list` | – | debug: Session id, revision, size, 80-char preview |

`draft` is either a string or a `DraftSnapshot`-shaped object: `{ text, references?, command?, quotes? }`.

## Storage and privacy

- Drafts are stored as **plaintext JSON** at `$DSH_HOME/storages/dsh-draft/drafts.json`. They are not encrypted and they outlive the browser tab.
- At most **400** Sessions (oldest `updatedAt` is pruned), one draft of up to **300,000** characters each, request bodies capped at **2 MB**.
- The route refuses non-loopback peers and requires `content-type: application/json` for writes, so a cross-origin page cannot read drafts (no CORS headers) or write them (preflight is never answered).
- The plugin makes no outbound network requests. If you expose DSH beyond loopback, the draft route still answers loopback peers only.

## Behaviour details

- **Restore on open.** If the composer is empty and untouched, the Host record is applied. If this browser already has text (for example the built-in `localStorage` draft was newer), the local text wins and is written to the Host.
- **Another device was first.** When the Host record is more than **1.5 s newer** than this browser's last successful save and the user has not started typing in this Session yet, the Host record wins.
- **Conflicts.** Writes carry the revision they are based on. A mismatch returns the current record instead of overwriting; if the local draft has changed, the actively edited draft is forced through (with a console warning); otherwise the newer Host draft is adopted.
- **Clearing.** Any transition to an empty composer deletes the record immediately, including `visibilitychange`/`pagehide` flushes so an accepted send is not resurrected by a reload.

## Limits and non-goals

- **Attachments are not persisted** (browser `File` objects cannot survive a reload); only text and text-reference chips.
- No visible "draft saved at HH:MM" indicator.
- No draft list, history, encryption, or per-workspace isolation.
- Multi-device editing is last-writer-wins with conflict detection, not a merge.

## Development

```bash
node test/host.test.mjs     # 12 tests: store, atomic writes, revisions, HTTP route
node test/client.test.mjs   # 10 tests: debounce, restore, clearing, conflicts
```

`npm test` runs both. Do not use `node --test <file>` on Windows with a restricted sandbox — the test runner spawns children.

End-to-end check against a live Host (headless Chrome + CDP). It types into a real Session, verifies the Host copy, clears `localStorage`, reloads, verifies restoration, then clears up after itself:

```bash
DSH_WEB_URL=http://127.0.0.1:7979 \
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
SESSION_TITLE="My test session" \
OTHER_TITLE="Another session" \
node scripts/e2e.mjs
```

On Windows the token is read from `%LOCALAPPDATA%\DSH\portal\url.txt` by default; elsewhere set `DSH_TOKEN` or `DSH_TOKEN_FILE`.

Layout:

```
index.js          Host half: DraftStore + loopback HTTP route
client.js         Client half: keeper component in conversation.input.dock
cordis.patch.yml  bundle patch (one insert row)
locale/           plugin list metadata (en, zh)
icon.svg          plugin icon
test/             node:test unit tests
scripts/e2e.mjs   live end-to-end verification helper
```

## Compatibility

The plugin relies on the public composer surfaces shipped in DSH 0.2.2-rc.1:

- `ctx.conversation.input.shell(sessionId)` and its `state` snapshot store,
- `state.getSnapshot().draft` / `.draftRev`,
- the `draftSnapshot` getter and `setDraft(text | snapshot)`,
- the `conversation.input.dock` list slot with a `sessionId` prop.

These are stable plugin surfaces, but a DSH upgrade can still change them. If drafts stop restoring after an upgrade, run the E2E script first; a `slot entry crashed in 'conversation.input.dock'` console error means the dock contract changed.

## Uninstall

Remove the bundle with the plugin manager. The stored drafts file is left in place; delete `$DSH_HOME/storages/dsh-draft/` manually if you want it gone.

## License

MIT
