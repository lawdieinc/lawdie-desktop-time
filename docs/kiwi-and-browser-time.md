# Plan: Kiwi and browser time in the desktop app, matched to matters

Status: built (reviewed and built in Codex 2026-10-26–28; finished, tested and shipped
2026-10-29, version 0.10.0). What shipped differs from the plan below in these ways:

- Phase 3 shipped first, as the plan's review asked: fetching and claiming are separate
  calls (`GET /desktop-time/feed`, `POST /desktop-time/feed/claim`), a claim is a row in
  Kiwi's `desktop_import_claims` owned by one workspace (`feed.workspaceID`) until reviewed,
  Kiwi's rollup and web Keep refuse claimed rows (triggers), a draft already rolled up from
  a claimed row is trimmed, and the app reports each source's fate back
  (`POST /desktop-time/feed/review`) from receipts that outlive the raw rows.
- The feed is paged by a cursor and replayed over the retention window each pass, so a
  browser segment uploaded late is never behind a `since`.
- `Activity` carries `origin`, `originRef`, `originAccount`, `sourceKind`, `url`,
  `kiwiProjectID`, `projectID` and clipped `sittings`; entries carry `sourceRefs` with the
  kept intervals, and Kiwi's sync reserves them for the entry before filing it.
- Joins are their own call (`POST /desktop-time/joins`) in the AI round, with the person's
  past decisions as examples; `inboxOf()` groups by Kiwi id, then local project id, then
  name. A workspace belongs to one Kiwi account.
- Kiwi runs `useBrowserSegmentSync` on every page, so the Chrome extension's segments
  reach Kiwi without the Time page open (the "known limit" below).
- Checked: Kiwi's `email` time is reading mail inside Kiwi, not an add-in in desktop
  Outlook, so nothing needs dropping on import.

The plan as written on 2026-10-26 follows.

## Why

Three things capture a lawyer's day, and none of them sees the others:

| Source | Where it lives today | What it covers |
|---|---|---|
| This app | `workspace.json`, synced to Kiwi/CRM | Word, Outlook, Teams, every desktop app but browsers |
| The Chrome extension (`lawdie-time-capture`) | the browser (7 days), pushed to Kiwi's `browser_activities` while Kiwi's Time page is open | websites other than Lawdie's own |
| Kiwi's in-app tracker | Kiwi's `activity_time` (`chat` / `email` / `tab`) | time spent in Kiwi itself |

They do not overlap by design: the app skips browsers (`BROWSER_OWNER_IDS`), the
extension skips Lawdie's own origins. The exception is a call, which the app counts
while Kiwi or Chrome is in front.

The goal: one inbox, here, where all three are reviewed and kept per matter per day.

## Phase 1: a Kiwi feed into the inbox

**Kiwi** (`backend/src/routes/desktopTime.ts`): `GET /desktop-time/feed?since=`,
behind `requireDesktopDevice`, answering

- `browser`: `browser_activities` not yet kept, with `matched_project_id`;
- `kiwi`: `activity_time` rows of kind `chat` and `email`, with the chat title or the
  email's subject and sender (the context `/billing/rollup` already builds) and the
  chat's `project_id`. `tab` presence is left out at first: a route path says little;
- `matters`: `id`, `name`, `cm_number` of every matter the user can reach.

**This app:**

- `Activity` gains `origin?: "browser" | "kiwi"` (absent: this computer), `originRef`
  (the segment or row id), `url?` and `kiwiProjectID?`. Validation and migration follow.
- `importFeed(w, feed, now)` in `src/shared/`, pure and tested: idempotent on
  `originRef`, imported rows arrive closed and pending, follow retention, and anything
  already kept or dismissed is left alone.
- `clipImported()`, pure and tested: this computer's time wins an overlap, so a call
  recorded here trims a Chrome or Kiwi row rather than doubling it.
- `src/main/feed.ts`, beside `sync.ts`, every few minutes. Opt-in in Settings ("Bring in
  browser and Kiwi time"), only while connected to Kiwi.
- `inboxOf()` already groups a matter's day across apps; Chrome and Kiwi become more apps
  in the same row.

Known limit: Chrome segments reach Kiwi only while its Time page is open. Either run
`useBrowserSegmentSync` on every Kiwi page, or see Phase 4.

To check: whether `kiwi-outlook` runs its tracker inside desktop Outlook. If so, those
minutes are also this app's Outlook time and must be dropped on import (marked as an
add-in by Kiwi, or clipped against this computer's Outlook/Word time).

## Phase 2: matching to real matters

`Project` gains `kiwiProjectID?`, `matterNumber?` and `aliases?: string[]`. Kiwi's matter
list is cached apart from `projects`, so the Matters screen does not fill with every
matter in the firm.

### Placing imported time

In order, first match wins:

1. the same `kiwiProjectID` (Kiwi's chat time carries it): exact, whatever either side
   calls the matter;
2. the same matter number;
3. the same name, ignoring case (today's `projectNamed()`);
4. a name in a project's `aliases`, remembered from an earlier merge or join;
5. none: the time waits in review under Kiwi's name, marked as a new matter, with
   "Same as…" to point it at an existing one. A duplicate is never made silently.

### When the same matter has two names

Example: the model named a lawyer's desktop work "Acme Logistics"; Kiwi time arrives on
its matter "Acme Matter". They are one matter and must join.

**The naming rule:**

- **Kiwi's name wins over a model's guess.** "Acme Logistics" was inferred from window
  titles; "Acme Matter" is a real matter with an id, and the one the time is billed to.
- **A person's name wins over Kiwi's.** A name a person typed or chose
  (`matterBy: "person"`) is never replaced, the rule the app already keeps.
- **Join automatically at high confidence; ask at every other confidence.** This applies
  whether the local name came from the model or a person. Linking a matter and changing
  its display name are separate: an automatic join still preserves a person's name.

**How a join happens:**

1. The naming round (`POST /desktop-time/matters`) also sends the local matters and
   Kiwi's, and asks which are the same; the person's past merges and joins are the
   examples. `matterMatch.ts` cannot be relied on here: it matches a party word only of
   five letters or more, and "Acme" has four.
2. High confidence, and the local name was the model's: the project is renamed to Kiwi's name,
   linked to its id, the old name kept in `aliases`, and its time moves with it. The
   Matters screen says so once ("Acme Logistics → Acme Matter, from Kiwi") with Undo.
3. High confidence, and the local name was a person's: link to Kiwi's id automatically
   and keep the person's name. The Matters screen says so once ("Linked to Kiwi's
   Acme Matter; your name was kept") with Undo.
4. At every other confidence, including missing or unknown confidence: ask in both cases
   ("Same as Kiwi's *Acme Matter*? Join"). Nothing joins until the person confirms;
   they can decline or choose a different matter. A confirmed join follows the same
   naming rules above.

**Prevention:** with Kiwi's matters in the request, the prompt
(`kiwi/backend/src/lib/desktopMatters.ts`) chooses an existing matter before inventing a
name, so the desktop work would have been "Acme Matter" from the start.

### On the wire

`syncRequest()` sends `kiwi_project_id` beside `project_name` on each kept entry; Kiwi's
`cleanSyncBody()` files the entry under it instead of re-matching from the title. The CRM
keeps using `project_name` (its ids are its own). All three contracts change together.

## Phase 3: never billed twice

- Kept entries carry `source_refs: [{ kind, id }]`. Kiwi sets `browser_activities.kept_at`
  (the column exists) and a new `activity_time.claimed_at` (migration).
- The feed claims what it hands out; `/billing/rollup` skips claimed rows. Without this,
  Kiwi drafts a matched segment while the app is still reviewing it.

Must ship before anyone bills real time through the import.

## Phase 4, only if needed: straight from the extension

A Chrome native-messaging host would bring segments in without Kiwi's Time page open. The
cost: the `nativeMessaging` permission (another Web Store review), a host manifest per
browser per OS, and a new `lawdie-time-capture` tag.

## Rules this touches

- "One-way, this computer → each target" (AGENTS.md) stops being true; rewrite it.
- "Browsers are not captured" still holds: the app imports the extension's segments and
  never captures a browser itself.
- Imported time is evidence until a person keeps it, like everything else.
