import { useEffect, useState, type ReactNode } from "react";

/* The small building blocks every screen is made of. Here, rather than in App.tsx, so the
   welcome and the tutorial (Onboarding.tsx) use the same ones. `tour` names a control the
   tutorial points at (a `data-tour` value; src/shared/onboarding.ts lists them). */

export function Heading({ eyebrow, title, subtitle }: { eyebrow?: string; title: string; subtitle?: string }): ReactNode {
    return <div className="heading">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 className="display">{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>;
}
export function Panel({ children, tour }: { children: ReactNode; tour?: string }): ReactNode { return <section className="panel" data-tour={tour}>{children}</section>; }
export function Empty({ title, detail }: { title: string; detail: string }): ReactNode { return <div className="empty"><strong>{title}</strong><p className="muted small">{detail}</p></div>; }
export function Setting({ title, detail, children }: { title: string; detail: string; children: ReactNode }): ReactNode {
    return <div className="setting"><div className="grow"><div className="small strong">{title}</div><p className="muted tiny">{detail}</p></div>{children}</div>;
}
export function Toggle({ on, onChange, label, tip }: { on: boolean; onChange: (v: boolean) => void; label: string; tip: { on: string; off: string } }): ReactNode {
    return <button type="button" role="switch" aria-checked={on} aria-label={label} title={on ? tip.on : tip.off} className={"toggle" + (on ? " on" : "")} onClick={() => onChange(!on)}><span /></button>;
}

/** One click puts `text` on the clipboard, to paste into the firm's time system; the label says "Copied" for a moment. */
export function CopyButton({ text, what, label = "Copy", className = "quiet" }: { text: string; what: string; label?: ReactNode; className?: string }): ReactNode {
    const [done, setDone] = useState(false);
    useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1500); return () => clearTimeout(t); }, [done]);
    return (
        <button type="button" className={className + " copy" + (done ? " copied" : "")} title={`Copy ${what}, to paste into your time system.`} aria-label={`Copy ${what}`}
            onClick={(e) => { e.stopPropagation(); void window.lawdie.copyText(text).then(() => setDone(true)); }}>{done ? "Copied" : label}</button>
    );
}
