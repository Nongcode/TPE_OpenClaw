import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildChatImageReplyPayload } from "../shared/chat-image-result.js";

const DEFAULTS = {
  browser_path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  user_data_dir: "C:/Users/PHAMDUCLONG/AppData/Local/Microsoft/Edge/User Data",
  profile_name: "Default",
  target_gemini_url: "https://gemini.google.com/app/5674ef324b03c392",
  image_paths: [],
  timeout_ms: 120000,
  retry_count: 2,
  dry_run: false,
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|;|,/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
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
        image_paths: parseList(parsed.image_paths),
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
    if (!next || next.startsWith("--")) {
      continue;
    }
    if (token === "--image_prompt") {
      params.image_prompt = next;
      index += 1;
      continue;
    }
    if (token === "--image_paths") {
      params.image_paths = parseList(next);
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
  if (typeof params.image_prompt !== "string" || params.image_prompt.trim() === "") missing.push("image_prompt");
  if (typeof params.browser_path !== "string" || params.browser_path.trim() === "") missing.push("browser_path");
  if (typeof params.user_data_dir !== "string" || params.user_data_dir.trim() === "") missing.push("user_data_dir");
  if (typeof params.profile_name !== "string" || params.profile_name.trim() === "") missing.push("profile_name");
  if (typeof params.target_gemini_url !== "string" || params.target_gemini_url.trim() === "") missing.push("target_gemini_url");
  return missing;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureReadableFiles(pathsToCheck) {
  for (const filePath of pathsToCheck) {
    await access(filePath);
  }
}

async function withRetry(taskName, tries, logs, fn) {
  let latestError = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      logs.push(`[retry] ${taskName} attempt ${attempt}/${tries}`);
      return await fn();
    } catch (error) {
      latestError = error;
      logs.push(`[retry] ${taskName} failed at attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < tries) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
  throw latestError;
}

function normalizePrompt(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
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
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 3000 });

  await page.evaluate(async (el) => {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } else {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, await locator.elementHandle());

  const lines = String(prompt).replace(/\r/g, '').split('\n');
  const first = lines.shift() ?? '';

  await locator.type(first, { delay: 8 });
  for (const line of lines) {
    await page.keyboard.press('Shift+Enter');
    if (line) await locator.type(line, { delay: 8 });
  }

  await page.waitForTimeout(300);

  const actual = normalizePrompt(await page.evaluate((el) => {
    if (el.isContentEditable) {
      return el.innerText || el.textContent || '';
    }
    return el.value || '';
  }, await locator.elementHandle()));

  const expected = normalizePrompt(prompt);
  if (actual !== expected) {
    throw new Error(`Prompt verification failed. Expected: ${JSON.stringify(expected)} | Actual: ${JSON.stringify(actual)}`);
  }

  logs.push(`[step4] Prompt set and verified on: ${selector}`);
}

async function uploadReferencesIfAny(page, imagePaths, logs) {
  if (imagePaths.length === 0) {
    logs.push('[step3] No reference images provided, skip upload');
    return;
  }

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(imagePaths, { timeout: 15000 });
  logs.push(`[step3] Uploaded ${imagePaths.length} reference image(s)`);
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

async function getGeneratedImageMenuCount(page) {
  return await page.locator('[data-test-id="more-menu-button"]').count();
}

async function waitForFreshImageBlock(page, beforeMenuCount, logs, timeoutMs) {
  logs.push(`[step5] Waiting for a fresh generated image block by menu count (timeout: ${timeoutMs}ms)...`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentMenuCount = await getGeneratedImageMenuCount(page);
    if (currentMenuCount > beforeMenuCount) {
      const freshIndex = beforeMenuCount;
      const freshMenuButton = page.locator('[data-test-id="more-menu-button"]').nth(freshIndex);
      const freshBlock = freshMenuButton.locator('xpath=ancestor::*[self::message-content or self::model-response or self::shared-response or self::div][.//img][1]').first();

      await freshMenuButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(1200);

      logs.push(`[step5] Fresh image identified by menu index: ${freshIndex} (menu count ${beforeMenuCount} -> ${currentMenuCount})`);
      return { freshIndex, freshMenuButton, freshBlock };
    }

    await page.waitForTimeout(1200);
  }

  throw new Error(`Timeout: Gemini did not create a new image action menu in ${Math.floor(timeoutMs / 1000)} seconds.`);
}

async function openMenuAndDownload(page, freshTarget, outputDir, logs) {
  const { freshIndex, freshMenuButton } = freshTarget;
  await freshMenuButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(700);

  try {
    await freshMenuButton.click({ force: true, timeout: 5000 });
    logs.push(`[step6] Opened image menu for fresh image index ${freshIndex}`);
  } catch (error) {
    throw new Error(`Cannot open more menu for fresh image index ${freshIndex}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const menuItemSelectors = [
    '[data-test-id="image-download-button"]',
    'button[data-test-id="image-download-button"]',
    'button:has-text("Tải hình ảnh xuống")',
    'button:has-text("Download image")',
  ];

  for (const selector of menuItemSelectors) {
    const item = page.locator(selector).last();
    const exists = await item.count().then((n) => n > 0).catch(() => false);
    if (!exists) continue;

    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
      await item.click({ force: true, timeout: 5000 });
      const download = await downloadPromise;
      const suggested = download.suggestedFilename() || `gemini-image-${nowStamp()}.png`;
      const safeName = /\.(png|jpg|jpeg|webp)$/i.test(suggested) ? suggested : `gemini-image-${nowStamp()}.png`;
      const filePath = path.join(outputDir, safeName);
      await download.saveAs(filePath);
      logs.push(`[step6] Downloaded fresh image from menu item ${selector} at index ${freshIndex} -> ${filePath}`);
      return filePath;
    } catch (error) {
      logs.push(`[step6] Download click via ${selector} failed for fresh index ${freshIndex}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error('Cannot trigger image download from the fresh block menu');
}

async function downloadFromSpecificBlock(page, freshTarget, outputDir, logs) {
  try {
    return await openMenuAndDownload(page, freshTarget, outputDir, logs);
  } catch (menuError) {
    logs.push(`[step6] Menu-based download failed, fallback to image capture: ${menuError instanceof Error ? menuError.message : String(menuError)}`);
  }

  const { freshMenuButton } = freshTarget;
  const imageScope = freshMenuButton.locator('xpath=ancestor::*[.//img][1]').first();
  const imgLocator = imageScope.locator('img[src^="blob:"], img').first();
  const hasImage = await imgLocator.count().then((n) => n > 0).catch(() => false);
  if (hasImage) {
    const imagePath = path.join(outputDir, `gemini-image-screenshot-${nowStamp()}.png`);
    await imgLocator.screenshot({ path: imagePath });
    logs.push(`[step6] Saved screenshot of fresh image as fallback -> ${imagePath}`);
    return imagePath;
  }

  throw new Error('Cannot download or capture the fresh generated image');
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, '[start] gemini_generate_image invoked'];
  const artifacts = [];

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(buildResult({
      success: false,
      message: 'Missing required inputs',
      artifacts,
      logs,
      error: { code: 'VALIDATION_ERROR', details: `Missing fields: ${missing.join(', ')}` },
    }));
    process.exit(1);
  }

  const imagePrompt = parsed.image_prompt.trim();
  const browserPath = path.normalize(parsed.browser_path);
  const userDataDir = path.normalize(parsed.user_data_dir);
  const profileName = parsed.profile_name.trim();
  const targetGeminiUrl = parsed.target_gemini_url.trim();
  const imagePaths = parseList(parsed.image_paths).map((item) => path.normalize(item));
  const timeoutMs = Number.isFinite(parsed.timeout_ms) ? Math.max(15000, parsed.timeout_ms) : DEFAULTS.timeout_ms;
  const retryCount = Number.isFinite(parsed.retry_count) ? Math.max(1, Math.min(4, Math.floor(parsed.retry_count))) : DEFAULTS.retry_count;

  const artifactsDir = path.join(process.cwd(), 'artifacts', 'images');
  await mkdir(artifactsDir, { recursive: true });

  logs.push(`[input] target_gemini_url=${targetGeminiUrl}`);
  logs.push(`[input] profile_name=${profileName}`);
  logs.push(`[input] image_paths=${imagePaths.length}`);

  if (parsed.dry_run) {
    logs.push('[dry-run] Skip browser automation flow');
    printResult(buildResult({
      success: true,
      message: 'Dry run completed. Gemini image generation skipped.',
      data: { image_prompt: imagePrompt, image_paths: imagePaths },
      artifacts,
      logs,
    }));
    return;
  }

  try {
    if (imagePaths.length > 0) {
      await ensureReadableFiles(imagePaths);
      logs.push('[step3] Reference image files verified');
    }
  } catch (error) {
    printResult(buildResult({
      success: false,
      message: 'Reference image file missing/unreadable',
      artifacts,
      logs,
      error: { code: 'IMAGE_FILE_ERROR', details: error instanceof Error ? error.message : String(error), failed_step: 3 },
    }));
    process.exit(1);
  }

  let context;

  try {
    logs.push('[step1] Opening Microsoft Edge with target profile');
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: browserPath,
      headless: false,
      acceptDownloads: true,
      args: [`--profile-directory=${profileName}`],
      viewport: { width: 1440, height: 900 },
    });

    const page = context.pages()[0] ?? await context.newPage();

    logs.push('[step2] Navigating to Gemini workspace/chat URL');
    await page.goto(targetGeminiUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
    await dismissPopupsIfAny(page, logs);

    const screenshotBefore = path.join(artifactsDir, `gemini-before-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotBefore, fullPage: true });
    artifacts.push({ type: 'screenshot_before', path: path.relative(process.cwd(), screenshotBefore).replace(/\\/g, '/') });

    const beforeMenuCount = await getGeneratedImageMenuCount(page);
    logs.push(`[step4] Existing image menu count before submit: ${beforeMenuCount}`);

    await withRetry('step3-upload-references', retryCount, logs, async () => {
      await uploadReferencesIfAny(page, imagePaths, logs);
    });

    await withRetry('step4-submit-prompt', retryCount, logs, async () => {
      await setPromptRobust(page, imagePrompt, logs);
      await submitPrompt(page, logs);
    });

    const freshTarget = await withRetry('step5-wait-result', retryCount, logs, async () => {
      return await waitForFreshImageBlock(page, beforeMenuCount, logs, timeoutMs);
    });

    const downloadedImagePath = await withRetry('step6-download-image', retryCount, logs, async () => {
      return await downloadFromSpecificBlock(page, freshTarget, artifactsDir, logs);
    });

    const relativeDownloadedImagePath = path
      .relative(process.cwd(), downloadedImagePath)
      .replace(/\\/g, '/');
    const chatReply = buildChatImageReplyPayload({
      imagePath: downloadedImagePath,
      data: {
        target_gemini_url: targetGeminiUrl,
        image_prompt: imagePrompt,
        downloaded_image_path: relativeDownloadedImagePath,
      },
      artifacts: [
        {
          type: 'generated_image',
          path: relativeDownloadedImagePath,
        },
      ],
    });

    const screenshotAfter = path.join(artifactsDir, `gemini-after-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotAfter, fullPage: true });
    artifacts.push({ type: 'screenshot_after', path: path.relative(process.cwd(), screenshotAfter).replace(/\\/g, '/') });

    logs.push('[step8] Flow completed, returning artifacts and logs');
    
    // 1. Lấy đường dẫn file chuẩn
    const relativePath = path.relative(process.cwd(), downloadedImagePath).replace(/\\/g, '/');
    
    // 2. TỐI THƯỢNG: Đọc file ảnh và mã hóa thành Base64
    const { readFile } = await import("node:fs/promises");
    const imageBuffer = await readFile(downloadedImagePath);
    const base64Image = imageBuffer.toString('base64');
    
    // Xác định định dạng ảnh (png, jpg, webp)
    let ext = path.extname(downloadedImagePath).substring(1).toLowerCase() || 'png';
    if (ext === 'jpg') ext = 'jpeg';
    
    // 3. Tạo chuỗi Data URI thần thánh
    const base64DataUri = `data:image/${ext};base64,${base64Image}`;

    printResult(buildResult({
      success: true,
      message: chatReply.assistantText,
      data: {
        ...chatReply.data,
        generation_status_message: 'Gemini image generation flow completed',
        target_gemini_url: targetGeminiUrl,
        image_prompt: imagePrompt,
        downloaded_image_path: relativePath,
        // Cấp sẵn luôn 1 cục Markdown chứa Base64 cho AI
        markdown_display: `![Ảnh thành phẩm](${base64DataUri})` 
      },
      artifacts: [...artifacts, ...chatReply.artifacts],
      logs,
    }));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    let failedStep = 'unknown';
    if (/file|upload/i.test(details)) failedStep = 3;
    else if (/prompt|submit|verification/i.test(details)) failedStep = 4;
    else if (/timeout|fresh image|downloadable image block/i.test(details)) failedStep = 5;
    else if (/download|capture/i.test(details)) failedStep = 6;
    else if (/goto|navigation/i.test(details)) failedStep = 2;

    logs.push(`[fail] Flow failed at step ${failedStep}: ${details}`);
    printResult(buildResult({
      success: false,
      message: 'Gemini image generation flow failed',
      data: { target_gemini_url: targetGeminiUrl, image_prompt: imagePrompt },
      artifacts,
      logs,
      error: { code: 'FLOW_FAILED', failed_step: failedStep, details },
    }));
    process.exit(1);
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
  }
})();
