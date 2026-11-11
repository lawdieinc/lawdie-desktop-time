import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_DAYS, backupDaily, lockIsStale, removeStaleTemps } from "./workspace";

// The workspace file's safety net (2026-11-11): the lock, backups and leftovers.

describe("the workspace lock", () => {
    const BOOT = 1_780_000_000_000;
    const alive = (pid: number) => pid === 4242;
    it("is held by a live process started since this computer's boot", () => {
        expect(lockIsStale(`4242 ${BOOT}`, BOOT, 1, alive)).toBe(false);
    });
    it("is stale from before a restart, even when its number names a live process now", () => {
        expect(lockIsStale(`4242 ${BOOT - 3_600_000}`, BOOT, 1, alive)).toBe(true);
    });
    it("is stale when its process is gone, is this one, or is unreadable; an old pid-only lock goes by the process", () => {
        expect(lockIsStale(`77 ${BOOT}`, BOOT, 1, alive)).toBe(true);
        expect(lockIsStale(`1 ${BOOT}`, BOOT, 1, alive)).toBe(true);
        expect(lockIsStale("", BOOT, 1, alive)).toBe(true);
        expect(lockIsStale("4242", BOOT, 1, alive)).toBe(false);
        expect(lockIsStale("77", BOOT, 1, alive)).toBe(true);
    });
});

describe("daily backups and leftovers", () => {
    it("copies the workspace once a day and keeps the newest seven", () => {
        const dir = mkdtempSync(join(tmpdir(), "lawdie-backup-"));
        const file = join(dir, "workspace.json");
        writeFileSync(file, "{}");
        for (let d = 1; d <= 9; d++) backupDaily(file, new Date(2026, 10, d, 12));
        backupDaily(file, new Date(2026, 10, 9, 18));
        const kept = readdirSync(join(dir, "backups")).sort();
        expect(kept).toHaveLength(BACKUP_DAYS);
        expect(kept[0]).toBe("workspace-2026-11-03.json");
        expect(kept[kept.length - 1]).toBe("workspace-2026-11-09.json");
    });
    it("never backs up a missing or empty file", () => {
        const dir = mkdtempSync(join(tmpdir(), "lawdie-backup-"));
        backupDaily(join(dir, "workspace.json"));
        writeFileSync(join(dir, "empty.json"), "");
        backupDaily(join(dir, "empty.json"));
        expect(readdirSync(dir)).toEqual(["empty.json"]);
    });
    it("removes a save's leftovers once they are a minute old, and nothing else", () => {
        const dir = mkdtempSync(join(tmpdir(), "lawdie-temp-"));
        for (const n of [".workspace-12-1780000000000.tmp", ".workspace-13-1780000000001.tmp", "workspace.json", "notes.tmp"]) writeFileSync(join(dir, n), "x");
        const old = new Date(Date.now() - 3_600_000);
        for (const n of [".workspace-12-1780000000000.tmp", "notes.tmp"]) utimesSync(join(dir, n), old, old);
        removeStaleTemps(dir);
        expect(readdirSync(dir).sort()).toEqual([".workspace-13-1780000000001.tmp", "notes.tmp", "workspace.json"]);
    });
});
