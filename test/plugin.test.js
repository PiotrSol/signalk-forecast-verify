'use strict'
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const createPlugin = require('..')

function setup ({ wmo, airHeight = 30, settings = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcv-'))
  if (wmo) {
    fs.mkdirSync(path.join(dir, 'plugin-config-data'))
    fs.writeFileSync(path.join(dir, 'plugin-config-data', 'signalk-wmo-gust.json'), JSON.stringify({ configuration: wmo }))
  }
  const app = { debug: () => {}, error: () => {}, setPluginStatus: (s) => { app.status = s }, config: { configPath: dir }, getSelfPath: () => ({ value: airHeight }) }
  const plugin = createPlugin(app)
  const routes = {}
  plugin.registerWithRouter({ get: (p, fn) => { routes[p] = fn } })
  plugin.start(settings)
  const call = (route, query = {}) => new Promise((resolve) => {
    const res = { code: 200, status (c) { this.code = c; return this }, json (b) { resolve({ code: this.code, body: b }) }, type () { return this }, sendFile (f) { resolve({ code: 200, file: f }) } }
    routes[route]({ query }, res)
  })
  return { app, plugin, call }
}

describe('config endpoint', () => {
  it('follows the WMO plugin settings and design.airHeight', async () => {
    const { call, app } = setup({ wmo: { sourcePath: 'environment.wind.speedOverGround', airHeightOffset: 0.6 } })
    const { body } = await call('/api/config')
    assert.equal(body.wmoInstalled, true)
    assert.equal(body.meanPath, 'environment.wind.speedOverGroundMeanWMO')
    assert.equal(body.gustPath, 'environment.wind.gustOverGroundWMO')
    assert.equal(body.dirPath, 'environment.wind.directionOverGroundMeanWMO')
    assert.equal(body.rawDirPath, 'environment.wind.directionTrue')
    assert.equal(body.height, 29.4)
    assert.equal(body.exponent, 0.11)
    assert.ok(Math.abs(body.heightFactor - Math.pow(10 / 29.4, 0.11)) < 1e-12)
    assert.ok(body.models.length > 10)
    assert.match(app.status, /speedOverGroundMeanWMO/)
  })

  it('uses water-referenced paths when the WMO plugin does', async () => {
    const { call } = setup({ wmo: { sourcePath: 'environment.wind.speedTrue', sensorHeight: 20, profileExponent: 0.143 } })
    const { body } = await call('/api/config')
    assert.equal(body.meanPath, 'environment.wind.speedTrueMeanWMO')
    assert.equal(body.height, 20)
    assert.equal(body.exponent, 0.143)
  })

  it('works without the WMO plugin', async () => {
    const { call } = setup({})
    const { body } = await call('/api/config')
    assert.equal(body.wmoInstalled, false)
    assert.equal(body.height, 29.7)
  })

  it('converts the stationary threshold to m/s', async () => {
    const { call } = setup({ settings: { stationaryKnots: 1 } })
    assert.ok(Math.abs((await call('/api/config')).body.stationaryMs - 0.514444) < 1e-9)
  })
})

describe('forecast endpoint', () => {
  it('rejects a missing position', async () => {
    const { call } = setup({})
    assert.equal((await call('/api/forecast', {})).code, 400)
    assert.equal((await call('/api/models', { lat: 'x', lon: 2 })).code, 400)
  })
})

describe('static files', () => {
  it('serves the shared logic and Chart.js from the package', async () => {
    const { call } = setup({})
    assert.ok(fs.existsSync((await call('/verify.js')).file))
    assert.ok(fs.existsSync((await call('/chart.js')).file))
  })
})
