#!/usr/bin/env python3
"""Fetch official weather sources and write data/latest.json.

The script intentionally fails soft by recording source errors. A missing feed is never
converted into a safe condition. It uses only the Python standard library.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config.json"
OUTPUT_PATH = ROOT / "data" / "latest.json"

with CONFIG_PATH.open("r", encoding="utf-8") as fh:
    CONFIG = json.load(fh)

TZ = ZoneInfo(CONFIG["district"]["timezone"])
USER_AGENT = CONFIG.get("nwsUserAgent", "MUSD-Weather-Dashboard/1.0")
ERRORS: list[str] = []


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat().replace("+00:00", "Z") if dt else None


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _clean_response_snippet(value: str, limit: int = 180) -> str:
    """Return a short, single-line response excerpt safe for dashboard diagnostics."""
    cleaned = re.sub(r"\s+", " ", value).strip()
    return cleaned[:limit] + ("..." if len(cleaned) > limit else "")


def json_get(
    url: str,
    params: dict[str, Any] | None = None,
    timeout: int = 30,
    accept: str = "application/geo+json, application/json",
    extra_headers: dict[str, str] | None = None,
) -> Any:
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, safe=',;:=')}"
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if extra_headers:
        headers.update(extra_headers)
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            content_type = response.headers.get("Content-Type", "unknown content type")
            snippet = _clean_response_snippet(body)
            raise ValueError(f"non-JSON response ({content_type}): {snippet}") from exc


def safe_get(
    name: str,
    url: str,
    params: dict[str, Any] | None = None,
    accept: str = "application/geo+json, application/json",
    extra_headers: dict[str, str] | None = None,
) -> Any | None:
    try:
        return json_get(
            url,
            params=params,
            accept=accept,
            extra_headers=extra_headers,
        )
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        detail = _clean_response_snippet(body)
        ERRORS.append(f"{name}: HTTP {exc.code}" + (f" — {detail}" if detail else ""))
        return None
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        ERRORS.append(f"{name}: {exc}")
        return None


def qvalue(obj: Any) -> float | None:
    if isinstance(obj, dict):
        value = obj.get("value")
    else:
        value = obj
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def c_to_f(value: float | None) -> float | None:
    return value * 9 / 5 + 32 if value is not None else None


def kmh_to_mph(value: float | None) -> float | None:
    return value * 0.621371 if value is not None else None


def meters_to_miles(value: float | None) -> float | None:
    return value / 1609.344 if value is not None else None


def meters_to_inches(value: float | None) -> float | None:
    return value * 39.3700787 if value is not None else None


def pa_to_inhg(value: float | None) -> float | None:
    return value * 0.00029529983 if value is not None else None


def age_minutes(timestamp: str | None) -> float | None:
    dt = parse_dt(timestamp)
    if not dt:
        return None
    return max(0.0, (now_utc() - dt.astimezone(timezone.utc)).total_seconds() / 60)


def threshold_level(value: float | None, cutoffs: list[float]) -> int | None:
    if value is None:
        return None
    level = 0
    for idx, cutoff in enumerate(cutoffs, start=1):
        if value >= cutoff:
            level = idx
    return min(level, 4)


def level_definition(level: int) -> dict[str, Any]:
    return next((item for item in CONFIG["levels"] if item["level"] == level), CONFIG["levels"][0])


def fetch_nws_station(station: dict[str, Any]) -> dict[str, Any] | None:
    station_id = station["id"]
    payload = safe_get(f"NWS station {station_id}", f"https://api.weather.gov/stations/{station_id}/observations/latest")
    if not payload or "properties" not in payload:
        return None
    p = payload["properties"]
    observed_at = p.get("timestamp")
    age = age_minutes(observed_at)
    stale = age is None or age > CONFIG["thresholds"]["stationStaleMinutes"]
    return {
        "id": station_id,
        "name": station["name"],
        "network": "NWS / aviation",
        "lat": station["lat"],
        "lon": station["lon"],
        "observed_at": observed_at,
        "age_minutes": age,
        "stale": stale,
        "condition": p.get("textDescription"),
        "temperature_f": c_to_f(qvalue(p.get("temperature"))),
        "dewpoint_f": c_to_f(qvalue(p.get("dewpoint"))),
        "relative_humidity_pct": qvalue(p.get("relativeHumidity")),
        "heat_index_f": c_to_f(qvalue(p.get("heatIndex"))),
        "wind_chill_f": c_to_f(qvalue(p.get("windChill"))),
        "wind_direction_deg": qvalue(p.get("windDirection")),
        "wind_speed_mph": kmh_to_mph(qvalue(p.get("windSpeed"))),
        "wind_gust_mph": kmh_to_mph(qvalue(p.get("windGust"))),
        "visibility_miles": meters_to_miles(qvalue(p.get("visibility"))),
        "pressure_inhg": pa_to_inhg(qvalue(p.get("barometricPressure"))),
        "precip_last_hour_in": meters_to_inches(qvalue(p.get("precipitationLastHour"))),
        "raw_message": p.get("rawMessage"),
        "source_url": f"https://api.weather.gov/stations/{station_id}/observations/latest",
    }


def find_nested_numeric(obj: Any, aliases: Iterable[str]) -> float | None:
    aliases_normalized = {re.sub(r"[^a-z0-9]", "", a.lower()) for a in aliases}
    if isinstance(obj, dict):
        for key, value in obj.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in aliases_normalized:
                if isinstance(value, dict):
                    candidate = value.get("Value", value.get("value"))
                else:
                    candidate = value
                try:
                    return float(candidate)
                except (TypeError, ValueError):
                    pass
        for value in obj.values():
            found = find_nested_numeric(value, aliases)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_nested_numeric(value, aliases)
            if found is not None:
                return found
    return None


def find_nested_text(obj: Any, aliases: Iterable[str]) -> str | None:
    aliases_normalized = {re.sub(r"[^a-z0-9]", "", a.lower()) for a in aliases}
    if isinstance(obj, dict):
        for key, value in obj.items():
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized in aliases_normalized and value not in (None, ""):
                return str(value.get("Value", value.get("value"))) if isinstance(value, dict) else str(value)
        for value in obj.values():
            found = find_nested_text(value, aliases)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_nested_text(value, aliases)
            if found:
                return found
    return None


def flatten_records(obj: Any) -> list[dict[str, Any]]:
    """Recursively find CIMIS-like observation records in an unknown JSON envelope."""
    out: list[dict[str, Any]] = []
    if isinstance(obj, dict):
        normalized_keys = {
            re.sub(r"[^a-z0-9]", "", str(key).lower())
            for key in obj.keys()
        }
        has_date = bool(
            normalized_keys
            & {"date", "datevalue", "recorddate", "observationdate"}
        )
        has_station = bool(
            normalized_keys
            & {
                "station",
                "stationnr",
                "stationnbr",
                "stationnumber",
                "stationid",
            }
        )
        has_hour = bool(
            normalized_keys
            & {"hour", "hourvalue", "recordhour", "observationhour"}
        )
        has_weather_value = any(
            key.startswith("hly")
            or key in {
                "airtmp",
                "airtemperature",
                "relativehumidity",
                "relhum",
                "windspeed",
                "windspd",
                "precipitation",
                "precip",
            }
            for key in normalized_keys
        )
        if has_date and has_station and (has_hour or has_weather_value):
            out.append(obj)
        for value in obj.values():
            out.extend(flatten_records(value))
    elif isinstance(obj, list):
        for value in obj:
            out.extend(flatten_records(value))
    return out


def parse_cimis_date(value: str | None) -> datetime.date | None:
    if not value:
        return None
    cleaned = value.strip()
    candidates = [cleaned[:10], cleaned]
    formats = (
        "%Y-%m-%d",
        "%m/%d/%Y",
        "%m/%d/%y",
        "%Y/%m/%d",
    )
    for candidate in candidates:
        try:
            return datetime.fromisoformat(candidate.replace("Z", "+00:00")).date()
        except ValueError:
            pass
        for fmt in formats:
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                continue
    return None


def parse_cimis_hour(value: str | None) -> tuple[int, int, bool]:
    """Return hour, minute and whether CIMIS used its special 2400 value."""
    if value in (None, ""):
        return 0, 0, False
    cleaned = str(value).strip().upper()

    # Handle clock strings such as 1:00 PM.
    for fmt in ("%I:%M %p", "%I %p", "%H:%M", "%H:%M:%S"):
        try:
            parsed = datetime.strptime(cleaned, fmt)
            return parsed.hour, parsed.minute, False
        except ValueError:
            continue

    digits = re.sub(r"\D", "", cleaned)
    if not digits:
        return 0, 0, False
    number = int(digits)
    if number == 2400:
        return 0, 0, True
    if number <= 23:
        return number, 0, False
    hour = min(number // 100, 23)
    minute = min(number % 100, 59)
    return hour, minute, False


def heat_index_fahrenheit(
    temperature_f: float | None,
    relative_humidity_pct: float | None,
) -> float | None:
    """Calculate NOAA/NWS heat index when temperature and humidity support it."""
    if temperature_f is None or relative_humidity_pct is None:
        return None
    t = float(temperature_f)
    rh = float(relative_humidity_pct)
    if t < 80 or rh < 40:
        return None

    simple = 0.5 * (
        t
        + 61.0
        + ((t - 68.0) * 1.2)
        + (rh * 0.094)
    )
    if (simple + t) / 2 < 80:
        return simple

    hi = (
        -42.379
        + 2.04901523 * t
        + 10.14333127 * rh
        - 0.22475541 * t * rh
        - 0.00683783 * t * t
        - 0.05481717 * rh * rh
        + 0.00122874 * t * t * rh
        + 0.00085282 * t * rh * rh
        - 0.00000199 * t * t * rh * rh
    )
    if rh < 13 and 80 <= t <= 112:
        hi -= ((13 - rh) / 4) * math.sqrt((17 - abs(t - 95)) / 17)
    elif rh > 85 and 80 <= t <= 87:
        hi += ((rh - 85) / 10) * ((87 - t) / 5)
    return hi


def cimis_record_datetime_utc(rec: dict[str, Any]) -> str | None:
    date_text = find_nested_text(
        rec,
        ["Date", "DateValue", "RecordDate", "ObservationDate"],
    )
    record_date = parse_cimis_date(date_text)
    if record_date is None:
        return None

    hour_text = find_nested_text(
        rec,
        ["Hour", "HourValue", "RecordHour", "ObservationHour"],
    )
    hour, minute, is_2400 = parse_cimis_hour(hour_text)
    if is_2400:
        record_date += timedelta(days=1)

    # CIMIS station data is reported in Pacific Standard Time year-round.
    cimis_tz = timezone(timedelta(hours=-8))
    local_dt = datetime.combine(
        record_date,
        datetime.min.time(),
        tzinfo=cimis_tz,
    ).replace(hour=hour, minute=minute)
    return iso(local_dt.astimezone(timezone.utc))


def fetch_cimis() -> list[dict[str, Any]]:
    """Fetch hourly station data from the current CIMIS StationWeb REST API.

    The latest CIMIS documentation uses StationWeb/GetDataByStationNumber with
    stationNbrs, isHourly, unitOfMeasure and dataItems query parameters. The
    documented request examples do not place the legacy AppKey in the URL.
    """
    station_defs = CONFIG["stations"]["cimis"]
    if not station_defs:
        return []

    # CIMIS uses PST throughout the year. Request yesterday and today so the
    # last completed hour remains available around midnight and during delays.
    cimis_tz = timezone(timedelta(hours=-8))
    local_now = datetime.now(cimis_tz)
    endpoint = (
        "https://et.water.ca.gov/"
        "StationWeb/GetDataByStationNumber"
    )
    params = {
        "stationNbrs": ",".join(str(s["id"]) for s in station_defs),
        "startDate": (local_now.date() - timedelta(days=1)).isoformat(),
        "endDate": local_now.date().isoformat(),
        "isHourly": "true",
        "unitOfMeasure": "E",
        "dataItems": (
            "hly-air-tmp,"
            "hly-dew-pnt,"
            "hly-precip,"
            "hly-rel-hum,"
            "hly-wind-dir,"
            "hly-wind-spd"
        ),
    }

    subscription_key = os.environ.get("CIMIS_APP_KEY", "").strip()
    if not subscription_key:
        ERRORS.append(
            "CIMIS: CIMIS_APP_KEY is not configured in the GitHub Actions environment."
        )
        return []

    payload = safe_get(
        "CIMIS",
        endpoint,
        params,
        accept="application/json",
        extra_headers={
            "Ocp-Apim-Subscription-Key": subscription_key,
        },
    )
    if payload is None:
        return []

    records = flatten_records(payload)
    result: list[dict[str, Any]] = []

    for station in station_defs:
        station_id = re.sub(r"\D", "", str(station["id"]))
        matching: list[dict[str, Any]] = []

        for rec in records:
            sid = find_nested_text(
                rec,
                [
                    "StationNbr",
                    "StationNr",
                    "StationNumber",
                    "StationId",
                    "Station",
                ],
            )
            if sid is None:
                continue
            sid_digits = re.sub(r"\D", "", sid)
            if sid_digits == station_id:
                matching.append(rec)

        if not matching:
            continue

        matching.sort(
            key=lambda rec: parse_dt(cimis_record_datetime_utc(rec))
            or datetime.min.replace(tzinfo=timezone.utc)
        )
        rec = matching[-1]
        observed_at = cimis_record_datetime_utc(rec)
        age = age_minutes(observed_at)

        temperature = find_nested_numeric(
            rec,
            [
                "HlyAirTmp",
                "hly-air-tmp",
                "AirTmp",
                "AirTemperature",
                "HourlyAirTemperature",
            ],
        )
        humidity = find_nested_numeric(
            rec,
            [
                "HlyRelHum",
                "hly-rel-hum",
                "RelHum",
                "RelativeHumidity",
                "HourlyRelativeHumidity",
            ],
        )
        dewpoint = find_nested_numeric(
            rec,
            [
                "HlyDewPnt",
                "hly-dew-pnt",
                "DewPoint",
                "HourlyDewPoint",
            ],
        )

        result.append({
            "id": str(station["id"]),
            "name": station["name"],
            "network": "California DWR CIMIS",
            "lat": station["lat"],
            "lon": station["lon"],
            "observed_at": observed_at,
            "age_minutes": age,
            "stale": (
                age is None
                or age > CONFIG["thresholds"]["stationStaleMinutes"]
            ),
            "condition": "Hourly CIMIS station observation",
            "temperature_f": temperature,
            "dewpoint_f": dewpoint,
            "relative_humidity_pct": humidity,
            "heat_index_f": heat_index_fahrenheit(temperature, humidity),
            "wind_chill_f": None,
            "wind_direction_deg": find_nested_numeric(
                rec,
                [
                    "HlyWindDir",
                    "hly-wind-dir",
                    "WindDir",
                    "WindDirection",
                    "HourlyWindDirection",
                ],
            ),
            "wind_speed_mph": find_nested_numeric(
                rec,
                [
                    "HlyWindSpd",
                    "hly-wind-spd",
                    "WindSpd",
                    "WindSpeed",
                    "HourlyWindSpeed",
                ],
            ),
            "wind_gust_mph": None,
            "visibility_miles": None,
            "pressure_inhg": None,
            "precip_last_hour_in": find_nested_numeric(
                rec,
                [
                    "HlyPrecip",
                    "hly-precip",
                    "Precip",
                    "Precipitation",
                    "HourlyPrecipitation",
                ],
            ),
            "raw_message": None,
            "source_url": endpoint,
        })

    if not result and records:
        ERRORS.append(
            "CIMIS: the API returned JSON, but no configured station records "
            "could be identified in the response."
        )
    return result

def fetch_point_forecast() -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    center = CONFIG["district"]["center"]
    point = safe_get("NWS point metadata", f"https://api.weather.gov/points/{center['lat']},{center['lon']}") or {}
    props = point.get("properties", {})
    hourly_url = props.get("forecastHourly")
    hourly_payload = safe_get("NWS hourly forecast", hourly_url) if hourly_url else None
    hourly = []
    for p in (hourly_payload or {}).get("properties", {}).get("periods", [])[:24]:
        hourly.append({
            "start_time": p.get("startTime"),
            "end_time": p.get("endTime"),
            "temperature_f": p.get("temperature") if p.get("temperatureUnit") == "F" else c_to_f(p.get("temperature")),
            "precip_probability_pct": qvalue(p.get("probabilityOfPrecipitation")),
            "relative_humidity_pct": qvalue(p.get("relativeHumidity")),
            "wind_speed": p.get("windSpeed"),
            "wind_direction": p.get("windDirection"),
            "short_forecast": p.get("shortForecast"),
            "detailed_forecast": p.get("detailedForecast"),
        })
    metadata = {
        "grid_id": props.get("gridId"), "grid_x": props.get("gridX"), "grid_y": props.get("gridY"),
        "forecast_zone": props.get("forecastZone"), "county": props.get("county"), "time_zone": props.get("timeZone"),
        "hourly_url": hourly_url,
    }
    return metadata, hourly, props


def fetch_alerts() -> list[dict[str, Any]]:
    center = CONFIG["district"]["center"]
    payload = safe_get("NWS alerts", "https://api.weather.gov/alerts/active", {"point": f"{center['lat']},{center['lon']}"})
    alerts = []
    severity_map = CONFIG["thresholds"]["alertSeverity"]
    for feature in (payload or {}).get("features", []):
        p = feature.get("properties", {})
        severity = p.get("severity", "Unknown")
        level = int(severity_map.get(severity, 0))
        event = p.get("event") or "Weather alert"
        if event in {"Tornado Warning", "Flash Flood Warning", "Extreme Wind Warning"}:
            level = 4
        alerts.append({
            "id": p.get("id") or feature.get("id"),
            "event": event,
            "headline": p.get("headline"),
            "description": p.get("description"),
            "instruction": p.get("instruction"),
            "severity": severity,
            "certainty": p.get("certainty"),
            "urgency": p.get("urgency"),
            "effective": p.get("effective"),
            "onset": p.get("onset"),
            "expires": p.get("expires"),
            "ends": p.get("ends"),
            "area_desc": p.get("areaDesc"),
            "sender_name": p.get("senderName"),
            "level": level,
            "web": p.get("web") or p.get("@id") or feature.get("id"),
        })
    return sorted(alerts, key=lambda a: a.get("level", 0), reverse=True)


def recursive_numbers(obj: Any) -> list[float]:
    values: list[float] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key.lower() in {"value", "values", "pixelvalue", "risk", "heatrisk"}:
                values.extend(recursive_numbers(value))
            elif isinstance(value, (dict, list)):
                values.extend(recursive_numbers(value))
    elif isinstance(obj, list):
        for value in obj:
            values.extend(recursive_numbers(value))
    else:
        try:
            values.append(float(obj))
        except (TypeError, ValueError):
            pass
    return values


def fetch_heat_risk() -> dict[str, Any] | None:
    center = CONFIG["district"]["center"]
    params = {
        "f": "json",
        "geometry": json.dumps({"x": center["lon"], "y": center["lat"], "spatialReference": {"wkid": 4326}}),
        "geometryType": "esriGeometryPoint",
        "returnGeometry": "false",
        "returnCatalogItems": "false",
    }
    payload = safe_get("NWS HeatRisk", "https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/identify", params)
    if not payload:
        return None
    candidates = [n for n in recursive_numbers(payload) if 0 <= n <= 4 and float(n).is_integer()]
    if not candidates:
        return None
    level = int(candidates[0])
    names = ["Green / Little to none", "Yellow / Minor", "Orange / Moderate", "Red / Major", "Magenta / Extreme"]
    return {"level": level, "display": f"{level} — {names[level]}", "note": "NWS experimental current-day HeatRisk"}


def fetch_airnow() -> dict[str, Any] | None:
    key = os.getenv("AIRNOW_API_KEY", "").strip()
    if not key:
        return None
    center = CONFIG["district"]["center"]
    payload = safe_get("EPA AirNow", "https://www.airnowapi.org/aq/observation/latLong/current/", {
        "format": "application/json",
        "latitude": center["lat"], "longitude": center["lon"], "distance": 50,
        "API_KEY": key,
    })
    if not isinstance(payload, list) or not payload:
        return None
    valid = [item for item in payload if isinstance(item.get("AQI"), (int, float))]
    if not valid:
        return None
    worst = max(valid, key=lambda item: item["AQI"])
    value = int(worst["AQI"])
    return {
        "value": value,
        "category": (worst.get("Category") or {}).get("Name"),
        "parameter": worst.get("ParameterName"),
        "reporting_area": worst.get("ReportingArea"),
        "observed_at": f"{worst.get('DateObserved')} {worst.get('HourObserved')}:00 {worst.get('LocalTimeZone')}",
        "level": threshold_level(value, CONFIG["thresholds"]["aqi"]),
        "note": f"{worst.get('ParameterName', 'AQI')} · {worst.get('ReportingArea', 'nearest reporting area')}",
        "all_observations": valid,
    }


def max_value(stations: list[dict[str, Any]], field: str) -> tuple[float | None, str | None]:
    valid = [(s.get(field), s.get("name")) for s in stations if not s.get("stale") and s.get(field) is not None]
    return max(valid, key=lambda x: x[0]) if valid else (None, None)


def build_evaluation(stations: list[dict[str, Any]], hourly: list[dict[str, Any]], alerts: list[dict[str, Any]], heat_risk: dict[str, Any] | None, airnow: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
    max_heat, max_heat_station = max_value(stations, "heat_index_f")
    if max_heat is None:
        max_heat, max_heat_station = max_value(stations, "temperature_f")
    max_gust, max_gust_station = max_value(stations, "wind_gust_mph")
    if max_gust is None:
        max_gust, max_gust_station = max_value(stations, "wind_speed_mph")
    next6 = hourly[:6]
    precip_values = [p.get("precip_probability_pct") for p in next6 if p.get("precip_probability_pct") is not None]
    max_precip = max(precip_values) if precip_values else None
    thunderstorm = any("thunder" in (p.get("short_forecast") or "").lower() for p in next6)

    heat_index_level = threshold_level(max_heat, CONFIG["thresholds"]["heatIndexF"])
    wind_level = threshold_level(max_gust, CONFIG["thresholds"]["windGustMph"])
    precip_level = threshold_level(max_precip, CONFIG["thresholds"]["precipProbabilityPct"])
    if thunderstorm and (precip_level or 0) < 2:
        precip_level = 2
    alert_level = max((a.get("level", 0) for a in alerts), default=0)

    candidates: list[tuple[int, str]] = []
    if heat_risk:
        candidates.append((heat_risk["level"], f"NWS HeatRisk is {heat_risk['display']}."))
    if airnow:
        candidates.append((airnow["level"], f"AirNow AQI is {airnow['value']} ({airnow.get('category') or 'category unavailable'})."))
    if heat_index_level is not None:
        candidates.append((heat_index_level, f"Highest current heat index/temperature is {round(max_heat)}°F at {max_heat_station}."))
    if wind_level is not None:
        candidates.append((wind_level, f"Highest current wind gust/speed is {round(max_gust)} mph at {max_gust_station}."))
    if precip_level is not None:
        candidates.append((precip_level, f"Highest precipitation probability in the next six hours is {round(max_precip)}%." if max_precip is not None else "Thunderstorms are possible in the next six hours."))
    if alert_level:
        candidates.append((alert_level, f"{len(alerts)} active NWS alert(s); highest alert level is {alert_level}."))

    official_fresh = [s for s in stations if not s.get("stale") and s.get("network") in {"NWS / aviation", "California DWR CIMIS"}]
    forecast_available = bool(hourly)
    if not official_fresh and not forecast_available:
        level = None
        definition = {"label": "Data unavailable — verify manually", "action": "Use official NWS, AirNow and district emergency procedures until data feeds are restored."}
        data_status = "Insufficient official data"
        reasons = ["No fresh official station observations or hourly forecast are available."]
    else:
        level = max((item[0] for item in candidates), default=0)
        definition = level_definition(level)
        data_status = "Operational" if official_fresh and forecast_available else "Partial — verify missing feeds"
        reasons = [reason for lev, reason in sorted(candidates, key=lambda x: x[0], reverse=True) if lev == level]
        if not reasons:
            reasons = ["No configured threshold is currently exceeded."]

    if level is None:
        actions = ["Verify current conditions directly with NWS and local agencies.", "Do not interpret missing data as normal conditions."]
    else:
        actions = [definition["action"]]
        if level >= 1:
            actions.append("Confirm conditions at affected school sites and document the decision source and time.")
        if level >= 2:
            actions.append("Notify principals, PE staff, coaches and supervisors of required modifications.")
        if level >= 3:
            actions.append("Use established staff and family communication procedures for affected activities or operations.")
        if thunderstorm:
            actions.append("A thunderstorm forecast is not a lightning-clearance system; use a dedicated lightning protocol or licensed feed.")

    summary = {
        "heat_risk": heat_risk or {"level": None, "display": "Unavailable", "note": "Open the NWS HeatRisk viewer for manual confirmation"},
        "aqi": airnow or {"value": None, "level": None, "note": "Add AIRNOW_API_KEY as a GitHub Actions secret"},
        "max_heat_index_f": max_heat,
        "max_heat_index_station": max_heat_station,
        "heat_index_level": heat_index_level,
        "max_wind_gust_mph": max_gust,
        "max_wind_gust_station": max_gust_station,
        "wind_level": wind_level,
        "max_precip_probability_pct": max_precip,
        "precip_level": precip_level,
        "thunderstorm_possible": thunderstorm,
        "alert_level": alert_level,
    }
    evaluation = {
        "level": level,
        "name": definition.get("name") if level is not None else "Unknown",
        "label": definition["label"],
        "action": definition["action"],
        "data_status": data_status,
        "reasons": reasons,
        "recommended_actions": actions,
    }
    return summary, evaluation


def main() -> int:
    stations = [s for s in (fetch_nws_station(d) for d in CONFIG["stations"]["nws"]) if s]
    cimis = fetch_cimis()
    stations.extend(cimis)
    metadata, hourly, _ = fetch_point_forecast()
    alerts = fetch_alerts()
    heat_risk = fetch_heat_risk()
    airnow = fetch_airnow()
    summary, evaluation = build_evaluation(stations, hourly, alerts, heat_risk, airnow)

    coverage = [
        {"name": "National Weather Service stations", "status": "available" if any(s["network"] == "NWS / aviation" for s in stations) else "unavailable", "detail": f"{sum(s['network'] == 'NWS / aviation' for s in stations)} of {len(CONFIG['stations']['nws'])} configured station feeds returned data."},
        {"name": "NWS point alerts and hourly forecast", "status": "available" if hourly else "unavailable", "detail": f"{len(alerts)} active alert(s); {len(hourly)} forecast hour(s) loaded."},
        {"name": "NWS HeatRisk", "status": "available" if heat_risk else "partial", "detail": "Automated current-day value loaded." if heat_risk else "Automated lookup unavailable; use the linked NWS HeatRisk viewer for manual confirmation."},
        {"name": "EPA AirNow AQI", "status": "available" if airnow else "partial", "detail": "Current regional AQI loaded." if airnow else "Add the AIRNOW_API_KEY repository secret to enable AQI."},
        {"name": "California DWR CIMIS", "status": "available" if cimis else "partial", "detail": f"{len(cimis)} station feed(s) loaded." if cimis else "The current CIMIS StationWeb API did not return usable hourly observations."},
        {"name": "Dedicated lightning proximity", "status": "unavailable", "detail": "Not included. A licensed provider is needed for strike-distance alerts and all-clear countdowns."},
        {"name": "Personal weather stations", "status": "partial", "detail": "Mapped as reference locations only; not used in the official decision calculation."},
    ]

    output = {
        "schema_version": 1,
        "sample": False,
        "generated_at": iso(now_utc()),
        "district": CONFIG["district"],
        "evaluation": evaluation,
        "summary": summary,
        "alerts": alerts,
        "stations": sorted(stations, key=lambda s: (s.get("stale", True), s.get("network", ""), s.get("name", ""))),
        "forecast": {"metadata": metadata, "hourly": hourly},
        "coverage": coverage,
        "errors": ERRORS,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = OUTPUT_PATH.with_suffix(".tmp")
    temp_path.write_text(json.dumps(output, indent=2, sort_keys=False), encoding="utf-8")
    temp_path.replace(OUTPUT_PATH)
    print(f"Wrote {OUTPUT_PATH} with {len(stations)} station observations and {len(alerts)} alerts")
    if ERRORS:
        print("Feed warnings:", " | ".join(ERRORS), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
