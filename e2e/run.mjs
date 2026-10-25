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
  openInvoice(url,cb){(window.__tgCalls=window.__tgCalls||[]).push(["openInvoice",url]);setTimeout(()=>cb&&cb(window.__invoiceStatus||"paid"),50)},
  shareToStory(url,opts){(window.__tgCalls=window.__tgCalls||[]).push(["shareToStory",url,opts||null])},
  shareMessage(id,cb){(window.__tgCalls=window.__tgCalls||[]).push(["shareMessage",id]);cb&&cb(true)},
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

async function setup(page, { lang = "ru", ls = null, setFails = false, curIdx = 0, tab = "workout", screen = "active_workout", params = {}, swr = null, liteSaved = false, quota = 0, platform = null, net = { setMode: "ok", setBodies: [], counts: {} } } = {}) {
  if (setFails) net.setMode = "fail500";
  await page.addInitScript(({ saved, lang, tab, screen, params, swr, quota, platform, ls }) => {
    if (ls) for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
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
  }, { saved: tab === "workout" ? savedWorkout(curIdx, liteSaved) : null, lang, tab, screen, params, swr, quota, platform, ls });
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
      if (p === "/workout/77/ai-review") {
        // текст разбора — в теле запроса, не в адресе (адрес попадает в журнал сервера)
        let rv = null; try { rv = JSON.parse(req.postData() || "{}").review ?? null; } catch {}
        (net.saved = net.saved || []).push(rv);
        (net.reviewInUrl = net.reviewInUrl || []).push(url.searchParams.has("review"));
        return json(route, { ok: true });
      }
      if (p === "/workout/555") return json(route, { id: 555, date: "2026-10-23T20:00:00", status: "finished", total_volume: 600,
        exercises: [{ name: "Жим штанги лёжа", sets: [{ set_number: 1, weight: 60, reps: 10, rpe: null }] }] });
      if (p === "/food/label") {
        (net.label = net.label || []).push(1);
        if (net.labelNot) return json(route, { ok: true, is_label: false, quota: { used: 2, limit: 10 } });
        return json(route, { ok: true, is_label: true, name: "Йогурт питьевой", brand: "Musaffo", per100: { kcal: 70, protein: 3, fat: 2.5, carbs: 9, fiber: null },
          serving_g: 250, category: "dairy", confidence: "high", note: null, quota: { used: 2, limit: 10 } });
      }
      if (p === "/food/label/save") {
        (net.labelSave = net.labelSave || []).push(JSON.parse(req.postData() || "{}"));
        return json(route, { ok: true, product_id: 9001, created: true, logged: { kcal: 175 } });
      }
      if (p === "/food/search") {
        (net.search = net.search || []).push(url.search);
        if (url.searchParams.get("category") === "national") return json(route, { total: 2, items: [
          { id: 1, name: "Плов (ош)", name_en: "Plov (pilaf)", name_uz: "Palov (osh)", name_kz: "Палау", calories: 250, protein: 7, fat: 12.5, carbs: 27,
            category: "national", serving_size_g: 350, dish_key: "plov", is_custom: false },
          { id: 2, name: "Манты", name_en: "Manti (dumplings)", name_uz: "Manti", name_kz: "Манты", calories: 200, protein: 10, fat: 10, carbs: 18,
            category: "national", serving_size_g: 250, dish_key: "manti", is_custom: false } ] });
        return json(route, { total: 0, items: [] });
      }
      if (p === "/food/analyze") {
        (net.analyze = net.analyze || []).push(1);
        if (net.foodLimit) return json(route, { detail: { code: "food_limit", used: 10, limit: 10 } }, 429);
        return json(route, { ok: true, dish_name: "Плов", weight_g: 300, calories: 600, protein_g: 20, fat_g: 25, carbs_g: 70, confidence: "high", note: null, quota: { used: 4, limit: 10 } });
      }
      if (p === `/premium/${TG_ID}`) {
        if (!net.premium) return json(route, {});
        const until = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 19);
        if (net.premInvoice) return json(route, { ...net.premium, active: true, source: "paid", until, trial_available: false });
        return json(route, net.premium);
      }
      if (p === `/premium/${TG_ID}/invoice`) {
        net.premInvoice = JSON.parse(req.postData() || "{}").plan;
        return json(route, { url: "https://t.me/$invoice-" + net.premInvoice, plan: net.premInvoice, stars: 199 });
      }
      if (p === `/premium/${TG_ID}/trial`) {
        (net.trials = net.trials || []).push(1);
        return json(route, { ...net.premium, active: true, source: "trial", until: "2026-10-31T10:00:00", trial_available: false });
      }
      const sm = p.match(/^\/share\/\d+\/workout\/(\d+)(\/prepared|\/send)?$/);
      if (sm) {
        (net.share = net.share || []).push((sm[2] || "/card").slice(1) + ":" + sm[1]);
        if (sm[2] === "/prepared") return json(route, { id: "prep-1" });
        if (sm[2] === "/send") return json(route, { ok: true });
        return json(route, { story_url: "https://api.test/api/share/img/77.story.ru.1.x.jpg", post_url: "https://api.test/p.jpg",
          thumb_url: "https://api.test/t.jpg", link: "https://t.me/GYMASH_bot?start=ref_ABC", caption: "💪", story_text: "Грудь 💪 t.me/GYMASH_bot", has_record: true });
      }
      if (p === `/workout/start/${TG_ID}`) {
        (net.starts = net.starts || []).push(JSON.parse(req.postData() || "{}"));
        return json(route, { workout_id: 77 });
      }
      if (p === `/social/${TG_ID}`) return json(route, net.social || { code: "IGOR0001", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=fr_IGOR0001", share_workouts: true, friends: [], teams: [] });
      const ivm = p.match(/^\/social\/\d+\/invite\/([A-Za-z0-9]+)$/);
      if (ivm) {
        (net.previews = net.previews || []).push(ivm[1]);
        const code = ivm[1].toUpperCase();
        if (code === "ANNA0002") return json(route, { kind: "friend", name: "Анна", already: false });
        if (code === "TEAM0007") return json(route, { kind: "team", id: 7, name: "Зал №1", members: 3, already: false });
        return json(route, { detail: { code: "bad_code" } }, 404);
      }
      if (p === `/social/${TG_ID}/friends/accept`) {
        (net.accepts = net.accepts || []).push(JSON.parse(req.postData() || "{}").code);
        return json(route, { ok: true, already: false, friend: { id: 2, name: "Анна" } });
      }
      if (p === `/social/${TG_ID}/teams/join`) {
        (net.joins = net.joins || []).push(JSON.parse(req.postData() || "{}").code);
        return json(route, { ok: true, already: false, team: (net.social?.teams || [])[0] });
      }
      if (p === `/social/${TG_ID}/feed`) return json(route, net.feed || { items: [], next_before: null });
      if (p === `/social/${TG_ID}/privacy` && req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        (net.privacy = net.privacy || []).push(b);
        net.social = { ...(net.social || {}), ...b };
        return json(route, { ok: true, share_workouts: net.social.share_workouts !== false, nudges_allowed: net.social.nudges_allowed !== false });
      }
      if (p === `/social/${TG_ID}/code/reset` && req.method() === "POST") {
        net.resets = (net.resets || 0) + 1;
        if (net.resetErr) return json(route, { detail: { code: "too_often" } }, 429);
        const code = "NEWC0DE" + net.resets, invite_link = `https://t.me/GYMASH_bot/gymapp?startapp=fr_${code}`;
        net.social = { ...(net.social || {}), code, invite_link };
        return json(route, { ok: true, code, invite_link });
      }
      const nm = p.match(/^\/social\/\d+\/friends\/(\d+)\/nudge$/);
      if (nm) {
        (net.nudges = net.nudges || []).push({ id: +nm[1], text: JSON.parse(req.postData() || "{}").text });
        if (net.nudgeErr) return json(route, { detail: { code: net.nudgeErr } }, net.nudgeErr === "no_links" ? 422 : 429);
        return json(route, { ok: true, delivered: !net.nudgeUndelivered, next_at: "2026-10-26T10:00:00" });
      }
      const lm = p.match(/^\/social\/\d+\/feed\/(\d+)\/like$/);
      if (lm) { (net.likes = net.likes || []).push(+lm[1]); return json(route, { ok: true, liked: true, likes: 3 }); }
      if (p === `/programs/${TG_ID}`) return json(route, net.programs || { programs: [], active: null });
      if (p.startsWith(`/programs/${TG_ID}/`) && p.endsWith("/start") && req.method() === "POST") {
        (net.progStart = net.progStart || []).push(p);
        if (net.progLocked) return json(route, { detail: { code: "premium_required" } }, 403);
        return json(route, { ok: true });
      }
      if (p.startsWith(`/programs/${TG_ID}/`)) return json(route, net.programDetail || {});
      if (p === `/strength/${TG_ID}`) return json(route, net.strength || { lifts: [], missing: [], keys: [], overall: null });
      if (p === `/whats-new/${TG_ID}`) {
        if (req.method() === "POST") { (net.wnPosts = net.wnPosts || []).push(JSON.parse(req.postData() || "{}").version); return json(route, { ok: true }); }
        net.wnGets = (net.wnGets || 0) + 1;
        return json(route, net.wn || { seen: "2099-01-01", new_user: false });
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
  await page.goto("http://app.test/gymbot-miniapp/" + (opts.startapp ? "?startapp=" + opts.startapp : ""));
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

// ── Premium и карточка тренировки ──
const PREMIUM = { enabled: true, visible: true, active: false, until: null, source: null, trial_available: true, trial_days: 7,
  subscription: null, plans: [{ id: "month", stars: 199, days: 30, recurring: true }, { id: "year", stars: 1290, days: 365, recurring: false }],
  perks: { ai_free: 5, ai_premium: 30, food_free: 10, food_premium: 20 } };
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
const STRENGTH = { gender: "male", bodyweight: 80, missing: [], keys: ["bench", "squat", "deadlift", "pullup"], age_coef: 1,
  overall: { level: 3, level_key: "intermediate", score: 3.2, percentile: 55, lifts: 2 },
  lifts: [
    { key: "bench", kind: "ratio", best: 93.3, from: { weight: 80, reps: 5, date: "2026-10-20T10:00:00" }, exercise: "Жим штанги лёжа",
      level: 3, level_key: "intermediate", score: 3.33, percentile: 60, ratio: 1.17, thresholds: [40, 60, 80, 120, 160],
      next: { level: "advanced", target: 120, to_go: 26.7 }, community: { people: 13, stronger_than_pct: 69 } },
    { key: "pullup", kind: "reps", best: 13, from: { weight: 0, reps: 13, date: "2026-10-20T10:00:00" }, exercise: "Подтягивания широким хватом",
      level: 3, level_key: "intermediate", score: 3.12, percentile: 54, ratio: null, thresholds: [1, 6, 12, 20, 28],
      next: { level: "advanced", target: 20, to_go: 7 }, community: null } ] };
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
const PROG_LIST = { active: { id: 5, slug: "fullbody_beginner", done: 3, total: 24, finished: false, next_day: 1, week: 2,
    title: "Фулбади для начинающих", next_day_title: "День B" },
  programs: [
    { slug: "fullbody_beginner", title: "Фулбади для начинающих", desc: "Всё тело за тренировку.", level: "beginner", days_per_week: 3, weeks: 8,
      premium: false, locked: false, total: 24, day_titles: ["День A", "День B"] },
    { slug: "ppl", title: "Тяни-толкай-ноги", desc: "Шесть тренировок в неделю.", level: "intermediate", days_per_week: 6, weeks: 8,
      premium: true, locked: true, total: 48, day_titles: ["Толкай", "Тяни", "Ноги"] },
    { slug: "home_dumbbells", title: "Дома с гантелями", desc: "Пара гантелей.", level: "beginner", days_per_week: 3, weeks: 6,
      premium: false, locked: false, total: 18, day_titles: ["Ноги и жимы", "Тяги и кор"] } ] };
const PROG_DETAIL = { slug: "fullbody_beginner", title: "Фулбади для начинающих", desc: "Всё тело за тренировку.", level: "beginner",
  days_per_week: 3, weeks: 8, total: 24, premium: false, locked: false, note: "Добавляйте вес.",
  active: { id: 5, slug: "fullbody_beginner", done: 3, total: 24, finished: false, next_day: 1, week: 2 },
  days: [
    { index: 0, title: "День A", exercises: [{ name: "Жим штанги лёжа", sets: 3, reps: "8-10", rest: 120, exercise_id: 101 }] },
    { index: 1, title: "День B", exercises: [{ name: "Жим штанги лёжа", sets: 3, reps: "10", rest: 90, exercise_id: 101 },
                                            { name: "Планка", sets: 3, reps: "30-45s", rest: 60, exercise_id: null }] } ] };
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
const TEAM = { id: 7, name: "Зал №1", code: "TEAM0007", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=tm_TEAM0007", is_owner: false,
  members: 3, week_total: 7, last_week_total: 9, my_place: 2,
  board: [ { id: 2, name: "Анна", is_me: false, is_owner: true, week: 4, last_week: 3, place: 1 },
           { id: 1, name: "Игорь", is_me: true, is_owner: false, week: 2, last_week: 4, place: 2 },
           { id: 3, name: "Борис", is_me: false, is_owner: false, week: 1, last_week: 2, place: 3 } ] };
const SOCIAL = { code: "IGOR0001", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=fr_IGOR0001", share_workouts: true,
  friends: [ { id: 2, name: "Анна", week: 4, last_workout_at: "2026-10-24T08:00:00" } ], teams: [TEAM] };
const SOCIAL_NUDGE = { code: "IGOR0001", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=fr_IGOR0001", share_workouts: true, teams: [],
  friends: [
    { id: 2, name: "Анна", week: 4, last_workout_at: "2026-10-24T08:00:00", idle_days: 0, inactive: false, can_nudge: false, nudged_at: null },
    { id: 3, name: "Борис", week: 0, last_workout_at: "2026-10-19T08:00:00", idle_days: 5, inactive: true, can_nudge: true, nudged_at: null },
    { id: 5, name: "Вика", week: null, last_workout_at: null, idle_days: null, inactive: null, can_nudge: true, nudged_at: null },
    { id: 6, name: "Гоша", week: 0, last_workout_at: null, idle_days: null, inactive: true, can_nudge: false, nudged_at: "2026-10-24T20:00:00" } ] };
const FEED = { next_before: null, items: [
  { workout_id: 901, user_id: 2, is_me: false, name: "Анна", date: "2026-10-24T08:00:00", duration_min: 50, volume: 4200,
    exercises: ["Жим штанги лёжа", "Приседания со штангой"], exercises_count: 5, sets: 15,
    records: [{ exercise: "Жим штанги лёжа", weight: 60, prev: 55 }], likes: 2, liked: false },
  { workout_id: 900, user_id: 1, is_me: true, name: "Игорь", date: "2026-10-23T08:00:00", duration_min: 0, volume: 0,
    exercises: ["Планка"], exercises_count: 1, sets: 3, records: [], likes: 0, liked: false } ] };
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
const WN_NET = () => ({ setMode: "ok", setBodies: [], counts: {}, home: HOME, premium: PREMIUM, wn: { seen: null, new_user: false } });
await scenario("58_whats_new_tour", VIEWPORTS[1], { tab: "menu", screen: null, net: WN_NET() }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const first = await page.getByText("ЧТО НОВОГО · 1/7").count();
  const title1 = await page.locator("#wn-title").textContent();
  const levels = await page.getByText("от «Старт» до «Элита»", { exact: false }).count();
  const bb = await page.evaluate(() => window.Telegram.WebApp.BackButton.isVisible);
  const titles = [title1];
  for (let k = 0; k < 6; k++) { await page.getByRole("button", { name: "ДАЛЕЕ" }).click(); await page.waitForTimeout(120); titles.push(await page.locator("#wn-title").textContent()); }
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
  const kicker = await page.getByText("ПОЛЕЗНО ЗНАТЬ · 1/7").count();
  const box = await page.getByRole("dialog").boundingBox();
  const swipe = async (from, to) => {
    await page.dispatchEvent('[role="dialog"]', "touchstart", { touches: [{ identifier: 1, clientX: from, clientY: 400 }], changedTouches: [{ identifier: 1, clientX: from, clientY: 400 }] });
    await page.dispatchEvent('[role="dialog"]', "touchend", { touches: [], changedTouches: [{ identifier: 1, clientX: to, clientY: 400 }] });
    await page.waitForTimeout(150);
  };
  await swipe(box.width - 40, 60);
  const afterLeft = await page.getByText("ПОЛЕЗНО ЗНАТЬ · 2/7").count();
  await swipe(60, box.width - 40);
  const afterRight = await page.getByText("ПОЛЕЗНО ЗНАТЬ · 1/7").count();
  await page.evaluate(() => window.Telegram.WebApp.BackButton._h.forEach(f => f()));
  await page.waitForTimeout(300);
  return { kicker, afterLeft, afterRight, dialogAfterBack: await page.getByRole("dialog").count(), posts: net.wnPosts || [] };
});
await scenario("61_whats_new_not_again", VIEWPORTS[1], { tab: "menu", screen: null, ls: { gymbot_wn_seen_123456789: "2026-10-25c" }, net: WN_NET() }, async (page, net) => {
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
  const kicker = await page.getByText("YANGILIKLAR · 1/7").count();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await page.getByRole("button", { name: "MENING DARAJAM" }).click();
  await page.waitForTimeout(400);
  return { kicker, overflow, dialog: await page.getByRole("dialog").count(), strengthReq: net.counts["GET /strength/{tg}"] || 0, posts: net.wnPosts || [] };
});

// ── «Что нового»: видел прошлую подборку — только новый слайд ──
await scenario("64_whats_new_only_new", VIEWPORTS[1], { tab: "menu", screen: null, net: { ...WN_NET(), wn: { seen: "2026-10-25", new_user: false }, social: SOCIAL_NUDGE, feed: FEED } }, async (page, net) => {
  await page.getByRole("dialog").waitFor({ timeout: 5000 });
  const only = await page.getByText("ЧТО НОВОГО · 1/2").count();
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
  const only = await page.getByText("ЧТО НОВОГО · 1/1").count();
  const title = await page.locator("#wn-title").textContent();
  await page.screenshot({ path: path.join(OUT, "67b_whats_new_friends_settings_360x740.png") });
  await page.getByRole("button", { name: "Открыть настройки" }).click();
  const sw = page.getByRole("switch", { name: /Получать напоминания от друзей/ });
  await sw.waitFor({ timeout: 4000 });
  return { only, title, posts: net.wnPosts || [], checked: await sw.getAttribute("aria-checked") };
});
// ── Друзья: отключить напоминания, сменить ссылку ──
const SOCIAL_SETTINGS = { ...SOCIAL_NUDGE, nudges_allowed: true,
  friends: [...SOCIAL_NUDGE.friends, { id: 7, name: "Дана", week: 0, last_workout_at: null, idle_days: 9, inactive: true, can_nudge: false, nudges_off: true, nudged_at: null }] };
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
