import { spawn } from "node:child_process";
import path from "node:path";

function parseArgs(argv) {
  const params = {
    browser_path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    user_data_dir: "C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data",
    profile_name: "Default",
    url: "https://www.facebook.com/profile.php?id=61575201895243",
    dry_run: false,
  };

  const logs = [];
  const args = argv.slice(2);

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      return {
        ...params,
        ...parsed,
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        logs,
      };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error.message}`);
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    if (token === "--browser_path" && next) {
      params.browser_path = next;
      index += 1;
      continue;
    }
    if (token === "--user_data_dir" && next) {
      params.user_data_dir = next;
      index += 1;
      continue;
    }
    if (token === "--profile_name" && next) {
      params.profile_name = next;
      index += 1;
      continue;
    }
    if (token === "--url" && next) {
      params.url = next;
      index += 1;
      continue;
    }
    if (token === "--dry-run" || token === "--dry_run") {
      params.dry_run = true;
    }
  }

  return { ...params, logs };
}

function sanitizeInput(params) {
  const missing = [];
  if (!params.browser_path) missing.push("browser_path");
  if (!params.user_data_dir) missing.push("user_data_dir");
  if (!params.profile_name) missing.push("profile_name");
  if (!params.url) missing.push("url");
  return missing;
}

function buildResult({
  success,
  message,
  data = {},
  artifacts = [],
  logs = [],
  screenshot_path = null,
  error = null,
}) {
  return {
    success,
    message,
    data,
    artifacts,
    logs,
    screenshot_path,
    error,
  };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs];

  logs.push("[start] open_browser_profile invoked");

  const missing = sanitizeInput(parsed);
  if (missing.length > 0) {
    const result = buildResult({
      success: false,
      message: "Missing required inputs",
      logs,
      error: {
        code: "VALIDATION_ERROR",
        details: `Missing fields: ${missing.join(", ")}`,
      },
    });
    printResult(result);
    process.exit(1);
  }

  const browserPath = path.normalize(parsed.browser_path);
  const userDataDir = path.normalize(parsed.user_data_dir);
  const profileName = parsed.profile_name;
  const targetUrl = parsed.url;

  const launchArgs = [`--user-data-dir=${userDataDir}`, `--profile-directory=${profileName}`, targetUrl];

  logs.push(`[input] browser_path=${browserPath}`);
  logs.push(`[input] user_data_dir=${userDataDir}`);
  logs.push(`[input] profile_name=${profileName}`);
  logs.push(`[input] url=${targetUrl}`);
  logs.push(`[plan] launch args: ${launchArgs.join(" ")}`);

  if (parsed.dry_run) {
    logs.push("[dry-run] Skipped process spawn");
    const result = buildResult({
      success: true,
      message: "Dry run completed. Browser launch skipped.",
      data: {
        dry_run: true,
        browser_path: browserPath,
        user_data_dir: userDataDir,
        profile_name: profileName,
        url: targetUrl,
        command: {
          executable: browserPath,
          args: launchArgs,
        },
      },
      logs,
      artifacts: [],
      screenshot_path: null,
      error: null,
    });
    printResult(result);
    return;
  }

  let child;
  try {
    child = spawn(browserPath, launchArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    logs.push("[spawn] Microsoft Edge process started");
  } catch (spawnError) {
    const result = buildResult({
      success: false,
      message: "Failed to open browser profile",
      logs: [...logs, "[spawn] Spawn threw synchronously"],
      error: {
        code: "SPAWN_ERROR",
        details: spawnError instanceof Error ? spawnError.message : String(spawnError),
      },
    });
    printResult(result);
    process.exit(1);
  }

  if (child && typeof child.once === "function") {
    child.once("error", (errorEvent) => {
      const result = buildResult({
        success: false,
        message: "Browser process emitted error event",
        logs: [...logs, "[spawn] Child process error event"],
        error: {
          code: "PROCESS_ERROR",
          details: errorEvent instanceof Error ? errorEvent.message : String(errorEvent),
        },
      });
      printResult(result);
    });
  }

  const result = buildResult({
    success: true,
    message: "Browser launch command sent successfully",
    data: {
      dry_run: false,
      browser_path: browserPath,
      user_data_dir: userDataDir,
      profile_name: profileName,
      url: targetUrl,
      pid: child && typeof child.pid === "number" ? child.pid : null,
      command: {
        executable: browserPath,
        args: launchArgs,
      },
    },
    artifacts: [],
    logs,
    screenshot_path: null,
    error: null,
  });

  printResult(result);
})();
