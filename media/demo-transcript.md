# Demo video transcript

The spoken narration of [demo.mp4](demo.mp4), 2 min 56 s, with what is on screen at each point. The same text is in [demo.srt](demo.srt) and [demo.vtt](demo.vtt) as captions. The live copy plays at https://video.credora.loan with captions the viewer can switch on.

| Time | On screen | Narration |
|---|---|---|
| 0:01 | Deck slide 1, title | Hi, I'm Anamika. This is Credora, my ExaThon India 2026 entry. Pre-approved loans for corporate customers, decided inside Exasol Personal. |
| 0:13 | Slide 2, the problem | The bank has the data, in six systems, gathered by hand. |
| 0:18 | Slide 3 for one second, then slide 4, what changes (numbers count up) | One run, 1,000 companies, 530 approved, 1,168 crore rupees in offers, 17 seconds. |
| 0:27 | Slide 5, everything meets in Exasol | Bank data read in place, 3rd party data via API, everyone reading as their own Exasol user. |
| 0:35 | DbVisualizer, Exasol > DBA > Auditing, then the Users tree and the Oracle, MySQL, PostgreSQL connections | This is the live Exasol database in DbVisualizer. Every statement is audited. Each role, and the AI, has its own Exasol user. Oracle, MySQL and PostgreSQL come in through virtual schemas. |
| 0:49 | test.sql cross-database query, re-run at 0:50, result rows for Ambika Technologies from 0:53 | One query joins Oracle, MySQL, PostgreSQL and the Exasol decision. Here is Ambika Technologies with its partners and its offer. |
| 1:01 | Slide 5 flashes, login page at 1:01, Data scientist chosen | Now the app, as the data scientist. |
| 1:06 | Overview as datasci (numbers count up), Analysis runs at 1:06, Run analysis starts at 1:08, steps tick with the Exasol console open from 1:13, finished at 1:20 | Run analysis starts one Lua script in Exasol. It refreshes the virtual schemas, pulls CIBIL, GST and Account Aggregator data through UDFs, scores, decides and ranks. The console shows each statement live. |
| 1:23 | Publish dialog, note "latest", published at 1:26 | Done. I publish it to loan operations. |
| 1:27 | Overview as loanops, Top 50 at 1:32, Decisions at 1:34, Top 50 again 1:35 to 1:38 | As loan operations, the Top 50 comes from a PREFERRING skyline in Exasol, with the SQL beside it. |
| 1:39 | Assign C000066 dialog with the RM list, to 1:41 | Each company goes to a relationship manager. |
| 1:43 | Login page, Relationship manager chosen, Overview as rm at 1:44, My companies from 1:45 | As a relationship manager, I see only my 24 companies. Exasol filters by my user. |
| 1:50 | Update loan status dialog for Vertex Specialty Chem, logged at 1:53, console open 1:55 to 1:56 | Every offer has a negotiation limit. Vertex Specialty Chem took the loan, so I log it. |
| 1:57 | Ask Credora, "What is the climate in Chennai?" refused at 2:02, then "Which of my assigned companies have the most negotiation headroom?" answered at 2:06 | Ask Credora is Claude, querying Exasol through the MCP server as my own AI user. Off-topic gets turned down. Negotiation headroom comes back with the SQL. |
| 2:08 | DbVisualizer semantic view query for one second, back to Ask at 2:09, "Show the raw CIBIL scores..." 2:10 to 2:12 | It reads the semantic view. Every answer shows its SQL. |
| 2:13 | Login page, Admin chosen, Overview as admin at 2:15, then Exasol control room, row-level security panel from 2:20 to 2:26 | Last, the admin. The control room proves row-level security. The RM and its AI user get the same 120 rows, a second RM gets none, and a direct read is refused. |
| 2:27 | Exasol audit, scheduled jobs, audited statements from 2:31 | Every statement lands in Exasol's audit log. Scheduled jobs run inside Exasol too. |
| 2:35 | Login page for one second, GitHub repo at 2:35, README from 2:37, bottom of README to 2:46 | The code is public on GitHub, MIT licensed, with docs, diagrams and the changelog. The data is synthetic. One command deploys it to AWS. |
| 2:46 | Slide 20, thank you, slide 21 at 2:52, slide 22 close 2:53 to 2:56 | Credora is built on Exasol open source. Thanks to the Exasol team, the Exasol Personal Local Starter Kit and Exasol Personal. Thanks for watching. |
