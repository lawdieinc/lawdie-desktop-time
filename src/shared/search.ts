/* One search across the workspace (2026-11-12, "a search bar to search anywhere"): the time waiting for review,
   matters, kept entries, client rules and invoices. Pure, and only over what is already on this computer: nothing
   here goes to Kiwi. Every word of the query must appear (case and accents ignored); a hit on an item's own name
   ranks above a hit in its details, and newer work wins a tie. Personal time and the tutorial's sample are never
   found. The window (Search.tsx) shows the groups and opens what is picked through its `target`. */

import { isPersonal, type Activity, type Workspace } from "./model";
import { inboxOf } from "./matters";
import { rulebooksOf } from "./invoice";
import { isTutorialID } from "./onboarding";

export type SearchKind = "matter" | "review" | "entry" | "rule" | "invoice";

/** What picking a hit opens. */
export type SearchTarget =
    | { route: "matters"; project: string } // a project id, or "none" for time on no matter
    | { route: "activity"; row: string } // a To review row's id (a matter's day, or a stretch)
    | { route: "today"; entry: string; day: string } // YYYY-MM-DD, local
    | { route: "rules"; book: string; rule: string | null };

export type SearchHit = {
    kind: SearchKind;
    /** Unique in the results. */
    key: string;
    title: string;
    detail: string;
    /** Some of the text that matched, when it was not the title: the words around the first match. */
    snippet: string | null;
    target: SearchTarget;
};

export type SearchGroup = { kind: SearchKind; label: string; hits: SearchHit[]; more: number };

/** Hits shown per group; the rest are counted. */
export const SEARCH_GROUP_MAX = 5;
/** Characters of matched text shown around the match. */
export const SNIPPET_CHARS = 90;

const LABELS: Record<SearchKind, string> = { matter: "Matters", review: "To review", entry: "Kept time", rule: "Client rules", invoice: "Invoices" };
const ORDER: SearchKind[] = ["matter", "review", "entry", "rule", "invoice"];

/** Lower case, accents off, runs of space as one. */
export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
export const tokensOf = (query: string): string[] => fold(query).split(" ").filter(Boolean);

type Candidate = { kind: SearchKind; key: string; title: string; detail: string; at: string; target: SearchTarget; fields: (string | null | undefined)[] };

/** 0 the title starts with the query; 1 a word of the title starts with the first word; 2 every word in the title;
 *  3 found in the details; null not found. */
function rank(c: Candidate, query: string, tokens: string[]): { score: number; snippet: string | null } | null {
    const title = fold(c.title);
    const fields = c.fields.filter((f): f is string => !!f && !!f.trim());
    const all = fold([c.title, ...fields].join(" \n "));
    if (!tokens.every((t) => all.includes(t))) return null;
    if (title.startsWith(fold(query))) return { score: 0, snippet: null };
    if (tokens.every((t) => title.includes(t))) return { score: (" " + title).includes(" " + tokens[0]) ? 1 : 2, snippet: null };
    // A snippet that only repeats the line under the title (the matter, the client) says nothing new.
    const snippet = snippetOf(fields, tokens);
    return { score: 3, snippet: snippet && !fold(c.detail).includes(fold(snippet)) ? snippet : null };
}

/** The words around the first match of a word the title does not hold, from the first field holding it. */
export function snippetOf(fields: readonly string[], tokens: readonly string[]): string | null {
    for (const t of tokens) {
        for (const f of fields) {
            const flat = f.replace(/\s+/g, " ").trim();
            // Folding keeps length for Latin text, so the index found in the folded copy points into the original.
            const folded = flat.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
            const i = folded.length === flat.length ? folded.indexOf(t) : -1;
            if (i < 0) continue;
            if (flat.length <= SNIPPET_CHARS) return flat;
            const start = Math.max(0, Math.min(i - Math.floor((SNIPPET_CHARS - t.length) / 2), flat.length - SNIPPET_CHARS));
            const end = Math.min(flat.length, start + SNIPPET_CHARS);
            return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
        }
    }
    return null;
}

const localDay = (iso: string): string => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shortDay = (iso: string): string => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

/** What a sitting says about itself, for matching: its name, the person's and the AI's words, what was read from it. */
const activityFields = (a: Activity): (string | null | undefined)[] =>
    [a.matter, a.description, a.draft?.text, a.summary?.text, a.document?.name, a.title, a.app, a.meeting?.subject, a.meeting?.with.join(" "), a.url, a.document?.excerpt, a.screenText];

function candidates(w: Workspace): Candidate[] {
    const out: Candidate[] = [];
    const projectByID = new Map(w.projects.map((p) => [p.id, p]));
    for (const p of w.projects) {
        out.push({ kind: "matter", key: `matter:${p.id}`, title: p.name, at: "", target: { route: "matters", project: p.id },
            detail: [p.matterNumber, p.client, p.archived ? "archived" : ""].filter(Boolean).join(" · "),
            fields: [p.matterNumber, p.client, ...(p.aliases ?? []), ...(p.billTo ?? [])] });
    }
    const byID = new Map(w.activities.map((a) => [a.id, a]));
    const { groups, stretches } = inboxOf(w.activities.filter((a) => !isTutorialID(a.id)));
    for (const g of groups) {
        const sittings = g.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a);
        const said = sittings.map((a) => a.description).find(Boolean) ?? g.draft?.text;
        out.push({ kind: "review", key: `review:${g.id}`, title: g.matter, at: g.endedAt, target: { route: "activity", row: g.id },
            detail: [said, shortDay(g.startedAt)].filter(Boolean).join(" · "),
            fields: [g.draft?.text, ...g.documents.map((d) => d.name), ...sittings.flatMap(activityFields)] });
    }
    for (const st of stretches) {
        const sittings = st.activityIDs.map((id) => byID.get(id)).filter((a): a is Activity => !!a);
        out.push({ kind: "review", key: `review:${st.id}`, title: sittings.map((a) => a.description).find(Boolean) ?? st.name, at: st.endedAt, target: { route: "activity", row: st.id },
            detail: [st.app, "no matter", shortDay(st.startedAt)].join(" · "),
            fields: [st.name, st.draft?.text, ...sittings.flatMap(activityFields)] });
    }
    for (const e of w.entries) {
        if (e.status === "dismissed" || isTutorialID(e.id)) continue;
        const p = e.projectID ? projectByID.get(e.projectID) : undefined;
        out.push({ kind: "entry", key: `entry:${e.id}`, title: e.description || "(no description)", at: e.endedAt, target: { route: "today", entry: e.id, day: localDay(e.startedAt) },
            detail: [p?.name ?? "No matter", shortDay(e.startedAt)].join(" · "),
            fields: [p?.name, p?.matterNumber, p?.client, e.taskCode, e.activityCode, e.raw, e.typed?.note, e.seen?.title, e.seen?.app, e.groupLabel] });
    }
    for (const b of rulebooksOf(w)) {
        out.push({ kind: "rule", key: `book:${b.key}`, title: `${b.client} rules`, at: "", target: { route: "rules", book: b.key, rule: null },
            detail: `${b.rules.length} ${b.rules.length === 1 ? "rule" : "rules"}`, fields: [b.short, b.title] });
        for (const r of b.rules) {
            out.push({ kind: "rule", key: `rule:${b.key}:${r.id}`, title: r.title || r.id, at: "", target: { route: "rules", book: b.key, rule: r.id },
                detail: [b.client, r.id, r.section].filter(Boolean).join(" · "), fields: [b.client, r.id, r.section, r.does, r.quote] });
        }
    }
    for (const inv of w.invoices ?? []) {
        out.push({ kind: "invoice", key: `invoice:${inv.number}:${inv.issuedAt}`, title: `Invoice ${inv.number}`, at: inv.issuedAt,
            target: { route: "matters", project: inv.projectID ?? "none" },
            detail: [inv.matter, inv.client, inv.from === inv.to ? inv.from : `${inv.from} to ${inv.to}`, inv.rejection ? "rejected" : ""].filter(Boolean).join(" · "),
            fields: [inv.matter, inv.client, inv.from, inv.to, inv.rejection?.note] });
    }
    // Personal is not work to find, whichever list it sits in.
    return out.filter((c) => !(c.kind === "review" && isPersonal(c.title)));
}

/** The workspace's matches for a query, grouped (matters, To review, kept time, client rules, invoices); empty for a blank query. */
export function searchWorkspace(w: Workspace, query: string, max = SEARCH_GROUP_MAX): SearchGroup[] {
    const tokens = tokensOf(query);
    if (!tokens.length) return [];
    const scored = candidates(w).flatMap((c) => { const r = rank(c, query, tokens); return r ? [{ c, ...r }] : []; });
    return ORDER.flatMap((kind) => {
        const list = scored.filter((x) => x.c.kind === kind).sort((a, b) => a.score - b.score || (a.c.at < b.c.at ? 1 : a.c.at > b.c.at ? -1 : 0) || a.c.title.localeCompare(b.c.title));
        if (!list.length) return [];
        const hits = list.slice(0, max).map(({ c, snippet }): SearchHit => ({ kind, key: c.key, title: c.title, detail: c.detail, snippet, target: c.target }));
        return [{ kind, label: LABELS[kind], hits, more: list.length - hits.length }];
    });
}
