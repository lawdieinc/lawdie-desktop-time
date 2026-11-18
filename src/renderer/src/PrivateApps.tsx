/**
 * Settings → Capture → "Apps that stay private": the excluded apps as apps (icon and name), and a sheet to pick more
 * from the apps on this computer and the apps capture has seen (src/shared/appExclusions.ts). 2026-11-18.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isBrowser, type Workspace } from "@shared/model";
import { appChoices, excludedApps, isOnList, searchApps, usedApps, withExclusions, type AppChoice } from "@shared/appExclusions";
import { duration } from "@shared/format";

function AppIcon({ app }: { app: AppChoice }): ReactNode {
    const [src, setSrc] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        if (app.path) void window.lawdie.appIcon(app.path).then((u) => { if (live) setSrc(u); });
        return () => { live = false; };
    }, [app.path]);
    return src ? <img className="app-icon" src={src} alt="" /> : <span className="app-icon blank" aria-hidden="true">{app.name.slice(0, 1).toUpperCase()}</span>;
}

let installedOnce: Promise<AppChoice[]> | null = null;
const installed = (): Promise<AppChoice[]> => (installedOnce ??= window.lawdie.installedApps().catch(() => []));

export function PrivateApps({ w, isMac, onChange }: { w: Workspace; isMac: boolean; onChange: (ids: string[]) => void }): ReactNode {
    const excluded = w.preferences.excludedOwnerIDs;
    const [apps, setApps] = useState<AppChoice[] | null>(null);
    const [picking, setPicking] = useState(false);
    useEffect(() => { void installed().then(setApps); }, []);
    const used = useMemo(() => usedApps(w), [w.activities]);
    const choices = useMemo(() => appChoices(apps ?? [], used), [apps, used]);
    const listed = excludedApps(excluded, choices, isMac ? "darwin" : "other");
    return (
        <>
            <div className="private-apps">
                {listed.map((a) => (
                    <div key={a.id} className="private-app">
                        <AppIcon app={a} />
                        <span className="private-app-name"><span>{a.name}</span>{!a.named && <span className="muted small mono">{a.id}</span>}</span>
                        <button type="button" className="quiet" title={`Capture ${a.name} again.`} aria-label={`Stop keeping ${a.name} private`} onClick={() => onChange(excluded.filter((x) => x !== a.id))}>Remove</button>
                    </div>
                ))}
                {!listed.length && <p className="muted small">No apps are kept private.</p>}
            </div>
            <div className="row gap">
                <button type="button" className="primary" title="Pick apps on this computer to keep private." onClick={() => setPicking(true)}>Add apps…</button>
            </div>
            {picking && <PickApps loading={apps === null} choices={choices} used={used} excluded={excluded} isMac={isMac} onClose={() => setPicking(false)} onAdd={(ids) => { onChange(withExclusions(excluded, ids)); setPicking(false); }} />}
        </>
    );
}

function PickApps({ loading, choices, used, excluded, isMac, onClose, onAdd }: { loading: boolean; choices: AppChoice[]; used: AppChoice[]; excluded: readonly string[]; isMac: boolean; onClose: () => void; onAdd: (ids: string[]) => void }): ReactNode {
    const [query, setQuery] = useState("");
    const [ticked, setTicked] = useState<AppChoice[]>([]);
    const [problem, setProblem] = useState<string | null>(null);
    const on = (a: AppChoice) => isOnList(excluded, a.id) || isOnList(ticked.map((t) => t.id), a.id);
    const toggle = (a: AppChoice) => { if (isOnList(excluded, a.id)) return; setTicked((t) => (isOnList(t.map((x) => x.id), a.id) ? t.filter((x) => x.id.toLowerCase() !== a.id.toLowerCase()) : [...t, a])); };
    const recent = query.trim() ? [] : used.slice(0, 6).map((u) => choices.find((c) => c.id.toLowerCase() === u.id.toLowerCase()) ?? u);
    const all = searchApps(choices, query);
    const chosen = ticked.filter((t) => !choices.some((c) => c.id.toLowerCase() === t.id.toLowerCase()));
    const choose = async (): Promise<void> => {
        setProblem(null);
        const a = await window.lawdie.chooseApp();
        if (!a) return;
        if (isBrowser(a.id)) { setProblem("Browsers are never captured, so there is no need to keep one private."); return; }
        if (!isOnList(excluded, a.id) && !isOnList(ticked.map((t) => t.id), a.id)) setTicked((t) => [...t, a]);
    };
    const row = (a: AppChoice, where: string) => (
        <label key={`${where}-${a.id}`} className={"pick-app" + (isOnList(excluded, a.id) ? " already" : "")}>
            <input type="checkbox" checked={on(a)} disabled={isOnList(excluded, a.id)} onChange={() => toggle(a)} />
            <AppIcon app={a} />
            <span className="pick-app-name">{a.name}</span>
            <span className="muted small">{isOnList(excluded, a.id) ? "Already private" : a.seconds ? `${duration(a.seconds)} captured` : ""}</span>
        </label>
    );
    return createPortal(
        <div className="scrim" onClick={onClose}>
            <form className="sheet pick-apps" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (ticked.length) onAdd(ticked.map((t) => t.id)); }}>
                <div className="heading">
                    <p className="eyebrow">Capture</p>
                    <h2 className="display">Keep apps private</h2>
                    <p className="muted small">Nothing is recorded while a private app is in front: not its name, its window titles or its time. Browsers are not listed; they are never captured here.</p>
                </div>
                <input autoFocus type="search" value={query} placeholder="Search apps" title="Find an app by its name." onChange={(e) => setQuery(e.target.value)} />
                <div className="pick-app-list">
                    {chosen.length > 0 && <><p className="eyebrow">Chosen</p>{chosen.map((a) => row(a, "chosen"))}</>}
                    {recent.length > 0 && <><p className="eyebrow">Apps you have used</p>{recent.map((a) => row(a, "used"))}<p className="eyebrow">All apps</p></>}
                    {all.map((a) => row(a, "all"))}
                    {loading && <p className="muted small">Finding the apps on this {isMac ? "Mac" : "computer"}…</p>}
                    {!loading && !all.length && query.trim() && <p className="muted small">No app matches “{query}”. Choose its file instead.</p>}
                </div>
                {problem && <p className="danger small">{problem}</p>}
                <div className="row between">
                    <button type="button" className="quiet" title={isMac ? "Pick an app from the Applications folder." : "Pick the program's file."} onClick={() => void choose()}>Choose an app file…</button>
                    <span className="row gap">
                        <button type="button" className="quiet" onClick={onClose}>Cancel</button>
                        <button type="submit" className="primary" disabled={!ticked.length} title={ticked.length ? "Keep the ticked apps private." : "Tick the apps to keep private."}>{ticked.length ? `Keep ${ticked.length === 1 ? ticked[0].name : `${ticked.length} apps`} private` : "Keep private"}</button>
                    </span>
                </div>
            </form>
        </div>,
        document.body,
    );
}
