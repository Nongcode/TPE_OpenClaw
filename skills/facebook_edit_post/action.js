import { access } from "node:fs/promises";

const DEFAULTS = {
  post_id: "643048852218433",
  access_token: "EAANUeplbZCAwBRDtmbZCZAXJH6xt1Wavxe0OiZAbIBV2nFwFZApZC6GsP0nKXO1BrMBoBaDUZBMpOjCOZAyUL9zC2iQh9spFumXC2KcT1THFvZCBjLeONUfyw4R7a0ZCn3bZAqNRglxjrh3GOVtZCIObHg3ArMqfOZC7RIJo6rvSn2FszW45e4KZCXfSAwddj5WRXmpnotnmoMzDwf1N6Myc6bb6py",
  dry_run: false,
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const hasCaption = (typeof params.caption_long === "string" && params.caption_long.trim() !== "") || 
                     (typeof params.caption_short === "string" && params.caption_short.trim() !== "");
  
  if (!hasCaption) missing.push("caption_long_or_caption_short (Nội dung mới)");
  if (!params.post_id || String(params.post_id).trim() === "") missing.push("post_id");
  if (!params.access_token || String(params.access_token).trim() === "") missing.push("access_token");
  
  return missing;
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] facebook_edit_post (Graph API) invoked"];
  
  const missing = validateInput(parsed);
  if (missing.length > 0) {
    printResult(buildResult({ success: false, message: "Missing required inputs", logs, error: { code: "VALIDATION_ERROR", details: missing.join(", ") }}));
    process.exit(1);
  }

  // Lấy nội dung mới
  const newCaption = (typeof parsed.caption_long === "string" && parsed.caption_long.trim() !== "")
    ? parsed.caption_long.trim()
    : parsed.caption_short.trim();
  
  const postId = String(parsed.post_id).trim();
  const accessToken = String(parsed.access_token).trim();

  logs.push(`[input] post_id=${postId}`);

  if (parsed.dry_run) {
    logs.push("[dry-run] Skip actual API call.");
    printResult(buildResult({ success: true, message: "Dry run completed.", data: { post_id: postId, new_caption: newCaption }, logs }));
    return;
  }

  try {
    // Để sửa bài, chúng ta gọi POST request thẳng vào ID của bài viết
    const apiUrl = `https://graph.facebook.com/v20.0/${postId}`;
    logs.push(`[step1] Target API Endpoint: ${apiUrl}`);

    const formData = new FormData();
    formData.append("access_token", accessToken);
    formData.append("message", newCaption); // 'message' là trường để cập nhật văn bản

    logs.push("[step2] Sending HTTP POST request to Facebook Graph API to update post...");
    
    const response = await fetch(apiUrl, {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (!response.ok || result.error) {
      throw new Error(result.error ? result.error.message : JSON.stringify(result));
    }

    logs.push(`[step3] Post updated successfully!`);

    printResult(buildResult({
      success: true,
      message: "Facebook post updated successfully via Graph API",
      data: {
        post_id: postId,
        success: result.success, // API thường trả về { success: true } khi sửa thành công
        raw_fb_response: result
      },
      logs
    }));

  } catch (error) {
    logs.push(`[fail] Flow failed: ${error.message}`);
    printResult(buildResult({
      success: false,
      message: "Failed to update post via Graph API",
      logs,
      error: { code: "API_ERROR", details: error.message }
    }));
    process.exit(1);
  }
})();
