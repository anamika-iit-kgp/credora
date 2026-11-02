-- Pricing reference tables read by the decision logic (exasol/lua/06_run_analysis.sql) and
-- explained in docs/PRICING.md. Both are seeded once, as CREDORA.CONFIG is: a row that already
-- exists keeps its value, so a figure changed on a live deployment survives the next deploy.
--
-- The figures are illustrative. They stand in for the margin and recovery assumptions a bank
-- keeps in its credit policy, and nothing here is calibrated on real portfolios.

-- Operating cash margin per industry, as % of 12 month GST turnover. The decision logic takes
-- it as the cash a company has for debt service (DSCR feature, offer size, negotiation limit)
-- in place of a flat 12% for every industry. An industry missing here gets CONFIG
-- CASH_MARGIN_DEFAULT_PCT. The industries are the ones the mock data generator produces
-- (mocks/generator/generator/reference.py), which also holds these figures for the past loans.
CREATE TABLE IF NOT EXISTS CREDORA.INDUSTRY_MARGIN (
  INDUSTRY        VARCHAR(40) PRIMARY KEY,
  CASH_MARGIN_PCT DECIMAL(5,2) NOT NULL,
  NOTE            VARCHAR(200)
);

MERGE INTO CREDORA.INDUSTRY_MARGIN m USING (
  SELECT 'Textiles' i, 9.00 v, 'Thin margins, working capital heavy, illustrative' n FROM DUAL UNION ALL
  SELECT 'Pharmaceuticals', 18.00, 'Formulations and bulk drugs, illustrative' FROM DUAL UNION ALL
  SELECT 'Auto Components', 12.00, 'Tier 2 and tier 3 suppliers, illustrative' FROM DUAL UNION ALL
  SELECT 'Food Processing', 8.00, 'Commodity inputs, seasonal, illustrative' FROM DUAL UNION ALL
  SELECT 'Chemicals', 15.00, 'Specialty and intermediates, illustrative' FROM DUAL UNION ALL
  SELECT 'Plastics & Polymers', 11.00, 'Conversion margins, illustrative' FROM DUAL UNION ALL
  SELECT 'Engineering', 12.00, 'Fabrication and machine tools, illustrative' FROM DUAL UNION ALL
  SELECT 'IT Services', 20.00, 'People cost, little inventory, illustrative' FROM DUAL UNION ALL
  SELECT 'Construction', 10.00, 'Contract work, lumpy cash flow, illustrative' FROM DUAL UNION ALL
  SELECT 'Logistics', 9.00, 'Fleet and fuel heavy, illustrative' FROM DUAL UNION ALL
  SELECT 'Agro Products', 6.00, 'Commodity trading and milling, illustrative' FROM DUAL UNION ALL
  SELECT 'Steel & Metals', 10.00, 'Cyclical, illustrative' FROM DUAL UNION ALL
  SELECT 'Electronics', 10.00, 'Assembly and components, illustrative' FROM DUAL UNION ALL
  SELECT 'Hospitality', 22.00, 'Hotels and resorts, high fixed cost, illustrative' FROM DUAL UNION ALL
  SELECT 'Retail Trade', 5.00, 'Distribution and retail, illustrative' FROM DUAL UNION ALL
  SELECT 'Gems & Jewellery', 5.00, 'High value stock, thin margins, illustrative' FROM DUAL UNION ALL
  SELECT 'Paper & Packaging', 12.00, 'Mills and corrugators, illustrative' FROM DUAL UNION ALL
  SELECT 'Healthcare', 18.00, 'Hospitals and diagnostics, illustrative' FROM DUAL
) s ON m.INDUSTRY = s.i
WHEN NOT MATCHED THEN INSERT VALUES (s.i, s.v, s.n);

-- Loss given default per collateral type, %. The decision logic blends it with the policy LGD
-- (CONFIG LGD_PCT, the unsecured figure) by the share of the credit need the collateral covers,
-- so collateral lowers the expected loss, the floor ROI and the capital charge, not only the
-- rate card. The figures follow the Basel II foundation IRB supervisory LGDs in spirit (45% senior
-- unsecured, 35% receivables and real estate, 40% other physical collateral, financial collateral
-- treated as covered). A collateral type missing here counts as unsecured.
CREATE TABLE IF NOT EXISTS CREDORA.LGD_COLLATERAL (
  COLLATERAL_TYPE VARCHAR(30) PRIMARY KEY,
  LGD_PCT         DECIMAL(5,2) NOT NULL,
  BASIS           VARCHAR(200)
);

MERGE INTO CREDORA.LGD_COLLATERAL l USING (
  SELECT 'None' t, 45.00 v, 'Senior unsecured, Basel II foundation IRB supervisory LGD, illustrative' b FROM DUAL UNION ALL
  SELECT 'Receivables', 35.00, 'Eligible receivables, Basel II foundation IRB supervisory LGD, illustrative' FROM DUAL UNION ALL
  SELECT 'Property', 35.00, 'Commercial or residential real estate, Basel II foundation IRB supervisory LGD, illustrative' FROM DUAL UNION ALL
  SELECT 'Plant & machinery', 40.00, 'Other physical collateral, Basel II foundation IRB supervisory LGD, illustrative' FROM DUAL UNION ALL
  SELECT 'Fixed deposit', 0.00, 'Financial collateral, the covered part counts as recovered. Not produced by the mock data' FROM DUAL
) s ON l.COLLATERAL_TYPE = s.t
WHEN NOT MATCHED THEN INSERT VALUES (s.t, s.v, s.b);
