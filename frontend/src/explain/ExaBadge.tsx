import { Cpu, Globe, Landmark, type LucideIcon } from "lucide-react";
import { useExplain } from "./ExplainContext";
import { Explain } from "./Explain";

type Kind = "exasol" | "bank" | "api";
const ICON: Record<Kind, LucideIcon> = { exasol: Cpu, bank: Landmark, api: Globe };

/**
 * "Where this number came from, in Exasol terms": a small chip on a result (Explain mode only).
 * Same marks as the provenance tags: landmark = read live from the bank, globe = external API, processor = computed in Exasol.
 */
export function ExaBadge({
  kind = "exasol",
  what,
  detail,
  term,
}: {
  kind?: Kind;
  what: string;
  detail?: string;
  term?: string;
}) {
  const { on } = useExplain();
  if (!on) return null;
  const Icon = ICON[kind];
  return (
    <span className={`xb xb-${kind}`}>
      <Icon aria-hidden="true" />
      <span className="xb-what">{what}</span>
      {detail && <span className="xb-detail">{detail}</span>}
      {term && <Explain id={term} label={what} />}
    </span>
  );
}

/** One thing Exasol did for a result, listed inside an ExaBadgeGroup. */
export interface ExaFact {
  detail: string;
  term?: string;
}

// The chip may wrap onto a second line when it carries several facts, so a narrow screen never clips it.
const GROUP_STYLE = { height: "auto", minHeight: 22, padding: "2px 4px 2px 7px", flexWrap: "wrap", rowGap: 2, whiteSpace: "normal" } as const;

/**
 * Several Exasol facts about one result as a single chip, so a screen does not repeat the same mark four times.
 * Each fact keeps its own hint, so nothing a separate badge would have said is lost.
 */
export function ExaBadgeGroup({ kind = "exasol", what, facts }: { kind?: Kind; what: string; facts: ExaFact[] }) {
  const { on } = useExplain();
  if (!on || facts.length === 0) return null;
  const Icon = ICON[kind];
  return (
    <span className={`xb xb-${kind}`} style={GROUP_STYLE}>
      <Icon aria-hidden="true" />
      <span className="xb-what">{what}</span>
      {facts.map((f) => (
        <span key={f.detail} className="xb-detail">
          {f.detail}
          {f.term && <Explain id={f.term} label={f.detail} />}
        </span>
      ))}
    </span>
  );
}

/** Ready-made badges for the recurring cases. */
export const Badges = {
  pd: () => <ExaBadge what="Computed in Exasol" detail="Python UDF PD_SCORE" term="python-udf" />,
  ranked: () => <ExaBadge what="Ranked" detail="PREFERRING skyline" term="preferring-skyline" />,
  semantic: () => <ExaBadge what="Semantic view" detail="certified metric" term="certified-metric" />,
  rls: () => <ExaBadge what="Row-level security" detail="V_RM_* on CURRENT_USER" term="row-level-security" />,
  readLive: (vs: string, db: string) => <ExaBadge kind="bank" what="Read live" detail={`${vs} pushdown to ${db}`} term="pushdown" />,
  decision: () => <ExaBadge what="Decided in Exasol" detail="RUN_ANALYSIS step 11, DECISION_LOGIC" term="run-analysis" />,
  whatIf: () => <ExaBadge what="Computed in Exasol" detail="one SELECT, nothing written" term="what-if" />,
  quote: () => <ExaBadge what="Checked in Exasol" detail="quote query as your Exasol user" term="negotiation-limit" />,
  mcp: () => <ExaBadge what="Answered from Exasol" detail="exasol-mcp-server as your AI session user" term="exasol-mcp-server" />,
  registry: () => <ExaBadge what="MODEL_REGISTRY" detail="pickle in BucketFS" term="model-registry" />,
};
