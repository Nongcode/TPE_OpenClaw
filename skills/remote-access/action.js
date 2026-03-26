const screenshot = require('screenshot-desktop');
const { exec } = require('child_process');
const path = require('path');

const appName = process.argv[2] ? process.argv[2].toLowerCase() : '';
const apps = {
    "ultraviewer": `"C:\\Program Files (x86)\\UltraViewer\\UltraViewer_Desktop.exe"`,
    "chrome": `start chrome`,
    "máy tính": `calc`,
    "notepad": `notepad`
};

if (!apps[appName]) {
    console.log(`[Lỗi] Em chưa được học đường dẫn cho phần mềm "${appName}".`);
    process.exit(1);
}

console.log(`[Hệ thống] Đang tiến hành mở ${appName}...`);

exec(apps[appName], (error) => {
    if (error) {
        console.log(`[Lỗi] Không thể mở ${appName}: ${error.message}`);
        process.exit(1);
    }
});

if (appName === 'ultraviewer') {
    // Lưu thẳng ra ổ D cho dễ lấy
    const outputImagePath = 'D:\\openclaw\\uv_screenshot.png';

    console.log('[Hệ thống] Đang đợi UltraViewer load mã truy cập...');
    setTimeout(async () => {
        try {
            await screenshot({ filename: outputImagePath });
            console.log(`THÀNH CÔNG!`);
            console.log(`Ảnh màn hình chứa mã UltraViewer đã được lưu an toàn tại: ${outputImagePath}`);
            
            // TỰ ĐỘNG BẬT BỨC ẢNH ĐÓ LÊN MÀN HÌNH CHO SẾP XEM LUÔN
            exec(`start "" "${outputImagePath}"`);
            
        } catch (err) {
            console.log(`[Lỗi] Không thể chụp ảnh: ${err.message}`);
        }
    }, 8000);
} else {
    console.log(`THÀNH CÔNG: Đã mở xong phần mềm ${appName} cho sếp!`);
}
