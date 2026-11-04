import { contextBridge, ipcRenderer } from "electron";
import type { AppState } from "@shared/state";
import type { BillingSetup, EntryChange, KeepInput, KeepLine, Preferences, ProjectChange } from "@shared/model";
import type { BillScope } from "@shared/invoice";
import type { ClientRuleInput, RulebookInput } from "@shared/clientRulebooks";
import type { Destination, Product } from "@shared/kiwi";

/* The whole surface the window may touch. Nothing else from Node or Electron is exposed. */
export const api = {
    importNow: (): Promise<void> => ipcRenderer.invoke("importNow"),
    joinMatter: (localID: string, kiwiID: string): Promise<boolean> => ipcRenderer.invoke("joinMatter", localID, kiwiID),
    undoJoin: (localID: string): Promise<boolean> => ipcRenderer.invoke("undoJoin", localID),
    declineJoin: (localID: string): Promise<boolean> => ipcRenderer.invoke("declineJoin", localID),
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
    /** A matter's day split into one entry per task, all or nothing. */
    keepLines: (lines: KeepLine[]): Promise<boolean> => ipcRenderer.invoke("keepLines", lines),
    /** A kept entry's description, hours, codes, billable flag or rate: a client rule's fix, or a person's edit. */
    editEntry: (id: string, change: EntryChange): Promise<boolean> => ipcRenderer.invoke("editEntry", id, change),
    dismissActivity: (ids: string | string[]): Promise<boolean> => ipcRenderer.invoke("dismissActivity", ids),
    deleteEntry: (id: string): Promise<boolean> => ipcRenderer.invoke("deleteEntry", id),
    /** The person's description of pending activities, before keeping; "" clears it. */
    describeActivities: (ids: string[], text: string): Promise<boolean> => ipcRenderer.invoke("describeActivities", ids, text),
    /** New time merged into a kept entry, which goes back to review with it; or kept apart from it for good. */
    mergeIntoEntry: (ids: string[], entryID: string): Promise<boolean> => ipcRenderer.invoke("mergeIntoEntry", ids, entryID),
    keepSeparate: (ids: string[], entryID: string): Promise<boolean> => ipcRenderer.invoke("keepSeparate", ids, entryID),
    /** A matter renamed from a review row: its project if it has one, else the activity named after it. */
    renameMatter: (from: string, to: string): Promise<boolean> => ipcRenderer.invoke("renameMatter", from, to),
    /** The person names (or, with null, clears) the matter of pending activities. */
    setMatter: (ids: string[], matter: string | null): Promise<boolean> => ipcRenderer.invoke("setMatter", ids, matter),
    /** From the button: now. Otherwise (opening Activity): only if the last run was over ten minutes ago. */
    suggestMatters: (fromButton = false): Promise<void> => ipcRenderer.invoke("suggestMatters", fromButton),
    /** A matter's name, client or rate; the rate applies to time kept from now on. */
    updateProject: (id: string, change: ProjectChange): Promise<boolean> => ipcRenderer.invoke("updateProject", id, change),
    mergeProjects: (fromID: string, intoID: string): Promise<boolean> => ipcRenderer.invoke("mergeProjects", fromID, intoID),
    archiveProject: (id: string, archived: boolean): Promise<boolean> => ipcRenderer.invoke("archiveProject", id, archived),
    clearActivity: (): Promise<boolean> => ipcRenderer.invoke("clearActivity"),
    connectKiwi: (destination: Destination, servers: Partial<Record<Product, string>>, token: string): Promise<boolean> => ipcRenderer.invoke("connectKiwi", destination, servers, token),
    disconnectKiwi: (): Promise<void> => ipcRenderer.invoke("disconnectKiwi"),
    syncNow: (): Promise<void> => ipcRenderer.invoke("syncNow"),
    /** Restart into the version already downloaded. */
    installUpdate: (): Promise<void> => ipcRenderer.invoke("installUpdate"),
    setAutoSync: (on: boolean): Promise<boolean> => ipcRenderer.invoke("setAutoSync", on),
    openAtLogin: (): Promise<boolean> => ipcRenderer.invoke("openAtLogin"),
    /** Resolves to what the OS now reports, which may differ if it refused. */
    setOpenAtLogin: (on: boolean): Promise<boolean> => ipcRenderer.invoke("setOpenAtLogin", on),
    dismissMessage: (): Promise<void> => ipcRenderer.invoke("dismissMessage"),
    /** Kept entries (by id) as a CSV file the person saves: project, date, hours, description. */
    exportCsv: (ids: string[], name: string): Promise<boolean> => ipcRenderer.invoke("exportCsv", ids, name),
    /** A screenshot, full size, in the system's viewer. */
    openScreenshot: (name: string): Promise<void> => ipcRenderer.invoke("openScreenshot", name),
    showDataFolder: (): Promise<void> => ipcRenderer.invoke("showDataFolder"),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("openExternal", url),
    /** Open a narrative's source by evidence id: its Outlook link, or its document on disk. Resolves to a problem, or null. */
    openSource: (id: string, what?: "link" | "path" | "screenshot"): Promise<string | null> => ipcRenderer.invoke("openSource", id, what),
    /** A source's screenshot as a data URL for the in-app viewer, or null. */
    screenshotData: (id: string): Promise<string | null> => ipcRenderer.invoke("screenshotData", id),
    /** Draft an entry's narrative again with the drafter chosen in Settings. */
    draftNarrative: (id: string): Promise<{ drafter: "rules" | "model"; message: string | null }> => ipcRenderer.invoke("draftNarrative", id),
    /** Pick a .csv or .xlsx export from the firm's time system and match its rows to captured work. */
    importEntries: (): Promise<boolean> => ipcRenderer.invoke("importEntries"),
    importDecision: (id: string, decision: "use" | "keep" | null): Promise<boolean> => ipcRenderer.invoke("importDecision", id, decision),
    clearImport: (): Promise<boolean> => ipcRenderer.invoke("clearImport"),
    /** Make the day's time sheet or invoice PDF in the matter folder and open it. Resolves to a problem, or null. */
    makePdf: (kind: "timesheet" | "invoice", mode: string = "generic", scope?: BillScope): Promise<string | null> => ipcRenderer.invoke("makePdf", kind, mode, scope),
    /** Settings → Billing. */
    setBilling: (input: BillingSetup): Promise<boolean> => ipcRenderer.invoke("setBilling", input),
    chooseBillingFolder: (): Promise<null> => ipcRenderer.invoke("chooseBillingFolder"),
    billingLogo: (): Promise<string | null> => ipcRenderer.invoke("billingLogo"),
    /** The firm's logo from its website; a problem as text, or null. */
    fetchLogo: (site: string): Promise<string | null> => ipcRenderer.invoke("fetchLogo", site),
    chooseLogo: (): Promise<string | null> => ipcRenderer.invoke("chooseLogo"),
    removeLogo: (): Promise<null> => ipcRenderer.invoke("removeLogo"),
    /** The time sheet with the client's rules as Word tracked changes and comments. Resolves to a problem, or null. */
    makeDocx: (mode: string = "generic", scope?: BillScope): Promise<string | null> => ipcRenderer.invoke("makeDocx", mode, scope),
    /** Match the imported rows not linked yet to captured work. */
    linkImport: (): Promise<boolean> => ipcRenderer.invoke("linkImport"),
    /** Match one typed entry (imported or added here) to the captured work it describes. */
    expandTyped: (id: string): Promise<boolean> => ipcRenderer.invoke("expandTyped", id),
    /** Add a simple entry to the day: a short note and its hours, shown as typed until it is expanded. */
    addTyped: (input: { date: string; note: string; hours: string; projectID: string | null }): Promise<boolean> => ipcRenderer.invoke("addTyped", input),
    /** Change a typed entry's note or hours; it is shown as typed again. */
    editTyped: (id: string, change: { description?: string; hours?: string }): Promise<boolean> => ipcRenderer.invoke("editTyped", id, change),
    /** Take a typed entry off the day, undoing what it changed. */
    removeTyped: (id: string): Promise<boolean> => ipcRenderer.invoke("removeTyped", id),
    /** Switch one of the client's billing rules on or off. */
    setClientRule: (bookKey: string, id: string, enabled: boolean): Promise<boolean> => ipcRenderer.invoke("setClientRule", bookKey, id, enabled),
    /** Apply a client's rulebook to the day by its key, or null for generic billing. */
    setBillingClient: (key: string | null): Promise<boolean> => ipcRenderer.invoke("setBillingClient", key),
    /** Rulebooks and rules made in the app: the new rulebook's key, or null when refused. */
    addRulebook: (input: RulebookInput): Promise<string | null> => ipcRenderer.invoke("addRulebook", input),
    updateRulebook: (key: string, input: Partial<RulebookInput>): Promise<boolean> => ipcRenderer.invoke("updateRulebook", key, input),
    removeRulebook: (key: string): Promise<boolean> => ipcRenderer.invoke("removeRulebook", key),
    /** The saved rule's id, or null when refused. */
    saveClientRule: (key: string, input: ClientRuleInput): Promise<string | null> => ipcRenderer.invoke("saveClientRule", key, input),
    removeClientRule: (key: string, id: string): Promise<boolean> => ipcRenderer.invoke("removeClientRule", key, id),
    officeStatus: (): Promise<{ supported: boolean; errors: Record<string, string> }> => ipcRenderer.invoke("officeStatus"),
    /** Whether on-screen text can be read here, and (macOS) whether Accessibility is allowed. */
    screenTextStatus: (): Promise<{ supported: boolean; trusted: boolean; error: string | null }> => ipcRenderer.invoke("screenTextStatus"),
    openAccessibilitySettings: (): Promise<void> => ipcRenderer.invoke("openAccessibilitySettings"),
    /** macOS: System Settings at Privacy & Security → Screen Recording or Accessibility. */
    openPrivacySettings: (pane: "screen" | "accessibility"): Promise<void> => ipcRenderer.invoke("openPrivacySettings", pane),
    /** Quit and reopen: macOS applies a new permission to a fresh process only. */
    relaunch: (): Promise<void> => ipcRenderer.invoke("relaunch"),
};

contextBridge.exposeInMainWorld("lawdie", api);
