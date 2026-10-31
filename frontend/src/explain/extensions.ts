// The Exasol open-source projects behind each part of the database (README section 14).

export interface Extension {
  id: string;
  name: string;
  repo: string;
  what: string;
}

export const EXTENSIONS: Record<string, Extension> = {
  "oracle-virtual-schema": {
    id: "oracle-virtual-schema",
    name: "oracle-virtual-schema",
    repo: "https://github.com/exasol/oracle-virtual-schema",
    what: "VS_CBS, which reads Oracle core banking live with pushdown",
  },
  "adbc-vs-rs": {
    id: "adbc-vs-rs",
    name: "adbc-vs-rs",
    repo: "https://github.com/exasol-labs/adbc-vs-rs",
    what: "VS_CIF and VS_LOS, which read MySQL and PostgreSQL through ADBC with one Rust adapter",
  },
  "language-container-rs": {
    id: "language-container-rs",
    name: "language-container-rs",
    repo: "https://github.com/exasol-labs/language-container-rs",
    what: "The RUST script language container the adbc-vs-rs adapter runs in",
  },
  "script-languages-release": {
    id: "script-languages-release",
    name: "script-languages-release",
    repo: "https://github.com/exasol/script-languages-release",
    what: "The PYTHON3 and JAVA containers behind the 3rd party API, ML and AI UDFs",
  },
  "exasol-semantic-views": {
    id: "exasol-semantic-views",
    name: "exasol-semantic-views",
    repo: "https://github.com/exasol-labs/exasol-semantic-views",
    what: "CREDORA_SEM.PORTFOLIO and its certified metrics",
  },
  "preprocessor-framework": {
    id: "preprocessor-framework",
    name: "preprocessor-framework",
    repo: "https://github.com/exasol-labs/preprocessor-framework",
    what: "Owns the SQL preprocessor slot (PREPROC_RT.MASTER) and routes semantic SQL per role",
  },
  "preprocessor-library": {
    id: "preprocessor-library",
    name: "preprocessor-library",
    repo: "https://github.com/exasol-labs/preprocessor-library",
    what: "Ready-made rewrite rules plugged into the framework (CAST shorthand, trailing commas, control sugar)",
  },
  "mcp-server": {
    id: "mcp-server",
    name: "mcp-server",
    repo: "https://github.com/exasol/mcp-server",
    what: "exasol-mcp-server 2.3.0, through which Ask Credora queries Exasol as your role's user",
  },
  "exasol-scheduler": {
    id: "exasol-scheduler",
    name: "exasol-scheduler",
    repo: "https://github.com/exasol-labs/exasol-scheduler",
    what: "SCHED, which runs CREDORA.PURGE_EXPIRED on a timetable inside Exasol",
  },
  "exasol-personal": {
    id: "exasol-personal",
    name: "exasol-personal",
    repo: "https://github.com/exasol/exasol-personal",
    what: "Exasol Personal and its launcher, which run the database itself on AWS EC2",
  },
  pyexasol: {
    id: "pyexasol",
    name: "pyexasol",
    repo: "https://github.com/exasol/pyexasol",
    what: "The Python driver every console statement goes through",
  },
};

/** Which project stands behind a schema of the database. */
export const SCHEMA_EXTENSION: Record<string, string[]> = {
  VS_CBS: ["oracle-virtual-schema"],
  ADAPTER: ["oracle-virtual-schema"],
  VS_CIF: ["adbc-vs-rs", "language-container-rs"],
  VS_LOS: ["adbc-vs-rs", "language-container-rs"],
  ADBC_VS: ["adbc-vs-rs", "language-container-rs"],
  CREDORA_SEM: ["exasol-semantic-views"],
  SEMANTIC_ADMIN: ["exasol-semantic-views"],
  SEMANTIC_AGENT: ["exasol-semantic-views"],
  SEMANTIC_CATALOG: ["exasol-semantic-views"],
  SEMANTIC_SOURCE: ["exasol-semantic-views"],
  SYS_SEMANTIC: ["exasol-semantic-views"],
  PREPROC: ["preprocessor-framework"],
  PREPROC_RT: ["preprocessor-framework", "preprocessor-library"],
  SCHED: ["exasol-scheduler"],
};
