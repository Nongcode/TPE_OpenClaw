/**
 * trend_analyzer/action.js — Lấy hashtag/keyword hot từ Google Trends.
 *
 * Input JSON (argv[2]):
 *   { "keyword": "máy nâng", "geo": "VN", "count": 5 }
 *
 * Output JSON (stdout):
 *   { "success": true, "data": { "trends": [...], "related_queries": [...] } }
 *
 * Degrade gracefully: nếu API lỗi, trả mảng rỗng thay vì crash.
 */

const DEFAULTS = {
  keyword: "",
  geo: "VN",
  count: 5,
};

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const params = { ...DEFAULTS };

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      return { ...params, ...JSON.parse(args[0]) };
    } catch {
      // Invalid JSON, use defaults
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;

    if (token === "--keyword") { params.keyword = next; index += 1; continue; }
    if (token === "--geo") { params.geo = next; index += 1; continue; }
    if (token === "--count") { params.count = Number(next); index += 1; continue; }
  }

  return params;
}

/**
 * Chuyển keyword thành dạng hashtag an toàn.
 */
function toHashtag(text) {
  return (
    "#" +
    String(text || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[đĐ]/g, "d")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "")
      .toLowerCase()
  );
}

/**
 * Thử load google-trends-api. Trả null nếu không có.
 */
function tryLoadGoogleTrends() {
  try {
    return require("google-trends-api");
  } catch {
    return null;
  }
}

async function fetchRelatedQueries(googleTrends, keyword, geo) {
  try {
    const result = await googleTrends.relatedQueries({
      keyword,
      geo,
      hl: "vi",
    });

    const parsed = JSON.parse(result);
    const queries = [];

    const defaultData = parsed?.default?.rankedList || [];
    for (const list of defaultData) {
      if (Array.isArray(list?.rankedKeyword)) {
        for (const item of list.rankedKeyword) {
          if (item?.query) {
            queries.push(item.query);
          }
        }
      }
    }

    return queries;
  } catch {
    return [];
  }
}

async function fetchRelatedTopics(googleTrends, keyword, geo) {
  try {
    const result = await googleTrends.relatedTopics({
      keyword,
      geo,
      hl: "vi",
    });

    const parsed = JSON.parse(result);
    const topics = [];

    const defaultData = parsed?.default?.rankedList || [];
    for (const list of defaultData) {
      if (Array.isArray(list?.rankedKeyword)) {
        for (const item of list.rankedKeyword) {
          if (item?.topic?.title) {
            topics.push(item.topic.title);
          }
        }
      }
    }

    return topics;
  } catch {
    return [];
  }
}

async function main() {
  const params = parseArgs(process.argv);
  const keyword = String(params.keyword || "").trim();

  if (!keyword) {
    printJson({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Missing keyword" },
    });
    process.exit(1);
    return;
  }

  const geo = params.geo || "VN";
  const count = Math.min(Math.max(1, params.count || 5), 20);

  const googleTrends = tryLoadGoogleTrends();

  if (!googleTrends) {
    // Package không có → degrade gracefully
    printJson({
      success: true,
      data: {
        keyword,
        geo,
        trends: [],
        related_queries: [],
        fetched_at: new Date().toISOString(),
        note: "google-trends-api not installed. Run: npm install google-trends-api",
      },
    });
    return;
  }

  try {
    const [queries, topics] = await Promise.all([
      fetchRelatedQueries(googleTrends, keyword, geo),
      fetchRelatedTopics(googleTrends, keyword, geo),
    ]);

    // Combine và dedup
    const allTerms = [...new Set([...queries, ...topics])];
    const trends = allTerms
      .slice(0, count)
      .map((term) => toHashtag(term))
      .filter((h) => h.length > 1);

    printJson({
      success: true,
      data: {
        keyword,
        geo,
        trends,
        related_queries: queries.slice(0, count),
        fetched_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    // API error → degrade gracefully
    printJson({
      success: true,
      data: {
        keyword,
        geo,
        trends: [],
        related_queries: [],
        fetched_at: new Date().toISOString(),
        note: `Google Trends API error: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }
}

main().catch((error) => {
  printJson({
    success: false,
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exit(1);
});
