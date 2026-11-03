import { joinMatter, undoJoin } from "@shared/feed";
import { Feed } from "./feed";
import { appendFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, protocol, shell, systemPreferences, Tray } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { isDestination, type Destination, type Product } from "@shared/kiwi";
import { archiveProject, closeActivity, deleteEntry, dismissActivities, keepStretch, mergeProjects, referencedScreenshots, setMatter, updateProject, type KeepInput, type Preferences } from "@shared/model";
import type { AppState } from "@shared/state";
import { entriesCsv } from "@shared/export";
import { Capture } from "./capture";
import { launchedAtLogin, openAtLogin, setOpenAtLogin } from "./login";
import { Matters, SUGGEST_ON_OPEN_MS } from "./matters";
import { Store } from "./store";
import { Sync, TokenFile } from "./sync";
import { Screenshots, SHOT_SCHEME } from "./screenshots";
import { Updater } from "./updater";
import { acquireLock, WorkspaceFile } from "./workspace";

/* Lawdie Time Capture, main process. One window, one tray item, one workspace file.
   Closing the window does not stop capture; quitting does. */

const argValue = (flag: string): string | null => {
    const index = process.argv.indexOf(flag);
    return index >= 0 && process.argv.length > index + 1 ? process.argv[index + 1] : null;
};

// A verification run captures a window that is usually behind others; without these,
// Chromium stops painting an occluded window and the capture shows a stale frame.
if (argValue("--screenshot")) {
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

// Screenshots load in the window from this scheme; it must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: SHOT_SCHEME, privileges: { standard: true, secure: true } }]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function createWindow(store: Store, hidden = false): BrowserWindow {
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
    // Opened at login: straight to the tray; the window waits until someone asks for it.
    if (!hidden) window.on("ready-to-show", () => window.show());
    window.on("close", (event) => {
        // Capture continues in the background; the tray reopens the window.
        if (!quitting) { event.preventDefault(); window.hide(); }
    });
    window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
    if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(__dirname, "../renderer/index.html"));
    window.webContents.on("did-finish-load", () => { applyTextSize(window, store); window.webContents.send("state", store.snapshot()); });
    return window;
}

/** Settings' text size is the window's zoom, so everything grows together, layout included. */
function applyTextSize(window: BrowserWindow, store: Store): void {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(store.workspace.preferences.textSize ?? 1);
}

const PRIVACY_PANES = { screen: "Privacy_ScreenCapture", accessibility: "Privacy_Accessibility" } as const;

/** A system notification, if the OS shows them; clicking it opens the window. */
function notify(store: Store, title: string, body: string): void {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on("click", () => showWindow(store));
    n.show();
}

/**
 * What a switched-on feature needs from macOS and does not have. An update can lose a grant
 * while System Settings still shows it on (2026-10-23: six days of capture without titles
 * that nobody saw), so this is checked all the time, and the window says so until it is fixed.
 */
function missingPermissions(store: Store, capture: Capture): AppState["missing"] {
    const p = store.workspace.preferences;
    if (process.platform !== "darwin" || !p.captureEnabled) return { screenRecording: false, accessibility: false };
    return {
        screenRecording: (p.captureTitles && capture.titlesRefused) || ((p.captureTitles || p.captureScreenshots === true) && systemPreferences.getMediaAccessStatus("screen") !== "granted"),
        accessibility: p.captureScreenText && !systemPreferences.isTrustedAccessibilityClient(false),
    };
}

function showWindow(store: Store): void {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(store);
    mainWindow.show();
    mainWindow.focus();
}

function buildTray(store: Store, capture: Capture, updater: Updater): void {
    const icon = nativeImage.createFromPath(join(process.resourcesPath ?? "", "resources/brand/tray.png"));
    const fallback = icon.isEmpty() ? nativeImage.createFromPath(join(__dirname, "../../resources/brand/tray.png")) : icon;
    tray = new Tray(fallback.resize({ width: 18, height: 18 }));
    tray.setToolTip("Lawdie Time Capture");
    const refresh = (): void => {
        const on = store.workspace.preferences.captureEnabled;
        const { screenRecording, accessibility } = store.missing;
        const attention = screenRecording || accessibility;
        tray?.setToolTip(attention ? "Lawdie Time Capture: needs a permission in System Settings" : "Lawdie Time Capture");
        const menu = Menu.buildFromTemplate([
            ...(attention ? [{ label: screenRecording ? "⚠ Allow Screen Recording…" : "⚠ Allow Accessibility…", click: () => showWindow(store) }, { type: "separator" as const }] : []),
            ...(store.updateReady ? [{ label: `Install update ${store.updateReady} and restart`, click: () => updater.install() }, { type: "separator" as const }] : []),
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
    const shots = new Screenshots(join(workspacePath, "..", "screenshots"));
    shots.serve();
    const capture = new Capture(store, shots);
    // Files nothing refers to any more (dismissed, pruned, cleared, an entry deleted): at launch, then hourly.
    const collectShots = (): void => { if (!store.loadFailed) shots.collect(referencedScreenshots(store.workspace)); };
    setTimeout(collectShots, 60_000);
    setInterval(collectShots, 60 * 60_000);
    // Office probe failures go to a log beside the workspace: the one place to look when
    // "Read Office document details" is on and nothing arrives (a denied permission, a
    // modal dialog in Office, a timeout).
    capture.office.onError = (officeApp, message) => {
        try { appendFileSync(join(userData, "office.log"), `${new Date().toISOString()} ${officeApp}: ${message}\n`); } catch { /* best effort */ }
    };
    capture.screen.onError = (message) => {
        try { appendFileSync(join(userData, "screen-text.log"), `${new Date().toISOString()} ${message}\n`); } catch { /* best effort */ }
    };
    const deviceLabel = process.platform === "darwin" ? "Mac" : "PC";
    const tokens = new TokenFile(join(userData, "kiwi-token.bin"));
    const sync = new Sync(store, tokens, deviceLabel);
    const matters = new Matters(store, tokens);
    const feed = new Feed(store, tokens);
    const updater = new Updater(store);

    // IPC: the window asks, the store answers. Every mutation goes through store.change.
    ipcMain.handle("importNow", () => feed.pull());
    ipcMain.handle("joinMatter", (_e, localID: string, remoteID: string) => store.change((w) => joinMatter(w, localID, remoteID)));
    ipcMain.handle("undoJoin", (_e, localID: string) => store.change((w) => undoJoin(w, localID)));
    ipcMain.handle("declineJoin", (_e, localID: string) => store.change((w) => { const j = w.feed?.joins.find((j) => j.local_id === localID && !j.status); if (j) j.status = "declined"; }));
    ipcMain.handle("state", () => store.snapshot());
    ipcMain.handle("setCapture", (_e, on: boolean) => { const ok = store.change((w) => { w.preferences.captureEnabled = on; if (!on) closeActivity(w, Date.now(), "paused"); }); void capture.sample(); return ok; });
    ipcMain.handle("setPreference", (_e, key: keyof Preferences, value: Preferences[keyof Preferences]) => {
        const ok = store.change((w) => {
            if (key === "captureTitles" && w.preferences.captureTitles !== value) closeActivity(w, Date.now(), "privacy-change");
            if (key === "captureDocuments" && w.preferences.captureDocuments !== value) { closeActivity(w, Date.now(), "privacy-change"); capture.office.reset(); }
            if (key === "captureScreenText" && w.preferences.captureScreenText !== value) { closeActivity(w, Date.now(), "privacy-change"); capture.screen.reset(); }
            (w.preferences as Record<string, unknown>)[key] = value;
            if (key === "excludedOwnerIDs" && w.currentActivity && Array.isArray(value) && value.includes(w.currentActivity.ownerID)) w.currentActivity = null;
        });
        if (ok && key === "textSize") for (const window of BrowserWindow.getAllWindows()) applyTextSize(window, store);
        if (ok && key === "importKiwiTime") { feed.cancel(); if (value === true) void feed.pull(); }
        if (ok && key === "suggestMatters" && value === true) void matters.suggest();
        // macOS shows its Accessibility prompt (once) when on-screen text is switched on.
        if (ok && key === "captureScreenText" && value === true && process.platform === "darwin") systemPreferences.isTrustedAccessibilityClient(true);
        return ok;
    });
    ipcMain.handle("keepActivity", (_e, ids: string | string[], input: KeepInput) => store.change((w) => { keepStretch(w, Array.isArray(ids) ? ids : [ids], input, Date.now()); }));
    ipcMain.handle("dismissActivity", (_e, ids: string | string[]) => store.change((w) => dismissActivities(w, Array.isArray(ids) ? ids : [ids])));
    ipcMain.handle("deleteEntry", (_e, id: string) => store.change((w) => deleteEntry(w, id)));
    ipcMain.handle("setMatter", (_e, ids: string[], matter: string | null) => store.change((w) => setMatter(w, Array.isArray(ids) ? ids : [], typeof matter === "string" ? matter : null)));
    ipcMain.handle("suggestMatters", (_e, fromButton: boolean) => matters.suggest(fromButton === true ? 0 : SUGGEST_ON_OPEN_MS));
    ipcMain.handle("updateProject", (_e, id: string, change: { name?: string; client?: string; hourlyRate?: number }) => store.change((w) => updateProject(w, String(id), {
        ...(typeof change?.name === "string" ? { name: change.name } : {}),
        ...(typeof change?.client === "string" ? { client: change.client } : {}),
        ...(typeof change?.hourlyRate === "number" ? { hourlyRate: change.hourlyRate } : {}),
    })));
    ipcMain.handle("mergeProjects", (_e, fromID: string, intoID: string) => store.change((w) => mergeProjects(w, String(fromID), String(intoID))));
    ipcMain.handle("archiveProject", (_e, id: string, archived: boolean) => store.change((w) => archiveProject(w, String(id), archived === true)));
    ipcMain.handle("clearActivity", () => { const ok = store.change((w) => { w.activities = []; w.currentActivity = null; w.preferences.captureEnabled = false; }); if (ok) store.say("Activity cleared and capture paused. Saved time entries are unchanged."); return ok; });
    ipcMain.handle("connectKiwi", (_e, destination: Destination, servers: Partial<Record<Product, string>>, token: string) => sync.connect(isDestination(destination) ? destination : "kiwi", servers ?? {}, token));
    ipcMain.handle("disconnectKiwi", () => { feed.cancel(); sync.disconnect(); });
    ipcMain.handle("syncNow", () => sync.syncNow());
    ipcMain.handle("installUpdate", () => updater.install());
    ipcMain.handle("setAutoSync", (_e, on: boolean) => store.change((w) => { if (w.sync) w.sync.autoSync = on; }));
    ipcMain.handle("openAtLogin", () => openAtLogin());
    ipcMain.handle("setOpenAtLogin", (_e, on: boolean) => { setOpenAtLogin(on === true); return openAtLogin(); });
    ipcMain.handle("dismissMessage", () => { store.error = null; store.notice = null; store.publish(); });
    // Kept entries as CSV, where the person chooses. Excel reads UTF-8 only with the BOM.
    ipcMain.handle("exportCsv", async (_e, ids: string[], name: string) => {
        const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
        const options = { title: "Export kept time", defaultPath: join(app.getPath("documents"), String(name || "Lawdie time.csv")), filters: [{ name: "CSV", extensions: ["csv"] }] };
        const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
        if (canceled || !filePath) return false;
        try {
            await writeFile(filePath, "\uFEFF" + entriesCsv(store.workspace, Array.isArray(ids) ? ids.map(String) : []), "utf8");
            store.say(`Exported to ${filePath}.`);
            return true;
        } catch (err) {
            store.error = `Could not export: ${err instanceof Error ? err.message : String(err)}`;
            store.publish();
            return false;
        }
    });
    ipcMain.handle("openScreenshot", (_e, name: string) => { const file = shots.file(String(name)); if (file) void shell.openPath(file); });
    ipcMain.handle("showDataFolder", () => shell.showItemInFolder(workspacePath));
    ipcMain.handle("openExternal", (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
    ipcMain.handle("deviceName", () => hostname());
    ipcMain.handle("officeStatus", () => ({ supported: capture.office.supported, errors: Object.fromEntries(capture.office.lastError) }));
    ipcMain.handle("screenTextStatus", () => ({
        supported: capture.screen.supported,
        trusted: process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) : true,
        error: capture.screen.lastError,
    }));
    ipcMain.handle("openAccessibilitySettings", () => { if (process.platform === "darwin") void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES.accessibility}`); });
    ipcMain.handle("openPrivacySettings", (_e, pane: keyof typeof PRIVACY_PANES) => { if (process.platform === "darwin" && pane in PRIVACY_PANES) void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES[pane]}`); });
    // macOS applies a new grant to a fresh process only.
    ipcMain.handle("relaunch", () => { quitting = true; app.relaunch(); app.quit(); });

    store.subscribe((state) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("state", state); });

    app.on("browser-window-created", (_e, window) => optimizer.watchWindowShortcuts(window));
    // Opened at login: capture resumes as it was left; a pause survives a restart.
    const atLogin = launchedAtLogin() && openAtLogin();
    mainWindow = createWindow(store, atLogin);
    if (argValue("--route")) mainWindow.webContents.once("did-finish-load", () => mainWindow?.webContents.send("route", argValue("--route")));
    // `--screenshot <file.png>` writes the window as rendered, for verification without a person at the screen.
    const shot = argValue("--screenshot");
    if (shot) {
        mainWindow.webContents.on("console-message", (event) => console.log(`[renderer:${event.level}] ${event.message}`));
        // `--click <css selector>` presses one control first, so a folded part of a screen can be captured open.
        const click = argValue("--click");
        mainWindow.webContents.once("did-finish-load", () => {
            if (click) setTimeout(() => void mainWindow?.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(click)}); console.log("--click", el ? el.textContent.slice(0, 60) : "matched nothing"); el?.click(); })()`), 2500);
            setTimeout(() => void mainWindow?.webContents.capturePage().then((image) => writeFileSync(shot, image.toPNG())), 3500);
        });
    }
    buildTray(store, capture, updater);
    updater.onReady = (version) => notify(store, "Update ready", `Lawdie Time Capture ${version} is ready. Open the app and press Install now; it restarts in a few seconds.`);
    // A permission newly missing: said in the window (which opens, once a run), the tray and a notification.
    let raised = false;
    const checkPermissions = (): void => {
        const before = store.missing;
        store.setMissing(missingPermissions(store, capture));
        const now = store.missing;
        const lost = (now.screenRecording && !before.screenRecording) || (now.accessibility && !before.accessibility);
        if (!lost || raised || argValue("--screenshot")) return;
        raised = true;
        notify(store, "Lawdie Time Capture needs a permission", now.screenRecording ? "macOS is not allowing Screen Recording, so window titles are not being captured. Open the app to fix it." : "macOS is not allowing Accessibility, so on-screen text is not being read. Open the app to fix it.");
        showWindow(store);
    };
    // After capture's first lookups, which are what raise macOS's own prompt.
    setTimeout(checkPermissions, 20_000);
    setInterval(checkPermissions, 15_000);
    store.subscribe(() => { if (store.missing.screenRecording || store.missing.accessibility) checkPermissions(); });
    // On-screen text left on from before, without the permission yet: macOS asks now rather than reads failing quietly.
    if (process.platform === "darwin" && store.workspace.preferences.captureScreenText && !systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
    capture.start();
    sync.start();
    matters.start();
    feed.start();
    updater.start();

    // `--kiwi-token <ldt_…> [--kiwi-destination kiwi|crm|both] [--kiwi-server <url>]
    // [--crm-server <url>]` pairs on launch without a person typing the token: provisioning
    // by an admin, and verification. The token is used once and then lives only in the
    // encrypted token file, like one pasted into Settings. The destination defaults to
    // Kiwi, as Settings does; a server left out is that product's default.
    const provisionToken = argValue("--kiwi-token");
    if (provisionToken && !store.workspace.sync) {
        const rawDestination = argValue("--kiwi-destination");
        const destination: Destination = isDestination(rawDestination) ? rawDestination : "kiwi";
        const servers: Partial<Record<Product, string>> = {};
        const kiwiServer = argValue("--kiwi-server"); if (kiwiServer) servers.kiwi = kiwiServer;
        const crmServer = argValue("--crm-server"); if (crmServer) servers.crm = crmServer;
        void sync.connect(destination, servers, provisionToken);
    }

    app.on("second-instance", () => showWindow(store));
    app.on("activate", () => showWindow(store));
    app.on("before-quit", () => { quitting = true; sync.stop(); feed.stop(); matters.stop(); updater.stop(); capture.shutdown(); releaseLock?.(); });
});

// Closing the last window keeps the process (and capture) alive on every platform; Quit is explicit.
app.on("window-all-closed", () => { /* keep running */ });
