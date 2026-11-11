import { describe, expect, it } from "vitest";
import { accountOf, ensureFeed, importFeed, joinMatter, type FeedPage, type FeedRow } from "./feed";
import { applyMatters } from "./matters";
import { carriedDeletions, emptyWorkspace, isLockScreen, observe, projectNamed, screenshotsToDelete, syncRequest, updateProject, validate, type Activity, type SyncTarget, type TimeEntry, type Workspace } from "./model";

// The edge cases found in the 2026-11-10 audit, each pinned so it stays fixed.

const EPOCH = 1_780_000_000_000;
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const SERVER = "https://lawdie.co/kiwi-api";
const ACCOUNT = accountOf(SERVER + "/", "user-1");
const ACME = { id: "11111111-1111-4111-8111-111111111111", name: "Acme Matter", cm_number: "CM-100" };
const ACME_2 = { id: "33333333-3333-4333-8333-333333333333", name: "acme matter ", cm_number: null };
const NOW = at(3600);

function connected(): Workspace {
    const w = emptyWorkspace();
    w.preferences.importKiwiTime = true;
    ensureFeed(w, ACCOUNT);
    return w;
}
const row = (over: Partial<FeedRow> = {}): FeedRow => ({ id: "seg-1", kind: "browser", app: "Chrome", title: "Acme contract", url: "https://docs.example.com/acme", started_at: iso(0), ended_at: iso(600), seconds: 600, kiwi_project_id: null, ...over });
const page = (rows: FeedRow[], matters = [ACME]): FeedPage => ({ account_id: "user-1", rows, matters, next: null });
const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({ id: "e-" + Math.random(), description: "Work", projectID: null, startedAt: iso(0), endedAt: iso(600), billable: true, hourlyRate: 0, source: "desktop", activityID: null, ...over });
const target = (over: Partial<SyncTarget> = {}): SyncTarget => ({ product: "kiwi", serverURL: SERVER, deviceID: "d1", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [], ...over });

describe("screenshots survive a missing workspace file", () => {
    const name = (s: number) => `11111111-1111-4111-8111-111111111111-${at(s)}.jpg`;
    const files = [{ name: name(0), mtimeMs: at(0) }, { name: name(10), mtimeMs: at(10) }, { name: name(5000), mtimeMs: at(5000) }];
    it("deletes nothing when nothing is referenced", () => {
        expect(screenshotsToDelete(files, new Set(), at(9000), 600_000)).toEqual([]);
    });
    it("never deletes one from before a fresh start, nor one just taken", () => {
        expect(screenshotsToDelete(files, new Set([name(10)]), at(9000), 600_000)).toEqual([name(0), name(5000)]);
        expect(screenshotsToDelete(files, new Set([name(10)]), at(9000), 600_000, at(1000))).toEqual([name(5000)]);
        expect(screenshotsToDelete(files, new Set([name(10)]), at(5100), 600_000, at(1000))).toEqual([]);
    });
});

describe("a reconnect keeps deletions not yet acknowledged", () => {
    it("carries them for the same product only", () => {
        const sync = { autoSync: true, targets: [target({ deletedEntryIDs: ["e1", "e2"] }), target({ product: "crm", deletedEntryIDs: ["e3"] })] };
        expect(carriedDeletions(sync, "kiwi")).toEqual(["e1", "e2"]);
        expect(carriedDeletions(sync, "crm")).toEqual(["e3"]);
        expect(carriedDeletions(null, "kiwi")).toEqual([]);
    });
});

describe("a matter number the person typed", () => {
    it("is not replaced by Kiwi's on import, at keep or on a join; an empty one is filled", () => {
        const w = connected();
        const p = projectNamed(w, "Acme Matter"); p.matterNumber = "104882-0001";
        importFeed(w, page([row({ kiwi_project_id: ACME.id })]), NOW);
        expect(p).toMatchObject({ kiwiProjectID: ACME.id, matterNumber: "104882-0001" });
        const w2 = connected(); w2.feed!.matters = [ACME];
        const q = projectNamed(w2, "Local name"); q.matterNumber = "MINE-1";
        joinMatter(w2, q.id, ACME.id);
        expect(q.matterNumber).toBe("MINE-1");
        const w3 = connected();
        const empty = projectNamed(w3, "Acme Matter");
        importFeed(w3, page([row({ kiwi_project_id: ACME.id })]), NOW);
        expect(empty.matterNumber).toBe("CM-100");
        validate(w); validate(w2); validate(w3);
    });
});

describe("only settled entries sync", () => {
    it("holds back a suggestion, an entry sent back and a dismissed one", () => {
        const w = emptyWorkspace();
        w.entries.push(entry({ id: "plain" }), entry({ id: "draft", status: "draft" }), entry({ id: "suggested", status: "suggested" }), entry({ id: "flagged", status: "flagged" }), entry({ id: "dismissed", status: "dismissed" }));
        expect(syncRequest(w, "0.16.2", "UTC", target()).entries.map((e) => e.id)).toEqual(["plain", "draft"]);
    });
});

describe("the lock screen is never work", () => {
    it("knows the login window and Windows' lock screens", () => {
        for (const id of ["com.apple.loginwindow", "/System/Library/CoreServices/loginwindow.app", "C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe", "C:\\Windows\\System32\\LogonUI.exe"]) expect(isLockScreen(id)).toBe(true);
        expect(isLockScreen("com.microsoft.Word")).toBe(false);
    });
    it("ends the segment when the login window comes to the front, and counts none of it", () => {
        const w = emptyWorkspace(); w.preferences.captureEnabled = true;
        const WORD = { app: "Word", ownerID: "com.microsoft.Word", title: null };
        const LOGIN = { app: "loginwindow", ownerID: "com.apple.loginwindow", title: null };
        observe(w, WORD, at(0), 0); observe(w, WORD, at(30), 0);
        observe(w, LOGIN, at(35), 0); observe(w, LOGIN, at(600), 0);
        expect(w.currentActivity).toBeNull();
        expect(w.activities.map((a) => a.app)).toEqual(["Word"]);
    });
});

describe("a calendar row does not erase browser time", () => {
    it("leaves imported time under a meeting row in review beside it", () => {
        const w = connected();
        const meeting: Activity = { id: "cal-1", app: "Outlook calendar", ownerID: "calendar:microsoft", title: "Client call", startedAt: iso(0), endedAt: iso(600), endedBy: "calendar", disposition: "pending" };
        w.activities.push(meeting);
        importFeed(w, page([row()]), NOW);
        const imported = w.activities.find((a) => a.originRef === "seg-1")!;
        expect(imported.disposition).toBe("pending");
        expect(imported.sittings!.map(({ startedAt, endedAt }) => ({ startedAt, endedAt }))).toEqual([{ startedAt: iso(0), endedAt: iso(600) }]);
    });
});

describe("a matter name two Kiwi matters share", () => {
    it("names the row but links neither", () => {
        const w = connected(); w.feed!.matters = [ACME, ACME_2];
        w.activities.push({ id: "d1", app: "Word", ownerID: "com.microsoft.Word", title: "Acme.docx", startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending" });
        applyMatters(w, ["d1"], { assignments: [{ activity_id: "d1", matter: "Acme Matter" }] });
        expect(w.activities[0].matter).toBe("Acme Matter");
        expect(w.activities[0].kiwiProjectID).toBeUndefined();
    });
});

describe("the first rate on a matter", () => {
    it("fills billable $0 entries not yet invoiced; a chosen rate, non-billable or invoiced entry is left", () => {
        const w = emptyWorkspace();
        const p = projectNamed(w, "New matter");
        w.entries.push(entry({ id: "zero", projectID: p.id }), entry({ id: "free", projectID: p.id, billable: false }), entry({ id: "billed", projectID: p.id }), entry({ id: "chosen", projectID: p.id, hourlyRate: 150 }));
        w.invoices = [{ number: "INV-1", projectID: p.id, client: "", matter: "New matter", from: "2026-05-28", to: "2026-05-28", mode: "generic", issuedAt: iso(0), total: 0, entryIDs: ["billed"] }];
        updateProject(w, p.id, { hourlyRate: 400 });
        expect(Object.fromEntries(w.entries.map((e) => [e.id, e.hourlyRate]))).toEqual({ zero: 400, free: 0, billed: 0, chosen: 150 });
        updateProject(w, p.id, { hourlyRate: 500 });
        expect(w.entries.find((e) => e.id === "zero")!.hourlyRate).toBe(400);
    });
});
