/* Test fixture: the seeded Manatt demo day as the app reads it (manatt-day.json, a copy of the demo seed with home
   paths written as ~): Rosa Delacroix's five entries and a suggested call, their evidence, and the Northlake and Kestrel
   Valley rulebooks. Not part of the app. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkspace, type TimeEntry, type Workspace } from "../model";

export const manattDay = (): Workspace => parseWorkspace(readFileSync(join(__dirname, "manatt-day.json"), "utf8"));

/** The entry whose narrative starts with these words. */
export const entryStarting = (w: Workspace, words: string): TimeEntry => {
    const e = w.entries.find((x) => x.description.startsWith(words));
    if (!e) throw new Error(`No entry starts with "${words}"`);
    return e;
};
