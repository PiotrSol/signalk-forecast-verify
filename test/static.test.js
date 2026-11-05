'use strict'
const { it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
it('keeps the web app copy of the shared logic in sync (run npm run build)', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify.js'), 'utf8')
  const b = fs.readFileSync(path.join(__dirname, '..', 'public', 'verify.js'), 'utf8')
  assert.equal(a, b)
})
it('ships Chart.js with the web app', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'vendor', 'chart.umd.min.js')))
})
