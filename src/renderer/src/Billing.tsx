import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { applyRules, changesOf, type AppliedBill, type AppliedChange, type AppliedLine } from "@shared/applyRules";
import { billable, citeOf, longDate, money, rulebooksOf, shortName, type BillScope, type Segment } from "@shared/invoice";
import { nextInvoiceNumber, type BillingSetup, type ClientRulebook, type Workspace } from "@shared/model";
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
    // A split entry's codes belong to its lines, each in front of its own task below; the entry shows no code chip.
    const code = book.rules.find((r) => r.kind === "codePrefix")?.id;
    const items = all.filter((c) => c.kind !== "split" && !(split && c.ruleId === code));
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
export function BillingMenu({ w, bill, day, onProblem }: { w: Workspace; bill: AppliedBill; day: string; onProblem: (p: string | null) => void }): ReactNode {
    const [busy, setBusy] = useState<string | null>(null);
    const [sheet, setSheet] = useState<"invoice" | "timesheet" | null>(null);
    // With the firm set up in Settings, a bill is one matter over a period, chosen in a sheet; a demo seed bills its day.
    if (w.billing) {
        return (
            <>
                <Menu label="Billing" tip="Make an invoice or a time sheet for one matter over a period, saved as a file.">
                    <button type="button" role="menuitem" title={`Invoice ${nextInvoiceNumber(w)}: one matter, a period, your rules or a client's.`} onClick={() => setSheet("invoice")}>Invoice…</button>
                    <button type="button" role="menuitem" title="The time detail for one matter over a period, as PDF or Word." onClick={() => setSheet("timesheet")}>Time sheet…</button>
                </Menu>
                {sheet && <InvoiceSheet w={w} kind={sheet} day={day} onClose={() => setSheet(null)} />}
            </>
        );
    }
    if (!bill.lines.length) return null;
    const mode = bill.book?.key ?? "generic";
    const run = async (what: "timesheet" | "invoice" | "docx"): Promise<void> => {
        setBusy(what);
        onProblem(what === "docx" ? await window.lawdie.makeDocx(mode, { day }) : await window.lawdie.makePdf(what, mode, { day }));
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

// ---------------------------------------------------------------------------
// An invoice or time sheet for one matter over a period (2026-11-04: billing for a person, not only a demo day)

const monthOf = (day: string): string => day.slice(0, 7);
const firstOf = (month: string): string => `${month}-01`;
const lastOf = (month: string): string => { const [y, m] = month.split("-").map(Number); return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };
const prevMonth = (month: string): string => { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

export function InvoiceSheet({ w, kind, day, onClose }: { w: Workspace; kind: "invoice" | "timesheet"; day: string; onClose: () => void }): ReactNode {
    const month = monthOf(day);
    const matters = useMemo(() => {
        const ids = new Set(billable(w).map((e) => e.projectID));
        return w.projects.filter((p) => ids.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    }, [w]);
    // The matter with time on the day shown comes first; the period is this month unless nothing in it bills.
    const todays = billable(w, day)[0]?.projectID ?? null;
    const [projectID, setProjectID] = useState<string>(todays && matters.some((p) => p.id === todays) ? todays : matters[0]?.id ?? "");
    const [period, setPeriod] = useState<"this" | "last" | "custom">("this");
    const [from, setFrom] = useState(firstOf(prevMonth(month)));
    const [to, setTo] = useState(lastOf(prevMonth(month)));
    const books = rulebooksOf(w);
    const [mode, setMode] = useState<string>(w.billingClient && books.some((b) => b.key === w.billingClient) ? w.billingClient : "generic");
    const [busy, setBusy] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const scope: BillScope = period === "this" ? { projectID, from: firstOf(month), to: lastOf(month) } : period === "last" ? { projectID, from: firstOf(prevMonth(month)), to: lastOf(prevMonth(month)) } : { projectID, from, to };
    const bill = useMemo(() => applyRules(w, null, mode, scope), [w, mode, scope.projectID, scope.from, scope.to]);
    const project = w.projects.find((p) => p.id === projectID) ?? null;
    const run = async (what: "invoice" | "timesheet" | "docx"): Promise<void> => {
        setBusy(what);
        const p = what === "docx" ? await window.lawdie.makeDocx(mode, scope) : await window.lawdie.makePdf(what, mode, scope);
        setBusy(null);
        if (p) setProblem(p); else onClose();
    };
    const title = kind === "invoice" ? `Invoice ${nextInvoiceNumber(w)}` : "Time sheet";
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void run(kind); }}>
                <div className="heading"><p className="eyebrow">{w.billing?.firm.name}</p><h2 className="display">{title}</h2></div>
                {matters.length === 0 ? <p className="muted small">Nothing to bill yet: keep time on a matter first.</p> : (
                    <>
                        <label className="field"><span className="eyebrow">Matter</span>
                            <select value={projectID} title="The matter this bill is for." onChange={(e) => setProjectID(e.target.value)}>{matters.map((p) => <option key={p.id} value={p.id}>{p.matterNumber ? `${p.matterNumber} · ` : ""}{p.name}{p.client ? ` (${p.client})` : ""}</option>)}</select>
                        </label>
                        <div className="row gap wrap">
                            <div className="field"><span className="eyebrow">Period</span>
                                <div className="segmented" role="radiogroup" aria-label="Period">
                                    {([["this", "This month"], ["last", "Last month"], ["custom", "Custom"]] as const).map(([k, text]) => <button key={k} type="button" role="radio" aria-checked={period === k} className={period === k ? "active" : ""} title={`Bill ${text.toLowerCase()}.`} onClick={() => setPeriod(k)}>{text}</button>)}
                                </div>
                            </div>
                            {period === "custom" && (
                                <>
                                    <label className="field"><span className="eyebrow">From</span><input type="date" value={from} max={to} title="First day billed." onChange={(e) => setFrom(e.target.value)} /></label>
                                    <label className="field"><span className="eyebrow">To</span><input type="date" value={to} min={from} title="Last day billed." onChange={(e) => setTo(e.target.value)} /></label>
                                </>
                            )}
                            {books.length > 0 && (
                                <label className="field"><span className="eyebrow">Rules</span>
                                    <select value={mode} title="Bill at standard rates, or under a client's billing rules." onChange={(e) => setMode(e.target.value)}>
                                        <option value="generic">Generic (standard rates)</option>
                                        {books.map((b) => <option key={b.key} value={b.key}>{b.client}</option>)}
                                    </select>
                                </label>
                            )}
                        </div>
                        <p className="muted tiny">
                            {project ? `Bill to ${(project.billTo?.[0] || project.client) || "no one yet: set the client on the matter"}` : ""}{scope.to ? ` · through ${longDate(scope.to)}` : ""}
                            {bill.lines.length ? ` · ${bill.lines.length} ${bill.lines.length === 1 ? "line" : "lines"}, ${bill.totals.billedHours.toFixed(1)} h` : " · nothing kept on this matter in this period"}
                            {bill.book && bill.standard !== bill.totals.fees ? ` · generic ${money(bill.standard)} → ${shortName(bill.book)} ${money(bill.totals.fees)}` : ""}
                            {w.billing?.folder ? ` · saved in ${w.billing.folder}` : " · you will be asked where to save it"}
                        </p>
                    </>
                )}
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span className="mono accent big">{money(bill.totals.fees)}</span>
                    <span className="row gap">
                        <button type="button" className="quiet" title="Close without making a file." onClick={onClose}>Cancel</button>
                        {kind === "timesheet" && <button type="button" className="quiet" disabled={!!busy || !bill.lines.length} title="The time detail as a Word file; a client's rules show as tracked changes." onClick={() => void run("docx")}>{busy === "docx" ? "Making…" : "Word"}</button>}
                        <button type="submit" className="primary" disabled={!!busy || !bill.lines.length} title={kind === "invoice" ? "Make the invoice as a PDF and open it." : "Make the time detail as a PDF and open it."}>{busy === kind ? "Making…" : kind === "invoice" ? "Make invoice (PDF)" : "Make time sheet (PDF)"}</button>
                    </span>
                </div>
            </form>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Settings → Billing: the firm's side of every invoice

const lines = (s: string): string[] => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function BillingSettings({ w }: { w: Workspace }): ReactNode {
    const b = w.billing ?? null;
    const [firm, setFirm] = useState(b?.firm.name ?? "");
    const [address, setAddress] = useState(b?.firm.address.join("\n") ?? "");
    const [name, setName] = useState(b?.timekeeper.name ?? w.profile?.name ?? "");
    const [title, setTitle] = useState(b?.timekeeper.title ?? w.profile?.title ?? "");
    const [terms, setTerms] = useState(b?.terms ?? "Net 30");
    const [remit, setRemit] = useState(b?.remit?.join("\n") ?? "");
    const [contact, setContact] = useState(b?.contact ?? "");
    const [prefix, setPrefix] = useState(b?.invoicePrefix ?? `${new Date().getFullYear()}-`);
    const [next, setNext] = useState(String(b?.nextInvoice ?? 1));
    const [site, setSite] = useState("");
    const [logo, setLogo] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    useEffect(() => { void window.lawdie.billingLogo().then(setLogo); }, [b?.logo]);
    const input: BillingSetup = { firm: { name: firm, address: lines(address) }, timekeeper: { name, title }, terms, remit: lines(remit), contact, invoicePrefix: prefix, nextInvoice: Number(next) };
    const saved: BillingSetup | null = b && { firm: b.firm, timekeeper: b.timekeeper, terms: b.terms ?? "", remit: b.remit ?? [], contact: b.contact ?? "", invoicePrefix: b.invoicePrefix ?? "", nextInvoice: b.nextInvoice ?? 1 };
    const changed = JSON.stringify({ ...input, terms: input.terms?.trim(), contact: input.contact?.trim(), invoicePrefix: input.invoicePrefix?.trim(), firm: { ...input.firm, name: input.firm.name.trim() }, timekeeper: { name: name.trim(), title: title.trim() } }) !== JSON.stringify(saved);
    const act = async (what: string, run: () => Promise<string | null | boolean>): Promise<void> => {
        setBusy(what); setProblem(null);
        const r = await run();
        setBusy(null);
        if (typeof r === "string") setProblem(r);
    };
    return (
        <div className="panel">
            <strong>Billing</strong>
            <p className="muted small">What every invoice and time sheet prints for the firm. The client, matter number and bill-to address come from each matter (Matters → the matter → Details).</p>
            <form className="billing-form" onSubmit={(e) => { e.preventDefault(); void act("save", () => window.lawdie.setBilling(input)); }}>
                <label className="field"><span className="eyebrow">Firm</span><input value={firm} placeholder="Firm name" title="The firm's name, at the top of every invoice." onChange={(e) => setFirm(e.target.value)} /></label>
                <label className="field"><span className="eyebrow">Address</span><textarea rows={3} value={address} placeholder={"100 Main Street, Suite 400\nAtlanta, GA 30303"} title="The firm's address, one line per line." onChange={(e) => setAddress(e.target.value)} /></label>
                <div className="row gap">
                    <label className="field"><span className="eyebrow">Timekeeper</span><input value={name} placeholder="Your name" title="Your name as the invoice's timekeeper summary prints it." onChange={(e) => setName(e.target.value)} /></label>
                    <label className="field"><span className="eyebrow">Title</span><input value={title} placeholder="Partner" title="Your title on the invoice." onChange={(e) => setTitle(e.target.value)} /></label>
                </div>
                <div className="row gap">
                    <label className="field"><span className="eyebrow">Payment terms</span><input value={terms} placeholder="Net 30" title="Printed under the total due." onChange={(e) => setTerms(e.target.value)} /></label>
                    <label className="field"><span className="eyebrow">Invoice prefix</span><input value={prefix} placeholder="2026-" title="The start of every invoice number." onChange={(e) => setPrefix(e.target.value)} /></label>
                    <label className="field short"><span className="eyebrow">Next number</span><input type="number" min="1" step="1" value={next} title="The number the next invoice gets; it moves on by itself." onChange={(e) => setNext(e.target.value)} /></label>
                </div>
                <label className="field"><span className="eyebrow">Remittance</span><textarea rows={2} value={remit} placeholder={"Check: Lockbox 1234, Atlanta, GA 30303\nWire: First Bank, account 000123, ABA 061000000"} title="Where and how to pay, printed at the foot of the invoice. Placeholders print without it." onChange={(e) => setRemit(e.target.value)} /></label>
                <label className="field"><span className="eyebrow">Billing contact</span><input value={contact} placeholder="Questions: billing@firm.com · (404) 555-0100" title="Who to ask about the invoice, printed with the payment terms." onChange={(e) => setContact(e.target.value)} /></label>
                <div className="row gap">
                    <span className="muted tiny grow">Next invoice: <span className="mono">{`${prefix.trim()}${String(Math.max(1, Number(next) || 1)).padStart(3, "0")}`}</span></span>
                    <button type="submit" className="primary" disabled={!changed || !firm.trim() || busy === "save"} title={changed ? "Save the firm's billing details." : "Change something first."}>{busy === "save" ? "Saving…" : "Save"}</button>
                </div>
            </form>
            <div className="setting">
                <div className="grow"><div className="small strong">Logo</div><p className="muted tiny">On the letterhead of every invoice and time sheet. Fetched from the firm's website (its icon or share image) or chosen as a PNG or JPEG.</p></div>
                {logo ? <img className="logo-preview" src={logo} alt="The firm's logo" /> : <span className="logo-preview none muted tiny">None</span>}
            </div>
            <div className="row gap wrap">
                <input value={site} placeholder="firm.com" title="The firm's website, to fetch its logo from." disabled={!b} onChange={(e) => setSite(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void act("fetch", () => window.lawdie.fetchLogo(site)); } }} />
                <button type="button" className="quiet" disabled={!b || !site.trim() || !!busy} title={b ? "Look for the logo on that website and keep the best picture it offers." : "Save the firm's name first."} onClick={() => void act("fetch", () => window.lawdie.fetchLogo(site))}>{busy === "fetch" ? "Looking…" : "Fetch from website"}</button>
                <button type="button" className="quiet" disabled={!b || !!busy} title={b ? "Choose a PNG or JPEG of the logo." : "Save the firm's name first."} onClick={() => void act("choose", () => window.lawdie.chooseLogo())}>Choose file…</button>
                {logo && <button type="button" className="quiet" disabled={!!busy} title="Take the logo off the letterhead." onClick={() => void act("remove", () => window.lawdie.removeLogo())}>Remove</button>}
            </div>
            <div className="setting">
                <div className="grow"><div className="small strong">Where files go</div><p className="muted tiny mono">{b?.folder ?? "Asked for each time, and remembered."}</p></div>
                <button type="button" className="quiet" disabled={!b} title={b ? "Choose the folder invoices and time sheets are saved in." : "Save the firm's name first."} onClick={() => void act("folder", () => window.lawdie.chooseBillingFolder())}>Choose folder…</button>
            </div>
            {problem && <p className="danger small">{problem}</p>}
        </div>
    );
}
