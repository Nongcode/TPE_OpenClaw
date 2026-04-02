import { buildControlUiChatArtifactUrl } from "../../../../src/gateway/control-ui-shared.js";

const CHAT_MEDIA_ARTIFACT_TYPES = new Set([
  "chat_image",
  "generated_image",
  "chat_video",
  "generated_video",
]);

export type UiChatImageBlock =
  | {
      type: "image_url";
      image_url: { url: string };
    }
  | {
      type: "video_url";
      video_url: { url: string };
    };

function serializePreview(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return "{}";
    }
    return serialized.length > 1200 ? `${serialized.slice(0, 1200)}...(truncated)` : serialized;
  } catch {
    return "{}";
  }
}

function debugChatImageArtifact(event: string, details: Record<string, unknown>) {
  try {
    console.debug("[openclaw chat media]", event, details);
  } catch {
    // Ignore logging failures in constrained runtimes.
  }
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function isRemoteMediaSource(value: string): boolean {
  return /^(https?:\/\/|data:(?:image|video)\/)/i.test(value);
}

function isVideoArtifactType(artifactType: string): boolean {
  return artifactType.includes("video");
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/");
}

function isAlreadyBridgedControlUiArtifact(value: string): boolean {
  return /\/__openclaw\/chat-artifact\?(?:path|absolute_path)=/i.test(value);
}

function preferAbsoluteLocalSource(source: unknown, absoluteFallback?: string | null): string | null {
  const normalized = normalizeString(source);
  if (!normalized) {
    return null;
  }
  if (isRemoteMediaSource(normalized) || isAbsoluteLocalPath(normalized)) {
    return normalized;
  }
  return absoluteFallback ?? normalized;
}

function resolveArtifactsRelativePath(source: string): string | null {
  const normalized = source.replace(/\\/g, "/");
  if (normalized.startsWith("artifacts/")) {
    const relative = normalized.slice("artifacts/".length).trim();
    return relative || null;
  }

  const marker = "/artifacts/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index >= 0) {
    const relative = normalized.slice(index + marker.length).trim();
    return relative || null;
  }
  return null;
}

function resolveUiImageSource(source: string, basePath = ""): string {
  if (isRemoteMediaSource(source) || isAlreadyBridgedControlUiArtifact(source)) {
    return source;
  }
  if (isAbsoluteLocalPath(source)) {
    return buildControlUiChatArtifactUrl(basePath, source, { absolute: true });
  }
  const relativeArtifactPath = resolveArtifactsRelativePath(source);
  if (!relativeArtifactPath) {
    return source;
  }
  return buildControlUiChatArtifactUrl(basePath, relativeArtifactPath);
}

function pushImageBlock(
  blocks: UiChatImageBlock[],
  emitted: Set<string>,
  source: unknown,
  basePath?: string,
  blockType: "image_url" | "video_url" = "image_url",
  debug?: {
    payloadPreview?: string;
    selectedSource?: string | null;
  },
) {
  const normalized = normalizeString(source);
  if (!normalized) {
    return;
  }
  const finalUrl = resolveUiImageSource(normalized, basePath);
  if (emitted.has(finalUrl)) {
    return;
  }
  emitted.add(finalUrl);
  if (blockType === "video_url") {
    blocks.push({
      type: "video_url",
      video_url: { url: finalUrl },
    });
  } else {
    blocks.push({
      type: "image_url",
      image_url: { url: finalUrl },
    });
  }
  debugChatImageArtifact("collect", {
    payloadPreview: debug?.payloadPreview,
    selectedSource: debug?.selectedSource ?? normalized,
    finalUrl,
    blockType,
  });
}

function collectImageBlocksFromRecord(
  record: Record<string, unknown>,
  blocks: UiChatImageBlock[],
  emitted: Set<string>,
  basePath?: string,
) {
  const payloadPreview = serializePreview(record);
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  const absoluteImageFallback = normalizeString(data?.absolute_image_path);
  const absoluteVideoFallback = normalizeString(data?.absolute_video_path);
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") {
      continue;
    }
    const typedArtifact = artifact as Record<string, unknown>;
    const artifactType = normalizeString(typedArtifact.type)?.toLowerCase();
    if (!artifactType || !CHAT_MEDIA_ARTIFACT_TYPES.has(artifactType)) {
      continue;
    }
    const absoluteFallback = isVideoArtifactType(artifactType)
      ? absoluteVideoFallback
      : absoluteImageFallback;
    const blockType = isVideoArtifactType(artifactType) ? "video_url" : "image_url";
    pushImageBlock(
      blocks,
      emitted,
      preferAbsoluteLocalSource(typedArtifact.path, absoluteFallback),
      basePath,
      blockType,
      {
        payloadPreview,
        selectedSource: normalizeString(typedArtifact.path),
      },
    );
    pushImageBlock(
      blocks,
      emitted,
      typedArtifact.url,
      basePath,
      blockType,
      {
        payloadPreview,
        selectedSource: normalizeString(typedArtifact.url),
      },
    );
  }

  pushImageBlock(
    blocks,
    emitted,
    preferAbsoluteLocalSource(data?.relative_image_path, absoluteImageFallback),
    basePath,
    "image_url",
    {
      payloadPreview,
      selectedSource: normalizeString(data?.relative_image_path),
    },
  );
  pushImageBlock(blocks, emitted, absoluteImageFallback, basePath, "image_url", {
    payloadPreview,
    selectedSource: absoluteImageFallback,
  });

  pushImageBlock(
    blocks,
    emitted,
    preferAbsoluteLocalSource(data?.relative_video_path, absoluteVideoFallback),
    basePath,
    "video_url",
    {
      payloadPreview,
      selectedSource: normalizeString(data?.relative_video_path),
    },
  );
  pushImageBlock(blocks, emitted, absoluteVideoFallback, basePath, "video_url", {
    payloadPreview,
    selectedSource: absoluteVideoFallback,
  });
}

function collectImageBlocksFromParsedValue(
  value: unknown,
  blocks: UiChatImageBlock[],
  emitted: Set<string>,
  basePath?: string,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  collectImageBlocksFromRecord(value as Record<string, unknown>, blocks, emitted, basePath);
}

export function collectChatImageBlocksFromValue(value: unknown, basePath?: string): UiChatImageBlock[] {
  const blocks: UiChatImageBlock[] = [];
  const emitted = new Set<string>();

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return blocks;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      collectImageBlocksFromParsedValue(parsed, blocks, emitted, basePath);
    } catch {
      // Non-JSON tool output is expected.
    }
    return blocks;
  }

  collectImageBlocksFromParsedValue(value, blocks, emitted, basePath);
  return blocks;
}

export function extractInlineImageBlocks(message: unknown, basePath?: string): UiChatImageBlock[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const entry = message as Record<string, unknown>;
  const content = Array.isArray(entry.content) ? entry.content : [];
  const blocks: UiChatImageBlock[] = [];
  const emitted = new Set<string>();

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const block = item as Record<string, unknown>;
    const blockType = normalizeString(block.type)?.toLowerCase();
    if (blockType === "image_url") {
      const nested = block.image_url as Record<string, unknown> | undefined;
      pushImageBlock(blocks, emitted, nested?.url, basePath, "image_url");
      continue;
    }
    if (blockType === "video_url") {
      const nested = block.video_url as Record<string, unknown> | undefined;
      pushImageBlock(blocks, emitted, nested?.url, basePath, "video_url");
      continue;
    }
    if (blockType === "image") {
      const source = block.source as Record<string, unknown> | undefined;
      if (typeof source?.data === "string" && source.type === "base64") {
        const mediaType = normalizeString(source.media_type) ?? "image/png";
        const data = source.data.startsWith("data:")
          ? source.data
          : `data:${mediaType};base64,${source.data}`;
        pushImageBlock(blocks, emitted, data, basePath, "image_url");
        continue;
      }
      pushImageBlock(blocks, emitted, block.url, basePath, "image_url");
      continue;
    }
    if (blockType === "video") {
      const source = block.source as Record<string, unknown> | undefined;
      if (typeof source?.data === "string" && source.type === "base64") {
        const mediaType = normalizeString(source.media_type) ?? "video/mp4";
        const data = source.data.startsWith("data:")
          ? source.data
          : `data:${mediaType};base64,${source.data}`;
        pushImageBlock(blocks, emitted, data, basePath, "video_url");
        continue;
      }
      pushImageBlock(blocks, emitted, block.url, basePath, "video_url");
      continue;
    }
  }

  if (blocks.length > 0) {
    return blocks;
  }

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const block = item as Record<string, unknown>;
    if (typeof block.text === "string") {
      for (const parsedBlock of collectChatImageBlocksFromValue(block.text, basePath)) {
        if (parsedBlock.type === "video_url") {
          pushImageBlock(blocks, emitted, parsedBlock.video_url.url, basePath, "video_url");
        } else {
          pushImageBlock(blocks, emitted, parsedBlock.image_url.url, basePath, "image_url");
        }
      }
    }
  }

  return blocks;
}
