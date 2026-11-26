const DEFAULT_SETTINGS = {
  enabled: true,
  lastPunchDate: null,
  lastPunchTime: null,
  lastStatus: "待機中"
};

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function render() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const today = getTodayString();

  const enabledToggle = document.getElementById("enabledToggle");
  const todayBadge = document.getElementById("todayBadge");
  const statusText = document.getElementById("statusText");
  const lastPunchText = document.getElementById("lastPunchText");

  enabledToggle.checked = Boolean(data.enabled);
  statusText.textContent = data.lastStatus || "待機中";

  if (!data.enabled) {
    todayBadge.textContent = "停止中";
    todayBadge.className = "badge badge-off";
  } else if (data.lastPunchDate === today) {
    todayBadge.textContent = "本日打刻済";
    todayBadge.className = "badge badge-done";
  } else {
    todayBadge.textContent = "未打刻";
    todayBadge.className = "badge badge-pending";
  }

  if (data.lastPunchDate) {
    lastPunchText.textContent = `最終打刻: ${data.lastPunchDate} ${data.lastPunchTime || ""}`;
  } else {
    lastPunchText.textContent = "最終打刻: なし";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  render();

  document.getElementById("enabledToggle").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ enabled: e.target.checked });
    await chrome.runtime.sendMessage({ type: "UPDATE_BADGE" });
    await render();
  });

  document.getElementById("runNowBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "RUN_NOW" });
    window.close();
  });

  document.getElementById("punchOutBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "PUNCH_OUT" });
    window.close();
  });
});

chrome.storage.onChanged.addListener(() => {
  render();
});
