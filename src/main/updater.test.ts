import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import electronUpdater from "electron-updater";
import { AppUpdater } from "electron-updater/out/AppUpdater.js";
import { report } from "./errors";
import type { Store } from "./store";
import { Updater } from "./updater";

vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("node:path", () => ({ join: () => "app-update.yml" }));
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("./errors", () => ({ report: vi.fn() }));
vi.mock("electron-updater", async () => {
    const { EventEmitter } = await import("node:events");
    return { default: { autoUpdater: Object.assign(new EventEmitter(), {
        checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
        autoDownload: false, autoInstallOnAppQuit: true, logger: null,
    }) } };
});

const { autoUpdater } = electronUpdater;
const check = vi.mocked(autoUpdater.checkForUpdates);
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

function wrapped(message: string): Error {
    return Object.assign(new Error(`Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/lawdieinc/lawdie-desktop-time/releases/latest), please ensure a production release exists: Error: ${message}\n    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:1:123)`), {
        code: "ERR_UPDATER_INVALID_RELEASE_FEED",
    });
}

// Exercise the installed dependency's emit-and-rethrow path and check-error label, without
// starting Electron or making network requests. Only the underlying check is replaced.
function rejectCheck(error: Error): void {
    Object.assign(autoUpdater, {
        isUpdaterActive: () => true,
        _logger: { info: vi.fn() },
        doCheckForUpdates: vi.fn().mockRejectedValue(error),
        checkForUpdatesPromise: null,
    });
    check.mockImplementation(() => AppUpdater.prototype.checkForUpdates.call(autoUpdater));
}

describe("updater failures", () => {
    let updater: Updater;
    let store: Store;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        autoUpdater.removeAllListeners();
        check.mockReset().mockResolvedValue(null);
        store = { workspace: {}, updateReady: null, setUpdateReady: vi.fn((version: string) => { store.updateReady = version; }) } as unknown as Store;
        updater = new Updater(store);
        updater.start();
    });

    afterEach(() => {
        updater.stop();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        new Error("net::ERR_TIMED_OUT"),
        wrapped("net::ERR_TIMED_OUT"),
        new Error("net::ERR_CONNECTION_TIMED_OUT"),
        new Error("net::ERR_INTERNET_DISCONNECTED"),
        new Error("net::ERR_NETWORK_CHANGED"),
        new Error("net::ERR_CONNECTION_RESET"),
    ])("logs a transient check locally once: %s", async (error) => {
        rejectCheck(error);
        await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
        expect(report).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledExactlyOnceWith("[updater] Check failed; will retry on schedule:", error.message);
    });

    it.each([
        wrapped("Unexpected close tag"),
        Object.assign(new Error("Unable to find latest version on GitHub, please ensure a production release exists"), { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" }),
        Object.assign(new Error("No published versions on GitHub"), { code: "ERR_UPDATER_NO_PUBLISHED_VERSIONS" }),
        new Error("Invalid update configuration"),
        wrapped("net::ERR_CERT_AUTHORITY_INVALID"),
        wrapped("net::ERR_TIMED_OUT_OTHER"),
        wrapped("HTTP 404"),
    ])("reports a genuine check failure once across event and rejection: %s", async (error) => {
        rejectCheck(error);
        await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
        expect(report).toHaveBeenCalledExactlyOnceWith("updater", error);
    });

    it("handles a promise-only timeout and reports a promise-only unexpected failure", async () => {
        check.mockRejectedValueOnce(wrapped("net::ERR_TIMED_OUT"));
        await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
        expect(report).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledTimes(1);
        const error = new Error("Unexpected check failure");
        check.mockRejectedValueOnce(error);
        await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
        expect(report).toHaveBeenCalledExactlyOnceWith("updater", error);
    });

    it("handles an event-only check timeout", () => {
        const error = wrapped("net::ERR_TIMED_OUT");
        autoUpdater.emit("error", error, `Cannot check for updates: ${error.stack}`);
        expect(report).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it.each([new Error("Update checksum mismatch"), new Error("net::ERR_TIMED_OUT")])("reports event-only download errors, including timeouts: %s", (error) => {
        autoUpdater.emit("error", error, error.stack);
        expect(report).toHaveBeenCalledExactlyOnceWith("updater", error);
    });

    it("does not deduplicate distinct errors with the same message", () => {
        const first = new Error("Download failed");
        const second = new Error(first.message);
        autoUpdater.emit("error", first);
        autoUpdater.emit("error", second);
        expect(report).toHaveBeenCalledTimes(2);
        expect(report).toHaveBeenNthCalledWith(1, "updater", first);
        expect(report).toHaveBeenNthCalledWith(2, "updater", second);
    });

    it("keeps the schedule after a timeout and still waits for Install after a later download", async () => {
        expect(autoUpdater.autoDownload).toBe(true);
        expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
        updater.onReady = vi.fn();
        updater.install();
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        check.mockRejectedValueOnce(wrapped("net::ERR_TIMED_OUT"));
        await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
        expect(check).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(check).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - FIRST_CHECK_MS - 1);
        expect(check).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(check).toHaveBeenCalledTimes(2);
        const downloaded = {
            version: "0.18.2", files: [], path: "update.zip", sha512: "checksum",
            releaseDate: "2026-11-16T00:00:00Z", downloadedFile: "/tmp/update.zip",
        };
        autoUpdater.emit("update-downloaded", downloaded);
        autoUpdater.emit("update-downloaded", downloaded);
        expect(store.updateReady).toBe("0.18.2");
        expect(updater.onReady).toHaveBeenCalledExactlyOnceWith("0.18.2");
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
        expect(check).toHaveBeenCalledTimes(2);
        updater.install();
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(report).not.toHaveBeenCalled();
    });
});
