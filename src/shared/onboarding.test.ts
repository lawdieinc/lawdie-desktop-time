import { describe, expect, it } from "vitest";
import { emptyWorkspace, keepStretch, validate, type Workspace } from "./model";
import { inboxOf } from "./matters";
import { TOUR_STEPS, TUTORIAL_MATTER, isTutorialID, needsWelcome, stepAfter, tutorialStretch } from "./onboarding";

const now = Date.UTC(2026, 10, 7, 16, 30);

describe("the welcome", () => {
    it("shows on a workspace nobody has used, and only then", () => {
        expect(needsWelcome(emptyWorkspace())).toBe(true);
        const kept = emptyWorkspace();
        kept.entries.push({ id: "e", description: "x", projectID: null, startedAt: new Date(now - 3_600_000).toISOString(), endedAt: new Date(now).toISOString(), billable: true, hourlyRate: 0, source: "desktop", activityID: null });
        expect(needsWelcome(kept)).toBe(false);
        const captured = emptyWorkspace();
        captured.activities.push({ id: "a", app: "Word", ownerID: "com.microsoft.Word", title: null, startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now).toISOString(), endedBy: "switched", disposition: "pending" });
        expect(needsWelcome(captured)).toBe(false);
        const connected = emptyWorkspace();
        connected.sync = { targets: [{ product: "kiwi", serverURL: "https://lawdie.co/kiwi-api", deviceID: "d", deviceName: "Mac", accountEmail: null, lastSyncedAt: null, lastError: null, deletedEntryIDs: [] }], autoSync: true };
        expect(needsWelcome(connected)).toBe(false);
        const demo = emptyWorkspace();
        demo.demo = { seed: "s", epoch: 1, stage: "day", day: "2026-10-22" };
        expect(needsWelcome(demo)).toBe(false);
    });

    it("is remembered as a preference the file validates", () => {
        const w = emptyWorkspace();
        w.preferences.onboardedAt = new Date(now).toISOString();
        expect(needsWelcome(w)).toBe(false);
        expect(() => validate(w)).not.toThrow();
        (w.preferences as { onboardedAt?: unknown }).onboardedAt = "yesterday";
        expect(() => validate(w)).toThrow(/invalid data/);
    });
});

describe("the tutorial", () => {
    it("has unique steps, each on a screen the window has, and the Keep steps wait on the sheet", () => {
        expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
        for (const s of TOUR_STEPS) {
            expect(["today", "activity", "matters", "settings"]).toContain(s.route);
            expect(s.title.length).toBeGreaterThan(0);
            expect(s.body.length).toBeGreaterThan(40);
        }
        const open = TOUR_STEPS.findIndex((s) => s.advanceOn === "keep-open");
        expect(TOUR_STEPS[open + 1].advanceOn).toBe("keep-closed");
        expect(stepAfter(TOUR_STEPS, open, "keep-open")).toBe(open + 1);
        expect(stepAfter(TOUR_STEPS, open, "keep-closed")).toBeNull();
        expect(stepAfter(TOUR_STEPS, open + 1, "keep-closed")).toBe(open + 2);
        expect(stepAfter(TOUR_STEPS, 0, "keep-open")).toBeNull();
        expect(stepAfter(TOUR_STEPS, TOUR_STEPS.length - 1, "keep-closed")).toBeNull();
    });

    it("has a sample stretch that reads as real work: two sittings on one document, idle flagged, on a matter", () => {
        const { stretch, sittings } = tutorialStretch(now);
        expect(sittings).toHaveLength(2);
        expect(stretch.activityIDs).toEqual(sittings.map((a) => a.id));
        expect(sittings.every((a) => isTutorialID(a.id))).toBe(true);
        expect(stretch.seconds).toBe((25 + 18) * 60);
        expect(stretch.sittings).toBe(2);
        expect(Date.parse(stretch.endedAt)).toBeLessThan(now);
        expect(sittings[1].idle).toHaveLength(1);
        expect(sittings.every((a) => a.matter === TUTORIAL_MATTER)).toBe(true);
        // The inbox groups it the way it groups a real matter's day: one row.
        const { groups, stretches } = inboxOf(sittings);
        expect(groups).toHaveLength(1);
        expect(groups[0].matter).toBe(TUTORIAL_MATTER);
        expect(groups[0].seconds).toBe(stretch.seconds);
        expect(stretches).toHaveLength(0);
    });

    it("never enters a workspace: keeping the sample's ids is refused, and nothing changes", () => {
        const w: Workspace = emptyWorkspace();
        const before = JSON.stringify(w);
        const { stretch } = tutorialStretch(now);
        expect(() => keepStretch(w, stretch.activityIDs, { description: "Sample", projectID: null, billable: true, matter: TUTORIAL_MATTER }, now)).toThrow(/already been reviewed/);
        expect(JSON.stringify(w)).toBe(before);
        expect(w.projects).toHaveLength(0);
    });
});
