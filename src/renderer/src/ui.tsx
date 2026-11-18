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

/* Icons for the buttons a row repeats (2026-11-18, "the buttons with text are getting crowded"). Line icons on a 16 px
   grid in the text colour; every button that shows one keeps its words in a tooltip and an aria-label. */
const ICON_PATHS = {
    edit: "M10.8 2.7l2.5 2.5M2.5 13.5l.6-3.1L11.2 2.3a1.2 1.2 0 011.7 0l.8.8a1.2 1.2 0 010 1.7l-8.1 8.1z",
    dismiss: "M4 4l8 8M12 4l-8 8",
    copy: "M5.5 5.5V3.3c0-.5.4-.8.8-.8h6.4c.5 0 .8.4.8.8v6.4c0 .5-.4.8-.8.8h-2.2M3.3 5.5h6.4c.5 0 .8.4.8.8v6.4c0 .5-.4.8-.8.8H3.3a.8.8 0 01-.8-.8V6.3c0-.4.4-.8.8-.8z",
    check: "M3 8.5l3 3 7-7",
    trash: "M2.5 4.5h11M6.5 4.5V3a.8.8 0 01.8-.8h1.4a.8.8 0 01.8.8v1.5M4 4.5l.6 8.3c0 .6.5 1 1.1 1h4.6c.6 0 1-.4 1.1-1l.6-8.3",
} as const;
export type IconName = keyof typeof ICON_PATHS;
export function Icon({ name }: { name: IconName }): ReactNode {
    return <svg className="ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d={ICON_PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** One click puts `text` on the clipboard, to paste into the firm's time system; the label says "Copied" (the icon a tick) for a moment. */
export function CopyButton({ text, what, label = "Copy", className = "quiet", icon = false }: { text: string; what: string; label?: ReactNode; className?: string; icon?: boolean }): ReactNode {
    const [done, setDone] = useState(false);
    useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1500); return () => clearTimeout(t); }, [done]);
    return (
        <button type="button" className={className + " copy" + (done ? " copied" : "")} title={`Copy ${what}, to paste into your time system.`} aria-label={`Copy ${what}`}
            onClick={(e) => { e.stopPropagation(); void window.lawdie.copyText(text).then(() => setDone(true)); }}>{icon ? <Icon name={done ? "check" : "copy"} /> : done ? "Copied" : label}</button>
    );
}
