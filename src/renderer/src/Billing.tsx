import { useState, type MouseEvent, type ReactNode } from "react";
import { changesOf, type AppliedBill, type AppliedChange, type AppliedLine } from "@shared/applyRules";
import { citeOf, money, rulebooksOf, shortName, type Segment } from "@shared/invoice";
import type { ClientRulebook, Workspace } from "@shared/model";
import { ContextMenu, Menu } from "./Menu";

/* Billing on the Time page: apply a client's rules to the day (or none), see each change
   inline under its entry with a chip naming the rule, and make the time sheet or invoice for
   the mode on screen. Every figure comes from the applied bill (src/shared/applyRules.ts), the
   same lines the PDFs and the DOCX print. Right-click a chip or the totals line to open the
   client's rules. */

type OpenRules = (book: string, rule?: string | null) => void;

/** "Apply client rules ▾": Generic, or one of the clients whose rules the workspace carries. */
export function ApplyRulesMenu({ w, onRules }: { w: Workspace; onRules: OpenRules }): ReactNode {
    const books = rulebooksOf(w);
    if (!books.length) return null;
    const current = books.find((b) => b.key === w.billingClient) ?? null;
    return (
        <Menu label={current ? `${shortName(current)} rules` : "Apply client rules"} active={!!current}
            tip={current ? `The day is shown under ${current.client}'s billing rules. Choose another client, or Generic.` : "Bill the day under a client's billing rules and see each change under its entry."}>
            <span className="menu-group" role="presentation">Bill this day as</span>
            <button type="button" role="menuitemradio" aria-checked={!current} title="Standard rates, no client rules." onClick={() => void window.lawdie.setBillingClient(null)}>
                <span className="menu-check" aria-hidden="true">{current ? "" : "✓"}</span>Generic
            </button>
            {books.map((b) => (
                <button key={b.key} type="button" role="menuitemradio" aria-checked={current?.key === b.key} title={`Apply ${b.title}, effective ${b.effective || "now"}.`} onClick={() => void window.lawdie.setBillingClient(b.key)}>
                    <span className="menu-check" aria-hidden="true">{current?.key === b.key ? "✓" : ""}</span>{b.client}
                </button>
            ))}
            {current && (
                <>
                    <span className="menu-sep" role="presentation" />
                    <button type="button" role="menuitem" title={`See each of ${current.client}'s rules, what it does today, and where it is written.`} onClick={() => onRules(current.key)}>
                        <span className="menu-check" aria-hidden="true" />Open {shortName(current)} rules
                    </button>
                </>
            )}
        </Menu>
    );
}

/** "Generic $5,616.50 → Northlake $4,730.00": the day's bill without and with the rules on screen. */
export function TotalsLine({ bill, onRules }: { bill: AppliedBill; onRules: OpenRules }): ReactNode {
    const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
    if (!bill.lines.length) return null;
    const book = bill.book;
    if (!book) return <p className="totals-line plain" title="The day's settled entries at standard rates, before any client's rules."><span className="muted">Generic</span> <span className="mono">{money(bill.standard)}</span></p>;
    const name = shortName(book);
    return (
        <>
            <button type="button" className="totals-line" title={`The day at standard rates, then under ${book.client}'s rules. Click or right-click to open the ${name} rules.`}
                onClick={() => onRules(book.key)} onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); }}>
                <span className="muted">Generic</span> <span className="mono">{money(bill.standard)}</span>
                <span className="arrow" aria-hidden="true">→</span>
                <span className="strong">{name}</span> <span className="mono strong accent">{money(bill.totals.fees)}</span>
            </button>
            {ctx && <ContextMenu at={ctx} items={[{ label: `Open ${name} rules`, tip: `See ${book.client}'s rules and what each does today.`, onClick: () => onRules(book.key) }]} onClose={() => setCtx(null)} />}
        </>
    );
}

/** A narrative with the words a rule added marked as inserted, the way a tracked change shows them. */
export function Segments({ segments, book }: { segments: Segment[]; book?: ClientRulebook | null }): ReactNode {
    // The mark covers the added words only; a space before or after them stays plain text.
    return <>{segments.map((g, n) => {
        if (!g.ins) return <span key={n}>{g.text}</span>;
        const [, lead, words, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(g.text) ?? ["", "", g.text, ""];
        return <span key={n}>{lead}<ins className="rule-ins" title={`Added by ${g.ins}${book ? ` (${book.rules.find((r) => r.id === g.ins)?.title ?? ""})` : ""}.`}>{words}</ins>{trail}</span>;
    })}</>;
}

/** The small chip naming the rule behind a change. Click or right-click opens the client's rules at that rule. */
function RuleChip({ ruleId, book, w, onRules }: { ruleId: string; book: ClientRulebook; w: Workspace; onRules: OpenRules }): ReactNode {
    const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
    const r = book.rules.find((x) => x.id === ruleId);
    const name = shortName(book);
    const open = (e: MouseEvent): void => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); };
    return (
        <>
            <button type="button" className="rule-chip" title={r ? `${r.id} ${citeOf(r, w, book)}: “${r.quote}” Click or right-click to open the ${name} rules.` : ruleId}
                onClick={() => onRules(book.key, ruleId)} onContextMenu={open}>
                <span className="mono">{ruleId}</span> {r?.title ?? ""}
            </button>
            {ctx && <ContextMenu at={ctx} items={[{ label: `Open ${name} rules`, tip: `See ${r ? r.id : "this rule"} and the rest of ${book.client}'s rules.`, onClick: () => onRules(book.key, ruleId) }]} onClose={() => setCtx(null)} />}
        </>
    );
}

const changeWords = (c: AppliedChange): string => (c.kind === "text" || c.kind === "kept" ? c.text ?? "" : `${c.before} → ${c.after}`);

/** Under an entry, with a client's rules applied: each change with its rule, and a split entry's lines. Nothing for an entry no rule changed. */
export function EntryChanges({ lines, book, w, onRules }: { lines: AppliedLine[]; book: ClientRulebook; w: Workspace; onRules: OpenRules }): ReactNode {
    const all = changesOf(lines);
    if (!all.length) return null;
    const split = lines.length > 1 ? all.find((c) => c.kind === "split") : undefined;
    const items = all.filter((c) => c.kind !== "split");
    return (
        <div className="entry-changes">
            {items.length > 0 && (
                <div className="change-items">
                    {items.map((c, n) => (
                        <span key={n} className={"change-item " + c.kind}>
                            <span className="change-what">{changeWords(c)}</span>
                            <RuleChip ruleId={c.ruleId} book={book} w={w} onRules={onRules} />
                        </span>
                    ))}
                </div>
            )}
            {split && (
                <div className="split-block">
                    <div className="split-head"><span className="split-rule" aria-hidden="true" /><span className="split-word">split</span><span className="split-rule" aria-hidden="true" /><RuleChip ruleId={split.ruleId} book={book} w={w} onRules={onRules} /></div>
                    {lines.map((l) => (
                        <div key={l.part ?? 0} className="split-row">
                            <span className="split-text"><Segments segments={l.segments} book={book} /></span>
                            <span className="mono split-hours">{l.hours.toFixed(1)} h</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** The narrative an entry shows under a client's rules: its first line with added words marked, unless it was split
 *  (then the split block shows the lines). Null when the rules add nothing to the words. */
export function inlineNarrative(lines: AppliedLine[] | undefined, book: ClientRulebook | null): ReactNode | null {
    if (!book || !lines?.length || lines.length > 1 || !lines[0].segments.some((g) => g.ins)) return null;
    return <Segments segments={lines[0].segments} book={book} />;
}

/** "Billing ▾" for the mode on screen: the time sheet as PDF or DOCX, and the invoice. */
export function BillingMenu({ bill, day, onProblem }: { bill: AppliedBill; day: string; onProblem: (p: string | null) => void }): ReactNode {
    const [busy, setBusy] = useState<string | null>(null);
    if (!bill.lines.length) return null;
    const mode = bill.book?.key ?? "generic";
    const run = async (what: "timesheet" | "invoice" | "docx"): Promise<void> => {
        setBusy(what);
        onProblem(what === "docx" ? await window.lawdie.makeDocx(mode, day) : await window.lawdie.makePdf(what, mode, day));
        setBusy(null);
    };
    const how = bill.book ? `with ${bill.book.client}'s rules` : "generic, at standard rates";
    return (
        <Menu label={busy ? "Making…" : "Billing"} tip={`Make the time sheet or the invoice for this day, ${how}. Saved in the matter folder and opened.`}>
            <span className="menu-group" role="presentation">{bill.book ? `${shortName(bill.book)} rules` : "Generic"}</span>
            <span className="menu-row" role="presentation">
                <span>Time sheet</span>
                <span className="menu-pills">
                    <button type="button" role="menuitem" className="menu-pill" disabled={!!busy} title={`The time detail as a PDF, ${how}.`} onClick={() => void run("timesheet")}>PDF</button>
                    <button type="button" role="menuitem" className="menu-pill" disabled={!!busy} title={bill.book ? `The time detail as a Word file with ${bill.book.client}'s rules as tracked changes, each with a comment that quotes the rule.` : "The time detail as a plain Word file at standard rates."} onClick={() => void run("docx")}>DOCX</button>
                </span>
            </span>
            <button type="button" role="menuitem" disabled={!!busy} title={`The invoice as a PDF, ${how}.`} onClick={() => void run("invoice")}>Invoice (PDF)</button>
        </Menu>
    );
}
