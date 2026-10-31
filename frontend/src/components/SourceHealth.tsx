import type { SourceHealth, SourceKind } from "../api/types";
import { num } from "../lib/format";
import { KIND_LABEL, sourceMeta } from "../lib/sources";
import { Cable, Cpu, Landmark, type LucideIcon } from "lucide-react";
import { BrandLogo } from "./BrandLogo";
import { SourceGlyph, SourceTag } from "./SourceTag";

const KIND_ICON: Record<SourceKind, LucideIcon> = { bank: Landmark, api: Cable, exasol: Cpu };

const ORDER: SourceKind[] = ["bank", "api", "exasol"];

/** Seven sources in three bands: Sapphire Bank, external APIs, Exasol. */
export function SourceHealthStrip({ sources, detailed = false }: { sources: SourceHealth[]; detailed?: boolean }) {
  return (
    <div className="srcstrip">
      {ORDER.map((kind) => {
        const list = sources.filter((s) => s.kind === kind);
        if (!list.length) return null;
        const Icon = KIND_ICON[kind];
        return (
          <div key={kind} className={`srcband srcband-${kind}`} style={{ flexGrow: list.length }}>
            <p className="srcband-label">
              <Icon className="ic" aria-hidden="true" />
              {KIND_LABEL[kind]}
              <SourceGlyph kind={kind} size={9} />
            </p>
            <ul className="srcband-list">
              {list.map((s) => (
                <li key={s.source} className={`src src-${s.status}`}>
                  <div className="src-head">
                    <span className="brand-tile brand-tile-sm">
                      <BrandLogo source={s.source} size={s.source === "bank.oracle" ? 15 : s.source === "bank.mysql" ? 26 : 18} />
                    </span>
                    <SourceTag source={s.source} />
                  </div>
                  <p className="src-holds">{sourceMeta(s.source)?.holds}</p>
                  <p className="src-status">
                    <span className={`dot dot-${s.status}`} aria-hidden="true" />
                    {s.status === "up" ? "Up" : "Down"}
                    {s.latency_ms != null && <span className="muted num"> · {s.latency_ms} ms</span>}
                  </p>
                  <table className="src-tables">
                    <caption className="sr-only">Row counts in {s.label}</caption>
                    <tbody>
                      {(detailed ? s.tables : s.tables.slice(0, 2)).map((t) => (
                        <tr key={t.name}>
                          <th scope="row">
                            <code>{t.name}</code>
                          </th>
                          <td className="num">{num(t.rows)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
