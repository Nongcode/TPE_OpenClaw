const { Client } = require('pg');

const sqlQuery = process.argv[2];

if (!sqlQuery) {
    console.log("LỖI: Không có câu lệnh SQL.");
    process.exit(1);
}

const client = new Client({
    user: 'openclaw_readonly', 
    host: 'localhost', 
    database: 'openclaw', 
    password: '123', 
    port: 5432,
});

async function run() {
    try {
        await client.connect();
        const res = await client.query(sqlQuery);
        // In kết quả ra dạng JSON để AI dễ đọc
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error("LỖI CƠ SỞ DỮ LIỆU: ", err.message);
        console.error("SQL Query was:", sqlQuery);
    } finally {
        await client.end();
    }
}

run();
