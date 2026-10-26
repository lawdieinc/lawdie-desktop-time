import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Evidence, Workspace } from "@shared/model";
import { ruleReports, type RuleReport } from "@shared/clientRules";
import { bookOf, money, rulebooksOf, shortName, termsOf } from "@shared/invoice";
import { applyRules } from "@shared/applyRules";
import { ImageViewer, SourceIcon } from "./Narrative";

/* A client's billing rules: the client, its guidelines and where they came from, then one card
   per rule with the client's words, what Lawdie does, what it does to today's entries, a switch,
   and the document and email it is written in. Switching a rule off takes it off the Time
   page, the time sheet and the invoice. */

type Filter = "all" | "changes" | "checked" | "none";
const FILTERS: { key: Filter; label: string; tip: string; test: (r: RuleReport) => boolean }[] = [
    { key: "all", label: "All", tip: "Every rule.", test: () => true },
    { key: "changes", label: "Changes today", tip: "Rules that change today's bill.", test: (r) => r.status === "changes" },
    { key: "checked", label: "Checked", tip: "Rules Lawdie checked today's entries against.", test: (r) => r.status === "pass" || r.status === "fail" },
    { key: "none", label: "Nothing today", tip: "Rules nothing today falls under.", test: (r) => r.status === "none" },
];
const STATUS_TIP: Record<RuleReport["status"], string> = {
    changes: "This rule changes today's bill.", pass: "Lawdie checked today's entries against this rule. They pass.",
    fail: "Some of today's entries do not meet this rule.", none: "Nothing today falls under this rule.",
};

/** "Priya Raman" → "P. Raman". */
const initialed = (name: string | undefined): string => { const p = (name ?? "").trim().split(/\s+/); return p.length > 1 ? `${p[0][0]}. ${p.slice(1).join(" ")}` : p[0] ?? ""; };
const dayOf = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

export function ClientRulesView({ w, bookKey, focusRule, day, onBack }: { w: Workspace; bookKey: string | null; focusRule: string | null; day: string | null; onBack: () => void }): ReactNode {
    const book = bookOf(w, bookKey) ?? bookOf(w, w.billingClient) ?? rulebooksOf(w)[0] ?? null;
    const [filter, setFilter] = useState<Filter>("all");
    const [shot, setShot] = useState<{ src: string; caption: string; id: string } | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const list = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!focusRule) return;
        const card = list.current?.querySelector<HTMLElement>(`[data-rule="${CSS.escape(focusRule)}"]`);
        card?.scrollIntoView({ block: "center" });
    }, [focusRule, book?.key]);
    if (!book) {
        return (
            <>
                <button type="button" className="link-btn back-link" title="Back to Time, where you were." onClick={onBack}>‹ Back to Time</button>
                <div className="empty"><strong>No client rules</strong><p className="muted small">This workspace has no client's billing rules.</p></div>
            </>
        );
    }
    const terms = termsOf(w);
    const reports = ruleReports(w, terms, book);
    const bill = applyRules(w, day, book.key);
    const shown = reports.filter(FILTERS.find((f) => f.key === filter)!.test);
    const ev = (id: string | null | undefined): Evidence | undefined => (id ? w.evidence?.[id] : undefined);
    const open = async (id: string, what: "link" | "path" | "screenshot"): Promise<void> => setProblem(await window.lawdie.openSource(id, what));
    const viewShot = async (id: string, caption: string): Promise<void> => { const src = await window.lawdie.screenshotData(id); if (src) setShot({ src, caption, id }); else void open(id, "screenshot"); };
    // The documents the rules are written in, the client's guidelines first, each with the email that delivered it.
    const docs = [...new Map([[book.doc, book.email], ...book.rules.flatMap((r) => (r.sources ?? []).map((s) => [s.doc, s.email ?? book.email] as [string, string]))]).entries()].filter(([d]) => ev(d));
    const actions = (id: string, x: Evidence, caption: string): ReactNode => (
        <span className="src-actions">
            {x.path && <button type="button" className="link-btn" title={`Open ${x.file ?? "the file"} on this Mac.`} onClick={() => void open(id, "path")}>Open file</button>}
            {x.link && <button type="button" className="link-btn" title="Open this email in Outlook on the web." onClick={() => void open(id, "link")}>Open in Outlook</button>}
            {x.screenshot && <button type="button" className="link-btn" title="See a picture of it as it looked." onClick={() => void viewShot(id, caption)}>Screenshot</button>}
        </span>
    );
    const docLine = (id: string, section?: string, page?: number | null): ReactNode => {
        const x = ev(id);
        if (!x) return null;
        const title = x.title ?? x.file ?? id;
        return (
            <span className="src-half">
                <SourceIcon ev={x} />
                <span className="src-label" title={x.file ?? title}>{title}{section ? ` · ${section}` : ""}{page ? ` · page ${page}` : ""}</span>
                {actions(id, x, title)}
            </span>
        );
    };
    const mailLine = (id: string | null | undefined): ReactNode => {
        const x = ev(id);
        if (!x || !id) return null;
        return (
            <span className="src-half">
                <SourceIcon ev={x} />
                <span className="src-label" title={x.subject ?? ""}>From {initialed(x.from)}, {dayOf(x.when)}</span>
                {actions(id, x, x.subject ?? "Email")}
            </span>
        );
    };
    return (
        <div className="rules-page">
            <button type="button" className="link-btn back-link" title="Back to Time, where you were, with these rules still applied." onClick={onBack}>‹ Back to Time</button>
            <header className="rules-hero">
                <p className="eyebrow">Client rules</p>
                <h2 className="display rules-client">{book.client}</h2>
                <p className="rules-guide">{book.title}{book.effective ? ` · Effective ${book.effective}` : ""}</p>
                {bill.lines.length > 0 && (
                    <p className="rules-figures" title="Today's settled entries at standard rates, then under these rules as they are switched now.">
                        <span className="muted">Generic</span> <span className="mono">{money(bill.standard)}</span><span className="arrow" aria-hidden="true">→</span><span className="strong">{shortName(book)}</span> <span className="mono strong accent">{money(bill.totals.fees)}</span>
                    </p>
                )}
            </header>
            {problem && <p className="danger small">{problem}</p>}
            {docs.length > 0 && (
                <section className="rules-section">
                    <p className="section-label"><span>Source documents</span></p>
                    <div className="source-docs">
                        {docs.map(([d, mail]) => {
                            const x = ev(d)!;
                            const m = ev(mail);
                            return (
                                <div key={d} className="source-doc">
                                    <div className="source-doc-head">
                                        <span className="doc-icon"><SourceIcon ev={x} /></span>
                                        <span className="doc-text"><span className="doc-title">{x.title ?? x.file}</span><span className="doc-file">{x.file}</span></span>
                                        {actions(d, x, x.title ?? x.file ?? d)}
                                    </div>
                                    {m && mail && (
                                        <div className="source-doc-mail">
                                            <SourceIcon ev={m} />
                                            <span className="src-label" title={m.subject ?? ""}>From {initialed(m.from)}, {dayOf(m.when)} · {m.subject}</span>
                                            {actions(mail, m, m.subject ?? "Email")}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}
            <div className="pill-tabs" role="tablist" aria-label="Which rules">
                {FILTERS.map((f) => {
                    const n = reports.filter(f.test).length;
                    return <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? "active" : ""} title={f.tip} onClick={() => setFilter(f.key)}>{f.label} <span className="pill-count">{n}</span></button>;
                })}
            </div>
            <section className="rules-section" ref={list}>
                <p className="section-label"><span>Rules</span></p>
                <div className="rule-cards">
                    {shown.map((r) => (
                        <article key={r.rule.id} data-rule={r.rule.id} className={"rule-card" + (r.rule.enabled ? "" : " off") + (r.rule.id === focusRule ? " focus" : "")}>
                            <div className="rule-head">
                                <span className="rule-id mono">{r.rule.id}</span>
                                <span className="rule-section">{r.rule.section}</span>
                                <h3 className="rule-title">{r.rule.title}</h3>
                                <span className="grow" />
                                {r.rule.enabled ? <span className={`rule-status ${r.status}`} title={STATUS_TIP[r.status]}>{r.status === "none" ? "Nothing today" : r.summary}</span> : <span className="rule-status none" title="Switched off: left out of the Time page, the time sheet and the invoice.">Off</span>}
                                <button type="button" role="switch" aria-checked={r.rule.enabled} aria-label={`${r.rule.id} on`} className={"toggle" + (r.rule.enabled ? " on" : "")}
                                    title={r.rule.enabled ? "On: Lawdie applies this rule to the Time page, the time sheet and the invoice. Click to switch it off." : "Off: left out. Click to switch it on."}
                                    onClick={() => void window.lawdie.setClientRule(book.key, r.rule.id, !r.rule.enabled)}><span /></button>
                            </div>
                            <blockquote className="rule-quote">“{r.rule.quote}”</blockquote>
                            <p className="rule-does">{r.rule.does}</p>
                            {r.rule.enabled && r.touches.length > 0 && (
                                <div className="rule-today">
                                    <p className="mini-label">Today</p>
                                    {r.touches.map((t, n) => (
                                        <div key={n} className={"touch-row" + (t.fail ? " fail" : "")}>
                                            <span className="touch-label" title={t.label}>{t.label}</span>
                                            <span className="touch-detail">{t.detail}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {(r.rule.sources?.length ?? 0) > 0 && (
                                <div className="rule-sources">
                                    <p className="mini-label">Source</p>
                                    {r.rule.sources!.map((s, n) => (
                                        <div key={n} className="src-row">
                                            {docLine(s.doc, s.section, s.page)}
                                            {mailLine(s.email)}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </article>
                    ))}
                    {!shown.length && <div className="empty"><strong>No rules here</strong><p className="muted small">Choose another filter above.</p></div>}
                </div>
            </section>
            {shot && <ImageViewer src={shot.src} caption={shot.caption} onOpen={() => void open(shot.id, "screenshot")} onClose={() => setShot(null)} />}
        </div>
    );
}
