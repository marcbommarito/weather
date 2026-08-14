'use strict';

(() => {
  let attempts = 0;
  const maxAttempts = 60;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function installStyles() {
    if (document.getElementById('musd-school-map-styles')) return;
    const style = document.createElement('style');
    style.id = 'musd-school-map-styles';
    style.textContent = `
      .musd-school-div-icon,
      .musd-office-div-icon {
        background: transparent !important;
        border: 0 !important;
      }
      .musd-school-icon,
      .musd-office-icon {
        display: grid;
        place-items: center;
        border: 2px solid #fff;
        border-radius: 50%;
        box-shadow: 0 1px 5px rgba(0,0,0,.42);
        line-height: 1;
      }
      .musd-school-icon {
        width: 28px;
        height: 28px;
        background: #17365d;
        font-size: 16px;
        transform: translate(-1px, -1px);
      }
      .musd-office-icon {
        width: 32px;
        height: 32px;
        background: #7b1f7a;
        font-size: 18px;
      }
      .musd-school-tooltip {
        font-weight: 800;
        color: #17365d;
      }
      .musd-school-legend {
        background: #fff;
        padding: 7px 9px;
        border: 1px solid #9aa9b6;
        border-radius: 5px;
        box-shadow: 0 1px 4px rgba(0,0,0,.22);
        font-size: 12px;
        line-height: 1.35;
      }
    `;
    document.head.appendChild(style);
  }

  function addSchools() {
    attempts += 1;

    if (window.__MUSD_SCHOOLS_ADDED__) return;
    if (typeof L === 'undefined' || typeof CONFIG === 'undefined' || !CONFIG || typeof stationMap === 'undefined' || !stationMap) {
      if (attempts < maxAttempts) window.setTimeout(addSchools, 250);
      return;
    }

    const schools = (CONFIG.schools || []).filter((school) =>
      Number.isFinite(Number(school.lat)) && Number.isFinite(Number(school.lon))
    );
    if (!schools.length) return;

    installStyles();

    const office = CONFIG.district?.office;
    if (office && Number.isFinite(Number(office.lat)) && Number.isFinite(Number(office.lon))) {
      const officeIcon = L.divIcon({
        className: 'musd-office-div-icon',
        html: '<span class="musd-office-icon" aria-hidden="true">🏛️</span>',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -18],
        tooltipAnchor: [0, -17]
      });
      L.marker([office.lat, office.lon], {
        icon: officeIcon,
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: 900
      }).addTo(stationMap)
        .bindTooltip(escapeHtml(office.name), {
          direction: 'top',
          opacity: 0.97,
          className: 'musd-school-tooltip'
        })
        .bindPopup(`<strong>${escapeHtml(office.name)}</strong><br>${escapeHtml(office.address || '')}`);
    }

    const schoolIcon = L.divIcon({
      className: 'musd-school-div-icon',
      html: '<span class="musd-school-icon" aria-hidden="true">🏫</span>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -16],
      tooltipAnchor: [0, -15]
    });

    const schoolLayer = L.layerGroup().addTo(stationMap);
    schools.forEach((school) => {
      const marker = L.marker([school.lat, school.lon], {
        icon: schoolIcon,
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: 700
      }).addTo(schoolLayer);

      marker.bindTooltip(escapeHtml(school.name), {
        direction: 'top',
        opacity: 0.97,
        className: 'musd-school-tooltip'
      });

      marker.bindPopup(
        `<strong>${escapeHtml(school.name)}</strong><br>` +
        `${escapeHtml(school.level || 'School')}<br>` +
        `${escapeHtml(school.address || '')}`
      );
    });

    const legend = L.control({position: 'bottomleft'});
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'musd-school-legend');
      div.innerHTML = '<strong>Campuses</strong><br>🏛️ District office<br>🏫 MUSD school';
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    legend.addTo(stationMap);

    window.__MUSD_SCHOOLS_ADDED__ = true;
    window.__MUSD_SCHOOL_LAYER__ = schoolLayer;
  }

  window.addEventListener('load', () => window.setTimeout(addSchools, 250));
})();
