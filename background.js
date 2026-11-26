const TARGET_URL = "https://nara-ta.ddrive.site/teacher_attendance/";
const PUNCH_IN_BUTTON_ID = "btn_punchin";
const PUNCH_OUT_BUTTON_ID = "btn_punchout";
const START_HOUR = 2; // 朝2時以降を「その日の朝」として扱う

const DEFAULT_SETTINGS = {
  enabled: true,
  lastPunchDate: null,
  lastPunchTime: null,
  lastStatus: "待機中"
};

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
 * ページ内で実行される関数：指定IDのボタンを探してクリックする
 * すでに disabled="" になっている場合は「すでに打刻済み」として扱う
 */
function clickPunchButtonInPage(buttonId, actionLabel, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    let disabledDetectedTimer = null;

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
        attributeFilter: ["disabled"]
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
  if (!tab.url || !tab.url.startsWith(TARGET_URL)) {
    await chrome.storage.local.set({
      lastStatus: "ログイン画面等を表示中（対象ページへの遷移を待機しています）"
    });
    return;
  }

  const actionType = session.pendingAction || "punchin";
  const isPunchOut = actionType === "punchout";
  const buttonId = isPunchOut ? PUNCH_OUT_BUTTON_ID : PUNCH_IN_BUTTON_ID;
  const actionLabel = isPunchOut ? "退勤" : "出勤";

  // 多重実行を防ぐため先に pendingTabId をクリア
  await chrome.storage.session.remove([
    "pendingTabId",
    "pendingTimestamp",
    "pendingForce",
    "pendingAction"
  ]);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: clickPunchButtonInPage,
      args: [buttonId, actionLabel, 15000]
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
    if (message.type === "RUN_NOW") {
      const res = await tryTriggerPunchIn(true);
      sendResponse(res);
    } else if (message.type === "PUNCH_OUT") {
      const res = await tryTriggerPunchOut();
      sendResponse(res);
    } else if (message.type === "UPDATE_BADGE") {
      await updateBadge();
      sendResponse({ ok: true });
    }
  })();
  return true;
});
