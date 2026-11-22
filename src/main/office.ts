/* What Word, Excel, PowerPoint and Outlook have open, asked through the OS's own
   automation: Apple Events (osascript) on macOS, COM through PowerShell on Windows. No
   add-in to install, nothing inside the documents changes. macOS asks the person once per
   app whether Lawdie Time Capture may control it; Windows asks nothing.

   What is read is what the person is looking at (2026-11-22, "wants to see like the content of the excel sheet"):
   Excel's visible cells, the Word text around the cursor, the PowerPoint slide on screen, the Outlook item open.
   The scripts print it raw; officeExcerpt() makes it one line ("Sheet “Damages” · A1 Claimant · B2 42,000 …",
   "Slide 2 of 12 · Damages summary · …") and cleanDocument() bounds it to EXCERPT_MAX.

   Opt-in ("Read Office document details"), and only for the app in front. The probe is
   throttled per app and never blocks a sample for more than a few seconds. Its output
   is a small text protocol parsed by parseProbeOutput(), which is what the tests cover;
   the scripts themselves are exercised by hand against real Office. In AppleScript, `lines`, `cells`, `text` and the
   like are the app's or the language's own words: a variable named so fails, so the scripts avoid them. */

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
//
// Two AppleScript traps shaped these. Inside a `tell application` block, `text 1 thru
// N of …` is the app's own `text` element, so "set theText to text 1 thru 600 of …" is
// dispatched to Word and the local variable is never assigned — silently. So the scripts
// only read whole values inside the tell and do the truncation outside it. And Word
// reports `full name` as an HFS path ("Macintosh HD:Users:…") where Excel reports POSIX;
// the tail converts through an alias when the file exists and keeps the raw string
// otherwise (an unsaved document's "full name" is just its name).
// ---------------------------------------------------------------------------

/** The raw text a script may print before officeExcerpt() shapes it (an Excel sheet's empty cells are tabs). */
export const RAW_MAX = 8_000;
/** How much of a sheet is read: what fits on a screen, and no more. */
export const SHEET_ROWS = 60;
export const SHEET_COLUMNS = 26;

const MAC_FINISH = `
try
  set thePath to POSIX path of (thePath as alias)
end try
if (length of theContent) > ${RAW_MAX} then set theContent to text 1 thru ${RAW_MAX} of theContent
return "NAME=" & theName & linefeed & "PATH=" & thePath & linefeed & "TEXT=" & theContent`;


const MAC_SCRIPTS: Record<OfficeApp, string> = {
    word: `
set theName to ""
set thePath to ""
set theContent to ""
tell application "Microsoft Word"
  if not (exists active document) then return ""
  set theDoc to active document
  set theName to name of theDoc
  set thePath to full name of theDoc
  -- The text around the cursor: what is being worked on, not the document's first lines.
  try
    set docEnd to end of content of text object of theDoc
    set here to selection start of selection
    set fromAt to here - 200
    if fromAt < 0 then set fromAt to 0
    set toAt to here + 800
    if toAt > docEnd then set toAt to docEnd
    set theContent to content of (create range theDoc start fromAt end toAt)
  on error
    try
      set theContent to content of text object of theDoc
    end try
  end try
end tell
${MAC_FINISH}`,
    excel: `
set theName to ""
set thePath to ""
set theContent to ""
tell application "Microsoft Excel"
  if not (exists active workbook) then return ""
  set theBook to active workbook
  set theName to name of theBook
  set thePath to full name of theBook
  set theSheet to ""
  set theAddress to ""
  set theRows to {}
  try
    set theSheet to name of active sheet
  end try
  -- The cells on screen, as the sheet shows them (formatted), row by row.
  try
    set theRange to visible range of active window
    set theAddress to get address theRange
    set theRows to string value of theRange
  end try
end tell
set rowTexts to {}
set AppleScript's text item delimiters to tab
set rowCount to 0
repeat with theRow in theRows
  set rowCount to rowCount + 1
  if rowCount > ${SHEET_ROWS} then exit repeat
  set rowCells to contents of theRow
  if class of rowCells is not list then set rowCells to {rowCells}
  if (count of rowCells) > ${SHEET_COLUMNS} then set rowCells to items 1 thru ${SHEET_COLUMNS} of rowCells
  set end of rowTexts to (rowCells as text)
end repeat
set AppleScript's text item delimiters to linefeed
set theContent to theSheet & linefeed & theAddress & linefeed & (rowTexts as text)
set AppleScript's text item delimiters to ""
${MAC_FINISH}`,
    powerpoint: `
set theName to ""
set thePath to ""
set theContent to ""
tell application "Microsoft PowerPoint"
  if not (exists active presentation) then return ""
  set theDeck to active presentation
  set theName to name of theDeck
  set thePath to full name of theDeck
  -- The slide on screen: its number, then the text of each shape on it.
  set parts to {}
  try
    set slideAt to slide index of slide range of selection of active window
    set theSlide to slide slideAt of theDeck
    set end of parts to (slideAt as text) & "/" & ((count of slides of theDeck) as text)
    repeat with i from 1 to (count of shapes of theSlide)
      try
        set end of parts to (content of text range of text frame of shape i of theSlide)
      end try
    end repeat
  end try
end tell
set AppleScript's text item delimiters to linefeed
set theContent to parts as text
set AppleScript's text item delimiters to ""
${MAC_FINISH}`,
    outlook: `
set theName to ""
set thePath to ""
set theContent to ""
set theSender to ""
tell application "Microsoft Outlook"
  set theItem to missing value
  -- An item open in its own window first (legacy Outlook exposes it as the window's
  -- object), else whatever is selected in the list.
  try
    set theItem to object of window 1
  end try
  if theItem is missing value then
    set theItems to selected objects
    if (count of theItems) is 0 then return ""
    set theItem to item 1 of theItems
  end if
  try
    set theName to subject of theItem
  end try
  try
    set theSender to name of sender of theItem
  end try
  try
    set theContent to plain text content of theItem
  end try
end tell
set theContent to theSender & " · " & theName & " · " & theContent
${MAC_FINISH}`,
};

const WIN_SCRIPTS: Record<OfficeApp, string> = {
    word: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
$d = $a.ActiveDocument
if ($d -eq $null) { exit 0 }
$t = ''
try { $here = $a.Selection.Start; $t = $d.Range([Math]::Max(0, $here - 200), [Math]::Min($d.Content.End, $here + 800)).Text } catch { try { $t = $d.Content.Text.Substring(0, [Math]::Min(${EXCERPT_MAX}, $d.Content.Text.Length)) } catch {} }
Write-Output ("NAME=" + $d.Name); Write-Output ("PATH=" + $d.FullName); Write-Output ("TEXT=" + $t)`,
    excel: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
$w = $a.ActiveWorkbook
if ($w -eq $null) { exit 0 }
$t = $a.ActiveSheet.Name
try {
  $r = $a.ActiveWindow.VisibleRange
  $rows = [Math]::Min($r.Rows.Count, ${SHEET_ROWS}); $cols = [Math]::Min($r.Columns.Count, ${SHEET_COLUMNS})
  $v = $r.Value2
  $lines = @()
  for ($i = 1; $i -le $rows; $i++) { $cells = @(); for ($j = 1; $j -le $cols; $j++) { if ($v -is [array]) { $cells += [string]$v[$i, $j] } else { $cells += [string]$v } }; $lines += ($cells -join "\`t") }
  $t = $t + "\`n" + $r.Address($false, $false) + "\`n" + ($lines -join "\`n")
} catch {}
Write-Output ("NAME=" + $w.Name); Write-Output ("PATH=" + $w.FullName); Write-Output ("TEXT=" + $t)`,
    powerpoint: `
$a = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
$p = $a.ActivePresentation
if ($p -eq $null) { exit 0 }
$t = ''
try {
  $sl = $a.ActiveWindow.View.Slide
  $parts = @("$($sl.SlideIndex)/$($p.Slides.Count)")
  foreach ($sh in $sl.Shapes) { try { if ($sh.HasTextFrame -and $sh.TextFrame.HasText) { $parts += $sh.TextFrame.TextRange.Text } } catch {} }
  $t = $parts -join "\`n"
} catch {}
Write-Output ("NAME=" + $p.Name); Write-Output ("PATH=" + $p.FullName); Write-Output ("TEXT=" + $t)`,
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
Write-Output ("NAME=" + $i.Subject); Write-Output ("PATH="); Write-Output ("TEXT=" + $f + " · " + $i.Subject + " · " + $b)`,
};

const columnName = (n: number): string => { let s = ""; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
const columnNumber = (letters: string): number => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

/**
 * What a script printed as TEXT, as one line to read. Excel: the sheet's name, then each filled cell on screen with its
 * address. PowerPoint: "Slide 2 of 12", then each shape's text. Word and Outlook: the text as it is. Lines and runs
 * of space are collapsed by cleanDocument().
 */
export function officeExcerpt(app: OfficeApp | null, raw: string): string {
    const text = raw.replace(/\r\n?/g, "\n");
    if (app === "excel") {
        const [sheet = "", address = "", ...rows] = text.split("\n");
        if (!address.trim()) return sheet.trim() ? `Sheet “${sheet.trim()}”` : "";
        const start = /^\$?([A-Za-z]+)\$?(\d+)/.exec(address.trim());
        const col0 = start ? columnNumber(start[1]) : 1, row0 = start ? Number(start[2]) : 1;
        const cells: string[] = [];
        rows.forEach((line, r) => line.split("\t").forEach((value, c) => { const v = value.replace(/\s+/g, " ").trim(); if (v) cells.push(`${columnName(col0 + c)}${row0 + r} ${v}`); }));
        return [sheet.trim() ? `Sheet “${sheet.trim()}”` : "", ...cells].filter(Boolean).join(" · ");
    }
    if (app === "powerpoint") {
        const [where = "", ...shapes] = text.split("\n");
        const at = /^(\d+)\/(\d+)$/.exec(where.trim());
        const lines = (at ? shapes : [where, ...shapes]).map((x) => x.trim()).filter(Boolean);
        return [at ? `Slide ${at[1]} of ${at[2]}` : "", ...lines].filter(Boolean).join(" · ");
    }
    return text;
}

/** The NAME/PATH/TEXT protocol the scripts print, as a DocumentInfo (or null for nothing open). */
export function parseProbeOutput(output: string, app: OfficeApp | null = null): DocumentInfo | null {
    const text = output.replace(/\r\n?/g, "\n");
    const nameAt = text.indexOf("NAME=");
    const pathAt = text.indexOf("\nPATH=");
    const textAt = text.indexOf("\nTEXT=");
    if (nameAt < 0 || pathAt < 0 || textAt < 0 || pathAt < nameAt || textAt < pathAt) return null;
    const name = text.slice(nameAt + 5, pathAt);
    const path = text.slice(pathAt + 6, textAt);
    const excerpt = officeExcerpt(app, text.slice(textAt + 6));
    // An unsaved document's "full name" is just its name ("Presentation1"): not a path.
    const saved = /[\/\\]/.test(path);
    return cleanDocument({ name, path: saved ? path : null, excerpt: excerpt || null });
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
                return parseProbeOutput(out, app);
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
