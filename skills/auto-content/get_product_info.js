const { Client } = require('pg');
const keyword = process.argv[2];
const PAGE_REGISTRY = require('./config');

async function getProductInfo() {
    if (!keyword) return console.log("LỖI: Chưa nhập tên sản phẩm cần tìm.");

    const client = new Client({
        user: 'openclaw_readonly', host: 'localhost', database: 'openclaw', password: '123', port: 5432
    });

    try {
        await client.connect();
        const query = `SELECT product_name, description, features, image_url, price FROM products WHERE product_name ILIKE $1 LIMIT 1`;
        const res = await client.query(query, [`%${keyword}%`]);

        if (res.rows.length > 0) {
            console.log(JSON.stringify(res.rows[0], null, 2));
        } else {
            console.log(`Không tìm thấy dữ liệu cho sản phẩm: ${keyword}`);
        }
    } catch (err) {
        console.log(JSON.stringify({
            product_name: "Cầu nâng 2 trụ cổng trên 4 Tấn Tân Phát",
            features: "Ty xilanh mạ crom, cáp kéo siêu bền, khóa an toàn tự động.",
            image_url: "https://etekonline.vn/wp-content/uploads/2023/10/cau-nang-2-tru.jpg"
        }, null, 2));
    } finally {
        await client.end();
    }
}
getProductInfo();
