import type { Workspace } from "./model";

/** What the window sees. Built by the main process's Store, sent whole on every change. */
export type AppState = {
    workspace: Workspace;
    syncing: boolean;
    feed: { running: boolean; error: string | null };
    /** Calendar meetings through Kiwi (src/main/meetings.ts): asking now, and the last failure. */
    meetings: { running: boolean; error: string | null };
    loadFailed: boolean;
    error: string | null;
    notice: string | null;
    /** Matter suggestions: asking Kiwi now, and the last failure. */
    matters: { running: boolean; error: string | null };
    /** A newer version downloaded and waiting for a restart, or null. */
    updateReady: string | null;
    /** macOS permissions a switched-on feature needs and does not have (an update can lose them). */
    missing: { screenRecording: boolean; accessibility: boolean };
    platform: NodeJS.Platform;
    appVersion: string;
    workspacePath: string;
};

/**
 * The window gets the whole state again on every change (capture saves every few seconds), as fresh objects, so
 * nothing in it is the object the screens already worked from and every list would be worked out and drawn again.
 * This hands back the parts of the workspace that did not change as the objects from last time: a tick that only
 * moved the sitting in progress leaves `activities`, `entries` and `projects` as they were, and a tick that changed
 * nothing leaves the workspace itself. One of these lives for as long as the window does.
 */
export function createSharer(): (state: AppState) => AppState {
    const parts = new Map<string, { json: string; value: unknown }>();
    let last: Workspace | null = null;
    return (state) => {
        const next = state.workspace as unknown as Record<string, unknown>;
        const shared: Record<string, unknown> = {};
        let same = last !== null && Object.keys(next).length === parts.size;
        for (const key of Object.keys(next)) {
            const json = JSON.stringify(next[key]) ?? "";
            const had = parts.get(key);
            if (had && had.json === json) shared[key] = had.value;
            else { parts.set(key, { json, value: next[key] }); shared[key] = next[key]; same = false; }
        }
        for (const key of [...parts.keys()]) if (!(key in next)) parts.delete(key);
        if (!same) last = shared as unknown as Workspace;
        return { ...state, workspace: last as Workspace };
    };
}
