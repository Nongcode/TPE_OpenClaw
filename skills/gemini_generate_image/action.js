import { readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildChatImageReplyPayload } from "../shared/chat-image-result.js";
import { publishGeneratedImageToUpTekGallery } from "../shared/uptek-gallery-publisher.js";

const DEFAULTS = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/PHAMDUCLONG/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Default",
  target_gemini_url: "https://gemini.google.com/app/c3226ddbd6829c8c",
  image_paths: [],
  output_dir: "",
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

  if (args.length >= 2 && (args[0] === "--input_file" || args[0] === "--input-file")) {
    try {
      const raw = readFileSync(args[1], "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      return {
        ...params,
        ...parsed,
        image_paths: parseList(parsed.image_paths),
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        logs,
      };
    } catch (error) {
      logs.push(
        `[parse] Invalid JSON input file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

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
      logs.push(
        `[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    if (token === "--output_dir") {
      params.output_dir = next;
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
  if (typeof params.image_prompt !== "string" || params.image_prompt.trim() === "")
    missing.push("image_prompt");
  if (typeof params.browser_path !== "string" || params.browser_path.trim() === "")
    missing.push("browser_path");
  if (typeof params.user_data_dir !== "string" || params.user_data_dir.trim() === "")
    missing.push("user_data_dir");
  if (typeof params.profile_name !== "string" || params.profile_name.trim() === "")
    missing.push("profile_name");
  if (typeof params.target_gemini_url !== "string" || params.target_gemini_url.trim() === "")
    missing.push("target_gemini_url");
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
      logs.push(
        `[retry] ${taskName} failed at attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, 1500));
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

function canonicalizePromptForVerification(text) {
  return normalizePrompt(text)
    .replace(/\*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function stripDiacritics(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function basenameVariants(filePath) {
  const base = path.basename(String(filePath || "")).trim();
  if (!base) return [];
  const stem = base.replace(/\.[^.]+$/, "");
  return [base, stem].filter(Boolean);
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
    "textarea",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 8000 });
      return { locator, selector };
    } catch {}
  }
  throw new Error("Cannot find Gemini prompt input field");
}

async function readPromptEditorValue(page, locator) {
  const handle = await locator.elementHandle();
  if (!handle) return "";
  return await page.evaluate((el) => {
    if (el.isContentEditable) return el.innerText || el.textContent || "";
    return el.value || "";
  }, handle);
}

async function clearPromptEditor(page, locator, logs) {
  const handle = await locator.elementHandle();
  if (!handle) throw new Error("Cannot access Gemini prompt input field");

  await locator.scrollIntoViewIfNeeded();
  await locator.click({ timeout: 3000 });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.keyboard
      .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
      .catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    await page.keyboard.press("Delete").catch(() => undefined);

    await page.evaluate((el) => {
      el.focus();
      if (el.isContentEditable) {
        el.textContent = "";
        if (typeof el.replaceChildren === "function") el.replaceChildren();
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "deleteContentBackward",
            data: null,
          }),
        );
      } else {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, handle);

    await page.waitForTimeout(200);
    const current = canonicalizePromptForVerification(await readPromptEditorValue(page, locator));
    if (!current) {
      logs.push(`[step4] Prompt editor cleared on attempt ${attempt}`);
      return;
    }
  }
  throw new Error("Prompt editor could not be cleared cleanly before input");
}

async function setPromptRobust(page, prompt, logs) {
  const { locator, selector } = await locatePromptEditor(page);
  const expected = canonicalizePromptForVerification(prompt);
  const existing = canonicalizePromptForVerification(await readPromptEditorValue(page, locator));

  if (existing === expected) {
    logs.push(`[step4] Prompt already present in editor, skip retyping on: ${selector}`);
    return;
  }

  await clearPromptEditor(page, locator, logs);
  await locator.click({ timeout: 3000 });
  await page.keyboard.insertText(String(prompt));
  await page.waitForTimeout(300);

  const actual = canonicalizePromptForVerification(await readPromptEditorValue(page, locator));
  if (actual !== expected) {
    logs.push(
      `[step4] Prompt verification mismatch on ${selector}; continue because Gemini normalizes formatting.`,
    );
  } else {
    logs.push(`[step4] Prompt set and verified on: ${selector}`);
  }
}

async function openComposerMenu(page, logs, stepLabel) {
  const menuSelectors = [
    "button.upload-card-button",
    'button[aria-label="Mở trình đơn tải tệp lên"]',
    'button[aria-controls="upload-file-menu"]',
    'button[aria-label*="Upload" i]',
    'button[aria-label*="Tải tệp" i]',
    "button.menu-button",
    'button[aria-label*="prompt input" i]',
    'button[aria-label*="\u00f4 nh\u1eadp n\u1ed9i dung"]',
  ];

  for (const selector of menuSelectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 1500 })) {
        await button.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(500);
        logs.push(`[${stepLabel}] Opened upload/tools menu via ${selector}`);
        return;
      }
    } catch {}
  }
  logs.push(
    `[${stepLabel}] Warning: Cannot click upload menu visually, will rely on hidden file input fallback.`,
  );
}

async function selectImageToolMode(page, logs) {
  await openComposerMenu(page, logs, "step2");

  const toolSelectors = [
    'button:has-text("T\u1ea1o h\u00ecnh \u1ea3nh")',
    'button.toolbox-drawer-item-list-button:has-text("T\u1ea1o h\u00ecnh \u1ea3nh")',
    'button:has-text("Generate image")',
  ];

  for (const selector of toolSelectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 1500 })) {
        await button.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(300);
        logs.push(`[step2] Selected Gemini tool mode via ${selector}`);
        return;
      }
    } catch {}
  }
  logs.push(
    "[step2] Warning: Cannot select explicit image tool mode, proceeding directly to prompt.",
  );
}

async function uploadReferencesSequentially(page, imagePaths, logs) {
  if (imagePaths.length === 0) {
    logs.push("[step3] No reference images provided, skip upload");
    return;
  }

  await ensureReadableFiles(imagePaths);
  logs.push(`[step3] Sequential upload enabled for ${imagePaths.length} reference image(s)`);

  const previewSignals = [
    'button[aria-label*="remove" i]',
    'button[aria-label*="xóa" i]',
    'button[aria-label*="delete" i]',
    'img[src^="blob:"]',
    'img[src^="data:"]',
    '[role="listitem"] img',
  ];

  const getPreviewCount = async () => {
    for (const selector of previewSignals) {
      const count = await page
        .locator(selector)
        .count()
        .catch(() => 0);
      if (count > 0) return count;
    }
    return 0;
  };

  const waitForSingleUploadAcknowledgement = async (imagePath, previousPreviewCount = 0) => {
    const startedAt = Date.now();
    const probeNames = basenameVariants(imagePath);

    while (Date.now() - startedAt < 15000) {
      const bodyText = normalizePrompt(
        await page
          .locator("body")
          .innerText({ timeout: 1000 })
          .catch(() => ""),
      );
      const folded = stripDiacritics(bodyText).toLowerCase();

      if (
        folded.includes("tep trong") ||
        folded.includes("empty file") ||
        folded.includes("file is empty")
      ) {
        throw new Error("UPLOAD_EMPTY_FILE: Gemini reported the uploaded reference file is empty");
      }

      const hasReferenceName = probeNames.some((name) => {
        const foldedName = stripDiacritics(name).toLowerCase();
        return foldedName && folded.includes(foldedName);
      });
      if (hasReferenceName) {
        logs.push(
          `[step3] Gemini acknowledged uploaded reference image by file name: ${path.basename(imagePath)}`,
        );
        return;
      }

      for (const selector of previewSignals) {
        const count = await page
          .locator(selector)
          .count()
          .catch(() => 0);
        if (count > previousPreviewCount) {
          logs.push(
            `[step3] Gemini showed new attachment preview via ${selector} for ${path.basename(imagePath)}`,
          );
          return;
        }
      }
      await page.waitForTimeout(500);
    }
    throw new Error(
      `UPLOAD_NOT_ACKNOWLEDGED: Gemini did not confirm uploaded reference image ${path.basename(imagePath)}`,
    );
  };

  const uploadSingleReference = async (imagePath) => {
    const previousPreviewCount = await getPreviewCount();

    // 1. CHẮC CHẮN MỞ LẠI MENU DẤU (+)
    // Vì ở bước chọn Tool, menu đã bị tắt. Cần mở lại để thấy nút tải file.
    try {
      const menuBtn = page
        .locator('button.upload-card-button, button[aria-label="Mở trình đơn tải tệp lên"]')
        .first();
      if (await menuBtn.isVisible({ timeout: 3000 })) {
        await menuBtn.click({ force: true });
        await page.waitForTimeout(1000); // Đợi 1 giây cho menu trượt lên hiển thị đầy đủ
      }
    } catch (e) {
      logs.push("[step3] Warning: Cannot click + button, maybe already open?");
    }

    // 2. CLICK TRỰC TIẾP VÀO NÚT TẢI TỆP TRÊN GIAO DIỆN
    // Sử dụng bộ chọn chính xác 100% lấy từ HTML bạn cung cấp
    try {
      const uiButton = page
        .locator('button[data-test-id="local-images-files-uploader-button"]')
        .first();

      if (await uiButton.isVisible({ timeout: 3000 })) {
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 });
        await uiButton.click({ force: true, timeout: 3000 });
        const chooser = await chooserPromise;
        await chooser.setFiles(imagePath);
        await waitForSingleUploadAcknowledgement(imagePath, previousPreviewCount);
        logs.push(
          `[step3] Uploaded reference image via UI Menu Button: ${path.basename(imagePath)}`,
        );
        return;
      }
    } catch (error) {
      logs.push(
        `[step3] UI Menu upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 3. FALLBACK: NẾU GIAO DIỆN LỖI, GỌI CÁC NÚT ẨN
    const triggers = [
      {
        name: "Hidden Image Trigger",
        selector: 'button[data-test-id="hidden-local-image-upload-button"]',
      },
      {
        name: "Hidden File Trigger",
        selector: 'button[data-test-id="hidden-local-file-upload-button"]',
      },
    ];

    for (const triggerInfo of triggers) {
      try {
        const trigger = page.locator(triggerInfo.selector).first();
        // Phải dùng waitFor attached, không dùng .count() > 0 vì nó check quá nhanh
        await trigger.waitFor({ state: "attached", timeout: 2000 });
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 8000 });
        await trigger.click({ force: true, timeout: 3000 });
        const chooser = await chooserPromise;
        await chooser.setFiles(imagePath);
        await waitForSingleUploadAcknowledgement(imagePath, previousPreviewCount);
        logs.push(
          `[step3] Uploaded reference image via ${triggerInfo.name}: ${path.basename(imagePath)}`,
        );
        return;
      } catch (error) {
        // Tiếp tục thử nút khác
      }
    }

    // 4. FALLBACK CUỐI: TRUYỀN THẲNG VÀO LÕI THẺ INPUT
    const fileInputs = page.locator('input[type="file"]');
    const count = await fileInputs.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      try {
        const input = fileInputs.nth(index);
        const accept = ((await input.getAttribute("accept").catch(() => "")) || "").toLowerCase();
        if (accept && !accept.includes("image")) continue;
        await input.setInputFiles(imagePath, { timeout: 15000 });
        await waitForSingleUploadAcknowledgement(imagePath, previousPreviewCount);
        logs.push(
          `[step3] Uploaded reference image via raw input #${index + 1}: ${path.basename(imagePath)}`,
        );
        return;
      } catch (error) {}
    }

    throw new Error(
      `Cannot find a working Gemini upload control for reference image ${path.basename(imagePath)}`,
    );
  };

  for (const imagePath of imagePaths) {
    await uploadSingleReference(imagePath);
  }
}

async function getUserQueryCount(page) {
  return await page
    .locator("user-query")
    .count()
    .catch(() => 0);
}

async function waitForEnabled(locator, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await locator.isEnabled().catch(() => false)) return;
    await locator.page().waitForTimeout(250);
  }
  throw new Error(`Button stayed disabled for ${timeoutMs}ms`);
}

async function verifyPromptSubmitted(page, beforeUserCount, logs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    const currentUserCount = await getUserQueryCount(page);
    if (currentUserCount > beforeUserCount) {
      logs.push(
        `[step4] Prompt submission confirmed by user-query count ${beforeUserCount} -> ${currentUserCount}`,
      );
      return;
    }
    try {
      const { locator } = await locatePromptEditor(page);
      const handle = await locator.elementHandle();
      if (handle) {
        const currentText = normalizePrompt(
          await page.evaluate((el) => {
            if (el.isContentEditable) return el.innerText || el.textContent || "";
            return el.value || "";
          }, handle),
        );
        if (!currentText) {
          logs.push("[step4] Prompt submission confirmed by cleared editor");
          return;
        }
      }
    } catch {}
    await page.waitForTimeout(400);
  }
  throw new Error("Prompt submit did not create a new Gemini user turn");
}

async function submitPrompt(page, logs, beforeUserCount) {
  const submitCandidates = [
    "button.send-button",
    'button[aria-label="Gửi tin nhắn"]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
  ];

  for (const selector of submitCandidates) {
    try {
      const button = page.locator(selector).first();
      await button.waitFor({ state: "visible", timeout: 3000 });
      await waitForEnabled(button, 15000);
      await button.click({ force: true, timeout: 3000 });
      logs.push(`[step4] Prompt submitted by button: ${selector}`);
      await verifyPromptSubmitted(page, beforeUserCount, logs);
      return;
    } catch {}
  }

  await page.keyboard.press("Enter");
  logs.push("[step4] Prompt submitted by Enter key");
  await verifyPromptSubmitted(page, beforeUserCount, logs);
}

async function getGeneratedImageMenuCount(page) {
  return await page.locator('[data-test-id="more-menu-button"]').count();
}

async function waitForFreshImageBlock(page, beforeMenuCount, logs, timeoutMs) {
  logs.push(
    `[step5] Waiting for a fresh generated image block by menu count (timeout: ${timeoutMs}ms)...`,
  );
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentMenuCount = await getGeneratedImageMenuCount(page);
    if (currentMenuCount > beforeMenuCount) {
      const freshIndex = beforeMenuCount;
      const freshMenuButton = page.locator('[data-test-id="more-menu-button"]').nth(freshIndex);
      const freshBlock = freshMenuButton
        .locator(
          "xpath=ancestor::*[self::message-content or self::model-response or self::shared-response or self::div][.//img][1]",
        )
        .first();

      await freshMenuButton.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(1200);

      logs.push(
        `[step5] Fresh image identified by menu index: ${freshIndex} (menu count ${beforeMenuCount} -> ${currentMenuCount})`,
      );
      return { freshIndex, freshMenuButton, freshBlock };
    }
    await page.waitForTimeout(1200);
  }
  throw new Error(
    `Timeout: Gemini did not create a new image action menu in ${Math.floor(timeoutMs / 1000)} seconds.`,
  );
}

async function openMenuAndDownload(page, freshTarget, outputDir, logs) {
  const { freshIndex, freshMenuButton } = freshTarget;
  await freshMenuButton.scrollIntoViewIfNeeded().catch(() => undefined);
  await page.waitForTimeout(700);

  try {
    await freshMenuButton.click({ force: true, timeout: 5000 });
    logs.push(`[step6] Opened image menu for fresh image index ${freshIndex}`);
  } catch (error) {
    throw new Error(
      `Cannot open more menu for fresh image index ${freshIndex}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const menuItemSelectors = [
    '[data-test-id="image-download-button"]',
    'button[data-test-id="image-download-button"]',
    'button:has-text("Tải hình ảnh xuống")',
    'button:has-text("Download image")',
  ];

  for (const selector of menuItemSelectors) {
    const item = page.locator(selector).last();
    const exists = await item
      .count()
      .then((n) => n > 0)
      .catch(() => false);
    if (!exists) continue;

    try {
      const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
      await item.click({ force: true, timeout: 5000 });
      const download = await downloadPromise;
      const suggested = download.suggestedFilename() || `gemini-image-${nowStamp()}.png`;
      const safeName = /\.(png|jpg|jpeg|webp)$/i.test(suggested)
        ? suggested
        : `gemini-image-${nowStamp()}.png`;
      const filePath = path.join(outputDir, safeName);
      await download.saveAs(filePath);
      logs.push(
        `[step6] Downloaded fresh image from menu item ${selector} at index ${freshIndex} -> ${filePath}`,
      );
      return filePath;
    } catch (error) {
      logs.push(
        `[step6] Download click via ${selector} failed for fresh index ${freshIndex}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error("Cannot trigger image download from the fresh block menu");
}

async function downloadFromSpecificBlock(page, freshTarget, outputDir, logs) {
  try {
    return await openMenuAndDownload(page, freshTarget, outputDir, logs);
  } catch (menuError) {
    logs.push(
      `[step6] Menu-based download failed, fallback to blob extraction: ${menuError instanceof Error ? menuError.message : String(menuError)}`,
    );
  }

  const { freshMenuButton } = freshTarget;
  const imageScope = freshMenuButton.locator("xpath=ancestor::*[.//img][1]").first();
  const imgLocator = imageScope.locator('img[src^="blob:"], img').first();
  const hasImage = await imgLocator
    .count()
    .then((n) => n > 0)
    .catch(() => false);
  if (hasImage) {
    const src = await imgLocator.getAttribute("src").catch(() => "");
    if (src && src.startsWith("blob:")) {
      const blobPayload = await page.evaluate(async (blobUrl) => {
        const response = await fetch(blobUrl);
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        return {
          mimeType: blob.type || "",
          bytes: Array.from(new Uint8Array(arrayBuffer)),
        };
      }, src);

      const extension =
        { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[
          blobPayload?.mimeType
        ] || ".png";
      const imagePath = path.join(outputDir, `gemini-image-fallback-${nowStamp()}${extension}`);
      await writeFile(imagePath, Buffer.from(blobPayload?.bytes || []));
      logs.push(`[step6] Saved blob-backed fallback image -> ${imagePath}`);
      return imagePath;
    }
  }
  throw new Error("Cannot download the fresh generated image as a real file");
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] gemini_generate_image invoked"];
  const artifacts = [];

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(
      buildResult({
        success: false,
        message: "Missing required inputs",
        artifacts,
        logs,
        error: { code: "VALIDATION_ERROR", details: `Missing fields: ${missing.join(", ")}` },
      }),
    );
    process.exit(1);
  }

  const imagePrompt = parsed.image_prompt.trim();
  const browserPath = path.normalize(parsed.browser_path);
  const userDataDir = path.normalize(parsed.user_data_dir);
  const profileName = parsed.profile_name.trim();
  const targetGeminiUrl = parsed.target_gemini_url.trim();
  const rawImagePaths = parseList(parsed.image_paths).map((item) => path.normalize(item));
  const imagePaths = rawImagePaths;
  const timeoutMs = Number.isFinite(parsed.timeout_ms)
    ? Math.max(15000, parsed.timeout_ms)
    : DEFAULTS.timeout_ms;
  const retryCount = Number.isFinite(parsed.retry_count)
    ? Math.max(1, Math.min(4, Math.floor(parsed.retry_count)))
    : DEFAULTS.retry_count;

  const artifactsDir = path.resolve(
    parsed.output_dir || path.join(process.cwd(), "artifacts", "images"),
  );
  await mkdir(artifactsDir, { recursive: true });

  logs.push(`[input] target_gemini_url=${targetGeminiUrl}`);
  logs.push(`[input] profile_name=${profileName}`);
  logs.push(`[input] image_paths=${imagePaths.length}`);
  logs.push(`[input] output_dir=${artifactsDir}`);
  if (imagePaths.length > 0) logs.push(`[input] Reference images=${imagePaths.join(" | ")}`);

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip browser automation flow");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed. Gemini image generation skipped.",
        data: { image_prompt: imagePrompt, image_paths: imagePaths },
        artifacts,
        logs,
      }),
    );
    return;
  }

  try {
    if (imagePaths.length > 0) {
      await ensureReadableFiles(imagePaths);
      logs.push("[step3] Reference image files verified");
    }
  } catch (error) {
    printResult(
      buildResult({
        success: false,
        message: "Reference image file missing/unreadable",
        artifacts,
        logs,
        error: {
          code: "IMAGE_FILE_ERROR",
          details: error instanceof Error ? error.message : String(error),
          failed_step: 3,
        },
      }),
    );
    process.exit(1);
  }

  let context;

  try {
    logs.push("[step1] Opening Microsoft Edge with target profile");
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: browserPath,
      headless: false,
      acceptDownloads: true,
      args: [`--profile-directory=${profileName}`],
      viewport: { width: 1440, height: 900 },
    });

    const page = context.pages()[0] ?? (await context.newPage());

    logs.push("[step2] Navigating to Gemini workspace/chat URL");
    await page.goto(targetGeminiUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await dismissPopupsIfAny(page, logs);

    await selectImageToolMode(page, logs);

    const screenshotBefore = path.join(artifactsDir, `gemini-before-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotBefore, fullPage: true });
    artifacts.push({
      type: "screenshot_before",
      path: path.relative(process.cwd(), screenshotBefore).replace(/\\/g, "/"),
    });

    const beforeMenuCount = await getGeneratedImageMenuCount(page);
    logs.push(`[step4] Existing image menu count before submit: ${beforeMenuCount}`);
    const beforeUserQueryCount = await getUserQueryCount(page);

    await withRetry("step3-upload-references", retryCount, logs, async () => {
      await uploadReferencesSequentially(page, imagePaths, logs);
    });

    await withRetry("step4-submit-prompt", retryCount, logs, async () => {
      await setPromptRobust(page, imagePrompt, logs);
      await submitPrompt(page, logs, beforeUserQueryCount);
    });

    const freshTarget = await withRetry("step5-wait-result", retryCount, logs, async () => {
      return await waitForFreshImageBlock(page, beforeMenuCount, logs, timeoutMs);
    });

    const downloadedImagePath = await withRetry(
      "step6-download-image",
      retryCount,
      logs,
      async () => {
        return await downloadFromSpecificBlock(page, freshTarget, artifactsDir, logs);
      },
    );

    const relativeDownloadedImagePath = path
      .relative(process.cwd(), downloadedImagePath)
      .replace(/\\/g, "/");

    let gallerySync = null;
    try {
      gallerySync = await publishGeneratedImageToUpTekGallery(downloadedImagePath, {
        imagePaths,
        imagePrompt,
        workspaceRoot: process.cwd(),
        productModel: typeof parsed.product_model === "string" ? parsed.product_model.trim() : "",
      });
      logs.push(
        `[step7] Synced generated image to UpTek gallery ${gallerySync.companyId}/${gallerySync.departmentId} with productModel=${gallerySync.productModel}: ${gallerySync.copiedPath}`,
      );
    } catch (error) {
      logs.push(
        `[step7] Warning: generated image sync to UpTek gallery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const chatReply = buildChatImageReplyPayload({
      imagePath: downloadedImagePath,
      data: {
        target_gemini_url: targetGeminiUrl,
        image_prompt: imagePrompt,
        downloaded_image_path: relativeDownloadedImagePath,
        company_gallery_synced: Boolean(gallerySync),
        company_gallery_path: gallerySync?.copiedPath || null,
        company_gallery_company_id: gallerySync?.companyId || "UpTek",
        company_gallery_department_id: gallerySync?.departmentId || "Phong_Marketing",
        company_gallery_product_model: gallerySync?.productModel || null,
        company_gallery_url: gallerySync?.galleryUrl || null,
        company_gallery_image_id: gallerySync?.imageId || null,
        company_gallery_media_file_id: gallerySync?.mediaFileId || null,
      },
      artifacts: [{ type: "generated_image", path: relativeDownloadedImagePath }],
    });

    const screenshotAfter = path.join(artifactsDir, `gemini-after-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotAfter, fullPage: true });
    artifacts.push({
      type: "screenshot_after",
      path: path.relative(process.cwd(), screenshotAfter).replace(/\\/g, "/"),
    });

    logs.push("[step8] Flow completed, returning artifacts and logs");

    printResult(
      buildResult({
        success: true,
        message: chatReply.assistantText,
        data: {
          target_gemini_url: targetGeminiUrl,
          image_prompt: imagePrompt,
          downloaded_image_path: relativeDownloadedImagePath,
          ...chatReply.data,
          generation_status_message: "Gemini image generation flow completed",
        },
        artifacts: [...artifacts, ...chatReply.artifacts],
        logs,
      }),
    );
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    let failedStep = "unknown";
    if (/file|upload/i.test(details)) failedStep = 3;
    else if (/prompt|submit|verification/i.test(details)) failedStep = 4;
    else if (/timeout|fresh image|downloadable image block/i.test(details)) failedStep = 5;
    else if (/download|capture/i.test(details)) failedStep = 6;
    else if (/goto|navigation/i.test(details)) failedStep = 2;

    logs.push(`[fail] Flow failed at step ${failedStep}: ${details}`);
    printResult(
      buildResult({
        success: false,
        message: "Gemini image generation flow failed",
        data: { target_gemini_url: targetGeminiUrl, image_prompt: imagePrompt },
        artifacts,
        logs,
        error: { code: "FLOW_FAILED", failed_step: failedStep, details },
      }),
    );
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
})();
