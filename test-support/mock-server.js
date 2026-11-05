// Mock Signal K server for UI testing: serves public/, the plugin router, a
// synthetic History API and a synthetic Open-Meteo (via the plugin's client).
const http = require('http'); const fs = require('fs'); const path = require('path')
const H = 3600000; const now = Date.now()
const wind = (t) => 5 + 2.5 * Math.sin(t / (6 * H)) + 1.2 * Math.sin(t / (1.3 * H))
const dirOf = (t) => (360 + 20 + 60 * Math.sin(t / (9 * H))) % 360 // swings across north
// Patch fetch for Open-Meteo: models = biased versions of the truth.
const bias = { ecmwf_ifs: 0.3, gfs_global: 1.4, icon_eu: -0.6, meteofrance_arome_france_hd: 0.1, ukmo_global_deterministic_10km: 0.8, ecmwf_aifs025_single: -1.0 }
globalThis.fetch = async (url) => {
  const u = new URL(url); const models = u.searchParams.get('models').split(',')
  if (models.some((m) => !(m in bias))) return { ok: false, status: 400, json: async () => ({ error: true, reason: 'No data is available for this location' }) }
  const lead = u.hostname.startsWith('previous') ? 1 : 0; const sfx = lead ? '_previous_day1' : ''
  const past = +u.searchParams.get('past_days'); const fut = +u.searchParams.get('forecast_days')
  const start = Math.floor(now / 86400000) * 86400000 - past * 86400000; const n = (past + fut) * 24
  const hourly = { time: [] }
  for (let i = 0; i < n; i++) hourly.time.push(new Date(start + i * H).toISOString().slice(0, 16))
  models.forEach((m) => {
    const k = models.length === 1 ? '' : '_' + m
    hourly['wind_speed_10m' + sfx + k] = hourly.time.map((s) => +(wind(Date.parse(s + 'Z')) + bias[m] * (lead ? 1.5 : 1)).toFixed(2))
    hourly['wind_direction_10m' + sfx + k] = hourly.time.map((s) => +((dirOf(Date.parse(s + 'Z')) + bias[m] * 8 + 360) % 360).toFixed(0))
    hourly['wind_gusts_10m' + sfx + k] = m === 'ecmwf_aifs025_single' ? hourly.time.map(() => null) : hourly.time.map((s) => +(1.45 * wind(Date.parse(s + 'Z')) + bias[m]).toFixed(2))
  })
  return { ok: true, status: 200, json: async () => ({ hourly }) }
}
const routes = {}
const router = { get: (p, fn) => { routes[p] = fn } }
const app = { debug: () => {}, error: console.error, setPluginStatus: () => {}, config: { configPath: '/tmp/skcfg' }, getSelfPath: () => ({ value: 30 }) }
const plugin = require('../index.js')(app); plugin.registerWithRouter(router); plugin.start({})
const gustStart = now - 11 * H
function historyResp (q) {
  const paths = q.get('paths').split(','); const from = Date.parse(q.get('from')); const to = Date.parse(q.get('to')); const res = +q.get('resolution') * 1000
  const values = paths.map((p) => { const [path, method] = p.split(':'); return { path, method } })
  const data = []
  for (let t = from; t < to; t += res) {
    const row = [new Date(t).toISOString()]
    for (const v of values) {
      const mid = t + res
      if (v.path.endsWith('directionOverGroundMeanWMO')) row.push(mid > now - 30 * H ? dirOf(mid) * Math.PI / 180 : null)
      else if (v.path.endsWith('MeanWMO')) row.push(mid > now - 30 * H ? wind(mid) * 0.89 : null)
      else if (v.path.includes('gust')) row.push(t > gustStart ? wind(mid) * 1.4 : null)
      else if (v.path === 'environment.wind.directionTrue') row.push(dirOf(t + 30000) * Math.PI / 180)
      else if (v.path === 'environment.wind.speedOverGround') row.push(wind(mid))
      else if (v.path === 'navigation.speedOverGround') row.push(0.1)
      else if (v.path === 'navigation.position') row.push([1.9273, 41.2604])
      else row.push(null)
    }
    data.push(row)
  }
  return { values, data }
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) }
  if (u.pathname === '/signalk/v2/api/history/values') return send(200, historyResp(u.searchParams))
  if (u.pathname === '/signalk/v1/api/vessels/self/navigation/position') return send(200, { value: { latitude: 41.2604, longitude: 1.9273 } })
  const pp = '/plugins/signalk-forecast-verify'
  if (u.pathname.startsWith(pp)) {
    const fn = routes[u.pathname.slice(pp.length)]
    if (!fn) return send(404, {})
    const r = { status (c) { this.c = c; return this }, json (b) { send(this.c || 200, b) }, type (t) { this.t = t; return this }, sendFile (f) { send(200, fs.readFileSync(f), this.t) } }
    return fn({ query: Object.fromEntries(u.searchParams) }, r)
  }
  const file = path.join(__dirname, '..', 'public', u.pathname === '/' ? 'index.html' : u.pathname)
  if (fs.existsSync(file)) return send(200, fs.readFileSync(file), file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'text/html')
  send(404, 'not found', 'text/plain')
}).listen(8765, () => console.log('mock on 8765'))
