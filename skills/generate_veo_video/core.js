import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Profile 2",
  project_url: "https://labs.google/fx/vi/tools/flow/project/2129dba8-28ff-4699-8ed8-7397e399d986",
  reference_image: "",
  logo_paths: [],
  prompt: "Tao video quang cao",
  output_dir: "",
  cdp_url: "",
  timeout_ms: 1_200_000,
  step_timeout_ms: 180_000,
  download_resolution: "720p",
  auto_close_browser: false,
  retry_count: 3,
  dry_run: false,
  dry_run_dom: false,
  dom_debug: true,
  debug_only: false,
  video_count: 1,
  generation_mode: "sequential",
  save_step_screenshots: true,
  fail_fast_on_quota: true,
  per_video_prompt_suffixes: [],
};

const MAX_VIDEO_COUNT = 10;
const BACKOFF_DELAYS_MS = [2_000, 5_000, 10_000];

export function buildResult({
  success,
  message,
  data = {},
  artifacts = [],
  logs = [],
  error = null,
}) {
  return { success, message, data, artifacts, logs, error };
}

export function parseList(value) {
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applyParsedInput(params, parsed) {
  Object.assign(params, parsed);
  params.logo_paths = parseList(parsed.logo_paths ?? params.logo_paths);
  params.per_video_prompt_suffixes = parseList(
    parsed.per_video_prompt_suffixes ?? params.per_video_prompt_suffixes,
  );
  if (parsed.dry_run === true || parsed["dry-run"] === true) {
    params.dry_run = true;
  }
  if (parsed.dry_run_dom === true || parsed["dry-run-dom"] === true) {
    params.dry_run_dom = true;
  }
}

function normalizeInputShape(params) {
  const normalized = { ...DEFAULTS, ...params };
  normalized.logo_paths = parseList(normalized.logo_paths);
  normalized.per_video_prompt_suffixes = parseList(normalized.per_video_prompt_suffixes);
  normalized.timeout_ms = parseNumber(normalized.timeout_ms, DEFAULTS.timeout_ms);
  normalized.step_timeout_ms = parseNumber(
    normalized.step_timeout_ms,
    DEFAULTS.step_timeout_ms,
  );
  normalized.retry_count = clamp(
    parseInteger(normalized.retry_count, DEFAULTS.retry_count),
    0,
    10,
  );
  normalized.video_count = clamp(
    parseInteger(normalized.video_count, DEFAULTS.video_count),
    1,
    MAX_VIDEO_COUNT,
  );
  normalized.auto_close_browser = parseBoolean(
    normalized.auto_close_browser,
    DEFAULTS.auto_close_browser,
  );
  normalized.dry_run = parseBoolean(normalized.dry_run, DEFAULTS.dry_run);
  normalized.dry_run_dom = parseBoolean(normalized.dry_run_dom, DEFAULTS.dry_run_dom);
  normalized.dom_debug = parseBoolean(normalized.dom_debug, DEFAULTS.dom_debug);
  normalized.debug_only = parseBoolean(normalized.debug_only, DEFAULTS.debug_only);
  normalized.save_step_screenshots = parseBoolean(
    normalized.save_step_screenshots,
    DEFAULTS.save_step_screenshots,
  );
  normalized.fail_fast_on_quota = parseBoolean(
    normalized.fail_fast_on_quota,
    DEFAULTS.fail_fast_on_quota,
  );
  normalized.generation_mode =
    normalized.generation_mode === "parallel_safe" ? "parallel_safe" : "sequential";
  normalized.download_resolution =
    normalizeResolutionLabel(normalized.download_resolution) ||
    normalizeResolutionLabel(DEFAULTS.download_resolution) ||
    "720p";

  if (normalized.dry_run_dom) {
    normalized.dom_debug = true;
    normalized.debug_only = true;
  }

  return normalized;
}

export function parseArgs(argv) {
  const params = { ...DEFAULTS };
  const logs = [];
  const args = argv.slice(2);

  const inputFileIndex = args.findIndex((token) => token === "--input_file" || token === "--input-file");
  if (inputFileIndex !== -1 && args[inputFileIndex + 1]) {
    try {
      const raw = readFileSync(args[inputFileIndex + 1], "utf8").replace(/^\uFEFF/, "");
      applyParsedInput(params, JSON.parse(raw));
    } catch (error) {
      logs.push(`[parse] Invalid JSON input file: ${error.message}`);
    }
  } else if (args.length > 0 && args[0].trim().startsWith("{")) {
    try {
      applyParsedInput(params, JSON.parse(args[0]));
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error.message}`);
    }
  }

  const readOptionalValue = (index) => {
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      return { value: undefined, consumed: 0 };
    }
    return { value: next, consumed: 1 };
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const { value, consumed } = readOptionalValue(index);

    switch (token) {
      case "--dry-run":
      case "--dry_run":
        params.dry_run = true;
        break;
      case "--dry-run-dom":
      case "--dry_run_dom":
        params.dry_run_dom = true;
        break;
      case "--prompt":
        if (value !== undefined) {
          params.prompt = value;
          index += consumed;
        }
        break;
      case "--reference_image":
        if (value !== undefined) {
          params.reference_image = value;
          index += consumed;
        }
        break;
      case "--logo_paths":
        if (value !== undefined) {
          params.logo_paths = parseList(value);
          index += consumed;
        }
        break;
      case "--output_dir":
        if (value !== undefined) {
          params.output_dir = value;
          index += consumed;
        }
        break;
      case "--project_url":
        if (value !== undefined) {
          params.project_url = value;
          index += consumed;
        }
        break;
      case "--browser_path":
        if (value !== undefined) {
          params.browser_path = value;
          index += consumed;
        }
        break;
      case "--cdp_url":
        if (value !== undefined) {
          params.cdp_url = value;
          index += consumed;
        }
        break;
      case "--user_data_dir":
        if (value !== undefined) {
          params.user_data_dir = value;
          index += consumed;
        }
        break;
      case "--profile_name":
        if (value !== undefined) {
          params.profile_name = value;
          index += consumed;
        }
        break;
      case "--timeout_ms":
        if (value !== undefined) {
          params.timeout_ms = value;
          index += consumed;
        }
        break;
      case "--step_timeout_ms":
        if (value !== undefined) {
          params.step_timeout_ms = value;
          index += consumed;
        }
        break;
      case "--download_resolution":
        if (value !== undefined) {
          params.download_resolution = value;
          index += consumed;
        }
        break;
      case "--auto_close_browser":
        params.auto_close_browser = value === undefined ? true : value;
        index += consumed;
        break;
      case "--retry_count":
        if (value !== undefined) {
          params.retry_count = value;
          index += consumed;
        }
        break;
      case "--video_count":
        if (value !== undefined) {
          params.video_count = value;
          index += consumed;
        }
        break;
      case "--generation_mode":
        if (value !== undefined) {
          params.generation_mode = value;
          index += consumed;
        }
        break;
      case "--dom_debug":
        params.dom_debug = value === undefined ? true : value;
        index += consumed;
        break;
      case "--debug_only":
        params.debug_only = value === undefined ? true : value;
        index += consumed;
        break;
      case "--save_step_screenshots":
        params.save_step_screenshots = value === undefined ? true : value;
        index += consumed;
        break;
      case "--fail_fast_on_quota":
        params.fail_fast_on_quota = value === undefined ? true : value;
        index += consumed;
        break;
      case "--per_video_prompt_suffixes":
        if (value !== undefined) {
          params.per_video_prompt_suffixes = parseList(value);
          index += consumed;
        }
        break;
      default:
        break;
    }
  }

  return { ...normalizeInputShape(params), logs };
}

export function normalizeResolutionLabel(text) {
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

export function qualityRank(text) {
  const normalized = normalizeResolutionLabel(text);
  if (normalized === "4k") return 2160;
  if (normalized === "1440p") return 1440;
  if (normalized === "1080p") return 1080;
  if (normalized === "720p") return 720;
  if (normalized === "480p") return 480;
  if (normalized === "360p") return 360;
  if (normalized === "270p") return 270;
  return 0;
}

export function extensionForResolution(resolutionLabel) {
  return resolutionLabel === "270p" ? ".gif" : ".mp4";
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function toSafeBaseName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildVideoFileName(videoIndex, selectedResolution, extension = "") {
  const normalizedResolution = normalizeResolutionLabel(selectedResolution) || "720p";
  const ext = extension || extensionForResolution(normalizedResolution);
  return `veo-video-${String(videoIndex).padStart(3, "0")}-${normalizedResolution}-${nowStamp()}${ext}`;
}

export function buildVideoOutputPath(outputDir, videoIndex, selectedResolution, extension = "") {
  return path.join(outputDir, buildVideoFileName(videoIndex, selectedResolution, extension));
}

export function buildPromptForVideo(basePrompt, videoIndex, videoCount, suffixes = []) {
  const prompt = String(basePrompt || "").trim();
  if (!prompt) return "";

  const explicitSuffix = String(suffixes[videoIndex - 1] || "").trim();
  if (explicitSuffix) {
    return `${prompt}\n\n${explicitSuffix}`;
  }

  if (videoCount <= 1) {
    return prompt;
  }

  return [
    prompt,
    "",
    `Bien the video so ${videoIndex}: giu nguyen san pham, chi thay doi goc camera, anh sang hoac chuyen dong may quay; khong thay doi san pham.`,
  ].join("\n");
}

export function relativeArtifactPath(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

export async function createOutputSessionDir(input) {
  const outputDir = path.resolve(input.output_dir || path.join(process.cwd(), "artifacts", "videos"));
  const sessionDir = path.join(outputDir, "sessions", nowStamp());
  const debugDir = path.join(outputDir, "debug");

  await mkdir(outputDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(debugDir, { recursive: true });

  return { outputDir, sessionDir, debugDir };
}

export function computeFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function buildSummary(videos, requestedVideoCount) {
  const succeeded = videos.filter((video) => video?.status === "success").length;
  const failed = Math.max(0, requestedVideoCount - succeeded);
  return {
    requested: requestedVideoCount,
    succeeded,
    failed,
  };
}

export function dedupeArtifacts(artifacts) {
  const seen = new Set();
  const result = [];

  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") continue;
    const type = String(artifact.type || "").trim();
    const artifactPath = String(artifact.path || "").trim();
    if (!type || !artifactPath) continue;

    const key = `${type}\u001F${artifactPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...artifact, type, path: artifactPath });
  }

  return result;
}

export function buildBatchData({
  input,
  videos,
  partialFailures,
  artifacts,
  primaryVideoPath = null,
  primaryVideoSha256 = null,
  primaryQcStatus = null,
  primaryQcReason = null,
}) {
  const summary = buildSummary(videos, input.video_count);

  return {
    project_url: input.project_url,
    prompt: input.prompt,
    downloaded_video_path: primaryVideoPath,
    used_reference_image: input.reference_image || null,
    used_logo_paths: parseList(input.logo_paths),
    reference_image_sha256:
      input.reference_image && existsSync(input.reference_image)
        ? computeFileSha256(input.reference_image)
        : null,
    video_qc_status: primaryQcStatus,
    video_qc_reason: primaryQcReason,
    requested_video_count: input.video_count,
    succeeded_video_count: summary.succeeded,
    failed_video_count: summary.failed,
    videos,
    partial_failures: partialFailures,
    summary,
    artifacts,
  };
}

export function sanitizeInputForDryRun(input) {
  return {
    ...input,
    prompt_length: String(input.prompt || "").length,
  };
}

export async function retryStep(
  {
    name,
    retries,
    logs,
    onError,
    shouldRetry,
    backoffMs = BACKOFF_DELAYS_MS,
  },
  fn,
) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (typeof onError === "function") {
        await onError(error, attempt);
      }

      const canRetry =
        attempt <= retries &&
        (typeof shouldRetry === "function" ? shouldRetry(error, attempt) : true);

      logs?.push?.(
        `[retry] ${name} attempt ${attempt} failed: ${error.message}${canRetry ? "" : " (final)"}`,
      );

      if (!canRetry) {
        throw error;
      }

      const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? backoffMs.at(-1) ?? 0;
      logs?.push?.(`[retry] ${name} sleeping ${delay}ms before retry ${attempt + 1}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function validateInput(input, { requireAssets = true } = {}) {
  const errors = [];

  if (!String(input.project_url || "").trim()) {
    errors.push("project_url is required");
  }

  if (requireAssets) {
    if (!String(input.reference_image || "").trim()) {
      errors.push("reference_image is required");
    }
    if (!String(input.prompt || "").trim()) {
      errors.push("prompt is required");
    }
  }

  if (!String(input.cdp_url || "").trim() && !String(input.browser_path || "").trim()) {
    errors.push("browser_path is required when cdp_url is not provided");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return input;
}
