"""Official five-minute demand feeds; no forecasts or inferred observations.

The caller owns bounded HTTPS fetching, raw archives, daily peak computation and
fallback policy. ``collect_direct`` returns the shared RegionDemand shape plus
the private ``_intervalEnding`` flag consumed by the orchestrator.

Endpoint discovery verified against the official dashboards on 2026-10-08:
CAISO /theme/js/outlook/outlook.js uses /outlook/history/YYYYMMDD/demand.csv;
ERCOT /gridmktinfo/dashboards/supplyanddemand uses the JSON endpoint below.
NYISO's direct host was inaccessible during verification, so this module does
not invent a verified NYISO adapter. The orchestrator can use EIA's actuals.
"""
from __future__ import annotations

import csv
import io
import json
import math
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

UTC = timezone.utc
CAISO_HISTORY = "https://www.caiso.com/outlook/history/{day}/demand.csv"
ERCOT_URL = "https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json"


class DirectDemandError(ValueError):
    """A direct feed could not supply validated actual demand."""


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _mw(value: object) -> float:
    if isinstance(value, bool) or value is None:
        raise DirectDemandError("Invalid actual demand MW")
    try:
        number = float(value)
    except (ValueError, TypeError) as exc:
        raise DirectDemandError("Invalid actual demand MW") from exc
    if not math.isfinite(number) or not 0 < number <= 1_000_000:
        raise DirectDemandError("Actual demand MW outside valid range")
    return number


def _exact_local(value: datetime, zone: ZoneInfo) -> datetime | None:
    """Reject ambiguous/missing DST wall-clock times when no offset is supplied."""
    candidates = set()
    for fold in (0, 1):
        candidate = value.replace(tzinfo=zone, fold=fold).astimezone(UTC)
        if candidate.astimezone(zone).replace(tzinfo=None) == value:
            candidates.add(candidate)
    return next(iter(candidates)) if len(candidates) == 1 else None


def _points(points: list[dict], now: datetime) -> list[dict]:
    unique: dict[str, dict] = {}
    for point in points:
        stamp = datetime.fromisoformat(point["observedAt"].replace("Z", "+00:00"))
        if stamp > now:
            raise DirectDemandError("Actual demand timestamp is in the future")
        previous = unique.get(point["observedAt"])
        if previous is not None and previous["mw"] != point["mw"]:
            raise DirectDemandError("Conflicting actual demand values at one timestamp")
        unique[point["observedAt"]] = point
    return [unique[key] for key in sorted(unique)]


def parse_caiso(raw: bytes, operating_day: date, now: datetime) -> tuple[list[dict], list[str]]:
    """Read only Current demand, using the date embedded in the requested URL.

    The final repeated 00:00 chart boundary is omitted, rather than assigned to
    the start of the same day. Blank actuals are missing, never zero/forecast.
    CAISO's CSV lacks UTC offsets; ambiguous DST rows stay unknown.
    """
    try:
        reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
        if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise DirectDemandError("CAISO CSV headers missing or duplicated")
        if not {"Time", "Day ahead forecast", "Hour ahead forecast", "Current demand"}.issubset(reader.fieldnames):
            raise DirectDemandError("CAISO CSV headers changed")
        rows = list(reader)
    except (UnicodeError, csv.Error) as exc:
        raise DirectDemandError("CAISO CSV could not be read") from exc
    if not rows or len(rows) > 400:
        raise DirectDemandError("CAISO CSV row count invalid")
    zone = ZoneInfo("America/Los_Angeles")
    result: list[dict] = []
    skipped_dst = 0
    for index, row in enumerate(rows):
        if None in row:
            raise DirectDemandError("CAISO CSV row has extra columns")
        raw_time = (row.get("Time") or "").strip()
        if (index == len(rows) - 1 and index > 0 and raw_time in ("00:00", "24:00")
                and (rows[index - 1].get("Time") or "").strip() == "23:55"):
            continue
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", raw_time):
            raise DirectDemandError("CAISO wall-clock time format changed")
        hour, minute = map(int, raw_time.split(":"))
        if minute % 5:
            raise DirectDemandError("CAISO interval is not five minutes")
        raw_demand = (row.get("Current demand") or "").strip()
        if not raw_demand:
            continue
        value = _mw(raw_demand)
        stamp = _exact_local(datetime.combine(operating_day, time(hour, minute)), zone)
        if stamp is None:
            skipped_dst += 1
            continue
        result.append({"observedAt": _iso(stamp), "mw": value, "quality": None})
    warnings = []
    if skipped_dst:
        warnings.append(f"CAISO {operating_day}: UTC 오프셋이 없는 DST 중복·누락 시각 {skipped_dst}개는 제외했습니다.")
    return _points(result, now), warnings


def parse_ercot(raw: bytes, now: datetime) -> list[dict]:
    """Official observed rows only; match the offset timestamp to epoch exactly."""
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise DirectDemandError("ERCOT JSON could not be read") from exc
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not 1 <= len(rows) <= 400:
        raise DirectDemandError("ERCOT actual series structure changed")
    result: list[dict] = []
    for row in rows:
        if not isinstance(row, dict) or type(row.get("forecast")) is not int or row["forecast"] not in (0, 1):
            raise DirectDemandError("ERCOT actual/forecast marker changed")
        if row["forecast"] == 1:
            continue
        try:
            stamp = datetime.fromisoformat(row["timestamp"])
        except (KeyError, ValueError, TypeError) as exc:
            raise DirectDemandError("ERCOT timestamp format changed") from exc
        if stamp.tzinfo is None:
            raise DirectDemandError("ERCOT timestamp has no UTC offset")
        epoch = row.get("epoch")
        if isinstance(epoch, bool) or not isinstance(epoch, (float, int)) or not math.isfinite(epoch):
            raise DirectDemandError("ERCOT epoch is invalid")
        if abs(stamp.timestamp() * 1000 - epoch) > 1:
            raise DirectDemandError("ERCOT timestamp and epoch disagree")
        central = stamp.astimezone(ZoneInfo("America/Chicago"))
        if stamp.utcoffset() != central.utcoffset() or stamp.minute % 5 or stamp.second or stamp.microsecond:
            raise DirectDemandError("ERCOT time zone or five-minute interval changed")
        result.append({"observedAt": _iso(stamp), "mw": _mw(row.get("demand")), "quality": None})
    result = _points(result, now)
    if not result:
        raise DirectDemandError("ERCOT contains no actual demand")
    return result


def collect_direct(region: str, fetch: Callable[[str], bytes], now: datetime, days: int = 7) -> dict | None:
    """Bounded direct collection; unsupported regions return None for fallback."""
    if region not in ("CAISO", "ERCOT"):
        return None
    if now.tzinfo is None or type(days) is not int or not 1 <= days <= 7:
        raise DirectDemandError("UTC-aware now and 1..7 days are required")
    now = now.astimezone(UTC)
    warnings: list[str] = []
    if region == "CAISO":
        zone = "America/Los_Angeles"
        local_date = now.astimezone(ZoneInfo(zone)).date()
        series: list[dict] = []
        for offset in range(days):
            day = local_date - timedelta(days=offset)
            url = CAISO_HISTORY.format(day=day.strftime("%Y%m%d"))
            try:
                points, parser_warnings = parse_caiso(fetch(url), day, now)
                series.extend(points)
                warnings.extend(parser_warnings)
                if not points:
                    warnings.append(f"CAISO {day}: 공개된 실측 부하가 없습니다.")
            except Exception as exc:
                # Do not copy HTTP response bodies or arbitrary fetch exception text.
                warnings.append(f"CAISO {day}: 일별 실측 취득·검증 실패 ({type(exc).__name__}).")
        series = _points(series, now)
        source_name = "CAISO Today's Outlook · 5분 실측"
        source_url = "https://www.caiso.com/todays-outlook/demand"
        warnings.append("5분 Current demand 관측값입니다. 예측 열과 순부하를 제외하며, 하루가 끝나기 전의 피크는 잠정값입니다.")
    else:
        zone = "America/Chicago"
        try:
            series = parse_ercot(fetch(ERCOT_URL), now)
        except DirectDemandError:
            raise
        except Exception as exc:
            raise DirectDemandError(f"ERCOT direct fetch failed ({type(exc).__name__})") from exc
        source_name = "ERCOT Supply and Demand · 5분 실측"
        source_url = "https://www.ercot.com/gridmktinfo/dashboards/supplyanddemand"
        warnings.extend([
            "ERCOT 직접 피드는 현재 운영일의 5분 관측만 제공합니다. 하루가 끝나기 전의 피크는 잠정값입니다.",
            "ERCOT 공식 정의상 이 부하에는 에너지저장장치 충전 수요가 포함되지 않습니다. 예측값은 제외했습니다.",
        ])
    if not series:
        raise DirectDemandError(f"{region} has no validated actual demand observations")
    latest = series[-1]
    age = now - datetime.fromisoformat(latest["observedAt"].replace("Z", "+00:00"))
    return {
        "region": region, "name": region, "timezone": zone,
        "sourceName": source_name, "sourceUrl": source_url,
        "retrievedAt": _iso(now), "observedAt": latest["observedAt"],
        "intervalMinutes": 5, "latestMw": latest["mw"],
        "status": "available" if age <= timedelta(hours=2) else "stale",
        "series": series, "dailyPeaks": [], "warnings": warnings,
        "_intervalEnding": False,
    }
