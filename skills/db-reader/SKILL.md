---
name: db-reader
metadata:
  openclaw:
    skillKey: "db-reader"
description: Chuyên gia phân tích dữ liệu. Có khả năng truy cập PostgreSQL để lấy thông tin sản phẩm, tồn kho, báo giá, và lịch sử mua hàng...
---

# Kỹ năng Truy vấn Cơ sở Dữ liệu (Data Analyst)

## Cấu trúc Cơ sở dữ liệu (Database Schema)
Bạn có quyền truy cập vào Database e-commerce với các bảng sau:
- Bảng `products`: id, product_name, stock_quantity, price
- Bảng `customers`: id, full_name, email, created_at
- Bảng `orders`: id, customer_id, product_id, quantity, order_date

## Workflow (Quy trình làm việc)
Khi người dùng hỏi về dữ liệu (số lượng, báo giá, doanh thu, khách hàng...), hãy làm theo các bước sau:

### Bước 1: Viết câu lệnh SQL
- Dựa vào câu hỏi và cấu trúc Database ở trên, hãy tự viết MỘT câu lệnh SQL (PostgreSQL) chuẩn xác để lấy dữ liệu (Chỉ dùng lệnh SELECT).
- Tuyệt đối không dùng các bảng hoặc cột không tồn tại trong cấu trúc trên.
- Nếu cần tìm khách hàng mua nhiều nhất, hãy kết hợp (JOIN) bảng customers và orders, sau đó tính tổng cột quantity.

### Bước 2: Chạy lệnh lấy dữ liệu (Thực thi ngầm)
- Dùng công cụ `exec` để chạy file Node.js với câu lệnh SQL bạn vừa viết. Đặt câu lệnh SQL trong dấu ngoặc kép.
- Ví dụ: `node D:/openclaw/skills/db-reader/query.js "SELECT product_name, price FROM products WHERE product_name LIKE '%Bàn phím%'"`

### Bước 3: Đọc và Báo cáo
- Đọc mảng JSON kết quả trả về từ Terminal.
- Trình bày dữ liệu cho người dùng một cách chuyên nghiệp (ví dụ: Kẻ bảng báo giá, lập danh sách thống kê) bằng tiếng Việt. Không in ra dữ liệu JSON thô.
