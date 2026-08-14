#!/usr/bin/env python3
"""Weather fetch wrapper with optional unofficial personal-station observations."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

import fetch_weather_v3 as patched

base = patched.base


def fetch_pws_station(station: dict[str, Any], api_key: str) -> tuple[dict[str, Any] | None, str | None]:
    """Fetch one Weather Company PWS current observation without exposing the key."""
    station_id = str(station.get("id", "")).strip()
    params = urllib.parse.urlencode({
        "stationId": station_id,
        "format": "json",
        "units": "e",
        "numericPrecision": "decimal",
        "apiKey": api_key,
    })
    url = f"https://api.weather.com/v2/pws/observations/current?{params}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": base.USER_AGENT,
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status == 204:
                return None, "No observation reported in the provider's current-observation window."
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 204:
            return None, "No observation reported in the provider's current-observation window."
        if exc.code in (401, 403):
            return None, "The Weather Company PWS API key was rejected or is not authorized for this product."
        if exc.code == 404:
            return None, "Station not found by the PWS API."
        return None, f"PWS API returned HTTP {exc.code}."
    except (urllib.error.URLError, TimeoutError):
        return None, "PWS API request timed out or was temporarily unavailable."

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return None, "PWS API returned an unreadable response."

    observations = payload.get("observations") if isinstance(payload, dict) else None
    if not isinstance(observations, list) or not observations:
        return None, "No current observation was returned."

    observation = observations[0] if isinstance(observations[0], dict) else None
    if not observation:
        return None, "No usable current observation was returned."

    imperial = observation.get("imperial") if isinstance(observation.get("imperial"), dict) else {}
    observed_at = observation.get("obsTimeUtc")
    age = base.age_minutes(observed_at)

    def number(value: Any) -> float | None:
        try:
            return float(value) if value not in (None, "") else None
        except (TypeError, ValueError):
            return None

    return {
        "id": station_id,
        "name": station.get("name") or observation.get("neighborhood") or station_id,
        "network": "Unofficial personal weather station",
        "lat": number(observation.get("lat")) or number(station.get("lat")),
        "lon": number(observation.get("lon")) or number(station.get("lon")),
        "observed_at": observed_at,
        "age_minutes": age,
        "stale": age is None or age > 60,
        "temperature_f": number(imperial.get("temp")),
        "heat_index_f": number(imperial.get("heatIndex")),
        "wind_chill_f": number(imperial.get("windChill")),
        "dewpoint_f": number(imperial.get("dewpt")),
        "relative_humidity_pct": number(observation.get("humidity")),
        "wind_direction_deg": number(observation.get("winddir")),
        "wind_speed_mph": number(imperial.get("windSpeed")),
        "wind_gust_mph": number(imperial.get("windGust")),
        "pressure_inhg": number(imperial.get("pressure")),
        "precip_rate_in_per_hr": number(imperial.get("precipRate")),
        "precip_total_in": number(imperial.get("precipTotal")),
        "uv": number(observation.get("uv")),
        "solar_radiation": number(observation.get("solarRadiation")),
        "qc_status": observation.get("qcStatus"),
        "source_url": f"https://www.wunderground.com/dashboard/pws/{urllib.parse.quote(station_id)}",
    }, None


def add_unofficial_observations() -> None:
    """Append supplemental PWS observations after official decision evaluation."""
    path = base.OUTPUT_PATH
    if not path.exists():
        return

    data = json.loads(path.read_text(encoding="utf-8"))
    station_defs = base.CONFIG.get("stations", {}).get("referencePersonal", [])
    api_key = os.environ.get("WEATHERCOM_API_KEY", "").strip()

    rows: list[dict[str, Any]] = []
    station_notes: list[dict[str, str]] = []

    if api_key:
        auth_failure = False
        for station in station_defs:
            observation, note = fetch_pws_station(station, api_key)
            if observation:
                rows.append(observation)
            elif note:
                station_notes.append({"id": str(station.get("id", "")), "note": note})
                if "key was rejected" in note:
                    auth_failure = True
                    break

        if auth_failure:
            status_note = "The Weather Company PWS key is configured but was rejected or is not authorized for current PWS observations."
        elif rows:
            status_note = f"{len(rows)} of {len(station_defs)} configured unofficial PWS stations returned a current observation."
        else:
            status_note = "The PWS key is configured, but none of the configured personal stations returned a current observation."
    else:
        status_note = "Live unofficial readings require a WEATHERCOM_API_KEY GitHub Actions secret. The mapped personal stations remain reference locations only."

    data["unofficial_status"] = {
        "provider": "The Weather Company PWS",
        "configured": bool(api_key),
        "returned": len(rows),
        "configured_stations": len(station_defs),
        "note": status_note,
        "station_notes": station_notes,
        "decision_use": False,
    }
    data["unofficial_stations"] = rows

    for item in data.get("coverage", []):
        if item.get("name") == "Personal weather stations":
            if not api_key:
                item["status"] = "partial"
            elif rows:
                item["status"] = "available" if len(rows) == len(station_defs) else "partial"
            else:
                item["status"] = "partial"
            item["detail"] = status_note + " Unofficial readings are not used in the official decision calculation."

    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Unofficial PWS observations: {len(rows)} of {len(station_defs)} configured stations")


if __name__ == "__main__":
    exit_code = base.main()
    patched.improve_coverage()
    add_unofficial_observations()
    raise SystemExit(exit_code)
