import { describe, expect, it } from "vitest";
import { billFor, bookOf, rulesTotals, totals } from "./invoice";
import { entryEffects, ruleReports } from "./clientRules";
import { bestMatch, typedRows } from "./importMatch";
import { addTypedRow, expandRow, linkAll } from "./typed";
import type { Workspace } from "./model";
import { entryStarting, manattDay } from "./__fixtures__/manattDay";

const day = "2026-10-26";
const book = (w: Workspace, key: string) => bookOf(w, key)!;

describe("billing the seeded day under each client's rules", () => {
    it("generic, Northlake and Kestrel Valley come to $5,616.50, $4,730.00 and $4,577.00", () => {
        const w = manattDay();
        expect(totals(billFor(w, w.invoice!, null))).toEqual({ hours: 4.7, billedHours: 4.7, fees: 5616.5 });
        expect(totals(billFor(w, w.invoice!, book(w, "northlake")))).toMatchObject({ billedHours: 4.4, fees: 4730 });
        expect(totals(billFor(w, w.invoice!, book(w, "kestrel")))).toMatchObject({ billedHours: 4.6, fees: 4577 }); // 4.6 h at $995
        expect(rulesTotals(w, w.invoice!, book(w, "kestrel"))).toEqual({ standard: 5616.5, withRules: 4577, hours: 4.6 });
    });

    it("Northlake: engagement rate, counseling code first, the internal conference at no charge, the block-billed entry split", () => {
        const w = manattDay();
        const fx = entryEffects(w, w.invoice!, book(w, "northlake"));
        const kickoff = fx.get(entryStarting(w, "Teams conference").id)!;
        expect(kickoff.effects).toEqual(expect.arrayContaining([
            { rule: "NBH-3", what: "rate", before: "$1,195", after: "$1,075" },
            { rule: "NBH-11", what: "text", text: "C300 added in front" },
        ]));
        expect(kickoff.lines[0].segments[0]).toEqual({ text: "C300 ", ins: "NBH-11" });
        expect(kickoff.lines[0].description).toMatch(/^C300 Teams conference with P\. Raman/);
        const theo = fx.get(entryStarting(w, "Conference with T. Navarro").id)!;
        expect(theo.effects).toContainEqual({ rule: "NBH-2", what: "noCharge", before: "$358.50", after: "No charge" });
        expect(theo.lines[0]).toMatchObject({ noCharge: true, amount: 0 });
        const states = fx.get(entryStarting(w, "Research telehealth").id)!;
        expect(states.lines.map((l) => l.hours)).toEqual([0.7, 0.9]);
        expect(states.effects).toContainEqual({ rule: "NBH-1", what: "split", before: "1.6 h", after: "0.7 h + 0.9 h" });
        expect(states.lines[0].description).toMatch(/^C200 Research telehealth licensure .* Florida\.$/);
        expect(states.lines[1].description).toMatch(/^C200 Review and revise six-state licensure/);
    });

    it("Kestrel Valley: partner cap, activity code first, the call cut to 0.5, the conference kept for the senior attendee, each task's time written in", () => {
        const w = manattDay();
        const fx = entryEffects(w, w.invoice!, book(w, "kestrel"));
        const kickoff = fx.get(entryStarting(w, "Teams conference").id)!;
        expect(kickoff.effects).toEqual(expect.arrayContaining([
            { rule: "KVH-1", what: "rate", before: "$1,195", after: "$995" },
            { rule: "KVH-5", what: "hours", before: "0.6 h", after: "0.5 h" },
            { rule: "KVH-4", what: "text", text: "A106 added in front" },
        ]));
        expect(kickoff.lines[0]).toMatchObject({ hours: 0.5, amount: 497.5 });
        const theo = fx.get(entryStarting(w, "Conference with T. Navarro").id)!;
        expect(theo.effects).toContainEqual({ rule: "KVH-6", what: "kept", text: "Billable for R. Delacroix, the senior attendee" });
        expect(theo.lines[0]).toMatchObject({ noCharge: false, hours: 0.3, amount: 298.5 });
        const states = fx.get(entryStarting(w, "Research telehealth").id)!;
        expect(states.lines).toHaveLength(1);
        expect(states.lines[0].description).toMatch(/^A102 Research telehealth .* Florida \(0\.7\); review and revise .* program \(0\.9\)\.$/);
        expect(states.lines[0].segments).toContainEqual({ text: " (0.7)", ins: "KVH-3" });
        expect(states.lines[0].hours).toBe(1.6);
    });

    it("a rule switched off is left out of the bill", () => {
        const w = manattDay();
        const nl = book(w, "northlake");
        nl.rules.find((r) => r.id === "NBH-3")!.enabled = false;
        expect(totals(billFor(w, w.invoice!, nl)).fees).toBe(5258); // 4.4 h at $1,195
        nl.rules.find((r) => r.id === "NBH-1")!.enabled = false;
        expect(billFor(w, w.invoice!, nl).filter((l) => l.entryID === entryStarting(w, "Research telehealth").id)).toHaveLength(1);
    });

    it("each rule card says whether it changes today's bill, was checked, or has nothing today", () => {
        const w = manattDay();
        const status = (key: string) => Object.fromEntries(ruleReports(w, w.invoice!, book(w, key)).map((r) => [r.rule.id, r.status]));
        expect(status("northlake")).toMatchObject({ "NBH-3": "changes", "NBH-1": "changes", "NBH-2": "changes", "NBH-11": "changes", "NBH-4": "pass", "NBH-5": "pass", "NBH-6": "pass", "NBH-7": "pass", "NBH-10": "pass", "NBH-9": "none", "EL-3": "none" });
        expect(status("kestrel")).toMatchObject({ "KVH-1": "changes", "KVH-2": "pass", "KVH-3": "changes", "KVH-4": "changes", "KVH-5": "changes", "KVH-6": "pass", "KVH-7": "pass" });
        const nbh3 = ruleReports(w, w.invoice!, book(w, "northlake")).find((r) => r.rule.id === "NBH-3")!;
        expect(nbh3.summary).toBe("$1,195 → $1,075 on 5 entries");
    });
});

describe("matching typed notes on the seeded day", () => {
    const match = (w: Workspace, description: string, hours: number) => bestMatch(w, { date: day, matter: "61407-002", timekeeper: "RD", hours, description });

    it("an exact word counts more than its shorthand: redline .8 is the agreement, not the matrix it widens to", () => {
        const w = manattDay();
        expect(match(w, "redline", 0.8)).toBe(entryStarting(w, "Review and revise HVHP").id);
    });

    it("hours are also compared with each stretch: research .7 is the 41-minute research stretch, not the conference with T. Navarro", () => {
        const w = manattDay();
        expect(match(w, "research", 0.7)).toBe(entryStarting(w, "Research telehealth").id);
    });

    it("initials or a state code alone never make a match", () => {
        const w = manattDay();
        expect(match(w, "email PR", 0.3)).toBeNull();
        expect(match(w, "CA", 0.3)).toBeNull();
        expect(match(w, "call PR re CA", 0.25)).toBe(entryStarting(w, "Telephone conference").id);
    });

    it("links each of the six rows of Rosa's messy sheet to its entry", () => {
        const w = manattDay();
        const sheet = [["RD time - wk of 10/26"], [], ["Date", "Client / Matter", "What", "Hrs", "Atty"],
            ["10/26", "Northlake", "phone call with client", ".9", "RD"], ["Oct 26", "61407-002", "rev HVHP v3 + redline (exh B, cred, termination)", "1.5h", "RD"],
            ["10/26", "Northlake", "w/ Theo re matrix", "0.3", "RD"], [], ["10/26", "Northlake", "telehealth research NY/CA/TX/FL; matrix", "120m", "RD"],
            ["Oct 26", "northlake", "Part 2 consent + BAA", ".5", "rd"], ["10/26", "Northlake", "call PR re CA", ".25", "RD"], ["", "", "Total", "5.45", ""]];
        w.imported = typedRows(sheet, 2026).map((r, n) => ({ ...r, id: `x${n}`, entryID: null, decision: null, linked: false, origin: "import" as const }));
        linkAll(w);
        const got = w.imported.map((r) => w.entries.find((e) => e.id === r.entryID)?.description.split(" ").slice(0, 3).join(" ") ?? null);
        expect(got).toEqual(["Teams conference with", "Review and revise", "Conference with T.", "Research telehealth licensure", "Review Northlake 42", "Telephone conference with"]);
    });

    it("expands the presenter's four notes to their entries", () => {
        const w = manattDay();
        const p = w.projects[0].id;
        const expand = (note: string, id: string) => { addTypedRow(w, { date: day, note, projectID: p }, id); return w.entries.find((e) => e.id === expandRow(w, id).entryID)?.description ?? null; };
        expect(expand(".9 call w/ client", "a")).toMatch(/^Teams conference with P\. Raman and M\. Bell/);
        expect(expand("theo .3", "b")).toMatch(/^Conference with T\. Navarro/);
        expect(expand("consent .5", "c")).toMatch(/^Review Northlake 42 CFR Part 2 consent/);
        expect(expand("call PR re CA .25", "d")).toMatch(/^Telephone conference with P\. Raman regarding California/);
    });
});
