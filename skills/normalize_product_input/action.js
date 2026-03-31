import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CAMPAIGN_ANGLE =
  "Nhấn mạnh lợi ích thực tế, điểm khác biệt nổi bật, và độ tin cậy cho nhóm khách hàng mục tiêu.";

function buildResult({ success, message, data, artifacts = [], logs = [], error = null }) {
  return {
    success,
    message,
    data,
    artifacts,
    logs,
    error,
  };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseListValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${String(item).trim()}`)
      .filter((item) => item !== ":");
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n|\||;|,/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function parseImagePaths(value) {
  return parseListValue(value).map((item) => path.normalize(item));
}

function parsePriceReference(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return { amount: value, currency: "VND", raw: String(value) };
  }

  if (typeof value === "object") {
    return value;
  }

  const raw = String(value).trim();
  const numberMatch = raw.match(/\d[\d.,]*/);
  const amount = numberMatch ? Number(numberMatch[0].replace(/[.,](?=\d{3}(\D|$))/g, "").replace(/,/g, "")) : null;
  const currency = /usd|\$/i.test(raw) ? "USD" : /vnd|đ|vnđ/i.test(raw) ? "VND" : "UNKNOWN";

  return {
    raw,
    amount: Number.isFinite(amount) ? amount : null,
    currency,
  };
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function deriveKeywords({ productName, productDescription, specifications, sellingPoints }) {
  const stopWords = new Set([
    "va", "voi", "cho", "mot", "nhung", "cac", "cua", "la", "duoc", "trong", "the", "co", "khong",
    "this", "that", "with", "from", "your", "you", "and", "for", "toi", "san", "pham", "product",
  ]);

  const source = [
    productName,
    productDescription,
    ...(specifications || []),
    ...(sellingPoints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const tokens = source.split(/[^a-z0-9]+/g).filter((token) => token.length >= 3 && !stopWords.has(token));
  const freq = new Map();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([token]) => token);
}

function parseArgs(argv) {
  const params = {
    product_name: "",
    product_description: "",
    specifications: [],
    selling_points: [],
    price_reference: null,
    image_paths: [],
    keywords: [],
    campaign_angle: "",
  };

  const logs = [];
  const args = argv.slice(2);

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      return { ...params, ...JSON.parse(args[0]), logs };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];
    if (!next || next.startsWith("--")) continue;

    const key = token.replace("--", "");
    if (Object.hasOwn(params, key)) {
      params[key] = next;
      index += 1;
    }
  }

  return { ...params, logs };
}

function validateInput(params) {
  const missing = [];
  if (typeof params.product_name !== "string" || params.product_name.trim() === "") missing.push("product_name");
  if (typeof params.product_description !== "string" || params.product_description.trim() === "") missing.push("product_description");
  return missing;
}

async function saveArtifact(productProfile, logs) {
  const artifactsDir = path.join(process.cwd(), "artifacts", "products");
  await mkdir(artifactsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${productProfile.product_id}-${timestamp}.json`;
  const outputPath = path.join(artifactsDir, filename);

  await writeFile(outputPath, `${JSON.stringify(productProfile, null, 2)}\n`, "utf8");
  logs.push(`[artifact] Saved product profile to ${outputPath}`);

  return {
    type: "product_profile",
    path: path.relative(process.cwd(), outputPath).replace(/\\/g, "/"),
  };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] normalize_product_input invoked"];

  const missing = validateInput(parsed);
  if (missing.length > 0) {
    const result = buildResult({
      success: false,
      message: "Missing required inputs",
      data: { product_profile: null },
      artifacts: [],
      logs,
      error: {
        code: "VALIDATION_ERROR",
        details: `Missing fields: ${missing.join(", ")}`,
      },
    });
    printResult(result);
    process.exit(1);
  }

  const productName = parsed.product_name.trim();
  const productDescription = parsed.product_description.trim();
  const specifications = parseListValue(parsed.specifications);
  const sellingPoints = parseListValue(parsed.selling_points);
  const imagePaths = parseImagePaths(parsed.image_paths);
  const priceReference = parsePriceReference(parsed.price_reference);
  const inputKeywords = parseListValue(parsed.keywords);
  const keywords = inputKeywords.length > 0
    ? [...new Set(inputKeywords)]
    : deriveKeywords({ productName, productDescription, specifications, sellingPoints });

  const campaignAngle =
    typeof parsed.campaign_angle === "string" && parsed.campaign_angle.trim() !== ""
      ? parsed.campaign_angle.trim()
      : DEFAULT_CAMPAIGN_ANGLE;

  const productProfile = {
    schema_version: "1.0",
    normalized_at: new Date().toISOString(),
    product_id: slugify(productName) || `product-${Date.now()}`,
    product_name: productName,
    product_description: productDescription,
    specifications,
    selling_points: sellingPoints,
    price_reference: priceReference,
    image_paths: imagePaths,
    keywords,
    campaign_angle: campaignAngle,
  };

  logs.push(`[normalize] product_id=${productProfile.product_id}`);
  try {
    const artifact = await saveArtifact(productProfile, logs);
    const result = buildResult({
      success: true,
      message: "Product input normalized successfully",
      data: { product_profile: productProfile },
      artifacts: [artifact],
      logs,
      error: null,
    });
    printResult(result);
  } catch (error) {
    const result = buildResult({
      success: false,
      message: "Failed to persist artifact",
      data: { product_profile: productProfile },
      artifacts: [],
      logs,
      error: {
        code: "ARTIFACT_WRITE_ERROR",
        details: error instanceof Error ? error.message : String(error),
      },
    });
    printResult(result);
    process.exit(1);
  }
})();
