import { execFile } from 'node:child_process';
import crypto, { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import fetch from 'node-fetch';

const execFileAsync = promisify(execFile);
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

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
    },
  })
);

const FACEBOOK_PAGE_ACCESS_TOKEN =
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN || '';

const HARDCODED_PAGES = {
  "1021996431004626": "EAANUeplbZCAwBRV5cJoU08nIySrQfhoyln4Hf7JOhcUXxRHxMDjN6XaZAckdmV4EiiC7B4HVqZAagIMSlR6L3ZBKrZABpfM4F6AuHVZCyzDp880CEACQAtUi0bo5ZAF7hPyxHdfgzQx5kvkqTBav47ocjmhH00hSzZAWsp1VwlKhfCeWGAGx0mbJiybkZBjUQ78i12cZAuZA8AWNmd2iP3PKlp8GwZDZD",
  "1129362243584971": "EAANUeplbZCAwBRcIpRwhl4ZBm0snseVLldRUE4C4MCSZCv6fZCQkR2A90rx2ZCiZAsQF4BjYguJcfpaq9hfzpocMSSS8RYCROPQCOho8vCMm0n8xOV7lV7Wm2EKjZArnhTqWOPHjFIZBHzw5om62jZAW70tYiNzV4h2t2v9FZBZB0Wc3zF3zNcZAQgzLIXZBy4d2F1CTfbtwJLDuE1lUkcRS0qub1ZBgZDZD",
};

function getPageAccessToken(pageId) {
  return HARDCODED_PAGES[pageId] || FACEBOOK_PAGE_ACCESS_TOKEN;
}

const FACEBOOK_VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN || process.env.VERIFY_TOKEN || '';
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';
const OPENCLAW_HOME =
  process.env.OPENCLAW_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.openclaw');
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'nv_consultant';

const QUEUE_CONCURRENCY = Number.parseInt(process.env.QUEUE_CONCURRENCY || '4', 10) || 4;
const MAX_RETRIES = Number.parseInt(process.env.MAX_RETRIES || '5', 10) || 5;
const BASE_RETRY_MS = Number.parseInt(process.env.BASE_RETRY_MS || '2000', 10) || 2000;
const PER_SENDER_WINDOW_MS =
  Number.parseInt(process.env.PER_SENDER_WINDOW_MS || String(60_000), 10) || 60_000;
const PER_SENDER_MAX = Number.parseInt(process.env.PER_SENDER_MAX || '5', 10) || 5;
const GLOBAL_WINDOW_MS = Number.parseInt(process.env.GLOBAL_WINDOW_MS || String(60_000), 10) || 60_000;
const GLOBAL_MAX = Number.parseInt(process.env.GLOBAL_MAX || '120', 10) || 120;
const DEDUPE_TTL_MS =
  Number.parseInt(process.env.DEDUPE_TTL_MS || String(15 * 60_000), 10) || 15 * 60_000;
const SEARCH_TARGET_SITE = process.env.SEARCH_PRODUCT_TARGET_SITE || 'uptek.vn';
const SEARCH_CATEGORY_HINT = process.env.SEARCH_PRODUCT_CATEGORY_HINT || '';
const SEARCH_TOOL_TIMEOUT_MS =
  Number.parseInt(process.env.SEARCH_TOOL_TIMEOUT_MS || '90000', 10) || 90000;

const PRODUCT_INTENT_REGEX =
  /\b(gia|bao\s*gia|thong\s*so|chi\s*tiet|model|ma\s*san\s*pham|san\s*pham|cau\s*nang|may\s*ra\s*vao\s*lop|chan\s*doan|thiet\s*bi|bao\s*hanh)\b/i;

const jobQueue = [];
let processingCount = 0;
let queueWakeTimer = null;
let queueWakeAt = 0;
const senderHistory = new Map();
const globalSentTimestamps = [];
const processedMessageIds = new Map();
const lastErrors = [];
const lastEvents = [];
const counters = {
  webhookPostsReceived: 0,
  signaturePassed: 0,
  signatureFailed: 0,
  eventsParsed: 0,
  eventsSkipped: 0,
  eventsEnqueued: 0,
  dedupeHits: 0,
  queueRetries: 0,
  queueGiveups: 0,
  gatewayCalls: 0,
  gatewayFailures: 0,
  gatewayFallbackHttpCalls: 0,
  sendApiCalls: 0,
  sendApiFailures: 0,
  messagesSent: 0,
};

function redactText(text, max = 220) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function recordEvent(stage, details = {}) {
  const event = {
    at: new Date().toISOString(),
    stage,
    ...details,
  };
  lastEvents.unshift(event);
  if (lastEvents.length > 100) lastEvents.length = 100;
}

function assertRequiredConfiguration() {
  const missing = [];
  const hasHardcodedPages = Object.keys(HARDCODED_PAGES).length > 0;
  if (!FACEBOOK_PAGE_ACCESS_TOKEN.trim() && !hasHardcodedPages) missing.push('FACEBOOK_PAGE_ACCESS_TOKEN or hardcoded pages');
  if (!FACEBOOK_VERIFY_TOKEN.trim()) missing.push('FACEBOOK_VERIFY_TOKEN/VERIFY_TOKEN');
  if (!FB_APP_SECRET.trim()) missing.push('FB_APP_SECRET');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function recordError(stage, error, extra = {}) {
  const entry = {
    at: new Date().toISOString(),
    stage,
    message: error instanceof Error ? error.message : String(error),
    ...extra,
  };
  lastErrors.unshift(entry);
  if (lastErrors.length > 50) lastErrors.length = 50;
  console.error(`[fanpage-webhook][error][${stage}]`, entry);
  recordEvent('error', { stage, message: entry.message, ...extra });
}

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

function resolveGatewayHttpUrl() {
  if (process.env.OPENCLAW_GATEWAY_HTTP_URL) {
    return String(process.env.OPENCLAW_GATEWAY_HTTP_URL).trim();
  }
  const gatewayUrl = resolveGatewayUrl();
  try {
    const parsed = new URL(gatewayUrl);
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    parsed.pathname = '/v1/chat/completions';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return gatewayUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
  }
}

function resolveGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    return String(process.env.OPENCLAW_GATEWAY_TOKEN).trim();
  }
  const config = loadOpenClawConfig();
  const token = config?.gateway?.auth?.token;
  return typeof token === 'string' ? token.trim() : '';
}

function resolveGatewayCallModulePath() {
  const distDir = path.join(REPO_ROOT, 'dist');
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

function safeEqualString(left, right) {
  const leftBuf = Buffer.from(String(left || ''), 'utf8');
  const rightBuf = Buffer.from(String(right || ''), 'utf8');
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

function verifySignature(req) {
  const signatureHeader = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature_header' };
  }
  const [algorithm, providedHash] = signatureHeader.split('=');
  if (!providedHash || (algorithm && algorithm.toLowerCase() !== 'sha256')) {
    return { ok: false, reason: 'invalid_signature_header_format' };
  }

  const expectedHash = crypto
    .createHmac('sha256', FB_APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');
  const ok = safeEqualString(providedHash, expectedHash);
  return { ok, reason: ok ? 'ok' : 'digest_mismatch' };
}

function cleanSenderHistory(senderPsid) {
  const now = Date.now();
  const items = senderHistory.get(senderPsid) || [];
  const kept = items.filter((ts) => now - ts <= PER_SENDER_WINDOW_MS);
  senderHistory.set(senderPsid, kept);
  return kept;
}

function cleanGlobalSent() {
  const now = Date.now();
  while (globalSentTimestamps.length && now - globalSentTimestamps[0] > GLOBAL_WINDOW_MS) {
    globalSentTimestamps.shift();
  }
}

function cleanProcessedMessageIds() {
  const now = Date.now();
  for (const [messageId, createdAt] of processedMessageIds.entries()) {
    if (now - createdAt > DEDUPE_TTL_MS) {
      processedMessageIds.delete(messageId);
    }
  }
}

function isDuplicateMessageId(messageId) {
  const normalized = String(messageId || '').trim();
  if (!normalized) return false;
  cleanProcessedMessageIds();
  if (processedMessageIds.has(normalized)) {
    counters.dedupeHits += 1;
    recordEvent('dedupe.hit', { messageId: normalized });
    console.log(`[fanpage-webhook][dedupe] hit messageId=${normalized}`);
    return true;
  }
  processedMessageIds.set(normalized, Date.now());
  return false;
}

function buildAgentSessionKey(senderPsid) {
  const normalizedSender = String(senderPsid || 'unknown').replace(/[^a-zA-Z0-9:_-]/g, '_');
  return `agent:${OPENCLAW_AGENT_ID}:facebook:${normalizedSender}`;
}

function shouldSkipEvent(event) {
  if (!event || typeof event !== 'object') return true;
  if (event.delivery || event.read || event.reaction || event.optin) return true;
  if (!event.message || event.message.is_echo) return true;
  return false;
}

function extractIncomingText(event) {
  const text = String(event?.message?.text || '').trim();
  if (text) return text;
  const postbackPayload = String(event?.postback?.payload || '').trim();
  if (postbackPayload) return `POSTBACK: ${postbackPayload}`;
  return '';
}

function isProductIntent(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return PRODUCT_INTENT_REGEX.test(text);
}

function extractSearchKeyword(message) {
  const text = String(message || '').trim();
  if (!text) return '';
  const quoted = text.match(/["“”']([^"“”']{3,120})["“”']/);
  if (quoted?.[1]) return quoted[1].trim();
  return text
    .replace(/\s+/g, ' ')
    .replace(/[!?.,;:()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function runSearchProductText(keyword) {
  const actionPath = path.join(REPO_ROOT, 'skills', 'search_product_text', 'action.js');
  const payload = {
    keyword,
    target_site: SEARCH_TARGET_SITE,
    category_hint: SEARCH_CATEGORY_HINT,
  };

  const { stdout } = await execFileAsync(process.execPath, [actionPath, JSON.stringify(payload)], {
    cwd: REPO_ROOT,
    timeout: SEARCH_TOOL_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });

  const normalized = String(stdout || '').trim();
  if (!normalized) throw new Error('search_product_text returned empty output.');
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error('search_product_text returned invalid JSON.');
  }
}

function buildProductToolContext(data) {
  const productName = String(data?.product_name || '').trim();
  const productUrl = String(data?.product_url || '').trim();
  const specs = String(data?.specifications_text || '').trim();
  return [
    'TOOL_RESULT: search_product_text',
    productName ? `- product_name: ${productName}` : '- product_name: (missing)',
    productUrl ? `- product_url: ${productUrl}` : '- product_url: (missing)',
    specs ? `- specifications_text: ${specs}` : '- specifications_text: (missing)',
    '',
    'Response policy:',
    '- Only answer product facts present in this tool result.',
    '- If missing data (price/spec), say unavailable and ask follow-up.',
    '- Do not invent technical details or price.',
  ].join('\n');
}

async function resolveProductGuard(message) {
  if (!isProductIntent(message)) {
    return { required: false, ok: false, context: '', fallbackReply: '' };
  }

  const keyword = extractSearchKeyword(message);
  if (!keyword) {
    return {
      required: true,
      ok: false,
      context: '',
      fallbackReply:
        'Mình cần thêm tên hoặc mã sản phẩm cụ thể để tra cứu chính xác. Bạn gửi giúp mình model hoặc tên sản phẩm nhé.',
    };
  }

  try {
    const result = await runSearchProductText(keyword);
    if (!result?.success || !result?.data) {
      return {
        required: true,
        ok: false,
        context: '',
        fallbackReply:
          'Mình chưa tra cứu được dữ liệu sản phẩm lúc này. Bạn cho mình tên/model đầy đủ để mình kiểm tra lại ngay nhé.',
      };
    }
    return {
      required: true,
      ok: true,
      context: buildProductToolContext(result.data),
      fallbackReply: '',
    };
  } catch (error) {
    recordError('tool.search_product_text', error, { keyword });
    return {
      required: true,
      ok: false,
      context: '',
      fallbackReply:
        'Mình đang gặp lỗi khi tra cứu thông tin sản phẩm. Bạn gửi lại tên/model sản phẩm, mình sẽ kiểm tra ngay khi hệ thống ổn định.',
    };
  }
}

function extractChatCompletionText(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part?.type === 'text' && typeof part?.text === 'string') return part.text;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

async function callOpenClawViaHttp(message, senderPsid, gatewayToken) {
  counters.gatewayFallbackHttpCalls += 1;
  recordEvent('gateway.http.start', { senderPsid, agentId: OPENCLAW_AGENT_ID });
  console.log(`[fanpage-webhook][gateway:http] start sender=${senderPsid} agent=${OPENCLAW_AGENT_ID}`);
  const sessionKey = buildAgentSessionKey(senderPsid);
  const response = await fetch(resolveGatewayHttpUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': OPENCLAW_AGENT_ID,
      'x-openclaw-session-key': sessionKey,
    },
    body: JSON.stringify({
      model: `openclaw:${OPENCLAW_AGENT_ID}`,
      user: `facebook:${senderPsid}`,
      messages: [{ role: 'user', content: message }],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP fallback failed (${response.status}): ${JSON.stringify(payload).slice(0, 400)}`);
  }
  recordEvent('gateway.http.success', { senderPsid, status: response.status });
  console.log(`[fanpage-webhook][gateway:http] success sender=${senderPsid} status=${response.status}`);
  return extractChatCompletionText(payload) || 'Xin lỗi, hiện tại mình chưa có câu trả lời phù hợp.';
}

async function callOpenClaw(message, senderPsid) {
  counters.gatewayCalls += 1;
  recordEvent('gateway.ws.start', { senderPsid, agentId: OPENCLAW_AGENT_ID });
  console.log(`[fanpage-webhook][gateway:ws] start sender=${senderPsid} agent=${OPENCLAW_AGENT_ID}`);
  const gatewayToken = resolveGatewayToken();
  if (!gatewayToken) {
    throw new Error('Missing OPENCLAW_GATEWAY_TOKEN and no token found in openclaw.json');
  }

  const sessionKey = buildAgentSessionKey(senderPsid);
  try {
    const { callGateway } = await loadGatewayCallModule();
    const result = await callGateway({
      url: resolveGatewayUrl(),
      token: gatewayToken,
      method: 'agent',
      params: {
        message,
        agentId: OPENCLAW_AGENT_ID,
        sessionKey,
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
    recordEvent('gateway.ws.success', { senderPsid, payloadCount: payloads.length });
    console.log(`[fanpage-webhook][gateway:ws] success sender=${senderPsid} payloadCount=${payloads.length}`);
    return text || result?.summary || 'Xin lỗi, hiện tại mình chưa có câu trả lời phù hợp.';
  } catch (error) {
    counters.gatewayFailures += 1;
    recordError('openclaw.ws', error, { senderPsid, sessionKey });
    return callOpenClawViaHttp(message, senderPsid, gatewayToken);
  }
}

async function sendMetaMessage(senderPsid, text, pageId) {
  const body = {
    recipient: { id: senderPsid },
    message: { text: text || 'Xin lỗi, hiện tại mình chưa có câu trả lời phù hợp.' },
  };
  const accessToken = getPageAccessToken(pageId);
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${encodeURIComponent(accessToken)}`;
  counters.sendApiCalls += 1;
  recordEvent('send-api.start', {
    senderPsid,
    pageId,
    textPreview: redactText(text),
  });
  console.log(`[fanpage-webhook][send-api] start recipient=${senderPsid}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    counters.sendApiFailures += 1;
    const errorMessage = payload?.error?.message || `Meta API HTTP ${response.status}`;
    throw new Error(errorMessage);
  }
  counters.messagesSent += 1;
  recordEvent('send-api.success', {
    senderPsid,
    status: response.status,
    messageId: payload?.message_id || null,
  });
  console.log(`[fanpage-webhook][send-api] success recipient=${senderPsid} status=${response.status}`);
}

function markMessageSent(senderPsid) {
  const senderEvents = senderHistory.get(senderPsid) || [];
  senderEvents.push(Date.now());
  senderHistory.set(
    senderPsid,
    senderEvents.filter((ts) => Date.now() - ts <= PER_SENDER_WINDOW_MS)
  );
  globalSentTimestamps.push(Date.now());
}

function enqueueJob(job) {
  counters.eventsEnqueued += 1;
  recordEvent('queue.enqueue', {
    senderPsid: job.senderPsid,
    messageId: job.messageId || null,
    messagePreview: redactText(job.message),
  });
  console.log(
    `[fanpage-webhook][queue] enqueue sender=${job.senderPsid} mid=${job.messageId || '-'} text=${redactText(job.message, 120)}`
  );
  jobQueue.push({
    ...job,
    attempts: job.attempts || 0,
    nextAttemptAt: job.nextAttemptAt || Date.now(),
    createdAt: job.createdAt || Date.now(),
  });
  void processQueue();
}

function scheduleQueueWake(nextAttemptAt) {
  const targetTime = Number(nextAttemptAt) || Date.now();
  if (queueWakeTimer && targetTime >= queueWakeAt) {
    return;
  }
  if (queueWakeTimer) {
    clearTimeout(queueWakeTimer);
  }
  queueWakeAt = targetTime;
  const delay = Math.max(0, targetTime - Date.now());
  queueWakeTimer = setTimeout(() => {
    queueWakeTimer = null;
    queueWakeAt = 0;
    void processQueue();
  }, delay);
  queueWakeTimer.unref?.();
}

function scheduleRetry(job, delayMs, error) {
  counters.queueRetries += 1;
  const attempts = (job.attempts || 0) + 1;
  if (attempts > MAX_RETRIES) {
    counters.queueGiveups += 1;
    recordError('job.giveup', error, { jobId: job.id, senderPsid: job.senderPsid, attempts });
    return;
  }
  recordEvent('queue.retry', {
    senderPsid: job.senderPsid,
    attempts,
    delayMs: Math.max(1000, delayMs || BASE_RETRY_MS * Math.pow(2, attempts - 1)),
  });
  const nextAttemptAt = Date.now() + Math.max(1000, delayMs || BASE_RETRY_MS * Math.pow(2, attempts - 1));
  jobQueue.push({
    ...job,
    attempts,
    nextAttemptAt,
  });
  scheduleQueueWake(nextAttemptAt);
}

async function processQueue() {
  if (!jobQueue.length || processingCount >= QUEUE_CONCURRENCY) return;

  const now = Date.now();
  let earliestDeferredAt = Infinity;
  for (let index = 0; index < jobQueue.length && processingCount < QUEUE_CONCURRENCY; ) {
    const job = jobQueue[index];
    if (job.nextAttemptAt > now) {
      earliestDeferredAt = Math.min(earliestDeferredAt, job.nextAttemptAt);
      index += 1;
      continue;
    }
    jobQueue.splice(index, 1);
    processingCount += 1;
    void processJob(job)
      .catch((error) => {
        recordError('job.crash', error, { jobId: job.id, senderPsid: job.senderPsid });
      })
      .finally(() => {
        processingCount -= 1;
        void processQueue();
      });
  }

  if (processingCount < QUEUE_CONCURRENCY && Number.isFinite(earliestDeferredAt)) {
    scheduleQueueWake(earliestDeferredAt);
  }
}

async function processJob(job) {
  recordEvent('queue.process.start', {
    senderPsid: job.senderPsid,
    messageId: job.messageId || null,
    attempts: job.attempts || 0,
  });
  const senderSnapshot = cleanSenderHistory(job.senderPsid);
  if (senderSnapshot.length >= PER_SENDER_MAX) {
    const waitMs = PER_SENDER_WINDOW_MS - (Date.now() - senderSnapshot[0]) + 1000;
    scheduleRetry(job, waitMs, 'sender_rate_limited');
    return;
  }

  cleanGlobalSent();
  if (globalSentTimestamps.length >= GLOBAL_MAX) {
    const waitMs = GLOBAL_WINDOW_MS - (Date.now() - globalSentTimestamps[0]) + 1000;
    scheduleRetry(job, waitMs, 'global_rate_limited');
    return;
  }

  try {
    const guard = await resolveProductGuard(job.message);
    if (guard.required && !guard.ok) {
      await sendMetaMessage(job.senderPsid, guard.fallbackReply, job.pageId);
      markMessageSent(job.senderPsid);
      return;
    }

    const messageForAgent =
      guard.required && guard.ok
        ? [guard.context, '', `Customer message: ${job.message}`].join('\n')
        : job.message;

    const reply = await callOpenClaw(messageForAgent, job.senderPsid);
    await sendMetaMessage(job.senderPsid, reply, job.pageId);
    markMessageSent(job.senderPsid);
    recordEvent('queue.process.success', {
      senderPsid: job.senderPsid,
      messageId: job.messageId || null,
    });
    console.log(`[fanpage-webhook][queue] success sender=${job.senderPsid} mid=${job.messageId || '-'}`);
  } catch (error) {
    scheduleRetry(job, 0, error);
  }
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/admin/queue', (_req, res) => {
  res.json({ queueLength: jobQueue.length, processingCount });
});

app.get('/admin/metrics', (_req, res) => {
  cleanGlobalSent();
  cleanProcessedMessageIds();
  res.json({
    queueLength: jobQueue.length,
    processingCount,
    recentGlobalSent: globalSentTimestamps.length,
    dedupeCacheSize: processedMessageIds.size,
    counters,
  });
});

app.get('/admin/last-errors', (_req, res) => {
  res.json({ count: lastErrors.length, errors: lastErrors });
});

app.get('/admin/last-events', (_req, res) => {
  res.json({ count: lastEvents.length, events: lastEvents.slice(0, 10) });
});

app.get('/admin/config-check', (_req, res) => {
  const fbAppSecret = String(FB_APP_SECRET || '');
  const suspiciousFbAppSecret =
    fbAppSecret.includes('FACEBOOK_VERIFY_TOKEN=') || fbAppSecret.includes('FB_APP_SECRET=');
  res.json({
    hasFacebookPageAccessToken: Boolean(FACEBOOK_PAGE_ACCESS_TOKEN) || Object.keys(HARDCODED_PAGES).length > 0,
    hasFacebookVerifyToken: Boolean(FACEBOOK_VERIFY_TOKEN),
    hasFbAppSecret: Boolean(FB_APP_SECRET),
    hasOpenClawAgentId: Boolean(OPENCLAW_AGENT_ID),
    hasOpenClawGatewayUrl: Boolean(resolveGatewayUrl()),
    hasOpenClawGatewayHttpUrl: Boolean(resolveGatewayHttpUrl()),
    hasOpenClawGatewayToken: Boolean(resolveGatewayToken()),
    selectedAgentId: OPENCLAW_AGENT_ID,
    suspiciousFbAppSecret,
    queueConfig: {
      queueConcurrency: QUEUE_CONCURRENCY,
      maxRetries: MAX_RETRIES,
      baseRetryMs: BASE_RETRY_MS,
      perSenderWindowMs: PER_SENDER_WINDOW_MS,
      perSenderMax: PER_SENDER_MAX,
      globalWindowMs: GLOBAL_WINDOW_MS,
      globalMax: GLOBAL_MAX,
      dedupeTtlMs: DEDUPE_TTL_MS,
    },
  });
});

app.get('/webhook', (req, res) => {
  const mode = String(req.query['hub.mode'] || '').trim();
  const token = String(req.query['hub.verify_token'] || '').trim();
  const challenge = String(req.query['hub.challenge'] || '');

  if (mode !== 'subscribe' || !token) {
    res.sendStatus(400);
    return;
  }
  if (!safeEqualString(token, FACEBOOK_VERIFY_TOKEN)) {
    res.sendStatus(403);
    return;
  }
  res.status(200).send(challenge);
});

app.post('/webhook', (req, res) => {
  counters.webhookPostsReceived += 1;
  const body = req.body;
  recordEvent('webhook.post.received', {
    object: body?.object || null,
    contentType: String(req.headers['content-type'] || ''),
    hasSignature256: Boolean(req.headers['x-hub-signature-256']),
    hasSignature: Boolean(req.headers['x-hub-signature']),
  });
  console.log(
    `[fanpage-webhook][webhook] received object=${body?.object || '-'} contentType=${String(req.headers['content-type'] || '-')}`
  );

  const signature = verifySignature(req);
  if (!signature.ok) {
    counters.signatureFailed += 1;
    recordError('webhook.signature', 'Invalid signature', {
      reason: signature.reason,
      signature256: req.headers['x-hub-signature-256'] || null,
      signature: req.headers['x-hub-signature'] || null,
    });
    res.sendStatus(403);
    return;
  }
  counters.signaturePassed += 1;
  recordEvent('webhook.signature.pass');
  console.log('[fanpage-webhook][signature] pass');

  if (!body || body.object !== 'page') {
    recordEvent('webhook.reject.object', { object: body?.object || null });
    res.sendStatus(404);
    return;
  }

  res.status(200).send('EVENT_RECEIVED');

  for (const entry of body.entry || []) {
    const messagingEvents = Array.isArray(entry?.messaging) ? entry.messaging : [];
    const standbyEvents = Array.isArray(entry?.standby) ? entry.standby : [];
    const changesMessagingEvents = (Array.isArray(entry?.changes) ? entry.changes : [])
      .flatMap((change) => {
        const valueMessaging = change?.value?.messaging;
        return Array.isArray(valueMessaging) ? valueMessaging : [];
      });
    const events = [...messagingEvents, ...standbyEvents, ...changesMessagingEvents];

    for (const event of events) {
      counters.eventsParsed += 1;
      try {
        const senderPsid = String(event?.sender?.id || '').trim();
        const recipientPsid = String(event?.recipient?.id || '').trim();
        const incomingText = extractIncomingText(event);
        const hasPostback = Boolean(event?.postback?.payload);
        const messageId = String(event?.message?.mid || event?.message?.id || '').trim();

        if (shouldSkipEvent(event) && !hasPostback) {
          counters.eventsSkipped += 1;
          recordEvent('webhook.event.skipped', {
            senderPsid,
            recipientPsid,
            reason: 'shouldSkipEvent',
            hasText: Boolean(incomingText),
          });
          continue;
        }
        if (!senderPsid) {
          counters.eventsSkipped += 1;
          recordEvent('webhook.event.skipped', { reason: 'missing_sender_id' });
          continue;
        }

        if (!incomingText) {
          counters.eventsSkipped += 1;
          recordEvent('webhook.event.skipped', {
            senderPsid,
            recipientPsid,
            reason: 'missing_text_and_postback',
          });
          continue;
        }

        if (messageId && isDuplicateMessageId(messageId)) {
          continue;
        }

        recordEvent('webhook.event.accepted', {
          senderPsid,
          recipientPsid,
          messageId: messageId || null,
          messagePreview: redactText(incomingText),
          hasPostback,
        });
        console.log(
          `[fanpage-webhook][event] sender=${senderPsid} recipient=${recipientPsid || '-'} mid=${messageId || '-'} text=${redactText(incomingText, 120)}`
        );

        enqueueJob({
          id: crypto.randomUUID(),
          senderPsid,
          message: incomingText,
          messageId,
          pageId: recipientPsid,
        });
      } catch (error) {
        recordError('webhook.iteration', error);
      }
    }
  }
});

const PORT = Number.parseInt(process.env.PORT || '3002', 10) || 3002;

assertRequiredConfiguration();
setInterval(cleanProcessedMessageIds, Math.max(30_000, Math.floor(DEDUPE_TTL_MS / 3))).unref();

app.listen(PORT, () => {
  console.log(`Fanpage webhook listening on port ${PORT}`);
  console.log(
    JSON.stringify(
      {
        port: PORT,
        hasPageToken: Boolean(FACEBOOK_PAGE_ACCESS_TOKEN),
        hasVerifyToken: Boolean(FACEBOOK_VERIFY_TOKEN),
        hasAppSecret: Boolean(FB_APP_SECRET),
        openclawHome: OPENCLAW_HOME,
        openclawAgentId: OPENCLAW_AGENT_ID,
      },
      null,
      2
    )
  );
});

export default app;
