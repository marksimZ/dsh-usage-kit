/**
 * Pricing spec — the money math behind a turn receipt, pinned.
 *
 * Plain Node, no framework. A price edit must touch this file too, so the
 * printed ¥ amount can never drift silently from the catalog.
 *
 * Usage: node scripts/pricing-spec.mjs
 */

import {
  DEFAULT_FX, FALLBACK_MODEL, PRICE_TABLE, costOfUsage, emptyUsage, isPeak,
  normalizeUsage, priceFor, toDisplayCurrency, totalTokens, usageDelta,
} from '../src/pricing.js'

let checks = 0
const failures = []

function check(label, actual, expected, tolerance) {
  checks += 1
  const ok = tolerance === undefined
    ? Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
    : Math.abs(actual - expected) <= tolerance
  if (!ok) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function near(label, actual, expected, tolerance = 1e-9) {
  check(label, actual, expected, tolerance)
}

function assert(label, condition) {
  checks += 1
  if (!condition) failures.push(`${label}: condition failed`)
}

// --- catalog ------------------------------------------------------------
near('flash peak cache hit', PRICE_TABLE['deepseek-flash'].peak.cacheHit, 0.006)
near('flash peak cache miss', PRICE_TABLE['deepseek-flash'].peak.cacheMiss, 0.3)
near('flash peak output', PRICE_TABLE['deepseek-flash'].peak.output, 1.2)
near('flash off-peak cache hit', PRICE_TABLE['deepseek-flash'].offPeak.cacheHit, 0.003)
near('pro peak cache miss', PRICE_TABLE['deepseek-v4-pro'].peak.cacheMiss, 1.32)
near('pro off-peak output', PRICE_TABLE['deepseek-v4-pro'].offPeak.output, 1.98)
check('fallback model', FALLBACK_MODEL, 'deepseek-flash')
near('default fx', DEFAULT_FX, 7.2)

// --- peak / off-peak ----------------------------------------------------
const monday = Date.UTC(2026, 9, 19, 2, 0, 0)
check('2026-10-19 is a Monday', new Date(Date.UTC(2026, 9, 19)).getUTCDay(), 1)
check('peak: Monday 02:00 UTC', isPeak(monday), true)
check('off-peak: Monday 05:00 UTC', isPeak(Date.UTC(2026, 9, 19, 5, 0, 0)), false)
check('peak window start', isPeak(Date.UTC(2026, 9, 19, 1, 0, 0)), true)
check('peak window end is exclusive', isPeak(Date.UTC(2026, 9, 19, 4, 0, 0)), false)
check('second peak window', isPeak(Date.UTC(2026, 9, 19, 6, 0, 0)), true)
check('weekend is off-peak', isPeak(Date.UTC(2026, 9, 17, 2, 0, 0)), false)
check('holiday list wins', isPeak(monday, ['2026-10-19']), false)

// --- prices -------------------------------------------------------------
const flashPeak = priceFor('deepseek-flash', true)
check('known model', flashPeak.known, true)
near('peak miss price', flashPeak.cacheMiss, 0.3)
const unknown = priceFor('some-other-model', false)
check('unknown falls back', unknown.model, 'deepseek-flash')
check('unknown reports unknown', unknown.known, false)
near('unknown uses off-peak row', unknown.cacheMiss, 0.15)

// --- billing ------------------------------------------------------------
const millionEach = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 }
near('cost of 1M each at flash peak', costOfUsage(millionEach, PRICE_TABLE['deepseek-flash'].peak), 0.006 + 0.3 + 0.3 + 1.2)
near('cost of 1M each at flash off-peak', costOfUsage(millionEach, PRICE_TABLE['deepseek-flash'].offPeak), 0.003 + 0.15 + 0.15 + 0.6)
near('cost of a small turn', costOfUsage({ uncachedInputTokens: 30_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 25_000 }, PRICE_TABLE['deepseek-flash'].peak), 0.0444)
near('display conversion', toDisplayCurrency(0.5, 7.2), 3.6)
near('display conversion ignores bad fx', toDisplayCurrency(1, 0), DEFAULT_FX)

// --- usage buckets ------------------------------------------------------
near('total tokens', totalTokens({ uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 }), 35)
near('normalize rejects nonsense', normalizeUsage({ outputTokens: -5, cacheReadTokens: 'x' }).outputTokens, 0)
const delta = usageDelta({ uncachedInputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 7 }, { uncachedInputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2 })
near('delta uncached', delta.uncachedInputTokens, 20)
near('delta clamps negative', delta.cacheReadTokens, 0)
near('delta output', delta.outputTokens, 5)
near('empty usage is zero', totalTokens(emptyUsage()), 0)

if (failures.length > 0) {
  console.error(`\n[pricing-spec] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[pricing-spec] ${checks} checks passed`)
