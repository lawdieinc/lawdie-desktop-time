/* "Time sheet with rules (DOCX)": the day's time detail with each client rule that is on
   applied as Word tracked changes by "Lawdie" (the standard figure deleted, the figure under
   the rule inserted; a block-billed entry split into an inserted row), and a comment on each
   changed cell that cites the rule, quotes it and says what changed. The way a pre-bill is
   marked up for the billing specialist. Rules that changed nothing are listed at the end. */

import {
    AlignmentType, BorderStyle, CommentRangeEnd, CommentRangeStart, CommentReference, DeletedTextRun, Document, Header, ImageRun,
    InsertedTextRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type ICommentOptions, type ParagraphChild,
} from "docx";
import { ruleReports } from "@shared/clientRules";
import { activeRules, citeOf, feeLines, money, totals, type FeeLine } from "@shared/invoice";
import type { ClientRule, InvoiceTerms, Workspace } from "@shared/model";

const AUTHOR = "Lawdie";
const FONT = "Arial";
const GREY = "BFBFBF";
const COLS = [1080, 1240, 760, 1300, 1340, 3640]; // twips; 9360 = 6.5 in

export async function timeSheetDocx(w: Workspace, terms: InvoiceTerms, logo: Buffer | null, now: Date): Promise<Buffer> {
    const date = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    let rev = 1;
    const comments: ICommentOptions[] = [];
    const rules = activeRules(w, terms);
    const byId = new Map((w.clientRules?.rules ?? []).map((r) => [r.id, r]));
    const std = feeLines(w, terms, []);
    const billed = feeLines(w, terms, rules);
    const text = (t: string, o: { bold?: boolean; color?: string; size?: number } = {}) => new TextRun({ text: t, font: FONT, size: o.size ?? 17, bold: o.bold, color: o.color });
    const del = (t: string) => new DeletedTextRun({ text: t, font: FONT, size: 17, id: rev++, author: AUTHOR, date });
    const ins = (t: string, below = false) => new InsertedTextRun({ text: t, font: FONT, size: 17, id: rev++, author: AUTHOR, date, ...(below ? { break: 1 } : {}) });
    /** A comment: the rule's id and section, its words, then the change. */
    const comment = (ruleIDs: string[], change: string): number => {
        const id = comments.length;
        // Cite the rule and state the change first (what a billing specialist acts on), then quote the client's words.
        const found = ruleIDs.map((rid) => byId.get(rid)).filter((r): r is ClientRule => !!r);
        const cite = found.map((r) => `${r.id} ${citeOf(r, w)}`).join("; ");
        const paras = [
            new Paragraph({ children: [new TextRun({ text: `${cite ? `${cite}: ` : ""}`, font: FONT, size: 16, bold: true }), new TextRun({ text: change, font: FONT, size: 16 })] }),
            ...found.map((r) => new Paragraph({ children: [new TextRun({ text: `“${r.quote}”`, font: FONT, size: 16, italics: true })] })),
        ];
        comments.push({ id, author: AUTHOR, initials: "L", date: now, children: paras });
        return id;
    };
    const commented = (id: number, runs: ParagraphChild[]): ParagraphChild[] => [new CommentRangeStart(id), ...runs, new CommentRangeEnd(id), new TextRun({ children: [new CommentReference(id)] })];
    const cell = (children: ParagraphChild[], col: number, right = false, opts: { shade?: boolean } = {}) => new TableCell({
        width: { size: COLS[col], type: WidthType.DXA },
        margins: { top: 90, bottom: 90, left: 100, right: 100 },
        shading: opts.shade ? { fill: "F2F2F2" } : undefined,
        children: [new Paragraph({ alignment: right ? AlignmentType.RIGHT : AlignmentType.LEFT, children })],
    });
    const amountOf = (l: FeeLine): string => (l.noCharge ? "No charge" : money(l.amount).slice(1));
    const changedBy = (l: FeeLine, kinds: ClientRule["kind"][]): string[] => l.changes.filter((id) => kinds.includes(byId.get(id)?.kind ?? (id === "rate" ? "rateCap" : id === "nc" ? "noCharge" : "split")));

    const rows: TableRow[] = [new TableRow({ tableHeader: true, children: ["Date", "Timekeeper", "Hours", "Rate", "Amount", "Description"].map((h, n) => cell([text(h.toUpperCase(), { bold: true, size: 15, color: "595959" })], n, n >= 2 && n <= 4, { shade: true })) })];
    for (const id of [...new Set(std.map((l) => l.entryID))]) {
        const s = std.find((l) => l.entryID === id)!;
        const after = billed.filter((l) => l.entryID === id);
        const a = after[0];
        if (!a) continue;
        const split = after.length > 1;
        // Hours: the standard figure, struck through and replaced when a rule changed it (a split part, a no-charge line).
        const ncBy = changedBy(a, ["noCharge", "notBilled"]);
        const newHours = ncBy.length ? "0.0" : a.hours.toFixed(1);
        const hoursCell = newHours !== s.hours.toFixed(1)
            ? commented(comment(split ? changedBy(a, ["split"]) : ncBy, split ? `Hours ${s.hours.toFixed(1)} split: ${after.map((l) => l.hours.toFixed(1)).join(" + ")}, each from its own captured time.` : `Hours ${s.hours.toFixed(1)} to 0.0: not billed under this rule.`), [del(s.hours.toFixed(1)), ins(newHours, true)])
            : [text(s.hours.toFixed(1))];
        const rateBy = changedBy(a, ["rateCap"]);
        const rateCell = a.rate !== s.rate ? commented(comment(rateBy, `Rate ${money(s.rate)} changed to ${money(a.rate)}.`), [del(money(s.rate).slice(1)), ins(money(a.rate).slice(1), true)]) : [text(money(s.rate).slice(1))];
        const amountCell = amountOf(a) !== amountOf(s)
            ? commented(comment([...new Set([...ncBy, ...rateBy, ...(split ? changedBy(a, ["split"]) : [])])], `Amount ${money(s.amount)} changed to ${a.noCharge ? "no charge" : money(a.amount)}.`), [del(amountOf(s)), ins(amountOf(a), true)])
            : [text(amountOf(s))];
        let descCell: ParagraphChild[] = [text(s.description)];
        if (split) {
            // Keep the first task; strike the rest, which moves to its own inserted row below.
            const first = a.description.replace(/\.$/, "");
            const rest = s.description.slice(first.length);
            descCell = commented(comment(changedBy(a, ["split"]), `Block-billed entry split into ${after.length} lines, one per task: ${after.map((l) => `${l.hours.toFixed(1)} h ${l.description}`).join(" and ")}`), [text(first), del(rest), ins(".")]);
        }
        rows.push(new TableRow({ cantSplit: true, children: [cell([text(s.date)], 0), cell([text(s.timekeeper)], 1), cell(hoursCell, 2, true), cell(rateCell, 3, true), cell(amountCell, 4, true), cell(descCell, 5)] }));
        for (const p of after.slice(1)) {
            rows.push(new TableRow({ cantSplit: true, insertion: { id: rev++, author: AUTHOR, date },
                children: [cell([ins(p.date)], 0), cell([ins(p.timekeeper)], 1), cell([ins(p.hours.toFixed(1))], 2, true), cell([ins(money(p.rate).slice(1))], 3, true), cell([ins(amountOf(p))], 4, true), cell([ins(p.description)], 5)] }));
        }
    }
    const before = totals(std), afterT = totals(billed);
    const rule = { style: BorderStyle.SINGLE, size: 4, color: GREY };
    const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const table = new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: COLS, rows,
        borders: { top: rule, bottom: rule, left: none, right: none, insideHorizontal: rule, insideVertical: none } });

    const passing = ruleReports(w, terms).filter((r) => r.rule.enabled && (r.status === "pass" || r.status === "none"));
    const para = (runs: ParagraphChild[], o: { before?: number; after?: number } = {}) => new Paragraph({ spacing: { before: o.before ?? 0, after: o.after ?? 80 }, children: runs });
    const who = w.profile?.name ?? terms.timekeeper.name;
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
                para([text(`${std[0]?.date ?? ""} · ${w.clientRules?.client ?? "Client"} billing rules applied as tracked changes by Lawdie. Each comment cites the rule.`, { color: "595959", size: 16 })], { after: 240 }),
                table,
                para([text("Total before rules: ", { bold: true }), text(`${before.hours.toFixed(1)} h, ${money(before.fees)} at standard rates`)], { before: 240, after: 40 }),
                para([text("Total with rules: ", { bold: true }), text(`${afterT.billedHours.toFixed(1)} h billed, ${money(afterT.fees)}`)], { after: 240 }),
                para([text("Checked, no change", { bold: true, size: 18 })], { after: 60 }),
                ...passing.map((r) => para([text(`${r.rule.id} ${citeOf(r.rule, w)}, ${r.rule.title}: `, { bold: true, size: 16 }), text(`${r.summary}.`, { size: 16 })], { after: 30 })),
                ...(terms.footer ? [para([text(terms.footer, { color: "8C8C8C", size: 14 })], { before: 240 })] : []),
            ],
        }],
    });
    return Buffer.from(await Packer.toBuffer(doc));
}
