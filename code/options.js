const $ = id => document.getElementById(id);

let settings;


// ============================================================
// Helpers
// ============================================================

function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character])
  );
}


// CSV escaping.
//
// Example:
//
// youtube.com
//
// stays:
//
// youtube.com
//
// But values containing commas/quotes/newlines get quoted.

function csvEscape(value) {
  const text = String(value ?? "");

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}


// Parse one CSV line.
//
// Handles quoted fields and commas inside quotes.

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const character = line[i];

    if (character === '"') {
      if (
        quoted &&
        line[i + 1] === '"'
      ) {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (
      character === "," &&
      !quoted
    ) {
      result.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  result.push(current);

  return result;
}


// ============================================================
// Settings UI
// ============================================================

function render() {
  $("sites").innerHTML =
    (settings.sites || [])
      .map((site, index) => `
        <div class="siteRow">

          <input
            data-k="label"
            data-i="${index}"
            value="${escapeHtml(site.label)}"
            placeholder="Label"
          >

          <input
            data-k="domain"
            data-i="${index}"
            value="${escapeHtml(site.domain)}"
            placeholder="example.com"
          >

          <input
            data-k="limit"
            data-i="${index}"
            type="number"
            min="0"
            value="${Number(site.limit) || 0}"
          >

          <label>
            <input
              data-k="enabled"
              data-i="${index}"
              type="checkbox"
              ${site.enabled ? "checked" : ""}
            >
            Track
          </label>

          <label>
            <input
              data-k="focus"
              data-i="${index}"
              type="checkbox"
              ${site.focus ? "checked" : ""}
            >
            Focus
          </label>

          <button data-remove="${index}">
            Remove
          </button>

        </div>
      `)
      .join("");

  $("focusMessage").value =
    settings.focusMessage || "";

  $("notifications").checked =
    settings.notifications !== false;
}


// ============================================================
// Load settings
// ============================================================

(async () => {
  const snapshot =
    await chrome.runtime.sendMessage({
      type: "getSnapshot"
    });

  settings = snapshot.settings;

  render();
})();


// ============================================================
// Add website
// ============================================================

$("add").onclick = () => {
  settings.sites.push({
    domain: "",
    label: "",
    enabled: true,
    limit: 30,
    focus: false
  });

  render();
};


// ============================================================
// Edit websites
// ============================================================

$("sites").addEventListener(
  "input",
  event => {
    const index =
      event.target.dataset.i;

    const key =
      event.target.dataset.k;

    if (index == null || !key) {
      return;
    }

    const site =
      settings.sites[index];

    if (event.target.type === "checkbox") {
      site[key] =
        event.target.checked;

    } else if (
      event.target.type === "number"
    ) {
      site[key] =
        Number(event.target.value);

    } else {
      site[key] =
        event.target.value;
    }
  }
);


// ============================================================
// Remove website
// ============================================================
//
// IMPORTANT:
//
// Removing a website from settings does NOT delete its
// historical usage data.
//
// Because all websites are tracked internally, adding the site
// again later will make its old data visible again.
//

$("sites").addEventListener(
  "click",
  event => {

    if (
      event.target.dataset.remove == null
    ) {
      return;
    }

    const index =
      Number(event.target.dataset.remove);

    settings.sites.splice(index, 1);

    render();
  }
);


// ============================================================
// Save settings
// ============================================================

$("save").onclick = async () => {

  settings.focusMessage =
    $("focusMessage").value;

  settings.notifications =
    $("notifications").checked;

  await chrome.runtime.sendMessage({
    type: "saveSettings",
    settings
  });

  $("status").textContent =
    "Saved.";
};


// ============================================================
// Reset usage data
// ============================================================

$("reset").onclick = async () => {

  if (
    !confirm(
      "Reset all recorded usage?"
    )
  ) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "resetData"
  });

  $("status").textContent =
    "Usage data reset.";
};


// ============================================================
// EXPORT CSV
// ============================================================
//
// Export format:
//
// date,domain,seconds
//
// Example:
//
// 2026-10-07,youtube.com,7200
// 2026-10-07,reddit.com,1800
//
// Only historical usage is exported.
// Settings/session state are not included.
//

$("exportCsv").onclick = async () => {

  const snapshot =
    await chrome.runtime.sendMessage({
      type: "getSnapshot"
    });

  const daily =
    snapshot.daily || {};

  const lines = [
    "date,domain,seconds"
  ];

  const dates =
    Object.keys(daily)
      .sort();

  for (const date of dates) {

    const domains =
      daily[date] || {};

    for (const domain of Object.keys(domains).sort()) {

      const seconds =
        Number(domains[domain]) || 0;

      lines.push(
        [
          csvEscape(date),
          csvEscape(domain),
          csvEscape(seconds)
        ].join(",")
      );
    }
  }

  const csv =
    lines.join("\r\n");

  const blob =
    new Blob(
      [csv],
      {
        type: "text/csv;charset=utf-8"
      }
    );

  const url =
    URL.createObjectURL(blob);

  const link =
    document.createElement("a");

  link.href = url;

  link.download =
    `timelens-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

  document.body.appendChild(link);

  link.click();

  link.remove();

  URL.revokeObjectURL(url);

  $("status").textContent =
    "CSV exported.";
};


// ============================================================
// IMPORT CSV
// ============================================================
//
// Expected columns:
//
// date,domain,seconds
//
// Imported values replace existing values for the same
// date/domain pair.
//
// This prevents importing a backup twice from doubling
// recorded usage.
//

$("importCsv").onclick = () => {
  $("importFile").click();
};


$("importFile").addEventListener(
  "change",
  async event => {

    const file =
      event.target.files?.[0];

    if (!file) {
      return;
    }

    try {

      const text =
        await file.text();

      const lines =
        text
          .replace(/^\uFEFF/, "")
          .split(/\r?\n/)
          .filter(line => line.trim());

      if (lines.length < 2) {
        throw new Error(
          "The CSV file contains no usage data."
        );
      }

      const header =
        parseCsvLine(lines[0])
          .map(value =>
            value.trim().toLowerCase()
          );

      const dateIndex =
        header.indexOf("date");

      const domainIndex =
        header.indexOf("domain");

      const secondsIndex =
        header.indexOf("seconds");

      if (
        dateIndex === -1 ||
        domainIndex === -1 ||
        secondsIndex === -1
      ) {
        throw new Error(
          "CSV must contain date, domain and seconds columns."
        );
      }

      const rows = [];

      for (
        let i = 1;
        i < lines.length;
        i++
      ) {

        const columns =
          parseCsvLine(lines[i]);

        rows.push({
          date:
            columns[dateIndex],

          domain:
            columns[domainIndex],

          seconds:
            Number(columns[secondsIndex])
        });
      }

      const result =
        await chrome.runtime.sendMessage({
          type: "importCsv",
          rows
        });

      if (!result?.ok) {
        throw new Error(
          result?.error ||
          "Import failed."
        );
      }

      $("status").textContent =
        `CSV imported: ${result.imported} rows.`;

    } catch (error) {

      console.error(
        "TimeLens CSV import:",
        error
      );

      $("status").textContent =
        `Import failed: ${error.message}`;

    } finally {

      // Allow the same file to be selected again.
      event.target.value = "";
    }
  }
);