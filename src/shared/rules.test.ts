import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFeed, applyStage, demoNow, parseSeed, seedWorkspace, type Seed } from "./demo";
import { editEntry, keepLines, type Workspace } from "./model";
import { narrativeFor } from "./narrative";
import { applyFix, checkEntry, normalizeRuleSet, rulebookFor, rulesMet, splitPlan, taskCount, type CheckContext, type EntryDraft } from "./rules";

// The Manatt demo seed (resources/demo/manatt.json) is the fixture: the checks below are
// what the presenter sees on stage, so a change that moves them fails here first.

const seed: Seed = parseSeed(readFileSync(join(__dirname, "../../resources/demo/manatt.json"), "utf8"));
const NOW = new Date(2026, 9, 26, 13, 0).getTime();
const day = (): Workspace => seedWorkspace(seed, 1, NOW);
const ctxOf = (w: Workspace): CheckContext => {
    const p = w.projects[0];
    return { book: rulebookFor(w, p.context, p.client), ctx: p.context ?? null, profile: w.profile ?? null };
};
const draft = (over: Partial<EntryDraft>): EntryDraft => ({ description: "", hours: 0.5, taskCode: "P500", activityCode: "A103", billable: true, hourlyRate: 1150, day: "2026-10-22", ...over });
const ids = (fs: { rule: { id: string } }[]) => fs.map((f) => f.rule.id);

/** The rules as the billing system sends them after Act 3: rules-export.json whole (make_seed.py writes the copy). */
const act3Export = (): unknown => JSON.parse(readFileSync(join(__dirname, "../../resources/demo/rules-export.json"), "utf8"));

describe("the Manatt seed day", () => {
    it("drafts one narrative per task from capture, deterministically", () => {
        const w = day();
        const plan = splitPlan(w.activities, w.projects[0].context!, w.profile!, { billable: true, hourlyRate: 1150, day: "2026-10-22" });
        expect(plan.map((l) => [l.draft.description, l.draft.hours, l.draft.taskCode, l.draft.activityCode])).toEqual([
            ["Emails with L. Mbeki re data-use restrictions and open points after the Corvane call", 0.4, "P500", "A106"],
            ["Revise Corvane data license agreement (v6) re section 4.2 (permitted purposes) and section 7.3 (audit rights)", 1.8, "P500", "A103"],
            ["Call with Corvane counsel and Dr. S. Achterberg re data-use restrictions and audit rights", 0.7, "P500", "A107"],
            ["Research 45 C.F.R. 164.504(e) business associate contracts", 0.8, "P300", "A102"],
            ["Conference with T. Lindqvist re BAA open points", 0.3, "P300", "A105"],
        ]);
        expect(seedWorkspace(seed, 1, NOW).activities[0].draft?.text).toBe(narrativeFor(w.activities, w.projects[0].context!, "Nadia Kessler"));
    });

    it("flags the whole day as one block-billed entry and offers the split by captured time", () => {
        const w = day();
        const text = w.activities[0].draft!.text;
        expect(taskCount(text, ";,")).toBe(5);
        const found = checkEntry(draft({ description: text, hours: 4.0, taskCode: undefined, activityCode: undefined }), { ...ctxOf(w), splitCount: 5 });
        expect(ids(found)).toEqual(["HHP-2", "HHP-3", "HHP-5"]);
        expect(found[0].cite).toBe("Halvorsen Outside Counsel Billing Guidelines §3.2");
        expect(found[0].fixes[0]).toMatchObject({ label: "Split into 5 entries by captured time", split: true });
    });

    it("leaves only the lines a client rule still catches, each with its fix", () => {
        const w = day();
        const c = ctxOf(w);
        const plan = splitPlan(w.activities, w.projects[0].context!, w.profile!, { billable: true, hourlyRate: 1150, day: "2026-10-22" });
        const found = plan.map((l) => ids(checkEntry(l.draft, c)));
        expect(found).toEqual([[], [], [], ["HHP-5"], ["HHP-4", "HHP-5"]]);
        const research = checkEntry(plan[3].draft, c)[0];
        expect(research.message).toBe("HIPAA business associate terms goes under task code P270, not P300.");
        const fixed = applyFix(plan[3].draft, research.fixes[0]);
        expect(fixed.taskCode).toBe("P270");
        expect(checkEntry(fixed, c)).toEqual([]);
        const conf = checkEntry(plan[4].draft, c);
        expect(conf[0]).toMatchObject({ cite: "Halvorsen Outside Counsel Billing Guidelines §3.5", fromClient: false });
        expect(applyFix(plan[4].draft, conf[0].fixes[0]).billable).toBe(false);
    });

    it("catches what a person types: vague words, a missing code, a quarter hour, an unnamed document", () => {
        const c = ctxOf(day());
        expect(ids(checkEntry(draft({ description: "Review draft" }), c))).toEqual(["MTS-1"]);
        const vague = checkEntry(draft({ description: "Review draft" }), { ...c, suggestion: "Review Corvane data license agreement (v6)" });
        expect(vague[0].fixes[0].change.description).toBe("Review Corvane data license agreement (v6)");
        const noCode = checkEntry(draft({ description: "Revise Corvane data license agreement re audit rights", taskCode: undefined }), c);
        expect(noCode.map((f) => [f.rule.id, f.fixes[0].label])).toEqual([["HHP-3", "Use P500 / A103"]]);
        const quarter = checkEntry(draft({ description: "Call with L. Mbeki re signature timing", hours: 0.25, activityCode: "A106" }), c);
        expect(quarter.map((f) => [f.rule.id, f.message, f.fixes[0].change.hours])).toEqual([["HHP-1", "0.25 h is not in tenths of an hour.", 0.3]]);
        expect(ids(checkEntry(draft({ description: "Call" }), c))).toEqual(["MTS-1", "MTS-2"]);
        expect(rulesMet(draft({ description: "Revise Corvane data license agreement re audit rights" }), c).length).toBeGreaterThan(5);
    });

    it("keeps the split lines as entries and changes an entry when a fix is accepted", () => {
        const w = day();
        const plan = splitPlan(w.activities, w.projects[0].context!, w.profile!, { billable: true, hourlyRate: 1150, day: "2026-10-22" });
        const kept = keepLines(w, plan.map((l) => ({ activityIDs: l.activityIDs, input: { description: l.draft.description, projectID: w.projects[0].id, billable: true, hours: l.draft.hours, taskCode: l.draft.taskCode, activityCode: l.draft.activityCode, drafted: "capture" } })), NOW);
        expect(kept).toHaveLength(5);
        expect(w.activities.every((a) => a.disposition === "kept")).toBe(true);
        const e = editEntry(w, kept[4].id, { billable: false }, NOW);
        expect(e.billable).toBe(false);
        expect(e.drafted).toBe("capture");
    });
});

describe("fixes that change kept entries", () => {
    it("folds a short email into the day's email entry: one entry, the summed hours, no second bill", () => {
        const w = applyFeed(day(), seed, { epoch: 1, stage: "act3", rulebooks: [act3Export()] }, NOW).workspace;
        const [first, second] = w.activities.filter((a) => a.app === "Microsoft Outlook");
        const pid = w.projects[0].id;
        const [kept] = keepLines(w, [{ activityIDs: [first.id], input: { description: "Emails with L. Mbeki re data-use restrictions", projectID: pid, billable: true, hours: 0.1, taskCode: "P500", activityCode: "A106" } }], NOW);
        const found = checkEntry(draft({ description: "Emails with L. Mbeki re open points", hours: 0.1, activityCode: "A106" }), { ...ctxOf(w), sameDay: [{ ...draft({ description: kept.description, hours: 0.1 }), id: kept.id }] });
        const fold = found.find((f) => f.rule.id === "HHP-12")!.fixes[0];
        expect(fold).toMatchObject({ foldInto: kept.id, change: { hours: 0.2, description: kept.description } });
        keepLines(w, [{ activityIDs: [second.id], input: { description: fold.change.description!, projectID: pid, billable: true, hours: fold.change.hours }, foldInto: fold.foldInto }], NOW);
        expect(w.entries).toHaveLength(1);
        expect(w.entries[0]).toMatchObject({ id: kept.id, hours: 0.2 });
    });

    it("takes a code off when its field is emptied, and survives a feed rule with no task", () => {
        const w = day();
        const plan = splitPlan(w.activities, w.projects[0].context!, w.profile!, { billable: true, hourlyRate: 1150, day: "2026-10-22" });
        const [e] = keepLines(w, [{ activityIDs: plan[0].activityIDs, input: { description: plan[0].draft.description, projectID: w.projects[0].id, billable: true, taskCode: "P500", activityCode: "A106" } }], NOW);
        expect(editEntry(w, e.id, { taskCode: "", activityCode: " " }, NOW)).not.toHaveProperty("taskCode");
        const odd = normalizeRuleSet({ clientId: "C-1", rules: [{ id: "X", text: "Cap.", check: "task_rate_cap", params: { task: "", cap: 700 } }, { id: "Y", text: "Cap.", check: "task_rate_cap", params: { task: "c++", cap: 700 } }] });
        expect(() => checkEntry(draft({ description: "Research CMIA" }), { book: odd, ctx: null, profile: null })).not.toThrow();
    });
});

describe("rules flowing back after the rejection (Act 3)", () => {
    it("reads the billing lane's export: sources, clauses, the new check names", () => {
        const book = normalizeRuleSet(act3Export());
        const r11 = book.rules.find((r) => r.id === "HHP-11")!;
        expect(r11).toMatchObject({ check: "task_rate_cap", source: "rejection", sourceRef: "Lauren Mbeki's rejection, Nov 4", atEntry: true });
        expect(book.rules.find((r) => r.id === "HHP-13")!.check).toBe("name_document");
        expect(book.rules.find((r) => r.id === "HHP-E1")!.sourceRef).toBe("Lauren Mbeki's email, Oct 16");
        expect(book.rules.find((r) => r.id === "HHP-10")!.atEntry).toBe(false);
    });

    it("announces the three new rules, adds the next day, and flags its research under the rejection's rule", () => {
        const w = day();
        const { workspace, notice } = applyFeed(w, seed, { epoch: 1, stage: "act3", rulebooks: [act3Export()] }, NOW);
        expect(notice).toContain("Halvorsen Health Partners updated its billing rules: 3 new rules from Lauren Mbeki's rejection, Nov 4.");
        expect(workspace.demo).toMatchObject({ stage: "act3", day: "2026-11-05" });
        const fresh = workspace.activities.filter((a) => a.id.startsWith("seed-act3-"));
        const plan = splitPlan(fresh, workspace.projects[0].context!, workspace.profile!, { billable: true, hourlyRate: 1150, day: "2026-11-05" });
        const found = checkEntry(plan[0].draft, ctxOf(workspace));
        expect(found.map((f) => [f.rule.id, f.isNew, f.fromClient, f.cite])).toEqual([["HHP-11", true, true, "From Lauren Mbeki's rejection, Nov 4"]]);
        expect(found[0].fixes.map((f) => f.label)).toEqual(["Bill at $700/h, the cap", "Bill at Theo's rate, $640/h"]);
        expect(checkEntry(draft({ description: "Revise draft", day: "2026-11-05" }), ctxOf(workspace)).map((f) => [f.rule.id, f.fixes[0]?.change.description])).toEqual([
            ["HHP-13", "Revise Corvane data license agreement"],
            ["MTS-1", undefined],
        ]);
        expect(demoNow(workspace, NOW)).toBeGreaterThan(new Date(2026, 10, 5, 23, 0).getTime());
    });

    it("undoes Act 3: the rules and the added day go, the seeded day's entries stay; a new epoch resets", () => {
        const w = applyFeed(day(), seed, { epoch: 1, stage: "act3", rulebooks: [act3Export()] }, NOW).workspace;
        const back = applyFeed(w, seed, { epoch: 1, stage: "day", rulebooks: [seed.rulebooks[0]] }, NOW);
        expect(back.workspace.activities.some((a) => a.id.startsWith("seed-act3-"))).toBe(false);
        expect(rulebookFor(back.workspace, back.workspace.projects[0].context)!.rules.some((r) => r.id === "HHP-11")).toBe(false);
        expect(back.workspace.demo?.day).toBe("2026-10-22");
        applyStage(back.workspace, seed, "day");
        const reset = applyFeed(back.workspace, seed, { epoch: 2, stage: "day" }, NOW);
        expect(reset.notice).toBe("Demo reset: Nadia Kessler's captured day is back to review.");
        expect(reset.workspace.entries).toEqual([]);
    });
});
