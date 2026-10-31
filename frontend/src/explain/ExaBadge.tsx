import { Cpu, Globe, Landmark } from "lucide-react";
import { useExplain } from "./ExplainContext";
import { Explain } from "./Explain";

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
  kind?: "exasol" | "bank" | "api";
  what: string;
  detail?: string;
  term?: string;
}) {
  const { on } = useExplain();
  if (!on) return null;
  const Icon = kind === "bank" ? Landmark : kind === "api" ? Globe : Cpu;
  return (
    <span className={`xb xb-${kind}`}>
      <Icon aria-hidden="true" />
      <span className="xb-what">{what}</span>
      {detail && <span className="xb-detail">{detail}</span>}
      {term && <Explain id={term} label={what} />}
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
  mcp: () => <ExaBadge what="Answered from Exasol" detail="exasol-mcp-server as your role's user" term="exasol-mcp-server" />,
  registry: () => <ExaBadge what="MODEL_REGISTRY" detail="pickle in BucketFS" term="model-registry" />,
};
