/**
 * Visual-token guard for the usage kit.
 *
 * Same rules the balance guard enforces: no raw colours, radii only from the
 * theme scale (plus pill 50%), type sizes only from the shipped scale, no
 * infinite animation. The two widgets are tiny, so the rules are strict on
 * purpose.
 *
 * Usage: node scripts/visual-tokens.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(resolve(HERE, '..'), 'src', 'client.js')
const source = readFileSync(CLIENT, 'utf8')

const stylesMatch = /const STYLES = `([\s\S]*?)`\n/.exec(source)
if (stylesMatch === null) throw new Error('could not locate the STYLES template in src/client.js')
const css = stylesMatch[1]
console.log(`[visual] stylesheet: ${css.length} bytes`)

let checks = 0
const failures = []

function assert(label, condition, detail) {
  checks += 1
  if (!condition) failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

const rawHex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match => match[0])
assert('no raw hex colours', rawHex.length === 0, rawHex.slice(0, 5).join(', '))
const rawRgb = [...css.matchAll(/\brgba?\s*\(/g)].map(match => match[0])
assert('no raw rgb() colours', rawRgb.length === 0, rawRgb.slice(0, 5).join(', '))
const rawHsl = [...css.matchAll(/\bhsla?\s*\(/g)].map(match => match[0])
assert('no raw hsl() colours', rawHsl.length === 0, rawHsl.slice(0, 5).join(', '))

const colorDeclarations = [...css.matchAll(/(?:background|background-color|color|box-shadow)\s*:\s*([^;}]+)/g)]
  .map(match => match[1].trim())
  .filter(value => !/^(none|transparent|inherit)$/.test(value))
for (const value of colorDeclarations) {
  assert('colour declaration uses tokens', value.includes('var(--dsw-'), value)
}

const radii = [...css.matchAll(/border-radius\s*:\s*([^;}]+)/g)].map(match => match[1].trim())
for (const value of radii) {
  assert('radius uses the theme scale', /^(50%|999px|var\(--dsw-radius-[a-z]+\))$/.test(value), value)
}

const fontSizes = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(match => match[1].trim())
for (const value of fontSizes) {
  assert('font size is part of the type scale', /^(11px|12px|13px|16px)$/.test(value), value)
}

assert('no @keyframes', !/@keyframes/.test(css))
assert('no infinite animation', !/animation\s*:\s*[^;]*infinite/.test(css))
assert('reduced motion is honoured', css.includes('prefers-reduced-motion'))

if (failures.length > 0) {
  console.error(`\n[visual] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[visual] ${checks} checks passed`)
console.log('[visual] OK')
