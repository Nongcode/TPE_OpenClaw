import { html } from "lit";
import { icons } from "../icons.ts";
import type { Tab } from "../navigation.ts";

export type BottomTabsProps = {
  activeTab: Tab;
  visibleTabs?: Tab[];
  onTabChange: (tab: Tab) => void;
};

const BOTTOM_TABS: Array<{ id: Tab; label: string; icon: keyof typeof icons }> = [
  { id: "overview", label: "Dashboard", icon: "barChart" },
  { id: "chat", label: "Chat", icon: "messageSquare" },
  { id: "sessions", label: "Sessions", icon: "fileText" },
  { id: "config", label: "Settings", icon: "settings" },
];

export function renderBottomTabs(props: BottomTabsProps) {
  const visibleTabs = new Set(props.visibleTabs ?? BOTTOM_TABS.map((tab) => tab.id));
  return html`
    <nav class="bottom-tabs">
      ${BOTTOM_TABS.filter((tab) => visibleTabs.has(tab.id)).map(
        (tab) => html`
          <button
            class="bottom-tab ${props.activeTab === tab.id ? "bottom-tab--active" : ""}"
            @click=${() => props.onTabChange(tab.id)}
          >
            <span class="bottom-tab__icon">${icons[tab.icon]}</span>
            <span class="bottom-tab__label">${tab.label}</span>
          </button>
        `,
      )}
    </nav>
  `;
}
