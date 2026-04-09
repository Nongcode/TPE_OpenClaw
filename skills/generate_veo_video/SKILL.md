# generate_veo_video

Tự động mở Google Flow và tạo video bằng Veo.

## Input JSON

```json
{
  "project_url": "https://labs.google/fx/vi/tools/flow/project/....",
  "prompt": "Tạo video quảng cáo máy cân bằng lốp trong gara ô tô hiện đại, ánh sáng cao cấp, logo Tân Phát Etek ở góc phải, chuyển động camera mượt, 9:16",
  "reference_image": "D:/CodeAiTanPhat/assets/product.png",
  "aspect_ratio": "9:16",
  "multiplier": "1",
  "model": "Veo 3.1 - Quality",
  "output_dir": "D:/CodeAiTanPhat/outputs/veo",
  "user_data_dir": "D:/CodeAiTanPhat/.flow-profile",
  "headless": false,
  "timeout_ms": 1200000,
  "manual_login_timeout_ms": 180000
}
```
