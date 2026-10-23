/* The observation layer: which app is in front (or which call is going on behind it), how
   long since the last input, and whether the machine is asleep or locked. get-windows
   answers the first on macOS, Windows and Linux (X11), MicrophoneProbe the call, and
   Electron's powerMonitor the rest everywhere.
   Everything it learns goes through observe() in the shared model; nothing is decided here. */

import { powerMonitor, systemPreferences } from "electron";
import { activeCall, callApp, type CallApp } from "@shared/calls";
import { closeActivity, isBrowser, isExcluded, observe, prune, screenRecordingAttempt, stopTimer, type Observation } from "@shared/model";
import { MicrophoneProbe } from "./calls";
import { OfficeProbe, officeApp } from "./office";
import { ScreenTextReader } from "./screenText";
import type { Store } from "./store";

export const SAMPLE_MS = 5_000;

type ForegroundWindow = { id: number; title: string; owner: { name: string; processId: number; bundleId?: string; path: string } };
type WindowOptions = { screenRecordingPermission?: boolean; accessibilityPermission?: boolean };
type GetWindows = { activeWindow(options?: WindowOptions): Promise<ForegroundWindow | undefined>; openWindows(options?: WindowOptions): Promise<ForegroundWindow[]> };

let getWindows: GetWindows | null = null;
async function loadGetWindows(): Promise<GetWindows> {
    // get-windows is ESM-only; the main bundle is CommonJS.
    getWindows ??= (await import("get-windows")) as GetWindows;
    return getWindows;
}

const ownerOf = (win: ForegroundWindow): string => (process.platform === "darwin" ? win.owner.bundleId || win.owner.path : win.owner.path);

export class Capture {
    private suspended = false;
    private timer: NodeJS.Timeout | null = null;
    private ticks = 0;
    private sampling = false;
    /** macOS refused Screen Recording (window titles need it): capture goes on without titles until it is allowed. */
    titlesRefused = false;
    /** macOS's own prompt is raised at most once a run: get-windows' check raises it every time it fails. */
    private asked = false;
    /** Last observation, for the window's "Currently in …" line and for tests. */
    lastForeground: Observation = null;

    readonly office = new OfficeProbe();
    readonly screen = new ScreenTextReader();
    readonly mic = new MicrophoneProbe();

    constructor(private readonly store: Store) {}

    start(): void {
        this.timer = setInterval(() => void this.tick(), SAMPLE_MS);
        const monitor = powerMonitor as unknown as { on(event: string, listener: () => void): void };
        for (const event of ["suspend", "lock-screen", "shutdown"]) monitor.on(event, () => this.suspend());
        for (const event of ["resume", "unlock-screen"]) monitor.on(event, () => { this.suspended = false; void this.sample(); });
        void this.sample();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private async tick(): Promise<void> {
        this.ticks += 1;
        await this.sample();
        if (this.ticks % 720 === 0) this.store.change((w) => prune(w, Date.now())); // hourly
    }

    async sample(): Promise<void> {
        if (this.sampling || this.store.loadFailed) return;
        this.sampling = true;
        try {
            const prefs = this.store.workspace.preferences;
            let foreground: Observation = null;
            if (prefs.captureEnabled && !this.suspended) {
                // A call in progress gets the time wherever the focus is (src/shared/calls.ts).
                const call = activeCall(await this.mic.recording());
                try {
                    // Exclusions are checked in observe() BEFORE any title is used; the title is
                    // only asked for at all when titles are on (macOS needs Screen Recording for it).
                    const win = await this.foreground(prefs.captureTitles).catch((err) => { if (!call) throw err; });
                    if (call && (!win || callApp(ownerOf(win))?.key !== call.app.key)) {
                        foreground = await this.callWindow(call, prefs.captureTitles);
                    } else if (win) {
                        const ownerID = ownerOf(win);
                        foreground = { app: win.owner.name || ownerID, ownerID, title: prefs.captureTitles ? (win.title ?? "").slice(0, 300) : null, isSelf: win.owner.processId === process.pid };
                        // Office document details are asked for only when switched on, only for
                        // the app in front, and never for an excluded app (observe() checks
                        // exclusions before using anything, but the ask itself is avoided too).
                        // Nothing inside an excluded app, a browser (the extension's) or this app is read.
                        const readable = !isExcluded(prefs, ownerID) && !isBrowser(ownerID) && !foreground.isSelf;
                        if (prefs.captureDocuments && readable && officeApp(ownerID)) {
                            foreground.document = await this.office.probe(ownerID);
                        } else if (prefs.captureScreenText && readable) {
                            // Office with document details on is asked directly above; everything else is read off the screen.
                            foreground.screenText = await this.screen.read(ownerID, win.title ?? "", { pid: win.owner.processId, hwnd: win.id });
                        }
                    }
                } catch (err) {
                    console.warn("[capture] foreground unavailable", err instanceof Error ? err.message : err);
                }
            }
            this.lastForeground = foreground;
            const idle = powerMonitor.getSystemIdleTime();
            const now = Date.now();
            const hadTimer = this.store.workspace.timer !== null;
            const ok = this.store.change((w) => observe(w, foreground, now, idle, this.suspended));
            if (ok && hadTimer && this.store.workspace.timer === null) this.store.say("Timer stopped at your last active moment. Your time is saved; restart when you're ready.");
        } finally {
            this.sampling = false;
        }
    }

    /**
     * The window in front. With titles on, macOS needs Screen Recording, and without it the
     * lookup fails outright; that must cost the titles, never the capture. An update can
     * lose the permission (an ad hoc signature is a new app to macOS, though System Settings
     * still shows the old grant switched on), so this is not rare.
     */
    private async foreground(titles: boolean): Promise<ForegroundWindow | undefined> {
        const ask = (options: WindowOptions) => loadGetWindows().then((gw) => gw.activeWindow(options));
        if (!titles || process.platform !== "darwin") return ask({ screenRecordingPermission: titles, accessibilityPermission: false });
        // macOS answers for a run: a grant takes effect when the app is reopened.
        if (screenRecordingAttempt(systemPreferences.getMediaAccessStatus("screen"), this.asked)) {
            this.asked = true;
            try {
                const win = await ask({ screenRecordingPermission: true, accessibilityPermission: false });
                this.titlesRefused = false;
                return win;
            } catch (err) {
                console.warn("[capture] titles unavailable", err instanceof Error ? err.message : err);
            }
        }
        const win = await ask({ screenRecordingPermission: false, accessibilityPermission: false });
        if (!this.titlesRefused) this.store.say("macOS has not allowed Screen Recording for this version of Lawdie Time Capture, so capture is going on without window titles. In System Settings → Privacy & Security → Screen Recording, select Lawdie Time Capture and remove it with −, even if it is switched on (that is an earlier version), then reopen this app and allow it.");
        this.titlesRefused = true;
        return win ? { ...win, title: "" } : win;
    }

    /**
     * The call going on behind the window in front: that app's frontmost window (a meeting's
     * title says who or what it is), or just the app when its windows cannot be listed.
     */
    private async callWindow(call: { app: CallApp; ownerID: string }, titles: boolean): Promise<Observation> {
        try {
            const windows = await (await loadGetWindows()).openWindows({ screenRecordingPermission: titles && !this.titlesRefused, accessibilityPermission: false });
            const win = windows.find((w) => callApp(ownerOf(w))?.key === call.app.key);
            if (win) return { app: win.owner.name || call.app.name, ownerID: ownerOf(win), title: titles && win.title ? win.title.slice(0, 300) : null };
        } catch (err) {
            console.warn("[capture] call window unavailable", err instanceof Error ? err.message : err);
        }
        return { app: call.app.name, ownerID: call.ownerID, title: null };
    }

    suspend(): void {
        this.suspended = true;
        const now = Date.now();
        this.store.change((w) => { closeActivity(w, now, "suspended"); stopTimer(w, now, "timer-suspended"); });
    }

    /** On quit: close what is open at this instant, so nothing is recovered later as a crash. */
    shutdown(): void {
        this.stop();
        const now = Date.now();
        this.store.change((w) => { closeActivity(w, now, "quit"); stopTimer(w, now); });
    }
}
