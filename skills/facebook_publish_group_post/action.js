import { access, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowserProfileLock } from "../shared/browser-profile-lock.js";
import { launchChrome, teardownChrome, CHROME_PROFILE } from "./lib/browser.js";
import { postToGroup } from "./lib/group-poster.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  media_paths: [],
  group_ids: null,
  delay_min_ms: 25000,
  delay_max_ms: 55000,
  max_groups: 9,
  dry_run: false,
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string")
    return value
      .split(/\r?\n|;|,/g)
      .map((v) => v.trim())
      .filter(Boolean);
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
        media_paths: parseList(parsed.media_paths),
        group_ids: parsed.group_ids ? parseList(parsed.group_ids) : null,
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        logs,
      };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error.message}`);
    }
  }
  return { ...params, logs };
}

function validate(params) {
  const missing = [];
  const hasCaption =
    (typeof params.caption_long === "string" && params.caption_long.trim() !== "") ||
    (typeof params.caption_short === "string" && params.caption_short.trim() !== "");
  if (!hasCaption) missing.push("caption_long_or_caption_short");
  return missing;
}

async function ensureReadable(paths) {
  for (const p of paths) await access(p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] facebook_publish_group_post invoked"];

  const missing = validate(parsed);
  if (missing.length > 0) {
    printResult(
      buildResult({
        success: false,
        message: "Missing required inputs",
        logs,
        error: { code: "VALIDATION_ERROR", details: missing.join(", ") },
      }),
    );
    process.exit(1);
  }

  const caption = (parsed.caption_long?.trim() || parsed.caption_short.trim());
  const mediaPaths = parseList(parsed.media_paths).map((p) => path.normalize(p));

  const configPath = path.join(__dirname, "config", "target-groups.json");
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (e) {
    printResult(
      buildResult({
        success: false,
        message: "Cannot read config/target-groups.json",
        logs,
        error: { code: "CONFIG_ERROR", details: e.message },
      }),
    );
    process.exit(1);
  }

  const allGroups = Array.isArray(config.groups) ? config.groups : [];
  let selected = allGroups.filter((g) => g.enabled !== false);
  if (parsed.group_ids && parsed.group_ids.length > 0) {
    const wanted = new Set(parsed.group_ids.map(String));
    selected = allGroups.filter((g) => wanted.has(String(g.id)));
  }

  const maxRun = Number(parsed.max_groups) || config.max_groups_per_run || selected.length;
  if (selected.length > maxRun) selected = selected.slice(0, maxRun);

  logs.push(`[input] groups_to_process=${selected.length}, media=${mediaPaths.length}`);

  if (selected.length === 0) {
    printResult(
      buildResult({
        success: false,
        message: "No groups selected (check enabled flags or group_ids filter)",
        logs,
      }),
    );
    process.exit(1);
  }

  if (mediaPaths.length > 0) {
    try {
      await ensureReadable(mediaPaths);
    } catch (e) {
      printResult(
        buildResult({
          success: false,
          message: "Media file not found or inaccessible",
          logs,
          error: { code: "FILE_ERROR", details: e.message },
        }),
      );
      process.exit(1);
    }
  }

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip browser actions");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed",
        data: {
          caption,
          media_paths: mediaPaths,
          groups: selected.map((g) => g.id),
          delay_range: [parsed.delay_min_ms, parsed.delay_max_ms],
        },
        logs,
      }),
    );
    return;
  }

  const screenshotDir = path.join(__dirname, ".screenshots");
  await mkdir(screenshotDir, { recursive: true }).catch(() => {});

  const lockOptions = {
    browserPath: CHROME_PROFILE.browserPath,
    userDataDir: CHROME_PROFILE.userDataDir,
    profileName: CHROME_PROFILE.profileName,
    logs,
    timeoutMs: selected.length * (parsed.delay_max_ms + 60000),
  };

  let chromeBundle = null;
  let hasError = false;
  const results = [];

  try {
    await withBrowserProfileLock(lockOptions, async () => {
      chromeBundle = await launchChrome({ logs });
      const { context } = chromeBundle;
      const page = context.pages()[0] || (await context.newPage());

      for (let i = 0; i < selected.length; i += 1) {
        const group = selected[i];
        logs.push(`\n--- [${i + 1}/${selected.length}] Group ${group.id} ---`);
        try {
          const r = await postToGroup({
            page,
            group,
            caption,
            mediaPaths,
            logs,
            screenshotDir,
          });
          results.push(r);
          if (!r.success && !r.skipped) hasError = true;
        } catch (e) {
          logs.push(`[group:${group.id}] FAIL: ${e.message}`);
          results.push({ group_id: group.id, success: false, error: e.message });
          hasError = true;
          await page.screenshot({
            path: path.join(screenshotDir, `${group.id}-FAIL-${Date.now()}.png`),
          }).catch(() => {});
        }

        if (i < selected.length - 1) {
          const delay = randomBetween(parsed.delay_min_ms, parsed.delay_max_ms);
          logs.push(`[wait] Sleeping ${delay}ms before next group`);
          await sleep(delay);
        }
      }
    });
  } catch (e) {
    logs.push(`[fatal] ${e.message}`);
    if (chromeBundle) await teardownChrome({ ...chromeBundle, logs });
    printResult(
      buildResult({
        success: false,
        message: "Fatal error during automation",
        data: { results },
        logs,
        error: { code: "FATAL", details: e.message },
      }),
    );
    process.exit(1);
  }

  if (chromeBundle) await teardownChrome({ ...chromeBundle, logs });

  const succeeded = results.filter((r) => r.success).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.success && !r.skipped).length;

  printResult(
    buildResult({
      success: !hasError,
      message: `Posted: ${succeeded}, Skipped: ${skipped}, Failed: ${failed}`,
      data: { results, summary: { succeeded, skipped, failed, total: results.length } },
      logs,
    }),
  );
})();
