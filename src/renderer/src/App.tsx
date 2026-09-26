import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppState } from "@shared/state";
import type { Activity, TimeEntry, Workspace } from "@shared/model";
import { DEFAULT_SERVER_URL } from "@shared/kiwi";
import { ago, clock, dayLabel, duration } from "@shared/format";
import wordmark from "../../../resources/brand/lawdie-wordmark.png";

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
    const pending = w.activities.filter((a) => a.disposition === "pending").length;

    return (
        <div className="shell">
            <aside className="sidebar">
                <div className="brand">
                    <img src={wordmark} alt="Lawdie" className="wordmark" draggable={false} />
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
                    <p className="muted small">{connected ? "Kept time syncs to Kiwi." : "Your time. On your machine."}</p>
                    <button type="button" className="quiet" disabled={state.loadFailed} onClick={() => void window.lawdie.setCapture(!w.preferences.captureEnabled)}>
                        {w.preferences.captureEnabled ? "Pause capture" : "Enable capture"}
                    </button>
                </div>
                <div className="account">
                    <span className="avatar">L</span>
                    <div><strong className="small">Personal workspace</strong><p className="muted tiny">{w.sync?.accountEmail ?? (connected ? "Synced to Kiwi" : "Local • No account needed")}</p></div>
                </div>
            </aside>
            <main className="content">
                <header className="topbar">
                    <span className="muted">Workspace</span><span className="muted">›</span><span>{ROUTES.find((r) => r.key === route)?.label}</span>
                    <span className="grow" />
                    <span className={"muted" + (w.sync?.lastError ? " danger" : "")}>{statusLine(state, now)}</span>
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
    if (state.syncing) return "Syncing to Kiwi…";
    if (sync.lastError) return `Kiwi sync failed · ${sync.lastError.slice(0, 60)}`;
    if (!sync.lastSyncedAt) return "Connected to Kiwi · not synced yet";
    return `Synced to Kiwi · ${ago(sync.lastSyncedAt, now)}`;
}

// ---------------------------------------------------------------------------

function Today({ w, now }: { w: Workspace; now: number }): ReactNode {
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const start = dayStart.getTime(), end = start + 86_400_000;
    const entries = w.entries.filter((e) => Date.parse(e.startedAt) < end && Date.parse(e.endedAt) > start).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const tracked = entries.reduce((s, e) => s + (Math.min(Date.parse(e.endedAt), end) - Math.max(Date.parse(e.startedAt), start)) / 1000, 0);
    const billable = entries.filter((e) => e.billable).reduce((s, e) => s + (Math.min(Date.parse(e.endedAt), end) - Math.max(Date.parse(e.startedAt), start)) / 1000, 0);
    const pending = w.activities.filter((a) => a.disposition === "pending").length;
    return (
        <>
            <Heading eyebrow={new Date(now).toLocaleDateString([], { weekday: "long" })} title="Your day, accounted for." subtitle="Track your work across matters, documents, and desktop apps." />
            <div className="metrics">
                <Metric label="Tracked today" value={duration(tracked)} detail={`${entries.length} saved entries`} />
                <Metric label="Billable time" value={duration(billable)} detail="Ready for your next invoice" />
                <Metric label="To review" value={String(pending)} detail="Captured desktop activities" />
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
                <div className="muted tiny">{p?.name ?? "No project"} · {clock(entry.startedAt)}{entry.billable ? " · billable" : ""}</div>
            </div>
            <span className="mono">{duration((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000)}</span>
            <button type="button" className="icon" aria-label="Delete entry" title="Delete entry" onClick={() => { if (confirm(`Delete “${entry.description}”?`)) void window.lawdie.deleteEntry(entry.id); }}>×</button>
        </div>
    );
}

// ---------------------------------------------------------------------------

function ActivityView({ w, state }: { w: Workspace; state: AppState }): ReactNode {
    const [filter, setFilter] = useState<"pending" | "kept" | "dismissed" | "all">("pending");
    const [reviewing, setReviewing] = useState<Activity | null>(null);
    const list = useMemo(() => w.activities.filter((a) => filter === "all" || a.disposition === filter).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [w.activities, filter]);
    const current = w.currentActivity;
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
                        <p className="muted small">{current ? `Currently in ${current.app} · ${duration((Date.now() - Date.parse(current.startedAt)) / 1000)}` : "App names and durations only by default. No screenshots, keystrokes, or page content."}</p>
                    </div>
                </div>
            </Panel>
            <div className="row between">
                <div className="segmented" role="tablist">
                    {(["pending", "kept", "dismissed", "all"] as const).map((f) => <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{{ pending: "To review", kept: "Kept", dismissed: "Dismissed", all: "All activity" }[f]}</button>)}
                </div>
                <span className="muted small">{list.length} activities · retained {w.preferences.retentionDays} days</span>
            </div>
            <Panel>
                {list.length === 0 ? (
                    <Empty title={filter === "pending" ? "You're all caught up." : "No activities here yet."} detail="Enable capture, then work in another app. Activity appears here when you switch apps, go idle, or pause capture." />
                ) : list.map((a) => (
                    <div className="activity" key={a.id}>
                        <span className="app-icon">▭</span>
                        <div className="grow">
                            <div className="small strong">{a.title || a.app}</div>
                            <div className="muted tiny">{a.app} · {dayLabel(a.startedAt)} {clock(a.startedAt)} · {a.endedBy}</div>
                        </div>
                        <span className="mono">{duration((Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000)}</span>
                        {a.disposition === "pending" ? (
                            <>
                                <button type="button" className="quiet" onClick={() => void window.lawdie.dismissActivity(a.id)}>Dismiss</button>
                                <button type="button" className="primary" onClick={() => setReviewing(a)}>Keep time</button>
                            </>
                        ) : <span className={"muted small status " + a.disposition}>{a.disposition === "kept" ? "Kept" : "Dismissed"}</span>}
                    </div>
                ))}
            </Panel>
            {reviewing && <KeepSheet activity={reviewing} onClose={() => setReviewing(null)} />}
        </>
    );
}

function KeepSheet({ activity, onClose }: { activity: Activity; onClose: () => void }): ReactNode {
    const [description, setDescription] = useState(activity.title ?? `Work in ${activity.app}`);
    const [billable, setBillable] = useState(true);
    const [problem, setProblem] = useState<string | null>(null);
    const save = async (): Promise<void> => {
        if (!description.trim()) { setProblem("Add a description."); return; }
        if (await window.lawdie.keepActivity(activity.id, { description, projectID: null, billable })) onClose();
        else setProblem("That could not be saved. It may overlap time you already kept.");
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <Heading eyebrow="From desktop activity" title="Keep time" subtitle="Review this activity and choose where it belongs." />
                <label className="field"><span className="eyebrow">Description</span><input autoFocus value={description} onChange={(e) => setDescription(e.target.value)} /></label>
                <div className="row gap">
                    <div className="field"><span className="eyebrow">Start</span><span>{dayLabel(activity.startedAt)} {clock(activity.startedAt)}</span></div>
                    <div className="field"><span className="eyebrow">End</span><span>{clock(activity.endedAt)}</span></div>
                    <label className="row gap check"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
                </div>
                <p className="muted tiny">Captured times are preserved. If this overlaps tracked time, dismiss the activity instead.</p>
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <span className="mono accent big">{duration((Date.parse(activity.endedAt) - Date.parse(activity.startedAt)) / 1000)}</span>
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
    const [server, setServer] = useState(DEFAULT_SERVER_URL);
    const [token, setToken] = useState("");
    const [advanced, setAdvanced] = useState(false);
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
                <p className="muted small">No telemetry, screenshots, keystroke recording, or local network service. Nothing leaves this {label} unless you connect Kiwi below, and then only captured activity and your time entries. Data is a local file protected by your account permissions; it is not separately encrypted.</p>
                <p className="mono tiny muted">{state.workspacePath}</p>
                <div className="row gap">
                    <button type="button" className="quiet" onClick={() => void window.lawdie.showDataFolder()}>Show data folder</button>
                    <span className="grow" />
                    <button type="button" className="quiet danger" onClick={() => { if (confirm("Clear all captured desktop activity? Saved time entries are kept and capture is paused.")) void window.lawdie.clearActivity(); }}>Clear activity…</button>
                </div>
            </Panel>
            <Panel>
                <div className="row between">
                    <strong>Connect to Kiwi</strong>
                    <span className="row gap small"><span className={"dot" + (w.sync ? (w.sync.lastError ? " bad" : " on") : "")} />{w.sync ? "Connected" : "Not connected"}</span>
                </div>
                {w.sync ? (
                    <>
                        <p className="muted small">Syncing to {w.sync.serverURL} as {w.sync.accountEmail ?? "your account"}. In Kiwi this {label} is “{w.sync.deviceName}”.</p>
                        <p className={"small strong" + (w.sync.lastError ? " danger" : "")}>{statusLine(state, now)}</p>
                        {w.sync.lastError && <p className="danger tiny">{w.sync.lastError}</p>}
                        <label className="row gap check"><input type="checkbox" checked={w.sync.autoSync} onChange={(e) => void window.lawdie.setAutoSync(e.target.checked)} /> Sync automatically, about once a minute</label>
                        <div className="row gap">
                            <button type="button" className="primary" disabled={state.syncing} onClick={() => void window.lawdie.syncNow()}>{state.syncing ? "Syncing…" : "Sync now"}</button>
                            <button type="button" className="quiet" disabled={state.syncing} onClick={() => void window.lawdie.disconnectKiwi()}>Disconnect</button>
                        </div>
                        <p className="muted tiny">What syncs: captured activity (app names, durations, and window titles if you switched them on) and the time entries you keep. Kiwi never guesses a matter from them; billable entries become drafts under “No matter” on Kiwi's Time page for you to place and approve. Deleting an entry here dismisses its draft there. Lawdie CRM is not connected.</p>
                    </>
                ) : (
                    <>
                        <p className="muted small">In Kiwi, open Time → Captured activity → On your desktop and click “Connect a computer”. Paste the token it shows here; it is shown once. Until you connect, nothing leaves this {label}.</p>
                        <form className="row gap" onSubmit={(e) => { e.preventDefault(); void window.lawdie.connectKiwi(server, token).then((ok) => { if (ok) setToken(""); }); }}>
                            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ldt_… token from Kiwi" autoComplete="off" />
                            <button type="submit" className="primary" disabled={state.syncing || !token.trim()}>{state.syncing ? "Connecting…" : "Connect"}</button>
                        </form>
                        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>{advanced ? "▾" : "▸"} Kiwi server</button>
                        {advanced && <div className="row gap"><input value={server} onChange={(e) => setServer(e.target.value)} /><span className="muted tiny">Change only for a self-hosted or local Kiwi.</span></div>}
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
