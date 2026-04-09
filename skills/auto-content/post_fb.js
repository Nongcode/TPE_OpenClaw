const fs = require("node:fs/promises");
const path = require("node:path");
const axios = require("axios");
const PAGE_REGISTRY = require("./config");


const args = process.argv.slice(2);
const targetPages = args[0] || "ALL";
let message = args[1]; // [Đã sửa]: Đổi const thành let để có thể format lại chữ
const rawImageUrl = args[2] || "";
const rawMediaInput = rawImageUrl;

// [TỐI ƯU 1]: Ép Terminal dịch chữ \n thành dấu Enter (xuống dòng) thật
if (message) {
    message = message.replace(/\\n/g, '\n');
}

// [TỐI ƯU 2]: Lá chắn chặn lỗi API ảnh
const imageUrl = (rawImageUrl && rawImageUrl.startsWith('http')) ? rawImageUrl.trim() : null;
const localMediaPath = rawMediaInput && !imageUrl ? path.resolve(rawMediaInput) : "";

function parsePages(value) {
    if (!value || value === "ALL") {
        return Object.keys(PAGE_REGISTRY);
    }
    return value.split(',').map(p => p.trim()).filter(Boolean);
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

async function postToFacebook() {
    if (!message) {
        console.log("LỖI: Không có nội dung để đăng."); return;
    }

    let pagesToPost = [];
    if (targetPages === "ALL") {
        pagesToPost = Object.keys(PAGE_REGISTRY);
    } else {
        pagesToPost = targetPages.split(',').map(p => p.trim());
    }

    for (const pageName of pagesToPost) {
        const page = PAGE_REGISTRY[pageName];
        if (!page) {
            console.log(`[BỎ QUA]: Không tìm thấy Fanpage "${pageName}" trong danh bạ.`);
            continue;
        }

        try {
            let url = `https://graph.facebook.com/v19.0/${page.id}/feed`;
            let payload = { message: message, access_token: page.token };

            if (imageUrl) {
                url = `https://graph.facebook.com/v19.0/${page.id}/photos`;
                payload.url = imageUrl; 
            }

            const response = await axios.post(url, payload);
            console.log(`-> THÀNH CÔNG! Đã đăng lên [${pageName}] ${imageUrl ? '(Kèm ảnh)' : '(Chỉ đăng chữ)'}. ID: ${response.data.id}`);
        } catch (error) {
            console.log(`-> [LỖI - ${pageName}]: ${error.response ? error.response.data.error.message : error.message}`);
        }
    }
}

postToFacebook();
