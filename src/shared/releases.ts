/* What's new, newest first (2026-11-09, after Kiwi's card). The window opens the first entry once, after an
   update, for a person who has not seen it (`needsWhatsNew`, remembered as `preferences.seenRelease` on this
   computer); "See all updates" lists the rest. Pure.

   When a release has something a person would notice (a new control, a new screen, a changed behaviour), add an
   entry at the TOP in the same change:
     - `id` is the version it ships in ("0.16.0"); ids are unique and newest first (a test checks).
     - `date` is the day it ships, YYYY-MM-DD.
     - Two to five items, each a short title and one plain sentence a lawyer would understand: what they can now
       do, not what moved in the code. `icon` is one of RELEASE_ICONS; `route` opens that screen.
     - `intro` (two or three sentences) and each item's `more` (a short paragraph: how it works, where it is,
       what it never does) are for the email newsletter (`newsletter.ts`); the card never shows them. Write them
       for the newest release; an item without `more` goes out with its one line. `picture` is the newsletter's
       one screenshot, a file in `docs/newsletter/` taken from the demo workspace (never a real one): about
       1100 px wide, named for the release.
   A release that only fixes bugs adds no entry, and the card stays closed. */

import { needsWelcome } from "./onboarding";
import type { Workspace } from "./model";

export const RELEASE_ICONS = ["calendar", "transcript", "compass", "invoice", "sparkle", "matter", "shield", "rules", "clock"] as const;
export type ReleaseIcon = (typeof RELEASE_ICONS)[number];

export type ReleaseItem = {
    icon: ReleaseIcon;
    title: string;
    /** One line, about twelve words: the card shows only this. */
    description: string;
    /** The newsletter's paragraph for this item, a few plain sentences. Never on the card. */
    more?: string;
    /** A screen to open, which also closes the card. */
    route?: "today" | "activity" | "matters" | "settings";
};

export type Release = {
    /** The version it ships in; doubles as the stored "seen" id. */
    id: string;
    /** YYYY-MM-DD. */
    date: string;
    title: string;
    /** The newsletter's opening, two or three sentences on what the release is about. Never on the card. */
    intro?: string;
    /** The newsletter's screenshot: a file in `docs/newsletter/`, what it shows, and a short label over it. */
    picture?: { file: string; alt: string; label?: string };
    items: readonly ReleaseItem[];
};

export const RELEASES: readonly Release[] = [
    {
        id: "0.18.0",
        date: "2026-11-12",
        title: "Approve your day in a click",
        intro: "This update is about getting through a day's time faster: rows you can approve as they stand, time that waits until you have looked at it, and hours shown the way you bill them.",
        picture: { file: "0.18.0-activity.jpg", alt: "The Activity screen: a row to review with its description, matter, 3.8 hours and an Approve button", label: "Activity · To review" },
        items: [
            { icon: "clock", title: "Approve, or approve them all", description: "Approve keeps a row as shown; tick rows and approve them together.", more: "Each row in To review now reads as the entry it would become: the description, the matter and the hours billed. Approve keeps it exactly as shown, and you can tick several rows and approve them together. A row with no matter or no description says what is missing, and one that breaks a client's rule or overlaps time you already kept opens the Keep sheet instead.", route: "activity" },
            { icon: "shield", title: "Unreviewed time waits for you", description: "Time you have not reviewed stays 90 days, with a warning a week before.", more: "Time you have not reviewed is no longer removed by the Reviewed activity setting. It stays for 90 days, or longer if that setting is longer, and a week before the oldest of it would go the app warns you on Activity, in the sidebar and in the tray. The setting now only says how long kept and dismissed activity stays.", route: "activity" },
            { icon: "invoice", title: "Tenths or quarter hours", description: "Choose your billing mode in Settings; time shows in hours, never minutes and seconds.", more: "Settings → Billing → Billing mode sets tenths of an hour or quarter hours. Time is rounded up to the increment, and a client's own increment rule still wins for that client. The hours are fixed when you keep an entry, so changing the mode later never changes one you already kept.", route: "settings" },
            { icon: "clock", title: "Fix or add time yourself", description: "Press any hours or times to change them; Add time for work capture missed.", more: "Press a row's hours, or a sitting's start and end times, to change them. Add time on Activity, or Add sitting on a matter's row, records work the computer did not see, such as a meeting away from your desk. What you add is marked as yours and still goes through review. A kept entry's Edit sheet has Start and End too.", route: "activity" },
            { icon: "compass", title: "Search everything", description: "Press ⌘K (Ctrl+K) to find a matter, an entry, time to review, a rule or an invoice.", more: "One search bar covers matters, time to review, kept entries, client rules and invoices, and picking a result opens its screen with the item shown. The search runs on your computer; nothing you type is sent anywhere." },
        ],
    },
    {
        id: "0.17.0",
        date: "2026-11-12",
        title: "Each sitting says what it was",
        intro: "Rows in To review are easier to read: each sitting now carries a line saying what the work was.",
        items: [
            { icon: "sparkle", title: "A line for every sitting", description: "Open a row to see what each stretch of work was, written by Kiwi's AI.", more: "With AI suggestions on and Kiwi connected, every sitting of a minute or more gets a one-line summary, shown when you open a row. Sittings from before the update are summarised too.", route: "activity" },
            { icon: "compass", title: "Screenshots help, if they are on", description: "With screenshots on, the AI reads one of each sitting to describe it better.", more: "If screenshots are switched on, Kiwi's AI reads one screenshot of each sitting to write that line. Never of a browser, an excluded app or a call. Nothing changes if screenshots are off.", route: "settings" },
            { icon: "matter", title: "Better matters and drafts", description: "Those lines help name the matter and draft the description you keep.", more: "The same lines are used when the app names the matter and drafts the billing description, so a sitting with no readable title can still be named." },
        ],
    },
    {
        id: "0.16.0",
        date: "2026-11-09",
        title: "Your meetings, counted",
        items: [
            { icon: "calendar", title: "Calendar meetings become time", description: "Connected to Kiwi, Google and Outlook meetings name a call or wait for review.", route: "settings" },
            { icon: "transcript", title: "Teams transcripts as evidence", description: "A Teams meeting's transcript sits under Why this entry and shapes the description." },
            { icon: "compass", title: "A welcome and a tutorial", description: "Settings → Display & data walks each screen with a sample that is never saved.", route: "settings" },
            { icon: "invoice", title: "Your firm on the bill", description: "Set up the firm and its logo once; every invoice and time sheet prints them.", route: "settings" },
            { icon: "sparkle", title: "What's new, right here", description: "Each update opens this card once. Past updates are a click away." },
        ],
    },
    {
        id: "0.15.0",
        date: "2026-11-06",
        title: "Errors reach us, your work does not",
        items: [
            { icon: "shield", title: "Crash reports", description: "When something fails, Lawdie hears about it, never what was on your screen.", route: "settings" },
        ],
    },
    {
        id: "0.14.0",
        date: "2026-11-06",
        title: "Move time between matters",
        items: [
            { icon: "matter", title: "A Matter menu on every row", description: "Move a row, or one document in it, to any matter or a new one.", route: "activity" },
            { icon: "matter", title: "Same name, same matter", description: "Naming a matter after one you have merges the two instead of clashing." },
            { icon: "transcript", title: "Each item says what it was", description: "The document's folder, an email, a call or a page's site, under its matter." },
        ],
    },
    {
        id: "0.13.0",
        date: "2026-11-05",
        title: "Billing, from your own time",
        items: [
            { icon: "invoice", title: "Invoices and time sheets", description: "Bill one matter over a period, as a PDF or Word time sheet.", route: "today" },
            { icon: "rules", title: "Client rules", description: "Write a client's billing guidelines as rules; entries are checked against them.", route: "today" },
            { icon: "transcript", title: "Why this entry", description: "Every kept entry shows the documents, emails and windows its time came from." },
            { icon: "rules", title: "Rejected bills", description: "Record a client's rejection; the entries come back and its rules are proposed." },
        ],
    },
    {
        id: "0.12.0",
        date: "2026-11-04",
        title: "Where the time went",
        items: [
            { icon: "clock", title: "Where you went next", description: "Each sitting says what you switched to, so a gap explains itself.", route: "activity" },
            { icon: "clock", title: "Idle time flagged", description: "Ten minutes without input is marked, and you choose whether to keep it." },
            { icon: "matter", title: "Rename in place", description: "Rename a row or a matter right where it is listed." },
            { icon: "sparkle", title: "Add to a kept entry", description: "New time on a matter you kept today can join that entry." },
        ],
    },
];

export const LATEST_RELEASE: Release = RELEASES[0];

/** Newer first: compares "0.16.0" and "0.15.1" part by part. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * The card opens by itself once per release: not over the welcome (a new person gets that instead, and finishing
 * it marks the release seen), not on a demo, and not again once dismissed.
 */
export function needsWhatsNew(w: Workspace, latest: Release = LATEST_RELEASE): boolean {
    return !w.demo && w.preferences.seenRelease !== latest.id && !needsWelcome(w);
}

/** "9 November 2026" for a release's date. */
export function releaseDateLabel(date: string): string {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
