# Lawdie Time Capture

Cross-platform (macOS, Windows, Linux) desktop time tracker: Electron + TypeScript. Work
in this repo; do not modify `lawdie`, `lawdie-crm`, or `lawdie-time-capture` unless the
user explicitly expands scope. `kiwi` is the sync destination; changes to the wire
contract land in both repos together.

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
workspace; Kiwi never receives the in-progress segment or a running timer. Never seed
sample entries in a real workspace.

## Commands

```sh
npm run dev | npm test | npm run typecheck | npm run package:mac|win|linux
```

Verification flags: `--workspace <path>`, `--route activity|settings|today`,
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
cover. Real Office is exercised by hand. Kiwi matches to a matter from title + document
(`kiwi/backend/src/lib/matterMatch.ts`); the app never does.

## Kiwi

Only Kiwi, not the CRM (user, 2026-09-26). One-way, this computer → Kiwi, over a device
token from Kiwi's Time page. The wire contract is `syncRequest()` in `src/shared/model.ts`
and `cleanSyncBody()` in `kiwi/backend/src/lib/desktopTime.ts`; change both. Kiwi's
`RUN_LIVE_DESKTOP_TIME=1 … desktopTime.live.test.ts` spawns `src/shared/kiwi.live.test.ts`
here against its real routes.

## History

2026-09-25: Swift/SwiftUI app built, branded, verified on macOS (see `legacy/swift/`).
2026-09-26: Kiwi sync added to the Swift app; then the user asked for every platform,
and the app was re-founded on Electron + TypeScript rather than grafted (the capture
ideas were carried over from the Swift notes, not the code). Version 0.3.0. Installers
are unsigned: macOS users click Open Anyway once, Windows users Run anyway once.
