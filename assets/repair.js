'use strict';

(() => {
  const TILE_SIZE = 256;

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

  function worldPixel(lat, lon, zoom) {
    const scale = TILE_SIZE * (2 ** zoom);
    const limitedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
    const latRadians = limitedLat * Math.PI / 180;
    return {
      x: ((Number(lon) + 180) / 360) * scale,
      y: (1 - Math.asinh(Math.tan(latRadians)) / Math.PI) / 2 * scale
    };
  }

  function chooseZoom(points) {
    for (let zoom = 13; zoom >= 8; zoom -= 1) {
      const pixels = points.map((point) => worldPixel(point.lat, point.lon, zoom));
      const width = Math.max(...pixels.map((point) => point.x)) - Math.min(...pixels.map((point) => point.x)) + 180;
      const height = Math.max(...pixels.map((point) => point.y)) - Math.min(...pixels.map((point) => point.y)) + 180;
      if (width <= 1050 && height <= 650) return zoom;
    }
    return 8;
  }

  function renderStreetMap(config, data) {
    const container = document.getElementById('stationMap');
    if (!container || !config?.district?.center) return;

    const center = config.district.center;
    const observations = new Map((data?.stations || []).map((station) => [String(station.id), station]));
    const points = [
      {id: 'MUSD', name: 'District Office', lat: center.lat, lon: center.lon, color: '#7b1f7a', official: true, district: true, group: 'District'},
      ...stationDefinitions(config)
    ];

    const zoom = chooseZoom(points);
    const pointPixels = points.map((point) => ({...point, ...worldPixel(point.lat, point.lon, zoom)}));
    const padding = 72;
    const minPointX = Math.min(...pointPixels.map((point) => point.x)) - padding;
    const maxPointX = Math.max(...pointPixels.map((point) => point.x)) + padding;
    const minPointY = Math.min(...pointPixels.map((point) => point.y)) - padding;
    const maxPointY = Math.max(...pointPixels.map((point) => point.y)) + padding;

    const tileCount = 2 ** zoom;
    const startTileX = Math.max(0, Math.floor(minPointX / TILE_SIZE));
    const endTileX = Math.min(tileCount - 1, Math.floor(maxPointX / TILE_SIZE));
    const startTileY = Math.max(0, Math.floor(minPointY / TILE_SIZE));
    const endTileY = Math.min(tileCount - 1, Math.floor(maxPointY / TILE_SIZE));
    const originX = startTileX * TILE_SIZE;
    const originY = startTileY * TILE_SIZE;
    const mapWidth = (endTileX - startTileX + 1) * TILE_SIZE;
    const mapHeight = (endTileY - startTileY + 1) * TILE_SIZE;

    const tiles = [];
    for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
      for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
        const left = ((tileX * TILE_SIZE - originX) / mapWidth) * 100;
        const top = ((tileY * TILE_SIZE - originY) / mapHeight) * 100;
        const width = TILE_SIZE / mapWidth * 100;
        const height = TILE_SIZE / mapHeight * 100;
        tiles.push(`<img class="map-tile" src="https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png" alt="" loading="eager" decoding="async" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%">`);
      }
    }

    const markers = pointPixels.map((point) => {
      const observation = observations.get(String(point.id));
      const status = observation
        ? `${observation.temperature_f != null ? Math.round(observation.temperature_f) + ' degrees F' : 'temperature unavailable'}, ${observation.stale ? 'stale' : 'current'}`
        : (point.official ? 'no current observation' : 'reference only');
      const label = `${point.id} - ${point.name}: ${status}`;
      const left = ((point.x - originX) / mapWidth) * 100;
      const top = ((point.y - originY) / mapHeight) * 100;
      const visibleLabel = point.district || point.official ? escapeHtml(point.id) : '';
      return `<button class="station-marker ${point.district ? 'district-marker' : point.official ? 'official-marker' : 'reference-marker'}" type="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" style="left:${left}%;top:${top}%;--marker-color:${point.color}">
        <span class="marker-dot" aria-hidden="true"></span>${visibleLabel ? `<span class="marker-label">${visibleLabel}</span>` : ''}
      </button>`;
    }).join('');

    const isFullPage = document.body.classList.contains('station-map-page');
    const mapLink = isFullPage
      ? `https://www.openstreetmap.org/#map=${zoom}/${center.lat}/${center.lon}`
      : 'map.html';
    const mapLinkText = isFullPage ? 'Open in OpenStreetMap' : 'Open full map with all stations';

    container.innerHTML = `<div class="station-map-shell">
      <div class="station-map-title">
        <div><strong>Menifee-area station coverage</strong><span>Markers are positioned directly on OpenStreetMap tiles.</span></div>
        <a href="${mapLink}" ${isFullPage ? 'target="_blank" rel="noreferrer"' : ''}>${mapLinkText}</a>
      </div>
      <div class="station-map-viewport" style="aspect-ratio:${mapWidth}/${mapHeight}">
        ${tiles.join('')}
        <div class="map-tile-message" hidden>Street-map tiles could not be loaded. Use the map link above.</div>
        ${markers}
        <div class="map-attribution"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></div>
      </div>
      <div class="map-legend">
        <span><b style="color:#7b1f7a">●</b> District office</span>
        <span><b style="color:#1f5f9b">●</b> NWS / aviation</span>
        <span><b style="color:#2f7d32">●</b> CIMIS</span>
        <span><b style="color:#e8791a">●</b> Personal reference</span>
      </div>
    </div>`;

    let failedTiles = 0;
    const tileElements = [...container.querySelectorAll('.map-tile')];
    const tileMessage = container.querySelector('.map-tile-message');
    tileElements.forEach((tile) => {
      tile.addEventListener('error', () => {
        failedTiles += 1;
        tile.classList.add('map-tile-failed');
        if (failedTiles === tileElements.length && tileMessage) tileMessage.hidden = false;
      });
    });
  }

  async function repair() {
    fixAqiCard();
    try {
      const stamp = Date.now();
      const [config, data] = await Promise.all([
        fetch(`config.json?v=${stamp}`).then((response) => {
          if (!response.ok) throw new Error('Could not load config.json');
          return response.json();
        }),
        fetch(`data/latest.json?v=${stamp}`).then((response) => {
          if (!response.ok) throw new Error('Could not load data/latest.json');
          return response.json();
        })
      ]);
      renderStreetMap(config, data);
      fixAqiCard();
    } catch (error) {
      console.warn('Dashboard repair layer could not load:', error);
    }
  }

  window.addEventListener('load', () => window.setTimeout(repair, 300));
})();
