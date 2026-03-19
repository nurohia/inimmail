require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");

const axios = require("axios");
const Database = require("better-sqlite3");
const express = require("express");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const { PrismaClient } = require("@prisma/client");

function normalizeAdminPath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value || value === "/") return "/_mail-admin";
  return value.startsWith("/") ? value.replace(/\/+$/, "") : `/${value.replace(/\/+$/, "")}`;
}

function resolveSqlitePath(databaseUrl) {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must use a SQLite file URL.");
  }

  return path.resolve(process.cwd(), databaseUrl.slice("file:".length));
}

const dbPath = resolveSqlitePath(process.env.DATABASE_URL);
const rawDb = new Database(dbPath);
rawDb.pragma("foreign_keys = ON");
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS "RedeemCode" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "durationHours" INTEGER NOT NULL,
    "isUsed" BOOLEAN NOT NULL DEFAULT 0,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "ActiveSession" (
    "sessionToken" TEXT NOT NULL PRIMARY KEY,
    "redeemCode" TEXT NOT NULL UNIQUE,
    "emailAddress" TEXT NOT NULL,
    "upstreamJwt" TEXT NOT NULL,
    "upstreamAddressId" TEXT,
    "expiresAt" DATETIME,
    "upstreamDeletedAt" DATETIME,
    "upstreamDeleteError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActiveSession_redeemCode_fkey"
      FOREIGN KEY ("redeemCode") REFERENCES "RedeemCode" ("code") ON DELETE CASCADE ON UPDATE CASCADE
  );

  CREATE TABLE IF NOT EXISTS "DomainConfig" (
    "domain" TEXT NOT NULL PRIMARY KEY,
    "isEnabled" BOOLEAN NOT NULL DEFAULT 1,
    "isAvailable" BOOLEAN NOT NULL DEFAULT 1,
    "source" TEXT,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "AppConfig" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "DeletedMessage" (
    "sessionToken" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("sessionToken", "messageId"),
    CONSTRAINT "DeletedMessage_sessionToken_fkey"
      FOREIGN KEY ("sessionToken") REFERENCES "ActiveSession" ("sessionToken") ON DELETE CASCADE ON UPDATE CASCADE
  );
`);

function ensureColumn(table, column, definition) {
  const exists = rawDb
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .some((item) => item.name === column);

  if (!exists) {
    rawDb.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

ensureColumn("RedeemCode", "lastBoundEmail", "TEXT");

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL,
  }),
});

const app = express();

const PORT = Number(process.env.PORT || 38117);
const WORKER_API_URL = (process.env.WORKER_API_URL || "").replace(/\/+$/, "");
const WORKER_ADMIN_PASSWORD = process.env.WORKER_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "";
const ADMIN_PATH = normalizeAdminPath(process.env.ADMIN_PATH || "/admin");
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || "admin1234";
const DOMAIN_CACHE_TTL_MS = Number(process.env.DOMAIN_CACHE_TTL_MS || 60000);
const EXPIRED_SESSION_SWEEP_INTERVAL_MS = Number(process.env.EXPIRED_SESSION_SWEEP_INTERVAL_MS || 60000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://127.0.0.1:42763,http://localhost:42763")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

let cachedDomains = {
  value: [],
  expiresAt: 0,
};

const keyedLocks = new Map();

const upstream = axios.create({
  baseURL: WORKER_API_URL,
  timeout: 15000,
});

function withKeyLock(key, task) {
  const previous = keyedLocks.get(key) || Promise.resolve();
  let release = null;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => {}).then(() => pending);
  keyedLocks.set(key, next);

  return previous
    .catch(() => {})
    .then(task)
    .finally(() => {
      release();
      if (keyedLocks.get(key) === next) keyedLocks.delete(key);
    });
}

function getConfigValue(key) {
  const row = rawDb.prepare('SELECT "value" FROM "AppConfig" WHERE "key" = ?').get(key);
  return row?.value ?? null;
}

function setConfigValue(key, value) {
  rawDb
    .prepare(
      `INSERT INTO "AppConfig" ("key", "value", "updatedAt")
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT("key")
       DO UPDATE SET "value" = excluded."value", "updatedAt" = CURRENT_TIMESTAMP`,
    )
    .run(key, value);
}

function saveRedeemCodeBinding(code, emailAddress) {
  if (!code) return;
  rawDb
    .prepare(`UPDATE "RedeemCode" SET "lastBoundEmail" = ? WHERE "code" = ?`)
    .run(emailAddress ? String(emailAddress).trim().toLowerCase() : null, String(code).trim());
}

function getRedeemCodeBindingMap(codes) {
  if (!codes.length) return new Map();
  const placeholders = codes.map(() => "?").join(", ");
  const rows = rawDb
    .prepare(`SELECT "code", "lastBoundEmail" FROM "RedeemCode" WHERE "code" IN (${placeholders})`)
    .all(...codes);
  return new Map(rows.map((item) => [item.code, item.lastBoundEmail || null]));
}

function getAdminCredentials() {
  return {
    username: getConfigValue("admin_username") || DEFAULT_ADMIN_USERNAME,
    password: getConfigValue("admin_password") || DEFAULT_ADMIN_PASSWORD,
  };
}

function getPurchaseLink() {
  return String(getConfigValue("purchase_link") || "").trim();
}

function normalizeOrigin(origin) {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch (_error) {
    return origin;
  }
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes("*")) return true;

  const normalized = normalizeOrigin(origin);
  return ALLOWED_ORIGINS.some((candidate) => normalizeOrigin(candidate) === normalized);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});
app.use(express.json());

function assertWorkerConfigured() {
  if (!WORKER_API_URL || !WORKER_ADMIN_PASSWORD) {
    const error = new Error("缺少 WORKER_API_URL 或 WORKER_ADMIN_PASSWORD。");
    error.status = 500;
    throw error;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearerToken(headerValue) {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function extractBasicAuth(req) {
  const value = req.headers.authorization;
  if (!value || !value.startsWith("Basic ")) return null;

  const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;

  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function rejectAdminAuth(res) {
  res.set("WWW-Authenticate", 'Basic realm="Temp Mail Admin", charset="UTF-8"');
  res.status(401).json({
    success: false,
    error: "ADMIN_AUTH_REQUIRED",
    message: "后台账号或密码不正确。",
  });
}

function requireAdminAuth(req, res, next) {
  const credentials = extractBasicAuth(req);
  if (!credentials) return rejectAdminAuth(res);

  const current = getAdminCredentials();
  if (!current.password) {
    return res.status(500).json({
      success: false,
      error: "ADMIN_PASSWORD_MISSING",
      message: "后台密码尚未配置。",
    });
  }

  if (!safeEqual(credentials.username, current.username) || !safeEqual(credentials.password, current.password)) {
    return rejectAdminAuth(res);
  }

  next();
}

function makeSessionExpiry(durationHours) {
  if (durationHours === -1) return null;
  return new Date(Date.now() + durationHours * 60 * 60 * 1000);
}

function isExpired(session) {
  return Boolean(session.expiresAt && session.expiresAt.getTime() <= Date.now());
}

function normalizeDurationHours(value) {
  if (value === "" || value === null || value === undefined) {
    return -1;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed === 0 || parsed < -1) {
    const error = new Error("时长必须是 -1 或正整数小时。");
    error.status = 400;
    throw error;
  }
  return parsed;
}

function normalizeMessages(payload) {
  const list =
    Array.isArray(payload) ? payload :
    Array.isArray(payload?.results) ? payload.results :
    Array.isArray(payload?.messages) ? payload.messages :
    Array.isArray(payload?.data) ? payload.data :
    Array.isArray(payload?.mails) ? payload.mails :
    [];

  return list.map(normalizeUpstreamMessage);
}

function normalizeMessageId(message) {
  const value =
    message?.id ??
    message?.message_id ??
    message?.messageId ??
    message?.mail_id ??
    message?.mailId ??
    message?.uid ??
    null;

  if (value === null || value === undefined || value === "") {
    return "";
  }

  return String(value);
}

function listDeletedMessageIds(sessionToken) {
  if (!sessionToken) return [];

  return rawDb
    .prepare('SELECT "messageId" FROM "DeletedMessage" WHERE "sessionToken" = ?')
    .all(sessionToken)
    .map((row) => String(row.messageId));
}

function rememberDeletedMessage(sessionToken, messageId) {
  if (!sessionToken || !messageId) return;

  rawDb
    .prepare(
      `INSERT INTO "DeletedMessage" ("sessionToken", "messageId")
       VALUES (?, ?)
       ON CONFLICT("sessionToken", "messageId") DO NOTHING`,
    )
    .run(sessionToken, String(messageId));
}

function clearDeletedMessages(sessionToken) {
  if (!sessionToken) return;

  rawDb.prepare('DELETE FROM "DeletedMessage" WHERE "sessionToken" = ?').run(sessionToken);
}

function normalizeCharset(charset) {
  const value = String(charset || "")
    .trim()
    .replace(/^"+|"+$/g, "")
    .toLowerCase();

  if (!value) return "utf-8";
  if (value === "utf8") return "utf-8";
  if (value === "gbk" || value === "gb2312" || value === "gb_2312-80") return "gb18030";
  return value;
}

function decodeBuffer(buffer, charset = "utf-8") {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const candidates = [normalizeCharset(charset), "utf-8", "gb18030"];

  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate).decode(source);
    } catch (_error) {
      // try next decoder
    }
  }

  return source.toString("utf8");
}

function decodeMimeWords(input) {
  if (!input) return "";

  return String(input).replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_m, charset, encoding, value) => {
    try {
      if (encoding.toLowerCase() === "b") {
        return decodeBuffer(Buffer.from(value, "base64"), charset);
      }

      const qp = value.replace(/_/g, " ").replace(/=([A-Fa-f0-9]{2})/g, (_x, hex) => String.fromCharCode(parseInt(hex, 16)));
      return decodeBuffer(Buffer.from(qp, "binary"), charset);
    } catch (_error) {
      return value;
    }
  });
}

function parseRawHeaders(raw) {
  if (!raw) return {};

  const headerBlock = String(raw).split(/\r?\n\r?\n/)[0] || "";
  const lines = headerBlock.split(/\r?\n/);
  const unfolded = [];

  for (const line of lines) {
    if (/^\s/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      continue;
    }

    unfolded.push(line);
  }

  const headers = {};

  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function decodeQuotedPrintableToBuffer(input) {
  if (!input) return "";

  const normalized = String(input).replace(/=\r?\n/g, "");
  const bytes = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (char === "=" && /^[A-Fa-f0-9]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }

    bytes.push(normalized.charCodeAt(index));
  }

  return Buffer.from(bytes);
}

function getCharsetFromContentType(contentType) {
  const match = String(contentType || "").match(/charset="?([^";]+)"?/i);
  return normalizeCharset(match?.[1] || "utf-8");
}

function decodeTransferBody(body, encoding = "", charset = "utf-8") {
  const normalizedEncoding = String(encoding || "").toLowerCase();

  try {
    if (normalizedEncoding.includes("base64")) {
      return decodeBuffer(Buffer.from(String(body || "").replace(/\s+/g, ""), "base64"), charset);
    }

    if (normalizedEncoding.includes("quoted-printable")) {
      return decodeBuffer(decodeQuotedPrintableToBuffer(body), charset);
    }
  } catch (_error) {
    return String(body || "");
  }

  return String(body || "");
}

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([A-Fa-f0-9]+);/g, (_match, value) => String.fromCodePoint(parseInt(value, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripHtmlTags(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|header|footer|h[1-6]|tr)>/gi, "\n")
      .replace(/<(p|div|section|article|header|footer|h[1-6]|table)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(td|th)\b[^>]*>/gi, "\t")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractMimeContent(raw) {
  if (!raw) {
    return {
      text: "",
      html: "",
    };
  }

  const [headerBlock, ...bodyParts] = String(raw).split(/\r?\n\r?\n/);
  const body = bodyParts.join("\n\n");
  const headers = parseRawHeaders(headerBlock);
  const contentType = headers["content-type"] || "";
  const transferEncoding = headers["content-transfer-encoding"] || "";
  const charset = getCharsetFromContentType(contentType);

  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);

  if (!boundaryMatch) {
    const decoded = decodeTransferBody(body, transferEncoding, charset);
    if (/text\/html/i.test(contentType)) {
      return { text: stripHtmlTags(decoded), html: decoded };
    }
    return { text: decoded.trim(), html: "" };
  }

  const boundary = boundaryMatch[1];
  const sections = body.split(new RegExp(`--${boundary}(?:--)?\\r?\\n`, "g"));

  let text = "";
  let html = "";

  for (const section of sections) {
    if (!section.trim()) continue;

    const [partHeaderBlock, ...partBodyParts] = section.split(/\r?\n\r?\n/);
    const partHeaders = parseRawHeaders(partHeaderBlock);
    const partBody = partBodyParts.join("\n\n");
    const partType = partHeaders["content-type"] || "";
    const partEncoding = partHeaders["content-transfer-encoding"] || "";
    const partCharset = getCharsetFromContentType(partType);
    const decoded = decodeTransferBody(partBody, partEncoding, partCharset).trim();

    if (!decoded) continue;

    if (/text\/plain/i.test(partType) && !text) {
      text = decoded;
    }

    if (/text\/html/i.test(partType) && !html) {
      html = decoded;
    }
  }

  if (!text && html) {
    text = stripHtmlTags(html);
  }

  return { text, html };
}

function normalizeUpstreamMessage(message) {
  const messageId = normalizeMessageId(message);
  const headers = parseRawHeaders(message?.raw);
  const subject = decodeMimeWords(message?.subject || headers.subject || "");
  const source = decodeMimeWords(message?.source || headers.from || "");
  const createdAt = message?.created_at || message?.createdAt || headers.date || "";
  const mime = extractMimeContent(message?.raw);
  const preview = (mime.text || stripHtmlTags(mime.html) || "").slice(0, 240);

  return {
    ...message,
    messageId,
    subject,
    source,
    createdAt,
    headerDate: headers.date || null,
    headerFrom: decodeMimeWords(headers.from || "") || null,
    headerTo: decodeMimeWords(headers.to || "") || null,
    bodyText: mime.text,
    bodyHtml: mime.html,
    preview,
  };
}

function extractUpstreamJwt(payload) {
  return payload?.jwt || payload?.token || payload?.data?.jwt || payload?.data?.token || null;
}

function extractUpstreamAddressId(payload) {
  return (
    payload?.addressId ||
    payload?.address_id ||
    payload?.id ||
    payload?.data?.addressId ||
    payload?.data?.address_id ||
    payload?.data?.id ||
    null
  );
}

function extractEmailAddress(payload, fallbackEmail) {
  return payload?.address || payload?.email || payload?.data?.address || payload?.data?.email || fallbackEmail;
}

function normalizeUpstreamAddressEntry(entry) {
  const id = entry?.id ?? entry?.addressId ?? entry?.address_id ?? entry?.data?.id ?? entry?.data?.addressId ?? null;
  const emailAddress =
    entry?.name ??
    entry?.address ??
    entry?.email ??
    entry?.data?.name ??
    entry?.data?.address ??
    entry?.data?.email ??
    null;

  return {
    id: id === null || id === undefined || id === "" ? null : String(id),
    emailAddress: emailAddress ? String(emailAddress).trim().toLowerCase() : "",
  };
}

function extractUpstreamAddressEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.addresses)) return payload.addresses;
  if (Array.isArray(payload?.data?.addresses)) return payload.data.addresses;
  return [];
}

async function fetchAllPaginatedUpstreamItems({ url, headers, params = {}, limit = 100, maxItems = 5000, extractor = extractUpstreamAddressEntries }) {
  const items = [];
  let offset = 0;
  let total = null;

  while ((total === null || offset < total) && offset < maxItems) {
    const response = await upstream.get(url, {
      headers,
      params: {
        ...params,
        limit,
        offset,
      },
    });

    const pageItems = extractor(response.data);
    if (!Array.isArray(pageItems) || !pageItems.length) {
      break;
    }

    items.push(...pageItems);

    const countValue =
      response.data?.count ??
      response.data?.total ??
      response.data?.data?.count ??
      response.data?.data?.total ??
      null;
    total = Number.isFinite(Number(countValue)) ? Number(countValue) : null;

    if (total === null && pageItems.length < limit) {
      break;
    }

    offset += pageItems.length;
  }

  return {
    results: items,
    count: total ?? items.length,
  };
}

function generateRedeemCode(prefix = "MAIL") {
  const safePrefix =
    String(prefix || "MAIL")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 12) || "MAIL";

  const middle = crypto.randomBytes(2).toString("hex").toUpperCase();
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${safePrefix}-${middle}-${suffix}`;
}

function extractDomainsFromPayload(payload) {
  const candidates = [
    payload,
    payload?.domains,
    payload?.data,
    payload?.data?.domains,
    payload?.result,
    payload?.result?.domains,
    payload?.config,
    payload?.config?.domains,
  ];

  for (const candidate of candidates) {
    if (!candidate || !Array.isArray(candidate)) continue;

    const values = candidate
      .map((item) => {
        if (typeof item === "string") return item;
        return item?.domain || item?.name || item?.value || null;
      })
      .filter(Boolean)
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);

    if (values.length) return [...new Set(values)];
  }

  return [];
}

function extractDomainsFromHtml(html) {
  if (typeof html !== "string") return [];
  const matches = html.match(/[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?/gi) || [];
  return [...new Set(matches.map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function fetchUpstreamDomains() {
  const attempts = [
    { url: "/open_api/settings", needsAdmin: false, responseType: "json", path: "domains" },
    { url: "/api/public-config", needsAdmin: false, responseType: "json" },
    { url: "/api/config", needsAdmin: false, responseType: "json" },
    { url: "/api/domains", needsAdmin: false, responseType: "json" },
    { url: "/domains", needsAdmin: false, responseType: "json" },
    { url: "/admin/domains", needsAdmin: true, responseType: "json" },
    { url: "/admin/config", needsAdmin: true, responseType: "json" },
    { url: "/admin", needsAdmin: true, responseType: "text" },
  ];

  for (const attempt of attempts) {
    try {
      const response = await upstream.get(attempt.url, {
        responseType: attempt.responseType,
        headers: attempt.needsAdmin
          ? {
              "x-admin-auth": WORKER_ADMIN_PASSWORD,
            }
          : undefined,
      });

      let domains = [];

      if (attempt.path === "domains" && Array.isArray(response.data?.domains)) {
        domains = response.data.domains
          .map((item) => String(item).trim().toLowerCase())
          .filter(Boolean);
      } else {
        domains =
          attempt.responseType === "text"
            ? extractDomainsFromHtml(response.data)
            : extractDomainsFromPayload(response.data);
      }

      if (domains.length) return domains;
    } catch (_error) {
      // continue
    }
  }

  return [];
}

async function syncDomainConfigs() {
  const upstreamDomains = await fetchUpstreamDomains();
  const now = new Date();

  if (upstreamDomains.length) {
    for (const domain of upstreamDomains) {
      await prisma.domainConfig.upsert({
        where: { domain },
        update: {
          isAvailable: true,
          source: "upstream",
          lastSeenAt: now,
        },
        create: {
          domain,
          isEnabled: true,
          isAvailable: true,
          source: "upstream",
          lastSeenAt: now,
        },
      });
    }

    await prisma.domainConfig.updateMany({
      where: {
        source: "upstream",
        domain: {
          notIn: upstreamDomains,
        },
      },
      data: {
        isAvailable: false,
      },
    });
  }

  const configs = await prisma.domainConfig.findMany({
    orderBy: [{ isEnabled: "desc" }, { isAvailable: "desc" }, { domain: "asc" }],
  });

  const publicDomains = configs
    .filter((item) => item.isEnabled && item.isAvailable)
    .map((item) => item.domain);

  cachedDomains = {
    value: publicDomains,
    expiresAt: Date.now() + DOMAIN_CACHE_TTL_MS,
  };

  return {
    domains: configs,
    publicDomains,
  };
}

async function getPublicDomains({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedDomains.value.length && cachedDomains.expiresAt > Date.now()) {
    return cachedDomains.value;
  }
  const result = await syncDomainConfigs();
  return result.publicDomains;
}

async function validateMailboxInput(prefix, domain) {
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(prefix)) {
    const error = new Error("邮箱前缀需为 2 到 32 位，并且只能包含字母、数字、点、横线或下划线。");
    error.status = 400;
    throw error;
  }

  if (!/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    const error = new Error("域名格式不正确。");
    error.status = 400;
    throw error;
  }

  const availableDomains = await getPublicDomains();
  if (availableDomains.length && !availableDomains.includes(String(domain).toLowerCase())) {
    const error = new Error("该域名当前不可用，请从系统提供的域名中选择。");
    error.status = 400;
    throw error;
  }
}

async function createUpstreamAddress(prefix, domain) {
  const response = await upstream.post(
    "/admin/new_address",
    { name: prefix, domain },
    {
      headers: {
        "x-admin-auth": WORKER_ADMIN_PASSWORD,
      },
    },
  );

  const jwt = extractUpstreamJwt(response.data);
  if (!jwt) {
    const error = new Error("上游系统没有返回邮箱令牌。");
    error.status = 502;
    throw error;
  }

  const emailAddress = extractEmailAddress(response.data, `${prefix}@${domain}`);
  let upstreamAddressId = extractUpstreamAddressId(response.data);

  if (!upstreamAddressId && emailAddress) {
    upstreamAddressId = await findUpstreamAddressIdByEmail(emailAddress);
  }

  return {
    upstreamJwt: jwt,
    upstreamAddressId,
    emailAddress,
  };
}

async function findUpstreamAddressIdByEmail(emailAddress) {
  const normalizedEmail = String(emailAddress || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const response = await fetchAllPaginatedUpstreamItems({
    url: "/admin/address",
    headers: {
      "x-admin-auth": WORKER_ADMIN_PASSWORD,
    },
    limit: 100,
    maxItems: 5000,
    extractor: extractUpstreamAddressEntries,
  });

  const normalizedResults = response.results.map(normalizeUpstreamAddressEntry);
  const matched = normalizedResults.find((item) => item.emailAddress === normalizedEmail && item.id);
  if (matched?.id) {
    return matched.id;
  }

  return null;
}

async function ensureMailboxAddressReusable(emailAddress, reuseTarget = null) {
  const normalizedEmail = String(emailAddress || "").trim().toLowerCase();
  if (!normalizedEmail) return null;

  const localSession = await prisma.activeSession.findFirst({
    where: { emailAddress: normalizedEmail },
    orderBy: { createdAt: "desc" },
  });

  let reclaimedMailbox = null;

  if (localSession) {
    await withKeyLock(`redeem-code:${localSession.redeemCode}`, async () => {
      const currentSession = await prisma.activeSession.findUnique({
        where: { sessionToken: localSession.sessionToken },
      });

      if (!currentSession) return;

      if (!isExpired(currentSession)) {
        const error = new Error("该邮箱地址仍在使用中，请更换前缀后重试。");
        error.status = 409;
        error.code = "MAILBOX_ADDRESS_IN_USE";
        throw error;
      }

      if (!reuseTarget?.redeemCode || !reuseTarget?.sessionToken) {
        await destroySession(currentSession);
        return;
      }

      const cleared = await clearUpstreamInbox(currentSession);
      if (!cleared.cleared) {
        if (cleared.reason === "missing_address_id") {
          await destroySession(currentSession);
          return;
        }

        const error = new Error("当前邮箱无法清空，请稍后重试或更换前缀。");
        error.status = 409;
        error.code = "MAILBOX_ADDRESS_CLEAR_FAILED";
        throw error;
      }

      clearDeletedMessages(currentSession.sessionToken);

      await prisma.$transaction([
        prisma.redeemCode.update({
          where: { code: reuseTarget.redeemCode },
          data: {
            isUsed: true,
            usedAt: new Date(),
          },
        }),
        prisma.activeSession.delete({
          where: { sessionToken: currentSession.sessionToken },
        }),
        prisma.activeSession.create({
          data: {
            sessionToken: reuseTarget.sessionToken,
            redeemCode: reuseTarget.redeemCode,
            emailAddress: currentSession.emailAddress,
            upstreamJwt: currentSession.upstreamJwt,
            upstreamAddressId: cleared.addressId || currentSession.upstreamAddressId,
            expiresAt: reuseTarget.expiresAt,
          },
        }),
      ]);

      saveRedeemCodeBinding(currentSession.redeemCode, currentSession.emailAddress);
      saveRedeemCodeBinding(reuseTarget.redeemCode, currentSession.emailAddress);
      reclaimedMailbox = {
        emailAddress: currentSession.emailAddress,
        upstreamJwt: currentSession.upstreamJwt,
        upstreamAddressId: cleared.addressId || currentSession.upstreamAddressId,
      };
    });
  }

  if (reclaimedMailbox) return reclaimedMailbox;

  const lingeringAddressId = await findUpstreamAddressIdByEmail(normalizedEmail);
  if (!lingeringAddressId) return null;

  const error = new Error("当前邮箱地址已存在，请更换前缀后再创建。");
  error.status = 409;
  error.code = "MAILBOX_ADDRESS_EXISTS_UPSTREAM";
  throw error;
}

async function persistResolvedAddressId(sessionToken, upstreamAddressId) {
  if (!sessionToken || !upstreamAddressId) return;

  await prisma.activeSession.update({
    where: { sessionToken },
    data: { upstreamAddressId: String(upstreamAddressId) },
  });
}

async function runUpstreamAddressAction(action, sessionOrTarget) {
  const sessionToken = sessionOrTarget?.sessionToken || null;
  const emailAddress = sessionOrTarget?.emailAddress || null;
  const triedIds = new Set();

  const execute = async (addressId) => {
    if (!addressId || triedIds.has(String(addressId))) return null;
    triedIds.add(String(addressId));

    try {
      await upstream.delete(`/admin/${action}/${encodeURIComponent(addressId)}`, {
        headers: {
          "x-admin-auth": WORKER_ADMIN_PASSWORD,
        },
      });

      if (sessionToken && String(sessionOrTarget?.upstreamAddressId || "") !== String(addressId)) {
        await persistResolvedAddressId(sessionToken, addressId);
      }

      return { ok: true, addressId: String(addressId) };
    } catch (error) {
      const status = error.response?.status;
      if ([400, 404].includes(status) && emailAddress) {
        return null;
      }
      throw error;
    }
  };

  const directResult = await execute(sessionOrTarget?.upstreamAddressId);
  if (directResult?.ok) return directResult;

  const resolvedAddressId = await findUpstreamAddressIdByEmail(emailAddress);
  const fallbackResult = await execute(resolvedAddressId);
  if (fallbackResult?.ok) return fallbackResult;

  return { ok: false, reason: "missing_address_id" };
}

async function deleteUpstreamAddress(sessionOrTarget) {
  const result = await runUpstreamAddressAction("delete_address", sessionOrTarget);
  if (!result.ok) {
    return { deleted: false, reason: result.reason || "missing_address_id" };
  }

  return { deleted: true };
}

async function clearUpstreamInbox(sessionOrTarget) {
  const sessionToken = sessionOrTarget?.sessionToken || null;
  const emailAddress = sessionOrTarget?.emailAddress || null;
  let addressId = sessionOrTarget?.upstreamAddressId ? String(sessionOrTarget.upstreamAddressId) : null;

  if (!addressId && emailAddress) {
    addressId = await findUpstreamAddressIdByEmail(emailAddress);
    if (sessionToken && addressId) {
      await persistResolvedAddressId(sessionToken, addressId);
    }
  }

  if (!addressId) {
    return { cleared: false, reason: "missing_address_id" };
  }

  await upstream.delete(`/admin/clear_inbox/${encodeURIComponent(addressId)}`, {
    headers: {
      "x-admin-auth": WORKER_ADMIN_PASSWORD,
    },
  });

  return { cleared: true, addressId: String(addressId) };
}

async function deleteUpstreamMessage(session, messageId) {
  if (!messageId) {
    return { deleted: false, reason: "missing_message_id" };
  }

  const encodedId = encodeURIComponent(messageId);
  const payload = {
    id: messageId,
    messageId,
    mailId: messageId,
    address: session.emailAddress,
    addressId: session.upstreamAddressId,
  };
  const attempts = [
    { method: "delete", url: `/admin/delete_mail/${encodedId}`, headers: { "x-admin-auth": WORKER_ADMIN_PASSWORD }, params: payload },
    { method: "delete", url: `/admin/delete_message/${encodedId}`, headers: { "x-admin-auth": WORKER_ADMIN_PASSWORD }, params: payload },
    { method: "delete", url: `/admin/mails/${encodedId}`, headers: { "x-admin-auth": WORKER_ADMIN_PASSWORD }, params: payload },
    { method: "delete", url: `/admin/messages/${encodedId}`, headers: { "x-admin-auth": WORKER_ADMIN_PASSWORD }, params: payload },
    { method: "post", url: "/admin/delete_mail", headers: { "x-admin-auth": WORKER_ADMIN_PASSWORD }, data: payload },
    { method: "post", url: "/admin/delete_message", headers: { "x-admin-auth": WORKER_ADMIN_PASSWORD }, data: payload },
    { method: "delete", url: `/user_api/mails/${encodedId}`, headers: { "x-user-token": session.upstreamJwt }, params: payload },
    { method: "delete", url: `/user_api/messages/${encodedId}`, headers: { "x-user-token": session.upstreamJwt }, params: payload },
    { method: "post", url: "/user_api/delete_mail", headers: { "x-user-token": session.upstreamJwt }, data: payload },
    { method: "delete", url: `/api/messages/${encodedId}`, headers: { Authorization: `Bearer ${session.upstreamJwt}` }, params: payload },
    { method: "delete", url: `/api/mails/${encodedId}`, headers: { Authorization: `Bearer ${session.upstreamJwt}` }, params: payload },
  ];

  let lastKnownError = null;

  for (const attempt of attempts) {
    try {
      await upstream.request({
        method: attempt.method,
        url: attempt.url,
        headers: attempt.headers,
        params: attempt.params,
        data: attempt.data,
      });

      return { deleted: true, upstreamDeleted: true };
    } catch (error) {
      const status = error.response?.status;
      if ([400, 401, 403, 404, 405].includes(status)) {
        lastKnownError = error;
        continue;
      }

      throw error;
    }
  }

  return {
    deleted: true,
    upstreamDeleted: false,
    reason: lastKnownError?.response?.data?.message || lastKnownError?.message || "upstream_delete_not_supported",
  };
}

async function fetchUpstreamMessages(upstreamJwt, emailAddress) {
  const attempts = [
    {
      url: "/admin/mails",
      headers: {
        "x-admin-auth": WORKER_ADMIN_PASSWORD,
      },
      params: {
        address: emailAddress,
      },
      paginated: true,
    },
    { url: "/user_api/mails", headers: { "x-user-token": upstreamJwt } },
    { url: "/api/messages", headers: { "x-user-token": upstreamJwt } },
    { url: "/api/mails", headers: { Authorization: `Bearer ${upstreamJwt}` } },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    try {
      if (attempt.paginated) {
        const paginatedResponse = await fetchAllPaginatedUpstreamItems({
          url: attempt.url,
          headers: attempt.headers,
          params: attempt.params,
          limit: 100,
          maxItems: 5000,
          extractor: extractUpstreamAddressEntries,
        });
        return paginatedResponse;
      }

      const response = await upstream.get(attempt.url, { headers: attempt.headers, params: attempt.params });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      if (![400, 401, 403, 404].includes(status)) throw error;
      lastError = error;
    }
  }

  throw lastError || new Error("获取邮件列表失败。");
}

async function markSessionDeleted(sessionToken, deleteResult) {
  await prisma.activeSession.update({
    where: { sessionToken },
    data: {
      upstreamDeletedAt: deleteResult.deleted ? new Date() : undefined,
      upstreamDeleteError: deleteResult.deleted ? null : deleteResult.reason || "delete_failed",
    },
  });
}

async function expireSessionIfNeeded(session) {
  if (!isExpired(session)) return false;
  await destroySession(session);
  return true;
}

async function cleanupSessionResources(session) {
  if (!session || session.upstreamDeletedAt) return { deleted: true, skipped: true };

  try {
    const deleteResult = await deleteUpstreamAddress(session);
    await markSessionDeleted(session.sessionToken, deleteResult);
    if (!deleteResult.deleted && deleteResult.reason !== "missing_address_id") {
      const error = new Error(deleteResult.reason || "Failed to delete upstream mailbox");
      error.code = "UPSTREAM_MAILBOX_DELETE_FAILED";
      error.status = 502;
      throw error;
    }
    return deleteResult;
  } catch (error) {
    await prisma.activeSession.update({
      where: { sessionToken: session.sessionToken },
      data: {
        upstreamDeleteError:
          error.response?.data?.message || error.message || "Failed to delete upstream mailbox",
      },
    });
    throw error;
  }
}

async function destroySession(session) {
  if (!session) return;

  await cleanupSessionResources(session);
  clearDeletedMessages(session.sessionToken);
  saveRedeemCodeBinding(session.redeemCode, session.emailAddress);

  await prisma.activeSession.delete({
    where: {
      sessionToken: session.sessionToken,
    },
  });

  await prisma.redeemCode.update({
    where: {
      code: session.redeemCode,
    },
    data: {
      isUsed: true,
      usedAt: new Date(),
    },
  });
}

async function sweepExpiredSessions({ limit = 100 } = {}) {
  if (!WORKER_API_URL || !WORKER_ADMIN_PASSWORD) {
    return { skipped: true, found: 0, cleaned: 0, failed: 0 };
  }

  const expiredSessions = await prisma.activeSession.findMany({
    where: {
      expiresAt: {
        not: null,
        lte: new Date(),
      },
    },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });

  let cleaned = 0;
  let failed = 0;

  for (const session of expiredSessions) {
    try {
      await withKeyLock(`redeem-code:${session.redeemCode}`, async () => {
        const currentSession = await prisma.activeSession.findUnique({
          where: { sessionToken: session.sessionToken },
        });

        if (!currentSession || !isExpired(currentSession)) return;
        await destroySession(currentSession);
        cleaned += 1;
      });
    } catch (error) {
      failed += 1;
      console.error(`[expired-session-sweep] Failed for ${session.emailAddress}:`, error.message || error);
    }
  }

  return {
    skipped: false,
    found: expiredSessions.length,
    cleaned,
    failed,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/public-config", async (_req, res) => {
  try {
    const domains = await getPublicDomains();
    res.json({
      domains,
      purchaseLink: getPurchaseLink(),
    });
  } catch (_error) {
    res.json({
      domains: [],
      purchaseLink: getPurchaseLink(),
    });
  }
});

app.get(`${ADMIN_PATH}/api/overview`, requireAdminAuth, async (_req, res, next) => {
  try {
    const [codes, sessions, domainState] = await Promise.all([
      prisma.redeemCode.findMany({
        orderBy: { createdAt: "desc" },
        include: { activeSession: true },
        take: 200,
      }),
      prisma.activeSession.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      syncDomainConfigs(),
    ]);
    const bindingMap = getRedeemCodeBindingMap(codes.map((item) => item.code));

    res.json({
      codes: codes.map((item) => ({
        ...item,
        lastBoundEmail: item.activeSession?.emailAddress || bindingMap.get(item.code) || null,
      })),
      sessions,
      domains: domainState.domains,
      publicDomains: domainState.publicDomains,
      settings: {
        username: getAdminCredentials().username,
        purchaseLink: getPurchaseLink(),
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/domains/sync`, requireAdminAuth, async (_req, res, next) => {
  try {
    const result = await syncDomainConfigs();
    res.json({
      success: true,
      domains: result.domains,
      publicDomains: result.publicDomains,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/sessions/:token/clear-messages`, requireAdminAuth, async (req, res, next) => {
  try {
    const session = await prisma.activeSession.findUnique({
      where: {
        sessionToken: String(req.params.token || "").trim(),
      },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "SESSION_NOT_FOUND",
        message: "会话不存在。",
      });
    }

    const clearResult = await clearUpstreamInbox(session);
    if (!clearResult.cleared) {
      return res.status(502).json({
        success: false,
        error: "UPSTREAM_ADDRESS_ID_NOT_FOUND",
        message: "未能在上游找到对应邮箱 ID，无法清空邮件。",
        emailAddress: session.emailAddress,
      });
    }

    clearDeletedMessages(session.sessionToken);

    res.json({
      success: true,
      addressId: clearResult.addressId || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/domains/:domain/toggle`, requireAdminAuth, async (req, res, next) => {
  try {
    const domain = String(req.params.domain || "").trim().toLowerCase();
    const isEnabled = Boolean(req.body?.isEnabled);

    const updated = await prisma.domainConfig.upsert({
      where: { domain },
      update: { isEnabled },
      create: {
        domain,
        isEnabled,
        isAvailable: false,
        source: "manual",
      },
    });

    cachedDomains.expiresAt = 0;
    res.json({
      success: true,
      domain: updated,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/domains/manual`, requireAdminAuth, async (req, res, next) => {
  try {
    const domains = String(req.body?.domains || "")
      .split(/[\s,]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    if (!domains.length) {
      return res.status(400).json({
        success: false,
        error: "DOMAINS_REQUIRED",
        message: "请至少输入一个域名。",
      });
    }

    for (const domain of domains) {
      await prisma.domainConfig.upsert({
        where: { domain },
        update: {
          isEnabled: true,
          isAvailable: true,
          source: "manual",
          lastSeenAt: new Date(),
        },
        create: {
          domain,
          isEnabled: true,
          isAvailable: true,
          source: "manual",
          lastSeenAt: new Date(),
        },
      });
    }

    cachedDomains.expiresAt = 0;
    const result = await syncDomainConfigs();

    res.json({
      success: true,
      domains: result.domains,
      publicDomains: result.publicDomains,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/settings/admin-auth`, requireAdminAuth, (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!username || !password || password.length < 4) {
      return res.status(400).json({
        success: false,
        error: "INVALID_ADMIN_AUTH",
        message: "后台账号不能为空，密码至少需要 4 位。",
      });
    }

    setConfigValue("admin_username", username);
    setConfigValue("admin_password", password);

    res.json({
      success: true,
      username,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/settings/purchase-link`, requireAdminAuth, (req, res, next) => {
  try {
    const rawLink = String(req.body?.purchaseLink || "").trim();

    if (rawLink) {
      let parsed = null;
      try {
        parsed = new URL(rawLink);
      } catch (_error) {
        parsed = null;
      }

      if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({
          success: false,
          error: "INVALID_PURCHASE_LINK",
          message: "购买链接必须是 http 或 https 地址。",
        });
      }
    }

    setConfigValue("purchase_link", rawLink);

    res.json({
      success: true,
      purchaseLink: rawLink,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/redeem-codes`, requireAdminAuth, async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim() || generateRedeemCode("MAIL");
    const durationHours = normalizeDurationHours(req.body?.durationHours);
    const created = await prisma.redeemCode.create({
      data: { code, durationHours },
    });

    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/sessions/:token/end`, requireAdminAuth, async (req, res, next) => {
  try {
    const sessionToken = String(req.params.token || "").trim();
    const session = await prisma.activeSession.findUnique({
      where: {
        sessionToken,
      },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "SESSION_NOT_FOUND",
        message: "会话不存在。",
      });
    }

    await withKeyLock(`redeem-code:${session.redeemCode}`, async () => {
      const currentSession = await prisma.activeSession.findUnique({
        where: { sessionToken },
      });

      if (!currentSession) {
        return;
      }

      await destroySession(currentSession);
    });

    res.json({
      success: true,
    });
  } catch (error) {
    next(error);
  }
});

app.post(`${ADMIN_PATH}/api/redeem-codes/batch`, requireAdminAuth, async (req, res, next) => {
  try {
    const prefix = String(req.body?.prefix || "MAIL");
    const count = Number(req.body?.count);
    const durationHours = normalizeDurationHours(req.body?.durationHours);

    if (!Number.isInteger(count) || count < 1 || count > 200) {
      return res.status(400).json({
        success: false,
        error: "INVALID_COUNT",
        message: "数量必须是 1 到 200 之间的整数。",
      });
    }

    const codes = [];
    while (codes.length < count) {
      const candidate = generateRedeemCode(prefix);
      const exists = await prisma.redeemCode.findUnique({ where: { code: candidate } });
      if (!exists) codes.push(candidate);
    }

    await prisma.redeemCode.createMany({
      data: codes.map((code) => ({ code, durationHours })),
    });

    res.status(201).json({
      success: true,
      codes,
      durationHours,
    });
  } catch (error) {
    next(error);
  }
});

app.delete(`${ADMIN_PATH}/api/redeem-codes/:code`, requireAdminAuth, async (req, res, next) => {
  try {
    const code = String(req.params.code || "").trim();
    const deleted = await withKeyLock(`redeem-code:${code}`, async () => {
      const record = await prisma.redeemCode.findUnique({
        where: { code },
        include: { activeSession: true },
      });

      if (!record) {
        return false;
      }

      if (record.activeSession) {
        await destroySession(record.activeSession);
      }

      await prisma.redeemCode.delete({ where: { code } });
      return true;
    });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "REDEEM_CODE_NOT_FOUND",
        message: "兑换码不存在。",
      });
    }

    res.json({
      success: true,
      deleted: code,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/redeem", async (req, res, next) => {
  try {
    assertWorkerConfigured();

    const code = String(req.body?.code || "").trim();
    const prefix = String(req.body?.prefix || "").trim();
    const domain = String(req.body?.domain || "").trim();

    if (!code) {
      return res.status(400).json({
        success: false,
        error: "REDEEM_CODE_REQUIRED",
        message: "请输入兑换码。",
      });
    }

    await withKeyLock(`redeem-code:${code}`, async () => {
      const redeemCode = await prisma.redeemCode.findUnique({
        where: { code },
        include: { activeSession: true },
      });

      if (!redeemCode) {
        return res.status(404).json({
          success: false,
          error: "REDEEM_CODE_NOT_FOUND",
          message: "兑换码不存在。",
        });
      }

      if (redeemCode.activeSession) {
        const expired = await expireSessionIfNeeded(redeemCode.activeSession);
        if (expired) {
          return res.status(403).json({
            success: false,
            error: "REDEEM_CODE_EXPIRED",
            message: "该兑换码对应的邮箱已经过期。",
          });
        }

        return res.json({
          success: true,
          reused: true,
          sessionToken: redeemCode.activeSession.sessionToken,
          emailAddress: redeemCode.activeSession.emailAddress,
          expiresAt: redeemCode.activeSession.expiresAt,
        });
      }

      if (redeemCode.isUsed) {
        return res.status(403).json({
          success: false,
          error: "REDEEM_CODE_ALREADY_USED",
          message: "该兑换码已经使用过，不能再次兑换。",
        });
      }

      if (!prefix || !domain) {
        return res.status(400).json({
          success: false,
          error: "SETUP_REQUIRED",
          message: "首次使用该兑换码，请填写邮箱前缀并选择域名。",
        });
      }

      await validateMailboxInput(prefix, domain);
      const sessionToken = crypto.randomUUID();
      const expiresAt = makeSessionExpiry(redeemCode.durationHours);
      const mailbox = await ensureMailboxAddressReusable(`${prefix}@${domain}`, { redeemCode: code, sessionToken, expiresAt });

      if (mailbox) {
        return res.json({
          success: true,
          reused: false,
          reclaimed: true,
          sessionToken,
          emailAddress: mailbox.emailAddress,
          expiresAt,
        });
      }

      const createdMailbox = await createUpstreamAddress(prefix, domain);

      try {
        await prisma.$transaction([
          prisma.redeemCode.update({
            where: { code },
            data: {
              isUsed: true,
              usedAt: new Date(),
            },
          }),
          prisma.activeSession.create({
            data: {
              sessionToken,
              redeemCode: code,
              emailAddress: createdMailbox.emailAddress,
              upstreamJwt: createdMailbox.upstreamJwt,
              upstreamAddressId: createdMailbox.upstreamAddressId,
              expiresAt,
            },
          }),
        ]);
        saveRedeemCodeBinding(code, createdMailbox.emailAddress);
      } catch (error) {
        try {
          await deleteUpstreamAddress(createdMailbox);
        } catch (_cleanupError) {
          // best effort
        }
        throw error;
      }

      return res.json({
        success: true,
        reused: false,
        sessionToken,
        emailAddress: createdMailbox.emailAddress,
        expiresAt,
      });
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/session/end", async (req, res, next) => {
  try {
    const sessionToken = extractBearerToken(req.headers.authorization);

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        error: "SESSION_TOKEN_REQUIRED",
        message: "缺少会话令牌。",
      });
    }

    const session = await prisma.activeSession.findUnique({
      where: {
        sessionToken,
      },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "SESSION_NOT_FOUND",
        message: "会话不存在。",
      });
    }

    await withKeyLock(`redeem-code:${session.redeemCode}`, async () => {
      const currentSession = await prisma.activeSession.findUnique({
        where: { sessionToken },
      });

      if (!currentSession) {
        return;
      }

      await destroySession(currentSession);
    });

    res.json({
      success: true,
    });
  } catch (error) {
    next(error);
  }
});

async function handleClearMessages(req, res, next) {
  try {
    const sessionToken = extractBearerToken(req.headers.authorization);

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        error: "SESSION_TOKEN_REQUIRED",
        message: "缺少会话令牌。",
      });
    }

    const session = await prisma.activeSession.findUnique({
      where: {
        sessionToken,
      },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "SESSION_NOT_FOUND",
        message: "会话不存在。",
      });
    }

    const clearResult = await clearUpstreamInbox(session);
    if (!clearResult.cleared) {
      return res.status(502).json({
        success: false,
        error: "UPSTREAM_ADDRESS_ID_NOT_FOUND",
        message: "未能在上游找到对应邮箱 ID，无法清空邮件。",
        emailAddress: session.emailAddress,
      });
    }

    clearDeletedMessages(session.sessionToken);

    res.json({
      success: true,
      addressId: clearResult.addressId || null,
    });
  } catch (error) {
    next(error);
  }
}

app.delete("/api/messages/clear", handleClearMessages);
app.post("/api/messages/clear", handleClearMessages);

app.delete("/api/messages/:id", async (req, res, next) => {
  try {
    const sessionToken = extractBearerToken(req.headers.authorization);

    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        error: "SESSION_TOKEN_REQUIRED",
        message: "缺少会话令牌。",
      });
    }

    const session = await prisma.activeSession.findUnique({
      where: { sessionToken },
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        error: "SESSION_NOT_FOUND",
        message: "会话不存在。",
      });
    }

    const messageId = String(req.params.id || "").trim();
    if (!messageId) {
      return res.status(400).json({
        success: false,
        error: "MESSAGE_ID_REQUIRED",
        message: "缺少邮件 ID。",
      });
    }

    const deleteResult = await deleteUpstreamMessage(session, messageId);
    rememberDeletedMessage(session.sessionToken, messageId);

    res.json({
      success: true,
      deleted: true,
      upstreamDeleted: deleteResult.upstreamDeleted,
      mode: deleteResult.upstreamDeleted ? "upstream" : "local",
      reason: deleteResult.reason || null,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/messages", async (req, res, next) => {
  try {
    assertWorkerConfigured();

    const sessionToken = extractBearerToken(req.headers.authorization);
    if (!sessionToken) {
      return res.status(401).json({
        success: false,
        error: "SESSION_TOKEN_REQUIRED",
        message: "缺少会话令牌。",
      });
    }

    const session = await prisma.activeSession.findUnique({
      where: { sessionToken },
    });

    if (!session) {
      return res.status(403).json({
        success: false,
        error: "SESSION_NOT_FOUND",
        message: "会话不存在或已经失效。",
      });
    }

    const expired = await expireSessionIfNeeded(session);
    if (expired) {
      return res.status(403).json({
        success: false,
        error: "SESSION_EXPIRED",
        message: "您的专属邮箱时长已耗尽。",
      });
    }

    const upstreamPayload = await fetchUpstreamMessages(session.upstreamJwt, session.emailAddress);
    const deletedIds = new Set(listDeletedMessageIds(session.sessionToken));
    const normalizedMessages = normalizeMessages(upstreamPayload).filter((message) => {
      const messageId = normalizeMessageId(message);
      return !messageId || !deletedIds.has(messageId);
    });

    res.json({
      messages: normalizedMessages,
      raw: upstreamPayload,
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const status = error.status || error.response?.status || 500;
  const upstreamMessage = error.response?.data?.message || error.response?.data?.error;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    success: false,
    error: error.code || "REQUEST_FAILED",
    message: upstreamMessage || error.message || "请求失败。",
  });
});

app.listen(PORT, () => {
  console.log(`Mail gateway listening on http://localhost:${PORT}`);
  console.log(`Admin console path: ${ADMIN_PATH}`);

  sweepExpiredSessions()
    .then((result) => {
      if (!result.skipped && result.found) {
        console.log(`[expired-session-sweep] startup found=${result.found} cleaned=${result.cleaned} failed=${result.failed}`);
      }
    })
    .catch((error) => {
      console.error("[expired-session-sweep] startup failed:", error.message || error);
    });

  if (EXPIRED_SESSION_SWEEP_INTERVAL_MS > 0) {
    const timer = setInterval(() => {
      sweepExpiredSessions().catch((error) => {
        console.error("[expired-session-sweep] interval failed:", error.message || error);
      });
    }, EXPIRED_SESSION_SWEEP_INTERVAL_MS);

    timer.unref?.();
    console.log(`[expired-session-sweep] enabled interval=${EXPIRED_SESSION_SWEEP_INTERVAL_MS}ms`);
  }
});
