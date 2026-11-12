import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Workspace } from "@shared/model";
import { searchWorkspace, type SearchHit, type SearchTarget } from "@shared/search";

/* The search field in the top bar (src/shared/search.ts does the finding). ⌘K / Ctrl+K or "/" goes to it; the
   arrow keys and Enter pick a result; Escape clears it. Picking a result hands its target to the App, which opens
   that screen; the screen then calls `reveal()` to scroll to the row and mark it for a moment. */

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function SearchBar({ w, onOpen }: { w: Workspace; onOpen: (target: SearchTarget) => void }): ReactNode {
    const [query, setQuery] = useState("");
    const [focused, setFocused] = useState(false);
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const groups = useMemo(() => searchWorkspace(w, query), [w, query]);
    const hits = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
    useEffect(() => setActive(0), [query]);
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
            if ((e.key === "k" && (isMac ? e.metaKey : e.ctrlKey)) || (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)) {
                e.preventDefault();
                input.current?.focus();
                input.current?.select();
                setFocused(true);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const pick = (hit: SearchHit | undefined): void => {
        if (!hit) return;
        setQuery("");
        input.current?.blur();
        onOpen(hit.target);
    };
    const open = focused && query.trim().length > 0;
    let index = -1;
    return (
        <div className="search" role="search">
            <svg className="search-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            <input ref={input} type="search" value={query} placeholder="Search matters, activity, entries…" aria-label="Search" spellCheck={false}
                title="Find a matter, time waiting for review, a kept entry, a client's rule or an invoice."
                role="combobox" aria-expanded={open} aria-controls="search-results" aria-activedescendant={open && hits[active] ? `search-${active}` : undefined}
                onChange={(e) => { setQuery(e.target.value); setFocused(true); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
                onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
                    else if (e.key === "Enter") { e.preventDefault(); pick(hits[active]); }
                    else if (e.key === "Escape") { e.preventDefault(); if (query) setQuery(""); else input.current?.blur(); }
                }} />
            {!query && <kbd className="search-key" aria-hidden="true">{isMac ? "⌘K" : "Ctrl K"}</kbd>}
            {open && (
                // Mouse down, not click: the field's blur would close the list before a click lands.
                <div className="search-results" id="search-results" role="listbox" onMouseDown={(e) => e.preventDefault()}>
                    {groups.length === 0 && <p className="muted small search-none">Nothing matches “{query.trim()}”.</p>}
                    {groups.map((g) => (
                        <div key={g.kind} role="group" aria-label={g.label}>
                            <p className="eyebrow search-group">{g.label}{g.more > 0 && <span className="muted"> · {g.more} more</span>}</p>
                            {g.hits.map((h) => {
                                const i = ++index;
                                return (
                                    <button key={h.key} id={`search-${i}`} type="button" role="option" aria-selected={i === active} className={"search-hit" + (i === active ? " active" : "")}
                                        onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
                                        <span className="small strong search-title">{h.title}</span>
                                        {h.detail && <span className="muted tiny">{h.detail}</span>}
                                        {h.snippet && <span className="tiny search-snippet">{h.snippet}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Scrolls to the element marked `data-search-id={id}` once it is on screen, and marks it for a moment. */
export function reveal(id: string): void {
    let tries = 0;
    const look = (): void => {
        const el = document.querySelector<HTMLElement>(`[data-search-id="${CSS.escape(id)}"]`);
        if (!el) { if (++tries < 20) setTimeout(look, 50); return; }
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.remove("search-flash");
        void el.offsetWidth; // restart the animation
        el.classList.add("search-flash");
        setTimeout(() => el.classList.remove("search-flash"), 2400);
    };
    setTimeout(look, 0);
}
