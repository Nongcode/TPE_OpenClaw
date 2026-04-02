import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleAgentEvent, type FallbackStatus, type ToolStreamEntry } from "./app-tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type MutableHost = ToolStreamHost & {
  compactionStatus?: unknown;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
};

function createHost(overrides?: Partial<MutableHost>): MutableHost {
  return {
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    ...overrides,
  };
}

describe("app-tool-stream fallback lifecycle handling", () => {
  beforeAll(() => {
    const globalWithWindow = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis;
    };
    if (!globalWithWindow.window) {
      globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
    }
  });

  it("accepts session-scoped fallback lifecycle events when no run is active", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
        reasonSummary: "rate limit",
      },
    });

    expect(host.fallbackStatus?.selected).toBe("fireworks/minimax-m2p5");
    expect(host.fallbackStatus?.active).toBe("deepinfra/moonshotai/Kimi-K2.5");
    expect(host.fallbackStatus?.reason).toBe("rate limit");
    vi.useRealTimers();
  });

  it("rejects idle fallback lifecycle events for other sessions", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:other:main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("auto-clears fallback status after toast duration", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(7_999);
    expect(host.fallbackStatus).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(host.fallbackStatus).toBeNull();
    vi.useRealTimers();
  });

  it("builds previous fallback label from provider + model on fallback_cleared", () => {
    vi.useFakeTimers();
    const host = createHost();

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "fallback_cleared",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "fireworks",
        activeModel: "fireworks/minimax-m2p5",
        previousActiveProvider: "deepinfra",
        previousActiveModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(host.fallbackStatus?.phase).toBe("cleared");
    expect(host.fallbackStatus?.previous).toBe("deepinfra/moonshotai/Kimi-K2.5");
    vi.useRealTimers();
  });

  it("adds image_url blocks for chat image artifacts in tool output JSON", () => {
    const host = createHost({ basePath: "/openclaw" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-1",
        name: "show_generated_image_in_chat",
        result: JSON.stringify({
          success: true,
          artifacts: [
            {
              type: "chat_image",
              path: "artifacts/images/generated.png",
            },
          ],
          data: {
            absolute_image_path: "C:/Users/Administrator/.openclaw/workspace/artifacts/images/generated.png",
          },
        }),
      },
    });

    expect(host.chatToolMessages).toHaveLength(1);
    const message = host.chatToolMessages[0] as { content?: Array<Record<string, unknown>> };
    const imageBlock = message.content?.find((item) => item.type === "image_url");
    expect(imageBlock).toEqual({
      type: "image_url",
      image_url: {
        url: "/openclaw/__openclaw/chat-artifact?absolute_path=C%3A%2FUsers%2FAdministrator%2F.openclaw%2Fworkspace%2Fartifacts%2Fimages%2Fgenerated.png",
      },
    });
  });

  it("adds video_url blocks for chat video artifacts in tool output JSON", () => {
    const host = createHost({ basePath: "/openclaw" });

    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      sessionKey: "main",
      data: {
        phase: "result",
        toolCallId: "tool-2",
        name: "show_generated_video_in_chat",
        result: JSON.stringify({
          success: true,
          artifacts: [
            {
              type: "chat_video",
              path: "artifacts/videos/generated.mp4",
            },
          ],
          data: {
            absolute_video_path:
              "C:/Users/Administrator/.openclaw/workspace/artifacts/videos/generated.mp4",
          },
        }),
      },
    });

    expect(host.chatToolMessages).toHaveLength(1);
    const message = host.chatToolMessages[0] as { content?: Array<Record<string, unknown>> };
    const videoBlock = message.content?.find((item) => item.type === "video_url");
    expect(videoBlock).toEqual({
      type: "video_url",
      video_url: {
        url: "/openclaw/__openclaw/chat-artifact?absolute_path=C%3A%2FUsers%2FAdministrator%2F.openclaw%2Fworkspace%2Fartifacts%2Fvideos%2Fgenerated.mp4",
      },
    });
  });
});
