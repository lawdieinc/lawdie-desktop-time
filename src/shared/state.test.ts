import { describe, expect, it } from "vitest";
import { emptyWorkspace } from "./model";
import { createSharer, type AppState } from "./state";

const stateOf = (change: (s: AppState) => void = () => undefined): AppState => {
    const s = { workspace: emptyWorkspace(), syncing: false, feed: { running: false, error: null }, meetings: { running: false, error: null }, loadFailed: false, error: null, notice: null, matters: { running: false, error: null }, updateReady: null, missing: { screenRecording: false, accessibility: false }, platform: "darwin", appVersion: "1.0.0", workspacePath: "/w.json" } as AppState;
    s.workspace.projects.push({ id: "p1", name: "Matter", client: null, hourlyRate: 0, archived: false } as unknown as AppState["workspace"]["projects"][number]);
    change(s);
    // As it arrives in the window: a copy, never the same objects twice.
    return structuredClone(s);
};

describe("the state as the window holds it", () => {
    it("keeps the workspace itself when a new state changed nothing in it", () => {
        const share = createSharer();
        const first = share(stateOf());
        const second = share(stateOf((s) => { s.syncing = true; }));
        expect(second.workspace).toBe(first.workspace);
        expect(second.syncing).toBe(true);
    });

    it("keeps the parts that did not change and takes the ones that did", () => {
        const share = createSharer();
        const first = share(stateOf());
        const second = share(stateOf((s) => { s.workspace.preferences.captureEnabled = !s.workspace.preferences.captureEnabled; }));
        expect(second.workspace).not.toBe(first.workspace);
        expect(second.workspace.projects).toBe(first.workspace.projects);
        expect(second.workspace.activities).toBe(first.workspace.activities);
        expect(second.workspace.preferences).not.toBe(first.workspace.preferences);
        expect(second.workspace.preferences.captureEnabled).toBe(!first.workspace.preferences.captureEnabled);
        const third = share(stateOf((s) => { s.workspace.projects[0].name = "Renamed"; }));
        expect(third.workspace.projects[0].name).toBe("Renamed");
        expect(third.workspace.preferences.captureEnabled).toBe(first.workspace.preferences.captureEnabled);
    });

    it("drops a part that is gone and takes one that is new", () => {
        const share = createSharer();
        const demo = { seed: "s", epoch: 0, stage: "a", day: "2026-11-15" };
        share(stateOf((s) => { s.workspace.demo = demo; }));
        const without = share(stateOf());
        expect("demo" in without.workspace).toBe(false);
        const again = share(stateOf((s) => { s.workspace.demo = demo; }));
        expect(again.workspace.demo).toEqual(demo);
    });
});
