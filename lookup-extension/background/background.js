// Background: minimal — opens the side panel (Chrome) / sidebar (Firefox)
// when the toolbar icon is clicked. All FCLM fetches and parsing happen in
// the sidebar page itself, which has DOMParser and (with host_permissions)
// the ability to fetch fclm-portal.amazon.com with cookies.

const api = typeof browser !== 'undefined' ? browser : chrome;

if (api.sidePanel?.setPanelBehavior) {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

api.action?.onClicked?.addListener(async (tab) => {
  if (api.sidebarAction?.open) {
    try { await api.sidebarAction.open(); } catch (_) {}
  } else if (api.sidePanel?.open) {
    try { await api.sidePanel.open({ tabId: tab.id }); } catch (_) {}
  }
});
