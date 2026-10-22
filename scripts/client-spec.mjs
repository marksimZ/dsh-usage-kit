/**
 * Client spec — the two widgets' pure projections, pinned.
 *
 * Loads the real browser bundle through a stubbed `window.__ModuleLoader__`,
 * asks for its test seam, and asserts the coach advice rules, the receipt
 * summary/detail model, the formatters and the Host-injected widget switches.
 * No DOM, no browser.
 *
 * Usage: node scripts/client-spec.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(resolve(HERE, '..'), 'src', 'client.js')

let checks = 0
const failures = []

function check(label, actual, expected) {
  checks += 1
  if (!Object.is(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(label, condition) {
  checks += 1
  if (!condition) failures.push(`${label}: condition failed`)
}

/** Load a fresh module instance with the given injected config. */
async function load(config) {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }
  globalThis.__DSH_USAGE_KIT_TEST__ = true
  globalThis.document = { hidden: false }
  if (config === undefined) delete globalThis.__DSH_USAGE_KIT_CONFIG__
  else globalThis.__DSH_USAGE_KIT_CONFIG__ = config
  await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}${Math.random()}`)
  return registrations[0].factory(() => ({
    createElement: () => ({}),
    useState: () => [null, () => {}],
    useEffect: () => {},
  }))
}

const module = await load(undefined)
check('module name', module.name, 'dsh-usage-kit')
check('injects slots', module.inject.includes('slots'), true)
assert('test seam present', module.__internals !== undefined)
const { coachAdvice, receiptView, formatTokens, formatDuration, formatMoney, percentText, cacheHitRatio, promptTokens, runtimeConfig } = module.__internals

// --- defaults -----------------------------------------------------------
check('default widgets', runtimeConfig.widgets, { coach: true, receipt: true })
check('default occupancy threshold', runtimeConfig.coach.occupancyWarn, 0.8)

// --- coach advice -------------------------------------------------------
const empty = coachAdvice({ pressure: {}, breakdown: {}, usage: {} }, {})
check('no data → no advice', empty, null)

const full = coachAdvice({
  pressure: { contextWindow: 100_000, pressureTokens: 85_000 },
  breakdown: { messageTokens: 42_000 },
  usage: {},
}, {})
check('occupancy advice level', full.level, 'warn')
check('occupancy advice text', full.text, '上下文已用 85% · 历史消息约 42.0k 可压缩')
check('occupancy advice action', full.action, 'compact')

const near = coachAdvice({
  pressure: { contextWindow: 100_000, pressureTokens: 40_000, projectedTokens: 95_000 },
  breakdown: {},
  usage: {},
}, {})
check('projected advice level', near.level, 'warn')
check('projected advice text', near.text, '下一步请求预计占 95% 窗口，可能触发压缩')
check('projected advice action', near.action, 'compact')

const lowCache = coachAdvice({
  pressure: { contextWindow: 100_000, pressureTokens: 10_000 },
  breakdown: {},
  usage: { uncachedInputTokens: 9_000, cacheReadTokens: 21_000, cacheWriteTokens: 0, outputTokens: 1_000 },
}, {})
check('cache advice level', lowCache.level, 'info')
check('cache advice text', lowCache.text, '缓存命中 70% · 重复输入可能更贵')
check('cache advice has no action', lowCache.action, null)

const smallPrompt = coachAdvice({
  pressure: {},
  breakdown: {},
  usage: { uncachedInputTokens: 1_500, cacheReadTokens: 3_500, cacheWriteTokens: 0, outputTokens: 100 },
}, {})
check('small prompt stays quiet', smallPrompt, null)

const healthy = coachAdvice({
  pressure: { contextWindow: 100_000, pressureTokens: 20_000 },
  breakdown: {},
  usage: { uncachedInputTokens: 1_000, cacheReadTokens: 99_000, cacheWriteTokens: 0, outputTokens: 1_000 },
}, {})
check('healthy context stays quiet', healthy, null)

const disabled = coachAdvice({ pressure: { contextWindow: 100_000, pressureTokens: 95_000 } }, { occupancyWarn: 0.99 })
check('threshold config is honoured', disabled, null)

// --- receipt model ------------------------------------------------------
const receipt = {
  turn: 3,
  endSeq: 42,
  steps: 8,
  usage: { uncachedInputTokens: 30_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 25_000 },
  tokens: 955_000,
  durationMs: 134_000,
  model: 'deepseek-flash',
  modelKnown: true,
  peak: true,
  costUsd: 0.0444,
  costCny: 0.32,
}
const view = receiptView(receipt)
check('receipt summary', view.summary, '8 步 · 955.0k tok · 缓存 97% · ¥0.32 · 2m14s')
check('receipt detail labels', view.detail.map(row => row.label), ['未缓存输入', '缓存读取', '输出', '模型', '时段'])
check('receipt detail input', view.detail[0].value, '30.0k')
check('receipt detail model', view.detail[3].value, 'deepseek-flash')
check('receipt detail period', view.detail[4].value, '峰时价')

const unknownModel = receiptView({ ...receipt, modelKnown: false, model: 'deepseek-flash' })
assert('unknown model is called out', unknownModel.detail[3].value.includes('未知模型'))

// --- formatters ---------------------------------------------------------
check('tokens small', formatTokens(950), '950')
check('tokens thousands', formatTokens(14_200), '14.2k')
check('tokens millions', formatTokens(1_240_000), '1.2M')
check('duration seconds', formatDuration(8_400), '8s')
check('duration minutes', formatDuration(134_000), '2m14s')
check('duration exact minute', formatDuration(120_000), '2m')
check('money', formatMoney(0.324), '¥0.32')
check('percent', percentText(0.856), '86%')
check('cache hit', cacheHitRatio({ uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0 }), 0.9)
check('cache hit absent', cacheHitRatio({}), null)
check('prompt tokens', promptTokens({ uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 99 }), 60)

// --- injected switches --------------------------------------------------
const configured = await load({ widgets: { coach: true, receipt: false }, coach: { occupancyWarn: 0.7 } })
check('injected receipt switch', configured.__internals.runtimeConfig.widgets.receipt, false)
check('injected threshold', configured.__internals.runtimeConfig.coach.occupancyWarn, 0.7)
check('injected fallbacks keep defaults', configured.__internals.runtimeConfig.coach.projectedWarn, 0.9)

if (failures.length > 0) {
  console.error(`\n[client-spec] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[client-spec] ${checks} checks passed`)
