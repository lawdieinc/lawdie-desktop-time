/* Who writes an entry's narrative from its evidence. Pure: the main process hands in the
   call to Kiwi, so this runs under vitest unchanged.

   Rules (the demo): the parts stored with the entry, as drafted ahead of time. Model: a
   prompt built from the evidence, sent through Kiwi's drafts route (the one the inbox
   uses, src/shared/kiwi.ts), and an answer that must cite evidence ids in square brackets.
   A part that cites an id the entry does not have is dropped; nothing is invented. */

import type { DraftsBody } from "./matters";
import type { DrafterKind, Evidence, NarrativePart, TimeEntry } from "./model";

export type Drafted = { parts: NarrativePart[]; narrative: string; drafter: DrafterKind };

export interface Drafter {
    kind: DrafterKind;
    draft(entry: TimeEntry, evidence: readonly Evidence[]): Promise<Drafted>;
}

export const narrativeOf = (parts: readonly NarrativePart[]): string => parts.map((p) => p.text).join("");

/** The stored parts, unchanged. */
export const rulesDrafter: Drafter = {
    kind: "rules",
    draft: async (entry) => {
        const parts = entry.parts ?? [];
        return { parts, narrative: narrativeOf(parts) || entry.description, drafter: "rules" };
    },
};

/** The client's narrative rules, as the model is told them. */
export const CLIENT_RULES = [
    "Write in the past tense.",
    "Describe one task.",
    "Name the participants (initial and surname, with role for client people).",
    "Name the document worked on.",
    "Say what the work was for.",
    "Do not use vague words: no 'attention to', 'work on', 'various', 'review file', 'follow up'.",
];

/** One line of evidence for the prompt: its id, then what it says. */
export function evidenceLine(e: Evidence): string {
    const cut = (t: string | undefined, n: number) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    if (e.kind === "email") return `[${e.id}] email "${e.subject ?? ""}" from ${e.from ?? "?"} to ${(e.to ?? []).join(", ")}${e.cc?.length ? ` cc ${e.cc.join(", ")}` : ""}: ${cut(e.body, 500)}`;
    if (e.kind === "meeting") return `[${e.id}] ${e.teams ? "Teams meeting" : "calendar hold"} "${e.subject ?? ""}" ${e.start ?? ""} with ${(e.attendees ?? []).join(", ")}: ${cut(e.body, 200)}`;
    if (e.kind === "transcript") return `[${e.id}] transcript: ${(e.lines ?? []).map((l) => `${l.who}: ${l.text}`).join(" / ").slice(0, 900)}`;
    return `[${e.id}] document "${e.file ?? ""}" (${e.title ?? ""})${e.facts?.length ? `: ${e.facts.join("; ")}` : ""}`;
}

/** The instruction and the evidence, for the model. */
export function modelPrompt(entry: TimeEntry, evidence: readonly Evidence[]): string {
    return [
        "Write one billing narrative for this time entry from the evidence below.",
        "Fill four slots in order: what was done (verb), who took part, which document, and the purpose.",
        ...CLIENT_RULES,
        "After each phrase, cite the evidence it rests on in square brackets, such as: Reviewed agreement v3 [hvhp-v3]. Cite only ids listed below.",
        `The attorney typed: "${entry.raw ?? ""}".`,
        "Evidence:",
        ...evidence.map(evidenceLine),
    ].join("\n");
}

/** The wire body for Kiwi's drafts route: the entry as one row, the prompt and evidence as its activity text. */
export function modelBody(entry: TimeEntry, evidence: readonly Evidence[], matter: string | null): DraftsBody {
    const seconds = Math.round((Date.parse(entry.endedAt) - Date.parse(entry.startedAt)) / 1000);
    return {
        groups: [{ id: entry.id, matter, seconds, activities: [{ app: "Lawdie narrative drafter", title: entry.raw || null, document: null, path: null, excerpt: null, screen_text: modelPrompt(entry, evidence).slice(0, 4000), seconds }] }],
        examples: [],
    };
}

/**
 * The model's text as parts: each phrase up to a [id, id] citation is one part citing those
 * ids. A part citing any id outside `known` is dropped. Text with no citation after it stays,
 * citing nothing.
 */
export function parseCited(text: string, known: ReadonlySet<string>): NarrativePart[] {
    const parts: NarrativePart[] = [];
    const re = /\[([^\]]*)\]/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const phrase = text.slice(last, m.index);
        last = m.index + m[0].length;
        const ids = m[1].split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        if (!phrase.trim()) continue;
        if (ids.some((id) => !known.has(id))) continue;
        parts.push({ text: phrase, evidence: ids, slot: null });
    }
    const tail = text.slice(last);
    if (tail.trim()) parts.push({ text: tail, evidence: [], slot: null });
    // Where a citation was taken out: one space between parts, none before punctuation.
    return parts
        .map((p) => ({ ...p, text: p.text.trim() }))
        .filter((p) => p.text)
        .map((p, n) => ({ ...p, text: n === 0 || /^[.,;:)]/.test(p.text) ? p.text : ` ${p.text}` }));
}

/** A drafter that asks a model through Kiwi; `send` is KiwiClient.drafts bound to a paired client. */
export function modelDrafter(send: (body: DraftsBody) => Promise<{ drafts: { id: string; text: string }[] }>, matter: string | null): Drafter {
    return {
        kind: "model",
        draft: async (entry, evidence) => {
            const answer = await send(modelBody(entry, evidence, matter));
            const text = answer.drafts?.find((d) => d.id === entry.id)?.text ?? "";
            const parts = parseCited(text, new Set(evidence.map((e) => e.id)));
            if (!parts.length) throw new Error("The model returned no narrative.");
            return { parts, narrative: narrativeOf(parts), drafter: "model" };
        },
    };
}

/** The evidence an entry cites, in its sources' order, with each meeting's transcript after it. */
export function evidenceFor(entry: TimeEntry, all: Record<string, Evidence> | undefined): Evidence[] {
    if (!all) return [];
    const ids: string[] = [];
    const add = (id: string | null | undefined) => { if (id && all[id] && !ids.includes(id)) ids.push(id); };
    for (const s of entry.sources ?? []) add(s.id);
    for (const p of entry.parts ?? []) p.evidence.forEach(add);
    for (const id of [...ids]) if (all[id].kind === "meeting") add(all[id].transcript);
    return ids.map((id) => all[id]);
}
