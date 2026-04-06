const { normalizeText } = require("./common");

function stripMarkdownFormatting(value) {
  return String(value || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function cleanStructuredLine(value) {
  return stripMarkdownFormatting(value)
    .replace(/^\[(hot|gia|inbox)\]\s*/i, "")
    .replace(/^[\u2705\u2714]+\s*/u, "- ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushLine(lines, value) {
  const cleaned = cleanStructuredLine(value);
  if (!cleaned) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    return;
  }
  lines.push(cleaned);
}

function collapseLines(lines) {
  const collapsed = [];
  for (const line of lines) {
    const value = String(line || "").trim();
    if (!value) {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== "") {
        collapsed.push("");
      }
      continue;
    }
    collapsed.push(value);
  }
  while (collapsed[0] === "") {
    collapsed.shift();
  }
  while (collapsed[collapsed.length - 1] === "") {
    collapsed.pop();
  }
  return collapsed.join("\n");
}

function isOneOf(normalizedLine, patterns) {
  return patterns.some((pattern) => normalizedLine === pattern || normalizedLine.startsWith(pattern));
}

function isIntroLine(normalizedLine) {
  return isOneOf(normalizedLine, [
    "da trien khai bai viet cho san pham",
    "ban thao noi dung ban hang cho san pham",
    "ban thao bai viet",
    "ban nhap content hoan chinh",
    "da hoan thien ban thao content",
    "da trien khai ban thao bai viet",
    "nhan vien content da hoan thanh",
    "ban nhap content dau tien de",
    "toi da hoan thanh ban nhap content facebook",
  ]);
}

function extractContentSections(value) {
  const sections = {
    hook: [],
    body: [],
    cta: [],
    hashtags: [],
  };
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return { hook: "", body: "", cta: "", hashtags: "" };
  }

  let currentSection = "body";
  let skipSection = false;

  for (const rawLine of text.split("\n")) {
    const trimmedLine = rawLine.trim();
    const cleanedLine = cleanStructuredLine(trimmedLine);
    const normalizedLine = normalizeText(cleanedLine.replace(/:$/, ""));

    if (!trimmedLine) {
      if (!skipSection) {
        pushLine(sections[currentSection], "");
      }
      continue;
    }

    if (normalizedLine === "rui ro" || normalizedLine === "de xuat buoc tiep") {
      break;
    }

    if (normalizedLine === "ket qua") {
      continue;
    }

    if (
      isOneOf(normalizedLine, ["hook", "hook goi y", "tieu de goi y"]) ||
      normalizedLine === "hook goi y"
    ) {
      currentSection = "hook";
      skipSection = false;
      continue;
    }

    if (
      isOneOf(normalizedLine, [
        "bai viet de xuat",
        "noi dung bai viet",
        "goi y noi dung bai viet",
        "caption de xuat",
      ])
    ) {
      currentSection = "body";
      skipSection = false;
      continue;
    }

    if (isOneOf(normalizedLine, ["cta", "cta goi y", "cta de xuat"])) {
      currentSection = "cta";
      skipSection = false;
      continue;
    }

    if (isOneOf(normalizedLine, ["hashtag", "hashtags", "hashtag goi y", "hashtag de xuat"])) {
      currentSection = "hashtags";
      skipSection = false;
      continue;
    }

    if (isOneOf(normalizedLine, ["caption ngan du phong"])) {
      currentSection = "body";
      skipSection = true;
      continue;
    }

    if (isIntroLine(normalizedLine)) {
      continue;
    }

    if (skipSection) {
      continue;
    }

    pushLine(sections[currentSection], trimmedLine);
  }

  return {
    hook: collapseLines(sections.hook),
    body: collapseLines(sections.body),
    cta: collapseLines(sections.cta),
    hashtags: collapseLines(sections.hashtags).replace(/\n+/g, "\n").trim(),
  };
}

function appendUniqueBlocks(blocks) {
  const output = [];
  const seen = new Set();

  for (const block of blocks) {
    const cleaned = collapseLines(String(block || "").replace(/\r\n/g, "\n").split("\n"));
    if (!cleaned) {
      continue;
    }
    const normalized = normalizeText(cleaned);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(cleaned);
  }

  return output.join("\n\n").trim();
}

function buildPublishTextFromSections(sections) {
  return appendUniqueBlocks([sections?.hook, sections?.body, sections?.cta, sections?.hashtags]);
}

module.exports = {
  appendUniqueBlocks,
  buildPublishTextFromSections,
  extractContentSections,
  stripMarkdownFormatting,
};
