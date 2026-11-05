'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const V = require('../lib/verify')

const H = 3600000
const T0 = Date.parse('2026-11-04T12:00:00Z')
const iso = (t) => new Date(t).toISOString()

describe('measuredHours', () => {
  const meanPath = 'environment.wind.speedOverGroundMeanWMO'
  const rawPath = 'environment.wind.speedOverGround'
  const gustPath = 'environment.wind.gustOverGroundWMO'

  // 10-minute buckets: the one labelled H-10 min ends at H.
  const tenMin = {
    values: [{ path: meanPath, method: 'last' }, { path: rawPath, method: 'average' }],
    data: [
      [iso(T0 - 600000), null, 6.0], // 12:00, WMO mean missing: back-filled from raw
      [iso(T0 + H - 600000), 5.0, 9.9], // 13:00, WMO mean present: raw ignored
      [iso(T0 + 2 * H - 600000), null, null] // 14:00, nothing
    ]
  }
  // Hourly buckets: the one labelled H-1h covers the hour before H.
  const hourly = {
    values: [{ path: gustPath, method: 'max' }, { path: 'navigation.speedOverGround', method: 'max' }, { path: 'navigation.position', method: 'first' }],
    data: [
      [iso(T0 - H), null, 0.1, [1.93, 41.26]],
      [iso(T0), 8.5, 0.2, [1.93, 41.26]],
      [iso(T0 + H), 7.0, 3.0, { longitude: 2.5, latitude: 41.5 }]
    ]
  }
  const rows = V.measuredHours({ tenMin, hourly, meanPath, rawPath, gustPath, heightFactor: 0.9, fromMs: T0, toMs: T0 + 2 * H })

  it('makes one row per full hour', () => {
    assert.deepEqual(rows.map((r) => r.t), [T0, T0 + H, T0 + 2 * H])
  })
  it('uses the 10-minute WMO mean ending at the hour', () => {
    assert.equal(rows[1].mean, 5.0)
    assert.equal(rows[1].meanBackfilled, false)
  })
  it('back-fills from the raw average, height-corrected, when the WMO mean is missing', () => {
    assert.ok(Math.abs(rows[0].mean - 5.4) < 1e-9)
    assert.equal(rows[0].meanBackfilled, true)
    assert.equal(rows[2].mean, null)
  })
  it('takes the highest gust of the hour before', () => {
    assert.equal(rows[0].gust, null)
    assert.equal(rows[1].gust, 8.5)
    assert.equal(rows[2].gust, 7.0)
  })
  it('reads positions in both Signal K forms', () => {
    assert.deepEqual(rows[0].position, { lon: 1.93, lat: 41.26 })
    assert.deepEqual(rows[2].position, { lon: 2.5, lat: 41.5 })
    assert.equal(rows[2].sogMax, 3.0)
  })
})

describe('direction', () => {
  it('averages across north as vectors, weighted by speed', () => {
    const north = V.vectorMean([{ v: 6, d: 350 }, { v: 6, d: 10 }])
    assert.ok(north < 0.01 || north > 359.99)
    assert.ok(Math.abs(V.vectorMean([{ v: 9, d: 90 }, { v: 3, d: 180 }]) - 108.43) < 0.01)
    assert.equal(V.vectorMean([]), null)
  })
  it('takes the circular difference, positive when the forecast is veered', () => {
    assert.equal(V.angleDiff(5, 355), 10)
    assert.equal(V.angleDiff(355, 5), -10)
    assert.equal(V.angleDiff(90, 90), 0)
  })
  it('scores direction on circular differences', () => {
    const s = V.scoreDirection([{ f: 5, o: 355 }, { f: 340, o: 10 }, { f: null, o: 3 }])
    assert.equal(s.n, 2)
    assert.equal(s.bias, -10)
    assert.equal(s.mae, 20)
  })
  it('uses the WMO mean direction, and back-fills from one-minute raw samples', () => {
    const meanPath = 'm'; const rawPath = 'raw'; const gustPath = 'g'; const dirPath = 'dirWMO'; const rawDirPath = 'dirRaw'
    const rad = (d) => d * Math.PI / 180
    const tenMin = { values: [{ path: dirPath, method: 'last' }], data: [[iso(T0 + H - 600000), rad(270)]] }
    const oneMin = { values: [{ path: rawPath, method: 'average' }, { path: rawDirPath, method: 'last' }], data: [] }
    for (let i = 0; i < 10; i++) oneMin.data.push([iso(T0 - 600000 + i * 60000), 5, rad(i % 2 ? 350 : 10)])
    const rows = V.measuredHours({ tenMin, hourly: {}, oneMin, meanPath, rawPath, gustPath, dirPath, rawDirPath, fromMs: T0, toMs: T0 + 2 * H })
    assert.ok(rows[0].dir < 0.01 || rows[0].dir > 359.99)
    assert.equal(rows[0].dirBackfilled, true)
    assert.ok(Math.abs(rows[1].dir - 270) < 1e-9)
    assert.equal(rows[1].dirBackfilled, false)
    assert.equal(rows[2].dir, null)
  })
})

describe('parseOpenMeteo', () => {
  it('reads suffixed keys for several models', () => {
    const json = { hourly: { time: ['2026-11-04T12:00', '2026-11-04T13:00'], wind_speed_10m_gfs_global: [5, null], wind_gusts_10m_gfs_global: [8, 9], wind_speed_10m_ecmwf_ifs: [6, 7] } }
    const p = V.parseOpenMeteo(json, ['gfs_global', 'ecmwf_ifs'])
    assert.deepEqual(p.times, [T0, T0 + H])
    assert.deepEqual(p.models.gfs_global, { mean: [5, null], gust: [8, 9], dir: [null, null] })
    assert.deepEqual(p.models.ecmwf_ifs.gust, [null, null])
  })
  it('reads unsuffixed keys for one model', () => {
    const json = { hourly: { time: ['2026-11-04T12:00'], wind_speed_10m: [4], wind_gusts_10m: [7], wind_direction_10m: [225] } }
    assert.deepEqual(V.parseOpenMeteo(json, ['icon_eu']).models.icon_eu, { mean: [4], gust: [7], dir: [225] })
  })
  it('reads previous-run keys', () => {
    const json = { hourly: { time: ['2026-11-04T12:00'], wind_speed_10m_previous_day1_icon_eu: [4], wind_gusts_10m_previous_day1_icon_eu: [6], wind_speed_10m_previous_day1_gfs_global: [5] } }
    const p = V.parseOpenMeteo(json, ['icon_eu', 'gfs_global'], 1)
    assert.deepEqual(p.models.icon_eu, { mean: [4], gust: [6], dir: [null] })
    assert.deepEqual(p.models.gfs_global, { mean: [5], gust: [null], dir: [null] })
  })
})

describe('score', () => {
  it('gives bias, average error and RMSE over complete pairs', () => {
    const s = V.score([{ f: 6, o: 5 }, { f: 3, o: 5 }, { f: null, o: 5 }, { f: 4, o: null }])
    assert.equal(s.n, 2)
    assert.equal(s.bias, -0.5)
    assert.equal(s.mae, 1.5)
    assert.ok(Math.abs(s.rmse - Math.sqrt(2.5)) < 1e-12)
  })
  it('reports no pairs', () => {
    assert.deepEqual(V.score([{ f: null, o: 1 }]), { n: 0, bias: null, mae: null, rmse: null })
  })
})

describe('helpers', () => {
  it('rounds positions to cells', () => {
    assert.equal(V.cellOf({ lat: 41.2604, lon: 1.9273 }).key, '41.25,1.95')
    assert.equal(V.cellOf({ lat: 41.2604, lon: 1.9273 }, 0.5).key, '41.5,2')
  })
  it('matches the WMO plugin path names', () => {
    assert.deepEqual(V.wmoPaths('environment.wind.speedOverGround'), { mean: 'environment.wind.speedOverGroundMeanWMO', gust: 'environment.wind.gustOverGroundWMO', dir: 'environment.wind.directionOverGroundMeanWMO' })
    assert.deepEqual(V.wmoPaths('environment.wind.speedTrue'), { mean: 'environment.wind.speedTrueMeanWMO', gust: 'environment.wind.gustTrueWMO', dir: 'environment.wind.directionTrueMeanWMO' })
  })
  it('computes the height factor', () => {
    assert.ok(Math.abs(V.heightFactor(29.4, 0.11) - Math.pow(10 / 29.4, 0.11)) < 1e-12)
    assert.equal(V.heightFactor(null, 0.11), 1)
  })
})
