import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AppState } from "@shared/state";
import { DESTINATION_LABELS, PRODUCTS, destinationLabel, pairHint, productsFor, type Destination, type Product } from "@shared/kiwi";
import { TOUR_STEPS, type TourStep } from "@shared/onboarding";
import { Setting, Toggle } from "./ui";

/* The welcome a new person sees once (a sheet over the window, four steps, the switches live),
   and the tutorial: a card that walks the real screens, pointing at one control a step through a
   spotlight. The steps are data in src/shared/onboarding.ts; the sample row the Keep steps use is
   the Activity screen's (App.tsx), shown only while the tutorial runs. */

type WelcomeStep = "welcome" | "capture" | "connect" | "done";
const WELCOME_STEPS: WelcomeStep[] = ["welcome", "capture", "connect", "done"];

export function Welcome({ state, onDone }: { state: AppState; onDone: (startTour: boolean) => void }): ReactNode {
    const [step, setStep] = useState<WelcomeStep>("welcome");
    const w = state.workspace, p = w.preferences;
    const isMac = state.platform === "darwin";
    const machine = isMac ? "Mac" : "computer";
    const n = WELCOME_STEPS.indexOf(step);
    const set = <K extends keyof typeof p>(key: K, value: (typeof p)[K]): void => void window.lawdie.setPreference(key, value);
    const [atLogin, setAtLogin] = useState(false);
    useEffect(() => { void window.lawdie.openAtLogin().then(setAtLogin); }, []);
    const [destination, setDestination] = useState<Destination>("kiwi");
    const [token, setToken] = useState("");
    const [servers] = useState<Record<Product, string>>({ kiwi: PRODUCTS.kiwi.defaultServerURL, crm: PRODUCTS.crm.defaultServerURL });
    const product = destinationLabel(w.sync ? w.sync.targets.map((t) => t.product) : productsFor(destination));
    const on = [p.captureEnabled && "capture", p.captureTitles && "window titles", p.captureDocuments && "Office document details", atLogin && "start at login"].filter(Boolean) as string[];
    return (
        <div className="scrim welcome-scrim" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
            <div className="sheet welcome">
                <div className="row between">
                    <p className="eyebrow">Welcome · {n + 1} of {WELCOME_STEPS.length}</p>
                    <div className="welcome-dots" aria-hidden="true">{WELCOME_STEPS.map((s) => <span key={s} className={s === step ? "on" : ""} />)}</div>
                </div>
                {step === "welcome" && (
                    <>
                        <div className="heading"><h2 className="display" id="welcome-title">Your time, on your {machine}.</h2><p className="muted">Lawdie Time Capture watches which app is in front while you work, so the day's time is there to review instead of reconstructed from memory.</p></div>
                        <ol className="welcome-list">
                            <li><strong>Capture.</strong> App names and durations, only while capture is on. Browsers are left to the Lawdie browser extension, and the apps you exclude are never read.</li>
                            <li><strong>Review.</strong> Work waits in the Activity inbox as stretches: the sittings on one document, grouped. Keep what is billable, dismiss the rest.</li>
                            <li><strong>Bill.</strong> Kept time lands on the Time screen by matter, with rates frozen when you keep it, ready for a time sheet, an invoice, Kiwi or Lawdie CRM.</li>
                        </ol>
                        <p className="muted small">Nothing leaves this {machine} unless you connect it to Kiwi or Lawdie CRM, and then only captured activity and the time you keep. No keystrokes, no screenshots unless you switch them on.</p>
                    </>
                )}
                {step === "capture" && (
                    <>
                        <div className="heading"><h2 className="display" id="welcome-title">What to capture</h2><p className="muted">Each of these can be changed later in Settings → Capture.</p></div>
                        <div className="welcome-settings">
                            <Setting title="Capture app activity" detail="The app in front and how long it stayed there. Off until you switch it on; pause it any time from the sidebar or the tray.">
                                <Toggle on={p.captureEnabled} onChange={(v) => void window.lawdie.setCapture(v)} label="Capture app activity" tip={{ on: "Stop recording app activity.", off: "Start recording app activity." }} />
                            </Setting>
                            <Setting title="Include window titles" detail={`Document and email names, which tell which matter the time was. Titles can hold client details; they stay on this ${machine} unless you connect.${isMac ? " macOS asks for Screen Recording the first time." : ""}`}>
                                <Toggle on={p.captureTitles} onChange={(v) => set("captureTitles", v)} label="Include window titles" tip={{ on: "Stop reading window titles.", off: "Read window titles for more context." }} />
                            </Setting>
                            <Setting title="Read Office document details" detail={`The open Word, Excel, PowerPoint or Outlook item's name, where it is saved and its first lines.${isMac ? " macOS asks once whether Time Capture may control each app." : state.platform === "win32" ? " Nothing to grant on Windows." : " Not available on Linux."}`}>
                                <Toggle on={p.captureDocuments} onChange={(v) => set("captureDocuments", v)} label="Read Office document details" tip={{ on: "Stop reading Office document details.", off: "Read the open Office document's name and first lines." }} />
                            </Setting>
                            <Setting title="Start at login" detail={`Opens Time Capture in the ${isMac ? "menu bar" : "tray"} when you sign in, so capture carries on without you opening the app.`}>
                                <Toggle on={atLogin} onChange={(v) => void window.lawdie.setOpenAtLogin(v).then(setAtLogin)} label="Start at login" tip={{ on: "Stop opening Time Capture when you sign in.", off: "Open Time Capture when you sign in." }} />
                            </Setting>
                        </div>
                    </>
                )}
                {step === "connect" && (
                    <>
                        <div className="heading"><h2 className="display" id="welcome-title">Connect to Kiwi or Lawdie CRM</h2><p className="muted">Optional. Connected, the time you keep syncs there about once a minute, and Kiwi's AI can name matters and draft descriptions. Not connected, everything still works, on this {machine} alone.</p></div>
                        {w.sync ? (
                            <p className="small strong"><span className="dot on" /> Connected to {product}{w.sync.targets[0]?.accountEmail ? ` as ${w.sync.targets[0].accountEmail}` : ""}.</p>
                        ) : (
                            <>
                                <div className="segmented" role="radiogroup" aria-label="Sync destination">
                                    {(Object.keys(DESTINATION_LABELS) as Destination[]).map((d) => (
                                        <button key={d} type="button" role="radio" aria-checked={destination === d} className={destination === d ? "active" : ""} title={d === "both" ? "Sync to Kiwi and Lawdie CRM." : `Sync to ${DESTINATION_LABELS[d]}.`} onClick={() => setDestination(d)}>{DESTINATION_LABELS[d]}</button>
                                    ))}
                                </div>
                                <p className="muted small">{pairHint(destination)} Paste the token it shows here; it is shown once.</p>
                                <form className="row gap" onSubmit={(e) => { e.preventDefault(); void window.lawdie.connectKiwi(destination, servers, token).then((ok) => { if (ok) setToken(""); }); }}>
                                    <input type="password" value={token} title={`Paste the pairing token from ${product}.`} onChange={(e) => setToken(e.target.value)} placeholder={`ldt_… token from ${product}`} autoComplete="off" />
                                    <button type="submit" className="primary" disabled={state.syncing || !token.trim()} title={token.trim() ? `Connect this ${machine} to ${product}.` : "Paste a token first."}>{state.syncing ? "Connecting…" : "Connect"}</button>
                                </form>
                                {state.error && <p className="danger small">{state.error}</p>}
                                <p className="muted tiny">A different server address, for a self-hosted Kiwi or CRM, is under Settings → Sync.</p>
                            </>
                        )}
                        {w.sync?.targets.some((t) => t.product === "kiwi") && (
                            <Setting title="AI suggestions" detail="Kiwi's AI names the matter of each finished stretch and drafts its billing description. The activity in progress is never sent. Your own names and descriptions are never overwritten.">
                                <Toggle on={p.suggestMatters} onChange={(v) => set("suggestMatters", v)} label="AI suggestions" tip={{ on: "Stop asking Kiwi's AI for matters and descriptions.", off: "Let Kiwi's AI name matters and draft descriptions." }} />
                            </Setting>
                        )}
                    </>
                )}
                {step === "done" && (
                    <>
                        <div className="heading"><h2 className="display" id="welcome-title">You're set.</h2><p className="muted">{on.length ? `On: ${on.join(", ")}.` : "Capture is still off; switch it on from the sidebar when you are ready."} {w.sync ? `Kept time syncs to ${product}.` : "Nothing leaves this " + machine + " until you connect."}</p></div>
                        <p className="small">Work as usual. When you like, open <strong>Activity</strong>: each stretch of work waits there with its time, and <strong>Keep time</strong> turns it into an entry. A two-minute tutorial walks the screens with a sample stretch; nothing it does is saved.</p>
                    </>
                )}
                <div className="row between welcome-actions">
                    {n > 0 ? <button type="button" className="quiet" title="Go back a step." onClick={() => setStep(WELCOME_STEPS[n - 1])}>Back</button> : <span />}
                    <span className="row gap">
                        {step !== "done" && (step !== "connect" || w.sync) && <button type="button" className="link" title="Close the welcome. Everything here is in Settings." onClick={() => onDone(false)}>Skip</button>}
                        {step === "done" ? (
                            <>
                                <button type="button" className="quiet" title="Close the welcome and use the app." onClick={() => onDone(false)}>Start working</button>
                                <button type="button" className="primary" title="Walk the screens with a sample stretch of work. Nothing is saved." onClick={() => onDone(true)}>Take the tutorial</button>
                            </>
                        ) : (
                            <button type="button" className="primary" title={step === "connect" && !w.sync ? "Go on without connecting; you can connect later in Settings." : "Next step."} onClick={() => setStep(WELCOME_STEPS[n + 1])}>{step === "connect" && !w.sync ? "Skip for now" : "Next"}</button>
                        )}
                    </span>
                </div>
            </div>
        </div>
    );
}

type Rect = { left: number; top: number; width: number; height: number };
const same = (a: Rect | null, b: Rect | null): boolean => (!a && !b) || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
const CARD_WIDTH = 380;

/** Where the step's control is on screen now, or null when it is not showing. */
function measure(target: string | null): Rect | null {
    if (!target) return null;
    const el = [...document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)].find((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * The tutorial's card and spotlight. `step` indexes TOUR_STEPS; the parent opens the step's route and
 * tells the Keep steps when the sheet opens and closes. The spotlight is a hole in a dim layer that
 * lets every click through, so the screen stays usable while the card explains it.
 */
export function Tour({ step, onStep, onEnd }: { step: number; onStep: (n: number) => void; onEnd: () => void }): ReactNode {
    const s: TourStep = TOUR_STEPS[step];
    const [rect, setRect] = useState<Rect | null>(null);
    const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
    const card = useRef<HTMLDivElement>(null);
    const scrolled = useRef<string | null>(null);
    // The control can move: the route just changed, a list unfolded, the window resized, the page scrolled. Measured often, set only when it moved.
    useEffect(() => {
        let last: Rect | null | undefined;
        const tick = (): void => {
            const r = measure(s.target);
            if (last === undefined || !same(r, last)) { last = r; setRect(r); }
            if (r && scrolled.current !== s.id) {
                scrolled.current = s.id;
                document.querySelector<HTMLElement>(`[data-tour="${s.target}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
            }
        };
        tick();
        const t = setInterval(tick, 150);
        return () => clearInterval(t);
    }, [s]);
    useLayoutEffect(() => {
        const el = card.current;
        if (!el) return;
        const h = el.offsetHeight, W = window.innerWidth, H = window.innerHeight, gap = 14;
        if (!rect) { setPos({ left: Math.round((W - CARD_WIDTH) / 2), top: Math.round((H - h) / 2) }); return; }
        let left = rect.left, top: number;
        if (rect.left + rect.width + gap + CARD_WIDTH <= W && rect.width < 320) { left = rect.left + rect.width + gap; top = rect.top; }
        else if (rect.top + rect.height + gap + h <= H) top = rect.top + rect.height + gap;
        else if (rect.top - gap - h >= 8) top = rect.top - gap - h;
        else top = Math.max(8, H - h - 8);
        setPos({ left: Math.max(8, Math.min(left, W - CARD_WIDTH - 8)), top: Math.max(8, Math.min(top, H - h - 8)) });
    }, [rect, step]);
    const last = step === TOUR_STEPS.length - 1;
    return createPortal(
        <>
            {rect ? <div className="tour-spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} aria-hidden="true" /> : <div className="tour-dim" aria-hidden="true" />}
            <div ref={card} className="tour-card" role="dialog" aria-labelledby="tour-title" style={pos ? { left: pos.left, top: pos.top, width: CARD_WIDTH } : { left: -9999, top: 0, width: CARD_WIDTH }}>
                <p className="eyebrow">Tutorial · {step + 1} of {TOUR_STEPS.length}</p>
                <h3 id="tour-title" className="display">{s.title}</h3>
                <p className="small">{s.body}</p>
                {s.target && !rect && <p className="muted tiny">The part this step describes is not on screen right now.</p>}
                <div className="row between">
                    <button type="button" className="link" title="Close the tutorial. Start it again from Settings → Display & data." onClick={onEnd}>End tutorial</button>
                    <span className="row gap">
                        {step > 0 && <button type="button" className="quiet" title="Go back a step." onClick={() => onStep(step - 1)}>Back</button>}
                        <button type="button" className="primary" title={last ? "Close the tutorial." : "Next step."} onClick={() => (last ? onEnd() : onStep(step + 1))}>{last ? "Finish" : "Next"}</button>
                    </span>
                </div>
            </div>
        </>,
        document.body,
    );
}
