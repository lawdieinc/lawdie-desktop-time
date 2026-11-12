import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Evidence, NarrativePart, PrivateStretch, TimeEntry, Workspace } from "@shared/model";
import { clock, duration, timeBlock } from "@shared/format";

/* A time entry's narrative as Lawdie drafted it, edited in place, and one dropdown, "Why
   this entry", with the work Time Capture saw (each stretch, the sum, the rounding), why it
   is on its matter, the reasons, and the sources with their links. Hovering a source lights
   the parts of the narrative it supports, and the other way round. Data comes from
   story.json, seeded by the demo repo's console/timecapture.py --story. */

/** Which part or source the pointer is on. */
export type Focus = { part?: number; source?: string } | null;

/** A small coloured badge for a source: Outlook blue for email and calendar, Teams purple for a Teams meeting or
    transcript, and a document in its own app's colour (Word, Excel, PDF). */
export function SourceIcon({ ev }: { ev?: Evidence }): ReactNode {
    const ext = (ev?.file ?? "").split(".").pop()?.toLowerCase();
    const kind = ev?.kind === "meeting" ? (ev.teams ? "teams" : "calendar") : ev?.kind === "document" ? (ext === "xlsx" ? "excel" : ext === "pdf" ? "pdf" : "word") : ev?.kind ?? "other";
    const color: Record<string, string> = { email: "#0F6CBD", calendar: "#0F6CBD", teams: "#5B5FC7", transcript: "#5B5FC7", word: "#185ABD", excel: "#107C41", pdf: "#C4302B", other: "#8A8178" };
    const path: Record<string, ReactNode> = {
        email: <path d="M3 5.5h10v6.5H3z M3 5.8l5 3.7 5-3.7" fill="none" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />,
        calendar: <><rect x="3.2" y="4.2" width="9.6" height="8.6" rx="1" fill="none" stroke="#fff" strokeWidth="1.2" /><path d="M3.2 7h9.6 M6 3v2.4 M10 3v2.4" stroke="#fff" strokeWidth="1.2" /></>,
        teams: <><rect x="2.8" y="5" width="7" height="6" rx="1.2" fill="#fff" /><path d="M10.2 7.2l3-1.6v4.8l-3-1.6z" fill="#fff" /></>,
        transcript: <path d="M4 5h8 M4 7.5h8 M4 10h5" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />,
        word: <text x="8" y="11.2" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff" fontFamily="Inter, sans-serif">W</text>,
        excel: <text x="8" y="11.2" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff" fontFamily="Inter, sans-serif">X</text>,
        pdf: <text x="8" y="10.6" textAnchor="middle" fontSize="5.2" fontWeight="700" fill="#fff" fontFamily="Inter, sans-serif">PDF</text>,
        other: <circle cx="8" cy="8" r="1.6" fill="#fff" />,
    };
    return (
        <svg className="source-icon" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
            <rect width="16" height="16" rx="3.5" fill={color[kind] ?? color.other} />
            {path[kind] ?? path.other}
        </svg>
    );
}
const KIND_NAME: Record<string, string> = { email: "Email", meeting: "Meeting", transcript: "Transcript", document: "Document", page: "Web page", window: "App window", chat: "Chat" };
/** What a source is, short: Email, Teams meeting, Calendar, Transcript, Document. */
export const rowKind = (ev: Evidence): string => (ev.kind === "meeting" ? (ev.teams ? "Teams meeting" : "Calendar") : KIND_NAME[ev.kind] ?? ev.kind);

/** Whether an entry has drafted parts, work or reasons to explain. */
export const hasNarrative = (e: TimeEntry): boolean => !!e.parts?.length || !!e.work?.length || !!e.reasons?.length || !!e.status;

const lit = (focus: Focus, parts: readonly NarrativePart[], n: number): boolean => !!focus && (focus.part === n || (!!focus.source && parts[n].evidence.includes(focus.source)));
const rowLit = (focus: Focus, parts: readonly NarrativePart[], id: string): boolean => !!focus && (focus.source === id || (focus.part !== undefined && !!parts[focus.part]?.evidence.includes(id)));

// ---------------------------------------------------------------------------

/** A small mark for the app, since the app keeps no app icons: its initial on a tint. */
const APP_MARKS: [RegExp, string, string][] = [
    [/teams/i, "T", "#5b5fc7"], [/outlook/i, "O", "#0f6cbd"], [/word/i, "W", "#185abd"], [/excel/i, "X", "#107c41"],
    [/powerpoint/i, "P", "#c43e1c"], [/acrobat|pdf|preview/i, "A", "#b30b00"], [/chrome|safari|edge|firefox/i, "◍", "#5f6368"], [/phone|facetime/i, "☏", "#5e8b5a"],
];
export function AppMark({ app }: { app: string }): ReactNode {
    const [, mark, color] = APP_MARKS.find(([re]) => re.test(app)) ?? [/./, app.trim()[0]?.toUpperCase() ?? "·", "#7c7366"];
    return <span className="app-mark" style={{ color, background: `${color}1f` }} aria-hidden="true">{mark}</span>;
}

const hm = (t: number): string => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** "9:15 to 9:51 AM", or "11:48 AM to 12:30 PM" across noon. */
export function timeRange(startIso: string, endIso: string): string {
    const a = hm(Date.parse(startIso)), b = hm(Date.parse(endIso));
    return a.slice(-2) === b.slice(-2) && /[AP]M/i.test(a) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}
/** A window title without the app's own name on the end: "Kickoff | Microsoft Teams" → "Kickoff". */
export const workTitle = (title: string): string =>
    title.replace(/\s+[|\-–]\s+(Microsoft Teams|Outlook|Microsoft Outlook|Word|Microsoft Word|Excel|Microsoft Excel|Kiwi|Google Chrome|Adobe Acrobat[^|]*)$/i, "").trim();
const appShort = (app: string): string => app.replace(/^(Microsoft|Google|Adobe)\s+/, "");
/** "52m in Chrome, 48m in Word": where an entry's time went. */
export const whereTime = (e: TimeEntry): string => (e.work ?? []).map((x) => (/phone/i.test(x.app) ? `${duration(Math.round(x.minutes * 60))} on the calendar` : `${duration(Math.round(x.minutes * 60))} in ${appShort(x.app)}`)).join(", ");

// ---------------------------------------------------------------------------

/** Entries whose dropdown is open, kept while the app runs. */
const OPEN = new Set<string>();

/** What a suggested entry's AI tag and its Confirm button say. */
export const SUGGESTED_TIP = "Lawdie drafted this from matter history. Confirm puts it on the bill.";

/** What a flagged entry's Assign button says: why it waits, and what the button does. */
export const flaggedTip = (entry: TimeEntry): string =>
    entry.projectID && /^Sent back by/.test(entry.why ?? "")
        ? `${entry.why!.trim().replace(/\.?$/, ".")} Fix the entry, then confirm it to put it on the next invoice.`
        : `Needs you: no matter found.${entry.why ? ` ${entry.why.trim().replace(/\.?$/, ".")}` : ""} Choose the matter and write the narrative for this time.`;

/** The ✦ AI tag's words: who drafted the narrative, and what is still to do (a status, kept off the page). */
function aiTip(entry: TimeEntry): string {
    if (entry.status === "suggested") return SUGGESTED_TIP;
    if (entry.status === "flagged") return flaggedTip(entry);
    return entry.partsEdited ? "Drafted by Lawdie from the sources below. You edited it, and its sources are kept." : "Drafted by Lawdie from the sources below. Edit it if anything is off.";
}

/**
 * The narrative line (parts and the ✦ AI tag, whose tooltip carries the entry's status), the inline
 * editor when `draft` is set, `meta`, the rules' changes (`after`) and the Why dropdown.
 */
export function NarrativeEntry({ entry, w, draft, setDraft, onDetails, meta, readOnly = false, onSaved, override, after }: {
    entry: TimeEntry; w: Workspace; draft: string | null; setDraft: (d: string | null) => void;
    onDetails?: () => void; meta?: ReactNode; readOnly?: boolean;
    /** After the narrative is saved from the editor (an expanded typed row uses it to accept the edited narrative). */
    onSaved?: () => void;
    /** The narrative as a client's rules write it (codes and task times added, marked as inserted), shown instead. */
    override?: ReactNode;
    /** Shown under the matter line, before the Why dropdown: the changes a client's rules made. */
    after?: ReactNode;
}): ReactNode {
    const [focus, setFocus] = useState<Focus>(null);
    const [open, setOpen] = useState(OPEN.has(entry.id));
    const [problem, setProblem] = useState<string | null>(null);
    const parts = entry.parts ?? [];
    const asParts = parts.length > 0 && !entry.partsEdited;
    const toggle = (): void => { const next = !open; setOpen(next); if (next) OPEN.add(entry.id); else OPEN.delete(entry.id); };
    const litCount = asParts ? (entry.sources ?? []).filter((s) => rowLit(focus, parts, s.id)).length : 0;
    const save = async (): Promise<void> => {
        if (draft === null) return;
        if (!draft.trim()) { setProblem("Add a narrative."); return; }
        if (draft.trim() === entry.description) { setDraft(null); onSaved?.(); return; }
        if (await window.lawdie.editEntry(entry.id, { description: draft })) { setDraft(null); setProblem(null); onSaved?.(); } else setProblem("That could not be saved.");
    };
    return (
        <>
            {draft !== null ? (
                <div className="narr-edit">
                    <textarea autoFocus value={draft} rows={2} title="The narrative the client sees. Enter saves, Escape cancels."
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setDraft(null); } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); } }} />
                    <div className="row gap">
                        <button type="button" className="primary slim" title="Save this narrative (Enter). Its sources stay with the entry." onClick={() => void save()}>Save</button>
                        <button type="button" className="quiet slim" title="Keep the narrative as it was (Escape)." onClick={() => setDraft(null)}>Cancel</button>
                        {onDetails && <button type="button" className="link-btn" title="Change hours, task and activity codes, rate or billable." onClick={onDetails}>Hours, codes and rate</button>}
                        {problem && <span className="danger tiny">{problem}</span>}
                    </div>
                </div>
            ) : (
                <div className="small strong narr">
                    {override ?? (asParts ? parts.map((p, n) => (
                        <span key={n} className={"part" + (lit(focus, parts, n) ? " hot" : "")}
                            title={p.evidence.length ? `From ${p.evidence.length === 1 ? "1 source" : `${p.evidence.length} sources`}. Click to see them.` : "Lawdie's wording."}
                            onMouseEnter={() => setFocus({ part: n })} onMouseLeave={() => setFocus(null)}
                            onClick={() => { if (!open) toggle(); }}>{p.text}</span>
                    )) : entry.description || <span className="muted narr-empty">No narrative yet</span>)}
                    {" "}
                    <span className="narr-tags">
                        {entry.drafted && <span className="ai-tag" title={aiTip(entry)}>✦ AI</span>}
                        {entry.billable === false && <span className="quiet-tag" title="Kept with the day's time. It is not billed to the client.">Not billable</span>}
                    </span>
                </div>
            )}
            {meta}
            {after}
            {hasNarrative(entry) && (
                <div className="why">
                    <button type="button" className={"why-toggle" + (open ? " open" : "") + (litCount ? " hot" : "")} aria-expanded={open}
                        title={open ? "Hide why this entry says what it says." : "Show the work Time Capture saw, why the narrative says what it says, and its sources."} onClick={toggle}>
                        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true"><path d="M2.5 1 L7 4.5 L2.5 8 Z" fill="currentColor" /></svg>
                        Why this entry
                        {!open && litCount > 0 && <span className="why-lit">{litCount} {litCount === 1 ? "source" : "sources"} for this part</span>}
                    </button>
                    {open && <WhyBody entry={entry} w={w} focus={focus} setFocus={setFocus} parts={parts} asParts={asParts} />}
                </div>
            )}
        </>
    );
}

/** Inside the dropdown: work done with its sum and rounding, the matter, the reasons, the sources, who drafted it. */
function WhyBody({ entry, w, focus, setFocus, parts, asParts }: { entry: TimeEntry; w: Workspace; focus: Focus; setFocus: (f: Focus) => void; parts: NarrativePart[]; asParts: boolean }): ReactNode {
    const [message, setMessage] = useState<string | null>(null);
    const [drafting, setDrafting] = useState(false);
    const work = entry.work ?? [];
    // Sources that are not a work stretch (a seed's emails, meetings and transcripts); the rest show on their work row.
    const others = (entry.sources ?? []).filter((s) => !work.some((x) => x.sourceID === s.id));
    const total = work.reduce((n, x) => n + x.minutes, 0);
    const hours = entry.hours;
    const sum = work.length > 1 ? `${work.map((x) => `${duration(Math.round(x.minutes * 60))}`).join(" + ")} = ${duration(Math.round(total * 60))}` : work.length ? `${duration(Math.round(total * 60))}` : "";
    const redraft = async (): Promise<void> => { setDrafting(true); const r = await window.lawdie.draftNarrative(entry.id); setDrafting(false); setMessage(r.message); };
    return (
        <div className="why-body">
            {work.length > 0 && (
                <section className="why-section">
                    <p className="why-head">Work done</p>
                    {work.map((x, n) => {
                        const end = new Date(Date.parse(x.startedAt) + x.minutes * 60_000).toISOString();
                        // A stretch capture made is its own source: its link and its hover sit on this row, not on a second list.
                        const ev = x.sourceID ? w.evidence?.[x.sourceID] : undefined;
                        const hot = !!x.sourceID && asParts && rowLit(focus, parts, x.sourceID);
                        return (
                            <div key={n} className={"work-row" + (x.sourceID ? " is-source" : "") + (hot ? " hot" : "")} title={x.url ? `${x.app}: ${x.url}` : `What Time Capture saw in ${x.app}.`}
                                onMouseEnter={() => x.sourceID && setFocus({ source: x.sourceID })} onMouseLeave={() => x.sourceID && setFocus(null)}>
                                <AppMark app={x.app} />
                                <span className="work-what" title={x.summary ? `${x.app} · ${x.title}: ${x.summary}` : undefined}><span className="strong">{x.app}</span> · {workTitle(x.title)}{x.summary && <span className="muted"> · {x.summary}</span>}</span>
                                <span className="work-when">{timeRange(x.startedAt, end)}</span>
                                <span className="work-min mono">{duration(Math.round(x.minutes * 60))}</span>
                                {ev && (ev.path || ev.link) && (
                                    <span className="source-links work-links">
                                        {ev.path && <button type="button" className="link-btn" title={`Open ${ev.file ?? "this file"} on this Mac.`} onClick={() => void window.lawdie.openSource(ev.id, "path")}>Open file</button>}
                                        {ev.link && <button type="button" className="link-btn" title={`Open ${ev.link} in the browser.`} onClick={() => void window.lawdie.openSource(ev.id, "link")}>Open page</button>}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </section>
            )}
            {(entry.reasons?.length || entry.why) && (
                <section className="why-section">
                    <p className="why-head">Why the narrative says this</p>
                    <ul className="why-reasons">
                        {(entry.reasons ?? []).map((r, n) => <li key={n}>{r}</li>)}
                        {entry.why && !(entry.reasons ?? []).includes(entry.why) && <li className={entry.status === "flagged" ? "danger" : ""}>{entry.why}</li>}
                    </ul>
                </section>
            )}
            {others.length > 0 && (
                <section className="why-section">
                    <p className="why-head">Sources</p>
                    <div className="source-rows">
                        {others.map((s) => <SourceRow key={s.id} id={s.id} label={s.label} w={w} lit={asParts && rowLit(focus, parts, s.id)} onHover={(on) => setFocus(on ? { source: s.id } : null)} />)}
                    </div>
                </section>
            )}
            {parts.length > 0 && (
                <div className="why-foot">
                    <span className="tiny muted" title={entry.drafter === "model" ? "Kiwi's model wrote this narrative from the sources." : entry.drafter === "rules" ? "The rules wrote this narrative. Pick Model under Narrative drafter in Settings to use Kiwi's model." : entry.drafted === "capture" ? "Written from what capture saw: the window titles and document names." : entry.drafted ? "Kiwi's AI drafted this from the window titles and document details when the time was reviewed." : "You wrote this when you kept the time."}>{entry.drafter === "model" ? "Drafted by: model (Kiwi)." : entry.drafter === "rules" ? "Drafted by: rules (demo)." : entry.drafted === "capture" ? "Written from capture." : entry.drafted ? "Drafted by Kiwi's AI at review." : "Written by you."}</span>
                    <button type="button" className="link-btn" disabled={drafting} title={w.preferences.narrativeDrafter === "model" ? "Ask the model to write this narrative again from the same sources. Your edits are replaced." : "Put back the narrative as drafted from the sources. Your edits are replaced."} onClick={() => void redraft()}>{drafting ? "Drafting…" : "Draft again"}</button>
                    {message && <span className="danger tiny">{message}</span>}
                </div>
            )}
        </div>
    );
}

/** When a source happened: an email's time, a meeting's span (a transcript takes its meeting's). */
function sourceTime(ev: Evidence, all: Record<string, Evidence> | undefined): string {
    const m = ev.kind === "transcript" && ev.meeting ? all?.[ev.meeting] : ev;
    if (m?.start && m.end) return `${new Date(m.start).toLocaleDateString([], { month: "short", day: "numeric" })}, ${timeRange(m.start, m.end)}`;
    if (ev.when) return new Date(ev.when).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return "";
}

/** One source: kind, title, time, and the links it has. */
function SourceRow({ id, label, w, lit: on, onHover }: { id: string; label: string; w: Workspace; lit: boolean; onHover: (on: boolean) => void }): ReactNode {
    const ev = w.evidence?.[id];
    const [lines, setLines] = useState(false);
    const [shot, setShot] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const meeting = ev?.kind === "transcript" && ev.meeting ? w.evidence?.[ev.meeting] : undefined;
    const title = !ev ? label : ev.kind === "email" || ev.kind === "meeting" ? ev.subject ?? label : ev.kind === "transcript" ? meeting?.subject ?? "Teams transcript" : ev.file ?? label;
    const open = async (what: "link" | "path" | "screenshot"): Promise<void> => setProblem(await window.lawdie.openSource(id, what));
    const viewShot = async (): Promise<void> => { const data = await window.lawdie.screenshotData(id); if (data) setShot(data); else void open("screenshot"); };
    return (
        <div className={"source-row" + (on ? " hot" : "")} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
            <span className="source-kind"><SourceIcon ev={ev} /> {ev ? (ev.invite_for ? "Teams invite" : rowKind(ev)) : "Source"}</span>
            <span className="source-title" title={title}>{title}</span>
            <span className="source-time">{ev ? sourceTime(ev, w.evidence) : ""}</span>
            <span className="source-links">
                {ev?.link && (ev.kind === "page" ? <button type="button" className="link-btn" title={`Open ${ev.link} in the browser.`} onClick={() => void open("link")}>Open page</button> : <button type="button" className="link-btn" title="Open this in Outlook on the web." onClick={() => void open("link")}>Open in Outlook</button>)}
                {ev?.screenshot && <button type="button" className="link-btn" title="See a picture of this source as it looked." onClick={() => void viewShot()}>Screenshot</button>}
                {ev?.path && <button type="button" className="link-btn" title={`Open ${ev.file ?? "this file"} on this Mac.`} onClick={() => void open("path")}>Open file</button>}
                {ev?.kind === "transcript" && <button type="button" className="link-btn" aria-expanded={lines} title={lines ? "Hide the transcript lines." : "Show the transcript lines here."} onClick={() => setLines(!lines)}>{lines ? "Hide transcript" : "Show transcript"}</button>}
                {ev && !ev.link && !ev.screenshot && !ev.path && (ev.kind === "email" || ev.kind === "meeting" || ev.kind === "document") && <span className="tiny muted" title={ev.kind === "document" ? "Capture did not see where the file is saved. Switch on Office document details in Settings." : ev.kind === "email" ? "Capture saw this message's subject and sender; opening it in Outlook is not built yet." : "Nothing to open for this source."}>No link</span>}
            </span>
            {problem && <div className="danger tiny source-wide">{problem}</div>}
            {lines && ev?.lines && (
                <div className="tx-lines source-wide">{ev.lines.map((l, n) => (
                    <div key={n} className="tx-line"><span className="mono tiny muted">{l.t.slice(0, 5)}</span><span className="tiny strong">{l.who}</span><span className="small">{l.text}</span></div>
                ))}</div>
            )}
            {shot && <ImageViewer src={shot} caption={title} onOpen={() => void open("screenshot")} onClose={() => setShot(null)} />}
        </div>
    );
}

/** A screenshot over the window; Escape or a click outside closes it. */
export function ImageViewer({ src, caption, onOpen, onClose }: { src: string; caption: string; onOpen: () => void; onClose: () => void }): ReactNode {
    useEffect(() => {
        const key = (e: KeyboardEvent): void => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
        window.addEventListener("keydown", key, true);
        return () => window.removeEventListener("keydown", key, true);
    }, [onClose]);
    return createPortal(
        <div className="viewer-scrim" onClick={onClose}>
            <figure className="viewer" onClick={(e) => e.stopPropagation()}>
                <div className="row between viewer-bar">
                    <figcaption className="small strong">{caption}</figcaption>
                    <span className="row gap">
                        <button type="button" className="quiet slim" title="Open the picture in Preview." onClick={onOpen}>Open in Preview</button>
                        <button type="button" className="icon" aria-label="Close" title="Close (Escape)." onClick={onClose}>×</button>
                    </span>
                </div>
                <img src={src} alt={caption} />
            </figure>
        </div>,
        document.body,
    );
}

/** A personal stretch, greyed: on this Mac only, never on the bill. */
export function PrivateRow({ item }: { item: PrivateStretch }): ReactNode {
    return (
        <div className="entry private-row">
            <span className="bar private" />
            <div className="grow">
                <div className="small" title="Personal time. It is not billed and never leaves this Mac.">Personal</div>
            </div>
            <span className="mono muted" title={timeBlock(item)}>{duration((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000)}</span>
        </div>
    );
}
