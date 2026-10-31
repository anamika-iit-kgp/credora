-- Connections to Sapphire Bank's databases, the mock APIs and BucketFS.
-- Placeholders like $${ORACLE_HOST} are filled in by the deploy tool from the deployment's runtime secret.

CREATE OR REPLACE CONNECTION ORA_CBS
  TO 'jdbc:oracle:thin:@//${ORACLE_HOST}:${ORACLE_PORT}/${ORACLE_SERVICE}'
  USER 'CREDORA_RO' IDENTIFIED BY '${ORACLE_RO_PASSWORD}';

CREATE OR REPLACE CONNECTION MYSQL_CIF
  TO 'mysql://${MYSQL_HOST}:${MYSQL_PORT}/cif'
  USER 'credora_ro' IDENTIFIED BY '${MYSQL_RO_PASSWORD}';

CREATE OR REPLACE CONNECTION PG_LOS
  TO 'postgresql://${PG_HOST}:${PG_PORT}/los'
  USER 'credora_ro' IDENTIFIED BY '${PG_RO_PASSWORD}';

-- The 3rd party data is fetched on demand via API, as from real services, through the
-- HTTPS relays cibil./gst./aa.<external domain> (or the app host's private address when
-- no external domain is configured).
CREATE OR REPLACE CONNECTION MOCK_CIBIL
  TO '${MOCK_CIBIL_URL}' USER 'api' IDENTIFIED BY '${MOCK_API_TOKEN}';

CREATE OR REPLACE CONNECTION MOCK_GSTN
  TO '${MOCK_GSTN_URL}' USER 'api' IDENTIFIED BY '${MOCK_API_TOKEN}';

CREATE OR REPLACE CONNECTION MOCK_AA
  TO '${MOCK_AA_URL}' USER 'api' IDENTIFIED BY '${MOCK_API_TOKEN}';

-- Lets the training UDF save model files to BucketFS.
CREATE OR REPLACE CONNECTION BUCKETFS_MODELS
  TO 'https://${EXASOL_PRIVATE_IP}:2581/default/models' USER 'w' IDENTIFIED BY '${BUCKETFS_WRITE_PASSWORD}';
