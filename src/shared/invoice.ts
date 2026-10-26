/* The day's time sheet and invoice, from the kept entries and the client's billing rules
   (workspace.invoice, written by a demo seed). Pure: the main process renders the HTML in a
   hidden window and prints it to PDF.

   Rules applied, in order: only settled entries bill (a suggestion waits for Confirm, a
   flagged entry for a matter); the rate is capped at the engagement-letter panel rate; an
   internal conference (the no-charge activity code) bills at no charge; an entry that joins
   two tasks with a semicolon is split into one line per task, each with its own captured time. */

import { seconds, type InvoiceTerms, type TimeEntry, type Workspace } from "./model";

export type FeeLine = { entryID: string; date: string; timekeeper: string; description: string; hours: number; rate: number; amount: number; noCharge: boolean; note: string | null };

/** Billing hours: captured time rounded up to the tenth. */
export const tenths = (minutes: number): number => Math.ceil(Math.round(minutes * 100) / 100 / 6 - 1e-9) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Entries that bill: on a matter, settled (no open suggestion or flag), billable. */
export function billable(w: Workspace): TimeEntry[] {
    return w.entries.filter((e) => e.projectID && (!e.status || e.status === "draft") && e.description.trim())
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

const sentence = (t: string): string => { const s = t.trim().replace(/[.;]+$/, ""); return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : s; };
const usDate = (iso: string): string => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };

/** One line per task, with hours, rate and amount after the client's rules. */
export function feeLines(w: Workspace, terms: InvoiceTerms): FeeLine[] {
    const out: FeeLine[] = [];
    for (const e of billable(w)) {
        const rate = Math.min(e.hourlyRate, terms.rateCap ?? Infinity);
        const internal = !!terms.noChargeActivity && e.activityCode === terms.noChargeActivity;
        const noCharge = internal || !e.billable;
        const note = internal ? `No charge per ${terms.noChargeRule ?? "client rules"}` : !e.billable ? "No charge" : null;
        const hours = e.hours ?? tenths(seconds(e) / 60);
        const tasks = e.description.split(/;\s+/);
        const base = { entryID: e.id, date: usDate(e.startedAt), timekeeper: terms.timekeeper.name, rate, noCharge, note };
        if (tasks.length > 1 && e.work && e.work.length === tasks.length) {
            // Block billing split: each task takes the captured time of its own stretch.
            tasks.forEach((t, n) => { const h = tenths(e.work![n].minutes); out.push({ ...base, description: sentence(t), hours: h, amount: noCharge ? 0 : round2(h * rate) }); });
        } else out.push({ ...base, description: sentence(e.description), hours, amount: noCharge ? 0 : round2(hours * rate) });
    }
    return out;
}

export function totals(lines: readonly FeeLine[]): { hours: number; billedHours: number; fees: number } {
    return {
        hours: round2(lines.reduce((n, l) => n + l.hours, 0)),
        billedHours: round2(lines.filter((l) => !l.noCharge).reduce((n, l) => n + l.hours, 0)),
        fees: round2(lines.reduce((n, l) => n + l.amount, 0)),
    };
}

export const money = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  ${logo ? `<img class="logo" src="${logo}" alt="Manatt" />` : `<strong>${esc(terms.firm.name)}</strong>`}
  <div class="firm"><strong>${esc(terms.firm.name)}</strong><br />${terms.firm.address.map(esc).join("<br />")}</div>
</div>`;

const page = (title: string, body: string, cls = ""): string =>
    `<!doctype html><html><head><meta charset="utf-8" /><title>${esc(title)}</title><style>${STYLE}</style></head><body class="${cls}">${body}</body></html>`;

/** "Time detail: Rosa Delacroix": every settled entry of the day with hours, rate and amount. */
export function timeSheetHtml(w: Workspace, terms: InvoiceTerms, logo: string | null): string {
    const lines = feeLines(w, terms);
    const t = totals(lines);
    const who = w.profile?.name ?? terms.timekeeper.name;
    const rows = lines.map((l) => `<tr><td>${l.date}</td><td>${esc(l.timekeeper)}</td><td class="num">${l.hours.toFixed(1)}</td><td class="num">${money(l.rate)}</td><td class="num">${l.noCharge ? `<span class="nc">No charge</span>` : money(l.amount)}</td><td>${esc(l.description)}${l.note ? `<br /><span class="nc">${esc(l.note)}</span>` : ""}</td></tr>`).join("");
    return page(`Time detail ${terms.matter}`, `${head(terms, logo)}
<h1>Time detail: ${esc(who)}</h1>
<p class="sub">${esc(terms.matter)} ${esc(terms.matterName)} · ${lines[0]?.date ?? ""}</p>
<table><thead><tr><th>Date</th><th>Timekeeper</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th><th>Description</th></tr></thead>
<tbody>${rows}<tr class="total"><td colspan="2">Total</td><td class="num">${t.hours.toFixed(1)}${t.billedHours !== t.hours ? ` <span class="nc">(${t.billedHours.toFixed(1)} billed)</span>` : ""}</td><td></td><td class="num">${money(t.fees)}</td><td></td></tr></tbody></table>`, "sheet");
}

/** The invoice: firm, bill-to, numbers, fee detail, timekeeper summary, totals, terms, remittance (placeholders only). */
export function invoiceHtml(w: Workspace, terms: InvoiceTerms, logo: string | null, today: Date): string {
    const lines = feeLines(w, terms);
    const t = totals(lines);
    const rate = lines.find((l) => !l.noCharge)?.rate ?? terms.rateCap ?? 0;
    const date = `${today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
    const rows = lines.map((l) => `<tr><td>${l.date}</td><td>${esc(l.timekeeper)}</td><td>${esc(l.description)}${l.note ? `<br /><span class="nc">${esc(l.note)}</span>` : ""}</td><td class="num">${l.hours.toFixed(1)}</td><td class="num">${l.noCharge ? `<span class="nc">No charge</span>` : money(l.amount)}</td></tr>`).join("");
    return page(`Invoice ${terms.number}`, `${head(terms, logo)}
<div class="blocks">
  <div class="block"><p class="label">Bill to</p>${terms.billTo.map((x) => `<p>${esc(x)}</p>`).join("")}</div>
  <table class="meta" style="width:auto"><tbody>
    <tr><td>Invoice</td><td>${esc(terms.number)}</td></tr><tr><td>Invoice date</td><td>${esc(date)}</td></tr>
    <tr><td>Client</td><td>${esc(terms.client)}</td></tr><tr><td>Matter</td><td>${esc(terms.matter)}</td></tr>
  </tbody></table>
</div>
<p><strong>${esc(terms.matterName)}</strong></p>
<p class="sub">For professional services rendered through ${esc(terms.through)}</p>
<h2>Fee detail</h2>
<table><thead><tr><th>Date</th><th>Timekeeper</th><th>Description</th><th class="num">Hours</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>
<div class="keep"><h2>Timekeeper summary</h2>
<table><thead><tr><th>Timekeeper</th><th>Title</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
<tbody><tr><td>${esc(terms.timekeeper.name)}</td><td>${esc(terms.timekeeper.title)}</td><td class="num">${t.billedHours.toFixed(1)}</td><td class="num">${money(rate)}</td><td class="num">${money(t.fees)}</td></tr></tbody></table>
<table class="due"><tbody><tr><td>Total fees</td><td class="num">${money(t.fees)}</td></tr><tr class="grand"><td>Total due</td><td class="num">${money(t.fees)}</td></tr></tbody></table>
<p class="sub" style="text-align:right;margin-top:6pt">Payment terms: ${esc(terms.terms)}</p>
<div class="remit"><strong>Remittance</strong><br />Please reference invoice ${esc(terms.number)} with your payment.<br />Check: [lockbox address]<br />Wire: [bank name], account [account number], ABA [routing number]</div></div>`, "invoice");
}
