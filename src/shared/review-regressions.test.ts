import { describe, expect, it } from "vitest";
import { basename, win32 } from "node:path";
import { emptyWorkspace, editEntry, foldInto, intervals, keepLines, keepStretch, keptMatch, mergeIntoEntry, parseWorkspace, reviewedActivities, seconds, subtractIntervals, validate, type Activity, type KeepInput } from "./model";
import { applyRules } from "./applyRules";
import { billingFileName, contextOf, localDay, termsFor } from "./invoice";
import { addRulebook, ruleSetOf, saveClientRule } from "./clientRulebooks";
import { ruleReports } from "./clientRules";
import { bestMatch } from "./importMatch";
import { checkEntry, splitPlan } from "./rules";
import { draftEntry } from "./drafter";
import { inboxOf } from "./matters";

const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 4, 14) + minutes * 60_000).toISOString();
const now = Date.parse(at(200));
const span = (start: number, end: number) => ({ startedAt: at(start), endedAt: at(end) });
const activity = (id: string, start: number, end: number, extra: Partial<Activity> = {}): Activity => ({
    id, app: "Word", ownerID: "com.microsoft.Word", title: "Contract.docx", ...span(start, end), endedBy: "switched", disposition: "pending", matter: "Matter", ...extra,
});
const input: KeepInput = { description: "Review contract terms", projectID: "p", billable: true };
function workspace() {
    const w = emptyWorkspace();
    w.projects.push({ id: "p", name: "Matter", client: "Client", matterNumber: "123-001", color: "gold", hourlyRate: 100, archived: false });
    return w;
}

describe("review decisions survive billing", () => {
    it("bills the kept intervals, excluding an interior idle gap, and explains only that time", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 60, { idle: [span(20, 40)] }));
        const e = keepStretch(w, ["a"], { ...input, leaveOutIdle: true }, now);
        const key = addRulebook(w, { client: "Client" });
        saveClientRule(w, key, { kind: "tenths", title: "Tenths" });
        expect(seconds(e)).toBe(40 * 60);
        expect(e.work?.map((x) => [x.startedAt, x.minutes])).toEqual([[at(0), 20], [at(40), 20]]);
        expect(applyRules(w, null, key).totals.hours).toBe(0.7);
    });

    it("a rate or narrative rule cannot undo a person's reduction of billed hours", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 60));
        const e = keepStretch(w, ["a"], input, now);
        editEntry(w, e.id, { hours: 0.2 }, now);
        const key = addRulebook(w, { client: "Client" });
        saveClientRule(w, key, { kind: "rateCap", title: "Rates", rate: 80 });
        saveClientRule(w, key, { kind: "check", title: "Narratives", check: "vague" });
        expect(applyRules(w, null, key).totals).toEqual({ hours: 0.2, billedHours: 0.2, fees: 16 });
        editEntry(w, e.id, { hours: 0 }, now);
        expect(applyRules(w, null, key).totals.fees).toBe(0);
    });

    it.each(["split", "blockWithTimes"] as const)("%s keeps the saved total across multiple tasks", (kind) => {
        const w = workspace();
        w.activities.push(activity("a", 0, 30), activity("b", 30, 60, { title: "Advice.docx" }));
        const e = keepStretch(w, ["a", "b"], { ...input, description: "Review contract; draft advice", hours: 0.2 }, now);
        const key = addRulebook(w, { client: "Client" });
        saveClientRule(w, key, { kind, title: "Tasks" });
        expect(applyRules(w, null, key).totals.hours).toBe(0.2);
        expect(e.work?.reduce((n, x) => n + x.minutes, 0)).toBe(60);
    });

    it("does not round away capture seconds at an increment boundary", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 6 + 1 / 60));
        const e = keepStretch(w, ["a"], input, now);
        const key = addRulebook(w, { client: "Client" });
        saveClientRule(w, key, { kind: "tenths", title: "Tenths" });
        expect(e.work?.[0].minutes).toBeCloseTo(6 + 1 / 60);
        expect(applyRules(w, null, key).totals.hours).toBe(0.2);
    });
});

describe("merge and split keep only reviewed time", () => {
    it.each([
        { choice: { startedAt: at(20), endedAt: at(40) }, expected: 30 },
        { choice: { leaveOutIdle: true }, expected: 50 },
        { choice: { startedAt: at(-10), endedAt: at(70) }, expected: 90 },
    ])("merge preserves $choice through a workspace reload", ({ choice, expected }) => {
        let w = workspace();
        w.activities.push(activity("a", 0, 60, { idle: [span(20, 40)] }), activity("b", 120, 130));
        const e = keepStretch(w, ["a"], { ...input, ...choice }, now);
        expect(keptMatch(w, ["b"])?.id).toBe(e.id);
        mergeIntoEntry(w, ["b"], e.id);
        w = parseWorkspace(JSON.stringify(w));
        expect(inboxOf(w.activities).groups[0].seconds).toBe(expected * 60);
        const again = keepStretch(w, ["a", "b"], input, now);
        expect(seconds(again)).toBe(expected * 60);
        expect(() => validate(w)).not.toThrow();
    });

    it("does not reopen a sitting wholly outside the previously kept bounds", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 10), activity("b", 20, 30), activity("c", 40, 50));
        const e = keepStretch(w, ["a", "b"], { ...input, ...span(20, 30) }, now);
        mergeIntoEntry(w, ["c"], e.id);
        expect(w.activities[0].disposition).toBe("dismissed");
        expect(inboxOf(w.activities).groups[0].activityIDs).toEqual(["b", "c"]);
    });

    it("split saves the trimmed intervals, idle gaps, billable choice and rate", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 60, { idle: [span(20, 40)] }), activity("b", 60, 90, { app: "Preview", title: "Advice.pdf" }));
        const selected = subtractIntervals([span(10, 80)], [span(20, 40)]);
        const plan = splitPlan(reviewedActivities(w.activities, selected), contextOf(w.projects[0]), null, { billable: false, hourlyRate: 75, day: localDay(at(0)), hours: 0.5 });
        expect(plan).toHaveLength(2);
        const entries = keepLines(w, plan.map((l) => ({ activityIDs: l.activityIDs, input: { ...input, ...l.draft, sittings: l.sittings } })), now);
        expect(entries.reduce((n, e) => n + seconds(e), 0)).toBe(50 * 60);
        expect(entries.reduce((n, e) => n + e.hours!, 0)).toBe(0.5);
        expect(entries.every((e) => !e.billable && e.hourlyRate === 75)).toBe(true);
        expect(entries.flatMap(intervals)).toEqual([span(10, 20), span(40, 60), span(60, 80)]);
        expect(() => validate(w)).not.toThrow();
    });

    it("fold uses the reviewed intervals and adds the new evidence", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 10), activity("b", 20, 50, { idle: [span(30, 40)] }));
        const e = keepStretch(w, ["a"], input, now);
        const folded = foldInto(w, e.id, ["b"], { ...input, ...span(25, 45), leaveOutIdle: true }, now);
        expect(w.entries).toHaveLength(1);
        expect(seconds(folded)).toBe(20 * 60);
        expect(folded.work?.reduce((n, x) => n + x.minutes, 0)).toBe(20);
        expect(folded.sources?.map((s) => s.id)).toEqual(["a", "b"]);
        expect(() => validate(w)).not.toThrow();
    });

    it("fold cannot silently discard a different billable choice or frozen rate", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 10), activity("b", 20, 30));
        const e = keepStretch(w, ["a"], input, now);
        const before = JSON.stringify(w);
        expect(() => foldInto(w, e.id, ["b"], { ...input, billable: false }, now)).toThrow(/separately/);
        expect(() => foldInto(w, e.id, ["b"], { ...input, hourlyRate: 75 }, now)).toThrow(/separately/);
        expect(JSON.stringify(w)).toBe(before);
    });
});

describe("real workspaces use the same features as demo workspaces", () => {
    it("an offline redraft does not alter the entry, and connecting permits a model draft", async () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 30));
        const e = keepStretch(w, ["a"], input, now);
        const before = JSON.stringify(w);
        await expect(draftEntry(w, e, null)).rejects.toThrow(/Connect/);
        expect(JSON.stringify(w)).toBe(before);
        // Also recovers entries labelled as rules by the old offline fallback.
        e.drafter = "rules";
        const d = await draftEntry(w, e, async () => ({ drafts: [{ id: e.id, text: "Review contract [a]." }] }));
        expect(d.drafter).toBe("model");
        expect(d.narrative).toBe("Review contract.");
    });

    it("matches an imported matter number set on a normal project", () => {
        const w = workspace();
        w.activities.push(activity("a", 0, 30));
        const e = keepStretch(w, ["a"], input, now);
        expect(bestMatch(w, { date: localDay(e.startedAt), matter: "123-001", timekeeper: "Lawyer", hours: 0.5, description: e.description })).toBe(e.id);
        expect(bestMatch(w, { date: localDay(e.startedAt), matter: "123-002", timekeeper: "Lawyer", hours: 0.5, description: e.description })).toBeNull();
    });

    it.each([['clerical', 'Scan and copy client documents'], ['travel', 'Travel to client meeting']] as const)("new %s rules detect violations, even in older saved rules", (check, description) => {
        const w = workspace();
        w.activities.push(activity("a", 0, 30));
        keepStretch(w, ["a"], { ...input, description }, now);
        const key = addRulebook(w, { client: "Client" });
        const id = saveClientRule(w, key, { kind: "check", title: "Check", check });
        const book = w.clientRulebooks![0];
        expect(ruleReports(w, termsFor(w, w.projects[0]), book)[0].status).toBe("fail");
        delete book.rules[0].words;
        expect(ruleReports(w, termsFor(w, w.projects[0]), book)[0].status).toBe("fail");
        book.rules[0].words = ["custom keyword"];
        saveClientRule(w, key, { id, kind: "check", title: "Renamed", check });
        expect(book.rules[0].words).toEqual(["custom keyword"]);
    });

    it.each(["Invoice 2026/001 Smith/Jones", 'Time detail A:B C\\D <>|?*', 'CON', '... ', '案件'.repeat(200)])("makes a portable billing filename from %s", (stem) => {
        for (const ext of ["pdf", "docx"] as const) {
            const name = billingFileName(stem, ext);
            expect(name).toBe(basename(name));
            expect(name).toBe(win32.basename(name));
            expect(name).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
            expect(Buffer.byteLength(name)).toBeLessThan(256);
            expect(name).toMatch(new RegExp(`\\.${ext}$`));
            expect(name).not.toMatch(/^CON\./i);
        }
    });

    it("treats custom check words as text rather than regular expressions", () => {
        const w = workspace();
        const key = addRulebook(w, { client: "Client" });
        saveClientRule(w, key, { kind: "check", title: "Clerical", check: "clerical", words: ["copy [files]"] });
        const findings = checkEntry({ description: "Copy [files] for the client", hours: 0.1, billable: true, hourlyRate: 100, day: localDay(at(0)) }, { book: ruleSetOf(w.clientRulebooks![0]), ctx: null, profile: null });
        expect(findings).toHaveLength(1);
        expect(findings[0].fixes[0].change.billable).toBe(false);
    });
});
