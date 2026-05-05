import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULTS,
  buildBatchData,
  normalizeResolutionLabel,
  parseArgs,
  retryStep,
} from "./core.js";

const actionSource = fs.readFileSync(new URL("./action.js", import.meta.url), "utf8");

test("parseArgs reads video_count and new batch flags from input file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veo-parse-"));
  const inputPath = path.join(tempDir, "input.json");
  fs.writeFileSync(
    inputPath,
    JSON.stringify({
      project_url: "https://labs.google/fx/vi/tools/flow/project/test",
      prompt: "Prompt",
      reference_image: "ref.png",
      video_count: 4,
      generation_mode: "parallel_safe",
      retry_count: 5,
      step_timeout_ms: 222000,
      dom_debug: false,
      save_step_screenshots: false,
      fail_fast_on_quota: false,
      per_video_prompt_suffixes: ["a", "b"],
    }),
  );

  const parsed = parseArgs(["node", "action.js", "--input_file", inputPath]);
  assert.equal(parsed.video_count, 4);
  assert.equal(parsed.generation_mode, "parallel_safe");
  assert.equal(parsed.retry_count, 5);
  assert.equal(parsed.step_timeout_ms, 222000);
  assert.equal(parsed.dom_debug, false);
  assert.equal(parsed.save_step_screenshots, false);
  assert.equal(parsed.fail_fast_on_quota, false);
  assert.deepEqual(parsed.per_video_prompt_suffixes, ["a", "b"]);
});

test("parseArgs keeps safe defaults and dry-run-dom forces debug mode", () => {
  const parsed = parseArgs(["node", "action.js", "--dry-run-dom"]);
  assert.equal(parsed.video_count, DEFAULTS.video_count);
  assert.equal(parsed.generation_mode, DEFAULTS.generation_mode);
  assert.equal(parsed.retry_count, DEFAULTS.retry_count);
  assert.equal(parsed.step_timeout_ms, DEFAULTS.step_timeout_ms);
  assert.equal(parsed.dom_debug, true);
  assert.equal(parsed.debug_only, true);
  assert.equal(parsed.download_resolution, "720p");
});

test("normalizeResolutionLabel normalizes common variants", () => {
  assert.equal(normalizeResolutionLabel("Download 720p"), "720p");
  assert.equal(normalizeResolutionLabel("1080P"), "1080p");
  assert.equal(normalizeResolutionLabel("Ultra 4K"), "4k");
  assert.equal(normalizeResolutionLabel("unknown"), "");
});

test("buildBatchData keeps compatibility fields and summary counts", () => {
  const data = buildBatchData({
    input: {
      project_url: "https://labs.google/fx/vi/tools/flow/project/test",
      prompt: "Prompt",
      reference_image: "",
      logo_paths: ["logo.png"],
      video_count: 2,
    },
    videos: [
      {
        index: 1,
        status: "success",
        path: "artifacts/videos/video-1.mp4",
        sha256: "abc",
        qc_status: "PASS",
        qc_reason: "ok",
      },
      {
        index: 2,
        status: "failed",
        path: null,
        sha256: null,
        qc_status: "FAIL",
        qc_reason: "bad",
      },
    ],
    partialFailures: [{ index: 2, error: "bad" }],
    artifacts: [{ type: "generated_video", path: "artifacts/videos/video-1.mp4" }],
    primaryVideoPath: "artifacts/videos/video-1.mp4",
    primaryQcStatus: "PASS",
    primaryQcReason: "ok",
  });

  assert.equal(data.downloaded_video_path, "artifacts/videos/video-1.mp4");
  assert.equal(data.requested_video_count, 2);
  assert.equal(data.succeeded_video_count, 1);
  assert.equal(data.failed_video_count, 1);
  assert.equal(data.summary.requested, 2);
  assert.equal(data.summary.succeeded, 1);
  assert.equal(data.summary.failed, 1);
  assert.equal(data.videos.length, 2);
  assert.equal(data.partial_failures.length, 1);
});

test("retryStep retries and eventually succeeds", async () => {
  const logs = [];
  let attempts = 0;

  const result = await retryStep(
    {
      name: "retry-unit",
      retries: 2,
      logs,
      backoffMs: [1, 1, 1],
    },
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`boom-${attempts}`);
      }
      return "ok";
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.match(logs.join("\n"), /retry-unit attempt 1 failed/);
  assert.match(logs.join("\n"), /retry-unit attempt 2 failed/);
});

test("action QC rejects image or HTML payloads saved as video files", () => {
  assert.match(actionSource, /MIN_GENERATED_VIDEO_BYTES = 64 \* 1024/);
  assert.match(actionSource, /looksLikeImagePayload/);
  assert.match(actionSource, /looksLikeHtmlPayload/);
  assert.match(actionSource, /payload tai ve la anh, khong phai video/);
  assert.match(actionSource, /payload tai ve la HTML\/error page/);
});

test("action locks the browser profile before launching or attaching to Flow", () => {
  assert.match(actionSource, /withBrowserProfileLock/);
  assert.match(actionSource, /browserPath: browser_path/);
  assert.match(actionSource, /userDataDir: user_data_dir/);
  assert.match(actionSource, /profileName: profile_name/);
  assert.match(actionSource, /cdpUrl: cdp_url/);
});

test("action waits for the tracked video progress card before accepting a source", () => {
  assert.match(actionSource, /collectGenerationProgressRegions/);
  assert.match(actionSource, /trackedProgressRegion/);
  assert.match(actionSource, /videoRecordOverlapsRegion/);
  assert.match(actionSource, /VIDEO_PROGRESS_SETTLE_MS/);
  assert.match(actionSource, /FALLBACK_FRESH_VIDEO_DELAY_MS/);
  assert.match(actionSource, /PASS new generated video source is stable/);
});

test("action downloads from the exact generated card before refusing arbitrary old videos", () => {
  assert.match(actionSource, /findVideoCardBySource/);
  assert.match(actionSource, /tryDownloadExpectedVideoBySourceCard/);
  assert.match(actionSource, /Download flow via the exact generated video card/);
  assert.match(actionSource, /Skipping arbitrary latest-card\/source fallback/);
  assert.match(actionSource, /exact generated card download failed to avoid returning an old video/);
});
