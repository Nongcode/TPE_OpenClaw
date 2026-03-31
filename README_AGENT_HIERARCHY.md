# Agent Hierarchy And Control UI README

## 1. Muc tieu cua chuoi thay doi nay

Tai lieu nay tong hop toan bo nhung thay doi da duoc them de bien he thong agent hien tai thanh:

- mot bo dieu phoi agent doc lap, khong bi khoa cung trong `auto-content`
- mot he thong phan cap phan quyen ro rang theo vai tro `main -> quan_ly -> truong_phong -> pho_phong -> nhan_vien`
- mot Control UI co the mo tung tab rieng cho tung role nhung van ton trong policy xem session
- mot co che dang nhap demo bang email va mat khau de dua dung nhan su vao dung khung chat va tu dong nhan gateway token

Tai lieu nay chi mo ta nhung thay doi da thuc hien cho bai toan nay, khong mo ta toan bo lich su cua repo OpenClaw.

## 2. Bai toan ban dau

He thong ban dau gap 4 nhom van de chinh:

- `skills/auto-content/agent_bridge.js` chi dong vai tro mot bridge cuc bo, khong phai orchestrator chung
- registry agent va routing bi hardcode, kho mo rong cho agent moi trong `~/.openclaw/agents`
- UI chi khoa chon agent o mot so cho, nhung van co the lo du lieu qua session list hoac session switch
- chua co luong dang nhap nhan vien theo email/mat khau de map vao dung agent lane

## 3. Ket qua kien truc hien tai

He thong hien tai duoc tach thanh 4 lop:

### 3.1. Lop runtime agent

Nguon su that la he thong agent that duoc tao duoi `~/.openclaw/agents` va cac workspace rieng.

Trong bai toan nay, so do to chuc duoc su dung la:

- `main`
- `quan_ly`
- `truong_phong`
- `pho_phong`
- `nv_content`
- `nv_media`

### 3.2. Lop orchestrator chung

Mot skill/doc lap moi da duoc tao tai `skills/agent-orchestrator`.

Thanh phan chinh:

- `skills/agent-orchestrator/scripts/orchestrator.js`
- `skills/agent-orchestrator/scripts/registry.js`
- `skills/agent-orchestrator/scripts/planner.js`
- `skills/agent-orchestrator/scripts/executor.js`
- `skills/agent-orchestrator/scripts/transport.js`
- `skills/agent-orchestrator/manifests/*.json`
- `skills/agent-orchestrator/references/*.md`

Muc tieu cua lop nay:

- auto-discover agent that
- tai manifest theo role
- sinh workflow theo phan cap
- dispatch task xuong dung role
- giu `auto-content` thanh wrapper mong

### 3.3. Lop enforcement o gateway

Phan quyen thuc su duoc day xuong gateway, khong chi o frontend.

Thanh phan chinh:

- `src/gateway/control-ui-access.ts`
- `src/gateway/control-ui.ts`
- `src/gateway/server/ws-connection/message-handler.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/protocol/schema/frames.ts`

Muc tieu cua lop nay:

- resolve role policy tu `gateway.controlUi.employeeDirectory`
- xac dinh agent/session nao duoc xem
- chan RPC truy cap session/chat ngoai pham vi duoc cap
- truyen `accessPolicy` xuong UI va len WS handshake

### 3.4. Lop Control UI

UI duoc nang cap de:

- khoa theo agent/session khi can
- nhin thay nhieu session neu role duoc phep
- an tab `Sessions` voi role self-only
- hien login gate bang email/mat khau cho demo

Thanh phan chinh:

- `ui/src/ui/app-settings.ts`
- `ui/src/ui/control-ui-access.ts`
- `ui/src/ui/app-render.ts`
- `ui/src/ui/app-render.helpers.ts`
- `ui/src/ui/gateway.ts`
- `ui/src/ui/views/login-gate.ts`
- `ui/src/ui/controllers/control-ui-bootstrap.ts`
- `ui/src/ui/controllers/control-ui-login.ts`

### 3.5. Lop tach "bo nao" theo agent

He thong hien tai ho tro tach rieng 2 thu:

- model cua tung agent
- auth profile/API key cua tung agent

Phan model:

- dat trong `agents.list[].model`

Phan auth profile:

- dat trong `agents.list[].authProfiles`
- moi provider map sang 1 profile id
- runtime se tu dong khoa agent vao profile do khi goi model/provider tuong ung

Vi du:

```json
{
  "agents": {
    "list": [
      {
        "id": "quan_ly",
        "model": {
          "primary": "openai/gpt-5"
        },
        "authProfiles": {
          "openai": "openai:quan-ly"
        }
      },
      {
        "id": "nv_content",
        "model": {
          "primary": "openai/gpt-5-mini"
        },
        "authProfiles": {
          "openai": "openai:content"
        }
      }
    ]
  }
}
```

Luu y quan trong:

- `auth.profiles` trong `openclaw.json` chi dinh nghia metadata profile
- secret API key that nen dat trong `auth-profiles.json`
- neu muon tach key theo tung agent, cach sach nhat la dung moi agent mot `auth-profiles.json` rieng trong agent dir

## 4. Tien trinh thay doi theo giai doan

### Giai doan A. Refactor bridge thanh orchestrator doc lap

Da tao he thong moi trong `skills/agent-orchestrator` thay cho viec de logic dieu phoi trong `skills/auto-content`.

Nhung thay doi chinh:

- them registry doc manifest va agent runtime that
- them planner co hieu `direct`, `auto`, `hierarchy`
- them executor theo task envelope
- them transport de gui task vao session
- them manifest mau cho `quan_ly`, `truong_phong`, `pho_phong`, `nv_content`, `nv_media`
- bien `skills/auto-content/agent_bridge.js` thanh wrapper goi sang orchestrator moi

Y nghia:

- bo dieu phoi nay khong con bi rang buoc vao skill `auto-content`
- cac skill khac co the goi chung orchestrator
- them agent moi chu yeu la them manifest va dang ky runtime, khong phai viet lai bridge

### Giai doan B. Chuan hoa phan cap va policy xem session

Da xay dung policy mac dinh theo dung co cau doanh nghiep:

- `main`: xem tat ca
- `quan_ly`: xem tat ca
- `truong_phong`: xem `truong_phong`, `pho_phong`, `nv_content`, `nv_media`
- `pho_phong`: xem `pho_phong`, `nv_content`, `nv_media`
- `nv_*`: chi xem lane cua chinh minh

Logic cot loi nam o `src/gateway/control-ui-access.ts`.

Ham `resolveDefaultVisibilityForLockedAgent(...)` la noi quyet dinh visibility mac dinh.

Ham `resolveControlUiSessionVisibility(...)` giai quyet 2 che do:

- neu config co `canViewAllSessions` hoac `visibleAgentIds` explicit thi dung explicit policy
- neu khong co explicit policy thi roi vao hierarchy mac dinh theo `lockedAgentId`

Bug da duoc sua o giai doan nay:

- truoc do `lockedAgentId` luon bi cong vao `visibleAgentIds`, lam cho `truong_phong` va `pho_phong` khong bao gio roi vao hierarchy mac dinh
- sau khi sua, chi khi config co `visibleAgentIds` explicit moi dung explicit branch

### Giai doan C. Day policy tu backend ra UI va WS

Da mo rong contract Control UI de policy khong bi rut gon nua.

File lien quan:

- `src/gateway/control-ui-contract.ts`
- `src/gateway/protocol/schema/frames.ts`
- `ui/src/ui/gateway.ts`
- `ui/src/ui/controllers/control-ui-bootstrap.ts`

Da them ho tro day du cho:

- `employeeId`
- `employeeName`
- `lockedAgentId`
- `lockedSessionKey`
- `canViewAllSessions`
- `visibleAgentIds`
- `lockAgent`
- `lockSession`
- `autoConnect`
- `enforcedByServer`

Bug da duoc sua o giai doan nay:

- bootstrap fallback tung tu dung object tay va lam roi `canViewAllSessions`, `visibleAgentIds`
- WS connect tung map thieu policy field
- sau khi sua, ca bootstrap va WS deu truyen du policy

### Giai doan D. Tach UI locking thanh hai khai niem

Da tach ro:

- `bi khoa cứng vao 1 lane`
- `duoc xem nhieu session theo hierarchy`

Logic nam o `ui/src/ui/control-ui-access.ts` va `ui/src/ui/app-settings.ts`.

Nguyen tac:

- worker self-only bi hard lock
- supervisor/manager van co preferred lane khi dang nhap
- nhung neu policy cho xem nhieu session thi UI khong duoc coi ho la self-only

Bug da duoc sua:

- `quan_ly` va `main` co luc bi an `Sessions` vi URL van mang `lockSession=1&lockAgent=1`
- sau khi sua, bootstrap policy co uu tien cao hon URL lock voi role co multi-session visibility

### Giai doan E. Chan ro du lieu o backend thay vi chi o UI

Da them enforcement o server de UI khong the lat duong bang cach goi RPC truc tiep.

Da chan cac nhom duong nhay sau:

- `sessions.list`
- `sessions.preview`
- `sessions.get`
- `sessions.resolve`
- `sessions.patch`
- `sessions.reset`
- `sessions.delete`
- `sessions.compact`
- `chat.history`
- `chat.send`
- `chat.abort`
- `chat.inject`

Y nghia:

- nhan vien khong chi bi an nut bam
- ma ngay ca gateway cung tu choi session/chat ngoai quyen

### Giai doan F. Them employeeDirectory va trusted-proxy support

Da mo rong config gateway de map nhan vien -> role/agent.

File lien quan:

- `src/config/types.gateway.ts`
- `src/config/zod-schema.ts`
- `src/config/schema.labels.ts`
- `src/config/schema.help.ts`
- `src/config/schema.hints.ts`
- `src/gateway/control-ui.ts`
- `src/gateway/auth.ts`

`gateway.controlUi.employeeDirectory` gio ho tro:

- `employeeId`
- `employeeName`
- `aliases`
- `lockedAgentId`
- `lockedSessionKey`
- `canViewAllSessions`
- `visibleAgentIds`
- `lockAgent`
- `lockSession`
- `autoConnect`

Ngoai ra, trusted-proxy auth da ho tro:

- `userHeader`
- `displayNameHeader`

Muc tieu:

- khi co auth that thi gateway tu biet user nao dang vao
- policy duoc resolve tu server, khong phu thuoc query string nua

### Giai doan G. Them login demo bang email/mat khau

Da them mot login gate don gian cho demo vai tro.

File lien quan:

- `src/gateway/control-ui-contract.ts`
- `src/gateway/control-ui.ts`
- `src/gateway/control-ui-routing.ts`
- `ui/src/ui/controllers/control-ui-bootstrap.ts`
- `ui/src/ui/controllers/control-ui-login.ts`
- `ui/src/ui/app.ts`
- `ui/src/ui/app-lifecycle.ts`
- `ui/src/ui/views/login-gate.ts`

Da them:

- endpoint bootstrap tra ve `demoLogin`
- endpoint `POST /__openclaw/control-ui-login`
- form email/password o login gate
- sample account list o UI
- tu dong lay gateway token tu server sau khi login thanh cong
- tu dong ap `accessPolicy` va nhay vao dung session

Logic dang nhap:

1. UI goi bootstrap
2. bootstrap tra `demoLogin` va `accessPolicy` neu co
3. neu demo login dang bat, tab moi khong tu auto-connect vao gateway
4. user nhap email/mat khau
5. UI goi `POST /__openclaw/control-ui-login`
6. server verify account trong `gateway.controlUi.demoLogin.accounts`
7. server tra ve token + `accessPolicy`
8. UI luu token trong session scope, apply policy, sync URL/session, connect vao gateway

## 5. So do phan quyen hien tai

### 5.1. Quyen xem session

| Role | Xem duoc session nao |
| --- | --- |
| `main` | tat ca |
| `quan_ly` | tat ca |
| `truong_phong` | `truong_phong`, `pho_phong`, `nv_content`, `nv_media` |
| `pho_phong` | `pho_phong`, `nv_content`, `nv_media` |
| `nv_content` | chi `nv_content` |
| `nv_media` | chi `nv_media` |

### 5.2. Hanh vi UI

- role self-only: an `Sessions`, an session switching vuot quyen
- role supervisory: giu lane mac dinh cua minh khi vao chat, nhung van mo `Sessions` de xem cap duoi
- role `main` va `quan_ly`: co the xem toan bo session, dung cho giam sat

### 5.3. Hanh vi gateway

- UI co the an nut, nhung gateway moi la noi enforce cuoi cung
- neu client co tinh yeu cau session ngoai quyen, gateway tra `unauthorized`

## 6. Du lieu cau hinh mau dang duoc dung

Trong local config cua he thong hien tai, da bo sung `demoLogin` va mot role `main` sample.

Tai khoan demo hien dang dung:

- `main@example.com` / `Demo@123`
- `quanly@example.com` / `Demo@123`
- `truongphong@example.com` / `Demo@123`
- `phophong@example.com` / `Demo@123`
- `content@example.com` / `Demo@123`
- `media@example.com` / `Demo@123`

Mapping vai tro:

- `main@example.com` -> `main`
- `quanly@example.com` -> `quan_ly`
- `truongphong@example.com` -> `truong_phong`
- `phophong@example.com` -> `pho_phong`
- `content@example.com` -> `nv_content`
- `media@example.com` -> `nv_media`

## 7. Map file theo chuc nang

### 7.1. Orchestrator

- `skills/agent-orchestrator/scripts/orchestrator.js`
  CLI entrypoint chung cho bo dieu phoi
- `skills/agent-orchestrator/scripts/registry.js`
  discover agent, session, workspace, merge manifest
- `skills/agent-orchestrator/scripts/planner.js`
  sinh plan `direct`, `auto`, `hierarchy`
- `skills/agent-orchestrator/scripts/executor.js`
  chay plan va dong goi task envelope
- `skills/agent-orchestrator/scripts/transport.js`
  gui task vao session/gateway backend
- `skills/auto-content/agent_bridge.js`
  wrapper mong de giu compatibility voi skill cu

### 7.2. Gateway policy va bootstrap

- `src/gateway/control-ui-access.ts`
  logic phan quyen cot loi
- `src/gateway/control-ui.ts`
  bootstrap, login endpoint, avatar va static control UI serving
- `src/gateway/control-ui-routing.ts`
  route classification, bao gom login route
- `src/gateway/control-ui-contract.ts`
  contract bootstrap/login/access policy
- `src/gateway/protocol/schema/frames.ts`
  schema WS connect frame cho `controlUiAccess`

### 7.3. UI behavior

- `ui/src/ui/control-ui-access.ts`
  rule UI cho tab/session/agent switching
- `ui/src/ui/app-settings.ts`
  dong bo URL, policy, lock state, tab visibility
- `ui/src/ui/app-render.ts`
  render navigation va session-related surfaces
- `ui/src/ui/app-render.helpers.ts`
  helper cho dropdown, lock labels, session routing
- `ui/src/ui/gateway.ts`
  WS connect va truyen `controlUiAccess`
- `ui/src/ui/views/login-gate.ts`
  man login, sample account list
- `ui/src/ui/controllers/control-ui-bootstrap.ts`
  load bootstrap config
- `ui/src/ui/controllers/control-ui-login.ts`
  POST login den gateway
- `ui/src/ui/app.ts`
  state va handler dang nhap
- `ui/src/ui/app-lifecycle.ts`
  skip auto-connect cho tab moi khi demo login dang bat

### 7.4. Config schema

- `src/config/types.gateway.ts`
- `src/config/zod-schema.ts`
- `src/config/schema.labels.ts`
- `src/config/schema.help.ts`
- `src/config/schema.hints.ts`

Nhom file nay da duoc mo rong de config form va config validation hieu:

- `employeeDirectory`
- `demoLogin`
- `displayNameHeader`
- `visibleAgentIds`
- `canViewAllSessions`

## 8. Nhung bug quan trong da gap va da sua

### Bug 1. UI khoa o chat nhung van lo session qua trang Sessions

Nguyen nhan:

- chi enforce o UI mot phan

Cach sua:

- day policy vao gateway
- chan RPC session/chat o backend

### Bug 2. `truong_phong` va `pho_phong` bi an `Sessions`

Nguyen nhan:

- `resolveControlUiSessionVisibility(...)` khong roi vao default hierarchy

Cach sua:

- explicit `visibleAgentIds` va default hierarchy duoc tach ro

### Bug 3. `main` va `quan_ly` bi an `Sessions` do URL lock flag

Nguyen nhan:

- frontend uu tien `lockSession=1&lockAgent=1` tu URL

Cach sua:

- bootstrap policy co uu tien cao hon voi role multi-session

### Bug 4. Bootstrap lam roi `canViewAllSessions` va `visibleAgentIds`

Nguyen nhan:

- fallback bootstrap trong `src/gateway/control-ui.ts` tu dung object tay

Cach sua:

- dung `buildClientDeclaredAccessPolicy(...)`

### Bug 5. UI/WS khong mang day du policy field

Nguyen nhan:

- `ui/src/ui/gateway.ts` va schema connect frame map thieu field

Cach sua:

- mo rong schema va payload cho `canViewAllSessions`, `visibleAgentIds`, `lockAgent`, `lockSession`

### Bug 6. Token cu co the bo qua man login demo

Nguyen nhan:

- Control UI co the auto-connect bang token da luu trong session

Cach sua:

- tab moi chi duoc connect khi co `demo-login.authed` marker
- marker chi duoc set sau khi login demo thanh cong

## 9. Hanh vi hien tai can nho khi van hanh

- neu `gateway.controlUi.demoLogin.enabled = true`, tab moi hien login gate
- sau khi login demo thanh cong, token gateway duoc tu dong luu trong session scope
- quyen xem session van duoc enforce boi gateway, khong chi boi UI
- `main` va `quan_ly` co the vao trang `Sessions` de giam sat
- `truong_phong` va `pho_phong` chi xem duoc cap duoi dung hierarchy
- `nv_content` va `nv_media` khong duoc xem session cua nguoi khac

## 10. Gioi han va huong mo rong tiep theo

Nhung gi da co hien nay hop cho demo va van hanh noi bo, nhung chua phai full production IAM.

Huong mo rong hop ly tiep theo:

- thay demo login bang auth that qua SSO hoac trusted reverse proxy
- them logout/switch-account UX ro rang trong Control UI
- them task store/resume state cho orchestrator
- them orchestration board de theo doi nhieu lane tren mot man hinh
- them planner thong minh hon cho workflow da buoc

## 11. Cach doc README nay de review code

Neu muon review theo thu tu hop ly, nen doc:

1. `skills/agent-orchestrator/scripts/orchestrator.js`
2. `skills/agent-orchestrator/scripts/registry.js`
3. `src/gateway/control-ui-access.ts`
4. `src/gateway/control-ui.ts`
5. `ui/src/ui/control-ui-access.ts`
6. `ui/src/ui/app-settings.ts`
7. `ui/src/ui/views/login-gate.ts`
8. `ui/src/ui/controllers/control-ui-login.ts`

Thu tu nay se giup thay ro tu orchestration -> backend policy -> frontend behavior -> login UX.

## 12. Ket luan

Chuoi thay doi nay da bien he thong tu:

- mot bridge cuc bo trong `auto-content`

thanh:

- mot bo dieu phoi agent co phan cap
- mot he thong gateway enforce phan quyen session/chat
- mot Control UI ton trong hierarchy role
- mot login demo bang email/mat khau de vao dung role va dung lane

Noi dung nay duoc viet de phuc vu viec review he thong phan cap phan quyen va luong dieu phoi agent hien tai.
