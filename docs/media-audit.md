# Media Audit

Phạm vi: audit này dựa trên codebase OpenClaw trong workspace hiện tại. Không thấy thư mục `UpTek_FE` trong repo này, nên các phát hiện bên dưới chỉ phản ánh các luồng media có trong OpenClaw. Task này không thay đổi hành vi hệ thống.

## 1. Endpoint và backend logic liên quan tới ảnh

### Core HTTP/RPC

| Luồng | File chính | Mô tả |
| --- | --- | --- |
| `GET /media/:id` | `src/media/server.ts`, `src/media/store.ts` | Serve file tạm trong thư mục media của OpenClaw. Route validate id, giới hạn kích thước, sniff MIME, set `nosniff`, xóa file sau khi response kết thúc và có cleanup TTL định kỳ. Đây là URL tạm, không phải asset bền vững. |
| Lưu media tạm | `src/media/store.ts` | `saveMediaSource` tải URL `http(s)` hoặc copy file local vào media dir; `saveMediaBuffer` lưu buffer inbound. Có giới hạn 5 MB, sniff MIME, đặt extension theo content type, và dùng SSRF guard cho URL remote. |
| Fetch media remote | `src/media/fetch.ts` | Tải remote media qua guarded fetch, kiểm tra redirect, content-length, giới hạn byte, content-disposition filename và MIME sniff. |
| `GET/HEAD /avatar/:agentId` | `src/gateway/control-ui.ts`, `src/gateway/control-ui-shared.ts` | Serve avatar local của agent qua Control UI. Local file được mở với kiểm tra symlink/size; remote/data avatar chỉ được trả trong metadata, không proxy nội dung remote. |
| `GET/HEAD /__openclaw/chat-artifact` | `src/gateway/control-ui.ts`, `src/gateway/control-ui-shared.ts` | Serve ảnh/video artifact cho chat UI. `path` chỉ được phép là relative path an toàn dưới `artifacts`; `absolute_path` chỉ được phép nếu đường dẫn nằm dưới một thư mục ancestor tên `artifacts`. |
| `chat.send` RPC | `src/gateway/server-methods/chat.ts`, `src/gateway/chat-attachments.ts` | Nhận attachment từ UI/mobile dạng base64 hoặc data URL. Backend chỉ giữ attachment có MIME ảnh hợp lệ/sniff được, rồi truyền vào `dispatchInboundMessage` dưới dạng `images` cho agent/vision. |
| `chat.history` RPC | `src/gateway/server-methods/chat.ts`, `src/gateway/chat-image-artifacts.ts` | Trả lịch sử chat đã sanitize. Raw image data trong block lịch sử bị loại bỏ để tránh payload lớn; generated/chat artifacts được chuyển thành block ảnh/video dùng URL `/__openclaw/chat-artifact`. |

### Core xử lý path và upload/download nội bộ

| Luồng | File chính | Mô tả |
| --- | --- | --- |
| Load outbound media | `extensions/whatsapp/src/media.ts` | Hàm `loadWebMedia`/`loadWebMediaRaw` được nhiều channel dùng để đọc URL remote, path local, hoặc `file://`. Local file phải nằm trong allowed roots hoặc có `readFile` đã sandbox-validate. Ảnh có thể được tối ưu bằng Sharp, gồm resize/compress và chuyển HEIC sang JPEG. |
| Allowed local roots | `src/media/local-roots.ts` | Xác định các root local được đọc: temp dir, state media, agents, workspace, sandboxes, và workspace scoped theo agent. Đây là ranh giới bảo mật quan trọng cho migration. |
| Stage inbound media vào sandbox | `src/auto-reply/reply/stage-sandbox-media.ts` | Copy inbound media từ media dir hoặc remote iMessage attachment root vào sandbox `media/inbound/...`; khi không có sandbox thì cache vào media remote-cache. Sau đó rewrite `MediaPath(s)` và `MediaUrl(s)` trong context/session. |
| Normalize reply media path | `src/auto-reply/reply/reply-media-paths.ts` | Chuẩn hóa `ReplyPayload.mediaUrl(s)`. Data URL bị cấm, HTTP URL giữ nguyên, local path được resolve theo sandbox hoặc workspace. |
| Media understanding cache | `src/media-understanding/attachments.normalize.ts`, `src/media-understanding/attachments.cache.ts` | Chuẩn hóa/cached attachment để phục vụ phân tích media. Remote URL được fetch qua logic guard và path cache riêng. |
| Chunked reply media | `src/plugin-sdk/reply-payload.ts` | Tách text dài và `mediaUrl(s)` khi gửi qua channel. Đây là lớp chung cho nhiều plugin/channel outbound. |

### Channel inbound và outbound

Các channel không dùng cùng một API upload, nhưng pattern chung là:

- Inbound: download/copy attachment về local hoặc giữ URL, rồi ghi vào `MsgContext.MediaPath`, `MsgContext.MediaPaths`, `MsgContext.MediaUrl`, hoặc `MsgContext.MediaUrls`.
- Outbound: đọc `ReplyPayload.mediaUrl(s)` qua `loadWebMedia` hoặc helper tương tự, sau đó upload bằng API riêng của từng nền tảng.

Các nhóm file đáng chú ý:

| Nhóm | File/Thư mục | Ghi chú |
| --- | --- | --- |
| WhatsApp | `extensions/whatsapp/src/inbound/media.ts`, `extensions/whatsapp/src/send.ts`, `extensions/whatsapp/src/media.ts` | Inbound/outbound media và helper đọc/tối ưu ảnh đang là điểm dùng lại rộng rãi. |
| Telegram | `extensions/telegram/src/send.ts`, `extensions/telegram/src/bot/delivery.resolve-media.ts` | Resolve media outbound/inbound rồi gửi theo loại ảnh/video/audio/document. |
| Slack | `extensions/slack/src/send.ts`, `extensions/slack/src/monitor/media.ts` | Upload file outbound và tải media inbound từ Slack. |
| Discord | `extensions/discord/src/send.shared.ts`, `extensions/discord/src/send.components.ts`, `extensions/discord/src/monitor/message-utils.ts` | Upload attachment, emoji/sticker/media và trích attachment inbound. |
| Microsoft Teams | `extensions/msteams/src/graph-upload.ts`, `extensions/msteams/src/messenger.ts`, `extensions/msteams/src/monitor-handler/inbound-media.ts` | Dùng Graph upload và xử lý attachment inbound. |
| Google Chat | `extensions/googlechat/src/api.ts`, `extensions/googlechat/src/channel.ts`, `extensions/googlechat/src/monitor.ts` | Upload attachment qua Google Chat media endpoint và nhận attachment inbound. |
| Matrix | `extensions/matrix/src/matrix/send/media.ts`, `extensions/matrix/src/matrix/monitor/media.ts` | Upload/download media Matrix. |
| Mattermost | `extensions/mattermost/src/mattermost/send.ts`, `extensions/mattermost/src/mattermost/monitor.ts` | Upload file hoặc dùng URL tùy loại outbound. |
| BlueBubbles/iMessage | `extensions/bluebubbles/src/media-send.ts`, `extensions/bluebubbles/src/attachments.ts`, `src/auto-reply/reply/stage-sandbox-media.ts` | Attachment local/remote iMessage cần staging và allowlist riêng. |
| Zalo/Zalo user | `extensions/zalo/src/monitor.ts`, `extensions/zalouser/src/channel.ts`, `extensions/zalouser/src/qr-temp-file.ts` | Media send/read và QR temp file. |
| Feishu, LINE, IRC, Nextcloud Talk, Tlon | `extensions/feishu/src/media.ts`, `extensions/line/src/channel.ts`, `extensions/irc/src/channel.ts`, `extensions/nextcloud-talk/src/channel.ts`, `extensions/tlon/src/urbit/upload.ts` | Các channel phụ có upload/download media hoặc gửi URL media. |

### Tool/skill tạo, đọc, xuất bản ảnh

| Nhóm nghiệp vụ | File/Thư mục | Mô tả |
| --- | --- | --- |
| OpenAI image generation | `skills/openai-image-gen/scripts/gen.py` | Gọi image generation API, lưu ảnh vào output dir và tạo `index.html` gallery thumbnail. |
| Gemini image generation | `skills/gemini_generate_image/action.js` | Upload ảnh reference vào Gemini UI, lấy ảnh generated bằng download hoặc screenshot fallback, lưu artifact ảnh và screenshot. |
| Gemini/Veo video generation | `skills/generate_video/action.js`, `skills/generate_veo_video/action.js` | Dùng ảnh reference làm input video generation, lưu video/screenshot artifact. |
| Chat image reply artifact | `skills/gemini_generate_image_chat_reply/action.js`, `skills/shared/chat-image-result.js` | Trả kết quả `chat_image` với `image_path`, `downloaded_image_path`, `absolute_image_path` để chat UI render. |
| Campaign/product media | `skills/campaign_artifacts_publisher/action.js`, `skills/campaign_orchestrator_minimal/action.js`, `skills/agent-orchestrator/scripts/campaign_pipeline.js`, `skills/agent-orchestrator/scripts/product_research.js`, `skills/agent-orchestrator/scripts/simulation_artifacts.js` | Lưu và truyền `image_paths`, `media_paths`, generated image/video, logo paths, product profile paths trong artifact JSON. |
| Product/reference image extraction | `skills/search_product_text/extract-image-for-media.js`, `skills/search_product_text/text-extractor.js`, `skills/normalize_product_input/action.js` | Scrape/download ảnh product/reference, lưu artifacts và profile có `image_paths`. |
| Facebook publish/schedule | `skills/facebook_publish_post/action.js`, `skills/schedule_facebook_post/action.js`, `skills/facebook_edit_post/action.js`, `skills/auto-content/post_fb.js` | Đăng ảnh/video lên Graph API từ path local hoặc URL ảnh. |
| Screenshots/temp visual artifacts | `skills/remote-access/action.js`, `skills/open_browser_profile/action.js` | Lưu screenshot làm artifact tạm hoặc bằng chứng thao tác. |

## 2. Bảng/cột DB hoặc nơi lưu path/url ảnh

Không thấy schema database quan hệ trong core `src/` đang định nghĩa bảng/cột ảnh. Phần lớn path/url ảnh được lưu trong JSON transcript, config, artifact hoặc context runtime.

| Nơi lưu | Field/path | File liên quan | Ghi chú migration |
| --- | --- | --- | --- |
| Product DB trong skill auto-content | `products.image_url` | `skills/auto-content/get_product_info.js` | Đây là SQL rõ ràng nhất tìm thấy có cột ảnh. Nếu hệ thống product DB thật nằm ngoài repo, cần audit DB đó riêng. |
| Chat RPC/transcript content | `content[].type=image`, `image_url.url`, `source.data`, `source.media_type` | `src/gateway/server-methods/chat.ts`, `ui/src/ui/controllers/chat.ts`, `ui/src/ui/chat/grouped-render.ts` | Base64/data URL có thể xuất hiện trước khi được sanitize. History trả ra sẽ cố loại raw data image. |
| Tool/artifact JSON | `artifacts[].path`, `artifacts[].url`, `data.relative_image_path`, `data.absolute_image_path`, `data.relative_video_path`, `data.absolute_video_path` | `src/gateway/chat-image-artifacts.ts`, `ui/src/ui/chat/image-artifacts.ts` | Render phụ thuộc vào việc path nằm dưới `artifacts` hoặc URL remote/data hợp lệ. |
| Reply/session context | `MediaPath`, `MediaPaths`, `MediaUrl`, `MediaUrls` | `src/auto-reply/reply/stage-sandbox-media.ts`, `src/auto-reply/reply/reply-media-paths.ts` | Context runtime có thể bị rewrite khi staging vào sandbox. |
| Temporary media dir | filename UUID/original basename dưới OpenClaw media dir | `src/media/store.ts`, `src/media/server.ts` | Không phải DB; URL `/media/:id` là tạm và có cleanup/single-use behavior. |
| Sandbox inbound media | `media/inbound/<filename>` | `src/auto-reply/reply/stage-sandbox-media.ts` | Path relative trong sandbox được đưa lại vào session context. |
| Agent avatar/config | avatar local path, data URL, hoặc remote URL | `src/gateway/control-ui.ts`, `src/gateway/control-ui-shared.ts`, `ui/src/ui/chat/grouped-render.ts`, `ui/src/ui/views/chat.ts` | Avatar local được serve qua `/avatar/:agentId`; remote/data URL chỉ nên giữ đúng semantics hiện tại. |
| Product/campaign profile artifacts | `image_paths`, `media_paths`, `logoPaths`, `source_generated_images`, `source_generated_videos` | `skills/normalize_product_input/action.js`, `skills/campaign_artifacts_publisher/action.js`, `skills/agent-orchestrator/scripts/campaign_pipeline.js` | Đây là artifact JSON, không có migration schema tập trung. |
| Mobile/share attachments | base64 attachment payload | `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift`, `apps/macos/Sources/OpenClaw/GatewayConnection.swift`, `apps/ios/Sources/Chat/IOSGatewayChatTransport.swift`, `apps/ios/ShareExtension/ShareViewController.swift` | App encode ảnh rồi gửi qua RPC, không lưu DB trong code này. |

## 3. Frontend component đang hiển thị ảnh

| Frontend | File | Ảnh được render |
| --- | --- | --- |
| Web chat composer | `ui/src/ui/views/chat.ts` | Preview attachment ảnh từ file/paste/drag-drop bằng data URL; render avatar/logo trong header. |
| Web chat messages | `ui/src/ui/chat/grouped-render.ts` | Render image/video blocks trong message bằng `<img>`/`<video>`; render avatar assistant/user/tool. |
| Web chat artifact resolver | `ui/src/ui/chat/image-artifacts.ts` | Resolve artifact path, absolute artifact path, data URL, remote URL thành source render được. |
| Web markdown | `ui/src/ui/markdown.ts` | Chỉ cho inline markdown image dạng `data:image/...;base64,...`; URL ảnh markdown thường bị escape thành text. |
| Web channel settings | `ui/src/ui/views/channels.whatsapp.ts`, `ui/src/ui/views/channels.nostr.ts`, `ui/src/ui/views/channels.nostr-profile-form.ts` | Render WhatsApp QR data URL và Nostr profile/avatar images. |
| Web login/branding | `ui/src/ui/views/login-gate.ts` | Render logo/app image. |
| Shared SwiftUI chat | `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift`, `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatComposer.swift`, `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMessageViews.swift`, `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownPreprocessor.swift`, `apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatModels.swift` | Preview image attachment, decode data URL/local/HTTP image message, và xử lý inline markdown image. |
| macOS app | `apps/macos/Sources/OpenClaw/GatewayConnection.swift`, `apps/macos/Sources/OpenClaw/ChannelsSettings+Helpers.swift`, `apps/macos/Sources/OpenClaw/ChannelSections.swift` | Encode attachment gửi gateway và render QR/login images trong channel settings. |
| iOS app/share extension | `apps/ios/Sources/Chat/IOSGatewayChatTransport.swift`, `apps/ios/Sources/Media/PhotoLibraryService.swift`, `apps/ios/Sources/Screen/ScreenController.swift`, `apps/ios/ShareExtension/ShareViewController.swift` | Encode attachment ảnh, đọc ảnh từ photo library/share extension/screen capture rồi gửi hoặc preview. |
| Generated gallery | `skills/openai-image-gen/scripts/gen.py` | Tạo `index.html` gallery có thumbnail `<img>` cho ảnh generated. |

## 4. Phân loại ảnh theo nghiệp vụ

| Loại | Nguồn/path chính | Đặc điểm |
| --- | --- | --- |
| Chat | `chat.send` attachments, channel inbound `MediaPath(s)`/`MediaUrl(s)`, message content `image`/`image_url`, `/media/:id`, `/__openclaw/chat-artifact` | Có cả base64, data URL, local path, URL remote và artifact URL. Một phần là tạm, một phần là durable artifact. |
| Gallery | `skills/openai-image-gen/scripts/gen.py`, chat grouped image rendering | Gallery rõ nhất là HTML thumbnail index của OpenAI image generation skill; chat UI cũng gom render nhiều ảnh/video nhưng không phải gallery lưu trữ riêng. |
| Company asset | Agent avatar/logo, app logo/assets, campaign/logo paths, Nostr profile image | Bao gồm avatar/branding dùng trong UI và logo/reference image dùng cho campaign/generation. Cần phân biệt với ảnh user upload vì quyền truy cập/công khai khác nhau. |
| Generated media | `artifacts/images`, `artifacts/videos`, `outputs/veo_videos`, `chat_image`, `generated_image`, `generated_video` artifacts | Media do skill/tool tạo, thường được render qua `/__openclaw/chat-artifact` nếu nằm dưới `artifacts`. |
| Tạm thời | OpenClaw media dir, sandbox `media/inbound`, remote-cache, QR temp files, screenshots before/after/fallback | Không nên migrate như storage bền vững. Một số ảnh có TTL, single-use hoặc chứa thông tin nhạy cảm như QR/login screenshot. |

## 5. Rủi ro khi migrate

- Storage model đang bị phân mảnh: media tạm, sandbox copy, artifact bền vững, URL remote, data URL/base64 và config/avatar path có lifecycle khác nhau.
- URL `/media/:id` là tạm và có cleanup/single-use behavior; nếu migrate nhầm thành public durable URL sẽ đổi semantics và có thể lộ dữ liệu.
- Route `/__openclaw/chat-artifact` chỉ serve file dưới thư mục tên `artifacts`; chuyển generated media ra nơi khác sẽ làm chat preview hỏng nếu không đổi resolver/route.
- Nhiều artifact và transcript có absolute path. Khi đổi máy, đổi OS, đổi workspace hoặc đổi separator path, link cũ có thể không render được.
- Allowed local roots trong `src/media/local-roots.ts` và sandbox validation là ranh giới chống đọc file tùy ý. Mở rộng root trong migration có thể tạo rủi ro exfiltration.
- Remote media fetch có SSRF guard ở một số đường đi, nhưng không phải mọi nơi đều cùng helper. Migration cần giữ guard tập trung, tránh thêm fetch raw.
- Frontend và backend đang chấp nhận data URL/base64 ở chat flow. Payload lớn, history bloat và leak raw image data là rủi ro nếu bỏ sanitize hoặc log thêm dữ liệu.
- Channel APIs có giới hạn và semantics khác nhau: Slack/Discord/Telegram/MSTeams/Google Chat/Matrix/Mattermost không upload cùng kiểu, không cùng MIME/size support.
- `loadWebMedia` có tối ưu ảnh bằng Sharp, có thể đổi format/kích thước. Nếu migrate sang object storage/CDN mà bỏ bước này, channel send có thể fail vì size/type.
- MIME được sniff từ nội dung và extension có thể không đáng tin. Migration cần ưu tiên content sniff và metadata chuẩn hóa thay vì tin path extension.
- Company assets/logo/reference images có thể là private nhưng được dùng trong generated media pipeline. Đưa lên public bucket/CDN cần phân quyền rõ.
- QR/login screenshots và remote-access screenshots có thể chứa token hoặc dữ liệu nhạy cảm. Không nên đưa nhóm này vào storage public/durable mặc định.
- `products.image_url` trong `skills/auto-content/get_product_info.js` là dấu hiệu DB ngoài core. Nếu production có DB riêng cho product/company, migration phải audit trực tiếp schema và dữ liệu thực tế.
- Bot/tool result shape đang được cả backend và frontend parse. Đổi field như `artifacts[].path`, `data.absolute_image_path`, `image_paths`, `media_paths` có thể làm mất preview dù file vẫn tồn tại.
- Một số skill dùng browser automation, download hoặc screenshot fallback. Migration phải giữ được đường dẫn local mà Playwright/browser có thể upload/đọc, không chỉ URL public.
