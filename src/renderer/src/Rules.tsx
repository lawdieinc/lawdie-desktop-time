import { useState, type ReactNode } from "react";
import type { Project, TimeEntry, Workspace } from "@shared/model";
import { narrativeFor } from "@shared/narrative";
import { applyFix, checkEntry, rulebookFor, rulesMet, type CheckContext, type EntryDraft, type Finding, type Fix, type PlanLine } from "@shared/rules";

/* The client's billing rules in the window: what each finding says, the clause it cites,
   and the fix a person accepts with one click. src/shared/rules.ts does the checking. */

/** The rules context of a matter, by name or project: its client's rule set, its people, the timekeeper. */
export function rulesContext(w: Workspace, project: Project | null | undefined): CheckContext {
    return { book: project ? rulebookFor(w, project.context, project.client) : null, ctx: project?.context ?? null, profile: w.profile ?? null };
}

export const projectByName = (w: Workspace, name: string): Project | undefined => w.projects.find((p) => !p.archived && p.name.trim().toLowerCase() === name.trim().toLowerCase());

const localDay = (t: string | number): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** A kept entry as the rules see it. */
export function draftOf(e: TimeEntry): EntryDraft {
    const secs = (e.sittings?.length ? e.sittings : [e]).reduce((n, i) => n + (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000, 0);
    return { id: e.id, description: e.description, hours: e.hours ?? Math.round((secs / 3600) * 100) / 100, taskCode: e.taskCode, activityCode: e.activityCode, billable: e.billable, hourlyRate: e.hourlyRate, day: localDay(e.startedAt) };
}

/** Entries on the same matter and day, for the rules that look across a day (one email entry, research hours). */
export function sameDayOf(w: Workspace, projectID: string | null, day: string, except?: string): EntryDraft[] {
    return w.entries.filter((e) => e.projectID === projectID && e.id !== except && localDay(e.startedAt) === day).map(draftOf);
}

/** The narrative capture gives an entry's own sittings, offered when what was typed is vague. */
export function suggestionFor(w: Workspace, e: TimeEntry, c: CheckContext): string | null {
    const ids = new Set([e.activityID, ...(e.activityIDs ?? [])].filter(Boolean));
    const acts = w.activities.filter((a) => ids.has(a.id));
    return acts.length && c.ctx ? narrativeFor(acts, c.ctx, c.profile?.name ?? null) : null;
}

const possessive = (name: string): string => (name.endsWith("s") ? `${name}'` : `${name}'s`);
const shortClient = (c: CheckContext): string => possessive(c.book?.client ?? "the client");

/** Each finding with its clause and its fixes; or, when nothing is found, every rule that was met. Never blank. */
export function RulesCheck({ draft, c, onFix, compact = false, canFold = true }: { draft: EntryDraft; c: CheckContext; onFix: (fix: Fix) => void; compact?: boolean; canFold?: boolean }): ReactNode {
    if (!c.book) return null;
    // A kept entry cannot fold into another kept entry here; that fix is offered only while keeping.
    const found = checkEntry(draft, c).map((f) => (canFold ? f : { ...f, fixes: f.fixes.filter((x) => !x.foldInto) }));
    if (!found.length) {
        const met = rulesMet(draft, c);
        return (
            <div className="rules ok" title={met.map((r) => `${r.title} (${r.clause || r.sourceRef || r.id})`).join("\n")}>
                <span className="rules-mark" aria-hidden="true">✓</span>
                <span className="small">Meets {shortClient(c)} rules</span>
                {!compact && <span className="tiny muted">{met.length} checked at entry · {met.filter((r) => (c.book?.newRuleIds ?? []).includes(r.id)).length ? `${met.filter((r) => (c.book?.newRuleIds ?? []).includes(r.id)).length} new from the client` : c.book.guidelines}</span>}
            </div>
        );
    }
    return <div className="findings">{found.map((f) => <FindingRow key={f.rule.id} f={f} onFix={onFix} />)}</div>;
}

function FindingRow({ f, onFix }: { f: Finding; onFix: (fix: Fix) => void }): ReactNode {
    return (
        <div className={"finding" + (f.fromClient ? " from-client" : "")}>
            <div className="row between">
                <span className="small strong">{f.rule.title}</span>
                {f.isNew && <span className="new-tag" title="This rule arrived with the client's latest rules update.">New rule</span>}
            </div>
            <div className="small">{f.message}</div>
            <div className="tiny cite" title={f.rule.text}>{f.cite}</div>
            {f.fixes.length > 0 && (
                <div className="row gap wrap">
                    {f.fixes.map((x) => (
                        <button key={x.label} type="button" className="fix" title={fixTip(x)} onClick={() => onFix(x)}>{x.label}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

const fixTip = (x: Fix): string =>
    x.split ? "Make one entry for each task, each with its own captured time."
        : x.change.description !== undefined ? "Replace the narrative with this fixed one."
            : x.change.hourlyRate !== undefined ? "Change the rate on this entry to the one shown."
                : x.change.billable === false ? "Keep this time on the record as no charge."
                    : x.change.hours !== undefined ? "Change the billed hours to the one shown."
                        : "Set these codes on the entry.";

/** One line of a split: its narrative, hours and codes, editable, with its own findings. */
export function SplitLines({ lines, setLines, c, sameDay }: { lines: PlanLine[]; setLines: (l: PlanLine[]) => void; c: CheckContext; sameDay: EntryDraft[] }): ReactNode {
    const set = (n: number, change: Partial<EntryDraft>) => setLines(lines.map((l, i) => (i === n ? { ...l, draft: { ...l.draft, ...change } } : l)));
    return (
        <div className="split-lines">
            {lines.map((l, n) => (
                <div className="split-line" key={l.activityIDs.join(",")}>
                    <div className="row gap">
                        <input className="grow" value={l.draft.description} title="Edit this entry's narrative; the rules check it as you type." onChange={(e) => set(n, { description: e.target.value })} />
                        <input className="hours" type="number" step="0.1" min="0" value={l.draft.hours} title="Billed hours, from this task's captured time." onChange={(e) => set(n, { hours: Number(e.target.value) })} />
                        <input className="code" value={l.draft.taskCode ?? ""} placeholder="Task" title="UTBMS task code for this entry." onChange={(e) => set(n, { taskCode: e.target.value.toUpperCase() })} />
                        <input className="code" value={l.draft.activityCode ?? ""} placeholder="Act." title="UTBMS activity code for this entry." onChange={(e) => set(n, { activityCode: e.target.value.toUpperCase() })} />
                        <label className="row check" title="Bill this entry to the client."><input type="checkbox" title="Bill this entry to the client." checked={l.draft.billable} onChange={(e) => set(n, { billable: e.target.checked })} /> Bill</label>
                    </div>
                    <RulesCheck compact draft={l.draft} c={{ ...c, sameDay }} onFix={(fix) => setLines(lines.map((x, i) => (i === n ? { ...x, draft: applyFix(x.draft, fix), ...(fix.foldInto ? { foldInto: fix.foldInto } : {}) } : x)))} />
                </div>
            ))}
        </div>
    );
}

/** Change a kept entry. The rules check every keystroke; a fix changes the entry here before it is saved. */
export function EditSheet({ w, entry, onClose }: { w: Workspace; entry: TimeEntry; onClose: () => void }): ReactNode {
    const project = w.projects.find((p) => p.id === entry.projectID);
    const c = rulesContext(w, project);
    const [d, setD] = useState<EntryDraft>(draftOf(entry));
    const [problem, setProblem] = useState<string | null>(null);
    const suggestion = suggestionFor(w, entry, c);
    const check: CheckContext = { ...c, sameDay: sameDayOf(w, entry.projectID, d.day, entry.id), suggestion };
    const save = async (): Promise<void> => {
        if (!d.description.trim()) { setProblem("Add a description."); return; }
        // Hours are written only when the entry already bills hours or the person changed them, so a plain entry stays as it was.
        const sendHours = entry.hours !== undefined || d.hours !== draftOf(entry).hours;
        const ok = await window.lawdie.editEntry(entry.id, { description: d.description, ...(sendHours ? { hours: d.hours } : {}), taskCode: d.taskCode ?? "", activityCode: d.activityCode ?? "", billable: d.billable, hourlyRate: d.hourlyRate });
        if (ok) onClose(); else setProblem("That could not be saved.");
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet wide" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <div className="heading"><p className="eyebrow">{project?.name ?? "No matter"}</p><h2 className="display">Edit entry</h2></div>
                <label className="field"><span className="eyebrow">Narrative</span><input autoFocus value={d.description} title="Edit the narrative; the client's rules check it as you type." onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
                <div className="row gap">
                    <label className="field"><span className="eyebrow">Hours</span><input type="number" step="0.05" min="0" value={d.hours} title="Billed hours for this entry." onChange={(e) => setD({ ...d, hours: Number(e.target.value) })} /></label>
                    <label className="field"><span className="eyebrow">Task code</span><input value={d.taskCode ?? ""} title="UTBMS task code, such as P500." onChange={(e) => setD({ ...d, taskCode: e.target.value.toUpperCase() })} /></label>
                    <label className="field"><span className="eyebrow">Activity code</span><input value={d.activityCode ?? ""} title="UTBMS activity code, such as A103." onChange={(e) => setD({ ...d, activityCode: e.target.value.toUpperCase() })} /></label>
                    <label className="field"><span className="eyebrow">Rate</span><input type="number" step="5" min="0" value={d.hourlyRate} title="Hourly rate billed on this entry." onChange={(e) => setD({ ...d, hourlyRate: Number(e.target.value) })} /></label>
                    <label className="row gap check" title="Bill this entry to the client."><input type="checkbox" title="Bill this entry to the client." checked={d.billable} onChange={(e) => setD({ ...d, billable: e.target.checked })} /> Billable</label>
                </div>
                <RulesCheck draft={d} c={check} canFold={false} onFix={(fix) => setD(applyFix(d, fix))} />
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span className="mono accent big">{d.hours.toFixed(2).replace(/0$/, "")} h</span>
                    <span className="row gap"><button type="button" className="quiet" title="Close without saving." onClick={onClose}>Cancel</button><button type="submit" className="primary" title="Save the entry as shown.">Save</button></span>
                </div>
            </form>
        </div>
    );
}

/** A kept entry's line under its narrative: hours, codes, and whether it meets the client's rules. */
export function EntryRules({ w, entry }: { w: Workspace; entry: TimeEntry }): ReactNode {
    const project = w.projects.find((p) => p.id === entry.projectID);
    const c = rulesContext(w, project);
    if (!c.book) return null;
    const d = draftOf(entry);
    const found = checkEntry(d, { ...c, sameDay: sameDayOf(w, entry.projectID, d.day, entry.id) });
    return (
        <span className="entry-rules tiny">
            <span className="mono">{d.hours.toFixed(1)} h</span>
            {entry.taskCode && <span className="mono">{entry.taskCode}{entry.activityCode ? ` / ${entry.activityCode}` : ""}</span>}
            {!entry.billable && <span>no charge</span>}
            {found.length ? <span className="rule-flag" title={found.map((f) => `${f.rule.title}: ${f.cite}`).join("\n")}>{found.length} {found.length === 1 ? "rule" : "rules"} to fix{found.some((f) => f.isNew) ? " · new rule" : ""}</span>
                : <span className="rule-ok" title={`Checked against ${c.book.guidelines} and the client's later rules.`}>✓ Meets {possessive(c.book.client)} rules</span>}
        </span>
    );
}
