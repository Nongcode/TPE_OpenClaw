import { loadFacebookEnv } from "../facebook_shared/load-env.js";

loadFacebookEnv();

const DEFAULTS = {
  page_id: process.env.FACEBOOK_PAGE_ID || "1131157960071384",
  access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || process.env.PAGE_ACCESS_TOKEN || "",
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
        page_ids: parseList(parsed.page_ids),
        post_ids: parseList(parsed.post_ids),
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
  const hasPostId =
    (typeof params.post_id === "string" && params.post_id.trim() !== "") ||
    parseList(params.post_ids).length > 0;
  const hasCaption =
    (typeof params.caption_long === "string" && params.caption_long.trim() !== "") ||
    (typeof params.caption_short === "string" && params.caption_short.trim() !== "");

  if (!hasCaption) missing.push("caption_long_or_caption_short (Nội dung mới)");
  if (!hasPostId) missing.push("post_id_or_post_ids");

  return missing;
}

function buildPageMap() {
  return new Map(
    TARGET_PAGES.map((page) => [
      String(page.page_id).trim(),
      {
        page_id: String(page.page_id).trim(),
        access_token: String(page.access_token).trim(),
      },
    ]),
  );
}

function inferPageIdFromPostId(postId) {
  const normalized = String(postId || "").trim();
  const separatorIndex = normalized.indexOf("_");
  if (separatorIndex <= 0) return "";
  return normalized.slice(0, separatorIndex);
}

function normalizeCanonicalPostId(postId, pageId) {
  const normalizedPostId = String(postId || "").trim();
  const normalizedPageId = String(pageId || "").trim();
  if (!normalizedPostId) return "";
  if (normalizedPostId.includes("_") || !normalizedPageId) return normalizedPostId;
  return `${normalizedPageId}_${normalizedPostId}`;
}

function resolveEditTargets(params) {
  const pageMap = buildPageMap();
  const explicitPageId = String(params.page_id || "").trim();
  const explicitAccessToken = String(params.access_token || "").trim();
  const requestedPageIds = parseList(params.page_ids);
  const rawPostIds = [
    ...parseList(params.post_ids),
    ...(typeof params.post_id === "string" && params.post_id.trim() !== ""
      ? [params.post_id.trim()]
      : []),
  ];
  const errors = [];
  const targets = [];

  for (const rawPostId of rawPostIds) {
    let pageId = inferPageIdFromPostId(rawPostId);

    if (!pageId && requestedPageIds.length === 1) {
      pageId = requestedPageIds[0];
    }
    if (!pageId && explicitPageId) {
      pageId = explicitPageId;
    }

    if (requestedPageIds.length > 0 && pageId && !requestedPageIds.includes(pageId)) {
      errors.push(`post_id ${rawPostId} does not belong to selected page_ids`);
      continue;
    }

    const configuredPage = pageId ? pageMap.get(pageId) : null;
    const accessToken =
      explicitAccessToken && (!pageId || pageId === explicitPageId)
        ? explicitAccessToken
        : configuredPage?.access_token || "";

    if (!pageId) {
      errors.push(`Cannot infer page_id for post_id ${rawPostId}. Provide page_id or canonical post_id.`);
      continue;
    }

    if (!accessToken) {
      errors.push(`No access token configured for page_id ${pageId}`);
      continue;
    }

    targets.push({
      page_id: pageId,
      post_id: normalizeCanonicalPostId(rawPostId, pageId),
      access_token: accessToken,
    });
  }

  return { targets, errors };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] facebook_edit_post (Graph API) invoked"];

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

  const newCaption =
    typeof parsed.caption_long === "string" && parsed.caption_long.trim() !== ""
      ? parsed.caption_long.trim()
      : parsed.caption_short.trim();
  const graphVersion = String(parsed.graph_version || DEFAULTS.graph_version).trim();
  const { targets, errors } = resolveEditTargets(parsed);

  if (errors.length > 0) {
    printResult(
      buildResult({
        success: false,
        message: "Invalid edit targets",
        logs,
        error: { code: "TARGET_RESOLUTION_ERROR", details: errors.join("; ") },
      }),
    );
    process.exit(1);
  }

  logs.push(`[input] edit_targets=${targets.length}`);
  logs.push(`[input] target_pages=${[...new Set(targets.map((target) => target.page_id))].join(",")}`);

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip actual API call.");
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed.",
        data: {
          new_caption: newCaption,
          targets: targets.map((target) => ({
            page_id: target.page_id,
            post_id: target.post_id,
          })),
        },
        logs,
      }),
    );
    return;
  }

  const results = [];
  let hasError = false;

  for (const target of targets) {
    try {
      const apiUrl = `https://graph.facebook.com/${graphVersion}/${target.post_id}`;
      logs.push(`[step1-${target.page_id}] Target API Endpoint: ${apiUrl}`);

      const formData = new FormData();
      formData.append("access_token", target.access_token);
      formData.append("message", newCaption);

      logs.push(
        `[step2-${target.page_id}] Sending HTTP POST request to Facebook Graph API to update post...`,
      );

      const response = await fetch(apiUrl, {
        method: "POST",
        body: formData,
      });

      const result = await response.json();

      if (!response.ok || result.error) {
        throw new Error(result.error ? result.error.message : JSON.stringify(result));
      }

      logs.push(`[step3-${target.page_id}] Post updated successfully!`);
      results.push({
        page_id: target.page_id,
        post_id: target.post_id,
        success: result.success === undefined ? true : result.success,
        raw_fb_response: result,
      });
    } catch (error) {
      logs.push(`[fail-${target.page_id}] Flow failed: ${error.message}`);
      if (/\(#200\)|permissions error/i.test(String(error.message || ""))) {
        logs.push(
          `[hint-${target.page_id}] Facebook Graph API rejected the edit request with a permissions error. Check that the configured page token can manage the target post and page.`,
        );
      }
      results.push({
        page_id: target.page_id,
        post_id: target.post_id,
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
        ? "Some or all Facebook post edits failed"
        : results.length > 1
          ? "Facebook posts updated successfully via Graph API"
          : "Facebook post updated successfully via Graph API",
      data: {
        results,
      },
      logs,
      error: hasError ? { code: "API_ERROR", details: "One or more post updates failed" } : null,
    }),
  );

  if (hasError) {
    process.exit(1);
  }
})();
