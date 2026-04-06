const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function sanitizeSegment(value) {
  return String(value || "run")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function toRunId(message) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = sanitizeSegment(message).slice(0, 70) || "workflow";
  return `${stamp}_${slug}`;
}

function resolveBaseDir(options) {
  if (options?.artifactsDir) {
    return path.resolve(options.artifactsDir);
  }
  return path.join(REPO_ROOT, "artifacts", "campaigns", "agent-orchestrator-simulations");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, String(value || "").trim() + "\n", "utf8");
}

function copyOriginalImages(productData, sourceImageDir, outputImageDir) {
  ensureDir(outputImageDir);
  const copied = [];

  const images = Array.isArray(productData?.images) ? productData.images : [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index] || {};
    const sourcePath = image.file_path;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      continue;
    }
    const ext = path.extname(image.file_name || sourcePath) || ".jpg";
    const targetName = `product-image-${String(index + 1).padStart(2, "0")}${ext.toLowerCase()}`;
    const targetPath = path.join(outputImageDir, targetName);
    fs.copyFileSync(sourcePath, targetPath);
    copied.push({
      index: index + 1,
      source: sourcePath,
      fileName: targetName,
      target: targetPath,
      isPrimary: Boolean(image.is_primary),
    });
  }

  if (copied.length === 0 && sourceImageDir && fs.existsSync(sourceImageDir)) {
    const entries = fs.readdirSync(sourceImageDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      const ext = path.extname(entry.name) || ".jpg";
      const targetName = `product-image-${String(index + 1).padStart(2, "0")}${ext.toLowerCase()}`;
      const sourcePath = path.join(sourceImageDir, entry.name);
      const targetPath = path.join(outputImageDir, targetName);
      fs.copyFileSync(sourcePath, targetPath);
      copied.push({
        index: index + 1,
        source: sourcePath,
        fileName: targetName,
        target: targetPath,
        isPrimary: index === 0,
      });
    }
  }

  return copied;
}

function createSimulationArtifacts(plan, options = {}) {
  if (options.disableSimulationArtifacts) {
    return null;
  }

  const runId = toRunId(plan.message || plan.taskType || "workflow");
  const runDir = path.join(resolveBaseDir(options), runId);
  ensureDir(runDir);

  const context = {
    runDir,
    notes: [],
    copiedProductImages: [],
  };

  writeJson(path.join(runDir, "01-plan.json"), plan);

  return {
    runDir,
    addStep(index, stepInfo) {
      const fileName = `${String(index + 1).padStart(2, "0")}-${stepInfo.type}.json`;
      writeJson(path.join(runDir, fileName), stepInfo);
    },
    setProductResearch(searchPayload) {
      writeJson(path.join(runDir, "10-product-research.json"), searchPayload);
      if (searchPayload?.data) {
        const sourceImageDir = searchPayload.data.image_download_dir || null;
        const imageOutputDir = path.join(runDir, "product-original-images");
        const copied = copyOriginalImages(searchPayload.data, sourceImageDir, imageOutputDir);
        context.copiedProductImages = copied;
        writeJson(path.join(runDir, "11-product-original-images.json"), copied);
      }
    },
    setFinalContent(content) {
      if (content) {
        writeText(path.join(runDir, "20-final-content.md"), content);
      }
    },
    setImagePrompt(prompt) {
      if (prompt) {
        writeText(path.join(runDir, "21-image-prompt.txt"), prompt);
      }
    },
    setVideoPrompt(prompt) {
      if (prompt) {
        writeText(path.join(runDir, "22-video-prompt.txt"), prompt);
      }
    },
    setPublishSimulation(payload) {
      if (payload && typeof payload === "object") {
        writeJson(path.join(runDir, "23-facebook-publish-simulation.json"), payload);
      }
    },
    setPublishExecution(payload) {
      if (payload && typeof payload === "object") {
        writeJson(path.join(runDir, "23-facebook-publish-result.json"), payload);
      }
    },
    setBatchInput(payload) {
      if (!payload || typeof payload !== "object") {
        return;
      }
      const batchInput = {
        ...payload,
        copiedProductOriginalImages: context.copiedProductImages,
      };
      writeJson(path.join(runDir, "24-batch-media-post-input.json"), batchInput);
    },
    addNote(note) {
      if (note) {
        context.notes.push(String(note));
      }
    },
    finalize(result) {
      if (context.notes.length > 0) {
        writeJson(path.join(runDir, "99-notes.json"), context.notes);
      }
      writeJson(path.join(runDir, "98-result.json"), {
        mode: result.mode,
        from: result.from,
        totalExecutedSteps: Array.isArray(result.executedSteps) ? result.executedSteps.length : 0,
        finalReplyPreview: String(result.finalReply || "").slice(0, 2000),
      });
    },
  };
}

module.exports = {
  createSimulationArtifacts,
};
