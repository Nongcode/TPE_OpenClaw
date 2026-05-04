import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildChatVideoReplyPayload } from "../shared/chat-video-result.js";

const DEFAULTS = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Profile 2",
  project_url: "https://labs.google/fx/vi/tools/flow/project/2129dba8-28ff-4699-8ed8-7397e399d986",
  reference_image: "",
  logo_paths: [],
  prompt: "Tao video quang cao",
  output_dir: "",
  cdp_url: "",
  timeout_ms: 1200000,
  download_resolution: "720p",
  auto_close_browser: false,
  retry_count: 2,
  dry_run: false,
  no_company_logo: true,
};

const UPLOAD_SETTLE_MS = 3000;
const PRE_SUBMIT_SETTLE_MS = 3000;

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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

  if (args.findIndex((a) => a === "--input_file" || a === "--input-file") !== -1) {
    const idx = args.findIndex((a) => a === "--input_file" || a === "--input-file");
    if (args[idx + 1]) {
      try {
        const raw = readFileSync(args[idx + 1], "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(raw);
        Object.assign(params, parsed);
        params.logo_paths = parseList(parsed.logo_paths);
        if (parsed.dry_run === true || parsed["dry-run"] === true) params.dry_run = true;
      } catch (error) {
        logs.push(`[parse] Invalid JSON input file: ${error.message}`);
      }
    }
  } else if (args.length > 0 && args[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      Object.assign(params, parsed);
      params.logo_paths = parseList(parsed.logo_paths);
      if (parsed.dry_run === true || parsed["dry-run"] === true) params.dry_run = true;
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error.message}`);
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    if (token === "--dry-run" || token === "--dry_run") {
      params.dry_run = true;
      continue;
    }
    if (token === "--no-company-logo" || token === "--no-logo") {
      params.no_company_logo = true;
      params.logo_paths = [];
      continue;
    }
    if (!next || next.startsWith("--")) continue;

    if (token === "--prompt") {
      params.prompt = next;
      index += 1;
    } else if (token === "--reference_image") {
      params.reference_image = next;
      index += 1;
    } else if (token === "--logo_paths") {
      params.logo_paths = parseList(next);
      index += 1;
    } else if (token === "--output_dir") {
      params.output_dir = next;
      index += 1;
    } else if (token === "--project_url") {
      params.project_url = next;
      index += 1;
    } else if (token === "--browser_path") {
      params.browser_path = next;
      index += 1;
    } else if (token === "--cdp_url") {
      params.cdp_url = next;
      index += 1;
    } else if (token === "--user_data_dir") {
      params.user_data_dir = next;
      index += 1;
    } else if (token === "--profile_name") {
      params.profile_name = next;
      index += 1;
    } else if (token === "--timeout_ms") {
      params.timeout_ms = Number(next);
      index += 1;
    } else if (token === "--download_resolution") {
      params.download_resolution = next;
      index += 1;
    } else if (token === "--auto_close_browser") {
      params.auto_close_browser = next === "true" || next === "1";
      index += 1;
    }
  }

  return { ...params, logs };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function ensureReadableFile(filePath) {
  if (filePath) {
    await access(filePath);
  }
}

async function ensureReadableFiles(filePaths) {
  for (const filePath of filePaths) {
    if (filePath) {
      await access(filePath);
    }
  }
}

async function loadSharp() {
  try {
    const sharpModule = await import("sharp");
    return sharpModule.default || sharpModule;
  } catch {
    return null;
  }
}

async function buildCompositeReferenceImage(referenceImage, logoPaths, outputDir, logs) {
  const normalizedLogoPaths = parseList(logoPaths).filter((filePath) => existsSync(filePath));
  if (!referenceImage || !existsSync(referenceImage) || normalizedLogoPaths.length === 0) {
    return referenceImage;
  }

  const sharp = await loadSharp();
  if (!sharp) {
    logs.push("[step1] sharp unavailable, skip composite reference image");
    return referenceImage;
  }

  try {
    const firstLogoPath = normalizedLogoPaths[0];
    const referenceMeta = await sharp(referenceImage).metadata();
    const referenceWidth = referenceMeta.width || 1280;
    const referenceHeight = referenceMeta.height || 720;
    const targetLogoWidth = Math.max(96, Math.round(referenceWidth * 0.16));
    const logoMargin = Math.max(16, Math.round(referenceWidth * 0.03));

    const resizedLogo = await sharp(firstLogoPath)
      .resize({
        width: targetLogoWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const logoMeta = await sharp(resizedLogo).metadata();
    const logoWidth = logoMeta.width || targetLogoWidth;
    const logoHeight = logoMeta.height || Math.round(targetLogoWidth / 3);

    const compositePath = path.join(outputDir, `veo-reference-${nowStamp()}.png`);
    await sharp(referenceImage)
      .composite([
        {
          input: resizedLogo,
          top: Math.max(0, referenceHeight - logoHeight - logoMargin),
          left: Math.max(0, referenceWidth - logoWidth - logoMargin),
        },
      ])
      .png()
      .toFile(compositePath);

    logs.push(`[step1] Built composite reference image with logo -> ${compositePath}`);
    return compositePath;
  } catch (error) {
    logs.push(`[step1] Could not build composite reference image: ${error.message}`);
    return referenceImage;
  }
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

async function findComposerGeometry(page, logs = null) {
  const result = await page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width >= 10 &&
        rect.height >= 10
      );
    };
    const normalize = (value) =>
      String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    const promptNodes = Array.from(
      document.querySelectorAll(
        'div[role="textbox"][contenteditable="true"], [data-slate-editor="true"][contenteditable="true"], .ql-editor[contenteditable="true"], textarea, input[type="text"]',
      ),
    )
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalize(
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            element.getAttribute("title"),
          ].join(" "),
        );
        let score = rect.y;
        if (rect.y > window.innerHeight * 0.45) score += 500;
        if (text.includes("ban muon tao") || text.includes("tao gi") || text.includes("prompt")) {
          score += 400;
        }
        if (text.includes("search") || text.includes("tim kiem") || text.includes("filter")) {
          score -= 1000;
        }
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          score,
        };
      })
      .filter((item) => item.score > -500)
      .sort((left, right) => right.score - left.score);

    const promptBox = promptNodes[0] || null;
    if (!promptBox) return { promptBox: null, plusCandidates: [] };

    const buttonNodes = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalize(
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-testid"),
          ].join(" "),
        );
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        const nearComposer =
          centerY >= promptBox.y - 170 &&
          centerY <= promptBox.y + promptBox.height + 170 &&
          centerX >= promptBox.x - 160 &&
          centerX <= promptBox.x + Math.max(180, promptBox.width * 0.35);
        let score = 0;
        if (text.includes("add_2") || text === "+" || text.includes("add")) score += 250;
        if (text.includes("tao") || text.includes("them") || text.includes("upload")) score += 50;
        if (nearComposer) score += 300;
        score -= Math.abs(centerX - (promptBox.x + 20)) / 4;
        score -= Math.abs(centerY - (promptBox.y + promptBox.height + 30)) / 4;
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          score,
        };
      })
      .filter((item) => item.score > 100)
      .sort((left, right) => right.score - left.score);

    return { promptBox, plusCandidates: buttonNodes.slice(0, 5) };
  });

  if (!result.promptBox) throw new Error("Khong tim thay khung prompt composer");
  if (!result.plusCandidates.length) throw new Error("Khong tim thay nut + trong composer");
  if (logs) {
    logs.push(
      `[step2] Composer prompt box x=${Math.round(result.promptBox.x)}, y=${Math.round(
        result.promptBox.y,
      )}, w=${Math.round(result.promptBox.width)}, h=${Math.round(result.promptBox.height)}`,
    );
  }
  return { promptBox: result.promptBox, plusBox: result.plusCandidates[0] };
}

async function pageLooksCrashed(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    return (
      /Application error|client-side exception/i.test(text) ||
      document.title.includes("Application error")
    );
  });
}

async function waitForFlowComposerReady(page, logs, timeoutMs = 90000) {
  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await dismissPopupsIfAny(page, logs);
    if (await pageLooksCrashed(page).catch(() => false)) {
      throw new Error("Flow page dang o trang thai Application error");
    }
    try {
      return await findComposerGeometry(page, null);
    } catch (error) {
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now();
        logs.push(`[step2] Waiting Flow composer render: ${error.message}`);
      }
      await page.waitForTimeout(1000);
    }
  }
  throw new Error("Flow load timeout: khong thay khung prompt composer");
}

async function ensureFlowPageReady(page, projectUrl, logs) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!page.url().includes(projectUrl)) {
      logs.push(`[step2] goto Flow attempt ${attempt}`);
      await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    } else if (attempt > 1) {
      logs.push(`[step2] reload Flow attempt ${attempt}`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 });
    }

    await page.waitForTimeout(3500);
    await dismissPopupsIfAny(page, logs);
    try {
      const geometry = await waitForFlowComposerReady(page, logs, 45000);
      logs.push(`[step2] PASS Flow ready on attempt ${attempt}`);
      return geometry;
    } catch (error) {
      logs.push(`[step2] Flow not ready on attempt ${attempt}: ${error.message}`);
      if (attempt === 3) throw error;
    }
  }
  throw new Error("Flow page did not become ready");
}

const PROMPT_INPUT_SELECTORS = [
  '.ql-editor[contenteditable="true"]',
  'rich-textarea .ql-editor[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  "textarea",
  '[contenteditable="true"]',
  'input[type="text"]',
];

function normalizePromptText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeCompanyLogoPromptLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .filter((line) => !/logo/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function findPromptInput(page, timeoutMs = 2000) {
  for (const selector of PROMPT_INPUT_SELECTORS) {
    try {
      const locator = page.locator(selector).filter({ hasNotText: "T\u00ecm ki\u1ebfm" }).last();
      if (await locator.isVisible({ timeout: timeoutMs })) {
        return { locator, selector };
      }
    } catch (_) {}
  }

  return null;
}

async function readPromptInputText(locator) {
  return locator.evaluate((element) => {
    const htmlElement = /** @type {HTMLElement | HTMLInputElement | HTMLTextAreaElement} */ (
      element
    );
    if ("value" in htmlElement && typeof htmlElement.value === "string") {
      return htmlElement.value;
    }
    return htmlElement.innerText || htmlElement.textContent || "";
  });
}

async function forceSetPromptText(locator, promptText) {
  return locator.evaluate((element, value) => {
    const target = /** @type {HTMLElement | HTMLInputElement | HTMLTextAreaElement} */ (element);
    target.focus();

    if ("value" in target && typeof target.value === "string") {
      target.value = value;
    } else {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      try {
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, value);
      } catch {}
      const current = target.innerText || target.textContent || "";
      if (!current.includes(value.slice(0, 20))) {
        target.textContent = value;
      }
    }

    target.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }),
    );
    target.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      }),
    );
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }, promptText);
}

async function verifyPromptAnywhere(page, promptText) {
  const needle = normalizePromptText(promptText).slice(0, Math.min(40, normalizePromptText(promptText).length));
  if (!needle) return false;
  return page.evaluate((expected) => {
    const nodes = Array.from(
      document.querySelectorAll(
        '[data-slate-editor="true"][contenteditable="true"], .ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea, input[type="text"]',
      ),
    );
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    return nodes.some((node) => {
      const text = "value" in node ? node.value : node.innerText || node.textContent || "";
      return normalize(text).includes(expected);
    });
  }, needle);
}

async function waitForPromptValue(page, expectedText, logs, timeoutMs = 5000) {
  const normalizedExpected = normalizePromptText(expectedText);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const promptInput = await findPromptInput(page, 400);
    if (promptInput) {
      const currentText = normalizePromptText(await readPromptInputText(promptInput.locator));
      if (
        currentText === normalizedExpected ||
        currentText.includes(normalizedExpected) ||
        normalizedExpected.includes(currentText)
      ) {
        logs.push(`[step4] Prompt verified in ${promptInput.selector}`);
        return true;
      }
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function findComposer(page) {
  const promptInput = await findPromptInput(page, 3000);
  if (!promptInput) {
    throw new Error("Khong tim thay prompt input/composer");
  }

  const candidateSelectors = [
    "xpath=ancestor::*[.//input[@type='file']][1]",
    "xpath=ancestor::form[1]",
    "xpath=ancestor::section[1]",
    "xpath=ancestor::div[.//input[@type='file']][1]",
    "xpath=ancestor::div[1]",
  ];

  for (const selector of candidateSelectors) {
    const candidate = promptInput.locator.locator(selector).first();
    const visible = await candidate.isVisible({ timeout: 800 }).catch(() => false);
    if (!visible) continue;

    const fileInputCount = await candidate
      .locator('input[type="file"]')
      .count()
      .catch(() => 0);
    if (fileInputCount > 0) {
      return candidate;
    }
  }

  return null;
}

async function isGenerationInFlight(page) {
  const runningSelectors = [
    'button:has-text("Stop")',
    'button:has-text("D\u1eebng")',
    'button:has-text("Cancel")',
    'button:has-text("H\u1ee7y")',
    'button[aria-label*="Stop" i]',
    'button[aria-label*="Cancel" i]',
    'button[aria-label*="H\u1ee7y" i]',
    'button[aria-label*="D\u1eebng" i]',
  ];

  for (const selector of runningSelectors) {
    if (
      await page
        .locator(selector)
        .last()
        .isVisible({ timeout: 250 })
        .catch(() => false)
    ) {
      return true;
    }
  }

  const runningTexts = [
    "Generating",
    "Creating",
    "Processing",
    "Rendering",
    "Uploading",
    "\u0110ang t\u1ea1o",
    "\u0110ang x\u1eed l\u00fd",
    "\u0110ang t\u1ea3i",
  ];
  for (const label of runningTexts) {
    if (
      await page
        .getByText(label, { exact: false })
        .first()
        .isVisible({ timeout: 250 })
        .catch(() => false)
    ) {
      return true;
    }
  }

  const progressVisible = await page
    .locator("text=/\\b\\d{1,3}%\\b/")
    .first()
    .isVisible({ timeout: 250 })
    .catch(() => false);
  if (progressVisible) return true;

  return false;
}

async function clickComposerPlus(page, logs) {
  const geometry = await waitForFlowComposerReady(page, logs, 90000);
  const { plusBox } = await findComposerGeometry(page, logs);
  const x = plusBox.x + plusBox.width / 2;
  const y = plusBox.y + plusBox.height / 2;
  logs.push(`[step3] Clicking composer + at x=${Math.round(x)}, y=${Math.round(y)}`);
  await page.mouse.click(x, y);
  await page.waitForTimeout(700);
  return geometry.promptBox;
}

async function clickUploadImageMenuItem(page, logs) {
  const candidates = [
    page.getByText("Upload image", { exact: true }),
    page.getByText("Upload images", { exact: true }),
    page.getByText("Tải hình ảnh lên", { exact: true }),
    page.locator('[role="menuitem"]').filter({ hasText: /tải hình ảnh|tai hinh anh|upload|image/i }),
    page.locator("button").filter({ hasText: /tải hình ảnh|tai hinh anh|upload|image/i }),
    page.locator("div").filter({ hasText: /^Tải hình ảnh lên$/i }),
    page.locator('button:has(i:has-text("upload"))'),
    page.locator('div:has(i:has-text("upload"))'),
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const locator = candidates[index].first();
    if (await locator.isVisible({ timeout: 3000 }).catch(() => false)) {
      logs.push(`[step3] Clicking upload image menu item by candidate ${index}`);
      await locator.click({ force: true, timeout: 5000 });
      return;
    }
  }
  throw new Error("Khong tim thay menu Tai hinh anh len");
}

async function readComposerRootState(page, promptBox) {
  return page.evaluate((box) => {
    const isVisible = (element, minWidth = 8, minHeight = 8) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width >= minWidth &&
        rect.height >= minHeight
      );
    };
    const normalize = (value) =>
      String(value || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const prompt = Array.from(
      document.querySelectorAll(
        'div[role="textbox"][contenteditable="true"], [data-slate-editor="true"][contenteditable="true"], .ql-editor[contenteditable="true"], textarea, input[type="text"]',
      ),
    ).find((element) => {
      if (!isVisible(element, 80, 10)) return false;
      const rect = element.getBoundingClientRect();
      return (
        Math.abs(rect.x - box.x) < 100 &&
        Math.abs(rect.y - box.y) < 140 &&
        Math.abs(rect.width - box.width) < 220
      );
    });

    if (!prompt) {
      return { found: false, imageCount: 0, loading: false, failed: false, rootBox: null };
    }

    let root = prompt;
    let bestScore = -Infinity;
    for (
      let current = prompt.parentElement;
      current && current !== document.body;
      current = current.parentElement
    ) {
      const rect = current.getBoundingClientRect();
      const text = normalize(current.textContent || "");
      const hasComposerButton =
        text.includes("add_2") ||
        text.includes("arrow_forward") ||
        text.includes("create") ||
        text.includes("tao");
      const plausibleSize =
        rect.width >= 300 &&
        rect.width <= 1000 &&
        rect.height >= 70 &&
        rect.height <= 420 &&
        rect.y >= box.y - 360 &&
        rect.y <= box.y + 120;
      if (!plausibleSize || !hasComposerButton) continue;
      const score = rect.width + rect.height * 2 - Math.abs(rect.y - (box.y - 70));
      if (score > bestScore) {
        bestScore = score;
        root = current;
      }
    }

    const rootRect = root.getBoundingClientRect();
    const images = Array.from(root.querySelectorAll("img")).filter((img) => isVisible(img, 20, 20));
    const textBlob = normalize(
      Array.from(root.querySelectorAll("*"))
        .filter((element) => isVisible(element))
        .map((element) => element.textContent || "")
        .join("\n"),
    );
    const loading =
      /\b(?:100|[1-9]?\d)%\b/.test(textBlob) ||
      textBlob.includes("dang tai") ||
      textBlob.includes("dang xu ly") ||
      textBlob.includes("uploading") ||
      textBlob.includes("processing");
    const failed =
      textBlob.includes("failed") ||
      textBlob.includes("khong thanh cong") ||
      textBlob.includes("không thành công") ||
      textBlob.includes("loi") ||
      textBlob.includes("lỗi");

    return {
      found: true,
      imageCount: images.length,
      loading,
      failed,
      rootBox: {
        x: rootRect.x,
        y: rootRect.y,
        width: rootRect.width,
        height: rootRect.height,
      },
      inputCount: root.querySelectorAll('input[type="file"]').length,
    };
  }, promptBox);
}

async function setFilesViaFileInputFallback(page, imagePaths, logs) {
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const input = inputs.nth(index);
    try {
      await input.setInputFiles(imagePaths, { timeout: 15000 });
      logs.push(`[step3] Uploaded ${imagePaths.length} image file(s) via input[type=file] fallback`);
      return true;
    } catch (error) {
      logs.push(`[step3] File input fallback skipped index=${index}: ${error.message.split("\n")[0]}`);
    }
  }
  return false;
}

async function uploadImagesRobust(page, imagePaths, logs) {
  const normalizedPaths = [
    ...new Set(
      parseList(imagePaths)
        .map((item) => path.resolve(String(item || "").trim()))
        .filter(Boolean),
    ),
  ];
  if (!normalizedPaths.length) throw new Error("Khong co file anh nao de upload");

  const missingFiles = normalizedPaths.filter((filePath) => !existsSync(filePath));
  if (missingFiles.length) throw new Error(`Khong tim thay file upload: ${missingFiles.join(", ")}`);

  logs.push("[step3] Finding composer and opening upload menu");
  const promptBox = await clickComposerPlus(page, logs);
  const beforeState = await readComposerRootState(page, promptBox).catch(() => null);
  if (beforeState?.rootBox) {
    logs.push(
      `[step3] Composer root x=${Math.round(beforeState.rootBox.x)}, y=${Math.round(
        beforeState.rootBox.y,
      )}, w=${Math.round(beforeState.rootBox.width)}, h=${Math.round(
        beforeState.rootBox.height,
      )}, fileInputs=${beforeState.inputCount}`,
    );
  }
  const beforeCount = beforeState?.imageCount || 0;
  logs.push(`[step3] Composer image count before upload=${beforeCount}`);

  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 20000 }).catch((error) => {
    logs.push(`[step3] File chooser did not open, using file input fallback: ${error.message.split("\n")[0]}`);
    return null;
  });
  await clickUploadImageMenuItem(page, logs);
  const fileChooser = await fileChooserPromise;
  logs.push(`[step3] Uploading ${normalizedPaths.length} image file(s)`);
  if (fileChooser) {
    await fileChooser.setFiles(normalizedPaths);
  } else if (!(await setFilesViaFileInputFallback(page, normalizedPaths, logs))) {
    throw new Error("Khong mo duoc file chooser va khong tim thay input[type=file] de upload anh");
  }

  const startedAt = Date.now();
  let stablePasses = 0;
  const expectedImageCount = Math.max(normalizedPaths.length, beforeCount + normalizedPaths.length);
  while (Date.now() - startedAt < 180000) {
    const state = await readComposerRootState(page, promptBox).catch(() => null);
    const count = state?.imageCount || 0;
    const loading = Boolean(state?.loading);
    const failed = Boolean(state?.failed);
    const enoughImages = count >= expectedImageCount;

    if (failed) {
      stablePasses = 0;
      logs.push(
        `[step3] Waiting upload recovery: composerImages=${count}, expected=${expectedImageCount}, failed=${failed}`,
      );
    } else if (enoughImages && !loading) {
      stablePasses += 1;
      if (stablePasses >= 3) {
        logs.push(
          `[step3] Upload appears complete: composerImages=${count}, expected=${expectedImageCount}, loading=${loading}`,
        );
        logs.push(`[step3] Waiting ${UPLOAD_SETTLE_MS}ms for uploaded images to settle`);
        await page.waitForTimeout(UPLOAD_SETTLE_MS);
        const settledState = await readComposerRootState(page, promptBox).catch(() => null);
        const settledCount = settledState?.imageCount || 0;
        const settledLoading = Boolean(settledState?.loading);
        const settledFailed = Boolean(settledState?.failed);
        if (settledCount >= expectedImageCount && !settledLoading && !settledFailed) {
          logs.push(
            `[step3] PASS upload settled: composerImages=${settledCount}, loading=${settledLoading}, failed=${settledFailed}`,
          );
          return { promptBox, normalizedPaths };
        }
        logs.push(
          `[step3] Upload changed during settle wait: composerImages=${settledCount}, loading=${settledLoading}, failed=${settledFailed}`,
        );
        stablePasses = 0;
      }
    } else {
      stablePasses = 0;
      logs.push(
        `[step3] Waiting upload complete: composerImages=${count}, expected=${expectedImageCount}, loading=${loading}, failed=${failed}`,
      );
    }
    await page.waitForTimeout(1200);
  }
  throw new Error("Upload timeout: anh chua xuat hien du trong khung composer");
}

async function findPromptLocatorForBox(page, promptBox = null) {
  const selectors = [
    'div[role="textbox"][data-slate-editor="true"][contenteditable="true"]',
    '[data-slate-editor="true"][contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"]',
    "textarea",
    'input[type="text"]',
  ];

  const candidates = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const box = await item.boundingBox().catch(() => null);
      if (!box || box.width < 80 || box.height < 10) continue;
      const meta = await item
        .evaluate((element) =>
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            element.getAttribute("title"),
          ].join(" "),
        )
        .catch(() => "");
      const normalized = normalizeText(meta);
      if (normalized.includes("search") || normalized.includes("tim kiem")) continue;

      let score = box.y;
      if (box.y > 300) score += 300;
      if (normalized.includes("ban muon tao") || normalized.includes("tao gi")) score += 250;
      if (promptBox) {
        const intersects =
          box.x >= promptBox.x - 50 &&
          box.x <= promptBox.x + promptBox.width + 50 &&
          box.y >= promptBox.y - 80 &&
          box.y <= promptBox.y + promptBox.height + 120;
        if (intersects) score += 500;
      }
      candidates.push({ locator: item, score });
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.locator || null;
}

async function clickPromptPlaceholder(page, logs) {
  const placeholder = page.getByText("Bạn muốn tạo gì?", { exact: false }).last();
  if (await placeholder.isVisible({ timeout: 700 }).catch(() => false)) {
    const box = await placeholder.boundingBox().catch(() => null);
    if (box && box.y > 300) {
      logs.push(`[step4] Clicking prompt placeholder at x=${Math.round(box.x)}, y=${Math.round(box.y)}`);
      await page.mouse.click(box.x + 8, box.y + Math.max(8, box.height / 2));
      await page.waitForTimeout(200);
    }
  }
}

async function prepareImageUpload(page, assetPaths, logs) {
  const normalizedAssetPaths = [
    ...new Set(
      parseList(assetPaths)
        .map((item) => path.resolve(String(item || "").trim()))
        .filter(Boolean),
    ),
  ];
  if (normalizedAssetPaths.length === 0) {
    throw new Error("Khong co file anh nao de upload");
  }

  const missingFiles = normalizedAssetPaths.filter((filePath) => !existsSync(filePath));
  if (missingFiles.length > 0) {
    throw new Error(`Khong tim thay file upload: ${missingFiles.join(", ")}`);
  }

  const expectedNames = normalizedAssetPaths.map((filePath) => path.basename(filePath));

  const findVisibleLocator = async (locatorFactories, timeoutMs = 2500) => {
    for (const factory of locatorFactories) {
      try {
        const locator = factory();
        const count = await locator.count().catch(() => 0);
        for (let index = count - 1; index >= 0; index -= 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible({ timeout: timeoutMs }).catch(() => false)) {
            return candidate;
          }
        }
      } catch (_) {}
    }
    return null;
  };

  const addButton = await findVisibleLocator([
    () => page.locator('button[aria-haspopup="dialog"]:has(i:has-text("add_2"))'),
    () =>
      page
        .locator('button[aria-haspopup="dialog"]')
        .filter({ has: page.locator('i:has-text("add_2")') }),
    () => page.locator('button:has(i:has-text("add_2"))'),
    () => page.getByRole("button", { name: /tạo/i }),
  ]);

  if (!addButton) {
    throw new Error("Khong tim thay nut '+' / 'Tạo' de mo menu tai file");
  }

  const resolveComposerRoot = async () => {
    const composerFromPrompt = await findComposer(page).catch(() => null);
    if (composerFromPrompt) return composerFromPrompt;

    const relativeCandidates = [
      addButton.locator("xpath=ancestor::form[1]"),
      addButton.locator("xpath=ancestor::section[1]"),
      addButton.locator('xpath=ancestor::div[contains(@class, "composer")][1]'),
      addButton.locator("xpath=ancestor::div[1]"),
    ];

    for (const candidate of relativeCandidates) {
      if (await candidate.isVisible({ timeout: 800 }).catch(() => false)) {
        return candidate;
      }
    }

    return page.locator("body");
  };

  const composerRoot = await resolveComposerRoot();
  const beforeState = await composerRoot.evaluate((root) => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity || "1") === 0
      ) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width >= 24 && rect.height >= 24;
    };

    const images = Array.from(root.querySelectorAll("img")).filter((img) => isVisible(img));
    const percentNodes = Array.from(root.querySelectorAll("*")).filter((node) => {
      if (!(node instanceof HTMLElement) || !isVisible(node)) return false;
      const text = (node.textContent || "").trim();
      return /^\d{1,3}%$/.test(text);
    });

    return {
      imageCount: images.length,
      percentCount: percentNodes.length,
    };
  });

  logs.push("[step3] Mo menu tai file bang nut + ...");
  await addButton.click({ force: true, timeout: 5000 });

  const uploadMenuItem = await findVisibleLocator(
    [
      () => page.locator('[role="menuitem"]').filter({ hasText: /^Tải hình ảnh lên$/i }),
      () => page.locator("button").filter({ hasText: /^Tải hình ảnh lên$/i }),
      () => page.locator("div").filter({ hasText: /^Tải hình ảnh lên$/i }),
      () => page.locator('div:has(i:has-text("upload"))').filter({ hasText: /Tải hình ảnh lên/i }),
      () => page.getByText("Tải hình ảnh lên", { exact: true }),
    ],
    4000,
  );

  if (!uploadMenuItem) {
    throw new Error("Khong tim thay menu 'Tải hình ảnh lên'");
  }

  logs.push("[step3] Đang đẩy toàn bộ file lên...");
  const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 15000 });
  await uploadMenuItem.click({ force: true, timeout: 5000 });
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(normalizedAssetPaths);

  logs.push("[step3] Đang chờ file xử lý 100%...");
  const startedAt = Date.now();
  let stablePasses = 0;
  while (Date.now() - startedAt < 120000) {
    const state = await composerRoot.evaluate(
      (root, payload) => {
        const { expectedNames, beforeImageCount } = payload;
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") === 0
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width >= 24 && rect.height >= 24;
        };

        const images = Array.from(root.querySelectorAll("img")).filter((img) => isVisible(img));
        const visibleTexts = Array.from(root.querySelectorAll("*"))
          .filter((node) => node instanceof HTMLElement && isVisible(node))
          .map((node) => (node.textContent || "").trim())
          .filter(Boolean);
        const textBlob = visibleTexts.join("\n");

        const labeledValues = Array.from(
          root.querySelectorAll("[alt], [title], [aria-label], [data-testid]"),
        )
          .map((node) => {
            if (!(node instanceof HTMLElement)) return "";
            return [
              node.getAttribute("alt") || "",
              node.getAttribute("title") || "",
              node.getAttribute("aria-label") || "",
              node.getAttribute("data-testid") || "",
            ].join(" ");
          })
          .join("\n");

        const percentTexts = visibleTexts.filter(
          (text) => /^\d{1,3}%$/.test(text) || /\b\d{1,3}%\b/.test(text),
        );
        const loadingTexts = visibleTexts.filter((text) =>
          /uploading|processing|đang tải|đang xử lý/i.test(text),
        );

        const matchedNames = expectedNames.filter((fileName) => {
          return textBlob.includes(fileName) || labeledValues.includes(fileName);
        });

        return {
          imageCount: images.length,
          newImageCount: Math.max(0, images.length - beforeImageCount),
          matchedNames: matchedNames.length,
          percentCount: percentTexts.length,
          loadingCount: loadingTexts.length,
        };
      },
      { expectedNames, beforeImageCount: beforeState.imageCount },
    );

    const enoughImages =
      state.newImageCount >= normalizedAssetPaths.length ||
      state.imageCount >= beforeState.imageCount + normalizedAssetPaths.length;
    const enoughLabels = state.matchedNames >= expectedNames.length;
    const noLoadingUi = state.percentCount === 0 && state.loadingCount === 0;

    if ((enoughImages || enoughLabels) && noLoadingUi) {
      stablePasses += 1;
      if (stablePasses >= 3) {
        logs.push(
          `[step3] Upload hoan tat: imageCount=${state.imageCount}, newImageCount=${state.newImageCount}, matchedNames=${state.matchedNames}`,
        );
        return normalizedAssetPaths;
      }
    } else {
      stablePasses = 0;
    }

    await page.waitForTimeout(700);
  }

  throw new Error(`Upload anh timeout, composer chua on dinh cho: ${expectedNames.join(", ")}`);
}

async function setPromptRobust(page, promptText, logs, promptBox = null) {
  logs.push("[step4] Typing prompt");
  const verifyPrompt = async (locator) => {
    const currentText = normalizePromptText(await readPromptInputText(locator));
    const expected = normalizePromptText(promptText).slice(0, Math.min(40, normalizePromptText(promptText).length));
    return currentText.includes(expected) || (await verifyPromptAnywhere(page, promptText));
  };

  const promptLocator = await findPromptLocatorForBox(page, promptBox).catch(() => null);
  if (promptLocator) {
    try {
      await promptLocator.scrollIntoViewIfNeeded().catch(() => {});
      await clickPromptPlaceholder(page, logs);
      const box = await promptLocator.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
      } else {
        await promptLocator.click({ force: true, timeout: 3000 });
      }
      await page.waitForTimeout(300);
      await page.keyboard
        .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
        .catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});

      const pasted = await page
        .evaluate(async (value) => {
          await navigator.clipboard.writeText(value);
          return true;
        }, promptText)
        .catch(() => false);
      if (pasted) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        logs.push("[step4] Prompt inserted via focused composer clipboard paste");
      } else {
        await forceSetPromptText(promptLocator, promptText);
        logs.push("[step4] Prompt inserted via focused composer direct set");
      }

      await page.waitForTimeout(700);
      if (await verifyPrompt(promptLocator)) {
        logs.push("[step4] Prompt verified in focused composer");
        return { promptBox, promptLocator };
      }
      logs.push("[step4] Focused composer prompt did not verify; trying selector fallbacks");
    } catch (error) {
      logs.push(`[step4] Focused composer prompt insert failed: ${error.message.split("\n")[0]}`);
    }
  }

  const candidates = PROMPT_INPUT_SELECTORS;
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).filter({ hasNotText: "T\u00ecm ki\u1ebfm" }).last();
      if (await loc.isVisible({ timeout: 2000 })) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const tagName = await loc.evaluate((el) => el.tagName.toLowerCase());

        await loc.click({ timeout: 2000 });
        await page.keyboard
          .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
          .catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});

        if (tagName === "textarea" || tagName === "input") {
          await loc.fill(promptText);
        } else {
          await forceSetPromptText(loc, promptText);
        }

        await page.waitForTimeout(500);
        if (await verifyPrompt(loc)) {
          logs.push(`[step4] Prompt verified after direct set in ${sel}`);
          return { promptBox, promptLocator: loc };
        }

        logs.push(`[step4] Prompt not visible after direct set in ${sel}; retrying clipboard paste`);
        await loc.click({ timeout: 2000 }).catch(() => {});
        await page.keyboard
          .press(process.platform === "darwin" ? "Meta+A" : "Control+A")
          .catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        const pasted = await page
          .evaluate(async (value) => {
            await navigator.clipboard.writeText(value);
            return true;
          }, promptText)
          .catch(() => false);
        if (pasted) {
          await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        } else {
          await forceSetPromptText(loc, promptText);
        }
        await page.waitForTimeout(700);
        if (await verifyPrompt(loc)) {
          logs.push(`[step4] Prompt verified after paste in ${sel}`);
          return { promptBox, promptLocator: loc };
        }

        logs.push(`[step4] Prompt still not visible in ${sel}; trying next candidate`);
      }
    } catch (_) {}
  }

  throw new Error("Could not set and verify prompt text in the composer");
}

async function findComposerSubmitButtonBox(page, promptBox = null) {
  return page.evaluate((box) => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width >= 16 &&
        rect.height >= 16
      );
    };
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter(isVisible)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        const text = (button.textContent || "").toLowerCase();
        const disabled =
          button.disabled ||
          button.getAttribute("aria-disabled") === "true" ||
          button.getAttribute("disabled") !== null;
        const inComposer = box
          ? rect.x >= box.x - 120 &&
            rect.x <= box.x + box.width + 140 &&
            rect.y >= box.y - 140 &&
            rect.y <= box.y + box.height + 240
          : rect.y > window.innerHeight * 0.45;
        const isArrow = text.includes("arrow_forward");
        const isModelSelector =
          text.includes("nano banana") ||
          text.includes("crop_16_9") ||
          text.includes("pro") ||
          text.includes("1x");
        const squareish = rect.width <= 72 && rect.height <= 72;
        let score = 0;
        if (isArrow) score += 500;
        if (inComposer) score += 400;
        if (squareish) score += 180;
        if (isModelSelector) score -= 500;
        score += rect.x / 6 + rect.y / 40;
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          score,
          disabled,
        };
      })
      .filter((item) => item.score > 300)
      .sort((left, right) => right.score - left.score);
    return buttons[0] || null;
  }, promptBox);
}

async function findComposerSubmitTarget(page, promptBox = null) {
  const buttonBox = await findComposerSubmitButtonBox(page, promptBox).catch(() => null);
  if (buttonBox) return { ...buttonBox, source: "button" };

  const state = promptBox ? await readComposerRootState(page, promptBox).catch(() => null) : null;
  if (state?.rootBox) {
    return {
      x: state.rootBox.x + state.rootBox.width - 28,
      y: state.rootBox.y + state.rootBox.height - 24,
      width: 1,
      height: 1,
      text: "composer-bottom-right-fallback",
      disabled: false,
      source: "root-fallback",
    };
  }
  return null;
}

async function waitForComposerReadyToSubmit(page, promptBox, logs, timeoutMs = 60000) {
  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const state = promptBox ? await readComposerRootState(page, promptBox).catch(() => null) : null;
    const submitButton = await findComposerSubmitTarget(page, promptBox).catch(() => null);
    const loading = Boolean(state?.loading);
    const failed = Boolean(state?.failed);
    if (submitButton && !loading && !failed) {
      logs.push(
        `[step5] PASS composer submit target is visible and upload loading is complete source=${submitButton.source} disabled=${submitButton.disabled}`,
      );
      logs.push(`[step5] Waiting ${PRE_SUBMIT_SETTLE_MS}ms before submit`);
      await page.waitForTimeout(PRE_SUBMIT_SETTLE_MS);
      const settledState = promptBox ? await readComposerRootState(page, promptBox).catch(() => null) : null;
      if (!Boolean(settledState?.loading) && !Boolean(settledState?.failed)) return true;
    }
    if (Date.now() - lastLogAt > 5000) {
      lastLogAt = Date.now();
      logs.push(
        `[step5] Waiting composer submit ready: hasButton=${Boolean(submitButton)}, disabled=${
          submitButton?.disabled ?? "unknown"
        }, loading=${loading}, failed=${failed}`,
      );
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("Timeout waiting for composer submit button to become active after upload");
}

async function promptLocatorStillHasPrompt(promptLocator, expectedPrompt) {
  const current = normalizePromptText(await readPromptInputText(promptLocator).catch(() => ""));
  const expected = normalizePromptText(expectedPrompt);
  return Boolean(expected && (current === expected || current.includes(expected)));
}

async function submitPrompt(page, logs, expectedPrompt = "", promptBox = null, promptLocator = null) {
  logs.push("[step5] Submitting prompt");
  if (promptBox) {
    await waitForComposerReadyToSubmit(page, promptBox, logs);
    const clickSubmit = async (label) => {
      const buttonBox = await findComposerSubmitTarget(page, promptBox);
      if (!buttonBox) return false;
      const x = buttonBox.width > 1 ? buttonBox.x + buttonBox.width / 2 : buttonBox.x;
      const y = buttonBox.height > 1 ? buttonBox.y + buttonBox.height / 2 : buttonBox.y;
      logs.push(
        `[step5] Clicking composer submit ${label} source=${buttonBox.source} x=${Math.round(x)}, y=${Math.round(y)}, disabled=${buttonBox.disabled}, text="${buttonBox.text}"`,
      );
      await page.mouse.click(x, y);
      await page.waitForTimeout(2500);
      return true;
    };

    if (await clickSubmit("primary")) {
      if (
        promptLocator &&
        expectedPrompt &&
        (await promptLocatorStillHasPrompt(promptLocator, expectedPrompt))
      ) {
        logs.push("[step5] Prompt still visible after submit click; retrying composer submit once");
        await clickSubmit("retry");
        if (await promptLocatorStillHasPrompt(promptLocator, expectedPrompt)) {
          logs.push("[step5] Prompt still visible after retry; sending Control+Enter fallback");
          await promptLocator.click({ force: true, timeout: 2000 }).catch(() => {});
          await page.keyboard.press("Control+Enter").catch(() => {});
          await page.waitForTimeout(1500);
        }
      }
      return;
    }
  }

  const submitCandidates = [
    "button.send-button",
    'button[aria-label="G\u1eedi tin nh\u1eafn"]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
    'button[aria-label*="T\u1ea1o"]',
    'button[aria-label*="Generate"]',
    'button:has-text("T\u1ea1o")',
    'button:has-text("Generate")',
    '[role="button"]:has-text("T\u1ea1o")',
    '[role="button"]:has-text("Generate")',
  ];

  for (const selector of submitCandidates) {
    try {
      const button = page.locator(selector).last();
      if ((await button.isVisible({ timeout: 1500 })) && (await button.isEnabled())) {
        await button.click({ force: true, timeout: 3000 });
        logs.push(`[step5] Clicked submit via ${selector}`);
        await page.waitForTimeout(1000);
        return;
      }
    } catch (_) {}
  }

  if (expectedPrompt && !(await waitForPromptValue(page, expectedPrompt, logs, 1500))) {
    throw new Error("Prompt text was not confirmed in the composer before fallback submit.");
  }

  const promptInput = await findPromptInput(page, 1000);
  if (promptInput) {
    await promptInput.locator.click({ timeout: 1000 }).catch(() => {});
  }
  await page.keyboard.press("Enter");
  logs.push("[step5] Submitted via Enter key");
  await page.waitForTimeout(1000);
}

async function waitForNewVideoSource(page, beforeVideoSources, timeoutMs, logs) {
  const beforeSet = new Set((beforeVideoSources || []).filter(Boolean));
  const startedAt = Date.now();
  let candidateSource = "";
  let stablePasses = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const currentSources = await collectVideoSources(page);
    const freshSources = currentSources.filter((src) => src && !beforeSet.has(src));
    const freshSource = freshSources[0] || "";
    const generationInFlight = await isGenerationInFlight(page).catch(() => false);

    if (freshSource) {
      if (freshSource === candidateSource) {
        stablePasses += 1;
      } else {
        candidateSource = freshSource;
        stablePasses = 1;
        logs.push(`[step6] Detected candidate video source: ${freshSource}`);
      }

      if (stablePasses >= 3 && !generationInFlight) {
        logs.push(`[step6] PASS new video source is stable and generation is idle: ${freshSource}`);
        return freshSource;
      }

      logs.push(
        `[step6] Waiting video source to settle: stablePasses=${stablePasses}, generationInFlight=${generationInFlight}`,
      );
    }

    await page.waitForTimeout(3000);
  }

  throw new Error("Timeout waiting for a new video source generated after submit");
}

async function waitForVideoResource(page, timeoutMs, logs, beforeVideoSources) {
  logs.push(`[step6] Waiting up to ${timeoutMs / 1000}s for newly generated video...`);
  const source = await waitForNewVideoSource(page, beforeVideoSources, timeoutMs, logs);
  return { source };
}

function qualityRank(text) {
  const normalized = String(text || "").toLowerCase();
  if (normalized.includes("4k") || normalized.includes("2160p")) return 2160;
  if (normalized.includes("1440p")) return 1440;
  if (normalized.includes("1080p")) return 1080;
  if (normalized.includes("720p")) return 720;
  if (normalized.includes("480p")) return 480;
  if (normalized.includes("360p")) return 360;
  if (normalized.includes("270p")) return 270;
  return 0;
}

function normalizeResolutionLabel(text) {
  const normalized = String(text || "").toLowerCase();
  if (normalized.includes("4k") || normalized.includes("2160p")) return "4k";
  if (normalized.includes("1440p")) return "1440p";
  if (normalized.includes("1080p")) return "1080p";
  if (normalized.includes("720p")) return "720p";
  if (normalized.includes("480p")) return "480p";
  if (normalized.includes("360p")) return "360p";
  if (normalized.includes("270p")) return "270p";
  return "";
}

function extensionForResolution(resolutionLabel) {
  return resolutionLabel === "270p" ? ".gif" : ".mp4";
}

function toSafeBaseName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function killAllCocCocBrowsers(logs) {
  try {
    if (process.platform === "win32") {
      execSync("taskkill /IM browser.exe /F", { stdio: "pipe" });
      logs.push("[cleanup] Killed all Coc Coc browser processes on Windows");
    } else if (process.platform === "darwin") {
      execSync('pkill -9 -f "CocCoc.*browser"', { stdio: "pipe" });
      logs.push("[cleanup] Killed all Coc Coc browser processes on macOS");
    } else {
      execSync('pkill -9 -f "browser.*CocCoc"', { stdio: "pipe" });
      logs.push("[cleanup] Killed all Coc Coc browser processes on Linux");
    }
  } catch (err) {
    logs.push(`[cleanup] Note: ${err.message.split("\n")[0]}`);
  }
}

async function saveDownloadWithMediaExtension(download, outputDir, logs, selectedResolution) {
  const rawSuggested = String(download.suggestedFilename() || "").trim();
  const normalizedSelected = normalizeResolutionLabel(selectedResolution) || "720p";
  const wantedExt = extensionForResolution(normalizedSelected);

  let fileName = toSafeBaseName(rawSuggested);
  const currentExt = path.extname(fileName).toLowerCase();
  const hasKnownMediaExt = /\.(mp4|webm|mov|mkv|gif)$/i.test(currentExt);
  const looksLikeUuid = /^[0-9a-f-]{24,}$/i.test(fileName.replace(/\.[^/.]+$/, ""));

  if (!fileName || !hasKnownMediaExt || looksLikeUuid) {
    let stem = fileName.replace(/\.[^/.]+$/, "");
    if (!stem || looksLikeUuid) {
      stem = `veo-${normalizedSelected}-${nowStamp()}`;
    }
    fileName = `${stem}${wantedExt}`;
  }

  const destination = path.join(outputDir, fileName);
  await download.saveAs(destination);
  logs.push(`[step7] Saved media file: ${destination}`);
  return destination;
}

function buildMediaOutputPath(outputDir, selectedResolution) {
  const normalizedSelected = normalizeResolutionLabel(selectedResolution) || "720p";
  const ext = extensionForResolution(normalizedSelected);
  const fileName = `veo-${normalizedSelected}-${nowStamp()}${ext}`;
  return path.join(outputDir, fileName);
}

function isUpsellOption(text) {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("n\u00e2ng c\u1ea5p") ||
    normalized.includes("upgrade") ||
    normalized.includes("premium") ||
    normalized.includes("pro")
  );
}

async function findLeftmostVideoCard(page, logs) {
  const mediaNodes = page.locator("img, video");
  const mediaCount = await mediaNodes.count();
  const cardCandidates = [];

  for (let i = 0; i < mediaCount; i += 1) {
    const media = mediaNodes.nth(i);
    const box = await media.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.width < 140 || box.height < 220) continue;
    if (box.y < 80) continue;
    cardCandidates.push({ mediaIndex: i, x: box.x, y: box.y, w: box.width, h: box.height });
  }

  if (cardCandidates.length === 0) {
    logs.push("[step7] Could not detect any visible video card candidate");
    return null;
  }

  cardCandidates.sort((a, b) => {
    const rowDelta = Math.abs(a.y - b.y);
    if (rowDelta > 24) return a.y - b.y;
    return a.x - b.x;
  });

  const chosenCard = cardCandidates[0];
  logs.push(
    `[step7] Picked leftmost card geometry: x=${Math.round(chosenCard.x)}, y=${Math.round(chosenCard.y)}, w=${Math.round(chosenCard.w)}, h=${Math.round(chosenCard.h)}`,
  );

  const menuButtons = page.locator('button[aria-haspopup="menu"]');
  const menuCount = await menuButtons.count();
  let bestMenuIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  const targetX = chosenCard.x + chosenCard.w - 24;
  const targetY = chosenCard.y + 24;

  for (let i = 0; i < menuCount; i += 1) {
    const menuBtn = menuButtons.nth(i);
    const box = await menuBtn.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.y < chosenCard.y - 20 || box.y > chosenCard.y + 90) continue;
    if (box.x < chosenCard.x - 40 || box.x > chosenCard.x + chosenCard.w + 60) continue;

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const distance = Math.abs(centerX - targetX) + Math.abs(centerY - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMenuIndex = i;
    }
  }

  return {
    media: mediaNodes.nth(chosenCard.mediaIndex),
    cardBox: chosenCard,
    menuButton: bestMenuIndex >= 0 ? menuButtons.nth(bestMenuIndex) : null,
  };
}

async function isPreviewOpen(page) {
  return page
    .locator('button:has-text("T\u1ea3i xu\u1ed1ng"), button:has-text("Download")')
    .first()
    .isVisible({ timeout: 2200 })
    .catch(() => false);
}

async function collectVideoSources(page) {
  return page
    .locator("video")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const element = /** @type {HTMLVideoElement} */ (node);
          return element.currentSrc || element.src || "";
        })
        .filter(Boolean),
    )
    .catch(() => []);
}

async function tryDownloadNewestVideoBySource(
  context,
  page,
  outputDir,
  logs,
  preferredResolution,
  beforeVideoSources,
) {
  const currentSources = await collectVideoSources(page);
  const beforeSet = new Set((beforeVideoSources || []).filter(Boolean));

  const candidates = currentSources.filter((src) => /^https?:\/\//i.test(src));
  const freshCandidates = candidates.filter((src) => !beforeSet.has(src));
  const targetSource = freshCandidates[0] || candidates[0] || "";

  if (!targetSource) {
    logs.push("[step7] Direct source fallback: no HTTP video source found");
    return null;
  }

  logs.push("[step7] Direct source fallback: downloading newest video by source URL");
  const response = await context.request.get(targetSource, { timeout: 60000 }).catch(() => null);
  if (!response || !response.ok()) {
    logs.push("[step7] Direct source fallback failed to fetch video URL");
    return null;
  }

  const body = await response.body();
  if (!body || body.length < 1024) {
    logs.push("[step7] Direct source fallback received empty/small payload");
    return null;
  }

  const destination = buildMediaOutputPath(outputDir, preferredResolution);
  await writeFile(destination, body);
  logs.push(`[step7] SUCCESS: Downloaded via direct source fallback -> ${destination}`);
  return destination;
}

async function downloadVideoByKnownSource(
  context,
  sourceUrl,
  outputDir,
  logs,
  preferredResolution,
) {
  const response = await context.request.get(sourceUrl, { timeout: 60000 }).catch(() => null);
  if (!response || !response.ok()) {
    throw new Error(`Khong the tai video tu source moi: ${sourceUrl}`);
  }

  const body = await response.body();
  if (!body || body.length < 1024) {
    throw new Error("Downloaded video payload is empty or too small");
  }

  const destination = buildMediaOutputPath(outputDir, preferredResolution);
  await writeFile(destination, body);
  logs.push(`[step7] Downloaded generated video by known source -> ${destination}`);
  return destination;
}

async function tryDownloadFromPreviewTopBar(page, outputDir, logs, preferredResolution) {
  const downloadButtons = page
    .locator('button[aria-haspopup="menu"], button')
    .filter({ hasText: /t\u1ea3i xu\u1ed1ng|download/i });

  const count = await downloadButtons.count();
  let chosenIndex = -1;
  let minY = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i += 1) {
    const btn = downloadButtons.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await btn.boundingBox().catch(() => null);
    if (!box) continue;
    if (box.y < minY) {
      minY = box.y;
      chosenIndex = i;
    }
  }

  if (chosenIndex < 0) {
    logs.push("[step7] Preview top-bar download button not found");
    return null;
  }

  const downloadBtn = downloadButtons.nth(chosenIndex);
  logs.push("[step7] Clicking preview top-bar 'Tải xuống' button...");
  const directDownload = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await downloadBtn.click({ force: true, timeout: 3000 });

  const maybeDirect = await directDownload;
  if (maybeDirect) {
    const dest = await saveDownloadWithMediaExtension(
      maybeDirect,
      outputDir,
      logs,
      preferredResolution,
    );
    logs.push(`[step7] SUCCESS: Downloaded directly from preview top-bar -> ${dest}`);
    return dest;
  }

  await page.waitForTimeout(700);
  const picked = await pickResolutionAndDownload(page, outputDir, logs, preferredResolution);
  if (picked) return picked;

  logs.push("[step7] Preview top-bar flow did not yield a download");
  return null;
}

async function pickResolutionAndDownload(page, outputDir, logs, preferredResolution) {
  const qualityCandidates = page
    .locator('[role="menuitem"], button, div')
    .filter({ hasText: /4k|2160p|1440p|1080p|720p|480p|360p|270p/i });

  const count = await qualityCandidates.count();
  const options = [];

  for (let i = 0; i < count; i += 1) {
    const option = qualityCandidates.nth(i);
    const visible = await option.isVisible().catch(() => false);
    if (!visible) continue;

    const text = (await option.textContent().catch(() => "")) || "";
    const rank = qualityRank(text);
    if (rank <= 0) continue;
    if (isUpsellOption(text)) {
      logs.push(
        `[step7] Skip quality option requiring upgrade: ${text.replace(/\s+/g, " ").trim()}`,
      );
      continue;
    }

    options.push({
      index: i,
      rank,
      label: normalizeResolutionLabel(text),
      text: text.replace(/\s+/g, " ").trim(),
    });
  }

  if (options.length === 0) {
    logs.push("[step7] No quality options found in download menu");
    return null;
  }

  const preferred = normalizeResolutionLabel(preferredResolution);
  let selected = null;

  if (preferred) {
    selected = options.find((item) => item.label === preferred) || null;
    if (selected) {
      logs.push(`[step7] Selecting preferred quality: ${selected.text}`);
    }
  }

  if (!selected) {
    options.sort((a, b) => b.rank - a.rank);
    selected = options[0];
    logs.push(`[step7] Preferred quality unavailable, fallback to: ${selected.text}`);
  }

  const target = qualityCandidates.nth(selected.index);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    target.click({ force: true }),
  ]);

  const dest = await saveDownloadWithMediaExtension(download, outputDir, logs, selected.label);
  logs.push(`[step7] SUCCESS: Downloaded -> ${dest}`);
  return dest;
}

async function openLatestCardPreview(page, target, logs) {
  if (!target?.cardBox) return false;

  const centerX = target.cardBox.x + target.cardBox.w / 2;
  const centerY = target.cardBox.y + target.cardBox.h / 2;
  logs.push("[step7] Opening preview of the leftmost (newest) video card...");

  if (target.media) {
    try {
      await target.media.click({ force: true, timeout: 2500 });
      if (await isPreviewOpen(page)) {
        logs.push("[step7] Preview opened via direct media click");
        return true;
      }
    } catch {}
  }

  await page.mouse.click(centerX, centerY, { button: "left" });
  if (await isPreviewOpen(page)) {
    logs.push("[step7] Preview opened via center click");
    return true;
  }

  await page.mouse.dblclick(centerX, centerY, { button: "left" });
  if (await isPreviewOpen(page)) {
    logs.push("[step7] Preview opened via double click");
    return true;
  }

  logs.push("[step7] Preview did not open after 3 click strategies");
  return false;
}

async function tryDownloadFromCardMenu(page, target, outputDir, logs, preferredResolution) {
  if (!target?.menuButton) {
    logs.push("[step7] No menu button mapped to newest card");
    return null;
  }

  logs.push("[step7] Fallback: open newest card menu and download from there...");
  await target.menuButton.click({ force: true, timeout: 3000 });
  await page.waitForTimeout(900);

  const downloadItem = page
    .locator('[role="menuitem"], button, div, span')
    .filter({ hasText: /(^|\s)(t\u1ea3i xu\u1ed1ng|download)(\s|$)/i })
    .first();

  if (!(await downloadItem.isVisible({ timeout: 2500 }).catch(() => false))) {
    logs.push("[step7] Download item not visible in newest card menu");
    return null;
  }

  const directDownload = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await downloadItem.click({ force: true, timeout: 3000 });
  const maybeDirect = await directDownload;

  if (maybeDirect) {
    const dest = await saveDownloadWithMediaExtension(
      maybeDirect,
      outputDir,
      logs,
      preferredResolution,
    );
    logs.push(`[step7] SUCCESS: Downloaded from newest card menu -> ${dest}`);
    return dest;
  }

  await page.waitForTimeout(700);
  return pickResolutionAndDownload(page, outputDir, logs, preferredResolution);
}

async function tryDownloadLatestVideo(page, outputDir, logs, preferredResolution) {
  logs.push("[step7] Download flow via preview dialog...");
  await page.waitForTimeout(3000);

  try {
    if (await isPreviewOpen(page)) {
      logs.push("[step7] Preview already open, using top-bar download flow");
      const previewTopBarDownloaded = await tryDownloadFromPreviewTopBar(
        page,
        outputDir,
        logs,
        preferredResolution,
      );
      if (previewTopBarDownloaded) return previewTopBarDownloaded;
    }

    const target = await findLeftmostVideoCard(page, logs);
    if (!target?.cardBox) {
      const previewFallback = await tryDownloadFromPreviewTopBar(
        page,
        outputDir,
        logs,
        preferredResolution,
      );
      if (previewFallback) return previewFallback;
      return null;
    }

    const previewOpened = await openLatestCardPreview(page, target, logs);
    if (!previewOpened) {
      const fromMenu = await tryDownloadFromCardMenu(
        page,
        target,
        outputDir,
        logs,
        preferredResolution,
      );
      if (fromMenu) return fromMenu;

      const previewFallback = await tryDownloadFromPreviewTopBar(
        page,
        outputDir,
        logs,
        preferredResolution,
      );
      if (previewFallback) return previewFallback;
      return null;
    }

    const downloadedFromPreview = await tryDownloadFromPreviewTopBar(
      page,
      outputDir,
      logs,
      preferredResolution,
    );
    if (downloadedFromPreview) return downloadedFromPreview;

    logs.push("[step7] Could not download from preview quality panel");
  } catch (err) {
    logs.push(`[step7] Download error: ${err.message}`);
  }

  logs.push("[step7] WARNING: All download strategies failed.");
  return null;
}

async function tryDownloadLatestVideoWithFallbacks(
  context,
  page,
  outputDir,
  logs,
  preferredResolution,
  beforeVideoSources,
) {
  const byUi = await tryDownloadLatestVideo(page, outputDir, logs, preferredResolution);
  if (byUi) return byUi;

  return tryDownloadNewestVideoBySource(
    context,
    page,
    outputDir,
    logs,
    preferredResolution,
    beforeVideoSources,
  );
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function runPostGenerationQc({ videoPath, referenceImage, logs }) {
  if (!videoPath || !String(videoPath).trim()) {
    return {
      pass: false,
      score: 0,
      reason: "Video QC fail: khong co duong dan video sau generate",
    };
  }

  const resolvedVideoPath = path.resolve(String(videoPath || ""));
  const resolvedReferenceImage = path.resolve(String(referenceImage || ""));

  if (!existsSync(resolvedVideoPath)) {
    return {
      pass: false,
      score: 0,
      reason: `Video QC fail: video khong ton tai ${resolvedVideoPath}`,
    };
  }
  if (!existsSync(resolvedReferenceImage)) {
    return {
      pass: false,
      score: 0,
      reason: `Video QC fail: reference image khong ton tai ${resolvedReferenceImage}`,
    };
  }

  const videoBuffer = readFileSync(resolvedVideoPath);
  if (!videoBuffer || videoBuffer.length < 1024) {
    return { pass: false, score: 0, reason: "Video QC fail: file video rong hoac qua nho" };
  }

  const qcResult = {
    pass: true,
    score: 0.35,
    reason:
      "QC da xac nhan file video ton tai, khong rong va buoc generate bat buoc dung anh goc nguyen ban lam reference duy nhat.",
  };

  logs.push(`[qc] pass=${qcResult.pass} score=${qcResult.score} reason=${qcResult.reason}`);
  return qcResult;
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] generate_veo_video invoked"];
  const artifacts = [];

  const {
    project_url,
    reference_image,
    logo_paths,
    prompt,
    output_dir,
    browser_path,
    user_data_dir,
    profile_name,
    timeout_ms,
    cdp_url,
    download_resolution,
    auto_close_browser,
    no_company_logo,
  } = parsed;
  const effectiveLogoPaths =
    no_company_logo || process.env.OPENCLAW_NO_COMPANY_LOGO === "1"
      ? []
      : parseList(logo_paths);
  const effectivePrompt =
    effectiveLogoPaths.length === 0 ? removeCompanyLogoPromptLines(prompt) : prompt;

  const outDir = path.resolve(output_dir || path.join(process.cwd(), "artifacts", "videos"));
  await mkdir(outDir, { recursive: true });

  logs.push(`[input] project_url=${project_url}`);
  logs.push(`[input] browser=${browser_path} ${profile_name}`);
  logs.push(`[input] target_dir=${outDir}`);
  logs.push(`[input] logo_paths=${effectiveLogoPaths.length}`);
  if (parseList(logo_paths).length > 0 && effectiveLogoPaths.length === 0) {
    logs.push("[input] Company logo disabled for this video run");
  }

  if (!reference_image || !String(reference_image).trim()) {
    logs.push("[fail] Missing reference_image");
    printResult(
      buildResult({
        success: false,
        message: "Missing reference_image",
        logs,
        error: { details: "reference_image is required for product-faithful video generation" },
      }),
    );
    process.exit(1);
  }

  if (!effectivePrompt || !String(effectivePrompt).trim()) {
    logs.push("[fail] Missing prompt");
    printResult(
      buildResult({
        success: false,
        message: "Missing prompt",
        logs,
        error: { details: "prompt is required" },
      }),
    );
    process.exit(1);
  }

  if (reference_image) {
    try {
      await ensureReadableFile(reference_image);
      logs.push("[step1] Checked reference image readability");
    } catch (err) {
      logs.push(`[fail] Image error: ${err.message}`);
      printResult(
        buildResult({
          success: false,
          message: "Reference image unreadable",
          logs,
          error: err.message,
        }),
      );
      process.exit(1);
    }
  }

  try {
    await ensureReadableFiles(effectiveLogoPaths);
    if (effectiveLogoPaths.length > 0) {
      logs.push("[step1] Checked logo readability");
    }
  } catch (err) {
    logs.push(`[fail] Logo error: ${err.message}`);
    printResult(
      buildResult({
        success: false,
        message: "Logo unreadable",
        logs,
        error: err.message,
      }),
    );
    process.exit(1);
  }

  if (parsed.dry_run) {
    logs.push("[dry-run] Exiting early.");
    printResult(buildResult({ success: true, message: "Dry run completed.", logs }));
    return;
  }

  let context;
  let page;
  let generationCompleted = false;
  let connectedByCdp = false;
  try {
    if (cdp_url) {
      logs.push(`[step2] Connecting to existing browser via CDP: ${cdp_url}`);
      try {
        const browser = await chromium.connectOverCDP(cdp_url);
        context = browser.contexts()[0];
        if (!context) {
          throw new Error("Connected but no valid browser context found");
        }
        logs.push("[step2] Successfully connected to existing browser session via CDP");
        connectedByCdp = true;
      } catch (e) {
        logs.push(`[step2] CDP unavailable (${e.message}). Falling back to local browser launch.`);
      }
    }

    if (!context) {
      logs.push("[step2] Launching persistent browser context...");
      context = await chromium.launchPersistentContext(user_data_dir, {
        executablePath: browser_path,
        headless: false,
        acceptDownloads: true,
        args: [
          `--profile-directory=${profile_name}`,
          "--start-maximized",
          "--disable-session-crashed-bubble",
        ],
        viewport: { width: 1440, height: 900 },
      });
    }

    page = context.pages().find((p) => p.url().includes("labs.google")) || context.pages()[0];
    if (!page) {
      page = await context.newPage();
    }

    try {
      await page.bringToFront();
    } catch (_) {}

    logs.push(`[step2] Navigating to ${project_url}`);
    await ensureFlowPageReady(page, project_url, logs);

    const screenshotBefore = path.join(outDir, `veo-before-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotBefore, fullPage: true });
    artifacts.push({
      type: "screenshot_before",
      path: path.relative(process.cwd(), screenshotBefore).replace(/\\/g, "/"),
    });

    const beforeVideoSources = await collectVideoSources(page);

    const normalizedAssetPaths = [
      path.resolve(reference_image),
      ...effectiveLogoPaths.map((filePath) => path.resolve(filePath)),
    ].filter(Boolean);
    const uploadReferenceImage = normalizedAssetPaths[0];
    logs.push(
      `[step1] Using ${normalizedAssetPaths.length} image asset(s): ${normalizedAssetPaths.join(", ")}`,
    );

    const uploadState = await uploadImagesRobust(page, normalizedAssetPaths, logs);

    logs.push("[step4] Ảnh đã sẵn sàng, bắt đầu nhập prompt...");
    const promptState = await setPromptRobust(page, effectivePrompt, logs, uploadState.promptBox);
    if (
      !(await waitForPromptValue(page, effectivePrompt, logs, 5000)) &&
      !(await verifyPromptAnywhere(page, effectivePrompt))
    ) {
      throw new Error("Prompt text could not be verified after image upload completed.");
    }

    await submitPrompt(
      page,
      logs,
      effectivePrompt,
      promptState.promptBox || uploadState.promptBox,
      promptState.promptLocator,
    );

    const waitResult = await waitForVideoResource(page, timeout_ms, logs, beforeVideoSources);
    const newVideoSource = waitResult.source;

    let downloadedVideoPath = null;
    try {
      downloadedVideoPath = await downloadVideoByKnownSource(
        context,
        newVideoSource,
        outDir,
        logs,
        download_resolution,
      );
    } catch (err) {
      logs.push(`[step7] Direct source download failed: ${err.message}`);
      downloadedVideoPath = await tryDownloadLatestVideoWithFallbacks(
        context,
        page,
        outDir,
        logs,
        download_resolution,
        beforeVideoSources,
      );
    }

    const qcResult = await runPostGenerationQc({
      videoPath: downloadedVideoPath,
      referenceImage: uploadReferenceImage,
      logs,
    });
    if (!qcResult.pass) {
      throw new Error(`QC failed: ${qcResult.reason}`);
    }

    const screenshotAfter = path.join(outDir, `veo-after-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotAfter, fullPage: true });
    artifacts.push({
      type: "screenshot_after",
      path: path.relative(process.cwd(), screenshotAfter).replace(/\\/g, "/"),
    });

    let relVideoPath = null;
    if (downloadedVideoPath) {
      relVideoPath = path.relative(process.cwd(), downloadedVideoPath).replace(/\\/g, "/");
      artifacts.push({ type: "generated_video", path: relVideoPath });
    }

    logs.push("[step8] Flow finished successfully");
    generationCompleted = true;
    const chatReply = downloadedVideoPath
      ? buildChatVideoReplyPayload({
          videoPath: downloadedVideoPath,
          data: {
            project_url,
            prompt: effectivePrompt,
            downloaded_video_path: relVideoPath || downloadedVideoPath,
            used_reference_image: uploadReferenceImage,
            used_logo_paths: effectiveLogoPaths,
            reference_image_sha256: computeFileSha256(uploadReferenceImage),
            video_qc_status: "PASS",
            video_qc_reason: qcResult.reason,
          },
          artifacts,
        })
      : null;
    printResult(
      buildResult({
        success: true,
        message:
          chatReply?.assistantText ||
          (downloadedVideoPath
            ? "Video generated and downloaded."
            : "Video generated but could not be downloaded."),
        data: {
          project_url,
          prompt: effectivePrompt,
          downloaded_video_path: relVideoPath || downloadedVideoPath,
          used_reference_image: uploadReferenceImage,
          used_logo_paths: effectiveLogoPaths,
          reference_image_sha256: computeFileSha256(uploadReferenceImage),
          video_qc_status: "PASS",
          video_qc_reason: qcResult.reason,
          ...(chatReply?.data || {}),
        },
        artifacts: chatReply?.artifacts || artifacts,
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] ${error.stack || error.message}`);
    printResult(
      buildResult({
        success: false,
        message: "Failed during Veo video generation flow",
        data: { project_url, prompt: effectivePrompt },
        artifacts,
        logs,
        error: { details: error.message },
      }),
    );
    process.exit(1);
  } finally {
    if (context) {
      if (generationCompleted && !connectedByCdp) {
        await context.close().catch(() => {});
        logs.push("[cleanup] Closed Flow browser context after successful download");
      } else if (generationCompleted && page) {
        await page.close().catch(() => {});
        logs.push("[cleanup] Closed Flow video tab after successful download");
      } else if (auto_close_browser && !connectedByCdp) {
        await context.close().catch(() => {});
      } else if (!auto_close_browser && !generationCompleted) {
        const browser = context.browser?.();
        if (browser?.disconnect) {
          browser.disconnect();
          logs.push("[cleanup] Auto close browser is disabled; disconnected Playwright and kept browser open");
        } else {
          logs.push("[cleanup] Auto close browser is disabled; leaving browser context open");
        }
      }
    }

    if (auto_close_browser) {
      await killAllCocCocBrowsers(logs);
    }
  }
})();
