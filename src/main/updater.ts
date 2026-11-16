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
import { isNetworkError } from "../shared/errorReport";
import { join } from "node:path";
import { app, autoUpdater as nativeUpdater } from "electron";
// CommonJS, and this bundle is an ES module: a named import fails at launch.
import electronUpdater from "electron-updater";
import type { Store } from "./store";

const { autoUpdater } = electronUpdater;

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;

export class Updater {
    private timer: NodeJS.Timeout | null = null;
    private installing = false;
    private macPrepared = false;
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
        autoUpdater.on("error", (err) => this.failed(err));
        setTimeout(() => void this.check(), FIRST_CHECK_MS);
        this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        nativeUpdater.removeListener("update-downloaded", this.macDownloaded);
    }

    /** Restart into the downloaded version: the only way it is installed. */
    install(): void {
        if (!this.store.updateReady || this.installing) return;
        this.installing = true;
        try {
            if (process.platform === "darwin" && !this.macPrepared) {
                // With install-on-quit off, the ZIP is ready but Squirrel has not prepared it yet.
                // MacUpdater.quitAndInstall starts that check on every call and leaves a restart
                // listener on failure. Own this handoff so repeated clicks cannot start it twice,
                // and a retry has only one restart listener. Use only Electron's public API.
                nativeUpdater.once("update-downloaded", this.macDownloaded);
                nativeUpdater.checkForUpdates();
            } else {
                autoUpdater.quitAndInstall();
            }
        } catch (err) {
            this.failed(err);
        }
    }

    private readonly macDownloaded = (): void => {
        this.macPrepared = true;
        // MacUpdater's earlier native listener has now marked the update prepared too.
        // Its quitAndInstall can restart and close the local ZIP server without another check.
        try {
            autoUpdater.quitAndInstall();
        } catch (err) {
            this.failed(err);
        }
    };

    private failed(err: unknown): void {
        nativeUpdater.removeListener("update-downloaded", this.macDownloaded);
        this.installing = false;
        failed(err);
    }

    private async check(): Promise<void> {
        if (this.store.updateReady) return;
        try {
            await autoUpdater.checkForUpdates();
        } catch (err) {
            failed(err);
        }
    }
}

/** A check or download that failed. One that never reached GitHub (offline, a firewall, a timeout) is only logged: the
    next check is in four hours, and it is not a bug to report. */
function failed(err: unknown): void {
    if (isNetworkError(err)) console.warn("[updater]", err instanceof Error ? err.message.slice(0, 200) : err);
    else report("updater", err);
}
