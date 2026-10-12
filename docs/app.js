(function () {
  'use strict';

  var VERSION = '6';
  window.addEventListener('error', function (e) {
    var l = document.getElementById('lead');
    if (l) l.textContent = 'Errore: ' + (e.message || 'sconosciuto') + ' (versione ' + VERSION + ')';
  });
  window.addEventListener('unhandledrejection', function (e) {
    var l = document.getElementById('lead');
    if (l) l.textContent = 'Errore: ' + ((e.reason && e.reason.message) || 'sconosciuto') + ' (versione ' + VERSION + ')';
  });

  var LAT = 45.9003, LON = 12.17, TZ = 'Europe/Rome';
  var NDAYS = 9, TTL = 30 * 60 * 1000, TIMEOUT = 10000, RETRIES = 2;
  var NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  var VARS = ['tmin', 'tmax', 'prec', 'prob', 'wind', 'gust'];
  var RANGE = { tmin: 20, tmax: 20, prec: 20, prob: 100, wind: 40, gust: 60 };
  var LIMITS = { tmin: [-60, 60], tmax: [-60, 60], prec: [0, 600], prob: [0, 100], wind: [0, 250], gust: [0, 400] };
  var PREC7 = [0, 0.1, 0.6, 2.5, 7, 13, 23, 40, 62, 80];
  var WIND7 = { 1: 0.15, 2: 1.9, 3: 5.7, 4: 9.4, 5: 14, 6: 20.9, 7: 28.5, 8: 35 };

  // ---------- utilità ----------
  var dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  function dayOf(d) { return dayFmt.format(d); }
  function num(x) { return (x === null || x === undefined || x === '') ? NaN : Number(x); }
  function ok(x) { return typeof x === 'number' && isFinite(x); }
  function red(arr, fn) { var a = arr.filter(ok); return a.length ? fn(a) : NaN; }
  function MIN(a) { return Math.min.apply(null, a); }
  function MAX(a) { return Math.max.apply(null, a); }
  function SUM(a) { return a.reduce(function (s, x) { return s + x; }, 0); }
  function MEAN(a) { return SUM(a) / a.length; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function row(date, tmin, tmax, prec, prob, wind, gust) {
    return { date: date, tmin: num(tmin), tmax: num(tmax), prec: num(prec), prob: num(prob), wind: num(wind), gust: num(gust) };
  }
  function windowDates() {
    var b = dayOf(new Date()).split('-').map(Number), out = [], i;
    for (i = 0; i < NDAYS; i++) out.push(dayFmt.format(new Date(Date.UTC(b[0], b[1] - 1, b[2] + i, 12))));
    return out;
  }
  function toDate(s) { var p = s.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); }
  function fmtWd(d) { return new Intl.DateTimeFormat('it-IT', { weekday: 'short', timeZone: 'UTC' }).format(d).replace('.', ''); }
  function fmtDm(d) { return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d).replace('.', ''); }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignora */ } }
  function getKeys() { try { return JSON.parse(lsGet('meteo.keys') || '{}'); } catch (e) { return {}; } }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function getJson(url, headers) {
    var attempt = 0;
    function go() {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
      return fetch(url, { signal: ctrl.signal, headers: headers || undefined })
        .then(function (r) { clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(function (e) {
          clearTimeout(timer);
          if (attempt < RETRIES) { var w = Math.pow(2, attempt) * 1000; attempt++; return sleep(w).then(go); }
          throw new Error(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'errore di rete');
        });
    }
    return go();
  }

  // ---------- fonti ----------
  function openMeteo(model) {
    var q = 'latitude=' + LAT + '&longitude=' + LON +
      '&daily=temperature_2m_min,temperature_2m_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_mean,wind_speed_10m_max,wind_gusts_10m_max' +
      '&models=' + model + '&timezone=Europe%2FRome&forecast_days=' + NDAYS + '&wind_speed_unit=kmh';
    return getJson('https://api.open-meteo.com/v1/forecast?' + q).then(function (j) {
      var d = j.daily, out = [], i;
      function has(a) { return a && a.some(function (x) { return x !== null; }); }
      var wm = has(d.wind_speed_10m_mean) ? d.wind_speed_10m_mean : (d.wind_speed_10m_max || []);
      var pr = d.precipitation_probability_max || [];
      for (i = 0; i < d.time.length; i++) {
        out.push(row(d.time[i], d.temperature_2m_min[i], d.temperature_2m_max[i], d.precipitation_sum[i], pr[i], wm[i], d.wind_gusts_10m_max[i]));
      }
      return out;
    });
  }

  function metNo() {
    var url = 'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=' + LAT.toFixed(4) + '&lon=' + LON.toFixed(4);
    var headers = NATIVE ? { 'User-Agent': 'meteo-pieve-di-soligo-app/1.0' } : undefined;
    return getJson(url, headers).then(function (j) {
      var days = {};
      j.properties.timeseries.forEach(function (ts) {
        var day = dayOf(new Date(ts.time));
        var b = days[day] || (days[day] = { t: [], p: [], pr: [], w: [], g: [] });
        var det = ts.data.instant.details;
        b.t.push(num(det.air_temperature));
        b.w.push(num(det.wind_speed) * 3.6);
        b.g.push(num(det.wind_speed_of_gust) * 3.6);
        var n1 = ts.data.next_1_hours, n6 = ts.data.next_6_hours;
        if (n1) b.p.push(num(n1.details.precipitation_amount));
        else if (n6) b.p.push(num(n6.details.precipitation_amount));
        if (n6) b.pr.push(num(n6.details.probability_of_precipitation));
      });
      return Object.keys(days).sort().filter(function (d) { return days[d].t.length >= 4; }).map(function (d) {
        var b = days[d];
        return row(d, red(b.t, MIN), red(b.t, MAX), red(b.p, SUM), red(b.pr, MAX), red(b.w, MEAN), red(b.g, MAX));
      });
    });
  }

  function sevenTimer() {
    var url = 'https://www.7timer.info/bin/api.pl?lon=' + LON + '&lat=' + LAT + '&product=civil&output=json&unit=metric';
    return getJson(url).then(function (j) {
      var s = String(j.init);
      var init = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10));
      var days = {};
      j.dataseries.forEach(function (p) {
        var day = dayOf(new Date(init + p.timepoint * 3600000));
        var b = days[day] || (days[day] = { t: [], p: [], w: [] });
        b.t.push(num(p.temp2m));
        var cl = num(p.prec_amount);
        b.p.push((ok(cl) ? (PREC7[Math.min(Math.max(cl, 0), 9)] || 0) : 0) * 3);
        var ws = num(p.wind10m && p.wind10m.speed);
        b.w.push(ok(ws) && WIND7[ws] !== undefined ? WIND7[ws] * 3.6 : NaN);
      });
      return Object.keys(days).sort().filter(function (d) { return days[d].t.length >= 4; }).map(function (d) {
        var b = days[d];
        return row(d, red(b.t, MIN), red(b.t, MAX), red(b.p, SUM), NaN, red(b.w, MEAN), NaN);
      });
    });
  }

  function owm(key) {
    var url = 'https://api.openweathermap.org/data/2.5/forecast?lat=' + LAT + '&lon=' + LON + '&units=metric&appid=' + encodeURIComponent(key);
    return getJson(url).then(function (j) {
      var days = {};
      j.list.forEach(function (e) {
        var day = dayOf(new Date(e.dt * 1000));
        var b = days[day] || (days[day] = { tmin: [], tmax: [], p: [], pr: [], w: [], g: [] });
        b.tmin.push(num(e.main.temp_min));
        b.tmax.push(num(e.main.temp_max));
        var rain = e.rain ? num(e.rain['3h']) : 0, snow = e.snow ? num(e.snow['3h']) : 0;
        b.p.push((ok(rain) ? rain : 0) + (ok(snow) ? snow : 0));
        b.pr.push(num(e.pop) * 100);
        b.w.push(num(e.wind && e.wind.speed) * 3.6);
        b.g.push(num(e.wind && e.wind.gust) * 3.6);
      });
      return Object.keys(days).sort().filter(function (d) { return days[d].tmin.length >= 4; }).map(function (d) {
        var b = days[d];
        return row(d, red(b.tmin, MIN), red(b.tmax, MAX), red(b.p, SUM), red(b.pr, MAX), red(b.w, MEAN), red(b.g, MAX));
      });
    });
  }

  function weatherApi(key) {
    var url = 'https://api.weatherapi.com/v1/forecast.json?key=' + encodeURIComponent(key) + '&q=' + LAT + ',' + LON + '&days=' + NDAYS + '&aqi=no&alerts=no';
    return getJson(url).then(function (j) {
      return j.forecast.forecastday.map(function (fd) {
        var d = fd.day, hrs = fd.hour || [];
        var wind = hrs.length ? red(hrs.map(function (h) { return num(h.wind_kph); }), MEAN) : num(d.maxwind_kph);
        var gust = hrs.length ? red(hrs.map(function (h) { return num(h.gust_kph); }), MAX) : NaN;
        var prob = red([num(d.daily_chance_of_rain), num(d.daily_chance_of_snow)], MAX);
        return row(fd.date, d.mintemp_c, d.maxtemp_c, d.totalprecip_mm, prob, wind, gust);
      });
    });
  }

  function visualCrossing(key) {
    var url = 'https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/' + LAT + ',' + LON +
      '/next7days?unitGroup=metric&include=days&contentType=json&key=' + encodeURIComponent(key);
    return getJson(url).then(function (j) {
      return j.days.map(function (d) { return row(d.datetime, d.tempmin, d.tempmax, d.precip, d.precipprob, d.windspeed, d.windgust); });
    });
  }

  function tomorrow(key) {
    var url = 'https://api.tomorrow.io/v4/weather/forecast?location=' + LAT + ',' + LON + '&timesteps=1d&units=metric&apikey=' + encodeURIComponent(key);
    return getJson(url).then(function (j) {
      return j.timelines.daily.map(function (e) {
        var v = e.values;
        var prec = v.rainAccumulationSum !== undefined ? v.rainAccumulationSum : v.rainAccumulationAvg;
        var prob = v.precipitationProbabilityMax !== undefined ? v.precipitationProbabilityMax : v.precipitationProbabilityAvg;
        return row(dayOf(new Date(e.time)), v.temperatureMin, v.temperatureMax, prec, prob, num(v.windSpeedAvg) * 3.6, num(v.windGustMax) * 3.6);
      });
    });
  }

  var SOURCES = [
    { id: 'ecmwf', name: 'Open-Meteo · ECMWF IFS', run: function () { return openMeteo('ecmwf_ifs025'); } },
    { id: 'icon', name: 'Open-Meteo · DWD ICON', run: function () { return openMeteo('icon_seamless'); } },
    { id: 'gfs', name: 'Open-Meteo · NOAA GFS', run: function () { return openMeteo('gfs_seamless'); } },
    { id: 'arpege', name: 'Open-Meteo · Météo-France ARPEGE', run: function () { return openMeteo('meteofrance_seamless'); } },
    { id: 'metno', name: 'MET Norway', run: metNo },
    { id: '7timer', name: '7Timer', run: sevenTimer },
    { id: 'owm', name: 'OpenWeatherMap', key: 'owm', run: owm },
    { id: 'wapi', name: 'WeatherAPI', key: 'wapi', run: weatherApi },
    { id: 'vc', name: 'Visual Crossing', key: 'vc', run: visualCrossing },
    { id: 'tio', name: 'Tomorrow.io', key: 'tio', run: tomorrow }
  ];

  function valid(rows) {
    if (!rows || !rows.length) return false;
    var any = false;
    for (var i = 0; i < rows.length; i++) {
      for (var k = 0; k < VARS.length; k++) {
        var v = rows[i][VARS[k]];
        if (ok(v)) { if (v < LIMITS[VARS[k]][0] || v > LIMITS[VARS[k]][1]) return false; if (k < 2) any = true; }
      }
    }
    return any;
  }
  function readCache(id) {
    try {
      var c = JSON.parse(lsGet('meteo.c9.' + id) || 'null');
      if (!c) return null;
      return { t: c.t, rows: c.rows.map(function (r) { return row(r.date, r.tmin, r.tmax, r.prec, r.prob, r.wind, r.gust); }) };
    } catch (e) { return null; }
  }
  function load(src, force) {
    var keys = getKeys();
    if (src.key && !keys[src.key]) return Promise.resolve({ src: src, status: 'nokey', rows: [] });
    var c = readCache(src.id), now = Date.now();
    if (c && !force && now - c.t < TTL && valid(c.rows)) return Promise.resolve({ src: src, status: 'ok', rows: c.rows, t: c.t });
    return src.run(src.key ? keys[src.key] : undefined).then(function (rows) {
      if (!valid(rows)) throw new Error('dati vuoti o fuori intervallo');
      lsSet('meteo.c9.' + src.id, JSON.stringify({ t: now, rows: rows }));
      return { src: src, status: 'ok', rows: rows, t: now };
    }).catch(function (e) {
      if (c && valid(c.rows)) return { src: src, status: 'stale', rows: c.rows, t: c.t, error: e.message };
      return { src: src, status: 'err', rows: [], error: e.message };
    });
  }

  // ---------- stato e aggregazione ----------
  var state = { hourly: [], hourlyDone: false, sky: [], sun: null, air: null, skyDone: false, airDone: false, done: 0, dates: [], results: [], frames: {}, ids: [], sel: 0, mode: 'mean', A: null, loading: false, last: null };

  function val(id, d, v) {
    var r = state.frames[id] && state.frames[id][state.dates[d]];
    return r ? r[v] : NaN;
  }
  function median(a) {
    var s = a.filter(ok).sort(function (x, y) { return x - y; });
    if (!s.length) return NaN;
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function aggregate(ids) {
    var days = [], weights = {}, d;
    for (d = 0; d < NDAYS; d++) days.push({ agr: [], n: 0 });
    VARS.forEach(function (v) {
      var piv = [];
      for (d = 0; d < NDAYS; d++) piv.push(ids.map(function (id) { return val(id, d, v); }));
      var med = piv.map(median);
      var w = ids.map(function (id, k) {
        var s = 0, c = 0, dd;
        for (dd = 0; dd < NDAYS; dd++) { var x = piv[dd][k]; if (ok(x) && ok(med[dd])) { s += Math.pow(x - med[dd], 2); c++; } }
        return c ? 1 / (Math.max(s / c, 0.25) + 1e-6) : 0;
      });
      weights[v] = w;
      for (d = 0; d < NDAYS; d++) {
        var xs = piv[d], num_ = 0, den = 0, vals = [], k;
        for (k = 0; k < xs.length; k++) if (ok(xs[k])) { num_ += w[k] * xs[k]; den += w[k]; vals.push(xs[k]); }
        var sd = NaN;
        if (vals.length) { var mu = MEAN(vals); sd = Math.sqrt(SUM(vals.map(function (x) { return Math.pow(x - mu, 2); })) / vals.length); }
        days[d][v] = { mean: den > 0 ? num_ / den : NaN, med: median(xs), min: vals.length ? MIN(vals) : NaN, max: vals.length ? MAX(vals) : NaN, sd: sd, n: vals.length };
        days[d].n = Math.max(days[d].n, vals.length);
        if (vals.length >= 2) days[d].agr.push(1 - Math.min(1, sd / RANGE[v]));
      }
    });
    days.forEach(function (o) { o.agreement = o.agr.length ? 100 * MEAN(o.agr) : NaN; });
    return { days: days, weights: weights };
  }

  // ---------- interfaccia ----------
  function pick(o) { return state.mode === 'mean' ? o.mean : o.med; }
  function f(x, nd) { return ok(x) ? x.toFixed(nd === undefined ? 1 : nd).replace('.', ',') : 'n/d'; }
  function cls(a) { return !ok(a) ? 'off' : a >= 85 ? 'ok' : a >= 65 ? 'warn' : 'bad'; }
  function lab(a) { return !ok(a) ? 'n/d' : a >= 85 ? 'Alto' : a >= 65 ? 'Medio' : 'Basso'; }
  var SINK = document.createElement('div');
  function $(id) { return document.getElementById(id) || SINK; }


  // ---------- icone meteo ----------
  var CL = 'M11 25h17.5a5.5 5.5 0 0 0 .9-10.9A8 8 0 0 0 14 12.8 6.3 6.3 0 0 0 11 25z';
  function cloudP(tr, strong) {
    return '<path d="' + CL + '"' + (tr ? ' transform="' + tr + '"' : '') + ' fill="' + (strong ? 'var(--cloud)' : 'var(--cloud-bg)') +
      '" stroke="var(--cloud)" stroke-width="1.6" stroke-linejoin="round"/>';
  }
  function sunP(cx, cy, r, rays) {
    var s = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="var(--sunfill)"/>', a;
    for (a = 0; a < 8; a++) {
      var an = a * Math.PI / 4, c = Math.cos(an), n = Math.sin(an);
      s += '<line x1="' + (cx + c * (r + 2.5)).toFixed(1) + '" y1="' + (cy + n * (r + 2.5)).toFixed(1) + '" x2="' + (cx + c * (r + rays)).toFixed(1) + '" y2="' + (cy + n * (r + rays)).toFixed(1) + '" stroke="var(--sunfill)" stroke-width="2.2" stroke-linecap="round"/>';
    }
    return s;
  }
  function drops(xs, y0, len, w) {
    return xs.map(function (x) {
      return '<line x1="' + x + '" y1="' + y0 + '" x2="' + (x - 2.2) + '" y2="' + (y0 + len) + '" stroke="var(--rain)" stroke-width="' + w + '" stroke-linecap="round"/>';
    }).join('');
  }
  function flake(x, y) {
    return '<path d="M' + (x - 3) + ' ' + y + 'h6M' + x + ' ' + (y - 3) + 'v6M' + (x - 2.2) + ' ' + (y - 2.2) + 'l4.4 4.4M' + (x - 2.2) + ' ' + (y + 2.2) + 'l4.4 -4.4" stroke="var(--rain)" stroke-width="1.5" stroke-linecap="round" fill="none"/>';
  }
  var ICONS = {
    sun: { l: 'Sereno', g: function () { return sunP(20, 20, 7, 6); } },
    moon: { l: 'Sereno', g: function () { return '<path d="M25 7a13 13 0 1 0 9 22A11 11 0 0 1 25 7z" fill="var(--cloud)"/>'; } },
    few: { l: 'Poco nuvoloso', g: function () { return sunP(15, 15, 6, 5) + cloudP('translate(7 8) scale(.85)'); } },
    moonc: { l: 'Poco nuvoloso', g: function () { return '<path d="M19 5a10 10 0 1 0 7 17A8.5 8.5 0 0 1 19 5z" fill="var(--cloud)"/>' + cloudP('translate(7 8) scale(.85)'); } },
    part: { l: 'Variabile', g: function () { return sunP(26, 13, 5.5, 4.5) + cloudP('translate(-1 6)'); } },
    cloud: { l: 'Nuvoloso', g: function () { return cloudP('translate(0 5)'); } },
    over: { l: 'Coperto', g: function () { return cloudP('translate(-4 -1) scale(.85)', true) + cloudP('translate(3 7)'); } },
    rain1: { l: 'Pioggia debole', g: function () { return cloudP('translate(0 -1)') + drops([17, 25], 28, 5, 2.2); } },
    rain2: { l: 'Pioggia moderata', g: function () { return cloudP('translate(0 -1)') + drops([14, 21, 28], 28, 7, 2.4); } },
    rain3: { l: 'Pioggia forte', g: function () { return cloudP('translate(0 -2)', true) + drops([13, 19.5, 26, 32], 26, 10, 2.8); } },
    storm: { l: 'Temporale', g: function () { return cloudP('translate(0 -2)', true) + '<polygon points="22,22 16,31 20.5,31 18,38 27,27 22,27 25,22" fill="var(--sunfill)" stroke="var(--warn)" stroke-width="1" stroke-linejoin="round"/>' + drops([12, 30], 27, 6, 2.2); } },
    hail: { l: 'Grandine possibile', g: function () {
      return cloudP('translate(0 -2)', true) + [[14, 28], [22, 31], [30, 28], [18, 36], [27, 36]].map(function (p) {
        return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.6" fill="var(--bad)" stroke="var(--surface)" stroke-width="1"/>';
      }).join(''); } },
    snow: { l: 'Neve', g: function () { return cloudP('translate(0 -2)') + flake(15, 31) + flake(23, 35) + flake(30, 30); } }
  };
  function icon(kind, size) {
    var d = ICONS[kind];
    if (!d) return '';
    return '<svg viewBox="0 0 40 40" width="' + size + '" height="' + size + '" role="img" aria-label="' + d.l + '" style="width:' + size + 'px;height:' + size + 'px">' + d.g() + '</svg>';
  }
  function cloudKind(c, night) {
    if (!ok(c)) return '';
    if (c < 20) return night ? 'moon' : 'sun';
    if (c < 45) return night ? 'moonc' : 'few';
    if (c < 70) return night ? 'moonc' : 'part';
    return c < 85 ? 'cloud' : 'over';
  }
  function rainLevel(mm, perHour) {
    var a = perHour ? 1 : 2, b = perHour ? 4 : 10;
    return mm < a ? 'rain1' : mm < b ? 'rain2' : 'rain3';
  }
  // tipo di giornata: grandine > temporale > neve > pioggia > nuvolosità.
  // Per oggi si guarda solo il tempo che resta, dall'ora attuale a mezzanotte.
  function dayKind(i, o) {
    var date = state.dates[i], N = state.hourly.length, from = i === 0 ? nowHour() : 0, hail = 0, storm = 0, snow = 0, hr, ccs = [], mms = [], prs = [];
    for (hr = from; hr < 24; hr++) {
      var c = hourCons(date, hr);
      if (c.hail > 0) hail++;
      if (c.storm > 0 && c.storm >= Math.min(2, N)) storm++;
      if (c.nm > 0 && c.snow * 2 >= c.nm) snow++;
      if (ok(c.mm)) mms.push(c.mm);
      if (ok(c.pr)) prs.push(c.pr);
      if (ok(c.cc)) ccs.push(c.cc);
    }
    if (hail > 0) return 'hail';
    if (storm > 0) return 'storm';
    if (snow >= (i === 0 ? 1 : 2)) return 'snow';
    var mm = pick(o.prec), pr = pick(o.prob);
    if (i === 0 && mms.length) { mm = SUM(mms); pr = prs.length ? MAX(prs) : pr; }
    var minMm = i === 0 ? 0.3 : 0.5;
    if (ok(mm) && mm >= minMm && (!ok(pr) || pr >= 30)) return rainLevel(mm, false);
    var cl = [], night = false, tm = sunTimes(date);
    try {
      var es = [];
      for (hr = from; hr < 24; hr++) es.push(skyHour(date, hr, tm));
      var dayE = es.filter(function (e) { return e.day; });
      if (i === 0 && tm && !dayE.length) { night = true; dayE = es; }
      else if (i !== 0) dayE = dayE.length ? dayE : es;
      cl = dayE.map(function (e) { return e.c; }).filter(ok);
    } catch (e) { cl = []; }
    var cloud = cl.length ? MEAN(cl) : (ccs.length ? MEAN(ccs) : NaN);
    return cloudKind(cloud, night);
  }
  function hourKind(date, hr, c, tm) {
    if (c.hail > 0) return 'hail';
    if (c.storm >= Math.min(2, state.hourly.length) && c.storm > 0) return 'storm';
    if (c.nm > 0 && c.snow * 2 >= c.nm && c.wet) return 'snow';
    if (c.wet && ok(c.mm)) return rainLevel(c.mm, true);
    var night = false, cloud = NaN;
    if (tm) night = Math.max(0, Math.min(hr * 60 + 60, tm.set) - Math.max(hr * 60, tm.rise)) === 0;
    try { var e = skyHour(date, hr, tm); if (ok(e.c)) cloud = e.c; } catch (x) { cloud = NaN; }
    if (!ok(cloud)) cloud = c.cc;
    return cloudKind(cloud, night);
  }

  function renderDays(A) {
    var h = '';
    A.days.forEach(function (o, i) {
      var t = toDate(state.dates[i]), k = '';
      try { k = dayKind(i, o); } catch (e) { k = ''; }
      if (!k) { try { var sd = skyDay(i); k = sd.has ? cloudKind(sd.cloud, false) : ''; } catch (e2) { k = ''; } }
      h += '<button type="button" class="day" data-d="' + i + '" aria-pressed="' + (i === state.sel) + '">' +
        '<span class="dn">' + fmtWd(t) + '</span><span class="dd">' + fmtDm(t) + (i === 0 ? ' · da ora' : '') + '</span>' +
        (k ? '<span class="ic">' + icon(k, 36) + '<span>' + ICONS[k].l + '</span></span>' : '') +
        '<span class="tt"><span class="tmax">' + f(pick(o.tmax), 0) + '°</span><span class="tmin">' + f(pick(o.tmin), 0) + '°</span></span>' +
        '<span class="rr">' + f(pick(o.prec)) + ' mm · ' + f(pick(o.prob), 0) + '%</span>' +
        '<span class="pill ' + cls(o.agreement) + '">Accordo ' + lab(o.agreement) + '</span></button>';
    });
    $('days').innerHTML = h;
  }

  function renderChart(A) {
    var W = 420, H = 240, L = 34, R = 12, T = 16, B = 34, mn = Infinity, mx = -Infinity;
    A.days.forEach(function (o) {
      ['tmin', 'tmax'].forEach(function (v) { if (ok(o[v].min)) mn = Math.min(mn, o[v].min); if (ok(o[v].max)) mx = Math.max(mx, o[v].max); });
    });
    if (!isFinite(mn) || !isFinite(mx)) { $('chart').innerHTML = '<div class="empty">Nessun dato di temperatura.</div>'; return; }
    var lo = Math.floor(mn / 2) * 2 - 2, hi = Math.ceil(mx / 2) * 2 + 2;
    function X(d) { return L + (W - L - R) * (d + 0.5) / NDAYS; }
    function Y(v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); }
    var bw = (W - L - R) / NDAYS;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Temperature minime e massime per giorno con intervallo tra fonti">', t;
    for (t = lo; t <= hi; t += 2) s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(t) + '" y2="' + Y(t) + '"/><text class="ax" x="' + (L - 8) + '" y="' + (Y(t) + 4) + '" text-anchor="end">' + t + '°</text>';
    s += '<rect x="' + (X(state.sel) - bw / 2) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" fill="var(--sel)"/>';
    [['tmax', 'var(--tmax)'], ['tmin', 'var(--tmin)']].forEach(function (p) {
      var pts = [];
      A.days.forEach(function (o, d) {
        var c = o[p[0]]; if (!ok(c.min)) return;
        s += '<rect x="' + (X(d) - 6) + '" y="' + Y(c.max) + '" width="12" height="' + Math.max(2, Y(c.min) - Y(c.max)) + '" rx="3" fill="' + p[1] + '" fill-opacity="0.35"/>';
        pts.push(X(d) + ',' + Y(pick(c)));
      });
      s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + p[1] + '" stroke-width="2"/>';
      A.days.forEach(function (o, d) { var c = o[p[0]]; if (ok(pick(c))) s += '<circle cx="' + X(d) + '" cy="' + Y(pick(c)) + '" r="4" fill="' + p[1] + '" stroke="var(--surface)" stroke-width="2"/>'; });
    });
    A.days.forEach(function (o, d) {
      var dt = toDate(state.dates[d]);
      s += '<text class="ax" x="' + X(d) + '" y="' + (H - 20) + '" text-anchor="middle">' + fmtWd(dt) + '</text><text class="ax" x="' + X(d) + '" y="' + (H - 7) + '" text-anchor="middle">' + dt.getUTCDate() + '</text>';
      s += '<rect data-d="' + d + '" x="' + (X(d) - bw / 2) + '" y="' + T + '" width="' + bw + '" height="' + (H - T) + '" fill="transparent" style="cursor:pointer"/>';
    });
    $('chart').innerHTML = s + '</svg>';
  }

  function renderTable(A) {
    var h = '<thead><tr><th>Data</th><th>Tmin</th><th>Tmax</th><th>Pioggia mm</th><th>Prob. %</th><th>Vento km/h</th><th>Raffica km/h</th><th>Accordo</th><th>Fonti</th></tr></thead><tbody>';
    A.days.forEach(function (o, i) {
      var dt = toDate(state.dates[i]);
      h += '<tr data-d="' + i + '" class="' + (i === state.sel ? 'sel' : '') + '"><td>' +
        new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(dt) + '</td>' +
        '<td>' + f(pick(o.tmin)) + '</td><td>' + f(pick(o.tmax)) + '</td><td>' + f(pick(o.prec)) + '</td><td>' + f(pick(o.prob), 0) + '</td>' +
        '<td>' + f(pick(o.wind)) + '</td><td>' + f(pick(o.gust)) + '</td>' +
        '<td><span class="pill ' + cls(o.agreement) + '">' + (ok(o.agreement) ? o.agreement.toFixed(0) + '%' : 'n/d') + '</span></td><td>' + o.n + '</td></tr>';
    });
    $('tbl').innerHTML = h + '</tbody>';
  }

  function renderSources(A) {
    var d = state.sel, t = toDate(state.dates[d]), cons = pick(A.days[d].tmax);
    $('srch').textContent = 'Dettaglio fonti · Tmax ' + fmtWd(t) + ' ' + fmtDm(t);
    var h = '<div class="srchead"><span>Fonte</span><span>Tmax</span><span>Scarto</span></div>';
    state.results.forEach(function (r) {
      var used = state.ids.indexOf(r.src.id) >= 0;
      var x = used ? val(r.src.id, d, 'tmax') : NaN;
      var delta = ok(x) && ok(cons) ? x - cons : NaN;
      var note = r.status === 'ok' ? 'in uso' : r.status === 'stale' ? 'dati salvati (' + esc(r.error || 'offline') + ')' :
        r.status === 'nokey' ? 'serve una chiave API' : 'non disponibile: ' + esc(r.error || 'errore');
      if (used && !ok(x)) note += ' · nessun dato per questo giorno';
      h += '<div class="src' + (used ? '' : ' off') + '"><div class="nm">' + esc(r.src.name) + '<small>' + note + '</small></div>' +
        '<div class="v tmax">' + (ok(x) ? f(x) + '°' : 'n/d') + '</div>' +
        '<div class="v">' + (ok(delta) ? (delta > 0 ? '+' : '') + f(delta) : 'n/d') + '</div></div>';
    });
    $('srcs').innerHTML = h;
  }

  function render() {
    state.ids = state.results.filter(function (r) { return r.rows.length; }).map(function (r) { return r.src.id; });
    var okc = state.results.filter(function (r) { return r.status === 'ok'; }).length;
    var stale = state.results.filter(function (r) { return r.status === 'stale'; }).length;
    if (state.loading) { $('lead').textContent = 'Aggiorno le fonti (' + state.done + ' di ' + SOURCES.length + ')...'; }
    else if (!state.ids.length) { $('lead').textContent = 'Nessuna fonte raggiungibile. Controlla la connessione.'; }
    else {
      var hh = state.last ? new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(state.last) : '';
      $('lead').textContent = 'Consenso tra ' + state.ids.length + ' fonti' + (stale ? ' (' + stale + ' da dati salvati)' : '') + ' · aggiornato alle ' + hh;
    }
    if (!state.ids.length) {
      $('days').innerHTML = ''; $('tbl').innerHTML = '';
      $('chart').innerHTML = '<div class="empty">' + (state.loading ? 'Caricamento...' : 'Nessun dato disponibile.') + '</div>';
      renderSources({ days: [{ tmax: {} }] });
      renderExtras();
      return;
    }
    state.A = aggregate(state.ids);
    renderDays(state.A); renderChart(state.A); renderTable(state.A); renderSources(state.A); renderExtras();
    void okc;
  }


  // ---------- astronomia: luna, sole e maree (calcolati sul telefono, senza internet) ----------
  var RAD = Math.PI / 180, DAYMS = 864e5;
  function toDays(ms) { return ms / DAYMS - 0.5 + 2440588 - 2451545; }
  var OBL = RAD * 23.4397;
  function rightAsc(l, b) { return Math.atan2(Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL), Math.cos(l)); }
  function decl(l, b) { return Math.asin(Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l)); }
  function sunCoords(d) {
    var M = RAD * (357.5291 + 0.98560028 * d);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + C + RAD * 102.9372 + Math.PI;
    return { dec: decl(L, 0), ra: rightAsc(L, 0) };
  }
  function moonCoords(d) {
    var L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
    var l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F);
    return { ra: rightAsc(l, b), dec: decl(l, b), dist: 385001 - 20905 * Math.cos(M) };
  }
  function altOf(ms, c) {
    var d = toDays(ms), H = RAD * (280.16 + 360.9856235 * d) - RAD * (-LON) - c.ra, phi = RAD * LAT;
    var h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
    return h;
  }
  function moonAlt(ms) { var h = altOf(ms, moonCoords(toDays(ms))); return h / RAD; }
  function sunAlt(ms) { var h = altOf(ms, sunCoords(toDays(ms))); return h / RAD; }
  // fase: 0 = nuova, 0.25 = primo quarto, 0.5 = piena, 0.75 = ultimo quarto
  function moonPhase(ms) {
    var d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sd = 149598000;
    var phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    var inc = Math.atan2(sd * Math.sin(phi), m.dist - sd * Math.cos(phi));
    var ang = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    return { frac: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (ang < 0 ? -1 : 1) / Math.PI, dist: m.dist };
  }
  // istanti esatti delle fasi principali (algoritmo di Meeus, termini principali), in millisecondi UTC
  function phaseTime(k, q) {
    var kk = k + q * 0.25, T = kk / 1236.85, d2 = Math.pow(T, 2), d3 = d2 * T, d4 = d3 * T;
    var jde = 2451550.09766 + 29.530588861 * kk + 0.00015437 * d2 - 0.00000015 * d3 + 0.00000000073 * d4;
    var E = 1 - 0.002516 * T - 0.0000074 * d2;
    var M = RAD * (2.5534 + 29.1053567 * kk - 0.0000014 * d2 - 0.00000011 * d3);
    var Mp = RAD * (201.5643 + 385.81693528 * kk + 0.0107582 * d2 + 0.00001238 * d3 - 0.000000058 * d4);
    var F = RAD * (160.7108 + 390.67050284 * kk - 0.0016118 * d2 - 0.00000227 * d3 + 0.000000011 * d4);
    var Om = RAD * (124.7746 - 1.56375588 * kk + 0.0020672 * d2 + 0.00000215 * d3);
    var s = Math.sin, c = 0;
    if (q === 0 || q === 2) {
      var a = q === 0 ? [-0.4072, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208, -0.00111, -0.00057, 0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017]
        : [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209, -0.00111, -0.00057, 0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017];
      c = a[0] * s(Mp) + a[1] * E * s(M) + a[2] * s(2 * Mp) + a[3] * s(2 * F) + a[4] * E * s(Mp - M) + a[5] * E * s(Mp + M) + a[6] * E * E * s(2 * M) +
        a[7] * s(Mp - 2 * F) + a[8] * s(Mp + 2 * F) + a[9] * E * s(2 * Mp + M) + a[10] * s(3 * Mp) + a[11] * E * s(M + 2 * F) + a[12] * E * s(M - 2 * F) +
        a[13] * E * s(2 * Mp - M) + a[14] * s(Om);
    } else {
      c = -0.62801 * s(Mp) + 0.17172 * E * s(M) - 0.01183 * E * s(Mp + M) + 0.00862 * s(2 * Mp) + 0.00804 * s(2 * F) + 0.00454 * E * s(Mp - M) +
        0.00204 * E * E * s(2 * M) - 0.0018 * s(Mp - 2 * F) - 0.0007 * s(Mp + 2 * F) - 0.0004 * s(3 * Mp) - 0.00034 * E * s(2 * Mp - M) +
        0.00032 * E * s(M + 2 * F) + 0.00032 * E * s(M - 2 * F) - 0.00028 * E * E * s(Mp + 2 * M) + 0.00027 * E * s(2 * Mp + M) - 0.00017 * s(Om);
      var W = 0.00306 - 0.00038 * E * Math.cos(M) + 0.00026 * Math.cos(Mp) - 0.00002 * Math.cos(Mp - M) + 0.00002 * Math.cos(Mp + M) + 0.00002 * Math.cos(2 * F);
      c += q === 1 ? W : -W;
    }
    return (jde + c - 69 / 86400 - 2440587.5) * DAYMS;
  }
  // fasi principali tra due momenti (q: 0 nuova, 1 primo quarto, 2 piena, 3 ultimo quarto)
  function phaseEvents(fromMs, toMs) {
    var k0 = Math.floor((fromMs / DAYMS / 365.25 + 1970 - 2000) * 12.3685) - 2, out = [], k, q;
    for (k = k0; k < k0 + 8 + Math.ceil((toMs - fromMs) / DAYMS / 29.5); k++) {
      for (q = 0; q < 4; q++) { var t = phaseTime(k, q); if (t >= fromMs && t < toMs) out.push({ t: t, q: q }); }
    }
    return out.sort(function (a, b) { return a.t - b.t; });
  }
  var PHASE_NAMES = ['Luna nuova', 'Primo quarto', 'Luna piena', 'Ultimo quarto'];

  // ---------- giorno locale (ora di Roma) ----------
  function localParts(ms) {
    var p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)), o = {};
    p.forEach(function (x) { o[x.type] = x.value; });
    return { date: o.year + '-' + o.month + '-' + o.day, h: Number(o.hour), mi: Number(o.minute) };
  }
  // millisecondi dell'istante "date hh:mm" ora di Roma
  function localMs(date, hh_, mi) {
    var p = date.split('-').map(Number), base = Date.UTC(p[0], p[1] - 1, p[2], hh_, mi || 0), off;
    for (off = 3; off >= 0; off--) {
      var c = base - off * 3600e3, q = localParts(c);
      if (q.date === date && q.h === hh_ && q.mi === (mi || 0)) return c;
    }
    return base - 2 * 3600e3;
  }
  function nextDate(date) {
    var p = date.split('-').map(Number);
    return dayFmt.format(new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1, 12)));
  }
  function clock(ms) { var q = localParts(ms); return (q.h < 10 ? '0' : '') + q.h + ':' + (q.mi < 10 ? '0' : '') + q.mi; }

  // sorge, culmina e tramonta nell'arco del giorno locale
  function moonDay(date) {
    var t0 = localMs(date, 0, 0), t1 = localMs(nextDate(date), 0, 0), hc = 0.133, step = 600e3, t, prev = moonAlt(t0) - hc, rise = null, set = null, best = -90, bt = t0;
    for (t = t0 + step; t <= t1; t += step) {
      var a = moonAlt(t), cur = a - hc;
      if (prev < 0 && cur >= 0 && rise === null) rise = cross(t - step, t, hc);
      if (prev >= 0 && cur < 0 && set === null) set = cross(t - step, t, hc);
      if (a > best) { best = a; bt = t; }
      prev = cur;
    }
    return { rise: rise, set: set, max: best, maxT: bt, t0: t0, t1: t1 };
  }
  function cross(a, b, hc) {
    var up = moonAlt(b) - hc >= 0, i;
    for (i = 0; i < 20; i++) {
      var m = (a + b) / 2, v = moonAlt(m) - hc >= 0;
      if (v === up) b = m; else a = m;
    }
    return (a + b) / 2;
  }

  // ---------- marea astronomica, Laguna di Venezia (Punta della Salute) ----------
  // Costanti armoniche del Centro Previsioni e Segnalazioni Maree di Venezia (ampiezza cm, fase gradi, velocità gradi/ora).
  var TIDE_C = {
    M2: [23.6, 310, 28.9841042], S2: [13.7, 319, 30.0], N2: [3.8, 309, 28.4397295], K2: [4.1, 313, 30.0821373],
    K1: [17.3, 87, 15.0410686], O1: [5.2, 78, 13.9430356], P1: [5.5, 85, 14.9589314]
  };
  var TIDE_SHIFT = -0.85;   // ore: allineamento verificato su tabelle di marea pubblicate (errore tipico 5-15 minuti)
  var TIDE_ZMPS = 31;       // livello medio del mare sopra lo zero di Punta Salute (cm)
  function tideCm(ms) {
    var T = (ms / DAYMS + 2440587.5 - 2451545) / 36525;
    var s = (218.3165 + 481267.8813 * T) % 360, h = (280.4661 + 36000.7698 * T) % 360, p = (83.3535 + 4069.0137 * T) % 360, N = (125.0445 - 1934.1363 * T) % 360;
    var tu = (ms / 3600e3) % 24, Tm = 15 * (tu - 12), cN = Math.cos(RAD * N), sN = Math.sin(RAD * N);
    var V = { M2: 2 * Tm - 2 * s + 2 * h, S2: 2 * Tm, N2: 2 * Tm - 3 * s + 2 * h + p, K2: 2 * Tm + 2 * h, K1: Tm + h - 90, O1: Tm - 2 * s + h + 90, P1: Tm - h + 90 };
    var F = { M2: 1 - 0.037 * cN, N2: 1 - 0.037 * cN, K2: 1.024 + 0.286 * cN, K1: 1.006 + 0.115 * cN, O1: 1.009 + 0.187 * cN, S2: 1, P1: 1 };
    var U = { M2: -2.14 * sN, N2: -2.14 * sN, K2: -17.74 * sN, K1: -8.86 * sN, O1: 10.80 * sN, S2: 0, P1: 0 };
    var tot = 0, k;
    for (k in TIDE_C) tot += F[k] * TIDE_C[k][0] * Math.cos(RAD * (V[k] + U[k] - TIDE_C[k][1] - TIDE_SHIFT * TIDE_C[k][2]));
    return tot + TIDE_ZMPS;
  }
  // alte e basse maree nell'arco del giorno locale
  function tideDay(date) {
    var t0 = localMs(date, 0, 0), t1 = localMs(nextDate(date), 0, 0), step = 300e3, ts = [], ys = [], t, i, ex = [];
    for (t = t0 - step; t <= t1 + step; t += step) { ts.push(t); ys.push(tideCm(t)); }
    for (i = 1; i < ys.length - 1; i++) {
      var isH = ys[i] > ys[i - 1] && ys[i] >= ys[i + 1], isL = ys[i] < ys[i - 1] && ys[i] <= ys[i + 1];
      if (!isH && !isL) continue;
      var den = ys[i - 1] - 2 * ys[i] + ys[i + 1], dx = den ? 0.5 * (ys[i - 1] - ys[i + 1]) / den : 0;
      var tt = ts[i] + dx * step, yy = ys[i] - 0.25 * (ys[i - 1] - ys[i + 1]) * dx;
      if (tt >= t0 && tt < t1) ex.push({ t: tt, y: yy, hi: isH });
    }
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < ys.length; i++) { if (ts[i] >= t0 && ts[i] <= t1) { if (ys[i] < lo) lo = ys[i]; if (ys[i] > hi) hi = ys[i]; } }
    var cl = [];
    ex.forEach(function (e) { var l = cl[cl.length - 1]; if (l && l.hi === e.hi && Math.abs(l.t - e.t) < 3 * 3600e3) { if ((e.hi && e.y > l.y) || (!e.hi && e.y < l.y)) cl[cl.length - 1] = e; } else cl.push(e); });
    for (i = 0; i < cl.length - 1; i++) {
      // scarta piccole oscillazioni (alta e bassa quasi uguali, ravvicinate) quando la marea è quasi piatta
      if (cl[i].hi !== cl[i + 1].hi && Math.abs(cl[i].y - cl[i + 1].y) < 4) { cl.splice(i, 2); i = Math.max(-1, i - 2); }
    }
    return { t0: t0, t1: t1, ex: cl, lo: lo, hi: hi };
  }

  // ---------- luna ----------
  function moonSvg(p, size) {
    var pp = p < 0.5 ? p : 1 - p, rx = Math.abs(Math.cos(2 * Math.PI * pp)) * 18;
    var lit = 'M20 2A18 18 0 0 1 20 38A' + rx.toFixed(2) + ' 18 0 0 ' + (pp < 0.25 ? 0 : 1) + ' 20 2z';
    return '<svg viewBox="0 0 40 40" width="' + size + '" height="' + size + '" role="img" aria-label="Fase lunare" style="width:' + size + 'px;height:' + size + 'px">' +
      '<circle cx="20" cy="20" r="18" fill="var(--moon-dark)" stroke="var(--cloud)" stroke-width="1"/>' +
      '<path d="' + lit + '" fill="var(--moon-lit)"' + (p >= 0.5 ? ' transform="translate(40 0) scale(-1 1)"' : '') + '/></svg>';
  }
  function moonOf(date) {
    var ref = localMs(date, 21, 0), ph = moonPhase(ref), t0 = localMs(date, 0, 0), t1 = localMs(nextDate(date), 0, 0);
    var evs = phaseEvents(t0, t1), ev = evs.length ? evs[0] : null, p = ph.phase;
    var name = ev ? PHASE_NAMES[ev.q] : p < 0.25 ? 'Falce crescente' : p < 0.5 ? 'Gibbosa crescente' : p < 0.75 ? 'Gibbosa calante' : 'Falce calante';
    var news = phaseEvents(ref - 31 * DAYMS, ref).filter(function (e) { return e.q === 0; });
    return { ref: ref, p: p, frac: ph.frac, dist: ph.dist, ev: ev, name: name, age: news.length ? (ref - news[news.length - 1].t) / DAYMS : p * 29.53 };
  }
  function distLabel(km) { return km < 362000 ? 'vicina (perigeo)' : km > 404000 ? 'lontana (apogeo)' : 'media'; }
  function thousands(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function moonVisibility(date) {
    if (!state.sky || !state.sky.length) return null;
    var tm = sunTimes(date), cs = [], n = 0, hr;
    for (hr = 0; hr < 24; hr++) {
      var mid = localMs(date, hr, 30);
      if (moonAlt(mid) > 5 && sunAlt(mid) < -6) { n++; var e = skyHour(date, hr, tm); if (ok(e.c)) cs.push(e.c); }
    }
    return { hrs: n, cloud: cs.length ? MEAN(cs) : NaN };
  }
  function renderMoonChart(md, isToday) {
    var W = 420, H = 210, L = 34, R = 14, T = 22, B = 26, span = md.t1 - md.t0, step = 600e3, t, k, s;
    var hiA = Math.max(30, Math.ceil((md.max + 5) / 30) * 30), loA = -30;
    function X(tt) { return L + (W - L - R) * (tt - md.t0) / span; }
    function Y(a) { return T + (H - T - B) * (1 - (a - loA) / (hiA - loA)); }
    var pts = [], nights = [], cur = null;
    for (t = md.t0; t <= md.t1; t += step) {
      pts.push([X(t), Y(moonAlt(t))]);
      if (sunAlt(t) < -0.833) { if (!cur) { cur = { a: t, b: t }; nights.push(cur); } cur.b = t; } else cur = null;
    }
    s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Altezza della Luna sull\'orizzonte">';
    nights.forEach(function (n) { s += '<rect x="' + X(n.a) + '" y="' + T + '" width="' + Math.max(1, X(n.b) - X(n.a)) + '" height="' + (H - T - B) + '" fill="var(--night)" fill-opacity="0.35"/>'; });
    for (k = loA; k <= hiA; k += 30) {
      s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(k) + '" y2="' + Y(k) + '"' + (k === 0 ? ' style="stroke:var(--muted)"' : '') + '/><text class="ax" x="' + (L - 6) + '" y="' + (Y(k) + 4) + '" text-anchor="end">' + k + '°</text>';
    }
    s += '<clipPath id="mclip"><rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (Y(0) - T) + '"/></clipPath>';
    s += '<polygon clip-path="url(#mclip)" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + ' ' + X(md.t1) + ',' + Y(loA) + ' ' + X(md.t0) + ',' + Y(loA) + '" fill="var(--moon-lit)" fill-opacity="0.45"/>';
    s += '<clipPath id="mclip2"><rect x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '"/></clipPath>';
    s += '<polyline clip-path="url(#mclip2)" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '" fill="none" stroke="var(--cloud)" stroke-width="2.2" stroke-linejoin="round"/>';
    if (isToday) {
      var nw = Date.now();
      if (nw >= md.t0 && nw <= md.t1) s += '<line x1="' + X(nw) + '" x2="' + X(nw) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-dasharray="3 3"/><text class="ax" x="' + X(nw) + '" y="' + (T - 8) + '" text-anchor="middle">ora</text>' +
        '<circle cx="' + X(nw) + '" cy="' + Y(moonAlt(nw)) + '" r="4.5" fill="var(--moon-lit)" stroke="var(--cloud)" stroke-width="2"/>';
    }
    function tag(tt, txt, up) {
      var x = X(tt), a = x < 60 ? 'start' : x > W - 60 ? 'end' : 'middle';
      return '<circle cx="' + x + '" cy="' + Y(moonAlt(tt)) + '" r="3.5" fill="var(--cloud)" stroke="var(--surface)" stroke-width="1.5"/><text x="' + x + '" y="' + (Y(moonAlt(tt)) + (up ? -8 : 15)) + '" text-anchor="' + a + '" font-size="11" font-family="var(--f-mono)" fill="var(--ink)">' + txt + '</text>';
    }
    if (md.rise) s += tag(md.rise, 'sorge ' + clock(md.rise), false);
    if (md.set) s += tag(md.set, 'tramonta ' + clock(md.set), false);
    if (md.max > 0) s += tag(md.maxT, Math.round(md.max) + '°', true);
    for (k = 0; k < 24; k += 3) s += '<text class="ax" x="' + X(md.t0 + k * 3600e3) + '" y="' + (H - 8) + '" text-anchor="middle">' + k + '</text>';
    return s + '</svg>';
  }

  function renderMoon() {
    var i, strip = '', mo = [];
    for (i = 0; i < NDAYS; i++) {
      var m = moonOf(state.dates[i]), t = toDate(state.dates[i]);
      mo.push(m);
      strip += '<button type="button" class="day mday" data-d="' + i + '" aria-pressed="' + (i === state.sel) + '"><span class="dn">' + fmtWd(t) + '</span><span class="dd">' + fmtDm(t) + '</span>' +
        '<span class="mi">' + moonSvg(m.p, 40) + '</span><span class="rr">' + Math.round(m.frac * 100) + '%</span><span class="mn">' + m.name + '</span></button>';
    }
    $('moonstrip').innerHTML = strip;
    var date = state.dates[state.sel], m2 = mo[state.sel], md = moonDay(date), h = '';
    var evp = m2.ev ? '<span class="pill ' + (m2.ev.q % 2 ? 'sunp' : 'cloudp') + '">' + PHASE_NAMES[m2.ev.q] + ' alle ' + clock(m2.ev.t) + '</span>' : '';
    var dl = distLabel(m2.dist);
    var super_ = (m2.ev && (m2.ev.q === 0 || m2.ev.q === 2) && m2.dist < 362000) ? '<span class="pill warn">' + (m2.ev.q === 2 ? 'Superluna' : 'Luna nuova vicina') + '</span>' : '';
    h += '<div class="mhero"><div class="mic">' + moonSvg(m2.p, 76) + '</div><div class="mtx"><div class="mname">' + m2.name + '</div>' +
      '<div class="msub">Illuminata al ' + Math.round(m2.frac * 100) + '% · età ' + f(m2.age, 1) + ' giorni</div><div class="msub">Aspetto alle 21:00</div><div class="rp" style="margin-top:6px">' + evp + super_ + '</div></div></div>';
    function r(a, b) { return '<div class="pl two"><span>' + a + '</span><span class="vv">' + b + '</span></div>'; }
    h += r('Sorge', md.rise ? clock(md.rise) : 'non in questo giorno');
    h += r('Culmina', md.max > 0 ? clock(md.maxT) + ' · ' + Math.round(md.max) + '° di altezza' : 'sempre sotto l\'orizzonte');
    h += r('Tramonta', md.set ? clock(md.set) : 'non in questo giorno');
    h += r('Distanza', thousands(m2.dist) + ' km · ' + dl);
    var vis = moonVisibility(date), vt;
    if (!vis) vt = 'n/d'; else if (!vis.hrs) vt = 'non visibile di notte'; else vt = vis.hrs + (vis.hrs === 1 ? ' ora' : ' ore') + ' di buio' + (ok(vis.cloud) ? ' · nuvolosità ' + f(vis.cloud, 0) + '%' + (vis.cloud < 30 ? ' (cielo buono)' : vis.cloud < 60 ? ' (parziale)' : ' (poco visibile)') : '');
    h += r('Visibilità di notte', vt);
    $('moonnow').innerHTML = h;
    var ts = toDate(date);
    $('moonchart').innerHTML = '<p class="sub">Altezza della Luna · ' + fmtWd(ts) + ' ' + fmtDm(ts) + '</p>' + renderMoonChart(md, state.sel === 0);
    var nx = phaseEvents(Date.now(), Date.now() + 40 * DAYMS).slice(0, 4), ph = '<p class="sub">Prossime fasi</p>';
    nx.forEach(function (e) {
      var q = localParts(e.t), td = toDate(q.date);
      ph += '<div class="pl two"><span class="phn">' + moonSvg(e.q * 0.25, 22) + PHASE_NAMES[e.q] + '</span><span class="vv">' + fmtWd(td) + ' ' + fmtDm(td) + ' · ' + clock(e.t) + '</span></div>';
    });
    $('moonnext').innerHTML = ph;
  }

  // ---------- maree ----------
  function renderTideChart(td, isToday) {
    var W = 420, H = 230, L = 40, R = 14, T = 28, B = 26, span = td.t1 - td.t0, step = 600e3, t, k, s;
    var lo = Math.floor((td.lo - 15) / 20) * 20, hi = Math.ceil((td.hi + 15) / 20) * 20;
    function X(tt) { return L + (W - L - R) * (tt - td.t0) / span; }
    function Y(v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); }
    var pts = [];
    for (t = td.t0; t <= td.t1; t += step) pts.push(X(t).toFixed(1) + ',' + Y(tideCm(t)).toFixed(1));
    s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Livello di marea durante il giorno">';
    for (k = lo; k <= hi; k += 20) {
      s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(k) + '" y2="' + Y(k) + '"' + (k === 0 ? ' style="stroke:var(--muted)"' : '') + '/><text class="ax" x="' + (L - 6) + '" y="' + (Y(k) + 4) + '" text-anchor="end">' + (k > 0 ? '+' : '') + k + '</text>';
    }
    s += '<text class="ax" x="' + L + '" y="' + (T - 16) + '">cm</text>';
    s += '<polygon points="' + pts.join(' ') + ' ' + X(td.t1) + ',' + Y(lo) + ' ' + X(td.t0) + ',' + Y(lo) + '" fill="var(--rain)" fill-opacity="0.2"/>';
    s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--rain)" stroke-width="2.4" stroke-linejoin="round"/>';
    if (isToday) {
      var nw = Date.now();
      if (nw >= td.t0 && nw <= td.t1) s += '<line x1="' + X(nw) + '" x2="' + X(nw) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-dasharray="3 3"/><text class="ax" x="' + X(nw) + '" y="' + (T - 16) + '" text-anchor="middle">ora</text>' +
        '<circle cx="' + X(nw) + '" cy="' + Y(tideCm(nw)) + '" r="4.5" fill="var(--rain)" stroke="var(--surface)" stroke-width="2"/>';
    }
    td.ex.forEach(function (e) {
      var x = X(e.t), a = x < 70 ? 'start' : x > W - 70 ? 'end' : 'middle', y = Y(e.y);
      s += '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + (e.hi ? 'var(--tmax)' : 'var(--tmin)') + '" stroke="var(--surface)" stroke-width="2"/>' +
        '<text x="' + x + '" y="' + (e.hi ? y - 9 : y + 17) + '" text-anchor="' + a + '" font-size="11" font-weight="600" font-family="var(--f-mono)" fill="var(--ink)">' + clock(e.t) + ' ' + (e.y > 0 ? '+' : '') + Math.round(e.y) + '</text>';
    });
    for (k = 0; k < 24; k += 3) s += '<text class="ax" x="' + X(td.t0 + k * 3600e3) + '" y="' + (H - 8) + '" text-anchor="middle">' + k + '</text>';
    return s + '</svg>';
  }

  function renderTide() {
    var i, html = '', tds = [];
    for (i = 0; i < NDAYS; i++) {
      var td = tideDay(state.dates[i]), t = toDate(state.dates[i]), parts = '', range = td.hi - td.lo;
      tds.push(td);
      td.ex.forEach(function (e) {
        parts += '<span class="pill ' + (e.hi ? 'tmaxp' : 'tminp') + '">' + (e.hi ? '▲ ' : '▼ ') + clock(e.t) + ' ' + (e.y > 0 ? '+' : '') + Math.round(e.y) + '</span>';
      });
      if (range >= 85) parts += '<span class="pill warn">Maree vive</span>';
      else if (range <= 60) parts += '<span class="pill off">Maree morte</span>';
      html += '<div class="rl' + (i === state.sel ? ' sel' : '') + '" data-d="' + i + '"><div class="rd"><b>' + fmtWd(t) + '</b> ' + fmtDm(t) + '</div><div class="rp">' + parts + '</div></div>';
    }
    $('tidelist').innerHTML = html;
    var now = Date.now(), sum = '';
    if (state.sel === 0) {
      var cur = tideCm(now), up = tideCm(now + 600e3) > cur;
      var nxt = tds[0].ex.concat(tideDay(nextDate(state.dates[0])).ex).filter(function (e) { return e.t > now; })[0];
      sum = '<p class="adv"><b>Adesso ' + (cur > 0 ? '+' : '') + Math.round(cur) + ' cm</b>, marea in ' + (up ? 'salita' : 'discesa') +
        (nxt ? ' · prossima ' + (nxt.hi ? 'alta' : 'bassa') + ' alle ' + clock(nxt.t) + ' (' + (nxt.y > 0 ? '+' : '') + Math.round(nxt.y) + ' cm)' : '') + '</p>';
    }
    var ts = toDate(state.dates[state.sel]);
    $('tidechart').innerHTML = sum + '<p class="sub">Livello ora per ora · ' + fmtWd(ts) + ' ' + fmtDm(ts) + '</p>' + renderTideChart(tds[state.sel], state.sel === 0);
  }

  // ---------- temperature ora per ora ----------
  function tempDay(i) {
    var out = [], hr, nh = i === 0 ? nowHour() : 0;
    for (hr = 0; hr < 24; hr++) { var c = hourCons(state.dates[i], hr); c.hr = hr; c.past = hr < nh; out.push(c); }
    return out;
  }

  function renderTempChart(hs, i) {
    var W = 420, H = 230, L = 34, R = 14, T = 24, B = 26, bw = (W - L - R) / 24, k, s, mn = Infinity, mx = -Infinity;
    hs.forEach(function (h) {
      if (ok(h.tlo)) mn = Math.min(mn, h.tlo);
      if (ok(h.thi)) mx = Math.max(mx, h.thi);
    });
    if (!isFinite(mn)) return '';
    var step = (mx - mn) <= 10 ? 2 : (mx - mn) <= 20 ? 5 : 10;
    var lo = Math.floor(mn / step) * step, hi = Math.ceil(mx / step) * step;
    if (hi === lo) hi += step;
    function Y(v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); }
    function X(h) { return L + (h + 0.5) * bw; }
    s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Temperatura ora per ora">';
    for (k = lo; k <= hi + 1e-9; k += step) {
      s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(k) + '" y2="' + Y(k) + '"/>' +
        '<text class="ax" x="' + (L - 6) + '" y="' + (Y(k) + 4) + '" text-anchor="end">' + k + '°</text>';
    }
    // fascia tra il valore minimo e massimo dei modelli
    var up = [], dn = [], line = [], pts = [];
    hs.forEach(function (h) {
      if (!ok(h.t)) return;
      up.push(X(h.hr) + ',' + Y(h.thi)); dn.unshift(X(h.hr) + ',' + Y(h.tlo)); line.push(X(h.hr) + ',' + Y(h.t)); pts.push(h);
    });
    if (line.length < 2) return '';
    s += '<polygon points="' + up.join(' ') + ' ' + dn.join(' ') + '" fill="var(--tmax)" fill-opacity="0.16"/>';
    s += '<polyline points="' + line.join(' ') + '" fill="none" stroke="var(--tmax)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
    // ora attuale
    if (i === 0) {
      var nh = nowHour();
      s += '<line x1="' + X(nh) + '" x2="' + X(nh) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text class="ax" x="' + X(nh) + '" y="' + (T - 8) + '" text-anchor="middle">ora</text>';
    }
    // massimo e minimo del giorno
    var pmax = pts[0], pmin = pts[0];
    pts.forEach(function (h) { if (h.t > pmax.t) pmax = h; if (h.t < pmin.t) pmin = h; });
    function mark(h, col, above) {
      var x = Math.max(L + 12, Math.min(W - R - 12, X(h.hr)));
      return '<circle cx="' + X(h.hr) + '" cy="' + Y(h.t) + '" r="4" fill="' + col + '" stroke="var(--surface)" stroke-width="2"/>' +
        '<text x="' + x + '" y="' + (Y(h.t) + (above ? -9 : 17)) + '" text-anchor="middle" font-size="12" font-weight="600" font-family="var(--f-mono)" fill="' + col + '">' + Math.round(h.t) + '°</text>';
    }
    s += mark(pmax, 'var(--tmax)', true);
    if (pmin.hr !== pmax.hr) s += mark(pmin, 'var(--tmin)', false);
    for (k = 0; k < 24; k += 3) s += '<text class="ax" x="' + X(k) + '" y="' + (H - 8) + '" text-anchor="middle">' + k + '</text>';
    return s + '</svg>';
  }

  function renderTemp() {
    var list = $('templist'), strip = $('tempstrip'), chart = $('tempchart');
    if (!state.hourly || !state.hourly.length) {
      list.innerHTML = '<div class="empty">' + (!state.hourlyDone ? 'Carico le temperature...' : 'Temperature orarie non disponibili. Premi Aggiorna per riprovare.') + '</div>';
      strip.innerHTML = ''; chart.innerHTML = '';
      return;
    }
    var html = '', i, selHours = null;
    for (i = 0; i < NDAYS; i++) {
      var hs = tempDay(i), t = toDate(state.dates[i]), parts = '';
      if (i === state.sel) selHours = hs;
      var vs = hs.filter(function (h) { return ok(h.t); });
      if (vs.length) {
        var a = vs[0], b = vs[0];
        vs.forEach(function (h) { if (h.t > b.t) b = h; if (h.t < a.t) a = h; });
        parts = '<span class="pill tminp">Min ' + Math.round(a.t) + '° alle ' + hh(a.hr) + '</span>' +
          '<span class="pill tmaxp">Max ' + Math.round(b.t) + '° alle ' + hh(b.hr) + '</span>';
      } else parts = '<span class="pill off">n/d</span>';
      html += '<div class="rl' + (i === state.sel ? ' sel' : '') + '" data-d="' + i + '"><div class="rd"><b>' + fmtWd(t) + '</b> ' + fmtDm(t) + '</div><div class="rp">' + parts + '</div></div>';
    }
    list.innerHTML = html;
    var date = state.dates[state.sel], tm = sunTimes(date), cells = '', nh = state.sel === 0 ? nowHour() : -1;
    selHours.forEach(function (h) {
      var k = '';
      try { k = hourKind(date, h.hr, h, tm); } catch (e) { k = ''; }
      cells += '<div class="hc' + (h.past ? ' past' : '') + (h.hr === nh ? ' now' : '') + '"><span class="hr">' + (h.hr < 10 ? '0' : '') + h.hr + '</span>' +
        '<span class="hi">' + (k ? icon(k, 26) : '') + '</span><span class="ht">' + (ok(h.t) ? Math.round(h.t) + '°' : 'n/d') + '</span></div>';
    });
    strip.innerHTML = cells;
    var ts = toDate(date);
    chart.innerHTML = '<p class="sub">Ora per ora · ' + fmtWd(ts) + ' ' + fmtDm(ts) + '</p>' + renderTempChart(selHours, state.sel);
    if (nh >= 0) { var el = strip.children[Math.max(0, nh - 1)]; if (el) strip.scrollLeft = el.offsetLeft - strip.offsetLeft; }
  }

  // ---------- orari di pioggia, temporale e grandine ----------
  var HMODELS = [
    { id: 'ecmwf', model: 'ecmwf_ifs025' },
    { id: 'icon', model: 'icon_seamless' },
    { id: 'gfs', model: 'gfs_seamless' },
    { id: 'arpege', model: 'meteofrance_seamless' }
  ];

  function openMeteoHourly(model) {
    var q = 'latitude=' + LAT + '&longitude=' + LON + '&hourly=precipitation,precipitation_probability,weather_code,cape,temperature_2m' +
      '&models=' + model + '&timezone=Europe%2FRome&forecast_days=' + NDAYS;
    return getJson('https://api.open-meteo.com/v1/forecast?' + q).then(function (j) {
      var h = j.hourly, out = {}, i, n = h.time.length;
      for (i = 0; i < n; i++) {
        var d = h.time[i].slice(0, 10), hr = Number(h.time[i].slice(11, 13));
        if (!out[d]) out[d] = [];
        // Pioggia e probabilità all'ora H sono riferite all'ora precedente: il valore a H+1 vale per l'ora H.
        var k = i + 1;
        out[d][hr] = {
          mm: k < n ? num(h.precipitation && h.precipitation[k]) : NaN,
          pr: k < n ? num(h.precipitation_probability && h.precipitation_probability[k]) : NaN,
          code: num(h.weather_code && h.weather_code[i]),
          cape: num(h.cape && h.cape[i]),
          t: num(h.temperature_2m && h.temperature_2m[i])
        };
      }
      return out;
    });
  }

  function loadHourly(m, force) {
    var key = 'meteo.h4.' + m.id, c = null, now = Date.now();
    try { c = JSON.parse(lsGet(key) || 'null'); } catch (e) { c = null; }
    if (c && !force && now - c.t < TTL) return Promise.resolve({ id: m.id, data: c.data });
    return openMeteoHourly(m.model).then(function (data) {
      lsSet(key, JSON.stringify({ t: now, data: data }));
      return { id: m.id, data: data };
    }).catch(function () {
      return c ? { id: m.id, data: c.data, stale: true } : { id: m.id, data: null };
    });
  }

  function loadAllHourly(force) {
    return Promise.all(HMODELS.map(function (m) { return loadHourly(m, force); })).then(function (r) {
      return r.filter(function (x) { return x.data; });
    });
  }

  function nowHour() {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: TZ }).format(new Date()));
  }

  var SNOWC = [71, 73, 75, 77, 85, 86];

  function hourCons(date, hr) {
    var mms = [], prs = [], wetN = 0, n = 0, storm = 0, hail = 0, cape = NaN, ts = [], snow = 0, nm = 0, ccs = [];
    state.hourly.forEach(function (m) {
      var day = m.data && m.data[date], e = day && day[hr];
      if (!e) return;
      var mm = num(e.mm), pr = num(e.pr), code = num(e.code), cp = num(e.cape);
      if (ok(mm)) { mms.push(mm); n++; if (mm >= 0.1) wetN++; }
      if (ok(pr)) prs.push(pr);
      if (code === 95 || code === 96 || code === 99) storm++;
      if (code === 96 || code === 99) hail++;
      if (ok(code)) {
        nm++;
        if (SNOWC.indexOf(code) >= 0) snow++;
        ccs.push(code === 0 ? 5 : code === 1 ? 20 : code === 2 ? 50 : 90);
      }
      if (ok(num(e.t))) ts.push(num(e.t));
      if (ok(cp) && (!ok(cape) || cp > cape)) cape = cp;
    });
    var mm2 = mms.length ? MEAN(mms) : NaN;
    var pr2 = prs.length ? MEAN(prs) : (n ? 100 * wetN / n : NaN);
    return {
      mm: mm2, pr: pr2, wet: n > 0 && (mm2 >= 0.2 || wetN / n >= 0.5), storm: storm, hail: hail, cape: cape, n: n,
      snow: snow, nm: nm, cc: ccs.length ? MEAN(ccs) : NaN,
      t: ts.length ? MEAN(ts) : NaN, tlo: ts.length ? MIN(ts) : NaN, thi: ts.length ? MAX(ts) : NaN
    };
  }

  function dayHours(i) {
    var out = [], hr, nh = i === 0 ? nowHour() : 0;
    for (hr = 0; hr < 24; hr++) {
      var c = hourCons(state.dates[i], hr);
      c.past = hr < nh;
      out.push(c);
    }
    return out;
  }

  function windows(hours, test, key) {
    var ws = [], cur = null;
    hours.forEach(function (h, i) {
      if (h.past || !test(h)) return;
      if (cur && i - cur.last <= 2) { cur.last = i; cur.idx.push(i); }
      else { cur = { first: i, last: i, idx: [i] }; ws.push(cur); }
    });
    return ws.map(function (x) {
      var hs = x.idx.map(function (i) { return hours[i]; });
      return {
        from: x.first, to: x.last + 1,
        pr: red(hs.map(function (h) { return h.pr; }), MAX),
        mm: red(hs.map(function (h) { return h.mm; }), SUM),
        n: key ? MAX(hs.map(function (h) { return h[key]; })) : 0
      };
    });
  }

  function hh(h) { return (h < 10 ? '0' : '') + h + ':00'; }

  function renderRainChart(hs) {
    var W = 420, H = 210, L = 34, R = 38, T = 30, B = 26, bw = (W - L - R) / 24, i, s;
    var mx = 2;
    hs.forEach(function (h) { if (ok(h.mm) && h.mm > mx) mx = h.mm; });
    mx = Math.ceil(mx);
    function Y(mm) { return T + (H - T - B) * (1 - mm / mx); }
    function YP(p) { return T + (H - T - B) * (1 - p / 100); }
    s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Pioggia ora per ora">';
    [0, 0.5, 1].forEach(function (k) {
      var y = T + (H - T - B) * (1 - k);
      s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/>' +
        '<text class="ax" x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + (mx * k).toFixed(k === 0.5 && mx % 2 ? 1 : 0).replace('.', ',') + '</text>' +
        '<text class="ax" x="' + (W - R + 6) + '" y="' + (y + 4) + '">' + (k * 100) + '%</text>';
    });
    s += '<text class="ax" x="' + L + '" y="' + (T - 18) + '">mm</text>';
    var pts = [];
    for (i = 0; i < 24; i++) {
      var h = hs[i], x = L + i * bw, op = h.past ? 0.3 : 1;
      if (ok(h.mm) && h.mm > 0) {
        s += '<rect x="' + (x + 2) + '" y="' + Y(h.mm) + '" width="' + (bw - 4) + '" height="' + Math.max(1.5, Y(0) - Y(h.mm)) + '" rx="2" fill="var(--rain)" fill-opacity="' + (0.85 * op) + '"/>';
      }
      if (h.storm > 0) s += '<rect x="' + (x + 2) + '" y="' + (T - 14) + '" width="' + (bw - 4) + '" height="8" rx="2" fill="var(--warn)" fill-opacity="' + op + '"/>';
      if (h.hail > 0) s += '<circle cx="' + (x + bw / 2) + '" cy="' + (T - 10) + '" r="5" fill="var(--bad)" stroke="var(--surface)" stroke-width="2"/>';
      if (ok(h.pr)) pts.push((x + bw / 2) + ',' + YP(h.pr));
      if (i % 3 === 0) s += '<text class="ax" x="' + (x + bw / 2) + '" y="' + (H - 10) + '" text-anchor="middle">' + i + '</text>';
    }
    if (pts.length) s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>';
    chart_set(s + '</svg>');
  }
  function chart_set(svg) { $('rainchart').innerHTML = svg; }

  function renderRain() {
    var list = $('rainlist'), chart = $('rainchart');
    if (!state.hourly || !state.hourly.length) {
      list.innerHTML = '<div class="empty">' + (!state.hourlyDone ? 'Carico gli orari...' : 'Orari non disponibili. Premi Aggiorna per riprovare.') + '</div>';
      chart.innerHTML = '';
      return;
    }
    var N = state.hourly.length, html = '', selHours = null, i;
    for (i = 0; i < NDAYS; i++) {
      var hs = dayHours(i), t = toDate(state.dates[i]), parts = '';
      if (i === state.sel) selHours = hs;
      var wet = windows(hs, function (x) { return x.wet; });
      var st = windows(hs, function (x) { return x.storm > 0; }, 'storm');
      var ha = windows(hs, function (x) { return x.hail > 0; }, 'hail');
      if (!wet.length && !st.length) parts = '<span class="pill ok">Nessuna pioggia prevista</span>';
      wet.forEach(function (w) { parts += '<span class="pill rainp">Pioggia ' + hh(w.from) + '–' + hh(w.to) + ' · fino a ' + f(w.pr, 0) + '% · ' + f(w.mm) + ' mm</span>'; });
      st.forEach(function (w) { parts += '<span class="pill warn">Temporale ' + hh(w.from) + '–' + hh(w.to) + ' · ' + w.n + (w.n === 1 ? ' modello' : ' modelli') + ' su ' + N + '</span>'; });
      ha.forEach(function (w) { parts += '<span class="pill bad">Grandine possibile ' + hh(w.from) + '–' + hh(w.to) + ' · ' + w.n + (w.n === 1 ? ' modello' : ' modelli') + ' su ' + N + '</span>'; });
      html += '<div class="rl' + (i === state.sel ? ' sel' : '') + '" data-d="' + i + '"><div class="rd"><b>' + fmtWd(t) + '</b> ' + fmtDm(t) + '</div><div class="rp">' + parts + '</div></div>';
    }
    list.innerHTML = html;
    var ts = toDate(state.dates[state.sel]);
    renderRainChart(selHours);
    chart.insertAdjacentHTML('afterbegin', '<p class="sub">Ora per ora · ' + fmtWd(ts) + ' ' + fmtDm(ts) + '</p>');
  }

  // ---------- caricamento con cache (nuvolosità, sole, aria) ----------
  function loadCached(key, fn, force) {
    var c = null, now = Date.now();
    try { c = JSON.parse(lsGet(key) || 'null'); } catch (e) { c = null; }
    if (c && !force && now - c.t < TTL) return Promise.resolve(c.data);
    return fn().then(function (data) {
      lsSet(key, JSON.stringify({ t: now, data: data }));
      return data;
    }).catch(function () { return c ? c.data : null; });
  }
  function pv(o, name, model) { return o[name] || (model ? o[name + '_' + model] : null) || null; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---------- nuvolosità e sole ----------
  function openMeteoSky(model) {
    var q = 'latitude=' + LAT + '&longitude=' + LON + '&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high' +
      '&daily=sunrise,sunset&models=' + model + '&timezone=Europe%2FRome&forecast_days=' + NDAYS;
    return getJson('https://api.open-meteo.com/v1/forecast?' + q).then(function (j) {
      var h = j.hourly || {}, d = j.daily || {}, t = h.time || [], out = { h: {}, d: {} }, i;
      var cc = pv(h, 'cloud_cover', model), cl = pv(h, 'cloud_cover_low', model),
        cm = pv(h, 'cloud_cover_mid', model), ch = pv(h, 'cloud_cover_high', model);
      for (i = 0; i < t.length; i++) {
        var day = t[i].slice(0, 10), hr = Number(t[i].slice(11, 13));
        if (!out.h[day]) out.h[day] = [];
        out.h[day][hr] = { c: num(cc && cc[i]), l: num(cl && cl[i]), m: num(cm && cm[i]), hi: num(ch && ch[i]) };
      }
      var sr = pv(d, 'sunrise', model), ss = pv(d, 'sunset', model);
      (d.time || []).forEach(function (day, k) { out.d[day] = { rise: sr ? sr[k] : null, set: ss ? ss[k] : null }; });
      return out;
    });
  }

  // Minuti di sole per ora dal modello. Il valore all'ora H è riferito all'ora precedente.
  function openMeteoSun() {
    var q = 'latitude=' + LAT + '&longitude=' + LON + '&hourly=sunshine_duration&timezone=Europe%2FRome&forecast_days=' + NDAYS;
    return getJson('https://api.open-meteo.com/v1/forecast?' + q).then(function (j) {
      var h = j.hourly || {}, t = h.time || [], s = h.sunshine_duration || [], out = { h: {} }, n = t.length, any = false, i;
      for (i = 0; i < n; i++) {
        var day = t[i].slice(0, 10), hr = Number(t[i].slice(11, 13));
        if (!out.h[day]) out.h[day] = [];
        var v = i + 1 < n ? num(s[i + 1]) : NaN;
        out.h[day][hr] = ok(v) ? Math.max(0, Math.min(60, v / 60)) : NaN;
        if (ok(v)) any = true;
      }
      if (!any) throw new Error('sunshine_duration non disponibile');
      return out;
    });
  }

  function hmToMin(s) { var m = /T(\d\d):(\d\d)/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; }
  function mmToHm(m) {
    var h = Math.floor(m / 60), mi = Math.round(m % 60);
    if (mi === 60) { h++; mi = 0; }
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }
  function sunTimes(date) {
    for (var i = 0; i < state.sky.length; i++) {
      var d = state.sky[i].data && state.sky[i].data.d, e = d && d[date];
      if (e) { var r = hmToMin(e.rise), s = hmToMin(e.set); if (ok(r) && ok(s)) return { rise: r, set: s }; }
    }
    return null;
  }

  function skyHour(date, hr, tm) {
    var cs = [], ls = [], ms = [], hs = [];
    state.sky.forEach(function (m) {
      var day = m.data && m.data.h && m.data.h[date], e = day && day[hr];
      if (!e) return;
      var c = num(e.c), l = num(e.l), md = num(e.m), hi = num(e.hi);
      if (ok(c)) cs.push(c);
      if (ok(l)) ls.push(l);
      if (ok(md)) ms.push(md);
      if (ok(hi)) hs.push(hi);
    });
    var cloud = cs.length ? MEAN(cs) : NaN;
    var frac = 1;
    if (tm) frac = Math.max(0, Math.min(hr * 60 + 60, tm.set) - Math.max(hr * 60, tm.rise)) / 60;
    var meas = state.sun && state.sun.h && state.sun.h[date] ? num(state.sun.h[date][hr]) : NaN;
    var sun = NaN, est = false;
    if (ok(meas)) sun = meas;
    else if (ok(cloud)) { sun = frac * 60 * (1 - cloud / 100); est = true; }
    if (tm && frac === 0) sun = 0;
    return {
      hr: hr, c: cloud, l: ls.length ? MEAN(ls) : NaN, m: ms.length ? MEAN(ms) : NaN, hi: hs.length ? MEAN(hs) : NaN,
      sun: sun, est: est, day: tm ? frac > 0 : (ok(sun) && sun > 0), n: cs.length
    };
  }

  function skyDay(i) {
    var date = state.dates[i], tm = sunTimes(date), nh = i === 0 ? nowHour() : 0, hrs = [], hr;
    for (hr = 0; hr < 24; hr++) { var e = skyHour(date, hr, tm); e.past = hr < nh; hrs.push(e); }
    var dayH = hrs.filter(function (e) { return e.day; });
    function avg(k) { return red(dayH.map(function (e) { return e[k]; }), MEAN); }
    return {
      hrs: hrs, tm: tm, cloud: avg('c'), low: avg('l'), mid: avg('m'), high: avg('hi'),
      sunH: SUM(dayH.map(function (e) { return ok(e.sun) ? e.sun : 0; })) / 60,
      has: dayH.some(function (e) { return ok(e.c) || ok(e.sun); }),
      est: dayH.some(function (e) { return e.est; })
    };
  }

  function skyLabel(c) {
    return !ok(c) ? 'n/d' : c < 12 ? 'Sereno' : c < 35 ? 'Poco nuvoloso' : c < 60 ? 'Parzialmente nuvoloso' : c < 85 ? 'Nuvoloso' : 'Coperto';
  }
  function sunny(e) { return e.day && ok(e.c) && e.c <= 30; }
  function cloudy(e) { return e.day && ok(e.c) && e.c >= 75; }
  function spans(hrs, test, minLen) {
    var out = [], cur = null;
    hrs.forEach(function (e, i) {
      if (e.past || !test(e)) { cur = null; return; }
      if (cur && i === cur.last + 1) cur.last = i;
      else { cur = { first: i, last: i }; out.push(cur); }
    });
    return out.filter(function (x) { return x.last - x.first + 1 >= minLen; });
  }

  function renderSkyChart(d) {
    var W = 420, H = 210, L = 36, R = 46, T = 16, B = 26, bw = (W - L - R) / 24, i, s;
    function Y(p) { return T + (H - T - B) * (1 - p / 100); }
    s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Nuvolosità e sole ora per ora">';
    if (d.tm) {
      for (i = 0; i < 24; i++) {
        if (!d.hrs[i].day) s += '<rect x="' + (L + i * bw) + '" y="' + T + '" width="' + bw + '" height="' + (H - T - B) + '" fill="var(--night)" fill-opacity="0.45"/>';
      }
    }
    [0, 50, 100].forEach(function (p) {
      s += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(p) + '" y2="' + Y(p) + '"/>' +
        '<text class="ax" x="' + (L - 6) + '" y="' + (Y(p) + 4) + '" text-anchor="end">' + p + '%</text>' +
        '<text class="ax" x="' + (W - R + 6) + '" y="' + (Y(p) + 4) + '">' + Math.round(p * 0.6) + ' min</text>';
    });
    var pts = [];
    for (i = 0; i < 24; i++) if (ok(d.hrs[i].c)) pts.push([L + i * bw + bw / 2, Y(d.hrs[i].c)]);
    if (pts.length > 1) {
      s += '<polygon points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + ' ' + pts[pts.length - 1][0] + ',' + Y(0) + ' ' + pts[0][0] + ',' + Y(0) + '" fill="var(--cloud)" fill-opacity="0.28"/>';
      s += '<polyline points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '" fill="none" stroke="var(--cloud)" stroke-width="2"/>';
    }
    for (i = 0; i < 24; i++) {
      var e = d.hrs[i];
      if (ok(e.sun) && e.sun > 0.5) {
        var hgt = (e.sun / 60) * (H - T - B);
        s += '<rect x="' + (L + i * bw + 3) + '" y="' + (H - B - hgt) + '" width="' + (bw - 6) + '" height="' + hgt + '" rx="2" fill="var(--sunfill)" fill-opacity="' + (e.past ? 0.3 : 0.9) + '"/>';
      }
      if (i % 3 === 0) s += '<text class="ax" x="' + (L + i * bw + bw / 2) + '" y="' + (H - 10) + '" text-anchor="middle">' + i + '</text>';
    }
    $('skychart').innerHTML = s + '</svg>';
  }

  function renderSky() {
    var list = $('skylist'), chart = $('skychart'), note = $('skynote');
    if (!state.sky.length) {
      list.innerHTML = '<div class="empty">' + (!state.skyDone ? 'Carico nuvolosità e sole...' : 'Dati non disponibili. Premi Aggiorna per riprovare.') + '</div>';
      chart.innerHTML = ''; note.textContent = '';
      return;
    }
    var html = '', sel = null, i;
    for (i = 0; i < NDAYS; i++) {
      var d = skyDay(i), t = toDate(state.dates[i]), parts = '';
      if (i === state.sel) sel = d;
      if (!d.has) parts = '<span class="pill off">Dati non disponibili</span>';
      else {
        parts += '<span class="pill cloudp">' + skyLabel(d.cloud) + ' · nubi ' + f(d.cloud, 0) + '%</span>';
        parts += '<span class="pill sunp">Sole ' + f(d.sunH) + ' h</span>';
        spans(d.hrs, sunny, 2).forEach(function (x) { parts += '<span class="pill sunp">Più sole ' + x.first + '–' + (x.last + 1) + '</span>'; });
        spans(d.hrs, cloudy, 2).forEach(function (x) { parts += '<span class="pill cloudp">Più nubi ' + x.first + '–' + (x.last + 1) + '</span>'; });
      }
      html += '<div class="rl' + (i === state.sel ? ' sel' : '') + '" data-d="' + i + '"><div class="rd"><b>' + fmtWd(t) + '</b> ' + fmtDm(t) + '</div><div class="rp">' + parts + '</div></div>';
    }
    list.innerHTML = html;
    var ts = toDate(state.dates[state.sel]);
    if (sel && sel.has) {
      renderSkyChart(sel);
      chart.insertAdjacentHTML('afterbegin', '<p class="subh">Ora per ora · ' + fmtWd(ts) + ' ' + fmtDm(ts) + (sel.tm ? ' · alba ' + mmToHm(sel.tm.rise) + ' · tramonto ' + mmToHm(sel.tm.set) : '') + '</p>');
      chart.insertAdjacentHTML('beforeend', '<p class="sub2">Di giorno, in media: nubi basse ' + f(sel.low, 0) + '% · medie ' + f(sel.mid, 0) + '% · alte ' + f(sel.high, 0) + '%</p>');
    } else { chart.innerHTML = ''; }
    note.textContent = 'Nuvolosità: media di ' + state.sky.length + (state.sky.length === 1 ? ' modello' : ' modelli') + '. ' +
      (sel && sel.est ? 'I minuti di sole sono stimati dalla nuvolosità. ' : 'I minuti di sole vengono dal modello meteorologico. ') +
      'Valori indicativi: con nubi alte e sottili il sole può comparire velato.';
  }

  // ---------- aria e pollini ----------
  var AQ_FULL = 'european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide,uv_index,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen';
  var AQ_CORE = 'european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide';
  var AQ_KEYS = {
    european_aqi: 'aqi', pm10: 'pm10', pm2_5: 'pm25', nitrogen_dioxide: 'no2', ozone: 'o3', sulphur_dioxide: 'so2', uv_index: 'uv',
    alder_pollen: 'alder', birch_pollen: 'birch', grass_pollen: 'grass', mugwort_pollen: 'mugwort', olive_pollen: 'olive', ragweed_pollen: 'ragweed'
  };
  var POLLEN = [['alder', 'Ontano'], ['birch', 'Betulla'], ['grass', 'Graminacee'], ['mugwort', 'Artemisia'], ['olive', 'Olivo'], ['ragweed', 'Ambrosia']];
  var EAQI = [
    { max: 20, t: 'Buona', c: 'ok', adv: 'Aria buona: nessuna precauzione particolare.' },
    { max: 40, t: 'Discreta', c: 'ok', adv: 'Aria discreta: le persone molto sensibili possono avvertire lievi disturbi.' },
    { max: 60, t: 'Moderata', c: 'warn', adv: "Qualità moderata: chi ha asma o problemi cardiaci o respiratori può ridurre gli sforzi prolungati all'aperto." },
    { max: 80, t: 'Scadente', c: 'bad', adv: "Qualità scadente: meglio ridurre l'attività fisica intensa all'aperto, soprattutto bambini, anziani e persone con asma." },
    { max: 100, t: 'Molto scadente', c: 'bad', adv: "Qualità molto scadente: evitare l'attività fisica intensa all'aperto." },
    { max: Infinity, t: 'Estremamente scadente', c: 'bad', adv: "Qualità estremamente scadente: evitare l'attività all'aperto, soprattutto le persone sensibili." }
  ];

  function openMeteoAirOnce(vars) {
    var url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + LAT + '&longitude=' + LON +
      '&hourly=' + vars + '&timezone=Europe%2FRome&forecast_days=' + NDAYS;
    return getJson(url).then(function (j) {
      var h = j.hourly || {}, t = h.time || [], out = { h: {} }, any = false, i;
      var names = Object.keys(AQ_KEYS);
      for (i = 0; i < t.length; i++) {
        var day = t[i].slice(0, 10), hr = Number(t[i].slice(11, 13));
        var o = out.h[day] || (out.h[day] = {});
        for (var k = 0; k < names.length; k++) {
          var key = AQ_KEYS[names[k]];
          if (!o[key]) o[key] = [];
          var v = h[names[k]] ? num(h[names[k]][i]) : NaN;
          o[key][hr] = v;
          if (ok(v) && (key === 'aqi' || key === 'pm10')) any = true;
        }
      }
      if (!any) throw new Error('nessun dato sulla qualità dell\'aria');
      return out;
    });
  }
  function openMeteoAir() {
    return openMeteoAirOnce(AQ_FULL).catch(function () { return openMeteoAirOnce(AQ_CORE); });
  }

  function aqiBand(v) {
    for (var i = 0; i < EAQI.length; i++) if (v <= EAQI[i].max) return EAQI[i];
    return EAQI[EAQI.length - 1];
  }
  function uvLevel(v) {
    return v < 3 ? { t: 'basso', c: 'ok' } : v < 6 ? { t: 'moderato', c: 'warn' } : v < 8 ? { t: 'alto', c: 'warn' } : v < 11 ? { t: 'molto alto', c: 'bad' } : { t: 'estremo', c: 'bad' };
  }
  function pollenLevel(v) {
    if (!ok(v)) return ['fuori stagione', 'off'];
    if (v < 1) return ['assente', 'ok'];
    if (v < 10) return ['basso', 'ok'];
    if (v < 50) return ['medio', 'warn'];
    if (v < 200) return ['alto', 'bad'];
    return ['molto alto', 'bad'];
  }
  function max8(a) {
    var best = NaN, i, j;
    for (i = 0; i + 8 <= a.length; i++) {
      var s = 0, n = 0;
      for (j = i; j < i + 8; j++) if (ok(a[j])) { s += a[j]; n++; }
      if (n >= 6) { var m = s / n; if (!ok(best) || m > best) best = m; }
    }
    return best;
  }

  function airDay(i) {
    var date = state.dates[i], o = state.air && state.air.h && state.air.h[date];
    if (!o) return null;
    function arr(k) { return (o[k] || []).map(function (x) { return num(x); }); }
    var aqi = arr('aqi'), pm10 = arr('pm10');
    if (!aqi.some(ok) && !pm10.some(ok)) return null;
    var nh = i === 0 ? nowHour() : 0, idx = [], hr;
    for (hr = 0; hr < 24; hr++) if (ok(aqi[hr]) && hr >= nh) idx.push(hr);
    if (!idx.length) for (hr = 0; hr < 24; hr++) if (ok(aqi[hr])) idx.push(hr);
    var best = idx.length ? idx[0] : -1, worst = best;
    idx.forEach(function (h) { if (aqi[h] < aqi[best]) best = h; if (aqi[h] > aqi[worst]) worst = h; });
    var pollen = {};
    POLLEN.forEach(function (p) { pollen[p[0]] = red(arr(p[0]), MAX); });
    return {
      has: idx.length > 0,
      max: worst >= 0 ? aqi[worst] : NaN, worstHr: worst, worst: worst >= 0 ? aqi[worst] : NaN,
      bestHr: best, best: best >= 0 ? aqi[best] : NaN,
      pm25: red(arr('pm25'), MEAN), pm10: red(pm10, MEAN), no2: red(arr('no2'), MEAN), so2: red(arr('so2'), MEAN),
      o3: max8(arr('o3')), uv: red(arr('uv'), MAX), pollen: pollen
    };
  }

  function pollenPill(a) {
    var vals = POLLEN.map(function (p) { return { n: p[1], v: a.pollen[p[0]] }; });
    var present = vals.filter(function (x) { return ok(x.v); });
    if (!present.length) return '<span class="pill off">Pollini: fuori stagione</span>';
    var hi = present.filter(function (x) { return x.v >= 1; }).sort(function (x, y) { return y.v - x.v; });
    if (!hi.length) return '<span class="pill ok">Pollini assenti</span>';
    var lv = pollenLevel(hi[0].v);
    return '<span class="pill ' + lv[1] + '">Pollini: ' + hi[0].n + ' ' + lv[0] + (hi.length > 1 ? ' +' + (hi.length - 1) : '') + '</span>';
  }

  function renderAirDetail(a) {
    var now = $('airnow'), pol = $('airpollen');
    var ts = toDate(state.dates[state.sel]), tl = fmtWd(ts) + ' ' + fmtDm(ts);
    if (!a) {
      now.innerHTML = '<p class="sub2">Per ' + tl + ' la previsione della qualità dell\'aria non è ancora disponibile: il modello copre circa 4 giorni.</p>';
      pol.innerHTML = '';
      return;
    }
    var b = aqiBand(a.max), h = '';
    if (a.has) {
      h += '<p class="subh">Qualità dell\'aria · ' + tl + '</p>' +
        '<div class="aqrow"><span class="pill ' + b.c + '">' + b.t + '</span><span>Indice europeo massimo ' + f(a.max, 0) + ' alle ' + hh(a.worstHr) + '</span></div>' +
        '<p class="adv">' + b.adv + '</p>';
      if (a.bestHr !== a.worstHr) h += '<p class="sub2">Ora migliore ' + hh(a.bestHr) + ' (indice ' + f(a.best, 0) + ') · ora peggiore ' + hh(a.worstHr) + ' (indice ' + f(a.worst, 0) + ')</p>';
    }
    var rows = [
      ['PM2,5', 'media giornaliera', a.pm25, 15],
      ['PM10', 'media giornaliera', a.pm10, 45],
      ['Biossido di azoto', 'media giornaliera', a.no2, 25],
      ['Biossido di zolfo', 'media giornaliera', a.so2, 40],
      ['Ozono', 'massimo su 8 ore', a.o3, 100]
    ];
    h += '<p class="subh">Inquinanti · valore previsto / soglia OMS, in µg/m³</p>';
    rows.forEach(function (r) {
      var ratio = ok(r[2]) ? r[2] / r[3] : NaN;
      var pc = !ok(ratio) ? 'off' : ratio <= 1 ? 'ok' : ratio <= 2 ? 'warn' : 'bad';
      var pt = !ok(ratio) ? 'n/d' : ratio <= 1 ? 'sotto soglia' : ratio <= 2 ? 'sopra soglia' : 'molto sopra';
      h += '<div class="pl"><span>' + r[0] + '<br><small class="dim">' + r[1] + '</small></span><span class="vv">' + f(r[2], 1) + ' / ' + r[3] + '</span><span class="pill ' + pc + '">' + pt + '</span></div>';
    });
    if (ok(a.uv)) { var u = uvLevel(a.uv); h += '<div class="aqrow"><span class="pill ' + u.c + '">UV ' + f(a.uv, 0) + ' · ' + u.t + '</span><span>Indice UV massimo della giornata</span></div>'; }
    now.innerHTML = h;

    var any = false, ph = '';
    POLLEN.forEach(function (p) {
      var v = a.pollen[p[0]];
      if (ok(v)) any = true;
      var lv = pollenLevel(v);
      ph += '<div class="pl"><span>' + p[1] + '</span><span class="vv">' + (ok(v) ? f(v, 0) + ' gr/m³' : 'n/d') + '</span><span class="pill ' + lv[1] + '">' + lv[0] + '</span></div>';
    });
    pol.innerHTML = '<p class="subh">Pollini · ' + tl + '</p>' +
      (any ? ph : '<p class="sub2">Il modello non segnala pollini: siamo fuori stagione di fioritura per le specie monitorate.</p>');
  }

  function renderAir() {
    var list = $('airlist');
    if (!state.air) {
      list.innerHTML = '<div class="empty">' + (!state.airDone ? "Carico la qualità dell'aria..." : 'Dati non disponibili. Premi Aggiorna per riprovare.') + '</div>';
      $('airnow').innerHTML = ''; $('airpollen').innerHTML = '';
      return;
    }
    var html = '', days = [], i;
    for (i = 0; i < NDAYS; i++) {
      var a = airDay(i), t = toDate(state.dates[i]), parts = '';
      days.push(a);
      if (!a) parts = '<span class="pill off">Non ancora disponibile</span>';
      else {
        if (a.has) { var b = aqiBand(a.max); parts += '<span class="pill ' + b.c + '">Indice ' + f(a.max, 0) + ' · ' + b.t + '</span>'; }
        if (ok(a.uv)) { var u = uvLevel(a.uv); parts += '<span class="pill ' + u.c + '">UV ' + f(a.uv, 0) + ' · ' + u.t + '</span>'; }
        parts += pollenPill(a);
      }
      html += '<div class="rl' + (i === state.sel ? ' sel' : '') + '" data-d="' + i + '"><div class="rd"><b>' + fmtWd(t) + '</b> ' + fmtDm(t) + '</div><div class="rp">' + parts + '</div></div>';
    }
    list.innerHTML = html;
    renderAirDetail(days[state.sel]);
  }

  function renderExtras() {
    var errs = [];
    [['luna', renderMoon], ['maree', renderTide], ['temperature', renderTemp], ['pioggia', renderRain], ['sole', renderSky], ['aria', renderAir]].forEach(function (p) {
      try { p[1](); } catch (e) { errs.push(p[0] + ': ' + e.message); }
    });
    $('diag').textContent = errs.length ? 'Avviso: sezione non mostrata (' + errs.join('; ') + ').' : '';
  }

  function refresh(force) {
    if (state.loading) return;
    state.loading = true;
    state.done = 0;
    state.results = [];
    state.frames = {};
    state.hourlyDone = false; state.skyDone = false; state.airDone = false;
    $('refresh').disabled = true;
    state.dates = windowDates();
    safeRender();
    SOURCES.forEach(function (s, idx) {
      load(s, force).then(function (r) {
        r.order = idx;
        state.results.push(r);
        state.results.sort(function (a, b) { return a.order - b.order; });
        var m = {};
        r.rows.forEach(function (x) { m[x.date] = x; });
        state.frames[r.src.id] = m;
        state.done++;
        state.last = new Date();
        if (state.done >= SOURCES.length) { state.loading = false; $('refresh').disabled = false; }
        safeRender();
      });
    });
    loadAllHourly(force).then(function (h) {
      state.hourly = h; state.hourlyDone = true; safeRender();
    });
    Promise.all(HMODELS.map(function (m) {
      return loadCached('meteo.s9.' + m.id, function () { return openMeteoSky(m.model); }, force).then(function (d) { return d ? { id: m.id, data: d } : null; });
    })).then(function (r) { state.sky = r.filter(Boolean); state.skyDone = true; safeRender(); });
    loadCached('meteo.sun9', openMeteoSun, force).then(function (d) { state.sun = d; safeRender(); });
    loadCached('meteo.a', openMeteoAir, force).then(function (d) { state.air = d; state.airDone = true; safeRender(); });
  }

  function safeRender() {
    try { render(); } catch (e) {
      $('lead').textContent = 'Errore: ' + e.message + ' (versione ' + VERSION + ')';
      state.loading = false; $('refresh').disabled = false;
    }
  }

  function setSel(e) {
    var el = e.target.closest('[data-d]');
    if (!el) return;
    state.sel = Number(el.getAttribute('data-d'));
    safeRender();
  }
  $('days').addEventListener('click', setSel);
  $('chart').addEventListener('click', setSel);
  $('tbl').addEventListener('click', setSel);
  $('templist').addEventListener('click', setSel);
  $('moonstrip').addEventListener('click', setSel);
  $('tidelist').addEventListener('click', setSel);
  $('rainlist').addEventListener('click', setSel);
  $('skylist').addEventListener('click', setSel);
  $('airlist').addEventListener('click', setSel);
  $('refresh').addEventListener('click', function () { refresh(true); });
  function setMode(m) {
    state.mode = m;
    $('m-mean').setAttribute('aria-pressed', String(m === 'mean'));
    $('m-med').setAttribute('aria-pressed', String(m === 'med'));
    if (state.A) render();
  }
  $('m-mean').addEventListener('click', function () { setMode('mean'); });
  $('m-med').addEventListener('click', function () { setMode('med'); });

  var ids = { owm: 'k-owm', wapi: 'k-wapi', vc: 'k-vc', tio: 'k-tio' };
  (function fillKeys() { var k = getKeys(); Object.keys(ids).forEach(function (n) { $(ids[n]).value = k[n] || ''; }); })();
  $('keys').addEventListener('submit', function (e) {
    e.preventDefault();
    var k = {};
    Object.keys(ids).forEach(function (n) { var v = $(ids[n]).value.trim(); if (v) k[n] = v; });
    lsSet('meteo.keys', JSON.stringify(k));
    $('settings').open = false;
    refresh(false);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.last && Date.now() - state.last.getTime() > TTL) refresh(false);
  });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !NATIVE) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* facoltativo */ });
  }

  var ft = document.querySelector('.foot');
  if (ft) ft.textContent += ' Versione app ' + VERSION + '.';
  state.dates = windowDates();
  refresh(false);
})();
