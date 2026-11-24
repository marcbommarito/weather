#!/usr/bin/env python3
"""Weather fetch wrapper with verified NWS HeatRisk and optional unofficial PWS observations."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

import fetch_weather_v3 as patched

base = patched.base

# Future HeatRisk is displayed for planning, never today's decision.
HEATRISK_NEXT: dict[str, Any] | None = None
HEATRISK_NAMES = ["Green / Little to none", "Yellow / Minor", "Orange / Moderate", "Red / Major", "Magenta / Extreme"]


def parse_heat_risk_pixel(payload: Any) -> int | None:
    """Return only the ArcGIS Identify top-level pixel value when it is 0-4.

    ArcGIS ImageServer Identify documents the top-level value property as
    the identified pixel value. Do not recurse through metadata, catalog item
    attributes, object IDs, or other numeric fields.
    """
    if not isinstance(payload, dict):
        return None

    raw = payload.get("value")
    if isinstance(raw, str):
        cleaned = raw.strip()
        if not cleaned or cleaned.lower() in {"nodata", "no data", "null", "nan"}:
            return None
        if "," in cleaned or " " in cleaned:
            return None
        raw = cleaned

    try:
        numeric = float(raw)
    except (TypeError, ValueError):
        return None

    rounded = round(numeric)
    if abs(numeric - rounded) > 1e-6 or not 0 <= rounded <= 4:
        return None
    return int(rounded)


def heat_risk_catalog_valid_time(payload: Any) -> str | None:
    """Best-effort extraction of the selected raster valid time for diagnostics."""
    if not isinstance(payload, dict):
        return None
    catalog = payload.get("catalogItems")
    if not isinstance(catalog, dict):
        return None
    features = catalog.get("features")
    if not isinstance(features, list) or not features:
        return None
    first = features[0]
    if not isinstance(first, dict):
        return None
    attrs = first.get("attributes")
    if not isinstance(attrs, dict):
        return None

    raw = attrs.get("idp_validtime")
    if raw in (None, ""):
        return None
    if isinstance(raw, (int, float)):
        try:
            return datetime.fromtimestamp(float(raw) / 1000.0, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return str(raw)
    return str(raw)


def fetch_heat_risk_verified() -> dict[str, Any] | None:
    """Fetch today's HeatRisk using the actual identified raster pixel only."""
    global HEATRISK_NEXT
    HEATRISK_NEXT = None
    center = base.CONFIG["district"]["center"]
    local_date = datetime.now(base.TZ).date()

    # HeatRisk is time enabled. Select the raster closest to today's 12 UTC
    # instead of relying on the service's default Northwest mosaic ordering.
    target_valid_time = f"{local_date:%Y/%m/%d} 12:00:00"
    # The service timestamps each daily raster at 12:00 UTC. The Identify
    # endpoint supports an explicit Unix-millisecond instant; relying solely
    # on by-attribute mosaic sorting can select tomorrow's overlapping raster.
    target_valid_dt = datetime.fromisoformat(f"{local_date.isoformat()}T12:00:00+00:00")
    target_valid_epoch_ms = int(target_valid_dt.timestamp() * 1000)
    mosaic_rule = {
        "mosaicMethod": "esriMosaicAttribute",
        "sortField": "idp_validtime",
        "sortValue": target_valid_time,
        "ascending": True,
        "mosaicOperation": "MT_FIRST",
    }
    params = {
        "f": "json",
        "geometry": json.dumps({
            "x": center["lon"],
            "y": center["lat"],
            "spatialReference": {"wkid": 4326},
        }),
        "geometryType": "esriGeometryPoint",
        "time": str(target_valid_epoch_ms),
        "mosaicRule": json.dumps(mosaic_rule),
        "returnGeometry": "false",
        "returnCatalogItems": "true",
        "returnAllPixelValues": "false",
    }

    endpoint = "https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/identify"
    payload = base.safe_get("NWS HeatRisk", endpoint, params)
    level = parse_heat_risk_pixel(payload)
    if level is None:
        # Some ArcGIS ImageServer versions return NoData for an exact instant,
        # even when a daily raster exists. Inspect the overlapping catalog,
        # then lock identify to the exact matching raster ID. Never substitute
        # the unfiltered value: it may belong to tomorrow's grid.
        catalog_params = {
            key: value for key, value in params.items()
            if key not in {"time", "mosaicRule"}
        }
        catalog_params["maxItemCount"] = "100"
        catalog_payload = base.safe_get("NWS HeatRisk catalog", endpoint, catalog_params)
        catalog = (catalog_payload or {}).get("catalogItems")
        features = catalog.get("features", []) if isinstance(catalog, dict) else []
        matches = []
        future_matches = []
        date_samples = []
        for feature in features if isinstance(features, list) else []:
            if not isinstance(feature, dict):
                continue
            attributes = feature.get("attributes")
            if not isinstance(attributes, dict):
                continue
            valid_iso = heat_risk_catalog_valid_time(
                {"catalogItems": {"features": [feature]}}
            )
            valid_dt = base.parse_dt(valid_iso) if valid_iso else None
            object_id = next(
                (value for name, value in attributes.items()
                 if name.lower().replace("_", "") == "objectid"),
                None,
            )
            if valid_dt is not None:
                date_samples.append(valid_dt.astimezone(timezone.utc).date().isoformat())
            if valid_dt is not None and object_id is not None:
                valid_date = valid_dt.astimezone(timezone.utc).date()
                if valid_date == local_date:
                    matches.append(object_id)
                elif valid_date > local_date:
                    future_matches.append((valid_date, object_id))

        print(
            f"NWS HeatRisk direct instant={payload.get('value') if isinstance(payload, dict) else None!r}; "
            f"catalog_dates={sorted(set(date_samples))}; matching_raster_ids={matches}"
        )
        for raster_id in matches:
            locked_params = dict(catalog_params)
            locked_params.pop("maxItemCount", None)
            locked_params["mosaicRule"] = json.dumps({
                "mosaicMethod": "esriMosaicLockRaster",
                "lockRasterIds": [raster_id],
                "mosaicOperation": "MT_FIRST",
            })
            candidate = base.safe_get("NWS HeatRisk locked raster", endpoint, locked_params)
            candidate_level = parse_heat_risk_pixel(candidate)
            candidate_valid = heat_risk_catalog_valid_time(candidate)
            candidate_dt = base.parse_dt(candidate_valid) if candidate_valid else None
            if (
                candidate_level is not None
                and candidate_dt is not None
                and candidate_dt.astimezone(timezone.utc).date() == local_date
            ):
                payload, level = candidate, candidate_level
                break

    if level is None:
        # Tomorrow's grid is planning context only, never a decision driver.
        for forecast_date, raster_id in sorted(future_matches):
            forecast_params = dict(catalog_params)
            forecast_params.pop("maxItemCount", None)
            forecast_params["mosaicRule"] = json.dumps({
                "mosaicMethod": "esriMosaicLockRaster",
                "lockRasterIds": [raster_id],
                "mosaicOperation": "MT_FIRST",
            })
            forecast_payload = base.safe_get(
                "NWS HeatRisk next forecast", endpoint, forecast_params
            )
            forecast_level = parse_heat_risk_pixel(forecast_payload)
            forecast_valid = heat_risk_catalog_valid_time(forecast_payload)
            forecast_dt = base.parse_dt(forecast_valid) if forecast_valid else None
            if (
                forecast_level is not None
                and forecast_dt is not None
                and forecast_dt.astimezone(timezone.utc).date() == forecast_date
            ):
                HEATRISK_NEXT = {
                    "level": forecast_level,
                    "display": f"{forecast_level} — {HEATRISK_NAMES[forecast_level]}",
                    "valid_date": forecast_date.isoformat(),
                    "valid_time": forecast_valid,
                    "decision_use": False,
                }
                print(
                    f"NWS HeatRisk next available forecast: "
                    f"{forecast_date.isoformat()} level={forecast_level}; "
                    "not used in today's decision."
                )
                break
        print("NWS HeatRisk: no verifiable current-day raster pixel was available.")
        return None

    valid_time = heat_risk_catalog_valid_time(payload)
    selected_dt = base.parse_dt(valid_time) if valid_time else None
    if selected_dt is None:
        print(
            "NWS HeatRisk: verified pixel was returned, but the selected "
            "raster valid time could not be verified. Ignoring HeatRisk."
        )
        return None

    selected_utc_date = selected_dt.astimezone(timezone.utc).date()
    if selected_utc_date != local_date:
        print(
            "NWS HeatRisk: selected raster is not for today; "
            f"target_utc_date={local_date.isoformat()} selected_utc_date={selected_utc_date.isoformat()}. "
            "Ignoring stale/future HeatRisk."
        )
        return None

    print(
        f"NWS HeatRisk verified pixel: {level}; "
        f"target={target_valid_time}; selected_valid_time={valid_time}"
    )
    return {
        "level": level,
        "display": f"{level} — {HEATRISK_NAMES[level]}",
        "note": "NWS experimental current-day HeatRisk · verified raster pixel",
        "valid_time": valid_time,
        "source_value": payload.get("value"),
    }


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
    if HEATRISK_NEXT is not None:
        summary = data.setdefault("summary", {})
        summary["heat_risk_next"] = HEATRISK_NEXT
        current_risk = summary.get("heat_risk") or {}
        if current_risk.get("level") is None:
            summary["heat_risk"] = {
                "level": None,
                "display": "Unavailable for today",
                "note": (
                    "NOAA no longer offers today's HeatRisk grid. "
                    f"The next available forecast is for {HEATRISK_NEXT['valid_date']}."
                ),
            }
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


base.fetch_heat_risk = fetch_heat_risk_verified


if __name__ == "__main__":
    exit_code = base.main()
    patched.improve_coverage()
    add_unofficial_observations()
    raise SystemExit(exit_code)
