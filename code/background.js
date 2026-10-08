const DEFAULT_SETTINGS = {
  sites: [
    {
      domain: "youtube.com",
      label: "YouTube",
      enabled: true,
      limit: 60,
      focus: false
    },
    {
      domain: "instagram.com",
      label: "Instagram",
      enabled: true,
      limit: 45,
      focus: false
    },
    {
      domain: "reddit.com",
      label: "Reddit",
      enabled: true,
      limit: 45,
      focus: false
    },
    {
      domain: "x.com",
      label: "X",
      enabled: true,
      limit: 30,
      focus: false
    }
  ],

  notifications: true,
  notification80: true,
  notification100: true,

  focusMessage: "Do you really want to open this site right now?"
};


// Alarm used to periodically save elapsed time.
const ALARM_NAME = "timelens-minute";

// One day in milliseconds.
const DAY = 86400000;


// ============================================================
// 2. RUNTIME STATE
// ============================================================
//
// This state only exists while the service worker is alive.
//
// Persistent usage data is NOT kept here.
// Persistent data lives in chrome.storage.local.
//
// The important persistent object is:
//
// session: {
//   tabId,
//   windowId,
//   domain,
//   startedAt
// }
//
// The session allows us to continue tracking after the MV3
// service worker goes to sleep and wakes up again.
//

let runtime = {
  focused: false,
  locked: false
};


// Chrome events can happen very quickly one after another.
//
// Example:
//   tab changes
//   window changes
//   alarm fires
//
// Using a promise queue prevents multiple tracking operations
// from modifying storage simultaneously.

let queue = Promise.resolve();

function run(fn) {
  queue = queue
    .then(fn)
    .catch(error => {
      console.error("TimeLens:", error);
    });

  return queue;
}


// ============================================================
// 3. STORAGE HELPERS
// ============================================================

async function getData() {
  return chrome.storage.local.get({
    settings: DEFAULT_SETTINGS,
    daily: {},
    lastNotified: {},
    session: null
  });
}


// Remove only the temporary active-session object.
//
// Historical usage in "daily" is NOT affected.

async function clearSession() {
  await chrome.storage.local.remove("session");
}


// ============================================================
// 4. DATE / DOMAIN HELPERS
// ============================================================


// currently uses the devices timezone, so when the device changes date or time,
// so does the extension (can cause inflated or negative trcaking times,
// but since change device time is uncommon, it's probably fine... right?)
function today() {
  const d = new Date();

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// Normalize a domain:
//
//   WWW.YouTube.com
//   youtube.com.
//   youtube.com
//
// all become:
//
//   youtube.com

function normalizeDomain(domain) {
  return (domain || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}


// Extract hostname from a URL.
//
// Only HTTP and HTTPS pages are tracked.
//
// chrome://
// edge://
// about:
// file:
// extension pages
//
// are ignored.

function getHost(url) {
  try {
    const parsed = new URL(url);

    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    return parsed.hostname;
  } catch {
    return null;
  }
}


// Check whether a hostname belongs to a domain.
//
// Example:
//
// youtube.com
// www.youtube.com
// music.youtube.com
//
// all match youtube.com.
//
// But:
//
// youtube.com.evil.com
//
// does NOT match.

function domainMatches(hostname, domain) {
  hostname = normalizeDomain(hostname);
  domain = normalizeDomain(domain);

  if (!hostname || !domain) {
    return false;
  }

  return (
    hostname === domain ||
    hostname.endsWith("." + domain)
  );
}


// Find a configured site.
//
// This is ONLY used for UI/settings/notifications.
//
// IMPORTANT:
// Tracking itself does NOT use this function anymore.
//
// All websites are tracked.

function findConfiguredSite(hostname, settings) {
  return (settings.sites || []).find(site =>
    site.enabled &&
    domainMatches(hostname, site.domain)
  ) || null;
}


// ============================================================
// 5. ACTIVE TAB HELPERS
// ============================================================

async function getActiveTab(windowId) {
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      windowId
    });

    return tabs[0] || null;
  } catch {
    return null;
  }
}


// ============================================================
// 6. TIME ACCUMULATION
// ============================================================
//
// This is the core tracking system.
//
// A session represents:
//
//   "The user is currently looking at domain X."
//
// Example:
//
// session = {
//   tabId: 123,
//   windowId: 1,
//   domain: "youtube.com",
//   startedAt: 1791390000000
// }
//
// When we need to save time:
//
//   now - startedAt
//
// becomes elapsed seconds.
//
// That amount is added to:
//
// daily[date][domain]
//
// Example:
//
// daily: {
//   "2026-10-07": {
//     "youtube.com": 3600,
//     "google.com": 500
//   }
// }
//
// ============================================================

async function accrueTime(now = Date.now()) {
  const data = await getData();
  const session = data.session;

  // Nothing to track.
  if (!session) {
    return data;
  }

  // Do not track while the browser window is unfocused.
  if (!runtime.focused) {
    return data;
  }

  // Do not track while the screen is locked.
  if (runtime.locked) {
    return data;
  }

  const startedAt = Number(session.startedAt);

  if (!Number.isFinite(startedAt)) {
    return data;
  }

  if (now <= startedAt) {
    return data;
  }

  const seconds = Math.floor(
    (now - startedAt) / 1000
  );

  if (seconds <= 0) {
    return data;
  }

  const date = today();

  if (!data.daily[date]) {
    data.daily[date] = {};
  }

  const domain = normalizeDomain(session.domain);

  data.daily[date][domain] =
    (Number(data.daily[date][domain]) || 0) +
    seconds;

  // Move session start forward.
  //
  // This prevents the same elapsed period from being
  // counted again on the next alarm/event.

  session.startedAt = now;

  await chrome.storage.local.set({
    daily: data.daily,
    session
  });

  return data;
}


// ============================================================
// 7. START / CHANGE CURRENT SESSION
// ============================================================
//
// This function determines what website the active tab is on.
//
// IMPORTANT:
//
// There is deliberately NO "is this site tracked?" check.
//
// Every HTTP/HTTPS domain can become a session.
//
// The tracking list only controls what the UI displays.
//

async function setSession(tab, force = false) {
  const data = await accrueTime();

  if (!tab || tab.id == null) {
    await clearSession();
    return;
  }

  const hostname = getHost(tab.url);

  // Ignore browser internal pages.
  if (!hostname) {
    await clearSession();
    return;
  }

  // If we are already tracking exactly this tab/domain,
  // there is nothing to change.

  const domain = normalizeDomain(hostname);
  const oldSession = data.session;

  if (
    !force &&
    oldSession &&
    oldSession.tabId === tab.id &&
    oldSession.windowId === tab.windowId &&
    oldSession.domain === domain
  ) {
    return;
  }

  await chrome.storage.local.set({
    session: {
      tabId: tab.id,
      windowId: tab.windowId,
      domain,
      startedAt: Date.now()
    }
  });
}


// ============================================================
// 8. RECONCILE CURRENT BROWSER STATE
// ============================================================
//
// "Reconcile" means:
//
//   Look at the actual browser state
//   and make our tracking session match it.
//
// This is especially important after the service worker wakes up.
//

async function reconcile(force = false) {
  let window;

  try {
    window = await chrome.windows.getLastFocused({
      populate: false
    });
  } catch {
    return;
  }

  // No focused browser window.
  if (
    !window ||
    window.id === chrome.windows.WINDOW_ID_NONE ||
    !window.focused
  ) {
    runtime.focused = false;
    await clearSession();
    return;
  }

  runtime.focused = true;

  // Locked screen.
  if (runtime.locked) {
    await accrueTime();
    await clearSession();
    return;
  }

  const tab = await getActiveTab(window.id);

  await setSession(tab, force);
}


// ============================================================
// 9. FOCUS MODE
// ============================================================
//
// Focus Mode only applies to sites explicitly configured with:
//
// focus: true
//
// Tracking itself still happens for every domain.
//

async function updateFocusRules(settings) {
  const rules = [];
  let ruleId = 1;

  for (const site of settings.sites || []) {
    if (!site.enabled || !site.focus) {
      continue;
    }

    const domain = normalizeDomain(site.domain);

    if (!domain) {
      continue;
    }

    rules.push({
      id: ruleId++,
      priority: 100,

      action: {
        type: "redirect",
        redirect: {
          extensionPath:
            `/pages/focus.html?site=${encodeURIComponent(domain)}`
        }
      },

      condition: {
        urlFilter: `||${domain}/`,
        resourceTypes: ["main_frame"]
      }
    });
  }

  try {
    const oldRules =
      await chrome.declarativeNetRequest.getDynamicRules();

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldRules.map(rule => rule.id),
      addRules: rules
    });
  } catch (error) {
    console.warn(
      "TimeLens: could not update Focus Mode rules",
      error
    );
  }
}


// ============================================================
// 10. USAGE LIMIT NOTIFICATIONS
// ============================================================
//
// Notifications only apply to sites currently enabled
// in the tracking list.
//
// Historical data from other domains is still stored.
//

async function checkLimitNotifications() {
  const data = await getData();

  const todayData =
    data.daily[today()] || {};

  const lastNotified =
    data.lastNotified || {};

  let changed = false;

  if (!data.settings.notifications) {
    return;
  }

  for (const site of data.settings.sites || []) {
    if (!site.enabled || !site.limit) {
      continue;
    }

    const domain = normalizeDomain(site.domain);

    const seconds =
      Number(todayData[domain]) || 0;

    const limitSeconds =
      Number(site.limit) * 60;

    const ratio =
      seconds / limitSeconds;

    for (const threshold of [80, 100]) {
      if (
        threshold === 80 &&
        !data.settings.notification80
      ) {
        continue;
      }

      if (
        threshold === 100 &&
        !data.settings.notification100
      ) {
        continue;
      }

      if (ratio >= threshold / 100) {
        const key =
          `${today()}:${domain}:${threshold}`;

        if (!lastNotified[key]) {
          await chrome.notifications.create(
            `tl-${Date.now()}`,
            {
              type: "basic",
              iconUrl:
                chrome.runtime.getURL("assets/icon.svg"),

              title: "TimeLens",

              message:
                `${site.label || site.domain}: ` +
                `you've reached ${threshold}% ` +
                `of your daily limit.`
            }
          );

          lastNotified[key] = Date.now();
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await chrome.storage.local.set({
      lastNotified
    });
  }
}


// ============================================================
// 11. WORKER INITIALIZATION
// ============================================================
//
// IMPORTANT:
//
// A service-worker restart is NOT the same thing as a browser
// restart.
//
// Therefore we DO NOT delete the current session here.
//
// The persisted session allows us to continue tracking after
// Chrome wakes the worker back up.
//
// ============================================================

async function initializeWorker() {
  const data = await getData();

  await updateFocusRules(data.settings);

  await reconcile();

  await chrome.alarms.create(
    ALARM_NAME,
    {
      periodInMinutes: 1
    }
  );
}


// ============================================================
// 12. BROWSER STARTUP
// ============================================================
//
// This event means Chrome itself has started.
//
// Any session from before shutdown must therefore be discarded.
// We do not know how long the computer was shut down.
//

chrome.runtime.onStartup.addListener(() =>
  run(async () => {
    await clearSession();

    runtime.locked = false;

    await reconcile(true);
  })
);


// ============================================================
// 13. EXTENSION INSTALL / UPDATE
// ============================================================

chrome.runtime.onInstalled.addListener(() =>
  run(async () => {
    const existing =
      await chrome.storage.local.get("settings");

    if (!existing.settings) {
      await chrome.storage.local.set({
        settings: DEFAULT_SETTINGS,
        daily: {},
        lastNotified: {}
      });
    }

    const data = await getData();

    await updateFocusRules(data.settings);

    await reconcile(true);

    await chrome.alarms.create(
      ALARM_NAME,
      {
        periodInMinutes: 1
      }
    );
  })
);


// ============================================================
// 14. PERIODIC ALARM
// ============================================================
//
// Every minute:
//
//   1. Reconcile browser state
//   2. Save elapsed time
//   3. Check notifications
//
// ============================================================

chrome.alarms.onAlarm.addListener(alarm =>
  run(async () => {
    if (alarm.name !== ALARM_NAME) {
      return;
    }

    await reconcile();

    await checkLimitNotifications();
  })
);


// ============================================================
// 15. ACTIVE TAB CHANGED
// ============================================================

chrome.tabs.onActivated.addListener(
  ({ tabId }) =>
    run(async () => {
      if (!runtime.focused || runtime.locked) {
        return;
      }

      try {
        const tab =
          await chrome.tabs.get(tabId);

        await setSession(tab, true);
      } catch {
        // Tab may have disappeared.
      }
    })
);


// ============================================================
// 16. TAB URL CHANGED
// ============================================================
//
// This catches navigation within the same tab.
//
// Example:
//
// YouTube -> Google
//
// The active tab ID stays the same,
// but the tracked domain changes.
//

chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) =>
    run(async () => {
      if (!changeInfo.url) {
        return;
      }

      try {
        const window =
          await chrome.windows.get(tab.windowId);

        if (
          window.focused &&
          tab.active &&
          !runtime.locked
        ) {
          await setSession(tab, true);
        }
      } catch {
        // Tab/window may have disappeared.
      }
    })
);


// ============================================================
// 17. TAB CLOSED
// ============================================================
//
// If the currently tracked tab disappears,
// save its remaining elapsed time first.
//

chrome.tabs.onRemoved.addListener(tabId =>
  run(async () => {
    const data = await getData();

    if (data.session?.tabId === tabId) {
      await accrueTime();
      await clearSession();
    }
  })
);


// ============================================================
// 18. BROWSER WINDOW FOCUS CHANGED
// ============================================================
//
// We only count time while the browser window is focused.
//
// Switching to another application pauses tracking.
//

chrome.windows.onFocusChanged.addListener(windowId =>
  run(async () => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      runtime.focused = false;

      await accrueTime();
      await clearSession();

      return;
    }

    runtime.focused = true;

    if (!runtime.locked) {
      const tab =
        await getActiveTab(windowId);

      await setSession(tab, true);
    }
  })
);


// ============================================================
// 19. SCREEN LOCK / UNLOCK
// ============================================================
//
// IMPORTANT:
//
// "idle" is NOT used to determine whether the user is watching
// a video.
//
// A person can watch a YouTube video without moving their mouse.
//
// We therefore only pause tracking when Chrome reports that
// the screen is actually locked.
//

chrome.idle.onStateChanged.addListener(state =>
  run(async () => {
    if (state === "locked") {
      runtime.locked = true;

      await accrueTime();
      await clearSession();

      return;
    }

    if (state === "active") {
      runtime.locked = false;

      await reconcile(true);
    }
  })
);


// ============================================================
// 20. MESSAGES FROM POPUP / OPTIONS
// ============================================================
//
// Supported messages:
//
//   getSnapshot
//   saveSettings
//   resetData
//
// ============================================================

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    run(async () => {

      // --------------------------------------------------------
      // GET SNAPSHOT
      // --------------------------------------------------------

      if (message?.type === "getSnapshot") {
        await reconcile();

        const data = await getData();
        const days = [];

        for (let i = 29; i >= 0; i--) {
          const d = new Date();

          d.setDate(d.getDate() - i);

          const date = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, "0"),
            String(d.getDate()).padStart(2, "0")
          ].join("-");

          days.push({
            date,
            data: data.daily[date] || {}
          });
        }

        sendResponse({
          settings: data.settings,

          today:
            data.daily[today()] || {},

          daily:
            data.daily,

          days
        });

        return;
      }


      // --------------------------------------------------------
      // SAVE SETTINGS
      // --------------------------------------------------------

      if (message?.type === "saveSettings") {
        const data = await getData();

        const settings = {
          ...data.settings,
          ...message.settings
        };

        await chrome.storage.local.set({
          settings
        });

        await updateFocusRules(settings);

        await reconcile(true);

        sendResponse({
          ok: true
        });

        return;
      }


      // --------------------------------------------------------
      // RESET USAGE DATA
      // --------------------------------------------------------

      if (message?.type === "resetData") {
        await chrome.storage.local.set({
          daily: {},
          lastNotified: {}
        });

        await reconcile(true);

        sendResponse({
          ok: true
        });

        return;
      }


      // --------------------------------------------------------
      // IMPORT CSV
      // --------------------------------------------------------

      if (message?.type === "importCsv") {
        const rows = Array.isArray(message.rows)
          ? message.rows
          : [];

        const data = await getData();

        if (!data.daily) {
          data.daily = {};
        }

        let imported = 0;

        for (const row of rows) {
          const date = String(
            row.date || ""
          ).trim();

          const domain = normalizeDomain(
            row.domain
          );

          const seconds =
            Number(row.seconds);

          // Validate row.
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !domain ||
            !Number.isFinite(seconds) ||
            seconds < 0
          ) {
            continue;
          }

          if (!data.daily[date]) {
            data.daily[date] = {};
          }

          // IMPORT BEHAVIOUR:
          //
          // The imported value replaces the existing value
          // for that date/domain.
          //
          // This prevents importing an exported backup from
          // accidentally doubling the user's time.

          data.daily[date][domain] =
            Math.floor(seconds);

          imported++;
        }

        await chrome.storage.local.set({
          daily: data.daily
        });

        sendResponse({
          ok: true,
          imported
        });

        return;
      }


      // --------------------------------------------------------
      // UNKNOWN MESSAGE
      // --------------------------------------------------------

      sendResponse({
        ok: false,
        error: "Unknown message type."
      });

    }).catch(error => {
      sendResponse({
        ok: false,
        error: String(error)
      });
    });

    // Keep sendResponse alive for async work.
    return true;
  }
);


// ============================================================
// 21. SERVICE-WORKER STARTUP
// ============================================================
//
// This runs whenever the MV3 service worker starts.
//
// DO NOT clear the session here.
//
// Chrome can wake/sleep this worker many times during normal
// extension operation.
//

run(async () => {

  const existing =
    await chrome.storage.local.get("settings");

  if (!existing.settings) {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      daily: {},
      lastNotified: {}
    });
  }

  await initializeWorker();
});