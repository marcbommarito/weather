'use strict';

(() => {
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  function fixAqiCard() {
    for (const card of document.querySelectorAll('.metric-card')) {
      const label = card.querySelector('.metric-label')?.textContent?.trim();
      if (label !== 'Air Quality Index') continue;
      const note = card.querySelector('.metric-note')?.textContent || '';
      const value = card.querySelector('.metric-value');
      if (value && /key is configured|configured/i.test(note) && /not configured/i.test(value.textContent || '')) {
        value.textContent = 'Unavailable';
      }
    }
  }

  function stationDefinitions(config) {
    return [
      ...(config?.stations?.nws || []).map((s) => ({...s, color: '#1f5f9b', official: true, group: 'NWS / aviation'})),
      ...(config?.stations?.cimis || []).map((s) => ({...s, color: '#2f7d32', official: true, group: 'CIMIS'})),
      ...(config?.stations?.referencePersonal || []).map((s) => ({...s, color: '#e8791a', official: false, group: 'Personal reference'}))
    ].filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
  }

  function mercatorY(lat) {
    const limited = Math.max(-85, Math.min(85, Number(lat)));
    const radians = limited * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + radians / 2));
  }

  function renderStreetMap(config, data) {
    const container = document.getElementById('stationMap');
    if (!container || !config?.district?.center) return;

    const center = config.district.center;
    const observations = new Map((data?.stations || []).map((s) => [String(s.id), s]));
    const points = [
      {id: 'MUSD', name: 'District Office', lat: center.lat, lon: center.lon, color: '#7b1f7a', official: true, district: true},
      ...stationDefinitions(config)
    ];

    const lats = points.map((p) => Number(p.lat));
    const lons = points.map((p) => Number(p.lon));
    const minLat = Math.min(...lats) - 0.035;
    const maxLat = Math.max(...lats) + 0.035;
    const minLon = Math.min(...lons) - 0.035;
    const maxLon = Math.max(...lons) + 0.035;

    const embedParams = new URLSearchParams({
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      layer: 'mapnik',
      marker: `${center.lat},${center.lon}`
    });
    const embedUrl = `https://www.openstreetmap.org/export/embed.html?${embedParams.toString()}`;
    const fullMapUrl = `https://www.openstreetmap.org/?mlat=${center.lat}&mlon=${center.lon}#map=10/${center.lat}/${center.lon}`;

    const width = 1000;
    const height = 600;
    const minMerc = mercatorY(minLat);
    const maxMerc = mercatorY(maxLat);
    const x = (lon) => ((Number(lon) - minLon) / Math.max(maxLon - minLon, 0.001)) * width;
    const y = (lat) => ((maxMerc - mercatorY(lat)) / Math.max(maxMerc - minMerc, 0.001)) * height;

    const markers = points.map((p) => {
      const obs = observations.get(String(p.id));
      const status = obs
        ? `${obs.temperature_f != null ? Math.round(obs.temperature_f) + '°F' : 'temperature unavailable'}; ${obs.stale ? 'stale' : 'current'}`
        : (p.official ? 'no current observation' : 'reference only');
      const label = `${p.id} — ${p.name}: ${status}`;
      const radius = p.district ? 11 : p.official ? 8 : 6;
      const px = x(p.lon);
      const py = y(p.lat);
      return `<g role="img" aria-label="${escapeHtml(label)}">
        <circle cx="${px}" cy="${py}" r="${radius + 3}" fill="rgba(255,255,255,.88)"/>
        <circle cx="${px}" cy="${py}" r="${radius}" fill="${p.color}" stroke="#fff" stroke-width="2"><title>${escapeHtml(label)}</title></circle>
        ${p.district ? `<text x="${px + 15}" y="${py - 10}" class="map-point-label">MUSD</text>` : ''}
      </g>`;
    }).join('');

    container.innerHTML = `<div class="station-map-shell">
      <div class="station-map-title">
        <div><strong>Menifee-area station coverage</strong><span>Street map with official and reference station locations.</span></div>
        <a href="${fullMapUrl}" target="_blank" rel="noreferrer">Open full map</a>
      </div>
      <div class="station-map-frame-wrap">
        <iframe class="station-map-frame" src="${embedUrl}" title="OpenStreetMap of Menifee-area weather stations" loading="eager" referrerpolicy="no-referrer-when-downgrade"></iframe>
        <svg class="station-map-overlay" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Weather station locations">${markers}</svg>
      </div>
      <div class="map-legend">
        <span><b style="color:#7b1f7a">●</b> District office</span>
        <span><b style="color:#1f5f9b">●</b> NWS / aviation</span>
        <span><b style="color:#2f7d32">●</b> CIMIS</span>
        <span><b style="color:#e8791a">●</b> Personal reference</span>
      </div>
    </div>`;
  }

  async function repair() {
    fixAqiCard();
    try {
      const stamp = Date.now();
      const [config, data] = await Promise.all([
        fetch(`config.json?v=${stamp}`).then((r) => {
          if (!r.ok) throw new Error('Could not load config.json');
          return r.json();
        }),
        fetch(`data/latest.json?v=${stamp}`).then((r) => {
          if (!r.ok) throw new Error('Could not load data/latest.json');
          return r.json();
        })
      ]);
      renderStreetMap(config, data);
      fixAqiCard();
    } catch (error) {
      console.warn('Dashboard repair layer could not load:', error);
    }
  }

  window.addEventListener('load', () => {
    window.setTimeout(repair, 300);
    window.setTimeout(repair, 9000);
  });
})();
