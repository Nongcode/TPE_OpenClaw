const axios = require('axios');
const PAGE_REGISTRY = require('./config');


const args = process.argv.slice(2);
const targetPages = args[0];
let message = args[1]; // [Đã sửa]: Đổi const thành let để có thể format lại chữ
const rawImageUrl = args[2] || "";

// [TỐI ƯU 1]: Ép Terminal dịch chữ \n thành dấu Enter (xuống dòng) thật
if (message) {
    message = message.replace(/\\n/g, '\n');
}

// [TỐI ƯU 2]: Lá chắn chặn lỗi API ảnh
const imageUrl = (rawImageUrl && rawImageUrl.startsWith('http')) ? rawImageUrl.trim() : null;

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
