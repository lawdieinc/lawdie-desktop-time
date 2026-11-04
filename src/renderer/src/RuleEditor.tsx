import { useState, type ReactNode } from "react";
import type { ClientRule, ClientRulebook, Workspace } from "@shared/model";
import { RULE_CHECKS, RULE_KINDS, describeRule, type ClientRuleInput, type RuleCheck, type RuleKind } from "@shared/clientRulebooks";

/* Making and changing a client's rules in the app (2026-11-04): a sheet for the rulebook (the
   client, its guidelines, when they took effect) and a sheet for one rule (its kind, what the
   kind needs, the client's words, what Lawdie does). src/shared/clientRulebooks.ts checks and
   saves; a refusal comes back as text. */

/** A new rulebook, or the client, title and effective date of an existing one. */
export function RulebookSheet({ book, onClose, onSaved }: { book: ClientRulebook | null; onClose: () => void; onSaved: (key: string) => void }): ReactNode {
    const [client, setClient] = useState(book?.client ?? "");
    const [title, setTitle] = useState(book?.title ?? "");
    const [effective, setEffective] = useState(book?.effective ?? "");
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const save = async (): Promise<void> => {
        setBusy(true); setProblem(null);
        if (book) {
            const ok = await window.lawdie.updateRulebook(book.key, { client, title, effective });
            setBusy(false);
            if (ok) onSaved(book.key); else setProblem("Those details could not be saved. Is there already a rulebook for that client?");
        } else {
            const key = await window.lawdie.addRulebook({ client, title, effective });
            setBusy(false);
            if (key) onSaved(key); else setProblem("The rulebook could not be made. Name the client; there may already be a rulebook for it.");
        }
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <div className="heading"><p className="eyebrow">Client rules</p><h2 className="display">{book ? "Rulebook" : "New rulebook"}</h2></div>
                <label className="field"><span className="eyebrow">Client</span><input autoFocus value={client} placeholder="Northlake Behavioral Health, Inc." title="The client whose billing rules these are; its matters are matched by this name." onChange={(e) => setClient(e.target.value)} /></label>
                <label className="field"><span className="eyebrow">Guidelines</span><input value={title} placeholder="Outside Counsel Guidelines (2026)" title="What the rules are written in, as the rules page names it." onChange={(e) => setTitle(e.target.value)} /></label>
                <label className="field"><span className="eyebrow">Effective</span><input value={effective} placeholder="January 1, 2026" title="When the guidelines took effect." onChange={(e) => setEffective(e.target.value)} /></label>
                <p className="muted tiny">A matter whose client is this name bills under these rules when you choose them on the Time page or in the Invoice sheet, and the Keep sheet checks its entries against the rules that apply to one entry.</p>
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span />
                    <span className="row gap"><button type="button" className="quiet" title="Close without saving." onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !client.trim()} title={book ? "Save the rulebook's details." : "Make the rulebook, then add its rules."}>{book ? "Save" : "Make rulebook"}</button></span>
                </div>
            </form>
        </div>
    );
}

/** One rule: new, or an existing one to change. */
export function RuleSheet({ w, book, rule, onClose }: { w: Workspace; book: ClientRulebook; rule: ClientRule | null; onClose: () => void }): ReactNode {
    const [kind, setKind] = useState<RuleKind>(rule?.kind ?? "tenths");
    const [title, setTitle] = useState(rule?.title ?? "");
    const [section, setSection] = useState(rule?.section ?? "");
    const [quote, setQuote] = useState(rule?.quote ?? "");
    const [does, setDoes] = useState(rule?.does ?? "");
    const [rate, setRate] = useState(rule?.rate ? String(rule.rate) : "");
    const [maxHours, setMaxHours] = useState(rule?.maxHours ? String(rule.maxHours) : "");
    const [activityCode, setActivityCode] = useState(rule?.activityCode ?? "A105");
    const [words, setWords] = useState(rule?.words?.join(", ") ?? "");
    const [code, setCode] = useState<"task" | "activity">(rule?.code ?? "task");
    const [check, setCheck] = useState<RuleCheck>(rule?.check ?? "vague");
    const [approved, setApproved] = useState(rule?.approved?.join(", ") ?? (w.billing?.timekeeper.name ?? w.profile?.name ?? ""));
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const info = RULE_KINDS.find((k) => k.kind === kind)!;
    const split = (s: string): string[] => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const input: ClientRuleInput = {
        ...(rule ? { id: rule.id } : {}), kind, title, section, quote, does,
        rate: Number(rate) || undefined, maxHours: Number(maxHours) || undefined, activityCode, words: split(words), code, check, approved: split(approved),
    };
    const preview = describeRule({ ...input, words: input.words, approved: input.approved } as ClientRule);
    const save = async (): Promise<void> => {
        setBusy(true); setProblem(null);
        const id = await window.lawdie.saveClientRule(book.key, input);
        setBusy(false);
        if (id) onClose();
        else setProblem(`The rule could not be saved. ${info.needs === "rate" ? "Enter the rate." : info.needs === "maxHours" ? "Enter the hours." : info.needs === "activityCode" ? "Enter an activity code such as A105." : info.needs === "words" ? "Enter at least one word." : check === "timekeepers" ? "List the approved timekeepers." : "Give it a title."}`);
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet wide rule-sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <div className="heading"><p className="eyebrow">{book.client}</p><h2 className="display">{rule ? `Rule ${rule.id}` : "New rule"}</h2></div>
                <div className="row gap wrap">
                    <label className="field grow"><span className="eyebrow">What the rule does</span>
                        <select value={kind} title="The kind of rule: what Lawdie does with entries that fall under it." onChange={(e) => setKind(e.target.value as RuleKind)}>
                            {RULE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                        </select>
                    </label>
                    {info.needs === "rate" && <label className="field short"><span className="eyebrow">Rate cap ($/h)</span><input type="number" min="1" step="5" value={rate} placeholder="1075" title="No hour bills above this." onChange={(e) => setRate(e.target.value)} /></label>}
                    {info.needs === "maxHours" && <label className="field short"><span className="eyebrow">Most hours</span><input type="number" min="0.1" step="0.1" value={maxHours} placeholder="0.5" title="A call bills at most this." onChange={(e) => setMaxHours(e.target.value)} /></label>}
                    {info.needs === "activityCode" && <label className="field short"><span className="eyebrow">Activity code</span><input value={activityCode} placeholder="A105" title="The UTBMS activity code; A105 is an internal conference." onChange={(e) => setActivityCode(e.target.value.toUpperCase())} /></label>}
                    {info.needs === "code" && <label className="field short"><span className="eyebrow">Which code</span><select value={code} title="Which UTBMS code goes in front." onChange={(e) => setCode(e.target.value as "task" | "activity")}><option value="task">Task (P500)</option><option value="activity">Activity (A103)</option></select></label>}
                    {info.needs === "check" && <label className="field grow"><span className="eyebrow">Check</span>
                        <select value={check} title="What Lawdie checks each entry for." onChange={(e) => setCheck(e.target.value as RuleCheck)}>
                            {RULE_CHECKS.map((c) => <option key={c.check} value={c.check}>{c.label}</option>)}
                        </select>
                    </label>}
                    {info.needs === "check" && check === "researchCap" && <label className="field short"><span className="eyebrow">Hours</span><input type="number" min="0.5" step="0.5" value={maxHours} placeholder="5" title="Research over this needs approval." onChange={(e) => setMaxHours(e.target.value)} /></label>}
                </div>
                {info.needs === "words" && <label className="field"><span className="eyebrow">Words</span><input value={words} placeholder="training, onboarding" title="Any of these in a narrative puts the entry at no charge; separate with commas." onChange={(e) => setWords(e.target.value)} /></label>}
                {info.needs === "check" && check === "timekeepers" && <label className="field"><span className="eyebrow">Approved timekeepers</span><input value={approved} placeholder="R. Delacroix, T. Navarro" title="Who may bill this client, as the lines name them; separate with commas." onChange={(e) => setApproved(e.target.value)} /></label>}
                <p className="muted tiny">{info.hint}</p>
                <div className="row gap wrap">
                    <label className="field grow"><span className="eyebrow">Title</span><input value={title} placeholder={info.label} title="The rule's name on its card and in each change it makes." onChange={(e) => setTitle(e.target.value)} /></label>
                    <label className="field short"><span className="eyebrow">Section</span><input value={section} placeholder="§4.1" title="Where the guidelines say it, cited on every change." onChange={(e) => setSection(e.target.value)} /></label>
                </div>
                <label className="field"><span className="eyebrow">The client's words</span><textarea rows={2} value={quote} placeholder="Time is recorded in increments of one-tenth of an hour." title="The clause as the client wrote it; quoted on the rule's card and in the Word time sheet's comments." onChange={(e) => setQuote(e.target.value)} /></label>
                <label className="field"><span className="eyebrow">What Lawdie does</span><textarea rows={2} value={does} placeholder={preview} title="In your words, or leave it and Lawdie says it from the rule's kind." onChange={(e) => setDoes(e.target.value)} /></label>
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span />
                    <span className="row gap"><button type="button" className="quiet" title="Close without saving." onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={busy || !title.trim()} title={rule ? "Save the rule; the bill reflects it at once." : "Add the rule to the rulebook, switched on."}>{rule ? "Save" : "Add rule"}</button></span>
                </div>
            </form>
        </div>
    );
}
