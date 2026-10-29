"""One bounded chemistry job in a disposable process.

The HTTP adapter terminates this process on timeout. No molecule or secret is
written to disk, and chemistry errors remain JSON rather than process traces.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if (ROOT / "python_lib").is_dir():
    sys.path.insert(0, str(ROOT / "python_lib"))

from chemistry import ChemistryError, process


def main():
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        value = {"status": 200, "body": process(payload)}
    except ChemistryError as exc:
        value = {"status": 422, "body": {"error": str(exc)}}
    except Exception:
        value = {"status": 500, "body": {"error": "計算發生未預期錯誤，請稍後重試。"}}
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
