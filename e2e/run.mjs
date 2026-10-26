// Сценарии приложения в настоящем Chromium (практика AiEvent: e2e/shots).
// Сеть целиком подменена: Telegram SDK — заглушка, API и R2 — фикстуры.
// Запуск: npm run build && node e2e/run.mjs. Падает с кодом 1, если хоть одна
// проверка из e2e/checks.mjs не прошла или в консоли страницы была ошибка.
// Скриншоты — в e2e/shots (в GitHub — артефакт прогона).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { CHECKS } from "./checks.mjs";
import { ROOT, OUT, API, TG_ID, catalog, groups, tapSetDone, VIEWPORTS, makeScenario,
         HOME, PREMIUM, STRENGTH, PROG_LIST, PROG_DETAIL, TEAM, SOCIAL, SOCIAL_NUDGE, FEED, WN_NET, SOCIAL_SETTINGS } from "./harness.mjs";

const results = [];
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const scenario = makeScenario(browser, results);

for (const vp of VIEWPORTS) {
  await scenario("01_set_screen", vp, {}, async (page) => {
    await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
    return { hasPhoto: await page.locator('button[aria-label^="ТЕХНИКА ВЫПОЛНЕНИЯ"] img').count(), lastTime: await page.getByText(/Прошлый раз · 2 дн\. назад/).count(), weightPrefill: await page.locator('input[type=number]').first().inputValue() };
  });
}
await scenario("01b_set_screen_scrolled", VIEWPORTS[0], {}, async (page) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await page.mouse.wheel(0, 600); await page.waitForTimeout(300);
});
await scenario("02_sheet", VIEWPORTS[1], {}, async (page, net) => {
  await page.locator('button[aria-label^="ТЕХНИКА ВЫПОЛНЕНИЯ"]').click();
  await page.getByRole("dialog").waitFor();
  const bb = await page.evaluate(() => window.Telegram.WebApp.BackButton.isVisible);
  await page.getByText(/Контроль опускания 3 секунды/).waitFor({ timeout: 3000 });
  await page.waitForTimeout(300);
  return { dialog: await page.getByRole("dialog").count(), backButtonShown: bb, techniqueLoaded: true, detailsRequests: net.details, batch: net.batch, catalogLite: net.catalogLite, haptics: await page.evaluate(() => window.__haptics || []) };
});
await scenario("02b_sheet_closed_by_back", VIEWPORTS[1], {}, async (page) => {
  await page.locator('button[aria-label^="ТЕХНИКА ВЫПОЛНЕНИЯ"]').click();
  await page.getByRole("dialog").waitFor();
  await page.evaluate(() => window.Telegram.WebApp.BackButton._h.forEach(f => f()));
  await page.waitForTimeout(200);
  return { dialogAfterBack: await page.getByRole("dialog").count(), backButtonHidden: !(await page.evaluate(() => window.Telegram.WebApp.BackButton.isVisible)) };
});
await scenario("03_photo_missing", VIEWPORTS[1], { curIdx: 2 }, async (page) => {
  await page.waitForTimeout(500);
  return { fallbackRow: await page.getByRole("button", { name: /ТЕХНИКА ВЫПОЛНЕНИЯ/ }).count(), brokenImg: await page.locator('img[src*="missing"]').count() };
});
await scenario("04_set_offline_queue", VIEWPORTS[1], { setFails: true }, async (page, net) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  const t0 = Date.now();
  await tapSetDone(page);
  await page.getByText("ПОДХОД 3 / 4").waitFor({ timeout: 1500 });
  const instantMs = Date.now() - t0;
  await page.getByText(/Ждут отправки: 1/).waitFor({ timeout: 6000 });
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("gymbot_set_queue") || "[]").length);
  // связь вернулась — повтор по нажатию на строку
  net.setMode = "ok";
  await page.getByText(/Ждут отправки/).dispatchEvent("click");
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("gymbot_set_queue") || "[]").length);
  return { instantMs, queued, afterRetryQueue: after, serverGot: net.setBodies.length, body: net.setBodies[0], indicatorGone: (await page.getByText(/Ждут отправки/).count()) === 0 };
});
await scenario("05_kz", VIEWPORTS[1], { lang: "kz" }, async (page) => {
  await page.waitForTimeout(600);
  return { setDoneKz: await page.getByText("✓ ТӘСІЛ ОРЫНДАЛДЫ").count(), lastTimeKz: await page.getByText(/Өткен жолы/).count(), groupKz: await page.getByText(/КЕУДЕ/).count() };
});

await scenario("06_log_then_next", VIEWPORTS[1], {}, async (page) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await tapSetDone(page);
  await page.getByText("ПОДХОД 3 / 4").waitFor({ timeout: 4000 });
  await page.waitForTimeout(300);
  const inputs = page.locator('input[type=number]');
  const afterLog = [await inputs.nth(0).inputValue(), await inputs.nth(1).inputValue()];
  await page.getByRole("button", { name: /СЛЕД/ }).dispatchEvent("click");
  await page.waitForTimeout(500);
  const nextEx = await page.locator("h1,h2,div").filter({ hasText: /^Жим гантелей/i }).count();
  const afterNext = [await inputs.nth(0).inputValue(), await inputs.nth(1).inputValue()];
  return { afterLog, afterNext, nextEx, haptics: await page.evaluate(() => window.__haptics || []) };
});

await scenario("07_requests_per_workout", VIEWPORTS[1], {}, async (page, net) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await page.waitForTimeout(800);
  for (let k = 0; k < 2; k++) {
    await tapSetDone(page);
    await page.waitForTimeout(300);
    await page.mouse.click(20, 20);     // пропустить отдых — кнопка Telegram вернётся
    await page.waitForTimeout(1400);    // больше защиты от двойного тапа (1,2 с)
  }
  await page.waitForTimeout(2500);      // дебаунс сохранения состояния 1,5 с
  const afterSets = { ...net.counts };
  await page.getByRole("button", { name: /СЛЕД/ }).dispatchEvent("click");
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /СЛЕД/ }).dispatchEvent("click");
  await page.waitForTimeout(2500);
  return { afterSets, afterNav: net.counts, setsSent: net.setBodies.map(b => b.set_number) };
});

await scenario("08_cancel_after_set", VIEWPORTS[1], {}, async (page, net) => {
  net.delaySet = 1500;
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  await tapSetDone(page);
  await page.waitForTimeout(150);
  await page.mouse.click(20, 20);          // тап по фону таймера — «пропустить отдых»
  await page.waitForTimeout(3500);
  return { order: net.order, sets: net.setBodies.length, ageMs: net.setBodies[0]?.age_ms };
});
await scenario("09_double_tap", VIEWPORTS[1], {}, async (page, net) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  // Второе касание доходит до приложения раньше, чем Telegram успел спрятать кнопку
  await tapSetDone(page); await page.waitForTimeout(150); await tapSetDone(page);
  await page.waitForTimeout(2000);
  return { setsSent: net.setBodies.map(x => x.set_number), screenSet: await page.getByText(/ПОДХОД \d \/ 4/).innerText() };
});

await scenario("10_home_instant_from_disk", VIEWPORTS[1], { tab: "menu", screen: null, swr: { [API + "/home/" + TG_ID]: HOME, [API + "/user/" + TG_ID]: { id: 1, telegram_id: TG_ID, first_name: "Игорь", profile_complete: true, lang: "ru", consents: { terms: true, basic: true }, ai_requests_today: 0 } }, net: { setMode: "ok", setBodies: [], counts: {}, homeDelay: 3000, home: HOME } }, async (page, net) => {
  await page.waitForTimeout(400);
  const loaderAt400 = await page.getByText("ЗАГРУЗКА").count();
  return { loaderAt400 };
});
await scenario("11_home_no_disk_cache", VIEWPORTS[1], { tab: "menu", screen: null, net: { setMode: "ok", setBodies: [], counts: {}, homeDelay: 3000, home: HOME } }, async (page, net) => {
  await page.waitForTimeout(400);
  return { loaderAt400: await page.getByText("ЗАГРУЗКА").count() };
});

await scenario("12_offline_start_keeps_cached_user", VIEWPORTS[1], { tab: "menu", screen: null, swr: { [API + "/home/" + TG_ID]: HOME, [API + "/user/" + TG_ID]: { id: 1, telegram_id: TG_ID, first_name: "Игорь", profile_complete: true, lang: "ru", consents: { terms: true, basic: true }, ai_requests_today: 0 } }, net: { setMode: "ok", setBodies: [], counts: {}, userFail: true, home: HOME } }, async (page, net) => {
  await page.waitForTimeout(1500);
  const disk = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gymbot_swr:")));
  return { consentGate: await page.getByText(/СОГЛАС/i).count(), navBar: await page.getByText(/КАТАЛОГ/i).count(), disk };
});
await scenario("13_health_not_on_disk", VIEWPORTS[1], { tab: "menu", screen: null, net: { setMode: "ok", setBodies: [], counts: {}, home: HOME } }, async (page, net) => {
  await page.waitForTimeout(1500);
  const raw = await page.evaluate((k) => localStorage.getItem(k), "gymbot_swr:" + API + "/user/" + TG_ID);
  return { stored: !!raw, hasMedical: /medical_conditions|allergies/.test(raw || ""), hasConsents: /consents/.test(raw || "") };
});

const DISK_USER = { id: 1, telegram_id: TG_ID, first_name: "Игорь", profile_complete: true, lang: "ru", consents: { terms: true, basic: true }, ai_requests_today: 0 };
await scenario("14_prime_then_offline_sheet", VIEWPORTS[1], { liteSaved: true }, async (page, net) => {
  await page.waitForTimeout(800);
  const batch = net.batch ? [...net.batch] : [];
  net.detailsFail = true; net.details = [];
  await page.locator('button[aria-label^="ТЕХНИКА ВЫПОЛНЕНИЯ"]').click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(400);
  const shown = await page.getByText(/Контроль опускания 3 секунды/).count();
  const onDisk = await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes("/details?lang=")).length);
  return { batch, shownOffline: shown, onDisk, singleRequestsWhileOffline: net.details.length };
});
await scenario("15_sheet_offline_no_cache", VIEWPORTS[1], { liteSaved: true, net: { setMode: "ok", setBodies: [], counts: {}, detailsFail: true } }, async (page, net) => {
  await page.locator('button[aria-label^="ТЕХНИКА ВЫПОЛНЕНИЯ"]').click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(600);
  const msg = await page.getByText(/Техника загрузится, когда появится связь/).count();
  net.detailsFail = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByText(/Контроль опускания 3 секунды/).waitFor({ timeout: 3000 });
  return { offlineMsg: msg, loadedAfterOnline: 1 };
});
await scenario("16_disk_catalog_still_retries", VIEWPORTS[1], { tab: "catalog", screen: null, swr: { [API + "/exercises?lang=ru&lite=1"]: { exercises: catalog.map(e => ({ ...e, technique: null, has_technique: true })), muscle_groups: groups } }, net: { setMode: "ok", setBodies: [], counts: {}, catalogFail: true } }, async (page, net) => {
  const shownFromDisk = await page.getByText("Жим штанги лёжа").count();
  await page.waitForTimeout(4800);
  return { shownFromDisk, catalogRequests: net.counts["GET /exercises"] || 0 };
});
await scenario("17_profile_offline_disk_user", VIEWPORTS[1], { tab: "menu", screen: "profile", swr: { [API + "/user/" + TG_ID]: DISK_USER }, net: { setMode: "ok", setBodies: [], counts: {}, userFail: true } }, async (page, net) => {
  const loaderFirst = await page.getByText("ПРОФИЛЬ").count();
  await page.waitForTimeout(5200);
  const retryBtn = await page.getByRole("button", { name: "ПОВТОРИТЬ" }).count();
  const userReqBefore = net.counts["GET /user/{tg}"] || 0;
  net.userFail = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(800);
  return { loaderFirst, retryBtn, userReqBefore, userReqAfter: net.counts["GET /user/{tg}"] || 0, profileShown: await page.getByText(/ИЗМЕНИТЬ/).count() };
});
await scenario("18_sweep_on_start", VIEWPORTS[1], { tab: "menu", screen: null, swr: { [API + "/user/999"]: { telegram_id: 999 }, [API + "/home/999"]: {}, [API + "/exercises?lang=en&lite=1"]: { exercises: [] }, [API + "/exercises/101/details?lang=uz"]: { id: 101 } }, net: { setMode: "ok", setBodies: [], counts: {}, home: HOME } }, async (page, net) => {
  await page.evaluate(() => localStorage.setItem("gymbot_swr:old", JSON.stringify({ t: Date.now() - 8 * 86400000, d: 1 })));
  await page.reload(); await page.waitForTimeout(1200);
  return { left: await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gymbot_swr:")).map(k => k.replace(/^gymbot_swr:https:\/\/[^/]+\/api/, ""))) };
});

await scenario("19_catalog_detail_loads_technique", VIEWPORTS[1], { tab: "catalog", screen: null }, async (page, net) => {
  await page.getByText("Жим штанги лёжа").first().click();
  await page.getByText(/Контроль опускания 3 секунды/).waitFor({ timeout: 3000 });
  return { details: net.details, descShown: await page.getByText(/Базовое упражнение/).count() };
});

const DET = Object.fromEntries(catalog.map(e => [API + "/exercises/" + e.id + "/details?lang=ru", { id: e.id, description: e.description, technique: e.technique }]));
await scenario("20_old_saved_workout_primes_from_catalog", VIEWPORTS[1], {}, async (page, net) => {
  await page.waitForTimeout(800);
  return { batch: net.batch || [] };
});
await scenario("21_details_502_no_offline_msg", VIEWPORTS[1], { liteSaved: true, net: { setMode: "ok", setBodies: [], counts: {}, details502: true } }, async (page, net) => {
  await page.locator('button[aria-label^="ТЕХНИКА ВЫПОЛНЕНИЯ"]').click();
  await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(600);
  return { offlineMsg: await page.getByText(/Техника загрузится/).count(), dots: await page.getByRole("dialog").getByText("…", { exact: true }).count(), desc: await page.getByRole("dialog").getByText(/Базовое упражнение/).count() };
});
await scenario("22_quota_keeps_technique", VIEWPORTS[1], { tab: "menu", screen: null, quota: 2600, swr: DET, net: { setMode: "ok", setBodies: [], counts: {}, home: HOME } }, async (page, net) => {
  await page.waitForTimeout(1500);
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("gymbot_swr:")).map(k => k.replace(/^gymbot_swr:https:\/\/[^/]+\/api/, "")));
  return { keys, quotaHits: await page.evaluate(() => window.__quotaHits || []) };
});

await scenario("26_closed_elsewhere", VIEWPORTS[1], { net: { setMode: "ok", setBodies: [], counts: {}, activeNotFound: true } }, async (page, net) => {
  await page.getByText(/Прошлая тренировка уже завершена/).waitFor({ timeout: 5000 });
  const ls = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("gymbot_active_workout") || "null"); } catch { return "bad"; } });
  return { notice: 1, localWorkoutId: ls ? ls.workoutId ?? null : null, setScreen: await page.getByText(/ПОДХОД \d \/ 4/).count(), statePuts: net.counts["PUT /workout/77/state"] || 0 };
});
await scenario("27_offline_first_start", VIEWPORTS[1], { tab: "menu", screen: null, net: { setMode: "ok", setBodies: [], counts: {}, userFail: true, home: HOME } }, async (page, net) => {
  await page.getByRole("button", { name: "ПОВТОРИТЬ" }).waitFor({ timeout: 5000 });
  const consent = await page.getByText(/СОГЛАСИЕ/).count();
  net.userFail = false;
  await page.getByRole("button", { name: "ПОВТОРИТЬ" }).click();
  await page.getByText("Каталог", { exact: true }).waitFor({ timeout: 5000 });
  return { offlineShown: 1, consent, recovered: 1 };
});
for (const [name, limit] of [["28_food_quota_ok", false], ["29_food_limit_reached", true]]) {
  await scenario(name, VIEWPORTS[1], { tab: "menu", screen: "food_vision", net: { setMode: "ok", setBodies: [], counts: {}, home: HOME, foodQuota: limit ? { used: 10, limit: 10 } : { used: 3, limit: 10 }, foodLimit: limit } }, async (page, net) => {
    await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "fixtures/photo.jpg"));
    await page.getByRole("button", { name: /ГОТОВО/ }).click();
    const quotaLine = await page.getByText(/Распознаваний на сегодня: \d+ из 10/).innerText().catch(() => null);
    await page.getByRole("button", { name: /АНАЛИЗИРОВАТЬ/ }).click();
    await page.waitForTimeout(600);
    return { quotaLine, limitMsg: await page.getByText(/На сегодня распознавания по фото закончились \(10 в день\)/).count(), result: await page.getByText("Плов").count(), analyzeCalls: (net.analyze || []).length };
  });
}

await scenario("30_new_workout_during_slow_check", VIEWPORTS[1], { net: { setMode: "ok", setBodies: [], counts: {}, activeNotFound: true, activeDelay: 2500 } }, async (page, net) => {
  // Пока сервер отвечает «нет активной», на устройстве уже другая тренировка
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem("gymbot_active_workout")); s.workoutId = 78; localStorage.setItem("gymbot_active_workout", JSON.stringify(s)); });
  await page.waitForTimeout(3500);
  const ls = await page.evaluate(() => JSON.parse(localStorage.getItem("gymbot_active_workout") || "null"));
  return { notice: await page.getByText(/Прошлая тренировка уже завершена/).count(), localWorkoutId: ls?.workoutId ?? null };
});

// Ночь по Ташкенту: 01:30 24.10 = 20:30 UTC 23.10. «Сегодня» — 24-е, шаг назад — 23-е.
// Раньше дневник жил по UTC: в это время «сегодня» было 23-м, а «вчера» — 22-м.
await scenario("32_nutrition_tashkent_night", VIEWPORTS[1], { tab: "menu", screen: "nutrition", clock: "2026-10-23T20:30:00Z" }, async (page, net) => {
  await page.getByText("СЕГОДНЯ", { exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Предыдущий день" }).click();   // кнопка «‹», имя для диктора
  await page.waitForTimeout(500);
  const dayLabel = await page.getByText(/23 окт/).count();
  await page.getByRole("button", { name: "К сегодняшнему дню" }).click(); // кнопка «›»
  await page.waitForTimeout(500);
  return { reqs: net.nutr || [], dayLabel };
});

// Подходы прошлой тренировки на английском; дата — по Ташкенту (в базе 20:00 UTC 23.10)
await scenario("33_workout_detail_en", VIEWPORTS[1], { lang: "en", tab: "menu", screen: "workout_detail", params: { workoutId: 555 } }, async (page) => {
  await page.getByText(/Жим штанги лёжа/).waitFor({ timeout: 5000 });
  await page.waitForTimeout(600);
  return { nameEn: await page.getByText("1. Жим штанги лёжа (en)").count(), date: await page.getByText(/October 24, 2026/).count() };
});

// Разбор тренера на экране завершения — потоком; если поток не завёлся — обычным запросом
for (const [name, streamFail] of [["34_finish_review_stream", false], ["35_finish_review_fallback", true]]) {
  await scenario(name, VIEWPORTS[1], { net: { setMode: "ok", setBodies: [], counts: {}, streamFail } }, async (page, net) => {
    await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
    await page.getByRole("button", { name: "ЗАВЕРШИТЬ", exact: true }).first().click();
    await page.getByText(streamFail ? "Запасной разбор тренировки." : "Хорошая работа: жим прибавил 2,5 кг.").waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    return { aiCalls: net.aiCalls || [], saved: net.saved || [], cursor: await page.getByText("▍").count() };
  });
}

// Сервер сказал «пустая» — без разбора тренера, с пояснением
await scenario("36_finish_empty_workout", VIEWPORTS[1], { net: { setMode: "ok", setBodies: [], counts: {}, finishEmpty: true } }, async (page, net) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "ЗАВЕРШИТЬ", exact: true }).first().click();
  await page.getByText(/тренировка не засчитана/).waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  return { aiCalls: net.aiCalls || [], body: (net.finishBodies || [])[0] || null, analyzing: await page.getByText(/АНАЛИЗИРУЕТ/).count() };
});

// ── Premium и карточка тренировки ──
await scenario("37_premium_buy_month", VIEWPORTS[1], { tab: "menu", screen: "premium", net: { setMode: "ok", setBodies: [], counts: {}, premium: PREMIUM } }, async (page, net) => {
  await page.getByText("GymBot Premium").waitFor({ timeout: 5000 });
  const save = await page.getByText(/выгода 46%/).count();
  await page.getByRole("button", { name: /оформить за 199/i }).click();
  await page.getByText(/Premium включён до/).waitFor({ timeout: 6000 });
  return { plan: net.premInvoice, calls: await page.evaluate(() => window.__tgCalls || []), save, perks: await page.getByText("30 вопросов тренеру в день").count() };
});
await scenario("38_premium_trial", VIEWPORTS[1], { tab: "menu", screen: "premium", net: { setMode: "ok", setBodies: [], counts: {}, premium: PREMIUM } }, async (page, net) => {
  await page.getByRole("button", { name: /попробовать 7 дн/i }).click();
  await page.getByText(/Пробный Premium до/).first().waitFor({ timeout: 4000 });
  return { trials: (net.trials || []).length, trialBtn: await page.getByRole("button", { name: /попробовать/i }).count() };
});
await scenario("39_finish_share", VIEWPORTS[1], {}, async (page, net) => {
  await page.getByText("ПОДХОД 2 / 4").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "ЗАВЕРШИТЬ", exact: true }).first().click();
  await page.getByText("ПОДЕЛИТЬСЯ").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /в историю/i }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: /в чат/i }).click();
  await page.waitForTimeout(300);
  return { share: net.share || [], calls: await page.evaluate(() => window.__tgCalls || []) };
});
await scenario("40_premium_entry_points", VIEWPORTS[1], { tab: "menu", screen: "food_vision", net: { setMode: "ok", setBodies: [], counts: {}, home: HOME, foodQuota: { used: 10, limit: 10 }, foodLimit: true, premium: PREMIUM } }, async (page, net) => {
  await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "fixtures/photo.jpg"));
  await page.getByRole("button", { name: /ГОТОВО/ }).click();
  await page.getByRole("button", { name: /АНАЛИЗИРОВАТЬ/ }).click();
  await page.getByText("С Premium — 20 фото еды в день").waitFor({ timeout: 4000 });
  await page.getByText("С Premium — 20 фото еды в день").click();
  await page.getByText("GymBot Premium").waitFor({ timeout: 4000 });
  return { nudge: 1, opened: 1 };
});
await scenario("41_workout_detail_share_old_client", VIEWPORTS[1], { tab: "menu", screen: "workout_detail", params: { workoutId: 555 } }, async (page, net) => {
  await page.evaluate(() => { window.Telegram.WebApp.isVersionAtLeast = v => parseFloat(v) <= 7.0; });
  await page.getByRole("button", { name: /в чат/i }).click();
  await page.getByText(/Карточка в чате с ботом/).waitFor({ timeout: 4000 });
  return { share: net.share || [], calls: await page.evaluate(() => window.__tgCalls || []) };
});
await scenario("42_story_on_desktop_goes_to_bot", VIEWPORTS[1], { tab: "menu", screen: "workout_detail", params: { workoutId: 555 }, platform: "tdesktop" }, async (page, net) => {
  await page.getByRole("button", { name: /в историю/i }).click();
  await page.getByText(/Карточка в чате с ботом/).waitFor({ timeout: 4000 });
  return { share: net.share || [], calls: await page.evaluate(() => window.__tgCalls || []) };
});
await scenario("43_home_premium_entry", VIEWPORTS[1], { tab: "menu", screen: null, net: { setMode: "ok", setBodies: [], counts: {}, home: HOME, premium: PREMIUM } }, async (page, net) => {
  await page.getByText("С Premium — 30 вопросов тренеру в день").waitFor({ timeout: 5000 });
  await page.getByText("С Premium — 30 вопросов тренеру в день").click();
  await page.getByText("GymBot Premium").waitFor({ timeout: 4000 });
  return { entry: 1, opened: 1 };
});
await scenario("44_premium_terms", VIEWPORTS[0], { tab: "menu", screen: "premium", net: { setMode: "ok", setBodies: [], counts: {}, premium: PREMIUM } }, async (page, net) => {
  await page.getByText("GymBot Premium").waitFor({ timeout: 5000 });
  await page.getByText(/Условия Premium, отмена и возврат/).click();
  await page.getByText("3. Premium").waitFor({ timeout: 4000 });
  return { prices: await page.getByText(/месяц стоит 199 ⭐, год — 1290 ⭐/).count(),
           trial: await page.getByText(/Пробный период — 7 дн\. бесплатно/).count(),
           refund: await page.getByText(/\/paysupport/).count() > 0 ? 1 : 0,
           cancel: await page.getByText(/Настройки → Мои звёзды/).count() > 0 ? 1 : 0 };
});
await scenario("45_more_terms", VIEWPORTS[1], { tab: "menu", screen: "more", net: { setMode: "ok", setBodies: [], counts: {}, premium: PREMIUM } }, async (page, net) => {
  await page.getByText("Правила использования").first().click();
  await page.getByText("1. Общие положения").waitFor({ timeout: 4000 });
  return { opened: 1, general: await page.getByText(/не являются медицинским назначением/).count() };
});
await scenario("46_strength_screen", VIEWPORTS[0], { tab: "menu", screen: "strength", net: { setMode: "ok", setBodies: [], counts: {}, strength: STRENGTH } }, async (page, net) => {
  await page.getByText("Общий ранг").waitFor({ timeout: 5000 });
  const has = async re => (await page.getByText(re).count()) > 0 ? 1 : 0;
  return { overall: await has(/Сильнее ~55% тренирующихся/), next: await has(/До уровня «Продвинутый»: \+26\.7 кг/),
           from: await has(/лучший подход 80 кг × 5/), reps: await has(/До уровня «Продвинутый»: \+7 повт\./),
           community: await has(/сильнее 69% из 13/), untracked: await has("Становая тяга") };
});
await scenario("47_strength_missing_profile", VIEWPORTS[1], { tab: "menu", screen: "strength", net: { setMode: "ok", setBodies: [], counts: {},
  strength: { gender: null, bodyweight: null, missing: ["gender", "weight"], keys: ["bench"], lifts: [], overall: null } } }, async (page, net) => {
  await page.getByRole("button", { name: /Заполнить профиль/i }).click();
  await page.waitForTimeout(600);
  return { toProfile: net.counts["GET /user/{tg}"] > 0 ? 1 : 0, msg: 1 };
});
await scenario("48_progress_strength_card", VIEWPORTS[1], { tab: "progress", screen: null, net: { setMode: "ok", setBodies: [], counts: {}, strength: STRENGTH } }, async (page, net) => {
  await page.getByText(/Средний · /).first().click();
  await page.getByText("Общий ранг").waitFor({ timeout: 4000 });
  return { opened: 1, oldNorms: await page.getByText(/VS НОРМЫ/).count() };
});
await scenario("49_label_scan", VIEWPORTS[0], { tab: "menu", screen: "label_scan", params: { meal_type: "lunch" } }, async (page, net) => {
  await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "fixtures/photo.jpg"));
  await page.getByRole("button", { name: /Распознать/ }).click();
  await page.getByText("На 100 г", { exact: true }).waitFor({ timeout: 5000 });
  const nameVal = await page.locator("input").nth(1).inputValue();
  const total = (await page.getByText(/Итого на 250 г/).count()) > 0 ? 1 : 0;   // порция с упаковки выбрана сама
  await page.getByRole("button", { name: /Записать в дневник/ }).click();
  await page.getByText(/Добавлено|✓/).first().waitFor({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { label: (net.label || []).length, nameVal, total, save: (net.labelSave || [])[0] || null };
});
await scenario("50_label_not_found", VIEWPORTS[1], { tab: "menu", screen: "label_scan", net: { setMode: "ok", setBodies: [], counts: {}, labelNot: true } }, async (page, net) => {
  await page.locator('input[type="file"]').setInputFiles(path.join(ROOT, "fixtures/photo.jpg"));
  await page.getByRole("button", { name: /Распознать/ }).click();
  await page.getByText(/не видно таблицы пищевой ценности/).waitFor({ timeout: 5000 });
  return { msg: 1, saves: (net.labelSave || []).length };
});
await scenario("51_food_search_national_uz", VIEWPORTS[1], { lang: "uz", tab: "menu", screen: "food_search" }, async (page, net) => {
  await page.getByText("Milliy taomlar").click();
  await page.getByText("Palov (osh)").waitFor({ timeout: 4000 });
  return { portion: await page.getByText("porsiya ~350 g").count(), scanBtn: await page.getByText(/Yorliqni skanerlash/).count(),
           query: (net.search || []).some(q => q.includes("category=national")) ? 1 : 0 };
});
await scenario("52_programs_list", VIEWPORTS[1], { tab: "menu", screen: "programs", net: { setMode: "ok", setBodies: [], counts: {}, programs: PROG_LIST } }, async (page, net) => {
  await page.getByText("ВАША ПРОГРАММА").waitFor({ timeout: 5000 });
  const has = async re => (await page.getByText(re).count()) > 0 ? 1 : 0;
  return { progress: await has(/Тренировка 4 из 24/), next: await has(/Следующая: День B/), premium: await has("PREMIUM"),
           free: await has("Бесплатно"), meta: await has(/6 трен\. в неделю · 8 нед\./) };
});
await scenario("53_program_start_day", VIEWPORTS[1], { tab: "menu", screen: "program_detail", params: { slug: "fullbody_beginner" },
  net: { setMode: "ok", setBodies: [], counts: {}, programs: PROG_LIST, programDetail: PROG_DETAIL } }, async (page, net) => {
  await page.getByText("ДНИ ПРОГРАММЫ").waitFor({ timeout: 5000 });
  const reps = (await page.getByText("3 × 30–45 с").count()) > 0 ? 1 : 0;
  const missing = (await page.getByText(/нет в каталоге/).count()) > 0 ? 1 : 0;
  await page.getByRole("button", { name: /Начать: День B/ }).click();
  await page.waitForTimeout(800);
  // экран тренировки с составом дня: начинаем
  const hint = (await page.getByText("Состав — из вашей программы").count()) > 0 ? 1 : 0;
  await page.getByRole("button", { name: /ПРОПУСТИТЬ/ }).last().click();   // разминку пропускаем
  await page.getByRole("button", { name: /НАЧАТЬ ТРЕНИРОВКУ/ }).click();    // порядок — и старт
  await page.waitForTimeout(800);
  return { reps, missing, hint, start: (net.starts || [])[0] || null };
});
await scenario("54_program_locked", VIEWPORTS[1], { tab: "menu", screen: "program_detail", params: { slug: "ppl" },
  net: { setMode: "ok", setBodies: [], counts: {}, premium: PREMIUM, programs: { programs: [], active: null },
         programDetail: { ...PROG_DETAIL, slug: "ppl", title: "Тяни-толкай-ноги", locked: true, premium: true, active: null } } }, async (page, net) => {
  await page.getByRole("button", { name: /Открыть с Premium/ }).click();
  await page.getByText("GymBot Premium").waitFor({ timeout: 4000 });
  return { toPremium: 1, starts: (net.progStart || []).length };
});
await scenario("55_social_accept_invite", VIEWPORTS[1], { tab: "menu", screen: "social", params: { accept: "ANNA0002" },
  net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL, feed: FEED } }, async (page, net) => {
  await page.getByText("Анна приглашает вас в друзья").waitFor({ timeout: 5000 });
  const acceptsBefore = (net.accepts || []).length;
  await page.screenshot({ path: path.join(OUT, "55b_invite_confirm.png") });
  await page.getByRole("button", { name: "Добавить в друзья" }).click();
  await page.getByText("Вы теперь друзья с Анна").waitFor({ timeout: 5000 });
  return { acceptsBefore, previews: net.previews || [], accepts: net.accepts || [], friendRow: await page.getByText("4 трен. на этой неделе").count(),
           privacy: await page.getByText("Показывать мои тренировки друзьям").count() };
});
await scenario("56_social_feed_like", VIEWPORTS[0], { tab: "menu", screen: "social",
  net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL, feed: FEED } }, async (page, net) => {
  await page.getByText(/Рекорд: Жим штанги лёжа — 60 кг \(было 55\)/).waitFor({ timeout: 5000 });
  const more = await page.getByText(/\+3/).count();
  const meta = await page.getByText(/15 подх\. · 4,2 т · 50 мин/).count();
  await page.getByRole("button", { name: /👏 2/ }).click();
  await page.getByRole("button", { name: /👏 3/ }).waitFor({ timeout: 3000 });
  return { likes: net.likes || [], more: more > 0 ? 1 : 0, meta, you: await page.getByText("Вы", { exact: true }).count() };
});
await scenario("57_team_join_board", VIEWPORTS[1], { tab: "menu", screen: "social", params: { join: "TEAM0007" },
  net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL, feed: FEED } }, async (page, net) => {
  await page.getByText("Приглашение в команду «Зал №1»").waitFor({ timeout: 5000 });
  await page.getByText(/3 участн\. В команде видно/).waitFor({ timeout: 2000 });
  await page.getByRole("button", { name: "Вступить", exact: true }).click();
  await page.getByText("Вы в команде «Зал №1»").waitFor({ timeout: 5000 });
  await page.getByText("РЕЙТИНГ НЕДЕЛИ").waitFor({ timeout: 4000 });
  return { joins: net.joins || [], owner: await page.getByText("владелец").count(), invite: await page.getByRole("button", { name: /Позвать в команду/ }).count() };
});

// ── «Что нового» ──
await scenario("58_whats_new_tour", VIEWPORTS[1], { tab: "menu", screen: null, net: WN_NET() }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const first = await page.getByText("ЧТО НОВОГО · 1/8").count();
  const title1 = await page.locator("#wn-title").textContent();
  const levels = await page.getByText("от «Старт» до «Элита»", { exact: false }).count();
  const bb = await page.evaluate(() => window.Telegram.WebApp.BackButton.isVisible);
  const titles = [title1];
  for (let k = 0; k < 7; k++) { await page.getByRole("button", { name: "ДАЛЕЕ" }).click(); await page.waitForTimeout(120); titles.push(await page.locator("#wn-title").textContent()); }
  const trialCta = await page.getByRole("button", { name: /Попробовать 7 дн\. бесплатно/i }).count();
  const perks = await page.getByText("До 30 вопросов AI-тренеру в день").count();
  await page.screenshot({ path: path.join(OUT, "58b_whats_new_premium.png") });
  await page.getByRole("button", { name: "ГОТОВО" }).click();
  await page.waitForTimeout(300);
  return { first, titles, levels, bb, trialCta, perks, dialogAfter: await page.getByRole("dialog").count(), posts: net.wnPosts || [],
           ls: await page.evaluate(() => localStorage.getItem("gymbot_wn_seen_123456789")), bbAfter: await page.evaluate(() => window.Telegram.WebApp.BackButton.isVisible) };
});
await scenario("59_whats_new_cta_opens_feature", VIEWPORTS[0], { tab: "menu", screen: null, net: WN_NET() }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "ДАЛЕЕ" }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, "59b_whats_new_food_360x740.png") });
  await page.getByRole("button", { name: "ДАЛЕЕ" }).click();
  await page.getByRole("button", { name: "ВЫБРАТЬ ПРОГРАММУ" }).click();
  await page.waitForTimeout(400);
  return { posts: net.wnPosts || [], dialog: await page.getByRole("dialog").count(), programs: await page.getByText("ПРОГРАММЫ", { exact: true }).count(),
           programsReq: net.counts["GET /programs/{tg}"] || 0 };
});
await scenario("60_whats_new_swipe_and_back", VIEWPORTS[2], { tab: "menu", screen: null, net: { ...WN_NET(), wn: { seen: "2026-01-01", new_user: true } } }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const kicker = await page.getByText("ПОЛЕЗНО ЗНАТЬ · 1/8").count();
  const box = await page.getByRole("dialog").boundingBox();
  const swipe = async (from, to) => {
    await page.dispatchEvent('[role="dialog"]', "touchstart", { touches: [{ identifier: 1, clientX: from, clientY: 400 }], changedTouches: [{ identifier: 1, clientX: from, clientY: 400 }] });
    await page.dispatchEvent('[role="dialog"]', "touchend", { touches: [], changedTouches: [{ identifier: 1, clientX: to, clientY: 400 }] });
    await page.waitForTimeout(150);
  };
  await swipe(box.width - 40, 60);
  const afterLeft = await page.getByText("ПОЛЕЗНО ЗНАТЬ · 2/8").count();
  await swipe(60, box.width - 40);
  const afterRight = await page.getByText("ПОЛЕЗНО ЗНАТЬ · 1/8").count();
  await page.evaluate(() => window.Telegram.WebApp.BackButton._h.forEach(f => f()));
  await page.waitForTimeout(300);
  return { kicker, afterLeft, afterRight, dialogAfterBack: await page.getByRole("dialog").count(), posts: net.wnPosts || [] };
});
await scenario("61_whats_new_not_again", VIEWPORTS[1], { tab: "menu", screen: null, ls: { gymbot_wn_seen_123456789: "2026-10-25d" }, net: WN_NET() }, async (page, net) => {
  await page.waitForTimeout(800);
  return { gets: net.wnGets || 0, dialog: await page.getByRole("dialog").count() };
});
await scenario("62_whats_new_not_over_deeplink", VIEWPORTS[1], { tab: "menu", screen: null, startapp: "premium", net: WN_NET() }, async (page, net) => {
  await page.waitForTimeout(1200);
  return { gets: net.wnGets || 0, dialog: await page.getByRole("dialog").count(), premium: await page.getByText(/ПОПРОБОВАТЬ|7 дней/i).count() > 0 ? 1 : 0 };
});
await scenario("63_whats_new_from_more_uz", VIEWPORTS[0], { lang: "uz", tab: "menu", screen: "more", net: { ...WN_NET(), wn: { seen: "2099-01-01", new_user: false } } }, async (page, net) => {
  await page.getByText("Yangiliklar", { exact: true }).click();
  await page.getByRole("dialog").waitFor({ timeout: 4000 });
  const kicker = await page.getByText("YANGILIKLAR · 1/8").count();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.getByRole("button", { name: "MENING DARAJAM" }).click();
  await page.waitForTimeout(400);
  return { kicker, overflow, dialog: await page.getByRole("dialog").count(), strengthReq: net.counts["GET /strength/{tg}"] || 0, posts: net.wnPosts || [] };
});

// ── «Что нового»: видел прошлую подборку — только новый слайд ──
await scenario("64_whats_new_only_new", VIEWPORTS[1], { tab: "menu", screen: null, net: { ...WN_NET(), wn: { seen: "2026-10-25", new_user: false }, social: SOCIAL_NUDGE, feed: FEED } }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const only = await page.getByText("ЧТО НОВОГО · 1/3").count();
  const title = await page.locator("#wn-title").textContent();
  await page.screenshot({ path: path.join(OUT, "64b_whats_new_nudge.png") });
  await page.getByRole("button", { name: "Открыть друзей" }).click();
  await page.getByText("Борис").waitFor({ timeout: 4000 });
  return { only, title, posts: net.wnPosts || [], friendsTab: await page.getByRole("button", { name: /Напомнить/ }).count() > 0 ? 1 : 0 };
});
// ── Друзья: напомнить тому, кто не тренируется ──
await scenario("65_friend_nudge", VIEWPORTS[0], { tab: "menu", screen: "social", params: { tab: "friends" }, net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL_NUDGE, feed: FEED } }, async (page, net) => {
  await page.getByText("Борис").waitFor({ timeout: 5000 });
  const idle = await page.getByText("не тренируется 5 дн.").count();
  const long = await page.getByText("давно не тренировался").count();
  const buttons = await page.getByRole("button", { name: /Напомнить/ }).count();
  const done = await page.getByText("✓ Напомнили").count();
  await page.screenshot({ path: path.join(OUT, "65a_friends_list_360x740.png") });
  await page.getByRole("button", { name: /Напомнить/ }).first().click();
  await page.getByRole("dialog").waitFor();
  const to = await page.getByText("Кому: Борис").count();
  await page.getByRole("button", { name: "Давно тебя не видно — сходим потренироваться?" }).click();
  await page.locator("textarea").fill("Борис, давно тебя не видно — в субботу в зал? 💪");
  await page.screenshot({ path: path.join(OUT, "65b_nudge_sheet_360x740.png") });
  await page.getByRole("button", { name: "Отправить" }).click();
  await page.getByText("Напоминание отправлено: Борис").waitFor({ timeout: 4000 });
  return { idle, long, buttons, done, to, nudges: net.nudges || [], dialogAfter: await page.getByRole("dialog").count() };
});
await scenario("66_friend_nudge_errors", VIEWPORTS[1], { tab: "menu", screen: "social", params: { tab: "friends" }, net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL_NUDGE, feed: FEED, nudgeErr: "no_links" } }, async (page, net) => {
  await page.getByText("Борис").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: /Напомнить/ }).first().click();
  await page.locator("textarea").fill("заходи t.me/somebot");
  await page.getByRole("button", { name: "Отправить" }).click();
  await page.getByText("Без ссылок и @упоминаний, пожалуйста").waitFor({ timeout: 4000 });
  const stillOpen = await page.getByRole("dialog").count();
  await page.locator("textarea").fill("   ");
  const disabled = await page.getByRole("button", { name: "Отправить" }).isDisabled();
  await page.evaluate(() => window.Telegram.WebApp.BackButton._h.forEach(f => f()));
  await page.waitForTimeout(200);
  net.nudgeErr = null; net.nudgeUndelivered = true;
  await page.getByRole("button", { name: /Напомнить/ }).nth(1).click();
  await page.getByRole("button", { name: "Отправить" }).click();
  await page.getByText("Не доставлено: Вика остановил(а) бота GymBot").waitFor({ timeout: 4000 });
  return { stillOpen, disabled, nudges: (net.nudges || []).map(n => n.id) };
});
// ── «Что нового»: видел подборку с напоминаниями — только слайд настроек ──
await scenario("67_whats_new_friends_settings", VIEWPORTS[0], { tab: "menu", screen: null, net: { ...WN_NET(), wn: { seen: "2026-10-25b", new_user: false }, social: SOCIAL_NUDGE, feed: FEED } }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const only = await page.getByText("ЧТО НОВОГО · 1/2").count();
  const title = await page.locator("#wn-title").textContent();
  await page.screenshot({ path: path.join(OUT, "67b_whats_new_friends_settings_360x740.png") });
  await page.getByRole("button", { name: "Открыть настройки" }).click();
  const sw = page.getByRole("switch", { name: /Получать напоминания от друзей/ });
  await sw.waitFor({ timeout: 4000 });
  return { only, title, posts: net.wnPosts || [], checked: await sw.getAttribute("aria-checked") };
});
// ── Друзья: отключить напоминания, сменить ссылку ──
await scenario("68_friends_settings", VIEWPORTS[0], { tab: "menu", screen: "social", params: { tab: "friends" }, net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL_SETTINGS, feed: FEED } }, async (page, net) => {
  await page.getByText("Дана").waitFor({ timeout: 5000 });
  const off = await page.getByText("🔕 напоминания выкл.").count();
  const sw = page.getByRole("switch", { name: /Получать напоминания от друзей/ });
  const before = await sw.getAttribute("aria-checked");
  await sw.click();
  await page.getByText("Друзья не смогут присылать вам напоминания").waitFor({ timeout: 3000 });
  const after = await page.getByRole("switch", { name: /Получать напоминания от друзей/ }).getAttribute("aria-checked");
  await page.screenshot({ path: path.join(OUT, "68a_friends_settings_360x740.png") });
  const dialogs = [];
  page.on("dialog", d => { dialogs.push(d.message()); d.accept(); });
  await page.getByRole("button", { name: "Сменить ссылку-приглашение" }).click();
  await page.getByText("Ссылка обновлена — старая больше не работает").waitFor({ timeout: 3000 });
  net.resetErr = true;
  await page.getByRole("button", { name: "Сменить ссылку-приглашение" }).click();
  await page.getByText("Ссылку можно менять не чаще раза в минуту").waitFor({ timeout: 3000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  return { off, before, after, privacy: net.privacy || [], resets: net.resets || 0, confirms: dialogs.length,
           confirmText: dialogs[0] || "", link: net.social.invite_link, overflow };
});
// ── Приглашение: «Не сейчас» ничего не принимает; в команде скрывший тренировки — без чисел ──
await scenario("69_invite_decline", VIEWPORTS[0], { tab: "menu", screen: "social", params: { accept: "ANNA0002" },
  net: { setMode: "ok", setBodies: [], counts: {}, social: SOCIAL, feed: FEED } }, async (page, net) => {
  await page.getByRole("button", { name: "Не сейчас" }).click();
  await page.waitForTimeout(300);
  return { accepts: (net.accepts || []).length, card: await page.getByText("Анна приглашает вас в друзья").count() };
});
const TEAM_HIDDEN = { ...TEAM, board: [...TEAM.board, { id: 9, name: "Дана", is_me: false, is_owner: false, hidden: true, week: null, last_week: null, place: 4 }] };
await scenario("70_team_hidden_member", VIEWPORTS[0], { tab: "menu", screen: "social", params: { join: "TEAM0007" },
  net: { setMode: "ok", setBodies: [], counts: {}, social: { ...SOCIAL, teams: [TEAM_HIDDEN] }, feed: FEED } }, async (page, net) => {
  await page.getByRole("button", { name: "Вступить", exact: true }).click();
  await page.getByText("Дана").waitFor({ timeout: 5000 });
  return { hidden: await page.getByText("скрыл(а) тренировки").count(), nullText: await page.getByText("null").count() };
});

// ── «Что нового»: достижения за друзей; кнопка открывает экран приглашения ──
await scenario("72_whats_new_referral_achievements", VIEWPORTS[0], { tab: "menu", screen: null, net: { ...WN_NET(), wn: { seen: "2026-10-25c", new_user: false } } }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const only = await page.getByText("ЧТО НОВОГО · 1/1").count();
  const title = await page.locator("#wn-title").textContent();
  await page.screenshot({ path: path.join(OUT, "72b_whats_new_referral_achievements_360x740.png") });
  await page.getByRole("button", { name: "Пригласить друга" }).click();
  await page.getByText("IGOR0001").first().waitFor({ timeout: 4000 });
  return { only, title, posts: net.wnPosts || [], referral: await page.getByText("ПРИГЛАСИТЬ ДРУГА").count() };
});

// ── Приглашения: баллы — после первой тренировки друга; кто ещё не тренировался — «ждёт» ──
await scenario("71_referral_pending", VIEWPORTS[0], { tab: "menu", screen: "referral",
  net: { setMode: "ok", setBodies: [], counts: {}, referral: { ref_code: "IGOR0001", ref_link: "https://t.me/GYMASH_bot?start=ref_IGOR0001",
    referrals_count: 2, rewarded_count: 1, bonus_per_referral: 50, enabled: true,
    referrals: [{ name: "Анна", username: null, joined: "2026-10-20T10:00:00", rewarded: true },
                { name: "Борис", username: null, joined: "2026-10-24T10:00:00", rewarded: false }] } } }, async (page) => {
  await page.getByText("Борис").waitFor({ timeout: 5000 });
  return { pending: await page.getByText("ждёт 1-й тренировки").count(), plus: await page.getByText("+50").count(),
           step: await page.getByText("Друг регистрируется и проводит первую тренировку").count() };
});

// ── Запрос повис при смене сети: через 10 с обрывается и повторяется, главный обновляется ──
await scenario("73_get_hang_retry", VIEWPORTS[1], { tab: "menu", screen: null,
  swr: { [API + "/home/" + TG_ID]: HOME },
  before: async (page) => { await page.clock.install(); },
  net: { setMode: "ok", setBodies: [], counts: {}, homeHangOnce: true, home: { ...HOME, week: { done: 3, target: 3 } } } }, async (page, net) => {
  const before = await page.getByText(/2 из 3/).count();
  await page.clock.fastForward(10500);
  await page.clock.fastForward(1000);
  await page.getByText(/3 из 3/).waitFor({ timeout: 5000 });
  const requests = net.counts["GET /home/{tg}"] || 0;
  if (net.release) net.release();
  return { before, after: 1, requests };
});

// ── Согласия при входе: пункт про AI — без «передачи в США» ──
await scenario("74_consent_gate_ai_label", VIEWPORTS[0], { tab: "menu", screen: null,
  net: { setMode: "ok", setBodies: [], counts: {}, home: HOME,
    user: { id: 1, telegram_id: TG_ID, first_name: "Игорь", profile_complete: true, lang: "ru", consents: {}, ai_requests_today: 0 } } }, async (page) => {
  await page.getByText("Обработка данных AI-сервисом по месту нахождения сервера").waitFor({ timeout: 5000 });
  return { label: 1, usa: await page.getByText(/США/).count() };
});

await browser.close();
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));

// ── Проверки ──
let failed = 0;
const seen = new Set(results.map(r => r.name));
for (const name of Object.keys(CHECKS)) if (!seen.has(name)) { console.log(`✗ ${name}: сценарий не запускался`); failed++; }
for (const r of results) {
  const problems = [...(r.errors || []).map(e => "ошибка: " + String(e).split("\n")[0])];
  const check = CHECKS[r.name];
  if (!check) problems.push("нет проверки в checks.mjs");
  else { try { problems.push(...(check(r) || [])); } catch (e) { problems.push("проверка упала: " + e.message); } }
  if (problems.length) { failed++; console.log(`✗ ${r.name} ${r.vp}: ${problems.join("; ")}`); }
  else console.log(`✓ ${r.name} ${r.vp}`);
}
console.log(failed ? `\nНе прошло: ${failed}` : `\nВсе ${results.length} прошли`);
process.exit(failed ? 1 : 0);
