# Architecture and integration boundary

## Shape

Three processes, one file, one pure module.

- **`src/shared/model.ts`** owns the rules. It is Foundation-free in the Swift sense —
  no Electron, no filesystem, no clock — and every function takes `now` in milliseconds.
  `observe()` is the capture state machine; `keepActivity()` / `saveEntry()` /
  `deleteEntry()` are the review rules; `syncRequest()` is the wire contract;
  `parseWorkspace()` validates a file and migrates the Swift app's `schemaVersion: 1`
  (reference-date seconds → ISO-8601, `bundleID` → `ownerID`).
- **`src/main/`** is the only place with side effects. `Store.change()` runs a mutation
  on a copy, validates, writes `workspace.json` atomically (temp file + rename, mode 0600
  where the platform has it), then swaps the live state and sends it whole to the window.
  A failed write leaves the old state and reports the error. One process holds the
  workspace lock (`workspace.lock` with the pid; a stale lock from a dead pid is taken).
- **`src/preload/`** exposes `window.lawdie`, a fixed list of invokes and one `onState`
  subscription. Context isolation is on; the sandbox is off only because the preload is
  ESM.
- **`src/renderer/`** renders `AppState` and asks for changes. It holds no state of its
  own beyond which screen is open and what is being typed.

## Capture lifecycle

1. Every 5 seconds, and on wake/unlock: `get-windows` reports the foreground window
   (owner name, bundle id or executable path, pid, and — only if titles are on — the
   title); `powerMonitor.getSystemIdleTime()` reports seconds since the last input.
2. `observe()` checks the explicit capture preference, the app's own pid, and exclusions
   (exact id, or executable basename on Windows/Linux) before using a title.
3. Segments are bounded by app or title changes, idle (trimmed to the last input),
   suspend/lock, pause, quit, or an unobserved gap over 45 s. The in-progress segment's
   `endedAt` is the last observation, so a crash recovers to it and never across downtime.
4. Keeping requires a description and rejects overlap with any saved entry or the running
   timer. The source activity is marked kept in the same write.

Raw activity is evidence, not billable time. Reports (next slice) sum only kept entries.

## Office document details

`src/main/office.ts`. When "Read Office document details" is on and the app in front is
Word, Excel, PowerPoint or Outlook (by bundle id or executable name), the sampler asks the
app what it has open before calling `observe()`: `osascript` on macOS (Apple Events; the
OS asks the person once per app), `powershell.exe` with COM `GetActiveObject` on Windows
(nothing to grant), nothing on Linux. Each script prints a three-line `NAME=` / `PATH=` /
`TEXT=` protocol; `parseProbeOutput()` is the only parser and the only part under unit
test — the scripts are exercised by hand against real Office. The ask is throttled to
once per 15 s per app, shares one in-flight call between samples, times out at 4 s, and
a refusal or timeout reads as "nothing" (remembered in `lastError` for Settings) rather
than an exception. Exclusions are checked before the ask. The excerpt is capped at 600
characters and whitespace-collapsed. `observe()` stores the document on the segment; a
different document in the same app ends the segment, a segment that only now learns its
document keeps going, and a failed probe never ends one.

Why not an add-in: automation reads the same three facts with nothing installed inside
Office and works for every document, not only ones opened after an add-in loads. An
add-in becomes worth it if a firm's IT policy blocks Apple Events / COM, or for richer
context (the paragraph being edited, tracked-change authorship).

## Sync (Kiwi or Lawdie CRM)

One-way, this computer → one destination, chosen at pairing (`SyncState.destination`).
Kiwi and Lawdie CRM answer the same two paths under their own API base and mint the same
kind of token from their Time pages. The device token is issued there, confirmed by
`GET /desktop-time/hello`, then stored encrypted with
`safeStorage` at `<userData>/kiwi-token.bin`. Every minute (and on Connect / Sync now)
`POST /desktop-time/sync` carries a full upsert — closed segments within retention, all
kept entries with their local project/client labels, deletions not yet acknowledged, and
this computer's IANA time zone so Kiwi dates drafts on the day they happened — batched
at 500. Kiwi writes a ledger draft per billable kept entry in the same request. `SyncState.deletedEntryIDs` is the one outbox; a failed sync leaves
everything for the next tick and records `lastError`. Kiwi upserts on the app's UUIDs and
recomputes seconds from the instants.

Matching to a matter happens on the server, at sync (`kiwi/backend/src/lib/matterMatch.ts`;
`lawdie-crm/server/services/desktopTimeService.js`): the matter number as a whole token
(the CRM also tries the court's case number), else a distinctive party name that belongs
to exactly one matter, from the title plus the document name, path and excerpt. Anything
ambiguous stays unmatched. The match is re-stamped on every sync, so a matter opened later
is picked up. In Kiwi a kept entry's draft carries the matter its activity matched; in the
CRM a kept entry with a matter is written to `crm_time_entries` (source `desktop`) at sync
and one without waits on the Time page for a person to name it.

Not solved: deduplication between this capture ("Google Chrome" as an app) and the
browser extension's segments of the same minutes. The person reviewing drafts in Kiwi is
the guard today.

## Platforms

| | macOS | Windows | Linux |
|---|---|---|---|
| Foreground app | `get-windows` (CGWindowList) | `get-windows` (Win32) | `get-windows` (X11 only) |
| App id | bundle id | executable path | executable path |
| Titles | need Screen Recording permission | free | free (X11) |
| Idle | `powerMonitor` | `powerMonitor` | `powerMonitor` |
| Lock/sleep | suspend, lock-screen | suspend, lock-screen | suspend |
| Token store | Keychain | DPAPI | keyring (plain file fallback) |
| Installer | dmg + zip (arm64, x64) | NSIS (x64) | AppImage |

Only macOS has been run by hand. Windows and Linux builds are produced by
`electron-builder` and the CI matrix; their capture path is the same package with the
same tests, but nobody has clicked them yet — see `docs/verification.md`.
