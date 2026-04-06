# Fanpage webhook (OpenClaw)

This small Express app accepts Facebook Messenger webhook events, forwards the customer's text to an OpenClaw agent (`nv_consultant`) and replies back to the sender.

Environment variables
- `PAGE_ACCESS_TOKEN` (required): Facebook Page access token
- `VERIFY_TOKEN` (required for webhook setup): verify token you set in Meta Webhooks
- `FB_APP_SECRET` (recommended): App secret for `x-hub-signature-256` verification
- `OPENCLAW_BIN` (optional): openclaw CLI binary path (default `openclaw`)
- `OPENCLAW_GATEWAY_HTTP_URL` (optional): explicit HTTP fallback endpoint, e.g. `http://127.0.0.1:18789/v1/chat/completions`
- `PORT` (optional): server port (default `3000`)

Run locally

1. Install deps inside the skill folder:

```bash
cd skills/fanpage_webhook
npm install
```

2. Run server (set env vars first):

```bash
PAGE_ACCESS_TOKEN=... VERIFY_TOKEN=... FB_APP_SECRET=... npm start
```

Testing
- Use `ngrok http 3000` and add the `https://<your-ngrok>.ngrok.io/webhook` URL to your Facebook app webhook settings. Use `VERIFY_TOKEN` when setting up the webhook.

Notes & recommendations
- Current implementation uses the `openclaw` CLI via `execFile`. For production, prefer calling OpenClaw's gateway/HTTP API or SDK rather than shelling out.
- The server returns HTTP 200 immediately and processes messages asynchronously to avoid FB timeouts.
- The code verifies `x-hub-signature-256` if `FB_APP_SECRET` is set. Do not skip this in production.
- Add queueing/rate-limiting if you expect high message volume.
