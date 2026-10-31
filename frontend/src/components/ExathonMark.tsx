import { useEffect, useState } from "react";
import { ArrowUpRight, BookOpen, PlayCircle, Presentation } from "lucide-react";
import { ExasolLogo } from "./BrandLogo";
import { siteLinks } from "../lib/sites";

/** "Built for ExaThon India 2026 · Powered by Exasol Personal", with the official Exasol logo. */
export function ExathonCredit({ logo = 13 }: { logo?: number }) {
  return (
    <p className="exathon-credit">
      <span className="exathon-built">Built for ExaThon India 2026</span>
      <span className="exathon-sep" aria-hidden="true">
        ·
      </span>
      <span className="exathon-powered">
        Powered by
        <span className="exathon-logo">
          <ExasolLogo height={logo} />
        </span>
        Personal
      </span>
    </p>
  );
}

/** Links to the companion sites; each opens in a new tab. */
/** View counts of the companion sites (one number per site, nothing about visitors). Optional. */
function useSiteViews(): Record<string, number> | null {
  const [views, setViews] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/views")
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => live && v && typeof v === "object" && setViews(v as Record<string, number>))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return views;
}

export function CompanionLinks() {
  const s = siteLinks();
  const views = useSiteViews();
  const items = [
    { href: s.docs, label: "Docs", icon: BookOpen, key: "docs" },
    { href: s.video, label: "Demo video", icon: PlayCircle, key: "video" },
    { href: s.ppt, label: "Presentation", icon: Presentation, key: "ppt" },
  ];
  return (
    <ul className="companion-links" aria-label="About this project">
      {items.map((i) => (
        <li key={i.label}>
          <a href={i.href} target="_blank" rel="noopener noreferrer" className="companion-link">
            <i.icon aria-hidden="true" />
            {i.label}
            <ArrowUpRight className="companion-out" aria-hidden="true" />
            {views && views[i.key] != null && (
              <span className="companion-views" title="Views">
                {views[i.key].toLocaleString("en-IN")}
              </span>
            )}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ExathonMark({ variant }: { variant: "nav" | "login" }) {
  return (
    <div className={`exathon exathon-${variant}`}>
      <CompanionLinks />
      <ExathonCredit logo={variant === "nav" ? 13 : 16} />
    </div>
  );
}
