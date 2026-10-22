/**
 * Host smoke — mount `apply` on a mock Host context, drive completed turns
 * through the real receipt route, and check the folded numbers.
 *
 * Usage is accumulated from `assistant/message.usage` samples, the model comes
 * from `request/context`, and receipts are keyed by both the turn number and
 * the closing seq (the transcript entry receives the closing *node* seq, which
 * is not the turn/end seq).
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

function mockContext() {
  const routes = []
  const listeners = new Map()
  return {
    routes,
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

const session = { id: 'session-1', header: {} }

const module = await import(pathToFileURL(ENTRY).href)
check('module name', module.name, 'usage-kit')
check('injection global', module.CONFIG_GLOBAL, '__DSH_USAGE_KIT_CONFIG__')
check('needs only the web server', module.inject.join(','), 'webServer')

const ctx = mockContext()
module.apply(ctx, { cnyPerUsd: FX, widgets: { coach: false, receipt: true }, coach: { occupancyWarn: 0.75 } })

check('one route', ctx.routes.length, 1)
check('route path', ctx.routes[0].path, '/dsh-usage-kit/receipts')

// Widget switches reach the browser through the index-injection row.
const table = []
ctx.emit('webserver/index-inject', table)
check('one injection row', table.length, 1)
check('injection name', table[0].name, '__DSH_USAGE_KIT_CONFIG__')
check('injection widgets', table[0].value.widgets, { coach: false, receipt: true })
check('injection coach threshold', table[0].value.coach.occupancyWarn, 0.75)
check('injection keeps the other defaults', table[0].value.coach.projectedWarn, 0.9)

// --- turn 1: one assistant sample, two steps ----------------------------
ctx.emit('session/event', session, { type: 'request/context', data: { provider: 'deepseek-account', model: 'deepseek-flash' }, seq: 9 })
ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 }, seq: 10 })
ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 1 }, seq: 11 })
ctx.emit('session/event', session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, usage: { inputTokens: 30_000, cacheReadTokens: 900_000, outputTokens: 25_000 } },
  seq: 12,
})
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 1, step: 1 }, seq: 13 })
ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1, step: 2 }, seq: 14 })
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 1, step: 2 }, seq: 15 })
await sleep(5)
ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 20 })

const first = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=session-1')).body)
check('session id echoed', first.sessionId, 'session-1')
const receipt = first.byTurn['1']
assert('receipt keyed by turn', receipt !== undefined)
if (receipt !== undefined) {
  check('receipt turn', receipt.turn, 1)
  check('receipt endSeq', receipt.endSeq, 20)
  check('receipt steps', receipt.steps, 2)
  check('receipt tokens', receipt.tokens, 955_000)
  check('receipt usage uncached', receipt.usage.uncachedInputTokens, 30_000)
  check('receipt usage cache read', receipt.usage.cacheReadTokens, 900_000)
  check('receipt usage output', receipt.usage.outputTokens, 25_000)
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
assert('receipt also keyed by the end seq', first.bySeq['20'] !== undefined)

// --- turn 2: retries add another billed sample -------------------------
ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 }, seq: 30 })
ctx.emit('session/event', session, {
  type: 'assistant/message',
  data: { turn: 2, step: 1, usage: { inputTokens: 10_000, cacheReadTokens: 100_000, outputTokens: 5_000 } },
  seq: 31,
})
ctx.emit('session/event', session, {
  type: 'assistant/message',
  data: { turn: 2, step: 1, usage: { inputTokens: 1_000, cacheWriteTokens: 2_000, outputTokens: 500 } },
  seq: 32,
})
ctx.emit('session/event', session, { type: 'step/end', data: { turn: 2, step: 1 }, seq: 33 })
ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: 40 })
const second = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=session-1')).body)
const secondReceipt = second.byTurn['2']
assert('second receipt exists', secondReceipt !== undefined)
if (secondReceipt !== undefined) {
  check('second receipt steps', secondReceipt.steps, 1)
  check('retry samples add up', secondReceipt.usage.uncachedInputTokens, 11_000)
  check('retry cache reads add up', secondReceipt.usage.cacheReadTokens, 100_000)
  check('cache writes are counted', secondReceipt.usage.cacheWriteTokens, 2_000)
  check('retry output adds up', secondReceipt.usage.outputTokens, 5_500)
  check('second receipt tokens', secondReceipt.tokens, 118_500)
}

// --- a model switch prices the next turn with the new model -------------
ctx.emit('session/event', session, { type: 'request/context', data: { provider: 'deepseek-account', model: 'deepseek-v4-pro' }, seq: 45 })
ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 3 }, seq: 46 })
ctx.emit('session/event', session, {
  type: 'assistant/message',
  data: { turn: 3, step: 1, usage: { inputTokens: 1_000, outputTokens: 100 } },
  seq: 47,
})
ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } }, seq: 50 })
const third = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=session-1')).body)
check('model switch is priced', third.byTurn['3'].model, 'deepseek-v4-pro')

// --- edges --------------------------------------------------------------
const unknown = JSON.parse((await respond(ctx.routes[0].handler, 'GET', '/dsh-usage-kit/receipts?session=nope')).body)
check('unknown session returns no receipts', Object.keys(unknown.byTurn).length, 0)
const post = await respond(ctx.routes[0].handler, 'POST')
check('POST is refused', post.status, 405)
const head = await respond(ctx.routes[0].handler, 'HEAD')
check('HEAD is accepted', head.status, 200)
check('HEAD has no body', head.body, '')

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
