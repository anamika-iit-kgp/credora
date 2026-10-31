-- Sapphire Bank's three databases, read in place. No copy of the bank's data is made:
-- every query against these schemas is pushed down to the source database.

-- Oracle core banking: Exasol's Oracle virtual schema (Java, JDBC).
CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_CBS USING ADAPTER.ORACLE_ADAPTER WITH
  CONNECTION_NAME = 'ORA_CBS'
  SCHEMA_NAME     = 'CBS';

-- MySQL customer master: adbc-vs-rs (Rust, ADBC, Arrow).
CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_CIF USING ADBC_VS.ADBC_ADAPTER WITH
  DRIVER          = 'mysql'
  CONNECTION_NAME = 'MYSQL_CIF';

-- PostgreSQL loan origination: adbc-vs-rs.
CREATE VIRTUAL SCHEMA IF NOT EXISTS VS_LOS USING ADBC_VS.ADBC_ADAPTER WITH
  DRIVER          = 'postgresql'
  CONNECTION_NAME = 'PG_LOS';
