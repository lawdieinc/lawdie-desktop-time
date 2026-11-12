import { describe, expect, it } from "vitest";
import { draftRequest, matterRequest } from "./matters";
import { capturedWhy, emptyWorkspace, PERSONAL, syncRequest, validate, type Activity, type SyncTarget, type Workspace } from "./model";
import { applySummaries, itemSummaries, SUMMARY_BATCH, SUMMARY_IMAGES, summaryRequest, summaryShot } from "./summaries";

const EPOCH = 1_780_000_000_000;
const at = (s: number) => EPOCH + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
let n = 0;
const ID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const shot = (id: string, s: number) => `${id}-${at(s)}.jpg`;
const activity = (over: Partial<Activity> = {}): Activity => ({ id: ID(), app: "Word", ownerID: "com.microsoft.Word", title: "Lease v3.docx", startedAt: iso(0), endedAt: iso(600), endedBy: "switched", disposition: "pending", ...over });
const target: SyncTarget = { product: "kiwi", serverURL: "https://lawdie.co/kiwi-api", deviceID: "d1", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] };

function workspace(activities: Activity[], screenshots = true): Workspace {
    const w = emptyWorkspace();
    w.preferences.captureScreenshots = screenshots;
    w.activities = activities;
    return w;
}

describe("which sittings are summarised", () => {
    it("asks about finished, pending work of a minute or more, newest first, never Personal, reviewed or already summarised", () => {
        const later = activity({ startedAt: iso(1000), endedAt: iso(1600) });
        const first = activity();
        const w = workspace([
            later, first,
            activity({ endedAt: iso(30) }),
            activity({ disposition: "kept" }),
            activity({ disposition: "dismissed" }),
            activity({ matter: PERSONAL, matterBy: "person" }),
            activity({ summary: { text: "Revised the lease", source: "kiwi" } }),
            activity({ title: null }),
        ], false);
        const r = summaryRequest(w)!;
        expect(r.ids).toEqual([later.id, first.id]);
        expect(r.body.sittings[1]).toMatchObject({ id: first.id, app: "Word", title: "Lease v3.docx", seconds: 600, matter: null });
        expect(r.shots).toEqual({});
        expect(summaryRequest(w, new Set(r.ids))).toBeNull();
    });

    it("sends a sitting with no text when it has a screenshot (titles off)", () => {
        const a = activity({ title: null });
        a.screenshots = [shot(a.id, 30)];
        const w = workspace([a]);
        expect(summaryRequest(w)?.shots).toEqual({ [a.id]: shot(a.id, 30) });
        w.preferences.captureScreenshots = false;
        expect(summaryRequest(w)).toBeNull();
    });

    it("picks the screenshot nearest the middle of the sitting", () => {
        const a = activity();
        a.screenshots = [shot(a.id, 20), shot(a.id, 320), shot(a.id, 590)];
        expect(summaryShot(workspace([a]), a)).toBe(shot(a.id, 320));
    });

    it("never sends a screenshot of a browser, an excluded app, a call or imported time", () => {
        const browser = activity({ app: "Chrome", ownerID: "com.google.Chrome" });
        const secret = activity({ app: "Signal", ownerID: "org.whispersystems.signal-desktop" });
        const call = activity({ app: "Zoom", ownerID: "us.zoom.xos" });
        const imported = activity({ origin: "kiwi", originRef: "x", sourceKind: "chat" });
        const all = [browser, secret, call, imported];
        for (const a of all) a.screenshots = [shot(a.id, 300)];
        const w = workspace(all);
        w.preferences.excludedOwnerIDs = ["org.whispersystems.signal-desktop"];
        for (const a of all) expect(summaryShot(w, a)).toBeNull();
        expect(Object.keys(summaryRequest(w)?.shots ?? {})).toEqual([]);
    });

    it("sends at most a batch, and at most SUMMARY_IMAGES screenshots in it", () => {
        const many = Array.from({ length: SUMMARY_BATCH + 5 }, (_, k) => { const a = activity({ startedAt: iso(k * 1000), endedAt: iso(k * 1000 + 600) }); a.screenshots = [shot(a.id, k * 1000 + 300)]; return a; });
        const r = summaryRequest(workspace(many))!;
        expect(r.ids).toHaveLength(SUMMARY_BATCH);
        expect(Object.keys(r.shots)).toHaveLength(SUMMARY_IMAGES);
    });
});

describe("the answer", () => {
    it("puts each line on its sitting, redacted and bounded, and records a screenshot was read", () => {
        const a = activity(); const b = activity(); const c = activity();
        a.screenshots = [shot(a.id, 300)];
        const w = workspace([a, b, c]);
        const r = summaryRequest(w)!;
        b.disposition = "kept"; // kept meanwhile
        const done = applySummaries(w, r, { summaries: [
            { id: a.id, text: "  Revised  indemnity clause in Smith lease, card 4111 1111 1111 1111.  " },
            { id: b.id, text: "Kept meanwhile" },
            { id: "not-asked", text: "Nope" },
            { id: c.id, text: "" },
            { id: a.id, text: "A second answer" },
            "junk",
        ] });
        expect(done).toEqual([a.id]);
        expect(a.summary).toEqual({ text: "Revised indemnity clause in Smith lease, card [card]", source: "kiwi", screenshot: true });
        expect(b.summary).toBeUndefined();
        expect(c.summary).toBeUndefined();
        expect(() => validate(w)).not.toThrow();
        expect(applySummaries(w, r, { nope: 1 })).toEqual([]);
        expect(applySummaries(w, r, null)).toEqual([]);
    });

    it("an item of several sittings lists each distinct line once, in order", () => {
        const items = [
            { startedAt: iso(600), summary: { text: "Revised the lease", source: "kiwi" as const } },
            { startedAt: iso(0), summary: { text: "Read the client's email", source: "kiwi" as const } },
            { startedAt: iso(900), summary: { text: "revised the lease", source: "kiwi" as const } },
            { startedAt: iso(1200) },
        ];
        expect(itemSummaries(items)).toEqual(["Read the client's email", "Revised the lease"]);
    });

    it("a bad summary fails validation", () => {
        const w = workspace([activity({ summary: { text: "", source: "kiwi" } })]);
        expect(() => validate(w)).toThrow();
        w.activities[0].summary = { text: "x".repeat(201), source: "kiwi" };
        expect(() => validate(w)).toThrow();
    });
});

describe("where a summary goes", () => {
    it("feeds the matter and draft requests, and makes a sitting with only a summary readable", () => {
        const a = activity({ title: null, summary: { text: "Marked up the Smith lease", source: "kiwi", screenshot: true } });
        const w = workspace([a]);
        expect(matterRequest(w)?.body.activities[0]).toMatchObject({ id: a.id, summary: "Marked up the Smith lease" });
        expect(draftRequest(w)?.body.groups[0].activities[0]).toMatchObject({ summary: "Marked up the Smith lease" });
    });

    it("is evidence at keep, and never synced", () => {
        const a = activity({ summary: { text: "Marked up the Smith lease", source: "kiwi" } });
        const why = capturedWhy([a], at(0), at(600), undefined);
        expect(why.work[0].summary).toBe("Marked up the Smith lease");
        expect(why.evidence[a.id].facts?.[0]).toBe("Marked up the Smith lease");
        const w = workspace([a]);
        w.sync = { autoSync: true, targets: [target] };
        expect(JSON.stringify(syncRequest(w, "1", null, target))).not.toContain("Smith lease");
    });
});
