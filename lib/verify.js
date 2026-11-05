/* global self */
/*
 * Verification logic shared by the server plugin and the web app. It has no
 * dependencies and runs in Node.js and in the browser (as window.Verify).
 *
 * Times are UTC milliseconds. A forecast value is valid at the full hour H:
 *   mean wind  instantaneous 10 m wind at H       -> measured 10-min WMO mean ending at H
 *   gust       highest gust in the hour before H  -> measured highest WMO gust in [H-1h, H)
 *   direction  instantaneous 10 m direction at H  -> measured 10-min WMO mean direction ending at H
 * Directions are degrees from true north, the direction the wind blows from.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.Verify = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const HOUR = 3600000
  const TEN_MIN = 600000

  /** Floors a time to the full UTC hour. */
  const floorHour = (t) => Math.floor(t / HOUR) * HOUR

  /** Parses an Open-Meteo GMT time ("2026-11-04T19:00") or an ISO string to ms. */
  function parseTime (s) {
    if (typeof s === 'number') return s
    return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z')
  }

  /**
   * Turns a Signal K History API response into { 'path:method': Map(labelMs -> value) }.
   * The response lists its columns in `values` ({ path, method }) and its rows in
   * `data` ([time, v1, v2, ...]); a row labelled T covers [T, T + resolution).
   */
  function historyColumns (response) {
    const out = {}
    const cols = (response && response.values) || []
    cols.forEach((c) => { out[`${c.path}:${c.method}`] = new Map() })
    for (const row of (response && response.data) || []) {
      const t = parseTime(row[0])
      cols.forEach((c, i) => {
        const v = row[i + 1]
        if (v !== null && v !== undefined) out[`${c.path}:${c.method}`].set(t, v)
      })
    }
    return out
  }

  /** Reads a position as [lon, lat] or { latitude, longitude }. */
  function toPosition (p) {
    if (Array.isArray(p) && p.length >= 2) return { lon: p[0], lat: p[1] }
    if (p && typeof p === 'object' && typeof p.latitude === 'number') return { lon: p.longitude, lat: p.latitude }
    return null
  }

  const DEG = 180 / Math.PI

  /** Speed-weighted vector mean of [{ v, d }] (m/s, degrees), or null. */
  function vectorMean (items) {
    let x = 0
    let y = 0
    let n = 0
    for (const { v, d } of items) {
      if (!Number.isFinite(v) || !Number.isFinite(d)) continue
      x += v * Math.sin(d / DEG)
      y += v * Math.cos(d / DEG)
      n++
    }
    if (n === 0 || (x === 0 && y === 0)) return null
    return (Math.atan2(x, y) * DEG + 360) % 360
  }

  /** Signed difference forecast - observed in degrees, -180 to 180 (positive: forecast veered). */
  function angleDiff (f, o) {
    return ((f - o) % 360 + 540) % 360 - 180
  }

  /**
   * Builds the hourly measured series from two History API responses:
   *   tenMin  resolution 600 s, starting 10 min before the first hour, with
   *           <meanPath>:last and <rawPath>:average
   *   hourly  resolution 3600 s, starting 1 h before the first hour, with
   *           <gustPath>:max, navigation.speedOverGround:max and navigation.position:first
   * Returns rows { t, mean, meanBackfilled, gust, sogMax, position } for every full
   * hour from fromMs to toMs. Where the WMO mean is missing, the raw average is
   * used instead, multiplied by `heightFactor` to put it on the same 10 m
   * footing, and the row is marked meanBackfilled.
   */
  function measuredHours ({ tenMin, hourly, oneMin, meanPath, rawPath, gustPath, dirPath, rawDirPath, heightFactor = 1, fromMs, toMs }) {
    const ten = historyColumns(tenMin)
    const hr = historyColumns(hourly)
    const wmoMean = ten[`${meanPath}:last`] || new Map()
    const rawMean = ten[`${rawPath}:average`] || new Map()
    const gust = hr[`${gustPath}:max`] || new Map()
    const sog = hr['navigation.speedOverGround:max'] || new Map()
    const pos = hr['navigation.position:first'] || new Map()
    const wmoDir = ten[`${dirPath}:last`] || new Map()
    const one = historyColumns(oneMin)
    const oneSpeed = one[`${rawPath}:average`] || new Map()
    const oneDir = one[`${rawDirPath}:last`] || new Map()

    const rows = []
    for (let t = Math.ceil(fromMs / HOUR) * HOUR; t <= toMs; t += HOUR) {
      let mean = wmoMean.get(t - TEN_MIN)
      let meanBackfilled = false
      if (mean === undefined) {
        const raw = rawMean.get(t - TEN_MIN)
        if (raw !== undefined) { mean = raw * heightFactor; meanBackfilled = true }
      }
      // Direction: the WMO mean (radians); else the vector mean of the ten
      // one-minute raw samples before the hour, if at least half are there.
      let dir = null
      let dirBackfilled = false
      const w = wmoDir.get(t - TEN_MIN)
      if (Number.isFinite(w)) {
        dir = (w * DEG + 360) % 360
      } else if (oneDir.size) {
        const items = []
        for (let m = t - TEN_MIN; m < t; m += 60000) {
          if (oneSpeed.has(m) && oneDir.has(m)) items.push({ v: oneSpeed.get(m), d: oneDir.get(m) * DEG })
        }
        if (items.length >= 5) { dir = vectorMean(items); dirBackfilled = dir !== null }
      }
      rows.push({
        t,
        mean: mean === undefined ? null : mean,
        meanBackfilled,
        dir,
        dirBackfilled,
        gust: gust.has(t - HOUR) ? gust.get(t - HOUR) : null,
        sogMax: sog.has(t - HOUR) ? sog.get(t - HOUR) : null,
        position: toPosition(pos.get(t - HOUR))
      })
    }
    return rows
  }

  /** Rounds a position to a forecast cell, so that nearby hours share one request. */
  function cellOf (pos, step = 0.05) {
    const lat = +(Math.round(pos.lat / step) * step).toFixed(4)
    const lon = +(Math.round(pos.lon / step) * step).toFixed(4)
    return { lat, lon, key: `${lat},${lon}` }
  }

  /**
   * Parses an Open-Meteo hourly response for the requested models. With one
   * model the keys have no suffix; with several they end in _<model>. Lead 0
   * reads wind_speed_10m; lead d > 0 reads wind_speed_10m_previous_day<d>.
   * Returns { times: [ms], models: { id: { mean: [], gust: [] } } } in m/s.
   */
  function parseOpenMeteo (json, models, lead = 0) {
    const h = (json && json.hourly) || {}
    const times = (h.time || []).map(parseTime)
    const sfx = lead > 0 ? `_previous_day${lead}` : ''
    const out = { times, models: {} }
    for (const m of models) {
      const key = (v) => (models.length === 1 && h[`${v}${sfx}`] ? `${v}${sfx}` : `${v}${sfx}_${m}`)
      const mean = h[key('wind_speed_10m')] || []
      const gust = h[key('wind_gusts_10m')] || []
      const dir = h[key('wind_direction_10m')] || []
      const num = (a) => times.map((_, i) => (typeof a[i] === 'number' ? a[i] : null))
      out.models[m] = { mean: num(mean), gust: num(gust), dir: num(dir) }
    }
    return out
  }

  /**
   * Error statistics of forecast against measurement over the pairs where both
   * exist: { n, bias, mae, rmse } in m/s, forecast minus measured.
   */
  function score (pairs) {
    const ok = pairs.filter((p) => Number.isFinite(p.f) && Number.isFinite(p.o))
    if (ok.length === 0) return { n: 0, bias: null, mae: null, rmse: null }
    let s = 0; let a = 0; let q = 0
    for (const { f, o } of ok) { const d = f - o; s += d; a += Math.abs(d); q += d * d }
    return { n: ok.length, bias: s / ok.length, mae: a / ok.length, rmse: Math.sqrt(q / ok.length) }
  }

  /**
   * Direction error statistics over pairs { f, o } in degrees: the same as
   * score(), on the circular difference, so 355° against 5° is a 10° error.
   */
  function scoreDirection (pairs) {
    const diffs = pairs
      .filter((p) => Number.isFinite(p.f) && Number.isFinite(p.o))
      .map((p) => ({ f: angleDiff(p.f, p.o), o: 0 }))
    return score(diffs)
  }

  /** Factor of the power-law wind profile from height h (m) to 10 m. */
  function heightFactor (h, exponent) {
    if (!(h > 0) || !(exponent > 0)) return 1
    return Math.pow(10 / h, exponent)
  }

  /**
   * The WMO plugin's output paths for a source path (see signalk-wmo-gust):
   * ground and water references get their own names, anything else a suffix.
   */
  function wmoPaths (src) {
    if (src === 'environment.wind.speedOverGround') {
      return { mean: 'environment.wind.speedOverGroundMeanWMO', gust: 'environment.wind.gustOverGroundWMO', dir: 'environment.wind.directionOverGroundMeanWMO' }
    }
    if (src === 'environment.wind.speedTrue') {
      return { mean: 'environment.wind.speedTrueMeanWMO', gust: 'environment.wind.gustTrueWMO', dir: 'environment.wind.directionTrueMeanWMO' }
    }
    return { mean: `${src}MeanWMO`, gust: `${src}GustWMO`, dir: `${src}DirectionMeanWMO` }
  }

  return { HOUR, TEN_MIN, floorHour, parseTime, historyColumns, toPosition, vectorMean, angleDiff, measuredHours, cellOf, parseOpenMeteo, score, scoreDirection, heightFactor, wmoPaths }
})
