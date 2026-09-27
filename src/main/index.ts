import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { DEFAULT_SERVER_URL } from "@shared/kiwi";
import { deleteEntry, dismissActivity, keepActivity, closeActivity, type Preferences } from "@shared/model";
import { Capture } from "./capture";
import { Store } from "./store";
import { Sync, TokenFile } from "./sync";
import { acquireLock, WorkspaceFile } from "./workspace";

/* Lawdie Time Capture, main process. One window, one tray item, one workspace file.
   Closing the window does not stop capture; quitting does. */

const argValue = (flag: string): string | null => {
    const index = process.argv.indexOf(flag);
    return index >= 0 && process.argv.length > index + 1 ? process.argv[index + 1] : null;
};

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function createWindow(store: Store): BrowserWindow {
    const window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 980,
        minHeight: 640,
        title: "Lawdie Time Capture",
        backgroundColor: "#F9F6F2",
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
        // electron-vite emits the preload as .mjs for a "type": "module" package; ESM preloads need sandbox off.
        webPreferences: { preload: join(__dirname, "../preload/index.mjs"), sandbox: false, contextIsolation: true },
    });
    window.on("ready-to-show", () => window.show());
    window.on("close", (event) => {
        // Capture continues in the background; the tray reopens the window.
        if (!quitting) { event.preventDefault(); window.hide(); }
    });
    window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
    if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(__dirname, "../renderer/index.html"));
    window.webContents.on("did-finish-load", () => window.webContents.send("state", store.snapshot()));
    return window;
}

function showWindow(store: Store): void {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(store);
    mainWindow.show();
    mainWindow.focus();
}

function buildTray(store: Store, capture: Capture): void {
    const icon = nativeImage.createFromPath(join(process.resourcesPath ?? "", "resources/brand/tray.png"));
    const fallback = icon.isEmpty() ? nativeImage.createFromPath(join(__dirname, "../../resources/brand/tray.png")) : icon;
    tray = new Tray(fallback.resize({ width: 18, height: 18 }));
    tray.setToolTip("Lawdie Time Capture");
    const refresh = (): void => {
        const on = store.workspace.preferences.captureEnabled;
        const menu = Menu.buildFromTemplate([
            { label: on ? "Capture is on" : "Capture is paused", enabled: false },
            { label: on ? "Pause capture" : "Enable capture", click: () => { store.change((w) => { w.preferences.captureEnabled = !on; if (on) closeActivity(w, Date.now(), "paused"); }); void capture.sample(); } },
            { type: "separator" },
            { label: "Open Time Capture", click: () => showWindow(store) },
            { label: "Quit", click: () => { quitting = true; app.quit(); } },
        ]);
        tray?.setContextMenu(menu);
    };
    refresh();
    store.subscribe(refresh);
    tray.on("click", () => showWindow(store));
}

app.whenReady().then(() => {
    electronApp.setAppUserModelId("co.lawdie.timecapture.desktop");
    if (!app.requestSingleInstanceLock()) { app.quit(); return; }

    const userData = app.getPath("userData");
    const workspacePath = argValue("--workspace") ?? join(userData, "workspace.json");
    let releaseLock: (() => void) | null = null;
    try {
        releaseLock = acquireLock(join(workspacePath, ".."));
    } catch (err) {
        dialog.showErrorBox("Lawdie Time Capture", err instanceof Error ? err.message : String(err));
        app.quit();
        return;
    }

    const store = new Store(new WorkspaceFile(workspacePath), app.getVersion());
    const capture = new Capture(store);
    // Office probe failures go to a log beside the workspace: the one place to look when
    // "Read Office document details" is on and nothing arrives (a denied permission, a
    // modal dialog in Office, a timeout).
    capture.office.onError = (officeApp, message) => {
        try { appendFileSync(join(userData, "office.log"), `${new Date().toISOString()} ${officeApp}: ${message}\n`); } catch { /* best effort */ }
    };
    const deviceLabel = process.platform === "darwin" ? "Mac" : "PC";
    const sync = new Sync(store, new TokenFile(join(userData, "kiwi-token.bin")), deviceLabel);

    // IPC: the window asks, the store answers. Every mutation goes through store.change.
    ipcMain.handle("state", () => store.snapshot());
    ipcMain.handle("setCapture", (_e, on: boolean) => { const ok = store.change((w) => { w.preferences.captureEnabled = on; if (!on) closeActivity(w, Date.now(), "paused"); }); void capture.sample(); return ok; });
    ipcMain.handle("setPreference", (_e, key: keyof Preferences, value: Preferences[keyof Preferences]) => store.change((w) => {
        if (key === "captureTitles" && w.preferences.captureTitles !== value) closeActivity(w, Date.now(), "privacy-change");
        if (key === "captureDocuments" && w.preferences.captureDocuments !== value) { closeActivity(w, Date.now(), "privacy-change"); capture.office.reset(); }
        (w.preferences as Record<string, unknown>)[key] = value;
        if (key === "excludedOwnerIDs" && w.currentActivity && Array.isArray(value) && value.includes(w.currentActivity.ownerID)) w.currentActivity = null;
    }));
    ipcMain.handle("keepActivity", (_e, id: string, input: { description: string; projectID: string | null; billable: boolean }) => store.change((w) => { keepActivity(w, id, input, Date.now()); }));
    ipcMain.handle("dismissActivity", (_e, id: string) => store.change((w) => dismissActivity(w, id)));
    ipcMain.handle("deleteEntry", (_e, id: string) => store.change((w) => deleteEntry(w, id)));
    ipcMain.handle("clearActivity", () => { const ok = store.change((w) => { w.activities = []; w.currentActivity = null; w.preferences.captureEnabled = false; }); if (ok) store.say("Activity cleared and capture paused. Saved time entries are unchanged."); return ok; });
    ipcMain.handle("connectKiwi", (_e, serverURL: string, token: string) => sync.connect(serverURL, token));
    ipcMain.handle("disconnectKiwi", () => sync.disconnect());
    ipcMain.handle("syncNow", () => sync.syncNow());
    ipcMain.handle("setAutoSync", (_e, on: boolean) => store.change((w) => { if (w.sync) w.sync.autoSync = on; }));
    ipcMain.handle("dismissMessage", () => { store.error = null; store.notice = null; store.publish(); });
    ipcMain.handle("showDataFolder", () => shell.showItemInFolder(workspacePath));
    ipcMain.handle("openExternal", (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
    ipcMain.handle("deviceName", () => hostname());
    ipcMain.handle("officeStatus", () => ({ supported: capture.office.supported, errors: Object.fromEntries(capture.office.lastError) }));

    store.subscribe((state) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("state", state); });

    app.on("browser-window-created", (_e, window) => optimizer.watchWindowShortcuts(window));
    mainWindow = createWindow(store);
    if (argValue("--route")) mainWindow.webContents.once("did-finish-load", () => mainWindow?.webContents.send("route", argValue("--route")));
    // `--screenshot <file.png>` writes the window as rendered, for verification without a person at the screen.
    const shot = argValue("--screenshot");
    if (shot) {
        mainWindow.webContents.on("console-message", (event) => console.log(`[renderer:${event.level}] ${event.message}`));
        mainWindow.webContents.once("did-finish-load", () => setTimeout(() => void mainWindow?.webContents.capturePage().then((image) => writeFileSync(shot, image.toPNG())), 2500));
    }
    buildTray(store, capture);
    capture.start();
    sync.start();

    // `--kiwi-token <ldt_…> [--kiwi-server <url>]` pairs on launch without a person typing the
    // token: provisioning by an admin, and verification. The token is used once and then
    // lives only in the encrypted token file, like one pasted into Settings.
    const provisionToken = argValue("--kiwi-token");
    if (provisionToken && !store.workspace.sync) {
        void sync.connect(argValue("--kiwi-server") ?? DEFAULT_SERVER_URL, provisionToken);
    }

    app.on("second-instance", () => showWindow(store));
    app.on("activate", () => showWindow(store));
    app.on("before-quit", () => { quitting = true; sync.stop(); capture.shutdown(); releaseLock?.(); });
});

// Closing the last window keeps the process (and capture) alive on every platform; Quit is explicit.
app.on("window-all-closed", () => { /* keep running */ });
