/* The What's new card (2026-11-09, after Kiwi's): one release's notes over the app, opened once after an update
   (`needsWhatsNew`) or on demand from Settings → Display & data and the tray. The items rise in one after another
   unless reduced motion is on. Escape, the backdrop, Got it and an item that opens a screen all dismiss it, and
   dismissing records the newest release as seen. "See all updates" lists every release in the same sheet. */

import { useEffect, useState, type ReactNode } from "react";
import { LATEST_RELEASE, RELEASES, releaseDateLabel, type Release, type ReleaseIcon, type ReleaseItem } from "@shared/releases";
import { HEROES, HeroFrame } from "./WhatsNewHeroes";

const PATHS: Record<ReleaseIcon, ReactNode> = {
    calendar: <><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></>,
    transcript: <><path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5" /></>,
    compass: <><circle cx="8" cy="8" r="5.5" /><path d="M10.2 5.8 9 9 5.8 10.2 7 7z" /></>,
    invoice: <><path d="M3.5 2h9v12l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1z" /><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" /></>,
    sparkle: <path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3zM12.5 11.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />,
    matter: <><path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /></>,
    shield: <><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" /><path d="M6 8l1.5 1.5L10.5 6.5" /></>,
    rules: <><path d="M3 4h10M3 8h10M3 12h6" /><circle cx="12" cy="12" r="1.5" /></>,
    clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
};

function Icon({ name }: { name: ReleaseIcon }): ReactNode {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>;
}

function Items({ items, onOpen, animate }: { items: readonly ReleaseItem[]; onOpen: (route: NonNullable<ReleaseItem["route"]>) => void; animate: boolean }): ReactNode {
    return (
        <ul className="whats-new-items">
            {items.map((item, i) => {
                const body = (
                    <>
                        <span className="whats-new-icon"><Icon name={item.icon} /></span>
                        <span>
                            <span className="whats-new-item-title">{item.title}{item.route && <span className="whats-new-go" aria-hidden="true"> →</span>}</span>
                            <span className="whats-new-item-text">{item.description}</span>
                        </span>
                    </>
                );
                return (
                    <li key={item.title} className={animate ? "rise" : undefined} style={animate ? { animationDelay: `${180 + i * 90}ms` } : undefined}>
                        {item.route ? <button type="button" className="whats-new-link" title={`Open ${item.route === "today" ? "Time" : item.route[0].toUpperCase() + item.route.slice(1)}.`} onClick={() => onOpen(item.route!)}>{body}</button> : <div className="whats-new-row">{body}</div>}
                    </li>
                );
            })}
        </ul>
    );
}

export function WhatsNew({ onDismiss, onOpen, release = LATEST_RELEASE }: { onDismiss: () => void; onOpen: (route: NonNullable<ReleaseItem["route"]>) => void; release?: Release }): ReactNode {
    const [all, setAll] = useState(false);
    useEffect(() => {
        const key = (e: KeyboardEvent): void => { if (e.key === "Escape") onDismiss(); };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [onDismiss]);
    const open = (route: NonNullable<ReleaseItem["route"]>): void => { onDismiss(); onOpen(route); };
    return (
        <div className="scrim whats-new-scrim" onClick={onDismiss} data-testid="whats-new">
            <div className={"sheet whats-new" + (all ? " all" : "")} role="dialog" aria-modal="true" aria-labelledby="whats-new-title" onClick={(e) => e.stopPropagation()}>
                {all ? (
                    <div className="whats-new-body">
                        <div className="row between">
                            <h2 className="display" id="whats-new-title">All updates</h2>
                            <button type="button" className="link" title="Back to the latest update." onClick={() => setAll(false)}>← Latest</button>
                        </div>
                        {RELEASES.map((r) => (
                            <section key={r.id} className="whats-new-release">
                                <p className="eyebrow">Version {r.id} · {releaseDateLabel(r.date)}</p>
                                <h3 className="display">{r.title}</h3>
                                <Items items={r.items} onOpen={open} animate={false} />
                            </section>
                        ))}
                    </div>
                ) : (
                    <>
                        {release.hero ? (() => { const Hero = HEROES[release.hero]; return <Hero />; })() : <HeroFrame />}
                        <div className="whats-new-body">
                            <p className="eyebrow">What's new <span className="whats-new-date">· {releaseDateLabel(release.date)} · version {release.id}</span></p>
                            <h2 className="display" id="whats-new-title">{release.title}</h2>
                            <Items items={release.items} onOpen={open} animate />
                        </div>
                    </>
                )}
                <div className="row between whats-new-foot">
                    {all ? <span /> : <button type="button" className="link" title="Every update, newest first." onClick={() => setAll(true)}>See all updates</button>}
                    <button type="button" className="primary" autoFocus title="Close and carry on." onClick={onDismiss}>Got it</button>
                </div>
            </div>
        </div>
    );
}
