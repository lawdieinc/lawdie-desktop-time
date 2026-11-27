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
    private checkErrors: Set<unknown> | null = null;
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
        // Local end-to-end update test only, never set in production (like LAWDIE_USER_DATA /
        // LAWDIE_TEST_ERROR): point the feed at a local server and print the outcome to stdout,
        // so a fused + signed build can be checked against the next one before a release ships.
        const testFeed = process.env.LAWDIE_UPDATE_FEED;
        if (testFeed) {
            autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
            autoUpdater.logger = console;
            autoUpdater.on("update-downloaded", (info) => console.log(`[updater-test] downloaded ${info.version}`));
            autoUpdater.on("error", (err) => console.log(`[updater-test] error ${err instanceof Error ? err.message : err}`));
            setTimeout(() => void this.check(), 1000);
        }
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
        // electron-updater emits the error before rejecting the same check with it.
        if (this.checkErrors?.has(err)) return;
        this.checkErrors?.add(err);
        nativeUpdater.removeListener("update-downloaded", this.macDownloaded);
        this.installing = false;
        failed(err);
    }

    private async check(): Promise<void> {
        if (this.store.updateReady || this.checkErrors) return;
        this.checkErrors = new Set();
        try {
            await autoUpdater.checkForUpdates();
        } catch (err) {
            this.failed(err);
        } finally {
            this.checkErrors = null;
        }
    }
}

/** A check or download that failed. A transport failure or gateway timeout is only logged: the
    next check is in four hours, and it is not a bug to report. */
function failed(err: unknown): void {
    if (isNetworkError(err) || isGatewayTimeout(err)) console.warn("[updater]", (err instanceof Error ? err.message : String(err)).slice(0, 200));
    else report("updater", err);
}

/** Updater-only HTTP 504 handling. GitHubProvider discards status and cause when it wraps a failed latest-version
    request, leaving only HttpError's stack in the message. Match that prefix, never status-like text in feed XML. */
function isGatewayTimeout(error: unknown): boolean {
    const seen = new Set<unknown>();
    let current = error;
    for (let depth = 0; depth <= 3 && current && typeof current === "object" && !seen.has(current); depth++) {
        seen.add(current);
        const record = current as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown; cause?: unknown };
        if ([record.statusCode, record.status, record.code].some((value) => value === 504 || value === "504") || record.code === "HTTP_ERROR_504") return true;
        if (typeof record.message === "string" && /^(?:Cannot parse releases feed: Error: )?Unable to find latest version on GitHub \(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/latest\), please ensure a production release exists: HttpError: 504\s/.test(record.message)) return true;
        current = record.cause;
    }
    return false;
}
