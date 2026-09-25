# Lawdie Time Capture

A native, local-first macOS time tracker. See your day across desktop apps, review
captured work, and turn it into accurate project time. No browser extension, server,
account, or JavaScript runtime required.

Follows the Lawdie brand guidelines: cream, espresso, brown-gold, frosted panels,
official logo assets, and locally bundled Playfair Display, Source Sans Pro, and
Fragment Mono. See [brand implementation](docs/brand.md).

## Run

Requires macOS 14+ and Swift 5.10+ (Xcode or Apple's Command Line Tools).

```sh
swift run Tempo
```

To build a double-clickable application:

```sh
bash scripts/package.sh
open "dist/Lawdie Time Capture.app"
```

The build is ad-hoc signed for local development. Public distribution requires a
Developer ID signature, hardened runtime review, and notarization. The package
script builds for the current machine's architecture.

To explore an explicitly labeled sample workspace without capturing activity or
writing workspace data:

```sh
swift run Tempo --demo
# Or, after packaging:
open "dist/Lawdie Time Capture.app" --args --demo
```

Quit an existing instance before switching between demo and real modes.

## What works

- Native SwiftUI workspace: Today, Activity, Time entries, Projects, Reports, Settings.
- Persistent timer with project, description, billable flag, and a menu-bar control.
- Desktop foreground-app capture using NSWorkspace, including native Word, Preview,
  Outlook, editors, and browsers. App names and durations are the default.
- Optional focused-window titles via Accessibility. No title permission needed for
  basic app capture. Browser URLs and tabs are not read.
- Idle cutoff, sleep, session and screen-lock handling. Manual timers stop and save;
  returning to work does not silently restart billing.
- Crash recovery to the last persisted observation, never across the downtime.
- Activity inbox: explicitly keep or dismiss a segment. Keeping requires a review;
  capture never guesses clients, projects, or matters.
- Projects with client labels, colors, USD hourly rates, and archive/unarchive.
- Manual time, editing, deletion, resume, search, and date filters.
- Weekly charts, project breakdowns, billable time and value, CSV export.
- JSON backup/restore, local retention, exclusions, and clear-activity control.

Capture starts **off**. Enable it from the sidebar or Settings, use another app, then
switch apps to see a completed segment. Capture continues when the main window is
closed; the menu-bar item remains available. Quit Time Capture to stop the process.

Shortcuts while Time Capture is active: `⌘N` new entry, `⌘⇧T` start/stop timer, `⌘⇧P`
pause/resume capture. These are application shortcuts, not global hotkeys.

## Local data and privacy

`~/Library/Application Support/Lawdie Time Capture/workspace.json` holds a versioned
workspace. Writes are atomic; the directory is private to the macOS account and the
file uses mode 0600. Data is **not separately encrypted**. Protect the machine with
your normal account and disk protections. No networking or telemetry is implemented.

Capture checks exclusions before asking for window titles. Password apps and system
settings are excluded initially. Add more apps through Settings. Titles can contain
sensitive data; enabling titles does not make them safe or redact them. The app does
not distinguish a browser's private windows, so exclude that browser when appropriate.

Activity is retained for 14 days by default (configurable). Saved entries do not
expire. Clearing activity pauses capture and keeps saved entries. Restore first saves
the original file beside the workspace and then replaces it; capture is paused after
restore. An unreadable workspace is not silently replaced with an empty one.

The process samples every five seconds and observes app switches. Brief activity under
two seconds is discarded. A process gap over 45 seconds is treated as unobserved time.
An unexpected crash may lose up to the last five seconds. Window-title sampling is
best-effort: some applications do not expose a title. Screen recording, input monitoring,
and Apple Events permissions are not requested.

## Development

```sh
swift build
swift run TempoCoreChecks
```

No third-party code dependencies. Fonts and their licenses are bundled. The standalone
test runner works with Command Line Tools without requiring XCTest. `TempoCore` contains the portable Foundation-only data
model, capture state machine, persistence, and CSV export. `Tempo` contains the macOS
observation layer and UI. Core tests cover privacy defaults, app exclusions, idle and
sleep transitions, crashes, gaps, overlap prevention, review idempotency, retention,
cross-midnight/DST accounting, CSV injection, and storage failures.

See [architecture](docs/architecture.md) and [release checklist](docs/release-checklist.md).

## Integration boundary

Kiwi and Lawdie CRM integration is a later phase. This app does not modify or replace
`lawdie-time-capture`, does not send data to those apps, and does not expose a local
HTTP service. UUIDs, source provenance, and activity references preserve a clean
starting point for explicit, authenticated adapters. See the architecture document
for deduplication and consent requirements before connecting anything.

## Inspiration

[Solidtime](https://github.com/solidtime-io/solidtime) inspired the core product
concepts: time entries, projects, clients, billable rates, and reporting. This is a new
Swift implementation, not a fork; no Solidtime source or assets were copied.
Solidtime identifies its own source as AGPL-3.0. No open-source license is granted
for this repository yet.

## Current scope

macOS first. Windows/Linux, browser URL capture, launch at login, global shortcuts,
team accounts, automated backups, multi-currency invoicing, syncing, an updater, and
signed/notarized distribution are not included in this release. Long passive reading
without mouse/keyboard input is treated as idle; adjust the timeout for your workflow.
The app is an initial local release, not yet validated for production billing.
