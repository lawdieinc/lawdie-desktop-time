# Lawdie Time Capture

Cross-platform (macOS, Windows, Linux) desktop time tracker: Electron + TypeScript. Work
in this repo; do not modify `lawdie`, `lawdie-crm`, or `lawdie-time-capture` unless the
user explicitly expands scope. `kiwi` and `lawdie-crm` are the sync destinations; changes to
the wire contract land in all three repos together.

## Layout

- `src/shared/` — pure, no Electron: `model.ts` (workspace types, the capture state
  machine, review rules, sync payload, file validation, the v1 Swift-format migration),
  `kiwi.ts` (the client), `feed.ts` (Kiwi and browser time brought in: pages, receipts,
  overlap clipping, matter links), `export.ts` (kept entries as CSV: project, date, hours,
  description; the Time screen's Export CSV, for the range shown), `format.ts`, `state.ts`. Everything here is under
  `model.test.ts` and `feed.test.ts`.
- `src/main/` — the Electron main process: `workspace.ts` (atomic file, lock),
  `store.ts` (the only place the workspace changes; copy → validate → save → publish),
  `capture.ts` (get-windows + powerMonitor → `observe()`), `sync.ts` (token via
  `safeStorage`, the minute tick), `feed.ts` (the import pass, every three minutes),
  `index.ts` (window, tray, IPC).
- `src/preload/` — the whole surface the window may touch (`window.lawdie`).
- `src/renderer/` — React. One file, `App.tsx`; brand in `styles.css` (see `docs/brand.md`).
- `resources/` fonts and brand assets; `build/` icons; `electron-builder.yml` installers.
- `legacy/swift/` — the first, macOS-only version. Reference only; not built.

## Rules that must survive any change

Capture is opt-in; titles are a separate opt-in; exclusions are checked before a title is
read; a segment is bounded by wall-clock observations and never spans an unobserved gap
(`GAP_SECONDS`); only the window in front counts, for as long as it is in front, input or
not (sleep and the lock screen end it), and the one exception is a call — a call app
recording from the microphone (`src/shared/calls.ts`) gets the time wherever the focus is;
idle stops only a running timer, at the last input; raw activity is evidence until a person
keeps it; kept time never overlaps; rates freeze at save; the token never enters the
workspace; Kiwi never receives the in-progress
segment or a running timer; a suggestion never overwrites a person's matter; browsers are
not captured (`BROWSER_OWNER_IDS`, checked like an exclusion; the Lawdie browser extension
owns web time, so it is never counted twice; its segments come back through Kiwi, see
below). Imported time is evidence like any other: this computer's own time wins an overlap,
one workspace owns a source until it is reviewed, and a receipt outlives the raw row so a
replay never brings reviewed time back. Never seed sample entries in a real workspace.

## Commands

```sh
npm run dev | npm test | npm run typecheck | npm run package:mac|win|linux
```

Verification flags: `--workspace <path>`, `--route activity|matters|settings|today`, `--click <selector>`,
`--screenshot <file.png>` (also echoes the renderer console to stdout). **Look at the
screenshot** after a renderer change: a blank cream window is a silent failure (a wrong
preload path or CSP did exactly that on 2026-09-26). Idleness (no input for longer than
`idleMinutes`) stops only a running timer; capture goes on while a window is in front.

npm 11 blocks install scripts by default; `package.json` `allowScripts` approves the ones
this app needs (electron, get-windows, esbuild). If Electron's binary is missing, run
`npm rebuild electron get-windows`.

## Office document details

`src/main/office.ts` asks Word/Excel/PowerPoint/Outlook what is open through OS
automation (osascript / PowerShell COM), opt-in, throttled, timeboxed; the three-line
NAME/PATH/TEXT protocol is parsed by `parseProbeOutput()`, which is what the tests
cover. Real Office is exercised by hand.

## Screenshots

Opt-in (`captureScreenshots`, off by default; 2026-11-03, to see what time was when
reviewing it). `src/main/screenshots.ts` captures the one window in front through
`desktopCapturer` (macOS: the Screen Recording permission titles need; `missing` covers
it), a 1440×900 JPEG in `screenshots/` beside the workspace, served to the window as
`lawdie-shot://shot/<name>`. The rules are pure in `model.ts` and tested:
`screenshotDue()` (none for a segment under 20 s, then every 5 minutes, at most 48),
`addScreenshot()` (only to the segment in progress or a pending one), `keepStretch()`
copies those inside the kept time to the entry, dismissing drops them, and
`referencedScreenshots()` is what `collect()` keeps (hourly; anything else is deleted). A
name is `<activity id>-<epoch ms>.jpg` and is validated, so it is never a path. Never of a
browser, a private app, this app or a call behind the window in front. Never synced and
never sent to the AI: `syncRequest()` and the matter requests list their fields.

## On-screen text

`src/main/screenText.ts` reads some of the text the window in front shows, for apps other
than Office (asked directly, above) and browsers (never captured), through the OS
accessibility system: on macOS `native/screen-text/main.swift`, built universal into
`resources/bin/` by `scripts/build-screen-text.mjs` (run by `dev`/`build`, unpacked from
the asar) and needing the Accessibility permission; on Windows a UI Automation script in
PowerShell. No screenshots. Opt-in (`captureScreenText`), never password fields, menus or
buttons, once per window title a minute, at most `SCREEN_TEXT_MAX` characters kept per
segment (the first read; scrolling is not a switch). `parseScreenText()` is what the tests
cover; the readers are exercised by hand. It is sent to Kiwi only as `screen_text` in a
matter request, never on sync.

## Matters

The app names the matter (2026-10-15, after the beta user's "five or six entries for one
matter" feedback). `src/shared/matters.ts` is pure and tested: `matterRequest()` builds
the request from closed, pending, unnamed activity with a title or document (never the
segment in progress, never kept or dismissed time), `applyMatters()` validates the
answer, `inboxOf()` groups the inbox one row per matter per day across apps.
`src/main/matters.ts` sends it to Kiwi (`POST /desktop-time/matters`, device token, every
30 minutes and on opening Activity if over 10 minutes since, opt-in `suggestMatters`, only while connected to Kiwi). Kiwi holds the prompt
and asks its server-side model (`kiwi/backend/src/lib/desktopMatters.ts`, Gemini via
Vertex), so no one enters a key and a device token buys only this question; it stores
nothing. A person's name (`matterBy: "person"`) is never overwritten and is fed back as
examples. The Matters screen (`MattersView` in `App.tsx`) lists them with time, billable
value and what waits for review, and edits name, client and rate (`updateProject`, a new
rate applies from then on), merges (`mergeProjects`) and archives; every Activity row
names its matter or says "No matter". Keeping a
matter makes or reuses the local project of that name, so it reaches Kiwi/the CRM as the
entry's `project_name`; mapping that name to a real matter (or logging it under the name
when none matches) is the destinations' job and not built yet — Kiwi still matches from
title + document (`kiwi/backend/src/lib/matterMatch.ts`).

After naming, the same loop asks Kiwi for a billing description per review row
(`draftRequest()`/`applyDrafts()`, `POST /desktop-time/drafts`; a row is drafted when a
quarter of its time has no draft, the person's own descriptions are the style examples)
and for an insight per matter whose time changed and whose last insight is over an hour
old (`insightRequest()`/`applyInsights()`, `POST /desktop-time/insights`; the app sends
the totals, so the model quotes figures rather than computing them). Prompts live in
`kiwi/backend/src/lib/desktopDrafts.ts` and `desktopInsights.ts`. Drafts and insights
record their source; "sample" ones come only from demo data and are never replaced.
One switch, "AI suggestions" (`suggestMatters`), covers all three.

## Kiwi and Lawdie CRM

Kiwi, the CRM, or both (`SyncState.targets`, one per product, 2026-09-27; before that
Kiwi only, flat — `normalizeSync()` reads the old shape). Kept time goes one way, this
computer → each target (the one thing that comes back is Kiwi's own evidence, next
section), over ONE device token: the Time page that mints it registers it with the other
product too (`POST …/devices { name, token }` on both backends). Both
answer `GET /desktop-time/hello` and `POST /desktop-time/sync` under their API base
(`https://lawdie.co/kiwi-api`, `https://crm-api.lawdie.co/api`). The wire contract is
`syncRequest()` in `src/shared/model.ts`, `cleanSyncBody()` in
`kiwi/backend/src/lib/desktopTime.ts` and `lawdie-crm/server/services/desktopTimeService.js`;
change all three. `KiwiClient` serves both; its `product` names the destination in messages. Kiwi's
`RUN_LIVE_DESKTOP_TIME=1 … desktopTime.live.test.ts` spawns `src/shared/kiwi.live.test.ts`
here against its real routes.

## Kiwi and browser time

Opt-in (`importKiwiTime`, "Bring in browser and Kiwi time"), Kiwi only, after
`docs/kiwi-and-browser-time.md`. Every three minutes `src/main/feed.ts` pages
`GET /desktop-time/feed` (the Chrome extension's segments from `browser_activities`, Kiwi's
own chat and email time from `activity_time`, and the matters the person can reach),
claims each page before saving it (`POST /desktop-time/feed/claim` → `desktop_import_claims`:
one workspace owns a source until it is reviewed; Kiwi's `/billing/rollup` and web Keep
refuse a claimed row, and a draft already rolled up from one is trimmed), then
`importFeed()` in `src/shared/feed.ts` (pure, `feed.test.ts`). An imported row is closed,
pending activity with `origin`, `originRef`, `sourceKind`, `url` and `kiwiProjectID`; this
computer's time wins an overlap (`clipImported()`, re-checked at keep); a receipt per source
outlives the raw row and is reported back (`POST /desktop-time/feed/review`). Keeping
records `sourceRefs` with the kept intervals; `syncRequest()` sends them and
`kiwi_project_id` to Kiwi only (the CRM drops both), and Kiwi's sync reserves the sources
for that entry before filing it. Matters: `Project` gains `kiwiProjectID`, `kiwiAccount`,
`matterNumber`, `aliases`, `nameBy`; imported time lands on the local project that matches
by id, then number, name, alias — never ambiguously — else waits under Kiwi's name. The AI
round also asks `POST /desktop-time/joins` which local matters are Kiwi's: high confidence
joins by itself (the model's name gives way to Kiwi's and stays as an alias; a person's
name, on the project or on a row, is kept) with Undo; any other confidence waits on the
Matters screen ("Kiwi matter links"). A workspace belongs to one Kiwi account
(`feed.account`). Kiwi side: `backend/migrations/20261027_01_desktop_feed.sql`,
`backend/src/modules/desktopFeed/`. Checked 2026-10-29: Kiwi's `email` time is reading
mail inside Kiwi, not an add-in in desktop Outlook, so it never doubles this app's Outlook
time.

## History

2026-09-25: Swift/SwiftUI app built, branded, verified on macOS (see `legacy/swift/`).
2026-09-26: Kiwi sync added to the Swift app; then the user asked for every platform,
and the app was re-founded on Electron + TypeScript rather than grafted (the capture
ideas were carried over from the Swift notes, not the code). Version 0.3.0. Installers
are unsigned: macOS users click Open Anyway once, Windows users Run anyway once.
2026-09-27: Lawdie CRM became the second destination (its `057_crm_desktop_time`
migration, `/api/desktop-time/*`, Time page "On your desktop"); Settings gained the picker,
then "Both" with one token registered on both sides at pairing.
2026-09-28: the inbox reviews stretches (sittings on one document grouped, 15-minute gap,
one entry with `sittings`), after "too many entries a user needs to manually accept".
Servers honour the entry's `seconds`. Version 0.6.0.
2026-10-15: Kiwi names matters; the inbox shows one row per matter per day (see Matters).
2026-10-19: macOS releases are signed with one self-signed certificate
(`scripts/mac-signing-cert.sh` → `MAC_CERT_P12`/`MAC_CERT_PASSWORD`, loaded in
`release.yml`), because ad hoc builds lost Screen Recording and Accessibility on every
update while System Settings still showed them on. Screen Recording is asked once a run
(`screenRecordingAttempt()`), never every minute. Version 0.7.1.
2026-10-21: the app updates itself (`src/main/updater.ts`, electron-updater against this
repo's GitHub Releases: checked 30 s after launch and every 4 hours, downloaded in the
background, installed on restart; failures are logged, never shown). `release.yml`
attaches the `.zip`s, `latest*.yml` and block maps it reads. The Mac updater installs only
an update signed like the running app, so it depends on the one certificate above. The
main bundle is an ES module: import electron-updater by its default export. Version 0.8.0.
2026-10-22: after the beta user's hour-long Teams call came out as seconds and reading in
Word as minutes, capture stopped ending at idle (the window in front counts while it is in
front) and a call counts in the background: `native/mic-users` (Core Audio's process list,
macOS 14.2+, built beside screen-text) and the Windows microphone registry say who is
recording; `src/main/calls.ts` asks every sample, and while a call app records, capture.ts
observes the call instead of the window in front, so the minutes are never counted twice.
The same day: unnamed mail (`MAIL_OWNER_IDS`) is one stretch per app rather than one per
message, which had sent an hour of Outlook into the short hops; and a matter whose whole
day is under `NOISE_SECONDS` joins the short hops ("brief touches") instead of a row.
Version 0.9.0.
2026-10-23: a blank title ("" with titles on) in the same app no longer splits a segment
(Finder flickered "Downloads" → "" every sample); titles off stays null. Rows of several
sittings say "between 12:17 and 12:33", since their time is less than the span
(`spanLabel()`), and durations under ten minutes show seconds. Version 0.9.1.
2026-10-25: "Personal" (`PERSONAL`) is the one reserved matter, after a football pool landed
on a legal matter: Kiwi's prompt offers it, a person sets it with a row's Personal button;
`inboxOf()` lists it apart (`personal`), `keepStretch()` refuses it and `syncRequest()`
leaves it out. "Not personal" sends an item back to review.
2026-10-29: Kiwi and browser time come into the inbox (section above): the plan was
reviewed and built in Codex 2026-10-26–28, then finished, tested and documented here.
Version 0.10.0.
2026-11-02: after the Oct 23 update installed unnoticed and macOS dropped Screen Recording
for six days (no titles, no screen details): an update downloads in the background but
installs only when the person presses Install (window callout, sidebar, tray, a
notification; `autoInstallOnAppQuit` off). A permission a switched-on feature needs and
lacks (`AppState.missing`, checked every 15 s in index.ts) shows a callout that cannot be
dismissed, a sidebar line and a tray item, and once a run a notification and the window.
Text is larger, and Settings → Display offers Standard/Large/Larger (`textSize`, the
window's zoom), after "unreadable at distance" on a laptop.
2026-11-03: screenshots, opt-in and local only, kept with entries (see Screenshots). The
"no screenshots" promise in Settings now reads "unless you switch them on".
RingCentral Meetings (a Zoom build, `us.zoom.ringcentral`) counts as RingCentral. Version 0.11.0
(0.10.0 was never tagged; its changes ship here).
