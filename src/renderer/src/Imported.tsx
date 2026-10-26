import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ImportedRow, TimeEntry, Workspace } from "@shared/model";
import { recordedHours } from "@shared/importMatch";
import { splitNote } from "@shared/typed";
import { AppMark, NarrativeEntry, SourceIcon, rowKind, timeRange, whereTime, workTitle } from "./Narrative";

/* Typed entries: rows imported from iTimeKeep and simple entries added on the Time page
   ("call w/ client", 0.9). Each shows as typed until it is expanded. "Expand narrative" (one
   row) or "Link sources and draft narratives" (every imported row) matches the note to the
   captured work behind it and shows the link being made: lines from the note to the emails,
   meetings, transcripts, documents and desktop stretches of that work, and the entry's drafted
   narrative appearing under it. The narrative is the one already drafted from those sources by
   the rules drafter: no model, the same every time. Then the row shows entered against
   recorded hours, the narrative with its Why dropdown, and the choice: use it, keep the note,
   or edit. Accepting folds the note into the captured entry; it never adds hours. */

/** Hours as typed: "0.9", "0.25". */
const hrs = (n: number): string => (Math.round(n * 100) % 10 ? n.toFixed(2) : n.toFixed(1));
/** "61407-002 Northlake" for a matter picked here; the matter as typed for an imported row. */
const matterShort = (w: Workspace, r: ImportedRow): string => {
    const p = r.projectID ? w.projects.find((x) => x.id === r.projectID) : undefined;
    return p ? `${p.name.split(" ")[0]} ${p.client.split(" ")[0]}` : r.matter || "·";
};
const entryOf = (w: Workspace, r: ImportedRow): TimeEntry | undefined => (r.entryID ? w.entries.find((e) => e.id === r.entryID) : undefined);

// ---------------------------------------------------------------------------
// Imported rows

export function ImportedPanel({ w }: { w: Workspace }): ReactNode {
    const rows = (w.imported ?? []).filter((r) => r.origin !== "manual");
    const open = rows.filter((r) => !r.linked);
    const [batch, setBatch] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const matched = rows.filter((r) => r.linked && entryOf(w, r)).length;
    const linkAll = async (): Promise<void> => {
        const ids = open.map((r) => r.id);
        setBusy(true);
        const ok = await window.lawdie.linkImport();
        setBusy(false);
        if (ok) setBatch(ids);
    };
    const shown = batch ? rows.filter((r) => batch.includes(r.id) && r.linked) : [];
    return (
        <section className="panel">
            <div className="row between">
                <span className="row gap"><strong>Entered in iTimeKeep</strong><span className="muted small">{rows.length} {rows.length === 1 ? "entry" : "entries"}{open.length ? ` · ${open.length} as typed` : ""}{rows.length - open.length ? ` · ${matched} matched to captured work` : ""}</span></span>
                <span className="row gap">
                    {!batch && rows.some((r) => r.linked) && <button type="button" className="link-btn" title="Show Lawdie linking each expanded entry to its sources again." onClick={() => setBatch(rows.filter((r) => r.linked).map((r) => r.id))}>Replay</button>}
                    <button type="button" className="quiet slim" title="Remove the imported entries from this list and undo what they changed. Time Capture's own entries stay." onClick={() => void window.lawdie.clearImport()}>Clear import</button>
                </span>
            </div>
            {batch && shown.length > 0 ? <LinkStage w={w} rows={shown} onDone={() => setBatch(null)} /> : (
                <>
                    <TypedTable w={w} rows={rows} origin="import" />
                    {open.length > 0 && (
                        <div className="link-cta">
                            <button type="button" className="primary big-button" disabled={busy}
                                title="Match every imported entry to the emails, meetings, transcripts, documents and desktop work behind it, and show the narrative drafted from them."
                                onClick={() => void linkAll()}>{busy ? "Linking…" : "Link sources and draft narratives"}</button>
                            <span className="muted small">Uses Outlook, Calendar and Teams through Microsoft Graph, and what Time Capture saw on this Mac.</span>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

// ---------------------------------------------------------------------------
// Entries added on the Time page

/** The day's simple entries, typed on the Time page, above the captured ones. */
export function TypedEntries({ w, rows }: { w: Workspace; rows: ImportedRow[] }): ReactNode {
    if (!rows.length) return null;
    return (
        <div className="typed-entries">
            <p className="eyebrow">Typed here</p>
            <TypedTable w={w} rows={rows} origin="manual" />
        </div>
    );
}

/** Add entry: a date, the hours, the matter and a short note, on the page above the list. */
export function AddEntryForm({ w, day, onClose }: { w: Workspace; day: string; onClose: () => void }): ReactNode {
    const matters = w.projects.filter((p) => !p.archived);
    const [date, setDate] = useState(day);
    const [hours, setHours] = useState("");
    const [projectID, setProjectID] = useState(matters.find((p) => /61407-002/.test(p.name))?.id ?? matters[0]?.id ?? "");
    const [note, setNote] = useState("");
    const [problem, setProblem] = useState<string | null>(null);
    const save = async (): Promise<void> => {
        const split = splitNote(note);
        if (!(hours.trim() ? note.trim() : split.note)) { setProblem("Type a short note, such as call w/ client."); return; }
        if (!hours.trim() && split.hours == null) { setProblem("Enter the hours, such as .9, 54m or 1.5h."); return; }
        if (await window.lawdie.addTyped({ date, note, hours, projectID: projectID || null })) onClose();
        else setProblem("That entry could not be added. Check the hours and the note.");
    };
    return (
        <form className="add-entry" onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}>
            <label className="field"><span className="eyebrow">Date</span><input type="date" value={date} title="The day of the work." onChange={(e) => setDate(e.target.value)} /></label>
            <label className="field hours"><span className="eyebrow">Hours</span><input value={hours} placeholder=".9" title="Hours as you would type them: .9, 0.9, 54m or 1.5h. Leave it empty if the note starts or ends with them." onChange={(e) => setHours(e.target.value)} /></label>
            <label className="field matter"><span className="eyebrow">Matter</span>
                <select value={projectID} title="The matter this time is for." onChange={(e) => setProjectID(e.target.value)}>
                    {matters.map((p) => <option key={p.id} value={p.id}>{`${p.name.split(" ")[0]} ${p.client.split(" ")[0]}`}</option>)}
                    {!matters.length && <option value="">No matters yet</option>}
                </select>
            </label>
            <label className="field note"><span className="eyebrow">Note</span><input autoFocus value={note} placeholder="call w/ client" title="A short note, as you would type it in iTimeKeep. Lawdie expands it into a narrative from what it matches." onChange={(e) => setNote(e.target.value)} /></label>
            <span className="row gap add-actions">
                <button type="submit" className="primary slim" title="Add this to the day as typed. Expand it to see the narrative.">Save</button>
                <button type="button" className="quiet slim" title="Close without adding anything (Escape)." onClick={onClose}>Cancel</button>
            </span>
            {problem && <p className="danger small add-problem">{problem}</p>}
        </form>
    );
}

// ---------------------------------------------------------------------------
// A table of typed rows: as typed, being linked, expanded

function TypedTable({ w, rows, origin }: { w: Workspace; rows: ImportedRow[]; origin: "import" | "manual" }): ReactNode {
    const anyTyped = rows.some((r) => !r.linked);
    return (
        <div className="typed-table">
            {anyTyped && (origin === "import"
                ? <div className="typed-row head"><span>Date</span><span>Atty</span><span>Matter</span><span className="num">Hrs</span><span>What was typed</span><span /></div>
                : <div className="typed-row manual head"><span>Date</span><span>Matter</span><span className="num">Hrs</span><span>Note</span><span /></div>)}
            {rows.map((r) => <TypedItem key={r.id} w={w} row={r} origin={origin} />)}
        </div>
    );
}

function TypedItem({ w, row, origin }: { w: Workspace; row: ImportedRow; origin: "import" | "manual" }): ReactNode {
    const [linking, setLinking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const expand = async (): Promise<void> => {
        setBusy(true);
        const ok = await window.lawdie.expandTyped(row.id);
        setBusy(false);
        if (ok) setLinking(true);
    };
    if (editing) return <NoteEditForm row={row} origin={origin} onDone={() => setEditing(false)} />;
    if (linking) {
        return row.linked
            ? <div className="typed-expanded"><LinkStage w={w} rows={[row]} onDone={() => setLinking(false)} /></div>
            : <div className="typed-expanded muted small">Linking…</div>;
    }
    if (row.linked) return <Expanded w={w} row={row} origin={origin} onEditNote={() => setEditing(true)} />;
    const cls = "typed-row" + (origin === "manual" ? " manual" : "");
    return (
        <div className={cls}>
            <span>{row.date}</span>
            {origin === "import" && <span>{row.timekeeper || "·"}</span>}
            <span>{matterShort(w, row)}</span>
            <span className="num mono">{hrs(row.hours)}</span>
            <span className="typed-text">“{row.description}”</span>
            <span className="typed-actions">
                <button type="button" className="primary slim" disabled={busy} title="Match this note to the captured work behind it and show the narrative drafted from its sources." onClick={() => void expand()}>{busy ? "Expanding…" : "Expand narrative"}</button>
                <button type="button" className="link-btn" title="Change the note or the hours." onClick={() => setEditing(true)}>Edit</button>
                {origin === "manual" && <button type="button" className="icon" aria-label="Remove this entry" title="Take this typed entry off the day." onClick={() => void window.lawdie.removeTyped(row.id)}>×</button>}
            </span>
        </div>
    );
}

/** Change a typed row's note or hours; it then shows as typed, ready to expand again. */
function NoteEditForm({ row, origin, onDone }: { row: ImportedRow; origin: "import" | "manual"; onDone: () => void }): ReactNode {
    const [note, setNote] = useState(row.description);
    const [hours, setHours] = useState(hrs(row.hours));
    const [problem, setProblem] = useState<string | null>(null);
    const save = async (): Promise<void> => {
        if (!note.trim()) { setProblem("Type a short note."); return; }
        if (await window.lawdie.editTyped(row.id, { description: note, hours })) onDone();
        else setProblem("That could not be saved. Check the hours.");
    };
    return (
        <form className="typed-edit" onSubmit={(e) => { e.preventDefault(); void save(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onDone(); } }}>
            <span className="import-label">{origin === "import" ? "Entered in iTimeKeep" : "Typed here"}</span>
            <input className="hours" value={hours} title="Hours: .9, 0.9, 54m or 1.5h." onChange={(e) => setHours(e.target.value)} />
            <input autoFocus className="note" value={note} title="The note. Name the person or the document so Lawdie can find the work." onChange={(e) => setNote(e.target.value)} />
            <button type="submit" className="primary slim" title="Save the note. Expand it again to see the narrative.">Save</button>
            <button type="button" className="quiet slim" title="Keep the note as it was (Escape)." onClick={onDone}>Cancel</button>
            {problem && <span className="danger tiny">{problem}</span>}
        </form>
    );
}

/** An expanded row: entered against recorded hours, Lawdie's narrative with its Why dropdown, and the choice. */
function Expanded({ w, row, origin, onEditNote }: { w: Workspace; row: ImportedRow; origin: "import" | "manual"; onEditNote: () => void }): ReactNode {
    const entry = entryOf(w, row);
    const [draft, setDraft] = useState<string | null>(null);
    const decide = (d: "use" | "keep" | null): void => void window.lawdie.importDecision(row.id, d);
    const label = origin === "import" ? "Entered in iTimeKeep" : "Typed here";
    const thing = origin === "import" ? "entry" : "note";
    // A note added here and accepted is part of the day: one line, and the entry itself is in the list below.
    if (origin === "manual" && row.decision && entry) {
        return (
            <div className="typed-merged small">
                <span className="typed-text">“{row.description}”</span>
                <span>is now part of the day: {entry.description.length > 90 ? `${entry.description.slice(0, 89).trimEnd()}…` : entry.description} ({recordedHours(entry).toFixed(1)} h, as recorded)</span>
                <button type="button" className="link-btn" title="Take the note back out of the entry and put the entry back as it was." onClick={() => decide(null)}>Undo</button>
            </div>
        );
    }
    const recorded = entry ? recordedHours(entry) : 0;
    const enteredTenths = Math.ceil(row.hours * 10 - 1e-9) / 10;
    const roundsUp = Math.abs(enteredTenths - row.hours) > 1e-9;
    const over = !!entry && enteredTenths - recorded > 0.049;
    const under = !!entry && recorded - enteredTenths > 0.049;
    const same = row.sameAs ? (w.imported ?? []).find((r) => r.id === row.sameAs) : undefined;
    return (
        <div className={"import-row typed-expanded" + (row.decision ? ` decided ${row.decision}` : "")}>
            <div className="import-typed">
                <span className="import-label">{label}</span>
                <span className="import-text">“{row.description}”</span>
                <span className="import-meta">{row.date} · {matterShort(w, row)} · <span className="mono">{hrs(row.hours)} h</span></span>
            </div>
            {entry ? (
                <>
                    <div className={"import-hours" + (over ? " over" : "")} title="Hours typed against the time Time Capture recorded for the same work, both in tenths. The entry bills the recorded time.">
                        Entered {hrs(row.hours)}{roundsUp ? `, which rounds to ${enteredTenths.toFixed(1)}` : ""}; recorded {recorded.toFixed(1)} ({whereTime(entry)}).{over ? " More time was entered than was recorded." : under ? " Less time was entered than was recorded." : " They agree."}
                    </div>
                    <div className="import-lawdie">
                        <span className="import-label">Lawdie drafted</span>
                        <div className="import-narr"><NarrativeEntry entry={entry} w={w} draft={draft} setDraft={setDraft} readOnly onSaved={() => { if (!row.decision) decide("use"); }} /></div>
                    </div>
                    <div className="row gap import-actions">
                        {row.decision ? (
                            <>
                                <span className="small strong">{row.decision === "use" ? "Using Lawdie's narrative for this entry." : "Keeping what you typed as the narrative."}</span>
                                <button type="button" className="link-btn" title="Choose again. The entry goes back to how it was." onClick={() => decide(null)}>Undo</button>
                            </>
                        ) : draft === null && (
                            <>
                                <button type="button" className="primary slim" title={`Make this the day's entry for the work, with Lawdie's narrative. The ${thing} joins the captured entry, so no hours are added twice.`} onClick={() => decide("use")}>Use this narrative</button>
                                <button type="button" className="quiet slim" title={`Keep your ${thing} as the narrative on the captured entry. Its hours stay as Time Capture recorded them.`} onClick={() => decide("keep")}>Keep mine</button>
                                <button type="button" className="link-btn" title="Change Lawdie's narrative here, then use it." onClick={() => setDraft(entry.description)}>Edit</button>
                            </>
                        )}
                    </div>
                </>
            ) : (
                <div className="row gap import-none">
                    <span className="muted small">{same ? `Same work as “${same.description}”, which already holds it.` : `No captured work matches this ${thing}.`}</span>
                    <button type="button" className="link-btn" title={`Change the ${thing} or the hours, then expand it again.`} onClick={onEditNote}>Edit</button>
                    {origin === "manual" && <button type="button" className="link-btn" title="Take this typed entry off the day." onClick={() => void window.lawdie.removeTyped(row.id)}>Remove</button>}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// The link, drawn

type Card = { key: string; kind: "source" | "capture"; icon: ReactNode; label: string; title: string; when: string };
const STEP_MS = 600;
const SETTLE_MS = 1100;

/** The cards a row's entry rests on: its sources, then the desktop stretches Time Capture saw for it. */
function cardsFor(w: Workspace, e: TimeEntry): Card[] {
    const ev = w.evidence ?? {};
    const sources: Card[] = (e.sources ?? []).map((s) => {
        const x = ev[s.id];
        const meeting = x?.kind === "transcript" && x.meeting ? ev[x.meeting] : undefined;
        const when = x?.start && x.end ? timeRange(x.start, x.end) : x?.when ? new Date(x.when).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : meeting?.start && meeting.end ? timeRange(meeting.start, meeting.end) : "";
        const kind = x ? (x.invite_for ? "Teams invite" : rowKind(x)) : "Source";
        return { key: `ev:${s.id}`, kind: "source", icon: <SourceIcon ev={x} />, label: kind, title: x?.subject ?? x?.file ?? meeting?.subject ?? s.label, when };
    });
    const capture: Card[] = (e.work ?? []).map((x, n) => ({
        key: `tc:${e.id}:${n}`, kind: "capture", icon: <AppMark app={x.app} />, label: `Time Capture · ${x.app.replace(/^(Microsoft|Google|Adobe)\s+/, "")}`,
        title: workTitle(x.title), when: `${timeRange(x.startedAt, new Date(Date.parse(x.startedAt) + x.minutes * 60_000).toISOString())} · ${x.minutes}m`,
    }));
    return [...capture, ...sources];
}

function LinkStage({ w, rows, onDone }: { w: Workspace; rows: ImportedRow[]; onDone: () => void }): ReactNode {
    const reduced = useMemo(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches, []);
    // Every card once, beside the first row that reaches it; a later row that rests on it draws its line back up.
    // Keyed on what the rows are, not on the array: callers pass a new array each render, and the lines are measured
    // from these cards, so a new value every render would measure, set state and render again without end.
    const rowsKey = rows.map((r) => `${r.id}:${r.entryID ?? ""}`).join("|");
    const { bands, links } = useMemo(() => {
        const seen = new Set<string>();
        const bands: Card[][] = [];
        const links = rows.map((r, n) => {
            const e = entryOf(w, r);
            const list = e ? cardsFor(w, e) : [];
            bands[n] = list.filter((c) => !seen.has(c.key));
            for (const c of list) seen.add(c.key);
            return list.map((c) => c.key);
        });
        return { bands, links };
    }, [rowsKey, w.entries, w.evidence]);
    const [step, setStep] = useState(reduced ? rows.length : -1);
    const stage = useRef<HTMLDivElement>(null);
    // The row being linked stays in view.
    useEffect(() => {
        if (step < 0 || step >= rows.length) return;
        stage.current?.querySelector(`[data-row="${step}"]`)?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    }, [step]);
    useEffect(() => {
        if (reduced) { const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }
        const timers = rows.map((_, n) => setTimeout(() => setStep(n), 250 + n * STEP_MS));
        timers.push(setTimeout(() => setStep(rows.length), 250 + rows.length * STEP_MS));
        timers.push(setTimeout(onDone, 250 + rows.length * STEP_MS + SETTLE_MS));
        return () => timers.forEach(clearTimeout);
    }, []);
    // Lines from each row's right edge to the left edge of each card it matched, measured after layout.
    const [paths, setPaths] = useState<{ key: string; row: number; d: string }[]>([]);
    const [box, setBox] = useState({ w: 0, h: 0 });
    useLayoutEffect(() => {
        const el = stage.current;
        if (!el) return;
        const measure = (): void => {
            const base = el.getBoundingClientRect();
            const rowEls = [...el.querySelectorAll<HTMLElement>("[data-row]")];
            const cardEls = new Map([...el.querySelectorAll<HTMLElement>("[data-card]")].map((c) => [c.dataset.card!, c.getBoundingClientRect()]));
            const out: { key: string; row: number; d: string }[] = [];
            rowEls.forEach((re, n) => {
                const r = (re.querySelector("[data-anchor]") as HTMLElement ?? re).getBoundingClientRect();
                const x1 = r.right - base.left + 8, y1 = r.top + r.height / 2 - base.top;
                for (const k of links[n] ?? []) {
                    const c = cardEls.get(k);
                    if (!c) continue;
                    const x2 = c.left - base.left - 6, y2 = c.top + c.height / 2 - base.top;
                    const mid = (x1 + x2) / 2;
                    out.push({ key: `${n}:${k}`, row: n, d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` });
                }
            });
            setPaths(out);
            setBox({ w: base.width, h: base.height });
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [step, links]);
    const activeCards = new Set(step >= 0 && step < rows.length ? links[step] : []);
    const doneCards = new Set(links.slice(0, Math.max(0, step)).flat());
    return (
        <div className={"link-stage" + (reduced ? " still" : "")} ref={stage}>
            <p className="link-label">Microsoft Graph: Outlook, Calendar, Teams · Time Capture: desktop</p>
            {rows.map((r, n) => {
                const e = entryOf(w, r);
                const state = n < step || step >= rows.length ? "done" : n === step ? "active" : "waiting";
                return (
                    <div key={r.id} className="link-band">
                        <div data-row={n} className={`link-row ${state}`}>
                            <div className="link-typed" data-anchor="">
                                <span className="mono link-hrs">{hrs(r.hours)}</span>
                                <span className="typed-text">“{r.description}”</span>
                            </div>
                            {state !== "waiting" && (
                                <div className="link-narr">{e ? <><span className="ai-tag">✦ AI</span> {e.description}</> : <span className="muted">No captured work matches this {r.origin === "manual" ? "note" : "entry"}.</span>}</div>
                            )}
                        </div>
                        <div />
                        <div className="link-cards">
                            {(bands[n] ?? []).map((c) => (
                                <div key={c.key} data-card={c.key} className={`link-card ${c.kind}` + (activeCards.has(c.key) ? " active" : doneCards.has(c.key) || step >= rows.length ? " done" : "")} title={`${c.label}: ${c.title}`}>
                                    {c.icon}
                                    <span className="link-card-text"><span className="link-card-kind">{c.label}</span> <span className="link-card-title">{c.title}</span></span>
                                    <span className="link-card-when">{c.when}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
            <svg className="link-lines" width={box.w} height={box.h} aria-hidden="true">
                {paths.map((p) => {
                    const state = p.row < step || step >= rows.length ? "done" : p.row === step ? "active" : "waiting";
                    return state === "waiting" ? null : <path key={p.key} d={p.d} pathLength={1} className={`link-line ${state}`} />;
                })}
            </svg>
        </div>
    );
}
