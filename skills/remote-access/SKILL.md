---
name: app-launcher
metadata:
  openclaw:
    skillKey: "app-launcher"
description: Trợ lý hệ thống. Tự động mở các phần mềm trên máy tính (Chrome, UltraViewer, Notepad...). Hỗ trợ chụp ảnh màn hình lấy mã truy cập từ xa.
---

# Kỹ năng Khởi động Phần mềm (App Launcher)

## Workflow

Khi người dùng yêu cầu mở một phần mềm bất kỳ (Ví dụ: "Mở cho anh chrome", "Mở ultraviewer lấy mã"...), hãy làm theo các bước sau:

### Bước 1: Trích xuất tên phần mềm và Thực thi
- Tìm từ khóa tên phần mềm mà người dùng muốn mở (ví dụ: `chrome`, `ultraviewer`, `notepad`, `postgre`).
- Sử dụng công cụ `exec` để chạy file Node.js, truyền tên phần mềm vào trong dấu ngoặc kép:
  `node D:/openclaw/skills/remote-access/action.js "[TÊN_PHẦN_MỀM]"`
  
  *Ví dụ:* `node D:/openclaw/skills/remote-access/action.js "chrome"`
  *Ví dụ:* `node D:/openclaw/skills/remote-access/action.js "ultraviewer"`

### Bước 2: Báo cáo và Hiển thị kết quả
- Đợi Terminal chạy xong và đọc kết quả.
- Nếu Terminal trả về một đoạn mã Markdown chứa link ảnh (thường xảy ra khi mở UltraViewer), **BẮT BUỘC** phải copy nguyên vẹn đoạn mã đó dán vào câu trả lời để hiển thị ảnh cho sếp.
- Nếu Terminal chỉ báo "THÀNH CÔNG", hãy trả lời sếp bằng một câu thân thiện: *"Em đã mở [Tên_Phần_Mềm] trên máy tính xong rồi sếp nhé!"*
- Nếu có lỗi "Chưa được học đường dẫn", hãy nhắc sếp vào file `action.js` để khai báo thêm phần mềm.
