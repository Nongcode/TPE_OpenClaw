import path from "node:path";
import { SELECTORS, buildBlockedDetector, findFirstVisible } from "./selectors.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function typeHumanLike(locator, text) {
  await locator.click();
  const page = locator.page();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    await page.keyboard.type(ch, { delay: randomBetween(5, 12) });
    if (ch === "\n" || (i > 0 && i % 80 === 0)) {
      await page.waitForTimeout(randomBetween(40, 110));
    }
  }
}

export async function postToGroup({ page, group, caption, mediaPaths = [], logs, screenshotDir }) {
  const tag = `[group:${group.id}]`;
  logs.push(`${tag} Navigating to ${group.url}`);

  await page.goto(group.url, { waitUntil: "domcontentloaded" });
  await sleep(randomBetween(2500, 4500));

  const isBlocked = buildBlockedDetector(page);
  if (await isBlocked()) {
    logs.push(`${tag} Detected "Nhóm không cho phép Page" banner — SKIP`);
    return { group_id: group.id, success: false, skipped: true, reason: "page_blocked" };
  }

  const join = await findFirstVisible(page, SELECTORS.joinGroupButton, 1500);
  if (join) {
    logs.push(`${tag} Profile chưa là member (thấy nút "Tham gia nhóm") — SKIP`);
    return { group_id: group.id, success: false, skipped: true, reason: "not_member" };
  }

  const trigger = await findFirstVisible(page, SELECTORS.composerTrigger, 12000);
  if (!trigger) {
    throw new Error("Không tìm thấy nút mở composer");
  }
  await trigger.click();
  logs.push(`${tag} Opened composer`);
  await sleep(randomBetween(1500, 2800));

  const dialog = page.locator(SELECTORS.composerDialog).first();
  await dialog.waitFor({ state: "visible", timeout: 10000 });

  if (await isBlocked()) {
    logs.push(`${tag} Banner block hiển thị sau khi mở composer — SKIP`);
    await page.keyboard.press("Escape").catch(() => {});
    return { group_id: group.id, success: false, skipped: true, reason: "page_blocked" };
  }

  const textbox = await findFirstVisible(page, SELECTORS.composerTextbox, 8000);
  if (!textbox) throw new Error("Không tìm thấy ô soạn nội dung");
  await typeHumanLike(textbox, caption);
  logs.push(`${tag} Typed caption (${caption.length} chars)`);
  await sleep(randomBetween(700, 1500));

  if (mediaPaths.length > 0) {
    const photoBtn = await findFirstVisible(page, SELECTORS.photoVideoButton, 4000);
    if (photoBtn) {
      await photoBtn.click().catch(() => {});
      await sleep(randomBetween(800, 1500));
    }
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.setInputFiles(mediaPaths);
    logs.push(`${tag} Attached ${mediaPaths.length} file(s)`);

    const uploadDeadline = Date.now() + 120000;
    while (Date.now() < uploadDeadline) {
      const submit = await findFirstVisible(page, SELECTORS.submitButton, 1500);
      if (submit) {
        const isDisabled = await submit.getAttribute("aria-disabled");
        if (isDisabled !== "true") break;
      }
      await sleep(1500);
    }
    logs.push(`${tag} Media upload appears ready`);
  }

  const submit = await findFirstVisible(page, SELECTORS.submitButton, 8000);
  if (!submit) throw new Error("Không tìm thấy nút Đăng");
  await sleep(randomBetween(800, 1600));
  await submit.click();
  logs.push(`${tag} Clicked submit`);

  try {
    await dialog.waitFor({ state: "hidden", timeout: 60000 });
    logs.push(`${tag} Composer closed → submit success`);
  } catch {
    logs.push(`${tag} Composer did not close in 60s — checking for pending approval state`);
    const pending = await findFirstVisible(page, SELECTORS.pendingApprovalIndicator, 1500);
    if (pending) {
      logs.push(`${tag} Bài chờ admin duyệt — coi như success`);
    } else {
      throw new Error("Composer không đóng sau khi submit");
    }
  }

  let screenshotPath = null;
  if (screenshotDir) {
    screenshotPath = path.join(screenshotDir, `${group.id}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  }

  return {
    group_id: group.id,
    success: true,
    screenshot_path: screenshotPath,
  };
}
