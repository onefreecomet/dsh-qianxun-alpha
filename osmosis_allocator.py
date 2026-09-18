#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Forum-safe standalone WorldQuant BRAIN Osmosis allocator.

Quick use:
1. Put user_config.json next to this script.
   Supported formats:
   {"credentials": {"username": "your_email", "password": "your_password"}}
   {"credentials": {"email": "your_email", "password": "your_password"}}
2. Change TARGET_REGION and TARGET_DELAY below, or pass --region / --delay
   on the command line (the flags win over the constants).
3. Run once in preview mode and inspect the CSV report (--preview forces
   this regardless of the ACTION constant).
4. To actually write points, set ACTION = "allocate" and WRITE_TO_PLATFORM = True.

The default mode is preview-only so a shared copy cannot accidentally clear or
write Osmosis points.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

import pandas as pd
import requests

SCRIPT_VERSION = "2026-08-28-Webinar"

# =============================================================================
# User settings. In normal use, only change these two.
# =============================================================================
TARGET_REGION = "USA"
TARGET_DELAY = 1
# These two are only defaults: --region / --delay override them at runtime.
# Snapshot taken at import so the flag defaults survive a second main() call
# in the same process (apply_cli_overrides rebinds the globals above).
_DEFAULT_REGION = TARGET_REGION
_DEFAULT_DELAY = TARGET_DELAY

# Optional: put known non-compensated or unwanted alpha IDs here.
# Example: EXCLUDE_ALPHA_IDS = {"mNq38GW", "qpzWgMV"}
EXCLUDE_ALPHA_IDS: set[str] = set()

# =============================================================================
# Operation settings.
# =============================================================================
TOTAL_POINTS = 100_000

# "allocate": clear current points in this region/delay, then write new points.
# "clear": clear current points only.
# "preview": build allocation plan only; no platform writes.
ACTION = "preview"

# Keep False for forum/shared copies. For real one-run operation, set True.
# The script still asks for a final confirmation before clearing or writing.
WRITE_TO_PLATFORM = False
CONFIRM_BEFORE_WRITE = True

# If ACTION == "allocate", clear current points in the scope before writing the
# new selected allocation.
CLEAR_EXISTING_FIRST = True
CLEAR_USE_DATE_FILTER = False

# Empty string means no date filter. Use ISO date like "2025-08-15" if needed.
MIN_DATE_SUBMITTED = ""
MAX_DATE_SUBMITTED = ""

# Pulling all candidates is normally cheap. Expensive recordset calls are made
# only for the top PRESELECT_LIMIT_PER_TYPE candidates.
MAX_ALPHA_SCAN = 1000
PRESELECT_LIMIT_PER_TYPE = 80
FETCH_YEARLY_STATS = True
FETCH_PNL_FOR_DIVERSITY = True
FETCH_ALPHA_DETAILS_FOR_OS = True
ALPHA_DETAIL_FETCH_LIMIT = 500

# Optional and slow. Turn on only when you really want self/prod correlation
# endpoints for top candidates. If list/detail payload already contains these
# fields, they are used without extra calls.
FETCH_EXTERNAL_CORRELATIONS = False

# =============================================================================
# Selection and scoring settings.
# =============================================================================
TARGET_ALPHA_COUNT = 20
MIN_ALPHA_COUNT = 10
MAX_ALPHA_COUNT = 25
FILL_TO_MIN_ALPHA_COUNT = True
FILLER_QUALITY_DISCOUNT = 0.35

# If both REGULAR and SUPER exist, SUPER receives a separate capped budget.
SUPER_POINT_SHARE = 0.22
SUPER_MAX_ALPHA_COUNT = 6
REGULAR_MIN_POINT_SHARE = 0.65

MIN_POINTS_PER_ALPHA = 500
REGULAR_MAX_POINTS_PER_ALPHA = 15_000
SUPER_MAX_POINTS_PER_ALPHA = 10_000

MAX_PNL_CORR = 0.70
SOFT_PNL_CORR = 0.45

# Conservative hard filters. Ranking still drives most decisions.
REGULAR_MIN_SHARPE = 1.20
REGULAR_MIN_FITNESS = 0.80
REGULAR_MAX_DRAWDOWN = 0.70
RELAXED_REGULAR_MIN_SHARPE = 0.80
RELAXED_REGULAR_MIN_FITNESS = 0.40
RELAXED_REGULAR_MAX_DRAWDOWN = 0.90
MAX_SELF_CORR = 0.75
MAX_PROD_CORR = 0.75

REQUEST_TIMEOUT = 60
REQUEST_RETRIES = 5
REQUEST_RETRY_DELAY = 2.0
PATCH_RETRIES = 5
PATCH_RETRY_DELAY = 3.0
PATCH_RETRY_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}
RETRY_BAD_REQUEST_PATCH = False
REDISTRIBUTE_FAILED_POINTS = True

BASE_URL = "https://api.worldquantbrain.com"
SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILENAME = "user_config.json"

@dataclass
class PatchResult:
    alpha_id: str
    requested: Optional[int]
    confirmed: Any
    ok: bool
    error: str = ""

def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")

def clean_region(region: Any) -> str:
    return str(region).strip().upper()

def clean_delay(delay: Any) -> int:
    return int(str(delay).strip())

def scope_name(region: str, delay: int) -> str:
    return f"{clean_region(region)}/D{clean_delay(delay)}"

def to_float(value: Any, default: float = math.nan) -> float:
    if value is None:
        return default
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(result) or math.isinf(result):
        return default
    return result

def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default

def nested_get(obj: dict[str, Any], path: Iterable[str], default: Any = None) -> Any:
    cur: Any = obj
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
    return default if cur is None else cur

def first_present(obj: dict[str, Any], names: Iterable[str]) -> Any:
    for name in names:
        if name in obj and obj[name] is not None:
            return obj[name]
    return None

def unique_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    result: list[Path] = []
    for path in paths:
        resolved = str(path.resolve())
        if resolved not in seen:
            seen.add(resolved)
            result.append(path)
    return result

def credential_file_candidates() -> list[Path]:
    env_config = os.environ.get("BRAIN_CONFIG_FILE")
    candidates: list[Path] = []
    if env_config:
        candidates.append(Path(env_config).expanduser())

    search_dirs = unique_paths(
        [
            SCRIPT_DIR,
            Path.cwd(),
            *SCRIPT_DIR.parents,
            *Path.cwd().parents,
        ]
    )
    for folder in search_dirs:
        candidates.extend(
            [
                folder / CONFIG_FILENAME,
                folder / "brain.txt",
                folder / "user_info.txt",
            ]
        )
    return unique_paths(candidates)

def _strip_quoted(value: Any) -> str:
    text = str(value).strip()
    if len(text) >= 2 and text[0] in ("'", '"') and text[-1] == text[0]:
        return text[1:-1]
    return text

def credentials_from_mapping(data: dict[str, Any]) -> Optional[tuple[str, str]]:
    blocks: list[dict[str, Any]] = [data]
    for key in ("credentials", "auth", "brain", "user"):
        value = data.get(key)
        if isinstance(value, dict):
            blocks.append(value)

    for block in blocks:
        username = (
            block.get("username")
            or block.get("email")
            or block.get("user")
            or block.get("login")
        )
        password = block.get("password") or block.get("pwd")
        if username and password:
            return _strip_quoted(username), _strip_quoted(password)
    return None

def credentials_from_colon_text(text: str) -> Optional[tuple[str, str]]:
    data: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = _strip_quoted(value.strip())
    return credentials_from_mapping(data)

def load_credentials_from_file(path: Path) -> Optional[tuple[str, str]]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return None

    if path.suffix.lower() == ".json" or text[0] in "[{":
        data = json.loads(text)
        if isinstance(data, list) and len(data) >= 2:
            return _strip_quoted(data[0]), _strip_quoted(data[1])
        if isinstance(data, dict):
            return credentials_from_mapping(data)
        return None

    return credentials_from_colon_text(text)

def load_credentials() -> tuple[str, str]:
    env_email = os.environ.get("BRAIN_EMAIL") or os.environ.get("BRAIN_USERNAME")
    env_password = os.environ.get("BRAIN_PASSWORD")
    if env_email and env_password:
        return env_email, env_password

    checked: list[str] = []
    for path in credential_file_candidates():
        checked.append(str(path))
        if not path.exists():
            continue
        creds = load_credentials_from_file(path)
        if creds:
            print(f"Loaded credentials from: {path}")
            return creds

    raise RuntimeError(
        "No credentials found. Put user_config.json next to this script. "
        "Supported JSON: {\"credentials\":{\"username\":\"...\",\"password\":\"...\"}} "
        "or {\"credentials\":{\"email\":\"...\",\"password\":\"...\"}}. "
        f"Checked {len(checked)} paths; first paths: {checked[:5]}"
    )

def authenticate() -> requests.Session:
    username, password = load_credentials()
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36"
            )
        }
    )
    session.auth = (username, password)
    response = session.post(
        f"{BASE_URL}/authentication",
        timeout=REQUEST_TIMEOUT,
    )
    if response.status_code in (200, 201):
        return session

    info = response.text or ""
    if "INVALID_CREDENTIALS" in info:
        raise RuntimeError(
            "Invalid credentials. Check username/email and password in user_config.json."
        )

    www_auth = response.headers.get("WWW-Authenticate", "")
    if response.status_code == 401 and www_auth == "persona":
        raise RuntimeError(
            "BRAIN requires biometric/persona authentication. Authenticate in "
            "your MCP/browser client first, then rerun this script or reuse the "
            "MCP client session."
        )

    raise RuntimeError(
        f"Authentication failed: HTTP {response.status_code} {response.text[:300]}"
    )

def retry_wait_seconds(retry_after: Optional[str], fallback: float) -> float:
    if not retry_after or retry_after in ("0", "0.0"):
        return fallback
    try:
        return max(0.0, float(retry_after))
    except (TypeError, ValueError):
        return fallback

def request_json(
    session: requests.Session,
    method: str,
    path_or_url: str,
    *,
    params: Any = None,
    payload: Any = None,
    allow_empty: bool = False,
) -> Any:
    url = path_or_url if path_or_url.startswith("http") else f"{BASE_URL}{path_or_url}"
    last_error: Optional[BaseException] = None

    for attempt in range(REQUEST_RETRIES):
        try:
            response = session.request(
                method,
                url,
                params=params,
                json=payload,
                timeout=REQUEST_TIMEOUT,
            )

            retry_after = response.headers.get("Retry-After")
            if retry_after and retry_after not in ("0", "0.0") and attempt < REQUEST_RETRIES - 1:
                wait = retry_wait_seconds(retry_after, REQUEST_RETRY_DELAY * (attempt + 1))
                time.sleep(wait)
                continue

            if response.status_code == 429 and attempt < REQUEST_RETRIES - 1:
                wait = retry_wait_seconds(retry_after, REQUEST_RETRY_DELAY * (attempt + 1))
                time.sleep(wait)
                continue

            response.raise_for_status()
            text = (response.text or "").strip()
            if not text:
                return {} if allow_empty else None
            return response.json()
        except Exception as exc:
            last_error = exc
            if attempt < REQUEST_RETRIES - 1:
                time.sleep(REQUEST_RETRY_DELAY * (attempt + 1))
                continue
            raise

    if last_error:
        raise last_error
    return None

def response_error_summary(response: requests.Response) -> str:
    text = (response.text or "").strip()
    if not text:
        return f"HTTP {response.status_code}"
    try:
        payload = response.json()
        if isinstance(payload, dict):
            detail = (
                payload.get("detail")
                or payload.get("message")
                or payload.get("error")
                or payload
            )
            return f"HTTP {response.status_code}: {detail}"
        return f"HTTP {response.status_code}: {payload}"
    except Exception:
        return f"HTTP {response.status_code}: {text[:500]}"

def patch_osmosis_points(
    session: requests.Session,
    alpha_id: str,
    points: Optional[int],
) -> PatchResult:
    payload = {"osmosisPoints": None if points is None else int(points)}
    url = f"{BASE_URL}/alphas/{alpha_id}"
    last_error = ""

    for attempt in range(PATCH_RETRIES):
        try:
            response = session.patch(url, json=payload, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            last_error = str(exc)
            if attempt < PATCH_RETRIES - 1:
                wait = PATCH_RETRY_DELAY * (attempt + 1)
                print(
                    f"\n    retry {attempt + 1}/{PATCH_RETRIES - 1} {alpha_id}: "
                    f"network error: {last_error[:180]} ; wait {wait:.1f}s",
                    end="",
                    flush=True,
                )
                time.sleep(wait)
                continue
            return PatchResult(alpha_id, points, None, False, last_error)

        retry_after = response.headers.get("Retry-After")
        if 200 <= response.status_code < 300:
            try:
                data = response.json() if (response.text or "").strip() else {}
            except Exception:
                data = {}
            confirmed = None if not isinstance(data, dict) else data.get("osmosisPoints")
            return PatchResult(alpha_id, points, confirmed, True)

        last_error = response_error_summary(response)
        retryable_status = response.status_code in PATCH_RETRY_STATUS_CODES
        if response.status_code == 400 and RETRY_BAD_REQUEST_PATCH:
            retryable_status = True

        if retryable_status and attempt < PATCH_RETRIES - 1:
            wait = retry_wait_seconds(retry_after, PATCH_RETRY_DELAY * (attempt + 1))
            print(
                f"\n    retry {attempt + 1}/{PATCH_RETRIES - 1} {alpha_id}: "
                f"{last_error[:220]} ; wait {wait:.1f}s",
                end="",
                flush=True,
            )
            time.sleep(wait)
            continue

        if response.status_code == 400 and not RETRY_BAD_REQUEST_PATCH:
            last_error = f"{last_error} (non-retryable 400)"
        return PatchResult(alpha_id, points, None, False, last_error)

    return PatchResult(alpha_id, points, None, False, last_error or "unknown patch error")

def alpha_query_params(
    region: str,
    delay: int,
    offset: int,
    limit: int,
    *,
    only_with_points: bool = False,
    use_date_filter: bool = True,
    hidden_filter: Optional[bool] = False,
    use_status_filter: bool = True,
) -> list[tuple[str, Any]]:
    params: list[tuple[str, Any]] = [
        ("limit", limit),
        ("offset", offset),
        ("settings.region", clean_region(region)),
        ("settings.delay", clean_delay(delay)),
        ("order", "-dateSubmitted"),
    ]
    if hidden_filter is not None:
        params.append(("hidden", "true" if hidden_filter else "false"))
    if use_status_filter:
        params.extend(
            [
                ("status!", "UNSUBMITTED"),
                ("status!", "IS_FAIL"),
            ]
        )
    if only_with_points:
        params.append(("osmosisPoints>", 0))
    if use_date_filter and MIN_DATE_SUBMITTED:
        params.append(("dateSubmitted>", f"{MIN_DATE_SUBMITTED}T00:00:00-04:00"))
    if use_date_filter and MAX_DATE_SUBMITTED:
        params.append(("dateSubmitted<", f"{MAX_DATE_SUBMITTED}T00:00:00-04:00"))
    return params

def fetch_scope_alphas(
    session: requests.Session,
    region: str,
    delay: int,
    *,
    only_with_points: bool = False,
    max_alpha_scan: int = MAX_ALPHA_SCAN,
    use_date_filter: bool = True,
    hidden_filter: Optional[bool] = False,
    use_status_filter: bool = True,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    limit = 100
    offset = 0

    while offset < max_alpha_scan:
        params = alpha_query_params(
            region,
            delay,
            offset,
            limit,
            only_with_points=only_with_points,
            use_date_filter=use_date_filter,
            hidden_filter=hidden_filter,
            use_status_filter=use_status_filter,
        )
        payload = request_json(session, "GET", "/users/self/alphas", params=params)
        if not isinstance(payload, dict):
            break

        results = payload.get("results") or []
        if not results:
            break
        rows.extend(results)

        count = to_int(payload.get("count"), 0)
        offset += len(results)
        if len(results) < limit or (count and offset >= count):
            break

    return rows[:max_alpha_scan]

def fetch_scope_alphas_all_visibility(
    session: requests.Session,
    region: str,
    delay: int,
    *,
    only_with_points: bool,
    max_alpha_scan: int = MAX_ALPHA_SCAN,
    use_date_filter: bool = False,
    use_status_filter: bool = False,
) -> list[dict[str, Any]]:
    """Fetch with hidden=false, hidden=true, and no hidden filter, then de-dupe.

    This is intentionally used for clearing/verifying current Osmosis points.
    A hidden scored alpha still counts toward platform totals, so a narrow
    hidden=false query can leave old points behind.
    """
    by_id: dict[str, dict[str, Any]] = {}
    for hidden_filter in (False, True, None):
        records = fetch_scope_alphas(
            session,
            region,
            delay,
            only_with_points=only_with_points,
            max_alpha_scan=max_alpha_scan,
            use_date_filter=use_date_filter,
            hidden_filter=hidden_filter,
            use_status_filter=use_status_filter,
        )
        for record in records:
            alpha_id = str(record.get("id") or "")
            if alpha_id:
                by_id[alpha_id] = record
    return list(by_id.values())

def alpha_code_blob(record: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("regular", "combo", "selection"):
        value = record.get(key)
        if isinstance(value, dict):
            for subkey in ("code", "description", "expression"):
                if value.get(subkey):
                    parts.append(str(value[subkey]))
        elif value:
            parts.append(str(value))
    return "\n".join(parts)

def alpha_signature(record: dict[str, Any]) -> str:
    settings = record.get("settings") or {}
    code = alpha_code_blob(record).lower()
    tokens = re.findall(r"[a-zA-Z_][a-zA-Z0-9_]*", code)
    ignored = {
        "rank",
        "ts_rank",
        "zscore",
        "group_neutralize",
        "winsorize",
        "scale",
        "ts_mean",
        "ts_std_dev",
        "ts_delay",
        "if_else",
        "and",
        "or",
        "not",
        "nan",
    }
    useful = [t for t in tokens if t not in ignored and len(t) > 2]
    top_tokens = sorted(set(useful[:80]))[:12]
    basis = [
        str(settings.get("universe", "")),
        str(settings.get("neutralization", "")),
        str(settings.get("decay", "")),
    ]
    return "|".join(basis + top_tokens)

def extract_alpha_type(record: dict[str, Any]) -> str:
    raw = str(record.get("type") or "").upper()
    if raw in ("REGULAR", "SUPER"):
        return raw
    if record.get("combo") or record.get("selection"):
        return "SUPER"
    return "REGULAR"

def extract_corr(record: dict[str, Any], kind: str) -> float:
    if kind == "self":
        names = (
            "selfCorrelation",
            "selfCorr",
            "self_corr",
            "maxSelfCorrelation",
            "maxSelfCorr",
        )
    else:
        names = (
            "prodCorrelation",
            "productionCorrelation",
            "prodCorr",
            "prod_corr",
            "maxProdCorrelation",
            "maxProdCorr",
        )

    value = first_present(record, names)
    if value is not None:
        return to_float(value)

    checks = record.get("checks")
    if isinstance(checks, list):
        for item in checks:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("result") or "").lower()
            if kind in name and "correlation" in name:
                value = first_present(
                    item,
                    ("value", "limit", "result", "max", "score", "correlation"),
                )
                parsed = to_float(value)
                if not math.isnan(parsed):
                    return parsed

    return math.nan

METRIC_KEYS = (
    "sharpe",
    "fitness",
    "returns",
    "turnover",
    "drawdown",
    "margin",
    "longCount",
    "shortCount",
)

def first_metric_block(record: dict[str, Any], names: Iterable[str]) -> dict[str, Any]:
    for name in names:
        value = record.get(name)
        if isinstance(value, dict):
            return value
    return {}

def metric_block_has_core_values(data: dict[str, Any]) -> bool:
    for key in ("sharpe", "fitness", "returns", "margin", "turnover", "drawdown"):
        if not math.isnan(to_float(data.get(key))):
            return True
    return False

def choose_metric_blocks(record: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], str]:
    is_data = first_metric_block(record, ("is", "IS", "inSample", "in_sample"))
    os_data = first_metric_block(record, ("os", "OS", "outOfSample", "out_of_sample", "oos", "OOS"))

    if metric_block_has_core_values(os_data):
        return os_data, is_data, os_data, "OS"
    return is_data, is_data, os_data, "IS"

def preferred_metric(preferred: dict[str, Any], fallback: dict[str, Any], key: str) -> float:
    value = to_float(preferred.get(key))
    if not math.isnan(value):
        return value
    return to_float(fallback.get(key))

def record_has_os_metrics(record: dict[str, Any]) -> bool:
    os_data = first_metric_block(record, ("os", "OS", "outOfSample", "out_of_sample", "oos", "OOS"))
    return metric_block_has_core_values(os_data)

def enrich_records_with_alpha_details_for_os(
    session: requests.Session,
    records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not FETCH_ALPHA_DETAILS_FOR_OS or not records:
        return records

    enriched: list[dict[str, Any]] = []
    fetched = 0
    needed = [record for record in records if not record_has_os_metrics(record)]
    if not needed:
        return records

    print(
        f"List payload lacks OS metrics for {len(needed)} records; "
        f"fetching alpha details for up to {ALPHA_DETAIL_FETCH_LIMIT} records..."
    )

    for record in records:
        if record_has_os_metrics(record) or fetched >= ALPHA_DETAIL_FETCH_LIMIT:
            enriched.append(record)
            continue

        alpha_id = str(record.get("id") or "")
        if not alpha_id:
            enriched.append(record)
            continue

        try:
            detail = request_json(session, "GET", f"/alphas/{alpha_id}")
        except Exception:
            detail = None

        if isinstance(detail, dict):
            merged = record.copy()
            merged.update(detail)
            enriched.append(merged)
        else:
            enriched.append(record)
        fetched += 1

        if fetched % 25 == 0:
            print(f"  fetched alpha details: {fetched}/{min(len(needed), ALPHA_DETAIL_FETCH_LIMIT)}")

    if len(needed) > ALPHA_DETAIL_FETCH_LIMIT:
        print(
            f"Detail fetch limit reached. Remaining {len(needed) - ALPHA_DETAIL_FETCH_LIMIT} "
            "records will use list payload metrics."
        )
    return enriched

def flatten_alpha(record: dict[str, Any]) -> dict[str, Any]:
    settings = record.get("settings") or {}
    metric_data, is_data, os_data, metric_source = choose_metric_blocks(record)
    alpha_id = str(record.get("id") or "")
    alpha_type = extract_alpha_type(record)
    region = clean_region(settings.get("region") or "")
    delay = to_int(settings.get("delay"), -1)

    return {
        "alpha_id": alpha_id,
        "type": alpha_type,
        "stage": record.get("stage"),
        "status": record.get("status"),
        "region": region,
        "delay": delay,
        "scope": scope_name(region, delay) if region and delay >= 0 else "",
        "dateSubmitted": record.get("dateSubmitted"),
        "dateCreated": record.get("dateCreated"),
        "color": record.get("color"),
        "osmosisPoints": to_float(record.get("osmosisPoints")),
        "metric_source": metric_source,
        "sharpe": preferred_metric(metric_data, is_data, "sharpe"),
        "fitness": preferred_metric(metric_data, is_data, "fitness"),
        "returns": preferred_metric(metric_data, is_data, "returns"),
        "turnover": preferred_metric(metric_data, is_data, "turnover"),
        "drawdown": preferred_metric(metric_data, is_data, "drawdown"),
        "margin": preferred_metric(metric_data, is_data, "margin"),
        "longCount": preferred_metric(metric_data, is_data, "longCount"),
        "shortCount": preferred_metric(metric_data, is_data, "shortCount"),
        "os_sharpe": to_float(os_data.get("sharpe")),
        "os_fitness": to_float(os_data.get("fitness")),
        "os_returns": to_float(os_data.get("returns")),
        "os_turnover": to_float(os_data.get("turnover")),
        "os_drawdown": to_float(os_data.get("drawdown")),
        "os_margin": to_float(os_data.get("margin")),
        "is_sharpe": to_float(is_data.get("sharpe")),
        "is_fitness": to_float(is_data.get("fitness")),
        "is_returns": to_float(is_data.get("returns")),
        "is_turnover": to_float(is_data.get("turnover")),
        "is_drawdown": to_float(is_data.get("drawdown")),
        "is_margin": to_float(is_data.get("margin")),
        "self_corr": extract_corr(record, "self"),
        "prod_corr": extract_corr(record, "prod"),
        "universe": settings.get("universe"),
        "neutralization": settings.get("neutralization"),
        "decay": settings.get("decay"),
        "truncation": settings.get("truncation"),
        "code_signature": alpha_signature(record),
        "raw": record,
    }

def rank01(series: pd.Series, higher_is_better: bool = True) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    if values.notna().sum() <= 1:
        return pd.Series(0.5, index=series.index)
    # pct rank should map the preferred side to values near 1.0:
    # higher_is_better=True  -> largest gets 1.0
    # higher_is_better=False -> smallest gets 1.0
    ranked = values.rank(pct=True, ascending=higher_is_better)
    return ranked.fillna(0.5).clip(0.0, 1.0)

def turnover_quality(value: Any) -> float:
    tv = to_float(value)
    if math.isnan(tv) or tv <= 0:
        return 0.45
    if 0.03 <= tv <= 0.30:
        return 1.0
    if 0.01 <= tv < 0.03:
        return 0.75 + 0.25 * (tv - 0.01) / 0.02
    if 0.30 < tv <= 0.60:
        return max(0.55, 1.0 - (tv - 0.30) / 0.30 * 0.45)
    if tv < 0.01:
        return max(0.35, tv / 0.01 * 0.75)
    return max(0.20, 0.55 - min(tv - 0.60, 1.0) * 0.35)

def corr_quality(row: pd.Series) -> float:
    vals = [
        to_float(row.get("self_corr")),
        to_float(row.get("prod_corr")),
    ]
    vals = [v for v in vals if not math.isnan(v)]
    if not vals:
        return 0.65
    worst = max(abs(v) for v in vals)
    return max(0.0, 1.0 - worst)

def add_base_scores(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    out = df.copy()
    out["turnover_quality"] = out["turnover"].map(turnover_quality)
    out["corr_quality"] = out.apply(corr_quality, axis=1)
    out["year_score"] = 0.50
    out["pnl_smoothness"] = 0.50

    scored_chunks: list[pd.DataFrame] = []
    for alpha_type, chunk in out.groupby("type", dropna=False):
        part = chunk.copy()
        sharpe_rank = rank01(part["sharpe"], True)
        fitness_rank = rank01(part["fitness"], True)
        returns_rank = rank01(part["returns"], True)
        margin_rank = rank01(part["margin"], True)
        drawdown_rank = rank01(part["drawdown"], False)
        turnover_rank = part["turnover_quality"].fillna(0.45)
        corr_rank = part["corr_quality"].fillna(0.65)

        if alpha_type == "SUPER":
            # SUPER is scored only inside the SUPER pool. Raw values are not
            # compared to REGULAR because SUPER metrics are often on a different
            # scale.
            part["is_quality"] = (
                0.38 * fitness_rank
                + 0.30 * sharpe_rank
                + 0.14 * returns_rank
                + 0.10 * drawdown_rank
                + 0.08 * margin_rank
            )
            part["base_quality_score"] = (
                0.45 * part["is_quality"]
                + 0.25 * turnover_rank
                + 0.20 * corr_rank
                + 0.10 * part["year_score"]
            )
        else:
            part["is_quality"] = (
                0.30 * sharpe_rank
                + 0.30 * fitness_rank
                + 0.15 * returns_rank
                + 0.15 * margin_rank
                + 0.10 * drawdown_rank
            )
            part["base_quality_score"] = (
                0.42 * part["is_quality"]
                + 0.24 * part["year_score"]
                + 0.20 * turnover_rank
                + 0.09 * corr_rank
                + 0.05 * rank01(part["longCount"].fillna(0) + part["shortCount"].fillna(0))
            )

        scored_chunks.append(part)

    scored = pd.concat(scored_chunks, ignore_index=True)
    scored["base_quality_score"] = scored["base_quality_score"].clip(0.0, 1.0)
    return scored

def add_filter_reasons(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    out = df.copy()
    out["filter_reason"] = ""

    invalid_status = out["status"].astype(str).str.upper().isin(["UNSUBMITTED", "IS_FAIL"])
    out.loc[invalid_status, "filter_reason"] += "bad_status;"

    wrong_scope = (out["region"] != clean_region(TARGET_REGION)) | (
        out["delay"] != clean_delay(TARGET_DELAY)
    )
    out.loc[wrong_scope, "filter_reason"] += "wrong_scope;"

    manual_excluded = out["alpha_id"].astype(str).isin(EXCLUDE_ALPHA_IDS)
    out.loc[manual_excluded, "filter_reason"] += "manual_exclude;"

    low_regular = (
        (out["type"] == "REGULAR")
        & (
            (out["sharpe"].fillna(-999) < REGULAR_MIN_SHARPE)
            | (out["fitness"].fillna(-999) < REGULAR_MIN_FITNESS)
        )
    )
    out.loc[low_regular, "filter_reason"] += "regular_low_is;"

    bad_drawdown = (
        (out["type"] == "REGULAR")
        & out["drawdown"].notna()
        & (out["drawdown"] > REGULAR_MAX_DRAWDOWN)
    )
    out.loc[bad_drawdown, "filter_reason"] += "high_drawdown;"

    high_self = out["self_corr"].notna() & (out["self_corr"].abs() > MAX_SELF_CORR)
    high_prod = out["prod_corr"].notna() & (out["prod_corr"].abs() > MAX_PROD_CORR)
    out.loc[high_self, "filter_reason"] += "high_self_corr;"
    out.loc[high_prod, "filter_reason"] += "high_prod_corr;"

    # SUPER filter is percentile/rank based, not absolute raw-metric based.
    super_mask = out["type"] == "SUPER"
    if super_mask.any():
        super_scores = out.loc[super_mask, "base_quality_score"]
        if super_scores.notna().sum() >= 4:
            cutoff = max(0.35, float(super_scores.quantile(0.25)))
            weak_super = super_mask & (out["base_quality_score"] < cutoff)
            out.loc[weak_super, "filter_reason"] += "super_bottom_quartile;"

    return out

def apply_hard_filters(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    out = add_filter_reasons(df)
    return out[out["filter_reason"] == ""].copy()

def payload_to_dataframe(payload: Any) -> pd.DataFrame:
    if payload is None:
        return pd.DataFrame()
    if isinstance(payload, list):
        return pd.DataFrame(payload)
    if isinstance(payload, dict):
        for key in ("records", "results", "data", "values"):
            value = payload.get(key)
            if isinstance(value, list):
                return pd.DataFrame(value)
        return pd.DataFrame([payload])
    return pd.DataFrame()

def fetch_recordset(
    session: requests.Session,
    alpha_id: str,
    name: str,
) -> Any:
    try:
        return request_json(
            session,
            "GET",
            f"/alphas/{alpha_id}/recordsets/{name}",
            allow_empty=True,
        )
    except Exception:
        return None

def parse_pnl_series(payload: Any) -> pd.Series:
    df = payload_to_dataframe(payload)
    if df.empty:
        return pd.Series(dtype=float)

    date_col = None
    for col in df.columns:
        if str(col).lower() in ("date", "day", "timestamp"):
            date_col = col
            break

    value_col = None
    preferred = ("pnl", "dailyPnl", "daily_pnl", "pnlDivTwo", "value")
    for name in preferred:
        if name in df.columns:
            value_col = name
            break
    if value_col is None:
        numeric_cols = [
            c for c in df.columns if pd.to_numeric(df[c], errors="coerce").notna().sum() > 5
        ]
        if numeric_cols:
            value_col = numeric_cols[0]

    if value_col is None:
        return pd.Series(dtype=float)

    values = pd.to_numeric(df[value_col], errors="coerce")
    if date_col is not None:
        index = pd.to_datetime(df[date_col], errors="coerce")
        series = pd.Series(values.values, index=index).dropna()
        series = series[~series.index.isna()]
    else:
        series = pd.Series(values.values).dropna()

    if len(series) < 8:
        return pd.Series(dtype=float)

    daily = series.diff().dropna()
    if daily.std() == 0 or len(daily) < 8:
        return series.dropna()
    return daily

def parse_year_score(payload: Any) -> float:
    df = payload_to_dataframe(payload)
    if df.empty:
        return 0.50

    sharpe_col = None
    for col in df.columns:
        if "sharpe" in str(col).lower():
            sharpe_col = col
            break
    if sharpe_col is None:
        return 0.50

    sharpe = pd.to_numeric(df[sharpe_col], errors="coerce").dropna()
    if sharpe.empty:
        return 0.50

    recent = sharpe.tail(4)
    mean_score = max(0.0, min(1.0, (recent.mean() + 1.0) / 4.0))
    positive_ratio = float((recent > 0).mean())
    std = float(recent.std(ddof=0)) if len(recent) > 1 else 0.0
    std_score = max(0.0, min(1.0, 1.0 - std / 3.0))
    trend_score = 0.50
    if len(recent) >= 2:
        trend_score = 0.65 if recent.iloc[-1] >= recent.iloc[0] else 0.35

    return (
        0.35 * mean_score
        + 0.25 * positive_ratio
        + 0.20 * std_score
        + 0.20 * trend_score
    )

def recursive_corr_values(obj: Any) -> list[float]:
    vals: list[float] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_l = str(key).lower()
            if any(token in key_l for token in ("corr", "correlation", "value", "max")):
                num = to_float(value)
                if not math.isnan(num) and -1.0 <= num <= 1.0:
                    vals.append(abs(num))
            vals.extend(recursive_corr_values(value))
    elif isinstance(obj, list):
        for item in obj:
            vals.extend(recursive_corr_values(item))
    return vals

def fetch_external_corr(session: requests.Session, alpha_id: str, kind: str) -> float:
    endpoint = "self" if kind == "self" else "prod"
    try:
        payload = request_json(session, "GET", f"/alphas/{alpha_id}/correlations/{endpoint}")
    except Exception:
        return math.nan
    vals = recursive_corr_values(payload)
    return max(vals) if vals else math.nan

def enrich_top_candidates(session: requests.Session, df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    out = df.copy()
    out["pnl_series"] = None

    top_ids: set[str] = set()
    for _, chunk in out.groupby("type"):
        top = chunk.sort_values("base_quality_score", ascending=False).head(
            PRESELECT_LIMIT_PER_TYPE
        )
        top_ids.update(top["alpha_id"].astype(str).tolist())

    print(f"Enriching {len(top_ids)} top candidates with optional recordsets...")
    for index, row in out.iterrows():
        alpha_id = str(row["alpha_id"])
        if alpha_id not in top_ids:
            continue

        if FETCH_YEARLY_STATS:
            payload = fetch_recordset(session, alpha_id, "yearly-stats")
            out.at[index, "year_score"] = parse_year_score(payload)

        if FETCH_PNL_FOR_DIVERSITY:
            payload = fetch_recordset(session, alpha_id, "pnl")
            out.at[index, "pnl_series"] = parse_pnl_series(payload)

        if FETCH_EXTERNAL_CORRELATIONS:
            if math.isnan(to_float(row.get("self_corr"))):
                out.at[index, "self_corr"] = fetch_external_corr(session, alpha_id, "self")
            if math.isnan(to_float(row.get("prod_corr"))):
                out.at[index, "prod_corr"] = fetch_external_corr(session, alpha_id, "prod")

    # Re-score after yearly/correlation enrichment. Keep pnl_series intact.
    pnl_map = out.set_index("alpha_id")["pnl_series"].to_dict()
    rescored = add_base_scores(out.drop(columns=["pnl_series"], errors="ignore"))
    rescored["pnl_series"] = rescored["alpha_id"].map(pnl_map)
    return rescored

def build_corr_matrix(df: pd.DataFrame) -> pd.DataFrame:
    series_map: dict[str, pd.Series] = {}
    for _, row in df.iterrows():
        alpha_id = str(row["alpha_id"])
        series = row.get("pnl_series")
        if isinstance(series, pd.Series) and len(series.dropna()) >= 8:
            series_map[alpha_id] = series.dropna()

    if len(series_map) < 2:
        return pd.DataFrame()

    aligned = pd.DataFrame(series_map)
    aligned = aligned.dropna(axis=0, thresh=max(2, int(len(series_map) * 0.35)))
    if aligned.empty:
        return pd.DataFrame()
    return aligned.corr().abs().fillna(0.0)

def code_similarity(sig_a: str, sig_b: str) -> float:
    set_a = set(str(sig_a).split("|"))
    set_b = set(str(sig_b).split("|"))
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)

def max_selected_corr(
    row: pd.Series,
    selected: list[pd.Series],
    corr_matrix: pd.DataFrame,
) -> float:
    if not selected:
        return 0.0
    alpha_id = str(row["alpha_id"])
    vals: list[float] = []
    for sel in selected:
        sid = str(sel["alpha_id"])
        if (
            not corr_matrix.empty
            and alpha_id in corr_matrix.index
            and sid in corr_matrix.columns
        ):
            vals.append(float(corr_matrix.loc[alpha_id, sid]))
        else:
            vals.append(code_similarity(row.get("code_signature"), sel.get("code_signature")))
    return max(vals) if vals else 0.0

def greedy_select(
    df: pd.DataFrame,
    target_count: int,
    max_count: int,
    corr_matrix: pd.DataFrame,
) -> pd.DataFrame:
    if df.empty or target_count <= 0:
        return pd.DataFrame(columns=df.columns)

    candidates = df.sort_values("base_quality_score", ascending=False).copy()
    selected: list[pd.Series] = []
    skipped: list[pd.Series] = []

    for _, row in candidates.iterrows():
        if len(selected) >= max_count:
            break
        max_corr = max_selected_corr(row, selected, corr_matrix)
        if max_corr <= MAX_PNL_CORR:
            row = row.copy()
            row["diversity_penalty"] = max(0.0, max_corr - SOFT_PNL_CORR)
            selected.append(row)
        else:
            skipped.append(row)
        if len(selected) >= target_count:
            break

    if len(selected) < target_count:
        for row in skipped:
            if len(selected) >= min(target_count, max_count):
                break
            row = row.copy()
            row["diversity_penalty"] = 0.25
            selected.append(row)

    if not selected:
        return pd.DataFrame(columns=df.columns)
    result = pd.DataFrame(selected)
    result["selection_rank"] = range(1, len(result) + 1)
    return result

def choose_type_counts(df: pd.DataFrame) -> tuple[int, int]:
    regular_available = int((df["type"] == "REGULAR").sum())
    super_available = int((df["type"] == "SUPER").sum())
    if regular_available == 0:
        return 0, min(MAX_ALPHA_COUNT, super_available)
    if super_available == 0:
        return min(MAX_ALPHA_COUNT, regular_available), 0

    super_target = min(
        SUPER_MAX_ALPHA_COUNT,
        max(1, round(TARGET_ALPHA_COUNT * SUPER_POINT_SHARE)),
        super_available,
    )
    regular_target = min(
        MAX_ALPHA_COUNT - super_target,
        max(MIN_ALPHA_COUNT, TARGET_ALPHA_COUNT - super_target),
        regular_available,
    )

    total = regular_target + super_target
    if total < MIN_ALPHA_COUNT:
        need = MIN_ALPHA_COUNT - total
        can_add_regular = max(0, regular_available - regular_target)
        add_regular = min(need, can_add_regular)
        regular_target += add_regular
        need -= add_regular
        if need > 0:
            can_add_super = max(0, super_available - super_target)
            super_target += min(need, can_add_super, SUPER_MAX_ALPHA_COUNT - super_target)

    return regular_target, super_target

def select_portfolio(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    regular_target, super_target = choose_type_counts(df)
    selected_chunks: list[pd.DataFrame] = []

    for alpha_type, target in (("REGULAR", regular_target), ("SUPER", super_target)):
        pool = df[df["type"] == alpha_type].copy()
        if pool.empty or target <= 0:
            continue
        max_count = MAX_ALPHA_COUNT if alpha_type == "REGULAR" else SUPER_MAX_ALPHA_COUNT
        corr_matrix = build_corr_matrix(pool)
        selected_chunks.append(greedy_select(pool, target, max_count, corr_matrix))

    if not selected_chunks:
        return pd.DataFrame(columns=df.columns)

    selected = pd.concat(selected_chunks, ignore_index=True)
    selected["adjusted_quality"] = (
        selected["base_quality_score"].astype(float)
        * (1.0 - selected.get("diversity_penalty", 0).fillna(0.0).clip(0.0, 0.6))
    ).clip(0.01, 1.0)

    selected = selected.sort_values(
        ["type", "adjusted_quality"], ascending=[True, False]
    ).reset_index(drop=True)
    selected["selection_reason"] = "primary"
    return selected

def relaxed_fill_candidates(all_scored: pd.DataFrame, selected: pd.DataFrame) -> pd.DataFrame:
    if all_scored.empty:
        return all_scored

    selected_ids = set(selected.get("alpha_id", pd.Series(dtype=str)).astype(str))
    pool = all_scored[~all_scored["alpha_id"].astype(str).isin(selected_ids)].copy()
    if pool.empty:
        return pool

    if "filter_reason" not in pool.columns:
        pool = add_filter_reasons(pool)

    valid_scope = (pool["region"] == clean_region(TARGET_REGION)) & (
        pool["delay"] == clean_delay(TARGET_DELAY)
    )
    valid_status = ~pool["status"].astype(str).str.upper().isin(["UNSUBMITTED", "IS_FAIL"])
    pool = pool[valid_scope & valid_status].copy()
    if pool.empty:
        return pool

    regular_relaxed = (
        (pool["type"] != "REGULAR")
        | (
            (pool["sharpe"].fillna(-999) >= RELAXED_REGULAR_MIN_SHARPE)
            & (pool["fitness"].fillna(-999) >= RELAXED_REGULAR_MIN_FITNESS)
            & (
                pool["drawdown"].isna()
                | (pool["drawdown"] <= RELAXED_REGULAR_MAX_DRAWDOWN)
            )
        )
    )
    corr_relaxed = (
        (pool["self_corr"].isna() | (pool["self_corr"].abs() <= MAX_SELF_CORR))
        & (pool["prod_corr"].isna() | (pool["prod_corr"].abs() <= MAX_PROD_CORR))
    )
    pool["relaxed_pass"] = regular_relaxed & corr_relaxed

    # Prefer candidates that only failed the strict threshold, then sort by score.
    pool["fill_sort_score"] = pool["base_quality_score"].fillna(0.0)
    pool.loc[~pool["relaxed_pass"], "fill_sort_score"] *= 0.55
    pool.loc[pool["filter_reason"].astype(str).str.contains("high_self_corr|high_prod_corr"), "fill_sort_score"] *= 0.35
    pool.loc[pool["filter_reason"].astype(str).str.contains("high_drawdown"), "fill_sort_score"] *= 0.70

    return pool.sort_values(
        ["relaxed_pass", "fill_sort_score", "base_quality_score"],
        ascending=[False, False, False],
    )

def ensure_minimum_selection(selected: pd.DataFrame, all_scored: pd.DataFrame) -> pd.DataFrame:
    if not FILL_TO_MIN_ALPHA_COUNT or len(selected) >= MIN_ALPHA_COUNT:
        return selected

    needed = min(MIN_ALPHA_COUNT - len(selected), MAX_ALPHA_COUNT - len(selected))
    if needed <= 0:
        return selected

    pool = relaxed_fill_candidates(all_scored, selected)
    if pool.empty:
        return selected

    selected_chunks = [selected.copy()]
    selected_super_count = int((selected["type"] == "SUPER").sum()) if not selected.empty else 0
    fillers: list[pd.Series] = []

    # First pass respects SUPER_MAX_ALPHA_COUNT.
    for _, row in pool.iterrows():
        if len(fillers) >= needed:
            break
        if row.get("type") == "SUPER" and selected_super_count >= SUPER_MAX_ALPHA_COUNT:
            continue
        row = row.copy()
        row["selection_reason"] = "filler"
        row["diversity_penalty"] = max(float(row.get("diversity_penalty", 0) or 0), 0.35)
        row["adjusted_quality"] = max(
            0.01,
            float(row.get("base_quality_score", 0.01) or 0.01) * FILLER_QUALITY_DISCOUNT,
        )
        fillers.append(row)
        if row.get("type") == "SUPER":
            selected_super_count += 1

    # If there are still fewer than 10 and only SUPER remains, add them anyway.
    if len(fillers) < needed:
        used = set(str(row["alpha_id"]) for row in fillers)
        for _, row in pool.iterrows():
            if len(fillers) >= needed:
                break
            if str(row["alpha_id"]) in used:
                continue
            row = row.copy()
            row["selection_reason"] = "filler"
            row["diversity_penalty"] = max(float(row.get("diversity_penalty", 0) or 0), 0.45)
            row["adjusted_quality"] = max(
                0.01,
                float(row.get("base_quality_score", 0.01) or 0.01) * FILLER_QUALITY_DISCOUNT,
            )
            fillers.append(row)

    if not fillers:
        return selected

    filler_df = pd.DataFrame(fillers)
    selected_chunks.append(filler_df)
    out = pd.concat(selected_chunks, ignore_index=True)
    out = out.drop_duplicates(subset=["alpha_id"], keep="first")
    out = out.sort_values(
        ["selection_reason", "adjusted_quality"],
        ascending=[False, False],
    ).reset_index(drop=True)
    print(
        f"Primary selection had {len(selected)} alphas; added "
        f"{len(out) - len(selected)} filler alphas to reach minimum {MIN_ALPHA_COUNT}."
    )
    return out

def largest_remainder(weights: list[float], total: int) -> list[int]:
    if not weights:
        return []
    clean = [max(0.0, float(w)) for w in weights]
    s = sum(clean)
    if s <= 0:
        base = total // len(clean)
        result = [base] * len(clean)
        result[-1] += total - sum(result)
        return result

    quotas = [w / s * total for w in clean]
    floors = [int(math.floor(q)) for q in quotas]
    remain = total - sum(floors)
    order = sorted(
        range(len(quotas)),
        key=lambda i: (quotas[i] - floors[i], quotas[i]),
        reverse=True,
    )
    for i in range(remain):
        floors[order[i % len(order)]] += 1
    return floors

def allocate_with_caps(
    weights: list[float],
    total: int,
    *,
    min_points: int,
    max_points: int,
) -> list[int]:
    n = len(weights)
    if n == 0:
        return []
    if total <= 0:
        return [0] * n

    min_points = min(min_points, total // n)
    max_points = max(max_points, min_points)
    if max_points * n < total:
        max_points = math.ceil(total / n)

    allocated = [min_points] * n
    remaining_total = total - sum(allocated)
    if remaining_total <= 0:
        allocated[-1] += total - sum(allocated)
        return allocated

    capacity = [max_points - min_points] * n
    active = [i for i, cap in enumerate(capacity) if cap > 0]
    clean_weights = [max(0.0, float(w)) for w in weights]

    while active and remaining_total > 0:
        sub_weights = [clean_weights[i] for i in active]
        proposal = largest_remainder(sub_weights, remaining_total)
        changed = False
        next_active: list[int] = []
        overflow = 0

        for idx, extra in zip(active, proposal):
            give = min(extra, capacity[idx])
            allocated[idx] += give
            capacity[idx] -= give
            overflow += extra - give
            changed = changed or give > 0
            if capacity[idx] > 0:
                next_active.append(idx)

        new_remaining = total - sum(allocated)
        if not changed or new_remaining == remaining_total:
            break
        remaining_total = new_remaining + overflow
        remaining_total = total - sum(allocated)
        active = next_active

    diff = total - sum(allocated)
    if diff > 0:
        order = sorted(range(n), key=lambda i: clean_weights[i], reverse=True)
        for idx in order:
            add = min(diff, max_points - allocated[idx])
            if add > 0:
                allocated[idx] += add
                diff -= add
            if diff == 0:
                break
    elif diff < 0:
        order = sorted(range(n), key=lambda i: clean_weights[i])
        need = -diff
        for idx in order:
            take = min(need, allocated[idx] - min_points)
            if take > 0:
                allocated[idx] -= take
                need -= take
            if need == 0:
                break

    if sum(allocated) != total:
        allocated[-1] += total - sum(allocated)
    return allocated

def rank_decay_weights(n: int) -> list[float]:
    if n <= 0:
        return []
    if n == 1:
        return [1.0]
    return [math.exp(-i / max(3.0, n / 3.0)) for i in range(n)]

def add_points(selected: pd.DataFrame) -> pd.DataFrame:
    if selected.empty:
        return selected

    out = selected.copy()
    counts = out["type"].value_counts().to_dict()
    has_regular = counts.get("REGULAR", 0) > 0
    has_super = counts.get("SUPER", 0) > 0

    if has_regular and has_super:
        super_budget = int(round(TOTAL_POINTS * SUPER_POINT_SHARE))
        regular_budget = TOTAL_POINTS - super_budget
        min_regular_budget = int(round(TOTAL_POINTS * REGULAR_MIN_POINT_SHARE))
        if regular_budget < min_regular_budget:
            regular_budget = min_regular_budget
            super_budget = TOTAL_POINTS - regular_budget
    elif has_super:
        regular_budget = 0
        super_budget = TOTAL_POINTS
    else:
        regular_budget = TOTAL_POINTS
        super_budget = 0

    out["osmosis_new"] = 0
    for alpha_type, budget, max_points in (
        ("REGULAR", regular_budget, REGULAR_MAX_POINTS_PER_ALPHA),
        ("SUPER", super_budget, SUPER_MAX_POINTS_PER_ALPHA),
    ):
        mask = out["type"] == alpha_type
        part = out[mask].sort_values("adjusted_quality", ascending=False)
        if part.empty or budget <= 0:
            continue

        q = part["adjusted_quality"].astype(float).tolist()
        rank_w = rank_decay_weights(len(part))
        weights = [0.70 * q_i + 0.30 * r_i for q_i, r_i in zip(q, rank_w)]
        points = allocate_with_caps(
            weights,
            budget,
            min_points=MIN_POINTS_PER_ALPHA,
            max_points=max_points,
        )
        out.loc[part.index, "osmosis_new"] = points

    total = int(out["osmosis_new"].sum())
    if total != TOTAL_POINTS and not out.empty:
        best_idx = out["adjusted_quality"].astype(float).idxmax()
        out.loc[best_idx, "osmosis_new"] += TOTAL_POINTS - total

    return out.sort_values("osmosis_new", ascending=False).reset_index(drop=True)

def allocation_report_columns(df: pd.DataFrame) -> pd.DataFrame:
    keep = [
        "alpha_id",
        "type",
        "selection_reason",
        "filter_reason",
        "osmosis_new",
        "metric_source",
        "adjusted_quality",
        "base_quality_score",
        "year_score",
        "sharpe",
        "fitness",
        "returns",
        "margin",
        "turnover",
        "drawdown",
        "os_sharpe",
        "os_fitness",
        "os_returns",
        "os_margin",
        "os_turnover",
        "os_drawdown",
        "is_sharpe",
        "is_fitness",
        "is_returns",
        "is_margin",
        "is_turnover",
        "is_drawdown",
        "self_corr",
        "prod_corr",
        "universe",
        "neutralization",
        "decay",
        "dateSubmitted",
    ]
    existing = [c for c in keep if c in df.columns]
    return df[existing].copy()

def write_report(all_df: pd.DataFrame, selected: pd.DataFrame) -> Path:
    stamp = now_stamp()
    report_path = SCRIPT_DIR / (
        f"osmosis_report_{clean_region(TARGET_REGION)}_D{clean_delay(TARGET_DELAY)}_{stamp}.csv"
    )

    all_out = all_df.drop(columns=["raw", "pnl_series"], errors="ignore").copy()
    all_out["selected"] = all_out["alpha_id"].isin(set(selected["alpha_id"]))
    selected_points = selected.set_index("alpha_id")["osmosis_new"].to_dict()
    all_out["osmosis_new"] = all_out["alpha_id"].map(selected_points).fillna(0).astype(int)
    all_out.to_csv(report_path, index=False, encoding="utf-8-sig")
    return report_path

def print_plan(selected: pd.DataFrame, report_path: Path) -> None:
    print()
    print(f"Scope: {scope_name(TARGET_REGION, TARGET_DELAY)}")
    print(f"Selected alphas: {len(selected)}")
    print(f"Total points: {int(selected['osmosis_new'].sum()):,}")
    print(f"Report: {report_path}")
    print()

    table = allocation_report_columns(selected)
    if not table.empty:
        table = table.copy()
        for col in (
            "adjusted_quality",
            "base_quality_score",
            "year_score",
            "sharpe",
            "fitness",
            "returns",
            "margin",
            "turnover",
            "drawdown",
            "os_sharpe",
            "os_fitness",
            "os_returns",
            "os_margin",
            "os_turnover",
            "os_drawdown",
            "is_sharpe",
            "is_fitness",
            "is_returns",
            "is_margin",
            "is_turnover",
            "is_drawdown",
            "self_corr",
            "prod_corr",
        ):
            if col in table.columns:
                table[col] = pd.to_numeric(table[col], errors="coerce").round(4)
        print(table.to_string(index=False))
        print()

def print_super_audit(all_df: pd.DataFrame, selected: pd.DataFrame, top_n: int = 15) -> None:
    if all_df.empty or "type" not in all_df.columns:
        return
    super_df = all_df[all_df["type"] == "SUPER"].copy()
    if super_df.empty:
        return

    selected_points = selected.set_index("alpha_id")["osmosis_new"].to_dict() if not selected.empty else {}
    selected_reasons = selected.set_index("alpha_id")["selection_reason"].to_dict() if not selected.empty and "selection_reason" in selected.columns else {}
    super_df["selected"] = super_df["alpha_id"].isin(set(selected_points))
    super_df["osmosis_new"] = super_df["alpha_id"].map(selected_points).fillna(0).astype(int)
    super_df["selection_reason"] = super_df["alpha_id"].map(selected_reasons).fillna("")

    cols = [
        "alpha_id",
        "selected",
        "osmosis_new",
        "selection_reason",
        "filter_reason",
        "metric_source",
        "sharpe",
        "fitness",
        "returns",
        "margin",
        "turnover",
        "drawdown",
        "base_quality_score",
        "adjusted_quality",
    ]
    cols = [c for c in cols if c in super_df.columns]
    display = super_df.sort_values(["sharpe", "fitness"], ascending=[False, False]).head(top_n)[cols].copy()
    for col in (
        "sharpe",
        "fitness",
        "returns",
        "margin",
        "turnover",
        "drawdown",
        "base_quality_score",
        "adjusted_quality",
    ):
        if col in display.columns:
            display[col] = pd.to_numeric(display[col], errors="coerce").round(4)

    print("Top SUPER candidates by selected metric sharpe:")
    print(display.to_string(index=False))
    print()

def confirm(prompt: str) -> bool:
    if not CONFIRM_BEFORE_WRITE:
        return True
    answer = input(f"{prompt} Type y/yes to continue: ").strip().lower()
    return answer in {"y", "yes"}

def clear_existing_points(session: requests.Session) -> None:
    print(f"Fetching current scored alphas in {scope_name(TARGET_REGION, TARGET_DELAY)}...")
    records = fetch_scope_alphas_all_visibility(
        session,
        TARGET_REGION,
        TARGET_DELAY,
        only_with_points=True,
        max_alpha_scan=MAX_ALPHA_SCAN,
        use_date_filter=CLEAR_USE_DATE_FILTER,
        use_status_filter=False,
    )
    df = pd.DataFrame(flatten_alpha(item) for item in records)
    if df.empty:
        print("No existing osmosis points found.")
        return
    df = df[df["osmosisPoints"].notna()].copy()
    df = df[df["osmosisPoints"] > 0].copy()
    if df.empty:
        print("No existing osmosis points found.")
        return

    print(f"Found {len(df)} alphas with current points. Sum={int(df['osmosisPoints'].sum()):,}")
    if not WRITE_TO_PLATFORM:
        print("WRITE_TO_PLATFORM is False. Clear skipped.")
        return
    if not confirm("Clear existing osmosis points?"):
        print("Clear cancelled.")
        return

    ok = 0
    failed = 0
    for i, row in enumerate(df.itertuples(index=False), 1):
        alpha_id = str(row.alpha_id)
        old_points = int(row.osmosisPoints)
        print(f"  [{i}/{len(df)}] clear {alpha_id} old={old_points} ... ", end="", flush=True)
        result = patch_osmosis_points(session, alpha_id, None)
        if result.ok:
            ok += 1
            print("ok")
        else:
            failed += 1
            print(f"failed: {result.error[:160]}")
    print(f"Clear done. ok={ok}, failed={failed}")

def verify_current_scope_points(
    session: requests.Session,
    selected_ids: Optional[set[str]] = None,
) -> None:
    print()
    print(f"Verifying current scored alphas in {scope_name(TARGET_REGION, TARGET_DELAY)}...")
    records = fetch_scope_alphas_all_visibility(
        session,
        TARGET_REGION,
        TARGET_DELAY,
        only_with_points=True,
        max_alpha_scan=MAX_ALPHA_SCAN,
        use_date_filter=False,
        use_status_filter=False,
    )
    df = pd.DataFrame(flatten_alpha(item) for item in records)
    if df.empty:
        print("Verify result: no current osmosis points found.")
        return

    df = df[df["osmosisPoints"].notna()].copy()
    df = df[df["osmosisPoints"] > 0].copy()
    total = int(df["osmosisPoints"].sum()) if not df.empty else 0
    print(f"Verify result: {len(df)} scored alphas, platform sum={total:,}")

    if selected_ids:
        extra = df[~df["alpha_id"].astype(str).isin(selected_ids)].copy()
        if not extra.empty:
            print("Scored alphas not in this allocation plan, likely residual points:")
            cols = ["alpha_id", "type", "osmosisPoints", "status", "dateSubmitted"]
            cols = [c for c in cols if c in extra.columns]
            print(extra[cols].sort_values("osmosisPoints", ascending=False).to_string(index=False))

    if total != TOTAL_POINTS:
        print(
            f"WARNING: platform sum is {total:,}, expected {TOTAL_POINTS:,}. "
            "Run ACTION='clear' if residual points remain, then allocate again."
        )

def write_allocation(session: requests.Session, selected: pd.DataFrame) -> None:
    if selected.empty:
        print("No selected alphas to write.")
        return
    if int(selected["osmosis_new"].sum()) != TOTAL_POINTS:
        raise RuntimeError("Internal error: selected points do not sum to TOTAL_POINTS.")
    if not WRITE_TO_PLATFORM:
        print("WRITE_TO_PLATFORM is False. Allocation write skipped.")
        return
    if not confirm("Write new osmosis allocation?"):
        print("Write cancelled.")
        return

    ok = 0
    failed = 0
    success_results: dict[str, PatchResult] = {}
    failed_results: list[PatchResult] = []
    rows = selected.sort_values("osmosis_new", ascending=False).itertuples(index=False)
    total_rows = len(selected)
    for i, row in enumerate(rows, 1):
        alpha_id = str(row.alpha_id)
        points = int(row.osmosis_new)
        print(f"  [{i}/{total_rows}] write {alpha_id}={points} ... ", end="", flush=True)
        result = patch_osmosis_points(session, alpha_id, points)
        if result.ok:
            ok += 1
            success_results[alpha_id] = result
            print(f"ok confirmed={result.confirmed}")
        else:
            failed += 1
            failed_results.append(result)
            print(f"failed: {result.error[:160]}")

    if failed_results and REDISTRIBUTE_FAILED_POINTS and success_results:
        failed_points = sum(int(r.requested or 0) for r in failed_results)
        print()
        print(
            f"First pass left {failed_points:,} points on {len(failed_results)} failed "
            f"alphas. Redistributing to {len(success_results)} writable alphas..."
        )

        success_ids = set(success_results)
        success_df = selected[selected["alpha_id"].astype(str).isin(success_ids)].copy()
        success_df = add_points(success_df)

        redistribute_ops: list[tuple[str, int, int]] = []
        old_by_id = {}
        for alpha_id, result in success_results.items():
            confirmed = to_int(result.confirmed, to_int(result.requested, 0))
            old_by_id[alpha_id] = confirmed

        for row in success_df.itertuples(index=False):
            alpha_id = str(row.alpha_id)
            new_points = int(row.osmosis_new)
            old_points = old_by_id.get(alpha_id, 0)
            if new_points != old_points:
                redistribute_ops.append((alpha_id, old_points, new_points))

        if not redistribute_ops:
            print("Redistribution produced no extra writes.")
        else:
            redist_ok = 0
            redist_failed = 0
            for i, (alpha_id, old_points, new_points) in enumerate(redistribute_ops, 1):
                print(
                    f"  [redistribute {i}/{len(redistribute_ops)}] "
                    f"{alpha_id}: {old_points} -> {new_points} ... ",
                    end="",
                    flush=True,
                )
                result = patch_osmosis_points(session, alpha_id, new_points)
                if result.ok:
                    redist_ok += 1
                    success_results[alpha_id] = result
                    print(f"ok confirmed={result.confirmed}")
                else:
                    redist_failed += 1
                    print(f"failed: {result.error[:160]}")

            final_confirmed_sum = 0
            for result in success_results.values():
                final_confirmed_sum += to_int(result.confirmed, to_int(result.requested, 0))
            print(
                f"Redistribution done. ok={redist_ok}, failed={redist_failed}, "
                f"confirmed writable sum~={final_confirmed_sum:,}"
            )

    elif failed_results and not success_results:
        print("All writes failed; nothing available for redistribution.")

    print(f"Write done. first_pass_ok={ok}, first_pass_failed={failed}")
    verify_current_scope_points(session, set(selected["alpha_id"].astype(str)))

def build_allocation_plan(session: requests.Session) -> tuple[pd.DataFrame, pd.DataFrame, Path]:
    print(f"Fetching candidates in {scope_name(TARGET_REGION, TARGET_DELAY)}...")
    records = fetch_scope_alphas(
        session,
        TARGET_REGION,
        TARGET_DELAY,
        only_with_points=False,
        max_alpha_scan=MAX_ALPHA_SCAN,
    )
    if not records:
        raise RuntimeError("No candidates returned by API for this region/delay.")

    records = enrich_records_with_alpha_details_for_os(session, records)
    all_df = pd.DataFrame(flatten_alpha(item) for item in records)
    all_df = add_base_scores(all_df)
    all_df = add_filter_reasons(all_df)
    eligible = all_df[all_df["filter_reason"] == ""].copy()
    print(f"Candidates fetched={len(all_df)}, eligible after hard filters={len(eligible)}")
    print(
        "Eligible by type: "
        + json.dumps(eligible["type"].value_counts().to_dict(), ensure_ascii=False)
    )

    if eligible.empty:
        enriched = eligible.copy()
        eligible2 = eligible.copy()
        all_for_fill = all_df.copy()
    else:
        enriched = enrich_top_candidates(session, eligible)
        enriched = add_filter_reasons(enriched)
        eligible2 = enriched[enriched["filter_reason"] == ""].copy()
        enriched_ids = set(enriched["alpha_id"].astype(str))
        all_for_fill = pd.concat(
            [enriched, all_df[~all_df["alpha_id"].astype(str).isin(enriched_ids)]],
            ignore_index=True,
        )
    selected = select_portfolio(eligible2)
    selected = ensure_minimum_selection(selected, all_for_fill)
    selected = add_points(selected)

    if selected.empty:
        report_path = write_report(all_for_fill, selected)
        raise RuntimeError(f"No selected candidates. See {report_path}")

    report_path = write_report(all_for_fill, selected)
    return all_for_fill, selected, report_path

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "WorldQuant BRAIN Osmosis allocator. Scope is one region/delay pair."
        ),
        epilog=(
            "With no flags the script uses the TARGET_REGION / TARGET_DELAY "
            "constants at the top of this file, so old invocations are unchanged. "
            "ACTION and WRITE_TO_PLATFORM default to the file constants; "
            "--allocate and --preview override both, and --preview wins. "
            "Thresholds and ACTION='clear' are file-only."
        ),
    )
    parser.add_argument(
        "--region",
        default=_DEFAULT_REGION,
        metavar="REGION",
        help="Region to allocate in, e.g. USA, EUR, CHN, GLB (default: %(default)s).",
    )
    parser.add_argument(
        "--delay",
        type=int,
        choices=(0, 1),
        default=_DEFAULT_DELAY,
        help="Data delay (default: %(default)s).",
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help=(
            "Force a dry run: pin ACTION to 'preview' and WRITE_TO_PLATFORM to "
            "False no matter what the file says. Reads the platform and writes "
            "the CSV report, never clears or writes Osmosis points. This flag "
            "is one-way; there is no command line switch that enables writing."
        ),
    )
    parser.add_argument(
        "--allocate",
        action="store_true",
        help=(
            "Live run: set ACTION to 'allocate' and WRITE_TO_PLATFORM to True, "
            "so the script CLEARS the current Osmosis points in this scope and "
            "writes the new plan via PATCH. The interactive y/yes confirmations "
            "still apply and cannot be skipped from the command line. If both "
            "--allocate and --preview are given, --preview wins."
        ),
    )
    return parser.parse_args(argv)

def apply_cli_overrides(args: argparse.Namespace) -> None:
    """Rebind the settings globals. Every consumer reads them at call time.

    --preview is applied last so it always wins over --allocate: a run can be
    tightened into a dry run by accident, never loosened into a live write.
    """
    global TARGET_REGION, TARGET_DELAY, ACTION, WRITE_TO_PLATFORM
    TARGET_REGION = clean_region(args.region)
    TARGET_DELAY = clean_delay(args.delay)
    if args.allocate:
        ACTION = "allocate"
        WRITE_TO_PLATFORM = True
    if args.preview:
        ACTION = "preview"
        WRITE_TO_PLATFORM = False

def validate_settings() -> None:
    action = ACTION.lower().strip()
    if action not in ("allocate", "clear", "preview"):
        raise ValueError("ACTION must be one of: allocate, clear, preview")
    if clean_delay(TARGET_DELAY) not in (0, 1):
        raise ValueError("TARGET_DELAY must be 0 or 1")
    if MIN_ALPHA_COUNT > MAX_ALPHA_COUNT:
        raise ValueError("MIN_ALPHA_COUNT must be <= MAX_ALPHA_COUNT")
    if not (0.0 <= SUPER_POINT_SHARE <= 0.50):
        raise ValueError("SUPER_POINT_SHARE should be between 0 and 0.50")

def main(argv: Optional[list[str]] = None) -> int:
    apply_cli_overrides(parse_args(argv))
    validate_settings()
    print(f"WorldQuant BRAIN Osmosis allocator {SCRIPT_VERSION}")
    print(f"Action: {ACTION.lower().strip()}")
    print(f"Scope: {scope_name(TARGET_REGION, TARGET_DELAY)}")
    print(f"WRITE_TO_PLATFORM: {WRITE_TO_PLATFORM}")
    print()

    session = authenticate()
    action = ACTION.lower().strip()

    if action == "clear":
        clear_existing_points(session)
        return 0

    all_df, selected, report_path = build_allocation_plan(session)
    print_plan(selected, report_path)
    print_super_audit(all_df, selected)

    if action == "preview":
        print("Preview only. Nothing written.")
        return 0

    if CLEAR_EXISTING_FIRST:
        clear_existing_points(session)
    write_allocation(session, selected)
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nCancelled.")
        raise SystemExit(130)
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)