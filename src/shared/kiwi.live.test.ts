/**
 * The real sync client against a real Kiwi (or its routes over a stub database).
 *
 * Runs only with TEMPO_KIWI_STUB_URL and TEMPO_KIWI_TOKEN set; Kiwi's
 * `RUN_LIVE_DESKTOP_TIME=1 … desktopTime.live.test.ts` sets them after pairing a device
 * through its own routes, so the wire contract is proven from this side rather than
 * from a transcription of it.
 */

import { describe, expect, it } from "vitest";
import { KiwiClient } from "./kiwi";
import { emptyWorkspace, keepActivity, syncRequest, type Activity } from "./model";

const SERVER = process.env.TEMPO_KIWI_STUB_URL;
const TOKEN = process.env.TEMPO_KIWI_TOKEN;

describe.skipIf(!SERVER || !TOKEN)("Kiwi live", () => {
    it("pairs, pushes two activities, one entry and one deletion, and is refused with a bad token", async () => {
        const client = new KiwiClient(SERVER!, TOKEN!);
        const hello = await client.hello();
        expect(hello.ok).toBe(true);
        expect(hello.device.id).toBeTruthy();

        const w = emptyWorkspace();
        w.projects = [{ id: "p", name: "Whitfield v. Meridian", client: "Whitfield", color: "gold", hourlyRate: 350, archived: false }];
        const word: Activity = { id: "4fd1c8a2-3b7e-4c1d-9a2f-1b3c4d5e6f70", app: "Microsoft Word", ownerID: "com.microsoft.Word", title: "Motion.docx", startedAt: "2026-05-28T20:26:40.000Z", endedAt: "2026-05-28T20:46:40.000Z", endedBy: "switched", disposition: "pending" };
        w.activities = [word, { ...word, id: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a", app: "Preview", ownerID: "com.apple.Preview", title: null, startedAt: "2026-05-28T20:48:20.000Z", endedAt: "2026-05-28T20:53:20.000Z", endedBy: "idle" }];
        keepActivity(w, word.id, { description: "Prepare motion", projectID: "p", billable: true }, Date.now());
        w.sync = { destination: "kiwi", serverURL: client.baseURL, deviceID: hello.device.id, deviceName: hello.device.name, accountEmail: null, autoSync: true, lastSyncedAt: null, lastError: null, deletedEntryIDs: ["aaaaaaaa-0000-4000-8000-000000000001"] };

        const response = await client.sync(syncRequest(w, "checks"));
        expect(response).toMatchObject({ ok: true, activities: 2, entries: 1, deleted: 1 });

        await expect(new KiwiClient(SERVER!, "ldt_" + "x".repeat(43)).hello()).rejects.toMatchObject({ code: "invalid_token" });
    });
});
