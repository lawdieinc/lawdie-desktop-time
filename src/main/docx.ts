/* "Time sheet (DOCX)": the day's time detail, rendered from the applied bill
   (src/shared/applyRules.ts), the same lines the Time page and the invoice show. Generic: a
   plain table at standard rates. With a client's rulebook applied: each change as Word tracked
   changes by "Lawdie" (the standard figure deleted, the figure under the rule inserted; a code
   or a task's time inserted into the narrative; a block-billed entry split into an inserted
   row), and a comment on each changed cell that cites the rule that changed that cell, says
   what changed and quotes the rule. A line a rule bills at no charge keeps its hours. Rules
   that changed nothing are listed at the end. */

import {
    AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, DeletedTextRun, Document, Header, ImageRun,
    InsertedTextRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type ICommentOptions, type ParagraphChild,
} from "docx";
import { changesOf, linesByEntry, type AppliedBill, type AppliedChange, type AppliedLine } from "@shared/applyRules";
import { ruleReports } from "@shared/clientRules";
import { citeOf, money } from "@shared/invoice";
import { rulesBasis } from "@shared/invoiceHtml";
import type { ClientRule, InvoiceTerms, Workspace } from "@shared/model";

const AUTHOR = "Lawdie";
const FONT = "Arial";
const GREY = "BFBFBF";
const COLS = [1080, 1240, 760, 1300, 1340, 3640]; // twips; 9360 = 6.5 in

/** What the DOCX prints for each line, after the rules: straight from the applied bill. */
export function docxRows(bill: AppliedBill): { entryId: string; part: number | null; hours: number; rate: number; amount: number; noCharge: boolean; narrative: string }[] {
    return bill.lines.map((l) => ({ entryId: l.entryId, part: l.part, hours: l.hours, rate: l.rate, amount: l.amount, noCharge: l.noCharge, narrative: l.narrative }));
}

export async function timeSheetDocx(w: Workspace, terms: InvoiceTerms, logo: Buffer | null, now: Date, bill: AppliedBill): Promise<Buffer> {
    const book = bill.book;
    const date = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    let rev = 1;
    const comments: ICommentOptions[] = [];
    const byId = new Map((book?.rules ?? []).map((r) => [r.id, r]));
    const text = (t: string, o: { bold?: boolean; color?: string; size?: number } = {}) => new TextRun({ text: t, font: FONT, size: o.size ?? 17, bold: o.bold, color: o.color });
    const del = (t: string) => new DeletedTextRun({ text: t, font: FONT, size: 17, id: rev++, author: AUTHOR, date });
    const ins = (t: string, below = false) => new InsertedTextRun({ text: t, font: FONT, size: 17, id: rev++, author: AUTHOR, date, ...(below ? { break: 1 } : {}) });
    /** A comment: the rule ids and sections that changed the cell and what changed, then each rule's words. */
    const comment = (ruleIDs: string[], change: string): number => {
        const id = comments.length;
        const found = [...new Set(ruleIDs)].map((rid) => byId.get(rid)).filter((r): r is ClientRule => !!r);
        const cite = found.map((r) => `${r.id} ${citeOf(r, w, book)}`).join("; ");
        comments.push({ id, author: AUTHOR, initials: "L", date: now, children: [
            new Paragraph({ children: [new TextRun({ text: cite ? `${cite}: ` : "", font: FONT, size: 16, bold: true }), new TextRun({ text: change, font: FONT, size: 16 })] }),
            ...found.map((r) => new Paragraph({ children: [new TextRun({ text: `“${r.quote}”`, font: FONT, size: 16, italics: true })] })),
        ] });
        return id;
    };
    const commented = (id: number, runs: ParagraphChild[]): ParagraphChild[] => [new CommentRangeStart(id), ...runs, new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] })];
    const cell = (children: ParagraphChild[], col: number, right = false, opts: { shade?: boolean } = {}) => new TableCell({
        width: { size: COLS[col], type: WidthType.DXA },
        margins: { top: 90, bottom: 90, left: 100, right: 100 },
        shading: opts.shade ? { fill: "F2F2F2" } : undefined,
        children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children })],
    });
    const amountOf = (l: AppliedLine): string => (l.noCharge ? "No charge" : money(l.amount).slice(1));
    const stdAmountOf = (l: AppliedLine): string => (l.std.amount === 0 && l.noCharge && !l.changes.some((c) => c.kind === "noCharge") ? "No charge" : money(l.std.amount).slice(1));
    const rulesOf = (cs: AppliedChange[], ...kinds: AppliedChange["kind"][]) => cs.filter((c) => kinds.includes(c.kind)).map((c) => c.ruleId);

    const rows: TableRow[] = [new TableRow({ tableHeader: true, children: ["Date", "Timekeeper", "Hours", "Rate", "Amount", "Description"].map((h, n) => cell([text(h.toUpperCase(), { bold: true, size: 15, color: "595959" })], n, n >= 2 && n <= 4, { shade: true })) })];
    for (const lines of linesByEntry(bill).values()) {
        const a = lines[0];
        if (!book) {
            rows.push(new TableRow({ cantSplit: true, children: [cell([text(a.date)], 0), cell([text(a.timekeeper)], 1), cell([text(a.hours.toFixed(1))], 2, true), cell([text(money(a.rate).slice(1))], 3, true), cell([text(amountOf(a))], 4, true), cell([text(a.narrative)], 5)] }));
            continue;
        }
        const s = a.std;
        const cs = changesOf(lines);
        const split = lines.length > 1;
        // Hours: struck and replaced when a rule changed them (a call cut, a split part). No charge keeps them.
        const hourRules = rulesOf(cs, "hours", ...(split ? ["split" as const] : []));
        const hoursCell = a.hours.toFixed(1) !== s.hours.toFixed(1)
            ? commented(comment(hourRules, split ? `Hours ${s.hours.toFixed(1)} split into ${lines.map((l) => l.hours.toFixed(1)).join(" + ")}, each task with its own captured time.` : `Hours ${s.hours.toFixed(1)} changed to ${a.hours.toFixed(1)}.`), [del(s.hours.toFixed(1)), ins(a.hours.toFixed(1), true)])
            : [text(s.hours.toFixed(1))];
        const rateCell = a.rate !== s.rate ? commented(comment(rulesOf(cs, "rate"), `Rate ${money(s.rate)} changed to ${money(a.rate)}.`), [del(money(s.rate).slice(1)), ins(money(a.rate).slice(1), true)]) : [text(money(s.rate).slice(1))];
        // Amount: a line not billed cites only the rule that took the charge off; otherwise the rules behind the figures.
        const ncRules = rulesOf(cs, "noCharge");
        const amountRules = a.noCharge && ncRules.length ? ncRules : rulesOf(cs, "rate", "hours", ...(split ? ["split" as const] : []));
        const amountCell = amountOf(a) !== stdAmountOf(a)
            ? commented(comment(amountRules, `Amount ${money(s.amount)} changed to ${a.noCharge ? "no charge" : money(a.amount)}.`), [del(stdAmountOf(a)), ins(amountOf(a), true)])
            : [text(amountOf(a))];
        // The narrative: words a rule added are inserted; a split keeps the first task here and strikes the rest.
        let descRuns: ParagraphChild[] = a.segments.map((g) => (g.ins ? ins(g.text) : text(g.text)));
        if (split) {
            const first = a.segments.filter((g) => !g.ins).map((g) => g.text).join("").replace(/\.$/, "");
            const added = a.segments.filter((g) => g.ins).map((g) => ins(g.text));
            // The first task is the start of the narrative (split at its semicolon); a task written apart from it replaces it whole.
            descRuns = s.narrative.startsWith(first)
                ? [...added, text(first), del(s.narrative.slice(first.length)), ins(".")]
                : [...added, del(s.narrative), ins(`${first}.`)];
        }
        // A split entry's code changes belong to its lines: this row says the first task's, each inserted row its own.
        const own = split ? a.changes : cs;
        const textRules = [...rulesOf(own, "text"), ...(split ? rulesOf(cs, "split") : [])];
        const said = [
            ...own.filter((c) => c.kind === "text" && c.text).map((c) => `${c.text}.`),
            ...(split ? [`Split into ${lines.length} lines, one per task: ${lines.map((l) => `${l.hours.toFixed(1)} h “${l.narrative}”`).join(" and ")}`] : []),
        ].join(" ");
        const descCell = textRules.length ? commented(comment(textRules, said), descRuns) : descRuns;
        rows.push(new TableRow({ cantSplit: true, children: [cell([text(a.date)], 0), cell([text(a.timekeeper)], 1), cell(hoursCell, 2, true), cell(rateCell, 3, true), cell(amountCell, 4, true), cell(descCell, 5)] }));
        for (const p of lines.slice(1)) {
            const pSaid = [...p.changes.filter((c) => c.kind === "text" && c.text).map((c) => `${c.text}.`),
                `Task ${(p.part ?? 0) + 1} of ${lines.length} from the split entry, with its own captured time: ${p.hours.toFixed(1)} h.`].join(" ");
            const pDesc = commented(comment([...rulesOf(p.changes, "text"), ...rulesOf(p.changes, "split")], pSaid), p.segments.map((g) => ins(g.text)));
            rows.push(new TableRow({ cantSplit: true, insertion: { id: rev++, author: AUTHOR, date },
                children: [cell([ins(p.date)], 0), cell([ins(p.timekeeper)], 1), cell([ins(p.hours.toFixed(1))], 2, true), cell([ins(money(p.rate).slice(1))], 3, true), cell([ins(amountOf(p))], 4, true), cell(pDesc, 5)] }));
        }
    }
    const rule = { style: BorderStyle.SINGLE, size: 4, color: GREY };
    const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const table = new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: COLS, rows,
        borders: { top: rule, bottom: rule, left: none, right: none, insideHorizontal: rule, insideVertical: none } });

    const passing = book ? ruleReports(w, terms, book).filter((r) => r.rule.enabled && (r.status === "pass" || r.status === "none")) : [];
    const para = (runs: ParagraphChild[], o: { before?: number; after?: number } = {}) => new Paragraph({ spacing: { before: o.before ?? 0, after: o.after ?? 80 }, children: runs });
    const who = w.profile?.name ?? terms.timekeeper.name;
    const t = bill.totals;
    const basis = rulesBasis(w, terms, bill);
    const doc = new Document({
        creator: AUTHOR,
        title: `Time detail ${terms.matter}`,
        comments: { children: comments },
        styles: { default: { document: { run: { font: FONT, size: 18 } } } },
        sections: [{
            properties: { page: { margin: { top: 1300, bottom: 1100, left: 1440, right: 1440 } } },
            headers: { default: new Header({ children: [new Paragraph({ children: logo ? [new ImageRun({ type: "png", data: logo, transformation: { width: 96, height: 45 } })] : [text(terms.firm.name, { bold: true })] })] }) },
            children: [
                para([text(`Time detail: ${who}`, { bold: true, size: 30 })], { before: 120, after: 60 }),
                para([text(`${terms.matter} ${terms.matterName}`, { color: "595959", size: 18 })], { after: 40 }),
                para([text(`${bill.lines[0]?.date ?? ""} · ${basis ? `${basis.name} ${basis.own ? "billing rules applied" : "rules applied to this matter for comparison,"} as tracked changes by Lawdie. Each comment cites the rule.` : "Generic: standard rates, no client rules applied."}`, { color: "595959", size: 16 })], { after: 240 }),
                table,
                ...(book ? [
                    para([text("Total before rules: ", { bold: true }), text(`${bill.lines.reduce((n, l) => n + (l.part ? 0 : l.std.hours), 0).toFixed(1)} h, ${money(bill.standard)} at standard rates`)], { before: 240, after: 40 }),
                    para([text(`Total with ${book.short} rules: `, { bold: true }), text(`${t.billedHours.toFixed(1)} h billed, ${money(t.fees)}`)], { after: 240 }),
                    para([text("Checked, no change", { bold: true, size: 18 })], { after: 60 }),
                    ...passing.map((r) => para([text(`${r.rule.id} ${citeOf(r.rule, w, book)}, ${r.rule.title}: `, { bold: true, size: 16 }), text(`${r.summary}.`, { size: 16 })], { after: 30 })),
                ] : [para([text("Total: ", { bold: true }), text(`${t.hours.toFixed(1)} h, ${money(t.fees)}`)], { before: 240, after: 240 })]),
                ...(terms.footer ? [para([text(terms.footer, { color: "8C8C8C", size: 14 })], { before: 240 })] : []),
            ],
        }],
    });
    return Buffer.from(await Packer.toBuffer(doc));
}
