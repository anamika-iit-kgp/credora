import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/policy.css";
import "./styles/workflow.css";
import "./styles/explain.css";
import { App } from "./App";

async function boot() {
  // Both conditions are replaced at build time, so a normal production build drops the fixture code entirely.
  if (import.meta.env.VITE_USE_FIXTURES === "1" || import.meta.env.MODE === "fixtures") {
    const { installFixtures } = await import("./fixtures/server");
    installFixtures();
    // Fixture mode only: `?as=admin|datasci|loanops|rm` signs in straight away (used for screenshots and demos).
    const as = new URLSearchParams(location.search).get("as");
    if (as && ["admin", "datasci", "loanops", "rm"].includes(as)) {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: as, password: "fixture" }),
      });
      const j = (await res.json()) as { token: string; user: unknown };
      sessionStorage.setItem("credora.token", j.token);
      sessionStorage.setItem("credora.user", JSON.stringify(j.user));
    }
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
