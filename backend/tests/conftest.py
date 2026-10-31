import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("APP_SECRET", "test-secret-for-unit-tests-only-0123456789")
os.environ.setdefault("APP_RM_ID", "RM001")
