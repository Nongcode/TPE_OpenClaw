# generate_veo_video

Tu dong mo Google Flow va tao video bang Veo.

## Debug DOM before generate

```bash
node skills/generate_veo_video/action.js --input_file skills/generate_veo_video/test-input.json --dry-run-dom
```

Che do nay chi mo Flow, capture DOM debug, va xuat cac file duoi `artifacts/videos/debug/`:

- `flow-body.html`
- `flow-accessibility.json`
- `flow-visible-text.txt`
- `flow-selectors.json`
- `flow-screenshot.png`

## Input JSON

```json
{
  "project_url": "https://labs.google/fx/vi/tools/flow/project/....",
  "prompt": "Tao video quang cao san pham",
  "reference_image": "D:/CodeAiTanPhat/assets/product.png",
  "logo_paths": ["D:/CodeAiTanPhat/assets/logo.png"],
  "browser_path": "C:/Program Files/CocCoc/Browser/Application/browser.exe",
  "user_data_dir": "C:/Users/Administrator/AppData/Local/CocCoc/Browser/User Data",
  "profile_name": "Profile 2",
  "output_dir": "D:/CodeAiTanPhat/outputs/veo",
  "cdp_url": "",
  "timeout_ms": 1200000,
  "step_timeout_ms": 180000,
  "download_resolution": "720p",
  "auto_close_browser": false,
  "video_count": 2,
  "generation_mode": "sequential",
  "retry_count": 3,
  "dom_debug": true,
  "debug_only": true,
  "save_step_screenshots": true,
  "fail_fast_on_quota": true,
  "per_video_prompt_suffixes": []
}
```
