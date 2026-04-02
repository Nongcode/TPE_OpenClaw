function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueTexts(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

export class TextExtractor {
  async extract(page, productUrl) {
    const data = await page.evaluate(() => {
      const cleanText = (value) =>
        String(value || "")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, template, svg").forEach((node) => node.remove());

      const titleSelectors = ["h1", ".product_title", ".product-title", '[class*="title"] h1'];
      let productName = "";
      for (const selector of titleSelectors) {
        const node = clone.querySelector(selector);
        const text = cleanText(node?.textContent || "");
        if (text) {
          productName = text;
          break;
        }
      }

      const candidates = [];
      const selector =
        'table, ul, ol, article, section, div[class*="description" i], div[class*="spec" i], div[class*="detail" i], div[class*="content" i], div[id*="description" i], div[id*="spec" i], div[id*="detail" i]';
      for (const node of clone.querySelectorAll(selector)) {
        const text = cleanText(node.textContent || "");
        if (text.length < 40) continue;
        candidates.push(text);
      }

      for (const table of clone.querySelectorAll("table")) {
        const lines = [];
        for (const row of table.querySelectorAll("tr")) {
          const cells = Array.from(row.querySelectorAll("th,td"))
            .map((cell) => cleanText(cell.textContent || ""))
            .filter(Boolean);
          if (cells.length === 0) continue;
          lines.push(cells.join(": "));
        }
        if (lines.length > 0) {
          candidates.push(lines.join("\n"));
        }
      }

      const paragraphs = Array.from(clone.querySelectorAll("p, li"))
        .map((node) => cleanText(node.textContent || ""))
        .filter((text) => text.length >= 30);
      if (paragraphs.length > 0) {
        candidates.push(paragraphs.join("\n"));
      }

      return {
        productName,
        candidates,
      };
    });

    const productName = normalizeWhitespace(data.productName);
    const specifications = uniqueTexts(data.candidates).join("\n\n");

    if (!productName) {
      throw new Error("Cannot extract product title from page");
    }

    return {
      product_url: productUrl,
      product_name: productName,
      specifications,
    };
  }
}
