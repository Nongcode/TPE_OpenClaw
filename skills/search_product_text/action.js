import { BaseScraper } from "./base-scraper.js";
import { extractImageForMedia } from "./extract-image-for-media.js";
import { TextExtractor } from "./text-extractor.js";

const DEFAULTS = {
  keyword: "",
  target_site: "uptek.vn",
  category_hint: "",
  browser_path: "",
  timeout_ms: 45000,
  headless: true,
  debug: false,
};

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const params = { ...DEFAULTS };

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    return { ...params, ...JSON.parse(args[0]) };
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    if (token === "--no-headless") {
      params.headless = false;
      continue;
    }
    if (token === "--headless") {
      params.headless = true;
      continue;
    }
    if (token === "--debug") {
      params.debug = true;
      continue;
    }
    if (!next || next.startsWith("--")) continue;

    if (token === "--keyword") {
      params.keyword = next;
      index += 1;
      continue;
    }
    if (token === "--target_site") {
      params.target_site = next;
      index += 1;
      continue;
    }
    if (token === "--category_hint") {
      params.category_hint = next;
      index += 1;
      continue;
    }
    if (token === "--browser_path") {
      params.browser_path = next;
      index += 1;
      continue;
    }
    if (token === "--timeout_ms") {
      params.timeout_ms = Number(next);
      index += 1;
    }
  }

  return params;
}

function validationError(message) {
  return {
    success: false,
    error: {
      code: "VALIDATION_ERROR",
      message,
    },
  };
}

async function main() {
  let browser = null;
  try {
    const params = parseArgs(process.argv);
    if (!String(params.keyword || "").trim()) {
      printJson(validationError("Missing --keyword"));
      process.exit(1);
      return;
    }

    const scraper = new BaseScraper(params);
    const extractor = new TextExtractor();

    const opened = await scraper.openProductPage();
    browser = opened.browser;

    const data = await extractor.extract(opened.page, opened.productUrl, {
      categoryIndex: opened.categoryIndex,
      matchedCandidate: opened.matchedCandidate,
    });
    const imageResult = await extractImageForMedia({
      productName: data.product_name,
      productUrl: data.product_url || opened.productUrl,
      images: data.images,
      debug: params.debug,
    });

    data.images = imageResult.downloaded;
    data.primary_image = imageResult.primary_image;
    data.image_download_dir = imageResult.output_dir;

    printJson({
      success: true,
      data,
    });
  } catch (error) {
    printJson({
      success: false,
      error: {
        code: "SCRAPE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

await main();
