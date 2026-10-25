#!/usr/bin/env node
// Эхо-бот: отвечает на каждое текстовое сообщение тем же текстом.
//   ETHER_URL=wss://your-relay.example node examples/echo-bot.js
// Личность и сессии хранятся в ./echo-bot.state.json и ./echo-bot.identity.json (права 0600) — удалите, чтобы начать заново.
// Добавить бота в приложении: откройте ссылку, которую бот печатает при запуске (она содержит id бота; ключ приложение берёт из присутствия).
"use strict";
const fs = require("fs");
const { Client, generateIdentity } = require("../index.cjs");

const IDENTITY_FILE = process.env.ETHER_IDENTITY || "./echo-bot.identity.json";
(async () => {
  let identity;
  try { identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8")); }
  catch (e) { identity = await generateIdentity({ name: "Echo" }); fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity), { mode: 0o600 }); }
  const bot = new Client({ url: process.env.ETHER_URL || "ws://localhost:8787", identity, statePath: process.env.ETHER_STATE || "./echo-bot.state.json", log: process.env.DEBUG ? console.log : undefined });
  bot.on("message", async ({ from, text }) => {
    if (text == null) return; // не текст (квитанции, наклейки и т.д.)
    await bot.sendText(from, "echo: " + text);
  });
  bot.on("key-changed", ({ id }) => console.warn("ключ контакта изменился, сообщения отвергнуты до подтверждения:", id));
  bot.on("decrypt-error", (e) => console.warn("не удалось расшифровать:", e.reason));
  bot.on("error", (e) => console.error(e.message));
  await bot.connect();
  console.log("echo-bot online as", identity.id);
  console.log("добавить в приложении:", bot.contactLink(process.env.ETHER_APP_URL || "https://arthurhuskyman.github.io/ether/"));
})().catch((e) => { console.error(e); process.exit(1); });
