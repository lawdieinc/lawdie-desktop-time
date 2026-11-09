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
  description; the Time screen's Export CSV, for the range shown), `format.ts`, `state.ts`; billing (see
  Billing): `rules.ts`, `clientRules.ts`, `applyRules.ts`, `invoice.ts`, `invoiceHtml.ts`, `narrative.ts`,
  `drafter.ts`, `typed.ts`, `importMatch.ts`, `demo.ts`. Everything here is under
  `model.test.ts`, `feed.test.ts` and the billing tests beside their files.
- `src/main/` — the Electron main process: `workspace.ts` (atomic file, lock),
  `store.ts` (the only place the workspace changes; copy → validate → save → publish),
  `capture.ts` (get-windows + powerMonitor → `observe()`), `sync.ts` (token via
  `safeStorage`, the minute tick), `feed.ts` (the import pass, every three minutes),
  `index.ts` (window, tray, IPC), `rulesFeed.ts` (client rulebooks from the billing system), `docx.ts` and
  `xlsx.ts` (the time sheet as Word; a time-system export read).
- `src/preload/` — the whole surface the window may touch (`window.lawdie`).
- `src/renderer/` — React. `App.tsx` (the screens), with billing beside it: `Billing.tsx`, `ClientRules.tsx`,
  `Rules.tsx`, `Narrative.tsx`, `Imported.tsx`, `Menu.tsx`; brand in `styles.css` (see `docs/brand.md`).
- `resources/` fonts and brand assets; `build/` icons; `electron-builder.yml` installers.
- `legacy/swift/` — the first, macOS-only version. Reference only; not built.

## Rules that must survive any change

Capture is opt-in; titles are a separate opt-in; exclusions are checked before a title is
read; a segment is bounded by wall-clock observations and never spans an unobserved gap
(`GAP_SECONDS`); only the window in front counts, for as long as it is in front, input or
not (sleep and the lock screen end it), and the one exception is a call — a call app
recording from the microphone (`src/shared/calls.ts`) gets the time wherever the focus is;
idle stops only a running timer, at the last input; ten minutes without input
(`IDLE_FLAG_SECONDS`) is flagged on the segment (`idle`), never on a call, and is counted
unless the person leaves it out at keep (`leaveOutIdle`); raw activity is evidence until a person
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
`--steps "btn:Keep time||type:input.inline-edit=Text||key:input.inline-edit=Enter"` (a flow, one step a
second; the kinds are listed in index.ts), `--screenshot <file.png>` (also echoes the renderer console to
stdout). A hand-written workspace fails validation easily (`matterBy` is `ai`/`person`); build one through
`emptyWorkspace()` + `validate()` in a throwaway vitest file instead. **Look at the
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
names its matter or says "No matter", and its "Matter ▾" menu (`MatterMenu`, 2026-11-06) moves the row,
or one document inside a matter ("Move…"), to a known matter, off any matter, or to a new one named in
place (`setMatter`, so it is the person's and never suggested over); the matter moved into unfolds and
a toast (`notify`, `NoticeContext`) says what happened. A name that is already another matter's, from
the row's pencil, the Matters page or "New matter…", merges into it rather than clashing
(`existingMatter()`, `renameMatterNamed()` returns the matter merged into; kept entries follow through
`mergeProjects`) and the toast says so. Each item inside a matter's row says what it was and shows
some of its text (`describeItem()` in matters.ts, tested: the document's folder, email, a call, a
page's site, the Office excerpt or on-screen text when those are on, when, where the time went next,
idle). Keeping a
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

## Billing

Merged from Meeth's `manatt-narratives` on 2026-11-04 (built for the Manatt demo, 2026-10-21 to
2026-11-04; README "Billing" has the person's view). Client rulebooks (`ClientRulebook`, one card
per rule with the client's words and its source) arrive by `--rules-feed <url|file>` (`rulesFeed.ts`,
read every 2 s) or a `--demo <seed.json>` workspace (`resources/demo/manatt.json`; `workspace.demo`
runs on the seeded day's clock and is never updated by a release). `applyRules()` is the one
function every figure comes from: the Time page, the Matters page, the time sheet (PDF and DOCX)
and the invoice all print its lines, so nothing recomputes a line on its own. Entries gain
`hours`, `taskCode`, `activityCode`, `raw`, `parts`/`sources` (the narrative and the evidence ids
it rests on, `workspace.evidence`), `status` (draft / suggested / flagged), `typed` (a note from
Add entry or an iTimeKeep/Excel import matched into the captured entry; it never adds hours) and
`tasks`. Narratives are drafted by the stored rules (the demo) or Kiwi's model
(`narrativeDrafter`); a part naming an unknown source is dropped. Schema version 3: every
addition is optional, a version 2 file reads as it is and is written back as 3 (so a build before
0.13 refuses it). Nothing here changes capture; billing details go on the entry at keep
(`KeepInput.hours`/codes/`hourlyRate`) only under a rulebook. A demo or verification run sets
`LAWDIE_USER_DATA` so it never locks the real workspace.

For a person, not a seed (2026-11-04, later the same day): Settings → Billing holds the firm's
side (`Workspace.billing`, `BillingSetup`: firm, address, timekeeper, terms, remittance, contact,
invoice prefix and counter, folder, logo; `setBilling()`/`setBillingFile()`), a matter holds its
own (`Project.matterNumber`, `billTo`, `codeSet`, edited on its page; `contextOf()` gives the
rules a context from them when a seed gave none), and `termsFor(w, project, through, number)`
joins the two into the `InvoiceTerms` a bill prints (a seed's `invoice` still stands in when
there is no setup). A bill is scoped (`BillScope`: a day for the Time page, or a matter over
a period for the Invoice sheet in Billing.tsx; `applyRules(w, day, mode, scope)`). An invoice
takes `nextInvoiceNumber()` and `invoiceIssued()` moves the counter once the PDF exists. The
logo comes from the firm's website (`src/shared/logo.ts` orders the page's apple-touch-icon,
og:image, sized icons and the well-known paths; `fetchLogo` in index.ts keeps the first that
decodes at 48 px or wider, as `billing-logo.png` beside the workspace) or from a chosen file.
Client rules are made in the app too (`src/shared/clientRulebooks.ts`, the same day): the
Client rules page (reached from the Time page's "Client rules…" when no client has rules,
else Apply client rules → Open … rules) makes a rulebook per client (`addRulebook`, key from the
client's name) and adds, changes or deletes rules of the ten kinds (`saveClientRule`: what each
kind needs is checked, ids run NBH-1, NBH-2 from the client's initials, `describeRule()` says
what a rule does when the person wrote nothing). `RuleEditor.tsx` holds the two sheets. A
rulebook made here also checks entries in the Keep sheet: `ruleSetOf()` maps the kinds an entry
can be checked for on its own (tenths, split, codePrefix, noCharge A105, the vague, clerical,
travel and research checks) to keep-time rules, and `rulebookFor()` falls back to it when the
client has no exported rule set. The Invoice sheet defaults to the matter's client's rulebook.
"Why this entry" comes from capture for a real entry (`capturedWhy()` in model.ts, called by
`keepStretch`, the same day): the stretches kept as `work`, each as a source with an evidence
record (a document with its path, an email's subject, a web page with its address, else the app
window; kinds `document`, `email`, `page`, `chat`, `window`), the reasons in words (where the
time went, idle left out, who drafted the narrative) and `matterReason`; `parts` is the
narrative citing every source, so "Draft again" can ask Kiwi's model to write parts that cite
them (`evidenceLine` knows the capture kinds). Deleting the entry removes its evidence. The
rules drafter only replays a seed's parts, so an entry kept from capture always goes to the
model when Kiwi is connected.
A rejection (`src/shared/rejection.ts`, the same day): every invoice made in the Invoice sheet
is remembered (`Workspace.invoices`, `IssuedInvoice`: number, matter, period, mode, total, entry
ids). Billing → Record a rejection… names one, takes the client's words, and
`rejectionProposals()` reads each sentence for a rule it states (one task per entry, tenths,
a rate cap with its figure, no charge for internal conferences, the vague, clerical and travel
checks, a cap on calls, research needing approval), each proposed quoting the sentence;
`recordRejection()` marks the invoice, sends its entries back as `flagged` with
`why` "Sent back by …: …" (so they leave the bill until Fix and confirm → Save, which
`editEntry` settles), and puts the approved rules on the client's rulebook (made if none)
under "Rejection of invoice N". The next invoice for the matter says it resubmits
(`resubmits()`). A model reading the note is the same open item as rules from a document.
Not built yet: rules proposed by a model from an uploaded guidelines document or a rejection
note (needs a Kiwi route), custom DOCX templates (layouts are in `invoiceHtml.ts`/`docx.ts`),
live Outlook/Teams sources (a seed's evidence; capture's own is above).

## Welcome and tutorial

For a new person (2026-11-07). `src/shared/onboarding.ts` is pure and tested: `needsWelcome()` shows the
welcome once, on a workspace nobody has used (no entries, activity, imports, sync or firm, not a demo, and
`preferences.onboardedAt` unset; someone who used the app before it existed is never interrupted);
`TOUR_STEPS` is the tutorial (route, `data-tour` target, title, body; the Keep steps `advanceOn` the
sheet opening and closing, `stepAfter()`; billing has its own: client rules, typed and imported
entries, the Billing menu (a disabled stand-in while no firm is set up) and the Billing tab); `tutorialStretch()` is the one sample stretch the tutorial
shows. `Onboarding.tsx` holds both: `Welcome` (a sheet, five steps, its switches live: capture, titles,
Office details, start at login; connect with a token or skip; the firm for the bill (`WelcomeBilling`:
name, timekeeper, address saved through `setBilling`, then the logo fetched from the firm's website
or chosen, the same calls as Settings → Billing) or skip; finishing or skipping writes
`onboardedAt` and can start the tutorial) and `Tour` (a spotlight hole over the step's control and a
card beside it, clicks pass through; measured every 150 ms since the control moves; a step whose
control is not on screen says so). A step opens what it describes: `TourStepContext` (Menu.tsx)
carries the step id, a `Menu` whose `tourStep` it is stays open (Entries, Billing) and is spotlit
with its button above the dim layer, Settings switches to the Billing tab, the sample row unfolds
its item, and the rules step routes to the Client rules page (the New rulebook sheet when no client
has rules yet; a rulebook made there is real). The sample row (`SampleRow` in App.tsx) is the window's only:
`isTutorialID` ids never enter the workspace, its Keep time opens the real `KeepSheet` with a `keep`
override that saves nothing and says so in a toast, and `keepStretch` refuses its ids (tested). The
small blocks shared by both files live in `ui.tsx`. Entry points: the welcome itself, Settings → Display
& data → "Learn the app", and `--route welcome|tutorial|whatsnew` for the harness.

## What's new

After Kiwi's card (2026-11-09). `src/shared/releases.ts` is what the What's new card (`WhatsNew.tsx`) shows:
`RELEASES`, newest first, id = the version it ships in, a date, a title and one to five items (an icon from
`RELEASE_ICONS`, a title, one plain line, optionally a `route` to open). **When a change is something a person
would notice, add an entry at the top in the same change**, written for a lawyer (what they can now do, not what
moved in the code); a bug fix with nothing visible adds none. `needsWhatsNew()` (tested in `releases.test.ts`)
opens it once per release, on this computer (`preferences.seenRelease`, set by Got it, Escape, the backdrop or an
item's link): never over the welcome (finishing the welcome marks the release seen, so a new person never gets
both), the tutorial, or a demo. "See all updates" lists every release in the same sheet. Also from Settings →
Display & data → "See what's new", the tray's "What's new", and `--route whatsnew`.

## Error reports

Errors go to Honeybadger (project "Time Capture Desktop", 2026-11-06), the way Kiwi's do. The rules are
pure and tested in `src/shared/errorReport.ts`: `scrubText` (secrets, emails, ids, long hex, numbers
of 3+ digits, and the home folder → `~`), frames only from a stack, causes three deep, an allow-list
of context keys (`CONTEXT_KEYS`: source, scope, version, platform, features, install, reason), the
SDK's parsed backtrace scrubbed too, ten notices a group an hour (`createGroupBudget`). A report
never carries what was on screen: no titles, documents, paths, excerpts, screen text, matter names,
descriptions, emails or tokens. `src/main/errors.ts` is the one client, in the main process:
`report(scope, err, extra?)` always logs and sends only when the key is baked in
(`__HONEYBADGER_API_KEY__`, a Vite `define` from the release workflow's `HONEYBADGER_API_KEY`
secret), the app is packaged, and Settings → Display & data → "Send crash reports" is on
(`preferences.crashReports`, absent = on). The window never talks to the network: `main.tsx`
forwards `error`, `unhandledrejection` and a render boundary through the preload's `reportError`
(`reportFromWindow` caps the strings). `store.onError` reports a failed change that is not a
`WorkspaceError`, plus the "invalid data" one; the capture, calls, screenshots, matters, drafter and
updater catch sites call `report`; `render-process-gone`/`child-process-gone` report crashes
(not `clean-exit`/`killed`); `process` uncaught and rejection handlers are ours (the SDK's would
exit), and SIGTERM/SIGINT call `app.quit()` (the SDK's own signal listener exits the process only
when no other listener exists; ours runs the before-quit cleanup instead). A notice that fails to send waits in `userData/errors.jsonl` (`QUEUE_MAX`) and is retried
every 5 minutes. `install-id` in userData is a random per-install id, never the device token.
Bundles are not minified so frames read without source maps. Sync and feed network failures are not
reported (a laptop offline is not a bug). Proving the path without a release: build with
`HONEYBADGER_API_KEY=<key>`, run with `LAWDIE_REPORT_ERRORS=1` (sends from an unpackaged build)
and `LAWDIE_TEST_ERROR=1` (one test error 3 s after launch); `HONEYBADGER_ENDPOINT=http://localhost:8787`
points at a local server (the SDK's transport drops the port, so that case goes through fetch).
A dev build, `npm test`, the screenshot harness and demo runs have no key and send nothing.

## Calendar meetings and Teams transcripts

Opt-in (`importMeetings` "Calendar meetings", `meetingTranscripts` "Teams transcripts"; 2026-11-08), Kiwi
only. Kiwi reads the person's Google and Outlook calendars with the grants it already holds from its
Integrations page (`GET /desktop-time/meetings?from&to`, `GET /desktop-time/meetings/transcript?join_url`,
`kiwi/backend/src/lib/desktopMeetings.ts`), so this app never holds a calendar token. Kiwi's Microsoft
sign-in asks for Calendars.Read and OnlineMeetings.Read; transcripts also need
OnlineMeetingTranscript.Read.All, which a firm's Microsoft admin grants once. `src/shared/meetings.ts`
is pure and tested (`meetings.test.ts`); `src/main/meetings.ts` asks every 15 minutes (and "Check now").
Only meetings ending after the switch went on count (`MeetingsState.since`). A meeting that ended is
decided once (`placed`): a call capture counted at the same time gains it (`Activity.meeting`: the
row reads as the subject and the matter request carries `meeting_with`, the other invitees); else, when
anyone else was invited, it becomes a review row (`ownerID` `calendar:google|microsoft`, `endedBy`
"calendar") for the part this computer did not count (computer time and kept time win the overlap); a
solo block does nothing. A Teams meeting with time on it is asked for its transcript every 20 minutes
for six hours after it ends; the transcript stays on the meeting and becomes `transcript` evidence (and a
source) beside the entry's `meeting` evidence, at keep or when it arrives (`attachTranscript`).
Meetings and transcripts are never synced; Kiwi's matter model sees the subject and invitees, and the
narrative drafter quotes the transcript. Zoom transcripts are not built.

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
2026-11-04, after the beta user's review: a sitting says where the time went next
(`endedTo`, the app's name: "switched to Outlook", "went to Google Chrome", never a title
inside the browser), and the site when Kiwi's browser time began as it ended
(`siteAfter()`/`endedText()`). Ten minutes without mouse or keyboard input is flagged
"idle" on the row (fixed, no setting; a call is never idle) and the Keep sheet offers
"Leave out … idle". A review row can be renamed in place (pencil; `describeActivities()`, the
activity's `description`): the person's text wins over the AI draft, is never drafted
over, and is what the Keep sheet starts from. A matter row's name renames the matter
everywhere (`renameMatterNamed()`: its project if it has one, else its activity). New time
that starts within 24 hours (`MERGE_WINDOW_MS`) of a kept desktop entry on the same
matter, or with no matter the same document in the same app (`keptMatch()`), is asked
about in two places: on its row in To review ("Add this to your kept entry …?", the row's
buttons become Keep separate / Add to entry) and under the entry in Kept ("New since").
Add to entry (`mergeIntoEntry()`): the entry is deleted, so the destinations are told, and
its sittings come back with the new ones as one row (`mergeKey`) to be kept again. Keep
separate (`separateFrom`) is never asked again. The Keep sheet keeps the captured bounds
exactly unless the times are edited (`keepBounds()`). Version 0.12.0.
2026-11-04, later: `manatt-narratives` (Meeth, 17 commits from 0.8.1) merged into main: billing
(section above). Resolved by hand: main's version, Install-on-press updater, callout, text sizes,
idle/merge/screenshot rows and Keep sheet kept, with the branch's rules check, hours and codes
added to the sheet; the branch's narrative `SourceRef` renamed `NarrativeSource` (feed.ts owns
`SourceRef`). Tests 162.
2026-11-04, later: billing for a person. Settings → Billing (the firm), matter number, bill-to
and code set on a matter, and an Invoice sheet (matter, period, rules) in place of "the day
shown"; the logo fetched from the firm's website. Tested: an invoice PDF made from a scratch
workspace through the sheet (`billing.test.ts` covers the model). The 0.12.0 Install path was
proved on this Mac the same day: a signed local 0.12.0 updated to a signed local 0.12.1 from a
local server in 3 s (ShipIt log); 0.11.0 hung because the fix shipped after its tag.
Same day: client rules made in the app (rulebook and rule sheets on the Client rules page; a
rulebook made here also checks entries at keep). Settings in four tabs.
Same day: "Why this entry" for entries kept from capture (work, sources, evidence, reasons).
Same day: bill rejection (invoices remembered; a client's note sends entries back and proposes
rules). The harness types into a textarea too.
2026-11-05: Codex's fixes (review decisions kept, billing workflow regressions; `review-regressions.test.ts`).
Version 0.13.0 (schema 3; the first build that reads a version 3 file). Tests 202.
2026-11-06: review rows take a matter. "Add a description" on a matter row without one; a Matter menu
on every row and item (known matters, No matter, New matter… in place); a name that is already a
matter's merges into it; toasts say what a move or merge did and the target unfolds; each item inside
a matter says what the work was (`describeItem`). Version 0.14.0. Tests 204.
2026-11-06, later: errors go to Honeybadger, project "Time Capture Desktop" (section above), opt-out in
Settings. Version 0.15.0. Tests 211.
2026-11-06, later: GitHub retired the `macos-14` runner label (jobs cancelled at start: "configuration
'macos-14-arm64-us-default' is not supported"), so 0.14.0 and 0.15.0 shipped for Windows and Linux only;
both workflows moved to `macos-15`. Version 0.15.1 is the first Mac build since 0.13.0.
2026-11-07: a welcome for a new person (five steps: switches live, connect or skip, the firm and its logo
for the bill) and a tutorial that walks the real screens with a sample stretch that is never saved, billing
included: client rules, imports, time sheets and invoices, the Billing tab (section above). Both verified through the harness
on an empty workspace and on one with history. Tests 216.
2026-11-08: calendar meetings (Google and Outlook) and Teams transcripts through Kiwi's own grants (section
above), verified end to end against a stand-in Kiwi: a Teams call named by its meeting, a conference-room
meeting as a row less the Word time, the transcript under Why this entry. Tests 224.
2026-11-09: a What's new card, after Kiwi's (section above): once per release after an update, every release
under "See all updates", notes written for a lawyer and kept in `src/shared/releases.ts`. Version 0.16.0
(calendar meetings and Teams transcripts ship here too). Tests 229.
