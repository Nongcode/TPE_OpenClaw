---
name: excel-report
metadata:
  openclaw:
    skillKey: "excel-report"
description: Tự động tổng hợp dữ liệu từ Database và xuất file Báo cáo Doanh thu định dạng Excel (.xlsx).
---

# Kỹ năng Xuất Báo Cáo Excel

## Workflow

Khi người dùng yêu cầu "Lập báo cáo doanh thu" hoặc "Xuất file excel doanh thu", bạn đóng vai trò là một trợ lý Kế toán và làm theo các bước sau:

### Bước 1: Chạy lệnh xuất file
Sử dụng công cụ `exec` để chạy lệnh Terminal sau bằng Node.js:
`node D:/openclaw/skills/excel-report/report.js`

### Bước 2: Báo cáo kết quả cho sếp
- Đọc kết quả in ra từ Terminal.
- Nếu thành công, hãy báo cho sếp biết file báo cáo Excel đã được tạo thành công và chỉ rõ đường dẫn file (ví dụ: `D:\openclaw\Bao_Cao_Doanh_Thu...`) để sếp mở lên xem.
- Hỏi xem sếp có muốn gửi file này qua email cho ai không (Gợi ý sử dụng kỹ năng `auto-email` nếu cần).
