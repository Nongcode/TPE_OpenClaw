const { Client } = require('pg');
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const khachHang = args[0] || "Khách hàng VIP";
// Định dạng đầu vào: "Máy nén:3, Máy hút:2"
const stringSanPham = args[1] || ""; 
const chietKhau = parseInt(args[2]) || 0; 

const formatTien = (soTien) => Number(soTien).toLocaleString('vi-VN') + " VNĐ";

async function generateQuote() {
    const client = new Client({
        user: 'openclaw_readonly', host: 'localhost', database: 'openclaw', password: '123', port: 5432
    });

    try {
        await client.connect();
        let danhSachItems = [];
        let tongTienHang = 0;
        let stt = 1;

        const mangSP = stringSanPham.split(',');
        for (const sp of mangSP) {
            const parts = sp.split(':');
            if (parts.length >= 2) {
                const soLuong = parseInt(parts.pop().trim()) || 1;
                const tuKhoaTenSP = parts.join(':').trim();

                // Node.js tự động tìm kiếm mờ an toàn, không lo lỗi font
                const query = `SELECT id, product_name, price FROM products WHERE product_name ILIKE $1 LIMIT 1`;
                const res = await client.query(query, [`%${tuKhoaTenSP}%`]);

                if (res.rows.length > 0) {
                    const dbSp = res.rows[0];
                    const donGia = Number(dbSp.price);
                    const thanhTien = donGia * soLuong;
                    tongTienHang += thanhTien;

                    danhSachItems.push({
                        stt: stt++, maSP: dbSp.id, tenSP: dbSp.product_name, soLuong: soLuong, donGia: formatTien(donGia), thanhTien: formatTien(thanhTien)
                    });
                }
            }
        }

        if (danhSachItems.length === 0) {
            console.log("[Lỗi] Không tìm thấy sản phẩm nào trong DB."); return;
        }

        const tienChietKhau = tongTienHang * (chietKhau / 100);
        const tienVAT = (tongTienHang - tienChietKhau) * 0.1;
        const tongThanhToan = (tongTienHang - tienChietKhau) + tienVAT;

        const templatePath = path.join(__dirname, "bao_gia_template.docx");
        const safeName = khachHang.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");
        const outputPath = path.join("D:", "openclaw", `Bao_Gia_${safeName}.docx`);

        const content = fs.readFileSync(templatePath, "binary");
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

        const today = new Date();
        doc.render({
            ngayTao: `${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear()}`, khachHang: khachHang, chietKhauPhanTram: chietKhau,
            items: danhSachItems, tongTienHang: formatTien(tongTienHang), tienChietKhau: formatTien(tienChietKhau), tienVAT: formatTien(tienVAT), tongThanhToan: formatTien(tongThanhToan)
        });

        const buf = doc.getZip().generate({ type: "nodebuffer" });
        fs.writeFileSync(outputPath, buf);
        console.log(`THÀNH CÔNG! Đường dẫn: ${outputPath}`);

    } catch (error) {
        console.log(`[Lỗi] ${error.message}`);
    } finally {
        await client.end();
    }
}
generateQuote();
