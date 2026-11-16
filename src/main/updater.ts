/* Updates: the app checks GitHub Releases (the same ones people download from) and fetches a
   newer version in the background, then waits for the person: it installs only when they
   press Install (window, sidebar, tray), never silently on quit. 2026-11-02, after the beta
   user's Oct 23 update installed unnoticed and macOS asked for Screen Recording again,
   which went unseen for six days; installing is now a moment the person chose and will
   notice what follows (see `missing` in index.ts). electron-updater reads the
   latest*.yml files the release workflow attaches; on macOS it takes the .zip and installs
   it only if it is signed like the running app (the one certificate, see
   scripts/mac-signing-cert.sh), which is also why permissions carry over.

   Nothing here is the person's problem: a failed check is logged and tried again later,
   never shown. The person hears only that an update is ready (`onReady`). */

import { existsSync } from "node:fs";
import { report } from "./errors";
import { join } from "node:path";
import { app } from "electron";
// CommonJS, and this bundle is an ES module: a named import fails at launch.
import electronUpdater from "electron-updater";
import type { Store } from "./store";

const { autoUpdater } = electronUpdater;

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;

// GitHubProvider embeds the original error's stack in its feed/version errors, without a cause.
// Match explicit transport tokens only; a missing release or malformed feed still needs a report.
const TRANSIENT_CHECK_ERROR = /\bnet::(?:ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET)\b/;

export class Updater {
    private timer: NodeJS.Timeout | null = null;
    private readonly handledErrors = new WeakSet<object>();
    /** Called once a version has downloaded and waits for Install. */
    onReady: (version: string) => void = () => {};

    constructor(private readonly store: Store) {}

    start(): void {
        // A development run or an unpacked build has nothing to update. Neither has a demo build: a workspace seeded for a
        // demo, or a local build packaged without a publish config (no app-update.yml), is never replaced by a release.
        if (!app.isPackaged) return;
        if (this.store.workspace.demo) return;
        if (!existsSync(join(process.resourcesPath, "app-update.yml"))) return;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.logger = null;
        autoUpdater.on("update-downloaded", (info) => {
            const first = this.store.updateReady !== info.version;
            this.store.setUpdateReady(info.version);
            if (first) this.onReady(info.version);
        });
        // AppUpdater labels check failures separately from download/install errors, then rethrows
        // the same object. Use that label so even a download timeout remains reportable.
        autoUpdater.on("error", (err, message) => this.handleError(err, message?.startsWith("Cannot check for updates: ") === true));
        setTimeout(() => void this.check(), FIRST_CHECK_MS);
        this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    /** Restart into the downloaded version: the only way it is installed. */
    install(): void {
        if (this.store.updateReady) autoUpdater.quitAndInstall();
    }

    private handleError(err: unknown, checking: boolean): void {
        if (err !== null && typeof err === "object") {
            if (this.handledErrors.has(err)) return;
            this.handledErrors.add(err);
        }
        if (checking && err instanceof Error && TRANSIENT_CHECK_ERROR.test(err.message)) {
            console.warn("[updater] Check failed; will retry on schedule:", err.message);
            return;
        }
        report("updater", err);
    }

    private async check(): Promise<void> {
        if (this.store.updateReady) return;
        try {
            await autoUpdater.checkForUpdates();
        } catch (err) {
            this.handleError(err, true);
        }
    }
}
