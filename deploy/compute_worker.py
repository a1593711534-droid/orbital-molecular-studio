"""Chemistry worker; one-shot CLI or reusable, bounded JSON-line protocol.

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


MAX_FRAME = 2 * 1024 * 1024 + 128
MAX_RESPONSE = 16 * 1024 * 1024


def calculate(payload):
    try:
        if not isinstance(payload, dict):
            raise ValueError()
        return {"status": 200, "body": process(payload)}
    except ChemistryError as exc:
        return {"status": 422, "body": {"error": str(exc)}}
    except Exception:
        return {"status": 500, "body": {"error": "計算發生未預期錯誤，請稍後重試。"}}


def persistent():
    sys.stdout.buffer.write(b'{"ready":true,"protocol":1}\n')
    sys.stdout.buffer.flush()
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not line:
            return
        if len(line) > MAX_FRAME or not line.endswith(b"\n"):
            return
        try:
            frame = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(frame, dict) or type(frame.get("id")) is not int:
                return
            value = {"id": frame["id"], **calculate(frame.get("payload"))}
            output = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8") + b"\n"
            if len(output) > MAX_RESPONSE:
                return
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        except (ValueError, UnicodeError, RecursionError, BrokenPipeError):
            return


def main():
    if sys.argv[1:] == ["--persistent"]:
        persistent()
        return
    try:
        value = calculate(json.loads(sys.stdin.buffer.read().decode("utf-8")))
    except Exception:
        value = {"status": 500, "body": {"error": "計算發生未預期錯誤，請稍後重試。"}}
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
