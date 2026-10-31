-- Sapphire Bank customer master (MySQL, database cif).
-- Safe to run repeatedly; the generator truncates the tables before loading.

CREATE DATABASE IF NOT EXISTS cif CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS cif.rm (
  rm_id        VARCHAR(6) PRIMARY KEY,
  name         VARCHAR(60) NOT NULL,
  branch       VARCHAR(40) NOT NULL
);

CREATE TABLE IF NOT EXISTS cif.company (
  cif_id             VARCHAR(8)  PRIMARY KEY,
  legal_name         VARCHAR(120) NOT NULL,
  constitution       VARCHAR(30) NOT NULL,
  pan                CHAR(10)    NOT NULL,
  gstin              CHAR(15)    NOT NULL,
  incorporated_on    DATE        NOT NULL,
  industry           VARCHAR(40) NOT NULL,
  city               VARCHAR(40) NOT NULL,
  state              VARCHAR(30) NOT NULL,
  rm_id              VARCHAR(6)  NOT NULL,
  kyc_status         VARCHAR(10) NOT NULL,
  kyc_expiry         DATE        NOT NULL,
  customer_since     DATE        NOT NULL,
  INDEX company_rm_ix (rm_id)
);

CREATE TABLE IF NOT EXISTS cif.partner (
  partner_id         VARCHAR(8)  PRIMARY KEY,
  cif_id             VARCHAR(8)  NOT NULL,
  name               VARCHAR(80) NOT NULL,
  pan                CHAR(10)    NOT NULL,
  dob                DATE        NOT NULL,
  gender             CHAR(1)     NOT NULL,
  role               VARCHAR(20) NOT NULL,
  share_pct          DECIMAL(5,2) NOT NULL,
  city               VARCHAR(40) NOT NULL,
  sapphire_customer  TINYINT(1)  NOT NULL,
  INDEX partner_cif_ix (cif_id)
);

-- Exasol's MySQL virtual schema (adbc-vs-rs) leaves out TINYINT(1) (boolean) columns,
-- so this view exposes the flag as a plain number.
CREATE OR REPLACE VIEW cif.partner_profile AS
SELECT partner_id, cif_id, name, pan, dob, gender, role, share_pct, city,
       sapphire_customer + 0 AS sapphire_flag
FROM cif.partner;
