import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const DEFAULTS = {
  browser_path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data",
  profile_name: "Default",
  target_gemini_url: "https://gemini.google.com/u/1/app/2a5b61cc5f1a0e3b",
  timeout_ms: 480000,
  retry_count: 2,
  dry_run: false,
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const params = { ...DEFAULTS };
  const logs = [];
  const args = argv.slice(2);

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      return {
        ...params,
        ...parsed,
        retry_count: Number.isFinite(Number(parsed.retry_count)) ? Number(parsed.retry_count) : params.retry_count,
        timeout_ms: Number.isFinite(Number(parsed.timeout_ms)) ? Number(parsed.timeout_ms) : params.timeout_ms,
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        logs,
      };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    if (token === "--dry-run" || token === "--dry_run") {
      params.dry_run = true;
      continue;
    }
    if (!next || next.startsWith("--")) continue;

    if (token === "--video_prompt") {
      params.video_prompt = next;
      index += 1;
      continue;
    }
    if (token === "--browser_path") {
      params.browser_path = next;
      index += 1;
      continue;
    }
    if (token === "--user_data_dir") {
      params.user_data_dir = next;
      index += 1;
      continue;
    }
    if (token === "--profile_name") {
      params.profile_name = next;
      index += 1;
      continue;
    }
    if (token === "--target_gemini_url") {
      params.target_gemini_url = next;
      index += 1;
      continue;
    }
    if (token === "--timeout_ms") {
      params.timeout_ms = Number(next);
      index += 1;
      continue;
    }
    if (token === "--retry_count") {
      params.retry_count = Number(next);
      index += 1;
      continue;
    }
  }

  return { ...params, logs };
}

function validateInput(params) {
  const missing = [];
  if (typeof params.video_prompt !== "string" || params.video_prompt.trim() === "") missing.push("video_prompt");
  if (typeof params.target_gemini_url !== "string" || params.target_gemini_url.trim() === "") missing.push("target_gemini_url");
  if (typeof params.browser_path !== "string" || params.browser_path.trim() === "") missing.push("browser_path");
  if (typeof params.user_data_dir !== "string" || params.user_data_dir.trim() === "") missing.push("user_data_dir");
  if (typeof params.profile_name !== "string" || params.profile_name.trim() === "") missing.push("profile_name");
  return missing;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

async function withRetry(taskName, tries, logs, fn) {
  const total = Math.max(1, Math.floor(tries || 1));
  let latestError = null;

  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      logs.push(`[retry] ${taskName} attempt ${attempt}/${total}`);
      return await fn();
    } catch (error) {
      latestError = error;
      logs.push(`[retry] ${taskName} failed at attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < total) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  throw latestError;
}

async function dismissPopupsIfAny(page, logs) {
  const selectors = [
    'button[aria-label*="Close" i]',
    'button[mattooltip*="Close" i]',
    'button:has-text("Got it")',
    'button:has-text("Đã hiểu")',
    'button:has-text("OK")',
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 500 })) {
        await locator.click({ timeout: 1000 });
        logs.push(`[ui] Dismissed popup by selector: ${selector}`);
      }
    } catch {}
  }
}

async function locatePromptEditor(page) {
  const selectors = [
    '.ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 8000 });
      return { locator, selector };
    } catch {}
  }

  throw new Error('Cannot find Gemini prompt input field');
}

async function setPromptRobust(page, prompt, logs) {
  const { locator, selector } = await locatePromptEditor(page);
  const handle = await locator.elementHandle();
  if (!handle) throw new Error('Prompt editor handle is unavailable');

  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 3000 });

  await page.evaluate((el) => {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } else {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, handle);

  const lines = String(prompt).replace(/\r/g, '').split('\n');
  const first = lines.shift() ?? '';

  await locator.type(first, { delay: 8 });
  for (const line of lines) {
    await page.keyboard.press('Shift+Enter');
    if (line) await locator.type(line, { delay: 8 });
  }

  await page.waitForTimeout(300);

  const actual = normalizeText(await page.evaluate((el) => {
    if (el.isContentEditable) return el.innerText || el.textContent || '';
    return el.value || '';
  }, handle));

  const expected = normalizeText(prompt);
  if (actual !== expected) {
    throw new Error(`Prompt verification failed. Expected: ${JSON.stringify(expected)} | Actual: ${JSON.stringify(actual)}`);
  }

  logs.push(`[step3] Prompt set and verified on: ${selector}`);
}

async function submitPrompt(page, logs) {
  const submitCandidates = [
    'button.send-button',
    'button[aria-label="Gửi tin nhắn"]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
  ];

  for (const selector of submitCandidates) {
    try {
      const button = page.locator(selector).first();
      await button.waitFor({ state: 'visible', timeout: 3000 });
      await button.click({ force: true, timeout: 3000 });
      logs.push(`[step4] Prompt submitted by button: ${selector}`);
      return;
    } catch {}
  }

  await page.keyboard.press('Enter');
  logs.push('[step4] Prompt submitted by Enter key');
}

async function getVideoMenuCount(page) {
  return await page.locator('[data-test-id="more-menu-button"]').count();
}

async function detectQuotaMessage(page) {
  const messageLocators = [
    page.locator('message-content').last(),
    page.locator('.model-response-text').last(),
    page.locator('model-response').last(),
  ];

  for (const locator of messageLocators) {
    try {
      const text = await locator.innerText({ timeout: 500 });
      const normalized = normalizeText(text).toLowerCase();
      if (!normalized) continue;

      const limitHints = ['tối đa', 'giới hạn', 'hết lượt', 'limit', 'quota', 'reached', 'không thể tạo thêm'];
      const mediaHints = ['video', 'veo'];
      const hasLimit = limitHints.some((kw) => normalized.includes(kw));
      const hasMedia = mediaHints.some((kw) => normalized.includes(kw));
      if (hasLimit && hasMedia) return text;
    } catch {}
  }

  return null;
}

async function waitForFreshVideoMenu(page, beforeMenuCount, logs, timeoutMs) {
  logs.push(`[step5] Waiting for a fresh video result by menu count (timeout: ${Math.floor(timeoutMs / 1000)}s)...`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const quotaMessage = await detectQuotaMessage(page);
    if (quotaMessage) {
      throw new Error(`QUOTA_REACHED: ${quotaMessage}`);
    }

    const currentMenuCount = await getVideoMenuCount(page);
    if (currentMenuCount > beforeMenuCount) {
      const freshIndex = beforeMenuCount;
      const freshMenuButton = page.locator('[data-test-id="more-menu-button"]').nth(freshIndex);
      const videoScope = freshMenuButton.locator('xpath=ancestor::*[.//video][1]').first();
      const videoElement = videoScope.locator('video').first();

      const hasVideo = await videoElement.count().then((n) => n > 0).catch(() => false);
      if (hasVideo) {
        await freshMenuButton.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout(2500);
        logs.push(`[step5] Fresh video identified by menu index ${freshIndex} (menu count ${beforeMenuCount} -> ${currentMenuCount})`);
        return { freshIndex, freshMenuButton, videoScope, videoElement };
      }
    }

    await page.waitForTimeout(3000);
  }

  throw new Error(`Timeout: Gemini did not create a new video action menu in ${Math.floor(timeoutMs / 1000)} seconds.`);
}

async function downloadVideoFromMenu(page, freshTarget, outputDir, logs) {
  const { freshIndex, freshMenuButton } = freshTarget;
  await freshMenuButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(700);

  await freshMenuButton.click({ force: true, timeout: 5000 });
  logs.push(`[step6] Opened video menu for fresh index ${freshIndex}`);

  const menuItemSelectors = [
    '[data-test-id="video-download-button"]',
    '[data-test-id="download-video-button"]',
    'button:has-text("Tải video xuống")',
    'button:has-text("Tải video")',
    'button:has-text("Download video")',
    'button:has-text("Download")',
  ];

  for (const selector of menuItemSelectors) {
    const item = page.locator(selector).last();
    const exists = await item.count().then((n) => n > 0).catch(() => false);
    if (!exists) continue;

    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
      await item.click({ force: true, timeout: 5000 });
      const download = await downloadPromise;
      const suggested = download.suggestedFilename() || `gemini-video-${nowStamp()}.mp4`;
      const safeName = /\.(mp4|webm|mov|mkv)$/i.test(suggested) ? suggested : `gemini-video-${nowStamp()}.mp4`;
      const filePath = path.join(outputDir, safeName);
      await download.saveAs(filePath);
      logs.push(`[step6] Downloaded fresh video from menu item ${selector} -> ${filePath}`);
      return filePath;
    } catch (error) {
      logs.push(`[step6] Download click via ${selector} failed for fresh index ${freshIndex}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error('Cannot trigger video download from the fresh block menu');
}

async function fallbackCapture(freshTarget, outputDir, logs) {
  const { videoElement } = freshTarget;
  const hasVideo = await videoElement.count().then((n) => n > 0).catch(() => false);
  if (!hasVideo) throw new Error('Fresh video element is unavailable for fallback capture');

  const poster = await videoElement.getAttribute('poster').catch(() => null);
  if (poster) {
    logs.push(`[step6] Video poster found for fallback: ${poster}`);
  }

  const screenshotPath = path.join(outputDir, `gemini-video-poster-${nowStamp()}.png`);
  await videoElement.screenshot({ path: screenshotPath });
  logs.push(`[step6] Saved video screenshot as fallback -> ${screenshotPath}`);
  return screenshotPath;
}

async function downloadFreshVideo(page, freshTarget, outputDir, logs) {
  try {
    return await downloadVideoFromMenu(page, freshTarget, outputDir, logs);
  } catch (error) {
    logs.push(`[step6] Menu-based download failed, fallback to capture: ${error instanceof Error ? error.message : String(error)}`);
    return await fallbackCapture(freshTarget, outputDir, logs);
  }
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, '[start] gemini_generate_video invoked'];
  const artifacts = [];

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(buildResult({
      success: false,
      message: 'Missing required inputs',
      logs,
      error: { code: 'VALIDATION_ERROR', details: `Missing fields: ${missing.join(', ')}` },
    }));
    process.exit(1);
  }

  const browserPath = path.normalize(parsed.browser_path);
  const userDataDir = path.normalize(parsed.user_data_dir);
  const profileName = parsed.profile_name.trim();
  const targetGeminiUrl = parsed.target_gemini_url.trim();
  const videoPrompt = parsed.video_prompt.trim();
  const timeoutMs = Number.isFinite(Number(parsed.timeout_ms)) ? Math.max(60000, Number(parsed.timeout_ms)) : DEFAULTS.timeout_ms;
  const retryCount = Number.isFinite(Number(parsed.retry_count)) ? Math.max(1, Math.min(4, Math.floor(Number(parsed.retry_count)))) : DEFAULTS.retry_count;

  const artifactsDir = path.join(process.cwd(), 'artifacts', 'videos');
  await mkdir(artifactsDir, { recursive: true });

  logs.push(`[input] target_gemini_url=${targetGeminiUrl}`);
  logs.push(`[input] profile_name=${profileName}`);

  if (parsed.dry_run) {
    printResult(buildResult({
      success: true,
      message: 'Dry run completed.',
      data: { video_prompt: videoPrompt, target_gemini_url: targetGeminiUrl },
      logs,
    }));
    return;
  }

  let context;

  try {
    logs.push('[step1] Opening Edge browser...');
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: browserPath,
      headless: true,
      acceptDownloads: true,
      args: [`--profile-directory=${profileName}`],
      viewport: { width: 1440, height: 900 },
    });

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(targetGeminiUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await dismissPopupsIfAny(page, logs);

    const screenshotBefore = path.join(artifactsDir, `gemini-video-before-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotBefore, fullPage: true });
    artifacts.push({ type: 'screenshot_before', path: path.relative(process.cwd(), screenshotBefore).replace(/\\/g, '/') });

    const beforeMenuCount = await getVideoMenuCount(page);
    logs.push(`[step2] Existing video/action menu count before submit: ${beforeMenuCount}`);

    await withRetry('step3-4-submit-prompt', retryCount, logs, async () => {
      await setPromptRobust(page, videoPrompt, logs);
      await submitPrompt(page, logs);
    });

    let freshTarget;
    try {
      freshTarget = await withRetry('step5-wait-video', retryCount, logs, async () => {
        return await waitForFreshVideoMenu(page, beforeMenuCount, logs, timeoutMs);
      });
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      if (details.includes('QUOTA_REACHED')) {
        printResult(buildResult({
          success: false,
          message: 'You have reached your daily limit for Veo video generation.',
          logs,
          error: { code: 'QUOTA_EXCEEDED', details },
        }));
        process.exit(0);
      }
      throw error;
    }

    const downloadedPath = await withRetry('step6-download-video', retryCount, logs, async () => {
      return await downloadFreshVideo(page, freshTarget, artifactsDir, logs);
    });

    if (/\.(mp4|webm|mov|mkv)$/i.test(downloadedPath)) {
      artifacts.push({ type: 'generated_video', path: path.relative(process.cwd(), downloadedPath).replace(/\\/g, '/') });
    } else {
      artifacts.push({ type: 'generated_video_fallback', path: path.relative(process.cwd(), downloadedPath).replace(/\\/g, '/') });
    }

    const screenshotAfter = path.join(artifactsDir, `gemini-video-after-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotAfter, fullPage: true });
    artifacts.push({ type: 'screenshot_after', path: path.relative(process.cwd(), screenshotAfter).replace(/\\/g, '/') });

    logs.push('[step8] Video flow completed');
    printResult(buildResult({
      success: true,
      message: 'Video generated successfully',
      data: {
        video_prompt: videoPrompt,
        downloaded_video_path: path.relative(process.cwd(), downloadedPath).replace(/\\/g, '/'),
        target_gemini_url: targetGeminiUrl,
      },
      artifacts,
      logs,
    }));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logs.push(`[fail] Flow failed: ${details}`);
    printResult(buildResult({
      success: false,
      message: 'Video generation failed',
      logs,
      error: { code: 'FLOW_FAILED', details },
    }));
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
})();
