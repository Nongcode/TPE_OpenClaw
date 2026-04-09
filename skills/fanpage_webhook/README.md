# Fanpage Webhook (24/7)

Production webhook service for Facebook Messenger CSKH that:
- Verifies Meta webhook challenge (`GET /webhook`)
- Validates signature (`x-hub-signature-256`)
- Deduplicates repeated message events
- ACKs quickly and processes asynchronously via in-memory queue
- Filters out unsupported events (`echo`, `read`, `delivery`, `postback`, ...)
- Enforces product-intent guard: must run `search_product_text` before product answers

## Environment variables

Required:
- `FACEBOOK_PAGE_ACCESS_TOKEN`
- `FACEBOOK_VERIFY_TOKEN` (or `VERIFY_TOKEN`)
- `FB_APP_SECRET`

Recommended:
- `OPENCLAW_GATEWAY_TOKEN` (if not in `~/.openclaw/openclaw.json`)
- `OPENCLAW_AGENT_ID` (default: `nv_consultant`)
- `PORT` (default: `3000`)

Operational tuning:
- `QUEUE_CONCURRENCY` (default: `4`)
- `MAX_RETRIES` (default: `5`)
- `BASE_RETRY_MS` (default: `2000`)
- `PER_SENDER_WINDOW_MS` (default: `60000`)
- `PER_SENDER_MAX` (default: `5`)
- `GLOBAL_WINDOW_MS` (default: `60000`)
- `GLOBAL_MAX` (default: `120`)
- `DEDUPE_TTL_MS` (default: `900000`)

Product guard:
- `SEARCH_PRODUCT_TARGET_SITE` (default: `uptek.vn`)
- `SEARCH_PRODUCT_CATEGORY_HINT` (optional)
- `SEARCH_TOOL_TIMEOUT_MS` (default: `90000`)

## Install and run

```bash
cd skills/fanpage_webhook
npm install
npm start
```

Or from repo root:

```bash
npm --prefix skills/fanpage_webhook install
npm --prefix skills/fanpage_webhook start
```

## Meta webhook setup

1. Expose local port:

```bash
ngrok http 3000
```

2. In Meta App Webhooks, set callback URL:
- `https://<your-ngrok-domain>/webhook`

3. Set verify token exactly equal to `FACEBOOK_VERIFY_TOKEN`.

4. Subscribe Page events:
- `messages`
- `messaging_postbacks` (optional for future)
- `messaging_reads` (optional, currently ignored)
- `message_deliveries` (optional, currently ignored)

## API endpoints

- `GET /healthz`: health check
- `GET /webhook`: Meta verify challenge
- `POST /webhook`: receive Messenger events
- `GET /admin/queue`: queue depth and active workers
- `GET /admin/metrics`: queue/rate/dedupe metrics
- `GET /admin/last-errors`: rolling error buffer

## Smoke tests

Health check:

```bash
curl -sS http://127.0.0.1:3000/healthz
```

Webhook verify:

```bash
curl -i "http://127.0.0.1:3000/webhook?hub.mode=subscribe&hub.verify_token=$FACEBOOK_VERIFY_TOKEN&hub.challenge=12345"
```

Queue/admin metrics:

```bash
curl -sS http://127.0.0.1:3000/admin/metrics
```

## Product-intent enforcement

When user message matches product intent (price/spec/model/product lookup), server runs `skills/search_product_text/action.js` first.

Behavior:
- Tool success: prepend structured tool result into agent prompt
- Tool failure/no data: send safe fallback to user and skip speculative product answer

## Recommended `nv_consultant` policy snippet

Add this into your agent/system prompt:

- For product/pricing/spec questions, only answer based on `search_product_text` output.
- If missing data, clearly say unavailable and ask follow-up.
- Never invent product facts, model compatibility, or pricing.

## Deployment checklist

- Set all required env vars in process manager/container platform.
- Ensure OpenClaw gateway is reachable and authenticated.
- Put HTTPS reverse proxy in front of service.
- Restrict inbound traffic to Meta IP ranges if possible.
- Monitor `GET /admin/metrics` and `GET /admin/last-errors`.
- Rotate `FACEBOOK_PAGE_ACCESS_TOKEN` and `OPENCLAW_GATEWAY_TOKEN` periodically.
