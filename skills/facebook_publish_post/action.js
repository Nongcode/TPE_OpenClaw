import { access, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  page_id: "1131157960071384",
  access_token:
    "EAAS86OsLd40BRIcOUIkiW7CXSsqtjkBrNIsc6goWQ2mnvxsJO2YJPErSt3aEKGDZCq0sMoYlu7RIcnZBG9OKVVmW9mlPMhjGet4fL5oplGTbyCBpepZCwtuytW39CvZBxHZAWg9pcciZA3c3wsL3tBKG3TMAyXr1ZBwg38VflZCaTjU60DlYhgLZBXD3dDQuJWYtft98pp0pZA",
  media_paths: [],
  dry_run: false,
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
  const video = isVideoFile(filePath);
  const endpoint = video ? "/videos" : "/photos";
  const apiUrl = `https://graph.facebook.com/v20.0/${pageId}${endpoint}`;

  const formData = new FormData();
  formData.append("access_token", accessToken);
  formData.append("published", "false");

  const fileBuffer = await readFile(filePath);
  const mimeType = video ? "video/mp4" : "image/jpeg";
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append("source", blob, path.basename(filePath));

  logs.push(`[upload] Uploading unpublished ${video ? "video" : "photo"}: ${filePath}`);
  const response = await fetch(apiUrl, {
    method: "POST",
    body: formData,
  });
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
  const logs = [...parsed.logs, "[start] facebook_publish_post (Graph API) invoked"];

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

  const caption =
    typeof parsed.caption_long === "string" && parsed.caption_long.trim() !== ""
      ? parsed.caption_long.trim()
      : parsed.caption_short.trim();
  const mediaPaths = parseList(parsed.media_paths).map((item) => path.normalize(item));
  const pageId = String(parsed.page_id).trim();
  const accessToken = String(parsed.access_token).trim();

  logs.push(`[input] page_id=${pageId}`);
  logs.push(`[input] media_count=${mediaPaths.length}`);

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip actual API call.");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed.",
        data: { caption, media_paths: mediaPaths },
        logs,
      }),
    );
    return;
  }

  try {
    if (mediaPaths.length > 0) {
      await ensureReadableFiles(mediaPaths);
      logs.push("[step1] Media files verified");
    }

    if (mediaPaths.length > 1) {
      logs.push("[step2] Multiple media detected, using attached_media flow");

      const uploads = [];
      for (const filePath of mediaPaths) {
        uploads.push(await uploadUnpublishedMedia({
          pageId,
          accessToken,
          filePath,
          logs,
        }));
      }

      const apiUrl = `https://graph.facebook.com/v20.0/${pageId}/feed`;
      const formData = new FormData();
      formData.append("access_token", accessToken);
      formData.append("message", caption);
      uploads.forEach((upload, index) => {
        formData.append(`attached_media[${index}]`, JSON.stringify({ media_fbid: upload.mediaId }));
      });

      logs.push("[step3] Creating combined feed post with attached_media...");
      const response = await fetch(apiUrl, {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      if (!response.ok || result.error) {
        throw new Error(result.error ? result.error.message : JSON.stringify(result));
      }

      const finalPostId = result.id || result.post_id || result.video_id;
      logs.push(`[step4] Combined post published successfully! FB Response ID: ${finalPostId}`);

      printResult(
        buildResult({
          success: true,
          message: "Facebook post published successfully via attached_media",
          data: {
            page_id: pageId,
            post_id: finalPostId,
            media_uploaded: true,
            media_type: "multi",
            attached_media_count: uploads.length,
            attached_media_ids: uploads.map((item) => item.mediaId),
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
    if (file) {
      endpoint = isVideo ? "/videos" : "/photos";
    }

    const apiUrl = `https://graph.facebook.com/v20.0/${pageId}${endpoint}`;
    logs.push(`[step2] Target API Endpoint: ${apiUrl}`);

    const formData = new FormData();
    formData.append("access_token", accessToken);

    if (endpoint === "/feed") {
      formData.append("message", caption);
    } else if (endpoint === "/photos") {
      formData.append("message", caption);
    } else if (endpoint === "/videos") {
      formData.append("description", caption);
    }

    if (file) {
      logs.push(`[step3] Reading file into memory: ${file}`);
      const fileBuffer = await readFile(file);
      const mimeType = isVideo ? "video/mp4" : "image/jpeg";
      const blob = new Blob([fileBuffer], { type: mimeType });
      formData.append("source", blob, path.basename(file));
    }

    logs.push("[step4] Sending HTTP POST request to Facebook Graph API...");

    const response = await fetch(apiUrl, {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!response.ok || result.error) {
      throw new Error(result.error ? result.error.message : JSON.stringify(result));
    }

    // --- SỬA ĐỔI QUAN TRỌNG Ở ĐÂY: Xử lý logic lấy ID ---
    // API có thể trả về 'id', 'post_id', hoặc 'video_id' tùy thuộc vào Endpoint
    const finalPostId = result.id || result.post_id || result.video_id;

    logs.push(`[step5] Post published successfully! FB Response ID: ${finalPostId}`);

    printResult(
      buildResult({
        success: true,
        message: "Facebook post published successfully via Graph API",
        data: {
          page_id: pageId,
          // Đảm bảo trường post_id luôn chứa đúng ID để truyền cho kỹ năng Get Metrics
          post_id: finalPostId,
          media_uploaded: !!file,
          media_type: isVideo ? "video" : file ? "photo" : "text",
          raw_fb_response: result, // Log lại toàn bộ cục response của FB để dễ debug
        },
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] Flow failed: ${error.message}`);
    printResult(
      buildResult({
        success: false,
        message: "Failed to publish post via Graph API",
        logs,
        error: { code: "API_ERROR", details: error.message },
      }),
    );
    process.exit(1);
  }
})();
