-- The Credora semantic model: certified portfolio metrics over the latest analysis run.
--
-- Built with exasol-labs/exasol-semantic-views. Published as the semantic view CREDORA_SEM.PORTFOLIO:
-- one row per company of the latest completed run (see 11_latest_run_views.sql), metrics as columns.
--
--   SELECT industry, approved_companies, pre_approved_amount
--   FROM CREDORA_SEM.PORTFOLIO GROUP BY industry ORDER BY pre_approved_amount DESC LIMIT 5;
--
-- Semantic SQL needs a session whose SQL preprocessor handles it. For the roles granted below the
-- preprocessor framework does that (exasol/extensions/10_semantic_views_module.sql); any other
-- session can run EXECUTE SCRIPT SEMANTIC_ADMIN.ENABLE_SEMANTIC_SQL() first.
--
-- The deploy tool drops and rebuilds the model on every run (deploy/exasol_setup.py), so this file
-- is the whole definition.

EXECUTE SCRIPT SEMANTIC_ADMIN.CREATE_MODEL('credora', 'CREDORA_SEM',
  'Sapphire Bank corporate lending. Credora''s pre-approved offer portfolio from the latest completed analysis run.',
  NULL);

-- Entities: one row per company (APP_ID) of the latest run in each view.
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_ENTITY('credora', 'company', 'CREDORA', 'V_LATEST_COMPANY', 'co', 'co.APP_ID',
  'One row per company in the latest completed analysis run',
  'An existing corporate customer of the bank as analysed (PAN and GSTIN are never exposed)');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_ENTITY('credora', 'decision', 'CREDORA', 'V_LATEST_DECISION', 'de', 'de.APP_ID',
  'One offer decision per company in the latest completed analysis run',
  'The offer decision: APPROVE (pre-approved offer), REFER (offer after credit committee review) or DECLINE (no offer)');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_ENTITY('credora', 'score', 'CREDORA', 'V_LATEST_SCORE', 'sc', 'sc.APP_ID',
  'One risk score per company in the latest completed analysis run',
  'Output of the risk model (probability of default)');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_ENTITY('credora', 'feature', 'CREDORA', 'V_LATEST_FEATURE', 'fe', 'fe.APP_ID',
  'One feature row per company in the latest completed analysis run',
  'Risk model inputs from CIBIL, GST and the Account Aggregator');

EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY('credora', 'company', 'company_pk', 'PRIMARY', 'One row per company', 'NATIVE');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY_COLUMN('credora', 'company', 'company_pk', 'APP_ID', NULL, 1);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY('credora', 'decision', 'decision_pk', 'PRIMARY', 'One row per company', 'NATIVE');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY_COLUMN('credora', 'decision', 'decision_pk', 'APP_ID', NULL, 1);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY('credora', 'score', 'score_pk', 'PRIMARY', 'One row per company', 'NATIVE');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY_COLUMN('credora', 'score', 'score_pk', 'APP_ID', NULL, 1);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY('credora', 'feature', 'feature_pk', 'PRIMARY', 'One row per company', 'NATIVE');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_UNIQUE_KEY_COLUMN('credora', 'feature', 'feature_pk', 'APP_ID', NULL, 1);

EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SEMANTIC_OBJECT('credora', 'PORTFOLIO', 'company',
  'Pre-approved offer portfolio of the latest completed analysis run: one row per company');

-- All four share the grain, so every join is one-to-one on APP_ID and no metric can fan out.
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_RELATIONSHIP('credora', 'company_to_decision', 'company', 'decision',
  'co.APP_ID = de.APP_ID', 'ONE_TO_ONE', 'LEFT', NULL);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_RELATIONSHIP_KEY_MAPPING('credora', 'company_to_decision', 'APP_ID', NULL, 'APP_ID', NULL, 1);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_RELATIONSHIP('credora', 'company_to_score', 'company', 'score',
  'co.APP_ID = sc.APP_ID', 'ONE_TO_ONE', 'LEFT', NULL);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_RELATIONSHIP_KEY_MAPPING('credora', 'company_to_score', 'APP_ID', NULL, 'APP_ID', NULL, 1);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_RELATIONSHIP('credora', 'company_to_feature', 'company', 'feature',
  'co.APP_ID = fe.APP_ID', 'ONE_TO_ONE', 'LEFT', NULL);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_RELATIONSHIP_KEY_MAPPING('credora', 'company_to_feature', 'APP_ID', NULL, 'APP_ID', NULL, 1);

-- Dimensions: company
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'cif_id', 'co.CIF_ID', 'VARCHAR(8)',
  'CIF', 'Customer id of the company in the core banking system', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'legal_name', 'co.LEGAL_NAME', 'VARCHAR(120)',
  'Company', 'Legal name of the company', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'industry', 'co.INDUSTRY', 'VARCHAR(40)',
  'Industry', 'Industry of the company', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'city', 'co.CITY', 'VARCHAR(40)',
  'City', 'City of the company''s registered office', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'state_name', 'co.STATE_NAME', 'VARCHAR(30)',
  'State', 'Indian state of the company''s registered office', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'rm_id', 'co.RM_ID', 'VARCHAR(6)',
  'Relationship manager', 'Id of the relationship manager who owns the company', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'product', 'co.PRODUCT', 'VARCHAR(4)',
  'Product', 'Product of the indicated need: WC working capital, TL term loan', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'constitution', 'co.CONSTITUTION', 'VARCHAR(30)',
  'Constitution', 'Legal form: Private Limited, Public Limited, Partnership, LLP', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'gst_stage', 'co.GST_STAGE', 'VARCHAR(12)',
  'GST stage', 'Company stage from its GST history: New, Mid-level or Stable', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'company', 'gst_years', 'co.GST_YEARS', 'DECIMAL(4,1)',
  'Years of GST history', 'Years since GST registration', NULL, TRUE);

-- Dimensions: decision and score
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'decision', 'decision', 'de.DECISION', 'VARCHAR(8)',
  'Decision', 'APPROVE = pre-approved offer, REFER = offer after credit committee review, DECLINE = no offer', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'decision', 'grade', 'de.GRADE', 'VARCHAR(3)',
  'Risk grade', 'Risk grade from the probability of default, A1 best', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'decision', 'top50', 'de.TOP50', 'BOOLEAN',
  'Top 50', 'TRUE for the 50 best offers of the run (PREFERRING skyline ranking)', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'decision', 'rank_no', 'de.RANK_NO', 'DECIMAL(5)',
  'Rank', 'Rank of the offer in the run, 1 = best; NULL without an offer', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'score', 'model_version', 'sc.MODEL_VERSION', 'VARCHAR(20)',
  'Model version', 'Risk model version that scored the company', NULL, TRUE);

-- Dimensions: risk model inputs
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'feature', 'cmr_rank', 'fe.CMR_RANK', 'DECIMAL(2)',
  'CMR rank', 'CIBIL commercial rank, 1 best to 10 worst', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'feature', 'gst_late_filings_12m', 'fe.GST_LATE_FILINGS_12M', 'DECIMAL(3)',
  'Late GST filings (12 months)', 'Late or missed GST returns in the last 12', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'feature', 'wilful_default', 'fe.WILFUL_DEFAULT', 'BOOLEAN',
  'Wilful defaulter', 'Company is on the wilful defaulter list (CIBIL)', NULL, TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_DIMENSION('credora', 'PORTFOLIO', 'feature', 'suit_filed', 'fe.SUIT_FILED', 'BOOLEAN',
  'Suit filed', 'A recovery suit is filed against the company (CIBIL)', NULL, TRUE);

-- Facts and metrics. Averages are ratios of sums, so they stay right at every grouping.
EXECUTE SCRIPT SEMANTIC_ADMIN.APPLY_SEMANTIC_DEFINITION(
  'ALTER SEMANTIC VIEW credora.PORTFOLIO
REPLACE FACTS (
  FACT company_count ON ENTITY decision AS 1 RETURNS DECIMAL(18,0) ADDITIVE
    DISPLAY ''Companies'' COMMENT ''One per company analysed'' PUBLIC CERTIFIED,
  FACT offered_count ON ENTITY decision AS CASE WHEN de.OFFER_AMOUNT IS NULL THEN 0 ELSE 1 END RETURNS DECIMAL(18,0) ADDITIVE
    DISPLAY ''Companies with an offer'' COMMENT ''One per company with an offer (APPROVE or REFER)'' PRIVATE,
  FACT offer_amount ON ENTITY decision AS de.OFFER_AMOUNT RETURNS DECIMAL(18,2) ADDITIVE
    DISPLAY ''Offer amount'' COMMENT ''Amount of the offer, INR; NULL when declined'' PUBLIC CERTIFIED,
  FACT headroom ON ENTITY decision AS de.MAX_AMOUNT - de.OFFER_AMOUNT RETURNS DECIMAL(18,2) ADDITIVE
    DISPLAY ''Negotiation headroom'' COMMENT ''Negotiation limit minus offer amount, INR'' PUBLIC CERTIFIED,
  FACT offer_roi ON ENTITY decision AS de.OFFER_ROI RETURNS DECIMAL(18,3) ADDITIVE
    DISPLAY ''Offer ROI'' COMMENT ''Interest rate of the offer, % p.a.'' PRIVATE,
  FACT floor_roi ON ENTITY decision AS de.FLOOR_ROI RETURNS DECIMAL(18,3) ADDITIVE
    DISPLAY ''Floor ROI'' COMMENT ''Lowest interest rate allowed in negotiation, % p.a.'' PRIVATE,
  FACT raroc_offer ON ENTITY decision AS de.RAROC_OFFER RETURNS DECIMAL(18,3) ADDITIVE
    DISPLAY ''RAROC at offer'' COMMENT ''Risk-adjusted return on capital at the offer, %'' PRIVATE,
  FACT pd ON ENTITY decision AS de.PD RETURNS DECIMAL(18,6) ADDITIVE
    DISPLAY ''PD'' COMMENT ''Probability of default, 0..1'' PRIVATE,
  FACT expected_loss_amount ON ENTITY decision AS CAST(de.PD * de.LGD_RATE * de.OFFER_AMOUNT AS DECIMAL(18,2)) RETURNS DECIMAL(18,2) ADDITIVE
    DISPLAY ''Expected loss'' COMMENT ''PD x LGD (policy CONFIG LGD_PCT, 45%) x offer amount, INR'' PUBLIC CERTIFIED,
  FACT anomaly_count ON ENTITY decision AS CASE WHEN REPLACE(de.HARD_FAILS, ''Anomaly:'', '''') <> de.HARD_FAILS THEN 1 ELSE 0 END RETURNS DECIMAL(18,0) ADDITIVE
    DISPLAY ''Anomaly flags'' COMMENT ''One per company the anomaly model flagged (reason text in the decision)'' PRIVATE
)
REPLACE METRICS (
  METRIC companies_analysed AS SUM(company_count) ON ENTITY decision RETURNS DECIMAL(18,0)
    FORMAT ''count'' DISPLAY ''Companies analysed'' COMMENT ''Companies in the latest completed analysis run''
    SYNONYMS (''companies'', ''customers analysed'', ''portfolio size'') ADDITIVE PUBLIC CERTIFIED,
  METRIC approved_companies AS SUM(company_count) ON ENTITY decision RETURNS DECIMAL(18,0)
    FILTER (WHERE decision = ''APPROVE'')
    FORMAT ''count'' DISPLAY ''Pre-approved companies'' COMMENT ''Companies with a pre-approved offer (decision APPROVE)''
    SYNONYMS (''approved'', ''pre-approved companies'', ''approvals'') ADDITIVE PUBLIC CERTIFIED,
  METRIC referred_companies AS SUM(company_count) ON ENTITY decision RETURNS DECIMAL(18,0)
    FILTER (WHERE decision = ''REFER'')
    FORMAT ''count'' DISPLAY ''Referred companies'' COMMENT ''Companies whose offer needs credit committee review (decision REFER)''
    SYNONYMS (''referred'', ''referrals'', ''credit committee'') ADDITIVE PUBLIC CERTIFIED,
  METRIC declined_companies AS SUM(company_count) ON ENTITY decision RETURNS DECIMAL(18,0)
    FILTER (WHERE decision = ''DECLINE'')
    FORMAT ''count'' DISPLAY ''Declined companies'' COMMENT ''Companies with no offer (decision DECLINE)''
    SYNONYMS (''declined'', ''declines'', ''no offer'') ADDITIVE PUBLIC CERTIFIED,
  METRIC approval_rate AS approved_companies / NULLIF(companies_analysed, 0) ON ENTITY decision RETURNS DOUBLE
    FORMAT ''percentage'' DISPLAY ''Approval rate'' COMMENT ''Pre-approved companies / companies analysed, 0..1''
    SYNONYMS (''approval ratio'', ''hit rate'') RATIO PUBLIC CERTIFIED,
  METRIC pre_approved_amount AS SUM(offer_amount) ON ENTITY decision RETURNS DECIMAL(18,2)
    FILTER (WHERE decision = ''APPROVE'')
    FORMAT ''currency'' DISPLAY ''Pre-approved amount'' COMMENT ''Sum of pre-approved offer amounts (APPROVE only), INR''
    SYNONYMS (''pre-approved book'', ''approved amount'', ''pre-approved limit'') ADDITIVE PUBLIC CERTIFIED,
  METRIC offered_amount AS SUM(offer_amount) ON ENTITY decision RETURNS DECIMAL(18,2)
    FORMAT ''currency'' DISPLAY ''Offered amount'' COMMENT ''Sum of all offer amounts, APPROVE and REFER, INR''
    SYNONYMS (''total offers'', ''pipeline'') ADDITIVE PUBLIC CERTIFIED,
  METRIC negotiation_headroom AS SUM(headroom) ON ENTITY decision RETURNS DECIMAL(18,2)
    FORMAT ''currency'' DISPLAY ''Negotiation headroom'' COMMENT ''Sum of negotiation limit minus offer amount over all offers, INR''
    SYNONYMS (''headroom'', ''negotiation room'') ADDITIVE PUBLIC CERTIFIED,
  METRIC offered_companies AS SUM(offered_count) ON ENTITY decision RETURNS DECIMAL(18,0)
    FORMAT ''count'' DISPLAY ''Companies with an offer'' COMMENT ''Companies with an offer, APPROVE or REFER'' ADDITIVE PUBLIC CERTIFIED,
  METRIC offer_roi_total AS SUM(offer_roi) ON ENTITY decision RETURNS DECIMAL(18,3)
    DISPLAY ''Offer ROI total'' COMMENT ''Helper for avg_offer_roi'' ADDITIVE PRIVATE,
  METRIC floor_roi_total AS SUM(floor_roi) ON ENTITY decision RETURNS DECIMAL(18,3)
    DISPLAY ''Floor ROI total'' COMMENT ''Helper for avg_floor_roi'' ADDITIVE PRIVATE,
  METRIC raroc_offer_total AS SUM(raroc_offer) ON ENTITY decision RETURNS DECIMAL(18,3)
    DISPLAY ''RAROC total'' COMMENT ''Helper for avg_raroc_offer'' ADDITIVE PRIVATE,
  METRIC pd_total AS SUM(pd) ON ENTITY decision RETURNS DECIMAL(18,6)
    DISPLAY ''PD total'' COMMENT ''Helper for avg_pd'' ADDITIVE PRIVATE,
  METRIC avg_offer_roi AS offer_roi_total / NULLIF(offered_companies, 0) ON ENTITY decision RETURNS DOUBLE
    FORMAT ''percent_pa'' DISPLAY ''Average offer ROI'' COMMENT ''Average interest rate of the offers (APPROVE and REFER), % p.a.''
    SYNONYMS (''average rate'', ''offer rate'', ''average ROI'') RATIO PUBLIC CERTIFIED,
  METRIC avg_floor_roi AS floor_roi_total / NULLIF(offered_companies, 0) ON ENTITY decision RETURNS DOUBLE
    FORMAT ''percent_pa'' DISPLAY ''Average floor ROI'' COMMENT ''Average lowest interest rate allowed in negotiation, over offers, % p.a.''
    SYNONYMS (''floor rate'', ''minimum rate'') RATIO PUBLIC CERTIFIED,
  METRIC avg_raroc_offer AS raroc_offer_total / NULLIF(offered_companies, 0) ON ENTITY decision RETURNS DOUBLE
    FORMAT ''percent'' DISPLAY ''Average RAROC at offer'' COMMENT ''Average risk-adjusted return on capital at the offer, over offers, %''
    SYNONYMS (''RAROC'', ''risk-adjusted return'') RATIO PUBLIC CERTIFIED,
  METRIC avg_pd AS pd_total / NULLIF(companies_analysed, 0) ON ENTITY decision RETURNS DOUBLE
    FORMAT ''percentage'' DISPLAY ''Average PD'' COMMENT ''Average probability of default over all companies analysed, 0..1''
    SYNONYMS (''probability of default'', ''default risk'', ''average risk'') RATIO PUBLIC CERTIFIED,
  METRIC expected_loss AS SUM(expected_loss_amount) ON ENTITY decision RETURNS DECIMAL(18,2)
    FORMAT ''currency'' DISPLAY ''Expected loss'' COMMENT ''Sum of PD x LGD x offer amount over all offers, INR''
    SYNONYMS (''EL'', ''expected credit loss'') ADDITIVE PUBLIC CERTIFIED,
  METRIC top50_amount AS SUM(offer_amount) ON ENTITY decision RETURNS DECIMAL(18,2)
    FILTER (WHERE top50 = TRUE)
    FORMAT ''currency'' DISPLAY ''Top 50 offer amount'' COMMENT ''Sum of offer amounts of the 50 best-ranked offers, INR''
    SYNONYMS (''top 50'', ''best offers amount'') ADDITIVE PUBLIC CERTIFIED,
  METRIC anomaly_flagged_companies AS SUM(anomaly_count) ON ENTITY decision RETURNS DECIMAL(18,0)
    FORMAT ''count'' DISPLAY ''Anomaly-flagged companies'' COMMENT ''Companies the Isolation Forest flagged as unusual (possible circular trading or inflated turnover); a flagged company is referred, never declined on it''
    SYNONYMS (''anomalies'', ''flagged companies'', ''circular trading'') ADDITIVE PUBLIC CERTIFIED
)',
  FALSE
);

EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SYNONYM('credora', 'DIMENSION', 'rm_id', 'relationship manager', 'MANUAL');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SYNONYM('credora', 'DIMENSION', 'industry', 'sector', 'MANUAL');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SYNONYM('credora', 'DIMENSION', 'state_name', 'state', 'MANUAL');
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_SYNONYM('credora', 'DIMENSION', 'legal_name', 'company name', 'MANUAL');

-- Guidance every agent reads with the model.
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_AGENT_INSTRUCTION('credora', 'MODEL', NULL, 'PRECONDITION',
  'Every row and metric is the latest completed analysis run only. For other runs, query CREDORA.DECISIONS by RUN_ID.', NULL, 10);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_AGENT_INSTRUCTION('credora', 'MODEL', NULL, 'STYLE',
  'Amounts are Indian rupees: write them in lakh (1 L = 100,000) or crore (1 cr = 10,000,000). approval_rate and avg_pd are ratios 0..1: show them as percentages. ROI and RAROC are already percentages.', NULL, 20);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_AGENT_INSTRUCTION('credora', 'MODEL', NULL, 'DEFINITION',
  'The bank does not process loan applications: it analyses its existing corporate customers and approaches the good ones with a pre-approved offer. Say company and pre-approved offer, never applicant or application.', NULL, 30);

-- Verified examples, the questions the model is known to answer.
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_VERIFIED_QUERY('credora', 'PORTFOLIO', 'portfolio_summary',
  'How many companies were analysed, approved, referred and declined, and what is the pre-approved amount?',
  '{"metrics": ["companies_analysed", "approved_companies", "referred_companies", "declined_companies", "approval_rate", "pre_approved_amount"]}',
  'One row', TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_VERIFIED_QUERY('credora', 'PORTFOLIO', 'pre_approved_by_industry',
  'Which industries have the largest pre-approved amount?',
  '{"metrics": ["pre_approved_amount", "approved_companies"], "dimensions": ["industry"], "order_by": [{"field": "pre_approved_amount", "direction": "desc"}], "limit": 5}',
  'Up to 5 rows, one per industry', TRUE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_VERIFIED_QUERY('credora', 'PORTFOLIO', 'risk_by_grade',
  'What is the average PD, offer ROI and expected loss per risk grade?',
  '{"metrics": ["companies_analysed", "avg_pd", "avg_offer_roi", "expected_loss"], "dimensions": ["grade"], "order_by": [{"field": "grade", "direction": "asc"}]}',
  'One row per grade', FALSE);
EXECUTE SCRIPT SEMANTIC_ADMIN.ADD_VERIFIED_QUERY('credora', 'PORTFOLIO', 'rm_headroom',
  'Which relationship managers have the most negotiation headroom?',
  '{"metrics": ["negotiation_headroom", "offered_companies"], "dimensions": ["rm_id"], "order_by": [{"field": "negotiation_headroom", "direction": "desc"}], "limit": 10}',
  'Up to 10 rows, one per relationship manager', FALSE);

EXECUTE SCRIPT SEMANTIC_ADMIN.SET_MODEL_GOVERNANCE_MODE('credora', 'GOVERNED');
EXECUTE SCRIPT SEMANTIC_ADMIN.VALIDATE_MODEL('credora');
EXECUTE SCRIPT SEMANTIC_ADMIN.PUBLISH_MODEL('credora');

-- Who may use the model. The compiled SQL reads the V_LATEST_* views with the caller's rights,
-- so the grants in 11_latest_run_views.sql decide what each role actually gets.
EXECUTE SCRIPT SEMANTIC_ADMIN.GRANT_MODEL_ROLE('credora', 'R_MCP');
EXECUTE SCRIPT SEMANTIC_ADMIN.GRANT_MODEL_ROLE('credora', 'R_ADMIN');
EXECUTE SCRIPT SEMANTIC_ADMIN.GRANT_MODEL_ROLE('credora', 'R_DATASCI');
EXECUTE SCRIPT SEMANTIC_ADMIN.GRANT_MODEL_ROLE('credora', 'R_LOANOPS');
EXECUTE SCRIPT SEMANTIC_ADMIN.GRANT_MODEL_ROLE('credora', 'R_RM');
