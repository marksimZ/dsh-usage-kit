# dsh-usage-kit

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin with two small,
independent widgets about **what a conversation is using**:

1. **Context coach** — an advisory row above the composer that appears *only* when there is
   something to do: context close to full, a projected request likely to trigger compaction, or a
   cache-hit ratio that makes repeated input expensive. One click runs `/compact`.
2. **Turn receipt** — one quiet line under every completed turn:
   `8 步 · 955.0k tok · 缓存 97% · ¥0.32 · 2m14s`, expandable to the four billed token buckets,
   the routed model and the peak/off-peak period.

Both are packaged in one plugin row but register from separate effects, so **either widget can be
switched off without the other** (`widgets.coach: false` / `widgets.receipt: false`), and deleting a
widget is removing one registration block from `src/client.js`.

## Why these two

DSH already ships a 14px context ring in the composer and a todo/goal dock above it. This kit does
not duplicate them:

- the ring shows numbers; the coach adds the **action** (and stays invisible when nothing is
  actionable, so it does not become a second meter);
- the built-in turn usage panel is token-only and behind a click; the receipt is **one inline line
  with money and duration**, priced from the official DeepSeek catalog.

## Screens

```
composer area
┌─────────────────────────────────────────────────────────────┐
│ 上下文已用 83% · 历史消息约 42.0k 可压缩              [压缩] │  ← coach (only when triggered)
├─────────────────────────────────────────────────────────────┤
│ … input card …                                               │
└─────────────────────────────────────────────────────────────┘

transcript, under a completed turn
✓ 3 files changed · 2 commands
8 步 · 955.0k tok · 缓存 97% · ¥0.32 · 2m14s ▾                    ← receipt
  未缓存输入 30.0k   缓存读取 900.0k
  输出 25.0k         模型 deepseek-flash
  时段 峰时价
```

## Requirements

- A DSH client that composes `webServer` and `sessionProjections` (the Desktop client and
  `dsh web` both do). The coach needs only the shipped session projections; the receipt needs the
  Host half to fold per-turn usage.
- Node 20+ only for the test/install scripts; the plugin itself has **no build step**.

## Install

```sh
git clone https://github.com/marksimZ/dsh-usage-kit.git dsh-usage-kit
```

One-off run:

```sh
dsh web --patch /absolute/path/to/dsh-usage-kit/cordis.patch.yml
```

Permanent install into a profile's patch layer (the installer picks `desktop` when that profile
exists, else `web`):

```sh
node scripts/install.mjs            # writes $DSH_HOME/profiles/<profile>/cordis.patch.yml
node scripts/install.mjs --dry-run
```

Verify the running GUI serves it:

```sh
node scripts/verify-deployed.mjs --url http://127.0.0.1:<GUI 端口>
```

> The Host half is a new plugin row, so it loads on the next client start; the browser half reloads
> with a normal page refresh. Nothing about the existing `dsh-balance-guard` changes.

## Configuration

Every key is optional; defaults live in `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `widgets.coach` | `true` | Register the context-coach row |
| `widgets.receipt` | `true` | Register the turn-receipt line |
| `coach.occupancyWarn` | `0.8` | Occupancy ratio that triggers the compaction advice |
| `coach.projectedWarn` | `0.9` | Projected next-request ratio that triggers it |
| `coach.cacheHitFloor` | `0.8` | Cache-hit ratio below which the "repeated input" hint appears |
| `coach.minPromptTokens` | `20000` | Minimum prompt tokens before that hint is worth showing |
| `cnyPerUsd` | `7.2` | Display conversion for the receipt amount |
| `holidays` | `[]` | UTC dates billed at off-peak all day (CN public holidays) |
| `turnsKept` | `300` | Completed turns kept per session for receipts |

Prices live in [`src/pricing.js`](src/pricing.js) (USD per 1M tokens, peak and off-peak rows for
`deepseek-flash` and `deepseek-v4-pro`), pinned by `scripts/pricing-spec.mjs`. Peak is
Monday–Friday `01:00–04:00` and `06:00–10:00` UTC, excluding `holidays`.

## Architecture

```text
Host half (src/index.ts)
  ctx.on('session/event')
    request/context      → the routed model for the turn
    turn/start           → open a turn (steps, running usage total)
    assistant/message    → add its billed usage sample (retries add another)
    turn/end             → price the turn and publish a receipt
  src/pricing.js                                 → price catalog, peak calendar, billing math (pure)
  └─ GET /dsh-usage-kit/receipts?session=<id>    → { byTurn, bySeq } receipts
  └─ globalThis.__DSH_USAGE_KIT_CONFIG__         → widget switches for the browser half

Browser half (src/client.js)
  conversation.input.dock   → context coach (reads contextPressure / contextBreakdown / tokenUsage)
  conversation.chat.turnTail → turn receipt (fetches the session's receipts, cached 10s)
```

**Why a Host half at all?** Per-turn usage cannot be derived from the cumulative `tokenUsage`
projection in the browser, so the Host folds each turn from the provider-reported
`assistant/message.usage` samples, prices it and publishes it. The coach needs no Host data and
runs entirely on the shipped projections.

**Why two lookup keys?** The transcript entry receives the closing **node** seq, which is not the
`turn/end` event seq, so a seq-only index misses. Receipts are therefore published under the turn
number (primary) and the end seq (fallback), and the browser resolves the turn id defensively from
the `TurnLocation` it receives.

**Why `conversation.chat.turnTail` and `conversation.input.dock`?** They are the two document
seats that already receive `useProjection` and the input/chat hooks; registering a fresh `id`
adds an entry beside the shipped ones instead of replacing them (`replaceRisk: none`).

## Tests

```sh
npm test          # pricing spec + client spec + bundle smoke + theme tokens + visual tokens
npm run test:host # folds three turns on a mock context and drives the real receipts route
npm run verify    # read-only probe of a running GUI
```

| Script | What it pins |
|---|---|
| `scripts/pricing-spec.mjs` | the official price table, the peak/off-peak calendar, billing math, usage deltas |
| `scripts/client-spec.mjs` | coach advice rules (occupancy / projected / cache), transcript turn identity, receipt summary and detail, formatters, injected switches |
| `scripts/client-smoke.mjs` | bundle contract, one stylesheet, two seat registrations, per-widget switches |
| `scripts/host-smoke.mjs` | usage accumulation from assistant samples (retries add up), model from request/context, byTurn/bySeq keys, cost, injections, route edges |
| `scripts/theme-tokens.mjs` | every `var(--dsw-*)` is declared by the shipped theme |
| `scripts/visual-tokens.mjs` | no raw colours, radii/type only from the theme scale, no infinite animation |
| `scripts/verify-deployed.mjs` | the running GUI serves the bundle and the receipts route |

## Limitations

- **Receipts start when the plugin loads.** Turns completed before the Host half was mounted have
  no folded receipt, so their tail line simply does not render (nothing is guessed).
- **The coach is advice, not automation.** It never compacts on its own; the button runs the
  shipped `/compact` command and surfaces a refusal as inline text.
- **Amounts are estimates of list price**, not a bill: they use the catalog and the period at turn
  end, not the provider's deferred settlement.
- **One row, two widgets.** Deleting a widget is a source edit (remove its registration block) or a
  config switch; there is no per-widget install row by design.

## License

MIT — see [LICENSE](LICENSE).
