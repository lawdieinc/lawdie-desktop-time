/* What each rule of a client's rulebook does to today's entries, for the rules page, the Time
   page's totals line and the DOCX time sheet. Pure. Rules that change a bill are worked out by
   src/shared/invoice.ts (each line keeps its effects); the others are checks Lawdie runs on every
   entry, which pass, fail, or have nothing to check today. */

import { billFor, feeLines, money, ruleEffects, totals, type FeeLine, type LineEffect } from "./invoice";
import { seconds, type ClientRule, type ClientRulebook, type InvoiceTerms, type Workspace } from "./model";

export type RuleStatus = "changes" | "pass" | "fail" | "none";
/** One entry a rule touches: a short name for it, and what the rule did or found. */
export type Touch = { entryID: string | null; label: string; detail: string; fail?: boolean };
export type RuleReport = { rule: ClientRule; status: RuleStatus; summary: string; touches: Touch[] };

const short = (t: string, n = 64): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const h = (n: number): string => `${n.toFixed(n * 10 % 1 ? 2 : 1)} h`;

/** A narrative a client would call vague: a bare activity with no subject or no other party named. */
export function isVague(text: string): boolean {
    const t = text.trim().replace(/^[A-Z]\d{3}\s+/, "");
    const words = t.split(/\s+/).filter(Boolean);
    const bare = /^(review(ed)? file|attention to|work on|call|phone call|telephone call|email|e-mail|emails|follow up|meeting|conference)\b/i.test(t);
    const party = /\b[A-Z]\.\s?[A-Z][a-z]+|\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(t);
    const subject = /\bregarding\b|\bre:?\s|\babout\b|\bon\b [A-Z]/i.test(t);
    return words.length < 4 || (bare && !(party && subject));
}

/** One effect in words, as the rules page and the Time page say it: "$1,195 → $1,075", "C300 added in front". */
export function effectText(x: LineEffect): string {
    if (x.what === "text" || x.what === "kept") return x.text ?? "";
    if (x.what === "split") return `${x.before} split into ${x.after}`;
    return `${x.before} → ${x.after}`;
}

/** Each rule of the rulebook and what it does today, in the rulebook's order. */
export function ruleReports(w: Workspace, terms: InvoiceTerms, book: ClientRulebook): RuleReport[] {
    const billed = billFor(w, terms, book);
    const std = feeLines(w, terms, [], { book });
    const name = (id: string): string => short(w.entries.find((e) => e.id === id)?.description ?? "");
    return book.rules.map((rule) => (rule.kind === "check" ? checkReport(w, rule, billed, name) : changeReport(w, terms, book, rule, name, std)));
}

function checkReport(w: Workspace, rule: ClientRule, lines: FeeLine[], name: (id: string) => string): RuleReport {
    if (rule.check === "vague") {
        const drafted = [...new Set(lines.map((l) => l.entryID))];
        // Notes someone really typed (Add entry) or imported, then the rule's own examples that no one typed today.
        const typed = [...new Set((w.imported ?? []).map((r) => r.description))];
        const examples = [...new Set(rule.examples ?? [])].filter((x) => !typed.includes(x));
        const wouldFail = (label: string) => (t: string): Touch => ({ entryID: null, label: `${label}: “${t}”`, detail: "Would fail: no subject or no other party", fail: true });
        const touches: Touch[] = [
            ...drafted.map((id) => { const v = isVague(w.entries.find((e) => e.id === id)?.description ?? ""); return { entryID: id, label: name(id), detail: v ? "Too vague: no subject or no other party" : "Names the task, the people and the subject", fail: v }; }),
            ...typed.filter(isVague).map(wouldFail("Typed note")),
            ...examples.filter(isVague).map(wouldFail("Example")),
        ];
        const failing = touches.filter((x) => x.fail && x.entryID).length;
        return { rule, status: failing ? "fail" : drafted.length ? "pass" : "none", summary: failing ? `${plural(failing, "entry")} too vague` : `Checked, all ${drafted.length} pass`, touches };
    }
    if (rule.check === "oneAttendee") {
        const meetings = [...new Set(lines.filter((l) => (w.entries.find((e) => e.id === l.entryID)?.sources ?? []).some((s) => s.kind === "meeting")).map((l) => l.entryID))];
        const who = new Set(lines.map((l) => l.timekeeper));
        const touches = meetings.map((id) => ({ entryID: id, label: name(id), detail: `Billed by ${[...who].join(", ")} only` }));
        return { rule, status: meetings.length ? (who.size > 1 ? "fail" : "pass") : "none", summary: meetings.length ? `Checked ${plural(meetings.length, "meeting")}, one attendee each` : "No meetings today", touches };
    }
    if (rule.check === "researchCap") {
        const max = rule.maxHours ?? 2;
        const research = lines.filter((l) => /^([A-Z]\d{3}\s+)?research/i.test(l.description));
        const over = research.filter((l) => l.hours > max);
        return { rule, status: research.length ? (over.length ? "fail" : "pass") : "none", summary: research.length ? (over.length ? `${plural(over.length, "entry")} over ${max.toFixed(1)} h` : `Checked, research under ${max.toFixed(1)} h`) : "No research today",
            touches: research.map((l) => ({ entryID: l.entryID, label: short(l.description), detail: `${h(l.hours)}${l.hours > max ? `, over ${max.toFixed(1)} h: needs approval` : `, under ${max.toFixed(1)} h`}`, fail: l.hours > max })) };
    }
    if (rule.check === "clerical" || rule.check === "travel") {
        const words = rule.words ?? [];
        const hits = lines.filter((l) => words.some((x) => new RegExp(`\\b${x}`, "i").test(l.description)));
        const what = rule.check === "travel" ? "travel" : "clerical work";
        if (rule.check === "travel" && !hits.length) return { rule, status: "none", summary: "No travel today", touches: [] };
        return { rule, status: hits.length ? "fail" : "pass", summary: hits.length ? `${plural(hits.length, "entry")} with ${what}` : `Checked ${plural(lines.length, "line")}, no ${what}`,
            touches: hits.map((l) => ({ entryID: l.entryID, label: short(l.description), detail: `Looks like ${what}`, fail: true })) };
    }
    if (rule.check === "timekeepers") {
        const approved = rule.approved ?? [];
        const who = [...new Set(lines.map((l) => l.timekeeper))];
        const bad = who.filter((x) => !approved.includes(x));
        return { rule, status: bad.length ? "fail" : "pass", summary: bad.length ? `${bad.join(", ")} not approved` : `Checked, ${who.join(", ")} approved`,
            touches: who.map((x) => ({ entryID: null, label: x, detail: approved.includes(x) ? `On the approved list: ${approved.join(", ")}` : "Not on the approved list", fail: !approved.includes(x) })) };
    }
    return { rule, status: "none", summary: "Nothing to check", touches: [] };
}

/** A rule that changes the bill: each entry it changes on its own, against the standard bill. */
function changeReport(w: Workspace, terms: InvoiceTerms, book: ClientRulebook, rule: ClientRule, name: (id: string) => string, std: FeeLine[]): RuleReport {
    const effects = ruleEffects(w, terms, rule, book);
    if (rule.kind === "tenths") {
        const touches = [...new Set(std.map((l) => l.entryID))].map((id) => {
            const e = w.entries.find((x) => x.id === id)!;
            // What capture recorded for it, stretch by stretch; an entry kept without that breakdown has its own span.
            const minutes = (e.work ?? []).reduce((n, x) => n + x.minutes, 0) || Math.round(seconds(e) / 60);
            const recorded = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}` : `${minutes}m`;
            return { entryID: id, label: name(id), detail: `${recorded} → ${h(std.find((l) => l.entryID === id)!.stdHours)}` };
        });
        return { rule, status: effects.length ? "changes" : touches.length ? "pass" : "none", summary: effects.length ? `Changes ${plural(effects.length, "entry", "entries")}` : `Checked, all ${touches.length} in tenths`, touches };
    }
    const touches: Touch[] = effects.map(({ entryID, effects: list }) => ({ entryID, label: name(entryID), detail: list.map(effectText).join("; ") }));
    const changed = effects.filter((x) => x.effects.some((e) => e.what !== "kept")).length;
    if (!effects.length) return { rule, status: "none", summary: "Nothing today", touches };
    if (!changed) return { rule, status: "pass", summary: `Checked ${plural(effects.length, "entry", "entries")}, no change`, touches };
    const summary = rule.kind === "rateCap" ? `${effectText(effects[0].effects[0])} on ${plural(changed, "entry", "entries")}` : `Changes ${plural(changed, "entry", "entries")}`;
    return { rule, status: "changes", summary, touches };
}

/** Each entry's lines and effects under a rulebook, for the Time page: what changed, by which rule. */
export function entryEffects(w: Workspace, terms: InvoiceTerms, book: ClientRulebook): Map<string, { lines: FeeLine[]; effects: LineEffect[] }> {
    const out = new Map<string, { lines: FeeLine[]; effects: LineEffect[] }>();
    for (const l of billFor(w, terms, book)) {
        const cur = out.get(l.entryID) ?? { lines: [], effects: [] };
        cur.lines.push(l);
        for (const x of l.effects) if (!cur.effects.some((y) => JSON.stringify(y) === JSON.stringify(x))) cur.effects.push(x);
        out.set(l.entryID, cur);
    }
    return out;
}

export { money, totals };
