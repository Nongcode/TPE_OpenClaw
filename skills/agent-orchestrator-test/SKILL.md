---
name: agent-orchestrator-test
description: "Điều phối riêng cho lane `pho_phong` khi người dùng muốn tạo bài Facebook theo quy trình duyệt hai chặng: `pho_phong` giao `nv_content` tự research thật bằng `search_product_text` rồi viết bài nháp để người dùng duyệt, sau khi người dùng duyệt content thì giao `nv_media` tự sinh prompt và tạo ảnh thật bằng `gemini_generate_image`, sau khi người dùng duyệt media thì `pho_phong` gọi `facebook_publish_post` để đăng bài thật lên Fanpage. Dùng khi cần luồng tách biệt với `agent-orchestrator`."
---

# Agent Orchestrator Test

## Overview

Điều phối một workflow riêng chỉ dành cho `pho_phong`, có trạng thái chờ duyệt giữa các lượt chat của người dùng. Skill này không dùng chung planner/executor của `agent-orchestrator`; nó chạy bằng script stateful riêng.

## Workflow

Luồng cố định:

1. User chat với `pho_phong` và giao việc tạo bài Facebook.
2. `pho_phong` giao `nv_content`.
3. `nv_content` tự dùng `skills/search_product_text/action.js` để lấy dữ liệu sản phẩm thật rồi viết bài nháp.
4. Skill trả bài nháp về cho user ở lane `pho_phong` để duyệt.
5. Khi user duyệt content, `pho_phong` giao `nv_media`.
6. `nv_media` tự sinh prompt tiếng Việt và dùng `skills/gemini_generate_image/action.js` để tạo đúng 1 ảnh thật.
7. Skill trả ảnh về cho user ở lane `pho_phong` để duyệt.
8. Khi user duyệt media, `pho_phong` gọi `skills/facebook_publish_post/action.js` để đăng bài thật.

## Cách chạy

Khi user gửi brief mới trong lane `pho_phong`, ghi nguyên văn brief UTF-8 vào file tạm trong workspace `pho_phong`, rồi chạy:

```bash
node D:/CodeAiTanPhat/TPE_OpenClaw/skills/agent-orchestrator-test/scripts/orchestrator.js --json --openclaw-home C:/Users/Administrator/.openclaw --from pho_phong --message-file C:/Users/Administrator/.openclaw/workspace_phophong/tmp/workflow-brief.txt
```

Khi user duyệt hoặc yêu cầu sửa ở bước content/media, tiếp tục ghi đúng câu user vừa nói vào cùng file `workflow-brief.txt` rồi chạy lại đúng lệnh trên. Script sẽ tự đọc trạng thái pending và quyết định:

- chuyển sang `nv_media`
- yêu cầu `nv_content` sửa lại
- yêu cầu `nv_media` sửa lại
- hoặc publish

## Quy tắc bắt buộc

- Chỉ dùng skill này cho lane `pho_phong`.
- Không dùng `skills/agent-orchestrator/scripts/orchestrator.js`.
- Không bỏ qua bước user duyệt content.
- Không bỏ qua bước user duyệt media.
- `nv_content` phải tự research thật bằng `search_product_text`.
- `nv_media` phải tự tạo ảnh thật bằng `gemini_generate_image`.
- Bản test này hiện chỉ tạo ảnh và publish bài ảnh. Không tạo video trong workflow mặc định.
- Publish chỉ chạy sau khi content và media đều đã được user duyệt.

## Trạng thái workflow

Script lưu state tại:

```text
C:/Users/Administrator/.openclaw/workspace_phophong/agent-orchestrator-test/current-workflow.json
```

Nếu đang có workflow pending thì lượt chat tiếp theo của user trong lane `pho_phong` sẽ được hiểu là:

- duyệt content
- từ chối content để sửa
- duyệt media để đăng bài
- hoặc từ chối media để sửa

## Phản hồi mong đợi

Script trả JSON tóm tắt để lane `pho_phong` có thể phản hồi user tự nhiên. Các trạng thái chính:

- `awaiting_content_approval`
- `awaiting_media_approval`
- `published`
- `blocked`

## Resources

- Xem [references/flow.md](references/flow.md) để biết state machine và câu lệnh user nên dùng.
- Dùng `scripts/orchestrator.js` làm entrypoint.
