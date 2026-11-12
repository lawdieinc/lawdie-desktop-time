import { describe, expect, it } from "vitest";
import {
    PENDING_MAX_DAYS, PENDING_WARN_DAYS, PERSONAL, deleteEntry, dismissActivities, emptyWorkspace, keepStretch, mergeIntoEntry, pendingDays, pendingExpiring, prune,
    referencedScreenshots, validate, type Activity, type Workspace,
} from "./model";
import { accountOf, ensureFeed, importFeed, refreshReceipts, type FeedPage, type FeedRow } from "./feed";
import { applyMeetings, ensureMeetings, type Meeting } from "./meetings";

// Unreviewed time waits until it is reviewed (2026-11-12): retentionDays is for reviewed activity only.

const EPOCH = 1_780_000_000_000; // 2026-05-28T20:26:40Z
const DAY = 86_400;
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const activity = (over: Partial<Activity> = {}): Activity => ({ id: "a-" + Math.random(), app: "Word", ownerID: "com.microsoft.Word", title: null, startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending", ...over });
const ids = (w: Workspace) => w.activities.map((a) => a.id);

describe("retention", () => {
    it("pending activity outlives retentionDays", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 14;
        w.activities = [activity({ id: "waiting" })];
        prune(w, at(20 * DAY));
        expect(ids(w)).toEqual(["waiting"]);
    });

    it("kept and dismissed activity go retentionDays after review", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 14;
        w.activities = [
            activity({ id: "kept-yesterday", disposition: "kept", reviewedAt: iso(79 * DAY) }),
            activity({ id: "dismissed-yesterday", disposition: "dismissed", reviewedAt: iso(79 * DAY) }),
            activity({ id: "kept-long-ago", disposition: "kept", reviewedAt: iso(65 * DAY - 1) }),
            activity({ id: "dismissed-long-ago", disposition: "dismissed", reviewedAt: iso(65 * DAY - 1) }),
        ];
        prune(w, at(80 * DAY));
        expect(ids(w)).toEqual(["kept-yesterday", "dismissed-yesterday"]);
    });

    it("reviewed activity without reviewedAt falls back to its end", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 14;
        w.activities = [
            activity({ id: "old", disposition: "dismissed" }),
            activity({ id: "recent", disposition: "kept", startedAt: iso(10 * DAY), endedAt: iso(10 * DAY + 600) }),
        ];
        prune(w, at(15 * DAY));
        expect(ids(w)).toEqual(["recent"]);
    });

    it("pending older than 90 days goes; a retention of 365 days waits longer", () => {
        const w = emptyWorkspace();
        expect(pendingDays(w.preferences)).toBe(PENDING_MAX_DAYS);
        w.activities = [activity({ id: "waiting" })];
        prune(w, at(600 + 90 * DAY));
        expect(ids(w)).toEqual(["waiting"]);
        prune(w, at(601 + 90 * DAY));
        expect(ids(w)).toEqual([]);

        w.preferences.retentionDays = 365;
        expect(pendingDays(w.preferences)).toBe(365);
        w.activities = [activity({ id: "waiting" })];
        prune(w, at(200 * DAY));
        expect(ids(w)).toEqual(["waiting"]);
        prune(w, at(366 * DAY));
        expect(ids(w)).toEqual([]);
    });

    it("Personal pending follows the same cap", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 7;
        w.activities = [activity({ id: "pool", matter: PERSONAL, matterBy: "person" })];
        prune(w, at(60 * DAY));
        expect(ids(w)).toEqual(["pool"]);
        prune(w, at(91 * DAY));
        expect(ids(w)).toEqual([]);
    });

    it("screenshots of pending activity stay referenced until it goes", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 7;
        w.activities = [activity({ id: "shot", screenshots: ["shot-1780000000000.jpg"] })];
        prune(w, at(30 * DAY));
        expect([...referencedScreenshots(w)]).toEqual(["shot-1780000000000.jpg"]);
        prune(w, at(91 * DAY));
        expect(referencedScreenshots(w).size).toBe(0);
    });

    it("warns a week before pending time goes, never for Personal or dismissed time", () => {
        const w = emptyWorkspace();
        w.activities = [
            activity({ id: "first", startedAt: iso(0), endedAt: iso(600) }),
            activity({ id: "second", startedAt: iso(3600), endedAt: iso(3900) }),
            activity({ id: "pool", matter: PERSONAL, matterBy: "person" }),
            activity({ id: "gone", disposition: "dismissed" }),
            activity({ id: "fresh", startedAt: iso(40 * DAY), endedAt: iso(40 * DAY + 600) }),
        ];
        expect(pendingExpiring(w, at(82 * DAY))).toBeNull();
        expect(pendingExpiring(w, at(600 + (PENDING_MAX_DAYS - PENDING_WARN_DAYS) * DAY))).toBeNull();
        expect(pendingExpiring(w, at(84 * DAY))).toEqual({ count: 2, seconds: 900, from: iso(0), to: iso(3900), removeAt: iso(600 + 90 * DAY) });

        w.activities = w.activities.filter((a) => a.id === "pool" || a.id === "gone");
        expect(pendingExpiring(w, at(84 * DAY))).toBeNull();
    });

    it("keeping and dismissing stamp reviewedAt; deleting the entry and adding to it clear it", () => {
        const w = emptyWorkspace();
        w.activities = [
            activity({ id: "a", matter: "Whitfield" }),
            activity({ id: "b", startedAt: iso(1000), endedAt: iso(1600) }),
            activity({ id: "c", startedAt: iso(2000), endedAt: iso(2600), matter: "Whitfield" }),
        ];
        const entry = keepStretch(w, ["a"], { description: "Motion to dismiss", projectID: null, matter: "Whitfield", billable: true }, at(5000));
        dismissActivities(w, ["b"], at(6000));
        const byID = (id: string) => w.activities.find((a) => a.id === id)!;
        expect(byID("a")).toMatchObject({ disposition: "kept", reviewedAt: iso(5000) });
        expect(byID("b")).toMatchObject({ disposition: "dismissed", reviewedAt: iso(6000) });
        expect(byID("c").reviewedAt).toBeUndefined();
        validate(w);

        deleteEntry(w, entry.id);
        expect(byID("a").disposition).toBe("pending");
        expect(byID("a").reviewedAt).toBeUndefined();

        const again = keepStretch(w, ["a"], { description: "Motion to dismiss", projectID: null, matter: "Whitfield", billable: true }, at(7000));
        expect(byID("a").reviewedAt).toBe(iso(7000));
        mergeIntoEntry(w, ["c"], again.id);
        expect(byID("a")).toMatchObject({ disposition: "pending", mergeKey: again.id });
        expect(byID("a").reviewedAt).toBeUndefined();
        expect(byID("c").reviewedAt).toBeUndefined();
        validate(w);
    });

    it("validate refuses a malformed reviewedAt", () => {
        const w = emptyWorkspace();
        w.activities = [activity({ disposition: "dismissed", reviewedAt: iso(700) })];
        validate(w);
        w.activities[0].reviewedAt = "yesterday";
        expect(() => validate(w)).toThrow();
    });

    it("a meeting past retention stays while a pending row refers to it, and goes once that row is kept and old", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 14;
        w.preferences.importMeetings = true;
        ensureMeetings(w, at(0));
        const M = 60, SELF = "me@firm.com";
        const calendars = [{ provider: "microsoft" as const, status: "ok" as const, email: SELF }];
        const meeting: Meeting = { id: "microsoft:m1", provider: "microsoft", subject: "Acme lease call", start: iso(60 * M), end: iso(90 * M), organizer: SELF, attendees: ["jane@acme.com", SELF], online: "teams", join_url: "https://teams.microsoft.com/l/meetup-join/abc", location: null, notes: null };
        w.activities = [activity({ id: "call", app: "Microsoft Teams", ownerID: "com.microsoft.teams2", title: "Meeting | Microsoft Teams", startedAt: iso(61 * M), endedAt: iso(89 * M) })];
        applyMeetings(w, { meetings: [meeting], calendars }, { from: iso(0), to: iso(200 * M) }, at(100 * M));
        expect(w.activities[0].meeting?.id).toBe("microsoft:m1");

        // Twenty days on, the call still waits for review: the meeting (and the transcript it may hold) waits with it.
        const later = (days: number) => applyMeetings(w, { meetings: [], calendars }, { from: iso((days - 2) * DAY), to: iso(days * DAY) }, at(days * DAY));
        prune(w, at(20 * DAY));
        later(20);
        expect(w.meetings!.list.map((m) => m.id)).toEqual(["microsoft:m1"]);

        keepStretch(w, ["call"], { description: "Call with Acme on the lease", projectID: null, billable: true }, at(20 * DAY + 60));
        later(21);
        expect(w.meetings!.list).toEqual([]);
        validate(w);
    });

    it("an imported pending row past retention keeps a pending receipt; past the cap it expires", () => {
        const w = emptyWorkspace();
        w.preferences.importKiwiTime = true;
        w.preferences.retentionDays = 14;
        ensureFeed(w, accountOf("https://lawdie.co/kiwi-api/", "user-1"));
        const row: FeedRow = { id: "seg-1", kind: "browser", app: "Chrome", title: "Acme contract", url: "https://docs.example.com/acme", started_at: iso(0), ended_at: iso(600), seconds: 600, kiwi_project_id: null };
        const page: FeedPage = { account_id: "user-1", rows: [row], matters: [], next: null };
        expect(importFeed(w, page, at(3600))).toBe(1);

        prune(w, at(20 * DAY));
        refreshReceipts(w);
        expect(w.activities).toHaveLength(1);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("pending");

        prune(w, at(91 * DAY));
        refreshReceipts(w);
        expect(w.activities).toHaveLength(0);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("expired");
        // A replay never brings it back.
        expect(importFeed(w, page, at(91 * DAY))).toBe(0);
        expect(w.activities).toHaveLength(0);
    });
});
