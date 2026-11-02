# How Credora prices a pre-approved offer

The whole rule runs as one SQL statement inside Exasol, `CREDORA.DECISION_LOGIC` in [`exasol/lua/06_run_analysis.sql`](../exasol/lua/06_run_analysis.sql), on the features and scores of a run. This page writes it out in plain English, with the reference tables it reads. Every figure below is illustrative and synthetic. Nothing is calibrated on a real portfolio.

## 1. The inputs

For each company analysed the rule has, from the run

- the credit need on file, with product (working capital or term loan), amount, tenure, industry, collateral type and collateral value (`CREDORA.APPLICATIONS`)
- 12 month GST turnover and the other features (`CREDORA.FEATURES`), including the company's exposure at all lenders from its CIBIL commercial report (`FEATURES.CIBIL_TOTAL_EXPOSURE`)
- the probability of default and the grade from the active risk model (`CREDORA.SCORES`)

and, from the policy

- the knobs in `CREDORA.CONFIG` (benchmark rate, spreads, cost of funds, operating cost, unsecured LGD, capital, hurdle, DSCR floors, GST share, the default cash margin and the exposure cap)
- the operating cash margin of the industry (`CREDORA.INDUSTRY_MARGIN`)
- the loss given default of the collateral type (`CREDORA.LGD_COLLATERAL`)

## 2. Cash available for debt service

Cash available in a year is the industry's operating cash margin applied to 12 month GST turnover.

```
CASH = GST_TURNOVER_12M x CASH_MARGIN_PCT / 100
```

`CASH_MARGIN_PCT` comes from `CREDORA.INDUSTRY_MARGIN` for the company's industry. An industry missing from the table gets `CONFIG CASH_MARGIN_DEFAULT_PCT` (12 percent, the single figure every industry had before 2.0.0). The same cash figure feeds the DSCR feature in step 7 of the run, so the risk model and the offer size see the same cash. The mock data generator uses the same margins for the DSCR of the past loans the model trains on (`mocks/generator/generator/reference.py`, kept in step by a test).

| Industry | Cash margin, % of GST turnover |
|---|---|
| Hospitality | 22 |
| IT Services | 20 |
| Pharmaceuticals | 18 |
| Healthcare | 18 |
| Chemicals | 15 |
| Auto Components | 12 |
| Engineering | 12 |
| Paper & Packaging | 12 |
| Plastics & Polymers | 11 |
| Construction | 10 |
| Steel & Metals | 10 |
| Electronics | 10 |
| Textiles | 9 |
| Logistics | 9 |
| Food Processing | 8 |
| Agro Products | 6 |
| Retail Trade | 5 |
| Gems & Jewellery | 5 |

The figures are illustrative operating cash margins for Indian mid-sized companies, seeded by [`exasol/sql/18_pricing_reference.sql`](../exasol/sql/18_pricing_reference.sql). A row that already exists on a deployment keeps its value when the file runs again, as `CONFIG` does, so a figure changed on a live deployment survives the next deploy.

## 3. Loss given default by collateral

The policy LGD (`CONFIG LGD_PCT`, 45 percent) is the unsecured figure. Collateral lowers it on the share of the credit need it covers.

```
COVER   = LEAST(COLLATERAL_VALUE / AMOUNT_REQUESTED, 1)
LGD_EFF = LGD_PCT + (LGD_COLLATERAL - LGD_PCT) x COVER
```

| Collateral type | LGD on the covered part, % | Basis |
|---|---|---|
| None | 45 | Senior unsecured, Basel II foundation IRB supervisory LGD |
| Receivables | 35 | Eligible receivables, Basel II foundation IRB |
| Property | 35 | Commercial or residential real estate, Basel II foundation IRB |
| Plant & machinery | 40 | Other physical collateral, Basel II foundation IRB |
| Fixed deposit | 0 | Financial collateral, the covered part counts as recovered. The mock data does not produce it |

A collateral type missing from the table counts as unsecured. The blend is a simplification of the foundation IRB treatment, which also sets minimum and full-recognition coverage levels, and the figures are illustrative. `LGD_EFF` is stored as `DECISIONS.LGD_PCT` and is what the floor ROI, both RAROC figures, the expected loss metric and the quote use. Before 2.0.0 collateral only took 0.25 percent off the rate card while the LGD stayed at 45 percent for everyone. The rate card discount stays.

## 4. Price

```
LIST_ROI  = EBLR_PCT + risk spread by grade + OPERATING_SPREAD_PCT - collateral discount
FLOOR_ROI = GREATEST(EBLR_PCT + FLOOR_MARGIN_PCT,
                     HURDLE_PCT x CAPITAL_PCT / 100 + FUNDS_COST_PCT + OPEX_PCT + PD x LGD_EFF)
            rounded up to the next 0.05
OFFER_ROI = GREATEST(LIST_ROI, FLOOR_ROI)
RAROC     = (ROI - FUNDS_COST_PCT - OPEX_PCT - PD x LGD_EFF) / CAPITAL_PCT x 100
```

The risk spread by grade is 1.00 percent for A1 up to 7.00 percent for D. The collateral discount is 0.25 percent when the collateral value covers the amount. The floor ROI is the lowest rate at which RAROC still meets the hurdle, and never below the benchmark plus the floor margin. RAROC is stored at the offer rate (`RAROC_OFFER`) and at the floor (`RAROC_FLOOR`).

## 5. Amount

The offer is the smallest of four amounts, rounded down to the lakh and never above the credit need on file.

1. The credit need on file.
2. What cash flow can repay at `MIN_DSCR` (1.25). For a term loan that is the loan whose EMI over the offered tenure at the offer rate equals `CASH / MIN_DSCR / 12`. For working capital it is `CASH / MIN_DSCR / (ROI / 100)`, interest only.
3. For working capital only, `MAX_GST_SHARE_PCT` (20 percent) of GST turnover.
4. The room under the total exposure cap.

```
EXPOSURE_ROOM = GREATEST(GST_TURNOVER_12M x MAX_EXPOSURE_PCT / 100 - CIBIL_TOTAL_EXPOSURE, 0)
```

The total exposure rule reads as follows. The company's exposure at all lenders, as its CIBIL commercial report states it, plus the offer stays within `MAX_EXPOSURE_PCT` of 12 month GST turnover (60 percent). A company with no commercial report counts as having no existing exposure. The negotiation limit (`MAX_AMOUNT`, at most 1.15 times the credit need and at `NEGOTIATION_DSCR` 1.10) respects the same room, so a relationship manager cannot negotiate past the cap. When the room, and not cash flow, is what pushes the offer below half the credit need, the referral reason reads `Existing exposure near the cap`.

Both the existing exposure and the room are stored with the decision (`DECISIONS.EXISTING_EXPOSURE`, `DECISIONS.EXPOSURE_ROOM`), as are the cash margin (`DECISIONS.CASH_MARGIN_PCT`) and the LGD (`DECISIONS.LGD_PCT`), so the report and the offer screens can show what the price rests on.

## 6. Decision

Unchanged by the pricing inputs. Any hard fail declines (wilful default, CMR rank 9 or worse, 4 or more late GST returns, a partner score below 600, a bounce ratio above 8 percent). A company is referred when KYC is not verified, when no GST returns are on file, when the grade is C2 or D, when the offer is below half the credit need, when the floor is above the rate card, or when the anomaly model flagged it. Everything else is a pre-approved offer.

## 7. Where each figure shows

| Screen | What it shows |
|---|---|
| Exasol report, Offer and negotiation limit | A "Priced with" block under the terms, with the cash margin and the industry, the yearly cash, the LGD and the collateral, the existing CIBIL exposure and the room under the cap |
| Offer, Negotiate | The quote's RAROC uses the decision's LGD, shown next to RAROC as "LGD used" |
| Ask Credora and the semantic view | `expected_loss` is PD x `LGD_RATE` x offer amount, where `V_LATEST_DECISION.LGD_RATE` is the decision's LGD after collateral, or the policy figure for runs made before 2.0.0 |
| What-if | The policy levers rerun the same SQL, so the margin table, the LGD table and the exposure cap apply to a what-if too |

## 8. Changing the figures

The two reference tables are policy. `CREDORA_SVC` may write them, the deploy user creates them, every other role reads them. To change a figure on a live deployment update the row in Exasol and run the analysis again. The seed files leave an existing row alone. `CONFIG MAX_EXPOSURE_PCT` and `CONFIG CASH_MARGIN_DEFAULT_PCT` are ordinary policy knobs.
