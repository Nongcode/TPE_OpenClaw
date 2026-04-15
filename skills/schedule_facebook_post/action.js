import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadFacebookEnv } from "../facebook_shared/load-env.js";

loadFacebookEnv();

const DEFAULTS = {
  page_id: process.env.FACEBOOK_PAGE_ID || "1131157960071384",
  access_token:
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    process.env.PAGE_ACCESS_TOKEN ||
    "EAAS86OsLd40BRC57JhTf37p5KqhdtjeuAZATviMt5GgJmstKAcj0MQsi0NR8xRY1HrWlUv2RfbLy8z6N4K8GhrlO6T0kRAB4BA1ZBR18Ei0hIyqxOcGuEjU0ezLteJaeMIL7TlOujpfjiPigesAVbwHBerMXe1p0mDLVY4Bk9CGTHhZBuAZBiZBqyLrBln9qZBsUNA",
  media_paths: [],
  scheduled_publish_time: "", // Bắt buộc: Thời gian muốn đăng (ISO 8601 hoặc Unix Timestamp)
  dry_run: false,
  graph_version: process.env.FACEBOOK_GRAPH_API_VERSION || "v20.0",
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string")
    return value
      .split(/\r?\n|;|,/g)
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
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
        media_paths: parseList(parsed.media_paths),
        dry_run: parsed.dry_run === true || parsed["dry-run"] === true,
        logs,
      };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error.message}`);
    }
  }

  return { ...params, logs };
}

function validateInput(params) {
  const missing = [];
  const hasCaption =
    (typeof params.caption_long === "string" && params.caption_long.trim() !== "") ||
    (typeof params.caption_short === "string" && params.caption_short.trim() !== "");

  if (!hasCaption) missing.push("caption_long_or_caption_short");
  if (!params.page_id || String(params.page_id).trim() === "") missing.push("page_id");
  if (!params.access_token || String(params.access_token).trim() === "")
    missing.push("access_token");
  if (!params.scheduled_publish_time) missing.push("scheduled_publish_time");

  return missing;
}

async function ensureReadableFiles(pathsToCheck) {
  for (const filePath of pathsToCheck) await access(filePath);
}

function isVideoFile(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return [".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext);
}

async function uploadUnpublishedMedia({ pageId, accessToken, filePath, logs }) {
  const graphVersion = process.env.FACEBOOK_GRAPH_API_VERSION || DEFAULTS.graph_version;
  const video = isVideoFile(filePath);
  const endpoint = video ? "/videos" : "/photos";
  const apiUrl = `https://graph.facebook.com/${graphVersion}/${pageId}${endpoint}`;

  const formData = new FormData();
  formData.append("access_token", accessToken);
  formData.append("published", "false");

  const fileBuffer = await readFile(filePath);
  const mimeType = video ? "video/mp4" : "image/jpeg";
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append("source", blob, path.basename(filePath));

  logs.push(`[upload] Uploading unpublished ${video ? "video" : "photo"}: ${filePath}`);
  const response = await fetch(apiUrl, { method: "POST", body: formData });
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(result.error ? result.error.message : JSON.stringify(result));
  }

  const mediaId = result.id || result.post_id || result.video_id;
  if (!mediaId) {
    throw new Error(`Upload ${path.basename(filePath)} khong tra ve media ID hop le`);
  }

  return {
    mediaId,
    mediaType: video ? "video" : "photo",
    raw: result,
  };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] schedule_facebook_post (Graph API) invoked"];

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(
      buildResult({
        success: false,
        message: "Missing required inputs",
        logs,
        error: { code: "VALIDATION_ERROR", details: missing.join(", ") },
      }),
    );
    process.exit(1);
  }

  // --- XỬ LÝ THỜI GIAN ĐẶT LỊCH ---
  let scheduledUnixTime;
  const inputTime = parsed.scheduled_publish_time;

  // Nếu AI truyền vào số (Unix timestamp), dùng luôn. Nếu truyền chuỗi (ví dụ: 2026-04-10T20:00:00+07:00), thì chuyển đổi.
  if (typeof inputTime === "number") {
    scheduledUnixTime = inputTime;
  } else {
    scheduledUnixTime = Math.floor(new Date(inputTime).getTime() / 1000);
  }

  if (isNaN(scheduledUnixTime)) {
    printResult(
      buildResult({
        success: false,
        message: "Invalid time format",
        logs,
        error: {
          code: "VALIDATION_ERROR",
          details: "scheduled_publish_time must be a valid date string or unix timestamp",
        },
      }),
    );
    process.exit(1);
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  // Facebook yêu cầu tối thiểu 10 phút (600 giây) và tối đa 75 ngày (6480000 giây)
  if (scheduledUnixTime < nowUnix + 600) {
    logs.push(
      "[warning] Time is less than 10 minutes from now. Auto-adjusting to Now + 11 minutes.",
    );
    scheduledUnixTime = nowUnix + 660;
  } else if (scheduledUnixTime > nowUnix + 6480000) {
    printResult(
      buildResult({
        success: false,
        message: "Scheduled time too far",
        logs,
        error: {
          code: "VALIDATION_ERROR",
          details: "Facebook only allows scheduling up to 75 days in advance.",
        },
      }),
    );
    process.exit(1);
  }

  logs.push(
    `[info] Scheduled for Unix Time: ${scheduledUnixTime} (Local: ${new Date(scheduledUnixTime * 1000).toLocaleString()})`,
  );

  const caption =
    typeof parsed.caption_long === "string" && parsed.caption_long.trim() !== ""
      ? parsed.caption_long.trim()
      : parsed.caption_short.trim();
  const mediaPaths = parseList(parsed.media_paths).map((item) => path.normalize(item));
  const pageId = String(parsed.page_id).trim();
  const accessToken = String(parsed.access_token).trim();
  const graphVersion = String(parsed.graph_version || DEFAULTS.graph_version).trim();

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip actual API call.");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed.",
        data: { caption, scheduled_time: scheduledUnixTime },
        logs,
      }),
    );
    return;
  }

  try {
    if (mediaPaths.length > 0) {
      await ensureReadableFiles(mediaPaths);
    }

    if (mediaPaths.length > 1) {
      logs.push("[step] Multiple media detected, using attached_media schedule flow");

      const uploads = [];
      for (const filePath of mediaPaths) {
        uploads.push(
          await uploadUnpublishedMedia({
            pageId,
            accessToken,
            filePath,
            logs,
          }),
        );
      }

      const apiUrl = `https://graph.facebook.com/${graphVersion}/${pageId}/feed`;
      const formData = new FormData();
      formData.append("access_token", accessToken);
      formData.append("published", "false");
      formData.append("scheduled_publish_time", scheduledUnixTime.toString());
      formData.append("message", caption);
      uploads.forEach((upload, index) => {
        formData.append(`attached_media[${index}]`, JSON.stringify({ media_fbid: upload.mediaId }));
      });

      logs.push("[step] Sending scheduled attached_media feed request...");
      const response = await fetch(apiUrl, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error ? result.error.message : JSON.stringify(result));
      }

      const finalPostId = result.post_id || result.id || result.video_id;
      printResult(
        buildResult({
          success: true,
          message: "Facebook post scheduled successfully!",
          data: {
            page_id: pageId,
            post_id: finalPostId,
            attached_media_count: uploads.length,
            attached_media_ids: uploads.map((item) => item.mediaId),
            scheduled_time_unix: scheduledUnixTime,
            scheduled_time_local: new Date(scheduledUnixTime * 1000).toLocaleString(),
            raw_fb_response: result,
          },
          logs,
        }),
      );
      return;
    }

    const file = mediaPaths.length > 0 ? mediaPaths[0] : null;
    const ext = file ? path.extname(file).toLowerCase() : "";
    const isVideo = [".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext);

    let endpoint = "/feed";
    if (file) endpoint = isVideo ? "/videos" : "/photos";

    const apiUrl = `https://graph.facebook.com/${graphVersion}/${pageId}${endpoint}`;

    const formData = new FormData();
    formData.append("access_token", accessToken);

    // --- HAI THAM SỐ QUAN TRỌNG ĐỂ ĐẶT LỊCH ---
    formData.append("published", "false");
    formData.append("scheduled_publish_time", scheduledUnixTime.toString());

    if (endpoint === "/feed" || endpoint === "/photos") {
      formData.append("message", caption);
    } else if (endpoint === "/videos") {
      formData.append("description", caption);
    }

    if (file) {
      const fileBuffer = await readFile(file);
      const mimeType = isVideo ? "video/mp4" : "image/jpeg";
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append("source", blob, path.basename(file));
    }

    logs.push("[step] Sending HTTP POST request to Facebook Graph API for Scheduling...");

    const response = await fetch(apiUrl, { method: "POST", body: formData });
    const result = await response.json();

    if (!response.ok || result.error) {
      throw new Error(result.error ? result.error.message : JSON.stringify(result));
    }

    const finalPostId = result.post_id || result.id || result.video_id;

    printResult(
      buildResult({
        success: true,
        message: "Facebook post scheduled successfully!",
        data: {
          page_id: pageId,
          post_id: finalPostId, // Vẫn trả về ID bài viết để có thể sửa đổi sau này
          scheduled_time_unix: scheduledUnixTime,
          scheduled_time_local: new Date(scheduledUnixTime * 1000).toLocaleString(),
          raw_fb_response: result,
        },
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] Flow failed: ${error.message}`);
    if (/\(#200\)|permissions error/i.test(String(error.message || ""))) {
      logs.push(
        "[hint] Facebook Graph API rejected the schedule request with a permissions error. Check that FACEBOOK_PAGE_ACCESS_TOKEN belongs to FACEBOOK_PAGE_ID and has pages_manage_posts/pages_read_engagement.",
      );
    }
    printResult(
      buildResult({
        success: false,
        message: "Failed to schedule post",
        logs,
        error: { code: "API_ERROR", details: error.message },
      }),
    );
    process.exit(1);
  }
})();
