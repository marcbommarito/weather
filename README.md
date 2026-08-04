# MUSD Extreme Weather Decision Dashboard

A GitHub Pages-ready dashboard for Menifee Union School District that combines official weather observations, NWS warnings and forecasts, optional EPA AirNow AQI, optional California DWR CIMIS station data, and district-configured action thresholds.

## What the dashboard does

- Pulls current observations from **KF70 French Valley**, **KHMT Hemet-Ryan**, and **KRIV March ARB** through the National Weather Service API.
- Pulls active NWS alerts for the district reference point and the next 24 hours of hourly forecasts.
- Attempts to retrieve the current-day NWS HeatRisk value. If that lookup is unavailable, the dashboard clearly directs staff to verify HeatRisk manually.
- Optionally pulls current AQI from EPA AirNow when an API key is configured.
- Optionally pulls hourly CIMIS data for stations 240, 179, 239, 62, and 237 when a CIMIS AppKey is configured.
- Calculates the highest applicable district action level and explains why that level was selected.
- Displays missing and stale feeds as unavailable rather than treating them as safe.

## Important limitation

This package does **not** include a real-time lightning-strike proximity feed. NWS thunderstorm forecasts and warnings are displayed, but a licensed service is needed for strike-distance alerts and an automated all-clear countdown.

## Deploy to GitHub Pages

1. Create a new GitHub repository, preferably named `musd-weather-dashboard`.
2. Upload the contents of this folder to the repository root and use `main` as the default branch.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, select **GitHub Actions** as the source.
5. Open **Actions** and run **Update weather data** once.
6. Run **Deploy dashboard to GitHub Pages** if it has not already run automatically.
7. The deployment action will display the public Pages URL.

GitHub's official Pages workflow uses `configure-pages@v5`, `upload-pages-artifact@v4`, and `deploy-pages@v4`.

## Enable AQI

1. Register for a free AirNow API key.
2. In the GitHub repository, open **Settings → Secrets and variables → Actions**.
3. Create a repository secret named `AIRNOW_API_KEY`.
4. Run the weather update workflow again.

## Enable CIMIS

1. Register for a CIMIS account and request an AppKey.
2. Create a repository secret named `CIMIS_APP_KEY`.
3. Run the weather update workflow again.

## Customize the district thresholds

Edit `config.json`. The main numeric thresholds are:

- `heatIndexF`: caution, modify, inclement, severe
- `aqi`: category starting values
- `windGustMph`: caution, modify, inclement, severe
- `precipProbabilityPct`: caution, modify, inclement, severe
- `stationStaleMinutes`: maximum age before an observation is marked stale

The included wind, heat-index and precipitation thresholds are **draft local operating settings**, not statements of statutory thresholds. Review them with the Risk Manager, Health Services, Athletics, Emergency Management, and legal counsel before formal adoption.

## Update frequency

The scheduled GitHub Action runs every 15 minutes. GitHub schedules can be delayed during periods of high demand, and Pages deployment can add several minutes. Always display and consider the dashboard's generated time and each station's observation time.

## Local preview

From the repository folder:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Decision logic

The overall level is the highest available level from:

- NWS HeatRisk (0–4)
- AQI category thresholds
- current heat index or temperature fallback
- current wind gust or wind-speed fallback
- next-six-hour precipitation probability and thunderstorm forecast
- active NWS alert severity, with tornado, flash-flood, and extreme-wind warnings elevated to level 4

The dashboard is decision support only. It does not independently close schools, cancel events, or replace an adopted district protocol.

## Data-source notes

- NWS observations can be delayed by quality-control processing.
- AirNow observations are preliminary and intended for AQI reporting and forecasting.
- CIMIS data are updated hourly and require an AppKey for API access.
- Personal weather stations shown on the map are not included in the decision calculation unless the district later adds a licensed, quality-controlled feed.

## License

MIT License. Review the source agencies' data-use terms and attribution requirements.
