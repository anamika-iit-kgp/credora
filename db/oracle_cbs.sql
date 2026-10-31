-- Sapphire Bank core banking (Oracle, schema CBS).
-- Run as user CBS. The generator creates the user, runs these statements
-- (skipping objects that already exist) and truncates the tables before loading.

CREATE TABLE ACCOUNT (
  ACCOUNT_NO        VARCHAR2(14) PRIMARY KEY,
  OWNER_TYPE        VARCHAR2(8)  NOT NULL,
  OWNER_ID          VARCHAR2(12) NOT NULL,
  ACCT_TYPE         VARCHAR2(4)  NOT NULL,
  BRANCH            VARCHAR2(40),
  OPENED_ON         DATE NOT NULL,
  STATUS            VARCHAR2(8)  NOT NULL,
  OD_LIMIT          NUMBER(18,2) DEFAULT 0
);

CREATE TABLE TXN (
  TXN_ID            NUMBER(12)   PRIMARY KEY,
  ACCOUNT_NO        VARCHAR2(14) NOT NULL,
  TXN_DATE          DATE         NOT NULL,
  DR_CR             CHAR(1)      NOT NULL,
  AMOUNT            NUMBER(18,2) NOT NULL,
  CHANNEL           VARCHAR2(6)  NOT NULL,
  COUNTERPARTY      VARCHAR2(80),
  NARRATION         VARCHAR2(120),
  BALANCE_AFTER     NUMBER(18,2) NOT NULL,
  BOUNCED           CHAR(1) DEFAULT 'N' NOT NULL
);

CREATE INDEX ACCOUNT_OWNER_IX ON ACCOUNT (OWNER_ID);

CREATE INDEX TXN_ACCOUNT_IX ON TXN (ACCOUNT_NO, TXN_DATE);
