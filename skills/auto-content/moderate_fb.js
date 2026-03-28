const axios = require('axios');
const args = process.argv.slice(2);
const PAGE_REGISTRY = require('./config');

const action = args[0]; // Lệnh: "get_posts", "get_comments", hoặc "delete_comment"

async function moderateFB() {
    if (!action) return console.log("LỖI: AI chưa truyền lệnh (action).");

    // 1. LỆNH LẤY BÀI VIẾT
    if (action === "get_posts") {
        const targetPages = args[1] || "ALL";
        let pagesToScan = targetPages === "ALL" ? Object.keys(PAGE_REGISTRY) : targetPages.split(',');
        let allPosts = [];

        for (const p of pagesToScan) {
            const pageName = p.trim();
            const page = PAGE_REGISTRY[pageName];
            if (!page) continue;
            try {
                const url = `https://graph.facebook.com/v19.0/${page.id}/posts?limit=5&access_token=${page.token}`;
                const res = await axios.get(url);
                const posts = res.data.data.map(post => ({
                    page_name: pageName,
                    id: post.id,
                    message: post.message ? post.message.substring(0, 30) + "..." : "[Bài viết có Ảnh/Video]"
                }));
                allPosts = allPosts.concat(posts);
            } catch (error) {
                console.log(`[LỖI LẤY BÀI - ${pageName}]: ${error.message}`);
            }
        }
        console.log(JSON.stringify(allPosts, null, 2));
    } 
    
    // 2. LỆNH LẤY BÌNH LUẬN
    else if (action === "get_comments") {
        const pageName = args[1];
        const postId = args[2];
        const page = PAGE_REGISTRY[pageName];
        if (!page || !postId) return console.log("LỖI: Thiếu Tên Page hoặc ID bài viết.");
        try {
            const url = `https://graph.facebook.com/v19.0/${postId}/comments?access_token=${page.token}`;
            const res = await axios.get(url);
            if (res.data.data.length === 0) console.log(`[${pageName}] Bài ${postId} chưa có bình luận.`);
            else console.log(JSON.stringify(res.data.data, null, 2));
        } catch (error) {
            console.log(`[LỖI LẤY BÌNH LUẬN - ${pageName}]: ${error.message}`);
        }
    } 
    
    // 3. LỆNH XÓA BÌNH LUẬN
    else if (action === "delete_comment") {
        const pageName = args[1];
        const commentId = args[2];
        const page = PAGE_REGISTRY[pageName];
        if (!page || !commentId) return console.log("LỖI: Thiếu Tên Page hoặc ID bình luận.");
        try {
            const url = `https://graph.facebook.com/v19.0/${commentId}?access_token=${page.token}`;
            await axios.delete(url);
            console.log(`THÀNH CÔNG! Đã "trảm" bình luận ID: ${commentId} trên page [${pageName}]`);
        } catch (error) {
            console.log(`[LỖI XÓA BÌNH LUẬN - ${pageName}]: ${error.message}`);
        }
    } 
    
    else {
        console.log("LỖI: Lệnh không hợp lệ.");
    }
}

moderateFB();
