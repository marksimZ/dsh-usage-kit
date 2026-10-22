/**
 * Pricing helpers for the usage kit — the Host half prices one turn; the
 * browser half receives numbers.
 *
 * Official DeepSeek list price, USD per 1M tokens, fetched 2026-10-17 from
 * https://api-docs.deepseek.com/quick_start/pricing/ . Off-peak is half of
 * peak; peak runs Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, excluding the
 * dates listed in the row's `holidays`.
 *
 * `scripts/pricing-spec.mjs` pins these numbers, so a price edit is a
 * deliberate two-file change instead of silent drift.
 */

/** USD per 1M tokens. */
export const PRICE_TABLE = Object.freeze({
  'deepseek-flash': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }),
    offPeak: Object.freeze({ cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }),
    offPeak: Object.freeze({ cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 }),
  }),
})

/** Peak windows in UTC hours, `[from, to)`. */
export const PEAK_UTC_WINDOWS = Object.freeze([Object.freeze([1, 4]), Object.freeze([6, 10])])

/** Model whose prices are used when the routed model is unknown. */
export const FALLBACK_MODEL = 'deepseek-flash'

/** Default CNY per USD for the display amount. */
export const DEFAULT_FX = 7.2

/** @typedef {{ uncachedInputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, outputTokens: number }} UsageBuckets */

/** @returns {UsageBuckets} a fresh all-zero sample. */
export function emptyUsage() {
  return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/** Coerce anything shaped like a usage sample into non-negative integers. */
export function normalizeUsage(value) {
  const record = value !== null && typeof value === 'object' ? value : {}
  const count = candidate => {
    const parsed = typeof candidate === 'number' ? candidate : Number(candidate)
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
  }
  return {
    uncachedInputTokens: count(record.uncachedInputTokens),
    cacheReadTokens: count(record.cacheReadTokens),
    cacheWriteTokens: count(record.cacheWriteTokens),
    outputTokens: count(record.outputTokens),
  }
}

/** Per-bucket difference, never negative. */
export function usageDelta(current, baseline) {
  const now = normalizeUsage(current)
  const then = normalizeUsage(baseline)
  return {
    uncachedInputTokens: Math.max(0, now.uncachedInputTokens - then.uncachedInputTokens),
    cacheReadTokens: Math.max(0, now.cacheReadTokens - then.cacheReadTokens),
    cacheWriteTokens: Math.max(0, now.cacheWriteTokens - then.cacheWriteTokens),
    outputTokens: Math.max(0, now.outputTokens - then.outputTokens),
  }
}

/** Sum of the four disjoint buckets. */
export function totalTokens(usage) {
  const sample = normalizeUsage(usage)
  return sample.uncachedInputTokens + sample.cacheReadTokens + sample.cacheWriteTokens + sample.outputTokens
}

/** Whether one instant falls in a peak window. */
export function isPeak(momentMs, holidays = []) {
  const moment = new Date(momentMs)
  const day = moment.getUTCDay()
  if (day === 0 || day === 6) return false
  const date = moment.toISOString().slice(0, 10)
  if (holidays.includes(date)) return false
  const hour = moment.getUTCHours()
  for (const [from, to] of PEAK_UTC_WINDOWS) if (hour >= from && hour < to) return true
  return false
}

/** The price row for one routed model and period. */
export function priceFor(model, peak) {
  const name = typeof model === 'string' ? model : ''
  const entry = PRICE_TABLE[name]
  const price = (entry ?? PRICE_TABLE[FALLBACK_MODEL])[peak ? 'peak' : 'offPeak']
  return {
    model: entry === undefined ? FALLBACK_MODEL : name,
    known: entry !== undefined,
    peak,
    cacheHit: price.cacheHit,
    cacheMiss: price.cacheMiss,
    output: price.output,
  }
}

/** Billed cost of one usage sample in USD. */
export function costOfUsage(usage, price) {
  const sample = normalizeUsage(usage)
  return (
    sample.uncachedInputTokens * price.cacheMiss +
    sample.cacheReadTokens * price.cacheHit +
    sample.cacheWriteTokens * price.cacheMiss +
    sample.outputTokens * price.output
  ) / 1e6
}

/** Convert USD to the display currency. */
export function toDisplayCurrency(usdAmount, cnyPerUsd) {
  return usdAmount * (Number.isFinite(cnyPerUsd) && cnyPerUsd > 0 ? cnyPerUsd : DEFAULT_FX)
}
