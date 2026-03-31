const DEFAULTS = {
  post_id: "",
  access_token: "EAANUeplbZCAwBRO6PjQwIBIMCUkZCQngYX0CsdSmJUS7I34CjTxq4AulnpdhV2D3vGZCmMXTw6qYfdZCE471IEkDVOMZBIdGKKUJHCyCLGQZA0WxhUETLxgpQ0yAKEUogXWxulpo0pXyovxxNBpPOMToLyIEAZCpDiwqFYvaEku1lRuHtfsEG7r706bW7DesPwTTC3sbdiaxlrOKmN2WRDA9IzW", // Nhớ dán lại token của bạn vào đây nhé
};

function buildResult({ success, message, data = {}, logs = [], error = null }) {
  return { success, message, data, logs, error };
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
      return { ...params, ...parsed, logs };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error.message}`);
    }
  }
  return { ...params, logs };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] facebook_get_post_metrics invoked"];
  
  const postId = String(parsed.post_id || "").trim();
  const accessToken = String(parsed.access_token || "").trim();

  if (!postId || !accessToken) {
    printResult(buildResult({ 
      success: false, 
      message: "Missing inputs", 
      logs, 
      error: { code: "VALIDATION_ERROR", details: "Requires post_id and access_token" }
    }));
    process.exit(1);
  }

  logs.push(`[input] post_id=${postId}`);

  try {
    // SỬA LỖI Ở ĐÂY: Thêm {message,from,created_time} để lấy chi tiết 50 comment mới nhất
    const fields = "likes.summary(true).limit(0),comments.summary(true).limit(50){message,from,created_time}";
    const apiUrl = `https://graph.facebook.com/v20.0/${postId}?fields=${fields}&access_token=${accessToken}`;
    
    logs.push("[step1] Fetching metrics and comments data from Facebook Graph API...");
    
    const response = await fetch(apiUrl);
    const result = await response.json();

    if (!response.ok || result.error) {
      throw new Error(result.error ? result.error.message : JSON.stringify(result));
    }

    // Bóc tách số liệu tổng quan
    const likesCount = result.likes?.summary?.total_count || 0;
    const commentsCount = result.comments?.summary?.total_count || 0;
    
    // Bóc tách danh sách chi tiết các comment
    const rawComments = result.comments?.data || [];
    const commentsList = rawComments.map(c => ({
      customer_name: c.from?.name || "Người dùng ẩn danh",
      customer_id: c.from?.id || "",
      message: c.message || "",
      time: c.created_time || ""
    }));

    logs.push(`[step2] Metrics retrieved: Likes=${likesCount}, Comments=${commentsCount}`);
    logs.push(`[step3] Extracted ${commentsList.length} comment details.`);

    printResult(buildResult({
      success: true,
      message: "Metrics and comments retrieved successfully",
      data: {
        post_id: postId,
        metrics: {
          likes: likesCount,
          comments_count: commentsCount
        },
        comments_data: commentsList // Trả về toàn bộ data comment ở đây
      },
      logs
    }));

  } catch (error) {
    logs.push(`[fail] Flow failed: ${error.message}`);
    printResult(buildResult({
      success: false,
      message: "Failed to retrieve metrics",
      logs,
      error: { code: "API_ERROR", details: error.message }
    }));
    process.exit(1);
  }
})();
