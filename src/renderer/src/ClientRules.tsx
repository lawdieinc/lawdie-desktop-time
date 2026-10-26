import { useState, type ReactNode } from "react";
import type { Workspace } from "@shared/model";
import { ruleReports, rulesTotals, type RuleReport } from "@shared/clientRules";
import { money } from "@shared/invoice";

/* The client's billing rules, one card each: where the rule is, the client's words, what
   Lawdie does, whether it changes today's bill or only checks it, and the entries it touches.
   A rule switched off is left out of the DOCX time sheet and the rules invoice. */

const STATUS: Record<RuleReport["status"], { text: (r: RuleReport) => string; cls: string; tip: string }> = {
    changes: { text: (r) => r.summary, cls: "changes", tip: "This rule changes today's bill." },
    pass: { text: (r) => r.summary, cls: "pass", tip: "Lawdie checked today's entries against this rule. They pass." },
    fail: { text: (r) => r.summary, cls: "fail", tip: "Some of today's entries do not meet this rule." },
    none: { text: (r) => r.summary, cls: "none", tip: "Nothing today falls under this rule." },
};

export function ClientRulesView({ w, onBack }: { w: Workspace; onBack: () => void }): ReactNode {
    const terms = w.invoice;
    const book = w.clientRules;
    const [busy, setBusy] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    if (!terms || !book) {
        return (
            <>
                <button type="button" className="link back" title="Back to Time." onClick={onBack}>‹ Time</button>
                <div className="empty"><strong>No client rules</strong><p className="muted small">This workspace has no billing rules for a client.</p></div>
            </>
        );
    }
    const reports = ruleReports(w, terms);
    const t = rulesTotals(w, terms);
    const on = reports.filter((r) => r.rule.enabled);
    const changing = on.filter((r) => r.status === "changes").length;
    const passing = on.filter((r) => r.status === "pass").length;
    const failing = on.filter((r) => r.status === "fail").length;
    const run = async (what: "docx" | "pdf"): Promise<void> => {
        setBusy(what);
        setProblem(what === "docx" ? await window.lawdie.makeDocx() : await window.lawdie.makePdf("invoice", "rules"));
        setBusy(null);
    };
    return (
        <>
            <button type="button" className="link back" title="Back to Time." onClick={onBack}>‹ Time</button>
            <div className="heading">
                <p className="eyebrow">Client rules</p>
                <h2 className="display">{book.client}</h2>
                <p className="muted">{book.title}</p>
            </div>
            <section className="panel rules-strip">
                <div className="strip-figure" title="Today's settled entries at standard rates, before any client rule."><span className="eyebrow">Standard</span><span className="mono big">{money(t.standard)}</span></div>
                <span className="strip-arrow" aria-hidden="true">→</span>
                <div className="strip-figure" title="The same entries with the rules that are on."><span className="eyebrow">With rules</span><span className="mono big accent">{money(t.withRules)}</span></div>
                <div className="strip-counts small">
                    <span>{changing} {changing === 1 ? "rule changes" : "rules change"} today's bill</span>
                    <span>{passing} checked, {failing ? `${failing} not met` : "all pass"}</span>
                    {reports.length - on.length > 0 && <span className="muted">{reports.length - on.length} switched off</span>}
                </div>
                <span className="grow" />
                <span className="row gap">
                    <button type="button" className="quiet" disabled={!!busy} title="Save the time sheet with these rules applied as Word tracked changes and comments, then open it." onClick={() => void run("docx")}>{busy === "docx" ? "Making…" : "Time sheet with rules (DOCX)"}</button>
                    <button type="button" className="primary" disabled={!!busy} title="Save the invoice with these rules applied as a PDF, then open it." onClick={() => void run("pdf")}>{busy === "pdf" ? "Making…" : "Invoice with rules (PDF)"}</button>
                </span>
            </section>
            {problem && <p className="danger small">{problem}</p>}
            <div className="rule-cards">
                {reports.map((r) => <RuleCard key={r.rule.id} r={r} />)}
            </div>
        </>
    );
}

function RuleCard({ r }: { r: RuleReport }): ReactNode {
    const s = STATUS[r.status];
    const on = r.rule.enabled;
    return (
        <section className={"rule-card" + (on ? "" : " off")}>
            <div className="rule-head">
                <span className="rule-id mono">{r.rule.id}</span>
                <span className="rule-section">{r.rule.section}</span>
                <strong className="rule-title">{r.rule.title}</strong>
                <span className="grow" />
                {on && <span className={`rule-status ${s.cls}`} title={s.tip}>{s.text(r)}</span>}
                <button type="button" role="switch" aria-checked={on} aria-label={`${r.rule.id} on`} className={"toggle" + (on ? " on" : "")}
                    title={on ? "On: Lawdie applies this rule to the DOCX time sheet and the rules invoice. Click to switch it off." : "Off: left out of the DOCX time sheet and the rules invoice. Click to switch it on."}
                    onClick={() => void window.lawdie.setClientRule(r.rule.id, !on)}><span /></button>
            </div>
            <blockquote className="rule-quote">“{r.rule.quote}”</blockquote>
            <p className="rule-does small"><span className="muted">What Lawdie does: </span>{r.rule.does}</p>
            {on && r.touches.length > 0 && (
                <ul className="rule-touches">
                    {r.touches.map((t, n) => (
                        <li key={n} className={t.fail ? "fail" : ""}>
                            <span className="touch-label">{t.label}</span>
                            <span className="touch-detail">{t.detail}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
