import { describe, expect, it } from "vitest";
import { emptyWorkspace, validate, WorkspaceError, type Project, type TimeEntry } from "./model";
import { addRulebook, describeRule, removeClientRule, removeRulebook, ruleSetOf, saveClientRule, updateRulebook } from "./clientRulebooks";
import { applyRules } from "./applyRules";
import { checkEntry, rulebookFor } from "./rules";
import { contextOf } from "./invoice";

const project = (id: string, client: string): Project => ({ id, name: `Matter ${id}`, client, color: "#000", hourlyRate: 1195, archived: false });
const entry = (id: string, projectID: string, description: string, hours: number, extra: Partial<TimeEntry> = {}): TimeEntry => ({
    id, description, projectID, startedAt: "2026-10-20T14:00:00.000Z", endedAt: new Date(Date.parse("2026-10-20T14:00:00.000Z") + hours * 3_600_000).toISOString(),
    billable: true, hourlyRate: 1195, source: "desktop", activityID: null, createdAt: "2026-10-20T15:00:00.000Z", updatedAt: "2026-10-20T15:00:00.000Z", synced: false, ...extra,
} as TimeEntry);

describe("a client's rulebook made in the app", () => {
    it("makes a rulebook with a key from the client's name, and refuses a second for the same client", () => {
        const w = emptyWorkspace();
        const key = addRulebook(w, { client: " Northlake Behavioral Health, Inc. ", effective: "January 1, 2026" });
        expect(key).toBe("northlake-behavioral-health-inc");
        expect(w.clientRulebooks![0]).toMatchObject({ key, client: "Northlake Behavioral Health, Inc.", short: "Northlake", title: "Northlake Behavioral Health, Inc. billing rules", effective: "January 1, 2026", rules: [] });
        expect(() => addRulebook(w, { client: "northlake behavioral health, inc." })).toThrow(WorkspaceError);
        expect(() => addRulebook(w, { client: "  " })).toThrow(WorkspaceError);
        updateRulebook(w, key, { client: "Northlake", title: "" });
        expect(w.clientRulebooks![0]).toMatchObject({ client: "Northlake", short: "Northlake", title: "Northlake billing rules" });
        expect(() => validate(w)).not.toThrow();
    });

    it("numbers rules from the client's initials, checks what each kind needs, and says what a rule does when no one did", () => {
        const w = emptyWorkspace();
        const key = addRulebook(w, { client: "Northlake Behavioral Health" });
        expect(saveClientRule(w, key, { kind: "tenths", title: "Tenth-hour increments", section: "§4.1", quote: "Time is recorded in tenths." })).toBe("NBH-1");
        expect(saveClientRule(w, key, { kind: "rateCap", title: "Engagement-letter rates", rate: 1075 })).toBe("NBH-2");
        expect(() => saveClientRule(w, key, { kind: "rateCap", title: "No rate" })).toThrow(WorkspaceError);
        expect(() => saveClientRule(w, key, { kind: "noCharge", title: "Bad code", activityCode: "internal" })).toThrow(WorkspaceError);
        expect(() => saveClientRule(w, key, { kind: "notBilled", title: "No words", words: [] })).toThrow(WorkspaceError);
        expect(() => saveClientRule(w, key, { kind: "check", title: "Who", check: "timekeepers", approved: [] })).toThrow(WorkspaceError);
        expect(() => saveClientRule(w, key, { kind: "tenths", title: "" })).toThrow(WorkspaceError);
        saveClientRule(w, key, { kind: "noCharge", title: "Internal conferences", activityCode: "a105" });
        saveClientRule(w, key, { kind: "check", title: "Vague narratives", check: "vague", examples: ["review file", ""] });
        const rules = w.clientRulebooks![0].rules;
        expect(rules.map((r) => r.id)).toEqual(["NBH-1", "NBH-2", "NBH-3", "NBH-4"]);
        expect(rules[1]).toMatchObject({ kind: "rateCap", rate: 1075, enabled: true, does: "Bills no hour above $1,075." });
        expect(rules[2]).toMatchObject({ activityCode: "A105", does: "Keeps entries coded A105 on the bill at no charge." });
        expect(rules[3]).toMatchObject({ check: "vague", examples: ["review file"] });
        // Changing a rule keeps its id and its switch; deleting it leaves the others.
        rules[1].enabled = false;
        expect(saveClientRule(w, key, { id: "NBH-2", kind: "rateCap", title: "Panel rate", rate: 950, does: "Caps at the panel rate." })).toBe("NBH-2");
        expect(rules[1]).toMatchObject({ id: "NBH-2", title: "Panel rate", rate: 950, enabled: false, does: "Caps at the panel rate." });
        removeClientRule(w, key, "NBH-3");
        expect(rules.map((r) => r.id)).toEqual(["NBH-1", "NBH-2", "NBH-4"]);
        expect(() => removeClientRule(w, key, "NBH-3")).toThrow(WorkspaceError);
        expect(() => validate(w)).not.toThrow();
        expect(describeRule({ kind: "callCap", maxHours: 0.5 })).toBe("Bills a call or video conference at no more than 0.5 hours.");
        expect(describeRule({ kind: "notBilled", words: ["training"] })).toBe("Bills at no charge any entry whose narrative mentions “training”.");
    });

    it("shapes a bill: the rate cap and the no-charge code apply under the rulebook, and deleting the rulebook returns the bill to generic", () => {
        const w = emptyWorkspace();
        w.projects.push(project("a", "Northlake Behavioral Health, Inc."));
        w.entries.push(entry("e1", "a", "Revise provider agreement.", 1), entry("e2", "a", "Conference with T. Navarro re strategy.", 0.5, { activityCode: "A105" }));
        const key = addRulebook(w, { client: "Northlake Behavioral Health, Inc." });
        saveClientRule(w, key, { kind: "rateCap", title: "Rates", rate: 1075 });
        saveClientRule(w, key, { kind: "noCharge", title: "Internal conferences", activityCode: "A105" });
        const bill = applyRules(w, "2026-10-20", key);
        expect(bill.standard).toBe(1792.5);
        expect(bill.totals).toEqual({ hours: 1.5, billedHours: 1, fees: 1075 });
        expect(bill.lines[1]).toMatchObject({ noCharge: true, note: "No charge per Northlake OCG " });
        w.billingClient = key;
        removeRulebook(w, key);
        expect(w.clientRulebooks).toEqual([]);
        expect(w.billingClient).toBeNull();
        expect(applyRules(w, "2026-10-20", key).totals.fees).toBe(1792.5);
    });

    it("checks an entry in the Keep sheet against the rules made here when the client has no exported rule set", () => {
        const w = emptyWorkspace();
        w.projects.push(project("a", "Northlake Behavioral Health, Inc."));
        const key = addRulebook(w, { client: "Northlake Behavioral Health" });
        saveClientRule(w, key, { kind: "tenths", title: "Tenths", section: "§4.1", quote: "Time is recorded in tenths of an hour." });
        saveClientRule(w, key, { kind: "split", title: "One task per entry" });
        saveClientRule(w, key, { kind: "rateCap", title: "Rates", rate: 1075 });
        saveClientRule(w, key, { kind: "check", title: "Vague", check: "vague" });
        const set = ruleSetOf(w.clientRulebooks![0]);
        expect(set.rules.map((r) => [r.id, r.check])).toEqual([["NBH-1", "time_increment"], ["NBH-2", "block_billing"], ["NBH-4", "vague_narrative"]]);
        expect(set.rules[0]).toMatchObject({ clause: "§4.1", text: "Time is recorded in tenths of an hour.", atEntry: true, source: "guidelines" });
        // The project's client is matched without its corporate ending; the context comes from the project itself.
        const ctx = contextOf(w.projects[0]);
        const c = { book: rulebookFor(w, ctx, w.projects[0].client), ctx, profile: null };
        expect(c.book?.clientId).toBe(key);
        const findings = checkEntry({ id: "x", description: "Review file", hours: 0.25, billable: true, hourlyRate: 1195, day: "2026-10-20" }, c);
        expect(findings.map((f) => f.rule.id)).toEqual(["NBH-1", "NBH-4"]);
        expect(findings[0].cite).toContain("§4.1");
        expect(checkEntry({ id: "y", description: "Review provider agreement; draft memo on licensure.", hours: 0.3, billable: true, hourlyRate: 1195, day: "2026-10-20" }, c).map((f) => f.rule.id)).toEqual(["NBH-2"]);
        expect(rulebookFor(w, null, "Someone Else")).toBeNull();
    });
});
