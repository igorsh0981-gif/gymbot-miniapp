// Общая часть e2e: подмена сети (заглушка Telegram SDK, API и R2 — фикстуры),
// размеры экранов, запуск сценария и данные для экранов. Используют
// e2e/run.mjs (сценарии) и e2e/a11y.mjs (проверка доступности axe-core).
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.dirname(new URL(import.meta.url).pathname);
export const DIST = path.join(ROOT, "..", "dist");
export const OUT = path.join(ROOT, "shots");
fs.mkdirSync(OUT, { recursive: true });
export const API = "https://web-production-4fe0b.up.railway.app/api";
export const MEDIA = "https://media.test";
export const TG_ID = 123456789;

const PHOTO = fs.readFileSync(path.join(ROOT, "fixtures/photo.jpg"));
const ICON = fs.readFileSync(path.join(ROOT, "fixtures/icon.jpg"));

export const groups = [{ id: 1, name: "Грудные мышцы", name_en: "Chest", name_uz: "Ko‘krak", name_kz: "Кеуде", emoji: "🫁", icon_url: `${MEDIA}/muscle_groups/1/icon.jpg?v=1` }];
const mk = (id, name, extra = {}) => ({
  id, name, name_en: name + " (en)", name_uz: name + " (uz)", name_kz: name + " (kz)",
  description: "Базовое упражнение для силы и массы грудных мышц.",
  technique: "1️⃣ Лечь на скамью, хват шире плеч\n2️⃣ Опустить штангу к груди\n3️⃣ Выжать вверх, не отрывая таз\n4️⃣ Контроль опускания 3 секунды",
  difficulty: "intermediate", equipment: "barbell", sets_recommended: 4, reps_recommended: "8-10",
  muscle_group_id: 1, group_name: "Грудные мышцы", group_name_en: "Chest", group_name_uz: "Ko‘krak", group_name_kz: "Кеуде",
  group_emoji: "🫁", group_icon_url: `${MEDIA}/muscle_groups/1/icon.jpg?v=1`,
  photo_url: `${MEDIA}/exercises/ex${id}/photo.jpg?v=1`, video_url: null, exercise_type: "strength", ...extra,
});
export const catalog = [
  mk(101, "Жим штанги лёжа"),
  mk(102, "Жим гантелей на наклонной скамье"),
  mk(103, "Сведение рук в кроссовере", { photo_url: `${MEDIA}/exercises/missing/photo.jpg?v=1` }),
];

export function savedWorkout(curIdx, lite = false) {
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
export const tapSetDone = (page) => page.locator("#root button", { hasText: "ПОДХОД ВЫПОЛНЕН" }).first().dispatchEvent("click");

export function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
}

export async function setup(page, { lang = "ru", ls = null, setFails = false, curIdx = 0, tab = "workout", screen = "active_workout", params = {}, swr = null, liteSaved = false, quota = 0, platform = null, net = { setMode: "ok", setBodies: [], counts: {} } } = {}) {
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

export const VIEWPORTS = [
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
];

// Сценарий: новый контекст браузера с подменённой сетью, действие, скриншот в e2e/shots.
export function makeScenario(browser, results) {
  return async function scenario(name, vp, opts, act) {
    opts = { ...opts, net: opts.net || { setMode: opts.setFails ? "fail500" : "ok", setBodies: [], counts: {} } };
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ru-RU", timezoneId: "Asia/Tashkent" });
    const page = await ctx.newPage();
    if (opts.clock) await page.clock.setSystemTime(new Date(opts.clock));
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await setup(page, opts);
    if (opts.before) await opts.before(page, opts.net);   // свои подмены поверх общих (последний route — главный)
    await page.goto("http://app.test/gymbot-miniapp/" + (opts.startapp ? "?startapp=" + opts.startapp : ""));
    await page.waitForTimeout(1200);
    let info = {};
    try { info = (await act(page, opts.net)) || {}; } catch (e) { errors.push("ACT: " + e.message); }
    const file = path.join(OUT, `${name}_${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    results.push({ name, vp: vp.name, errors: errors.filter(e => !/Failed to load resource/.test(e)), ...info });
    await ctx.close();
  };
}

// ── Данные для экранов ──
export const HOME = { user: { first_name: "Игорь" }, week: { done: 2, target: 3 } };
export const PREMIUM = { enabled: true, visible: true, active: false, until: null, source: null, trial_available: true, trial_days: 7,
  subscription: null, plans: [{ id: "month", stars: 199, days: 30, recurring: true }, { id: "year", stars: 1290, days: 365, recurring: false }],
  perks: { ai_free: 5, ai_premium: 30, food_free: 10, food_premium: 20 } };
export const STRENGTH = { gender: "male", bodyweight: 80, missing: [], keys: ["bench", "squat", "deadlift", "pullup"], age_coef: 1,
  overall: { level: 3, level_key: "intermediate", score: 3.2, percentile: 55, lifts: 2 },
  lifts: [
    { key: "bench", kind: "ratio", best: 93.3, from: { weight: 80, reps: 5, date: "2026-10-20T10:00:00" }, exercise: "Жим штанги лёжа",
      level: 3, level_key: "intermediate", score: 3.33, percentile: 60, ratio: 1.17, thresholds: [40, 60, 80, 120, 160],
      next: { level: "advanced", target: 120, to_go: 26.7 }, community: { people: 13, stronger_than_pct: 69 } },
    { key: "pullup", kind: "reps", best: 13, from: { weight: 0, reps: 13, date: "2026-10-20T10:00:00" }, exercise: "Подтягивания широким хватом",
      level: 3, level_key: "intermediate", score: 3.12, percentile: 54, ratio: null, thresholds: [1, 6, 12, 20, 28],
      next: { level: "advanced", target: 20, to_go: 7 }, community: null } ] };
export const PROG_LIST = { active: { id: 5, slug: "fullbody_beginner", done: 3, total: 24, finished: false, next_day: 1, week: 2,
    title: "Фулбади для начинающих", next_day_title: "День B" },
  programs: [
    { slug: "fullbody_beginner", title: "Фулбади для начинающих", desc: "Всё тело за тренировку.", level: "beginner", days_per_week: 3, weeks: 8,
      premium: false, locked: false, total: 24, day_titles: ["День A", "День B"] },
    { slug: "ppl", title: "Тяни-толкай-ноги", desc: "Шесть тренировок в неделю.", level: "intermediate", days_per_week: 6, weeks: 8,
      premium: true, locked: true, total: 48, day_titles: ["Толкай", "Тяни", "Ноги"] },
    { slug: "home_dumbbells", title: "Дома с гантелями", desc: "Пара гантелей.", level: "beginner", days_per_week: 3, weeks: 6,
      premium: false, locked: false, total: 18, day_titles: ["Ноги и жимы", "Тяги и кор"] } ] };
export const PROG_DETAIL = { slug: "fullbody_beginner", title: "Фулбади для начинающих", desc: "Всё тело за тренировку.", level: "beginner",
  days_per_week: 3, weeks: 8, total: 24, premium: false, locked: false, note: "Добавляйте вес.",
  active: { id: 5, slug: "fullbody_beginner", done: 3, total: 24, finished: false, next_day: 1, week: 2 },
  days: [
    { index: 0, title: "День A", exercises: [{ name: "Жим штанги лёжа", sets: 3, reps: "8-10", rest: 120, exercise_id: 101 }] },
    { index: 1, title: "День B", exercises: [{ name: "Жим штанги лёжа", sets: 3, reps: "10", rest: 90, exercise_id: 101 },
                                            { name: "Планка", sets: 3, reps: "30-45s", rest: 60, exercise_id: null }] } ] };
export const TEAM = { id: 7, name: "Зал №1", code: "TEAM0007", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=tm_TEAM0007", is_owner: false,
  members: 3, week_total: 7, last_week_total: 9, my_place: 2,
  board: [ { id: 2, name: "Анна", is_me: false, is_owner: true, week: 4, last_week: 3, place: 1 },
           { id: 1, name: "Игорь", is_me: true, is_owner: false, week: 2, last_week: 4, place: 2 },
           { id: 3, name: "Борис", is_me: false, is_owner: false, week: 1, last_week: 2, place: 3 } ] };
export const SOCIAL = { code: "IGOR0001", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=fr_IGOR0001", share_workouts: true,
  friends: [ { id: 2, name: "Анна", week: 4, last_workout_at: "2026-10-24T08:00:00" } ], teams: [TEAM] };
export const SOCIAL_NUDGE = { code: "IGOR0001", invite_link: "https://t.me/GYMASH_bot/gymapp?startapp=fr_IGOR0001", share_workouts: true, teams: [],
  friends: [
    { id: 2, name: "Анна", week: 4, last_workout_at: "2026-10-24T08:00:00", idle_days: 0, inactive: false, can_nudge: false, nudged_at: null },
    { id: 3, name: "Борис", week: 0, last_workout_at: "2026-10-19T08:00:00", idle_days: 5, inactive: true, can_nudge: true, nudged_at: null },
    { id: 5, name: "Вика", week: null, last_workout_at: null, idle_days: null, inactive: null, can_nudge: true, nudged_at: null },
    { id: 6, name: "Гоша", week: 0, last_workout_at: null, idle_days: null, inactive: true, can_nudge: false, nudged_at: "2026-10-24T20:00:00" } ] };
export const FEED = { next_before: null, items: [
  { workout_id: 901, user_id: 2, is_me: false, name: "Анна", date: "2026-10-24T08:00:00", duration_min: 50, volume: 4200,
    exercises: ["Жим штанги лёжа", "Приседания со штангой"], exercises_count: 5, sets: 15,
    records: [{ exercise: "Жим штанги лёжа", weight: 60, prev: 55 }], likes: 2, liked: false },
  { workout_id: 900, user_id: 1, is_me: true, name: "Игорь", date: "2026-10-23T08:00:00", duration_min: 0, volume: 0,
    exercises: ["Планка"], exercises_count: 1, sets: 3, records: [], likes: 0, liked: false } ] };
export const WN_NET = () => ({ setMode: "ok", setBodies: [], counts: {}, home: HOME, premium: PREMIUM, wn: { seen: null, new_user: false } });
export const SOCIAL_SETTINGS = { ...SOCIAL_NUDGE, nudges_allowed: true,
  friends: [...SOCIAL_NUDGE.friends, { id: 7, name: "Дана", week: 0, last_workout_at: null, idle_days: 9, inactive: true, can_nudge: false, nudges_off: true, nudged_at: null }] };
