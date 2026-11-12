import { describe, expect, it } from "vitest";
import { PERSONAL, emptyWorkspace, keepStretch, seconds, validate, type Activity, type Project, type TimeEntry, type Workspace } from "./model";
import { accountOf, ensureFeed } from "./feed";
import { inboxOf, matterStretch } from "./matters";
import { tutorialStretch } from "./onboarding";
import type { Rule, RuleSet } from "./rules";
import { APPROVE_MAX_ROWS, approveCheck, approveRows, approveSummary, billedHours, inboxRowOf, keepPreview, keepStart, type ApproveReport, type ApproveVerdict } from "./keep";

// Approve keeps a review row as the Keep sheet would with nothing changed (src/shared/keep.ts).

const T0 = new Date(2026, 10, 10, 9, 0, 0).getTime(); // a Tuesday morning, local time
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const NOW = T0 + 8 * 3_600_000;
const DRAFT = "Review and revise the Acme lease amendment regarding the rent escalation clause";

const act = (id: string, from: number, to: number, over: Partial<Activity> = {}): Activity => ({ id, app: "Microsoft Word", ownerID: "com.microsoft.Word", title: "Lease amendment.docx", startedAt: at(from), endedAt: at(to), endedBy: "switched", disposition: "pending", ...over });
const acme = (over: Partial<Project> = {}): Project => ({ id: "p-acme", name: "Acme lease", client: "", color: "gold", hourlyRate: 450, archived: false, ...over });
const rule = (id: string, check: string, params: Record<string, unknown> = {}): Rule => ({ id, clause: "§3", title: id, text: "", check, params, source: "guidelines", sourceRef: null, approvedAt: null, atEntry: true });
const book = (rules: Rule[]): RuleSet => ({ client: "Halvorsen", clientId: "halvorsen", matter: null, guidelines: "Halvorsen Billing Guidelines", version: "1", exportedAt: at(0), rules });
const kept = (id: string, from: number, to: number, over: Partial<TimeEntry> = {}): TimeEntry => ({ id, description: "Earlier work", projectID: null, startedAt: at(from), endedAt: at(to), billable: true, hourlyRate: 0, source: "manual", activityID: null, ...over });

/** A matter's day with Kiwi's draft: two sittings in Word, 20 and 10 minutes, half an hour apart. */
function drafted(): Workspace {
    const w = emptyWorkspace();
    w.projects.push(acme());
    w.activities.push(
        act("a1", 0, 20, { matter: "Acme lease", matterBy: "ai", draft: { text: DRAFT, source: "kiwi" } }),
        act("a2", 50, 60, { matter: "Acme lease", matterBy: "ai" }),
    );
    return validate(w);
}
/** The same day under a client's rules. */
function underRules(rules: Rule[]): Workspace {
    const w = drafted();
    w.projects[0].client = "Halvorsen";
    w.projects[0].matterNumber = "2026-014";
    w.rulebooks = [book(rules)];
    return validate(w);
}
const rowOf = (w: Workspace, ids: string[]) => { const r = inboxRowOf(w, ids); if (!r) throw new Error("no such row"); return r; };
const verdict = (w: Workspace, ids: string[]): ApproveVerdict => { const r = rowOf(w, ids); return approveCheck(w, r.stretch, r.sittings, r.matter, NOW); };
const refusal = (v: ApproveVerdict) => { if (v.ok) throw new Error("expected a refusal"); return v; };

describe("the Keep sheet's state", () => {
    it("opens on the row's matter, draft and captured times, and sends them unchanged", () => {
        const w = drafted();
        const r = rowOf(w, ["a1", "a2"]);
        const start = keepStart(w, r.stretch, r.sittings, r.matter, "ignored");
        expect(start).toMatchObject({ matter: "Acme lease", description: DRAFT, billable: true, leaveOutIdle: false, hoursSet: null, rate: null, codes: {} });
        const p = keepPreview(w, r.stretch, r.sittings, start, start.single);
        expect(p.input).toEqual({ description: DRAFT, projectID: null, matter: "Acme lease", billable: true, drafted: "kiwi" });
        expect(p).toMatchObject({ changed: false, missingTime: false, imported: false, hourlyRate: 450, findings: [], asDrafted: true, drafted: "kiwi" });
        expect(p.project?.id).toBe("p-acme");
    });

    it("a person's own description records no draft; one equal to the draft does", () => {
        const w = drafted();
        const r = rowOf(w, ["a1", "a2"]);
        const start = keepStart(w, r.stretch, r.sittings, r.matter, "");
        const own = keepPreview(w, r.stretch, r.sittings, { ...start, description: "Negotiate the rent escalation clause with the landlord's counsel" }, start.single);
        expect(own.asDrafted).toBe(false);
        expect(own.input.drafted).toBeUndefined();
        expect(keepPreview(w, r.stretch, r.sittings, { ...start, description: ` ${DRAFT} ` }, start.single).input.drafted).toBe("kiwi");
        // Written in review with the pencil: the description is the person's and the sheet starts from it.
        w.activities[1].description = "Mark up the amendment for the client";
        const again = rowOf(w, ["a1", "a2"]);
        const mine = keepStart(w, again.stretch, again.sittings, again.matter, "");
        expect(mine.description).toBe("Mark up the amendment for the client");
        expect(keepPreview(w, again.stretch, again.sittings, mine, mine.single).input.drafted).toBeUndefined();
    });

    it("bills captured time in tenths, rounded up, and never the gaps between sittings", () => {
        expect([30, 360, 420, 3660].map(billedHours)).toEqual([0.1, 0.1, 0.2, 1.1]);
        const w = drafted();
        const r = rowOf(w, ["a1", "a2"]);
        const start = keepStart(w, r.stretch, r.sittings, r.matter, "");
        const p = keepPreview(w, r.stretch, r.sittings, start, start.single);
        expect(p.previewSeconds).toBe(30 * 60); // 20 + 10 minutes, not the hour between 9:00 and 10:00
        expect(p.hours).toBe(0.5);
        expect(p.preview?.sittings).toHaveLength(2);
    });

    it("under a client rulebook the input carries hours, codes and the rate", () => {
        const w = underRules([rule("H-1", "time_increment")]);
        const v = verdict(w, ["a1", "a2"]);
        expect(v).toMatchObject({ ok: true, hours: 0.5, label: DRAFT });
        if (!v.ok) return;
        expect(v.input).toMatchObject({ description: DRAFT, matter: "Acme lease", billable: true, drafted: "kiwi", hours: 0.5, hourlyRate: 450 });
        expect(v.input.taskCode).toMatch(/^[A-Z]\d{3}$/);
        expect(v.input.activityCode).toMatch(/^A\d{3}$/);
        expect(v.input.startedAt).toBeUndefined();
    });
});

describe("Approve on one row", () => {
    it("sends a row the client's rules flag to the Keep sheet", () => {
        const w = underRules([rule("H-2", "vague_narrative")]);
        for (const a of w.activities) a.description = "Review";
        const v = refusal(verdict(w, ["a1", "a2"]));
        expect(v).toMatchObject({ reason: "rules", opensSheet: true });
        expect(v.message).toBe("Halvorsen's rules flag this entry: \"Review\" does not say what was done, on what, or why.");
    });

    it("sends a block-billed draft over two captured tasks to the Keep sheet, where the split is", () => {
        const w = underRules([rule("H-3", "block_billing", { separators: ";" })]);
        w.activities.push(act("a3", 70, 90, { app: "Microsoft Outlook", ownerID: "com.microsoft.Outlook", title: "Re: rent escalation - Outlook", matter: "Acme lease", matterBy: "ai" }));
        w.activities[0].draft = { text: "Review lease amendment; emails with landlord's counsel regarding rent escalation", source: "kiwi" };
        const r = rowOf(w, ["a1", "a2", "a3"]);
        const v = refusal(approveCheck(w, r.stretch, r.sittings, r.matter, NOW));
        expect(v).toMatchObject({ reason: "rules", opensSheet: true });
        expect(v.message).toContain("Lists 2 tasks in one entry.");
        const start = keepStart(w, r.stretch, r.sittings, r.matter, "");
        const p = keepPreview(w, r.stretch, r.sittings, start, start.single);
        expect(p.plan).toHaveLength(2);
        expect(p.findings[0].fixes[0]).toMatchObject({ split: true });
    });

    it("is disabled, with the reason, when something on the row must change first", () => {
        const none = drafted();
        none.activities[0].draft = null;
        expect(refusal(verdict(none, ["a1", "a2"]))).toMatchObject({ reason: "no-description", opensSheet: false });

        const personal = drafted();
        for (const a of personal.activities) a.matter = PERSONAL;
        expect(refusal(verdict(personal, ["a1", "a2"]))).toMatchObject({ reason: "personal", opensSheet: false, message: "Personal time is never kept." });

        const loose = drafted();
        for (const a of loose.activities) { delete a.matter; delete a.matterBy; }
        const st = inboxOf(loose.activities).stretches[0];
        expect(refusal(approveCheck(loose, st, loose.activities, null, NOW))).toMatchObject({ reason: "no-matter", opensSheet: false });

        const asked = drafted();
        keepStretch(asked, ["a1"], { description: "Review lease", projectID: null, matter: "Acme lease", billable: true }, NOW);
        asked.activities[1].draft = { text: DRAFT, source: "kiwi" };
        expect(refusal(verdict(asked, ["a2"]))).toMatchObject({ reason: "merge-question", opensSheet: false });

        const sample = tutorialStretch(NOW);
        expect(refusal(approveCheck(drafted(), sample.stretch, sample.sittings, sample.sittings[0].matter ?? null, NOW))).toMatchObject({ reason: "tutorial", opensSheet: false });

        const running = drafted();
        running.currentActivity = act("now", 100, 110, { matter: "Acme lease", draft: { text: DRAFT, source: "kiwi" } });
        const current = { ...matterStretch(inboxOf(running.activities).groups[0]), activityIDs: ["now"] };
        expect(refusal(approveCheck(running, current, [running.currentActivity], "Acme lease", NOW))).toMatchObject({ reason: "in-progress", opensSheet: false });

        const gone = drafted();
        const row = rowOf(gone, ["a1", "a2"]);
        gone.activities[1].disposition = "dismissed";
        expect(refusal(approveCheck(gone, row.stretch, row.sittings, row.matter, NOW))).toMatchObject({ reason: "reviewed", opensSheet: false });
    });

    it("opens the sheet when the time overlaps a kept entry or the timer is running", () => {
        const w = drafted();
        w.entries.push(kept("e1", 10, 15));
        expect(refusal(verdict(w, ["a1", "a2"]))).toMatchObject({ reason: "overlap", opensSheet: true });
        // An entry in the gap between the two sittings is no overlap: only the sittings count.
        const gap = drafted();
        gap.entries.push(kept("e1", 25, 45));
        expect(verdict(gap, ["a1", "a2"]).ok).toBe(true);
        const timed = drafted();
        timed.timer = { description: "", projectID: null, startedAt: at(55), lastHeartbeat: at(58), billable: true, hourlyRate: 0 };
        expect(refusal(verdict(timed, ["a1", "a2"]))).toMatchObject({ reason: "overlap", opensSheet: true });
    });

    it("opens the sheet when imported time has been covered since it came in", () => {
        const w = drafted();
        ensureFeed(w, accountOf("https://lawdie.co/kiwi-api", "user-1"));
        w.activities = [act("i1", 0, 20, { app: "Chrome", ownerID: "import:browser", origin: "browser", originRef: "seg-1", originAccount: w.feed!.account, sourceKind: "browser", endedBy: "imported", matter: "Acme lease", matterBy: "ai", draft: { text: DRAFT, source: "kiwi" } })];
        expect(verdict(w, ["i1"]).ok).toBe(true);
        // This computer's own time now covers five of its minutes.
        w.activities.push(act("local", 5, 10, { disposition: "dismissed" }));
        expect(refusal(verdict(w, ["i1"]))).toMatchObject({ reason: "imported-overlap", opensSheet: true });
    });
});

describe("approving several rows", () => {
    /** Three rows: Acme (fine), Bolt (its time already kept), Personal. */
    function three(): Workspace {
        const w = drafted();
        w.activities.push(
            act("b1", 120, 150, { title: "Bolt term sheet.docx", matter: "Bolt Holdings", matterBy: "ai", draft: { text: "Draft the Bolt Holdings term sheet for the Series B round", source: "kiwi" } }),
            act("c1", 200, 230, { app: "Safari", ownerID: "com.apple.mail", title: "Football pool", matter: PERSONAL, matterBy: "ai", draft: { text: "Football pool", source: "kiwi" } }),
        );
        w.entries.push(kept("e-bolt", 125, 140));
        return validate(w);
    }

    it("keeps each row on its own: one that cannot be kept never stops the others", () => {
        const w = three();
        const r = approveRows(w, [["c1"], ["b1"], ["a1", "a2"]], NOW);
        expect(r.kept).toHaveLength(1);
        expect(r.kept[0]).toMatchObject({ activityIDs: ["a1", "a2"], label: DRAFT, hours: 0.5 });
        expect(r.skipped.map((x) => [x.activityIDs[0], x.reason])).toEqual([["b1", "overlap"], ["c1", "personal"]]);
        expect(w.entries.map((e) => e.id)).toEqual(expect.arrayContaining(["e-bolt", r.kept[0].entryID]));
        expect(w.entries).toHaveLength(2);
        // Nothing of the skipped rows was touched: no project for Bolt, both still pending.
        expect(w.projects.map((p) => p.name)).toEqual(["Acme lease"]);
        expect(w.activities.filter((a) => a.disposition === "pending").map((a) => a.id)).toEqual(["b1", "c1"]);
        validate(w);
    });

    it("leaves the workspace exactly as it was when a keep is refused", () => {
        const w = drafted();
        w.projects.push(acme({ id: "p-acme-2" })); // two open matters of one name: the keep refuses to choose
        const before = structuredClone(w);
        const r = approveRows(w, [["a1", "a2"]], NOW);
        expect(r.kept).toEqual([]);
        expect(r.skipped[0]).toMatchObject({ reason: "refused", message: "More than one matter has this name. Choose its linked matter." });
        expect(w).toEqual(before);
    });

    it("skips a row that changed since it was shown, and ids sent twice", () => {
        const w = three();
        w.activities.find((a) => a.id === "a2")!.disposition = "dismissed";
        const r = approveRows(w, [["a1", "a2"], ["b1"], ["b1"], [], ["nope"]], NOW);
        expect(r.kept).toEqual([]);
        expect(r.skipped.map((x) => [x.activityIDs.join(), x.reason])).toEqual([["a1,a2", "changed"], ["b1", "changed"], ["nope", "changed"], ["b1", "overlap"]]);
        expect(r.skipped[0]).toMatchObject({ label: DRAFT, message: "This row changed since it was shown. Review it again." });
        expect(w.entries).toHaveLength(1);
    });

    it("a later row sees the entries kept before it in the same approval", () => {
        const emails = (mergeKey?: string): Workspace => {
            const w = emptyWorkspace();
            w.projects.push(acme({ client: "Halvorsen" }));
            w.rulebooks = [book([rule("H-4", "merge_short_emails", { max_hrs: 0.1 })])];
            const mail = { app: "Microsoft Outlook", ownerID: "com.microsoft.Outlook", title: "Re: lease - Outlook", matter: "Acme lease", matterBy: "ai" as const, draft: { text: "Emails with landlord's counsel regarding the lease amendment", source: "kiwi" as const } };
            // Two rows on one matter and day: the second is tied to the project, so the inbox lists it apart.
            w.activities.push(act("m1", 0, 4, mail), act("m2", 60, 64, { ...mail, projectID: "p-acme", ...(mergeKey ? { mergeKey } : {}) }));
            return validate(w);
        };
        // Each alone is fine.
        expect(verdict(emails("x"), ["m2"]).ok).toBe(true);
        // Together, the later one meets the first as a kept entry: the client wants one email entry a day.
        const w = emails("x");
        const r = approveRows(w, [["m2"], ["m1"]], NOW);
        expect(r.kept.map((k) => k.activityIDs)).toEqual([["m1"]]);
        expect(r.skipped[0]).toMatchObject({ activityIDs: ["m2"], reason: "rules", message: "Halvorsen's rules flag this entry: Emails of 0.1 h or less are billed as one entry for the day." });
        expect(w.entries).toHaveLength(1);
        // Without the merge already answered, the later row is asked whether it is more of the entry just kept.
        const asked = approveRows(emails(), [["m1"], ["m2"]], NOW);
        expect(asked.kept).toHaveLength(1);
        expect(asked.skipped[0]).toMatchObject({ activityIDs: ["m2"], reason: "merge-question" });
    });

    it("keeps what the Keep sheet keeps", () => {
        const viaSheet = drafted();
        viaSheet.projects = [];
        const viaApprove = structuredClone(viaSheet);
        const row = rowOf(viaSheet, ["a1", "a2"]);
        const start = keepStart(viaSheet, row.stretch, row.sittings, row.matter, "");
        const sheet = keepStretch(viaSheet, row.stretch.activityIDs, keepPreview(viaSheet, row.stretch, row.sittings, start, start.single).input, NOW);

        const r = approveRows(viaApprove, [["a2", "a1"]], NOW);
        const entry = viaApprove.entries.find((e) => e.id === r.kept[0].entryID)!;
        const shape = (e: TimeEntry) => ({ ...e, id: "", projectID: "", sources: e.sources?.length, work: e.work?.length, parts: e.parts?.map((p) => p.text) });
        expect(shape(entry)).toEqual(shape(sheet));
        // The captured bounds and sittings exactly, the draft as offered, the matter's project made by name.
        expect(entry).toMatchObject({ description: DRAFT, startedAt: at(0), endedAt: at(60), sittings: [{ startedAt: at(0), endedAt: at(20) }, { startedAt: at(50), endedAt: at(60) }], billable: true, drafted: "kiwi", source: "desktop", activityID: "a1", activityIDs: ["a1", "a2"] });
        expect(seconds(entry)).toBe(30 * 60);
        expect(entry.hours).toBeUndefined();
        expect(viaApprove.projects.map((p) => [p.id === entry.projectID, p.name])).toEqual([[true, "Acme lease"]]);
        // Approving accepts the suggested matter: it is the person's from then on.
        expect(viaApprove.activities.map((a) => [a.disposition, a.matter, a.matterBy])).toEqual([["kept", "Acme lease", "person"], ["kept", "Acme lease", "person"]]);
        // Reviewed when approved, so retention counts from now (Workstream A).
        expect(viaApprove.activities.every((a) => typeof a.reviewedAt === "string")).toBe(true);
        validate(viaApprove);
    });

    it("takes at most 200 rows, quickly", () => {
        const w = emptyWorkspace();
        // 260 days, a matter a day, each a row of three sittings.
        for (let d = 0; d < 260; d += 1) for (let n = 0; n < 3; n += 1) w.activities.push(act(`d${d}-${n}`, -d * 1440 + n * 30, -d * 1440 + n * 30 + 20, { matter: `Matter ${d}`, matterBy: "person", ...(n === 0 ? { draft: { text: `Review the documents produced on day ${d} of the matter`, source: "kiwi" } } : {})}));
        const rows = inboxOf(w.activities).groups.map((g) => g.activityIDs);
        expect(rows).toHaveLength(260);
        const began = Date.now();
        const r = approveRows(w, rows, NOW);
        const took = Date.now() - began;
        // The first 200 sent are taken; the rest are not looked at.
        expect(r.kept).toHaveLength(APPROVE_MAX_ROWS);
        expect(r.skipped).toEqual([]);
        expect(w.entries).toHaveLength(APPROVE_MAX_ROWS);
        if (process.env.KEEP_TIMING) console.log("approveRows: 200 rows of 780 activities in", took, "ms");
        expect(took).toBeLessThan(5000);
    });
});

describe("the approval's summary", () => {
    it("says what was kept, names the first three that were not, and counts the rest", () => {
        const skip = (label: string, reason: ApproveReport["skipped"][number]["reason"], message = ""): ApproveReport["skipped"][number] => ({ activityIDs: [label], label, reason, message });
        const keptRow = (hours: number): ApproveReport["kept"][number] => ({ activityIDs: ["x"], entryID: "e", label: "Kept", hours });
        expect(approveSummary({ kept: [keptRow(0.5), keptRow(0.7), keptRow(0.2)], skipped: [] })).toBe("Kept 3 entries, 1.4 hr.");
        expect(approveSummary({ kept: [keptRow(0.5)], skipped: [] })).toBe("Kept 1 entry, 0.5 hr.");
        expect(approveSummary({
            kept: [keptRow(0.5), keptRow(0.9)],
            skipped: [skip("Bolt term sheet", "overlap"), skip("Review", "rules", "Halvorsen's rules flag this entry: \"Review\" does not say what was done."), skip("Football pool", "personal"), skip("Fourth", "no-matter"), skip("Fifth", "changed")],
        })).toBe("Kept 2 entries, 1.4 hr. Not kept: “Bolt term sheet” overlaps time you already kept, or the timer is running; “Review” needs the Keep sheet: Halvorsen's rules flag this entry: \"Review\" does not say what was done; “Football pool” is personal time; and 2 more.");
        expect(approveSummary({ kept: [], skipped: [skip("Lease", "refused", "More than one matter has this name. Choose its linked matter.")] })).toBe("Nothing was kept. Not kept: “Lease” could not be kept: More than one matter has this name. Choose its linked matter.");
    });
});
