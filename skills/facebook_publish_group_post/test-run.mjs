import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CAPTION = `Nếu anh em đang cần một mẫu tủ dụng cụ gọn gàng, có sẵn nhiều đồ nghề để vào việc luôn thì bản 7 ngăn, 136 chi tiết màu xanh lá cây này là mẫu khá đáng để tham khảo. Form tủ nhìn thực dụng, dễ bố trí trong khu làm việc, hợp cho xưởng muốn sắp đồ ngăn nắp hơn. 🛠️

Thông số theo dữ liệu thực tế:
- Tên sản phẩm: Tủ dụng cụ 7 ngăn, 136 chi tiết (màu xanh lá cây)
- Model: C-7DW136
- Thương hiệu: JONNESWAY
- Xuất xứ: Taiwan
- Hãng sản xuất: Jonnesway Enterprise Co., Ltd.
- Kích thước: 670 x 460 x 813 mm
- Số lượng chi tiết: 136
- Số lượng ngăn: 7

Điểm dễ thấy ở mẫu này là cấu hình khá rõ ràng: 7 ngăn để chia nhóm dụng cụ, còn bộ 136 chi tiết đi kèm giúp anh em đỡ mất thời gian gom lẻ từng món. Kích thước 670 x 460 x 813 mm cũng là mức vừa phải, đặt trong xưởng hoặc khu kỹ thuật nhìn vẫn gọn mà thao tác vẫn tiện.

Anh em có thể xem chi tiết sản phẩm tại đây:
https://uptek.vn/.../jonn-c-7dw136-tu-dung-cu-7-ngan-136...

Cần tham khảo kỹ hơn về mẫu tủ này thì nhắn ngay để được gửi thêm thông tin chi tiết. 🔧`;

const IMAGE = "C:/Users/Administrator/.openclaw/workspace_media/artifacts/images/flow-image-2k-2026-05-05T03-46-04-429Z.png";

const MODE = (process.argv[2] || "dry").toLowerCase();

const payload = {
  caption_long: CAPTION,
  media_paths: [IMAGE],
};

if (MODE === "dry") {
  payload.dry_run = true;
} else if (MODE === "one") {
  payload.group_ids = ["412910482507838"];
} else if (MODE === "all") {
  // không filter — đăng tất cả group enabled
} else {
  console.error(`Unknown mode "${MODE}". Use: dry | one | all`);
  process.exit(2);
}

const actionPath = path.join(__dirname, "action.js");
console.error(`[runner] Mode=${MODE}`);
console.error(`[runner] Spawning: node ${actionPath}`);

const child = spawn("node", [actionPath, JSON.stringify(payload)], {
  stdio: "inherit",
  cwd: path.resolve(__dirname, "..", ".."),
});
child.on("exit", (code) => process.exit(code ?? 0));
