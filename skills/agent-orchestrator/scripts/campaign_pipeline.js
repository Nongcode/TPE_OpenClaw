const { access, copyFile, mkdir, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  buildPublishTextFromSections,
  extractContentSections,
  stripMarkdownFormatting,
} = require("./content_cleanup");
const { normalizeText } = require("./common");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const DEFAULT_MEDIA_CONFIG = {
  browser_path: "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  user_data_dir: "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  profile_name: "Default",
  target_gemini_image_url: "https://gemini.google.com/app/3f383fca1153c26a",
  target_gemini_video_url: "https://gemini.google.com/app",
  page_id: "643048852218433",
  access_token:
    "EAANUeplbZCAwBRDtmbZCZAXJH6xt1Wavxe0OiZAbIBV2nFwFZApZC6GsP0nKXO1BrMBoBaDUZBMpOjCOZAyUL9zC2iQh9spFumXC2KcT1THFvZCBjLeONUfyw4R7a0ZCn3bZAqNRglxjrh3GOVtZCIObHg3ArMqfOZC7RIJo6rvSn2FszW45e4KZCXfSAwddj5WRXmpnotnmoMzDwf1N6Myc6bb6py",
  timeout_ms: 420000,
};

function parseJsonFromOutput(outputText) {
  const raw = String(outputText || "").trim();
  if (!raw) {
    return null;
  }

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

function toRepoRelative(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, "/");
}

function splitLines(value) {
  return String(value || "")
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugifySegment(value) {
  return String(value || "campaign")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueNormalizedPaths(paths) {
  return [...new Set(paths.map((item) => path.normalize(item)).filter(Boolean))];
}

async function collectValidReferenceImages(productResearchData, limit = 1) {
  const orderedCandidates = [
    productResearchData?.primary_image?.file_path,
    ...(Array.isArray(productResearchData?.images)
      ? productResearchData.images.map((item) => item?.file_path)
      : []),
  ];
  const uniqueCandidates = uniqueNormalizedPaths(orderedCandidates);
  const validPaths = [];

  for (const candidatePath of uniqueCandidates) {
    try {
      await access(candidatePath);
      const fileStat = await stat(candidatePath);
      if (!fileStat.isFile() || fileStat.size <= 0) {
        continue;
      }
      validPaths.push(candidatePath);
      if (validPaths.length >= limit) {
        break;
      }
    } catch {}
  }

  return validPaths;
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function deriveShortCaption(text, fallback) {
  const seed = pickFirstNonEmpty(text, fallback);
  if (!seed) {
    return "";
  }
  return seed.replace(/\s+/g, " ").trim().slice(0, 180);
}

function sanitizeShortCaption(value) {
  return stripMarkdownFormatting(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHashtagLine(value) {
  const blocked = new Set(["xuat", "hang", "saleonline", "chotdonnhanh"]);
  const tags = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
  return tags
    .filter((tag) => tag.startsWith("#"))
    .filter((tag) => !blocked.has(normalizeText(tag).replace(/^#/, "")))
    .join(" ");
}

function ensureProductKeywordInLead(lead, productName) {
  const cleanLead = sanitizeShortCaption(lead);
  const cleanProductName = sanitizeShortCaption(productName);
  if (!cleanLead) {
    return cleanProductName;
  }
  if (!cleanProductName) {
    return cleanLead;
  }
  return normalizeText(cleanLead).includes(normalizeText(cleanProductName))
    ? cleanLead
    : `${cleanProductName} - ${cleanLead}`;
}

function buildSeoContentSections(finalContent, salesContent, productProfile) {
  const finalSections = extractContentSections(finalContent);
  const salesSections = {
    hook: sanitizeShortCaption(pickFirstNonEmpty(salesContent?.caption_short)),
    body: buildPublishTextFromSections(extractContentSections(salesContent?.caption_long)),
    cta: sanitizeShortCaption(
      pickFirstNonEmpty(
        salesContent?.cta,
        `Lien he Tan Phat ETEK de duoc tu van ${productProfile.product_name} phu hop voi gara/xuong cua ban.`,
      ),
    ),
    hashtags: sanitizeHashtagLine(salesContent?.hashtags),
  };

  return {
    hook: ensureProductKeywordInLead(
      pickFirstNonEmpty(finalSections.hook, salesSections.hook),
      productProfile.product_name,
    ),
    body: pickFirstNonEmpty(finalSections.body, salesSections.body, productProfile.product_name),
    cta: pickFirstNonEmpty(finalSections.cta, salesSections.cta),
    hashtags: pickFirstNonEmpty(sanitizeHashtagLine(finalSections.hashtags), salesSections.hashtags),
  };
}

function buildSeoLongCaption(primaryText, fallbackSections) {
  const primarySections = extractContentSections(primaryText);
  return buildPublishTextFromSections({
    hook: pickFirstNonEmpty(primarySections.hook, fallbackSections.hook),
    body: pickFirstNonEmpty(primarySections.body, fallbackSections.body),
    cta: pickFirstNonEmpty(primarySections.cta, fallbackSections.cta),
    hashtags: pickFirstNonEmpty(primarySections.hashtags, fallbackSections.hashtags),
  });
}

function resolveMediaConfig(options = {}) {
  return {
    browser_path: options.browserPath || DEFAULT_MEDIA_CONFIG.browser_path,
    user_data_dir: options.userDataDir || DEFAULT_MEDIA_CONFIG.user_data_dir,
    profile_name: options.profileName || DEFAULT_MEDIA_CONFIG.profile_name,
    target_gemini_image_url:
      options.targetGeminiImageUrl || DEFAULT_MEDIA_CONFIG.target_gemini_image_url,
    target_gemini_video_url:
      options.targetGeminiVideoUrl || DEFAULT_MEDIA_CONFIG.target_gemini_video_url,
    page_id: options.pageId || DEFAULT_MEDIA_CONFIG.page_id,
    access_token: options.accessToken || DEFAULT_MEDIA_CONFIG.access_token,
    retry_count:
      Number.isFinite(Number(options.retryCount)) && Number(options.retryCount) > 0
        ? Number(options.retryCount)
        : 1,
    timeout_ms:
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) >= 30000
        ? Number(options.timeoutMs)
        : DEFAULT_MEDIA_CONFIG.timeout_ms,
    dry_run: options.dryRun === true,
  };
}

async function runSkillStep({ step, skillName, payload, logs }) {
  const skillPath = path.join(REPO_ROOT, "skills", skillName, "action.js");
  logs.push(`[step${step}] Running ${skillName}`);

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [skillPath, JSON.stringify(payload)], {
      cwd: REPO_ROOT,
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

function buildProductProfileInput(productResearchData) {
  const specifications = Array.isArray(productResearchData?.specifications)
    ? productResearchData.specifications
        .map((entry) => {
          const name = String(entry?.name || "").trim();
          const value = String(entry?.value || "").trim();
          return name && value ? `${name}: ${value}` : "";
        })
        .filter(Boolean)
    : splitLines(productResearchData?.specifications_text);

  const image_paths = Array.isArray(productResearchData?.images)
    ? productResearchData.images.map((item) => item?.file_path).filter(Boolean)
    : [];

  return {
    product_name: String(productResearchData?.product_name || "").trim(),
    product_description: pickFirstNonEmpty(
      productResearchData?.long_description,
      productResearchData?.meta_description,
      productResearchData?.specifications_text,
      productResearchData?.product_name,
    ),
    specifications,
    selling_points: [],
    image_paths,
  };
}

function buildImagePrompt(basePrompt, productProfile, referenceImages) {
  const baseLines = [];
  if (pickFirstNonEmpty(basePrompt)) {
    baseLines.push(pickFirstNonEmpty(basePrompt));
  }
  if (referenceImages.length === 0) {
    return [
      ...baseLines,
      `Tạo ảnh quảng cáo bằng tiếng Việt cho sản phẩm ${productProfile.product_name}.`,
      "Bố cục rõ ràng, sạch sẽ, chuyên nghiệp, phù hợp đăng Facebook.",
      'Bắt buộc đặt logo "TÂN PHÁT ETEK" ở góc trái bên trên hình.',
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    ...baseLines,
    `Tạo ảnh quảng cáo bằng tiếng Việt cho sản phẩm ${productProfile.product_name} dựa trên ảnh tham chiếu gốc đã upload.`,
    "Bối cảnh rửa xe/bảo dưỡng chuyên nghiệp, sạch sẽ, ánh sáng rõ, phù hợp bài đăng Facebook.",
    "Giữ đúng hình dáng, màu sắc và chi tiết thật của sản phẩm từ ảnh gốc.",
    'Bắt buộc đặt logo "TÂN PHÁT ETEK" ở góc trái bên trên hình.',
    "Không chèn chữ quảng cáo khác ngoài logo.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildVideoPrompt(basePrompt, productProfile, referenceImages, generatedImages) {
  const baseLines = [];
  if (pickFirstNonEmpty(basePrompt)) {
    baseLines.push(pickFirstNonEmpty(basePrompt));
  }
  const notes = [];
  if (referenceImages.length > 0) {
    notes.push(
      `Bắt buộc dùng các ảnh tham chiếu đã upload làm nguồn đúng cho ngoại quan sản phẩm ${productProfile.product_name}.`,
    );
  }
  if (generatedImages.length > 0) {
    notes.push("Nếu có ảnh key visual đã tạo, dùng nó làm tham chiếu bố cục cho video.");
  }
  notes.push("Video quảng cáo ngắn 15-20 giây, nhịp nhanh, bối cảnh rửa xe/bảo dưỡng sạch sẽ, chuyên nghiệp.");
  notes.push("Không tạo chi tiết ngoại quan sai khác so với ảnh gốc.");
  notes.push('Bắt buộc logo "TÂN PHÁT ETEK" xuất hiện ở góc trái bên trên xuyên suốt video hoặc ở mọi cảnh chính.');
  notes.push("Ưu tiên prompt tiếng Việt, mô tả rõ chuyển động máy, xe buýt và không gian làm việc.");
  return [...baseLines, `Tạo video quảng cáo ngắn bằng tiếng Việt cho ${productProfile.product_name}.`, ...notes]
    .filter(Boolean)
    .join(" ");
}

function buildMediaSpecificContent(finalContent, salesContent, productProfile) {
  const seoSections = buildSeoContentSections(finalContent, salesContent, productProfile);
  const baseLong = buildPublishTextFromSections(seoSections);
  const leadShort = sanitizeShortCaption(
    pickFirstNonEmpty(
      seoSections.hook,
      salesContent?.caption_short,
      deriveShortCaption(baseLong, productProfile.product_name),
    ),
  );
  const bodyNormalized = normalizeText(seoSections.body);
  const leadForLong =
    leadShort && bodyNormalized && bodyNormalized.startsWith(normalizeText(leadShort)) ? "" : leadShort;
  const imageShort = pickFirstNonEmpty(
    sanitizeShortCaption(salesContent?.caption_image_short),
    leadShort,
    sanitizeShortCaption(deriveShortCaption(baseLong, productProfile.product_name)),
  );
  const videoShort = pickFirstNonEmpty(
    sanitizeShortCaption(salesContent?.caption_video_short),
    sanitizeShortCaption(
      `${deriveShortCaption(baseLong, salesContent?.caption_short || productProfile.product_name)} Video demo`,
    ),
  );

  return {
    image: {
      caption_short: imageShort,
      caption_long: buildSeoLongCaption(
        salesContent?.caption_image_long,
        {
          ...seoSections,
          hook: pickFirstNonEmpty(leadForLong, seoSections.hook),
        },
      ),
    },
    video: {
      caption_short: videoShort,
      caption_long: buildSeoLongCaption(
        salesContent?.caption_video_long,
        {
          ...seoSections,
          hook: pickFirstNonEmpty(leadForLong, seoSections.hook),
        },
      ),
    },
  };
}

function isQuotaExceededStepResult(stepResult) {
  const code = String(stepResult?.parsed?.error?.code || "").trim().toUpperCase();
  if (code === "QUOTA_EXCEEDED") {
    return true;
  }

  const details = [
    stepResult?.parsed?.message,
    stepResult?.parsed?.error?.details,
    stepResult?.stderr,
  ]
    .map((item) => String(item || "").toLowerCase())
    .join("\n");

  return (
    details.includes("quota") ||
    details.includes("daily limit") ||
    details.includes("gioi han") ||
    details.includes("ngay mai") ||
    details.includes("tomorrow") ||
    details.includes("3 video") ||
    details.includes("hết lượt") ||
    details.includes("veo")
  );
}

async function materializeMediaBundle(workflowState, generatedImages, generatedVideos) {
  const productName =
    workflowState?.productProfile?.product_name ||
    workflowState?.productResearch?.data?.product_name ||
    "campaign";
  const bundleDir = path.join(
    REPO_ROOT,
    "artifacts",
    "campaign-media",
    `${slugifySegment(productName)}-${Date.now()}`,
  );
  await mkdir(bundleDir, { recursive: true });

  const copiedImages = [];
  for (let index = 0; index < generatedImages.length; index += 1) {
    const sourcePath = generatedImages[index];
    const ext = path.extname(sourcePath) || ".png";
    const targetPath = path.join(bundleDir, `image-${String(index + 1).padStart(2, "0")}${ext}`);
    await copyFile(sourcePath, targetPath);
    copiedImages.push(targetPath);
  }

  const copiedVideos = [];
  for (let index = 0; index < generatedVideos.length; index += 1) {
    const sourcePath = generatedVideos[index];
    const ext = path.extname(sourcePath) || ".mp4";
    const targetPath = path.join(bundleDir, `video-${String(index + 1).padStart(2, "0")}${ext}`);
    await copyFile(sourcePath, targetPath);
    copiedVideos.push(targetPath);
  }

  const manifestPath = path.join(bundleDir, "media-bundle.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        product_name: productName,
        source_generated_images: generatedImages,
        source_generated_videos: generatedVideos,
        bundled_images: copiedImages,
        bundled_videos: copiedVideos,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    bundleDir,
    bundledImages: copiedImages,
    bundledVideos: copiedVideos,
    manifestPath,
  };
}

async function ensureCampaignBundle(workflowState, options = {}) {
  const logs = [];
  const stepReports = {};
  const sourceArtifacts = { ...workflowState.sourceArtifacts };

  if (!workflowState?.productResearch?.data) {
    throw new Error("Missing product research data for campaign bundle.");
  }

  if (!workflowState.productProfile) {
    const step1 = await runSkillStep({
      step: 1,
      skillName: "normalize_product_input",
      payload: buildProductProfileInput(workflowState.productResearch.data),
      logs,
    });
    stepReports.step1_normalize_product_input = summarizeStepResult(step1);
    if (!step1.parsed?.success) {
      throwStepFailure(1, "normalize_product_input", step1);
    }
    workflowState.productProfile = step1.parsed.data?.product_profile;
    sourceArtifacts.product_artifact_path =
      step1.parsed.artifacts?.find((item) => item?.type === "product_profile")?.path || null;
  }

  if (!workflowState.salesContent) {
    const step2 = await runSkillStep({
      step: 2,
      skillName: "generate_sales_content",
      payload: { product_profile: workflowState.productProfile },
      logs,
    });
    stepReports.step2_generate_sales_content = summarizeStepResult(step2);
    if (!step2.parsed?.success) {
      throwStepFailure(2, "generate_sales_content", step2);
    }
    workflowState.salesContent = step2.parsed.data || null;
    sourceArtifacts.content_artifact_path =
      step2.parsed.artifacts?.find((item) => item?.type === "sales_content")?.path || null;
  }

  if (!workflowState.salesContent?.image_prompt || !workflowState.salesContent?.video_prompt) {
    throw new Error("Sales content is incomplete: missing image/video prompts.");
  }

  if (!String(workflowState.imagePrompt || "").trim()) {
    workflowState.imagePrompt = workflowState.salesContent.image_prompt;
  }
  if (!String(workflowState.videoPrompt || "").trim()) {
    workflowState.videoPrompt = workflowState.salesContent.video_prompt;
  }
  if (!String(workflowState.finalContent || "").trim()) {
    workflowState.finalContent = pickFirstNonEmpty(
      workflowState.latestContentDraft,
      workflowState.salesContent.caption_long,
    );
  }

  workflowState.mediaSpecificContent = buildMediaSpecificContent(
    workflowState.finalContent,
    workflowState.salesContent,
    workflowState.productProfile,
  );
  workflowState.sourceArtifacts = sourceArtifacts;

  return { logs, stepReports, sourceArtifacts };
}

async function generateMediaAssets(workflowState, options = {}) {
  const logs = [];
  const stepReports = {};
  const config = resolveMediaConfig(options);

  const bundle = await ensureCampaignBundle(workflowState, options);
  logs.push(...bundle.logs);
  Object.assign(stepReports, bundle.stepReports);

  const referenceImages = await collectValidReferenceImages(
    workflowState.productResearch?.data,
    1,
  );
  if (referenceImages.length === 0) {
    throw new Error("Khong tim thay anh goc hop le de gui sang Gemini image/video.");
  }

  const imagePrompt = buildImagePrompt(
    workflowState.imagePrompt,
    workflowState.productProfile,
    referenceImages,
  );
  const step3 = await runSkillStep({
    step: 3,
    skillName: "gemini_generate_image",
    payload: {
      image_prompt: imagePrompt,
      image_paths: referenceImages,
      browser_path: config.browser_path,
      user_data_dir: config.user_data_dir,
      profile_name: config.profile_name,
      target_gemini_url: config.target_gemini_image_url,
      timeout_ms: config.timeout_ms,
      retry_count: config.retry_count,
      dry_run: config.dry_run,
    },
    logs,
  });
  stepReports.step3_gemini_generate_image = summarizeStepResult(step3);
  if (!step3.parsed?.success) {
    throwStepFailure(3, "gemini_generate_image", step3);
  }

  const generatedImages = (step3.parsed.artifacts || [])
    .filter((item) => item?.type === "generated_image")
    .map((item) => path.resolve(REPO_ROOT, item.path));
  if (generatedImages.length === 0 && !config.dry_run) {
    throw new Error("Image generation completed without a saved generated_image artifact.");
  }

  const videoReferenceImages = referenceImages.slice(0, 1);
  const videoPrompt = buildVideoPrompt(
    workflowState.videoPrompt,
    workflowState.productProfile,
    referenceImages,
    generatedImages,
  );
  const step4 = await runSkillStep({
    step: 4,
    skillName: "generate_video",
    payload: {
      video_prompt: videoPrompt,
      image_paths: videoReferenceImages,
      browser_path: config.browser_path,
      user_data_dir: config.user_data_dir,
      profile_name: config.profile_name,
      target_gemini_url: config.target_gemini_video_url,
      timeout_ms: Math.max(config.timeout_ms, 240000),
      retry_count: config.retry_count,
      dry_run: config.dry_run,
    },
    logs,
  });
  stepReports.step4_generate_video = summarizeStepResult(step4);
  let generatedVideos = [];
  let videoGenerationSkipped = null;
  if (!step4.parsed?.success) {
    if (isQuotaExceededStepResult(step4)) {
      videoGenerationSkipped = {
        code: "QUOTA_EXCEEDED",
        reason:
          step4.parsed?.error?.details ||
          step4.parsed?.message ||
          "Reached daily Veo generation limit.",
      };
      logs.push(`[step4] Video generation skipped: ${videoGenerationSkipped.reason}`);
    } else {
      throwStepFailure(4, "generate_video", step4);
    }
  } else {
    generatedVideos = (step4.parsed.artifacts || [])
      .filter((item) => item?.type === "generated_video")
      .map((item) => path.resolve(REPO_ROOT, item.path));
    if (generatedVideos.length === 0 && !config.dry_run) {
      throw new Error("Video generation completed without a publishable generated_video artifact.");
    }
  }

  const mediaBundle = await materializeMediaBundle(workflowState, generatedImages, generatedVideos);

  workflowState.imagePrompt = imagePrompt;
  workflowState.videoPrompt = videoPrompt;
  workflowState.referenceImages = referenceImages;
  workflowState.videoReferenceImages = videoReferenceImages;
  workflowState.generatedImagePaths = mediaBundle.bundledImages;
  workflowState.generatedVideoPaths = mediaBundle.bundledVideos;
  workflowState.mediaBundleDir = mediaBundle.bundleDir;
  workflowState.videoGenerationSkipped = videoGenerationSkipped;
  workflowState.mediaGeneration = {
    artifacts: [...(step3.parsed.artifacts || []), ...(step4.parsed.artifacts || [])],
    stepReports,
    logs,
    mediaBundleDir: mediaBundle.bundleDir,
    videoGenerationSkipped,
  };

  return {
    logs,
    stepReports,
    referenceImages,
    videoReferenceImages,
    generatedImages: workflowState.generatedImagePaths,
    generatedVideos: workflowState.generatedVideoPaths,
    mediaBundleDir: mediaBundle.bundleDir,
    videoGenerationSkipped,
  };
}

async function publishCampaignPosts(workflowState, options = {}) {
  const logs = [];
  const stepReports = {};
  const config = resolveMediaConfig(options);

  if (!Array.isArray(workflowState.generatedImagePaths) || workflowState.generatedImagePaths.length === 0) {
    throw new Error("Missing generated image for publish step.");
  }
  if (!workflowState.mediaSpecificContent) {
    await ensureCampaignBundle(workflowState, options);
  }

  const imagePath = workflowState.generatedImagePaths[0];
  await access(imagePath);

  const imageStep = await runSkillStep({
    step: "5A",
    skillName: "facebook_publish_post",
    payload: {
      caption_long: workflowState.mediaSpecificContent.image.caption_long,
      caption_short: workflowState.mediaSpecificContent.image.caption_short,
      media_paths: [imagePath],
      page_id: config.page_id,
      access_token: config.access_token,
      dry_run: config.dry_run,
    },
    logs,
  });
  stepReports.step5a_facebook_publish_image = summarizeStepResult(imageStep);
  if (!imageStep.parsed?.success) {
    throwStepFailure("5A", "facebook_publish_post(image)", imageStep);
  }

  let videoPayload = {
    skipped: true,
    reason:
      workflowState.videoGenerationSkipped?.reason || "Khong co file video publishable do video bi bo qua.",
    code: workflowState.videoGenerationSkipped?.code || "VIDEO_NOT_AVAILABLE",
  };
  if (Array.isArray(workflowState.generatedVideoPaths) && workflowState.generatedVideoPaths.length > 0) {
    const videoPath = workflowState.generatedVideoPaths[0];
    await access(videoPath);

    const videoStep = await runSkillStep({
      step: "5B",
      skillName: "facebook_publish_post",
      payload: {
        caption_long: workflowState.mediaSpecificContent.video.caption_long,
        caption_short: workflowState.mediaSpecificContent.video.caption_short,
        media_paths: [videoPath],
        page_id: config.page_id,
        access_token: config.access_token,
        dry_run: config.dry_run,
      },
      logs,
    });
    stepReports.step5b_facebook_publish_video = summarizeStepResult(videoStep);
    if (!videoStep.parsed?.success) {
      throwStepFailure("5B", "facebook_publish_post(video)", videoStep);
    }
    videoPayload = videoStep.parsed.data || null;
  } else {
    logs.push(`[step5B] Skip facebook_publish_post(video): ${videoPayload.reason}`);
    stepReports.step5b_facebook_publish_video = {
      code: 0,
      success: true,
      message: videoPayload.reason,
      stderr: "",
      stdout_preview: "",
      error: null,
      artifacts: [],
      data: videoPayload,
    };
  }

  workflowState.publishResults = {
    image: imageStep.parsed.data || null,
    video: videoPayload,
    stepReports,
    logs,
  };

  return workflowState.publishResults;
}

module.exports = {
  buildMediaSpecificContent,
  ensureCampaignBundle,
  generateMediaAssets,
  publishCampaignPosts,
  resolveMediaConfig,
  toRepoRelative,
};
