const $ = id =>
  document.getElementById(id);


// ============================================================
// Formatting
// ============================================================

function formatTime(seconds) {
  seconds =
    Math.max(
      0,
      Math.round(Number(seconds) || 0)
    );

  const hours =
    Math.floor(seconds / 3600);

  const minutes =
    Math.floor(
      (seconds % 3600) / 60
    );

  return hours
    ? `${hours}h ${minutes}m`
    : `${minutes}m`;
}


function totalTime(data) {
  return Object
    .values(data || {})
    .reduce(
      (total, value) =>
        total + (Number(value) || 0),
      0
    );
}


function normalizeDomain(domain) {
  return (domain || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}


function escapeHtml(value) {
  return String(value).replace(
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


// ============================================================
// Main
// ============================================================

(async () => {

  const snapshot =
    await chrome.runtime.sendMessage({
      type: "getSnapshot"
    });


  // ----------------------------------------------------------
  // Overall statistics
  // ----------------------------------------------------------

  const todayTotal =
    totalTime(snapshot.today);

  const last7 =
    snapshot.days.slice(-7);

  const last30 =
    snapshot.days;


  $("today").textContent =
    formatTime(todayTotal);


  $("avg7").textContent =
    formatTime(
      last7.reduce(
        (total, day) =>
          total + totalTime(day.data),
        0
      ) / 7
    );


  $("avg30").textContent =
    formatTime(
      last30.reduce(
        (total, day) =>
          total + totalTime(day.data),
        0
      ) / 30
    );


  // ----------------------------------------------------------
  // Chart
  // ----------------------------------------------------------

  const maximum =
    Math.max(
      1,
      ...last7.map(day =>
        totalTime(day.data)
      )
    );


  $("chart").innerHTML =
    last7
      .map(day => {

        const total =
          totalTime(day.data);

        const height =
          Math.max(
            4,
            (total / maximum) * 100
          );

        return `
          <div class="barwrap">
            <div
              class="bar"
              style="height:${height}%"
            ></div>

            <small>
              ${day.date.slice(5)}
            </small>
          </div>
        `;
      })
      .join("");


  // ----------------------------------------------------------
  // Tracked-site display
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  //
  // snapshot.today may contain MANY domains.
  //
  // We only display domains that are currently enabled
  // in settings.sites.
  //
  // Their historical data still exists even if they were
  // previously removed from the tracking list.
  //

  const visibleSites =
    (snapshot.settings.sites || [])
      .filter(site => site.enabled);


  $("sites").innerHTML =
    visibleSites
      .map(site => {

        const domain =
          normalizeDomain(site.domain);

        const seconds =
          Number(
            snapshot.today[domain] || 0
          );

        const percentage =
          site.limit
            ? Math.min(
                100,
                seconds /
                  (site.limit * 60) *
                  100
              )
            : 0;

        return `
          <div class="site">

            <div>
              <b>
                ${escapeHtml(
                  site.label || site.domain
                )}
              </b>

              <span>
                ${formatTime(seconds)}

                ${
                  site.limit
                    ? ` / ${site.limit}m`
                    : ""
                }
              </span>
            </div>

            <div class="progress">
              <i
                style="width:${percentage}%"
              ></i>
            </div>

          </div>
        `;
      })
      .join("")
    ||
    '<div class="muted">No tracked sites yet.</div>';

})();