const axios = require('axios');
const PAGE_REGISTRY = require('./config');

const args = process.argv.slice(2);
const pageName = args[0];
const postId = args[1];


async function getMetrics() {
    if (!pageName || !postId) {
        console.log("LỖI: AI chưa truyền Tên Page hoặc ID bài viết.");
        return;
    }

    const page = PAGE_REGISTRY[pageName];
    if (!page) {
        console.log(`[LỖI]: Không tìm thấy Fanpage "${pageName}" trong danh bạ.`);
        return;
    }

    try {
        // Lấy tổng số Like và Comment bằng Token của đúng Page đó
        const url = `https://graph.facebook.com/v19.0/${postId}?fields=likes.summary(true),comments.summary(true)&access_token=${page.token}`;
        const response = await axios.get(url);
        
        const data = {
            page: pageName,
            id: response.data.id,
            total_likes: response.data.likes ? response.data.likes.summary.total_count : 0,
            total_comments: response.data.comments ? response.data.comments.summary.total_count : 0
        };

        // Trả ra JSON cho AI tự "nuốt" và đánh giá
        console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        console.log(`[LỖI ĐO LƯỜNG - ${pageName}]: ${error.response ? error.response.data.error.message : error.message}`);
    }
}

getMetrics();
