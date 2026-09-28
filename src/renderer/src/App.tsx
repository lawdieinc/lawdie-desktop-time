import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppState } from "@shared/state";
import { NOISE_SECONDS, STRETCH_GAP_MS, intervals, seconds as entrySeconds, secondsWithin, stretchSpan, stretchesOf, type Activity, type Interval, type Stretch, type TimeEntry, type Workspace } from "@shared/model";
import { DESTINATION_LABELS, PRODUCTS, destinationLabel, pairHint, productsFor, type Destination, type Product } from "@shared/kiwi";
import { ago, clock, dayLabel, duration } from "@shared/format";
import wordmark from "../../../resources/brand/lawdie-wordmark.png";
import kiwiMark from "../../../resources/brand/kiwi.png";

/* The window. Three screens for now — Today, Activity, Settings — and the Kiwi
   connection. Everything it shows is the main process's AppState; everything it does
   goes back over window.lawdie. */

type Route = "today" | "activity" | "settings";
const ROUTES: { key: Route; label: string; icon: string }[] = [
    { key: "today", label: "Today", icon: "▦" },
    { key: "activity", label: "Activity", icon: "∿" },
    { key: "settings", label: "Settings", icon: "⚙" },
];

export function App(): ReactNode {
    const [state, setState] = useState<AppState | null>(null);
    const [route, setRoute] = useState<Route>("today");
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        void window.lawdie.getState().then(setState);
        const offState = window.lawdie.onState(setState);
        const offRoute = window.lawdie.onRoute((r) => { if (ROUTES.some((x) => x.key === r)) setRoute(r as Route); });
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { offState(); offRoute(); clearInterval(tick); };
    }, []);

    if (!state) return <div className="loading">Opening your workspace…</div>;
    const w = state.workspace;
    const connected = w.sync !== null;
    const pending = stretchesOf(w.activities).stretches.length; // no hook: this sits after the early return above

    return (
        <div className="shell">
            <aside className="sidebar">
                <div className="brand">
                    <span className="marks"><img src={kiwiMark} alt="" className="kiwi-mark" draggable={false} /><img src={wordmark} alt="Lawdie" className="wordmark" draggable={false} /></span>
                    <h1 className="display">Time capture</h1>
                </div>
                <p className="eyebrow">Workspace</p>
                <nav>
                    {ROUTES.map((r) => (
                        <button key={r.key} type="button" className={"nav" + (route === r.key ? " active" : "")} onClick={() => setRoute(r.key)} aria-current={route === r.key ? "page" : undefined}>
                            <span className="nav-icon" aria-hidden="true">{r.icon}</span>
                            {r.label}
                            {r.key === "activity" && pending > 0 && <span className="badge">{pending}</span>}
                        </button>
                    ))}
                </nav>
                <div className="capture-card">
                    <div className="row"><span className={"dot" + (w.preferences.captureEnabled ? " on" : "")} /> <strong>{w.preferences.captureEnabled ? "Capture is on" : "Capture is paused"}</strong></div>
                    <p className="muted small">{connected ? `Kept time syncs to ${destinationLabel(w.sync?.targets.map((t) => t.product) ?? [])}.` : "Your time. On your machine."}</p>
                    <button type="button" className="quiet" disabled={state.loadFailed} onClick={() => void window.lawdie.setCapture(!w.preferences.captureEnabled)}>
                        {w.preferences.captureEnabled ? "Pause capture" : "Enable capture"}
                    </button>
                </div>
                <div className="account">
                    <span className="avatar">L</span>
                    <div><strong className="small">Personal workspace</strong><p className="muted tiny">{w.sync?.targets[0]?.accountEmail ?? (connected ? `Synced to ${destinationLabel(w.sync?.targets.map((t) => t.product) ?? [])}` : "Local • No account needed")}</p></div>
                </div>
            </aside>
            <main className="content">
                <header className="topbar">
                    <span className="muted">Workspace</span><span className="muted">›</span><span>{ROUTES.find((r) => r.key === route)?.label}</span>
                    <span className="grow" />
                    <span className={"muted" + (w.sync?.targets.some((t) => t.lastError) ? " danger" : "")}>{statusLine(state, now)}</span>
                    <span className="divider" />
                    <span className="muted">{new Date(now).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
                </header>
                <div className="page">
                    {state.error && <Banner tone="danger" onClose={() => void window.lawdie.dismissMessage()}>{state.error}</Banner>}
                    {state.notice && <Banner onClose={() => void window.lawdie.dismissMessage()}>{state.notice}</Banner>}
                    {state.loadFailed ? (
                        <Panel><Empty title="Your workspace needs attention" detail="Time Capture could not read the workspace. The original file is preserved." /></Panel>
                    ) : route === "today" ? <Today w={w} now={now} /> : route === "activity" ? <ActivityView w={w} state={state} /> : <Settings state={state} now={now} />}
                </div>
            </main>
        </div>
    );
}

function statusLine(state: AppState, now: number): string {
    const sync = state.workspace.sync;
    if (!sync) return "Saved on this computer";
    const product = destinationLabel(sync.targets.map((t) => t.product));
    if (state.syncing) return `Syncing to ${product}…`;
    const failed = sync.targets.find((t) => t.lastError);
    if (failed) return `${PRODUCTS[failed.product].label} sync failed · ${failed.lastError!.slice(0, 60)}`;
    const times = sync.targets.map((t) => t.lastSyncedAt);
    if (times.some((t) => !t)) return `Connected to ${product} · not synced yet`;
    return `Synced to ${product} · ${ago(times.sort()[0]!, now)}`;
}

// ---------------------------------------------------------------------------

function Today({ w, now }: { w: Workspace; now: number }): ReactNode {
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const start = dayStart.getTime(), end = start + 86_400_000;
    const entries = w.entries.filter((e) => Date.parse(e.startedAt) < end && Date.parse(e.endedAt) > start).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const tracked = entries.reduce((s, e) => s + secondsWithin(e, start, end), 0);
    const billable = entries.filter((e) => e.billable).reduce((s, e) => s + secondsWithin(e, start, end), 0);
    const pending = stretchesOf(w.activities).stretches.length;
    return (
        <>
            <Heading eyebrow={new Date(now).toLocaleDateString([], { weekday: "long" })} title="Your day, accounted for." subtitle="Track your work across matters, documents, and desktop apps." />
            <div className="metrics">
                <Metric label="Tracked today" value={duration(tracked)} detail={`${entries.length} saved entries`} />
                <Metric label="Billable time" value={duration(billable)} detail="Ready for your next invoice" />
                <Metric label="To review" value={String(pending)} detail="Stretches of desktop work" />
            </div>
            <Panel>
                <div className="row between"><strong>Your day, in focus</strong><span className="eyebrow">Today</span></div>
                {entries.length === 0 ? (
                    <Empty title="A fresh start" detail="Enable capture, work in another app, then keep what matters from the Activity inbox. Your day will take shape here." />
                ) : entries.map((e) => <EntryRow key={e.id} entry={e} w={w} />)}
            </Panel>
        </>
    );
}

function EntryRow({ entry, w }: { entry: TimeEntry; w: Workspace }): ReactNode {
    const p = w.projects.find((x) => x.id === entry.projectID);
    return (
        <div className="entry">
            <span className="bar" />
            <div className="grow">
                <div className="small strong">{entry.description}</div>
                <div className="muted tiny">{p?.name ?? "No project"} · {clock(entry.startedAt)}{entry.sittings && entry.sittings.length > 1 ? `–${clock(entry.endedAt)} · ${entry.sittings.length} sittings` : ""}{entry.billable ? " · billable" : ""}</div>
            </div>
            <span className="mono">{duration(entrySeconds(entry))}</span>
            <button type="button" className="icon" aria-label="Delete entry" title="Delete entry" onClick={() => { if (confirm(`Delete “${entry.description}”?`)) void window.lawdie.deleteEntry(entry.id); }}>×</button>
        </div>
    );
}

// ---------------------------------------------------------------------------

function ActivityView({ w, state }: { w: Workspace; state: AppState }): ReactNode {
    const [filter, setFilter] = useState<"pending" | "kept" | "dismissed" | "all">("pending");
    const [reviewing, setReviewing] = useState<Stretch | null>(null);
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const toggle = (id: string): void => setOpen((o) => ({ ...o, [id]: !o[id] }));
    const { stretches, short } = useMemo(() => stretchesOf(w.activities), [w.activities]);
    const kept = useMemo(() => w.entries.filter((e) => e.activityID).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [w.entries]);
    const raw = useMemo(() => w.activities.filter((a) => filter === "all" || a.disposition === filter).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [w.activities, filter]);
    const byID = useMemo(() => new Map(w.activities.map((a) => [a.id, a])), [w.activities]);
    const current = w.currentActivity;
    const shortSeconds = short.reduce((n, st) => n + st.seconds, 0);
    const gapMinutes = Math.round(STRETCH_GAP_MS / 60_000);
    const count = filter === "pending" ? `${stretches.length} stretches` : filter === "kept" ? `${kept.length} entries` : `${raw.length} sittings`;
    return (
        <>
            <div className="row between">
                <Heading eyebrow="Beyond the browser" title="Review your activity." subtitle="Turn captured desktop work into accurate time entries." />
                <button type="button" className="primary" disabled={state.loadFailed} onClick={() => void window.lawdie.setCapture(!w.preferences.captureEnabled)}>{w.preferences.captureEnabled ? "Pause capture" : "Enable capture"}</button>
            </div>
            <Panel>
                <div className="row gap">
                    <span className="big-icon">{w.preferences.captureEnabled ? "∿" : "‖"}</span>
                    <div className="grow">
                        <strong>{w.preferences.captureEnabled ? "Desktop capture is active" : "Capture is paused"}</strong>
                        <p className="muted small">{current ? `Currently in ${current.app} · ${duration((Date.now() - Date.parse(current.startedAt)) / 1000)}` : "App names and durations only by default. No screenshots, keystrokes, or page contents."}</p>
                    </div>
                </div>
            </Panel>
            <div className="row between">
                <div className="segmented" role="tablist">
                    {(["pending", "kept", "dismissed", "all"] as const).map((f) => <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{{ pending: "To review", kept: "Kept", dismissed: "Dismissed", all: "All" }[f]}</button>)}
                </div>
                <span className="muted small">{count} · retained {w.preferences.retentionDays} days</span>
            </div>
            <Panel>
                {filter === "pending" ? (
                    <>
                        {stretches.length === 0 && short.length === 0 && (
                            <Empty title="You're all caught up." detail="Enable capture, then work in another app. A stretch of work appears here when you switch apps, go idle, or pause capture." />
                        )}
                        {stretches.map((st) => (
                            <div key={st.id}>
                                <div className="activity">
                                    <span className="app-icon">▭</span>
                                    <div className="grow">
                                        <div className="small strong">{st.name}</div>
                                        <div className="muted tiny meta">
                                            <span>{st.app} · {dayLabel(st.startedAt)} {clock(st.startedAt)}{st.sittings > 1 ? `–${clock(st.endedAt)}` : ` · ${endedLabel(st.endedBy)}`}{st.document?.path ? ` · ${st.document.path}` : ""}</span>
                                            {st.sittings > 1 && <SittingsToggle count={st.sittings} open={!!open[st.id]} onClick={() => toggle(st.id)} />}
                                        </div>
                                    </div>
                                    <span className="mono">{duration(st.seconds)}</span>
                                    <button type="button" className="quiet" onClick={() => void window.lawdie.dismissActivity(st.activityIDs)}>Dismiss</button>
                                    <button type="button" className="primary" onClick={() => setReviewing(st)}>Keep time</button>
                                </div>
                                {open[st.id] && st.sittings > 1 && (
                                    <Sittings items={st.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a)} onDismiss={st.sittings > 1 ? (id) => void window.lawdie.dismissActivity(id) : undefined} />
                                )}
                            </div>
                        ))}
                        {short.length > 0 && (
                            <div className="activity">
                                <span className="app-icon muted">·</span>
                                <div className="grow">
                                    <div className="small strong">{short.length} short {short.length === 1 ? "switch" : "switches"}</div>
                                    <div className="muted tiny">Under {NOISE_SECONDS} seconds each — app hops, not work. Sittings on one document within {gapMinutes} minutes are already grouped above.</div>
                                </div>
                                <span className="mono">{duration(shortSeconds)}</span>
                                <button type="button" className="quiet" onClick={() => void window.lawdie.dismissActivity(short.flatMap((st) => st.activityIDs))}>Dismiss all</button>
                            </div>
                        )}
                    </>
                ) : filter === "kept" ? (
                    kept.length === 0 ? (
                        <Empty title="Nothing kept yet." detail="Keep a stretch from To review and it appears here as the entry it became." />
                    ) : kept.map((e) => {
                        const spans = intervals(e);
                        const first = byID.get(e.activityID as string);
                        return (
                            <div key={e.id}>
                                <div className="activity">
                                    <span className="app-icon">▭</span>
                                    <div className="grow">
                                        <div className="small strong">{e.description}</div>
                                        <div className="muted tiny meta">
                                            <span>{first ? `${first.app} · ` : ""}{dayLabel(e.startedAt)} {clock(e.startedAt)}–{clock(e.endedAt)}{e.billable ? " · billable" : " · not billable"}</span>
                                            {spans.length > 1 && <SittingsToggle count={spans.length} open={!!open[e.id]} onClick={() => toggle(e.id)} />}
                                        </div>
                                    </div>
                                    <span className="mono">{duration(entrySeconds(e))}</span>
                                    <span className="muted small status kept">Kept</span>
                                    <button type="button" className="quiet" onClick={() => { if (confirm(`Delete “${e.description}”? Its sittings go back to review.`)) void window.lawdie.deleteEntry(e.id); }}>Delete</button>
                                </div>
                                {open[e.id] && spans.length > 1 && <Sittings items={spans} />}
                            </div>
                        );
                    })
                ) : raw.length === 0 ? (
                    <Empty title="No activities here yet." detail="Each sitting — one stay in one app — is listed here once reviewed." />
                ) : raw.map((a) => (
                    <div className="activity" key={a.id}>
                        <span className="app-icon">▭</span>
                        <div className="grow">
                            <div className="small strong">{a.document?.name || a.title || a.app}</div>
                            <div className="muted tiny">{a.app} · {dayLabel(a.startedAt)} {clock(a.startedAt)} · {endedLabel(a.endedBy)}{a.document?.path ? ` · ${a.document.path}` : ""}</div>
                        </div>
                        <span className="mono">{duration((Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000)}</span>
                        <span className={"muted small status " + a.disposition}>{a.disposition === "kept" ? "Kept" : a.disposition === "dismissed" ? "Dismissed" : "To review"}</span>
                    </div>
                ))}
            </Panel>
            {reviewing && <KeepSheet stretch={reviewing} sittings={reviewing.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a)} onClose={() => setReviewing(null)} />}
        </>
    );
}

/** How a sitting ended, in words. */
const ENDED_BY: Record<string, string> = {
    switched: "switched apps", idle: "went idle", suspended: "the computer slept", gap: "lost track", paused: "paused capture",
    quit: "quit the app", excluded: "opened a private app", "privacy-change": "changed privacy settings", "crash-recovered": "the app went down",
};
const endedLabel = (by: string | undefined): string => (by ? ENDED_BY[by] ?? by : "");

/** "6 sittings ▾" — the count is the control that opens them. */
function SittingsToggle({ count, open, onClick }: { count: number; open: boolean; onClick: () => void }): ReactNode {
    return (
        <button type="button" className={"sittings-toggle" + (open ? " open" : "")} aria-expanded={open} onClick={onClick}>
            {count} sittings
            <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true"><path d="M0.6 1.2h7.8L4.5 5.2z" fill="currentColor" /></svg>
        </button>
    );
}

/** The sittings inside a stretch or a kept entry as a timeline: each sitting on the rail,
 *  the time away between two of them named, and, while a stretch is still under review,
 *  a Dismiss on each that drops it from the stretch. */
function Sittings({ items, onDismiss }: { items: (Interval & { id?: string; endedBy?: string })[]; onDismiss?: (id: string) => void }): ReactNode {
    return (
        <div className="sittings">
            {items.map((i, n) => {
                const prev = items[n - 1];
                const away = prev ? (Date.parse(i.startedAt) - Date.parse(prev.endedAt)) / 1000 : 0;
                return (
                    <div key={i.id ?? n}>
                        {prev && away >= 30 && <div className="sitting-gap"><span className="sitting-rail" aria-hidden="true" /><span className="tiny muted">{duration(away)} away</span></div>}
                        <div className="sitting">
                            <span className="sitting-dot" aria-hidden="true" />
                            <span className="small">{clock(i.startedAt)}–{clock(i.endedAt)}</span>
                            {i.endedBy && <span className="tiny muted">{endedLabel(i.endedBy)}</span>}
                            <span className="grow" />
                            <span className="mono small">{duration((Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000)}</span>
                            {onDismiss && i.id && <button type="button" className="link sitting-dismiss" onClick={() => onDismiss(i.id as string)}>Dismiss</button>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** "HH:MM" in local time, and back onto the stretch's day (an end before the start rolls to the next day). */
const timeValue = (isoText: string): string => { const d = new Date(isoText); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const onDay = (dayIso: string, hhmm: string, notBefore: number | null = null): number => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(dayIso); d.setHours(h, m, 0, 0);
    if (notBefore !== null && d.getTime() <= notBefore) d.setDate(d.getDate() + 1);
    return d.getTime();
};

function KeepSheet({ stretch, sittings, onClose }: { stretch: Stretch; sittings: Activity[]; onClose: () => void }): ReactNode {
    const [description, setDescription] = useState(stretch.document?.name ?? stretch.name);
    const [billable, setBillable] = useState(true);
    const [startText, setStartText] = useState(timeValue(stretch.startedAt));
    const [endText, setEndText] = useState(timeValue(stretch.endedAt));
    const [problem, setProblem] = useState<string | null>(null);
    const start = onDay(stretch.startedAt, startText);
    const end = onDay(stretch.startedAt, endText, start);
    const spans: Interval[] = sittings.map((a) => ({ startedAt: a.startedAt, endedAt: a.endedAt }));
    const preview = stretchSpan(spans, start, end);
    const previewSeconds = preview ? intervals(preview).reduce((n, i) => n + (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000, 0) : 0;
    const changed = startText !== timeValue(stretch.startedAt) || endText !== timeValue(stretch.endedAt);
    const save = async (): Promise<void> => {
        if (!description.trim()) { setProblem("Add a description."); return; }
        if (!preview) { setProblem("No captured time falls between those times."); return; }
        const input = { description, projectID: null, billable, ...(changed ? { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() } : {}) };
        if (await window.lawdie.keepActivity(stretch.activityIDs, input)) onClose();
        else setProblem("That could not be saved. It may overlap time you already kept.");
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <Heading eyebrow="From desktop activity" title="Keep time" subtitle={stretch.sittings > 1 ? `${stretch.sittings} sittings on one document, kept as one entry.` : "Review this activity and choose where it belongs."} />
                <label className="field"><span className="eyebrow">Description</span><input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} /></label>
                <div className="row gap">
                    <label className="field"><span className="eyebrow">Start · {dayLabel(stretch.startedAt)}</span><input type="time" value={startText} onChange={(e) => setStartText(e.target.value)} /></label>
                    <label className="field"><span className="eyebrow">End</span><input type="time" value={endText} onChange={(e) => setEndText(e.target.value)} /></label>
                    <label className="row gap check"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
                </div>
                {stretch.sittings > 1 && <Sittings items={intervals(preview ?? { startedAt: stretch.startedAt, endedAt: stretch.endedAt })} />}
                <p className="muted tiny">{stretch.sittings > 1 ? "Only the sittings count; narrowing the times trims them, and time in other apps between them stays free to keep on its own." : "Change the times if the work ran longer than what was captured."} If this overlaps tracked time, dismiss the activity instead.</p>
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span className="mono accent big">{duration(previewSeconds)}</span>
                    <span className="row gap"><button type="button" className="quiet" onClick={onClose}>Cancel</button><button type="submit" className="primary">Keep time</button></span>
                </div>
            </form>
        </div>
    );
}

// ---------------------------------------------------------------------------

function Settings({ state, now }: { state: AppState; now: number }): ReactNode {
    const w = state.workspace, p = w.preferences;
    const [excluded, setExcluded] = useState("");
    const [office, setOffice] = useState<{ supported: boolean; errors: Record<string, string> } | null>(null);
    useEffect(() => {
        if (!p.captureDocuments) return undefined;
        const ask = () => void window.lawdie.officeStatus().then(setOffice);
        ask();
        const t = setInterval(ask, 10_000);
        return () => clearInterval(t);
    }, [p.captureDocuments]);
    const [destination, setDestination] = useState<Destination>("kiwi");
    const [servers, setServers] = useState<Record<Product, string>>({ kiwi: PRODUCTS.kiwi.defaultServerURL, crm: PRODUCTS.crm.defaultServerURL });
    const [token, setToken] = useState("");
    const [advanced, setAdvanced] = useState(false);
    const product = destinationLabel(w.sync ? w.sync.targets.map((t) => t.product) : productsFor(destination));
    const set = <K extends keyof typeof p>(key: K, value: (typeof p)[K]): void => void window.lawdie.setPreference(key, value);
    const isMac = state.platform === "darwin";
    const label = isMac ? "Mac" : "computer";
    return (
        <>
            <Heading eyebrow="On your terms" title="Your time. Your boundaries." subtitle="Control what Time Capture sees, what it keeps, and what leaves your machine." />
            <Panel>
                <strong>Desktop capture</strong>
                <Setting title="Capture app activity" detail="Records the foreground app and duration across your desktop. Start and stop at any time.">
                    <Toggle on={p.captureEnabled} onChange={(v) => void window.lawdie.setCapture(v)} label="Capture app activity" />
                </Setting>
                <Setting title="Include window titles" detail={isMac ? "Optional context such as document names. Titles may contain sensitive information. macOS asks for Screen Recording permission the first time." : "Optional context such as document names. Titles may contain sensitive information."}>
                    <Toggle on={p.captureTitles} onChange={(v) => set("captureTitles", v)} label="Include window titles" />
                </Setting>
                <Setting title="Read Office document details" detail={`For Word, Excel, PowerPoint and Outlook: the open document's name, where it is saved, and its first few lines (Outlook: the sender and subject). Kiwi or Lawdie CRM uses these to match your time to a matter. ${isMac ? "macOS asks once whether Time Capture may control each app." : state.platform === "win32" ? "Nothing to grant on Windows." : "Not available on Linux."}`}>
                    <Toggle on={p.captureDocuments} onChange={(v) => set("captureDocuments", v)} label="Read Office document details" />
                </Setting>
                {p.captureDocuments && office && !office.supported && <p className="muted tiny">Not available on this platform.</p>}
                {p.captureDocuments && office && Object.entries(office.errors).map(([app, message]) => (
                    <p key={app} className="danger tiny">{{ word: "Word", excel: "Excel", powerpoint: "PowerPoint", outlook: "Outlook" }[app] ?? app} did not answer: {message}</p>
                ))}
                <Setting title="Idle timeout" detail="Stops capture and your timer at the last input after this much inactivity.">
                    <select value={p.idleMinutes} onChange={(e) => set("idleMinutes", Number(e.target.value))}>{[1, 3, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select>
                </Setting>
                <Setting title="Activity retention" detail="Older raw activity is removed automatically. Saved time entries are kept.">
                    <select value={p.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value))}>{[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
                </Setting>
            </Panel>
            <Panel>
                <strong>Apps that stay private</strong>
                <p className="muted small">Excluded apps are skipped before any window title is read. {isMac ? "Enter a bundle identifier, such as com.apple.Safari." : "Enter the program's file name, such as chrome.exe."}</p>
                <div className="chips">{p.excludedOwnerIDs.map((id) => <span key={id} className="chip mono">{id}<button type="button" aria-label={`Stop excluding ${id}`} onClick={() => set("excludedOwnerIDs", p.excludedOwnerIDs.filter((x) => x !== id))}>×</button></span>)}</div>
                <form className="row gap" onSubmit={(e) => { e.preventDefault(); const v = excluded.trim(); if (v && !p.excludedOwnerIDs.includes(v)) set("excludedOwnerIDs", [...p.excludedOwnerIDs, v]); setExcluded(""); }}>
                    <input value={excluded} onChange={(e) => setExcluded(e.target.value)} placeholder={isMac ? "com.example.private-app" : "private-app.exe"} />
                    <button type="submit" className="quiet">Exclude</button>
                </form>
            </Panel>
            <Panel>
                <strong>Your data belongs here</strong>
                <p className="muted small">No telemetry, screenshots, keystroke recording, or local network service. Nothing leaves this {label} unless you connect Kiwi or Lawdie CRM below, and then only captured activity and your time entries. Data is a local file protected by your account permissions; it is not separately encrypted.</p>
                <p className="mono tiny muted">{state.workspacePath}</p>
                <div className="row gap">
                    <button type="button" className="quiet" onClick={() => void window.lawdie.showDataFolder()}>Show data folder</button>
                    <span className="grow" />
                    <button type="button" className="quiet danger" onClick={() => { if (confirm("Clear all captured desktop activity? Saved time entries are kept and capture is paused.")) void window.lawdie.clearActivity(); }}>Clear activity…</button>
                </div>
            </Panel>
            <Panel>
                <div className="row between">
                    <strong>Sync to Kiwi or Lawdie CRM</strong>
                    <span className="row gap small"><span className={"dot" + (w.sync ? (w.sync.targets.some((t) => t.lastError) ? " bad" : " on") : "")} />{w.sync ? "Connected" : "Not connected"}</span>
                </div>
                {w.sync ? (
                    <>
                        {w.sync.targets.map((t) => (
                            <div key={t.product}>
                                <p className="muted small">{PRODUCTS[t.product].label} ({t.serverURL}) as {t.accountEmail ?? "your account"}. There, this {label} is “{t.deviceName}”.</p>
                                {t.lastError && <p className="danger tiny">{PRODUCTS[t.product].label}: {t.lastError}</p>}
                            </div>
                        ))}
                        <p className={"small strong" + (w.sync.targets.some((t) => t.lastError) ? " danger" : "")}>{statusLine(state, now)}</p>
                        <label className="row gap check"><input type="checkbox" checked={w.sync.autoSync} onChange={(e) => void window.lawdie.setAutoSync(e.target.checked)} /> Sync automatically, about once a minute</label>
                        <div className="row gap">
                            <button type="button" className="primary" disabled={state.syncing} onClick={() => void window.lawdie.syncNow()}>{state.syncing ? "Syncing…" : "Sync now"}</button>
                            <button type="button" className="quiet" disabled={state.syncing} onClick={() => void window.lawdie.disconnectKiwi()}>Disconnect</button>
                        </div>
                        <p className="muted tiny">What syncs: captured activity (app names, durations, and window titles and Office document details if you switched them on) and the time entries you keep. {product} matches a stretch to a matter only when its title or document names exactly one — never from your local project label.{w.sync.targets.some((t) => t.product === "kiwi") ? " In Kiwi, billable kept entries become drafts on the Time page for you to approve, under “No matter” when nothing matched; deleting an entry here dismisses its draft there." : ""}{w.sync.targets.some((t) => t.product === "crm") ? " In Lawdie CRM, a kept entry with a matter lands on the ledger at the next sync and one without waits on its Time page for you to name the matter; deleting an entry here removes it there unless it has been billed." : ""}</p>
                    </>
                ) : (
                    <>
                        <div className="segmented" role="radiogroup" aria-label="Sync destination">
                            {(Object.keys(DESTINATION_LABELS) as Destination[]).map((d) => (
                                <button key={d} type="button" role="radio" aria-checked={destination === d} className={destination === d ? "active" : ""} onClick={() => setDestination(d)}>{DESTINATION_LABELS[d]}</button>
                            ))}
                        </div>
                        <p className="muted small">{pairHint(destination)} Paste the token it shows here; it is shown once. Until you connect, nothing leaves this {label}.</p>
                        <form className="row gap" onSubmit={(e) => { e.preventDefault(); void window.lawdie.connectKiwi(destination, servers, token).then((ok) => { if (ok) setToken(""); }); }}>
                            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={`ldt_… token from ${product}`} autoComplete="off" />
                            <button type="submit" className="primary" disabled={state.syncing || !token.trim()}>{state.syncing ? "Connecting…" : "Connect"}</button>
                        </form>
                        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>{advanced ? "▾" : "▸"} Server {productsFor(destination).length > 1 ? "addresses" : "address"}</button>
                        {advanced && productsFor(destination).map((p) => (
                            <div key={p} className="row gap">
                                <span className="muted small">{PRODUCTS[p].label}</span>
                                <input value={servers[p]} onChange={(e) => setServers({ ...servers, [p]: e.target.value })} aria-label={`${PRODUCTS[p].label} server`} />
                                <span className="muted tiny">Change only for a self-hosted or local {PRODUCTS[p].label}.</span>
                            </div>
                        ))}
                    </>
                )}
            </Panel>
        </>
    );
}

// ---------------------------------------------------------------------------

function Heading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }): ReactNode {
    return <div className="heading"><p className="eyebrow">{eyebrow}</p><h2 className="display">{title}</h2><p className="muted">{subtitle}</p></div>;
}
function Panel({ children }: { children: ReactNode }): ReactNode { return <section className="panel">{children}</section>; }
function Metric({ label, value, detail }: { label: string; value: string; detail: string }): ReactNode {
    return <section className="panel metric"><p className="muted small">{label}</p><p className="value">{value}</p><p className="muted tiny">{detail}</p></section>;
}
function Empty({ title, detail }: { title: string; detail: string }): ReactNode { return <div className="empty"><strong>{title}</strong><p className="muted small">{detail}</p></div>; }
function Banner({ children, tone, onClose }: { children: ReactNode; tone?: "danger"; onClose: () => void }): ReactNode {
    return <div className={"banner" + (tone ? " " + tone : "")} role={tone ? "alert" : "status"}><span className="grow">{children}</span><button type="button" className="icon" aria-label="Dismiss" onClick={onClose}>×</button></div>;
}
function Setting({ title, detail, children }: { title: string; detail: string; children: ReactNode }): ReactNode {
    return <div className="setting"><div className="grow"><div className="small strong">{title}</div><p className="muted tiny">{detail}</p></div>{children}</div>;
}
function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }): ReactNode {
    return <button type="button" role="switch" aria-checked={on} aria-label={label} className={"toggle" + (on ? " on" : "")} onClick={() => onChange(!on)}><span /></button>;
}
