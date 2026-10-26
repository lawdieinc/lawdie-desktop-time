/* The applied bill: one pure function for a day and a rulebook (or generic billing), and the
   one source every view of the bill renders from. The Time page's inline changes, the time
   sheet (PDF and DOCX) and the invoice all take its lines, so what the presenter sees on the
   Time page is what the client receives. Nothing recomputes a line on its own. */

import { bookOf, feeLines, rulebooksOf, termsOf, totals, type FeeLine, type LineEffect, type Segment } from "./invoice";
import type { ClientRulebook, Workspace } from "./model";

/** A change a rule made to a line: which rule, what kind, before and after (or what it says). */
export type AppliedChange = { ruleId: string; kind: LineEffect["what"]; before?: string; after?: string; text?: string };

export type AppliedLine = {
    entryId: string;
    /** A split entry's part (0, 1, ...) and how many parts; a whole entry is part null of 1. */
    part: number | null;
    parts: number;
    date: string;
    timekeeper: string;
    hours: number;
    rate: number;
    amount: number;
    /** Kept on the bill at $0.00, with its hours: a rule (NBH-2) or a non-billable entry. */
    noCharge: boolean;
    note: string | null;
    /** The narrative after the client's format rules; `segments` mark the words a rule added. */
    narrative: string;
    segments: Segment[];
    /** The line as the firm's standard terms bill it, before any rule. */
    std: { hours: number; rate: number; amount: number; narrative: string };
    changes: AppliedChange[];
};

export type AppliedBill = {
    /** "generic" or the rulebook's key. */
    mode: string;
    book: ClientRulebook | null;
    day: string | null;
    lines: AppliedLine[];
    totals: { hours: number; billedHours: number; fees: number };
    /** The same day at standard rates, for "Generic $5,616.50 → Northlake $4,730.00". */
    standard: number;
};

const toLine = (l: FeeLine): AppliedLine => ({
    entryId: l.entryID, part: l.split ? l.split.part : null, parts: l.split ? l.split.of : 1,
    date: l.date, timekeeper: l.timekeeper, hours: l.hours, rate: l.rate, amount: l.amount, noCharge: l.noCharge, note: l.note,
    narrative: l.description, segments: l.segments,
    std: { hours: l.stdHours, rate: l.stdRate, amount: l.stdAmount, narrative: l.stdDescription },
    changes: l.effects.map((x) => ({ ruleId: x.rule, kind: x.what, ...(x.before !== undefined ? { before: x.before } : {}), ...(x.after !== undefined ? { after: x.after } : {}), ...(x.text !== undefined ? { text: x.text } : {}) })),
});

/** The rulebook a mode names: a key, "generic" (none), or the older "rules" (the first client's). */
export function bookForMode(w: Workspace, mode: string | null | undefined): ClientRulebook | null {
    if (!mode || mode === "generic") return null;
    if (mode === "rules") return rulebooksOf(w)[0] ?? null;
    return bookOf(w, mode);
}

/**
 * The day's bill under a rulebook's rules that are on ("generic": none). `day` is YYYY-MM-DD,
 * or null for every settled entry in the workspace.
 */
export function applyRules(w: Workspace, day: string | null, mode: string | null): AppliedBill {
    const terms = termsOf(w);
    const book = bookForMode(w, mode);
    const lines = book ? feeLines(w, terms, book.rules.filter((r) => r.enabled), { book, day }) : feeLines(w, terms, [], { day });
    return { mode: book ? book.key : "generic", book, day, lines: lines.map(toLine), totals: totals(lines), standard: totals(feeLines(w, terms, [], { day })).fees };
}

/** What the Time page shows of each line: the figures and the narrative, by entry and part. */
export function uiRows(bill: AppliedBill): { entryId: string; part: number | null; hours: number; rate: number; amount: number; noCharge: boolean; narrative: string }[] {
    return bill.lines.map((l) => ({ entryId: l.entryId, part: l.part, hours: l.hours, rate: l.rate, amount: l.amount, noCharge: l.noCharge, narrative: l.narrative }));
}

/** The bill's lines by entry, in order: what an entry row on the Time page shows under its narrative. */
export function linesByEntry(bill: AppliedBill): Map<string, AppliedLine[]> {
    const out = new Map<string, AppliedLine[]>();
    for (const l of bill.lines) out.set(l.entryId, [...(out.get(l.entryId) ?? []), l]);
    return out;
}

/** An entry's changes, each once, in the order the rules made them (a split's lines repeat the entry's changes). */
export function changesOf(lines: readonly AppliedLine[]): AppliedChange[] {
    const seen = new Set<string>();
    return lines.flatMap((l) => l.changes).filter((c) => { const k = JSON.stringify(c); if (seen.has(k)) return false; seen.add(k); return true; });
}
