import { describe, expect, it } from "vitest";
import { activeRules, feeLines, tenths, totals } from "./invoice";
import { matchRows, normalizeDate, parseCsv, typedRows } from "./importMatch";
import { emptyWorkspace, type InvoiceTerms, type TimeEntry, type Workspace } from "./model";

const day = "2026-10-26";
const at = (hhmm: string, plus = 0): string => new Date(new Date(`${day}T${hhmm}:00`).getTime() + plus * 60_000).toISOString();
let n = 0;
const entry = (start: string, minutes: number, description: string, over: Partial<TimeEntry> = {}): TimeEntry => ({
    id: `e${++n}`, description, projectID: "p1", startedAt: at(start), endedAt: at(start, minutes), billable: true, hourlyRate: 1195,
    source: "desktop", activityID: null, hours: tenths(minutes), parts: [{ text: description, evidence: [], slot: null }],
    work: [{ app: "Microsoft Teams", title: description, startedAt: at(start), minutes }], ...over,
});

/** Rosa's day as the seed writes it: five entries, a suggestion, a flagged stretch. */
function rosa(): Workspace {
    n = 0;
    const w = emptyWorkspace();
    w.projects = [{ id: "p1", name: "61407-002 Hudson Valley Health Plan provider agreement", client: "Northlake Behavioral Health", color: "gold", hourlyRate: 1195, archived: false }];
    w.entries = [
        entry("09:15", 36, "Teams conference with P. Raman and M. Bell (Northlake) regarding HVHP rates.", { activityCode: "A106" }),
        entry("09:58", 100, "Review and revise HVHP participating provider agreement.", { activityCode: "A103",
            work: [{ app: "Google Chrome", title: "HVHP v3 - Kiwi", startedAt: at("09:58"), minutes: 52 }, { app: "Microsoft Word", title: "HVHP redline.docx", startedAt: at("10:55"), minutes: 48 }] }),
        entry("12:30", 18, "Conference with T. Navarro regarding licensure matrix format.", { activityCode: "A105", work: [{ app: "Microsoft Teams", title: "Rosa / Theo: Northlake licensure matrix", startedAt: at("12:30"), minutes: 18 }] }),
        entry("13:05", 95, "Research telehealth licensure and prescribing rules for six states; prepare licensure and prescribing matrix for MAT program.", { activityCode: "A102",
            work: [{ app: "Google Chrome", title: "research", startedAt: at("13:05"), minutes: 41 }, { app: "Microsoft Excel", title: "matrix.xlsx", startedAt: at("13:52"), minutes: 54 }] }),
        entry("14:55", 26, "Review Northlake 42 CFR Part 2 consent form and BAA template.", { activityCode: "A104" }),
        entry("16:10", 15, "Telephone conference with P. Raman regarding California timing.", { status: "suggested" }),
        entry("16:31", 11, "", { status: "flagged", projectID: null, billable: false }),
    ];
    return w;
}

const terms: InvoiceTerms = { firm: { name: "Firm", address: [] }, billTo: [], client: "61407", matter: "61407-002", matterName: "x", number: "712418", through: "October 31, 2026",
    rateCap: 1075, noChargeActivity: "A105", noChargeRule: "Northlake OCG §5.1", terms: "Due within 30 days", timekeeper: { name: "R. Delacroix", title: "Partner" } };

describe("invoice", () => {
    it("caps the rate, bills the internal conference at no charge, splits the block-billed entry, leaves out what is not settled", () => {
        const w = rosa();
        const lines = feeLines(w, terms, activeRules(w, terms));
        expect(totals(feeLines(w, terms, []))).toEqual({ hours: 4.7, billedHours: 4.7, fees: 5616.5 });
        expect(lines.map((l) => l.hours)).toEqual([0.6, 1.7, 0.3, 0.7, 0.9, 0.5]);
        expect(lines.every((l) => l.rate === 1075)).toBe(true);
        expect(lines[2]).toMatchObject({ noCharge: true, amount: 0, note: "No charge per Northlake OCG §5.1" });
        expect(lines[3].description).toBe("Research telehealth licensure and prescribing rules for six states.");
        expect(lines[4].description).toBe("Prepare licensure and prescribing matrix for MAT program.");
        expect(totals(lines)).toEqual({ hours: 4.7, billedHours: 4.4, fees: 4730 });
    });

    it("rounds captured minutes up to the tenth", () => {
        expect([tenths(36), tenths(41), tenths(54), tenths(95), tenths(100), tenths(6)]).toEqual([0.6, 0.7, 0.9, 1.6, 1.7, 0.1]);
    });
});

describe("importing typed entries", () => {
    const csv = "date,matter,timekeeper,hours,description\n2026-10-26,61407-002,R. Delacroix,0.9,phone call with client\n2026-10-26,61407-002,R. Delacroix,1.5,HVHP agmt\n"
        + "2026-10-26,61407-002,R. Delacroix,0.3,Theo\n2026-10-26,61407-002,R. Delacroix,2.0,research / matrix\n2026-10-26,61407-002,R. Delacroix,0.5,consent\n10/26/2026,61407-002,R. Delacroix,1.0,\"lunch, with \"\"friends\"\"\"\n";

    it("reads CSV with quotes and US dates", () => {
        const rows = typedRows(parseCsv(csv));
        expect(rows).toHaveLength(6);
        expect(rows[5]).toMatchObject({ date: "2026-10-26", description: 'lunch, with "friends"', hours: 1 });
        expect(normalizeDate("46321")).toBe("2026-10-26");
    });

    it("reads a messy sheet: title and blank rows above the header, odd column names, short dates and hours, a total row", () => {
        const table = [["RD time - wk of 10/26"], [], ["Date", "Client / Matter", "What", "Hrs", "Atty"],
            ["10/26", "Northlake", "phone call with client", ".9", "RD"], ["Oct 26", "61407-002", "rev HVHP v3 + redline (exh B, cred, termination)", "1.5h", "RD"],
            [], ["10/26", "Northlake", "telehealth research NY/CA/TX/FL; matrix", "120m", "RD"], ["10/26", "Northlake", "call PR re CA", ".25", "RD"], ["", "", "Total", "4.65", ""]];
        const rows = typedRows(table, 2026);
        expect(rows.map((r) => [r.date, r.matter, r.hours])).toEqual([["2026-10-26", "Northlake", 0.9], ["2026-10-26", "61407-002", 1.5], ["2026-10-26", "Northlake", 2], ["2026-10-26", "Northlake", 0.25]]);
        const w = rosa();
        const out = matchRows(w, rows, (k) => `m${k}`);
        const first = (id: string | null) => w.entries.find((e) => e.id === id)?.description.split(" ")[0] ?? null;
        expect(out.map((r) => first(r.entryID))).toEqual(["Teams", "Review", "Research", "Telephone"]);
    });

    it("pairs each typed row with the captured entry it describes, one to one, and leaves what matches nothing", () => {
        const w = rosa();
        const out = matchRows(w, typedRows(parseCsv(csv)), (k) => `r${k}`);
        const narrativeOf = (id: string | null) => w.entries.find((e) => e.id === id)?.description.split(" ")[0] ?? null;
        expect(out.map((r) => narrativeOf(r.entryID))).toEqual(["Teams", "Review", "Conference", "Research", "Review", null]);
        expect(out[1].entryID).not.toBe(out[4].entryID);
    });
});
