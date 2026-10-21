/* Updates: the app checks GitHub Releases (the same ones people download from), fetches a
   newer version in the background and installs it on restart, so a person updates once
   by hand (to the first version with this) and never again. electron-updater reads the
   latest*.yml files the release workflow attaches; on macOS it takes the .zip and installs
   it only if it is signed like the running app (the one certificate, see
   scripts/mac-signing-cert.sh), which is also why permissions carry over.

   Nothing here is the person's problem: a failed check is logged and tried again later,
   never shown. The window only hears that an update is ready. */

import { app } from "electron";
// CommonJS, and this bundle is an ES module: a named import fails at launch.
import electronUpdater from "electron-updater";
import type { Store } from "./store";

const { autoUpdater } = electronUpdater;

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const FIRST_CHECK_MS = 30_000;

export class Updater {
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly store: Store) {}

    start(): void {
        // A development run or an unpacked build has nothing to update.
        if (!app.isPackaged) return;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.logger = null;
        autoUpdater.on("update-downloaded", (info) => this.store.setUpdateReady(info.version));
        autoUpdater.on("error", (err) => console.warn("[updater]", err instanceof Error ? err.message : err));
        setTimeout(() => void this.check(), FIRST_CHECK_MS);
        this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
    }

    /** Restart into the downloaded version; quitting installs it too. */
    install(): void {
        if (this.store.updateReady) autoUpdater.quitAndInstall();
    }

    private async check(): Promise<void> {
        if (this.store.updateReady) return;
        try {
            await autoUpdater.checkForUpdates();
        } catch (err) {
            console.warn("[updater]", err instanceof Error ? err.message : err);
        }
    }
}
