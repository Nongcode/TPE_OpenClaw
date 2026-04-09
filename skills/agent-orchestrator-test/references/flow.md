# Flow

## State machine

`agent-orchestrator-test` chỉ có 4 trạng thái chính:

1. `drafting_content`
2. `awaiting_content_approval`
3. `awaiting_media_approval`
4. `published`

## User messages

Khi đang chờ duyệt content, các câu sau được hiểu là duyệt:

- "duyệt content"
- "duyệt bài"
- "ok content"
- "ok bài"
- "cho làm ảnh"

Khi đang chờ duyệt content, các câu sau được hiểu là yêu cầu sửa:

- "sửa content"
- "viết lại"
- "chưa duyệt content"
- "bài chưa đạt"

Khi đang chờ duyệt media, các câu sau được hiểu là duyệt và publish:

- "duyệt ảnh"
- "duyệt media"
- "ok ảnh"
- "đăng bài"
- "publish"

Khi đang chờ duyệt media, các câu sau được hiểu là yêu cầu sửa:

- "sửa ảnh"
- "làm lại ảnh"
- "chưa duyệt media"
- "ảnh chưa đạt"

## Output blocks expected from child agents

`nv_content` phải trả các marker sau để script parse ổn định:

- `APPROVED_CONTENT_BEGIN`
- `APPROVED_CONTENT_END`
- `PRODUCT_NAME:`
- `PRODUCT_URL:`
- `IMAGE_DOWNLOAD_DIR:`

`nv_media` phải trả các marker sau:

- `IMAGE_PROMPT_BEGIN`
- `IMAGE_PROMPT_END`
- `GENERATED_IMAGE_PATH:`

## Publish payload

Sau khi user duyệt media, script sẽ publish bằng:

```json
{
  "caption_long": "<approved content>",
  "media_paths": ["<generated image path>"]
}
```
