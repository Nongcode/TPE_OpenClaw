import { launchChrome, CHROME_PROFILE } from "./lib/browser.js";

const logs = [];
console.error(`[setup] Profile dir: ${CHROME_PROFILE.userDataDir}`);
console.error(`[setup] Chrome sẽ mở ở user-data-dir RIÊNG (không đụng Chrome desktop của bạn).`);
console.error(`[setup] Trong Chrome vừa mở:`);
console.error(`         1. Truy cập facebook.com → đăng nhập`);
console.error(`         2. Click avatar → "Sử dụng Facebook với tư cách Page" → chọn Page bạn muốn đăng group`);
console.error(`         3. Verify identity Page đã active (avatar góc phải = avatar Page)`);
console.error(`         4. Đóng cửa sổ Chrome (X) khi xong → setup hoàn tất`);
console.error("");

const { chromeProcess, port } = await launchChrome({
  logs,
  loginMode: true,
  initialUrl: "https://www.facebook.com/",
});
console.error(`[setup] Chrome đã mở. Debug port: ${port}`);
console.error(`[setup] Đang chờ bạn đóng Chrome...`);

await new Promise((resolve) => {
  chromeProcess.on("exit", resolve);
});

console.error(`[setup] Chrome đã đóng. Setup hoàn tất.`);
console.error(`[setup] Profile lưu tại: ${CHROME_PROFILE.userDataDir}`);
console.error(`[setup] Giờ bạn có thể chạy: node skills/facebook_publish_group_post/test-run.mjs one`);
