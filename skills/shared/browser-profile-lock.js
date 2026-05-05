import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, open, readFile, unlink } from "node:fs/promises";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

function normalizeIdentityPart(value) {
  return String(value || "").trim().replace(/\\/g, "/").toLowerCase();
}

export function buildBrowserProfileLockIdentity(options = {}) {
  return [
    normalizeIdentityPart(options.browserPath),
    normalizeIdentityPart(options.userDataDir),
    normalizeIdentityPart(options.profileName),
    normalizeIdentityPart(options.cdpUrl),
  ].join("|");
}

export function buildBrowserProfileLockPath(options = {}) {
  const identity = buildBrowserProfileLockIdentity(options);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return path.join(os.tmpdir(), "openclaw-browser-profile-locks", `${digest}.lock`);
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLockInfo(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function removeStaleLock(lockPath, staleMs, logs) {
  const info = await readLockInfo(lockPath);
  const createdAt = Number(info?.createdAt) || 0;
  const ageMs = Date.now() - createdAt;
  const ownerAlive = isProcessAlive(info?.pid);
  if (ownerAlive && ageMs < staleMs) {
    return false;
  }

  try {
    await unlink(lockPath);
    logs?.push?.(`[lock] Removed stale browser profile lock ${lockPath}`);
    return true;
  } catch {
    return false;
  }
}

async function tryAcquire(lockPath, owner) {
  let handle = null;
  try {
    handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(owner, null, 2));
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function release(lockPath, token, logs) {
  const info = await readLockInfo(lockPath);
  if (info?.token !== token) {
    return;
  }
  try {
    await unlink(lockPath);
    logs?.push?.(`[lock] Released browser profile lock ${lockPath}`);
  } catch {}
}

export async function withBrowserProfileLock(options = {}, worker) {
  const logs = options.logs;
  const lockPath = buildBrowserProfileLockPath(options);
  const lockDir = path.dirname(lockPath);
  const token = randomUUID();
  const timeoutMs = Math.max(Number(options.timeoutMs) || 0, 30000);
  const lockWaitMs =
    Number(options.lockWaitMs) ||
    Number(process.env.OPENCLAW_BROWSER_PROFILE_LOCK_WAIT_MS) ||
    timeoutMs + 60 * 60 * 1000;
  const staleMs =
    Number(options.staleMs) ||
    Number(process.env.OPENCLAW_BROWSER_PROFILE_LOCK_STALE_MS) || DEFAULT_STALE_MS;
  const pollMs =
    Number(options.pollMs) ||
    Number(process.env.OPENCLAW_BROWSER_PROFILE_LOCK_POLL_MS) || DEFAULT_POLL_MS;
  const owner = {
    token,
    pid: process.pid,
    createdAt: Date.now(),
    identity: buildBrowserProfileLockIdentity(options),
  };

  await mkdir(lockDir, { recursive: true });
  const deadline = Date.now() + Math.max(lockWaitMs, pollMs);
  let reportedWait = false;

  while (Date.now() <= deadline) {
    if (await tryAcquire(lockPath, owner)) {
      logs?.push?.(`[lock] Acquired browser profile lock ${lockPath}`);
      try {
        return await worker();
      } finally {
        await release(lockPath, token, logs);
      }
    }

    if (await removeStaleLock(lockPath, staleMs, logs)) {
      continue;
    }

    if (!reportedWait) {
      logs?.push?.(`[lock] Waiting for browser profile lock ${lockPath}`);
      reportedWait = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out waiting for browser profile lock after ${Math.round(lockWaitMs / 1000)}s: ${lockPath}`,
  );
}
