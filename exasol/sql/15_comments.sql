-- Plain-English meaning of every Credora schema, table, column and script, stored in Exasol itself
-- (COMMENT ON). The meanings follow docs/GLOSSARY.md and docs/DATA_MODEL.md. Any SQL client, the
-- EXA_ALL_* system tables and the Exasol MCP server's describe tools return them, so Ask Credora's
-- AI and a person in DbVisualizer read the same definitions.
--
-- Views are the exception. Exasol accepts a comment on a view only inside its CREATE VIEW (the
-- COMMENT IS clause after the query), never through COMMENT ON, so the views are described where
-- they are created. V_COMPANY_MASKED in exasol/sql/07_security.sql, V_SESSION_SCOPE and V_RM_* in
-- exasol/sql/13_rm_row_security.sql, V_LATEST_* in exasol/semantic/11_latest_run_views.sql. The
-- semantic view CREDORA_SEM.PORTFOLIO gets its comments from the semantic model (12_credora_model.sql).
--
-- Runs after every file that creates or replaces these objects (a replaced script loses its
-- comment), so the deploy tool applies it last. Re-running it is safe.

COMMENT ON SCHEMA CREDORA IS 'Credora results inside Exasol. The analysis of Sapphire Bank''s corporate customers (decisions, features, scores, models, run log, policy), the hand-off to relationship managers, and the purge proof. Read per role, see exasol/sql/07_security.sql.';
COMMENT ON SCHEMA CREDORA_STAGE IS 'Raw replies from the 3rd party APIs (CIBIL, GSTN, Account Aggregator) and core-banking monthly aggregates, staged by RUN_ANALYSIS. Consent-based rows carry PURGE_AT and are deleted on time by CREDORA.PURGE_EXPIRED, run by the Exasol Scheduler.';

-- ---------------------------------------------------------------- policy and run control

COMMENT ON TABLE CREDORA.CONFIG IS 'Policy knobs of the decision logic (rates, hurdle, caps, coverage, anomaly share). Changed only through an approved policy proposal.' (
  CONFIG_KEY IS 'Name of the policy knob, e.g. HURDLE_PCT',
  CONFIG_VALUE IS 'Current value of the knob (percent values are in %, not fractions)',
  DESCRIPTION IS 'What the knob means, in plain words'
);

COMMENT ON TABLE CREDORA.RUN_LOG IS 'One row per step of each analysis run (RUN_ANALYSIS commits each step as it finishes), with what ran, how many rows and how long.' (
  RUN_ID IS 'Analysis run id, R + IST date and time, e.g. R20261031-1530',
  STEP_NO IS 'Step number within the run (1 = refresh the virtual schemas)',
  STEP_NAME IS 'What the step did, in plain words',
  STATUS IS 'OK or FAILED',
  ROWS_OUT IS 'Rows the step produced',
  MS IS 'Duration of the step in milliseconds',
  DETAIL IS 'Error message of a failed step, or extra detail',
  LOGGED_AT IS 'When the step finished (database time zone)'
);

COMMENT ON TABLE CREDORA.RUN_PUBLISH IS 'Runs the data scientist published to loan operations. A run without a row here is a draft. The latest published run is the official one.' (
  RUN_ID IS 'The published analysis run',
  PUBLISHED_BY IS 'App user who published it (or the system, for an approved policy proposal)',
  PUBLISHED_AT IS 'When it was published',
  NOTE IS 'Publisher''s note'
);

-- ---------------------------------------------------------------- the analysis

COMMENT ON TABLE CREDORA.APPLICATIONS IS 'One row per company per run, with the company''s credit need on file (PostgreSQL loan origination, VS_LOS) joined with the customer master (MySQL, VS_CIF). These are the companies analysed in the run.' (
  RUN_ID IS 'Analysis run id',
  APP_ID IS 'Id of the company''s credit need on file in loan origination. Keys the company within a run',
  CIF_ID IS 'Customer id of the company in the customer master and core banking',
  LEGAL_NAME IS 'Legal name of the company',
  CONSTITUTION IS 'Legal form, one of proprietorship, partnership, LLP, private limited',
  PAN IS 'Company PAN (tax id), full. RM and AI roles see it masked or only for assigned companies',
  GSTIN IS 'Company GST registration number, full',
  INDUSTRY IS 'Industry of the company',
  CITY IS 'City of the registered office',
  STATE_NAME IS 'Indian state of the registered office',
  RM_ID IS 'Relationship manager who owns the customer in the customer master',
  KYC_STATUS IS 'KYC status in the customer master, VERIFIED, EXPIRED or PENDING. Anything but VERIFIED gives REFER',
  APPLIED_ON IS 'Date the credit need was recorded, and the as-of date of every feature',
  PRODUCT IS 'WC = working capital, TL = term loan',
  AMOUNT_REQUESTED IS 'Indicated need on file, INR',
  TENURE_REQUESTED IS 'Indicated tenure on file, months',
  PURPOSE IS 'Stated purpose of the credit need',
  COLLATERAL_TYPE IS 'Collateral offered, if any',
  COLLATERAL_VALUE IS 'Value of that collateral, INR',
  PARTNERS IS 'Number of partners or directors'
);

COMMENT ON TABLE CREDORA.FEATURES IS 'The thirteen credit features per company per run, computed in Exasol from core banking (VS_CBS, pushdown), GST, CIBIL and Account Aggregator data. Definitions are in docs/DATA_MODEL.md section 8.' (
  RUN_ID IS 'Analysis run id',
  APP_ID IS 'Company key within the run',
  CIF_ID IS 'Customer id of the company',
  GST_YEARS IS 'Years since GST registration, 1 decimal',
  GST_TURNOVER_12M IS 'Turnover declared in the last 12 GST returns (GSTR-1), INR',
  GST_LATE_FILINGS_12M IS 'GST returns filed late or missed among the last 12. NULL when no GST returns are on file, which gives REFER, not DECLINE',
  GST_BANK_GAP_PCT IS 'Gap between GST turnover and current-account credits over 12 months, % of GST turnover. A large gap hints at inflated turnover',
  AVG_BALANCE_12M IS 'Average current-account balance over 12 months, INR',
  INFLOW_VOLATILITY IS 'Standard deviation / mean of the 12 monthly current-account credit totals',
  BOUNCE_RATIO IS 'Bounced debits / all debits on the current account over 12 months',
  CMR_RANK IS 'CIBIL commercial rank of the company, 1 best to 10 worst',
  PARTNER_MIN_SCORE IS 'Lowest CIBIL consumer score among the partners (no history counts as 650)',
  PARTNER_AVG_SCORE IS 'Average CIBIL consumer score of the partners',
  PARTNER_OVERDUE_AMT IS 'Overdue amount on all partners'' credit accounts, INR',
  PARTNER_OTHER_BANK_BAL IS 'Partners'' balances at other banks, from the Account Aggregator, INR',
  DSCR IS 'Debt service coverage ratio at the indicated need (cash available / debt service)',
  BANK_CREDITS_12M IS 'Current-account credits over 12 months, INR',
  WILFUL_DEFAULT IS 'CIBIL marks the company a wilful defaulter',
  SUIT_FILED IS 'A lender has filed a recovery suit against the company',
  GST_STAGE IS 'Company stage from its GST history, New, Mid-level or Stable'
);

COMMENT ON TABLE CREDORA.SCORES IS 'Probability of default per company per run from the active champion model (PD_SCORE UDF), with the effect of each feature.' (
  RUN_ID IS 'Analysis run id',
  APP_ID IS 'Company key within the run',
  MODEL_VERSION IS 'Model that scored it (MODEL_REGISTRY)',
  PD IS 'Probability of default within 12 months, 0..1',
  GRADE IS 'Risk grade from the PD, A1 best',
  CONTRIBUTIONS IS 'JSON of feature -> change in PD it caused'
);

COMMENT ON TABLE CREDORA.CHALLENGER_SCORES IS 'Champion/challenger, shadow only. What the challenger scorecard would have scored and decided for each company. Never read by the decision step.' (
  RUN_ID IS 'Analysis run id',
  APP_ID IS 'Company key within the run',
  MODEL_VERSION IS 'The challenger model (v<n>-lr)',
  PD IS 'Challenger probability of default, 0..1',
  GRADE IS 'Challenger risk grade',
  DECISION IS 'Decision the challenger would have given, APPROVE, REFER or DECLINE'
);

COMMENT ON TABLE CREDORA.ANOMALY IS 'Isolation Forest anomaly check per company per run (ANOMALY_FLAG UDF). A flagged company is referred for review, never declined on the flag.' (
  RUN_ID IS 'Analysis run id',
  APP_ID IS 'Company key within the run',
  SCORE IS 'Anomaly score, higher = more unusual',
  IS_ANOMALY IS 'Flagged as among the most unusual share set by CONFIG ANOMALY_CONTAMINATION_PCT (about 3%)',
  TOP_REASONS IS 'The figures that stand out, e.g. GST turnover far from bank credits'
);

COMMENT ON TABLE CREDORA.DECISIONS IS 'The result. One row per company per run with the decision, the pre-approved offer and the negotiation limit, and the rank. Declined companies have no offer.' (
  RUN_ID IS 'Analysis run id',
  APP_ID IS 'Company key within the run',
  CIF_ID IS 'Customer id of the company',
  LEGAL_NAME IS 'Legal name of the company',
  RM_ID IS 'Relationship manager who owns the customer in the customer master (RM_ASSIGNMENT says who works it now)',
  PRODUCT IS 'WC = working capital, TL = term loan',
  AMOUNT_REQUESTED IS 'Indicated need on file, INR',
  TENURE_REQUESTED IS 'Indicated tenure on file, months',
  DECISION IS 'APPROVE = pre-approved offer, REFER = offer after credit committee review, DECLINE = no offer',
  HARD_FAILS IS 'Policy rules that failed, separated by semicolons (for example GST filing, CIBIL, wilful default), and the reasons for a referral (KYC, no GST returns on file, hurdle above the rate card, or an Anomaly reason)',
  GRADE IS 'Risk grade, A1 best',
  PD IS 'Probability of default, 0..1',
  OFFER_AMOUNT IS 'Pre-approved amount, INR',
  OFFER_ROI IS 'Offered rate of interest, % p.a.',
  OFFER_TENURE IS 'Offered tenure, months',
  FLOOR_ROI IS 'Lowest rate the relationship manager may agree in negotiation, % p.a.',
  MAX_AMOUNT IS 'Highest amount the relationship manager may agree, INR',
  MAX_TENURE IS 'Longest tenure the relationship manager may agree, months',
  RAROC_OFFER IS 'Risk-adjusted return on capital at the offer, %',
  RAROC_FLOOR IS 'Risk-adjusted return on capital at the negotiation limit, % (still meets the hurdle)',
  RANK_NO IS 'Portfolio rank from the PREFERRING skyline, 1 = best',
  SKYLINE_LAYER IS 'Skyline layer, where 1 = not beaten on return, risk and size by any other company',
  TOP50 IS 'Among the 50 best-ranked offers handed to relationship managers',
  DECIDED_AT IS 'When the decision was written'
);

COMMENT ON TABLE CREDORA.MODEL_REGISTRY IS 'Risk models trained inside Exasol by TRAIN_MODEL and saved in BucketFS. Each training adds the champion v<n> and the challenger v<n>-lr, measured on the same hold-out.' (
  MODEL_VERSION IS 'v<n> = gradient-boosted trees, v<n>-lr = logistic regression scorecard',
  TRAINED_AT IS 'When the model was trained',
  ALGORITHM IS 'Model type',
  AUC IS 'Area under the ROC curve on the 25% hold-out, 0.5 = chance, 1 = perfect',
  GINI IS 'Gini = 2 x AUC - 1',
  N_TRAIN IS 'Past loans used for training',
  DEFAULT_RATE IS 'Share of those past loans that defaulted',
  FEATURE_IMPORTANCE IS 'JSON of permutation importance (trees) or signed coefficients per standard deviation (scorecard)',
  MODEL_PATH IS 'BucketFS path of the pickled model',
  IS_ACTIVE IS 'The champion that decides. Changes only after the admin approves an activation request',
  MODEL_SHA256 IS 'SHA-256 of the pickled model file. PD_SCORE checks the file against it before loading'
);

COMMENT ON TABLE CREDORA.MEMOS IS 'Credit memos written by Claude through the CREDIT_MEMO UDF (or the backend).' (
  RUN_ID IS 'Analysis run the memo describes',
  CIF_ID IS 'Customer id of the company',
  MODEL IS '<AI model>|<engine>. Engine exasol-udf means it was written inside Exasol',
  MEMO IS 'The memo text',
  CREATED_AT IS 'When it was written'
);

COMMENT ON TABLE CREDORA.PURGE_LOG IS 'Proof of deletion. What PURGE_EXPIRED deleted, when, and a SHA-256 fingerprint of the deleted content, so an auditor can confirm it without the data.' (
  PURGED_AT IS 'When the rows were deleted',
  TABLE_NAME IS 'Staging table the rows came from',
  RUN_ID IS 'Analysis run that fetched them',
  ROWS_DELETED IS 'How many rows were deleted',
  SHA256 IS 'SHA-256 fingerprint of the deleted rows'' key fields. The rows are sorted by key and cut into chunks of 1,000, each chunk is hashed, and this is the hash of the chunk hashes in order'
);

-- ---------------------------------------------------------------- the hand-off

COMMENT ON TABLE CREDORA.RM_ASSIGNMENT IS 'Which relationship manager works which company, set by loan operations. The RM views filter on EXA_USER = CURRENT_USER with the _AI suffix of an AI session user stripped, so Exasol returns each manager, and her AI session user, only her own companies.' (
  CIF_ID IS 'Customer id of the company',
  RM_ID IS 'Relationship manager it is assigned to',
  EXA_USER IS 'Exasol user of that relationship manager (row-level security key)',
  ASSIGNED_BY IS 'App user who assigned it',
  ASSIGNED_AT IS 'When it was assigned'
);

COMMENT ON TABLE CREDORA.LOAN_STATUS_LOG IS 'Loan status history the relationship managers log per company. The newest row per company is its current status.' (
  EVENT_ID IS 'Event id',
  CIF_ID IS 'Customer id of the company',
  RM_ID IS 'Relationship manager who logged it',
  STATUS IS 'ASSIGNED, CONTACTED, NEGOTIATING, LOAN_TAKEN, IN_PROGRESS, DISBURSED or NOT_INTERESTED',
  NOTE IS 'Free-text note',
  LOGGED_BY IS 'App user who logged it',
  LOGGED_AT IS 'When it was logged'
);

-- ---------------------------------------------------------------- staged 3rd party data

COMMENT ON TABLE CREDORA_STAGE.CA_MONTHLY IS 'Company current-account activity per month, aggregated inside Oracle through VS_CBS (with pushdown, about 850,000 transactions never leave the bank''s database).' (
  ACCOUNT_NO IS 'Core-banking account number',
  CIF_ID IS 'Customer id of the company',
  MON IS 'First day of the month',
  CREDITS IS 'Sum of credits in the month, INR',
  DEBITS IS 'Number of debits in the month',
  BOUNCES IS 'Number of bounced debits in the month',
  BAL_SUM IS 'Sum of balances after each transaction (for the average balance), INR',
  N IS 'Number of transactions in the month'
);

COMMENT ON TABLE CREDORA_STAGE.CIBIL_CONSUMER IS 'CIBIL consumer credit report per partner, fetched by CIBIL_CONSUMER_FETCH and deleted at PURGE_AT.' (
  RUN_ID IS 'Analysis run that fetched it',
  PAN IS 'Partner PAN',
  NAME IS 'Partner name',
  SCORE IS 'CIBIL score 300..900, -1 = no credit history',
  ENQUIRIES_6M IS 'Credit enquiries in the last 6 months',
  ENQUIRIES_12M IS 'Credit enquiries in the last 12 months',
  ACCOUNTS IS 'Credit accounts on file',
  ACTIVE_ACCOUNTS IS 'Open credit accounts',
  TOTAL_SANCTIONED IS 'Total sanctioned on all accounts, INR',
  TOTAL_BALANCE IS 'Total outstanding, INR',
  TOTAL_OVERDUE IS 'Total overdue, INR',
  MAX_DPD_12M IS 'Worst days past due in the last 12 months',
  MAX_DPD_36M IS 'Worst days past due in the last 36 months',
  WRITTEN_OFF IS 'Accounts written off',
  FETCHED_AT IS 'When Exasol fetched it',
  PURGE_AT IS 'When it must be deleted (consent and retention). PURGE_EXPIRED deletes it then',
  RAW_JSON IS 'The relay''s reply as received'
);

COMMENT ON TABLE CREDORA_STAGE.CIBIL_COMMERCIAL IS 'CIBIL commercial credit report per company, fetched by CIBIL_COMMERCIAL_FETCH and deleted at PURGE_AT.' (
  RUN_ID IS 'Analysis run that fetched it',
  PAN IS 'Company PAN',
  NAME IS 'Company name',
  CMR_RANK IS 'CIBIL commercial rank, 1 best to 10 worst',
  TOTAL_EXPOSURE IS 'Total credit exposure, INR',
  OVERDUE IS 'Overdue amount, INR',
  SUIT_FILED IS 'A lender has filed a recovery suit',
  WILFUL_DEFAULT IS 'Marked a wilful defaulter',
  FACILITIES IS 'Credit facilities on file',
  FETCHED_AT IS 'When Exasol fetched it',
  PURGE_AT IS 'When it must be deleted. PURGE_EXPIRED deletes it then',
  RAW_JSON IS 'The relay''s reply as received'
);

COMMENT ON TABLE CREDORA_STAGE.GST_FILING IS 'Monthly GST returns per company from the GSTN relay, fetched by GST_FETCH and deleted at PURGE_AT.' (
  RUN_ID IS 'Analysis run that fetched it',
  GSTIN IS 'Company GST registration number',
  LEGAL_NAME IS 'Legal name on the GST registration',
  PAN IS 'Company PAN',
  STATE_NAME IS 'State of the GST registration',
  REGISTERED_ON IS 'GST registration date',
  REG_STATUS IS 'Registration status, e.g. Active',
  STAGE IS 'Company stage from its GST history, New, Mid-level or Stable',
  GST_PERIOD IS 'Return period, YYYY-MM',
  GSTR1_TURNOVER IS 'Turnover declared in GSTR-1, INR (NULL if not filed)',
  GSTR3B_TAX_PAID IS 'Tax paid with GSTR-3B, INR',
  DUE_DATE IS 'Filing due date',
  FILED_ON IS 'Date filed, NULL if not filed',
  DELAY_DAYS IS 'Days filed after the due date',
  FETCHED_AT IS 'When Exasol fetched it',
  PURGE_AT IS 'When it must be deleted. PURGE_EXPIRED deletes it then'
);

COMMENT ON TABLE CREDORA_STAGE.AA_ACCOUNT IS 'Partners'' and companies'' accounts at other banks, shared with consent through the Account Aggregator and fetched by AA_FETCH, and deleted at PURGE_AT.' (
  RUN_ID IS 'Analysis run that fetched it',
  PAN IS 'PAN of the account owner',
  CONSENT_ID IS 'Account Aggregator consent id',
  CONSENT_EXPIRES IS 'When the consent expires',
  AA_ACCOUNT_ID IS 'Account id at the Account Aggregator',
  FIP IS 'Financial information provider, the other bank',
  ACCT_TYPE IS 'Account type, e.g. SAVINGS, CURRENT',
  MASKED_NO IS 'Masked account number',
  OPENED_ON IS 'Date the account was opened',
  CURRENT_BALANCE IS 'Current balance, INR',
  TXN_COUNT IS 'Transactions in the last 12 months',
  CREDITS_12M IS 'Credits in the last 12 months, INR',
  DEBITS_12M IS 'Debits in the last 12 months, INR',
  FETCHED_AT IS 'When Exasol fetched it',
  PURGE_AT IS 'When it must be deleted (consent end). PURGE_EXPIRED deletes it then'
);

-- ---------------------------------------------------------------- scripts and UDFs

COMMENT ON SCRIPT CREDORA.RUN_ANALYSIS IS 'Lua. The whole analysis as one call, EXECUTE SCRIPT CREDORA.RUN_ANALYSIS(''<run>''). It reads the bank in place, fetches 3rd party data via API, builds features, scores, flags, prices, ranks and shadow-scores, and logs and commits each step in RUN_LOG.';
COMMENT ON SCRIPT CREDORA.DECISION_LOGIC IS 'Lua. The decision SQL (hard fails, pricing, negotiation limit, RAROC) shared by the champion run and the challenger shadow run.';
COMMENT ON SCRIPT CREDORA.SCORE_CHALLENGER IS 'Lua. Shadow-scores a run with the challenger scorecard through the same decision SQL, into CHALLENGER_SCORES. Decides nothing.';
COMMENT ON SCRIPT CREDORA.TRAIN_MODEL IS 'Lua. Trains the champion (TRAIN_PD) and the challenger (TRAIN_SCORECARD) on past loans read through VS_LOS, on the same hold-out, and registers both in MODEL_REGISTRY.';
COMMENT ON SCRIPT CREDORA.PURGE_EXPIRED IS 'Lua. Deletes staged 3rd party data whose PURGE_AT has passed, one table per transaction, after writing row counts and a chunked SHA-256 fingerprint to PURGE_LOG. Skips while an analysis is in progress. Run every 15 minutes as CREDORA_SVC by the Exasol Scheduler container (task credora_purge_expired in SCHED.SCHED_TASKS).';
COMMENT ON SCRIPT CREDORA.CIBIL_CONSUMER_FETCH IS 'Python SET UDF. Fetches CIBIL consumer reports for partners from the CIBIL relay over HTTPS (CONNECTION MOCK_CIBIL), in 16 batches, 4 at a time, with 3 attempts per call.';
COMMENT ON SCRIPT CREDORA.CIBIL_COMMERCIAL_FETCH IS 'Python SET UDF. Fetches CIBIL commercial reports for companies from the CIBIL relay over HTTPS (CONNECTION MOCK_CIBIL), in 16 batches, 4 at a time, with 3 attempts per call.';
COMMENT ON SCRIPT CREDORA.GST_FETCH IS 'Python SET UDF. Fetches GST registrations and monthly returns from the GSTN relay over HTTPS (CONNECTION MOCK_GSTN), in 16 batches, 4 at a time, with 3 attempts per call.';
COMMENT ON SCRIPT CREDORA.AA_FETCH IS 'Python SET UDF. Fetches consented other-bank accounts from the Account Aggregator relay over HTTPS (CONNECTION MOCK_AA), in 16 batches, 4 at a time, with 3 attempts per call.';
COMMENT ON SCRIPT CREDORA.TRAIN_PD IS 'Python SET UDF. Trains the champion, a monotonic gradient-boosted PD model, and saves it to BucketFS.';
COMMENT ON SCRIPT CREDORA.TRAIN_SCORECARD IS 'Python SET UDF. Trains the challenger, a logistic regression scorecard on standardised features, on the same hold-out.';
COMMENT ON SCRIPT CREDORA.PD_SCORE IS 'Python SET UDF. Scores companies with a model from BucketFS after checking the file''s SHA-256 against MODEL_REGISTRY, giving probability of default, grade and feature contributions.';
COMMENT ON SCRIPT CREDORA.MODEL_FILE_SHA256 IS 'Python SCALAR UDF. SHA-256 of a model file in BucketFS, used once to fill MODEL_SHA256 for models trained before the check existed.';
COMMENT ON SCRIPT CREDORA.ANOMALY_FLAG IS 'Python SET UDF. Isolation Forest over all companies of a run. Flags the most unusual share for review, never for decline.';
COMMENT ON SCRIPT CREDORA.CREDIT_MEMO IS 'Python SCALAR UDF. Writes a credit memo for one company with Claude, through CONNECTION AI_LLM, and returns it as SQL output.';
