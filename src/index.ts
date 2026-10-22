/**
 * Usage kit, Host half.
 *
 * One job: fold every completed Turn into a small receipt — steps, the four
 * billed token buckets, wall-clock duration, the routed model and the priced
 * cost — and publish the receipts for one session on a read-only route.
 *
 * The browser half renders two widgets from this data:
 *   - the turn receipt under each completed Turn in the transcript;
 *   - (client-only) the context coach above the composer.
 *
 * The context coach needs no Host data: it reads the shipped session
 * projections directly in the browser. This half exists only because
 * per-Turn usage is not derivable from the cumulative `tokenUsage` projection.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_FX, costOfUsage, emptyUsage, isPeak, normalizeUsage, priceFor,
  toDisplayCurrency, totalTokens, usageDelta,
} from './pricing.js'

/** Cordis plugin name (the Loader row name). */
export const name = 'usage-kit'

/**
 * `webServer` carries the receipt route; `sessionProjections` supplies the
 * cumulative usage the per-Turn delta is measured against.
 */
export const inject = ['webServer', 'sessionProjections']

/** Index-injection property carrying the widget toggles to the browser half. */
export const CONFIG_GLOBAL = '__DSH_USAGE_KIT_CONFIG__'

/** Receipt route. */
const ROUTE_RECEIPTS = '/dsh-usage-kit/receipts'

/** Host-half configuration (every key optional). */
export interface Config {
  /** Per-widget switches; both default on. */
  readonly widgets?: { readonly coach?: boolean; readonly receipt?: boolean }
  /** Context-coach thresholds. */
  readonly coach?: {
    /** Occupancy ratio that triggers the compaction advice. @default 0.8 */
    readonly occupancyWarn?: number
    /** Projected next-request ratio that triggers the compaction advice. @default 0.9 */
    readonly projectedWarn?: number
    /** Cache-hit ratio below which the "repeated input" hint appears. @default 0.8 */
    readonly cacheHitFloor?: number
    /** Minimum prompt tokens before the cache hint is worth showing. @default 20000 */
    readonly minPromptTokens?: number
  }
  /** CNY per USD for the display amount. @default 7.2 */
  readonly cnyPerUsd?: number
  /** UTC dates billed at off-peak all day. @default [] */
  readonly holidays?: readonly string[]
  /** Completed Turns kept per session. @default 300 */
  readonly turnsKept?: number
}

interface WidgetSettings {
  coach: boolean
  receipt: boolean
}

interface CoachSettings {
  occupancyWarn: number
  projectedWarn: number
  cacheHitFloor: number
  minPromptTokens: number
}

interface Settings {
  widgets: WidgetSettings
  coach: CoachSettings
  cnyPerUsd: number
  holidays: string[]
  turnsKept: number
}

const DEFAULTS: Settings = {
  widgets: { coach: true, receipt: true },
  coach: { occupancyWarn: 0.8, projectedWarn: 0.9, cacheHitFloor: 0.8, minPromptTokens: 20_000 },
  cnyPerUsd: DEFAULT_FX,
  holidays: [],
  turnsKept: 300,
}

/* ------------------------------------------------------------------ types */

interface UsageBuckets {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

interface TurnReceipt {
  turn: number
  endSeq: number
  steps: number
  usage: UsageBuckets
  tokens: number
  durationMs: number
  model: string
  modelKnown: boolean
  peak: boolean
  costUsd: number
  costCny: number
}

interface OpenTurn {
  turn: number
  startedAt: number
  baseline: UsageBuckets
  stepIds: Set<number>
}

interface SessionTrack {
  id: string
  session: unknown
  open?: OpenTurn
  receipts: Map<number, TurnReceipt>
}

interface ProjectionRegistry {
  stateOf(session: unknown, key: string): unknown
}

interface RequestLike {
  method?: string
  url?: string
}

interface ResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body?: string): void
}

/* --------------------------------------------------------------- helpers */

/** A declared service, read as a property (legal because of `inject`). */
function service<T>(ctx: Context, name: string): T | undefined {
  const direct = (ctx as unknown as Record<string, T | undefined>)[name]
  return direct === undefined ? undefined : direct
}

/** Coerce a wire value into a finite number, else zero. */
function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Coerce a wire value into a string, else the empty string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Error text without assuming the thrown value is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Clamp a config number into a sane range. */
function ratio(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

/** Normalize a partial row config against the defaults. */
function normalize(config: Config | undefined): Settings {
  const widgets = config?.widgets ?? {}
  const coach = config?.coach ?? {}
  const turnsKept = config?.turnsKept
  return {
    widgets: {
      coach: widgets.coach ?? DEFAULTS.widgets.coach,
      receipt: widgets.receipt ?? DEFAULTS.widgets.receipt,
    },
    coach: {
      occupancyWarn: ratio(coach.occupancyWarn, DEFAULTS.coach.occupancyWarn),
      projectedWarn: ratio(coach.projectedWarn, DEFAULTS.coach.projectedWarn),
      cacheHitFloor: ratio(coach.cacheHitFloor, DEFAULTS.coach.cacheHitFloor),
      minPromptTokens: Number.isFinite(coach.minPromptTokens) && Number(coach.minPromptTokens) > 0
        ? Math.round(Number(coach.minPromptTokens))
        : DEFAULTS.coach.minPromptTokens,
    },
    cnyPerUsd: Number.isFinite(config?.cnyPerUsd) && Number(config?.cnyPerUsd) > 0
      ? Number(config?.cnyPerUsd)
      : DEFAULTS.cnyPerUsd,
    holidays: Array.isArray(config?.holidays) ? config.holidays.filter(entry => typeof entry === 'string') : [],
    turnsKept: Number.isFinite(turnsKept) && Number(turnsKept) > 0 ? Math.round(Number(turnsKept)) : DEFAULTS.turnsKept,
  }
}

/** The session id, wherever this DSH build put it. */
function sessionKey(session: unknown): string | undefined {
  const value = session as { id?: unknown; header?: { id?: unknown } } | null | undefined
  const id = value?.id ?? value?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/* ------------------------------------------------------------------ apply */

/**
 * Mount the per-Turn receipt folder and its route.
 * @param ctx - Host plugin context.
 * @param config - optional row configuration.
 */
export function apply(ctx: Context, config?: Config): void {
  const settings = normalize(config)
  let disposed = false

  const projectionRegistry = (): ProjectionRegistry | undefined => service<ProjectionRegistry>(ctx, 'sessionProjections')

  const projectionOf = <T>(session: unknown, key: string): T | undefined => {
    const registry = projectionRegistry()
    if (registry === undefined) return undefined
    try {
      return registry.stateOf(session, key) as T | undefined
    } catch {
      return undefined
    }
  }

  const readUsage = (session: unknown): UsageBuckets => normalizeUsage(projectionOf(session, 'tokenUsage'))

  const modelOf = (session: unknown): string => {
    const selection = projectionOf<{ next?: { model?: string } | null; lastUsed?: { model?: string } | null }>(session, 'modelSelection')
    return text(selection?.next?.model) || text(selection?.lastUsed?.model)
  }

  const sessions = new Map<string, SessionTrack>()

  const trackFor = (session: unknown): SessionTrack | undefined => {
    const id = sessionKey(session)
    if (id === undefined) return undefined
    let track = sessions.get(id)
    if (track === undefined) {
      track = { id, session, receipts: new Map() }
      sessions.set(id, track)
    }
    track.session = session
    return track
  }

  /** Close one open Turn into a receipt. */
  const settle = (track: SessionTrack, endSeq: number, endedAt: number): void => {
    const open = track.open
    if (open === undefined) return
    track.open = undefined
    const usage = usageDelta(readUsage(track.session), open.baseline)
    const peak = isPeak(endedAt, settings.holidays)
    const price = priceFor(modelOf(track.session), peak)
    const costUsd = costOfUsage(usage, price)
    const receipt: TurnReceipt = {
      turn: open.turn,
      endSeq,
      steps: Math.max(1, open.stepIds.size),
      usage,
      tokens: totalTokens(usage),
      durationMs: Math.max(0, endedAt - open.startedAt),
      model: price.model,
      modelKnown: price.known,
      peak,
      costUsd,
      costCny: toDisplayCurrency(costUsd, settings.cnyPerUsd),
    }
    track.receipts.set(receipt.endSeq, receipt)
    while (track.receipts.size > settings.turnsKept) {
      const oldest = track.receipts.keys().next()
      if (oldest.done === true) break
      track.receipts.delete(oldest.value)
    }
  }

  const onSessionEvent = (session: unknown, event: { type?: string; data?: Record<string, unknown>; seq?: unknown }): void => {
    if (disposed) return
    const track = trackFor(session)
    if (track === undefined) return
    const now = Date.now()
    const type = text(event?.type)
    const data = (event?.data ?? {}) as Record<string, unknown>

    if (type === 'turn/start') {
      // A predecessor without its own end is settled against the next boundary.
      settle(track, 0, now)
      track.open = {
        turn: num(data.turn),
        startedAt: now,
        baseline: readUsage(track.session),
        stepIds: new Set(),
      }
      return
    }

    if (type === 'step/start' || type === 'step/end' || type === 'assistant/message') {
      const open = track.open
      if (open === undefined) return
      const step = num(data.step)
      if (step > 0) open.stepIds.add(step)
      return
    }

    if (type === 'turn/end') settle(track, num(event.seq), now)
  }

  /* ------------------------------------------------------------- surfaces */

  const respond = (res: ResponseLike, status: number, payload: string, head: boolean): void => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(head ? undefined : payload)
  }

  const handleReceipts = (req: RequestLike, res: ResponseLike): void => {
    try {
      const method = text(req.method).toUpperCase() || 'GET'
      if (method !== 'GET' && method !== 'HEAD') {
        respond(res, 405, JSON.stringify({ error: 'method not allowed' }), false)
        return
      }
      const url = new URL(text(req.url) || ROUTE_RECEIPTS, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session') ?? ''
      const track = sessionId.length > 0 ? sessions.get(sessionId) : undefined
      const receipts: Record<string, TurnReceipt> = {}
      if (track !== undefined) {
        for (const [seq, receipt] of track.receipts) receipts[String(seq)] = receipt
      }
      respond(res, 200, JSON.stringify({
        sessionId,
        receipts,
        updatedAt: Date.now(),
      }), method === 'HEAD')
    } catch (error) {
      respond(res, 500, JSON.stringify({ error: messageOf(error) }), false)
    }
  }

  ctx.effect(() => (ctx as unknown as { webServer: { register(route: { kind: 'exact'; path: string; handler: (req: RequestLike, res: ResponseLike) => void }): () => void } }).webServer.register({
    kind: 'exact',
    path: ROUTE_RECEIPTS,
    handler: handleReceipts,
  }), `${name}: receipts route`)

  ctx.effect(() => ctx.on('session/event', onSessionEvent), `${name}: receipt folding`)

  // The browser half registers its widgets from this row, so a widget can be
  // switched off without touching the other one.
  ctx.effect(() => ctx.on('webserver/index-inject', (table: unknown[]) => {
    if (disposed) return
    table.push({
      kind: 'global',
      name: CONFIG_GLOBAL,
      value: {
        widgets: settings.widgets,
        coach: settings.coach,
      },
    })
  }), `${name}: widget switches`)

  ctx.effect(() => () => {
    disposed = true
    sessions.clear()
  }, `${name}: disposal`)
}
