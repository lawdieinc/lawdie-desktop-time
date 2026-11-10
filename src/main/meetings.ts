import { KiwiClient } from "@shared/kiwi";
import { applyMeetings, applyTranscript, meetingsWindow, parseMeetings, transcriptsDue } from "@shared/meetings";
import type { Store } from "./store";
import type { TokenFile } from "./sync";

/** Transcripts asked for per pass at most; the rest wait for the next. */
const TRANSCRIPTS_PER_PASS = 5;

/**
 * Calendar meetings through Kiwi (src/shared/meetings.ts holds the rules): every 15 minutes
 * while "Calendar meetings" is on and Kiwi is connected, the last two days' meetings, then
 * the Teams transcripts that are due when "Teams transcripts" is on too. Kiwi reads the
 * calendars with the person's own Google and Microsoft grants; this computer never holds them.
 */
export class Meetings {
    private timer: NodeJS.Timeout | null = null;
    private initial: NodeJS.Timeout | null = null;
    private running = false;
    private generation = 0;
    constructor(private readonly store: Store, private readonly tokens: TokenFile) {}
    start(): void {
        this.timer = setInterval(() => void this.pull(), 15 * 60_000);
        this.initial = setTimeout(() => void this.pull(), 20_000);
    }
    stop(): void { this.generation++; if (this.timer) clearInterval(this.timer); if (this.initial) clearTimeout(this.initial); }
    cancel(): void { this.generation++; }
    async pull(): Promise<void> {
        const prefs = () => this.store.workspace.preferences;
        if (this.running || this.store.loadFailed || this.store.workspace.demo || !prefs().importMeetings) return;
        const target = this.store.workspace.sync?.targets.find((t) => t.product === "kiwi");
        const token = this.tokens.load();
        if (!target || !token) return;
        const generation = this.generation;
        const active = () => generation === this.generation && !!prefs().importMeetings && !!this.store.workspace.sync?.targets.some((t) => t.product === "kiwi" && t.serverURL === target.serverURL);
        this.running = true;
        this.store.setMeetingsStatus(true, null);
        let error: string | null = null;
        try {
            const client = new KiwiClient(target.serverURL, token);
            const now = Date.now();
            const window = meetingsWindow(this.store.workspace, now);
            const answer = parseMeetings(await client.meetings(window.from, window.to));
            if (!active()) return;
            this.store.change((w) => { applyMeetings(w, answer, window, Date.now()); });
            if (!prefs().meetingTranscripts) return;
            for (const m of transcriptsDue(this.store.workspace, Date.now()).slice(0, TRANSCRIPTS_PER_PASS)) {
                if (!active() || !m.join_url) break;
                // A failed ask is asked again next pass; like sync, a network failure is not reported.
                const raw = await client.meetingTranscript(m.join_url, m.start, m.end).catch(() => null);
                if (raw && active()) this.store.change((w) => { applyTranscript(w, m.id, raw, Date.now()); });
            }
        } catch (err) {
            // Offline or Kiwi without the route yet: said in Settings, not reported (a laptop offline is not a bug).
            error = err instanceof Error ? err.message : "Could not bring in calendar meetings.";
        } finally {
            this.running = false;
            this.store.setMeetingsStatus(false, generation === this.generation ? error : null);
        }
    }
}
