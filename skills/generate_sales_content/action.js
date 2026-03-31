import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
  if (typeof value === "string") {
    return value
      .split(/\r?\n|\||;|,/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
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

function toHashtag(value) {
  const normalized = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/g)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
  return normalized ? `#${normalized}` : "";
}

function parseInput(argv) {
  const logs = [];
  const args = argv.slice(2);

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(args[0]);
      if (parsed && typeof parsed === "object" && parsed.product_profile) {
        return { productProfile: parsed.product_profile, logs };
      }
      return { productProfile: parsed, logs };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
      return { productProfile: null, logs };
    }
  }

  let jsonPayload = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--product_profile" && args[index + 1]) {
      jsonPayload = args[index + 1];
      break;
    }
  }

  if (!jsonPayload) {
    return { productProfile: null, logs };
  }

  try {
    return { productProfile: JSON.parse(jsonPayload), logs };
  } catch (error) {
    logs.push(`[parse] Invalid --product_profile JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { productProfile: null, logs };
  }
}

function validateProductProfile(productProfile) {
  const missing = [];
  if (!productProfile || typeof productProfile !== "object") {
    return ["product_profile"];
  }
  if (typeof productProfile.product_name !== "string" || productProfile.product_name.trim() === "") {
    missing.push("product_profile.product_name");
  }
  if (
    typeof productProfile.product_description !== "string" ||
    productProfile.product_description.trim() === ""
  ) {
    missing.push("product_profile.product_description");
  }
  return missing;
}

function buildSalesContent(productProfile, logs) {
  const productName = productProfile.product_name.trim();
  const productDescription = productProfile.product_description.trim();
  const sellingPoints = parseListValue(productProfile.selling_points).slice(0, 4);
  const specifications = parseListValue(productProfile.specifications).slice(0, 5);
  const keywords = parseListValue(productProfile.keywords).slice(0, 8);
  const imagePaths = parseListValue(productProfile.image_paths).map((item) => path.normalize(item));

  const firstSpec = specifications[0] ?? "Thiết kế tối ưu cho nhu cầu sử dụng hằng ngày";
  const secondSpec = specifications[1] ?? "Vận hành ổn định";
  const firstPoint = sellingPoints[0] ?? "Dễ dùng, phù hợp nhu cầu thực tế";
  const secondPoint = sellingPoints[1] ?? "Hiệu quả tốt trong tầm giá";

  const priceText =
    productProfile.price_reference && typeof productProfile.price_reference === "object"
      ? productProfile.price_reference.raw || "Giá linh hoạt theo chương trình"
      : typeof productProfile.price_reference === "string" && productProfile.price_reference.trim() !== ""
        ? productProfile.price_reference.trim()
        : "Inbox để nhận báo giá ưu đãi";

  logs.push(`[content] specs_used=${specifications.length}`);
  logs.push(`[content] selling_points_used=${sellingPoints.length}`);
  logs.push(`[content] keywords_used=${keywords.length}`);
  logs.push(`[content] image_paths_used=${imagePaths.length}`);

  const captionShort = `${productName} – ${firstSpec}. ${firstPoint}. ${priceText}!`;

  const captionLong = [
    `[Hot] ${productName} đã sẵn sàng cho bạn!`,
    `${productDescription}`,
    `✅ Nổi bật: ${firstSpec}; ${secondSpec}.`,
    `✅ Lý do nên chọn: ${firstPoint}; ${secondPoint}.`,
    `[Gia] Giá tham khảo: ${priceText}.`,
    `[Inbox] Nhắn ngay để được tư vấn cấu hình phù hợp và nhận ưu đãi hôm nay!`,
  ].join("\n");

  const cta = `Nhắn tin ngay để chốt ${productName} với ưu đãi tốt hôm nay.`;

  const hashtagSeed = [productName, ...keywords.slice(0, 5), "SaleOnline", "ChotDonNhanh"]; 
  const hashtags = [...new Set(hashtagSeed.map(toHashtag).filter(Boolean))].slice(0, 10);

  const imageReference =
    imagePaths.length > 0
      ? `Tham chiếu hình thật từ các ảnh: ${imagePaths.slice(0, 3).join(", ")}.`
      : "Không có ảnh tham chiếu, giữ bố cục trung tính và an toàn.";

  const imagePrompt = [
    `Tạo ảnh quảng cáo sản phẩm ${productName}.`,
    `Bám đúng mô tả: ${productDescription}.`,
    specifications.length > 0 ? `Thông số chỉ dùng từ danh sách này: ${specifications.join("; ")}.` : "Không tự bịa thêm thông số kỹ thuật.",
    `Thông điệp bán hàng: ${firstPoint}.`,
    imageReference,
    "Phong cách: thương mại điện tử, sạch, sáng, rõ sản phẩm, có vùng trống cho text giá/CTA.",
  ].join(" ");

  const videoPrompt = [
    `Tạo video quảng cáo ngắn 15-20 giây cho ${productName}.`,
    `Nội dung bám dữ liệu thật: ${productDescription}.`,
    specifications.length > 0 ? `Highlight các điểm: ${specifications.join("; ")}.` : "Không thêm thông số ngoài dữ liệu đầu vào.",
    `Bán hàng online, nhịp nhanh, rõ lợi ích: ${firstPoint}; ${secondPoint}.`,
    imageReference,
    `Kết thúc bằng CTA: ${cta}`,
  ].join(" ");

  return {
    caption_short: captionShort,
    caption_long: captionLong,
    cta,
    hashtags,
    image_prompt: imagePrompt,
    video_prompt: videoPrompt,
    source_context: {
      product_name: productName,
      specifications_used: specifications,
      selling_points_used: sellingPoints,
      image_paths_used: imagePaths,
    },
  };
}

async function saveArtifact(productProfile, salesContent, logs) {
  const artifactsDir = path.join(process.cwd(), "artifacts", "content");
  await mkdir(artifactsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const productKey =
    typeof productProfile.product_id === "string" && productProfile.product_id.trim() !== ""
      ? slugify(productProfile.product_id)
      : slugify(productProfile.product_name) || `product-${Date.now()}`;
  const filename = `${productKey}-sales-content-${timestamp}.json`;
  const outputPath = path.join(artifactsDir, filename);

  const payload = {
    generated_at: new Date().toISOString(),
    product_profile: productProfile,
    sales_content: salesContent,
  };

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  logs.push(`[artifact] Saved sales content to ${outputPath}`);

  return {
    type: "sales_content",
    path: path.relative(process.cwd(), outputPath).replace(/\\/g, "/"),
  };
}

(async function main() {
  const parsed = parseInput(process.argv);
  const logs = [...parsed.logs, "[start] generate_sales_content invoked"];

  const missing = validateProductProfile(parsed.productProfile);
  if (missing.length > 0) {
    const result = buildResult({
      success: false,
      message: "Invalid product_profile input",
      data: {
        caption_short: null,
        caption_long: null,
        cta: null,
        hashtags: [],
        image_prompt: null,
        video_prompt: null,
      },
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

  const productProfile = parsed.productProfile;
  const salesContent = buildSalesContent(productProfile, logs);

  try {
    const artifact = await saveArtifact(productProfile, salesContent, logs);
    const result = buildResult({
      success: true,
      message: "Sales content generated successfully",
      data: salesContent,
      artifacts: [artifact],
      logs,
      error: null,
    });
    printResult(result);
  } catch (error) {
    const result = buildResult({
      success: false,
      message: "Failed to persist content artifact",
      data: salesContent,
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
