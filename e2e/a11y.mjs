// Проверка доступности (axe-core, WCAG 2.2 A/AA + best practices) ключевых экранов
// в том же Chromium и с той же подменой сети, что и e2e/run.mjs.
// Запуск: npm run test:a11y  (или npx vite build && node e2e/a11y.mjs [метка]);
// только часть экранов: A11Y_ONLY=home,nudge_sheet node e2e/a11y.mjs
// Итог — таблица по экранам и по важности (critical / serious / moderate / minor),
// подробности — в e2e/shots/<метка>.json (по умолчанию a11y.json).
// Код выхода 0: это отчёт, а не барьер; экран не открылся — код 1.
// Известное и пока не исправленное:
//  - meta-viewport: user-scalable=no в index.html — решение по масштабированию в Telegram;
//  - label-content-name-mismatch на кнопке «Техника выполнения»: значок «ⓘ» (aria-hidden)
//    axe нормализует в букву «i» и считает видимым текстом — для диктора имя верное.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { OUT, API, TG_ID, tapSetDone, VIEWPORTS, makeScenario,
         HOME, PREMIUM, STRENGTH, PROG_LIST, PROG_DETAIL, SOCIAL, FEED, WN_NET, SOCIAL_SETTINGS } from "./harness.mjs";

const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const LABEL = process.argv[2] || "a11y";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"];
const IMPACTS = ["critical", "serious", "moderate", "minor"];
const N = (extra = {}) => ({ setMode: "ok", setBodies: [], counts: {}, ...extra });
const VP = VIEWPORTS[1];

async function axe(page) {
  await page.waitForTimeout(400);   // анимации появления (opacity) — до проверки контраста
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async (tags) => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, tags: v.tags.filter(t => /^wcag|best/.test(t)), help: v.help,
      nodes: v.nodes.map(n => ({ target: n.target.join(" "), html: n.html.slice(0, 160), summary: (n.failureSummary || "").split("\n").slice(1, 3).join(" ").slice(0, 200) })) }));
  }, TAGS);
}
// Пользователь без согласий / новичок — поверх общей подмены
const userRoute = (body, status = 200) => async (page) => {
  await page.route(`${API}/user/${TG_ID}`, r => r.request().method() === "OPTIONS"
    ? r.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } })
    : r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) }));
};
const NO_CONSENT = { id: 1, telegram_id: TG_ID, first_name: "Игорь", profile_complete: true, lang: "ru", consents: {}, ai_requests_today: 0 };

const SCREENS = [
  ["home", { tab: "menu", screen: null, net: N({ home: HOME, premium: PREMIUM }) }, p => p.getByText("Каталог", { exact: true }).waitFor()],
  ["more", { tab: "menu", screen: "more", net: N({ premium: PREMIUM }) }, p => p.getByText("Правила использования").first().waitFor()],
  ["workout_set", {}, p => p.getByText("ПОДХОД 2 / 4").waitFor()],
  ["technique_sheet", {}, async p => { await p.getByRole("button", { name: /ТЕХНИКА ВЫПОЛНЕНИЯ/ }).click(); await p.getByRole("dialog").waitFor(); await p.getByText(/Контроль опускания/).waitFor(); }],
  ["rest_timer", {}, async p => { await p.getByText("ПОДХОД 2 / 4").waitFor(); await tapSetDone(p); await p.getByText("ПОДХОД 3 / 4").waitFor(); }],
  ["workout_finish", {}, async p => { await p.getByText("ПОДХОД 2 / 4").waitFor(); await p.getByRole("button", { name: "ЗАВЕРШИТЬ", exact: true }).first().click(); await p.getByText("ПОДЕЛИТЬСЯ").waitFor(); await p.waitForTimeout(800); }],
  ["workouts_tab", { tab: "workout", screen: null }, p => p.waitForTimeout(800)],
  ["workout_detail", { tab: "menu", screen: "workout_detail", params: { workoutId: 555 } }, p => p.getByText(/Жим штанги лёжа/).first().waitFor()],
  ["catalog", { tab: "catalog", screen: null }, p => p.getByText("Жим штанги лёжа").first().waitFor()],
  ["exercise_detail", { tab: "catalog", screen: null }, async p => { await p.getByText("Жим штанги лёжа").first().click(); await p.getByText(/Контроль опускания/).waitFor(); }],
  ["progress", { tab: "progress", screen: null, net: N({ strength: STRENGTH }) }, p => p.getByText(/Средний · /).first().waitFor()],
  ["strength", { tab: "menu", screen: "strength", net: N({ strength: STRENGTH }) }, p => p.getByText("Общий ранг").waitFor()],
  ["nutrition", { tab: "menu", screen: "nutrition" }, p => p.getByText("СЕГОДНЯ", { exact: true }).waitFor()],
  ["food_photo", { tab: "menu", screen: "food_vision", net: N({ foodQuota: { used: 3, limit: 10 } }) }, p => p.waitForTimeout(600)],
  ["food_photo_result", { tab: "menu", screen: "food_vision", net: N({ foodQuota: { used: 3, limit: 10 } }) }, async p => {
    await p.locator('input[type="file"]').first().setInputFiles(path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/photo.jpg"));
    await p.getByRole("button", { name: /ГОТОВО/ }).click(); await p.getByRole("button", { name: /АНАЛИЗИРОВАТЬ/ }).click(); await p.getByText("Плов").first().waitFor(); }],
  ["label_scan", { tab: "menu", screen: "label_scan", params: { meal_type: "lunch" } }, p => p.waitForTimeout(600)],
  ["food_search", { tab: "menu", screen: "food_search" }, p => p.waitForTimeout(800)],
  ["ai_chat", { tab: "ai", screen: null }, p => p.waitForTimeout(1000)],
  ["programs", { tab: "menu", screen: "programs", net: N({ programs: PROG_LIST }) }, p => p.getByText("ВАША ПРОГРАММА").waitFor()],
  ["program_detail", { tab: "menu", screen: "program_detail", params: { slug: "fullbody_beginner" }, net: N({ programs: PROG_LIST, programDetail: PROG_DETAIL }) }, p => p.getByText("ДНИ ПРОГРАММЫ").waitFor()],
  ["social_feed", { tab: "menu", screen: "social", net: N({ social: SOCIAL, feed: FEED }) }, p => p.getByText(/Рекорд: Жим штанги лёжа/).waitFor()],
  ["social_friends", { tab: "menu", screen: "social", params: { tab: "friends" }, net: N({ social: SOCIAL_SETTINGS, feed: FEED }) }, p => p.getByText("Дана").waitFor()],
  ["invite_confirm", { tab: "menu", screen: "social", params: { accept: "ANNA0002" }, net: N({ social: SOCIAL, feed: FEED }) }, p => p.getByText("Анна приглашает вас в друзья").waitFor()],
  ["team_board", { tab: "menu", screen: "social", params: { join: "TEAM0007" }, net: N({ social: SOCIAL, feed: FEED }) }, async p => {
    await p.getByRole("button", { name: "Вступить", exact: true }).click(); await p.getByText("РЕЙТИНГ НЕДЕЛИ").waitFor(); }],
  ["nudge_sheet", { tab: "menu", screen: "social", params: { tab: "friends" }, net: N({ social: SOCIAL_SETTINGS, feed: FEED }) }, async p => {
    await p.getByText("Борис").waitFor(); await p.getByRole("button", { name: /Напомнить/ }).first().click(); await p.getByRole("dialog").waitFor(); }],
  ["premium", { tab: "menu", screen: "premium", net: N({ premium: PREMIUM }) }, p => p.getByText("GymBot Premium").waitFor()],
  ["profile", { tab: "menu", screen: "profile" }, p => p.getByText("Баллы").waitFor()],
  ["language", { tab: "menu", screen: "language" }, p => p.waitForTimeout(600)],
  ["consent_gate", { tab: "menu", screen: null, before: userRoute(NO_CONSENT) }, p => p.getByText(/СОГЛАС/i).first().waitFor()],
  ["onboarding", { tab: "menu", screen: null, before: userRoute({ detail: "nf" }, 404) }, p => p.waitForTimeout(800)],
  ["whats_new", { tab: "menu", screen: null, net: WN_NET() }, p => p.getByRole("dialog").waitFor()],
];

const results = [];
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const scenario = makeScenario(browser, results);
const only = process.env.A11Y_ONLY ? new Set(process.env.A11Y_ONLY.split(",")) : null;
for (const [name, opts, reach] of SCREENS) {
  if (only && !only.has(name)) continue;
  await scenario("a11y_" + name, VP, { ...opts }, async (page) => {
    await reach(page);
    return { screen: name, lang: await page.evaluate(() => document.documentElement.lang), violations: await axe(page) };
  });
}
await browser.close();

// ── Итог ──
let broken = 0;
const total = Object.fromEntries(IMPACTS.map(i => [i, 0]));
const wcagOnly = Object.fromEntries(IMPACTS.map(i => [i, 0]));
const byRule = {};
const uniq = new Map();   // правило + разметка: шапка/меню на каждом экране считаются один раз
console.log(`axe-core ${JSON.parse(fs.readFileSync(require.resolve("axe-core/package.json"), "utf8")).version}, ${VP.name}, ${TAGS.join(" ")}\n`);
console.log("экран".padEnd(20) + IMPACTS.map(i => i.padStart(10)).join("") + "   правила");
for (const r of results) {
  if (!r.violations) { broken++; console.log(`${(r.screen || r.name).padEnd(20)} НЕ ОТКРЫЛСЯ: ${(r.errors || []).join("; ").slice(0, 200)}`); continue; }
  const row = Object.fromEntries(IMPACTS.map(i => [i, 0]));
  for (const v of r.violations) {
    row[v.impact] += v.nodes.length; total[v.impact] += v.nodes.length;
    if (v.tags.some(t => t.startsWith("wcag"))) wcagOnly[v.impact] += v.nodes.length;
    const b = byRule[v.id] = byRule[v.id] || { impact: v.impact, help: v.help, wcag: v.tags.some(t => t.startsWith("wcag")), nodes: 0, screens: new Set() };
    b.nodes += v.nodes.length; b.screens.add(r.screen);
    for (const n of v.nodes) uniq.set(v.id + "|" + n.html, v.impact);
  }
  console.log(r.screen.padEnd(20) + IMPACTS.map(i => String(row[i]).padStart(10)).join("") + "   " + r.violations.map(v => v.id).join(", ") + (r.errors?.length ? `   [ошибки: ${r.errors.length}]` : ""));
}
const uniqBy = Object.fromEntries(IMPACTS.map(i => [i, [...uniq.values()].filter(x => x === i).length]));
console.log("\n" + "ВСЕГО (узлы)".padEnd(20) + IMPACTS.map(i => String(total[i]).padStart(10)).join(""));
console.log("только WCAG".padEnd(20) + IMPACTS.map(i => String(wcagOnly[i]).padStart(10)).join(""));
console.log("уникальные".padEnd(20) + IMPACTS.map(i => String(uniqBy[i]).padStart(10)).join(""));
console.log("\nПравила:");
for (const [id, b] of Object.entries(byRule).sort((a, b) => IMPACTS.indexOf(a[1].impact) - IMPACTS.indexOf(b[1].impact) || b[1].nodes - a[1].nodes))
  console.log(`  ${b.impact.padEnd(9)} ${id.padEnd(28)} ${String(b.nodes).padStart(4)} узл. на ${b.screens.size} экр.${b.wcag ? "" : " (best practice)"} — ${b.help}`);
fs.writeFileSync(path.join(OUT, LABEL + ".json"), JSON.stringify({ total, wcagOnly, unique: uniqBy, results }, null, 2));
console.log(`\nПодробно: e2e/shots/${LABEL}.json`);
process.exit(broken ? 1 : 0);
