const crypto = require("node:crypto");

function randomToken(size = 24) {
  return crypto.randomBytes(size).toString("hex");
}

console.log("Suggested backend secrets:");
console.log(`ADMIN_PATH="/_${randomToken(8)}"`);
console.log(`ADMIN_USERNAME="admin"`);
console.log(`ADMIN_PANEL_PASSWORD="${randomToken(12)}"`);
console.log(`WORKER_ADMIN_PASSWORD="replace-with-your-cloudflare-worker-admin-password"`);
