import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "@shared/state";
import type { KeepInput, Preferences } from "@shared/model";
import type { Destination, Product } from "@shared/kiwi";

/* The whole surface the window may touch. Nothing else from Node or Electron is exposed. */
export const api = {
    getState: (): Promise<AppState> => ipcRenderer.invoke("state"),
    onState: (listener: (state: AppState) => void): (() => void) => {
        const handler = (_e: unknown, state: AppState): void => listener(state);
        ipcRenderer.on("state", handler);
        return () => ipcRenderer.removeListener("state", handler);
    },
    onRoute: (listener: (route: string) => void): (() => void) => {
        const handler = (_e: unknown, route: string): void => listener(route);
        ipcRenderer.on("route", handler);
        return () => ipcRenderer.removeListener("route", handler);
    },
    setCapture: (on: boolean): Promise<boolean> => ipcRenderer.invoke("setCapture", on),
    setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<boolean> => ipcRenderer.invoke("setPreference", key, value),
    /** One activity, or every sitting of a stretch, as one entry. */
    keepActivity: (ids: string | string[], input: KeepInput): Promise<boolean> => ipcRenderer.invoke("keepActivity", ids, input),
    dismissActivity: (ids: string | string[]): Promise<boolean> => ipcRenderer.invoke("dismissActivity", ids),
    deleteEntry: (id: string): Promise<boolean> => ipcRenderer.invoke("deleteEntry", id),
    /** The person names (or, with null, clears) the matter of pending activities. */
    setMatter: (ids: string[], matter: string | null): Promise<boolean> => ipcRenderer.invoke("setMatter", ids, matter),
    suggestMatters: (): Promise<void> => ipcRenderer.invoke("suggestMatters"),
    /** A matter's name, client or rate; the rate applies to time kept from now on. */
    updateProject: (id: string, change: { name?: string; client?: string; hourlyRate?: number }): Promise<boolean> => ipcRenderer.invoke("updateProject", id, change),
    mergeProjects: (fromID: string, intoID: string): Promise<boolean> => ipcRenderer.invoke("mergeProjects", fromID, intoID),
    archiveProject: (id: string, archived: boolean): Promise<boolean> => ipcRenderer.invoke("archiveProject", id, archived),
    clearActivity: (): Promise<boolean> => ipcRenderer.invoke("clearActivity"),
    connectKiwi: (destination: Destination, servers: Partial<Record<Product, string>>, token: string): Promise<boolean> => ipcRenderer.invoke("connectKiwi", destination, servers, token),
    disconnectKiwi: (): Promise<void> => ipcRenderer.invoke("disconnectKiwi"),
    syncNow: (): Promise<void> => ipcRenderer.invoke("syncNow"),
    setAutoSync: (on: boolean): Promise<boolean> => ipcRenderer.invoke("setAutoSync", on),
    openAtLogin: (): Promise<boolean> => ipcRenderer.invoke("openAtLogin"),
    /** Resolves to what the OS now reports, which may differ if it refused. */
    setOpenAtLogin: (on: boolean): Promise<boolean> => ipcRenderer.invoke("setOpenAtLogin", on),
    dismissMessage: (): Promise<void> => ipcRenderer.invoke("dismissMessage"),
    showDataFolder: (): Promise<void> => ipcRenderer.invoke("showDataFolder"),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("openExternal", url),
    officeStatus: (): Promise<{ supported: boolean; errors: Record<string, string> }> => ipcRenderer.invoke("officeStatus"),
    /** Whether on-screen text can be read here, and (macOS) whether Accessibility is allowed. */
    screenTextStatus: (): Promise<{ supported: boolean; trusted: boolean; error: string | null }> => ipcRenderer.invoke("screenTextStatus"),
    openAccessibilitySettings: (): Promise<void> => ipcRenderer.invoke("openAccessibilitySettings"),
};

contextBridge.exposeInMainWorld("lawdie", api);
