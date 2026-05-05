import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";

const DEFAULTS = {
  backendBaseUrl: process.env.UPTEK_BE_URL || "http://localhost:3001",
  automationSyncToken:
    process.env.AUTOMATION_SYNC_TOKEN || "uptek_internal_sync_2026_secure_token",
  galleryRoot: process.env.UPTEK_GALLERY_ROOT || "D:/UpTek_FE/backend/storage/images",
  companyId: process.env.UPTEK_GALLERY_COMPANY_ID || "UpTek",
  departmentId: process.env.UPTEK_GALLERY_DEPARTMENT_ID || "Phong_Marketing",
  agentId: process.env.UPTEK_GALLERY_AGENT_ID || "nv_media",
  productModel: process.env.UPTEK_GALLERY_PRODUCT_MODEL || "generated_media",
  prefix: process.env.UPTEK_GALLERY_PREFIX || "AI_Generated",
};

function sanitizePathSegment(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function sanitizeFilename(value, fallbackBase = "generated-image") {
  const ext = path.extname(String(value || "")).replace(/[^.a-zA-Z0-9]/g, "") || ".png";
  const stem = path
    .basename(String(value || ""), path.extname(String(value || "")))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 120);
  return `${stem || fallbackBase}${ext.toLowerCase()}`;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .trim();
}

function dedupe(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function extractModelCandidates(value) {
  const source = String(value || "").toUpperCase();
  const matches = [
    ...(source.match(/(?:^|[-_\s])MODEL[-_\s]+([A-Z0-9][A-Z0-9._-]{1,80})/g) || []).map((item) =>
      item.replace(/.*MODEL[-_\s]+/i, ""),
    ),

    ...(source.match(/[A-Z]{1,6}-\d+(?:\.\d+)?(?:-[A-Z0-9]+)+/g) || []),
    ...(source.match(/[A-Z]{2,}\d+[A-Z0-9.-]*(?:\s+(?:PLUS|PRO|MAX|EVO|ECO))?/g) || []),
    ...(source.match(/[A-Z]{1,4}\s+\d{2,5}(?:[A-Z0-9.-]*)?(?:\s+(?:PLUS|PRO|MAX|EVO|ECO))?/g) || []),
  ];
  return dedupe(matches.map((item) => item.replace(/\s+/g, " ").trim()));
}

async function findProductProfileByImagePaths(imagePaths, workspaceRoot) {
  const productsDir = path.join(workspaceRoot, "artifacts", "products");
  let entries = [];
  try {
    entries = await readdir(productsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const normalizedTargets = new Set(
    (imagePaths || []).map((item) => normalizeForMatch(path.resolve(item))).filter(Boolean),
  );
  if (normalizedTargets.size === 0) return null;

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(productsDir, entry.name))
    .sort((left, right) => right.localeCompare(left));

  for (const filePath of files) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      const profilePaths = Array.isArray(parsed?.image_paths)
        ? parsed.image_paths.map((item) => normalizeForMatch(path.resolve(item)))
        : [];
      if (profilePaths.some((item) => normalizedTargets.has(item))) {
        return parsed;
      }
    } catch {}
  }

  return null;
}

async function resolveProductModel(options = {}) {
  const explicitProductModel = String(options.productModel || "").trim();
  if (explicitProductModel) {
    return explicitProductModel;
  }

  const workspaceRoot = path.resolve(String(options.workspaceRoot || process.cwd()));
  const imagePaths = Array.isArray(options.imagePaths) ? options.imagePaths : [];
  const matchedProfile = await findProductProfileByImagePaths(imagePaths, workspaceRoot);
  const profileName = String(matchedProfile?.product_name || "").trim();
  const profileDescription = String(matchedProfile?.product_description || "").trim();
  const profileId = String(matchedProfile?.product_id || "").trim();
  const profileSpecifications = Array.isArray(matchedProfile?.specifications)
    ? matchedProfile.specifications.map((item) => String(item || "").trim())
    : [];

  const candidateTexts = [
    profileName,
    profileDescription,
    profileId,
    ...profileSpecifications,
    String(options.imagePrompt || "").trim(),
    ...imagePaths.map((item) => path.basename(String(item || ""))),
    ...imagePaths.map((item) => path.basename(path.dirname(String(item || "")))),
  ];

  for (const text of candidateTexts) {
    const models = extractModelCandidates(text);
    if (models.length > 0) {
      return models[0];
    }
  }

  if (profileName) {
    return profileName.slice(0, 120);
  }


  const fallbackDir = imagePaths[0]
    ? path.basename(path.dirname(String(imagePaths[0]))).replace(/-/g, " ").trim()
    : "";

  if (fallbackDir) {
    return fallbackDir.slice(0, 120);
  }

  return String(DEFAULTS.productModel).trim() || "generated_media";
}

function buildCopiedFilename(sourcePath) {
  const safeOriginal = sanitizeFilename(path.basename(sourcePath), "generated-image");
  const ext = path.extname(safeOriginal) || ".png";
  const stem = path.basename(safeOriginal, ext);
  return `${stem}-${nowStamp()}${ext}`;
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const payloadBytes = Buffer.byteLength(payload);

    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",

          "Content-Length": payloadBytes,

          ...headers,
        },
      },
      (response) => {
        let buffer = "";
        response.on("data", (chunk) => {
          buffer += String(chunk);
        });
        response.on("end", () => {
          if ((response.statusCode || 500) >= 400) {
            reject(
              new Error(

                `Gallery sync failed: ${response.statusCode} (${payloadBytes} request bytes) ${buffer.slice(0, 300) || response.statusMessage || "unknown error"}`,

              ),
            );
            return;
          }
          try {
            resolve(buffer ? JSON.parse(buffer) : {});
          } catch (error) {
            reject(
              new Error(
                `Gallery sync returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

export async function publishGeneratedImageToUpTekGallery(imagePath, options = {}) {
  const backendBaseUrl = String(options.backendBaseUrl || DEFAULTS.backendBaseUrl).trim();
  const automationSyncToken = String(
    options.automationSyncToken || DEFAULTS.automationSyncToken,
  ).trim();
  const companyId = sanitizePathSegment(options.companyId || DEFAULTS.companyId, "UpTek");
  const departmentId = sanitizePathSegment(
    options.departmentId || DEFAULTS.departmentId,
    "Phong_Marketing",
  );
  const agentId = String(options.agentId || DEFAULTS.agentId).trim() || "nv_media";
  const productModel = await resolveProductModel({
    productModel: options.productModel,
    imagePaths: options.imagePaths,
    imagePrompt: options.imagePrompt,
    workspaceRoot: options.workspaceRoot,
  });
  const prefix = String(options.prefix || DEFAULTS.prefix).trim() || "AI_Generated";
  const galleryRoot = path.resolve(String(options.galleryRoot || DEFAULTS.galleryRoot).trim());
  const targetDir = path.join(galleryRoot, companyId, departmentId);

  await mkdir(targetDir, { recursive: true });

  const copiedFilename = buildCopiedFilename(imagePath);
  const copiedPath = path.join(targetDir, copiedFilename);
  await copyFile(imagePath, copiedPath);

  const fileBuffer = await readFile(copiedPath);
  const base64Data = `data:image/${path.extname(copiedFilename).replace(/^\./, "") || "png"};base64,${fileBuffer.toString("base64")}`;

  const response = await postJson(
    new URL("/api/gallery/agent-upload", backendBaseUrl),
    {
      filename: copiedFilename,
      base64Data,
      productModel,
      prefix,
      companyId,
      departmentId,
      agentId,
    },
    {
      "x-automation-sync-token": automationSyncToken,
    },
  );

  return {
    companyId,
    departmentId,
    copiedPath,
    copiedFilename,
    productModel,
    galleryUrl: response?.url || null,
    imageId: response?.id || null,
    mediaFileId: response?.mediaFileId || null,
  };
}
