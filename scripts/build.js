// Copies the browser files into public/; plain Node so it runs on every OS.
'use strict'
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const vendor = path.join(root, 'public', 'vendor')
fs.mkdirSync(vendor, { recursive: true })
const chart = path.join(root, 'node_modules', 'chart.js')
fs.copyFileSync(path.join(root, 'lib', 'verify.js'), path.join(root, 'public', 'verify.js'))
fs.copyFileSync(path.join(chart, 'dist', 'chart.umd.min.js'), path.join(vendor, 'chart.umd.min.js'))
fs.copyFileSync(path.join(chart, 'LICENSE.md'), path.join(vendor, 'chart.js-LICENSE.md'))
