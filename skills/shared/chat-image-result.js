import path from "node:path";

const DEFAULT_ASSISTANT_TEXT = "Đây là ảnh vừa tạo cho bạn:";

function normalizePathForOutput(value) {
  return String(value || "").replace(/\\/g, "/");
}

function toAbsoluteImagePath(imagePath) {
  return path.isAbsolute(imagePath)
    ? path.normalize(imagePath)
    : path.resolve(process.cwd(), imagePath);
}

function toRelativeWorkspacePath(absolutePath) {
  return path.relative(process.cwd(), absolutePath).replace(/\\/g, "/");
}

function toChatArtifactPath(absolutePath, preferredPath) {
  if (typeof preferredPath === "string" && preferredPath.trim()) {
    return normalizePathForOutput(preferredPath.trim());
  }

  const normalizedAbsolutePath = normalizePathForOutput(absolutePath);
  const artifactsMarker = "/artifacts/";
  const artifactsIndex = normalizedAbsolutePath.toLowerCase().lastIndexOf(artifactsMarker);
  if (artifactsIndex >= 0) {
    return `artifacts/${normalizedAbsolutePath.slice(artifactsIndex + artifactsMarker.length)}`;
  }

  const relativePath = toRelativeWorkspacePath(absolutePath);
  if (
    relativePath &&
    !relativePath.startsWith("../") &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return normalizedAbsolutePath;
}

function buildUniqueArtifacts(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const type = typeof item.type === "string" ? item.type.trim() : "";
    const itemPath = typeof item.path === "string" ? item.path.trim() : "";
    const key = `${type}\u001F${itemPath}`;
    if (!type || !itemPath || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ ...item, type, path: itemPath });
  }

  return result;
}

export function buildChatImageReplyPayload(params) {
  const {
    imagePath,
    assistantText = DEFAULT_ASSISTANT_TEXT,
    data = {},
    artifacts = [],
  } = params;

  const absoluteImagePath = toAbsoluteImagePath(imagePath);
  const normalizedAbsoluteImagePath = normalizePathForOutput(absoluteImagePath);
  const chatArtifactPath = toChatArtifactPath(absoluteImagePath, data.image_path);

  return {
    assistantText,
    data: {
      ...data,
      image_path: chatArtifactPath,
      downloaded_image_path:
        typeof data.downloaded_image_path === "string" && data.downloaded_image_path.trim()
          ? data.downloaded_image_path
          : chatArtifactPath,
      absolute_image_path: normalizedAbsoluteImagePath,
      reply_mode: "show_image_in_chat",
      assistant_text_template: assistantText,
    },
    artifacts: buildUniqueArtifacts([
      ...artifacts,
      {
        type: "chat_image",
        path: chatArtifactPath,
      },
    ]),
  };
}

export { DEFAULT_ASSISTANT_TEXT };
