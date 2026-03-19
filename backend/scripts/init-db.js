require("dotenv").config();

const path = require("node:path");

const Database = require("better-sqlite3");

function resolveSqlitePath(databaseUrl) {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must use a SQLite file: URL.");
  }

  const rawPath = databaseUrl.slice("file:".length);
  return path.resolve(process.cwd(), rawPath);
}

function main() {
  const dbPath = resolveSqlitePath(process.env.DATABASE_URL);
  const db = new Database(dbPath);

  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS "RedeemCode" (
      "code" TEXT NOT NULL PRIMARY KEY,
      "durationHours" INTEGER NOT NULL,
      "isUsed" BOOLEAN NOT NULL DEFAULT 0,
      "usedAt" DATETIME,
      "lastBoundEmail" TEXT,
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
  `);

  const hasLastBoundEmail = db
    .prepare(`PRAGMA table_info("RedeemCode")`)
    .all()
    .some((item) => item.name === "lastBoundEmail");

  if (!hasLastBoundEmail) {
    db.exec(`ALTER TABLE "RedeemCode" ADD COLUMN "lastBoundEmail" TEXT`);
  }

  console.log(`Initialized SQLite database at ${dbPath}`);
  db.close();
}

main();
