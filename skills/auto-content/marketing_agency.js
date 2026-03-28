const axios = require('axios');
const { execSync } = require('child_process');
const CONFIG_REGISTRY = require('./config');

const topic = process.argv.slice(2).join(" ");
const OPENAI_KEY = CONFIG_REGISTRY.openai.apiKey;

if (!topic) {
    console.log("🟢 [Quản lý AI]: Báo cáo sếp, hệ thống chưa nhận được chủ đề chiến dịch. Vui lòng cung cấp chủ đề để phòng ban triển khai ạ!");
    process.exit(1);
}

function safeJSONParse(str, defaultObj) {
    try {
        // Cắt bỏ các ký tự Markdown thừa nếu LLM lỡ tay bọc code (ví dụ: ```json ... ```)
        const cleanedStr = str.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleanedStr);
    } catch (e) {
        console.log(`⚠️ [Hệ thống]: Lỗi phân tích định dạng phản hồi từ AI. Áp dụng luồng dự phòng.`);
        return defaultObj; // Trả về phương án an toàn nhất nếu lỗi
    }
}

// ==========================================
// VŨ KHÍ CỐT LÕI: Hàm gọi LLM có khiên chống lỗi
// ==========================================
async function askLLM(rolePrompt, taskPrompt, isJson = false) {
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: "gpt-4o-mini",
                response_format: isJson ? { type: "json_object" } : { type: "text" },
                messages: [
                    { role: "system", content: rolePrompt },
                    { role: "user", content: taskPrompt }
                ]
            },
            { 
                headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
                timeout: 30000 // Giới hạn 30 giây, quá thời gian tự ngắt để không treo hệ thống
            }
        );
        return response.data.choices[0].message.content;
    } catch (error) {
        console.log(`⚠️ [LỖI API LLM]: Hệ thống não bộ đang gặp trục trặc - ${error.message}`);
        return null;
    }
}

// ==========================================
// KỊCH BẢN VẬN HÀNH 4 TẦNG (CHUYÊN NGHIỆP & CHẶT CHẼ)
// ==========================================
async function runAgency() {
    console.log(`\n🟢 [Quản lý AI]: Đã tiếp nhận chỉ thị chiến dịch: "${topic}". Đang khởi động tiến trình làm việc của phòng Marketing...\n`);

    let contentDraft = "";
    let isApprovedByDeputy = false;
    let loopCount = 0;
    const MAX_RETRIES = 3;

    // ---------------------------------------------------------
    // TẦNG 3 & 4: Phó phòng điều phối Nhân viên Content
    // ---------------------------------------------------------
    while (!isApprovedByDeputy && loopCount < MAX_RETRIES) {
        loopCount++;
        console.log(`✍️ [Chuyên viên Content] (Bản thảo ${loopCount}): Đang nghiên cứu và triển khai nội dung...`);
        
        const contentRole = "Đóng vai một Chuyên viên Copywriter B2B chuyên nghiệp. Viết bài Facebook bán hàng thiết bị ô tô, tập trung vào giải quyết bài toán của khách hàng. KHÔNG sử dụng dấu ngoặc kép. Luôn có phần thông tin liên hệ Công ty Thiết bị Tân Phát ETEK ở cuối.";
        contentDraft = await askLLM(contentRole, `Yêu cầu viết bài bán: ${topic}. Nếu đây là lần sửa lại, hãy chú ý cải thiện văn phong cho thuyết phục hơn.`);
        
        if (!contentDraft) {
            console.log(`❌ [Hệ thống]: Chuyên viên Content không thể hoàn thành bài viết do lỗi kết nối. Dừng chiến dịch!`);
            return;
        }

        console.log(`\n--- TRÍCH ĐOẠN BẢN NHÁP ---\n${contentDraft.substring(0, 150)}...\n---------------------------\n`);
        console.log(`👨‍💼 [Phó phòng AI]: Đang kiểm duyệt chất lượng nội dung sơ bộ...`);

        const deputyRole = "Đóng vai Phó phòng Marketing. Đánh giá nội dung bài viết. Yêu cầu: Không hô khẩu hiệu, phải thiết thực và có sức hút. Trả lời định dạng JSON BẮT BUỘC: {\"status\": \"PASS\" hoặc \"FAIL\", \"feedback\": \"Lý do ngắn gọn\"}";
        const deputyReviewStr = await askLLM(deputyRole, `Vui lòng duyệt bản thảo này:\n${contentDraft}`, true);
        
        // Dùng khiên chống lỗi JSON. Nếu lỗi định dạng, tự động cho PASS để tránh kẹt vòng lặp
        const deputyReview = safeJSONParse(deputyReviewStr, { status: "PASS", feedback: "Hệ thống tự động duyệt do lỗi định dạng báo cáo." });

        if (deputyReview.status === "PASS") {
            console.log(`👨‍💼 [Phó phòng AI]: ✅ Đã duyệt! Nội dung đạt chuẩn. Chuyển tiếp cho bộ phận Media thiết kế hình ảnh.\n`);
            isApprovedByDeputy = true;
        } else {
            console.log(`👨‍💼 [Phó phòng AI]: ⚠️ Yêu cầu Content điều chỉnh lại! Phản hồi: ${deputyReview.feedback}\n`);
        }
    }

    if (!isApprovedByDeputy) {
        console.log(`👨‍💼 [Phó phòng AI]: ❌ Báo cáo Trưởng phòng, bộ phận Content đã thử ${MAX_RETRIES} lần nhưng vẫn chưa đạt yêu cầu. Tạm dừng triển khai.\n`);
        return;
    }

    // ---------------------------------------------------------
    // TẦNG 4: Nhân viên Media xuất kích (Có Fallback an toàn)
    // ---------------------------------------------------------
    console.log(`🎨 [Chuyên viên Media]: Đã nhận nội dung. Đang tiến hành tạo hình ảnh trực quan...`);
    let imageUrl = ""; // Mặc định là rỗng (đăng text) nếu lỗi
    try {
        const mediaPrompt = await askLLM("Đóng vai Chuyên viên Thiết kế.", `Đọc nội dung và tóm tắt thành 1 câu tiếng Việt mô tả bối cảnh hình ảnh cần vẽ: ${contentDraft}`);
        
        if (mediaPrompt) {
            // Chạy lệnh đồng bộ và bắt lỗi qua luồng stderr
            const imageLog = execSync(`node D:/openclaw/skills/auto-content/generate_image.js "${topic}" "${mediaPrompt}"`, { encoding: 'utf-8', stdio: 'pipe' });
            const match = imageLog.match(/JSON_LOCAL_IMAGE_PATH:\s*(.+)/);
            if (match) imageUrl = match[1].trim();
            console.log(`🎨 [Chuyên viên Media]: Hoàn tất thiết kế! File lưu tại: (${imageUrl})\n`);
        }
    } catch (err) {
        console.log(`🎨 [Chuyên viên Media]: ⚠️ Trục trặc hệ thống thiết kế (API lỗi/hết tiền). Sẽ đề xuất xuất bản định dạng văn bản (Text-only) ạ.\n`);
    }

    // ---------------------------------------------------------
    // TẦNG 2: Trưởng phòng chốt hạ (Có kiểm tra quyền hạn Fanpage)
    // ---------------------------------------------------------
    console.log(`🦅 [Trưởng phòng AI]: Đang tiến hành xét duyệt tổng thể toàn bộ chiến dịch...`);
    const headRole = `Đóng vai Giám đốc Marketing. Xem xét bài viết. Nhiệm vụ:
    1. Chỉ định Fanpage (Bắt buộc chọn 1 trong các page: "TPE", "ALL").
    2. Quyết định ĐĂNG bài hay HỦY.
    Trả lời định dạng JSON: {"decision": "POST" hoặc "REJECT", "page": "Tên_Page", "reason": "Lý do ngắn gọn"}`;
    
    const headReviewStr = await askLLM(headRole, `Nội dung:\n${contentDraft}`, true);
    
    // Nếu lỗi JSON, Trưởng phòng mặc định Hủy để đảm bảo an toàn
    const headReview = safeJSONParse(headReviewStr, { decision: "REJECT", page: "NONE", reason: "Lỗi đánh giá hệ thống, tự động hủy để đảm bảo an toàn." });

    if (headReview.decision === "POST") {
        // Kiểm tra xem Trưởng phòng có chọn Page ảo không, nếu ảo thì ép về TPE
        let targetPage = headReview.page;
        if (targetPage !== "ALL" && !CONFIG_REGISTRY.pages[targetPage]) {
            console.log(`🦅 [Trưởng phòng AI]: ⚠️ Trưởng phòng chỉ định nhầm Page không có trong danh bạ. Tự động điều hướng về Fanpage mặc định [TPE].`);
            targetPage = "TPE";
        }

        console.log(`🦅 [Trưởng phòng AI]: ✅ PHÊ DUYỆT CHIẾN DỊCH! Ủy quyền xuất bản lên Fanpage: [${targetPage}]. Yêu cầu hệ thống đăng tải ngay!\n`);
        
        // ---------------------------------------------------------
        // TẦNG 1: Quản lý kích hoạt đăng bài
        // ---------------------------------------------------------
        console.log(`🟢 [Quản lý AI]: Đã nhận lệnh phê duyệt. Tiến hành kết nối API Facebook...`);
        try {
            const postLog = execSync(`node D:/openclaw/skills/auto-content/post_fb.js "${targetPage}" "${contentDraft}" "${imageUrl}"`, { encoding: 'utf-8', stdio: 'pipe' });
            console.log(`\n🎉 [Quản lý AI]: BÁO CÁO SẾP! CHIẾN DỊCH ĐÃ HOÀN TẤT THÀNH CÔNG!`);
            console.log(`Nhật ký xuất bản:\n${postLog}`);
        } catch (e) {
            console.log(`🟢 [Quản lý AI]: ❌ Báo cáo sếp, khâu xuất bản cuối cùng gặp gián đoạn: ${e.message}`);
            // Log chi tiết lỗi từ file post_fb.js nếu có
            if (e.stdout) console.log(e.stdout);
        }

    } else {
        console.log(`🦅 [Trưởng phòng AI]: ❌ TỪ CHỐI XUẤT BẢN! Lý do: ${headReview.reason}`);
        console.log(`🟢 [Quản lý AI]: Dạ thưa sếp, chiến dịch đã bị đình chỉ ở vòng kiểm duyệt cuối. Chúng em sẽ rà soát lại quy trình ạ.`);
    }
}

runAgency();
