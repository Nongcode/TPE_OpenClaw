const DEFAULTS = {
  page_id: process.env.FACEBOOK_PAGE_ID || "643048852218433",
  access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "",
  limit: 10,
  mode: "recent",
  include_messages: true,
  message_limit: 20,
  graph_version: process.env.FACEBOOK_GRAPH_API_VERSION || "v20.0",
};

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(lowered)) return true;
    if (["false", "0", "no", "n"].includes(lowered)) return false;
  }
  return fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  if (normalized <= 0) return fallback;
  return normalized;
}

function normalizeCliKey(token) {
  return String(token || "")
    .replace(/^--?/, "")
    .trim()
    .replace(/-/g, "_");
}

function tryParseJson(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseKeyValueArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!String(token).startsWith("-")) {
      continue;
    }
    const key = normalizeCliKey(token);
    const next = args[index + 1];

    if (!next || String(next).startsWith("-")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function parseArgs(argv) {
  const params = { ...DEFAULTS };
  const logs = [];
  const args = argv.slice(2);

  const jsonFromSingleArg = args.length === 1 ? tryParseJson(args[0]) : null;
  const jsonFromJoinedArgs = jsonFromSingleArg ? null : tryParseJson(args.join(" "));
  const cliKeyValues = !jsonFromSingleArg && !jsonFromJoinedArgs ? parseKeyValueArgs(args) : null;
  const parsed = jsonFromSingleArg || jsonFromJoinedArgs || cliKeyValues || {};

  return {
    ...params,
    ...parsed,
    limit: parsePositiveInt(parsed.limit, params.limit),
    message_limit: parsePositiveInt(parsed.message_limit, params.message_limit),
    include_messages: parseBoolean(parsed.include_messages, params.include_messages),
    logs,
  };
}

function validateInput(params) {
  const missing = [];
  const mode = String(params.mode || "").trim().toLowerCase();

  if (!String(params.page_id || "").trim()) missing.push("page_id");
  if (!String(params.access_token || "").trim()) missing.push("access_token or FACEBOOK_PAGE_ACCESS_TOKEN");
  if (!["recent", "unreplied"].includes(mode)) missing.push('mode (must be "recent" or "unreplied")');

  return { missing, normalizedMode: mode || "recent" };
}

function toIsoTimestamp(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString();
}

function sortMessagesNewestFirst(messages) {
  return [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.created_time || "");
    const rightTime = Date.parse(right.created_time || "");
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}

function isConversationNeedingReply(conversation) {
  const sorted = sortMessagesNewestFirst(conversation.messages || []);
  if (sorted.length === 0) return false;
  return sorted[0].is_from_page === false;
}

async function fetchGraphJson({ endpoint, params, accessToken, logs }) {
  const url = new URL(`https://graph.facebook.com/${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  if (!url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", accessToken);
  }

  logs.push(`[http:get] ${url.origin}${url.pathname}`);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const errorMessage = payload?.error?.message || `HTTP ${response.status}`;
    const errorCode = payload?.error?.code || response.status;
    throw new Error(`Graph API error (${errorCode}): ${errorMessage}`);
  }

  return payload;
}

async function fetchConversationMessages({ conversationId, accessToken, graphVersion, pageId, messageLimit, logs }) {
  const payload = await fetchGraphJson({
    endpoint: `${graphVersion}/${conversationId}/messages`,
    params: {
      fields: "id,from,to,message,created_time",
      limit: messageLimit,
    },
    accessToken,
    logs,
  });

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map((message) => {
    const fromId = String(message?.from?.id || "");
    return {
      message_id: String(message?.id || ""),
      from_id: fromId,
      from_name: String(message?.from?.name || ""),
      text: String(message?.message || ""),
      created_time: toIsoTimestamp(message?.created_time),
      is_from_page: fromId === pageId,
    };
  });
}

async function loadConversations({ pageId, accessToken, limit, mode, includeMessages, messageLimit, graphVersion, logs }) {
  const basePayload = await fetchGraphJson({
    endpoint: `${graphVersion}/${pageId}/conversations`,
    params: {
      platform: "messenger",
      fields: "id,updated_time,participants",
      limit,
    },
    accessToken,
    logs,
  });

  const rawConversations = Array.isArray(basePayload?.data) ? basePayload.data : [];
  const conversations = [];

  for (const conversation of rawConversations) {
    const conversationId = String(conversation?.id || "");
    const participants = Array.isArray(conversation?.participants?.data)
      ? conversation.participants.data.map((participant) => ({
          id: String(participant?.id || ""),
          name: String(participant?.name || ""),
        }))
      : [];

    const normalized = {
      conversation_id: conversationId,
      updated_time: toIsoTimestamp(conversation?.updated_time),
      participants,
      messages: [],
    };

    if (includeMessages) {
      normalized.messages = await fetchConversationMessages({
        conversationId,
        accessToken,
        graphVersion,
        pageId,
        messageLimit,
        logs,
      });
    }

    conversations.push(normalized);
  }

  if (mode === "unreplied") {
    return conversations.filter((item) => isConversationNeedingReply(item));
  }

  return conversations;
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] facebook_get_page_messages invoked"];

  const { missing, normalizedMode } = validateInput(parsed);
  if (missing.length > 0) {
    printResult(
      buildResult({
        success: false,
        message: "Missing or invalid inputs",
        logs,
        error: { code: "VALIDATION_ERROR", details: missing.join(", ") },
      }),
    );
    process.exit(1);
  }

  const pageId = String(parsed.page_id).trim();
  const accessToken = String(parsed.access_token).trim();
  const limit = parsePositiveInt(parsed.limit, DEFAULTS.limit);
  const messageLimit = parsePositiveInt(parsed.message_limit, DEFAULTS.message_limit);
  const includeMessages = normalizedMode === "unreplied" ? true : parseBoolean(parsed.include_messages, true);
  const graphVersion = String(parsed.graph_version || DEFAULTS.graph_version).trim() || DEFAULTS.graph_version;

  logs.push(`[input] page_id=${pageId}`);
  logs.push(`[input] mode=${normalizedMode}`);
  logs.push(`[input] limit=${limit}`);
  logs.push(`[input] include_messages=${includeMessages}`);

  try {
    const conversations = await loadConversations({
      pageId,
      accessToken,
      limit,
      mode: normalizedMode,
      includeMessages,
      messageLimit,
      graphVersion,
      logs,
    });

    logs.push(`[done] conversations=${conversations.length}`);

    printResult(
      buildResult({
        success: true,
        message: `Fetched ${conversations.length} conversation(s) from page inbox`,
        data: {
          page_id: pageId,
          mode: normalizedMode,
          include_messages: includeMessages,
          conversations,
        },
        logs,
      }),
    );
  } catch (error) {
    logs.push(`[fail] ${error instanceof Error ? error.message : String(error)}`);
    printResult(
      buildResult({
        success: false,
        message: "Failed to fetch page conversations",
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
