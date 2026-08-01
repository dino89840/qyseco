const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const path = require("path");
const { mkdirSync } = require("fs");

// ======================================================
// URL NORMALIZER
// ======================================================

/**
 * Examples:
 *
 * https://wwwa.qyshare.com:2083/s/2ufvdq
 * https://wwwg.qyshare.com:2099/s/2ufvdq
 * https://qyshare.com/s/2ufvdq
 *
 * Become:
 *
 * https://qyun.org/s/2ufvdq
 */
function normalizeShareUrl(input) {
  if (typeof input !== "string") {
    throw new Error("URL must be a string");
  }

  let rawUrl = input.trim();

  if (!rawUrl) {
    throw new Error("Empty URL");
  }

  // Protocol မပါလျှင် https:// ထည့်ပေးမည်
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = `https://${rawUrl}`;
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // qyshare.com နှင့် ၎င်း၏ subdomains အားလုံး
  const isQyShare =
    hostname === "qyshare.com" ||
    hostname.endsWith(".qyshare.com");

  // qyun.org ကိုယ်တိုင်ကိုလည်း canonical URL လုပ်မည်
  const isQyun =
    hostname === "qyun.org" ||
    hostname.endsWith(".qyun.org");

  if (!isQyShare && !isQyun) {
    throw new Error(`Unsupported host: ${hostname}`);
  }

  // Domain, protocol နှင့် port ကို canonical ပုံစံပြောင်းမည်
  parsed.protocol = "https:";
  parsed.hostname = "qyun.org";
  parsed.port = "";

  // Username/password ပါလာပါက ဖယ်ရှားမည်
  parsed.username = "";
  parsed.password = "";

  return parsed.toString();
}

// HTML ထဲသို့ Database value ထည့်သည့်အခါ XSS ကာကွယ်ရန်
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ======================================================
// DATABASE SETUP
// ======================================================

const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch (error) {
  console.error("Unable to create data directory:", error);
}

const db = new Database(path.join(DATA_DIR, "links.db"));

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    url TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    added_at INTEGER,
    last_check INTEGER,
    error TEXT,
    direct_url TEXT,
    used_host TEXT
  )
`);

// Database အဟောင်းမှ upgrade လုပ်ခြင်း
try {
  db.exec("ALTER TABLE links ADD COLUMN direct_url TEXT");
} catch {}

try {
  db.exec("ALTER TABLE links ADD COLUMN used_host TEXT");
} catch {}

// ======================================================
// DB HELPERS
// ======================================================

function getAllLinks() {
  return db
    .prepare("SELECT * FROM links ORDER BY added_at DESC")
    .all();
}

function getLink(url) {
  return db
    .prepare("SELECT * FROM links WHERE url = ?")
    .get(url);
}

function upsertLink(data) {
  const stmt = db.prepare(`
    INSERT INTO links (
      url,
      status,
      added_at,
      last_check,
      error,
      direct_url,
      used_host
    )
    VALUES (
      @url,
      @status,
      @added_at,
      @last_check,
      @error,
      @direct_url,
      @used_host
    )
    ON CONFLICT(url) DO UPDATE SET
      status = @status,
      last_check = @last_check,
      error = @error,
      direct_url = @direct_url,
      used_host = @used_host
  `);

  stmt.run({
    url: data.url,
    status: data.status || "pending",
    added_at: data.added_at || Date.now(),
    last_check: data.last_check || null,
    error: data.error || null,
    direct_url: data.direct_url || null,
    used_host: data.used_host || null,
  });
}

function deleteLink(url) {
  db.prepare("DELETE FROM links WHERE url = ?").run(url);
}

// ======================================================
// MIGRATE EXISTING QYSHARE LINKS TO QYUN.ORG
// ======================================================

function migrateExistingLinks() {
  const rows = db.prepare("SELECT * FROM links").all();

  const updateUrl = db.prepare(`
    UPDATE links
    SET url = ?
    WHERE url = ?
  `);

  const removeUrl = db.prepare(`
    DELETE FROM links
    WHERE url = ?
  `);

  const migration = db.transaction(() => {
    let migratedCount = 0;
    let duplicateCount = 0;

    for (const row of rows) {
      let normalizedUrl;

      try {
        normalizedUrl = normalizeShareUrl(row.url);
      } catch {
        // Unsupported/invalid old links ကို မဖျက်ဘဲထားမည်
        continue;
      }

      if (normalizedUrl === row.url) {
        continue;
      }

      const existingTarget = getLink(normalizedUrl);

      if (existingTarget) {
        // Canonical link ရှိပြီးသားဆိုရင် old duplicate ကိုဖျက်မည်
        removeUrl.run(row.url);
        duplicateCount++;
      } else {
        updateUrl.run(normalizedUrl, row.url);
        migratedCount++;
      }
    }

    return {
      migratedCount,
      duplicateCount,
    };
  });

  try {
    const result = migration();

    console.log(
      `🔄 Link migration completed: ${result.migratedCount} changed, ${result.duplicateCount} duplicates removed`
    );
  } catch (error) {
    console.error("Link migration failed:", error);
  }
}

migrateExistingLinks();

// ======================================================
// HONO APP
// ======================================================

const app = new Hono();

app.get("/", (c) => {
  const links = getAllLinks();

  const activeCount = links.filter(
    (link) => link.status === "active"
  ).length;

  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
      >

      <title>Qyun Keeper (MMT)</title>

      <script src="https://cdn.tailwindcss.com"></script>

      <link
        rel="stylesheet"
        href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"
      >
    </head>

    <body class="bg-slate-900 text-slate-200 min-h-screen p-4 flex flex-col items-center">
      <div class="w-full max-w-5xl">

        <!-- Header -->
        <div class="flex justify-between items-center mb-6">
          <div>
            <h1 class="text-2xl font-bold text-emerald-400">
              <i class="fa-solid fa-robot mr-2"></i>
              Qyun Smart Keeper
            </h1>

            <p class="text-xs text-slate-400 mt-1">
              QyShare links are automatically changed to qyun.org
            </p>

            <p class="text-xs text-slate-500 mt-1">
              Runs every 2 days at 12:00 PM Myanmar Time
            </p>
          </div>

          <div class="text-right">
            <div class="text-3xl font-bold text-white">
              ${links.length}
            </div>

            <div class="text-xs text-slate-400">
              Total Links
            </div>
          </div>
        </div>

        <!-- Input -->
        <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg mb-8">
          <label class="block text-xs font-bold text-slate-400 mb-2 uppercase">
            Add QyShare / Qyun Links
          </label>

          <div class="flex gap-2">
            <textarea
              id="newLinks"
              rows="3"
              class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-xs text-green-300 focus:outline-none focus:border-emerald-500"
              placeholder="https://wwwa.qyshare.com:2083/s/2ufvdq"
            ></textarea>

            <button
              id="addButton"
              onclick="addLinks()"
              class="bg-emerald-600 hover:bg-emerald-500 text-white px-6 rounded-lg font-bold text-sm whitespace-nowrap"
            >
              Add
            </button>
          </div>

          <div id="message" class="mt-3 text-xs hidden"></div>

          <p class="text-xs text-slate-500 mt-3">
            Example:
            <span class="text-blue-300 font-mono">
              https://wwwa.qyshare.com:2083/s/2ufvdq
            </span>
            →
            <span class="text-emerald-300 font-mono">
              https://qyun.org/s/2ufvdq
            </span>
          </p>
        </div>

        <!-- List -->
        <div class="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 shadow-lg">
          <div class="px-6 py-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
            <span class="text-sm font-bold text-slate-300">
              Monitored Files (${activeCount} Active)
            </span>

            <button
              onclick="runCheckNow()"
              class="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded"
            >
              ⚡ Force Check
            </button>
          </div>

          <div class="overflow-x-auto max-h-[600px]">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-900 text-slate-500 sticky top-0">
                <tr>
                  <th class="p-4">Qyun URL</th>
                  <th class="p-4">Host Used</th>
                  <th class="p-4">Last Checked (MMT)</th>
                  <th class="p-4">Status</th>
                  <th class="p-4 text-right">Action</th>
                </tr>
              </thead>

              <tbody class="divide-y divide-slate-700">
                ${
                  links.length === 0
                    ? `
                      <tr>
                        <td
                          colspan="5"
                          class="p-8 text-center text-slate-500"
                        >
                          Empty List
                        </td>
                      </tr>
                    `
                    : ""
                }

                ${links
                  .map((link) => {
                    const safeUrl = escapeHtml(link.url);
                    const safeHost = escapeHtml(
                      link.used_host || "-"
                    );
                    const safeError = escapeHtml(
                      link.error || ""
                    );

                    const encodedDeleteUrl =
                      encodeURIComponent(link.url);

                    const lastChecked = link.last_check
                      ? new Date(
                          link.last_check
                        ).toLocaleString("en-US", {
                          timeZone: "Asia/Yangon",
                        })
                      : "Pending...";

                    let statusHtml;

                    if (link.status === "active") {
                      statusHtml = `
                        <span class="text-green-400 font-bold">
                          ✅ Active
                        </span>
                      `;
                    } else if (link.status === "failed") {
                      statusHtml = `
                        <span
                          class="text-red-400 font-bold"
                          title="${safeError}"
                        >
                          ❌ Failed
                        </span>
                      `;
                    } else {
                      statusHtml = `
                        <span class="text-yellow-500">
                          ⏳ Waiting
                        </span>
                      `;
                    }

                    return `
                      <tr class="hover:bg-slate-700/30 transition">
                        <td
                          class="p-4 text-blue-300 font-mono truncate max-w-[300px]"
                          title="${safeUrl}"
                        >
                          <a
                            href="${safeUrl}"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="hover:text-blue-200 hover:underline"
                          >
                            ${safeUrl}
                          </a>
                        </td>

                        <td class="p-4 text-slate-400 font-mono">
                          ${safeHost}
                        </td>

                        <td class="p-4 text-slate-400">
                          ${escapeHtml(lastChecked)}
                        </td>

                        <td class="p-4">
                          ${statusHtml}
                        </td>

                        <td class="p-4 text-right">
                          <button
                            onclick="deleteLnk('${encodedDeleteUrl}')"
                            class="text-red-400 hover:text-red-300"
                            title="Delete"
                          >
                            <i class="fa-solid fa-trash"></i>
                          </button>
                        </td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <script>
        function showMessage(text, isError = false) {
          const element = document.getElementById("message");

          element.textContent = text;
          element.classList.remove(
            "hidden",
            "text-red-400",
            "text-emerald-400"
          );

          element.classList.add(
            isError ? "text-red-400" : "text-emerald-400"
          );
        }

        async function addLinks() {
          const textarea = document.getElementById("newLinks");
          const button = document.getElementById("addButton");
          const text = textarea.value;

          if (!text.trim()) {
            showMessage("Please enter at least one link.", true);
            return;
          }

          const links = text
            .split(/\\r?\\n/)
            .map((link) => link.trim())
            .filter(Boolean);

          button.disabled = true;
          button.innerText = "Saving...";

          try {
            const response = await fetch("/api/add", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ links }),
            });

            const result = await response.json();

            if (!response.ok) {
              throw new Error(
                result.error || "Unable to add links"
              );
            }

            if (result.invalid && result.invalid.length > 0) {
              const invalidMessages = result.invalid
                .map(
                  (item) =>
                    item.input + " - " + item.error
                )
                .join("\\n");

              alert(
                "Some links could not be added:\\n\\n" +
                invalidMessages
              );
            }

            window.location.reload();
          } catch (error) {
            showMessage(error.message, true);
            button.disabled = false;
            button.innerText = "Add";
          }
        }

        async function deleteLnk(encodedUrl) {
          if (!confirm("Delete this link?")) {
            return;
          }

          const url = decodeURIComponent(encodedUrl);

          try {
            const response = await fetch("/api/delete", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ url }),
            });

            if (!response.ok) {
              throw new Error("Delete failed");
            }

            window.location.reload();
          } catch (error) {
            alert(error.message);
          }
        }

        async function runCheckNow() {
          if (!confirm("Run check now?")) {
            return;
          }

          try {
            const response = await fetch("/api/trigger", {
              method: "POST",
            });

            const result = await response.json();

            if (!response.ok) {
              throw new Error(
                result.error || "Unable to start check"
              );
            }

            alert(
              "Check started in background. Refresh the page after a few minutes."
            );
          } catch (error) {
            alert(error.message);
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ======================================================
// API: ADD LINKS
// ======================================================

app.post("/api/add", async (c) => {
  try {
    const body = await c.req.json();
    const links = Array.isArray(body.links) ? body.links : [];

    if (links.length === 0) {
      return c.json(
        {
          success: false,
          error: "No links provided",
        },
        400
      );
    }

    const added = [];
    const duplicates = [];
    const invalid = [];

    for (const inputUrl of links) {
      try {
        // qyshare domain/subdomain/port အားလုံးကို
        // https://qyun.org အဖြစ်ပြောင်းခြင်း
        const normalizedUrl = normalizeShareUrl(inputUrl);

        const existing = getLink(normalizedUrl);

        if (existing) {
          duplicates.push({
            input: inputUrl,
            normalized: normalizedUrl,
          });

          continue;
        }

        upsertLink({
          url: normalizedUrl,
          status: "pending",
          added_at: Date.now(),
          last_check: null,
          error: null,
          direct_url: null,
          used_host: null,
        });

        added.push({
          input: inputUrl,
          normalized: normalizedUrl,
        });
      } catch (error) {
        invalid.push({
          input: inputUrl,
          error: error.message,
        });
      }
    }

    return c.json({
      success: true,
      added,
      duplicates,
      invalid,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error.message || "Invalid request",
      },
      400
    );
  }
});

// ======================================================
// API: DELETE LINK
// ======================================================

app.post("/api/delete", async (c) => {
  try {
    const { url } = await c.req.json();

    if (!url) {
      return c.json(
        {
          success: false,
          error: "URL is required",
        },
        400
      );
    }

    deleteLink(url);

    return c.json({
      success: true,
    });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error.message || "Delete failed",
      },
      400
    );
  }
});

// ======================================================
// API: MANUAL TRIGGER
// ======================================================

let maintenanceRunning = false;

app.post("/api/trigger", (c) => {
  if (maintenanceRunning) {
    return c.json(
      {
        success: false,
        error: "Maintenance is already running",
      },
      409
    );
  }

  // Request ကိုမစောင့်ဘဲ background တွင် run မည်
  runMaintenance().catch((error) => {
    console.error("Manual maintenance error:", error);
  });

  return c.json({
    success: true,
    message: "Maintenance started",
  });
});

// GET အဟောင်းကိုလည်း ဆက်အသုံးပြုနိုင်ရန်
app.get("/api/trigger", (c) => {
  if (maintenanceRunning) {
    return c.json(
      {
        success: false,
        error: "Maintenance is already running",
      },
      409
    );
  }

  runMaintenance().catch((error) => {
    console.error("Manual maintenance error:", error);
  });

  return c.json({
    success: true,
    message: "Maintenance started",
  });
});

// ======================================================
// MAINTENANCE LOGIC
// ======================================================

async function runMaintenance() {
  if (maintenanceRunning) {
    console.log("⚠️ Maintenance is already running");
    return;
  }

  maintenanceRunning = true;

  try {
    const allLinks = getAllLinks();

    if (allLinks.length === 0) {
      console.log("No links to process");
      return;
    }

    const shuffled = [...allLinks].sort(
      () => Math.random() - 0.5
    );

    const BATCH_SIZE = 5;

    for (
      let i = 0;
      i < shuffled.length;
      i += BATCH_SIZE
    ) {
      const batch = shuffled.slice(
        i,
        i + BATCH_SIZE
      );

      console.log(
        `Processing batch ${
          Math.floor(i / BATCH_SIZE) + 1
        } of ${Math.ceil(
          shuffled.length / BATCH_SIZE
        )}`
      );

      await Promise.all(
        batch.map(async (linkData) => {
          const MAX_RETRIES = 3;

          let success = false;
          let lastError = null;
          let result = null;

          for (
            let attempt = 1;
            attempt <= MAX_RETRIES;
            attempt++
          ) {
            try {
              // Database ထဲမှာ old URL ကျန်ခဲ့ရင်တောင်
              // process မလုပ်ခင် qyun.org ပြောင်းမည်
              const normalizedUrl =
                normalizeShareUrl(linkData.url);

              result = await processQyShare(
                normalizedUrl
              );

              success = true;
              break;
            } catch (error) {
              lastError =
                error.message || String(error);

              if (attempt < MAX_RETRIES) {
                console.warn(
                  `Retry ${attempt}/${MAX_RETRIES} for ${linkData.url}: ${lastError}`
                );

                await sleep(2000);
              }
            }
          }

          if (success) {
            upsertLink({
              ...linkData,
              status: "active",
              last_check: Date.now(),
              error: null,
              direct_url: result.directUrl,
              used_host: result.usedHost,
            });

            console.log(
              `✅ Active: ${linkData.url}`
            );
          } else {
            console.error(
              `❌ Failed ${linkData.url}: ${lastError}`
            );

            upsertLink({
              ...linkData,
              status: "failed",
              last_check: Date.now(),
              error: `Failed after ${MAX_RETRIES} attempts: ${lastError}`,
              direct_url: linkData.direct_url || null,
              used_host: linkData.used_host || null,
            });
          }
        })
      );

      // နောက်ဆုံး batch မဟုတ်လျှင်သာ စောင့်မည်
      if (i + BATCH_SIZE < shuffled.length) {
        await sleep(5000);
      }
    }
  } finally {
    maintenanceRunning = false;
    console.log("🏁 Maintenance completed");
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// ======================================================
// HOST TESTING HELPERS
// ======================================================

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function hostProtocol(host) {
  const bareHost = host.split(":")[0];

  const isIp =
    /^(\d{1,3}\.){3}\d{1,3}$/.test(bareHost);

  return isIp ? "http" : "https";
}

async function testHost(host) {
  if (!host) {
    return false;
  }

  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 6000);

  try {
    const pingUrl =
      `${hostProtocol(host)}://${host}` +
      `/ping?ts=${Date.now()}`;

    const response = await fetch(pingUrl, {
      method: "GET",
      headers: COMMON_HEADERS,
      signal: controller.signal,
    });

    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function findAvailableHost(hosts) {
  for (const hostData of hosts) {
    if (
      hostData &&
      hostData.host &&
      (await testHost(hostData.host))
    ) {
      return hostData;
    }
  }

  return null;
}

// ======================================================
// QYUN PAGE PROCESSING
// ======================================================

async function processQyShare(inputUrl) {
  // ဒီနေရာမှာပါ ထပ်မံ normalize လုပ်ထားသည်
  const url = normalizeShareUrl(inputUrl);

  const controller = new AbortController();

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 30000);

  try {
    console.log(`Checking normalized URL: ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers: COMMON_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Share page HTTP ${response.status}`
      );
    }

    const html = await response.text();

    // Page variables parse လုပ်ခြင်း
    const token =
      html.match(
        /(?:const|let|var)\s+token\s*=\s*["']([^"']+)["']/
      )?.[1];

    const fileId =
      html.match(
        /(?:const|let|var)\s+fileId\s*=\s*["']?(\d+)["']?/
      )?.[1];

    const hostsMatch = html.match(
      /(?:const|let|var)\s+downloadHosts\s*=\s*(\[[\s\S]*?\])\s*;/
    );

    const backupHostsMatch = html.match(
      /(?:const|let|var)\s+backupDownloadHosts\s*=\s*(\[[\s\S]*?\])\s*;/
    );

    if (!token || !fileId) {
      throw new Error(
        "Invalid page structure: token/fileId missing"
      );
    }

    if (!hostsMatch) {
      throw new Error(
        "downloadHosts not found"
      );
    }

    const hasPassword =
      /(?:const|let|var)\s+hasPassword\s*=\s*true/.test(
        html
      );

    let parsedDownloadHosts;
    let parsedBackupHosts = [];

    try {
      parsedDownloadHosts = JSON.parse(
        hostsMatch[1]
      );

      if (backupHostsMatch) {
        parsedBackupHosts = JSON.parse(
          backupHostsMatch[1]
        );
      }
    } catch {
      throw new Error(
        "Unable to parse download hosts"
      );
    }

    const downloadHosts = Array.isArray(
      parsedDownloadHosts
    )
      ? parsedDownloadHosts.filter(
          (host) =>
            Number(host.status) === 1 &&
            host.host
        )
      : [];

    const backupHosts = Array.isArray(
      parsedBackupHosts
    )
      ? parsedBackupHosts.filter(
          (host) =>
            Number(host.status) === 1 &&
            host.host
        )
      : [];

    if (
      downloadHosts.length === 0 &&
      backupHosts.length === 0
    ) {
      throw new Error("No hosts available");
    }

    // Primary hosts ကို အရင်စစ်မည်
    let chosenHost =
      await findAvailableHost(downloadHosts);

    // Primary မရလျှင် backup hosts ကိုစစ်မည်
    if (!chosenHost) {
      chosenHost =
        await findAvailableHost(backupHosts);
    }

    // /ping မရသော်လည်း listed host ကို fallback အသုံးပြုမည်
    if (!chosenHost) {
      chosenHost =
        downloadHosts[0] ||
        backupHosts[0] ||
        null;
    }

    if (!chosenHost) {
      throw new Error("No usable host");
    }

    // qyun.org origin ဖြင့် API URL တည်ဆောက်မည်
    const parsedUrl = new URL(url);

    const apiUrl =
      `${parsedUrl.origin}/api/share/download` +
      `?token=${encodeURIComponent(token)}` +
      `&fileId=${encodeURIComponent(fileId)}` +
      `&hostId=${encodeURIComponent(
        chosenHost.id
      )}`;

    const apiResponse = await fetch(apiUrl, {
      method: "GET",
      headers: {
        ...COMMON_HEADERS,
        Referer: url,
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (
      !apiResponse.ok &&
      apiResponse.status !== 206
    ) {
      throw new Error(
        `Download API failed: HTTP ${apiResponse.status}`
      );
    }

    const directUrl =
      apiResponse.url || apiUrl;

    // File အပြည့်မ download ဘဲ 64 KB ခန့်သာဖတ်မည်
    const reader =
      apiResponse.body?.getReader();

    if (reader) {
      let pulledBytes = 0;
      const maxBytes = 64 * 1024;

      while (pulledBytes < maxBytes) {
        const { done, value } =
          await reader.read();

        if (done) {
          break;
        }

        pulledBytes +=
          value?.byteLength ||
          value?.length ||
          0;
      }

      try {
        await reader.cancel();
      } catch {}
    }

    return {
      directUrl,
      usedHost: chosenHost.host,
      hasPassword,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Timeout: website is too slow"
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ======================================================
// CRON
// Every 2 days at 12:00 PM Myanmar Time
// Explicit timezone အသုံးပြုထားသည်
// ======================================================

cron.schedule(
  "0 12 */2 * *",
  async () => {
    console.log(
      "🕛 MMT 12:00 PM - Scheduled task started"
    );

    try {
      await runMaintenance();
    } catch (error) {
      console.error(
        "Scheduled maintenance failed:",
        error
      );
    }
  },
  {
    timezone: "Asia/Yangon",
  }
);

// ======================================================
// START SERVER
// ======================================================

const PORT = Number(
  process.env.PORT || 3000
);

serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(
      `🚀 Qyun Keeper running on port ${info.port}`
    );

    console.log(
      "🔁 QyShare links will automatically be changed to https://qyun.org"
    );
  }
);
