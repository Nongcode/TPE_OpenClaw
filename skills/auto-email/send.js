const nodemailer = require('nodemailer');
const fs = require('fs');

// Lấy tham số
const args = process.argv.slice(2);
const toEmail = args[0];
const subject = args[1];
const rawBody = args[2] || "";
const body = rawBody.replace(/\\n/g, '\n');
// Tham số thứ 4 bây giờ có thể chứa NHIỀU đường dẫn, cách nhau bằng dấu phẩy
const attachmentPathsString = args[3]; 

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'long109204@gmail.com',
        pass: 'mcxk kaxn fpdh vfff'
    }
});

const isBulkEmail = toEmail.includes(',');

const mailOptions = {
    from: 'long109204@gmail.com',
    to: isBulkEmail ? 'long109204@gmail.com' : toEmail, 
    bcc: isBulkEmail ? toEmail : '', 
    subject: subject,
    text: body
};

if (attachmentPathsString && attachmentPathsString.trim() !== "") {
    // 1. Tách chuỗi thành mảng các đường dẫn dựa vào dấu phẩy
    const pathsArray = attachmentPathsString.split(',');
    
    // 2. Khởi tạo mảng chứa file đính kèm
    mailOptions.attachments = [];

    // 3. Chạy vòng lặp kiểm tra từng đường dẫn một
    pathsArray.forEach(filePath => {
        const cleanPath = filePath.trim(); // Xóa khoảng trắng thừa ở 2 đầu
        
        if (cleanPath !== "") {
            if (fs.existsSync(cleanPath)) {
                // Nếu file tồn tại, nhét nó vào gói hàng
                mailOptions.attachments.push({ path: cleanPath });
                console.log(`[Hệ thống] Đã gom thành công file: ${cleanPath}`);
            } else {
                console.log(`[Cảnh báo] Không tìm thấy file: ${cleanPath}. Hệ thống sẽ bỏ qua file này.`);
            }
        }
    });

    // Nếu mảng rỗng (do lỗi đường dẫn hết), thì xóa thuộc tính attachments đi để tránh lỗi
    if (mailOptions.attachments.length === 0) {
        delete mailOptions.attachments;
        console.log(`[Cảnh báo] Toàn bộ file đính kèm đều bị lỗi đường dẫn. Email sẽ gửi chay.`);
    }
}


transporter.sendMail(mailOptions, function(error, info){
    if (error) {
        console.log("LỖI: " + error.message);
    } else {
        const soLuongFile = mailOptions.attachments ? mailOptions.attachments.length : 0;
        console.log(`THÀNH CÔNG: Email đã được gửi tới ${toEmail} ` + (soLuongFile > 0 ? `CÙNG VỚI ${soLuongFile} FILE ĐÍNH KÈM.` : "(Không có file đính kèm)."));
    }
});
