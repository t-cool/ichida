const TARGET_URL = "https://nara-ta.ddrive.site/teacher_attendance/";
const PUNCH_IN_BUTTON_ID = "btn_punchin";
const PUNCH_OUT_BUTTON_ID = "btn_punchout";
const HISTORY_CLOSE_BUTTON_ID = "btn_history_close";
const START_HOUR = 2; // 朝2時以降を「その日の朝」として扱う
const IP_CHECK_ENDPOINTS = [
  { url: "https://cloudflare.com/cdn-cgi/trace", type: "trace" },
  { url: "https://checkip.amazonaws.com/", type: "text" },
  { url: "https://api.ipify.org?format=json", type: "json" },
  { url: "https://1.1.1.1/cdn-cgi/trace", type: "trace" }
];
const IP_CACHE_TTL_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  ipFilterEnabled: false,
  allowedGlobalIp: "",
  lastPunchDate: null,
  lastPunchTime: null,
  lastStatus: "待機中"
};

/**
 * URLが勤怠打刻ページかどうかを判定する
 */
function isTargetAttendanceUrl(url) {
  if (!url) return false;
  return url.startsWith(TARGET_URL) || url === TARGET_URL.replace(/\/$/, "");
}

/**
 * ローカルタイムゾーンで YYYY-MM-DD を返す
 */
function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * ローカルタイムゾーンで HH:MM:SS を返す
 */
function getCurrentTimeString() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * 設定と状態を取得する
 */
async function getSettings() {
  const data = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...data };
}

/**
 * 拡張機能アイコンのバッジを更新する
 */
async function updateBadge() {
  const settings = await getSettings();
  const today = getTodayString();

  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#9e9e9e" });
  } else if (settings.lastPunchDate === today) {
    await chrome.action.setBadgeText({ text: "済" });
    await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

/**
 * 許可するグローバルIPの文字列を配列に分解する（カンマ・空白区切り対応）
 */
function parseAllowedIps(raw) {
  return String(raw || "")
    .split(/[\s,、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * エンドポイントのレスポンスからIP文字列を取り出す
 */
async function extractIpFromResponse(res, type) {
  if (type === "json") {
    const data = await res.json();
    return typeof data?.ip === "string" ? data.ip.trim() : "";
  }
  const text = await res.text();
  if (type === "trace") {
    const match = text.match(/^ip=(.+)$/m);
    return match ? match[1].trim() : "";
  }
  return text.trim();
}

/**
 * 現在のグローバルIPを取得する（自動判定時は短時間キャッシュを使用）
 * @param {boolean} useCache
 * @returns {Promise<{ ip: string | null, error?: string }>}
 */
async function fetchCurrentGlobalIpWithDetail(useCache = true) {
  if (useCache) {
    const cached = await chrome.storage.session.get([
      "cachedGlobalIp",
      "cachedGlobalIpAt"
    ]);
    if (
      cached.cachedGlobalIp &&
      cached.cachedGlobalIpAt &&
      Date.now() - cached.cachedGlobalIpAt < IP_CACHE_TTL_MS
    ) {
      return { ip: cached.cachedGlobalIp };
    }
  }

  const errors = [];
  for (const endpoint of IP_CHECK_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(endpoint.url, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!res.ok) {
        errors.push(`${new URL(endpoint.url).hostname}: HTTP ${res.status}`);
        continue;
      }
      const ip = await extractIpFromResponse(res, endpoint.type);
      if (ip) {
        await chrome.storage.session.set({
          cachedGlobalIp: ip,
          cachedGlobalIpAt: Date.now()
        });
        return { ip };
      }
      errors.push(`${new URL(endpoint.url).hostname}: IPが空でした`);
    } catch (err) {
      errors.push(`${new URL(endpoint.url).hostname}: ${err.message || err.name}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ip: null, error: errors.join(" / ") };
}

/**
 * 現在のグローバルIPを取得する（文字列のみ返すラッパー）
 * @param {boolean} useCache
 * @returns {Promise<string | null>}
 */
async function fetchCurrentGlobalIp(useCache = true) {
  const result = await fetchCurrentGlobalIpWithDetail(useCache);
  return result.ip;
}

let isCreatingTab = false;

/**
 * 打刻用のタブを開く共通処理
 * @param {"punchin" | "punchout"} actionType
 * @param {boolean} force - 手動実行時は true
 */
async function tryTriggerPunch(actionType, force = false) {
  if (isCreatingTab) {
    return { triggered: false, reason: "打刻処理を起動中です" };
  }
  isCreatingTab = true;

  try {
    if (actionType === "punchin" && !force) {
      const settings = await getSettings();
      const today = getTodayString();
      const currentHour = new Date().getHours();

      if (!settings.enabled) {
        return { triggered: false, reason: "自動打刻が無効です" };
      }
      if (currentHour < START_HOUR) {
        return {
          triggered: false,
          reason: `開始時刻（${START_HOUR}:00）前のため待機中`
        };
      }
      if (settings.lastPunchDate === today) {
        return { triggered: false, reason: "本日はすでに打刻済みです" };
      }

      if (settings.ipFilterEnabled) {
        const allowedIps = parseAllowedIps(settings.allowedGlobalIp);
        if (allowedIps.length === 0) {
          const reason = "学校のグローバルIPが未設定のため自動打刻を待機中";
          await chrome.storage.local.set({ lastStatus: reason });
          return { triggered: false, reason };
        }

        const currentIp = await fetchCurrentGlobalIp(true);
        if (!currentIp) {
          const reason = "グローバルIPの取得に失敗したため自動打刻を待機中";
          await chrome.storage.local.set({ lastStatus: reason });
          return { triggered: false, reason };
        }

        if (!allowedIps.includes(currentIp)) {
          const reason = `指定IP外（現在: ${currentIp}）のため自動打刻をスキップ`;
          await chrome.storage.local.set({ lastStatus: reason });
          return { triggered: false, reason };
        }
      }
    }

    // 二重起動防止（処理中のタブが既にあるか確認）
    const session = await chrome.storage.session.get([
      "pendingTabId",
      "pendingTimestamp"
    ]);
    const nowMs = Date.now();
    if (
      session.pendingTabId &&
      session.pendingTimestamp &&
      nowMs - session.pendingTimestamp < 60000
    ) {
      try {
        await chrome.tabs.get(session.pendingTabId);
        return { triggered: false, reason: "打刻処理を実行中です" };
      } catch {
        // タブが既に閉じられていた場合は続行
      }
    }

    // 現在のタブがすでに勤怠ページなら新規タブを開かずそのまま打刻する
    const [activeTab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    if (activeTab?.id && isTargetAttendanceUrl(activeTab.url)) {
      const actionLabel = actionType === "punchout" ? "退勤" : "出勤";
      if (activeTab.status === "complete") {
        await chrome.storage.local.set({
          lastStatus: `現在のタブで${actionLabel}打刻を実行しています...`
        });
        executePunchInTab(activeTab.id, actionType);
        return { triggered: true, tabId: activeTab.id, reusedTab: true };
      }

      await chrome.storage.session.set({
        pendingTabId: activeTab.id,
        pendingTimestamp: Date.now(),
        pendingForce: force,
        pendingAction: actionType
      });

      await chrome.storage.local.set({
        lastStatus: "現在のタブの読み込み完了を待っています..."
      });

      return { triggered: true, tabId: activeTab.id, reusedTab: true };
    }

    const tab = await chrome.tabs.create({
      url: TARGET_URL,
      active: true
    });

    await chrome.storage.session.set({
      pendingTabId: tab.id,
      pendingTimestamp: Date.now(),
      pendingForce: force,
      pendingAction: actionType
    });

    await chrome.storage.local.set({
      lastStatus:
        actionType === "punchout"
          ? "退勤打刻ページを開いています..."
          : "打刻ページを開いています..."
    });

    return { triggered: true, tabId: tab.id };
  } finally {
    isCreatingTab = false;
  }
}

/**
 * 本日の出勤打刻処理を実行すべきか判定し、必要ならタブを開く
 * @param {boolean} force - 手動テスト実行時は true
 */
async function tryTriggerPunchIn(force = false) {
  return tryTriggerPunch("punchin", force);
}

/**
 * 退勤打刻処理を実行するためタブを開く
 */
async function tryTriggerPunchOut() {
  return tryTriggerPunch("punchout", true);
}

/**
 * ページ内で実行される関数：履歴画面が開いている場合は閉じてから指定IDのボタンを探してクリックする
 * すでに disabled="" になっている場合は「すでに打刻済み」として扱う
 */
function clickPunchButtonInPage(
  buttonId,
  actionLabel,
  timeoutMs,
  historyCloseButtonId
) {
  return new Promise((resolve) => {
    let finished = false;
    let disabledDetectedTimer = null;
    let historyCloseClicked = false;

    const isElementVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const finish = (result) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timerId);
      clearTimeout(disabledDetectedTimer);
      resolve(result);
    };

    const checkButton = () => {
      const historyCloseBtn = historyCloseButtonId
        ? document.getElementById(historyCloseButtonId)
        : null;
      if (isElementVisible(historyCloseBtn)) {
        if (!historyCloseClicked) {
          historyCloseClicked = true;
          historyCloseBtn.click();
        }
        return;
      }

      const btn = document.getElementById(buttonId);
      if (!btn) return;

      if (!btn.disabled) {
        btn.click();
        finish({
          success: true,
          alreadyPunched: false,
          message: `${actionLabel}ボタンをクリックしました`
        });
        return;
      }

      // ボタンが disabled の場合、初期読み込み中の一時的な無効化の可能性を考慮して
      // 3秒待っても disabled のままなら「すでに打刻済み」と判定する
      if (!disabledDetectedTimer) {
        disabledDetectedTimer = setTimeout(() => {
          const currentBtn = document.getElementById(buttonId);
          if (currentBtn && currentBtn.disabled) {
            finish({
              success: true,
              alreadyPunched: true,
              message: "すでに打刻済み（ボタンが無効化済み）でした"
            });
          }
        }, 3000);
      }
    };

    const observer = new MutationObserver(checkButton);
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "style", "class", "hidden"]
      });
    }

    const intervalId = setInterval(checkButton, 500);

    const timerId = setTimeout(() => {
      const btn = document.getElementById(buttonId);
      if (btn && btn.disabled) {
        finish({
          success: true,
          alreadyPunched: true,
          message: "すでに打刻済み（ボタンが無効化済み）でした"
        });
      } else {
        finish({
          success: false,
          reason: `ボタン（#${buttonId}）が見つかりませんでした（未ログインの可能性があります）`
        });
      }
    }, timeoutMs);

    checkButton();
  });
}

/**
 * 指定タブ内で出勤/退勤ボタンのクリックを実行し、結果を保存する
 * @param {number} tabId
 * @param {"punchin" | "punchout"} actionType
 */
async function executePunchInTab(tabId, actionType) {
  const isPunchOut = actionType === "punchout";
  const buttonId = isPunchOut ? PUNCH_OUT_BUTTON_ID : PUNCH_IN_BUTTON_ID;
  const actionLabel = isPunchOut ? "退勤" : "出勤";

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickPunchButtonInPage,
      args: [buttonId, actionLabel, 15000, HISTORY_CLOSE_BUTTON_ID]
    });

    const outcome = results?.[0]?.result;
    if (outcome?.success) {
      const today = getTodayString();
      const time = getCurrentTimeString();
      const statusMessage = outcome.alreadyPunched
        ? `${today} ${time} 確認：すでに${actionLabel}打刻済みでした`
        : `${today} ${time} に${actionLabel}ボタンをクリックしました`;

      if (isPunchOut) {
        await chrome.storage.local.set({
          lastStatus: statusMessage
        });
      } else {
        await chrome.storage.local.set({
          lastPunchDate: today,
          lastPunchTime: time,
          lastStatus: statusMessage
        });
        await updateBadge();
      }
    } else {
      await chrome.storage.local.set({
        lastStatus: `失敗: ${outcome?.reason || "不明なエラー"}`
      });
    }
  } catch (err) {
    await chrome.storage.local.set({
      lastStatus: `エラー: ${err.message}`
    });
  }
}

/**
 * 対象タブの読み込み完了を検知してボタンをクリックする
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  const session = await chrome.storage.session.get([
    "pendingTabId",
    "pendingForce",
    "pendingAction"
  ]);
  if (session.pendingTabId !== tabId) return;

  // 対象URLに到達していない場合（ログイン画面へリダイレクト中など）はそのまま待機
  if (!isTargetAttendanceUrl(tab.url)) {
    await chrome.storage.local.set({
      lastStatus: "ログイン画面等を表示中（対象ページへの遷移を待機しています）"
    });
    return;
  }

  const actionType = session.pendingAction || "punchin";

  // 多重実行を防ぐため先に pendingTabId をクリア
  await chrome.storage.session.remove([
    "pendingTabId",
    "pendingTimestamp",
    "pendingForce",
    "pendingAction"
  ]);

  await executePunchInTab(tabId, actionType);
});

/**
 * 処理中のタブが閉じられた場合はロックを解除する
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await chrome.storage.session.get(["pendingTabId"]);
  if (session.pendingTabId === tabId) {
    await chrome.storage.session.remove([
      "pendingTabId",
      "pendingTimestamp",
      "pendingForce",
      "pendingAction"
    ]);
  }
});

// 1. PCログイン後、Chrome初回起動時
chrome.runtime.onStartup.addListener(async () => {
  await updateBadge();
  await tryTriggerPunchIn(false);
});

// 2. スリープ復帰・画面ロック解除時（Macをシャットダウンせずスリープ運用する場合に有効）
chrome.idle.onStateChanged.addListener(async (newState) => {
  if (newState === "active") {
    await updateBadge();
    await tryTriggerPunchIn(false);
  }
});

// 3. Chromeウィンドウがフォーカスされた時（夜間Chromeを開きっぱなしにしていた場合のフォールバック）
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    await updateBadge();
    await tryTriggerPunchIn(false);
  }
});

// インストール・更新時の初期化
chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const merged = { ...DEFAULT_SETTINGS, ...current };
  await chrome.storage.local.set(merged);
  await chrome.storage.local.remove("startHour");
  await updateBadge();
});

// ポップアップからのメッセージ処理
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "RUN_NOW") {
        const res = await tryTriggerPunchIn(true);
        sendResponse(res);
      } else if (message.type === "PUNCH_OUT") {
        const res = await tryTriggerPunchOut();
        sendResponse(res);
      } else if (message.type === "UPDATE_BADGE") {
        await updateBadge();
        sendResponse({ ok: true });
      } else if (message.type === "GET_CURRENT_IP") {
        const result = await fetchCurrentGlobalIpWithDetail(false);
        if (result.ip) {
          sendResponse({ ok: true, ip: result.ip });
        } else {
          sendResponse({
            ok: false,
            error: `グローバルIPの取得に失敗しました（${result.error || "ネットワーク接続を確認してください"}）`
          });
        }
      } else {
        sendResponse({ ok: false, error: "不明なリクエストです" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || "内部エラーが発生しました" });
    }
  })();
  return true;
});
