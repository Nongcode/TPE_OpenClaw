import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";

export const CHROME_PROFILE = {
  browserPath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  // user-data-dir RIÊNG cho automation — KHÔNG dùng profile Default vì Chrome
  // chặn --remote-debugging-port với default profile (security từ Chrome ~v136).
  userDataDir: path.join(os.homedir(), ".openclaw", "fb-automation-profile"),
  profileName: "Default",
};

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port, timeoutMs, devtoolsLineSeen) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    if (devtoolsLineSeen()) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return await res.json();
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `CDP debug port ${port} không sẵn sàng sau ${timeoutMs}ms. ` +
      `Last fetch error: ${lastErr?.message || "n/a"}`,
  );
}

export async function launchChrome({ logs, loginMode = false, initialUrl = null } = {}) {
  await mkdir(CHROME_PROFILE.userDataDir, { recursive: true });

  const port = await getFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME_PROFILE.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    "--disable-features=ChromeWhatsNewUI",
  ];
  if (initialUrl) args.push(initialUrl);

  logs?.push?.(`[browser] user-data-dir: ${CHROME_PROFILE.userDataDir}`);
  logs?.push?.(`[browser] Spawning Chrome on debug port ${port}`);

  const child = spawn(CHROME_PROFILE.browserPath, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });

  let devtoolsLine = false;
  let stderrBuf = "";
  child.stderr?.on("data", (chunk) => {
    const s = chunk.toString();
    stderrBuf += s;
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    if (s.includes("DevTools listening on")) devtoolsLine = true;
  });
  child.on("error", (err) => {
    logs?.push?.(`[browser] Chrome spawn error: ${err.message}`);
  });

  try {
    await waitForCdp(port, 25000, () => devtoolsLine);
  } catch (e) {
    try {
      child.kill();
    } catch {}
    const tail = stderrBuf.split(/\r?\n/).slice(-12).join("\n");
    throw new Error(
      `${e.message}\n--- Chrome stderr (tail) ---\n${tail || "(empty)"}\n` +
        `Tip: nếu thấy "Chrome đã không tắt đúng cách" hoặc Chrome khác đang chạy, ` +
        `hãy kill toàn bộ process: Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force`,
    );
  }

  if (loginMode) {
    logs?.push?.(`[browser] LOGIN MODE — không attach Playwright, chờ user login`);
    return { browser: null, context: null, chromeProcess: child, port };
  }

  logs?.push?.(`[browser] CDP ready, connecting via Playwright`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(45000);

  return { browser, context, chromeProcess: child, port };
}

export async function teardownChrome({ browser, chromeProcess, logs }) {
  try {
    await browser?.close();
  } catch {}
  try {
    if (chromeProcess && !chromeProcess.killed) {
      chromeProcess.kill();
      logs?.push?.(`[browser] Chrome process terminated`);
    }
  } catch {}
}
