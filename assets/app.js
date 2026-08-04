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

function initMap() {
  if (!window.L || !$('stationMap')) {
    $('stationMap').innerHTML = '<div class="no-data">Interactive map library did not load.</div>';
    return;
  }
  const center = CONFIG.district.center;
  stationMap = L.map('stationMap', {scrollWheelZoom: false}).setView([center.lat, center.lon], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(stationMap);

  L.marker([center.lat, center.lon], {title: CONFIG.district.shortName}).addTo(stationMap)
    .bindPopup(`<strong>${escapeHtml(CONFIG.district.name)}</strong><br>District reference point`);

  [5, 10, 15].forEach(miles => L.circle([center.lat, center.lon], {
    radius: miles * 1609.344, fill: false, weight: 1, dashArray: '6 6', color: '#17365d'
  }).addTo(stationMap).bindTooltip(`${miles}-mile radius`));

  const byId = new Map((DATA.stations || []).map(s => [String(s.id), s]));
  const addMarker = (s, color, official) => {
    const obs = byId.get(String(s.id));
    const text = obs
      ? `<strong>${escapeHtml(s.name)} (${escapeHtml(s.id)})</strong><br>${obs.temperature_f != null ? `${Math.round(obs.temperature_f)}°F` : 'Temp unavailable'} · ${obs.wind_gust_mph != null ? `Gust ${Math.round(obs.wind_gust_mph)} mph` : 'Gust unavailable'}<br>${escapeHtml(formatDateTime(obs.observed_at))}`
      : `<strong>${escapeHtml(s.name)} (${escapeHtml(s.id)})</strong><br>${official ? 'Configured source — no current observation' : 'Reference location only; not used in calculation'}`;
    L.circleMarker([s.lat, s.lon], {radius: official ? 8 : 5, color, fillColor: color, fillOpacity: official ? .85 : .45, weight: 2}).addTo(stationMap).bindPopup(text);
  };
  CONFIG.stations.nws.forEach(s => addMarker(s, '#1f5f9b', true));
  CONFIG.stations.cimis.forEach(s => addMarker(s, '#2f7d32', true));
  CONFIG.stations.referencePersonal.forEach(s => addMarker(s, '#e8791a', false));
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
    initMap();
  } catch (error) {
    $('errorBanner').classList.remove('hidden');
    $('errorBanner').textContent = `Dashboard could not load: ${error.message}`;
    $('levelLabel').textContent = 'Data unavailable — verify manually';
    $('levelAction').textContent = 'Use official NWS, AirNow and district emergency procedures until the dashboard is restored.';
  }
}

$('refreshButton').addEventListener('click', () => window.location.reload());
loadDashboard();
