import { describe, expect, it } from "vitest";
import {
    closeActivity, deleteEntry, dismissActivities, emptyWorkspace, keepActivity, keepStretch, markSynced, migrateV1, observe, parseWorkspace, prune,
    recover, saveEntry, seconds, secondsWithin, startTimer, stopTimer, stretchesOf, syncBatches, syncRequest, validate, WorkspaceError, type Activity, type TimeEntry, type Workspace,
} from "./model";
import { KiwiClient, KiwiFailure, PRODUCTS, destinationLabel, isDestination, normalizeServerURL, productsFor, type Product } from "./kiwi";

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

describe("stretches", () => {
    const seg = (id: string, start: number, end: number, name: string, app = "Microsoft Word", extra: Partial<Activity> = {}): Activity =>
        ({ id, app, ownerID: `com.${app.replace(/\s/g, "")}`, title: null, document: { name, path: null, excerpt: null }, startedAt: iso(start), endedAt: iso(end), endedBy: "switched", disposition: "pending", ...extra });

    it("groups sittings on one document within the gap into one stretch, across other documents' sittings, and sets short hops apart", () => {
        const acts = [
            seg("a", 0, 600, "Hollis letter.docx"),
            seg("b", 600, 900, "Brantley schedule.xlsx", "Microsoft Excel"),
            seg("c", 900, 1500, "Hollis letter.docx"),
            seg("d", 1500, 1530, "Slack", "Slack", { document: null, title: "Slack" }),
            seg("e", 1530, 1800, "Brantley schedule.xlsx", "Microsoft Excel"),
            seg("f", 1800 + 20 * 60, 1800 + 20 * 60 + 300, "Hollis letter.docx"), // 20 minutes later: a new stretch
            seg("g", 100, 400, "Kept already.docx", "Microsoft Word", { disposition: "kept" }),
        ];
        const { stretches, short } = stretchesOf(acts);
        expect(stretches.map((st) => [st.name, st.sittings, st.seconds])).toEqual([
            ["Hollis letter.docx", 1, 300],
            ["Brantley schedule.xlsx", 2, 570],
            ["Hollis letter.docx", 2, 1200],
        ]);
        expect(stretches[2].activityIDs).toEqual(["a", "c"]);
        expect(stretches[2]).toMatchObject({ startedAt: iso(0), endedAt: iso(1500), endedBy: "switched" });
        expect(short.map((st) => [st.name, st.seconds])).toEqual([["Slack", 30]]);
    });

    it("keeps a stretch as one entry whose sittings alone count and alone block overlap, and reopens all of them on delete", () => {
        const w = emptyWorkspace();
        w.activities = [seg("a", 0, 600, "Hollis letter.docx"), seg("b", 600, 900, "Brantley schedule.xlsx", "Microsoft Excel"), seg("c", 900, 1500, "Hollis letter.docx")];
        const hollis = stretchesOf(w.activities).stretches.find((st) => st.sittings === 2)!;
        const entry = keepStretch(w, hollis.activityIDs, { description: "Drafted the Hollis letter", projectID: null, billable: true }, at(2000));
        expect(entry).toMatchObject({ startedAt: iso(0), endedAt: iso(1500), activityID: "a", activityIDs: ["a", "c"] });
        expect(entry.sittings).toEqual([{ startedAt: iso(0), endedAt: iso(600) }, { startedAt: iso(900), endedAt: iso(1500) }]);
        expect(seconds(entry)).toBe(1200);
        expect(secondsWithin(entry, at(500), at(1000))).toBe(200);
        expect(w.activities.filter((a) => a.disposition === "kept").map((a) => a.id)).toEqual(["a", "c"]);
        // The Excel sitting sits in the gap: it is still free to keep.
        const excel = keepActivity(w, "b", { description: "Schedule", projectID: null, billable: true }, at(2000));
        expect(excel.sittings).toBeUndefined();
        expect(seconds(excel)).toBe(300);
        // But nothing may land on a sitting.
        expect(() => saveEntry(w, { ...excel, id: "x", startedAt: iso(1000), endedAt: iso(1100) }, at(2000))).toThrow(WorkspaceError);
        // The wire request carries the worked seconds, which both servers honour.
        expect(syncRequest(w, "t").entries.find((e) => e.id === entry.id)?.seconds).toBe(1200);
        // Sittings must stay inside the span and in order.
        expect(() => saveEntry(w, { ...entry, id: "y", sittings: [{ startedAt: iso(0), endedAt: iso(2000) }] }, at(3000))).toThrow(WorkspaceError);
        deleteEntry(w, entry.id);
        expect(w.activities.filter((a) => a.disposition === "pending").map((a) => a.id)).toEqual(["a", "c"]);
        // Dismissing a stretch dismisses every sitting; a stretch cannot be kept twice.
        dismissActivities(w, ["a", "c"]);
        expect(w.activities.map((a) => a.disposition)).toEqual(["dismissed", "kept", "dismissed"]);
        expect(() => keepStretch(w, ["a", "c"], { description: "x", projectID: null, billable: true }, at(3000))).toThrow(WorkspaceError);
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
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://lawdie.co/kiwi-api", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["gone"] }], autoSync: true };
        const req = syncRequest(w, "0.3.0", "America/New_York");
        expect(Object.keys(req).sort()).toEqual(["activities", "app_version", "deleted_entry_ids", "entries", "time_zone"]);
        expect(req.time_zone).toBe("America/New_York");
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
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }, { product: "crm", serverURL: "https://crm.test/api", deviceID: "e", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }], autoSync: true };
        saveEntry(w, entry({ id: kept.id, description: "Again" }), at(700));
        deleteEntry(w, kept.id); deleteEntry(w, kept.id); deleteEntry(w, "nothing");
        expect(w.sync.targets.map((t) => t.deletedEntryIDs)).toEqual([[kept.id], [kept.id]]);
    });

    it("clears only the deletions Kiwi acknowledged", () => {
        const w = emptyWorkspace();
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: "boom", deletedEntryIDs: ["seen", "later"] }, { product: "crm", serverURL: "https://crm.test/api", deviceID: "e", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["seen", "later"] }], autoSync: true };
        markSynced(w, at(10), ["seen"], "kiwi");
        expect(w.sync.targets[0]).toMatchObject({ deletedEntryIDs: ["later"], lastSyncedAt: iso(10), lastError: null });
        expect(w.sync.targets[1]).toMatchObject({ deletedEntryIDs: ["seen", "later"], lastSyncedAt: null });
        expect(syncRequest(w, "t", null, w.sync.targets[1]).deleted_entry_ids).toEqual(["seen", "later"]);
        markSynced(w, at(11), ["seen", "later"]);
        expect(w.sync.targets.map((t) => t.deletedEntryIDs)).toEqual([[], []]);
    });

    it("batches under Kiwi's limit with deletions first", () => {
        const w = emptyWorkspace();
        w.activities = Array.from({ length: 1201 }, (_, i) => activity({ id: `a${i}` }));
        w.entries = Array.from({ length: 7 }, (_, i) => entry({ id: `e${i}`, startedAt: iso(i * 1000), endedAt: iso(i * 1000 + 600) }));
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://kiwi.test", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["x", "y"] }], autoSync: true };
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

    it("names the destination in what it says, so a CRM user is never told about Kiwi", async () => {
        const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
        const crm = new KiwiClient(PRODUCTS.crm.defaultServerURL, "t", respond(401, { code: "device_revoked" }), 30_000, PRODUCTS.crm.label);
        expect(crm.baseURL).toBe("https://crm-api.lawdie.co/api");
        await expect(crm.hello()).rejects.toThrow(/disconnected in Lawdie CRM/);
        await expect(new KiwiClient("https://k.test", "t", respond(503, {})).hello()).rejects.toThrow(/^Kiwi is not ready/);
        expect(() => new KiwiClient("nope", "t", fetch, 30_000, "Lawdie CRM")).toThrow(/Lawdie CRM server address, such as https:\/\/crm-api\.lawdie\.co\/api/);
        expect(isDestination("crm") && isDestination("kiwi") && !isDestination("other")).toBe(true);
        expect(destinationLabel([])).toBe("Kiwi");
    });

    it("reads a 0.4.x workspace (one product, flat) as one target, and refuses an unknown product", () => {
        const w = emptyWorkspace();
        const flat = { destination: "crm", serverURL: "https://crm-api.lawdie.co/api", deviceID: "d", deviceName: "PC", accountEmail: "a@b", autoSync: false, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["z"] };
        const back = parseWorkspace(JSON.stringify({ ...w, sync: flat }));
        expect(back.sync).toEqual({ targets: [{ product: "crm", serverURL: flat.serverURL, deviceID: "d", deviceName: "PC", accountEmail: "a@b", lastSyncedAt: null, lastError: null, deletedEntryIDs: ["z"] }], autoSync: false });
        const { destination: _d, ...older } = flat;
        expect(parseWorkspace(JSON.stringify({ ...w, sync: older })).sync?.targets[0].product).toBe("kiwi");
        w.sync = { targets: [{ product: "kiwi", serverURL: "https://k", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }, { product: "crm", serverURL: "https://c/api", deviceID: "e", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }], autoSync: true };
        expect(parseWorkspace(JSON.stringify(w)).sync).toEqual(w.sync);
        expect(() => validate({ ...w, sync: { ...w.sync!, targets: [{ ...w.sync!.targets[0], product: "elsewhere" as Product }] } })).toThrow(WorkspaceError);
        expect(() => validate({ ...w, sync: { ...w.sync!, targets: [w.sync!.targets[0], w.sync!.targets[0]] } })).toThrow(WorkspaceError);
        expect(productsFor("both")).toEqual(["kiwi", "crm"]);
        expect(destinationLabel(["kiwi", "crm"])).toBe("Kiwi and Lawdie CRM");
        expect(isDestination("both") && !isDestination("elsewhere")).toBe(true);
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
