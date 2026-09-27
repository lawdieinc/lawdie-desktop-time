import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "@shared/state";
import type { Preferences } from "@shared/model";
import type { Destination } from "@shared/kiwi";

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
    keepActivity: (id: string, input: { description: string; projectID: string | null; billable: boolean }): Promise<boolean> => ipcRenderer.invoke("keepActivity", id, input),
    dismissActivity: (id: string): Promise<boolean> => ipcRenderer.invoke("dismissActivity", id),
    deleteEntry: (id: string): Promise<boolean> => ipcRenderer.invoke("deleteEntry", id),
    clearActivity: (): Promise<boolean> => ipcRenderer.invoke("clearActivity"),
    connectKiwi: (destination: Destination, serverURL: string, token: string): Promise<boolean> => ipcRenderer.invoke("connectKiwi", destination, serverURL, token),
    disconnectKiwi: (): Promise<void> => ipcRenderer.invoke("disconnectKiwi"),
    syncNow: (): Promise<void> => ipcRenderer.invoke("syncNow"),
    setAutoSync: (on: boolean): Promise<boolean> => ipcRenderer.invoke("setAutoSync", on),
    dismissMessage: (): Promise<void> => ipcRenderer.invoke("dismissMessage"),
    showDataFolder: (): Promise<void> => ipcRenderer.invoke("showDataFolder"),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("openExternal", url),
    officeStatus: (): Promise<{ supported: boolean; errors: Record<string, string> }> => ipcRenderer.invoke("officeStatus"),
};

contextBridge.exposeInMainWorld("lawdie", api);
