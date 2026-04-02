import { access } from "node:fs/promises";
import path from "node:path";
import { buildChatImageReplyPayload } from "../shared/chat-image-result.js";

function buildResult({ success, message, data = {}, artifacts = [], logs = [], error = null }) {
  return { success, message, data, artifacts, logs, error };
}

function printResult(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseArgs(argv) {
  const logs = [];
  const args = argv.slice(2);

  if (args.length === 1 && args[0].trim().startsWith("{")) {
    try {
      return { ...JSON.parse(args[0]), logs };
    } catch (error) {
      logs.push(`[parse] Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { image_path: "", logs };
}

(async function main() {
  const parsed = parseArgs(process.argv);
  const logs = [...parsed.logs, "[start] show_generated_image_in_chat invoked"];

  if (typeof parsed.image_path !== "string" || parsed.image_path.trim() === "") {
    printResult(buildResult({
      success: false,
      message: "Missing required inputs",
      logs,
      error: { code: "VALIDATION_ERROR", details: "Missing field: image_path" },
    }));
    process.exit(1);
  }

  const inputPath = parsed.image_path.trim();
  const absolutePath = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(process.cwd(), inputPath);

  try {
    await access(absolutePath);
  } catch (error) {
    printResult(buildResult({
      success: false,
      message: "Image file not found",
      logs,
      data: {
        input_image_path: inputPath,
        absolute_image_path: absolutePath.replace(/\\/g, "/"),
      },
      error: {
        code: "IMAGE_FILE_MISSING",
        details: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exit(1);
  }

  const chatReply = buildChatImageReplyPayload({
    imagePath: absolutePath,
  });

  printResult(buildResult({
    success: true,
    message: chatReply.assistantText,
    data: chatReply.data,
    artifacts: chatReply.artifacts,
    logs,
    error: null,
  }));
})();
