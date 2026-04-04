import { html, nothing } from "lit";
import { t, i18n, SUPPORTED_LOCALES, type Locale, isSupportedLocale } from "../../i18n/index.ts";
import type { EventLogEntry } from "../app-events.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { formatDurationHuman } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import type {
  AgentsListResult,
  AttentionItem,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  HealthSummary,
  SessionsListResult,
  SessionsUsageResult,
  SkillStatusReport,
} from "../types.ts";
import type { ControlUiBootstrapAccessPolicy } from "../../../../src/gateway/control-ui-contract.js";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastErrorCode: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  attentionItems: AttentionItem[];
  eventLog: EventLogEntry[];
  overviewLogLines: string[];
  agentsList?: AgentsListResult | null;
  channelsSnapshot?: ChannelsStatusSnapshot | null;
  healthResult?: HealthSummary | null;
  bootstrapAccessPolicy?: ControlUiBootstrapAccessPolicy | null;
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onToggleGatewayTokenVisibility: () => void;
  onToggleGatewayPasswordVisibility: () => void;
  onConnect: () => void;
  onRefresh: () => void;
  onNavigate: (tab: string) => void;
  onRefreshLogs: () => void;
};

type ExecutiveCard = {
  id: string;
  label: string;
  role: string;
  status: string;
  tone: "success" | "warn" | "muted";
  sessions: number;
  tokens: number;
  cost: number;
  note: string;
};

type ChannelCard = {
  id: string;
  label: string;
  summary: string;
  tone: "success" | "warn" | "muted";
  connected: number;
  configured: number;
  total: number;
};

const AGENT_PRESENTATION: Record<string, { label: string; role: string; note: string }> = {
  main: {
    label: "Ban giám đốc AI",
    role: "Tầng ra quyết định, theo dõi KPI và phê duyệt chiến lược.",
    note: "Giữ góc nhìn toàn cảnh cho chiến dịch và hiệu quả vận hành.",
  },
  quan_ly: {
    label: "Quản lý vận hành",
    role: "Điều phối luồng công việc, tiến độ và chất lượng đầu ra.",
    note: "Giữ cho chuỗi thực thi giữa các agent không bị đứt đoạn.",
  },
  truong_phong: {
    label: "Trưởng phòng marketing",
    role: "Thiết kế kế hoạch chiến dịch và giao mục tiêu cho nhóm.",
    note: "Quy đổi yêu cầu kinh doanh thành kế hoạch hành động rõ ràng.",
  },
  pho_phong: {
    label: "Phó phòng marketing",
    role: "Bóc tách nhiệm vụ và phân công xuống từng nhân viên AI.",
    note: "Theo dõi tiến độ sản xuất nội dung, media và phản hồi nhanh.",
  },
  nv_content: {
    label: "Nhân viên content",
    role: "Sản xuất nội dung, kịch bản và thông điệp chiến dịch.",
    note: "Tập trung vào tốc độ ra bài, tính đúng insight và tiêu chuẩn thương hiệu.",
  },
  nv_media: {
    label: "Nhân viên media",
    role: "Tạo asset hình ảnh, media và hỗ trợ creative execution.",
    note: "Đảm nhiệm phần visual, asset quảng bá và xuất bản đa định dạng.",
  },
  nv_consultant: {
    label: "Nhân viên tư vấn",
    role: "Hỗ trợ bán hàng, tư vấn và xử lý kịch bản chuyển đổi.",
    note: "Bám sát đầu vào khách hàng và tình trạng phản hồi.",
  },
};

function formatCount(value: number | null | undefined): string {
  return new Intl.NumberFormat("vi-VN").format(Math.max(0, Math.round(value ?? 0)));
}

function formatCurrency(value: number | null | undefined): string {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Math.max(0, value ?? 0));
}

function formatDateTime(value: number | null | undefined): string {
  if (!value) {
    return "Chưa có dữ liệu";
  }
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
}

function formatAgo(value: number | null | undefined): string {
  if (!value) {
    return "Chưa ghi nhận";
  }
  const diff = Date.now() - value;
  if (diff < 60_000) {
    return "Vừa xong";
  }
  if (diff < 3_600_000) {
    return `${Math.max(1, Math.round(diff / 60_000))} phút trước`;
  }
  if (diff < 86_400_000) {
    return `${Math.max(1, Math.round(diff / 3_600_000))} giờ trước`;
  }
  return `${Math.max(1, Math.round(diff / 86_400_000))} ngày trước`;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resolveAgentDisplay(agent: { id: string; name?: string; identity?: { name?: string } }) {
  const presentation = AGENT_PRESENTATION[agent.id];
  return {
    label: presentation?.label ?? agent.name?.trim() ?? agent.identity?.name?.trim() ?? agent.id,
    role: presentation?.role ?? "Thành viên trong quy trình marketing AI.",
    note: presentation?.note ?? "Đang sẵn sàng nhận việc và xử lý tác vụ runtime.",
  };
}

function resolveAgentUsage(agentId: string, usageResult: SessionsUsageResult | null) {
  const rows = usageResult?.sessions.filter((entry) => entry.agentId === agentId) ?? [];
  return rows.reduce(
    (acc, row) => {
      acc.tokens += row.usage?.totalTokens ?? 0;
      acc.cost += row.usage?.totalCost ?? 0;
      acc.messages += row.usage?.messageCounts?.total ?? 0;
      return acc;
    },
    { tokens: 0, cost: 0, messages: 0 },
  );
}

function resolveAgentStatus(
  agentId: string,
  sessionsResult: SessionsListResult | null,
  usageResult: SessionsUsageResult | null,
): { status: string; tone: "success" | "warn" | "muted"; note: string } {
  const sessions = sessionsResult?.sessions.filter((entry) => entry.agentId === agentId) ?? [];
  const recentSession = sessions
    .map((entry) => entry.updatedAt ?? 0)
    .sort((a, b) => b - a)[0];
  const usage = resolveAgentUsage(agentId, usageResult);

  if (recentSession && Date.now() - recentSession < 6 * 60 * 60 * 1000) {
    return {
      status: "Đang hoạt động",
      tone: "success",
      note: `Hoạt động gần nhất ${formatAgo(recentSession)}.`,
    };
  }
  if (usage.messages > 0 || sessions.length > 0) {
    return {
      status: "Có lịch sử xử lý",
      tone: "warn",
      note: `Đã ghi nhận ${formatCount(usage.messages)} lượt trao đổi.`,
    };
  }
  return {
    status: "Chờ khởi chạy",
    tone: "muted",
    note: "Chưa thấy phiên hoặc usage trong runtime hiện tại.",
  };
}

function buildExecutiveCards(props: OverviewProps): ExecutiveCard[] {
  const sourceAgents =
    props.agentsList?.agents ??
    props.healthResult?.agents.map((entry) => ({ id: entry.id, name: entry.name })) ??
    [];
  return sourceAgents.map((agent) => {
    const display = resolveAgentDisplay(agent);
    const status = resolveAgentStatus(agent.id, props.sessionsResult, props.usageResult);
    const usage = resolveAgentUsage(agent.id, props.usageResult);
    const sessions =
      props.sessionsResult?.sessions.filter((entry) => entry.agentId === agent.id).length ?? 0;
    return {
      id: agent.id,
      label: display.label,
      role: display.role,
      status: status.status,
      tone: status.tone,
      sessions,
      tokens: usage.tokens,
      cost: usage.cost,
      note: status.note || display.note,
    };
  });
}

function buildChannelCards(snapshot: ChannelsStatusSnapshot | null | undefined): ChannelCard[] {
  if (!snapshot) {
    return [];
  }
  const channelIds = snapshot.channelMeta?.length
    ? snapshot.channelMeta.map((entry) => entry.id)
    : snapshot.channelOrder;
  return channelIds.map((channelId) => {
    const accounts = snapshot.channelAccounts?.[channelId] ?? [];
    const connected = accounts.filter((entry) => entry.connected).length;
    const configured = accounts.filter((entry) => entry.configured).length;
    let tone: "success" | "warn" | "muted" = "muted";
    let summary = "Chưa cấu hình";
    if (connected > 0) {
      tone = "success";
      summary = `${connected}/${accounts.length || connected} tài khoản đang online`;
    } else if (configured > 0) {
      tone = "warn";
      summary = `${configured}/${accounts.length || configured} tài khoản đã cấu hình`;
    }
    return {
      id: channelId,
      label: snapshot.channelLabels?.[channelId] ?? channelId,
      summary,
      tone,
      connected,
      configured,
      total: accounts.length,
    };
  });
}

function buildRuntimeRows(
  props: OverviewProps,
): Array<{ label: string; value: string; hint?: string }> {
  const jobs = props.cronJobs ?? [];
  const failedJobs = jobs.filter(
    (job) => job.state?.lastRunStatus === "error" || job.state?.consecutiveErrors,
  ).length;
  const nextJob = jobs
    .filter((job) => typeof job.state?.nextRunAtMs === "number")
    .sort((a, b) => (a.state?.nextRunAtMs ?? 0) - (b.state?.nextRunAtMs ?? 0))[0];
  return [
    {
      label: "Gateway uptime",
      value:
        formatDurationHuman(
          ((props.hello?.snapshot as { uptimeMs?: number } | undefined)?.uptimeMs ?? 0) || 0,
        ) || "Chưa có dữ liệu",
      hint: props.connected ? "Gateway đang duy trì kết nối realtime." : "Gateway chưa kết nối.",
    },
    {
      label: "Lịch cron",
      value:
        props.cronStatus?.enabled === true
          ? `${formatCount(props.cronStatus.jobs)} job`
          : "Đang tắt",
      hint: nextJob?.state?.nextRunAtMs
        ? `Lần chạy gần nhất tiếp theo: ${formatDateTime(nextJob.state.nextRunAtMs)}`
        : "Chưa có lịch chạy kế tiếp.",
    },
    {
      label: "Cảnh báo cần xử lý",
      value: failedJobs > 0 ? `${failedJobs} job lỗi` : "Ổn định",
      hint:
        failedJobs > 0
          ? "Có job cron đang lỗi hoặc đang tăng số lần retry."
          : "Chưa phát hiện lỗi runtime đáng chú ý.",
    },
    {
      label: "Tệp session",
      value: props.healthResult?.sessions?.path ?? "Chưa nhận diện",
      hint:
        props.healthResult?.sessions?.count != null
          ? `${formatCount(props.healthResult.sessions.count)} session đang được theo dõi`
          : "Gateway chưa trả về vùng lưu session.",
    },
  ];
}

function renderLocaleSelect(props: OverviewProps, currentLocale: Locale) {
  return html`
    <label class="field">
      <span>${t("overview.access.language")}</span>
      <select
        .value=${currentLocale}
        @change=${(e: Event) => {
          const value = (e.target as HTMLSelectElement).value as Locale;
          void i18n.setLocale(value);
          props.onSettingsChange({ ...props.settings, locale: value });
        }}
      >
        ${SUPPORTED_LOCALES.map((locale) => {
          const key = locale.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
          return html`<option value=${locale} ?selected=${currentLocale === locale}>
            ${t(`languages.${key}`)}
          </option>`;
        })}
      </select>
    </label>
  `;
}

function renderExecutiveCards(cards: ExecutiveCard[]) {
  if (cards.length === 0) {
    return html`
      <div class="uptek-empty">
        Chưa có dữ liệu agent runtime. Hãy kết nối gateway để hệ thống dựng lại sơ đồ phòng
        marketing AI theo session và usage thật.
      </div>
    `;
  }

  const maxTokens = Math.max(...cards.map((entry) => entry.tokens), 1);
  return html`
    <div class="uptek-board-grid">
      ${cards.map(
        (entry) => html`
          <article class="uptek-persona-card">
            <div class="uptek-persona-card__title">${entry.label}</div>
            <div class="uptek-persona-card__role">${entry.role}</div>
            <div class="uptek-persona-card__status" data-tone=${entry.tone}>${entry.status}</div>
            <div class="uptek-persona-card__stats">
              <div class="uptek-mini-stat">
                <div class="uptek-mini-stat__label">Session</div>
                <div class="uptek-mini-stat__value">${formatCount(entry.sessions)}</div>
              </div>
              <div class="uptek-mini-stat">
                <div class="uptek-mini-stat__label">Token</div>
                <div class="uptek-mini-stat__value">${formatCount(entry.tokens)}</div>
              </div>
              <div class="uptek-mini-stat">
                <div class="uptek-mini-stat__label">Chi phí</div>
                <div class="uptek-mini-stat__value">${formatCurrency(entry.cost)}</div>
              </div>
            </div>
            <div class="uptek-bar"><span style=${`width:${clampPercent((entry.tokens / maxTokens) * 100)}%`}></span></div>
            <div class="uptek-list-note">${entry.note}</div>
          </article>
        `,
      )}
    </div>
  `;
}

function renderChannelCards(cards: ChannelCard[]) {
  if (cards.length === 0) {
    return html`
      <div class="uptek-empty">
        Chưa có snapshot kênh giao tiếp. Sau khi gateway online, phần này sẽ hiển thị Telegram,
        Discord, Slack và các kênh khác với trạng thái thật.
      </div>
    `;
  }
  const maxAccounts = Math.max(...cards.map((entry) => entry.total), 1);
  return html`
    <div class="uptek-channel-grid">
      ${cards.map(
        (entry) => html`
          <article class="uptek-runtime-card">
            <div class="uptek-runtime-card__title">${entry.label}</div>
            <div class="uptek-runtime-card__sub">${entry.summary}</div>
            <div class="uptek-runtime-card__row">
              <div class="uptek-runtime-card__label">Tài khoản hoạt động</div>
              <div class="uptek-runtime-card__value">${formatCount(entry.connected)}</div>
            </div>
            <div class="uptek-runtime-card__row">
              <div class="uptek-runtime-card__label">Đã cấu hình</div>
              <div class="uptek-runtime-card__value">${formatCount(entry.configured)}</div>
            </div>
            <div class="uptek-runtime-card__row">
              <div class="uptek-runtime-card__label">Tổng số account</div>
              <div class="uptek-runtime-card__value">${formatCount(entry.total)}</div>
            </div>
            <div class="uptek-bar">
              <span style=${`width:${clampPercent((entry.total / maxAccounts) * 100)}%`}></span>
            </div>
          </article>
        `,
      )}
    </div>
  `;
}

function renderAttentionCards(items: AttentionItem[]) {
  if (items.length === 0) {
    return html`
      <div class="uptek-empty">
        Không có cảnh báo trọng yếu. Dashboard đang ở trạng thái phù hợp để trình bày với ban
        điều hành.
      </div>
    `;
  }
  return html`
    <div class="uptek-feed-grid">
      ${items.slice(0, 6).map(
        (item) => html`
          <article class="uptek-attention-card">
            <div class="uptek-attention-card__title">${item.title}</div>
            <div class="uptek-attention-card__sub">${item.description}</div>
            <div class="uptek-list-note">
              Mức độ:
              ${item.severity === "error"
                ? "Khẩn cấp"
                : item.severity === "warning"
                  ? "Cần chú ý"
                  : "Thông tin"}
            </div>
            ${
              item.href
                ? html`
                    <div class="uptek-list-note">
                      <a
                        class="session-link"
                        href=${item.href}
                        target=${item.external ? EXTERNAL_LINK_TARGET : "_self"}
                        rel=${item.external ? buildExternalLinkRel() : nothing}
                      >
                        Mở chi tiết
                      </a>
                    </div>
                  `
                : nothing
            }
          </article>
        `,
      )}
    </div>
  `;
}

function renderFeed(eventLog: EventLogEntry[], overviewLogLines: string[]) {
  const events = [...eventLog].slice(-5).reverse();
  const lines = [...overviewLogLines].slice(-6).reverse();
  return html`
    <div class="uptek-feed-grid">
      <article class="uptek-feed-card">
        <div class="uptek-feed-card__title">Live events</div>
        <div class="uptek-feed-card__sub">Các sự kiện mới nhất từ gateway và control UI.</div>
        ${
          events.length > 0
            ? events.map(
                (entry) => html`
                  <div class="uptek-feed-card__row">
                    <div class="uptek-feed-card__label">${entry.event}</div>
                    <div class="uptek-feed-card__value">${formatAgo(entry.ts)}</div>
                  </div>
                `,
              )
            : html`<div class="uptek-empty">Chưa có sự kiện mới trong buffer hiện tại.</div>`
        }
      </article>

      <article class="uptek-feed-card">
        <div class="uptek-feed-card__title">Gateway logs</div>
        <div class="uptek-feed-card__sub">Nhật ký rút gọn để kiểm tra tín hiệu runtime thật.</div>
        ${
          lines.length > 0
            ? lines.map(
                (line) => html`
                  <div class="uptek-feed-card__row">
                    <div class="uptek-feed-card__label mono">${line}</div>
                    <div class="uptek-feed-card__value">log</div>
                  </div>
                `,
              )
            : html`<div class="uptek-empty">Chưa có log mới trong phiên dashboard này.</div>`
        }
      </article>
    </div>
  `;
}

export function renderOverview(props: OverviewProps) {
  const currentLocale = isSupportedLocale(props.settings.locale)
    ? props.settings.locale
    : i18n.getLocale();
  const executiveCards = buildExecutiveCards(props);
  const channelCards = buildChannelCards(props.channelsSnapshot);
  const runtimeRows = buildRuntimeRows(props);
  const uptimeMs = (props.hello?.snapshot as { uptimeMs?: number } | undefined)?.uptimeMs ?? null;
  const skillCount =
    props.skillsReport?.skills.filter((entry) => !entry.disabled && !entry.blockedByAllowlist)
      .length ?? 0;
  const healthSessions = props.healthResult?.sessions?.count ?? props.sessionsCount ?? 0;
  const totalAgents = executiveCards.length;
  const totalMessages = props.usageResult?.aggregates.messages.total ?? 0;
  const totalTokens = props.usageResult?.totals.totalTokens ?? 0;
  const totalCost = props.usageResult?.totals.totalCost ?? 0;
  const channelsOnline = channelCards.reduce((sum, entry) => sum + entry.connected, 0);
  const employeeName = props.bootstrapAccessPolicy?.employeeName?.trim() || "Ban điều hành";
  const lastUpdateAt =
    props.usageResult?.updatedAt ??
    props.lastChannelsRefresh ??
    props.healthResult?.ts ??
    props.eventLog.at(-1)?.ts ??
    null;

  return html`
    <section class="uptek-dashboard">
      <section class="uptek-hero">
        <article class="uptek-hero__main">
          <div class="uptek-chip-row">
            <span class="uptek-chip ${props.connected ? "uptek-chip--success" : "uptek-chip--warn"}">
              ${props.connected ? "Gateway đang online" : "Gateway đang chờ kết nối"}
            </span>
            <span class="uptek-chip">Tân Phát Etek · Marketing AI</span>
            <span class="uptek-chip">Operator: ${employeeName}</span>
          </div>

          <div class="uptek-eyebrow">Uptek Command Center</div>
          <div class="uptek-title">Dashboard điều hành marketing AI cho ban lãnh đạo</div>
          <div class="uptek-subtitle">
            Đây là lớp hiển thị quản trị dành cho sếp và quản lý: nhìn được toàn bộ luồng vận hành,
            nhân sự AI, hiệu suất runtime, kênh giao tiếp và các cảnh báo đang xảy ra trong
            OpenClaw của bạn.
          </div>

          <div class="uptek-meta-row">
            <div class="uptek-meta">
              <div class="uptek-meta__label">Phiên bản gateway</div>
              <div class="uptek-meta__value">
                ${props.hello?.server?.version ?? "Chưa handshake"}
              </div>
              <div class="uptek-meta__hint">Tự lấy từ phiên kết nối control UI hiện tại.</div>
            </div>
            <div class="uptek-meta">
              <div class="uptek-meta__label">Uptime</div>
              <div class="uptek-meta__value">
                ${uptimeMs ? formatDurationHuman(uptimeMs) : "Chưa có dữ liệu"}
              </div>
              <div class="uptek-meta__hint">Cho biết gateway đã chạy ổn định trong bao lâu.</div>
            </div>
            <div class="uptek-meta">
              <div class="uptek-meta__label">Lần cập nhật gần nhất</div>
              <div class="uptek-meta__value">${lastUpdateAt ? formatAgo(lastUpdateAt) : "Chưa có dữ liệu"}</div>
              <div class="uptek-meta__hint">
                ${lastUpdateAt ? formatDateTime(lastUpdateAt) : "Chờ dữ liệu runtime đầu tiên"}
              </div>
            </div>
          </div>

          <div class="uptek-action-row">
            <button class="btn primary" @click=${() => props.onRefresh()}>Làm mới toàn bộ</button>
            <button class="btn" @click=${() => props.onNavigate("agents")}>Mở sơ đồ agent</button>
            <button class="btn" @click=${() => props.onNavigate("usage")}>Xem hiệu suất</button>
            <button class="btn" @click=${() => props.onNavigate("cron")}>Kiểm tra cron</button>
          </div>
        </article>

        <article class="uptek-hero__side">
          <div class="uptek-section__header">
            <div>
              <div class="uptek-section__title">Bảng tóm tắt điều hành</div>
              <div class="uptek-section__sub">
                Thể hiện đúng dữ liệu runtime lấy từ gateway, session, usage, channel và cron.
              </div>
            </div>
            <span class="uptek-pill">${props.settings.gatewayUrl || "ws://uptek.vn:19001"}</span>
          </div>
          ${runtimeRows.map(
            (entry) => html`
              <div class="uptek-runtime-card__row">
                <div>
                  <div class="uptek-runtime-card__label">${entry.label}</div>
                  ${entry.hint ? html`<div class="uptek-runtime-card__sub">${entry.hint}</div>` : nothing}
                </div>
                <div class="uptek-runtime-card__value">${entry.value}</div>
              </div>
            `,
          )}
          <div class="uptek-list-note">
            Domain local đang dùng: <strong>uptek.vn</strong>. Nếu cần trình diễn cho nội bộ, chỉ
            cần mở dashboard qua alias local này thay vì <code>localhost</code>.
          </div>
        </article>
      </section>

      <section class="uptek-kpi-grid">
        <article class="uptek-kpi">
          <div class="uptek-kpi__label">Nhân sự AI đang hiển thị</div>
          <div class="uptek-kpi__value">${formatCount(totalAgents)}</div>
          <div class="uptek-kpi__hint">Toàn bộ cấp quản lý và nhân viên AI trong pipeline marketing.</div>
        </article>
        <article class="uptek-kpi">
          <div class="uptek-kpi__label">Session runtime</div>
          <div class="uptek-kpi__value">${formatCount(healthSessions)}</div>
          <div class="uptek-kpi__hint">Được đọc trực tiếp từ gateway health và sessions list.</div>
        </article>
        <article class="uptek-kpi">
          <div class="uptek-kpi__label">Lượt trao đổi</div>
          <div class="uptek-kpi__value">${formatCount(totalMessages)}</div>
          <div class="uptek-kpi__hint">Tổng message và tool activity đã ghi nhận trong usage.</div>
        </article>
        <article class="uptek-kpi">
          <div class="uptek-kpi__label">Token / chi phí</div>
          <div class="uptek-kpi__value">${formatCount(totalTokens)}</div>
          <div class="uptek-kpi__hint">${formatCurrency(totalCost)} tổng chi phí runtime hiện có.</div>
        </article>
        <article class="uptek-kpi">
          <div class="uptek-kpi__label">Kênh online</div>
          <div class="uptek-kpi__value">${formatCount(channelsOnline)}</div>
          <div class="uptek-kpi__hint">Số account kênh đang kết nối realtime.</div>
        </article>
        <article class="uptek-kpi">
          <div class="uptek-kpi__label">Kỹ năng sẵn sàng</div>
          <div class="uptek-kpi__value">${formatCount(skillCount)}</div>
          <div class="uptek-kpi__hint">Skill runtime không bị chặn và không bị disable.</div>
        </article>
      </section>

      <section class="uptek-section">
        <div class="uptek-section__header">
          <div>
            <div class="uptek-section__title">Sơ đồ vận hành phòng marketing AI</div>
            <div class="uptek-section__sub">
              Từng card đại diện một agent trong quy trình thực tế của bạn, gắn với session và usage
              đang chạy ngay lúc này.
            </div>
          </div>
          <span class="uptek-pill">${formatCount(totalAgents)} agent</span>
        </div>
        ${renderExecutiveCards(executiveCards)}
      </section>

      <section class="uptek-section">
        <div class="uptek-section__header">
          <div>
            <div class="uptek-section__title">Kênh giao tiếp và runtime operations</div>
            <div class="uptek-section__sub">
              Theo dõi kết nối, cấu hình và độ sẵn sàng của các kênh mà ban điều hành cần nhìn thấy.
            </div>
          </div>
          <span class="uptek-pill">${formatCount(channelCards.length)} channel</span>
        </div>
        ${renderChannelCards(channelCards)}
      </section>

      <section class="uptek-section">
        <div class="uptek-section__header">
          <div>
            <div class="uptek-section__title">Điểm chú ý cho quản lý</div>
            <div class="uptek-section__sub">
              Những tín hiệu cần can thiệp ngay, lấy từ gateway attention, skill state và lỗi kết nối.
            </div>
          </div>
          <span class="uptek-pill">${formatCount(props.attentionItems.length)} cảnh báo</span>
        </div>
        ${renderAttentionCards(props.attentionItems)}
      </section>

      <section class="uptek-section">
        <div class="uptek-section__header">
          <div>
            <div class="uptek-section__title">Nhật ký điều hành trực tiếp</div>
            <div class="uptek-section__sub">
              Vùng này cho sếp thấy ngay tín hiệu đang đi qua hệ thống, phù hợp để demo năng lực vận hành.
            </div>
          </div>
          <button class="btn" @click=${() => props.onRefreshLogs()}>Tải log mới</button>
        </div>
        ${renderFeed(props.eventLog, props.overviewLogLines)}
      </section>

      <section class="uptek-section">
        <div class="uptek-section__header">
          <div>
            <div class="uptek-section__title">Quản trị truy cập dashboard</div>
            <div class="uptek-section__sub">
              Dành cho quản trị viên thay đổi kết nối, locale và session mặc định mà không rời dashboard.
            </div>
          </div>
          <span class="uptek-pill">${props.connected ? "Đã kết nối" : "Chưa kết nối"}</span>
        </div>

        <div class="uptek-form-grid">
          <label class="field">
            <span>${t("overview.access.wsUrl")}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const value = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, gatewayUrl: value });
              }}
              placeholder="ws://uptek.vn:19001"
            />
          </label>

          <label class="field">
            <span>${t("overview.access.token")}</span>
            <input
              type=${props.showGatewayToken ? "text" : "password"}
              .value=${props.settings.token}
              @input=${(e: Event) => {
                const value = (e.target as HTMLInputElement).value;
                props.onSettingsChange({ ...props.settings, token: value });
              }}
              placeholder="OPENCLAW_GATEWAY_TOKEN"
            />
          </label>

          <label class="field">
            <span>${t("overview.access.password")}</span>
            <input
              type=${props.showGatewayPassword ? "text" : "password"}
              .value=${props.password}
              @input=${(e: Event) => {
                props.onPasswordChange((e.target as HTMLInputElement).value);
              }}
              placeholder="Mật khẩu hệ thống"
            />
          </label>

          <label class="field">
            <span>${t("overview.access.sessionKey")}</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                props.onSessionKeyChange((e.target as HTMLInputElement).value);
              }}
              placeholder="agent:main:main"
            />
          </label>

          ${renderLocaleSelect(props, currentLocale)}
        </div>

        <div class="uptek-form-actions">
          <button class="btn primary" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
        </div>

        ${
          props.lastError
            ? html`<div class="uptek-empty" style="margin-top:16px;">${props.lastError}</div>`
            : nothing
        }

        ${
          !props.connected
            ? html`
                <div class="uptek-list-note" style="margin-top:16px;">
                  1. Chạy <code>openclaw gateway run</code><br />
                  2. Mở dashboard bằng <code>openclaw dashboard --no-open</code><br />
                  3. Truy cập qua <code>http://uptek.vn:19001/overview</code> hoặc dùng trực tiếp
                  WebSocket ở trên.<br />
                  4. Tài liệu:
                  <a
                    class="session-link"
                    href="https://docs.openclaw.ai/web/dashboard"
                    target=${EXTERNAL_LINK_TARGET}
                    rel=${buildExternalLinkRel()}
                  >
                    ${t("overview.connection.docsLink")}
                  </a>
                </div>
              `
            : nothing
        }
      </section>
    </section>
  `;
}
