const fs = require("fs");
const path = require("path");

function inboxDir() {
  return path.join(
    process.env.HOME || process.env.USERPROFILE,
    ".ufoo",
    "online",
    "inbox"
  );
}

function inboxFilePath(nickname) {
  return path.join(inboxDir(), `${nickname}.jsonl`);
}

/**
 * Find all inbox files for a given nickname (including room/channel-namespaced ones).
 * Returns array of { file, route } objects.
 */
function findInboxFiles(nickname) {
  const dir = inboxDir();
  if (!fs.existsSync(dir)) return [];
  const prefix = `${nickname}__`;
  const exact = `${nickname}.jsonl`;
  const results = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    if (name === exact) {
      results.push({ file: path.join(dir, name), route: "" });
    } else if (name.startsWith(prefix)) {
      const route = name.slice(prefix.length, -".jsonl".length);
      results.push({ file: path.join(dir, name), route });
    }
  }
  return results;
}

function readMarkerPath(nickname) {
  return path.join(inboxDir(), `${nickname}.read`);
}

function outboxFilePath(nickname) {
  const dir = path.join(
    process.env.HOME || process.env.USERPROFILE,
    ".ufoo",
    "online",
    "outbox"
  );
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${nickname}.jsonl`);
}

function send(nickname, options = {}) {
  if (!nickname) {
    console.error("nickname is required");
    process.exitCode = 1;
    return;
  }
  const text = options.text || "";
  if (!text) {
    console.error("--text is required");
    process.exitCode = 1;
    return;
  }
  const msg = { text };
  if (options.channel) msg.channel = options.channel;
  if (options.room) msg.room = options.room;
  if (!msg.channel && !msg.room) {
    console.error("--channel or --room is required");
    process.exitCode = 1;
    return;
  }

  const file = outboxFilePath(nickname);
  fs.appendFileSync(file, JSON.stringify(msg) + "\n");
  const target = msg.channel ? `channel ${msg.channel}` : `room ${msg.room}`;
  console.log(`Queued to ${target}: ${text}`);
}

const RETENTION_MS = {
  channel: 7 * 24 * 60 * 60 * 1000,   // 7 days
  room:    30 * 24 * 60 * 60 * 1000,   // 30 days
};

function cleanupInbox(file) {
  if (!fs.existsSync(file)) return;
  const now = Date.now();
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const kept = [];
  for (const line of lines) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const source = msg._source || "channel";
    const maxAge = RETENTION_MS[source];
    const age = now - new Date(msg._receivedAt || 0).getTime();
    if (age < maxAge) kept.push(line);
  }
  fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
}

function checkInbox(nickname, options = {}) {
  const clear = options.clear || false;
  const unreadOnly = options.unread || false;
  const filterRoom = options.room || "";
  const filterChannel = options.channel || "";

  if (!nickname) {
    console.error("nickname is required");
    process.exitCode = 1;
    return;
  }

  const markerFile = readMarkerPath(nickname);

  // Gather all inbox files for this nickname
  const inboxFiles = findInboxFiles(nickname);

  if (clear) {
    let cleared = 0;
    for (const { file } of inboxFiles) {
      if (fs.existsSync(file)) { fs.unlinkSync(file); cleared++; }
    }
    console.log(cleared > 0 ? `Inbox cleared for ${nickname} (${cleared} file(s)).` : `No inbox file for ${nickname}.`);
    return;
  }

  let messages = [];
  for (const { file } of inboxFiles) {
    cleanupInbox(file);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  }

  // Filter by room/channel if specified
  if (filterRoom) {
    messages = messages.filter((m) => m.room === filterRoom);
  } else if (filterChannel) {
    messages = messages.filter((m) => m.channel === filterChannel);
  }

  function displayWidth(str) {
    let w = 0;
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0x303e) ||
        (cp >= 0x3040 && cp <= 0x33bf) ||
        (cp >= 0x3400 && cp <= 0x4dbf) ||
        (cp >= 0x4e00 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff01 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f9ff) ||
        (cp >= 0x20000 && cp <= 0x2fa1f)
      ) {
        w += 2;
      } else {
        w += 1;
      }
    }
    return w;
  }

  function padRight(str, width) {
    const dw = displayWidth(str);
    if (dw >= width) return str;
    return str + " ".repeat(width - dw);
  }

  const W = 50;

  function hline(left, fill, right) {
    return left + fill.repeat(W) + right;
  }

  function row(text) {
    return "\u2551 " + padRight(text, W - 2) + " \u2551";
  }

  let lastRead = "";
  try {
    lastRead = fs.readFileSync(markerFile, "utf-8").trim();
  } catch {
    // no marker
  }

  const unreadMessages = lastRead
    ? messages.filter((m) => (m._receivedAt || "") > lastRead)
    : messages;

  const displayMessages = unreadOnly ? unreadMessages : messages;
  const count = displayMessages.length;
  const unreadCount = unreadMessages.length;
  const label = unreadOnly ? "unread" : "message";
  const unreadTag = unreadCount > 0 ? `, ${unreadCount} unread` : "";
  const title = `\ud83d\udcec Inbox: ${nickname}  (${count} ${label}${count !== 1 ? "s" : ""}${unreadOnly ? "" : unreadTag})`;

  console.log(hline("\u2554", "\u2550", "\u2557"));
  console.log(row(title));

  if (count === 0) {
    console.log(hline("\u2560", "\u2550", "\u2563"));
    console.log(row("(empty)"));
    console.log(hline("\u255a", "\u2550", "\u255d"));
    markAsRead(markerFile);
    return;
  }

  displayMessages.forEach((msg, i) => {
    console.log(hline("\u2560", "\u2550", "\u2563"));

    const from = msg.from || msg.subscriberId || "unknown";
    const time = msg._receivedAt
      ? msg._receivedAt.replace("T", " ").replace(/\.\d+Z$/, "")
      : "?";
    const isUnread = !lastRead || (msg._receivedAt || "") > lastRead;
    const marker = isUnread ? " [NEW]" : "";

    const source = msg._source || "channel";
    const sourceTag = source === "room"
      ? ` [${msg.room || "room"}]`
      : ` [${msg.channel || "channel"}]`;

    console.log(row(`#${i + 1}  from: ${from}${sourceTag}${marker}`));
    console.log(row(`    time: ${time}`));
    console.log(row("    " + "\u2500".repeat(Math.min(W - 6, 37))));

    let body = "";
    if (msg.payload) {
      if (typeof msg.payload === "string") {
        body = msg.payload;
      } else if (msg.payload.message) {
        body = msg.payload.message;
      } else {
        body = JSON.stringify(msg.payload);
      }
    } else {
      body = JSON.stringify(msg);
    }

    const maxLine = W - 6;
    const bodyLines = [];
    for (const rawLine of body.split("\n")) {
      if (displayWidth(rawLine) <= maxLine) {
        bodyLines.push(rawLine);
      } else {
        let cur = "";
        for (const ch of rawLine) {
          if (displayWidth(cur + ch) > maxLine) {
            bodyLines.push(cur);
            cur = ch;
          } else {
            cur += ch;
          }
        }
        if (cur) bodyLines.push(cur);
      }
    }

    for (const line of bodyLines) {
      console.log(row("    " + line));
    }
  });

  console.log(hline("\u255a", "\u2550", "\u255d"));
  markAsRead(markerFile);
}

function markAsRead(markerFile) {
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, new Date().toISOString());
}

module.exports = { send, checkInbox };
