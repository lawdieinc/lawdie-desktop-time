# Architecture and integration boundary

## Ownership

`TempoCore` is a Foundation-only Swift library. `Workspace` owns projects, entries,
activities, preferences, and recoverable in-flight records. `Tempo` is a native macOS
executable with SwiftUI views and an AppKit/ApplicationServices observation layer.
All app mutations run on the main actor, write a candidate workspace atomically, and
only publish it to the UI after the write succeeds. No third-party packages are used.

The local JSON workspace is deliberately inspectable and versioned. This is suitable
for one user and bounded raw activity; a later SQLite migration is appropriate for
large, multi-year datasets. Current writes encode the whole workspace every five
seconds while a timer or activity is running. An exclusive OS file lock prevents
multiple processes from overwriting the same workspace. Standard LaunchServices
launching reuses one instance.

## Capture lifecycle

1. Observe NSWorkspace foreground application notifications plus a five-second poll.
2. Check explicit capture preference, app exclusions, and our bundle identifier.
3. If titles are enabled and Accessibility is granted, read only the focused window
   title, with a short IPC timeout and a 300-character maximum.
4. Bound segments by foreground app/title changes, idle, pause, session lock, sleep,
   quit, or a missing-observation gap. Save a heartbeat with each observation.
5. Restart recovers only to the stored heartbeat. Never infer time across downtime.
6. Keeping activity requires a description/project review and rejects overlap with
   any saved entry or the active timer. The source activity is marked kept atomically.

App capture and a manual timer intentionally coexist. Raw activity is evidence, not
billable time; reports sum only approved time entries. Overlapping raw segments must
be dismissed or manually reduced to untracked portions; the app never double-counts
them automatically. Saved rates are snapshots, so project rate changes do not alter
historical billable values. Reports clip intervals at calendar day/week boundaries.

## Planned Kiwi / CRM adapters

The existing browser extension emits neutral activity segments, and each host owns
matching. Keep that architecture. Do not add matter matching to this capture engine.

A future versioned adapter should use:

- Stable source identity (`desktop`, installation ID, entry/activity UUID) for idempotency.
- UTC ISO-8601 exchange timestamps and exact unrounded durations. Internal Codable
  dates currently use Foundation's reference-date encoding; the JSON backup is an
  internal storage format, not the future API contract. CSV uses ISO-8601.
- Explicit client/project external references, scoped to a connector/account.
- User-approved mappings and review states; never guess a legal matter from an app name.
- A durable delivery outbox with retries, acknowledgements, tombstones, and conflict rules.
- Keychain-held credentials; explicit destination consent and separate read/write scope.
- Interval deduplication between desktop/browser/host timers. A browser window and
  browser extension may describe the same work and must not create duplicate time.

No integrations, tokens, local socket, or API server exist in this release.

## Native references

- [NSWorkspace activation](https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification)
- [CGEventSource idle time](https://developer.apple.com/documentation/coregraphics/cgeventsource)
- [SwiftUI MenuBarExtra](https://developer.apple.com/documentation/swiftui/menubarextra)
- [Product inspiration: Solidtime](https://github.com/solidtime-io/solidtime)
