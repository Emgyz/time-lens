# How to install
1. extract the zip file
2. go to browser extensions
3. turn on developer mode
4. click "load unpacked"
5. select the folder
6. done

# TimeLens 3.0

Added a bunch of multi line comments to make the code much more understandable, as it was barely readably before. Also export and import options added, so data can be moved between browser and devices (albeit manually still, but that's the price for it being completely local).

# TimeLens 2.1

This build fixes the main time-loss bug by persisting the active tracking session in chrome.storage.local instead of relying on Manifest V3 service-worker memory. It checkpoints elapsed time and restores the current active tab when the worker wakes.

It handles service-worker restarts, active-tab changes, URL changes, window focus, WINDOW_ID_NONE, system idle/active, closed tabs, and browser startup. Browser startup clears any old live session so Chrome being closed does not count as website usage.

# Timelens 2.0 and under

Barely functional, tracking didn't work properly yet. Not worthy of any docs / changelog.

# General

Domains match the exact domain plus all subdomains (for example youtube.com includes www.youtube.com and music.youtube.com).

TimeLens persists its active session in `chrome.storage.local`, so MV3 service-worker sleep/wake cycles do not reset the timer. Ordinary `chrome.idle` inactivity is not treated as leaving a site; only a locked screen pauses tracking. Event handling is serialized to avoid timing races.
