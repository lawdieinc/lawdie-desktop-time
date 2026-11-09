import { describe, expect, it } from "vitest";
import { emptyWorkspace, validate } from "./model";
import { LATEST_RELEASE, RELEASES, RELEASE_ICONS, compareVersions, needsWhatsNew, releaseDateLabel } from "./releases";

const used = (): ReturnType<typeof emptyWorkspace> => {
    const w = emptyWorkspace();
    w.preferences.onboardedAt = "2026-11-07T10:00:00.000Z";
    return w;
};

describe("the release notes", () => {
    it("are unique versions, newest first, each with two to five items (one for a small release) a screen can open", () => {
        expect(new Set(RELEASES.map((r) => r.id)).size).toBe(RELEASES.length);
        for (let i = 1; i < RELEASES.length; i++) {
            expect(compareVersions(RELEASES[i - 1].id, RELEASES[i].id)).toBeGreaterThan(0);
            expect(RELEASES[i - 1].date >= RELEASES[i].date).toBe(true);
        }
        for (const r of RELEASES) {
            expect(r.id).toMatch(/^\d+\.\d+\.\d+$/);
            expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(r.items.length).toBeGreaterThanOrEqual(1);
            expect(r.items.length).toBeLessThanOrEqual(5);
            for (const item of r.items) {
                expect(RELEASE_ICONS).toContain(item.icon);
                expect(item.description.length).toBeLessThanOrEqual(100);
            }
        }
        expect(LATEST_RELEASE).toBe(RELEASES[0]);
    });

    it("compare versions part by part and print the day", () => {
        expect(compareVersions("0.16.0", "0.15.1")).toBeGreaterThan(0);
        expect(compareVersions("0.9.1", "0.10.0")).toBeLessThan(0);
        expect(compareVersions("1.0", "1.0.0")).toBe(0);
        expect(releaseDateLabel("2026-11-09")).toBe("9 November 2026");
    });
});

describe("the card", () => {
    it("opens once for someone who used the app, and not again once seen", () => {
        const w = used();
        expect(needsWhatsNew(w)).toBe(true);
        w.preferences.seenRelease = RELEASES[1]?.id ?? "0.0.0";
        expect(needsWhatsNew(w)).toBe(true);
        w.preferences.seenRelease = LATEST_RELEASE.id;
        expect(needsWhatsNew(w)).toBe(false);
        expect(() => validate(w)).not.toThrow();
    });

    it("gives way to the welcome on a new workspace, and never shows on a demo", () => {
        expect(needsWhatsNew(emptyWorkspace())).toBe(false);
        const demo = used();
        demo.demo = { seed: "s", epoch: 1, stage: "day", day: "2026-10-22" };
        expect(needsWhatsNew(demo)).toBe(false);
    });

    it("is remembered as a preference the file validates", () => {
        const w = used();
        (w.preferences as { seenRelease?: unknown }).seenRelease = 16;
        expect(() => validate(w)).toThrow(/invalid data/);
    });
});
