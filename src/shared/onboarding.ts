/* The welcome a new person sees once, and the tutorial that walks the real screens (2026-11-07).
   Pure: what decides whether the welcome shows, the tutorial's steps, and the one sample stretch
   the tutorial puts in the Activity inbox so there is something to keep. The sample lives in the
   window only: its ids never enter the workspace (`keepStretch` refuses ids it does not know), so
   the rule that no sample is seeded in a real workspace holds. */

import { PERSONAL, type Activity, type Stretch, type Workspace } from "./model";

/** The route a tutorial step opens and where its card points (a `data-tour` value in the window). */
export type TourStep = {
    id: string;
    route: "today" | "activity" | "matters" | "settings";
    /** The `data-tour` of the control the card points at; null for a card alone, centred. */
    target: string | null;
    title: string;
    body: string;
    /** The step moves on by itself: when the Keep sheet opens, or when it closes. */
    advanceOn?: "keep-open" | "keep-closed";
};

/**
 * The welcome shows once, on a workspace nobody has used: no kept time, no captured activity, not
 * connected, not a demo, and not yet welcomed or skipped (`preferences.onboardedAt`). Someone who was
 * using the app before the welcome existed is never interrupted by it.
 */
export function needsWelcome(w: Workspace): boolean {
    return !w.preferences.onboardedAt && !w.demo && w.entries.length === 0 && w.activities.length === 0 && w.sync === null && (w.imported ?? []).length === 0;
}

export const TUTORIAL_PREFIX = "tutorial-";
export const TUTORIAL_MATTER = "Sample matter (tutorial)";

/**
 * A stretch of work for the tutorial's inbox: two sittings in Word on one document, half an hour
 * apart, the way real work goes. Dated from `now`, so it reads as this morning. Window only.
 */
export function tutorialStretch(now: number): { stretch: Stretch; sittings: Activity[] } {
    const minute = 60_000;
    const at = (minutesAgo: number): string => new Date(now - minutesAgo * minute).toISOString();
    const document = { name: "Lease amendment (sample).docx", path: null, excerpt: "AMENDMENT TO LEASE — This Amendment is entered into between the Landlord and the Tenant …" };
    const base = { app: "Microsoft Word", ownerID: "com.microsoft.Word", title: "Lease amendment (sample).docx", document, disposition: "pending" as const, matter: TUTORIAL_MATTER, matterBy: "ai" as const };
    const sittings: Activity[] = [
        { ...base, id: `${TUTORIAL_PREFIX}1`, startedAt: at(95), endedAt: at(70), endedBy: "switched", endedTo: "Outlook" },
        { ...base, id: `${TUTORIAL_PREFIX}2`, startedAt: at(58), endedAt: at(40), endedBy: "switched", endedTo: "Finder", idle: [{ startedAt: at(46), endedAt: at(40) }] },
    ];
    const draft = { text: "Review and revise lease amendment; confer regarding landlord's proposed rent escalation.", source: "sample" as const };
    sittings[0].draft = draft;
    const seconds = sittings.reduce((n, a) => n + (Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000, 0);
    return {
        sittings,
        stretch: { id: sittings[0].id, app: base.app, ownerID: base.ownerID, name: document.name, document, activityIDs: sittings.map((a) => a.id), startedAt: sittings[0].startedAt, endedAt: sittings[1].endedAt, seconds, sittings: sittings.length, endedBy: "switched", endedTo: "Finder", draft },
    };
}

/** Whether an id is the tutorial's: such a row is the window's, never the workspace's. */
export const isTutorialID = (id: string): boolean => id.startsWith(TUTORIAL_PREFIX);

/** The tutorial, in order. Each step opens its route and points at one control; the sample row carries the Keep steps. */
export const TOUR_STEPS: readonly TourStep[] = [
    { id: "screens", route: "activity", target: "nav", title: "Four screens", body: "Time is what you have kept, by day. Activity is where captured work waits for review. Matters is each matter's time, rate and value. Settings is what is captured and where it goes." },
    { id: "capture", route: "activity", target: "capture", title: "Capture is yours to switch on", body: "Nothing is recorded until you enable capture here, from the tray, or in Settings. When it is on, the app in front counts for as long as it is in front; browsers are left to the Lawdie browser extension, and excluded apps are never read." },
    { id: "status", route: "activity", target: "capture-status", title: "What is captured", body: "App names and durations, and nothing else until you switch it on: window titles, Office document details, on-screen text or screenshots, each explained in Settings. No keystrokes, ever." },
    { id: "row", route: "activity", target: "review-row", title: "A stretch of work, to review", body: "This sample row is what capture turns into: the sittings on one document within fifteen minutes of each other, grouped as one stretch with its time. The matter and the description are suggested when AI suggestions are on; the pencil renames either. Idle minutes are flagged, never hidden." },
    { id: "actions", route: "activity", target: "review-actions", title: "Keep, dismiss, or set apart", body: `Keep time saves the stretch as a time entry. Dismiss drops it. ${PERSONAL} keeps it out of billing and sync for good. Matter moves it to another matter, or a new one. Press Keep time on the sample to see the sheet.`, advanceOn: "keep-open" },
    { id: "sheet", route: "activity", target: "keep-sheet", title: "The Keep sheet", body: "Name the matter, write or accept the description, trim the times or leave the idle minutes out, and mark it billable. Only the sittings count as time, and kept time never overlaps. The sample saves nothing: press Keep time or Cancel to go on.", advanceOn: "keep-closed" },
    { id: "time", route: "today", target: "entries", title: "Your day, kept", body: "Kept entries land here by day and by matter, with tracked and billable totals above. Edit or delete an entry, export the range as CSV, or add a typed entry for work the computer did not see." },
    { id: "matters", route: "matters", target: "matters", title: "Matters", body: "A matter is made the first time you keep time on it. Open one to set its client, rate, matter number and bill-to; the rate applies from then on, and entries already kept keep theirs." },
    { id: "settings", route: "settings", target: "settings-tabs", title: "Settings", body: "Capture: titles, Office details, screenshots, AI suggestions and the apps that stay private. Billing: the firm's details for invoices. Sync: connect this computer to Kiwi or Lawdie CRM with a token; until you do, nothing leaves it. Display & data: text size and where the file lives." },
    { id: "done", route: "settings", target: null, title: "That is the whole loop", body: "Enable capture, work as usual, review the Activity inbox when you like, keep what matters. You can run this tutorial again from Settings → Display & data." },
];

/** The next step to show from `index` once `event` happened, or null when the current step is not waiting on it. */
export function stepAfter(steps: readonly TourStep[], index: number, event: "keep-open" | "keep-closed"): number | null {
    const step = steps[index];
    if (!step || step.advanceOn !== event) return null;
    return index + 1 < steps.length ? index + 1 : null;
}
