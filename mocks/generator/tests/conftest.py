import sys
from pathlib import Path

# The generator package is one level up, so the tests also run from the repo root (python -m pytest mocks/generator/tests).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
