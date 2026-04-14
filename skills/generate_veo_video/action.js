import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const DEFAULTS = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Default",
  project_url: "https://labs.google/fx/vi/tools/flow/project/c5c6d835-fae3-4140-af60-9a54ab1dd804",
  reference_image: "",
  prompt: "Tạo video quảng cáo",
  output_dir: "",
  cdp_url: "",
  timeout_ms: 1200000,
  download_resolution: "720p",
  auto_close_browser: false,
  retry_count: 2,
  dry_run: false,
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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
        if (parsed.dry_run === true || parsed["dry-run"] === true) params.dry_run = true;
      } catch (error) {
        logs.push(`[parse] Invalid JSON input file: ${error.message}`);
      }
    }
  } else if (args.length > 0 && args[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      Object.assign(params, parsed);
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

    if (token === "--prompt") {
      params.prompt = next;
      index += 1;
    } else if (token === "--reference_image") {
      params.reference_image = next;
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

async function ensureReadableFile(filePath) {
  if (filePath) {
    await access(filePath);
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

async function prepareImageUpload(page, imagePath, logs) {
  if (!imagePath || !existsSync(imagePath)) {
    logs.push("[step3] No valid reference image provided, skipping upload");
    return;
  }

  logs.push(`[step3] Attempting to upload image: ${imagePath}`);

  // More robust waiting logic
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fileInputs = page.locator('input[type="file"]');
      const fileInputCount = await fileInputs.count().catch(() => 0);

      if (fileInputCount > 0) {
        for (let i = fileInputCount - 1; i >= 0; i--) {
          const input = fileInputs.nth(i);
          // Ensure it's not a search or hidden system input
          const isVisible = await input.isVisible().catch(() => false);
          await input.setInputFiles(imagePath, { timeout: 15000 });
          logs.push(`[step3] Uploaded via direct input[type="file"] #${i} (Attempt ${attempt})`);
          await page.waitForTimeout(2000);
          return;
        }
      }

      // Try via UI buttons if input not found
      const visibleChooserSelectors = [
        'button[aria-label^="Tải tệp lên"]',
        'button:has-text("Tải tệp lên")',
        'button:has-text("Tải hình ảnh lên")',
        'button:has-text("Upload image")',
        'button[aria-label*="prompt input" i]',
        'button[aria-label*="ô nhập nội dung"]',
      ];

      for (const selector of visibleChooserSelectors) {
        const trigger = page.locator(selector).last();
        if (await trigger.isVisible({ timeout: 1000 })) {
          const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
          await trigger.click({ force: true, timeout: 2000 });
          const chooser = await chooserPromise;
          await chooser.setFiles(imagePath);
          logs.push(`[step3] Uploaded via UI button ${selector} (Attempt ${attempt})`);
          await page.waitForTimeout(2000);
          return;
        }
      }
    } catch (e) {
      logs.push(`[step3] Attempt ${attempt} failed: ${e.message}`);
    }

    // Wait before next attempt
    await page.waitForTimeout(3000);
  }

  throw new Error(
    "Could not find any upload mechanism to attach the reference image after multiple retries.",
  );
}

async function setPromptRobust(page, promptText, logs) {
  logs.push("[step4] Typing prompt");
  const candidates = [
    '.ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    "textarea",
    '[contenteditable="true"]',
    'input[type="text"]', // general fallback
  ];

  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).filter({ hasNotText: "Tìm kiếm" }).last();
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
          await page.keyboard.insertText(promptText);
        }

        // Minor wait to allow frontend state updates
        await page.waitForTimeout(500);
        logs.push(`[step4] Typed prompt into ${sel}`);
        return true;
      }
    } catch (_) {}
  }

  throw new Error("Could not locate any input field for the prompt");
}

async function submitPrompt(page, logs) {
  logs.push("[step5] Submitting prompt");
  const submitCandidates = [
    "button.send-button",
    'button[aria-label="Gửi tin nhắn"]',
    'button[aria-label*="Send" i]',
    'button:has-text("Send")',
    'button[aria-label*="Tạo"]',
    'button[aria-label*="Generate"]',
    'button:has-text("Tạo")',
    'button:has-text("Generate")',
    '[role="button"]:has-text("Tạo")',
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

  await page.keyboard.press("Enter");
  logs.push("[step5] Submitted via Enter key");
  await page.waitForTimeout(1000);
}

async function waitForVideoResource(page, timeoutMs, logs, beforeVideoCount) {
  logs.push(`[step6] Waiting up to ${timeoutMs / 1000}s for video output...`);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentVideoCount = await page
      .locator("video")
      .count()
      .catch(() => 0);
    if (currentVideoCount > beforeVideoCount || (beforeVideoCount === 0 && currentVideoCount > 0)) {
      logs.push(
        `[step6] New <video> element detected. (${beforeVideoCount} -> ${currentVideoCount})`,
      );
      return;
    }

    const completedTexts = ["Hoàn tất", "Xong", "Completed", "Complete", "Success"];
    for (const txt of completedTexts) {
      if (
        await page
          .getByText(txt)
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false)
      ) {
        logs.push(`[step6] Detected completion wording: ${txt}`);
        // We still want to see a video tag ideally
        if (currentVideoCount > 0) return;
      }
    }

    await page.waitForTimeout(5000);
  }

  throw new Error("Timeout waiting for Veo video generation to finish");
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
      logs.push("[cleanup] Killed all Cốc Cốc browser processes on Windows");
    } else if (process.platform === "darwin") {
      execSync('pkill -9 -f "CocCoc.*browser"', { stdio: "pipe" });
      logs.push("[cleanup] Killed all Cốc Cốc browser processes on macOS");
    } else {
      execSync('pkill -9 -f "browser.*CocCoc"', { stdio: "pipe" });
      logs.push("[cleanup] Killed all Cốc Cốc browser processes on Linux");
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
    normalized.includes("nâng cấp") ||
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
    .locator('button:has-text("Tải xuống"), button:has-text("Download")')
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

  const contentType = (response.headers()["content-type"] || "").toLowerCase();
  if (!contentType.includes("video") && !contentType.includes("application/octet-stream")) {
    logs.push(
      `[step7] Direct source fallback unexpected content-type: ${contentType || "unknown"}`,
    );
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

async function tryDownloadFromPreviewTopBar(page, outputDir, logs, preferredResolution) {
  const downloadButtons = page
    .locator('button[aria-haspopup="menu"], button')
    .filter({ hasText: /tải xuống|download/i });

  const count = await downloadButtons.count();
  let chosenIndex = -1;
  let minY = Number.POSITIVE_INFINITY;

  for (let i = 0; i < count; i += 1) {
    const btn = downloadButtons.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await btn.boundingBox().catch(() => null);
    if (!box) continue;
    // Top-bar preview download button is near top edge in the preview layout.
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

  // Attempt 1: direct click on media element.
  if (target.media) {
    try {
      await target.media.click({ force: true, timeout: 2500 });
      if (await isPreviewOpen(page)) {
        logs.push("[step7] Preview opened via direct media click");
        return true;
      }
    } catch {}
  }

  // Attempt 2: coordinate click at center.
  await page.mouse.click(centerX, centerY, { button: "left" });
  if (await isPreviewOpen(page)) {
    logs.push("[step7] Preview opened via center click");
    return true;
  }

  // Attempt 3: double click for cards requiring enter/open behavior.
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
    .filter({ hasText: /(^|\s)(tải xuống|download)(\s|$)/i })
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
    logs.push(`[step7] SUCCESS: Downloaded via card menu -> ${dest}`);
    return dest;
  }

  await page.waitForTimeout(700);
  return pickResolutionAndDownload(page, outputDir, logs, preferredResolution);
}

async function tryDownloadLatestVideo(page, outputDir, logs, preferredResolution) {
  logs.push("[step7] Download flow via preview dialog...");
  await page.waitForTimeout(3000);

  try {
    // First priority: if preview is already open, use its top-bar download path.
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
      // Last resort: UI could still be in preview but button selectors changed position.
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

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] generate_veo_video invoked"];
  const artifacts = [];

  const {
    project_url,
    reference_image,
    prompt,
    output_dir,
    browser_path,
    user_data_dir,
    profile_name,
    timeout_ms,
    cdp_url,
    download_resolution,
    auto_close_browser,
  } = parsed;

  const outDir = path.resolve(output_dir || path.join(process.cwd(), "artifacts", "video"));
  await mkdir(outDir, { recursive: true });

  logs.push(`[input] project_url=${project_url}`);
  logs.push(`[input] browser=${browser_path} ${profile_name}`);
  logs.push(`[input] target_dir=${outDir}`);

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

  if (parsed.dry_run) {
    logs.push("[dry-run] Exiting early.");
    printResult(buildResult({ success: true, message: "Dry run completed.", logs }));
    return;
  }

  let context;
  let connectedByCdp = false;
  try {
    let page;
    if (cdp_url) {
      logs.push(`[step2] Connecting to browser via CDP: ${cdp_url}`);
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
        args: [`--profile-directory=${profile_name}`, "--start-maximized"],
        viewport: { width: 1440, height: 900 },
      });
    }

    page = context.pages().find((p) => p.url().includes("labs.google")) || context.pages()[0];
    if (!page) {
      page = await context.newPage();
    }

    // Attempt bringing to front if using CDP, so user can see it running
    try {
      await page.bringToFront();
    } catch (_) {}

    logs.push(`[step2] Navigating to ${project_url}`);
    if (!page.url().includes(project_url)) {
      await page.goto(project_url, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await page.waitForTimeout(4000);
    await dismissPopupsIfAny(page, logs);

    const screenshotBefore = path.join(outDir, `veo-before-${nowStamp()}.png`);
    await page.screenshot({ path: screenshotBefore, fullPage: true });
    artifacts.push({
      type: "screenshot_before",
      path: path.relative(process.cwd(), screenshotBefore).replace(/\\/g, "/"),
    });

    const beforeVideoCount = await page
      .locator("video")
      .count()
      .catch(() => 0);
    const beforeVideoSources = await collectVideoSources(page);

    await prepareImageUpload(page, reference_image, logs);
    await setPromptRobust(page, prompt, logs);
    await submitPrompt(page, logs);

    await waitForVideoResource(page, timeout_ms, logs, beforeVideoCount);

    const downloadedVideoPath = await tryDownloadLatestVideoWithFallbacks(
      context,
      page,
      outDir,
      logs,
      download_resolution,
      beforeVideoSources,
    );

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
    printResult(
      buildResult({
        success: true,
        message: downloadedVideoPath
          ? "Video generated and downloaded."
          : "Video generated but could not be downloaded.",
        data: {
          project_url,
          prompt,
          downloaded_video_path: relVideoPath || downloadedVideoPath,
        },
        artifacts,
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] ${error.stack || error.message}`);
    printResult(
      buildResult({
        success: false,
        message: "Failed during Veo video generation flow",
        data: { project_url, prompt },
        artifacts,
        logs,
        error: { details: error.message },
      }),
    );
    process.exit(1);
  } finally {
    if (context) {
      // If connected through CDP, do not close the user's browser.
      if (!connectedByCdp) {
        await context.close().catch(() => {});
      }
    }

    if (auto_close_browser) {
      await killAllCocCocBrowsers(logs);
    } else {
      logs.push("[cleanup] Auto close browser is disabled");
    }
  }
})();
