import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A button that opens a small menu below it. A choice, a click outside it (including on another menu), or Escape
    closes it, so only one menu is ever open. `active` marks the button as showing something applied. */
export function Menu({ label, tip, children, active = false, className = "quiet" }: { label: ReactNode; tip: string; children: ReactNode; active?: boolean; className?: string }): ReactNode {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        const close = (e: Event): void => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
        const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", close);
        document.addEventListener("keydown", esc);
        return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
    }, [open]);
    return (
        <span className="menu" ref={root}>
            <button type="button" className={className + " menu-button" + (open ? " open" : "") + (active ? " applied" : "")} aria-haspopup="menu" aria-expanded={open} title={tip} onClick={() => setOpen(!open)}>
                {label}
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {open && <span className="menu-list" role="menu" onClick={() => setOpen(false)}>{children}</span>}
        </span>
    );
}

/** A right-click menu at the pointer: a few choices; a choice, a click elsewhere, scrolling or Escape closes it. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number }; items: { label: string; tip: string; onClick: () => void }[]; onClose: () => void }): ReactNode {
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const close = (e: Event): void => { if (!root.current?.contains(e.target as Node)) onClose(); };
        const esc = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
        document.addEventListener("mousedown", close, true);
        document.addEventListener("keydown", esc);
        document.addEventListener("scroll", onClose, true);
        window.addEventListener("blur", onClose);
        return () => { document.removeEventListener("mousedown", close, true); document.removeEventListener("keydown", esc); document.removeEventListener("scroll", onClose, true); window.removeEventListener("blur", onClose); };
    }, [onClose]);
    // Kept inside the window: a menu opened near the right or bottom edge opens the other way.
    const x = Math.min(at.x, window.innerWidth - 240), y = Math.min(at.y, window.innerHeight - 20 - items.length * 40);
    return createPortal(
        <div ref={root} className="context-menu menu-list" role="menu" style={{ left: x, top: y }}>
            {items.map((it) => <button key={it.label} type="button" role="menuitem" title={it.tip} onClick={() => { it.onClick(); onClose(); }}>{it.label}</button>)}
        </div>,
        document.body,
    );
}
