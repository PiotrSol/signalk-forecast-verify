'use strict'

/*
 * Open-Meteo client for the forecast comparison.
 *
 *   lead 0  api.open-meteo.com: the latest runs, stitched hour by hour, for the
 *           past (past_days) and the future (forecast_days)
 *   lead d  previous-runs-api.open-meteo.com: what each model forecast d days
 *           before the valid time
 *
 * A request naming a model with no data at the position fails as a whole
 * ("No data is available for this location"), so the models are probed one by
 * one for each forecast cell first, and the result is cached.
 */

const { parseOpenMeteo } = require('./verify')

// Specific models rather than "seamless" blends, so that no model appears twice
// under another name. Regional models drop out where they have no data.
const MODELS = [
  { id: 'ecmwf_ifs', label: 'ECMWF IFS 9 km', centre: 'ECMWF' },
  { id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS (AI)', centre: 'ECMWF' },
  { id: 'gfs_global', label: 'NOAA GFS', centre: 'NOAA' },
  { id: 'ncep_hrrr_conus', label: 'NOAA HRRR (US)', centre: 'NOAA' },
  { id: 'ncep_nam_conus', label: 'NOAA NAM (US)', centre: 'NOAA' },
  { id: 'icon_global', label: 'DWD ICON', centre: 'DWD' },
  { id: 'icon_eu', label: 'DWD ICON-EU', centre: 'DWD' },
  { id: 'icon_d2', label: 'DWD ICON-D2', centre: 'DWD' },
  { id: 'meteofrance_arpege_europe', label: 'Météo-France ARPEGE', centre: 'Météo-France' },
  { id: 'meteofrance_arome_france', label: 'Météo-France AROME', centre: 'Météo-France' },
  { id: 'meteofrance_arome_france_hd', label: 'Météo-France AROME HD', centre: 'Météo-France' },
  { id: 'ukmo_global_deterministic_10km', label: 'UK Met Office', centre: 'UKMO' },
  { id: 'knmi_harmonie_arome_europe', label: 'KNMI HARMONIE', centre: 'KNMI' },
  { id: 'dmi_harmonie_arome_europe', label: 'DMI HARMONIE', centre: 'DMI' },
  { id: 'metno_nordic', label: 'MET Norway Nordic', centre: 'MET Norway' },
  { id: 'gem_global', label: 'GEM (Canada)', centre: 'ECCC' },
  { id: 'jma_seamless', label: 'JMA (Japan)', centre: 'JMA' },
  { id: 'cma_grapes_global', label: 'CMA GRAPES (China)', centre: 'CMA' }
]

const ENDPOINT = {
  0: 'https://api.open-meteo.com/v1/forecast',
  1: 'https://previous-runs-api.open-meteo.com/v1/forecast',
  2: 'https://previous-runs-api.open-meteo.com/v1/forecast'
}

const PROBE_TTL_MS = 24 * 3600000
const FORECAST_TTL_MS = 30 * 60000

function createClient ({ fetchImpl = globalThis.fetch, debug = () => {}, now = () => Date.now() } = {}) {
  const probeCache = new Map() // cell key -> { at, models: [ids] }
  const forecastCache = new Map() // request key -> { at, data }

  async function getJson (url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'signalk-forecast-verify' } })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) {
      const err = new Error(json.reason || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return json
  }

  function url (lead, { lat, lon }, models, { pastDays = 3, forecastDays = 2 } = {}) {
    const sfx = lead > 0 ? `_previous_day${lead}` : ''
    const q = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      hourly: `wind_speed_10m${sfx},wind_gusts_10m${sfx},wind_direction_10m${sfx}`,
      models: models.join(','),
      wind_speed_unit: 'ms',
      timezone: 'GMT',
      past_days: String(pastDays),
      forecast_days: String(lead > 0 ? 1 : forecastDays)
    })
    return `${ENDPOINT[lead]}?${q}`
  }

  /** The models with data at a cell, probed one by one and cached for a day. */
  async function availableModels (cell) {
    const hit = probeCache.get(cell.key)
    if (hit && now() - hit.at < PROBE_TTL_MS) return hit.models
    const results = await Promise.all(MODELS.map(async (m) => {
      try {
        const json = await getJson(url(0, cell, [m.id], { pastDays: 0, forecastDays: 1 }))
        const parsed = parseOpenMeteo(json, [m.id], 0)
        return parsed.models[m.id].mean.some((v) => v !== null) ? m.id : null
      } catch (err) {
        debug(`probe ${m.id} at ${cell.key}: ${err.message}`)
        return null
      }
    }))
    const models = results.filter(Boolean)
    probeCache.set(cell.key, { at: now(), models })
    return models
  }

  /**
   * Forecast series for a cell: { times, models: { id: { mean, gust } } }, m/s.
   * Cached for 30 minutes per cell, lead and window.
   */
  async function forecast (cell, { lead = 0, pastDays = 3, forecastDays = 2 } = {}) {
    if (!ENDPOINT[lead]) throw new Error(`Unsupported lead ${lead}`)
    const key = `${cell.key}|${lead}|${pastDays}|${forecastDays}`
    const hit = forecastCache.get(key)
    if (hit && now() - hit.at < FORECAST_TTL_MS) return hit.data
    const models = await availableModels(cell)
    if (models.length === 0) return { times: [], models: {} }
    const json = await getJson(url(lead, cell, models, { pastDays, forecastDays }))
    const data = parseOpenMeteo(json, models, lead)
    forecastCache.set(key, { at: now(), data })
    return data
  }

  return { MODELS, availableModels, forecast, url }
}

module.exports = { createClient, MODELS }
