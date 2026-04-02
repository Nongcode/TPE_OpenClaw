import path from "node:path";
import { buildControlUiChatArtifactUrl } from "./control-ui-shared.js";

const CHAT_MEDIA_ARTIFACT_TYPES = new Set([
  "chat_image",
  "generated_image",
  "chat_video",
  "generated_video",
]);

type ChatImageArtifactCandidate = {
  source: string;
  artifactType: string;
  payloadPreview: string;
};

export type ChatImageArtifactBlock =
  | {
      type: "image_url";
      image_url: { url: string };
      filePath?: string;
    }
  | {
      type: "video_url";
      video_url: { url: string };
      filePath?: string;
    };

export type ChatImageArtifactDebug = {
  payloadPreview: string;
  selectedSource: string;
  resolvedFilePath?: string;
  finalSource: string;
  artifactType: string;
};

function normalizeStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

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

function isRemoteMediaSource(value: string): boolean {
  return /^(https?:\/\/|data:(?:image|video)\/)/i.test(value);
}

function isVideoArtifactType(artifactType: string): boolean {
  return artifactType.includes("video");
}

function fallbackArtifactTypeForField(kind: "image" | "video"): string {
  return kind === "video" ? "generated_video" : "generated_image";
}

function preferAbsoluteLocalSource(source: unknown, absoluteFallback?: string): string | undefined {
  const normalized = normalizeStringValue(source);
  if (!normalized) {
    return undefined;
  }
  if (isRemoteMediaSource(normalized) || path.isAbsolute(normalized)) {
    return normalized;
  }
  return absoluteFallback ?? normalized;
}

function resolveArtifactAbsolutePath(source: string): string | undefined {
  if (isRemoteMediaSource(source)) {
    return undefined;
  }
  const resolved = path.isAbsolute(source) ? path.normalize(source) : path.resolve(process.cwd(), source);
  return resolved.replace(/\\/g, "/");
}

function resolveArtifactRelativeToRoot(absolutePath: string): string | undefined {
  const artifactsRoot = path.resolve(process.cwd(), "artifacts");
  const candidate = path.resolve(absolutePath);
  const relative = path.relative(artifactsRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, "/");
}

function pushCandidate(
  candidates: ChatImageArtifactCandidate[],
  seen: Set<string>,
  source: unknown,
  artifactType: string,
  payloadPreview: string,
) {
  const normalized = normalizeStringValue(source);
  if (!normalized) {
    return;
  }
  const dedupeKey = `${artifactType}\u{001F}${normalized}`;
  if (seen.has(dedupeKey)) {
    return;
  }
  seen.add(dedupeKey);
  candidates.push({
    source: normalized,
    artifactType,
    payloadPreview,
  });
}

function collectCandidatesFromRecord(
  record: Record<string, unknown>,
  candidates: ChatImageArtifactCandidate[],
  seen: Set<string>,
) {
  const payloadPreview = serializePreview(record);
  const data =
    record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? (record.data as Record<string, unknown>)
      : undefined;
  const absoluteImageFallback = normalizeStringValue(data?.absolute_image_path);
  const absoluteVideoFallback = normalizeStringValue(data?.absolute_video_path);

  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") {
      continue;
    }
    const typedArtifact = artifact as Record<string, unknown>;
    const artifactType = normalizeStringValue(typedArtifact.type)?.toLowerCase();
    if (!artifactType || !CHAT_MEDIA_ARTIFACT_TYPES.has(artifactType)) {
      continue;
    }
    const absoluteFallback = isVideoArtifactType(artifactType)
      ? absoluteVideoFallback
      : absoluteImageFallback;
    pushCandidate(
      candidates,
      seen,
      preferAbsoluteLocalSource(typedArtifact.path, absoluteFallback),
      artifactType,
      payloadPreview,
    );
    pushCandidate(candidates, seen, typedArtifact.url, artifactType, payloadPreview);
  }

  const imageFallbackArtifactType = fallbackArtifactTypeForField("image");
  const imageFallbackSource = preferAbsoluteLocalSource(
    data?.relative_image_path,
    absoluteImageFallback,
  );
  pushCandidate(candidates, seen, imageFallbackSource, imageFallbackArtifactType, payloadPreview);
  pushCandidate(candidates, seen, absoluteImageFallback, imageFallbackArtifactType, payloadPreview);

  const videoFallbackArtifactType = fallbackArtifactTypeForField("video");
  const videoFallbackSource = preferAbsoluteLocalSource(
    data?.relative_video_path,
    absoluteVideoFallback,
  );
  pushCandidate(candidates, seen, videoFallbackSource, videoFallbackArtifactType, payloadPreview);
  pushCandidate(candidates, seen, absoluteVideoFallback, videoFallbackArtifactType, payloadPreview);
}

export function collectChatImageBlocksFromMessage(params: {
  message: Record<string, unknown>;
  controlUiBasePath?: string;
}): { blocks: ChatImageArtifactBlock[]; debug: ChatImageArtifactDebug[] } {
  const { message, controlUiBasePath = "" } = params;
  const candidates: ChatImageArtifactCandidate[] = [];
  const seen = new Set<string>();

  collectCandidatesFromRecord(message, candidates, seen);

  if (message.details && typeof message.details === "object" && !Array.isArray(message.details)) {
    collectCandidatesFromRecord(message.details as Record<string, unknown>, candidates, seen);
  }

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const text = normalizeStringValue((block as { text?: unknown }).text);
      if (!text) {
        continue;
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          collectCandidatesFromRecord(parsed as Record<string, unknown>, candidates, seen);
        }
      } catch {
        // Non-JSON text blocks are expected.
      }
    }
  }

  const blocks: ChatImageArtifactBlock[] = [];
  const debug: ChatImageArtifactDebug[] = [];
  const emittedFinalSources = new Set<string>();

  for (const candidate of candidates) {
    const resolvedFilePath = resolveArtifactAbsolutePath(candidate.source);
    const bridgedRelativePath = resolvedFilePath
      ? resolveArtifactRelativeToRoot(resolvedFilePath)
      : undefined;
    const finalSource =
      bridgedRelativePath
        ? buildControlUiChatArtifactUrl(controlUiBasePath, bridgedRelativePath)
        : resolvedFilePath
          ? buildControlUiChatArtifactUrl(controlUiBasePath, resolvedFilePath, { absolute: true })
        : candidate.source;
    if (emittedFinalSources.has(finalSource)) {
      continue;
    }
    emittedFinalSources.add(finalSource);
    if (isVideoArtifactType(candidate.artifactType)) {
      blocks.push({
        type: "video_url",
        video_url: { url: finalSource },
        ...(resolvedFilePath ? { filePath: resolvedFilePath } : {}),
      });
    } else {
      blocks.push({
        type: "image_url",
        image_url: { url: finalSource },
        ...(resolvedFilePath ? { filePath: resolvedFilePath } : {}),
      });
    }
    debug.push({
      payloadPreview: candidate.payloadPreview,
      selectedSource: candidate.source,
      resolvedFilePath,
      finalSource,
      artifactType: candidate.artifactType,
    });
  }

  return { blocks, debug };
}
