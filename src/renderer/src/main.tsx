import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installTips } from "./tips";
import "./styles.css";

installTips();

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
