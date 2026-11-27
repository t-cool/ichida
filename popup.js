const DEFAULT_SETTINGS = {
  enabled: true,
  ipFilterEnabled: false,
  allowedGlobalIp: "",
  lastPunchDate: null,
  lastPunchTime: null,
  lastStatus: "待機中"
};

const DEFAULT_IP_HINT = "カンマ区切りで複数IPも指定できます";

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isValidIpAddress(ip) {
  // IPv4
  const ipv4Parts = ip.split(".");
  if (ipv4Parts.length === 4) {
    return ipv4Parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const num = Number(part);
      return num >= 0 && num <= 255;
    });
  }
  // IPv6（簡易判定）
  if (ip.includes(":")) {
    return /^[0-9a-fA-F:]+$/.test(ip);
  }
  return false;
}

function parseIpList(raw) {
  return String(raw || "")
    .split(/[\s,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function setIpHint(text, type = "") {
  const ipHintText = document.getElementById("ipHintText");
  ipHintText.textContent = text;
  ipHintText.className = type ? `meta-text hint-${type}` : "meta-text";
}

async function render() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);

  const runNowBtn = document.getElementById("runNowBtn");
  const enabledToggle = document.getElementById("enabledToggle");
  const ipFilterToggle = document.getElementById("ipFilterToggle");
  const ipConfigArea = document.getElementById("ipConfigArea");
  const allowedIpInput = document.getElementById("allowedIpInput");
  const statusText = document.getElementById("statusText");
  const lastPunchText = document.getElementById("lastPunchText");

  const isPunchedToday = data.lastPunchDate === getTodayString();
  runNowBtn.classList.toggle("is-punched", isPunchedToday);

  enabledToggle.checked = Boolean(data.enabled);
  ipFilterToggle.checked = Boolean(data.ipFilterEnabled);
  ipConfigArea.classList.toggle("is-disabled", !data.ipFilterEnabled);
  if (document.activeElement !== allowedIpInput) {
    allowedIpInput.value = data.allowedGlobalIp || "";
  }
  statusText.textContent = data.lastStatus || "待機中";

  if (data.lastPunchDate) {
    lastPunchText.textContent = `最終打刻: ${data.lastPunchDate} ${data.lastPunchTime || ""}`;
  } else {
    lastPunchText.textContent = "最終打刻: なし";
  }
}

async function saveAllowedIp() {
  const allowedIpInput = document.getElementById("allowedIpInput");
  const ips = parseIpList(allowedIpInput.value);

  const invalidIps = ips.filter((ip) => !isValidIpAddress(ip));
  if (invalidIps.length > 0) {
    setIpHint(`IPアドレスの形式が正しくありません: ${invalidIps[0]}`, "error");
    return false;
  }

  const normalized = ips.join(", ");
  allowedIpInput.value = normalized;
  await chrome.storage.local.set({ allowedGlobalIp: normalized });
  setIpHint(normalized ? "グローバルIPを保存しました" : "グローバルIPをクリアしました", "success");
  return true;
}

document.addEventListener("DOMContentLoaded", () => {
  render();

  document.getElementById("enabledToggle").addEventListener("change", async (e) => {
    await chrome.storage.local.set({ enabled: e.target.checked });
    await chrome.runtime.sendMessage({ type: "UPDATE_BADGE" });
    await render();
  });

  document.getElementById("ipFilterToggle").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.local.set({ ipFilterEnabled: enabled });
    if (enabled && parseIpList(document.getElementById("allowedIpInput").value).length === 0) {
      setIpHint("学校のグローバルIPを入力して保存してください", "error");
    } else {
      setIpHint(DEFAULT_IP_HINT);
    }
    await render();
  });

  document.getElementById("saveIpBtn").addEventListener("click", async () => {
    await saveAllowedIp();
  });

  document.getElementById("allowedIpInput").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await saveAllowedIp();
    }
  });

  document.getElementById("fetchIpBtn").addEventListener("click", async () => {
    const fetchBtn = document.getElementById("fetchIpBtn");
    const allowedIpInput = document.getElementById("allowedIpInput");
    fetchBtn.disabled = true;
    fetchBtn.textContent = "取得中...";
    setIpHint("現在のグローバルIPを取得しています...");

    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_CURRENT_IP" });
      if (res?.ok && res.ip) {
        allowedIpInput.value = res.ip;
        await chrome.storage.local.set({ allowedGlobalIp: res.ip });
        setIpHint(`現在のIP（${res.ip}）を取得して保存しました`, "success");
      } else if (!res) {
        setIpHint("応答がありません。chrome://extensions で拡張機能を再読み込みしてください", "error");
      } else {
        setIpHint(res.error || "グローバルIPの取得に失敗しました", "error");
      }
    } catch (err) {
      setIpHint(`取得エラー: ${err?.message || "拡張機能を再読み込みしてください"}`, "error");
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = "現在のIPを取得";
    }
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
