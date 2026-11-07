import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installTips } from "./tips";
import "./styles.css";

installTips();

// Errors in the window go to the main process, which reports them (src/main/errors.ts).
const forward = (scope: string, error: unknown): void => {
    const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-Error value thrown");
    try { window.lawdie.reportError({ scope, name: e.name, message: e.message, stack: e.stack }); } catch { /* never let reporting break the window */ }
};
window.addEventListener("error", (ev) => forward("error", ev.error ?? ev.message));
window.addEventListener("unhandledrejection", (ev) => forward("rejection", ev.reason));

/** A screen that threw is reported and replaced by a line and a Reload, rather than a blank cream window. */
class Boundary extends React.Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
    componentDidCatch(error: unknown): void { forward("render", error); }
    render(): ReactNode {
        if (!this.state.failed) return this.props.children;
        return (
            <div className="loading" role="alert">
                Something went wrong drawing this screen. It has been reported.{" "}
                <button type="button" className="quiet" onClick={() => location.reload()}>Reload</button>
            </div>
        );
    }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <Boundary><App /></Boundary>
    </React.StrictMode>,
);
