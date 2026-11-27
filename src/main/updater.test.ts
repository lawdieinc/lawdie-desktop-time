import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoUpdater as nativeUpdater } from "electron";
import electronUpdater from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { createHttpError } from "builder-util-runtime";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
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

// Exercise the installed provider's real wrapping: it loses HttpError's status, code and cause.
async function githubFailure(status: number): Promise<Error> {
    const feed = '<feed><entry><title>v0.18.9</title><link href="https://github.com/lawdieinc/lawdie-desktop-time/releases/tag/v0.18.9"/></entry></feed>';
    const response = Object.assign(new IncomingMessage(new Socket()), {
        statusCode: status, statusMessage: "", headers: { "content-type": "text/html" },
    });
    const request = vi.fn().mockResolvedValueOnce(feed).mockRejectedValueOnce(createHttpError(response,
        `method: GET url: https://github.com/lawdieinc/lawdie-desktop-time/releases/tag/v0.18.9\n\nData:\n<html><body><h1>${status} Gateway Time-out</h1>\nThe server didn't respond in time.\n</body></html>\n\n`));
    const provider = new GitHubProvider({ provider: "github", owner: "lawdieinc", repo: "lawdie-desktop-time" }, autoUpdater, {
        platform: "darwin", isUseMultipleRangeRequest: false,
        executor: { request } as unknown as ProviderRuntimeOptions["executor"],
    });
    try {
        await provider.getLatestVersion();
    } catch (error) {
        if (error instanceof Error) return error;
        throw error;
    }
    throw new Error("Expected the GitHub request to fail");
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    vi.restoreAllMocks();
});

describe("checking updates", () => {
    it("logs a real GitHubProvider wrapped 504 once, then recovers on the scheduled check", async () => {
        const error = await githubFailure(504);
        expect(error).toMatchObject({ code: "ERR_UPDATER_INVALID_RELEASE_FEED" });
        expect(error.cause).toBeUndefined();
        expect(error.message).toContain("Cannot parse releases feed: Error: Unable to find latest version on GitHub");
        expect(error.message).toContain("HttpError: 504");
        expect(error.message).toContain("<html><body><h1>504 Gateway Time-out");
        vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
            autoUpdater.emit("error", error);
            throw error;
        });
        const ready = updater.onReady = vi.fn();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith("[updater]", error.message.slice(0, 200));
        expect(report).not.toHaveBeenCalled();
        expect(store.updateReady).toBeNull();
        expect(ready).not.toHaveBeenCalled();
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 - 30_001);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
        vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
            const info = {
                version: "0.19.0", downloadedFile: "/cache/update.zip", files: [],
                path: "update.zip", sha512: "test", releaseDate: "2026-11-27",
            };
            autoUpdater.emit("update-downloaded", info);
            autoUpdater.emit("update-downloaded", info);
            return null;
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
        expect(store.updateReady).toBe("0.19.0");
        expect(ready).toHaveBeenCalledExactlyOnceWith("0.19.0");
        expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
        expect(nativeUpdater.checkForUpdates).not.toHaveBeenCalled();
        expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
        expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it.each([
        { statusCode: 504 }, { statusCode: "504" }, { status: 504 }, { code: 504 }, { code: "HTTP_ERROR_504" },
        new Error("request failed", { cause: { statusCode: 504 } }),
        new Error("request failed", { cause: new Error("nested", { cause: { code: "HTTP_ERROR_504" } }) }),
        new Error("net::ERR_INTERNET_DISCONNECTED"),
        Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }),
    ])("only logs a transient failure: %s", async (error) => {
        vi.mocked(autoUpdater.checkForUpdates).mockRejectedValueOnce(error);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(report).not.toHaveBeenCalled();
        expect(store.updateReady).toBeNull();
    });

    it.each([401, 403, 404, 500, 503])("still reports a wrapped HTTP %s", async (status) => {
        const error = await githubFailure(status);
        autoUpdater.emit("error", error);
        expect(report).toHaveBeenCalledExactlyOnceWith("updater", error);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it.each([
        "Cannot parse releases feed: Unexpected token < in JSON",
        "No published versions on GitHub",
        "Unable to find latest version on GitHub, please ensure a production release exists",
        "HttpError: 404", "HttpError: 401", "HttpError: 403",
        "sha512 checksum mismatch", "signature verification failed",
        "timeout reading release configuration", "Gateway Time-out", "504",
        'Cannot parse releases feed: invalid XML: <title>HttpError: 504 Gateway Time-out</title>',
        'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/lawdieinc/lawdie-desktop-time/releases/latest), please ensure a production release exists: SyntaxError: invalid JSON\nXML:\nHttpError: 504 Gateway Time-out',
    ])("still reports a genuine updater failure: %s", async (message) => {
        const error = new Error(message);
        vi.mocked(autoUpdater.checkForUpdates).mockImplementationOnce(async () => {
            autoUpdater.emit("error", error);
            throw error;
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(report).toHaveBeenCalledExactlyOnceWith("updater", error);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("bounds cause traversal and handles cycles", () => {
        const cycle = Object.assign(new Error("cycle"), { cause: {} });
        cycle.cause = cycle;
        const deep = new Error("deep", { cause: { cause: { cause: { cause: { statusCode: 504 } } } } });
        autoUpdater.emit("error", cycle);
        autoUpdater.emit("error", deep);
        expect(report).toHaveBeenCalledTimes(2);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("handles each later check even if it rejects with the same error object", async () => {
        const error = new Error("invalid feed");
        vi.mocked(autoUpdater.checkForUpdates).mockRejectedValue(error);
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 - 30_000);
        expect(report).toHaveBeenCalledTimes(2);
    });
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
