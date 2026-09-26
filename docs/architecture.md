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

## Kiwi sync

One-way, this computer → Kiwi, Lawdie CRM not connected. The device token is issued by
Kiwi's Time page, confirmed by `GET /desktop-time/hello`, then stored encrypted with
`safeStorage` at `<userData>/kiwi-token.bin`. Every minute (and on Connect / Sync now)
`POST /desktop-time/sync` carries a full upsert — closed segments within retention, all
kept entries with their local project/client labels, and deletions not yet acknowledged —
batched at 500. `SyncState.deletedEntryIDs` is the one outbox; a failed sync leaves
everything for the next tick and records `lastError`. Kiwi upserts on the app's UUIDs and
recomputes seconds from the instants.

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
