/* What Word, Excel, PowerPoint and Outlook have open, asked through the OS's own
   automation: Apple Events (osascript) on macOS, COM through PowerShell on Windows. No
   add-in to install, nothing inside the documents changes. macOS asks the person once per
   app whether Lawdie Time Capture may control it; Windows asks nothing.

   Opt-in ("Read Office document details"), and only for the app in front. The probe is
   throttled per app and never blocks a sample for more than a few seconds. Its output
   is a small text protocol parsed by parseProbeOutput(), which is what the tests cover;
   the scripts themselves are exercised by hand against real Office. */

import { execFile } from "node:child_process";
import type { DocumentInfo } from "@shared/model";
import { EXCERPT_MAX, cleanDocument } from "@shared/model";

export type OfficeApp = "word" | "excel" | "powerpoint" | "outlook";

const MAC_BUNDLES: Record<string, OfficeApp> = {
    "com.microsoft.word": "word",
    "com.microsoft.excel": "excel",
    "com.microsoft.powerpoint": "powerpoint",
    "com.microsoft.outlook": "outlook",
};
const WIN_EXES: Record<string, OfficeApp> = {
    "winword.exe": "word",
    "excel.exe": "excel",
    "powerpnt.exe": "powerpoint",
    "outlook.exe": "outlook",
    "olk.exe": "outlook",
};

/** Which Office app an owner id names, if any (bundle id on macOS, exe path elsewhere). */
export function officeApp(ownerID: string): OfficeApp | null {
    const lower = ownerID.toLowerCase();
    if (MAC_BUNDLES[lower]) return MAC_BUNDLES[lower];
    const base = lower.split(/[\\/]/).pop() ?? lower;
    return WIN_EXES[base] ?? null;
}

// ---------------------------------------------------------------------------
// The scripts. Each prints NAME=…, PATH=…, TEXT=… lines (TEXT last, may span lines).
// ---------------------------------------------------------------------------

const MAC_SCRIPTS: Record<OfficeApp, string> = {
    word: `
tell application "Microsoft Word"
  if not (exists active document) then return ""
  set d to active document
  set t to ""
  try
    set t to text 1 thru ${EXCERPT_MAX} of (content of text object of d)
  on error
    try
      set t to content of text object of d
    end try
  end try
  return "NAME=" & (name of d) & linefeed & "PATH=" & (full name of d) & linefeed & "TEXT=" & t
end tell`,
    excel: `
tell application "Microsoft Excel"
  if not (exists active workbook) then return ""
  set wb to active workbook
  return "NAME=" & (name of wb) & linefeed & "PATH=" & (full name of wb) & linefeed & "TEXT=" & (name of active sheet)
end tell`,
    powerpoint: `
tell application "Microsoft PowerPoint"
  if not (exists active presentation) then return ""
  set p to active presentation
  return "NAME=" & (name of p) & linefeed & "PATH=" & (full name of p) & linefeed & "TEXT="
end tell`,
    outlook: `
tell application "Microsoft Outlook"
  set items to selected objects
  if (count of items) is 0 then return ""
  set m to item 1 of items
  set s to ""
  set f to ""
  set b to ""
  try
    set s to subject of m
  end try
  try
    set f to name of sender of m
  end try
  try
    set b to text 1 thru ${EXCERPT_MAX} of (plain text content of m)
  on error
    try
      set b to plain text content of m
    end try
  end try
  return "NAME=" & s & linefeed & "PATH=" & linefeed & "TEXT=" & f & " — " & s & " — " & b
end tell`,
};

const WIN_SCRIPTS: Record<OfficeApp, string> = {
    word: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
$d = $a.ActiveDocument
if ($d -eq $null) { exit 0 }
$t = ''
try { $t = $d.Content.Text.Substring(0, [Math]::Min(${EXCERPT_MAX}, $d.Content.Text.Length)) } catch {}
Write-Output ("NAME=" + $d.Name); Write-Output ("PATH=" + $d.FullName); Write-Output ("TEXT=" + $t)`,
    excel: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$w = $a.ActiveWorkbook
if ($w -eq $null) { exit 0 }
Write-Output ("NAME=" + $w.Name); Write-Output ("PATH=" + $w.FullName); Write-Output ("TEXT=" + $a.ActiveSheet.Name)`,
    powerpoint: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
$p = $a.ActivePresentation
if ($p -eq $null) { exit 0 }
Write-Output ("NAME=" + $p.Name); Write-Output ("PATH=" + $p.FullName); Write-Output ("TEXT=")`,
    outlook: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
$i = $null
$insp = $a.ActiveInspector()
if ($insp -ne $null) { $i = $insp.CurrentItem } else { $sel = $a.ActiveExplorer().Selection; if ($sel.Count -gt 0) { $i = $sel.Item(1) } }
if ($i -eq $null) { exit 0 }
$b = ''
try { $b = $i.Body.Substring(0, [Math]::Min(${EXCERPT_MAX}, $i.Body.Length)) } catch {}
$f = ''
try { $f = $i.SenderName } catch {}
Write-Output ("NAME=" + $i.Subject); Write-Output ("PATH="); Write-Output ("TEXT=" + $f + " — " + $i.Subject + " — " + $b)`,
};

/** The NAME/PATH/TEXT protocol the scripts print, as a DocumentInfo (or null for nothing open). */
export function parseProbeOutput(output: string): DocumentInfo | null {
    const text = output.replace(/\r\n?/g, "\n");
    const nameAt = text.indexOf("NAME=");
    const pathAt = text.indexOf("\nPATH=");
    const textAt = text.indexOf("\nTEXT=");
    if (nameAt < 0 || pathAt < 0 || textAt < 0 || pathAt < nameAt || textAt < pathAt) return null;
    const name = text.slice(nameAt + 5, pathAt);
    const path = text.slice(pathAt + 6, textAt);
    const excerpt = text.slice(textAt + 6);
    return cleanDocument({ name, path: path || null, excerpt: excerpt || null });
}

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

export const PROBE_TIMEOUT_MS = 4_000;
/** How long one answer stands in for a running app before it is asked again. */
export const PROBE_CACHE_MS = 15_000;

type Runner = (app: OfficeApp) => Promise<string>;

function runMac(app: OfficeApp): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("osascript", ["-e", `with timeout of 3 seconds\n${MAC_SCRIPTS[app]}\nend timeout`], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim()));
            else resolve(stdout);
        });
    });
}

function runWindows(app: OfficeApp): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_SCRIPTS[app]], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim()));
            else resolve(stdout);
        });
    });
}

export class OfficeProbe {
    private cache = new Map<OfficeApp, { at: number; document: DocumentInfo | null }>();
    private inflight = new Map<OfficeApp, Promise<DocumentInfo | null>>();
    /** The last failure per app, for the Settings screen ("Word did not answer: …"). */
    readonly lastError = new Map<OfficeApp, string>();

    /** Called with each failure as it happens, for a log file; the message is already bounded. */
    onError: ((app: OfficeApp, message: string) => void) | null = null;

    constructor(private readonly runner: Runner | null = process.platform === "darwin" ? runMac : process.platform === "win32" ? runWindows : null) {}

    get supported(): boolean {
        return this.runner !== null;
    }

    /** What the Office app behind `ownerID` has open, or null: not Office, nothing open, refused, or timed out. */
    async probe(ownerID: string, now = Date.now()): Promise<DocumentInfo | null> {
        const app = officeApp(ownerID);
        if (!app || !this.runner) return null;
        const cached = this.cache.get(app);
        if (cached && now - cached.at < PROBE_CACHE_MS) return cached.document;
        const pending = this.inflight.get(app);
        if (pending) return pending;
        const run = this.runner(app)
            .then((out) => {
                this.lastError.delete(app);
                return parseProbeOutput(out);
            })
            .catch((err: Error) => {
                const message = err.message.slice(0, 200);
                this.lastError.set(app, message);
                this.onError?.(app, message);
                return null;
            })
            .then((document) => {
                this.cache.set(app, { at: now, document });
                this.inflight.delete(app);
                return document;
            });
        this.inflight.set(app, run);
        return run;
    }

    /** Forget cached answers, e.g. when the preference is switched on. */
    reset(): void {
        this.cache.clear();
    }
}
