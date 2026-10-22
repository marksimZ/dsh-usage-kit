/**
 * Usage kit, browser half — two independent widgets in one bundle.
 *
 * 1. Context coach (`conversation.input.dock`): a single advisory row that
 *    appears *only* when there is something to do — context close to full, a
 *    projected request that may trigger compaction, or a cache-hit ratio that
 *    makes repeated input expensive. The built-in context ring already shows
 *    the numbers; this widget adds the action, so it stays out of the way.
 *
 * 2. Turn receipt (`conversation.chat.turnTail`): one line under a completed
 *    Turn with steps, tokens, cache hit, money and duration, expandable to the
 *    bucket detail. The data comes from the Host half, because per-Turn usage
 *    cannot be derived from the cumulative projection in the browser.
 *
 * Both widgets are plain CommonJS inside the module-table contract, share one
 * stylesheet, and use only shipped `--dsw-*` tokens. Each registers from its
 * own effect, so switching one off (or deleting its registration) leaves the
 * other untouched.
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-kit',
  factory: (require) => {
    'use strict'

    const React = require('react')

    /** Receipt route served by the Host half. */
    const RECEIPTS_ROUTE = '/dsh-usage-kit/receipts'

    /** One stylesheet for both widgets. */
    const STYLE_ID = 'dsh-usage-kit/styles'

    /** Receipt cache freshness in the page. */
    const RECEIPT_TTL_MS = 10_000

    /** Defaults mirror the Host row; the Host injects the live values. */
    const DEFAULT_CONFIG = {
      widgets: { coach: true, receipt: true },
      coach: { occupancyWarn: 0.8, projectedWarn: 0.9, cacheHitFloor: 0.8, minPromptTokens: 20_000 },
    }

    const STYLES = `
.duk-coach {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  min-height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.duk-coach[data-level='warn'] {
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-label-primary);
}
.duk-coach-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-label-tertiary);
}
.duk-coach[data-level='warn'] .duk-coach-dot { background: var(--dsw-alias-state-warn-primary); }
.duk-coach-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.duk-btn {
  flex: none;
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-link);
  font: inherit;
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;
  cursor: pointer;
}
.duk-btn:hover { background: var(--dsw-alias-interactive-bg-hover-accent); }
.duk-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.duk-btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 1px; }
.duk-error {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 14px;
}
.duk-receipt-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0;
}
.duk-receipt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.duk-receipt:hover { color: var(--dsw-alias-label-secondary); }
.duk-receipt:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; border-radius: var(--dsw-radius-xs); }
.duk-receipt-chevron { font-size: 11px; line-height: 1; }
.duk-receipt-detail {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, max-content));
  gap: 2px 16px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.duk-receipt-detail span { white-space: nowrap; }
.duk-receipt-detail b {
  color: var(--dsw-alias-label-secondary);
  font-weight: 500;
}
@media (prefers-reduced-motion: reduce) {
  .duk-coach,
  .duk-receipt { transition: none; }
}
`

    /** The Host-injected widget switches and thresholds. */
    const runtimeConfig = (() => {
      const injected = globalThis.__DSH_USAGE_KIT_CONFIG__
      if (injected === null || typeof injected !== 'object') return DEFAULT_CONFIG
      return {
        widgets: { ...DEFAULT_CONFIG.widgets, ...(injected.widgets ?? {}) },
        coach: { ...DEFAULT_CONFIG.coach, ...(injected.coach ?? {}) },
      }
    })()

    /** Install the stylesheet once per page. */
    function installStyles() {
      if (document.querySelector('style[data-dsh-plugin-css="' + STYLE_ID + '"]') !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.dshPlugin = 'dsh-usage-kit'
      tag.dataset.dshPluginCss = STYLE_ID
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    /* ------------------------------------------------------------ helpers */

    function num(value) {
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : 0
    }

    /** 950 → "950"; 14_200 → "14.2k"; 1_240_000 → "1.2M". */
    function formatTokens(value) {
      const count = num(value)
      if (count < 1_000) return String(Math.round(count))
      if (count < 1_000_000) return (count / 1_000).toFixed(1) + 'k'
      return (count / 1_000_000).toFixed(1) + 'M'
    }

    /** 134_000 → "2m14s"; 8_400 → "8s". */
    function formatDuration(milliseconds) {
      const total = Math.max(0, Math.round(num(milliseconds) / 1_000))
      if (total < 60) return total + 's'
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return seconds === 0 ? minutes + 'm' : minutes + 'm' + String(seconds).padStart(2, '0') + 's'
    }

    /** 0.42 → "¥0.42". */
    function formatMoney(yuan) {
      return '¥' + num(yuan).toFixed(2)
    }

    /** 0.823 → "82%". */
    function percentText(ratio) {
      return Math.round(num(ratio) * 100) + '%'
    }

    /** Prompt-side buckets only. */
    function promptTokens(usage) {
      const sample = usage ?? {}
      return num(sample.uncachedInputTokens) + num(sample.cacheReadTokens) + num(sample.cacheWriteTokens)
    }

    /** Cache-read share of the prompt side, or null without a sample. */
    function cacheHitRatio(usage) {
      const prompt = promptTokens(usage)
      if (prompt <= 0) return null
      return num(usage?.cacheReadTokens) / prompt
    }

    /**
     * The one advisory to show, or null when nothing needs doing.
     * Pure and exported to the spec test.
     *
     * @param {{ pressure?: any, breakdown?: any, usage?: any }} projections
     * @param {{ occupancyWarn?: number, projectedWarn?: number, cacheHitFloor?: number, minPromptTokens?: number }} thresholds
     */
    function coachAdvice(projections, thresholds) {
      const limits = { ...DEFAULT_CONFIG.coach, ...(thresholds ?? {}) }
      const pressure = projections?.pressure ?? {}
      const breakdown = projections?.breakdown ?? {}
      const usage = projections?.usage ?? {}
      const window = num(pressure.contextWindow)
      const used = num(pressure.pressureTokens)

      if (window > 0) {
        const occupancy = used > 0 ? used / window : 0
        if (occupancy >= limits.occupancyWarn) {
          const messageTokens = num(breakdown.messageTokens)
          const release = messageTokens > 0 ? ' · 历史消息约 ' + formatTokens(messageTokens) + ' 可压缩' : ''
          return {
            level: 'warn',
            text: '上下文已用 ' + percentText(occupancy) + release,
            action: 'compact',
          }
        }
        const projected = num(pressure.projectedTokens)
        if (projected > 0 && projected / window >= limits.projectedWarn) {
          return {
            level: 'warn',
            text: '下一步请求预计占 ' + percentText(projected / window) + ' 窗口，可能触发压缩',
            action: 'compact',
          }
        }
      }

      const hit = cacheHitRatio(usage)
      if (hit !== null && promptTokens(usage) >= limits.minPromptTokens && hit < limits.cacheHitFloor) {
        return {
          level: 'info',
          text: '缓存命中 ' + percentText(hit) + ' · 重复输入可能更贵',
          action: null,
        }
      }

      return null
    }

    /** Receipt summary line and its detail rows, from one Host receipt. */
    function receiptView(receipt) {
      const hit = cacheHitRatio(receipt?.usage)
      const route = receipt?.modelKnown === false ? '（未知模型按 flash 估价）' : ''
      return {
        summary: [
          num(receipt?.steps) + ' 步',
          formatTokens(receipt?.tokens) + ' tok',
          hit === null ? '缓存 —' : '缓存 ' + percentText(hit),
          formatMoney(receipt?.costCny),
          formatDuration(receipt?.durationMs),
        ].join(' · '),
        detail: [
          { label: '未缓存输入', value: formatTokens(receipt?.usage?.uncachedInputTokens) },
          { label: '缓存读取', value: formatTokens(receipt?.usage?.cacheReadTokens) },
          { label: '输出', value: formatTokens(receipt?.usage?.outputTokens) },
          { label: '模型', value: (receipt?.model ?? '—') + route },
          { label: '时段', value: receipt?.peak === true ? '峰时价' : '谷时价' },
        ],
      }
    }

    /**
     * The numeric turn id behind the transcript's `turn` owner prop.
     *
     * The transcript hands the entry a `TurnLocation` (`{ kind, turn }`) whose
     * `turn` is the timeline's Turn object, so the number can sit one or two
     * levels down depending on the build. Returns NaN when nothing numeric is
     * found, and the store then falls back to the closing seq.
     */
    function turnNumberOf(turn) {
      if (typeof turn === 'number' && Number.isFinite(turn)) return turn
      if (turn === null || typeof turn !== 'object') return Number.NaN
      const direct = turn.turn
      if (typeof direct === 'number' && Number.isFinite(direct)) return direct
      if (direct !== null && typeof direct === 'object' && typeof direct.turn === 'number') return direct.turn
      if (typeof turn.id === 'number' && Number.isFinite(turn.id)) return turn.id
      return Number.NaN
    }

    /* ------------------------------------------------------ receipt store */

    /** One fetch per session, shared by every receipt of that session. */
    const receiptStore = {
      sessions: new Map(),
      read(sessionId, seq, turnNumber) {
        const entry = this.sessions.get(sessionId)
        if (entry === undefined) return null
        if (Number.isFinite(turnNumber)) {
          const byTurn = entry.data.byTurn?.[String(turnNumber)]
          if (byTurn !== undefined) return byTurn
        }
        return entry.data.bySeq?.[String(seq)] ?? null
      },
      async ensure(sessionId) {
        const existing = this.sessions.get(sessionId)
        const entry = existing ?? { data: { byTurn: {}, bySeq: {} }, at: 0, inflight: null }
        if (existing === undefined) this.sessions.set(sessionId, entry)
        if (entry.at > 0 && Date.now() - entry.at < RECEIPT_TTL_MS) return
        if (entry.inflight !== null) return entry.inflight
        entry.inflight = (async () => {
          try {
            const response = await fetch(RECEIPTS_ROUTE + '?session=' + encodeURIComponent(sessionId), {
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const body = await response.json()
            if (body !== null && typeof body === 'object' && typeof body.byTurn === 'object' && typeof body.bySeq === 'object') {
              entry.data = { byTurn: body.byTurn, bySeq: body.bySeq }
              entry.at = Date.now()
            }
          } catch {
            // Leave the cache alone; the next mount retries.
          } finally {
            entry.inflight = null
          }
        })()
        return entry.inflight
      },
    }

    /* ---------------------------------------------------------- widgets */

    /** Advisory row above the composer; renders nothing when there is no advice. */
    function ContextCoach(props) {
      const pressure = props.useProjection('contextPressure')
      const breakdown = props.useProjection('contextBreakdown')
      const usage = props.useProjection('tokenUsage')
      const thresholds = props.kit?.coach ?? runtimeConfig.coach
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const advice = coachAdvice({ pressure, breakdown, usage }, thresholds)

      if (advice === null) return null

      const runCompact = () => {
        setBusy(true)
        setError(null)
        Promise.resolve()
          .then(() => props.kit?.ctx?.remote?.commands?.execute(props.sessionId, '/compact', []))
          .then(result => {
            if (result !== null && typeof result === 'object' && result.ok === false) setError('命令被拒绝')
          })
          .catch(reason => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }

      return React.createElement('div', { className: 'duk-coach', 'data-level': advice.level },
        React.createElement('span', { className: 'duk-coach-dot', 'aria-hidden': 'true' }),
        React.createElement('span', { className: 'duk-coach-text' }, advice.text),
        advice.action === 'compact'
          ? React.createElement('button', {
            type: 'button',
            className: 'duk-btn',
            disabled: busy,
            onClick: runCompact,
          }, busy ? '压缩中…' : '压缩')
          : null,
        error === null
          ? null
          : React.createElement('span', { className: 'duk-error' }, error))
    }

    /** One-line receipt under a completed Turn, expandable to bucket detail. */
    function TurnReceipt(props) {
      const sessionId = props.sessionId
      const seq = props.seq
      const turnNumber = turnNumberOf(props.turn)
      const [receipt, setReceipt] = React.useState(() => receiptStore.read(sessionId, seq, turnNumber))
      const [open, setOpen] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        void receiptStore.ensure(sessionId).then(() => {
          if (alive) setReceipt(receiptStore.read(sessionId, seq, turnNumber))
        })
        return () => { alive = false }
      }, [sessionId, seq, turnNumber])

      if (receipt === null || receipt === undefined) return null
      const view = receiptView(receipt)

      return React.createElement('div', { className: 'duk-receipt-root' },
        React.createElement('button', {
          type: 'button',
          className: 'duk-receipt',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => { setOpen(value => !value) },
        },
        React.createElement('span', undefined, view.summary),
        React.createElement('span', { className: 'duk-receipt-chevron', 'aria-hidden': 'true' }, open ? '▴' : '▾')),
        open
          ? React.createElement('div', { className: 'duk-receipt-detail' },
            view.detail.map(row => React.createElement('span', { key: row.label },
              React.createElement('b', undefined, row.label + ' '),
              row.value)))
          : null)
    }

    /* ------------------------------------------------------------ apply */

    /**
     * Register the enabled widgets. Each one rides its own effect, so the two
     * can be switched off or removed independently.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'usage-kit: styles')
      const widgets = runtimeConfig.widgets

      if (widgets.coach !== false) {
        ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'usage-coach',
          order: 20,
          label: '上下文教练',
        }, entryProps => React.createElement(ContextCoach, {
          ...entryProps,
          kit: { ctx, coach: runtimeConfig.coach },
        }))), 'usage-kit: context coach')
      }

      if (widgets.receipt !== false) {
        ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'usage-receipt',
          order: 40,
          label: '轮次回执',
        }, TurnReceipt)), 'usage-kit: turn receipt')
      }
    }

    return {
      name: 'dsh-usage-kit',
      inject: ['slots'],
      apply,
      ...globalThis.__DSH_USAGE_KIT_TEST__ === true
        ? {
          __internals: {
            coachAdvice,
            receiptView,
            formatTokens,
            formatDuration,
            formatMoney,
            percentText,
            cacheHitRatio,
            promptTokens,
            turnNumberOf,
            receiptStore,
            STYLE_ID,
            runtimeConfig,
          },
        }
        : {},
    }
  },
})
