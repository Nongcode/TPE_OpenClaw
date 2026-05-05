import path from "node:path";

const DEFAULT_ASSISTANT_TEXT = "Đây là video vừa tạo cho bạn:";

function normalizePathForOutput(value) {
  return String(value || "").replace(/\\/g, "/");
}

function toAbsoluteVideoPath(videoPath) {
  return path.isAbsolute(videoPath)
    ? path.normalize(videoPath)
    : path.resolve(process.cwd(), videoPath);
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

export function buildChatVideoReplyPayload(params) {
  const {
    videoPath,
    assistantText = DEFAULT_ASSISTANT_TEXT,
    data = {},
    artifacts = [],
  } = params;

  const absoluteVideoPath = toAbsoluteVideoPath(videoPath);
  const normalizedAbsoluteVideoPath = normalizePathForOutput(absoluteVideoPath);
  const chatArtifactPath = toChatArtifactPath(absoluteVideoPath, data.video_path);

  return {
    assistantText,
    data: {
      ...data,
      video_path: chatArtifactPath,
      downloaded_video_path:
        typeof data.downloaded_video_path === "string" && data.downloaded_video_path.trim()
          ? data.downloaded_video_path
          : chatArtifactPath,
      absolute_video_path: normalizedAbsoluteVideoPath,
      reply_mode: "show_video_in_chat",
      assistant_text_template: assistantText,
    },
    artifacts: buildUniqueArtifacts([
      ...artifacts,
      {
        type: "chat_video",
        path: chatArtifactPath,
      },
    ]),
  };
}

export { DEFAULT_ASSISTANT_TEXT };
