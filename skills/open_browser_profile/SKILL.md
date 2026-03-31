---
name: open-browser-profile
metadata:
  openclaw:
    skillKey: "open_browser_profile"
description: Mở Microsoft Edge theo profile chỉ định (browser_path, user_data_dir, profile_name, url), có JSON output chuẩn và hỗ trợ dry-run.
---

# Skill `open_browser_profile`

## Mục tiêu

Mở Microsoft Edge đúng profile người dùng để chuẩn bị cho các bước automation sau này.

## Input bắt buộc

- `browser_path`
- `user_data_dir`
- `profile_name`
- `url`

## Input tùy chọn

- `dry_run` (`true|false`): nếu `true` chỉ validate + in kế hoạch chạy, không mở trình duyệt.

## Cách chạy

### Dạng cờ CLI

`node D:/CodeAiTanPhat/TPE_OpenClaw/skills/open_browser_profile/action.js --browser_path "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --user_data_dir "C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data" --profile_name "Default" --url "https://example.com"`

### Dạng JSON input

`node D:/CodeAiTanPhat/TPE_OpenClaw/skills/open_browser_profile/action.js "{\"browser_path\":\"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe\",\"user_data_dir\":\"C:/Users/Administrator/AppData/Local/Microsoft/Edge/User Data\",\"profile_name\":\"Default\",\"url\":\"https://example.com\",\"dry_run\":true}"`

## Output chuẩn

Script luôn trả về JSON có các trường:

- `success`
- `message`
- `data`
- `artifacts`
- `logs`
- `screenshot_path`
- `error`
