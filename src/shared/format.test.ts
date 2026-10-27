import { describe, expect, it } from "vitest";
import { timeBlock } from "./format";

/** An ISO time for a local clock time on the demo day, so the test reads the same in any time zone. */
const at = (h: number, m: number): string => new Date(2026, 9, 26, h, m).toISOString();

describe("the time block on an entry's minutes", () => {
    it("says one stretch once, with AM or PM at the end", () => {
        expect(timeBlock({ startedAt: at(9, 15), endedAt: at(9, 51) })).toBe("9:15 to 9:51 AM");
    });

    it("says AM and PM on both ends when the stretch crosses noon", () => {
        expect(timeBlock({ startedAt: at(11, 40), endedAt: at(12, 20) })).toBe("11:40 AM to 12:20 PM");
    });

    it("lists each sitting and counts them", () => {
        const e = { startedAt: at(9, 58), endedAt: at(11, 43), sittings: [{ startedAt: at(9, 58), endedAt: at(10, 50) }, { startedAt: at(10, 55), endedAt: at(11, 43) }] };
        expect(timeBlock(e)).toBe("9:58 to 10:50 AM and 10:55 to 11:43 AM (2 sittings)");
    });

    it("joins three sittings with commas and a last and", () => {
        const e = { startedAt: at(13, 0), endedAt: at(15, 0), sittings: [{ startedAt: at(13, 0), endedAt: at(13, 30) }, { startedAt: at(14, 0), endedAt: at(14, 10) }, { startedAt: at(14, 40), endedAt: at(15, 0) }] };
        expect(timeBlock(e)).toBe("1:00 to 1:30 PM, 2:00 to 2:10 PM and 2:40 to 3:00 PM (3 sittings)");
    });
});
