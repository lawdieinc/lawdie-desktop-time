import { useState, type ReactNode } from "react";
import type { Activity, Workspace } from "@shared/model";
import { clock, keepBounds, timeValue } from "@shared/format";
import { hoursText, hr } from "@shared/billingMode";
import { knownMatters } from "@shared/matters";
import { NOTE_MAX } from "@shared/manual";

/* Time put in or corrected by hand (src/shared/manual.ts): hours typed on a row or an entry, a sitting's start and
   end changed in place, a sitting added to a matter's row, and Activity's "Add time". Everything added waits in
   To review like captured time. A refused change is explained by the window's banner. */

const SAVE_FAILED = "That could not be saved.";

/** Hours as a control: press to type other hours. Enter or leaving saves, Escape cancels; emptied, `onSave(null)` (back to the time, rounded). */
export function HoursEdit({ hours, set = false, title, onSave }: { hours: number; set?: boolean; title: string; onSave: (hours: number | null) => void }): ReactNode {
    const [text, setText] = useState<string | null>(null);
    const finish = (save: boolean): void => {
        const t = (text ?? "").trim();
        setText(null);
        if (!save) return;
        if (!t) { if (set) onSave(null); return; }
        const h = Number(t);
        if (Number.isFinite(h) && h > 0 && h <= 24 && h !== hours) onSave(Math.round(h * 100) / 100);
    };
    if (text !== null) return (
        <input className="inline-edit hours-input" type="number" step="0.05" min="0" max="24" autoFocus value={text} aria-label="Hours" title="Hours to bill. Enter saves, Escape cancels; empty goes back to the captured time."
            onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => finish(true)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }} />
    );
    return <button type="button" className={"hours-edit mono" + (set ? " set" : "")} title={`${title}${set ? " You set these hours." : ""} Press to change the hours.`} onClick={() => setText(hoursText(hours))}>{hr(hours)}</button>;
}

/** May this sitting's times be changed in place? Not imported or calendar time, which keep the times they came with. */
export const timesEditable = (a: Activity): boolean => a.disposition === "pending" && !a.origin && !a.ownerID.startsWith("calendar:");

/** A sitting's times as a control: press to change its start and end. */
export function TimeEdit({ a, notify }: { a: Activity; notify: (text: string) => void }): ReactNode {
    const [editing, setEditing] = useState(false);
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const label = `${clock(a.startedAt)}–${clock(a.endedAt)}`;
    if (!timesEditable(a)) return <span className="small">{label}</span>;
    const save = async (): Promise<void> => {
        if (!start || !end) return;
        const b = keepBounds(a, start, end);
        setEditing(false);
        if (!b.changed) return;
        const ok = await window.lawdie.editActivityTime(a.id, new Date(b.start).toISOString(), new Date(b.end).toISOString());
        if (!ok) notify(SAVE_FAILED);
    };
    if (!editing) return <button type="button" className={"time-edit small" + (a.timeEdited ? " set" : "")} title={`${a.timeEdited ? "You changed these times. " : ""}Press to change when this sitting started and ended.`} onClick={() => { setStart(timeValue(a.startedAt)); setEnd(timeValue(a.endedAt)); setEditing(true); }}>{label}</button>;
    return (
        <form className="time-form" onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}>
            <input type="time" autoFocus value={start} aria-label="Start" title="When this sitting started." onChange={(e) => setStart(e.target.value)} />
            <span className="muted">–</span>
            <input type="time" value={end} aria-label="End" title="When this sitting ended." onChange={(e) => setEnd(e.target.value)} />
            <button type="submit" className="link" disabled={!start || !end} title="Save these times.">Save</button>
            <button type="button" className="link muted" title="Leave the times as they were." onClick={() => setEditing(false)}>Cancel</button>
        </form>
    );
}

/** Each sitting's times, to change in place. */
export function SittingTimes({ acts, notify }: { acts: readonly Activity[]; notify: (text: string) => void }): ReactNode {
    const list = [...acts].sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
    if (!list.some(timesEditable)) return null;
    return <div className="sitting-times">{list.map((a) => <TimeEdit key={a.id} a={a} notify={notify} />)}</div>;
}

const dayKey = (t: number): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** A day and two "HH:MM" as a span; an end not after the start is on the next day. */
function spanOf(day: string, start: string, end: string): { startedAt: string; endedAt: string } {
    const from = new Date(`${day}T${start}:00`).getTime();
    let to = new Date(`${day}T${end}:00`).getTime();
    if (to <= from) to += 86_400_000;
    return { startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString() };
}

/** Under a matter's items: a sitting the person adds to that row, on the row's day. */
export function AddSitting({ like, day, notify }: { like: string; day: string; notify: (text: string) => void }): ReactNode {
    const [open, setOpen] = useState(false);
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [note, setNote] = useState("");
    const add = async (): Promise<void> => {
        const ok = await window.lawdie.addManualTime({ ...spanOf(dayKey(Date.parse(day)), start, end), note, like });
        if (!ok) { notify(SAVE_FAILED); return; }
        setOpen(false); setStart(""); setEnd(""); setNote("");
    };
    if (!open) return <button type="button" className="link add-sitting" title="Add time capture missed, such as a call or a meeting away from the computer. It joins this row." onClick={() => setOpen(true)}>+ Add sitting</button>;
    return (
        <form className="time-form add-sitting" onSubmit={(e) => { e.preventDefault(); void add(); }} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
            <input type="time" autoFocus required value={start} aria-label="Start" title="When it started." onChange={(e) => setStart(e.target.value)} />
            <span className="muted">–</span>
            <input type="time" required value={end} aria-label="End" title="When it ended." onChange={(e) => setEnd(e.target.value)} />
            <input className="grow" value={note} maxLength={NOTE_MAX} placeholder="What it was (optional)" aria-label="What it was" title="What this time was, such as a call with the client." onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className="link" disabled={!start || !end} title="Add this sitting to the row.">Add</button>
            <button type="button" className="link muted" title="Close without adding." onClick={() => setOpen(false)}>Cancel</button>
        </form>
    );
}

/** Activity's "Add time": time capture did not see, put in by hand. It lands in To review. */
export function AddTimeSheet({ w, now, onClose, notify }: { w: Workspace; now: number; onClose: () => void; notify: (text: string) => void }): ReactNode {
    const [matter, setMatter] = useState("");
    const [note, setNote] = useState("");
    const [day, setDay] = useState(dayKey(now));
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const ready = !!day && !!start && !!end;
    const add = async (): Promise<void> => {
        if (!ready) return;
        const ok = await window.lawdie.addManualTime({ ...spanOf(day, start, end), note, matter: matter.trim() || null });
        if (!ok) { setProblem("That could not be added. Check the times: the end must be after the start, and not in the future."); return; }
        notify(`Added to To review${matter.trim() ? ` on ${matter.trim()}` : ""}. Approve it to keep the time.`);
        onClose();
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void add(); }}>
                <div className="heading"><p className="eyebrow">Activity</p><h2 className="display">Add time</h2><p className="muted small">For work capture did not see, such as a call or a meeting away from the computer. It waits in To review with the rest.</p></div>
                <label className="field"><span className="eyebrow">Matter</span>
                    <input list="add-time-matters" value={matter} maxLength={120} placeholder="A matter, or leave empty" title="The matter this time is for. Leave it empty to decide in review." onChange={(e) => setMatter(e.target.value)} />
                    <datalist id="add-time-matters">{knownMatters(w).map((m) => <option key={m} value={m} />)}</datalist>
                </label>
                <label className="field"><span className="eyebrow">Description</span><input autoFocus value={note} maxLength={NOTE_MAX} placeholder="What the work was" title="What the work was: the description it is kept with." onChange={(e) => setNote(e.target.value)} /></label>
                <div className="row gap">
                    <label className="field"><span className="eyebrow">Date</span><input type="date" required value={day} max={dayKey(now)} title="The day of the work." onChange={(e) => setDay(e.target.value)} /></label>
                    <label className="field"><span className="eyebrow">Start</span><input type="time" required value={start} title="When it started." onChange={(e) => setStart(e.target.value)} /></label>
                    <label className="field"><span className="eyebrow">End</span><input type="time" required value={end} title="When it ended." onChange={(e) => setEnd(e.target.value)} /></label>
                </div>
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span />
                    <span className="row gap"><button type="button" className="quiet" title="Close without adding any time." onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={!ready} title={ready ? "Add this time to To review." : "Enter the date and both times first."}>Add to review</button></span>
                </div>
            </form>
        </div>
    );
}
