const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function compactOutput(text, limit = 2000) {
  return String(text || "").trim().slice(0, limit);
}

function extractPublishedPosts(outputText) {
  const posts = [];
  const pattern = /->\s*SUCCESS\s*\[([^\]]+)\][\s\S]*?ID:\s*([^\s]+)/gi;
  let match = pattern.exec(String(outputText || ""));
  while (match) {
    posts.push({
      page: match[1].trim(),
      post_id: match[2].trim(),
    });
    match = pattern.exec(String(outputText || ""));
  }
  return posts;
}

async function runAutoContentPost({ targetPages, message, mediaPath, dryRun = false }) {
  if (dryRun) {
    return {
      code: 0,
      stdout: `[dry-run] targetPages=${targetPages} media=${mediaPath || "(none)"}`,
      stderr: "",
      posts: [],
    };
  }

  const skillPath = path.join(REPO_ROOT, "skills", "auto-content", "post_fb_local.js");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [skillPath, targetPages, message, mediaPath || ""], {
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
        posts: [],
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        posts: extractPublishedPosts(stdout),
      });
    });
  });
}

function buildPublishFailure(kind, result) {
  const errorText = compactOutput(result.stderr || result.stdout || `auto-content ${kind} publish failed`);
  const error = new Error(errorText || `auto-content ${kind} publish failed`);
  error.kind = kind;
  error.result = result;
  return error;
}

async function publishViaAutoContent(workflowState, options = {}) {
  const targetPages =
    options.autoContentTargetPages || process.env.OPENCLAW_AUTO_CONTENT_TARGET_PAGES || "ALL";
  const imagePath = workflowState.generatedImagePaths?.[0] || "";
  const videoPath = workflowState.generatedVideoPaths?.[0] || "";
  const imageCaption =
    workflowState.mediaSpecificContent?.image?.caption_long ||
    workflowState.finalContent ||
    workflowState.latestContentDraft ||
    "";
  const videoCaption =
    workflowState.mediaSpecificContent?.video?.caption_long ||
    workflowState.mediaSpecificContent?.image?.caption_long ||
    workflowState.finalContent ||
    workflowState.latestContentDraft ||
    "";

  if (!String(imageCaption || "").trim()) {
    throw new Error("Khong co final content de goi auto-content dang Facebook.");
  }

  const imageResult = await runAutoContentPost({
    targetPages,
    message: imageCaption,
    mediaPath: imagePath,
    dryRun: options.dryRun === true,
  });
  if (imageResult.code !== 0) {
    throw buildPublishFailure("image", imageResult);
  }

  let videoResult = {
    skipped: true,
    reason: videoPath ? "Video khong duoc goi." : "Khong co file video publishable.",
    stdout: "",
    stderr: "",
    posts: [],
  };

  if (videoPath) {
    const attemptedVideoResult = await runAutoContentPost({
      targetPages,
      message: videoCaption,
      mediaPath: videoPath,
      dryRun: options.dryRun === true,
    });
    if (attemptedVideoResult.code !== 0) {
      throw buildPublishFailure("video", attemptedVideoResult);
    }
    videoResult = attemptedVideoResult;
  }

  return {
    targetPages,
    image: {
      posts: imageResult.posts,
      post_id: imageResult.posts[0]?.post_id || null,
      stdout: compactOutput(imageResult.stdout),
      stderr: compactOutput(imageResult.stderr),
      media_path: imagePath || null,
    },
    video: videoResult.skipped
      ? {
          skipped: true,
          reason: videoResult.reason,
          media_path: videoPath || null,
        }
      : {
          posts: videoResult.posts,
          post_id: videoResult.posts[0]?.post_id || null,
          stdout: compactOutput(videoResult.stdout),
          stderr: compactOutput(videoResult.stderr),
          media_path: videoPath || null,
        },
  };
}

module.exports = {
  publishViaAutoContent,
};
