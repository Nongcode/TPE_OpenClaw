const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function extractQuotedKeyword(source) {
  const match = String(source || "").match(/["“](.+?)["”]/u);
  return match?.[1]?.trim() || "";
}

function extractKeywordAfterProductPhrase(source) {
  const patterns = [
    /sản phẩm\s+(.+?)(?=$|[.?!\n])/iu,
    /san pham\s+(.+?)(?=$|[.?!\n])/iu,
    /về\s+(.+?)(?=$|[.?!\n])/iu,
    /ve\s+(.+?)(?=$|[.?!\n])/iu,
  ];

  for (const pattern of patterns) {
    const match = String(source || "").match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim().replace(/^[:\-–]\s*/u, "");
    }
  }

  return "";
}

function resolveKeyword(step, plan, options) {
  if (options?.productKeyword && String(options.productKeyword).trim()) {
    return String(options.productKeyword).trim();
  }
  const source = step?.message || plan?.message || "";
  return (
    extractQuotedKeyword(source) ||
    extractKeywordAfterProductPhrase(source) ||
    String(source).trim()
  );
}

function runProductResearch(step, plan, options = {}) {
function normalizeTextField(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMultilineField(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => normalizeTextField(line))
    .filter(Boolean)
    .join("\n");
}

function normalizeCategoryList(data) {
  const candidates = [];

  const categoryObject = data?.category;
  if (categoryObject && typeof categoryObject === "object" && !Array.isArray(categoryObject)) {
    const objectName = normalizeTextField(categoryObject?.name || categoryObject?.label);
    if (objectName) {
      candidates.push({
        id: normalizeTextField(categoryObject?.id),
        name: objectName,
        url: normalizeTextField(categoryObject?.url),
      });
    }
  }

  if (Array.isArray(data?.categories)) {
    candidates.push(
      ...data.categories.map((item) => {
        if (typeof item === "string") {
          return { id: "", name: normalizeTextField(item), url: "" };
        }
        return {
          id: normalizeTextField(item?.id),
          name: normalizeTextField(item?.name || item?.label),
          url: normalizeTextField(item?.url),
        };
      }),
    );
  }
  const singleCategory =
    typeof data?.category === "string" ? normalizeTextField(data.category) : "";
  if (singleCategory) {
    candidates.push({ id: "", name: singleCategory, url: "" });
  }

  const seen = new Set();
  return candidates
    .filter((item) => item.name)
    .filter((item) => {
      const key = item.name.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function normalizeImages(data) {
  const source = Array.isArray(data?.images) ? data.images : [];
  const normalized = source
    .map((item, index) => {
      const filePath = normalizeTextField(item?.file_path || item?.path || item?.url);
      if (!filePath) {
        return null;
      }
      const fileName = normalizeTextField(item?.file_name) || path.basename(filePath);
      return {
        file_path: filePath,
        file_name: fileName,
        is_primary: Boolean(item?.is_primary) || index === 0,
        source: normalizeTextField(item?.source) || "search_product_text",
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) {
    normalized[0].is_primary = true;
  }
  return normalized;
}

function normalizeResearchPayload(payload, keyword, targetSite) {
  const data = payload?.data || {};
  const productName = normalizeTextField(data.product_name) || normalizeTextField(keyword);
  const productUrl = normalizeTextField(data.product_url || data.source_url);
  const categories = normalizeCategoryList(data);
  const category = normalizeTextField(data.category) || categories[0]?.name || "";
  const images = normalizeImages(data);
  const imageDownloadDir = normalizeTextField(data.image_download_dir);

  return {
    ...payload,
    data: {
      ...data,
      product_name: productName,
      product_url: productUrl,
      source_url: normalizeTextField(data.source_url || productUrl),
      category,
      categories,
      specifications_text: normalizeMultilineField(data.specifications_text),
      long_description: normalizeMultilineField(data.long_description),
      image_download_dir: imageDownloadDir,
      images,
      primary_image: images[0] || null,
      target_site: normalizeTextField(data.target_site || targetSite),
    },
  };
}
  const keyword = resolveKeyword(step, plan, options);
  if (!keyword) {
    throw new Error("Missing product keyword for product research.");
  }

  const targetSite = String(options.targetSite || "uptek.vn").trim();
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
        throw run.error;
      }

      const stdout = String(run.stdout || "").trim();
      if (!stdout) {
        throw new Error("search_product_text returned empty stdout.");
      }

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        throw new Error("search_product_text returned non-JSON output.");
      }

      if (!payload?.success) {
        throw new Error(payload?.error?.message || "search_product_text failed.");
      }

          const normalizedPayload = normalizeResearchPayload(payload, keyword, targetSite);

          return {
        command: `${process.execPath} ${scriptPath} --keyword \"${keyword}\" --target_site \"${targetSite}\"`,
        targetSite,
        keyword,
        researchAttempt: attempt,
            ...normalizedPayload,
      };
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
  runProductResearch,
};
