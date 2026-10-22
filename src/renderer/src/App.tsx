import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppState } from "@shared/state";
import { NOISE_SECONDS, SCREEN_TEXT_MAX, STRETCH_GAP_MS, intervals, seconds as entrySeconds, secondsWithin, stretchSpan, type Activity, type Draft, type DraftSource, type Interval, type Project, type Stretch, type TimeEntry, type Workspace } from "@shared/model";
import { inboxOf, matterStretch, toReview, type MatterGroup } from "@shared/matters";
import { DESTINATION_LABELS, PRODUCTS, destinationLabel, pairHint, productsFor, type Destination, type Product } from "@shared/kiwi";
import { ago, clock, dayLabel, duration } from "@shared/format";
import wordmark from "../../../resources/brand/lawdie-wordmark.png";
import kiwiMark from "../../../resources/brand/kiwi.png";

/* The window. Four screens (Time, Activity, Matters, Settings) and the Kiwi
   connection. Everything it shows is the main process's AppState; everything it does
   goes back over window.lawdie. */

type Route = "today" | "activity" | "matters" | "settings";
const ROUTES: { key: Route; label: string; icon: string }[] = [
    { key: "today", label: "Time", icon: "▦" },
    { key: "activity", label: "Activity", icon: "∿" },
    { key: "matters", label: "Matters", icon: "§" },
    { key: "settings", label: "Settings", icon: "⚙" },
];

export function App(): ReactNode {
    const [state, setState] = useState<AppState | null>(null);
    const [route, setRoute] = useState<Route>("today");
    const [updateLater, setUpdateLater] = useState(false);
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
    const pending = toReview(w.activities); // no hook: this sits after the early return above

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
                    {state.updateReady && !updateLater && (
                        <Banner onClose={() => setUpdateLater(true)}>
                            <span className="row gap">Version {state.updateReady} is ready; it installs the next time the app restarts.<span className="grow" /><button type="button" className="primary" onClick={() => void window.lawdie.installUpdate()}>Restart now</button></span>
                        </Banner>
                    )}
                    {state.loadFailed ? (
                        <Panel><Empty title="Your workspace needs attention" detail="Time Capture could not read the workspace. The original file is preserved." /></Panel>
                    ) : route === "today" ? <Today w={w} now={now} /> : route === "activity" ? <ActivityView w={w} state={state} /> : route === "matters" ? <MattersView w={w} now={now} onReview={() => setRoute("activity")} /> : <Settings state={state} now={now} />}
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

type RangeKey = "today" | "week" | "month" | "all" | "custom";
const RANGES: { key: RangeKey; label: string }[] = [
    { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "all", label: "All time" }, { key: "custom", label: "Custom" },
];
const dayKey = (t: number): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dayStartOf = (t: number): number => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** [start, end) for a range, in local time. Custom takes YYYY-MM-DD from and to, inclusive. */
function rangeBounds(key: RangeKey, now: number, from: string, to: string): { start: number; end: number; label: string } {
    const today = dayStartOf(now);
    if (key === "today") return { start: today, end: today + 86_400_000, label: new Date(now).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) };
    if (key === "week") { const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { start: d.getTime(), end: today + 86_400_000, label: `Week of ${d.toLocaleDateString([], { month: "long", day: "numeric" })}` }; }
    if (key === "month") { const d = new Date(today); d.setDate(1); return { start: d.getTime(), end: today + 86_400_000, label: d.toLocaleDateString([], { month: "long", year: "numeric" }) }; }
    if (key === "all") return { start: 0, end: today + 86_400_000, label: "All time" };
    const f = from ? new Date(`${from}T00:00:00`).getTime() : today, t = to ? new Date(`${to}T00:00:00`).getTime() + 86_400_000 : today + 86_400_000;
    return { start: f, end: Math.max(t, f + 86_400_000), label: `${new Date(f).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(t - 1).toLocaleDateString([], { month: "short", day: "numeric" })}` };
}

function Today({ w, now }: { w: Workspace; now: number }): ReactNode {
    const [range, setRange] = useState<RangeKey>("today");
    const [from, setFrom] = useState(dayKey(now - 6 * 86_400_000));
    const [to, setTo] = useState(dayKey(now));
    const { start, end, label } = rangeBounds(range, now, from, to);
    const entries = w.entries.filter((e) => Date.parse(e.startedAt) < end && Date.parse(e.endedAt) > start).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const tracked = entries.reduce((s, e) => s + secondsWithin(e, start, end), 0);
    const billable = entries.filter((e) => e.billable).reduce((s, e) => s + secondsWithin(e, start, end), 0);
    const pending = toReview(w.activities);
    // Grouped by day, newest first; a day's figure is only what fell inside the range.
    const days = new Map<string, TimeEntry[]>();
    for (const e of entries) { const k = dayKey(Date.parse(e.startedAt)); if (!days.has(k)) days.set(k, []); days.get(k)!.push(e); }
    const byProject = new Map<string, number>();
    for (const e of entries.filter((x) => x.billable)) { const name = w.projects.find((p) => p.id === e.projectID)?.name ?? "No project"; byProject.set(name, (byProject.get(name) ?? 0) + secondsWithin(e, start, end)); }
    const projects = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
    return (
        <>
            <Heading eyebrow={label} title={range === "today" ? "Your day, accounted for." : "Your time, accounted for."} />
            <div className="row between wrap">
                <div className="segmented" role="tablist" aria-label="Range">
                    {RANGES.map((r) => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} className={range === r.key ? "active" : ""} onClick={() => setRange(r.key)}>{r.label}</button>)}
                </div>
                {range === "custom" && (
                    <span className="row gap small">
                        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
                        <span className="muted">to</span>
                        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
                    </span>
                )}
            </div>
            <div className="metrics">
                <Metric label={range === "today" ? "Tracked today" : "Tracked"} value={duration(tracked)} detail={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`} />
                <Metric label="Billable time" value={duration(billable)} detail={tracked ? `${Math.round((billable / tracked) * 100)}% of tracked` : "Ready for your next invoice"} />
                <Metric label="To review" value={String(pending)} detail="Matters and stretches of desktop work" />
            </div>
            {projects.length > 1 && (
                <Panel>
                    <div className="row between"><strong>Billable, by project</strong><span className="eyebrow">{label}</span></div>
                    {projects.map(([name, secs]) => (
                        <div className="row between small" key={name} style={{ padding: "8px 0" }}><span>{name}</span><span className="mono">{duration(secs)}</span></div>
                    ))}
                </Panel>
            )}
            <Panel>
                <div className="row between"><strong>{range === "today" ? "Your day, in focus" : "Entries"}</strong><span className="eyebrow">{label}</span></div>
                {entries.length === 0 ? (
                    <Empty title={range === "today" ? "A fresh start" : "Nothing in this range"} detail="Enable capture, work in another app, then keep what matters from the Activity inbox. Your time will take shape here." />
                ) : [...days.entries()].map(([k, list]) => (
                    <div key={k}>
                        {range !== "today" && (
                            <div className="row between day-head">
                                <span className="eyebrow">{dayLabel(list[0].startedAt, new Date(now))}</span>
                                <span className="muted tiny mono">{duration(list.reduce((s, e) => s + secondsWithin(e, start, end), 0))} · billable {duration(list.filter((e) => e.billable).reduce((s, e) => s + secondsWithin(e, start, end), 0))}</span>
                            </div>
                        )}
                        {list.map((e) => <EntryRow key={e.id} entry={e} w={w} />)}
                    </div>
                ))}
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
                <div className="small strong">{entry.description} <AiTag source={entry.drafted} /></div>
                <div className="muted tiny"><MatterLabel name={p?.name} /> · {clock(entry.startedAt)}{entry.sittings && entry.sittings.length > 1 ? `–${clock(entry.endedAt)} · ${entry.sittings.length} sittings` : ""}{entry.billable ? " · billable" : ""}</div>
            </div>
            <span className="mono">{duration(entrySeconds(entry))}</span>
            <button type="button" className="icon" aria-label="Delete entry" title="Delete entry" onClick={() => { if (confirm(`Delete “${entry.description}”?`)) void window.lawdie.deleteEntry(entry.id); }}>×</button>
        </div>
    );
}

// ---------------------------------------------------------------------------

const SORTS = { newest: "Newest first", oldest: "Oldest first", longest: "Longest first", name: "Name A–Z" } as const;
type SortBy = keyof typeof SORTS;

/** A list in the order picked: by when it was last worked on, by time, or by name. */
function sortBy<T>(items: readonly T[], by: SortBy, key: (item: T) => { at: string; seconds: number; name: string }): T[] {
    return [...items].sort((x, y) => {
        const a = key(x), b = key(y);
        if (by === "longest") return b.seconds - a.seconds;
        if (by === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        return by === "oldest" ? Date.parse(a.at) - Date.parse(b.at) : Date.parse(b.at) - Date.parse(a.at);
    });
}

function ActivityView({ w, state }: { w: Workspace; state: AppState }): ReactNode {
    const [filter, setFilter] = useState<"pending" | "kept" | "dismissed" | "all">("pending");
    const [sort, setSort] = useState<SortBy>("newest");
    const [reviewing, setReviewing] = useState<{ stretch: Stretch; matter: string | null; description: string } | null>(null);
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const toggle = (id: string): void => setOpen((o) => ({ ...o, [id]: !o[id] }));
    const { groups, stretches, short } = useMemo(() => inboxOf(w.activities), [w.activities]);
    // Opening the inbox freshens it; the main process skips this when it ran in the last ten minutes.
    useEffect(() => { if (w.preferences.suggestMatters) void window.lawdie.suggestMatters(); }, [w.preferences.suggestMatters]);
    // Matters and stretches are one list, so the newest work is on top whether or not it has a matter yet.
    const pendingRows = useMemo(() => sortBy([...groups.map((g) => ({ group: g })), ...stretches.map((st) => ({ stretch: st }))], sort,
        (r) => "group" in r ? { at: r.group.endedAt, seconds: r.group.seconds, name: r.group.matter } : { at: r.stretch.endedAt, seconds: r.stretch.seconds, name: r.stretch.name }), [groups, stretches, sort]);
    const kept = useMemo(() => sortBy(w.entries.filter((e) => e.activityID), sort, (e) => ({ at: e.endedAt, seconds: entrySeconds(e), name: e.description })), [w.entries, sort]);
    const raw = useMemo(() => sortBy(w.activities.filter((a) => filter === "all" || a.disposition === filter), sort, (a) => ({ at: a.endedAt, seconds: (Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000, name: a.document?.name || a.title || a.app })), [w.activities, filter, sort]);
    const byID = useMemo(() => new Map(w.activities.map((a) => [a.id, a])), [w.activities]);
    const current = w.currentActivity;
    const shortSeconds = short.reduce((n, st) => n + st.seconds, 0);
    const gapMinutes = Math.round(STRETCH_GAP_MS / 60_000);
    const count = filter === "pending" ? [groups.length ? `${groups.length} ${groups.length === 1 ? "matter" : "matters"}` : "", stretches.length || !groups.length ? `${stretches.length} ${stretches.length === 1 ? "stretch" : "stretches"}` : ""].filter(Boolean).join(" · ") : filter === "kept" ? `${kept.length} entries` : `${raw.length} sittings`;
    return (
        <>
            <div className="row between">
                <Heading eyebrow="Beyond the browser" title="Review your activity." />
                <button type="button" className="primary" disabled={state.loadFailed} onClick={() => void window.lawdie.setCapture(!w.preferences.captureEnabled)}>{w.preferences.captureEnabled ? "Pause capture" : "Enable capture"}</button>
            </div>
            <Panel>
                <div className="row gap">
                    <span className="big-icon">{w.preferences.captureEnabled ? "∿" : "‖"}</span>
                    <div className="grow">
                        <strong>{w.preferences.captureEnabled ? "Desktop capture is active" : "Capture is paused"}</strong>
                        <p className="muted small">{current ? `Currently in ${current.app} · ${duration((Date.now() - Date.parse(current.startedAt)) / 1000)}` : w.preferences.captureScreenText ? "App names and durations, and some on-screen text from the apps you work in. No screenshots or keystrokes; browsers are left to the browser extension." : "App names and durations only by default. No screenshots, keystrokes, or page contents."}</p>
                    </div>
                </div>
            </Panel>
            {w.preferences.suggestMatters && (
                <div className="row gap small matter-status">
                    <span className={"dot" + (state.matters.error ? " bad" : state.matters.running ? " on" : "")} />
                    <span className={"grow" + (state.matters.error ? " danger" : " muted")}>{state.matters.running ? "Kiwi's AI is naming matters and drafting descriptions…" : state.matters.error ?? "Kiwi's AI names each stretch of work's matter and drafts its description. Correct either when you keep the time and later suggestions follow you."}</span>
                    <button type="button" className="quiet" disabled={state.matters.running} onClick={() => void window.lawdie.suggestMatters(true)}>Suggest now</button>
                </div>
            )}
            <div className="row between">
                <div className="segmented" role="tablist">
                    {(["pending", "kept", "dismissed", "all"] as const).map((f) => <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{{ pending: "To review", kept: "Kept", dismissed: "Dismissed", all: "All" }[f]}</button>)}
                </div>
                <div className="row gap">
                    <span className="muted small">{count} · retained {w.preferences.retentionDays} days</span>
                    <select value={sort} onChange={(e) => setSort(e.target.value as SortBy)} aria-label="Sort">{(Object.keys(SORTS) as SortBy[]).map((k) => <option key={k} value={k}>{SORTS[k]}</option>)}</select>
                </div>
            </div>
            <Panel>
                {filter === "pending" ? (
                    <>
                        {groups.length === 0 && stretches.length === 0 && short.length === 0 && (
                            <Empty title="You're all caught up." detail="Enable capture, then work in another app. A stretch of work appears here when you switch apps, lock or sleep the computer, or pause capture." />
                        )}
                        {pendingRows.map((r) => "group" in r ? (
                            <MatterRow key={r.group.id} group={r.group} open={!!open[r.group.id]} onToggle={() => toggle(r.group.id)}
                                onKeep={() => setReviewing({ stretch: matterStretch(r.group), matter: r.group.matter, description: r.group.draft?.text ?? r.group.documents.slice(0, 3).map((d) => d.name).join("; ") })} />
                        ) : ((st) => (
                            <div key={st.id}>
                                <div className="activity">
                                    <span className="app-icon">▭</span>
                                    <div className="grow">
                                        <div className="small strong">{st.name}</div>
                                        {st.draft && <DraftLine draft={st.draft} />}
                                        <div className="muted tiny meta">
                                            <span><MatterLabel name={null} /> · {st.app} · {dayLabel(st.startedAt)} {clock(st.startedAt)}{st.sittings > 1 ? `–${clock(st.endedAt)}` : ` · ${endedLabel(st.endedBy)}`}{st.document?.path ? ` · ${st.document.path}` : ""}</span>
                                            {st.sittings > 1 && <SittingsToggle label={`${st.sittings} sittings`} open={!!open[st.id]} onClick={() => toggle(st.id)} />}
                                        </div>
                                    </div>
                                    <span className="mono">{duration(st.seconds)}</span>
                                    <button type="button" className="quiet" onClick={() => void window.lawdie.dismissActivity(st.activityIDs)}>Dismiss</button>
                                    <button type="button" className="primary" onClick={() => setReviewing({ stretch: st, matter: null, description: st.draft?.text ?? st.document?.name ?? st.name })}>Keep time</button>
                                </div>
                                {open[st.id] && st.sittings > 1 && (
                                    <Sittings items={st.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a)} onDismiss={st.sittings > 1 ? (id) => void window.lawdie.dismissActivity(id) : undefined} />
                                )}
                            </div>
                        ))(r.stretch))}
                        {short.length > 0 && (
                            <div className="activity">
                                <span className="app-icon muted">·</span>
                                <div className="grow">
                                    <div className="small strong">{short.length} brief {short.length === 1 ? "touch" : "touches"}</div>
                                    <div className="muted tiny">Under {NOISE_SECONDS} seconds each, on a matter or not: app hops and glances, not billable time. Sittings on one document within {gapMinutes} minutes are already grouped above.</div>
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
                                        <div className="small strong">{e.description} <AiTag source={e.drafted} /></div>
                                        <div className="muted tiny meta">
                                            <span><MatterLabel name={w.projects.find((x) => x.id === e.projectID)?.name} /> · {first ? `${first.app} · ` : ""}{dayLabel(e.startedAt)} {clock(e.startedAt)}–{clock(e.endedAt)}{e.billable ? " · billable" : " · not billable"}</span>
                                            {spans.length > 1 && <SittingsToggle label={`${spans.length} sittings`} open={!!open[e.id]} onClick={() => toggle(e.id)} />}
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
                    <Empty title="No activities here yet." detail="Each sitting, one stay in one app, is listed here once reviewed." />
                ) : raw.map((a) => (
                    <div className="activity" key={a.id}>
                        <span className="app-icon">▭</span>
                        <div className="grow">
                            <div className="small strong">{a.document?.name || a.title || a.app}</div>
                            <div className="muted tiny"><MatterLabel name={a.matter} /> · {a.app} · {dayLabel(a.startedAt)} {clock(a.startedAt)} · {endedLabel(a.endedBy)}{a.document?.path ? ` · ${a.document.path}` : ""}</div>
                            {(a.screenText || a.document?.excerpt) && <div className="tiny screen-text" title="What was read from the window">{(a.screenText ?? a.document?.excerpt ?? "").replace(/\n/g, " · ").slice(0, 220)}</div>}
                        </div>
                        <span className="mono">{duration((Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000)}</span>
                        <span className={"muted small status " + a.disposition}>{a.disposition === "kept" ? "Kept" : a.disposition === "dismissed" ? "Dismissed" : "To review"}</span>
                    </div>
                ))}
            </Panel>
            {reviewing && <KeepSheet key={reviewing.stretch.id} stretch={reviewing.stretch} matter={reviewing.matter} initialDescription={reviewing.description} projects={w.projects.filter((p) => !p.archived).map((p) => p.name)} sittings={reviewing.stretch.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a)} onClose={() => setReviewing(null)} />}
        </>
    );
}

/** How a sitting ended, in words. */
const ENDED_BY: Record<string, string> = {
    switched: "switched apps", idle: "went idle", suspended: "the computer slept", gap: "lost track", paused: "paused capture",
    quit: "quit the app", excluded: "opened a private app", browser: "went to the browser", "privacy-change": "changed privacy settings", "crash-recovered": "the app went down",
};
const endedLabel = (by: string | undefined): string => (by ? ENDED_BY[by] ?? by : "");

/** An AI-drafted billing description, under the row it was drafted for. */
function DraftLine({ draft }: { draft: Draft }): ReactNode {
    return <div className="draft-line" title={draft.source === "sample" ? "Sample draft, not generated from your data" : "Drafted by AI from what was captured"}><span aria-hidden="true">✦</span> {draft.text}</div>;
}

/** "✦ AI" after a description that is an AI draft kept as written. */
function AiTag({ source }: { source: DraftSource | undefined }): ReactNode {
    return source ? <span className="ai-tag" title={source === "sample" ? "Sample draft, not generated from your data" : "Drafted by AI, kept as written"}>✦ AI{source === "sample" ? " · sample" : ""}</span> : null;
}

/** The matter something is on, in small type; "No matter" when it is on none. */
function MatterLabel({ name }: { name: string | null | undefined }): ReactNode {
    return name ? <span className="matter-label">{name}</span> : <span className="matter-label none">No matter</span>;
}

/** One matter's day: every app and document it was in, as one row to keep. */
function MatterRow({ group: g, open, onToggle, onKeep }: { group: MatterGroup; open: boolean; onToggle: () => void; onKeep: () => void }): ReactNode {
    return (
        <div>
            <div className="activity">
                <span className="app-icon matter-icon" aria-hidden="true">§</span>
                <div className="grow">
                    <div className="small strong">{g.matter}</div>
                    {g.draft && <DraftLine draft={g.draft} />}
                    <div className="muted tiny meta">
                        <span>{g.apps.join(", ")} · {dayLabel(g.startedAt)} {clock(g.startedAt)}–{clock(g.endedAt)} · {g.sittings} {g.sittings === 1 ? "sitting" : "sittings"}</span>
                        <SittingsToggle label={`${g.documents.length} ${g.documents.length === 1 ? "item" : "items"}`} open={open} onClick={onToggle} />
                    </div>
                </div>
                <span className="mono">{duration(g.seconds)}</span>
                <button type="button" className="quiet" onClick={() => void window.lawdie.dismissActivity(g.activityIDs)}>Dismiss</button>
                <button type="button" className="primary" onClick={onKeep}>Keep time</button>
            </div>
            {open && (
                <div className="sittings">
                    {g.documents.map((d) => (
                        <div className="sitting" key={`${d.app}\n${d.name}`}>
                            <span className="sitting-dot" aria-hidden="true" />
                            <span className="small">{d.name}</span>
                            <span className="tiny muted">{d.app}{d.activityIDs.length > 1 ? ` · ${d.activityIDs.length} sittings` : ""}</span>
                            <span className="grow" />
                            <span className="mono small">{duration(d.seconds)}</span>
                            <button type="button" className="link sitting-dismiss" title="Take this out of the matter; it goes back to review on its own" onClick={() => void window.lawdie.setMatter(d.activityIDs, null)}>Not this matter</button>
                            <button type="button" className="link sitting-dismiss" title={`Dismiss ${d.activityIDs.length === 1 ? "this sitting" : `these ${d.activityIDs.length} sittings`}; the rest of the matter stays to review`} onClick={() => void window.lawdie.dismissActivity(d.activityIDs)}>Dismiss</button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** "6 sittings ▾": the count is the control that opens them. */
function SittingsToggle({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }): ReactNode {
    return (
        <button type="button" className={"sittings-toggle" + (open ? " open" : "")} aria-expanded={open} onClick={onClick}>
            {label}
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

function KeepSheet({ stretch, matter: suggested, initialDescription, projects, sittings, onClose }: { stretch: Stretch; matter: string | null; initialDescription: string; projects: string[]; sittings: Activity[]; onClose: () => void }): ReactNode {
    const [description, setDescription] = useState(initialDescription);
    const [matter, setMatter] = useState(suggested ?? "");
    const asDrafted = !!stretch.draft && description.trim() === stretch.draft.text;
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
        const input = { description, projectID: null, matter: matter.trim() || null, billable, ...(asDrafted ? { drafted: stretch.draft!.source } : {}), ...(changed ? { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() } : {}) };
        if (await window.lawdie.keepActivity(stretch.activityIDs, input)) onClose();
        else setProblem("That could not be saved. It may overlap time you already kept.");
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <Heading eyebrow="From desktop activity" title="Keep time" subtitle={suggested ? `${stretch.sittings} ${stretch.sittings === 1 ? "sitting" : "sittings"} on ${suggested}, in ${stretch.app}, kept as one entry.` : stretch.sittings > 1 ? `${stretch.sittings} sittings on one document, kept as one entry.` : "Review this activity and choose where it belongs."} />
                <label className="field"><span className="eyebrow">Matter{suggested ? " · suggested" : ""}</span><input list="matter-names" value={matter} placeholder="Which matter is this? Leave empty for none." onChange={(e) => setMatter(e.target.value)} /></label>
                <datalist id="matter-names">{projects.map((p) => <option key={p} value={p} />)}</datalist>
                <label className="field"><span className="eyebrow">Description{asDrafted ? ` · drafted by AI${stretch.draft!.source === "sample" ? " (sample)" : ""}` : ""}</span><input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} /></label>
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

const money = (n: number): string => n.toLocaleString([], { style: "currency", currency: "USD", maximumFractionDigits: 0 });
type MatterStats = { tracked: number; billable: number; value: number; entries: TimeEntry[] };
/** What a matter's kept time came to inside [start, end): every entry at the rate it was saved with. */
function statsFor(w: Workspace, projectID: string | null, start: number, end: number): MatterStats {
    const entries = w.entries.filter((e) => e.projectID === projectID && Date.parse(e.startedAt) < end && Date.parse(e.endedAt) > start).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    let tracked = 0, billable = 0, value = 0;
    for (const e of entries) {
        const secs = secondsWithin(e, start, end);
        tracked += secs;
        if (e.billable) { billable += secs; value += (secs / 3600) * e.hourlyRate; }
    }
    return { tracked, billable, value, entries };
}
const MATTER_RANGES = RANGES.filter((r) => r.key !== "custom");

function MattersView({ w, now, onReview }: { w: Workspace; now: number; onReview: () => void }): ReactNode {
    const [range, setRange] = useState<RangeKey>("week");
    const [selected, setSelected] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const { start, end, label } = rangeBounds(range, now, "", "");
    const { groups } = useMemo(() => inboxOf(w.activities), [w.activities]);
    const waiting = (name: string): MatterGroup[] => groups.filter((g) => g.matter.toLowerCase() === name.trim().toLowerCase());
    const rows = w.projects.map((p) => ({ p, stats: statsFor(w, p.id, start, end), waiting: waiting(p.name) }));
    const open = rows.filter((r) => !r.p.archived).sort((a, b) => b.stats.tracked - a.stats.tracked || a.p.name.localeCompare(b.p.name));
    const archived = rows.filter((r) => r.p.archived).sort((a, b) => a.p.name.localeCompare(b.p.name));
    const none = statsFor(w, null, start, end);
    const total = open.reduce((n, r) => n + r.stats.value, 0);
    const billable = open.reduce((n, r) => n + r.stats.billable, 0);
    const chosen = selected === "none" ? null : w.projects.find((p) => p.id === selected);
    const rangeTabs = (
        <div className="segmented" role="tablist" aria-label="Range">
            {MATTER_RANGES.map((r) => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} className={range === r.key ? "active" : ""} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
    );
    if (selected && (chosen || selected === "none")) {
        return <MatterDetail key={selected} w={w} project={chosen ?? null} stats={chosen ? statsFor(w, chosen.id, start, end) : none} waiting={chosen ? waiting(chosen.name) : []} label={label} rangeTabs={rangeTabs} now={now} onBack={() => setSelected(null)} onReview={onReview} />;
    }
    const row = ({ p, stats, waiting: list }: (typeof rows)[number]) => (
        <button type="button" key={p.id} className={"matter-row" + (p.archived ? " archived" : "")} onClick={() => setSelected(p.id)}>
            <span className="app-icon matter-icon" aria-hidden="true">§</span>
            <span className="matter-name">
                <span className="small strong">{p.name}</span>
                <span className="muted tiny">{p.client || "No client"} · {p.hourlyRate ? `${money(p.hourlyRate)}/h` : "No rate set"}</span>
            </span>
            <span className="mono small">{duration(stats.tracked)}</span>
            <span className="mono small">{duration(stats.billable)}</span>
            <span className="mono small">{money(stats.value)}</span>
            <span className="tiny">{list.length ? <span className="waiting">{list.length} to review</span> : null}</span>
        </button>
    );
    return (
        <>
            <Heading eyebrow={label} title="Your matters." />
            <div className="row between wrap">{rangeTabs}</div>
            <div className="metrics">
                <Metric label="Billable value" value={money(total)} detail={`${duration(billable)} billable across ${open.filter((r) => r.stats.tracked > 0).length} matters`} />
                <Metric label="Open matters" value={String(open.length)} detail={archived.length ? `${archived.length} archived` : "Made when you keep time on a matter"} />
                <Metric label="No matter" value={duration(none.tracked)} detail={none.entries.length ? `${none.entries.length} ${none.entries.length === 1 ? "entry" : "entries"} kept without one` : "Everything kept is on a matter"} />
            </div>
            <Panel>
                <div className="matter-row head eyebrow" aria-hidden="true"><span /><span>Matter</span><span>Tracked</span><span>Billable</span><span>Value</span><span>Review</span></div>
                {open.length === 0 && <Empty title="No matters yet." detail="Keep time from the Activity inbox with a matter named, and the matter appears here with its time and rate." />}
                {open.map(row)}
                {none.entries.length > 0 && (
                    <button type="button" className="matter-row" onClick={() => setSelected("none")}>
                        <span className="app-icon muted" aria-hidden="true">·</span>
                        <span className="matter-name"><span className="small strong muted">No matter</span><span className="muted tiny">Kept without a matter</span></span>
                        <span className="mono small">{duration(none.tracked)}</span>
                        <span className="mono small">{duration(none.billable)}</span>
                        <span className="mono small">{money(none.value)}</span>
                        <span />
                    </button>
                )}
                {archived.length > 0 && <button type="button" className="link" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "▾" : "▸"} {archived.length} archived</button>}
                {showArchived && archived.map(row)}
            </Panel>
        </>
    );
}

function MatterDetail({ w, project: p, stats, waiting, label, rangeTabs, now, onBack, onReview }: { w: Workspace; project: Project | null; stats: MatterStats; waiting: MatterGroup[]; label: string; rangeTabs: ReactNode; now: number; onBack: () => void; onReview: () => void }): ReactNode {
    const [name, setName] = useState(p?.name ?? "");
    const [client, setClient] = useState(p?.client ?? "");
    const [rate, setRate] = useState(p ? String(p.hourlyRate) : "");
    const [into, setInto] = useState("");
    const changed = !!p && (name !== p.name || client !== p.client || Number(rate) !== p.hourlyRate);
    const others = w.projects.filter((x) => p && x.id !== p.id && !x.archived).sort((a, b) => a.name.localeCompare(b.name));
    const days = new Map<string, TimeEntry[]>();
    for (const e of stats.entries) { const k = dayKey(Date.parse(e.startedAt)); if (!days.has(k)) days.set(k, []); days.get(k)!.push(e); }
    const save = (): void => { if (p) void window.lawdie.updateProject(p.id, { name, client, hourlyRate: Number(rate) }); };
    return (
        <>
            <button type="button" className="link back" onClick={onBack}>‹ All matters</button>
            <Heading eyebrow={p ? `${p.client || "No client"}${p.archived ? " · archived" : ""}` : "Kept without a matter"} title={p?.name ?? "No matter"} />
            <div className="row between wrap">{rangeTabs}<span className="eyebrow">{label}</span></div>
            <div className="metrics">
                <Metric label="Tracked" value={duration(stats.tracked)} detail={`${stats.entries.length} ${stats.entries.length === 1 ? "entry" : "entries"}`} />
                <Metric label="Billable" value={duration(stats.billable)} detail={stats.tracked ? `${Math.round((stats.billable / stats.tracked) * 100)}% of tracked` : "Nothing kept in this range"} />
                <Metric label="Value" value={money(stats.value)} detail="At the rate each entry was kept at" />
            </div>
            {p?.insight && (
                <Panel>
                    <div className="row between">
                        <strong className="insight-title"><span aria-hidden="true">✦</span> AI insight</strong>
                        <span className="eyebrow">{p.insight.source === "sample" ? "Sample, not generated from your data" : `Kiwi · ${ago(p.insight.generatedAt, now)}`}</span>
                    </div>
                    <p className="insight-summary">{p.insight.summary}</p>
                    {p.insight.points.length > 0 && <ul className="insight-points">{p.insight.points.map((x, n) => <li key={n}>{x}</li>)}</ul>}
                </Panel>
            )}
            {p && (
                <Panel>
                    <strong>Details</strong>
                    <form className="row gap wrap matter-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
                        <label className="field grow"><span className="eyebrow">Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
                        <label className="field grow"><span className="eyebrow">Client</span><input value={client} placeholder="Who it is billed to" onChange={(e) => setClient(e.target.value)} /></label>
                        <label className="field rate"><span className="eyebrow">Hourly rate</span><input type="number" min="0" step="5" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
                        <button type="submit" className="primary" disabled={!changed || !name.trim() || !(Number(rate) >= 0)}>Save</button>
                    </form>
                    <p className="muted tiny">A new rate applies to time you keep from now on; entries already kept keep the rate they were saved with. Renaming carries activity named after this matter along with it.</p>
                    <div className="row gap wrap">
                        {others.length > 0 && (
                            <>
                                <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="Merge into">
                                    <option value="">Merge into another matter…</option>
                                    {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                                </select>
                                <button type="button" className="quiet" disabled={!into} onClick={() => { const target = others.find((x) => x.id === into); if (target && confirm(`Merge “${p.name}” into “${target.name}”? Its entries move there and “${p.name}” is removed. Times and rates are not changed.`)) void window.lawdie.mergeProjects(p.id, target.id).then((ok) => { if (ok) onBack(); }); }}>Merge</button>
                            </>
                        )}
                        <span className="grow" />
                        <button type="button" className="quiet" onClick={() => void window.lawdie.archiveProject(p.id, !p.archived)}>{p.archived ? "Restore matter" : "Archive matter"}</button>
                    </div>
                </Panel>
            )}
            {waiting.length > 0 && (
                <Panel>
                    <div className="row between"><strong>Waiting in review</strong><button type="button" className="quiet" onClick={onReview}>Review in Activity</button></div>
                    {waiting.map((g) => (
                        <div className="entry" key={g.id}>
                            <span className="bar pending" />
                            <div className="grow">
                                <div className="small strong">{g.documents.slice(0, 3).map((d) => d.name).join("; ")}</div>
                                <div className="muted tiny">{g.apps.join(", ")} · {dayLabel(g.startedAt, new Date(now))} {clock(g.startedAt)}–{clock(g.endedAt)} · {g.sittings} {g.sittings === 1 ? "sitting" : "sittings"}</div>
                            </div>
                            <span className="mono">{duration(g.seconds)}</span>
                        </div>
                    ))}
                </Panel>
            )}
            <Panel>
                <div className="row between"><strong>Kept time</strong><span className="eyebrow">{label}</span></div>
                {stats.entries.length === 0 ? <Empty title="Nothing kept in this range." detail="Pick a longer range above, or keep this matter's time from the Activity inbox." /> : [...days.entries()].map(([k, list]) => (
                    <div key={k}>
                        <div className="row between day-head">
                            <span className="eyebrow">{dayLabel(list[0].startedAt, new Date(now))}</span>
                            <span className="muted tiny mono">{duration(list.reduce((n, e) => n + entrySeconds(e), 0))}</span>
                        </div>
                        {list.map((e) => <EntryRow key={e.id} entry={e} w={w} />)}
                    </div>
                ))}
            </Panel>
        </>
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
    const [screen, setScreen] = useState<{ supported: boolean; trusted: boolean; error: string | null } | null>(null);
    useEffect(() => {
        if (!p.captureScreenText) return undefined;
        const ask = () => void window.lawdie.screenTextStatus().then(setScreen);
        ask();
        const t = setInterval(ask, 5_000);
        return () => clearInterval(t);
    }, [p.captureScreenText]);
    const [atLogin, setAtLogin] = useState(false);
    useEffect(() => { void window.lawdie.openAtLogin().then(setAtLogin); }, []);
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
            <Heading eyebrow="On your terms" title="Your time. Your boundaries." />
            <Panel>
                <strong>Desktop capture</strong>
                <Setting title="Capture app activity" detail="Records the foreground app and duration across your desktop. Start and stop at any time. Browsers are left to the Lawdie browser extension, so web time is never counted twice.">
                    <Toggle on={p.captureEnabled} onChange={(v) => void window.lawdie.setCapture(v)} label="Capture app activity" />
                </Setting>
                <Setting title="Start at login" detail={`Opens Time Capture in the ${isMac ? "menu bar" : "tray"} when you sign in to this ${label}, so capture carries on without you opening the app. If you paused capture, it stays paused.`}>
                    <Toggle on={atLogin} onChange={(v) => void window.lawdie.setOpenAtLogin(v).then(setAtLogin)} label="Start at login" />
                </Setting>
                <Setting title="Include window titles" detail={isMac ? "Optional context such as document names. Titles may contain sensitive information. macOS asks for Screen Recording permission the first time." : "Optional context such as document names. Titles may contain sensitive information."}>
                    <Toggle on={p.captureTitles} onChange={(v) => set("captureTitles", v)} label="Include window titles" />
                </Setting>
                <Setting title="Read Office document details" detail={`For Word, Excel, PowerPoint and Outlook: the open document's name, where it is saved, and its first few lines (Outlook: the sender and subject). Kiwi or Lawdie CRM uses these to match your time to a matter. ${isMac ? "macOS asks once whether Time Capture may control each app." : state.platform === "win32" ? "Nothing to grant on Windows." : "Not available on Linux."}`}>
                    <Toggle on={p.captureDocuments} onChange={(v) => set("captureDocuments", v)} label="Read Office document details" />
                </Setting>
                {p.captureDocuments && office && !office.supported && <p className="muted tiny">Not available on this platform.</p>}
                <Setting title="Read on-screen text" detail={`For apps other than Office and browsers, such as Acrobat, Teams or your practice software: some of the text the window in front shows, read through ${isMac ? "macOS Accessibility" : "Windows UI Automation"}, the channel screen readers use. No screenshots. Password fields are never read, at most ${SCREEN_TEXT_MAX} characters are kept per stretch on this ${label}, and they reach Kiwi only to name the matter when matter suggestions are on. ${isMac ? "macOS asks once for Accessibility permission." : state.platform === "win32" ? "Nothing to grant on Windows." : "Not available on Linux."}`}>
                    <Toggle on={p.captureScreenText} onChange={(v) => set("captureScreenText", v)} label="Read on-screen text" />
                </Setting>
                {p.captureScreenText && screen && !screen.supported && <p className="muted tiny">Not available on this platform.</p>}
                {p.captureScreenText && screen?.supported && !screen.trusted && (
                    <p className="danger tiny">macOS has not allowed Lawdie Time Capture to use Accessibility yet. <button type="button" className="link" onClick={() => void window.lawdie.openAccessibilitySettings()}>Open Privacy &amp; Security → Accessibility</button> and switch it on, then quit and reopen the app.</p>
                )}
                {p.captureScreenText && screen?.error && <p className="danger tiny">The last read failed: {screen.error}</p>}
                {p.captureDocuments && office && Object.entries(office.errors).map(([app, message]) => (
                    <p key={app} className="danger tiny">{{ word: "Word", excel: "Excel", powerpoint: "PowerPoint", outlook: "Outlook" }[app] ?? app} did not answer: {message}</p>
                ))}
                <Setting title="AI suggestions" detail="Kiwi's AI names the matter of your finished, unreviewed activity (so the inbox shows a matter's day across every app as one row), drafts a billing description for each row, and writes an insight on each matter's page. It sees titles, Office document details and on-screen text with personal details already removed, and your kept entries' descriptions and times. The activity in progress is never sent. Needs this computer connected to Kiwi below. Off until you switch it on.">
                    <Toggle on={p.suggestMatters} onChange={(v) => set("suggestMatters", v)} label="AI suggestions" />
                </Setting>
                {p.suggestMatters && !w.sync?.targets.some((t) => t.product === "kiwi") && <p className="danger tiny">Connect this {label} to Kiwi below to get AI suggestions.</p>}
                <Setting title="Timer idle timeout" detail="Stops a running timer at your last input after this much inactivity. Capture counts the app in front for as long as it is in front, and a call even behind other windows.">
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
                <p className="muted small">No telemetry, screenshots, keystroke recording, or local network service. Nothing leaves this {label} unless you connect Kiwi or Lawdie CRM below, and then only captured activity and your time entries, or switch on matter suggestions above, and then only what Kiwi needs to name the matter. Data is a local file protected by your account permissions; it is not separately encrypted.</p>
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
                        <p className="muted tiny">What syncs: captured activity (app names, durations, and window titles and Office document details if you switched them on) and the time entries you keep. {product} matches a stretch to a matter only when its title or document names exactly one, never from your local project label.{w.sync.targets.some((t) => t.product === "kiwi") ? " In Kiwi, billable kept entries become drafts on the Time page for you to approve, under “No matter” when nothing matched; deleting an entry here dismisses its draft there." : ""}{w.sync.targets.some((t) => t.product === "crm") ? " In Lawdie CRM, a kept entry with a matter lands on the ledger at the next sync and one without waits on its Time page for you to name the matter; deleting an entry here removes it there unless it has been billed." : ""}</p>
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

function Heading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }): ReactNode {
    return <div className="heading"><p className="eyebrow">{eyebrow}</p><h2 className="display">{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>;
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
