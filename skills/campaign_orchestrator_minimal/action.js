import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULTS = {
  browser_path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data",
  profile_name: "Default",
  target_gemini_image_url: "https://gemini.google.com/u/1/app/7e759bcb86865737", // Link chat vẽ ảnh
  target_gemini_video_url: "https://gemini.google.com/u/1/app/2a5b61cc5f1a0e3b", // Link chat làm video
  page_id: "643048852218433",
  access_token: "EAANUeplbZCAwBRO6PjQwIBIMCUkZCQngYX0CsdSmJUS7I34CjTxq4AulnpdhV2D3vGZCmMXTw6qYfdZCE471IEkDVOMZBIdGKKUJHCyCLGQZA0WxhUETLxgpQ0yAKEUogXWxulpo0pXyovxxNBpPOMToLyIEAZCpDiwqFYvaEku1lRuHtfsEG7r706bW7DesPwTTC3sbdiaxlrOKmN2WRDA9IzW",
  retry_count: 1,
  timeout_ms: 120000, // Tăng timeout lên 2 phút vì làm video khá lâu
  dry_run: false,
  allow_text_only_fallback: false,
  facebook_publish_mode: "confirm_only",
  publish_image_post: true,
  publish_video_post: true,
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
        retry_count: Number.isFinite(Number(parsed.retry_count)) ? Number(parsed.retry_count) : params.retry_count,
        timeout_ms: Number.isFinite(Number(parsed.timeout_ms)) ? Number(parsed.timeout_ms) : params.timeout_ms,
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        allow_text_only_fallback: parsed.allow_text_only_fallback === true,
        publish_image_post: parsed.publish_image_post !== false,
        publish_video_post: parsed.publish_video_post !== false,
        facebook_publish_mode: ["confirm_only", "publish_now"].includes(parsed.facebook_publish_mode)
          ? parsed.facebook_publish_mode
          : params.facebook_publish_mode,
        logs,
      };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ...params, logs };
}

function validateInput(params) {
  const missing = [];
  if (typeof params.product_name !== "string" || params.product_name.trim() === "") missing.push("product_name");
  if (typeof params.product_description !== "string" || params.product_description.trim() === "") missing.push("product_description");
  if (typeof params.browser_path !== "string" || params.browser_path.trim() === "") missing.push("browser_path");
  if (typeof params.user_data_dir !== "string" || params.user_data_dir.trim() === "") missing.push("user_data_dir");
  if (typeof params.profile_name !== "string" || params.profile_name.trim() === "") missing.push("profile_name");
  if (typeof params.target_gemini_image_url !== "string" || params.target_gemini_image_url.trim() === "") missing.push("target_gemini_image_url");
  if (typeof params.target_gemini_video_url !== "string" || params.target_gemini_video_url.trim() === "") missing.push("target_gemini_video_url");
  if (typeof params.page_id !== "string" || params.page_id.trim() === "") missing.push("page_id");
  if (typeof params.access_token !== "string" || params.access_token.trim() === "") missing.push("access_token");
  return missing;
}

function parseJsonFromOutput(outputText) {
  const raw = String(outputText || "").trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function runSkillStep({ step, skillName, payload, logs }) {
  const skillPath = path.join(process.cwd(), "skills", skillName, "action.js");
  logs.push(`[step${step}] Running ${skillName}`);

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [skillPath, JSON.stringify(payload)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
        parsed: null,
      });
    });

    child.on("close", (code) => {
      const parsed = parseJsonFromOutput(stdout);
      resolve({ code: code ?? 1, stdout, stderr, parsed });
    });
  });
}

function summarizeStepResult(stepResult) {
  return {
    code: stepResult.code,
    success: Boolean(stepResult.parsed?.success),
    message: stepResult.parsed?.message ?? null,
    stderr: stepResult.stderr || "",
    stdout_preview: String(stepResult.stdout || "").slice(0, 1200),
    error: stepResult.parsed?.error ?? null,
    artifacts: stepResult.parsed?.artifacts ?? [],
    data: stepResult.parsed?.data ?? null,
  };
}

function throwStepFailure(step, skillName, stepResult) {
  const message =
    stepResult.parsed?.error?.details ||
    stepResult.parsed?.message ||
    stepResult.stderr ||
    `Step ${step} (${skillName}) failed with exit code ${stepResult.code}`;
  throw new Error(`[step${step}:${skillName}] ${message}`);
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

function buildMediaSpecificContent(salesContent, productProfile) {
  const captionShort = pickFirstNonEmpty(salesContent?.caption_short);
  const captionLong = pickFirstNonEmpty(salesContent?.caption_long);
  const cta = pickFirstNonEmpty(
    salesContent?.cta,
    `Nhắn tin ngay để nhận tư vấn về ${productProfile.product_name}.`
  );

  const hashtags = Array.isArray(salesContent?.hashtags) ? salesContent.hashtags.join(" ") : "";

  const imageShort = pickFirstNonEmpty(
    salesContent?.caption_image_short,
    `${captionShort} [Hình ảnh sản phẩm]`
  );

  const imageLong = pickFirstNonEmpty(
    salesContent?.caption_image_long,
    `${captionLong}\n\n📸 Hình ảnh sản phẩm giúp bạn xem nhanh thiết kế và điểm nổi bật.\n${cta}${hashtags ? `\n\n${hashtags}` : ""}`
  );

  const videoShort = pickFirstNonEmpty(
    salesContent?.caption_video_short,
    `${captionShort} [Video demo]`
  );

  const videoLong = pickFirstNonEmpty(
    salesContent?.caption_video_long,
    `${captionLong}\n\n🎬 Xem video demo để thấy rõ khả năng vận hành và lợi ích thực tế.\n${cta}${hashtags ? `\n\n${hashtags}` : ""}`
  );

  return {
    image: {
      caption_short: imageShort,
      caption_long: imageLong,
    },
    video: {
      caption_short: videoShort,
      caption_long: videoLong,
    },
  };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] campaign_orchestrator_minimal invoked"];
  const artifacts = [];
  const step_reports = {};

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(buildResult({
      success: false,
      message: "Missing required inputs",
      artifacts,
      logs,
      error: { code: "VALIDATION_ERROR", details: `Missing fields: ${missing.join(", ")}` },
    }));
    process.exit(1);
  }

  const retryCount = Number.isFinite(Number(parsed.retry_count))
    ? Math.max(1, Math.min(4, Math.floor(Number(parsed.retry_count))))
    : DEFAULTS.retry_count;
  const timeoutMs = Number.isFinite(Number(parsed.timeout_ms))
    ? Math.max(30000, Number(parsed.timeout_ms))
    : DEFAULTS.timeout_ms;

  try {
    const step1 = await runSkillStep({
      step: 1,
      skillName: "normalize_product_input",
      payload: {
        product_name: parsed.product_name,
        product_description: parsed.product_description,
        specifications: parsed.specifications,
        selling_points: parsed.selling_points,
      },
      logs,
    });
    step_reports.step1_normalize_product_input = summarizeStepResult(step1);
    if (!step1.parsed?.success) throwStepFailure(1, "normalize_product_input", step1);
    const productProfile = step1.parsed.data?.product_profile;
    if (!productProfile) throw new Error("[step1:normalize_product_input] Missing product_profile in result");
    artifacts.push(...(step1.parsed.artifacts ?? []));

    const step2 = await runSkillStep({
      step: 2,
      skillName: "generate_sales_content",
      payload: { product_profile: productProfile },
      logs,
    });
    step_reports.step2_generate_sales_content = summarizeStepResult(step2);
    if (!step2.parsed?.success) throwStepFailure(2, "generate_sales_content", step2);
    const salesContent = step2.parsed.data;
    if (!salesContent?.caption_long || !salesContent?.caption_short) {
      throw new Error("[step2:generate_sales_content] Missing required captions in result");
    }
    artifacts.push(...(step2.parsed.artifacts ?? []));

    const mediaSpecificContent = buildMediaSpecificContent(salesContent, productProfile);

    const step3 = await runSkillStep({
      step: 3,
      skillName: "gemini_generate_image",
      payload: {
        image_prompt: salesContent.image_prompt,
        browser_path: parsed.browser_path,
        user_data_dir: parsed.user_data_dir,
        profile_name: parsed.profile_name,
        target_gemini_url: parsed.target_gemini_image_url,
        timeout_ms: timeoutMs,
        retry_count: retryCount,
        dry_run: parsed.dry_run,
      },
      logs,
    });
    step_reports.step3_gemini_generate_image = summarizeStepResult(step3);
    if (step3.parsed?.success) artifacts.push(...(step3.parsed.artifacts ?? []));

    const step4 = await runSkillStep({
      step: 4,
      skillName: "generate_video",
      payload: {
        video_prompt: salesContent.video_prompt,
        browser_path: parsed.browser_path,
        user_data_dir: parsed.user_data_dir,
        profile_name: parsed.profile_name,
        target_gemini_url: parsed.target_gemini_video_url,
        timeout_ms: timeoutMs,
        retry_count: retryCount,
        dry_run: parsed.dry_run,
      },
      logs,
    });
    step_reports.step4_generate_video = summarizeStepResult(step4);
    if (step4.parsed?.success) artifacts.push(...(step4.parsed.artifacts ?? []));

    const generatedVideos = artifacts
      .filter((i) => i?.type === "generated_video")
      .map((i) => path.resolve(process.cwd(), i.path).replace(/\\/g, "/"));

    const generatedImages = artifacts
      .filter((i) => i?.type === "generated_image")
      .map((i) => path.resolve(process.cwd(), i.path).replace(/\\/g, "/"));

    const publishResults = [];

    if (parsed.publish_image_post && generatedImages.length > 0) {
      const imagePublishStep = await runSkillStep({
        step: "5A",
        skillName: "facebook_publish_post",
        payload: {
          caption_long: mediaSpecificContent.image.caption_long,
          caption_short: mediaSpecificContent.image.caption_short,
          media_paths: [generatedImages[0]],
          page_id: parsed.page_id,
          access_token: parsed.access_token,
          browser_path: parsed.browser_path,
          user_data_dir: parsed.user_data_dir,
          profile_name: parsed.profile_name,
          target_page_url: parsed.target_page_url,
          publish_mode: parsed.facebook_publish_mode,
          dry_run: parsed.dry_run,
        },
        logs,
      });
      step_reports.step5a_facebook_publish_image = summarizeStepResult(imagePublishStep);
      if (!imagePublishStep.parsed?.success) throwStepFailure("5A", "facebook_publish_post(image)", imagePublishStep);
      artifacts.push(...(imagePublishStep.parsed.artifacts ?? []));
      publishResults.push({
        type: "image",
        media_path: generatedImages[0],
        content_used: mediaSpecificContent.image,
        publish_result: imagePublishStep.parsed.data,
      });
    }

    if (parsed.publish_video_post && generatedVideos.length > 0) {
      const videoPublishStep = await runSkillStep({
        step: "5B",
        skillName: "facebook_publish_post",
        payload: {
          caption_long: mediaSpecificContent.video.caption_long,
          caption_short: mediaSpecificContent.video.caption_short,
          media_paths: [generatedVideos[0]],
          page_id: parsed.page_id,
          access_token: parsed.access_token,
          browser_path: parsed.browser_path,
          user_data_dir: parsed.user_data_dir,
          profile_name: parsed.profile_name,
          target_page_url: parsed.target_page_url,
          publish_mode: parsed.facebook_publish_mode,
          dry_run: parsed.dry_run,
        },
        logs,
      });
      step_reports.step5b_facebook_publish_video = summarizeStepResult(videoPublishStep);
      if (!videoPublishStep.parsed?.success) throwStepFailure("5B", "facebook_publish_post(video)", videoPublishStep);
      artifacts.push(...(videoPublishStep.parsed.artifacts ?? []));
      publishResults.push({
        type: "video",
        media_path: generatedVideos[0],
        content_used: mediaSpecificContent.video,
        publish_result: videoPublishStep.parsed.data,
      });
    }

    if (publishResults.length === 0) {
      if (parsed.allow_text_only_fallback === true) {
        const fallbackCaptionLong = pickFirstNonEmpty(mediaSpecificContent.image.caption_long, salesContent.caption_long);
        const fallbackCaptionShort = pickFirstNonEmpty(mediaSpecificContent.image.caption_short, salesContent.caption_short);

        const fallbackStep = await runSkillStep({
          step: "5T",
          skillName: "facebook_publish_post",
          payload: {
            caption_long: fallbackCaptionLong,
            caption_short: fallbackCaptionShort,
            media_paths: [],
            page_id: parsed.page_id,
            access_token: parsed.access_token,
            browser_path: parsed.browser_path,
            user_data_dir: parsed.user_data_dir,
            profile_name: parsed.profile_name,
            target_page_url: parsed.target_page_url,
            publish_mode: parsed.facebook_publish_mode,
            dry_run: parsed.dry_run,
          },
          logs,
        });
        step_reports.step5t_facebook_publish_text_only = summarizeStepResult(fallbackStep);
        if (!fallbackStep.parsed?.success) throwStepFailure("5T", "facebook_publish_post(text-only)", fallbackStep);
        artifacts.push(...(fallbackStep.parsed.artifacts ?? []));
        publishResults.push({
          type: "text_only_fallback",
          media_path: null,
          content_used: {
            caption_long: fallbackCaptionLong,
            caption_short: fallbackCaptionShort,
          },
          publish_result: fallbackStep.parsed.data,
        });
      } else {
        throw new Error("[step5] No publishable image/video result available and text-only fallback is disabled");
      }
    }

    const summaryPayload = {
      generated_at: new Date().toISOString(),
      product_input: {
        product_name: parsed.product_name,
        product_description: parsed.product_description,
        specifications: parsed.specifications ?? null,
        selling_points: parsed.selling_points ?? null,
      },
      product_profile: productProfile,
      generated_captions: salesContent,
      media_specific_content: mediaSpecificContent,
      media_used: {
        images: generatedImages,
        videos: generatedVideos,
      },
      publish_results: publishResults,
      step_reports,
    };

    const summaryDir = path.join(
      process.cwd(),
      "artifacts",
      "campaigns",
      `${slugify(parsed.product_name)}-${Date.now()}`
    );
    await mkdir(summaryDir, { recursive: true });
    await writeFile(path.join(summaryDir, "summary.json"), JSON.stringify(summaryPayload, null, 2), "utf8");
    artifacts.push({
      type: "summary",
      path: path.relative(process.cwd(), path.join(summaryDir, "summary.json")).replace(/\\/g, "/"),
    });

    printResult(buildResult({
      success: true,
      message:
        parsed.facebook_publish_mode === "publish_now"
          ? "Campaign orchestration completed successfully with separate image/video publishing"
          : "Campaign orchestration completed successfully in safe confirmation mode with separate image/video publishing",
      data: summaryPayload,
      artifacts,
      logs,
      error: null,
    }));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logs.push(`[fail] ${details}`);

    const failureSummary = {
      generated_at: new Date().toISOString(),
      product_name: parsed.product_name ?? null,
      step_reports,
      failure_details: details,
    };

    try {
      const summaryDir = path.join(
        process.cwd(),
        "artifacts",
        "campaigns",
        `${slugify(parsed.product_name || "unknown-product")}-${Date.now()}`
      );
      await mkdir(summaryDir, { recursive: true });
      await writeFile(path.join(summaryDir, "summary.error.json"), JSON.stringify(failureSummary, null, 2), "utf8");
      artifacts.push({
        type: "summary_error",
        path: path.relative(process.cwd(), path.join(summaryDir, "summary.error.json")).replace(/\\/g, "/"),
      });
    } catch {}

    printResult(buildResult({
      success: false,
      message: "Campaign orchestration failed",
      data: { step_reports },
      artifacts,
      logs,
      error: { code: "FLOW_FAILED", details },
    }));
    process.exit(1);
  }
})();
