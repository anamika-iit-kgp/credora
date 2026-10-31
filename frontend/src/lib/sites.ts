import { FIXTURES } from "./env";

/**
 * Companion sites (docs, demo video, presentation) live on sub-domains of whatever domain serves the app,
 * so nothing here names a domain: on app.example the docs are at docs.example.
 * Locally (fixtures, localhost, a bare IP) there is no such domain, so the links fall back to relative placeholders.
 */
export interface SiteLinks {
  docs: string;
  video: string;
  ppt: string;
}

function isLocal(host: string) {
  return !host || host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":");
}

/** The domain the app is served from, without a leading "www."; null when running locally. */
export function rootDomain(hostname: string = window.location.hostname): string | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return FIXTURES || isLocal(host) ? null : host;
}

export function siteLinks(hostname?: string): SiteLinks {
  const root = rootDomain(hostname);
  if (!root) return { docs: "/docs", video: "/video", ppt: "/ppt" };
  return { docs: `https://docs.${root}`, video: `https://video.${root}`, ppt: `https://ppt.${root}` };
}
