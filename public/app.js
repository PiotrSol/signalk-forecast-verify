/* eslint-env browser */
/* global Chart, Verify */
'use strict'

const API = '/plugins/signalk-forecast-verify/api'
const HISTORY = '/signalk/v2/api/history/values'
const UNITS = {
  kn: { factor: 1.943844, label: 'kn', digits: 1 },
  ms: { factor: 1, label: 'm/s', digits: 1 },
  kmh: { factor: 3.6, label: 'km/h', digits: 0 }
}
const MAX_CELLS = 24
const MIN_SCORED_HOURS = 6

// Model line colours on the day and dark charts; the night chart uses reds only.
const PALETTE = ['#1d6fa5', '#d4851c', '#3f8f4f', '#7a4fa8', '#a33b3b', '#2b9a9a', '#8a6d1c',
  '#c25a92', '#4d6e8c', '#6b8f2a', '#9c5a2e', '#3d5fbf', '#8c3f6e', '#2f7d6d', '#b06a00',
  '#5a5a9c', '#7f7f3a', '#a14d4d']
const NIGHT = ['#b5352a', '#8f271c', '#c8503c', '#7a2016', '#a8432f', '#6a1a12']
const DASHES = [[], [6, 3], [2, 3], [10, 3, 2, 3]]

const $ = (id) => document.getElementById(id)
const state = { config: null, charts: {}, hidden: loadHidden(), data: null }

function loadHidden () {
  try { return new Set(JSON.parse(localStorage.getItem('fcv-hidden') || '[]')) } catch (e) { return new Set() }
}
function saveHidden () {
  try { localStorage.setItem('fcv-hidden', JSON.stringify([...state.hidden])) } catch (e) { /* private mode */ }
}

// ---------------------------------------------------------------- formatting

const fmtTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: '2-digit' })
const fmtHour = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function units () { return UNITS[$('units').value] || UNITS.kn }
function speed (ms, signed = false) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '–'
  const u = units()
  const v = (ms * u.factor).toFixed(u.digits)
  return signed && ms > 0 ? `+${v}` : v
}
function latLon (p) {
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`
  return `${f(p.lat, 'N', 'S')}, ${f(p.lon, 'E', 'W')}`
}

// ---------------------------------------------------------------- data

async function getJson (url) {
  const res = await fetch(url, { credentials: 'same-origin' })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) {
    const err = new Error('Log in to the Signal K server first (Login, top right of the Signal K admin), then reload this page.')
    err.auth = true
    throw err
  }
  if (!res.ok) throw new Error(body.error || body.message || `${res.status} ${res.statusText}`)
  return body
}

function history (paths, fromMs, toMs, resolutionS) {
  const q = new URLSearchParams({
    paths: paths.join(','),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    resolution: String(resolutionS)
  })
  return getJson(`${HISTORY}?${q}`)
}

async function currentPosition () {
  try {
    const p = await getJson('/signalk/v1/api/vessels/self/navigation/position')
    return Verify.toPosition(p.value || p)
  } catch (e) {
    return null
  }
}

/** Groups hours into forecast cells, coarsening the grid until there are few enough. */
function assignCells (rows, fallback) {
  for (const step of [0.05, 0.25, 0.5, 1]) {
    const cells = new Map()
    let last = fallback
    for (const r of rows) {
      const p = r.position || last
      if (!p) continue
      last = p
      const c = Verify.cellOf(p, step)
      r.cell = c.key
      if (!cells.has(c.key)) cells.set(c.key, c)
    }
    if (cells.size <= MAX_CELLS) return cells
  }
  return new Map()
}

async function load () {
  const days = Number($('period').value)
  const lead = Number($('lead').value)
  const cfg = state.config
  const now = Date.now()
  const fromMs = Math.ceil((now - days * 86400000) / Verify.HOUR) * Verify.HOUR
  const toMs = now

  const [tenMin, hourly, oneMin, here] = await Promise.all([
    history([`${cfg.meanPath}:last`, `${cfg.rawPath}:average`, `${cfg.dirPath}:last`], fromMs - Verify.TEN_MIN, toMs, 600),
    history([`${cfg.gustPath}:max`, 'navigation.speedOverGround:max', 'navigation.position:first'], fromMs - Verify.HOUR, toMs, 3600),
    // One-minute raw samples, to back-fill the direction from before the WMO plugin had one.
    history([`${cfg.rawPath}:average`, `${cfg.rawDirPath}:last`], fromMs - Verify.TEN_MIN, toMs, 60).catch(() => null),
    currentPosition()
  ])

  const rows = Verify.measuredHours({
    tenMin,
    hourly,
    oneMin,
    dirPath: cfg.dirPath,
    rawDirPath: cfg.rawDirPath,
    meanPath: cfg.meanPath,
    rawPath: cfg.rawPath,
    gustPath: cfg.gustPath,
    heightFactor: cfg.heightFactor,
    fromMs,
    toMs
  })
  const lastPos = [...rows].reverse().find((r) => r.position)
  const position = here || (lastPos && lastPos.position)
  if (!position) throw new Error('The vessel position is not known, so no forecast can be fetched. Check navigation.position.')

  const cells = assignCells(rows, position)
  const nowCell = Verify.cellOf(position)
  if (!cells.has(nowCell.key)) cells.set(nowCell.key, nowCell)

  const forecasts = new Map()
  await Promise.all([...cells.values()].map(async (c) => {
    const q = new URLSearchParams({ lat: c.lat, lon: c.lon, lead, pastDays: days + 1, forecastDays: lead === 0 ? 2 : 1 })
    forecasts.set(c.key, await getJson(`${API}/forecast?${q}`))
  }))

  // Every model that any cell returned, in catalogue order.
  const seen = new Set()
  for (const f of forecasts.values()) Object.keys(f.models || {}).forEach((m) => seen.add(m))
  const models = cfg.models.filter((m) => seen.has(m.id))

  const valueAt = (f, model, kind, t) => {
    if (!f || !f.models[model]) return null
    if (!f._index) f._index = new Map(f.times.map((x, i) => [x, i]))
    const i = f._index.get(t)
    return i === undefined ? null : f.models[model][kind][i]
  }

  // Past: each hour from the forecast of the cell the vessel was in.
  for (const r of rows) {
    r.f = {}
    const f = forecasts.get(r.cell)
    for (const m of models) r.f[m.id] = { mean: valueAt(f, m.id, 'mean', r.t), gust: valueAt(f, m.id, 'gust', r.t), dir: valueAt(f, m.id, 'dir', r.t) }
  }

  // Future (latest runs only): at the present position.
  const future = []
  if (lead === 0) {
    const f = forecasts.get(nowCell.key)
    for (const t of (f && f.times) || []) {
      if (t <= toMs) continue
      const e = { t, f: {} }
      for (const m of models) e.f[m.id] = { mean: valueAt(f, m.id, 'mean', t), gust: valueAt(f, m.id, 'gust', t), dir: valueAt(f, m.id, 'dir', t) }
      future.push(e)
    }
  }

  return { rows, future, models, position, cells: cells.size, fromMs, toMs, lead, days }
}

// ---------------------------------------------------------------- scoring

function scoreModels (data) {
  const onlyStationary = $('stationary').checked
  const lim = state.config.stationaryMs
  const scored = data.rows.filter((r) => !onlyStationary || (r.sogMax !== null && r.sogMax < lim))
  const out = data.models.map((m) => ({
    model: m,
    mean: Verify.score(scored.map((r) => ({ f: r.f[m.id].mean, o: r.mean }))),
    gust: Verify.score(scored.map((r) => ({ f: r.f[m.id].gust, o: r.gust }))),
    // Direction only where there is enough wind for it to mean something.
    dir: Verify.scoreDirection(scored.filter((r) => r.mean !== null && r.mean >= state.config.dirMinMs)
      .map((r) => ({ f: r.f[m.id].dir, o: r.dir })))
  }))
  out.sort((a, b) => (a.mean.n >= MIN_SCORED_HOURS ? a.mean.mae : Infinity) - (b.mean.n >= MIN_SCORED_HOURS ? b.mean.mae : Infinity))
  return { scores: out, scoredHours: scored.length }
}

// ---------------------------------------------------------------- drawing

function css (name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() }
function isNight () { return document.documentElement.dataset.theme === 'night' }
function modelStyle (i) {
  return isNight()
    ? { color: NIGHT[i % NIGHT.length], dash: DASHES[i % DASHES.length] }
    : { color: PALETTE[i % PALETTE.length], dash: DASHES[Math.floor(i / PALETTE.length) % DASHES.length] }
}

/** Tick values on local midnights, or on 3 or 6-hour marks of local time. */
function alignedTicks (min, max, step) {
  const ticks = []
  const d = new Date(min)
  d.setMinutes(0, 0, 0)
  const hours = step / Verify.HOUR
  while (d.getTime() < min || d.getHours() % Math.min(hours, 24) !== 0) d.setHours(d.getHours() + 1)
  let t = d.getTime()
  while (t <= max) {
    ticks.push({ value: t })
    const n = new Date(t)
    n.setHours(n.getHours() + hours) // calendar steps stay on the hour across DST changes
    t = n.getTime()
  }
  return ticks
}

// Marks the present moment and shades the forecast still to come.
const nowPlugin = {
  id: 'now',
  beforeDatasetsDraw (chart, args, opts) {
    const x = chart.scales.x
    const { top, bottom, right } = chart.chartArea
    const px = x.getPixelForValue(opts.now)
    if (px < chart.chartArea.left || px > right) return
    const ctx = chart.ctx
    ctx.save()
    ctx.fillStyle = opts.shade
    ctx.fillRect(px, top, right - px, bottom - top)
    ctx.strokeStyle = opts.line
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke()
    ctx.fillStyle = opts.line
    ctx.font = `600 12px ${css('--sans')}`
    ctx.fillText('now', px + 4, top + 12)
    ctx.restore()
  }
}

function drawChart (canvasId, kind, data) {
  const u = units()
  const ink = css('--ink')
  const soft = css('--ink-soft')
  const rule = css('--rule')
  const conv = (v) => (v === null ? null : v * u.factor)

  const measuredColour = isNight() ? css('--magenta') : ink
  const measured = {
    label: 'Measured (WMO)',
    data: data.rows.map((r) => ({ x: r.t, y: conv(r[kind]), bf: kind === 'mean' && r.meanBackfilled })),
    borderColor: measuredColour,
    backgroundColor: measuredColour,
    borderWidth: isNight() ? 4 : 3,
    pointRadius: 0,
    spanGaps: false,
    segment: { borderDash: (ctx) => (ctx.p1 && ctx.p1.raw && ctx.p1.raw.bf ? [5, 4] : undefined) },
    order: 0
  }
  const sets = data.models.map((m, i) => {
    const s = modelStyle(i)
    const pts = data.rows.map((r) => ({ x: r.t, y: conv(r.f[m.id][kind]) }))
      .concat(data.future.map((e) => ({ x: e.t, y: conv(e.f[m.id][kind]) })))
    return {
      label: m.label,
      modelId: m.id,
      data: pts,
      borderColor: s.color,
      backgroundColor: s.color,
      borderDash: s.dash,
      borderWidth: 1.5,
      pointRadius: 0,
      spanGaps: false,
      hidden: state.hidden.has(m.id) || pts.every((p) => p.y === null),
      order: 1
    }
  })

  const span = data.toMs - data.fromMs + data.future.length * Verify.HOUR
  const step = span > 4 * 86400000 ? 86400000 : span > 36 * Verify.HOUR ? 6 * Verify.HOUR : 3 * Verify.HOUR
  const config = {
    type: 'line',
    data: { datasets: [measured, ...sets] },
    options: {
      parsing: false,
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: data.fromMs,
          max: data.future.length ? data.future[data.future.length - 1].t : data.toMs,
          afterBuildTicks: (scale) => { scale.ticks = alignedTicks(scale.min, scale.max, step) },
          ticks: {
            color: soft,
            maxRotation: 0,
            autoSkip: true,
            callback: (v) => (new Date(v).getHours() === 0 ? fmtDay.format(v) : fmtHour.format(v))
          },
          grid: { color: rule }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: u.label, color: soft },
          ticks: { color: soft },
          grid: { color: rule }
        }
      },
      plugins: {
        now: { now: data.toMs, line: css('--magenta'), shade: isNight() ? 'rgba(255,74,51,0.06)' : 'rgba(176,40,122,0.06)' },
        legend: {
          position: 'bottom',
          labels: { color: ink, boxWidth: 18, boxHeight: 2, usePointStyle: false },
          onClick: (e, item, legend) => {
            const ds = legend.chart.data.datasets[item.datasetIndex]
            if (!ds.modelId) return
            if (state.hidden.has(ds.modelId)) state.hidden.delete(ds.modelId); else state.hidden.add(ds.modelId)
            saveHidden()
            render()
          }
        },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? fmtTime.format(items[0].parsed.x) : ''),
            label: (item) => `${item.dataset.label}: ${item.parsed.y === null ? '–' : item.parsed.y.toFixed(u.digits)} ${u.label}`
          }
        }
      }
    },
    plugins: [nowPlugin]
  }
  if (state.charts[canvasId]) state.charts[canvasId].destroy()
  state.charts[canvasId] = new Chart($(canvasId), config)
}

const COMPASS = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 360: 'N' }

function drawDirChart (canvasId, data) {
  const ink = css('--ink')
  const soft = css('--ink-soft')
  const rule = css('--rule')
  const measuredColour = isNight() ? css('--magenta') : ink
  const measured = {
    label: 'Measured (WMO)',
    data: data.rows.filter((r) => r.dir !== null).map((r) => ({ x: r.t, y: r.dir, bf: r.dirBackfilled })),
    borderColor: measuredColour,
    backgroundColor: measuredColour,
    showLine: false,
    pointRadius: (ctx) => (ctx.raw && ctx.raw.bf ? 2.5 : 3.5),
    pointStyle: (ctx) => (ctx.raw && ctx.raw.bf ? 'circle' : 'rectRot'),
    order: 0
  }
  const sets = data.models.map((m, i) => {
    const s = modelStyle(i)
    const pts = data.rows.map((r) => ({ x: r.t, y: r.f[m.id].dir }))
      .concat(data.future.map((e) => ({ x: e.t, y: e.f[m.id].dir })))
      .filter((p) => p.y !== null)
    return {
      label: m.label,
      modelId: m.id,
      data: pts,
      borderColor: s.color,
      backgroundColor: s.color,
      showLine: false,
      pointRadius: 1.6,
      hidden: state.hidden.has(m.id) || pts.length === 0,
      order: 1
    }
  })
  const meanOpts = state.charts.meanChart.options
  const base = { ...meanOpts.scales.x, ticks: { ...meanOpts.scales.x.ticks }, grid: { ...meanOpts.scales.x.grid } }
  const config = {
    type: 'line',
    data: { datasets: [measured, ...sets] },
    options: {
      parsing: false,
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: base,
        y: {
          min: 0,
          max: 360,
          ticks: { stepSize: 90, color: soft, callback: (v) => COMPASS[v] || `${v}°` },
          grid: { color: rule }
        }
      },
      plugins: {
        now: { ...meanOpts.plugins.now },
        legend: { ...meanOpts.plugins.legend, labels: { ...meanOpts.plugins.legend.labels } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? fmtTime.format(items[0].parsed.x) : ''),
            label: (item) => `${item.dataset.label}: ${String(Math.round(item.parsed.y) % 360).padStart(3, '0')}°`
          }
        }
      }
    },
    plugins: [nowPlugin]
  }
  if (state.charts[canvasId]) state.charts[canvasId].destroy()
  state.charts[canvasId] = new Chart($(canvasId), config)
}

function degCell (s, signed) {
  if (!s.n) return '<td class="none">–</td>'
  if (!signed) return `<td>${Math.round(s.mae)}°</td>`
  const cls = Math.abs(s.bias) < 10 ? '' : s.bias > 0 ? 'high' : 'low'
  const word = cls === 'high' ? 'Veers: forecast direction clockwise of measured' : cls === 'low' ? 'Backs: forecast direction anticlockwise of measured' : 'No clear bias'
  return `<td class="${cls}" title="${word}">${s.bias > 0 ? '+' : ''}${Math.round(s.bias)}°</td>`
}

function biasCell (s) {
  if (!s.n) return '<td class="none">–</td>'
  const cls = Math.abs(s.bias) < 0.25 ? '' : s.bias > 0 ? 'high' : 'low'
  const word = cls === 'high' ? ' high' : cls === 'low' ? ' low' : ''
  return `<td class="${cls}" title="${word ? `Runs${word}` : 'No clear bias'}">${speed(s.bias, true)}</td>`
}

function drawTable (scored, data) {
  const body = $('scores').tBodies[0]
  body.innerHTML = ''
  let bestDone = false
  scored.scores.forEach(({ model, mean, gust, dir }) => {
    const i = data.models.indexOf(model)
    const s = modelStyle(i)
    const tr = document.createElement('tr')
    if (!bestDone && mean.n >= MIN_SCORED_HOURS) { tr.className = 'best'; bestDone = true }
    tr.innerHTML = `<td class="model"><span class="model-name"><span class="swatch" style="background:${s.color}"></span>${model.label}</span></td>` +
      biasCell(mean) + `<td>${mean.n ? speed(mean.mae) : '–'}</td>` +
      biasCell(gust) + `<td>${gust.n ? speed(gust.mae) : '–'}</td>` +
      degCell(dir, true) + degCell(dir, false) +
      `<td>${mean.n} / ${gust.n} / ${dir.n}</td>`
    body.appendChild(tr)
  })
  const u = units().label
  $('score-explain').textContent = `Forecast minus measured, in ${u}, over ${scored.scoredHours} scored hours` +
    `${$('stationary').checked ? ' when moored or at anchor' : ''}. Bias shows whether a model runs high or low; average error is how far off it is, either way.` +
    ` Direction is scored only with at least ${speed(state.config.dirMinMs)} ${u} of measured wind; + means the forecast direction is veered (clockwise) from the measured one.` +
    ` Models are ranked by mean-wind error once they have ${MIN_SCORED_HOURS} hours.`
}

function drawNotes (data) {
  const cfg = state.config
  const notes = []
  const firstGust = data.rows.find((r) => r.gust !== null)
  const backfilled = data.rows.filter((r) => r.meanBackfilled).length
  if (cfg.height) {
    notes.push(`Measured wind is corrected to 10 m from the anemometer at ${cfg.height.toFixed(1)} m (${cfg.heightSource}), with a profile exponent of ${cfg.exponent}.`)
  } else {
    notes.push('The anemometer height is not known, so raw history is not height-corrected. Set design.airHeight or a height in the plugin settings.')
  }
  const dirBf = data.rows.filter((r) => r.dirBackfilled).length
  if (dirBf) notes.push(`${dirBf} hours of direction (round markers) are vector means of one-minute raw ${cfg.rawDirPath} samples, from before the WMO plugin published a mean direction.`)
  if (!data.rows.some((r) => r.dir !== null)) notes.push(`No measured direction in this period: check ${cfg.dirPath} or ${cfg.rawDirPath}.`)
  if (backfilled) notes.push(`${backfilled} hours of mean wind (dashed) come from raw ${cfg.rawPath} records from before the WMO plugin was running.`)
  if (firstGust) {
    if (firstGust.t > data.fromMs) notes.push(`Measured gusts start at ${fmtTime.format(firstGust.t)}. Raw history is sampled too sparsely to derive a WMO 3-second gust.`)
  } else {
    notes.push(`No measured gusts in this period: ${cfg.gustPath} has no history yet.`)
  }
  const noGust = data.models.filter((m) => data.rows.concat(data.future).every((r) => r.f[m.id].gust === null)).map((m) => m.label)
  if (noGust.length) notes.push(`No gust forecast from ${noGust.join(', ')}.`)
  const absent = data.models.filter((m) => data.rows.every((r) => r.f[m.id].mean === null)).map((m) => m.label)
  if (absent.length && data.lead > 0) notes.push(`No ${data.lead}-day-ahead runs from ${absent.join(', ')} for this period: their forecasts do not reach that far.`)
  if (data.cells > 1) notes.push(`The vessel moved through ${data.cells} forecast cells; each hour is compared with the forecast for where the vessel was.`)
  notes.push('Forecast gusts are maxima of the preceding hour. Measured wind under way also depends on heading, SOG and COG accuracy; moored and at-anchor hours are the cleanest comparison.')
  notes.push('Forecast data from Open-Meteo.com (CC BY 4.0), which redistributes the national weather services’ model output.')
  $('notes').innerHTML = notes.map((n) => `<li>${n}</li>`).join('')
}

function render () {
  if (!state.data) return
  drawChart('meanChart', 'mean', state.data)
  drawChart('gustChart', 'gust', state.data)
  drawDirChart('dirChart', state.data)
  drawTable(scoreModels(state.data), state.data)
  drawNotes(state.data)
}

// ---------------------------------------------------------------- start

function message (text) {
  const m = $('message')
  m.hidden = !text
  m.textContent = text || ''
}

async function refresh () {
  message('Fetching history and forecasts…')
  try {
    state.data = await load()
    $('where').textContent = `${latLon(state.data.position)}, ${state.data.models.length} models available here`
    message('')
    render()
  } catch (err) {
    message(err.message)
  }
}

async function init () {
  try {
    const saved = localStorage.getItem('fcv-theme')
    if (saved === 'night') { document.documentElement.dataset.theme = 'night'; $('night').setAttribute('aria-pressed', 'true') }
  } catch (e) { /* private mode */ }

  $('night').addEventListener('click', () => {
    const on = !isNight()
    if (on) document.documentElement.dataset.theme = 'night'; else delete document.documentElement.dataset.theme
    $('night').setAttribute('aria-pressed', String(on))
    try { localStorage.setItem('fcv-theme', on ? 'night' : '') } catch (e) { /* private mode */ }
    render()
  })
  $('period').addEventListener('change', refresh)
  $('lead').addEventListener('change', refresh)
  $('units').addEventListener('change', render)
  $('stationary').addEventListener('change', render)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render)

  try {
    state.config = await getJson(`${API}/config`)
  } catch (err) {
    message(err.auth ? err.message : `The Wind Forecast Check plugin is not running: ${err.message}. Enable it in Server → Plugin Config.`)
    return
  }
  if (!state.config.wmoInstalled) message('signalk-wmo-gust is not installed: only back-filled mean wind can be shown.')
  await refresh()
  setInterval(refresh, 15 * 60000)
}

init()
