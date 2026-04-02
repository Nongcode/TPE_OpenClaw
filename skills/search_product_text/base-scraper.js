import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { chromium } from "playwright-core";

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const SEARCH_ENGINES = [
  {
    name: "google",
    buildUrl(targetSite, keyword) {
      const query = `site:${targetSite} ${keyword}`;
      return `https://www.google.com/search?hl=vi&gl=vn&q=${encodeURIComponent(query)}`;
    },
  },
  {
    name: "bing",
    buildUrl(targetSite, keyword) {
      const query = `site:${targetSite} ${keyword}`;
      return `https://www.bing.com/search?setlang=vi&q=${encodeURIComponent(query)}`;
    },
  },
  {
    name: "duckduckgo",
    buildUrl(targetSite, keyword) {
      const query = `site:${targetSite} ${keyword}`;
      return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    },
  },
];

function normalizeUrlCandidate(rawHref) {
  if (!rawHref) return "";
  try {
    const url = new URL(rawHref, "https://www.google.com");
    if (url.hostname.includes("google.") && url.pathname === "/url") {
      return url.searchParams.get("q") || "";
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

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export class BaseScraper {
  constructor(options = {}) {
    this.keyword = String(options.keyword || "").trim();
    this.targetSite = String(options.target_site || options.targetSite || "canifa.com").trim();
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
      throw new Error("Cannot find Microsoft Edge executable");
    }
    return found;
  }

  buildGoogleSearchUrl() {
    const query = `site:${this.targetSite} ${this.keyword}`;
    return `https://www.google.com/search?hl=vi&gl=vn&q=${encodeURIComponent(query)}`;
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

  async findFirstResultUrl(page, engineName) {
    await page.waitForLoadState("domcontentloaded");
    if (engineName === "google") {
      await this.dismissGoogleConsentIfNeeded(page);
    }
    await page.waitForTimeout(1200);

    const productUrl = await page.evaluate(
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

        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const anchor of anchors) {
          const rawHref = anchor.getAttribute("href") || "";
          const candidate = normalizeCandidate(rawHref);
          if (!candidate) continue;
          try {
            const parsedCandidate = new URL(candidate);
            const hostname = parsedCandidate.hostname;
            if (hostname === currentTargetSite || hostname.endsWith(`.${currentTargetSite}`)) {
              return parsedCandidate.href;
            }
          } catch {}
        }
        return "";
      },
      { currentTargetSite: this.targetSite },
    );

    if (productUrl && hostMatchesTarget(productUrl, this.targetSite)) {
      return productUrl;
    }

    const fallbackAnchors = await page.locator('a[href]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href") || ""),
    );
    for (const href of fallbackAnchors) {
      const normalized = normalizeUrlCandidate(href);
      if (hostMatchesTarget(normalized, this.targetSite)) {
        return normalized;
      }
    }

    throw new Error(`No ${engineName} result matched target site ${this.targetSite}`);
  }

  async openProductPage() {
    if (!this.keyword) {
      throw new Error("Missing keyword");
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
      let lastError = null;
      for (const engine of SEARCH_ENGINES) {
        try {
          const searchUrl = engine.buildUrl(this.targetSite, this.keyword);
          this.debugLog(`${engine.name} search url=${searchUrl}`);
          await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
          });
          productUrl = await this.findFirstResultUrl(page, engine.name);
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
        throw lastError || new Error(`No search result matched target site ${this.targetSite}`);
      }

      await page.goto(productUrl, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForLoadState("networkidle").catch(() => {});

      return { browser, page, productUrl };
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
}
