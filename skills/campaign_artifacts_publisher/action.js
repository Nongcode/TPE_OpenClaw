import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULTS = {
  artifacts_root: "artifacts",
  browser_path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data",
  profile_name: "Default",
  target_gemini_image_url: "https://gemini.google.com/u/1/app/7e759bcb86865737",
  target_gemini_video_url: "https://gemini.google.com/u/1/app/2a5b61cc5f1a0e3b",
  page_id: "643048852218433",
  access_token: "EAANUeplbZCAwBRO6PjQwIBIMCUkZCQngYX0CsdSmJUS7I34CjTxq4AulnpdhV2D3vGZCmMXTw6qYfdZCE471IEkDVOMZBIdGKKUJHCyCLGQZA0WxhUETLxgpQ0yAKEUogXWxulpo0pXyovxxNBpPOMToLyIEAZCpDiwqFYvaEku1lRuHtfsEG7r706bW7DesPwTTC3sbdiaxlrOKmN2WRDA9IzW",
  retry_count: 1,
  timeout_ms: 120000,
  dry_run: false,
  allow_text_only_fallback: false,
  facebook_publish_mode: "confirm_only",
  publish_image_post: true,
  publish_video_post: true,
  include_generated_image_for_video: true,
  include_campaign_images: true,
  image_paths: [],
};

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
        image_paths: parseList(parsed.image_paths),
        retry_count: Number.isFinite(Number(parsed.retry_count)) ? Number(parsed.retry_count) : params.retry_count,
        timeout_ms: Number.isFinite(Number(parsed.timeout_ms)) ? Number(parsed.timeout_ms) : params.timeout_ms,
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        allow_text_only_fallback: parsed.allow_text_only_fallback === true,
        publish_image_post: parsed.publish_image_post !== false,
        publish_video_post: parsed.publish_video_post !== false,
        include_generated_image_for_video: parsed.include_generated_image_for_video !== false,
        include_campaign_images: parsed.include_campaign_images !== false,
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

function validateConfig(params) {
  const missing = [];
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
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        parsed: parseJsonFromOutput(stdout),
      });
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

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function collectFilesRecursive(rootDir, matcher, accumulator = []) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await collectFilesRecursive(fullPath, matcher, accumulator);
      continue;
    }
    if (matcher(fullPath, entry.name)) {
      accumulator.push(fullPath);
    }
  }
  return accumulator;
}

async function pickLatestFile(paths) {
  const enriched = [];
  for (const filePath of paths) {
    try {
      const info = await stat(filePath);
      enriched.push({ filePath, mtimeMs: info.mtimeMs });
    } catch {}
  }
  enriched.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return enriched[0]?.filePath ?? null;
}

function normalizeProductProfile(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.product_profile && typeof candidate.product_profile === "object") {
    return candidate.product_profile;
  }
  if (candidate.product_name && candidate.product_description) {
    return candidate;
  }
  return null;
}

function normalizeSalesContent(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.generated_captions && typeof candidate.generated_captions === "object") {
    return candidate.generated_captions;
  }
  if (candidate.sales_content && typeof candidate.sales_content === "object") {
    return candidate.sales_content;
  }
  if (candidate.caption_long || candidate.caption_short || candidate.image_prompt || candidate.video_prompt) {
    return candidate;
  }
  return null;
}

async function resolveLatestCampaignSummary(artifactsRoot) {
  const campaignsDir = path.join(process.cwd(), artifactsRoot, "campaigns");
  if (!(await fileExists(campaignsDir))) return null;
  const candidates = await collectFilesRecursive(campaignsDir, (fullPath, name) => name === "summary.json");
  return await pickLatestFile(candidates);
}

async function resolveLatestContentArtifact(artifactsRoot) {
  const contentDir = path.join(process.cwd(), artifactsRoot, "content");
  if (!(await fileExists(contentDir))) return null;
  const candidates = await collectFilesRecursive(contentDir, (fullPath) => fullPath.endsWith(".json"));
  return await pickLatestFile(candidates);
}

async function resolveLatestProductArtifact(artifactsRoot) {
  const productsDir = path.join(process.cwd(), artifactsRoot, "products");
  if (!(await fileExists(productsDir))) return null;
  const candidates = await collectFilesRecursive(productsDir, (fullPath) => fullPath.endsWith(".json"));
  return await pickLatestFile(candidates);
}

function uniqueNormalizedPaths(paths) {
  return [...new Set(paths.map((item) => path.normalize(item)).filter(Boolean))];
}

async function collectCampaignReferenceImages(campaignDir) {
  if (!campaignDir || !(await fileExists(campaignDir))) return [];
  const candidates = await collectFilesRecursive(
    campaignDir,
    (fullPath, name) =>
      /\.(png|jpg|jpeg|webp)$/i.test(name) &&
      !/(gemini|facebook|screenshot|before-|after-|poster)/i.test(fullPath)
  );
  return candidates;
}

function buildImagePrompt(basePrompt, productProfile, referenceImages) {
  if (referenceImages.length === 0) return String(basePrompt || "").trim();
  return [
    String(basePrompt || "").trim(),
    `Bat buoc bam sat cac anh tham chieu da upload de giu dung hinh dang, mau sac, bo cuc va chi tiet that cua san pham ${productProfile.product_name}.`,
    "Khong thay doi thanh san pham khac, khong hallucinate logo/chi tiet ky thuat ngoai anh goc.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildVideoPrompt(basePrompt, productProfile, referenceImages, generatedImages) {
  const extraNotes = [];
  if (referenceImages.length > 0) {
    extraNotes.push(
      `Bat buoc dung cac anh tham chieu da upload lam source-of-truth cho ngoai quan san pham ${productProfile.product_name}.`
    );
  }
  if (generatedImages.length > 0) {
    extraNotes.push("Neu co anh key visual da tao, dung no lam tham chieu bo cuc/chien dich cho video.");
  }
  extraNotes.push("Khong tao chi tiet ngoai quan sai khac so voi anh goc.");
  return [String(basePrompt || "").trim(), ...extraNotes].filter(Boolean).join(" ");
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
    `Nhan tin ngay de nhan tu van ve ${productProfile.product_name}.`
  );

  const hashtags = Array.isArray(salesContent?.hashtags) ? salesContent.hashtags.join(" ") : "";

  return {
    image: {
      caption_short: pickFirstNonEmpty(salesContent?.caption_image_short, `${captionShort} [Hinh anh san pham]`),
      caption_long: pickFirstNonEmpty(
        salesContent?.caption_image_long,
        `${captionLong}\n\nHinh anh san pham thuc te giup khach hang nhin ro ngoai quan va diem noi bat.\n${cta}${hashtags ? `\n\n${hashtags}` : ""}`
      ),
    },
    video: {
      caption_short: pickFirstNonEmpty(salesContent?.caption_video_short, `${captionShort} [Video demo]`),
      caption_long: pickFirstNonEmpty(
        salesContent?.caption_video_long,
        `${captionLong}\n\nXem video demo de thay ro cach van hanh va loi ich thuc te.\n${cta}${hashtags ? `\n\n${hashtags}` : ""}`
      ),
    },
  };
}

async function resolveSourceBundle(parsed, logs) {
  const artifactsRoot = parsed.artifacts_root;
  let campaignSummaryPath = parsed.campaign_summary_path ? path.resolve(process.cwd(), parsed.campaign_summary_path) : null;
  let campaignDir = parsed.campaign_dir ? path.resolve(process.cwd(), parsed.campaign_dir) : null;
  let contentArtifactPath = parsed.content_artifact_path ? path.resolve(process.cwd(), parsed.content_artifact_path) : null;
  let productArtifactPath = parsed.product_artifact_path ? path.resolve(process.cwd(), parsed.product_artifact_path) : null;

  if (!campaignSummaryPath && campaignDir) {
    const candidate = path.join(campaignDir, "summary.json");
    if (await fileExists(candidate)) campaignSummaryPath = candidate;
  }

  if (!campaignSummaryPath) {
    campaignSummaryPath = await resolveLatestCampaignSummary(artifactsRoot);
  }

  let productProfile = null;
  let salesContent = null;
  const sourceArtifacts = {
    campaign_summary_path: campaignSummaryPath ? path.relative(process.cwd(), campaignSummaryPath).replace(/\\/g, "/") : null,
    content_artifact_path: null,
    product_artifact_path: null,
  };

  if (campaignSummaryPath && (await fileExists(campaignSummaryPath))) {
    const summary = await readJsonFile(campaignSummaryPath);
    productProfile = normalizeProductProfile(summary.product_profile ?? summary.productProfile);
    salesContent = normalizeSalesContent(summary.generated_captions ?? summary.sales_content ?? summary);
    campaignDir = path.dirname(campaignSummaryPath);
    logs.push(`[source] Loaded campaign summary: ${sourceArtifacts.campaign_summary_path}`);
  }

  if (!contentArtifactPath && !salesContent) {
    contentArtifactPath = await resolveLatestContentArtifact(artifactsRoot);
  }
  if (contentArtifactPath && (await fileExists(contentArtifactPath))) {
    const contentArtifact = await readJsonFile(contentArtifactPath);
    salesContent = salesContent ?? normalizeSalesContent(contentArtifact.sales_content ?? contentArtifact);
    productProfile = productProfile ?? normalizeProductProfile(contentArtifact.product_profile);
    sourceArtifacts.content_artifact_path = path.relative(process.cwd(), contentArtifactPath).replace(/\\/g, "/");
    logs.push(`[source] Loaded content artifact: ${sourceArtifacts.content_artifact_path}`);
  }

  if (!productArtifactPath && !productProfile) {
    productArtifactPath = await resolveLatestProductArtifact(artifactsRoot);
  }
  if (productArtifactPath && (await fileExists(productArtifactPath))) {
    const productArtifact = await readJsonFile(productArtifactPath);
    productProfile = productProfile ?? normalizeProductProfile(productArtifact);
    sourceArtifacts.product_artifact_path = path.relative(process.cwd(), productArtifactPath).replace(/\\/g, "/");
    logs.push(`[source] Loaded product artifact: ${sourceArtifacts.product_artifact_path}`);
  }

  return { productProfile, salesContent, sourceArtifacts, campaignDir };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] campaign_artifacts_publisher invoked"];
  const artifacts = [];
  const step_reports = {};

  const missingConfig = validateConfig(parsed);
  if (missingConfig.length > 0) {
    printResult(buildResult({
      success: false,
      message: "Missing required configuration",
      artifacts,
      logs,
      error: { code: "VALIDATION_ERROR", details: `Missing fields: ${missingConfig.join(", ")}` },
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
    let { productProfile, salesContent, sourceArtifacts, campaignDir } = await resolveSourceBundle(parsed, logs);

    if (!productProfile && parsed.product_name && parsed.product_description) {
      const step1 = await runSkillStep({
        step: 1,
        skillName: "normalize_product_input",
        payload: {
          product_name: parsed.product_name,
          product_description: parsed.product_description,
          specifications: parsed.specifications,
          selling_points: parsed.selling_points,
          image_paths: parsed.image_paths,
        },
        logs,
      });
      step_reports.step1_normalize_product_input = summarizeStepResult(step1);
      if (!step1.parsed?.success) throwStepFailure(1, "normalize_product_input", step1);
      productProfile = step1.parsed.data?.product_profile;
      artifacts.push(...(step1.parsed.artifacts ?? []));
      sourceArtifacts.product_artifact_path = step1.parsed.artifacts?.[0]?.path ?? sourceArtifacts.product_artifact_path;
    }

    if (!productProfile) {
      throw new Error("No usable product profile found in artifacts or input");
    }

    if (!salesContent) {
      const step2 = await runSkillStep({
        step: 2,
        skillName: "generate_sales_content",
        payload: { product_profile: productProfile },
        logs,
      });
      step_reports.step2_generate_sales_content = summarizeStepResult(step2);
      if (!step2.parsed?.success) throwStepFailure(2, "generate_sales_content", step2);
      salesContent = step2.parsed.data;
      artifacts.push(...(step2.parsed.artifacts ?? []));
      sourceArtifacts.content_artifact_path = step2.parsed.artifacts?.[0]?.path ?? sourceArtifacts.content_artifact_path;
    }

    if (!salesContent?.caption_long || !salesContent?.caption_short || !salesContent?.image_prompt || !salesContent?.video_prompt) {
      throw new Error("Sales content is incomplete: missing caption or media prompts");
    }

    const explicitImagePaths = parseList(parsed.image_paths).map((item) => path.resolve(process.cwd(), item));
    const productImagePaths = parseList(productProfile.image_paths).map((item) =>
      path.isAbsolute(item) ? path.normalize(item) : path.resolve(process.cwd(), item)
    );
    const campaignImagePaths = parsed.include_campaign_images ? await collectCampaignReferenceImages(campaignDir) : [];
    const referenceImages = uniqueNormalizedPaths([...explicitImagePaths, ...productImagePaths, ...campaignImagePaths]);

    if (referenceImages.length > 0) {
      for (const imagePath of referenceImages) {
        await access(imagePath);
      }
    }
    logs.push(`[source] reference_images=${referenceImages.length}`);

    const mediaSpecificContent = buildMediaSpecificContent(salesContent, productProfile);
    const imagePrompt = buildImagePrompt(salesContent.image_prompt, productProfile, referenceImages);

    const step3 = await runSkillStep({
      step: 3,
      skillName: "gemini_generate_image",
      payload: {
        image_prompt: imagePrompt,
        image_paths: referenceImages,
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
    if (!step3.parsed?.success) throwStepFailure(3, "gemini_generate_image", step3);
    artifacts.push(...(step3.parsed.artifacts ?? []));

    const generatedImages = (step3.parsed.artifacts ?? [])
      .filter((item) => item?.type === "generated_image")
      .map((item) => path.resolve(process.cwd(), item.path));

    const videoReferenceImages = uniqueNormalizedPaths([
      ...referenceImages,
      ...(parsed.include_generated_image_for_video ? generatedImages : []),
    ]);
    const videoPrompt = buildVideoPrompt(salesContent.video_prompt, productProfile, referenceImages, generatedImages);

    const step4 = await runSkillStep({
      step: 4,
      skillName: "generate_video",
      payload: {
        video_prompt: videoPrompt,
        image_paths: videoReferenceImages,
        browser_path: parsed.browser_path,
        user_data_dir: parsed.user_data_dir,
        profile_name: parsed.profile_name,
        target_gemini_url: parsed.target_gemini_video_url,
        timeout_ms: Math.max(timeoutMs, 240000),
        retry_count: retryCount,
        dry_run: parsed.dry_run,
      },
      logs,
    });
    step_reports.step4_generate_video = summarizeStepResult(step4);
    if (!step4.parsed?.success) throwStepFailure(4, "generate_video", step4);
    artifacts.push(...(step4.parsed.artifacts ?? []));

    const generatedVideos = (step4.parsed.artifacts ?? [])
      .filter((item) => item?.type === "generated_video" || item?.type === "generated_video_fallback")
      .map((item) => path.resolve(process.cwd(), item.path));

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
        media_path: path.relative(process.cwd(), generatedImages[0]).replace(/\\/g, "/"),
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
        media_path: path.relative(process.cwd(), generatedVideos[0]).replace(/\\/g, "/"),
        content_used: mediaSpecificContent.video,
        publish_result: videoPublishStep.parsed.data,
      });
    }

    if (parsed.dry_run && publishResults.length === 0) {
      if (parsed.publish_image_post) {
        publishResults.push({
          type: "image_dry_run_skipped",
          media_path: null,
          content_used: mediaSpecificContent.image,
          publish_result: { dry_run: true, skipped_reason: "No generated media persisted in dry_run mode" },
        });
      }
      if (parsed.publish_video_post) {
        publishResults.push({
          type: "video_dry_run_skipped",
          media_path: null,
          content_used: mediaSpecificContent.video,
          publish_result: { dry_run: true, skipped_reason: "No generated media persisted in dry_run mode" },
        });
      }
    }

    if (publishResults.length === 0) {
      if (parsed.allow_text_only_fallback === true) {
        const fallbackStep = await runSkillStep({
          step: "5T",
          skillName: "facebook_publish_post",
          payload: {
            caption_long: mediaSpecificContent.image.caption_long,
            caption_short: mediaSpecificContent.image.caption_short,
            media_paths: [],
            page_id: parsed.page_id,
            access_token: parsed.access_token,
            publish_mode: parsed.facebook_publish_mode,
            dry_run: parsed.dry_run,
          },
          logs,
        });
        step_reports.step5t_facebook_publish_text_only = summarizeStepResult(fallbackStep);
        if (!fallbackStep.parsed?.success) throwStepFailure("5T", "facebook_publish_post(text-only)", fallbackStep);
        publishResults.push({
          type: "text_only_fallback",
          media_path: null,
          content_used: mediaSpecificContent.image,
          publish_result: fallbackStep.parsed.data,
        });
      } else {
        throw new Error("No publishable image/video result available and text-only fallback is disabled");
      }
    }

    const summaryPayload = {
      generated_at: new Date().toISOString(),
      source_artifacts: sourceArtifacts,
      source_campaign_dir: campaignDir ? path.relative(process.cwd(), campaignDir).replace(/\\/g, "/") : null,
      product_profile: productProfile,
      sales_content: salesContent,
      prompts_used: {
        image_prompt: imagePrompt,
        video_prompt: videoPrompt,
      },
      reference_images_used: referenceImages.map((item) => path.relative(process.cwd(), item).replace(/\\/g, "/")),
      video_reference_images_used: videoReferenceImages.map((item) => path.relative(process.cwd(), item).replace(/\\/g, "/")),
      media_used: {
        images: generatedImages.map((item) => path.relative(process.cwd(), item).replace(/\\/g, "/")),
        videos: generatedVideos.map((item) => path.relative(process.cwd(), item).replace(/\\/g, "/")),
      },
      publish_results: publishResults,
      step_reports,
    };

    const summaryDir = path.join(
      process.cwd(),
      parsed.artifacts_root,
      "campaigns",
      `${slugify(productProfile.product_name)}-artifact-publisher-${Date.now()}`
    );
    await mkdir(summaryDir, { recursive: true });
    const summaryPath = path.join(summaryDir, "summary.json");
    await writeFile(summaryPath, JSON.stringify(summaryPayload, null, 2), "utf8");
    artifacts.push({
      type: "summary",
      path: path.relative(process.cwd(), summaryPath).replace(/\\/g, "/"),
    });

    printResult(buildResult({
      success: true,
      message:
        parsed.facebook_publish_mode === "publish_now"
          ? "Artifact-driven campaign publishing completed successfully"
          : "Artifact-driven campaign publishing completed successfully in confirmation mode",
      data: summaryPayload,
      artifacts,
      logs,
      error: null,
    }));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    logs.push(`[fail] ${details}`);
    printResult(buildResult({
      success: false,
      message: "Artifact-driven campaign publishing failed",
      data: { step_reports },
      artifacts,
      logs,
      error: { code: "FLOW_FAILED", details },
    }));
    process.exit(1);
  }
})();
