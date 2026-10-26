/* What each of the client's billing rules does to today's entries, for the Client rules page
   and the DOCX time sheet. Pure. Rules that change a bill (split, no charge, rate, tenths, not
   billed) are worked out by src/shared/invoice.ts; the others are checks Lawdie runs on every
   entry, which pass, fail, or have nothing to check today. */

import { activeRules, feeLines, money, ruleEffects, totals, type FeeLine } from "./invoice";
import type { ClientRule, InvoiceTerms, Workspace } from "./model";

export type RuleStatus = "changes" | "pass" | "fail" | "none";
/** One entry a rule touches: a short name for it, and what the rule did or found. */
export type Touch = { entryID: string | null; label: string; detail: string; fail?: boolean };
export type RuleReport = { rule: ClientRule; status: RuleStatus; summary: string; touches: Touch[] };

const short = (t: string, n = 64): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const h = (n: number): string => `${n.toFixed(n * 10 % 1 ? 2 : 1)} h`;

/** A narrative a client would call vague: a bare activity with no subject or no other party named. */
export function isVague(text: string): boolean {
    const t = text.trim();
    const words = t.split(/\s+/).filter(Boolean);
    const bare = /^(review(ed)? file|attention to|work on|call|phone call|telephone call|email|e-mail|emails|follow up|meeting|conference)\b/i.test(t);
    const party = /\b[A-Z]\.\s?[A-Z][a-z]+|\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(t);
    const subject = /\bregarding\b|\bre:?\s|\babout\b|\bon\b [A-Z]/i.test(t);
    return words.length < 4 || (bare && !(party && subject));
}

/** The rules' effects, one report per rule, in the client's order. */
export function ruleReports(w: Workspace, terms: InvoiceTerms): RuleReport[] {
    const rules = w.clientRules?.rules ?? [];
    const std = feeLines(w, terms, []);
    const billed = feeLines(w, terms, activeRules(w, terms));
    const name = (id: string): string => short(w.entries.find((e) => e.id === id)?.description ?? "");
    return rules.map((rule) => {
        if (rule.kind !== "check") return changeReport(w, terms, rule, name, std);
        const lines = billed;
        if (rule.check === "vague") {
            const drafted = [...new Set(lines.map((l) => l.entryID))];
            const typed = [...(w.imported ?? []).map((r) => r.description), ...(rule.examples ?? [])].filter((x, n, a) => a.indexOf(x) === n);
            const touches: Touch[] = [
                ...drafted.map((id) => ({ entryID: id, label: name(id), detail: isVague(w.entries.find((e) => e.id === id)?.description ?? "") ? "Vague" : "Names the task, the people and the subject: passes" , fail: isVague(w.entries.find((e) => e.id === id)?.description ?? "") })),
                ...typed.filter(isVague).map((t) => ({ entryID: null, label: `Typed note: “${t}”`, detail: "Would fail: no subject and no other party. Lawdie drafts the narrative from the sources instead.", fail: true })),
            ];
            const failing = touches.filter((x) => x.fail && x.entryID).length;
            return { rule, status: failing ? "fail" : "pass", summary: failing ? `${plural(failing, "entry")} too vague` : `Checked, all ${drafted.length} drafted narratives pass`, touches };
        }
        if (rule.check === "oneAttendee") {
            const meetings = [...new Set(lines.filter((l) => (w.entries.find((e) => e.id === l.entryID)?.sources ?? []).some((s) => s.kind === "meeting")).map((l) => l.entryID))];
            const who = new Set(lines.map((l) => l.timekeeper));
            const touches = meetings.map((id) => ({ entryID: id, label: name(id), detail: `Billed by ${[...who].join(", ")} only: passes` }));
            return { rule, status: meetings.length ? (who.size > 1 ? "fail" : "pass") : "none", summary: meetings.length ? `Checked ${plural(meetings.length, "meeting")}, one attendee billed` : "No meetings today", touches };
        }
        if (rule.check === "researchCap") {
            const max = rule.maxHours ?? 2;
            const research = lines.filter((l) => /^research/i.test(l.description));
            const over = research.filter((l) => l.hours > max);
            return { rule, status: research.length ? (over.length ? "fail" : "pass") : "none", summary: research.length ? (over.length ? `${plural(over.length, "entry")} over ${max.toFixed(1)} h` : `Checked, research is under ${max.toFixed(1)} h`) : "No research today",
                touches: research.map((l) => ({ entryID: l.entryID, label: short(l.description), detail: `${h(l.hours)}${l.hours > max ? `: over ${max.toFixed(1)} h, needs approval` : `: under ${max.toFixed(1)} h, passes`}`, fail: l.hours > max })) };
        }
        if (rule.check === "clerical" || rule.check === "travel") {
            const words = rule.words ?? [];
            const hits = lines.filter((l) => words.some((x) => new RegExp(`\\b${x}`, "i").test(l.description)));
            const what = rule.check === "travel" ? "travel" : "clerical or administrative work";
            if (rule.check === "travel" && !hits.length) return { rule, status: "none", summary: "No travel today", touches: [] };
            return { rule, status: hits.length ? "fail" : "pass", summary: hits.length ? `${plural(hits.length, "entry")} with ${what}` : `Checked ${plural(lines.length, "line")}, no ${what}`,
                touches: hits.map((l) => ({ entryID: l.entryID, label: short(l.description), detail: `Looks like ${what}`, fail: true })) };
        }
        if (rule.check === "timekeepers") {
            const approved = rule.approved ?? [];
            const who = [...new Set(lines.map((l) => l.timekeeper))];
            const bad = who.filter((x) => !approved.includes(x));
            return { rule, status: bad.length ? "fail" : "pass", summary: bad.length ? `${bad.join(", ")} not approved` : `Checked, ${who.join(", ")} approved`,
                touches: who.map((x) => ({ entryID: null, label: x, detail: approved.includes(x) ? `Approved (${approved.join(", ")})` : "Not on the approved list", fail: !approved.includes(x) })) };
        }
        return { rule, status: "none", summary: "Nothing to check", touches: [] };
    });
}

/** A rule that changes the bill: each entry it changes, before and after, on its own against the standard bill. */
function changeReport(w: Workspace, terms: InvoiceTerms, rule: ClientRule, name: (id: string) => string, std: FeeLine[]): RuleReport {
    const effects = ruleEffects(w, terms, rule);
    if (rule.kind === "tenths") {
        const touches = [...new Set(std.map((l) => l.entryID))].map((id) => {
            const e = w.entries.find((x) => x.id === id)!;
            const minutes = (e.work ?? []).reduce((n, x) => n + x.minutes, 0);
            return { entryID: id, label: name(id), detail: `${minutes}m rounds up to ${(std.find((l) => l.entryID === id)!.stdHours).toFixed(1)} h` };
        });
        return { rule, status: effects.length ? "changes" : "pass", summary: effects.length ? `Changes ${plural(effects.length, "entry", "entries")}` : `Checked, all ${touches.length} entries in tenths`, touches };
    }
    const touches: Touch[] = effects.map(({ entryID, before, after }) => {
        const b = before[0];
        if (after.length > 1) return { entryID, label: name(entryID), detail: `${h(b.hours)} split into ${after.map((l) => `${l.hours.toFixed(1)} h “${l.description}”`).join(" and ")}` };
        const a = after[0];
        if (a.noCharge && !b.noCharge) return { entryID, label: name(entryID), detail: `${h(b.hours)} ${money(b.amount)} to no charge` };
        if (a.rate !== b.rate) return { entryID, label: name(entryID), detail: `${money(b.rate)} to ${money(a.rate)}: ${money(b.amount)} to ${money(a.amount)}` };
        return { entryID, label: name(entryID), detail: `${money(b.amount)} to ${money(a.amount)}` };
    });
    const summary = rule.kind === "rateCap" && effects.length
        ? `Rates ${money(effects[0].before[0].rate)} to ${money(rule.rate ?? 0)} on ${plural(effects.length, "entry", "entries")}`
        : effects.length ? `Changes ${plural(effects.length, "entry", "entries")}` : "Nothing today";
    return { rule, status: effects.length ? "changes" : "none", summary, touches };
}

/** The bill without and with the rules that are on, for the summary strip. */
export function rulesTotals(w: Workspace, terms: InvoiceTerms): { standard: number; withRules: number } {
    return { standard: totals(feeLines(w, terms, [])).fees, withRules: totals(feeLines(w, terms, activeRules(w, terms))).fees };
}
