/* What's new, newest first (2026-11-09, after Kiwi's card). The window opens the first entry once, after an
   update, for a person who has not seen it (`needsWhatsNew`, remembered as `preferences.seenRelease` on this
   computer); "See all updates" lists the rest. Pure.

   When a release has something a person would notice (a new control, a new screen, a changed behaviour), add an
   entry at the TOP in the same change:
     - `id` is the version it ships in ("0.16.0"); ids are unique and newest first (a test checks).
     - `date` is the day it ships, YYYY-MM-DD.
     - Two to five items, each a short title and one plain sentence a lawyer would understand: what they can now
       do, not what moved in the code. `icon` is one of RELEASE_ICONS; `route` opens that screen.
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
    /** A screen to open, which also closes the card. */
    route?: "today" | "activity" | "matters" | "settings";
};

export type Release = {
    /** The version it ships in; doubles as the stored "seen" id. */
    id: string;
    /** YYYY-MM-DD. */
    date: string;
    title: string;
    items: readonly ReleaseItem[];
};

export const RELEASES: readonly Release[] = [
    {
        id: "0.17.0",
        date: "2026-11-12",
        title: "Each sitting says what it was",
        items: [
            { icon: "sparkle", title: "A line for every sitting", description: "Open a row to see what each stretch of work was, written by Kiwi's AI.", route: "activity" },
            { icon: "compass", title: "Screenshots help, if they are on", description: "With screenshots on, the AI reads one of each sitting to describe it better.", route: "settings" },
            { icon: "matter", title: "Better matters and drafts", description: "Those lines help name the matter and draft the description you keep." },
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
