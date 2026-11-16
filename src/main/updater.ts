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
const INSTALL_FAILED = "The update could not be installed. Please try Install again, or quit and reopen the app before retrying.";

export class Updater {
    private timer: NodeJS.Timeout | null = null;
    private cancelInstall: (() => void) | null = null;
    private macReady = false;
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
        autoUpdater.on("error", (err) => this.installFailed(err));
        setTimeout(() => void this.check(), FIRST_CHECK_MS);
        this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.cancelInstall?.();
        this.cancelInstall = null;
    }

    /** Restart into the downloaded version: the only way it is installed. */
    install(): void {
        if (!this.store.updateReady || this.store.updateInstalling) return;
        this.store.setUpdateInstalling(true);
        if (this.store.notice === INSTALL_FAILED) this.store.say(null);
        const finish = (): void => {
            this.cancelInstall?.();
            this.cancelInstall = null;
            try {
                autoUpdater.quitAndInstall();
            } catch (err) {
                this.installFailed(err);
            }
        };
        if (this.store.platform !== "darwin" || this.macReady) {
            finish();
            return;
        }
        // With autoInstallOnAppQuit=false, the ZIP is ready before Squirrel has staged it.
        // MacUpdater.quitAndInstall() would add a persistent callback before starting that
        // check, leaving it behind on failure. Own the staging listeners so retries are safe;
        // the dependency's earlier native listener marks it ready before finish() runs.
        const downloaded = (): void => { this.macReady = true; finish(); };
        const unavailable = (): void => this.installFailed(new Error("The downloaded update could not be staged."));
        this.cancelInstall = () => {
            nativeUpdater.removeListener("update-downloaded", downloaded);
            nativeUpdater.removeListener("update-not-available", unavailable);
        };
        nativeUpdater.once("update-downloaded", downloaded);
        nativeUpdater.once("update-not-available", unavailable);
        try {
            nativeUpdater.checkForUpdates();
        } catch (err) {
            this.installFailed(err);
        }
    }

    private installFailed(err: unknown): void {
        if (this.store.updateInstalling) {
            this.cancelInstall?.();
            this.cancelInstall = null;
            this.store.setUpdateInstalling(false);
            this.store.say(INSTALL_FAILED);
        }
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
