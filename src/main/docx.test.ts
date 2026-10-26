import { describe, expect, it } from "vitest";
import { applyRules, uiRows } from "@shared/applyRules";
import { invoiceHtml, invoiceRows, timeSheetHtml } from "@shared/invoiceHtml";
import { manattDay } from "../shared/__fixtures__/manattDay";
import { docxRows, timeSheetDocx } from "./docx";
import { unzip } from "./xlsx";

const day = "2026-10-26";
const pick = (r: { entryId: string; part: number | null; hours: number; rate: number; amount: number; noCharge: boolean; narrative: string }) =>
    ({ entryId: r.entryId, part: r.part, hours: r.hours, rate: r.rate, amount: r.amount, noCharge: r.noCharge, narrative: r.narrative });
/** The text a Word XML part reads as, tags taken out. */
const words = (xml: string): string => xml.replace(/<w:p[ >]/g, "\n$&").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("one applied bill behind every view", () => {
    for (const [mode, fees] of [["generic", 5616.5], ["northlake", 4730], ["kestrel", 4577]] as const) {
        it(`${mode}: the Time page, the invoice and the DOCX print the same lines, ${fees.toFixed(2)} in all`, () => {
            const bill = applyRules(manattDay(), day, mode);
            expect(bill.totals.fees).toBe(fees);
            const ui = uiRows(bill).map(pick);
            expect(invoiceRows(bill).map(pick)).toEqual(ui);
            expect(docxRows(bill).map(pick)).toEqual(ui);
        });
    }

    it("says whose rules were applied: the matter's own client's, or another client's for comparison, billed to Northlake either way", () => {
        const w = manattDay();
        const at = new Date(`${day}T12:00:00`);
        const northlake = invoiceHtml(w, w.invoice!, null, at, applyRules(w, day, "northlake"));
        expect(northlake).toContain("<br />Northlake Behavioral Health billing rules applied</p>");
        const kestrel = invoiceHtml(w, w.invoice!, null, at, applyRules(w, day, "kestrel"));
        expect(kestrel).toContain("<br />Kestrel Valley Health rules applied to this matter for comparison.</p>");
        expect(kestrel).toMatch(/<p class="label">Bill to<\/p><p>Northlake Behavioral Health, Inc\.<\/p>/);
        expect(timeSheetHtml(w, w.invoice!, null, applyRules(w, day, "kestrel"))).toContain("Kestrel Valley Health rules applied to this matter for comparison.");
        expect(timeSheetHtml(w, w.invoice!, null, applyRules(w, day, "generic"))).toContain("Generic: standard rates, no client rules applied");
    });

    it("prints the seed's remittance lines and contact, and placeholders without them", () => {
        const w = manattDay();
        const terms = { ...w.invoice!, remit: ["Check: Lockbox 1", "Wire: Bank 2", "ACH: Bank 3"], contact: "Questions: billing desk" };
        const html = invoiceHtml(w, terms, null, new Date(`${day}T12:00:00`), applyRules(w, day, "northlake"));
        expect(html).toContain("Check: Lockbox 1<br />Wire: Bank 2<br />ACH: Bank 3</div>");
        expect(html).toContain("<br />Questions: billing desk</p>");
        expect(invoiceHtml(w, w.invoice!, null, new Date(`${day}T12:00:00`), applyRules(w, day, "northlake"))).toContain("[lockbox address]");
    });

    it("the invoice shows the total due on page 1, beside the invoice number", () => {
        const w = manattDay();
        const html = invoiceHtml(w, w.invoice!, null, new Date(`${day}T12:00:00`), applyRules(w, day, "northlake"));
        expect(html).toMatch(/<tr class="due-row"><td>Total due<\/td><td>\$4,730\.00<\/td><\/tr>/);
        expect(html.indexOf("due-row")).toBeLessThan(html.indexOf("Fee detail"));
    });
});

describe("the DOCX time sheet under Northlake's rules", async () => {
    const w = manattDay();
    const buf = await timeSheetDocx(w, w.invoice!, null, new Date(`${day}T22:00:00Z`), applyRules(w, day, "northlake"));
    const files = unzip(buf);
    const doc = files.get("word/document.xml")!.toString("utf8");
    const comments = words(files.get("word/comments.xml")!.toString("utf8"));

    it("is marked up as tracked changes by Lawdie, with a comment on each changed cell", () => {
        expect(doc).toMatch(/<w:ins [^>]*w:author="Lawdie"/);
        expect(doc).toMatch(/<w:del [^>]*w:author="Lawdie"/);
        expect(comments).toContain("NBH-3 Northlake OCG §3.1: Rate $1,195.00 changed to $1,075.00.");
    });

    it("keeps the internal conference at 0.3 h at no charge, and cites only the rule that took the charge off", () => {
        expect(doc).not.toMatch(/>0\.0</);
        const nc = comments.split("\n").find((l) => l.includes("changed to no charge"))!;
        expect(nc).toMatch(/^NBH-2 Northlake OCG §5\.1: Amount \$358\.50 changed to no charge\.$/);
    });

    it("names Northlake's own rules under the title", () => {
        expect(words(doc)).toContain("Northlake Behavioral Health billing rules applied as tracked changes by Lawdie.");
    });

    it("says the split in a readable sentence", () => {
        expect(comments).toMatch(/Split into 2 lines, one per task: 0\.7 h “C200 Research telehealth licensure [^”]+Florida\.” and 0\.9 h “C200 Review and revise six-state licensure[^”]+\.”/);
        expect(comments).not.toMatch(/Florida\. and/);
    });
});

describe("the DOCX time sheet under Kestrel's rules on a Northlake matter", async () => {
    const w = manattDay();
    const buf = await timeSheetDocx(w, w.invoice!, null, new Date(`${day}T22:00:00Z`), applyRules(w, day, "kestrel"));
    const doc = words(unzip(buf).get("word/document.xml")!.toString("utf8"));

    it("says the rules are applied for comparison", () => {
        expect(doc).toContain("Kestrel Valley Health rules applied to this matter for comparison, as tracked changes by Lawdie.");
    });
});
