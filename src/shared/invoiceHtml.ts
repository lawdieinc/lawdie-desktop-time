/* The time sheet and invoice as HTML, printed to PDF by the main process in a hidden window.
   Both render the applied bill (src/shared/applyRules.ts) as given: the same lines, figures and
   narratives the Time page shows. Nothing here computes a line. */

import { money } from "./invoice";
import type { AppliedBill, AppliedLine } from "./applyRules";
import type { InvoiceTerms, Workspace } from "./model";

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STYLE = `
@page { size: Letter; margin: 0.75in 0.8in; }
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.45 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #222; }
.top { display: flex; justify-content: space-between; align-items: flex-start; }
.logo { width: 1.0in; height: auto; display: block; }
.firm { text-align: right; font-size: 9pt; color: #444; }
.firm strong { color: #222; font-size: 10pt; }
h1 { font-size: 16pt; font-weight: 600; margin: 28pt 0 4pt; }
.sub { color: #555; margin: 0 0 18pt; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 8pt; letter-spacing: 0.06em; text-transform: uppercase; color: #666; font-weight: 600; padding: 0 8pt 7pt; border-bottom: 1pt solid #999; }
td { padding: 9pt 8pt; border-bottom: 0.5pt solid #d8d8d8; vertical-align: top; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.nc { color: #777; font-style: italic; }
.total td { border-bottom: 0; border-top: 1pt solid #999; font-weight: 600; padding-top: 10pt; }
.blocks { display: flex; justify-content: space-between; gap: 24pt; margin: 22pt 0 18pt; }
.block p { margin: 0; } .block .label { font-size: 8pt; letter-spacing: 0.06em; text-transform: uppercase; color: #666; margin-bottom: 4pt; }
.meta td { border: 0; padding: 1pt 0 1pt 12pt; } .meta td:first-child { color: #666; padding-left: 0; }
.meta tr.due-row td { padding-top: 6pt; font-weight: 700; color: #222; }
h2 { font-size: 10pt; letter-spacing: 0.06em; text-transform: uppercase; color: #444; margin: 22pt 0 8pt; }
.due { margin-left: auto; width: 46%; margin-top: 14pt; } .due td { border: 0; padding: 4pt 8pt; } .due .grand td { border-top: 1pt solid #222; font-weight: 700; font-size: 11pt; }
.remit { margin-top: 18pt; padding: 10pt 14pt; border: 0.75pt solid #ccc; border-radius: 4pt; font-size: 9pt; color: #444; }
.keep { break-inside: avoid; }
.sheet td { padding: 7pt 8pt; } .sheet table { table-layout: fixed; } .sheet th:nth-child(1) { width: 13%; } .sheet th:nth-child(2) { width: 15%; } .sheet th:nth-child(3) { width: 7%; } .sheet td:nth-child(2) { white-space: nowrap; } .sheet th:nth-child(4) { width: 12%; } .sheet th:nth-child(5) { width: 12%; } .sheet h1 { margin-top: 22pt; }
.invoice td { padding: 6pt 8pt; } .invoice .meta td { padding: 1pt 0 1pt 14pt; } .invoice .meta td:first-child { padding-left: 0; } .invoice h1 { margin-top: 18pt; } .invoice h2 { margin: 16pt 0 6pt; } .invoice .blocks { margin: 16pt 0 12pt; }
`;

/** The footer line printToPDF puts on every page, with page numbers. */
export function footerTemplate(terms: InvoiceTerms): string {
    return `<div style="width:100%;font:7pt Helvetica,Arial,sans-serif;color:#888;text-align:center;padding:0 0.8in">${terms.footer ? `${esc(terms.footer)} · ` : ""}Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
}

const head = (terms: InvoiceTerms, logo: string | null): string => `
<div class="top">
  ${logo ? `<img class="logo" src="${logo}" alt="${esc(terms.firm.name)}" />` : `<strong>${esc(terms.firm.name)}</strong>`}
  <div class="firm"><strong>${esc(terms.firm.name)}</strong><br />${terms.firm.address.map(esc).join("<br />")}</div>
</div>`;

const page = (title: string, body: string, cls = ""): string =>
    `<!doctype html><html><head><meta charset="utf-8" /><title>${esc(title)}</title><style>${STYLE}</style></head><body class="${cls}">${body}</body></html>`;

/** What the invoice prints for each line, straight from the applied bill. */
export function invoiceRows(bill: AppliedBill): { entryId: string; part: number | null; hours: number; rate: number; amount: number; noCharge: boolean; narrative: string; note: string | null; date: string; timekeeper: string }[] {
    return bill.lines.map((l: AppliedLine) => ({ entryId: l.entryId, part: l.part, hours: l.hours, rate: l.rate, amount: l.amount, noCharge: l.noCharge, narrative: l.narrative, note: l.note, date: l.date, timekeeper: l.timekeeper }));
}

/** "Northlake Behavioral Health": a client's name without its corporate ending. */
const plainClient = (name: string): string => name.replace(/,?\s+(Inc|LLC|L\.L\.C|LLP|Ltd|Corp|Corporation|Co|P\.?C)\.?$/i, "").trim();

/** The client the matter is billed to: the project of the bill's entries, else the invoice's bill-to. */
function matterClient(w: Workspace, terms: InvoiceTerms, bill: AppliedBill): string {
    const first = bill.lines[0] ? w.entries.find((e) => e.id === bill.lines[0].entryId) : undefined;
    const project = (first && w.projects.find((p) => p.id === first.projectID)) || w.projects.find((p) => !!terms.matter && p.name.startsWith(terms.matter));
    return project?.client || terms.billTo[0] || "";
}

/**
 * Whose rules shaped the bill: the rulebook's client, and whether that client is the matter's own.
 * Another client's rules (Kestrel's on a Northlake matter) are a comparison; the bill still goes to
 * the matter's client. Null for generic billing.
 */
export function rulesBasis(w: Workspace, terms: InvoiceTerms, bill: AppliedBill): { name: string; own: boolean } | null {
    if (!bill.book) return null;
    const name = plainClient(bill.book.client);
    const matter = matterClient(w, terms, bill);
    return { name, own: !matter || plainClient(matter).toLowerCase() === name.toLowerCase() };
}

/** The line under the title on the time sheet and the invoice that says whose rules were applied. */
export function rulesLine(w: Workspace, terms: InvoiceTerms, bill: AppliedBill): string | null {
    const b = rulesBasis(w, terms, bill);
    return b ? (b.own ? `${b.name} billing rules applied` : `${b.name} rules applied to this matter for comparison.`) : null;
}

/** "Time detail: Rosa Delacroix": every settled line of the day with hours, rate and amount. */
export function timeSheetHtml(w: Workspace, terms: InvoiceTerms, logo: string | null, bill: AppliedBill): string {
    const rows = invoiceRows(bill);
    const t = bill.totals;
    const who = w.profile?.name ?? terms.timekeeper.name;
    const body = rows.map((l) => `<tr><td>${l.date}</td><td>${esc(l.timekeeper)}</td><td class="num">${l.hours.toFixed(1)}</td><td class="num">${money(l.rate)}</td><td class="num">${l.noCharge ? `<span class="nc">No charge</span>` : money(l.amount)}</td><td>${esc(l.narrative)}${l.note ? `<br /><span class="nc">${esc(l.note)}</span>` : ""}</td></tr>`).join("");
    return page(`Time detail ${terms.matter}`, `${head(terms, logo)}
<h1>Time detail: ${esc(who)}</h1>
<p class="sub">${esc(terms.matter)} ${esc(terms.matterName)} · ${rows[0]?.date ?? ""}<br />${esc(rulesLine(w, terms, bill) ?? "Generic: standard rates, no client rules applied")}</p>
<table><thead><tr><th>Date</th><th>Timekeeper</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th><th>Description</th></tr></thead>
<tbody>${body}<tr class="total"><td colspan="2">Total</td><td class="num">${t.hours.toFixed(1)}${t.billedHours !== t.hours ? ` <span class="nc">(${t.billedHours.toFixed(1)} billed)</span>` : ""}</td><td></td><td class="num">${money(t.fees)}</td><td></td></tr></tbody></table>`, "sheet");
}

const remitLines = (terms: InvoiceTerms): string[] =>
    !terms.remit ? ["Check: [lockbox address]", "Wire: [bank name], account [account number], ABA [routing number]"] : Array.isArray(terms.remit) ? terms.remit : terms.remit.split("\n");

/** The invoice: firm, bill-to, numbers and the total due on page 1, fee detail, timekeeper summary, terms, remittance. */
export function invoiceHtml(w: Workspace, terms: InvoiceTerms, logo: string | null, today: Date, bill: AppliedBill): string {
    const rows = invoiceRows(bill);
    const t = bill.totals;
    const rate = rows.find((l) => !l.noCharge)?.rate ?? 0;
    const date = today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const body = rows.map((l) => `<tr><td>${l.date}</td><td>${esc(l.timekeeper)}</td><td>${esc(l.narrative)}${l.note ? `<br /><span class="nc">${esc(l.note)}</span>` : ""}</td><td class="num">${l.hours.toFixed(1)}</td><td class="num">${l.noCharge ? `<span class="nc">No charge</span>` : money(l.amount)}</td></tr>`).join("");
    return page(`Invoice ${terms.number}`, `${head(terms, logo)}
<div class="blocks">
  <div class="block"><p class="label">Bill to</p>${terms.billTo.map((x) => `<p>${esc(x)}</p>`).join("")}</div>
  <table class="meta" style="width:auto"><tbody>
    <tr><td>Invoice</td><td>${esc(terms.number)}</td></tr><tr><td>Invoice date</td><td>${esc(date)}</td></tr>
    <tr><td>Client</td><td>${esc(terms.client)}</td></tr><tr><td>Matter</td><td>${esc(terms.matter)}</td></tr>
    <tr class="due-row"><td>Total due</td><td>${money(t.fees)}</td></tr>
  </tbody></table>
</div>
<p><strong>${esc(terms.matterName)}</strong></p>
<p class="sub">For professional services rendered through ${esc(terms.through)}<br />${esc(rulesLine(w, terms, bill) ?? "Generic invoice: standard rates, no client rules applied")}</p>
<h2>Fee detail</h2>
<table><thead><tr><th>Date</th><th>Timekeeper</th><th>Description</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead><tbody>${body}</tbody></table>
<div class="keep"><h2>Timekeeper summary</h2>
<table><thead><tr><th>Timekeeper</th><th>Title</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
<tbody><tr><td>${esc(terms.timekeeper.name)}</td><td>${esc(terms.timekeeper.title)}</td><td class="num">${t.billedHours.toFixed(1)}</td><td class="num">${money(rate)}</td><td class="num">${money(t.fees)}</td></tr></tbody></table>
<table class="due"><tbody><tr><td>Total fees</td><td class="num">${money(t.fees)}</td></tr><tr class="grand"><td>Total due</td><td class="num">${money(t.fees)}</td></tr></tbody></table>
<p class="sub" style="text-align:right;margin-top:6pt">Payment terms: ${esc(terms.terms)}${terms.contact ? `<br />${esc(terms.contact)}` : ""}</p>
<div class="remit"><strong>Remittance</strong><br />Please reference invoice ${esc(terms.number)} with your payment.<br />${remitLines(terms).map(esc).join("<br />")}</div></div>`, "invoice");
}
