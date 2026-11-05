/* A client sends an invoice back (2026-11-04). Pure. The note's sentences are read for the
   rules they state (a rate cap, no block billing, tenths, no charge for internal conferences,
   vague narratives, clerical work, travel, a cap on calls), each proposed as a rule of the
   client's rulebook quoting the sentence; the person approves which. The invoice's entries go
   back to the person as flagged, with the client's words as the reason, so they leave the bill
   until fixed and confirmed; the next invoice for the matter is the resubmission. */

import { REJECTION_NOTE_MAX, WorkspaceError, type IssuedInvoice, type Workspace } from "./model";
import { addRulebook, saveClientRule, type ClientRuleInput } from "./clientRulebooks";

export type Proposal = { rule: ClientRuleInput; sentence: string };

const sentences = (note: string): string[] => note.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|\n+|;\s+/).map((s) => s.trim()).filter((s) => s.length > 3);
const money = (s: string): number | null => { const m = s.match(/\$\s?(\d{2,5})(?:\.\d+)?/); return m ? Number(m[1]) : null; };
const hours = (s: string): number | null => { const m = s.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h\b)/i) ?? s.match(/(?:half|0\.5)\s*(?:an\s+)?hour/i); return m ? (m[1] ? Number(m[1]) : 0.5) : null; };

/** The rules a rejection note states, one per sentence that states one, each quoting that sentence. */
export function rejectionProposals(note: string): Proposal[] {
    const out: Proposal[] = [];
    const seen = new Set<string>();
    const add = (sentence: string, rule: Omit<ClientRuleInput, "quote">): void => {
        if (seen.has(rule.kind + (rule.check ?? ""))) return;
        seen.add(rule.kind + (rule.check ?? ""));
        out.push({ sentence, rule: { ...rule, quote: sentence } });
    };
    for (const s of sentences(note)) {
        const t = s.toLowerCase();
        const amount = money(s);
        if (/\b(block[- ]?bill|one task|single task|separate (entries|lines)|each task|lumped|combined entries)\b/.test(t)) add(s, { kind: "split", title: "One task per entry" });
        if (/\b(tenths?|0\.1|six[- ]minute|increments?)\b/.test(t) && !/\bquarter\b/.test(t)) add(s, { kind: "tenths", title: "Tenth-hour increments" });
        if (amount && /\b(rate|cap|per hour|an hour|hourly|\/h|exceed|above|more than|higher than|agreed|engagement)\b/.test(t)) add(s, { kind: "rateCap", title: /\bresearch\b/.test(t) ? "Rate cap on research" : "Rate cap", rate: amount });
        if (/\b(internal|intra-?firm|among (your|firm) (attorneys|lawyers|staff)|between (your|firm) (attorneys|lawyers))\b/.test(t) && /\b(conference|meeting|discussion|confer|call)s?\b/.test(t)) add(s, { kind: "noCharge", title: "Internal conferences at no charge", activityCode: "A105" });
        if (/\b(vague|insufficient detail|not (enough|sufficient) detail|describe|more detail|what was done|generic (descriptions?|narratives?)|unclear)\b/.test(t)) add(s, { kind: "check", title: "No vague narratives", check: "vague" });
        if (/\b(clerical|administrative|secretarial|scanning|copying|filing|calendaring|overhead)\b/.test(t)) add(s, { kind: "check", title: "No clerical work", check: "clerical" });
        if (/\btravel\b/.test(t)) add(s, { kind: "check", title: "Travel at a reduced rate", check: "travel" });
        const h = hours(s);
        if (h && /\b(calls?|conference calls?|telephone|video)\b/.test(t) && /\b(cap|limit|most|maximum|no more than|exceed|over)\b/.test(t)) add(s, { kind: "callCap", title: "Cap on calls", maxHours: h });
        if (h && /\bresearch\b/.test(t) && /\b(approv|authoriz|advance|prior|before)\w*\b/.test(t)) add(s, { kind: "check", title: "Research needs approval over a limit", check: "researchCap", maxHours: h });
        if (/\b(approved timekeepers?|not (an )?approved|staffing|unapproved (attorney|timekeeper|associate|paralegal))\b/.test(t)) add(s, { kind: "check", title: "Approved timekeepers only", check: "timekeepers", approved: [] });
    }
    return out.filter((p) => !(p.rule.check === "timekeepers"));
}

export type RejectionInput = { number: string; by: string; note: string; at: string };

/**
 * The invoice is marked rejected, its entries go back as flagged with the client's words as the
 * reason (they leave the bill until fixed and confirmed), and the approved rules join the
 * client's rulebook (made if the client has none), each citing the rejection. Returns what
 * happened, for the notice.
 */
export function recordRejection(w: Workspace, input: RejectionInput, approved: readonly ClientRuleInput[]): { flagged: number; ruleIDs: string[]; rulebookKey: string | null } {
    const inv = (w.invoices ?? []).find((i) => i.number === input.number);
    if (!inv) throw new WorkspaceError("That invoice is not one made here.");
    if (inv.rejection) throw new WorkspaceError(`Invoice ${inv.number} was already sent back.`);
    const note = input.note.trim().slice(0, REJECTION_NOTE_MAX);
    if (!note) throw new WorkspaceError("Paste what the client said.");
    const by = input.by.trim().slice(0, 120) || inv.client || "the client";
    const why = `Sent back by ${by}: ${note.length > 300 ? `${note.slice(0, 299).trimEnd()}…` : note}`;
    let flagged = 0;
    for (const e of w.entries) {
        if (!inv.entryIDs.includes(e.id)) continue;
        e.status = "flagged";
        e.why = why;
        flagged++;
    }
    let rulebookKey: string | null = null;
    const ruleIDs: string[] = [];
    if (approved.length) {
        const client = inv.client || w.projects.find((p) => p.id === inv.projectID)?.client || "";
        if (!client) throw new WorkspaceError("Set the client on the matter before approving its rules.");
        const existing = (w.clientRulebooks ?? []).find((b) => b.client.trim().toLowerCase() === client.trim().toLowerCase());
        rulebookKey = existing?.key ?? addRulebook(w, { client, title: `${client} billing rules` });
        for (const r of approved) ruleIDs.push(saveClientRule(w, rulebookKey, { ...r, section: r.section || `Rejection of invoice ${inv.number}` }));
    }
    inv.rejection = { at: input.at, by, note, ruleIDs };
    return { flagged, ruleIDs, rulebookKey };
}

/** The rejected invoice a new one for the same matter resubmits, if any: the latest sent back and not yet followed by another. */
export function resubmits(w: Workspace, projectID: string | null): IssuedInvoice | null {
    const list = (w.invoices ?? []).filter((i) => i.projectID === projectID);
    const last = list[list.length - 1];
    return last?.rejection ? last : null;
}
