# Verification — September 25, 2026

- Optimized native arm64 release build: passed on this Mac.
- Standalone core checks: 20 passed, covering capture opt-in, separate title opt-in,
  exclusions, app switching, idle trimming, sleep, crash recovery, unobserved gaps,
  single-timer enforcement, frozen rates, explicit/idempotent review, overlap and
  invalid-entry rejection, retention, midnight/DST, persistence roundtrip, corrupt
  file preservation, unknown schemas, CSV safety, writer locking, write failures,
  and invalid settings/rates.
- Packaged app signature: `codesign --verify --deep --strict` passed (ad-hoc local signing).
- Native app launched successfully. Inspected the Today view and time-entry editor.
- Final screenshot verified the official wordmark, cream/espresso/brown-gold theme,
  font hierarchy, Lawdie Time Capture name, and removal of the blank title-bar strip.
- Real workspace remained empty with desktop capture paused during UI inspection.

Not manually verified yet: Accessibility-granted window-title capture, sustained
real-app tracking, physical lock/sleep transitions, menu-bar background use, and the
full backup/restore interaction. Their state-machine/storage behavior is covered by
core checks, but OS integration still needs the manual release checks.

The app is a local macOS build, not notarized for external distribution. The repo
is initialized locally; no GitHub remote has been created or pushed.

## Follow-up — real capture failure and fix

The user enabled capture but no activity was recorded. Inspection found the native
idle query used `.null`, a specific event type, instead of `kCGAnyInputEventType`
(`UInt32.max`). That could report continuous idle time and discard all activity.
The pure state-machine tests did not exercise this macOS API boundary.

Corrected the native query and rebuilt/re-signed the app. Verified against the real
running app: a Cursor foreground segment accumulated live, pausing capture completed
it, and the Activity inbox showed that real segment with Keep time / Dismiss actions.
Resumed capture afterward; window-title capture stayed off. Core checks still pass.
`scripts/check-live-capture.py` checks recent persisted output from the actual recorder
and fails when no real segments have appeared, unlike seeded unit fixtures.

Basic foreground capture plus pause/resume is now manually verified. Physical
lock/sleep, Accessibility titles, and extended continuous tracking remain unverified.

## 2026-09-26 — Kiwi sync

- `swift build` and `swift run TempoCoreChecks`: 26 core checks passed (20 prior plus six
  for sync: wire format and key spelling, tombstones only when connected, acknowledged
  deletions cleared, 0.1.0 workspace files still load and a bad server URL is rejected,
  batching under Kiwi's 500-item limit with deletions first, server URL normalisation).
- The seventh, `testLiveSyncAgainstServer`, ran as part of Kiwi's
  `RUN_LIVE_DESKTOP_TIME=1 … desktopTime.live.test.ts`: the real `URLSession` client paired,
  pushed two activities, one entry and one deletion into the real Express routes (in-memory
  database), and a wrong token was refused as `invalidToken`. Kiwi's side asserted the
  stored rows, including the instants and recomputed seconds.
- `bash scripts/package.sh` and `codesign --verify --deep --strict`: passed; Info.plist
  reads 0.2.0 with local networking allowed.
- The packaged app launched with `--workspace` on an empty file and `--route Settings`,
  wrote a workspace without a `sync` key, and quit cleanly. No Keychain item was left.

Not verified by hand: the Settings panel against a Kiwi that has applied the
`20260926_01_desktop_time` migration (none had at the time), the Keychain prompt on an
ad-hoc-signed rebuild, and a sync of a workspace larger than one batch.

## 2026-09-26 — Electron re-found (0.3.0)

The Swift app could not reach Windows, so the app was rebuilt on Electron + TypeScript
(`legacy/swift/` keeps the original). What was verified on this Mac:

- `npm test`: 22 engine and contract checks pass — the Swift core checks carried over
  (opt-in capture and titles, bounded segments, exclusions incl. Windows `.exe` names,
  idle trim, sleep, crash recovery, unobserved gap, single timer with frozen rate,
  explicit/idempotent review, overlap rejection, retention) plus the sync payload, tombstone
  and batching rules, Kiwi refusals, and the migration of a Swift `schemaVersion: 1` file.
- `npm run typecheck`: main, preload and renderer clean.
- Kiwi's `RUN_LIVE_DESKTOP_TIME=1 … desktopTime.live.test.ts`: the app's real client
  (`src/shared/kiwi.live.test.ts`) paired through Kiwi's real routes, pushed two activities,
  one entry and one deletion, and was refused with a bad token; Kiwi asserted the stored rows.
- The running app (`npm run dev --workspace … --route … --screenshot …`): real foreground
  capture of Cursor landed in the workspace file and in the Activity inbox; the Activity and
  Settings screens were looked at as PNGs and render in the brand. Finding on the way: with
  the default 3-minute idle timeout a scripted run captures nothing, because nobody is
  touching the keyboard — the idle rule working. Also found and fixed by looking: a blank
  window from the wrong preload extension (`.js` vs `.mjs`) and a CSP that blocked Vite's
  dev preamble.
- `npm run package:mac`: `Lawdie Time Capture-0.3.0-arm64.dmg`, `-0.3.0.dmg` (x64) and the
  matching zips, ~133 MB each, unsigned.
- `npm run package:win`: NSIS x64 installer (win-arm64 dropped: get-windows cannot be
  cross-compiled for it from macOS).

Not verified: the Windows and Linux builds have not been run on a Windows or Linux
machine — capture, lock/unlock and the SmartScreen "Run anyway" path there are unclicked.
The Kiwi click-through (paste token in the app → segment on Kiwi's "On your desktop" panel)
waits on Kiwi's `20260926_01_desktop_time` migration being applied to the database the
local Kiwi backend uses. Timer, manual entries, projects, reports, CSV and backup/restore
are not yet rebuilt.

### Click-through, same day

After the user applied Kiwi's `20260926_01_desktop_time` migration: a device was paired
through Kiwi's real routes (Clerk session, token handed over by the user), the packaged
app was opened on the real workspace (the Swift file migrated in place: 120 activities
kept, backup written beside it), the user pasted the token with the server set to the
local Kiwi backend, and within the minute Kiwi's Time page showed **On your Mac →
Abhinav's Mac → Synced just now · v0.3.0** with the captured segments, read from the
migrated database. The workspace records `lastSyncedAt` and no error; the token file is
mode 0600 and encrypted.

Found on the way and fixed: a segment closed because this app came to the front was
labelled `excluded` (Kiwi rendered it "opened a private app"); it is now `switched`, and
capture switched off closes as `paused`. The installers in `release/` were rebuilt from
the final source afterwards. The app the user is running is the build before that fix;
the label difference is cosmetic.

Also changed in Kiwi, because the desktop path exposed it: the Time page gate now opens
on a connected desktop computer as well as on the extension, hosts the pairing form, and
"Elsewhere in the browser" reports a missing or paused extension instead of "Capturing".

## 2026-09-27 — Office document details: proven end to end

With Excel signed in and Kiwi's `20260926_02_desktop_documents` migration applied: the
installed 0.4.0 app (real workspace, paired) captured a segment in Excel with
`document = { name: "Brantley Millwork 2026-TX-0118 schedule.xlsx", path: …, excerpt:
"Penalty schedule" }`, synced it, and Kiwi's `/desktop-time/activity` returned it with
`matter_name: "Brantley Millwork, Inc. v. Commissioner", matter_number: "2026-TX-0118",
match_reason: "matter_number"` — one of the user's real matters, matched from the file
name. Probe failures now go to `office.log` beside the workspace and under the Settings
toggle; none occurred. Windows COM untested.

Word, later the same day: the first Word script failed with "The variable t is not
defined" — inside `tell application "Microsoft Word"`, `text 1 thru 600 of …` is Word's
own `text` element, so the assignment went to Word and the variable was never set.
Word also reports `full name` as an HFS path. All four scripts now read whole values
inside the tell and truncate / convert the path outside it. Verified: the installed app
captured a 20 s Word segment with `document = { name: "Hollis Vance IRS response
2026-TX-0126.docx", path: /…/…docx, excerpt: "MEMORANDUM Re: Hollis & Vance Staffing,
LLC — … Matter 2026-TX-0126 …" }` (a hand-written .docx opened through Finder, since
Word's `make new document` stalls on its start screen).

PowerPoint: a deck made and saved by automation as "Brantley hearing deck
2026-TX-0118.pptx"; the installed app captured a 75 s segment with its name and POSIX
path (no excerpt, by design). First attempt caught a parser gap: PowerPoint had a blank
unsaved "Presentation1" in front, whose "full name" is just its name, and that was being
stored as the path — a name without a separator is now no path.

Outlook: cannot be tested on this Mac. It runs as "New Outlook" with **no account
signed in** (`accounts=0/0`, an "Add Account" window), so no message exists to read;
`selected objects` and `current messages` answer 0 without error, and a draft made by
automation is not persisted. The script gained a fallback to the item open in the front
window (legacy Outlook's `object of window 1`) and runs to completion against New
Outlook, returning "nothing open". Verifying the body/subject read needs a mailbox.

Found on the way: a computer paired again after a disconnect re-sent its history under a
new device id, and Kiwi's per-device uniqueness kept every copy (280 rows for 146
segments, duplicate React keys on the Time page). Kiwi's `20260927_01` migration makes
activities and entries unique per user and the sync take rows over.

## 2026-09-26 — Office document details (earlier, before Office was signed in)

Built and unit-verified: the opt-in "Read Office document details" preference, the
Apple Events / COM probe with its NAME/PATH/TEXT protocol (`src/main/office.test.ts`:
app detection by bundle id and exe, parsing incl. Windows line endings, bounding,
caching, shared in-flight asks, refusal handling), the engine rules for documents on a
segment (`model.test.ts`), the sync payload, and Kiwi's matcher, routes, rollup and
panel (93 backend tests, 43 Time-page tests).

Against real Office on this Mac: `version` queries to Excel answer (so Apple Events
reach Office and the permission path works), but `activate` + creating or reading a
document in Word or Excel times out (`AppleEvent timed out, -1712`) — both apps were
freshly installed and are sitting on their first-run / sign-in screens, which block
automation until a person clicks through them. The end-to-end proof (Excel workbook
named for a real matter → document details on the segment → matter matched on Kiwi's
panel) is therefore not yet done; it needs Office signed in once and Kiwi's
`20260926_02_desktop_documents` migration applied. Windows COM is untested here.

## 2026-09-27 — Lawdie CRM as a second destination, one token for both

- `npm test` (35), `npm run typecheck` clean. The sync state became per-product targets
  (`SyncState.targets`), each with its own device id and deletion outbox; a 0.4.x file is
  read by `normalizeSync()`.
- Live, against a local Kiwi (`:4100`) and a local CRM (`:4000/api`): the CRM's Time page
  minted a token and registered it with Kiwi; the built app launched with
  `--kiwi-token … --kiwi-destination both` said hello to both, synced a copy of the real
  workspace (252 activities, 3 kept Office entries), and the CRM matched 7 activities by
  matter number and wrote the 3 kept entries to its ledger on 2026-TX-0118 / 0126 with the
  matter's rate; the CRM Time page showed them as "On the ledger". Kiwi took the same rows
  under the new device.
- Found on the way: the CRM's gate opened on its poll while the token was still on screen
  (now held until Done), and the ledger table did not learn about entries a sync logged
  (now reloads when the poll shows new ones).

## 2026-09-28 — stretches in the inbox

- `npm test` (37), `npm run typecheck` clean. New: `stretchesOf` grouping across other
  documents' sittings with the gap and the noise floor; `keepStretch` writing one entry
  whose sittings alone count and alone block overlap; delete reopening every sitting; the
  wire `seconds`. Kiwi (39) and the CRM (17) tests cover `cleanEntry` honouring `seconds`.
- The built app opened on a copy of the real workspace (252 sittings): the inbox showed
  stretches with sitting counts and a single "short switches" line instead of one row per
  hop (screenshot looked at).

