#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

function logStep(step, detail = "") {
  const msg = detail ? `[veo-skill] ${step}: ${detail}` : `[veo-skill] ${step}`;
  console.error(msg);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeNow() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseInput() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error("Thiếu JSON input ở argv[2].");
  }
  return JSON.parse(raw);
}

async function maybeClick(page, selectors = [], timeout = 2500) {
  for (const s of selectors) {
    try {
      const locator = page.locator(s).first();
      await locator.waitFor({ state: "visible", timeout });
      await locator.click();
      return true;
    } catch (_) {}
  }
  return false;
}

async function maybeClickByText(page, texts = [], timeout = 2500) {
  for (const t of texts) {
    try {
      const locator = page.getByText(t, { exact: true }).first();
      await locator.waitFor({ state: "visible", timeout });
      await locator.click();
      return true;
    } catch (_) {}
  }
  return false;
}

async function maybeFillPrompt(page, prompt) {
  const candidates = [
    'textarea',
    '[contenteditable="true"]',
    'div[role="textbox"]',
    'input[type="text"]'
  ];

  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).filter({ hasNotText: "Tìm kiếm" }).last();
      await loc.waitFor({ state: "visible", timeout: 2000 });

      const tagName = await loc.evaluate((el) => el.tagName.toLowerCase());
      if (tagName === "textarea" || tagName === "input") {
        await loc.fill(prompt);
      } else {
        await loc.click();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.type(prompt, { delay: 10 });
      }
      return true;
    } catch (_) {}
  }

  return false;
}

async function selectAspectRatio(page, ratio) {
  logStep("aspect_ratio", ratio);

  const ok = await maybeClickByText(page, [ratio], 2000);
  if (ok) return true;

  const mapping = {
    "9:16": ['button:has-text("9:16")', '[role="button"]:has-text("9:16")'],
    "16:9": ['button:has-text("16:9")', '[role="button"]:has-text("16:9")'],
  };

  return maybeClick(page, mapping[ratio] || [], 2000);
}

async function selectMultiplier(page, multiplier) {
  const label = `x${multiplier}`;
  logStep("multiplier", label);
  return maybeClickByText(page, [label], 2000);
}

async function selectVideoTab(page) {
  logStep("tab", "Video");
  const ok = await maybeClickByText(page, ["Video"], 3000);
  if (ok) return true;

  return maybeClick(page, [
    'button:has-text("Video")',
    '[role="tab"]:has-text("Video")',
    '[role="button"]:has-text("Video")'
  ], 3000);
}

async function selectModel(page, modelLabel) {
  logStep("model", modelLabel);

  const opened = await maybeClick(page, [
    `button:has-text("${modelLabel}")`,
    `[role="button"]:has-text("${modelLabel}")`,
    'button:has-text("Veo")',
    '[role="button"]:has-text("Veo")'
  ], 2000);

  if (!opened) {
    // Có thể dropdown đã mở sẵn / model đang hiển thị rồi
    return true;
  }

  const chosen = await maybeClickByText(page, [modelLabel], 2500);
  return chosen || true;
}

async function uploadReferenceImage(page, imagePath) {
  if (!imagePath) return false;

  const abs = path.resolve(imagePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Không tìm thấy file ảnh tham chiếu: ${abs}`);
  }

  logStep("upload_image", abs);

  // Đảm bảo đang ở tab "Hình ảnh" (hoặc Thành phần) nếu có
  await maybeClickByText(page, ["Hình ảnh", "Thành phần"], 2500);
  await sleep(1000);

  // Cách an toàn nhất trong Playwright: Lắng nghe sự kiện bật hộp thoại chọn file
  try {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      // Click vào vùng chứa dòng chữ "Tải hình ảnh lên" như trong HTML
      page.locator('div:has-text("Tải hình ảnh lên")').last().click()
    ]);
    
    // Gắn đường dẫn file vào hộp thoại vừa mở
    await fileChooser.setFiles(abs);
    return true;
  } catch (err) {
    logStep("upload_image_fallback", "Đang thử tìm input file ẩn...");
    // Fallback: Thử gắn file trực tiếp vào thẻ input ẩn nếu cách trên thất bại
    const fileInputs = page.locator('input[type="file"]');
    const count = await fileInputs.count();
    if (count > 0) {
      await fileInputs.first().setInputFiles(abs);
      return true;
    }
  }

  throw new Error("Không thể thực hiện click tải ảnh lên.");
}

async function clickGenerate(page) {
  logStep("generate", "Bắt đầu tạo video");

  const selectors = [
    'button[aria-label*="Tạo"]',
    'button[aria-label*="Generate"]',
    'button:has-text("Tạo")',
    'button:has-text("Generate")',
    '[role="button"]:has-text("Tạo")',
    '[role="button"]:has-text("Generate")',
    'button:has(svg)',
  ];

  for (const s of selectors) {
    try {
      const locator = page.locator(s).last();
      await locator.waitFor({ state: "visible", timeout: 2000 });
      await locator.click();
      return true;
    } catch (_) {}
  }

  // fallback: Enter
  await page.keyboard.press("Enter");
  return true;
}

async function waitForGeneration(page, timeoutMs) {
  logStep("wait_generation", `${Math.round(timeoutMs / 1000)}s`);

  const start = Date.now();
  let lastStatus = "Đang chờ video hoàn thành...";

  while (Date.now() - start < timeoutMs) {
    try {
      const videoCards = page.locator('video');
      const count = await videoCards.count();
      if (count > 0) {
        logStep("generation_done", `Tìm thấy ${count} phần tử video`);
        return { done: true, reason: "video_element_found" };
      }
    } catch (_) {}

    const statusTexts = [
      "Đang tạo",
      "Generating",
      "Rendering",
      "Processing",
      "Tạo video",
      "Hoàn tất",
      "Complete",
      "Completed"
    ];

    for (const t of statusTexts) {
      try {
        const visible = await page.getByText(t).first().isVisible({ timeout: 300 });
        if (visible) {
          lastStatus = t;
          logStep("progress", t);
          break;
        }
      } catch (_) {}
    }

    await sleep(5000);
  }

  return { done: false, reason: `timeout: ${lastStatus}` };
}

async function tryDownloadLatestVideo(page, outDir) {
  logStep("download", "Thử tải video mới nhất");

  // BƯỚC 1: Click chuột phải vào video mới nhất để mở Context Menu
  try {
    const videoElement = page.locator('video').last();
    await videoElement.waitFor({ state: "visible", timeout: 5000 });
    // Dùng nút right (chuột phải) thay vì click thông thường
    await videoElement.click({ button: 'right' }); 
    await sleep(1500); // Chờ một chút để menu xổ xuống (rất quan trọng)
  } catch (err) {
    logStep("download_warn", "Không tìm thấy thẻ video để click chuột phải.");
  }

  // BƯỚC 2: Click vào nút "Tải xuống" bên trong menu
  // Thay đổi selector để phù hợp với thẻ <div role="menuitem"> trong HTML
  const possibleMenuContent = [
    '[role="menuitem"]:has-text("Tải xuống")', 
    'div:has-text("Tải xuống")',
    '[role="menuitem"]:has-text("Download")'
  ];

  for (const sel of possibleMenuContent) {
    try {
      const btn = page.locator(sel).last();
      await btn.waitFor({ state: "visible", timeout: 2500 });

      // Lắng nghe sự kiện tải xuống của trình duyệt trước khi click
      const downloadPromise = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
      await btn.click();
      
      const download = await downloadPromise;
      if (download) {
        const fileName = download.suggestedFilename() || `veo-${safeNow()}.mp4`;
        const filePath = path.join(outDir, fileName);
        await download.saveAs(filePath);
        logStep("download_success", filePath);
        return filePath;
      }
    } catch (_) {}
  }

  return null;
}

async function ensureLogin(page, waitForManualLoginMs) {
  const url = page.url();
  const needsLogin =
    /accounts\.google\.com/i.test(url) ||
    /signin/i.test(url);

  if (!needsLogin) return;

  logStep("login_required", "Cần đăng nhập Google thủ công lần đầu");
  console.error("Hãy đăng nhập Google trên cửa sổ trình duyệt vừa mở...");

  const deadline = Date.now() + waitForManualLoginMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const nowUrl = page.url();
    if (!/accounts\.google\.com/i.test(nowUrl) && !/signin/i.test(nowUrl)) {
      logStep("login_success", "Đăng nhập thành công");
      return;
    }
  }

  throw new Error("Hết thời gian chờ đăng nhập Google thủ công.");
}

async function main() {
  const input = parseInput();

  const projectUrl =
    input.project_url ||
    "https://labs.google/fx/vi/tools/flow/project/ea150be4-d292-432a-a757-34e6ae1a06cd";

  const prompt =
    input.prompt ||
    input.video_prompt ||
    "Tạo video quảng cáo sản phẩm chuyên nghiệp.";

  const outputDir = path.resolve(
    input.output_dir || path.join(process.cwd(), "outputs", "veo_videos")
  );

  const userDataDir = path.resolve(
    input.user_data_dir || path.join(process.cwd(), ".flow-profile")
  );

  const aspectRatio = input.aspect_ratio || "9:16";
  const multiplier = String(input.multiplier || "1").replace("x", "");
  const model = input.model || "Veo 3.1 - Quality";
  const referenceImage = input.reference_image || input.image_path || null;
  const headless = Boolean(input.headless ?? false);
  const timeoutMs = Number(input.timeout_ms || 20 * 60 * 1000);
  const waitForManualLoginMs = Number(input.manual_login_timeout_ms || 3 * 60 * 1000);

  ensureDir(outputDir);
  ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1600, height: 1000 },
    args: ["--start-maximized"],
    acceptDownloads: true,
  });

  const page = context.pages()[0] || await context.newPage();

  try {
    logStep("open", projectUrl);
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

    await ensureLogin(page, waitForManualLoginMs);

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await sleep(3000);

    console.error("STATUS: Đang chuyển sang chế độ Video");
    await selectVideoTab(page);

    console.error(`STATUS: Đang chọn model ${model}`);
    await selectModel(page, model);

    console.error(`STATUS: Đang chọn tỉ lệ ${aspectRatio}`);
    await selectAspectRatio(page, aspectRatio);

    console.error(`STATUS: Đang chọn số clip x${multiplier}`);
    await selectMultiplier(page, multiplier);

    if (referenceImage) {
      console.error("STATUS: Đang tải ảnh tham chiếu");
      await uploadReferenceImage(page, referenceImage);
      await sleep(2000);
    }

    console.error("STATUS: Đang nhập prompt video");
    const filled = await maybeFillPrompt(page, prompt);
    if (!filled) {
      throw new Error("Không tìm thấy ô prompt để nhập nội dung.");
    }

    console.error("STATUS: Đang bấm tạo video");
    await clickGenerate(page);

    console.error("STATUS: Đang chờ Veo render video");
    const result = await waitForGeneration(page, timeoutMs);

    const screenshotPath = path.join(outputDir, `veo-${safeNow()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    if (!result.done) {
      console.log(JSON.stringify({
        success: false,
        error: {
          code: "GENERATION_TIMEOUT",
          message: `Veo chưa trả video xong: ${result.reason}`
        },
        artifacts: [screenshotPath],
        logs: [`screenshot=${screenshotPath}`]
      }, null, 2));
      await context.close();
      process.exit(1);
    }

    console.error("STATUS: Đang thử tải video về máy");
    const videoPath = await tryDownloadLatestVideo(page, outputDir);

    const response = {
      success: true,
      message: videoPath
        ? "Tạo video thành công và đã tải file về máy."
        : "Tạo video thành công, nhưng chưa tự tải được file. Hãy kiểm tra UI/selector download.",
      result: {
        project_url: projectUrl,
        model,
        aspect_ratio: aspectRatio,
        multiplier: `x${multiplier}`,
        prompt,
        screenshot_path: screenshotPath,
        video_path: videoPath || null,
      },
      artifacts: [screenshotPath].concat(videoPath ? [videoPath] : []),
      logs: [
        `project_url=${projectUrl}`,
        `model=${model}`,
        `aspect_ratio=${aspectRatio}`,
        `multiplier=x${multiplier}`,
        `screenshot=${screenshotPath}`,
        ...(videoPath ? [`video=${videoPath}`, `MEDIA: ${videoPath}`] : [])
      ]
    };

    console.log(JSON.stringify(response, null, 2));
    await context.close();
  } catch (err) {
    const screenshotPath = path.join(outputDir, `veo-error-${safeNow()}.png`);
    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (_) {}

    console.log(JSON.stringify({
      success: false,
      error: {
        code: "VEO_AUTOMATION_FAILED",
        message: err.message
      },
      artifacts: fs.existsSync(screenshotPath) ? [screenshotPath] : [],
      logs: fs.existsSync(screenshotPath) ? [`error_screenshot=${screenshotPath}`] : []
    }, null, 2));

    await context.close();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
