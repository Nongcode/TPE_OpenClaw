const { Client } = require('pg');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// Cấu hình Database (Dùng lại tài khoản Read-Only hôm trước)
const client = new Client({
    user: 'openclaw_readonly',
    host: 'localhost',
    database: 'openclaw', // Nhớ đổi tên database thực tế của anh
    password: '123',     // Nhớ đổi mật khẩu thực tế
    port: 5432,
});

async function generateReport() {
    try {
        await client.connect();
        
        // 1. Câu lệnh SQL lấy dữ liệu (ĐÃ SỬA LẠI TÊN CỘT VÀ BẢNG)
        const sqlQuery = `
            SELECT 
                c.full_name AS customer_name,
                p.product_name AS product_name,
                p.price AS unit_price,
                o.quantity AS quantity,
                (p.price * o.quantity) AS total_amount
            FROM orders o
            JOIN customers c ON o.customer_id = c.id
            JOIN products p ON o.product_id = p.id
            WHERE EXTRACT(MONTH FROM o.order_date) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(YEAR FROM o.order_date) = EXTRACT(YEAR FROM CURRENT_DATE);
        `;
        
        const res = await client.query(sqlQuery);
        const data = res.rows;

        // 2. Khởi tạo file Excel
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Báo Cáo Doanh Thu');

        // Thiết lập Tiêu đề
        sheet.mergeCells('A1:E1');
        const titleCell = sheet.getCell('A1');
        titleCell.value = 'BÁO CÁO DOANH THU BÁN HÀNG';
        titleCell.font = { size: 16, bold: true };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };

        // Thiết lập Ngày tháng
        sheet.mergeCells('A2:E2');
        const dateCell = sheet.getCell('A2');
        const today = new Date();
        dateCell.value = `Ngày xuất báo cáo: ${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear()}`;
        dateCell.alignment = { horizontal: 'center' };
        
        sheet.addRow([]); // Dòng trống

        // 3. Đổ Header cho Bảng
        const headerRow = sheet.addRow(['Tên khách hàng', 'Tên sản phẩm', 'Đơn giá', 'Số lượng đã mua', 'Tiền thanh toán']);
        headerRow.font = { bold: true };
        headerRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };
            cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        });

        // 4. Đổ Dữ liệu và Tính Tổng
        let grandTotal = 0;
        data.forEach(row => {
            // Sử dụng các alias (AS) đã định nghĩa trong SQL
            const dataRow = sheet.addRow([row.customer_name, row.product_name, row.unit_price, row.quantity, row.total_amount]);
            dataRow.eachCell(cell => cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} });
            grandTotal += Number(row.total_amount);
        });

        // 5. Dòng Tổng Doanh Thu cuối cùng
        const totalRow = sheet.addRow(['', '', '', 'TỔNG DOANH THU:', grandTotal]);
        totalRow.font = { bold: true, color: { argb: 'FFFF0000' } }; // Chữ in đậm, màu đỏ

        // Căn chỉnh độ rộng cột cho đẹp
        sheet.columns = [
            { width: 25 }, { width: 30 }, { width: 15 }, { width: 18 }, { width: 20 }
        ];

        // 6. Lưu file ra ổ D (Nhớ đảm bảo thư mục D:/openclaw tồn tại)
        const filePath = path.join('D:', 'openclaw', `Bao_Cao_Doanh_Thu_Thang_${today.getMonth()+1}.xlsx`);
        await workbook.xlsx.writeFile(filePath);

        console.log(`THÀNH CÔNG: Đã xuất báo cáo thành công tại đường dẫn: ${filePath}`);

    } catch (err) {
        console.log("LỖI: " + err.message);
    } finally {
        await client.end();
    }
}

generateReport();
