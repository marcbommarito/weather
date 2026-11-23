'use strict';

const WeatherFreshness = (() => {
  function timestamp(value) {
    // Do not interpret a missing timezone as the viewer's local timezone.
    return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? Date.parse(value) : NaN;
  }

  function station(observation, thresholds, now = Date.now()) {
    const time = timestamp(observation?.observed_at);
    if (!Number.isFinite(time) || time > now) {
      return {label: 'Unavailable', age: null, current: false};
    }
    const age = (now - time) / 60000;
    const cutoff = thresholds?.stationStaleMinutes ?? 120;
    return age > cutoff
      ? {label: 'Stale', age, current: false}
      : {label: 'Current', age, current: true};
  }

  function assess(data, config, now = Date.now(), refreshFailed = false) {
    const generated = timestamp(data.generated_at);
    const cadence = Number(config.refreshMinutes) > 0 ? Number(config.refreshMinutes) : 15;
    const invalid = !Number.isFinite(generated) || generated > now;
    const next = invalid ? null : generated + cadence * 60000;
    const delayed = !invalid && now >= generated + 2 * cadence * 60000;
    const rows = data.stations || [];
    const issues = [];
    if (invalid) issues.push('The snapshot timestamp is invalid or in the future.');
    if (delayed) issues.push('Two or more expected update intervals have passed.');
    if (refreshFailed) issues.push('The latest refresh could not be checked.');
    if (data.sample) issues.push('This snapshot contains sample data.');
    if (!Number.isFinite(data.summary?.aqi?.value) || data.errors?.some(e => /^EPA AirNow:/i.test(e))) {
      issues.push('AirNow air quality data is unavailable or incomplete.');
    }
    if (!rows.some(s => /CIMIS/i.test(s.network || '')) || data.errors?.some(e => /^CIMIS:/i.test(e))) {
      issues.push('CIMIS station data is unavailable or incomplete.');
    }
    if (data.errors?.some(e => /^NWS/i.test(e))) issues.push('A National Weather Service request failed.');
    if (!rows.length || rows.some(s => !station(s, config.thresholds, now).current)) {
      issues.push('Some official station observations are stale or unavailable.');
    }
    if (rows.some(s => [s.temperature_f, s.relative_humidity_pct, s.wind_speed_mph].some(n => !Number.isFinite(n)))) {
      issues.push('Some official station readings are incomplete.');
    }
    if (data.evaluation?.data_status !== 'Operational') issues.push('The snapshot reports incomplete official coverage.');

    const historical = invalid || delayed || refreshFailed || !!data.sample;
    return {next, delayed, historical, issues,
      status: invalid ? 'Data unavailable' : delayed ? 'Data delayed'
        : issues.length ? 'Partial data' : 'Operational'};
  }

  return {station, assess, timestamp};
})();
