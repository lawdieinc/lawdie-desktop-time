# Lawdie Time Capture

Cross-platform (macOS, Windows, Linux) desktop time tracker: Electron + TypeScript. Work
in this repo; do not modify `lawdie`, `lawdie-crm`, or `lawdie-time-capture` unless the
user explicitly expands scope. `kiwi` and `lawdie-crm` are the sync destinations; changes to
the wire contract land in all three repos together.

## Layout

- `src/shared/` — pure, no Electron: `model.ts` (workspace types, the capture state
  machine, review rules, sync payload, file validation, the v1 Swift-format migration),
  `kiwi.ts` (the client), `format.ts`, `state.ts`. Everything here is under `model.test.ts`.
- `src/main/` — the Electron main process: `workspace.ts` (atomic file, lock),
  `store.ts` (the only place the workspace changes; copy → validate → save → publish),
  `capture.ts` (get-windows + powerMonitor → `observe()`), `sync.ts` (token via
  `safeStorage`, the minute tick), `index.ts` (window, tray, IPC).
- `src/preload/` — the whole surface the window may touch (`window.lawdie`).
- `src/renderer/` — React. One file, `App.tsx`; brand in `styles.css` (see `docs/brand.md`).
- `resources/` fonts and brand assets; `build/` icons; `electron-builder.yml` installers.
- `legacy/swift/` — the first, macOS-only version. Reference only; not built.

## Rules that must survive any change

Capture is opt-in; titles are a separate opt-in; exclusions are checked before a title is
read; a segment is bounded by wall-clock observations and never spans an unobserved gap
(`GAP_SECONDS`); idle trims to the last input; raw activity is evidence until a person
keeps it; kept time never overlaps; rates freeze at save; the token never enters the
workspace; Kiwi never receives the in-progress
segment or a running timer; a suggestion never overwrites a person's matter; browsers are
not captured (`BROWSER_OWNER_IDS`, checked like an exclusion; the Lawdie browser extension
owns web time, so it is never counted twice). Never seed
sample entries in a real workspace.

## Commands

```sh
npm run dev | npm test | npm run typecheck | npm run package:mac|win|linux
```

Verification flags: `--workspace <path>`, `--route activity|matters|settings|today`, `--click <selector>`,
`--screenshot <file.png>` (also echoes the renderer console to stdout). **Look at the
screenshot** after a renderer change: a blank cream window is a silent failure (a wrong
preload path or CSP did exactly that on 2026-09-26). The engine treats a machine with no
input for longer than the idle timeout as idle; a scripted run captures nothing with the
default 3 minutes — seed `idleMinutes: 60`.

npm 11 blocks install scripts by default; `package.json` `allowScripts` approves the ones
this app needs (electron, get-windows, esbuild). If Electron's binary is missing, run
`npm rebuild electron get-windows`.

## Office document details

`src/main/office.ts` asks Word/Excel/PowerPoint/Outlook what is open through OS
automation (osascript / PowerShell COM), opt-in, throttled, timeboxed; the three-line
NAME/PATH/TEXT protocol is parsed by `parseProbeOutput()`, which is what the tests
cover. Real Office is exercised by hand.

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
5 minutes, opt-in `suggestMatters`, only while connected to Kiwi). Kiwi holds the prompt
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

## Kiwi and Lawdie CRM

Kiwi, the CRM, or both (`SyncState.targets`, one per product, 2026-09-27; before that
Kiwi only, flat — `normalizeSync()` reads the old shape). One-way, this computer → each
target, over ONE device token: the Time page that mints it registers it with the other
product too (`POST …/devices { name, token }` on both backends). Both
answer `GET /desktop-time/hello` and `POST /desktop-time/sync` under their API base
(`https://lawdie.co/kiwi-api`, `https://crm-api.lawdie.co/api`). The wire contract is
`syncRequest()` in `src/shared/model.ts`, `cleanSyncBody()` in
`kiwi/backend/src/lib/desktopTime.ts` and `lawdie-crm/server/services/desktopTimeService.js`;
change all three. `KiwiClient` serves both; its `product` names the destination in messages. Kiwi's
`RUN_LIVE_DESKTOP_TIME=1 … desktopTime.live.test.ts` spawns `src/shared/kiwi.live.test.ts`
here against its real routes.

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
