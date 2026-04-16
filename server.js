const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const Database = require("better-sqlite3");
const cron = require("node-cron");
const path = require("path");

// ============ DATABASE SETUP ============
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const { mkdirSync } = require("fs");
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const db = new Database(path.join(DATA_DIR, "links.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    url TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    added_at INTEGER,
    last_check INTEGER,
    error TEXT
  )
`);

// ============ DB HELPERS ============
function getAllLinks() {
  return db.prepare("SELECT * FROM links ORDER BY added_at DESC").all();
}

function getLink(url) {
  return db.prepare("SELECT * FROM links WHERE url = ?").get(url);
}

function upsertLink(data) {
  const stmt = db.prepare(`
    INSERT INTO links (url, status, added_at, last_check, error)
    VALUES (@url, @status, @added_at, @last_check, @error)
    ON CONFLICT(url) DO UPDATE SET
      status = @status,
      last_check = @last_check,
      error = @error
  `);
  stmt.run({
    url: data.url,
    status: data.status || "pending",
    added_at: data.added_at || Date.now(),
    last_check: data.last_check || null,
    error: data.error || null,
  });
}

function deleteLink(url) {
  db.prepare("DELETE FROM links WHERE url = ?").run(url);
}

// ============ HONO APP ============
const app = new Hono();

app.get("/", (c) => {
  const links = getAllLinks();
  const activeCount = links.filter((l) => l.status === "active").length;

  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QyShare Keeper (MMT)</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" />
    </head>
    <body class="bg-slate-900 text-slate-200 min-h-screen p-4 flex flex-col items-center">
        <div class="w-full max-w-5xl">
            <!-- Header -->
            <div class="flex justify-between items-center mb-6">
                <div>
                    <h1 class="text-2xl font-bold text-emerald-400"><i class="fa-solid fa-robot mr-2"></i> QyShare Smart Keeper</h1>
                    <p class="text-xs text-slate-400 mt-1">Runs every 2 days at 12:00 PM (Myanmar Time)</p>
                </div>
                <div class="text-right">
                    <div class="text-3xl font-bold text-white">${links.length}</div>
                    <div class="text-xs text-slate-400">Total Links</div>
                </div>
            </div>
            <!-- Input -->
            <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg mb-8">
                <label class="block text-xs font-bold text-slate-400 mb-2 uppercase">Add Links</label>
                <div class="flex gap-2">
                    <textarea id="newLinks" rows="2" class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-xs text-green-300 focus:outline-none focus:border-emerald-500" placeholder="Paste links here..."></textarea>
                    <button onclick="addLinks()" class="bg-emerald-600 hover:bg-emerald-500 text-white px-6 rounded-lg font-bold text-sm whitespace-nowrap">
                        Add
                    </button>
                </div>
            </div>
            <!-- List -->
            <div class="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 shadow-lg">
                <div class="px-6 py-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-300">Monitored Files (${activeCount} Active)</span>
                    <button onclick="runCheckNow()" class="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded">
                        ⚡ Force Check
                    </button>
                </div>
                <div class="overflow-x-auto max-h-[600px]">
                    <table class="w-full text-left text-xs">
                        <thead class="bg-slate-900 text-slate-500 sticky top-0">
                            <tr>
                                <th class="p-4">Link URL</th>
                                <th class="p-4">Last Checked (MMT)</th>
                                <th class="p-4">Status</th>
                                <th class="p-4 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-700">
                            ${links.length === 0 ? '<tr><td colspan="4" class="p-8 text-center text-slate-500">Empty List</td></tr>' : ""}
                            ${links
                              .map(
                                (l) => `
                                <tr class="hover:bg-slate-700/30 transition">
                                    <td class="p-4 text-blue-300 font-mono truncate max-w-[300px]" title="${l.url}">${l.url}</td>
                                    <td class="p-4 text-slate-400">
                                        ${l.last_check ? new Date(l.last_check).toLocaleString("en-US", { timeZone: "Asia/Yangon" }) : "Pending..."}
                                    </td>
                                    <td class="p-4">
                                        ${
                                          l.status === "active"
                                            ? '<span class="text-green-400 font-bold">✅ Active</span>'
                                            : l.status === "failed"
                                            ? `<span class="text-red-400 font-bold" title="${l.error || ""}">❌ Failed</span>`
                                            : '<span class="text-yellow-500">⏳ Waiting</span>'
                                        }
                                    </td>
                                    <td class="p-4 text-right">
                                        <button onclick="deleteLnk('${l.url}')" class="text-red-400 hover:text-red-300"><i class="fa-solid fa-trash"></i></button>
                                    </td>
                                </tr>
                            `
                              )
                              .join("")}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
        <script>
            async function addLinks() {
                const text = document.getElementById('newLinks').value;
                if(!text.trim()) return;
                document.querySelector('button').innerText = "Saving...";
                await fetch('/api/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ links: text.split('\\n').map(l=>l.trim()).filter(l=>l) })
                });
                window.location.reload();
            }
            async function deleteLnk(url) {
                if(!confirm("Delete?")) return;
                await fetch('/api/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                window.location.reload();
            }
            function runCheckNow() {
                if(!confirm("Run check now?")) return;
                fetch('/api/trigger');
                alert("Started in background... refresh page in a few minutes.");
            }
        </script>
    </body>
    </html>
  `);
});

app.post("/api/add", async (c) => {
  const { links } = await c.req.json();
  for (const url of links) {
    const existing = getLink(url);
    if (!existing) {
      upsertLink({ url, status: "pending", added_at: Date.now() });
    }
  }
  return c.json({ success: true });
});

app.post("/api/delete", async (c) => {
  const { url } = await c.req.json();
  deleteLink(url);
  return c.json({ success: true });
});

app.get("/api/trigger", (c) => {
  runMaintenance();
  return c.text("Triggered");
});

// ============ MAINTENANCE LOGIC ============
async function runMaintenance() {
  const allLinks = getAllLinks();
  const shuffled = allLinks.sort(() => Math.random() - 0.5);
  const BATCH_SIZE = 5;

  for (let i = 0; i < shuffled.length; i += BATCH_SIZE) {
    const batch = shuffled.slice(i, i + BATCH_SIZE);
    console.log(
      `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(shuffled.length / BATCH_SIZE)}`
    );

    await Promise.all(
      batch.map(async (linkData) => {
        const MAX_RETRIES = 3;
        let success = false;
        let lastError = null;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await processQyShare(linkData.url);
            success = true;
            break;
          } catch (e) {
            lastError = e.message;
            if (attempt < MAX_RETRIES) {
              console.warn(
                `Retry ${attempt}/${MAX_RETRIES} for ${linkData.url}: ${e.message}`
              );
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }

        if (success) {
          upsertLink({
            ...linkData,
            status: "active",
            last_check: Date.now(),
            error: null,
          });
        } else {
          console.error(`FAILED ${linkData.url}: ${lastError}`);
          upsertLink({
            ...linkData,
            status: "failed",
            last_check: Date.now(),
            error: `Failed after 3 attempts: ${lastError}`,
          });
        }
      })
    );

    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function processQyShare(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const token = html.match(/const token = "([^"]+)";/)?.[1];
    const fileId = html.match(/const fileId = (\d+);/)?.[1];
    const hostsMatch = html.match(/const downloadHosts = (\[.*?\]);/s);

    if (!token || !fileId || !hostsMatch) throw new Error("Invalid Page Structure");

    const hosts = JSON.parse(hostsMatch[1]);
    if (hosts.length === 0) throw new Error("No Hosts Available");

    const parsedUrl = new URL(url);
    const apiUrl = `${parsedUrl.origin}/api/share/download?token=${encodeURIComponent(token)}&fileId=${encodeURIComponent(fileId)}&hostId=${hosts[0].id}`;

    const apiRes = await fetch(apiUrl, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0", Referer: url },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!apiRes.ok) throw new Error("API Connection Failed");

    // Consume and discard the body
    const reader = apiRes.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    return true;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Timeout (Web too slow)");
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
}

// ============ CRON: Every 2 days at 12:00 PM Myanmar Time (UTC+6:30 = 5:30 UTC) ============
cron.schedule("30 5 */2 * *", async () => {
  console.log("🕛 MMT 12:00 PM - Scheduled Task Started...");
  await runMaintenance();
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
serve(
  {
    fetch: app.fetch,
    port: Number(PORT),
  },
  (info) => {
    console.log(`🚀 QyShare Keeper running on port ${info.port}`);
  }
);
