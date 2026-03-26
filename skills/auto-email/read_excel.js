const ExcelJS = require('exceljs');

const filePath = process.argv[2];

async function readExcel() {
    if (!filePath) {
        console.log("LỖI: Sếp chưa truyền đường dẫn file Excel.");
        return;
    }

    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const worksheet = workbook.worksheets[0]; // Đọc Sheet đầu tiên

        let data = [];
        let headers = [];

        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) {
                // Lấy dòng 1 làm Tiêu đề cột
                headers = row.values.slice(1); 
            } else {
                let rowData = {};
                row.eachCell((cell, colNumber) => {
                    rowData[headers[colNumber - 1]] = cell.value;
                });
                data.push(rowData);
            }
        });

        // In ra màn hình dạng JSON cho não AI tự phân tích
        console.log(JSON.stringify(data, null, 2));
    } catch (error) {
        console.log("LỖI ĐỌC FILE EXCEL: " + error.message);
    }
}

readExcel();
