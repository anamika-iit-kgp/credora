// Explain mode plumbing that the API client needs, kept free of React.

const SESSION_KEY = "credora.console.session";

let cached: string | null = null;

/** A random id for this browser tab, sent as X-Credora-Session, so the Exasol console shows only this tab's statements. */
export function consoleSession(): string {
  if (cached) return cached;
  try {
    cached = sessionStorage.getItem(SESSION_KEY);
  } catch {
    cached = null;
  }
  if (!cached) {
    cached = `tab-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    try {
      sessionStorage.setItem(SESSION_KEY, cached);
    } catch {
      /* storage unavailable: the id lives for this page only */
    }
  }
  return cached;
}

/** Request path (without /api) -> the ACTION_EXPLAIN key of the action it starts. Quotes, reads and polls are not actions. */
const ACTION_ROUTES: [method: string, pattern: RegExp, action: string][] = [
  ["POST", /^\/admin\/generate$/, "generate"],
  ["POST", /^\/analysis\/run$/, "runAnalysis"],
  ["POST", /^\/runs\/[^/]+\/publish$/, "publishRun"],
  ["POST", /^\/ml\/train$/, "trainModels"],
  ["POST", /^\/ml\/activation-requests$/, "requestModelActivation"],
  ["POST", /^\/ml\/activation-requests\/[^/]+\/approve$/, "approveModelActivation"],
  ["POST", /^\/whatif(\/runs)?$/, "whatIf"],
  ["POST", /^\/policy\/proposals$/, "proposePolicy"],
  ["POST", /^\/policy\/proposals\/[^/]+\/approve$/, "approvePolicy"],
  ["POST", /^\/assignments$/, "assignRm"],
  ["POST", /^\/loan-status\/[^/]+$/, "logLoanStatus"],
  ["POST", /^\/offers\/[^/]+\/propose$/, "rmNegotiate"],
  ["POST", /^\/offers\/[^/]+\/(verify|sanction)$/, "verifySanction"],
  ["POST", /^\/companies\/[^/]+\/memo$/, "creditMemo"],
  ["POST", /^\/ai\/ask$/, "askCredora"],
  ["POST", /^\/admin\/purge/, "purge"],
];

export const ACTION_EVENT = "credora:action";

/** Called by the API client before each request: announces actions to Explain mode. */
export function noteRequest(method: string, path: string) {
  if (method === "GET") return;
  const p = path.split("?")[0];
  const hit = ACTION_ROUTES.find(([m, re]) => m === method && re.test(p));
  if (!hit) return;
  try {
    window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: { action: hit[2], path: p } }));
  } catch {
    /* no window (tests) */
  }
}
