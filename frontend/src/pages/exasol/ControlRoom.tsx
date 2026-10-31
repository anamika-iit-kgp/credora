import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Cable,
  Cpu,
  ExternalLink,
  FlaskConical,
  Landmark,
  Layers,
  Lock,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Sparkles,
  SquareFunction,
  Timer,
  Users,
} from "lucide-react";
import { api } from "../../api/client";
import { useControlRoom, type ControlRoom, type CrSchema, type Section } from "../../api/exasol";
import { ErrorState, Loading, PageHeader, Panel } from "../../components/ui";
import { Explain, WithExplain } from "../../explain/Explain";
import { EXTENSIONS, SCHEMA_EXTENSION } from "../../explain/extensions";
import { ms } from "../../explain/ExasolConsole";
import { num } from "../../lib/format";

/* ---------- small parts ---------- */

function Ext({ id }: { id: string }) {
  const e = EXTENSIONS[id];
  if (!e) return null;
  const owner = e.repo.split("/").slice(-2, -1)[0];
  return (
    <a className="cr-ext" href={e.repo} target="_blank" rel="noreferrer" title={e.what}>
      <span className="cr-ext-owner">{owner}/</span>
      {e.name}
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

/** A section Exasol refused: shown as the grant at work, not as a failure of the page. */
function Refused({ s, who, what }: { s: Extract<Section<unknown>, { ok: false }>; who: string; what: string }) {
  if (!s.denied)
    return (
      <p className="cr-fail">
        This part did not load. <code>{s.error}</code>
      </p>
    );
  return (
    <div className="cr-refused">
      <span className="cr-refused-mark" aria-hidden="true">
        <Lock />
      </span>
      <div>
        <p className="cr-refused-title">
          Exasol refused {what} for <code>{who}</code>
          <Explain id="grant" />
        </p>
        <p className="cr-refused-msg">
          <code>{s.error}</code>
        </p>
        <p className="muted small">The database said no, not the app. Your role holds no grant on this object, so the same query from any tool would fail the same way.</p>
      </div>
    </div>
  );
}

function SectionBody<T>({ s, who, what, children }: { s: Section<T>; who: string; what: string; children: (d: T) => ReactNode }) {
  if (!s.ok) return <Refused s={s} who={who} what={what} />;
  return <>{children(s.data)}</>;
}

const COUNT_WORDS: [string, string, string][] = [
  ["table", "table", "tables"],
  ["view", "view", "views"],
  ["script", "script", "scripts"],
  ["function", "function", "functions"],
];

function counts(c: Record<string, number>) {
  return COUNT_WORDS.filter(([k]) => c[k]).map(([k, one, many]) => `${num(c[k])} ${c[k] === 1 ? one : many}`);
}

/* ---------- the schema map ---------- */

const SEMANTIC_ENGINE = ["SEMANTIC_ADMIN", "SEMANTIC_AGENT", "SEMANTIC_CATALOG", "SEMANTIC_SOURCE", "SYS_SEMANTIC"];
const LANES: { key: string; title: string; note: string; icon: typeof Cpu; schemas: string[] }[] = [
  { key: "bank", title: "Bank systems, read in place", note: "Virtual schemas push every query down to RDS", icon: Landmark, schemas: ["VS_CBS", "VS_CIF", "VS_LOS"] },
  { key: "stage", title: "Raw 3rd party data", note: "CIBIL, GSTN and AA API replies, fetched on demand and purged on time", icon: Layers, schemas: ["CREDORA_STAGE"] },
  { key: "results", title: "Results", note: "Decisions, scores, models and the run log", icon: Cpu, schemas: ["CREDORA"] },
  { key: "sem", title: "Governed metrics", note: "One semantic view for the app and the AI", icon: Sparkles, schemas: ["CREDORA_SEM"] },
];
const ENGINE_SCHEMAS = ["ADAPTER", "ADBC_VS", "PREPROC", "PREPROC_RT", "SCHED", ...SEMANTIC_ENGINE];

const SCHEMA_TERM: Record<string, string> = {
  VS_CBS: "oracle-vs-adapter",
  VS_CIF: "adbc-vs-rs",
  VS_LOS: "adbc-vs-rs",
  CREDORA_STAGE: "credora-stage",
  CREDORA: "credora-schema",
  CREDORA_SEM: "semantic-view",
  ADAPTER: "oracle-vs-adapter",
  ADBC_VS: "adbc-vs-rs",
  PREPROC: "sql-preprocessor",
  PREPROC_RT: "sql-preprocessor",
  SCHED: "exasol-scheduler",
};

function SchemaTile({ s, wide = false }: { s: CrSchema; wide?: boolean }) {
  const hidden = s.visible === 0;
  const ext = SCHEMA_EXTENSION[s.name] ?? [];
  return (
    <li className={`cr-tile ${hidden ? "is-hidden" : ""} ${s.virtual ? "is-virtual" : ""} ${wide ? "is-wide" : ""}`}>
      <p className="cr-tile-name">
        <code>{s.name}</code>
        {SCHEMA_TERM[s.name] && <Explain id={SCHEMA_TERM[s.name]} label={s.name} />}
      </p>
      {hidden ? (
        <p className="cr-tile-lock">
          <Lock aria-hidden="true" />
          No objects visible to your role
        </p>
      ) : (
        <p className="cr-tile-counts">{counts(s.counts).join(" · ") || "Visible"}</p>
      )}
      {s.virtual && <p className="cr-tile-tag">Virtual schema</p>}
      {s.comment && (
        <p className="cr-tile-comment" title={s.comment}>
          {s.comment}
        </p>
      )}
      {ext.length > 0 && (
        <p className="cr-tile-ext">
          {ext.map((x) => (
            <Ext key={x} id={x} />
          ))}
        </p>
      )}
    </li>
  );
}

function SchemaMap({ schemas }: { schemas: CrSchema[] }) {
  const by = new Map(schemas.map((s) => [s.name, s]));
  const engine = ENGINE_SCHEMAS.map((n) => by.get(n)).filter(Boolean) as CrSchema[];
  const semanticEngine = engine.filter((s) => SEMANTIC_ENGINE.includes(s.name));
  const others = schemas.filter((s) => !LANES.some((l) => l.schemas.includes(s.name)) && !ENGINE_SCHEMAS.includes(s.name));
  const visibleTotal = schemas.reduce((a, s) => a + s.visible, 0);
  return (
    <div className="cr-map">
      <ol className="cr-lanes" aria-label="How data flows through the schemas">
        {LANES.map((l) => (
          <li key={l.key} className={`cr-lane cr-lane-${l.key}`}>
            <p className="cr-lane-title">
              <l.icon aria-hidden="true" />
              {l.title}
            </p>
            <p className="cr-lane-note">{l.note}</p>
            <ul className="cr-tiles">
              {l.schemas
                .map((n) => by.get(n))
                .filter(Boolean)
                .map((s) => (
                  <SchemaTile key={s!.name} s={s!} />
                ))}
            </ul>
          </li>
        ))}
      </ol>
      <div className="cr-engine">
        <p className="cr-lane-title">
          <Boxes aria-hidden="true" />
          Exasol extensions installed in the database
        </p>
        <ul className="cr-tiles cr-tiles-row">
          {engine
            .filter((s) => !SEMANTIC_ENGINE.includes(s.name))
            .map((s) => (
              <SchemaTile key={s.name} s={s} />
            ))}
          {semanticEngine.length > 0 && (
            <SchemaTile
              wide
              s={{
                name: "SEMANTIC_*",
                owner: "SYS",
                virtual: false,
                comment: "Exasol Semantic Views catalog, compiler and agent views behind CREDORA_SEM",
                counts: semanticEngine.reduce<Record<string, number>>((acc, s) => {
                  for (const [k, v] of Object.entries(s.counts)) acc[k] = (acc[k] ?? 0) + v;
                  return acc;
                }, {}),
                visible: semanticEngine.reduce((a, s) => a + s.visible, 0),
              }}
            />
          )}
          {others.map((s) => (
            <SchemaTile key={s.name} s={s} />
          ))}
        </ul>
      </div>
      <p className="muted small">
        {schemas.length} schemas exist, and your Exasol user can see <span className="num">{num(visibleTotal)}</span> objects in them. Counts come from{" "}
        <code>EXA_ALL_OBJECTS</code>, which lists only what your grants allow.
      </p>
    </div>
  );
}

/* ---------- panels ---------- */

const ADAPTER_LANG: Record<string, string> = { "ADAPTER.ORACLE_ADAPTER": "JAVA", "ADBC_VS.ADBC_ADAPTER": "RUST" };
const LANG_EXT: Record<string, string> = { PYTHON3: "script-languages-release", JAVA: "script-languages-release", RUST: "language-container-rs" };

function scriptKind(type: string, input: string | null, language: string) {
  if (type === "SCRIPTING") return `${language === "LUA" ? "Lua" : language} script`;
  if (type === "ADAPTER") return "Adapter script";
  const lang = language === "PYTHON3" ? "Python" : language === "LUA" ? "Lua" : language.charAt(0) + language.slice(1).toLowerCase();
  return `${lang} ${input ?? ""} UDF`.replace(/\s+/g, " ");
}

function ScriptsPanel({ cr }: { cr: ControlRoom }) {
  const [schema, setSchema] = useState<string>("CREDORA");
  const who = cr.exasol_user;
  const adapters = cr.virtual_schemas.ok ? Array.from(new Set(cr.virtual_schemas.data.map((v) => v.adapter))) : [];
  return (
    <Panel title={<WithExplain id="udf">Scripts and UDFs</WithExplain>} icon={SquareFunction} flush>
      <SectionBody s={cr.scripts} who={who} what="the script list">
        {(d) => {
          const schemas = Array.from(new Set(d.items.map((i) => i.schema)));
          const items = d.items.filter((i) => i.schema === (schemas.includes(schema) ? schema : schemas[0]));
          return (
            <>
              <div className="cr-panel-tools">
                <div className="seg seg-sm" role="radiogroup" aria-label="Schema">
                  {schemas.map((s) => (
                    <button key={s} role="radio" aria-checked={items[0]?.schema === s} className={`seg-btn ${items[0]?.schema === s ? "is-on" : ""}`} onClick={() => setSchema(s)}>
                      {s} <span className="num muted">{d.per_schema[s] ?? 0}</span>
                    </button>
                  ))}
                </div>
                <span className="muted small">
                  <span className="num">{num(d.total)}</span> scripts visible in <code>EXA_ALL_SCRIPTS</code>
                </span>
              </div>
              {items.length === 0 ? (
                <p className="pad muted">No scripts of the Credora schemas are visible to <code>{who}</code>. Your role executes none of them.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Script</th>
                        <th>
                          <WithExplain id="scalar-vs-set-udf">Kind</WithExplain>
                        </th>
                        <th>
                          <WithExplain id="slc">Language</WithExplain>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((s) => (
                        <tr key={s.schema + s.name}>
                          <td>
                            <code className="cr-script">{s.name}</code>
                          </td>
                          <td>
                            {scriptKind(s.type, s.input, s.language)}
                            <div className="muted small">{s.result}</div>
                          </td>
                          <td>
                            <span className={`cr-lang cr-lang-${s.language.toLowerCase()}`}>{s.language}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {adapters.length > 0 && (
                <p className="cr-note">
                  Adapter scripts{" "}
                  {adapters.map((a, i) => (
                    <span key={a}>
                      {i > 0 && ", "}
                      <code>{a}</code> ({ADAPTER_LANG[a] ?? "adapter"})
                    </span>
                  ))}{" "}
                  run the virtual schemas. They belong to <code>SYS</code>, so they appear here through the virtual schemas only.
                </p>
              )}
            </>
          );
        }}
      </SectionBody>
      {cr.preprocessor.ok && cr.preprocessor.data.languages.length > 0 && (
        <div className="cr-slcs">
          <p className="cr-sub">
            <WithExplain id="slc">Script languages (SCRIPT_LANGUAGES)</WithExplain>
          </p>
          <ul>
            {cr.preprocessor.data.languages.map((l) => (
              <li key={l.alias}>
                <span className={`cr-lang cr-lang-${l.alias.toLowerCase()}`}>{l.alias}</span>
                <span className="muted small">{l.builtin ? "built in" : "BucketFS"}</span>
                <code className="cr-slc-path">{l.container}</code>
                {LANG_EXT[l.alias] && <Ext id={LANG_EXT[l.alias]} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function RunLogPanel({ cr }: { cr: ControlRoom }) {
  return (
    <Panel title={<WithExplain id="run-log">Latest analysis run</WithExplain>} icon={Timer}>
      <SectionBody s={cr.run_log} who={cr.exasol_user} what="CREDORA.RUN_LOG">
        {(d) => {
          if (!d.steps.length) return <p className="muted">No analysis has run yet.</p>;
          const max = Math.max(...d.steps.map((s) => s.ms ?? 0), 1);
          const total = d.steps.reduce((a, s) => a + (s.ms ?? 0), 0);
          return (
            <>
              <p className="muted small cr-runlog-head">
                <code>EXECUTE SCRIPT CREDORA.RUN_ANALYSIS('{d.run_id}')</code> · {d.steps.length} steps, each committed to <code>RUN_LOG</code> ·{" "}
                <span className="num">{ms(total)}</span> in Exasol
              </p>
              <ol className="cr-steps">
                {d.steps.map((s) => (
                  <li key={s.n} className={s.status === "OK" ? "" : "is-failed"}>
                    <span className="cr-step-n num">{s.n}</span>
                    <span className="cr-step-name">{s.name}</span>
                    <span className="cr-step-bar" aria-hidden="true">
                      <span style={{ transform: `scaleX(${Math.max(0.01, (s.ms ?? 0) / max)})` }} />
                    </span>
                    <span className="cr-step-ms num">{ms(s.ms)}</span>
                    <span className="cr-step-rows num muted">{s.rows != null ? num(s.rows) : ""}</span>
                  </li>
                ))}
              </ol>
            </>
          );
        }}
      </SectionBody>
    </Panel>
  );
}

function SecurityPanel({ cr }: { cr: ControlRoom }) {
  return (
    <Panel
      title={<WithExplain id="role">Roles and grants</WithExplain>}
      icon={ShieldCheck}
      aside={cr.security.ok && <span className="muted small">{cr.security.data.scope === "dba" ? "EXA_DBA_* (admin)" : "EXA_ROLE_* and EXA_USER_* (your own)"}</span>}
    >
      <SectionBody s={cr.security} who={cr.exasol_user} what="the grants">
        {(d) => (
          <>
            {d.scope === "own" && (
              <p className="cr-note cr-note-top">
                Your Exasol user can read only its own grants. The admin, with <code>SELECT ANY DICTIONARY</code>
                <Explain id="select-any-dictionary" />, sees every role here.
              </p>
            )}
            <ul className="cr-roles">
              {d.roles.map((r) => {
                const objs = r.objects.reduce<Record<string, string[]>>((acc, o) => {
                  (acc[o.object] ??= []).push(o.privilege);
                  return acc;
                }, {});
                return (
                  <li key={r.role} className={`cr-role ${r.users.includes(cr.exasol_user) ? "is-mine" : ""}`}>
                    <p className="cr-role-head">
                      <code className="cr-role-name">{r.role}</code>
                      {r.users.map((u) => (
                        <code key={u} className="cr-role-user">
                          {u}
                        </code>
                      ))}
                      {r.users.includes(cr.exasol_user) && <span className="cr-you">you</span>}
                    </p>
                    {r.system.length > 0 && <p className="cr-role-sys">{r.system.join(", ")}</p>}
                    <ul className="cr-role-objs">
                      {Object.entries(objs).map(([o, privs]) => (
                        <li key={o}>
                          <span className="cr-privs">{privs.join(", ")}</span> <code>{o}</code>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </SectionBody>
    </Panel>
  );
}

/* ---------- the page ---------- */

export function ControlRoomPage() {
  const q = useControlRoom();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const cr = q.data;
  const read = useMemo(() => (cr ? new Date(cr.read_at).toLocaleTimeString("en-GB", { hour12: false }) : null), [cr]);

  const refresh = async () => {
    setBusy(true);
    try {
      const fresh = await api<ControlRoom>("/exasol/control-room?fresh=true");
      qc.setQueryData(["exasol", "control-room"], fresh);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page ctrl-room">
      <PageHeader
        title="Exasol control room"
        lede={
          <>
            The live database, read just now as <code>{cr?.exasol_user ?? "your role's Exasol user"}</code>. Every panel is a query on Exasol's system
            tables made with your own Exasol user, so what your grants hide is missing here too. Sign in as another role and this page changes.
          </>
        }
        actions={
          <>
            {cr && (
              <span className="muted small cr-read">
                Read {read} · <span className="num">{ms(cr.took_ms)}</span>
                {cr.cached ? " · cached" : ""}
              </span>
            )}
            <button className="btn btn-quiet btn-sm" onClick={() => void refresh()} disabled={busy}>
              <RefreshCw aria-hidden="true" className={busy ? "spin" : ""} />
              Read again
            </button>
          </>
        }
      />
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {!cr && !q.isError && <Loading label="Reading Exasol's system tables" rows={8} />}
      {cr && (
        <>
          <SectionBody s={cr.system} who={cr.exasol_user} what="the system information">
            {(s) => (
              <dl className="cr-sys">
                <div>
                  <dt>
                    <WithExplain id="exasol-personal-aws">Database</WithExplain>
                  </dt>
                  <dd>
                    Exasol <span className="num">{s.version}</span>
                  </dd>
                </div>
                <div>
                  <dt>Deployment</dt>
                  <dd>
                    {s.deployment} <Ext id="exasol-personal" />
                  </dd>
                </div>
                <div>
                  <dt>Machine</dt>
                  <dd className="num">
                    {[s.instance_type, s.nodes != null && `${s.nodes} node`, s.vcpu != null && `${s.vcpu} vCPU`, s.db_ram_gib != null && `${s.db_ram_gib} GiB DB RAM`]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </div>
                <div>
                  <dt>
                    <WithExplain id="current-user">You, in Exasol</WithExplain>
                  </dt>
                  <dd>
                    <code>{s.current_user}</code> <span className="muted small num">session {s.session_id}</span>
                  </dd>
                </div>
              </dl>
            )}
          </SectionBody>

          <Panel title={<WithExplain id="system-tables">Schemas, as your grants show them</WithExplain>} icon={Layers}>
            <SectionBody s={cr.schemas} who={cr.exasol_user} what="the schema list">
              {(d) => <SchemaMap schemas={d} />}
            </SectionBody>
          </Panel>

          <Panel title={<WithExplain id="virtual-schema">Virtual schemas</WithExplain>} icon={Landmark} flush aside={<span className="muted small">EXA_ALL_VIRTUAL_SCHEMAS</span>}>
            <SectionBody s={cr.virtual_schemas} who={cr.exasol_user} what="the virtual schemas">
              {(d) => (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Schema</th>
                        <th>Source</th>
                        <th>
                          <WithExplain id="oracle-vs-adapter">Adapter</WithExplain>
                        </th>
                        <th>
                          <WithExplain id="connection-object">Connection</WithExplain>
                        </th>
                        <th>
                          <WithExplain id="vs-refresh">Last refresh</WithExplain>
                        </th>
                        <th>Open source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.map((v) => (
                        <tr key={v.name}>
                          <td>
                            <code className="strong">{v.name}</code>
                          </td>
                          <td>
                            {v.source}
                            <div className="muted small">{v.holds}</div>
                          </td>
                          <td>
                            <code>{v.adapter}</code>
                            {v.driver && (
                              <div className="muted small">
                                ADBC driver {v.driver} {v.driver_version}
                              </div>
                            )}
                          </td>
                          <td>
                            <code>{v.connection}</code>
                          </td>
                          <td className="nowrap">
                            {v.last_refresh ? new Date(v.last_refresh).toLocaleString("en-GB", { hour12: false }) : "never"}
                            {v.last_refresh_by && <div className="muted small">by {v.last_refresh_by}</div>}
                          </td>
                          <td>{v.extension && <Ext id={v.extension} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionBody>
          </Panel>

          <div className="grid-2 cr-grid">
            <ScriptsPanel cr={cr} />
            <RunLogPanel cr={cr} />
          </div>

          <div className="grid-2 cr-grid">
            <Panel title={<WithExplain id="model-registry">Model registry</WithExplain>} icon={FlaskConical} flush>
              <SectionBody s={cr.models} who={cr.exasol_user} what="CREDORA.MODEL_REGISTRY">
                {(d) => (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Version</th>
                          <th className="r">AUC</th>
                          <th>
                            <WithExplain id="pickle-model">Pickle in BucketFS</WithExplain>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.map((m) => (
                          <tr key={m.version} className={m.active ? "cr-active" : ""}>
                            <td className="nowrap">
                              <code className="strong">{m.version}</code> {m.active && <span className="cr-you">active</span>}
                              <div className="muted small">{m.algorithm}</div>
                            </td>
                            <td className="r num">{m.auc != null ? m.auc.toFixed(3) : "–"}</td>
                            <td>
                              <code className="cr-path">{m.path}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionBody>
            </Panel>
            <SecurityPanel cr={cr} />
          </div>

          <div className="grid-2 cr-grid">
            <Panel title={<WithExplain id="semantic-view">Semantic model</WithExplain>} icon={Sparkles} flush aside={<Ext id="exasol-semantic-views" />}>
              <SectionBody s={cr.semantic} who={cr.exasol_user} what="the semantic catalog">
                {(d) => (
                  <>
                    {d.models.map((m) => (
                      <p key={m.name} className="cr-note cr-note-top">
                        Model <code>{m.name}</code> v{m.model_version}, published to <code>{m.schema}</code> ({m.status.toLowerCase()}, {m.surface.toLowerCase().replace(/_/g, " ")})
                        {d.version && <> · Semantic Views {d.version}</>}
                      </p>
                    ))}
                    <div className="table-wrap cr-metrics">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>
                              <WithExplain id="certified-metric">Metric</WithExplain>
                            </th>
                            <th>Definition</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.metrics.map((m) => (
                            <tr key={m.name}>
                              <td>
                                <code className="strong">{m.name}</code> {m.certified && <span className="cr-cert">certified</span>}
                                <div className="muted small">{m.display}</div>
                              </td>
                              <td>
                                <code className="cr-expr">
                                  {m.expression}
                                  {m.filter ? ` WHERE ${m.filter}` : ""}
                                </code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </SectionBody>
            </Panel>
            <Panel title={<WithExplain id="sql-preprocessor">SQL preprocessor</WithExplain>} icon={ScrollText} aside={<Ext id="preprocessor-framework" />}>
              <SectionBody s={cr.preprocessor} who={cr.exasol_user} what="the parameters">
                {(p) => (
                  <dl className="cr-kv">
                    <div>
                      <dt>System value</dt>
                      <dd>
                        <code>{p.system ?? "not set"}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>This session</dt>
                      <dd>
                        <code>{p.session ?? "not set"}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>What it does</dt>
                      <dd>
                        Every statement of every session passes through <code>PREPROC_RT.MASTER</code> before Exasol parses it. The dispatcher sends
                        semantic SQL on <code>CREDORA_SEM</code> to the Semantic Views compiler for your role, and applies the rewrite rules of{" "}
                        <Ext id="preprocessor-library" />.
                      </dd>
                    </div>
                  </dl>
                )}
              </SectionBody>
              <div className="cr-conns">
                <p className="cr-sub">
                  <Cable aria-hidden="true" />
                  <WithExplain id="connection-object">Connections</WithExplain>
                  <span className="muted small">Names only. Addresses and secrets never leave Exasol.</span>
                </p>
                <SectionBody s={cr.connections} who={cr.exasol_user} what="the connection list">
                  {(d) => (
                    <ul className="cr-conn-list">
                      {d.map((c) => (
                        <li key={c.name}>
                          <code>{c.name}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionBody>
              </div>
            </Panel>
          </div>

          {cr.sessions && (
            <Panel
              title={<WithExplain id="sessions">Sessions right now</WithExplain>}
              icon={Users}
              flush
              aside={<span className="muted small">EXA_DBA_SESSIONS · admin only</span>}
            >
              <SectionBody s={cr.sessions} who={cr.exasol_user} what="EXA_DBA_SESSIONS">
                {(d) => (
                  <div className="table-wrap table-wrap-tall">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Client</th>
                          <th>Status</th>
                          <th>
                            <WithExplain id="consumer-group">Consumer group</WithExplain>
                          </th>
                          <th className="r">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.map((s) => (
                          <tr key={s.session_id}>
                            <td>
                              <code>{s.user}</code>
                            </td>
                            <td>
                              <code className="cr-client">{s.client}</code>
                              <div className="muted small">{s.driver}</div>
                            </td>
                            <td className="nowrap">
                              {s.status}
                              {s.command && s.command !== "NOT SPECIFIED" && <span className="muted"> · {s.command}</span>}
                            </td>
                            <td>{s.consumer_group ? <code>{s.consumer_group}</code> : <span className="muted">–</span>}</td>
                            <td className="r num">{s.duration}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionBody>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
