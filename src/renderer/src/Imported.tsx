import { useState, type ReactNode } from "react";
import type { ImportedRow, Workspace } from "@shared/model";
import { recordedHours } from "@shared/importMatch";
import { NarrativeEntry, whereTime } from "./Narrative";

/* Entries the attorney typed into iTimeKeep, imported and matched back to the work Time
   Capture saw: what was typed, the hours entered against the hours recorded, Lawdie's
   narrative for the same work with its Why dropdown, and the choice between the two. */

export function ImportedPanel({ w }: { w: Workspace }): ReactNode {
    const rows = w.imported ?? [];
    const matched = rows.filter((r) => r.entryID && w.entries.some((e) => e.id === r.entryID)).length;
    return (
        <section className="panel">
            <div className="row between">
                <span className="row gap"><strong>Entered in iTimeKeep</strong><span className="muted small">{rows.length} {rows.length === 1 ? "entry" : "entries"} · {matched} matched to captured work</span></span>
                <button type="button" className="quiet slim" title="Remove the imported entries from this list. Time Capture's own entries stay." onClick={() => void window.lawdie.clearImport()}>Clear import</button>
            </div>
            {rows.map((r) => <ImportRow key={r.id} row={r} w={w} />)}
        </section>
    );
}

function ImportRow({ row, w }: { row: ImportedRow; w: Workspace }): ReactNode {
    const entry = row.entryID ? w.entries.find((e) => e.id === row.entryID) : undefined;
    const [draft, setDraft] = useState<string | null>(null);
    const recorded = entry ? recordedHours(entry) : 0;
    const over = !!entry && row.hours - recorded > 0.049;
    const under = !!entry && recorded - row.hours > 0.049;
    const decide = (d: "use" | "keep" | null): void => void window.lawdie.importDecision(row.id, d);
    return (
        <div className={"import-row" + (row.decision ? ` decided ${row.decision}` : "")}>
            <div className="import-typed">
                <span className="import-label">Entered in iTimeKeep</span>
                <span className="import-text">“{row.description}”</span>
                <span className="import-meta">{row.date} · {row.matter || "no matter"} · <span className="mono">{row.hours.toFixed(1)} h</span></span>
            </div>
            {entry ? (
                <>
                    <div className={"import-hours" + (over ? " over" : "")} title="Hours typed into iTimeKeep against the time Time Capture recorded for the same work.">
                        Entered {row.hours.toFixed(1)}, recorded {recorded.toFixed(1)} ({whereTime(entry)}){over ? ". More time was entered than was recorded." : under ? ". Less time was entered than was recorded." : ""}
                    </div>
                    <div className="import-lawdie">
                        <span className="import-label">Lawdie drafted</span>
                        <div className="import-narr"><NarrativeEntry entry={entry} w={w} draft={draft} setDraft={setDraft} readOnly /></div>
                    </div>
                    <div className="row gap import-actions">
                        {row.decision ? (
                            <>
                                <span className="small strong">{row.decision === "use" ? "Using Lawdie's narrative for this entry." : "Keeping what you typed."}</span>
                                <button type="button" className="link-btn" title="Choose again." onClick={() => decide(null)}>Undo</button>
                            </>
                        ) : (
                            <>
                                <button type="button" className="primary slim" title="Replace what was typed in iTimeKeep with Lawdie's narrative for the same work." onClick={() => decide("use")}>Use this narrative</button>
                                <button type="button" className="quiet slim" title="Keep the description as typed in iTimeKeep." onClick={() => decide("keep")}>Keep mine</button>
                            </>
                        )}
                    </div>
                </>
            ) : <p className="muted small import-none">No captured work matches this entry.</p>}
        </div>
    );
}
