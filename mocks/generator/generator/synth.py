"""Synthetic data for Sapphire Bank and the mock bureaus.

build_world() creates every entity in memory (a few MB). Bank and AA
transactions are large, so they are produced lazily by generator functions and
streamed into the databases by the loaders. Each company and partner uses its
own RNG stream derived from the seed, so output is reproducible for a seed.
"""

import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterator

import numpy as np
from faker import Faker

from . import ids, reference as ref
from .risk import (NO_HISTORY_SCORE, Behaviour, behaviour, bureau_score, dscr, loan_request,
                   other_bank_balance, partner_latent, sigmoid, true_pd)

N_COMPANIES = 1000
N_RMS = 12
N_PAST_LOANS = 5000
RM_BRANCHES = ["Mumbai", "Pune", "Ahmedabad", "Surat", "Bengaluru", "Chennai", "New Delhi",
               "Noida", "Hyderabad", "Kolkata", "Gurugram", "Jaipur"]
CITY_STATE = {city: state for state, (_, cities, _) in ref.STATES.items() for city in cities}

# Independent RNG streams per purpose, so adding draws in one place does not shift another.
STREAM_BANK, STREAM_SA, STREAM_AA = 1, 2, 3


@dataclass
class Partner:
    partner_id: str
    cif_id: str
    name: str
    pan: str
    dob: date
    gender: str
    role: str
    share_pct: float
    city: str
    sapphire_customer: bool
    z: float
    score: int
    other_bank_accounts: list = field(default_factory=list)
    sa_account: str | None = None
    sa_opened: date | None = None


@dataclass
class Company:
    idx: int
    cif_id: str
    legal_name: str
    constitution: str
    pan: str
    gstin: str
    state: str
    city: str
    industry: str
    rm_id: str
    incorporated_on: date
    kyc_status: str
    kyc_expiry: date
    z: float
    pd: float
    would_default: bool
    beh: Behaviour
    annual_turnover: float
    periods: list[tuple[int, int]]   # GST periods, oldest first, plus the current month last
    turnover: np.ndarray             # monthly sales aligned with periods
    filings: list[tuple]             # (period, turnover, tax, due_date, filed_on)
    bank_months: int
    account_no: str
    account_opened: date
    od_limit: float
    emi: float
    emi_lender: str
    customers: list[str]
    suppliers: list[str]
    registered_on: date | None = None
    partners: list[Partner] = field(default_factory=list)


@dataclass
class Existing:
    """What is already in the databases when appending: last ids and the values that must stay unique.

    An empty Existing (the default) means a fresh data set, as in replace mode."""
    rms: list[tuple] = field(default_factory=list)   # (rm_id, name, branch); empty: create the RMs
    last_cif: int = 0
    last_partner: int = 0
    last_app: int = 0
    last_txn: int = 0
    has_past_loans: bool = False
    company_names: set[str] = field(default_factory=set)
    person_names: set[str] = field(default_factory=set)
    pans: set[str] = field(default_factory=set)
    gstins: set[str] = field(default_factory=set)
    account_nos: set[str] = field(default_factory=set)
    aa_ids: set[str] = field(default_factory=set)


@dataclass
class World:
    seed: int
    today: date
    rms: list[tuple]
    companies: list[Company]
    consumer_reports: list[tuple]
    consumer_accounts: list[tuple]
    commercial_reports: list[tuple]
    registrations: list[tuple]
    applications: list[tuple]
    past_loans: list[tuple]
    aa_accounts: list[tuple]
    new_rms: bool = True        # False when appending to a data set that already has its RMs
    txn_start: int = 0          # last CBS.TXN TXN_ID before this run

    @property
    def partners(self) -> list[Partner]:
        return [p for c in self.companies for p in c.partners]

    def filings(self) -> Iterator[tuple]:
        for c in self.companies:
            for period, turnover, tax, due, filed in c.filings:
                yield c.gstin, period, turnover, tax, due, filed

    def truth(self) -> list[tuple]:
        return [(c.cif_id, round(c.pd, 5), c.would_default) for c in self.companies]


# ---------------------------------------------------------------- helpers

def month_add(y: int, m: int, k: int) -> tuple[int, int]:
    n = y * 12 + (m - 1) + k
    return n // 12, n % 12 + 1


def weighted(rng: np.random.Generator, options: dict | list, weights=None):
    keys = list(options)
    w = np.asarray(weights if weights is not None else list(options.values()), dtype=float)
    return keys[int(rng.choice(len(keys), p=w / w.sum()))]


def pick(rng: np.random.Generator, seq):
    """Uniform choice from a sequence; much faster than Generator.choice on Python lists."""
    return seq[int(rng.integers(len(seq)))]


def rand_date(rng: np.random.Generator, start: date, end: date) -> date:
    return start + timedelta(days=int(rng.integers(0, max((end - start).days, 1))))


def working_day(d: date) -> date:
    return d - timedelta(days=1) if d.weekday() == 6 and d.day > 1 else d


def split(rng: np.random.Generator, total: float, n: int, spread: float = 0.8) -> np.ndarray:
    w = rng.lognormal(0, spread, n)
    return total * w / w.sum()


def round_amt(x: float) -> float:
    return round(float(x), 2)


class Names:
    """Draws people's and companies' names, never repeating one already used (in this run or,
    when appending, already in the databases)."""

    PLAIN_TRIES = 8         # plain "First Last" / "Prefix Word Suffix" attempts before widening
    MAX_TRIES = 400

    def __init__(self, fake: Faker, rng: np.random.Generator, people: set[str] | None = None,
                 firms: set[str] | None = None):
        self.fake, self.rng = fake, rng
        self.people: set[str] = set(people or ())
        self.used: set[str] = set(firms or ())

    def last(self) -> str:
        return pick(self.rng, ref.LAST_NAMES)

    def person(self, gender: str) -> str:
        """A unique full name. After a few clashes a middle initial is added ("Rahul K. Sharma"),
        which widens the space from about 40,000 names to over a million."""
        firsts = ref.FIRST_NAMES_M if gender == "M" else ref.FIRST_NAMES_F
        for attempt in range(self.MAX_TRIES):
            first, last = pick(self.rng, firsts), self.last()
            if attempt < self.PLAIN_TRIES:
                name = f"{first} {last}"
            else:
                name = f"{first} {ids.LETTERS[int(self.rng.integers(26))]}. {last}"
            if name not in self.people:
                self.people.add(name)
                return name
        raise RuntimeError("ran out of unique person names")

    def firm(self, industry: str, constitution: str) -> str:
        words = ref.INDUSTRIES[industry][0]
        for attempt in range(self.MAX_TRIES):
            if constitution == "Partnership" and self.rng.random() < 0.4:
                base = f"{self.last()} {pick(self.rng, words)}"
            else:
                base = f"{pick(self.rng, ref.NAME_PREFIXES)} {pick(self.rng, words)}"
            if attempt >= self.PLAIN_TRIES:
                base = f"{base} {pick(self.rng, ref.NAME_QUALIFIERS)}"
            name = f"{base} {pick(self.rng, ref.NAME_SUFFIX[constitution])}"
            if name not in self.used:
                self.used.add(name)
                return name
        raise RuntimeError("ran out of company names")

    def counterparty(self) -> str:
        industry = pick(self.rng, list(ref.INDUSTRIES))
        word = pick(self.rng, ref.INDUSTRIES[industry][0])
        head = pick(self.rng, ref.NAME_PREFIXES) if self.rng.random() < 0.6 else self.last()
        return f"{head} {word}".upper()


# ---------------------------------------------------------------- world

def build_world(seed: int, today: date | None = None, n_companies: int = N_COMPANIES,
                existing: Existing | None = None) -> World:
    """Create n_companies new companies. With `existing` (append mode) every sequence continues
    after the databases' current maximum and names, PANs, GSTINs and account numbers stay unique."""
    today = today or date.today()
    ex = existing or Existing()
    rng = np.random.default_rng(seed)
    fake = Faker("en_IN")
    fake.seed_instance(seed)
    names = Names(fake, rng, people=ex.person_names | {r[1] for r in ex.rms}, firms=ex.company_names)
    uid = ids.UniqueIds(rng, taken=ex.pans | ex.account_nos | ex.aa_ids)
    gstins = set(ex.gstins)

    if ex.rms:
        rms = list(ex.rms)
    else:
        names.people.add("Subhashree Mohanty")
        rms = [(ids.rm_id(i + 1), names.person("M" if rng.random() < 0.6 else "F"), f"{city} Main Branch")
               for i, city in enumerate(RM_BRANCHES[:N_RMS])]
        # The "rm" demo login acts as RM001, so it keeps the same name in every generated data set.
        rms[0] = (rms[0][0], "Subhashree Mohanty", rms[0][2])
    rms_by_state: dict[str, list[str]] = {}
    for rm, _, branch in rms:
        state_of_branch = CITY_STATE.get(branch.removesuffix(" Main Branch"))
        if state_of_branch:
            rms_by_state.setdefault(state_of_branch, []).append(rm)

    counterparty_pool = list(dict.fromkeys(names.counterparty() for _ in range(4000)))
    state_weights = {s: v[2] for s, v in ref.STATES.items()}
    # latest GST period is the last one whose due date (20th of the next month) has passed
    last_period = month_add(today.year, today.month, -1 if today.day > 20 else -2)

    companies: list[Company] = []
    partner_seq = ex.last_partner
    for i in range(ex.last_cif, ex.last_cif + n_companies):
        z = float(rng.normal())
        pd = float(true_pd(z))
        beh = behaviour(z, rng)
        constitution = weighted(rng, ref.CONSTITUTIONS)
        industry = pick(rng, list(ref.INDUSTRIES))
        state = weighted(rng, state_weights)
        state_code, cities, _ = ref.STATES[state]
        city = pick(rng, cities)
        legal_name = names.firm(industry, constitution)
        holder = "C" if constitution in ("Private Limited", "Public Limited") else "F"
        pan = uid.pan(holder, legal_name)
        while ids.gstin(state_code, pan) in gstins:
            pan = uid.pan(holder, legal_name)
        gstins.add(ids.gstin(state_code, pan))

        # GST history: 2-10 years of monthly sales, plus the running month for the bank feed.
        gst_months = int(rng.integers(24, 121))
        first = month_add(*last_period, -(gst_months - 1))
        periods = [month_add(*first, k) for k in range(gst_months + 1)]
        annual = float(np.clip(np.exp(rng.normal(np.log(8e7), 0.9)), 5e6, 2.5e9))
        k = np.arange(gst_months + 1) - (gst_months - 1)
        amp = ref.INDUSTRIES[industry][4]
        phase = rng.uniform(0, 2 * np.pi)
        months_of_year = np.array([m for _, m in periods])
        turnover = (annual / 12 * (1 + beh.growth) ** (k / 12)
                    * (1 + amp * np.sin(months_of_year / 12 * 2 * np.pi + phase))
                    * np.exp(rng.normal(0, beh.volatility, gst_months + 1)))
        filings = gst_filings(rng, beh, ref.INDUSTRIES[industry][1], periods[:-1], turnover, today)
        registered_on = date(*first, 1) - timedelta(days=int(rng.integers(0, 25)))
        incorporated_on = registered_on - timedelta(days=int(rng.integers(30, 5 * 365)))

        # 13-24 months back, so 12 full months precede any applied_on in the last 30 days
        bank_months = int(rng.integers(13, 25))
        start_y, start_m = month_add(today.year, today.month, -bank_months)
        account_opened = date(start_y, start_m, 1)
        kyc_status = weighted(rng, {"VERIFIED": 0.86 - 0.04 * max(z, 0), "EXPIRED": 0.09 + 0.04 * max(z, 0),
                                    "PENDING": 0.05})
        kyc_expiry = (today + timedelta(days=int(rng.integers(30, 900))) if kyc_status == "VERIFIED"
                      else today - timedelta(days=int(rng.integers(1, 400))) if kyc_status == "EXPIRED"
                      else today + timedelta(days=30))
        rm = pick(rng, rms_by_state.get(state) or [r[0] for r in rms])
        monthly_credit = annual / 12
        od_limit = round(monthly_credit * rng.uniform(0.1, 0.25), -4) if rng.random() < 0.25 else 0.0
        has_emi = rng.random() < 0.6
        emi = round(annual * rng.uniform(0.004, 0.012), -2) if has_emi else 0.0
        lenders = ref.FIP_BANKS + ref.NBFC_LENDERS

        company = Company(
            idx=i, cif_id=ids.cif_id(i + 1), legal_name=legal_name, constitution=constitution, pan=pan,
            gstin=ids.gstin(state_code, pan), state=state, city=city, industry=industry, rm_id=rm,
            incorporated_on=incorporated_on, kyc_status=kyc_status, kyc_expiry=kyc_expiry,
            z=z, pd=pd, would_default=bool(rng.random() < pd), beh=beh, annual_turnover=annual,
            periods=periods, turnover=turnover, filings=filings, bank_months=bank_months,
            account_no=uid.sapphire_account(), account_opened=account_opened, od_limit=od_limit,
            emi=emi, emi_lender=pick(rng, lenders),
            customers=[str(x) for x in rng.choice(counterparty_pool, int(rng.integers(6, 21)), replace=False)],
            suppliers=[str(x) for x in rng.choice(counterparty_pool, int(rng.integers(5, 16)), replace=False)],
            registered_on=registered_on,
        )

        n_partners = int(rng.integers(2, 6))
        shares = np.maximum(rng.dirichlet(np.full(n_partners, 2.0)) * 100, 1.0)
        shares = np.round(shares / shares.sum() * 100, 2)
        shares[np.argmax(shares)] += round(100 - shares.sum(), 2)
        order = np.argsort(-shares)
        pzs = partner_latent(z, rng, n_partners)
        for rank, j in enumerate(order):
            partner_seq += 1
            gender = "M" if rng.random() < 0.8 else "F"
            name = names.person(gender)
            if constitution in ("Partnership", "LLP"):
                role = "Partner"
            else:
                role = "Promoter" if rank == 0 else "Director"
            score = -1 if rng.random() < 0.03 else bureau_score(float(pzs[j]), rng)
            p = Partner(
                partner_id=ids.partner_id(partner_seq), cif_id=company.cif_id, name=name,
                pan=uid.pan("P", name.split()[-1]),
                dob=today - timedelta(days=int(rng.integers(28 * 365, 70 * 365))),
                gender=gender, role=role, share_pct=float(shares[j]),
                city=city if rng.random() < 0.85 else pick(rng, list(CITY_STATE)),
                sapphire_customer=bool(rng.random() < 0.30), z=float(pzs[j]), score=score,
            )
            if p.sapphire_customer:
                p.sa_account = uid.sapphire_account()
                p.sa_opened = today - timedelta(days=int(rng.integers(400, 15 * 365)))
            company.partners.append(p)
        companies.append(company)

    consumer_reports, consumer_accounts = cibil_consumer(rng, companies, today)
    aa_accounts = aa_account_rows(rng, uid, companies, today)
    return World(
        seed=seed, today=today, rms=rms, companies=companies,
        consumer_reports=consumer_reports, consumer_accounts=consumer_accounts,
        commercial_reports=[cibil_commercial(rng, c, today) for c in companies],
        registrations=[(c.gstin, c.legal_name, c.pan, c.state, c.registered_on,
                        "SUSPENDED" if c.z > 2.2 and rng.random() < 0.5 else "ACTIVE") for c in companies],
        applications=[application(rng, c, today, ex.last_app + k + 1) for k, c in enumerate(companies)],
        past_loans=[] if ex.has_past_loans else past_loans(rng, today),
        aa_accounts=aa_accounts,
        new_rms=not ex.rms,
        txn_start=ex.last_txn,
    )


def gst_filings(rng, beh: Behaviour, gst_rate: float, periods, turnover, today: date) -> list[tuple]:
    rows = []
    n = len(periods)
    for k, (y, m) in enumerate(periods):
        ny, nm = month_add(y, m, 1)
        due = date(ny, nm, 20)
        recent = k >= n - 12
        stress = 1.3 if recent and beh.z > 0.5 else 1.0   # risky firms slip more lately
        roll = rng.random()
        if roll < beh.p_missing * stress:
            filed = None
        elif roll < (beh.p_missing + beh.p_late) * stress:
            filed = due + timedelta(days=int(rng.integers(1, 15 + int(30 * max(beh.z, 0)))))
        else:
            filed = due - timedelta(days=int(rng.integers(0, 11)))
        tax_share = rng.uniform(0.25, 0.45)   # drawn always, so the stream does not depend on the date
        if filed is not None and filed >= today:
            filed = None
        if filed is None:
            rows.append((f"{y:04d}-{m:02d}", None, None, due, None))
        else:
            sales = float(turnover[k])
            tax = sales * gst_rate * tax_share
            rows.append((f"{y:04d}-{m:02d}", round_amt(sales), round_amt(tax), due, filed))
    return rows


def dpd_history(rng, pz: float, months_open: int) -> list[int]:
    """36 monthly DPD values, oldest first, from a small delinquency Markov chain."""
    p_slip = float(sigmoid(-4.4 + 1.3 * pz))
    p_cure = 0.55
    out, dpd = [], 0
    for month in range(36):
        if month < 36 - months_open:
            out.append(0)
            continue
        if dpd == 0:
            dpd = 30 if rng.random() < p_slip else 0
        elif rng.random() < p_cure:
            dpd = 0
        else:
            dpd = min(dpd + 30, 180)
        out.append(dpd)
    return out


def consumer_accounts(rng, pan: str, pz: float, score: int, today: date) -> tuple[list[tuple], int]:
    """Bureau tradelines for one person, and the score after recent delinquencies."""
    rows = []
    lenders = ref.FIP_BANKS + ref.NBFC_LENDERS
    for _ in range(1 + int(min(rng.poisson(2.2), 6))):
        product = weighted(rng, ref.CONSUMER_PRODUCTS, ref.CONSUMER_PRODUCT_WEIGHTS)
        (lo, hi), tenure = ref.CONSUMER_PRODUCTS[product]
        sanctioned = round(float(np.exp(rng.uniform(np.log(lo), np.log(hi)))), -3)
        age = int(rng.integers(3, 150))
        opened = date(*month_add(today.year, today.month, -age), 1) + timedelta(days=int(rng.integers(0, 27)))
        dpd = dpd_history(rng, pz, age)
        closed = tenure and age > tenure
        if max(dpd[-12:]) >= 90 and rng.random() < 0.35:
            status = "WRITTEN_OFF"
        elif max(dpd) >= 90 and rng.random() < 0.25:
            status = "SETTLED"
        elif closed:
            status = "CLOSED"
        else:
            status = "ACTIVE"
        if status in ("CLOSED", "SETTLED"):
            dpd = dpd[:-1] + [0]
            balance = 0.0
        elif product == "Credit Card":
            balance = sanctioned * rng.uniform(0.05, 0.6)
        elif status == "WRITTEN_OFF":
            balance = sanctioned * rng.uniform(0.3, 0.8)
        else:
            balance = sanctioned * max(0.05, 1 - age / tenure)
        instalment = balance * 0.05 if product == "Credit Card" else sanctioned / max(tenure, 1) * 1.3
        overdue = balance if status == "WRITTEN_OFF" else instalment * dpd[-1] / 30
        # deduct score for recent delinquencies so the score agrees with the DPD grid
        score -= 12 * sum(1 for v in dpd[-12:] if v > 0)
        rows.append((pan, pick(rng, lenders), product, opened, sanctioned, round_amt(balance),
                     round_amt(min(overdue, balance)), status, ",".join(str(v) for v in reversed(dpd))))
    return rows, max(300, score)


def cibil_consumer(rng, companies: list[Company], today: date):
    reports, accounts = [], []
    for c in companies:
        for p in c.partners:
            enq6 = int(rng.poisson(0.6 + 1.2 * max(p.z, 0)))
            if p.score >= 0:
                rows, p.score = consumer_accounts(rng, p.pan, p.z, p.score, today)
                accounts.extend(rows)
            reports.append((p.pan, p.name, p.dob, p.score, today, enq6, enq6 + int(rng.poisson(0.8))))
    return reports, accounts


def cibil_commercial(rng, c: Company, today: date) -> tuple:
    exposure = c.annual_turnover * rng.uniform(0.08, 0.45) + c.emi * 30
    overdue = exposure * rng.uniform(0.01, 0.08) if c.beh.cmr_rank >= 7 and rng.random() < 0.6 else 0.0
    return (c.pan, c.legal_name, c.beh.cmr_rank, today, round(exposure, -3), round_amt(overdue),
            c.beh.suit_filed, c.beh.wilful_default, int(rng.integers(1, 9)))


def application(rng, c: Company, today: date, app_no: int) -> tuple:
    product, amount, tenure = loan_request(rng, c.annual_turnover, c.z)
    if product == "WC":
        purpose = pick(rng, ref.WC_PURPOSES)
        collateral = weighted(rng, {"Receivables": 0.5, "Property": 0.3, "None": 0.2})
    else:
        purpose = pick(rng, ref.TL_PURPOSES)
        collateral = weighted(rng, {"Property": 0.45, "Plant & machinery": 0.45, "None": 0.10})
    value = 0.0 if collateral == "None" else round(amount * rng.uniform(0.8, 1.8), -4)
    return (ids.app_id(app_no), c.cif_id, today - timedelta(days=int(rng.integers(0, 31))),
            product, amount, tenure, purpose, collateral, value, "NEW")


def past_loans(rng, today: date) -> list[tuple]:
    rows = []
    for i in range(N_PAST_LOANS):
        z = float(rng.normal())
        sanctioned = rand_date(rng, date(2018, 4, 1), today - timedelta(days=730))
        f = past_loan_features(z, rng, sanctioned)
        rows.append((f"PL{i + 1:08d}", sanctioned, f["product"], f["amount"], f["gst_years"],
                     f["gst_turnover_12m"], f["gst_late_filings_12m"], f["gst_bank_gap_pct"],
                     f["avg_balance_12m"], f["inflow_volatility"], f["bounce_ratio"], f["cmr_rank"],
                     f["partner_min_score"], f["partner_avg_score"], f["partner_overdue_amt"],
                     f["partner_other_bank_bal"], f["dscr"], bool(rng.random() < true_pd(z))))
    return rows


def aa_account_rows(rng, uid: ids.UniqueIds, companies: list[Company], today: date) -> list[list]:
    """Other-bank accounts. Balances are filled in when transactions are simulated."""
    rows = []

    def add(pan, name, acct_type, z):
        acct_id = uid.aa_account()
        opened = today - timedelta(days=int(rng.integers(400, 20 * 365)))
        rows.append([acct_id, pan, name, weighted(rng, ref.FIP_BANKS, ref.FIP_WEIGHTS), acct_type,
                     f"XXXXXX{int(rng.integers(0, 10000)):04d}", opened, 0.0, z])
        return acct_id

    for c in companies:
        for p in c.partners:
            for _ in range(int(rng.choice([1, 2, 3], p=[0.5, 0.35, 0.15]))):
                kind = "SAVINGS" if rng.random() < 0.85 else "CURRENT"
                p.other_bank_accounts.append(add(p.pan, p.name, kind, p.z))
        if rng.random() < 0.2:
            add(c.pan, c.legal_name, "CURRENT", c.z)
    return rows


# ---------------------------------------------------------------- bank transactions

def bank_accounts(world: World) -> list[tuple]:
    rows = []
    for c in world.companies:
        rows.append((c.account_no, "COMPANY", c.cif_id, "CA", f"{c.city} Main Branch",
                     c.account_opened, "ACTIVE", c.od_limit))
        for p in c.partners:
            if p.sa_account:
                status = "DORMANT" if (int(p.partner_id[1:]) * 7919) % 20 == 0 else "ACTIVE"
                rows.append((p.sa_account, "PARTNER", p.partner_id, "SA", f"{c.city} Main Branch",
                             p.sa_opened, status, 0.0))
    return rows


class Ledger:
    """Running balance for one account; returns rows without TXN_ID."""

    def __init__(self, account_no: str, balance: float, od_limit: float = 0.0):
        self.account_no, self.balance, self.od_limit = account_no, balance, od_limit
        self.rows: list[list] = []

    def credit(self, d, amount, channel, party, narration):
        self.balance += amount
        self.rows.append([self.account_no, d, "C", round_amt(amount), channel, party, narration[:120],
                          round_amt(self.balance), "N"])

    def debit(self, d, amount, channel, party, narration, bounce=False, charge_narr=None) -> bool:
        if bounce or amount > self.balance + self.od_limit:
            if charge_narr is None:
                return False          # electronic payment not attempted without funds
            self.rows.append([self.account_no, d, "D", round_amt(amount), channel, party, narration[:120],
                              round_amt(self.balance), "Y"])
            if self.balance + self.od_limit >= 590:
                self.debit(d, 590.0, "NEFT", "SAPPHIRE BANK", charge_narr)
            return False
        self.balance -= amount
        self.rows.append([self.account_no, d, "D", round_amt(amount), channel, party, narration[:120],
                          round_amt(self.balance), "N"])
        return True


def credit_channel(rng, amount: float, cash_heavy: bool) -> str:
    if amount >= 200000:
        return "RTGS" if rng.random() < 0.6 else "NEFT"
    r = rng.random()
    if cash_heavy and r < 0.15:
        return "CASH"
    return "NEFT" if r < 0.55 else "IMPS" if r < 0.72 else "UPI" if r < 0.87 else "CHQ"


def company_transactions(c: Company, seed: int, today: date) -> list[list]:
    rng = np.random.default_rng([seed, STREAM_BANK, c.idx])
    beh = c.beh
    _, gst_rate, salary_share, cash_heavy, _ = ref.INDUSTRIES[c.industry]
    month_sales = dict(zip(c.periods, c.turnover))
    tax_by_period = {f[0]: f[2] for f in c.filings}
    monthly_credit = c.annual_turnover / 12
    ledger = Ledger(c.account_no, round(monthly_credit * beh.cushion, 2), c.od_limit)
    lam_credit = float(np.clip(10 + 5 * np.log10(c.annual_turnover / 1e7), 5, 30))
    rent = round(monthly_credit * rng.uniform(0.01, 0.03), -2)
    yesterday = today - timedelta(days=1)

    for k in range(c.bank_months, -1, -1):
        y, m = month_add(today.year, today.month, -k)
        ndays = calendar.monthrange(y, m)[1]
        sales = float(month_sales.get((y, m), monthly_credit))
        credits = sales * (1 + beh.gap_sign * beh.gst_bank_gap) * rng.lognormal(0, 0.03)
        spend = credits * (1 - rng.normal(beh.margin, 0.02))
        events = []   # (day, tiebreak, callable)

        def at(day, fn):
            events.append((min(max(day, 1), ndays), rng.random(), fn))

        n_cr = max(1, int(rng.poisson(lam_credit)))
        for amt in split(rng, credits, n_cr):
            party = pick(rng, c.customers)
            ch = credit_channel(rng, amt, cash_heavy)
            ref_no = int(rng.integers(10**8, 10**9))
            narr = ("CASH DEPOSIT BY SELF" if ch == "CASH" else f"CHQ DEP {ref_no % 10**6:06d} {party}"
                    if ch == "CHQ" else f"{ch}/CR/{ref_no}/{party}")
            at(int(rng.integers(1, ndays + 1)),
               lambda d, a=amt, ch=ch, p=("SELF" if ch == "CASH" else party), n=narr: ledger.credit(d, a, ch, p, n))

        prev = month_add(y, m, -1)
        gst = tax_by_period.get(f"{prev[0]:04d}-{prev[1]:02d}") or 0.0
        if gst:
            at(20, lambda d, a=gst: ledger.debit(d, a, "NEFT", "GSTN - CBIC", f"GST PMT CPIN {y}{m:02d}{c.idx:06d}"))
        salary = round(spend * salary_share, 0)
        at(ndays - int(rng.integers(0, 3)), lambda d, a=salary: ledger.debit(
            d, a, "NEFT", "EMPLOYEES - BULK", f"SALARY {calendar.month_abbr[m].upper()}{y % 100:02d} BULK UPLOAD"))
        if c.emi:
            bounce = rng.random() < beh.p_bounce
            at(5, lambda d, b=bounce: ledger.debit(
                d, c.emi, "NEFT", c.emi_lender.upper(), f"NACH DR {c.emi_lender.upper()} EMI", b,
                "NACH RTN CHGS INCL GST"))
        at(int(rng.integers(1, 8)), lambda d: ledger.debit(d, rent, "NEFT", "LANDLORD", "RENT PMT OFFICE/FACTORY"))
        for util in ("ELECTRICITY BOARD", "AIRTEL BROADBAND"):
            amt = spend * (0.012 if util.startswith("ELEC") else 0.001) * rng.lognormal(0, 0.1)
            at(int(rng.integers(8, 16)), lambda d, a=amt, u=util: ledger.debit(d, a, "UPI", u, f"UPI/BILLPAY/{u}"))

        fixed = gst + salary + c.emi + rent + spend * 0.013
        supplier_total = max(spend - fixed, spend * 0.05)
        n_sup = max(1, int(rng.poisson(lam_credit * 0.8)))
        for amt in split(rng, supplier_total, n_sup):
            party = pick(rng, c.suppliers)
            ref_no = int(rng.integers(10**8, 10**9))
            if amt >= 200000 and rng.random() < 0.6:
                ch = "RTGS"
            else:
                ch = "CHQ" if rng.random() < 0.3 else "NEFT"
            if ch == "CHQ":
                chq = ref_no % 10**6
                at(int(rng.integers(1, ndays + 1)), lambda d, a=amt, p=party, q=chq, b=rng.random() < beh.p_bounce:
                   ledger.debit(d, a, "CHQ", p, f"CHQ PAID {q:06d} {p}", b,
                                f"CHQ RTN CHGS {q:06d} INSUFFICIENT FUNDS"))
            else:
                at(int(rng.integers(1, ndays + 1)), lambda d, a=amt, p=party, ch=ch, r=ref_no:
                   ledger.debit(d, a, ch, p, f"{ch}/DR/{r}/{p}"))
        for _ in range(int(rng.poisson(4))):
            amt = round(float(rng.uniform(500, 25000)), 0)
            if rng.random() < 0.5:
                at(int(rng.integers(1, ndays + 1)), lambda d, a=amt: ledger.debit(d, a, "CASH", "SELF", "CASH WDL SELF"))
            else:
                shop = pick(rng, ref.SPEND_MERCHANTS).upper()
                at(int(rng.integers(1, ndays + 1)), lambda d, a=amt, s=shop: ledger.debit(d, a, "UPI", s, f"UPI/{s}/PURCHASE"))

        for day, _, fn in sorted(events, key=lambda e: (e[0], e[1])):
            d = working_day(date(y, m, day))
            if c.account_opened <= d <= yesterday:
                fn(d)
    return ledger.rows


def partner_sa_transactions(c: Company, p: Partner, seed: int, today: date) -> list[list]:
    rng = np.random.default_rng([seed, STREAM_SA, int(p.partner_id[1:])])
    income = c.annual_turnover * 0.03 * p.share_pct / 100 / 12 + rng.uniform(40000, 150000)
    ledger = Ledger(p.sa_account, round(income * rng.uniform(0.5, 4), 2))
    p_bounce = float(sigmoid(-5 + 1.2 * p.z))
    emi = round(income * rng.uniform(0.15, 0.35), -2) if rng.random() < 0.5 else 0.0
    yesterday = today - timedelta(days=1)
    events = []
    for k in range(12, -1, -1):
        y, m = month_add(today.year, today.month, -k)
        ndays = calendar.monthrange(y, m)[1]

        def at(day, fn):
            d = working_day(date(y, m, min(day, ndays)))
            if today - timedelta(days=365) <= d <= yesterday:
                events.append((d, rng.random(), fn))

        at(1, lambda d, a=income * rng.lognormal(0, 0.05): ledger.credit(
            d, a, "NEFT", c.legal_name.upper()[:80], f"NEFT/CR/REMUNERATION/{c.legal_name.upper()}"))
        if m == 4 and rng.random() < 0.5:
            at(15, lambda d, a=income * rng.uniform(1, 4): ledger.credit(
                d, a, "NEFT", c.legal_name.upper()[:80], "DIVIDEND/PROFIT SHARE"))
        if emi:
            at(5, lambda d, b=rng.random() < p_bounce: ledger.debit(
                d, emi, "NEFT", "HOME LOAN EMI", "NACH DR HOME LOAN EMI", b, "NACH RTN CHGS INCL GST"))
        at(7, lambda d, a=round(income * 0.08, -2): ledger.debit(d, a, "NEFT", "MUTUAL FUND SIP", "NACH DR MF SIP"))
        at(10, lambda d, a=income * rng.uniform(0.1, 0.3): ledger.debit(d, a, "NEFT", "CREDIT CARD", "CC BILL PAYMENT"))
        for _ in range(int(rng.poisson(8))):
            shop = pick(rng, ref.SPEND_MERCHANTS).upper()
            at(int(rng.integers(1, 29)), lambda d, a=round(float(rng.lognormal(7.5, 1.0)), 2), s=shop:
               ledger.debit(d, a, "UPI", s, f"UPI/{s}/{int(rng.integers(10**9, 10**10))}"))
        if rng.random() < 0.6:
            at(int(rng.integers(1, 29)), lambda d, a=float(rng.choice([5000, 10000, 20000])):
               ledger.debit(d, a, "CASH", "SELF", "ATM WDL"))
    for d, _, fn in sorted(events, key=lambda e: (e[0], e[1])):
        fn(d)
    return ledger.rows


def bank_transactions(world: World) -> Iterator[list]:
    """All CBS.TXN rows, TXN_ID first, ordered by account then date."""
    txn_id = world.txn_start
    for c in world.companies:
        batches = [company_transactions(c, world.seed, world.today)]
        batches += [partner_sa_transactions(c, p, world.seed, world.today) for p in c.partners if p.sa_account]
        for rows in batches:
            for row in rows:
                txn_id += 1
                yield [txn_id, *row]


# ---------------------------------------------------------------- AA transactions

AA_CREDIT_TEXT = ["SALARY/NEFT", "NEFT/CR/REMUNERATION", "INTEREST CREDIT", "IMPS/CR/TRANSFER"]
AA_DEBIT_TEXT = ["UPI/{shop}", "ATM WDL", "NEFT/DR/TRANSFER", "CC BILL PAYMENT", "NACH DR EMI"]


def _month_amounts(rng, counts: np.ndarray, totals: np.ndarray, spread: float):
    """Split each month's total into counts[k] lognormal-weighted amounts; returns (month index, amount)."""
    month = np.repeat(np.arange(len(counts)), counts)
    w = rng.lognormal(0, spread, month.size)
    return month, w / np.bincount(month, w, len(counts))[month] * totals[month]


def aa_account_walk(rng, z: float, current: bool, today: date, with_rows: bool = True):
    """Twelve months of other-bank activity: [(date, dr_cr, amount, narration, balance)], closing balance."""
    balance = other_bank_balance(z, rng)
    inflow = balance * rng.uniform(0.15, 0.4)
    months = [month_add(today.year, today.month, -k) for k in range(12, -1, -1)]
    first = np.array([date(y, m, 1).toordinal() for y, m in months])
    ndays = np.array([calendar.monthrange(y, m)[1] for y, m in months])
    m_in, a_in = _month_amounts(rng, rng.poisson(3 if current else 1, 13) + 1,
                                inflow * rng.lognormal(0, 0.15, 13), 0.5)
    m_out, a_out = _month_amounts(rng, np.maximum(rng.poisson(4 if current else 3, 13), 1),
                                  inflow * rng.uniform(0.85, 1.08, 13), 0.8)
    month = np.concatenate([m_in, m_out])
    day = first[month] + (rng.random(month.size) * ndays[month]).astype(int)
    amount = np.concatenate([a_in, a_out])
    is_credit = np.arange(month.size) < m_in.size
    text_idx = np.where(is_credit, rng.integers(0, len(AA_CREDIT_TEXT), month.size),
                        rng.integers(0, len(AA_DEBIT_TEXT), month.size))
    shop_idx = rng.integers(0, len(ref.SPEND_MERCHANTS), month.size)
    lo, hi = (today - timedelta(days=365)).toordinal(), (today - timedelta(days=1)).toordinal()
    rows = []
    for i in np.argsort(day, kind="stable").tolist():
        d = int(day[i])
        if not lo <= d <= hi:
            continue
        amt = float(amount[i])
        if is_credit[i]:
            balance += amt
        elif amt > balance:
            continue
        else:
            balance -= amt
        if with_rows:
            if is_credit[i]:
                text = "NEFT/CR/CUSTOMER RECEIPT" if current else AA_CREDIT_TEXT[text_idx[i]]
            else:
                text = AA_DEBIT_TEXT[text_idx[i]].format(shop=ref.SPEND_MERCHANTS[shop_idx[i]].upper())
            rows.append((date.fromordinal(d), "C" if is_credit[i] else "D", round_amt(amt), text,
                         round_amt(balance)))
    return rows, round_amt(balance)


def aa_transactions(world: World) -> Iterator[tuple]:
    """fi_txn rows (without id). Also sets each AA account's closing balance."""
    for acct in world.aa_accounts:
        acct_id, z, current = acct[0], acct[8], acct[4] == "CURRENT"
        rng = np.random.default_rng([world.seed, STREAM_AA, int(acct_id[2:])])
        rows, acct[7] = aa_account_walk(rng, z, current, world.today)
        for row in rows:
            yield acct_id, *row


# ---------------------------------------------------------------- historical loans

def past_loan_features(z: float, rng: np.random.Generator, as_of: date) -> dict:
    """Feature snapshot of a historical loan. The raw data stays virtual, but each feature is
    drawn from the same latent-risk process (and shared simulators) as a live company."""
    b = behaviour(z, rng)
    gst_months = int(rng.integers(24, 121))
    annual = float(np.clip(np.exp(rng.normal(np.log(8e7), 0.9)), 5e6, 2.5e9))
    industry = pick(rng, list(ref.INDUSTRIES))
    amp = ref.INDUSTRIES[industry][4]
    season = 1 + amp * np.sin(np.arange(12) / 12 * 2 * np.pi + rng.uniform(0, 2 * np.pi))
    sales = annual / 12 * season * np.exp(rng.normal(0, b.volatility, 12))
    bank = sales * (1 + b.gap_sign * b.gst_bank_gap) * np.exp(rng.normal(0, 0.03, 12))
    stress = 1.3 if z > 0.5 else 1.0
    roll = rng.random(12)
    missing = roll < b.p_missing * stress
    late = roll < (b.p_missing + b.p_late) * stress
    gst_turnover = float(sales[~missing].sum())
    debits = int(rng.poisson(26 * 12))
    # only cheques and NACH debits (about 15% of debits) can bounce
    bounced = int(rng.binomial(debits, min(1.0, b.p_bounce * 0.15)))
    # payments are skipped rather than overdrawn, so balances flatten out near a floor
    balance_months = float(np.hypot(max(b.cushion + 6 * b.margin, 0.0), 0.4))

    n_partners = int(rng.integers(2, 6))
    scores, overdue, other_bal = [], 0.0, 0.0
    for pz in partner_latent(z, rng, n_partners):
        pz = float(pz)
        score = -1 if rng.random() < 0.03 else bureau_score(pz, rng)
        if score >= 0:
            rows, score = consumer_accounts(rng, "", pz, score, as_of)
            overdue += sum(r[6] for r in rows)
        scores.append(NO_HISTORY_SCORE if score < 0 else score)
        for _ in range(int(rng.choice([1, 2, 3], p=[0.5, 0.35, 0.15]))):
            other_bal += aa_account_walk(rng, pz, rng.random() >= 0.85, as_of, with_rows=False)[1]

    product, amount, tenure = loan_request(rng, annual, z)
    return {
        "product": product,
        "amount": amount,
        "gst_years": round((gst_months + rng.uniform(0, 1.5)) / 12, 1),
        "gst_turnover_12m": round(gst_turnover, 2),
        "gst_late_filings_12m": int(late.sum()),
        "gst_bank_gap_pct": round(float(abs(gst_turnover - bank.sum()) / gst_turnover * 100), 2),
        "avg_balance_12m": round(annual / 12 * balance_months, 2),
        "inflow_volatility": round(float(bank.std() / bank.mean()), 4),
        "bounce_ratio": round(bounced / max(debits, 1), 4),
        "cmr_rank": b.cmr_rank,
        "partner_min_score": int(min(scores)),
        "partner_avg_score": round(float(np.mean(scores)), 1),
        "partner_overdue_amt": round(overdue, 2),
        "partner_other_bank_bal": round(other_bal, 2),
        "dscr": round(dscr(gst_turnover, product, amount, tenure, ref.CASH_MARGIN_PCT[industry] / 100), 3),
    }
