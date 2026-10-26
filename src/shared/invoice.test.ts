import { describe, expect, it } from "vitest";
import { activeRules, feeLines, tenths, totals } from "./invoice";
import { matchRows, normalizeDate, parseCsv, typedRows } from "./importMatch";
import { rosa, terms } from "./__fixtures__/rosaDay";

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
