"""Load a UDF's Python body straight from the SQL file that deploys it, and run it in
exasol/udf-mock-python's mock Exasol environment."""

from __future__ import annotations

import pathlib
import re

from exasol_udf_mock_python.mock_meta_data import MockMetaData

ROOT = pathlib.Path(__file__).resolve().parents[2]


def udf_code(sql_file: str, script: str) -> str:
    """The Python between `... AS` and the closing `/` of CREATE ... SCRIPT <script>."""
    text = (ROOT / sql_file).read_text(encoding="utf-8")
    m = re.search(rf"CREATE OR REPLACE PYTHON3 \w+ SCRIPT {re.escape(script)}\(.*?\)\s*(?:EMITS\s*\(.*?\)|RETURNS\s+[^\n]*?)\s+AS\n(.*?)\n/\n",
                  text, re.S)
    assert m, f"{script} not found in {sql_file}"
    return m.group(1)


def meta(sql_file: str, script: str, input_columns, output_columns, input_type="SET", output_type="EMITS"):
    md = MockMetaData(script_code_wrapper_function=None, input_columns=input_columns, input_type=input_type,
                      output_columns=output_columns, output_type=output_type)
    md._script_code = udf_code(sql_file, script)  # the deployed code itself, not a copy
    return md
