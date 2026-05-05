import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildChatImageReplyPayload } from "../shared/chat-image-result.js";
import { publishGeneratedImageToUpTekGallery } from "../shared/uptek-gallery-publisher.js";

const FLOW_PROJECT_URL =
  "https://labs.google/fx/tools/flow/project/0049461b-a587-4c3d-ba90-464aa0f51336";

const DEFAULTS = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Default",
  project_url: FLOW_PROJECT_URL,
  target_gemini_url: FLOW_PROJECT_URL,
  image_prompt: "",
  image_paths: [],
  prompt: "",
  output_dir: "",
  timeout_ms: 1200000,
  download_resolution: "2k",
  auto_close_browser: false,
  automation_mode: "playwright",
  dry_run: false,
};

const MIN_GENERATED_IMAGE_BYTES = 50 * 1024;
const AUTOMATION_REVISION = "flow-rewrite-stepwise-20260503-restore-1748";

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
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
  const inputIndex = args.findIndex((arg) => arg === "--input_file" || arg === "--input-file");

  if (inputIndex >= 0 && args[inputIndex + 1]) {
    try {
      const raw = readFileSync(args[inputIndex + 1], "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      Object.assign(params, parsed);
      params.image_paths = parseList(parsed.image_paths);
      if (parsed.image_prompt && !parsed.prompt) params.prompt = parsed.image_prompt;
      if (parsed.target_gemini_url && !parsed.project_url)
        params.project_url = parsed.target_gemini_url;
      if (parsed.project_url && !parsed.target_gemini_url)
        params.target_gemini_url = parsed.project_url;
      if (parsed.dry_run === true || parsed["dry-run"] === true) params.dry_run = true;
    } catch (error) {
      logs.push(`[parse] Invalid JSON input file: ${error.message}`);
    }
  } else if (args[0]?.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      Object.assign(params, parsed);
      params.image_paths = parseList(parsed.image_paths);
      if (parsed.image_prompt && !parsed.prompt) params.prompt = parsed.image_prompt;
      if (parsed.target_gemini_url && !parsed.project_url)
        params.project_url = parsed.target_gemini_url;
      if (parsed.project_url && !parsed.target_gemini_url)
        params.target_gemini_url = parsed.project_url;
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
    if (!next || next.startsWith("--")) continue;

    if (token === "--prompt" || token === "--image_prompt") {
      params.prompt = next;
      params.image_prompt = next;
      index += 1;
    } else if (token === "--image_paths") {
      params.image_paths = parseList(next);
      index += 1;
    } else if (token === "--output_dir") {
      params.output_dir = next;
      index += 1;
    } else if (token === "--project_url" || token === "--target_gemini_url") {
      params.project_url = next;
      params.target_gemini_url = next;
      index += 1;
    } else if (token === "--browser_path") {
      params.browser_path = next;
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

  if (params.image_prompt && !params.prompt) params.prompt = params.image_prompt;
  if (params.prompt && !params.image_prompt) params.image_prompt = params.prompt;
  if (params.target_gemini_url && !params.project_url)
    params.project_url = params.target_gemini_url;
  if (params.project_url && !params.target_gemini_url)
    params.target_gemini_url = params.project_url;
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

function mediaNameFromSource(source) {
  try {
    const url = new URL(String(source || ""), "https://labs.google");
    return url.searchParams.get("name") || "";
  } catch {
    return "";
  }
}

function outputImagePath(outputDir, resolution) {
  const label =
    String(resolution || "2k")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "") || "2k";
  return path.join(outputDir, `flow-image-${label}-${nowStamp()}.png`);
}

function relativePath(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

async function ensureReadableFiles(filePaths) {
  for (const filePath of filePaths) await access(filePath);
}

function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function dismissPopupsIfAny(page, logs) {
  for (const selector of [
    'button[aria-label*="Close" i]',
    'button[mattooltip*="Close" i]',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button:has-text("Đã hiểu")',
  ]) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 400 })) {
        await button.click({ timeout: 1000 });
        logs.push(`[ui] Dismissed popup by selector: ${selector}`);
      }
    } catch {}
  }
}

async function getOrCreateFlowPage(context, flowUrl, logs) {
  const pages = context.pages();
  const exact = pages.find((page) => page.url().includes(flowUrl));
  if (exact) {
    logs.push("[step1] Reusing existing Flow tab");
    return exact;
  }
  const blank = pages.find((page) => {
    const url = page.url();
    return !url || url === "about:blank" || url.startsWith("chrome://newtab");
  });
  if (blank) {
    logs.push("[step1] Using blank tab for Flow");
    return blank;
  }
  logs.push("[step1] Opening new Flow tab");
  return context.newPage();
}

async function openFlowPage(parsed, logs) {
  if (!existsSync(parsed.browser_path)) {
    throw new Error(`Khong tim thay browser_path: ${parsed.browser_path}`);
  }

  logs.push("[step1] Launching CocCoc persistent context");
  const context = await chromium.launchPersistentContext(parsed.user_data_dir, {
    executablePath: parsed.browser_path,
    headless: false,
    acceptDownloads: true,
    args: [
      `--profile-directory=${parsed.profile_name}`,
      "--start-maximized",
      "--disable-session-crashed-bubble",
    ],
    viewport: { width: 1440, height: 900 },
  });

  const page = await getOrCreateFlowPage(context, parsed.target_gemini_url, logs);
  await page.bringToFront().catch(() => {});
  logs.push(`[step1] Navigating to ${parsed.target_gemini_url}`);
  if (!page.url().includes(parsed.target_gemini_url)) {
    await page.goto(parsed.target_gemini_url, { waitUntil: "domcontentloaded", timeout: 90000 });
  }
  await page.waitForTimeout(3500);
  await dismissPopupsIfAny(page, logs);
  await waitForComposerReady(page, logs, 90000);

  const visibleSources = await collectImageSources(page);
  logs.push(`[step1] PASS Flow opened, visible image sources=${visibleSources.length}`);
  return { context, page };
}

async function findComposerGeometry(page, logs) {
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
    const boxOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        text: normalize(element.textContent || element.getAttribute("aria-label") || ""),
      };
    };

    const promptNodes = Array.from(
      document.querySelectorAll(
        'div[role="textbox"][contenteditable="true"], [data-slate-editor="true"][contenteditable="true"], textarea, input[type="text"]',
      ),
    )
      .filter(isVisible)
      .map((element) => {
        const box = boxOf(element);
        const attrs = normalize(
          [
            element.getAttribute("aria-label"),
            element.getAttribute("placeholder"),
            element.getAttribute("title"),
            element.textContent,
          ].join(" "),
        );
        let score = box.y;
        if (box.y > window.innerHeight * 0.45) score += 500;
        if (
          attrs.includes("ban muon tao") ||
          attrs.includes("tao gi") ||
          attrs.includes("prompt")
        ) {
          score += 400;
        }
        if (attrs.includes("search") || attrs.includes("tim kiem") || attrs.includes("filter")) {
          score -= 1000;
        }
        return { ...box, score };
      })
      .filter((item) => item.score > -500)
      .sort((a, b) => b.score - a.score);

    const promptBox = promptNodes[0] || null;
    if (!promptBox) return { promptBox: null, plusCandidates: [] };

    const buttonNodes = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(isVisible)
      .map((element) => {
        const text = normalize(
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("data-testid"),
          ].join(" "),
        );
        const box = boxOf(element);
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
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
        return { ...box, score };
      })
      .filter((item) => item.score > 100)
      .sort((a, b) => b.score - a.score);

    return { promptBox, plusCandidates: buttonNodes.slice(0, 5) };
  });

  if (!result.promptBox) throw new Error("Khong tim thay khung prompt composer");
  if (logs) {
    logs.push(
      `[step2] Composer prompt box x=${Math.round(result.promptBox.x)}, y=${Math.round(
        result.promptBox.y,
      )}, w=${Math.round(result.promptBox.width)}, h=${Math.round(result.promptBox.height)}`,
    );
    logs.push(
      `[step2] Composer + candidates: ${result.plusCandidates
        .map(
          (item) =>
            `x=${Math.round(item.x)},y=${Math.round(item.y)},w=${Math.round(
              item.width,
            )},h=${Math.round(item.height)},text="${item.text}"`,
        )
        .join(" | ")}`,
    );
  }
  if (!result.plusCandidates.length) throw new Error("Khong tim thay nut + trong composer");
  return { promptBox: result.promptBox, plusBox: result.plusCandidates[0] };
}

async function waitForComposerReady(page, logs, timeoutMs = 90000) {
  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await dismissPopupsIfAny(page, logs);
    try {
      return await findComposerGeometry(page, null);
    } catch (error) {
      if (Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now();
        logs.push(`[step1] Waiting for Flow composer to render: ${error.message}`);
      }
      await page.waitForTimeout(1000);
    }
  }
  throw new Error("Flow load timeout: khong thay khung prompt composer sau khi doi trang load");
}

async function clickComposerPlus(page, logs) {
  const geometry = await waitForComposerReady(page, logs, 90000);
  const { plusBox } = await findComposerGeometry(page, logs);
  const x = plusBox.x + plusBox.width / 2;
  const y = plusBox.y + plusBox.height / 2;
  logs.push(`[step2] Clicking composer + at x=${Math.round(x)}, y=${Math.round(y)}`);
  await page.mouse.click(x, y);
  await page.waitForTimeout(700);
  return geometry.promptBox;
}

async function clickUploadImageMenuItem(page, logs) {
  const candidates = [
    page.getByText("Upload image", { exact: true }),
    page.getByText("Upload images", { exact: true }),
    page.getByText("Tải hình ảnh lên", { exact: true }),
    page
      .locator('[role="menuitem"]')
      .filter({ hasText: /tải hình ảnh|tai hinh anh|upload|image/i }),
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
        'div[role="textbox"][contenteditable="true"], [data-slate-editor="true"][contenteditable="true"], textarea, input[type="text"]',
      ),
    ).find((element) => {
      if (!isVisible(element, 80, 10)) return false;
      const rect = element.getBoundingClientRect();
      return (
        Math.abs(rect.x - box.x) < 80 &&
        Math.abs(rect.y - box.y) < 120 &&
        Math.abs(rect.width - box.width) < 180
      );
    });

    if (!prompt) {
      return {
        found: false,
        imageCount: 0,
        mediaNames: [],
        loading: false,
        rootBox: null,
        inputCount: 0,
      };
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
        rect.width <= 900 &&
        rect.height >= 70 &&
        rect.height <= 360 &&
        rect.y >= box.y - 330 &&
        rect.y <= box.y + 90;
      if (!plausibleSize || !hasComposerButton) continue;
      const score = rect.width + rect.height * 2 - Math.abs(rect.y - (box.y - 70));
      if (score > bestScore) {
        bestScore = score;
        root = current;
      }
    }

    const rootRect = root.getBoundingClientRect();
    const images = Array.from(root.querySelectorAll("img")).filter((img) => isVisible(img, 20, 20));
    const mediaNames = images
      .map((img) => {
        try {
          const url = new URL(img.currentSrc || img.src || "", window.location.href);
          return url.searchParams.get("name") || "";
        } catch {
          return "";
        }
      })
      .filter(Boolean);
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

    return {
      found: true,
      imageCount: images.length,
      mediaNames: [...new Set(mediaNames)],
      loading,
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

async function countComposerImages(page, promptBox) {
  const state = await readComposerRootState(page, promptBox);
  return state.imageCount;
}

async function collectComposerMediaNames(page, promptBox) {
  const state = await readComposerRootState(page, promptBox);
  return state.mediaNames;
}

async function hasVisibleUploadProgress(page, promptBox) {
  const state = await readComposerRootState(page, promptBox);
  return state.loading;
}

async function uploadImages(page, imagePaths, logs) {
  logs.push("[step2] Finding composer and opening upload menu");
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
    logs.push(
      `[step3] File chooser did not open, using file input fallback: ${error.message.split("\n")[0]}`,
    );
    return null;
  });
  await clickUploadImageMenuItem(page, logs);
  const fileChooser = await fileChooserPromise;
  logs.push(`[step3] Uploading ${imagePaths.length} image file(s)`);
  if (fileChooser) {
    await fileChooser.setFiles(imagePaths);
  } else {
    const uploadedByInput = await setFilesViaFileInputFallback(page, imagePaths, logs);
    if (!uploadedByInput) {
      throw new Error(
        "Khong mo duoc file chooser va khong tim thay input[type=file] de upload anh",
      );
    }
  }

  const startedAt = Date.now();
  let stablePasses = 0;
  while (Date.now() - startedAt < 180000) {
    const state = await readComposerRootState(page, promptBox).catch(() => null);
    const count = state?.imageCount || 0;
    const loading = Boolean(state?.loading);
    const elapsedMs = Date.now() - startedAt;
    const enoughImages = count >= Math.max(1, imagePaths.length);
    if (enoughImages && (!loading || elapsedMs > 12000)) {
      stablePasses += 1;
      if (stablePasses >= 3) {
        logs.push(
          `[step3] PASS upload: composer image count=${count}, loading=${loading}, elapsedMs=${elapsedMs}`,
        );
        return promptBox;
      }
    } else {
      stablePasses = 0;
      logs.push(`[step3] Waiting upload: composerImages=${count}, loading=${loading}`);
    }
    await page.waitForTimeout(1200);
  }
  throw new Error("Upload timeout: anh chua xuat hien du trong khung chat composer");
}

async function setFilesViaFileInputFallback(page, imagePaths, logs) {
  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const input = inputs.nth(index);
    try {
      await input.setInputFiles(imagePaths, { timeout: 15000 });
      logs.push(
        `[step3] Uploaded ${imagePaths.length} image file(s) via input[type=file] fallback`,
      );
      return true;
    } catch (error) {
      logs.push(
        `[step3] File input fallback skipped index=${index}: ${error.message.split("\n")[0]}`,
      );
    }
  }
  return false;
}

async function findPromptLocator(page, promptBox = null) {
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
  return candidates[0] || null;
}

async function clickPlaceholderPrompt(page, logs) {
  const placeholder = page.getByText("Bạn muốn tạo gì?", { exact: false }).last();
  if (await placeholder.isVisible({ timeout: 700 }).catch(() => false)) {
    const box = await placeholder.boundingBox().catch(() => null);
    if (box && box.y > 300) {
      logs.push(
        `[step4] Clicking prompt placeholder at x=${Math.round(box.x)}, y=${Math.round(box.y)}`,
      );
      await page.mouse.click(box.x + 8, box.y + Math.max(8, box.height / 2));
      await page.waitForTimeout(200);
    }
  }
}

async function typePrompt(page, prompt, logs, promptBox = null) {
  const freshGeometry = await findComposerGeometry(page, logs).catch((error) => {
    logs.push(`[step4] Could not refresh composer geometry before typing: ${error.message}`);
    return null;
  });

  const activePromptBox = freshGeometry?.promptBox || promptBox;
  const promptTarget = await findPromptLocator(page, activePromptBox);

  if (!promptTarget) throw new Error("Khong tim thay prompt composer de nhap prompt");

  const locator = promptTarget.locator;
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await clickPlaceholderPrompt(page, logs);

  const targetBox = await locator.boundingBox().catch(() => null);
  if (targetBox) {
    const safeX = targetBox.x + targetBox.width - 30;
    const safeY = targetBox.y + targetBox.height / 2;
    await page.mouse.click(safeX, safeY);
  } else {
    await locator.click({ force: true, timeout: 3000 });
  }

  await page.waitForTimeout(300);
  await page.keyboard.press("Control+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.waitForTimeout(300);

  if (tagName === "textarea" || tagName === "input") {
    await locator.fill(prompt);
    await locator.evaluate((element) =>
      element.dispatchEvent(new Event("input", { bubbles: true })),
    );
  } else {
    await page.keyboard.type(prompt, { delay: 10 });
  }

  await page.waitForTimeout(800);
  logs.push("[step4] PASS prompt typed successfully");
}

async function submitPrompt(page, logs) {
  const arrowButtons = page
    .locator("button")
    .filter({ has: page.locator('i:has-text("arrow_forward")') });
  const count = await arrowButtons.count().catch(() => 0);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const button = arrowButtons.nth(index);
    if (!(await button.isVisible({ timeout: 300 }).catch(() => false))) continue;
    if (!(await button.isEnabled().catch(() => false))) continue;
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.y < 300) continue;
    candidates.push({ button, box });
  }
  candidates.sort((left, right) => right.box.y - left.box.y || right.box.x - left.box.x);
  if (candidates.length) {
    const { button, box } = candidates[0];
    logs.push(
      `[step5] Clicking submit arrow_forward button x=${Math.round(box.x + box.width / 2)}, y=${Math.round(
        box.y + box.height / 2,
      )}`,
    );
    await button.click({ force: true, timeout: 5000 });
    await page.waitForTimeout(1500);
    return;
  }

  const promptTarget = await findPromptLocator(page);
  if (promptTarget) await promptTarget.locator.click({ force: true }).catch(() => {});
  await page.keyboard.press("Control+Enter").catch(() => {});
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter").catch(() => {});
  logs.push("[step5] Submitted via keyboard fallback");
}

async function collectImageSources(page) {
  return page
    .locator("img")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => {
          const element = /** @type {HTMLImageElement} */ (node);
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity || "1") === 0 ||
            rect.width < 120 ||
            rect.height < 90 ||
            rect.y < 60
          ) {
            return "";
          }
          return element.currentSrc || element.src || "";
        })
        .filter((source) => source && !source.startsWith("data:")),
    )
    .catch(() => []);
}

async function collectRenderableImageRecords(page, promptBox = null) {
  return page
    .locator("img")
    .evaluateAll(
      (nodes, box) =>
        nodes
          .map((node, index) => {
            const element = /** @type {HTMLImageElement} */ (node);
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const src = element.currentSrc || element.src || "";
            const visible =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0 &&
              rect.width >= 160 &&
              rect.height >= 90 &&
              rect.y >= 60;
            const inComposer = box
              ? rect.x >= box.x - 120 &&
                rect.x <= box.x + box.width + 120 &&
                rect.y >= box.y - 320 &&
                rect.y <= box.y + box.height + 150
              : false;
            return {
              index,
              src,
              visible,
              complete: element.complete,
              naturalWidth: element.naturalWidth || 0,
              naturalHeight: element.naturalHeight || 0,
              area: rect.width * rect.height,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              inComposer,
            };
          })
          .filter((item) => item.visible && item.src && !item.src.startsWith("data:")),
      promptBox,
    )
    .catch(() => []);
}

async function waitForNewImageSource(
  page,
  beforeSources,
  timeoutMs,
  logs,
  excludedMediaNames = [],
  promptBox = null,
) {
  const beforeSet = new Set((beforeSources || []).filter(Boolean));
  const excludedSet = new Set((excludedMediaNames || []).filter(Boolean));
  logs.push(
    `[step6] Waiting for generated image; baseline sources=${beforeSet.size}, excluded upload media=${excludedSet.size}`,
  );

  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const records = await collectRenderableImageRecords(page, promptBox);
    const fresh = records
      .filter((record) => {
        const name = mediaNameFromSource(record.src);
        return (
          !beforeSet.has(record.src) &&
          !excludedSet.has(name) &&
          !record.inComposer &&
          record.complete &&
          record.naturalWidth >= 512 &&
          record.naturalHeight >= 256
        );
      })
      .sort((left, right) => right.area - left.area);

    if (fresh.length > 0) {
      const picked = fresh[0];
      logs.push(
        `[step6] PASS detected generated image source: ${picked.src} natural=${picked.naturalWidth}x${picked.naturalHeight} box=${Math.round(picked.width)}x${Math.round(picked.height)}`,
      );
      return picked.src;
    }

    if (Date.now() - lastLogAt > 10000) {
      lastLogAt = Date.now();
      logs.push(`[step6] Waiting generated renderable image; visible candidates=${records.length}`);
    }
    await page.waitForTimeout(2500);
  }
  throw new Error("Timeout waiting for generated image after submit");
}

async function saveBufferIfImage(buffer, outputDir, resolution, logs, label) {
  if (!buffer || buffer.length < MIN_GENERATED_IMAGE_BYTES) return null;
  const destination = outputImagePath(outputDir, resolution);
  await writeFile(destination, buffer);
  logs.push(`[step7] PASS saved generated image via ${label}: ${destination}`);
  return destination;
}

async function saveImageFromSource(context, page, sourceUrl, outputDir, resolution, logs) {
  const sourceName = mediaNameFromSource(sourceUrl);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let buffer = Buffer.alloc(0);
    try {
      if (attempt === 1) {
        const response = await context.request.get(sourceUrl, {
          timeout: 60000,
          maxRedirects: 10,
          headers: { accept: "image/*,*/*;q=0.8", referer: page.url() },
        });
        buffer = await response.body();
      } else {
        const bytes = await page.evaluate(async (url) => {
          const response = await fetch(url, {
            credentials: "include",
            redirect: "follow",
            cache: "no-store",
          });
          return Array.from(new Uint8Array(await response.arrayBuffer()));
        }, sourceUrl);
        buffer = Buffer.from(bytes || []);
      }
    } catch (error) {
      logs.push(`[step7] Download attempt ${attempt} failed: ${error.message}`);
    }
    logs.push(`[step7] Download attempt ${attempt} bytes=${buffer.length}`);
    const saved = await saveBufferIfImage(
      buffer,
      outputDir,
      resolution,
      logs,
      `download attempt ${attempt}`,
    );
    if (saved) return saved;
  }

  const records = await collectRenderableImageRecords(page);
  const matching = records
    .filter((record) => {
      const name = mediaNameFromSource(record.src);
      return (
        (record.src === sourceUrl || (sourceName && name === sourceName)) &&
        record.complete &&
        record.naturalWidth >= 512 &&
        record.naturalHeight >= 256
      );
    })
    .sort((left, right) => right.area - left.area);
  const target = matching[0];
  if (target) {
    const destination = outputImagePath(outputDir, resolution);
    await page.locator("img").nth(target.index).screenshot({ path: destination, timeout: 30000 });
    const size = readFileSync(destination).length;
    if (size >= MIN_GENERATED_IMAGE_BYTES) {
      logs.push(`[step7] PASS saved generated image by element screenshot: ${destination}`);
      return destination;
    }
    logs.push(`[step7] Element screenshot too small: ${size} bytes`);
  }

  throw new Error("Generated image detected but could not be saved");
}

async function runPostGenerationQc(imagePath) {
  if (!imagePath || !existsSync(imagePath)) {
    return { pass: false, reason: "generated image file does not exist" };
  }
  const size = readFileSync(imagePath).length;
  if (size < MIN_GENERATED_IMAGE_BYTES) {
    return { pass: false, reason: `generated image too small: ${size} bytes` };
  }
  return { pass: true, reason: `generated image saved, size=${size} bytes` };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [
    ...parsed.logs,
    "[start] generate_flow_image invoked",
    `[start] automation_revision=${AUTOMATION_REVISION}`,
  ];
  const artifacts = [];

  const targetGeminiUrl = parsed.target_gemini_url || parsed.project_url || FLOW_PROJECT_URL;
  parsed.target_gemini_url = targetGeminiUrl;
  const imagePrompt = String(parsed.prompt || parsed.image_prompt || "").trim();
  const imagePaths = parseList(parsed.image_paths).map((filePath) => path.resolve(filePath));
  const outputDir = path.resolve(
    parsed.output_dir || path.join(process.cwd(), "artifacts", "images"),
  );
  await mkdir(outputDir, { recursive: true });

  logs.push(`[input] target_gemini_url=${targetGeminiUrl}`);
  logs.push(`[input] browser=${parsed.browser_path} ${parsed.profile_name}`);
  logs.push(`[input] target_dir=${outputDir}`);
  logs.push(`[input] image_paths=${imagePaths.length}`);

  if (!imagePrompt) {
    printResult(
      buildResult({
        success: false,
        message: "Missing required inputs",
        logs,
        error: { code: "VALIDATION_ERROR", details: "Missing fields: image_prompt" },
      }),
    );
    process.exit(1);
  }

  try {
    await ensureReadableFiles(imagePaths);
    logs.push("[step0] PASS input files readable");
  } catch (error) {
    printResult(
      buildResult({
        success: false,
        message: "Reference image file missing/unreadable",
        logs: [...logs, `[fail] ${error.message}`],
        error: { code: "IMAGE_FILE_ERROR", details: error.message },
      }),
    );
    process.exit(1);
  }

  if (parsed.dry_run) {
    logs.push("[dry-run] Exiting early.");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed. Flow image generation skipped.",
        data: {
          target_gemini_url: targetGeminiUrl,
          image_prompt: imagePrompt,
          image_paths: imagePaths,
        },
        logs,
      }),
    );
    return;
  }

  let context = null;
  try {
    const opened = await openFlowPage(parsed, logs);
    context = opened.context;
    const page = opened.page;

    const screenshotBefore = path.join(outputDir, `flow-before-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotBefore, fullPage: true });
    artifacts.push({ type: "screenshot_before", path: relativePath(screenshotBefore) });

    let promptBox = null;
    if (imagePaths.length > 0) {
      promptBox = await uploadImages(page, imagePaths, logs);
    }
    const uploadedMediaNames = promptBox ? await collectComposerMediaNames(page, promptBox) : [];
    if (uploadedMediaNames.length) {
      logs.push(`[step3] Composer uploaded media names excluded: ${uploadedMediaNames.join(", ")}`);
    }

    await typePrompt(page, imagePrompt, logs, promptBox);
    const beforeGenerationSources = await collectImageSources(page);
    logs.push(
      `[step5] Baseline after upload/prompt before submit, visible image sources=${beforeGenerationSources.length}`,
    );
    await submitPrompt(page, logs);
    await page.waitForTimeout(5000);

    const generatedSource = await waitForNewImageSource(
      page,
      beforeGenerationSources,
      Number(parsed.timeout_ms || 1200000),
      logs,
      uploadedMediaNames,
      promptBox,
    );
    const downloadedImagePath = await saveImageFromSource(
      context,
      page,
      generatedSource,
      outputDir,
      parsed.download_resolution,
      logs,
    );
    const qcResult = await runPostGenerationQc(downloadedImagePath);
    if (!qcResult.pass) throw new Error(`QC failed: ${qcResult.reason}`);
    logs.push(`[qc] PASS ${qcResult.reason}`);

    const screenshotAfter = path.join(outputDir, `flow-after-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotAfter, fullPage: true });
    artifacts.push({ type: "screenshot_after", path: relativePath(screenshotAfter) });

    const relativeDownloadedImagePath = relativePath(downloadedImagePath);
    artifacts.push({ type: "generated_image", path: relativeDownloadedImagePath });

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
        `[step7] Warning: generated image sync to UpTek gallery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const data = {
      target_gemini_url: targetGeminiUrl,
      image_prompt: imagePrompt,
      downloaded_image_path: relativeDownloadedImagePath,
      used_image_paths: imagePaths,
      reference_image_sha256: imagePaths[0] ? computeFileSha256(imagePaths[0]) : null,
      image_qc_status: "PASS",
      image_qc_reason: qcResult.reason,
      company_gallery_synced: Boolean(gallerySync),
      company_gallery_path: gallerySync?.copiedPath || null,
      company_gallery_company_id: gallerySync?.companyId || "UpTek",
      company_gallery_department_id: gallerySync?.departmentId || "Phong_Marketing",
      company_gallery_product_model: gallerySync?.productModel || null,
      company_gallery_url: gallerySync?.galleryUrl || null,
      company_gallery_image_id: gallerySync?.imageId || null,
      company_gallery_media_file_id: gallerySync?.mediaFileId || null,
    };
    const chatReply = buildChatImageReplyPayload({
      imagePath: downloadedImagePath,
      data,
      artifacts,
    });

    printResult(
      buildResult({
        success: true,
        message: chatReply?.assistantText || "Đây là ảnh vừa tạo cho bạn:",
        data: { ...data, ...(chatReply?.data || {}) },
        artifacts: chatReply?.artifacts || artifacts,
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] ${error.stack || error.message}`);
    printResult(
      buildResult({
        success: false,
        message: "Flow image generation flow failed",
        data: { target_gemini_url: targetGeminiUrl, image_prompt: imagePrompt },
        artifacts,
        logs,
        error: { code: "FLOW_FAILED", details: error.message },
      }),
    );
    process.exit(1);
  } finally {
    if (context) await context.close().catch(() => {});
  }
})();
