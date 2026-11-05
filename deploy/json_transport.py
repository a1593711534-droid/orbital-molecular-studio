"""Validate JSON before it crosses the UTF-8 worker protocol boundary."""
import json
import math

MAX_DEPTH = 64


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite number")
    return number


def _reject_constant(value):
    raise ValueError("Non-finite number")


def load_request(raw):
    payload = json.loads(raw.decode("utf-8-sig"), parse_float=_finite_float,
                         parse_constant=_reject_constant)
    if not isinstance(payload, dict):
        raise ValueError("Expected object")
    # JSON escapes can contain lone surrogates even after strict UTF-8 decoding.
    # Check them here, not after a worker slot has been acquired for the request.
    pending = [(payload, 0)]
    while pending:
        value, depth = pending.pop()
        if depth > MAX_DEPTH:
            raise ValueError("JSON nesting is too deep")
        if isinstance(value, str):
            value.encode("utf-8")
        elif isinstance(value, dict):
            for key, item in value.items():
                key.encode("utf-8")
                pending.append((item, depth + 1))
        elif isinstance(value, list):
            pending.extend((item, depth + 1) for item in value)
    return payload
