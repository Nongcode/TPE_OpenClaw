const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { normalizeText } = require("./common");

const PRODUCT_INTRO_PATTERNS = [
  /(?:san pham|sản phẩm|model|mau|mẫu)\s*[:\-]\s*(.+)$/iu,
  /(?:viet bai|tao bai|dang bai|dang facebook|lam media|quang ba|trien khai)\s+(?:cho|ve|về)\s+(.+)$/iu,
  /(?:cho|ve|về)\s+(.+)$/iu,
];

const PRODUCT_STOP_PHRASES = [
  "de viet bai",
  "de dang facebook",
  "de dang face",
  "de lam media",
  "de tao anh",
  "de tao video",
  "roi dang",
  "va dang",
  "va lam media",
  "va tao media",
  "de toi duyet",
  "de trinh duyet",
];

function resolveCacheDir(options = {}) {
  if (options.productResearchCacheDir) {
    return path.resolve(options.productResearchCacheDir);
  }
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  return path.join(repoRoot, "artifacts", "cache", "product-research");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildCacheKey(keyword, targetSite) {
  return normalizeText(`${targetSite} ${keyword}`)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function readCachedResearch(keyword, targetSite, options = {}) {
  if (options.disableProductResearchCache) {
    return null;
  }
  const ttlMs =
    Number.isFinite(Number(options.productResearchCacheTtlMs)) && Number(options.productResearchCacheTtlMs) >= 0
      ? Number(options.productResearchCacheTtlMs)
      : 6 * 60 * 60 * 1000;
  const cacheFile = path.join(resolveCacheDir(options), `${buildCacheKey(keyword, targetSite)}.json`);
  if (!fs.existsSync(cacheFile)) {
    return null;
  }
  try {
    const stat = fs.statSync(cacheFile);
    if (ttlMs === 0 || Date.now() - stat.mtimeMs > ttlMs) {
      return null;
    }
    const payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!payload?.success || !payload?.data?.product_name) {
      return null;
    }
    return {
      ...payload,
      cacheHit: true,
      cacheFile,
    };
  } catch {
    return null;
  }
}

function writeCachedResearch(keyword, targetSite, payload, options = {}) {
  if (options.disableProductResearchCache) {
    return;
  }
  const cacheDir = resolveCacheDir(options);
  ensureDir(cacheDir);
  const cacheFile = path.join(cacheDir, `${buildCacheKey(keyword, targetSite)}.json`);
  fs.writeFileSync(cacheFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function extractQuotedKeyword(source) {
  const match = String(source || "").match(/["“](.+?)["”]/u);
  return match?.[1]?.trim() || "";
}

function sanitizeKeywordCandidate(value) {
  let cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-,\s]+/u, "")
    .replace(/[.?!,\s]+$/u, "");

  for (const phrase of PRODUCT_STOP_PHRASES) {
    const normalizedCleaned = normalizeText(cleaned);
    const normalizedPhrase = normalizeText(phrase);
    const index = normalizedCleaned.indexOf(normalizedPhrase);
    if (index > 0) {
      cleaned = cleaned.slice(0, index).trim().replace(/[,:;\-\s]+$/u, "");
    }
  }

  return cleaned;
}

function looksLikeProductKeyword(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  const banned = [
    "viet bai",
    "dang facebook",
    "dang bai",
    "lam media",
    "tao anh",
    "tao video",
    "trinh duyet",
    "toi duyet",
  ];
  return !banned.some((phrase) => normalized === phrase || normalized.startsWith(`${phrase} `));
}

function extractKeywordByIntentPatterns(source) {
  for (const pattern of PRODUCT_INTRO_PATTERNS) {
    const match = String(source || "").match(pattern);
    if (match?.[1]) {
      const candidate = sanitizeKeywordCandidate(match[1]);
      if (looksLikeProductKeyword(candidate)) {
        return candidate;
      }
    }
  }
  return "";
}

function extractKeywordAfterProductPhrase(source) {
  const patterns = [
    /sản phẩm\s+(.+?)(?=$|[.?!,\n])/iu,
    /san pham\s+(.+?)(?=$|[.?!,\n])/iu,
    /về\s+(.+?)(?=$|[.?!,\n])/iu,
    /ve\s+(.+?)(?=$|[.?!,\n])/iu,
  ];

  for (const pattern of patterns) {
    const match = String(source || "").match(pattern);
    if (match?.[1]?.trim()) {
      const candidate = sanitizeKeywordCandidate(match[1]);
      if (looksLikeProductKeyword(candidate)) {
        return candidate;
      }
    }
  }

  return "";
}

function resolveKeyword(step, plan, options) {
  if (options?.productKeyword && String(options.productKeyword).trim()) {
    return sanitizeKeywordCandidate(String(options.productKeyword).trim());
  }
  const source = step?.message || plan?.message || "";
  return (
    extractQuotedKeyword(source) ||
    extractKeywordByIntentPatterns(source) ||
    extractKeywordAfterProductPhrase(source) ||
    sanitizeKeywordCandidate(String(source).trim())
  );
}

function runProductResearch(step, plan, options = {}) {
  const keyword = resolveKeyword(step, plan, options);
  if (!keyword) {
    throw new Error("Missing product keyword for product research.");
  }

  const targetSite = String(options.targetSite || "uptek.vn").trim();
  const cached = readCachedResearch(keyword, targetSite, options);
  if (cached) {
    options.onProgress?.({
      phase: "product-research-cache-hit",
      message: `Product research cache hit cho "${keyword}" (${targetSite}).`,
      keyword,
      targetSite,
      cacheFile: cached.cacheFile,
    });
    return cached;
  }
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const scriptPath = path.join(repoRoot, "skills", "search_product_text", "action.js");
  const attempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const run = spawnSync(
      process.execPath,
      [scriptPath, "--keyword", keyword, "--target_site", targetSite],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 25 * 1024 * 1024,
      },
    );

    try {
      if (run.error) {
        const e = run.error instanceof Error ? run.error : new Error(String(run.error));
        e.stdout = run.stdout;
        e.stderr = run.stderr;
        throw e;
      }

      const stdout = String(run.stdout || "").trim();
      if (!stdout) {
        const e = new Error("search_product_text returned empty stdout.");
        e.stdout = stdout;
        e.stderr = run.stderr;
        throw e;
      }

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        const e = new Error("search_product_text returned non-JSON output.");
        e.stdout = stdout;
        e.stderr = run.stderr;
        throw e;
      }

      if (!payload?.success) {
        const e = new Error(payload?.error?.message || "search_product_text failed.");
        e.stdout = stdout;
        e.stderr = run.stderr;
        throw e;
      }

      const result = {
        command: `${process.execPath} ${scriptPath} --keyword "${keyword}" --target_site "${targetSite}"`,
        targetSite,
        keyword,
        researchAttempt: attempt,
        ...payload,
      };
      writeCachedResearch(keyword, targetSite, result, options);
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function normalizeSlugToName(value) {
  return String(value || "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function selectFallbackReferenceDir(baseDir, keyword) {
  if (!fs.existsSync(baseDir)) {
    return null;
  }

  const entries = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(baseDir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        name: entry.name,
        fullPath,
        mtimeMs: stat.mtimeMs,
      };
    });

  if (entries.length === 0) {
    return null;
  }

  const keywordTokens = normalizeForMatch(keyword)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  let best = null;
  for (const item of entries) {
    const normalizedName = normalizeForMatch(item.name);
    const score = keywordTokens.reduce(
      (total, token) => (normalizedName.includes(token) ? total + 1 : total),
      0,
    );
    const ranked = {
      ...item,
      score,
    };

    if (!best) {
      best = ranked;
      continue;
    }

    if (ranked.score > best.score || (ranked.score === best.score && ranked.mtimeMs > best.mtimeMs)) {
      best = ranked;
    }
  }

  return best?.fullPath || null;
}

function createDemoProductResearchFallback(step, plan, options = {}) {
  const keyword = resolveKeyword(step, plan, options);
  const targetSite = String(options.targetSite || "uptek.vn").trim();
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const referenceBase = path.join(repoRoot, "artifacts", "references", "search_product_text");
  const selectedDir = selectFallbackReferenceDir(referenceBase, keyword);

  if (!selectedDir) {
    throw new Error("No cached product research reference directory found for demo fallback.");
  }

  const imageFiles = fs
    .readdirSync(selectedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.(webp|png|jpe?g)$/i.test(name));

  const images = imageFiles.map((fileName, index) => ({
    file_path: path.join(selectedDir, fileName),
    file_name: fileName,
    is_primary: index === 0,
    source: "demo_fallback",
  }));

  const folderName = path.basename(selectedDir);
  const productName = normalizeSlugToName(folderName) || keyword;

  return {
    command: "[demo-fallback] use cached artifacts/references/search_product_text",
    targetSite,
    keyword,
    success: true,
    data: {
      product_name: productName,
      product_url: `https://${targetSite}/shop`,
      source_url: `https://${targetSite}/shop`,
      category: "Cau nang",
      categories: [{ id: "demo", name: "Cau nang", url: `https://${targetSite}/shop` }],
      specifications_text: "Demo fallback du lieu san pham tu cache local.",
      images,
      primary_image: images[0] || null,
      image_download_dir: selectedDir,
    },
    demoFallback: true,
  };
}

module.exports = {
  createDemoProductResearchFallback,
  readCachedResearch,
  resolveKeyword,
  runProductResearch,
  writeCachedResearch,
};
