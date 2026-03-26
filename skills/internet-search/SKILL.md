---
name: internet-search
metadata:
  openclaw:
    skillKey: "internet-search"
description: Công cụ tự động truy cập Internet để lấy dữ liệu thời gian thực (giá vàng, tỷ giá, tin tức) từ các trang web cụ thể.
---

# Kỹ năng Truy Cập Web Tự Động

## Workflow (Quy trình làm việc)

Khi người dùng yêu cầu tra cứu thông tin (như giá vàng), bạn phải làm theo các bước sau:

### Bước 1: Xác định nguồn dữ liệu
- Để lấy giá vàng của NHIỀU CỬA HÀNG (SJC, DOJI, PNJ, Bảo Tín Minh Châu...), chúng ta sẽ quét trang báo 24h thông qua dịch vụ Jina Reader để lấy văn bản sạch.
- URL sử dụng là: `https://r.jina.ai/https://www.24h.com.vn/gia-vang-hom-nay-c425.html`

### Bước 2: Chạy lệnh lấy dữ liệu (Thực thi ngầm)
Sử dụng công cụ `exec` để chạy lệnh Terminal sau bằng Node.js:

`node -e "fetch('https://r.jina.ai/https://www.24h.com.vn/gia-vang-hom-nay-c425.html').then(res => res.text()).then(text => console.log(text.substring(0, 4000))).catch(err => console.log('Lỗi:', err.message))"`

### Bước 3: Đọc hiểu, Phân tích và So sánh
1. Đọc nội dung Markdown được Terminal trả về.
2. Tìm kiếm Bảng giá vàng trong văn bản (chú ý đến các từ khóa như SJC, DOJI, PNJ, Mua vào, Bán ra).
3. Rút trích các con số giá vàng mới nhất của từng hãng.
4. Trình bày cho người dùng một bảng so sánh giá mua/bán giữa các thương hiệu một cách rõ ràng, trực quan bằng tiếng Việt.
