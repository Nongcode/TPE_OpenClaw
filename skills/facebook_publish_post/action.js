import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadFacebookEnv } from "../facebook_shared/load-env.js";

loadFacebookEnv();

const DEFAULTS = {
  media_paths: [],
  dry_run: false,
  graph_version: process.env.FACEBOOK_GRAPH_API_VERSION || "v20.0",
};

const TARGET_PAGES = [
  {
    page_id: "1131157960071384",
    access_token:
      "EAAUnu2nAp08BRYhR8vsGPVE7mxmzy7ZCoW6UOAPrxsEiY9J4lkVBjq4Bsv6BUWuicTDRGz1EJN1StQZCGZCDyvlWAyCM0ly6ECTjxIIv2DHPVLdd8xC2oDuJmVSTBf7J6JKFdR94IxZB63SoM1A7J6J36f5snKZCS2uQhGWrH0HRT7SxRo5MavJCphSUOKHZCrFi0Mkln8jPlJB8bZBWNmo",
  },
  {
    page_id: "1021996431004626",
    access_token:
      "EAAUnu2nAp08BRV6ZAuAAjp8pv5RZAqB4d7BwGAY1wVHc9uHhklc6YZCXZC98X7GxxIWXqC47PFHnCApCA7TZCWvNETpfhgZAMvHeVSRDsTWgmmgBPbTdXGSYKwX7WZAO2dZCwfe4PFUrXlQAL9Q3FN8OZBWVcVayB3pa9eHJoz0PhWXx1fL5HGBn1OkxQu4zjdaLGQZAO3cYUjTbUIxfYBZC7c46ZBgv",
  },
  {
    page_id: "1129362243584971",
    access_token:
      "EAAUnu2nAp08BRSOKFfRZBaZB8Eu9NxMoJUN4PyuWvpI0VC7d3F3BuzzOxqOfEkYJOEQ68Pur7mcB4WZAX3WZADNLc1FMo4DZBmLnhdg4rbzZBFunxECAZAZAd407UffINo8640ZBcaZA7ywzLZCvEJxvURhmB4f6i5pPKZBFWeYMdTCY0zDxd5fsElnji3a1ntwqGLpA6kZCn3txM7axCzcepczbL",
  },
];

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
  const graphVersion = String(parsed.graph_version || DEFAULTS.graph_version).trim();

  logs.push(`[input] pages_count=${TARGET_PAGES.length}`);
  logs.push(`[input] media_count=${mediaPaths.length}`);

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip actual API call.");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed.",
        data: {
          caption,
          media_paths: mediaPaths,
          pages: TARGET_PAGES.map((p) => p.page_id),
        },
        logs,
      }),
    );
    return;
  }

  if (mediaPaths.length > 0) {
    try {
      await ensureReadableFiles(mediaPaths);
      logs.push("[step1] Media files verified");
    } catch (e) {
      printResult(
        buildResult({
          success: false,
          message: "Media file not found or inaccessible",
          logs,
          error: { code: "FILE_ERROR", details: e.message },
        }),
      );
      process.exit(1);
    }
  }

  const results = [];
  let hasError = false;

  for (const page of TARGET_PAGES) {
    const pageId = String(page.page_id).trim();
    const accessToken = String(page.access_token).trim();
    logs.push(`\n--- Processing page: ${pageId} ---`);

    try {
      if (mediaPaths.length > 1) {
        logs.push(
          `[step2-${pageId}] Multiple media detected, using attached_media flow for page ${pageId}`,
        );

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
        formData.append("message", caption);
        uploads.forEach((upload, index) => {
          formData.append(
            `attached_media[${index}]`,
            JSON.stringify({ media_fbid: upload.mediaId }),
          );
        });

        logs.push(`[step3-${pageId}] Creating combined feed post...`);
        const response = await fetch(apiUrl, {
          method: "POST",
          body: formData,
        });
        const result = await response.json();
        if (!response.ok || result.error) {
          throw new Error(result.error ? result.error.message : JSON.stringify(result));
        }

        const finalPostId = result.id || result.post_id || result.video_id;
        logs.push(`[step4-${pageId}] Success! FB Response ID: ${finalPostId}`);

        results.push({
          page_id: pageId,
          success: true,
          post_id: finalPostId,
          attached_media_count: uploads.length,
          raw_fb_response: result,
        });
        continue;
      }

      const file = mediaPaths.length > 0 ? mediaPaths[0] : null;
      const ext = file ? path.extname(file).toLowerCase() : "";
      const isVideo = [".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext);

      let endpoint = "/feed";
      if (file) {
        endpoint = isVideo ? "/videos" : "/photos";
      }

      const apiUrl = `https://graph.facebook.com/${graphVersion}/${pageId}${endpoint}`;
      logs.push(`[step2-${pageId}] Target API Endpoint: ${apiUrl}`);

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
        logs.push(`[step3-${pageId}] Attached file: ${file}`);
        const fileBuffer = await readFile(file);
        const mimeType = isVideo ? "video/mp4" : "image/jpeg";
        const blob = new Blob([fileBuffer], { type: mimeType });
        formData.append("source", blob, path.basename(file));
      }

      logs.push(`[step4-${pageId}] Sending HTTP POST request...`);

      const response = await fetch(apiUrl, {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        throw new Error(result.error ? result.error.message : JSON.stringify(result));
      }

      const finalPostId = result.id || result.post_id || result.video_id;
      logs.push(`[step5-${pageId}] Success! FB Response ID: ${finalPostId}`);

      results.push({
        page_id: pageId,
        success: true,
        post_id: finalPostId,
        raw_fb_response: result,
      });
    } catch (error) {
      logs.push(`[fail-${pageId}] Flow failed: ${error.message}`);
      if (/\(#200\)|permissions error/i.test(String(error.message || ""))) {
        logs.push(
          `[hint-${pageId}] Permissions error for page ${pageId}. Check that access token has pages_manage_posts/pages_read_engagement.`,
        );
      }
      results.push({
        page_id: pageId,
        success: false,
        error: error.message,
      });
      hasError = true;
    }
  }

  printResult(
    buildResult({
      success: !hasError,
      message: hasError
        ? "Some or all posts failed to publish"
        : "All Facebook posts published successfully",
      data: {
        results,
      },
      logs,
    }),
  );
})();
