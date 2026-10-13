import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://fallen-angel-ruby.vercel.app").replace(/\/$/, "");
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${FRONTEND_URL}/auth/callback`;
const DISCORD_INSTALL_REDIRECT_URI = process.env.DISCORD_INSTALL_REDIRECT_URI || `${FRONTEND_URL}/auth/install/callback`;
const DISCORD_BOT_PERMISSIONS = process.env.DISCORD_BOT_PERMISSIONS || "0";

let pool;
let schemaPromise;
function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured in Vercel Environment Variables.");
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
  return pool;
}
async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = db().query(`
      CREATE TABLE IF NOT EXISTS fa_sessions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fa_oauth_states (
        state TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fa_sessions_expiry_idx ON fa_sessions (expires_at);
      CREATE INDEX IF NOT EXISTS fa_oauth_states_expiry_idx ON fa_oauth_states (expires_at);
    `).catch((error) => { schemaPromise = null; throw error; });
  }
  return schemaPromise;
}
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("hex"); }
function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}
function setCookie(res, name, value, maxAge) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; HttpOnly; Secure${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [...(existing ? (Array.isArray(existing) ? existing : [existing]) : []), cookie]);
}
function clearCookie(res, name) { setCookie(res, name, "", 0); }
function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}
function redirect(res, url) { res.statusCode = 302; res.setHeader("Location", url); res.setHeader("Cache-Control", "no-store"); res.end(); }
function canManageGuild(guild) {
  if (guild.owner === true) return true;
  try {
    const permissions = BigInt(guild.permissions_new || guild.permissions || "0");
    return (permissions & 0x20n) === 0x20n;
  } catch { return false; }
}
async function discordRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { data = body; }
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}
async function exchangeCode(code, redirectUri = DISCORD_REDIRECT_URI) {
  const body = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri });
  return discordRequest("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
}
async function getDiscordUser(accessToken) {
  return discordRequest("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${accessToken}` } });
}
async function getDiscordGuilds(accessToken) {
  return discordRequest("https://discord.com/api/v10/users/@me/guilds", { headers: { Authorization: `Bearer ${accessToken}` } });
}
async function botIsInGuild(guildId) {
  if (!DISCORD_BOT_TOKEN) return false;
  try {
    await discordRequest(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`, { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` } });
    return true;
  } catch { return false; }
}
async function buildGuildList(accessToken) {
  const guilds = await getDiscordGuilds(accessToken);
  return Promise.all(guilds.filter(canManageGuild).map(async (guild) => ({
    id: guild.id, name: guild.name, icon: guild.icon, owner: guild.owner,
    permissions: guild.permissions_new || guild.permissions || "0",
    installed: await botIsInGuild(guild.id),
  })));
}
async function getSession(req) {
  const id = parseCookies(req).fa_session;
  if (!id) return null;
  const result = await db().query("SELECT data FROM fa_sessions WHERE id = $1 AND expires_at > NOW()", [id]);
  if (!result.rowCount) {
    await db().query("DELETE FROM fa_sessions WHERE id = $1", [id]).catch(() => {});
    return null;
  }
  return result.rows[0].data;
}
async function storeState(state, kind, data, ttlSeconds = 600) {
  await db().query("INSERT INTO fa_oauth_states (state, kind, data, expires_at) VALUES ($1, $2, $3::jsonb, NOW() + ($4 * INTERVAL '1 second'))", [state, kind, JSON.stringify(data), ttlSeconds]);
}
async function consumeState(state, kind) {
  if (!state) return null;
  const result = await db().query("DELETE FROM fa_oauth_states WHERE state = $1 AND kind = $2 AND expires_at > NOW() RETURNING data", [state, kind]);
  return result.rowCount ? result.rows[0].data : null;
}
async function routeRequest(req, res) {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return json(res, 500, { error: "Discord OAuth credentials are not configured." });
  await ensureSchema();
  const parsed = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const route = parsed.searchParams.get("route");
  if (!route) return json(res, 404, { error: "Not found." });
  const pathname = route.startsWith("/") ? route : `/${route}`;
  // Keep original callback query values while using the rewritten route path.
  const url = new URL(`https://local.invalid${pathname}`);
  for (const [key, value] of parsed.searchParams.entries()) if (key !== "route") url.searchParams.append(key, value);

  if (pathname === "/auth/install" && req.method === "GET") {
    const requestedReturn = url.searchParams.get("return_to");
    const returnTo = requestedReturn === "dashboard" ? "dashboard" : "home";
    const state = randomToken(24);
    const sessionId = parseCookies(req).fa_session || null;
    await storeState(state, "install", { returnTo, sessionId });
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, scope: "bot applications.commands", permissions: DISCORD_BOT_PERMISSIONS, integration_type: "0", response_type: "code", redirect_uri: DISCORD_INSTALL_REDIRECT_URI, state });
    return redirect(res, `https://discord.com/oauth2/authorize?${params}`);
  }
  if (pathname === "/auth/install/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const stateData = await consumeState(url.searchParams.get("state"), "install");
    if (!code || !stateData) return json(res, 400, { error: "Invalid or expired installation session. Start the installation again." });
    try {
      await exchangeCode(code, DISCORD_INSTALL_REDIRECT_URI);
      if (stateData.sessionId) {
        const result = await db().query("SELECT data FROM fa_sessions WHERE id = $1 AND expires_at > NOW()", [stateData.sessionId]);
        if (result.rowCount && result.rows[0].data.accessToken) {
          const data = result.rows[0].data;
          data.guilds = await buildGuildList(data.accessToken);
          await db().query("UPDATE fa_sessions SET data = $2::jsonb WHERE id = $1", [stateData.sessionId, JSON.stringify(data)]);
        }
      }
      return redirect(res, `${FRONTEND_URL}${stateData.returnTo === "dashboard" ? "/?view=servers" : "/"}`);
    } catch (error) {
      console.error("Bot installation callback failed:", error);
      return json(res, 500, { error: "Could not complete the installation callback." });
    }
  }
  if (pathname === "/auth/discord" && req.method === "GET") {
    const state = randomToken(24);
    await storeState(state, "login", {});
    setCookie(res, "fa_oauth_state", state, 600);
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, response_type: "code", redirect_uri: DISCORD_REDIRECT_URI, scope: "identify guilds", state });
    return redirect(res, `https://discord.com/oauth2/authorize?${params}`);
  }
  if (pathname === "/auth/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return json(res, 400, { error: "Missing OAuth code or state." });
    if (parseCookies(req).fa_oauth_state !== state) return json(res, 400, { error: "Invalid OAuth state. Please restart Discord login." });
    const stateData = await consumeState(state, "login");
    if (!stateData) return json(res, 400, { error: "OAuth session expired. Please restart Discord login." });
    try {
      const token = await exchangeCode(code);
      const user = await getDiscordUser(token.access_token);
      const guilds = await buildGuildList(token.access_token);
      const sessionId = randomToken();
      const sessionData = { accessToken: token.access_token, user: { id: user.id, username: user.username, global_name: user.global_name, avatar: user.avatar }, guilds };
      await db().query("INSERT INTO fa_sessions (id, data, expires_at) VALUES ($1, $2::jsonb, NOW() + INTERVAL '24 hours')", [sessionId, JSON.stringify(sessionData)]);
      setCookie(res, "fa_session", sessionId, 86400);
      clearCookie(res, "fa_oauth_state");
      return redirect(res, `${FRONTEND_URL}/?authenticated=1`);
    } catch (error) {
      console.error("Discord OAuth error:", error);
      return json(res, 500, { error: "Discord authorization failed. Check your redirect URLs and environment variables." });
    }
  }
  if (pathname === "/auth/logout" && req.method === "GET") {
    const sessionId = parseCookies(req).fa_session;
    if (sessionId) await db().query("DELETE FROM fa_sessions WHERE id = $1", [sessionId]);
    clearCookie(res, "fa_session");
    return redirect(res, FRONTEND_URL);
  }
  if (pathname === "/api/session" && req.method === "GET") {
    const session = await getSession(req);
    return json(res, 200, session ? { authenticated: true, user: session.user, guilds: session.guilds } : { authenticated: false });
  }
  const statusMatch = pathname.match(/^\/api\/guilds\/([^/]+)\/status$/);
  if (statusMatch && req.method === "GET") {
    const session = await getSession(req);
    if (!session) return json(res, 401, { error: "Not authenticated." });
    const guild = (session.guilds || []).find((item) => item.id === statusMatch[1]);
    if (!guild) return json(res, 403, { error: "You cannot manage this server." });
    const installed = await botIsInGuild(statusMatch[1]);
    guild.installed = installed;
    const sessionId = parseCookies(req).fa_session;
    await db().query("UPDATE fa_sessions SET data = $2::jsonb WHERE id = $1", [sessionId, JSON.stringify(session)]);
    return json(res, 200, { installed });
  }
  const inviteMatch = pathname.match(/^\/api\/guilds\/([^/]+)\/invite$/);
  if (inviteMatch && req.method === "GET") {
    const session = await getSession(req);
    if (!session) return json(res, 401, { error: "Not authenticated." });
    const guildId = inviteMatch[1];
    if (!(session.guilds || []).some((item) => item.id === guildId)) return json(res, 403, { error: "You cannot manage this server." });
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, scope: "bot applications.commands", permissions: DISCORD_BOT_PERMISSIONS, guild_id: guildId, disable_guild_select: "true", integration_type: "0" });
    return json(res, 200, { url: `https://discord.com/oauth2/authorize?${params}` });
  }
  return json(res, 404, { error: "Not found." });
}

export default async function handler(req, res) {
  try {
    await routeRequest(req, res);
  } catch (error) {
    console.error("FallenAngel API error:", error);
    if (!res.headersSent) json(res, 500, { error: "Internal server error. Check Vercel Function Logs." });
    else res.end();
  }
}
