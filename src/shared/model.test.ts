import { describe, expect, it } from "vitest";
import {
    closeActivity, deleteEntry, emptyWorkspace, keepActivity, markSynced, migrateV1, observe, parseWorkspace, prune,
    recover, saveEntry, startTimer, stopTimer, syncBatches, syncRequest, type Activity, type TimeEntry, type Workspace,
} from "./model";
import { KiwiClient, KiwiFailure, normalizeServerURL } from "./kiwi";

// The Swift app's 20 core checks, carried over as the contract this engine keeps.

const EPOCH = 1_780_000_000_000; // 2026-05-28T20:26:40Z
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const WORD = { app: "Microsoft Word", ownerID: "com.microsoft.Word", title: null as string | null };
const PREVIEW = { app: "Preview", ownerID: "com.apple.Preview", title: null };

function capturing(): Workspace {
    const w = emptyWorkspace();
    w.preferences.captureEnabled = true;
    return w;
}
const activity = (over: Partial<Activity> = {}): Activity => ({ id: "a-" + Math.random(), app: "Word", ownerID: "com.microsoft.Word", title: null, startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending", ...over });
const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({ id: "e-" + Math.random(), description: "Work", projectID: null, startedAt: iso(0), endedAt: iso(600), billable: false, hourlyRate: 0, source: "manual", activityID: null, ...over });

describe("capture", () => {
    it("requires opt-in, and titles require a separate opt-in", () => {
        const w = emptyWorkspace();
        observe(w, { ...WORD, title: "Secret" }, at(0), 0);
        expect(w.currentActivity).toBeNull();
        w.preferences.captureEnabled = true;
        observe(w, { ...WORD, title: "Secret" }, at(5), 0);
        expect(w.currentActivity?.title).toBeNull();
        w.preferences.captureTitles = true;
        observe(w, { ...WORD, title: "Document" }, at(10), 0);
        expect(w.currentActivity?.title).toBe("Document");
        expect(w.activities[0].title).toBeNull();
    });

    it("a switch produces a bounded neutral segment", () => {
        const w = capturing();
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0); observe(w, PREVIEW, at(10), 0);
        expect(w.activities).toHaveLength(1);
        expect(w.activities[0]).toMatchObject({ endedBy: "switched", startedAt: iso(0), endedAt: iso(10) });
        expect(w.currentActivity?.app).toBe("Preview");
        expect(w.entries).toEqual([]);
    });

    it("an excluded app, the app itself, and a Windows executable on the list close the previous segment without capturing", () => {
        const w = capturing();
        observe(w, WORD, at(0), 0); observe(w, { app: "Passwords", ownerID: "com.apple.Passwords", title: null }, at(5), 0);
        expect(w.currentActivity).toBeNull();
        expect(w.activities).toHaveLength(1);
        expect(w.activities[0].endedBy).toBe("excluded");
        observe(w, WORD, at(8), 0);
        observe(w, { app: "Lawdie Time Capture", ownerID: "C:\\x\\lawdie.exe", title: null, isSelf: true }, at(12), 0);
        expect(w.currentActivity).toBeNull();
        expect(w.activities[1].endedBy).toBe("switched"); // coming to this app is not "a private app"
        observe(w, { app: "1Password", ownerID: "C:\\Program Files\\1Password\\1Password.exe", title: null }, at(15), 0);
        expect(w.currentActivity).toBeNull();
    });

    it("idle trims the segment and the timer to the last input, and does not restart billing", () => {
        const w = capturing();
        w.preferences.idleMinutes = 1;
        startTimer(w, { description: "Draft", projectID: null, billable: true }, at(0));
        for (let s = 0; s <= 85; s += 5) observe(w, WORD, at(s), Math.max(0, s - 30));
        observe(w, WORD, at(90), 60);
        expect(w.timer).toBeNull(); expect(w.currentActivity).toBeNull();
        expect(w.entries[0].endedAt).toBe(iso(30));
        expect(w.activities[0].endedAt).toBe(iso(30));
        observe(w, WORD, at(95), 0);
        expect(w.timer).toBeNull();
        expect(w.currentActivity).not.toBeNull();
    });

    it("sleep stops the timer and capture", () => {
        const w = capturing();
        startTimer(w, { description: "Work", projectID: null, billable: false }, at(0));
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0); observe(w, WORD, at(9), 0, true);
        expect(w.timer).toBeNull(); expect(w.currentActivity).toBeNull();
        expect(w.entries[0].endedAt).toBe(iso(9));
        expect(w.activities[0].endedBy).toBe("suspended");
    });

    it("crash recovery never counts downtime", () => {
        const w = capturing();
        startTimer(w, { description: "Work", projectID: null, billable: false }, at(0));
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0);
        recover(w, at(8 * 3600));
        expect(w.entries[0].endedAt).toBe(iso(5));
        expect(w.activities[0]).toMatchObject({ endedAt: iso(5), endedBy: "crash-recovered" });
        expect(w.timer).toBeNull(); expect(w.currentActivity).toBeNull();
    });

    it("an unobserved gap is not time worked", () => {
        const w = capturing();
        startTimer(w, { description: "Work", projectID: null, billable: false }, at(0));
        observe(w, WORD, at(0), 0); observe(w, WORD, at(5), 0); observe(w, WORD, at(600), 0);
        expect(w.entries[0].endedAt).toBe(iso(5));
        expect(w.activities[0].endedAt).toBe(iso(5));
        expect(w.currentActivity?.startedAt).toBe(iso(600));
    });

    it("keeps Office document details only when switched on, and a new document is new work", () => {
        const w = capturing();
        const doc = { name: "Whitfield motion.docx", path: "/x/Whitfield motion.docx", excerpt: "Re:   Whitfield v. Meridian\n Matter 2026-014" };
        observe(w, { ...WORD, document: doc }, at(0), 0);
        expect(w.currentActivity?.document).toBeNull();
        w.preferences.captureDocuments = true;
        observe(w, { ...WORD, document: doc }, at(5), 0);
        expect(w.currentActivity?.document).toEqual({ name: "Whitfield motion.docx", path: "/x/Whitfield motion.docx", excerpt: "Re: Whitfield v. Meridian Matter 2026-014" });
        // A probe that failed once does not end the segment or lose what it knew.
        observe(w, { ...WORD, document: null }, at(10), 0);
        expect(w.currentActivity?.document?.name).toBe("Whitfield motion.docx");
        expect(w.activities).toEqual([]);
        // A different document is a different stretch of work.
        observe(w, { ...WORD, document: { name: "Lease.docx", path: null, excerpt: null } }, at(15), 0);
        expect(w.activities).toHaveLength(1);
        expect(w.activities[0].document?.name).toBe("Whitfield motion.docx");
        expect(w.currentActivity?.document).toEqual({ name: "Lease.docx", path: null, excerpt: null });
        const req = syncRequest(w, "t");
        expect(req.activities[0]).toMatchObject({ document_name: "Whitfield motion.docx", document_path: "/x/Whitfield motion.docx", excerpt: "Re: Whitfield v. Meridian Matter 2026-014" });
    });

    it("brief activity is discarded", () => {
        const w = capturing();
        observe(w, WORD, at(0), 0); closeActivity(w, at(1), "switched");
        expect(w.activities).toEqual([]);
    });
});

describe("timer and entries", () => {
    it("one timer at a time, with the rate frozen at start", () => {
        const w = emptyWorkspace();
        w.projects = [{ id: "p", name: "Matter", client: "", color: "gold", hourlyRate: 350, archived: false }];
        startTimer(w, { description: "Work", projectID: "p", billable: true }, at(0));
        expect(() => startTimer(w, { description: "Other", projectID: null, billable: false }, at(1))).toThrow();
        w.projects[0].hourlyRate = 500;
        stopTimer(w, at(3600));
        expect(w.entries[0].hourlyRate).toBe(350);
    });

    it("review is explicit and idempotent", () => {
        const w = emptyWorkspace();
        const a = activity(); w.activities = [a];
        keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700));
        expect(w.entries).toHaveLength(1);
        expect(w.activities[0].disposition).toBe("kept");
        expect(w.entries[0].activityID).toBe(a.id);
        expect(() => keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700))).toThrow();
    });

    it("overlaps are rejected; adjacent and self-edits are allowed", () => {
        const w = emptyWorkspace();
        const e = entry({ description: "One" });
        saveEntry(w, e, at(3600)); saveEntry(w, e, at(3600));
        expect(w.entries).toHaveLength(1);
        expect(() => saveEntry(w, entry({ startedAt: iso(599), endedAt: iso(800) }), at(3600))).toThrow();
        saveEntry(w, entry({ startedAt: iso(600), endedAt: iso(800) }), at(3600));
        startTimer(w, { description: "Running", projectID: null, billable: false }, at(900));
        expect(() => saveEntry(w, entry({ startedAt: iso(850), endedAt: iso(950) }), at(3600))).toThrow();
    });

    it("invalid and future entries are rejected", () => {
        const w = emptyWorkspace();
        for (const bad of [entry({ description: " " }), entry({ startedAt: iso(100), endedAt: iso(0) }), entry({ endedAt: iso(1000) }), entry({ hourlyRate: -10 })]) {
            expect(() => saveEntry(w, bad, at(600))).toThrow();
        }
    });

    it("a failed review does not mark the activity kept", () => {
        const w = emptyWorkspace();
        w.entries = [entry({ description: "Existing" })];
        const a = activity(); w.activities = [a];
        expect(() => keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700))).toThrow();
        expect(w.activities[0].disposition).toBe("pending");
        expect(w.entries).toHaveLength(1);
    });

    it("retention removes activity, never entries", () => {
        const w = emptyWorkspace();
        w.preferences.retentionDays = 7;
        w.activities = [activity({ endedAt: iso(60) })];
        w.entries = [entry({ endedAt: iso(60) })];
        prune(w, at(8 * 86400));
        expect(w.activities).toEqual([]);
        expect(w.entries).toHaveLength(1);
    });
});

describe("Kiwi sync", () => {
    it("builds the wire request Kiwi's cleanSyncBody accepts, without the in-progress segment", () => {
        const w = emptyWorkspace();
        w.projects = [{ id: "p", name: "Whitfield v. Meridian", client: "Whitfield", color: "gold", hourlyRate: 350, archived: false }];
        const a = activity({ id: "a1", app: "Microsoft Word", title: "Motion.docx", endedAt: iso(1200), disposition: "kept" });
        w.activities = [a];
        w.currentActivity = activity({ app: "Preview" });
        w.entries = [entry({ id: "4fd1c8a2-3b7e-4c1d-9a2f-1b3c4d5e6f70", description: "Prepare motion", projectID: "p", endedAt: iso(1200), billable: true, hourlyRate: 350, source: "desktop", activityID: "a1" })];
        w.sync = { serverURL: "https://lawdie.co/kiwi-api", deviceID: "d", deviceName: "Mac", accountEmail: null, autoSync: true, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["gone"] };
        const req = syncRequest(w, "0.3.0");
        expect(Object.keys(req).sort()).toEqual(["activities", "app_version", "deleted_entry_ids", "entries"]);
        expect(req.activities).toEqual([{ id: "a1", app: "Microsoft Word", bundle_id: "com.microsoft.Word", title: "Motion.docx", document_name: null, document_path: null, excerpt: null, started_at: iso(0), ended_at: iso(1200), seconds: 1200, ended_by: "switched", disposition: "kept" }]);
        expect(req.entries[0]).toEqual({ id: "4fd1c8a2-3b7e-4c1d-9a2f-1b3c4d5e6f70", description: "Prepare motion", project_name: "Whitfield v. Meridian", client_name: "Whitfield", started_at: iso(0), ended_at: iso(1200), seconds: 1200, billable: true, hourly_rate: 350, source: "desktop", activity_id: "a1" });
        expect(req.deleted_entry_ids).toEqual(["gone"]);
        expect(JSON.stringify(req)).not.toContain("ldt_");
    });

    it("deleting an entry reopens its activity and records a tombstone only when connected", () => {
        const w = emptyWorkspace();
        const a = activity(); w.activities = [a];
        const kept = keepActivity(w, a.id, { description: "Draft", projectID: null, billable: true }, at(700));
        deleteEntry(w, kept.id);
        expect(w.entries).toEqual([]);
        expect(w.activities[0].disposition).toBe("pending");
        expect(w.sync).toBeNull();
        w.sync = { serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, autoSync: true, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] };
        saveEntry(w, entry({ id: kept.id, description: "Again" }), at(700));
        deleteEntry(w, kept.id); deleteEntry(w, kept.id); deleteEntry(w, "nothing");
        expect(w.sync.deletedEntryIDs).toEqual([kept.id]);
    });

    it("clears only the deletions Kiwi acknowledged", () => {
        const w = emptyWorkspace();
        w.sync = { serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, autoSync: true, lastSyncedAt: null, lastError: "boom", deletedEntryIDs: ["seen", "later"] };
        markSynced(w, at(10), ["seen"]);
        expect(w.sync).toMatchObject({ deletedEntryIDs: ["later"], lastSyncedAt: iso(10), lastError: null });
    });

    it("batches under Kiwi's limit with deletions first", () => {
        const w = emptyWorkspace();
        w.activities = Array.from({ length: 1201 }, (_, i) => activity({ id: `a${i}` }));
        w.entries = Array.from({ length: 7 }, (_, i) => entry({ id: `e${i}`, startedAt: iso(i * 1000), endedAt: iso(i * 1000 + 600) }));
        w.sync = { serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, autoSync: true, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["x", "y"] };
        const batches = syncBatches(syncRequest(w, "t"));
        expect(batches.map((b) => b.activities.length)).toEqual([500, 500, 201]);
        expect(batches.map((b) => b.entries.length)).toEqual([7, 0, 0]);
        expect(batches.map((b) => b.deleted_entry_ids.length)).toEqual([2, 0, 0]);
    });

    it("normalises the server URL and refuses junk", () => {
        expect(normalizeServerURL(" https://lawdie.co/kiwi-api/ ")).toBe("https://lawdie.co/kiwi-api");
        expect(normalizeServerURL("http://localhost:4100")).toBe("http://localhost:4100");
        for (const junk of ["", "lawdie.co", "ftp://x", "file:///tmp", "https://"]) expect(normalizeServerURL(junk)).toBeNull();
        expect(() => new KiwiClient("nope", "ldt_x")).toThrow(KiwiFailure);
    });

    it("reads Kiwi's refusals as what they are", async () => {
        const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
        await expect(new KiwiClient("https://k.test", "t", respond(401, { code: "device_revoked" })).hello()).rejects.toMatchObject({ code: "device_revoked" });
        await expect(new KiwiClient("https://k.test", "t", respond(401, { code: "invalid_device_token" })).hello()).rejects.toMatchObject({ code: "invalid_token" });
        await expect(new KiwiClient("https://k.test", "t", respond(503, {})).hello()).rejects.toMatchObject({ code: "migration_pending" });
        await expect(new KiwiClient("https://k.test", "t", respond(413, {})).hello()).rejects.toMatchObject({ code: "too_large" });
        const ok = await new KiwiClient("https://k.test", "t", respond(200, { ok: true, device: { id: "d", name: "Mac" }, user: { email: "a@b" } })).hello();
        expect(ok.device.name).toBe("Mac");
    });
});

describe("files", () => {
    it("reads a workspace the Swift app wrote (reference-date seconds, bundleID) and keeps everything", () => {
        const swift = {
            schemaVersion: 1,
            projects: [{ id: "P1", name: "Matter", client: "Client", color: "gold", hourlyRate: 350, archived: false }],
            entries: [{ id: "E1", description: "Draft", projectID: "P1", startedAt: 812492800, endedAt: 812496400, billable: true, hourlyRate: 350, source: "desktop", activityID: "A1" }],
            activities: [{ id: "A1", app: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92", startedAt: 812492800, endedAt: 812496400, endedBy: "paused", disposition: "kept" }],
            preferences: { captureEnabled: true, captureTitles: false, idleMinutes: 3, retentionDays: 14, excludedBundleIDs: ["com.apple.Passwords"] },
        };
        const w = parseWorkspace(JSON.stringify(swift));
        expect(w.schemaVersion).toBe(2);
        expect(w.activities[0]).toMatchObject({ ownerID: "com.todesktop.230313mzl4w4u92", startedAt: "2026-09-30T20:26:40.000Z", endedAt: "2026-09-30T21:26:40.000Z", disposition: "kept" });
        expect(w.entries[0]).toMatchObject({ projectID: "P1", startedAt: "2026-09-30T20:26:40.000Z", billable: true });
        expect(w.preferences).toMatchObject({ captureEnabled: true, excludedOwnerIDs: ["com.apple.Passwords"] });
        expect(w.sync).toBeNull();
    });

    it("refuses a newer schema and invalid data, and fills in what an older v2 file lacks", () => {
        expect(() => parseWorkspace(JSON.stringify({ schemaVersion: 99 }))).toThrow(/newer/);
        expect(() => parseWorkspace(JSON.stringify({ ...emptyWorkspace(), preferences: { ...emptyWorkspace().preferences, idleMinutes: 0 } }))).toThrow(/invalid/);
        const { sync: _s, timer: _t, currentActivity: _c, ...older } = emptyWorkspace();
        expect(parseWorkspace(JSON.stringify(older))).toEqual(emptyWorkspace());
        expect(migrateV1({}).preferences.excludedOwnerIDs.length).toBeGreaterThan(0);
    });
});
