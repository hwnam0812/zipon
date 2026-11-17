// Streamlit v2 calls the renderer again for new data, but cleans up only on unmount.
// Keep one reader and one app instance for the lifetime of this DOM root.
export default function renderZipon(component) {
  document.documentElement.lang = "ko";
  const { parentElement, data, setTriggerValue } = component;
  let root = parentElement.querySelector("[data-zipon-root]");
  if (!root) { root = document.createElement("div"); root.dataset.ziponRoot = ""; parentElement.appendChild(root); }
  const emit = request => setTriggerValue("request", request);
  if (!root.ziponApp) root.ziponApp = new ZiponApp(root, { Chart: globalThis.Chart, data, emit });
  else root.ziponApp.update(data, emit);
  return () => { const app = root.ziponApp; delete root.ziponApp; void app?.destroy(); };
}
