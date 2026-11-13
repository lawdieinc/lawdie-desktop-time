import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopCapturer, systemPreferences } from "electron";
import { emptyWorkspace, observe, type Workspace } from "@shared/model";
import { Capture } from "./capture";
import { report } from "./errors";
import { Screenshots } from "./screenshots";
import type { Store } from "./store";

vi.mock("electron", () => ({
    desktopCapturer: { getSources: vi.fn() },
    systemPreferences: { getMediaAccessStatus: vi.fn() },
    powerMonitor: { getSystemIdleState: () => "active", getSystemIdleTime: () => 0 },
}));
vi.mock("./errors", () => ({ report: vi.fn() }));
vi.mock("get-windows", () => ({ activeWindow: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), writeFile: vi.fn() }));

const name = "activity-1794499200000.jpg";
const jpeg = Buffer.from("exact window jpeg");
function source(id = "window:42:0", empty = false) {
    return { id, name: "Window", display_id: "", appIcon: null, thumbnail: {
        isEmpty: vi.fn(() => empty), toJPEG: vi.fn(() => jpeg),
    } };
}
const getSources = vi.mocked(desktopCapturer.getSources);
let dir: string;
let shots: Screenshots;

beforeEach(async () => {
    vi.resetAllMocks();
    // Exercise the macOS permission gate on every host without invoking native APIs.
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue("granted");
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(fs.writeFile);
    dir = mkdtempSync(join(tmpdir(), "lawdie-shots-"));
    shots = new Screenshots(dir);
    getSources.mockResolvedValue([source() as unknown as Electron.DesktopCapturerSource]);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
});

function expectNoFile() {
    expect(readdirSync(dir)).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
}

describe("Screenshots.take", () => {
    it("skips an absent window without reporting or substituting another source", async () => {
        const other = source("window:420:0");
        // Electron is asked for windows only; other windows must never be selected.
        getSources.mockResolvedValue([other as unknown as Electron.DesktopCapturerSource]);
        expect(await shots.take(42, name, async () => true)).toBe(false);
        expect(other.thumbnail.toJPEG).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        expectNoFile();
    });

    it.each([false, true])("rechecks foreground after enumeration before inspecting a stale thumbnail (empty: %s)", async (empty) => {
        const stale = source("window:42:0", empty);
        const stillInFront = vi.fn(async () => false);
        getSources.mockImplementation(async () => {
            expect(stillInFront).not.toHaveBeenCalled();
            return [stale as unknown as Electron.DesktopCapturerSource];
        });
        expect(await shots.take(42, name, stillInFront)).toBe(false);
        expect(stillInFront).toHaveBeenCalledOnce();
        expect(stale.thumbnail.isEmpty).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        expectNoFile();
    });

    it("writes only the exact window after confirming it is still in front", async () => {
        const other = source("window:420:0");
        const exact = source();
        getSources.mockResolvedValue([other, exact] as unknown as Electron.DesktopCapturerSource[]);
        expect(await shots.take(42, name, async () => true)).toBe(true);
        expect(getSources).toHaveBeenCalledWith({ types: ["window"], thumbnailSize: { width: 1440, height: 900 }, fetchWindowIcons: false });
        expect(other.thumbnail.toJPEG).not.toHaveBeenCalled();
        expect(exact.thumbnail.toJPEG).toHaveBeenCalledWith(65);
        expect(readFileSync(join(dir, name))).toEqual(jpeg);
        expect(writeFile).toHaveBeenCalledWith(join(dir, name), jpeg, { mode: 0o600 });
        expect(report).not.toHaveBeenCalled();
    });

    it("does not enumerate or save without Screen Recording permission", async () => {
        vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue("denied");
        expect(await shots.take(42, name)).toBe(false);
        expect(getSources).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        expectNoFile();
    });

    it("keeps empty thumbnails for the current window observable", async () => {
        getSources.mockResolvedValue([source("window:42:0", true) as unknown as Electron.DesktopCapturerSource]);
        expect(await shots.take(42, name)).toBe(false);
        expect(report).toHaveBeenCalledWith("screenshots", expect.any(Error), { reason: "empty" });
        expectNoFile();
    });

    it("reports a capturer rejection and saves nothing", async () => {
        getSources.mockRejectedValue(new Error("capturer failed"));
        expect(await shots.take(42, name)).toBe(false);
        expect(report).toHaveBeenCalledWith("screenshots", new Error("capturer failed"), { reason: "error" });
        expectNoFile();
    });

    it("reports a write failure and returns false", async () => {
        vi.mocked(writeFile).mockRejectedValue(new Error("disk full"));
        expect(await shots.take(42, name)).toBe(false);
        expect(report).toHaveBeenCalledWith("screenshots", new Error("disk full"), { reason: "error" });
        expect(readdirSync(dir)).toEqual([]);
    });

    it("continues to report a capture timeout", async () => {
        vi.useFakeTimers();
        getSources.mockReturnValue(new Promise(() => {}));
        const taking = shots.take(42, name);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await taking).toBe(false);
        expect(report).toHaveBeenCalledWith("screenshots", expect.any(Error), { reason: "timeout" });
        expectNoFile();
    });
});

describe("Capture screenshot attachment", () => {
    it.each(["missing", "changed", "denied", "capturer", "write", "success"])("preserves time and attaches a file only on success: %s", async (outcome) => {
        const { activeWindow } = await import("get-windows");
        const win = { platform: "macos" as const, id: 42, title: "Document", bounds: { x: 0, y: 0, width: 800, height: 600 }, memoryUsage: 0, owner: { name: "Editor", processId: 123, bundleId: "test.editor", path: "/Editor" } };
        vi.mocked(activeWindow).mockResolvedValue(win);
        const workspace = emptyWorkspace();
        workspace.preferences.captureEnabled = true;
        workspace.preferences.captureScreenshots = true;
        const now = Date.now();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(now);
        const observation = { app: "Editor", ownerID: "test.editor", title: null, isSelf: false, call: false };
        // Keep observations within GAP_SECONDS while letting the screenshot settle.
        for (let elapsed = 25_000; elapsed > 0; elapsed -= 5_000) observe(workspace, observation, now - elapsed, 0, false);
        const store = {
            workspace, loadFailed: false,
            change: (update: (w: Workspace) => void) => { update(workspace); return true; },
            say: vi.fn(),
        };
        const capture = new Capture(store as unknown as Store, shots);
        vi.spyOn(capture.mic, "recording").mockResolvedValue([]);
        if (outcome === "missing") getSources.mockResolvedValue([]);
        if (outcome === "changed") vi.mocked(activeWindow).mockResolvedValueOnce(win).mockResolvedValue({ ...win, id: 43 });
        if (outcome === "denied") vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue("denied");
        if (outcome === "capturer") getSources.mockRejectedValue(new Error("capturer failed"));
        if (outcome === "write") vi.mocked(writeFile).mockRejectedValue(new Error("disk full"));
        await capture.sample();
        expect(workspace.currentActivity?.endedAt).toBe(new Date(now).toISOString());
        const attached = workspace.currentActivity?.screenshots ?? [];
        expect(attached).toHaveLength(outcome === "success" ? 1 : 0);
        expect(readdirSync(dir)).toEqual(attached);
    });
});
