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

  function renderReliableMap(config, data) {
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
    const minLat = Math.min(...lats) - 0.018;
    const maxLat = Math.max(...lats) + 0.018;
    const minLon = Math.min(...lons) - 0.018;
    const maxLon = Math.max(...lons) + 0.018;
    const width = 1000;
    const height = 560;
    const pad = 54;
    const x = (lon) => pad + ((Number(lon) - minLon) / Math.max(maxLon - minLon, .001)) * (width - pad * 2);
    const y = (lat) => height - pad - ((Number(lat) - minLat) / Math.max(maxLat - minLat, .001)) * (height - pad * 2);

    const grid = Array.from({length: 8}, (_, i) => {
      const gx = pad + i * (width - pad * 2) / 7;
      const gy = pad + i * (height - pad * 2) / 7;
      return `<line x1="${gx}" y1="${pad}" x2="${gx}" y2="${height-pad}" class="map-grid-line"/>` +
        `<line x1="${pad}" y1="${gy}" x2="${width-pad}" y2="${gy}" class="map-grid-line"/>`;
    }).join('');

    const cities = [
      ['Perris', 33.783, -117.229], ['Menifee', 33.728, -117.147],
      ['Hemet', 33.748, -116.972], ['Winchester', 33.707, -117.087],
      ['Murrieta', 33.554, -117.213], ['Temecula', 33.494, -117.148]
    ].map(([name, lat, lon]) => `<text x="${x(lon)}" y="${y(lat)}" class="map-city-label">${escapeHtml(name)}</text>`).join('');

    const markers = points.map((p) => {
      const obs = observations.get(String(p.id));
      const status = obs ? `${obs.temperature_f != null ? Math.round(obs.temperature_f) + '°F' : 'No temperature'}; ${obs.stale ? 'stale' : 'current'}` : (p.official ? 'No current observation' : 'Reference only');
      const label = `${p.id} — ${p.name}: ${status}`;
      const radius = p.district ? 10 : p.official ? 7 : 5;
      return `<g tabindex="0" role="img" aria-label="${escapeHtml(label)}"><circle cx="${x(p.lon)}" cy="${y(p.lat)}" r="${radius}" fill="${p.color}" stroke="#fff" stroke-width="2"><title>${escapeHtml(label)}</title></circle>${p.district ? `<text x="${x(p.lon)+12}" y="${y(p.lat)-8}" class="map-point-label">MUSD</text>` : ''}</g>`;
    }).join('');

    container.innerHTML = `<div class="station-map-shell">
      <div class="station-map-title"><strong>Menifee-area station coverage</strong><span>Reliable geographic planning view; personal stations are reference-only.</span></div>
      <svg class="station-map-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Map of Menifee-area weather stations">
        <rect width="${width}" height="${height}" class="map-background"/><rect x="${pad}" y="${pad}" width="${width-pad*2}" height="${height-pad*2}" class="map-plot"/>${grid}${cities}${markers}
        <text x="${width-pad}" y="${height-16}" text-anchor="end" class="map-axis-label">West ← longitude → East</text>
      </svg>
      <div class="map-legend"><span><b style="color:#7b1f7a">●</b> District office</span><span><b style="color:#1f5f9b">●</b> NWS / aviation</span><span><b style="color:#2f7d32">●</b> CIMIS</span><span><b style="color:#e8791a">●</b> Personal reference</span></div>
    </div>`;
  }

  async function repair() {
    fixAqiCard();
    try {
      const stamp = Date.now();
      const [config, data] = await Promise.all([
        fetch(`config.json?v=${stamp}`).then((r) => r.json()),
        fetch(`data/latest.json?v=${stamp}`).then((r) => r.json())
      ]);
      renderReliableMap(config, data);
      fixAqiCard();
    } catch (error) {
      console.warn('Dashboard repair layer could not load:', error);
    }
  }

  window.addEventListener('load', () => window.setTimeout(repair, 250));
})();
