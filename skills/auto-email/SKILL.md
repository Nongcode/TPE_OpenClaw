---
name: auto-email
metadata:
  openclaw:
    skillKey: "auto-email"
description: Tự động soạn email, gửi ngầm, hỗ trợ đính kèm file, BCC hàng loạt và chạy chiến dịch Cold Email Marketing cá nhân hóa.
---

# Kỹ năng Soạn và Gửi Email Tự Động 

## Workflow 1: Gửi Email Thông Thường & BCC Hàng Loạt

### Bước 1: Phân tích và Phóng tác Nội dung (CỰC KỲ QUAN TRỌNG)
- Khi người dùng đưa ra một ý tưởng ngắn gọn (Ví dụ: "Mời Long đi cafe cuối tuần", "Gửi báo cáo doanh thu", "Gửi lời cảm ơn"), bạn KHÔNG ĐƯỢC soạn email cộc lốc. 
- Hãy đóng vai trò là một Trợ lý Ngoại giao chuyên nghiệp, tự động "phóng tác" và mở rộng nội dung thành một email hoàn chỉnh, gần gũi và trân trọng theo cấu trúc sau:
  1. **Lời chào:** Lịch sự, thân thiện (Kính gửi, Chào thân ái...).
  2. **Hỏi thăm/Dẫn dắt:** Tự động thêm những câu hỏi thăm sức khỏe, công việc hoặc tình hình dạo này một cách chân thành, tự nhiên.
  3. **Nội dung chính:** Truyền đạt ý chính của người dùng (mời cafe, gửi file báo cáo...) một cách khéo léo, rõ ràng.
  4. **Lời kết:** Chúc sức khỏe, chúc cuối tuần/ngày làm việc vui vẻ, mong nhận được phản hồi.
- Nếu người dùng yêu cầu gửi file đính kèm, hãy tự động lấy đường dẫn tuyệt đối của file đó từ lịch sử chat và nhắc khéo về file trong nội dung email.
- **BẮT BUỘC:** Luôn trình bày bản nháp (Tiêu đề + Nội dung) ra khung chat để xin phép người dùng trước khi gửi.

### Bước 2: Thực thi lệnh gửi (Hỗ trợ Gửi hàng loạt & File đính kèm)
- Khi người dùng duyệt bản nháp và nói "Gửi đi", sử dụng công cụ `exec` để chạy file Node.js.
- **CỰC KỲ QUAN TRỌNG KHI GỬI CHO NHIỀU NGƯỜI CÙNG NỘI DUNG:** Bạn **TUYỆT ĐỐI KHÔNG** được gọi lệnh gửi lặp đi lặp lại nhiều lần. Hãy gom tất cả các địa chỉ email lại, cách nhau bằng dấu phẩy (Ví dụ: `khach1@gmail.com, khach2@gmail.com`) và truyền vào tham số `[EMAIL_NHẬN]` để hệ thống tự động BCC đồng loạt 1 lần duy nhất.
- **Cú pháp Lệnh:**
  `node D:/openclaw/skills/auto-email/send.js "[EMAIL_NHẬN]" "[TIÊU_ĐỀ]" "[NỘI_DUNG]" "[ĐƯỜNG_DẪN_FILE_NẾU_CÓ]"`

- *VÍ DỤ GỬI 1 NGƯỜI (CÓ ĐÍNH KÈM):* `node D:/openclaw/skills/auto-email/send.js "sep@gmail.com" "Báo cáo Doanh thu" "Gửi sếp file báo cáo ạ" "D:\openclaw\Bao_Cao.xlsx"`
- *VÍ DỤ GỬI HÀNG LOẠT (BCC):* `node D:/openclaw/skills/auto-email/send.js "khach1@gmail.com, khach2@gmail.com" "Cảm ơn quý khách" "Cửa hàng xin cảm ơn..." ""`

### Bước 3: Báo cáo
- Đọc kết quả từ Terminal. Trả lời ngắn gọn xem email đã được gửi thành công chưa.

---

## Workflow 2: Chiến dịch Cold Email Marketing (Cá Nhân Hóa Từ Excel)
- Kích hoạt khi người dùng cung cấp đường dẫn một file Excel và yêu cầu gửi email Marketing chào hàng/chăm sóc.

### Bước 1: Đọc Data khách hàng
- Sử dụng công cụ `exec` để chạy lệnh đọc file Excel:
  `node D:/openclaw/skills/auto-email/read_excel.js "[ĐƯỜNG_DẪN_FILE_EXCEL]"`
- Đọc dữ liệu JSON trả về để lấy thông tin (Tên, Email, Tên Công ty, Ngành nghề...).

### Bước 2: Viết Nháp Email Cá Nhân Hóa (DUYỆT MẪU ĐẠI DIỆN)
- ĐỪNG trình bày toàn bộ 100 email nháp ra khung chat, người dùng sẽ bị choáng ngợp.
- Hãy chọn ra **2-3 khách hàng tiêu biểu nhất** (khác nhau về ngành nghề/vị trí) từ danh sách Excel.
- Soạn email hoàn chỉnh, cá nhân hóa cho 2-3 người đó và trình bày ra khung chat làm mẫu.
- Hỏi người dùng: *"Em đã soạn xong kịch bản cá nhân hóa cho toàn bộ danh sách. Dưới đây là 3 mẫu đại diện gửi cho anh A, chị B, anh C để sếp duyệt văn phong. Sếp xem ổn chưa để em tự động 'xào' lại kịch bản này cho [SỐ_LƯỢNG] người còn lại và tiến hành gửi hàng loạt luôn nhé?"*

### Bước 3: Gửi Riêng Lẻ (Vòng Lặp)
- Khi người dùng chốt "Gửi đi", bạn BẮT BUỘC phải gọi lệnh `exec` **NHIỀU LẦN**, mỗi lần cho một khách hàng riêng biệt để đảm bảo email gửi đích danh.
  `node D:/openclaw/skills/auto-email/send.js "[EMAIL_KHÁCH_1]" "[TIÊU_ĐỀ_1]" "[NỘI_DUNG_CỦA_KHÁCH_1]" ""`
  `node D:/openclaw/skills/auto-email/send.js "[EMAIL_KHÁCH_2]" "[TIÊU_ĐỀ_2]" "[NỘI_DUNG_CỦA_KHÁCH_2]" ""`
- Báo cáo hoàn tất sau khi gửi xong toàn bộ danh sách.
