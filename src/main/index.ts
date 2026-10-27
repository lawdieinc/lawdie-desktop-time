import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, hostname } from "node:os";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, systemPreferences, Tray } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { isDestination, KiwiClient, PRODUCTS, type Destination, type Product } from "@shared/kiwi";
import { evidenceFor, modelDrafter, rulesDrafter, type Drafter } from "@shared/drafter";
import { parseCsv, typedRows } from "@shared/importMatch";
import { addTypedRow, clearImports, decideRow, editTypedRow, expandRow, linkAll, removeTypedRow, type TypedInput } from "@shared/typed";
import { localDay, rulebooksOf, shortName } from "@shared/invoice";
import { footerTemplate, invoiceHtml, timeSheetHtml } from "@shared/invoiceHtml";
import { applyRules, type AppliedBill } from "@shared/applyRules";
import { timeSheetDocx } from "./docx";
import { readXlsx } from "./xlsx";
import { archiveProject, closeActivity, setNarrative, deleteEntry, dismissActivities, editEntry, keepLines, keepStretch, mergeProjects, setMatter, updateProject, type EntryChange, type InvoiceTerms, type KeepInput, type KeepLine, type Preferences, type Workspace } from "@shared/model";
import { demoNow } from "@shared/demo";
import { Capture } from "./capture";
import { launchedAtLogin, openAtLogin, setOpenAtLogin } from "./login";
import { Matters, SUGGEST_ON_OPEN_MS } from "./matters";
import { RulesFeed } from "./rulesFeed";
import { Store } from "./store";
import { Sync, TokenFile } from "./sync";
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

// A demo or a verification run keeps its own app data, so it never locks or touches the person's real workspace.
if (process.env.LAWDIE_USER_DATA) app.setPath("userData", process.env.LAWDIE_USER_DATA);

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
    // A verification run (--screenshot) stays out of the person's way: shown without focus, see-through, and
    // deaf to the mouse, so it still paints for the capture but nobody can click or type into it.
    const quiet = !!argValue("--screenshot");
    if (quiet) { window.setFocusable(false); window.setIgnoreMouseEvents(true); window.setOpacity(0); }
    if (!hidden) window.on("ready-to-show", () => (quiet ? window.showInactive() : window.show()));
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
    capture.screen.onError = (message) => {
        try { appendFileSync(join(userData, "screen-text.log"), `${new Date().toISOString()} ${message}\n`); } catch { /* best effort */ }
    };
    const deviceLabel = process.platform === "darwin" ? "Mac" : "PC";
    const tokens = new TokenFile(join(userData, "kiwi-token.bin"));
    const sync = new Sync(store, tokens, deviceLabel);
    const matters = new Matters(store, tokens);
    const updater = new Updater(store);
    // `--rules-feed <url|file>`: client billing rules from the billing system; `--demo <seed.json>`: a demo workspace the feed's console drives.
    let rulesFeed: RulesFeed | null = null;
    try {
        rulesFeed = new RulesFeed(store, argValue("--rules-feed") ?? process.env.LAWDIE_RULES_FEED ?? null, argValue("--demo") ?? process.env.LAWDIE_DEMO_SEED ?? null, join(workspacePath, ".."));
    } catch (err) {
        dialog.showErrorBox("Lawdie Time Capture", `The demo seed could not be read. ${err instanceof Error ? err.message : String(err)}`);
    }
    // A demo runs on its seeded day's clock, so time kept on that day is never "in the future".
    const clock = (): number => demoNow(store.workspace, Date.now());

    // IPC: the window asks, the store answers. Every mutation goes through store.change.
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
        if (ok && key === "suggestMatters" && value === true) void matters.suggest();
        // macOS shows its Accessibility prompt (once) when on-screen text is switched on.
        if (ok && key === "captureScreenText" && value === true && process.platform === "darwin") systemPreferences.isTrustedAccessibilityClient(true);
        return ok;
    });
    ipcMain.handle("keepActivity", (_e, ids: string | string[], input: KeepInput) => store.change((w) => { keepStretch(w, Array.isArray(ids) ? ids : [ids], input, clock()); }));
    ipcMain.handle("keepLines", (_e, lines: KeepLine[]) => store.change((w) => { keepLines(w, Array.isArray(lines) ? lines : [], clock()); }));
    ipcMain.handle("editEntry", (_e, id: string, change: EntryChange) => store.change((w) => { editEntry(w, String(id), change ?? {}, clock()); }));
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
    ipcMain.handle("disconnectKiwi", () => sync.disconnect());
    ipcMain.handle("syncNow", () => sync.syncNow());
    ipcMain.handle("installUpdate", () => updater.install());
    ipcMain.handle("setAutoSync", (_e, on: boolean) => store.change((w) => { if (w.sync) w.sync.autoSync = on; }));
    ipcMain.handle("openAtLogin", () => openAtLogin());
    ipcMain.handle("setOpenAtLogin", (_e, on: boolean) => { setOpenAtLogin(on === true); return openAtLogin(); });
    ipcMain.handle("dismissMessage", () => { store.error = null; store.notice = null; store.publish(); });
    ipcMain.handle("showDataFolder", () => shell.showItemInFolder(workspacePath));
    ipcMain.handle("openExternal", (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
    // A narrative's source: an Outlook web link opens in the browser, a document from disk. Looked up here by id, so the window names no paths.
    const localPath = (p: string): string => p.replace(/^~(?=\/)/, homedir());
    ipcMain.handle("openSource", async (_e, id: string, what?: "link" | "path" | "screenshot") => {
        const ev = store.workspace.evidence?.[String(id)];
        const want = what ?? (ev?.link ? "link" : "path");
        if (want === "link" && ev?.link && /^https:\/\//.test(ev.link)) { await shell.openExternal(ev.link); return null; }
        const file = want === "screenshot" ? ev?.screenshot : want === "path" ? ev?.path : undefined;
        if (file) { const failed = await shell.openPath(localPath(file)); return failed ? `Could not open ${ev?.file ?? "the file"}: ${failed}` : null; }
        return "There is nothing to open for this source yet.";
    });
    // A source's screenshot for the in-app viewer, as a data URL (the page's CSP allows data: images only). Null when it cannot be read.
    ipcMain.handle("screenshotData", (_e, id: string) => {
        const shot = store.workspace.evidence?.[String(id)]?.screenshot;
        if (!shot || !/\.png$/i.test(shot)) return null;
        try { return `data:image/png;base64,${readFileSync(localPath(shot)).toString("base64")}`; } catch { return null; }
    });
    // Draft an entry's narrative again with the drafter chosen in Settings. Model needs Kiwi; without it, the stored parts stand.
    ipcMain.handle("draftNarrative", async (_e, id: string) => {
        const w = store.workspace;
        const entry = w.entries.find((x) => x.id === String(id));
        if (!entry) return { drafter: "rules", message: "That entry no longer exists." };
        let drafter: Drafter = rulesDrafter;
        let message: string | null = null;
        if ((w.preferences.narrativeDrafter ?? "rules") === "model") {
            const kiwi = w.sync?.targets.find((t) => t.product === "kiwi");
            const token = kiwi ? tokens.load() : null;
            if (kiwi && token) {
                const client = new KiwiClient(kiwi.serverURL, token, fetch, 120_000, PRODUCTS.kiwi.label);
                drafter = modelDrafter((body) => client.drafts(body), w.projects.find((p) => p.id === entry.projectID)?.name ?? null);
            } else message = "Model not connected. Connect this computer to Kiwi in Settings. The rules draft stands.";
        }
        try {
            const d = await drafter.draft(entry, evidenceFor(entry, w.evidence));
            if (d.parts.length) store.change((x) => { setNarrative(x, entry.id, d.parts, d.drafter, clock()); });
            return { drafter: d.drafter, message };
        } catch (err) {
            console.warn("[drafter]", err instanceof Error ? err.message : err);
            return { drafter: "rules", message: `The model could not draft this entry, so the rules draft stands. ${err instanceof Error ? err.message : ""}`.trim() };
        }
    });
    // Import entries typed into the firm's time system (.csv or .xlsx). They show as typed until "Link sources and draft narratives".
    const importFile = (file: string): boolean => {
        try {
            const table = /\.xlsx$/i.test(file) ? readXlsx(readFileSync(file)) : parseCsv(readFileSync(file, "utf8"));
            const year = new Date(clock()).getFullYear();
            const rows = typedRows(table, year);
            if (!rows.length) { store.error = "That file has no time entries in it."; store.publish(); return false; }
            const stamp = Date.now().toString(36);
            // A new import replaces the last one (its decisions undone); entries added on the Time page stay.
            const ok = store.change((w) => {
                clearImports(w);
                w.imported = [...(w.imported ?? []), ...rows.map((r, n) => ({ ...r, id: `import-${stamp}-${n}`, entryID: null, decision: null, linked: false, origin: "import" as const, source: /\.xlsx$/i.test(file) ? "excel" as const : "itimekeep" as const }))];
            });
            if (ok) store.say(`Imported ${rows.length} ${rows.length === 1 ? "entry" : "entries"} from ${basename(file)}.`);
            return ok;
        } catch (err) {
            store.error = `That file could not be read. ${err instanceof Error ? err.message : ""}`.trim();
            store.publish();
            return false;
        }
    };
    ipcMain.handle("importEntries", async () => {
        const res = await dialog.showOpenDialog({ title: "Import time entries", properties: ["openFile"], filters: [{ name: "Time entries", extensions: ["csv", "xlsx"] }] });
        return res.canceled || !res.filePaths[0] ? false : importFile(res.filePaths[0]);
    });
    // Typed entries (src/shared/typed.ts): imported rows and entries added on the Time page. "Expand narrative" and
    // "Link sources and draft narratives" match them to captured work; the window shows the links being made.
    ipcMain.handle("linkImport", () => store.change((w) => { linkAll(w); }));
    ipcMain.handle("expandTyped", (_e, id: string) => store.change((w) => { expandRow(w, String(id)); }));
    ipcMain.handle("importDecision", (_e, id: string, decision: "use" | "keep" | null) => store.change((w) => {
        decideRow(w, String(id), decision === "use" || decision === "keep" ? decision : null);
    }));
    ipcMain.handle("clearImport", () => store.change((w) => { clearImports(w); }));
    ipcMain.handle("addTyped", (_e, input: TypedInput) => store.change((w) => {
        addTypedRow(w, { date: String(input?.date ?? ""), note: String(input?.note ?? ""), hours: input?.hours ?? null, projectID: input?.projectID ?? null }, `typed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    }));
    ipcMain.handle("editTyped", (_e, id: string, change: { description?: string; hours?: string }) => store.change((w) => {
        editTypedRow(w, String(id), { description: change?.description, hours: change?.hours });
    }));
    ipcMain.handle("removeTyped", (_e, id: string) => store.change((w) => { removeTypedRow(w, String(id)); }));
    // One of a client's rules on or off (the rules page); the older single-client rules follow when they name the same rule.
    ipcMain.handle("setClientRule", (_e, bookKey: string, id: string, enabled: boolean) => store.change((w) => {
        const rule = rulebooksOf(w).find((b) => b.key === String(bookKey))?.rules.find((r) => r.id === String(id));
        if (rule) rule.enabled = enabled === true;
        const legacy = w.clientRules?.rules.find((r) => r.id === String(id));
        if (legacy && (bookKey === "client" || w.clientRulebooks?.[0]?.key === bookKey)) legacy.enabled = enabled === true;
    }));
    // Apply a client's rulebook to the day, or none (generic billing).
    ipcMain.handle("setBillingClient", (_e, key: string | null) => store.change((w) => {
        w.billingClient = key && rulebooksOf(w).some((b) => b.key === key) ? key : null;
    }));

    /** The matter folder for billing files, or the folder the person picks when it is missing. Null when they cancel. */
    const billingFolder = async (terms: InvoiceTerms, what: string): Promise<string | null> => {
        const folder = terms.folder ? localPath(terms.folder) : "";
        if (folder && existsSync(folder)) return folder;
        const res = await dialog.showOpenDialog({ title: `Where should the ${what} go?`, properties: ["openDirectory", "createDirectory"] });
        return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
    };
    const saved = (folder: string, name: string, data: Buffer): void => {
        const out = join(folder, name);
        writeFileSync(out, data);
        if (!argValue("--screenshot")) void shell.openPath(out);
        store.say(`Saved ${name} in ${basename(folder)}.`);
    };
    const logoFile = (terms: InvoiceTerms): Buffer | null => { try { return terms.logo ? readFileSync(localPath(terms.logo)) : null; } catch { return null; } };
    // The day's time sheet or invoice: generic (standard rates, no client rules) or with the client's rules that are on.
    // HTML from src/shared/invoice.ts, printed to PDF in a hidden window, saved in the matter folder, opened.
    /** The rulebook a billing file is for: a client's key, "generic", or the older "rules" (the first client). */
    /** The applied bill for a billing file: the day shown on the Time page (else the demo day, else today) and the mode
     *  ("generic" or a client's key), from the one function the Time page renders from too. */
    const billOf = (w: Workspace, mode: string | null | undefined, day: string | null | undefined): AppliedBill =>
        applyRules(w, day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : w.demo?.day ?? localDay(new Date(clock()).toISOString()), mode ?? "generic");
    const modeTag = (bill: AppliedBill): string => (bill.book ? ` (${shortName(bill.book)} rules)` : " (generic)");
    ipcMain.handle("makePdf", async (_e, kind: "timesheet" | "invoice", mode: string = "generic", day?: string) => {
        const w = store.workspace, terms = w.invoice;
        if (!terms) return "This workspace has no billing terms for a time sheet or invoice.";
        const png = logoFile(terms);
        const logo = png ? `data:image/png;base64,${png.toString("base64")}` : null;
        const bill = billOf(w, mode, day);
        const html = kind === "invoice" ? invoiceHtml(w, terms, logo, new Date(clock()), bill) : timeSheetHtml(w, terms, logo, bill);
        const tag = modeTag(bill);
        const name = kind === "invoice" ? `Invoice ${terms.number} ${terms.matter}${tag}.pdf` : `Time detail ${w.profile?.name ?? terms.timekeeper.name} ${terms.matter}${tag}.pdf`;
        const folder = await billingFolder(terms, "PDF");
        if (!folder) return null;
        const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
        try {
            await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`);
            const pdf = await win.webContents.printToPDF({ pageSize: "Letter", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: footerTemplate(terms) });
            saved(folder, name, pdf);
            return null;
        } catch (err) {
            return `The PDF could not be made. ${err instanceof Error ? err.message : ""}`.trim();
        } finally {
            win.destroy();
        }
    });
    // The time sheet with the client's rules as Word tracked changes and comments (src/main/docx.ts).
    ipcMain.handle("makeDocx", async (_e, mode: string = "generic", day?: string) => {
        const w = store.workspace, terms = w.invoice;
        if (!terms) return "This workspace has no billing terms for a time sheet.";
        const folder = await billingFolder(terms, "time sheet");
        if (!folder) return null;
        const bill = billOf(w, mode, day);
        try {
            saved(folder, `Time detail ${w.profile?.name ?? terms.timekeeper.name} ${terms.matter}${modeTag(bill)}.docx`, await timeSheetDocx(w, terms, logoFile(terms), new Date(), bill));
            return null;
        } catch (err) {
            return `The time sheet could not be made. ${err instanceof Error ? err.message : ""}`.trim();
        }
    });
    ipcMain.handle("deviceName", () => hostname());
    ipcMain.handle("officeStatus", () => ({ supported: capture.office.supported, errors: Object.fromEntries(capture.office.lastError) }));
    ipcMain.handle("screenTextStatus", () => ({
        supported: capture.screen.supported,
        trusted: process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) : true,
        error: capture.screen.lastError,
    }));
    ipcMain.handle("openAccessibilitySettings", () => { if (process.platform === "darwin") void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"); });

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
        // `--steps "btn:Keep time||type:input[autofocus]=Review draft||click:.fix"` walks a flow first, one step a second:
        // btn: presses the first visible button whose text starts with it, click: a CSS selector, hover: points at one, type: sets an input's value,
        // context: right-clicks one, wait: lets a second pass, tips: logs each visible control that has no tooltip.
        const steps = (argValue("--steps") ?? "").split("||").filter(Boolean);
        const run = (step: string): string => `(() => {
            const s = ${JSON.stringify(step)}; const [kind, ...rest] = s.split(":"); const arg = rest.join(":");
            const visible = (e) => e.offsetParent !== null;
            if (kind === "scroll") { const el = [...document.querySelectorAll(arg)].filter(visible)[0]; console.log("--steps", s, el ? "ok" : "matched nothing"); el?.scrollIntoView({ block: "start" }); return; }
            if (kind === "hover") { const el = [...document.querySelectorAll(arg)].filter(visible)[0]; console.log("--steps", s, el ? "ok" : "matched nothing"); el?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); return; }
            if (kind === "context") { const el = [...document.querySelectorAll(arg)].filter(visible)[0]; console.log("--steps", s, el ? "ok" : "matched nothing"); if (!el) return;
                const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.bottom - 2 })); return; }
            if (kind === "wait") return;
            if (kind === "tips") { const bad = [...document.querySelectorAll("button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button], [role=tab], [role=link]")].filter(visible)
                .filter((e) => !(e.getAttribute("title") || e.getAttribute("data-tip") || e.closest("label[title]") || "").toString().trim()).map((e) => e.outerHTML.slice(0, 140));
                console.log("--steps tips", bad.length ? bad.length + " without a tooltip: " + JSON.stringify(bad) : "every visible control has a tooltip"); return; }
            if (kind === "btn") { const el = [...document.querySelectorAll("button")].filter(visible).find((b) => b.textContent.trim().startsWith(arg)); console.log("--steps", s, el ? "ok" : "matched nothing"); el?.click(); return; }
            if (kind === "type") { const [sel, ...t] = arg.split("="); const el = [...document.querySelectorAll(sel)].filter(visible)[0]; console.log("--steps", s, el ? "ok" : "matched nothing"); if (!el) return;
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, t.join("=")); el.dispatchEvent(new Event("input", { bubbles: true })); return; }
            const el = [...document.querySelectorAll(arg)].filter(visible)[0]; console.log("--steps", s, el ? "ok" : "matched nothing"); el?.click();
        })()`;
        mainWindow.webContents.once("did-finish-load", () => {
            if (click) setTimeout(() => void mainWindow?.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(click)}); console.log("--click", el ? el.textContent.slice(0, 60) : "matched nothing"); el?.click(); })()`), 2500);
            steps.forEach((step, n) => setTimeout(() => void mainWindow?.webContents.executeJavaScript(run(step)), 3000 + n * 1200));
            setTimeout(() => void mainWindow?.webContents.capturePage().then((image) => writeFileSync(shot, image.toPNG())), 4000 + steps.length * 1200);
        });
    }
    buildTray(store, capture);
    // On-screen text left on from before, without the permission yet: macOS asks now rather than reads failing quietly.
    if (process.platform === "darwin" && store.workspace.preferences.captureScreenText && !systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
    capture.start();
    sync.start();
    matters.start();
    updater.start();
    rulesFeed?.start();
    // `--import <file.csv|.xlsx>` imports time entries at launch, as the Time page's Import entries does (verification, demos).
    const importArg = argValue("--import");
    if (importArg) importFile(importArg);

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
    app.on("before-quit", () => { quitting = true; sync.stop(); matters.stop(); rulesFeed?.stop(); updater.stop(); capture.shutdown(); releaseLock?.(); });
});

// Closing the last window keeps the process (and capture) alive on every platform; Quit is explicit.
app.on("window-all-closed", () => { /* keep running */ });
