const DEFAULT_SETTINGS = {
  sites: [
    { domain: "youtube.com", label: "YouTube", enabled: true, limit: 60, focus: false },
    { domain: "instagram.com", label: "Instagram", enabled: true, limit: 45, focus: false },
    { domain: "reddit.com", label: "Reddit", enabled: true, limit: 45, focus: false },
    { domain: "x.com", label: "X", enabled: true, limit: 30, focus: false }],
    notifications: true,
    notification80: true,
    notification100: true,
    focusMessage: "Do you really want to open this site right now?"
};
const ALARM = "timelens-minute", DAY = 86400000;
let runtime = { focused: false, locked: false };
let queue = Promise.resolve();

const today = () => new Date().toISOString().slice(0, 10);
const norm = h => (h || "").toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
function match(h, d) { h = norm(h); d = norm(d); return !!d && (h === d || h.endsWith("." + d)) }
function host(url) { try { let u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname : null } catch { return null } }
function siteFor(h, s) { return (s.sites || []).find(x => x.enabled && match(h, x.domain)) || null }
async function data() { return chrome.storage.local.get({ settings: DEFAULT_SETTINGS, daily: {}, lastNotified: {}, session: null }) }

function run(fn) {
  queue = queue.then(fn).catch(e => console.error("TimeLens:", e));
  return queue;
}

async function accrue(now = Date.now()) {
  let d = await data(), s = d.session;
  if (!s || !runtime.focused || runtime.locked) return d;
  let start = Number(s.startedAt);
  if (!Number.isFinite(start) || now <= start) return d;
  let sec = Math.floor((now - start) / 1000);
  if (sec <= 0) return d;
  let k = today(); d.daily[k] ??= {};
  d.daily[k][s.domain] = (Number(d.daily[k][s.domain]) || 0) + sec;
  s.startedAt = now;
  await chrome.storage.local.set({ daily: d.daily, session: s });
  return d;
}
async function clear() { await chrome.storage.local.remove("session") }
async function activeTab(wid) {
  try { let a = await chrome.tabs.query({ active: true, windowId: wid }); return a[0] || null } catch { return null }
}

async function setSession(tab, force = false) {
  let d = await accrue();
  if (!tab || tab.id == null) { await clear(); return }
  let s = siteFor(host(tab.url), d.settings);
  if (!s || !runtime.focused || runtime.locked) { await clear(); return }
  let domain = norm(s.domain), old = d.session;
  if (!force && old && old.tabId === tab.id && old.windowId === tab.windowId && old.domain === domain) return;
  await chrome.storage.local.set({ session: { tabId: tab.id, windowId: tab.windowId, domain, startedAt: Date.now() } });
}

async function reconcile(force = false) {
  let w;
  try { w = await chrome.windows.getLastFocused({ populate: false }) } catch { return }
  if (!w || w.id === chrome.windows.WINDOW_ID_NONE || !w.focused) {
    runtime.focused = false;
    await clear();
    return;
  }
  runtime.focused = true;
  if (runtime.locked) { await accrue(); await clear(); return }
  await setSession(await activeTab(w.id), force);
}

async function focusRules(settings) {
  let rules = [], id = 1;
  for (let s of settings.sites || []) if (s.enabled && s.focus) {
    let d = norm(s.domain); if (!d) continue;
    rules.push({
      id: id++, priority: 100, action: { type: "redirect", redirect: { extensionPath: `/pages/focus.html?site=${encodeURIComponent(d)}` } },
      condition: { urlFilter: `||${d}/`, resourceTypes: ["main_frame"] }
    });
  }
  try {
    let old = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(x => x.id), addRules: rules });
  } catch (e) { console.warn(e) }
}

async function notifyLimits() {
  let d = await data(), t = d.daily[today()] || {}, ln = d.lastNotified || {}, changed = false;
  if (!d.settings.notifications) return;
  for (let s of d.settings.sites || []) {
    if (!s.enabled || !s.limit) continue;
    let dom = norm(s.domain), sec = Number(t[dom] || 0), lim = s.limit * 60, r = sec / lim;
    for (let threshold of [80, 100]) {
      if ((threshold === 80 && !d.settings.notification80) || (threshold === 100 && !d.settings.notification100)) continue;
      if (r >= threshold / 100) {
        let k = `${today()}:${dom}:${threshold}`;
        if (!ln[k]) {
          await chrome.notifications.create(`tl-${Date.now()}`, {
            type: "basic", iconUrl: chrome.runtime.getURL("assets/icon.svg"),
            title: "TimeLens", message: `${s.label || s.domain}: you've reached ${threshold}% of your daily limit.`
          });
          ln[k] = Date.now(); changed = true;
        }
      }
    }
  }
  if (changed) await chrome.storage.local.set({ lastNotified: ln });
}

async function initializeWorker() {
  let d = await data();
  await focusRules(d.settings);
  await reconcile();
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

// Actual browser startup is different from a service-worker restart.
// Only on browser startup do we discard a previous session, because Chrome may
// have been closed for an unknown amount of time and that downtime must not count.
chrome.runtime.onStartup.addListener(() => run(async () => {
  await clear();
  runtime.locked = false;
  await reconcile(true);
}));

chrome.runtime.onInstalled.addListener(() => run(async () => {
  let x = await chrome.storage.local.get("settings");
  if (!x.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, daily: {}, lastNotified: {} });
  let d = await data();
  await focusRules(d.settings);
  await reconcile(true);
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}));

chrome.alarms.onAlarm.addListener(a => run(async () => {
  if (a.name === ALARM) { await reconcile(); await notifyLimits() }
}));

chrome.tabs.onActivated.addListener(({ tabId }) => run(async () => {
  if (!runtime.focused || runtime.locked) return;
  try { await setSession(await chrome.tabs.get(tabId), true) } catch { }
}));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => run(async () => {
  if (!changeInfo.url) return;
  try {
    let w = await chrome.windows.get(tab.windowId);
    if (w.focused && tab.active && !runtime.locked) await setSession(tab, true);
  } catch { }
}));

chrome.tabs.onRemoved.addListener(id => run(async () => {
  let d = await data();
  if (d.session?.tabId === id) { await accrue(); await clear() }
}));

chrome.windows.onFocusChanged.addListener(id => run(async () => {
  if (id === chrome.windows.WINDOW_ID_NONE) {
    runtime.focused = false;
    await accrue();
    await clear();
    return;
  }
  runtime.focused = true;
  if (!runtime.locked) await setSession(await activeTab(id), true);
}));

// "idle" means no recent input, not that the user stopped watching a video.
// Only a real screen lock pauses tracking.
chrome.idle.onStateChanged.addListener(st => run(async () => {
  if (st === "locked") {
    runtime.locked = true;
    await accrue();
    await clear();
  } else if (st === "active") {
    runtime.locked = false;
    await reconcile(true);
  }
}));

chrome.runtime.onMessage.addListener((m, _, send) => {
  run(async () => {
    if (m?.type === "getSnapshot") {
      await reconcile();
      let d = await data(), days = [];
      for (let i = 29; i >= 0; i--) { let k = new Date(Date.now() - i * DAY).toISOString().slice(0, 10); days.push({ date: k, data: d.daily[k] || {} }) }
      send({ settings: d.settings, today: d.daily[today()] || {}, daily: d.daily, days });
      return;
    }
    if (m?.type === "saveSettings") {
      let d = await data(), settings = { ...d.settings, ...m.settings };
      await chrome.storage.local.set({ settings });
      await focusRules(settings);
      await reconcile(true);
      send({ ok: true });
      return;
    }
    if (m?.type === "resetData") {
      await chrome.storage.local.set({ daily: {}, lastNotified: {} });
      await reconcile(true);
      send({ ok: true });
      return;
    }
    send({ ok: false });
  }).catch(e => send({ ok: false, error: String(e) }));
  return true;
});

// Service-worker startup: initialize without clearing the persisted session.
// The persisted session is the source of truth across worker sleep/wake cycles.
run(async () => {
  let x = await chrome.storage.local.get("settings");
  if (!x.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, daily: {}, lastNotified: {} });
  await initializeWorker();
});
