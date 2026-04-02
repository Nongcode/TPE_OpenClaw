import { spawn } from 'node:child_process';

const payload = {
  image_prompt: 'Ảnh quảng cáo chân thực cho sản phẩm Máy rửa xe ô tô Tân Phát ETK, phong cách thương mại hiện đại, sạch sẽ, chuyên nghiệp, ánh sáng đẹp, làm nổi bật sản phẩm, bố cục cao cấp, nền bối cảnh studio hoặc garage sang trọng gọn gàng, tập trung vào sản phẩm, màu sắc hài hòa, cảm giác mạnh mẽ và đáng tin cậy.'
};

const child = spawn(process.execPath, ['D:/CodeAiTanPhat/TPE_OpenClaw/skills/gemini_generate_image_chat_reply/action.js', JSON.stringify(payload)], {
  cwd: 'D:/CodeAiTanPhat/TPE_OpenClaw',
  stdio: 'inherit'
});

child.on('exit', code => process.exit(code ?? 1));
