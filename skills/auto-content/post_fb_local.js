const fs = require("node:fs/promises");
const path = require("node:path");
const axios = require("axios");
const PAGE_REGISTRY = require("./config");

const args = process.argv.slice(2);
const targetPages = args[0] || "ALL";
let message = args[1] || "";
const rawMediaInput = args[2] || "";

if (message) {
  message = message.replace(/\\n/g, "\n");
}

function parsePages(value) {
  if (!value || value === "ALL") {
    return Object.keys(PAGE_REGISTRY);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function detectLocalMediaKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp4", ".mov", ".avi", ".webm", ".mkv"].includes(ext)) {
    return "video";
  }
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
    return "image";
  }
  return "";
}

async function postText(page, text) {
  const url = `https://graph.facebook.com/v19.0/${page.id}/feed`;
  const payload = { message: text, access_token: page.token };
  const response = await axios.post(url, payload);
  return response.data.id;
}

async function postRemoteImage(page, text, mediaUrl) {
  const url = `https://graph.facebook.com/v19.0/${page.id}/photos`;
  const payload = { message: text, url: mediaUrl, access_token: page.token };
  const response = await axios.post(url, payload);
  return response.data.id || response.data.post_id;
}

async function postLocalMedia(page, text, mediaPath, mediaKind) {
  const endpoint = mediaKind === "video" ? "videos" : "photos";
  const apiUrl = `https://graph.facebook.com/v20.0/${page.id}/${endpoint}`;
  const fileBuffer = await fs.readFile(mediaPath);
  const formData = new FormData();
  formData.append("access_token", page.token);
  if (mediaKind === "video") {
    formData.append("description", text);
    formData.append("source", new Blob([fileBuffer], { type: "video/mp4" }), path.basename(mediaPath));
  } else {
    formData.append("message", text);
    formData.append("source", new Blob([fileBuffer], { type: "image/jpeg" }), path.basename(mediaPath));
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    body: formData,
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(result.error ? result.error.message : JSON.stringify(result));
  }
  return result.id || result.post_id || result.video_id;
}

async function main() {
  if (!message) {
    console.log("ERROR: Khong co noi dung de dang.");
    process.exitCode = 1;
    return;
  }

  const pagesToPost = parsePages(targetPages);
  const remoteMediaUrl = isRemoteUrl(rawMediaInput) ? rawMediaInput.trim() : "";
  const localMediaPath = rawMediaInput && !remoteMediaUrl ? path.resolve(rawMediaInput) : "";
  const localMediaKind = localMediaPath ? detectLocalMediaKind(localMediaPath) : "";

  if (localMediaPath && !localMediaKind) {
    console.log(`ERROR: Khong ho tro dinh dang file media ${localMediaPath}`);
    process.exitCode = 1;
    return;
  }

  for (const pageName of pagesToPost) {
    const page = PAGE_REGISTRY[pageName];
    if (!page) {
      console.log(`-> SKIP [${pageName}]: Khong tim thay fanpage trong config.`);
      continue;
    }

    try {
      let postId = null;
      let mode = "text";

      if (remoteMediaUrl) {
        postId = await postRemoteImage(page, message, remoteMediaUrl);
        mode = "remote-image";
      } else if (localMediaPath) {
        postId = await postLocalMedia(page, message, localMediaPath, localMediaKind);
        mode = localMediaKind;
      } else {
        postId = await postText(page, message);
      }

      console.log(`-> SUCCESS [${pageName}] (${mode}). ID: ${postId}`);
    } catch (error) {
      const details = error.response?.data?.error?.message || error.message;
      console.log(`-> ERROR [${pageName}]: ${details}`);
      process.exitCode = 1;
    }
  }
}

main();
