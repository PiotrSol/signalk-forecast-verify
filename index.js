/*
 * signalk-forecast-verify
 *
 * Compares the wind a vessel measured, as WMO 10-minute mean and gust (from
 * signalk-wmo-gust, read through the Signal K History API), with what weather
 * models forecast for the same hours and positions (from Open-Meteo).
 *
 * The server side provides:
 *   GET /plugins/signalk-forecast-verify/api/config    paths and height factor
 *   GET /plugins/signalk-forecast-verify/api/models    models with data at a position
 *   GET /plugins/signalk-forecast-verify/api/forecast  forecast series at a position
 *   GET /plugins/signalk-forecast-verify/verify.js     shared logic for the web app
 *   GET /plugins/signalk-forecast-verify/chart.js      Chart.js, served locally so
 *                                                       the app works without internet
 * The web app itself is in public/ and is served by the Signal K server.
 *
 * SPDX-License-Identifier: MIT
 */

'use strict'

const fs = require('fs')
const path = require('path')
const { createClient, MODELS } = require('./lib/openmeteo')
const V = require('./lib/verify')

const DEFAULT_EXPONENT = 0.11
const DEFAULT_OFFSET = 0.3

module.exports = function (app) {
  const plugin = {
    id: 'signalk-forecast-verify',
    name: 'Wind Forecast Check',
    description: 'Compares measured WMO wind and gust with forecasts from many weather models'
  }

  let client = null
  let settings = {}

  plugin.schema = {
    type: 'object',
    properties: {
      stationaryKnots: {
        type: 'number',
        title: 'Stationary below (kn)',
        description: 'Hours with a highest SOG below this count as moored or at anchor, where measurement is most reliable.',
        default: 0.5
      },
      sensorHeight: {
        type: 'number',
        title: 'Anemometer height (m), for back-filled history',
        description: 'Used to correct raw wind recorded before the WMO plugin was installed. Leave empty to use the WMO plugin settings, or design.airHeight.'
      }
    }
  }

  /** The WMO plugin's saved settings, if it is installed. */
  function wmoSettings () {
    try {
      const dir = (app.config && app.config.configPath) || path.join(require('os').homedir(), '.signalk')
      const file = path.join(dir, 'plugin-config-data', 'signalk-wmo-gust.json')
      return JSON.parse(fs.readFileSync(file, 'utf8')).configuration || {}
    } catch (err) {
      return null
    }
  }

  function currentConfig () {
    const wmo = wmoSettings()
    const src = (wmo && wmo.sourcePath) || 'environment.wind.speedOverGround'
    const paths = V.wmoPaths(src)
    const exponent = wmo && typeof wmo.profileExponent === 'number' ? wmo.profileExponent : DEFAULT_EXPONENT
    const offset = wmo && typeof wmo.airHeightOffset === 'number' ? wmo.airHeightOffset : DEFAULT_OFFSET

    let height = null
    let heightSource = 'unknown'
    if (settings.sensorHeight > 0) {
      height = settings.sensorHeight; heightSource = 'Wind Forecast Check setting'
    } else if (wmo && wmo.sensorHeight > 0) {
      height = wmo.sensorHeight; heightSource = 'WMO plugin setting'
    } else {
      let air = app.getSelfPath('design.airHeight')
      if (air && typeof air === 'object') air = air.value
      if (typeof air === 'number' && air - offset > 0) {
        height = air - offset; heightSource = `design.airHeight ${air} m − ${offset} m`
      }
    }
    return {
      wmoInstalled: wmo !== null,
      sourcePath: src,
      meanPath: paths.mean,
      gustPath: paths.gust,
      dirPath: paths.dir,
      rawPath: src,
      rawDirPath: (wmo && wmo.directionPath) || 'environment.wind.directionTrue',
      dirMinMs: 1.5,
      exponent,
      height,
      heightSource,
      heightFactor: height ? V.heightFactor(height, exponent) : 1,
      stationaryMs: (settings.stationaryKnots > 0 ? settings.stationaryKnots : 0.5) * 0.514444,
      models: MODELS
    }
  }

  const number = (v, lo, hi, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt
  }

  plugin.registerWithRouter = function (router) {
    router.get('/api/config', (req, res) => {
      res.json(currentConfig())
    })

    router.get('/api/models', async (req, res) => {
      if (!client) return res.status(503).json({ error: 'Plugin not started' })
      const lat = number(req.query.lat, -90, 90, null)
      const lon = number(req.query.lon, -180, 180, null)
      if (lat === null || lon === null) return res.status(400).json({ error: 'lat and lon are required' })
      try {
        const cell = V.cellOf({ lat, lon })
        const ids = await client.availableModels(cell)
        res.json({ cell, models: client.MODELS.filter((m) => ids.includes(m.id)) })
      } catch (err) {
        res.status(502).json({ error: err.message })
      }
    })

    router.get('/api/forecast', async (req, res) => {
      if (!client) return res.status(503).json({ error: 'Plugin not started' })
      const lat = number(req.query.lat, -90, 90, null)
      const lon = number(req.query.lon, -180, 180, null)
      if (lat === null || lon === null) return res.status(400).json({ error: 'lat and lon are required' })
      const lead = number(req.query.lead, 0, 2, 0)
      const pastDays = Math.round(number(req.query.pastDays, 0, 14, 3))
      const forecastDays = Math.round(number(req.query.forecastDays, 1, 7, 2))
      try {
        const cell = V.cellOf({ lat, lon })
        const data = await client.forecast(cell, { lead, pastDays, forecastDays })
        res.json({ cell, lead, ...data })
      } catch (err) {
        app.debug(`forecast ${lat},${lon} lead ${lead}: ${err.message}`)
        res.status(502).json({ error: `Open-Meteo: ${err.message}` })
      }
    })

    router.get('/verify.js', (req, res) => {
      res.type('application/javascript').sendFile(path.join(__dirname, 'lib', 'verify.js'))
    })

    router.get('/chart.js', (req, res) => {
      const dist = path.dirname(require.resolve('chart.js'))
      res.type('application/javascript').sendFile(path.join(dist, 'chart.umd.min.js'))
    })
  }

  plugin.start = function (options) {
    settings = options || {}
    client = createClient({ debug: (m) => app.debug(m) })
    const cfg = currentConfig()
    app.setPluginStatus(
      cfg.wmoInstalled
        ? `Reading ${cfg.meanPath} and ${cfg.gustPath}`
        : 'signalk-wmo-gust not found: only back-filled mean wind is available'
    )
  }

  plugin.stop = function () {
    client = null
  }

  return plugin
}
