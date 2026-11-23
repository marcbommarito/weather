const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const config = JSON.parse(readFileSync('config.json'));
const js = name => readFileSync(`assets/${name}.js`, 'utf8');
const base = Date.parse('2026-11-23T13:04:55Z');
const at = (mins, from = base) => new Date(from + mins * 60000).toISOString();
const station = (id, network, observed_at) => ({
  id, name: id, network, observed_at, age_minutes: 0, stale: false,
  temperature_f: 49, relative_humidity_pct: 80, wind_speed_mph: 0
});
const report = (generated = base) => ({
  generated_at: at(0, generated), sample: false,
  stations: [station('KF70', 'NWS / aviation', at(-119, generated)),
    station('240', 'California DWR CIMIS', at(-10, generated))],
  summary: { aqi: { value: 24, configured: true }, max_heat_index_f: 49 },
  evaluation: { level: 0, label: 'Normal outdoor operations', action: 'Continue normal operations',
    data_status: 'Operational', recommended_actions: ['Continue normal operations'] },
  alerts: [], errors: [],
  coverage: [{name: 'National Weather Service stations', status: 'available', detail: 'Current at generation'}],
  forecast: {hourly: [{start_time: at(-30, generated), end_time: at(30, generated)}]}
});

test('freshness uses a strict station boundary, not stale flags or frozen ages', () => {
  const ctx = vm.createContext({});
  vm.runInContext(js('freshness'), ctx);
  const f = vm.runInContext('WeatherFreshness', ctx);
  for (const [minutes, label] of [[119, 'Current'], [120, 'Current'], [121, 'Stale'], [180, 'Stale']]) {
    assert.equal(f.station(station('A', 'NWS', at(-minutes)), config.thresholds, base).label, label);
  }
  for (const timestamp of [null, '2026-11-23T13:00:00', 'garbage', at(1)]) {
    assert.equal(f.station(station('A', 'NWS', timestamp), config.thresholds, base).label, 'Unavailable');
  }
  assert.equal(f.assess({...report(), generated_at: at(1)}, config, base).status, 'Data unavailable');
});

test('dashboard ages without reload, retries failures, preserves real warnings, and recovers', async () => {
  let now = base, data = report(), requestFailed = false, tick;
  const nodes = new Map();
  const node = id => {
    if (id === 'stationMap') return null;
    if (!nodes.has(id)) nodes.set(id, {textContent: '', innerHTML: '',
      classList: {toggle() {}, remove() {}}, addEventListener(_, cb) {this.action = cb;}});
    return nodes.get(id);
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: Clock, Intl, AbortSignal, console, Event,
    document: {getElementById: node, addEventListener() {}, dispatchEvent() {}},
    window: {setInterval(cb) {tick = cb;}, location: {reload() { assert.fail('unexpected reload'); }}},
    fetch: async uri => {
      if (requestFailed) throw new Error('test network failure');
      return {ok: true, json: async () => structuredClone(uri.startsWith('config.json') ? config : data)};
    }
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  vm.runInContext(js('freshness'), context);
  vm.runInContext(js('app'), context);
  await flush();
  const popup = () => vm.runInContext("stationPopup({id:'KF70', name:'French Valley', group:'Aviation', official:true})", context);
  assert.match(popup(), /49°F.*Current observation/);
  assert.equal(node('levelLabel').textContent, 'Normal outdoor operations');
  assert.match(node('stationRows').innerHTML, /119 min old/);
  now += 2 * 60000;
  tick();
  await flush();
  assert.match(node('stationRows').innerHTML, /Stale.*121 min old/);
  assert.match(popup(), /Stale observation/);
  assert.equal(node('dataStatus').textContent, 'Partial data');
  assert.doesNotMatch(node('recommendedActions').innerHTML, /Continue normal/);
  now = base + 30 * 60000;
  tick();
  await flush();
  assert.equal(node('dataStatus').textContent, 'Data delayed');
  assert.match(node('nextUpdate').textContent, /overdue/);
  assert.match(node('alertsList').innerHTML, /unverified/);
  assert.match(node('forecastStrip').innerHTML, /unavailable/);

  data = report(now);
  data.stations = data.stations.filter(s => s.id !== '240');
  data.stations[0].observed_at = at(1, now);
  data.summary.aqi.value = null;
  data.errors = ['CIMIS: HTTP 500', 'EPA AirNow: HTTP 504'];
  await node('refreshButton').action();
  assert.equal(node('dataStatus').textContent, 'Partial data');
  assert.match(node('errorBanner').textContent, /CIMIS.*AirNow|AirNow.*CIMIS/);
  assert.match(node('stationRows').innerHTML, /Unavailable.*Unknown age/);
  assert.match(popup(), /No current observation/);
  assert.doesNotMatch(popup(), /49°F/);
  assert.doesNotMatch(node('levelLabel').textContent, /Normal/);

  now += 60000;
  data = report(now);
  data.errors = ['CIMIS: HTTP 500'];
  data.evaluation = {level: 3, label: 'Inclement weather procedures', data_status: 'Operational',
    action: 'Stop affected outdoor activities.', recommended_actions: ['Stop affected outdoor activities.']};
  data.alerts = [{level: 3, event: 'Flash Flood Warning', expires: at(60, now)}];
  await node('refreshButton').action();
  assert.equal(node('levelLabel').textContent, 'Inclement weather procedures');
  assert.match(node('recommendedActions').innerHTML, /Verify current conditions.*Stop affected outdoor/);
  assert.match(node('alertsList').innerHTML, /Flash Flood Warning/);

  requestFailed = true;
  await node('refreshButton').action();
  assert.equal(node('levelNumber').textContent, '?');
  assert.match(node('alertsList').innerHTML, /last snapshot.*Flash Flood Warning/s);
  assert.match(node('errorBanner').textContent, /latest refresh could not be checked/);

  now += 60000;
  requestFailed = false;
  data = report(now);
  tick();
  await flush();
  assert.equal(node('dataStatus').textContent, 'Operational');
  assert.equal(node('levelLabel').textContent, 'Normal outdoor operations');
  assert.equal(node('errorBanner').textContent, '');
  assert.doesNotMatch(node('alertsList').innerHTML, /Flash Flood Warning/);
});
