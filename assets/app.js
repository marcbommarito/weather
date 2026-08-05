'use strict';

const LEVEL_COLORS = ['#2f7d32', '#d9a400', '#e8791a', '#c73535', '#7b1f7a'];
let CONFIG = null;
let DATA = null;
let stationMap = null;

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
  const level = Number.isInteger(evaluation.level) ? evaluation.level : null;
  const hero = $('decisionHero');
  hero.className = `decision-hero ${level === null ? 'level-unknown' : `level-${level}`}`;
  $('levelNumber').textContent = level === null ? '?' : level;
  $('levelLabel').textContent = evaluation.label || 'Data unavailable — verify manually';
  $('levelAction').textContent = evaluation.action || 'Do not rely on this dashboard until official data sources are restored.';
  $('generatedAt').textContent = formatDateTime(DATA.generated_at);
  $('dataStatus').textContent = evaluation.data_status || 'Unknown';
  if (DATA.generated_at && CONFIG.refreshMinutes) {
    const next = new Date(new Date(DATA.generated_at).getTime() + CONFIG.refreshMinutes * 60000);
    $('nextUpdate').textContent = formatDateTime(next.toISOString());
  } else {
    $('nextUpdate').textContent = 'Unavailable';
  }
}

function setBanners() {
  if (DATA.sample) {
    $('sampleBanner').classList.remove('hidden');
    $('sampleBanner').textContent = 'DEMO DATA: This preview uses sample values. Run the GitHub Action to replace it with live official feeds.';
  }
  if (DATA.errors?.length) {
    $('errorBanner').classList.remove('hidden');
    $('errorBanner').textContent = `Some feeds were unavailable: ${DATA.errors.join(' | ')}`;
  }
}

function renderMetrics() {
  const s = DATA.summary || {};
  const metrics = [
    metricCard('NWS HeatRisk', s.heat_risk?.display ?? 'Unavailable', s.heat_risk?.note ?? 'Current-day HeatRisk feed', s.heat_risk?.level),
    metricCard('Air Quality Index', s.aqi?.value ?? 'Not configured', s.aqi?.note ?? 'EPA AirNow API key required', s.aqi?.level),
    metricCard('Highest heat index', s.max_heat_index_f != null ? `${Math.round(s.max_heat_index_f)}°F` : 'Unavailable', s.max_heat_index_station || 'Across reporting official stations', s.heat_index_level),
    metricCard('Highest wind gust', s.max_wind_gust_mph != null ? `${Math.round(s.max_wind_gust_mph)} mph` : 'Unavailable', s.max_wind_gust_station || 'Across reporting official stations', s.wind_level),
    metricCard('Next 6-hour rain chance', s.max_precip_probability_pct != null ? `${Math.round(s.max_precip_probability_pct)}%` : 'Unavailable', s.thunderstorm_possible ? 'Thunderstorms possible' : 'NWS hourly forecast', s.precip_level),
    metricCard('Active NWS alerts', DATA.alerts?.length ?? 0, DATA.alerts?.length ? 'Review official alert details below' : 'No active point alerts', s.alert_level)
  ];
  $('metricsGrid').innerHTML = metrics.join('');
}

function renderActionsAndReasons() {
  const ev = DATA.evaluation || {};
  const actions = ev.recommended_actions?.length ? ev.recommended_actions : ['Verify conditions manually and follow district protocols.'];
  const reasons = ev.reasons?.length ? ev.reasons : ['No reliable decision calculation is currently available.'];
  $('recommendedActions').innerHTML = actions.map(x => `<li>${escapeHtml(x)}</li>`).join('');
  $('decisionReasons').innerHTML = reasons.map(x => `<li>${escapeHtml(x)}</li>`).join('');
}

function renderAlerts() {
  const alerts = DATA.alerts || [];
  if (!alerts.length) {
    $('alertsList').innerHTML = '<div class="no-data">No active NWS alerts were returned for the district reference point.</div>';
    return;
  }
  $('alertsList').innerHTML = alerts.map(alert => `
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
  const coverage = DATA.coverage || [];
  $('coverageList').innerHTML = coverage.map(item => {
    const cls = item.status === 'available' ? 'status-ok' : item.status === 'partial' ? 'status-warning' : 'status-error';
    return `<div class="coverage-item"><span class="status-dot ${cls}" aria-hidden="true"></span><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.detail)}</span></div></div>`;
  }).join('');
}

function renderStations() {
  const rows = DATA.stations || [];
  if (!rows.length) {
    $('stationRows').innerHTML = '<tr><td colspan="9">No official station observations are available.</td></tr>';
    return;
  }
  $('stationRows').innerHTML = rows.map(s => {
    const freshness = s.stale ? '<span class="stale">Stale</span>' : '<span class="fresh">Current</span>';
    const wind = s.wind_speed_mph != null ? `${Math.round(s.wind_speed_mph)} mph` : '—';
    return `<tr>
      <th scope="row">${escapeHtml(s.name)}<br><span class="fine-print">${escapeHtml(s.id)} · ${escapeHtml(s.network)}</span></th>
      <td>${escapeHtml(formatDateTime(s.observed_at))}</td>
      <td>${s.temperature_f != null ? `${Math.round(s.temperature_f)}°F` : '—'}</td>
      <td>${s.heat_index_f != null ? `${Math.round(s.heat_index_f)}°F` : '—'}</td>
      <td>${s.relative_humidity_pct != null ? `${Math.round(s.relative_humidity_pct)}%` : '—'}</td>
      <td>${escapeHtml(wind)}${s.wind_direction_deg != null ? ` / ${Math.round(s.wind_direction_deg)}°` : ''}</td>
      <td>${s.wind_gust_mph != null ? `${Math.round(s.wind_gust_mph)} mph` : '—'}</td>
      <td>${escapeHtml(s.condition || '—')}</td>
      <td>${freshness}<br><span class="fine-print">${s.age_minutes != null ? `${Math.round(s.age_minutes)} min old` : 'Unknown age'}</span></td>
    </tr>`;
  }).join('');
}

function renderForecast() {
  const periods = (DATA.forecast?.hourly || []).slice(0, 12);
  if (!periods.length) {
    $('forecastStrip').innerHTML = '<div class="no-data">Hourly forecast unavailable.</div>';
    return;
  }
  $('forecastStrip').innerHTML = periods.map(p => `
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
    const byId = new Map((DATA.stations || []).map(s => [String(s.id), s]));

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
      const obs = byId.get(String(s.id));
      const status = obs
        ? `${obs.temperature_f != null ? `${Math.round(obs.temperature_f)}°F` : 'Temperature unavailable'} · ${obs.wind_gust_mph != null ? `Gust ${Math.round(obs.wind_gust_mph)} mph` : 'Gust unavailable'}<br>${escapeHtml(formatDateTime(obs.observed_at))}`
        : (s.official ? 'Configured official source — no current observation' : 'Reference location only; not used in calculation');
      const text = `<strong>${escapeHtml(s.name)} (${escapeHtml(s.id)})</strong><br>${escapeHtml(s.group)}<br>${status}`;

      L.circleMarker([s.lat, s.lon], {
        radius: s.official ? 8 : 5,
        color: '#ffffff',
        fillColor: s.color,
        fillOpacity: s.official ? 0.9 : 0.65,
        weight: 2
      }).addTo(stationMap)
        .bindPopup(text)
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

async function loadDashboard() {
  try {
    const cacheBust = `?v=${Date.now()}`;
    [CONFIG, DATA] = await Promise.all([
      fetch(`config.json${cacheBust}`).then(r => { if (!r.ok) throw new Error('Could not load config.json'); return r.json(); }),
      fetch(`data/latest.json${cacheBust}`).then(r => { if (!r.ok) throw new Error('Could not load data/latest.json'); return r.json(); })
    ]);
    document.title = `${CONFIG.district.shortName} ${CONFIG.district.dashboardTitle}`;
    $('footerDisclaimer').textContent = CONFIG.district.decisionDisclaimer;
    setBanners();
    setHero();
    renderMetrics();
    renderActionsAndReasons();
    renderAlerts();
    renderCoverage();
    renderStations();
    renderForecast();
    renderThresholds();
    await initMap();
  } catch (error) {
    $('errorBanner').classList.remove('hidden');
    $('errorBanner').textContent = `Dashboard could not load: ${error.message}`;
    $('levelLabel').textContent = 'Data unavailable — verify manually';
    $('levelAction').textContent = 'Use official NWS, AirNow and district emergency procedures until the dashboard is restored.';
  }
}

$('refreshButton').addEventListener('click', () => window.location.reload());
loadDashboard();
