import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { chromium } from "playwright-core";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];

const SEARCH_ENGINES = [
  {
    name: "google",
    buildUrl(targetSite, keyword) {
      const query = `site:${targetSite}/shop ${keyword}`;
      return `https://www.google.com/search?hl=vi&gl=vn&q=${encodeURIComponent(query)}`;
    },
  },
  {
    name: "bing",
    buildUrl(targetSite, keyword) {
      const query = `site:${targetSite}/shop ${keyword}`;
      return `https://www.bing.com/search?setlang=vi&q=${encodeURIComponent(query)}`;
    },
  },
  {
    name: "duckduckgo",
    buildUrl(targetSite, keyword) {
      const query = `site:${targetSite}/shop ${keyword}`;
      return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    },
  },
];

const MIN_SEARCH_ENGINE_MATCH_SCORE = 120;

function normalizeUrlCandidate(rawHref) {
  if (!rawHref) return "";
  try {
    const url = new URL(rawHref, "https://www.google.com");
    if (url.hostname.includes("google.") && url.pathname === "/url") {
      return url.searchParams.get("q") || "";
    }
    if (url.hostname.includes("duckduckgo.com") && url.pathname.startsWith("/l/")) {
      return url.searchParams.get("uddg") || "";
    }
    return url.href;
  } catch {
    return "";
  }
}

function hostMatchesTarget(urlString, targetSite) {
  try {
    const url = new URL(urlString);
    return url.hostname === targetSite || url.hostname.endsWith(`.${targetSite}`);
  } catch {
    return false;
  }
}

function isProductUrl(urlString, targetSite) {
  try {
    const url = new URL(urlString);
    if (!hostMatchesTarget(url.href, targetSite)) {
      return false;
    }
    return /\/shop\/(?!category\/)(?!cart(?:\/|$))/.test(url.pathname);
  } catch {
    return false;
  }
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function getShopCategoryIndex(page) {
  return await page.evaluate(() => {
    const toAbsolute = (value) => {
      try {
        return new URL(value, window.location.href).href;
      } catch {
        return "";
      }
    };

    const readText = (node) =>
      String(node?.textContent || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const categories = [];
    const seen = new Set();
    const nodes = Array.from(
      document.querySelectorAll('[data-link-href*="/shop/category/"], a[href*="/shop/category/"]'),
    );
    for (const node of nodes) {
      const href = node.getAttribute("data-link-href") || node.getAttribute("href") || "";
      const url = toAbsolute(href);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const text =
        readText(node.querySelector("label span")) ||
        readText(node.querySelector("span")) ||
        readText(node);
      const match = url.match(/-([0-9]+)(?:$|[/?#])/);
      categories.push({
        id: match ? match[1] : "",
        name: text,
        url,
      });
    }
    return categories.filter((entry) => entry.name || entry.id);
  });
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanExtractedKeyword(value) {
  return String(value || "")
    .replace(/^["'“”‘’\s]+/, "")
    .replace(/["'“”‘’\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanDirectProductUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim().replace(/^["'<(\[]+/, "").replace(/["'>)\].,]+$/, "");
  if (!trimmed) return "";
  try {
    return new URL(trimmed).href;
  } catch {
    return "";
  }
}

export function extractDirectProductUrl(source, targetSite = "") {
  const text = String(source || "");
  if (!text) {
    return "";
  }

  const matches = text.match(/https?:\/\/[^\s"'<>`]+/gi) || [];
  for (const rawMatch of matches) {
    const candidate = cleanDirectProductUrl(rawMatch);
    if (!candidate) continue;
    if (targetSite && !hostMatchesTarget(candidate, targetSite)) continue;
    if (!isProductUrl(candidate, targetSite || new URL(candidate).hostname)) continue;
    return candidate;
  }

  const direct = cleanDirectProductUrl(text);
  if (!direct) {
    return "";
  }
  if (targetSite && !hostMatchesTarget(direct, targetSite)) {
    return "";
  }
  return isProductUrl(direct, targetSite || new URL(direct).hostname) ? direct : "";
}

export function extractProductIntentKeyword(source) {
  const text = String(source || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  const labeledPatterns = [
    /YEU_CAU_GOC_SAN_PHAM:\s*([^.\n]+?)(?=\s*(?:URL_SAN_PHAM|TEN_SAN_PHAM|DANH_MUC|THONG_SO|THU_MUC_ANH_GOC|$))/i,
    /KEYWORD_SACH:\s*([^.\n]+?)(?=\s*(?:URL_SAN_PHAM|TEN_SAN_PHAM|DANH_MUC|THONG_SO|THU_MUC_ANH_GOC|$))/i,
    /TEN_SAN_PHAM:\s*([^.\n]+?)(?=\s*(?:URL_SAN_PHAM|DANH_MUC|THONG_SO|THU_MUC_ANH_GOC|$))/i,
    /keyword sach(?: chi gom ten san pham)?\s*:\s*([^?\n]+?)(?=\s*(?:URL|Chat lieu|Kich thuoc|Doi tuong|CTA|$))/i,
    /keyword sạch(?: chỉ gồm tên sản phẩm)?\s*:\s*([^?\n]+?)(?=\s*(?:URL|Chất liệu|Kích thước|Đối tượng|CTA|$))/i,
    /Yêu cầu gốc sản phẩm\s*:\s*([^?\n]+?)(?=\s*(?:URL|Tên sản phẩm|Danh mục|Thông số|$))/i,
    /Tên sản phẩm(?: chuẩn)?\s*:\s*([^?\n]+?)(?=\s*(?:URL|Chất liệu|Kích thước|Đối tượng|CTA|$))/i,
    /sản phẩm(?: chuẩn)?\s*:\s*([^?\n]+?)(?=\s*(?:URL|Chất liệu|Kích thước|Đối tượng|CTA|$))/i,
  ];

  for (const pattern of labeledPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = cleanExtractedKeyword(match[1]);
      if (candidate) {
        return candidate;
      }
    }
  }

  const inlinePatterns = [
    /quảng bá sản phẩm\s+(.+?)(?=\s+(?:để|de|và|va|với|voi|trình|review|duyệt|đăng|dang|yêu cầu:|yeu cau:|$))/i,
    /viết bài(?: Facebook)?(?: quảng bá)?\s+(?:cho|về)\s+(.+?)(?=\s+(?:để|de|và|va|với|voi|trình|review|duyệt|đăng|dang|yêu cầu:|yeu cau:|$))/i,
    /cho\s+(.+?)(?=\s+(?:để|de|và|va|với|voi|trình|review|duyệt|đăng|dang|yêu cầu:|yeu cau:|$))/i,
  ];

  for (const pattern of inlinePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = cleanExtractedKeyword(match[1]);
      if (candidate && candidate.length <= 160) {
        return candidate;
      }
    }
  }

  return cleanExtractedKeyword(text);
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter(Boolean);
}

const GENERIC_PRODUCT_TOKENS = new Set([
  "thiet",
  "bi",
  "kiem",
  "tra",
  "goc",
  "dat",
  "banh",
  "xe",
  "cong",
  "nghe",
  "dung",
  "cho",
  "loai",
  "mau",
  "va",
  "tu",
  "dong",
  "may",
  "san",
  "pham",
]);

const COLOR_TOKENS = ["do", "xanh", "den", "trang", "vang", "bac", "cam", "xam"];
const FEATURE_PHRASES = [
  "tu dong",
  "xoay tu dong",
  "4 robot",
  "8 camera",
  "12 camera",
  "2 camera",
];
const TECHNOLOGY_TOKENS = ["3d", "ccd", "camera", "robot", "laser"];

function uniqueTokens(tokens) {
  return [...new Set(tokens.filter(Boolean))];
}

function buildDistinctiveSignals(keyword) {
  const normalized = normalizeSearchText(keyword);
  const tokens = tokenizeSearchText(keyword);
  const numericTokens = uniqueTokens(tokens.filter((token) => /^\d+[a-z]*$/.test(token)));
  const colors = uniqueTokens(tokens.filter((token) => COLOR_TOKENS.includes(token)));
  const techTokens = uniqueTokens(tokens.filter((token) => TECHNOLOGY_TOKENS.includes(token)));
  const phraseSignals = FEATURE_PHRASES.filter((phrase) => normalized.includes(phrase));
  const distinctiveTokens = uniqueTokens(
    tokens.filter(
      (token) =>
        !GENERIC_PRODUCT_TOKENS.has(token) &&
        (token.length >= 4 || /^\d+[a-z]*$/.test(token) || COLOR_TOKENS.includes(token) || TECHNOLOGY_TOKENS.includes(token)),
    ),
  );

  return {
    colors,
    numericTokens,
    phraseSignals,
    techTokens,
    distinctiveTokens,
  };
}

function extractModelTokens(value) {
  const source = String(value || "").toUpperCase();
  const matches = source.match(/[A-Z]{1,6}-\d+(?:\.\d+)?(?:-\d+[A-Z0-9]*)+/g) || [];
  return [...new Set(matches.map((token) => token.trim()).filter(Boolean))];
}

function buildKeywordSignals(keyword, categoryHint = "") {
  const effectiveKeyword = extractProductIntentKeyword(keyword);
  const normalizedKeyword = normalizeSearchText(effectiveKeyword);
  const tokens = tokenizeSearchText(effectiveKeyword);
  const modelTokens = extractModelTokens(effectiveKeyword);
  const distinctiveSignals = buildDistinctiveSignals(effectiveKeyword);
  const categoryHints = [];
  const addCategoryHint = (value) => {
    const normalized = normalizeSearchText(value);
    if (normalized && !categoryHints.includes(normalized)) {
      categoryHints.push(normalized);
    }
  };

  if (normalizedKeyword.includes("cau nang")) addCategoryHint("cau nang");
  if (normalizedKeyword.includes("cau nang o to")) addCategoryHint("cau nang o to");
  if (normalizedKeyword.includes("2 tru")) addCategoryHint("2 tru");
  if (normalizedKeyword.includes("rua xe")) addCategoryHint("rua xe");
  if (normalizedKeyword.includes("xuong lam lop")) addCategoryHint("xuong lam lop");
  if (normalizedKeyword.includes("lop")) addCategoryHint("xuong lam lop");
  if (normalizedKeyword.includes("ra vao lop")) addCategoryHint("may ra vao lop");
  if (normalizedKeyword.includes("lop xe con")) addCategoryHint("may ra vao lop");
  if (normalizedKeyword.includes("cam bien ap suat lop")) addCategoryHint("may ra vao lop");
  if (normalizedKeyword.includes("ap suat lop")) addCategoryHint("may ra vao lop");
  addCategoryHint(categoryHint);

  return {
    normalizedKeyword,
    tokens,
    modelTokens,
    ...distinctiveSignals,
    categoryHints,
  };
}

function shouldPreferShopCrawl(keywordSignals) {
  if ((keywordSignals.modelTokens || []).length > 0) return true;
  if ((keywordSignals.phraseSignals || []).length > 0 && (keywordSignals.colors || []).length > 0) return true;
  if ((keywordSignals.techTokens || []).length > 0 && (keywordSignals.numericTokens || []).length > 0) return true;
  return (keywordSignals.distinctiveTokens || []).length >= 5;
}

function scoreProductCandidate(candidate, keywordSignals) {
  const haystack = normalizeSearchText(
    `${candidate.title || ""} ${candidate.url || ""} ${candidate.category?.name || ""}`,
  );
  const needle = keywordSignals.normalizedKeyword;
  if (!haystack || !needle) return 0;

  let score = 0;
  if (haystack.includes(needle)) {
    score += 1000;
  }

  for (const token of keywordSignals.tokens) {
    if (haystack.includes(token)) {
      score += 10 + token.length;
    }
  }

  for (const token of keywordSignals.distinctiveTokens || []) {
    if (haystack.includes(token)) {
      score += 120 + token.length * 2;
    } else {
      score -= 90;
    }
  }

  for (const phrase of keywordSignals.phraseSignals || []) {
    if (haystack.includes(phrase)) {
      score += 260;
    } else {
      score -= 180;
    }
  }

  for (const color of keywordSignals.colors || []) {
    if (haystack.includes(color)) {
      score += 240;
    } else {
      const conflictingColor = COLOR_TOKENS.some((entry) => entry !== color && haystack.includes(entry));
      score += conflictingColor ? -450 : -180;
    }
  }

  for (const tech of keywordSignals.techTokens || []) {
    if (haystack.includes(tech)) {
      score += 220;
    } else {
      const conflictingTech = TECHNOLOGY_TOKENS.some((entry) => entry !== tech && haystack.includes(entry));
      score += conflictingTech ? -420 : -150;
    }
  }

  for (const numeric of keywordSignals.numericTokens || []) {
    if (haystack.includes(numeric)) {
      score += 180;
    } else {
      score -= 160;
    }
  }

  const candidateModelTokens = extractModelTokens(`${candidate.title || ""} ${candidate.url || ""}`);
  if (keywordSignals.modelTokens.length > 0) {
    const modelMatched = keywordSignals.modelTokens.some((token) => candidateModelTokens.includes(token));
    if (modelMatched) {
      score += 5000;
    } else {
      score -= 1500;
    }
  }

  if (candidate.category?.name) {
    const normalizedCategory = normalizeSearchText(candidate.category.name);
    for (const hint of keywordSignals.categoryHints) {
      if (normalizedCategory.includes(hint)) {
        score += 400;
      }
    }
  }

  if (candidate.url && /\/en\/shop\//.test(candidate.url)) {
    score += 5;
  }
  if (candidate.title) {
    score += Math.min(candidate.title.length, 60) / 60;
  }
  return score;
}

function hasStrongKeywordMatch(candidate, keywordSignals) {
  const haystack = normalizeSearchText(
    `${candidate.title || ""} ${candidate.url || ""} ${candidate.category?.name || ""}`,
  );
  const matchedTokens = keywordSignals.tokens.filter((token) => haystack.includes(token));
  const matchedDistinctiveTokens = (keywordSignals.distinctiveTokens || []).filter((token) => haystack.includes(token));
  const matchedPhrases = (keywordSignals.phraseSignals || []).filter((phrase) => haystack.includes(phrase));
  const matchedColors = (keywordSignals.colors || []).filter((color) => haystack.includes(color));
  const matchedTechTokens = (keywordSignals.techTokens || []).filter((token) => haystack.includes(token));
  const matchedNumericTokens = (keywordSignals.numericTokens || []).filter((token) => haystack.includes(token));

  if (keywordSignals.modelTokens.length > 0) {
    return matchedTokens.length >= 1;
  }
  if ((keywordSignals.colors || []).length > 0 && matchedColors.length < keywordSignals.colors.length) {
    return false;
  }
  if ((keywordSignals.techTokens || []).length > 0 && matchedTechTokens.length === 0) {
    return false;
  }
  if ((keywordSignals.numericTokens || []).length > 0 && matchedNumericTokens.length === 0) {
    return false;
  }
  if ((keywordSignals.phraseSignals || []).length > 0 && matchedPhrases.length === 0) {
    return false;
  }
  if ((keywordSignals.distinctiveTokens || []).length >= 4) {
    return matchedDistinctiveTokens.length >= Math.ceil(keywordSignals.distinctiveTokens.length * 0.75);
  }
  if (keywordSignals.tokens.length <= 2) {
    return matchedTokens.length >= keywordSignals.tokens.length;
  }
  return matchedTokens.length >= Math.max(2, Math.ceil(keywordSignals.tokens.length * 0.6));
}

export function pickBestProductCandidateForKeyword(candidates, keyword, categoryHint = "") {
  const keywordSignals = buildKeywordSignals(keyword, categoryHint);
  const ranked = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      score: scoreProductCandidate(candidate, keywordSignals),
    }))
    .sort((left, right) => right.score - left.score);

  if (!ranked[0] || ranked[0].score <= 0) {
    return null;
  }
  return hasStrongKeywordMatch(ranked[0], keywordSignals) ? ranked[0] : null;
}

async function collectProductCandidates(page) {
  return await page.evaluate(() => {
    const toAbsolute = (value) => {
      try {
        return new URL(value, window.location.href).href;
      } catch {
        return "";
      }
    };

    const breadcrumb = Array.from(document.querySelectorAll(".breadcrumb .breadcrumb-item"))
      .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const currentCategory =
      window.location.pathname.includes("/shop/category/") && breadcrumb.length >= 3
        ? {
            name: breadcrumb[breadcrumb.length - 1],
            url: window.location.href,
          }
        : null;

    const products = [];
    const seen = new Set();
    const productAnchors = Array.from(
      document.querySelectorAll(
        '.tp-product-title a[href*="/shop/"], a[itemprop="name"][href*="/shop/"], .oe_product a[href*="/shop/"]',
      ),
    );
    const anchors =
      productAnchors.length > 0
        ? productAnchors
        : Array.from(document.querySelectorAll('a[href*="/shop/"]'));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const url = toAbsolute(href);
      if (!url || seen.has(url)) continue;
      if (!/\/shop\/(?!category\/)(?!cart(?:\/|$))(?!wishlist(?:\/|$))(?!all-brands(?:\/|$))/.test(url)) {
        continue;
      }

      const title =
        String(anchor.getAttribute("title") || "")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/g, " ")
          .trim() ||
        String(anchor.textContent || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      products.push({
        url,
        title,
        category: currentCategory,
      });
      seen.add(url);
    }

    const categoryLinks = Array.from(
      document.querySelectorAll('[data-link-href*="/shop/category/"], a[href*="/shop/category/"]'),
    )
      .map((node) => {
        const href = node.getAttribute("data-link-href") || node.getAttribute("href") || "";
        return toAbsolute(href);
      })
      .filter(Boolean);

    const pageLinks = Array.from(document.querySelectorAll(".pagination a[href]"))
      .map((anchor) => toAbsolute(anchor.getAttribute("href") || ""))
      .filter((url) => url.includes("/shop/category/"));

    return { products, categoryLinks, pageLinks };
  });
}

async function collectSearchEngineCandidates(page, targetSite) {
  return await page.evaluate(
    ({ currentTargetSite }) => {
      const normalizeCandidate = (rawHref) => {
        if (!rawHref) return "";
        try {
          const parsed = new URL(rawHref, "https://www.google.com");
          if (parsed.hostname.includes("google.") && parsed.pathname === "/url") {
            return parsed.searchParams.get("q") || "";
          }
          if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
            return parsed.searchParams.get("uddg") || "";
          }
          return parsed.href;
        } catch {
          return "";
        }
      };

      const cleanText = (value) =>
        String(value || "")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const results = [];
      const seen = new Set();
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const rawHref = anchor.getAttribute("href") || "";
        const candidateUrl = normalizeCandidate(rawHref);
        if (!candidateUrl || seen.has(candidateUrl)) {
          continue;
        }
        try {
          const parsed = new URL(candidateUrl);
          const hostname = parsed.hostname;
          if (
            !(hostname === currentTargetSite || hostname.endsWith(`.${currentTargetSite}`)) ||
            !/\/shop\/(?!category\/)(?!cart(?:\/|$))(?!wishlist(?:\/|$))(?!all-brands(?:\/|$))/.test(
              parsed.pathname,
            )
          ) {
            continue;
          }
        } catch {
          continue;
        }

        const heading =
          cleanText(anchor.closest("div, li, article")?.querySelector("h3, h2")?.textContent || "") ||
          cleanText(anchor.getAttribute("title") || "") ||
          cleanText(anchor.textContent || "");

        results.push({
          url: candidateUrl,
          title: heading,
          category: null,
        });
        seen.add(candidateUrl);
      }
      return results;
    },
    { currentTargetSite: targetSite },
  );
}

export class BaseScraper {
  constructor(options = {}) {
    this.keyword = String(options.keyword || "").trim();
    this.effectiveKeyword = extractProductIntentKeyword(this.keyword) || this.keyword;
    this.targetSite = String(options.target_site || options.targetSite || "uptek.vn").trim();
    this.directProductUrl =
      extractDirectProductUrl(options.product_url || options.productUrl || "", this.targetSite) ||
      extractDirectProductUrl(this.keyword, this.targetSite);
    this.categoryHint = String(options.category_hint || options.categoryHint || "").trim();
    this.browserPath = String(options.browser_path || options.browserPath || "").trim();
    this.headless = options.headless !== false;
    this.timeoutMs = Number(options.timeout_ms || options.timeoutMs || 45000);
    this.debug = options.debug === true;
  }

  debugLog(message) {
    if (this.debug) {
      process.stderr.write(`[search_product_text] ${message}\n`);
    }
  }

  async resolveBrowserPath() {
    if (this.browserPath) {
      return this.browserPath;
    }
    const found = await firstExistingPath(EDGE_CANDIDATES);
    if (!found) {
      throw new Error("Cannot find Microsoft Edge or Google Chrome executable");
    }
    return found;
  }

  async dismissGoogleConsentIfNeeded(page) {
    const selectors = [
      'button:has-text("Từ chối tất cả")',
      'button:has-text("Chấp nhận tất cả")',
      'button:has-text("Accept all")',
      'button:has-text("Reject all")',
      'form [role="button"]:has-text("Accept all")',
    ];

    for (const selector of selectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 1000 })) {
          await button.click({ timeout: 2000 });
          this.debugLog(`dismissed consent via ${selector}`);
          return;
        }
      } catch {}
    }
  }

  async findFirstResultUrl(page, engineName, keywordSignals) {
    await page.waitForLoadState("domcontentloaded");
    if (engineName === "google") {
      await this.dismissGoogleConsentIfNeeded(page);
    }
    await page.waitForTimeout(1200);

    const rankedCandidates = (await collectSearchEngineCandidates(page, this.targetSite))
      .map((candidate) => ({
        ...candidate,
        score: scoreProductCandidate(candidate, keywordSignals),
      }))
      .sort((left, right) => right.score - left.score);

    if (this.debug) {
      for (const candidate of rankedCandidates.slice(0, 5)) {
        this.debugLog(
          `search-engine candidate score=${candidate.score} title=${candidate.title || "<empty>"} url=${candidate.url}`,
        );
      }
    }

    if (
      rankedCandidates[0] &&
      rankedCandidates[0].score >= MIN_SEARCH_ENGINE_MATCH_SCORE &&
      hasStrongKeywordMatch(rankedCandidates[0], keywordSignals)
    ) {
      return rankedCandidates[0].url;
    }

    throw new Error(`No ${engineName} result matched target site ${this.targetSite}`);
  }

  async openProductPage() {
    if (!this.keyword && !this.directProductUrl) {
      throw new Error("Missing keyword or product URL");
    }

    const executablePath = await this.resolveBrowserPath();
    const browser = await chromium.launch({
      executablePath,
      headless: this.headless,
    });

    try {
      const page = await browser.newPage({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      });
      page.setDefaultTimeout(this.timeoutMs);
      page.setDefaultNavigationTimeout(this.timeoutMs);

      let productUrl = "";
      let matchedCandidate = null;
      let lastError = null;
      const keywordSignals = buildKeywordSignals(this.effectiveKeyword, this.categoryHint);

      const findProductViaShopCrawl = async () => {
        const shopUrl = new URL("/shop", `https://${this.targetSite}`).href;
        await page.goto(shopUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});

        const rootCollection = await collectProductCandidates(page);
        const rootCategoryIndex = await getShopCategoryIndex(page);
        const prioritizedCategories = [...rootCategoryIndex]
          .map((entry) => ({
            ...entry,
            score: scoreProductCandidate(
              {
                title: entry.name,
                url: entry.url,
                category: { name: entry.name, url: entry.url },
              },
              keywordSignals,
            ),
          }))
          .sort((left, right) => right.score - left.score);

        const categoryQueue = [
          ...new Set(
            prioritizedCategories
              .filter((entry) => entry.score > 0)
              .slice(0, 10)
              .map((entry) => entry.url),
          ),
          ...new Set(rootCollection.categoryLinks),
        ].slice(0, 24);
        const allCandidates = [...rootCollection.products];

        for (const categoryUrl of categoryQueue) {
          try {
            await page.goto(categoryUrl, { waitUntil: "domcontentloaded" });
            await page.waitForLoadState("networkidle").catch(() => {});
            const categoryCollection = await collectProductCandidates(page);
            allCandidates.push(...categoryCollection.products);

            const paginationQueue = [...new Set(categoryCollection.pageLinks)].slice(0, 8);
            for (const paginationUrl of paginationQueue) {
              try {
                await page.goto(paginationUrl, { waitUntil: "domcontentloaded" });
                await page.waitForLoadState("networkidle").catch(() => {});
                const pagedCollection = await collectProductCandidates(page);
                allCandidates.push(...pagedCollection.products);
              } catch (error) {
                this.debugLog(
                  `category page crawl failed ${paginationUrl}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          } catch (error) {
            this.debugLog(
              `category crawl failed ${categoryUrl}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        const mergedCandidates = [];
        const candidateByUrl = new Map();
        for (const entry of allCandidates) {
          const existing = candidateByUrl.get(entry.url);
          if (!existing) {
            candidateByUrl.set(entry.url, { ...entry });
            mergedCandidates.push(candidateByUrl.get(entry.url));
            continue;
          }
          if (!existing.title && entry.title) {
            existing.title = entry.title;
          }
          if (!existing.category && entry.category) {
            existing.category = entry.category;
          }
        }

        const bestCandidate = pickBestProductCandidateForKeyword(
          mergedCandidates,
          this.effectiveKeyword,
          this.categoryHint,
        );
        if (!bestCandidate) {
          throw new Error(`No shop candidate matched keyword ${this.effectiveKeyword}`);
        }
        return bestCandidate;
      };

      if (this.directProductUrl) {
        productUrl = this.directProductUrl;
        this.debugLog(`using direct product url=${productUrl}`);
      }

      if (!productUrl && shouldPreferShopCrawl(keywordSignals)) {
        try {
          matchedCandidate = await findProductViaShopCrawl();
          productUrl = matchedCandidate.url;
          this.debugLog(`matched product url via prioritized shop crawl=${productUrl}`);
        } catch (error) {
          lastError = error;
          this.debugLog(
            `prioritized shop crawl failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await page.goto("about:blank").catch(() => {});
        }
      }

      for (const engine of SEARCH_ENGINES) {
        if (productUrl) break;
        try {
          const searchUrl = engine.buildUrl(this.targetSite, this.effectiveKeyword);
          this.debugLog(`${engine.name} search url=${searchUrl}`);
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
          });
          productUrl = await this.findFirstResultUrl(page, engine.name, keywordSignals);
          this.debugLog(`matched product url via ${engine.name}=${productUrl}`);
          break;
        } catch (error) {
          lastError = error;
          this.debugLog(
            `${engine.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!productUrl) {
        try {
          await page.goto("about:blank").catch(() => {});
          matchedCandidate = await findProductViaShopCrawl();
          productUrl = matchedCandidate.url;
          this.debugLog(`matched product url via shop crawl=${productUrl}`);
        } catch (error) {
          lastError = error;
          this.debugLog(
            `shop crawl fallback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!productUrl) {
        throw lastError || new Error(`No search result matched target site ${this.targetSite}`);
      }

      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle").catch(() => {});

      const shopUrl = new URL("/shop", productUrl).href;
      let categoryIndex = [];
      try {
        await page.goto(shopUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        categoryIndex = await getShopCategoryIndex(page);
      } catch (error) {
        this.debugLog(
          `category index load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle").catch(() => {});

      return { browser, page, productUrl, categoryIndex, matchedCandidate };
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
}
