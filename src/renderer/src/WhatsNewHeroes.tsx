/* The scenes at the top of the What's new card (after Kiwi's heroes): a small demo of the release that plays by
   itself and loops. Decoration only: hidden from assistive tech and never interactive. With reduced motion a scene
   shows its last frame and stays still. A release names its scene by key (`Release.hero`); without one the band
   shows the mark. */

import { useEffect, useState, type ReactNode } from "react";
import type { ReleaseHero } from "@shared/releases";
import mark from "../../../resources/brand/lawdie-icon.png";

const reducedMotion = (): boolean => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Steps through a scene's frames at the given times (ms), then starts again; the last frame when motion is reduced. */
function useScene(times: readonly number[], loopAt: number): number {
    const last = times.length;
    const [step, setStep] = useState(() => (reducedMotion() ? last : 0));
    useEffect(() => {
        if (reducedMotion()) return;
        let timers: ReturnType<typeof setTimeout>[] = [];
        const play = (): void => {
            timers = [...times.map((at, i) => setTimeout(() => setStep(i + 1), at)), setTimeout(() => { setStep(0); play(); }, loopAt)];
        };
        play();
        return () => timers.forEach(clearTimeout);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return step;
}

export function HeroFrame({ children }: { children?: ReactNode }): ReactNode {
    return <div className="whats-new-hero" aria-hidden="true">{children ?? <img className="hero-mark" src={mark} alt="" />}</div>;
}

/**
 * 0.16.0: a Teams call captured as "Microsoft Teams, no matter"; the Outlook meeting at the same time slides in,
 * the row takes its subject and invitees, the matter is named, and the transcript arrives. Then again.
 */
function MeetingsHero(): ReactNode {
    const step = useScene([700, 1700, 2500, 3300], 7000);
    const meeting = step >= 1, named = step >= 2, matter = step >= 3, transcript = step >= 4;
    return (
        <HeroFrame>
            <div className="hero-scene">
                <div className={"hero-event" + (meeting && !named ? " in" : "") + (named ? " gone" : "")}>
                    <span className="hero-event-bar" />
                    <span>
                        <span className="hero-event-when">Outlook · 2:00 – 2:45 PM</span>
                        <span className="hero-event-title">Lease renewal strategy call</span>
                    </span>
                </div>
                <div className={"hero-row" + (named ? " named" : "")}>
                    <span className="hero-app">T</span>
                    <span className="hero-row-main">
                        <span className="hero-row-title">
                            <span key={named ? "m" : "t"} className="hero-swap">{named ? "Lease renewal strategy call" : "Microsoft Teams"}</span>
                        </span>
                        <span className="hero-row-sub">
                            {named ? <span key="with" className="hero-swap">with Priya Patel, Sam Chen</span> : <span>Call · 44 min</span>}
                        </span>
                        <span className="hero-row-tags">
                            <span key={matter ? "a" : "b"} className={"hero-matter hero-swap" + (matter ? "" : " none")}>{matter ? "Harbor & Vale · Lease" : "No matter"}</span>
                            {transcript && <span className="hero-chip">Transcript</span>}
                        </span>
                    </span>
                    <span className="hero-time">44m</span>
                </div>
            </div>
        </HeroFrame>
    );
}

export const HEROES: Record<ReleaseHero, () => ReactNode> = { meetings: MeetingsHero };
