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
       main screenshot and an item's `picture` goes under that item: files in `docs/newsletter/` taken from the
       demo workspace (never a real one), about 1100 px wide (an item's 930), named for the release.
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
    /** The newsletter's picture under this item: a file in `docs/newsletter/` and what it shows. Never on the card. */
    picture?: { file: string; alt: string };
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
    /** The newsletter's main screenshot: a file in `docs/newsletter/` and what it shows. */
    picture?: { file: string; alt: string };
    items: readonly ReleaseItem[];
};

export const RELEASES: readonly Release[] = [
    {
        id: "0.18.8",
        date: "2026-11-21",
        title: "One entry per matter, per day",
        intro: "After feedback from a user: time on a matter that already has an entry kept that day now joins that entry when you approve it, whichever came first, and the app always tells you when time is merged.",
        items: [
            { icon: "matter", title: "Same matter, same day, one entry", description: "Approving time on a matter already kept that day merges it into that entry.", more: "Rename a row to a matter you already kept time on that day, or approve more time on it, and Approve now adds it to that entry: the hours are added together and the descriptions joined, while the entry's billable choice and rate stand. Before, the result depended on which time came first: sometimes you were asked, sometimes a second entry was kept without a word. The row says beforehand which entry it will join, and a note says so once it has. Time on another day, an entry already on an invoice, or time you chose to keep separate stays its own entry.", route: "activity" },
            { icon: "matter", title: "Kept time grouped by matter", description: "Activity → Kept now lists each day's entries under their matter, with the hours.", more: "The Kept list used to be one long column, so several entries on the same matter sat apart. It now groups them the way the Time page does: each day with its hours and billable hours, then each matter with its total and its Copy button, and time with no matter last.", route: "activity" },
            { icon: "sparkle", title: "A note when time is merged", description: "Add to entry and folding into the day's email entry now say what they did.", more: "Add to entry takes a kept entry back to To review with the new time, so it can be approved as one. It used to do that silently, and the entry just vanished from Kept. A note now says which entry was merged and where it went. Folding time into the day's email entry, under a client's rules, says so too.", route: "activity" },
        ],
    },
    {
        id: "0.18.6",
        date: "2026-11-18",
        title: "Pick the apps that stay private",
        intro: "Keeping an app private used to mean typing its technical identifier. Now you pick it from a list.",
        items: [
            { icon: "shield", title: "Choose private apps from a list", description: "Settings → Capture → Add apps… lists the apps on this computer to tick.", more: "Apps that stay private are never recorded: not their name, their window titles or their time. Add apps… in Settings → Capture lists every app on this computer with its icon, the ones you use most at the top, and a search box. Tick the ones to keep private, or choose an app's file if it is not listed. The list shows each private app by its name and icon, with Remove beside it.", route: "settings" },
        ],
    },
    {
        id: "0.18.5",
        date: "2026-11-18",
        title: "Edit, then approve when ready",
        intro: "Two changes to the sheet that opens from Edit…, after feedback from a user: type the hours you bill, and save your changes without approving the time.",
        items: [
            { icon: "matter", title: "Save without approving", description: "Edit… now saves your changes to the row; Approve is a separate button.", more: "The sheet that opens from Edit… used to have one button, Keep time, so editing a row also approved it. It now has Save, which puts the matter, description, hours and (for one sitting) the times back on the row and leaves it in To review, and Approve, which keeps it. Billable, leaving out idle, codes and a rate belong to the kept entry, so they apply when you approve; Save says so if you changed one.", route: "activity" },
            { icon: "sparkle", title: "Tidier rows", description: "Edit, Dismiss, Copy and Delete are icons now; hover one to see what it does.", more: "Each row had grown a line of worded buttons. Edit and Dismiss on rows to review, and Copy, Edit and Delete on kept entries, are now small icons (a pencil, a cross, two pages and a bin), each naming itself when you point at it. Matter, Personal and Approve keep their words.", route: "activity" },
            { icon: "clock", title: "Hours on every Keep sheet", description: "Type the hours to bill when you keep time; no time math.", more: "The Keep sheet now always has an Hours box beside Start and End. It opens with the captured time rounded up to your billing increment; type the hours you want to bill and those are what is kept, while the captured times stay as they were. Empty the box to go back to the rounded figure. Before this the box showed only for clients with billing rules.", route: "activity" },
        ],
    },
    {
        id: "0.18.4",
        date: "2026-11-17",
        title: "Quicker matters and a Copy button",
        intro: "Two small changes to how time waiting for review gets its matter, after feedback from a user.",
        items: [
            { icon: "matter", title: "Type a matter where it says No matter", description: "The pencil beside “No matter” on a row names its matter in place.", more: "A row waiting for review without a matter now has a pencil beside “No matter”. Click it, type the matter's name and press Enter. A name you already use puts the time on that matter; a new name makes the matter when you keep the time. The Matter menu still works as before.", route: "activity" },
            { icon: "sparkle", title: "New matter… first", description: "The Matter menu now starts with New matter…, above your matters.", more: "On a long list of matters, New matter… used to sit at the very bottom of the Matter menu. It is now the first item, with your matters below it and No matter last.", route: "activity" },
            { icon: "invoice", title: "Copy an entry in one click", description: "Copy beside a kept entry puts its narrative on the clipboard for your time system.", more: "Every kept entry on the Time page and in Activity's Kept list has a Copy button: one click and the narrative as that screen shows it (on the Time page with a client's rules applied, as the rules write it, one line per part of a split entry) is ready to paste into Tabs3 or any other time system. A matter's heading has Copy for its number and its name, and you can also select part of either and copy it.", route: "today" },
            { icon: "rules", title: "Room to edit a description", description: "The pencil on a row opens the whole description, not one line.", more: "Editing a row's description used to squeeze it into a single line you had to scroll through. The pencil now opens a box that grows to show all of it. Enter saves and Escape cancels, as before.", route: "activity" },
            { icon: "clock", title: "Dismiss is always there", description: "A row that could join a kept entry still offers Personal and Dismiss.", more: "When new time could be added to an entry you already kept, the row asks Keep separate or Add to entry. It now keeps Personal and Dismiss beside them, so time that is neither can go straight away.", route: "activity" },
        ],
    },
    {
        id: "0.18.2",
        date: "2026-11-16",
        title: "A quicker Activity screen",
        intro: "This update makes Activity quick again when a lot of time is waiting for review.",
        items: [
            { icon: "clock", title: "Long lists, 50 rows at a time", description: "Activity shows 50 rows, with Show more below; clicks answer at once.", more: "With a great deal of time waiting, Activity used to draw every row and slow the whole window down. To review, Kept, Dismissed and All now show 50 rows at a time, with Show 50 more and Show all at the end of the list. Search still finds a row further down and opens the list to it. Select and Approve selected act on the rows shown.", route: "activity" },
        ],
    },
    {
        id: "0.18.0",
        date: "2026-11-12",
        title: "Approve your day in a click",
        intro: "This update is about getting through a day's time faster: rows you can approve as they stand, time that waits until you have looked at it, and hours shown the way you bill them.",
        picture: { file: "0.18.0-activity.jpg", alt: "The Activity screen: a row to review with its description, matter, 3.8 hours and an Approve button" },
        items: [
            { icon: "clock", title: "Approve, or approve them all", description: "Approve keeps a row as shown; tick rows and approve them together.", more: "Each row in To review now reads as the entry it would become: the description, the matter and the hours billed. Approve keeps it exactly as shown, and you can tick several rows and approve them together. A row with no matter or no description says what is missing, and one that breaks a client's rule or overlaps time you already kept opens the Keep sheet instead.", picture: { file: "0.18.0-approve.jpg", alt: "A review row with its description, the matter under it, 3.8 hours and the Approve button" }, route: "activity" },
            { icon: "shield", title: "Unreviewed time waits for you", description: "Time you have not reviewed stays 90 days, with a warning a week before.", more: "Time you have not reviewed is no longer removed by the Reviewed activity setting. It stays for 90 days, or longer if that setting is longer, and a week before the oldest of it would go the app warns you on Activity, in the sidebar and in the tray. The setting now only says how long kept and dismissed activity stays.", route: "activity" },
            { icon: "invoice", title: "Tenths or quarter hours", description: "Choose your billing mode in Settings; time shows in hours, never minutes and seconds.", more: "Settings → Billing → Billing mode sets tenths of an hour or quarter hours. Time is rounded up to the increment, and a client's own increment rule still wins for that client. The hours are fixed when you keep an entry, so changing the mode later never changes one you already kept.", route: "settings" },
            { icon: "clock", title: "Fix or add time yourself", description: "Press any hours or times to change them; Add time for work capture missed.", more: "Press a row's hours, or a sitting's start and end times, to change them. Add time on Activity, or Add sitting on a matter's row, records work the computer did not see, such as a meeting away from your desk. What you add is marked as yours and still goes through review. A kept entry's Edit sheet has Start and End too.", route: "activity" },
            { icon: "compass", title: "Search everything", description: "Press ⌘K (Ctrl+K) to find a matter, an entry, time to review, a rule or an invoice.", more: "One search bar covers matters, time to review, kept entries, client rules and invoices, and picking a result opens its screen with the item shown. The search runs on your computer; nothing you type is sent anywhere.", picture: { file: "0.18.0-search.jpg", alt: "The search bar with a matter and a row to review found for one word" } },
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
