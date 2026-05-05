import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { publishGeneratedImageToUpTekGallery } from "./uptek-gallery-publisher.js";

async function listen(server) {
  return await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("publishGeneratedImageToUpTekGallery", () => {
  const cleanupDirs = [];
  const cleanupServers = [];

  afterEach(async () => {
    while (cleanupServers.length > 0) {
      const server = cleanupServers.pop();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("copies image to UpTek/Phong_Marketing and syncs via backend API", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "uptek-gallery-test-"));
    cleanupDirs.push(tempDir);

    const sourcePath = path.join(tempDir, "source image.png");
    await writeFile(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const requests = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          token: req.headers["x-automation-sync-token"],
          body: JSON.parse(body || "{}"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, url: "/storage/images/UpTek/Phong_Marketing/file.png", id: "img_1", mediaFileId: "media_1" }));
      });
    });
    cleanupServers.push(server);

    const backendBaseUrl = await listen(server);
    const result = await publishGeneratedImageToUpTekGallery(sourcePath, {
      backendBaseUrl,
      automationSyncToken: "token_123",
      galleryRoot: tempDir,
    });

    expect(result.copiedPath).toContain(path.join("UpTek", "Phong_Marketing"));
    expect(result.galleryUrl).toBe("/storage/images/UpTek/Phong_Marketing/file.png");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("/api/gallery/agent-upload");
    expect(requests[0].token).toBe("token_123");
    expect(requests[0].body.companyId).toBe("UpTek");
    expect(requests[0].body.departmentId).toBe("Phong_Marketing");
    expect(requests[0].body.agentId).toBe("nv_media");
    expect(requests[0].body.productModel).toBe("generated_media");
    expect(requests[0].body.prefix).toBe("AI_Generated");
    expect(requests[0].body.base64Data.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("derives product model from matched product artifact image_paths", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "uptek-gallery-artifact-"));
    cleanupDirs.push(tempDir);

    const imageDir = path.join(tempDir, "artifacts", "references", "search_product_text", "may-can-bang");
    const productsDir = path.join(tempDir, "artifacts", "products");
    await mkdir(imageDir, { recursive: true });
    await mkdir(productsDir, { recursive: true });

    const referenceImagePath = path.join(imageDir, "emp9780c-plus.png");
    await writeFile(referenceImagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(
      path.join(productsDir, "sample.json"),
      JSON.stringify({
        product_name: "May can bang lop xe con EMP9780C PLUS",
        image_paths: [referenceImagePath],
      }),
    );

    const generatedPath = path.join(tempDir, "generated.png");
    await writeFile(generatedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const requests = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        requests.push(JSON.parse(body || "{}"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, url: "/storage/images/UpTek/Phong_Marketing/file.png", id: "img_2", mediaFileId: "media_2" }));
      });
    });
    cleanupServers.push(server);

    const backendBaseUrl = await listen(server);
    const result = await publishGeneratedImageToUpTekGallery(generatedPath, {
      backendBaseUrl,
      automationSyncToken: "token_456",
      galleryRoot: tempDir,
      workspaceRoot: tempDir,
      imagePaths: [referenceImagePath],
    });

    expect(result.productModel).toBe("EMP9780C PLUS");
    expect(requests[0].productModel).toBe("EMP9780C PLUS");
  });
});
