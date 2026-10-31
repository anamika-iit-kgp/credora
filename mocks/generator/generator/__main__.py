"""Run one generation from the command line: python -m generator [--seed N] [--mode append] [--companies N]."""

import argparse
import json
import logging

from .job import DEFAULT_COMPANIES, MODES, Job

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

parser = argparse.ArgumentParser(description="Regenerate (or add to) all Credora mock data")
parser.add_argument("--seed", type=int, default=None)
parser.add_argument("--mode", choices=MODES, default="replace",
                    help="replace: clear everything first; append: keep the data and add new companies")
parser.add_argument("--companies", type=int, default=DEFAULT_COMPANIES)
args = parser.parse_args()
if not 100 <= args.companies <= 5000:
    parser.error("--companies must be between 100 and 5000")

job = Job(args.seed, args.mode, args.companies)
job.run()
print(json.dumps(job.snapshot(), default=str, indent=2))
raise SystemExit(0 if job.status == "done" else 1)
