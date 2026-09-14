import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { searchUniversalMetadata, applyMetadataToCalibre } from "./scraper";
import { isArchiveFile, unpackArchive } from "./archive";

const DROP_DIR = "/Users/ospeto/Books_Drop";
const SERVER_URL = "http://127.0.0.1:8088";
const ENV_PATH = "/Users/ospeto/uploader/.env";
const CACHE_DB_PATH = "/Users/ospeto/uploader/cache.db";
const PROXY_URL = "http://127.0.0.1:7890";
const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024; // 20MB Telegram Bot API limit
const ALLOWED_EXTS = [".epub", ".pdf", ".mobi", ".azw3", ".cbz", ".cbr", ".azw", ".zip", ".rar", ".7z", ".tar"];

if (!fs.existsSync(DROP_DIR)) {
  fs.mkdirSync(DROP_DIR, { recursive: true });
}

const cacheDb = new Database(CACHE_DB_PATH);
cacheDb.run("PRAGMA busy_timeout = 5000;");
cacheDb.run(`
  CREATE TABLE IF NOT EXISTS file_hashes (
    filepath TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    hash TEXT NOT NULL,
    book_id INTEGER,
    title TEXT,
    authors TEXT,
    cover INTEGER
  );
`);
cacheDb.run(`CREATE INDEX IF NOT EXISTS idx_file_hashes_hash ON file_hashes(hash);`);

let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("TELEGRAM_BOT_TOKEN=")) {
      TELEGRAM_BOT_TOKEN = trimmed.replace("TELEGRAM_BOT_TOKEN=", "").trim();
    }
  }
}

if (!TELEGRAM_BOT_TOKEN) {
  console.error("[TelegramBot] Missing TELEGRAM_BOT_TOKEN. Exiting.");
  process.exit(1);
}

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.log(`[${ts}] [TelegramBot] ${msg}`);
}

function logError(msg: string, err?: any) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.error(`[${ts}] [TelegramBot] ERROR: ${msg}`, err || "");
}

function getKOReaderBinary256(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const md5 = crypto.createHash("md5");
    const size = 1024;
    for (let i = -1; i <= 10; i++) {
      const offset = i === -1 ? 256 : 1024 * Math.pow(4, i);
      if (offset >= stats.size) break;
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, offset);
      if (bytesRead > 0) md5.update(buf.subarray(0, bytesRead));
    }
    fs.closeSync(fd);
    return md5.digest("hex");
  } catch (e) {
    return null;
  }
}

function runCalibredb(args: string[]) {
  const env: any = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.http_proxy;
  delete env.HTTPS_PROXY;
  delete env.https_proxy;
  delete env.ALL_PROXY;
  delete env.all_proxy;
  env.PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env.PATH || "");

  return spawnSync("/opt/homebrew/bin/calibredb", args, {
    encoding: "utf8",
    env
  });
}

function safeParseJson(str: string): any {
  if (!str) return null;
  const trimmed = str.trim();
  const startBracket = trimmed.indexOf("[");
  const endBracket = trimmed.lastIndexOf("]");
  if (startBracket !== -1 && endBracket !== -1 && endBracket > startBracket) {
    try {
      return JSON.parse(trimmed.substring(startBracket, endBracket + 1));
    } catch {}
  }
  const startBrace = trimmed.indexOf("{");
  const endBrace = trimmed.lastIndexOf("}");
  if (startBrace !== -1 && endBrace !== -1 && endBrace > startBrace) {
    try {
      return JSON.parse(trimmed.substring(startBrace, endBrace + 1));
    } catch {}
  }
  return JSON.parse(trimmed);
}

async function tgFetch(endpoint: string, options: any = {}) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`;
  const timeoutMs = options.timeoutMs || 45000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOpts: any = {
      ...options,
      signal: controller.signal,
      proxy: PROXY_URL
    };
    delete fetchOpts.timeoutMs;
    const res = await fetch(url, fetchOpts);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessage(chatId: number, text: string, parseMode: string = ""): Promise<number | null> {
  try {
    const body: any = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    const res = await tgFetch("sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 15000
    });
    const data = await res.json() as any;
    if (data.ok && data.result?.message_id) {
      return data.result.message_id;
    }
  } catch (err: any) {
    logError(`Failed to send message to chat ${chatId}: ${err.message}`);
  }
  return null;
}

async function editOrSendMessage(chatId: number, messageId: number | null, text: string, parseMode: string = ""): Promise<number | null> {
  if (messageId) {
    try {
      const body: any = { chat_id: chatId, message_id: messageId, text };
      if (parseMode) body.parse_mode = parseMode;
      const res = await tgFetch("editMessageText", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 15000
      });
      const data = await res.json() as any;
      if (data.ok && data.result?.message_id) {
        return data.result.message_id;
      }
    } catch {}
  }
  return await sendMessage(chatId, text, parseMode);
}

function cleanString(str: string): string {
  if (!str) return "";
  let s = str;
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/t\.me\/\S+/gi, " ");
  s = s.replace(/@\w+/gi, " ");
  s = s.replace(/www\.\S+/gi, " ");
  s = s.replace(/\[.*?(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr).*?\]/gi, " ");
  s = s.replace(/\((.*?)(ebook|pdf|epub|channel|mobi|azw|scan|myanmar|tg|bookr)(.*?)\)/gi, " ");
  s = s.replace(/_v[0-9]+/gi, " ");
  s = s.replace(/\([0-9]+\)$/g, " ");
  s = s.replace(/\b(epub|pdf|mobi|azw3|cbz|cbr)\b/gi, " ");
  s = s.replace(/[_\s]+/g, " ").trim();
  s = s.replace(/^[-–—\s]+|[-–—\s]+$/g, "").trim();
  return s;
}

export function extractSeries(title: string, filename?: string): { series: string; volume: number } | null {
  const candidates = [title, filename ? path.basename(filename, path.extname(filename)) : ""].filter(Boolean);

  const patterns = [
    /^(.*?)[,_\s-]+(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:book|bk)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+#\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i,
    /^(.*?)[,_\s-]+(?:part|pt)\.?\s*(\d+(?:\.\d+)?)(?:[\s-–—:].*)?$/i
  ];

  for (const str of candidates) {
    for (const p of patterns) {
      const m = str.match(p);
      if (m) {
        let series = cleanString(m[1]).replace(/[,_–—:-]+$/, "").trim();
        let vol = parseFloat(m[2]);
        if (series.length >= 2 && !isNaN(vol)) {
          return { series, volume: vol };
        }
      }
    }
  }
  return null;
}

function sanitizeMetadata(rawTitle: string, rawAuthors: string, rawTags: string[], filename?: string) {
  let title = cleanString(rawTitle);
  let author = cleanString(rawAuthors);
  let tags = (rawTags || []).map(cleanString).filter(t => t && !/http|t\.me|channel|\.com|\.org|download|share|thebookr/i.test(t) && t.length < 30);

  const isAuthorJunk = !author || /http|t\.me|channel|admin|unknown|\.com|\.org|thebookr/i.test(author);

  if ((!title || isAuthorJunk) && filename) {
    const base = path.basename(filename, path.extname(filename));
    const parts = base.split(/[-–—]/).map(cleanString).filter(Boolean);
    if (parts.length >= 2) {
      if (!title || title.length < 3) title = parts[0];
      if (isAuthorJunk) author = parts[1] || "Unknown";
    } else {
      if (!title || title.length < 3) title = base;
      if (isAuthorJunk) author = "Unknown";
    }
  }

  return { title: cleanString(title), author: cleanString(author), tags };
}

function ingestBookFile(filePath: string, originalFileName: string) {
  const format = path.extname(originalFileName).replace(".", "").toUpperCase();
  const preliminary = sanitizeMetadata("", "", [], originalFileName);

  // 1. Level 1: KOReader Binary Checksum Deduplication
  const fileHash = getKOReaderBinary256(filePath);
  if (fileHash) {
    const hashMatch = cacheDb.query(
      "SELECT book_id, title, authors FROM file_hashes WHERE hash = ? LIMIT 1"
    ).get(fileHash) as any;

    if (hashMatch && hashMatch.book_id) {
      log(`Duplicate detected via KOReader binary hash: "${hashMatch.title}" (ID: ${hashMatch.book_id})`);
      return {
        success: true,
        duplicate: true,
        bookId: hashMatch.book_id,
        displayTitle: hashMatch.title || preliminary.title,
        message: `Already in your library (identical content)`
      };
    }
  }

  // 2. Level 2: Semantic Title, Serialization & Format Deduplication
  const incomingSeries = extractSeries(preliminary.title, originalFileName);

  try {
    const listRes = runCalibredb([
      "list",
      "--with-library",
      SERVER_URL,
      "--fields",
      "id,title,authors,formats,series,series_index",
      "--for-machine"
    ]);

    let books: any[] = [];
    if (listRes.status === 0 && listRes.stdout) {
      const parsed = safeParseJson(listRes.stdout);
      if (Array.isArray(parsed)) books = parsed;
    }

    const existingBook = books.find((b: any) => {
      const bTitle = cleanString(b.title).toLowerCase();
      const sTitle = preliminary.title.toLowerCase();

      // Check series & volume differentiation
      const bSeries = extractSeries(b.title, "");
      const bActualSeries = b.series ? { series: cleanString(b.series), volume: b.series_index || 1 } : bSeries;

      if (incomingSeries && bActualSeries) {
        // Different volume number in the same series -> NOT a duplicate!
        if (cleanString(incomingSeries.series).toLowerCase() === cleanString(bActualSeries.series).toLowerCase()) {
          return incomingSeries.volume === bActualSeries.volume;
        }
      } else if (incomingSeries || bActualSeries) {
        // One has a series volume number and the other doesn't -> separate books!
        return false;
      }

      return bTitle === sTitle || (sTitle.length > 5 && (bTitle === sTitle || bTitle.startsWith(sTitle) || sTitle.startsWith(bTitle)));
    });

    if (existingBook) {
      const existingFormats = (existingBook.formats || []).map((f: string) => f.toUpperCase());
      if (existingFormats.includes(format)) {
        log(`Duplicate detected via title match: "${existingBook.title}" (has format: ${format})`);
        return {
          success: true,
          duplicate: true,
          bookId: existingBook.id,
          displayTitle: existingBook.title,
          message: `Already exists in format ${format}`
        };
      } else {
        // Multi-format attach
        log(`Attaching new format ${format} to existing book "${existingBook.title}" (ID: ${existingBook.id})`);
        runCalibredb([
          "add_format",
          String(existingBook.id),
          filePath,
          "--with-library",
          SERVER_URL
        ]);

        if (fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            filePath, Date.now(), fileHash, existingBook.id, existingBook.title, existingBook.authors || "", 0
          );
        }

        return {
          success: true,
          duplicate: false,
          attachedFormat: true,
          bookId: existingBook.id,
          displayTitle: existingBook.title,
          message: `Attached ${format} to existing entry`
        };
      }
    }

    // 3. Level 3: Add to Calibre with --automerge ignore guard
    const addRes = runCalibredb([
      "add",
      filePath,
      "--with-library",
      SERVER_URL,
      "--automerge",
      "ignore"
    ]);

    if (addRes.status === 0) {
      const match = addRes.stdout?.match(/Added book ids?:?\s*([0-9]+)/i);
      const newId = match ? parseInt(match[1]) : null;

      let finalTitle = preliminary.title;
      let finalAuthor = preliminary.author;

      if (newId) {
        // Fetch embedded OPF metadata extracted by Calibre
        const listOne = runCalibredb([
          "list",
          "--with-library",
          SERVER_URL,
          "--search",
          `id:${newId}`,
          "--fields",
          "id,title,authors,tags,series,series_index",
          "--for-machine"
        ]);

        let rawTitle = "";
        let rawAuthors = "";
        let rawTags: string[] = [];
        let rawSeries = "";
        let rawSeriesIndex = 0;

        if (listOne.status === 0 && listOne.stdout) {
          const parsed = safeParseJson(listOne.stdout);
          if (Array.isArray(parsed) && parsed[0]) {
            rawTitle = parsed[0].title || "";
            rawAuthors = parsed[0].authors || "";
            rawTags = parsed[0].tags || [];
            rawSeries = parsed[0].series || "";
            rawSeriesIndex = parsed[0].series_index || 0;
          }
        }

        const clean = sanitizeMetadata(rawTitle, rawAuthors, rawTags, originalFileName);
        finalTitle = clean.title || preliminary.title;
        finalAuthor = clean.author || preliminary.author;

        const setArgs = ["set_metadata", String(newId), "--with-library", SERVER_URL];
        if (clean.title && clean.title !== rawTitle) setArgs.push("--field", `title:${clean.title}`);
        if (clean.author && clean.author !== rawAuthors && clean.author !== "Unknown") setArgs.push("--field", `authors:${clean.author}`);
        if (clean.tags && clean.tags.length) setArgs.push("--field", `tags:${clean.tags.join(",")}`);

        // Serialization auto-tagging
        if (!rawSeries && incomingSeries) {
          setArgs.push("--field", `series:${incomingSeries.series}`);
          setArgs.push("--field", `series_index:${incomingSeries.volume}`);
          log(`Auto-assigned series "${incomingSeries.series}" #${incomingSeries.volume} to ID ${newId}`);
        }

        if (setArgs.length > 4) {
          runCalibredb(setArgs);
        }

        // Cache binary hash for instant future deduplication
        if (fileHash) {
          cacheDb.run(
            "INSERT OR REPLACE INTO file_hashes (filepath, mtime, hash, book_id, title, authors, cover) VALUES (?, ?, ?, ?, ?, ?, ?)",
            filePath, Date.now(), fileHash, newId, finalTitle, finalAuthor, 0
          );
        }

        // Background scraper enrichment
        setTimeout(async () => {
          try {
            const isManga = format === "CBZ" || format === "CBR" || (clean.tags || []).some(t => /manga|comic/i.test(t));
            log(`Background metadata enrichment for book ID ${newId} ("${finalTitle}")...`);
            const matches = await searchUniversalMetadata(finalTitle, isManga);
            if (matches.length > 0 && matches[0].confidence >= 0.85) {
              await applyMetadataToCalibre(newId, matches[0]);
              log(`Auto-applied metadata (${matches[0].source}, confidence: ${matches[0].confidence}) to ID ${newId}`);
            }
          } catch (err: any) {
            logError(`Scraper background task error for ID ${newId}: ${err.message}`);
          }
        }, 300);
      }

      return {
        success: true,
        duplicate: false,
        bookId: newId,
        displayTitle: finalTitle,
        message: incomingSeries ? `Added (${incomingSeries.series} #${incomingSeries.volume})` : `Added to library`
      };
    } else {
      return {
        success: false,
        displayTitle: preliminary.title || originalFileName,
        error: addRes.stderr || "Failed to add book to Calibre"
      };
    }
  } catch (err: any) {
    return {
      success: false,
      displayTitle: preliminary.title || originalFileName,
      error: err.message
    };
  }
}

interface QueuedDoc {
  doc: any;
  fileName: string;
  fileSize: number;
  chatId: number;
  sender: string;
}

const pendingBatches = new Map<number, {
  docs: QueuedDoc[];
  timer: any;
}>();

async function processBatch(chatId: number, items: QueuedDoc[]) {
  if (items.length === 0) return;

  const isBatch = items.length > 1;
  const total = items.length;
  log(`Processing batch of ${total} item(s) for chat ${chatId}`);

  let statusMsgId: number | null = null;
  if (isBatch) {
    statusMsgId = await sendMessage(chatId, `📥 Received *${total}* books. Starting batch ingestion...`, "Markdown");
  }

  const results: Array<{ name: string; title?: string; status: "success" | "duplicate" | "error"; note: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { doc, fileName, fileSize, sender } = item;
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);
    const ext = path.extname(fileName).toLowerCase();

    log(`[Batch ${i + 1}/${total}] Processing "${fileName}" (${sizeMB} MB) from ${sender}`);

    if (!ALLOWED_EXTS.includes(ext)) {
      results.push({
        name: fileName,
        status: "error",
        note: `Unsupported format: ${ext}`
      });
      continue;
    }

    if (fileSize > MAX_TELEGRAM_FILE_SIZE) {
      results.push({
        name: fileName,
        status: "error",
        note: `Exceeds 20MB limit (${sizeMB} MB). Use Web Uploader.`
      });
      continue;
    }

    if (isBatch) {
      await editOrSendMessage(chatId, statusMsgId, `⏳ *[${i + 1}/${total}]* Ingesting "${fileName}"...`, "Markdown");
    } else {
      statusMsgId = await sendMessage(chatId, `⏳ Downloading & Ingesting "${fileName}" (${sizeMB} MB)...`);
    }

    // Download from Telegram
    try {
      const fileRes = await tgFetch(`getFile?file_id=${doc.file_id}`, { timeoutMs: 20000 });
      const fileJson = await fileRes.json() as any;

      if (!fileJson.ok || !fileJson.result?.file_path) {
        const errMsg = fileJson.description || "Failed to retrieve file from Telegram";
        results.push({ name: fileName, status: "error", note: errMsg });
        continue;
      }

      const dlUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`;
      const dl = await fetch(dlUrl, { proxy: PROXY_URL } as any);
      if (!dl.ok) {
        results.push({ name: fileName, status: "error", note: `Download failed (HTTP ${dl.status})` });
        continue;
      }

      const arrayBuf = await dl.arrayBuffer();
      const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const safeBase = path.basename(fileName, ext);
      const tempFileName = `${safeBase}_${uniqueSuffix}${ext}`;
      const destPath = path.join(DROP_DIR, tempFileName);

      fs.writeFileSync(destPath, Buffer.from(arrayBuf));

      if (isArchiveFile(fileName)) {
        log(`Unpacking archive "${fileName}"...`);
        const unp = unpackArchive(destPath);
        try { fs.unlinkSync(destPath); } catch {}

        if (!unp.success) {
          results.push({ name: fileName, status: "error", note: unp.error || "Archive extraction failed" });
          continue;
        }

        if (unp.books.length === 0) {
          unp.cleanup();
          results.push({ name: fileName, status: "error", note: "No supported eBooks found in archive" });
          continue;
        }

        log(`Archive "${fileName}" yielded ${unp.books.length} book(s)`);
        for (const b of unp.books) {
          const r = ingestBookFile(b.tempPath, b.originalName);
          results.push({
            name: b.originalName,
            title: r.displayTitle,
            status: r.duplicate ? "duplicate" : (r.success ? "success" : "error"),
            note: r.message || r.error || "Processed"
          });
        }
        unp.cleanup();
        continue;
      }

      const res = ingestBookFile(destPath, fileName);
      try { fs.unlinkSync(destPath); } catch {}

      if (res.success) {
        results.push({
          name: fileName,
          title: res.displayTitle,
          status: res.duplicate ? "duplicate" : "success",
          note: res.message
        });
      } else {
        results.push({
          name: fileName,
          title: res.displayTitle,
          status: "error",
          note: res.error || "Calibre ingest failed"
        });
      }
    } catch (err: any) {
      results.push({ name: fileName, status: "error", note: err.message });
    }
  }

  // Send Final Status
  if (!isBatch) {
    const single = results[0];
    if (single.status === "success") {
      await editOrSendMessage(chatId, statusMsgId, `✅ *${single.title || single.name}*\n\n${single.note}. Ready on Kindle OPDS feed.`, "Markdown");
    } else if (single.status === "duplicate") {
      await editOrSendMessage(chatId, statusMsgId, `ℹ️ *${single.title || single.name}*\n\n${single.note}. Ready on Kindle.`, "Markdown");
    } else {
      await editOrSendMessage(chatId, statusMsgId, `⚠️ Import failed for *${single.name}*:\n${single.note}`, "Markdown");
    }
  } else {
    const successCount = results.filter(r => r.status === "success" || r.status === "duplicate").length;
    let summary = `📚 *Batch Ingestion Complete* (${successCount}/${total} processed)\n\n`;

    for (const r of results) {
      if (r.status === "success") {
        summary += `✅ \`${r.name}\` — ${r.note}\n`;
      } else if (r.status === "duplicate") {
        summary += `ℹ️ \`${r.name}\` — ${r.note}\n`;
      } else {
        summary += `⚠️ \`${r.name}\` — ${r.note}\n`;
      }
    }

    summary += `\n📖 _All books are cataloged and ready on your Kindle OPDS feed._`;
    await editOrSendMessage(chatId, statusMsgId, summary, "Markdown");
  }
}

let offset = 0;
async function pollTelegram() {
  log(`Polling started via proxy ${PROXY_URL} for bot: ${TELEGRAM_BOT_TOKEN.substring(0, 10)}...`);

  while (true) {
    try {
      const res = await tgFetch(`getUpdates?offset=${offset}&timeout=25`, { timeoutMs: 35000 });
      if (!res.ok) {
        const errText = await res.text();
        logError(`getUpdates returned HTTP ${res.status}: ${errText}`);
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      const json = await res.json() as any;
      if (json.ok && json.result && json.result.length > 0) {
        for (const update of json.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg) continue;
          const chatId = msg.chat.id;
          const sender = msg.from?.username || msg.from?.first_name || `ID ${chatId}`;

          if (msg.document) {
            const doc = msg.document;
            const fileName = doc.file_name || "telegram_book.epub";
            const fileSize = doc.file_size || 0;

            let batch = pendingBatches.get(chatId);
            if (!batch) {
              batch = { docs: [], timer: null };
              pendingBatches.set(chatId, batch);
            }
            batch.docs.push({ doc, fileName, fileSize, chatId, sender });

            if (batch.timer) clearTimeout(batch.timer);
            batch.timer = setTimeout(() => {
              const currentDocs = [...batch.docs];
              pendingBatches.delete(chatId);
              processBatch(chatId, currentDocs);
            }, 1800); // 1.8s debounce collects files sent in a burst

          } else if (msg.text) {
            const text = msg.text.trim();
            log(`Received text: "${text}" from ${sender}`);

            if (text === "/start" || text === "/help") {
              await sendMessage(chatId, 
                `📚 *Reading HQ Ingestion Bot*\n\n` +
                `Send or forward any book file(s) directly in this chat:\n` +
                `• *Serialization Auto-Group:* Vol 1, Vol 2, Book 3 automatically grouped into Series.\n` +
                `• *Batch Uploads Supported:* Select and send multiple EPUBs/CBZs at once.\n` +
                `• *Duplicate Protection:* Instant binary hash + volume-aware deduplication.\n` +
                `• *Formats:* \`.epub\`, \`.pdf\`, \`.mobi\`, \`.azw3\`, \`.cbz\`, \`.cbr\`\n` +
                `• *File Limit:* Up to *20 MB* per file (Telegram API limit)\n\n` +
                `_Books are automatically de-duplicated, sanitized, and available on your Kindle._`,
                "Markdown"
              );
            } else {
              await sendMessage(chatId, "👋 Please send or forward eBook files (`.epub`, `.pdf`, `.mobi`, `.cbz`) to add them to your library. You can send multiple files at once!", "Markdown");
            }
          }
        }
      }
    } catch (err: any) {
      logError(`Polling exception: ${err.message}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

pollTelegram();
