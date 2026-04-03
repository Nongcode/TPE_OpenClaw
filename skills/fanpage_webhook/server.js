import express from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const app = express();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

function loadDotEnv() {
  const envPaths = [path.join(SCRIPT_DIR, '.env'), path.join(process.cwd(), '.env')];
  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadDotEnv();

// capture raw body for signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
    },
  })
);

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'replace_verify_token';
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';
const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.openclaw');
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'nv_consultant';

function loadOpenClawConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(OPENCLAW_HOME, 'openclaw.json'), 'utf8').replace(/^\uFEFF/, '')
    );
  } catch {
    return {};
  }
}

function resolveGatewayUrl() {
  const config = loadOpenClawConfig();
  const port = Number(config?.gateway?.port) || 18789;
  return process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${port}`;
}

function resolveGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    return String(process.env.OPENCLAW_GATEWAY_TOKEN).trim();
  }
  const config = loadOpenClawConfig();
  const token = config?.gateway?.auth?.token;
  return typeof token === 'string' ? token.trim() : '';
}

function resolveRepoRoot() {
  return REPO_ROOT;
}

function resolveGatewayCallModulePath() {
  const distDir = path.join(resolveRepoRoot(), 'dist');
  const candidates = fs
    .readdirSync(distDir)
    .filter((name) => /^call-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, 'utf8');
    if (source.includes('export { buildGatewayConnectionDetails, callGateway,')) {
      return candidate;
    }
  }
  throw new Error('Cannot locate built gateway call module in dist/.');
}

let gatewayCallModulePromise = null;

async function loadGatewayCallModule() {
  if (!gatewayCallModulePromise) {
    gatewayCallModulePromise = import(pathToFileURL(resolveGatewayCallModulePath()).href);
  }
  return gatewayCallModulePromise;
}

// Queue and rate-limit configuration
const QUEUE_CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY) || 4;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 5;
const BASE_RETRY_MS = parseInt(process.env.BASE_RETRY_MS) || 2000;
const PER_SENDER_WINDOW_MS = parseInt(process.env.PER_SENDER_WINDOW_MS) || 60 * 1000; // 1 minute
const PER_SENDER_MAX = parseInt(process.env.PER_SENDER_MAX) || 5; // messages per sender per window
const GLOBAL_WINDOW_MS = parseInt(process.env.GLOBAL_WINDOW_MS) || 60 * 1000; // 1 minute
const GLOBAL_MAX = parseInt(process.env.GLOBAL_MAX) || 120; // messages per window

// In-memory queue and metrics (non-persistent)
const jobQueue = [];
let processingCount = 0;
const senderHistory = new Map(); // senderPsid -> [timestamps]
const globalSentTimestamps = [];

function cleanSenderHistory(sender) {
  const now = Date.now();
  const arr = senderHistory.get(sender) || [];
  const kept = arr.filter((ts) => now - ts <= PER_SENDER_WINDOW_MS);
  senderHistory.set(sender, kept);
  return kept;
}

function cleanGlobalSent() {
  const now = Date.now();
  while (globalSentTimestamps.length && now - globalSentTimestamps[0] > GLOBAL_WINDOW_MS) {
    globalSentTimestamps.shift();
  }
  return globalSentTimestamps;
}

function enqueueJob(job) {
  job.attempts = job.attempts || 0;
  job.nextAttemptAt = job.nextAttemptAt || Date.now();
  job.createdAt = job.createdAt || Date.now();
  job.lastError = job.lastError || null;
  job.failed = false;
  job.succeeded = false;
  jobQueue.push(job);
  processQueue();
}

function scheduleRetry(job, delayMs, err) {
  job.attempts = (job.attempts || 0) + 1;
  job.lastError = err ? String(err).slice(0, 1000) : null;
  if (job.attempts > MAX_RETRIES) {
    job.failed = true;
    console.warn(`Job ${job.id} failed after ${job.attempts} attempts`);
    return;
  }
  job.nextAttemptAt = Date.now() + Math.max(1000, delayMs || BASE_RETRY_MS * Math.pow(2, job.attempts - 1));
  jobQueue.push(job);
}

async function processQueue() {
  if (!jobQueue.length) return;
  if (processingCount >= QUEUE_CONCURRENCY) return;

  const now = Date.now();
  // process eligible jobs in FIFO order
  for (let i = 0; i < jobQueue.length && processingCount < QUEUE_CONCURRENCY; ) {
    const job = jobQueue[i];
    if (job.nextAttemptAt && job.nextAttemptAt > now) {
      i++;
      continue;
    }
    // remove from queue
    jobQueue.splice(i, 1);
    // fire-and-forget
    processJob(job).catch((e) => console.error('processJob error', e));
  }
}

async function processJob(job) {
  processingCount++;
  try {
    const now = Date.now();

    // per-sender rate limit
    const sHistory = cleanSenderHistory(job.senderPsid);
    if (sHistory.length >= PER_SENDER_MAX) {
      const waitMs = PER_SENDER_WINDOW_MS - (now - sHistory[0]) + 1000;
      console.log(`Delaying job ${job.id} for sender rate limit ${waitMs}ms`);
      scheduleRetry(job, waitMs, 'sender_rate_limited');
      return;
    }

    // global rate limit
    cleanGlobalSent();
    if (globalSentTimestamps.length >= GLOBAL_MAX) {
      const waitMs = GLOBAL_WINDOW_MS - (now - globalSentTimestamps[0]) + 1000;
      console.log(`Delaying job ${job.id} for global rate limit ${waitMs}ms`);
      scheduleRetry(job, waitMs, 'global_rate_limited');
      return;
    }

    // Execute AI call
    let aiReply;
    try {
      aiReply = await callOpenClaw(job.message);
    } catch (err) {
      console.error(`callOpenClaw failed for job ${job.id}:`, err?.message || err);
      scheduleRetry(job, BASE_RETRY_MS * Math.pow(2, job.attempts), err?.message || err);
      return;
    }

    // Send to Meta
    try {
      await sendMetaMessage(job.senderPsid, aiReply);
    } catch (err) {
      console.error(`sendMetaMessage failed for job ${job.id}:`, err?.message || err);
      scheduleRetry(job, BASE_RETRY_MS * Math.pow(2, job.attempts), err?.message || err);
      return;
    }

    // success: record metrics
    const arr = senderHistory.get(job.senderPsid) || [];
    arr.push(Date.now());
    // keep only recent
    senderHistory.set(job.senderPsid, arr.filter((ts) => Date.now() - ts <= PER_SENDER_WINDOW_MS));
    globalSentTimestamps.push(Date.now());
    job.succeeded = true;
    console.log(`Job ${job.id} processed successfully`);
  } finally {
    processingCount--;
    // let next items run
    setImmediate(processQueue);
  }
}

// Admin endpoints for inspection
app.get('/admin/queue', (req, res) => {
  const snapshot = jobQueue.map((j) => ({ id: j.id, sender: j.senderPsid, attempts: j.attempts, nextAttemptAt: j.nextAttemptAt, createdAt: j.createdAt, failed: !!j.failed, succeeded: !!j.succeeded }));
  res.json({ queueLength: jobQueue.length, processingCount, snapshot });
});

app.get('/admin/metrics', (req, res) => {
  cleanGlobalSent();
  res.json({ processingCount, queueLength: jobQueue.length, recentGlobalSent: globalSentTimestamps.length });
});

function verifySignature(req) {
  if (!FB_APP_SECRET) return true; // skip verification if secret not set (but recommended)
  const signatureHeader = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];
  if (!signatureHeader) return false;
  const sig = signatureHeader.toString();
  const [, hash] = sig.split('=');
  if (!hash) return false;
  const expected = crypto.createHmac('sha256', FB_APP_SECRET).update(req.rawBody || '').digest('hex');
  return hash === expected;
}

app.get('/webhook', (req, res) => {
  // Lấy mã xác minh từ biến môi trường
  const verifyToken = process.env.VERIFY_TOKEN || 'long100904';

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('WEBHOOK ĐÃ ĐƯỢC XÁC MINH THÀNH CÔNG!');
      res.status(200).send(challenge); // Bắt buộc phải trả lại challenge để Facebook gật đầu
    } else {
      console.log('Xác minh Webhook thất bại: Sai pass');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400); // Lỗi cú pháp
  }
});

app.post('/webhook', async (req, res) => {
  // Verify signature if secret provided
  if (FB_APP_SECRET && !verifySignature(req)) {
    console.warn('Invalid signature on incoming request');
    return res.sendStatus(403);
  }

  const body = req.body;
  if (body && body.object === 'page') {
    // quick 200 so Facebook doesn't retry while we process async
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        try {
          if (event.message && !event.message.is_echo) {
            const senderPsid = event.sender && event.sender.id;
            if (!senderPsid) continue;

            const customerMessage = event.message.text || '';
            if (!customerMessage) {
              // attachments, quick replies etc can be handled here
              console.log('Non-text message received, skipping for now');
              continue;
            }
                      // enqueue job for background processing (queue handles retries & rate limiting)
                      try {
                        enqueueJob({
                          id: crypto.randomUUID(),
                          senderPsid,
                          message: customerMessage,
                          attempts: 0,
                          createdAt: Date.now(),
                          nextAttemptAt: Date.now(),
                        });
                      } catch (e) {
                        console.error('Failed to enqueue job', e?.message || e);
                      }
          }
        } catch (e) {
          console.error('Error iterating messaging event', e?.message || e);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

async function callOpenClaw(message) {
  const gatewayToken = resolveGatewayToken();
  if (!gatewayToken) {
    throw new Error('Missing OPENCLAW_GATEWAY_TOKEN and no token found in openclaw.json');
  }
  try {
    const { callGateway } = await loadGatewayCallModule();
    const result = await callGateway({
      url: resolveGatewayUrl(),
      token: gatewayToken,
      method: 'agent',
      params: {
        message,
        agentId: OPENCLAW_AGENT_ID,
        sessionKey: `agent:${OPENCLAW_AGENT_ID}:main`,
        idempotencyKey: crypto.randomUUID(),
      },
      expectFinal: true,
      timeoutMs: Number(process.env.OPENCLAW_TIMEOUT_MS || 900000),
    });

    const payloads = Array.isArray(result?.result?.payloads) ? result.result.payloads : [];
    const text = payloads
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();

    return text || result?.summary || 'Xin loi, hien tai toi chua co cau tra loi.';

    // Try to parse JSON output and extract first textual payload if present
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed === 'object') {
        // common shapes: { result: { payloads: [...] } }
        if (parsed.result && Array.isArray(parsed.result.payloads)) {
          for (const p of parsed.result.payloads) {
            if (typeof p.text === 'string' && p.text.trim()) return p.text.trim();
            if (typeof p.assistantText === 'string' && p.assistantText.trim()) return p.assistantText.trim();
            if (p.data && typeof p.data.assistant_text === 'string' && p.data.assistant_text.trim()) return p.data.assistant_text.trim();
          }
        }
        if (parsed.reply && typeof parsed.reply === 'string') return parsed.reply.trim();
      }
    } catch (e) {
      // not JSON, fall back to raw stdout
    }

    return out || 'Xin lỗi, tôi không có câu trả lời ngay.';
  } catch (err) {
    console.error('callOpenClaw failed:', err?.message || err);
    throw err;
  }
}

async function sendMetaMessage(senderPsid, text) {
  if (!PAGE_ACCESS_TOKEN) throw new Error('Missing PAGE_ACCESS_TOKEN environment variable');

  const requestBody = {
    recipient: { id: senderPsid },
    message: { text: text || 'Xin lỗi, hiện tại tôi chưa có câu trả lời.' },
  };

  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const data = await resp.json();
    if (!resp.ok) console.error('Meta API error:', resp.status, data);
    return data;
  } catch (err) {
    console.error('Failed to send message to Meta:', err?.message || err);
    throw err;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Fanpage webhook listening on port ${PORT}`);
  console.log(
    JSON.stringify(
      {
        port: Number(PORT),
        hasPageToken: Boolean(PAGE_ACCESS_TOKEN),
        hasVerifyToken: Boolean(VERIFY_TOKEN),
        hasAppSecret: Boolean(FB_APP_SECRET),
        openclawHome: OPENCLAW_HOME,
        openclawAgentId: OPENCLAW_AGENT_ID,
        gatewayUrl: resolveGatewayUrl(),
        hasGatewayToken: Boolean(resolveGatewayToken()),
      },
      null,
      2
    )
  );
});

export default app;
