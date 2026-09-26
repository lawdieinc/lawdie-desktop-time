/* The observation layer: which app is in front, how long since the last input, and
   whether the machine is asleep or locked. get-windows answers the first on macOS,
   Windows and Linux (X11); Electron's powerMonitor answers the rest everywhere.
   Everything it learns goes through observe() in the shared model; nothing is decided here. */

import { powerMonitor } from "electron";
import { closeActivity, observe, prune, stopTimer, type Observation } from "@shared/model";
import type { Store } from "./store";

export const SAMPLE_MS = 5_000;

type ForegroundWindow = { title: string; owner: { name: string; processId: number; bundleId?: string; path: string } };
type ActiveWindow = (options?: { screenRecordingPermission?: boolean; accessibilityPermission?: boolean }) => Promise<ForegroundWindow | undefined>;

let activeWindow: ActiveWindow | null = null;
async function loadActiveWindow(): Promise<ActiveWindow> {
    // get-windows is ESM-only; the main bundle is CommonJS.
    activeWindow ??= ((await import("get-windows")) as { activeWindow: ActiveWindow }).activeWindow;
    return activeWindow;
}

export class Capture {
    private suspended = false;
    private timer: NodeJS.Timeout | null = null;
    private ticks = 0;
    private sampling = false;
    /** Last observation, for the window's "Currently in …" line and for tests. */
    lastForeground: Observation = null;

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
                try {
                    // Exclusions are checked in observe() BEFORE any title is used; the title is
                    // only asked for at all when titles are on (macOS needs Screen Recording for it).
                    const win = await (await loadActiveWindow())({ screenRecordingPermission: prefs.captureTitles, accessibilityPermission: false });
                    if (win) {
                        const ownerID = process.platform === "darwin" ? win.owner.bundleId || win.owner.path : win.owner.path;
                        foreground = { app: win.owner.name || ownerID, ownerID, title: prefs.captureTitles && win.title ? win.title.slice(0, 300) : null, isSelf: win.owner.processId === process.pid };
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
