import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoUpdater as nativeUpdater } from "electron";
import electronUpdater from "electron-updater";
import { report } from "./errors";
import type { Store } from "./store";
import { Updater } from "./updater";

vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        app: { isPackaged: true },
        autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: vi.fn() }),
    };
});
vi.mock("electron-updater", async () => {
    const { EventEmitter } = await import("node:events");
    return { default: { autoUpdater: Object.assign(new EventEmitter(), {
        checkForUpdates: vi.fn(), quitAndInstall: vi.fn(),
    }) } };
});
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("./errors", () => ({ report: vi.fn() }));

const { autoUpdater } = electronUpdater;
let updater: Updater;
let store: Store;
let prepared: boolean;

beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal("process", { ...process, platform: "darwin", resourcesPath: "/app/Resources" });
    nativeUpdater.removeAllListeners();
    autoUpdater.removeAllListeners();
    // MacUpdater registers these when its singleton is created, before Updater.start().
    prepared = false;
    nativeUpdater.on("update-downloaded", () => { prepared = true; });
    nativeUpdater.on("error", (err) => autoUpdater.emit("error", err));
    vi.mocked(autoUpdater.quitAndInstall).mockImplementation(() => {
        if (process.platform === "darwin" && !prepared) throw new Error("Squirrel is not ready");
    });
    store = {
        workspace: {}, updateReady: null,
        setUpdateReady(version: string) { this.updateReady = version; },
    } as Store;
    updater = new Updater(store);
    updater.start();
});

afterEach(() => {
    updater.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("installing updates", () => {
    it("waits for the person's Install, then prepares once despite repeated clicks", async () => {
        updater.install();
        expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();
        autoUpdater.emit("update-downloaded", {
            version: "0.18.3", downloadedFile: "/cache/update.zip", files: [],
            path: "update.zip", sha512: "test", releaseDate: "2026-11-16",
        });
        expect(store.updateReady).toBe("0.18.3");
        expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
        expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();

        updater.install();
        updater.install();
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
        expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();

        nativeUpdater.emit("update-downloaded");
        updater.install();
        nativeUpdater.emit("update-downloaded");
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(report).not.toHaveBeenCalled();
    });

    it("removes a failed handoff before retrying, so success restarts only once", () => {
        store.updateReady = "0.18.3";
        updater.install();
        const error = new Error("Preparation failed");
        nativeUpdater.emit("error", error);
        expect(report).toHaveBeenCalledWith("updater", error);
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(1);

        updater.install();
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        nativeUpdater.emit("update-downloaded");
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("handles a synchronous preparation failure and allows retry", () => {
        store.updateReady = "0.18.3";
        const error = new Error("The command is disabled and cannot be executed");
        vi.mocked(nativeUpdater.checkForUpdates).mockImplementationOnce(() => { throw error; });
        expect(() => updater.install()).not.toThrow();
        expect(report).toHaveBeenCalledWith("updater", error);
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(1);
        updater.install();
        nativeUpdater.emit("update-downloaded");
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("retries a failed restart without preparing the same update again", () => {
        store.updateReady = "0.18.3";
        updater.install();
        const error = new Error("Restart failed");
        vi.mocked(autoUpdater.quitAndInstall).mockImplementationOnce(() => { throw error; });
        nativeUpdater.emit("update-downloaded");
        expect(report).toHaveBeenCalledWith("updater", error);
        updater.install();
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
    });

    it.each(["win32", "linux"])("guards repeated installs on %s without the macOS handoff", (platform) => {
        vi.stubGlobal("process", { ...process, platform });
        store.updateReady = "0.18.3";
        updater.install();
        updater.install();
        expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    });

    it("removes its pending restart callback when stopped", () => {
        store.updateReady = "0.18.3";
        updater.install();
        updater.stop();
        nativeUpdater.emit("update-downloaded");
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
});
