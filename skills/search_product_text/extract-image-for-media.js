import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

function sanitizeFileName(value) {
  return String(value || "product")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/[. ]+$/g, "")
    .toLowerCase() || "product";
}

function getExtensionFromContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.includes("image/png")) return ".png";
  if (normalized.includes("image/webp")) return ".webp";
  if (normalized.includes("image/gif")) return ".gif";
  if (normalized.includes("image/jpeg") || normalized.includes("image/jpg")) return ".jpg";
  return ".bin";
}

function isKnownImageExtension(value) {
  return [".png", ".webp", ".gif", ".jpg", ".jpeg"].includes(String(value || "").toLowerCase());
}

function getFileNameFromUrl(urlString, fallbackBaseName, index, contentType) {
  try {
    const url = new URL(urlString);
    const nameFromPath = decodeURIComponent(path.posix.basename(url.pathname));
    const rawName = nameFromPath && nameFromPath !== "/" ? nameFromPath : `${fallbackBaseName}-${index + 1}`;
    const cleaned = sanitizeFileName(rawName.replace(/\.[a-z0-9]+$/i, ""));
    const extensionFromPath = path.posix.extname(rawName);
    const extension = isKnownImageExtension(extensionFromPath)
      ? extensionFromPath
      : getExtensionFromContentType(contentType);
    return `${cleaned}${extension}`;
  } catch {
    return `${fallbackBaseName}-${index + 1}${getExtensionFromContentType(contentType)}`;
  }
}

export async function extractImageForMedia(options) {
  const {
    productName,
    productUrl,
    images,
    artifactsDir = path.resolve("artifacts", "references", "search_product_text"),
    debug = false,
  } = options || {};

  const uniqueImages = [];
  const seen = new Set();
  for (const image of Array.isArray(images) ? images : []) {
    const url = String(image?.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    uniqueImages.push(image);
  }

  const productSlug = sanitizeFileName(productName || productUrl || "product");
  const outputDir = path.join(artifactsDir, productSlug);
  await mkdir(outputDir, { recursive: true });

  const downloaded = [];
  const usedNames = new Set();
  const seenContentHashes = new Set();
  for (let index = 0; index < uniqueImages.length; index += 1) {
    const image = uniqueImages[index];
    const response = await fetch(image.url, {
      headers: {
        referer: productUrl,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) {
      if (debug) {
        process.stderr.write(
          `[search_product_text] image download failed ${image.url} status=${response.status}\n`,
        );
      }
      continue;
    }

    const arrayBuffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const contentHash = createHash("sha256").update(fileBuffer).digest("hex");
    if (seenContentHashes.has(contentHash)) {
      continue;
    }
    seenContentHashes.add(contentHash);
    const contentType = response.headers.get("content-type") || "";
    let fileName = getFileNameFromUrl(image.url, productSlug, index, contentType);
    if (usedNames.has(fileName)) {
      const extension = path.extname(fileName);
      const base = fileName.slice(0, -extension.length);
      let dedupIndex = 2;
      while (usedNames.has(`${base}-${dedupIndex}${extension}`)) {
        dedupIndex += 1;
      }
      fileName = `${base}-${dedupIndex}${extension}`;
    }
    usedNames.add(fileName);
    const filePath = path.join(outputDir, fileName);
    await writeFile(filePath, fileBuffer);

    downloaded.push({
      ...image,
      content_type: contentType,
      content_hash: contentHash,
      file_path: filePath,
      file_name: fileName,
      size_bytes: arrayBuffer.byteLength,
      is_primary: index === 0,
    });
  }

  return {
    output_dir: outputDir,
    downloaded,
    primary_image: downloaded[0] || null,
  };
}
