import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChatImageReplyPayload } from "../shared/chat-image-result.js";

const DEFAULTS = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Profile 2",
  target_flow_url:
    "https://labs.google/fx/vi/tools/flow/project/84c5e618-a20d-49cf-b4ef-707db64693bc",
  image_paths: [],
  output_dir: "",
  cdp_url: "",
  timeout_ms: 1200000,
  download_resolution: "720p",
  auto_close_browser: false,
  retry_count: 2,
  dry_run: false,
};

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "artifacts", "images");

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

  if (args.findIndex((arg) => arg === "--input_file" || arg === "--input-file") !== -1) {
    const index = args.findIndex((arg) => arg === "--input_file" || arg === "--input-file");
    const inputPath = args[index + 1];
    if (inputPath) {
      try {
        const parsed = JSON.parse(requireTextFile(inputPath).replace(/^\uFEFF/, ""));
        Object.assign(params, parsed);
        params.image_paths = parseList(parsed.image_paths);
        if (parsed.dry_run === true || parsed["dry-run"] === true) params.dry_run = true;
      } catch (error) {
        logs.push(`[parse] Invalid JSON input file: ${toErrorMessage(error)}`);
      }
    }
  } else if (args.length > 0 && args[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      Object.assign(params, parsed);
      params.image_paths = parseList(parsed.image_paths);
      if (parsed.dry_run === true || parsed["dry-run"] === true) params.dry_run = true;
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${toErrorMessage(error)}`);
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
    if (token === "--target_flow_url" || token === "--project_url") {
      params.target_flow_url = next;
      index += 1;
      continue;
    }
    if (token === "--cdp_url") {
      params.cdp_url = next;
      index += 1;
      continue;
    }
    if (token === "--timeout_ms") {
      params.timeout_ms = Number(next);
      index += 1;
      continue;
    }
    if (token === "--download_resolution") {
      params.download_resolution = next;
      index += 1;
      continue;
    }
    if (token === "--auto_close_browser") {
      params.auto_close_browser = next === "true" || next === "1";
      index += 1;
      continue;
    }
    if (token === "--retry_count") {
      params.retry_count = Number(next);
      index += 1;
    }
  }

  return { ...params, logs };
}

function requireTextFile(filePath) {
  return String(readFileSync(filePath, "utf8"));
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateInput(params) {
  const missing = [];

  if (typeof params.image_prompt !== "string" || params.image_prompt.trim() === "") {
    missing.push("image_prompt");
  }
  if (!Array.isArray(parseList(params.image_paths)) || parseList(params.image_paths).length === 0) {
    missing.push("image_paths");
  }

  return missing;
}

function createChildInput(params) {
  const imagePaths = parseList(params.image_paths);
  const [referenceImage = "", ...extraImages] = imagePaths;

  return {
    project_url: String(params.target_flow_url || DEFAULTS.target_flow_url).trim(),
    prompt: String(params.image_prompt || "").trim(),
    reference_image: referenceImage,
    logo_paths: extraImages,
    browser_path: String(params.browser_path || DEFAULTS.browser_path).trim(),
    user_data_dir: String(params.user_data_dir || DEFAULTS.user_data_dir).trim(),
    profile_name: String(params.profile_name || DEFAULTS.profile_name).trim(),
    output_dir: String(params.output_dir || DEFAULT_OUTPUT_DIR).trim(),
    cdp_url: String(params.cdp_url || "").trim(),
    timeout_ms: Number.isFinite(params.timeout_ms) ? params.timeout_ms : DEFAULTS.timeout_ms,
    download_resolution: String(params.download_resolution || DEFAULTS.download_resolution).trim(),
    auto_close_browser: Boolean(params.auto_close_browser),
    retry_count: Number.isFinite(params.retry_count) ? params.retry_count : DEFAULTS.retry_count,
    dry_run: params.dry_run === true,
  };
}

function dedupeArtifacts(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = typeof item.type === "string" ? item.type.trim() : "";
    const itemPath = typeof item.path === "string" ? item.path.trim() : "";
    if (!type || !itemPath) continue;

    const key = `${type}\u001F${itemPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, type, path: itemPath });
  }

  return result;
}

function remapArtifactType(type) {
  if (type === "generated_video") return "generated_image";
  if (type === "chat_video") return "chat_image";
  return type;
}

function pickGeneratedMediaPath(childResult) {
  const childData =
    childResult?.data && typeof childResult.data === "object" ? childResult.data : {};
  if (
    typeof childData.downloaded_video_path === "string" &&
    childData.downloaded_video_path.trim()
  ) {
    return childData.downloaded_video_path.trim();
  }
  if (typeof childData.video_path === "string" && childData.video_path.trim()) {
    return childData.video_path.trim();
  }

  const artifacts = Array.isArray(childResult?.artifacts) ? childResult.artifacts : [];
  const candidate = artifacts.find((item) => item?.type === "generated_video" && item?.path);
  return typeof candidate?.path === "string" ? candidate.path.trim() : "";
}

function sanitizeChildData(childData, params, downloadedImagePath, chatReplyData) {
  const payload = {
    target_flow_url: String(params.target_flow_url || DEFAULTS.target_flow_url).trim(),
    image_prompt: String(params.image_prompt || "").trim(),
    downloaded_image_path: downloadedImagePath || "",
  };

  if (typeof childData.used_reference_image === "string" && childData.used_reference_image.trim()) {
    payload.used_reference_image = childData.used_reference_image.trim();
  }
  if (Array.isArray(childData.used_logo_paths) && childData.used_logo_paths.length > 0) {
    payload.used_extra_image_paths = childData.used_logo_paths;
  }
  if (
    typeof childData.reference_image_sha256 === "string" &&
    childData.reference_image_sha256.trim()
  ) {
    payload.reference_image_sha256 = childData.reference_image_sha256.trim();
  }
  if (chatReplyData && typeof chatReplyData === "object") {
    Object.assign(payload, chatReplyData);
  }

  return payload;
}

function remapChildMessage(message, fallback) {
  const text = typeof message === "string" && message.trim() ? message.trim() : fallback;
  return text.replace(/video/gi, (matched) => {
    if (matched === "Video") return "Image";
    if (matched === "VIDEO") return "IMAGE";
    return "image";
  });
}

function buildSuccessResult(params, childResult, logs) {
  const childData =
    childResult?.data && typeof childResult.data === "object" ? childResult.data : {};
  const downloadedImagePath = pickGeneratedMediaPath(childResult);
  const childArtifacts = Array.isArray(childResult?.artifacts) ? childResult.artifacts : [];
  const remappedArtifacts = childArtifacts.map((item) => ({
    ...item,
    type: remapArtifactType(item?.type),
  }));

  let chatReply = null;
  if (downloadedImagePath) {
    chatReply = buildChatImageReplyPayload({
      imagePath: downloadedImagePath,
      data: {
        target_flow_url: String(params.target_flow_url || DEFAULTS.target_flow_url).trim(),
        image_prompt: String(params.image_prompt || "").trim(),
        downloaded_image_path: downloadedImagePath,
      },
      artifacts: [{ type: "generated_image", path: downloadedImagePath }],
    });
  }

  return buildResult({
    success: true,
    message:
      chatReply?.assistantText ||
      remapChildMessage(
        childResult?.message,
        "Image generation flow completed, but no downloadable image artifact was returned.",
      ),
    data: sanitizeChildData(childData, params, downloadedImagePath, chatReply?.data),
    artifacts: dedupeArtifacts([...remappedArtifacts, ...(chatReply?.artifacts || [])]),
    logs,
  });
}

function buildFailureResult(params, childResult, logs, fallbackDetails = "") {
  const childData =
    childResult?.data && typeof childResult.data === "object" ? childResult.data : {};
  const childError =
    childResult?.error && typeof childResult.error === "object" ? childResult.error : null;

  return buildResult({
    success: false,
    message: remapChildMessage(childResult?.message, "Flow image generation failed"),
    data: {
      target_flow_url: String(params.target_flow_url || DEFAULTS.target_flow_url).trim(),
      image_prompt: String(params.image_prompt || "").trim(),
      ...(typeof childData === "object" ? childData : {}),
    },
    artifacts: Array.isArray(childResult?.artifacts) ? childResult.artifacts : [],
    logs,
    error: childError || {
      code: "FLOW_FAILED",
      details: fallbackDetails || "Flow image generation failed",
    },
  });
}

function parseChildJson(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

function runChildAction(inputPayload, logs) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "generate-flow-image-"));
  const tempInputPath = path.join(tempDir, "input.json");

  try {
    writeFileSync(tempInputPath, `${JSON.stringify(inputPayload, null, 2)}\n`, "utf8");
    const childActionPath = path.resolve("skills/generate_veo_video/action.js");

    logs.push("[bridge] Calling generate_veo_video/action.js with mapped image payload");
    const child = spawnSync(process.execPath, [childActionPath, "--input_file", tempInputPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });

    const stdout = String(child.stdout || "");
    const stderr = String(child.stderr || "");
    const childResult = parseChildJson(stdout);

    if (stderr.trim()) {
      logs.push(`[bridge] Child stderr: ${stderr.trim()}`);
    }
    logs.push(`[bridge] Child exit status: ${child.status ?? "null"}`);

    return { child, childResult };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

(function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] generate_flow_image invoked"];

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(
      buildResult({
        success: false,
        message: "Missing required inputs",
        logs,
        error: {
          code: "VALIDATION_ERROR",
          details: `Missing fields: ${missing.join(", ")}`,
        },
      }),
    );
    process.exit(1);
  }

  const childInput = createChildInput(parsed);
  logs.push(`[input] target_flow_url=${childInput.project_url}`);
  logs.push(`[input] image_paths=${parseList(parsed.image_paths).length}`);
  logs.push(`[input] output_dir=${childInput.output_dir}`);

  try {
    const { child, childResult } = runChildAction(childInput, logs);

    if (!childResult || typeof childResult !== "object") {
      printResult(
        buildFailureResult(parsed, null, logs, "Child flow did not return valid JSON output"),
      );
      process.exit(1);
    }

    const childLogs = Array.isArray(childResult.logs) ? childResult.logs : [];
    const mergedLogs = [...logs, ...childLogs];

    if (child.status === 0 && childResult.success === true) {
      printResult(buildSuccessResult(parsed, childResult, mergedLogs));
      return;
    }

    printResult(buildFailureResult(parsed, childResult, mergedLogs));
    process.exit(typeof child.status === "number" && child.status !== 0 ? child.status : 1);
  } catch (error) {
    logs.push(`[fail] ${toErrorMessage(error)}`);
    printResult(buildFailureResult(parsed, null, logs, toErrorMessage(error)));
    process.exit(1);
  }
})();
