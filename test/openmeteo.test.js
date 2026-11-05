'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../lib/openmeteo')

// A fake Open-Meteo: three models have data at the cell, the rest are out of area.
function fakeFetch (log) {
  const here = ['ecmwf_ifs', 'gfs_global', 'meteofrance_arome_france_hd']
  return async (url) => {
    log.push(url)
    const u = new URL(url)
    const models = u.searchParams.get('models').split(',')
    const lead = u.hostname.startsWith('previous-runs') ? 1 : 0
    if (models.some((m) => !here.includes(m))) {
      return { ok: false, status: 400, json: async () => ({ error: true, reason: 'No data is available for this location' }) }
    }
    const sfx = lead ? '_previous_day1' : ''
    const hourly = { time: ['2026-11-04T12:00', '2026-11-04T13:00'] }
    models.forEach((m, i) => {
      const k = models.length === 1 ? '' : `_${m}`
      hourly[`wind_speed_10m${sfx}${k}`] = [5 + i, 6 + i]
      hourly[`wind_gusts_10m${sfx}${k}`] = m === 'meteofrance_arome_france_hd' ? [null, null] : [9, 10]
    })
    return { ok: true, status: 200, json: async () => ({ hourly }) }
  }
}

describe('Open-Meteo client', () => {
  const cell = { lat: 41.25, lon: 1.95, key: '41.25,1.95' }

  it('keeps only the models with data at the cell', async () => {
    const log = []
    const c = createClient({ fetchImpl: fakeFetch(log) })
    assert.deepEqual(await c.availableModels(cell), ['ecmwf_ifs', 'gfs_global', 'meteofrance_arome_france_hd'])
  })

  it('asks for all available models in one request and caches it', async () => {
    const log = []
    const c = createClient({ fetchImpl: fakeFetch(log) })
    const f = await c.forecast(cell, { lead: 0, pastDays: 3, forecastDays: 2 })
    assert.deepEqual(Object.keys(f.models), ['ecmwf_ifs', 'gfs_global', 'meteofrance_arome_france_hd'])
    assert.deepEqual(f.models.gfs_global.mean, [6, 7])
    const requests = log.length
    await c.forecast(cell, { lead: 0, pastDays: 3, forecastDays: 2 })
    assert.equal(log.length, requests, 'second call served from cache')
    const main = log.find((u) => u.includes('models=ecmwf_ifs%2Cgfs_global'))
    assert.match(main, /past_days=3/)
    assert.match(main, /wind_speed_unit=ms/)
    assert.match(main, /wind_direction_10m/)
  })

  it('uses the Previous Runs API for earlier issues', async () => {
    const log = []
    const c = createClient({ fetchImpl: fakeFetch(log) })
    const f = await c.forecast(cell, { lead: 1, pastDays: 3 })
    assert.ok(log.some((u) => u.startsWith('https://previous-runs-api.open-meteo.com/') && u.includes('previous_day1')))
    assert.deepEqual(f.models.ecmwf_ifs.gust, [9, 10])
  })

  it('refreshes the probe after a day', async () => {
    const log = []
    let t = 0
    const c = createClient({ fetchImpl: fakeFetch(log), now: () => t })
    await c.availableModels(cell)
    const n = log.length
    await c.availableModels(cell)
    assert.equal(log.length, n)
    t = 25 * 3600000
    await c.availableModels(cell)
    assert.ok(log.length > n)
  })
})
