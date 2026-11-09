import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppState } from "@shared/state";
import { IDLE_FLAG_SECONDS, MATTER_MAX, NOISE_SECONDS, existingMatter, descriptionOf, keptMatch, endedText, idleSeconds, PERSONAL, SCREEN_TEXT_MAX, TEXT_SIZES, screenshotTime, STRETCH_GAP_MS, clipSittings, intervals, reviewedActivities, subtractIntervals, seconds as entrySeconds, secondsWithin, stretchSpan, type Activity, type Draft, type DraftSource, type Interval, type PrivateStretch, type ClientRulebook, type KeepInput, type Project, type Stretch, type TimeEntry, type Workspace } from "@shared/model";
import { describeItem, inboxOf, knownMatters, matterStretch, toReview, type MatterGroup } from "@shared/matters";
import { DESTINATION_LABELS, PRODUCTS, destinationLabel, pairHint, productsFor, type Destination, type Product } from "@shared/kiwi";
import { ago, clock, dayLabel, duration, keepBounds, spanLabel, timeBlock, timeValue } from "@shared/format";
import { viewNow } from "@shared/demo";
import { applyFix, roundUpToTenth, splitPlan, type EntryDraft, type Fix, type PlanLine } from "@shared/rules";
import { EditSheet, EntryRules, RulesCheck, SplitLines, projectByName, rulesContext, sameDayOf } from "./Rules";
import { NarrativeEntry, PrivateRow, SUGGESTED_TIP, flaggedTip, hasNarrative } from "./Narrative";
import { AddEntryForm, ImportedPanel, TypedEntries } from "./Imported";
import { ClientRulesView } from "./ClientRules";
import { Menu, TourStepContext } from "./Menu";
import { ApplyRulesMenu, BillingMenu, BillingSettings, EntryChanges, NEW_RULEBOOK, TotalsLine, inlineNarrative } from "./Billing";
import { rulebooksOf } from "@shared/invoice";
import { applyRules, linesByEntry, type AppliedBill, type AppliedLine } from "@shared/applyRules";
import { money as dollars, shortName } from "@shared/invoice";
import wordmark from "../../../resources/brand/lawdie-wordmark.png";

import kiwiMark from "../../../resources/brand/kiwi.png";
import { Empty, Heading, Panel, Setting, Toggle } from "./ui";
import { Tour, Welcome } from "./Onboarding";
import { WhatsNew } from "./WhatsNew";
import { LATEST_RELEASE, needsWhatsNew } from "@shared/releases";
import { TOUR_STEPS, isTutorialID, needsWelcome, stepAfter, tutorialStretch } from "@shared/onboarding";

/* The window. Four screens (Time, Activity, Matters, Settings) and the Kiwi
   connection. Everything it shows is the main process's AppState; everything it does
   goes back over window.lawdie. */

type Route = "today" | "activity" | "matters" | "settings" | "rules";
const ROUTES: { key: Route; label: string; icon: string; tip: string }[] = [
    { key: "today", label: "Time", icon: "▦", tip: "Show the day's time entries and the bill." },
    { key: "activity", label: "Activity", icon: "∿", tip: "Review captured activity and keep time." },
    { key: "matters", label: "Matters", icon: "§", tip: "See kept time and value for each matter." },
    { key: "settings", label: "Settings", icon: "⚙", tip: "Change capture, privacy and sync settings." },
];

export function App(): ReactNode {
    const [state, setState] = useState<AppState | null>(null);
    const [route, setRoute] = useState<Route>("today");
    const [updateLater, setUpdateLater] = useState(false);
    const [now, setNow] = useState(Date.now());
    // The client rules page opens over Time; Back returns to the same place on Time, the same rules applied.
    const page = useRef<HTMLDivElement>(null);
    const timeScroll = useRef<number | null>(null);
    const [rulesView, setRulesView] = useState<{ book: string | null; rule: string | null }>({ book: null, rule: null });
    // Toasts: a line saying what just happened (a move, a merge), gone on its own after a few seconds.
    const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
    const notify = (text: string): void => {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t.slice(-2), { id, text }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
    };
    const openRules = (book: string | null, rule: string | null = null): void => {
        if (route === "today") timeScroll.current = page.current?.scrollTop ?? 0;
        setRulesView({ book, rule });
        setRoute("rules");
    };
    useLayoutEffect(() => {
        if (!page.current) return;
        if (route === "today" && timeScroll.current != null) { page.current.scrollTop = timeScroll.current; timeScroll.current = null; }
        else if (route === "rules") page.current.scrollTop = 0;
    }, [route]);
    // The welcome, once, on a workspace nobody has used (decided when the state first arrives, so finishing it never
    // brings it back); and the tutorial, a step index into TOUR_STEPS, which opens each step's screen itself.
    const [welcome, setWelcome] = useState(false);
    // What's new: once after an update (src/shared/releases.ts), or from Settings and the tray; dismissing marks it seen.
    const [whatsNew, setWhatsNew] = useState(false);
    const dismissWhatsNew = (): void => { setWhatsNew(false); void window.lawdie.setPreference("seenRelease", LATEST_RELEASE.id); };
    const decided = useRef(false);
    const [tour, setTour] = useState<number | null>(null);
    const [keepOpen, setKeepOpen] = useState(false);
    const startTour = (): void => { setWelcome(false); setKeepOpen(false); setTour(0); };
    const endTour = (): void => { setTour(null); setKeepOpen(false); };
    // Each step opens its screen; the rules step opens the Client rules page (the New rulebook sheet when no client has rules yet).
    useEffect(() => {
        if (tour === null) return;
        const r = TOUR_STEPS[tour].route;
        if (r === "rules") openRules(state && rulebooksOf(state.workspace).length ? null : NEW_RULEBOOK); else setRoute(r);
    }, [tour]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (tour === null) return; const n = stepAfter(TOUR_STEPS, tour, keepOpen ? "keep-open" : "keep-closed"); if (n !== null) setTour(n); }, [keepOpen]); // eslint-disable-line react-hooks/exhaustive-deps
    const sample = useMemo(() => tutorialStretch(Date.now()), [tour === null]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        void window.lawdie.getState().then(setState);
        const offState = window.lawdie.onState(setState);
        const offRoute = window.lawdie.onRoute((r) => {
            if (r === "welcome") setWelcome(true);
            else if (r === "whatsnew") setWhatsNew(true);
            else if (r === "tutorial") startTour();
            else if (r === "rules" || ROUTES.some((x) => x.key === r)) setRoute(r as Route);
        });
        const tick = setInterval(() => setNow(Date.now()), 1000);
        return () => { offState(); offRoute(); clearInterval(tick); };
    }, []);
    useEffect(() => {
        if (!state || decided.current) return;
        decided.current = true;
        if (!state.loadFailed && tour === null && needsWelcome(state.workspace)) setWelcome(true);
        else if (!state.loadFailed && tour === null && needsWhatsNew(state.workspace)) setWhatsNew(true);
    }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!state) return <div className="loading">Opening your workspace…</div>;
    const w = state.workspace;
    const finishWelcome = (takeTour: boolean): void => {
        void window.lawdie.setPreference("onboardedAt", new Date().toISOString());
        void window.lawdie.setPreference("seenRelease", LATEST_RELEASE.id); // a new person has nothing to catch up on
        setWelcome(false);
        if (takeTour) startTour();
    };
    const connected = w.sync !== null;
    const pending = toReview(w.activities); // no hook: this sits after the early return above

    return (
        <NoticeContext.Provider value={notify}>
        <TourStepContext.Provider value={tour !== null ? TOUR_STEPS[tour].id : null}>
        <div className="shell">
            <aside className="sidebar">
                <div className="brand">
                    <span className="marks"><img src={kiwiMark} alt="" className="kiwi-mark" draggable={false} /><img src={wordmark} alt="Lawdie" className="wordmark" draggable={false} /></span>
                    <h1 className="display">Time capture</h1>
                </div>
                <p className="eyebrow">Workspace</p>
                <nav data-tour="nav">
                    {ROUTES.map((r) => (
                        <button key={r.key} type="button" className={"nav" + (route === r.key || (route === "rules" && r.key === "today") ? " active" : "")} title={r.tip} onClick={() => setRoute(r.key)} aria-current={route === r.key ? "page" : undefined}>
                            <span className="nav-icon" aria-hidden="true">{r.icon}</span>
                            {r.label}
                            {r.key === "activity" && pending > 0 && <span className="badge">{pending}</span>}
                        </button>
                    ))}
                </nav>
                <div className="capture-card" data-tour="capture">
                    <div className="row"><span className={"dot" + (w.preferences.captureEnabled ? " on" : "")} /> <strong>{w.preferences.captureEnabled ? "Capture is on" : "Capture is paused"}</strong></div>
                    <p className="muted small">{connected ? `Kept time syncs to ${destinationLabel(w.sync?.targets.map((t) => t.product) ?? [])}.` : "Your time. On your machine."}</p>
                    {state.missing.screenRecording && <p className="danger small strong">Window titles are not being captured: macOS needs Screen Recording.</p>}
                    {state.missing.accessibility && <p className="danger small strong">On-screen text is not being read: macOS needs Accessibility.</p>}
                    <button type="button" className="quiet" disabled={state.loadFailed} title={w.preferences.captureEnabled ? "Stop recording app activity until you start it again." : "Start recording app activity."} onClick={() => void window.lawdie.setCapture(!w.preferences.captureEnabled)}>
                        {w.preferences.captureEnabled ? "Pause capture" : "Enable capture"}
                    </button>
                    {state.updateReady && <button type="button" className="primary" onClick={() => void window.lawdie.installUpdate()}>Install update</button>}
                </div>
                <div className="account">
                    <span className="avatar">{w.profile ? w.profile.name[0] : "L"}</span>
                    <div><strong className="small">{w.profile ? `${w.profile.name} · ${w.profile.timekeeper}` : "Personal workspace"}</strong><p className="muted tiny">{w.sync?.targets[0]?.accountEmail ?? (connected ? `Synced to ${destinationLabel(w.sync?.targets.map((t) => t.product) ?? [])}` : "Local • No account needed")}</p></div>
                </div>
            </aside>
            <main className="content">
                <header className="topbar">
                    <span className="muted">Workspace</span><span className="muted">›</span><span>{route === "rules" ? "Time › Client rules" : ROUTES.find((r) => r.key === route)?.label}</span>
                    <span className="grow" />
                    <span className={"muted" + (w.sync?.targets.some((t) => t.lastError) ? " danger" : "")}>{statusLine(state, now)}</span>
                    <span className="divider" />
                    <span className="muted">{new Date(viewNow(w, now)).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span>
                </header>
                <div className="page" ref={page}>
                    {state.error && <Banner tone="danger" onClose={() => void window.lawdie.dismissMessage()}>{state.error}</Banner>}
                    {state.notice && <Banner onClose={() => void window.lawdie.dismissMessage()}>{state.notice}</Banner>}
                    {state.missing.screenRecording && (
                        <PermissionCallout pane="screen" title={w.preferences.captureScreenshots && !w.preferences.captureTitles ? "Screenshots are not being taken" : w.preferences.captureScreenshots ? "Window titles and screenshots are not being captured" : "Window titles are not being captured"} what={w.preferences.captureTitles ? "macOS is not allowing Screen Recording for this version of Lawdie Time Capture, so your activity has app names only, without the document and email names that tell which matter it was. This often happens after an update." : "macOS is not allowing Screen Recording for this version of Lawdie Time Capture, so no screenshots are being taken. This often happens after an update."} />
                    )}
                    {state.missing.accessibility && (
                        <PermissionCallout pane="accessibility" title="On-screen text is not being read" what="macOS is not allowing Accessibility for this version of Lawdie Time Capture, so text from the window in front is not read and matters are harder to name. This often happens after an update." />
                    )}
                    {state.updateReady && !updateLater && (
                        <section className="callout" role="status">
                            <div className="grow">
                                <p className="callout-title">Version {state.updateReady} is ready to install</p>
                                <p className="muted">You are on {state.appVersion}. Installing restarts the app in a few seconds; nothing you captured is lost.{state.platform === "darwin" ? " If macOS then asks again for Screen Recording or Accessibility, allow it; this window will say so if anything is missing." : ""}</p>
                            </div>
                            <button type="button" className="quiet" onClick={() => setUpdateLater(true)}>Later</button>
                            <button type="button" className="primary" onClick={() => void window.lawdie.installUpdate()}>Install now</button>
                        </section>
                    )}
                    {state.loadFailed ? (
                        <Panel><Empty title="Your workspace needs attention" detail="Time Capture could not read the workspace. The original file is preserved." /></Panel>
                    ) : route === "today" ? <Today w={w} now={viewNow(w, now)} onRules={openRules} tutorial={tour !== null} /> : route === "rules" ? <ClientRulesView w={w} bookKey={rulesView.book} focusRule={rulesView.rule} day={dayKey(viewNow(w, now))} onBack={() => setRoute("today")} /> : route === "activity" ? <ActivityView w={w} state={state} tutorial={tour !== null ? { ...sample, onSheet: setKeepOpen } : null} /> : route === "matters" ? <MattersView w={w} now={now} onReview={() => setRoute("activity")} /> : <Settings state={state} now={now} onRules={openRules} onTour={startTour} onWelcome={() => setWelcome(true)} onWhatsNew={() => setWhatsNew(true)} />}
                </div>
            </main>
            {toasts.length > 0 && (
                <div className="toasts" role="status" aria-live="polite">
                    {toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}
                </div>
            )}
            {welcome && <Welcome state={state} onDone={finishWelcome} />}
            {!welcome && tour !== null && <Tour step={tour} onStep={setTour} onEnd={endTour} />}
            {whatsNew && !welcome && tour === null && <WhatsNew onDismiss={dismissWhatsNew} onOpen={setRoute} />}
        </div>
        </TourStepContext.Provider>
        </NoticeContext.Provider>
    );
}

/** `notify(text)`: a toast from anywhere in the window. */
const NoticeContext = createContext<(text: string) => void>(() => undefined);
const useNotify = (): ((text: string) => void) => useContext(NoticeContext);

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

function Today({ w, now, onRules, tutorial = false }: { w: Workspace; now: number; onRules: (book: string | null, rule?: string | null) => void; tutorial?: boolean }): ReactNode {
    const [range, setRange] = useState<RangeKey>("today");
    const [from, setFrom] = useState(dayKey(now - 6 * 86_400_000));
    const [to, setTo] = useState(dayKey(now));
    const { start, end, label } = rangeBounds(range, now, from, to);
    const entries = w.entries.filter((e) => Date.parse(e.startedAt) < end && Date.parse(e.endedAt) > start).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const tracked = entries.reduce((s, e) => s + secondsWithin(e, start, end), 0);
    // Billable time is what goes on the bill: kept entries, not a suggestion or a flag still waiting for Rosa.
    const billable = entries.filter((e) => e.billable && (!e.status || e.status === "draft")).reduce((s, e) => s + secondsWithin(e, start, end), 0);
    const pending = toReview(w.activities);
    const waiting = entries.filter((e) => e.status === "suggested" || e.status === "flagged").length;
    // Grouped by day, newest first; a day's figure is only what fell inside the range.
    const days = new Map<string, TimeEntry[]>();
    for (const e of entries) { const k = dayKey(Date.parse(e.startedAt)); if (!days.has(k)) days.set(k, []); days.get(k)!.push(e); }
    const byProject = new Map<string, number>();
    for (const e of entries.filter((x) => x.billable)) { const name = w.projects.find((p) => p.id === e.projectID)?.name ?? "No project"; byProject.set(name, (byProject.get(name) ?? 0) + secondsWithin(e, start, end)); }
    const projects = [...byProject.entries()].sort((a, b) => b[1] - a[1]);
    const privates = (w.privateStretches ?? []).filter((x) => Date.parse(x.startedAt) < end && Date.parse(x.endedAt) > start);
    const privatesOf = (k: string): PrivateStretch[] => privates.filter((x) => dayKey(Date.parse(x.startedAt)) === k);
    const [pdfProblem, setPdfProblem] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    // Simple entries typed on this page (Add entry) for the days in range; imported rows have their own panel.
    const typedHere = (w.imported ?? []).filter((r) => r.origin === "manual" && (() => { const t = new Date(`${r.date}T12:00:00`).getTime(); return t >= start && t < end; })());
    const imported = (w.imported ?? []).filter((r) => r.origin !== "manual");
    // The bill: the day on screen under the client's rules applied (or generic), from the one function the PDFs and the
    // DOCX print from too. Entry rows show their own lines from it whatever the range.
    const day = dayKey(now);
    const mode = w.billingClient ?? "generic";
    const dayBill = useMemo(() => applyRules(w, day, mode), [w, day, mode]);
    const allBill = useMemo(() => applyRules(w, null, mode), [w, mode]);
    const lines = useMemo(() => (dayBill.book ? linesByEntry(allBill) : null), [allBill, dayBill.book]);
    return (
        <>
            <Heading title={label} />
            <div className="row between wrap">
                <div className="segmented" role="tablist" aria-label="Range">
                    {RANGES.map((r) => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} className={range === r.key ? "active" : ""} title={`Show ${r.label.toLowerCase()}.`} onClick={() => setRange(r.key)}>{r.label}</button>)}
                </div>
                {range === "custom" && (
                    <span className="row gap small">
                        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" title="First day to show." />
                        <span className="muted">to</span>
                        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" title="Last day to show." />
                    </span>
                )}
                <span className="grow" />
                <span className="row gap">
                    <span data-tour="client-rules"><ApplyRulesMenu w={w} onRules={onRules} /></span>
                    <span data-tour="entries-menu">
                    <Menu label="Entries" tip="Add a simple entry, or bring in entries typed in another time system." tourStep="import">
                        <button type="button" role="menuitem" title="Type a short note and its hours, such as .9 call w/ client. It shows as typed until you expand it into a narrative." onClick={() => setAdding(true)}>Add entry</button>
                        <button type="button" role="menuitem" title="Import entries typed into iTimeKeep or another time system (.csv or .xlsx). Each one is matched to the work Time Capture saw." onClick={() => void window.lawdie.importEntries()}>Import entries</button>
                    </Menu>
                    </span>
                    {(w.invoice || w.billing) ? <span data-tour="billing-menu"><BillingMenu w={w} bill={dayBill} day={day} onProblem={setPdfProblem} /></span>
                        : tutorial && <span data-tour="billing-menu"><button type="button" className="quiet menu-button" disabled title="Appears once the firm is set up in Settings → Billing: an invoice or a time sheet for one matter over a period.">Billing <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button></span>}
                </span>
            </div>
            {range === "today" && (w.invoice || w.billing) && <TotalsLine bill={dayBill} onRules={onRules} />}
            {pdfProblem && <p className="danger small">{pdfProblem}</p>}
            <div className="metrics">
                <Metric label={range === "today" ? "Tracked today" : "Tracked"} value={cardTime(tracked)} detail={`${entries.length} ${entries.length === 1 ? "entry" : "entries"}`} />
                <Metric label="Billable time" value={cardTime(billable)} detail={`${tracked ? `${Math.round((billable / tracked) * 100)}% of tracked` : "No time kept yet"}${range === "today" && w.invoice && dayBill.lines.length ? ` · ${dayBill.totals.billedHours.toFixed(1)} h billed` : ""}`} />
                <Metric label="To review" value={String(pending + waiting)} detail={waiting ? `${waiting} ${waiting === 1 ? "entry" : "entries"} to confirm${pending ? `, ${pending} from desktop work` : ""}` : "Matters and stretches of desktop work"} />
            </div>
            {projects.length > 1 && (
                <Panel>
                    <div className="row between"><strong>Billable, by project</strong><span className="eyebrow">{label}</span></div>
                    {projects.map(([name, secs]) => (
                        <div className="row between small" key={name} style={{ padding: "8px 0" }}><span>{name}</span><span className="mono">{duration(secs)}</span></div>
                    ))}
                </Panel>
            )}
            {imported.length > 0 && <ImportedPanel w={w} />}
            <Panel tour="entries">
                <div className="row between">
                    <strong>{range === "today" ? "Your day, in focus" : "Entries"}</strong>
                    <span className="row gap">
                        <span className="eyebrow">{label}</span>
                        <button type="button" className="quiet" disabled={entries.length === 0} title="Project, date, hours and description of each kept entry shown here" onClick={() => void window.lawdie.exportCsv(entries.map((e) => e.id), `Lawdie time ${dayKey(start || Date.parse(entries[entries.length - 1]?.startedAt ?? new Date(now).toISOString()))} to ${dayKey(end - 1)}.csv`)}>Export CSV</button>
                    </span>
                </div>
                {adding && <AddEntryForm w={w} day={dayKey(now)} onClose={() => setAdding(false)} />}
                <TypedEntries w={w} rows={typedHere} />
                {entries.length === 0 ? (typedHere.length || adding ? null :
                    <Empty title={range === "today" ? "A fresh start" : "Nothing in this range"} detail="Enable capture, work in another app, then keep what matters from the Activity inbox. Your time will take shape here." />
                ) : [...days.entries()].map(([k, list]) => (
                    <div key={k}>
                        {range !== "today" && (
                            <div className="row between day-head">
                                <span className="eyebrow">{dayLabel(list[0].startedAt, new Date(now))}</span>
                                <span className="muted tiny mono">{duration(list.reduce((s, e) => s + secondsWithin(e, start, end), 0))} · billable {duration(list.filter((e) => e.billable).reduce((s, e) => s + secondsWithin(e, start, end), 0))}</span>
                            </div>
                        )}
                        {matterGroups(w, list).map((g) => (
                            <section className="entry-group" key={g.key}>
                                <GroupHead title={g.project?.name ?? "No matter yet"}
                                    tip={g.project ? (g.project.client ? `Billed to ${g.project.client.replace(/\.?$/, ".")}` : "No client is set for this matter.") : "Time Lawdie could not put on a matter. It is not billed until it has one."}
                                    total={duration(g.entries.reduce((s, e) => s + secondsWithin(e, start, end), 0))}
                                    totalTip={g.project ? billedTip(allBill, g.entries) : "Not billed until it has a matter."} />
                                {g.entries.map((e) => <EntryRow key={e.id} entry={e} w={w} lines={lines?.get(e.id)} book={dayBill.book} onRules={onRules} />)}
                            </section>
                        ))}
                        {privatesOf(k).length > 0 && (
                            <section className="entry-group">
                                <GroupHead title="Personal" tip="Personal time stays on this Mac. It is never billed or synced."
                                    total={duration(privatesOf(k).reduce((s, x) => s + (Date.parse(x.endedAt) - Date.parse(x.startedAt)) / 1000, 0))} totalTip="Not billed." />
                                {[...privatesOf(k)].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map((x) => <PrivateRow key={x.key} item={x} />)}
                            </section>
                        )}
                    </div>
                ))}
            </Panel>
        </>
    );
}

function EntryRow({ entry, w, lines, book = null, onRules = () => undefined }: { entry: TimeEntry; w: Workspace; lines?: AppliedLine[]; book?: ClientRulebook | null; onRules?: (book: string | null, rule?: string | null) => void }): ReactNode {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<string | null>(null);
    const narrative = hasNarrative(entry);
    const inline = narrative && entry.status !== "flagged";
    // The matter is the group's title and the time sits in the minutes' tooltip; only a matter rulebook's check stays here.
    // A sent-back entry shows the client's words under it; a flag with no matter says so in its tooltip instead.
    const sentBack = entry.status === "flagged" && entry.projectID && /^Sent back by/.test(entry.why ?? "");
    const meta = <><EntryRules w={w} entry={entry} />{sentBack && <p className="sent-back" title={entry.why}>{entry.why}</p>}</>;
    // Under a client's rules: the narrative as the rules write it, and each change with its rule chip.
    const changes = book && lines ? <EntryChanges lines={lines} book={book} w={w} onRules={onRules} /> : null;
    return (
        <div className={"entry" + (narrative ? " with-why" : "") + (entry.status === "flagged" ? " flagged" : entry.status === "suggested" ? " suggested" : "")}>
            <span className="bar" />
            <div className="grow">
                {narrative ? <NarrativeEntry entry={entry} w={w} draft={draft} setDraft={setDraft} onDetails={() => setEditing(true)} meta={meta} override={inlineNarrative(lines, book)} after={changes} />
                    : <><div className="small strong">{entry.description} <AiTag source={entry.drafted} status={entry.status} />{entry.billable === false && <span className="quiet-tag" title="Kept with the day's time. It is not billed to the client.">Not billable</span>}</div>{meta}{changes}</>}
                <Shots names={entry.screenshots} />
            </div>
            {entry.status === "suggested" && <button type="button" className="fix" title={SUGGESTED_TIP} onClick={() => void window.lawdie.editEntry(entry.id, { confirm: true })}>Confirm</button>}
            {entry.status === "flagged" && <button type="button" className="fix" title={flaggedTip(entry)} onClick={() => setEditing(true)}>{entry.projectID ? "Fix and confirm" : "Assign and edit"}</button>}
            <span className="mono" title={timeBlock(entry)}>{duration(entrySeconds(entry))}</span>
            <button type="button" className="quiet" disabled={draft !== null} title={inline ? "Edit this narrative here, in the row." : "Change this entry's narrative, matter, hours, codes or rate."} onClick={() => (inline ? setDraft(entry.description) : setEditing(true))}>Edit</button>
            <button type="button" className="icon" aria-label="Delete entry" title="Delete this entry; its activity goes back to review." onClick={() => { if (confirm(`Delete “${entry.description}”?`)) void window.lawdie.deleteEntry(entry.id); }}>×</button>
            {editing && <EditSheet w={w} entry={entry} onClose={() => setEditing(false)} />}
        </div>
    );
}

/** A day's entries by matter, in the list's order: each matter in the order its newest entry appears, then
 *  "No matter yet". Inside a group the entries keep their order. */
function matterGroups(w: Workspace, list: readonly TimeEntry[]): { key: string; project: Project | null; entries: TimeEntry[] }[] {
    const groups = new Map<string, { key: string; project: Project | null; entries: TimeEntry[] }>();
    for (const e of list) {
        const project = w.projects.find((p) => p.id === e.projectID) ?? null;
        const key = project?.id ?? "none";
        if (!groups.has(key)) groups.set(key, { key, project, entries: [] });
        groups.get(key)!.entries.push(e);
    }
    return [...groups.values()].sort((a, b) => Number(!a.project) - Number(!b.project));
}

/** "4.4 h billed under Northlake rules": the group's billed hours in the bill on screen (no-charge lines left out). */
function billedTip(bill: AppliedBill, entries: readonly TimeEntry[]): string {
    const ids = new Set(entries.map((e) => e.id));
    const hours = bill.lines.filter((l) => ids.has(l.entryId) && !l.noCharge).reduce((n, l) => n + l.hours, 0);
    return `${hours.toFixed(1)} h billed ${bill.book ? `under ${shortName(bill.book)} rules` : "at standard rates"}.`;
}

/** A matter's title over its entries, with the group's time on the right. */
function GroupHead({ title, tip, total, totalTip }: { title: string; tip: string; total: string; totalTip: string }): ReactNode {
    return (
        <div className="group-head">
            <span className="group-title" title={tip}>{title}</span>
            <span className="group-total mono" title={totalTip}>{total}</span>
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

/** The tutorial's sample stretch (src/shared/onboarding.ts) while it runs: a row in To review that opens the real Keep sheet and saves nothing. */
type Tutorial = { stretch: Stretch; sittings: Activity[]; onSheet: (open: boolean) => void };

function ActivityView({ w, state, tutorial = null }: { w: Workspace; state: AppState; tutorial?: Tutorial | null }): ReactNode {
    const [filter, setFilter] = useState<"pending" | "kept" | "dismissed" | "all">("pending");
    const [sort, setSort] = useState<SortBy>("newest");
    const [reviewing, setReviewing] = useState<{ stretch: Stretch; matter: string | null; description: string } | null>(null);
    const notify = useNotify();
    // The sample's sheet: the tutorial follows it opening and closing; ending the tutorial closes it.
    const sampleOpen = !!reviewing && isTutorialID(reviewing.stretch.id);
    useEffect(() => { tutorial?.onSheet(sampleOpen); }, [sampleOpen]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (!tutorial && sampleOpen) setReviewing(null); }, [tutorial, sampleOpen]);
    const tourStep = useContext(TourStepContext);
    const keepSample = async (): Promise<boolean> => { notify("That was the tutorial's sample: nothing was saved. A real stretch becomes an entry on the Time screen."); return true; };
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const toggle = (id: string): void => setOpen((o) => ({ ...o, [id]: !o[id] }));
    const { groups, stretches, short, personal } = useMemo(() => inboxOf(w.activities), [w.activities]);
    // Time moved onto a matter lands inside that matter's row: the row unfolds so the move can be seen.
    const [moved, setMoved] = useState<string | null>(null);
    useEffect(() => {
        if (!moved) return;
        const g = groups.find((x) => x.activityIDs.includes(moved));
        if (g) { setOpen((o) => ({ ...o, [g.id]: true })); setMoved(null); }
    }, [groups, moved]);
    const onMoved = (ids: string[]): void => setMoved(ids[0] ?? null);
    // Opening the inbox freshens it; the main process skips this when it ran in the last ten minutes.
    useEffect(() => { if (w.preferences.suggestMatters) void window.lawdie.suggestMatters(); }, [w.preferences.suggestMatters]);
    // Matters and stretches are one list, so the newest work is on top whether or not it has a matter yet.
    const pendingRows = useMemo(() => sortBy([...groups.map((g) => ({ group: g })), ...stretches.map((st) => ({ stretch: st }))], sort,
        (r) => "group" in r ? { at: r.group.endedAt, seconds: r.group.seconds, name: r.group.matter } : { at: r.stretch.endedAt, seconds: r.stretch.seconds, name: r.stretch.name }), [groups, stretches, sort]);
    /** Each review row that looks like more of a kept entry (by its first activity), and each such entry's waiting rows. */
    const { matches, waiting } = useMemo(() => {
        const matches = new Map<string, TimeEntry>(), waiting = new Map<string, string[][]>();
        for (const ids of pendingRows.map((r) => ("group" in r ? r.group.activityIDs : r.stretch.activityIDs))) {
            const m = keptMatch(w, ids);
            if (!m) continue;
            matches.set(ids[0], m);
            waiting.set(m.id, [...(waiting.get(m.id) ?? []), ids]);
        }
        return { matches, waiting };
    }, [w, pendingRows]);
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
                <Heading title="Activity" />
                <button type="button" className="primary" disabled={state.loadFailed} title={w.preferences.captureEnabled ? "Stop recording app activity until you start it again." : "Start recording app activity."} onClick={() => void window.lawdie.setCapture(!w.preferences.captureEnabled)}>{w.preferences.captureEnabled ? "Pause capture" : "Enable capture"}</button>
            </div>
            <Panel tour="capture-status">
                <div className="row gap">
                    <span className="big-icon">{w.preferences.captureEnabled ? "∿" : "‖"}</span>
                    <div className="grow">
                        <strong>{w.preferences.captureEnabled ? "Desktop capture is active" : "Capture is paused"}</strong>
                        <p className="muted small">{current ? `Currently in ${current.app} · ${duration((Date.now() - Date.parse(current.startedAt)) / 1000)}` : w.preferences.captureScreenshots ? "App names and durations, and a screenshot of the window you work in now and then, kept on this computer only. No keystrokes; browsers are left to the browser extension." : w.preferences.captureScreenText ? "App names and durations, and some on-screen text from the apps you work in. No screenshots or keystrokes; browsers are left to the browser extension." : "App names and durations only by default. No screenshots, keystrokes, or page contents."}</p>
                    </div>
                </div>
            </Panel>
            {w.preferences.suggestMatters && (
                <div className="row gap small matter-status">
                    <span className={"dot" + (state.matters.error ? " bad" : state.matters.running ? " on" : "")} />
                    <span className={"grow" + (state.matters.error ? " danger" : " muted")}>{state.matters.running ? "Kiwi's AI is naming matters and drafting descriptions…" : state.matters.error ?? "Kiwi's AI names each stretch of work's matter and drafts its description. Correct either when you keep the time and later suggestions follow you."}</span>
                    <button type="button" className="quiet" disabled={state.matters.running} title={state.matters.running ? "Kiwi is working on the suggestions now." : "Ask Kiwi's AI to name matters and draft descriptions now."} onClick={() => void window.lawdie.suggestMatters(true)}>Suggest now</button>
                </div>
            )}
            <div className="row between">
                <div className="segmented" role="tablist">
                    {(["pending", "kept", "dismissed", "all"] as const).map((f) => <button key={f} type="button" role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} title={{ pending: "Show the activity you have not reviewed yet.", kept: "Show the time you kept.", dismissed: "Show the activity you dismissed.", all: "Show every captured sitting." }[f]} onClick={() => setFilter(f)}>{{ pending: "To review", kept: "Kept", dismissed: "Dismissed", all: "All" }[f]}</button>)}
                </div>
                <div className="row gap">
                    <span className="muted small">{count} · retained {w.preferences.retentionDays} days</span>
                    <select value={sort} onChange={(e) => setSort(e.target.value as SortBy)} aria-label="Sort" title="Change the order of the list.">{(Object.keys(SORTS) as SortBy[]).map((k) => <option key={k} value={k}>{SORTS[k]}</option>)}</select>
                </div>
            </div>
            <Panel>
                {filter === "pending" ? (
                    <>
                        {tutorial && <SampleRow tutorial={tutorial} open={!!open[tutorial.stretch.id] || tourStep === "row"} onToggle={() => toggle(tutorial.stretch.id)} notify={notify} onKeep={() => setReviewing({ stretch: tutorial.stretch, matter: tutorial.sittings[0].matter ?? null, description: tutorial.stretch.draft?.text ?? tutorial.stretch.name })} />}
                        {!tutorial && groups.length === 0 && stretches.length === 0 && short.length === 0 && personal.length === 0 && (
                            <Empty title="You're all caught up." detail="Enable capture, then work in another app. A stretch of work appears here when you switch apps, lock or sleep the computer, or pause capture." />
                        )}
                        {pendingRows.map((r) => "group" in r ? (
                            <MatterRow key={r.group.id} w={w} onMoved={onMoved} group={r.group} match={matches.get(r.group.activityIDs[0]) ?? null} merged={r.group.activityIDs.some((id) => byID.get(id)?.mergeKey)} described={descriptionOf(r.group.activityIDs.map((id) => byID.get(id)))} idle={idleSeconds(r.group.activityIDs.map((id) => byID.get(id) ?? {}))} shots={r.group.activityIDs.flatMap((id) => byID.get(id)?.screenshots ?? [])} open={!!open[r.group.id]} onToggle={() => toggle(r.group.id)}
                                onKeep={() => setReviewing({ stretch: matterStretch(r.group), matter: r.group.matter, description: descriptionOf(r.group.activityIDs.map((id) => byID.get(id)))?.text ?? r.group.documents.slice(0, 3).map((d) => d.name).join("; ") })} />
                        ) : ((st, own) => (
                            <div key={st.id}>
                                <div className="activity">
                                    <span className="app-icon">▭</span>
                                    <div className="grow">
                                        <Editable initial={own?.text ?? st.name} onSave={(text) => void window.lawdie.describeActivities(st.activityIDs, text)}>
                                            <div className="small strong">{own?.by === "person" ? own.text : st.name}</div>
                                        </Editable>
                                        {st.draft && own?.by !== "person" && <DraftLine draft={st.draft} />}
                                        <Shots names={st.activityIDs.flatMap((id) => byID.get(id)?.screenshots ?? [])} />
                                        <div className="muted tiny meta">
                                            <span><MatterLabel name={null} /> · {st.app} · {dayLabel(st.startedAt)} {st.sittings > 1 ? spanLabel(st.startedAt, st.endedAt, st.sittings) : `${clock(st.startedAt)} · ${endedText(st, w.activities)}`}{meetingWith(byID.get(st.activityIDs[0]))}{own?.by === "person" && st.name !== own.text ? ` · ${st.name}` : ""}{st.document?.path ? ` · ${st.document.path}` : ""}<IdleTag seconds={idleSeconds(st.activityIDs.map((id) => byID.get(id) ?? {}))} /></span>
                                            {st.sittings > 1 && <SittingsToggle label={`${st.sittings} sittings`} open={!!open[st.id]} onClick={() => toggle(st.id)} />}
                                        </div>
                                        <MergeLine match={matches.get(st.activityIDs[0]) ?? null} merged={st.activityIDs.some((id) => byID.get(id)?.mergeKey)} />
                                    </div>
                                    <span className="mono">{duration(st.seconds)}</span>
                                    <MatterMenu w={w} ids={st.activityIDs} current={null} what={own?.text ?? st.name} onMoved={onMoved} />
                                    {matches.get(st.activityIDs[0]) ? <MergeButtons ids={st.activityIDs} match={matches.get(st.activityIDs[0])!} /> : <>
                                        <button type="button" className="quiet" title="Not work: kept out of billing and never synced" onClick={() => void window.lawdie.setMatter(st.activityIDs, PERSONAL)}>Personal</button>
                                        <button type="button" className="quiet" title="Take this stretch out of review without keeping time." onClick={() => void window.lawdie.dismissActivity(st.activityIDs)}>Dismiss</button>
                                        <button type="button" className="primary" title="Check this stretch and save it as a time entry." onClick={() => setReviewing({ stretch: st, matter: null, description: own?.text ?? st.document?.name ?? st.name })}>Keep time</button>
                                    </>}
                                </div>
                                {open[st.id] && st.sittings > 1 && (
                                    <Sittings all={w.activities} items={st.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a)} onDismiss={st.sittings > 1 ? (id) => void window.lawdie.dismissActivity(id) : undefined} />
                                )}
                            </div>
                        ))(r.stretch, descriptionOf(r.stretch.activityIDs.map((id) => byID.get(id)))))}
                        {personal.length > 0 && <PersonalRow groups={personal} open={!!open.personal} onToggle={() => toggle("personal")} />}
                        {short.length > 0 && (
                            <div className="activity">
                                <span className="app-icon muted">·</span>
                                <div className="grow">
                                    <div className="small strong">{short.length} brief {short.length === 1 ? "touch" : "touches"}</div>
                                    <div className="muted tiny">Under {NOISE_SECONDS} seconds each, on a matter or not: app hops and glances, not billable time. Sittings on one document within {gapMinutes} minutes are already grouped above.</div>
                                </div>
                                <span className="mono">{duration(shortSeconds)}</span>
                                <button type="button" className="quiet" title="Take all the short switches out of review." onClick={() => void window.lawdie.dismissActivity(short.flatMap((st) => st.activityIDs))}>Dismiss all</button>
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
                                        <Shots names={e.screenshots} />
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
                                {waiting.get(e.id) && <NewSince rows={waiting.get(e.id)!} entryID={e.id} byID={byID} />}
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
                            <div className="muted tiny"><MatterLabel name={a.matter} /> · {a.app} · {dayLabel(a.startedAt)} {clock(a.startedAt)} · {endedText(a, w.activities)}{a.document?.path ? ` · ${a.document.path}` : ""}<IdleTag seconds={idleSeconds([a])} /></div>
                            <Shots names={a.screenshots} />
                            {(a.screenText || a.document?.excerpt) && <div className="tiny screen-text" title="What was read from the window">{(a.screenText ?? a.document?.excerpt ?? "").replace(/\n/g, " · ").slice(0, 220)}</div>}
                        </div>
                        <span className="mono">{duration((Date.parse(a.endedAt) - Date.parse(a.startedAt)) / 1000)}</span>
                        <span className={"muted small status " + a.disposition}>{a.disposition === "kept" ? "Kept" : a.disposition === "dismissed" ? "Dismissed" : "To review"}</span>
                    </div>
                ))}
            </Panel>
            {reviewing && <KeepSheet key={reviewing.stretch.id} w={w} stretch={reviewing.stretch} matter={reviewing.matter} initialDescription={reviewing.description} projects={w.projects.filter((p) => !p.archived).map((p) => p.name)} sittings={sampleOpen && tutorial ? tutorial.sittings : reviewing.stretch.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a)} keep={sampleOpen ? keepSample : undefined} onClose={() => setReviewing(null)} />}
        </>
    );
}

/**
 * The tutorial's sample stretch, laid out like a matter's row so the tutorial can point at its parts.
 * Its buttons say what the real ones do; only Keep time opens anything, and that sheet saves nothing.
 */
function SampleRow({ tutorial: { stretch: st, sittings }, open, onToggle, notify, onKeep }: { tutorial: Tutorial; open: boolean; onToggle: () => void; notify: (text: string) => void; onKeep: () => void }): ReactNode {
    const idle = idleSeconds(sittings);
    const explain = (what: string): void => notify(`On a real row, ${what}. This sample row stays until the tutorial ends.`);
    return (
        <div data-tour="review-row">
            <div className="activity">
                <span className="app-icon matter-icon" aria-hidden="true">§</span>
                <div className="grow">
                    <div className="small strong">{sittings[0].matter} <span className="sample-tag" title="A sample the tutorial shows. It is not in your workspace and nothing done to it is saved.">Sample</span></div>
                    {st.draft && <DraftLine draft={st.draft} />}
                    <div className="muted tiny meta">
                        <span>{st.app} · {dayLabel(st.startedAt)} {spanLabel(st.startedAt, st.endedAt, st.sittings)} · {st.sittings} sittings<IdleTag seconds={idle} /></span>
                        <SittingsToggle label="1 item" open={open} what="the documents in this matter" onClick={onToggle} />
                    </div>
                </div>
                <span className="mono">{duration(st.seconds)}</span>
                <span className="row gap" data-tour="review-actions">
                    <button type="button" className="quiet menu-button" title="Move this time to another matter, off any matter, or to a new one." onClick={() => explain("Matter moves this time to another matter, off any matter, or to a new one you name in place")}>Matter <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                    <button type="button" className="quiet" title="Not work: kept out of billing and never synced" onClick={() => explain(`${PERSONAL} keeps the time out of billing and sync for good`)}>Personal</button>
                    <button type="button" className="quiet" title="Take this stretch out of review without keeping time." onClick={() => explain("Dismiss takes the stretch out of review without keeping time")}>Dismiss</button>
                    <button type="button" className="primary" title="Check this stretch and save it as a time entry. The sample saves nothing." onClick={onKeep}>Keep time</button>
                </span>
            </div>
            {open && (
                <div className="sittings">
                    <div className="sitting">
                        <span className="sitting-dot" aria-hidden="true" />
                        <div className="grow item-body">
                            <div><span className="small">{st.name}</span> <span className="tiny muted">{st.app} · {st.sittings} sittings</span></div>
                            <div className="tiny muted">{describeItem(sittings, sittings).facts}</div>
                        </div>
                        <span className="mono small">{duration(st.seconds)}</span>
                    </div>
                </div>
            )}
        </div>
    );
}

/** Under a review row that looks like more of a kept entry: the question, naming the entry. The row's buttons become Separate / Add to entry. Once merged: that it must be kept again. */
function MergeLine({ match, merged }: { match: TimeEntry | null; merged: boolean }): ReactNode {
    if (merged) return <div className="merge-note tiny">↺ Added to a kept entry · keep it again to put it back on your timesheet</div>;
    if (!match) return null;
    return <div className="merge-note tiny">↔ Add this to your kept entry <strong>“{match.description}”</strong> ({clock(match.startedAt)}–{clock(match.endedAt)}, {duration(entrySeconds(match))})?</div>;
}

/**
 * Under a kept entry: the new activity since, that looks like more of it, each with Add (the
 * entry comes back to review with it, to be kept again as one) and Separate.
 */
function NewSince({ rows, entryID, byID }: { rows: string[][]; entryID: string; byID: Map<string, Activity> }): ReactNode {
    return (
        <div className="new-since">
            <div className="eyebrow">New since</div>
            {rows.map((ids) => {
                const acts = ids.map((id) => byID.get(id)).filter((a): a is Activity => !!a).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
                if (!acts.length) return null;
                const first = acts[0], last = acts[acts.length - 1];
                const apps = [...new Set(acts.map((a) => a.app))].join(", ");
                const name = first.description ?? first.document?.name ?? first.title ?? first.app;
                return (
                    <div className="sitting" key={ids[0]}>
                        <span className="sitting-dot new" aria-hidden="true" />
                        <span className="grow"><span className="small">{name}</span> <span className="tiny muted">· {apps} · {dayLabel(first.startedAt)} {spanLabel(first.startedAt, last.endedAt, acts.length)}</span></span>
                        <span className="mono small">{duration(acts.reduce((n, a) => n + entrySeconds(a), 0))}</span>
                        <button type="button" className="link sitting-dismiss" title="The new time is other work: it stays in review on its own" onClick={() => void window.lawdie.keepSeparate(ids, entryID)}>Separate</button>
                        <button type="button" className="link sitting-dismiss add" title="This entry comes back to review with the new time, to be kept again as one" onClick={() => void window.lawdie.mergeIntoEntry(ids, entryID)}>Add to entry</button>
                    </div>
                );
            })}
        </div>
    );
}

/** The row's buttons while its kept-entry question is open. */
function MergeButtons({ ids, match }: { ids: string[]; match: TimeEntry }): ReactNode {
    return (
        <>
            <button type="button" className="quiet" title="This is other work: review it on its own, and never suggest this entry for it again" onClick={() => void window.lawdie.keepSeparate(ids, match.id)}>Keep separate</button>
            <button type="button" className="primary" title="The kept entry comes back to review with this time, to be kept again as one" onClick={() => void window.lawdie.mergeIntoEntry(ids, match.id)}>Add to entry</button>
        </>
    );
}

/** "· 14m idle" after a row whose time includes flagged idle time; nothing otherwise. */
function IdleTag({ seconds }: { seconds: number }): ReactNode {
    return seconds >= 60 ? <span className="idle-tag" title={`No mouse or keyboard input for ${IDLE_FLAG_SECONDS / 60} minutes or more. Counted unless you leave it out when keeping.`}> · {duration(seconds)} idle</span> : null;
}

/** Screenshots of a row's time, oldest first: at most `max`, spread evenly; one opens full size in the system's viewer. */
function Shots({ names, max = 6 }: { names: string[] | undefined; max?: number }): ReactNode {
    if (!names?.length) return null;
    const sorted = [...names].sort((a, b) => screenshotTime(a) - screenshotTime(b));
    const shown = sorted.length <= max ? sorted : Array.from({ length: max }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (max - 1))]);
    return (
        <div className="shots">
            {shown.map((n) => (
                <button key={n} type="button" className="shot" title={`Screenshot at ${clock(new Date(screenshotTime(n)).toISOString())}. Open full size`} onClick={() => void window.lawdie.openScreenshot(n)}>
                    <img src={`lawdie-shot://shot/${n}`} alt={`Screenshot at ${clock(new Date(screenshotTime(n)).toISOString())}`} loading="lazy" draggable={false} />
                </button>
            ))}
            {sorted.length > shown.length && <span className="tiny muted">{sorted.length} screenshots</span>}
        </div>
    );
}

/**
 * Text with a pencil beside it: the pencil (or a click on the text) turns it into a field;
 * Enter or leaving the field saves, Escape cancels. Saving the text unchanged saves nothing.
 * With no text yet (a matter row without a description or draft), a full line says what to
 * add, in the draft line's place, so it reads as the field it is and not a stray pencil.
 */
function Editable({ initial, placeholder, title = "Rename: the description this is kept as", onSave, children }: { initial: string; placeholder?: string; title?: string; onSave: (text: string) => void; children: ReactNode }): ReactNode {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(initial);
    const begin = (): void => { setText(initial); setEditing(true); };
    const finish = (save: boolean): void => { setEditing(false); if (save && text.trim() !== initial.trim()) onSave(text.trim()); };
    if (editing) return (
        <input className="inline-edit" autoFocus value={text} placeholder={placeholder} maxLength={500} aria-label="Description"
            onChange={(e) => setText(e.target.value)} onBlur={() => finish(true)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }} />
    );
    return (
        <div className="editable">
            {children && <div className="editable-text" onClick={begin}>{children}</div>}
            {children ? <button type="button" className="pencil" title={title} aria-label={title} onClick={begin}>✎</button>
                : <button type="button" className="pencil describe" title={title} onClick={begin}><span aria-hidden="true">✎</span> Add a description</button>}
        </div>
    );
}

/** An AI-drafted billing description, under the row it was drafted for. */
function DraftLine({ draft }: { draft: Draft }): ReactNode {
    return <div className="draft-line" title={draft.source === "sample" ? "Sample draft, not generated from your data" : draft.source === "capture" ? "Written from the captured apps, documents and people." : "Drafted by AI from what was captured"}><span aria-hidden="true">✦</span> {draft.text}</div>;
}

/** "✦ AI" after a description that is an AI draft kept as written. */
function AiTag({ source, status }: { source: DraftSource | undefined; status?: TimeEntry["status"] }): ReactNode {
    const waiting = status === "suggested" ? ` ${SUGGESTED_TIP}` : "";
    if (source === "capture") return <span className="ai-tag" title={`Written from the captured activity, kept as written.${waiting}`}>✦ From capture</span>;
    return source ? <span className="ai-tag" title={`${source === "sample" ? "Sample draft, not generated from your data." : "Drafted by AI, kept as written."}${waiting}`}>✦ AI{source === "sample" ? " · sample" : ""}</span> : null;
}

/** The matter something is on, in small type; "No matter" when it is on none. */
function MatterLabel({ name }: { name: string | null | undefined }): ReactNode {
    return name ? <span className="matter-label">{name}</span> : <span className="matter-label none">No matter</span>;
}

/**
 * "Matter ▾" on a review row or a document inside a matter: moves that activity to a matter the app
 * knows (open projects and names on pending activity), off any matter, or to a new one named right
 * here. The person's choice (`setMatter`, `matterBy: "person"`) is never suggested over.
 */
function MatterMenu({ w, ids, current, what, label = "Matter", className, onMoved }: { w: Workspace; ids: string[]; current: string | null; what: string; label?: string; className?: string; onMoved?: (ids: string[]) => void }): ReactNode {
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const notify = useNotify();
    const names = knownMatters(w).filter((n) => n.toLowerCase() !== current?.toLowerCase() && n.toLowerCase() !== PERSONAL.toLowerCase());
    // A new name that is already a matter's joins that matter, spelt its way, and says so.
    const move = (matter: string | null): void => {
        const known = matter ? existingMatter(w, matter) : null;
        const target = known ?? matter?.trim() ?? null;
        void window.lawdie.setMatter(ids, target).then((ok) => {
            if (!ok) return;
            if (!target) notify(`${what} is back in review on its own.`);
            else if (known) notify(`${what} added to “${known}”${current ? `, from “${current}”` : ""}.`);
            else notify(`${what} put on a new matter, “${target}”. It is made when you keep the time.`);
            if (target) onMoved?.(ids);
        });
    };
    const finish = (save: boolean): void => { setNaming(false); if (save && name.trim()) move(name); setName(""); };
    if (naming) return (
        <input className="inline-edit matter-new" autoFocus value={name} placeholder="New matter's name" aria-label="New matter" maxLength={MATTER_MAX}
            onChange={(e) => setName(e.target.value)} onBlur={() => finish(true)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } }} />
    );
    return (
        <Menu label={label} className={className} tip={current ? "Move this time to another matter, off any matter, or to a new one." : "Put this time on one of your matters, or name a new one."}>
            {names.map((n) => <button key={n} type="button" role="menuitem" title={`Move this time to ${n}.`} onClick={() => move(n)}>{n}</button>)}
            {names.length > 0 && <span className="menu-sep" aria-hidden="true" />}
            <button type="button" role="menuitem" title="Name a matter the app does not know yet; it is made when you keep the time." onClick={() => setNaming(true)}>New matter…</button>
            {current && <button type="button" role="menuitem" title="Take this time off the matter; it goes back to review on its own." onClick={() => move(null)}>No matter</button>}
        </Menu>
    );
}

/** One matter's day: every app and document it was in, as one row to keep. */
function MatterRow({ w, onMoved, group: g, match, merged, described, idle, shots, open, onToggle, onKeep }: { w: Workspace; onMoved: (ids: string[]) => void; group: MatterGroup; match: TimeEntry | null; merged: boolean; described: ReturnType<typeof descriptionOf>; idle: number; shots: string[]; open: boolean; onToggle: () => void; onKeep: () => void }): ReactNode {
    const notify = useNotify();
    return (
        <div>
            <div className="activity">
                <span className="app-icon matter-icon" aria-hidden="true">§</span>
                <div className="grow">
                    <Editable initial={g.matter} title="Rename this matter, everywhere it appears; another matter's name merges the two" onSave={(name) => {
                        if (!name) return;
                        const into = name.toLowerCase() === g.matter.toLowerCase() ? null : existingMatter(w, name);
                        void window.lawdie.renameMatter(g.matter, name).then((ok) => { if (ok && into) notify(`“${g.matter}” merged into “${into}”: its time is on that matter now.`); });
                    }}>
                        <div className="small strong">{g.matter}</div>
                    </Editable>
                    <Editable initial={described?.text ?? ""} placeholder="Describe this work" title="Describe this work: the description it is kept as, or the start of one" onSave={(text) => void window.lawdie.describeActivities(g.activityIDs, text)}>
                        {described?.by === "person" ? <div className="draft-line own">{described.text}</div> : g.draft ? <DraftLine draft={g.draft} /> : null}
                    </Editable>
                    <Shots names={shots} />
                    <div className="muted tiny meta">
                        <span>{g.apps.join(", ")} · {dayLabel(g.startedAt)} {spanLabel(g.startedAt, g.endedAt, g.sittings)} · {g.sittings} {g.sittings === 1 ? "sitting" : "sittings"}<IdleTag seconds={idle} /></span>
                        <SittingsToggle label={`${g.documents.length} ${g.documents.length === 1 ? "item" : "items"}`} open={open} what="the documents in this matter" onClick={onToggle} />
                    </div>
                    <MergeLine match={match} merged={merged} />
                </div>
                <span className="mono">{duration(g.seconds)}</span>
                <MatterMenu w={w} ids={g.activityIDs} current={g.matter} what={`${g.matter}'s time`} onMoved={onMoved} />
                {match ? <MergeButtons ids={g.activityIDs} match={match} /> : <>
                    <button type="button" className="quiet" title="Not work: kept out of billing and never synced" onClick={() => void window.lawdie.setMatter(g.activityIDs, PERSONAL)}>Personal</button>
                    <button type="button" className="quiet" title="Take this matter's activity out of review without keeping time." onClick={() => void window.lawdie.dismissActivity(g.activityIDs)}>Dismiss</button>
                    <button type="button" className="primary" title="Check this matter's time and save it." onClick={onKeep}>Keep time</button>
                </>}
            </div>
            {open && (
                <div className="sittings">
                    {g.documents.map((d) => (
                        <div className="sitting" key={`${d.app}\n${d.name}`}>
                            <span className="sitting-dot" aria-hidden="true" />
                            <div className="grow item-body">
                                <div><span className="small">{d.name}</span> <span className="tiny muted">{d.app}{d.activityIDs.length > 1 ? ` · ${d.activityIDs.length} sittings` : ""}</span></div>
                                {((item) => <>
                                    <div className="tiny muted">{item.facts}</div>
                                    {item.text && <div className="tiny muted item-text">{item.text}</div>}
                                </>)(describeItem(w.activities.filter((a) => d.activityIDs.includes(a.id)), w.activities))}
                            </div>
                            <span className="mono small">{duration(d.seconds)}</span>
                            <MatterMenu w={w} ids={d.activityIDs} current={g.matter} what={d.name} label="Move…" className="link sitting-dismiss" onMoved={onMoved} />
                            <button type="button" className="link sitting-dismiss" title={`Dismiss ${d.activityIDs.length === 1 ? "this sitting" : `these ${d.activityIDs.length} sittings`}; the rest of the matter stays to review`} onClick={() => void window.lawdie.dismissActivity(d.activityIDs)}>Dismiss</button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Time the AI or the person called personal, every day of it in one row: dismissed in one go, or an item sent back to review. Never kept. */
function PersonalRow({ groups, open, onToggle }: { groups: MatterGroup[]; open: boolean; onToggle: () => void }): ReactNode {
    const items = groups.flatMap((g) => g.documents.map((d) => ({ ...d, day: g.startedAt })));
    const seconds = groups.reduce((n, g) => n + g.seconds, 0);
    return (
        <div>
            <div className="activity">
                <span className="app-icon muted" aria-hidden="true">⌂</span>
                <div className="grow">
                    <div className="small strong">{PERSONAL}</div>
                    <div className="muted tiny meta">
                        <span>Not work: never kept, billed or synced.</span>
                        <SittingsToggle label={`${items.length} ${items.length === 1 ? "item" : "items"}`} open={open} onClick={onToggle} />
                    </div>
                </div>
                <span className="mono">{duration(seconds)}</span>
                <button type="button" className="quiet" onClick={() => void window.lawdie.dismissActivity(groups.flatMap((g) => g.activityIDs))}>Dismiss all</button>
            </div>
            {open && (
                <div className="sittings">
                    {items.map((d) => (
                        <div className="sitting" key={`${d.day}\n${d.app}\n${d.name}`}>
                            <span className="sitting-dot" aria-hidden="true" />
                            <span className="small">{d.name}</span>
                            <span className="tiny muted">{d.app} · {dayLabel(d.day)}</span>
                            <span className="grow" />
                            <span className="mono small">{duration(d.seconds)}</span>
                            <button type="button" className="link sitting-dismiss" title="It is work: back to review" onClick={() => void window.lawdie.setMatter(d.activityIDs, null)}>Not personal</button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** "6 sittings ▾": the count is the control that opens them. */
function SittingsToggle({ label, open, onClick, what = "the sittings" }: { label: string; open: boolean; onClick: () => void; what?: string }): ReactNode {
    return (
        <button type="button" className={"sittings-toggle" + (open ? " open" : "")} aria-expanded={open} title={`${open ? "Hide" : "Show"} ${what}.`} onClick={onClick}>
            {label}
            <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true"><path d="M0.6 1.2h7.8L4.5 5.2z" fill="currentColor" /></svg>
        </button>
    );
}

/** The sittings inside a stretch or a kept entry as a timeline: each sitting on the rail,
 *  the time away between two of them named, and, while a stretch is still under review,
 *  a Dismiss on each that drops it from the stretch. */
function Sittings({ items, all, onDismiss }: { items: (Interval & { id?: string; endedBy?: string; endedTo?: string })[]; all?: readonly Activity[]; onDismiss?: (id: string) => void }): ReactNode {
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
                            {i.endedBy && <span className="tiny muted">{endedText(i, all)}</span>}
                            <span className="grow" />
                            <span className="mono small">{duration((Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000)}</span>
                            {onDismiss && i.id && <button type="button" className="link sitting-dismiss" title="Drop this sitting from the stretch." onClick={() => onDismiss(i.id as string)}>Dismiss</button>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** "HH:MM" in local time, and back onto the stretch's day (an end before the start rolls to the next day). */

function KeepSheet({ w, stretch, matter: suggested, initialDescription, projects, sittings, keep = (ids, input) => window.lawdie.keepActivity(ids, input), onClose }: { w: Workspace; stretch: Stretch; matter: string | null; initialDescription: string; projects: string[]; sittings: Activity[]; keep?: (ids: string[], input: KeepInput) => Promise<boolean>; onClose: () => void }): ReactNode {
    const [matter, setMatter] = useState(suggested ?? "");
    const project = projectByName(w, matter);
    const rc = rulesContext(w, project);
    const day = new Date(stretch.startedAt).toLocaleDateString("en-CA");
    // The client's rules want one task per entry: the captured tasks of this stretch, each with its narrative, hours and codes.
    const initialPlan = useMemo(() => (rc.ctx ? splitPlan(sittings, rc.ctx, rc.profile, { billable: true, hourlyRate: project?.hourlyRate ?? 0, day }) : []), [sittings, rc.ctx, rc.profile, project?.hourlyRate, day]);
    const single = initialPlan.length === 1 ? initialPlan[0].draft : null;
    const [description, setDescription] = useState(descriptionOf(sittings)?.text ?? single?.description ?? initialDescription);
    const asDrafted = (!!stretch.draft && description.trim() === stretch.draft.text) || (!!single && description.trim() === single.description);
    const [billable, setBillable] = useState(true);
    const [startText, setStartText] = useState(timeValue(stretch.startedAt));
    const [endText, setEndText] = useState(timeValue(stretch.endedAt));
    const [hoursSet, setHoursSet] = useState<number | null>(null);
    const [codes, setCodes] = useState<{ taskCode?: string; activityCode?: string }>(single ? { taskCode: single.taskCode, activityCode: single.activityCode } : {});
    const [rate, setRate] = useState<number | null>(null);
    const [lines, setLines] = useState<PlanLine[] | null>(null);
    const [foldTarget, setFoldTarget] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [leaveOutIdle, setLeaveOutIdle] = useState(false);
    const { start, end, changed } = keepBounds(stretch, startText, endText);
    const spans: Interval[] = sittings.flatMap(intervals);
    const imported = sittings.some((a) => a.origin);
    const span = imported ? (() => { const kept = clipSittings(spans, start, end); return kept.length ? { startedAt: kept[0].startedAt, endedAt: kept[kept.length - 1].endedAt, sittings: kept } : null; })() : stretchSpan(spans, start, end);
    const idleList = sittings.flatMap((a) => a.idle ?? []);
    const idle = span ? idleList.reduce((n, i) => n + intervals(span).reduce((m, s) => m + Math.max(0, Math.min(Date.parse(i.endedAt), Date.parse(s.endedAt)) - Math.max(Date.parse(i.startedAt), Date.parse(s.startedAt))) / 1000, 0), 0) : 0;
    const left = span && leaveOutIdle && idle > 0 ? subtractIntervals(intervals(span), idleList) : null;
    const preview = left ? (left.length ? { startedAt: left[0].startedAt, endedAt: left[left.length - 1].endedAt, sittings: left } : null) : span;
    const previewSeconds = preview ? intervals(preview).reduce((n, i) => n + (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000, 0) : 0;
    const hours = hoursSet ?? Math.max(0.1, roundUpToTenth(previewSeconds / 3600));
    const hourlyRate = rate ?? project?.hourlyRate ?? 0;
    const plan = rc.ctx && preview ? splitPlan(reviewedActivities(sittings, intervals(preview)), rc.ctx, rc.profile, { billable, hourlyRate, day, ...(hoursSet !== null ? { hours: hoursSet } : {}) }) : [];
    const draft: EntryDraft = { description, hours, ...codes, billable, hourlyRate, day };
    const sameDay = sameDayOf(w, project?.id ?? null, day);
    const check = { ...rc, sameDay, splitCount: plan.length, suggestion: single?.description ?? null };
    const onFix = (fix: Fix): void => {
        if (fix.split) { setLines(plan); return; }
        if (fix.foldInto) setFoldTarget(fix.foldInto);
        const next = applyFix(draft, fix);
        setDescription(next.description); setHoursSet(next.hours); setCodes({ taskCode: next.taskCode, activityCode: next.activityCode }); setBillable(next.billable); setRate(next.hourlyRate);
    };
    const drafted = (text: string, from: string | undefined): { drafted?: DraftSource } => (from && text.trim() === from ? { drafted: "capture" } : {});
    const save = async (): Promise<void> => {
        if (lines) {
            if (lines.some((l) => !l.draft.description.trim())) { setProblem("Add a narrative to every line."); return; }
            const ok = await window.lawdie.keepLines(lines.map((l, n) => ({ activityIDs: l.activityIDs, input: { description: l.draft.description, projectID: null, matter: matter.trim() || null, sittings: l.sittings, leaveOutIdle, billable: l.draft.billable, hours: l.draft.hours, taskCode: l.draft.taskCode, activityCode: l.draft.activityCode, hourlyRate: l.draft.hourlyRate, ...drafted(l.draft.description, plan[n]?.draft.description) }, foldInto: l.foldInto ?? null })));
            if (ok) onClose(); else setProblem("Those entries could not be saved. They may overlap time you already kept.");
            return;
        }
        if (!description.trim()) { setProblem("Add a description."); return; }
        if (!preview) { setProblem(span ? "All of this time was idle. Dismiss it instead." : "No captured time falls between those times."); return; }
        const input = { description, projectID: null, matter: matter.trim() || null, billable, ...(asDrafted ? { drafted: (stretch.draft?.source ?? "capture") as DraftSource } : {}), ...(changed ? { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() } : {}), ...(leaveOutIdle && idle > 0 ? { leaveOutIdle: true } : {}), ...(rc.book ? { hours, ...codes, hourlyRate } : {}) };
        // Folded into the day's email entry: the sittings join that entry, which takes the summed hours.
        const ok = foldTarget ? await window.lawdie.keepLines([{ activityIDs: stretch.activityIDs, input, foldInto: foldTarget }]) : await keep(stretch.activityIDs, input);
        if (ok) onClose();
        else setProblem("That could not be saved. It may overlap time you already kept.");
    };
    return (
        <div className="scrim" onClick={onClose}>
            <form className={"sheet" + (lines || rc.book ? " wide" : "")} data-tour="keep-sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <Heading eyebrow={imported ? "From captured activity" : "From desktop activity"} title={lines ? `Keep ${lines.length} entries` : "Keep time"} subtitle={lines ? `${matter}: one entry per task, each with its captured time.` : suggested ? `${stretch.sittings} ${stretch.sittings === 1 ? "sitting" : "sittings"} on ${suggested}, in ${stretch.app}.` : stretch.sittings > 1 ? `${stretch.sittings} sittings on one document, kept as one entry.` : "Review this activity and choose where it belongs."} />
                {lines ? (
                    <>
                        <SplitLines lines={lines} setLines={setLines} c={{ ...rc, sameDay }} sameDay={sameDay} />
                        {problem && <p className="danger small">{problem}</p>}
                        <div className="row between">
                            <span className="mono accent big">{lines.reduce((n, l) => n + l.draft.hours, 0).toFixed(1)} h</span>
                            <span className="row gap"><button type="button" className="quiet" title="Go back to one entry for the whole stretch." onClick={() => setLines(null)}>Back</button><button type="submit" className="primary" title="Save each line as its own time entry.">Keep {lines.length} entries</button></span>
                        </div>
                    </>
                ) : (
                    <>
                        <label className="field"><span className="eyebrow">Matter{suggested ? " · suggested" : ""}</span><input list="matter-names" value={matter} placeholder="Which matter is this? Leave empty for none." title="The matter this time is billed to." onChange={(e) => setMatter(e.target.value)} /></label>
                        <datalist id="matter-names">{projects.map((p) => <option key={p} value={p} />)}</datalist>
                        <label className="field"><span className="eyebrow">Description{asDrafted ? (stretch.draft?.source === "capture" || single ? " · drafted from capture" : ` · drafted by AI${stretch.draft!.source === "sample" ? " (sample)" : ""}`) : ""}</span><input autoFocus value={description} title="The narrative the client sees; the rules check it as you type." onChange={(e) => setDescription(e.target.value)} /></label>
                        <div className="row gap">
                            <label className="field"><span className="eyebrow">Start · {dayLabel(stretch.startedAt)}</span><input type="time" value={startText} title="When the work started." onChange={(e) => setStartText(e.target.value)} /></label>
                            <label className="field"><span className="eyebrow">End</span><input type="time" value={endText} title="When the work ended." onChange={(e) => setEndText(e.target.value)} /></label>
                            {rc.book && <label className="field"><span className="eyebrow">Hours</span><input type="number" step="0.05" min="0" value={hours} title="Billed hours; captured time rounded up to the tenth." onChange={(e) => setHoursSet(Number(e.target.value))} /></label>}
                            {rc.book && <label className="field"><span className="eyebrow">Task</span><input value={codes.taskCode ?? ""} placeholder="P500" title="UTBMS task code for this entry." onChange={(e) => setCodes({ ...codes, taskCode: e.target.value.toUpperCase() })} /></label>}
                            {rc.book && <label className="field"><span className="eyebrow">Activity</span><input value={codes.activityCode ?? ""} placeholder="A103" title="UTBMS activity code for this entry." onChange={(e) => setCodes({ ...codes, activityCode: e.target.value.toUpperCase() })} /></label>}
                            <label className="row gap check" title="Bill this time to the client."><input type="checkbox" checked={billable} title="Bill this time to the client." onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
                        </div>
                        {idle >= 60 && <label className="row gap check"><input type="checkbox" checked={leaveOutIdle} onChange={(e) => setLeaveOutIdle(e.target.checked)} /> Leave out {duration(idle)} idle (no mouse or keyboard for {IDLE_FLAG_SECONDS / 60} minutes or more)</label>}
                        <RulesCheck draft={draft} c={check} onFix={onFix} />
                        {(stretch.sittings > 1 || (left?.length ?? 0) > 1) && !rc.book && <Sittings items={intervals(preview ?? { startedAt: stretch.startedAt, endedAt: stretch.endedAt })} />}
                        {!rc.book && <p className="muted tiny">{stretch.sittings > 1 ? "Only the sittings count; narrowing the times trims them, and time in other apps between them stays free to keep on its own." : imported ? "Imported time stays within the captured intervals. Any portion you leave out is treated as reviewed." : "Change the times if the work ran longer than what was captured."} If this overlaps tracked time, dismiss the activity instead.</p>}
                        {problem && <p className="danger small">{problem}</p>}
                        <div className="row between">
                            <span className="mono accent big">{rc.book ? `${hours.toFixed(1)} h` : duration(previewSeconds)}</span>
                            <span className="row gap"><button type="button" className="quiet" title="Close without keeping any time." onClick={onClose}>Cancel</button><button type="submit" className="primary" title="Save this as one time entry.">Keep time</button></span>
                        </div>
                    </>
                )}
            </form>
        </div>
    );
}

// ---------------------------------------------------------------------------

const money = (n: number): string => n.toLocaleString([], { style: "currency", currency: "USD", maximumFractionDigits: 0 });
type MatterStats = { tracked: number; billable: number; value: number; entries: TimeEntry[] };
/** An entry that goes on the bill: kept as billable, not a suggestion, a flag or a dismissal still waiting for Rosa. */
const onBill = (e: TimeEntry): boolean => e.billable && (!e.status || e.status === "draft");
/** What a matter's kept time came to inside [start, end): all its time, the time that goes on the bill, and that
 *  time's value as the bill prices it at standard rates (`amounts`, from applyRules), so it agrees with the Time page. */
function statsFor(w: Workspace, projectID: string | null, start: number, end: number, amounts: ReadonlyMap<string, number>): MatterStats {
    const entries = w.entries.filter((e) => e.projectID === projectID && Date.parse(e.startedAt) < end && Date.parse(e.endedAt) > start).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    let tracked = 0, billable = 0, value = 0;
    for (const e of entries) {
        const secs = secondsWithin(e, start, end);
        tracked += secs;
        if (onBill(e)) { billable += secs; value += amounts.get(e.id) ?? 0; }
    }
    return { tracked, billable, value: Math.round(value * 100) / 100, entries };
}
const MATTER_RANGES = RANGES.filter((r) => r.key !== "custom");

function MatterLinks({ w }: { w: Workspace }): ReactNode {
    const [localID, setLocalID] = useState("");
    const [remoteID, setRemoteID] = useState("");
    if (!w.feed?.matters.length) return null;
    const names = [...w.projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name })), ...[...new Set(w.activities.filter((a) => a.disposition === "pending" && a.matter && a.matter !== PERSONAL && !a.kiwiProjectID && !w.projects.some((p) => p.name === a.matter)).map((a) => a.matter!))].map((name) => ({ id: `name:${name}`, name }))];
    return <Panel><h3>Kiwi matter links</h3>
        {w.feed.joins.filter((j) => j.status !== "declined").map((j) => {
            const remote = w.feed!.matters.find((m) => m.id === j.kiwi_project_id);
            const local = names.find((p) => p.id === j.local_id)?.name ?? j.before?.name ?? j.local_id.replace(/^name:/, "");
            return <div key={j.local_id} className="row between wrap gap" style={{ marginBottom: 12 }}>
                <div><p className="small">{local} {j.status === "joined" ? "is linked to" : "— same as"} {remote?.name ?? "a Kiwi matter"}{j.status ? "" : "?"}</p>{j.reason && <p className="muted tiny">{j.reason}</p>}</div>
                {j.status === "joined" ? <button className="quiet" type="button" onClick={() => void window.lawdie.undoJoin(j.local_id)}>Undo join</button> : <span className="row gap"><button className="quiet" type="button" onClick={() => void window.lawdie.declineJoin(j.local_id)}>Keep separate</button><button className="primary" type="button" onClick={() => void window.lawdie.joinMatter(j.local_id, j.kiwi_project_id)}>Join</button></span>}
            </div>;
        })}
        <div className="row gap wrap">
            <label className="field"><span className="eyebrow">Local matter</span><select value={localID} onChange={(e) => setLocalID(e.target.value)}><option value="">Choose a matter</option>{names.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field"><span className="eyebrow">Same as Kiwi matter</span><select value={remoteID} onChange={(e) => setRemoteID(e.target.value)}><option value="">Choose a Kiwi matter</option>{w.feed.matters.map((m) => <option key={m.id} value={m.id}>{m.name}{m.cm_number ? ` · ${m.cm_number}` : ""}</option>)}</select></label>
            <button className="quiet" type="button" disabled={!localID || !remoteID} onClick={() => void window.lawdie.joinMatter(localID, remoteID)}>Join matters</button>
        </div><p className="muted tiny">High-confidence matches join automatically. Other matches wait for your choice. Your chosen names are kept.</p>
    </Panel>;
}

function MattersView({ w, now, onReview }: { w: Workspace; now: number; onReview: () => void }): ReactNode {
    const [range, setRange] = useState<RangeKey>("week");
    const [selected, setSelected] = useState<string | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const { start, end, label } = rangeBounds(range, now, "", "");
    const { groups } = useMemo(() => inboxOf(w.activities), [w.activities]);
    const waiting = (name: string): MatterGroup[] => groups.filter((g) => g.matter.toLowerCase() === name.trim().toLowerCase());
    // Every settled entry's amount on the bill at standard rates: what the Time page's Generic total adds up.
    const amounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const l of applyRules(w, null, "generic").lines) m.set(l.entryId, (m.get(l.entryId) ?? 0) + l.amount);
        return m;
    }, [w]);
    const rows = w.projects.map((p) => ({ p, stats: statsFor(w, p.id, start, end, amounts), waiting: waiting(p.name) }));
    const open = rows.filter((r) => !r.p.archived).sort((a, b) => b.stats.tracked - a.stats.tracked || a.p.name.localeCompare(b.p.name));
    const archived = rows.filter((r) => r.p.archived).sort((a, b) => a.p.name.localeCompare(b.p.name));
    const none = statsFor(w, null, start, end, amounts);
    const total = open.reduce((n, r) => n + r.stats.value, 0);
    const billable = open.reduce((n, r) => n + r.stats.billable, 0);
    const chosen = selected === "none" ? null : w.projects.find((p) => p.id === selected);
    const rangeTabs = (
        <div className="segmented" role="tablist" aria-label="Range">
            {MATTER_RANGES.map((r) => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} className={range === r.key ? "active" : ""} title={`Show matters for ${r.label.toLowerCase()}.`} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
    );
    if (selected && (chosen || selected === "none")) {
        return <MatterDetail key={selected} w={w} project={chosen ?? null} stats={chosen ? statsFor(w, chosen.id, start, end, amounts) : none} waiting={chosen ? waiting(chosen.name) : []} label={label} rangeTabs={rangeTabs} now={now} onBack={() => setSelected(null)} onReview={onReview} />;
    }
    const row = ({ p, stats, waiting: list }: (typeof rows)[number]) => (
        <button type="button" key={p.id} className={"matter-row" + (p.archived ? " archived" : "")} title="Open this matter's time, rate and settings." onClick={() => setSelected(p.id)}>
            <span className="app-icon matter-icon" aria-hidden="true">§</span>
            <span className="matter-name">
                <span className="small strong">{p.name}</span>
                <span className="muted tiny">{p.client || "No client"} · {p.hourlyRate ? `${money(p.hourlyRate)}/h` : "No rate set"}</span>
            </span>
            <span className="mono small">{duration(stats.tracked)}</span>
            <span className="mono small">{duration(stats.billable)}</span>
            <span className="mono small">{dollars(stats.value)}</span>
            <span className="tiny">{list.length ? <span className="waiting">{list.length} to review</span> : null}</span>
        </button>
    );
    return (
        <>
            <Heading eyebrow={label} title="Your matters." />
            <MatterLinks w={w} />
            <div className="row between wrap">{rangeTabs}</div>
            <div className="metrics">
                <Metric label="Billable value" value={dollars(total)} detail={((n) => `${duration(billable)} billable across ${n} ${n === 1 ? "matter" : "matters"}`)(open.filter((r) => r.stats.tracked > 0).length)} />
                <Metric label="Open matters" value={String(open.length)} detail={archived.length ? `${archived.length} archived` : "Made when you keep time on a matter"} />
                <Metric label="No matter" value={cardTime(none.tracked)} detail={none.entries.length ? `${none.entries.length} ${none.entries.length === 1 ? "entry" : "entries"} kept without one` : "Everything kept is on a matter"} />
            </div>
            <Panel tour="matters">
                <div className="matter-row head eyebrow" aria-hidden="true"><span /><span>Matter</span><span>Tracked</span><span>Billable</span><span>Value</span><span>Review</span></div>
                {open.length === 0 && <Empty title="No matters yet." detail="Keep time from the Activity inbox with a matter named, and the matter appears here with its time and rate." />}
                {open.map(row)}
                {none.entries.length > 0 && (
                    <button type="button" className="matter-row" title="Open the time kept without a matter." onClick={() => setSelected("none")}>
                        <span className="app-icon muted" aria-hidden="true">·</span>
                        <span className="matter-name"><span className="small strong muted">No matter</span><span className="muted tiny">Kept without a matter</span></span>
                        <span className="mono small">{duration(none.tracked)}</span>
                        <span className="mono small">{duration(none.billable)}</span>
                        <span className="mono small">{dollars(none.value)}</span>
                        <span />
                    </button>
                )}
                {archived.length > 0 && <button type="button" className="link" title={showArchived ? "Hide the archived matters." : "Show the archived matters."} onClick={() => setShowArchived(!showArchived)}>{showArchived ? "▾" : "▸"} {archived.length} archived</button>}
                {showArchived && archived.map(row)}
            </Panel>
        </>
    );
}

function MatterDetail({ w, project: p, stats, waiting, label, rangeTabs, now, onBack, onReview }: { w: Workspace; project: Project | null; stats: MatterStats; waiting: MatterGroup[]; label: string; rangeTabs: ReactNode; now: number; onBack: () => void; onReview: () => void }): ReactNode {
    const [name, setName] = useState(p?.name ?? "");
    const [client, setClient] = useState(p?.client ?? "");
    const [rate, setRate] = useState(p ? String(p.hourlyRate) : "");
    const [number, setNumber] = useState(p?.matterNumber ?? "");
    const [billTo, setBillTo] = useState(p?.billTo?.join("\n") ?? "");
    const [codeSet, setCodeSet] = useState<string>(p?.codeSet ?? "");
    const [into, setInto] = useState("");
    const billToLines = billTo.split("\n").map((l) => l.trim()).filter(Boolean);
    const changed = !!p && (name !== p.name || client !== p.client || Number(rate) !== p.hourlyRate || number.trim() !== (p.matterNumber ?? "") || billToLines.join("\n") !== (p.billTo ?? []).join("\n") || codeSet !== (p.codeSet ?? ""));
    const others = w.projects.filter((x) => p && x.id !== p.id && !x.archived).sort((a, b) => a.name.localeCompare(b.name));
    const days = new Map<string, TimeEntry[]>();
    for (const e of stats.entries) { const k = dayKey(Date.parse(e.startedAt)); if (!days.has(k)) days.set(k, []); days.get(k)!.push(e); }
    const notify = useNotify();
    const save = (): void => {
        if (!p) return;
        const into = name.trim().toLowerCase() === p.name.toLowerCase() ? null : existingMatter(w, name);
        if (into) {
            // Another matter's name: the two merge (entries and review rows move there) rather than clash.
            void window.lawdie.renameMatter(p.name, name).then((ok) => { if (ok) { notify(`“${p.name}” merged into “${into}”: its entries and review rows are on that matter now.`); onBack(); } });
            return;
        }
        void window.lawdie.updateProject(p.id, { name, client, hourlyRate: Number(rate), matterNumber: number, billTo: billToLines, codeSet: (codeSet || null) as Project["codeSet"] | null });
    };
    return (
        <>
            <button type="button" className="link back" title="Go back to the list of matters." onClick={onBack}>‹ All matters</button>
            <Heading eyebrow={p ? `${p.client || "No client"}${p.archived ? " · archived" : ""}` : "Kept without a matter"} title={p?.name ?? "No matter"} />
            <div className="row between wrap">{rangeTabs}<span className="eyebrow">{label}</span></div>
            <div className="metrics">
                <Metric label="Tracked" value={cardTime(stats.tracked)} detail={`${stats.entries.length} ${stats.entries.length === 1 ? "entry" : "entries"}`} />
                <Metric label="Billable" value={cardTime(stats.billable)} detail={stats.tracked ? `${Math.round((stats.billable / stats.tracked) * 100)}% of tracked` : "Nothing kept in this range"} />
                <Metric label="Value" value={dollars(stats.value)} detail="At the rate each entry was kept at" />
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
                    <form className="matter-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
                        <div className="row gap wrap">
                        <label className="field grow"><span className="eyebrow">Name</span><input value={name} title="The matter's name in Time Capture." onChange={(e) => setName(e.target.value)} /></label>
                        <label className="field grow"><span className="eyebrow">Client</span><input value={client} placeholder="Who it is billed to" title="The client this matter is billed to." onChange={(e) => setClient(e.target.value)} /></label>
                        <label className="field rate"><span className="eyebrow">Hourly rate</span><input type="number" min="0" step="5" value={rate} title="The hourly rate for time you keep from now on." onChange={(e) => setRate(e.target.value)} /></label>
                        </div>
                        <div className="row gap wrap">
                        <label className="field rate"><span className="eyebrow">Matter number</span><input value={number} placeholder="104882-0001" title="The client's or the firm's number for this matter, printed on the invoice." onChange={(e) => setNumber(e.target.value)} /></label>
                        <label className="field grow"><span className="eyebrow">Bill to</span><textarea rows={2} value={billTo} placeholder={"Billing contact, Client Inc.\n200 Main Street, Suite 100, City, ST 00000"} title="The invoice's Bill to lines: the client's billing contact and address. The client's name alone without them." onChange={(e) => setBillTo(e.target.value)} /></label>
                        <label className="field rate"><span className="eyebrow">Code set</span>
                            <select value={codeSet} title="The UTBMS code set the client bills this matter under, for its rules." onChange={(e) => setCodeSet(e.target.value)}>
                                <option value="">None</option><option value="project">Project (P)</option><option value="counseling">Counseling (C)</option><option value="litigation">Litigation (L)</option>
                            </select>
                        </label>
                        <button type="submit" className="primary" disabled={!changed || !name.trim() || !(Number(rate) >= 0)} title={changed ? "Save the matter's details." : "Change something first."}>Save</button>
                        </div>
                    </form>
                    <p className="muted tiny">A new rate applies to time you keep from now on; entries already kept keep the rate they were saved with. Renaming carries activity named after this matter along with it. The number, bill-to and code set go on this matter's invoices{w.billing ? "" : " once billing is set up in Settings"}.</p>
                    <div className="row gap wrap">
                        {others.length > 0 && (
                            <>
                                <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="Merge into" title="Pick the matter to merge this one into.">
                                    <option value="">Merge into another matter…</option>
                                    {others.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                                </select>
                                <button type="button" className="quiet" disabled={!into} title={into ? "Move this matter's entries into the one you picked." : "Pick a matter to merge into first."} onClick={() => { const target = others.find((x) => x.id === into); if (target && confirm(`Merge “${p.name}” into “${target.name}”? Its entries move there and “${p.name}” is removed. Times and rates are not changed.`)) void window.lawdie.mergeProjects(p.id, target.id).then((ok) => { if (ok) onBack(); }); }}>Merge</button>
                            </>
                        )}
                        <span className="grow" />
                        <button type="button" className="quiet" title={p.archived ? "Put this matter back on the open list." : "Take this matter off the open list."} onClick={() => void window.lawdie.archiveProject(p.id, !p.archived)}>{p.archived ? "Restore matter" : "Archive matter"}</button>
                    </div>
                </Panel>
            )}
            {waiting.length > 0 && (
                <Panel>
                    <div className="row between"><strong>Waiting in review</strong><button type="button" className="quiet" title="Open the Activity page to review this time." onClick={onReview}>Review in Activity</button></div>
                    {waiting.map((g) => (
                        <div className="entry" key={g.id}>
                            <span className="bar pending" />
                            <div className="grow">
                                <div className="small strong">{g.documents.slice(0, 3).map((d) => d.name).join("; ")}</div>
                                <div className="muted tiny">{g.apps.join(", ")} · {dayLabel(g.startedAt, new Date(now))} {spanLabel(g.startedAt, g.endedAt, g.sittings)} · {g.sittings} {g.sittings === 1 ? "sitting" : "sittings"}</div>
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

type SettingsTab = "capture" | "billing" | "sync" | "data";
const SETTINGS_TABS: { key: SettingsTab; label: string; tip: string }[] = [
    { key: "capture", label: "Capture", tip: "What is captured, how long it is kept, and the apps that stay private." },
    { key: "billing", label: "Billing", tip: "The firm's details on every invoice and time sheet, and the logo." },
    { key: "sync", label: "Sync", tip: "Kiwi and Lawdie CRM." },
    { key: "data", label: "Display & data", tip: "Text size, and where your data lives." },
];
function Settings({ state, now, onRules, onTour, onWelcome, onWhatsNew }: { state: AppState; now: number; onRules: (book: string | null, rule?: string | null) => void; onTour: () => void; onWelcome: () => void; onWhatsNew: () => void }): ReactNode {
    const w = state.workspace, p = w.preferences;
    const [excluded, setExcluded] = useState("");
    const [tab, setTab] = useState<SettingsTab>("capture");
    const tourStep = useContext(TourStepContext);
    useEffect(() => { if (tourStep === "billing-settings") setTab("billing"); }, [tourStep]);
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
            <Heading title="Settings" />
            <div className="segmented settings-tabs" role="tablist" aria-label="Settings" data-tour="settings-tabs">
                {SETTINGS_TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "active" : ""} title={t.tip} data-tour={t.key === "billing" ? "settings-billing" : undefined} onClick={() => setTab(t.key)}>{t.label}</button>)}
            </div>
            {tab === "capture" && <Panel>
                <strong>Desktop capture</strong>
                <Setting title="Capture app activity" detail="Records the foreground app and duration across your desktop. Start and stop at any time. Browsers are left to the Lawdie browser extension, so web time is never counted twice.">
                    <Toggle on={p.captureEnabled} onChange={(v) => void window.lawdie.setCapture(v)} label="Capture app activity" tip={{ on: "Stop recording app activity.", off: "Start recording app activity." }} />
                </Setting>
                <Setting title="Start at login" detail={`Opens Time Capture in the ${isMac ? "menu bar" : "tray"} when you sign in to this ${label}, so capture carries on without you opening the app. If you paused capture, it stays paused.`}>
                    <Toggle on={atLogin} onChange={(v) => void window.lawdie.setOpenAtLogin(v).then(setAtLogin)} label="Start at login" tip={{ on: "Stop opening Time Capture when you sign in.", off: "Open Time Capture when you sign in." }} />
                </Setting>
                <Setting title="Include window titles" detail={isMac ? "Optional context such as document names. Titles may contain sensitive information. macOS asks for Screen Recording permission the first time." : "Optional context such as document names. Titles may contain sensitive information."}>
                    <Toggle on={p.captureTitles} onChange={(v) => set("captureTitles", v)} label="Include window titles" tip={{ on: "Stop reading window titles.", off: "Read window titles for more context." }} />
                </Setting>
                <Setting title="Take screenshots" detail={`A picture of the window you are working in, once you have been in it 20 seconds and then every 5 minutes, so you can see what the time was when you review it. Screenshots show whatever is on that window, client documents included. They stay on this ${label}: never synced to Kiwi or Lawdie CRM and never sent to the AI. Those of time you dismiss are deleted; those of time you keep stay with the entry until you delete it. Never of browsers, private apps or this app.${isMac ? " macOS asks for Screen Recording permission." : ""}`}>
                    <Toggle on={p.captureScreenshots === true} onChange={(v) => set("captureScreenshots", v)} label="Take screenshots" tip={{ on: "Stop taking screenshots.", off: "Take a screenshot of the window in front now and then, kept on this computer." }} />
                </Setting>
                <Setting title="Read Office document details" detail={`For Word, Excel, PowerPoint and Outlook: the open document's name, where it is saved, and its first few lines (Outlook: the sender and subject). Kiwi or Lawdie CRM uses these to match your time to a matter. ${isMac ? "macOS asks once whether Time Capture may control each app." : state.platform === "win32" ? "Nothing to grant on Windows." : "Not available on Linux."}`}>
                    <Toggle on={p.captureDocuments} onChange={(v) => set("captureDocuments", v)} label="Read Office document details" tip={{ on: "Stop reading Office document details.", off: "Read the open Office document's name and first lines." }} />
                </Setting>
                {p.captureDocuments && office && !office.supported && <p className="muted tiny">Not available on this platform.</p>}
                <Setting title="Read on-screen text" detail={`For apps other than Office and browsers, such as Acrobat, Teams or your practice software: some of the text the window in front shows, read through ${isMac ? "macOS Accessibility" : "Windows UI Automation"}, the channel screen readers use. No screenshots. Password fields are never read, at most ${SCREEN_TEXT_MAX} characters are kept per stretch on this ${label}, and they reach Kiwi only to name the matter when matter suggestions are on. ${isMac ? "macOS asks once for Accessibility permission." : state.platform === "win32" ? "Nothing to grant on Windows." : "Not available on Linux."}`}>
                    <Toggle on={p.captureScreenText} onChange={(v) => set("captureScreenText", v)} label="Read on-screen text" tip={{ on: "Stop reading text from the window in front.", off: "Read some text from the window in front." }} />
                </Setting>
                {p.captureScreenText && screen && !screen.supported && <p className="muted tiny">Not available on this platform.</p>}
                {p.captureScreenText && screen?.supported && !screen.trusted && (
                    <p className="danger tiny">macOS has not allowed Lawdie Time Capture to use Accessibility yet. <button type="button" className="link" title="Open the Accessibility settings in System Settings." onClick={() => void window.lawdie.openAccessibilitySettings()}>Open Privacy &amp; Security → Accessibility</button> and switch it on, then quit and reopen the app.</p>
                )}
                {p.captureScreenText && screen?.error && <p className="danger tiny">The last read failed: {screen.error}</p>}
                {p.captureDocuments && office && Object.entries(office.errors).map(([app, message]) => (
                    <p key={app} className="danger tiny">{{ word: "Word", excel: "Excel", powerpoint: "PowerPoint", outlook: "Outlook" }[app] ?? app} did not answer: {message}</p>
                ))}
                <Setting title="AI suggestions" detail="Kiwi's AI names the matter of your finished, unreviewed activity (so the inbox shows a matter's day across every app as one row), drafts a billing description for each row, and writes an insight on each matter's page. It sees titles, Office document details and on-screen text with personal details already removed, and your kept entries' descriptions and times. The activity in progress is never sent. Needs this computer connected to Kiwi below. Off until you switch it on.">
                    <Toggle on={p.suggestMatters} onChange={(v) => set("suggestMatters", v)} label="AI suggestions" tip={{ on: "Stop asking Kiwi's AI for matters and descriptions.", off: "Let Kiwi's AI name matters and draft descriptions." }} />
                </Setting>
                <Setting title="Bring in browser and Kiwi time" detail="Import captured titles and page addresses from Kiwi for review here. AI suggestions also use imported titles. Pausing stops new imports; time already brought in stays assigned to this workspace.">
                    <Toggle on={p.importKiwiTime === true} onChange={(v) => set("importKiwiTime", v)} label="Bring in browser and Kiwi time" tip={{ on: "Stop bringing in browser and Kiwi time.", off: "Bring the browser extension's and Kiwi's time into the Activity inbox." }} />
                </Setting>
                {p.importKiwiTime && <div className="row between wrap gap"><p className="muted tiny">{w.feed?.lastImportedAt ? `Last imported ${ago(w.feed.lastImportedAt, now)}` : "No imports yet"}. {w.sync?.targets.some((t) => t.product === "kiwi") ? "Browser uploads arrive while Kiwi is open." : "Connect to Kiwi below to import."}</p><button className="quiet" type="button" disabled={state.feed.running} onClick={() => void window.lawdie.importNow()}>{state.feed.running ? "Importing…" : "Import now"}</button></div>}
                {state.feed.error && <p className="danger tiny">{state.feed.error}</p>}
                <Setting title="Calendar meetings" detail="Kiwi reads your Google or Outlook calendar, whichever you connected on Kiwi's Integrations page, and this app uses the meetings that end from now on. A Teams or Zoom call this computer counted takes the meeting's name and invitees. A meeting it did not count, such as one in a conference room, comes into review as its own row for the time this computer was not counting something else. Only the meeting's subject and the other invitees' email addresses go to Kiwi's AI, to name the matter. Meetings stay on this computer and are never synced.">
                    <Toggle on={p.importMeetings === true} onChange={(v) => set("importMeetings", v)} label="Calendar meetings" tip={{ on: "Stop bringing in calendar meetings.", off: "Bring Google and Outlook calendar meetings into review." }} />
                </Setting>
                {p.importMeetings && <Setting title="Teams transcripts" detail="After a Teams meeting with time on it, ask Teams for its transcript for up to six hours. It is kept on this computer with the meeting, shown under Why this entry, and quoted when Kiwi's AI drafts the entry's narrative. Teams makes one only when someone started transcription in the meeting, and your firm's Microsoft admin must approve transcript access for Kiwi once.">
                    <Toggle on={p.meetingTranscripts === true} onChange={(v) => set("meetingTranscripts", v)} label="Teams transcripts" tip={{ on: "Stop fetching Teams transcripts.", off: "Fetch Teams transcripts for meetings with time on them." }} />
                </Setting>}
                {p.importMeetings && <div className="row between wrap gap"><p className="muted tiny">{meetingsLine(w, now)}</p><button className="quiet" type="button" disabled={state.meetings.running} onClick={() => void window.lawdie.meetingsNow()}>{state.meetings.running ? "Checking…" : "Check now"}</button></div>}
                {p.importMeetings && state.meetings.error && <p className="danger tiny">{state.meetings.error}</p>}
                {p.suggestMatters && !w.sync?.targets.some((t) => t.product === "kiwi") && <p className="danger tiny">Connect this {label} to Kiwi below to get AI suggestions.</p>}
                {w.demo && <Setting title="Narrative drafter" detail="Who writes each entry's narrative in this demo: the narratives its seed drafted ahead of time, or Kiwi's model from the same sources (each part must name the source it rests on). Entries kept from capture always go to the model.">
                    <div className="segmented" role="radiogroup" aria-label="Narrative drafter">
                        {([["rules", "Rules (demo)", "Use the narratives drafted ahead of time from the sources."], ["model", "Model", "Ask Kiwi's model to write narratives from the sources. Needs this computer connected to Kiwi."]] as const).map(([k, text, tip]) => (
                            <button key={k} type="button" role="radio" aria-checked={(p.narrativeDrafter ?? "rules") === k} className={(p.narrativeDrafter ?? "rules") === k ? "active" : ""} title={tip} onClick={() => set("narrativeDrafter", k)}>{text}</button>
                        ))}
                    </div>
                </Setting>}
                {w.demo && p.narrativeDrafter === "model" && !w.sync?.targets.some((t) => t.product === "kiwi") && <p className="danger tiny">Model not connected. Narratives stay with the rules until this {label} is connected to Kiwi below.</p>}
                <Setting title="Timer idle timeout" detail="Stops a running timer at your last input after this much inactivity. Capture counts the app in front for as long as it is in front, and a call even behind other windows.">
                    <select value={p.idleMinutes} title="How long without input before a running timer stops." onChange={(e) => set("idleMinutes", Number(e.target.value))}>{[1, 3, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select>
                </Setting>
                <Setting title="Activity retention" detail="Older raw activity is removed automatically. Saved time entries are kept.">
                    <select value={p.retentionDays} title="Choose how long raw activity is kept." onChange={(e) => set("retentionDays", Number(e.target.value))}>{[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
                </Setting>
            </Panel>}
            {tab === "billing" && <BillingSettings w={w} onRules={onRules} />}
            {tab === "data" && <Panel>
                <strong>Display</strong>
                <Setting title="Text size" detail="Makes everything in this window larger, for reading on a laptop or from a distance.">
                    <div className="segmented" role="radiogroup" aria-label="Text size">
                        {TEXT_SIZES.map((size, i) => (
                            <button key={size} type="button" role="radio" aria-checked={(p.textSize ?? 1) === size} className={(p.textSize ?? 1) === size ? "active" : ""} onClick={() => set("textSize", size)}>{["Standard", "Large", "Larger"][i]}</button>
                        ))}
                    </div>
                </Setting>
            </Panel>}
            {tab === "capture" && <Panel>
                <strong>Apps that stay private</strong>
                <p className="muted small">Excluded apps are skipped before any window title is read. {isMac ? "Enter a bundle identifier, such as com.apple.Safari." : "Enter the program's file name, such as chrome.exe."}</p>
                <div className="chips">{p.excludedOwnerIDs.map((id) => <span key={id} className="chip mono">{id}<button type="button" aria-label={`Stop excluding ${id}`} title={`Stop excluding ${id}.`} onClick={() => set("excludedOwnerIDs", p.excludedOwnerIDs.filter((x) => x !== id))}>×</button></span>)}</div>
                <form className="row gap" onSubmit={(e) => { e.preventDefault(); const v = excluded.trim(); if (v && !p.excludedOwnerIDs.includes(v)) set("excludedOwnerIDs", [...p.excludedOwnerIDs, v]); setExcluded(""); }}>
                    <input value={excluded} title={isMac ? "Type an app's bundle identifier to keep it private." : "Type a program's file name to keep it private."} onChange={(e) => setExcluded(e.target.value)} placeholder={isMac ? "com.example.private-app" : "private-app.exe"} />
                    <button type="submit" className="quiet" title="Skip this app when capture runs.">Exclude</button>
                </form>
            </Panel>}
            {tab === "data" && <Panel>
                <strong>Learn the app</strong>
                <Setting title="Tutorial" detail="Walks the four screens with a sample stretch of work in the Activity inbox: what capture records, how a stretch is kept, where kept time goes, client rules, imports, time sheets and invoices. Nothing it does is saved.">
                    <button type="button" className="quiet" title="Start the tutorial on the Activity screen." onClick={onTour}>Start the tutorial</button>
                </Setting>
                <Setting title="Welcome" detail="The welcome shown the first time the app opened: what it does, what to capture, connecting to Kiwi or Lawdie CRM, and the firm's details for the bill.">
                    <button type="button" className="quiet" title="Show the welcome again." onClick={onWelcome}>Show the welcome</button>
                </Setting>
                <Setting title="What's new" detail={`What changed in the latest update (version ${LATEST_RELEASE.id}: ${LATEST_RELEASE.title.toLowerCase()}), and every update before it.`}>
                    <button type="button" className="quiet" title="Show what changed in recent updates." onClick={onWhatsNew}>See what's new</button>
                </Setting>
            </Panel>}
            {tab === "data" && <Panel>
                <strong>Diagnostics</strong>
                <Setting title="Send crash reports to Lawdie" detail="When something in the app fails, the error and which features were on are sent to Lawdie so it can be fixed. A report never includes what was on your screen: no titles, documents, text, matters or descriptions.">
                    <Toggle on={p.crashReports !== false} onChange={(v) => set("crashReports", v)} label="Send crash reports" tip={{ on: "Stop sending crash reports to Lawdie.", off: "Send crash reports to Lawdie when the app fails." }} />
                </Setting>
            </Panel>}
            {tab === "data" && <Panel>
                <strong>Your data belongs here</strong>
                <p className="muted small">No usage tracking, keystroke recording, or local network service, and no screenshots unless you switch them on above; they never leave this {label}. A crash report, if you leave them on above, carries the error alone. Nothing leaves this {label} unless you connect Kiwi or Lawdie CRM below, and then only captured activity and your time entries, or switch on matter suggestions above, and then only what Kiwi needs to name the matter. Data is a local file protected by your account permissions; it is not separately encrypted.</p>
                <p className="mono tiny muted">{state.workspacePath}</p>
                <div className="row gap">
                    <button type="button" className="quiet" title="Open the folder that holds the workspace file." onClick={() => void window.lawdie.showDataFolder()}>Show data folder</button>
                    <span className="grow" />
                    <button type="button" className="quiet danger" title="Delete all captured activity. Saved time entries stay." onClick={() => { if (confirm("Clear all captured desktop activity? Saved time entries are kept and capture is paused.")) void window.lawdie.clearActivity(); }}>Clear activity…</button>
                </div>
            </Panel>}
            {tab === "sync" && <Panel>
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
                        <label className="row gap check" title={w.sync.autoSync ? "Stop syncing on its own. Use Sync now instead." : "Sync in the background without a click."}><input type="checkbox" checked={w.sync.autoSync} title={w.sync.autoSync ? "Stop syncing on its own. Use Sync now instead." : "Sync in the background without a click."} onChange={(e) => void window.lawdie.setAutoSync(e.target.checked)} /> Sync automatically, about once a minute</label>
                        <div className="row gap">
                            <button type="button" className="primary" disabled={state.syncing} title="Send captured activity and kept time now." onClick={() => void window.lawdie.syncNow()}>{state.syncing ? "Syncing…" : "Sync now"}</button>
                            <button type="button" className="quiet" disabled={state.syncing} title={`Stop syncing this ${label}.`} onClick={() => void window.lawdie.disconnectKiwi()}>Disconnect</button>
                        </div>
                        <p className="muted tiny">What syncs: captured activity (app names, durations, and window titles and Office document details if you switched them on) and the time entries you keep. {product} matches a stretch to a matter only when its title or document names exactly one, never from your local project label.{w.sync.targets.some((t) => t.product === "kiwi") ? " In Kiwi, billable kept entries become drafts on the Time page for you to approve, under “No matter” when nothing matched; deleting an entry here dismisses its draft there." : ""}{w.sync.targets.some((t) => t.product === "crm") ? " In Lawdie CRM, a kept entry with a matter lands on the ledger at the next sync and one without waits on its Time page for you to name the matter; deleting an entry here removes it there unless it has been billed." : ""}</p>
                    </>
                ) : (
                    <>
                        <div className="segmented" role="radiogroup" aria-label="Sync destination">
                            {(Object.keys(DESTINATION_LABELS) as Destination[]).map((d) => (
                                <button key={d} type="button" role="radio" aria-checked={destination === d} className={destination === d ? "active" : ""} title={d === "both" ? "Sync to Kiwi and Lawdie CRM." : `Sync to ${DESTINATION_LABELS[d]}.`} onClick={() => setDestination(d)}>{DESTINATION_LABELS[d]}</button>
                            ))}
                        </div>
                        <p className="muted small">{pairHint(destination)} Paste the token it shows here; it is shown once. Until you connect, nothing leaves this {label}.</p>
                        <form className="row gap" onSubmit={(e) => { e.preventDefault(); void window.lawdie.connectKiwi(destination, servers, token).then((ok) => { if (ok) setToken(""); }); }}>
                            <input type="password" value={token} title={`Paste the pairing token from ${product}.`} onChange={(e) => setToken(e.target.value)} placeholder={`ldt_… token from ${product}`} autoComplete="off" />
                            <button type="submit" className="primary" disabled={state.syncing || !token.trim()} title={token.trim() ? `Connect this ${label} to ${product}.` : "Paste a token first."}>{state.syncing ? "Connecting…" : "Connect"}</button>
                        </form>
                        <button type="button" className="link" title={advanced ? "Hide the server addresses." : "Change the server addresses."} onClick={() => setAdvanced(!advanced)}>{advanced ? "▾" : "▸"} Server {productsFor(destination).length > 1 ? "addresses" : "address"}</button>
                        {advanced && productsFor(destination).map((p) => (
                            <div key={p} className="row gap">
                                <span className="muted small">{PRODUCTS[p].label}</span>
                                <input value={servers[p]} onChange={(e) => setServers({ ...servers, [p]: e.target.value })} aria-label={`${PRODUCTS[p].label} server`} title={`The ${PRODUCTS[p].label} server address.`} />
                                <span className="muted tiny">Change only for a self-hosted or local {PRODUCTS[p].label}.</span>
                            </div>
                        ))}
                    </>
                )}
            </Panel>}
        </>
    );
}

// ---------------------------------------------------------------------------

/** A permission a switched-on feature needs: stays until macOS allows it, since dismissing it would not. */
function PermissionCallout({ pane, title, what }: { pane: "screen" | "accessibility"; title: string; what: string }): ReactNode {
    const name = pane === "screen" ? "Screen Recording" : "Accessibility";
    return (
        <section className="callout danger" role="alert">
            <div className="grow">
                <p className="callout-title">{title}</p>
                <p>{what}</p>
                <ol>
                    <li>Open System Settings → Privacy &amp; Security → {name}.</li>
                    <li>If Lawdie Time Capture is listed, switched on or not, select it and remove it with −. That entry is an earlier version.</li>
                    <li>Add it again with + (or reopen the app and allow it when asked), then reopen the app.</li>
                </ol>
            </div>
            <div className="callout-actions">
                <button type="button" className="primary" onClick={() => void window.lawdie.openPrivacySettings(pane)}>Open {name} settings</button>
                <button type="button" className="quiet" onClick={() => void window.lawdie.relaunch()}>Reopen the app</button>
            </div>
        </section>
    );
}
/** Time on a card: "None" when there is none, else hours and minutes ("1h 05m", "12m"), never seconds. */
const cardTime = (secs: number): string => (secs < 30 ? "None" : duration(Math.max(60, Math.round(secs / 60) * 60)));
function Metric({ label, value, detail }: { label: string; value: string; detail: string }): ReactNode {
    return <section className="panel metric"><p className="muted small">{label}</p><p className="value">{value}</p><p className="muted tiny">{detail}</p></section>;
}
function Banner({ children, tone, onClose }: { children: ReactNode; tone?: "danger"; onClose: () => void }): ReactNode {
    return <div className={"banner" + (tone ? " " + tone : "")} role={tone ? "alert" : "status"}><span className="grow">{children}</span><button type="button" className="icon" aria-label="Dismiss" title="Close this message." onClick={onClose}>×</button></div>;
}

/** What the calendar switch has done: each calendar's state, in words, and when it last looked. */
function meetingsLine(w: Workspace, now: number): string {
    if (!w.sync?.targets.some((t) => t.product === "kiwi")) return "Connect this computer to Kiwi below to bring in meetings.";
    const m = w.meetings;
    if (!m?.lastFetchedAt) return "No meetings checked yet.";
    const name = { google: "Google Calendar", microsoft: "Outlook calendar" } as const;
    const says = m.calendars.filter((c) => c.status !== "not_connected").map((c) => c.status === "ok" ? `${name[c.provider]}${c.email ? ` (${c.email})` : ""} connected` : c.status === "reconnect" || c.status === "no_calendar" ? `${name[c.provider]}: reconnect ${c.provider === "google" ? "Google" : "Microsoft"} on Kiwi's Integrations page to allow calendar access` : `${name[c.provider]} could not be read`);
    const list = says.length ? says.join(". ") : "No calendar is connected in Kiwi. Connect Google or Microsoft on Kiwi's Integrations page";
    return `${list}. Last checked ${ago(m.lastFetchedAt, now)}.`;
}

/** " · with jane@acme.com and 2 more" for a row that was a calendar meeting, else nothing. */
function meetingWith(a: { meeting?: { with: string[] } } | undefined): string {
    const who = a?.meeting?.with ?? [];
    return who.length ? ` · with ${who[0]}${who.length > 1 ? ` and ${who.length - 1} more` : ""}` : "";
}
