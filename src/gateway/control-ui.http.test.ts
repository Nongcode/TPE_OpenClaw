import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_LOGIN_PATH,
} from "./control-ui-contract.js";
import { handleControlUiAvatarRequest, handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("handleControlUiHttpRequest", () => {
  async function withControlUiRoot<T>(params: {
    indexHtml?: string;
    fn: (tmp: string) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      return await params.fn(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      basePath: string;
      assistantName: string;
      assistantAvatar: string;
      assistantAgentId: string;
      accessPolicy?: {
        employeeId?: string;
        employeeName?: string;
        lockedAgentId?: string;
        lockedSessionKey?: string;
        canViewAllSessions?: boolean;
        visibleAgentIds?: string[];
        lockAgent?: boolean;
        lockSession?: boolean;
        enforcedByServer?: boolean;
      };
    };
  }

  function expectNotFoundResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(404);
    expect(params.end).toHaveBeenCalledWith("Not Found");
  }

  function runControlUiRequest(params: {
    url: string;
    method: "GET" | "HEAD" | "POST";
    rootPath: string;
    basePath?: string;
    rootKind?: "resolved" | "bundled";
    config?: Record<string, unknown>;
    resolvedAuth?: Record<string, unknown>;
    trustedProxies?: string[];
    remoteAddress?: string;
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiHttpRequest(
      {
        url: params.url,
        method: params.method,
        socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
      } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        ...(params.config ? { config: params.config as never } : {}),
        ...(params.resolvedAuth ? { resolvedAuth: params.resolvedAuth as never } : {}),
        ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
        root: { kind: params.rootKind ?? "resolved", path: params.rootPath },
      },
    );
    return { res, end, handled };
  }

  async function runControlUiRequestWithBody(params: {
    url: string;
    method: "POST";
    rootPath: string;
    body: string;
    config?: Record<string, unknown>;
  }) {
    const req = {
      url: params.url,
      method: params.method,
      socket: { remoteAddress: "127.0.0.1" },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "data") {
          handler(Buffer.from(params.body));
        }
        if (event === "end") {
          handler();
        }
        return req;
      },
    } as unknown as IncomingMessage;
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiHttpRequest(req, res, {
      ...(params.config ? { config: params.config as never } : {}),
      root: { kind: "resolved", path: params.rootPath },
    });
    await Promise.resolve();
    await Promise.resolve();
    return { res, end, handled };
  }

  function runAvatarRequest(params: {
    url: string;
    method: "GET" | "HEAD";
    resolveAvatar: Parameters<typeof handleControlUiAvatarRequest>[2]["resolveAvatar"];
    basePath?: string;
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiAvatarRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        resolveAvatar: params.resolveAvatar,
      },
    );
    return { res, end, handled };
  }

  async function writeAssetFile(rootPath: string, filename: string, contents: string) {
    const assetsDir = path.join(rootPath, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    const filePath = path.join(assetsDir, filename);
    await fs.writeFile(filePath, contents);
    return { assetsDir, filePath };
  }

  async function createHardlinkedAssetFile(rootPath: string) {
    const { filePath } = await writeAssetFile(rootPath, "app.js", "console.log('hi');");
    const hardlinkPath = path.join(path.dirname(filePath), "app.hl.js");
    await fs.link(filePath, hardlinkPath);
    return hardlinkPath;
  }

  async function withBasePathRootFixture<T>(params: {
    siblingDir: string;
    fn: (paths: { root: string; sibling: string }) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-root-"));
    try {
      const root = path.join(tmp, "ui");
      const sibling = path.join(tmp, params.siblingDir);
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(path.join(root, "index.html"), "<html>ok</html>\n");
      return await params.fn({ root, sibling });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  it("sets security headers for Control UI responses", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, setHeader } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        const csp = setHeader.mock.calls.find((call) => call[0] === "Content-Security-Policy")?.[1];
        expect(typeof csp).toBe("string");
        expect(String(csp)).toContain("frame-ancestors 'none'");
        expect(String(csp)).toContain("script-src 'self'");
        expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
      },
    });
  });

  it("does not inject inline scripts into index.html", async () => {
    const html = "<html><head></head><body>Hello</body></html>\n";
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "evil.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        expect(end).toHaveBeenCalledWith(html);
      },
    });
  });

  it("serves bootstrap config JSON", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "</script>.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantName).toBe("</script><script>alert(1)//");
        expect(parsed.assistantAvatar).toBe("/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("serves bootstrap config JSON under basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, method: "GET" } as IncomingMessage,
          res,
          {
            basePath: "/openclaw",
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("/openclaw");
        expect(parsed.assistantName).toBe("Ops");
        expect(parsed.assistantAvatar).toBe("/openclaw/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("resolves employee access policy from gateway.controlUi.employeeDirectory", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          {
            url: `${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}?employeeId=emp-01&agent=nv_media&lockSession=1`,
            method: "GET",
          } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              gateway: {
                controlUi: {
                  employeeDirectory: [
                    {
                      employeeId: "emp-01",
                      employeeName: "Lan",
                      lockedAgentId: "nv_content",
                      lockSession: true,
                    },
                  ],
                },
              },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.accessPolicy).toEqual({
          employeeId: "emp-01",
          employeeName: "Lan",
          lockedAgentId: "nv_content",
          lockedSessionKey: "agent:nv_content:main",
          canViewAllSessions: false,
          visibleAgentIds: ["nv_content"],
          lockAgent: true,
          lockSession: true,
          autoConnect: false,
          enforcedByServer: true,
        });
      },
    });
  });

  it("derives employee identity from trusted-proxy auth for bootstrap policy lookup", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const req = {
          url: `${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
          method: "GET",
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            "x-forwarded-user": "lan@example.com",
            "x-forwarded-proto": "https",
          },
        } as IncomingMessage;
        const { res: res2, end: end2 } = makeMockHttpResponse();
        const handled2 = handleControlUiHttpRequest(req, res2, {
          root: { kind: "resolved", path: tmp },
          trustedProxies: ["127.0.0.1"],
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: {
              userHeader: "x-forwarded-user",
              displayNameHeader: "x-forwarded-name",
              requiredHeaders: ["x-forwarded-proto"],
            },
          },
          config: {
            agents: { defaults: { workspace: tmp } },
            gateway: {
              controlUi: {
                employeeDirectory: [
                  {
                    employeeId: "lan@example.com",
                    employeeName: "Lan",
                    lockedAgentId: "nv_content",
                    lockSession: true,
                  },
                ],
              },
            },
          },
        });

        expect(handled2).toBe(true);
        const parsed = parseBootstrapPayload(end2);
        expect(parsed.accessPolicy).toEqual({
          employeeId: "lan@example.com",
          employeeName: "Lan",
          lockedAgentId: "nv_content",
          lockedSessionKey: "agent:nv_content:main",
          canViewAllSessions: false,
          visibleAgentIds: ["nv_content"],
          lockAgent: true,
          lockSession: true,
          autoConnect: false,
          enforcedByServer: true,
        });
      },
    });
  });

  it("uses trusted-proxy display name when directory entry omits employeeName", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const req = {
          url: `${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
          method: "GET",
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            "x-forwarded-user": "minh@example.com",
            "x-forwarded-name": "Minh Tran",
            "x-forwarded-proto": "https",
          },
        } as IncomingMessage;
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(req, res, {
          root: { kind: "resolved", path: tmp },
          trustedProxies: ["127.0.0.1"],
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: {
              userHeader: "x-forwarded-user",
              displayNameHeader: "x-forwarded-name",
              requiredHeaders: ["x-forwarded-proto"],
            },
          },
          config: {
            agents: { defaults: { workspace: tmp } },
            gateway: {
              controlUi: {
                employeeDirectory: [
                  {
                    employeeId: "minh@example.com",
                    lockedAgentId: "nv_media",
                    lockSession: true,
                  },
                ],
              },
            },
          },
        });

        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.accessPolicy).toEqual({
          employeeId: "minh@example.com",
          employeeName: "Minh Tran",
          lockedAgentId: "nv_media",
          lockedSessionKey: "agent:nv_media:main",
          canViewAllSessions: false,
          visibleAgentIds: ["nv_media"],
          lockAgent: true,
          lockSession: true,
          autoConnect: false,
          enforcedByServer: true,
        });
      },
    });
  });

  it("includes manager-wide visibility in bootstrap fallback when employeeDirectory does not match", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          {
            url: `${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}?employeeId=sep_long%40example.com&agent=quan_ly&session=agent%3Aquan_ly%3Amain&lockSession=1&lockAgent=1`,
            method: "GET",
          } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
            },
          },
        );

        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.accessPolicy).toEqual({
          employeeId: "sep_long@example.com",
          lockedAgentId: "quan_ly",
          lockedSessionKey: "agent:quan_ly:main",
          canViewAllSessions: true,
          lockAgent: true,
          lockSession: true,
          autoConnect: false,
          enforcedByServer: false,
        });
      },
    });
  });

  it("applies default hierarchy visibility for truong_phong without explicit visibleAgentIds", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          {
            url: `${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}?employeeId=truong_phong_01`,
            method: "GET",
          } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              gateway: {
                controlUi: {
                  employeeDirectory: [
                    {
                      employeeId: "truong_phong_01",
                      employeeName: "Truong Phong Marketing",
                      lockedAgentId: "truong_phong",
                    },
                  ],
                },
              },
            },
          },
        );

        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.accessPolicy).toEqual({
          employeeId: "truong_phong_01",
          employeeName: "Truong Phong Marketing",
          lockedAgentId: "truong_phong",
          lockedSessionKey: "agent:truong_phong:main",
          canViewAllSessions: false,
          visibleAgentIds: ["truong_phong", "pho_phong", "nv_content", "nv_media"],
          lockAgent: false,
          lockSession: false,
          autoConnect: false,
          enforcedByServer: true,
        });
      },
    });
  });

  it("applies default hierarchy visibility for pho_phong without explicit visibleAgentIds", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          {
            url: `${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}?employeeId=pho_phong_01`,
            method: "GET",
          } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              gateway: {
                controlUi: {
                  employeeDirectory: [
                    {
                      employeeId: "pho_phong_01",
                      employeeName: "Pho Phong Marketing",
                      lockedAgentId: "pho_phong",
                    },
                  ],
                },
              },
            },
          },
        );

        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.accessPolicy).toEqual({
          employeeId: "pho_phong_01",
          employeeName: "Pho Phong Marketing",
          lockedAgentId: "pho_phong",
          lockedSessionKey: "agent:pho_phong:main",
          canViewAllSessions: false,
          visibleAgentIds: ["pho_phong", "nv_content", "nv_media"],
          lockAgent: false,
          lockSession: false,
          autoConnect: false,
          enforcedByServer: true,
        });
      },
    });
  });

  it("authenticates demo login accounts and returns token plus access policy", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end, handled } = await runControlUiRequestWithBody({
          url: CONTROL_UI_LOGIN_PATH,
          method: "POST",
          rootPath: tmp,
          body: JSON.stringify({
            email: "content@example.com",
            password: "Demo@123",
          }),
          config: {
            gateway: {
              auth: { token: "demo-token" },
              controlUi: {
                employeeDirectory: [
                  {
                    employeeId: "lan_content",
                    employeeName: "Lan Content",
                    lockedAgentId: "nv_content",
                    lockSession: true,
                  },
                ],
                demoLogin: {
                  enabled: true,
                  accounts: [
                    {
                      email: "content@example.com",
                      password: "Demo@123",
                      employeeId: "lan_content",
                      label: "Nhan vien content",
                    },
                  ],
                },
              },
            },
          },
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(String(end.mock.calls[0]?.[0] ?? ""))).toEqual({
          ok: true,
          token: "demo-token",
          accessPolicy: {
            employeeId: "lan_content",
            employeeName: "Lan Content",
            lockedAgentId: "nv_content",
            lockedSessionKey: "agent:nv_content:main",
            canViewAllSessions: false,
            visibleAgentIds: ["nv_content"],
            lockAgent: true,
            lockSession: true,
            autoConnect: false,
            enforcedByServer: true,
          },
        });
      },
    });
  });

  it("serves local avatar bytes through hardened avatar handler", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-"));
    try {
      const avatarPath = path.join(tmp, "main.png");
      await fs.writeFile(avatarPath, "avatar-bytes\n");

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: avatarPath }),
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("avatar-bytes\n");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects avatar symlink paths from resolver", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "outside-secret\n");
      const linkPath = path.join(tmp, "avatar-link.png");
      await fs.symlink(outsideFile, linkPath);

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: linkPath }),
      });

      expectNotFoundResponse({ handled, res, end });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlinked assets that resolve outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-outside-"));
        try {
          const outsideFile = path.join(outsideDir, "secret.txt");
          await fs.mkdir(assetsDir, { recursive: true });
          await fs.writeFile(outsideFile, "outside-secret\n");
          await fs.symlink(outsideFile, path.join(assetsDir, "leak.txt"));

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: "/assets/leak.txt", method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
            },
          );
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("allows symlinked assets that resolve inside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { assetsDir, filePath } = await writeAssetFile(tmp, "actual.txt", "inside-ok\n");
        await fs.symlink(filePath, path.join(assetsDir, "linked.txt"));

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/linked.txt",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("inside-ok\n");
      },
    });
  });

  it("serves HEAD for in-root assets without writing a body", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/actual.txt",
          method: "HEAD",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(end.mock.calls[0]?.length ?? -1).toBe(0);
      },
    });
  });

  it("rejects symlinked SPA fallback index.html outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-outside-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.symlink(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = runControlUiRequest({
            url: "/app/route",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked index.html for non-package control-ui roots", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-hardlink-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside-hardlink</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.link(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = runControlUiRequest({
            url: "/",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked asset files for custom/resolved roots (security boundary)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await createHardlinkedAssetFile(tmp);

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(404);
        expect(end).toHaveBeenCalledWith("Not Found");
      },
    });
  });

  it("serves hardlinked asset files for bundled roots (pnpm global install)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await createHardlinkedAssetFile(tmp);

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("console.log('hi');");
      },
    });
  });

  it("does not handle POST to root-mounted paths (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const webhookPath of ["/bluebubbles-webhook", "/custom-webhook", "/callback"]) {
          const { res } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: webhookPath, method: "POST" } as IncomingMessage,
            res,
            { root: { kind: "resolved", path: tmp } },
          );
          expect(handled, `POST to ${webhookPath} should pass through to plugin handlers`).toBe(
            false,
          );
        }
      },
    });
  });

  it("does not handle POST to paths outside basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/bluebubbles-webhook", method: "POST" } as IncomingMessage,
          res,
          { basePath: "/openclaw", root: { kind: "resolved", path: tmp } },
        );
        expect(handled).toBe(false);
      },
    });
  });

  it("does not handle /api paths when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const apiPath of ["/api", "/api/sessions", "/api/channels/nostr"]) {
          const { handled } = runControlUiRequest({
            url: apiPath,
            method: "GET",
            rootPath: tmp,
          });
          expect(handled, `expected ${apiPath} to not be handled`).toBe(false);
        }
      },
    });
  });

  it("does not handle /plugins paths when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const pluginPath of ["/plugins", "/plugins/diffs/view/abc/def"]) {
          const { handled } = runControlUiRequest({
            url: pluginPath,
            method: "GET",
            rootPath: tmp,
          });
          expect(handled, `expected ${pluginPath} to not be handled`).toBe(false);
        }
      },
    });
  });

  it("falls through POST requests when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { handled, end } = runControlUiRequest({
          url: "/webhook/bluebubbles",
          method: "POST",
          rootPath: tmp,
        });
        expect(handled).toBe(false);
        expect(end).not.toHaveBeenCalled();
      },
    });
  });

  it("falls through POST requests under configured basePath (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const route of ["/openclaw", "/openclaw/", "/openclaw/some-page"]) {
          const { handled, end } = runControlUiRequest({
            url: route,
            method: "POST",
            rootPath: tmp,
            basePath: "/openclaw",
          });
          expect(handled, `POST to ${route} should pass through to plugin handlers`).toBe(false);
          expect(end, `POST to ${route} should not write a response`).not.toHaveBeenCalled();
        }
      },
    });
  });

  it("rejects absolute-path escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "ui-secrets",
      fn: async ({ root, sibling }) => {
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const secretPathUrl = secretPath.split(path.sep).join("/");
        const absolutePathUrl = secretPathUrl.startsWith("/") ? secretPathUrl : `/${secretPathUrl}`;
        const { res, end, handled } = runControlUiRequest({
          url: `/openclaw/${absolutePathUrl}`,
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("rejects symlink escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "outside",
      fn: async ({ root, sibling }) => {
        await fs.mkdir(path.join(root, "assets"), { recursive: true });
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const linkPath = path.join(root, "assets", "leak.txt");
        try {
          await fs.symlink(secretPath, linkPath, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") {
            return;
          }
          throw error;
        }

        const { res, end, handled } = runControlUiRequest({
          url: "/openclaw/assets/leak.txt",
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });
});
