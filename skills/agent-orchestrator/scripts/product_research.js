const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function stripQuotedEdges(value) {
  return String(value || "")
    .trim()
    .replace(/^["'“”‘’\s]+/, "")
    .replace(/["'“”‘’\s]+$/, "")
    .trim();
}

function cleanKeywordCandidate(value) {
  return stripQuotedEdges(
    String(value || "")
      .replace(/^(là|la|là:|la:)\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function extractProductKeywordFromMessage(source) {
  const text = String(source || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const labeledPatterns = [
    /TEN_SAN_PHAM:\s*([^.\n]+?)(?=\s+(?:URL_SAN_PHAM|DANH_MUC|THONG_SO|THU_MUC_ANH_GOC|$))/i,
    /Tên sản phẩm(?: chuẩn)?\s*:\s*([^?\n]+?)(?=\s+(?:URL|Chất liệu|Kích thước|Đối tượng|CTA|$))/i,
  ];
  for (const pattern of labeledPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = cleanKeywordCandidate(match[1]);
      if (candidate) {
        return candidate;
      }
    }
  }

  const inlinePatterns = [
    /quảng bá sản phẩm\s+(.+?)(?=\s+(?:để|de|voi|với|trình|review|duyệt|dang|đăng|Yêu cầu:|yeu cau:|$))/i,
    /viết bài(?: Facebook)?(?: quảng bá)?\s+(?:cho|về)\s+(.+?)(?=\s+(?:để|de|voi|với|trình|review|duyệt|dang|đăng|Yêu cầu:|yeu cau:|$))/i,
    /cho\s+(.+?)(?=\s+(?:để|de|trình|review|duyệt|dang|đăng|Yêu cầu:|yeu cau:|$))/i,
  ];

  for (const pattern of inlinePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = cleanKeywordCandidate(match[1]);
      if (candidate && candidate.length <= 160) {
        return candidate;
      }
    }
  }

  return "";
}

function resolveKeyword(step, plan, options) {
  if (options?.productKeyword && String(options.productKeyword).trim()) {
    return String(options.productKeyword).trim();
  }
  const source = step?.message || plan?.message || "";
  return extractProductKeywordFromMessage(source) || String(source).trim();
}

function runProductResearch(step, plan, options = {}) {
  const keyword = resolveKeyword(step, plan, options);
  if (!keyword) {
    throw new Error("Missing product keyword for product research.");
  }

  const targetSite = String(options.targetSite || "uptek.vn").trim();
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const scriptPath = path.join(repoRoot, "skills", "search_product_text", "action.js");

  const run = spawnSync(
    process.execPath,
    [scriptPath, "--keyword", keyword, "--target_site", targetSite],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 25 * 1024 * 1024,
    },
  );

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

  return {
    command: `${process.execPath} ${scriptPath} --keyword \"${keyword}\" --target_site \"${targetSite}\"`,
    targetSite,
    keyword,
    ...payload,
  };
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
  extractProductKeywordFromMessage,
  createDemoProductResearchFallback,
  runProductResearch,
};
