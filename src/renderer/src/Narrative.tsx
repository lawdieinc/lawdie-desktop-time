import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Evidence, NarrativePart, PrivateStretch, SourceRef, TimeEntry, Workspace } from "@shared/model";
import { evidenceFor } from "@shared/drafter";
import { clock, duration } from "@shared/format";

/* What the attorney typed, the narrative Lawdie drafted, and the sources behind each part
   of it (story.json, seeded by the demo repo's console/timecapture.py --story). Hovering a
   part lights its sources; clicking a part or a source opens "Why this narrative". */

/** Which part or source the pointer is on, or which one the panel opened at. */
export type Focus = { part?: number; source?: string } | null;

const KIND_ICON: Record<string, string> = { email: "✉", meeting: "◷", transcript: "❝", document: "▤" };
/** The drafter's slots, in the words the panel shows. */
const SLOT_NAME: Record<string, string> = { verb: "task", party: "who", participants: "who", object: "what", purpose: "why" };
const KIND_NAME: Record<string, string> ={ email: "Email", meeting: "Meeting", transcript: "Transcript", document: "Document" };

/** What a source is, in a few words: "Outlook email", "Teams meeting", "Calendar", "Teams transcript (sample)", "Document". */
const kindLabel = (ev: Evidence): string =>
    ev.kind === "email" ? "Outlook email" : ev.kind === "meeting" ? (ev.teams ? "Teams meeting" : "Calendar") : ev.kind === "transcript" ? "Teams transcript (sample)" : KIND_NAME[ev.kind] ?? ev.kind;

/** A source's label without its kind ("Outlook email: …" → "…"), for a chip. */
const shortLabel = (s: SourceRef): string => s.label.replace(/^(Outlook email|Teams meeting|Calendar|Document): /, "").replace(/^Teams transcript \(sample\)$/, "Teams transcript");

/** Whether an entry has the narrative-with-sources shape. */
export const hasNarrative = (e: TimeEntry): boolean => e.raw !== undefined || !!e.parts?.length || !!e.status;

const lit = (focus: Focus, parts: readonly NarrativePart[], n: number): boolean =>
    !!focus && (focus.part === n || (!!focus.source && parts[n].evidence.includes(focus.source)));
const chipLit = (focus: Focus, parts: readonly NarrativePart[], id: string): boolean =>
    !!focus && (focus.source === id || (focus.part !== undefined && !!parts[focus.part]?.evidence.includes(id)));

/** "You typed", the narrative in parts, and the source chips: what an entry row shows. */
export function NarrativeLines({ entry, onWhy, tag }: { entry: TimeEntry; onWhy: (f: Focus) => void; tag?: ReactNode }): ReactNode {
    const [focus, setFocus] = useState<Focus>(null);
    const parts = entry.parts ?? [];
    const asParts = parts.length > 0 && !entry.partsEdited;
    const sources = entry.sources ?? [];
    return (
        <>
            <div className="narr-raw tiny" title="What the attorney typed on the time card.">{entry.raw ? <>You typed: <span className="narr-raw-text">{entry.raw}</span></> : "Nothing typed"}</div>
            <div className="small strong narr">
                {asParts ? parts.map((p, n) => (
                    <span key={n} className={"part" + (p.evidence.length ? "" : " uncited") + (lit(focus, parts, n) ? " hot" : "")}
                        role="button" tabIndex={0}
                        title={p.evidence.length ? `From ${p.evidence.length === 1 ? "1 source" : `${p.evidence.length} sources`}. Click to see why.` : "The drafter's wording. Click to see the sources."}
                        onMouseEnter={() => setFocus({ part: n })} onMouseLeave={() => setFocus(null)}
                        onFocus={() => setFocus({ part: n })} onBlur={() => setFocus(null)}
                        onClick={() => onWhy({ part: n })} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onWhy({ part: n }); } }}>{p.text}</span>
                )) : entry.description || <span className="muted narr-empty">No narrative yet</span>}
                {" "}{tag}
                {entry.partsEdited && <span className="edited-tag" title="You edited this narrative. What you typed and the sources are kept.">Edited</span>}
            </div>
            {sources.length > 0 && (
                <div className="source-chips">
                    {sources.map((s) => (
                        <button key={s.id} type="button" className={"source-chip" + (asParts && chipLit(focus, parts, s.id) ? " hot" : "")}
                            title={`${s.label}. Click to see what it says.`}
                            onMouseEnter={() => setFocus({ source: s.id })} onMouseLeave={() => setFocus(null)}
                            onClick={() => onWhy({ source: s.id })}>
                            <span aria-hidden="true">{KIND_ICON[s.kind] ?? "·"}</span> {shortLabel(s)}
                        </button>
                    ))}
                </div>
            )}
        </>
    );
}

/** The suggested or flagged line under an entry, with its actions. */
export function StatusLine({ entry, onEdit }: { entry: TimeEntry; onEdit: () => void }): ReactNode {
    if (entry.status === "suggested") {
        return (
            <div className="status-line suggested">
                <span className="status-badge" title={entry.why ?? "Built from the matter's history. Confirm it before it is billed."}>From matter history, confirm</span>
                {entry.why && <span className="tiny muted grow">{entry.why}</span>}
                <button type="button" className="fix" title="The narrative is right: keep it as a normal entry." onClick={() => void window.lawdie.editEntry(entry.id, { confirm: true })}>Confirm</button>
                <button type="button" className="quiet slim" title="Change the narrative first, then keep it." onClick={onEdit}>Edit</button>
            </div>
        );
    }
    if (entry.status === "flagged") {
        return (
            <div className="status-line flagged">
                <span className="status-badge" title="Lawdie found no matter for this time and did not guess.">Needs you: no matter found</span>
                {entry.why && <span className="tiny grow">{entry.why}</span>}
                <button type="button" className="fix" title="Choose the matter and write the narrative for this time." onClick={onEdit}>Assign and edit</button>
            </div>
        );
    }
    return null;
}

/** A personal stretch, greyed: on this Mac only, never on the bill. */
export function PrivateRow({ item }: { item: PrivateStretch }): ReactNode {
    return (
        <div className="entry private-row" title="Personal time. It is not billed and never leaves this Mac.">
            <span className="bar private" />
            <div className="grow">
                <div className="small">Personal, never leaves this Mac</div>
                <div className="muted tiny">{item.app} · {clock(item.startedAt)} · not billed, not synced</div>
            </div>
            <span className="mono muted">{duration((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000)}</span>
        </div>
    );
}

// ---------------------------------------------------------------------------

const STOP = new Set(["about", "after", "their", "there", "these", "those", "which", "while", "would", "could", "should", "under", "including", "regarding"]);
/** The words of a part that are worth finding in a source: five letters or more, compared by their first five. */
const stems = (texts: string[]): string[] => [...new Set(texts.join(" ").toLowerCase().match(/[a-z0-9]{5,}/g) ?? [])].filter((w) => !STOP.has(w)).map((w) => w.slice(0, 5));
const hits = (line: string, keys: string[]): boolean => { const l = line.toLowerCase(); return keys.some((k) => l.includes(k)); };
const when = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const timeOnly = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

/** "Why this narrative": each part and the sources it rests on, what each source says, and a way to open it. */
export function WhyPanel({ w, entry, focus: initial, onClose }: { w: Workspace; entry: TimeEntry; focus: Focus; onClose: () => void }): ReactNode {
    const [focus, setFocus] = useState<Focus>(initial);
    const [message, setMessage] = useState<string | null>(null);
    const [drafting, setDrafting] = useState(false);
    const evidence = evidenceFor(entry, w.evidence);
    const parts = entry.parts ?? [];
    const asParts = parts.length > 0 && !entry.partsEdited;
    const focusIDs = new Set(focus?.source ? [focus.source] : focus?.part !== undefined ? parts[focus.part]?.evidence ?? [] : []);
    const listRef = useRef<HTMLDivElement>(null);
    // Only the source list scrolls to the focused source; the panel's heading and parts stay in view.
    useEffect(() => {
        const list = listRef.current;
        const first = list?.querySelector<HTMLElement>(".src-card.focus");
        if (list && first) list.scrollTo({ top: first.offsetTop - list.offsetTop - 24, behavior: "smooth" });
    }, [focus]);
    useEffect(() => {
        const key = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [onClose]);
    /** The parts that rest on a source: its own id, or (a transcript) its meeting's. */
    const partsCiting = (ev: Evidence): NarrativePart[] => parts.filter((p) => p.evidence.includes(ev.id) || (!!ev.meeting && p.evidence.includes(ev.meeting)));
    const open = async (ev: Evidence): Promise<void> => { setMessage(await window.lawdie.openSource(ev.id)); };
    const redraft = async (): Promise<void> => {
        setDrafting(true);
        const r = await window.lawdie.draftNarrative(entry.id);
        setDrafting(false);
        setMessage(r.message);
    };
    const drafter = entry.drafter === "model" ? "model (Kiwi)" : "rules (demo)";
    // On the body: a panel's backdrop filter would otherwise hold this fixed layer inside the panel.
    return createPortal(
        <div className="why-scrim" onClick={onClose}>
            <aside className="why-panel" onClick={(e) => e.stopPropagation()} aria-label="Why this narrative">
                <div className="row between">
                    <div className="heading"><p className="eyebrow">{clock(entry.startedAt)} · {duration((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000)}</p><h2 className="display">Why this narrative</h2></div>
                    <button type="button" className="icon" aria-label="Close" title="Close this panel (Esc)." onClick={onClose}>×</button>
                </div>
                <div className="why-typed">
                    <p className="eyebrow">You typed</p>
                    <p className="small">{entry.raw ? `“${entry.raw}”` : "Nothing"}</p>
                </div>
                <div className="why-parts">
                    <p className="eyebrow">Lawdie drafted</p>
                    {asParts ? parts.map((p, n) => (
                        <button key={n} type="button" className={"why-part" + (focus?.part === n || (focus?.source && p.evidence.includes(focus.source)) ? " hot" : "")}
                            title={p.evidence.length ? "Show the sources for this part." : "No source: the drafter's own wording."} onClick={() => setFocus({ part: n })}>
                            {p.slot && <span className="slot">{SLOT_NAME[p.slot] ?? p.slot}</span>}
                            <span className="why-part-text">{p.text.trim()}</span>
                            <span className="tiny muted">{p.evidence.length ? p.evidence.map((id) => (w.evidence?.[id] ? kindLabel(w.evidence[id]) : id)).join(", ") : "no source"}</span>
                        </button>
                    )) : <p className="small">{entry.description || "No narrative yet."}{entry.partsEdited ? " (edited by you)" : ""}</p>}
                </div>
                {entry.why && <p className={"small why-note " + (entry.status ?? "")}>{entry.why}</p>}
                <div className="why-sources" ref={listRef}>
                    <p className="eyebrow">Sources</p>
                    {evidence.length === 0 && <p className="muted small">No sources were captured for this time.</p>}
                    {evidence.map((ev) => {
                        const keys = stems(partsCiting(ev).map((p) => p.text));
                        const meeting = ev.meeting ? w.evidence?.[ev.meeting] : undefined;
                        return (
                            <section key={ev.id} className={"src-card" + (focusIDs.has(ev.id) || (!!ev.meeting && focusIDs.has(ev.meeting)) ? " focus" : "")} title="Click to light the parts that rest on this source." onClick={() => setFocus({ source: ev.id })}>
                                <div className="row between">
                                    <span className="src-kind"><span aria-hidden="true">{KIND_ICON[ev.kind] ?? "·"}</span> {kindLabel(ev)}</span>
                                    <OpenButton ev={ev} onOpen={() => void open(ev)} />
                                </div>
                                {ev.kind === "email" && (
                                    <>
                                        <div className="small strong">{ev.subject}</div>
                                        <div className="tiny muted">From {ev.from} to {(ev.to ?? []).join(", ")}{ev.cc?.length ? `, cc ${ev.cc.join(", ")}` : ""} · {when(ev.when)}</div>
                                        <div className="src-body">{(ev.body ?? "").split("\n").map((line, n) => <div key={n} className={"body-line" + (line.trim() && hits(line, keys) ? " hit" : "")}>{line || " "}</div>)}</div>
                                    </>
                                )}
                                {ev.kind === "meeting" && (
                                    <>
                                        <div className="small strong">{ev.subject}</div>
                                        <div className="tiny muted">{when(ev.start)} to {timeOnly(ev.end)}{ev.location ? ` · ${ev.location}` : ""}</div>
                                        <div className="tiny">With {(ev.attendees ?? []).join(", ")}</div>
                                        {ev.body && <div className="tiny muted">{ev.body}</div>}
                                        {!ev.transcript && <div className="tiny muted">No recording or transcript.</div>}
                                    </>
                                )}
                                {ev.kind === "transcript" && (
                                    <>
                                        {meeting && <div className="tiny muted">{meeting.subject}</div>}
                                        <div className="tx-lines">{(ev.lines ?? []).map((l, n) => (
                                            <div key={n} className={"tx-line" + (hits(l.text, keys) ? " hit" : "")}><span className="mono tiny muted">{l.t.slice(0, 5)}</span><span className="tiny strong">{l.who}</span><span className="small">{l.text}</span></div>
                                        ))}</div>
                                    </>
                                )}
                                {ev.kind === "document" && (
                                    <>
                                        <div className="small strong">{ev.file}</div>
                                        <div className="tiny muted">{ev.title}</div>
                                        {ev.facts?.length ? <ul className="src-facts">{ev.facts.map((f) => <li key={f} className={hits(f, keys) ? "hit" : ""}>{f}</li>)}</ul> : null}
                                    </>
                                )}
                            </section>
                        );
                    })}
                </div>
                {message && <p className="small danger">{message}</p>}
                <div className="why-foot row between">
                    <span className="tiny muted">Drafted by: {drafter}.{entry.drafter === "model" ? "" : " Swap for a model in Settings."}</span>
                    {parts.length > 0 && <button type="button" className="quiet slim" disabled={drafting} title={w.preferences.narrativeDrafter === "model" ? "Ask the model to write this narrative again from the same sources. Your edits are replaced." : "Put back the narrative as drafted from the sources. Your edits are replaced."} onClick={() => void redraft()}>{drafting ? "Drafting…" : "Draft again"}</button>}
                </div>
            </aside>
        </div>,
        document.body,
    );
}

/** Open a source where it lives: Outlook on the web, or the file on this Mac. A transcript shows its lines above. */
function OpenButton({ ev, onOpen }: { ev: Evidence; onOpen: () => void }): ReactNode {
    if (ev.kind === "transcript") return <span className="tiny muted" title="The transcript lines are shown here.">Lines below</span>;
    const where = ev.link ? (ev.kind === "document" ? "Open" : "Open in Outlook") : ev.path ? "Open file" : null;
    const tip = ev.link ? "Open this in Outlook on the web." : ev.path ? `Open ${ev.file ?? "this file"} on this Mac.` : ev.kind === "document" ? "No file path yet. It is added when the matter folder is written." : "No Outlook link yet. It is added when the mailbox is seeded.";
    return <button type="button" className="quiet slim" disabled={!where} title={tip} onClick={(e) => { e.stopPropagation(); onOpen(); }}>{where ?? "Open"}</button>;
}
