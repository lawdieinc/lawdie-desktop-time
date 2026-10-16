/* The text the app in front shows, for "Read on-screen text": through the OS
   accessibility system, the channel screen readers use. No screenshots. On macOS a small
   Swift program (native/screen-text, built to resources/bin) asks the Accessibility API,
   which needs the Accessibility permission once; on Windows a PowerShell script asks UI
   Automation for the foreground window, which needs nothing. Both skip password fields,
   menus, toolbars and buttons, prefer the part of a long text that is on screen, and stop
   at a length and time budget. Read once per window title (a new document or page is a
   new title) rather than every sample. Office and browsers never come here (capture.ts);
   cleanScreenText() bounds what is kept. parseScreenText() (src/shared/model.ts) is what
   the tests cover; the readers are exercised by hand against real apps. */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { app } from "electron";
import { SCREEN_TEXT_MAX, parseScreenText } from "@shared/model";

export const READ_TIMEOUT_MS = 5_000;
const BUDGET_MS = 1_500;
/** Characters asked for: more than is kept, so repeats and chrome can be dropped first. */
const ASK_CHARS = SCREEN_TEXT_MAX * 2;
/** How long one read of a window title stands; an empty one is tried again sooner (an Electron app may still be building its tree). */
export const READ_CACHE_MS = 60_000;
const EMPTY_CACHE_MS = 10_000;

type Target = { pid: number; hwnd: number };

function helperPath(): string {
    const base = app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked") : app.getAppPath();
    return join(base, "resources", "bin", "screen-text");
}

function runMac({ pid }: Target): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(helperPath(), [String(Math.trunc(pid)), String(ASK_CHARS), String(BUDGET_MS)], { timeout: READ_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
            // Exit 2 is UNTRUSTED, said on stdout; anything else without output is a failure.
            if (err && !stdout) reject(new Error(err.killed ? `timed out reading pid ${pid}` : `exit ${err.code ?? err.signal} reading pid ${pid}`));
            else resolve(stdout);
        });
    });
}

// UI Automation over the window's control view, breadth first, from the focused element
// (when it is in this window) and then the window; trees (sidebars) skipped. Document and Edit
// controls give their visible text ranges (else the start of the whole text); Text,
// headers and list items give their names. `n is PowerShell's newline.
const winScript = ({ hwnd }: Target) => `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${Math.trunc(hwnd)})
if ($root -eq $null) { exit 0 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$skip = @('MenuBar','Menu','MenuItem','ToolBar','Button','SplitButton','CheckBox','RadioButton','ScrollBar','Image','TitleBar','Thumb','Slider','Spinner','Tree','TreeItem')
$deadline = (Get-Date).AddMilliseconds(${BUDGET_MS})
$out = New-Object System.Collections.Generic.List[string]
$seen = New-Object System.Collections.Generic.HashSet[string]
$total = 0; $visited = 0
$queue = New-Object System.Collections.Generic.Queue[object]
# What has focus first, when it is in this window: the text being worked in says most.
try { $f = [System.Windows.Automation.AutomationElement]::FocusedElement; if ($f -ne $null -and $f.Current.ProcessId -eq $root.Current.ProcessId) { $queue.Enqueue($f) } } catch {}
$queue.Enqueue($root)
while ($queue.Count -gt 0 -and $total -lt ${ASK_CHARS} -and $visited -lt 3000 -and (Get-Date) -lt $deadline) {
  $el = $queue.Dequeue(); $visited++
  try {
    $c = $el.Current
    $type = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
    if ($c.IsPassword -or ($skip -contains $type)) { continue }
    $t = $null; $p = $null
    if ($type -eq 'Document' -or $type -eq 'Edit') {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) {
        $ranges = $p.GetVisibleRanges()
        if ($ranges.Length -gt 0) { $t = ($ranges | ForEach-Object { $_.GetText(${ASK_CHARS}) }) -join "\`n" }
        if (-not $t) { $t = $p.DocumentRange.GetText(${ASK_CHARS}) }
      } elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $t = $p.Current.Value }
    } elseif ('Text','Header','HeaderItem','ListItem','DataItem' -contains $type) { $t = $c.Name }
    if ($t) { $t = $t.Trim(); if ($t -and $seen.Add($t)) { $out.Add($t); $total += $t.Length + 1 } }
    if ($type -ne 'Document') {
      $child = $walker.GetFirstChild($el)
      while ($child -ne $null) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    }
  } catch {}
}
Write-Output ("TEXT=" + ($out -join "\`n"))`;

function runWindows(target: Target): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", winScript(target)], { timeout: READ_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

export class ScreenTextReader {
    private cache = new Map<string, { at: number; text: string | null }>();
    private inflight = new Map<string, Promise<string | null>>();
    /** macOS said this app may not use Accessibility; Settings shows how to allow it. */
    untrusted = false;
    lastError: string | null = null;
    onError: ((message: string) => void) | null = null;

    constructor(private readonly runner: ((t: Target) => Promise<string>) | null = process.platform === "darwin" ? runMac : process.platform === "win32" ? runWindows : null) {}

    get supported(): boolean {
        return this.runner !== null;
    }

    /** The text the window shows, read at most once a minute per window title. */
    async read(ownerID: string, title: string, target: Target, now = Date.now()): Promise<string | null> {
        if (!this.runner) return null;
        const key = `${ownerID}\n${title}`;
        const cached = this.cache.get(key);
        if (cached && now - cached.at < (cached.text ? READ_CACHE_MS : EMPTY_CACHE_MS)) return cached.text;
        const pending = this.inflight.get(key);
        if (pending) return pending;
        const ask = this.runner(target)
            .then((out) => {
                const parsed = parseScreenText(out);
                if (parsed.untrusted && !this.untrusted) this.onError?.("macOS has not granted Accessibility to Lawdie Time Capture; nothing can be read until it is.");
                this.untrusted = parsed.untrusted;
                this.lastError = null;
                return parsed.text;
            })
            .catch((err: Error) => {
                this.lastError = err.message.slice(0, 200);
                this.onError?.(this.lastError);
                return null;
            })
            .then((text) => {
                if (this.cache.size > 300) this.cache.clear();
                this.cache.set(key, { at: now, text });
                this.inflight.delete(key);
                return text;
            });
        this.inflight.set(key, ask);
        return ask;
    }

    reset(): void {
        this.cache.clear();
        this.untrusted = false;
    }
}
