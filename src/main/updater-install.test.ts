import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, autoUpdater as nativeUpdater } from "electron";
import { MacUpdater } from "electron-updater/out/MacUpdater.js";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import { report } from "./errors";
import { Store } from "./store";
import type { WorkspaceFile } from "./workspace";
import { emptyWorkspace } from "../shared/model";
import type { Updater } from "./updater";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: () => true }));
vi.mock("node:path", async (original) => ({ ...await original<typeof import("node:path")>(), join: () => "app-update.yml" }));
vi.mock("./errors", () => ({ report: vi.fn() }));
vi.mock("electron", async () => {
    const { EventEmitter } = await import("node:events");
    return {
        app: Object.assign(new EventEmitter(), { isPackaged: true }),
        autoUpdater: Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(), quitAndInstall: vi.fn() }),
    };
});

// MacUpdater uses CommonJS require("electron"), which Vitest's ESM mock does not intercept.
// Replace that export only while constructing it. Everything except Electron itself and
// network checking uses the installed dependency, including its native readiness listener
// and quitAndInstall implementation (the source of the persistent-callback regression).
function macUpdater(): MacUpdater {
    const require = createRequire(import.meta.url);
    require("electron");
    const module = require.cache[require.resolve("electron")]!;
    const original = module.exports;
    module.exports = { autoUpdater: nativeUpdater };
    try {
        const adapter: AppAdapter = {
            version: "0.18.2", name: "Lawdie", isPackaged: true,
            appUpdateConfigPath: "app-update.yml", userDataPath: "/tmp", baseCachePath: "/tmp",
            whenReady: async () => {}, relaunch: vi.fn(), quit: vi.fn(), onQuit: vi.fn(),
        };
        return new MacUpdater(undefined, adapter);
    } finally {
        module.exports = original;
    }
}

const downloaded = {
    version: "0.18.3", downloadedFile: "/tmp/update.zip", files: [],
    path: "update.zip", sha512: "checksum", releaseDate: "2026-11-16T00:00:00Z",
};

describe("explicit update installation", () => {
    let updater: Updater;
    let wrapper: MacUpdater;
    let store: Store;
    let nativeListeners: number;

    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.clearAllMocks();
        nativeUpdater.removeAllListeners();
        vi.mocked(nativeUpdater.checkForUpdates).mockReset();
        vi.mocked(nativeUpdater.quitAndInstall).mockReset();
        wrapper = macUpdater();
        vi.spyOn(wrapper, "checkForUpdates").mockResolvedValue(null);
        vi.spyOn(wrapper, "quitAndInstall");
        vi.doMock("electron-updater", () => ({ default: { autoUpdater: wrapper } }));
        const { Updater } = await import("./updater");
        const file = { path: "/tmp/workspace.json", load: emptyWorkspace, save: vi.fn() } as unknown as WorkspaceFile;
        store = new Store(file, "0.18.2", "darwin");
        updater = new Updater(store);
        updater.start();
        nativeListeners = nativeUpdater.listenerCount("update-downloaded");
    });

    afterEach(() => {
        updater.stop();
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("ignores Install before a download, and never installs on ordinary quit", () => {
        expect(wrapper.autoInstallOnAppQuit).toBe(false);
        updater.install();
        expect(store.updateInstalling).toBe(false);
        wrapper.emit("update-downloaded", downloaded);
        expect(store.updateReady).toBe(downloaded.version);
        expect(store.snapshot().updateInstalling).toBe(false);
        app.emit("before-quit", {});
        updater.stop();
        app.emit("quit", {}, 0);
        expect(wrapper.quitAndInstall).not.toHaveBeenCalled();
        expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it("shares one staging attempt across rapid window, sidebar and tray requests, and installs once", () => {
        wrapper.emit("update-downloaded", downloaded);
        const published: boolean[] = [];
        store.subscribe((state) => published.push(state.updateInstalling));
        // All three entry points call this same main-process Updater.
        const windowInstall = () => updater.install();
        const sidebarInstall = () => updater.install();
        const trayInstall = () => updater.install();
        windowInstall(); sidebarInstall(); trayInstall();
        expect(published).toEqual([true]);
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(wrapper.quitAndInstall).not.toHaveBeenCalled();
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(nativeListeners + 1);
        nativeUpdater.emit("update-downloaded");
        nativeUpdater.emit("update-downloaded");
        trayInstall();
        expect(wrapper.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(nativeListeners);
        expect(nativeUpdater.listenerCount("update-not-available")).toBe(0);
        expect(store.updateInstalling).toBe(true);
    });

    it.each(["throw", "native error", "wrapper error", "unavailable"])("cleans up after %s, ignores late completion and retries without accumulating callbacks", (failure) => {
        const error = new Error("The command is disabled and cannot be executed");
        const unrelated = vi.fn();
        nativeUpdater.on("update-downloaded", unrelated);
        wrapper.emit("update-downloaded", downloaded);
        for (let attempt = 0; attempt < 3; attempt++) {
            if (failure === "throw") vi.mocked(nativeUpdater.checkForUpdates).mockImplementationOnce(() => { throw error; });
            expect(() => updater.install()).not.toThrow();
            if (failure === "native error") nativeUpdater.emit("error", error);
            if (failure === "wrapper error") wrapper.emit("error", error);
            if (failure === "unavailable") nativeUpdater.emit("update-not-available");
            expect(store.updateInstalling).toBe(false);
            expect(store.updateReady).toBe(downloaded.version);
            expect(store.notice).toContain("Please try Install again");
            expect(nativeUpdater.listenerCount("update-downloaded")).toBe(nativeListeners + 1);
            expect(nativeUpdater.listenerCount("update-not-available")).toBe(0);
            nativeUpdater.emit("update-downloaded");
            expect(wrapper.quitAndInstall).not.toHaveBeenCalled();
            expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
        }
        expect(report).toHaveBeenCalledTimes(3);
        updater.install();
        nativeUpdater.emit("update-downloaded");
        expect(wrapper.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(4);
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(nativeListeners + 1);
        expect(unrelated).toHaveBeenCalledTimes(4);
    });

    it("can retry a synchronous install failure after native readiness without staging again", () => {
        const error = new Error("Native install failed");
        vi.mocked(nativeUpdater.quitAndInstall).mockImplementationOnce(() => { throw error; });
        wrapper.emit("update-downloaded", downloaded);
        updater.install();
        expect(() => nativeUpdater.emit("update-downloaded")).not.toThrow();
        expect(store.updateInstalling).toBe(false);
        expect(report).toHaveBeenCalledExactlyOnceWith("updater", error);
        updater.install();
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(nativeListeners);
        expect(store.updateInstalling).toBe(true);
    });

    it("handles an emitted install failure after staging and allows a retry", () => {
        wrapper.emit("update-downloaded", downloaded);
        updater.install();
        nativeUpdater.emit("update-downloaded");
        nativeUpdater.emit("error", new Error("Install failed"));
        expect(store.updateInstalling).toBe(false);
        updater.install();
        expect(nativeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
    });

    it("cancels only its staging listeners when the app quits during an attempt", () => {
        const unrelated = vi.fn();
        nativeUpdater.on("update-downloaded", unrelated);
        wrapper.emit("update-downloaded", downloaded);
        updater.install();
        updater.stop();
        nativeUpdater.emit("update-downloaded");
        expect(unrelated).toHaveBeenCalledTimes(1);
        expect(nativeUpdater.listenerCount("update-downloaded")).toBe(nativeListeners + 1);
        expect(nativeUpdater.listenerCount("update-not-available")).toBe(0);
        expect(nativeUpdater.quitAndInstall).not.toHaveBeenCalled();
        expect(wrapper.autoInstallOnAppQuit).toBe(false);
    });

    it.each(["win32", "linux"] as const)("guards direct installation and failure/retry on %s", (platform) => {
        Object.defineProperty(store, "platform", { value: platform });
        // The other platforms use their wrapper's install path directly.
        vi.mocked(wrapper.quitAndInstall).mockImplementation(() => {});
        store.setUpdateReady(downloaded.version);
        vi.mocked(wrapper.quitAndInstall).mockImplementationOnce(() => { throw new Error("Install failed"); });
        updater.install();
        expect(store.updateInstalling).toBe(false);
        updater.install(); updater.install();
        expect(wrapper.quitAndInstall).toHaveBeenCalledTimes(2);
        expect(store.updateInstalling).toBe(true);
        expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
});
