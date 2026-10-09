import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3001);
const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:5173";

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI ||
  "http://localhost:3001/auth/callback";

const DISCORD_INSTALL_REDIRECT_URI =
  process.env.DISCORD_INSTALL_REDIRECT_URI ||
  "http://localhost:3001/auth/install/callback";

const installStates = new Map();

const DISCORD_BOT_PERMISSIONS =
  process.env.DISCORD_BOT_PERMISSIONS || "0";

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
  console.error("Missing Discord OAuth credentials.");
  console.error("Check your .env file.");
  process.exit(1);
}

if (!DISCORD_BOT_TOKEN) {
  console.warn("Warning: DISCORD_BOT_TOKEN is missing.");
}

const sessions = new Map();
const oauthStates = new Map();

const COOKIE_SECURE =
  process.env.NODE_ENV === "production" ? "; Secure" : "";

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";

  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function setCookie(res, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || "/"}`,
    `SameSite=${options.sameSite || "Lax"}`,
  ];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  if (COOKIE_SECURE) {
    parts.push("Secure");
  }

  const cookie = parts.join("; ");

  const existing = res.getHeader("Set-Cookie");

  if (existing) {
    const cookies = Array.isArray(existing)
      ? existing
      : [existing];

    res.setHeader("Set-Cookie", [
      ...cookies,
      cookie,
    ]);
  } else {
    res.setHeader("Set-Cookie", [cookie]);
  }
}

function clearCookie(res, name) {
  setCookie(res, name, "", {
    maxAge: 0,
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  res.writeHead(302, {
    Location: url,
  });

  res.end();
}

function getSession(req) {
  const cookies = parseCookies(req);

  if (!cookies.fa_session) {
    return null;
  }

  return sessions.get(cookies.fa_session) || null;
}

function createSession(data) {
  const id = randomToken();

  sessions.set(id, {
    ...data,
    createdAt: Date.now(),
  });

  return id;
}

function canManageGuild(guild) {
  if (guild.owner === true) {
    return true;
  }

  const permissions =
    BigInt(guild.permissions_new || guild.permissions || "0");

  const MANAGE_GUILD = 0x20n;

  return (permissions & MANAGE_GUILD) === MANAGE_GUILD;
}

async function discordRequest(url, options = {}) {
  const response = await fetch(url, options);

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Discord API ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function exchangeCode(
  code,
  redirectUri = DISCORD_REDIRECT_URI
) {
  const body = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    client_secret: DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  return discordRequest(
    "https://discord.com/api/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );
}

async function getDiscordUser(accessToken) {
  return discordRequest(
    "https://discord.com/api/v10/users/@me",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
}

async function getDiscordGuilds(accessToken) {
  return discordRequest(
    "https://discord.com/api/v10/users/@me/guilds",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );
}

async function botIsInGuild(guildId) {
  if (!DISCORD_BOT_TOKEN) {
    return false;
  }

  try {
    await discordRequest(
      `https://discord.com/api/v10/guilds/${guildId}`,
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        },
      }
    );

    return true;
  } catch {
    return false;
  }
}

async function buildGuildList(accessToken) {
  const guilds = await getDiscordGuilds(accessToken);

  const manageable = guilds.filter(canManageGuild);

  const results = await Promise.all(
    manageable.map(async (guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner,
      permissions:
        guild.permissions_new ||
        guild.permissions ||
        "0",
      installed: await botIsInGuild(guild.id),
    }))
  );

  return results;
}

function findGuild(session, guildId) {
  return session.guilds.find(
    (guild) => guild.id === guildId
  );
}

function handleAuthInstall(req, res, url) {
  const requestedReturn =
    url.searchParams.get("return_to");

  const returnTo =
    requestedReturn === "dashboard"
      ? "dashboard"
      : "home";

  const state = randomToken(24);
  const session = getSession(req);
  const cookies = parseCookies(req);

  installStates.set(state, {
    returnTo,
    sessionId: cookies.fa_session || null,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    scope: "bot applications.commands",
    permissions: DISCORD_BOT_PERMISSIONS,
    integration_type: "0",
    response_type: "code",
    redirect_uri: DISCORD_INSTALL_REDIRECT_URI,
    state,
  });

  redirect(
    res,
    `https://discord.com/oauth2/authorize?${params.toString()}`
  );
}

async function handleInstallCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateData = state
    ? installStates.get(state)
    : null;

  if (!code || !stateData) {
    return json(res, 400, {
      error: "Invalid or expired installation session.",
    });
  }

  installStates.delete(state);

  try {
    await exchangeCode(
      code,
      DISCORD_INSTALL_REDIRECT_URI
    );

    const session = stateData.sessionId
      ? sessions.get(stateData.sessionId)
      : null;

    if (session?.accessToken) {
      session.guilds = await buildGuildList(
        session.accessToken
      );
    }

    const destination =
      stateData.returnTo === "dashboard"
        ? "/?view=servers"
        : "/";

    redirect(res, `${FRONTEND_URL}${destination}`);
  } catch (error) {
    console.error("Bot installation callback failed:", error);

    json(res, 500, {
      error: "Could not complete the installation callback.",
    });
  }
}

async function handleAuthDiscord(req, res) {
  const state = randomToken(24);

  oauthStates.set(state, {
    createdAt: Date.now(),
  });

  setCookie(res, "fa_oauth_state", state, {
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: "identify guilds",
    state,
  });

  redirect(
    res,
    `https://discord.com/oauth2/authorize?${params.toString()}`
  );
}

async function handleAuthCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const cookies = parseCookies(req);

  if (!code || !state) {
    return json(res, 400, {
      error: "Missing OAuth code or state.",
    });
  }

  if (
    !cookies.fa_oauth_state ||
    cookies.fa_oauth_state !== state
  ) {
    return json(res, 400, {
      error: "Invalid OAuth state.",
    });
  }

  const stateData = oauthStates.get(state);

  if (!stateData) {
    return json(res, 400, {
      error: "OAuth session expired.",
    });
  }

  oauthStates.delete(state);

  try {
    const token = await exchangeCode(code);

    const user = await getDiscordUser(
      token.access_token
    );

    const guilds = await buildGuildList(
      token.access_token
    );

    const sessionId = createSession({
     accessToken: token.access_token,
      user: {
      id: user.id,
      username: user.username,
      global_name: user.global_name,
      avatar: user.avatar,
    },
      guilds,
    });

    setCookie(res, "fa_session", sessionId, {
      maxAge: 60 * 60 * 24,
    });

    clearCookie(res, "fa_oauth_state");

    redirect(
      res,
      `${FRONTEND_URL}/?authenticated=1`
    );
  } catch (error) {
    console.error("Discord OAuth error:", error);

    json(res, 500, {
      error: "Discord authorization failed.",
    });
  }
}

async function handleSession(req, res) {
  const session = getSession(req);

  if (!session) {
    return json(res, 200, {
      authenticated: false,
    });
  }

  json(res, 200, {
    authenticated: true,
    user: session.user,
    guilds: session.guilds,
  });
}

async function handleGuildStatus(req, res, guildId) {
  const session = getSession(req);

  if (!session) {
    return json(res, 401, {
      error: "Not authenticated.",
    });
  }

  const guild = findGuild(session, guildId);

  if (!guild) {
    return json(res, 403, {
      error: "You cannot manage this server.",
    });
  }

  const installed = await botIsInGuild(guildId);

  guild.installed = installed;

  json(res, 200, {
    installed,
  });
}

async function handleGuildInvite(req, res, guildId) {
  const session = getSession(req);

  if (!session) {
    return json(res, 401, {
      error: "Not authenticated.",
    });
  }

  const guild = findGuild(session, guildId);

  if (!guild) {
    return json(res, 403, {
      error: "You cannot manage this server.",
    });
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    scope: "bot applications.commands",
    permissions: DISCORD_BOT_PERMISSIONS,
    guild_id: guildId,
    disable_guild_select: "true",
    integration_type: "0",
  });

  json(res, 200, {
    url: `https://discord.com/oauth2/authorize?${params.toString()}`,
  });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);

  if (cookies.fa_session) {
    sessions.delete(cookies.fa_session);
  }

  clearCookie(res, "fa_session");

  redirect(res, FRONTEND_URL);
}

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();

  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

  return types[ext] || "application/octet-stream";
}

function serveProductionFile(req, res, pathname) {
  const dist = path.join(__dirname, "dist");

  if (!fs.existsSync(dist)) {
    return json(res, 404, {
      error: "Frontend build not found.",
    });
  }

  let requested = pathname;

  if (requested === "/") {
    requested = "/index.html";
  }

  const filePath = path.resolve(
    dist,
    "." + requested
  );

  if (!filePath.startsWith(path.resolve(dist))) {
    return json(res, 403, {
      error: "Forbidden.",
    });
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
    });

    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const index = path.join(dist, "index.html");

  res.writeHead(200, {
    "Content-Type": "text/html",
  });

  fs.createReadStream(index).pipe(res);
}

const server = http.createServer(
  async (req, res) => {
    try {
      const url = new URL(
        req.url,
        `http://${req.headers.host}`
      );

      const pathname = url.pathname;

      if (
       pathname === "/auth/install" &&
      req.method === "GET"
      ) {
      return handleAuthInstall(req, res, url);
      }
      
      if (
       pathname === "/auth/install/callback" &&
      req.method === "GET"
      ) {
      return handleInstallCallback(req, res, url);
      }

      if (
        pathname === "/auth/discord" &&
        req.method === "GET"
      ) {
        return handleAuthDiscord(req, res);
      }

      if (
        pathname === "/auth/callback" &&
        req.method === "GET"
      ) {
        return handleAuthCallback(
          req,
          res,
          url
        );
      }

      if (
        pathname === "/auth/logout" &&
        req.method === "GET"
      ) {
        return handleLogout(req, res);
      }

      if (
        pathname === "/api/session" &&
        req.method === "GET"
      ) {
        return handleSession(req, res);
      }

      const statusMatch = pathname.match(
        /^\/api\/guilds\/([^/]+)\/status$/
      );

      if (
        statusMatch &&
        req.method === "GET"
      ) {
        return handleGuildStatus(
          req,
          res,
          statusMatch[1]
        );
      }

      const inviteMatch = pathname.match(
        /^\/api\/guilds\/([^/]+)\/invite$/
      );

      if (
        inviteMatch &&
        req.method === "GET"
      ) {
        return handleGuildInvite(
          req,
          res,
          inviteMatch[1]
        );
      }

      if (process.env.NODE_ENV === "production") {
        return serveProductionFile(
          req,
          res,
          pathname
        );
      }

      json(res, 404, {
        error: "Not found.",
      });
    } catch (error) {
      console.error(error);

      json(res, 500, {
        error: "Internal server error.",
      });
    }
  }
);


server.listen(PORT, "0.0.0.0", () => {
  console.log(`FallenAngel backend running on port ${PORT}`);
});

if (process.env.NODE_ENV !== "production") {
  const npmCommand =
    process.platform === "win32"
      ? "npm.cmd"
      : "npm";

  const vite = spawn(
    npmCommand,
    ["run", "dev:web"],
    {
      stdio: "inherit",
      shell: true,
    }
  );

  process.on("SIGINT", () => {
    vite.kill();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    vite.kill();
    process.exit(0);
  });
}