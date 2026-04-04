function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
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

function uniqueRecords(records, keyFactory) {
  const seen = new Set();
  const output = [];
  for (const record of records) {
    const key = keyFactory(record);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(record);
  }
  return output;
}

function formatSpecText(specifications) {
  return specifications.map((entry) => `${entry.name}: ${entry.value}`).join("\n");
}

function dedupeLines(text) {
  const output = [];
  const seen = new Set();
  for (const part of String(text || "").split(/\n+/)) {
    const line = normalizeWhitespace(part);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    output.push(line);
  }
  return output.join("\n");
}

function cleanCategoryName(value) {
  return normalizeWhitespace(value).replace(/\s*-\s*\d+\s+items?$/i, "").trim();
}

export class TextExtractor {
  async extract(page, productUrl, options = {}) {
    const raw = await page.evaluate(() => {
      const cleanText = (value) =>
        String(value || "")
          .replace(/\u00A0/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const dedupeTextLines = (value) => {
        const output = [];
        const seen = new Set();
        for (const part of String(value || "").split(/\n+/)) {
          const line = cleanText(part);
          if (!line || seen.has(line)) continue;
          seen.add(line);
          output.push(line);
        }
        return output.join("\n");
      };

      const toAbsolute = (value) => {
        if (!value) return "";
        try {
          return new URL(value, window.location.href).href;
        } catch {
          return "";
        }
      };

      const pickContent = (selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const text = cleanText(node?.textContent || "");
          if (text) return text;
        }
        return "";
      };

      const readMeta = (name, attr = "property") => {
        const meta = document.head.querySelector(`meta[${attr}="${name}"]`);
        return cleanText(meta?.getAttribute("content") || "");
      };

      const breadcrumb = Array.from(document.querySelectorAll(".breadcrumb .breadcrumb-item"))
        .map((node) => cleanText(node.textContent || ""))
        .filter(Boolean);

      const categoryLinks = Array.from(document.querySelectorAll('a[href*="/shop/category/"]')).map(
        (anchor) => ({
          name: cleanText(anchor.textContent || ""),
          url: toAbsolute(anchor.getAttribute("href") || ""),
        }),
      );

      const specifications = Array.from(
        document.querySelectorAll(
          "#product_specifications tr, #product_full_spec tr, .tp-product-details-tab tr, table tr",
        ),
      )
        .map((row) => {
          const cells = Array.from(row.querySelectorAll("th, td"))
            .map((cell) => cleanText(cell.textContent || ""))
            .filter(Boolean);
          if (cells.length < 2) return null;
          return {
            name: cells[0],
            value: cells.slice(1).join(" | "),
          };
        })
        .filter(Boolean);

      const variantAttributes = Array.from(
        document.querySelectorAll(".variant_attribute, .o_wsale_product_attribute"),
      )
        .map((node) => {
          const attributeName =
            cleanText(node.getAttribute("data-attribute_name") || "") ||
            cleanText(node.querySelector(".attribute_name")?.textContent || "");
          if (!attributeName) return null;

          const selectedValues = Array.from(
            node.querySelectorAll(
              'input[type="radio"]:checked, input[type="checkbox"]:checked, option:checked, .active, .selected',
            ),
          )
            .map((selectedNode) => {
              const element = selectedNode;
              const container =
                element.closest("label, li, option, .radio_input_value, .badge") || element;
              const text =
                cleanText(element.getAttribute("data-value_name") || "") ||
                cleanText(container?.textContent || "");
              return text;
            })
            .filter(Boolean);

          const fallbackValues = Array.from(
            node.querySelectorAll(".js_attribute_value span, .radio_input_value span, option"),
          )
            .map((child) => cleanText(child.textContent || ""))
            .filter(Boolean);

          const values = selectedValues.length > 0 ? selectedValues : fallbackValues.slice(0, 1);
          if (values.length === 0) return null;

          return {
            name: attributeName,
            value: values.join(" | "),
          };
        })
        .filter(Boolean);

      const sections = [];
      const sectionSelectors = [
        "#product_full_spec",
        "#product_specifications",
        ".tp-product-details-tab .tab-pane",
        ".o_wsale_product_page [itemprop='description']",
        ".oe_website_sale [class*='description']",
      ];
      const seenSectionNodes = new Set();
      for (const selector of sectionSelectors) {
        for (const node of document.querySelectorAll(selector)) {
          if (seenSectionNodes.has(node)) continue;
          seenSectionNodes.add(node);

          const heading =
            cleanText(node.querySelector("h1, h2, h3, h4, h5, .nav-link, .attribute_name")?.textContent || "") ||
            cleanText(node.getAttribute("id") || "") ||
            "section";

          const lines = Array.from(node.querySelectorAll("p, li, tr"))
            .map((child) => {
              if (child.tagName === "TR") {
                const cells = Array.from(child.querySelectorAll("th, td"))
                  .map((cell) => cleanText(cell.textContent || ""))
                  .filter(Boolean);
                return cells.length >= 2 ? cells.join(": ") : "";
              }
              return cleanText(child.textContent || "");
            })
            .filter((text) => text.length >= 3)
            .slice(0, 300);

          const text = dedupeTextLines(lines.join("\n"));
          if (text.length < 20) continue;
          sections.push({ heading, text });
        }
      }

      const paragraphs = Array.from(document.querySelectorAll("#wrap p, #wrap li"))
        .map((node) => cleanText(node.textContent || ""))
        .filter((text) => text.length >= 25);

      const productId = cleanText(document.querySelector(".product_id")?.getAttribute("value") || "");
      const productTemplateId = cleanText(
        document.querySelector(".product_template_id")?.getAttribute("value") || "",
      );
      const productCategoryId = cleanText(
        document.querySelector(".product_category_id")?.getAttribute("value") || "",
      );

      const imageCandidates = [];
      const pushImage = (entry) => {
        if (!entry.url) return;
        imageCandidates.push({
          url: entry.url,
          alt: cleanText(entry.alt || ""),
          source: cleanText(entry.source || ""),
          widthHint: Number(entry.widthHint || 0),
        });
      };

      pushImage({
        url: readMeta("og:image"),
        alt: pickContent(["h1[itemprop='name']", "h1", "title"]),
        source: "meta:og:image",
        widthHint: 1200,
      });
      pushImage({
        url: pickContent(["[itemprop='image']"]),
        alt: pickContent(["h1[itemprop='name']", "h1"]),
        source: "itemprop:image",
        widthHint: 1920,
      });

      const imageNodes = document.querySelectorAll(
        "#o-carousel-product img, .o_wsale_product_images img, img.product_detail_img, span[itemprop='image'], img[src*='/web/image/product.'], img[src*='/web/image/product.template/']",
      );
      for (const img of imageNodes) {
        const src =
          img.getAttribute("data-zoom-image") ||
          img.getAttribute("data-src") ||
          img.getAttribute("src") ||
          img.textContent ||
          "";
        const widthHint =
          Number(img.getAttribute("width") || 0) ||
          Number(img.getAttribute("data-width") || 0) ||
          (src.includes("image_1920") ? 1920 : src.includes("image_1024") ? 1024 : 0);
        pushImage({
          url: toAbsolute(src),
          alt: img.getAttribute("alt") || "",
          source: "dom:image",
          widthHint,
        });
      }

      return {
        productName:
          pickContent(["h1[itemprop='name']", "#product_details h1", "h1", "meta[property='og:title']"]) ||
          readMeta("og:title"),
        breadcrumb,
        categoryLinks,
        productId,
        productTemplateId,
        productCategoryId,
        price: pickContent([
          "[itemprop='price']",
          ".product_price .oe_currency_value",
          ".product-price .oe_currency_value",
        ]),
        currency:
          pickContent(["[itemprop='priceCurrency']"]) ||
          cleanText(document.querySelector(".product_price")?.textContent || "").match(/[₫$€£¥]/)?.[0] ||
          "",
        canonicalUrl:
          document.querySelector("link[rel='canonical']")?.getAttribute("href") || window.location.href,
        metaDescription: readMeta("description", "name") || readMeta("og:description"),
        pageTitle: cleanText(document.title || ""),
        paragraphs,
        sections,
        specifications,
        variantAttributes,
        imageCandidates,
      };
    });

    const productName = normalizeWhitespace(raw.productName);
    if (!productName) {
      throw new Error("Cannot extract product title from page");
    }

    const specifications = uniqueRecords(
      [...(raw.specifications || []), ...(raw.variantAttributes || [])]
        .map((entry) => ({
          name: normalizeWhitespace(entry?.name),
          value: normalizeWhitespace(entry?.value),
        }))
        .filter((entry) => entry.name && entry.value),
      (entry) => `${entry.name}::${entry.value}`,
    );

    const categoryIndex = Array.isArray(options.categoryIndex) ? options.categoryIndex : [];
    const categoriesFromPage = uniqueRecords(
      (raw.categoryLinks || [])
        .map((entry) => ({
          id: String(entry.url || "").match(/-([0-9]+)(?:$|[/?#])/)?.[1] || "",
          name: cleanCategoryName(entry.name),
          url: normalizeWhitespace(entry.url),
        }))
        .filter((entry) => entry.name || entry.id),
      (entry) => entry.url || `${entry.id}::${entry.name}`,
    );

    let resolvedCategory = null;
    const hiddenCategoryId = normalizeWhitespace(raw.productCategoryId);
    if (hiddenCategoryId) {
      const matched = categoryIndex.find((entry) => String(entry.id) === hiddenCategoryId);
      if (matched) {
        resolvedCategory = {
          id: matched.id,
          name: cleanCategoryName(matched.name),
          url: normalizeWhitespace(matched.url),
        };
      } else {
        resolvedCategory = {
          id: hiddenCategoryId,
          name: "",
          url: "",
        };
      }
    } else if (categoriesFromPage[0]) {
      resolvedCategory = categoriesFromPage[0];
    }

    const matchedCandidateCategory = options.matchedCandidate?.category
      ? {
          id:
            String(options.matchedCandidate.category.url || "").match(/-([0-9]+)(?:$|[/?#])/)?.[1] ||
            "",
          name: cleanCategoryName(options.matchedCandidate.category.name),
          url: normalizeWhitespace(options.matchedCandidate.category.url),
        }
      : null;

    const breadcrumbCategory =
      Array.isArray(raw.breadcrumb) && raw.breadcrumb.length >= 3
        ? {
            id: "",
            name: cleanCategoryName(raw.breadcrumb[raw.breadcrumb.length - 2]),
            url: "",
          }
        : null;

    const categories = uniqueRecords(
      [
        ...(matchedCandidateCategory ? [matchedCandidateCategory] : []),
        ...(breadcrumbCategory ? [breadcrumbCategory] : []),
        ...(resolvedCategory ? [resolvedCategory] : []),
        ...categoriesFromPage,
      ]
        .filter(Boolean)
        .map((entry) => ({
          id: normalizeWhitespace(entry.id),
          name: cleanCategoryName(entry.name),
          url: normalizeWhitespace(entry.url),
        })),
      (entry) => entry.url || `${entry.id}::${entry.name}`,
    ).filter(
      (entry, index, all) =>
        entry.name || entry.url
          ? !(
              !entry.url &&
              all.some(
                (other, otherIndex) =>
                  otherIndex !== index &&
                  other.name === entry.name &&
                  Boolean(other.url),
              )
            )
          : false,
    );

    const contentSections = uniqueRecords(
      (raw.sections || [])
        .map((section) => ({
          heading: normalizeWhitespace(section?.heading),
          text: dedupeLines(section?.text),
        }))
        .filter((section) => section.text && section.text.length >= 20),
      (section) => `${section.heading}::${section.text}`,
    );

    const paragraphs = uniqueStrings(raw.paragraphs || []);
    const specificationsText = formatSpecText(specifications);
    const longDescription = uniqueStrings(
      [raw.metaDescription, ...contentSections.map((section) => section.text)].filter(Boolean),
    )
      .map((entry) => dedupeLines(entry))
      .filter(Boolean)
      .join("\n\n") || specificationsText || paragraphs[0] || "";

    const ownProductIds = [normalizeWhitespace(raw.productId), normalizeWhitespace(raw.productTemplateId)].filter(
      Boolean,
    );
    const filteredImageCandidates = (raw.imageCandidates || []).filter((entry) => {
      const url = normalizeWhitespace(entry?.url);
      if (!url) return false;
      if (url.includes("/product.template.attribute.value/")) return false;
      if (url.includes("image_128") || url.includes("image_256")) return false;
      if (url.includes("/product.template/") || url.includes("/product.product/")) {
        if (ownProductIds.length === 0) return true;
        return ownProductIds.some((id) => url.includes(`/${id}/`));
      }
      return true;
    });

    const imageCandidates = uniqueRecords(
      filteredImageCandidates
        .map((entry) => ({
          url: normalizeWhitespace(entry?.url),
          alt: normalizeWhitespace(entry?.alt),
          source: normalizeWhitespace(entry?.source),
          widthHint: Number(entry?.widthHint || 0),
        }))
        .filter((entry) => entry.url),
      (entry) => entry.url,
    ).sort((left, right) => right.widthHint - left.widthHint);

    return {
      product_url: normalizeWhitespace(raw.canonicalUrl) || productUrl,
      source_url: productUrl,
      page_title: normalizeWhitespace(raw.pageTitle),
      product_name: productName,
      breadcrumb: uniqueStrings(raw.breadcrumb || []),
      category: categories.find((entry) => entry.name || entry.url) || categories[0] || null,
      categories: categories.filter((entry) => entry.name || entry.url),
      product_ids: {
        product_id: normalizeWhitespace(raw.productId),
        product_template_id: normalizeWhitespace(raw.productTemplateId),
        product_category_id: hiddenCategoryId,
      },
      pricing: {
        price: normalizeWhitespace(raw.price),
        currency: normalizeWhitespace(raw.currency),
      },
      specifications,
      specifications_text: specificationsText,
      content_sections: contentSections,
      long_description: longDescription,
      images: imageCandidates,
      meta_description: normalizeWhitespace(raw.metaDescription),
    };
  }
}
