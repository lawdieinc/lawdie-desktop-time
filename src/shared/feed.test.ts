import { describe, expect, it } from "vitest";
import { accountOf, applyJoins, ensureFeed, importFeed, joinMatter, joinRequest, matchingProject, parseFeedPage, refreshReceipts, subtractIntervals, undoJoin, type FeedPage, type FeedRow } from "./feed";
import { PERSONAL, WorkspaceError, deleteEntry, dismissActivities, emptyWorkspace, keepStretch, mergeProjects, projectNamed, prune, setMatter, syncBatches, syncRequest, updateProject, validate, type Activity, type SyncTarget, type Workspace } from "./model";
import { applyMatters, inboxOf } from "./matters";

// Kiwi and browser time, brought in for review beside this computer's own (docs/kiwi-and-browser-time.md).

const EPOCH = 1_780_000_000_000; // 2026-05-28T20:26:40Z
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const SERVER = "https://lawdie.co/kiwi-api";
const ACCOUNT = accountOf(SERVER + "/", "user-1");
const ACME = { id: "11111111-1111-4111-8111-111111111111", name: "Acme Matter", cm_number: "CM-100" };
const BOLT = { id: "22222222-2222-4222-8222-222222222222", name: "Bolt Holdings", cm_number: null };
const NOW = at(3600);

function connected(): Workspace {
    const w = emptyWorkspace();
    w.preferences.importKiwiTime = true;
    ensureFeed(w, ACCOUNT);
    return w;
}
const row = (over: Partial<FeedRow> = {}): FeedRow => ({ id: "seg-1", kind: "browser", app: "Chrome", title: "Acme contract", url: "https://docs.example.com/acme?tab=1#top", started_at: iso(0), ended_at: iso(600), seconds: 600, kiwi_project_id: null, ...over });
const page = (rows: FeedRow[], matters = [ACME, BOLT]): FeedPage => ({ account_id: "user-1", rows, matters, next: null });
const local = (over: Partial<Activity> = {}): Activity => ({ id: "l-" + Math.random(), app: "Word", ownerID: "com.microsoft.Word", title: null, startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending", ...over });
const target = (product: "kiwi" | "crm"): SyncTarget => ({ product, serverURL: SERVER, deviceID: "d1", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] });

describe("importing a feed page", () => {
    it("accepts a page once: a replay neither duplicates nor reopens anything", () => {
        const w = connected();
        expect(importFeed(w, page([row(), row({ id: "chat-1", kind: "chat", app: "Kiwi", title: "Acme memo", url: undefined, started_at: iso(1000), ended_at: iso(1300), seconds: 300, kiwi_project_id: ACME.id })]), NOW)).toBe(2);
        expect(importFeed(w, page([row()]), NOW)).toBe(0);
        expect(w.activities).toHaveLength(2);
        const chrome = w.activities.find((a) => a.originRef === "seg-1")!;
        expect(chrome).toMatchObject({ origin: "browser", sourceKind: "browser", originAccount: ACCOUNT, ownerID: "import:browser", endedBy: "imported", disposition: "pending", url: "https://docs.example.com/acme" });
        const chat = w.activities.find((a) => a.originRef === "chat-1")!;
        expect(chat).toMatchObject({ origin: "kiwi", sourceKind: "chat", matter: "Acme Matter", kiwiProjectID: ACME.id });
        expect(w.feed!.matters).toEqual([ACME, BOLT]);
        expect(w.feed!.lastImportedAt).toBe(new Date(NOW).toISOString());
        validate(w);

        // Dismissed, then pruned by retention: the receipt remembers, so the row never returns.
        // The chat row was never reviewed, so it waits (retention is for reviewed activity).
        dismissActivities(w, [chrome.id], NOW);
        refreshReceipts(w);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("dismissed");
        prune(w, NOW + 15 * 86_400_000);
        expect(w.activities.map((a) => a.originRef)).toEqual(["chat-1"]);
        expect(importFeed(w, page([row()]), at(0) + 15 * 86_400_000)).toBe(0);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("dismissed");
    });

    it("lets a row older than retention through as a receipt only", () => {
        const w = connected();
        expect(importFeed(w, page([row({ ended_at: iso(600) })]), at(600) + 15 * 86_400_000)).toBe(0);
        expect(w.activities).toHaveLength(0);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("expired");
    });

    it("refuses a workspace that belongs to another Kiwi account", () => {
        const w = connected();
        expect(() => ensureFeed(w, accountOf(SERVER, "user-2"))).toThrow(/another Kiwi account/);
        expect(() => importFeed(emptyWorkspace(), page([row()]), NOW)).toThrow(/Connect Kiwi/);
    });

    it("rejects a page Kiwi could not have sent", () => {
        expect(() => parseFeedPage({ account_id: "u", rows: [row({ seconds: 5 })], matters: [], next: null }, NOW)).toThrow(/invalid activity/);
        expect(() => parseFeedPage({ account_id: "u", rows: [row({ ended_at: iso(0) })], matters: [], next: null }, NOW)).toThrow(/invalid activity/);
        expect(() => parseFeedPage({ account_id: "u", rows: [row({ kind: "tab" as never })], matters: [], next: null }, NOW)).toThrow(/invalid activity/);
        expect(() => parseFeedPage({ account_id: "u", rows: [row({ ended_at: new Date(NOW + 120_000).toISOString(), started_at: new Date(NOW).toISOString(), seconds: 120 })], matters: [], next: null }, NOW)).toThrow(/invalid activity/);
        expect(() => parseFeedPage({ account_id: "u", rows: [], matters: [{ id: "x", name: " ", cm_number: null }], next: null }, NOW)).toThrow(/invalid matter/);
        expect(() => parseFeedPage({ rows: [] }, NOW)).toThrow(/invalid import page/);
        expect(parseFeedPage(page([row()]), NOW).rows).toHaveLength(1);
    });
});

describe("this computer's time wins an overlap", () => {
    it("subtracts a union of intervals, keeping the pieces", () => {
        const src = [{ startedAt: iso(0), endedAt: iso(600) }];
        expect(subtractIntervals(src, [{ startedAt: iso(200), endedAt: iso(300) }])).toEqual([{ startedAt: iso(0), endedAt: iso(200) }, { startedAt: iso(300), endedAt: iso(600) }]);
        expect(subtractIntervals(src, [{ startedAt: iso(0), endedAt: iso(600) }])).toEqual([]);
        expect(subtractIntervals(src, [{ startedAt: iso(599.5), endedAt: iso(900) }, { startedAt: iso(-10), endedAt: iso(599) }])).toEqual([]);
        expect(subtractIntervals(src, [{ startedAt: iso(700), endedAt: iso(900) }])).toEqual(src);
    });

    it("trims an imported row around captured activity, kept entries and the running timer", () => {
        const w = connected();
        w.activities.push(local({ startedAt: iso(0), endedAt: iso(300) })); // a call here while Chrome was in front
        w.entries.push({ id: "e1", description: "Manual", projectID: null, startedAt: iso(500), endedAt: iso(550), billable: false, hourlyRate: 0, source: "manual", activityID: null });
        w.timer = { description: "", projectID: null, startedAt: iso(3000), lastHeartbeat: iso(3000), billable: false, hourlyRate: 0 };
        importFeed(w, page([row(), row({ id: "seg-2", started_at: iso(2900), ended_at: iso(3300), seconds: 400 })]), NOW);
        const first = w.activities.find((a) => a.originRef === "seg-1")!;
        expect(first.sittings).toEqual([{ startedAt: iso(300), endedAt: iso(500) }, { startedAt: iso(550), endedAt: iso(600) }]);
        expect(first.startedAt).toBe(iso(300));
        const second = w.activities.find((a) => a.originRef === "seg-2")!;
        expect(second.sittings).toEqual([{ startedAt: iso(2900), endedAt: iso(3000) }]);
        validate(w);
    });

    it("dismisses a row this computer already covered, and says so on the receipt", () => {
        const w = connected();
        w.activities.push(local({ startedAt: iso(0), endedAt: iso(600) }));
        importFeed(w, page([row()]), NOW);
        expect(w.activities.find((a) => a.originRef === "seg-1")!.disposition).toBe("dismissed");
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("overlap");
    });

    it("re-checks before keeping: capture that arrived since trims or blocks the keep", () => {
        const w = connected();
        importFeed(w, page([row()]), NOW);
        const imported = w.activities[0];
        w.activities.push(local({ startedAt: iso(0), endedAt: iso(600) }));
        expect(() => keepStretch(w, [imported.id], { description: "x", projectID: null, billable: true }, NOW)).toThrow(/covered by other activity/);
        expect(w.activities.find((a) => a.id === imported.id)!.disposition).toBe("dismissed");
    });
});

describe("keeping imported time", () => {
    it("files the entry under the linked Kiwi matter with the clipped source intervals, and only Kiwi hears of them", () => {
        const w = connected();
        importFeed(w, page([row({ kiwi_project_id: ACME.id }), row({ id: "seg-2", started_at: iso(900), ended_at: iso(1200), seconds: 300, kiwi_project_id: ACME.id })]), NOW);
        const ids = w.activities.map((a) => a.id);
        const entry = keepStretch(w, ids, { description: "Reviewed the Acme contract", projectID: null, matter: "Acme Matter", billable: true, startedAt: iso(100), endedAt: iso(1200) }, NOW);
        expect(entry.sittings).toEqual([{ startedAt: iso(100), endedAt: iso(600) }, { startedAt: iso(900), endedAt: iso(1200) }]);
        expect(entry.sourceRefs).toEqual([
            { kind: "browser", id: "seg-1", account: ACCOUNT, intervals: [{ startedAt: iso(100), endedAt: iso(600) }] },
            { kind: "browser", id: "seg-2", account: ACCOUNT, intervals: [{ startedAt: iso(900), endedAt: iso(1200) }] },
        ]);
        const p = w.projects.find((p) => p.id === entry.projectID)!;
        expect(p).toMatchObject({ name: "Acme Matter", kiwiProjectID: ACME.id, kiwiAccount: ACCOUNT, matterNumber: "CM-100" });
        refreshReceipts(w);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("kept");
        validate(w);

        const kiwi = syncRequest(w, "0.10.0", "UTC", target("kiwi"));
        expect(kiwi.import_workspace_id).toBe(w.feed!.workspaceID);
        expect(kiwi.activities).toEqual([]); // imported evidence is Kiwi's own; it never goes back
        expect(kiwi.entries[0]).toMatchObject({ kiwi_project_id: ACME.id, project_name: "Acme Matter", source_refs: [{ kind: "browser", id: "seg-1", intervals: [{ startedAt: iso(100), endedAt: iso(600) }] }, { kind: "browser", id: "seg-2", intervals: [{ startedAt: iso(900), endedAt: iso(1200) }] }] });
        expect(kiwi.entries[0].source_refs![0]).not.toHaveProperty("account");
        // Batching keeps the workspace id on every batch (Kiwi refuses imported entries without it).
        expect(syncBatches(kiwi, 1).map((b) => b.import_workspace_id)).toEqual(Array(syncBatches(kiwi, 1).length).fill(w.feed!.workspaceID));
        const crm = syncRequest(w, "0.10.0", "UTC", target("crm"));
        expect(crm.entries[0]).not.toHaveProperty("kiwi_project_id");
        expect(crm.entries[0]).not.toHaveProperty("source_refs");

        deleteEntry(w, entry.id);
        refreshReceipts(w);
        expect(w.feed!.receipts["browser:seg-1"].disposition).toBe("pending");
    });

    it("never keeps Personal, and will not merge two Kiwi matters into one entry", () => {
        const w = connected();
        importFeed(w, page([row({ kiwi_project_id: ACME.id }), row({ id: "seg-2", started_at: iso(900), ended_at: iso(1200), seconds: 300, kiwi_project_id: BOLT.id })]), NOW);
        const ids = w.activities.map((a) => a.id);
        setMatter(w, ids, "Same name");
        for (const a of w.activities) a.kiwiProjectID = a.originRef === "seg-1" ? ACME.id : BOLT.id;
        expect(() => keepStretch(w, ids, { description: "x", projectID: null, matter: "Same name", billable: true }, NOW)).toThrow(/different Kiwi matters/);
        setMatter(w, [ids[0]], PERSONAL);
        expect(() => keepStretch(w, [ids[0]], { description: "x", projectID: null, matter: PERSONAL, billable: false }, NOW)).toThrow(/not kept/);
        expect(w.activities[0].kiwiProjectID).toBeUndefined(); // a person's choice drops the Kiwi link
    });
});

describe("placing imported time on a matter", () => {
    it("matches by Kiwi id, then matter number, then name, then alias — never ambiguously", () => {
        const w = connected();
        const byID = projectNamed(w, "Whatever"); byID.kiwiProjectID = ACME.id; byID.kiwiAccount = ACCOUNT;
        expect(matchingProject(w, ACME)).toBe(byID);
        const w2 = connected();
        const byNumber = projectNamed(w2, "Acme Logistics"); byNumber.matterNumber = "CM-100";
        expect(matchingProject(w2, ACME)).toBe(byNumber);
        const w3 = connected();
        const byName = projectNamed(w3, "acme matter");
        expect(matchingProject(w3, ACME)).toBe(byName);
        const w4 = connected();
        const byAlias = projectNamed(w4, "Acme Logistics"); byAlias.aliases = ["Acme Matter"];
        expect(matchingProject(w4, ACME)).toBe(byAlias);
        projectNamed(w4, "Acme Freight").aliases = ["acme matter"];
        expect(matchingProject(w4, ACME)).toBeUndefined();
        const w5 = connected();
        projectNamed(w5, "Acme Matter").kiwiProjectID = BOLT.id; // the same name, already another matter
        expect(matchingProject(w5, ACME)).toBeUndefined();
        expect(matchingProject(connected(), ACME)).toBeUndefined();
    });

    it("imports under the local project when one matches, else under Kiwi's name, and the inbox groups by identity", () => {
        const w = connected();
        const logistics = projectNamed(w, "Acme Logistics"); logistics.matterNumber = "CM-100";
        importFeed(w, page([row({ kiwi_project_id: ACME.id }), row({ id: "chat-1", kind: "chat", app: "Kiwi", title: "Bolt", url: undefined, started_at: iso(700), ended_at: iso(900), seconds: 200, kiwi_project_id: BOLT.id })]), NOW);
        expect(w.activities[0]).toMatchObject({ matter: "Acme Logistics", projectID: logistics.id, kiwiProjectID: ACME.id });
        expect(logistics.kiwiProjectID).toBe(ACME.id);
        expect(w.activities[1]).toMatchObject({ matter: "Bolt Holdings", kiwiProjectID: BOLT.id });
        expect(w.activities[1].projectID).toBeUndefined();
        expect(w.projects.map((p) => p.name)).toEqual(["Acme Logistics"]); // no matter made silently
        w.activities.push(local({ matter: "Acme Logistics", matterBy: "ai", startedAt: iso(1000), endedAt: iso(1300) }));
        // The local row carries only the name; the imported row ties that name to Kiwi's id, so they are one group.
        expect(inboxOf(w.activities).groups.map((g) => [g.matter, g.activityIDs.length, g.kiwiProjectID])).toEqual([["Bolt Holdings", 1, BOLT.id], ["Acme Logistics", 2, ACME.id]]);
        // A row the model named with the imported row's name joins it, id or not.
        w.activities.push(local({ matter: "Bolt Holdings", matterBy: "ai", startedAt: iso(1400), endedAt: iso(1700) }));
        expect(inboxOf(w.activities).groups.map((g) => [g.matter, g.activityIDs.length, g.kiwiProjectID])).toEqual([["Bolt Holdings", 2, BOLT.id], ["Acme Logistics", 2, ACME.id]]);
    });

    it("stamps the Kiwi id when the model names a Kiwi matter, so a keep links the project", () => {
        const w = connected();
        w.feed!.matters = [ACME, BOLT];
        w.activities.push(local({ id: "d1", title: "Acme supply agreement.docx" }));
        applyMatters(w, ["d1"], { assignments: [{ activity_id: "d1", matter: "acme matter" }] });
        expect(w.activities[0]).toMatchObject({ matter: "acme matter", matterBy: "ai", kiwiProjectID: ACME.id });
        const entry = keepStretch(w, ["d1"], { description: "Reviewed", projectID: null, matter: "acme matter", billable: true }, NOW);
        expect(w.projects.find((p) => p.id === entry.projectID)).toMatchObject({ kiwiProjectID: ACME.id, matterNumber: "CM-100" });
        expect(syncRequest(w, "0.10.0", "UTC", target("kiwi")).entries[0].kiwi_project_id).toBe(ACME.id);
    });
});

describe("joining a local matter to Kiwi's", () => {
    function named(): Workspace {
        const w = connected();
        w.feed!.matters = [ACME, BOLT];
        projectNamed(w, "Acme Logistics");
        w.activities.push(local({ id: "a1", matter: "Acme Logistics", matterBy: "ai" }), local({ id: "a2", matter: "Acme Logistics", matterBy: "ai", startedAt: iso(700), endedAt: iso(900) }), local({ id: "a3", matter: "Bolt", matterBy: "ai", startedAt: iso(1000), endedAt: iso(1100) }));
        return w;
    }

    it("asks about unlinked matters and names on activity, with past decisions as examples", () => {
        const w = named();
        const req = joinRequest(w)!;
        expect(req.local_matters.map((p) => p.name)).toEqual(["Acme Logistics", "Bolt"]);
        expect(req.local_matters[1].id).toBe("name:Bolt");
        expect(req.kiwi_matters).toEqual([ACME, BOLT]);
        expect(joinRequest(connected())).toBeNull();
    });

    it("joins at high confidence: the model's name gives way to Kiwi's, kept as an alias, and the time moves", () => {
        const w = named();
        const req = joinRequest(w)!;
        const logistics = w.projects[0];
        applyJoins(w, req, { joins: [{ local_id: logistics.id, kiwi_project_id: ACME.id, confidence: "high", reason: "same caption" }, { local_id: "name:Bolt", kiwi_project_id: BOLT.id, confidence: "medium", reason: "shares a word" }, { local_id: "bogus", kiwi_project_id: ACME.id, confidence: "high", reason: "" }] });
        expect(logistics).toMatchObject({ name: "Acme Matter", nameBy: "kiwi", aliases: ["Acme Logistics"], kiwiProjectID: ACME.id, kiwiAccount: ACCOUNT, matterNumber: "CM-100" });
        expect(w.activities.find((a) => a.id === "a1")).toMatchObject({ matter: "Acme Matter", projectID: logistics.id, kiwiProjectID: ACME.id });
        expect(w.activities.find((a) => a.id === "a2")).toMatchObject({ matter: "Acme Matter", projectID: logistics.id, kiwiProjectID: ACME.id });
        expect(w.feed!.joins.map((j) => [j.local_id, j.status])).toEqual([[logistics.id, "joined"], ["name:Bolt", undefined]]);
        expect(w.activities.find((a) => a.id === "a3")!.kiwiProjectID).toBeUndefined(); // medium waits for a person
        validate(w);

        undoJoin(w, logistics.id);
        expect(logistics).toMatchObject({ name: "Acme Logistics" });
        expect(logistics.kiwiProjectID).toBeUndefined();
        expect(w.activities.find((a) => a.id === "a1")).toMatchObject({ matter: "Acme Logistics" });
        expect(w.activities.find((a) => a.id === "a1")!.kiwiProjectID).toBeUndefined();
        expect(w.feed!.joins[0].status).toBe("declined");
        expect(joinRequest(w)).toBeNull(); // not asked again
    });

    it("keeps a person's name on a high-confidence join, and links by hand at any confidence", () => {
        const w = named();
        const logistics = w.projects[0];
        updateProject(w, logistics.id, { name: "Acme (ours)" });
        applyJoins(w, joinRequest(w)!, { joins: [{ local_id: logistics.id, kiwi_project_id: ACME.id, confidence: "high", reason: "" }] });
        expect(logistics).toMatchObject({ name: "Acme (ours)", nameBy: "person", kiwiProjectID: ACME.id });
        expect(logistics.aliases).toBeUndefined();
        expect(w.activities.find((a) => a.id === "a1")).toMatchObject({ matter: "Acme (ours)", kiwiProjectID: ACME.id });

        // A name a person put on a row is a person's name too: the matter links, the name stays.
        const w2 = named();
        w2.activities.find((a) => a.id === "a2")!.matterBy = "person";
        applyJoins(w2, joinRequest(w2)!, { joins: [{ local_id: w2.projects[0].id, kiwi_project_id: ACME.id, confidence: "high", reason: "" }] });
        expect(w2.projects[0]).toMatchObject({ name: "Acme Logistics", kiwiProjectID: ACME.id });
        expect(w2.activities.find((a) => a.id === "a2")).toMatchObject({ matter: "Acme Logistics", kiwiProjectID: ACME.id });

        joinMatter(w, "name:Bolt", BOLT.id);
        const bolt = w.projects.find((p) => p.name === "Bolt Holdings")!;
        expect(bolt).toMatchObject({ aliases: ["Bolt"], kiwiProjectID: BOLT.id });
        expect(w.activities.find((a) => a.id === "a3")).toMatchObject({ matter: "Bolt Holdings", projectID: bolt.id, kiwiProjectID: BOLT.id });
        expect(() => joinMatter(w, logistics.id, BOLT.id)).toThrow(/already linked/);
        expect(() => joinMatter(w, "name:Nope", "no-such-matter")).toThrow(WorkspaceError);
    });

    it("merging carries the link and the old name; two different Kiwi matters never merge", () => {
        const w = named();
        const logistics = w.projects[0];
        joinMatter(w, logistics.id, ACME.id);
        const other = projectNamed(w, "Acme Freight");
        mergeProjects(w, other.id, logistics.id);
        expect(logistics.aliases).toEqual(["Acme Logistics", "Acme Freight"]);
        const bolt = projectNamed(w, "Bolt Holdings"); bolt.kiwiProjectID = BOLT.id; bolt.kiwiAccount = ACCOUNT;
        expect(() => mergeProjects(w, bolt.id, logistics.id)).toThrow(/different Kiwi matters/);
    });
});
