/**
 * Host smoke — mount `apply` on a mock Host context, drive two completed turns
 * through the real receipt route, and check the folded numbers.
 *
 * Usage: node --experimental-strip-types scripts/host-smoke.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { costOfUsage, isPeak, priceFor } from '../src/pricing.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(resolve(HERE, '..'), 'src', 'index.ts')
const FX = 7.2

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

function near(label, actual, expected, tolerance = 1e-9) {
  checks += 1
  if (!(Math.abs(actual - expected) <= tolerance)) failures.push(`${label}: expected ${expected}, got ${actual}`)
}

const sleep = milliseconds => new Promise(settle => setTimeout(settle, milliseconds))

function mockContext(services) {
  const routes = []
  const listeners = new Map()
  return {
    routes,
    ...services,
    effect(body) {
      const dispose = body()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { warn: () => {} },
  }
}

function respond(handler, method = 'GET', url = '/dsh-usage-kit/receipts') {
  return new Promise((settle, fail) => {
    const res = {
      status: 0,
      writeHead(status) { this.status = status },
      end(body) { settle({ status: this.status, body: body ?? '' }) },
    }
    try { handler({ method, url }, res) } catch (error) { fail(error) }
  })
}

const session = { id: 'session-1', header: {}, projections: {} }
const projections = {
  stateOf(target, key) {
    return target?.projections?.[key]
  },
}

const module = await import(pathToFileURL(ENTRY).href)
check('module name', module.name, 'usage-kit')
check('injection global', module.CONFIG_GLOBAL, '__DSH_USAGE_KIT_CONFIG__')
check('declares its services', module.inject.join(','), 'webServer,sessionProjections')

const ctx = mockContext({ sessionProjections: projections })
module.apply(ctx, { cnyPerUsd: FX, widgets: { coach: false, receipt: true }, coach: { occupancyWarn: 0.75 } })

check('one route', ctx.routes.length, 1)
check('route path', ctx.routes[0].path, '/dsh-usage-kit/receipts')

// The widget switches reach the browser through the index-injection row.
const table = []
ctx.emit('webserver/index-inject', table)
check('one injection row', table.length, 1)
check('injection name', table[0].name, '__DSH_USAGE_KIT_CONFIG__')
check('injection widgets', table[0].value.widgets, { coach: false, receipt: true })
check('injection coach threshold', table[0].value.coach.occupancyWarn, 0.75)
check('injection keeps the other defaults', table[0].value.coach.projectedWarn, 0.9)

// --- turn 1: two steps --------------------------------------------------
session.projections = {
  tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  modelSelection: { lastUsed: { model: 'deepseek-flash' }, next: { model: 'deepseek-flash' } },
}
ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 }, seq: 10 })
session.projections.tokenUsage = { uncachedInputTokens: 30_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 25_000 }
ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 }, seq: 11 })
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 1, step: 1 }, seq: 12 })
ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 2 }, seq: 13 })
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 1, step: 2 }, seq: 14 })
await sleep(5)
ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 20 })

const first = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=session-1')).body)
check('session id echoed', first.sessionId, 'session-1')
const receipt = first.receipts['20']
assert('receipt keyed by closing seq', receipt !== undefined)
if (receipt !== undefined) {
  check('receipt turn', receipt.turn, 1)
  check('receipt endSeq', receipt.endSeq, 20)
  check('receipt steps', receipt.steps, 2)
  check('receipt tokens', receipt.tokens, 955_000)
  check('receipt model', receipt.model, 'deepseek-flash')
  check('receipt model known', receipt.modelKnown, true)
  const peak = isPeak(Date.now(), [])
  check('receipt period matches the wall clock', receipt.peak, peak)
  const expectedUsd = costOfUsage({
    uncachedInputTokens: 30_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 25_000,
  }, priceFor('deepseek-flash', peak))
  near('receipt cost usd', receipt.costUsd, expectedUsd)
  near('receipt cost cny', receipt.costCny, expectedUsd * FX)
  assert('receipt has a non-negative duration', receipt.durationMs >= 0)
}

// --- turn 2: usage delta is measured from the turn baseline -------------
session.projections.tokenUsage = { uncachedInputTokens: 40_000, cacheReadTokens: 1_100_000, cacheWriteTokens: 0, outputTokens: 40_000 }
ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 }, seq: 30 })
session.projections.tokenUsage = { uncachedInputTokens: 50_000, cacheReadTokens: 1_200_000, cacheWriteTokens: 0, outputTokens: 45_000 }
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 2, step: 1 }, seq: 31 })
ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: 40 })
const second = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=session-1')).body)
const secondReceipt = second.receipts['40']
assert('second receipt exists', secondReceipt !== undefined)
if (secondReceipt !== undefined) {
  check('second receipt steps', secondReceipt.steps, 1)
  check('second receipt delta uncached', secondReceipt.usage.uncachedInputTokens, 10_000)
  check('second receipt delta cache read', secondReceipt.usage.cacheReadTokens, 100_000)
  check('second receipt delta output', secondReceipt.usage.outputTokens, 5_000)
  check('second receipt tokens', secondReceipt.tokens, 115_000)
}

// --- edges --------------------------------------------------------------
const unknown = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=nope')).body)
check('unknown session returns no receipts', Object.keys(unknown.receipts).length, 0)
const post = await respond(ctx.routes[0].handler, 'POST')
check('POST is refused', post.status, 405)
const head = await respond(ctx.routes[0].handler, 'HEAD')
check('HEAD is accepted', head.status, 200)
check('HEAD has no body', head.body, '')

// The route carries aggregates only: no prompt or message text.
for (const forbidden of ['messages', 'content"', 'prompt"']) {
  assert(`wire payload omits ${forbidden}`, !JSON.stringify(first).includes(forbidden))
}

if (failures.length > 0) {
  console.error(`\n[host-smoke] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[host-smoke] ${checks} checks passed`)
process.exit(0)
