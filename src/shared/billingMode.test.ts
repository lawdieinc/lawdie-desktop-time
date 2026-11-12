import { describe, expect, it } from "vitest";
import { emptyWorkspace, keepStretch, validate, type Activity, type TimeEntry, type Workspace } from "./model";
import type { Rule, RuleSet } from "./rules";
import { inboxRowOf, keepPreview, keepStart } from "./keep";
import { billedHours, billingModeOf, entryHours, hoursText, hoursWithin, hr, incrementFor, roundUpTo, sumHours } from "./billingMode";

const T0 = new Date(2026, 10, 10, 9, 0, 0).getTime();
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const act = (id: string, from: number, to: number): Activity => ({ id, app: "Microsoft Word", ownerID: "com.microsoft.Word", title: "Lease.docx", startedAt: at(from), endedAt: at(to), endedBy: "switched", disposition: "pending", matter: "Acme lease", matterBy: "person", description: "Revised the lease" });
const entry = (id: string, from: number, to: number, over: Partial<TimeEntry> = {}): TimeEntry => ({ id, description: "Work", projectID: null, startedAt: at(from), endedAt: at(to), billable: true, hourlyRate: 0, source: "desktop", activityID: null, ...over });

function day(mode?: "tenths" | "quarters"): Workspace {
    const w = emptyWorkspace();
    if (mode) w.preferences.billingMode = mode;
    w.projects.push({ id: "p", name: "Acme lease", client: "Halvorsen", color: "gold", hourlyRate: 450, archived: false });
    w.activities.push(act("a1", 0, 20));
    return validate(w);
}
const preview = (w: Workspace) => { const r = inboxRowOf(w, ["a1"])!; const s = keepStart(w, r.stretch, r.sittings, r.matter, ""); return { r, p: keepPreview(w, r.stretch, r.sittings, s, s.single) }; };

describe("the billing mode", () => {
    it("is tenths unless quarter hours is chosen, and anything else is refused", () => {
        expect(billingModeOf(emptyWorkspace().preferences)).toBe("tenths");
        expect(billingModeOf(day("quarters").preferences)).toBe("quarters");
        const w = day();
        (w.preferences as { billingMode?: string }).billingMode = "minutes";
        expect(() => validate(w)).toThrow();
    });

    it("rounds up to the increment and never under one", () => {
        expect([1, 360, 361, 1200, 3600].map((s) => billedHours(s, 0.1))).toEqual([0.1, 0.1, 0.2, 0.4, 1]);
        expect([1, 900, 901, 1200, 3600, 4000].map((s) => billedHours(s, 0.25))).toEqual([0.25, 0.25, 0.5, 0.5, 1, 1.25]);
        expect(roundUpTo(0.3, 0.1)).toBe(0.3);
        expect(roundUpTo(0.3, 0.25)).toBe(0.5);
    });

    it("writes hours with one decimal, two when the hundredths count", () => {
        expect([0.1, 1, 0.25, 0.5, 1.75].map(hoursText)).toEqual(["0.1", "1.0", "0.25", "0.5", "1.75"]);
        expect(hr(1.25)).toBe("1.25 hr");
    });

    it("keeps twenty minutes as 0.4 in tenths and 0.5 in quarter hours, stored on the entry", () => {
        expect(preview(day()).p.hours).toBe(0.4);
        const w = day("quarters");
        const { r, p } = preview(w);
        expect(p.hours).toBe(0.5);
        const e = keepStretch(w, r.stretch.activityIDs, p.input, T0 + 3_600_000);
        expect(e.hours).toBe(0.5);
        // Changing the mode later leaves the kept entry as it was billed.
        w.preferences.billingMode = "tenths";
        expect(entryHours(e)).toBe(0.5);
    });

    it("lets a client's own increment rule win over the mode", () => {
        const rule: Rule = { id: "INC", clause: "§3", title: "Tenths", text: "", check: "time_increment", params: { incr: 0.1 }, source: "guidelines", sourceRef: null, approvedAt: null, atEntry: true };
        const book: RuleSet = { client: "Halvorsen", clientId: "halvorsen", matter: null, guidelines: "Halvorsen Billing Guidelines", version: "1", exportedAt: at(0), rules: [rule] };
        const w = day("quarters");
        w.rulebooks = [book];
        expect(incrementFor(w.preferences, book)).toBe(0.1);
        expect(incrementFor(w.preferences, null)).toBe(0.25);
        expect(preview(validate(w)).p.hours).toBe(0.4);
    });

    it("reads an entry kept before hours were stored in tenths, and totals as the sum of the entries", () => {
        const old = entry("e1", 0, 20), stored = entry("e2", 30, 50, { hours: 0.5 });
        expect(entryHours(old)).toBe(0.4);
        expect(sumHours([old, stored])).toBe(0.9);
        // Half of an entry inside the range is half of its hours.
        expect(hoursWithin(stored, T0 + 40 * 60_000, T0 + 600 * 60_000)).toBe(0.25);
        expect(hoursWithin(stored, T0 + 600 * 60_000, T0 + 700 * 60_000)).toBe(0);
    });
});
