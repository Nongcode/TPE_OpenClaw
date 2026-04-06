const DEFAULTS = {
  page_id: process.env.FACEBOOK_PAGE_ID || "643048852218433",
  access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "EAANUeplbZCAwBRDtmbZCZAXJH6xt1Wavxe0OiZAbIBV2nFwFZApZC6GsP0nKXO1BrMBoBaDUZBMpOjCOZAyUL9zC2iQh9spFumXC2KcT1THFvZCBjLeONUfyw4R7a0ZCn3bZAqNRglxjrh3GOVtZCIObHg3ArMqfOZC7RIJo6rvSn2FszW45e4KZCXfSAwddj5WRXmpnotnmoMzDwf1N6Myc6bb6py",
  recipient_id: "",
  reply_text: "",
  dry_run: false,
  graph_version: process.env.FACEBOOK_GRAPH_API_VERSION || "v20.0",
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(lowered)) return true;
    if (["0", "false", "no", "n"].includes(lowered)) return false;
  }
  return fallback;
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
        dry_run: parseBoolean(parsed.dry_run ?? parsed["dry-run"], false),
        logs,
      };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
      return { ...params, logs };
    }
  }

  return { ...params, logs };
}

function validateInput(params) {
  const missing = [];
  const dryRun = parseBoolean(params.dry_run, false);
  if (!String(params.page_id || "").trim()) missing.push("page_id");
  if (!dryRun && !String(params.access_token || "").trim()) {
    missing.push("access_token or FACEBOOK_PAGE_ACCESS_TOKEN");
  }
  if (!String(params.recipient_id || "").trim()) missing.push("recipient_id");
  if (!String(params.reply_text || "").trim()) missing.push("reply_text");
  return missing;
}

async function postGraphMessage({ endpoint, body, accessToken, logs }) {
  const url = `https://graph.facebook.com/${endpoint}`;
  logs.push(`[http:post] ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const errorMessage = payload?.error?.message || `HTTP ${response.status}`;
    const errorCode = payload?.error?.code || response.status;
    throw new Error(`Graph API error (${errorCode}): ${errorMessage}`);
  }

  return payload;
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] facebook_reply_page_message invoked"];

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

  const pageId = String(parsed.page_id).trim();
  const accessToken = String(parsed.access_token).trim();
  const recipientId = String(parsed.recipient_id).trim();
  const replyText = String(parsed.reply_text).trim();
  const dryRun = parseBoolean(parsed.dry_run, false);
  const graphVersion = String(parsed.graph_version || DEFAULTS.graph_version).trim() || DEFAULTS.graph_version;
  const endpoint = `${graphVersion}/${pageId}/messages`;

  logs.push(`[input] page_id=${pageId}`);
  logs.push(`[input] recipient_id=${recipientId}`);
  logs.push(`[input] dry_run=${dryRun}`);

  if (dryRun) {
    logs.push(`[dry-run] Skip send to recipient_id=${recipientId}`);
    printResult(
      buildResult({
        success: true,
        message: "Dry run completed. Reply was not sent.",
        data: {
          page_id: pageId,
          recipient_id: recipientId,
          reply_text: replyText,
          dry_run: true,
        },
        logs,
      }),
    );
    return;
  }

  try {
    const payload = await postGraphMessage({
      endpoint,
      accessToken,
      logs,
      body: {
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: replyText },
      },
    });

    logs.push(`[done] Sent message successfully to recipient_id=${recipientId}`);

    printResult(
      buildResult({
        success: true,
        message: "Reply sent successfully via Facebook Messenger API",
        data: {
          page_id: pageId,
          recipient_id: recipientId,
          messaging_product: "messenger",
          response: payload,
          dry_run: false,
        },
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] recipient_id=${recipientId} :: ${error instanceof Error ? error.message : String(error)}`);
    printResult(
      buildResult({
        success: false,
        message: "Failed to send page reply",
        logs,
        error: {
          code: "API_ERROR",
          details: error instanceof Error ? error.message : String(error),
        },
      }),
    );
    process.exit(1);
  }
})();
