import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ImportedRow, TimeEntry, Workspace } from "@shared/model";
import { recordedHours } from "@shared/importMatch";
import { AppMark, NarrativeEntry, SourceIcon, rowKind, timeRange, whereTime, workTitle } from "./Narrative";

/* Entries the attorney typed into iTimeKeep, imported as typed, then linked to what Microsoft
   Graph (Outlook, Calendar, Teams) and Time Capture hold for the same work. The link is shown
   as it happens: each typed row draws lines to the emails, meetings, transcripts, documents
   and desktop stretches it matched, and its drafted narrative appears under it. Then the
   rows settle into the list: entered against recorded hours, Lawdie's narrative with its Why
   dropdown, and the choice between the two. */

/** Hours as typed: "0.9", "0.25". */
const hrs = (n: number): string => (Math.round(n * 100) % 10 ? n.toFixed(2) : n.toFixed(1));
/** Rows whose link animation already ran this session; a reload shows the list. */
let PLAYED = false;

export function ImportedPanel({ w }: { w: Workspace }): ReactNode {
    const rows = w.imported ?? [];
    const linked = rows.length > 0 && rows.every((r) => r.linked);
    const [phase, setPhase] = useState<"typed" | "linking" | "list">(linked ? "list" : "typed");
    const [busy, setBusy] = useState(false);
    useEffect(() => { if (!linked) setPhase("typed"); }, [linked]);
    const matched = rows.filter((r) => r.entryID && w.entries.some((e) => e.id === r.entryID)).length;
    const link = async (): Promise<void> => {
        setBusy(true);
        const ok = await window.lawdie.linkImport();
        setBusy(false);
        if (ok) setPhase("linking");
    };
    return (
        <section className="panel">
            <div className="row between">
                <span className="row gap"><strong>Entered in iTimeKeep</strong><span className="muted small">{rows.length} {rows.length === 1 ? "entry" : "entries"}{linked ? ` · ${matched} matched to captured work` : " · as typed"}</span></span>
                <span className="row gap">
                    {phase === "list" && <button type="button" className="link-btn" title="Show Lawdie linking each typed entry to its sources again." onClick={() => setPhase("linking")}>Replay</button>}
                    <button type="button" className="quiet slim" title="Remove the imported entries from this list. Time Capture's own entries stay." onClick={() => void window.lawdie.clearImport()}>Clear import</button>
                </span>
            </div>
            {phase === "typed" && (
                <>
                    <div className="typed-table">
                        <div className="typed-row head"><span>Date</span><span>Atty</span><span>Matter</span><span className="num">Hrs</span><span>What was typed</span></div>
                        {rows.map((r) => (
                            <div key={r.id} className="typed-row">
                                <span>{r.date}</span><span>{r.timekeeper || "·"}</span><span>{r.matter || "·"}</span><span className="num mono">{hrs(r.hours)}</span><span className="typed-text">“{r.description}”</span>
                            </div>
                        ))}
                    </div>
                    <div className="link-cta">
                        <button type="button" className="primary big-button" disabled={busy}
                            title="Match each typed entry to the emails, meetings, transcripts, documents and desktop work behind it, and draft its narrative from them."
                            onClick={() => void link()}>{busy ? "Linking…" : "Link sources and draft narratives"}</button>
                        <span className="muted small">Uses Outlook, Calendar and Teams through Microsoft Graph, and what Time Capture saw on this Mac.</span>
                    </div>
                </>
            )}
            {phase === "linking" && linked && <LinkStage w={w} rows={rows} onDone={() => { PLAYED = true; setPhase("list"); }} />}
            {phase === "list" && rows.map((r) => <ImportRow key={r.id} row={r} w={w} />)}
        </section>
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
        const kind = x ? (x.kind === "email" && /invite/i.test(s.label) ? "Teams invite" : rowKind(x)) : "Source";
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
    const entryOf = (r: ImportedRow): TimeEntry | undefined => (r.entryID ? w.entries.find((e) => e.id === r.entryID) : undefined);
    // Every card once, beside the first row that reaches it; a later row that rests on it draws its line back up.
    const { bands, links } = useMemo(() => {
        const seen = new Set<string>();
        const bands: Card[][] = [];
        const links = rows.map((r, n) => {
            const e = entryOf(r);
            const list = e ? cardsFor(w, e) : [];
            bands[n] = list.filter((c) => !seen.has(c.key));
            for (const c of list) seen.add(c.key);
            return list.map((c) => c.key);
        });
        return { bands, links };
    }, [rows, w]);
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
                const e = entryOf(r);
                const state = n < step || step >= rows.length ? "done" : n === step ? "active" : "waiting";
                return (
                    <div key={r.id} className="link-band">
                        <div data-row={n} className={`link-row ${state}`}>
                            <div className="link-typed" data-anchor="">
                                <span className="mono link-hrs">{hrs(r.hours)}</span>
                                <span className="typed-text">“{r.description}”</span>
                            </div>
                            {state !== "waiting" && (
                                <div className="link-narr">{e ? <><span className="ai-tag">✦ AI</span> {e.description}</> : <span className="muted">No captured work matches this entry.</span>}</div>
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

// ---------------------------------------------------------------------------

function ImportRow({ row, w }: { row: ImportedRow; w: Workspace }): ReactNode {
    const entry = row.entryID ? w.entries.find((e) => e.id === row.entryID) : undefined;
    const [draft, setDraft] = useState<string | null>(null);
    const recorded = entry ? recordedHours(entry) : 0;
    const enteredTenths = Math.ceil(row.hours * 10 - 1e-9) / 10;
    const roundsUp = Math.abs(enteredTenths - row.hours) > 1e-9;
    const over = !!entry && enteredTenths - recorded > 0.049;
    const under = !!entry && recorded - enteredTenths > 0.049;
    const decide = (d: "use" | "keep" | null): void => void window.lawdie.importDecision(row.id, d);
    return (
        <div className={"import-row" + (row.decision ? ` decided ${row.decision}` : "")}>
            <div className="import-typed">
                <span className="import-label">Entered in iTimeKeep</span>
                <span className="import-text">“{row.description}”</span>
                <span className="import-meta">{row.date} · {row.matter || "no matter"} · <span className="mono">{hrs(row.hours)} h</span></span>
            </div>
            {entry ? (
                <>
                    <div className={"import-hours" + (over ? " over" : "")} title="Hours typed into iTimeKeep against the time Time Capture recorded for the same work, both in tenths.">
                        Entered {hrs(row.hours)}{roundsUp ? `, which rounds to ${enteredTenths.toFixed(1)}` : ""}; recorded {recorded.toFixed(1)} ({whereTime(entry)}).{over ? " More time was entered than was recorded." : under ? " Less time was entered than was recorded." : " They agree."}
                    </div>
                    <div className="import-lawdie">
                        <span className="import-label">Lawdie drafted</span>
                        <div className="import-narr"><NarrativeEntry entry={entry} w={w} draft={draft} setDraft={setDraft} readOnly /></div>
                    </div>
                    <div className="row gap import-actions">
                        {row.decision ? (
                            <>
                                <span className="small strong">{row.decision === "use" ? "Using Lawdie's narrative for this entry." : "Keeping what you typed."}</span>
                                <button type="button" className="link-btn" title="Choose again." onClick={() => decide(null)}>Undo</button>
                            </>
                        ) : (
                            <>
                                <button type="button" className="primary slim" title="Replace what was typed in iTimeKeep with Lawdie's narrative for the same work." onClick={() => decide("use")}>Use this narrative</button>
                                <button type="button" className="quiet slim" title="Keep the description as typed in iTimeKeep." onClick={() => decide("keep")}>Keep mine</button>
                            </>
                        )}
                    </div>
                </>
            ) : <p className="muted small import-none">No captured work matches this entry.</p>}
        </div>
    );
}
