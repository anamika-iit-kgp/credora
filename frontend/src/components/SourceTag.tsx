import { Cpu, Globe, Landmark } from "lucide-react";
import type { SourceId, SourceKind } from "../api/types";
import { KIND_LABEL, SOURCES, sourceMeta } from "../lib/sources";

/** The provenance mark: a stock icon per kind (bank = landmark, external API = globe, Exasol = processor),
 *  always shown with the kind's colour and its words, so meaning never rests on colour alone. */
export function SourceGlyph({ kind, size = 9 }: { kind: SourceKind; size?: number }) {
  const Icon = kind === "bank" ? Landmark : kind === "api" ? Globe : Cpu;
  return <Icon className={`glyph glyph-${kind === "exasol" ? "exa" : kind}`} size={size + 3} strokeWidth={2.25} aria-hidden="true" />;
}

export function SourceTag({
  source,
  compact = false,
  className = "",
}: {
  source: SourceId | string | null | undefined;
  compact?: boolean;
  className?: string;
}) {
  const m = sourceMeta(source);
  if (!m) return null;
  return (
    <span className={`stag stag-${m.kind} ${compact ? "stag-compact" : ""} ${className}`} title={m.label}>
      <SourceGlyph kind={m.kind} />
      <span className="stag-owner">{m.owner}</span>
      {m.kind !== "exasol" && <span className="stag-system">{compact && m.short ? m.short : m.system}</span>}
      {m.kind === "exasol" && <span className="stag-system">result</span>}
      <span className="sr-only">{`, ${m.holds}`}</span>
    </span>
  );
}

export function SourceLegend() {
  const kinds: { kind: SourceKind; ex: SourceId[] }[] = [
    { kind: "bank", ex: ["bank.oracle", "bank.mysql", "bank.postgres"] },
    { kind: "api", ex: ["api.cibil", "api.gstn", "api.aa"] },
    { kind: "exasol", ex: ["exasol"] },
  ];
  return (
    <dl className="legend">
      {kinds.map((k) => (
        <div key={k.kind} className={`legend-item legend-${k.kind}`}>
          <dt>
            <SourceGlyph kind={k.kind} size={10} /> {KIND_LABEL[k.kind]}
          </dt>
          <dd>{k.ex.map((e) => SOURCES[e].system === "result" ? "Decisions, ranks, offers" : SOURCES[e].system).join(", ")}</dd>
        </div>
      ))}
    </dl>
  );
}
