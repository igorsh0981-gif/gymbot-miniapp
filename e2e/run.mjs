// Сценарии приложения в настоящем Chromium (практика AiEvent: e2e/shots).
// Сеть целиком подменена: Telegram SDK — заглушка, API и R2 — фикстуры.
// Запуск: npm run build && node e2e/run.mjs. Падает с кодом 1, если хоть одна
// проверка из e2e/checks.mjs не прошла или в консоли страницы была ошибка.
// Скриншоты — в e2e/shots (в GitHub — артефакт прогона).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { CHECKS } from "./checks.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DIST = path.join(ROOT, "..", "dist");
const OUT = path.join(ROOT, "shots");
fs.mkdirSync(OUT, { recursive: true });
const API = "https://web-production-4fe0b.up.railway.app/api";
const MEDIA = "https://media.test";
const TG_ID = 123456789;

const PHOTO = fs.readFileSync(path.join(ROOT, "fixtures/photo.jpg"));
const ICON = fs.readFileSync(path.join(ROOT, "fixtures/icon.jpg"));

const groups = [{ id: 1, name: "Грудные мышцы", name_en: "Chest", name_uz: "Ko‘krak", name_kz: "Кеуде", emoji: "🫁", icon_url: `${MEDIA}/muscle_groups/1/icon.jpg?v=1` }];
const mk = (id, name, extra = {}) => ({
  id, name, name_en: name + " (en)", name_uz: name + " (uz)", name_kz: name + " (kz)",
  description: "Базовое упражнение для силы и массы грудных мышц.",
  technique: "1️⃣ Лечь на скамью, хват шире плеч\n2️⃣ Опустить штангу к груди\n3️⃣ Выжать вверх, не отрывая таз\n4️⃣ Контроль опускания 3 секунды",
  difficulty: "intermediate", equipment: "barbell", sets_recommended: 4, reps_recommended: "8-10",
  muscle_group_id: 1, group_name: "Грудные мышцы", group_name_en: "Chest", group_name_uz: "Ko‘krak", group_name_kz: "Кеуде",
  group_emoji: "🫁", group_icon_url: `${MEDIA}/muscle_groups/1/icon.jpg?v=1`,
  photo_url: `${MEDIA}/exercises/ex${id}/photo.jpg?v=1`, video_url: null, exercise_type: "strength", ...extra,
});
const catalog = [
  mk(101, "Жим штанги лёжа"),
  mk(102, "Жим гантелей на наклонной скамье"),
  mk(103, "Сведение рук в кроссовере", { photo_url: `${MEDIA}/exercises/missing/photo.jpg?v=1` }),
];

function savedWorkout(curIdx, lite = false) {
  return {
    workoutId: 77, step: 4, warmup: null, warmupDone: true, curIdx,
    selExs: catalog.map((e, i) => ({ ...e, order: i + 1, photo_url: null, ...(lite ? { technique: null, has_technique: true } : {}) })), // как из старого localStorage
    sets: { 101: [{ weight: "60", reps: "10" }], 102: [1, 2, 3, 4].map(() => ({ weight: "24", reps: "10" })), 103: [] },
    startTime: Date.now() - 20 * 60000, savedAt: Date.now(), lastSetAt: Date.now() - 60000, exerciseTips: {},
  };
}

const TG_STUB = `
window.Telegram={WebApp:{
  initData:"query_id=x&user=%7B%22id%22%3A${TG_ID}%7D&auth_date=1&hash=x",
  initDataUnsafe:{user:{id:${TG_ID},first_name:"Игорь",language_code:"ru"}},
  version:"8.0", platform:(window.__platform||"android"), colorScheme:"dark", themeParams:{},
  isVersionAtLeast:v=>true, ready(){}, expand(){}, close(){}, sendData(){}, openLink(){}, openTelegramLink(){},
  onEvent(){}, offEvent(){}, setHeaderColor(){}, setBackgroundColor(){}, enableClosingConfirmation(){}, disableClosingConfirmation(){},
  HapticFeedback:{impactOccurred(s){(window.__haptics=window.__haptics||[]).push("impact:"+s)},notificationOccurred(t){(window.__haptics=window.__haptics||[]).push("notify:"+t)},selectionChanged(){(window.__haptics=window.__haptics||[]).push("select")}},
  BackButton:{isVisible:false,_h:[],onClick(f){this._h.push(f)},offClick(f){this._h=this._h.filter(x=>x!==f)},show(){this.isVisible=true},hide(){this.isVisible=false}},
  MainButton:{text:"",color:"",textColor:"",isVisible:false,isActive:true,isProgressVisible:false,_h:[],
    _render(){var mb=this;var el=document.getElementById("__tgmb");
      if(!el){el=document.createElement("button");el.id="__tgmb";el.type="button";
        el.style.cssText="position:fixed;left:8px;right:8px;top:-200px;height:48px;border:none;border-radius:10px;font:700 15px -apple-system,sans-serif;z-index:100000";
        el.onclick=function(){if(mb.isActive&&mb.isVisible)mb._h.slice().forEach(function(f){f()})};document.body.appendChild(el);}
      el.style.display=mb.isVisible?"block":"none";el.textContent=mb.isProgressVisible?"…":mb.text;el.style.background=mb.color;el.style.color=mb.textColor;el.disabled=!mb.isActive;
      window.__mb={text:mb.text,visible:mb.isVisible,active:mb.isActive,progress:mb.isProgressVisible,color:mb.color,textColor:mb.textColor,handlers:mb._h.length};},
    setParams(p){if("text" in p)this.text=p.text;if("color" in p)this.color=p.color;if("text_color" in p)this.textColor=p.text_color;if("is_active" in p)this.isActive=p.is_active;if("is_visible" in p)this.isVisible=p.is_visible;this._render();return this},
    show(){this.isVisible=true;this._render();return this},hide(){this.isVisible=false;this._render();return this},
    setText(t){this.text=t;this._render();return this},enable(){this.isActive=true;this._render();return this},disable(){this.isActive=false;this._render();return this},
    showProgress(){this.isProgressVisible=true;this._render();return this},hideProgress(){this.isProgressVisible=false;this._render();return this},
    onClick(f){this._h.push(f);window.__mbh=this._h.length;return this},offClick(f){this._h=this._h.filter(function(x){return x!==f});window.__mbh=this._h.length;return this}},
}};`;

// «Подход выполнен» — кнопка в странице. dispatchEvent — потому что поверх
// после первого подхода лежит таймер отдыха.
const tapSetDone = (page) => page.locator("#root button", { hasText: "ПОДХОД ВЫПОЛНЕН" }).first().dispatchEvent("click");

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
}

async function setup(page, { lang = "ru", setFails = false, curIdx = 0, tab = "workout", screen = "active_workout", params = {}, swr = null, liteSaved = false, quota = 0, platform = null, net = { setMode: "ok", setBodies: [], counts: {} } } = {}) {
  if (setFails) net.setMode = "fail500";
  await page.addInitScript(({ saved, lang, tab, screen, params, swr, quota, platform }) => {
    if (platform) window.__platform = platform;
    if (quota) {
      // Имитация переполненного хранилища: считаем только записи кэша
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (String(k).startsWith("gymbot_swr:")) {
          let used = 0;
          for (let i = 0; i < this.length; i++) { const kk = this.key(i); if (kk.startsWith("gymbot_swr:") && kk !== k) used += (this.getItem(kk) || "").length; }
          if (used + String(v).length > quota) { (window.__quotaHits = window.__quotaHits || []).push(k.replace(/^gymbot_swr:https:\/\/[^/]+\/api/, "")); throw new DOMException("full", "QuotaExceededError"); }
        }
        return orig.call(this, k, v);
      };
    }
    if (saved) localStorage.setItem("gymbot_active_workout", JSON.stringify(saved));
    localStorage.setItem("gymbot_lang", lang);
    history.replaceState({ _g: true, tab, screen, params }, "");
    if (swr) for (const [k, v] of Object.entries(swr)) localStorage.setItem("gymbot_swr:" + k, JSON.stringify({ t: Date.now(), d: v }));
  }, { saved: tab === "workout" ? savedWorkout(curIdx, liteSaved) : null, lang, tab, screen, params, swr, quota, platform });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === "telegram.org") return route.fulfill({ contentType: "application/javascript", body: TG_STUB });
    if (url.origin === "http://app.test") {
      let p = url.pathname.replace(/^\/gymbot-miniapp\/?/, "") || "index.html";
      const f = path.join(DIST, p);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const ct = p.endsWith(".js") ? "application/javascript" : p.endsWith(".css") ? "text/css" : p.endsWith(".png") ? "image/png" : p.endsWith(".json") ? "application/json" : "text/html";
        return route.fulfill({ contentType: ct, body: fs.readFileSync(f) });
      }
      return route.fulfill({ status: 404, body: "" });
    }
    if (url.origin === MEDIA) {
      if (url.pathname.includes("/missing/")) return route.fulfill({ status: 404, body: "" });
      if (url.pathname.endsWith("icon.jpg")) return route.fulfill({ contentType: "image/jpeg", body: ICON });
      return route.fulfill({ contentType: "image/jpeg", body: PHOTO });
    }
    if (req.url().startsWith(API)) {
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      const p = url.pathname.replace(/^\/api/, "");
      const key = req.method() + " " + p.replace(/\d{6,}/, "{tg}");
      net.counts[key] = (net.counts[key] || 0) + 1;
      if (p === `/user/${TG_ID}` && net.userFail) return route.abort("internetdisconnected");
      if (p === `/user/${TG_ID}`) return json(route, { id: 1, telegram_id: TG_ID, first_name: "Игорь", profile_complete: true, lang, consents: { terms: true, basic: true, health: true, ai: true }, ai_requests_today: 0, user_rank: "athlete", total_points: 250, medical_conditions: ["hypertension"], allergies: ["lactose"] });
      if (p === "/exercises" && net.catalogFail) return route.abort("internetdisconnected");
      if (p === "/exercises/details") {
        (net.batch = net.batch || []).push(url.searchParams.get("ids"));
        if (net.detailsFail) return route.abort("internetdisconnected");
        const ids = (url.searchParams.get("ids") || "").split(",").map(Number);
        return json(route, { items: catalog.filter(e => ids.includes(e.id)).map(e => ({ id: e.id, description: e.description, technique: e.technique })) });
      }
      if (p === "/exercises") {
        const lite = url.searchParams.get("lite");
        net.catalogLite = !!lite;
        const ex = lite ? catalog.map(e => ({ ...e, technique: null, has_technique: !!e.technique })) : catalog;
        return json(route, { exercises: ex, muscle_groups: groups });
      }
      const dm = p.match(/^\/exercises\/(\d+)\/details$/);
      if (dm) {
        (net.details = net.details || []).push(+dm[1]);
        if (net.detailsFail) return route.abort("internetdisconnected");
        if (net.details502) return json(route, { detail: "bad gateway" }, 502);
        const e = catalog.find(x => x.id === +dm[1]);
        return e ? json(route, { id: e.id, description: e.description, technique: e.technique }) : json(route, { detail: "nf" }, 404);
      }
      if (p === `/home/${TG_ID}`) {
        if (net.homeDelay) await new Promise(r => setTimeout(r, net.homeDelay));
        return json(route, net.home || {});
      }
      if (p === `/exercises/${TG_ID}/last-sets`) {
        const n = url.searchParams.get("exercise_name") || "";
        if (n.startsWith("Жим штанги")) return json(route, { found: true, date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19), rest_sec: 0, sets: [{ weight: 60, reps: 10 }, { weight: 62.5, reps: 8 }, { weight: 62.5, reps: 7 }, { weight: 57.5, reps: 10 }] });
        return json(route, { found: false });
      }
      if (p === `/exercises/${TG_ID}/last-sets-batch`) {
        const names = JSON.parse(req.postData() || "{}").names || [];
        const results = {};
        for (const n of names) results[n] = n.startsWith("Жим штанги")
          ? { found: true, date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19), rest_sec: 0, sets: [{ weight: 60, reps: 10 }, { weight: 62.5, reps: 8 }, { weight: 62.5, reps: 7 }, { weight: 57.5, reps: 10 }] }
          : { found: false };
        return json(route, { results });
      }
      if (p === `/workout/${TG_ID}/rest/cancel`) { (net.order = net.order || []).push("cancel"); return json(route, { ok: true }); }
      if (p === "/workout/77/set") {
        if (net.delaySet) await new Promise(r => setTimeout(r, net.delaySet));
        (net.order = net.order || []).push("set");
        if (net.setMode === "offline") return route.abort("internetdisconnected");
        if (net.setMode === "fail500") return json(route, { detail: "db" }, 500);
        net.setBodies.push(JSON.parse(req.postData() || "{}"));
        return json(route, { ok: true });
      }
      if (p === `/workout/${TG_ID}/active` && net.activeNotFound) {
        if (net.activeDelay) await new Promise(r => setTimeout(r, net.activeDelay));
        return json(route, { found: false });
      }
      if (p === `/food/quota/${TG_ID}`) return json(route, net.foodQuota || { used: 0, limit: 10 });
      if (p.startsWith(`/nutrition/${TG_ID}`) && req.method() === "GET") {
        (net.nutr = net.nutr || []).push(p.replace(String(TG_ID), "{tg}") + url.search);
        return json(route, { tdee: 2500, target_kcal: 2500, water_norm_glasses: 8, today_logs: [], logs: [],
                             today_totals: { kcal: 0, protein: 0, fat: 0, carb: 0 }, totals: { kcal: 0, protein: 0, fat: 0, carb: 0 } });
      }
      if (p === "/workout/77/finish") {
        (net.finishBodies = net.finishBodies || []).push(JSON.parse(req.postData() || "{}"));
        return json(route, net.finishEmpty ? { ok: true, empty: true, streak_days: 0, new_streak_rewards: [] } : { ok: true, streak_days: 1, new_streak_rewards: [] });
      }
      if (p === "/ai/ask-stream") {
        (net.aiCalls = net.aiCalls || []).push("stream");
        if (net.streamFail) return json(route, { detail: "boom" }, 500);
        const ev = (o) => `data: ${JSON.stringify(o)}\n\n`;
        return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" },
          body: ev({ type: "delta", text: "Хорошая работа: " }) + ev({ type: "delta", text: "жим прибавил 2,5 кг." }) + ev({ type: "done", answer: "Хорошая работа: жим прибавил 2,5 кг." }) });
      }
      if (p === "/ai/ask") { (net.aiCalls = net.aiCalls || []).push("ask"); return json(route, { answer: "Запасной разбор тренировки." }); }
      if (p === "/workout/77/ai-review") { (net.saved = net.saved || []).push(url.searchParams.get("review")); return json(route, { ok: true }); }
      if (p === "/workout/555") return json(route, { id: 555, date: "2026-10-23T20:00:00", status: "finished", total_volume: 600,
        exercises: [{ name: "Жим штанги лёжа", sets: [{ set_number: 1, weight: 60, reps: 10, rpe: null }] }] });
      if (p === "/food/analyze") {
        (net.analyze = net.analyze || []).push(1);
        if (net.foodLimit) return json(route, { detail: { code: "food_limit", used: 10, limit: 10 } }, 429);
        return json(route, { ok: true, dish_name: "Плов", weight_g: 300, calories: 600, protein_g: 20, fat_g: 25, carbs_g: 70, confidence: "high", note: null, quota: { used: 4, limit: 10 } });
      }
      if (p.startsWith("/custom-exercises")) return json(route, { exercises: [] });
      if (p.startsWith("/workout/") && p.endsWith("/state")) return json(route, { ok: true });
      return json(route, {});
    }
    return route.abort();
  });
}

const VIEWPORTS = [
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
];

const results = [];
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
async function scenario(name, vp, opts, act) {
  opts = { ...opts, net: opts.net || { setMode: opts.setFails ? "fail500" : "ok", setBodies: [], counts: {} } };
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU", timezoneId: "Asia/Tashkent" });
  const page = await ctx.newPage();
  if (opts.clock) await page.clock.setSystemTime(new Date(opts.clock));
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await setup(page, opts);
  await page.goto("http://app.test/gymbot-miniapp/");
  await page.waitForTimeout(1200);
  let info = {};
  try { info = (await act(page, opts.net)) || {}; } catch (e) { errors.push("ACT: " + e.message); }
  const file = path.join(OUT, `${name}_${vp.name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  results.push({ name, vp: vp.name, errors: errors.filter(e => !/Failed to load resource/.test(e)), ...info });
  await ctx.close();
}

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

const HOME = { user: { first_name: "Игорь" }, week: { done: 2, target: 3 } };
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
  await page.getByRole("button", { name: "‹" }).click();
  await page.waitForTimeout(500);
  const dayLabel = await page.getByText(/23 окт/).count();
  await page.getByRole("button", { name: "›" }).click();
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
