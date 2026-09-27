# Lawdie Time Capture

A local-first desktop time tracker for macOS, Windows and Linux. See your day across
desktop apps — Word, Acrobat, Outlook, everything a browser extension cannot see — review
captured work, and turn it into accurate time. Optionally connect it to Kiwi, and the
activity you capture and the time you keep sync there.

Electron + TypeScript. The capture rules live in one pure module (`src/shared/model.ts`)
that runs under tests and inside the app unchanged; the first, macOS-only Swift version is
kept under `legacy/swift/` for reference and is no longer built.

## Install

**Download:** <https://github.com/lawdieinc/lawdie-desktop-time/releases/latest> — pick
the `.dmg` for a Mac (arm64 for Apple Silicon, the other for Intel), the `Setup .exe`
for Windows, or the `.AppImage` for Linux.

There is no Apple Developer or Windows code-signing certificate yet, so each platform
asks once before the first launch. That is expected; the app is unchanged after it.

- **macOS** — open the `.dmg`, drag Lawdie Time Capture to Applications, open it. macOS
  says it "could not verify" the app: go to **System Settings → Privacy & Security**, scroll
  to the message, click **Open Anyway**, confirm. (Or, in Terminal:
  `xattr -d com.apple.quarantine "/Applications/Lawdie Time Capture.app"`.)
  Both Apple Silicon (`arm64`) and Intel (`x64`) builds are produced.
- **Windows** — run `Lawdie Time Capture Setup x.y.z.exe`. SmartScreen says "Windows
  protected your PC": click **More info → Run anyway**. The installer lets you pick the
  folder and adds a Start menu shortcut. The build is x64; Windows on ARM runs it under
  emulation.
- **Linux** — `chmod +x Lawdie-Time-Capture-x.y.z.AppImage` and run it. Foreground-app
  capture needs X11 (or XWayland); on pure Wayland the app runs but sees no windows.

Releases are cut by tag: bump `version` in `package.json`, commit, `git tag vX.Y.Z`,
`git push origin vX.Y.Z`. The Release workflow builds each platform on its own runner
and attaches the installers to the GitHub Release. Locally, `npm run package:mac` /
`package:win` / `package:linux` write the same files to `release/`.

## What works

- Today, Activity and Settings screens, in the Lawdie brand (cream, espresso, brown-gold,
  Playfair Display / Source Sans Pro / Fragment Mono, all bundled).
- Desktop foreground-app capture: app name, stable id (bundle id on macOS, executable
  path elsewhere), duration, and why the stretch ended. Sampled every 5 seconds plus on
  wake and unlock.
- Optional window titles. On macOS they need Screen Recording permission, which the OS
  asks for the first time. No title is read for an excluded app.
- Idle cutoff, sleep, and screen-lock handling: a segment and a running timer end at the
  last input; returning does not silently restart billing. Crash recovery ends at the last
  persisted observation, never across the downtime.
- Activity inbox: keep a segment as a time entry (description, billable) or dismiss it.
  Keeping never overlaps time already kept. Retention removes raw activity, never entries.
- Exclusions (password managers and system settings by default; add your own by bundle id
  or `.exe` name), pause/resume from the window or the tray, clear-activity control.
- Kiwi sync: pair this computer from Kiwi's Time page; captured activity and kept entries
  sync every minute. Off until you connect.
- Reads a workspace written by the Swift app (`schemaVersion` 1) and migrates it in place.

Capture starts **off**. Enable it from the sidebar, the tray, or Settings; use another
app; switch apps to see a completed segment. Closing the window keeps capturing; the tray
item reopens it. Quit from the tray to stop.

## Kiwi sync

Kiwi is the one destination. Lawdie CRM is not connected.

1. In Kiwi: Time → **Captured activity** → **On your desktop** → **Connect a computer**. Kiwi shows
   a token (`ldt_…`) once and keeps only its hash.
2. Here: Settings → **Connect to Kiwi** → paste → **Connect**. The app confirms the pairing
   (`GET /desktop-time/hello`) and only then stores the token, encrypted with the OS
   keystore (Keychain, DPAPI, or the Linux keyring via Electron's `safeStorage`). It never
   enters `workspace.json` or a backup.
3. Every minute while auto-sync is on (and on Connect and **Sync now**) the app pushes
   (`POST /desktop-time/sync`): every closed activity segment within retention (app, id,
   title only if titles are on, start/end, how it ended, kept/dismissed); every time entry
   you kept, with its local project and client labels; and the ids of entries you deleted
   since the last sync. Kiwi upserts on the app's own UUIDs, so a re-sync updates rather
   than duplicates.

Kiwi shows it on the Time page and, on rollup, turns each *billable* kept entry into a
draft under "No matter" for you to place and approve. Kiwi never guesses a matter from a
project label. Deleting an entry here dismisses its draft there if still a draft. Disconnect
from either side; what was synced stays in Kiwi. The server defaults to
`https://lawdie.co/kiwi-api` and can be changed under "Kiwi server" (e.g.
`http://localhost:4100`). Kiwi must have applied its `20260926_01_desktop_time` migration.

## Local data and privacy

The workspace is one JSON file, private to your OS account (mode 0600 where the platform
has it), written atomically:

- macOS: `~/Library/Application Support/Lawdie Time Capture/workspace.json`
- Windows: `%APPDATA%\Lawdie Time Capture\workspace.json`
- Linux: `~/.config/Lawdie Time Capture/workspace.json`

There is no telemetry, no screenshots, no keystroke recording, and no network use at all
until you connect Kiwi. Titles can contain sensitive data; enabling them does not redact
anything. A browser is one app to this capture; exclude it if you do not want it seen.

## Development

```sh
npm install
npm run dev          # the app, with hot reload
npm test             # the engine and the sync contract (vitest)
npm run typecheck    # main, preload and renderer
npm run package:mac  # or package:win / package:linux → release/
```

Flags for verification: `--workspace <path>` uses another workspace file, `--route
activity|settings|today` opens on that screen, `--screenshot <file.png>` writes the window
as rendered (and echoes the renderer console) so a change can be looked at without a
person at the screen. The engine treats a machine with no keyboard or mouse input for
longer than the idle timeout as idle, so a scripted run with the default 3 minutes
captures nothing; seed a workspace with `idleMinutes: 60` for that.

Kiwi's `RUN_LIVE_DESKTOP_TIME=1` test runs `src/shared/kiwi.live.test.ts` here against
its real routes, which is how the wire contract is proven end to end.

## Not yet

Manual timer and manual entries, projects and rates, reports and CSV, backup/restore —
all of which the Swift version had — are the next slices. Also: launch at login, an
updater, code signing / notarization, and Wayland capture. Sync is one-way (this computer
→ Kiwi).
