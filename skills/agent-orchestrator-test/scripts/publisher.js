/**
 * publisher.js — Logic publish/schedule/edit bài Facebook.
 *
 * Tất cả đều dùng runLocalSkill() pattern — gọi subprocess tới action.js tương ứng.
 * Chỉ được kích hoạt khi trạng thái là Approved (sếp duyệt toàn bộ).
 */

const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function normalizeMediaPaths(mediaPaths) {
  return (Array.isArray(mediaPaths) ? mediaPaths : [mediaPaths])
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function splitMediaPathsByType(mediaPaths) {
  const imagePaths = [];
  const videoPaths = [];

  for (const mediaPath of normalizeMediaPaths(mediaPaths)) {
    const ext = path.extname(mediaPath).toLowerCase();
    if ([".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext)) {
      videoPaths.push(mediaPath);
    } else {
      imagePaths.push(mediaPath);
    }
  }

  return { imagePaths, videoPaths };
}

function buildSplitPublishResult(mode, imageResult, videoResult) {
  return {
    success: true,
    data: {
      mode,
      post_ids: [extractPostId(imageResult), extractPostId(videoResult)].filter(Boolean),
      image_publish_result: imageResult,
      video_publish_result: videoResult,
    },
  };
}

/**
 * Chạy một skill local (subprocess).
 */
function runLocalSkill(skillName, payload) {
  const scriptPath = path.join(REPO_ROOT, "skills", skillName, "action.js");
  const run = spawnSync(process.execPath, [scriptPath, JSON.stringify(payload)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 25 * 1024 * 1024,
  });

  if (run.error) {
    throw run.error;
  }

  const parsed = parseJsonFromOutput(run.stdout);
  if (!parsed?.success) {
    const hintLogs = Array.isArray(parsed?.logs)
      ? parsed.logs.filter((entry) => String(entry || "").toLowerCase().startsWith("[hint]"))
      : [];
    const hintText = hintLogs.length > 0 ? ` ${hintLogs.join(" ")}` : "";
    throw new Error(
      `${parsed?.error?.details || parsed?.message || run.stderr || `${skillName} failed`}${hintText}`,
    );
  }

  return parsed;
}

/**
 * Parse JSON từ stdout có thể chứa text thừa.
 */
function parseJsonFromOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Đăng bài ngay lập tức lên Fanpage.
 *
 * @param {object} params
 * @param {string} params.content — Nội dung bài viết đã duyệt
 * @param {string[]} params.mediaPaths — Mảng đường dẫn file media
 * @returns {object} Kết quả từ skill facebook_publish_post
 */
function publishNow(params) {
  const { content, mediaPaths } = params;
  const { imagePaths, videoPaths } = splitMediaPathsByType(mediaPaths);

  if (imagePaths.length > 0 && videoPaths.length > 0) {
    const imageResult = runLocalSkill("facebook_publish_post", {
      caption_long: content,
      media_paths: imagePaths,
    });
    const videoResult = runLocalSkill("facebook_publish_post", {
      caption_long: content,
      media_paths: videoPaths,
    });
    return buildSplitPublishResult("split_image_video", imageResult, videoResult);
  }

  return runLocalSkill("facebook_publish_post", {
    caption_long: content,
    media_paths: normalizeMediaPaths(mediaPaths),
  });
}

/**
 * Hẹn giờ đăng bài lên Fanpage.
 *
 * @param {object} params
 * @param {string} params.content — Nội dung bài viết đã duyệt
 * @param {string[]} params.mediaPaths — Mảng đường dẫn file media
 * @param {string|number} params.scheduleTime — ISO 8601 hoặc Unix timestamp
 * @returns {object} Kết quả từ skill schedule_facebook_post
 */
function schedulePost(params) {
  const { content, mediaPaths, scheduleTime } = params;
  const { imagePaths, videoPaths } = splitMediaPathsByType(mediaPaths);

  if (imagePaths.length > 0 && videoPaths.length > 0) {
    const imageResult = runLocalSkill("schedule_facebook_post", {
      caption_long: content,
      media_paths: imagePaths,
      scheduled_publish_time: scheduleTime,
    });
    const videoResult = runLocalSkill("schedule_facebook_post", {
      caption_long: content,
      media_paths: videoPaths,
      scheduled_publish_time: scheduleTime,
    });
    return buildSplitPublishResult("split_image_video", imageResult, videoResult);
  }

  return runLocalSkill("schedule_facebook_post", {
    caption_long: content,
    media_paths: normalizeMediaPaths(mediaPaths),
    scheduled_publish_time: scheduleTime,
  });
}

/**
 * Sửa bài đã đăng trên Fanpage.
 *
 * @param {object} params
 * @param {string} params.postId — ID bài viết Facebook cần sửa
 * @param {string} params.newContent — Nội dung mới
 * @returns {object} Kết quả từ skill facebook_edit_post
 */
function editPublishedPost(params) {
  const { postId, newContent } = params;

  if (!postId) {
    throw new Error("Can cung cap post_id de sua bai da dang.");
  }

  return runLocalSkill("facebook_edit_post", {
    post_id: postId,
    caption_long: newContent,
  });
}

/**
 * Trích xuất Post ID từ kết quả publish.
 */
function extractPostId(publishResult) {
  if (Array.isArray(publishResult?.data?.post_ids) && publishResult.data.post_ids.length > 0) {
    return String(publishResult.data.post_ids[0] || "").trim();
  }
  return (
    publishResult?.data?.post_id ||
    publishResult?.data?.raw_fb_response?.id ||
    publishResult?.data?.raw_fb_response?.post_id ||
    ""
  );
}

function extractPostIds(publishResult) {
  if (Array.isArray(publishResult?.data?.post_ids)) {
    return publishResult.data.post_ids.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const singleId = extractPostId(publishResult);
  return singleId ? [singleId] : [];
}

module.exports = {
  editPublishedPost,
  extractPostId,
  extractPostIds,
  parseJsonFromOutput,
  publishNow,
  runLocalSkill,
  schedulePost,
  splitMediaPathsByType,
};
