'use strict';

const LEVEL_COLORS = ['#2f7d32', '#d9a400', '#e8791a', '#c73535', '#7b1f7a'];
let CONFIG = null;
let DATA = null;
let stationMap = null;
let QUALITY = null;
let renderTime = 0;
let refreshFailed = false;
let refreshInFlight = false;
const verificationAction = 'Verify current conditions with the National Weather Service, official air quality sources and district procedures before relying on this dashboard.';

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function formatDateTime(value) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG?.district?.timezone || 'America/Los_Angeles',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(date);
}

function formatHour(value) {
  if (!value) return '—';
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG?.district?.timezone || 'America/Los_Angeles', hour: 'numeric'
  }).format(date);
}

function metricCard(label, value, note, level = null) {
  const cls = Number.isInteger(level) ? ` level-${level}` : '';
  return `<article class="metric-card${cls}"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(value)}</div><p class="metric-note">${escapeHtml(note)}</p></article>`;
}

function setHero() {
  const evaluation = DATA.evaluation || {};
  const snapshotLevel = Number.isInteger(evaluation.level) ? evaluation.level : null;
  // A known hazard on a current snapshot remains visible even with another feed missing.
  const level = QUALITY.historical || (QUALITY.issues.length && snapshotLevel === 0) ? null : snapshotLevel;
  const hero = $('decisionHero');
  hero.className = `decision-hero ${level === null ? 'level-unknown' : `level-${level}`}`;
  $('levelNumber').textContent = level === null ? '?' : level;
  $('levelLabel').textContent = level === null
    ? `${QUALITY.status === 'Operational' ? 'Data unavailable' : QUALITY.status} · Verify official sources`
    : (evaluation.label || 'Verify official sources');
  $('levelAction').textContent = level === null ? verificationAction
    : [evaluation.action, QUALITY.issues.length ? verificationAction : ''].filter(Boolean).join(' ');
  $('generatedAt').textContent = formatDateTime(DATA.generated_at);
  $('dataStatus').textContent = QUALITY.status;
  $('nextUpdate').textContent = QUALITY.next == null ? 'Unavailable'
    : `${formatDateTime(QUALITY.next)}${renderTime > QUALITY.next ? ' (overdue)' : ''}`;
}

function setBanners() {
  $('sampleBanner').classList.toggle('hidden', !DATA.sample);
  $('sampleBanner').textContent = 'DEMO DATA: This preview uses sample values.';
  const alerts = QUALITY.historical && !DATA.sample && DATA.alerts?.length
    ? ['The last snapshot included a National Weather Service alert. Verify its current status directly.'] : [];
  const messages = [...QUALITY.issues, ...alerts, ...(DATA.errors || [])];
  $('errorBanner').classList.toggle('hidden', !messages.length);
  const message = messages.join(' ');
  if ($('errorBanner').textContent !== message) $('errorBanner').textContent = message;
}

function renderMetrics() {
  const s = DATA.summary || {};
  const currentHeatRisk = s.heat_risk || {};
  const nextHeatRisk = s.heat_risk_next || null;
  const hasCurrentHeatRisk = Number.isInteger(currentHeatRisk.level);
  const heatRiskLabel = !hasCurrentHeatRisk && nextHeatRisk
    ? 'NWS HeatRisk · next available forecast' : 'NWS HeatRisk';
  const heatRiskValue = !hasCurrentHeatRisk && nextHeatRisk
    ? nextHeatRisk.display : (currentHeatRisk.display ?? 'Unavailable');
  const heatRiskNote = !hasCurrentHeatRisk && nextHeatRisk
    ? `Valid ${nextHeatRisk.valid_date} · Future forecast only; not part of today's decision`
    : (currentHeatRisk.note ?? 'Current-day HeatRisk feed');
  const metrics = [
    metricCard(heatRiskLabel, heatRiskValue, heatRiskNote,
      hasCurrentHeatRisk ? currentHeatRisk.level : null),
    metricCard('Air Quality Index', s.aqi?.value ?? (s.aqi?.configured ? 'Unavailable' : 'Not configured'), s.aqi?.observed_at ? `Observed ${s.aqi.observed_at} · ${s.aqi.category || 'AirNow'}` : (s.aqi?.note ?? 'EPA AirNow observation unavailable'), s.aqi?.level),
    metricCard('Highest heat index', s.max_heat_index_f != null ? `${Math.round(s.max_heat_index_f)}°F` : 'Unavailable', s.max_heat_index_station || 'Across reporting official stations', s.heat_index_level),
    metricCard('Highest wind gust', s.max_wind_gust_mph != null ? `${Math.round(s.max_wind_gust_mph)} mph` : 'Unavailable', s.max_wind_gust_station || 'Across reporting official stations', s.wind_level),
    metricCard(QUALITY.historical ? '6-hour rain chance at last update' : 'Next 6-hour rain chance', s.max_precip_probability_pct != null ? `${Math.round(s.max_precip_probability_pct)}%` : 'Unavailable', s.thunderstorm_possible ? 'Thunderstorms possible' : 'NWS hourly forecast', s.precip_level),
    metricCard(QUALITY.historical ? 'NWS alerts in last snapshot' : 'Active NWS alerts',
      DATA.alerts?.length || (QUALITY.historical || DATA.errors?.some(e => /^NWS alerts:/i.test(e)) ? 'Unverified' : 0),
      QUALITY.historical ? 'Verify current alerts with NWS' : (DATA.alerts?.length ? 'Review official alert details below' : 'Verify current alerts with NWS'), s.alert_level)
  ];
  $('metricsGrid').innerHTML = (QUALITY.historical
    ? '<p class="fine-print">Values below are from the last snapshot, not live conditions.</p>' : '') + metrics.join('');
}

function renderActionsAndReasons() {
  const ev = DATA.evaluation || {};
  const rules = ev.recommended_actions || [];
  const actions = QUALITY.issues.length ? [verificationAction, ...(!QUALITY.historical && ev.level > 0 ? rules : [])]
    : (rules.length ? rules : [verificationAction]);
  const reasons = ev.reasons?.length
    ? ev.reasons.map(reason => QUALITY.historical ? `At last update: ${reason.replace(/\bcurrent\s+/gi, '')}` : reason)
    : ['No reliable decision calculation is currently available.'];
  $('recommendedActions').innerHTML = actions.map(x => `<li>${escapeHtml(x)}</li>`).join('');
  $('decisionReasons').innerHTML = reasons.map(x => `<li>${escapeHtml(x)}</li>`).join('');
}

function renderAlerts() {
  const alerts = DATA.alerts || [];
  if (!alerts.length) {
    const unverified = QUALITY.historical || DATA.errors?.some(e => /^NWS alerts:/i.test(e));
    $('alertsList').innerHTML = unverified
      ? '<div class="no-data">Current alerts are unverified. Check the National Weather Service directly.</div>'
      : '<div class="no-data">No active NWS alerts were returned for the district reference point.</div>';
    return;
  }
  $('alertsList').innerHTML = (QUALITY.historical
    ? '<p>Alerts from the last snapshot. Verify whether these are still active with the National Weather Service.</p>' : '') + alerts.map(alert => `
    <article class="alert-card level-${alert.level ?? 2}">
      <h3>${escapeHtml(alert.event || alert.headline || 'Weather alert')}</h3>
      <div class="alert-meta">
        <span><strong>Severity:</strong> ${escapeHtml(alert.severity || 'Unknown')}</span>
        <span><strong>Effective:</strong> ${escapeHtml(formatDateTime(alert.effective || alert.onset))}</span>
        <span><strong>Expires:</strong> ${escapeHtml(formatDateTime(alert.expires || alert.ends))}</span>
        <span><strong>Area:</strong> ${escapeHtml(alert.area_desc || 'District point')}</span>
      </div>
      <p>${escapeHtml(alert.headline || alert.description || '')}</p>
      ${alert.instruction ? `<details><summary>Official instructions</summary><p>${escapeHtml(alert.instruction)}</p></details>` : ''}
      ${alert.web ? `<p><a href="${escapeHtml(alert.web)}" target="_blank" rel="noreferrer">Open official alert</a></p>` : ''}
    </article>`).join('');
}

function renderCoverage() {
  const displayCoverage = item => {
    const rows = DATA.stations || [];
    let network = null;
    if (/National Weather Service stations/i.test(item.name)) network = /NWS/i;
    if (/CIMIS/i.test(item.name)) network = /CIMIS/i;
    if (network) {
      const matches = rows.filter(s => network.test(s.network || ''));
      const current = matches.filter(s => WeatherFreshness.station(s, CONFIG.thresholds, renderTime).current).length;
      const stale = matches.filter(s => WeatherFreshness.station(s, CONFIG.thresholds, renderTime).label === 'Stale').length;
      const total = (network.source === 'CIMIS' ? CONFIG.stations?.cimis : CONFIG.stations?.nws)?.length ?? matches.length;
      return {status: current === total ? 'available' : 'partial',
        detail: `${current} current, ${stale} stale, ${Math.max(0, total - current - stale)} unavailable of ${total} configured.`};
    }
    return QUALITY.historical && /^NWS point|^EPA AirNow/i.test(item.name) && item.status === 'available'
      ? {status: 'partial', detail: 'Last snapshot only; verify current conditions with the official source.'} : item;
  };
  $('coverageList').innerHTML = (DATA.coverage || []).map(item => {
    const {status, detail} = displayCoverage(item);
    const cls = status === 'available' ? 'status-ok' : status === 'partial' ? 'status-warning' : 'status-error';
    return `<div class="coverage-item"><span class="status-dot ${cls}" aria-hidden="true"></span><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detail)}</span></div></div>`;
  }).join('');
}

function renderStations() {
  const rows = DATA.stations || [];
  if (!rows.length) {
    $('stationRows').innerHTML = '<tr><td colspan="9">No official station observations are available.</td></tr>';
    return;
  }
  $('stationRows').innerHTML = rows.map(s => {
    const {label, age, current} = WeatherFreshness.station(s, CONFIG.thresholds, renderTime);
    const freshness = `<span class="${current ? 'fresh' : 'stale'}">${label}</span>`;
    const wind = age != null && s.wind_speed_mph != null ? `${Math.round(s.wind_speed_mph)} mph` : '—';
    return `<tr>
      <th scope="row">${escapeHtml(s.name)}<br><span class="fine-print">${escapeHtml(s.id)} · ${escapeHtml(s.network)}</span></th>
      <td>${escapeHtml(formatDateTime(s.observed_at))}</td>
      <td>${age != null && s.temperature_f != null ? `${Math.round(s.temperature_f)}°F` : '—'}</td>
      <td>${age != null && s.heat_index_f != null ? `${Math.round(s.heat_index_f)}°F` : '—'}</td>
      <td>${age != null && s.relative_humidity_pct != null ? `${Math.round(s.relative_humidity_pct)}%` : '—'}</td>
      <td>${escapeHtml(wind)}${age != null && s.wind_direction_deg != null ? ` / ${Math.round(s.wind_direction_deg)}°` : ''}</td>
      <td>${age != null && s.wind_gust_mph != null ? `${Math.round(s.wind_gust_mph)} mph` : '—'}</td>
      <td>${escapeHtml(age != null ? (s.condition || '—') : '—')}</td>
      <td>${freshness}<br><span class="fine-print">${age != null ? `${Math.round(age)} min old` : 'Unknown age'}</span></td>
    </tr>`;
  }).join('');
}

function renderForecast() {
  const periods = (DATA.forecast?.hourly || []).filter(p => WeatherFreshness.timestamp(p.end_time) > renderTime).slice(0, 12);
  if (!periods.length) {
    $('forecastStrip').innerHTML = '<div class="no-data">Hourly forecast unavailable.</div>';
    return;
  }
  $('forecastStrip').innerHTML = (QUALITY.historical
    ? '<p class="fine-print">From the last snapshot. Check NWS for the latest forecast.</p>' : '') + periods.map(p => `
    <article class="forecast-card">
      <span>${escapeHtml(formatHour(p.start_time))}</span>
      <strong>${p.temperature_f != null ? `${Math.round(p.temperature_f)}°` : '—'}</strong>
      <span>${escapeHtml(p.short_forecast || '—')}</span>
      <span>Rain: ${p.precip_probability_pct != null ? `${Math.round(p.precip_probability_pct)}%` : '—'}</span>
      <span>Wind: ${escapeHtml(p.wind_speed || '—')}</span>
    </article>`).join('');
}

function renderThresholds() {
  const t = CONFIG.thresholds;
  const rows = [
    ['Heat index (°F)', ...t.heatIndexF],
    ['AQI begins at', ...t.aqi],
    ['Wind gust (mph)', ...t.windGustMph],
    ['Rain chance (%)', ...t.precipProbabilityPct]
  ];
  $('thresholdTable').innerHTML = `<div class="threshold-grid">
    <div>Measure</div><div>Caution 1</div><div>Modify 2</div><div>Inclement 3</div><div>Severe 4</div>
    ${rows.flatMap(row => row.map((cell, i) => `<div>${i === 0 ? escapeHtml(cell) : escapeHtml(cell)}</div>`)).join('')}
  </div>`;
}

let leafletLoadPromise = null;

function addStylesheetOnce(href, id) {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function loadScriptWithTimeout(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      script.remove();
      reject(new Error(`Timed out loading ${src}`));
    }, timeoutMs);

    script.src = src;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error(`Could not load ${src}`));
    };
    document.head.appendChild(script);
  });
}

async function ensureLeaflet() {
  if (window.L) return true;
  if (leafletLoadPromise) return leafletLoadPromise;

  leafletLoadPromise = (async () => {
    const sources = [
      {
        css: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
        js: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js'
      },
      {
        css: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
        js: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js'
      }
    ];

    for (let i = 0; i < sources.length; i += 1) {
      try {
        addStylesheetOnce(sources[i].css, `leaflet-fallback-css-${i}`);
        await loadScriptWithTimeout(sources[i].js);
        if (window.L) return true;
      } catch (error) {
        console.warn(error.message);
      }
    }
    return false;
  })();

  return leafletLoadPromise;
}

function allConfiguredStations() {
  return [
    ...(CONFIG?.stations?.nws || []).map(s => ({...s, group: 'NWS / aviation', color: '#1f5f9b', official: true})),
    ...(CONFIG?.stations?.cimis || []).map(s => ({...s, group: 'CIMIS', color: '#2f7d32', official: true})),
    ...(CONFIG?.stations?.referencePersonal || []).map(s => ({...s, group: 'Personal reference', color: '#e8791a', official: false}))
  ].filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
}

function renderStaticStationMap(message = 'Interactive street-map tiles could not be loaded.') {
  const container = $('stationMap');
  if (!container) return;

  const center = CONFIG.district.center;
  const stations = allConfiguredStations();
  const points = [
    {name: CONFIG.district.shortName, id: 'District office', lat: center.lat, lon: center.lon, color: '#7b1f7a', official: true},
    ...stations
  ];

  const lats = points.map(p => Number(p.lat));
  const lons = points.map(p => Number(p.lon));
  const minLat = Math.min(...lats) - 0.025;
  const maxLat = Math.max(...lats) + 0.025;
  const minLon = Math.min(...lons) - 0.025;
  const maxLon = Math.max(...lons) + 0.025;
  const width = 900;
  const height = 500;
  const pad = 46;

  const x = lon => pad + ((Number(lon) - minLon) / Math.max(maxLon - minLon, 0.001)) * (width - pad * 2);
  const y = lat => height - pad - ((Number(lat) - minLat) / Math.max(maxLat - minLat, 0.001)) * (height - pad * 2);

  const grid = Array.from({length: 7}, (_, i) => {
    const gx = pad + i * (width - pad * 2) / 6;
    const gy = pad + i * (height - pad * 2) / 6;
    return `<line x1="${gx}" y1="${pad}" x2="${gx}" y2="${height - pad}" stroke="#cbd5df" stroke-width="1"/>` +
      `<line x1="${pad}" y1="${gy}" x2="${width - pad}" y2="${gy}" stroke="#cbd5df" stroke-width="1"/>`;
  }).join('');

  const stationSvg = points.map((p, index) => {
    const px = x(p.lon);
    const py = y(p.lat);
    const radius = index === 0 ? 9 : (p.official ? 7 : 5);
    const label = `${escapeHtml(p.id || '')}${p.name ? ` — ${escapeHtml(p.name)}` : ''}`;
    return `<g tabindex="0" role="img" aria-label="${label}">
      <circle cx="${px}" cy="${py}" r="${radius}" fill="${p.color}" stroke="white" stroke-width="2">
        <title>${label}</title>
      </circle>
      ${index === 0 ? `<text x="${px + 12}" y="${py - 8}" font-size="13" font-weight="700" fill="#17212b">MUSD</text>` : ''}
    </g>`;
  }).join('');

  container.innerHTML = `
    <div style="padding:.75rem;background:#fff;border-bottom:1px solid #d5dde5;font-size:.86rem;color:#485766">
      ${escapeHtml(message)} A geographic station plot is shown instead.
    </div>
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" role="img" aria-label="Geographic plot of Menifee-area weather stations" style="display:block;background:#eef3f7;min-height:430px">
      <rect x="${pad}" y="${pad}" width="${width - pad * 2}" height="${height - pad * 2}" fill="#f7fafc" stroke="#9aa9b6"/>
      ${grid}
      <text x="${pad}" y="28" font-size="16" font-weight="700" fill="#17365d">Menifee-area station coverage</text>
      <text x="${width - pad}" y="${height - 14}" text-anchor="end" font-size="11" fill="#52616f">West ← longitude → East</text>
      <text x="16" y="${pad}" font-size="11" fill="#52616f" transform="rotate(-90 16 ${pad})">South ← latitude → North</text>
      ${stationSvg}
    </svg>
    <div style="display:flex;gap:1rem;flex-wrap:wrap;padding:.65rem .8rem;background:#fff;border-top:1px solid #d5dde5;font-size:.8rem">
      <span><b style="color:#7b1f7a">●</b> District office</span>
      <span><b style="color:#1f5f9b">●</b> NWS / aviation</span>
      <span><b style="color:#2f7d32">●</b> CIMIS</span>
      <span><b style="color:#e8791a">●</b> Personal reference</span>
    </div>`;
}

function stationPopup(s) {
  const obs = (DATA.stations || []).find(o => String(o.id) === String(s.id));
  const freshness = WeatherFreshness.station(obs, CONFIG.thresholds).label;
  const status = obs && freshness !== 'Unavailable'
    ? `${obs.temperature_f != null ? `${Math.round(obs.temperature_f)}°F` : 'Temperature unavailable'} · ${obs.wind_gust_mph != null ? `Gust ${Math.round(obs.wind_gust_mph)} mph` : 'Gust unavailable'}<br>${escapeHtml(formatDateTime(obs.observed_at))}<br>${freshness} observation`
    : (s.official ? 'Configured official source · No current observation' : 'Reference location only; not used in calculation');
  return `<strong>${escapeHtml(s.name)} (${escapeHtml(s.id)})</strong><br>${escapeHtml(s.group)}<br>${status}`;
}

async function initMap() {
  const container = $('stationMap');
  if (!container) return;

  container.innerHTML = '<div class="no-data">Loading station map…</div>';
  const leafletReady = await ensureLeaflet();
  if (!leafletReady || !window.L) {
    renderStaticStationMap('The Leaflet map library was blocked or unavailable.');
    return;
  }

  try {
    if (stationMap) {
      stationMap.remove();
      stationMap = null;
    }
    container.innerHTML = '';

    const center = CONFIG.district.center;
    const stations = allConfiguredStations();
    stationMap = L.map(container, {
      scrollWheelZoom: false,
      zoomControl: true,
      preferCanvas: true
    });

    const primaryTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
      crossOrigin: true
    });

    const backupTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      crossOrigin: true
    });

    let tileErrors = 0;
    let switchedToBackup = false;
    primaryTiles.on('tileerror', () => {
      tileErrors += 1;
      if (tileErrors >= 4 && !switchedToBackup) {
        switchedToBackup = true;
        stationMap.removeLayer(primaryTiles);
        backupTiles.addTo(stationMap);
      }
    });
    backupTiles.on('tileerror', () => {
      tileErrors += 1;
      if (tileErrors >= 12) {
        try { stationMap.remove(); } catch (_) { /* no-op */ }
        stationMap = null;
        renderStaticStationMap('Both public street-map tile services were blocked or unavailable.');
      }
    });
    primaryTiles.addTo(stationMap);

    const bounds = L.latLngBounds();

    const districtMarker = L.circleMarker([center.lat, center.lon], {
      radius: 10,
      color: '#ffffff',
      weight: 3,
      fillColor: '#7b1f7a',
      fillOpacity: 1
    }).addTo(stationMap)
      .bindPopup(`<strong>${escapeHtml(CONFIG.district.name)}</strong><br>District reference point`);
    districtMarker.bindTooltip('MUSD District Office');
    bounds.extend([center.lat, center.lon]);

    [5, 10, 15].forEach(miles => L.circle([center.lat, center.lon], {
      radius: miles * 1609.344,
      fill: false,
      weight: 1,
      dashArray: '6 6',
      color: '#17365d',
      opacity: 0.7
    }).addTo(stationMap).bindTooltip(`${miles}-mile radius`));

    stations.forEach(s => {

      L.circleMarker([s.lat, s.lon], {
        radius: s.official ? 8 : 5,
        color: '#ffffff',
        fillColor: s.color,
        fillOpacity: s.official ? 0.9 : 0.65,
        weight: 2
      }).addTo(stationMap)
        .bindPopup(() => stationPopup(s))
        .bindTooltip(`${s.id} — ${s.name}`);
      bounds.extend([s.lat, s.lon]);
    });

    const legend = L.control({position: 'bottomright'});
    legend.onAdd = () => {
      const div = L.DomUtil.create('div');
      div.style.cssText = 'background:white;padding:8px 10px;border:1px solid #9aa9b6;border-radius:5px;box-shadow:0 1px 4px rgba(0,0,0,.25);font-size:12px;line-height:1.45';
      div.innerHTML = '<b>Stations</b><br><span style="color:#7b1f7a">●</span> District office<br><span style="color:#1f5f9b">●</span> NWS / aviation<br><span style="color:#2f7d32">●</span> CIMIS<br><span style="color:#e8791a">●</span> Personal reference';
      return div;
    };
    legend.addTo(stationMap);

    if (bounds.isValid()) {
      stationMap.fitBounds(bounds.pad(0.08), {padding: [24, 24], maxZoom: 11});
    } else {
      stationMap.setView([center.lat, center.lon], 10);
    }

    window.setTimeout(() => {
      if (stationMap) stationMap.invalidateSize(true);
    }, 150);
    window.addEventListener('resize', () => {
      if (stationMap) stationMap.invalidateSize(false);
    }, {passive: true});
  } catch (error) {
    console.error('Map initialization failed:', error);
    renderStaticStationMap(`Interactive map error: ${error.message}`);
  }
}

function renderLiveData() {
  renderTime = Date.now();
  const previous = QUALITY;
  QUALITY = WeatherFreshness.assess(DATA, CONFIG, renderTime, refreshFailed);
  setBanners();
  setHero();
  renderMetrics();
  renderActionsAndReasons();
  if (!previous || previous.historical !== QUALITY.historical) renderAlerts();
  renderCoverage();
  renderStations();
  renderForecast();
}

async function fetchJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`, {
    cache: 'no-store', signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return response.json();
}

async function refreshData() {
  if (!CONFIG) {
    window.location.reload();
    return;
  }
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const next = await fetchJson('data/latest.json');
    const nextTime = WeatherFreshness.timestamp(next?.generated_at);
    const currentTime = WeatherFreshness.timestamp(DATA.generated_at);
    if (!Number.isFinite(nextTime) || nextTime > Date.now() || (Number.isFinite(currentTime) && currentTime <= Date.now() && nextTime < currentTime)) {
      throw new Error('Latest snapshot has an invalid or older timestamp');
    }
    if (next.generated_at !== DATA.generated_at) {
      DATA = next;
      QUALITY = null;
      document.dispatchEvent(new Event('dashboard-data-updated'));
    }
    refreshFailed = false;
  } catch {
    refreshFailed = true;
  } finally {
    refreshInFlight = false;
    renderLiveData();
  }
}

async function loadDashboard() {
  try {
    const [config, data] = await Promise.all([fetchJson('config.json'), fetchJson('data/latest.json')]);
    CONFIG = config;
    DATA = data;
    document.title = `${CONFIG.district.shortName} ${CONFIG.district.dashboardTitle}`;
    $('footerDisclaimer').textContent = CONFIG.district.decisionDisclaimer;
    renderLiveData();
    renderThresholds();
    // Update the wall-clock even while the network refresh is still pending.
    window.setInterval(() => { renderLiveData(); void refreshData(); }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { renderLiveData(); void refreshData(); }
    });
    await initMap();
  } catch (error) {
    $('errorBanner').classList.remove('hidden');
    $('errorBanner').textContent = `Dashboard could not load: ${error.message}`;
    $('dataStatus').textContent = 'Data unavailable';
    $('levelLabel').textContent = 'Data unavailable · Verify official sources';
    $('levelAction').textContent = verificationAction;
  }
}

$('refreshButton').addEventListener('click', refreshData);
loadDashboard();
