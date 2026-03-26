---
name: auto-quote
metadata:
  openclaw:
    skillKey: "auto-quote"
description: Tự động tạo Báo giá Word và gửi Email. Tiết kiệm Token tuyệt đối.
---

# Kỹ năng Báo Giá Thần Tốc (Bản Tối Ưu Cuối Cùng)

## LUẬT CẤM BẮT BUỘC (Để tiết kiệm API Token):
1. **TUYỆT ĐỐI KHÔNG** sử dụng công cụ `read`, `edit`, `ls`, `find` trong bất kỳ tình huống nào.
2. Bạn đã được cung cấp sẵn mọi câu lệnh bên dưới, chỉ việc dùng `exec` để chạy, cấm tự ý tìm hiểu thêm.

## Workflow Thực Thi (Làm đúng thứ tự):

### Bước 1: Tạo file Báo Giá (1 lệnh exec duy nhất)
- Đóng gói dữ liệu thành: `TÊN_SẢN_PHẨM:SỐ_LƯỢNG, TÊN_SP:SỐ_LƯỢNG`.
- Chạy lệnh sau để tạo file Word:
  `node D:/openclaw/skills/auto-quote/quote.js "[TÊN_KHÁCH_HÀNG]" "[CHUỖI_SẢN_PHẨM]" "[CHIẾT_KHẤU]"`
- Đọc kết quả từ Terminal để lấy **ĐƯỜNG DẪN FILE WORD**.

### Bước 2: Báo cáo và Trả đường dẫn cho người dùng
- Khi tạo xong, **BẮT BUỘC phải in thẳng cái [ĐƯỜNG DẪN FILE WORD] ra màn hình chat** để sếp click vào xem hoặc copy.
  *(Ví dụ: "Em đã tạo xong báo giá. File được lưu tại: D:\openclaw\Bao_Gia_Pham_Long.docx")*

### Bước 3: Gửi Email (NẾU người dùng yêu cầu)
- **CẤM DÙNG LỆNH READ ĐỂ ĐỌC FILE EMAIL.** Bạn chỉ cần tự soạn [NỘI_DUNG] thật chuyên nghiệp, rồi chạy thẳng 1 lệnh `exec` duy nhất này:
  `node D:/openclaw/skills/auto-email/send.js "[EMAIL_NHẬN]" "[TIÊU_ĐỀ]" "[NỘI_DUNG_TỰ_SOẠN]" "[ĐƯỜNG_DẪN_FILE_Ở_BƯỚC_1]"`
