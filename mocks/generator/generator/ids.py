"""Identifier formats shared with the rest of Credora (see docs/DATA_MODEL.md)."""

import string

import numpy as np

LETTERS = string.ascii_uppercase
GSTIN_CHARS = string.digits + string.ascii_uppercase


def cif_id(n: int) -> str:
    return f"C{n:06d}"


def partner_id(n: int) -> str:
    return f"P{n:07d}"


def rm_id(n: int) -> str:
    return f"RM{n:03d}"


def app_id(n: int) -> str:
    return f"A{n:07d}"


def gstin_check_char(first14: str) -> str:
    """Standard GSTIN check character (mod-36, alternating weights 1 and 2)."""
    total = 0
    for i, ch in enumerate(first14):
        product = GSTIN_CHARS.index(ch) * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return GSTIN_CHARS[(36 - total % 36) % 36]


def number(value: str | None) -> int:
    """Numeric part of a prefixed sequential id ('C000042' -> 42); 0 for None or empty."""
    return int(value[1:]) if value else 0


def gstin(state_code: str, pan: str) -> str:
    first14 = f"{state_code}{pan}1Z"
    return first14 + gstin_check_char(first14)


class UniqueIds:
    """Draws PANs and account numbers without collisions."""

    def __init__(self, rng: np.random.Generator, taken: set[str] | None = None):
        self.rng = rng
        # values already in the databases (append mode) count as drawn
        self.seen: set[str] = set(taken or ())

    def _unique(self, make) -> str:
        while True:
            value = make()
            if value not in self.seen:
                self.seen.add(value)
                return value

    def pan(self, holder: str, name: str) -> str:
        """holder: 'C' company, 'F' firm, 'P' person. Fifth letter is the name's initial."""
        initial = next((c for c in name.upper() if c in LETTERS), "X")

        def make():
            r = self.rng
            return ("".join(LETTERS[i] for i in r.integers(0, 26, 3)) + holder + initial
                    + f"{int(r.integers(0, 10000)):04d}" + LETTERS[int(r.integers(0, 26))])

        return self._unique(make)

    def sapphire_account(self) -> str:
        return self._unique(lambda: f"5011{int(self.rng.integers(10**9, 10**10)):010d}")

    def aa_account(self) -> str:
        return self._unique(lambda: f"AA{int(self.rng.integers(0, 10**8)):08d}")
