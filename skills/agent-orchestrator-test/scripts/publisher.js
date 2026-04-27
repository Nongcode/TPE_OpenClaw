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

function normalizeCanonicalPostId(candidatePostId, pageId) {
  const rawPostId = String(candidatePostId || "").trim();
  const normalizedPageId = String(pageId || "").trim();
  if (!rawPostId) {
    return "";
  }
  if (rawPostId.includes("_") || !normalizedPageId) {
    return rawPostId;
  }
  return `${normalizedPageId}_${rawPostId}`;
}

function collectPublishEntries(publishResult) {
  if (!publishResult || typeof publishResult !== "object") {
    return [];
  }

  const nestedResults = [
    publishResult?.data?.image_publish_result,
    publishResult?.data?.video_publish_result,
  ]
    .filter(Boolean)
    .flatMap((entry) => collectPublishEntries(entry));
  if (nestedResults.length > 0) {
    return nestedResults;
  }

  if (Array.isArray(publishResult?.data?.post_ids) && publishResult.data.post_ids.length > 0) {
    return publishResult.data.post_ids
      .map((postId) => {
        const normalizedPostId = String(postId || "").trim();
        if (!normalizedPostId) {
          return null;
        }
        const pageId = normalizedPostId.includes("_") ? normalizedPostId.split("_")[0] : "";
        return {
          pageId,
          postId: normalizedPostId,
          permalink: "",
          rawPostId: normalizedPostId,
          raw: { post_id: normalizedPostId },
        };
      })
      .filter(Boolean);
  }

  const directResults = Array.isArray(publishResult?.data?.results)
    ? publishResult.data.results
    : [publishResult];

  return directResults
    .map((entry) => {
      const payload = entry?.data?.results ? null : entry;
      if (!payload || typeof payload !== "object") {
        return null;
      }
      const rawResponse = payload.raw_fb_response || publishResult?.data?.raw_fb_response || {};
      const pageId = String(payload.page_id || publishResult?.data?.page_id || rawResponse.page_id || "").trim();
      const rawPostId =
        rawResponse.post_id ||
        payload.post_id ||
        publishResult?.data?.post_id ||
        rawResponse.id ||
        "";
      const canonicalPostId = normalizeCanonicalPostId(rawPostId, pageId);
      const permalink = String(
        payload.permalink_url || rawResponse.permalink_url || publishResult?.data?.permalink_url || "",
      ).trim();

      return {
        pageId,
        postId: canonicalPostId,
        permalink,
        rawPostId: String(rawPostId || "").trim(),
        raw: payload,
      };
    })
    .filter(Boolean);
}

function extractCanonicalPublishResult(publishResult) {
  const entries = collectPublishEntries(publishResult);
  const pageIds = [...new Set(entries.map((entry) => entry.pageId).filter(Boolean))];
  const postIds = [...new Set(entries.map((entry) => entry.postId).filter(Boolean))];
  const permalink = entries.find((entry) => entry.permalink)?.permalink || "";

  return {
    status: publishResult?.success ? "published" : "error",
    pageId: pageIds[0] || "",
    pageIds,
    postId: postIds[0] || "",
    postIds,
    permalink,
    entries,
  };
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
  return extractCanonicalPublishResult(publishResult).postId;
}

function extractPostIds(publishResult) {
  return extractCanonicalPublishResult(publishResult).postIds;
}

module.exports = {
  editPublishedPost,
  extractCanonicalPublishResult,
  extractPostId,
  extractPostIds,
  parseJsonFromOutput,
  publishNow,
  runLocalSkill,
  schedulePost,
  splitMediaPathsByType,
};
