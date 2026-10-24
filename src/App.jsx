import { useState, useEffect, useRef, Fragment } from "react";

const tg = window.Telegram?.WebApp;
// Адрес API задаётся при сборке (VITE_API_URL) — для тестового контура.
// Без переменной — боевой, как раньше.
const API = (import.meta.env && import.meta.env.VITE_API_URL) || "https://web-production-4fe0b.up.railway.app/api";

// Автоматически прикрепляем подписанный Telegram initData ко всем запросам к своему API —
// бэкенд проверяет эту подпись и не доверяет просто tg_id из URL. Оборачиваем fetch один раз
// здесь, а не в каждом из сотен вызовов fetch() по всему файлу — гарантированно покрывает всё.
const _originalFetch = window.fetch.bind(window);
window.fetch = (url, options = {}) => {
  const urlStr = typeof url === "string" ? url : (url?.url || "");
  const isOwn = urlStr.startsWith(API);
  const method = (options.method || "GET").toUpperCase();
  const opts = (isOwn && tg?.initData)
    ? { ...options, headers: { ...(options.headers || {}), "X-Telegram-Init-Data": tg.initData } }
    : options;
  const res = _originalFetch(url, opts);
  // Любой изменяющий запрос к своему API сбрасывает затронутые записи кэша.
  // Делаем это здесь, а не в двадцати местах по экранам: про половину точек
  // мутации рано или поздно забудешь, и человек увидит устаревшие данные.
  if (isOwn && method !== "GET") {
    return res.then(r => { if (r.ok) _invalidateByMutation(urlStr); return r; });
  }
  return res;
};

// ── Тактильный отклик ────────────────────────────────────────────────────────
// Как в AiEvent (src/tg/haptics.ts): только через Telegram и с проверкой версии,
// вне Telegram и на старых клиентах — молча ничего. navigator.vibrate не трогаем:
// в WebView он ведёт себя непредсказуемо, а на iOS его нет вовсе.
const haptic = {
  _ok() { try { return !!tg?.HapticFeedback && !!tg?.isVersionAtLeast?.("6.1"); } catch { return false; } },
  select() { if (haptic._ok()) { try { tg.HapticFeedback.selectionChanged(); } catch {} } },
  impact(style = "light") { if (haptic._ok()) { try { tg.HapticFeedback.impactOccurred(style); } catch {} } },
  notify(type = "success") { if (haptic._ok()) { try { tg.HapticFeedback.notificationOccurred(type); } catch {} } },
};

// ── Очередь записей тренировки ───────────────────────────────────────────────
// «Подход выполнен» больше не ждёт сервер: подход сразу появляется на экране,
// а запрос уходит отсюда фоном. Раньше человек после каждого подхода смотрел
// 2–3 секунды на «Сохраняем…», а в подвальном зале без связи подход терялся.
// Очередь лежит в localStorage и переживает закрытие приложения. Отправка
// строго по порядку: сервер узнаёт повтор подхода по последней строке, оценка
// RPE должна лечь на свой подход, а «пропустить отдых» — прийти после подхода,
// который этот отдых запустил.
const SET_QUEUE_KEY = "gymbot_set_queue";
const SET_QUEUE_PARKED_KEY = "gymbot_set_queue_parked";
const SQ_STALE_REST_MS = 20000;   // позже этого подход отдых уже не запускает
const SQ_PARK_AFTER = 6;          // столько сбоев 5xx подряд — запись в сторону, очередь дальше
const _sqLoad = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const _sq = {
  // Отложенные в прошлый раз записи получают ещё одну попытку при запуске
  items: [..._sqLoad(SET_QUEUE_KEY), ..._sqLoad(SET_QUEUE_PARKED_KEY).map(it => ({ ...it, fails: 0 }))],
  parked: [],
  busy: false, timer: null, tries: 0, lastStatus: null, dropped: 0, listeners: new Set(),
};
try { localStorage.removeItem(SET_QUEUE_PARKED_KEY); } catch {}
function _sqUid() { return tg?.initDataUnsafe?.user?.id || null; }
function _sqSave() {
  try {
    localStorage.setItem(SET_QUEUE_KEY, JSON.stringify(_sq.items));
    localStorage.setItem(SET_QUEUE_PARKED_KEY, JSON.stringify(_sq.parked));
  } catch {}
}
function _sqEmit() { _sq.listeners.forEach(f => { try { f(); } catch {} }); }
// Записи этого пользователя: на одном телефоне может быть несколько аккаунтов
// Telegram с общим хранилищем, и чужая запись не должна стопорить свою очередь.
function _sqMine() { const u = _sqUid(); return _sq.items.filter(it => !it.uid || !u || it.uid === u); }
function sqPending() { return _sqMine().length; }
function sqPendingSets(workoutId) { return _sqMine().filter(it => it.kind === "set" && it.workoutId === workoutId).length; }
/** Подходы тренировки, которых сервер ещё не получил: в очереди и отложенные
 *  после серии 5xx. Отложенные sqPending не видит — а сервер, не найдя подходов,
 *  удалил бы тренировку, и они пропали бы при следующем запуске с 404. */
function sqUnsentSets(workoutId) {
  const u = _sqUid();
  return [..._sq.items, ..._sq.parked].filter(it => (!it.uid || !u || it.uid === u) && it.kind === "set" && it.workoutId === workoutId).length;
}
function sqSubscribe(f) { _sq.listeners.add(f); return () => _sq.listeners.delete(f); }
function sqPush(kind, url, body, extra = {}) {
  _sq.items.push({ kind, url, body, at: Date.now(), uid: _sqUid(), fails: 0, ...extra });
  _sqSave(); _sqEmit(); sqKick(0);
}
function sqKick(delay = 0) { clearTimeout(_sq.timer); _sq.timer = setTimeout(_sqRun, delay); }
async function _sqRun() {
  if (_sq.busy) return;
  _sq.busy = true;
  try {
    for (;;) {
      const it = _sqMine()[0];
      if (!it) break;
      const body = { ...(it.body || {}) };
      if (it.kind === "set") {
        const age = Date.now() - (it.at || Date.now());
        body.age_ms = Math.max(0, age);
        if (age > SQ_STALE_REST_MS) body.rest_sec = null;   // отдых давно прошёл
      }
      let res = null;
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const killer = ctl ? setTimeout(() => ctl.abort(), 15000) : null;   // зависший запрос не держит очередь
      try {
        res = await fetch(it.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl?.signal });
      } catch {} finally { if (killer) clearTimeout(killer); }
      const st = res ? res.status : 0;
      const drop = () => { _sq.items = _sq.items.filter(x => x !== it); _sq.tries = 0; _sq.lastStatus = null; _sqSave(); _sqEmit(); };
      if (res && res.ok) { drop(); continue; }
      if (st === 404 || st === 422 || st === 400) {
        // Тренировки нет или запрос негодный — повтор не поможет, а очередь встала бы навсегда
        console.warn("[set queue] отброшено", st, it);
        if (it.kind === "set") _sq.dropped++;
        drop(); continue;
      }
      if (st >= 500 && ++it.fails >= SQ_PARK_AFTER) {
        // Сервер упорно не принимает именно эту запись — откладываем её до
        // следующего запуска, чтобы за ней не встали все остальные подходы.
        console.warn("[set queue] отложено до следующего запуска", st, it);
        _sq.parked.push(it); drop(); continue;
      }
      _sq.tries++; _sq.lastStatus = st; _sqSave(); _sqEmit();
      // 401/403 — устарела подпись Telegram: поможет только новое открытие
      // приложения, поэтому без частых повторов, но очередь сохраняем.
      const delay = (st === 401 || st === 403) ? 60000 : Math.min(30000, 2000 * 2 ** Math.min(_sq.tries - 1, 4));
      sqKick(delay);
      return;
    }
  } finally { _sq.busy = false; }
}
/** Дождаться отправки очереди. Ждём, пока она движется: ставим предел не на
 *  общее время, а на простой — 20 подходов после зала без связи уходят дольше
 *  восьми секунд, и обрезать их на середине нельзя. true — всё ушло. */
async function sqFlush(stallMs = 8000, maxMs = 90000) {
  const start = Date.now();
  let left = sqPending(), changed = Date.now();
  while (left && Date.now() - changed < stallMs && Date.now() - start < maxMs) {
    if (!_sq.busy) { _sq.tries = 0; sqKick(0); }   // человек ждёт — без пауз между повторами
    await new Promise(r => setTimeout(r, 300));
    const now = sqPending();
    if (now !== left) { left = now; changed = Date.now(); }
  }
  return sqPending() === 0;
}
try {
  window.addEventListener("online", () => sqKick(0));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sqKick(0); });
} catch {}
if (_sq.items.length) sqKick(1500);   // осталось с прошлого запуска

// ─────────────────────────────────────────────────────────────────────────────
//  Кэш GET-запросов с инвалидацией по событиям
//
//  В логах одного сеанса: /home семь раз, /planned пять, /alternatives три,
//  /sport-types три. Данные те же, а каждый возврат на экран ждёт сеть — отсюда
//  и ощущение, что переходы стали долгими.
//
//  Кэш живёт в памяти вкладки, а не в localStorage: устаревшие данные после
//  перезапуска приложения опаснее лишнего запроса.
// ─────────────────────────────────────────────────────────────────────────────
const _apiCache = new Map();   // url -> {t, data}

// ── Последний ответ — на диске, для мгновенного первого кадра ────────────────
// Главный экран, профиль и каталог сохраняются в localStorage и при следующем
// запуске показываются сразу, пока идёт свежий запрос; придёт ответ — экран
// обновится. Раньше первый кадр ждал сеть Ташкент — Калифорния и обратно.
// Чтобы старое не путало, запись стирается тем же событием, что и кэш в
// памяти (завершили тренировку — главный экран с диска уже не берём), и
// не живёт дольше недели.
const SWR_PREFIX = "gymbot_swr:";
const SWR_MAX_AGE = 7 * 86400000;
const SWR_RULES = [/\/home\/\d+$/, /\/user\/\d+$/, /\/exercises\?lang=[a-z]+&lite=1$/, /\/exercises\/\d+\/details\?lang=[a-z]+$/];
function swrRead(url){
  try{
    const e=JSON.parse(localStorage.getItem(SWR_PREFIX+url)||"null");
    return e&&Date.now()-e.t<SWR_MAX_AGE?e.d:null;
  }catch{return null;}
}
// Из профиля на диск не попадают данные о здоровье: для первого кадра они
// не нужны, а лежать в хранилище браузера неделю им незачем. Профиль с диска
// помечается _disk — экран профиля ждёт свежий, чтобы не сохранить форму
// с пустыми заболеваниями поверх настоящих.
const SWR_STRIP = {user:["medical_conditions","allergies"]};
function swrWrite(url,data){
  if(!data||!SWR_RULES.some(r=>r.test(url)))return;
  let d=data;
  if(/\/user\/\d+$/.test(url)){d={...data};for(const k of SWR_STRIP.user)delete d[k];}
  const v=JSON.stringify({t:Date.now(),d});
  const put=()=>{try{localStorage.setItem(SWR_PREFIX+url,v);return true;}catch{return false;}};
  if(put())return;
  // Хранилище переполнено. Освобождаем от самого объёмного и легко
  // восстановимого, по шагам, а не ждём, пока откажет запись очереди подходов
  // (она тоже живёт в localStorage). Технику текущего языка не трогаем
  // никогда: она заранее загружена под тренировку без связи.
  const cur=LANG_STORE.current||"ru";
  const isCat=k=>/\/exercises\?lang=/.test(k), isDet=k=>/\/exercises\/\d+\/details\?lang=/.test(k);
  const otherLang=k=>!k.includes(`lang=${cur}`);
  const steps=[k=>isCat(k)&&otherLang(k), k=>isDet(k)&&otherLang(k)];
  // Каталог текущего языка жертвуем ради всего остального, но не ради самого себя
  if(!isCat(url))steps.push(k=>isCat(k));
  for(const pred of steps){
    swrRemove(pred);
    if(put())return;
  }
}
function swrRemove(pred){
  try{
    for(let i=localStorage.length-1;i>=0;i--){
      const k=localStorage.key(i);
      if(k&&k.startsWith(SWR_PREFIX)&&pred(k.slice(SWR_PREFIX.length)))localStorage.removeItem(k);
    }
  }catch{}
}
/** Уборка при запуске: просроченное, чужие аккаунты на этом устройстве
 *  (Telegram даёт общее хранилище всем, кто открывает приложение с телефона)
 *  и каталог с техникой на других языках. */
function swrSweep(tgId,lang){
  try{
    const now=Date.now();
    for(let i=localStorage.length-1;i>=0;i--){
      const k=localStorage.key(i);
      if(!k||!k.startsWith(SWR_PREFIX))continue;
      const url=k.slice(SWR_PREFIX.length);
      let drop=false;
      try{const e=JSON.parse(localStorage.getItem(k)||"null");drop=!e||!(now-e.t<SWR_MAX_AGE);}catch{drop=true;}
      const own=url.match(/\/(home|user)\/(\d+)$/);
      if(own&&String(own[2])!==String(tgId))drop=true;
      const lm=url.match(/[?&]lang=([a-z]+)/);
      if(lm&&lang&&lm[1]!==lang)drop=true;
      if(drop)localStorage.removeItem(k);
    }
  }catch{}
}
function swrDrop(parts){
  try{
    for(let i=localStorage.length-1;i>=0;i--){
      const k=localStorage.key(i);
      if(k&&k.startsWith(SWR_PREFIX)&&parts.some(p=>k.includes(p)))localStorage.removeItem(k);
    }
  }catch{}
}
const _apiInflight = new Map(); // url -> Promise, чтобы два экрана не дёргали одно и то же

// Сколько живёт ответ. Короткий у того, что меняется от действий человека,
// длинный у справочников.
const API_TTL = [
  [/\/sport-types$/,        60 * 60 * 1000],
  // Не просто $: у каталога появился параметр языка (?lang=uz), и с якорем на
  // конец строки правило перестало бы совпадать — каталог вообще выпал бы из
  // кэша и качался заново при каждом запуске. Слэш перед словом обязателен,
  // иначе правило поймало бы /custom-exercises/.
  [/\/exercises(\?|$)/,     30 * 60 * 1000],
  [/\/exercises\/\d+\/details/, 24 * 60 * 60 * 1000],   // техника одного упражнения
  // Как и у каталога, не просто $: у справочника сплитов теперь есть параметр
  // языка, и с якорем на конец строки правило бы не совпало.
  [/\/splits(\?|$)/,        60 * 60 * 1000],
  [/\/custom-exercises\//,   5 * 60 * 1000],
  [/\/home\/\d+\/alternatives/, 3 * 60 * 1000],
  [/\/home\/\d+$/,           2 * 60 * 1000],
  [/\/strength\/\d+$/,       5 * 60 * 1000],
  [/\/programs\/\d+/,        2 * 60 * 1000],   // программы: сброс после тренировки и старта/стопа   // силовые ранги: сбрасываются после тренировки и смены веса
  [/\/planned\/\d+$/,        2 * 60 * 1000],
  [/\/user\/\d+$/,           2 * 60 * 1000],
  [/\/user\/\d+\/supplements/, 5 * 60 * 1000],
];
function _ttlFor(url){
  for(const [re,ms] of API_TTL) if(re.test(url)) return ms;
  return 0; // не кэшируем то, что не перечислено явно
}

// Поколение адреса растёт при каждом сбросе. Запрос, вылетевший ДО сброса,
// снимает данные до изменения — и, вернувшись, не должен класть их в кэш.
// Иначе так: открыт главный экран, запрос в полёте, человек жмёт «Завершить
// тренировку», кэш сброшен — и приехавший следом старый ответ ложится свежим
// на две минуты, показывая состояние до тренировки.
let _apiGen = 0;

/** GET с кэшем. force:true — сходить на сервер и обновить запись. */
function apiGet(url,{force=false}={}){
  const ttl=_ttlFor(url);
  if(ttl===0) return fetch(url).then(r=>{if(!r.ok)throw new Error(r.status);return r.json();});
  const now=Date.now();
  if(!force){
    const hit=_apiCache.get(url);
    if(hit&&now-hit.t<ttl) return Promise.resolve(hit.data);
    const flying=_apiInflight.get(url);
    if(flying) return flying;
  }
  const genAtStart=_apiGen;
  const p=fetch(url)
    .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
    .then(d=>{
      // Пока запрос летел, кэш сбросили — данные уже неактуальны, в кэш не кладём.
      // Вызывающему отдаём как есть: экран хотя бы что-то покажет, а следующий
      // заход сходит на сервер заново.
      if(_apiGen===genAtStart){ _apiCache.set(url,{t:Date.now(),data:d}); swrWrite(url,d); }
      return d;
    })
    .finally(()=>{
      // Снимаем только СВОЮ запись: после сброса здесь уже может лежать
      // промис более нового запроса, и затирать его нельзя.
      if(_apiInflight.get(url)===p) _apiInflight.delete(url);
    });
  _apiInflight.set(url,p);
  return p;
}

/** Сбросить кэш по подстрокам пути. invalidateApi("/home","/planned") */
function invalidateApi(...parts){
  _apiGen++;
  swrDrop(parts);
  for(const key of Array.from(_apiCache.keys()))
    if(parts.some(p=>key.includes(p))) _apiCache.delete(key);
  for(const key of Array.from(_apiInflight.keys()))
    if(parts.some(p=>key.includes(p))) _apiInflight.delete(key);
}

// Какие записи устаревают после какого события. Один словарь вместо россыпи
// ручных сбросов по экранам — иначе про половину мест забудешь.
const API_EVENTS = {
  workout_finished: ["/home","/planned","/workouts","/progress","/achievements","/user/","/strength/","/programs/"],
  workout_started:  ["/home","/planned"],
  planned_changed:  ["/planned","/home"],
  food_logged:      ["/home","/nutrition"],
  sport_logged:     ["/home","/workouts","/progress"],
  // Только свои упражнения: /api/exercises — общий каталог, своих там нет,
  // и сбрасывать его означало лишь выбросить справочник на четырёх языках.
  exercises_changed:["/custom-exercises"],
  profile_changed:  ["/user/","/home","/strength/"],
  prefs_changed:    ["/home","/alternatives","/user/"],
  checkin_done:     ["/home","/progress","/user/","/strength/"],
};
function apiEvent(name){
  const parts=API_EVENTS[name];
  if(parts) invalidateApi(...parts);
}

// Какой изменяющий запрос какое событие означает. Проверяется сверху вниз,
// срабатывает первое совпадение.
const _MUTATION_EVENTS = [
  [/\/workout\/[^/]+\/(finish|close-active)/, "workout_finished"],
  // Запись подхода — десятки раз за тренировку, и главный экран в это время
  // всё равно не смотрят. Сбрасывать на каждый подход незачем.
  [/\/workout\/[^/]+\/(set|state|rest|last-set-rpe)/, null],
  [/\/workout\//,            "workout_started"],
  [/\/planned\//,            "planned_changed"],
  // Еда пишется через /nutrition/, а /food/ — только распознавание фото и
  // пересчёт, они ничего не сохраняют. Без этого правила «Съедено» на главном
  // не менялось до двух минут после записи обеда.
  [/\/nutrition\//,          "food_logged"],
  [/\/food\//,               "food_logged"],
  [/\/sport\//,              "sport_logged"],
  [/\/custom-exercises\//,   "exercises_changed"],
  [/\/training-prefs\//,     "prefs_changed"],
  [/\/checkin\//,            "checkin_done"],
  [/\/measurements\//,       "checkin_done"],
  [/\/consent\//,            "profile_changed"],
  [/\/user\//,               "profile_changed"],
];
function _invalidateByMutation(url){
  for(const [re,name] of _MUTATION_EVENTS){
    // name===null — правило-исключение: совпало, но сбрасывать нечего
    if(re.test(url)){ if(name) apiEvent(name); return; }
  }
}

// Показывать баннер "Продолжить тренировку" можно только если тренировка РЕАЛЬНО была начата
// (есть workoutId — вызов /api/workout/start на сервере уже произошёл). Простой факт наличия
// gymbot_active_workout в localStorage не годится: он появляется уже на этапе выбора упражнений,
// до нажатия "Начать" — иначе баннер показывается даже когда тренировка не начиналась вовсе.
function hasResumableActiveWorkout(){
  try{
    const raw=localStorage.getItem("gymbot_active_workout");
    if(!raw)return false;
    const data=JSON.parse(raw);
    return !!data?.workoutId;
  }catch{return false;}
}

const C = {
  bg:"#0F0F0F", surface:"#1A1A1A", card:"#222222",
  accent:"#C8FF00", text:"#FFFFFF", muted:"#888888",
  border:"#2A2A2A", danger:"#FF4444", success:"#00CC66", warn:"#FFB800",
};


// ── i18n ─────────────────────────────────────────────────────────────────────
// Язык дублируется в localStorage, хотя источник правды — users.lang на сервере.
// Причина: профиль приходит отдельным запросом, и до его ответа всё рисуется
// по-русски. Для узбекского пользователя это заметная вспышка чужого языка при
// каждом запуске. А ещё каталог упражнений запрашивается в том же useEffect,
// что и профиль, и теперь просит у сервера конкретный язык — не зная языка,
// он бы всегда просил русский. Сервер остаётся главным: когда профиль придёт,
// он перезапишет и локальное значение, и язык каталога.
const LANG_KEY = "gymbot_lang";
const LANG_ALLOWED = ["ru", "en", "uz", "kz"];

/** Любой код языка → один из четырёх наших, либо null. */
function normLang(code) {
  if (!code) return null;
  let c = String(code).trim().toLowerCase().split(/[-_]/)[0];
  if (c === "kk" || c === "kaz") c = "kz";   // в стандарте казахский — kk, у нас kz
  return LANG_ALLOWED.includes(c) ? c : null;
}

// Язык из настроек самого Телеграма. Нужен ровно для одного случая: первый
// запуск (или запрет на localStorage), когда своего сохранённого языка нет.
// Угадать по телефону точнее, чем всегда брать русский: иначе узбекский
// пользователь в приватном режиме качает каталог дважды при каждом запуске —
// сперва русский, потом настоящий.
function telegramLang() {
  return normLang(tg?.initDataUnsafe?.user?.language_code);
}
function readStoredLang() {
  let stored = null;
  try { stored = localStorage.getItem(LANG_KEY); }
  catch {}                      // приватный режим / запрет на хранилище
  return normLang(stored) || telegramLang() || "ru";
}
function storeLang(code) {
  const c = normLang(code);
  if (!c) return;
  try { localStorage.setItem(LANG_KEY, c); } catch {}
}
const LANG_STORE = { current: readStoredLang() };
const T = {
  ru: {
    menu_nutrition:"Питание", menu_workout:"Тренировки", menu_progress:"Прогресс",
    menu_catalog:"Каталог", menu_ai:"Тренер", menu_checkin:"Чек-ин",
    menu_measurements:"Замеры тела", menu_goals:"Цели", menu_supplements:"Добавки",
    menu_support:"Поддержка", menu_language:"Язык", menu_sport:"Виды спорта",
    menu_gamification:"Мой статус", menu_food_guide:"Каталог продуктов",
    menu_referral:"Пригласить друга", menu_photo_kbju:"Фото → КБЖУ",
    menu_rest_timer:"Таймер отдыха", menu_plan:"Запланировать", menu_reminders:"Напоминания",
    menu_tab_menu:"Меню", menu_tab_workout:"Тренировки", menu_tab_progress:"Прогресс",
    menu_tab_catalog:"Каталог", menu_tab_ai:"Тренер",
    section_quick:"БЫСТРЫЙ ДОСТУП", section_catalog:"КАТАЛОГ", section_profile:"ПРОФИЛЬ",
    start_workout:"▶ НАЧАТЬ ТРЕНИРОВКУ", back:"← НАЗАД",
    today:"СЕГОДНЯ", loading:"ЗАГРУЗКА", save:"СОХРАНИТЬ", cancel:"ОТМЕНА",
    add:"ДОБАВИТЬ", edit:"ИЗМЕНИТЬ", delete:"УДАЛИТЬ", close:"ЗАКРЫТЬ",
    save_profile:"СОХРАНИТЬ", cancel_btn:"ОТМЕНА", edit_profile:"ИЗМЕНИТЬ ПРОФИЛЬ",
    edit_profile_btn:"ИЗМЕНИТЬ →", profile_title:"МОЙ ПРОФИЛЬ",
    my_profile:"МОЙ ПРОФИЛЬ", not_specified:"Не указано", allergies:"АЛЛЕРГИИ",
    level:"УРОВЕНЬ", goal_label:"ЦЕЛЬ", no_conditions:"Нет противопоказаний",
    no_allergies:"Нет аллергий", reset_btn:"СБРОС", status_label:"СТАТУС",
    fitness_level_label:"УРОВЕНЬ ПОДГОТОВКИ", my_rating:"МОЙ РЕЙТИНГ",
    points_label:"БАЛЛЫ", rank_label:"РАНГ",
    plateau_title:"ПЛАТО ДЕТЕКТОР", plateau_weight:"Вес не меняется",
    plateau_exercise:"Застрявшие упражнения", plateau_none:"Плато не обнаружено",
    referral_title:"ПРИГЛАСИТЬ ДРУГА", referral_your_code:"Твой код",
    referral_link:"Реферальная ссылка", referral_friends:"Приглашено друзей",
    referral_bonus:"Баллов за приглашение",
    workout_title:"ТРЕНИРОВКИ", workouts_title:"ТРЕНИРОВКИ",
    no_workouts:"Тренировок пока нет", no_workouts_yet:"Тренировок пока нет",
    tonnage_label:"ТОННАЖ", no_sport_yet:"Занятий пока нет",
    planned_tab:"📅 ПЛАН", sport_tab:"⚽ СПОРТ", archive_tab:"📋 АРХИВ",
    no_planned:"Нет запланированных тренировок", planned_archive:"АРХИВ ЗАПЛАНИРОВАННЫХ",
    nutrition_title:"ДНЕВНИК", add_meal:"+ добавить",
    water_label:"💧 ВОДА", glasses_unit:"стаканов",
    ask_trainer:"Спросить тренера о питании",
    meal_breakfast:"Завтрак", meal_lunch:"Обед", meal_dinner:"Ужин", meal_snack:"Перекус",
    progress_title:"ПРОГРЕСС", catalog_title:"УПРАЖНЕНИЯ", ai_title:"ТРЕНЕР НА СВЯЗИ",
    food_search_title:"СПРАВОЧНИК", food_search_placeholder:"Поиск продукта...",
    add_to_diary:"ДОБАВИТЬ В ДНЕВНИК", weight_label:"ВЕС (г)",
    sport_record:"ЗАПИСАТЬ ЗАНЯТИЕ", sport_duration:"ПРОДОЛЖИТЕЛЬНОСТЬ (МИН)",
    sport_intensity:"ИНТЕНСИВНОСТЬ", sport_date:"ДАТА", sport_notes:"ЗАМЕТКИ",
    sport_type_label:"ВИД СПОРТА", sport_notes_opt:"ЗАМЕТКИ (ОПЦИОНАЛЬНО)",
    sport_saved:"ЗАПИСАНО", sport_save_btn:"✓ ЗАПИСАТЬ ЗАНЯТИЕ",
    score_opt:"СЧЁТ (ОПЦИОНАЛЬНО)", score_label:"СЧЁТ",
    intensity_low:"🟢 Низкая", intensity_medium:"🟡 Средняя", intensity_high:"🔴 Высокая",
    time_label:"ВРЕМЯ", intensity_label:"ИНТЕНСИВНОСТЬ", calories_label:"КАЛОРИИ",
    archive_label:"АРХИВ",
    choose_type:"ЧТО ДЕЛАЕМ?", choose_type_label:"ВЫБЕРИ ТИП",
    gym_title:"Тренажёрный зал", gym_desc:"Силовые упражнения, выбор мышц и упражнений",
    sport_section:"Виды спорта", sport_desc:"Запись занятия с расчётом калорий",
    sport_section_title:"Виды спорта", sport_section_desc:"Запись занятия с расчётом калорий",
    resume_workout:"ПРОДОЛЖИТЬ ТРЕНИРОВКУ", resume_desc:"У тебя есть незавершённая тренировка",
    workout_closed_elsewhere:"Прошлая тренировка уже завершена — на другом устройстве или автоматически. Можно начать новую.",
    finish_workout:"ЗАВЕРШИТЬ", workout_empty_note:"Ни одного подхода не записано — тренировка не засчитана и в историю не попала.", set_done:"✓ ПОДХОД ВЫПОЛНЕН", set_done_label:"ПОДХОД ВЫПОЛНЕН",
    premium_menu:"Premium", premium_kicker:"PREMIUM", premium_title:"GymBot Premium", premium_lead:"Больше вопросов тренеру и распознаваний еды — и поддержка развития GymBot.", premium_active_until:"Premium активен до {date}", premium_trial_until:"Пробный Premium до {date}", premium_manual:"Premium активен", premium_perk_ai:"{n} вопросов тренеру в день", premium_perk_food:"{n} фото еды в день", premium_perk_now:"без Premium — {n}", premium_perk_support:"Новые функции быстрее: вы поддерживаете развитие приложения", premium_month:"Месяц", premium_year:"Год", premium_month_note:"продлевается каждые 30 дней, выключить можно в любой момент", premium_year_note:"разовая оплата на 365 дней", premium_save:"выгода {n}%", premium_buy:"Оформить за {n} ⭐", premium_extend:"Продлить за {n} ⭐", premium_trial_btn:"Попробовать {n} дн. бесплатно", premium_renews:"Подписка продлится {date}", premium_renew_off:"Автопродление выключено — Premium до {date}", premium_cancel_btn:"Выключить автопродление", premium_resume_btn:"Включить автопродление", premium_paid_wait:"Оплата прошла — включаем Premium…", premium_paid_ok:"Premium включён до {date}. Спасибо!", premium_paid_late:"Оплата прошла. Premium включится в течение нескольких минут — бот пришлёт сообщение.", premium_failed:"Оплата не прошла. Попробуйте ещё раз.", premium_error:"Не получилось открыть оплату. Попробуйте позже.", premium_already_sub:"Подписка уже оформлена.", premium_note:"Оплата звёздами Telegram. Автопродление можно выключить здесь или в Telegram: Настройки → Мои звёзды. Вопросы по оплате — команда /paysupport в боте.", premium_nudge_ai:"С Premium — {n} вопросов тренеру в день", premium_nudge_food:"С Premium — {n} фото еды в день", premium_nudge_btn:"Подробнее", share_kicker:"ПОДЕЛИТЬСЯ", share_story:"В историю", share_chat:"В чат", share_preparing:"Готовлю карточку…", share_sent_bot:"Карточка в чате с ботом — перешлите её друзьям", share_error:"Не получилось подготовить карточку. Попробуйте ещё раз.",
    soc_menu:"Друзья и команды", soc_kicker:"СООБЩЕСТВО", soc_title:"Друзья и команды", tab_feed:"Лента", tab_friends:"Друзья", tab_teams:"Команды", soc_invite_title:"Позовите друзей", soc_invite_hint:"Друзья видят тренировки и рекорды друг друга и ставят 👏. Вес, питание и здоровье не показываются никогда.", soc_invite_btn:"Пригласить друга", soc_copy:"Скопировать ссылку", soc_copied:"Ссылка скопирована", soc_share_text:"Тренируемся вместе в GymBot 💪", soc_privacy:"Показывать мои тренировки друзьям", soc_friends_empty:"Пока нет друзей — отправьте приглашение.", soc_week_n:"{n} трен. на этой неделе", soc_remove:"Удалить", soc_remove_confirm:"Удалить {name} из друзей?", soc_feed_empty:"Здесь будут ваши тренировки и тренировки друзей.", soc_you:"Вы", soc_sets:"{n} подх.", soc_tonnage:"{n} т", soc_min:"{n} мин", soc_record:"Рекорд: {ex} — {w} кг (было {p})", soc_more:"Показать ещё", soc_accepted:"Вы теперь друзья с {name}", soc_already:"{name} уже у вас в друзьях", soc_bad_code:"Ссылка устарела или неверная", soc_own_code:"Это ваша собственная ссылка 🙂", soc_teams_empty:"Команд пока нет. Создайте свою или вступите по коду.", soc_team_create:"Создать команду", soc_team_name:"Название команды", soc_team_join:"Вступить по коду", soc_team_code:"Код команды", soc_team_members:"{n} участн.", soc_team_week:"За неделю: {n} трен.", soc_team_place:"Ваше место: {n}", soc_team_invite:"Позвать в команду", soc_team_leave:"Выйти из команды", soc_team_leave_confirm:"Выйти из команды «{name}»?", soc_team_rename:"Переименовать", soc_team_joined:"Вы в команде «{name}»", soc_team_full:"В команде уже 50 человек", soc_too_many_teams:"Можно состоять не больше чем в 5 командах", soc_board_title:"РЕЙТИНГ НЕДЕЛИ", soc_board_hint:"Считаются завершённые тренировки с понедельника", soc_last_week:"прошлая: {n}", soc_owner:"владелец", soc_share_team_text:"Вступай в нашу команду «{name}» в GymBot 💪", soc_remove_member:"Убрать", soc_remove_member_confirm:"Убрать {name} из команды?",
    wn_kicker:"ЧТО НОВОГО", wn_kicker_new:"ПОЛЕЗНО ЗНАТЬ", wn_menu:"Что нового", wn_skip:"Пропустить", wn_next:"Далее", wn_done:"Готово", wn_str_d:"Узнайте, насколько вы сильны: уровень в каждом упражнении — от «{a}» до «{b}».", wn_str_1:"Учитываются пол, вес тела и возраст", wn_str_2:"Сравнение с другими атлетами GymBot", wn_str_3:"Сколько добавить до следующего уровня", wn_str_b:"Мой уровень", wn_food_t:"Плов, лагман, самса", wn_food_d:"В дневнике питания — блюда местной кухни, и фото тарелки их узнаёт.", wn_food_1:"37 национальных блюд с калориями и БЖУ", wn_food_2:"Сканер этикеток: сфотографируйте упаковку — КБЖУ заполнится сам", wn_food_3:"Названия на русском, узбекском и казахском", wn_food_b:"Сканировать этикетку", wn_prog_d:"Готовые планы на 6–12 недель: что делать в каждый день, сколько подходов и повторов.", wn_prog_1:"Для зала и для дома, для новичков и опытных", wn_prog_2:"Приложение подскажет, какой день следующий", wn_prog_3:"3 программы — бесплатно", wn_prog_3_all:"Все программы — бесплатно", wn_prog_b:"Выбрать программу", wn_soc_d:"Тренироваться вместе веселее — и пропускать труднее.", wn_soc_1:"Лента тренировок и рекордов друзей, 👏 за старания", wn_soc_2:"Команды с рейтингом по тренировкам за неделю", wn_soc_3:"Вес, питание и здоровье друзья не видят", wn_soc_b:"Позвать друга", wn_prem_d:"Больше возможностей для тех, кто тренируется всерьёз.", wn_prem_1:"До {n} вопросов AI-тренеру в день", wn_prem_2:"До {n} фото еды в день", wn_prem_3:"Все программы тренировок; оплата звёздами Telegram", wn_prem_b:"Подробнее", wn_prem_trial:"Попробовать {n} дн. бесплатно",
    prog_menu:"Программы тренировок", prog_kicker:"ПРОГРАММЫ", prog_title:"Программы тренировок", prog_lead:"Готовые планы на несколько недель: что делать в каждый день, сколько подходов и повторов.", prog_meta:"{d} трен. в неделю · {w} нед.", prog_active:"ВАША ПРОГРАММА", prog_progress:"Тренировка {n} из {t}", prog_next:"Следующая: {day}", prog_start_day:"Начать: {day}", prog_start:"Начать программу", prog_replace_confirm:"Сейчас идёт «{cur}». Начать новую программу вместо неё?", prog_stop:"Остановить программу", prog_stop_confirm:"Остановить программу? Сделанные тренировки останутся в истории.", prog_unlock:"Открыть с Premium", prog_tip:"СОВЕТ", prog_days:"ДНИ ПРОГРАММЫ", prog_rest_s:"отдых {n} с", prog_rest_m:"отдых {n} мин", prog_reps_max:"макс.", prog_sec:"с", prog_finished:"Программа пройдена! Выберите следующую.", prog_free:"Бесплатно", prog_week:"неделя {n}", prog_not_in_catalog:"нет в каталоге", prog_is_active:"Программа идёт", prog_all:"Все программы", prog_open:"Открыть",
    fcat_national:"Местная кухня", label_scan_btn:"Сканировать этикетку", fv_mode_dish:"Блюдо", fv_mode_label:"Этикетка", label_kicker:"СКАНЕР ЭТИКЕТОК", label_title:"Фото этикетки", label_hint:"Сфотографируйте таблицу пищевой ценности на упаковке — заполним КБЖУ на 100 г, а продукт сохраним в справочник.", label_photo_btn:"Сфотографировать этикетку", label_read_btn:"Распознать", label_reading:"ЧИТАЮ ЭТИКЕТКУ…", label_not_found:"На фото не видно таблицы пищевой ценности. Сфотографируйте её ближе и ровнее.", label_failed:"Не получилось прочитать этикетку. Попробуйте ещё раз.", label_name:"Название", label_brand:"Бренд", label_per100:"На 100 г", label_low_conf:"Проверьте цифры: часть могла прочитаться неточно.", label_portion:"Сколько съели, г", label_pack_portion:"порция с упаковки", label_save_log:"Записать в дневник", label_save_only:"Только сохранить в справочник", label_saved_only:"Продукт сохранён — его можно найти в поиске.", label_total:"Итого на {w} г", food_portion_approx:"порция ~{n} г",
    str_e1rm:"расч. максимум", str_menu:"Силовые ранги", str_kicker:"СИЛА", str_title:"Силовые ранги", str_overall:"Общий ранг", str_stronger:"Сильнее ~{n}% тренирующихся", str_basis:"Оценка по силовым нормативам для вашего пола, веса тела и возраста. Максимум считается по лучшему подходу до 12 повторов (формула Эпли).", str_missing:"Чтобы посчитать ранги, укажите в профиле пол и вес.", str_btn_profile:"Заполнить профиль", str_to_next:"До уровня «{lvl}»: +{n} {u}", str_top:"Высший уровень — поздравляем!", str_community:"Среди пользователей GymBot: сильнее {n}% из {m}", str_untracked:"Ещё без ранга", str_untracked_hint:"Сделайте подход в любом из этих упражнений — ранг появится сам.", str_all:"Все ранги", str_from:"лучший подход {w} кг × {r}", str_from_reps:"лучший подход — {r} повт.", str_reps:"повт.", str_on:"по {n} упр.", str_empty:"Пока нет подходов в базовых упражнениях — ранги появятся после первой тренировки с ними.", str_lvl_start:"Старт", str_lvl_beginner:"Новичок", str_lvl_novice:"Начинающий", str_lvl_intermediate:"Средний", str_lvl_advanced:"Продвинутый", str_lvl_elite:"Элита",
    terms_menu:"Правила использования", terms_kicker:"ДОКУМЕНТ", terms_title:"Правила использования", terms_updated:"Редакция от 24 октября 2026 года", terms_read:"Читать правила", terms_premium_link:"Условия Premium, отмена и возврат", terms_close:"Закрыть", terms_s_general_t:"1. Общие положения", terms_s_general_b:"GymBot — дневник тренировок и питания с AI-тренером в Telegram. Пользоваться им можно с 18 лет.\n\nСоветы AI-тренера, оценка калорий по фото и рекомендации по нагрузке — справочные и не являются медицинским назначением. Решения о тренировках, питании и добавках вы принимаете сами, с учётом своего здоровья. При заболеваниях и противопоказаниях посоветуйтесь с врачом.\n\nНельзя использовать приложение для спама, оскорблений и чужих данных. За это мы можем ограничить доступ.", terms_s_data_t:"2. Данные", terms_s_data_b:"Какие данные собираются и кому передаются, описано в согласиях. Их можно посмотреть в профиле; согласия на сведения о здоровье и на передачу данных AI-сервису можно отозвать в любой момент.", terms_s_prem_t:"3. Premium", terms_p_what:"Premium — платная часть приложения: больше вопросов AI-тренеру и распознаваний еды по фото в день, а также другие возможности, перечисленные на экране Premium. Текущие лимиты указаны там же. Состав Premium может расширяться.", terms_p_pay:"Оплата — только звёздами Telegram (Telegram Stars) внутри Telegram. Сейчас месяц стоит {pm} ⭐, год — {py} ⭐. Если цена изменится, уже оплаченный период не пересчитывается.", terms_p_pay_np:"Оплата — только звёздами Telegram (Telegram Stars) внутри Telegram. Актуальные цены указаны на экране Premium. Если цена изменится, уже оплаченный период не пересчитывается.", terms_p_month:"Месяц — это подписка: каждые 30 дней Telegram автоматически списывает ту же сумму, пока вы её не отмените. Отменить можно в любой момент — на экране Premium кнопкой «Выключить автопродление» или в Telegram: Настройки → Мои звёзды. После отмены Premium работает до конца оплаченного периода, новых списаний не будет.", terms_p_year:"Год — разовая оплата на 365 дней, без автопродления. Если при этом у вас действует месячная подписка, мы выключаем её, чтобы звёзды не списывались дважды.", terms_p_trial:"Пробный период — {n} дн. бесплатно, один раз на аккаунт. Он не продлевается сам и ничего не списывает.", terms_p_refund:"Возврат. Если звёзды списались, а Premium не включился, или списание прошло по ошибке либо дважды — напишите в поддержку командой /paysupport в боте и укажите дату оплаты. При возврате звёзды возвращаются на ваш счёт в Telegram, а дни Premium за этот платёж снимаются полностью. Возврат за уже использованное время рассматривается индивидуально.", terms_p_account:"Premium привязан к вашему аккаунту Telegram и не передаётся другим людям.", terms_s_support_t:"4. Поддержка", terms_s_support_b:"Вопросы и жалобы — в разделе «Поддержка» приложения, вопросы по оплате — командой /paysupport в боте. Отвечаем в чате с ботом.\n\nПравила могут меняться. О существенных изменениях сообщим в боте.",
    warmup_title:"РАЗМИНКА", warmup_skip:"ПРОПУСТИТЬ", warmup_done:"✓ РАЗМИНКА ВЫПОЛНЕНА",
    warmup_hint:"Кардио для разминки — опционально", warmup_badge:"🏃 РАЗМИНКА",
    ready_wk_kicker:"ТРЕНИРОВКА СОБРАНА", ready_wk_hint:"Состав подобран по твоей истории", ready_wk_program:"Состав — из вашей программы", ready_wk_change:"Изменить состав",
    rest_notify_title:"Сигнал об отдыхе", rest_notify_hint:"Бот пришлёт сообщение, когда отдых закончится. Телефон можно убрать — часы завибрируют.", rest_notify_on:"Включено", rest_notify_off:"Выключено",
    rest_offer_kicker:"ПОДСКАЗКА", rest_offer_title:"Убрать телефон во время тренировки?", rest_offer_text:"Бот может сам сигналить об окончании отдыха. Тогда телефон не нужно держать в руке — часы или браслет завибрируют.", rest_offer_yes:"Включить", rest_offer_no:"Не нужно",
    order_title:"ПОРЯДОК", order_hint:"↑↓ — перестановка · ↔ — замена",
    muscles_title:"ГРУППЫ МЫШЦ", exercises_title:"УПРАЖНЕНИЯ", replace_title:"ЗАМЕНА", show_all_exercises:"ПОКАЗАТЬ ВСЕ УПРАЖНЕНИЯ",
    select_groups_hint:"Выбери одну или несколько групп → покажем упражнения",
    step_1_4:"ШАГ 1 / 4", step_2_4:"ШАГ 2 / 4", step_3_4:"ШАГ 3 / 4", step_4_4:"ШАГ 4 / 4",
    weight_kg:"ВЕС (КГ)", reps_label:"ПОВТОРЕНИЙ", time_sec:"ВРЕМЯ (СЕК)",
    distance_km:"ДИСТАНЦИЯ (КМ)", prev_btn:"← ПРЕД", next_btn:"СЛЕД →",
    workout_done:"ТРЕНИРОВКА ЗАВЕРШЕНА", workout_complete:"ТРЕНИРОВКА ЗАВЕРШЕНА",
    great_work:"Отличная работа!", analyzing:"АНАЛИЗИРУЕТ ТРЕНИРОВКУ...",
    workout_sets:"СОСТАВ ТРЕНИРОВКИ", no_sets:"Нет записей о подходах", reps_short:"ПОВТ",
    error_label:"ОШИБКА", load_error:"НЕ УДАЛОСЬ ЗАГРУЗИТЬ",
    water_hint:"← нажми чтобы отметить стакан воды",
    ai_thinking:"АНАЛИЗИРУЮ...", ai_ask:"СПРОСИТЬ ТРЕНЕРА", ai_limit:"⚠️ Лимит AI запросов исчерпан",
    goal_health:"Здоровье",
    goal_lose:"Похудение",
    goal_muscle:"Набор массы",
    goal_strength:"Сила",
    goal_endurance:"Выносливость",
    level_beginner:"Начинающий",
    level_intermediate:"Средний",
    level_advanced:"Продвинутый",
    difficulty_easy:"Лёгкое",
    difficulty_medium:"Среднее",
    difficulty_hard:"Сложное",
    gender_male:"Мужской",
    gender_female:"Женский",
    next_btn2:"ДАЛЕЕ →",
    back_to_menu:"← В МЕНЮ",
    search_placeholder:"ПОИСК...",
    enter_name:"Твоё имя",
    enter_goal:"КАКАЯ ТВОЯ ЦЕЛЬ?",
    hello_name:"ПРИВЕТ! КАК ТЕБЯ ЗОВУТ?",
    name_hint:"Имя будет отображаться в приложении",
    sets_label:"ПОДХОДОВ",
    reps_label2:"ПОВТОРЕНИЙ",
    exercises_label:"УПРАЖНЕНИЙ",
    minutes_label:"МИНУТ",
    tonnage_label2:"ТОННАЖ",
    volume_label:"ОБЪЁМ",
    weight_label2:"ВЕС",
    date_label:"ДАТА",
    time_label2:"ВРЕМЯ",
    difficulty_label:"СЛОЖНОСТЬ",
    equipment_label:"ОБОРУДОВАНИЕ",
    description_label:"ОПИСАНИЕ",
    technique_label:"ТЕХНИКА ВЫПОЛНЕНИЯ", tech_offline:"Техника загрузится, когда появится связь.",
    more_info:"ПОДРОБНЕЕ →",
    open_plan:"ОТКРЫТЬ СОСТАВ →",
    continue_workout2:"ПРОДОЛЖИТЬ ТРЕНИРОВКУ",
    unfinished:"Незавершённая тренировка ждёт",
    skip_warmup:"ПРОПУСТИТЬ РАЗМИНКУ",
    warmup_time:"РЕКОМЕНДУЕМОЕ ВРЕМЯ РАЗМИНКИ",
    replace_exercise:"↔ ЗАМЕНА УПРАЖНЕНИЯ",
    do_replace:"↔ ЗАМЕНИТЬ",
    add_exercise:"+ ДОБАВИТЬ УПРАЖНЕНИЕ",
    add_during:"ДОБАВИТЬ УПРАЖНЕНИЕ",
    my_exercise:"СВОЁ УПРАЖНЕНИЕ",
    all_exercises:"ВСЕ УПРАЖНЕНИЯ →",
    show_exercises:"ПОКАЗАТЬ ВСЕ УПРАЖНЕНИЯ →",
    order_hint2:"↑↓ — перестановка · ↔ — замена",
    steps_1_4:"ШАГ 1 / 4",
    steps_2_4:"ШАГ 2 / 4",
    steps_3_4:"ШАГ 3 / 4",
    steps_4_4:"ШАГ 4 / 4",
    steps_1_2:"ШАГ 1 / 2",
    steps_2_2:"ШАГ 2 / 2",
    plan_step1:"ПЛАНИРОВАНИЕ · ШАГ 1",
    plan_step2:"ПЛАНИРОВАНИЕ · ШАГ 2",
    plan_step3:"ПЛАНИРОВАНИЕ · ШАГ 3",
    calories_label2:"КАЛОРИИ",
    proteins_label:"БЕЛКИ",
    fats_label:"ЖИРЫ",
    carbs_label:"УГЛЕВОДЫ",
    kcal_unit:"ккал",
    kcal_per100:"ккал/100г",
    protein_g:"Белки г",
    fat_g:"Жиры г",
    carb_g:"Углев г",
    weight_g:"Вес (кг)",
    portions_label:"ПРИЁМ ПИЩИ",
    add_meal2:"ДОБАВИТЬ В ДНЕВНИК",
    add_product:"ДОБАВИТЬ ПРОДУКТ",
    new_product:"НОВЫЙ ПРОДУКТ (КБЖУ на 100г)",
    product_catalog:"КАТАЛОГ ПРОДУКТОВ",
    food_catalog_title:"СПРАВОЧНИК ПРОДУКТОВ",
    food_catalog_kbju:"КБЖУ НА 100Г",
    search_product:"Поиск продукта...",
    product_name:"Название продукта *",
    dish_name:"Название блюда",
    add_custom_product:"+ ДОБАВИТЬ СВОЙ ПРОДУКТ",
    product_exists:"Продукт с таким названием уже существует",
    calories_short:"Ккал",
    calories_req:"Ккал *",
    carbs_short:"Углев",
    photo_kbju_title:"ФОТО → КБЖУ",
    photo_kbju_hint:"Сфотографируй еду — AI определит калории и БЖУ",
    analyzing_photo:"AI АНАЛИЗИРУЕТ ФОТО...",
    analyze_btn:"🔍 АНАЛИЗИРОВАТЬ",
    new_photo:"НОВОЕ ФОТО",
    add_to_diary2:"💾 В ДНЕВНИК",
    add_photo:"ДОБАВИТЬ ФОТО",
    ai_nutrition_title:"AI ПИТАНИЕ",
    saved_to_diary:"✓ СОХРАНЕНО В ДНЕВНИК ПИТАНИЯ",
    measurements_title2:"ЗАМЕРЫ ТЕЛА",
    measurements_cat:"АНТРОПОМЕТРИЯ",
    save_measurements:"СОХРАНИТЬ ЗАМЕРЫ",
    measurements_saved:"✓ ЗАМЕРЫ СОХРАНЕНЫ",
    measurements_history:"ИСТОРИЯ",
    measurements_add:"ДОБАВИТЬ",
    measurements_none:"Замеров пока нет",
    waist:"Талия",
    hips:"Бёдра",
    chest:"Грудь",
    arm:"Рука (бицепс)",
    thigh:"Бедро",
    checkin_title2:"ЧЕК-ИН",
    checkin_weekly:"ЕЖЕНЕДЕЛЬНЫЙ",
    checkin_saved:"ЧЕК-ИН СОХРАНЁН",
    send_checkin:"ОТПРАВИТЬ ЧЕК-ИН",
    checkin_ai_hint:"AI тренер получил обновлённые данные",
    sleep_hours:"СОН (ЧАСОВ)",
    energy_label:"Энергия",
    stress_label:"Стресс",
    motivation_label:"Мотивация",
    profile_fill:"Заполните профиль",
    profile_fill_hint:"Для персонализации тренировок заполните профиль",
    profile_edit:"✏ РЕДАКТИРОВАТЬ ПРОФИЛЬ",
    edit_date:"✏ ИЗМЕНИТЬ ДАТУ/СОСТАВ",
    age_label:"Возраст",
    age_years:"Возраст (лет)",
    height_label:"Рост",
    height_cm:"Рост (см)",
    bmi_label:"ИМТ",
    gender_label:"ПОЛ",
    ai_style_label:"СТИЛЬ ОБЩЕНИЯ AI",
    status_saved:"✓ СОХРАНЕНО",
    profile_saved2:"✓ ЗАМЕРЫ СОХРАНЕНЫ",
    ai_bro_desc:"Молодёжный, сленг, мотивация",
    ai_mentor_desc:"Умеренный, поддержка, советы",
    ai_expert_desc:"Профессиональный, термины",
    ai_bro_name:"Фитнес-бро",
    med_label:"МЕД. ПОКАЗАТЕЛИ / ПРОТИВОПОКАЗАНИЯ",
    no_med:"Нет противопоказаний",
    supps_label:"💊 МОИ ДОБАВКИ",
    quick_select:"БЫСТРЫЙ ВЫБОР",
    manual_input:"ИЛИ ВВЕДИ ВРУЧНУЮ",
    supp_name:"Название добавки...",
    supp_dose:"Дозировка (напр. 5г)",
    supp_timing:"Время (утром, до трен.)",
    not_specified2:"Не указаны",
    gamification_title2:"МОЙ СТАТУС",
    my_rating2:"МОЙ РЕЙТИНГ",
    status_label2:"СТАТУС",
    points_label2:"БАЛЛЫ",
    rank_label2:"УРОВЕНЬ",
    leaderboard_title:"ТАБЛИЦА ЛИДЕРОВ",
    my_position:"МОЯ ПОЗИЦИЯ",
    how_earn:"КАК ЗАРАБАТЫВАТЬ БАЛЛЫ",
    recent_points:"ПОСЛЕДНИЕ НАЧИСЛЕНИЯ",
    next_rank:"ДО СЛЕДУЮЩЕГО РАНГА",
    streak_series:"🔥 СЕРИЯ АКТИВНОСТИ",
    achievements_title2:"ДОСТИЖЕНИЯ",
    new_achievement:"🎉 НОВОЕ ДОСТИЖЕНИЕ",
    progress_label:"ПРОГРЕСС",
    unlocked_label:"ОТКРЫТО",
    referral_title2:"БОНУСНАЯ ПРОГРАММА",
    how_works:"КАК ЭТО РАБОТАЕТ",
    goals_title2:"МОИ ЦЕЛИ",
    goals_add:"+ ДОБАВИТЬ ЦЕЛЬ",
    new_goal:"НОВАЯ ЦЕЛЬ",
    goal_desc:"Описание цели...",
    goal_achieved:"ДОСТИГНУТО",
    no_goals:"Активных целей нет. Поставь первую!",
    goal_target:"Цель",
    goal_unit:"ед.",
    reminders_title2:"НАПОМИНАНИЯ",
    reminders_cat:"УВЕДОМЛЕНИЯ",
    upcoming_workouts:"БЛИЖАЙШИЕ ТРЕНИРОВКИ",
    no_reminders:"Нет предстоящих тренировок",
    bot_reminds:"🔔 Бот напоминает за",
    one_hour:"1 час",
    before_workout:"до тренировки",
    plateau_check:"Плато-детектор проверяет каждое воскресенье в 10:30.",
    add_plan:"+ ЗАПЛАНИРОВАТЬ",
    add_plan2:"+ ЗАПЛАНИРОВАТЬ ТРЕНИРОВКУ",
    support_title2:"ПОДДЕРЖКА",
    support_cat:"ОБРАТНАЯ СВЯЗЬ",
    support_placeholder:"Опишите ваше обращение, мы ответим в ближайшее время",
    support_problem:"ОПИШИ ПРОБЛЕМУ ИЛИ ВОПРОС",
    sending:"ОТПРАВЛЯЕМ...",
    sent:"ОТПРАВЛЕНО",
    send_btn:"ОТПРАВИТЬ",
    error_send:"Ошибка отправки. Попробуй позже.",
    error_conn:"Нет соединения. Проверь интернет.",
    error_conn2:"Нет соединения. Попробуй позже.",
    language_title2:"ЯЗЫК",
    settings_title:"НАСТРОЙКИ",
    current_lang:"✓ ТЕКУЩИЙ",
    sport_title2:"ВИДЫ СПОРТА",
    sport_cat:"СПОРТ",
    record_btn:"ЗАПИСАНО",
    sport_full_record:"Полная запись в разделе Тренировки → ⚽ Спорт",
    score_optional:"Счёт, партнёры, ощущения...",
    score_example:"Например: 3:2 или 21:18",
    sport_planned:"📤 ПОДЕЛИТЬСЯ",
    no_activities:"Нет занятий",
    ai_training:"AI ТРЕНЕР",
    greeting_back:"О,",
    greeting_back2:"ТЫ ВЕРНУЛСЯ",
    greet_away:["О, ТЫ ВЕРНУЛСЯ","ДАВНО НЕ ВИДЕЛИСЬ","С ВОЗВРАЩЕНИЕМ","НУ ЧТО, НАЧНЁМ ЗАНОВО"],
    greet_streak:["ТЫ В ОГНЕ","СЕРИЯ ДЕРЖИТСЯ","НЕ СБАВЛЯЕШЬ","ВОТ ЭТО ДИСЦИПЛИНА"],
    greet_today:["СЕГОДНЯ УЖЕ СДЕЛАНО","ОТЛИЧНАЯ РАБОТА","ДЕЛО СДЕЛАНО","МОЛОДЕЦ"],
    greet_normal:["ПРИВЕТ","РАД ТЕБЯ ВИДЕТЬ","НУ ЧТО, ПОЕХАЛИ","ГОТОВ К РАБОТЕ"],
    home_load_error:"Не удалось загрузить. Проверь связь.", retry:"ПОВТОРИТЬ",
    home_k_profile:"Нужен профиль", home_k_resume:"Не завершено", home_k_planned:"Запланировано на сегодня", home_k_suggest:"Тренер предлагает",
    home_days_streak:"дн. подряд", home_of:"из", home_this_week:"на этой неделе", home_sport:"спорт",
    home_min:"мин", home_exercises:"упражнений", home_other_option:"Другой вариант",
    home_food:"Еда", home_burned:"Потрачено", home_weight:"Вес", home_kg:"кг",
    home_photo_food:"Фото еды", home_ask_coach:"Спросить тренера", home_services:"Сервисы",
    prog_this_week:"ТЕКУЩАЯ НЕДЕЛЯ", week_gym:"зал", week_sport:"спорт", prefill_from:"из тренировки",
    consent_intro:"Приложение собирает сведения о тренировках, питании и здоровье, включая противопоказания и аллергии, и передаёт их AI-тренеру для подбора нагрузок. Доступно с 18 лет.",
    consent_checkbox:"Согласен на обработку персональных данных, включая сведения о здоровье",
    consent_record:"СОГЛАСИЕ НА ОБРАБОТКУ ДАННЫХ", consent_ver:"редакция", age_too_young:"Приложение доступно с 18 лет.",
    consent_give:"дать",
    ai_consent_btn:"ПЕРЕЙТИ В ПРОФИЛЬ",
    ai_consent_needed:"Тренер недоступен: отозвано согласие на передачу данных AI-сервису. Восстановить его можно в профиле, в разделе согласий.",
    consent_i_terms:"Мне 18 лет, принимаю правила использования", consent_i_terms_h:"Решения о нагрузке, питании и добавках принимаю сам, с учётом своего здоровья. Ответ AI — не медицинское назначение.",
    consent_i_basic:"Обработка данных аккаунта и тренировок", consent_i_basic_h:"Профиль, дневники, цели и статистика. Хранятся на серверах за рубежом.",
    consent_i_health:"Обработка сведений о здоровье", consent_i_health_h:"Противопоказания, аллергии, лекарства, заболевания. Без этого ограничения не будут учитываться.",
    consent_i_ai:"Передача данных AI-сервису в США", consent_i_ai_h:"Профиль, история и медицинские ограничения передаются Anthropic при каждом обращении к тренеру. Без этого AI-тренер и распознавание еды недоступны.",
    consent_required_note:"* обязательны для работы приложения. Остальные можно отозвать в профиле в любой момент.",
    consent_no_ai_note:"Без согласия на передачу данных AI-тренер и распознавание еды по фото работать не будут.",
    consent_not_given:"не дано", consent_withdraw:"отозвать", consent_req_note:"обязательно",
    consent_wd_ai_confirm:"Отозвать согласие на передачу данных? AI-тренер и распознавание еды перестанут работать.",
    consent_wd_health_confirm:"Отозвать согласие на обработку здоровья? Противопоказания, аллергии и лекарства будут удалены из профиля.",
    mydata_title:"МОИ ДАННЫЕ", mydata_export:"Выгрузить мои данные", mydata_delete:"Удалить аккаунт и все данные",
    consent_gate_kicker:"ПРЕЖДЕ ЧЕМ ПРОДОЛЖИТЬ", consent_gate_title:"СОГЛАСИЕ НА ОБРАБОТКУ ДАННЫХ", consent_gate_btn:"ПРИНИМАЮ",
    mydata_export_err:"Не удалось выгрузить данные.", mydata_del_err:"Не удалось удалить аккаунт.",
    mydata_del_confirm1:"Удалить аккаунт? Будут стёрты все тренировки, замеры, питание и история. Это необратимо.",
    mydata_del_confirm2:"Для подтверждения введите DELETE", mydata_del_done:"Аккаунт и все данные удалены.",
    rpe_question:"КАК ДАЛСЯ ПОДХОД?", rpe_easy:"Легко", rpe_ok:"Норм", rpe_hard:"Тяжело", rpe_max:"Предел",
    home_close_workout:"Закрыть тренировку", home_close_confirm:"Закрыть незавершённую тренировку? Записанные подходы сохранятся.", home_checkin_due:"пора на чек-ин",
    more_profile:"ПРОФИЛЬ", more_training:"ТРЕНИРОВКИ", more_health:"ЗДОРОВЬЕ", more_catalog:"КАТАЛОГ",
    more_edit_profile:"Анкета и параметры", more_training_prefs:"Частота и сплит",
    more_achievements:"Достижения", more_leaderboard:"Лидерборд",
    alt_kicker:"ЗАМЕНА", alt_title:"ДРУГОЙ ВАРИАНТ", alt_repeat_last:"Повторить прошлую",
    alt_build_own:"Собрать самому", alt_available:"ДОСТУПНО", alt_recent:"НЕДАВНО ТРЕНИРОВАЛОСЬ",
    alt_never:"ещё не тренировалось", alt_rest:"отдых", alt_days:"дн.",
    alt_confirm_repeat:"Точно повторить?", alt_split:"Сплит", alt_change:"изменить", alt_no_last:"Нет завершённых тренировок для повтора.",
    prefs_kicker:"ТРЕНИРОВОЧНЫЙ ПРОЦЕСС", prefs_title:"ЧАСТОТА И СПЛИТ",
    prefs_freq:"СИЛОВЫХ В НЕДЕЛЮ", prefs_freq_hint:"Спорт в квоту не входит — он учитывается отдельно.",
    prefs_split:"СИСТЕМА СПЛИТА", prefs_split_hint:"Произвольный — тренер сам выбирает группы по отдыху.",
    prefs_days_in_cycle:"дн. в цикле", prefs_saving:"Сохраняю...", prefs_saved:"Сохранено",
    streak_day1:"ДЕНЬ",
    streak_day24:"ДНЯ",
    streak_days5:"ДНЕЙ",
    streak_podryad:"ПОДРЯД",
    ai_today:"AI сегодня",
    checkin_card_hint:"Заполняй раз в неделю — в воскресенье вечером или понедельник утром.",
    checkin_card_hint2:"учитывает твой чек-ин при составлении планов, ответах и советах.",
    level_below:"Ниже нач.",
    level_elite:"Элита",
    norm_beg:"Нач",
    norm_mid:"Ср",
    norm_adv:"Прод",
    norm_elite:"Элита",
    age_suffix:"л",
    coef_label:"коэф.",
    sleep_label2:"Сон",
    supp_timing_anytime:"В любое время, ежедневно",
    supp_timing_food:"Во время еды",
    supp_timing_food_sleep:"Во время еды или перед сном",
    supp_timing_before:"За 30–45 мин до тренировки",
    supp_timing_morning:"Утром с жирной едой",
    supp_timing_sleep:"Перед сном",
    supp_timing_collagen:"За 1 час до тренировки с витамином C",
    supp_protein:"Протеин",
    supp_creatine:"Креатин моногидрат",
    supp_omega:"Омега-3",
    supp_vitd:"Витамин D3",
    supp_magnesium:"Магний",
    supp_bcaa:"BCAA",
    supp_zinc:"Цинк",
    supp_vitc:"Витамин C",
    supp_multi:"Мультивитамины",
    supp_glutamine:"Глютамин",
    supp_collagen:"Коллаген",
    supp_melatonin:"Мелатонин",
    supp_caffeine:"Кофеин",
    supp_beta:"Бета-аланин",
    supp_preworkout:"Предтреник",
    add30s:"+30 сек",
    minus15s:"−15 сек",
    rest_5_10:"5–10 мин",
    sets_short2:"подх",
    reps_short2:"ПОВТ",
    pts_short:"балл.",
    pts_label:"баллов",
    kcal_short:"ккал",
    kcal_100g:"ккал/100г",
    volume_short:"объём (кг×повт)",
    workouts_week:"тренировок в неделю",
    one_session2:"1 тр-ка",
    max_w:"MAX ВЕС",
    dist_short:"ДИСТ. (КМ)",
    field_waist:"Талия",
    field_hips:"Бёдра",
    field_chest:"Грудь",
    field_arm:"Рука (бицепс)",
    field_thigh:"Бедро",
    field_age:"Возраст",
    field_age_y:"Возраст (лет)",
    field_weight_kg:"Вес (кг)",field_weight_g:"ВЕС (г)",
    field_height_cm:"Рост (см)",
    step_1_2:"ШАГ 1 / 2",
    step_2_2:"ШАГ 2 / 2",
    step_1_4b:"ШАГ 1 / 4",
    step_2_4b:"ШАГ 2 / 4",
    step_3_4b:"ШАГ 3 / 4",
    step_4_4b:"ШАГ 4 / 4",
    plan_s1:"ПЛАНИРОВАНИЕ · ШАГ 1",
    plan_s2:"ПЛАНИРОВАНИЕ · ШАГ 2",
    plan_s3:"ПЛАНИРОВАНИЕ · ШАГ 3",
    sel_group_hint:"Выбери одну или несколько групп",
    next_datetime:"ДАЛЕЕ → ДАТА И ВРЕМЯ",
    choose_replacement:"ВЫБЕРИ ЗАМЕНУ",
    warmup_exec_hint:"Выполни разминку перед основной тренировкой",
    edit_btn:"ИЗМЕНИТЬ",
    edit_arrow:"ИЗМЕНИТЬ →",
    profile_section:"ПРОФИЛЬ",
    language_section:"ЯЗЫК",
    score_section:"СЧЁТ",
    notes_section:"ЗАМЕТКИ",
    cancel_btn2:"ОТМЕНА",
    delete_btn:"УДАЛИТЬ",
    error_label2:"ОШИБКА",
    failed_load2:"НЕ УДАЛОСЬ ЗАГРУЗИТЬ",
    points_short:"ПОДХОДОВ",
    order_section:"ПОРЯДОК",
    meal_section:"ПРИЁМ ПИЩИ",
    allergy_section:"АЛЛЕРГИИ",
    archive_section:"АРХИВ",
    goal_section:"ЦЕЛЬ",
    status_section:"СТАТУС",
    level_section:"УРОВЕНЬ",
    calories_section:"КАЛОРИИ",
    exercises_section:"УПРАЖНЕНИЯ",
    volume_section:"ОБЪЁМ",
    tonnage_section:"ТОННАЖ",
    time_min_section:"ВРЕМЯ (МИН)",
    name_section:"НАЗВАНИЕ",
    name_opt_section:"НАЗВАНИЕ (ОПЦИОНАЛЬНО)",
    food_catalog_section:"КАТАЛОГ ПРОДУКТОВ",
    food_ref_section:"СПРАВОЧНИК ПРОДУКТОВ",
    new_product_section:"НОВЫЙ ПРОДУКТ (КБЖУ на 100г)",
    add_product_btn:"ДОБАВИТЬ ПРОДУКТ",
    add_photo_btn:"ДОБАВИТЬ ФОТО",
    add_exercise_btn:"ДОБАВИТЬ УПРАЖНЕНИЕ",
    my_exercise_section:"СВОЁ УПРАЖНЕНИЕ",
    when_take_section:"КОГДА ПРИНИМАТЬ",
    photo_kbju_title2:"ФОТО → КБЖУ",
    ai_trainer_title:"AI ТРЕНЕР",
    ai_trainer_online:"ТРЕНЕР НА СВЯЗИ",
    analyzing_photo2:"AI АНАЛИЗИРУЕТ ФОТО...",
    workout_still_active:"⚠️ ТРЕНИРОВКА ЕЩЁ ВЫПОЛНЯЕТСЯ",
    record_sport:"⚽ ЗАПИСАТЬ ЗАНЯТИЕ",
    edit_date_plan:"✏ ИЗМЕНИТЬ ДАТУ/СОСТАВ",
    edit_profile_btn2:"✏ РЕДАКТИРОВАТЬ ПРОФИЛЬ",
    added_done:"✓ ДОБАВЛЕНО",
    warmup_done2:"✓ РАЗМИНКА ВЫПОЛНЕНА",
    save_confirm:"✓ СОХРАНИТЬ",
    workout_saved_tab:"✓ ТРЕНИРОВКА СОХРАНЕНА → вкладка Запланированные",
    calories_food:"🍽 КАЛОРИИ (ЕДА)",
    warmup_badge3:"🏃 РАЗМИНКА",
    when_workout2:"📅 КОГДА ТРЕНИРОВКА?",
    share_btn2:"📤 ПОДЕЛИТЬСЯ",
    other_photo2:"📷 Другое",
    analyze_btn2:"🔍 АНАЛИЗИРОВАТЬ",
    bot_reminds2:"🔔 Бот напоминает за",
    burned_sport:"🔥 ПОТРАЧЕНО (СПОРТ)",
    water_tap_hint:"← нажми чтобы отметить стакан воды",
    replace_exercise2:"↔ ЗАМЕНА УПРАЖНЕНИЯ",
    do_replace2:"↔ ЗАМЕНИТЬ",
    plateau_schedule:"Плато-детектор проверяет каждое воскресенье в 10:30.",
    bot_1h:"Бот напомнит за 1 час",
    bot_1h_full:"Бот напомнит за 1 час до тренировки",
    continue_workout3:"ПРОДОЛЖИТЬ ТРЕНИРОВКУ",
    skip_warmup2:"ПРОПУСТИТЬ РАЗМИНКУ",
    warmup_rec_time:"РЕКОМЕНДУЕМОЕ ВРЕМЯ РАЗМИНКИ",
    no_allergies2:"Нет аллергий",
    no_conditions2:"Нет противопоказаний",
    not_specified3:"Не указано",
    measurements_hint:"Замеры хранятся в истории — можно отслеживать динамику",
    ai_trainer_hint:"AI-тренер подстроит советы под неё",
    goal_hint:"КАКАЯ ТВОЯ ЦЕЛЬ?",
    name_hint2:"ПРИВЕТ! КАК ТЕБЯ ЗОВУТ?",
    requests_left:"ЗАПРОСОВ ОСТАЛОСЬ ·",
    or_write:"или напиши",
    pts_per:"до тренировки.",
    pts_bonus:"+8 баллов",
    no_data_short:"нет данных",
    day_30:"30 дней",
    day_60:"60 дней",
    day_90:"90 дней",
    day_180:"180 дней",
    hour_1:"1 час",
    ai_chat_title:"ДИАЛОГ С ТРЕНЕРОМ",
    ai_clear:"🗑 ОЧИСТИТЬ",
    ai_coach_label:"🤖 ТРЕНЕР",
    ai_thinking2:"ТРЕНЕР ДУМАЕТ...",
    ai_analyzing:"АНАЛИЗИРУЕТ ТРЕНИРОВКУ...",
    ai_review_title:"ОЦЕНКА AI ТРЕНЕРА",
    ai_coach_advice:"💬 СОВЕТ ТРЕНЕРА",
    ai_proposes:"💪 AI ПРЕДЛАГАЕТ ТРЕНИРОВКУ",
    ai_save_plan:"📅 СОХРАНИТЬ В РАСПИСАНИЕ",
    ai_date_hint:"Выбери дату и время перед сохранением",
    ai_saved:"✓ ТРЕНИРОВКА СОХРАНЕНА → вкладка Запланированные",
    open_schedule:"ОТКРЫТЬ РАСПИСАНИЕ →",
    continue_dialog:"+ ПРОДОЛЖИТЬ",
    quick_questions:"БЫСТРЫЕ ВОПРОСЫ",
    voice_hint:"🎙 ГОЛОС · ИЛИ НАПИШИ",
    voice_full_hint:"🎙 НАЖМИ ДЛЯ ЗАПИСИ ГОЛОСА · ИЛИ НАПИШИ",
    recognizing:"РАСПОЗНАЮ...",
    no_mic:"Нет доступа к микрофону",
    no_audio:"Нет данных аудио",
    speech_not_recognized:"Речь не распознана",
    transcription_error:"Ошибка транскрипции",
    progress_title2:"МОЙ ПРОГРЕСС",
    weekly_activity:"АКТИВНОСТЬ ПО НЕДЕЛЯМ",
    workouts_per_week:"тренировок в неделю",
    muscle_progress:"ПРОГРЕСС ПО ГРУППАМ МЫШЦ",
    strength_norms:"ТВОИ СИЛОВЫЕ VS НОРМЫ",
    no_data_period:"Нет данных за выбранный период",
    need_2_workouts:"Нужно ≥2 тренировок для графика",
    max_weight:"MAX ВЕС",
    volume_unit:"объём (кг×повт)",
    sessions_count:"тр-к",
    one_session:"тр-ка",
    weight_dynamics:"ДИНАМИКА ВЕСА",
    timer_title:"ТАЙМЕР ОТДЫХА",
    tools_title:"ИНСТРУМЕНТЫ",
    rest_done:"✓ ОТДЫХ ЗАВЕРШЁН",
    rest_label:"ОТДЫХ",
    choose_time:"ВЫБЕРИ ВРЕМЯ",
    pause_btn:"⏸ ПАУЗА",
    start_btn2:"▶ СТАРТ",
    add30:"+ 30 сек",
    minus15:"− 15 сек",
    reset_btn2:"СБРОС",
    supps_title2:"ДОБАВКИ",
    supps_cat:"СПОРТИВНЫЕ ДОБАВКИ",
    supps_ref:"СПРАВОЧНИК",
    supp_dose_label:"ДОЗА",
    supp_when:"КОГДА ПРИНИМАТЬ",
    supp_sources:"ИСТОЧНИКИ",
    supp_desc:"ОПИСАНИЕ И СОВЕТЫ",
    supp_warning:"⚠️ Применение витаминов и добавок носит рекомендательный характер.",
    food_guide_cat:"СПРАВОЧНИК",
    food_guide_title2:"КАТАЛОГ ПРОДУКТОВ",
    food_when:"⏰ КОГДА ЕСТЬ",
    food_tips:"💡 СОВЕТЫ",
    food_best:"🏆 ЛУЧШИЕ ПРОДУКТЫ",
    food_combines:"✅ СОЧЕТАЕТСЯ С",
    food_avoid:"❌ НЕ СОЧЕТАТЬ",
    error_server:"Ошибка сервера",
    error_save:"Ошибка сохранения",
    error_net:"Ошибка сети",
    error_request:"Ошибка запроса",
    error_launch:"Ошибка запуска",
    error_load:"Ошибка загрузки",
    error_try_again:"Ошибка. Попробуй ещё раз.",
    open_telegram:"Открой приложение через Telegram.",
    failed_load:"Не удалось загрузить",
    failed_recognize:"Не удалось распознать. Попробуй другое фото.",
    food_limit_reached:"На сегодня распознавания по фото закончились ({limit} в день). Завтра снова можно, а пока блюдо можно внести вручную.",
    food_quota_left:"Распознаваний на сегодня: {left} из {limit}",
    limit_exceeded:"Дневной лимит запросов исчерпан. Попробуй завтра.",ai_unavailable:"AI-тренер временно недоступен. Попробуй чуть позже — лимит запросов не списан.",last_time:"Прошлый раз",day_today_l:"сегодня",day_yesterday:"вчера",days_ago_n:"{n} дн. назад",set_save_failed:"Подход не сохранился — проверь связь и нажми ещё раз",sq_dropped:"Не сохранено подходов: {n} — тренировка уже закрыта на сервере",sq_waiting:"⏳ Ждут отправки: {n}. Уйдут сами, как появится связь",sq_finish_pending:"Ещё не отправлено подходов: {n}. Завершить сейчас? Они уйдут позже, но в итоги этой тренировки не попадут.",
    specify_name:"Укажите название",
    specify_name_cal:"Укажите название и калории",
    delete_confirm:"Удалить занятие?",
    no_answer:"Нет ответа",
    another_one:"ЕЩЁ ОДНО",
    going_in:"ВХОДИМ...",
    exercises_none:"Упражнения не выбраны",
    exercises_none_planned:"Упражнения не были запланированы",
    my_workout_name:"Моя тренировка",
    workout_name_opt:"НАЗВАНИЕ (ОПЦИОНАЛЬНО)",
    workout_status_active:"⚠️ ТРЕНИРОВКА ЕЩЁ ВЫПОЛНЯЕТСЯ",
    scheduled_workout:"ЗАПЛАНИРОВАННАЯ ТРЕНИРОВКА",
    scheduled_done:"ЗАПЛАНИРОВАНО",
    my_workouts_title:"МОИ ТРЕНИРОВКИ",
    schedule_label:"РАСПИСАНИЕ",
    upcoming_label:"ПРЕДСТОЯЩИЕ",
    archive_planned:"АРХИВ ЗАПЛАНИРОВАННЫХ",
    search_exercise:"Поиск упражнения...",
    search_placeholder2:"Поиск...",
    name_label:"НАЗВАНИЕ",
    name_req:"Название *",
    exercise_group:"Группа мышц",
    sets_num:"Подходов",
    reps_num:"Повторений",
    all_btn:"ВСЕ",
    knowledge_base:"БАЗА ЗНАНИЙ",
    save_measurements2:"СОХРАНИТЬ ЗАМЕРЫ",
    saving:"СОХРАНЯЕМ...",
    saving2:"СОХРАНЯЮ...",
    saved2:"✓ СОХРАНЕНО",
    when_workout:"📅 КОГДА ТРЕНИРОВКА?",
    share_btn:"📤 ПОДЕЛИТЬСЯ",
    other_photo:"📷 Другое",
    warmup_badge2:"🏃 РАЗМИНКА",
    notifications_hint:"🔔 Бот напоминает за 1 час до тренировки.",
    not_found_hint:"Ничего не найдено",
    enter_name_or_cat:"ВВЕДИТЕ НАЗВАНИЕ ИЛИ ВЫБЕРИТЕ КАТЕГОРИЮ",
    calories_eaten:"🍽 КАЛОРИИ (ЕДА)",
    calories_burned2:"🔥 ПОТРАЧЕНО (СПОРТ)",
    trainer_bot:"Бот напомнит за 1 час",
    trainer_bot2:"Бот напомнит за 1 час до тренировки",
    conflict_time:"выбрать другое время?",
    dist_km:"ДИСТ. (КМ)",
    imt_label:"ИМТ",
    workout_done2:"Тренировка завершена",
    workout_type:"Тренировка",
    sets_short:"подх",
    reps_done:"выполнено",
    rpe_label:"RPE",
    warmup_duration:"5–10 мин",
    add_time30:"+30 сек",
    minus_time15:"−15 сек",
    no_sets_data:"нет данных",
    one_portion:"1 порция",
    portions_pack:"порций в упаковке",
    // ── ЖДЁТ ПЕРЕВОДА (батч 2, translations_batch2.csv) ──────────────────
    // Эти ключи намеренно есть ТОЛЬКО в русской секции: t() сам падает на
    // русский, поэтому интерфейс работает как раньше, а проверка паритета
    // по языкам показывает их как незакрытый долг и не даёт о них забыть.
    ref_step1:"Поделись ссылкой с другом",
    ref_step2:"Друг регистрируется в GymBot",
    ref_step3:"Ты получаешь {n} баллов",
    ref_step4:"Друг получает бонус при старте",
    plan_time_taken:"На {dt} уже есть тренировка «{title}». Выбрать другое время?",
    plan_show_ex:"ПОКАЗАТЬ УПРАЖНЕНИЯ ({n} групп) →",
    plan_ex_groups:"УПРАЖНЕНИЯ ({n} групп) →",
    err_save_failed:"Не удалось сохранить: {err}",
    err_save_status:"Ошибка сохранения ({code})",
    err_server_retry:"Ошибка сервера ({code}). Попробуй позже.",
    sup_per_pack:"{n} порций в упаковке",
    sup_tabs:"{a}мг ({b} таб по 100мг)",
    prog_weight_range:"График веса: от {a} до {b}",
    ai_plan_more:"+{n} ещё",
    u_let:"лет",
    u_dn:"дн",
    u_t:"т",
    u_km:"км",
    u_povt:"повт",
    // ── Добавлено 05.10.2026: тексты, которых не было в словаре вовсе.
    // Раньше они стояли литералами прямо в разметке и показывались
    // по-русски при любом языке приложения.
    // Активная тренировка
    aw_badminton:"🏸 Бадминтон",
    aw_ballov_za_seriyu:"баллов за серию",
    aw_basketbol:"🏀 Баскетбол",
    aw_beg:"🏃 Бег",
    aw_boks:"🥊 Бокс",
    aw_bolshoy_tennis:"🎾 Большой теннис",
    aw_dney:"дней",
    aw_dnya:"дня",
    aw_dobavit_uprazhnenie:"Добавить упражнение",
    aw_futbol:"⚽ Футбол",
    aw_gandbol:"🤾 Гандбол",
    aw_gornye_lyzhi:"⛷ Горные лыжи",
    aw_nastolnyy_tennis:"🏓 Настольный теннис",
    aw_padel:"🎾 Падел",
    aw_pilates:"🧘 Пилатес",
    aw_plavanie:"🏊 Плавание",
    aw_skalolazanie:"🧗 Скалолазание",
    aw_sohranyaem:"⏳ СОХРАНЯЕМ...",
    aw_velosport:"🚴 Велоспорт",
    aw_voleybol:"🏐 Волейбол",
    aw_vyberi_zamenu:"— выбери замену",
    aw_vybrano:"ВЫБРАНО (",
    aw_yoga:"🧘 Йога",
    aw_zagruzka:"Загрузка...",
    // Блок «плато» в прогрессе
    plateau_analiz:"АНАЛИЗ",
    // Гид по питанию
    fg_belok:"БЕЛОК",
    // Голосовая запись
    voice_oshibka:"Ошибка",
    // График недели: короткие названия спорта
    sps_badm:"бадм.",
    sps_basket:"баскет",
    sps_beg:"бег",
    sps_boks:"бокс",
    sps_futbol:"футбол",
    sps_gandbol:"гандбол",
    sps_krossfit:"кроссфит",
    sps_lyzhi:"лыжи",
    sps_n_tennis:"н.теннис",
    sps_padel:"падел",
    sps_pilates:"пилатес",
    sps_plav:"плав.",
    sps_skalolaz:"скалолаз.",
    sps_tennis:"теннис",
    sps_velo:"вело",
    sps_voley:"волей",
    sps_yoga:"йога",
    // График по группам мышц
    mgc_obem:"объём",
    // Достижения
    ach_esche_ne_otkryto:"ЕЩЁ НЕ ОТКРЫТО (",
    ach_otkryto:"ОТКРЫТО (",
    // Единицы измерения
    u_carb:"У",
    u_fat:"Ж",
    u_g:"г",u_s:"с",
    u_prot:"Б",
    // Журнал занятий спортом
    splog_svoe:"Своё",
    // Замеры тела
    meas_sm:"см",
    // Запланированная тренировка
    pw_arhivnaya:"📋 АРХИВНАЯ",
    pw_tolko_prosmotr:"ТОЛЬКО ПРОСМОТР",
    pw_uprazhneniya:"УПРАЖНЕНИЯ (",
    pw_vypolnena:"✓ ВЫПОЛНЕНА",
    // Знакомство при первом входе
    onb_analiziruet_trenirovki_vesa_:"Анализирует тренировки, веса, повторы — и советует, когда действительно пора прибавлять нагрузку",
    onb_atlet:"Атлет",
    onb_derzhit_motivaciyu:"Держит мотивацию",
    onb_dobro_pozhalovat:"ДОБРО ПОЖАЛОВАТЬ",
    onb_nachat:"НАЧАТЬ 🏋️",
    onb_nachat_znakomstvo:"НАЧАТЬ ЗНАКОМСТВО →",
    onb_otvechaet_kak_zhivoy_trener:"Отвечает как живой тренер",
    onb_pitanie_po_foto:"Питание по фото",
    onb_serii_dney_dostizheniya_ches:"Серии дней, достижения, честная обратная связь — без лишней сюсюканья",
    onb_sfotografiroval_edu_poluchil:"Сфотографировал еду — получил КБЖУ. Без ручного ввода каждого приёма пищи",
    onb_sprosi_chto_ugodno_pro:"Спроси что угодно про тренировку, восстановление, добавки — получишь конкретный ответ по твоим данным",
    onb_tvoy_lichnyy_ai_trener:"Твой личный AI-тренер 🤖",
    onb_vidit_ves_tvoy_progress:"Видит весь твой прогресс",
    // История тренировок
    wh_nizkaya:"Низкая",
    wh_plan:"ПЛАН",
    wh_srednyaya:"Средняя",
    wh_vysokaya:"Высокая",
    wh_zavershena:"✓ ЗАВЕРШЕНА",
    // Карточка тренировки
    wd_ph:"ПХ",
    // Лидерборд
    lb_ty:"(ты)",
    // Мои добавки
    usup_dobavit:"+ ДОБАВИТЬ",
    usup_dobavit2:"✓ ДОБАВИТЬ",
    // Питание
    nut_belki:"Белки",
    nut_cel:"цель",
    nut_g:"(г)",
    nut_isprav_nazvanie_sostav_kbzhu:"Исправь название/состав — КБЖУ пересчитается автоматически",
    nut_limit_ai_zaprosov_na:"⚠️ Лимит AI запросов на сегодня исчерпан",
    nut_ml:"мл",
    nut_naprimer_chto_mne_ne:"Например: что мне не хватает в питании сегодня? или как лучше распределить белки?",
    nut_naprimer_risovaya_kasha_s:"Например: Рисовая каша с молоком, 300г",
    nut_oshibka:"ошибка",
    nut_pereschitat_i_sohranit:"🔄 ПЕРЕСЧИТАТЬ И СОХРАНИТЬ",
    nut_pitanie:"ПИТАНИЕ",
    nut_zhiry:"Жиры",
    // Поиск продукта
    fs_na:"на",
    fs_poisk:"ПОИСК",
    fs_sportpit:"💊 Спортпит",
    fs_vse:"Все",
    // Правка занятия спортом
    spedit_partnery_oschuscheniya:"Партнёры, ощущения...",
    spedit_schet:"Счёт",
    // Прогресс
    prog_cht:"чт",
    prog_pn:"пн",
    prog_pt:"пт",
    prog_sb:"сб",
    prog_seriya:"СЕРИЯ",
    prog_sr:"ср",
    prog_trenirovok:"ТРЕНИРОВОК",
    prog_vs:"вс",
    prog_vt:"вт",
    // Профиль
    prof_bally:"Баллы",
    prof_bro:"🤙 Бро",
    prof_ekspert:"🎓 Эксперт",
    prof_ekspert2:"Эксперт",
    prof_nastavnik:"🧑‍🏫 Наставник",
    prof_nastavnik2:"Наставник",
    prof_profil_ne_nayden_snachala:"Профиль не найден. Сначала пройди регистрацию в боте @GYMASH_bot, затем вернись сюда.",
    prof_status:"Статус",
    prof_stil_ai:"Стиль AI",
    prof_uroven:"Уровень",
    // Профиль: аллергии
    alg_glyuten:"🌾 Глютен",
    alg_laktoza:"🥛 Лактоза",
    alg_orehi:"🥜 Орехи",
    alg_rybiy_zhir:"🐟 Рыбий жир",
    alg_soya:"🫘 Соя",
    alg_yayca:"🥚 Яйца",
    // Профиль: ограничения по здоровью
    med_bol_v_spine:"🔙 Боль в спине",
    med_diabet:"💉 Диабет",
    med_gipertoniya:"🩺 Гипертония",
    med_gryzha:"⚠️ Грыжа",
    med_plecho_rotator:"💪 Плечо/ротатор",
    med_pochki:"🫘 Почки",
    med_pozvonochnik:"🦴 Позвоночник",
    med_serdce_sosudy:"❤️ Сердце/сосуды",
    med_travma_kolena:"🦵 Травма колена",
    // Профиль: уровень подготовки
    lvl_novichok:"Новичок",
    // Распознавание еды по фото
    fv_blyudo:"Блюдо",
    fv_gotovo:"✅ ГОТОВО",
    fv_ispravit:"✏️ ИСПРАВИТЬ",
    fv_naprimer_risovaya_kasha_s:"Например: Рисовая каша с молоком и мёдом, 300г",
    fv_ne_udalos_pereschitat_poprob:"Не удалось пересчитать. Попробуй описать иначе.",
    fv_neizvestnaya_oshibka:"неизвестная ошибка",
    fv_nizkaya:"❓ Низкая",
    fv_otmena:"Отмена",
    fv_perekadrirovat:"🔄 Перекадрировать",
    fv_pereschitat:"🔄 ПЕРЕСЧИТАТЬ",
    fv_pereschityvaem:"ПЕРЕСЧИТЫВАЕМ...",
    fv_povtorit_sohranenie:"🔄 ПОВТОРИТЬ СОХРАНЕНИЕ",
    fv_povtoryaem:"ПОВТОРЯЕМ...",
    fv_srednyaya:"⚠️ Средняя",
    fv_vysokaya:"✅ Высокая",
    // Рефералы
    ref_kopirovat:"📋 КОПИРОВАТЬ",
    ref_moi_referaly:"МОИ РЕФЕРАЛЫ (",
    ref_skopirovano:"✓ СКОПИРОВАНО",
    // Сбор тренировки
    plan_dobavit_v_trenirovku:"+ ДОБАВИТЬ В ТРЕНИРОВКУ",
    plan_ubrat_iz_trenirovki:"✓ УБРАТЬ ИЗ ТРЕНИРОВКИ",
    plan_vybrano:"ВЫБРАНО",
    plan_zaplanirovat:"📅 ЗАПЛАНИРОВАТЬ",
    // Своё блюдо (форма)
    fcat_frukty:"🍎 Фрукты",
    fcat_hleb:"🍞 Хлеб",
    fcat_krupy:"🌾 Крупы",
    fcat_molochka:"🥛 Молочка",
    fcat_myaso:"🥩 Мясо",
    fcat_napitki:"🧃 Напитки",
    fcat_ovoschi:"🥦 Овощи",
    fcat_prochee:"🫙 Прочее",
    fcat_ryba:"🐟 Рыба",
    fcat_sneki:"🍫 Снеки",
    // Своё упражнение
    cex_moe:"Моё",
    // Серии и баллы
    gam_atlet:"🥈 Атлет",
    gam_chek_in:"✓ Чек-ин",
    gam_chempion:"🥇 Чемпион",
    gam_legenda:"💎 Легенда",
    gam_pitanie_vneseno:"Питание внесено",
    gam_tennis:"🎾 Теннис",
    gam_trenirovka_zavershena:"🏋️ Тренировка завершена",
    gam_zanyatie_sportom:"Занятие спортом",
    // Справочник добавок
    sup_10g_den:"10г/день",
    sup_15_30mg_den:"15–30мг/день",
    sup_1_3g_epa_dha:"1–3г EPA+DHA/день",
    sup_2000_5000_me_den:"2000–5000 МЕ/день",
    sup_200_400mg:"200–400мг",
    sup_20_40g_za_priem:"20–40г за приём",
    sup_3_5g_den:"3–5г/день",
    sup_3_6mg_kg_vesa:"3–6мг/кг веса",
    sup_bez_zagruzki_rezultat_cherez:"Без загрузки. Результат через 2–4 недели. Запивай водой (250мл). Один из самых изученных препаратов.",
    sup_immunitet_testosteron_kosti_:"Иммунитет, тестостерон, кости. Принимать с K2 (100–200мкг) для правильного усвоения кальция.",
    sup_immunitet_testosteron_vossta:"Иммунитет, тестостерон, восстановление. Не принимать вместе с кальцием — конкурируют за усвоение.",
    sup_kachestvo_sna_myshechnoe_vos:"Качество сна, мышечное восстановление, снижение стресса. Форма: глицинат или малат (не оксид — плохо усваивается).",
    sup_posle_trenirovki_ili_v:"После тренировки или в любое время дня",
    sup_povyshaet_vynoslivost_silu_i:"Повышает выносливость, силу и концентрацию. Не принимать после 15:00 — нарушает сон. Допуск развивается быстро.",
    sup_prokonsultiruysya_s_vrachom_:"⚠️ Проконсультируйся с врачом — есть противопоказания",
    sup_protivovospalitelnyy_effekt_:"Противовоспалительный эффект, суставы, сердце. Смотри на содержание EPA+DHA, не общий жир рыбы.",
    sup_sustavy_i_svyazki_neobhodim:"Суставы и связки. Необходим витамин C (100мг) для синтеза коллагена. Эффект накопительный — 8–12 недель.",
    sup_umerennyy_uroven_dokazatelno:"🟡 Умеренный уровень доказательности",
    sup_vospolnenie_belka_syvorotoch:"Восполнение белка. Сывороточный — быстрый, казеин — медленный (на ночь).",
    sup_vozmozhna_allergicheskaya_re:"🚫 Возможна аллергическая реакция",
    sup_vysokiy_uroven_dokazatelnost:"🟢 Высокий уровень доказательности",
    sup_your_weight:"(ТВОЙ ВЕС {w}КГ)",
    // Цели
    goals_celi:"ЦЕЛИ",
    // Экран тренера (AI)
    ai_ai_trenirovka:"AI тренировка",
    ai_chto_est_do_i:"Что есть до и после тренировки",
    ai_oshibka_soedineniya:"Ошибка соединения —",
    ai_programma_dlya_pohudeniya_na:"Программа для похудения на месяц",
    ai_sostav_plan_trenirovki_na:"Составь план тренировки на неделю под набор массы",
    ai_sprosi_chto_ugodno:"СПРОСИ ЧТО УГОДНО...",
    ai_trenirovka_na_plechi_i:"Тренировка на плечи и руки",
    // ── Батч 2 и 3, переводы получены 06.10.2026 ───────────────────────
    // Батч 2 — тексты из шаблонных строк, батч 3 — многострочные
    // текстовые узлы JSX: ни те, ни другие построчный поиск не находит.
    ui_1_porciya:"1 порция =",
    ui_ai_zaprosov_v_den:"AI запросов в день:",
    ui_ball:"балл.)",
    ui_dobavit_svoe_uprazhnenie:"⭐ ДОБАВИТЬ СВОЁ УПРАЖНЕНИЕ",
    ui_dobavit_svoy_produkt:"＋ ДОБАВИТЬ СВОЙ ПРОДУКТ",
    ui_izmenenie_za_3_nedeli:"Изменение за 3 недели:",
    ui_kg_za_period:"кг за период",
    ui_limit_ai_zaprosov_na:"💬 Лимит AI запросов на сегодня исчерпан — оценка будет доступна завтра",
    ui_napishi_pravilnoe_nazvanie_ili:"Напиши правильное название или состав блюда. КБЖУ пересчитается автоматически.",
    ui_naydeno_v_kataloge:"⚠ Найдено в каталоге:",
    ui_ne_prosto_spisok_uprazhneniy:"Не просто список упражнений — тренер, который реально знает твою историю и подстраивается под тебя.",
    ui_ne_udalos_poluchit_ocenku:"Не удалось получить оценку AI — проверь соединение",
    ui_peremeschay_i_uvelichivay_chto:"Перемещай и увеличивай, чтобы блюдо поместилось целиком",
    ui_podhod:"ПОДХОД",
    ui_poka_nikto_ne_v:"Пока никто не в рейтинге. Тренируйся и зарабатывай баллы!",
    ui_polnaya_zapis_v_razdele:"↗ Полная запись в разделе Тренировки → ⚽ Спорт",
    ui_poprobuy_otkryt_cherez_telegra:"Попробуй открыть через Telegram-бот.",
    ui_poprobuy_smenit_uprazhnenie_il:"💡 Попробуй сменить упражнение или добавить дроп-сет — спроси тренера",
    ui_posledniy_raz:"ПОСЛЕДНИЙ РАЗ (",
    ui_primenenie_vitaminov_i_dobavok:"⚠️ Применение витаминов и добавок носит рекомендательный характер и не является медицинской рекомендацией. Перед применением проконсультируйтесь с врачом.",
    ui_privet_treniruyus_v_gymbot:"Привет! Тренируюсь в GymBot — умный AI-тренер в Telegram. Присоединяйся по моей ссылке и получи бонусные баллы!",
    ui_referalnaya_programma_vremenno:"Реферальная программа временно недоступна",
    ui_seriya:"🔥 Серия:",
    ui_sleduyuschiy:"Следующий:",
    ui_taymer_avtomaticheski_zapuskae:"Таймер автоматически запускается после каждого подхода во время тренировки.",
    ui_tochnost:"ТОЧНОСТЬ:",
    ui_trenirovka_ne_naydena_ili:"Тренировка не найдена или нет доступа.",
    ui_vybrano_grupp:"ВЫБРАНО ГРУПП:",
    ui_zamenit:"ЗАМЕНИТЬ",
    ui_zdes_mozhno_ispolzovat_otdelno:"Здесь можно использовать отдельно.",
  },
  en: {
    menu_nutrition:"Nutrition", menu_workout:"Workouts", menu_progress:"Progress",
    menu_catalog:"Catalog", menu_ai:"Coach", menu_checkin:"Check-in",
    menu_measurements:"Body Measurements", menu_goals:"Goals", menu_supplements:"Supplements",
    menu_support:"Support", menu_language:"Language", menu_sport:"Sports",
    menu_gamification:"My Status", menu_food_guide:"Food Catalog",
    menu_referral:"Invite Friend", menu_photo_kbju:"Photo → Calories",
    menu_rest_timer:"Rest Timer", menu_plan:"Schedule", menu_reminders:"Reminders",
    menu_tab_menu:"Menu", menu_tab_workout:"Workouts", menu_tab_progress:"Progress",
    menu_tab_catalog:"Catalog", menu_tab_ai:"Coach",
    section_quick:"QUICK ACCESS", section_catalog:"CATALOG", section_profile:"PROFILE",
    start_workout:"▶ START WORKOUT", back:"← BACK",
    today:"TODAY", loading:"LOADING", save:"SAVE", cancel:"CANCEL",
    add:"ADD", edit:"EDIT", delete:"DELETE", close:"CLOSE",
    save_profile:"SAVE", cancel_btn:"CANCEL", edit_profile:"EDIT PROFILE",
    edit_profile_btn:"EDIT →", profile_title:"MY PROFILE",
    my_profile:"MY PROFILE", not_specified:"Not specified", allergies:"ALLERGIES",
    level:"LEVEL", goal_label:"GOAL", no_conditions:"No conditions",
    no_allergies:"No allergies", reset_btn:"RESET", status_label:"STATUS",
    fitness_level_label:"FITNESS LEVEL", my_rating:"MY RATING",
    points_label:"POINTS", rank_label:"RANK",
    plateau_title:"PLATEAU DETECTOR", plateau_weight:"Weight not changing",
    plateau_exercise:"Stagnant exercises", plateau_none:"No plateau detected",
    referral_title:"INVITE FRIEND", referral_your_code:"Your code",
    referral_link:"Referral link", referral_friends:"Friends invited",
    referral_bonus:"Points per referral",
    workout_title:"WORKOUTS", workouts_title:"WORKOUTS",
    no_workouts:"No workouts yet", no_workouts_yet:"No workouts yet",
    tonnage_label:"TONNAGE", no_sport_yet:"No activities yet",
    planned_tab:"📅 PLAN", sport_tab:"⚽ SPORT", archive_tab:"📋 ARCHIVE",
    no_planned:"No planned workouts", planned_archive:"PLANNED ARCHIVE",
    nutrition_title:"DIARY", add_meal:"+ add",
    water_label:"💧 WATER", glasses_unit:"glasses",
    ask_trainer:"Ask trainer about nutrition",
    meal_breakfast:"Breakfast", meal_lunch:"Lunch", meal_dinner:"Dinner", meal_snack:"Snack",
    progress_title:"PROGRESS", catalog_title:"EXERCISES", ai_title:"COACH ONLINE",
    food_search_title:"CATALOG", food_search_placeholder:"Search product...",
    add_to_diary:"ADD TO DIARY", weight_label:"WEIGHT (g)",
    sport_record:"LOG ACTIVITY", sport_duration:"DURATION (MIN)",
    sport_intensity:"INTENSITY", sport_date:"DATE", sport_notes:"NOTES",
    sport_type_label:"SPORT TYPE", sport_notes_opt:"NOTES (OPTIONAL)",
    sport_saved:"RECORDED", sport_save_btn:"✓ LOG ACTIVITY",
    score_opt:"SCORE (OPTIONAL)", score_label:"SCORE",
    intensity_low:"🟢 Low", intensity_medium:"🟡 Medium", intensity_high:"🔴 High",
    time_label:"TIME", intensity_label:"INTENSITY", calories_label:"CALORIES",
    archive_label:"ARCHIVE",
    choose_type:"WHAT ARE WE DOING?", choose_type_label:"CHOOSE TYPE",
    gym_title:"Gym", gym_desc:"Strength exercises, muscle and exercise selection",
    sport_section:"Sports", sport_desc:"Log activity with calorie calculation",
    sport_section_title:"Sports", sport_section_desc:"Log activity with calorie calculation",
    resume_workout:"CONTINUE WORKOUT", resume_desc:"You have an unfinished workout",
    workout_closed_elsewhere:"Your previous workout has already been finished — on another device or automatically. You can start a new one.",
    finish_workout:"FINISH", workout_empty_note:"No sets were logged, so this workout was not counted and is not in your history.", set_done:"✓ SET DONE", set_done_label:"SET DONE",
    premium_menu:"Premium", premium_kicker:"PREMIUM", premium_title:"GymBot Premium", premium_lead:"More coach questions and food recognitions — and you support GymBot's development.", premium_active_until:"Premium is active until {date}", premium_trial_until:"Premium trial until {date}", premium_manual:"Premium is active", premium_perk_ai:"{n} coach questions a day", premium_perk_food:"{n} food photos a day", premium_perk_now:"{n} without Premium", premium_perk_support:"New features sooner: you support the app's development", premium_month:"Month", premium_year:"Year", premium_month_note:"renews every 30 days, turn off any time", premium_year_note:"one-time payment for 365 days", premium_save:"save {n}%", premium_buy:"Get for {n} ⭐", premium_extend:"Extend for {n} ⭐", premium_trial_btn:"Try {n} days free", premium_renews:"Subscription renews on {date}", premium_renew_off:"Auto-renewal is off — Premium until {date}", premium_cancel_btn:"Turn off auto-renewal", premium_resume_btn:"Turn on auto-renewal", premium_paid_wait:"Payment received — turning Premium on…", premium_paid_ok:"Premium is on until {date}. Thank you!", premium_paid_late:"Payment received. Premium will turn on within a few minutes — the bot will message you.", premium_failed:"Payment failed. Please try again.", premium_error:"Couldn't open the payment. Please try later.", premium_already_sub:"You already have a subscription.", premium_note:"Paid with Telegram Stars. You can turn auto-renewal off here or in Telegram: Settings → My Stars. Payment questions — /paysupport in the bot.", premium_nudge_ai:"With Premium — {n} coach questions a day", premium_nudge_food:"With Premium — {n} food photos a day", premium_nudge_btn:"Learn more", share_kicker:"SHARE", share_story:"To story", share_chat:"To chat", share_preparing:"Preparing the card…", share_sent_bot:"The card is in your chat with the bot — forward it to friends", share_error:"Couldn't prepare the card. Please try again.",
    soc_menu:"Friends & teams", soc_kicker:"COMMUNITY", soc_title:"Friends & teams", tab_feed:"Feed", tab_friends:"Friends", tab_teams:"Teams", soc_invite_title:"Invite friends", soc_invite_hint:"Friends see each other's workouts and records and give 👏. Weight, nutrition and health are never shown.", soc_invite_btn:"Invite a friend", soc_copy:"Copy link", soc_copied:"Link copied", soc_share_text:"Let's train together in GymBot 💪", soc_privacy:"Show my workouts to friends", soc_friends_empty:"No friends yet — send an invite.", soc_week_n:"{n} workouts this week", soc_remove:"Remove", soc_remove_confirm:"Remove {name} from friends?", soc_feed_empty:"Your and your friends' workouts will appear here.", soc_you:"You", soc_sets:"{n} sets", soc_tonnage:"{n} t", soc_min:"{n} min", soc_record:"Record: {ex} — {w} kg (was {p})", soc_more:"Show more", soc_accepted:"You and {name} are now friends", soc_already:"{name} is already your friend", soc_bad_code:"The link is outdated or invalid", soc_own_code:"That's your own link 🙂", soc_teams_empty:"No teams yet. Create one or join with a code.", soc_team_create:"Create team", soc_team_name:"Team name", soc_team_join:"Join with a code", soc_team_code:"Team code", soc_team_members:"{n} members", soc_team_week:"This week: {n} workouts", soc_team_place:"Your place: {n}", soc_team_invite:"Invite to team", soc_team_leave:"Leave team", soc_team_leave_confirm:"Leave «{name}»?", soc_team_rename:"Rename", soc_team_joined:"You're in «{name}»", soc_team_full:"The team already has 50 members", soc_too_many_teams:"You can be in at most 5 teams", soc_board_title:"WEEKLY RANKING", soc_board_hint:"Completed workouts since Monday", soc_last_week:"last: {n}", soc_owner:"owner", soc_share_team_text:"Join our team «{name}» in GymBot 💪", soc_remove_member:"Remove", soc_remove_member_confirm:"Remove {name} from the team?",
    wn_kicker:"WHAT'S NEW", wn_kicker_new:"GOOD TO KNOW", wn_menu:"What's new", wn_skip:"Skip", wn_next:"Next", wn_done:"Done", wn_str_d:"See how strong you are: a level for every lift — from «{a}» to «{b}».", wn_str_1:"Takes your sex, body weight and age into account", wn_str_2:"Compare yourself with other GymBot athletes", wn_str_3:"See how much to add to reach the next level", wn_str_b:"My level", wn_food_t:"Plov, lagman, samsa", wn_food_d:"Local dishes are now in the food diary, and meal photos recognise them.", wn_food_1:"37 national dishes with calories and macros", wn_food_2:"Label scanner: snap the package and the nutrition facts fill in by themselves", wn_food_3:"Names in Russian, Uzbek and Kazakh", wn_food_b:"Scan a label", wn_prog_d:"Ready-made 6–12 week plans: what to do each day, how many sets and reps.", wn_prog_1:"For the gym and for home, for beginners and experienced lifters", wn_prog_2:"The app tells you which day is next", wn_prog_3:"3 programs are free", wn_prog_3_all:"All programs are free", wn_prog_b:"Choose a program", wn_soc_d:"Training together is more fun — and harder to skip.", wn_soc_1:"A feed of friends' workouts and records, 👏 for the effort", wn_soc_2:"Teams with a weekly workout ranking", wn_soc_3:"Friends never see your weight, nutrition or health", wn_soc_b:"Invite a friend", wn_prem_d:"More for those who train seriously.", wn_prem_1:"Up to {n} AI coach questions a day", wn_prem_2:"Up to {n} food photos a day", wn_prem_3:"All training programs; pay with Telegram Stars", wn_prem_b:"Learn more", wn_prem_trial:"Try {n} days free",
    prog_menu:"Training programs", prog_kicker:"PROGRAMS", prog_title:"Training programs", prog_lead:"Ready-made plans for several weeks: what to do each day, how many sets and reps.", prog_meta:"{d} workouts a week · {w} wk", prog_active:"YOUR PROGRAM", prog_progress:"Workout {n} of {t}", prog_next:"Next: {day}", prog_start_day:"Start: {day}", prog_start:"Start program", prog_replace_confirm:"You're on «{cur}». Start the new program instead?", prog_stop:"Stop program", prog_stop_confirm:"Stop the program? Completed workouts stay in your history.", prog_unlock:"Unlock with Premium", prog_tip:"TIP", prog_days:"PROGRAM DAYS", prog_rest_s:"rest {n} s", prog_rest_m:"rest {n} min", prog_reps_max:"max", prog_sec:"s", prog_finished:"Program complete! Choose the next one.", prog_free:"Free", prog_week:"week {n}", prog_not_in_catalog:"not in catalog", prog_is_active:"In progress", prog_all:"All programs", prog_open:"Open",
    fcat_national:"Local cuisine", label_scan_btn:"Scan a label", fv_mode_dish:"Dish", fv_mode_label:"Label", label_kicker:"LABEL SCANNER", label_title:"Label photo", label_hint:"Take a photo of the nutrition facts table on the package — we'll fill in the values per 100 g and save the product to the catalog.", label_photo_btn:"Photograph the label", label_read_btn:"Read label", label_reading:"READING THE LABEL…", label_not_found:"No nutrition table found in the photo. Take it closer and straighter.", label_failed:"Couldn't read the label. Please try again.", label_name:"Name", label_brand:"Brand", label_per100:"Per 100 g", label_low_conf:"Check the numbers: some may have been read inaccurately.", label_portion:"How much you ate, g", label_pack_portion:"package serving", label_save_log:"Add to diary", label_save_only:"Just save to catalog", label_saved_only:"Saved — you can find it in search.", label_total:"Total for {w} g", food_portion_approx:"serving ~{n} g",
    str_e1rm:"est. 1RM", str_menu:"Strength ranks", str_kicker:"STRENGTH", str_title:"Strength ranks", str_overall:"Overall rank", str_stronger:"Stronger than ~{n}% of lifters", str_basis:"Estimated from strength standards for your sex, body weight and age. The max is taken from your best set of up to 12 reps (Epley formula).", str_missing:"To calculate ranks, add your sex and weight in the profile.", str_btn_profile:"Complete profile", str_to_next:"To «{lvl}»: +{n} {u}", str_top:"Top level — congratulations!", str_community:"Among GymBot users: stronger than {n}% of {m}", str_untracked:"No rank yet", str_untracked_hint:"Do a set in any of these exercises and the rank will appear.", str_all:"All ranks", str_from:"best set {w} kg × {r}", str_from_reps:"best set — {r} reps", str_reps:"reps", str_on:"from {n} lifts", str_empty:"No sets in the main lifts yet — ranks will appear after your first workout with them.", str_lvl_start:"Start", str_lvl_beginner:"Beginner", str_lvl_novice:"Novice", str_lvl_intermediate:"Intermediate", str_lvl_advanced:"Advanced", str_lvl_elite:"Elite",
    terms_menu:"Terms of use", terms_kicker:"DOCUMENT", terms_title:"Terms of use", terms_updated:"Version of 24 October 2026", terms_read:"Read the terms", terms_premium_link:"Premium terms, cancellation and refunds", terms_close:"Close", terms_s_general_t:"1. General", terms_s_general_b:"GymBot is a training and nutrition log with an AI coach in Telegram. It is available from age 18.\n\nThe AI coach's advice, calorie estimates from photos and load recommendations are for reference only and are not medical prescriptions. You make your own decisions about training, nutrition and supplements, taking your health into account. If you have conditions or contraindications, consult a doctor.\n\nDo not use the app for spam, insults or other people's data. We may restrict access for this.", terms_s_data_t:"2. Data", terms_s_data_b:"What data is collected and who it is shared with is described in the consents. You can view them in your profile; consents for health data and for sharing data with the AI service can be withdrawn at any time.", terms_s_prem_t:"3. Premium", terms_p_what:"Premium is the paid part of the app: more AI coach questions and food photo recognitions per day, plus the other features listed on the Premium screen. Current limits are shown there. Premium may gain new features.", terms_p_pay:"Payment is made only with Telegram Stars inside Telegram. Currently a month costs {pm} ⭐ and a year {py} ⭐. If the price changes, an already paid period is not recalculated.", terms_p_pay_np:"Payment is made only with Telegram Stars inside Telegram. Current prices are shown on the Premium screen. If the price changes, an already paid period is not recalculated.", terms_p_month:"A month is a subscription: every 30 days Telegram automatically charges the same amount until you cancel. You can cancel any time — on the Premium screen with «Turn off auto-renewal» or in Telegram: Settings → My Stars. After cancelling, Premium works until the end of the paid period and there are no new charges.", terms_p_year:"A year is a one-time payment for 365 days with no auto-renewal. If you also have an active monthly subscription, we turn it off so you are not charged twice.", terms_p_trial:"The trial is {n} days free, once per account. It does not renew by itself and charges nothing.", terms_p_refund:"Refunds. If Stars were charged but Premium didn't turn on, or a charge was made by mistake or twice, contact support with /paysupport in the bot and mention the payment date. On refund, the Stars go back to your Telegram balance and the Premium days for that payment are removed in full. Refunds for time already used are reviewed case by case.", terms_p_account:"Premium is tied to your Telegram account and cannot be transferred to other people.", terms_s_support_t:"4. Support", terms_s_support_b:"Questions and complaints — in the app's «Support» section; payment questions — /paysupport in the bot. We reply in the chat with the bot.\n\nThese terms may change. We will announce significant changes in the bot.",
    warmup_title:"WARM UP", warmup_skip:"SKIP", warmup_done:"✓ WARM UP DONE",
    warmup_hint:"Cardio for warm-up — optional", warmup_badge:"🏃 WARM UP",
    ready_wk_kicker:"WORKOUT READY", ready_wk_hint:"Built from your training history", ready_wk_program:"From your program", ready_wk_change:"Change exercises",
    rest_notify_title:"Rest alert", rest_notify_hint:"The bot messages you when rest is over. Pocket your phone — your watch will buzz.", rest_notify_on:"On", rest_notify_off:"Off",
    rest_offer_kicker:"TIP", rest_offer_title:"Put the phone away during training?", rest_offer_text:"The bot can signal the end of each rest. No need to hold the phone — your watch or band will buzz.", rest_offer_yes:"Turn on", rest_offer_no:"No thanks",
    order_title:"ORDER", order_hint:"↑↓ — reorder · ↔ — replace",
    muscles_title:"MUSCLE GROUPS", exercises_title:"EXERCISES", replace_title:"REPLACE", show_all_exercises:"SHOW ALL EXERCISES",
    select_groups_hint:"Select one or more groups → we'll show exercises",
    step_1_4:"STEP 1 / 4", step_2_4:"STEP 2 / 4", step_3_4:"STEP 3 / 4", step_4_4:"STEP 4 / 4",
    weight_kg:"WEIGHT (KG)", reps_label:"REPS", time_sec:"TIME (SEC)",
    distance_km:"DISTANCE (KM)", prev_btn:"← PREV", next_btn:"NEXT →",
    workout_done:"WORKOUT COMPLETE", workout_complete:"WORKOUT COMPLETE",
    great_work:"Great work!", analyzing:"ANALYZING WORKOUT...",
    workout_sets:"WORKOUT SETS", no_sets:"No set records", reps_short:"REPS",
    error_label:"ERROR", load_error:"FAILED TO LOAD",
    water_hint:"← tap to log a glass of water",
    ai_thinking:"ANALYZING...", ai_ask:"ASK COACH", ai_limit:"⚠️ AI request limit reached",
    goal_health:"Health",
    goal_lose:"Weight Loss",
    goal_muscle:"Muscle Gain",
    goal_strength:"Strength",
    goal_endurance:"Endurance",
    level_beginner:"Beginner",
    level_intermediate:"Intermediate",
    level_advanced:"Advanced",
    difficulty_easy:"Easy",
    difficulty_medium:"Medium",
    difficulty_hard:"Hard",
    gender_male:"Male",
    gender_female:"Female",
    next_btn2:"NEXT →",
    back_to_menu:"← TO MENU",
    search_placeholder:"SEARCH...",
    enter_name:"Your name",
    enter_goal:"WHAT IS YOUR GOAL?",
    hello_name:"HI! WHAT IS YOUR NAME?",
    name_hint:"Your name will be shown in the app",
    sets_label:"SETS",
    reps_label2:"REPS",
    exercises_label:"EXERCISES",
    minutes_label:"MINUTES",
    tonnage_label2:"TONNAGE",
    volume_label:"VOLUME",
    weight_label2:"WEIGHT",
    date_label:"DATE",
    time_label2:"TIME",
    difficulty_label:"DIFFICULTY",
    equipment_label:"EQUIPMENT",
    description_label:"DESCRIPTION",
    technique_label:"TECHNIQUE", tech_offline:"The technique will load once you are back online.",
    more_info:"MORE →",
    open_plan:"OPEN PLAN →",
    continue_workout2:"CONTINUE WORKOUT",
    unfinished:"You have an unfinished workout",
    skip_warmup:"SKIP WARM-UP",
    warmup_time:"RECOMMENDED WARM-UP TIME",
    replace_exercise:"↔ REPLACE EXERCISE",
    do_replace:"↔ REPLACE",
    add_exercise:"+ ADD EXERCISE",
    add_during:"ADD EXERCISE",
    my_exercise:"CUSTOM EXERCISE",
    all_exercises:"ALL EXERCISES →",
    show_exercises:"SHOW ALL EXERCISES →",
    order_hint2:"↑↓ — reorder · ↔ — replace",
    steps_1_4:"STEP 1 / 4",
    steps_2_4:"STEP 2 / 4",
    steps_3_4:"STEP 3 / 4",
    steps_4_4:"STEP 4 / 4",
    steps_1_2:"STEP 1 / 2",
    steps_2_2:"STEP 2 / 2",
    plan_step1:"PLANNING · STEP 1",
    plan_step2:"PLANNING · STEP 2",
    plan_step3:"PLANNING · STEP 3",
    calories_label2:"CALORIES",
    proteins_label:"PROTEINS",
    fats_label:"FATS",
    carbs_label:"CARBS",
    kcal_unit:"kcal",
    kcal_per100:"kcal/100g",
    protein_g:"Protein g",
    fat_g:"Fat g",
    carb_g:"Carbs g",
    weight_g:"Weight (kg)",
    portions_label:"MEAL",
    add_meal2:"ADD TO DIARY",
    add_product:"ADD PRODUCT",
    new_product:"NEW PRODUCT (per 100g)",
    product_catalog:"FOOD CATALOG",
    food_catalog_title:"FOOD REFERENCE",
    food_catalog_kbju:"PER 100G",
    search_product:"Search product...",
    product_name:"Product name *",
    dish_name:"Dish name",
    add_custom_product:"+ ADD CUSTOM PRODUCT",
    product_exists:"Product with this name already exists",
    calories_short:"Kcal",
    calories_req:"Kcal *",
    carbs_short:"Carbs",
    photo_kbju_title:"PHOTO → CALORIES",
    photo_kbju_hint:"Photo your food — AI will count calories and macros",
    analyzing_photo:"AI ANALYZING PHOTO...",
    analyze_btn:"🔍 ANALYZE",
    new_photo:"NEW PHOTO",
    add_to_diary2:"💾 TO DIARY",
    add_photo:"ADD PHOTO",
    ai_nutrition_title:"AI NUTRITION",
    saved_to_diary:"✓ SAVED TO NUTRITION DIARY",
    measurements_title2:"BODY MEASUREMENTS",
    measurements_cat:"ANTHROPOMETRY",
    save_measurements:"SAVE MEASUREMENTS",
    measurements_saved:"✓ MEASUREMENTS SAVED",
    measurements_history:"HISTORY",
    measurements_add:"ADD",
    measurements_none:"No measurements yet",
    waist:"Waist",
    hips:"Hips",
    chest:"Chest",
    arm:"Arm (bicep)",
    thigh:"Thigh",
    checkin_title2:"CHECK-IN",
    checkin_weekly:"WEEKLY",
    checkin_saved:"CHECK-IN SAVED",
    send_checkin:"SEND CHECK-IN",
    checkin_ai_hint:"AI coach received updated data",
    sleep_hours:"SLEEP (HOURS)",
    energy_label:"Energy",
    stress_label:"Stress",
    motivation_label:"Motivation",
    profile_fill:"Complete profile",
    profile_fill_hint:"Complete your profile to personalize workouts",
    profile_edit:"✏ EDIT PROFILE",
    edit_date:"✏ EDIT DATE/EXERCISES",
    age_label:"Age",
    age_years:"Age (years)",
    height_label:"Height",
    height_cm:"Height (cm)",
    bmi_label:"BMI",
    gender_label:"GENDER",
    ai_style_label:"AI COMMUNICATION STYLE",
    status_saved:"✓ SAVED",
    profile_saved2:"✓ MEASUREMENTS SAVED",
    ai_bro_desc:"Youth, slang, motivation",
    ai_mentor_desc:"Moderate, support, advice",
    ai_expert_desc:"Professional, terms",
    ai_bro_name:"Fitness Bro",
    med_label:"MEDICAL CONDITIONS",
    no_med:"No contraindications",
    supps_label:"💊 MY SUPPLEMENTS",
    quick_select:"QUICK SELECT",
    manual_input:"OR ENTER MANUALLY",
    supp_name:"Supplement name...",
    supp_dose:"Dosage (e.g. 5g)",
    supp_timing:"Timing (morning, pre-workout)",
    not_specified2:"Not specified",
    gamification_title2:"MY STATUS",
    my_rating2:"MY RATING",
    status_label2:"STATUS",
    points_label2:"POINTS",
    rank_label2:"RANK",
    leaderboard_title:"LEADERBOARD",
    my_position:"MY POSITION",
    how_earn:"HOW TO EARN POINTS",
    recent_points:"RECENT POINTS",
    next_rank:"TO NEXT RANK",
    streak_series:"🔥 ACTIVITY STREAK",
    achievements_title2:"ACHIEVEMENTS",
    new_achievement:"🎉 NEW ACHIEVEMENT",
    progress_label:"PROGRESS",
    unlocked_label:"UNLOCKED",
    referral_title2:"BONUS PROGRAM",
    how_works:"HOW IT WORKS",
    goals_title2:"MY GOALS",
    goals_add:"+ ADD GOAL",
    new_goal:"NEW GOAL",
    goal_desc:"Goal description...",
    goal_achieved:"ACHIEVED",
    no_goals:"No active goals. Set your first one!",
    goal_target:"Target",
    goal_unit:"unit",
    reminders_title2:"REMINDERS",
    reminders_cat:"NOTIFICATIONS",
    upcoming_workouts:"UPCOMING WORKOUTS",
    no_reminders:"No upcoming workouts",
    bot_reminds:"🔔 Bot reminds",
    one_hour:"1 hour",
    before_workout:"before workout",
    plateau_check:"Plateau detector runs every Sunday at 10:30.",
    add_plan:"+ SCHEDULE",
    add_plan2:"+ SCHEDULE WORKOUT",
    support_title2:"SUPPORT",
    support_cat:"FEEDBACK",
    support_placeholder:"Describe your issue, we will respond soon",
    support_problem:"DESCRIBE YOUR ISSUE",
    sending:"SENDING...",
    sent:"SENT",
    send_btn:"SEND",
    error_send:"Send error. Try later.",
    error_conn:"No connection. Check internet.",
    error_conn2:"No connection. Try later.",
    language_title2:"LANGUAGE",
    settings_title:"SETTINGS",
    current_lang:"✓ CURRENT",
    sport_title2:"SPORTS",
    sport_cat:"SPORT",
    record_btn:"RECORDED",
    sport_full_record:"Full log in Workouts → ⚽ Sport",
    score_optional:"Score, partners, feelings...",
    score_example:"E.g. 3:2 or 21:18",
    sport_planned:"📤 SHARE",
    no_activities:"No activities",
    ai_training:"AI COACH",
    greeting_back:"HEY,",
    greeting_back2:"WELCOME BACK",
    greet_away:["WELCOME BACK","LONG TIME NO SEE","GOOD TO SEE YOU","LET'S START FRESH"],
    greet_streak:["YOU'RE ON FIRE","STREAK ALIVE","KEEPING IT UP","THAT'S DISCIPLINE"],
    greet_today:["DONE FOR TODAY","GREAT WORK","MISSION COMPLETE","WELL DONE"],
    greet_normal:["HEY","GOOD TO SEE YOU","LET'S GO","READY TO WORK"],
    home_load_error:"Could not load. Check your connection.", retry:"RETRY",
    home_k_profile:"Profile needed", home_k_resume:"Unfinished", home_k_planned:"Planned for today", home_k_suggest:"Coach suggests",
    home_days_streak:"day streak", home_of:"of", home_this_week:"this week", home_sport:"sport",
    home_min:"min", home_exercises:"exercises", home_other_option:"Other option",
    home_food:"Food", home_burned:"Burned", home_weight:"Weight", home_kg:"kg",
    home_photo_food:"Photo food", home_ask_coach:"Ask coach", home_services:"Services",
    prog_this_week:"THIS WEEK", week_gym:"gym", week_sport:"sport", prefill_from:"from workout",
    consent_intro:"The app collects training, nutrition and health data, including conditions and allergies, and shares it with the AI coach. Available from age 18.",
    consent_checkbox:"I consent to processing of my personal data, including health data",
    consent_record:"DATA PROCESSING CONSENT", consent_ver:"version", age_too_young:"The app is available from age 18.",
    consent_give:"give",
    ai_consent_btn:"GO TO PROFILE",
    ai_consent_needed:"Coach unavailable: consent for data transfer to the AI service was withdrawn. You can restore it in your profile, in the consents section.",
    consent_i_terms:"I am 18+ and accept the terms of use", consent_i_terms_h:"I decide on loads, nutrition and supplements myself, considering my health. AI answers are not medical prescriptions.",
    consent_i_basic:"Processing of account and training data", consent_i_basic_h:"Profile, logs, goals and statistics. Stored on servers abroad.",
    consent_i_health:"Processing of health data", consent_i_health_h:"Conditions, allergies, medications, illnesses. Without this, limitations will not be taken into account.",
    consent_i_ai:"Transfer of data to an AI service in the USA", consent_i_ai_h:"Profile, history and medical limitations are sent to Anthropic on every coach request. Without this, the AI coach and food recognition are unavailable.",
    consent_required_note:"* required for the app to work. The others can be withdrawn in your profile at any time.",
    consent_no_ai_note:"Without this consent the AI coach and photo food recognition will not work.",
    consent_not_given:"not given", consent_withdraw:"withdraw", consent_req_note:"required",
    consent_wd_ai_confirm:"Withdraw consent for data transfer? The AI coach and food recognition will stop working.",
    consent_wd_health_confirm:"Withdraw consent for health data? Conditions, allergies and medications will be deleted from your profile.",
    mydata_title:"MY DATA", mydata_export:"Export my data", mydata_delete:"Delete account and all data",
    consent_gate_kicker:"BEFORE YOU CONTINUE", consent_gate_title:"DATA PROCESSING CONSENT", consent_gate_btn:"I AGREE",
    mydata_export_err:"Could not export data.", mydata_del_err:"Could not delete account.",
    mydata_del_confirm1:"Delete account? All workouts, measurements, nutrition and history will be erased. This cannot be undone.",
    mydata_del_confirm2:"Type DELETE to confirm", mydata_del_done:"Account and all data deleted.",
    rpe_question:"HOW WAS THAT SET?", rpe_easy:"Easy", rpe_ok:"OK", rpe_hard:"Hard", rpe_max:"Limit",
    home_close_workout:"Close workout", home_close_confirm:"Close the unfinished workout? Logged sets will be kept.", home_checkin_due:"check-in due",
    more_profile:"PROFILE", more_training:"TRAINING", more_health:"HEALTH", more_catalog:"CATALOG",
    more_edit_profile:"Details and parameters", more_training_prefs:"Frequency and split",
    more_achievements:"Achievements", more_leaderboard:"Leaderboard",
    alt_kicker:"REPLACE", alt_title:"OTHER OPTION", alt_repeat_last:"Repeat last one",
    alt_build_own:"Build my own", alt_available:"AVAILABLE", alt_recent:"RECENTLY TRAINED",
    alt_never:"not trained yet", alt_rest:"rested", alt_days:"d.",
    alt_confirm_repeat:"Repeat anyway?", alt_split:"Split", alt_change:"change", alt_no_last:"No finished workouts to repeat yet.",
    prefs_kicker:"TRAINING PLAN", prefs_title:"FREQUENCY AND SPLIT",
    prefs_freq:"STRENGTH SESSIONS PER WEEK", prefs_freq_hint:"Sport is counted separately, not in this quota.",
    prefs_split:"SPLIT SYSTEM", prefs_split_hint:"Auto — the coach picks groups by recovery.",
    prefs_days_in_cycle:"days in cycle", prefs_saving:"Saving...", prefs_saved:"Saved",
    streak_day1:"DAY",
    streak_day24:"DAYS",
    streak_days5:"DAYS",
    streak_podryad:"IN A ROW",
    ai_today:"AI today",
    checkin_card_hint:"Fill in once a week — Sunday evening or Monday morning.",
    checkin_card_hint2:"uses your check-in when building plans, answers and advice.",
    level_below:"Below beg.",
    level_elite:"Elite",
    norm_beg:"Beg",
    norm_mid:"Int",
    norm_adv:"Adv",
    norm_elite:"Elite",
    age_suffix:"y",
    coef_label:"coef.",
    sleep_label2:"Sleep",
    supp_timing_anytime:"At any time daily",
    supp_timing_food:"With food",
    supp_timing_food_sleep:"With food or before sleep",
    supp_timing_before:"30–45 min before workout",
    supp_timing_morning:"Morning with fatty food",
    supp_timing_sleep:"Before sleep",
    supp_timing_collagen:"1 hour before workout with vitamin C",
    supp_protein:"Protein",
    supp_creatine:"Creatine Monohydrate",
    supp_omega:"Omega-3",
    supp_vitd:"Vitamin D3",
    supp_magnesium:"Magnesium",
    supp_bcaa:"BCAA",
    supp_zinc:"Zinc",
    supp_vitc:"Vitamin C",
    supp_multi:"Multivitamins",
    supp_glutamine:"Glutamine",
    supp_collagen:"Collagen",
    supp_melatonin:"Melatonin",
    supp_caffeine:"Caffeine",
    supp_beta:"Beta-Alanine",
    supp_preworkout:"Pre-workout",
    add30s:"+30 sec",
    minus15s:"−15 sec",
    rest_5_10:"5–10 min",
    sets_short2:"sets",
    reps_short2:"REPS",
    pts_short:"pts.",
    pts_label:"points",
    kcal_short:"kcal",
    kcal_100g:"kcal/100g",
    volume_short:"volume (kg×reps)",
    workouts_week:"workouts per week",
    one_session2:"1 session",
    max_w:"MAX WEIGHT",
    dist_short:"DIST. (KM)",
    field_waist:"Waist",
    field_hips:"Hips",
    field_chest:"Chest",
    field_arm:"Arm (bicep)",
    field_thigh:"Thigh",
    field_age:"Age",
    field_age_y:"Age (years)",
    field_weight_kg:"Weight (kg)",field_weight_g:"WEIGHT (g)",
    field_height_cm:"Height (cm)",
    step_1_2:"STEP 1 / 2",
    step_2_2:"STEP 2 / 2",
    step_1_4b:"STEP 1 / 4",
    step_2_4b:"STEP 2 / 4",
    step_3_4b:"STEP 3 / 4",
    step_4_4b:"STEP 4 / 4",
    plan_s1:"PLANNING · STEP 1",
    plan_s2:"PLANNING · STEP 2",
    plan_s3:"PLANNING · STEP 3",
    sel_group_hint:"Select one or more groups",
    next_datetime:"NEXT → DATE & TIME",
    choose_replacement:"CHOOSE REPLACEMENT",
    warmup_exec_hint:"Complete warm-up before main workout",
    edit_btn:"EDIT",
    edit_arrow:"EDIT →",
    profile_section:"PROFILE",
    language_section:"LANGUAGE",
    score_section:"SCORE",
    notes_section:"NOTES",
    cancel_btn2:"CANCEL",
    delete_btn:"DELETE",
    error_label2:"ERROR",
    failed_load2:"FAILED TO LOAD",
    points_short:"SETS",
    order_section:"ORDER",
    meal_section:"MEAL",
    allergy_section:"ALLERGIES",
    archive_section:"ARCHIVE",
    goal_section:"GOAL",
    status_section:"STATUS",
    level_section:"LEVEL",
    calories_section:"CALORIES",
    exercises_section:"EXERCISES",
    volume_section:"VOLUME",
    tonnage_section:"TONNAGE",
    time_min_section:"TIME (MIN)",
    name_section:"NAME",
    name_opt_section:"NAME (OPTIONAL)",
    food_catalog_section:"FOOD CATALOG",
    food_ref_section:"FOOD REFERENCE",
    new_product_section:"NEW PRODUCT (per 100g)",
    add_product_btn:"ADD PRODUCT",
    add_photo_btn:"ADD PHOTO",
    add_exercise_btn:"ADD EXERCISE",
    my_exercise_section:"CUSTOM EXERCISE",
    when_take_section:"WHEN TO TAKE",
    photo_kbju_title2:"PHOTO → CALORIES",
    ai_trainer_title:"AI COACH",
    ai_trainer_online:"COACH ONLINE",
    analyzing_photo2:"AI ANALYZING PHOTO...",
    workout_still_active:"⚠️ WORKOUT STILL IN PROGRESS",
    record_sport:"⚽ LOG ACTIVITY",
    edit_date_plan:"✏ EDIT DATE/EXERCISES",
    edit_profile_btn2:"✏ EDIT PROFILE",
    added_done:"✓ ADDED",
    warmup_done2:"✓ WARM-UP DONE",
    save_confirm:"✓ SAVE",
    workout_saved_tab:"✓ WORKOUT SAVED → Scheduled tab",
    calories_food:"🍽 CALORIES (FOOD)",
    warmup_badge3:"🏃 WARM-UP",
    when_workout2:"📅 WHEN IS THE WORKOUT?",
    share_btn2:"📤 SHARE",
    other_photo2:"📷 Other",
    analyze_btn2:"🔍 ANALYZE",
    bot_reminds2:"🔔 Bot reminds",
    burned_sport:"🔥 BURNED (SPORT)",
    water_tap_hint:"← tap to log a glass of water",
    replace_exercise2:"↔ REPLACE EXERCISE",
    do_replace2:"↔ REPLACE",
    plateau_schedule:"Plateau detector runs every Sunday at 10:30.",
    bot_1h:"Bot reminds 1 hour before",
    bot_1h_full:"Bot reminds 1 hour before workout",
    continue_workout3:"CONTINUE WORKOUT",
    skip_warmup2:"SKIP WARM-UP",
    warmup_rec_time:"RECOMMENDED WARM-UP TIME",
    no_allergies2:"No allergies",
    no_conditions2:"No contraindications",
    not_specified3:"Not specified",
    measurements_hint:"Measurements are saved in history — track your progress",
    ai_trainer_hint:"AI coach will tailor advice to your goal",
    goal_hint:"WHAT IS YOUR GOAL?",
    name_hint2:"HI! WHAT IS YOUR NAME?",
    requests_left:"REQUESTS LEFT ·",
    or_write:"or type",
    pts_per:"before workout.",
    pts_bonus:"+8 points",
    no_data_short:"no data",
    day_30:"30 days",
    day_60:"60 days",
    day_90:"90 days",
    day_180:"180 days",
    hour_1:"1 hour",
    ai_chat_title:"CHAT WITH COACH",
    ai_clear:"🗑 CLEAR",
    ai_coach_label:"🤖 COACH",
    ai_thinking2:"COACH THINKING...",
    ai_analyzing:"ANALYZING WORKOUT...",
    ai_review_title:"AI COACH REVIEW",
    ai_coach_advice:"💬 COACH ADVICE",
    ai_proposes:"💪 AI SUGGESTS WORKOUT",
    ai_save_plan:"📅 SAVE TO SCHEDULE",
    ai_date_hint:"Choose date and time before saving",
    ai_saved:"✓ WORKOUT SAVED → Scheduled tab",
    open_schedule:"OPEN SCHEDULE →",
    continue_dialog:"+ CONTINUE",
    quick_questions:"QUICK QUESTIONS",
    voice_hint:"🎙 VOICE · OR TYPE",
    voice_full_hint:"🎙 PRESS TO RECORD · OR TYPE",
    recognizing:"RECOGNIZING...",
    no_mic:"No microphone access",
    no_audio:"No audio data",
    speech_not_recognized:"Speech not recognized",
    transcription_error:"Transcription error",
    progress_title2:"MY PROGRESS",
    weekly_activity:"WEEKLY ACTIVITY",
    workouts_per_week:"workouts per week",
    muscle_progress:"PROGRESS BY MUSCLE GROUP",
    strength_norms:"YOUR STRENGTH VS NORMS",
    no_data_period:"No data for selected period",
    need_2_workouts:"Need ≥2 workouts for chart",
    max_weight:"MAX WEIGHT",
    volume_unit:"volume (kg×reps)",
    sessions_count:"sessions",
    one_session:"session",
    weight_dynamics:"WEIGHT DYNAMICS",
    timer_title:"REST TIMER",
    tools_title:"TOOLS",
    rest_done:"✓ REST COMPLETE",
    rest_label:"REST",
    choose_time:"CHOOSE TIME",
    pause_btn:"⏸ PAUSE",
    start_btn2:"▶ START",
    add30:"+30 sec",
    minus15:"−15 sec",
    reset_btn2:"RESET",
    supps_title2:"SUPPLEMENTS",
    supps_cat:"SPORTS SUPPLEMENTS",
    supps_ref:"REFERENCE",
    supp_dose_label:"DOSAGE",
    supp_when:"WHEN TO TAKE",
    supp_sources:"SOURCES",
    supp_desc:"DESCRIPTION & TIPS",
    supp_warning:"⚠️ Supplements are advisory, not medical advice.",
    food_guide_cat:"REFERENCE",
    food_guide_title2:"FOOD CATALOG",
    food_when:"⏰ WHEN TO EAT",
    food_tips:"💡 TIPS",
    food_best:"🏆 BEST PRODUCTS",
    food_combines:"✅ COMBINES WITH",
    food_avoid:"❌ DO NOT COMBINE",
    error_server:"Server error",
    error_save:"Save error",
    error_net:"Network error",
    error_request:"Request error",
    error_launch:"Launch error",
    error_load:"Load error",
    error_try_again:"Error. Try again.",
    open_telegram:"Open via Telegram.",
    failed_load:"Failed to load",
    failed_recognize:"Failed to recognize. Try another photo.",
    food_limit_reached:"You've used today's photo recognitions ({limit} a day). Try again tomorrow, or add the meal manually for now.",
    food_quota_left:"Recognitions left today: {left} of {limit}",
    limit_exceeded:"Daily limit reached. Try tomorrow.",ai_unavailable:"The AI coach is temporarily unavailable. Try again a bit later — your request limit wasn't used.",last_time:"Last time",day_today_l:"today",day_yesterday:"yesterday",days_ago_n:"{n} days ago",set_save_failed:"Set not saved — check your connection and tap again",sq_dropped:"{n} set(s) not saved — the workout is already closed on the server",sq_waiting:"⏳ Waiting to send: {n}. They will go as soon as you are online",sq_finish_pending:"{n} set(s) not sent yet. Finish now? They will be sent later but won't count in this workout's summary.",
    specify_name:"Enter name",
    specify_name_cal:"Enter name and calories",
    delete_confirm:"Delete activity?",
    no_answer:"No answer",
    another_one:"ONE MORE",
    going_in:"LOADING...",
    exercises_none:"No exercises selected",
    exercises_none_planned:"No exercises were planned",
    my_workout_name:"My workout",
    workout_name_opt:"NAME (OPTIONAL)",
    workout_status_active:"⚠️ WORKOUT STILL IN PROGRESS",
    scheduled_workout:"SCHEDULED WORKOUT",
    scheduled_done:"SCHEDULED",
    my_workouts_title:"MY WORKOUTS",
    schedule_label:"SCHEDULE",
    upcoming_label:"UPCOMING",
    archive_planned:"PLANNED ARCHIVE",
    search_exercise:"Search exercise...",
    search_placeholder2:"Search...",
    name_label:"NAME",
    name_req:"Name *",
    exercise_group:"Muscle group",
    sets_num:"Sets",
    reps_num:"Reps",
    all_btn:"ALL",
    knowledge_base:"KNOWLEDGE BASE",
    save_measurements2:"SAVE MEASUREMENTS",
    saving:"SAVING...",
    saving2:"SAVING...",
    saved2:"✓ SAVED",
    when_workout:"📅 WHEN IS THE WORKOUT?",
    share_btn:"📤 SHARE",
    other_photo:"📷 Other",
    warmup_badge2:"🏃 WARM-UP",
    notifications_hint:"🔔 Bot reminds 1 hour before workout.",
    not_found_hint:"Nothing found",
    enter_name_or_cat:"ENTER NAME OR SELECT CATEGORY",
    calories_eaten:"🍽 CALORIES (FOOD)",
    calories_burned2:"🔥 BURNED (SPORT)",
    trainer_bot:"Bot will remind 1 hour before",
    trainer_bot2:"Bot reminds 1 hour before workout",
    conflict_time:"choose another time?",
    dist_km:"DIST. (KM)",
    imt_label:"BMI",
    workout_done2:"Workout complete",
    workout_type:"Workout",
    sets_short:"sets",
    reps_done:"done",
    rpe_label:"RPE",
    warmup_duration:"5–10 min",
    add_time30:"+30 sec",
    minus_time15:"−15 sec",
    no_sets_data:"no data",
    one_portion:"1 serving",
    portions_pack:"servings per pack",
    // ── Добавлено 05.10.2026: тексты, которых не было в словаре вовсе.
    // Раньше они стояли литералами прямо в разметке и показывались
    // по-русски при любом языке приложения.
    // Активная тренировка
    aw_badminton:"🏸 Badminton",
    aw_ballov_za_seriyu:"points per streak",
    aw_basketbol:"🏀 Basketball",
    aw_beg:"🏃 Running",
    aw_boks:"🥊 Boxing",
    aw_bolshoy_tennis:"🎾 Tennis",
    aw_dney:"days",
    aw_dnya:"days",
    aw_dobavit_uprazhnenie:"Add exercise",
    aw_futbol:"⚽ Football",
    aw_gandbol:"🤾 Handball",
    aw_gornye_lyzhi:"⛷ Alpine skiing",
    aw_nastolnyy_tennis:"🏓 Table tennis",
    aw_padel:"🎾 Padel",
    aw_pilates:"🧘 Pilates",
    aw_plavanie:"🏊 Swimming",
    aw_skalolazanie:"🧗 Climbing",
    aw_sohranyaem:"⏳ SAVING...",
    aw_velosport:"🚴 Cycling",
    aw_voleybol:"🏐 Volleyball",
    aw_vyberi_zamenu:"— choose replacement",
    aw_vybrano:"SELECTED (",
    aw_yoga:"🧘 Yoga",
    aw_zagruzka:"Loading...",
    // Блок «плато» в прогрессе
    plateau_analiz:"ANALYSIS",
    // Гид по питанию
    fg_belok:"PROTEIN",
    // Голосовая запись
    voice_oshibka:"Error",
    // График недели: короткие названия спорта
    sps_badm:"badm.",
    sps_basket:"basket",
    sps_beg:"run",
    sps_boks:"boxing",
    sps_futbol:"football",
    sps_gandbol:"handball",
    sps_krossfit:"crossfit",
    sps_lyzhi:"ski",
    sps_n_tennis:"t.tennis",
    sps_padel:"padel",
    sps_pilates:"pilates",
    sps_plav:"swim",
    sps_skalolaz:"climb",
    sps_tennis:"tennis",
    sps_velo:"cycle",
    sps_voley:"volley",
    sps_yoga:"yoga",
    // График по группам мышц
    mgc_obem:"volume",
    // Достижения
    ach_esche_ne_otkryto:"NOT UNLOCKED (",
    ach_otkryto:"UNLOCKED (",
    // Единицы измерения
    u_carb:"C",
    u_fat:"F",
    u_g:"g",u_s:"s",
    u_prot:"P",
    // Журнал занятий спортом
    splog_svoe:"Custom",
    // Замеры тела
    meas_sm:"cm",
    // Запланированная тренировка
    pw_arhivnaya:"📋 ARCHIVED",
    pw_tolko_prosmotr:"VIEW ONLY",
    pw_uprazhneniya:"EXERCISES (",
    pw_vypolnena:"✓ COMPLETED",
    // Знакомство при первом входе
    onb_analiziruet_trenirovki_vesa_:"Analyzes workouts, weights, and reps — and tells you when it’s really time to increase the load",
    onb_atlet:"Athlete",
    onb_derzhit_motivaciyu:"Keeps you motivated",
    onb_dobro_pozhalovat:"WELCOME",
    onb_nachat:"START 🏋️",
    onb_nachat_znakomstvo:"GET STARTED →",
    onb_otvechaet_kak_zhivoy_trener:"Answers like a real coach",
    onb_pitanie_po_foto:"Nutrition from a photo",
    onb_serii_dney_dostizheniya_ches:"Streaks, achievements, honest feedback — no unnecessary sugarcoating",
    onb_sfotografiroval_edu_poluchil:"Snap your food — get calories and macros. No manual entry for every meal",
    onb_sprosi_chto_ugodno_pro:"Ask anything about training, recovery, or supplements — get a specific answer based on your data",
    onb_tvoy_lichnyy_ai_trener:"Your personal AI coach 🤖",
    onb_vidit_ves_tvoy_progress:"Sees all your progress",
    // История тренировок
    wh_nizkaya:"Low",
    wh_plan:"PLAN",
    wh_srednyaya:"Medium",
    wh_vysokaya:"High",
    wh_zavershena:"✓ COMPLETED",
    // Карточка тренировки
    wd_ph:"SET",
    // Лидерборд
    lb_ty:"(you)",
    // Мои добавки
    usup_dobavit:"+ ADD",
    usup_dobavit2:"✓ ADD",
    // Питание
    nut_belki:"Protein",
    nut_cel:"target",
    nut_g:"(g)",
    nut_isprav_nazvanie_sostav_kbzhu:"Edit the name/ingredients — calories and macros will recalculate automatically",
    nut_limit_ai_zaprosov_na:"⚠️ Today’s AI request limit reached",
    nut_ml:"ml",
    nut_naprimer_chto_mne_ne:"For example: what am I missing in my diet today? or how should I distribute protein?",
    nut_naprimer_risovaya_kasha_s:"For example: Rice porridge with milk, 300g",
    nut_oshibka:"error",
    nut_pereschitat_i_sohranit:"🔄 RECALC & SAVE",
    nut_pitanie:"NUTRITION",
    nut_zhiry:"Fats",
    // Поиск продукта
    fs_na:"for",
    fs_poisk:"SEARCH",
    fs_sportpit:"💊 Sports supps",
    fs_vse:"All",
    // Правка занятия спортом
    spedit_partnery_oschuscheniya:"Partners, how it felt...",
    spedit_schet:"Score",
    // Прогресс
    prog_cht:"Thu",
    prog_pn:"Mon",
    prog_pt:"Fri",
    prog_sb:"Sat",
    prog_seriya:"STREAK",
    prog_sr:"Wed",
    prog_trenirovok:"WORKOUTS",
    prog_vs:"Sun",
    prog_vt:"Tue",
    // Профиль
    prof_bally:"Points",
    prof_bro:"🤙 Bro",
    prof_ekspert:"🎓 Expert",
    prof_ekspert2:"Expert",
    prof_nastavnik:"🧑‍🏫 Mentor",
    prof_nastavnik2:"Mentor",
    prof_profil_ne_nayden_snachala:"Profile not found. First register in @GYMASH_bot, then come back here.",
    prof_status:"Status",
    prof_stil_ai:"AI style",
    prof_uroven:"Level",
    // Профиль: аллергии
    alg_glyuten:"🌾 Gluten",
    alg_laktoza:"🥛 Lactose",
    alg_orehi:"🥜 Nuts",
    alg_rybiy_zhir:"🐟 Fish oil",
    alg_soya:"🫘 Soy",
    alg_yayca:"🥚 Eggs",
    // Профиль: ограничения по здоровью
    med_bol_v_spine:"🔙 Back pain",
    med_diabet:"💉 Diabetes",
    med_gipertoniya:"🩺 Hypertension",
    med_gryzha:"⚠️ Hernia",
    med_plecho_rotator:"💪 Shoulder/rotator",
    med_pochki:"🫘 Kidneys",
    med_pozvonochnik:"🦴 Spine",
    med_serdce_sosudy:"❤️ Heart/vessels",
    med_travma_kolena:"🦵 Knee injury",
    // Профиль: уровень подготовки
    lvl_novichok:"Beginner",
    // Распознавание еды по фото
    fv_blyudo:"Dish",
    fv_gotovo:"✅ DONE",
    fv_ispravit:"✏️ EDIT",
    fv_naprimer_risovaya_kasha_s:"For example: Rice porridge with milk and honey, 300g",
    fv_ne_udalos_pereschitat_poprob:"Couldn’t recalculate. Try describing it differently.",
    fv_neizvestnaya_oshibka:"unknown error",
    fv_nizkaya:"❓ Low",
    fv_otmena:"Cancel",
    fv_perekadrirovat:"🔄 Reframe",
    fv_pereschitat:"🔄 RECALCULATE",
    fv_pereschityvaem:"RECALCULATING...",
    fv_povtorit_sohranenie:"🔄 RETRY SAVE",
    fv_povtoryaem:"RETRYING...",
    fv_srednyaya:"⚠️ Medium",
    fv_vysokaya:"✅ High",
    // Рефералы
    ref_kopirovat:"📋 COPY",
    ref_moi_referaly:"MY REFERRALS (",
    ref_skopirovano:"✓ COPIED",
    // Сбор тренировки
    plan_dobavit_v_trenirovku:"+ ADD TO WORKOUT",
    plan_ubrat_iz_trenirovki:"✓ REMOVE FROM WORKOUT",
    plan_vybrano:"SELECTED",
    plan_zaplanirovat:"📅 SCHEDULE",
    // Своё блюдо (форма)
    fcat_frukty:"🍎 Fruit",
    fcat_hleb:"🍞 Bread",
    fcat_krupy:"🌾 Grains",
    fcat_molochka:"🥛 Dairy",
    fcat_myaso:"🥩 Meat",
    fcat_napitki:"🧃 Drinks",
    fcat_ovoschi:"🥦 Vegetables",
    fcat_prochee:"🫙 Other",
    fcat_ryba:"🐟 Fish",
    fcat_sneki:"🍫 Snacks",
    // Своё упражнение
    cex_moe:"Mine",
    // Серии и баллы
    gam_atlet:"🥈 Athlete",
    gam_chek_in:"✓ Check-in",
    gam_chempion:"🥇 Champion",
    gam_legenda:"💎 Legend",
    gam_pitanie_vneseno:"Nutrition logged",
    gam_tennis:"🎾 Tennis",
    gam_trenirovka_zavershena:"🏋️ Workout completed",
    gam_zanyatie_sportom:"Sports activity",
    // Справочник добавок
    sup_10g_den:"10g/day",
    sup_15_30mg_den:"15–30mg/day",
    sup_1_3g_epa_dha:"1–3g EPA+DHA/day",
    sup_2000_5000_me_den:"2000–5000 IU/day",
    sup_200_400mg:"200–400mg",
    sup_20_40g_za_priem:"20–40g per serving",
    sup_3_5g_den:"3–5g/day",
    sup_3_6mg_kg_vesa:"3–6mg/kg body weight",
    sup_bez_zagruzki_rezultat_cherez:"No loading phase. Results in 2–4 weeks. Take with water (250ml). One of the most studied supplements.",
    sup_immunitet_testosteron_kosti_:"Immunity, testosterone, bones. Take with K2 (100–200mcg) for proper calcium absorption.",
    sup_immunitet_testosteron_vossta:"Immunity, testosterone, recovery. Do not take with calcium — they compete for absorption.",
    sup_kachestvo_sna_myshechnoe_vos:"Sleep quality, muscle recovery, stress reduction. Form: glycinate or malate (not oxide — poorly absorbed).",
    sup_posle_trenirovki_ili_v:"After training or any time of day",
    sup_povyshaet_vynoslivost_silu_i:"Improves endurance, strength, and focus. Do not take after 15:00 — it disrupts sleep. Tolerance develops quickly.",
    sup_prokonsultiruysya_s_vrachom_:"⚠️ Consult a doctor — there are contraindications",
    sup_protivovospalitelnyy_effekt_:"Anti-inflammatory effect, joints, heart. Check EPA+DHA content, not total fish oil.",
    sup_sustavy_i_svyazki_neobhodim:"Joints and ligaments. Vitamin C (100mg) is needed for collagen synthesis. Cumulative effect — 8–12 weeks.",
    sup_umerennyy_uroven_dokazatelno:"🟡 Moderate evidence",
    sup_vospolnenie_belka_syvorotoch:"Protein supplementation. Whey is fast, casein is slow (before bed).",
    sup_vozmozhna_allergicheskaya_re:"🚫 Allergic reaction possible",
    sup_vysokiy_uroven_dokazatelnost:"🟢 High evidence",
    sup_your_weight:"(YOUR WEIGHT {w}KG)",
    // Цели
    goals_celi:"GOALS",
    // Экран тренера (AI)
    ai_ai_trenirovka:"AI workout",
    ai_chto_est_do_i:"What to eat before and after training",
    ai_oshibka_soedineniya:"Connection error —",
    ai_programma_dlya_pohudeniya_na:"One-month weight-loss program",
    ai_sostav_plan_trenirovki_na:"Create a one-week workout plan for muscle gain",
    ai_sprosi_chto_ugodno:"ASK ANYTHING...",
    ai_trenirovka_na_plechi_i:"Shoulder and arm workout",
    ai_plan_more:"+{n} more",
    err_save_failed:"Could not save: {err}",
    err_save_status:"Save error ({code})",
    err_server_retry:"Server error ({code}). Try again later.",
    plan_ex_groups:"EXERCISES ({n} GROUPS) →",
    plan_show_ex:"SHOW EXERCISES ({n} GROUPS) →",
    plan_time_taken:"There is already a workout “{title}” at {dt}. Choose another time?",
    prog_weight_range:"Weight chart: {a} to {b}",
    ref_step1:"Share the link with a friend",
    ref_step2:"Your friend signs up for GymBot",
    ref_step3:"You get {n} points",
    ref_step4:"Your friend gets a starting bonus",
    sup_per_pack:"{n} servings per pack",
    sup_tabs:"{a}mg ({b} tabs of 100mg)",
    u_dn:"d",
    u_km:"km",
    u_let:"years",
    u_povt:"reps",
    u_t:"t",
    // ── Батч 2 и 3, переводы получены 06.10.2026 ───────────────────────
    // Батч 2 — тексты из шаблонных строк, батч 3 — многострочные
    // текстовые узлы JSX: ни те, ни другие построчный поиск не находит.
    ui_1_porciya:"1 serving =",
    ui_ai_zaprosov_v_den:"AI requests per day:",
    ui_ball:"pts.)",
    ui_dobavit_svoe_uprazhnenie:"⭐ ADD CUSTOM EXERCISE",
    ui_dobavit_svoy_produkt:"＋ ADD CUSTOM FOOD",
    ui_izmenenie_za_3_nedeli:"Change over 3 weeks:",
    ui_kg_za_period:"kg for period",
    ui_limit_ai_zaprosov_na:"💬 Today’s AI request limit is reached — assessment will be available tomorrow",
    ui_napishi_pravilnoe_nazvanie_ili:"Enter the correct dish name or ingredients. Calories and macros will recalculate automatically.",
    ui_naydeno_v_kataloge:"⚠ Found in catalog:",
    ui_ne_prosto_spisok_uprazhneniy:"Not just a list of exercises — a coach that actually knows your history and adapts to you.",
    ui_ne_udalos_poluchit_ocenku:"Could not get the AI assessment — check your connection",
    ui_peremeschay_i_uvelichivay_chto:"Move and zoom so the whole dish fits",
    ui_podhod:"SET",
    ui_poka_nikto_ne_v:"No one is in the ranking yet. Train and earn points!",
    ui_polnaya_zapis_v_razdele:"↗ Full entry in Workouts → ⚽ Sports",
    ui_poprobuy_otkryt_cherez_telegra:"Try opening it through the Telegram bot.",
    ui_poprobuy_smenit_uprazhnenie_il:"💡 Try changing the exercise or adding a drop set — ask your coach",
    ui_posledniy_raz:"LAST TIME (",
    ui_primenenie_vitaminov_i_dobavok:"⚠️ Use of vitamins and supplements is for guidance only and is not medical advice. Consult a doctor before use.",
    ui_privet_treniruyus_v_gymbot:"Hi! I train with GymBot — a smart AI coach in Telegram. Join through my link and get bonus points",
    ui_referalnaya_programma_vremenno:"The referral program is temporarily unavailable",
    ui_seriya:"🔥 Streak:",
    ui_sleduyuschiy:"Next:",
    ui_taymer_avtomaticheski_zapuskae:"The timer starts automatically after each set during a workout.",
    ui_tochnost:"ACCURACY:",
    ui_trenirovka_ne_naydena_ili:"Workout not found or access denied.",
    ui_vybrano_grupp:"GROUPS SELECTED:",
    ui_zamenit:"REPLACE",
    ui_zdes_mozhno_ispolzovat_otdelno:"You can use it separately here.",
  },
  uz: {
    menu_nutrition:"Ovqatlanish", menu_workout:"Mashqlar", menu_progress:"Taraqqiyot",
    menu_catalog:"Katalog", menu_ai:"Murabbiy", menu_checkin:"Tekshiruv",
    menu_measurements:"Tana o'lchovlari", menu_goals:"Maqsadlar", menu_supplements:"Qo'shimchalar",
    menu_support:"Yordam", menu_language:"Til", menu_sport:"Sport turlari",
    menu_gamification:"Mening statusim", menu_food_guide:"Mahsulotlar katalogi",
    menu_referral:"Do'st taklif qilish", menu_photo_kbju:"Foto → Kaloriya",
    menu_rest_timer:"Dam olish taymer", menu_plan:"Rejalashtirish", menu_reminders:"Eslatmalar",
    menu_tab_menu:"Menyu", menu_tab_workout:"Mashqlar", menu_tab_progress:"Taraqqiyot",
    menu_tab_catalog:"Katalog", menu_tab_ai:"Murabbiy",
    section_quick:"TEZKOR KIRISH", section_catalog:"KATALOG", section_profile:"PROFIL",
    start_workout:"▶ MASHQNI BOSHLASH", back:"← ORQAGA",
    today:"BUGUN", loading:"YUKLANMOQDA", save:"SAQLASH", cancel:"BEKOR QILISH",
    add:"QO'SHISH", edit:"O'ZGARTIRISH", delete:"O'CHIRISH", close:"YOPISH",
    save_profile:"SAQLASH", cancel_btn:"BEKOR QILISH", edit_profile:"PROFILNI TAHRIRLASH",
    edit_profile_btn:"O'ZGARTIRISH →", profile_title:"MENING PROFILIM",
    my_profile:"MENING PROFILIM", not_specified:"Ko'rsatilmagan", allergies:"ALLERGIYALAR",
    level:"DARAJA", goal_label:"MAQSAD", no_conditions:"Cheklovlar yo'q",
    no_allergies:"Allergiya yo'q", reset_btn:"TOZALASH", status_label:"STATUS",
    fitness_level_label:"TAYYORGARLIK DARAJASI", my_rating:"MENING REYTINGIM",
    points_label:"BALLLAR", rank_label:"DARAJA",
    plateau_title:"PLATO DETEKTORI", plateau_weight:"Vazn o'zgarmayapti",
    plateau_exercise:"Qotib qolgan mashqlar", plateau_none:"Plato aniqlanmadi",
    referral_title:"DO'ST TAKLIF QILISH", referral_your_code:"Sizning kodingiz",
    referral_link:"Referal havola", referral_friends:"Taklif qilingan do'stlar",
    referral_bonus:"Taklif uchun balllar",
    workout_title:"MASHQLAR", workouts_title:"MASHQLAR",
    no_workouts:"Hali mashqlar yo'q", no_workouts_yet:"Hali mashqlar yo'q",
    tonnage_label:"TONNAJ", no_sport_yet:"Hali mashg'ulotlar yo'q",
    planned_tab:"📅 REJA", sport_tab:"⚽ SPORT", archive_tab:"📋 ARXIV",
    no_planned:"Rejalashtirilgan mashqlar yo'q", planned_archive:"REJALASHTIRILGAN ARXIV",
    nutrition_title:"KUNDALIK", add_meal:"+ qo'shish",
    water_label:"💧 SUV", glasses_unit:"stakan",
    ask_trainer:"Ovqatlanish haqida murabbiydan so'rash",
    meal_breakfast:"Nonushta", meal_lunch:"Tushlik", meal_dinner:"Kechki ovqat", meal_snack:"Gazak",
    progress_title:"TARAQQIYOT", catalog_title:"MASHQLAR", ai_title:"MURABBIY",
    food_search_title:"KATALOG", food_search_placeholder:"Mahsulot qidirish...",
    add_to_diary:"KUNDALIKKA QO'SHISH", weight_label:"OG'IRLIK (g)",
    sport_record:"MASHG'ULOT YOZISH", sport_duration:"DAVOMIYLIGI (DAQIQA)",
    sport_intensity:"INTENSIVLIK", sport_date:"SANA", sport_notes:"IZOHLAR",
    sport_type_label:"SPORT TURI", sport_notes_opt:"IZOHLAR (IXTIYORIY)",
    sport_saved:"YOZILDI", sport_save_btn:"✓ MASHG'ULOTNI YOZ",
    score_opt:"NATIJA (IXTIYORIY)", score_label:"NATIJA",
    intensity_low:"🟢 Past", intensity_medium:"🟡 O'rta", intensity_high:"🔴 Yuqori",
    time_label:"VAQT", intensity_label:"INTENSIVLIK", calories_label:"KALORIYA",
    archive_label:"ARXIV",
    choose_type:"NIMA QILAMIZ?", choose_type_label:"TURNI TANLANG",
    gym_title:"Sport zali", gym_desc:"Kuch mashqlari, mushak va mashq tanlash",
    sport_section:"Sport turlari", sport_desc:"Kaloriya hisobi bilan mashg'ulotni yozish",
    sport_section_title:"Sport turlari", sport_section_desc:"Kaloriya hisobi bilan mashg'ulotni yozish",
    resume_workout:"MASHQNI DAVOM ETTIRISH", resume_desc:"Tugallanmagan mashqingiz bor",
    workout_closed_elsewhere:"Oldingi mashq allaqachon yakunlangan — boshqa qurilmada yoki avtomatik. Yangisini boshlashingiz mumkin.",
    finish_workout:"TUGATISH", workout_empty_note:"Birorta ham yondashuv yozilmadi — mashg‘ulot hisobga olinmadi va tarixga tushmadi.", set_done:"✓ YONDASHUV BAJARILDI", set_done_label:"YONDASHUV BAJARILDI",
    premium_menu:"Premium", premium_kicker:"PREMIUM", premium_title:"GymBot Premium", premium_lead:"Murabbiyga ko'proq savol va ovqatni ko'proq aniqlash — hamda GymBot rivojini qo'llab-quvvatlash.", premium_active_until:"Premium {date} gacha faol", premium_trial_until:"Sinov Premium {date} gacha", premium_manual:"Premium faol", premium_perk_ai:"Kuniga {n} ta murabbiy savoli", premium_perk_food:"Kuniga {n} ta ovqat surati", premium_perk_now:"Premium'siz — {n}", premium_perk_support:"Yangi imkoniyatlar tezroq: siz ilova rivojini qo'llab-quvvatlaysiz", premium_month:"Oy", premium_year:"Yil", premium_month_note:"har 30 kunda yangilanadi, istalgan vaqtda o'chirish mumkin", premium_year_note:"365 kunga bir martalik to'lov", premium_save:"{n}% tejash", premium_buy:"{n} ⭐ ga olish", premium_extend:"{n} ⭐ ga uzaytirish", premium_trial_btn:"{n} kun bepul sinab ko'rish", premium_renews:"Obuna {date} da yangilanadi", premium_renew_off:"Avto-yangilash o'chirilgan — Premium {date} gacha", premium_cancel_btn:"Avto-yangilashni o'chirish", premium_resume_btn:"Avto-yangilashni yoqish", premium_paid_wait:"To'lov o'tdi — Premium yoqilmoqda…", premium_paid_ok:"Premium {date} gacha yoqildi. Rahmat!", premium_paid_late:"To'lov o'tdi. Premium bir necha daqiqada yoqiladi — bot xabar yuboradi.", premium_failed:"To'lov o'tmadi. Qaytadan urinib ko'ring.", premium_error:"To'lovni ochib bo'lmadi. Keyinroq urinib ko'ring.", premium_already_sub:"Obuna allaqachon rasmiylashtirilgan.", premium_note:"Telegram yulduzlari bilan to'lov. Avto-yangilashni shu yerda yoki Telegram'da o'chirish mumkin: Sozlamalar → Mening yulduzlarim. To'lov bo'yicha savollar — botda /paysupport buyrug'i.", premium_nudge_ai:"Premium bilan — kuniga {n} ta murabbiy savoli", premium_nudge_food:"Premium bilan — kuniga {n} ta ovqat surati", premium_nudge_btn:"Batafsil", share_kicker:"ULASHISH", share_story:"Hikoyaga", share_chat:"Chatga", share_preparing:"Kartochka tayyorlanmoqda…", share_sent_bot:"Kartochka bot bilan chatda — uni do'stlaringizga yuboring", share_error:"Kartochkani tayyorlab bo'lmadi. Qaytadan urinib ko'ring.",
    soc_menu:"Do'stlar va jamoalar", soc_kicker:"HAMJAMIYAT", soc_title:"Do'stlar va jamoalar", tab_feed:"Lenta", tab_friends:"Do'stlar", tab_teams:"Jamoalar", soc_invite_title:"Do'stlarni taklif qiling", soc_invite_hint:"Do'stlar bir-birining mashg'ulotlari va rekordlarini ko'radi va 👏 qo'yadi. Vazn, ovqatlanish va sog'liq hech qachon ko'rsatilmaydi.", soc_invite_btn:"Do'stni taklif qilish", soc_copy:"Havolani nusxalash", soc_copied:"Havola nusxalandi", soc_share_text:"GymBot'da birga shug'ullanamiz 💪", soc_privacy:"Mashg'ulotlarimni do'stlarga ko'rsatish", soc_friends_empty:"Hali do'stlar yo'q — taklif yuboring.", soc_week_n:"bu hafta {n} mashg'ulot", soc_remove:"O'chirish", soc_remove_confirm:"{name} do'stlardan o'chirilsinmi?", soc_feed_empty:"Bu yerda sizning va do'stlaringizning mashg'ulotlari bo'ladi.", soc_you:"Siz", soc_sets:"{n} yondashuv", soc_tonnage:"{n} t", soc_min:"{n} daq", soc_record:"Rekord: {ex} — {w} kg (avval {p})", soc_more:"Yana ko'rsatish", soc_accepted:"Siz endi {name} bilan do'stsiz", soc_already:"{name} allaqachon do'stingiz", soc_bad_code:"Havola eskirgan yoki noto'g'ri", soc_own_code:"Bu o'zingizning havolangiz 🙂", soc_teams_empty:"Hali jamoalar yo'q. O'zingiznikini yarating yoki kod orqali qo'shiling.", soc_team_create:"Jamoa yaratish", soc_team_name:"Jamoa nomi", soc_team_join:"Kod orqali qo'shilish", soc_team_code:"Jamoa kodi", soc_team_members:"{n} ishtirokchi", soc_team_week:"Bu hafta: {n} mashg'ulot", soc_team_place:"Sizning o'rningiz: {n}", soc_team_invite:"Jamoaga taklif qilish", soc_team_leave:"Jamoadan chiqish", soc_team_leave_confirm:"«{name}» jamoasidan chiqasizmi?", soc_team_rename:"Nomini o'zgartirish", soc_team_joined:"Siz «{name}» jamoasidasiz", soc_team_full:"Jamoada allaqachon 50 kishi bor", soc_too_many_teams:"Ko'pi bilan 5 ta jamoada bo'lish mumkin", soc_board_title:"HAFTA REYTINGI", soc_board_hint:"Dushanbadan beri tugatilgan mashg'ulotlar hisoblanadi", soc_last_week:"o'tgan: {n}", soc_owner:"egasi", soc_share_team_text:"GymBot'dagi «{name}» jamoamizga qo'shiling 💪", soc_remove_member:"Chiqarish", soc_remove_member_confirm:"{name} jamoadan chiqarilsinmi?",
    wn_kicker:"YANGILIKLAR", wn_kicker_new:"BILISH FOYDALI", wn_menu:"Yangiliklar", wn_skip:"O'tkazib yuborish", wn_next:"Keyingisi", wn_done:"Tayyor", wn_str_d:"Qanchalik kuchli ekaningizni bilib oling: har bir mashqda daraja — «{a}»dan «{b}»gacha.", wn_str_1:"Jins, tana vazni va yosh hisobga olinadi", wn_str_2:"GymBot'ning boshqa sportchilari bilan taqqoslash", wn_str_3:"Keyingi darajagacha qancha qo'shish kerakligi", wn_str_b:"Mening darajam", wn_food_t:"Palov, lag'mon, somsa", wn_food_d:"Ovqatlanish kundaligida mahalliy taomlar bor, taom surati ularni taniydi.", wn_food_1:"Kaloriya va BJU bilan 37 ta milliy taom", wn_food_2:"Yorliq skaneri: qadoqni suratga oling — KBJU o'zi to'ldiriladi", wn_food_3:"Nomlari rus, o'zbek va qozoq tillarida", wn_food_b:"Yorliqni skanerlash", wn_prog_d:"6–12 haftalik tayyor rejalar: har kuni nima qilish, nechta yondashuv va takror.", wn_prog_1:"Zal va uy uchun, yangi boshlovchilar va tajribalilar uchun", wn_prog_2:"Ilova keyingi kunni aytib beradi", wn_prog_3:"3 ta dastur — bepul", wn_prog_3_all:"Barcha dasturlar — bepul", wn_prog_b:"Dastur tanlash", wn_soc_d:"Birga shug'ullanish qiziqroq — va o'tkazib yuborish qiyinroq.", wn_soc_1:"Do'stlar mashg'ulotlari va rekordlari lentasi, harakat uchun 👏", wn_soc_2:"Haftalik mashg'ulotlar reytingi bilan jamoalar", wn_soc_3:"Do'stlar vazn, ovqatlanish va sog'liqni ko'rmaydi", wn_soc_b:"Do'stni chaqirish", wn_prem_d:"Jiddiy shug'ullanadiganlar uchun ko'proq imkoniyatlar.", wn_prem_1:"Kuniga {n} tagacha AI-murabbiyga savol", wn_prem_2:"Kuniga {n} tagacha ovqat surati", wn_prem_3:"Barcha mashg'ulot dasturlari; Telegram yulduzlari bilan to'lov", wn_prem_b:"Batafsil", wn_prem_trial:"{n} kun bepul sinab ko'rish",
    prog_menu:"Mashg'ulot dasturlari", prog_kicker:"DASTURLAR", prog_title:"Mashg'ulot dasturlari", prog_lead:"Bir necha haftalik tayyor rejalar: har kuni nima qilish, nechta yondashuv va takror.", prog_meta:"haftasiga {d} mashg'ulot · {w} hafta", prog_active:"SIZNING DASTURINGIZ", prog_progress:"{t} tadan {n}-mashg'ulot", prog_next:"Keyingisi: {day}", prog_start_day:"Boshlash: {day}", prog_start:"Dasturni boshlash", prog_replace_confirm:"Hozir «{cur}» davom etmoqda. Uning o'rniga yangi dasturni boshlaysizmi?", prog_stop:"Dasturni to'xtatish", prog_stop_confirm:"Dasturni to'xtatasizmi? Bajarilgan mashg'ulotlar tarixda qoladi.", prog_unlock:"Premium bilan ochish", prog_tip:"MASLAHAT", prog_days:"DASTUR KUNLARI", prog_rest_s:"dam {n} s", prog_rest_m:"dam {n} daq", prog_reps_max:"maks.", prog_sec:"s", prog_finished:"Dastur tugadi! Keyingisini tanlang.", prog_free:"Bepul", prog_week:"{n}-hafta", prog_not_in_catalog:"katalogda yo'q", prog_is_active:"Davom etmoqda", prog_all:"Barcha dasturlar", prog_open:"Ochish",
    fcat_national:"Milliy taomlar", label_scan_btn:"Yorliqni skanerlash", fv_mode_dish:"Taom", fv_mode_label:"Yorliq", label_kicker:"YORLIQ SKANERI", label_title:"Yorliq surati", label_hint:"Qadoqdagi ozuqaviy qiymat jadvalini suratga oling — 100 g dagi KBJU ni to'ldiramiz va mahsulotni ma'lumotnomaga saqlaymiz.", label_photo_btn:"Yorliqni suratga olish", label_read_btn:"Aniqlash", label_reading:"YORLIQ O'QILMOQDA…", label_not_found:"Suratda ozuqaviy qiymat jadvali ko'rinmayapti. Uni yaqinroq va to'g'riroq suratga oling.", label_failed:"Yorliqni o'qib bo'lmadi. Qaytadan urinib ko'ring.", label_name:"Nomi", label_brand:"Brend", label_per100:"100 g da", label_low_conf:"Raqamlarni tekshiring: ba'zilari noaniq o'qilgan bo'lishi mumkin.", label_portion:"Qancha yedingiz, g", label_pack_portion:"qadoqdagi porsiya", label_save_log:"Kundalikka yozish", label_save_only:"Faqat ma'lumotnomaga saqlash", label_saved_only:"Saqlandi — uni qidiruvda topish mumkin.", label_total:"{w} g uchun jami", food_portion_approx:"porsiya ~{n} g",
    str_e1rm:"taxminiy maksimum", str_menu:"Kuch darajalari", str_kicker:"KUCH", str_title:"Kuch darajalari", str_overall:"Umumiy daraja", str_stronger:"Shug'ullanuvchilarning ~{n}% idan kuchliroq", str_basis:"Jinsingiz, tana vazningiz va yoshingiz uchun kuch me'yorlari bo'yicha baho. Maksimum 12 tagacha takrorli eng yaxshi yondashuv bo'yicha hisoblanadi (Epli formulasi).", str_missing:"Darajalarni hisoblash uchun profilda jins va vazningizni kiriting.", str_btn_profile:"Profilni to'ldirish", str_to_next:"«{lvl}» darajasigacha: +{n} {u}", str_top:"Eng yuqori daraja — tabriklaymiz!", str_community:"GymBot foydalanuvchilari orasida: {m} kishidan {n}% idan kuchliroq", str_untracked:"Hali darajasiz", str_untracked_hint:"Ushbu mashqlardan birida yondashuv bajaring — daraja o'zi paydo bo'ladi.", str_all:"Barcha darajalar", str_from:"eng yaxshi yondashuv {w} kg × {r}", str_from_reps:"eng yaxshi yondashuv — {r} takror", str_reps:"takror", str_on:"{n} ta mashq bo'yicha", str_empty:"Asosiy mashqlarda hali yondashuvlar yo'q — ular bilan birinchi mashg'ulotdan keyin darajalar paydo bo'ladi.", str_lvl_start:"Start", str_lvl_beginner:"Yangi boshlovchi", str_lvl_novice:"Boshlang'ich", str_lvl_intermediate:"O'rta", str_lvl_advanced:"Ilg'or", str_lvl_elite:"Elita",
    terms_menu:"Foydalanish qoidalari", terms_kicker:"HUJJAT", terms_title:"Foydalanish qoidalari", terms_updated:"2026-yil 24-oktabr tahriri", terms_read:"Qoidalarni o'qish", terms_premium_link:"Premium shartlari, bekor qilish va qaytarish", terms_close:"Yopish", terms_s_general_t:"1. Umumiy qoidalar", terms_s_general_b:"GymBot — Telegram'dagi AI-murabbiyli mashg'ulot va ovqatlanish kundaligi. Undan 18 yoshdan foydalanish mumkin.\n\nAI-murabbiy maslahatlari, surat bo'yicha kaloriya bahosi va yuklama tavsiyalari ma'lumot uchun bo'lib, tibbiy tayinlov emas. Mashg'ulot, ovqatlanish va qo'shimchalar bo'yicha qarorni sog'lig'ingizni hisobga olib o'zingiz qabul qilasiz. Kasallik yoki qarshi ko'rsatmalar bo'lsa, shifokor bilan maslahatlashing.\n\nIlovadan spam, haqorat va boshqalarning ma'lumotlari uchun foydalanish mumkin emas. Buning uchun kirishni cheklashimiz mumkin.", terms_s_data_t:"2. Ma'lumotlar", terms_s_data_b:"Qanday ma'lumotlar yig'ilishi va kimga uzatilishi roziliklarda yozilgan. Ularni profilda ko'rish mumkin; sog'liq haqidagi ma'lumotlar va AI-xizmatga uzatish bo'yicha roziliklarni istalgan vaqtda qaytarib olish mumkin.", terms_s_prem_t:"3. Premium", terms_p_what:"Premium — ilovaning pullik qismi: kuniga AI-murabbiyga ko'proq savol va ovqatni surat bo'yicha ko'proq aniqlash, shuningdek Premium ekranida sanab o'tilgan boshqa imkoniyatlar. Joriy limitlar o'sha yerda ko'rsatilgan. Premium tarkibi kengayishi mumkin.", terms_p_pay:"To'lov — faqat Telegram yulduzlari (Telegram Stars) bilan, Telegram ichida. Hozir oy {pm} ⭐, yil — {py} ⭐ turadi. Narx o'zgarsa, allaqachon to'langan davr qayta hisoblanmaydi.", terms_p_pay_np:"To'lov — faqat Telegram yulduzlari (Telegram Stars) bilan, Telegram ichida. Joriy narxlar Premium ekranida ko'rsatilgan. Narx o'zgarsa, allaqachon to'langan davr qayta hisoblanmaydi.", terms_p_month:"Oy — bu obuna: har 30 kunda Telegram siz bekor qilmaguningizcha xuddi shu summani avtomatik yechadi. Istalgan vaqtda bekor qilish mumkin — Premium ekranida «Avto-yangilashni o'chirish» tugmasi bilan yoki Telegram'da: Sozlamalar → Mening yulduzlarim. Bekor qilingandan keyin Premium to'langan davr oxirigacha ishlaydi, yangi yechimlar bo'lmaydi.", terms_p_year:"Yil — 365 kunga bir martalik to'lov, avto-yangilashsiz. Agar bunda oylik obunangiz amalda bo'lsa, yulduzlar ikki marta yechilmasligi uchun uni o'chiramiz.", terms_p_trial:"Sinov davri — {n} kun bepul, har bir akkaunt uchun bir marta. U o'zi uzaytirilmaydi va hech narsa yechmaydi.", terms_p_refund:"Qaytarish. Agar yulduzlar yechilgan, lekin Premium yoqilmagan bo'lsa yoki yechim xato yoxud ikki marta bo'lgan bo'lsa — botda /paysupport buyrug'i bilan qo'llab-quvvatlashga yozing va to'lov sanasini ko'rsating. Qaytarishda yulduzlar Telegram hisobingizga qaytadi, bu to'lov uchun Premium kunlari to'liq olib tashlanadi. Foydalanilgan vaqt uchun qaytarish alohida ko'rib chiqiladi.", terms_p_account:"Premium Telegram akkauntingizga bog'langan va boshqa odamlarga o'tkazilmaydi.", terms_s_support_t:"4. Qo'llab-quvvatlash", terms_s_support_b:"Savol va shikoyatlar — ilovaning «Qo'llab-quvvatlash» bo'limida, to'lov bo'yicha savollar — botda /paysupport buyrug'i bilan. Bot bilan chatda javob beramiz.\n\nQoidalar o'zgarishi mumkin. Muhim o'zgarishlar haqida botda xabar beramiz.",
    warmup_title:"ISITISH", warmup_skip:"O'TKAZIB YUBORISH", warmup_done:"✓ ISITISH BAJARILDI",
    warmup_hint:"Isitish uchun kardio — ixtiyoriy", warmup_badge:"🏃 ISITISH",
    ready_wk_kicker:"MASHG'ULOT TAYYOR", ready_wk_hint:"Tarkib mashg'ulot tarixingiz asosida tanlandi", ready_wk_program:"Tarkib — dasturingizdan", ready_wk_change:"Tarkibni o'zgartirish",
    rest_notify_title:"Dam olish signali", rest_notify_hint:"Dam olish tugaganda bot xabar yuboradi. Telefonni cho'ntakka soling — soat tebranadi.", rest_notify_on:"Yoqilgan", rest_notify_off:"O'chirilgan",
    rest_offer_kicker:"MASLAHAT", rest_offer_title:"Mashg'ulot paytida telefonni olib qo'yasizmi?", rest_offer_text:"Bot dam olish tugaganini o'zi bildiradi. Telefonni ushlab turish shart emas — soat yoki bilaguzuk tebranadi.", rest_offer_yes:"Yoqish", rest_offer_no:"Kerak emas",
    order_title:"TARTIB", order_hint:"↑↓ — qayta joylashtirish · ↔ — almashtirish",
    muscles_title:"MUSHAK GURUHLARI", exercises_title:"MASHQLAR", replace_title:"ALMASHTIRISH", show_all_exercises:"BARCHA MASHQLARNI KO'RSATISH",
    select_groups_hint:"Bir yoki bir nechta guruh tanlang → mashqlarni ko'rsatamiz",
    step_1_4:"QADAM 1 / 4", step_2_4:"QADAM 2 / 4", step_3_4:"QADAM 3 / 4", step_4_4:"QADAM 4 / 4",
    weight_kg:"OG'IRLIK (KG)", reps_label:"MARTA", time_sec:"VAQT (SEK)",
    distance_km:"MASOFA (KM)", prev_btn:"← OLDINGI", next_btn:"KEYINGI →",
    workout_done:"MASHQ YAKUNLANDI", workout_complete:"MASHQ YAKUNLANDI",
    great_work:"Zo'r ish!", analyzing:"MASHQ TAHLIL QILINMOQDA...",
    workout_sets:"MASHQ TARKIBI", no_sets:"Yondashuv yozuvlari yo'q", reps_short:"MARTA",
    error_label:"XATO", load_error:"YUKLAB BO'LMADI",
    water_hint:"← bir stakan suv belgisi uchun bosing",
    ai_thinking:"TAHLIL QILMOQDA...", ai_ask:"MURABBIYDAN SO'RASH", ai_limit:"⚠️ AI so'rovlar limiti tugadi",
    goal_health:"Salomatlik",
    goal_lose:"Vazn yo'qotish",
    goal_muscle:"Mushak o'stirish",
    goal_strength:"Kuch",
    goal_endurance:"Chidamlilik",
    level_beginner:"Boshlang'ich",
    level_intermediate:"O'rta",
    level_advanced:"Ilg'or",
    difficulty_easy:"Oson",
    difficulty_medium:"O'rta",
    difficulty_hard:"Qiyin",
    gender_male:"Erkak",
    gender_female:"Ayol",
    next_btn2:"KEYINGI →",
    back_to_menu:"← MENYUGA",
    search_placeholder:"QIDIRISH...",
    enter_name:"Ismingiz",
    enter_goal:"MAQSADINGIZ NIMA?",
    hello_name:"SALOM! ISMINGIZ NIMA?",
    name_hint:"Ismingiz ilovada ko'rsatiladi",
    sets_label:"YONDASHUV",
    reps_label2:"MARTA",
    exercises_label:"MASHQLAR",
    minutes_label:"DAQIQA",
    tonnage_label2:"TONNAJ",
    volume_label:"HAJM",
    weight_label2:"OG'IRLIK",
    date_label:"SANA",
    time_label2:"VAQT",
    difficulty_label:"QIYINLIK",
    equipment_label:"JIHOZLAR",
    description_label:"TAVSIF",
    technique_label:"BAJARISH TEXNIKASI", tech_offline:"Texnika aloqa tiklanganda yuklanadi.",
    more_info:"BATAFSIL →",
    open_plan:"TARKIBNI OCHISH →",
    continue_workout2:"MASHQNI DAVOM ETTIRISH",
    unfinished:"Tugallanmagan mashqingiz bor",
    skip_warmup:"ISITISHNI O'TKAZIB YUBORISH",
    warmup_time:"TAVSIYA ETILGAN ISITISH VAQTI",
    replace_exercise:"↔ MASHQNI ALMASHTIRISH",
    do_replace:"↔ ALMASHTIRISH",
    add_exercise:"+ MASHQ QO'SHISH",
    add_during:"MASHQ QO'SHISH",
    my_exercise:"O'Z MASHQIM",
    all_exercises:"BARCHA MASHQLAR →",
    show_exercises:"BARCHA MASHQLARNI KO'RSATISH →",
    order_hint2:"↑↓ — tartib · ↔ — almashtirish",
    steps_1_4:"QADAM 1 / 4",
    steps_2_4:"QADAM 2 / 4",
    steps_3_4:"QADAM 3 / 4",
    steps_4_4:"QADAM 4 / 4",
    steps_1_2:"QADAM 1 / 2",
    steps_2_2:"QADAM 2 / 2",
    plan_step1:"REJALASHTIRISH · QADAM 1",
    plan_step2:"REJALASHTIRISH · QADAM 2",
    plan_step3:"REJALASHTIRISH · QADAM 3",
    calories_label2:"KALORIYA",
    proteins_label:"OQSILLAR",
    fats_label:"YOG'LAR",
    carbs_label:"UGLEVODLAR",
    kcal_unit:"kkal",
    kcal_per100:"kkal/100g",
    protein_g:"Oqsil g",
    fat_g:"Yog' g",
    carb_g:"Uglevod g",
    weight_g:"Og'irlik (kg)",
    portions_label:"OVQAT TURI",
    add_meal2:"KUNDALIKKA QO'SHISH",
    add_product:"MAHSULOT QO'SHISH",
    new_product:"YANGI MAHSULOT (100g uchun)",
    product_catalog:"MAHSULOTLAR KATALOGI",
    food_catalog_title:"MAHSULOTLAR MA'LUMOTNOMAI",
    food_catalog_kbju:"100G UCHUN",
    search_product:"Mahsulot qidirish...",
    product_name:"Mahsulot nomi *",
    dish_name:"Taom nomi",
    add_custom_product:"+ O'Z MAHSULOTIMNI QO'SHISH",
    product_exists:"Bu nomli mahsulot allaqachon mavjud",
    calories_short:"Kkal",
    calories_req:"Kkal *",
    carbs_short:"Uglevod",
    photo_kbju_title:"FOTO → KALORIYA",
    photo_kbju_hint:"Ovqatni suratingiz — AI kaloriyalarni hisoblab beradi",
    analyzing_photo:"AI FOTONI TAHLIL QILMOQDA...",
    analyze_btn:"🔍 TAHLIL QILISH",
    new_photo:"YANGI FOTO",
    add_to_diary2:"💾 KUNDALIKKA",
    add_photo:"FOTO QO'SHISH",
    ai_nutrition_title:"AI OVQATLANISH",
    saved_to_diary:"✓ OVQATLANISH KUNDALIGIGA SAQLANDI",
    measurements_title2:"TANA O'LCHOVLARI",
    measurements_cat:"ANTROPOMETRIYA",
    save_measurements:"O'LCHOVLARNI SAQLASH",
    measurements_saved:"✓ O'LCHOVLAR SAQLANDI",
    measurements_history:"TARIX",
    measurements_add:"QO'SHISH",
    measurements_none:"Hali o'lchovlar yo'q",
    waist:"Bel",
    hips:"Tos",
    chest:"Ko'krak",
    arm:"Qo'l (biceps)",
    thigh:"Son",
    checkin_title2:"TEKSHIRUV",
    checkin_weekly:"HAFTALIK",
    checkin_saved:"TEKSHIRUV SAQLANDI",
    send_checkin:"TEKSHIRUVNI YUBORISH",
    checkin_ai_hint:"AI murabbiy yangilangan ma'lumotlarni oldi",
    sleep_hours:"UYQU (SOAT)",
    energy_label:"Energiya",
    stress_label:"Stress",
    motivation_label:"Motivatsiya",
    profile_fill:"Profilni to'ldiring",
    profile_fill_hint:"Mashqlarni moslash uchun profilni to'ldiring",
    profile_edit:"✏ PROFILNI TAHRIRLASH",
    edit_date:"✏ SANA/TARKIBNI O'ZGARTIRISH",
    age_label:"Yosh",
    age_years:"Yosh (yillar)",
    height_label:"Bo'y",
    height_cm:"Bo'y (sm)",
    bmi_label:"TKI",
    gender_label:"JINS",
    ai_style_label:"AI MULOQOT USLUBI",
    status_saved:"✓ SAQLANDI",
    profile_saved2:"✓ O'LCHOVLAR SAQLANDI",
    ai_bro_desc:"Yoshlar, sleng, motivatsiya",
    ai_mentor_desc:"O'rtacha, qo'llab-quvvatlash",
    ai_expert_desc:"Professional, atamalar",
    ai_bro_name:"Fitnes-bro",
    med_label:"TIBBIY KO'RSATMALAR",
    no_med:"Cheklovlar yo'q",
    supps_label:"💊 MENING QO'SHIMCHALARIM",
    quick_select:"TEZKOR TANLASH",
    manual_input:"YOKI QO'LDA KIRITING",
    supp_name:"Qo'shimcha nomi...",
    supp_dose:"Dozasi (masalan 5g)",
    supp_timing:"Vaqti (ertalab, mashqdan oldin)",
    not_specified2:"Ko'rsatilmagan",
    gamification_title2:"MENING STATUSIM",
    my_rating2:"MENING REYTINGIM",
    status_label2:"STATUS",
    points_label2:"BALLLAR",
    rank_label2:"DARAJA",
    leaderboard_title:"LIDERLAR JADVALI",
    my_position:"MENING O'RNIM",
    how_earn:"QANDAY BALL ISHLASH MUMKIN",
    recent_points:"SO'NGGI HISOBLASHLAR",
    next_rank:"KEYINGI DARAJAGA",
    streak_series:"🔥 FAOLLIK SERIYASI",
    achievements_title2:"YUTUQLAR",
    new_achievement:"🎉 YANGI YUTUQ",
    progress_label:"TARAQQIYOT",
    unlocked_label:"OCHILDI",
    referral_title2:"BONUS DASTURI",
    how_works:"QANDAY ISHLAYDI",
    goals_title2:"MENING MAQSADLARIM",
    goals_add:"+ MAQSAD QO'SHISH",
    new_goal:"YANGI MAQSAD",
    goal_desc:"Maqsad tavsifi...",
    goal_achieved:"ERISHILDI",
    no_goals:"Faol maqsadlar yo'q. Birinchisini qo'ying!",
    goal_target:"Maqsad",
    goal_unit:"birlik",
    reminders_title2:"ESLATMALAR",
    reminders_cat:"BILDIRISHNOMALAR",
    upcoming_workouts:"KELGUSI MASHQLAR",
    no_reminders:"Kelgusi mashqlar yo'q",
    bot_reminds:"🔔 Bot eslatadi",
    one_hour:"1 soat",
    before_workout:"mashqdan oldin",
    plateau_check:"Plato detektori har yakshanba 10:30 da tekshiradi.",
    add_plan:"+ REJALASHTIRISH",
    add_plan2:"+ MASHQNI REJALASHTIRISH",
    support_title2:"YORDAM",
    support_cat:"FIKR-MULOHAZA",
    support_placeholder:"Muammoingizni tasvirlab bering, tez javob beramiz",
    support_problem:"MUAMMO YOKI SAVOLNI TUSHUNTIRING",
    sending:"YUBORILMOQDA...",
    sent:"YUBORILDI",
    send_btn:"YUBORISH",
    error_send:"Yuborishda xato. Keyinroq urinib ko'ring.",
    error_conn:"Ulanish yo'q. Internetni tekshiring.",
    error_conn2:"Ulanish yo'q. Keyinroq urinib ko'ring.",
    language_title2:"TIL",
    settings_title:"SOZLAMALAR",
    current_lang:"✓ JORIY",
    sport_title2:"SPORT TURLARI",
    sport_cat:"SPORT",
    record_btn:"YOZILDI",
    sport_full_record:"To'liq yozuv Mashqlar → ⚽ Sport bo'limida",
    score_optional:"Natija, hamkorlar, his-tuyg'ular...",
    score_example:"Masalan: 3:2 yoki 21:18",
    sport_planned:"📤 ULASHISH",
    no_activities:"Mashg'ulotlar yo'q",
    ai_training:"AI MURABBIY",
    greeting_back:"SALOM,",
    greeting_back2:"XUSH KELIBSIZ",
    greet_away:["XUSH KELIBSIZ","KO'RISHMAGANIMIZGA ANCHA BO'LDI","QAYTGANINGIZ YAXSHI","YANGIDAN BOSHLAYMIZ"],
    greet_streak:["ZO'R KETYAPSIZ","SERIYA DAVOM ETMOQDA","SUSAYMAYAPSIZ","MANA BU INTIZOM"],
    greet_today:["BUGUN BAJARILDI","AJOYIB ISH","ISH BITDI","BARAKALLA"],
    greet_normal:["SALOM","KO'RGANIMDAN XURSANDMAN","QANI KETDIK","ISHGA TAYYOR"],
    home_load_error:"Yuklab bo'lmadi. Aloqani tekshiring.", retry:"QAYTA",
    home_k_profile:"Profil kerak", home_k_resume:"Tugallanmagan", home_k_planned:"Bugunga rejalashtirilgan", home_k_suggest:"Murabbiy taklif qiladi",
    home_days_streak:"kun ketma-ket", home_of:"dan", home_this_week:"shu haftada", home_sport:"sport",
    home_min:"daq.", home_exercises:"mashq", home_other_option:"Boshqa variant",
    home_food:"Ovqat", home_burned:"Sarflandi", home_weight:"Vazn", home_kg:"kg",
    home_photo_food:"Ovqat surati", home_ask_coach:"Murabbiyga savol", home_services:"Xizmatlar",
    prog_this_week:"SHU HAFTA", week_gym:"zal", week_sport:"sport", prefill_from:"mashqdan",
    consent_intro:"Ilova mashq, ovqatlanish va sogliq malumotlarini, shu jumladan qarshi korsatmalar va allergiyalarni toplaydi va AI-murabbiyga uzatadi. 18 yoshdan.",
    consent_checkbox:"Shaxsiy malumotlarim, shu jumladan sogliq malumotlari qayta ishlanishiga roziman",
    consent_record:"MALUMOTLARNI QAYTA ISHLASHGA ROZILIK", consent_ver:"tahrir", age_too_young:"Ilova 18 yoshdan mavjud.",
    consent_give:"berish",
    ai_consent_btn:"PROFILGA OTISH",
    ai_consent_needed:"Murabbiy mavjud emas: AI-xizmatga malumot uzatishga rozilik qaytarib olingan. Uni profildagi roziliklar bolimida tiklash mumkin.",
    consent_i_terms:"Menga 18 yosh toldi, foydalanish qoidalarini qabul qilaman", consent_i_terms_h:"Yuklama, ovqatlanish va qoshimchalar boyicha qarorni ozim qabul qilaman. AI javobi tibbiy tayinlov emas.",
    consent_i_basic:"Hisob va mashq malumotlarini qayta ishlash", consent_i_basic_h:"Profil, kundaliklar, maqsadlar va statistika. Chet eldagi serverlarda saqlanadi.",
    consent_i_health:"Sogliq malumotlarini qayta ishlash", consent_i_health_h:"Qarshi korsatmalar, allergiyalar, dorilar, kasalliklar. Busiz cheklovlar hisobga olinmaydi.",
    consent_i_ai:"Malumotlarni AQShdagi AI-xizmatga uzatish", consent_i_ai_h:"Profil, tarix va tibbiy cheklovlar har bir murojaatda Anthropicga uzatiladi. Busiz AI-murabbiy va ovqatni aniqlash ishlamaydi.",
    consent_required_note:"* ilova ishlashi uchun majburiy. Qolganlarini profilda istalgan vaqtda qaytarib olish mumkin.",
    consent_no_ai_note:"Bu rozilik bolmasa AI-murabbiy va surat boyicha ovqatni aniqlash ishlamaydi.",
    consent_not_given:"berilmagan", consent_withdraw:"qaytarib olish", consent_req_note:"majburiy",
    consent_wd_ai_confirm:"Malumot uzatishga rozilik qaytarib olinsinmi? AI-murabbiy va ovqatni aniqlash ishlamay qoladi.",
    consent_wd_health_confirm:"Sogliq malumotlariga rozilik qaytarib olinsinmi? Qarshi korsatmalar, allergiyalar va dorilar profildan ochiriladi.",
    mydata_title:"MENING MALUMOTLARIM", mydata_export:"Malumotlarimni yuklab olish", mydata_delete:"Hisobni va barcha malumotlarni ochirish",
    consent_gate_kicker:"DAVOM ETISHDAN OLDIN", consent_gate_title:"MALUMOTLARNI QAYTA ISHLASHGA ROZILIK", consent_gate_btn:"ROZIMAN",
    mydata_export_err:"Malumotlarni yuklab bolmadi.", mydata_del_err:"Hisobni ochirib bolmadi.",
    mydata_del_confirm1:"Hisob ochirilsinmi? Barcha mashqlar, olchovlar, ovqatlanish va tarix ochiriladi. Qaytarib bolmaydi.",
    mydata_del_confirm2:"Tasdiqlash uchun DELETE deb yozing", mydata_del_done:"Hisob va barcha malumotlar ochirildi.",
    rpe_question:"YONDASHUV QANDAY BO'LDI?", rpe_easy:"Oson", rpe_ok:"Normal", rpe_hard:"Og'ir", rpe_max:"Chegara",
    home_close_workout:"Mashqni yopish", home_close_confirm:"Tugallanmagan mashqni yopamizmi? Yozilgan yondashuvlar saqlanadi.", home_checkin_due:"chek-in vaqti",
    more_profile:"PROFIL", more_training:"MASHQLAR", more_health:"SALOMATLIK", more_catalog:"KATALOG",
    more_edit_profile:"Anketa va parametrlar", more_training_prefs:"Chastota va split",
    more_achievements:"Yutuqlar", more_leaderboard:"Reyting",
    alt_kicker:"ALMASHTIRISH", alt_title:"BOSHQA VARIANT", alt_repeat_last:"O'tgansini takrorlash",
    alt_build_own:"O'zim tuzaman", alt_available:"MAVJUD", alt_recent:"YAQINDA MASHQ QILINGAN",
    alt_never:"hali mashq qilinmagan", alt_rest:"dam", alt_days:"kun",
    alt_confirm_repeat:"Baribir takrorlaymizmi?", alt_split:"Split", alt_change:"o'zgartirish", alt_no_last:"Takrorlash uchun tugallangan mashq yo'q.",
    prefs_kicker:"MASHQ JARAYONI", prefs_title:"CHASTOTA VA SPLIT",
    prefs_freq:"HAFTASIGA KUCH MASHQLARI", prefs_freq_hint:"Sport bu kvotaga kirmaydi, alohida hisoblanadi.",
    prefs_split:"SPLIT TIZIMI", prefs_split_hint:"Ixtiyoriy — murabbiy guruhlarni dam olishiga qarab tanlaydi.",
    prefs_days_in_cycle:"kun siklda", prefs_saving:"Saqlanmoqda...", prefs_saved:"Saqlandi",
    streak_day1:"KUN",
    streak_day24:"KUN",
    streak_days5:"KUN",
    streak_podryad:"KETMA-KET",
    ai_today:"AI bugun",
    checkin_card_hint:"Haftada bir marta — yakshanba kechasi yoki dushanba ertalab to'ldiring.",
    checkin_card_hint2:"reja, javob va maslahatlarda chek-iningizni hisobga oladi.",
    level_below:"Boshdan past",
    level_elite:"Elit",
    norm_beg:"Bosh",
    norm_mid:"O'rta",
    norm_adv:"Ilg'or",
    norm_elite:"Elit",
    age_suffix:"y",
    coef_label:"koef.",
    sleep_label2:"Uyqu",
    supp_timing_anytime:"Har kuni istalgan vaqtda",
    supp_timing_food:"Ovqat bilan",
    supp_timing_food_sleep:"Ovqat bilan yoki uxlashdan oldin",
    supp_timing_before:"Mashqdan 30–45 daqiqa oldin",
    supp_timing_morning:"Ertalab yog'li ovqat bilan",
    supp_timing_sleep:"Uxlashdan oldin",
    supp_timing_collagen:"Mashqdan 1 soat oldin C vitamini bilan",
    supp_protein:"Protein",
    supp_creatine:"Kreatin monogidrat",
    supp_omega:"Omega-3",
    supp_vitd:"D3 vitamini",
    supp_magnesium:"Magniy",
    supp_bcaa:"BCAA",
    supp_zinc:"Rux",
    supp_vitc:"C vitamini",
    supp_multi:"Multivitaminlar",
    supp_glutamine:"Glutamin",
    supp_collagen:"Kollagen",
    supp_melatonin:"Melatonin",
    supp_caffeine:"Kofein",
    supp_beta:"Beta-alanin",
    supp_preworkout:"Pre-workout",
    add30s:"+30 soniya",
    minus15s:"−15 soniya",
    rest_5_10:"5–10 daqiqa",
    sets_short2:"yondashuv",
    reps_short2:"MARTA",
    pts_short:"ball.",
    pts_label:"balllar",
    kcal_short:"kkal",
    kcal_100g:"kkal/100g",
    volume_short:"hajm (kg×marta)",
    workouts_week:"mashq haftada",
    one_session2:"1 mashg'ulot",
    max_w:"MAX OG'IRLIK",
    dist_short:"MASOFA (KM)",
    field_waist:"Bel",
    field_hips:"Tos",
    field_chest:"Ko'krak",
    field_arm:"Qo'l (biceps)",
    field_thigh:"Son",
    field_age:"Yosh",
    field_age_y:"Yosh (yillar)",
    field_weight_kg:"Og'irlik (kg)",field_weight_g:"OG'IRLIK (g)",
    field_height_cm:"Bo'y (sm)",
    step_1_2:"QADAM 1 / 2",
    step_2_2:"QADAM 2 / 2",
    step_1_4b:"QADAM 1 / 4",
    step_2_4b:"QADAM 2 / 4",
    step_3_4b:"QADAM 3 / 4",
    step_4_4b:"QADAM 4 / 4",
    plan_s1:"REJALASHTIRISH · QADAM 1",
    plan_s2:"REJALASHTIRISH · QADAM 2",
    plan_s3:"REJALASHTIRISH · QADAM 3",
    sel_group_hint:"Bir yoki bir nechta guruh tanlang",
    next_datetime:"KEYINGI → SANA VA VAQT",
    choose_replacement:"ALMASHTIRISH TANLANG",
    warmup_exec_hint:"Asosiy mashqdan oldin isitishni bajaring",
    edit_btn:"O'ZGARTIRISH",
    edit_arrow:"O'ZGARTIRISH →",
    profile_section:"PROFIL",
    language_section:"TIL",
    score_section:"NATIJA",
    notes_section:"IZOHLAR",
    cancel_btn2:"BEKOR QILISH",
    delete_btn:"O'CHIRISH",
    error_label2:"XATO",
    failed_load2:"YUKLAB BO'LMADI",
    points_short:"YONDASHUV",
    order_section:"TARTIB",
    meal_section:"OVQAT TURI",
    allergy_section:"ALLERGIYALAR",
    archive_section:"ARXIV",
    goal_section:"MAQSAD",
    status_section:"STATUS",
    level_section:"DARAJA",
    calories_section:"KALORIYA",
    exercises_section:"MASHQLAR",
    volume_section:"HAJM",
    tonnage_section:"TONNAJ",
    time_min_section:"VAQT (DAQIQA)",
    name_section:"NOMI",
    name_opt_section:"NOMI (IXTIYORIY)",
    food_catalog_section:"MAHSULOTLAR KATALOGI",
    food_ref_section:"MAHSULOTLAR MA'LUMOTNOMAI",
    new_product_section:"YANGI MAHSULOT (100g uchun)",
    add_product_btn:"MAHSULOT QO'SHISH",
    add_photo_btn:"FOTO QO'SHISH",
    add_exercise_btn:"MASHQ QO'SHISH",
    my_exercise_section:"O'Z MASHQIM",
    when_take_section:"QACHON QABUL QILISH",
    photo_kbju_title2:"FOTO → KALORIYA",
    ai_trainer_title:"AI MURABBIY",
    ai_trainer_online:"MURABBIY ALOQADA",
    analyzing_photo2:"AI FOTONI TAHLIL QILMOQDA...",
    workout_still_active:"⚠️ MASHQ HALI DAVOM ETMOQDA",
    record_sport:"⚽ MASHG'ULOTNI YOZ",
    edit_date_plan:"✏ SANA/TARKIBNI O'ZGARTIRISH",
    edit_profile_btn2:"✏ PROFILNI TAHRIRLASH",
    added_done:"✓ QO'SHILDI",
    warmup_done2:"✓ ISITISH BAJARILDI",
    save_confirm:"✓ SAQLASH",
    workout_saved_tab:"✓ MASHQ SAQLANDI → Rejalashtirilgan yorliq",
    calories_food:"🍽 KALORIYA (OVQAT)",
    warmup_badge3:"🏃 ISITISH",
    when_workout2:"📅 MASHQ QACHON?",
    share_btn2:"📤 ULASHISH",
    other_photo2:"📷 Boshqasi",
    analyze_btn2:"🔍 TAHLIL QILISH",
    bot_reminds2:"🔔 Bot eslatadi",
    burned_sport:"🔥 SARFLANDI (SPORT)",
    water_tap_hint:"← bir stakan suv belgisi uchun bosing",
    replace_exercise2:"↔ MASHQNI ALMASHTIRISH",
    do_replace2:"↔ ALMASHTIRISH",
    plateau_schedule:"Plato detektori har yakshanba 10:30 da tekshiradi.",
    bot_1h:"Bot 1 soat oldin eslatadi",
    bot_1h_full:"Bot mashqdan 1 soat oldin eslatadi",
    continue_workout3:"MASHQNI DAVOM ETTIRISH",
    skip_warmup2:"ISITISHNI O'TKAZIB YUBORISH",
    warmup_rec_time:"TAVSIYA ETILGAN ISITISH VAQTI",
    no_allergies2:"Allergiya yo'q",
    no_conditions2:"Cheklovlar yo'q",
    not_specified3:"Ko'rsatilmagan",
    measurements_hint:"O'lchovlar tarixda saqlanadi — dinamikani kuzating",
    ai_trainer_hint:"AI murabbiy maqsadingizga mos maslahat beradi",
    goal_hint:"MAQSADINGIZ NIMA?",
    name_hint2:"SALOM! ISMINGIZ NIMA?",
    requests_left:"SO'ROVLAR QOLDI ·",
    or_write:"yoki yozing",
    pts_per:"mashqdan oldin.",
    pts_bonus:"+8 ball",
    no_data_short:"ma'lumot yo'q",
    day_30:"30 kun",
    day_60:"60 kun",
    day_90:"90 kun",
    day_180:"180 kun",
    hour_1:"1 soat",
    ai_chat_title:"MURABBIY BILAN MULOQOT",
    ai_clear:"🗑 TOZALASH",
    ai_coach_label:"🤖 MURABBIY",
    ai_thinking2:"MURABBIY FIKRLAYDI...",
    ai_analyzing:"MASHQ TAHLIL QILINMOQDA...",
    ai_review_title:"AI MURABBIY BAHOLASHI",
    ai_coach_advice:"💬 MURABBIY MASLAHATI",
    ai_proposes:"💪 AI MASHQ TAKLIF QILMOQDA",
    ai_save_plan:"📅 JADVALGA SAQLASH",
    ai_date_hint:"Saqlashdan oldin sana va vaqtni tanlang",
    ai_saved:"✓ MASHQ SAQLANDI → Rejalashtirilgan yorliq",
    open_schedule:"JADVALINI OCHISH →",
    continue_dialog:"+ DAVOM ETISH",
    quick_questions:"TEZKOR SAVOLLAR",
    voice_hint:"🎙 OVOZ · YOKI YOZING",
    voice_full_hint:"🎙 YOZISH UCHUN BOSING · YOKI YOZING",
    recognizing:"TANILMOQDA...",
    no_mic:"Mikrofonga ruxsat yo'q",
    no_audio:"Audio ma'lumotlari yo'q",
    speech_not_recognized:"Nutq tanilmadi",
    transcription_error:"Transkripsiya xatosi",
    progress_title2:"MENING TARAQQIYOTIM",
    weekly_activity:"HAFTALIK FAOLLIK",
    workouts_per_week:"mashq haftada",
    muscle_progress:"MUSHAK GURUHLARI BO'YICHA TARAQQIYOT",
    strength_norms:"SIZNING KUCHINGIZ VS NORMALAR",
    no_data_period:"Tanlangan davr uchun ma'lumot yo'q",
    need_2_workouts:"Grafik uchun ≥2 mashq kerak",
    max_weight:"MAX OG'IRLIK",
    volume_unit:"hajm (kg×marta)",
    sessions_count:"mashg'ulot",
    one_session:"mashg'ulot",
    weight_dynamics:"VAZN DINAMIKASI",
    timer_title:"DAM OLISH TAYMERI",
    tools_title:"ASBOBLAR",
    rest_done:"✓ DAM OLISH TUGADI",
    rest_label:"DAM OLISH",
    choose_time:"VAQTNI TANLANG",
    pause_btn:"⏸ PAUZA",
    start_btn2:"▶ BOSHLASH",
    add30:"+30 soniya",
    minus15:"−15 soniya",
    reset_btn2:"TOZALASH",
    supps_title2:"QO'SHIMCHALAR",
    supps_cat:"SPORT QO'SHIMCHALARI",
    supps_ref:"MA'LUMOTNOMA",
    supp_dose_label:"DOZASI",
    supp_when:"QACHON QABUL QILISH",
    supp_sources:"MANBALAR",
    supp_desc:"TAVSIF VA MASLAHATLAR",
    supp_warning:"⚠️ Vitamin va qo'shimchalar qabul qilish tibbiy maslahat emas.",
    food_guide_cat:"MA'LUMOTNOMA",
    food_guide_title2:"MAHSULOTLAR KATALOGI",
    food_when:"⏰ QACHON YEYISH",
    food_tips:"💡 MASLAHATLAR",
    food_best:"🏆 ENG YAXSHI MAHSULOTLAR",
    food_combines:"✅ UYG'UN KELADI",
    food_avoid:"❌ BIRGA ISTE'MOL ETMANG",
    error_server:"Server xatosi",
    error_save:"Saqlash xatosi",
    error_net:"Tarmoq xatosi",
    error_request:"So'rov xatosi",
    error_launch:"Ishga tushirish xatosi",
    error_load:"Yuklash xatosi",
    error_try_again:"Xato. Qayta urinib ko'ring.",
    open_telegram:"Telegram orqali oching.",
    failed_load:"Yuklab bo'lmadi",
    failed_recognize:"Tanib bo'lmadi. Boshqa foto urinib ko'ring.",
    food_limit_reached:"Bugungi rasm orqali aniqlashlar tugadi (kuniga {limit} ta). Ertaga yana mumkin, hozircha taomni qo'lda kiritishingiz mumkin.",
    food_quota_left:"Bugun qolgan aniqlashlar: {left} / {limit}",
    limit_exceeded:"Kunlik limit tugadi. Ertaga urinib ko'ring.",ai_unavailable:"AI-murabbiy vaqtincha ishlamayapti. Birozdan keyin urinib ko‘r — so‘rovlar limiti sarflanmadi.",last_time:"O‘tgan safar",day_today_l:"bugun",day_yesterday:"kecha",days_ago_n:"{n} kun oldin",set_save_failed:"Yondashuv saqlanmadi — aloqani tekshirib, qayta bos",sq_dropped:"Saqlanmagan yondashuvlar: {n} — mashg‘ulot serverda allaqachon yopilgan",sq_waiting:"⏳ Yuborilishini kutmoqda: {n}. Aloqa paydo bo‘lishi bilan o‘zi ketadi",sq_finish_pending:"Hali yuborilmagan yondashuvlar: {n}. Hozir tugatasizmi? Ular keyinroq ketadi, lekin bu mashg‘ulot natijalariga kirmaydi.",
    specify_name:"Nomni kiriting",
    specify_name_cal:"Nom va kaloriyalarni kiriting",
    delete_confirm:"Mashg'ulotni o'chirilsinmi?",
    no_answer:"Javob yo'q",
    another_one:"YANA BIRI",
    going_in:"KIRILMOQDA...",
    exercises_none:"Mashqlar tanlanmagan",
    exercises_none_planned:"Mashqlar rejalashtirilmagan edi",
    my_workout_name:"Mening mashqim",
    workout_name_opt:"NOMI (IXTIYORIY)",
    workout_status_active:"⚠️ MASHQ HALI DAVOM ETMOQDA",
    scheduled_workout:"REJALASHTIRILGAN MASHQ",
    scheduled_done:"REJALASHTIRILDI",
    my_workouts_title:"MENING MASHQLARIM",
    schedule_label:"JADVAL",
    upcoming_label:"KELGUSI",
    archive_planned:"REJALASHTIRILGAN ARXIV",
    search_exercise:"Mashq qidirish...",
    search_placeholder2:"Qidirish...",
    name_label:"NOMI",
    name_req:"Nomi *",
    exercise_group:"Mushak guruhi",
    sets_num:"Yondashuv",
    reps_num:"Marta",
    all_btn:"BARCHASI",
    knowledge_base:"BILIM BAZASI",
    save_measurements2:"O'LCHOVLARNI SAQLASH",
    saving:"SAQLANMOQDA...",
    saving2:"SAQLANMOQDA...",
    saved2:"✓ SAQLANDI",
    when_workout:"📅 MASHQ QACHON?",
    share_btn:"📤 ULASHISH",
    other_photo:"📷 Boshqasi",
    warmup_badge2:"🏃 ISITISH",
    notifications_hint:"🔔 Bot mashqdan 1 soat oldin eslatadi.",
    not_found_hint:"Hech narsa topilmadi",
    enter_name_or_cat:"NOMI KIRITING YOKI KATEGORIYA TANLANG",
    calories_eaten:"🍽 KALORIYA (OVQAT)",
    calories_burned2:"🔥 SARFLANDI (SPORT)",
    trainer_bot:"Bot 1 soat oldin eslatadi",
    trainer_bot2:"Bot mashqdan 1 soat oldin eslatadi",
    conflict_time:"boshqa vaqt tanlaysizmi?",
    dist_km:"MASOFA (KM)",
    imt_label:"TKI",
    workout_done2:"Mashq tugadi",
    workout_type:"Mashq",
    sets_short:"yondashuv",
    reps_done:"bajarildi",
    rpe_label:"RPE",
    warmup_duration:"5–10 daqiqa",
    add_time30:"+30 soniya",
    minus_time15:"−15 soniya",
    no_sets_data:"ma'lumot yo'q",
    one_portion:"1 porsiya",
    portions_pack:"qadoqdagi porsiyalar",
    // ── Добавлено 05.10.2026: тексты, которых не было в словаре вовсе.
    // Раньше они стояли литералами прямо в разметке и показывались
    // по-русски при любом языке приложения.
    // Активная тренировка
    aw_badminton:"🏸 Badminton",
    aw_ballov_za_seriyu:"seriya uchun ball",
    aw_basketbol:"🏀 Basketbol",
    aw_beg:"🏃 Yugurish",
    aw_boks:"🥊 Boks",
    aw_bolshoy_tennis:"🎾 Tennis",
    aw_dney:"kun",
    aw_dnya:"kun",
    aw_dobavit_uprazhnenie:"Mashq qo‘shish",
    aw_futbol:"⚽ Futbol",
    aw_gandbol:"🤾 Gandbol",
    aw_gornye_lyzhi:"⛷ Tog‘ chang‘isi",
    aw_nastolnyy_tennis:"🏓 Stol tennisi",
    aw_padel:"🎾 Padel",
    aw_pilates:"🧘 Pilates",
    aw_plavanie:"🏊 Suzish",
    aw_skalolazanie:"🧗 Qoyaga chiqish",
    aw_sohranyaem:"⏳ SAQLANMOQDA...",
    aw_velosport:"🚴 Velosport",
    aw_voleybol:"🏐 Voleybol",
    aw_vyberi_zamenu:"— o‘rnini tanla",
    aw_vybrano:"TANLANDI (",
    aw_yoga:"🧘 Yoga",
    aw_zagruzka:"Yuklanmoqda...",
    // Блок «плато» в прогрессе
    plateau_analiz:"TAHLIL",
    // Гид по питанию
    fg_belok:"OQSIL",
    // Голосовая запись
    voice_oshibka:"Xato",
    // График недели: короткие названия спорта
    sps_badm:"badm.",
    sps_basket:"basket",
    sps_beg:"yugur.",
    sps_boks:"boks",
    sps_futbol:"futbol",
    sps_gandbol:"gandbol",
    sps_krossfit:"krossfit",
    sps_lyzhi:"chang‘i",
    sps_n_tennis:"st.tennis",
    sps_padel:"padel",
    sps_pilates:"pilates",
    sps_plav:"suzish",
    sps_skalolaz:"qoya",
    sps_tennis:"tennis",
    sps_velo:"velo",
    sps_voley:"voley",
    sps_yoga:"yoga",
    // График по группам мышц
    mgc_obem:"hajm",
    // Достижения
    ach_esche_ne_otkryto:"OCHILMAGAN (",
    ach_otkryto:"OCHILGAN (",
    // Единицы измерения
    u_carb:"U",
    u_fat:"Y",
    u_g:"g",u_s:"s",
    u_prot:"O",
    // Журнал занятий спортом
    splog_svoe:"O‘zimniki",
    // Замеры тела
    meas_sm:"sm",
    // Запланированная тренировка
    pw_arhivnaya:"📋 ARXIVDA",
    pw_tolko_prosmotr:"FAQAT KO‘RISH",
    pw_uprazhneniya:"MASHQLAR (",
    pw_vypolnena:"✓ BAJARILDI",
    // Знакомство при первом входе
    onb_analiziruet_trenirovki_vesa_:"Treninglar, og‘irliklar va takrorlarni tahlil qiladi — yuklamani qachon oshirish kerakligini aytadi",
    onb_atlet:"Atlet",
    onb_derzhit_motivaciyu:"Motivatsiyani ushlab turadi",
    onb_dobro_pozhalovat:"XUSH KELIBSIZ",
    onb_nachat:"BOSHLASH 🏋️",
    onb_nachat_znakomstvo:"TANISHISH →",
    onb_otvechaet_kak_zhivoy_trener:"Haqiqiy murabbiydek javob beradi",
    onb_pitanie_po_foto:"Surat orqali ovqatlanish",
    onb_serii_dney_dostizheniya_ches:"Kunlik seriyalar, yutuqlar va halol fikr — ortiqcha erkalatishsiz",
    onb_sfotografiroval_edu_poluchil:"Taomni suratga ol — kaloriya va BJU tayyor. Har bir ovqatni qo‘lda kiritish shart emas",
    onb_sprosi_chto_ugodno_pro:"Trening, tiklanish yoki qo‘shimchalar haqida istagan narsangni so‘ra — ma’lumotlaring asosida aniq javob olasan",
    onb_tvoy_lichnyy_ai_trener:"Shaxsiy AI murabbiying 🤖",
    onb_vidit_ves_tvoy_progress:"Butun progressingni ko‘radi",
    // История тренировок
    wh_nizkaya:"Past",
    wh_plan:"REJA",
    wh_srednyaya:"O‘rtacha",
    wh_vysokaya:"Yuqori",
    wh_zavershena:"✓ YAKUNLANDI",
    // Карточка тренировки
    wd_ph:"SET",
    // Лидерборд
    lb_ty:"(sen)",
    // Мои добавки
    usup_dobavit:"+ QO‘SHISH",
    usup_dobavit2:"✓ QO‘SHISH",
    // Питание
    nut_belki:"Oqsil",
    nut_cel:"maqsad",
    nut_g:"(g)",
    nut_isprav_nazvanie_sostav_kbzhu:"Nomini/tarkibini tuzat — kaloriya va BJU avtomatik qayta hisoblanadi",
    nut_limit_ai_zaprosov_na:"⚠️ Bugungi AI so‘rovlar limiti tugadi",
    nut_ml:"ml",
    nut_naprimer_chto_mne_ne:"Masalan: bugun ovqatlanishimda nima yetishmayapti? yoki oqsilni qanday taqsimlagan ma’qul?",
    nut_naprimer_risovaya_kasha_s:"Masalan: Sutli guruch bo‘tqasi, 300g",
    nut_oshibka:"xato",
    nut_pereschitat_i_sohranit:"🔄 HISOBLA VA SAQLA",
    nut_pitanie:"OVQATLANISH",
    nut_zhiry:"Yog‘",
    // Поиск продукта
    fs_na:"uchun",
    fs_poisk:"QIDIRISH",
    fs_sportpit:"💊 Sport oziqa",
    fs_vse:"Barchasi",
    // Правка занятия спортом
    spedit_partnery_oschuscheniya:"Sheriklar, hislar...",
    spedit_schet:"Hisob",
    // Прогресс
    prog_cht:"pa",
    prog_pn:"du",
    prog_pt:"ju",
    prog_sb:"sh",
    prog_seriya:"SERIYA",
    prog_sr:"ch",
    prog_trenirovok:"TRENING",
    prog_vs:"ya",
    prog_vt:"se",
    // Профиль
    prof_bally:"Ballar",
    prof_bro:"🤙 Bro",
    prof_ekspert:"🎓 Ekspert",
    prof_ekspert2:"Ekspert",
    prof_nastavnik:"🧑‍🏫 Ustoz",
    prof_nastavnik2:"Ustoz",
    prof_profil_ne_nayden_snachala:"Profil topilmadi. Avval @GYMASH_bot’da ro‘yxatdan o‘t, keyin bu yerga qayt.",
    prof_status:"Holat",
    prof_stil_ai:"AI uslubi",
    prof_uroven:"Daraja",
    // Профиль: аллергии
    alg_glyuten:"🌾 Glyuten",
    alg_laktoza:"🥛 Laktoza",
    alg_orehi:"🥜 Yong‘oq",
    alg_rybiy_zhir:"🐟 Baliq yog‘i",
    alg_soya:"🫘 Soya",
    alg_yayca:"🥚 Tuxum",
    // Профиль: ограничения по здоровью
    med_bol_v_spine:"🔙 Bel og‘rig‘i",
    med_diabet:"💉 Diabet",
    med_gipertoniya:"🩺 Gipertoniya",
    med_gryzha:"⚠️ Churra",
    med_plecho_rotator:"💪 Yelka/rotator",
    med_pochki:"🫘 Buyrak",
    med_pozvonochnik:"🦴 Umurtqa",
    med_serdce_sosudy:"❤️ Yurak/tomirlar",
    med_travma_kolena:"🦵 Tizza jarohati",
    // Профиль: уровень подготовки
    lvl_novichok:"Boshlovchi",
    // Распознавание еды по фото
    fv_blyudo:"Taom",
    fv_gotovo:"✅ TAYYOR",
    fv_ispravit:"✏️ TUZATISH",
    fv_naprimer_risovaya_kasha_s:"Masalan: Sut va asalli guruch bo‘tqasi, 300g",
    fv_ne_udalos_pereschitat_poprob:"Qayta hisoblab bo‘lmadi. Boshqacha tasvirlab ko‘r.",
    fv_neizvestnaya_oshibka:"noma’lum xato",
    fv_nizkaya:"❓ Past",
    fv_otmena:"Bekor qilish",
    fv_perekadrirovat:"🔄 Qayta kadrla",
    fv_pereschitat:"🔄 QAYTA HISOBLA",
    fv_pereschityvaem:"HISOBLANMOQDA...",
    fv_povtorit_sohranenie:"🔄 QAYTA SAQLASH",
    fv_povtoryaem:"QAYTA URINISH...",
    fv_srednyaya:"⚠️ O‘rtacha",
    fv_vysokaya:"✅ Yuqori",
    // Рефералы
    ref_kopirovat:"📋 NUSXALASH",
    ref_moi_referaly:"REFERALLARIM (",
    ref_skopirovano:"✓ NUSXALANDI",
    // Сбор тренировки
    plan_dobavit_v_trenirovku:"+ TRENINGGA QO‘SH",
    plan_ubrat_iz_trenirovki:"✓ TRENINGDAN OL",
    plan_vybrano:"TANLANDI",
    plan_zaplanirovat:"📅 REJALASH",
    // Своё блюдо (форма)
    fcat_frukty:"🍎 Mevalar",
    fcat_hleb:"🍞 Non",
    fcat_krupy:"🌾 Yormalar",
    fcat_molochka:"🥛 Sutli",
    fcat_myaso:"🥩 Go‘sht",
    fcat_napitki:"🧃 Ichimliklar",
    fcat_ovoschi:"🥦 Sabzavotlar",
    fcat_prochee:"🫙 Boshqa",
    fcat_ryba:"🐟 Baliq",
    fcat_sneki:"🍫 Sneklar",
    // Своё упражнение
    cex_moe:"Meniki",
    // Серии и баллы
    gam_atlet:"🥈 Atlet",
    gam_chek_in:"✓ Chek-in",
    gam_chempion:"🥇 Chempion",
    gam_legenda:"💎 Afsona",
    gam_pitanie_vneseno:"Ovqatlanish kiritildi",
    gam_tennis:"🎾 Tennis",
    gam_trenirovka_zavershena:"🏋️ Trening yakunlandi",
    gam_zanyatie_sportom:"Sport mashg‘uloti",
    // Справочник добавок
    sup_10g_den:"10g/kun",
    sup_15_30mg_den:"15–30mg/kun",
    sup_1_3g_epa_dha:"1–3g EPA+DHA/kun",
    sup_2000_5000_me_den:"2000–5000 ME/kun",
    sup_200_400mg:"200–400mg",
    sup_20_40g_za_priem:"20–40g bir qabulda",
    sup_3_5g_den:"3–5g/kun",
    sup_3_6mg_kg_vesa:"3–6mg/kg vazn",
    sup_bez_zagruzki_rezultat_cherez:"Yuklash bosqichisiz. Natija 2–4 haftada. Suv bilan ich (250ml). Eng ko‘p o‘rganilgan qo‘shimchalardan biri.",
    sup_immunitet_testosteron_kosti_:"Immunitet, testosteron, suyaklar. Kalsiyning to‘g‘ri o‘zlashishi uchun K2 (100–200mkg) bilan qabul qiling.",
    sup_immunitet_testosteron_vossta:"Immunitet, testosteron, tiklanish. Kalsiy bilan birga qabul qilmang — o‘zlashishda raqobatlashadi.",
    sup_kachestvo_sna_myshechnoe_vos:"Uyqu sifati, mushak tiklanishi, stressni kamaytirish. Shakli: glitsinat yoki malat (oksid emas — yomon o‘zlashadi).",
    sup_posle_trenirovki_ili_v:"Treningdan keyin yoki kunning istalgan vaqtida",
    sup_povyshaet_vynoslivost_silu_i:"Chidamlilik, kuch va diqqatni oshiradi. 15:00 dan keyin qabul qilmang — uyquni buzadi. Tolerantlik tez rivojlanadi.",
    sup_prokonsultiruysya_s_vrachom_:"⚠️ Shifokor bilan maslahatlashing — qarshi ko‘rsatmalar bor",
    sup_protivovospalitelnyy_effekt_:"Yallig‘lanishga qarshi ta’sir, bo‘g‘imlar, yurak. Umumiy baliq yog‘iga emas, EPA+DHA miqdoriga qarang.",
    sup_sustavy_i_svyazki_neobhodim:"Bo‘g‘imlar va paylar. Kollagen sintezi uchun C vitamini (100mg) kerak. Ta’siri yig‘ilib boradi — 8–12 hafta.",
    sup_umerennyy_uroven_dokazatelno:"🟡 O‘rtacha dalil darajasi",
    sup_vospolnenie_belka_syvorotoch:"Oqsilni to‘ldirish. Zardob oqsili — tez, kazein — sekin (uyqudan oldin).",
    sup_vozmozhna_allergicheskaya_re:"🚫 Allergik reaksiya bo‘lishi mumkin",
    sup_vysokiy_uroven_dokazatelnost:"🟢 Yuqori dalil darajasi",
    sup_your_weight:"(VAZNING {w}KG)",
    // Цели
    goals_celi:"MAQSADLAR",
    // Экран тренера (AI)
    ai_ai_trenirovka:"AI trening",
    ai_chto_est_do_i:"Treningdan oldin va keyin nima yeyish kerak",
    ai_oshibka_soedineniya:"Ulanish xatosi —",
    ai_programma_dlya_pohudeniya_na:"Bir oylik ozish dasturi",
    ai_sostav_plan_trenirovki_na:"Massa yig‘ish uchun bir haftalik trening rejasini tuz",
    ai_sprosi_chto_ugodno:"ISTAGANINGNI SO‘RA...",
    ai_trenirovka_na_plechi_i:"Yelka va qo‘l uchun trening",
    ai_plan_more:"+ yana {n}",
    err_save_failed:"Saqlab bo‘lmadi: {err}",
    err_save_status:"Saqlash xatosi ({code})",
    err_server_retry:"Server xatosi ({code}). Keyinroq urinib ko‘r.",
    plan_ex_groups:"MASHQLAR ({n} GURUH) →",
    plan_show_ex:"MASHQLARNI KO‘RSATISH ({n} GURUH) →",
    plan_time_taken:"{dt} vaqtiga «{title}» treningi allaqachon bor. Boshqa vaqt tanlaysanmi?",
    prog_weight_range:"Vazn grafigi: {a} dan {b} gacha",
    ref_step1:"Do‘sting bilan havolani ulash",
    ref_step2:"Do‘sting GymBot’da ro‘yxatdan o‘tadi",
    ref_step3:"Sen {n} ball olasan",
    ref_step4:"Do‘sting boshlang‘ich bonus oladi",
    sup_per_pack:"Qadoqda {n} porsiya",
    sup_tabs:"{a}mg ({b} ta 100mg tabletka)",
    u_dn:"kun",
    u_km:"km",
    u_let:"yosh",
    u_povt:"takr",
    u_t:"t",
    // ── Батч 2 и 3, переводы получены 06.10.2026 ───────────────────────
    // Батч 2 — тексты из шаблонных строк, батч 3 — многострочные
    // текстовые узлы JSX: ни те, ни другие построчный поиск не находит.
    ui_1_porciya:"1 porsiya =",
    ui_ai_zaprosov_v_den:"Kunlik AI so‘rovlar:",
    ui_ball:"ball.)",
    ui_dobavit_svoe_uprazhnenie:"⭐ O‘Z MASHQINGNI QO‘SH",
    ui_dobavit_svoy_produkt:"＋ O‘Z MAHSULOTINGNI QO‘SH",
    ui_izmenenie_za_3_nedeli:"3 haftadagi o‘zgarish:",
    ui_kg_za_period:"davrda kg",
    ui_limit_ai_zaprosov_na:"💬 Bugungi AI so‘rovlar limiti tugadi — baholash ertaga mavjud bo‘ladi",
    ui_napishi_pravilnoe_nazvanie_ili:"Taomning to‘g‘ri nomi yoki tarkibini yoz. Kaloriya va BJU avtomatik qayta hisoblanadi.",
    ui_naydeno_v_kataloge:"⚠ Katalogdan topildi:",
    ui_ne_prosto_spisok_uprazhneniy:"Shunchaki mashqlar ro‘yxati emas — tarixingni haqiqatan biladigan va senga moslashadigan murabbiy.",
    ui_ne_udalos_poluchit_ocenku:"AI bahosini olib bo‘lmadi — ulanishni tekshir",
    ui_peremeschay_i_uvelichivay_chto:"Taom to‘liq sig‘ishi uchun sur va kattalashtir",
    ui_podhod:"YONDASHUV",
    ui_poka_nikto_ne_v:"Reytingda hali hech kim yo‘q. Trening qil va ball to‘pla!",
    ui_polnaya_zapis_v_razdele:"↗ To‘liq yozuv Treninglar → ⚽ Sport bo‘limida",
    ui_poprobuy_otkryt_cherez_telegra:"Telegram-bot orqali ochib ko‘r.",
    ui_poprobuy_smenit_uprazhnenie_il:"💡 Mashqni almashtirib yoki drop-set qo‘shib ko‘r — murabbiydan so‘ra",
    ui_posledniy_raz:"OXIRGI MARTA (",
    ui_primenenie_vitaminov_i_dobavok:"⚠️ Vitaminlar va qo‘shimchalardan foydalanish tavsiyaviy xarakterga ega va tibbiy tavsiya hisoblanmaydi. Qo‘llashdan oldin shifokor bilan maslahatlashing.",
    ui_privet_treniruyus_v_gymbot:"Salom! Men GymBot — Telegram’dagi aqlli AI murabbiy bilan shug‘ullanaman. Havolam orqali qo‘shil va bonus ballar ol",
    ui_referalnaya_programma_vremenno:"Referal dasturi vaqtincha mavjud emas",
    ui_seriya:"🔥 Seriya:",
    ui_sleduyuschiy:"Keyingi:",
    ui_taymer_avtomaticheski_zapuskae:"Trening vaqtida har bir yondashuvdan keyin taymer avtomatik ishga tushadi.",
    ui_tochnost:"ANIQLIK:",
    ui_trenirovka_ne_naydena_ili:"Trening topilmadi yoki kirish huquqi yo‘q.",
    ui_vybrano_grupp:"TANLANGAN GURUHLAR:",
    ui_zamenit:"ALMASHTIRISH",
    ui_zdes_mozhno_ispolzovat_otdelno:"Bu yerda alohida ishlatish mumkin.",
  },
  kz: {
    menu_nutrition:"Тамақтану", menu_workout:"Жаттығулар", menu_progress:"Прогресс",
    menu_catalog:"Каталог", menu_ai:"Жаттықтырушы", menu_checkin:"Тексеру",
    menu_measurements:"Дене өлшемдері", menu_goals:"Мақсаттар", menu_supplements:"Қоспалар",
    menu_support:"Қолдау", menu_language:"Тіл", menu_sport:"Спорт түрлері",
    menu_gamification:"Менің статусым", menu_food_guide:"Өнімдер каталогы",
    menu_referral:"Досты шақыру", menu_photo_kbju:"Фото → Калория",
    menu_rest_timer:"Демалыс таймері", menu_plan:"Жоспарлау", menu_reminders:"Еске салулар",
    menu_tab_menu:"Мәзір", menu_tab_workout:"Жаттығулар", menu_tab_progress:"Прогресс",
    menu_tab_catalog:"Каталог", menu_tab_ai:"Жаттықтырушы",
    section_quick:"ЖЫЛДАМ ҚАТЫНАС", section_catalog:"КАТАЛОГ", section_profile:"ПРОФИЛЬ",
    start_workout:"▶ ЖАТТЫҒУДЫ БАСТАУ", back:"← АРТҚА",
    today:"БҮГІН", loading:"ЖҮКТЕЛУДЕ", save:"САҚТАУ", cancel:"БОЛДЫРМАУ",
    add:"ҚОСУ", edit:"ӨЗГЕРТУ", delete:"ЖОЮ", close:"ЖАБУ",
    save_profile:"САҚТАУ", cancel_btn:"БОЛДЫРМАУ", edit_profile:"ПРОФИЛЬДІ ӨЗГЕРТУ",
    edit_profile_btn:"ӨЗГЕРТУ →", profile_title:"МЕНІҢ ПРОФИЛІМ",
    my_profile:"МЕНІҢ ПРОФИЛІМ", not_specified:"Көрсетілмеген", allergies:"АЛЛЕРГИЯЛАР",
    level:"ДЕҢГЕЙ", goal_label:"МАҚСАТ", no_conditions:"Шектеулер жоқ",
    no_allergies:"Аллергия жоқ", reset_btn:"ТАЗАЛАУ", status_label:"СТАТУС",
    fitness_level_label:"ДАЙЫНДЫҚ ДЕҢГЕЙІ", my_rating:"МЕНІҢ РЕЙТИНГІМ",
    points_label:"БАЛЛДАР", rank_label:"ДӘРЕЖЕ",
    plateau_title:"ПЛАТО ДЕТЕКТОРЫ", plateau_weight:"Салмақ өзгермейді",
    plateau_exercise:"Тоқырап қалған жаттығулар", plateau_none:"Плато анықталмады",
    referral_title:"ДОСТЫ ШАҚЫРУ", referral_your_code:"Сіздің кодыңыз",
    referral_link:"Реферал сілтеме", referral_friends:"Шақырылған достар",
    referral_bonus:"Шақыру үшін балл",
    workout_title:"ЖАТТЫҒУЛАР", workouts_title:"ЖАТТЫҒУЛАР",
    no_workouts:"Әлі жаттығулар жоқ", no_workouts_yet:"Әлі жаттығулар жоқ",
    tonnage_label:"ТОННАЖ", no_sport_yet:"Әлі сабақтар жоқ",
    planned_tab:"📅 ЖОСПАР", sport_tab:"⚽ СПОРТ", archive_tab:"📋 МҰРАҒАТ",
    no_planned:"Жоспарланған жаттығулар жоқ", planned_archive:"ЖОСПАРЛАНҒАН МҰРАҒАТ",
    nutrition_title:"КҮНДЕЛІК", add_meal:"+ қосу",
    water_label:"💧 СУ", glasses_unit:"стакан",
    ask_trainer:"Тамақтану туралы жаттықтырушыдан сұрау",
    meal_breakfast:"Таңғы ас", meal_lunch:"Түскі ас", meal_dinner:"Кешкі ас", meal_snack:"Тағамдық",
    progress_title:"ПРОГРЕСС", catalog_title:"ЖАТТЫҒУЛАР", ai_title:"ЖАТТЫҚТЫРУШЫ",
    food_search_title:"КАТАЛОГ", food_search_placeholder:"Өнімді іздеу...",
    add_to_diary:"КҮНДЕЛІККЕ ҚОСУ", weight_label:"САЛМАҚ (г)",
    sport_record:"САБАҚТЫ ЖАЗ", sport_duration:"ҰЗАҚТЫҒЫ (МИН)",
    sport_intensity:"ҚАРҚЫНДЫЛЫҚ", sport_date:"КҮН", sport_notes:"ЖАЗБАЛАР",
    sport_type_label:"СПОРТ ТҮРІ", sport_notes_opt:"ЖАЗБАЛАР (МІНДЕТТІ ЕМЕС)",
    sport_saved:"ЖАЗЫЛДЫ", sport_save_btn:"✓ САБАҚТЫ ЖАЗ",
    score_opt:"НӘТИЖЕ (МІНДЕТТІ ЕМЕС)", score_label:"НӘТИЖЕ",
    intensity_low:"🟢 Төмен", intensity_medium:"🟡 Орташа", intensity_high:"🔴 Жоғары",
    time_label:"УАҚЫТ", intensity_label:"ҚАРҚЫНДЫЛЫҚ", calories_label:"КАЛОРИЯ",
    archive_label:"МҰРАҒАТ",
    choose_type:"НЕ ЖАСАЙМЫЗ?", choose_type_label:"ТҮРДІ ТАҢДАҢЫЗ",
    gym_title:"Жаттығу залы", gym_desc:"Күш жаттығулары, бұлшықет пен жаттығу таңдау",
    sport_section:"Спорт түрлері", sport_desc:"Калория есебімен сабақты жазу",
    sport_section_title:"Спорт түрлері", sport_section_desc:"Калория есебімен сабақты жазу",
    resume_workout:"ЖАТТЫҒУДЫ ЖАЛҒАСТЫРУ", resume_desc:"Аяқталмаған жаттығуыңыз бар",
    workout_closed_elsewhere:"Алдыңғы жаттығу аяқталған — басқа құрылғыда немесе автоматты түрде. Жаңасын бастауға болады.",
    finish_workout:"АЯҚТАУ", workout_empty_note:"Бірде-бір тәсіл жазылмады — жаттығу есептелмеді және тарихқа түспеді.", set_done:"✓ ТӘСІЛ ОРЫНДАЛДЫ", set_done_label:"ТӘСІЛ ОРЫНДАЛДЫ",
    premium_menu:"Premium", premium_kicker:"PREMIUM", premium_title:"GymBot Premium", premium_lead:"Жаттықтырушыға көбірек сұрақ және тамақты көбірек тану — әрі GymBot дамуына қолдау.", premium_active_until:"Premium {date} дейін белсенді", premium_trial_until:"Сынақ Premium {date} дейін", premium_manual:"Premium белсенді", premium_perk_ai:"Күніне {n} жаттықтырушы сұрағы", premium_perk_food:"Күніне {n} тамақ суреті", premium_perk_now:"Premium-сыз — {n}", premium_perk_support:"Жаңа мүмкіндіктер тезірек: сіз қолданбаның дамуын қолдайсыз", premium_month:"Ай", premium_year:"Жыл", premium_month_note:"әр 30 күн сайын ұзартылады, кез келген уақытта өшіруге болады", premium_year_note:"365 күнге бір реттік төлем", premium_save:"{n}% үнем", premium_buy:"{n} ⭐ алу", premium_extend:"{n} ⭐ ұзарту", premium_trial_btn:"{n} күн тегін байқап көру", premium_renews:"Жазылым {date} ұзартылады", premium_renew_off:"Автоұзарту өшірулі — Premium {date} дейін", premium_cancel_btn:"Автоұзартуды өшіру", premium_resume_btn:"Автоұзартуды қосу", premium_paid_wait:"Төлем өтті — Premium қосылуда…", premium_paid_ok:"Premium {date} дейін қосылды. Рахмет!", premium_paid_late:"Төлем өтті. Premium бірнеше минутта қосылады — бот хабарлама жібереді.", premium_failed:"Төлем өтпеді. Қайта көріңіз.", premium_error:"Төлемді ашу мүмкін болмады. Кейінірек көріңіз.", premium_already_sub:"Жазылым бұрыннан бар.", premium_note:"Telegram жұлдыздарымен төлем. Автоұзартуды осында немесе Telegram-да өшіруге болады: Баптаулар → Менің жұлдыздарым. Төлем бойынша сұрақтар — боттағы /paysupport командасы.", premium_nudge_ai:"Premium-мен — күніне {n} жаттықтырушы сұрағы", premium_nudge_food:"Premium-мен — күніне {n} тамақ суреті", premium_nudge_btn:"Толығырақ", share_kicker:"БӨЛІСУ", share_story:"Тарихқа", share_chat:"Чатқа", share_preparing:"Карточка дайындалуда…", share_sent_bot:"Карточка ботпен чатта — оны достарыңызға жіберіңіз", share_error:"Карточканы дайындау мүмкін болмады. Қайта көріңіз.",
    soc_menu:"Достар мен командалар", soc_kicker:"ҚАУЫМДАСТЫҚ", soc_title:"Достар мен командалар", tab_feed:"Лента", tab_friends:"Достар", tab_teams:"Командалар", soc_invite_title:"Достарды шақырыңыз", soc_invite_hint:"Достар бір-бірінің жаттығулары мен рекордтарын көріп, 👏 қояды. Салмақ, тамақтану және денсаулық ешқашан көрсетілмейді.", soc_invite_btn:"Досты шақыру", soc_copy:"Сілтемені көшіру", soc_copied:"Сілтеме көшірілді", soc_share_text:"GymBot-та бірге жаттығамыз 💪", soc_privacy:"Жаттығуларымды достарға көрсету", soc_friends_empty:"Әзірге достар жоқ — шақыру жіберіңіз.", soc_week_n:"осы аптада {n} жаттығу", soc_remove:"Жою", soc_remove_confirm:"{name} достардан жойылсын ба?", soc_feed_empty:"Мұнда сіздің және достарыңыздың жаттығулары болады.", soc_you:"Сіз", soc_sets:"{n} тәсіл", soc_tonnage:"{n} т", soc_min:"{n} мин", soc_record:"Рекорд: {ex} — {w} кг (бұрын {p})", soc_more:"Тағы көрсету", soc_accepted:"Сіз енді {name} екеуіңіз доссыз", soc_already:"{name} бұрыннан досыңыз", soc_bad_code:"Сілтеме ескірген немесе қате", soc_own_code:"Бұл өз сілтемеңіз 🙂", soc_teams_empty:"Әзірге командалар жоқ. Өзіңіздікін құрыңыз немесе код арқылы қосылыңыз.", soc_team_create:"Команда құру", soc_team_name:"Команда атауы", soc_team_join:"Код арқылы қосылу", soc_team_code:"Команда коды", soc_team_members:"{n} қатысушы", soc_team_week:"Осы апта: {n} жаттығу", soc_team_place:"Сіздің орныңыз: {n}", soc_team_invite:"Командаға шақыру", soc_team_leave:"Командадан шығу", soc_team_leave_confirm:"«{name}» командасынан шығасыз ба?", soc_team_rename:"Атауын өзгерту", soc_team_joined:"Сіз «{name}» командасындасыз", soc_team_full:"Командада 50 адам бар", soc_too_many_teams:"Ең көбі 5 командада болуға болады", soc_board_title:"АПТА РЕЙТИНГІ", soc_board_hint:"Дүйсенбіден бергі аяқталған жаттығулар есептеледі", soc_last_week:"өткен: {n}", soc_owner:"иесі", soc_share_team_text:"GymBot-тағы «{name}» командамызға қосыл 💪", soc_remove_member:"Шығару", soc_remove_member_confirm:"{name} командадан шығарылсын ба?",
    wn_kicker:"НЕ ЖАҢАЛЫҚ", wn_kicker_new:"БІЛГЕН ЖӨН", wn_menu:"Не жаңалық", wn_skip:"Өткізіп жіберу", wn_next:"Келесі", wn_done:"Дайын", wn_str_d:"Қаншалықты күштісіз — біліңіз: әр жаттығуда деңгей — «{a}»-тан «{b}»-ға дейін.", wn_str_1:"Жыныс, дене салмағы және жас ескеріледі", wn_str_2:"GymBot-тың басқа спортшыларымен салыстыру", wn_str_3:"Келесі деңгейге дейін қанша қосу керек", wn_str_b:"Менің деңгейім", wn_food_t:"Палау, лағман, самса", wn_food_d:"Тамақтану күнделігінде жергілікті тағамдар бар, тағам суреті оларды таниды.", wn_food_1:"Калориясы мен құрамы көрсетілген 37 ұлттық тағам", wn_food_2:"Заттаңба сканері: қаптаманы суретке түсіріңіз — құрамы өзі толтырылады", wn_food_3:"Атаулары орыс, өзбек және қазақ тілдерінде", wn_food_b:"Заттаңбаны сканерлеу", wn_prog_d:"6–12 аптаға арналған дайын жоспарлар: әр күні не істеу, қанша тәсіл және қайталау.", wn_prog_1:"Зал мен үйге, жаңадан бастаушылар мен тәжірибелілерге", wn_prog_2:"Қосымша келесі күнді айтып береді", wn_prog_3:"3 бағдарлама — тегін", wn_prog_3_all:"Барлық бағдарламалар — тегін", wn_prog_b:"Бағдарлама таңдау", wn_soc_d:"Бірге жаттығу қызықты — әрі өткізіп алу қиынырақ.", wn_soc_1:"Достардың жаттығулары мен рекордтарының лентасы, еңбегіне 👏", wn_soc_2:"Апталық жаттығу рейтингі бар командалар", wn_soc_3:"Достар салмақты, тамақтануды және денсаулықты көрмейді", wn_soc_b:"Досты шақыру", wn_prem_d:"Байыпты жаттығатындарға көбірек мүмкіндік.", wn_prem_1:"Күніне {n} дейін AI-жаттықтырушыға сұрақ", wn_prem_2:"Күніне {n} дейін тағам суреті", wn_prem_3:"Барлық жаттығу бағдарламалары; Telegram жұлдыздарымен төлем", wn_prem_b:"Толығырақ", wn_prem_trial:"{n} күн тегін байқап көру",
    prog_menu:"Жаттығу бағдарламалары", prog_kicker:"БАҒДАРЛАМАЛАР", prog_title:"Жаттығу бағдарламалары", prog_lead:"Бірнеше аптаға дайын жоспарлар: әр күні не істеу керек, қанша тәсіл мен қайталау.", prog_meta:"аптасына {d} жаттығу · {w} апта", prog_active:"СІЗДІҢ БАҒДАРЛАМАҢЫЗ", prog_progress:"{t} жаттығудың {n}-сі", prog_next:"Келесісі: {day}", prog_start_day:"Бастау: {day}", prog_start:"Бағдарламаны бастау", prog_replace_confirm:"Қазір «{cur}» жүріп жатыр. Оның орнына жаңа бағдарламаны бастайсыз ба?", prog_stop:"Бағдарламаны тоқтату", prog_stop_confirm:"Бағдарламаны тоқтатасыз ба? Орындалған жаттығулар тарихта қалады.", prog_unlock:"Premium-мен ашу", prog_tip:"КЕҢЕС", prog_days:"БАҒДАРЛАМА КҮНДЕРІ", prog_rest_s:"демалыс {n} с", prog_rest_m:"демалыс {n} мин", prog_reps_max:"макс.", prog_sec:"с", prog_finished:"Бағдарлама аяқталды! Келесісін таңдаңыз.", prog_free:"Тегін", prog_week:"{n}-апта", prog_not_in_catalog:"каталогта жоқ", prog_is_active:"Жүріп жатыр", prog_all:"Барлық бағдарламалар", prog_open:"Ашу",
    fcat_national:"Ұлттық тағамдар", label_scan_btn:"Затбелгіні сканерлеу", fv_mode_dish:"Тағам", fv_mode_label:"Затбелгі", label_kicker:"ЗАТБЕЛГІ СКАНЕРІ", label_title:"Затбелгі суреті", label_hint:"Қаптамадағы тағамдық құндылық кестесін суретке түсіріңіз — 100 г-ға КБЖУ-ды толтырамыз, ал өнімді анықтамалыққа сақтаймыз.", label_photo_btn:"Затбелгіні суретке түсіру", label_read_btn:"Тану", label_reading:"ЗАТБЕЛГІ ОҚЫЛУДА…", label_not_found:"Суретте тағамдық құндылық кестесі көрінбейді. Оны жақынырақ және тігірек түсіріңіз.", label_failed:"Затбелгіні оқу мүмкін болмады. Қайта көріңіз.", label_name:"Атауы", label_brand:"Бренд", label_per100:"100 г-да", label_low_conf:"Сандарды тексеріңіз: кейбірі дәл оқылмаған болуы мүмкін.", label_portion:"Қанша жедіңіз, г", label_pack_portion:"қаптамадағы порция", label_save_log:"Күнделікке жазу", label_save_only:"Тек анықтамалыққа сақтау", label_saved_only:"Сақталды — оны іздеуден табуға болады.", label_total:"{w} г үшін барлығы", food_portion_approx:"порция ~{n} г",
    str_e1rm:"есептік максимум", str_menu:"Күш деңгейлері", str_kicker:"КҮШ", str_title:"Күш деңгейлері", str_overall:"Жалпы деңгей", str_stronger:"Жаттығатындардың ~{n}%-нан күштірек", str_basis:"Жынысыңыз, дене салмағыңыз және жасыңыз үшін күш нормативтері бойынша баға. Максимум 12 қайталауға дейінгі ең үздік тәсіл бойынша есептеледі (Эпли формуласы).", str_missing:"Деңгейлерді есептеу үшін профильде жынысыңыз бен салмағыңызды көрсетіңіз.", str_btn_profile:"Профильді толтыру", str_to_next:"«{lvl}» деңгейіне дейін: +{n} {u}", str_top:"Ең жоғары деңгей — құттықтаймыз!", str_community:"GymBot пайдаланушылары арасында: {m} адамның {n}%-нан күштірек", str_untracked:"Әзірге деңгейсіз", str_untracked_hint:"Осы жаттығулардың бірінде тәсіл жасаңыз — деңгей өзі пайда болады.", str_all:"Барлық деңгейлер", str_from:"ең үздік тәсіл {w} кг × {r}", str_from_reps:"ең үздік тәсіл — {r} қайт.", str_reps:"қайт.", str_on:"{n} жаттығу бойынша", str_empty:"Негізгі жаттығуларда әзірге тәсілдер жоқ — олармен алғашқы жаттығудан кейін деңгейлер пайда болады.", str_lvl_start:"Старт", str_lvl_beginner:"Жаңадан бастаушы", str_lvl_novice:"Бастауыш", str_lvl_intermediate:"Орташа", str_lvl_advanced:"Озық", str_lvl_elite:"Элита",
    terms_menu:"Пайдалану ережелері", terms_kicker:"ҚҰЖАТ", terms_title:"Пайдалану ережелері", terms_updated:"2026 жылғы 24 қазандағы редакция", terms_read:"Ережелерді оқу", terms_premium_link:"Premium шарттары, тоқтату және қайтару", terms_close:"Жабу", terms_s_general_t:"1. Жалпы ережелер", terms_s_general_b:"GymBot — Telegram-дағы AI-жаттықтырушысы бар жаттығу және тамақтану күнделігі. Оны 18 жастан пайдалануға болады.\n\nAI-жаттықтырушының кеңестері, сурет бойынша калория бағасы және жүктеме ұсыныстары анықтамалық сипатта және медициналық тағайындау емес. Жаттығу, тамақтану және қоспалар туралы шешімді денсаулығыңызды ескеріп, өзіңіз қабылдайсыз. Ауру немесе қарсы көрсетілімдер болса, дәрігермен кеңесіңіз.\n\nҚолданбаны спам, қорлау және бөгде адамдардың деректері үшін пайдалануға болмайды. Ол үшін қолжетімділікті шектеуіміз мүмкін.", terms_s_data_t:"2. Деректер", terms_s_data_b:"Қандай деректер жиналатыны және кімге берілетіні келісімдерде жазылған. Оларды профильде көруге болады; денсаулық туралы мәліметтерге және деректерді AI-сервиске беруге келісімдерді кез келген уақытта қайтарып алуға болады.", terms_s_prem_t:"3. Premium", terms_p_what:"Premium — қолданбаның ақылы бөлігі: күніне AI-жаттықтырушыға көбірек сұрақ және тамақты сурет бойынша көбірек тану, сондай-ақ Premium экранында көрсетілген басқа мүмкіндіктер. Ағымдағы лимиттер сонда көрсетілген. Premium құрамы кеңеюі мүмкін.", terms_p_pay:"Төлем — тек Telegram жұлдыздарымен (Telegram Stars), Telegram ішінде. Қазір ай {pm} ⭐, жыл — {py} ⭐ тұрады. Баға өзгерсе, төленген кезең қайта есептелмейді.", terms_p_pay_np:"Төлем — тек Telegram жұлдыздарымен (Telegram Stars), Telegram ішінде. Ағымдағы бағалар Premium экранында көрсетілген. Баға өзгерсе, төленген кезең қайта есептелмейді.", terms_p_month:"Ай — бұл жазылым: әр 30 күн сайын Telegram сіз тоқтатқанша сол соманы автоматты түрде алады. Кез келген уақытта тоқтатуға болады — Premium экранында «Автоұзартуды өшіру» батырмасымен немесе Telegram-да: Баптаулар → Менің жұлдыздарым. Тоқтатқаннан кейін Premium төленген кезеңнің соңына дейін жұмыс істейді, жаңа төлемдер болмайды.", terms_p_year:"Жыл — 365 күнге бір реттік төлем, автоұзартусыз. Егер бұл кезде айлық жазылымыңыз жұмыс істеп тұрса, жұлдыздар екі рет алынбауы үшін оны өшіреміз.", terms_p_trial:"Сынақ кезеңі — {n} күн тегін, әр аккаунтқа бір рет. Ол өздігінен ұзартылмайды және ештеңе алмайды.", terms_p_refund:"Қайтару. Егер жұлдыздар алынса, бірақ Premium қосылмаса, немесе төлем қателікпен не екі рет өтсе — боттағы /paysupport командасымен қолдауға жазып, төлем күнін көрсетіңіз. Қайтарғанда жұлдыздар Telegram шотыңызға қайтады, ал осы төлем үшін Premium күндері толық алынып тасталады. Пайдаланылған уақыт үшін қайтару жеке қаралады.", terms_p_account:"Premium Telegram аккаунтыңызға байланған және басқа адамдарға берілмейді.", terms_s_support_t:"4. Қолдау", terms_s_support_b:"Сұрақтар мен шағымдар — қолданбаның «Қолдау» бөлімінде, төлем бойынша сұрақтар — боттағы /paysupport командасымен. Ботпен чатта жауап береміз.\n\nЕрежелер өзгеруі мүмкін. Елеулі өзгерістер туралы ботта хабарлаймыз.",
    warmup_title:"ЖЫЛЫТУ", warmup_skip:"ӨТКІЗІП ЖІБЕРу", warmup_done:"✓ ЖЫЛЫТУ ОРЫНДАЛДЫ",
    warmup_hint:"Жылыту үшін кардио — міндетті емес", warmup_badge:"🏃 ЖЫЛЫТУ",
    ready_wk_kicker:"ЖАТТЫҒУ ЖИНАЛДЫ", ready_wk_hint:"Құрамы жаттығу тарихыңыз бойынша таңдалды", ready_wk_program:"Құрамы — бағдарламаңыздан", ready_wk_change:"Құрамын өзгерту",
    rest_notify_title:"Демалыс сигналы", rest_notify_hint:"Демалыс біткенде бот хабар жібереді. Телефонды қалтаға салыңыз — сағат дірілдейді.", rest_notify_on:"Қосулы", rest_notify_off:"Өшірулі",
    rest_offer_kicker:"КЕҢЕС", rest_offer_title:"Жаттығу кезінде телефонды алып қоясыз ба?", rest_offer_text:"Бот демалыс аяқталғанын өзі білдіреді. Телефонды ұстап тұрудың қажеті жоқ — сағат немесе білезік дірілдейді.", rest_offer_yes:"Қосу", rest_offer_no:"Керек емес",
    order_title:"ТӘРТІП", order_hint:"↑↓ — қайта орналастыру · ↔ — ауыстыру",
    muscles_title:"БҰЛШЫҚЕТ ТОПТАРЫ", exercises_title:"ЖАТТЫҒУЛАР", replace_title:"АУЫСТЫРУ", show_all_exercises:"БАРЛЫҚ ЖАТТЫҒУЛАРДЫ КӨРСЕТУ",
    select_groups_hint:"Бір немесе бірнеше топ таңдаңыз → жаттығуларды көрсетеміз",
    step_1_4:"ҚАДАМ 1 / 4", step_2_4:"ҚАДАМ 2 / 4", step_3_4:"ҚАДАМ 3 / 4", step_4_4:"ҚАДАМ 4 / 4",
    weight_kg:"САЛМАҚ (КГ)", reps_label:"РЕТ", time_sec:"УАҚЫТ (СЕК)",
    distance_km:"ҚАШЫҚТЫҚ (КМ)", prev_btn:"← АЛДЫҢҒЫ", next_btn:"КЕЛЕСІ →",
    workout_done:"ЖАТТЫҒУ АЯҚТАЛДЫ", workout_complete:"ЖАТТЫҒУ АЯҚТАЛДЫ",
    great_work:"Тамаша жұмыс!", analyzing:"ЖАТТЫҒУ ТАЛДАНУДА...",
    workout_sets:"ЖАТТЫҒУ ҚҰРАМЫ", no_sets:"Жазбалар жоқ", reps_short:"РЕТ",
    error_label:"ҚАТЕ", load_error:"ЖҮКТЕУ МҮМКІН ЕМЕС",
    water_hint:"← бір стакан су белгілеу үшін басыңыз",
    ai_thinking:"ТАЛДАНУДА...", ai_ask:"ЖАТТЫҚТЫРУШЫДАН СҰРАу", ai_limit:"⚠️ AI сұраулар лимиті таусылды",
    goal_health:"Денсаулық",
    goal_lose:"Салмақ жоғалту",
    goal_muscle:"Бұлшықет өсіру",
    goal_strength:"Күш",
    goal_endurance:"Төзімділік",
    level_beginner:"Бастаушы",
    level_intermediate:"Орта",
    level_advanced:"Озық",
    difficulty_easy:"Жеңіл",
    difficulty_medium:"Орташа",
    difficulty_hard:"Қиын",
    gender_male:"Ер",
    gender_female:"Әйел",
    next_btn2:"КЕЛЕСІ →",
    back_to_menu:"← МӘЗІРГЕ",
    search_placeholder:"ІЗДЕУ...",
    enter_name:"Атыңыз",
    enter_goal:"МАҚСАТЫҢЫЗ НЕ?",
    hello_name:"СӘЛЕМ! АТЫҢЫЗ КІМ?",
    name_hint:"Атыңыз қосымшада көрсетіледі",
    sets_label:"ТӘСІЛДЕР",
    reps_label2:"РЕТ",
    exercises_label:"ЖАТТЫҒУЛАР",
    minutes_label:"МИНУТ",
    tonnage_label2:"ТОННАЖ",
    volume_label:"КӨЛЕМ",
    weight_label2:"САЛМАҚ",
    date_label:"КҮН",
    time_label2:"УАҚЫТ",
    difficulty_label:"ҚИЫНДЫҚ",
    equipment_label:"ЖАБДЫҚТАР",
    description_label:"СИПАТТАМА",
    technique_label:"ОРЫНДАУ ТЕХНИКАСЫ", tech_offline:"Техника байланыс қалпына келгенде жүктеледі.",
    more_info:"ТОЛЫҒЫРАҚ →",
    open_plan:"ҚҰРАМЫН АШУ →",
    continue_workout2:"ЖАТТЫҒУДЫ ЖАЛҒАСТЫРУ",
    unfinished:"Аяқталмаған жаттығуыңыз бар",
    skip_warmup:"ЖЫЛЫТУДЫ ӨТКІЗІП ЖІБЕРу",
    warmup_time:"ҰСЫНЫЛАТЫН ЖЫЛЫТУ УАҚЫТЫ",
    replace_exercise:"↔ ЖАТТЫҒУДЫ АУЫСТЫРУ",
    do_replace:"↔ АУЫСТЫРУ",
    add_exercise:"+ ЖАТТЫҒУ ҚОСУ",
    add_during:"ЖАТТЫҒУ ҚОСУ",
    my_exercise:"ӨЗ ЖАТТЫҒУЫМ",
    all_exercises:"БАРЛЫҚ ЖАТТЫҒУЛАР →",
    show_exercises:"БАРЛЫҚ ЖАТТЫҒУЛАРДЫ КӨРСЕТу →",
    order_hint2:"↑↓ — тәртіп · ↔ — ауыстыру",
    steps_1_4:"ҚАДАМ 1 / 4",
    steps_2_4:"ҚАДАМ 2 / 4",
    steps_3_4:"ҚАДАМ 3 / 4",
    steps_4_4:"ҚАДАМ 4 / 4",
    steps_1_2:"ҚАДАМ 1 / 2",
    steps_2_2:"ҚАДАМ 2 / 2",
    plan_step1:"ЖОСПАРЛАУ · ҚАДАМ 1",
    plan_step2:"ЖОСПАРЛАУ · ҚАДАМ 2",
    plan_step3:"ЖОСПАРЛАУ · ҚАДАМ 3",
    calories_label2:"КАЛОРИЯ",
    proteins_label:"АҚУЫЗДАР",
    fats_label:"МАЙЛАР",
    carbs_label:"КӨМІРСУЛАР",
    kcal_unit:"ккал",
    kcal_per100:"ккал/100г",
    protein_g:"Ақуыз г",
    fat_g:"Май г",
    carb_g:"Көмірсу г",
    weight_g:"Салмақ (кг)",
    portions_label:"АС ТҮРІ",
    add_meal2:"КҮНДЕЛІККЕ ҚОСУ",
    add_product:"ӨНІМ ҚОСУ",
    new_product:"ЖАҢА ӨНІМ (100г үшін)",
    product_catalog:"ӨНІМДЕР КАТАЛОГЫ",
    food_catalog_title:"ӨНІМДЕР АНЫҚТАМАСЫ",
    food_catalog_kbju:"100Г ҮШІН",
    search_product:"Өнімді іздеу...",
    product_name:"Өнім атауы *",
    dish_name:"Тағам атауы",
    add_custom_product:"+ ӨЗ ӨНІМІМДІ ҚОСУ",
    product_exists:"Бұл атаулы өнім бұрыннан бар",
    calories_short:"Ккал",
    calories_req:"Ккал *",
    carbs_short:"Көмірсу",
    photo_kbju_title:"ФОТО → КАЛОРИЯ",
    photo_kbju_hint:"Тағамды суретке түсіріңіз — AI калорияны санайды",
    analyzing_photo:"AI СУРЕТТІ ТАЛДАУДА...",
    analyze_btn:"🔍 ТАЛДАУ",
    new_photo:"ЖАҢА ФОТО",
    add_to_diary2:"💾 КҮНДЕЛІККЕ",
    add_photo:"ФОТО ҚОСУ",
    ai_nutrition_title:"AI ТАМАҚТАНУ",
    saved_to_diary:"✓ ТАМАҚТАНУ КҮНДЕЛІГІНЕ САҚТАЛДЫ",
    measurements_title2:"ДЕНЕ ӨЛШЕМДЕРІ",
    measurements_cat:"АНТРОПОМЕТРИЯ",
    save_measurements:"ӨЛШЕМДЕРДІ САҚТАУ",
    measurements_saved:"✓ ӨЛШЕМДЕР САҚТАЛДЫ",
    measurements_history:"ТАРИХ",
    measurements_add:"ҚОСУ",
    measurements_none:"Әлі өлшемдер жоқ",
    waist:"Бел",
    hips:"Жамбас",
    chest:"Кеуде",
    arm:"Қол (бицепс)",
    thigh:"Сан",
    checkin_title2:"ТЕКСЕРУ",
    checkin_weekly:"АПТАЛЫҚ",
    checkin_saved:"ТЕКСЕРУ САҚТАЛДЫ",
    send_checkin:"ТЕКСЕРУДІ ЖІБЕРУ",
    checkin_ai_hint:"AI жаттықтырушы жаңартылған деректерді алды",
    sleep_hours:"ҰЙҚЫ (САҒАТ)",
    energy_label:"Энергия",
    stress_label:"Стресс",
    motivation_label:"Мотивация",
    profile_fill:"Профильді толтырыңыз",
    profile_fill_hint:"Жаттығуларды бейімдеу үшін профильді толтырыңыз",
    profile_edit:"✏ ПРОФИЛЬДІ ӨЗГЕРТУ",
    edit_date:"✏ КҮНДІ/ҚҰРАМДЫ ӨЗГЕРТУ",
    age_label:"Жас",
    age_years:"Жас (жылдар)",
    height_label:"Бой",
    height_cm:"Бой (см)",
    bmi_label:"ДСИ",
    gender_label:"ЖЫН",
    ai_style_label:"AI ҚАРЫМ-ҚАТЫНАС СТИЛІ",
    status_saved:"✓ САҚТАЛДЫ",
    profile_saved2:"✓ ӨЛШЕМДЕР САҚТАЛДЫ",
    ai_bro_desc:"Жастар, сленг, мотивация",
    ai_mentor_desc:"Орташа, қолдау, кеңес",
    ai_expert_desc:"Кәсіби, терминдер",
    ai_bro_name:"Фитнес-бро",
    med_label:"МЕДИЦИНАЛЫҚ КӨРСЕТКІШТЕР",
    no_med:"Шектеулер жоқ",
    supps_label:"💊 МЕНІҢ ҚОСПАЛАРЫМ",
    quick_select:"ЖЫЛДАМ ТАҢДАУ",
    manual_input:"НЕМЕСЕ ӨЗ ҚОЛЫҢЫЗБЕН ЕНГІЗІҢІЗ",
    supp_name:"Қоспа атауы...",
    supp_dose:"Дозасы (мысалы 5г)",
    supp_timing:"Уақыты (таңертең, жаттығуға дейін)",
    not_specified2:"Көрсетілмеген",
    gamification_title2:"МЕНІҢ СТАТУСЫМ",
    my_rating2:"МЕНІҢ РЕЙТИНГІМ",
    status_label2:"СТАТУС",
    points_label2:"БАЛЛДАР",
    rank_label2:"ДӘРЕЖЕ",
    leaderboard_title:"ЖЕТЕКШІЛЕР КЕСТЕСІ",
    my_position:"МЕНІҢ ОРНЫМ",
    how_earn:"БАЛЛ ҚАЛАЙ ЖИНАУҒА БОЛАДЫ",
    recent_points:"СОҢҒЫ ЕСЕПТЕУЛЕР",
    next_rank:"КЕЛЕСІ ДӘРЕЖЕГЕ",
    streak_series:"🔥 БЕЛСЕНДІЛІК СЕРИЯСЫ",
    achievements_title2:"ЖЕТІСТІКТЕР",
    new_achievement:"🎉 ЖАҢА ЖЕТІСТІК",
    progress_label:"ПРОГРЕСС",
    unlocked_label:"АШЫЛДЫ",
    referral_title2:"БОНУС БАҒДАРЛАМАСЫ",
    how_works:"ҚАЛАЙ ЖҰМЫС ІСТЕЙДІ",
    goals_title2:"МЕНІҢ МАҚСАТТАРЫМ",
    goals_add:"+ МАҚСАТ ҚОСУ",
    new_goal:"ЖАҢА МАҚСАТ",
    goal_desc:"Мақсат сипаттамасы...",
    goal_achieved:"ЖЕТІЛДІ",
    no_goals:"Белсенді мақсаттар жоқ. Бірінші мақсатты қойыңыз!",
    goal_target:"Мақсат",
    goal_unit:"бірлік",
    reminders_title2:"ЕСКЕ САЛУЛАР",
    reminders_cat:"ХАБАРЛАНДЫРУЛАР",
    upcoming_workouts:"АЛДАҒЫ ЖАТТЫҒУЛАР",
    no_reminders:"Алдағы жаттығулар жоқ",
    bot_reminds:"🔔 Бот еске салады",
    one_hour:"1 сағат",
    before_workout:"жаттығудан бұрын",
    plateau_check:"Плато детекторы әр жексенбі 10:30-да тексереді.",
    add_plan:"+ ЖОСПАРЛАУ",
    add_plan2:"+ ЖАТТЫҒУДЫ ЖОСПАРЛАУ",
    support_title2:"ҚОЛДАУ",
    support_cat:"КЕРІ БАЙЛАНЫС",
    support_placeholder:"Мәселеңізді сипаттаңыз, жақын арада жауап береміз",
    support_problem:"МӘСЕЛЕ НЕМЕСЕ СҰРАҚТЫ СИПАТТАҢЫЗ",
    sending:"ЖІБЕРІЛУДЕ...",
    sent:"ЖІБЕРІЛДІ",
    send_btn:"ЖІБЕРУ",
    error_send:"Жіберу қатесі. Кейінірек байқаңыз.",
    error_conn:"Қосылым жоқ. Интернетті тексеріңіз.",
    error_conn2:"Қосылым жоқ. Кейінірек байқаңыз.",
    language_title2:"ТІЛ",
    settings_title:"БАПТАУЛАР",
    current_lang:"✓ АҒЫМДАҒЫ",
    sport_title2:"СПОРТ ТҮРЛЕРІ",
    sport_cat:"СПОРТ",
    record_btn:"ЖАЗЫЛДЫ",
    sport_full_record:"Толық жазба Жаттығулар → ⚽ Спорт бөлімінде",
    score_optional:"Нәтиже, серіктер, сезімдер...",
    score_example:"Мысалы: 3:2 немесе 21:18",
    sport_planned:"📤 БӨЛІСУ",
    no_activities:"Сабақтар жоқ",
    ai_training:"AI ЖАТТЫҚТЫРУШЫ",
    greeting_back:"СӘЛЕМ,",
    greeting_back2:"ҚАЙТА КЕЛДІҢІЗ",
    greet_away:["ҚАЙТА КЕЛДІҢІЗ","КӨРІСПЕГЕЛІ ҚАШАН","ОРАЛҒАНЫҢЫЗ ЖАҚСЫ","ЖАҢАДАН БАСТАЙЫҚ"],
    greet_streak:["КЕРЕМЕТ КЕТІП БАРАСЫҢ","СЕРИЯ ҮЗІЛМЕЙДІ","БӘСЕҢДЕМЕЙСІҢ","МІНЕ БҰЛ ТӘРТІП"],
    greet_today:["БҮГІН ОРЫНДАЛДЫ","КЕРЕМЕТ ЖҰМЫС","ІС БІТТІ","ЖАРАЙСЫҢ"],
    greet_normal:["СӘЛЕМ","КӨРГЕНІМЕ ҚУАНЫШТЫМЫН","КЕТТІК","ЖҰМЫСҚА ДАЙЫН"],
    home_load_error:"Жүктеу мүмкін болмады. Байланысты тексеріңіз.", retry:"ҚАЙТАЛАУ",
    home_k_profile:"Профиль қажет", home_k_resume:"Аяқталмаған", home_k_planned:"Бүгінге жоспарланған", home_k_suggest:"Жаттықтырушы ұсынады",
    home_days_streak:"күн қатарынан", home_of:"ішінен", home_this_week:"осы аптада", home_sport:"спорт",
    home_min:"мин", home_exercises:"жаттығу", home_other_option:"Басқа нұсқа",
    home_food:"Тамақ", home_burned:"Жұмсалды", home_weight:"Салмақ", home_kg:"кг",
    home_photo_food:"Тамақ суреті", home_ask_coach:"Жаттықтырушыдан сұрау", home_services:"Сервистер",
    prog_this_week:"АҒЫМДАҒЫ АПТА", week_gym:"зал", week_sport:"спорт", prefill_from:"жаттығудан",
    consent_intro:"Қолданба жаттығу, тамақтану және денсаулық мәліметтерін, оның ішінде қарсы көрсетілімдер мен аллергияларды жинайды және AI-жаттықтырушыға береді. 18 жастан.",
    consent_checkbox:"Дербес деректерімді, оның ішінде денсаулық мәліметтерін өңдеуге келісемін",
    consent_record:"ДЕРЕКТЕРДІ ӨҢДЕУГЕ КЕЛІСІМ", consent_ver:"редакция", age_too_young:"Қолданба 18 жастан қолжетімді.",
    consent_give:"беру",
    ai_consent_btn:"ПРОФИЛЬГЕ ӨТУ",
    ai_consent_needed:"Жаттықтырушы қолжетімсіз: AI-қызметке деректерді беруге келісім қайтарылды. Оны профильдегі келісімдер бөлімінде қалпына келтіруге болады.",
    consent_i_terms:"Маған 18 жас толды, пайдалану ережелерін қабылдаймын", consent_i_terms_h:"Жүктеме, тамақтану және қоспалар туралы шешімді өзім қабылдаймын. AI жауабы медициналық тағайындау емес.",
    consent_i_basic:"Аккаунт және жаттығу деректерін өңдеу", consent_i_basic_h:"Профиль, күнделіктер, мақсаттар және статистика. Шетелдегі серверлерде сақталады.",
    consent_i_health:"Денсаулық мәліметтерін өңдеу", consent_i_health_h:"Қарсы көрсетілімдер, аллергиялар, дәрілер, аурулар. Онсыз шектеулер ескерілмейді.",
    consent_i_ai:"Деректерді АҚШ-тағы AI-қызметке беру", consent_i_ai_h:"Профиль, тарих және медициналық шектеулер әрбір сұрауда Anthropic-ке беріледі. Онсыз AI-жаттықтырушы мен тамақты тану қолжетімсіз.",
    consent_required_note:"* қолданба жұмысы үшін міндетті. Қалғандарын профильде кез келген уақытта қайтарып алуға болады.",
    consent_no_ai_note:"Бұл келісімсіз AI-жаттықтырушы мен сурет бойынша тамақты тану жұмыс істемейді.",
    consent_not_given:"берілмеген", consent_withdraw:"қайтарып алу", consent_req_note:"міндетті",
    consent_wd_ai_confirm:"Деректерді беруге келісім қайтарылсын ба? AI-жаттықтырушы мен тамақты тану жұмысын тоқтатады.",
    consent_wd_health_confirm:"Денсаулық мәліметтеріне келісім қайтарылсын ба? Қарсы көрсетілімдер, аллергиялар және дәрілер профильден жойылады.",
    mydata_title:"МЕНІҢ ДЕРЕКТЕРІМ", mydata_export:"Деректерімді жүктеу", mydata_delete:"Аккаунтты және барлық деректерді жою",
    consent_gate_kicker:"ЖАЛҒАСТЫРУ АЛДЫНДА", consent_gate_title:"ДЕРЕКТЕРДІ ӨҢДЕУГЕ КЕЛІСІМ", consent_gate_btn:"КЕЛІСЕМІН",
    mydata_export_err:"Деректерді жүктеу мүмкін болмады.", mydata_del_err:"Аккаунтты жою мүмкін болмады.",
    mydata_del_confirm1:"Аккаунт жойылсын ба? Барлық жаттығулар, өлшемдер, тамақтану және тарих өшіріледі. Қайтару мүмкін емес.",
    mydata_del_confirm2:"Растау үшін DELETE деп жазыңыз", mydata_del_done:"Аккаунт және барлық деректер жойылды.",
    rpe_question:"ТӘСІЛ ҚАЛАЙ ӨТТІ?", rpe_easy:"Оңай", rpe_ok:"Қалыпты", rpe_hard:"Ауыр", rpe_max:"Шегі",
    home_close_workout:"Жаттығуды жабу", home_close_confirm:"Аяқталмаған жаттығуды жабамыз ба? Жазылған тәсілдер сақталады.", home_checkin_due:"чек-ин уақыты",
    more_profile:"ПРОФИЛЬ", more_training:"ЖАТТЫҒУЛАР", more_health:"ДЕНСАУЛЫҚ", more_catalog:"КАТАЛОГ",
    more_edit_profile:"Анкета және параметрлер", more_training_prefs:"Жиілік және сплит",
    more_achievements:"Жетістіктер", more_leaderboard:"Көшбасшылар",
    alt_kicker:"АУЫСТЫРУ", alt_title:"БАСҚА НҰСҚА", alt_repeat_last:"Өткенді қайталау",
    alt_build_own:"Өзім құрастырамын", alt_available:"ҚОЛЖЕТІМДІ", alt_recent:"ЖАҚЫНДА ЖАТТЫҚТЫ",
    alt_never:"әлі жаттықпаған", alt_rest:"демалыс", alt_days:"күн",
    alt_confirm_repeat:"Сонда да қайталаймыз ба?", alt_split:"Сплит", alt_change:"өзгерту", alt_no_last:"Қайталауға аяқталған жаттығу жоқ.",
    prefs_kicker:"ЖАТТЫҒУ ПРОЦЕСІ", prefs_title:"ЖИІЛІК ЖӘНЕ СПЛИТ",
    prefs_freq:"АПТАСЫНА КҮШ ЖАТТЫҒУЛАРЫ", prefs_freq_hint:"Спорт бұл квотаға кірмейді, бөлек есептеледі.",
    prefs_split:"СПЛИТ ЖҮЙЕСІ", prefs_split_hint:"Еркін — жаттықтырушы топтарды демалысына қарай таңдайды.",
    prefs_days_in_cycle:"күн циклде", prefs_saving:"Сақталуда...", prefs_saved:"Сақталды",
    streak_day1:"КҮН",
    streak_day24:"КҮН",
    streak_days5:"КҮН",
    streak_podryad:"ҚАТАРЫНАН",
    ai_today:"AI бүгін",
    checkin_card_hint:"Аптасына бір рет — жексенбі кешінде немесе дүйсенбі таңертеңінде толтырыңыз.",
    checkin_card_hint2:"жоспарларды, жауаптар мен кеңестерді жасауда тексеруіңізді ескереді.",
    level_below:"Бастаушыдан төмен",
    level_elite:"Элита",
    norm_beg:"Бас",
    norm_mid:"Орт",
    norm_adv:"Озық",
    norm_elite:"Элита",
    age_suffix:"ж",
    coef_label:"коэф.",
    sleep_label2:"Ұйқы",
    supp_timing_anytime:"Күн сайын кез келген уақытта",
    supp_timing_food:"Тамақпен бірге",
    supp_timing_food_sleep:"Тамақпен немесе ұйқыға дейін",
    supp_timing_before:"Жаттығудан 30–45 минут бұрын",
    supp_timing_morning:"Таңертең майлы тамақпен",
    supp_timing_sleep:"Ұйқыға дейін",
    supp_timing_collagen:"Жаттығудан 1 сағат бұрын С витаминімен",
    supp_protein:"Протеин",
    supp_creatine:"Креатин моногидрат",
    supp_omega:"Омега-3",
    supp_vitd:"D3 витамині",
    supp_magnesium:"Магний",
    supp_bcaa:"BCAA",
    supp_zinc:"Мырыш",
    supp_vitc:"С витамині",
    supp_multi:"Мультивитаминдер",
    supp_glutamine:"Глютамин",
    supp_collagen:"Коллаген",
    supp_melatonin:"Мелатонин",
    supp_caffeine:"Кофеин",
    supp_beta:"Бета-аланин",
    supp_preworkout:"Предтреник",
    add30s:"+30 секунд",
    minus15s:"−15 секунд",
    rest_5_10:"5–10 минут",
    sets_short2:"тәсіл",
    reps_short2:"РЕТ",
    pts_short:"балл.",
    pts_label:"баллдар",
    kcal_short:"ккал",
    kcal_100g:"ккал/100г",
    volume_short:"көлем (кг×рет)",
    workouts_week:"жаттығу аптасына",
    one_session2:"1 сабақ",
    max_w:"MAX САЛМАҚ",
    dist_short:"ҚАШЫҚТЫҚ (КМ)",
    field_waist:"Бел",
    field_hips:"Жамбас",
    field_chest:"Кеуде",
    field_arm:"Қол (бицепс)",
    field_thigh:"Сан",
    field_age:"Жас",
    field_age_y:"Жас (жылдар)",
    field_weight_kg:"Салмақ (кг)",field_weight_g:"САЛМАҚ (г)",
    field_height_cm:"Бой (см)",
    step_1_2:"ҚАДАМ 1 / 2",
    step_2_2:"ҚАДАМ 2 / 2",
    step_1_4b:"ҚАДАМ 1 / 4",
    step_2_4b:"ҚАДАМ 2 / 4",
    step_3_4b:"ҚАДАМ 3 / 4",
    step_4_4b:"ҚАДАМ 4 / 4",
    plan_s1:"ЖОСПАРЛАУ · ҚАДАМ 1",
    plan_s2:"ЖОСПАРЛАУ · ҚАДАМ 2",
    plan_s3:"ЖОСПАРЛАУ · ҚАДАМ 3",
    sel_group_hint:"Бір немесе бірнеше топ таңдаңыз",
    next_datetime:"КЕЛЕСІ → КҮН МЕН УАҚЫТ",
    choose_replacement:"АУЫСТЫРУДЫ ТАҢДАҢЫЗ",
    warmup_exec_hint:"Негізгі жаттығудан бұрын жылытуды орындаңыз",
    edit_btn:"ӨЗГЕРТУ",
    edit_arrow:"ӨЗГЕРТУ →",
    profile_section:"ПРОФИЛЬ",
    language_section:"ТІЛ",
    score_section:"НӘТИЖЕ",
    notes_section:"ЖАЗБАЛАР",
    cancel_btn2:"БОЛДЫРМАУ",
    delete_btn:"ЖОЮ",
    error_label2:"ҚАТЕ",
    failed_load2:"ЖҮКТЕУ МҮМКІН ЕМЕС",
    points_short:"ТӘСІЛДЕР",
    order_section:"ТӘРТІП",
    meal_section:"АС ТҮРІ",
    allergy_section:"АЛЛЕРГИЯЛАР",
    archive_section:"МҰРАҒАТ",
    goal_section:"МАҚСАТ",
    status_section:"СТАТУС",
    level_section:"ДЕҢГЕЙ",
    calories_section:"КАЛОРИЯ",
    exercises_section:"ЖАТТЫҒУЛАР",
    volume_section:"КӨЛЕМ",
    tonnage_section:"ТОННАЖ",
    time_min_section:"УАҚЫТ (МИН)",
    name_section:"АТЫ",
    name_opt_section:"АТЫ (МІНДЕТТІ ЕМЕС)",
    food_catalog_section:"ӨНІМДЕР КАТАЛОГЫ",
    food_ref_section:"ӨНІМДЕР АНЫҚТАМАСЫ",
    new_product_section:"ЖАҢА ӨНІМ (100г үшін)",
    add_product_btn:"ӨНІМ ҚОСУ",
    add_photo_btn:"ФОТО ҚОСУ",
    add_exercise_btn:"ЖАТТЫҒУ ҚОСУ",
    my_exercise_section:"ӨЗ ЖАТТЫҒУЫМ",
    when_take_section:"ҚАШАН ҚАБЫЛДАУ",
    photo_kbju_title2:"ФОТО → КАЛОРИЯ",
    ai_trainer_title:"AI ЖАТТЫҚТЫРУШЫ",
    ai_trainer_online:"ЖАТТЫҚТЫРУШЫ БАЙЛАНЫСТА",
    analyzing_photo2:"AI СУРЕТТІ ТАЛДАУДА...",
    workout_still_active:"⚠️ ЖАТТЫҒУ ӘЛІ ЖҮРІП ЖАТЫР",
    record_sport:"⚽ САБАҚТЫ ЖАЗ",
    edit_date_plan:"✏ КҮНДІ/ҚҰРАМДЫ ӨЗГЕРТУ",
    edit_profile_btn2:"✏ ПРОФИЛЬДІ ӨЗГЕРТУ",
    added_done:"✓ ҚОСЫЛДЫ",
    warmup_done2:"✓ ЖЫЛЫТУ ОРЫНДАЛДЫ",
    save_confirm:"✓ САҚТАУ",
    workout_saved_tab:"✓ ЖАТТЫҒУ САҚТАЛДЫ → Жоспарланғандар қойындысы",
    calories_food:"🍽 КАЛОРИЯ (АС)",
    warmup_badge3:"🏃 ЖЫЛЫТУ",
    when_workout2:"📅 ЖАТТЫҒУ ҚАШАН?",
    share_btn2:"📤 БӨЛІСУ",
    other_photo2:"📷 Басқасы",
    analyze_btn2:"🔍 ТАЛДАУ",
    bot_reminds2:"🔔 Бот еске салады",
    burned_sport:"🔥 ЖҰМСАЛДЫ (СПОРТ)",
    water_tap_hint:"← бір стакан су белгілеу үшін басыңыз",
    replace_exercise2:"↔ ЖАТТЫҒУДЫ АУЫСТЫРУ",
    do_replace2:"↔ АУЫСТЫРУ",
    plateau_schedule:"Плато детекторы әр жексенбі 10:30-да тексереді.",
    bot_1h:"Бот 1 сағат бұрын еске салады",
    bot_1h_full:"Бот жаттығудан 1 сағат бұрын еске салады",
    continue_workout3:"ЖАТТЫҒУДЫ ЖАЛҒАСТЫРУ",
    skip_warmup2:"ЖЫЛЫТУДЫ ӨТКІЗІП ЖІБЕРу",
    warmup_rec_time:"ҰСЫНЫЛАТЫН ЖЫЛЫТУ УАҚЫТЫ",
    no_allergies2:"Аллергия жоқ",
    no_conditions2:"Шектеулер жоқ",
    not_specified3:"Көрсетілмеген",
    measurements_hint:"Өлшемдер тарихта сақталады — динамиканы бақылаңыз",
    ai_trainer_hint:"AI жаттықтырушы мақсатыңызға сай кеңес береді",
    goal_hint:"МАҚСАТЫҢЫЗ НЕ?",
    name_hint2:"СӘЛЕМ! АТЫҢЫЗ КІМ?",
    requests_left:"СҰРАУЛАР ҚАЛДЫ ·",
    or_write:"немесе жазыңыз",
    pts_per:"жаттығудан бұрын.",
    pts_bonus:"+8 балл",
    no_data_short:"деректер жоқ",
    day_30:"30 күн",
    day_60:"60 күн",
    day_90:"90 күн",
    day_180:"180 күн",
    hour_1:"1 сағат",
    ai_chat_title:"ЖАТТЫҚТЫРУШЫМЕН СҰХБАТ",
    ai_clear:"🗑 ТАЗАЛАУ",
    ai_coach_label:"🤖 ЖАТТЫҚТЫРУШЫ",
    ai_thinking2:"ЖАТТЫҚТЫРУШЫ ОЙЛАНАДЫ...",
    ai_analyzing:"ЖАТТЫҒУ ТАЛДАНУДА...",
    ai_review_title:"AI ЖАТТЫҚТЫРУШЫ БАҒАЛАУЫ",
    ai_coach_advice:"💬 ЖАТТЫҚТЫРУШЫ КЕҢЕСІ",
    ai_proposes:"💪 AI ЖАТТЫҒУ ҰСЫНАДЫ",
    ai_save_plan:"📅 КЕСТЕГЕ САҚТАУ",
    ai_date_hint:"Сақтамас бұрын күн мен уақытты таңдаңыз",
    ai_saved:"✓ ЖАТТЫҒУ САҚТАЛДЫ → Жоспарланғандар қойындысы",
    open_schedule:"КЕСТЕНІ АШУ →",
    continue_dialog:"+ ЖАЛҒАСТЫРУ",
    quick_questions:"ЖЫЛДАМ СҰРАҚТАР",
    voice_hint:"🎙 ДАУЫС · НЕМЕСЕ ЖАЗЫҢЫЗ",
    voice_full_hint:"🎙 ЖАЗУ ҮШІН БАСЫҢЫЗ · НЕМЕСЕ ЖАЗЫҢЫЗ",
    recognizing:"ТАНЫЛУДА...",
    no_mic:"Микрофонға рұқсат жоқ",
    no_audio:"Аудио деректер жоқ",
    speech_not_recognized:"Сөйлеу танылмады",
    transcription_error:"Транскрипция қатесі",
    progress_title2:"МЕНІҢ ПРОГРЕСІМ",
    weekly_activity:"АПТАЛЫҚ БЕЛСЕНДІЛІК",
    workouts_per_week:"жаттығу аптасына",
    muscle_progress:"БҰЛШЫҚЕТ ТОПТАРЫ БОЙЫНША ПРОГРЕСС",
    strength_norms:"СІЗДІҢ КҮШІҢІЗ VS НОРМАЛАР",
    no_data_period:"Таңдалған кезең үшін деректер жоқ",
    need_2_workouts:"График үшін ≥2 жаттығу керек",
    max_weight:"MAX САЛМАҚ",
    volume_unit:"көлем (кг×рет)",
    sessions_count:"сабақ",
    one_session:"сабақ",
    weight_dynamics:"САЛМАҚ ДИНАМИКАСЫ",
    timer_title:"ДЕМАЛыс ТАЙМЕРІ",
    tools_title:"АСПАПТАР",
    rest_done:"✓ ДЕМАЛЫС АЯҚТАЛДЫ",
    rest_label:"ДЕМАЛЫС",
    choose_time:"УАҚЫТТЫ ТАҢДАҢЫЗ",
    pause_btn:"⏸ ПАУЗА",
    start_btn2:"▶ БАСТАУ",
    add30:"+30 секунд",
    minus15:"−15 секунд",
    reset_btn2:"ТАЗАЛАУ",
    supps_title2:"ҚОСПАЛАР",
    supps_cat:"СПОРТ ҚОСПАЛАРЫ",
    supps_ref:"АНЫҚТАМА",
    supp_dose_label:"ДОЗАСЫ",
    supp_when:"ҚАШАН ҚАБЫЛДАУ",
    supp_sources:"ДЕРЕККӨЗДЕР",
    supp_desc:"СИПАТТАМА ЖӘНЕ КЕҢЕСТЕР",
    supp_warning:"⚠️ Витаминдер мен қоспаларды қолдану медициналық кеңес емес.",
    food_guide_cat:"АНЫҚТАМА",
    food_guide_title2:"ӨНІМДЕР КАТАЛОГЫ",
    food_when:"⏰ ҚАШАН ЖЕУ",
    food_tips:"💡 КЕҢЕСТЕР",
    food_best:"🏆 ЕҢ ЖАҚСЫ ӨНІМДЕР",
    food_combines:"✅ ҮЙЛЕСЕДІ",
    food_avoid:"❌ БІРГЕ ТҰТЫНБАҢЫЗ",
    error_server:"Сервер қатесі",
    error_save:"Сақтау қатесі",
    error_net:"Желі қатесі",
    error_request:"Сұрау қатесі",
    error_launch:"Іске қосу қатесі",
    error_load:"Жүктеу қатесі",
    error_try_again:"Қате. Қайта байқаңыз.",
    open_telegram:"Telegram арқылы ашыңыз.",
    failed_load:"Жүктеу мүмкін емес",
    failed_recognize:"Танып болмады. Басқа фото байқаңыз.",
    food_limit_reached:"Бүгінгі суреттен танулар бітті (күніне {limit}). Ертең қайта болады, әзірге тағамды қолмен енгізуге болады.",
    food_quota_left:"Бүгін қалған танулар: {left} / {limit}",
    limit_exceeded:"Күндік лимит таусылды. Ертең байқаңыз.",ai_unavailable:"AI-жаттықтырушы уақытша қолжетімсіз. Сәл кейінірек қайталап көр — сұраулар лимиті жұмсалмады.",last_time:"Өткен жолы",day_today_l:"бүгін",day_yesterday:"кеше",days_ago_n:"{n} күн бұрын",set_save_failed:"Тәсіл сақталмады — байланысты тексеріп, қайта бас",sq_dropped:"Сақталмаған тәсілдер: {n} — жаттығу серверде жабылып қойған",sq_waiting:"⏳ Жіберуді күтуде: {n}. Байланыс пайда болғанда өздері кетеді",sq_finish_pending:"Әлі жіберілмеген тәсілдер: {n}. Қазір аяқтайсыз ба? Олар кейін кетеді, бірақ осы жаттығудың қорытындысына кірмейді.",
    specify_name:"Атауды енгізіңіз",
    specify_name_cal:"Атау мен калорияларды енгізіңіз",
    delete_confirm:"Сабақты жоюды растайсыз ба?",
    no_answer:"Жауап жоқ",
    another_one:"ТАҒЫ БІРІ",
    going_in:"КІРІЛУДЕ...",
    exercises_none:"Жаттығулар таңдалмаған",
    exercises_none_planned:"Жаттығулар жоспарланбаған болатын",
    my_workout_name:"Менің жаттығуым",
    workout_name_opt:"АТЫ (МІНДЕТТІ ЕМЕС)",
    workout_status_active:"⚠️ ЖАТТЫҒУ ӘЛІ ЖҮРІП ЖАТЫР",
    scheduled_workout:"ЖОСПАРЛАНҒАН ЖАТТЫҒУ",
    scheduled_done:"ЖОСПАРЛАНДЫ",
    my_workouts_title:"МЕНІҢ ЖАТТЫҒУЛАРЫМ",
    schedule_label:"КЕСТЕ",
    upcoming_label:"АЛДАҒЫ",
    archive_planned:"ЖОСПАРЛАНҒАН МҰРАҒАТ",
    search_exercise:"Жаттығуды іздеу...",
    search_placeholder2:"Іздеу...",
    name_label:"АТЫ",
    name_req:"Аты *",
    exercise_group:"Бұлшықет тобы",
    sets_num:"Тәсілдер",
    reps_num:"Рет",
    all_btn:"БАРЛЫҒЫ",
    knowledge_base:"БІЛІМ БАЗАСЫ",
    save_measurements2:"ӨЛШЕМДЕРДІ САҚТАУ",
    saving:"САҚТАЛУДА...",
    saving2:"САҚТАЛУДА...",
    saved2:"✓ САҚТАЛДЫ",
    when_workout:"📅 ЖАТТЫҒУ ҚАШАН?",
    share_btn:"📤 БӨЛІСУ",
    other_photo:"📷 Басқасы",
    warmup_badge2:"🏃 ЖЫЛЫТУ",
    notifications_hint:"🔔 Бот жаттығудан 1 сағат бұрын еске салады.",
    not_found_hint:"Ештеңе табылмады",
    enter_name_or_cat:"АТЫ ЕНГІЗІҢІЗ НЕМЕСЕ САНАТТЫ ТАҢДАҢЫЗ",
    calories_eaten:"🍽 КАЛОРИЯ (АС)",
    calories_burned2:"🔥 ЖҰМСАЛДЫ (СПОРТ)",
    trainer_bot:"Бот 1 сағат бұрын еске салады",
    trainer_bot2:"Бот жаттығудан 1 сағат бұрын еске салады",
    conflict_time:"басқа уақыт таңдайсыз ба?",
    dist_km:"ҚАШЫҚТЫҚ (КМ)",
    imt_label:"ДСИ",
    workout_done2:"Жаттығу аяқталды",
    workout_type:"Жаттығу",
    sets_short:"тәсіл",
    reps_done:"орындалды",
    rpe_label:"RPE",
    warmup_duration:"5–10 минут",
    add_time30:"+30 секунд",
    minus_time15:"−15 секунд",
    no_sets_data:"деректер жоқ",
    one_portion:"1 порция",
    portions_pack:"қаптағы порциялар",
    // ── Добавлено 05.10.2026: тексты, которых не было в словаре вовсе.
    // Раньше они стояли литералами прямо в разметке и показывались
    // по-русски при любом языке приложения.
    // Активная тренировка
    aw_badminton:"🏸 Бадминтон",
    aw_ballov_za_seriyu:"серия үшін ұпай",
    aw_basketbol:"🏀 Баскетбол",
    aw_beg:"🏃 Жүгіру",
    aw_boks:"🥊 Бокс",
    aw_bolshoy_tennis:"🎾 Теннис",
    aw_dney:"күн",
    aw_dnya:"күн",
    aw_dobavit_uprazhnenie:"Жаттығу қосу",
    aw_futbol:"⚽ Футбол",
    aw_gandbol:"🤾 Гандбол",
    aw_gornye_lyzhi:"⛷ Тау шаңғысы",
    aw_nastolnyy_tennis:"🏓 Үстел теннисі",
    aw_padel:"🎾 Падел",
    aw_pilates:"🧘 Пилатес",
    aw_plavanie:"🏊 Жүзу",
    aw_skalolazanie:"🧗 Құзға өрмелеу",
    aw_sohranyaem:"⏳ САҚТАЛУДА...",
    aw_velosport:"🚴 Велоспорт",
    aw_voleybol:"🏐 Волейбол",
    aw_vyberi_zamenu:"— ауыстыруды таңда",
    aw_vybrano:"ТАҢДАЛДЫ (",
    aw_yoga:"🧘 Йога",
    aw_zagruzka:"Жүктелуде...",
    // Блок «плато» в прогрессе
    plateau_analiz:"ТАЛДАУ",
    // Гид по питанию
    fg_belok:"АҚУЫЗ",
    // Голосовая запись
    voice_oshibka:"Қате",
    // График недели: короткие названия спорта
    sps_badm:"бадм.",
    sps_basket:"баскет",
    sps_beg:"жүгіру",
    sps_boks:"бокс",
    sps_futbol:"футбол",
    sps_gandbol:"гандбол",
    sps_krossfit:"кроссфит",
    sps_lyzhi:"шаңғы",
    sps_n_tennis:"ү.теннис",
    sps_padel:"падел",
    sps_pilates:"пилатес",
    sps_plav:"жүзу",
    sps_skalolaz:"өрмел.",
    sps_tennis:"теннис",
    sps_velo:"вело",
    sps_voley:"волей",
    sps_yoga:"йога",
    // График по группам мышц
    mgc_obem:"көлем",
    // Достижения
    ach_esche_ne_otkryto:"АШЫЛМАҒАН (",
    ach_otkryto:"АШЫЛҒАН (",
    // Единицы измерения
    u_carb:"К",
    u_fat:"М",
    u_g:"г",u_s:"с",
    u_prot:"А",
    // Журнал занятий спортом
    splog_svoe:"Өзімдік",
    // Замеры тела
    meas_sm:"см",
    // Запланированная тренировка
    pw_arhivnaya:"📋 МҰРАҒАТТА",
    pw_tolko_prosmotr:"ТЕК КӨРУ",
    pw_uprazhneniya:"ЖАТТЫҒУЛАР (",
    pw_vypolnena:"✓ ОРЫНДАЛДЫ",
    // Знакомство при первом входе
    onb_analiziruet_trenirovki_vesa_:"Жаттығуларды, салмақтар мен қайталауларды талдайды — жүктемені қашан арттыру керегін айтады",
    onb_atlet:"Атлет",
    onb_derzhit_motivaciyu:"Мотивацияны сақтайды",
    onb_dobro_pozhalovat:"ҚОШ КЕЛДІҢІЗ",
    onb_nachat:"БАСТАУ 🏋️",
    onb_nachat_znakomstvo:"ТАНЫСУ →",
    onb_otvechaet_kak_zhivoy_trener:"Нағыз жаттықтырушыдай жауап береді",
    onb_pitanie_po_foto:"Фото арқылы тамақтану",
    onb_serii_dney_dostizheniya_ches:"Күндер сериясы, жетістіктер және шынайы кері байланыс — артық еркелетусіз",
    onb_sfotografiroval_edu_poluchil:"Тағамды суретке түсір — калория мен БЖК дайын. Әр ас қабылдауды қолмен енгізудің қажеті жоқ",
    onb_sprosi_chto_ugodno_pro:"Жаттығу, қалпына келу немесе қоспалар туралы кез келген сұрақ қой — деректеріңе негізделген нақты жауап аласың",
    onb_tvoy_lichnyy_ai_trener:"Жеке AI жаттықтырушың 🤖",
    onb_vidit_ves_tvoy_progress:"Бүкіл прогресіңді көреді",
    // История тренировок
    wh_nizkaya:"Төмен",
    wh_plan:"ЖОСПАР",
    wh_srednyaya:"Орташа",
    wh_vysokaya:"Жоғары",
    wh_zavershena:"✓ АЯҚТАЛДЫ",
    // Карточка тренировки
    wd_ph:"СЕТ",
    // Лидерборд
    lb_ty:"(сен)",
    // Мои добавки
    usup_dobavit:"+ ҚОСУ",
    usup_dobavit2:"✓ ҚОСУ",
    // Питание
    nut_belki:"Ақуыз",
    nut_cel:"мақсат",
    nut_g:"(г)",
    nut_isprav_nazvanie_sostav_kbzhu:"Атауын/құрамын түзет — калория мен БЖК автоматты түрде қайта есептеледі",
    nut_limit_ai_zaprosov_na:"⚠️ Бүгінгі AI сұрауларының лимиті бітті",
    nut_ml:"мл",
    nut_naprimer_chto_mne_ne:"Мысалы: бүгін тамақтануымда не жетіспейді? немесе ақуызды қалай бөлген дұрыс?",
    nut_naprimer_risovaya_kasha_s:"Мысалы: Сүтті күріш ботқасы, 300g",
    nut_oshibka:"қате",
    nut_pereschitat_i_sohranit:"🔄 ЕСЕПТЕП САҚТА",
    nut_pitanie:"ТАМАҚТАНУ",
    nut_zhiry:"Май",
    // Поиск продукта
    fs_na:"үшін",
    fs_poisk:"ІЗДЕУ",
    fs_sportpit:"💊 Спортқоспа",
    fs_vse:"Барлығы",
    // Правка занятия спортом
    spedit_partnery_oschuscheniya:"Серіктестер, сезімдер...",
    spedit_schet:"Есеп",
    // Прогресс
    prog_cht:"бс",
    prog_pn:"дс",
    prog_pt:"жм",
    prog_sb:"сб",
    prog_seriya:"СЕРИЯ",
    prog_sr:"ср",
    prog_trenirovok:"ЖАТТЫҒУ",
    prog_vs:"жс",
    prog_vt:"сс",
    // Профиль
    prof_bally:"Ұпай",
    prof_bro:"🤙 Бро",
    prof_ekspert:"🎓 Сарапшы",
    prof_ekspert2:"Сарапшы",
    prof_nastavnik:"🧑‍🏫 Тәлімгер",
    prof_nastavnik2:"Тәлімгер",
    prof_profil_ne_nayden_snachala:"Профиль табылмады. Алдымен @GYMASH_bot-та тіркеліп, кейін осында қайт.",
    prof_status:"Мәртебе",
    prof_stil_ai:"AI стилі",
    prof_uroven:"Деңгей",
    // Профиль: аллергии
    alg_glyuten:"🌾 Глютен",
    alg_laktoza:"🥛 Лактоза",
    alg_orehi:"🥜 Жаңғақ",
    alg_rybiy_zhir:"🐟 Балық майы",
    alg_soya:"🫘 Соя",
    alg_yayca:"🥚 Жұмыртқа",
    // Профиль: ограничения по здоровью
    med_bol_v_spine:"🔙 Арқа ауруы",
    med_diabet:"💉 Диабет",
    med_gipertoniya:"🩺 Гипертония",
    med_gryzha:"⚠️ Жарық",
    med_plecho_rotator:"💪 Иық/ротатор",
    med_pochki:"🫘 Бүйрек",
    med_pozvonochnik:"🦴 Омыртқа",
    med_serdce_sosudy:"❤️ Жүрек/тамырлар",
    med_travma_kolena:"🦵 Тізе жарақаты",
    // Профиль: уровень подготовки
    lvl_novichok:"Бастаушы",
    // Распознавание еды по фото
    fv_blyudo:"Тағам",
    fv_gotovo:"✅ ДАЙЫН",
    fv_ispravit:"✏️ ТҮЗЕТУ",
    fv_naprimer_risovaya_kasha_s:"Мысалы: Сүт пен бал қосылған күріш ботқасы, 300g",
    fv_ne_udalos_pereschitat_poprob:"Қайта есептеу мүмкін болмады. Басқаша сипаттап көр.",
    fv_neizvestnaya_oshibka:"белгісіз қате",
    fv_nizkaya:"❓ Төмен",
    fv_otmena:"Болдырмау",
    fv_perekadrirovat:"🔄 Қайта кадрлау",
    fv_pereschitat:"🔄 ҚАЙТА ЕСЕПТЕ",
    fv_pereschityvaem:"ЕСЕПТЕЛУДЕ...",
    fv_povtorit_sohranenie:"🔄 ҚАЙТА САҚТАУ",
    fv_povtoryaem:"ҚАЙТА ӘРЕКЕТ...",
    fv_srednyaya:"⚠️ Орташа",
    fv_vysokaya:"✅ Жоғары",
    // Рефералы
    ref_kopirovat:"📋 КӨШІРУ",
    ref_moi_referaly:"РЕФЕРАЛДАРЫМ (",
    ref_skopirovano:"✓ КӨШІРІЛДІ",
    // Сбор тренировки
    plan_dobavit_v_trenirovku:"+ ЖАТТЫҒУҒА ҚОС",
    plan_ubrat_iz_trenirovki:"✓ ЖАТТЫҒУДАН АЛ",
    plan_vybrano:"ТАҢДАЛДЫ",
    plan_zaplanirovat:"📅 ЖОСПАРЛАУ",
    // Своё блюдо (форма)
    fcat_frukty:"🍎 Жемістер",
    fcat_hleb:"🍞 Нан",
    fcat_krupy:"🌾 Жармалар",
    fcat_molochka:"🥛 Сүт өнімдері",
    fcat_myaso:"🥩 Ет",
    fcat_napitki:"🧃 Сусындар",
    fcat_ovoschi:"🥦 Көкөністер",
    fcat_prochee:"🫙 Басқа",
    fcat_ryba:"🐟 Балық",
    fcat_sneki:"🍫 Снэктер",
    // Своё упражнение
    cex_moe:"Менікі",
    // Серии и баллы
    gam_atlet:"🥈 Атлет",
    gam_chek_in:"✓ Чек-ин",
    gam_chempion:"🥇 Чемпион",
    gam_legenda:"💎 Аңыз",
    gam_pitanie_vneseno:"Тамақтану енгізілді",
    gam_tennis:"🎾 Теннис",
    gam_trenirovka_zavershena:"🏋️ Жаттығу аяқталды",
    gam_zanyatie_sportom:"Спорттық жаттығу",
    // Справочник добавок
    sup_10g_den:"10г/күн",
    sup_15_30mg_den:"15–30мг/күн",
    sup_1_3g_epa_dha:"1–3г EPA+DHA/күн",
    sup_2000_5000_me_den:"2000–5000 ХБ/күн",
    sup_200_400mg:"200–400мг",
    sup_20_40g_za_priem:"20–40г бір қабылдауда",
    sup_3_5g_den:"3–5г/күн",
    sup_3_6mg_kg_vesa:"3–6мг/кг салмақ",
    sup_bez_zagruzki_rezultat_cherez:"Жүктеу кезеңінсіз. Нәтиже 2–4 аптада. Сумен іш (250ml). Ең көп зерттелген қоспалардың бірі.",
    sup_immunitet_testosteron_kosti_:"Иммунитет, тестостерон, сүйектер. Кальций дұрыс сіңуі үшін K2 (100–200мкг) бірге қабылдаңыз.",
    sup_immunitet_testosteron_vossta:"Иммунитет, тестостерон, қалпына келу. Кальциймен бірге қабылдамаңыз — сіңуі үшін бәсекелеседі.",
    sup_kachestvo_sna_myshechnoe_vos:"Ұйқы сапасы, бұлшықеттің қалпына келуі, стрессті азайту. Түрі: глицинат немесе малат (оксид емес — нашар сіңеді).",
    sup_posle_trenirovki_ili_v:"Жаттығудан кейін немесе күннің кез келген уақытында",
    sup_povyshaet_vynoslivost_silu_i:"Төзімділікті, күшті және зейінді арттырады. 15:00-ден кейін қабылдамаңыз — ұйқыны бұзады. Төзімділік тез қалыптасады.",
    sup_prokonsultiruysya_s_vrachom_:"⚠️ Дәрігермен кеңесіңіз — қарсы көрсетілімдер бар",
    sup_protivovospalitelnyy_effekt_:"Қабынуға қарсы әсер, буындар, жүрек. Жалпы балық майына емес, EPA+DHA мөлшеріне қараңыз.",
    sup_sustavy_i_svyazki_neobhodim:"Буындар мен байламдар. Коллаген синтезі үшін C дәрумені (100mg) қажет. Әсері жинақталады — 8–12 апта.",
    sup_umerennyy_uroven_dokazatelno:"🟡 Дәлел деңгейі орташа",
    sup_vospolnenie_belka_syvorotoch:"Ақуызды толықтыру. Сарысу ақуызы — жылдам, казеин — баяу (ұйқы алдында).",
    sup_vozmozhna_allergicheskaya_re:"🚫 Аллергиялық реакция болуы мүмкін",
    sup_vysokiy_uroven_dokazatelnost:"🟢 Дәлел деңгейі жоғары",
    sup_your_weight:"(САЛМАҒЫҢ {w}КГ)",
    // Цели
    goals_celi:"МАҚСАТТАР",
    // Экран тренера (AI)
    ai_ai_trenirovka:"AI жаттығу",
    ai_chto_est_do_i:"Жаттығуға дейін және кейін не жеу керек",
    ai_oshibka_soedineniya:"Қосылым қатесі —",
    ai_programma_dlya_pohudeniya_na:"Бір айлық арықтау бағдарламасы",
    ai_sostav_plan_trenirovki_na:"Бұлшықет өсіруге бір апталық жаттығу жоспарын құр",
    ai_sprosi_chto_ugodno:"КЕЗ КЕЛГЕНІН СҰРА...",
    ai_trenirovka_na_plechi_i:"Иық пен қолға арналған жаттығу",
    ai_plan_more:"+ тағы {n}",
    err_save_failed:"Сақтау мүмкін болмады: {err}",
    err_save_status:"Сақтау қатесі ({code})",
    err_server_retry:"Сервер қатесі ({code}). Кейінірек қайталап көр.",
    plan_ex_groups:"ЖАТТЫҒУЛАР ({n} ТОП) →",
    plan_show_ex:"ЖАТТЫҒУЛАРДЫ КӨРСЕТУ ({n} ТОП) →",
    plan_time_taken:"{dt} уақытына «{title}» жаттығуы бар. Басқа уақытты таңдайсың ба?",
    prog_weight_range:"Салмақ графигі: {a}-ден {b}-ге дейін",
    ref_step1:"Сілтемені досыңмен бөліс",
    ref_step2:"Досың GymBot-та тіркеледі",
    ref_step3:"Сен {n} ұпай аласың",
    ref_step4:"Досың бастапқы бонус алады",
    sup_per_pack:"Қаптамада {n} порция",
    sup_tabs:"{a}мг ({b} дана 100мг таблетка)",
    u_dn:"күн",
    u_km:"км",
    u_let:"жас",
    u_povt:"рет",
    u_t:"т",
    // ── Батч 2 и 3, переводы получены 06.10.2026 ───────────────────────
    // Батч 2 — тексты из шаблонных строк, батч 3 — многострочные
    // текстовые узлы JSX: ни те, ни другие построчный поиск не находит.
    ui_1_porciya:"1 порция =",
    ui_ai_zaprosov_v_den:"Күніне AI сұраулары:",
    ui_ball:"ұпай.)",
    ui_dobavit_svoe_uprazhnenie:"⭐ ӨЗ ЖАТТЫҒУЫҢДЫ ҚОС",
    ui_dobavit_svoy_produkt:"＋ ӨЗ ӨНІМІҢДІ ҚОС",
    ui_izmenenie_za_3_nedeli:"3 аптадағы өзгеріс:",
    ui_kg_za_period:"кезеңде кг",
    ui_limit_ai_zaprosov_na:"💬 Бүгінгі AI сұрауларының лимиті бітті — бағалау ертең қолжетімді болады",
    ui_napishi_pravilnoe_nazvanie_ili:"Тағамның дұрыс атауын немесе құрамын жаз. Калория мен БЖК автоматты түрде қайта есептеледі.",
    ui_naydeno_v_kataloge:"⚠ Каталогтан табылды:",
    ui_ne_prosto_spisok_uprazhneniy:"Жай ғана жаттығулар тізімі емес — тарихыңды шынымен білетін және саған бейімделетін жаттықтырушы.",
    ui_ne_udalos_poluchit_ocenku:"AI бағасын алу мүмкін болмады — қосылымды тексер",
    ui_peremeschay_i_uvelichivay_chto:"Тағам толық сыйуы үшін жылжытып, үлкейт",
    ui_podhod:"ТӘСІЛ",
    ui_poka_nikto_ne_v:"Рейтингте әзірге ешкім жоқ. Жаттығып, ұпай жина!",
    ui_polnaya_zapis_v_razdele:"↗ Толық жазба Жаттығулар → ⚽ Спорт бөлімінде",
    ui_poprobuy_otkryt_cherez_telegra:"Telegram-бот арқылы ашып көр.",
    ui_poprobuy_smenit_uprazhnenie_il:"💡 Жаттығуды ауыстырып немесе дроп-сет қосып көр — жаттықтырушыдан сұра",
    ui_posledniy_raz:"СОҢҒЫ РЕТ (",
    ui_primenenie_vitaminov_i_dobavok:"⚠️ Дәрумендер мен қоспаларды қолдану ұсынымдық сипатта және медициналық кеңес болып табылмайды. Қолданар алдында дәрігермен кеңесіңіз.",
    ui_privet_treniruyus_v_gymbot:"Сәлем! Мен GymBot — Telegram-дағы ақылды AI жаттықтырушымен жаттығамын. Менің сілтемем арқылы қосылып, бонустық ұпайлар ал",
    ui_referalnaya_programma_vremenno:"Рефералдық бағдарлама уақытша қолжетімсіз",
    ui_seriya:"🔥 Серия:",
    ui_sleduyuschiy:"Келесі:",
    ui_taymer_avtomaticheski_zapuskae:"Жаттығу кезінде әр тәсілден кейін таймер автоматты түрде іске қосылады.",
    ui_tochnost:"ДӘЛДІК:",
    ui_trenirovka_ne_naydena_ili:"Жаттығу табылмады немесе қолжетімділік жоқ.",
    ui_vybrano_grupp:"ТАҢДАЛҒАН ТОПТАР:",
    ui_zamenit:"АУЫСТЫРУ",
    ui_zdes_mozhno_ispolzovat_otdelno:"Мұнда бөлек қолдануға болады.",
  },
};
function t(key) { return T[LANG_STORE.current]?.[key] || T.ru[key] || key; }

// Перевод названия оборудования («Штанга / EZ-гриф» и прочее)
function tEquip(eq) {
  if (!eq) return "";
  const lang = LANG_STORE.current;
  if (lang === "ru") return eq;
  const map = {
    "Штанга / EZ-гриф":{en:"Barbell / EZ-bar",uz:"Shtanga / EZ-shtanga",kz:"Штанга / EZ-штанга"},
    "Штанга / гантели":{en:"Barbell / Dumbbells",uz:"Shtanga / gantellar",kz:"Штанга / гантельдер"},
    "Штанга + скамья":{en:"Barbell + Bench",uz:"Shtanga + skamya",kz:"Штанга + орындық"},
    "Штанга + наклонная скамья":{en:"Barbell + Incline bench",uz:"Shtanga + qiyalik skamya",kz:"Штанга + еңкіш орындық"},
    "Штанга или гантели, Скамья":{en:"Barbell or Dumbbells, Bench",uz:"Shtanga yoki gantellar, skamya",kz:"Штанга немесе гантельдер, орындық"},
    "Гантели + скамья":{en:"Dumbbells + Bench",uz:"Gantellar + skamya",kz:"Гантельдер + орындық"},
    "Гантель + скамья":{en:"Dumbbell + Bench",uz:"Gantel + skamya",kz:"Гантель + орындық"},
    "Гантели, Скамья":{en:"Dumbbells, Bench",uz:"Gantellar, skamya",kz:"Гантельдер, орындық"},
    "Гантели, Наклонная скамья":{en:"Dumbbells, Incline bench",uz:"Gantellar, qiyalik skamya",kz:"Гантельдер, еңкіш орындық"},
    "Гантели + скамья со спинкой":{en:"Dumbbells + Back bench",uz:"Gantellar + suyanchli skamya",kz:"Гантельдер + арқалы орындық"},
    "Гантель, Скамья":{en:"Dumbbell, Bench",uz:"Gantel, skamya",kz:"Гантель, орындық"},
    "Тренажёр «Бабочка»":{en:"Pec Deck",uz:"Pec-deck",kz:"Пек-дек"},
    "Тренажёр Hammer":{en:"Hammer Machine",uz:"Hammer trenajori",kz:"Hammer тренажері"},
    "Тренажёр Hammer Strength":{en:"Hammer Strength",uz:"Hammer Strength",kz:"Hammer Strength"},
    "Тренажёр гиперэкстензия":{en:"Hyperextension machine",uz:"Giperekstenziya trenajori",kz:"Гиперэкстензия тренажері"},
    "Тренажёр блок":{en:"Cable machine",uz:"Kabel trenajori",kz:"Кабель тренажері"},
    "Тренажёр для плеч":{en:"Shoulder press machine",uz:"Yelka pressi trenajori",kz:"Иық прессі тренажері"},
    "Блочный тренажёр":{en:"Cable machine",uz:"Blokli trenajor",kz:"Блокты тренажер"},
    "Кроссовер (блочный тренажёр)":{en:"Cable crossover",uz:"Kabel crossover",kz:"Кабель кроссовері"},
    "Скамья Скотта + EZ-гриф":{en:"Scott bench + EZ-bar",uz:"Skott skamyasi + EZ-shtanga",kz:"Скотт орындығы + EZ-штанга"},
    "Т-гриф":{en:"T-bar",uz:"T-shtanga",kz:"Т-штанга"},
    "Штанга с упором":{en:"Landmine barbell",uz:"Landmayn shtanga",kz:"Лэндмайн штанга"},
    "Штанга": {en:"Barbell",uz:"Shtanga",kz:"Штанга"},
    "Гантели": {en:"Dumbbells",uz:"Gantellar",kz:"Гантельдер"},
    "Гантель": {en:"Dumbbell",uz:"Gantel",kz:"Гантель"},
    "Турник": {en:"Pull-up bar",uz:"Turnik",kz:"Турник"},
    "Брусья": {en:"Parallel bars",uz:"Bruslari",kz:"Брустар"},
    "Тренажёр": {en:"Machine",uz:"Trenajor",kz:"Тренажер"},
    "Блок": {en:"Cable",uz:"Blok",kz:"Блок"},
    "Кроссовер": {en:"Cable crossover",uz:"Kabel crossover",kz:"Кабель кроссовері"},
    "Скамья": {en:"Bench",uz:"Skamya",kz:"Орындық"},
    "Резиновая лента": {en:"Resistance band",uz:"Rezinka",kz:"Резеңке"},
    "Резиновая лента, Стойка":{en:"Resistance band, Rack",uz:"Rezinka, stoyka",kz:"Резеңке, стойка"},
    "Без оборудования": {en:"No equipment",uz:"Jihozlarsiz",kz:"Жабдықсыз"},
    "Не нужно": {en:"No equipment",uz:"Kerak emas",kz:"Қажет емес"},
    "Гиря": {en:"Kettlebell",uz:"Girya",kz:"Гиря"},
    "EZ-гриф": {en:"EZ-bar",uz:"EZ-shtanga",kz:"EZ-штанга"},
    "Степ-платформа":{en:"Step platform",uz:"Step platforma",kz:"Степ платформа"},
  };
  if (map[eq]) return map[eq][lang] || eq;
  // Partial replacement - replace known RU words in complex strings
  let result = eq;
  const parts = [
    ["Штанга","Barbell","Shtanga","Штанга"],
    ["Гантели","Dumbbells","Gantellar","Гантельдер"],
    ["Гантель","Dumbbell","Gantel","Гантель"],
    ["Скамья","Bench","Skamya","Орындық"],
    ["Тренажёр","Machine","Trenajor","Тренажер"],
    ["Блок","Cable","Blok","Блок"],
    ["наклонная","incline","qiyalik","еңкіш"],
    ["Брусья","Bars","Bruslari","Брустар"],
    ["Турник","Bar","Turnik","Турник"],
  ];
  const idx = ["en","uz","kz"].indexOf(lang);
  if (idx >= 0) {
    for (const p of parts) result = result.split(p[0]).join(p[idx+1]);
  }
  return result;
}
// Локализованное поле объекта из API: берём name_uz, если есть, иначе name.
// Названия приезжают сразу на всех языках и выбираются здесь. Описание и
// техника — наоборот, приходят уже на нужном языке (см. /api/exercises),
// и для них этот хелпер просто отдаёт obj[field]. Так и задумано: абзацы
// на четырёх языках весят слишком много, чтобы возить их все.
/** Локаль для toLocaleDateString и родственных.
 *
 *  Названия месяцев и дней недели браузер знает сам, переводить их не нужно —
 *  нужно лишь передать язык вместо жёсткого "ru", как было во всех шестнадцати
 *  местах. Казахский у браузера называется kk, а у нас в базе kz: без этой
 *  подмены дата осталась бы на английском (запасной язык ICU).
 */
function dateLocale() {
  const l = LANG_STORE.current;
  return l === "kz" ? "kk" : (l || "ru");
}

/** Сегодняшняя дата по Ташкенту, в виде YYYY-MM-DD.
 *
 *  Везде стоял `new Date().toISOString().split("T")[0]`, а toISOString переводит
 *  в UTC. В Ташкенте это +5, поэтому с полуночи до пяти утра «сегодня» было
 *  вчерашним днём: дневник питания открывался на вчера, запись занятия спортом
 *  ложилась вчерашним числом, а потом это же расхождение всплывало в разборе
 *  тренировки как перепутанный порядок событий.
 */
function localToday() {
  // По Ташкенту (UTC+5, без перехода на летнее время), а не по поясу телефона:
  // сервер делит сутки так же, и utcToLocal показывает время в том же поясе.
  // С поясом телефона в поездке «сегодня» в дневнике не совпало бы с серверным.
  return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
}
/** Сдвиг даты YYYY-MM-DD на delta дней — чистая арифметика по календарю,
 *  без часового пояса (new Date("2026-10-24") — это UTC-полночь, и setDate
 *  в местном поясе мог дать тот же день или пропустить один). */
function shiftDay(ymd, delta) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Отметка времени из базы (наивный UTC, без «Z») → момент для показа.
 *
 *  Браузер по спецификации читает «2026-10-08T21:14:03» без смещения как
 *  МЕСТНОЕ время, хотя в базе это UTC. Поэтому к разобранной дате добавляем
 *  пять часов и получаем тот же момент в ташкентских стенных часах.
 *  Сдвиг уже стоял тремя копиями числом 5*3600000 — здесь он получает имя.
 *
 *  Без него карточка ночной тренировки показывала вчерашнее число. Раньше
 *  тренер ошибался так же, и расхождения не было видно; теперь он называет
 *  дату верно, и человек увидел бы на одном экране «8 окт.» в списке и
 *  «9 октября» в разборе.
 */
function utcToLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : new Date(d.getTime() + 5 * 3600000);
}
/** YYYY-MM-DD по полям Date (getFullYear/getMonth/getDate), без перевода в UTC. */
function ymdOf(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Подпись дня прошлой тренировки: «сегодня», «вчера», «3 дн. назад», «12 окт.».
 *  Раньше на экран подхода шла сырая отметка из базы — «2026-09-11 17:23:10.157706». */
function fmtDayAgo(iso) {
  const d = utcToLocal(iso);
  if (!d) return "";
  const [y, m, dd] = localToday().split("-").map(Number);
  const days = Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days === 0) return t("day_today_l");
  if (days === 1) return t("day_yesterday");
  if (days > 1 && days < 7) return t("days_ago_n").replace("{n}", days);
  return d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });
}

function tField(obj, field) {
  if (!obj) return "";
  const lang = LANG_STORE.current;
  if (lang !== "ru" && obj[field + "_" + lang]) return obj[field + "_" + lang];
  return obj[field] || "";
}

// ── Названия из истории на языке приложения ─────────────────────────────────
// Подходы хранят название упражнения в момент записи — по-русски, как в
// каталоге. История и прогресс показывали его как есть, и у узбека или казаха
// прошлые тренировки оставались русскими навсегда. Каталог (он грузится при
// старте) знает переводы: ищем по русскому названию и подменяем при показе.
// Своё упражнение в каталоге не найдётся — останется как записано.
const _exByRu = new Map(), _mgByRu = new Map();
function indexCatalogNames(exercises, groups) {
  _exByRu.clear(); _mgByRu.clear();
  for (const e of exercises || []) if (e?.name && !e.is_custom) _exByRu.set(String(e.name).trim().toLowerCase(), e);
  for (const g of groups || []) if (g?.name) _mgByRu.set(String(g.name).trim().toLowerCase(), g);
}
function trEx(name) {
  if (!name) return name || "";
  const e = _exByRu.get(String(name).trim().toLowerCase());
  return (e && tField(e, "name")) || name;
}
function trGroupName(name) {
  if (!name) return name || "";
  const g = _mgByRu.get(String(name).trim().toLowerCase());
  return (g && tField(g, "name")) || name;
}

// Локализованное название группы мышц
function tGroup(ex) {
  if (!ex) return "";
  const lang = LANG_STORE.current;
  if (lang !== "ru" && ex["group_name_" + lang]) return ex["group_name_" + lang];
  return ex.group_name || "";
}

// Локализованное название вида спорта
function tSport(sport) {
  if (!sport) return "";
  const lang = LANG_STORE.current;
  // Handle both full API objects (name_en) and mapped objects (l_en)
  if (lang !== "ru") {
    if (sport["name_" + lang]) return sport["name_" + lang];
    if (sport["l_" + lang]) return sport["l_" + lang];
  }
  return sport.name || sport.name_ru || sport.l || "";
}


const Hero = ({children,style={}}) => <div style={{fontWeight:700,fontSize:26,letterSpacing:-0.5,lineHeight:1.15,color:C.text,textTransform:"uppercase",...style}}>{children}</div>;
const Kicker = ({children}) => <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>{children}</div>;
const Mono = ({children,color=C.accent,size=18}) => <span style={{fontFamily:"monospace",fontWeight:700,fontSize:size,color}}>{children}</span>;

function Card({children,accent,danger,onClick,style={},pad="14px 16px"}){
  const border = accent?C.accent:danger?C.danger:C.border;
  return <div onClick={onClick} style={{background:C.card,border:`0.5px solid ${border}`,borderRadius:12,padding:pad,cursor:onClick?"pointer":"default",...style}}>{children}</div>;
}
function Loader({text=t("loading")}){
  return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"60vh"}}><div style={{textAlign:"center"}}><div style={{fontFamily:"monospace",fontSize:12,color:C.accent,letterSpacing:3}}>{text}</div><div style={{color:C.muted,fontSize:24,marginTop:8}}>◌</div></div></div>;
}
/** Экран ждёт свежий профиль (на руках копия с прошлого запуска, без данных
 *  о здоровье). Сразу — загрузка; если за 5 секунд не пришёл — «нет связи»
 *  и кнопка повтора, а не вечное колёсико. */
function DiskWait({onBack,text,onRetry}){
  const [slow,setSlow]=useState(false);
  useEffect(()=>{const tm=setTimeout(()=>setSlow(true),5000);return()=>clearTimeout(tm);},[]);
  return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/>
    {slow
      ?<div style={{textAlign:"center",marginTop:40}}>
        <div style={{fontSize:14,color:C.muted}}>{t("home_load_error")}</div>
        {onRetry&&<Btn full onClick={onRetry} style={{marginTop:16}}>{t("retry")}</Btn>}
      </div>
      :<Loader text={text}/>}
  </div>;
}
/** Нет связи с сервером при запуске: что случилось и кнопка повтора.
 *  Повторяет и сам, как только браузер скажет, что связь вернулась. */
function OfflineScreen({onRetry}){
  // «online» приходит, только если пропала сама сеть. Когда лежит сервер
  // (выкладка), браузер остаётся онлайн — поэтому ещё и раз в 15 секунд.
  useEffect(()=>{
    const on=()=>{if(document.visibilityState!=="hidden")onRetry();};
    window.addEventListener("online",on);
    const iv=setInterval(on,15000);
    return()=>{window.removeEventListener("online",on);clearInterval(iv);};
  },[]);
  return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg,padding:24,boxSizing:"border-box"}}>
    <div style={{textAlign:"center",maxWidth:320}}>
      <div style={{fontSize:32,marginBottom:12}} aria-hidden="true">📡</div>
      <div style={{fontSize:14,color:C.muted,lineHeight:1.5,marginBottom:16}}>{t("home_load_error")}</div>
      <Btn accent full onClick={onRetry}>{t("retry")}</Btn>
    </div>
  </div>;
}
function BackBtn({onBack}){
  return <button onClick={onBack} style={{background:"none",border:"none",color:C.muted,fontFamily:"monospace",fontSize:12,letterSpacing:1,cursor:"pointer",padding:"0 0 16px 0",display:"block"}}>{t("back")}</button>;
}
function Btn({children,onClick,accent,danger,disabled,full,style={}}){
  const bg=accent?C.accent:danger?"#FF444422":C.card;
  const bc=accent?C.accent:danger?C.danger:C.border;
  const col=accent?C.bg:danger?C.danger:C.text;
  return <button onClick={onClick} disabled={disabled} style={{width:full?"100%":"auto",background:bg,border:`0.5px solid ${bc}`,borderRadius:10,padding:"13px 20px",color:col,fontWeight:700,fontSize:14,letterSpacing:0.5,textTransform:"uppercase",cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,...style}}>{children}</button>;
}
function Sel({value,onChange,options}){
  return <select value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",boxSizing:"border-box"}}>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
function Tag({children,color=C.muted,bg}){
  return <span style={{background:bg||`${color}22`,border:`0.5px solid ${color}`,borderRadius:16,padding:"4px 10px",fontSize:12,color,display:"inline-block"}}>{children}</span>;
}
function ProgressBar({pct,color=C.accent}){
  return <div style={{background:C.border,borderRadius:4,height:6}}><div style={{width:`${Math.min(100,pct)}%`,height:"100%",background:pct>100?C.danger:color,borderRadius:4,transition:"width 0.4s"}}/></div>;
}

// Эти списки вычисляются при загрузке модуля — РАНЬШЕ, чем станет известен язык
// (он приходит из профиля отдельным запросом). Поэтому вызывать здесь t() нельзя:
// подпись застыла бы на том языке, который был в момент загрузки, и не менялась
// бы при переключении. Храним ключ, переводим в месте показа — так же, как это
// уже сделано ниже у getGoalLabel и getDiff. Поле label остаётся русским
// запасным вариантом на случай, если ключа в словаре почему-то нет.
const MEDICAL_OPTIONS=[
  {key:"knee_injury",tkey:"med_travma_kolena",label:"🦵 Травма колена"},{key:"back_pain",tkey:"med_bol_v_spine",label:"🔙 Боль в спине"},
  {key:"spine_issues",tkey:"med_pozvonochnik",label:"🦴 Позвоночник"},{key:"shoulder_injury",tkey:"med_plecho_rotator",label:"💪 Плечо/ротатор"},
  {key:"heart_disease",tkey:"med_serdce_sosudy",label:"❤️ Сердце/сосуды"},{key:"hypertension",tkey:"med_gipertoniya",label:"🩺 Гипертония"},
  {key:"hernia",tkey:"med_gryzha",label:"⚠️ Грыжа"},{key:"kidney_disease",tkey:"med_pochki",label:"🫘 Почки"},{key:"diabetes",tkey:"med_diabet",label:"💉 Диабет"},
];
const ALLERGY_OPTIONS=[
  {key:"lactose",tkey:"alg_laktoza",label:"🥛 Лактоза"},{key:"gluten",tkey:"alg_glyuten",label:"🌾 Глютен"},
  {key:"nuts",tkey:"alg_orehi",label:"🥜 Орехи"},{key:"soy",tkey:"alg_soya",label:"🫘 Соя"},
  {key:"fish_oil",tkey:"alg_rybiy_zhir",label:"🐟 Рыбий жир"},{key:"eggs",tkey:"alg_yayca",label:"🥚 Яйца"},
];
const MEDICAL_LABELS=Object.fromEntries(MEDICAL_OPTIONS.map(o=>[o.key,o.label]));
const ALLERGY_LABELS=Object.fromEntries(ALLERGY_OPTIONS.map(o=>[o.key,o.label]));
const _TKEY_BY_OPT=Object.fromEntries([...MEDICAL_OPTIONS,...ALLERGY_OPTIONS].map(o=>[o.key,o.tkey]));
/** Подпись ограничения или аллергии на языке приложения. Вызывать при рендере. */
const getOptLabel=(key)=>{const k=_TKEY_BY_OPT[key];const v=k&&t(k);return (v&&v!==k)?v:(MEDICAL_LABELS[key]||ALLERGY_LABELS[key]||key);};
const GOAL_LABELS={lose_weight:"Похудение",gain_muscle:"Набор массы",gain_strength:"Сила",improve_endurance:"Выносливость",stay_healthy:"Здоровье"};
const getGoalLabel=(key)=>({lose_weight:t("goal_lose"),gain_muscle:t("goal_muscle"),gain_strength:t("goal_strength"),improve_endurance:t("goal_endurance"),stay_healthy:t("goal_health")})[key]||GOAL_LABELS[key]||key;
const LEVEL_LABELS={beginner:"Новичок",intermediate:"Средний",advanced:"Продвинутый"};
// lvl_novichok, а не level_beginner: в словаре тот ключ уже есть, но с русским
// словом «Начинающий». Взять его означало бы молча поменять русский текст.
const getLevelLabel=(key)=>({beginner:t("lvl_novichok"),intermediate:t("level_intermediate"),advanced:t("level_advanced")})[key]||LEVEL_LABELS[key]||key;
const DIFF_COLOR={easy:C.success,medium:C.accent,hard:C.danger};
const getDiff=(d)=>({easy:t("difficulty_easy"),medium:t("difficulty_medium"),hard:t("difficulty_hard")})[d]||d;
const CARDIO_DISTANCE=["бег трусцой","интервальный бег","велосипед на улице","ходьба на беговой дорожке","бег на месте"];
const CARDIO_TIME=["зумба","танцевальная аэробика","степ-аэробика","плавание","кардио на лестнице","велотренажёр","эллиптический тренажёр"];

function cardioType(ex={}){
  // Приоритет 1: muscle_group_id=9 — всегда кардио
  if(ex.muscle_group_id===9){
    const n=(ex.name||"").toLowerCase();
    if(CARDIO_DISTANCE.some(c=>n.includes(c)||c.includes(n)))return "distance";
    if(ex.exercise_type==="cardio_distance")return "distance";
    return "time"; // все кардио по умолчанию = время
  }
  // Приоритет 2: exercise_type из БД
  if(ex.exercise_type==="cardio_distance")return "distance";
  if(ex.exercise_type==="cardio_time")return "time";
  // Приоритет 3: fallback по названию
  const n=(ex.name||"").toLowerCase();
  if(CARDIO_DISTANCE.some(c=>n.includes(c)||c.includes(n)))return "distance";
  if(CARDIO_TIME.some(c=>n.includes(c)||c.includes(n)))return "time";
  return null; // силовое
}

function CheckboxGroup({options,selected,onChange}){
  const toggle=key=>onChange(selected.includes(key)?selected.filter(k=>k!==key):[...selected,key]);
  return <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
    {options.map(o=>{const a=selected.includes(o.key);return(
      <button key={o.key} onClick={()=>toggle(o.key)} style={{padding:"7px 12px",borderRadius:20,fontSize:12,cursor:"pointer",background:a?C.accent:C.bg,border:`0.5px solid ${a?C.accent:C.border}`,color:a?C.bg:C.muted,fontWeight:a?700:400}}>{o.tkey?getOptLabel(o.key):o.label}</button>
    );})}
  </div>;
}


function RestTimer({onClose,autoStart=null,onRpe=null}){
  const PRESETS=[60,90,120,180];
  const [rpeDone,setRpeDone]=useState(null);
  const [total,setTotal]=useState(90);
  const [left,setLeft]=useState(null); // null = не запущен
  const [running,setRunning]=useState(false);
  const intervalRef=useRef(null);
  const endTimeRef=useRef(null); // абсолютное время окончания таймера (Date.now() + left*1000)

  function start(sec){
    setTotal(sec);setLeft(sec);setRunning(true);
    endTimeRef.current=Date.now()+sec*1000;
  }
  function pause(){
    setRunning(false);
    endTimeRef.current=null;
  }
  function resume(){
    setRunning(true);
    endTimeRef.current=Date.now()+(left||0)*1000;
  }
  function reset(){setRunning(false);setLeft(null);endTimeRef.current=null;}

  // Автозапуск сразу после записанного подхода: в зале не до выбора пресетов,
  // а время всё равно правится кнопками +30 / −15 прямо на ходу.
  useEffect(()=>{
    if(autoStart&&autoStart>0){
      setTotal(autoStart);setLeft(autoStart);setRunning(true);
      endTimeRef.current=Date.now()+autoStart*1000;
    }
  },[autoStart]);
  function addTime(sec){
    setLeft(p=>{
      const newLeft=p!=null?Math.max(0,p+sec):sec;
      if(endTimeRef.current)endTimeRef.current=Date.now()+newLeft*1000;
      return newLeft;
    });
  }

  // Пересчёт при возврате из фона (браузер замораживает setInterval в фоне)
  useEffect(()=>{
    function onVisible(){
      if(document.visibilityState==='visible'&&running&&endTimeRef.current){
        const remaining=Math.max(0,Math.round((endTimeRef.current-Date.now())/1000));
        if(remaining===0){
          setRunning(false);setLeft(0);
          if(navigator.vibrate)navigator.vibrate([200,100,200,100,400]);
        } else {
          setLeft(remaining);
        }
      }
    }
    document.addEventListener('visibilitychange',onVisible);
    return()=>document.removeEventListener('visibilitychange',onVisible);
  },[running]);

  useEffect(()=>{
    if(!running)return;
    intervalRef.current=setInterval(()=>{
      if(!endTimeRef.current)return;
      const remaining=Math.max(0,Math.round((endTimeRef.current-Date.now())/1000));
      setLeft(p=>{
        if(remaining<=0){
          setRunning(false);
          if(navigator.vibrate)navigator.vibrate([200,100,200,100,400]);
          try{
            const ctx=new(window.AudioContext||window.webkitAudioContext)();
            const beep=(freq,start,dur)=>{
              const o=ctx.createOscillator();
              const g=ctx.createGain();
              o.connect(g);g.connect(ctx.destination);
              o.frequency.value=freq;
              g.gain.setValueAtTime(0.4,ctx.currentTime+start);
              g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+start+dur);
              o.start(ctx.currentTime+start);
              o.stop(ctx.currentTime+start+dur);
            };
            beep(880,0,0.15);beep(880,0.2,0.15);beep(1100,0.4,0.3);
          }catch{}
          return 0;
        }
        return remaining;
      });
    },1000);
    return()=>clearInterval(intervalRef.current);
  },[running]);

  const pct=left!=null?Math.round((1-left/total)*100):0;
  const fmt=s=>{if(s==null)return"--:--";const m=Math.floor(s/60);const sec=s%60;return`${m}:${sec.toString().padStart(2,"0")}`;};
  const done=left===0;

  return(
    <Fragment>
    <div style={{position:"fixed",bottom:0,left:0,right:0,top:0,zIndex:199,background:"rgba(0,0,0,0.6)"}} onClick={e=>{if(e.target===e.currentTarget){reset();onClose();}}}/>
    <div style={{position:"fixed",bottom:"calc(70px + env(safe-area-inset-bottom))",left:16,right:16,background:C.surface,border:`0.5px solid ${done?C.success:C.accent}`,borderRadius:16,padding:"16px",zIndex:200,boxShadow:"0 -4px 24px rgba(0,0,0,0.4)"}}>
      {/* Прогресс-бар */}
      <div style={{background:C.border,borderRadius:4,height:4,marginBottom:12,overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:done?C.success:C.accent,borderRadius:4,transition:"width 1s linear"}}/>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:2}}>
            {done?t("rest_done"):left!=null?t("rest_label"):t("choose_time")}
          </div>
          <div style={{fontSize:36,fontFamily:"monospace",fontWeight:700,color:done?C.success:C.accent,lineHeight:1}}>
            {fmt(left)}
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {left!=null&&!done&&(
            <button onClick={running?pause:resume}
              style={{background:C.accent,border:"none",borderRadius:10,padding:"8px 16px",color:C.bg,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"monospace"}}>
              {running?t("pause_btn"):t("start_btn2")}
            </button>
          )}
          <button onClick={()=>{reset();onClose();}}
            style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:10,padding:"8px 12px",color:C.muted,fontSize:13,cursor:"pointer"}}>
            ✕
          </button>
        </div>
      </div>

      {onRpe&&(
        <div style={{marginBottom:12,paddingBottom:12,borderBottom:`0.5px solid ${C.border}`}}>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("rpe_question")}</div>
          <div style={{display:"flex",gap:6}}>
            {[{v:6,l:t("rpe_easy")},{v:7,l:t("rpe_ok")},{v:8,l:t("rpe_hard")},{v:9,l:t("rpe_max")}].map(o=>(
              <button key={o.v} onClick={()=>{setRpeDone(o.v);onRpe(o.v);}}
                style={{flex:1,background:rpeDone===o.v?C.accent:C.card,border:`0.5px solid ${rpeDone===o.v?C.accent:C.border}`,
                  borderRadius:8,padding:"8px 4px",color:rpeDone===o.v?C.bg:C.text,fontSize:12,cursor:"pointer"}}>
                {o.l}
              </button>
            ))}
          </div>
        </div>
      )}

      {left!=null&&!done?(
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>addTime(30)} style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px",color:C.text,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>{t("add30s")}</button>
          <button onClick={()=>addTime(-15)} style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px",color:C.muted,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>{t("minus15s")}</button>
          <button onClick={reset} style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px",color:C.danger,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>{t("reset_btn2")}</button>
        </div>
      ):(
        <div style={{display:"flex",gap:6}}>
          {PRESETS.map(s=>(
            <button key={s} onClick={()=>start(s)}
              style={{flex:1,background:done&&total===s?C.success:C.card,border:`0.5px solid ${done&&total===s?C.success:C.border}`,borderRadius:8,padding:"8px 4px",color:done&&total===s?"#fff":C.muted,fontSize:12,fontFamily:"monospace",cursor:"pointer",fontWeight:done&&total===s?700:400}}>
              {s}{t("u_s")}
            </button>
          ))}
        </div>
      )}
    </div>
    </Fragment>
  );
}

function NavBar({active,onChange}){
  const tabs=[{id:"menu",icon:"⊞",label:t("menu_tab_menu")},{id:"workout",icon:"▶",label:t("menu_tab_workout")},{id:"progress",icon:"↗",label:t("menu_tab_progress")},{id:"catalog",icon:"☰",label:t("menu_tab_catalog")},{id:"ai",icon:"●",label:t("menu_tab_ai")}];
  return <div style={{position:"fixed",bottom:0,left:0,right:0,background:C.surface,borderTop:`0.5px solid ${C.border}`,display:"flex",padding:"8px 0 calc(8px + env(safe-area-inset-bottom))",zIndex:100}}>
    {tabs.map(t=><button key={t.id} onClick={()=>onChange(t.id)} style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"4px 0"}}>
      <span style={{fontSize:18,color:active===t.id?C.accent:C.muted}}>{t.icon}</span>
      <span style={{fontSize:10,fontFamily:"monospace",letterSpacing:0.5,color:active===t.id?C.accent:C.muted}}>{t.label}</span>
    </button>)}
  </div>;
}

function ExerciseSelectCard({ex,sel,onToggle}){
  const containerRef=useRef(null);
  const [inView,setInView]=useState(false);
  const [imgLoaded,setImgLoaded]=useState(false);

  useEffect(()=>{
    if(!ex.video_url||!containerRef.current)return;
    const obs=new IntersectionObserver((entries)=>{
      if(entries[0].isIntersecting){setInView(true);obs.disconnect();}
    },{rootMargin:"150px"});
    obs.observe(containerRef.current);
    return ()=>obs.disconnect();
  },[ex.video_url]);

  return (
    <Card style={{padding:0,overflow:"hidden",cursor:"default",marginBottom:0}}>
      <div ref={containerRef} style={{position:"relative",width:"100%",aspectRatio:"1/1",background:C.bg,overflow:"hidden"}}>
        {ex.video_url&&inView?
          <video src={ex.video_url} poster={ex.photo_url} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}
            autoPlay loop muted playsInline preload="metadata" onError={e=>e.target.style.display="none"}/>
          :ex.photo_url?
          <img src={ex.photo_url} alt="" loading="lazy"
            style={{width:"100%",height:"100%",objectFit:"cover",display:"block",opacity:imgLoaded?1:0,transition:"opacity 0.25s ease"}}
            onLoad={()=>setImgLoaded(true)} onError={e=>e.target.style.display="none"}/>
          :<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30}}>{ex.group_emoji||"💪"}</div>}
        <button onClick={ev=>{ev.stopPropagation();onToggle();}} style={{position:"absolute",top:6,right:6,width:30,height:30,borderRadius:8,background:sel?C.accent:"rgba(0,0,0,0.55)",border:`0.5px solid ${sel?C.accent:C.border}`,color:sel?C.bg:"#fff",fontSize:16,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          {sel?`${sel.order}`:"+"}
        </button>
      </div>
      <div style={{padding:"9px 10px 11px"}}>
        <div style={{fontWeight:600,fontSize:12.5,color:C.text,lineHeight:1.3,marginBottom:5,minHeight:32}}>{tField(ex,"name")}</div>
        <Tag color={DIFF_COLOR[ex.difficulty]||C.muted}>{getDiff(ex.difficulty)}</Tag>
      </div>
    </Card>
  );
}

function ExCard({ex,onClick,badge,action}){
  return <Card onClick={onClick} style={{marginBottom:8}}>
    <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
      {ex.photo_url&&<img src={ex.photo_url} alt="" style={{width:56,height:56,borderRadius:8,objectFit:"cover",flexShrink:0}} onError={e=>e.target.style.display="none"}/>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{fontWeight:600,fontSize:14,color:C.text,lineHeight:1.3}}>{tField(ex,"name")}</div>
          {badge&&<Tag color={DIFF_COLOR[ex.difficulty]||C.muted}>{badge}</Tag>}
        </div>
        <div style={{fontSize:11,color:C.muted,marginTop:3}}>{ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:14,height:14,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:3}}/>:ex.group_emoji+" "}{tGroup(ex)}</div>
        <div style={{display:"flex",gap:10,marginTop:6}}>
          <span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{ex.sets_recommended} {t("sets_short2")}</span>
          <span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{ex.reps_recommended} {t("reps_short2")}</span>
          {ex.equipment&&<span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{tEquip(ex.equipment)}</span>}
        </div>
      </div>
      {action}
    </div>
  </Card>;
}



// ─── ONBOARDING ──────────────────────────────────────────────────────────────
// Четыре раздельных согласия. Первые два обязательны для работы приложения,
// два других расширяют функции: без согласия на передачу в Anthropic AI-тренер
// недоступен, без согласия на здоровье противопоказания не учитываются.
const CONSENT_ITEMS=[
  {k:"terms",  req:true,  label:"consent_i_terms",  hint:"consent_i_terms_h"},
  {k:"basic",  req:true,  label:"consent_i_basic",  hint:"consent_i_basic_h"},
  {k:"health", req:false, label:"consent_i_health", hint:"consent_i_health_h"},
  {k:"ai",     req:false, label:"consent_i_ai",     hint:"consent_i_ai_h"},
];

function OnboardingScreen({tgId,tgUser,onComplete}){
  const [step,setStep]=useState(0);
  const [consent,setConsent]=useState({terms:false,basic:false,health:false,ai:false}); // раздельные согласия
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState("");
  const [name,setName]=useState(tgUser?.first_name||"");
  const [goal,setGoal]=useState("stay_healthy");
  const [showTerms,setShowTerms]=useState(false);

  async function finish(){
    if(!tgId){setErr(t("open_telegram"));return;}
    setSaving(true);setErr("");
    try{
      const body={
        telegram_id:tgId,
        first_name:(name||"").trim()||tgUser?.first_name||"Атлет",   // данные в БД, не подпись: дефолты на сервере и в боте тоже русские
        username:tgUser?.username||null,
        desired_result:goal,
        lang:LANG_STORE.current||"ru",
        fitness_level:"beginner",
      };
      const res=await fetch(`${API}/user/create`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(!res.ok){
        if(res.status===403){setErr(t("age_too_young"));setSaving(false);return;}
        throw new Error("server");
      }
      // Отметка о согласии: фиксируем платформу, с которой оно дано
      try{
        await fetch(`${API}/consent/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({kinds:CONSENT_ITEMS.filter(i=>consent[i.k]).map(i=>i.k),
            platform:(tg?.platform||"unknown")+(tg?.version?` ${tg.version}`:"")})});
      }catch{}
      // Применяем реферальный код если есть
      const refCode=sessionStorage.getItem("gymbot_ref_code");
      if(refCode&&tgId){
        try{
          await fetch(`${API}/referral/apply?tg_id=${tgId}&ref_code=${refCode}`,{method:"POST"});
          sessionStorage.removeItem("gymbot_ref_code");
        }catch{}
      }
      onComplete();
    }catch(e){setErr(t("error_try_again"));setSaving(false);}
  }

  const goals=[
    {v:"lose_weight",icon:"⚖️",label:t("goal_lose")},
    {v:"gain_muscle",icon:"💪",label:t("goal_muscle")},
    {v:"gain_strength",icon:"🏋️",label:t("goal_strength")},
    {v:"improve_endurance",icon:"🏃",label:t("goal_endurance")},
    {v:"stay_healthy",icon:"❤️",label:t("goal_health")},
  ];

  if(showTerms)return <TermsOverlay tgId={tgId} onClose={()=>setShowTerms(false)}/>;
  return(
    <div style={{minHeight:"100vh",background:C.bg,display:"flex",flexDirection:"column"}}>
      <div style={{height:3,background:C.border}}>
        <div style={{height:3,background:C.accent,width:step===0?"33%":step===1?"66%":"100%",transition:"width 0.3s"}}/>
      </div>
      <div style={{flex:1,padding:"32px 20px 24px",display:"flex",flexDirection:"column"}}>
        {step===0&&<Fragment>
          <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,letterSpacing:2,marginBottom:16}}>{t("onb_dobro_pozhalovat")}</div>
          <Hero style={{marginBottom:8}}>{t("onb_tvoy_lichnyy_ai_trener")}</Hero>
          <div style={{fontSize:14,color:C.muted,marginBottom:28,lineHeight:1.5}}>
            {t("ui_ne_prosto_spisok_uprazhneniy")}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14,flex:1}}>
            {[
              {icon:"📊",title:t("onb_vidit_ves_tvoy_progress"),desc:t("onb_analiziruet_trenirovki_vesa_")},
              {icon:"🍽",title:t("onb_pitanie_po_foto"),desc:t("onb_sfotografiroval_edu_poluchil")},
              {icon:"💬",title:t("onb_otvechaet_kak_zhivoy_trener"),desc:t("onb_sprosi_chto_ugodno_pro")},
              {icon:"🔥",title:t("onb_derzhit_motivaciyu"),desc:t("onb_serii_dney_dostizheniya_ches")},
            ].map((f,i)=>(
              <div key={i} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                <div style={{fontSize:26,flexShrink:0}}>{f.icon}</div>
                <div>
                  <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:2}}>{f.title}</div>
                  <div style={{fontSize:12,color:C.muted,lineHeight:1.4}}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{fontSize:12,color:C.muted,lineHeight:1.5,marginTop:18,marginBottom:10}}>{t("consent_intro")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {CONSENT_ITEMS.map(it=>
              <ConsentCheck key={it.k} item={it} checked={consent[it.k]} onOpenTerms={()=>setShowTerms(true)}
                onToggle={()=>setConsent(p=>({...p,[it.k]:!p[it.k]}))}/>
            )}
          </div>
          <div style={{fontSize:12,color:C.muted,marginTop:12,lineHeight:1.5}}>{t("consent_required_note")}</div>
          <Btn accent full disabled={!(consent.terms&&consent.basic)} onClick={()=>setStep(1)}
            style={{marginTop:14,opacity:consent.terms&&consent.basic?1:0.45}}>{t("onb_nachat_znakomstvo")}</Btn>
        </Fragment>}
        {step===1&&<Fragment>
          <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,letterSpacing:2,marginBottom:16}}>{t("step_1_2")}</div>
          <Hero style={{marginBottom:8}}>{t("name_hint2")}</Hero>
          <div style={{fontSize:13,color:C.muted,marginBottom:28}}>{t("name_hint")}</div>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder={tgUser?.first_name||t("enter_name")} maxLength={40} autoFocus
            style={{width:"100%",background:C.card,border:`1px solid ${(name||"").trim()?C.accent:C.border}`,borderRadius:10,padding:"14px 16px",color:C.text,fontSize:18,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
          {err&&<div style={{marginTop:12,padding:"10px 14px",background:"rgba(255,68,68,0.1)",border:`1px solid ${C.danger}`,borderRadius:8,color:C.danger,fontSize:13}}>{err}</div>}
          <div style={{flex:1}}/>
          <Btn accent full onClick={()=>setStep(2)} style={{marginTop:24}}>{t("next_btn2")}</Btn>
        </Fragment>}
        {step===2&&<Fragment>
          <div style={{fontFamily:"monospace",fontSize:10,color:C.muted,letterSpacing:2,marginBottom:16}}>{t("step_2_2")}</div>
          <Hero style={{marginBottom:8}}>{t("goal_hint")}</Hero>
          <div style={{fontSize:13,color:C.muted,marginBottom:24}}>{t("ai_trainer_hint")}</div>
          <div style={{display:"flex",flexDirection:"column",gap:10,flex:1}}>
            {goals.map(g=>(
              <div key={g.v} onClick={()=>setGoal(g.v)}
                style={{display:"flex",alignItems:"center",gap:16,padding:"14px 16px",borderRadius:12,
                  border:`1px solid ${goal===g.v?C.accent:C.border}`,
                  background:goal===g.v?"rgba(200,255,0,0.06)":C.card,cursor:"pointer"}}>
                <span style={{fontSize:24}}>{g.icon}</span>
                <span style={{fontSize:15,fontWeight:600,color:goal===g.v?C.accent:C.text}}>{g.label}</span>
                {goal===g.v&&<span style={{marginLeft:"auto",color:C.accent,fontSize:18}}>✓</span>}
              </div>
            ))}
          </div>
          {err&&<div style={{marginTop:12,padding:"10px 14px",background:"rgba(255,68,68,0.1)",border:`1px solid ${C.danger}`,borderRadius:8,color:C.danger,fontSize:13}}>{err}</div>}
          <div style={{display:"flex",gap:10,marginTop:24}}>
            <Btn onClick={()=>setStep(1)} style={{flex:1}}>{t("back")}</Btn>
            <Btn accent disabled={saving} onClick={finish} style={{flex:2}}>{saving?t("going_in"):t("onb_nachat")}</Btn>
          </div>
        </Fragment>}
      </div>
    </div>
  );
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
function ConsentCheck({item,checked,onToggle,onOpenTerms}){
  return <div onClick={onToggle} style={{display:"flex",alignItems:"flex-start",gap:11,cursor:"pointer",
    padding:"12px 13px",background:C.card,border:`0.5px solid ${checked?C.accent:C.border}`,borderRadius:10}}>
    <span style={{width:21,height:21,borderRadius:6,flexShrink:0,marginTop:1,
      background:checked?C.accent:C.bg,border:`1px solid ${checked?C.accent:C.border}`,
      display:"flex",alignItems:"center",justifyContent:"center",color:C.bg,fontSize:13,fontWeight:900}}>
      {checked?"✓":""}
    </span>
    <div style={{minWidth:0}}>
      <div style={{fontSize:14,color:C.text,lineHeight:1.45}}>
        {t(item.label)}
        {item.req&&<span style={{color:C.accent,marginLeft:5}}>*</span>}
      </div>
      <div style={{fontSize:12,color:C.muted,lineHeight:1.45,marginTop:4}}>{t(item.hint)}</div>
      {item.k==="terms"&&onOpenTerms&&<div onClick={e=>{e.stopPropagation();onOpenTerms();}}
        style={{fontSize:12,color:C.accent,marginTop:6,cursor:"pointer"}}>{t("terms_read")} ›</div>}
    </div>
  </div>;
}

function ConsentGateScreen({tgId,onDone}){
  const [sel,setSel]=useState({terms:false,basic:false,health:false,ai:false});
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState(null);
  const [showTerms,setShowTerms]=useState(false);
  const canGo=sel.terms&&sel.basic;

  function submit(){
    if(!canGo||!tgId)return;
    const kinds=CONSENT_ITEMS.filter(i=>sel[i.k]).map(i=>i.k);
    setSaving(true);setErr(null);
    fetch(`${API}/consent/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({kinds,platform:(tg?.platform||"unknown")+(tg?.version?` ${tg.version}`:"")})})
      .then(r=>{if(!r.ok)throw new Error();return r.json();})
      .then(()=>onDone&&onDone())
      .catch(()=>{setErr(t("home_load_error"));setSaving(false);});
  }

  if(showTerms)return <TermsOverlay tgId={tgId} onClose={()=>setShowTerms(false)}/>;
  return <div style={{padding:"22px 18px 100px"}}>
    <Kicker>{t("consent_gate_kicker")}</Kicker>
    <Hero style={{fontSize:23,marginTop:6}}>{t("consent_gate_title")}</Hero>
    <div style={{fontSize:13,color:C.muted,lineHeight:1.6,marginTop:12,marginBottom:18}}>{t("consent_intro")}</div>

    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {CONSENT_ITEMS.map(it=>
        <ConsentCheck key={it.k} item={it} checked={sel[it.k]} onOpenTerms={()=>setShowTerms(true)}
          onToggle={()=>setSel(p=>({...p,[it.k]:!p[it.k]}))}/>
      )}
    </div>

    <div style={{fontSize:12,color:C.muted,marginTop:14,lineHeight:1.5}}>{t("consent_required_note")}</div>
    {!sel.ai&&<div style={{fontSize:12,color:C.warn||C.muted,marginTop:8,lineHeight:1.5}}>{t("consent_no_ai_note")}</div>}
    {err&&<div style={{marginTop:14,fontSize:13,color:C.danger}}>{err}</div>}

    <Btn accent full disabled={!canGo||saving} onClick={submit}
      style={{marginTop:20,opacity:canGo&&!saving?1:0.45}}>
      {saving?t("prefs_saving"):t("consent_gate_btn")}
    </Btn>
  </div>;
}

// Данные главного экрана переживают смену вкладки: MenuScreen перемонтируется при
// каждом возврате в «Меню», и без этого был пустой экран с загрузкой каждый раз.
// Берём их из общего кэша запросов, а не из отдельного объекта: своим кэшем
// главный экран не видел сбросов по событиям и мог показывать данные до тренировки.
function _cachedHome(tgId){
  if(!tgId)return null;
  const hit=_apiCache.get(`${API}/home/${tgId}`);
  // Нет в памяти — берём прошлый ответ с диска: экран рисуется сразу,
  // а запрос ниже всё равно сходит за свежим и подменит его.
  return hit?hit.data:swrRead(`${API}/home/${tgId}`);
}

function MenuScreen({user,onNav,activeWorkout=false}){
  const [prem]=usePremium(user?.telegram_id);
  const tgId=user?.telegram_id;
  const [home,setHome]=useState(()=>_cachedHome(tgId));
  const [failed,setFailed]=useState(false);

  useEffect(()=>{
    if(!tgId)return;
    setFailed(false);
    apiGet(`${API}/home/${tgId}`)
      .then(d=>setHome(d))
      .catch(()=>{if(!_cachedHome(tgId))setFailed(true);});
  },[tgId]);

  if(failed)return <div style={{padding:"16px 16px 100px"}}>
    <div style={{fontSize:14,color:C.muted,marginTop:40,textAlign:"center"}}>{t("home_load_error")}</div>
    <Btn full onClick={()=>{setFailed(false);setHome(null);
      apiGet(`${API}/home/${tgId}`,{force:true}).then(d=>setHome(d)).catch(()=>setFailed(true));}}
      style={{marginTop:16}}>{t("retry")}</Btn>
  </div>;
  if(!home)return <Loader text={t("loading")}/>;

  const u=home.user||{};
  const week=home.week||{};
  // Приветствие по ситуации — вариант привязан к дате, чтобы не прыгал в течение дня
  const greetText=(()=>{
    const d=user?.days_since_workout, s=user?.true_streak_days||0;
    const pool=(d!==null&&d!==undefined&&d>=7)?t("greet_away")
      :(d===0)?t("greet_today")
      :(s>=7)?t("greet_streak")
      :t("greet_normal");
    if(!Array.isArray(pool)||!pool.length)return null;
    const n=new Date();
    return pool[(n.getFullYear()*10000+(n.getMonth()+1)*100+n.getDate())%pool.length];
  })();
  const card=home.card;
  const st=home.stats||{};

  function cardAction(){
    if(!card)return;
    if(card.state==="profile_incomplete"){onNav("profile");return;}
    if(card.state==="resume"){onNav("active_workout");return;}
    if(card.state==="planned"){onNav("planned_detail",{pwId:card.planned_workout_id});return;}
    // Сервер подобрал состав по истории — передаём упражнениями, а не группами.
    // Раньше уходили только группы мышц, и «Начать тренировку» приводило на экран
    // выбора упражнений: собирать тренировку всё равно приходилось руками.
    if(card.exercise_ids?.length>0){
      onNav("active_workout",{preselectedExIds:card.exercise_ids,preselectedGroupIds:card.group_ids||[]});
      return;
    }
    onNav("active_workout",{preselectedGroupIds:card.group_ids||[]});
  }

  const kicker={
    profile_incomplete:t("home_k_profile"),
    resume:t("home_k_resume"),
    planned:t("home_k_planned"),
    recommendation:t("home_k_suggest"),
  }[card?.state]||"";

  // Точек столько, сколько стоит цель. Цель не задана — показываем по факту сделанного.
  const dotsTotal=week.target||Math.max(week.done||0,3);
  const dots=Array.from({length:dotsTotal},(_,i)=>i<(week.done||0));

  return <div style={{padding:"16px 16px 100px"}}>

    <div onClick={()=>onNav("profile")} style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,cursor:"pointer"}}>
      <div style={{width:34,height:34,borderRadius:"50%",background:C.card,border:`0.5px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:C.accent,flexShrink:0}}>
        {(u.first_name||"?").trim().charAt(0).toUpperCase()}
      </div>
      <div style={{minWidth:0}}>
        <div style={{fontSize:15,color:C.text}}>
          {greetText?`${greetText}, ${(u.first_name||"").split(" ")[0].toUpperCase()}`:(u.first_name||t("onb_atlet"))}
        </div>
        <div style={{fontSize:12,color:C.muted}}>
          {u.goal?getGoalLabel(u.goal):""}
          {u.goal&&u.streak>0?" · ":""}
          {u.streak>0?`🔥 ${u.streak} ${t("home_days_streak")}`:""}
        </div>
      </div>
      <div style={{marginLeft:"auto",width:34,height:34,borderRadius:"50%",background:C.card,border:`0.5px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,color:C.muted,flexShrink:0}}>⚙</div>
    </div>

    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
      <div style={{display:"flex",gap:4}}>
        {dots.map((f,i)=><span key={i} style={{width:7,height:7,borderRadius:"50%",background:f?C.accent:"#3A3A3A"}}/>)}
      </div>
      <span style={{fontSize:13,color:C.muted}}>
        {week.target?`${week.done} ${t("home_of")} ${week.target} ${t("home_this_week")}`:`${week.done} ${t("home_this_week")}`}
        {week.sport_count>0?` · ${t("home_sport")} ${week.sport_count}`:""}
      </span>
    </div>

    {card&&<Card accent style={{marginBottom:20}}>
      {kicker&&<div style={{fontSize:13,color:C.muted,marginBottom:6}}>{kicker}</div>}
      <div style={{fontSize:20,fontWeight:600,color:C.text,marginBottom:8}}>{card.title}</div>
      <div style={{fontSize:14,color:C.text,opacity:0.8,lineHeight:1.6,marginBottom:14}}>{card.description}</div>
      <Btn accent full onClick={cardAction}>{card.cta}</Btn>
      {card.state==="resume"&&<Btn full onClick={()=>{
        if(!window.confirm(t("home_close_confirm")))return;
        // Пустую тренировку сервер удаляет; подходы из очереди тогда пропали бы.
        // Если после попытки отправить они всё ещё в очереди (или отложены после
        // сбоев) — говорим серверу: он не удалит, а отложит до их прихода.
        (sqPending()>0?sqFlush():Promise.resolve(true))
          .then(()=>fetch(`${API}/workout/${tgId}/close-active${card.workout_id&&sqUnsentSets(card.workout_id)>0?"?has_unsent=true":""}`,{method:"POST"}))
          .then(()=>apiGet(`${API}/home/${tgId}`,{force:true}))
          .then(d=>setHome(d))
          .catch(()=>window.alert(t("home_load_error")));
      }} style={{marginTop:8}}>{t("home_close_workout")}</Btn>}
      <div style={{display:"flex",alignItems:"center",marginTop:12}}>
        <span style={{fontSize:13,color:C.muted}}>
          {card.est_minutes?`~${card.est_minutes} ${t("home_min")}`:""}
          {/* Разделитель: теперь рекомендация несёт и время, и состав, и без него
              строка склеивалась в «~60 мин6 упражнений» */}
          {card.est_minutes&&card.exercises_count?" · ":""}
          {card.exercises_count?`${card.exercises_count} ${t("home_exercises")}`:""}
        </span>
        {card.state==="recommendation"&&
          <span onClick={()=>onNav("alternatives")} style={{marginLeft:"auto",fontSize:14,color:C.accent,cursor:"pointer"}}>{t("home_other_option")}</span>}
      </div>
    </Card>}

    <div style={{display:"flex",justifyContent:"space-between",paddingBottom:14,borderBottom:`0.5px solid ${C.border}`,marginBottom:14}}>
      <div onClick={()=>onNav("nutrition")} style={{cursor:"pointer",padding:"2px 4px"}}>
        <div style={{fontSize:13,color:C.muted,marginBottom:3}}>{t("home_food")}</div>
        <div style={{fontSize:17,color:C.text}}>{st.kcal_eaten||0} <span style={{fontSize:13,color:C.muted}}>/ {st.kcal_goal}</span></div>
      </div>
      {/* Тап по расходу показывает, откуда он взялся — историю за день,
          а не экран записи нового занятия, как было раньше */}
      <div onClick={()=>onNav("my_workouts")} style={{cursor:"pointer",padding:"2px 4px"}}>
        <div style={{fontSize:13,color:C.muted,marginBottom:3}}>{t("home_burned")}</div>
        <div style={{fontSize:17,color:(st.kcal_burned||0)>=(st.burn_goal||400)?C.accent:C.text}}>
          {st.kcal_burned||0} <span style={{fontSize:13,color:C.muted}}>/ {st.burn_goal}</span>
        </div>
      </div>
      <div onClick={()=>onNav((st.days_since_checkin===null||st.days_since_checkin>=7)?"checkin":"measurements")} style={{cursor:"pointer",padding:"2px 4px"}}>
        <div style={{fontSize:13,color:C.muted,marginBottom:3}}>{t("home_weight")}</div>
        <div style={{fontSize:17,color:C.text}}>{st.weight?st.weight:"—"} <span style={{fontSize:13,color:C.muted}}>{t("home_kg")}</span></div>
        {(st.days_since_checkin===null||st.days_since_checkin>=7)&&
          <div style={{fontSize:11,color:C.accent,marginTop:3}}>{t("home_checkin_due")}</div>}
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
      {[
        {icon:"📷",label:t("home_photo_food"),s:"food_vision"},
        {icon:"💬",label:t("home_ask_coach"),s:"tab_ai"},
        {icon:"📅",label:t("menu_plan"),s:"plan_workout"},
        {icon:"⊞",label:t("home_services"),s:"more"},
      ].map(it=><Card key={it.s} onClick={()=>onNav(it.s)} pad="13px 14px">
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <span style={{fontSize:17}}>{it.icon}</span>
          <span style={{fontSize:14,color:C.text}}>{it.label}</span>
        </div>
      </Card>)}
    </div>
    <ProgramHomeCard tgId={tgId} onNav={onNav}/>
    <Card onClick={()=>onNav("social")} pad="13px 14px" style={{marginTop:8}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}>
        <span style={{fontSize:17}}>👥</span>
        <span style={{fontSize:14,color:C.text}}>{t("soc_menu")}</span>
        <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
      </div>
    </Card>
    {prem?.visible&&<Card accent onClick={()=>onNav("premium")} pad="13px 14px" style={{marginTop:8}}>
      <div style={{display:"flex",alignItems:"center",gap:9}}>
        <Icon name="star" size={18} fill="currentColor"/>
        <span style={{fontSize:14,color:C.text,fontWeight:600}}>{t("premium_menu")}</span>
        <span style={{marginLeft:"auto",fontSize:12,color:C.accent,fontFamily:"monospace",textAlign:"right"}}>
          {prem.active?(prem.until?fmtDay(prem.until):"✓"):t("premium_nudge_ai").replace("{n}",prem.perks?.ai_premium)}
        </span>
      </div>
    </Card>}

  </div>;
}

function MoreScreen({user,onNav,onBack}){
  const [prem]=usePremium(user?.telegram_id);
  const groups=[
    {title:t("more_profile"),items:[
      {label:t("wn_menu"),icon:"✨",s:"whats_new"},
      {label:t("more_training_prefs"),icon:"⚙",s:"training_prefs"},
      {label:t("menu_goals"),icon:"🎯",s:"goals"},
      {label:t("menu_gamification"),icon:"🏆",s:"gamification"},
      {label:t("more_achievements"),icon:"🎖",s:"achievements"},
      {label:t("more_leaderboard"),icon:"📊",s:"leaderboard"},
      {label:t("soc_menu"),icon:"👥",s:"social"},
      {label:t("menu_referral"),icon:"🎁",s:"referral"},
      {label:t("menu_language"),icon:"🌐",s:"language"},
      {label:t("menu_support"),icon:"?",s:"support"},
      {label:t("terms_menu"),icon:"§",s:"terms"},
    ]},
    {title:t("more_training"),items:[
      {label:t("prog_menu"),icon:"📋",s:"programs"},
      {label:t("str_menu"),icon:"⚡",s:"strength"},
      {label:t("menu_plan"),icon:"📅",s:"plan_workout"},
      {label:t("menu_rest_timer"),icon:"⏱",s:"rest_timer"},
      {label:t("menu_sport"),icon:"⚽",s:"sport_log"},
    ]},
    {title:t("more_health"),items:[
      {label:t("menu_checkin"),icon:"✓",s:"checkin"},
      {label:t("menu_measurements"),icon:"○",s:"measurements"},
      {label:t("menu_reminders"),icon:"🔔",s:"reminders"},
    ]},
    {title:t("more_catalog"),items:[
      {label:t("menu_food_guide"),icon:"🥗",s:"food_guide"},
      {label:t("menu_supplements"),icon:"◆",s:"supplements"},
    ]},
  ];
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <div onClick={()=>onNav("profile")} style={{display:"flex",alignItems:"center",gap:12,marginBottom:20,cursor:"pointer"}}>
      <div style={{width:44,height:44,borderRadius:"50%",background:C.card,border:`0.5px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,color:C.accent}}>
        {(user?.first_name||"?").trim().charAt(0).toUpperCase()}
      </div>
      <div>
        <div style={{fontSize:17,fontWeight:600,color:C.text}}>{user?.first_name||t("onb_atlet")}</div>
        <div style={{fontSize:13,color:C.muted}}>{t("more_edit_profile")}</div>
      </div>
      <span style={{marginLeft:"auto",color:C.muted,fontSize:20}}>›</span>
    </div>
    {prem?.visible&&<Card accent onClick={()=>onNav("premium")} pad="12px 14px" style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:11}}>
        <Icon name="star" size={18} fill="currentColor" style={{width:20}}/>
        <span style={{fontSize:14,color:C.text,fontWeight:600}}>{t("premium_menu")}</span>
        <span style={{marginLeft:"auto",fontSize:11,color:C.accent,fontFamily:"monospace"}}>
          {prem.active?(prem.until?fmtDay(prem.until):"✓"):""}
        </span>
        <span style={{color:C.muted,fontSize:16}}>›</span>
      </div>
    </Card>}
    {groups.map((g,gi)=><div key={gi} style={{marginBottom:18}}>
      <Kicker>{g.title}</Kicker>
      <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
        {g.items.map(it=><Card key={it.s} onClick={()=>onNav(it.s)} pad="12px 14px">
          <div style={{display:"flex",alignItems:"center",gap:11}}>
            <span style={{fontSize:16,width:20,textAlign:"center"}}>{it.icon}</span>
            <span style={{fontSize:14,color:C.text}}>{it.label}</span>
            <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
          </div>
        </Card>)}
      </div>
    </div>)}
  </div>;
}

function AlternativesScreen({tgId,onNav,onBack}){
  const [data,setData]=useState(null);
  const [failed,setFailed]=useState(false);
  // Какой вариант сейчас собирается. Хук обязан стоять здесь, до условных
  // return ниже, иначе порядок хуков между рендерами разойдётся.
  const [composing,setComposing]=useState(null);

  useEffect(()=>{
    if(!tgId)return;
    apiGet(`${API}/home/${tgId}/alternatives`)
      .then(d=>setData(d)).catch(()=>setFailed(true));
  },[tgId]);

  if(failed)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <div style={{fontSize:14,color:C.muted,marginTop:20}}>{t("home_load_error")}</div>
  </div>;
  if(!data)return <Loader text={t("loading")}/>;

  const restLabel=(r)=>r===null||r===undefined?t("alt_never"):`${t("alt_rest")} ${r} ${t("alt_days")}`;

  async function start(o){
    const gids=o.group_ids||[];
    if(gids.length===0){onNav("active_workout",{preselectedGroupIds:[]});return;}
    // Состав подбираем по тапу: в списке его не считали, чтобы экран открывался быстро.
    setComposing(o.key);
    try{
      const r=await fetch(`${API}/home/${tgId}/compose?group_ids=${gids.join(",")}`);
      const d=r.ok?await r.json():null;
      if(d?.exercise_ids?.length>0){
        onNav("active_workout",{preselectedExIds:d.exercise_ids,preselectedGroupIds:gids});
        return;
      }
    }catch{}
    finally{setComposing(null);}
    // Подобрать не из чего — ведём на выбор упражнений с отмеченными группами
    onNav("active_workout",{preselectedGroupIds:gids});
  }

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("alt_kicker")}</Kicker>
    <Hero style={{fontSize:22}}>{t("alt_title")}</Hero>
    <div style={{height:16}}/>

    <Card onClick={()=>onNav("repeat_last")} style={{marginBottom:8}} pad="14px 16px">
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:17}}>↺</span>
        <span style={{fontSize:15,color:C.text}}>{t("alt_repeat_last")}</span>
        <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
      </div>
    </Card>
    <Card onClick={()=>onNav("active_workout")} style={{marginBottom:20}} pad="14px 16px">
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:17}}>✎</span>
        <span style={{fontSize:15,color:C.text}}>{t("alt_build_own")}</span>
        <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
      </div>
    </Card>

    {data.available?.length>0&&<Fragment>
      <Kicker>{t("alt_available")}</Kicker>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:8,marginBottom:20}}>
        {data.available.map(o=><Card key={o.key} onClick={()=>{if(!composing)start(o);}} pad="13px 16px"
          style={composing&&composing!==o.key?{opacity:0.5}:undefined}>
          <div style={{display:"flex",alignItems:"baseline"}}>
            <span style={{fontSize:15,color:C.text}}>{o.title}</span>
            <span style={{marginLeft:"auto",fontSize:12,color:C.muted}}>~{o.est_minutes} {t("home_min")}</span>
          </div>
          <div style={{fontSize:13,color:C.muted,marginTop:4}}>
            {composing===o.key?t("loading"):restLabel(o.rest_days)}
          </div>
        </Card>)}
      </div>
    </Fragment>}

    {data.recently_trained?.length>0&&<Fragment>
      <Kicker>{t("alt_recent")}</Kicker>
      <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8,marginBottom:20}}>
        {data.recently_trained.map(o=><Card key={o.key} onClick={()=>{
          if(window.confirm(`${o.title}: ${restLabel(o.rest_days)}. ${t("alt_confirm_repeat")}`))start(o);
        }} pad="12px 16px" style={{opacity:0.55}}>
          <div style={{display:"flex",alignItems:"baseline"}}>
            <span style={{fontSize:14,color:C.muted}}>{o.title}</span>
            <span style={{marginLeft:"auto",fontSize:12,color:C.muted}}>{o.done_date||""}</span>
          </div>
        </Card>)}
      </div>
    </Fragment>}

    <Card onClick={()=>onNav("training_prefs")} pad="13px 16px">
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{fontSize:16}}>⚙</span>
        <span style={{fontSize:14,color:C.text}}>{t("alt_split")}: {data.split_name}</span>
        <span style={{marginLeft:"auto",fontSize:13,color:C.accent}}>{t("alt_change")}</span>
      </div>
    </Card>
  </div>;
}

function TrainingPrefsScreen({tgId,onBack}){
  const [splits,setSplits]=useState([]);
  const [cur,setCur]=useState(null);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);

  useEffect(()=>{
    apiGet(`${API}/splits?lang=${encodeURIComponent(LANG_STORE.current||"ru")}`).then(d=>setSplits(d.splits||[])).catch(()=>setSplits([]));
    if(tgId)apiGet(`${API}/home/${tgId}/alternatives`)
      .then(d=>setCur({split_type:d.split_type,target:d.week?.target||null})).catch(()=>setCur({split_type:"auto",target:null}));
  },[tgId]);

  if(!cur)return <Loader text={t("loading")}/>;

  function save(patch){
    const next={...cur,...patch};
    setCur(next);setSaving(true);setSaved(false);
    fetch(`${API}/training-prefs/${tgId}`,{
      method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({target_workouts_per_week:next.target,split_type:next.split_type}),
    }).then(()=>{setSaved(true);}).catch(()=>{}).finally(()=>setSaving(false));
  }

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("prefs_kicker")}</Kicker>
    <Hero style={{fontSize:22}}>{t("prefs_title")}</Hero>
    <div style={{height:20}}/>

    <Kicker>{t("prefs_freq")}</Kicker>
    <div style={{fontSize:13,color:C.muted,marginTop:6,marginBottom:10}}>{t("prefs_freq_hint")}</div>
    <div style={{display:"flex",gap:6,marginBottom:24}}>
      {[2,3,4,5,6].map(n=><div key={n} onClick={()=>save({target:n})}
        style={{flex:1,padding:"12px 0",textAlign:"center",borderRadius:10,cursor:"pointer",
          background:cur.target===n?C.accent:C.card,border:`0.5px solid ${cur.target===n?C.accent:C.border}`,
          color:cur.target===n?C.bg:C.text,fontSize:16,fontWeight:600}}>{n}</div>)}
    </div>

    <Kicker>{t("prefs_split")}</Kicker>
    <div style={{fontSize:13,color:C.muted,marginTop:6,marginBottom:10}}>{t("prefs_split_hint")}</div>
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      {splits.map(s=><Card key={s.key} accent={cur.split_type===s.key} onClick={()=>save({split_type:s.key})} pad="13px 16px">
        <div style={{display:"flex",alignItems:"center"}}>
          <div>
            <div style={{fontSize:15,color:cur.split_type===s.key?C.accent:C.text}}>{s.name}</div>
            {s.days&&<div style={{fontSize:12,color:C.muted,marginTop:3}}>{s.days} {t("prefs_days_in_cycle")}</div>}
          </div>
          {cur.split_type===s.key&&<span style={{marginLeft:"auto",color:C.accent,fontSize:18}}>✓</span>}
        </div>
      </Card>)}
    </div>

    {saving&&<div style={{marginTop:14,fontSize:13,color:C.muted}}>{t("prefs_saving")}</div>}
    {saved&&!saving&&<div style={{marginTop:14,fontSize:13,color:C.accent}}>{t("prefs_saved")}</div>}
  </div>;
}

function UserSupplementsBlock({tgId}){
  const COMMON=[
    t("supp_protein"),t("supp_creatine"),t("supp_omega"),t("supp_vitd"),t("supp_magnesium"),
    "BCAA",t("supp_zinc"),t("supp_vitc"),t("supp_multi"),t("supp_glutamine"),
    t("supp_collagen"),t("supp_melatonin"),t("supp_caffeine"),t("supp_beta"),t("supp_preworkout"),
  ];
  const [supps,setSupps]=useState(null);
  const [adding,setAdding]=useState(false);
  const [form,setForm]=useState({name:"",dose:"",timing:""});
  const [saving,setSaving]=useState(false);

  useEffect(()=>{
    if(!tgId)return;
    fetch(`${API}/user/${tgId}/supplements`).then(r=>r.json()).then(d=>setSupps(d.supplements||[])).catch(()=>setSupps([]));
  },[]);

  async function add(name,dose="",timing=""){
    setSaving(true);
    try{
      await fetch(`${API}/user/${tgId}/supplements`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name,dose:dose||null,timing:timing||null,is_custom:!COMMON.includes(name)})});
      const d=await fetch(`${API}/user/${tgId}/supplements`).then(r=>r.json());
      setSupps(d.supplements||[]);
      setAdding(false);setForm({name:"",dose:"",timing:""});
    }catch{}finally{setSaving(false);}
  }

  async function remove(id){
    await fetch(`${API}/user/${tgId}/supplements/${id}`,{method:"DELETE"});
    setSupps(p=>p.filter(s=>s.id!==id));
  }

  const alreadyAdded=new Set((supps||[]).map(s=>s.name));

  return<div style={{marginBottom:16}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
      <Kicker>{t("supps_label")}</Kicker>
      <button onClick={()=>setAdding(!adding)}
        style={{background:"none",border:`0.5px solid ${C.accent}`,borderRadius:6,padding:"3px 10px",
          color:C.accent,fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>
        {adding?"✕":t("usup_dobavit")}
      </button>
    </div>
    {supps===null?<Loader text={t("loading")}/>:supps.length===0&&!adding?
      <div style={{color:C.muted,fontSize:12,fontFamily:"monospace",padding:"8px 0"}}>{t("not_specified2")}</div>:
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:adding?12:0}}>
        {supps.map(s=><div key={s.id} style={{display:"flex",alignItems:"center",gap:6,
          background:C.card,border:`0.5px solid ${C.border}`,borderRadius:20,padding:"5px 10px"}}>
          <span style={{fontSize:12,color:C.text}}>{tSport(s)||s.name}</span>
          {s.dose&&<span style={{fontSize:10,color:C.muted}}>{s.dose}</span>}
          <button onClick={()=>remove(s.id)}
            style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:12,padding:0,lineHeight:1}}>✕</button>
        </div>)}
      </div>}
    {adding&&<Card style={{marginTop:8}}>
      <Kicker>{t("quick_select")}</Kicker>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,margin:"8px 0 12px"}}>
        {COMMON.filter(n=>!alreadyAdded.has(n)).map(n=>(
          <button key={n} onClick={()=>add(n)}
            style={{padding:"5px 12px",borderRadius:20,fontSize:12,cursor:"pointer",
              background:C.card,border:`0.5px solid ${C.border}`,color:C.text}}>{n}</button>
        ))}
      </div>
      <Kicker>{t("manual_input")}</Kicker>
      <input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))}
        placeholder={t("supp_name")}
        style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
          padding:"8px 12px",color:C.text,fontSize:13,outline:"none",
          boxSizing:"border-box",marginTop:6,marginBottom:6}}/>
      <div style={{display:"flex",gap:6,marginBottom:8}}>
        <input value={form.dose} onChange={e=>setForm(p=>({...p,dose:e.target.value}))}
          placeholder={t("supp_dose")}
          style={{flex:1,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"8px 10px",color:C.text,fontSize:12,outline:"none"}}/>
        <input value={form.timing} onChange={e=>setForm(p=>({...p,timing:e.target.value}))}
          placeholder={t("supp_timing")}
          style={{flex:1,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"8px 10px",color:C.text,fontSize:12,outline:"none"}}/>
      </div>
      <Btn accent full onClick={()=>form.name.trim()&&add(form.name.trim(),form.dose,form.timing)} disabled={!form.name.trim()||saving}>
        {saving?t("saving2"):t("usup_dobavit2")}
      </Btn>
    </Card>}
  </div>;
}

function ProfileScreen({user,tgId,onBack,onUserUpdated,onNav}){
  const [editing,setEditing]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [form,setForm]=useState({age:"",weight:"",height:"",gender:"male",fitness_level:"beginner",desired_result:"stay_healthy",ai_tone:"",medical_conditions:[],allergies:[]});

  // _disk — профиль с прошлого запуска, без заболеваний и аллергий: ждём свежий
  if(user?._disk)return <DiskWait onBack={onBack} text={t("section_profile")} onRetry={onUserUpdated}/>;
  if(!user)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("section_profile")}/></div>;

  function startEdit(){
    setForm({age:user.age||"",weight:user.weight||"",height:user.height||"",gender:user.gender||"male",fitness_level:user.fitness_level||"beginner",desired_result:user.desired_result||"stay_healthy",
      medical_conditions:(user.medical_conditions||[]).filter(c=>c!=="none"),
      allergies:(user.allergies||[]).filter(a=>a!=="none"),
      ai_tone:user.ai_tone||"",
    });setEditing(true);
  }
  async function handleSave(){
    setSaving(true);
    try{
      const body={age:parseInt(form.age)||undefined,weight:parseFloat(form.weight)||undefined,height:parseInt(form.height)||undefined,
        gender:form.gender,fitness_level:form.fitness_level,desired_result:form.desired_result,
        ai_tone:form.ai_tone||undefined,
        medical_conditions:form.medical_conditions.length?form.medical_conditions:["none"],
        allergies:form.allergies.length?form.allergies:["none"]};
      const res=await fetch(`${API}/user/${tgId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(res.ok){setSaved(true);setEditing(false);onUserUpdated();setTimeout(()=>setSaved(false),3000);}
      else if(res.status===404){alert(t("prof_profil_ne_nayden_snachala"));}
      else{alert(t("err_save_status").replace("{code}",res.status));}
    }catch(e){alert(t("error_conn"));}finally{setSaving(false);}
  }

  const medNames=(user.medical_conditions||[]).filter(c=>c!=="none").map(c=>getOptLabel(c));
  const algNames=(user.allergies||[]).filter(a=>a!=="none").map(a=>getOptLabel(a));
  const aiLimit=user.ai_daily_limit||5;
  // Таблица профиля была целиком русской: и подписи строк, и единицы, и стиль AI.
  // Уровень и цель берём через функции, а не через карты LEVEL_LABELS/GOAL_LABELS:
  // карты вычисляются при загрузке модуля и языка ещё не знают.
  const rows=[{l:t("field_age"),v:user.age?`${user.age} ${t("u_let")}`:"—"},{l:t("home_weight"),v:user.weight?`${user.weight} ${t("home_kg")}`:"—"},{l:t("height_label"),v:user.height?`${user.height} ${t("meas_sm")}`:"—"},{l:t("bmi_label"),v:user.bmi||"—"},{l:t("prof_uroven"),v:getLevelLabel(user.fitness_level)||"—"},{l:t("goal_target"),v:getGoalLabel(user.desired_result)||"—"},{l:t("menu_language"),v:(user.lang||"ru").toUpperCase()},{l:t("prof_stil_ai"),v:{"bro":t("prof_bro"),"mentor":t("prof_nastavnik"),"expert":t("prof_ekspert")}[user.ai_tone]||t("prof_ekspert")},{l:t("ai_today"),v:`${user.ai_requests_today||0}/${aiLimit}`},{l:t("prof_status"),v:user.rank_name||"🥉"},{l:t("prof_bally"),v:`${user.total_points||0} pts`}];

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("my_profile")}</Kicker>
    <Hero>{user.first_name||t("onb_atlet")}</Hero>
    {user.username&&<div style={{color:C.muted,fontSize:13,marginTop:4,fontFamily:"monospace"}}>@{user.username}</div>}
    <div style={{height:16}}/>
    {saved&&<div style={{background:"#00CC6622",border:`0.5px solid ${C.success}`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontFamily:"monospace",fontSize:12,color:C.success}}>{t("status_saved")}</div>}
    {!editing?<>
      <Card style={{marginBottom:12}}>
        {rows.map((r,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:i<rows.length-1?`0.5px solid ${C.border}`:"none"}}>
          <span style={{fontSize:13,color:C.muted,fontFamily:"monospace"}}>{r.l}</span>
          <span style={{fontSize:13,color:C.text,fontWeight:500}}>{r.v}</span>
        </div>)}
      </Card>
      <div style={{marginBottom:12}}>
        <Kicker>{t("med_label")}</Kicker>
        <Card>{medNames.length>0?<div style={{display:"flex",flexWrap:"wrap",gap:6}}>{medNames.map((n,i)=><Tag key={i} color={C.danger}>{n}</Tag>)}</div>:<span style={{fontSize:13,color:C.muted}}>{t("not_specified3")}</span>}</Card>
      </div>
      <div style={{marginBottom:16}}>
        <Kicker>{t("allergy_section")}</Kicker>
        <Card>{algNames.length>0?<div style={{display:"flex",flexWrap:"wrap",gap:6}}>{algNames.map((n,i)=><Tag key={i} color={C.warn}>{n}</Tag>)}</div>:<span style={{fontSize:13,color:C.muted}}>{t("not_specified3")}</span>}</Card>
      </div>
      <UserSupplementsBlock tgId={tgId}/>
      <Btn accent full onClick={startEdit}>{t("edit_profile_btn2")}</Btn>
    </>:<>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {[{label:t("field_age_y"),key:"age",placeholder:"45"},{label:t("field_weight_kg"),key:"weight",placeholder:"86"},{label:t("field_height_cm"),key:"height",placeholder:"186"}].map(f=><Card key={f.key}>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{f.label.toUpperCase()}</div>
          <input type="number" value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.placeholder} style={{background:"none",border:"none",color:C.accent,fontSize:22,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/>
        </Card>)}
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("gender_label")}</div><Sel value={form.gender} onChange={v=>setForm(p=>({...p,gender:v}))} options={[{value:"male",label:t("gender_male")},{value:"female",label:t("gender_female")}]}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("level_section")}</div><Sel value={form.fitness_level} onChange={v=>setForm(p=>({...p,fitness_level:v}))} options={[{value:"beginner",label:t("lvl_novichok")},{value:"intermediate",label:t("level_intermediate")},{value:"advanced",label:t("level_advanced")}]}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("goal_section")}</div><Sel value={form.desired_result} onChange={v=>setForm(p=>({...p,desired_result:v}))} options={[{value:"lose_weight",label:t("goal_lose")},{value:"gain_muscle",label:t("goal_muscle")},{value:"gain_strength",label:t("goal_strength")},{value:"improve_endurance",label:t("goal_endurance")},{value:"stay_healthy",label:t("goal_health")}]}/></Card>
        <Card style={{marginBottom:12}}>
          <Kicker style={{marginBottom:10}}>{t("ai_style_label")}</Kicker>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[
                {v:"bro",    icon:"🤙", label:t("ai_bro_name"),  desc:t("ai_bro_desc")},
                {v:"mentor", icon:"🧑‍🏫", label:t("prof_nastavnik2"),   desc:t("ai_mentor_desc")},
                {v:"expert", icon:"🎓", label:t("prof_ekspert2"),     desc:t("ai_expert_desc")},
              ].map(t=>{
                const isSelected = form.ai_tone===t.v || (!form.ai_tone && t.v==="expert");
                return(
                  <div key={t.v} onClick={()=>setForm(p=>({...p,ai_tone:t.v}))}
                    style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:10,
                      border:`1px solid ${isSelected?C.accent:C.border}`,
                      background:isSelected?"rgba(200,255,0,0.08)":"none",cursor:"pointer"}}>
                    <span style={{fontSize:20}}>{t.icon}</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:isSelected?C.accent:C.text}}>{t.label}</div>
                      <div style={{fontSize:11,color:C.muted}}>{t.desc}</div>
                    </div>
                    {isSelected&&<span style={{color:C.accent,fontSize:16}}>✓</span>}
                  </div>
                );
              })}
            </div>
        </Card>
        <Card>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:10}}>{t("med_label")}</div>
          <CheckboxGroup options={MEDICAL_OPTIONS} selected={form.medical_conditions} onChange={v=>setForm(p=>({...p,medical_conditions:v}))}/>
          {form.medical_conditions.length===0&&<div style={{fontSize:11,color:C.muted,marginTop:8,fontFamily:"monospace"}}>{t("no_conditions2")}</div>}
        </Card>
        <Card>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:10}}>{t("allergy_section")}</div>
          <CheckboxGroup options={ALLERGY_OPTIONS} selected={form.allergies} onChange={v=>setForm(p=>({...p,allergies:v}))}/>
          {form.allergies.length===0&&<div style={{fontSize:11,color:C.muted,marginTop:8,fontFamily:"monospace"}}>{t("no_allergies2")}</div>}
        </Card>
      </div>
      <div style={{display:"flex",gap:10}}>
        <Btn full onClick={()=>setEditing(false)} style={{flex:1}}>{t("cancel_btn2")}</Btn>
        <Btn accent full onClick={handleSave} disabled={saving} style={{flex:2}}>{saving?t("saving"):t("save_profile")}</Btn>
      </div>
    </>}

    {!editing&&user?.consents&&<div style={{marginTop:20}}>
      <Kicker>{t("consent_record")}</Kicker>
      <div style={{fontSize:12,color:C.muted,marginTop:6,marginBottom:8}}>
        {t("consent_ver")} {user.consent_version||"—"}
        {user.consent_username?` · @${user.consent_username}`:""}
        {user.consent_platform?` · ${user.consent_platform}`:""}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {CONSENT_ITEMS.map(it=>{
          const given=user.consents[it.k];
          return <Card key={it.k} pad="11px 14px">
            <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
              <span style={{fontSize:14,color:given?C.accent:C.muted,marginTop:1}}>{given?"✓":"—"}</span>
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontSize:13,color:C.text,lineHeight:1.4}}>{t(it.label)}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:3}}>
                  {given?new Date(given).toLocaleString():t("consent_not_given")}
                </div>
              </div>
              {given&&!it.req&&<span onClick={()=>{
                if(!window.confirm(t(it.k==="ai"?"consent_wd_ai_confirm":"consent_wd_health_confirm")))return;
                fetch(`${API}/consent/${tgId}/withdraw`,{method:"POST",headers:{"Content-Type":"application/json"},
                  body:JSON.stringify({kind:it.k})})
                  .then(r=>{if(!r.ok)throw new Error();return r.json();})
                  .then(()=>onUserUpdated&&onUserUpdated())
                  .catch(()=>window.alert(t("home_load_error")));
              }} style={{fontSize:12,color:C.danger,cursor:"pointer",flexShrink:0,marginTop:2}}>
                {t("consent_withdraw")}
              </span>}
              {!given&&<span onClick={()=>{
                fetch(`${API}/consent/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},
                  body:JSON.stringify({kinds:[it.k],
                    platform:(tg?.platform||"unknown")+(tg?.version?` ${tg.version}`:"")})})
                  .then(r=>{if(!r.ok)throw new Error();return r.json();})
                  .then(()=>onUserUpdated&&onUserUpdated())
                  .catch(()=>window.alert(t("home_load_error")));
              }} style={{fontSize:12,color:C.accent,cursor:"pointer",flexShrink:0,marginTop:2,
                border:`0.5px solid ${C.accent}`,borderRadius:6,padding:"3px 10px"}}>
                {t("consent_give")}
              </span>}
              {given&&it.req&&<span style={{fontSize:11,color:C.muted,flexShrink:0,marginTop:3}}>{t("consent_req_note")}</span>}
            </div>
          </Card>;
        })}
      </div>
    </div>}

    {/* Сигнал об отдыхе. Выключен по умолчанию — включает человек сам,
        здесь или по предложению после первой тренировки. */}
    {!editing&&<div style={{marginTop:20}}>
      <Kicker>{t("rest_notify_title")}</Kicker>
      <Card style={{marginTop:8}} pad="12px 14px" onClick={()=>{
        if(!tgId)return;
        const next=!user.rest_notify;
        fetch(`${API}/user/${tgId}`,{method:"PUT",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({rest_notify:next})})
          .then(()=>onUserUpdated&&onUserUpdated())
          .catch(()=>{});
      }}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,color:C.text}}>
              {user.rest_notify?t("rest_notify_on"):t("rest_notify_off")}
            </div>
            <div style={{fontSize:11,color:C.muted,marginTop:4,lineHeight:1.45}}>{t("rest_notify_hint")}</div>
          </div>
          <div style={{flexShrink:0,width:44,height:26,borderRadius:13,padding:2,
            background:user.rest_notify?C.accent:"#3A3A3A",transition:"background .15s"}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:user.rest_notify?C.bg:"#8A8A8A",
              transform:user.rest_notify?"translateX(18px)":"translateX(0)",transition:"transform .15s"}}/>
          </div>
        </div>
      </Card>
    </div>}

    {!editing&&<div style={{marginTop:20}}>
      <Kicker>{t("mydata_title")}</Kicker>
      <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
        <Card pad="12px 14px" onClick={()=>{
          if(!tgId)return;
          fetch(`${API}/account/${tgId}/export`).then(r=>r.json()).then(d=>{
            const blob=new Blob([JSON.stringify(d,null,2)],{type:"application/json"});
            const url=URL.createObjectURL(blob);
            const link=document.createElement("a");
            link.href=url; link.download=`gymbot-data-${tgId}.json`;
            document.body.appendChild(link); link.click();
            document.body.removeChild(link); URL.revokeObjectURL(url);
          }).catch(()=>window.alert(t("mydata_export_err")));
        }}>
          <div style={{display:"flex",alignItems:"center",gap:11}}>
            <span style={{fontSize:16,width:20,textAlign:"center"}}>⭳</span>
            <span style={{fontSize:14,color:C.text}}>{t("mydata_export")}</span>
            <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
          </div>
        </Card>
        <Card pad="12px 14px" danger onClick={()=>{
          if(!tgId)return;
          if(!window.confirm(t("mydata_del_confirm1")))return;
          const typed=window.prompt(t("mydata_del_confirm2"));
          if((typed||"").trim().toUpperCase()!=="DELETE")return;
          fetch(`${API}/account/${tgId}?confirm=DELETE`,{method:"DELETE"})
            .then(r=>{if(!r.ok)throw new Error();return r.json();})
            .then(()=>{
              try{localStorage.clear();sessionStorage.clear();}catch{}
              window.alert(t("mydata_del_done"));
              if(tg?.close)tg.close(); else window.location.reload();
            })
            .catch(()=>window.alert(t("mydata_del_err")));
        }}>
          <div style={{display:"flex",alignItems:"center",gap:11}}>
            <span style={{fontSize:16,width:20,textAlign:"center"}}>🗑</span>
            <span style={{fontSize:14,color:C.danger}}>{t("mydata_delete")}</span>
            <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
          </div>
        </Card>
      </div>
    </div>}

    {!editing&&onNav&&<div style={{marginTop:24}}>
      {[
        {icon:"⚙",label:t("more_training_prefs"),s:"training_prefs"},
        {icon:"🎯",label:t("menu_goals"),s:"goals"},
        {icon:"🏆",label:t("menu_gamification"),s:"gamification"},
        {icon:"🔔",label:t("menu_reminders"),s:"reminders"},
        {icon:"🎁",label:t("menu_referral"),s:"referral"},
        {icon:"🌐",label:t("menu_language"),s:"language"},
        {icon:"?",label:t("menu_support"),s:"support"},
      ].map(it=><Card key={it.s} onClick={()=>onNav(it.s)} pad="12px 14px" style={{marginBottom:6}}>
        <div style={{display:"flex",alignItems:"center",gap:11}}>
          <span style={{fontSize:16,width:20,textAlign:"center"}}>{it.icon}</span>
          <span style={{fontSize:14,color:C.text}}>{it.label}</span>
          <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
        </div>
      </Card>)}
    </div>}
  </div>;
}

// ─── WORKOUT HISTORY ──────────────────────────────────────────────────────────
function SportEditModal({session,tgId,onClose,onSaved,onDeleted}){
  const [duration,setDuration]=useState(String(session.duration_min||60));
  const [intensity,setIntensity]=useState(session.intensity||"medium");
  const [notes,setNotes]=useState(session.notes||"");
  const [score,setScore]=useState(session.score||"");
  const [saving,setSaving]=useState(false);

  async function save(){
    setSaving(true);
    try{
      // Удаляем старую и создаём новую с обновлёнными данными
      await fetch(`${API}/sport/${tgId}/${session.id}`,{method:"DELETE"});
      await fetch(`${API}/sport/${tgId}`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          sport_type:session.sport_type,
          duration_min:parseInt(duration)||session.duration_min,
          intensity,
          notes:notes.trim()||score.trim()?`${score?t("spedit_schet")+': '+score+'. ':''}${notes}`.trim():null,
          session_date:session.session_date,
        }),
      });
      onSaved();
    }catch{}finally{setSaving(false);}
  }

  async function del(){
    if(!window.confirm(t("delete_confirm")))return;
    setSaving(true);
    try{
      await fetch(`${API}/sport/${tgId}/${session.id}`,{method:"DELETE"});
      onDeleted();
    }catch{}finally{setSaving(false);}
  }

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",
      zIndex:300,display:"flex",alignItems:"flex-end",padding:"0"}}>
      <div style={{background:C.surface,borderRadius:"16px 16px 0 0",padding:"20px 16px 40px",
        width:"100%",border:`0.5px solid ${C.border}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:16,color:C.text}}>{session.sport_label}</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:20,cursor:"pointer"}}>✕</button>
        </div>

        <div style={{marginBottom:12}}>
          <Kicker>{t("sport_duration")}</Kicker>
          <div style={{display:"flex",gap:8,marginTop:6,flexWrap:"wrap"}}>
            {[30,45,60,90,120].map(d=>(
              <button key={d} onClick={()=>setDuration(String(d))}
                style={{padding:"6px 14px",borderRadius:8,fontSize:12,cursor:"pointer",
                  background:duration===String(d)?C.accent:C.card,
                  border:`0.5px solid ${duration===String(d)?C.accent:C.border}`,
                  color:duration===String(d)?C.bg:C.text,fontFamily:"monospace"}}>
                {d}
              </button>
            ))}
            <input type="number" value={duration} onChange={e=>setDuration(e.target.value)}
              style={{width:60,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
                padding:"6px 8px",color:C.text,fontSize:12,outline:"none",textAlign:"center"}}/>
          </div>
        </div>

        <div style={{marginBottom:12}}>
          <Kicker>{t("sport_intensity")}</Kicker>
          <div style={{display:"flex",gap:8,marginTop:6}}>
            {[{v:"low",l:t("intensity_low")},{v:"medium",l:t("intensity_medium")},{v:"high",l:t("intensity_high")}].map(i=>(
              <button key={i.v} onClick={()=>setIntensity(i.v)}
                style={{flex:1,padding:"8px 4px",borderRadius:8,fontSize:11,cursor:"pointer",
                  background:intensity===i.v?C.accent:C.card,
                  border:`0.5px solid ${intensity===i.v?C.accent:C.border}`,
                  color:intensity===i.v?C.bg:C.text}}>
                {i.l}
              </button>
            ))}
          </div>
        </div>

        <div style={{marginBottom:12}}>
          <Kicker>{t("score_opt")}</Kicker>
          <input value={score} onChange={e=>setScore(e.target.value)}
            placeholder={t("score_example")}
            style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
              padding:"8px 12px",color:C.text,fontSize:13,outline:"none",
              boxSizing:"border-box",marginTop:6}}/>
        </div>

        <div style={{marginBottom:16}}>
          <Kicker>{t("notes_section")}</Kicker>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)}
            placeholder={t("spedit_partnery_oschuscheniya")}
            style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
              padding:"8px 12px",color:C.text,fontSize:13,outline:"none",resize:"none",
              minHeight:50,fontFamily:"inherit",boxSizing:"border-box",marginTop:6}}/>
        </div>

        <div style={{display:"flex",gap:8}}>
          <Btn full onClick={del} disabled={saving} style={{flex:1,color:C.danger,border:`0.5px solid ${C.danger}`}}>{t("delete_btn")}</Btn>
          <Btn accent full onClick={save} disabled={saving} style={{flex:2}}>{saving?t("saving"):t("save_profile")}</Btn>
        </div>
      </div>
    </div>
  );
}


function AddCustomExerciseInline({tgId,muscleGroups,onAdded}){
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState("");
  const [f,setF]=useState({name:"",muscle_group_id:"",sets_recommended:"3",reps_recommended:"12",equipment:"",difficulty:"medium"});

  async function save(){
    if(!f.name.trim()){setErr(t("specify_name"));return;}
    setSaving(true);setErr("");
    try{
      const res=await fetch(`${API}/custom-exercises/${tgId}`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          name:f.name.trim(),
          muscle_group_id:f.muscle_group_id?parseInt(f.muscle_group_id):null,
          sets_recommended:parseInt(f.sets_recommended)||3,
          reps_recommended:parseInt(f.reps_recommended)||12,
          equipment:f.equipment||null,
          difficulty:f.difficulty,
        }),
      });
      if(!res.ok){setErr(t("error_save"));return;}
      const d=await res.json();
      const mg=muscleGroups?.find(g=>g.id===parseInt(f.muscle_group_id));
      onAdded({
        id:d.id,name:f.name.trim(),muscle_group_id:f.muscle_group_id?parseInt(f.muscle_group_id):null,
        sets_recommended:parseInt(f.sets_recommended)||3,reps_recommended:parseInt(f.reps_recommended)||12,
        equipment:f.equipment||null,difficulty:f.difficulty,is_custom:true,photo_url:null,
        group_name:mg?.name||t("cex_moe"),group_emoji:mg?.emoji||"⭐",
      });
      setOpen(false);
      setF({name:"",muscle_group_id:"",sets_recommended:"3",reps_recommended:"12",equipment:"",difficulty:"medium"});
    }catch{setErr(t("error_net"));}
    finally{setSaving(false);}
  }

  if(!open)return(
    <button onClick={()=>setOpen(true)}
      style={{width:"100%",marginTop:8,marginBottom:4,background:"none",
        border:`0.5px dashed ${C.border}`,borderRadius:10,padding:"10px 16px",
        color:C.muted,fontSize:12,cursor:"pointer",fontFamily:"monospace",letterSpacing:1}}>
      {t("ui_dobavit_svoe_uprazhnenie")}
    </button>
  );

  return(
    <Card style={{marginTop:8,marginBottom:8}}>
      <Kicker>{t("my_exercise_section")}</Kicker>
      <input value={f.name} onChange={e=>setF(p=>({...p,name:e.target.value}))}
        placeholder={t("name_req")}
        style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
          padding:"8px 12px",color:C.text,fontSize:13,outline:"none",
          marginBottom:8,boxSizing:"border-box",marginTop:8}}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
        <select value={f.muscle_group_id} onChange={e=>setF(p=>({...p,muscle_group_id:e.target.value}))}
          style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",
            color:C.text,fontSize:12,outline:"none"}}>
          <option value="">{t("exercise_group")}</option>
          {(muscleGroups||[]).map(g=><option key={g.id} value={g.id}>{g.emoji} {tField(g,"name")}</option>)}
        </select>
        <select value={f.difficulty} onChange={e=>setF(p=>({...p,difficulty:e.target.value}))}
          style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",
            color:C.text,fontSize:12,outline:"none"}}>
          <option value="easy">{t("difficulty_easy")}</option>
          <option value="medium">{t("difficulty_medium")}</option>
          <option value="hard">{t("difficulty_hard")}</option>
        </select>
        <input type="number" value={f.sets_recommended} onChange={e=>setF(p=>({...p,sets_recommended:e.target.value}))}
          placeholder={t("sets_num")}
          style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"8px 10px",color:C.text,fontSize:12,outline:"none",textAlign:"center"}}/>
        <input type="number" value={f.reps_recommended} onChange={e=>setF(p=>({...p,reps_recommended:e.target.value}))}
          placeholder={t("reps_num")}
          style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"8px 10px",color:C.text,fontSize:12,outline:"none",textAlign:"center"}}/>
      </div>
      {err&&<div style={{color:C.danger,fontSize:12,fontFamily:"monospace",marginBottom:6}}>{err}</div>}
      <div style={{display:"flex",gap:8}}>
        <Btn full onClick={()=>setOpen(false)} style={{flex:1}}>{t("cancel_btn2")}</Btn>
        <Btn accent full onClick={save} disabled={saving||!f.name.trim()} style={{flex:2}}>
          {saving?t("saving"):t("add")}
        </Btn>
      </div>
    </Card>
  );
}


// ── SportEditModal ────────────────────────────────────────────────────────────
function AddExerciseDuringWorkout({allExercises,muscleGroups,tgId,onAdd}){
  const [open,setOpen]=useState(false);
  const [search,setSearch]=useState("");
  const [groupId,setGroupId]=useState(null);

  const filtered=(allExercises||[]).filter(e=>
    (!groupId||e.muscle_group_id===groupId)&&
    (!search||(e.name.toLowerCase().includes(search.toLowerCase())||(tField(e,"name")||"").toLowerCase().includes(search.toLowerCase())))
  ).slice(0,20);

  if(!open)return(
    <button onClick={()=>setOpen(true)}
      style={{width:"100%",marginTop:4,background:"none",border:`0.5px dashed ${C.border}`,
        borderRadius:8,padding:"8px",color:C.muted,fontSize:11,cursor:"pointer",
        fontFamily:"monospace",letterSpacing:1}}>
      {t("add_exercise")}
    </button>
  );

  return(
    <div style={{marginTop:8,background:C.surface,border:`0.5px solid ${C.border}`,borderRadius:12,padding:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <Kicker>{t("add_exercise_btn")}</Kicker>
        <button onClick={()=>{setOpen(false);setSearch("");setGroupId(null);}}
          style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16}}>✕</button>
      </div>
      <input value={search} onChange={e=>setSearch(e.target.value)}
        placeholder={t("search_placeholder2")}
        style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
          padding:"8px 12px",color:C.text,fontSize:12,outline:"none",
          boxSizing:"border-box",marginBottom:8}}/>
      <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:4,marginBottom:8}}>
        <button onClick={()=>setGroupId(null)}
          style={{flexShrink:0,padding:"4px 10px",borderRadius:12,fontSize:10,cursor:"pointer",
            background:!groupId?C.accent:C.card,border:`0.5px solid ${!groupId?C.accent:C.border}`,
            color:!groupId?C.bg:C.muted,fontFamily:"monospace"}}>{t("all_btn")}</button>
        {(muscleGroups||[]).map(g=>(
          <button key={g.id} onClick={()=>setGroupId(groupId===g.id?null:g.id)}
            style={{flexShrink:0,padding:"4px 10px",borderRadius:12,fontSize:10,cursor:"pointer",
              background:groupId===g.id?C.accent:C.card,border:`0.5px solid ${groupId===g.id?C.accent:C.border}`,
              color:groupId===g.id?C.bg:C.muted,fontFamily:"monospace",display:"inline-flex",alignItems:"center",gap:4}}>
            {g.icon_url?<img src={g.icon_url} alt="" style={{width:14,height:14,objectFit:"cover",borderRadius:3}}/>:g.emoji}
          </button>
        ))}
      </div>
      <div style={{maxHeight:200,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
        {filtered.map(ex=>(
          <button key={ex.id} onClick={()=>{onAdd(ex);setOpen(false);setSearch("");setGroupId(null);}}
            style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,
              padding:"8px 10px",color:C.text,fontSize:12,cursor:"pointer",textAlign:"left",
              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontWeight:600}}>{tField(ex,"name")}</div>
              <div style={{fontSize:10,color:C.muted}}>{ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:13,height:13,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:3}}/>:ex.group_emoji+" "}{tGroup(ex)}</div>
            </div>
            <span style={{color:C.accent,fontSize:16,flexShrink:0}}>+</span>
          </button>
        ))}
        {filtered.length===0&&<div style={{textAlign:"center",color:C.muted,fontSize:12,padding:12}}>{t("not_found_hint")}</div>}
      </div>
    </div>
  );
}


// ── AddCustomExerciseInline ───────────────────────────────────────────────────
function PlateauBlock({tgId}){
  const [data,setData]=useState(null);
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    if(!tgId||!open)return;
    fetch(`${API}/plateau/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData(null));
  },[open]);

  return(
    <Card style={{marginBottom:16}}>
      <button onClick={()=>setOpen(!open)}
        style={{width:"100%",background:"none",border:"none",display:"flex",
          alignItems:"center",justifyContent:"space-between",cursor:"pointer",padding:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:18}}>📊</span>
          <Kicker style={{margin:0}}>{t("plateau_title")}</Kicker>
        </div>
        <span style={{color:C.accent,fontSize:14}}>{open?"∧":"∨"}</span>
      </button>
      {open&&<div style={{marginTop:12,paddingTop:12,borderTop:`0.5px solid ${C.border}`}}>
        {!data?<Loader text={t("plateau_analiz")}/>:
         !data.has_plateau?(
           <div style={{color:C.success,fontFamily:"monospace",fontSize:12,textAlign:"center",padding:"8px 0"}}>
             ✅ {t("plateau_none")}
           </div>
         ):(
           <div>
             {data.weight_plateau&&<div style={{marginBottom:10}}>
               <div style={{fontSize:12,color:C.warn,fontFamily:"monospace",marginBottom:4}}>
                 ⚠️ {t("plateau_weight")}
               </div>
               <div style={{fontSize:11,color:C.muted}}>
                 {t("ui_izmenenie_za_3_nedeli")} {data.weight_change > 0 ? "+" : ""}{data.weight_change} {t("home_kg")}
               </div>
             </div>}
             {data.stagnant_exercises?.length>0&&<div>
               <div style={{fontSize:12,color:C.warn,fontFamily:"monospace",marginBottom:6}}>
                 ⚠️ {t("plateau_exercise")}:
               </div>
               {data.stagnant_exercises.map((ex,i)=>(
                 <div key={i} style={{padding:"6px 0",borderBottom:`0.5px solid ${C.border}`,fontSize:12}}>
                   <div style={{color:C.text}}>{tField(ex,"name")}</div>
                   <div style={{color:C.muted,fontSize:11}}>
                     {ex.min_weight}–{ex.max_weight} {t("home_kg")} · {ex.sessions} {t("prog_trenirovok").toLowerCase()}
                   </div>
                 </div>
               ))}
               <div style={{marginTop:10,fontSize:11,color:C.muted}}>
                 {t("ui_poprobuy_smenit_uprazhnenie_il")}
               </div>
             </div>}
           </div>
         )
        }
      </div>}
    </Card>
  );
}

function AddCustomProductForm({onAdded}){
  const CATS=[
    {v:"meat",l:t("fcat_myaso")},{v:"fish",l:t("fcat_ryba")},{v:"dairy",l:t("fcat_molochka")},
    {v:"eggs",l:t("alg_yayca")},{v:"grains",l:t("fcat_krupy")},{v:"bread",l:t("fcat_hleb")},
    {v:"vegetables",l:t("fcat_ovoschi")},{v:"fruits",l:t("fcat_frukty")},{v:"nuts",l:t("alg_orehi")},
    {v:"drinks",l:t("fcat_napitki")},{v:"snacks",l:t("fcat_sneki")},{v:"other",l:t("fcat_prochee")},
  ];
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState("");
  const [f,setF]=useState({name:"",calories:"",protein:"",fat:"",carbs:"",fiber:"",category:"meat"});

  async function save(){
    if(!f.name.trim()||!f.calories){setErr(t("specify_name_cal"));return;}
    setSaving(true);setErr("");
    try{
      const res=await fetch(`${API}/food/products`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          name:f.name.trim(),calories:parseFloat(f.calories)||0,
          protein:parseFloat(f.protein)||0,fat:parseFloat(f.fat)||0,
          carbs:parseFloat(f.carbs)||0,fiber:parseFloat(f.fiber)||0,
          category:f.category,
        }),
      });
      if(res.status===409){setErr(t("product_exists"));return;}
      if(!res.ok){setErr(t("error_save"));return;}
      const d=await res.json();
      onAdded({
        id:d.id,name:f.name.trim(),calories:parseFloat(f.calories)||0,
        protein:parseFloat(f.protein)||0,fat:parseFloat(f.fat)||0,
        carbs:parseFloat(f.carbs)||0,fiber:parseFloat(f.fiber)||0,
        category:f.category,is_custom:true,is_verified:false,
      });
      setOpen(false);
      setF({name:"",calories:"",protein:"",fat:"",carbs:"",fiber:"",category:"meat"});
    }catch{setErr(t("error_net"));}
    finally{setSaving(false);}
  }

  if(!open)return(
    <button onClick={()=>setOpen(true)}
      style={{width:"100%",marginTop:8,background:"none",border:`0.5px dashed ${C.border}`,
        borderRadius:10,padding:"12px 16px",color:C.muted,fontSize:13,cursor:"pointer",
        fontFamily:"monospace",letterSpacing:1}}>
      {t("ui_dobavit_svoy_produkt")}
    </button>
  );

  return(
    <Card style={{marginTop:8}}>
      <Kicker>{t("new_product_section")}</Kicker>
      <input value={f.name} onChange={e=>setF(p=>({...p,name:e.target.value}))}
        placeholder={t("product_name")}
        style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
          padding:"10px 12px",color:C.text,fontSize:13,outline:"none",
          marginBottom:8,boxSizing:"border-box"}}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
        {[{k:"calories",p:t("calories_req")},{k:"protein",p:t("protein_g")},{k:"fat",p:t("fat_g")},{k:"carbs",p:t("carb_g")}].map(x=>(
          <input key={x.k} type="number" value={f[x.k]} onChange={e=>setF(p=>({...p,[x.k]:e.target.value}))}
            placeholder={x.p}
            style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
              padding:"8px 10px",color:C.text,fontSize:13,outline:"none",textAlign:"center"}}/>
        ))}
      </div>
      <Sel value={f.category} onChange={v=>setF(p=>({...p,category:v}))} options={CATS.map(c=>({value:c.v,label:c.l}))}/>
      {err&&<div style={{color:C.danger,fontSize:12,fontFamily:"monospace",marginTop:6}}>{err}</div>}
      <div style={{display:"flex",gap:8,marginTop:10}}>
        <Btn full onClick={()=>setOpen(false)} style={{flex:1}}>{t("cancel_btn2")}</Btn>
        <Btn accent full onClick={save} disabled={saving||!f.name.trim()||!f.calories} style={{flex:2}}>
          {saving?t("saving"):t("add")}
        </Btn>
      </div>
    </Card>
  );
}


// ── AddExerciseDuringWorkout ──────────────────────────────────────────────────

function WorkoutHistoryScreen({workouts,onNav,tgId,refreshToken=0}){
  const [activeTab,setActiveTab]=useState("planned");
  const [planned,setPlanned]=useState(null);
  const [deleting,setDeleting]=useState(null);
  const [sportSessions,setSportSessions]=useState(null);
  const [editSport,setEditSport]=useState(null);
  const [sportRefresh,setSportRefresh]=useState(0);

  useEffect(()=>{
    setPlanned(null);
    if(tgId)apiGet(`${API}/planned/${tgId}`).then(d=>setPlanned(d)).catch(()=>setPlanned({planned:[],archive:[]}));
    else setPlanned({planned:[],archive:[]});
  },[refreshToken]);

  useEffect(()=>{
    if(activeTab==="planned"&&!planned){
      if(tgId)apiGet(`${API}/planned/${tgId}`).then(d=>setPlanned(d)).catch(()=>setPlanned({planned:[],archive:[]}));
      else setPlanned({planned:[],archive:[]});
    }
    if(activeTab==="sport"){
      setSportSessions(null);
      if(tgId)fetch(`${API}/sport/${tgId}`).then(r=>r.json()).then(d=>setSportSessions(d.sessions||[])).catch(()=>setSportSessions([]));
      else setSportSessions([]);
    }
  },[activeTab,sportRefresh]);

  async function delPlanned(id){
    setDeleting(id);
    try{await fetch(`${API}/planned/${tgId}/${id}`,{method:"DELETE"});setPlanned(null);}
    catch{}finally{setDeleting(null);}
  }

  async function delSport(id){
    setDeleting(id);
    try{await fetch(`${API}/sport/${tgId}/${id}`,{method:"DELETE"});setSportSessions(null);}
    catch{}finally{setDeleting(null);}
  }

  const fmtDt=iso=>{const d=utcToLocal(iso);return d?d.toLocaleString(dateLocale(),{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—";};
  const fmtDate=iso=>{if(!iso)return"—";const d=new Date(iso+"T12:00:00");return d.toLocaleDateString(dateLocale(),{day:"numeric",month:"short"});};
  const statusColor={scheduled:C.accent,reminded:C.warn,completed:C.success,missed:C.danger};
  const intensityLabel={low:t("wh_nizkaya"),medium:t("wh_srednyaya"),high:t("wh_vysokaya")};
  const intensityColor={low:C.success,medium:C.accent,high:C.danger};

  if(!workouts)return <div style={{padding:"16px 16px 100px"}}><Loader text={t("workout_title")}/></div>;

  return <div style={{padding:"16px 16px 100px"}}>
    <Hero>{t("workouts_title")}</Hero>
    <div style={{height:12}}/>
    <div style={{display:"flex",gap:0,marginBottom:16,border:`0.5px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
      {[{id:"planned",label:t("planned_tab")},{id:"sport",label:t("sport_tab")},{id:"history",label:t("archive_tab")}].map(t=>(
        <button key={t.id} onClick={()=>setActiveTab(t.id)} style={{flex:1,padding:"10px 4px",background:activeTab===t.id?C.accent:C.card,border:"none",color:activeTab===t.id?C.bg:C.muted,fontFamily:"monospace",fontSize:10,fontWeight:700,cursor:"pointer",letterSpacing:0.5}}>
          {t.label}
        </button>
      ))}
    </div>
    {hasResumableActiveWorkout()&&<Card accent style={{marginBottom:8,cursor:"pointer"}} onClick={()=>onNav("active_workout")}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <span style={{fontSize:24}}>▶</span>
        <div style={{flex:1}}>
          <div style={{fontWeight:700,fontSize:14,color:C.accent}}>{t("continue_workout3")}</div>
          <div style={{fontSize:11,color:C.muted,marginTop:2}}>{t("unfinished")}</div>
        </div>
        <span style={{color:C.accent}}>→</span>
      </div>
    </Card>}
    {activeTab!=="sport"&&!hasResumableActiveWorkout()&&<Btn accent full onClick={()=>onNav("active_workout")} style={{marginBottom:16}}>{t("start_workout")}</Btn>}

    {activeTab==="history"&&(
      workouts.length===0
        ?<Card><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,marginBottom:8}}>◎</div><div style={{color:C.muted}}>{t("no_workouts_yet")}</div></div></Card>
        :<div style={{display:"flex",flexDirection:"column",gap:10}}>
          {workouts.map(w=><Card key={w.id} onClick={()=>onNav("workout_detail",{workoutId:w.id})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <Kicker>{utcToLocal(w.date||w.started_at)?.toLocaleDateString(dateLocale(),{day:"numeric",month:"short"})||"—"}</Kicker>
                <div style={{fontWeight:600,fontSize:15,color:C.text}}>{w.workout_type==="completed"?t("workout_type"):w.workout_type||t("workout_type")}</div>
              </div>
              <div style={{textAlign:"right"}}><Mono>{w.sets_count||0}</Mono><span style={{fontSize:11,color:C.muted}}> {t("sets_short2")}</span></div>
            </div>
            <div style={{borderTop:`0.5px solid ${C.border}`,marginTop:10,paddingTop:10,display:"flex",gap:20}}>
              <div><div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("tonnage_section")}</div><Mono>{Math.round((w.total_volume||0)/1000*10)/10}</Mono><span style={{fontSize:11,color:C.muted}}> {t("u_t")}</span></div>
              <div><div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("status_section")}</div><span style={{fontSize:12,fontFamily:"monospace",color:w.status==="finished"?C.success:C.muted}}>{w.status==="finished"?t("wh_zavershena"):w.status||"—"}</span></div>
            </div>
            <div style={{marginTop:8,fontSize:11,color:C.accent,fontFamily:"monospace"}}>{t("open_plan")}</div>
          </Card>)}
        </div>
    )}

    {activeTab==="sport"&&(
      <Fragment>
        <Btn accent full onClick={()=>onNav("sport_log",{})} style={{marginBottom:12}}>{t("record_sport")}</Btn>
        {!sportSessions?<Loader text={t("sport_cat")}/>:
         sportSessions.length===0?<Card><div style={{textAlign:"center",padding:"20px 0",color:C.muted}}>{t("no_sport_yet")}</div></Card>:
         <div style={{display:"flex",flexDirection:"column",gap:8}}>
           {(()=>{const today=localToday();
             const future=sportSessions.filter(s=>s.session_date>=today);
             const past=sportSessions.filter(s=>s.session_date<today);
             return(<>
             {future.map(s=>(
              <Card key={s.id} onClick={()=>setEditSport(s)} style={{cursor:"pointer",marginBottom:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:600,fontSize:15,color:C.text}}>{s.sport_label}</div>
                    <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:2}}>{fmtDate(s.session_date)}</div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{fontSize:10,color:C.accent,fontFamily:"monospace"}}>{t("edit_arrow")}</span>
                    <button onClick={e=>{e.stopPropagation();delSport(s.id);}} disabled={deleting===s.id}
                      style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:6,padding:"3px 8px",color:C.danger,fontSize:11,cursor:"pointer",flexShrink:0}}>
                      {deleting===s.id?"...":"✕"}
                    </button>
                  </div>
                </div>
                <div style={{borderTop:`0.5px solid ${C.border}`,marginTop:8,paddingTop:8,display:"flex",gap:16,flexWrap:"wrap"}}>
                  <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("time_label2")}</div><Mono size={13}>{s.duration_min} {t("home_min")}</Mono></div>
                  <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("sport_intensity")}</div><span style={{fontSize:12,fontFamily:"monospace",color:intensityColor[s.intensity]||C.muted}}>{intensityLabel[s.intensity]||s.intensity}</span></div>
                  {s.calories_burned>0&&<div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("calories_section")}</div><Mono size={13}>{s.calories_burned} {t("kcal_unit")}</Mono></div>}
                  {s.score&&<div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("score_section")}</div><Mono size={13}>{s.score}</Mono></div>}
                </div>
                {s.notes&&<div style={{fontSize:12,color:C.muted,marginTop:6}}>{s.notes}</div>}
              </Card>
             ))}
             {past.length>0&&<>
               <div style={{marginTop:12,marginBottom:6}}><Kicker>{t("archive_section")}</Kicker></div>
               {past.map(s=>(<Card key={s.id} style={{opacity:0.6,cursor:"pointer",marginBottom:8}} onClick={()=>setEditSport(s)}>
                 <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                   <div><div style={{fontWeight:600,fontSize:13,color:C.muted}}>{s.sport_label}</div>
                     <div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{fmtDate(s.session_date)}</div></div>
                   <Mono size={12} color={C.muted}>{s.duration_min} {t("home_min")}</Mono>
                 </div></Card>))}
             </>}
             </>);})()} 
          </div>
        }
      {editSport&&<SportEditModal
        session={editSport}
        tgId={tgId}
        onClose={()=>setEditSport(null)}
        onSaved={()=>{setEditSport(null);setSportRefresh(r=>r+1);}}
        onDeleted={()=>{setEditSport(null);setSportRefresh(r=>r+1);}}
      />}
      </Fragment>
    )}

    {activeTab==="planned"&&(
      !planned?<Loader text={t("wh_plan")}/>:<>
        {(planned.planned||[]).filter(pw=>pw.status==="scheduled"||pw.status==="reminded").length===0&&<Card style={{marginBottom:12}}><div style={{textAlign:"center",padding:"12px 0",color:C.muted,fontSize:14}}>{t("no_planned")}</div></Card>}
        {(planned.planned||[]).filter(pw=>pw.status==="scheduled"||pw.status==="reminded").map(pw=><Card key={pw.id} style={{marginBottom:8}} onClick={()=>onNav("planned_detail",{pwId:pw.id})}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:14,color:C.text}}>{pw.title}</div>
              <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginTop:3}}>{fmtDt(pw.planned_datetime)}</div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{fontSize:11,fontFamily:"monospace",color:statusColor[pw.status]||C.muted}}>{pw.status?.toUpperCase()}</span>
              <button onClick={e=>{e.stopPropagation();delPlanned(pw.id);}} disabled={deleting===pw.id} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:6,padding:"3px 8px",color:C.danger,fontSize:11,cursor:"pointer"}}>{deleting===pw.id?"...":"✗"}</button>
            </div>
          </div>
          <div style={{marginTop:8,fontSize:11,color:C.accent,fontFamily:"monospace"}}>{t("open_plan")}</div>
        </Card>)}
        <Btn full onClick={()=>onNav("plan_workout")} style={{marginTop:8}}>{t("add_plan2")}</Btn>
        {planned.archive?.length>0&&<>
          <div style={{marginTop:20,marginBottom:8}}><Kicker>{t("planned_archive")}</Kicker></div>
          {planned.archive.map(pw=><Card key={pw.id} style={{marginBottom:8,opacity:0.6}} onClick={()=>onNav("planned_detail",{pwId:pw.id,readOnly:true})}>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <div><div style={{fontWeight:600,fontSize:14,color:C.muted}}>{pw.title}</div><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:2}}>{fmtDt(pw.planned_datetime)}</div></div>
              <span style={{fontSize:11,fontFamily:"monospace",color:statusColor[pw.status]||C.muted}}>{pw.status?.toUpperCase()}</span>
            </div>
          </Card>)}
        </>}
      </>
    )}
  </div>;
}

// ─── WORKOUT DETAIL ───────────────────────────────────────────────────────────
function WorkoutDetailScreen({workoutId,tgId,onBack}){
  const [data,setData]=useState(null);
  useEffect(()=>{
    if(!workoutId||!tgId){setData({exercises:[],status:"error",_nodata:true});return;}
    fetch(`${API}/workout/${workoutId}?tg_id=${tgId}`)
      .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
      .then(setData)
      .catch(()=>setData({exercises:[],status:"error",_nodata:true}));
  },[workoutId]);

  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;
  if(data._nodata)return(
  <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("error_label2")}</Kicker>
    <Hero style={{fontSize:20}}>{t("failed_load2")}</Hero>
    <div style={{height:16}}/>
    <Card danger>
      <div style={{fontSize:13,color:C.danger,fontFamily:"monospace",lineHeight:1.6}}>
        {t("ui_trenirovka_ne_naydena_ili")}<br/>
        {t("ui_poprobuy_otkryt_cherez_telegra")}
      </div>
    </Card>
    <Btn full onClick={onBack} style={{marginTop:16}}>{t("back")}</Btn>
  </div>
);

  // Тренировка в процессе (active) — показываем что есть
  const isActive = data.status === "active";
  const totalSets=data.exercises?.reduce((s,e)=>s+e.sets.length,0)||0;
  // в базе UTC: тренировка в 01:00 по Ташкенту иначе показывалась вчерашним числом
  const dateStr=utcToLocal(data.date)?.toLocaleDateString(dateLocale(),{day:"numeric",month:"long",year:"numeric"})||"—";

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{dateStr}</Kicker>
    <Hero>{t("workout_sets")}</Hero>
    <div style={{height:12}}/>
    {isActive&&<div style={{background:"#FFB80022",border:`0.5px solid ${C.warn}`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,color:C.warn,fontFamily:"monospace"}}>{t("workout_still_active")}</div>}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
      {[{l:t("sets_label"),v:totalSets},{l:t("tonnage_label2"),v:`${Math.round((data.total_volume||0)/1000*10)/10} ${t("u_t")}`},{l:t("status_label"),v:data.status==="finished"?"✓":data.status||"—"}].map((s,i)=><Card key={i} style={{textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div><Mono size={14}>{s.v}</Mono></Card>)}
    </div>
    {(data.status==="finished"||data.status==="completed")&&totalSets>0&&<ShareWorkout tgId={tgId} workoutId={workoutId}/>}

    {data.exercises?.length===0&&<Card><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>{t("no_sets")}</div></Card>}

    {data.exercises?.map((ex,i)=><Card key={i} style={{marginBottom:10}}>
      <div style={{fontWeight:700,fontSize:15,color:C.text,marginBottom:10}}>{i+1}. {trEx(tField(ex,"name"))}</div>
      <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr 1fr",gap:"4px 12px",alignItems:"center"}}>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("wd_ph")}</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("weight_label2")}</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("reps_short2")}</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>RPE</div>
        {ex.sets.map((s,si)=>(
          <Fragment key={`set-${si}`}>
            <Mono size={13}>{s.set_number}</Mono>
            <Mono size={13}>{s.weight!=null?`${s.weight} ${t("home_kg")}`:"—"}</Mono>
            <Mono size={13}>{s.reps!=null?`${s.reps}`:"—"}</Mono>
            <Mono size={13} color={C.muted}>{s.rpe||"—"}</Mono>
          </Fragment>
        ))}
      </div>
    </Card>)}
    {data?.ai_review&&<Card accent style={{marginTop:12}}>
      <Kicker>{t("ai_coach_advice")}</Kicker>
      <div style={{fontSize:13,color:C.text,lineHeight:1.6,marginTop:8,whiteSpace:"pre-wrap"}}>{data.ai_review}</div>
    </Card>}
  </div>;
}

// ─── ACTIVE WORKOUT ───────────────────────────────────────────────────────────
// Базовая пауза по группе мышц: после тяжёлых базовых нужно больше, чем после изоляции.
// Персональные значения появятся, когда накопится история времени подходов.
function restSecFor(ex){
  const g=ex?.muscle_group_id;
  if(g===9)return 0;                 // кардио — без таймера
  if(g===1||g===2||g===6)return 150; // грудь, спина, ноги
  if(g===3)return 120;               // плечи
  return 90;                         // руки, пресс, ягодицы
}

/** Описание и техника упражнения. Лёгкий каталог приходит без техники —
 *  догружаем её при открытии карточки или шторки, один раз на упражнение и
 *  язык (ответ кэшируется на сутки). Свои упражнения и полный каталог старого
 *  формата уже содержат технику — им ничего не догружаем. */
function exDetailsUrl(id,lang){return `${API}/exercises/${id}/details?lang=${encodeURIComponent(lang)}`;}
function exNeedsText(e){return !!e&&!!e.id&&!e.technique&&!!e.has_technique&&!e.is_custom;}
/** Уже загруженная техника: из памяти или с диска (переживает перезапуск). */
function peekExDetails(id,lang){
  const u=exDetailsUrl(id,lang);
  const h=_apiCache.get(u);
  return h?h.data:swrRead(u);
}
/** Техника всех упражнений тренировки — одним запросом на старте, чтобы
 *  шторка открывалась и там, где нет связи. Кладём в тот же кэш, откуда
 *  читает useExerciseText, и на диск. */
const _primeInflight=new Set();   // `${id}|${lang}` — уже запрошены, ответ ещё не пришёл
function primeExDetails(list,lang){
  const ids=[...new Set((list||[]).filter(exNeedsText).map(e=>e.id))]
    .filter(id=>!peekExDetails(id,lang)&&!_primeInflight.has(`${id}|${lang}`)).slice(0,30);
  if(!ids.length)return;
  ids.forEach(id=>_primeInflight.add(`${id}|${lang}`));
  apiGet(`${API}/exercises/details?ids=${ids.join(",")}&lang=${encodeURIComponent(lang)}`)
    .finally(()=>ids.forEach(id=>_primeInflight.delete(`${id}|${lang}`)))
    .then(d=>{
      for(const it of d?.items||[]){
        if(!it?.id)continue;
        const u=exDetailsUrl(it.id,lang);
        _apiCache.set(u,{t:Date.now(),data:it});
        swrWrite(u,it);
      }
    })
    .catch(()=>{});   // не вышло — догрузится по одному при открытии шторки
}
function useExerciseText(ex){
  const lang=LANG_STORE.current||"ru";
  const id=ex?.id;
  const need=exNeedsText(ex);
  const key=need?`${id}|${lang}`:null;
  const [st,setSt]=useState({key:null,data:null,failed:false});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!key)return;
    let alive=true;
    setSt({key,data:peekExDetails(id,lang),failed:false});
    apiGet(exDetailsUrl(id,lang))
      .then(d=>{if(alive&&d?.id===id)setSt({key,data:d,failed:false});})
      // Что-то уже есть (с диска) — оставляем. Нет ничего: без связи (fetch
      // отклонился TypeError'ом или браузер офлайн) — пишем, что ждём связь;
      // ответ сервера с ошибкой (упражнение удалили, 502 на выкладке) — просто
      // не показываем технику, «нет связи» там было бы неправдой.
      .catch(e=>{
        if(!alive)return;
        const offline=!navigator.onLine||e instanceof TypeError;
        setSt(s=>s.key===key&&s.data?s:{key,data:null,failed:offline,gone:!offline});
      });
    return()=>{alive=false;};
  },[key,retry]);
  useEffect(()=>{
    if(!(key&&st.key===key&&st.failed))return;
    const on=()=>setRetry(r=>r+1);
    window.addEventListener("online",on);
    return()=>window.removeEventListener("online",on);
  },[key,st.key,st.failed]);
  if(!ex||!need)return ex;
  // До эффекта (первый кадр) смотрим кэш сразу — без мигания пустой шторки
  const data=st.key===key?st.data:peekExDetails(id,lang);
  const failed=st.key===key&&st.failed&&!data;
  const gone=st.key===key&&st.gone&&!data;
  return {...ex,description:data?.description||ex.description,technique:data?.technique||ex.technique,
    _techPending:!data&&!failed&&!gone,_techFailed:failed};
}
/** Место под технику, пока её нет: «…» во время загрузки, без связи — объяснение. */
function TechPlaceholder({full}){
  if(!full||full.technique||!(full._techPending||full._techFailed))return null;
  return <Card style={{marginBottom:10}}><Kicker>{t("technique_label")}</Kicker>
    <div style={{fontSize:13,color:C.muted,lineHeight:1.6,marginTop:6}}>{full._techFailed?t("tech_offline"):"…"}</div></Card>;
}

// ── Фото и техника упражнения на экране подхода ──────────────────────────────
/** Фото упражнения из каталога на месте пустого низа экрана. Тап — шторка
 *  с видео и техникой. Адрес фото бывает, а файла нет (папку в R2 заводит
 *  и загрузка одного видео) — тогда вместо битой картинки компактная строка
 *  «Техника», как EventMediaView в AiEvent: нейтральная замена, не пустая рамка. */
function ExerciseMediaCard({ex,onOpen}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>{setFailed(false);},[ex?.photo_url]);
  if(!ex)return null;
  const hasVideo=!!ex.video_url;
  const hasText=!!(ex.technique||ex.has_technique||ex.description);
  const showPhoto=!!ex.photo_url&&!failed;
  if(!showPhoto&&!hasVideo&&!hasText)return null;
  const label=(
    <span style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:11,fontWeight:700,letterSpacing:1,fontFamily:"monospace",color:C.accent}}>
      <span aria-hidden="true">{hasVideo?"▶":"ⓘ"}</span>{t("technique_label")}
    </span>
  );
  if(!showPhoto)return(
    <button type="button" onClick={onOpen}
      style={{width:"100%",display:"flex",alignItems:"center",gap:10,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:12,padding:"12px 14px",marginBottom:10,cursor:"pointer",textAlign:"left"}}>
      {ex.group_icon_url
        ?<img src={ex.group_icon_url} alt="" style={{width:28,height:28,objectFit:"cover",borderRadius:6}} onError={e=>{e.currentTarget.style.display="none";}}/>
        :<span style={{fontSize:20}} aria-hidden="true">{ex.group_emoji||"🏋️"}</span>}
      <span style={{flex:1}}>{label}</span>
      <span style={{color:C.muted,fontSize:18}} aria-hidden="true">›</span>
    </button>
  );
  return(
    <button type="button" onClick={onOpen} aria-label={`${t("technique_label")}: ${tField(ex,"name")}`}
      style={{position:"relative",display:"block",width:"100%",padding:0,border:`0.5px solid ${C.border}`,borderRadius:14,overflow:"hidden",background:C.card,marginBottom:10,cursor:"pointer",aspectRatio:"16 / 10",maxHeight:240}}>
      <img src={ex.photo_url} alt="" decoding="async" onError={()=>setFailed(true)}
        style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
      <span style={{position:"absolute",left:0,right:0,bottom:0,padding:"28px 14px 12px",background:"linear-gradient(transparent, rgba(0,0,0,0.78))",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        {label}
        <span style={{color:C.text,fontSize:18}} aria-hidden="true">›</span>
      </span>
    </button>
  );
}

/** Шторка с видео, описанием и техникой поверх экрана подхода — человек смотрит,
 *  как делать, и возвращается к вводу, не теряя место. Закрывается крестиком,
 *  тапом по фону, Escape и системной кнопкой «Назад» Telegram: без неё «Назад»
 *  на Android закрыл бы всё приложение посреди тренировки. Таймер отдыха
 *  (zIndex 199) остаётся поверх шторки. */
function ExerciseInfoSheet({ex,onClose}){
  const closeRef=useRef(null);
  const onCloseRef=useRef(onClose);
  onCloseRef.current=onClose;
  const [videoFailed,setVideoFailed]=useState(false);
  const [photoFailed,setPhotoFailed]=useState(false);
  const full=useExerciseText(ex);
  useEffect(()=>{
    const prevFocus=document.activeElement;
    try{closeRef.current?.focus({preventScroll:true});}catch{}
    const onKey=e=>{if(e.key==="Escape")onCloseRef.current();};
    document.addEventListener("keydown",onKey);
    const prevOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const bb=tg?.BackButton;
    let bbOk=false;
    try{bbOk=!!bb&&!!tg?.isVersionAtLeast?.("6.1");}catch{}
    const onBack=()=>onCloseRef.current();
    if(bbOk){try{bb.onClick(onBack);bb.show();}catch{}}
    return()=>{
      document.removeEventListener("keydown",onKey);
      document.body.style.overflow=prevOverflow;
      if(bbOk){try{bb.offClick(onBack);bb.hide();}catch{}}
      try{prevFocus?.focus?.({preventScroll:true});}catch{}
    };
  },[]);
  if(!ex)return null;
  const desc=tField(full,"description"), tech=tField(full,"technique");
  return(
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:150,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div role="dialog" aria-modal="true" aria-labelledby="ex-sheet-title" onClick={e=>e.stopPropagation()}
        style={{width:"100%",maxWidth:560,maxHeight:"88vh",overflowY:"auto",WebkitOverflowScrolling:"touch",background:C.surface,borderRadius:"18px 18px 0 0",borderTop:`0.5px solid ${C.border}`,padding:"8px 16px calc(20px + env(safe-area-inset-bottom, 0px))",boxSizing:"border-box"}}>
        <div aria-hidden="true" style={{width:36,height:4,borderRadius:2,background:C.border,margin:"0 auto 10px"}}/>
        <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:12}}>
          <div style={{flex:1,minWidth:0}}>
            <Kicker>{tGroup(ex)?.toUpperCase()}</Kicker>
            <div id="ex-sheet-title" style={{fontSize:18,fontWeight:700,color:C.text,lineHeight:1.3}}>{tField(ex,"name")}</div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("close")}
            style={{width:44,height:44,flexShrink:0,borderRadius:12,background:C.card,border:`0.5px solid ${C.border}`,color:C.text,fontSize:18,cursor:"pointer"}}>✕</button>
        </div>
        {ex.video_url&&!videoFailed
          ?<video src={ex.video_url} poster={(!photoFailed&&ex.photo_url)||undefined} autoPlay loop muted playsInline preload="metadata"
              onError={()=>setVideoFailed(true)}
              style={{width:"100%",borderRadius:12,marginBottom:12,objectFit:"cover",maxHeight:260,background:C.card,display:"block"}}/>
          :ex.photo_url&&!photoFailed&&<img src={ex.photo_url} alt={tField(ex,"name")} onError={()=>setPhotoFailed(true)}
              style={{width:"100%",borderRadius:12,marginBottom:12,objectFit:"cover",maxHeight:260,display:"block"}}/>}
        {desc&&<Card style={{marginBottom:10}}><Kicker>{t("description_label")}</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:6}}>{desc}</div></Card>}
        {tech?<Card style={{marginBottom:10}}><Kicker>{t("technique_label")}</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.8,marginTop:6,whiteSpace:"pre-wrap"}}>{tech}</div></Card>
          :<TechPlaceholder full={full}/>}
        {ex.equipment&&<Card><Kicker>{t("equipment_label")}</Kicker><div style={{fontSize:14,color:C.text,marginTop:4}}>{tEquip(ex.equipment)}</div></Card>}
      </div>
    </div>
  );
}

function ActiveWorkoutScreen({tgId,user=null,onUserUpdated=null,exercises,muscleGroups,onBack,onFinish,onFinishNav=null,onNav=null,preselectedExIds=[],preselectedGroupIds=[],plannedWorkoutId=null,exerciseTips={},programDay=null}){
  const STEP={MD:-1,SG:0,SE:1,WU:2,OR:3,LG:4,FN:5}; // MD=выбор режима
  // Если с момента последней записи подхода прошло больше 3 часов — тренировка считается
  // брошенной, и таймер обнуляется. Иначе в базу попадали сессии на 20+ часов: человек
  // закрыл приложение, не завершив тренировку, и вернулся на следующий день.
  const IDLE_RESET_MS=3*60*60*1000;
  // Если все упражнения кардио — пропускаем разминку
  const _allCardio=preselectedExIds?.length>0&&exercises?.length>0&&
    preselectedExIds.every(id=>{const ex=exercises?.find(e=>e.id===id);return ex?.muscle_group_id===9;});
  // Рекомендация с главного экрана приходит сразу с составом (preselectedExIds):
  // тренировка собрана сервером по истории, человек попадает на разминку.
  // preselectedGroupIds без состава — запасной путь, когда подобрать было не из чего:
  // тогда ведём на выбор упражнений с уже отмеченными группами.
  const initStep=preselectedExIds?.length>0?(_allCardio?3:2):(preselectedGroupIds?.length>0?1:-1);
  // Восстанавливаем сохранённое состояние тренировки
  const _saved=()=>{try{const s=localStorage.getItem("gymbot_active_workout");return s?JSON.parse(s):null;}catch{return null;}};
  const _sv=_saved();
  // Если пришли из запланированной тренировки — localStorage-состояние не применяем,
  // чтобы не перекрыть preselectedExIds сохранённым состоянием предыдущей сессии.
  // Также сразу синхронно вычисляем selExs из preselectedExIds + exercises,
  // чтобы избежать race condition (useState синхронен, useEffect — нет).
  const _initSelExs=(()=>{
    if(preselectedExIds?.length>0&&exercises?.length>0){
      const preEx=preselectedExIds
        .map((id,i)=>{const ex=(exercises||[]).find(e=>e.id===id);return ex?{...ex,order:i+1}:null;})
        .filter(Boolean);
      if(preEx.length>0)return preEx;
    }
    return null; // вернём null — значит используем localStorage или пустой массив
  })();
  const _useSaved=!!_sv&&!plannedWorkoutId&&!(preselectedExIds?.length>0)&&!(preselectedGroupIds?.length>0);
  const [step,setStep]=useState(_useSaved?_sv.step:initStep);
  const [showSports,setShowSports]=useState(false); // Виды спорта свёрнуты по умолчанию — зал теперь основной
  const [selGroups,setSelGroups]=useState(()=>(!_useSaved&&preselectedGroupIds?.length>0)?new Set(preselectedGroupIds):new Set()); // мультивыбор групп
  const [selExs,setSelExs]=useState(_initSelExs||(_useSaved?_sv.selExs:[]));
  const [warmup,setWarmup]=useState(_useSaved?_sv.warmup:null);
  const [warmupDone,setWarmupDone]=useState(_useSaved?_sv.warmupDone:false);
  const [workoutId,setWorkoutId]=useState(_useSaved?_sv.workoutId:null);
  const [curIdx,setCurIdx]=useState(_useSaved?_sv.curIdx:0);
  const [exTips,setExTips]=useState(_useSaved?(_sv.exerciseTips||{}):(exerciseTips||{}));
  const [lastSets,setLastSets]=useState({}); // {exerciseId: {found, date, sets:[{weight,reps}]}} — fallback когда нет совета AI
  const [infoEx,setInfoEx]=useState(null);   // упражнение, чья техника открыта в шторке
  const [logErr,setLogErr]=useState(null);   // подход не сохранился на сервере
  const [finishing,setFinishing]=useState(false); // ждём отправки очереди перед завершением
  // Сколько записей ещё в очереди и чем кончилась последняя попытка (null — ошибок не было)
  const [sqCount,setSqCount]=useState(()=>sqPending());
  const [sqStatus,setSqStatus]=useState(()=>_sq.lastStatus);
  const [sqDropped,setSqDropped]=useState(()=>_sq.dropped);
  useEffect(()=>sqSubscribe(()=>{setSqCount(sqPending());setSqStatus(_sq.lastStatus);setSqDropped(_sq.dropped);}),[]);
  const lastTapRef=useRef(0);   // защита от двойного нажатия «Подход выполнен»

  // Сменилось упражнение (стрелки, точки, замена на месте) — поля чистые.
  // Иначе на следующем упражнении стояли цифры предыдущего, и подстановка из
  // его «прошлого раза» не срабатывала: она не трогает уже заполненные поля.
  const curExId=selExs[curIdx]?.id;
  useEffect(()=>{
    setPrefillFrom(null);setLogErr(null);
    setLocalSet({reps:"",weight:"",time:"",distance:""});
  },[curExId]);

  // Техника упражнений тренировки — заранее и одним запросом (см. primeExDetails)
  // Шторка открывает объект из каталога, а не из selExs (у тренировки, начатой
  // до обновления, в selExs техника есть, а в лёгком каталоге — нет), поэтому
  // и подгружаем по объектам каталога.
  const selIdsKey=selExs.map(e=>e?.id).join(",");
  useEffect(()=>{
    if(!selExs.length)return;
    const list=selExs.map(e=>e?.is_custom?e:((exercises||[]).find(c=>c.id===e?.id)||e));
    primeExDetails(list,LANG_STORE.current||"ru");
  },[selIdsKey,exercises]);

  const lastSetsPending=useRef(new Set());
  useEffect(()=>{
    const curEx=selExs[curIdx];
    if(!curEx||!tgId||!curEx.name)return;
    // Грузим всегда, даже когда есть совет AI: эти же данные подставляются
    // в поля веса и повторов, чтобы не вводить всё заново каждый подход.
    if(lastSets[curEx.id]!==undefined||lastSetsPending.current.has(curEx.id))return;
    // Сразу для всех упражнений тренировки, у которых «прошлого раза» ещё нет:
    // раньше это был отдельный запрос на каждом переходе, по 2,2–2,4 с.
    const need=selExs.filter(e=>e?.name&&lastSets[e.id]===undefined&&!lastSetsPending.current.has(e.id));
    need.forEach(e=>lastSetsPending.current.add(e.id));
    const one=()=>fetch(`${API}/exercises/${tgId}/last-sets?exercise_name=${encodeURIComponent(curEx.name)}`)
      .then(r=>r.json())
      .then(d=>setLastSets(prev=>({...prev,[curEx.id]:d})))
      .catch(()=>setLastSets(prev=>({...prev,[curEx.id]:{found:false}})));
    fetch(`${API}/exercises/${tgId}/last-sets-batch`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({names:need.map(e=>e.name)})})
      .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
      .then(d=>{
        const res=d?.results||{};
        setLastSets(prev=>{const n={...prev};need.forEach(e=>{n[e.id]=res[e.name]||{found:false};});return n;});
      })
      // Пакетного запроса нет (старый сервер) или сбой — как раньше, по одному
      .catch(one)
      .finally(()=>need.forEach(e=>lastSetsPending.current.delete(e.id)));
  },[curIdx,selExs,tgId,lastSets]);
  const [sets,setSets]=useState(_useSaved?(_sv.sets||{}):{});
  const [lastSetAt,setLastSetAt]=useState(_useSaved?(_sv.lastSetAt||null):null);
  const [prefillFrom,setPrefillFrom]=useState(null); // дата тренировки, из которой подставлены цифры

  // Подставляем вес и повторы из прошлой тренировки: человек либо подтверждает,
  // либо правит на пару килограммов. Не трогаем поля, если он уже начал вводить сам.
  useEffect(()=>{
    const curEx=selExs[curIdx];
    if(!curEx)return;
    const ls=lastSets[curEx.id];
    if(!ls||!ls.found||!ls.sets||!ls.sets.length)return;
    // Данные старше двух месяцев уже не ориентир: подставить вес трёхмесячной
    // давности хуже, чем не подставлять ничего — человек начнёт с чужой цифры.
    if(ls.date){
      const ageDays=(Date.now()-new Date(ls.date).getTime())/86400000;
      if(!(ageDays>=0)||ageDays>60){setPrefillFrom(null);return;}
    }
    const idx=(sets[curEx.id]||[]).length;
    const src=ls.sets[Math.min(idx,ls.sets.length-1)];
    if(!src)return;
    setLocalSet(p=>{
      if(p.reps!==""||p.weight!=="")return p;
      setPrefillFrom(ls.date||null);
      return {...p,reps:src.reps?String(src.reps):"",weight:src.weight?String(src.weight):""};
    });
  },[curIdx,lastSets,sets,selExs]);
  const [startTime,setStartTime]=useState(()=>{
    if(!_useSaved)return Date.now();
    const saved=_sv.startTime||Date.now();
    const lastActivity=_sv.lastSetAt||_sv.savedAt||saved;
    // Простой больше 3 часов — начинаем отсчёт заново, а не продолжаем вчерашний
    return (Date.now()-lastActivity>IDLE_RESET_MS)?Date.now():saved;
  });

  // Длительность тренировки с отсечкой простоя: если после последнего подхода прошло
  // больше 3 часов, засчитываем время до этого подхода, а не до нажатия «Завершить».
  function workoutDurationMin(){
    const end=(lastSetAt&&lastSetAt>startTime&&Date.now()-lastSetAt>IDLE_RESET_MS)?lastSetAt:Date.now();
    return Math.max(1,Math.round((end-startTime)/60000));
  }
  const [resumeBanner,setResumeBanner]=useState(_useSaved&&(_sv.workoutId||_sv.selExs?.length>0));
  const [exSearch,setExSearch]=useState("");
  const [replaceIdx,setReplaceIdx]=useState(null);
  const [localSet,setLocalSet]=useState({reps:"",weight:"",time:"",distance:""});
  const [logBusy,setLogBusy]=useState(false); // B-04: блокировка двойного нажатия
  const [lgReplaceMode,setLgReplaceMode]=useState(false); // B-07: замена упражнения
  const [aiReview,setAiReview]=useState(null); // B-06: AI оценка (null=загрузка, ""=ошибка)
  const [aiReviewStream,setAiReviewStream]=useState(""); // разбор, пока он пишется
  const [streakInfo,setStreakInfo]=useState(null); // {streak_days, new_streak_rewards: [{days,name,emoji,pts,desc}]}
  // Предложение включить сигнал об отдыхе. Показывается один раз, после первой
  // тренировки, и только тем, кому ещё не предлагали. Включать молча нельзя:
  // двадцать пять вибраций без спроса — и человек отключит бота совсем.
  const [restOffer,setRestOffer]=useState(null); // null=не отвечал, "yes"/"no"=ответил
  const [showTimer,setShowTimer]=useState(false);
  const [timerAuto,setTimerAuto]=useState(null); // секунды автозапуска отдыха после подхода
  const [timerEx,setTimerEx]=useState(null); // упражнение, для которого спрашиваем оценку усилия

  // Восстановление тренировки с сервера.
  //
  // localStorage остаётся как быстрый кэш: он читается синхронно, поэтому экран
  // не моргает. Но источник правды теперь сервер — иначе закрытое не вовремя
  // приложение теряло тренировку целиком, а продолжить с другого устройства
  // было нельзя в принципе.
  //
  // Подходы берём с сервера всегда: они пишутся отдельным запросом при каждом
  // подходе и разойтись не могут, в отличие от локальной копии.
  const [restored,setRestored]=useState(false);
  // Своё упражнение приходит отдельным запросом; без отметки «загрузилось»
  // нельзя отличить «ещё не пришли» от «их нет», и восстановление теряло бы их.
  const [customLoaded,setCustomLoaded]=useState(false);
  // Запланированная тренировка после восстановления: проп сюда уже не придёт,
  // а без него план не закрывается по завершении.
  const [restoredPlannedId,setRestoredPlannedId]=useState(null);
  // Тренировка с этого устройства на сервере уже закрыта — показываем пояснение
  const [closedElsewhere,setClosedElsewhere]=useState(false);
  // Текущий id тренировки для ответа, пришедшего позже: замыкание эффекта
  // видит значение на момент отправки запроса, а не на момент ответа.
  const workoutIdRef=useRef(null);
  workoutIdRef.current=workoutId;
  useEffect(()=>{
    if(restored||!tgId)return;
    // Явный старт новой тренировки — восстанавливать нечего
    if(preselectedExIds?.length>0||preselectedGroupIds?.length>0||plannedWorkoutId){setRestored(true);return;}
    if(!exercises?.length||!customLoaded)return;   // ждём каталог и свои упражнения
    let alive=true;
    const _readSv=()=>{try{const r=localStorage.getItem("gymbot_active_workout");return r?JSON.parse(r):null;}catch{return null;}};
    // Какая тренировка лежала на устройстве, когда спросили сервер. Пока ответ
    // летит (плохая связь в зале), человек мог начать новую — её не трогаем.
    const askedFor=_readSv()?.workoutId||null;
    fetch(`${API}/workout/${tgId}/active`)
      .then(r=>r.ok?r.json():null)
      .then(d=>{
        if(!alive)return;
        setRestored(true);
        const _now_sv=_readSv();
        // Сервер ответил, что активной тренировки нет, а на устройстве лежит
        // начатая (с id с сервера). Значит её завершили на другом устройстве
        // или закрыла ночная уборка. Раньше копия жила дальше: показывалась
        // вчерашняя тренировка, а сохранение состояния получало 404.
        // d===null — сбой запроса, а не «нет тренировки»: тогда не трогаем.
        if(d&&d.found===false){
          // Стираем только ту тренировку, о которой спрашивали, и только если
          // она всё ещё та же и на устройстве, и на экране.
          if(askedFor&&_now_sv?.workoutId===askedFor&&workoutIdRef.current===askedFor){
            try{localStorage.removeItem("gymbot_active_workout");}catch{}
            setWorkoutId(null);setSelExs([]);setSets({});setCurIdx(0);
            setWarmup(null);setWarmupDone(false);setExTips({});setLastSetAt(null);
            setResumeBanner(false);setStep(initStep);setStartTime(Date.now());
            setClosedElsewhere(true);
          }
          return;
        }
        if(!d?.found)return;
        // Локальное состояние свежее серверного — значит человек прямо сейчас
        // тренируется на этом устройстве, перетирать нельзя.
        const localAt=_now_sv?.savedAt||0;
        const srvAt=d.state_at?Date.parse(d.state_at+"Z"):0;
        // Локальное состояние считается годным, только если в нём есть состав.
        // Баннер «Продолжить» кладёт заглушку с пустым selExs и свежей отметкой
        // времени — без этой проверки она всегда перебивала бы серверное.
        const localUsable=(_now_sv?.selExs?.length||0)>0;
        if(localUsable&&_now_sv?.workoutId===d.workout_id&&localAt>=srvAt)return;

        const st=d.state||{};
        // Ищем и в каталоге, и среди своих упражнений: у custom_exercises
        // собственная последовательность id, и без этого своё упражнение
        // молча выпадало из восстановленного состава, сдвигая curIdx.
        const pool=[...exercises,...customExs.filter(c=>!exercises.find(e=>e.id===c.id))];
        const exs=(st.exIds||[])
          .map((id,i)=>{const e=pool.find(x=>x.id===id);return e?{...e,order:i+1}:null;})
          .filter(Boolean);
        if(exs.length)setSelExs(exs);
        setWorkoutId(d.workout_id);
        if(typeof st.curIdx==="number")setCurIdx(st.curIdx);
        if(typeof st.step==="number")setStep(st.step);
        if(st.warmupDone!==undefined)setWarmupDone(!!st.warmupDone);
        if(st.exerciseTips)setExTips(st.exerciseTips);
        if(st.plannedWorkoutId)setRestoredPlannedId(st.plannedWorkoutId);
        setResumeBanner(true);
        // startTime трогаем только если своего нет: иначе отсчёт пошёл бы от
        // создания записи, и продолженная на следующий день тренировка дала бы
        // девять часов и четыре тысячи килокалорий.
        if(d.started_at&&!_now_sv?.startTime){
          const t=Date.parse(d.started_at+"Z");
          if(t)setStartTime(Date.now()-t>IDLE_RESET_MS?Date.now():t);
        }

        // Подходы — серверные плюс те, что ещё лежат в очереди этого телефона:
        // иначе после восстановления неотправленные пропали бы с экрана, а номер
        // следующего подхода совпал бы с номером ещё не дошедшего.
        const srv={};
        (exs.length?exs:selExs).forEach(e=>{
          const arr=d.sets?.[String(e.id)]||d.sets?.[e.name]||[];
          srv[e.id]=arr.map(x=>({weight:x.weight||"",reps:x.reps||"",time:"",distance:""}));
        });
        _sq.items.forEach(it=>{
          if(it.kind!=="set"||it.workoutId!==d.workout_id)return;
          const b=it.body||{};
          if(srv[b.exercise_id]===undefined)return;
          // Подход мог уже дойти до сервера, а ответ — ещё нет: тогда он есть
          // в ответе /active, и второй раз его не добавляем.
          if(srv[b.exercise_id].length>=(b.set_number||0))return;
          const str=v=>v==null?"":String(v);
          srv[b.exercise_id]=[...srv[b.exercise_id],{weight:str(b.weight),reps:str(b.reps),time:str(b.duration_sec),distance:str(b.distance_km)}];
        });
        setSets(srv);
      })
      .catch(()=>{if(alive)setRestored(true);});
    return()=>{alive=false;};
  },[tgId,exercises?.length,customLoaded,restored]);

  // Автосохранение состояния тренировки при любом изменении
  const _stateTimer=useRef(null);
  useEffect(()=>{
    if(step===STEP.FN){
      // Тренировка завершена — очищаем
      try{localStorage.removeItem("gymbot_active_workout");}catch{}
      return;
    }
    if(workoutId||selExs.length>0){
      // Сохраняем при наличии workoutId или выбранных упражнений
      try{
        localStorage.setItem("gymbot_active_workout",JSON.stringify({
          step,selExs,warmup,warmupDone,workoutId,curIdx,sets,startTime,lastSetAt,
          plannedWorkoutId,exerciseTips:exTips,savedAt:Date.now(),
        }));
      }catch{}
    }
  },[step,curIdx,sets,workoutId,selExs.map(e=>e.id).join(","),lastSetAt,warmupDone,warmup?.id]);
  useEffect(()=>{
    if(step===STEP.FN)return;
    // На сервер — с задержкой, чтобы не слать запрос на каждое нажатие.
    // Подходов в этом состоянии нет, поэтому и от них оно не зависит: раньше
    // запрос уходил после каждого подхода впустую, по 1,4–2,6 с на сервере.
    // Подходы сюда не кладём: они уже записаны отдельно и лежат в workout_sets.
    // Пустой состав не отправляем: на сервере лежит единственная информация
    // о том, из чего состоит тренировка, и затереть её пустотой нельзя.
    if(workoutId&&tgId&&selExs.length>0){
      clearTimeout(_stateTimer.current);
      _stateTimer.current=setTimeout(()=>{
        fetch(`${API}/workout/${workoutId}/state?tg_id=${tgId}`,{method:"PUT",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({state:{
            exIds:selExs.map(e=>e.id),curIdx,step,
            warmupDone,warmupId:warmup?.id||null,
            plannedWorkoutId,exerciseTips:exTips,
          }})}).catch(()=>{});
      },1500);
    }
    return()=>clearTimeout(_stateTimer.current);
    // Состав — по списку id, а не по длине: перестановка и замена упражнения
    // длину не меняют, и без этого они не сохранялись вовсе.
  },[step,curIdx,workoutId,selExs.map(e=>e.id).join(","),warmupDone,warmup?.id]);

  // Защита от повреждённого восстановленного состояния: если мы на экране логирования (LG),
  // но selExs пуст или curIdx указывает за пределы массива — вместо немого чёрного экрана
  // чистим localStorage и возвращаем пользователя назад
  useEffect(()=>{
    // Ждём восстановления с сервера. Баннер «Продолжить тренировку» кладёт в
    // localStorage заглушку с пустым составом, и без этой проверки защитник
    // уводил человека назад за мгновение до того, как состав приезжал с сервера.
    if(!restored)return;
    if(step===STEP.LG&&!selExs[curIdx]){
      try{localStorage.removeItem("gymbot_active_workout");}catch{}
      if(onBack)onBack();
    }
  },[step,curIdx,selExs.length,restored]);
  // Спорт режим
  const [sports,setSports]=useState([]);
  useEffect(()=>{
    apiGet(`${API}/sport-types`).then(d=>{
      if(d.sport_types?.length)setSports(d.sport_types);
    }).catch(()=>{});
  },[]);

  const allEx=exercises||[];
  const [customExs,setCustomExs]=useState([]);
  useEffect(()=>{
    if(!tgId){setCustomLoaded(true);return;}
    apiGet(`${API}/custom-exercises/${tgId}`)
      .then(d=>setCustomExs((d.exercises||[]).map(e=>({...e,group_name:e.group_name||t("cex_moe"),group_emoji:e.group_emoji||"⭐"}))))
      .catch(()=>{})
      .finally(()=>setCustomLoaded(true));
  },[]);
  const allExWithCustom=[...allEx,...customExs.filter(ce=>!allEx.find(e=>e.id===ce.id))];

  // Заполняем selExs из preselectedExIds (запуск из запланированной тренировки)
  useEffect(()=>{
    if(preselectedExIds?.length>0&&allEx.length>0&&selExs.length===0){
      const preEx=preselectedExIds
        .map((id,i)=>{const ex=allEx.find(e=>e.id===id);return ex?{...ex,order:i+1}:null;})
        .filter(Boolean);
      if(preEx.length>0)setSelExs(preEx);
    }
  },[allEx.length]);
  const filteredEx=allExWithCustom.filter(e=>(selGroups.size===0||selGroups.has(e.muscle_group_id))&&(!exSearch||e.name.toLowerCase().includes(exSearch.toLowerCase())));
  const cardioExs=allExWithCustom.filter(e=>e.muscle_group_id===9);

  function toggleEx(ex){setSelExs(p=>{const h=p.find(e=>e.id===ex.id);if(h)return p.filter(e=>e.id!==ex.id);return[...p,{...ex,order:p.length+1}];});}
  function moveEx(i,d){setSelExs(p=>{const a=[...p],t=i+d;if(t<0||t>=a.length)return a;[a[i],a[t]]=[a[t],a[i]];return a.map((e,j)=>({...e,order:j+1}));});}
  function doReplace(i,ex){setSelExs(p=>p.map((e,j)=>j===i?{...ex,order:e.order}:e));setReplaceIdx(null);}
  function stepBack(){if(step===STEP.MD||step===STEP.SG)onBack();else if(step===STEP.SE){setStep(STEP.SG);}else if(step===STEP.WU)setStep(STEP.SE);else if(step===STEP.OR)setStep(STEP.WU);}

  async function startWorkout(){
    try{
      const r=await fetch(`${API}/workout/start/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({exercise_ids:selExs.map(e=>e.id),program_day:programDay??null})});
      // Без проверки экран подходов открывался и при отказе сервера, без id
      // тренировки — и ни один подход потом не сохранялся.
      if(!r.ok)throw new Error(`start HTTP ${r.status}`);
      const d=await r.json();
      if(!d?.workout_id)throw new Error("no workout_id");
      setWorkoutId(d.workout_id);
      const init={};selExs.forEach(e=>{init[e.id]=[];});setSets(init);setStep(STEP.LG);
    }catch{alert(t("error_launch"));}
  }
  async function doLog(){
    const ex=selExs[curIdx];if(!ex)return;
    // Тренировка не заведена на сервере — подход сохранить некуда. Раньше здесь
    // был тихий return, и кнопка показывала успех.
    if(!workoutId)throw new Error("no workout id");
    const done=(sets[ex.id]||[]).length;
    // Длительность отдыха считаем ДО отправки и передаём вместе с подходом:
    // отсчёт ведёт сервер и сам пришлёт уведомление, когда время выйдет.
    // Таймер в приложении остаётся как визуальный, но больше не единственный —
    // раньше он просто вставал, стоило заблокировать телефон.
    const rs=lastSets[ex.id]?.rest_sec||restSecFor(ex);
    // Подход сразу на экране, а запрос — в очередь: она отправит его фоном,
    // повторит при сбое и не потеряет при закрытии приложения. Повтор после
    // потерянного ответа сервер узнаёт и второй раз не записывает.
    // Пределы — от опечаток: «100000» повторов база не примет вовсе, и такой
    // подход стоял бы в очереди вечно.
    const lim=(v,max)=>{const n=Number(v);return n>0?Math.min(n,max):null;};
    sqPush("set",`${API}/workout/${workoutId}/set?tg_id=${tgId}`,
      {exercise_id:ex.id,exercise_name:ex.name,set_number:done+1,reps:lim(parseInt(localSet.reps),1000),weight:lim(parseFloat(localSet.weight),1000),duration_sec:lim(parseInt(localSet.time),86400),distance_km:lim(parseFloat(localSet.distance),500),rest_sec:rs>0?rs:null},
      {workoutId});
    setSets(p=>({...p,[ex.id]:[...(p[ex.id]||[]),{...localSet}]}));
    setLastSetAt(Date.now());
    setLocalSet({reps:"",weight:"",time:"",distance:""});
    if(rs>0){setTimerAuto(rs);setTimerEx(ex.name);setShowTimer(true);}
  }
  async function finish(){
    // Итоги, рекорды и разбор тренера сервер считает по записанным подходам —
    // поэтому сначала отправляем очередь.
    if(finishing)return;
    if(sqPending()>0||sqUnsentSets(workoutId)>0){
      setFinishing(true);
      const sent=await sqFlush();
      setFinishing(false);
      const left=sqUnsentSets(workoutId);
      if((!sent||left>0)&&!window.confirm(t("sq_finish_pending").replace("{n}",left||sqPending())))return;
    }
    console.log("[finish] START workoutId:",workoutId,"plannedWorkoutId:",plannedWorkoutId,"tgId:",tgId);
    try{localStorage.removeItem("gymbot_active_workout");}catch{}
    const dur=workoutDurationMin();
    // Пустая тренировка (ни одного подхода) сервером удаляется и не засчитывается:
    // ни разбора тренера, ни отметки запланированной.
    // Решает сервер (он видит подходы со всех устройств); по своим подсчётам — только если ответа нет.
    let emptyWorkout=Object.values(sets).reduce((n,a)=>n+a.length,0)===0;
    try{
      if(workoutId){
        const fr=await fetch(`${API}/workout/${workoutId}/finish?tg_id=${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({duration_minutes:dur,has_unsent:sqUnsentSets(workoutId)>0})});
        console.log("[finish] workout finish →",fr.status);
        try{
          const fd=await fr.json();
          if(fr.ok)emptyWorkout=!!fd.empty;
          setStreakInfo({
            streak_days:fd.streak_days||0,
            new_streak_rewards:fd.new_streak_rewards||[],
          });
        }catch{}
      }
    }catch(e){console.error("[finish] workout finish error",e);}
    // Помечаем запланированную тренировку как выполненную
    // После восстановления проп пуст — берём id плана из состояния,
    // иначе запланированная тренировка остаётся незакрытой.
    const pwId=plannedWorkoutId||restoredPlannedId;
    console.log("[finish] pwId=",pwId);
    if(pwId&&tgId&&!emptyWorkout){
      try{
        const r=await fetch(`${API}/planned/${tgId}/${pwId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"completed"})});
        console.log("[finish] planned PUT",pwId,"→",r.status);
      }catch(e){console.error("[finish] planned PUT error",e);}
    }else{
      console.log("[finish] SKIP planned: pwId=",pwId,"tgId=",tgId);
    }
    if(onFinish)onFinish();
    setStep(STEP.FN);
    if(emptyWorkout){setAiReview("__empty__");return;}
    // B-06: запрашиваем AI оценку тренировки
    try{
      const totalSetsCount=Object.values(sets).reduce((s,a)=>s+a.length,0);
      const exList=selExs.map((e,i)=>{
        const exSets=sets[e.id]||[];
        const setsStr=exSets.map(s=>s.weight?`${s.weight}кг×${s.reps}`:s.time?`${s.time}с`:"—").join(", ");
        return `${i+1}. ${tField(e,"name")}: ${setsStr||t("no_sets_data")}`;
      }).join("\n");
      const q=`Оцени мою тренировку. Длительность: ${dur} мин. Упражнений: ${selExs.length}. Подходов: ${totalSetsCount}.

Состав:
${exList}

Дай короткую оценку (3-4 предложения): что хорошо, что улучшить, совет на следующую тренировку.`;
      // Прошлые советы отсюда больше не досылаем: сервер сам кладёт их в контекст
      // (полный текст по последней тренировке, по остальным — обрезанный), и этот
      // блок дублировал их вторым экземпляром, оплачивая одни и те же токены дважды.
      // mode:"review" — разбор проведённой тренировки. Без него сервер видел слово
      // «тренировку» в вопросе и включал схему плана: модель тратила ответ на план
      // упражнений, которого никто не просил, вместо связной оценки.
      const body=JSON.stringify({question:q,tg_id:tgId,skip_limit:true,mode:"review"});
      // Разбор целиком шёл 9–19 секунд, и всё это время на экране было «анализирую».
      // Берём потоком, как в чате: первые слова через пару секунд. Поток не завёлся
      // и ничего не показано — тихо повторяем обычным запросом.
      let reviewText=null, streamed="", got=false, complete=false;
      try{
        const res=await fetch(`${API}/ai/ask-stream`,{method:"POST",headers:{"Content-Type":"application/json"},body});
        if(!res.ok||!res.body)throw new Error("stream unavailable");
        const reader=res.body.getReader(), dec=new TextDecoder();
        let buf="", lastPaint=0;
        read: for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          buf+=dec.decode(value,{stream:true});
          let nl;
          while((nl=buf.indexOf("\n\n"))>=0){
            const line=buf.slice(0,nl); buf=buf.slice(nl+2);
            if(!line.startsWith("data:"))continue;
            let ev; try{ev=JSON.parse(line.slice(5));}catch{continue;}
            if(ev.type==="delta"){
              streamed+=ev.text; got=true;
              const now=Date.now();
              if(now-lastPaint>80){lastPaint=now;setAiReviewStream(streamed);}
            }else if(ev.type==="done"){
              reviewText=ev.answer||streamed||"__error__";
              complete=true;
              break read;
            }else if(ev.type==="error"){
              if(ev.status===429){setAiReviewStream("");setAiReview("__limit__");return;}
              if(ev.status===503&&!got){setAiReview("__unavailable__");return;}
              throw new Error(`stream error ${ev.status}`);
            }
          }
        }
        if(reviewText===null)throw new Error("stream ended early");
      }catch(streamErr){
        if(got){
          // Часть уже прочитана — второй запрос дал бы другой разбор. Оставляем пришедшее.
          reviewText=streamed;
        }else{
          const res=await fetch(`${API}/ai/ask`,{method:"POST",headers:{"Content-Type":"application/json"},body});
          if(res.status===429){setAiReview("__limit__");return;}
          if(res.status===503){setAiReview("__unavailable__");return;}
          if(!res.ok){setAiReview("__error__");return;}
          const d=await res.json();
          reviewText=d.answer||"__error__";
          complete=true;
        }
      }
      setAiReviewStream("");
      setAiReview(reviewText);
      // Оборванный на середине разбор показываем, но не сохраняем: он ушёл бы
      // в контекст тренера на следующих тренировках обрывком фразы.
      if(!complete)return;
      // Сохраняем совет тренера в БД
      if(workoutId&&reviewText&&reviewText!=="__error__"&&reviewText!=="__limit__"){
        try{
          await fetch(`${API}/workout/${workoutId}/ai-review?tg_id=${tgId}&review=${encodeURIComponent(reviewText)}`,{method:"POST"});
        }catch{}
      }
    }catch{setAiReview("__error__");}
  }

  async function answerRestOffer(enable){
    setRestOffer(enable?"yes":"no");
    if(!tgId)return;
    try{
      await fetch(`${API}/user/${tgId}`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({rest_notify:enable,rest_notify_offered:true})});
      // Перечитываем профиль: без этого родительский user остаётся со старыми
      // флагами, предложение всплывало бы снова на следующей тренировке,
      // а тумблер в профиле показывал бы «Выключено» при включённом сигнале.
      if(onUserUpdated)onUserUpdated();
    }catch{}
  }

  if(step===STEP.FN)return(
    <div style={{padding:"16px 16px 100px"}}>
      <div style={{textAlign:"center",paddingTop:32,paddingBottom:24}}>
        <div style={{fontSize:60}}>🏆</div>
        <Hero style={{textAlign:"center",marginTop:16}}>{t("workout_done")}</Hero>
        <div style={{color:C.muted,fontSize:14,marginTop:8}}>{t("great_work")}</div>
        <div style={{marginTop:8,fontFamily:"monospace",color:C.accent,fontSize:20}}>{workoutDurationMin()} {t("minutes_label")}</div>
      </div>

      {/* Спрашиваем один раз и только после настоящей тренировки: предлагать
          то, чего человек ещё не пробовал, бессмысленно. */}
      {user&&!user.rest_notify&&!user.rest_notify_offered&&restOffer===null&&
       Object.values(sets).reduce((n,a)=>n+a.length,0)>0&&
        <Card accent style={{marginBottom:16}}>
          <Kicker>{t("rest_offer_kicker")}</Kicker>
          <div style={{fontSize:16,fontWeight:600,color:C.text,marginTop:6}}>{t("rest_offer_title")}</div>
          <div style={{fontSize:13,color:C.text,opacity:0.8,lineHeight:1.55,marginTop:8}}>{t("rest_offer_text")}</div>
          <div style={{display:"flex",gap:8,marginTop:14}}>
            <Btn accent full onClick={()=>answerRestOffer(true)}>{t("rest_offer_yes")}</Btn>
            <Btn full onClick={()=>answerRestOffer(false)}>{t("rest_offer_no")}</Btn>
          </div>
        </Card>}
      {restOffer==="yes"&&<Card style={{marginBottom:16}} pad="12px 16px">
        <div style={{fontSize:13,color:C.accent}}>✓ {t("rest_notify_on")} — {t("rest_notify_title").toLowerCase()}</div>
      </Card>}

      {streakInfo?.new_streak_rewards?.length>0&&streakInfo.new_streak_rewards.map((r,i)=>(
        <Card key={i} accent style={{marginBottom:16,textAlign:"center",background:"linear-gradient(135deg,rgba(200,255,0,0.12),rgba(200,255,0,0.03))"}}>
          <div style={{fontSize:36,marginBottom:4}}>{r.emoji}</div>
          <div style={{fontSize:16,fontWeight:700,color:C.text,marginBottom:4}}>{r.name}!</div>
          <div style={{fontSize:12,color:C.muted,marginBottom:4}}>{r.desc}</div>
          <div style={{fontSize:13,color:C.accent,fontFamily:"monospace"}}>+{r.pts} {t("aw_ballov_za_seriyu")}</div>
        </Card>
      ))}
      {streakInfo&&!(streakInfo.new_streak_rewards?.length>0)&&streakInfo.streak_days>1&&(
        <div style={{textAlign:"center",marginBottom:16,fontFamily:"monospace",fontSize:13,color:C.muted}}>
          {t("ui_seriya")} {streakInfo.streak_days} {streakInfo.streak_days<5?t("aw_dnya"):t("aw_dney")} {t("streak_podryad").toLowerCase()}
        </div>
      )}

      {/* Итоги */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
        {[
          {l:t("exercises_label"),v:selExs.length},
          {l:t("sets_label"),v:Object.values(sets).reduce((s,a)=>s+a.length,0)},
          {l:t("minutes_label"),v:workoutDurationMin()},
        ].map((s,i)=><Card key={i} style={{textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div><Mono size={18}>{s.v}</Mono></Card>)}
      </div>

      {/* Поделиться — только настоящей тренировкой: пустую сервер удалил */}
      {aiReview!=="__empty__"&&Object.values(sets).reduce((n,a)=>n+a.length,0)>0&&
        <ShareWorkout tgId={tgId} workoutId={workoutId}/>}

      {/* B-06: AI оценка тренировки */}
      {aiReview===null&&aiReviewStream?(
        <Card accent style={{marginBottom:16}}>
          <Kicker>{t("ai_review_title")}</Kicker>
          <div style={{fontSize:14,color:C.text,lineHeight:1.7,marginTop:8,whiteSpace:"pre-wrap"}}>{aiReviewStream}<span style={{color:C.accent}}>▍</span></div>
        </Card>
      ):aiReview===null?(
        <Card accent style={{marginBottom:16}}>
          <Kicker>{t("ai_trainer_title")}</Kicker>
          <div style={{textAlign:"center",padding:"12px 0"}}>
            <div style={{color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:2}}>{t("analyzing")}</div>
            <div style={{color:C.muted,fontSize:24,marginTop:8}}>◌</div>
          </div>
        </Card>
      ):aiReview&&aiReview!=="__limit__"&&aiReview!=="__error__"&&aiReview!=="__unavailable__"&&aiReview!=="__empty__"?(
        <Card accent style={{marginBottom:16}}>
          <Kicker>{t("ai_review_title")}</Kicker>
          <div style={{fontSize:14,color:C.text,lineHeight:1.7,marginTop:8,whiteSpace:"pre-wrap"}}>{aiReview}</div>
        </Card>
      ):aiReview==="__limit__"?(
        <Card style={{marginBottom:16}}>
          <div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"8px 0"}}>
            {t("ui_limit_ai_zaprosov_na")}
          </div>
          <PremiumNudge tgId={tgId} kind="ai" onNav={onNav}/>
        </Card>
      ):aiReview==="__error__"?(
        <Card style={{marginBottom:16}}>
          <div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"8px 0"}}>
            {t("ui_ne_udalos_poluchit_ocenku")}
          </div>
        </Card>
      ):aiReview==="__unavailable__"?(
        <Card style={{marginBottom:16}}>
          <div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"8px 0"}}>
            {t("ai_unavailable")}
          </div>
        </Card>
      ):aiReview==="__empty__"?(
        <Card style={{marginBottom:16}}>
          <div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"8px 0",lineHeight:1.5}}>
            {t("workout_empty_note")}
          </div>
        </Card>
      ):null}

      <Btn accent full onClick={()=>{if(onFinishNav)onFinishNav();else onBack();}} style={{marginTop:8}}>{t("back_to_menu")}</Btn>
    </div>
  );

  // ── Выбор режима: тренажёрка или спорт ──────────────────────────────────────
  if(step===STEP.MD)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={onBack}/>
      <Kicker>{t("choose_type_label")}</Kicker>
      <Hero style={{marginBottom:24}}>{t("choose_type")}</Hero>
      {closedElsewhere&&<Card style={{marginBottom:16}}>
        <div style={{fontSize:13,color:C.muted,lineHeight:1.5}}>{t("workout_closed_elsewhere")}</div>
      </Card>}
      {resumeBanner&&<Card accent style={{marginBottom:16,cursor:"pointer"}} onClick={()=>{setResumeBanner(false);setStep(STEP.LG);}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:28}}>▶</span>
          <div>
            <div style={{fontWeight:700,fontSize:15,color:C.accent}}>{t("resume_workout")}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{t("resume_desc")}</div>
          </div>
          <span style={{marginLeft:"auto",color:C.accent,fontSize:18}}>→</span>
        </div>
      </Card>}
      <div style={{fontWeight:700,fontSize:16,color:C.text,marginBottom:10}}>
        <span style={{fontSize:22,marginRight:8}}>🏋️</span>{t("gym_title")}
      </div>
      <div style={{fontSize:12,color:C.muted,marginBottom:12}}>{t("gym_desc")}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:12}}>
        {(muscleGroups||[]).filter(g=>g.id!==9).map(g=>(
          <div key={g.id} onClick={()=>{setSelGroups(new Set([g.id]));setStep(STEP.SG);}}
            style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:12,padding:"14px 6px",textAlign:"center",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
            {g.icon_url?<img src={g.icon_url} alt="" style={{width:28,height:28,objectFit:"cover",borderRadius:6}}/>:<div style={{fontSize:24}}>{g.emoji}</div>}
            <div style={{fontSize:9,fontFamily:"monospace",fontWeight:700,color:C.text,lineHeight:1.2}}>{(tField(g,"name")).toUpperCase()}</div>
          </div>
        ))}
      </div>
      <Card onClick={()=>{setSelGroups(new Set());setStep(STEP.SE);}} style={{marginBottom:12,cursor:"pointer",padding:"12px 16px",textAlign:"center"}}>
        <span style={{color:C.accent,fontSize:13,fontFamily:"monospace",fontWeight:700}}>{t("show_all_exercises")} →</span>
      </Card>
      {!showSports?(
        <Card onClick={()=>setShowSports(true)} style={{cursor:"pointer",padding:"20px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <span style={{fontSize:40}}>⚽</span>
            <div>
              <div style={{fontWeight:700,fontSize:17,color:C.text,marginBottom:4}}>{t("sport_section_title")}</div>
              <div style={{fontSize:13,color:C.muted}}>{t("sport_section_desc")}</div>
            </div>
            <span style={{color:C.accent,fontSize:20,marginLeft:"auto"}}>→</span>
          </div>
        </Card>
      ):(
      <Card style={{cursor:"pointer",padding:"20px 16px"}}>
        <div style={{fontWeight:700,fontSize:17,color:C.text,marginBottom:12}}>
          <span style={{fontSize:24,marginRight:10}}>⚽</span>{t("sport_section_title")}
        </div>
        <div style={{fontSize:13,color:C.muted,marginBottom:16}}>{t("sport_section_desc")}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {(sports.length?sports:[
            {code:"football",name:t("aw_futbol")},{code:"volleyball",name:t("aw_voleybol")},
            {code:"basketball",name:t("aw_basketbol")},{code:"handball",name:t("aw_gandbol")},
            {code:"table_tennis",name:t("aw_nastolnyy_tennis")},{code:"padel",name:t("aw_padel")},
            {code:"tennis",name:t("aw_bolshoy_tennis")},{code:"badminton",name:t("aw_badminton")},
            {code:"boxing",name:t("aw_boks")},{code:"mma",name:"🥋 MMA"},
            {code:"swimming",name:t("aw_plavanie")},{code:"cycling",name:t("aw_velosport")},
            {code:"running",name:t("aw_beg")},{code:"crossfit",name:"🏋️ CrossFit"},
            {code:"yoga",name:t("aw_yoga")},{code:"pilates",name:t("aw_pilates")},
            {code:"skiing",name:t("aw_gornye_lyzhi")},{code:"climbing",name:t("aw_skalolazanie")},
          ]).map(s=>(
            <button key={s.code||s.v} onClick={()=>{
              if(onNav){onNav("sport_log",{initial_sport:s.code||s.v});}else{onBack();}
            }}
              style={{padding:"8px 14px",borderRadius:20,fontSize:13,cursor:"pointer",
                background:C.card,border:`0.5px solid ${C.border}`,color:C.text}}>
              {tSport(s)||s.name}
            </button>
          ))}
        </div>
        <div style={{marginTop:12,fontSize:11,color:C.muted,fontFamily:"monospace"}}>
          {t("ui_polnaya_zapis_v_razdele")}
        </div>
      </Card>
      )}
    </div>
  );

  if(step===STEP.SG)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setStep(STEP.MD)}/>
      <Kicker>{t("step_1_4b")}</Kicker><Hero>{t("muscles_title")}</Hero>
      <div style={{fontSize:13,color:C.muted,marginTop:8,marginBottom:16}}>{t("select_groups_hint")}</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:16}}>
        {muscleGroups?.map(g=>{
          const sel=selGroups.has(g.id);
          return(
            <div key={g.id} onClick={()=>{setSelGroups(prev=>{const n=new Set(prev);if(n.has(g.id))n.delete(g.id);else n.add(g.id);return n;}); setExSearch("");}}
              style={{position:"relative",background:sel?C.accent:C.card,border:`0.5px solid ${sel?C.accent:C.border}`,borderRadius:12,padding:"14px 6px",textAlign:"center",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              {sel&&<span style={{position:"absolute",top:6,right:6,width:16,height:16,borderRadius:4,background:C.bg,color:C.accent,fontSize:11,fontWeight:900,display:"flex",alignItems:"center",justifyContent:"center"}}>✓</span>}
              {g.icon_url?<img src={g.icon_url} alt="" style={{width:32,height:32,objectFit:"cover",borderRadius:6}}/>:<div style={{fontSize:26}}>{g.emoji}</div>}
              <div style={{fontSize:10,fontFamily:"monospace",fontWeight:700,color:sel?C.bg:C.text,lineHeight:1.2}}>{(tField(g,"name")).toUpperCase()}</div>
            </div>
          );
        })}
      </div>
      {selGroups.size>0&&(
        <div style={{marginBottom:12,fontFamily:"monospace",fontSize:11,color:C.accent}}>
          {t("ui_vybrano_grupp")} {selGroups.size} · {(muscleGroups||[]).filter(g=>selGroups.has(g.id)).map(g=>g.emoji+(tField(g,"name"))).join(", ")}
        </div>
      )}
      <Btn accent full onClick={()=>setStep(STEP.SE)}>
        {selGroups.size===0?t("show_exercises"):t("plan_show_ex").replace("{n}",selGroups.size)}
      </Btn>
    </div>
  );

  if(step===STEP.SE){
    if(replaceIdx!==null)return(
      <div style={{padding:"16px 16px 100px"}}>
        <BackBtn onBack={()=>setReplaceIdx(null)}/>
        <Kicker>{t("replace_title")}</Kicker><Hero>{t("choose_replacement")}</Hero><div style={{height:12}}/>
        {filteredEx.slice(0,30).map(ex=><ExCard key={ex.id} ex={ex} badge={getDiff(ex.difficulty)} onClick={()=>doReplace(replaceIdx,ex)}/>)}
      </div>
    );
    return(
      <div style={{padding:"16px 16px 100px"}}>
        <BackBtn onBack={stepBack}/>
        <Kicker>{t("step_2_4b")}</Kicker><Hero>{t("exercises_section")}</Hero>
        <input value={exSearch} onChange={e=>setExSearch(e.target.value)} placeholder={t("search_placeholder")} style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",boxSizing:"border-box",marginTop:12,marginBottom:12}}/>
        {selExs.length>0&&(
          <div style={{marginBottom:12}}>
            <Kicker>{t("aw_vybrano")}{selExs.length})</Kicker>
            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
              {selExs.map((e,i)=><Tag key={e.id} color={C.accent}>{i+1}. {e.name.split(" ").slice(0,2).join(" ")}</Tag>)}
            </div>
          </div>
        )}
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{filteredEx.length}  {t("exercises_label")}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {filteredEx.slice(0,50).map(ex=>{
            const sel=selExs.find(e=>e.id===ex.id);
            return <ExerciseSelectCard key={ex.id} ex={ex} sel={sel} onToggle={()=>toggleEx(ex)}/>;
          })}
        </div>
        <AddCustomExerciseInline tgId={tgId} muscleGroups={muscleGroups} onAdded={ex=>{
          setCustomExs(p=>[...p,{...ex,group_name:ex.group_name||t("cex_moe"),group_emoji:ex.group_emoji||"⭐"}]);
          setSelExs(p=>[...p,{...ex,order:p.length+1,group_name:ex.group_name||t("cex_moe"),group_emoji:ex.group_emoji||"⭐"}]);
        }}/>
        {selExs.length>0&&(
          <div style={{position:"sticky",bottom:80,marginTop:12}}>
            <Btn accent full onClick={()=>{
              const allCardio=selExs.every(e=>e.muscle_group_id===9||cardioType(e)!==null);
              setStep(allCardio?STEP.OR:STEP.WU);
            }}>{t("next_btn2")} {selExs.every(e=>e.muscle_group_id===9||cardioType(e)!==null)?t("order_title"):t("warmup_title")} ({selExs.length})</Btn>
          </div>
        )}
      </div>
    );
  }

  // Пропускаем разминку если все упражнения кардио
  // Все выбранные упражнения кардио?
  const _isCardioEx=(e)=>e?.muscle_group_id===9||e?.exercise_type==="cardio_time"||e?.exercise_type==="cardio_distance";
  const _checkCardio=(exList)=>exList.length>0&&exList.every(e=>_isCardioEx(e));
  const _preselCardio=selExs.length===0&&preselectedExIds.length>0&&exercises?.length>0&&
    preselectedExIds.every(id=>_isCardioEx((exercises||[]).find(e=>e.id===id)));
  const allSelCardio=_checkCardio(selExs)||_preselCardio;
  if(step===STEP.WU&&allSelCardio){
    // Автоматически переходим к ORDER
    if(step===STEP.WU)setTimeout(()=>setStep(STEP.OR),0);
    return null;
  }

  if(step===STEP.WU)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={stepBack}/>
      <Kicker>{t("step_3_4b")}</Kicker><Hero>{t("warmup_title")}</Hero>
      {/* Состав показываем сразу: тренировка пришла собранной, и человек должен
          увидеть что именно ему предложили, а не угадывать. Рядом — выход на правку. */}
      {preselectedExIds?.length>0&&selExs.length>0&&<Card style={{marginTop:12,marginBottom:4}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8}}>
          <Kicker>{t("ready_wk_kicker")}</Kicker>
          <Mono size={12} color={C.muted}>{selExs.length}</Mono>
        </div>
        <div style={{fontSize:11,color:C.muted,marginTop:2}}>{programDay!=null?t("ready_wk_program"):t("ready_wk_hint")}</div>
        <div style={{display:"flex",flexDirection:"column",gap:5,marginTop:10}}>
          {selExs.map((ex,i)=>(
            <div key={ex.id} style={{display:"flex",gap:8,alignItems:"center"}}>
              <Mono size={12} color={C.accent}>{i+1}</Mono>
              <div style={{fontSize:13,color:C.text,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tField(ex,"name")}</div>
            </div>
          ))}
        </div>
        <button onClick={()=>setStep(STEP.SE)} style={{marginTop:12,width:"100%",background:"none",border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 10px",color:C.muted,fontSize:12,cursor:"pointer",fontFamily:"monospace"}}>
          {t("ready_wk_change")}
        </button>
      </Card>}
      <div style={{fontSize:13,color:C.muted,marginTop:8,marginBottom:16}}>{t("warmup_hint")}</div>
      <Btn full onClick={()=>setStep(STEP.OR)} style={{marginBottom:12}}>{t("warmup_skip")}</Btn>
      {cardioExs.map(ex=>(
        <ExCard key={ex.id} ex={ex}
          action={
            <button onClick={()=>setWarmup(warmup?.id===ex.id?null:ex)} style={{flexShrink:0,width:32,height:32,borderRadius:8,background:warmup?.id===ex.id?C.accent:C.card,border:`0.5px solid ${warmup?.id===ex.id?C.accent:C.border}`,color:warmup?.id===ex.id?C.bg:C.muted,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {warmup?.id===ex.id?"✓":"+"}
            </button>}/>
      ))}
      <div style={{position:"sticky",bottom:80,marginTop:12}}>
        <Btn accent full onClick={()=>setStep(STEP.OR)}>{warmup?"✓ "+warmup.name.split(" ").slice(0,2).join(" ")+" → "+t("order_title"):t("warmup_skip")}</Btn>
      </div>
    </div>
  );

  if(step===STEP.OR)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={stepBack}/>
      <Kicker>{t("step_4_4b")}</Kicker><Hero>{t("order_section")}</Hero>
      <div style={{fontSize:13,color:C.muted,marginTop:8,marginBottom:16}}>{t("order_hint")}</div>
      {warmup&&<Card accent style={{marginBottom:12}}><div style={{fontSize:12,color:C.accent,fontFamily:"monospace",marginBottom:4}}>{t("warmup_badge3")}</div><div style={{fontWeight:600,color:C.text}}>{warmup.name}</div></Card>}
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
        {selExs.map((ex,i)=>(
          <Card key={ex.id}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <Mono color={C.accent} size={20}>{i+1}</Mono>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,fontSize:14,color:C.text}}>{tField(ex,"name")}</div>
                <div style={{fontSize:11,color:C.muted}}>{ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:14,height:14,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:3}}/>:ex.group_emoji+" "}{tGroup(ex)}</div>
              </div>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                <button onClick={()=>setReplaceIdx(i)} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:4,color:C.muted,width:28,height:26,cursor:"pointer",fontSize:12}}>↔</button>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <button onClick={()=>moveEx(i,-1)} disabled={i===0} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:3,color:C.muted,width:28,height:22,cursor:"pointer",fontSize:11}}>↑</button>
                  <button onClick={()=>moveEx(i,1)} disabled={i===selExs.length-1} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:3,color:C.muted,width:28,height:22,cursor:"pointer",fontSize:11}}>↓</button>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Btn accent full onClick={startWorkout}>{t("start_workout")}</Btn>
    </div>
  );

  if(step===STEP.LG){
    // B-03: показываем экран разминки перед основными упражнениями
    if(warmup&&!warmupDone){return(
      <div style={{padding:"16px 16px 100px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <Kicker>{t("warmup_badge3")}</Kicker>
          <button onClick={finish} disabled={finishing} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:8,padding:"5px 10px",color:C.danger,fontSize:11,fontFamily:"monospace",cursor:"pointer",opacity:finishing?0.6:1}}>{finishing?t("aw_sohranyaem"):t("finish_workout")}</button>
        </div>
        {warmup.photo_url&&<img src={warmup.photo_url} alt="" style={{width:"100%",borderRadius:12,marginBottom:12,maxHeight:180,objectFit:"cover"}} onError={e=>e.target.style.display="none"}/>}
        <Hero style={{fontSize:20,marginBottom:4}}>{warmup.name}</Hero>
        <div style={{fontSize:13,color:C.muted,marginBottom:20}}>{t("warmup_exec_hint")}</div>
        <Card accent style={{marginBottom:16,padding:"16px",textAlign:"center"}}>
          <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("warmup_rec_time")}</div>
          <div style={{fontSize:32,fontFamily:"monospace",fontWeight:700,color:C.accent}}>{t("rest_5_10")}</div>
        </Card>
        <Btn accent full onClick={()=>setWarmupDone(true)} style={{marginBottom:10}}>{t("warmup_done2")}</Btn>
        <Btn full onClick={()=>setWarmupDone(true)}>{t("skip_warmup2")}</Btn>
      </div>
    );}

    const ex=selExs[curIdx];
    if(!ex){
      return(
        <div style={{padding:"16px 16px 100px",textAlign:"center"}}>
          <div style={{fontSize:13,color:C.muted,marginTop:40}}>{t("loading")}</div>
        </div>
      );
    }
    const cType=cardioType(ex);
    const doneSets=sets[ex.id]||[];
    const setNum=doneSets.length+1;
    const totalSets=parseInt(ex.sets_recommended)||4;

    // Подсказка следующего веса (+2.5 кг от последнего подхода)
    const lastWeight=doneSets.length>0?parseFloat(doneSets[doneSets.length-1].weight||0):parseFloat(localSet.weight||0);
    const suggestWeight=lastWeight>0?Math.round((lastWeight+2.5)*4)/4:null;
    // Фото, видео и технику берём из свежего каталога: состав тренировки,
    // восстановленный из localStorage, хранит объекты на момент старта —
    // со старым языком описания и без медиа, если их добавили позже.
    // Свои упражнения — из другой таблицы, их id может совпасть с каталожным
    const exMedia=ex.is_custom?ex:((exercises||[]).find(e=>e.id===ex.id)||ex);
    const lsCur=lastSets[ex.id];
    const lastIdx=lsCur?.sets?.length?Math.min(doneSets.length,lsCur.sets.length-1):-1;

    const lastAgo=lsCur?.date?fmtDayAgo(lsCur.date):"";

    return(
      <div style={{padding:"16px 16px 100px"}}>
        {/* Хедер */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>
            {ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:16,height:16,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:4}}/>:ex.group_emoji+" "}{tGroup(ex)?.toUpperCase()}
          </div>
          <button onClick={finish} disabled={finishing} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:8,padding:"5px 10px",color:C.danger,fontSize:11,fontFamily:"monospace",cursor:"pointer",opacity:finishing?0.6:1}}>
            {finishing?t("aw_sohranyaem"):t("finish_workout")}
          </button>
        </div>

        {/* B-07: Название + кнопка замены */}
        {lgReplaceMode?(
          <div style={{marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <Kicker>{t("replace_exercise2")}</Kicker>
              <button onClick={()=>setLgReplaceMode(false)} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:8,padding:"4px 10px",color:C.muted,fontSize:12,cursor:"pointer"}}>{t("cancel_btn2")}</button>
            </div>
            <div style={{fontSize:12,color:C.muted,marginBottom:10}}>{ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:14,height:14,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:3}}/>:ex.group_emoji+" "}{tGroup(ex)} — {t("aw_vyberi_zamenu")}:</div>
            {(exercises||[]).filter(e=>e.muscle_group_id===ex.muscle_group_id&&e.id!==ex.id).slice(0,15).map(alt=>(
              <ExCard key={alt.id} ex={alt} badge={getDiff(alt.difficulty)}
                onClick={()=>{
                  setSelExs(prev=>prev.map((e2,i)=>i===curIdx?{...alt,order:e2.order}:e2));
                  setSets(prev=>{const n={...prev};if(!n[alt.id])n[alt.id]=[];return n;});
                  setLgReplaceMode(false);
                }}
                action={
                  <button
                    onClick={ev=>{ev.stopPropagation();
                      setSelExs(prev=>prev.map((e2,i)=>i===curIdx?{...alt,order:e2.order}:e2));
                      setSets(prev=>{const n={...prev};if(!n[alt.id])n[alt.id]=[];return n;});
                      setLgReplaceMode(false);
                    }}
                    style={{flexShrink:0,background:C.accent,border:"none",borderRadius:8,
                      padding:"6px 10px",color:C.bg,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                    {t("ui_zamenit")}
                  </button>
                }
              />
            ))}
          </div>
        ):(
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
              <Hero style={{fontSize:22,flex:1}}>{tField(ex,"name")}</Hero>
              <button onClick={()=>setLgReplaceMode(true)} style={{background:"rgba(200,255,0,0.15)",border:`0.5px solid ${C.accent}`,borderRadius:8,padding:"6px 12px",color:C.accent,fontSize:12,fontWeight:600,cursor:"pointer",flexShrink:0,marginLeft:8,fontFamily:"monospace"}}>{t("do_replace2")}</button>
            </div>
            <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:12}}>
              {t("ui_podhod")} {setNum} / {totalSets}
              {doneSets.length>0&&<span style={{color:C.success,marginLeft:8}}>✓ {doneSets.length} {t("reps_done")}</span>}
            </div>
          </>
        )}

        {/* Совет AI-тренера по этому упражнению — рядом с вводом, а не под кнопками */}
        {!lgReplaceMode&&exTips[ex.id]&&(
          <Card style={{marginBottom:10,background:"rgba(200,255,0,0.06)",border:`0.5px solid ${C.accent}`}}>
            <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
              <div style={{fontSize:18}} aria-hidden="true">🤖</div>
              <div style={{flex:1,fontSize:13,color:C.text,lineHeight:1.5}}>{exTips[ex.id]}</div>
            </div>
          </Card>
        )}

        {/* Прошлый раз — прямо над полями: с ним сверяются, когда вводят цифры.
            Подход, который сейчас по счёту, выделен — его цифры и подставлены. */}
        {!lgReplaceMode&&lsCur?.found&&lsCur.sets?.length>0&&(
          <div style={{display:"flex",alignItems:"baseline",flexWrap:"wrap",gap:"4px 10px",fontSize:12,fontFamily:"monospace",color:C.muted,margin:"0 2px 8px"}}>
            <span>{t("last_time")}{lastAgo?` · ${lastAgo}`:""}</span>
            <span>
              {lsCur.sets.map((s,i)=>(
                <span key={i} style={{color:i===lastIdx&&prefillFrom?C.text:C.muted,fontWeight:i===lastIdx&&prefillFrom?700:400,marginRight:8,whiteSpace:"nowrap"}}>
                  {s.weight>0?`${s.weight}×${s.reps}`:`${s.reps} ${t("u_povt")}`}
                </span>
              ))}
            </span>
          </div>
        )}

        {/* Основной блок ввода — скрываем при режиме замены */}
        {/* Поля сжимаются вместе с экраном: на 360px ширины кнопка «−» у веса
            вылезала за край карточки — у полей была жёсткая ширина 80 и 60px. */}
        {!lgReplaceMode&&cType===null&&(
          <Card accent style={{marginBottom:12,padding:"16px 12px"}}>
            <div style={{display:"flex",gap:10,alignItems:"flex-end",justifyContent:"center"}}>

              {/* Вес */}
              <div style={{textAlign:"center",flex:1,minWidth:0}}>
                <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("weight_kg")}</div>
                <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"center"}}>
                  <button onClick={()=>{haptic.select();setLocalSet(p=>({...p,weight:String(Math.max(0,parseFloat(p.weight||0)-2.5))}));}}
                    style={{width:36,height:36,borderRadius:8,background:C.card,border:`0.5px solid ${C.border}`,color:C.muted,fontSize:16,cursor:"pointer",flexShrink:0}}>−</button>
                  <input type="number" value={localSet.weight} onChange={e=>setLocalSet(p=>({...p,weight:e.target.value}))} placeholder="0" aria-label={t("weight_kg")}
                    style={{background:"none",border:"none",color:C.accent,fontSize:"clamp(22px, 6.6vw, 32px)",fontFamily:"monospace",fontWeight:700,flex:1,minWidth:0,width:"100%",padding:0,outline:"none",textAlign:"center"}}/>
                  <button onClick={()=>{haptic.select();setLocalSet(p=>({...p,weight:String(parseFloat(p.weight||0)+2.5)}));}}
                    style={{width:36,height:36,borderRadius:8,background:C.card,border:`0.5px solid ${C.border}`,color:C.muted,fontSize:16,cursor:"pointer",flexShrink:0}}>+</button>
                </div>
                {suggestWeight&&doneSets.length===0&&(
                  <div style={{fontSize:11,color:C.muted,marginTop:4,fontFamily:"monospace"}}>
                    <button onClick={()=>setLocalSet(p=>({...p,weight:String(suggestWeight)}))}
                      style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:11,fontFamily:"monospace",textDecoration:"underline"}}>
                      → {suggestWeight} {t("home_kg")}
                    </button>
                  </div>
                )}
              </div>

              <div style={{width:1,height:60,background:C.border,flexShrink:0}}/>

              {/* Повторения */}
              <div style={{textAlign:"center",flex:1,minWidth:0}}>
                <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("reps_label")}</div>
                <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"center"}}>
                  <button onClick={()=>{haptic.select();setLocalSet(p=>({...p,reps:String(Math.max(1,parseInt(p.reps||0)-1))}));}}
                    style={{width:36,height:36,borderRadius:8,background:C.card,border:`0.5px solid ${C.border}`,color:C.muted,fontSize:16,cursor:"pointer",flexShrink:0}}>−</button>
                  <input type="number" inputMode="numeric" value={localSet.reps} onChange={e=>setLocalSet(p=>({...p,reps:e.target.value}))} placeholder="0" aria-label={t("reps_label")}
                    style={{background:"none",border:"none",color:C.accent,fontSize:"clamp(22px, 6.6vw, 32px)",fontFamily:"monospace",fontWeight:700,flex:1,minWidth:0,width:"100%",padding:0,outline:"none",textAlign:"center"}}/>
                  <button onClick={()=>{haptic.select();setLocalSet(p=>({...p,reps:String(parseInt(p.reps||0)+1)}));}}
                    style={{width:36,height:36,borderRadius:8,background:C.card,border:`0.5px solid ${C.border}`,color:C.muted,fontSize:16,cursor:"pointer",flexShrink:0}}>+</button>
                </div>
              </div>
            </div>
          </Card>
        )}

        {/* Кардио: время */}
        {!lgReplaceMode&&cType==="time"&&(
          <Card accent style={{marginBottom:12,padding:"16px",textAlign:"center"}}>
            <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("time_sec")}</div>
            <input type="number" value={localSet.time} onChange={e=>setLocalSet(p=>({...p,time:e.target.value}))} placeholder="0"
              style={{background:"none",border:"none",color:C.accent,fontSize:40,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none",textAlign:"center"}}/>
          </Card>
        )}

        {/* Кардио: дистанция */}
        {!lgReplaceMode&&cType==="distance"&&(
          <Card accent style={{marginBottom:12,padding:"16px"}}>
            <div style={{display:"flex",gap:16}}>
              <div style={{flex:1,textAlign:"center"}}>
                <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("time_min_section")}</div>
                <input type="number" value={localSet.time} onChange={e=>setLocalSet(p=>({...p,time:e.target.value}))} placeholder="0"
                  style={{background:"none",border:"none",color:C.accent,fontSize:32,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none",textAlign:"center"}}/>
              </div>
              <div style={{width:1,background:C.border}}/>
              <div style={{flex:1,textAlign:"center"}}>
                <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("dist_short")}</div>
                <input type="number" step="0.1" value={localSet.distance} onChange={e=>setLocalSet(p=>({...p,distance:e.target.value}))} placeholder="0"
                  style={{background:"none",border:"none",color:C.accent,fontSize:32,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none",textAlign:"center"}}/>
              </div>
            </div>
          </Card>
        )}

        {/* История подходов */}
        {doneSets.length>0&&(
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            {doneSets.map((s,i)=>(
              <div key={i} style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"6px 10px",textAlign:"center",minWidth:60}}>
                <div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("wd_ph")} {i+1}</div>
                <div style={{fontSize:12,color:C.success,fontFamily:"monospace",fontWeight:700,marginTop:2}}>
                  {cType==="distance"?`${s.distance}${t("u_km")}`:cType==="time"?`${s.time}${t("u_s")}`:`${s.weight}×${s.reps}`}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Главная кнопка */}
        <button onClick={async()=>{
          if(logBusy)return;
          // Запись теперь мгновенная, logBusy держится один кадр. Второе касание
          // через 200 мс записало бы ещё один подход с подставленными цифрами.
          if(Date.now()-lastTapRef.current<1200)return;
          lastTapRef.current=Date.now();
          setLogBusy(true);setLogErr(null);
          try{
            await doLog();
            haptic.notify("success");
            setShowTimer(true);
            // Поля чистит сам doLog. Второй сброс здесь, после await, стирал
            // уже подставленные цифры следующего подхода: запись теперь
            // мгновенная, и подстановка успевает отработать раньше.
          }catch(e){
            console.warn("[set] не сохранён",e);
            haptic.notify("error");
            setLogErr(t("set_save_failed"));
          }finally{setLogBusy(false);}
        }}
          disabled={logBusy}
          style={{width:"100%",background:logBusy?"#8FB300":C.accent,border:"none",borderRadius:12,padding:"16px",color:C.bg,fontWeight:700,fontSize:16,cursor:logBusy?"not-allowed":"pointer",marginBottom:10,letterSpacing:0.5,opacity:logBusy?0.8:1,transition:"all 0.15s"}}>
          {logBusy?t("aw_sohranyaem"):t("set_done")}
        </button>
        {logErr&&<div role="alert" style={{fontSize:12,color:C.danger,textAlign:"center",margin:"-2px 0 10px",lineHeight:1.4}}>{logErr}</div>}
        {/* Подходы ждут связи — показываем, только если отправка уже не удалась */}
        {sqDropped>0&&<div role="alert" style={{fontSize:12,color:C.danger,textAlign:"center",margin:"-2px 0 10px",lineHeight:1.4}}>{t("sq_dropped").replace("{n}",sqDropped)}</div>}
        {sqCount>0&&sqStatus!==null&&(
          <button type="button" onClick={()=>sqKick(0)} aria-live="polite"
            style={{display:"block",width:"100%",background:"none",border:"none",padding:0,fontSize:12,color:C.warn,textAlign:"center",margin:"-2px 0 10px",lineHeight:1.4,cursor:"pointer"}}>
            {t("sq_waiting").replace("{n}",sqCount)} · {t("retry")}
          </button>
        )}

        {/* Навигация между упражнениями */}
        <div style={{display:"flex",gap:10,marginBottom:10}}>
          <Btn full onClick={()=>setCurIdx(i=>Math.max(0,i-1))} disabled={curIdx===0} style={{flex:1}}>{t("prev_btn")}</Btn>
          <Btn full onClick={()=>setCurIdx(i=>Math.min(selExs.length-1,i+1))} disabled={curIdx===selExs.length-1} style={{flex:1}}>{t("next_btn")}</Btn>
        </div>
        {/* Кнопка "Добавить упражнение" отрендерена один раз ниже, после точек-индикаторов —
            здесь раньше был дублирующий вызов с опечаткой в проп-имени (allEx вместо allExercises) */}

        {/* Точки-индикаторы */}
        <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap",marginBottom:8}}>
          {selExs.map((e,i)=>{
            // Раньше подсвечивалась только текущая точка, и по ним нельзя было
            // понять, что уже сделано. Теперь: все подходы — зелёная галочка,
            // часть — зелёная рамка.
            const cur=i===curIdx;
            const nDone=(sets[e.id]||[]).length;
            const full=nDone>=(parseInt(e.sets_recommended)||4);
            const part=nDone>0&&!full;
            return(
              <button key={e.id} onClick={()=>{if(!cur){haptic.select();setCurIdx(i);}}}
                aria-label={`${i+1}. ${tField(e,"name")}${full?" ✓":""}`} aria-current={cur?"step":undefined}
                style={{width:32,height:32,borderRadius:8,background:cur?C.accent:full?"rgba(0,204,102,0.15)":C.card,border:`0.5px solid ${cur?C.accent:(full||part)?C.success:C.border}`,color:cur?C.bg:full?C.success:C.muted,fontSize:11,fontFamily:"monospace",fontWeight:full?700:400,cursor:"pointer"}}>
                {full&&!cur?"✓":i+1}
              </button>
            );
          })}
        </div>

        {/* Фото и техника упражнения из каталога */}
        {!lgReplaceMode&&<ExerciseMediaCard key={exMedia.id} ex={exMedia} onOpen={()=>{haptic.impact("light");setInfoEx(exMedia);}}/>}

        {/* Добавить упражнение во время тренировки */}
        <AddExerciseDuringWorkout
          allExercises={allExWithCustom}
          muscleGroups={muscleGroups}
          tgId={tgId}
          onAdd={ex=>{
            // Уже есть в тренировке — переходим к нему. Раньше индекс уезжал
            // за конец списка, и экран зависал на «ЗАГРУЗКА».
            const at=selExs.findIndex(e=>e.id===ex.id);
            if(at>=0){setCurIdx(at);return;}
            setSelExs(p=>[...p,{...ex,order:p.length+1}]);
            setSets(p=>({...p,[ex.id]:[]}));
            setCurIdx(selExs.length);
          }}
        />

        {/* Шторка с техникой */}
        {infoEx&&<ExerciseInfoSheet ex={infoEx} onClose={()=>setInfoEx(null)}/>}

        {/* Таймер отдыха */}
        {showTimer&&<RestTimer autoStart={timerAuto}
          onRpe={timerEx&&tgId?(v)=>{
            // Через очередь: если подход ещё не ушёл, оценка встала бы на предыдущий
            sqPush("rpe",`${API}/workout/${tgId}/last-set-rpe`,{exercise_name:timerEx,rpe:v});
          }:null}
          onClose={()=>{
            setShowTimer(false);setTimerAuto(null);setTimerEx(null);
            // Отдых прерван вручную — снимаем его и на сервере, иначе уведомление
            // придёт, когда человек уже делает следующий подход.
            // Через очередь: иначе отмена обгоняла подход, который ещё летит,
            // подход приезжал следом и снова заводил отдых — напоминание
            // «отдых окончен» приходило посреди следующего подхода.
            if(tgId)sqPush("cancel",`${API}/workout/${tgId}/rest/cancel`,{});
          }}/>}
      </div>
    );
  }
  return null;
}


// ─── MY WORKOUTS DETAIL ───────────────────────────────────────────────────────
function MyWorkoutsDetailScreen({tgId,onBack,onNav}){
  const [data,setData]=useState(null);
  const [deleting,setDeleting]=useState(null);
  function load(){
    if(!tgId){setData({planned:[],archive:[]});return;}
    apiGet(`${API}/planned/${tgId}`,{force:true}).then(setData).catch(()=>setData({planned:[],archive:[]}));
  }
  useEffect(()=>{load();},[]);
  async function del(id){setDeleting(id);try{await fetch(`${API}/planned/${tgId}/${id}`,{method:"DELETE"});load();}catch{}finally{setDeleting(null);};}
  const fmtDt=iso=>{const d=utcToLocal(iso);return d?d.toLocaleString(dateLocale(),{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—";};
  const statusColor={scheduled:C.accent,reminded:C.warn,completed:C.success,missed:C.danger};
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("schedule_label")}</Kicker><Hero>{t("my_workouts_title")}</Hero>
    <div style={{height:16}}/>
    <Kicker>{t("upcoming_label")}</Kicker>
    {data.planned.length===0?<Card style={{marginBottom:16}}><div style={{textAlign:"center",padding:"12px 0",color:C.muted,fontSize:14}}>{t("no_planned")}</div></Card>:
    <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
      {data.planned.map(pw=><Card key={pw.id} onClick={()=>onNav("planned_detail",{pwId:pw.id})}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14,color:C.text}}>{pw.title}</div>
            <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginTop:3}}>{fmtDt(pw.planned_datetime)}</div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <span style={{fontSize:11,fontFamily:"monospace",color:statusColor[pw.status]||C.muted}}>{pw.status?.toUpperCase()}</span>
            <button onClick={e=>{e.stopPropagation();del(pw.id);}} disabled={deleting===pw.id} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:6,padding:"3px 8px",color:C.danger,fontSize:11,cursor:"pointer"}}>{deleting===pw.id?"...":"✗"}</button>
          </div>
        </div>
        <div style={{marginTop:8,fontSize:11,color:C.accent,fontFamily:"monospace"}}>{t("open_plan")}</div>
      </Card>)}
    </div>}
    {data.archive.length>0&&<><Kicker>{t("archive_section")}</Kicker><div style={{display:"flex",flexDirection:"column",gap:8}}>
      {data.archive.map(pw=><Card key={pw.id} onClick={()=>onNav("planned_detail",{pwId:pw.id})} style={{opacity:0.7}}>
        <div style={{display:"flex",justifyContent:"space-between"}}>
          <div><div style={{fontWeight:600,fontSize:14,color:C.muted}}>{pw.title}</div><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:2}}>{fmtDt(pw.planned_datetime)}</div></div>
          <span style={{fontSize:11,fontFamily:"monospace",color:statusColor[pw.status]||C.muted}}>{pw.status?.toUpperCase()}</span>
        </div>
      </Card>)}
    </div></>}
  </div>;
}

// ─── PLANNED DETAIL ───────────────────────────────────────────────────────────
function PlannedDetailScreen({pwId,tgId,onBack,exercises=[],muscleGroups=[],readOnly=false,onNav}){
  const [data,setData]=useState(null);
  const [editing,setEditing]=useState(false);
  const [form,setForm]=useState({title:"",date:"",time:""});
  const [editExIds,setEditExIds]=useState([]);
  const [exSearch,setExSearch]=useState("");
  const [saving,setSaving]=useState(false);

  useEffect(()=>{
    if(!pwId||!tgId){setData({exercises:[],title:"—",status:"error"});return;}
    fetch(`${API}/planned/${tgId}/${pwId}`)
      .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
      .then(d=>{
        setData(d);
        if(d.planned_datetime){
          // В базе время UTC, форма — по Ташкенту. Раньше форма показывала UTC-время,
          // а сохранение снова вычитало 5 ч: каждое редактирование сдвигало тренировку на 5 ч раньше.
          const dt=utcToLocal(d.planned_datetime);
          if(dt)setForm({title:d.title||"",date:ymdOf(dt),time:dt.toTimeString().slice(0,5)});
        }
      })
      .catch(()=>setData({exercises:[],title:t("failed_load"),status:"error"}));
  },[pwId]);

  async function save(){
    setSaving(true);
    try{
      const body={title:form.title,planned_datetime:`${form.date}T${form.time}:00`,exercises_ids:editExIds};
      await fetch(`${API}/planned/${tgId}/${pwId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const updated=await fetch(`${API}/planned/${tgId}/${pwId}`).then(r=>r.json());
      setData(updated);setEditing(false);
    }catch{}finally{setSaving(false);}
  }

  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  const dt=utcToLocal(data.planned_datetime)?.toLocaleString(dateLocale(),{day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"})||"—";

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("scheduled_workout")}</Kicker>
    {!editing?<>
      <Hero>{data.title||t("workout_type")}</Hero>
      <div style={{fontSize:13,color:C.accent,fontFamily:"monospace",marginTop:6,marginBottom:16}}>📅 {dt}</div>
      {!readOnly&&data?.status==="scheduled"&&<>
        <Btn accent full onClick={()=>onNav&&onNav("active_workout",{
          preselectedExIds: data.exercises?.map(e=>e.id)||[],
          plannedWorkoutId: pwId,
          exerciseTips: Object.fromEntries((data.exercises||[]).filter(e=>e.ai_tip).map(e=>[e.id,e.ai_tip])),
        })} style={{marginBottom:10}}>{t("start_workout")}</Btn>
        <Btn full onClick={()=>{setEditing(true);setEditExIds(data.exercises?.map(e=>e.id)||[]);setExSearch("");}} style={{marginBottom:16}}>{t("edit_date_plan")}</Btn>
      </>}
      {(readOnly||data?.status==="completed"||data?.status==="missed")&&<Card style={{marginBottom:12,background:data?.status==="completed"?"#00CC6611":"#FF444411",border:`0.5px solid ${data?.status==="completed"?C.success:C.danger}`}}><div style={{fontSize:13,color:data?.status==="completed"?C.success:C.danger,fontFamily:"monospace"}}>{data?.status==="completed"?t("pw_vypolnena"):t("pw_arhivnaya")+" · "+(data.status||"missed").toUpperCase()+" · "+t("pw_tolko_prosmotr")}</div></Card>}
      {data.exercises?.length===0?<Card><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>{readOnly?t("exercises_none_planned"):t("exercises_none")}</div></Card>:
      <><Kicker>{t("pw_uprazhneniya")}{data.exercises?.length})</Kicker>
      {data.exercises?.map(ex=><Card key={ex.id} style={{marginBottom:8}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <Mono color={C.accent} size={20}>{ex.order}</Mono>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14,color:C.text}}>{tField(ex,"name")}</div>
            <div style={{fontSize:11,color:C.muted,marginTop:2}}>{ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:14,height:14,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:3}}/>:ex.group_emoji+" "}{tGroup(ex)}</div>
            <div style={{display:"flex",gap:10,marginTop:6}}>
              <Tag color={DIFF_COLOR[ex.difficulty]||C.muted}>{getDiff(ex.difficulty)}</Tag>
              <span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{ex.sets_recommended}×{ex.reps_recommended}</span>
            </div>
            {ex.description&&<div style={{fontSize:12,color:C.muted,marginTop:6,lineHeight:1.5}}>{ex.description}</div>}
          </div>
        </div>
      </Card>)}</>}
    </>:<>
      <Hero>{t("edit_btn")}</Hero>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:16,marginBottom:16}}>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("name_section")}</div><input value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} style={{background:"none",border:"none",color:C.text,fontSize:16,width:"100%",outline:"none"}}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("sport_date")}</div><div style={{display:"flex",alignItems:"center",gap:8}}><input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} style={{colorScheme:"dark",background:"none",border:"none",color:C.accent,fontSize:18,fontFamily:"monospace",fontWeight:700,outline:"none",flex:1,WebkitAppearance:"none",appearance:"none"}}/><span style={{fontSize:20,flexShrink:0}}>📅</span></div></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("time_label2")}</div><div style={{display:"flex",alignItems:"center",gap:8}}><input type="time" value={form.time} onChange={e=>setForm(p=>({...p,time:e.target.value}))} style={{colorScheme:"dark",background:"none",border:"none",color:C.accent,fontSize:18,fontFamily:"monospace",fontWeight:700,outline:"none",flex:1,WebkitAppearance:"none",appearance:"none"}}/><span style={{fontSize:20,flexShrink:0}}>⏰</span></div></Card>
      </div>
      <div style={{marginBottom:16}}>
        <Kicker>{t("exercises_section")}</Kicker>
        <input value={exSearch} onChange={e=>setExSearch(e.target.value)}
          placeholder={t("search_exercise")}
          style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"8px 12px",color:C.text,fontSize:13,outline:"none",
            boxSizing:"border-box",marginTop:6,marginBottom:8}}/>
        {editExIds.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:8}}>
          {editExIds.map(id=>{
            const ex=(exercises||[]).find(e=>e.id===id);
            if(!ex)return null;
            return<div key={id} style={{display:"flex",alignItems:"center",gap:4,background:C.card,
              border:`0.5px solid ${C.border}`,borderRadius:8,padding:"4px 8px",fontSize:11}}>
              <span style={{color:C.text}}>{tField(ex,"name")}</span>
              <button onClick={()=>setEditExIds(p=>p.filter(i=>i!==id))}
                style={{background:"none",border:"none",color:C.danger,cursor:"pointer",fontSize:12,padding:0}}>✕</button>
            </div>;
          })}
        </div>}
        <div style={{maxHeight:200,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
          {(exercises||[]).filter(e=>
            !editExIds.includes(e.id)&&
            (!exSearch||e.name.toLowerCase().includes(exSearch.toLowerCase()))
          ).slice(0,20).map(ex=>(
            <button key={ex.id} onClick={()=>setEditExIds(p=>[...p,ex.id])}
              style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,
                padding:"8px 12px",color:C.text,fontSize:12,cursor:"pointer",
                textAlign:"left",display:"flex",justifyContent:"space-between"}}>
              <span>{ex.group_icon_url?<img src={ex.group_icon_url} alt="" style={{width:14,height:14,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:3}}/>:ex.group_emoji+" "}{tField(ex,"name")}</span>
              <span style={{color:C.accent}}>+</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{display:"flex",gap:10}}><Btn full onClick={()=>setEditing(false)} style={{flex:1}}>{t("cancel_btn2")}</Btn><Btn accent full onClick={save} disabled={saving} style={{flex:2}}>{saving?"...":t("save_profile")}</Btn></div>
    </>}
  </div>;
}

// ─── PLAN WORKOUT ─────────────────────────────────────────────────────────────
function PlanWorkoutScreen({tgId,exercises,muscleGroups,onBack}){
  const [step,setStep]=useState(0); // 0=group, 1=exercises, 2=datetime
  const [selGroups,setSelGroups]=useState(new Set()); // мультивыбор групп
  const [selExs,setSelExs]=useState([]);
  const [form,setForm]=useState({title:"",date:"",time:"10:00"});
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [search,setSearch]=useState("");
  const [viewEx,setViewEx]=useState(null); // просмотр карточки

  const filtered=(exercises||[]).filter(e=>(selGroups.size===0||selGroups.has(e.muscle_group_id))&&(!search||(e.name.toLowerCase().includes(search.toLowerCase())||(tField(e,"name")||"").toLowerCase().includes(search.toLowerCase()))));
  const toggle=ex=>setSelExs(prev=>prev.find(e=>e.id===ex.id)?prev.filter(e=>e.id!==ex.id):[...prev,ex]);

  async function save(){
    if(!form.date||!form.time)return;
    setSaving(true);
    try{
      // Проверяем конфликт времени
      const planDt=new Date(`${form.date}T${form.time}:00`);
      const planned=await fetch(`${API}/planned/${tgId}`).then(r=>r.json()).catch(()=>({planned:[]}));
      const conflict=(planned.planned||[]).find(pw=>{
        const pwDt=utcToLocal(pw.planned_datetime); // с сервера UTC, planDt — по Ташкенту
        return pwDt&&Math.abs(planDt-pwDt)<60*60*1000; // ±1 час
      });
      if(conflict){
        const ok=window.confirm(t("plan_time_taken").replace("{dt}",planDt.toLocaleString(dateLocale(),{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})).replace("{title}",conflict.title));
        if(ok){setSaving(false);return;}
      }
      const title=form.title||selExs.slice(0,2).map(e=>e.name.split(" ")[0]).join("+")||t("workout_type");
      const res=await fetch(`${API}/planned/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,planned_datetime:`${form.date}T${form.time}:00`,exercise_ids:selExs.map(e=>e.id)})});
      if(res.ok)setSaved(true);
    }catch{}finally{setSaving(false);}
  }

  if(saved)return <div style={{padding:"16px 16px 100px"}}>
    <div style={{textAlign:"center",paddingTop:60}}>
      <div style={{fontSize:48,color:C.accent}}>📅</div>
      <Hero style={{textAlign:"center",marginTop:16}}>{t("scheduled_done")}</Hero>
      <div style={{color:C.muted,marginTop:8,fontFamily:"monospace"}}>{t("bot_1h")}</div>
      <Btn accent full onClick={onBack} style={{marginTop:32}}>{t("back")}</Btn>
    </div>
  </div>;

  if(step===0)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={onBack}/>
      <Kicker>{t("plan_s1")}</Kicker><Hero>{t("muscles_title")}</Hero>
      <div style={{fontSize:13,color:C.muted,marginTop:8,marginBottom:16}}>{t("sel_group_hint")}</div>
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
        {muscleGroups?.map(g=>{
          const sel=selGroups.has(g.id);
          return(
            <Card key={g.id} accent={sel} onClick={()=>setSelGroups(p=>{const n=new Set(p);if(n.has(g.id))n.delete(g.id);else n.add(g.id);return n;})}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div><span style={{fontSize:22,marginRight:12}}>{g.icon_url?<img src={g.icon_url} alt="" style={{width:26,height:26,objectFit:"cover",borderRadius:5,verticalAlign:"middle"}}/>:g.emoji}</span><span style={{fontSize:15,fontWeight:600,color:sel?C.accent:C.text}}>{tField(g,"name")}</span></div>
                <span style={{width:22,height:22,borderRadius:6,background:sel?C.accent:C.card,border:`0.5px solid ${sel?C.accent:C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:sel?C.bg:C.muted,flexShrink:0}}>{sel?"✓":""}</span>
              </div>
            </Card>
          );
        })}
      </div>
      {selGroups.size>0&&<div style={{marginBottom:10,fontSize:11,color:C.accent,fontFamily:"monospace"}}>{t("plan_vybrano")}: {(muscleGroups||[]).filter(g=>selGroups.has(g.id)).map(g=>g.emoji+tField(g,"name")).join(", ")}</div>}
      <Btn accent full onClick={()=>setStep(1)}>{selGroups.size===0?t("all_exercises"):t("plan_ex_groups").replace("{n}",selGroups.size)}</Btn>
    </div>
  );

  // Просмотр карточки упражнения
  if(step===1&&viewEx)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setViewEx(null)}/>
      {viewEx.video_url?
        <video src={viewEx.video_url} style={{width:"100%",borderRadius:12,marginBottom:14,objectFit:"cover",maxHeight:220}} autoPlay loop muted playsInline onError={e=>e.target.style.display="none"}/>
        :viewEx.photo_url&&<img src={viewEx.photo_url} alt={tField(viewEx,"name")} style={{width:"100%",borderRadius:12,marginBottom:14,objectFit:"cover",maxHeight:220}} onError={e=>e.target.style.display="none"}/>}
      {/* Эта карточка (просмотр упражнения при сборе тренировки) была целиком
          русской, хотя в списке рядом название уже переводилось. Описание
          теперь приходит с сервера на нужном языке, и русское название над
          переведённым описанием смотрелось бы особенно странно. */}
      <Kicker>{viewEx.group_emoji} {tGroup(viewEx)?.toUpperCase()}</Kicker>
      <Hero style={{fontSize:20}}>{tField(viewEx,"name")}</Hero>
      <div style={{height:12}}/>
      <div style={{display:"flex",gap:8,marginBottom:14}}>
        {[{l:t("sets_label"),v:viewEx.sets_recommended},{l:t("reps_label2"),v:viewEx.reps_recommended},{l:t("difficulty_label"),v:getDiff(viewEx.difficulty)||viewEx.difficulty}].map((s,i)=>(
          <Card key={i} style={{flex:1,textAlign:"center"}}>
            <div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div>
            <div style={{fontSize:14,fontWeight:700,color:C.accent}}>{s.v||"—"}</div>
          </Card>
        ))}
      </div>
      {viewEx.description&&<Card style={{marginBottom:10}}><Kicker>{t("description_label")}</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:6}}>{viewEx.description}</div></Card>}
      {viewEx.equipment&&<Card style={{marginBottom:14}}><Kicker>{t("equipment_label")}</Kicker><div style={{fontSize:14,color:C.text,marginTop:4}}>{tEquip(viewEx.equipment)}</div></Card>}
      <div style={{display:"flex",gap:10}}>
        <Btn full onClick={()=>setViewEx(null)} style={{flex:1}}>{t("back")}</Btn>
        <Btn accent full onClick={()=>{
          setSelExs(prev=>prev.find(e=>e.id===viewEx.id)?prev.filter(e=>e.id!==viewEx.id):[...prev,viewEx]);
          setViewEx(null);
        }} style={{flex:2}}>
          {selExs.find(e=>e.id===viewEx.id)?t("plan_ubrat_iz_trenirovki"):t("plan_dobavit_v_trenirovku")}
        </Btn>
      </div>
    </div>
  );

  if(step===1)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setStep(0)}/><Kicker>{t("plan_s2")}</Kicker><Hero>{t("exercises_section")}</Hero>
    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("search_placeholder")} style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",boxSizing:"border-box",marginTop:12,marginBottom:12}}/>
    {selExs.length>0&&<div style={{marginBottom:12}}><Kicker>{t("aw_vybrano")}{selExs.length})</Kicker><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{selExs.map((e,i)=><Tag key={e.id} color={C.accent}>{i+1}. {e.name.split(" ").slice(0,2).join(" ")}</Tag>)}</div></div>}
    {filtered.slice(0,50).map(ex=>{const sel=selExs.find(e=>e.id===ex.id);return<ExCard key={ex.id} ex={ex} badge={getDiff(ex.difficulty)}
      onClick={()=>setViewEx(ex)}
      action={<button onClick={e=>{e.stopPropagation();toggle(ex);}} style={{flexShrink:0,width:32,height:32,borderRadius:8,background:sel?C.accent:C.card,border:`0.5px solid ${sel?C.accent:C.border}`,color:sel?C.bg:C.muted,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{sel?`${selExs.indexOf(sel)+1}`:"+"}</button>}/>;
    })}
    {selExs.length>0&&<div style={{position:"sticky",bottom:80,marginTop:12}}><Btn accent full onClick={()=>setStep(2)}>{t("next_datetime")}</Btn></div>}
  </div>;

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setStep(1)}/><Kicker>{t("plan_s3")}</Kicker><Hero>{t("time_label2")}</Hero>
    <div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
      <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("name_opt_section")}</div><input value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} placeholder={selExs.slice(0,2).map(e=>e.name.split(" ")[0]).join("+")||t("my_workout_name")} style={{background:"none",border:"none",color:C.text,fontSize:16,width:"100%",outline:"none"}}/></Card>
      <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("sport_date")}</div><div style={{display:"flex",alignItems:"center",gap:8}}><input id="plan-date-input" type="date" value={form.date} min={localToday()} onChange={e=>setForm(p=>({...p,date:e.target.value}))} style={{colorScheme:"dark",background:"none",border:"none",color:C.accent,fontSize:20,fontFamily:"monospace",fontWeight:700,outline:"none",flex:1,WebkitAppearance:"none",appearance:"none"}}/><span style={{fontSize:22,flexShrink:0}}>📅</span></div></Card>
      <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("time_label2")}</div><div style={{display:"flex",alignItems:"center",gap:8}}><input id="plan-time-input" type="time" value={form.time} onChange={e=>setForm(p=>({...p,time:e.target.value}))} style={{colorScheme:"dark",background:"none",border:"none",color:C.accent,fontSize:20,fontFamily:"monospace",fontWeight:700,outline:"none",flex:1,WebkitAppearance:"none",appearance:"none"}}/><span style={{fontSize:22,flexShrink:0}}>⏰</span></div></Card>
    </div>
    <div style={{marginBottom:16}}><Kicker>{t("pw_uprazhneniya")}{selExs.length})</Kicker>{selExs.map((e,i)=><div key={e.id} style={{padding:"6px 0",borderBottom:`0.5px solid ${C.border}`,display:"flex",gap:10}}><Mono color={C.accent} size={13}>{i+1}</Mono><span style={{fontSize:13,color:C.text}}>{tField(e,"name")}</span></div>)}</div>
    <Btn accent full onClick={save} disabled={saving||!form.date}>{saving?t("saving"):t("plan_zaplanirovat")}</Btn>
    <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",textAlign:"center",marginTop:8}}>{t("bot_1h_full")}</div>
  </div>;
}

// ─── STANDALONE TIMER (из меню) ──────────────────────────────────────────────
function StandaloneTimer({onBack}){
  return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={onBack}/>
      <Kicker>{t("tools_title")}</Kicker>
      <Hero>{t("timer_title")}</Hero>
      <div style={{height:16}}/>
      <Card>
        <div style={{fontSize:13,color:C.muted,lineHeight:1.6,marginBottom:12}}>
          {t("ui_taymer_avtomaticheski_zapuskae")}<br/>
          {t("ui_zdes_mozhno_ispolzovat_otdelno")}
        </div>
      </Card>
      <div style={{marginTop:16,position:"relative"}}>
        <RestTimer onClose={onBack} standalone/>
      </div>
    </div>
  );
}

// ─── WEIGHT CHART ─────────────────────────────────────────────────────────────
function WeightChart({logs}){
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(()=>{
    if(!logs||logs.length<2||!canvasRef.current)return;

    // Уничтожаем предыдущий график
    if(chartRef.current){chartRef.current.destroy();}

    const sorted = [...logs].sort((a,b)=>new Date(a.logged_at)-new Date(b.logged_at)).slice(-30);
    const labels = sorted.map(w=>{
      const d=new Date(w.logged_at);
      return d.toLocaleDateString(dateLocale(),{day:"numeric",month:"short"});
    });
    const data = sorted.map(w=>parseFloat(w.weight)||0);
    const minW = Math.min(...data)-1;
    const maxW = Math.max(...data)+1;

    chartRef.current = new window.Chart(canvasRef.current,{
      type:"line",
      data:{
        labels,
        datasets:[{
          label:t("field_weight_kg"),
          data,
          borderColor:"#C8FF00",
          backgroundColor:"rgba(200,255,0,0.08)",
          borderWidth:2,
          pointBackgroundColor:"#C8FF00",
          pointRadius:4,
          pointHoverRadius:6,
          fill:true,
          tension:0.3,
        }]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{
          legend:{display:false},
          tooltip:{
            backgroundColor:"#222222",
            titleColor:"#888888",
            bodyColor:"#C8FF00",
            borderColor:"#2A2A2A",
            borderWidth:1,
          }
        },
        scales:{
          x:{
            ticks:{color:"#888888",font:{size:10},maxRotation:45},
            grid:{color:"rgba(255,255,255,0.05)"},
          },
          y:{
            min:minW,max:maxW,
            ticks:{color:"#888888",font:{size:10},callback:v=>`${v} ${t("home_kg")}`},
            grid:{color:"rgba(255,255,255,0.05)"},
          }
        }
      }
    });

    return()=>{if(chartRef.current)chartRef.current.destroy();};
  },[logs]);

  // Загружаем Chart.js если нет
  useEffect(()=>{
    if(window.Chart)return;
    const script=document.createElement("script");
    script.src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
    script.onload=()=>{if(canvasRef.current&&logs?.length>=2){/* перерисует useEffect выше */}};
    document.head.appendChild(script);
  },[]);

  const sorted=[...logs].sort((a,b)=>new Date(a.logged_at)-new Date(b.logged_at));
  const first=parseFloat(sorted[0]?.weight||0);
  const last=parseFloat(sorted[sorted.length-1]?.weight||0);
  const delta=Math.round((last-first)*10)/10;

  return(
    <Card style={{marginTop:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <Kicker>{t("weight_dynamics")}</Kicker>
        <div style={{textAlign:"right"}}>
          <Mono size={16}>{last} {t("home_kg")}</Mono>
          {delta!==0&&<div style={{fontSize:11,fontFamily:"monospace",color:delta<0?C.success:C.danger,marginTop:2}}>
            {delta>0?"+":""}{delta} {t("ui_kg_za_period")}
          </div>}
        </div>
      </div>
      <div style={{position:"relative",height:160}}>
        <canvas ref={canvasRef} role="img" aria-label={t("prog_weight_range").replace("{a}",first).replace("{b}",`${last} ${t("home_kg")}`)}/>
      </div>
    </Card>
  );
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────
function MuscleGroupChart({data,groupName,emoji}){
  if(!data||data.length===0)return null;
  // При 1 тренировке показываем карточку с данными без графика
  if(data.length===1){
    const d=data[0];
    return<Card style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <Kicker>{emoji} {groupName.toUpperCase()}</Kicker>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("one_session2")}</div>
      </div>
      <div style={{display:"flex",gap:16,padding:"8px 0"}}>
        <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("date_label")}</div><Mono size={13}>{String(d.date).slice(0,10).slice(5)}</Mono></div>
        <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("max_w")}</div><Mono size={13}>{d.max_weight}{t("home_kg")}</Mono></div>
        <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("volume_section")}</div><Mono size={13}>{Math.round(d.volume)}</Mono></div>
        <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{t("sets_label")}</div><Mono size={13}>{d.sets}</Mono></div>
      </div>
      <div style={{fontSize:11,color:C.muted,marginTop:4}}>{t("need_2_workouts")}</div>
    </Card>;
  }
  const maxVol=Math.max(...data.map(d=>d.volume),1);
  const maxW=Math.max(...data.map(d=>d.max_weight),1);
  const W=300;const H=100;const pad=12;
  // Форматируем дату MM-DD из строки YYYY-MM-DD или timestamp
  const fmtDate=s=>{
    if(!s)return"";
    const clean=String(s).slice(0,10); // берём только YYYY-MM-DD
    return clean.slice(5); // MM-DD
  };
  const pts=data.map((d,i)=>{
    const x=pad+i*(W-pad*2)/(data.length-1);
    const y=H-pad-(d.volume/maxVol)*(H-pad*2);
    return `${x},${y}`;
  });
  return<Card style={{marginBottom:12}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
      <Kicker>{emoji} {groupName.toUpperCase()}</Kicker>
      <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>
        max {Math.round(maxW)}{t("home_kg")} · {data.length} {t("sessions_count")}
      </div>
    </div>
    <div style={{width:"100%",overflow:"hidden"}}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"100px",display:"block"}}>
        <polyline points={pts.join(" ")} fill="none" stroke={C.accent} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        {data.map((d,i)=>{
          const x=pad+i*(W-pad*2)/(data.length-1);
          const y=H-pad-(d.volume/maxVol)*(H-pad*2);
          return<circle key={i} cx={x} cy={y} r="4" fill={C.accent}/>;
        })}
      </svg>
    </div>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted,fontFamily:"monospace",marginTop:4}}>
      <span>{fmtDate(data[0]?.date)}</span>
      <span>{t("volume_short")}</span>
      <span>{fmtDate(data[data.length-1]?.date)}</span>
    </div>
    <div style={{display:"flex",gap:12,marginTop:8,flexWrap:"wrap"}}>
      {data.slice(-3).map((d,i)=><div key={i} style={{fontSize:10}}>
        <div style={{color:C.muted,fontFamily:"monospace"}}>{fmtDate(d.date)}</div>
        <div style={{color:C.accent,fontWeight:600}}>max {d.max_weight}{t("home_kg")}</div>
        <div style={{color:C.muted}}>{t("mgc_obem")} {Math.round(d.volume)}</div>
      </div>)}
    </div>
  </Card>;
}

// Короткое название вида спорта для недельной полосы. Коды приходят с бэкенда,
// полный справочник грузить ради одной подписи незачем.
// Храним КЛЮЧИ, а не переводы: карта вычисляется при загрузке модуля, когда
// язык ещё не известен. Если положить сюда t(), подпись застынет на начальном
// языке — человек переключил бы язык, весь интерфейс сменился, а недельная
// полоса видов спорта осталась бы на прежнем до перезапуска приложения.
const SPORT_SHORT_KEYS={padel:"sps_padel",football:"sps_futbol",basketball:"sps_basket",volleyball:"sps_voley",
  tennis:"sps_tennis",table_tennis:"sps_n_tennis",badminton:"sps_badm",handball:"sps_gandbol",
  boxing:"sps_boks",swimming:"sps_plav",cycling:"sps_velo",running:"sps_beg",
  crossfit:"sps_krossfit",yoga:"sps_yoga",pilates:"sps_pilates",skiing:"sps_lyzhi",climbing:"sps_skalolaz"};
const SPORT_SHORT_RAW={mma:"MMA"};   // одинаково на всех языках, ключ не нужен
function sportLabel(code){
  if(!code)return null;
  const k=SPORT_SHORT_KEYS[code];
  if(k) return t(k);
  return SPORT_SHORT_RAW[code]||String(code).slice(0,8);
}

// ── Силовые ранги ────────────────────────────────────────────────────────────
// Считает API (strength.py): лучший подход → расчётный максимум → доля от веса тела
// → уровень по нормативам для пола и возраста. Ранги бесплатные.
const STR_LEVELS=["start","beginner","novice","intermediate","advanced","elite"];
const STR_RU_NAMES={bench:"Жим штанги лёжа",squat:"Приседания со штангой",deadlift:"Становая тяга",ohp:"Жим штанги стоя (ОНП)",
  row:"Тяга штанги в наклоне",pullup:"Подтягивания широким хватом",dips:"Отжимания на брусьях",front_squat:"Фронтальные приседания",
  rdl:"Румынская тяга",hip_thrust:"Ягодичный мостик со штангой",leg_press:"Жим ногами",pulldown:"Тяга верхнего блока",
  db_bench:"Жим гантелей лёжа",db_press:"Жим гантелей сидя",curl:"Подъём штанги на бицепс"};
const strLvl=k=>t("str_lvl_"+k);
function fmtKg(v){return Math.round(v*10)/10;}

function StrengthLadder({lift}){
  // шкала: пять порогов, отметка — где сейчас лучший результат
  const th=lift.thresholds||[];
  const max=th.length?th[th.length-1]*1.1:1;
  const pos=Math.min(100,Math.max(0,(lift.best/max)*100));
  return <div style={{position:"relative",height:8,borderRadius:4,background:C.border,marginTop:8}}>
    <div style={{position:"absolute",left:0,top:0,bottom:0,width:`${pos}%`,borderRadius:4,background:C.accent}}/>
    {th.map((x,i)=><div key={i} title={strLvl(STR_LEVELS[i+1])} style={{position:"absolute",top:-2,bottom:-2,width:1.5,
      left:`${(x/max)*100}%`,background:i+1<=lift.level?C.bg:C.muted,opacity:0.8}}/>)}
  </div>;
}

function StrengthLiftRow({lift,last}){
  const unit=lift.kind==="reps"?t("str_reps"):t("home_kg");
  const from=lift.kind==="reps"?t("str_from_reps").replace("{r}",lift.from?.reps)
    :t("str_from").replace("{w}",fmtKg(lift.from?.weight||0)).replace("{r}",lift.from?.reps);
  return <div style={{padding:"12px 0",borderBottom:last?"none":`0.5px solid ${C.border}`}}>
    <div style={{display:"flex",alignItems:"baseline",gap:8}}>
      <div style={{fontSize:14,color:C.text,fontWeight:600,flex:1,minWidth:0}}>{trEx(lift.exercise)||trEx(STR_RU_NAMES[lift.key])}</div>
      <span style={{fontSize:11,fontFamily:"monospace",color:lift.level>=3?C.bg:C.accent,background:lift.level>=3?C.accent:"transparent",
        border:`1px solid ${C.accent}`,borderRadius:6,padding:"2px 7px",whiteSpace:"nowrap"}}>{strLvl(lift.level_key)}</span>
    </div>
    <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:4}}>
      <Mono size={18}>{fmtKg(lift.best)}</Mono><span style={{fontSize:12,color:C.muted}}>{unit}{lift.kind==="ratio"?` · ${t("str_e1rm")}`:""}</span>
      <span style={{fontSize:11,color:C.muted,marginLeft:"auto",textAlign:"right"}}>{from}</span>
    </div>
    <StrengthLadder lift={lift}/>
    <div style={{fontSize:12,color:C.muted,marginTop:8,lineHeight:1.45}}>
      {lift.next?t("str_to_next").replace("{lvl}",strLvl(lift.next.level)).replace("{n}",fmtKg(lift.next.to_go)).replace("{u}",unit):t("str_top")}
    </div>
    {lift.community&&<div style={{fontSize:11,color:C.accent,marginTop:4,fontFamily:"monospace"}}>
      {t("str_community").replace("{n}",lift.community.stronger_than_pct).replace("{m}",lift.community.people)}
    </div>}
  </div>;
}

function StrengthOverall({d}){
  const o=d.overall;
  return <Card accent style={{marginBottom:12}}>
    <Kicker style={{margin:0}}>{t("str_overall")}</Kicker>
    <div style={{display:"flex",alignItems:"baseline",gap:10,marginTop:6}}>
      <div style={{fontSize:24,fontWeight:800,color:C.accent}}>{strLvl(o.level_key)}</div>
      <span style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginLeft:"auto"}}>{t("str_on").replace("{n}",o.lifts)}</span>
    </div>
    <div style={{fontSize:13,color:C.text,marginTop:4}}>{t("str_stronger").replace("{n}",o.percentile)}</div>
    <div style={{display:"flex",gap:3,marginTop:10}}>
      {STR_LEVELS.slice(1).map((k,i)=><div key={k} style={{flex:1,height:6,borderRadius:3,
        background:o.score>=i+1?C.accent:C.border,opacity:o.score>=i+1?1:0.7}}/>)}
    </div>
  </Card>;
}

function useStrength(tgId){
  const [d,setD]=useState(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    if(!tgId)return;
    apiGet(`${API}/strength/${tgId}`).then(setD).catch(()=>setFailed(true));
  },[tgId]);
  return [d,failed];
}

// Карточка на вкладке «Прогресс»
function StrengthCard({tgId,onNav}){
  const [d]=useStrength(tgId);
  if(!d)return null;
  const top=[...(d.lifts||[])].sort((a,b)=>b.score-a.score).slice(0,3);
  return <Card onClick={onNav?()=>onNav("strength"):undefined} style={{marginBottom:16}}>
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <IconTile name="bolt"/>
      <div style={{flex:1}}>
        <Kicker style={{margin:0}}>{t("str_title")}</Kicker>
        <div style={{fontSize:14,color:C.text,marginTop:3}}>
          {d.overall?<>{strLvl(d.overall.level_key)} · <span style={{color:C.muted}}>{t("str_stronger").replace("{n}",d.overall.percentile)}</span></>
            :(d.missing?.length?t("str_missing"):t("str_empty"))}
        </div>
      </div>
      <span style={{color:C.muted,fontSize:16}}>›</span>
    </div>
    {top.length>0&&<div style={{marginTop:10,display:"flex",flexDirection:"column",gap:4}}>
      {top.map(l=><div key={l.key} style={{display:"flex",fontSize:12,color:C.muted}}>
        <span style={{flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{trEx(l.exercise)}</span>
        <span style={{color:C.accent,fontFamily:"monospace",marginLeft:8}}>{strLvl(l.level_key)}</span>
      </div>)}
    </div>}
  </Card>;
}

function StrengthScreen({tgId,onBack,onNav}){
  const [d,failed]=useStrength(tgId);
  if(failed)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/>
    <div style={{fontSize:14,color:C.muted,marginTop:20}}>{t("home_load_error")}</div></div>;
  if(!d)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;
  const done=new Set((d.lifts||[]).map(l=>l.key));
  const untracked=(d.keys||[]).filter(k=>!done.has(k));
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("str_kicker")}</Kicker>
    <Hero>{t("str_title")}</Hero>
    <div style={{fontSize:12,color:C.muted,lineHeight:1.55,marginTop:8,marginBottom:16}}>{t("str_basis")}</div>
    {d.missing?.length>0&&<Card style={{marginBottom:12}}>
      <div style={{fontSize:14,color:C.text,lineHeight:1.5}}>{t("str_missing")}</div>
      {onNav&&<Btn accent full style={{marginTop:10}} onClick={()=>onNav("profile")}>{t("str_btn_profile")}</Btn>}
    </Card>}
    {d.overall&&<StrengthOverall d={d}/>}
    {d.lifts?.length>0&&<Card style={{marginBottom:12}} pad="4px 16px">
      {d.lifts.map((l,i)=><StrengthLiftRow key={l.key} lift={l} last={i===d.lifts.length-1}/>)}
    </Card>}
    {!d.missing?.length&&!d.lifts?.length&&<Card style={{marginBottom:12}}>
      <div style={{fontSize:13,color:C.muted,lineHeight:1.5}}>{t("str_empty")}</div></Card>}
    {untracked.length>0&&<div style={{marginTop:6}}>
      <Kicker>{t("str_untracked")}</Kicker>
      <div style={{fontSize:12,color:C.muted,margin:"6px 0 8px",lineHeight:1.5}}>{t("str_untracked_hint")}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {untracked.map(k=><span key={k} style={{fontSize:12,color:C.text,border:`0.5px solid ${C.border}`,borderRadius:14,padding:"5px 10px"}}>
          {trEx(STR_RU_NAMES[k])}</span>)}
      </div>
    </div>}
  </div>;
}

// ── Программы тренировок ─────────────────────────────────────────────────────
// Каталог и «моя программа» (programs.py). Тренировка из программы стартует с
// program_day — сервер засчитывает её и двигает день по кругу.
function fmtReps(r){
  const s=String(r||"");
  if(s==="max")return t("prog_reps_max");
  const sec=s.match(/^(\d+)(?:-(\d+))?s$/);
  if(sec)return `${sec[1]}${sec[2]?"–"+sec[2]:""} ${t("prog_sec")}`;
  return s.replace("-","–");
}
function fmtRest(n){
  if(!n)return "";
  return n>=120?t("prog_rest_m").replace("{n}",String(Math.round(n/30)/2).replace(".",LANG_STORE.current==="en"?".":",")):t("prog_rest_s").replace("{n}",n);
}
function progTip(e){return `${e.sets} × ${fmtReps(e.reps)}${e.rest?" · "+fmtRest(e.rest):""}`;}
function progMeta(p){return t("prog_meta").replace("{d}",p.days_per_week).replace("{w}",p.weeks);}

function usePrograms(tgId){
  const [d,setD]=useState(null);
  const [failed,setFailed]=useState(false);
  const load=(force=false)=>{
    if(!tgId)return;
    apiGet(`${API}/programs/${tgId}?lang=${LANG_STORE.current||"ru"}`,{force}).then(setD).catch(()=>setFailed(true));
  };
  useEffect(()=>{load();},[tgId]);
  return [d,failed,load];
}

// Старт тренировки по дню программы: состав и подсказки «3 × 8–10 · отдых 90 с»
function startProgramDay(onNav,day){
  const exs=(day?.exercises||[]).filter(e=>e.exercise_id);
  onNav("active_workout",{preselectedExIds:exs.map(e=>e.exercise_id),
    exerciseTips:Object.fromEntries(exs.map(e=>[e.exercise_id,progTip(e)])),programDay:day.index});
}

function ProgramActiveCard({act,onOpen,onStart}){
  const pct=act.total?Math.round(act.done/act.total*100):0;
  return <Card accent style={{marginBottom:14}}>
    <Kicker style={{margin:0}}>{t("prog_active")}</Kicker>
    <div onClick={onOpen} style={{fontSize:17,fontWeight:700,color:C.text,marginTop:6,cursor:onOpen?"pointer":"default"}}>{act.title}</div>
    <div style={{display:"flex",fontSize:12,color:C.muted,marginTop:4,fontFamily:"monospace"}}>
      <span>{t("prog_progress").replace("{n}",Math.min(act.done+1,act.total)).replace("{t}",act.total)}</span>
      {act.week&&<span style={{marginLeft:"auto"}}>{t("prog_week").replace("{n}",act.week)}</span>}
    </div>
    <div style={{marginTop:8}}><ProgressBar pct={pct}/></div>
    {act.next_day_title&&<div style={{fontSize:13,color:C.text,marginTop:8}}>{t("prog_next").replace("{day}",act.next_day_title)}</div>}
    {onStart&&<Btn accent full style={{marginTop:10}} onClick={onStart}>{t("prog_start_day").replace("{day}",act.next_day_title||"")}</Btn>}
  </Card>;
}

function ProgramsScreen({tgId,onBack,onNav}){
  const [d,failed]=usePrograms(tgId);
  if(failed)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/>
    <div style={{fontSize:14,color:C.muted,marginTop:20}}>{t("home_load_error")}</div></div>;
  if(!d)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;
  const act=d.active&&!d.active.finished?d.active:null;
  async function startNext(){
    // следующий день берём из деталей: там состав с id упражнений
    try{
      const det=await apiGet(`${API}/programs/${tgId}/${act.slug}?lang=${LANG_STORE.current||"ru"}`);
      startProgramDay(onNav,det.days[act.next_day]);
    }catch{window.alert(t("home_load_error"));}
  }
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("prog_kicker")}</Kicker>
    <Hero>{t("prog_title")}</Hero>
    <div style={{fontSize:13,color:C.muted,lineHeight:1.55,marginTop:8,marginBottom:16}}>{t("prog_lead")}</div>
    {d.active?.finished&&<Card accent style={{marginBottom:14}}><div style={{fontSize:14,color:C.accent}}>{t("prog_finished")}</div></Card>}
    {act&&<ProgramActiveCard act={act} onOpen={()=>onNav("program_detail",{slug:act.slug})} onStart={startNext}/>}
    {(d.programs||[]).map(p=><Card key={p.slug} onClick={()=>onNav("program_detail",{slug:p.slug})} style={{marginBottom:10}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:15,fontWeight:700,color:C.text}}>{p.title}</div>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:3}}>{progMeta(p)} · {strLvl(p.level)}</div>
        </div>
        {act?.slug===p.slug?<span style={{fontSize:10,fontFamily:"monospace",color:C.bg,background:C.accent,borderRadius:6,padding:"2px 6px"}}>{t("prog_is_active")}</span>
          :p.premium?<span style={{display:"flex",alignItems:"center",gap:3,fontSize:10,fontFamily:"monospace",color:C.accent,border:`1px solid ${C.accent}`,borderRadius:6,padding:"2px 6px"}}>
            <Icon name="star" size={10} fill="currentColor"/>PREMIUM</span>
          :<span style={{fontSize:10,fontFamily:"monospace",color:C.muted,border:`0.5px solid ${C.border}`,borderRadius:6,padding:"2px 6px"}}>{t("prog_free")}</span>}
      </div>
      <div style={{fontSize:12,color:C.muted,lineHeight:1.5,marginTop:8,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{p.desc}</div>
      <div style={{fontSize:11,color:C.muted,marginTop:6}}>{(p.day_titles||[]).join(" · ")}</div>
    </Card>)}
  </div>;
}

function ProgramDetailScreen({tgId,slug,onBack,onNav}){
  const [d,setD]=useState(null);
  const [failed,setFailed]=useState(false);
  const [busy,setBusy]=useState(false);
  const load=(force=false)=>apiGet(`${API}/programs/${tgId}/${slug}?lang=${LANG_STORE.current||"ru"}`,{force}).then(setD).catch(()=>setFailed(true));
  useEffect(()=>{if(tgId&&slug)load();},[tgId,slug]);
  if(failed)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/>
    <div style={{fontSize:14,color:C.muted,marginTop:20}}>{t("home_load_error")}</div></div>;
  if(!d)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;
  const act=d.active&&!d.active.finished?d.active:null;

  async function start(){
    if(busy)return;
    try{
      const list=await apiGet(`${API}/programs/${tgId}?lang=${LANG_STORE.current||"ru"}`);
      const cur=list?.active&&!list.active.finished?list.active:null;
      if(cur&&cur.slug!==slug&&!window.confirm(t("prog_replace_confirm").replace("{cur}",cur.title)))return;
    }catch{}
    setBusy(true);
    try{
      const r=await fetch(`${API}/programs/${tgId}/${slug}/start`,{method:"POST"});
      if(r.status===403){onNav("premium");return;}
      if(!r.ok)throw new Error(r.status);
      invalidateApi("/programs/");haptic.notify("success");
      await load(true);
    }catch{window.alert(t("home_load_error"));}
    finally{setBusy(false);}
  }
  async function stop(){
    if(busy||!window.confirm(t("prog_stop_confirm")))return;
    setBusy(true);
    try{
      await fetch(`${API}/programs/${tgId}/stop`,{method:"POST"});
      invalidateApi("/programs/");await load(true);
    }catch{}
    finally{setBusy(false);}
  }

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("prog_kicker")}</Kicker>
    <Hero style={{fontSize:24}}>{d.title}</Hero>
    <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:6}}>{progMeta(d)} · {strLvl(d.level)}</div>
    <div style={{fontSize:13,color:C.muted,lineHeight:1.6,marginTop:10,marginBottom:14}}>{d.desc}</div>
    {act&&<ProgramActiveCard act={{...act,title:d.title,next_day_title:d.days[act.next_day]?.title}}
      onStart={()=>startProgramDay(onNav,d.days[act.next_day])}/>}
    {!act&&(d.locked
      ?<Btn accent full style={{marginBottom:14}} onClick={()=>onNav("premium")}>{withStar?withStar(t("prog_unlock")):t("prog_unlock")}</Btn>
      :<Btn accent full style={{marginBottom:14}} disabled={busy} onClick={start}>{busy?"…":t("prog_start")}</Btn>)}
    {d.note&&<Card style={{marginBottom:14}} pad="12px 14px">
      <Kicker style={{margin:0}}>{t("prog_tip")}</Kicker>
      <div style={{fontSize:13,color:C.text,lineHeight:1.55,marginTop:6}}>{d.note}</div>
    </Card>}
    <Kicker>{t("prog_days")}</Kicker>
    <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:8}}>
      {d.days.map(day=><Card key={day.index} pad="12px 14px" accent={act?.next_day===day.index}>
        <div style={{fontSize:14,fontWeight:700,color:act?.next_day===day.index?C.accent:C.text,marginBottom:6}}>{day.title}</div>
        {day.exercises.map((e,i)=><div key={i} style={{display:"flex",gap:8,fontSize:13,padding:"5px 0",borderTop:i?`0.5px solid ${C.border}`:"none"}}>
          <span style={{flex:1,minWidth:0,color:e.exercise_id?C.text:C.muted}}>{trEx(e.name)}{!e.exercise_id&&<span style={{fontSize:10,marginLeft:6}}>({t("prog_not_in_catalog")})</span>}</span>
          <span style={{fontFamily:"monospace",fontSize:12,color:C.accent,whiteSpace:"nowrap"}}>{e.sets} × {fmtReps(e.reps)}</span>
        </div>)}
      </Card>)}
    </div>
    {act&&<Btn full style={{marginTop:16}} disabled={busy} onClick={stop}>{t("prog_stop")}</Btn>}
  </div>;
}

// На главном: идёт программа — карточка со следующим днём; нет — короткий вход в каталог
function ProgramHomeCard({tgId,onNav}){
  const [d]=usePrograms(tgId);
  const act=d?.active&&!d.active.finished?d.active:null;
  if(!d)return null;
  if(!act)return <Card onClick={()=>onNav("programs")} pad="13px 14px" style={{marginTop:8}}>
    <div style={{display:"flex",alignItems:"center",gap:9}}>
      <span style={{fontSize:17}}>📋</span>
      <span style={{fontSize:14,color:C.text}}>{t("prog_menu")}</span>
      <span style={{marginLeft:"auto",color:C.muted,fontSize:16}}>›</span>
    </div>
  </Card>;
  return <Card onClick={()=>onNav("programs")} pad="13px 14px" style={{marginTop:8}}>
    <div style={{display:"flex",alignItems:"center",gap:9}}>
      <span style={{fontSize:17}}>📋</span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:14,color:C.text,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{act.title}</div>
        <div style={{fontSize:12,color:C.muted,marginTop:2}}>{t("prog_next").replace("{day}",act.next_day_title||"")} · {act.done}/{act.total}</div>
      </div>
      <span style={{color:C.accent,fontSize:16}}>›</span>
    </div>
  </Card>;
}

// ── Друзья, лента и команды (social.py) ─────────────────────────────────────
// Друзья — по личной ссылке startapp=fr_<код>, команды — startapp=tm_<код>.
// В ленте — только тренировки и рекорды; вес, питание и здоровье — никогда.
function shareTg(url,textMsg){
  const link=`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(textMsg||"")}`;
  if(tg?.openTelegramLink)tg.openTelegramLink(link);else window.open(link,"_blank");
}
function socErr(detail){
  const c=detail?.code;
  return c==="own_code"?t("soc_own_code"):c==="team_full"?t("soc_team_full"):c==="too_many_teams"?t("soc_too_many_teams"):t("soc_bad_code");
}
function fmtTon(kg){const v=Math.round((kg||0)/100)/10;return t("soc_tonnage").replace("{n}",String(v).replace(".",LANG_STORE.current==="en"?".":","));}

function FeedItem({it,tgId,onLiked}){
  const [busy,setBusy]=useState(false);
  async function like(){
    if(busy)return;setBusy(true);
    try{
      const r=await fetch(`${API}/social/${tgId}/feed/${it.workout_id}/like`,{method:"POST"});
      if(r.ok){const d=await r.json();haptic.impact?.("light");onLiked(it.workout_id,d);}
    }catch{}finally{setBusy(false);}
  }
  const more=it.exercises_count-it.exercises.length;
  return <Card style={{marginBottom:10}} pad="12px 14px">
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div style={{width:32,height:32,borderRadius:"50%",background:it.is_me?C.accent:C.bg,border:`0.5px solid ${C.border}`,
        display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:it.is_me?C.bg:C.accent,flexShrink:0}}>
        {(it.is_me?t("soc_you"):it.name).trim().charAt(0).toUpperCase()}</div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:14,fontWeight:600,color:C.text}}>{it.is_me?t("soc_you"):it.name}</div>
        <div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{fmtDay(it.date)}</div>
      </div>
    </div>
    <div style={{fontSize:13,color:C.text,marginTop:10,lineHeight:1.5}}>
      {it.exercises.map(trEx).join(" · ")}{more>0?` · +${more}`:""}
    </div>
    <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:6}}>
      {[t("soc_sets").replace("{n}",it.sets),it.volume>0?fmtTon(it.volume):null,it.duration_min>0?t("soc_min").replace("{n}",it.duration_min):null].filter(Boolean).join(" · ")}
    </div>
    {it.records.map((r,i)=><div key={i} style={{fontSize:12,color:C.accent,marginTop:6}}>
      🏆 {t("soc_record").replace("{ex}",trEx(r.exercise)).replace("{w}",fmtKg(r.weight)).replace("{p}",fmtKg(r.prev))}</div>)}
    <div style={{display:"flex",marginTop:10}}>
      <button onClick={like} disabled={busy||it.is_me&&false} style={{background:it.liked?C.accent:"transparent",color:it.liked?C.bg:C.text,
        border:`0.5px solid ${it.liked?C.accent:C.border}`,borderRadius:16,padding:"5px 12px",fontSize:13,cursor:"pointer"}}>
        👏 {it.likes>0?it.likes:""}</button>
    </div>
  </Card>;
}

function SocialFeed({tgId}){
  const [items,setItems]=useState(null);
  const [next,setNext]=useState(null);
  const [loading,setLoading]=useState(false);
  async function load(before){
    setLoading(true);
    try{
      const r=await fetch(`${API}/social/${tgId}/feed${before?`?before=${encodeURIComponent(before)}`:""}`);
      const d=await r.json();
      setItems(p=>before?[...(p||[]),...(d.items||[])]:(d.items||[]));setNext(d.next_before||null);
    }catch{setItems(p=>p||[]);}finally{setLoading(false);}
  }
  useEffect(()=>{if(tgId)load(null);},[tgId]);
  if(!items)return <Loader text={t("loading")}/>;
  if(!items.length)return <div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"30px 10px"}}>{t("soc_feed_empty")}</div>;
  return <div>
    {items.map(it=><FeedItem key={it.workout_id} it={it} tgId={tgId}
      onLiked={(id,d)=>setItems(p=>p.map(x=>x.workout_id===id?{...x,liked:d.liked,likes:d.likes}:x))}/>)}
    {next&&<Btn full disabled={loading} onClick={()=>load(next)}>{loading?"…":t("soc_more")}</Btn>}
  </div>;
}

function SocialFriends({tgId,data,reload}){
  const [copied,setCopied]=useState(false);
  async function setShare(v){
    await fetch(`${API}/social/${tgId}/privacy`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({share_workouts:v})}).catch(()=>{});
    reload();
  }
  async function remove(f){
    if(!window.confirm(t("soc_remove_confirm").replace("{name}",f.name)))return;
    await fetch(`${API}/social/${tgId}/friends/${f.id}`,{method:"DELETE"}).catch(()=>{});
    reload();
  }
  return <div>
    <Card accent style={{marginBottom:12}}>
      <div style={{fontSize:15,fontWeight:700,color:C.text}}>{t("soc_invite_title")}</div>
      <div style={{fontSize:12,color:C.muted,lineHeight:1.5,marginTop:6}}>{t("soc_invite_hint")}</div>
      <Btn accent full style={{marginTop:10}} onClick={()=>shareTg(data.invite_link,t("soc_share_text"))}>{t("soc_invite_btn")}</Btn>
      <Btn full style={{marginTop:8}} onClick={()=>{navigator.clipboard?.writeText(data.invite_link).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);}).catch(()=>{});}}>
        {copied?t("soc_copied"):t("soc_copy")}</Btn>
    </Card>
    <Card style={{marginBottom:12}} pad="12px 14px" onClick={()=>setShare(!data.share_workouts)}>
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <span style={{flex:1,fontSize:14,color:C.text}}>{t("soc_privacy")}</span>
        <span style={{width:42,height:24,borderRadius:12,background:data.share_workouts?C.accent:C.border,position:"relative",flexShrink:0}}>
          <span style={{position:"absolute",top:3,left:data.share_workouts?21:3,width:18,height:18,borderRadius:"50%",background:C.bg,transition:"left .15s"}}/>
        </span>
      </div>
    </Card>
    {data.friends.length===0?<div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"18px 10px"}}>{t("soc_friends_empty")}</div>
      :data.friends.map(f=><Card key={f.id} style={{marginBottom:8}} pad="11px 14px">
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,color:C.text,fontWeight:600}}>{f.name}</div>
            {f.week!=null&&<div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:2}}>{t("soc_week_n").replace("{n}",f.week)}</div>}
          </div>
          <span onClick={()=>remove(f)} style={{fontSize:12,color:C.muted,cursor:"pointer"}}>{t("soc_remove")}</span>
        </div>
      </Card>)}
  </div>;
}

function TeamBoard({team,tgId,onChanged}){
  async function leave(){
    if(!window.confirm(t("soc_team_leave_confirm").replace("{name}",team.name)))return;
    await fetch(`${API}/social/${tgId}/teams/${team.id}/leave`,{method:"POST"}).catch(()=>{});
    onChanged(null);
  }
  async function rename(){
    const n=window.prompt(t("soc_team_name"),team.name);
    if(!n||n.trim().length<2)return;
    const r=await fetch(`${API}/social/${tgId}/teams/${team.id}/rename`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n})}).catch(()=>null);
    if(r?.ok)onChanged(await r.json());
  }
  async function kick(m){
    if(!window.confirm(t("soc_remove_member_confirm").replace("{name}",m.name)))return;
    const r=await fetch(`${API}/social/${tgId}/teams/${team.id}/members/${m.id}`,{method:"DELETE"}).catch(()=>null);
    if(r?.ok)onChanged(await r.json());
  }
  return <div>
    <Card accent style={{marginBottom:12}}>
      <div style={{fontSize:17,fontWeight:700,color:C.text}}>{team.name}</div>
      <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginTop:4}}>
        {t("soc_team_members").replace("{n}",team.members)} · {t("soc_team_week").replace("{n}",team.week_total)}</div>
      <Btn accent full style={{marginTop:10}} onClick={()=>shareTg(team.invite_link,t("soc_share_team_text").replace("{name}",team.name))}>{t("soc_team_invite")}</Btn>
      <div style={{fontSize:11,color:C.muted,marginTop:8,fontFamily:"monospace",textAlign:"center"}}>{t("soc_team_code")}: {team.code}</div>
    </Card>
    <Kicker>{t("soc_board_title")}</Kicker>
    <div style={{fontSize:11,color:C.muted,margin:"4px 0 8px"}}>{t("soc_board_hint")}</div>
    <Card pad="4px 14px" style={{marginBottom:12}}>
      {team.board.map((m,i)=><div key={m.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderTop:i?`0.5px solid ${C.border}`:"none"}}>
        <span style={{width:22,fontFamily:"monospace",fontSize:13,color:m.place<=3?C.accent:C.muted}}>{m.place}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:14,color:m.is_me?C.accent:C.text,fontWeight:m.is_me?700:500}}>
            {m.is_me?t("soc_you"):m.name}{m.is_owner&&<span style={{fontSize:10,color:C.muted,marginLeft:6}}>{t("soc_owner")}</span>}</div>
          <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{t("soc_last_week").replace("{n}",m.last_week)}</div>
        </div>
        <Mono size={16}>{m.week}</Mono>
        {team.is_owner&&!m.is_me&&<span onClick={()=>kick(m)} style={{fontSize:11,color:C.muted,cursor:"pointer",marginLeft:4}}>✕</span>}
      </div>)}
    </Card>
    {team.is_owner&&<Btn full style={{marginBottom:8}} onClick={rename}>{t("soc_team_rename")}</Btn>}
    <Btn full onClick={leave}>{t("soc_team_leave")}</Btn>
  </div>;
}

function SocialTeams({tgId,data,reload,openTeamId,setOpenTeamId}){
  const [name,setName]=useState("");
  const [code,setCode]=useState("");
  const [msg,setMsg]=useState(null);
  const [busy,setBusy]=useState(false);
  const team=data.teams.find(x=>x.id===openTeamId);
  if(team)return <div>
    <div onClick={()=>setOpenTeamId(null)} style={{fontSize:12,color:C.muted,cursor:"pointer",marginBottom:10,fontFamily:"monospace"}}>← {t("tab_teams")}</div>
    <TeamBoard team={team} tgId={tgId} onChanged={tm=>{if(!tm)setOpenTeamId(null);reload();}}/>
  </div>;
  async function create(){
    if(busy||name.trim().length<2)return;setBusy(true);setMsg(null);
    try{
      const r=await fetch(`${API}/social/${tgId}/teams`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})});
      const d=await r.json();
      if(!r.ok){setMsg(socErr(d.detail));return;}
      setName("");await reload();setOpenTeamId(d.id);
    }catch{setMsg(t("home_load_error"));}finally{setBusy(false);}
  }
  async function join(){
    if(busy||code.trim().length<4)return;setBusy(true);setMsg(null);
    try{
      const r=await fetch(`${API}/social/${tgId}/teams/join`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:code.trim()})});
      const d=await r.json();
      if(!r.ok){setMsg(socErr(d.detail));return;}
      setCode("");await reload();setOpenTeamId(d.team.id);
    }catch{setMsg(t("home_load_error"));}finally{setBusy(false);}
  }
  const inp={width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.text,fontSize:14,outline:"none",boxSizing:"border-box"};
  return <div>
    {data.teams.length===0&&<div style={{fontSize:13,color:C.muted,textAlign:"center",padding:"10px 10px 16px"}}>{t("soc_teams_empty")}</div>}
    {data.teams.map(tm=><Card key={tm.id} onClick={()=>setOpenTeamId(tm.id)} style={{marginBottom:8}} pad="12px 14px">
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:15,fontWeight:700,color:C.text}}>{tm.name}</div>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:3}}>
            {t("soc_team_members").replace("{n}",tm.members)} · {t("soc_team_week").replace("{n}",tm.week_total)}</div>
        </div>
        {tm.my_place&&<span style={{fontSize:12,color:C.accent,fontFamily:"monospace"}}>#{tm.my_place}</span>}
        <span style={{color:C.muted}}>›</span>
      </div>
    </Card>)}
    {msg&&<div style={{fontSize:13,color:C.danger,margin:"8px 0"}}>{msg}</div>}
    <Card style={{marginTop:12}} pad="12px 14px">
      <Kicker style={{margin:0}}>{t("soc_team_create")}</Kicker>
      <input value={name} onChange={e=>setName(e.target.value)} maxLength={60} placeholder={t("soc_team_name")} style={{...inp,marginTop:8}}/>
      <Btn accent full style={{marginTop:8}} disabled={busy||name.trim().length<2} onClick={create}>{t("soc_team_create")}</Btn>
    </Card>
    <Card style={{marginTop:8}} pad="12px 14px">
      <Kicker style={{margin:0}}>{t("soc_team_join")}</Kicker>
      <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())} maxLength={12} placeholder={t("soc_team_code")} style={{...inp,marginTop:8,fontFamily:"monospace",letterSpacing:2}}/>
      <Btn full style={{marginTop:8}} disabled={busy||code.trim().length<4} onClick={join}>{t("soc_team_join")}</Btn>
    </Card>
  </div>;
}

function SocialScreen({tgId,onBack,accept=null,join=null,tab:tab0=null}){
  const [tab,setTab]=useState(tab0||(accept?"friends":join?"teams":"feed"));
  const [data,setData]=useState(null);
  const [banner,setBanner]=useState(null);   // {text, ok}
  const [openTeamId,setOpenTeamId]=useState(null);
  const handled=useRef(false);
  async function reload(){
    try{const r=await fetch(`${API}/social/${tgId}`);if(r.ok)setData(await r.json());}catch{}
  }
  useEffect(()=>{
    if(!tgId)return;
    (async()=>{
      if(!handled.current&&(accept||join)){
        handled.current=true;
        try{
          if(accept){
            const r=await fetch(`${API}/social/${tgId}/friends/accept`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:accept})});
            const d=await r.json();
            setBanner(r.ok?{text:t(d.already?"soc_already":"soc_accepted").replace("{name}",d.friend?.name||""),ok:true}:{text:socErr(d.detail)});
            if(r.ok&&!d.already)haptic.notify("success");
          }else{
            const r=await fetch(`${API}/social/${tgId}/teams/join`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:join})});
            const d=await r.json();
            setBanner(r.ok?{text:t("soc_team_joined").replace("{name}",d.team?.name||""),ok:true}:{text:socErr(d.detail)});
            if(r.ok)setOpenTeamId(d.team.id);
          }
        }catch{setBanner({text:t("home_load_error")});}
      }
      await reload();
    })();
  },[tgId]);
  const tabs=[["feed",t("tab_feed")],["friends",t("tab_friends")],["teams",t("tab_teams")]];
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("soc_kicker")}</Kicker>
    <Hero>{t("soc_title")}</Hero>
    {banner&&<Card accent={!!banner.ok} style={{marginTop:12}} pad="11px 14px">
      <div style={{fontSize:13,color:banner.ok?C.accent:C.text}}>{banner.text}</div></Card>}
    <div style={{display:"flex",gap:6,margin:"14px 0"}}>
      {tabs.map(([k,l])=><button key={k} onClick={()=>{setTab(k);if(k!=="teams")setOpenTeamId(null);}} style={{flex:1,padding:"8px 0",borderRadius:16,fontSize:13,cursor:"pointer",
        background:tab===k?C.accent:C.card,color:tab===k?C.bg:C.muted,border:`0.5px solid ${tab===k?C.accent:C.border}`,fontFamily:"inherit"}}>{l}</button>)}
    </div>
    {tab==="feed"&&<SocialFeed tgId={tgId}/>}
    {tab!=="feed"&&!data&&<Loader text={t("loading")}/>}
    {tab==="friends"&&data&&<SocialFriends tgId={tgId} data={data} reload={reload}/>}
    {tab==="teams"&&data&&<SocialTeams tgId={tgId} data={data} reload={reload} openTeamId={openTeamId} setOpenTeamId={setOpenTeamId}/>}
  </div>;
}

function ProgressScreen({stats,tgId,onNav}){
  const [week,setWeek]=useState(()=>_cachedHome(tgId)?.week||null);
  const [muscleData,setMuscleData]=useState(null);
  const [activeGroup,setActiveGroup]=useState(null);
  const [days,setDays]=useState(90);

  // Детали недели: берём из кэша главного экрана, если он есть, иначе догружаем
  useEffect(()=>{
    if(!tgId||week)return;
    apiGet(`${API}/home/${tgId}`).then(d=>setWeek(d.week)).catch(()=>{});
  },[tgId,week]);

  useEffect(()=>{
    if(!tgId)return;
    setMuscleData(null);
    fetch(`${API}/progress/muscle-groups/${tgId}?days=${days}`)
      .then(r=>r.json())
      .then(d=>setMuscleData(d))
      .catch(()=>setMuscleData({}));
  },[tgId,days]);


  if(!stats)return <div style={{padding:"16px 16px 100px"}}><Loader text={t("progress_label")}/></div>;
  const weekly=stats.weekly_workouts||[];const peak=Math.max(...weekly,1);
  const blocks=" ▁▂▃▄▅▆▇█";const spark=weekly.map(v=>blocks[Math.min(8,Math.round(8*v/peak))]).join("");

  const groups=Object.entries(muscleData?.by_group||{});
  const selectedGroup=activeGroup&&muscleData?.by_group?.[activeGroup];

  return <div style={{padding:"16px 16px 100px"}}>
    <Kicker>{stats.period_days||30} {t("streak_days5")}</Kicker><Hero>{t("progress_title2")}</Hero>
    <div style={{height:16}}/>

    {/* Основные метрики */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
      {[
        {l:t("prog_trenirovok"),v:stats.total_workouts||0},
        {l:t("sets_label"),v:stats.total_sets||0},
        {l:t("tonnage_label2"),v:`${Math.round((stats.total_volume||0)/1000*10)/10} ${t("u_t")}`},
        {l:t("prog_seriya"),v:`${stats.streak_days||0} ${t("u_dn")}`}
      ].map((s,i)=><Card key={i}>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{tSport(s)||s.l}</div>
        <Mono>{s.v}</Mono>
      </Card>)}
    </div>

    {/* Текущая неделя по дням */}
    {week&&<Card style={{marginBottom:16}}>
      <div style={{display:"flex",alignItems:"baseline",marginBottom:10}}>
        <Kicker>{t("prog_this_week")}</Kicker>
        <span style={{marginLeft:"auto",fontSize:13,color:C.text}}>
          {week.target?`${week.done} ${t("home_of")} ${week.target}`:`${week.done}`}
          {week.sport_count>0?` · ${t("home_sport")} ${week.sport_count}`:""}
        </span>
      </div>
      <div style={{display:"flex",gap:5}}>
        {(week.days||[]).map((d,i)=>{
          const wd=[t("prog_pn"),t("prog_vt"),t("prog_sr"),t("prog_cht"),t("prog_pt"),t("prog_sb"),t("prog_vs")][i]||"";
          const bg=d.gym?C.accent:C.card;
          const bd=d.gym?C.accent:d.sport?C.accent:C.border;
          const col=d.gym?C.bg:d.sport?C.accent:C.muted;
          // Подписываем словом: безымянный символ читается как пропуск,
          // хотя в этот день была тренировка, просто не в зале.
          const label=d.gym?t("week_gym"):d.sport?(sportLabel(d.sport_type)||t("week_sport")):"—";
          return <div key={i} style={{flex:1,borderRadius:8,padding:"7px 2px",textAlign:"center",
            background:bg,border:`${d.is_today?1:0.5}px solid ${d.is_today?"#fff":bd}`}}>
            <div style={{fontSize:10,color:col,opacity:0.8}}>{wd}</div>
            <div style={{fontSize:9,color:col,marginTop:3,lineHeight:1.1,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
          </div>;
        })}
      </div>
    </Card>}

    {/* График по неделям */}
    {weekly.length>0&&<Card style={{marginBottom:16}}>
      <Kicker>{t("weekly_activity")}</Kicker>
      <div style={{fontFamily:"monospace",fontSize:22,color:C.accent,letterSpacing:2,margin:"8px 0"}}>{spark||t("no_sets_data")}</div>
      <div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{t("workouts_week")}</div>
    </Card>}

    {/* Прогресс по группам мышц */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
      <Kicker>{t("muscle_progress")}</Kicker>
      <select value={days} onChange={e=>setDays(Number(e.target.value))}
        style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:6,
          padding:"4px 8px",color:C.accent,fontSize:11,fontFamily:"monospace",outline:"none"}}>
        <option value={30}>{t("day_30")}</option>
        <option value={60}>{t("day_60")}</option>
        <option value={90}>{t("day_90")}</option>
        <option value={180}>{t("day_180")}</option>
      </select>
    </div>

    {!muscleData?<Loader text={t("loading")}/>:groups.length===0?
      <Card style={{marginBottom:16}}><div style={{color:C.muted,fontSize:13,textAlign:"center",padding:"12px 0"}}>{t("no_data_period")}</div></Card>:
      <>
        {/* Кнопки групп мышц */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
          <button onClick={()=>setActiveGroup(null)}
            style={{padding:"6px 12px",borderRadius:20,fontSize:11,cursor:"pointer",
              background:!activeGroup?C.accent:C.card,
              border:`0.5px solid ${!activeGroup?C.accent:C.border}`,
              color:!activeGroup?C.bg:C.muted,fontFamily:"monospace"}}>{t("all_btn")}</button>
          {groups.map(([name,g])=><button key={name} onClick={()=>setActiveGroup(activeGroup===name?null:name)}
            style={{padding:"6px 12px",borderRadius:20,fontSize:11,cursor:"pointer",
              background:activeGroup===name?C.accent:C.card,
              border:`0.5px solid ${activeGroup===name?C.accent:C.border}`,
              color:activeGroup===name?C.bg:C.muted}}>
            {g.emoji} {trGroupName(name)} ({g.workouts.length})
          </button>)}
        </div>

        {/* Графики */}
        {(activeGroup?[[activeGroup,selectedGroup]]:groups).map(([name,g])=>
          g&&<MuscleGroupChart key={name} data={g.workouts} groupName={trGroupName(name)} emoji={g.emoji}/>
        )}
      </>
    }

    {/* Вес */}
    {stats.weight_logs?.length>0&&<WeightChart logs={stats.weight_logs}/>}

    {/* Силовые ранги (заменили старый блок «силовые vs нормы») */}
    <StrengthCard tgId={tgId} onNav={onNav}/>

    {/* Плато детектор */}
    <PlateauBlock tgId={tgId}/>
    {onNav&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:16}}>
      <Card onClick={()=>onNav("achievements")} pad="13px 14px">
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <span style={{fontSize:17}}>🎖</span>
          <span style={{fontSize:14,color:C.text}}>{t("more_achievements")}</span>
        </div>
      </Card>
      <Card onClick={()=>onNav("leaderboard")} pad="13px 14px">
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <span style={{fontSize:17}}>📊</span>
          <span style={{fontSize:14,color:C.text}}>{t("more_leaderboard")}</span>
        </div>
      </Card>
    </div>}
  </div>;
}

// ─── CATALOG ──────────────────────────────────────────────────────────────────
function ExerciseCatalogCard({ex,onClick}){
  const containerRef=useRef(null);
  const [inView,setInView]=useState(false);
  const [imgLoaded,setImgLoaded]=useState(false);

  useEffect(()=>{
    if(!ex.video_url||!containerRef.current)return;
    const obs=new IntersectionObserver((entries)=>{
      if(entries[0].isIntersecting){setInView(true);obs.disconnect();}
    },{rootMargin:"150px"}); // начинаем грузить видео чуть раньше, до появления в кадре
    obs.observe(containerRef.current);
    return ()=>obs.disconnect();
  },[ex.video_url]);

  return (
    <Card onClick={onClick} style={{padding:0,overflow:"hidden",cursor:"pointer",marginBottom:0}}>
      <div ref={containerRef} style={{position:"relative",width:"100%",aspectRatio:"1/1",background:C.bg,overflow:"hidden"}}>
        {ex.video_url&&inView?
          <video src={ex.video_url} poster={ex.photo_url} style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}
            autoPlay loop muted playsInline preload="metadata" onError={e=>e.target.style.display="none"}/>
          :ex.photo_url?
          <img src={ex.photo_url} alt="" loading="lazy"
            style={{width:"100%",height:"100%",objectFit:"cover",display:"block",opacity:imgLoaded?1:0,transition:"opacity 0.25s ease"}}
            onLoad={()=>setImgLoaded(true)} onError={e=>e.target.style.display="none"}/>
          :<div style={{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30}}>{ex.group_emoji||"💪"}</div>}
      </div>
      <div style={{padding:"9px 10px 11px"}}>
        <div style={{fontWeight:600,fontSize:12.5,color:C.text,lineHeight:1.3,marginBottom:5,minHeight:32}}>{tField(ex,"name")}</div>
        <Tag color={DIFF_COLOR[ex.difficulty]||C.muted}>{getDiff(ex.difficulty)}</Tag>
      </div>
    </Card>
  );
}

function CatalogScreen({exercises,muscleGroups,onNav}){
  const [activeGroup,setActiveGroup]=useState(null);
  const [search,setSearch]=useState("");
  const [selected,setSelected]=useState(null);
  const selectedFull=useExerciseText(selected);
  const filtered=(exercises||[]).filter(e=>(!activeGroup||e.muscle_group_id===activeGroup)&&(!search||(e.name.toLowerCase().includes(search.toLowerCase())||(tField(e,"name")||"").toLowerCase().includes(search.toLowerCase()))));

  // Предзагрузка фото видимой выборки — прогреваем кэш браузера ДО того как карточки
  // реально отрендерятся, чтобы изображения не "выскакивали" по одному при скролле.
  // Кэш теперь долгоживущий (immutable) — при повторном заходе фото вообще не перекачиваются.
  useEffect(()=>{
    filtered.slice(0,40).forEach(ex=>{
      if(ex.photo_url){const img=new Image();img.src=ex.photo_url;}
    });
  },[activeGroup,search,exercises]);

  // Открытая карточка держит сам объект упражнения, а описание и техника в нём
  // приходят с сервера уже на одном языке. Если каталог приехал заново на
  // другом языке (первый запуск: сперва ответ по сохранённому языку, потом по
  // языку из профиля), список под карточкой обновится, а открытая карточка
  // останется с описанием на прежнем языке. Поэтому подменяем её свежим
  // объектом из нового массива.
  useEffect(()=>{
    if(!selected)return;
    const fresh=(exercises||[]).find(e=>e.id===selected.id);
    // Своих упражнений в общем каталоге нет — тогда fresh не найдётся и
    // карточка остаётся как есть, это правильно.
    if(fresh&&fresh!==selected)setSelected(fresh);
  },[exercises,selected]);

  if(selected)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setSelected(null)}/>
    {selected.video_url?
      <video src={selected.video_url} poster={selected.photo_url} style={{width:"100%",borderRadius:12,marginBottom:14,objectFit:"cover",maxHeight:220}} autoPlay loop muted playsInline preload="auto" onError={e=>e.target.style.display="none"}/>
      :selected.photo_url&&<img src={selected.photo_url} alt={tField(selected,"name")} style={{width:"100%",borderRadius:12,marginBottom:14,objectFit:"cover",maxHeight:220}} onError={e=>e.target.style.display="none"}/>}
    <Kicker>{selected.group_icon_url?<img src={selected.group_icon_url} alt="" style={{width:16,height:16,objectFit:"cover",borderRadius:3,verticalAlign:"middle",marginRight:4}}/>:selected.group_emoji+" "}{tGroup(selected)?.toUpperCase()}</Kicker><Hero>{tField(selected,"name")}</Hero>
    <div style={{height:12}}/>
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      {[{l:t("sets_label"),v:selected.sets_recommended},{l:t("reps_label2"),v:selected.reps_recommended},{l:t("difficulty_label"),v:getDiff(selected.difficulty)||selected.difficulty}].map((s,i)=><Card key={i} style={{flex:1,textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div><div style={{fontSize:14,fontWeight:700,color:C.accent}}>{s.v||"—"}</div></Card>)}
    </div>
    {selectedFull.description&&<Card style={{marginBottom:10}}><Kicker>{t("description_label")}</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:6}}>{tField(selectedFull,"description")}</div></Card>}
    {selectedFull.technique&&<Card style={{marginBottom:10}}>
      <Kicker>{t("technique_label")}</Kicker>
      <div style={{fontSize:14,color:C.text,lineHeight:1.8,marginTop:6,whiteSpace:"pre-wrap"}}>{tField(selectedFull,"technique")}</div>
    </Card>}
    {selected&&!selectedFull.technique&&<TechPlaceholder full={selectedFull}/>}
    {selected.equipment&&<Card><Kicker>{t("equipment_label")}</Kicker><div style={{fontSize:14,color:C.text,marginTop:4}}>{tEquip(selected.equipment)}</div></Card>}
  </div>;

  return <div style={{padding:"16px 16px 100px"}}>
    <Kicker>{t("knowledge_base")}</Kicker><Hero>{t("exercises_section")}</Hero>
    <div style={{height:12}}/>
    {onNav&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
      <Card onClick={()=>onNav("food_guide")} pad="12px 14px">
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <span style={{fontSize:17}}>🥗</span>
          <span style={{fontSize:14,color:C.text}}>{t("menu_food_guide")}</span>
        </div>
      </Card>
      <Card onClick={()=>onNav("supplements")} pad="12px 14px">
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <span style={{fontSize:17}}>◆</span>
          <span style={{fontSize:14,color:C.text}}>{t("menu_supplements")}</span>
        </div>
      </Card>
    </div>}
    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("search_placeholder")} style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",letterSpacing:1,boxSizing:"border-box",marginBottom:12,outline:"none"}}/>
    <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:12}}>
      <button onClick={()=>setActiveGroup(null)} style={{flexShrink:0,padding:"6px 12px",borderRadius:20,background:!activeGroup?C.accent:C.card,color:!activeGroup?C.bg:C.muted,border:`0.5px solid ${!activeGroup?C.accent:C.border}`,fontSize:11,fontFamily:"monospace",cursor:"pointer",fontWeight:700}}>{t("all_btn")}</button>
      {muscleGroups?.map(g=><button key={g.id} onClick={()=>setActiveGroup(g.id===activeGroup?null:g.id)} style={{flexShrink:0,padding:"6px 12px",borderRadius:20,background:activeGroup===g.id?C.accent:C.card,color:activeGroup===g.id?C.bg:C.muted,border:`0.5px solid ${activeGroup===g.id?C.accent:C.border}`,fontSize:11,fontFamily:"monospace",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:5}}>{g.icon_url?<img src={g.icon_url} alt="" style={{width:16,height:16,objectFit:"cover",borderRadius:3}}/>:g.emoji} {(tField(g,"name")).toUpperCase()}</button>)}
    </div>
    <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{filtered.length}  {t("exercises_label")}</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
      {filtered.slice(0,60).map(ex=><ExerciseCatalogCard key={ex.id} ex={ex} onClick={()=>setSelected(ex)}/>)}
    </div>
  </div>;
}

// ─── AI ───────────────────────────────────────────────────────────────────────
// ── VoiceRecorder — запись голоса и транскрипция ────────────────────────────
function VoiceRecorder({tgId,onTranscribed,disabled=false}){
  const [recording,setRecording]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [seconds,setSeconds]=useState(0);
  const mediaRef=useRef(null);
  const chunksRef=useRef([]);
  const timerRef=useRef(null);

  async function startRec(){
    setError(null);
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
      // Определяем поддерживаемый формат
      const mimeType=["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg","audio/mp4"]
        .find(t=>MediaRecorder.isTypeSupported(t))||"";
      const mr=new MediaRecorder(stream,mimeType?{mimeType}:{});
      chunksRef.current=[];
      mr.ondataavailable=e=>{if(e.data&&e.data.size>0)chunksRef.current.push(e.data);};
      mr.onstop=async()=>{
        stream.getTracks().forEach(t=>t.stop());
        if(chunksRef.current.length===0){
          setError(t("no_audio"));
          setLoading(false);
          return;
        }
        const finalMime=mr.mimeType||mimeType||"audio/webm";
        const blob=new Blob(chunksRef.current,{type:finalMime});
        console.log("[Voice] blob size:",blob.size,"type:",finalMime);
        await transcribe(blob,finalMime);
      };
      mr.start(); // без timeslice — один chunk при stop
      mediaRef.current=mr;
      setRecording(true);
      setSeconds(0);
      timerRef.current=setInterval(()=>setSeconds(s=>s+1),1000);
    }catch(e){
      console.error("[Voice] startRec error:",e);
      setError(e.name==="NotAllowedError"?t("no_mic"):e.message||t("voice_oshibka"));
    }
  }

  function stopRec(){
    clearInterval(timerRef.current);
    setRecording(false);
    setLoading(true);
    if(mediaRef.current&&mediaRef.current.state!=="inactive"){
      mediaRef.current.requestData(); // принудительно сбрасываем буфер
      mediaRef.current.stop();
    }
  }

  async function transcribe(blob,mimeType){
    try{
      // Определяем расширение для Whisper
      const ext=mimeType.includes("ogg")?"ogg":mimeType.includes("mp4")?"mp4":"webm";
      const res=await fetch(`${API}/voice/transcribe?tg_id=${tgId}&ext=${ext}`,{
        method:"POST",
        headers:{"Content-Type":mimeType||"audio/webm"},
        body:blob,
      });
      if(!res.ok){
        const e=await res.json().catch(()=>({detail:t("error_server")}));
        throw new Error(e.detail||t("voice_oshibka"));
      }
      const d=await res.json();
      if(!d.text)throw new Error(t("speech_not_recognized"));
      onTranscribed(d.text);
    }catch(e){
      console.error("[Voice] transcribe error:",e);
      setError(e.message||t("transcription_error"));
    }finally{
      setLoading(false);
    }
  }

  const fmt=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  return(
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      {error&&<div style={{fontSize:11,color:C.danger,flex:1}}>{error}</div>}
      {loading&&<div style={{fontSize:11,color:C.muted,fontFamily:"monospace",flex:1}}>{t("recognizing")}</div>}
      {recording&&!loading&&(
        <div style={{fontSize:12,color:C.danger,fontFamily:"monospace",flex:1}}>
          ● {fmt(seconds)}
        </div>
      )}
      <button
        onClick={recording?stopRec:startRec}
        disabled={disabled||loading}
        style={{
          width:44,height:44,borderRadius:"50%",
          background:recording?C.danger:C.card,
          border:`1.5px solid ${recording?C.danger:C.border}`,
          color:recording?"#fff":C.muted,
          fontSize:20,cursor:"pointer",flexShrink:0,
          display:"flex",alignItems:"center",justifyContent:"center",
          transition:"all 0.2s",
          opacity:disabled||loading?0.5:1,
        }}>
        {loading?"⏳":recording?"⬛":"🎙"}
      </button>
    </div>
  );
}



function AIScreen({user,tgId,onNav,exercises=[]}){
  const [q,setQ]=useState("");
  const qTaRef=useRef(null);
  const [answer,setAnswer]=useState(null);
  const [limitHit,setLimitHit]=useState(false);   // упёрлись в суточный лимит — покажем Premium
  const [aiBlocked,setAiBlocked]=useState(false); // отозвано согласие на передачу данных
  const [workoutPlan,setWorkoutPlan]=useState(null);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [chatHistory,setChatHistory]=useState([]); // [{role,content,time}]
  const [streamText,setStreamText]=useState("");   // ответ, который сейчас печатается
  // Выбор даты объявлен здесь, выше ask(): открывать его теперь может и сам ответ
  // тренера, когда человек попросил сохранить тренировку словами в чате.
  const [showDatePicker,setShowDatePicker]=useState(false);
  const [planDate,setPlanDate]=useState(()=>{const d=new Date();d.setDate(d.getDate()+1);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().split("T")[0];});
  const [planTime,setPlanTime]=useState("10:00");
  // Сессия диалога живёт в localStorage, а не в состоянии компонента. Экран AI
  // рендерится условно (if(tab==="ai")), поэтому при любом переходе он размонтировался
  // и sessionId генерировался заново — диалог рвался, тренер начинал с нуля.
  // Сессия обнуляется сама через сутки простоя или по кнопке «Очистить».
  const [sessionId,setSessionId]=useState(()=>{
    const SKEY="gymbot_ai_session", TTL=24*60*60*1000;
    try{
      const raw=localStorage.getItem(SKEY);
      if(raw){
        const s=JSON.parse(raw);
        if(s?.id&&s?.tgId===tgId&&s?.ts&&Date.now()-s.ts<TTL){
          localStorage.setItem(SKEY,JSON.stringify({...s,ts:Date.now()}));
          return s.id;
        }
      }
    }catch{}
    const id=`session_${tgId}_${Date.now()}`;
    try{localStorage.setItem(SKEY,JSON.stringify({id,tgId,ts:Date.now()}));}catch{}
    return id;
  });
  // Восстанавливаем переписку с сервера — иначе человек видит пустой экран,
  // хотя тренер помнит диалог, и это выглядит как потеря истории.
  // Заодно возвращаем последний предложенный план: без него кнопка сохранения
  // исчезала при любом уходе с экрана, и тренировку было уже не сохранить.
  useEffect(()=>{
    if(!tgId||!sessionId)return;
    let alive=true;
    try{
      const raw=localStorage.getItem("gymbot_ai_plan");
      if(raw){
        const p=JSON.parse(raw);
        // Возвращаем только план. Текст ответа не восстанавливаем: он мог
        // устареть на несколько ходов вперёд, и в панели показывался бы старый
        // ответ при том, что история чата ниже заканчивается новым.
        if(p?.sessionId===sessionId&&p?.plan?.exercises?.length>0)setWorkoutPlan(p.plan);
      }
    }catch{}
    fetch(`${API}/ai/history/${tgId}?session_id=${sessionId}`)
      .then(r=>r.ok?r.json():null)
      .then(d=>{
        if(!alive||!d?.messages?.length)return;
        setChatHistory(d.messages.map(m=>({role:m.role,content:m.content,time:""})));
      }).catch(()=>{});
    return()=>{alive=false;};
  },[tgId,sessionId]);
  const requestsLeft=5-(user?.ai_requests_today||0);
  const suggs=[t("ai_sostav_plan_trenirovki_na"),t("ai_chto_est_do_i"),t("ai_programma_dlya_pohudeniya_na"),t("ai_trenirovka_na_plechi_i")];

  async function ask(question){
    if(!question.trim()||loading)return;
    const userMsg={role:"user",content:question,time:new Date().toLocaleTimeString(dateLocale(),{hour:"2-digit",minute:"2-digit"})};
    setChatHistory(prev=>[...prev,userMsg]);
    // workoutPlan НЕ сбрасываем: уточнение к уже предложенной тренировке стирало план,
    // и кнопка сохранения исчезала насовсем. Новый план заменит старый сам.
    setLoading(true);setAnswer(null);setSaved(false);setQ("");setAiBlocked(false);
    try{
      // Режим задаём явно, но не «plan» на всё подряд: на этом же экране спрашивают
      // и про еду. Запрос считается тренировочным, если он про тренировку по словам,
      // ИЛИ если план уже предложен — тогда это уточнение к нему, и состав с кнопкой
      // сохранения терять нельзя (раньше ровно это и происходило).
      // Узбекские и казахские корни добавлены 05.10.2026. До этого список был
      // только русско-английским, поэтому вопрос, заданный по-узбекски, никогда
      // не попадал в режим плана: тренер отвечал текстом, без состава упражнений
      // и без кнопки сохранения.
      const PLAN_WORDS=["тренировк","программ","сплит","упражнен","жим","присед","тяг",
        "ноги","спину","груд","плеч","бицепс","трицепс","workout","program","split","exercise",
        "train","trening","mashq","жаттығ","dastur","бағдарлам","tricep","triseps",
        "squat","скват","bicep","biseps","orqa","арқа","leg","oyoq","аяқ","chest","ko‘krak",
        "кеуде","shoulder","yelka","иық","press","push","bosish","jim","итеру","pull","row",
        "tortish","tyaga","тарту","тяга"];
      // Про еду, добавки и сон спрашивают теми же словами («что есть до тренировки») —
      // такие вопросы в режим плана не уводим, иначе тренер обязан будет выдать состав
      // упражнений там, где его не просили.
      const FOOD_WORDS=["есть","еда","пита","калори","белк","протеин","углевод","жиры",
        "добавк","креатин","витамин","вода","пить","сон","спать","диет","меню",
        "eat","food","nutrition","calor","protein","diet","sleep","supplement",
        "oqsil","ақуыз","carb","uglevod","көмірсу","creatin","kreatin","kalori",
        "qo‘shimcha","қоспа","uxla","uyqu","ұйық","ұйқы","ovqat","тамақ","nutrit",
        "ovqatlan","тамақтан","fat","yog‘","май","water","suv","drink","ichim","ichis",
        "diyet","menu","menyu","мәзір","meal","taom","тағам",
        // Удлинённые до трёх символов корни «есть»: «ye» и «же» сами по себе
        // слишком коротки. «yey» покрывает yeyish/yeyman и не задевает «yelka»,
        // «жеу» — казахское «жеу керек». Без них вопрос «treningdan oldin nima
        // yeyish kerak» попадал в режим плана из-за слова «trening».
        "yey","жеу"];
      // Два способа поиска, и это не придирка.
      //
      // Корни от четырёх символов ищем ПОДСТРОКОЙ, как было раньше. Русский
      // язык приставочный: «есть» должно поймать «поесть», «съесть», «наесться»,
      // а «пить» — «выпить» и «попить». Если требовать начало слова, вопрос
      // «что поесть после тренировки» перестаёт быть вопросом про еду и уезжает
      // в режим плана из-за слова «тренировк». Именно это я тут и сломал,
      // когда переходил на поиск по началу слова для всех корней подряд.
      //
      // Трёхсимвольные корни ищем в НАЧАЛЕ слова: подстрокой они дают слишком
      // много ложных попаданий. Короче трёх символов не берём вовсе («ye»,
      // «су», «іш») — узбекское «ye» лежит внутри «yelka» (плечо), и вопрос
      // «yelka uchun trening» уехал бы в режим еды при любом способе поиска.
      //
      // Апострофы приводим к одному виду: в словах вроде «yog‘», «qo‘shimcha»
      // у нас стоит типографский U+2018, а телефонная клавиатура даёт обычный
      // апостроф или U+2019. Без приведения такие корни не срабатывали никогда.
      const normApos=(s)=>s.replace(/[‘’ʻʼ`´']/g,"'");
      const ql=normApos(question.toLowerCase());
      const hasStem=(w0)=>{
        const w=normApos(w0);
        if(w.length<3) return false;
        if(w.length>=4) return ql.includes(w);
        try{ return new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`,"u").test(ql); }
        catch{ return ql.includes(w); }   // движок без поддержки \p{...}
      };
      const looksLikePlan=PLAN_WORDS.some(hasStem);
      const looksLikeFood=FOOD_WORDS.some(hasStem);
      const mode=looksLikeFood?"chat":((looksLikePlan||workoutPlan)?"plan":"chat");
      const body=JSON.stringify({question,tg_id:tgId,session_id:sessionId,mode});

      // Ответ целиком приходит за 13–18 секунд, и всё это время экран был пуст.
      // Берём потоком: первые слова появляются примерно через полторы секунды.
      // Если поток не завёлся и наружу ещё ничего не ушло — тихо откатываемся
      // на обычный запрос, человек разницы не замечает.
      let streamed="", gotAnything=false;
      try{
        const res=await fetch(`${API}/ai/ask-stream`,{method:"POST",
          headers:{"Content-Type":"application/json"},body});
        if(!res.ok||!res.body)throw new Error("stream unavailable");
        const reader=res.body.getReader(), dec=new TextDecoder();
        let buf="", lastPaint=0;
        for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          buf+=dec.decode(value,{stream:true});
          let nl;
          while((nl=buf.indexOf("\n\n"))>=0){
            const line=buf.slice(0,nl); buf=buf.slice(nl+2);
            if(!line.startsWith("data:"))continue;
            let ev; try{ev=JSON.parse(line.slice(5));}catch{continue;}
            if(ev.type==="delta"){
              streamed+=ev.text; gotAnything=true;
              // Не перерисовываем на каждый токен — текст идёт мелкими кусками,
              // а стейт обновляется чаще, чем экран успевает это показать.
              const now=Date.now();
              if(now-lastPaint>80){lastPaint=now;setStreamText(streamed);}
            }else if(ev.type==="done"){
              setStreamText("");
              applyAnswer(ev);
              return;
            }else if(ev.type==="error"){
              setStreamText("");
              if(ev.status===429){setLimitHit(true);setAnswer(t("limit_exceeded"));return;}
              if(ev.status===451){setAiBlocked(true);return;}
              // Anthropic недоступен: повтор обычным запросом упрётся в то же самое
              if(ev.status===503&&!gotAnything){setAnswer(t("ai_unavailable"));return;}
              throw new Error(`stream error ${ev.status}`);
            }
          }
        }
        // Поток кончился без события done — ответ недополучен
        throw new Error("stream ended early");
      }catch(streamErr){
        setStreamText("");
        if(gotAnything){
          // Часть текста человек уже прочитал. Повторять запрос нельзя — он
          // спишет лимит и выдаст второй ответ. Оставляем что пришло.
          const aiAnswer=streamed||t("no_answer");
          setAnswer(aiAnswer);
          setChatHistory(prev=>[...prev,{role:"assistant",content:aiAnswer,
            time:new Date().toLocaleTimeString(dateLocale(),{hour:"2-digit",minute:"2-digit"})}]);
          return;
        }
        // Ничего не отдали — спокойно повторяем обычным запросом
        const res=await fetch(`${API}/ai/ask`,{method:"POST",
          headers:{"Content-Type":"application/json"},body});
        if(res.status===429){setLimitHit(true);setAnswer(t("limit_exceeded"));return;}
        if(res.status===451){setAiBlocked(true);return;}
        if(res.status===503){setAnswer(t("ai_unavailable"));return;}
        if(!res.ok){
          const err=await res.text().catch(()=>"");
          setAnswer(t("err_server_retry").replace("{code}",res.status+(err?" — "+err.slice(0,100):"")));
          return;
        }
        applyAnswer(await res.json());
      }
    }catch(e){
      setStreamText("");
      const errMsg=t("ai_oshibka_soedineniya")+" "+e.message;
      setAnswer(errMsg);
      setChatHistory(prev=>[...prev,{role:"assistant",content:errMsg,time:""}]);
    }
    finally{setLoading(false);}
  }

  /** Разбор итогового ответа — общий для потока и обычного запроса. */
  function applyAnswer(d){
    const aiAnswer=d.answer||t("no_answer");
    setAnswer(aiAnswer);
    if(d.workout_plan){
      setWorkoutPlan(d.workout_plan);
      try{localStorage.setItem("gymbot_ai_plan",JSON.stringify({sessionId,plan:d.workout_plan}));}catch{}
    }
    setChatHistory(prev=>[...prev,{role:"assistant",content:aiAnswer,
      time:new Date().toLocaleTimeString(dateLocale(),{hour:"2-digit",minute:"2-digit"})}]);
    // Попросил сохранить словами в чате — открываем выбор даты сами.
    // Сохранять модель не умеет, раньше она просто отвечала «сохранил», и человек
    // не находил тренировку в запланированных.
    if(d.save_requested&&(d.workout_plan||workoutPlan))setShowDatePicker(true);
  }

  function clearHistory(){
    setChatHistory([]);
    setAnswer(null);setWorkoutPlan(null);setSaved(false);
    if(tgId)fetch(`${API}/ai/history/${tgId}?session_id=${sessionId}`,{method:"DELETE"}).catch(()=>{});
    // Начинаем новую сессию: иначе сохранённый в localStorage id вернул бы
    // очищенный диалог обратно при следующем входе на экран.
    const id=`session_${tgId}_${Date.now()}`;
    try{
      localStorage.setItem("gymbot_ai_session",JSON.stringify({id,tgId,ts:Date.now()}));
      localStorage.removeItem("gymbot_ai_plan");
    }catch{}
    setSessionId(id);
  }

  async function saveWorkoutPlan(){
    if(!workoutPlan||!tgId)return;
    setShowDatePicker(true);
  }

  async function confirmSaveWorkoutPlan(){
    setShowDatePicker(false);
    setSaving(true);
    try{
      // Конвертируем названия упражнений в ID из каталога
      const exNames = workoutPlan.exercises||[];
      const exIds = exNames.map(name=>{
        const nameLow = name.toLowerCase().trim();
        // Сначала точное совпадение
        let found = (exercises||[]).find(e=>e.name.toLowerCase().trim()===nameLow);
        // Потом частичное — каталог содержит название AI или наоборот
        if(!found) found = (exercises||[]).find(e=>
          e.name.toLowerCase().includes(nameLow) || nameLow.includes(e.name.toLowerCase())
        );
        // Потом по ключевым словам (первые 2 слова)
        if(!found){
          const words = nameLow.split(" ").filter(w=>w.length>3).slice(0,2);
          if(words.length>0) found = (exercises||[]).find(e=>
            words.every(w=>e.name.toLowerCase().includes(w))
          );
        }
        return found?.id||null;
      }).filter(Boolean);

      // Сохраняем в запланированные — выбранная дата и время
      const dt=`${planDate}T${planTime}`;
      const res=await fetch(`${API}/planned/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({title:workoutPlan.title||t("ai_ai_trenirovka"),planned_datetime:dt,
          exercise_ids:exIds,
          exercise_names:workoutPlan.exercises||[],
          exercise_tips:workoutPlan.tips||null,
          ai_plan_text:answer||null})});
      if(res.ok){
        setSaved(true);setWorkoutPlan(null);
        // Сохранили — убираем черновик, иначе кнопка вернётся при следующем входе
        try{localStorage.removeItem("gymbot_ai_plan");}catch{}
      }
      else setSaving(false);
    }catch{setSaving(false);}
    finally{setSaving(false);}
  }

  return <div style={{padding:"16px 16px 160px"}}>
    <Kicker>{t("ai_trainer_title")}</Kicker><Hero>{t("ai_trainer_online")}</Hero>
    <div style={{color:C.muted,fontSize:13,marginTop:6,marginBottom:16,fontFamily:"monospace"}}>{t("requests_left")} <Mono size={13}>{requestsLeft}</Mono></div>
    {/* История чата */}
    {chatHistory.length>0&&<div style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <Kicker>{t("ai_chat_title")}</Kicker>
        <button onClick={clearHistory} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:6,padding:"3px 10px",color:C.muted,fontSize:11,cursor:"pointer",fontFamily:"monospace"}}>
          {t("ai_clear")}
        </button>
      </div>
      {aiBlocked&&<Card style={{marginBottom:10,border:`0.5px solid ${C.danger}`}} pad="14px 16px">
        <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
          <span style={{fontSize:18}}>🔒</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,color:C.text,lineHeight:1.55}}>{t("ai_consent_needed")}</div>
            <Btn accent full onClick={()=>onNav&&onNav("profile")} style={{marginTop:12}}>
              {t("ai_consent_btn")}
            </Btn>
          </div>
        </div>
      </Card>}

      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {chatHistory.map((msg,i)=>(
          <div key={i} style={{display:"flex",flexDirection:"column",alignItems:msg.role==="user"?"flex-end":"flex-start"}}>
            <div style={{
              maxWidth:"85%",padding:"10px 14px",borderRadius:12,
              background:msg.role==="user"?"rgba(200,255,0,0.12)":C.card,
              border:`0.5px solid ${msg.role==="user"?C.accent:C.border}`,
            }}>
              {msg.role==="assistant"&&<div style={{fontSize:10,color:C.accent,fontFamily:"monospace",marginBottom:4}}>{t("ai_coach_label")}</div>}
              <div style={{fontSize:13,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{msg.content}</div>
              {msg.time&&<div style={{fontSize:10,color:C.muted,marginTop:4,textAlign:"right"}}>{msg.time}</div>}
            </div>
          </div>
        ))}
        {/* Ответ печатается на глазах. Пока не пришло ни слова — прежняя заглушка. */}
        {loading&&streamText&&<div style={{display:"flex",alignItems:"flex-start"}}>
          <div style={{maxWidth:"85%",padding:"10px 14px",borderRadius:12,background:C.card,border:`0.5px solid ${C.border}`}}>
            <div style={{fontSize:10,color:C.accent,fontFamily:"monospace",marginBottom:4}}>{t("ai_coach_label")}</div>
            <div style={{fontSize:13,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap"}}>
              {streamText}<span style={{color:C.accent}}>▍</span>
            </div>
          </div>
        </div>}
        {loading&&!streamText&&<div style={{display:"flex",alignItems:"flex-start"}}>
          <div style={{padding:"10px 14px",borderRadius:12,background:C.card,border:`0.5px solid ${C.border}`}}>
            <div style={{color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:2}}>{t("ai_thinking2")}</div>
          </div>
        </div>}
      </div>
    </div>}

    {limitHit&&<PremiumNudge tgId={tgId} kind="ai" onNav={onNav} style={{marginBottom:12}}/>}

    {/* Быстрые вопросы — только если нет истории */}
    {chatHistory.length===0&&<div style={{marginBottom:8}}>
      <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("quick_questions")}</div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {suggs.map((s,i)=><button key={i} onClick={()=>{setQ(s);ask(s);}}
          style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,cursor:"pointer",textAlign:"left"}}>{s} →</button>)}
      </div>
    </div>}

    {/* Фиксированный блок ввода внизу */}
    <div style={{position:"fixed",bottom:"calc(60px + env(safe-area-inset-bottom))",left:0,right:0,background:C.surface,borderTop:`0.5px solid ${C.border}`,padding:"10px 12px",zIndex:50}}>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
        <VoiceRecorder tgId={tgId} disabled={loading} onTranscribed={text=>setQ(prev=>prev?prev+" "+text:text)}/>
        <div style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,display:"flex",alignItems:"flex-end"}}>
          <textarea ref={qTaRef} value={q} rows={1}
            onChange={e=>{
              setQ(e.target.value);
              const el=e.target;
              el.style.height="auto";
              el.style.height=Math.min(el.scrollHeight,120)+"px";
            }}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();ask(q);if(qTaRef.current){qTaRef.current.style.height="auto";}}}}
            placeholder={t("ai_sprosi_chto_ugodno")} style={{flex:1,background:"none",border:"none",padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",resize:"none",maxHeight:120,lineHeight:1.4}}/>
          <button onClick={()=>{ask(q);if(qTaRef.current){qTaRef.current.style.height="auto";}}} disabled={loading||!q.trim()}
            style={{background:C.accent,border:"none",borderRadius:"0 8px 8px 0",padding:"10px 16px",color:C.bg,fontWeight:700,fontSize:14,cursor:"pointer",opacity:loading||!q.trim()?0.5:1,alignSelf:"stretch"}}>→</button>
        </div>
      </div>
      <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",textAlign:"center"}}>{t("voice_hint")}</div>
    </div>

        {/* Блок сохранения тренировки */}
    {workoutPlan&&!saved&&(
      <div style={{marginBottom:12,padding:"12px 14px",background:"#C8FF0015",border:`0.5px solid ${C.accent}`,borderRadius:10}}>
        <div style={{fontSize:12,color:C.accent,fontFamily:"monospace",marginBottom:6}}>{t("ai_proposes")}</div>
        <div style={{fontSize:14,fontWeight:600,color:C.text,marginBottom:4}}>{workoutPlan.title}</div>
        {workoutPlan.exercises?.length>0&&(
          <div style={{fontSize:12,color:C.muted,marginBottom:6}}>{workoutPlan.exercises.slice(0,5).join(", ")}{workoutPlan.exercises.length>5?` ${t("ai_plan_more").replace("{n}",workoutPlan.exercises.length-5)}`:""}</div>
        )}
        {workoutPlan.exercises?.length>0&&exercises?.length>0&&(()=>{
          const matched=workoutPlan.exercises.filter(name=>{
            const nameLow=name.toLowerCase().trim();
            return exercises.find(e=>e.name.toLowerCase().trim()===nameLow||e.name.toLowerCase().includes(nameLow)||nameLow.includes(e.name.toLowerCase()));
          });
          return matched.length<workoutPlan.exercises.length?(
            <div style={{fontSize:11,color:C.warn,fontFamily:"monospace",marginBottom:6}}>
              {t("ui_naydeno_v_kataloge")} {matched.length}/{workoutPlan.exercises.length}
            </div>
          ):null;
        })()}
        <Btn accent full onClick={saveWorkoutPlan} disabled={saving}>
          {saving?t("saving"):t("ai_save_plan")}
        </Btn>
        <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",textAlign:"center",marginTop:6}}>{t("ai_date_hint")}</div>
      </div>
    )}
    {saved&&<div style={{marginBottom:12,background:"#00CC6622",border:`0.5px solid ${C.success}`,borderRadius:10,padding:"10px 14px",fontSize:12,color:C.success,fontFamily:"monospace"}}>{t("workout_saved_tab")}</div>}
    {saved&&<button onClick={()=>onNav&&onNav("my_workouts")} style={{width:"100%",marginBottom:12,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 16px",color:C.text,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>
      {t("open_schedule")}
    </button>}
    {showDatePicker&&(
      <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.7)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
        <div style={{background:C.surface,borderRadius:16,padding:20,width:"100%",maxWidth:360}}>
          <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:16,fontFamily:"monospace"}}>{t("when_workout2")}</div>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:6}}>{t("sport_date")}</div>
            <input type="date" value={planDate} min={localToday()}
              onChange={e=>setPlanDate(e.target.value)}
              style={{colorScheme:"dark",width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.accent,fontSize:16,fontFamily:"monospace",outline:"none"}}/>
          </div>
          <div style={{marginBottom:20}}>
            <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:6}}>{t("time_label2")}</div>
            <input type="time" value={planTime}
              onChange={e=>setPlanTime(e.target.value)}
              style={{colorScheme:"dark",width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.accent,fontSize:16,fontFamily:"monospace",outline:"none"}}/>
          </div>
          <div style={{display:"flex",gap:10}}>
            <Btn full onClick={()=>setShowDatePicker(false)} style={{flex:1}}>{t("cancel_btn2")}</Btn>
            <Btn accent full onClick={confirmSaveWorkoutPlan} style={{flex:2}}>{t("save_confirm")}</Btn>
          </div>
        </div>
      </div>
    )}
  </div>;
}

// ─── FOOD VISION ─────────────────────────────────────────────────────────────



const CROP_SIZE=320; // размер квадратной рамки кадрирования на экране (px)
const CROP_OUTPUT=800; // размер итогового изображения, отправляемого на анализ (px)

function FoodVisionScreen({tgId,onBack,mealType,onNav}){
  const [rawFile,setRawFile]=useState(null); // исходный File до кадрирования
  const [photo,setPhoto]=useState(null); // base64 после кадрирования — то, что уходит на анализ
  const [preview,setPreview]=useState(null); // base64 после кадрирования — превью
  const [result,setResult]=useState(null);
  const [loading,setLoading]=useState(false);
  const [saved,setSaved]=useState(false);
  const [error,setError]=useState(null);
  const [editing,setEditing]=useState(false);
  const [editText,setEditText]=useState("");
  const [recalculating,setRecalculating]=useState(false);
  const [quota,setQuota]=useState(null);   // {used, limit} — распознаваний за сегодня
  const [foodLimitHit,setFoodLimitHit]=useState(false);
  const inputRef=useRef(null);
  useEffect(()=>{
    if(!tgId)return;
    fetch(`${API}/food/quota/${tgId}`).then(r=>r.ok?r.json():null).then(q=>{if(q&&q.limit!=null)setQuota(q);}).catch(()=>{});
  },[tgId]);

  // ── Кадрирование ──────────────────────────────────────────────────────────
  const [cropping,setCropping]=useState(false);
  const [cropImg,setCropImg]=useState(null); // HTMLImageElement
  const [zoom,setZoom]=useState(1); // множитель поверх базового scale (cover)
  const [offset,setOffset]=useState({x:0,y:0}); // смещение центра изображения относительно рамки
  const canvasRef=useRef(null);
  const dragRef=useRef(null); // {startX,startY,startOffX,startOffY}

  function baseScale(img){
    // Минимальный scale, при котором изображение полностью покрывает квадратную рамку
    return Math.max(CROP_SIZE/img.naturalWidth, CROP_SIZE/img.naturalHeight);
  }

  function handleFile(file){
    if(!file)return;
    setResult(null);setSaved(false);setError(null);
    setRawFile(file);
    const img=new Image();
    img.onload=()=>{
      setCropImg(img);
      setZoom(1);
      setOffset({x:0,y:0});
      setCropping(true);
    };
    img.src=URL.createObjectURL(file);
  }

  // Перерисовываем canvas кадрирования при любом изменении зума/смещения/картинки
  useEffect(()=>{
    if(!cropping||!cropImg||!canvasRef.current)return;
    const canvas=canvasRef.current;
    canvas.width=CROP_SIZE;canvas.height=CROP_SIZE;
    const ctx=canvas.getContext("2d");
    ctx.clearRect(0,0,CROP_SIZE,CROP_SIZE);
    const scale=baseScale(cropImg)*zoom;
    const w=cropImg.naturalWidth*scale, h=cropImg.naturalHeight*scale;
    const cx=CROP_SIZE/2+offset.x, cy=CROP_SIZE/2+offset.y;
    ctx.drawImage(cropImg, cx-w/2, cy-h/2, w, h);
  },[cropping,cropImg,zoom,offset]);

  function clampOffset(next,z){
    if(!cropImg)return next;
    const scale=baseScale(cropImg)*z;
    const w=cropImg.naturalWidth*scale, h=cropImg.naturalHeight*scale;
    const maxX=Math.max(0,(w-CROP_SIZE)/2), maxY=Math.max(0,(h-CROP_SIZE)/2);
    return {x:Math.max(-maxX,Math.min(maxX,next.x)), y:Math.max(-maxY,Math.min(maxY,next.y))};
  }

  function onDragStart(e){
    const p=e.touches?e.touches[0]:e;
    dragRef.current={startX:p.clientX,startY:p.clientY,startOffX:offset.x,startOffY:offset.y};
  }
  function onDragMove(e){
    if(!dragRef.current)return;
    const p=e.touches?e.touches[0]:e;
    const dx=p.clientX-dragRef.current.startX, dy=p.clientY-dragRef.current.startY;
    setOffset(clampOffset({x:dragRef.current.startOffX+dx,y:dragRef.current.startOffY+dy},zoom));
  }
  function onDragEnd(){dragRef.current=null;}

  function confirmCrop(){
    if(!cropImg)return;
    const out=document.createElement("canvas");
    out.width=CROP_OUTPUT;out.height=CROP_OUTPUT;
    const ctx=out.getContext("2d");
    const scale=baseScale(cropImg)*zoom*(CROP_OUTPUT/CROP_SIZE);
    const w=cropImg.naturalWidth*scale, h=cropImg.naturalHeight*scale;
    const cx=CROP_OUTPUT/2+offset.x*(CROP_OUTPUT/CROP_SIZE), cy=CROP_OUTPUT/2+offset.y*(CROP_OUTPUT/CROP_SIZE);
    ctx.drawImage(cropImg, cx-w/2, cy-h/2, w, h);
    const dataUrl=out.toDataURL("image/jpeg",0.88);
    setPreview(dataUrl);
    setPhoto(dataUrl.split(",")[1]);
    setCropping(false);
  }

  function recropCurrentPhoto(){
    // Вернуться к кадрированию того же файла (кнопка "Другое фото" открывает выбор нового файла отдельно)
    if(!rawFile)return;
    const img=new Image();
    img.onload=()=>{setCropImg(img);setZoom(1);setOffset({x:0,y:0});setCropping(true);};
    img.src=URL.createObjectURL(rawFile);
  }

  async function analyze(){
    if(!photo)return;
    setLoading(true);setError(null);
    try{
      const res=await fetch(`${API}/food/analyze`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({image_base64:photo,tg_id:tgId,save:false})});
      if(res.status===429){
        // Лимит на сегодня: сервер говорит, сколько можно, — показываем это, а не «не удалось»
        let q=null;try{q=(await res.json())?.detail;}catch{}
        if(q&&q.limit!=null)setQuota({used:q.used,limit:q.limit});
        setError(t("food_limit_reached").replace("{limit}",q?.limit??""));
        setFoodLimitHit(true);
        return;
      }
      if(!res.ok)throw new Error(res.status);
      const d=await res.json();
      if(d?.quota)setQuota(d.quota);
      setResult(d);
    }catch(e){setError(e?.message==="503"?t("ai_unavailable"):t("failed_recognize"));}
    finally{setLoading(false);}
  }

  async function saveToLog(){
    if(!result)return;
    setLoading(true);setError(null);
    try{
      // Сохраняем то, что реально показано в result (включая правки после пересчёта),
      // а не заново анализируем фото — иначе правка потеряется при сохранении.
      const res=await fetch(`${API}/nutrition/${tgId}`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({meal_name:result.dish_name||t("fv_blyudo"),kcal:Number(result.calories)||0,
          protein:Number(result.protein_g)||0,fat:Number(result.fat_g)||0,carb:Number(result.carbs_g)||0,
          meal_type:mealType||null})});
      if(!res.ok){
        let detail="";
        try{const j=await res.json();detail=j.detail||"";}catch{}
        throw new Error(`HTTP ${res.status}${detail?": "+detail:""}`);
      }
      setSaved(true);
    }catch(e){
      setError(t("err_save_failed").replace("{err}",e.message||t("fv_neizvestnaya_oshibka")));
    }finally{setLoading(false);}
  }

  async function recalcNutrition(){
    if(!editText.trim())return;
    setRecalculating(true);setError(null);
    try{
      const res=await fetch(`${API}/food/recalc`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({description:editText,weight_g:result?.weight_g||300})});
      if(!res.ok)throw new Error(res.status);
      const newResult=await res.json();
      setResult(newResult);
      setEditing(false);setEditText("");
    }catch(e){setError(e?.message==="503"?t("ai_unavailable"):t("fv_ne_udalos_pereschitat_poprob"));}
    finally{setRecalculating(false);}
  }

  const confColor={"high":C.success,"medium":C.warn,"low":C.danger};
  const confLabel={"high":t("fv_vysokaya"),"medium":t("fv_srednyaya"),"low":t("fv_nizkaya")};

  return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={onBack}/>
      <Kicker>{t("ai_nutrition_title")}</Kicker>
      <Hero>{t("photo_kbju_title2")}</Hero>
      {onNav&&<div style={{display:"flex",gap:6,marginTop:10}}>
        <span style={{padding:"6px 14px",borderRadius:16,fontSize:12,fontFamily:"monospace",background:C.accent,color:C.bg}}>{t("fv_mode_dish")}</span>
        <span onClick={()=>onNav("label_scan",{meal_type:mealType})} style={{padding:"6px 14px",borderRadius:16,fontSize:12,cursor:"pointer",
          fontFamily:"monospace",border:`0.5px solid ${C.border}`,color:C.muted}}>🏷 {t("fv_mode_label")}</span>
      </div>}
      <div style={{color:C.muted,fontSize:13,marginTop:4,marginBottom:20}}>{t("photo_kbju_hint")}</div>
      <input ref={inputRef} type="file" accept="image/*"
        onChange={e=>{handleFile(e.target.files[0]);e.target.value="";}} style={{display:"none"}}/>
      {cropping?(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:12,color:C.muted,marginBottom:8,textAlign:"center"}}>
            {t("ui_peremeschay_i_uvelichivay_chto")}
          </div>
          <div style={{display:"flex",justifyContent:"center",marginBottom:12}}>
            <canvas ref={canvasRef} width={CROP_SIZE} height={CROP_SIZE}
              style={{borderRadius:12,border:`0.5px solid ${C.border}`,touchAction:"none",cursor:"grab"}}
              onMouseDown={onDragStart} onMouseMove={onDragMove} onMouseUp={onDragEnd} onMouseLeave={onDragEnd}
              onTouchStart={onDragStart} onTouchMove={onDragMove} onTouchEnd={onDragEnd}/>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,padding:"0 4px"}}>
            <span style={{fontSize:16}}>🔍</span>
            <input type="range" min="1" max="3" step="0.05" value={zoom}
              onChange={e=>{const z=parseFloat(e.target.value);setZoom(z);setOffset(o=>clampOffset(o,z));}}
              style={{flex:1,accentColor:C.accent}}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn full onClick={()=>{setCropping(false);if(!preview){setRawFile(null);}}} style={{flex:1}}>{t("fv_otmena")}</Btn>
            <Btn accent full onClick={confirmCrop} style={{flex:2}}>{t("fv_gotovo")}</Btn>
          </div>
        </div>
      ):!preview?(
        <div onClick={()=>inputRef.current?.click()}
          style={{border:`2px dashed ${C.border}`,borderRadius:16,padding:"48px 20px",
            textAlign:"center",cursor:"pointer",marginBottom:16}}>
          <div style={{fontSize:52,marginBottom:10}}>📷</div>
          <Btn accent full style={{pointerEvents:"none",fontSize:15}}>{t("add_photo_btn")}</Btn>
        </div>
      ):(
        <div style={{marginBottom:16}}>
          <img src={preview} alt="food" style={{width:"100%",borderRadius:12,maxHeight:280,objectFit:"contain",background:C.bg,marginBottom:10}}/>
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <Btn full onClick={()=>inputRef.current?.click()} style={{flex:1}}>{t("other_photo2")}</Btn>
            {!result&&!loading&&<Btn accent full onClick={analyze} style={{flex:2}}>{t("analyze_btn2")}</Btn>}
          </div>
          {!result&&!loading&&<Btn full onClick={recropCurrentPhoto}>{t("fv_perekadrirovat")}</Btn>}
          {quota&&!result&&<div style={{fontSize:11,color:C.muted,textAlign:"center",marginTop:8,fontFamily:"monospace"}}>
            {t("food_quota_left").replace("{left}",Math.max(0,quota.limit-quota.used)).replace("{limit}",quota.limit)}</div>}
        </div>
      )}
      {loading&&<Card><div style={{textAlign:"center",padding:"16px 0",color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:2}}>{t("analyzing_photo2")}</div></Card>}
      {error&&(
        <Card>
          <div style={{color:C.danger,fontSize:13,textAlign:"center",padding:"8px 0",marginBottom:result?8:0}}>{error}</div>
          {foodLimitHit&&<PremiumNudge tgId={tgId} kind="food" onNav={onNav} style={{marginTop:4}}/>}
          {result&&!saved&&(
            <Btn accent full onClick={saveToLog} disabled={loading}>
              {loading?t("fv_povtoryaem"):t("fv_povtorit_sohranenie")}
            </Btn>
          )}
        </Card>
      )}
      {result&&!loading&&(
        <Fragment>
          <Card accent style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div>
                <div style={{fontSize:16,fontWeight:700,color:C.text}}>{result.dish_name}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:2}}>~{result.weight_g} {t("u_g")}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:24,fontWeight:700,color:C.accent}}>{result.calories}</div>
                <div style={{fontSize:11,color:C.muted}}>{t("kcal_short")}</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
              {[{l:t("proteins_label"),v:result.protein_g},{l:t("fats_label"),v:result.fat_g},{l:t("carbs_label"),v:result.carbs_g}].map((m,i)=>(
                <div key={i} style={{textAlign:"center",background:C.bg,borderRadius:8,padding:"8px 4px"}}>
                  <div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{m.l}</div>
                  <Mono size={15}>{m.v} {t("u_g")}</Mono>
                </div>
              ))}
            </div>
            <div style={{fontSize:11,color:confColor[result.confidence]||C.muted,fontFamily:"monospace"}}>
              {t("ui_tochnost")} {confLabel[result.confidence]||result.confidence}
            </div>
            {result.note&&<div style={{fontSize:12,color:C.muted,marginTop:6}}>{result.note}</div>}
          </Card>
          {editing&&(
            <Card style={{marginBottom:12}}>
              <div style={{fontSize:12,color:C.muted,marginBottom:8}}>
                {t("ui_napishi_pravilnoe_nazvanie_ili")}
              </div>
              <input value={editText} onChange={e=>setEditText(e.target.value)}
                placeholder={t("fv_naprimer_risovaya_kasha_s")}
                style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
                  padding:"10px 12px",color:C.text,fontSize:13,outline:"none",marginBottom:10}}/>
              <div style={{display:"flex",gap:8}}>
                <Btn full onClick={()=>{setEditing(false);setEditText("");}} style={{flex:1}}>{t("fv_otmena")}</Btn>
                <Btn accent full onClick={recalcNutrition} disabled={recalculating||!editText.trim()} style={{flex:2}}>
                  {recalculating?t("fv_pereschityvaem"):t("fv_pereschitat")}
                </Btn>
              </div>
            </Card>
          )}
          {saved?(
            <div style={{background:"#00CC6622",border:`0.5px solid ${C.success}`,borderRadius:10,
              padding:"12px",fontSize:13,color:C.success,fontFamily:"monospace",textAlign:"center"}}>
              {t("saved_to_diary")}
            </div>
          ):!editing&&(
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              <div style={{display:"flex",gap:8}}>
                <Btn full onClick={()=>{setResult(null);setPreview(null);setPhoto(null);}} style={{flex:1}}>{t("new_photo")}</Btn>
                <Btn accent full onClick={saveToLog} disabled={loading} style={{flex:2}}>
                  {loading?t("saving"):t("add_to_diary2")}
                </Btn>
              </div>
              <Btn full onClick={()=>{setEditing(true);setEditText("");}}>{t("fv_ispravit")}</Btn>
            </div>
          )}
        </Fragment>
      )}
    </div>
  );
}

// ─── NUTRITION ────────────────────────────────────────────────────────────────

function NutritionScreen({tgId,onBack,onNav}){
  const MEALS=[{type:"breakfast",label:t("meal_breakfast"),icon:"🌅"},{type:"lunch",label:t("meal_lunch"),icon:"☀️"},{type:"dinner",label:t("meal_dinner"),icon:"🌙"},{type:"snack",label:t("meal_snack"),icon:"🍎"}];
  const [data,setData]=useState(null);
  const [error,setError]=useState(null);
  // Дата по местному времени — сервер теперь тоже делит питание на сутки по UTC+5.
  // Раньше обе стороны жили по UTC, и с полуночи до пяти утра «сегодня» было вчера.
  const [viewDate,setViewDate]=useState(()=>localToday());
  const [adding,setAdding]=useState(null);
  const [saving,setSaving]=useState(false);
  const [form,setForm]=useState({meal_name:"",kcal:"",protein:"",fat:"",carb:""});
  const [glasses,setGlasses]=useState(0);
  const [aiOpen,setAiOpen]=useState(false);
  const [aiQ,setAiQ]=useState("");
  const [aiAnswer,setAiAnswer]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const [editingLog,setEditingLog]=useState(null);
  const [editLogText,setEditLogText]=useState("");
  const [editLogWeight,setEditLogWeight]=useState(300);
  const [editLogBusy,setEditLogBusy]=useState(false);
  const isToday=viewDate===localToday();

  // Норма воды: вес(кг) * 30мл / 250мл = стаканов (мин 6, макс 12)
  const waterGoal=data?.water_norm_glasses||8;

  function load(){
    if(!tgId)return;
    const url=isToday?`${API}/nutrition/${tgId}`:`${API}/nutrition/${tgId}/history?date=${viewDate}`;
    fetch(url).then(r=>r.json()).then(d=>{setData(d);const w=(d.today_logs||d.logs||[]).find(l=>l.meal_type==="water");setGlasses(w?.kcal||0);}).catch(()=>setError(t("error_load")));
  }
  useEffect(()=>{setData(null);load();},[viewDate]);

  async function askAI(){
    if(!aiQ.trim())return;
    setAiLoading(true);setAiAnswer(null);
    try{
      // Формируем контекст питания за день
      const logs=data?.today_logs||[];
      const totals=data?.today_totals||{};
      const logSummary=logs.filter(l=>l.meal_type!=="water").map(l=>`${l.meal_name}(${l.kcal}ккал Б${l.protein}г Ж${l.fat}г У${l.carb}г)`).join(", ");
      const nutritionCtx=logSummary?`\n\nПитание пользователя сегодня: ${logSummary}. Итого: ${totals.kcal||0}ккал, Б${totals.protein||0}г, Ж${totals.fat||0}г, У${totals.carb||0}г. Цель: ${data?.target_kcal||2000}ккал.`:"\n\nПользователь ещё ничего не ел сегодня.";
      const question=aiQ+nutritionCtx;
      // mode:"chat" — вопрос про питание. Без него слово «план» в вопросе («составь
      // план питания») включало схему тренировочного плана и портило ответ.
      const res=await fetch(`${API}/ai/ask`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tg_id:tgId,question,mode:"chat"})});
      if(res.status===503){setAiAnswer(t("ai_unavailable"));return;}
      const d=await res.json();
      if(res.status===429){setAiAnswer(t("nut_limit_ai_zaprosov_na"));}
      else{setAiAnswer(d.answer||t("no_answer"));}
    }catch{setAiAnswer(t("error_request"));}
    finally{setAiLoading(false);}
  }

  const logs=data?.today_logs||data?.logs||[];
  const totals=data?.today_totals||data?.totals||{};
  function logsFor(type){return logs.filter(l=>l.meal_type===type);}
  function totalFor(type){const ls=logsFor(type);return{kcal:ls.reduce((s,l)=>s+(l.kcal||0),0),protein:ls.reduce((s,l)=>s+(l.protein||0),0),fat:ls.reduce((s,l)=>s+(l.fat||0),0),carb:ls.reduce((s,l)=>s+(l.carb||0),0)};}

  async function addMeal(){
    if(!form.meal_name.trim()||!form.kcal||!adding)return;
    setSaving(true);
    try{const res=await fetch(`${API}/nutrition/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({meal_name:form.meal_name,kcal:parseFloat(form.kcal)||0,protein:parseFloat(form.protein)||0,fat:parseFloat(form.fat)||0,carb:parseFloat(form.carb)||0,meal_type:adding})});if(res.ok){setAdding(null);setForm({meal_name:"",kcal:"",protein:"",fat:"",carb:""});setData(null);load();}}catch{}finally{setSaving(false);}
  }

  async function deleteLog(logId){if(!tgId||!logId)return;try{await fetch(`${API}/nutrition/${tgId}/${logId}`,{method:"DELETE"});setData(null);load();}catch{}}

  async function recalcAndUpdateLog(logId){
    if(!editLogText.trim())return;
    setEditLogBusy(true);
    try{
      const res=await fetch(`${API}/food/recalc`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({description:editLogText,weight_g:editLogWeight||300})});
      if(res.status===503)throw new Error(t("ai_unavailable"));
      if(!res.ok)throw new Error(`recalc HTTP ${res.status}`);
      const r=await res.json();
      const putRes=await fetch(`${API}/nutrition/${tgId}/${logId}`,{method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({meal_name:r.dish_name||t("fv_blyudo"),kcal:Number(r.calories)||0,
          protein:Number(r.protein_g)||0,fat:Number(r.fat_g)||0,carb:Number(r.carbs_g)||0})});
      if(!putRes.ok)throw new Error(`update HTTP ${putRes.status}`);
      setEditingLog(null);setEditLogText("");setData(null);load();
    }catch(e){alert(t("err_save_failed").replace("{err}",e.message||t("nut_oshibka")));}
    finally{setEditLogBusy(false);}
  }

  async function setWater(g){setGlasses(g);try{await fetch(`${API}/nutrition/${tgId}/water`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({glasses:g})});}catch{}}

  if(error)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Card><div style={{color:C.danger,fontSize:13}}>{error}</div></Card></div>;
  if(!data)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("nut_pitanie")}/></div>;

  const pct=Math.min(100,Math.round(((totals.kcal||0)/Math.max(data.target_kcal||2000,1))*100));

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("menu_nutrition")}</Kicker><Hero>{t("nutrition_title")}</Hero>

    <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,marginBottom:16}}>
      <button onClick={()=>setViewDate(shiftDay(viewDate,-1))} style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"6px 14px",color:C.text,cursor:"pointer",fontSize:16}}>‹</button>
      <div style={{flex:1,textAlign:"center",fontFamily:"monospace",fontSize:12,color:isToday?C.accent:C.muted}}>{isToday?t("today"):new Date(viewDate+"T12:00:00").toLocaleDateString(dateLocale(),{day:"numeric",month:"short"})}</div>
      {!isToday&&<button onClick={()=>setViewDate(localToday())} style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"6px 14px",color:C.text,cursor:"pointer",fontSize:16}}>›</button>}
    </div>

    <Card accent style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:8}}>
        <Mono>{totals.kcal||0} <span style={{fontSize:13,color:C.muted,fontWeight:400}}>{t("kcal_short")}</span></Mono>
        <span style={{fontFamily:"monospace",fontSize:11,color:C.muted}}>{t("nut_cel")} {data.target_kcal||2000}</span>
      </div>
      <ProgressBar pct={pct}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:10}}>
        {[{l:t("u_prot"),v:totals.protein||0},{l:t("u_fat"),v:totals.fat||0},{l:t("u_carb"),v:totals.carb||0}].map((m,i)=><div key={i} style={{textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{m.l} {t("nut_g")}</div><Mono size={13}>{Math.round(m.v)}</Mono></div>)}
      </div>
    </Card>

    <Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <Kicker>{t("water_label")}</Kicker>
        <span style={{fontFamily:"monospace",fontSize:11,color:C.muted}}>{glasses}/{waterGoal} {t("glasses_unit")} · {waterGoal*250}{t("nut_ml")}</span>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:glasses===0&&isToday?8:0}}>
        {Array.from({length:waterGoal},(_,i)=>(
          <button key={i} onClick={()=>isToday&&setWater(i<glasses?i:i+1)}
            style={{width:36,height:36,borderRadius:8,
              border:`0.5px solid ${i<glasses?"rgba(0,180,255,0.5)":C.border}`,
              background:i<glasses?"rgba(0,180,255,0.25)":"rgba(0,180,255,0.05)",
              fontSize:16,cursor:isToday?"pointer":"default",
              color:i<glasses?"rgba(0,180,255,1)":"rgba(0,180,255,0.3)"}}>
            {i<glasses?"💧":"◯"}
          </button>
        ))}
      </div>
      {glasses===0&&isToday&&<div style={{fontSize:11,color:"rgba(0,180,255,0.5)",fontFamily:"monospace"}}>{t("water_tap_hint")}</div>}
    </Card>

    {MEALS.map(meal=>{
      const ml=logsFor(meal.type);const mt=totalFor(meal.type);
      return<Card key={meal.type} style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:ml.length>0?10:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:20}}>{meal.icon}</span>
            <div>
              <div style={{fontWeight:600,fontSize:14,color:C.text}}>{meal.label}</div>
              {ml.length>0&&<div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{mt.kcal} {t("kcal_unit")} · {t("u_prot")}{Math.round(mt.protein)} {t("u_fat")}{Math.round(mt.fat)} {t("u_carb")}{Math.round(mt.carb)}</div>}
            </div>
          </div>
          {isToday&&<div style={{display:"flex",gap:6}}>
            <button onClick={()=>onNav&&onNav("food_vision",{meal_type:meal.type})} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:8,padding:"5px 8px",color:C.muted,fontSize:13,cursor:"pointer"}}>📷</button>
            <button onClick={()=>onNav&&onNav("food_search",{meal_type:meal.type})} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:8,padding:"5px 8px",color:C.muted,fontSize:13,cursor:"pointer"}}>🔍</button>
            <button onClick={()=>{setAdding(adding===meal.type?null:meal.type);setForm({meal_name:"",kcal:"",protein:"",fat:"",carb:""}); }} style={{background:adding===meal.type?"rgba(200,255,0,0.1)":"none",border:`0.5px solid ${adding===meal.type?C.accent:C.border}`,borderRadius:8,padding:"5px 10px",color:adding===meal.type?C.accent:C.muted,fontSize:12,cursor:"pointer"}}>{adding===meal.type?"✕":t("add_meal")}</button>
          </div>}
        </div>
        {ml.map(l=>(
          <Fragment key={l.id}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderTop:`0.5px solid ${C.border}`}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13,color:C.text}}>{l.meal_name}</div>
              <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginTop:2}}>{t("u_prot")}{l.protein}{t("u_g")} · {t("u_fat")}{l.fat}{t("u_g")} · {t("u_carb")}{l.carb}{t("u_g")}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <Mono size={13}>{l.kcal} <span style={{fontSize:10,color:C.muted,fontWeight:400}}>{t("kcal_short")}</span></Mono>
              {l.id&&isToday&&<button onClick={()=>{setEditingLog(editingLog===l.id?null:l.id);setEditLogText("");setEditLogWeight(300);}} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:6,padding:"2px 7px",color:C.muted,fontSize:11,cursor:"pointer"}}>✏️</button>}
              {l.id&&isToday&&<button onClick={()=>deleteLog(l.id)} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:6,padding:"2px 7px",color:C.danger,fontSize:11,cursor:"pointer"}}>✕</button>}
            </div>
          </div>
          {editingLog===l.id&&(
            <div style={{padding:"8px 0",borderTop:`0.5px solid ${C.border}`}}>
              <div style={{fontSize:11,color:C.muted,marginBottom:6}}>{t("nut_isprav_nazvanie_sostav_kbzhu")}</div>
              <input value={editLogText} onChange={e=>setEditLogText(e.target.value)}
                placeholder={t("nut_naprimer_risovaya_kasha_s")}
                style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 12px",color:C.text,fontSize:13,outline:"none",marginBottom:8}}/>
              <div style={{display:"flex",gap:8}}>
                <Btn full onClick={()=>{setEditingLog(null);setEditLogText("");}} style={{flex:1}}>{t("fv_otmena")}</Btn>
                <Btn accent full onClick={()=>recalcAndUpdateLog(l.id)} disabled={editLogBusy||!editLogText.trim()} style={{flex:2}}>
                  {editLogBusy?t("fv_pereschityvaem"):t("nut_pereschitat_i_sohranit")}
                </Btn>
              </div>
            </div>
          )}
          </Fragment>
        ))}
        {adding===meal.type&&isToday&&<div style={{marginTop:12,paddingTop:12,borderTop:`0.5px solid ${C.border}`}}>
          <input value={form.meal_name} onChange={e=>setForm(p=>({...p,meal_name:e.target.value}))} placeholder={t("dish_name")} style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 12px",color:C.text,fontSize:13,outline:"none",marginBottom:8}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:10}}>
            {[{k:"kcal",p:t("calories_short")},{k:"protein",p:t("nut_belki")},{k:"fat",p:t("nut_zhiry")},{k:"carb",p:t("carbs_short")}].map(f=>(
              <input key={f.k} type="number" value={form[f.k]} onChange={e=>setForm(p=>({...p,[f.k]:e.target.value}))} placeholder={f.p} style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 6px",color:C.text,fontSize:12,outline:"none",textAlign:"center"}}/>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn full onClick={()=>setAdding(null)} style={{flex:1}}>{t("cancel_btn2")}</Btn>
            <Btn accent full onClick={addMeal} disabled={saving||!form.meal_name.trim()||!form.kcal} style={{flex:2}}>{saving?t("saving"):t("add")}</Btn>
          </div>
        </div>}
      </Card>;
    })}

    {isToday&&<Card style={{marginBottom:12}}>
      <button onClick={()=>{setAiOpen(!aiOpen);setAiAnswer(null);setAiQ("");}}
        style={{width:"100%",background:"none",border:"none",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",padding:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:20}}>💬</span>
          <div style={{fontWeight:600,fontSize:14,color:C.text,textAlign:"left"}}>{t("ask_trainer")}</div>
        </div>
        <span style={{color:C.accent,fontSize:16}}>{aiOpen?"∧":"∨"}</span>
      </button>
      {aiOpen&&<div style={{marginTop:12,paddingTop:12,borderTop:`0.5px solid ${C.border}`}}>
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
          <VoiceRecorder tgId={tgId} disabled={aiLoading} onTranscribed={text=>setAiQ(prev=>prev?prev+" "+text:text)}/>
          <div style={{fontSize:11,color:C.muted}}>{t("or_write")}</div>
        </div>
        <textarea value={aiQ} onChange={e=>setAiQ(e.target.value)}
          placeholder={t("nut_naprimer_chto_mne_ne")}
          style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"10px 12px",color:C.text,fontSize:13,outline:"none",resize:"none",
            minHeight:80,fontFamily:"inherit",boxSizing:"border-box",marginBottom:10}}/>
        <Btn accent full onClick={askAI} disabled={aiLoading||!aiQ.trim()}>
          {aiLoading?t("ai_thinking"):t("ai_ask")}
        </Btn>
        {aiAnswer&&<div style={{marginTop:12,padding:"12px 14px",background:C.bg,borderRadius:8,
          border:`0.5px solid ${C.border}`,fontSize:13,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap"}}>
          {aiAnswer}
        </div>}
      </div>}
    </Card>}
  </div>;
}



// ── FoodSearchScreen ─────────────────────────────────────────────────────────
// Название продукта на языке приложения (у местных блюд есть узбекское и казахское)
function foodName(p){
  if(!p)return "";
  const lang=LANG_STORE.current;
  return (lang==="uz"&&p.name_uz)||(lang==="kz"&&p.name_kz)||(lang==="en"&&p.name_en)||p.name;
}

function resizeImage(file,max=1600){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const k=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
      const c=document.createElement("canvas");
      c.width=Math.round(img.naturalWidth*k);c.height=Math.round(img.naturalHeight*k);
      c.getContext("2d").drawImage(img,0,0,c.width,c.height);
      resolve(c.toDataURL("image/jpeg",0.85));
    };
    img.onerror=reject;
    img.src=URL.createObjectURL(file);
  });
}

// ── Сканер этикеток: фото таблицы пищевой ценности → КБЖУ на 100 г ──────────
// Распознавание — общий дневной лимит фото еды. Продукт сохраняется в справочник
// (как свой, до проверки админом), порция — в дневник.
function LabelScanScreen({tgId,onBack,onNav,mealType}){
  const MEAL_OPTS=[
    {value:"breakfast",label:t("meal_breakfast")},{value:"lunch",label:t("meal_lunch")},
    {value:"dinner",label:t("meal_dinner")},{value:"snack",label:t("meal_snack")},
  ];
  const inputRef=useRef(null);
  const [preview,setPreview]=useState(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [limitHit,setLimitHit]=useState(false);
  const [quota,setQuota]=useState(null);
  const [form,setForm]=useState(null);
  const [weight,setWeight]=useState("100");
  const [meal,setMeal]=useState(mealType||"snack");
  const [saving,setSaving]=useState(false);
  const [done,setDone]=useState(null);   // "log" | "only"
  useEffect(()=>{
    if(!tgId)return;
    fetch(`${API}/food/quota/${tgId}`).then(r=>r.ok?r.json():null).then(q=>{if(q&&q.limit!=null)setQuota(q);}).catch(()=>{});
  },[tgId]);

  async function pick(file){
    if(!file)return;
    setError(null);setForm(null);setDone(null);setLimitHit(false);
    try{setPreview(await resizeImage(file));}catch{setError(t("label_failed"));}
  }
  async function read(){
    if(!preview||loading)return;
    setLoading(true);setError(null);
    try{
      const r=await fetch(`${API}/food/label`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({tg_id:tgId,image_base64:preview.split(",")[1]})});
      if(r.status===429){
        let q=null;try{q=(await r.json())?.detail;}catch{}
        if(q&&q.limit!=null)setQuota({used:q.used,limit:q.limit});
        setError(t("food_limit_reached").replace("{limit}",q?.limit??""));setLimitHit(true);return;
      }
      if(!r.ok)throw new Error(r.status);
      const d=await r.json();
      if(d.quota)setQuota(d.quota);
      if(!d.is_label){setError(t("label_not_found"));return;}
      const v=d.per100||{};
      const num=x=>x==null?"":String(x);
      setForm({name:d.name||"",brand:d.brand||"",kcal:num(v.kcal),protein:num(v.protein),fat:num(v.fat),carbs:num(v.carbs),
        fiber:num(v.fiber),category:d.category||"other",serving_g:d.serving_g||null,confidence:d.confidence});
      setWeight(String(d.serving_g||100));
    }catch(e){setError(e?.message==="503"?t("ai_unavailable"):t("label_failed"));}
    finally{setLoading(false);}
  }
  const n=x=>{const v=parseFloat(String(x).replace(",","."));return isFinite(v)&&v>=0?v:0;};
  const w=n(weight);
  const tot=form?{kcal:Math.round(n(form.kcal)*w/100),p:Math.round(n(form.protein)*w/10)/10,
    f:Math.round(n(form.fat)*w/10)/10,c:Math.round(n(form.carbs)*w/10)/10}:null;
  const valid=!!form&&form.name.trim().length>=2&&form.kcal!==""&&n(form.kcal)<=1000;
  async function save(log){
    if(!valid||saving)return;
    setSaving(true);setError(null);
    try{
      const r=await fetch(`${API}/food/label/save`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({tg_id:tgId,name:form.name.trim(),brand:form.brand.trim()||null,kcal:n(form.kcal),
          protein:Math.min(100,n(form.protein)),fat:Math.min(100,n(form.fat)),carbs:Math.min(100,n(form.carbs)),
          fiber:Math.min(100,n(form.fiber)),category:form.category,
          serving_g:form.serving_g||null,weight_g:log&&w>0?w:null,meal_type:log?meal:null})});
      if(!r.ok)throw new Error(r.status);
      setDone(log?"log":"only");haptic.notify("success");
      if(log)setTimeout(()=>{if(onNav)onNav("nutrition",{});else onBack();},1200);
    }catch(e){setError(t("err_save_failed").replace("{err}",e?.message||""));}
    finally{setSaving(false);}
  }
  const field=(k,label,num)=><div style={{flex:1,minWidth:0}}>
    <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{label}</div>
    <input value={form[k]} inputMode={num?"decimal":undefined} onChange={e=>{const v=e.target.value;setForm(f=>({...f,[k]:v}));}}
      style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"9px 8px",color:C.text,
        fontSize:14,outline:"none",boxSizing:"border-box",fontFamily:num?"monospace":"inherit"}}/>
  </div>;

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("label_kicker")}</Kicker>
    <Hero>{t("label_title")}</Hero>
    <div style={{color:C.muted,fontSize:13,marginTop:4,marginBottom:16,lineHeight:1.5}}>{t("label_hint")}</div>
    <input ref={inputRef} type="file" accept="image/*" onChange={e=>{pick(e.target.files[0]);e.target.value="";}} style={{display:"none"}}/>
    {!preview?<div onClick={()=>inputRef.current?.click()} style={{border:`2px dashed ${C.border}`,borderRadius:16,padding:"40px 20px",textAlign:"center",cursor:"pointer",marginBottom:16}}>
      <div style={{fontSize:46,marginBottom:10}}>🏷</div>
      <Btn accent full style={{pointerEvents:"none"}}>{t("label_photo_btn")}</Btn>
    </div>:<div style={{marginBottom:12}}>
      <img src={preview} alt="label" style={{width:"100%",borderRadius:12,maxHeight:260,objectFit:"contain",background:C.bg,marginBottom:10}}/>
      <div style={{display:"flex",gap:8}}>
        <Btn full onClick={()=>inputRef.current?.click()} style={{flex:1}}>{t("other_photo2")}</Btn>
        {!form&&<Btn accent full onClick={read} disabled={loading} style={{flex:2}}>{loading?"…":t("label_read_btn")}</Btn>}
      </div>
      {quota&&!form&&<div style={{fontSize:11,color:C.muted,textAlign:"center",marginTop:8,fontFamily:"monospace"}}>
        {t("food_quota_left").replace("{left}",Math.max(0,quota.limit-quota.used)).replace("{limit}",quota.limit)}</div>}
    </div>}
    {loading&&<Card style={{marginBottom:12}}><div style={{textAlign:"center",padding:"14px 0",color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:2}}>{t("label_reading")}</div></Card>}
    {error&&<Card style={{marginBottom:12}}>
      <div style={{color:C.danger,fontSize:13,textAlign:"center",lineHeight:1.5}}>{error}</div>
      {limitHit&&<PremiumNudge tgId={tgId} kind="food" onNav={onNav} style={{marginTop:8}}/>}
    </Card>}
    {form&&<Fragment>
      <Card style={{marginBottom:12}}>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {field("name",t("label_name"))}
          {field("brand",t("label_brand"))}
          <Kicker style={{margin:"6px 0 0"}}>{t("label_per100")}</Kicker>
          <div style={{display:"flex",gap:6}}>
            {field("kcal",t("calories_short"),true)}{field("protein",t("nut_belki"),true)}
            {field("fat",t("nut_zhiry"),true)}{field("carbs",t("carbs_short"),true)}
          </div>
          {form.confidence==="low"&&<div style={{fontSize:12,color:C.warn||C.accent,lineHeight:1.5}}>{t("label_low_conf")}</div>}
        </div>
      </Card>
      {done==="only"?<Card accent style={{marginBottom:12}}><div style={{fontSize:13,color:C.accent,textAlign:"center"}}>{t("label_saved_only")}</div></Card>
      :done==="log"?<div style={{textAlign:"center",color:C.accent,fontFamily:"monospace",fontSize:14,padding:20}}>{t("added_done")}</div>
      :<Fragment>
        <Kicker>{t("label_portion")}</Kicker>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",margin:"6px 0 8px"}}>
          {[...(form.serving_g?[form.serving_g]:[]),50,100,200,300].filter((x,i,a)=>a.indexOf(x)===i).map(x=>
            <button key={x} onClick={()=>setWeight(String(x))} style={{padding:"6px 12px",borderRadius:8,fontSize:12,cursor:"pointer",
              background:weight===String(x)?C.accent:C.card,border:`0.5px solid ${weight===String(x)?C.accent:C.border}`,
              color:weight===String(x)?C.bg:C.text,fontFamily:"monospace"}}>
              {x===form.serving_g?`${x}${t("u_g")} · ${t("label_pack_portion")}`:`${x}${t("u_g")}`}</button>)}
        </div>
        <input type="number" value={weight} onChange={e=>setWeight(e.target.value)}
          style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,
            fontSize:14,outline:"none",boxSizing:"border-box",marginBottom:10}}/>
        {tot&&<div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:12}}>
          {t("label_total").replace("{w}",w)}: <span style={{color:C.accent}}>{tot.kcal} {t("kcal_short")}</span> · {t("u_prot")}{tot.p} · {t("u_fat")}{tot.f} · {t("u_carb")}{tot.c}
        </div>}
        <div style={{marginBottom:14}}><Kicker>{t("meal_section")}</Kicker><Sel value={meal} onChange={setMeal} options={MEAL_OPTS}/></div>
        <Btn accent full disabled={!valid||saving||w<=0} onClick={()=>save(true)}>{saving?t("saving"):t("label_save_log")}</Btn>
        <Btn full style={{marginTop:8}} disabled={!valid||saving} onClick={()=>save(false)}>{t("label_save_only")}</Btn>
      </Fragment>}
    </Fragment>}
  </div>;
}

function FoodSearchScreen({tgId,onBack,onNav,mealType}){
  const CATS=[
    {v:"",l:t("fs_vse")},{v:"national",l:t("fcat_national")},
    {v:"meat",l:t("fcat_myaso")},{v:"fish",l:t("fcat_ryba")},{v:"dairy",l:t("fcat_molochka")},
    {v:"eggs",l:t("alg_yayca")},{v:"grains",l:t("fcat_krupy")},{v:"bread",l:t("fcat_hleb")},
    {v:"vegetables",l:t("fcat_ovoschi")},{v:"fruits",l:t("fcat_frukty")},{v:"nuts",l:t("alg_orehi")},
    {v:"drinks",l:t("fcat_napitki")},{v:"snacks",l:t("fcat_sneki")},{v:"other",l:t("fcat_prochee")},
    {v:"supplements",l:t("fs_sportpit")},
  ];
  const MEAL_OPTS=[
    {value:"breakfast",label:t("meal_breakfast")},{value:"lunch",label:t("meal_lunch")},
    {value:"dinner",label:t("meal_dinner")},{value:"snack",label:t("meal_snack")},
  ];
  const [q,setQ]=useState("");
  const [cat,setCat]=useState("");
  const [results,setResults]=useState([]);
  const [loading,setLoading]=useState(false);
  const [sel,setSel]=useState(null);
  const [weight,setWeight]=useState("100");
  const [meal,setMeal]=useState(mealType||"breakfast");
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const timerRef=useRef(null);

  useEffect(()=>{
    if(timerRef.current)clearTimeout(timerRef.current);
    if(!q.trim()&&!cat){setResults([]);return;}
    timerRef.current=setTimeout(()=>doSearch(q,cat),400);
    return()=>{if(timerRef.current)clearTimeout(timerRef.current);};
  },[q,cat]);

  async function doSearch(query,category){
    setLoading(true);
    try{
      const params=new URLSearchParams({limit:"30"});
      if(query.trim())params.append("q",query.trim());
      if(category)params.append("category",category);
      const r=await fetch(`${API}/food/search?${params}`);
      const d=await r.json();
      setResults(d.items||[]);
    }catch{}finally{setLoading(false);}
  }

  function calcKcal(p){
    const w=parseFloat(weight)||100;
    const f=w/100;
    return{
      kcal:Math.round((p.calories||0)*f),
      protein:Math.round((p.protein||0)*f*10)/10,
      fat:Math.round((p.fat||0)*f*10)/10,
      carb:Math.round((p.carbs||0)*f*10)/10,
    };
  }

  async function logProduct(){
    if(!sel||!tgId)return;
    const w=parseFloat(weight);
    if(!w||w<=0)return;
    setSaving(true);
    try{
      const r=await fetch(`${API}/food/log-from-catalog`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({user_id:tgId,product_id:sel.id,weight_g:w,meal_type:meal}),
      });
      if(r.ok){setSaved(true);setTimeout(()=>{if(onNav)onNav("nutrition",{});else onBack();},1200);}
    }catch{}finally{setSaving(false);}
  }

  if(sel){
    const calc=calcKcal(sel);
    return<div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setSel(null)}/>
      <Kicker>{t("add_product_btn")}</Kicker>
      <Hero style={{marginBottom:16}}>{foodName(sel)}</Hero>
      {sel.brand&&<div style={{fontFamily:"monospace",fontSize:11,color:C.muted,marginBottom:4}}>{sel.brand}</div>}
      {sel.supplement_type&&<Tag color={C.accent} style={{marginBottom:12}}>{sel.supplement_type}</Tag>}

      <Card accent style={{marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,textAlign:"center"}}>
          {[{l:t("calories_short"),v:calc.kcal},{l:t("nut_belki"),v:calc.protein+t("u_g")},{l:t("nut_zhiry"),v:calc.fat+t("u_g")},{l:t("carbs_short"),v:calc.carb+t("u_g")}].map((m,i)=>(
            <div key={i}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:2}}>{m.l}</div><Mono size={14}>{m.v}</Mono></div>
          ))}
        </div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",textAlign:"center",marginTop:8}}>{t("fs_na")} {weight}{t("u_g")}</div>
      </Card>

      {sel.serving_size_g&&<div style={{fontFamily:"monospace",fontSize:11,color:C.muted,marginBottom:12}}>
        {t("ui_1_porciya")} {sel.serving_size_g}{t("u_g")}
        {sel.servings_per_pack&&` · ${t("sup_per_pack").replace("{n}",sel.servings_per_pack)}`}
      </div>}

      <div style={{marginBottom:12}}>
        {/* Без ||: t() при промахе возвращает сам ключ, а он непустой — поэтому
            запасной вариант никогда не срабатывал и на экране стояло слово
            «field_weight_g». Ключ теперь есть во всех четырёх языках. */}
        <Kicker>{t("field_weight_g")}</Kicker>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
          {(sel.serving_size_g?[sel.serving_size_g,100,200,300]:[50,100,150,200,300]).map(w=>(
            <button key={w} onClick={()=>setWeight(String(w))}
              style={{padding:"6px 14px",borderRadius:8,fontSize:12,cursor:"pointer",
                background:weight===String(w)?C.accent:C.card,
                border:`0.5px solid ${weight===String(w)?C.accent:C.border}`,
                color:weight===String(w)?C.bg:C.text,fontFamily:"monospace"}}>
              {w===sel.serving_size_g?t("one_portion"):w+t("u_g")}
            </button>
          ))}
        </div>
        <input type="number" value={weight} onChange={e=>setWeight(e.target.value)}
          style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"10px 14px",color:C.text,fontSize:14,outline:"none",boxSizing:"border-box"}}/>
      </div>

      <div style={{marginBottom:20}}>
        <Kicker>{t("meal_section")}</Kicker>
        <Sel value={meal} onChange={setMeal} options={MEAL_OPTS}/>
      </div>

      {saved
        ?<div style={{textAlign:"center",color:C.accent,fontFamily:"monospace",fontSize:14,padding:20}}>{t("added_done")}</div>
        :<Btn accent full onClick={logProduct} disabled={saving||!weight||parseFloat(weight)<=0}>
          {saving?t("saving"):t("add_meal2")}
        </Btn>
      }
    </div>;
  }

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("menu_nutrition")}</Kicker>
    <Hero style={{marginBottom:12}}>{t("food_search_title")}</Hero>
    {tgId&&onNav&&<Btn full style={{marginBottom:12}} onClick={()=>onNav("label_scan",{meal_type:meal})}>🏷 {t("label_scan_btn")}</Btn>}

    <input value={q} onChange={e=>setQ(e.target.value)}
      placeholder={t("food_search_placeholder")}
      style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:10,
        padding:"12px 16px",color:C.text,fontSize:14,outline:"none",
        boxSizing:"border-box",marginBottom:12}}/>

    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
      {CATS.map(c=>(
        <button key={c.v} onClick={()=>{setCat(c.v);if(!q.trim())doSearch("",c.v);}}
          style={{padding:"5px 12px",borderRadius:16,fontSize:12,cursor:"pointer",
            background:cat===c.v?C.accent:C.card,
            border:`0.5px solid ${cat===c.v?C.accent:C.border}`,
            color:cat===c.v?C.bg:C.muted,fontFamily:"monospace"}}>
          {c.l}
        </button>
      ))}
    </div>

    {loading&&<Loader text={t("fs_poisk")}/>}

    {!loading&&results.length===0&&(q||cat)&&(
      <div style={{textAlign:"center",color:C.muted,fontFamily:"monospace",fontSize:12,padding:32}}>
        {t("not_found_hint").toUpperCase()}
      </div>
    )}

    {!loading&&results.length===0&&!q&&!cat&&(
      <div style={{textAlign:"center",color:C.muted,fontFamily:"monospace",fontSize:12,padding:32}}>
        {t("enter_name_or_cat")}
      </div>
    )}

    {results.map(p=>(
      <Card key={p.id} onClick={()=>{setSel(p);setWeight(p.serving_size_g?String(p.serving_size_g):"100");}} style={{marginBottom:10,cursor:"pointer"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,color:C.text,fontWeight:600,marginBottom:2}}>{foodName(p)}</div>
            {p.brand&&<div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{p.brand}</div>}
            {p.category==="national"&&p.serving_size_g&&<div style={{fontSize:11,color:C.accent,fontFamily:"monospace"}}>
              {t("food_portion_approx").replace("{n}",p.serving_size_g)}</div>}
            <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:4}}>
              {t("u_prot")}{p.protein}{t("u_g")} · {t("u_fat")}{p.fat}{t("u_g")} · {t("u_carb")}{p.carbs}{t("u_g")}
            </div>
          </div>
          <div style={{flexShrink:0,textAlign:"right",marginLeft:12}}>
            <Mono size={15}>{p.calories}</Mono>
            <div style={{fontSize:10,color:C.muted}}>{t("kcal_100g")}</div>
            {p.supplement_type&&<Tag color={C.accent} style={{marginTop:4,fontSize:10}}>{p.supplement_type}</Tag>}
          </div>
        </div>
      </Card>
    ))}

    <AddCustomProductForm onAdded={p=>{setSel(p);setWeight("100");}}/>
  </div>;
}

// ── Форма добавления пользовательского продукта ───────────────────────────────
// ── SportLogScreen ────────────────────────────────────────────────────────────
function SportLogScreen({tgId,onBack,initialSport=null}){
  const [sports,setSports]=useState([
    {v:"football",l:t("aw_futbol")},{v:"volleyball",l:t("aw_voleybol")},
    {v:"basketball",l:t("aw_basketbol")},{v:"table_tennis",l:t("aw_nastolnyy_tennis")},
    {v:"padel",l:t("aw_padel")},{v:"tennis",l:t("aw_bolshoy_tennis")},{v:"yoga",l:t("aw_yoga")},
  ]);
  useEffect(()=>{
    apiGet(`${API}/sport-types`).then(d=>{
      if(d.sport_types?.length)setSports(d.sport_types.map(s=>({v:s.code,l:s.name,l_en:s.name_en,l_uz:s.name_uz,l_kz:s.name_kz,met:s.met,track_distance:s.track_distance,track_duration:s.track_duration,track_intensity:s.track_intensity,track_sets:s.track_sets,track_score:s.track_score})));
    }).catch(()=>{});
  },[]);
  const SPORTS=sports;
  const [sport,setSport]=useState(initialSport||"football");
  const [duration,setDuration]=useState("60");
  const [intensity,setIntensity]=useState("medium");
  const [notes,setNotes]=useState("");
  const [date,setDate]=useState(localToday);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(null);

  async function save(){
    if(!duration||parseInt(duration)<=0)return;
    setSaving(true);
    try{
      const r=await fetch(`${API}/sport/${tgId}`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({sport_type:sport,duration_min:parseInt(duration),
          intensity,notes:notes.trim()||null,session_date:date}),
      });
      const d=await r.json();
      if(r.ok)setSaved(d.calories_burned);
    }catch{}finally{setSaving(false);}
  }

  if(saved!==null)return(
    <div style={{padding:"16px 16px 100px",textAlign:"center",paddingTop:60}}>
      <div style={{fontSize:52,marginBottom:16}}>{SPORTS.find(s=>s.v===sport)?.l.split(" ")[0]||"⚽"}</div>
      <Hero style={{textAlign:"center",marginBottom:8}}>{t("record_btn")}</Hero>
      <div style={{color:C.muted,fontFamily:"monospace",fontSize:13,marginBottom:4}}>
        {SPORTS.find(s=>s.v===sport)?.l} · {duration} {t("home_min")}
      </div>
      {saved>0&&<div style={{color:C.accent,fontFamily:"monospace",fontSize:18,marginBottom:4}}>~{saved} {t("kcal_unit")}</div>}
      <div style={{color:C.success,fontSize:12,fontFamily:"monospace",marginBottom:24}}>{t("pts_bonus")}</div>
      <div style={{display:"flex",gap:10}}>
        <Btn full onClick={()=>{setSaved(null);setNotes("");setDuration("60");}} style={{flex:1}}>{t("another_one")}</Btn>
        <Btn accent full onClick={onBack} style={{flex:1}}>{t("back")}</Btn>
      </div>
    </div>
  );

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("sport_title2")}</Kicker>
    <Hero style={{marginBottom:16}}>{t("sport_record")}</Hero>

    <div style={{marginBottom:14}}>
      <Kicker>{t("sport_type_label")}</Kicker>
      <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:6}}>
        {SPORTS.map(s=>(
          <button key={s.v} onClick={()=>setSport(s.v)}
            style={{padding:"8px 14px",borderRadius:20,fontSize:13,cursor:"pointer",
              background:sport===s.v?C.accent:C.card,
              border:`0.5px solid ${sport===s.v?C.accent:C.border}`,
              color:sport===s.v?C.bg:C.text,fontWeight:sport===s.v?700:400}}>
            {tSport(s)||s.l}
          </button>
        ))}
      </div>
    </div>

    <div style={{marginBottom:14}}>
      <Kicker>{t("sport_duration")}</Kicker>
      <div style={{display:"flex",gap:8,marginTop:6,flexWrap:"wrap"}}>
        {[30,45,60,90,120].map(d=>(
          <button key={d} onClick={()=>setDuration(String(d))}
            style={{padding:"6px 14px",borderRadius:8,fontSize:13,cursor:"pointer",
              background:duration===String(d)?C.accent:C.card,
              border:`0.5px solid ${duration===String(d)?C.accent:C.border}`,
              color:duration===String(d)?C.bg:C.text,fontFamily:"monospace"}}>
            {d}
          </button>
        ))}
        <input type="number" value={duration} onChange={e=>setDuration(e.target.value)}
          placeholder={t("splog_svoe")}
          style={{width:70,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,
            padding:"6px 10px",color:C.text,fontSize:13,outline:"none",textAlign:"center"}}/>
      </div>
    </div>

    <div style={{marginBottom:14}}>
      <Kicker>{t("sport_intensity")}</Kicker>
      <div style={{display:"flex",gap:8,marginTop:6}}>
        {[{v:"low",l:t("intensity_low")},{v:"medium",l:t("intensity_medium")},{v:"high",l:t("intensity_high")}].map(i=>(
          <button key={i.v} onClick={()=>setIntensity(i.v)}
            style={{flex:1,padding:"8px 6px",borderRadius:8,fontSize:12,cursor:"pointer",
              background:intensity===i.v?C.accent:C.card,
              border:`0.5px solid ${intensity===i.v?C.accent:C.border}`,
              color:intensity===i.v?C.bg:C.text,fontWeight:intensity===i.v?700:400}}>
            {i.l}
          </button>
        ))}
      </div>
    </div>

    <div style={{marginBottom:14}}>
      <Kicker>{t("sport_date")}</Kicker>
      <input type="date" value={date} onChange={e=>setDate(e.target.value)}
        style={{colorScheme:"dark",width:"100%",background:C.card,border:`0.5px solid ${C.border}`,
          borderRadius:8,padding:"10px 14px",color:C.accent,fontSize:14,
          fontFamily:"monospace",outline:"none",marginTop:6}}/>
    </div>

    <div style={{marginBottom:20}}>
      <Kicker>{t("sport_notes_opt")}</Kicker>
      <textarea value={notes} onChange={e=>setNotes(e.target.value)}
        placeholder={t("score_optional")}
        style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,
          padding:"10px 12px",color:C.text,fontSize:13,outline:"none",resize:"none",
          minHeight:60,fontFamily:"inherit",boxSizing:"border-box",marginTop:6}}/>
    </div>

    <Btn accent full onClick={save} disabled={saving||!duration||parseInt(duration)<=0}>
      {saving?t("saving"):t("sport_save_btn")}
    </Btn>
  </div>;
}

// ── GamificationScreen ────────────────────────────────────────────────────────
function GamificationScreen({tgId,onBack,user}){
  const [data,setData]=useState(null);
  useEffect(()=>{
    if(!tgId){setData(null);return;}
    fetch(`${API}/gamification/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData(null));
  },[]);

  const rankColors={beginner:"#CD7F32",athlete:"#C0C0C0",champion:"#FFD700",legend:"#00FFFF"};
  const reasonLabels={
    workout_finished:t("gam_trenirovka_zavershena"),
    checkin:t("gam_chek_in"),
    sport_football:t("aw_futbol"),sport_volleyball:t("aw_voleybol"),sport_basketball:t("aw_basketbol"),
    sport_table_tennis:t("aw_nastolnyy_tennis"),sport_padel:t("aw_padel"),
    sport_tennis:t("gam_tennis"),sport_yoga:t("aw_yoga"),
  };

  if(!data)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("status_label")}/></div>;

  const rankColor=rankColors[data.rank]||C.accent;

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("gamification_title2")}</Kicker>
    <Hero style={{marginBottom:16}}>{t("gamification_title2")}</Hero>

    <Card style={{marginBottom:16,border:`0.5px solid ${rankColor}`,textAlign:"center",padding:"20px 16px"}}>
      <div style={{fontSize:48,marginBottom:8}}>{
        {beginner:"🥉",athlete:"🥈",champion:"🥇",legend:"💎"}[data.rank]||"🥉"
      }</div>
      <div style={{fontSize:22,fontWeight:700,color:rankColor,marginBottom:4}}>{data.rank_name}</div>
      <Mono size={32} color={rankColor}>{data.total_points}</Mono>
      <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginTop:4}}>{t("pts_label")}</div>
      <div style={{fontSize:12,color:C.accent,fontFamily:"monospace",marginTop:8}}>
        {t("ui_ai_zaprosov_v_den")} {data.ai_limit}
      </div>
    </Card>

    {data.next_rank&&<Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
        <Kicker>{t("next_rank")}</Kicker>
        <span style={{fontFamily:"monospace",fontSize:11,color:C.muted}}>{data.pts_to_next} {t("pts_short")}</span>
      </div>
      <ProgressBar pct={data.progress_pct}/>
      <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:6}}>
        {t("ui_sleduyuschiy")} {
          {athlete:t("gam_atlet"),champion:t("gam_chempion"),legend:t("gam_legenda")}[data.next_rank]
        } ({data.next_rank_pts} {t("ui_ball")}
      </div>
    </Card>}

    <Card style={{marginBottom:16}}>
      <Kicker>{t("how_earn")}</Kicker>
      <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>
        {[
          {icon:"🏋️",l:t("workout_done2"),pts:10},
          {icon:"⚽",l:t("gam_zanyatie_sportom"),pts:8},
          {icon:"✓",l:t("menu_checkin"),pts:5},
          {icon:"📷",l:t("gam_pitanie_vneseno"),pts:2},
        ].map((r,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",
            borderBottom:i<3?`0.5px solid ${C.border}`:"none"}}>
            <span style={{fontSize:13,color:C.text}}>{r.icon} {r.l}</span>
            <span style={{fontFamily:"monospace",fontSize:13,color:C.accent}}>+{r.pts}</span>
          </div>
        ))}
      </div>
    </Card>

    {/* Streak rewards */}
    {data.streak_rewards?.length>0&&<Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <Kicker>{t("streak_series")}</Kicker>
        <Mono size={14}>{data.streak_days||0} {t("alt_days")}</Mono>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {data.streak_rewards.map((r,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",
            borderBottom:i<data.streak_rewards.length-1?`0.5px solid ${C.border}`:"none",
            opacity:r.unlocked?1:0.4}}>
            <span style={{fontSize:20,flexShrink:0}}>{r.emoji}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:13,color:r.unlocked?C.text:C.muted,fontWeight:r.unlocked?600:400}}>
                {r.name} {r.unlocked?"✓":""}
              </div>
              <div style={{fontSize:11,color:C.muted}}>{r.desc}</div>
            </div>
            <span style={{fontFamily:"monospace",fontSize:12,color:r.unlocked?C.accent:C.muted,flexShrink:0}}>
              +{r.pts}
            </span>
          </div>
        ))}
      </div>
    </Card>}

    {data.recent_points?.length>0&&<Card>
      <Kicker>{t("recent_points")}</Kicker>
      <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
        {data.recent_points.slice(0,5).map((r,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",
            borderBottom:i<4?`0.5px solid ${C.border}`:"none"}}>
            <span style={{color:C.muted}}>{reasonLabels[r.reason]||r.reason}</span>
            <span style={{color:C.accent,fontFamily:"monospace"}}>+{r.pts}</span>
          </div>
        ))}
      </div>
    </Card>}
  </div>;
}


// ── PlateauBlock — блок плато в ProgressScreen ───────────────────────────────
// ── ReferralScreen ────────────────────────────────────────────────────────────
// ── Иконки Premium и «поделиться» ────────────────────────────────────────────
// Свои линейные значки в цвет приложения вместо эмодзи: эмодзи на каждом
// телефоне свои и спорят с остальным интерфейсом.
const ICON_PATHS={
  coach:<><path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7.5L7 21v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z"/><circle cx="8.2" cy="11" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="11" r="1.05" fill="currentColor" stroke="none"/><circle cx="15.8" cy="11" r="1.05" fill="currentColor" stroke="none"/></>,
  camera:<><path d="M3 8.6a2 2 0 0 1 2-2h2.6l1.6-2.2h5.6l1.6 2.2H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13.1" r="3.6"/></>,
  bolt:<path d="M13.4 2.8 5 13.6h6.4l-.8 7.6L19 10.4h-6.4l.8-7.6Z"/>,
  star:<path d="m12 3.4 2.62 5.31 5.86.85-4.24 4.13 1 5.83L12 16.77l-5.24 2.75 1-5.83-4.24-4.13 5.86-.85Z"/>,
  story:<><circle cx="12" cy="12" r="8.6" strokeDasharray="3.4 2.3"/><path d="M12 8.4v7.2M8.4 12h7.2"/></>,
  send:<><path d="M20.6 3.4 3.4 10.7l6.9 2.7 2.7 6.9 7.6-16.9Z"/><path d="m10.3 13.4 4.6-4.6"/></>,
};
function Icon({name,size=22,color=C.accent,fill="none",style={}}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{color,flexShrink:0,display:"block",...style}}>{ICON_PATHS[name]}</svg>;
}
/** Строка с «⭐» из перевода: звезду рисуем своим значком в цвет текста —
 *  жёлтый эмодзи на салатовой кнопке выглядел грязно. */
function withStar(str,size=15){
  const parts=String(str).split("⭐");
  return parts.map((x,i)=><Fragment key={i}>{x}{i<parts.length-1&&<Icon name="star" size={size} fill="currentColor" color="currentColor"
    style={{display:"inline-block",verticalAlign:"-2px",margin:"0 1px"}}/>}</Fragment>);
}
function IconTile({name,size=40}){
  return <div style={{width:size,height:size,borderRadius:10,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",
    background:"rgba(200,255,0,0.08)",border:"0.5px solid rgba(200,255,0,0.28)"}}><Icon name={name} size={Math.round(size*0.55)}/></div>;
}

// ── Premium ──────────────────────────────────────────────────────────────────
// Статус Premium нужен нескольким экранам (меню, тренер, фото еды) — держим
// одну копию на минуту, чтобы не спрашивать сервер при каждом переходе.
let _premCache=null, _premAt=0, _premInflight=null;
function fetchPremium(tgId,force=false){
  if(!tgId)return Promise.resolve(null);
  if(!force&&_premCache&&Date.now()-_premAt<60000)return Promise.resolve(_premCache);
  if(_premInflight&&!force)return _premInflight;
  const req=fetch(`${API}/premium/${tgId}`).then(r=>r.ok?r.json():null)
    .then(d=>{if(d){_premCache=d;_premAt=Date.now();}return d;}).catch(()=>null)
    .finally(()=>{if(_premInflight===req)_premInflight=null;});
  _premInflight=req;
  return req;
}
function usePremium(tgId){
  const [p,setP]=useState(_premCache);
  useEffect(()=>{let on=true;fetchPremium(tgId).then(d=>{if(on&&d)setP(d);});return()=>{on=false;};},[tgId]);
  return [p,setP];
}
function fmtDay(iso){
  // Год — только если не текущий: русское «2026 г.» перед точкой давало «г..»
  const d=utcToLocal(iso);
  if(!d)return "";
  const opts={day:"numeric",month:"long"};
  if(d.getFullYear()!==new Date().getFullYear())opts.year="numeric";
  return d.toLocaleDateString(dateLocale(),opts);
}
/** Подсказка «с Premium можно больше» там, где упёрлись в лимит. Пока Premium
 *  выключен (или уже есть) — ничего не показывает. */
function PremiumNudge({tgId,kind,onNav,style={}}){
  const [p]=usePremium(tgId);
  if(!p||!p.visible||p.active||!onNav)return null;
  const n=kind==="food"?p.perks?.food_premium:p.perks?.ai_premium;
  return <Card accent onClick={()=>onNav("premium")} style={{marginTop:12,...style}} pad="12px 14px">
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <IconTile name="star" size={34}/>
      <span style={{fontSize:13,color:C.text,flex:1,lineHeight:1.4}}>{t(kind==="food"?"premium_nudge_food":"premium_nudge_ai").replace("{n}",n)}</span>
      <span style={{fontSize:12,color:C.accent,fontFamily:"monospace",whiteSpace:"nowrap"}}>{t("premium_nudge_btn")} ›</span>
    </div>
  </Card>;
}

// ── Правила использования ────────────────────────────────────────────────────
// Один документ на все входы: онбординг и повторное согласие (оверлеем), «Сервисы»,
// экран Premium (сразу к разделу Premium), /terms в боте (startapp=terms).
function TermsView({tgId,section}){
  const [p]=usePremium(tgId);
  const premRef=useRef(null);
  useEffect(()=>{
    if(section==="premium"&&premRef.current)premRef.current.scrollIntoView({block:"start"});
  },[section]);
  const month=p?.plans?.find(x=>x.id==="month"), year=p?.plans?.find(x=>x.id==="year");
  const pay=month&&year?t("terms_p_pay").replace("{pm}",month.stars).replace("{py}",year.stars):t("terms_p_pay_np");
  const trialDays=p?.trial_days??7;
  const prem=["terms_p_what",null,"terms_p_month","terms_p_year",trialDays>0?"terms_p_trial":null,"terms_p_refund","terms_p_account"];
  const H=({children})=><div style={{fontSize:15,fontWeight:700,color:C.text,margin:"22px 0 8px"}}>{children}</div>;
  const P=({children})=><div style={{fontSize:13,color:C.muted,lineHeight:1.65,marginBottom:10,whiteSpace:"pre-line"}}>{children}</div>;
  return <div>
    <Kicker>{t("terms_kicker")}</Kicker>
    <Hero style={{fontSize:24}}>{t("terms_title")}</Hero>
    <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:6}}>{t("terms_updated")}</div>
    <H>{t("terms_s_general_t")}</H><P>{t("terms_s_general_b")}</P>
    <H>{t("terms_s_data_t")}</H><P>{t("terms_s_data_b")}</P>
    <div ref={premRef} style={{scrollMarginTop:12}}><H>{t("terms_s_prem_t")}</H></div>
    {prem.map((k,i)=>k===null&&i===1?<P key="pay">{pay}</P>:k&&<P key={k}>{k==="terms_p_trial"?t(k).replace("{n}",trialDays):t(k)}</P>)}
    <H>{t("terms_s_support_t")}</H><P>{t("terms_s_support_b")}</P>
  </div>;
}

function TermsScreen({tgId,section,onBack}){
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <TermsView tgId={tgId} section={section}/>
  </div>;
}

// Поверх онбординга и экрана согласия: там ещё нет навигации по экранам.
function TermsOverlay({tgId,onClose}){
  return <div style={{position:"fixed",inset:0,zIndex:1000,background:C.bg,overflowY:"auto",padding:"18px 16px 110px"}}>
    <TermsView tgId={tgId}/>
    <Btn accent full style={{marginTop:18}} onClick={onClose}>{t("terms_close")}</Btn>
  </div>;
}

function PremiumScreen({tgId,onBack,onNav}){
  const [p,setP]=usePremium(tgId);
  const [busy,setBusy]=useState(null);   // "month" | "year" | "trial" | "sub"
  const [msg,setMsg]=useState(null);     // {text, ok}
  const [failed,setFailed]=useState(false);
  useEffect(()=>{fetchPremium(tgId,true).then(d=>{if(d)setP(d);else setFailed(true);});},[tgId]);
  const keep=d=>{if(d){_premCache=d;_premAt=Date.now();setP(d);}};

  // Платёж принимает бот: после «paid» ждём, пока срок на сервере сдвинется.
  async function waitActive(prevUntil){
    for(let i=0;i<14;i++){
      await new Promise(r=>setTimeout(r,1500));
      const d=await fetchPremium(tgId,true);
      if(d&&d.active&&d.until&&d.until!==prevUntil){keep(d);return d;}
    }
    return null;
  }
  async function buy(plan){
    if(busy)return;
    setBusy(plan);setMsg(null);
    let handedOff=false;
    try{
      const r=await fetch(`${API}/premium/${tgId}/invoice`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({plan})});
      if(r.status===409){setMsg({text:t("premium_already_sub")});fetchPremium(tgId,true).then(keep);return;}
      if(!r.ok)throw new Error(r.status);
      const {url}=await r.json();
      const prevUntil=p?.until||null;
      if(tg?.openInvoice&&tgAtLeast("6.1")){
        // handedOff — только после вызова: openInvoice может бросить сразу
        // (неверная ссылка), и тогда кнопки остались бы заблокированными.
        tg.openInvoice(url,async(status)=>{
          try{
            if(status==="paid"){
              haptic.notify("success");
              setMsg({text:t("premium_paid_wait")});
              const d=await waitActive(prevUntil);
              setMsg(d?{text:t("premium_paid_ok").replace("{date}",fmtDay(d.until)),ok:true}:{text:t("premium_paid_late")});
            }else if(status==="failed"){setMsg({text:t("premium_failed")});}
          }finally{setBusy(null);}
        });
        handedOff=true;
        return;
      }
      if(tg?.openTelegramLink)tg.openTelegramLink(url);else window.open(url,"_blank");
    }catch{setMsg({text:t("premium_error")});}
    finally{if(!handedOff)setBusy(null);}
  }
  async function trial(){
    if(busy)return;
    setBusy("trial");setMsg(null);
    try{
      const r=await fetch(`${API}/premium/${tgId}/trial`,{method:"POST"});
      if(!r.ok)throw new Error(r.status);
      const d=await r.json();keep(d);haptic.notify("success");
      setMsg({text:t("premium_trial_until").replace("{date}",fmtDay(d.until)),ok:true});
    }catch{setMsg({text:t("premium_error")});fetchPremium(tgId,true).then(keep);}
    finally{setBusy(null);}
  }
  async function setRenew(renew){
    if(busy)return;
    setBusy("sub");setMsg(null);
    try{
      const r=await fetch(`${API}/premium/${tgId}/subscription`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({renew})});
      if(!r.ok)throw new Error(r.status);
      keep(await r.json());
    }catch{setMsg({text:t("premium_error")});}
    finally{setBusy(null);}
  }

  if(!p&&failed)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/>
    <div style={{fontSize:14,color:C.muted,marginTop:20}}>{t("home_load_error")}</div></div>;
  if(!p)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;

  const month=p.plans?.find(x=>x.id==="month"), year=p.plans?.find(x=>x.id==="year");
  const save=month&&year?Math.round((1-year.stars/(month.stars*12))*100):0;
  const sub=p.subscription;
  const status=p.source==="manual"?t("premium_manual")
    :(p.source==="trial"?t("premium_trial_until"):t("premium_active_until")).replace("{date}",fmtDay(p.until));
  const perks=[
    {i:"coach",l:t("premium_perk_ai").replace("{n}",p.perks?.ai_premium),n:t("premium_perk_now").replace("{n}",p.perks?.ai_free)},
    {i:"camera",l:t("premium_perk_food").replace("{n}",p.perks?.food_premium),n:t("premium_perk_now").replace("{n}",p.perks?.food_free)},
    {i:"bolt",l:t("premium_perk_support")},
  ];
  const plan=(pl,title,note,badge)=>pl&&<Card key={pl.id} accent={pl.id==="year"} style={{marginBottom:10}}>
    <div style={{display:"flex",alignItems:"baseline",gap:8}}>
      <div style={{fontSize:16,fontWeight:700,color:C.text}}>{title}</div>
      {badge&&<span style={{fontSize:11,fontFamily:"monospace",color:C.bg,background:C.accent,borderRadius:6,padding:"2px 6px"}}>{badge}</span>}
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
        <Mono size={20}>{pl.stars}</Mono><Icon name="star" size={18} fill="currentColor"/>
      </div>
    </div>
    <div style={{fontSize:12,color:C.muted,marginTop:4,lineHeight:1.5}}>{note}</div>
    <Btn accent={pl.id==="year"} full style={{marginTop:12}} disabled={!!busy||(pl.id==="month"&&!!sub)} onClick={()=>buy(pl.id)}>
      {busy===pl.id?"…":(pl.id==="month"&&sub)?t("premium_already_sub"):withStar(t(p.active?"premium_extend":"premium_buy").replace("{n}",pl.stars))}
    </Btn>
  </Card>;

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("premium_kicker")}</Kicker>
    <Hero>{t("premium_title")}</Hero>
    <div style={{fontSize:13,color:C.muted,lineHeight:1.55,marginTop:8,marginBottom:16}}>{t("premium_lead")}</div>

    {p.active&&<Card accent style={{marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,fontSize:15,fontWeight:600,color:C.accent}}>
        <Icon name="star" size={18} fill="currentColor"/>{status}
      </div>
      {sub&&<div style={{fontSize:12,color:C.muted,marginTop:6,lineHeight:1.5}}>
        {sub.renews?t("premium_renews").replace("{date}",fmtDay(sub.next_charge)):t("premium_renew_off").replace("{date}",fmtDay(p.until))}
      </div>}
      {sub&&<Btn full style={{marginTop:10}} disabled={!!busy} onClick={()=>setRenew(!sub.renews)}>
        {busy==="sub"?"…":sub.renews?t("premium_cancel_btn"):t("premium_resume_btn")}
      </Btn>}
    </Card>}

    <Card style={{marginBottom:16}}>
      {perks.map((x,i)=><div key={i} style={{display:"flex",gap:12,alignItems:"center",padding:"10px 0",borderTop:i?`0.5px solid ${C.border}`:"none"}}>
        <IconTile name={x.i}/>
        <div style={{flex:1}}>
          <div style={{fontSize:14,color:C.text,lineHeight:1.4}}>{x.l}</div>
          {x.n&&<div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginTop:2}}>{x.n}</div>}
        </div>
      </div>)}
    </Card>

    {p.source!=="manual"&&<>
      {plan(month,t("premium_month"),t("premium_month_note"))}
      {plan(year,t("premium_year"),t("premium_year_note"),save>0?t("premium_save").replace("{n}",save):null)}
    </>}
    {p.trial_available&&<Btn full style={{marginBottom:10}} disabled={!!busy} onClick={trial}>
      {busy==="trial"?"…":t("premium_trial_btn").replace("{n}",p.trial_days)}
    </Btn>}
    {msg&&<Card accent={!!msg.ok} style={{marginBottom:12}} pad="12px 14px">
      <div style={{fontSize:13,color:msg.ok?C.accent:C.text,lineHeight:1.5}}>{msg.text}</div>
    </Card>}
    <div style={{fontSize:11,color:C.muted,lineHeight:1.6,marginTop:8}}>{t("premium_note")}</div>
    {onNav&&<div onClick={()=>onNav("terms",{section:"premium"})}
      style={{fontSize:12,color:C.accent,marginTop:10,cursor:"pointer"}}>{t("terms_premium_link")} ›</div>}
  </div>;
}

// ── Карточка тренировки: в историю и в чат ───────────────────────────────────
// Картинку рисует сервер; Telegram забирает её по подписанной ссылке.
// Старый Telegram (без shareToStory/shareMessage) и компьютер — карточка
// приходит в чат с ботом, оттуда её пересылают.
function tgAtLeast(v){try{return !!tg?.isVersionAtLeast?.(v);}catch{return false;}}
function ShareWorkout({tgId,workoutId,style={}}){
  const [busy,setBusy]=useState(null);
  const [note,setNote]=useState(null);
  if(!tgId||!workoutId)return null;
  async function sendToBot(){
    const r=await fetch(`${API}/share/${tgId}/workout/${workoutId}/send`,{method:"POST"});
    if(!r.ok)throw new Error(r.status);
    setNote(t("share_sent_bot"));
  }
  async function story(){
    if(busy)return;
    setBusy("story");setNote(null);
    try{
      // Истории публикуются только с телефона: Telegram Desktop и веб сообщают
      // новую версию, но shareToStory там молча ничего не делает.
      const mobile=/^(ios|android)/.test(tg?.platform||"");
      if(!(tg?.shareToStory&&tgAtLeast("7.8")&&mobile)){await sendToBot();return;}
      const r=await fetch(`${API}/share/${tgId}/workout/${workoutId}`,{method:"POST"});
      if(!r.ok)throw new Error(r.status);
      const d=await r.json();
      const opts={text:d.story_text};
      // Ссылка в истории — только у Telegram Premium, остальным Telegram откажет.
      if(tg?.initDataUnsafe?.user?.is_premium)opts.widget_link={url:d.link,name:"GymBot"};
      haptic.impact();
      tg.shareToStory(d.story_url,opts);
    }catch{setNote(t("share_error"));}
    finally{setBusy(null);}
  }
  async function chat(){
    if(busy)return;
    setBusy("chat");setNote(null);
    try{
      if(!(tg?.shareMessage&&tgAtLeast("8.0"))){await sendToBot();return;}
      const r=await fetch(`${API}/share/${tgId}/workout/${workoutId}/prepared`,{method:"POST"});
      if(!r.ok)throw new Error(r.status);
      const {id}=await r.json();
      haptic.impact();
      tg.shareMessage(id,()=>{});
    }catch{setNote(t("share_error"));}
    finally{setBusy(null);}
  }
  return <div style={{marginBottom:16,...style}}>
    <Kicker>{t("share_kicker")}</Kicker>
    <div style={{display:"flex",gap:8,marginTop:8}}>
      <Btn full onClick={story} disabled={!!busy} style={{padding:"12px 8px",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {busy==="story"?"…":<><Icon name="story" size={18}/>{t("share_story")}</>}
      </Btn>
      <Btn full onClick={chat} disabled={!!busy} style={{padding:"12px 8px",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
        {busy==="chat"?"…":<><Icon name="send" size={18}/>{t("share_chat")}</>}
      </Btn>
    </div>
    {note&&<div style={{fontSize:12,color:C.muted,marginTop:8,lineHeight:1.5}}>{note}</div>}
  </div>;
}

function ReferralScreen({tgId,onBack}){
  const [data,setData]=useState(null);
  const [copied,setCopied]=useState(false);

  useEffect(()=>{
    if(!tgId)return;
    fetch(`${API}/referral/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData(null));
  },[]);

  function copyLink(){
    if(!data?.ref_link)return;
    navigator.clipboard?.writeText(data.ref_link).then(()=>{
      setCopied(true);setTimeout(()=>setCopied(false),2000);
    }).catch(()=>{
      // fallback для Telegram
      if(window.Telegram?.WebApp?.openLink)
        window.Telegram.WebApp.openLink(data.ref_link);
    });
  }

  function shareLink(){
    if(!data?.ref_link)return;
    const text=`${t("ui_privet_treniruyus_v_gymbot")}
${data.ref_link}`;
    if(window.Telegram?.WebApp?.openTelegramLink)
      window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(data.ref_link)}&text=${encodeURIComponent(text)}`);
    else
      navigator.clipboard?.writeText(text);
  }

  if(!data)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;

  if(!data.enabled)return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={onBack}/>
      <Hero>{t("referral_title")}</Hero>
      <Card style={{marginTop:16,textAlign:"center"}}>
        <div style={{color:C.muted,fontSize:13,padding:"20px 0"}}>
          {t("ui_referalnaya_programma_vremenno")}
        </div>
      </Card>
    </div>
  );

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("referral_title2")}</Kicker>
    <Hero style={{marginBottom:16}}>{t("referral_title")}</Hero>

    <Card accent style={{marginBottom:16,textAlign:"center",padding:"20px 16px"}}>
      <Kicker>{t("referral_your_code")}</Kicker>
      <div style={{fontSize:32,fontWeight:700,fontFamily:"monospace",color:C.accent,
        letterSpacing:4,margin:"8px 0"}}>{data.ref_code}</div>
      <div style={{fontSize:12,color:C.muted,marginBottom:12}}>{data.ref_link}</div>
      <div style={{display:"flex",gap:8}}>
        <Btn full onClick={copyLink} style={{flex:1}}>
          {copied?t("ref_skopirovano"):t("ref_kopirovat")}
        </Btn>
        <Btn accent full onClick={shareLink} style={{flex:1}}>{t("share_btn2")}</Btn>
      </div>
    </Card>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
      <Card style={{textAlign:"center"}}>
        <Kicker>{t("referral_friends")}</Kicker>
        <Mono size={28}>{data.referrals_count}</Mono>
      </Card>
      <Card style={{textAlign:"center"}}>
        <Kicker>{t("referral_bonus")}</Kicker>
        <Mono size={28}>{data.bonus_per_referral}</Mono>
        <div style={{fontSize:11,color:C.muted}}>{t("pts_label")}</div>
      </Card>
    </div>

    <Card style={{marginBottom:16}}>
      <Kicker>{t("how_works")}</Kicker>
      <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:8}}>
        {[
          {n:"1",t:t("ref_step1")},
          {n:"2",t:t("ref_step2")},
          {n:"3",t:t("ref_step3").replace("{n}",data.bonus_per_referral)},
          {n:"4",t:t("ref_step4")},
        ].map((s,i)=>(
          <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{width:22,height:22,borderRadius:"50%",background:C.accent,
              color:C.bg,fontSize:11,fontWeight:700,display:"flex",alignItems:"center",
              justifyContent:"center",flexShrink:0}}>{s.n}</div>
            <div style={{fontSize:13,color:C.text,paddingTop:3}}>{s.t}</div>
          </div>
        ))}
      </div>
    </Card>

    {data.referrals?.length>0&&<Card>
      <Kicker>{t("ref_moi_referaly")}{data.referrals_count})</Kicker>
      <div style={{marginTop:8}}>
        {data.referrals.map((r,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",
            padding:"6px 0",borderBottom:i<data.referrals.length-1?`0.5px solid ${C.border}`:"none"}}>
            <span style={{fontSize:13,color:C.text}}>{r.name}{r.username?` @${r.username}`:""}</span>
            <span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>
              {r.joined?new Date(r.joined).toLocaleDateString(dateLocale(),{day:"numeric",month:"short"}):"—"}
            </span>
          </div>
        ))}
      </div>
    </Card>}
  </div>;
}


// ── Экспорт ──────────────────────────────────────────────────────────────────
function FoodGuideScreen({onBack}){
  const [cats,setCats]=useState(null);const [sel,setSel]=useState(null);
  useEffect(()=>{fetch(`${API}/food-guide`).then(r=>r.json()).then(d=>setCats(d.categories||[])).catch(()=>setCats([]));},[]);
  if(sel)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setSel(null)}/>
    <div style={{fontSize:40,marginBottom:8}}>{sel.emoji}</div>
    <Kicker>{t("food_ref_section")}</Kicker><Hero>{sel.name}</Hero>
    <div style={{height:16}}/>
    <Card accent style={{marginBottom:10}}>
      <Kicker>{t("food_catalog_kbju")}</Kicker>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
        {[{l:t("calories_label"),v:sel.kcal,u:t("kcal_unit")},{l:t("fg_belok"),v:sel.protein,u:t("u_g")},{l:t("fats_label"),v:sel.fat,u:t("u_g")},{l:t("carbs_label"),v:sel.carb,u:t("u_g")}].map((m,i)=><div key={i}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{m.l}</div><Mono size={14}>{m.v} <span style={{fontSize:11,color:C.muted,fontWeight:400}}>{m.u}</span></Mono></div>)}
      </div>
    </Card>
    {[{label:t("food_when"),value:sel.timing},{label:t("food_tips"),value:sel.tips},{label:t("food_best"),value:sel.best},{label:t("food_combines"),value:sel.combines},{label:t("food_avoid"),value:sel.avoid}].map((r,i)=><Card key={i} style={{marginBottom:8}}><Kicker>{r.label}</Kicker><div style={{fontSize:13,color:C.text,lineHeight:1.6,marginTop:4}}>{r.value}</div></Card>)}
  </div>;
  if(!cats)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("supps_ref")}</Kicker><Hero>{t("food_catalog_section")}</Hero>
    <div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {cats.map((c,i)=><Card key={i} onClick={()=>setSel(c)}>
        <div style={{display:"flex",gap:14,alignItems:"center"}}>
          <span style={{fontSize:32}}>{c.emoji}</span>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:15,color:C.text}}>{c.name}</div><div style={{fontSize:11,color:C.muted,marginTop:2,fontFamily:"monospace"}}>{c.kcal} {t("kcal_unit")} · {t("u_prot")} {c.protein}{t("u_g")} · {t("u_fat")} {c.fat}{t("u_g")} · {t("u_carb")} {c.carb}{t("u_g")}</div></div>
          <span style={{color:C.accent,fontSize:16}}>→</span>
        </div>
      </Card>)}
    </div>
  </div>;
}

// ─── SUPPLEMENTS ──────────────────────────────────────────────────────────────
function SupplementsScreen({onBack,user,onRetry=null}){
  const [sel,setSel]=useState(null);
  // Предупреждения строятся по заболеваниям и аллергиям, а в копии профиля
  // с прошлого запуска их нет — без свежего профиля список показал бы добавки
  // без единого предупреждения.
  if(user?._disk)return <DiskWait onBack={onBack} onRetry={onRetry}/>;
  const supps=[
    {name:t("supp_protein"),icon:"🥛",dose:t("sup_20_40g_za_priem"),timing:t("sup_posle_trenirovki_ili_v"),
      tips:t("sup_vospolnenie_belka_syvorotoch"),
      evidence:t("sup_vysokiy_uroven_dokazatelnost"),
      contraindications:["kidney_disease"],
      links:[{label:"Examine.com — Protein",url:"https://examine.com/supplements/protein-powder/"}]},
    {name:t("supp_creatine"),icon:"⚡",dose:t("sup_3_5g_den"),timing:t("supp_timing_anytime"),
      tips:t("sup_bez_zagruzki_rezultat_cherez"),
      evidence:t("sup_vysokiy_uroven_dokazatelnost"),
      contraindications:["kidney_disease"],
      links:[{label:"Examine.com — Creatine",url:"https://examine.com/supplements/creatine/"}]},
    {name:t("supp_omega"),icon:"🐟",dose:t("sup_1_3g_epa_dha"),timing:t("supp_timing_food"),
      tips:t("sup_protivovospalitelnyy_effekt_"),
      evidence:t("sup_vysokiy_uroven_dokazatelnost"),
      contraindications:["fish_oil"],
      links:[{label:"Examine.com — Omega-3",url:"https://examine.com/supplements/fish-oil/"}]},
    {name:t("supp_vitd"),icon:"☀️",dose:t("sup_2000_5000_me_den"),timing:t("supp_timing_morning"),
      tips:t("sup_immunitet_testosteron_kosti_"),
      evidence:t("sup_vysokiy_uroven_dokazatelnost"),
      contraindications:[],
      links:[{label:"Examine.com — Vitamin D",url:"https://examine.com/supplements/vitamin-d/"}]},
    {name:t("supp_magnesium"),icon:"💊",dose:t("sup_200_400mg"),timing:t("supp_timing_sleep"),
      tips:t("sup_kachestvo_sna_myshechnoe_vos"),
      evidence:t("sup_umerennyy_uroven_dokazatelno"),
      contraindications:[],
      links:[{label:"Examine.com — Magnesium",url:"https://examine.com/supplements/magnesium/"}]},
    {name:t("supp_caffeine"),icon:"☕",dose:t("sup_3_6mg_kg_vesa"),timing:t("supp_timing_before"),
      tips:t("sup_povyshaet_vynoslivost_silu_i"),
      evidence:t("sup_vysokiy_uroven_dokazatelnost"),
      contraindications:["hypertension","heart_disease"],
      links:[{label:"Examine.com — Caffeine",url:"https://examine.com/supplements/caffeine/"}]},
    {name:t("supp_zinc"),icon:"🔩",dose:t("sup_15_30mg_den"),timing:t("supp_timing_food_sleep"),
      tips:t("sup_immunitet_testosteron_vossta"),
      evidence:t("sup_umerennyy_uroven_dokazatelno"),
      contraindications:[],
      links:[{label:"Examine.com — Zinc",url:"https://examine.com/supplements/zinc/"}]},
    {name:t("supp_collagen"),icon:"🦴",dose:t("sup_10g_den"),timing:t("supp_timing_collagen"),
      tips:t("sup_sustavy_i_svyazki_neobhodim"),
      evidence:t("sup_umerennyy_uroven_dokazatelno"),
      contraindications:[],
      links:[{label:"Examine.com — Collagen",url:"https://examine.com/supplements/collagen/"}]},
  ];

  // Персонализация по профилю
  const userConditions=user?.medical_conditions||[];
  const userAllergies=user?.allergies||[];
  const weight=user?.weight;

  function getWarning(s){
    const w=[];
    if(s.contraindications.some(c=>userConditions.includes(c)))w.push(t("sup_prokonsultiruysya_s_vrachom_"));
    if(s.contraindications.some(c=>userAllergies.includes(c)))w.push(t("sup_vozmozhna_allergicheskaya_re"));
    return w;
  }
  function personalDose(s){
    if(s.name===t("supp_caffeine")&&weight)return t("sup_tabs").replace("{a}",Math.round(3*weight)+"–"+Math.round(6*weight)).replace("{b}",Math.round(3*weight/100)+"–"+Math.round(6*weight/100));
    return s.dose;
  }

  if(sel){
    const warnings=getWarning(sel);
    return <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setSel(null)}/>
      <div style={{fontSize:40,marginBottom:8}}>{sel.icon}</div>
      <Kicker>{t("supps_cat")}</Kicker><Hero>{sel.name}</Hero>
      <div style={{marginTop:8,marginBottom:16,fontSize:12,color:C.muted,fontFamily:"monospace"}}>{sel.evidence}</div>
      {warnings.length>0&&warnings.map((w,i)=><div key={i} style={{background:"#FF444422",border:`0.5px solid ${C.danger}`,borderRadius:10,padding:"10px 14px",marginBottom:10,fontSize:13,color:C.danger}}>{w}</div>)}
      <Card accent style={{marginBottom:10}}>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{t("supp_dose_label")}{weight?" "+t("sup_your_weight").replace("{w}",weight):""}</div><div style={{fontSize:14,color:C.accent,fontWeight:600}}>{personalDose(sel)}</div></div>
          <div><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{t("when_take_section")}</div><div style={{fontSize:14,color:C.accent,fontWeight:600}}>{sel.timing}</div></div>
        </div>
      </Card>
      <Card style={{marginBottom:10}}><Kicker>{t("supp_desc")}</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:6}}>{sel.tips}</div></Card>
      {sel.links?.length>0&&<Card><Kicker>{t("supp_sources")}</Kicker><div style={{marginTop:8,display:"flex",flexDirection:"column",gap:6}}>{sel.links.map((l,i)=><button key={i} onClick={()=>{if(window.Telegram?.WebApp?.openLink)window.Telegram.WebApp.openLink(l.url);else window.open(l.url,'_blank');}} style={{background:"none",border:`0.5px solid ${C.accent}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:C.accent,cursor:"pointer",display:"flex",alignItems:"center",gap:6,width:"100%",textAlign:"left"}}>🔗 {l.label}</button>)}</div></Card>}
    </div>;
  }

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("supps_ref")}</Kicker><Hero>{t("supps_title2")}</Hero>
    {user&&<div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginTop:6,marginBottom:8}}>{t("section_profile")} · {user.weight}{t("home_kg")} · {getLevelLabel(user.fitness_level)}</div>}
    <div style={{background:"#FFB80015",border:`0.5px solid ${C.warn}`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:11,color:C.warn,lineHeight:1.6}}>
      {t("ui_primenenie_vitaminov_i_dobavok")}
    </div>
    <div style={{height:4}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {supps.map((s,i)=>{
        const warnings=getWarning(s);
        return <Card key={i} onClick={()=>setSel(s)}>
          <div style={{display:"flex",gap:14,alignItems:"center"}}>
            <span style={{fontSize:32}}>{s.icon}</span>
            <div style={{flex:1}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontWeight:600,fontSize:15,color:C.text}}>{tSport(s)||s.name}</div>
                {warnings.length>0&&<span style={{fontSize:14}}>⚠️</span>}
              </div>
              <div style={{fontSize:11,color:C.muted,marginTop:2,fontFamily:"monospace"}}>{personalDose(s)}</div>
              <div style={{fontSize:10,color:C.muted,marginTop:2}}>{s.evidence}</div>
            </div>
            <span style={{color:C.accent,fontSize:16}}>→</span>
          </div>
        </Card>;
      })}
    </div>
  </div>;
}

// ─── MEASUREMENTS / CHECKIN / LANGUAGE / SUPPORT / GOALS / REMINDERS ─────────
function MeasurementsScreen({onBack,tgId}){
  const [view,setView]=useState("add"); // "add" | "history"
  const [history,setHistory]=useState(null);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [form,setForm]=useState({waist:"",hips:"",chest:"",arm:"",thigh:""});
  const fields=[{key:"waist",label:t("field_waist")},{key:"hips",label:t("field_hips")},{key:"chest",label:t("field_chest")},{key:"arm",label:t("field_arm")},{key:"thigh",label:t("field_thigh")}];

  useEffect(()=>{
    if(view==="history"&&!history){
      if(tgId)fetch(`${API}/measurements/${tgId}`).then(r=>r.json()).then(d=>setHistory(d.logs||[])).catch(()=>setHistory([]));
      else setHistory([]);
    }
  },[view]);

  async function save(){
    const data=Object.fromEntries(Object.entries(form).filter(([,v])=>v).map(([k,v])=>[k,parseFloat(v)]));
    if(!Object.keys(data).length)return;
    setSaving(true);
    try{
      const res=await fetch(`${API}/measurements/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
      if(res.ok){setSaved(true);setForm({waist:"",hips:"",chest:"",arm:"",thigh:""});setHistory(null);setTimeout(()=>setSaved(false),3000);}
    }catch{}finally{setSaving(false);}
  }

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("measurements_cat")}</Kicker><Hero>{t("measurements_title2")}</Hero>
    <div style={{display:"flex",gap:0,margin:"16px 0",border:`0.5px solid ${C.border}`,borderRadius:10,overflow:"hidden"}}>
      {[{id:"add",label:t("add")},{id:"history",label:t("measurements_history")}].map(t=>(
        <button key={t.id} onClick={()=>setView(t.id)} style={{flex:1,padding:"10px",background:view===t.id?C.accent:C.card,border:"none",color:view===t.id?C.bg:C.muted,fontFamily:"monospace",fontSize:11,fontWeight:700,cursor:"pointer"}}>
          {t.label}
        </button>
      ))}
    </div>

    {view==="add"&&<>
      {saved&&<div style={{background:"#00CC6622",border:`0.5px solid ${C.success}`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontFamily:"monospace",fontSize:12,color:C.success}}>{t("measurements_saved")}</div>}
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {fields.map(f=><Card key={f.key}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:13,color:C.muted,fontFamily:"monospace",marginBottom:6}}>{f.label.toUpperCase()}</div>
              <input type="number" value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder="0"
                style={{background:"none",border:"none",color:C.accent,fontSize:22,fontFamily:"monospace",fontWeight:700,width:80,outline:"none"}}/>
            </div>
            <span style={{fontFamily:"monospace",fontSize:14,color:C.muted}}>{t("meas_sm")}</span>
          </div>
        </Card>)}
      </div>
      <Btn accent full onClick={save} disabled={saving||!Object.values(form).some(v=>v)}>
        {saving?t("saving"):t("save_measurements")}
      </Btn>
      <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",textAlign:"center",marginTop:8}}>{t("measurements_hint")}</div>
    </>}

    {view==="history"&&(
      !history?<Loader text={t("measurements_history")}/>:
      history.length===0?<Card><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>{t("measurements_none")}</div></Card>:
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {history.map((h,i)=><Card key={i}>
          <Kicker>{new Date(h.logged_at||h.created_at).toLocaleDateString(dateLocale(),{day:"numeric",month:"long"})}</Kicker>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 16px",marginTop:8}}>
            {fields.map(f=>h[f.key]?<div key={f.key}>
              <span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{f.label}: </span>
              <Mono size={13}>{h[f.key]} <span style={{fontSize:11,color:C.muted,fontWeight:400}}>{t("meas_sm")}</span></Mono>
            </div>:null)}
          </div>
        </Card>)}
      </div>
    )}
  </div>;
}

function CheckinScreen({onBack,tgId}){
  const [sent,setSent]=useState(false);
  const [saving,setSaving]=useState(false);
  const [form,setForm]=useState({weight:"",sleep_hours:"",energy:3,sleep:3,stress:3,motivation:3});
  const sliders=[{key:"energy",label:t("energy_label"),lo:"😴",hi:"⚡"},{key:"sleep",label:t("sleep_label2"),lo:"😞",hi:"😴✨"},{key:"stress",label:t("stress_label"),lo:"😌",hi:"😤"},{key:"motivation",label:t("motivation_label"),lo:"😑",hi:"🔥"}];

  async function send(){
    setSaving(true);
    const body={...form,weight:parseFloat(form.weight)||null,sleep_hours:parseFloat(form.sleep_hours)||null};
    try{
      if(tgId){
        await fetch(`${API}/checkin/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      }
    }catch{}finally{setSaving(false);}
    setSent(true);
  }

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("checkin_weekly")}</Kicker><Hero>{t("checkin_title2")}</Hero>
    <Card style={{marginBottom:16}}>
      <div style={{fontSize:13,color:C.muted,lineHeight:1.6}}>
        {t("checkin_card_hint")}<br/>
        <span style={{color:C.accent}}>{t("ai_trainer_title")}</span> {t("checkin_card_hint2")}
      </div>
    </Card>
    <div style={{height:8}}/>
    {sent
      ?<Card accent><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,color:C.accent}}>✓</div><div style={{fontFamily:"monospace",fontSize:13,color:C.accent,marginTop:8}}>{t("checkin_saved")}</div><div style={{fontSize:12,color:C.muted,marginTop:6}}>{t("checkin_ai_hint")}</div></div></Card>
      :<>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
          <Card>
            <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("weight_kg")}</div>
            <input type="number" step="0.1" value={form.weight} onChange={e=>setForm(p=>({...p,weight:e.target.value}))} placeholder="0.0"
              style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/>
          </Card>
          <Card>
            <div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{t("sleep_hours")}</div>
            <input type="number" step="0.5" min="0" max="24" value={form.sleep_hours} onChange={e=>setForm(p=>({...p,sleep_hours:e.target.value}))} placeholder="7.5"
              style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/>
          </Card>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
          {sliders.map(s=>(
            <Card key={s.key}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                <span style={{fontSize:12,color:C.muted,fontFamily:"monospace"}}>{s.label.toUpperCase()}</span>
                <Mono size={14}>{form[s.key]}/5</Mono>
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <span style={{fontSize:14}}>{s.lo}</span>
                <input type="range" min={1} max={5} value={form[s.key]} onChange={e=>setForm(p=>({...p,[s.key]:+e.target.value}))} style={{flex:1,accentColor:C.accent}}/>
                <span style={{fontSize:14}}>{s.hi}</span>
              </div>
            </Card>
          ))}
        </div>
        <Btn accent full onClick={send} disabled={saving}>{saving?t("saving"):t("send_checkin")}</Btn>
      </>
    }
  </div>;
}

function LanguageScreen({tgId,user,onBack,onUserUpdated}){
  const [saving,setSaving]=useState(false);
  const langs=[{code:"ru",label:"🇷🇺 Русский"},{code:"en",label:"🇬🇧 English"},{code:"uz",label:"🇺🇿 O'zbek"},{code:"kz",label:"🇰🇿 Қазақша"}];
  async function setLang(code){setSaving(code);try{await fetch(`${API}/user/${tgId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({lang:code})});LANG_STORE.current=code;storeLang(code);invalidateApi("/home");onUserUpdated&&onUserUpdated(code);setTimeout(onBack,500);}catch{}finally{setSaving(false);};}
  // Через normLang: если в users.lang лежит "kk" или "RU", галочка «текущий»
  // иначе не встала бы ни на один пункт списка.
  const cur=normLang(user?.lang)||"ru";
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("settings_title")}</Kicker><Hero>{t("language_section")}</Hero><div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {langs.map(l=><Card key={l.code} onClick={()=>setLang(l.code)} accent={cur===l.code}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:16,color:C.text,fontWeight:cur===l.code?700:400}}>{l.label}</span>{cur===l.code&&<span style={{color:C.accent,fontFamily:"monospace",fontSize:12}}>{t("current_lang")}</span>}{saving===l.code&&<span style={{color:C.muted,fontFamily:"monospace",fontSize:11}}>...</span>}</div>
      </Card>)}
    </div>
  </div>;
}

function SupportScreen({onBack,tgId}){
  const [msg,setMsg]=useState("");
  const [sent,setSent]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState(null);

  async function send(){
    if(!msg.trim())return;
    setSaving(true);setError(null);
    try{
      const res=await fetch(`${API}/support`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({tg_id:tgId||0,message:msg.trim(),
          user_name:tg?.initDataUnsafe?.user?.first_name||"Mini App User",
          username:tg?.initDataUnsafe?.user?.username||""})
      });
      if(res.ok){setSent(true);}
      else{setError(t("error_send"));}
    }catch{setError(t("error_conn2"));}
    finally{setSaving(false);}
  }
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("support_cat")}</Kicker><Hero>{t("support_title2")}</Hero><div style={{height:16}}/>
    {sent?<Card accent><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,color:C.accent}}>✓</div><div style={{fontFamily:"monospace",fontSize:13,color:C.accent,marginTop:8}}>{t("sent")}</div></div></Card>:<>
      <Card style={{marginBottom:16}}><div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:10}}>{t("support_problem")}</div><textarea value={msg} onChange={e=>setMsg(e.target.value)} placeholder={t("support_placeholder")} rows={5} style={{width:"100%",background:"none",border:"none",color:C.text,fontSize:14,lineHeight:1.6,resize:"none",outline:"none",boxSizing:"border-box"}}/></Card>
      <Btn accent full onClick={send} disabled={saving||!msg.trim()}>
              {saving?t("sending"):t("send_btn")}
            </Btn>
            {error&&<div style={{marginTop:10,fontSize:12,color:C.danger,fontFamily:"monospace",textAlign:"center"}}>{error}</div>}
    </>}
  </div>;
}

function GoalsScreen({tgId,onBack}){
  const [data,setData]=useState(null);const [adding,setAdding]=useState(false);const [form,setForm]=useState({description:"",target_value:"",unit:"кг",deadline:""});const [saving,setSaving]=useState(false);
  function load(){if(!tgId){setData({goals:[]});return;}fetch(`${API}/goals/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData({goals:[]}));}
  useEffect(()=>{load();},[]);
  async function add(){if(!form.description.trim())return;setSaving(true);try{const res=await fetch(`${API}/goals/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({description:form.description,target_value:parseFloat(form.target_value)||null,unit:form.unit||null,deadline:form.deadline||null,goal_type:"custom"})});if(res.ok){setAdding(false);setForm({description:"",target_value:"",unit:"кг",deadline:""});load();}}catch{}finally{setSaving(false);};}
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("goals_celi")}/></div>;
  const active=data.goals.filter(g=>!g.is_achieved);const done=data.goals.filter(g=>g.is_achieved);
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("progress_title")}</Kicker><Hero>{t("goals_title2")}</Hero><div style={{height:16}}/>
    {!adding?<Btn accent full onClick={()=>setAdding(true)} style={{marginBottom:16}}>{t("goals_add")}</Btn>:
    <Card style={{marginBottom:16}}><Kicker>{t("new_goal")}</Kicker><div style={{display:"flex",flexDirection:"column",gap:10,marginTop:8}}>
      <input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder={t("goal_desc")} style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.text,fontSize:14,outline:"none"}}/>
      <div style={{display:"flex",gap:8}}>
        <input type="number" value={form.target_value} onChange={e=>setForm(p=>({...p,target_value:e.target.value}))} placeholder={t("goal_target")} style={{flex:2,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.accent,fontSize:14,fontFamily:"monospace",outline:"none"}}/>
        <input value={form.unit} onChange={e=>setForm(p=>({...p,unit:e.target.value}))} placeholder={t("goal_unit")} style={{flex:1,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.muted,fontSize:14,outline:"none"}}/>
      </div>
      <input type="date" value={form.deadline} onChange={e=>setForm(p=>({...p,deadline:e.target.value}))} style={{colorScheme:"dark",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.muted,fontSize:13,outline:"none"}}/>
      <div style={{display:"flex",gap:8}}><Btn full onClick={()=>setAdding(false)} style={{flex:1}}>{t("cancel_btn2")}</Btn><Btn accent full onClick={add} disabled={saving||!form.description.trim()} style={{flex:2}}>{saving?"...":t("save_profile")}</Btn></div>
    </div></Card>}
    {active.length===0&&!adding&&<Card style={{marginBottom:12}}><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>{t("no_goals")}</div></Card>}
    {active.map(g=><Card key={g.id} style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><div style={{fontWeight:600,fontSize:14,color:C.text,flex:1}}>{g.description}</div><Mono size={12}>{g.pct}%</Mono></div>
      <div style={{marginBottom:6}}><ProgressBar pct={g.pct}/></div>
      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{g.current_value}/{g.target_value} {g.unit}</span>{g.days_left!=null&&<span style={{fontSize:11,color:g.days_left<7?C.danger:C.muted,fontFamily:"monospace"}}>{g.days_left} {t("alt_days")}</span>}</div>
    </Card>)}
    {done.length>0&&<><Kicker style={{marginTop:16}}>{t("goal_achieved")}</Kicker>{done.map(g=><Card key={g.id} style={{marginBottom:8,opacity:0.6}}><div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:14,color:C.success}}>✓ {g.description}</span><Mono size={12} color={C.success}>100%</Mono></div></Card>)}</>}
  </div>;
}

function RemindersScreen({tgId,onBack,onNav}){
  const [data,setData]=useState(null);
  useEffect(()=>{if(!tgId){setData({reminders:[]});return;}fetch(`${API}/reminders/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData({reminders:[]}));},[]);
  const fmt=iso=>{const d=new Date(iso);return d.toLocaleString(dateLocale(),{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});};
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>{t("reminders_cat")}</Kicker><Hero>{t("reminders_title2")}</Hero><div style={{height:16}}/>
    <Card style={{marginBottom:16}}><div style={{fontSize:13,color:C.muted,lineHeight:1.6}}>{t("bot_reminds2")} <span style={{color:C.accent}}>{t("hour_1")}</span> {t("before_workout")}<br/>{t("plateau_schedule")}</div></Card>
    <Kicker>{t("upcoming_workouts")}</Kicker>
    {data.reminders.length===0?<Card><div style={{textAlign:"center",padding:"16px 0"}}><div style={{color:C.muted,fontSize:14}}>{t("no_reminders")}</div><button onClick={()=>onNav("plan_workout")} style={{marginTop:10,background:"none",border:`0.5px solid ${C.accent}`,borderRadius:8,padding:"8px 16px",color:C.accent,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>{t("add_plan")}</button></div></Card>:
    <div style={{display:"flex",flexDirection:"column",gap:8}}>{data.reminders.map((r,i)=><Card key={i} onClick={()=>r.id&&onNav&&onNav("planned_detail",{pwId:r.id})} style={{cursor:r.id?"pointer":"default"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:C.text,marginBottom:4}}>{r.title}</div>
            <div style={{fontSize:12,color:C.accent,fontFamily:"monospace"}}>🔔 {fmt(r.dt)}</div>
          </div>
          {r.id&&<span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>→</span>}
        </div>
      </Card>)}</div>}
  </div>;
}




// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
function LeaderboardScreen({tgId,onBack}){
  const [data,setData]=useState(null);
  useEffect(()=>{
    if(!tgId)return;
    fetch(`${API}/leaderboard?tg_id=${tgId}&limit=20`)
      .then(r=>r.json()).then(setData).catch(()=>setData(null));
  },[]);

  const rankColors={beginner:"#CD7F32",athlete:"#C0C0C0",champion:"#FFD700",legend:"#00FFFF"};
  const medals=["🥇","🥈","🥉"];

  if(!data)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("loading")}/></div>;

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("rank_label2")}</Kicker>
    <Hero style={{marginBottom:16}}>{t("leaderboard_title")}</Hero>

    {/* Моя позиция */}
    {data.me&&<Card accent style={{marginBottom:16,textAlign:"center"}}>
      <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{t("my_position")}</div>
      <div style={{fontSize:32,fontWeight:700,color:C.accent}}>#{data.my_position}</div>
      <div style={{fontSize:13,color:C.text,marginTop:4}}>{data.me.name} · {data.me.pts} {t("pts_short")}</div>
      <div style={{fontSize:11,color:C.muted,marginTop:2}}>{data.me.rank}</div>
    </Card>}

    {/* Топ лидеров */}
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {(data.leaders||[]).map((l,i)=>(
        <Card key={i} style={{
          border:l.is_me?`0.5px solid ${C.accent}`:undefined,
          background:l.is_me?"rgba(200,255,0,0.05)":C.card,
        }}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:32,textAlign:"center",flexShrink:0}}>
              {i<3
                ?<span style={{fontSize:22}}>{medals[i]}</span>
                :<span style={{fontFamily:"monospace",fontSize:14,color:C.muted}}>#{l.position}</span>
              }
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:600,fontSize:14,color:l.is_me?C.accent:C.text}}>
                {l.name}{l.is_me?" "+t("lb_ty"):""}
              </div>
              <div style={{fontSize:11,color:C.muted,marginTop:2}}>
                {l.rank}
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <Mono size={16}>{l.pts}</Mono>
              <div style={{fontSize:10,color:C.muted}}>{t("pts_short")}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>

    {data.leaders?.length===0&&<Card>
      <div style={{textAlign:"center",padding:"20px 0",color:C.muted}}>
        {t("ui_poka_nikto_ne_v")}
      </div>
    </Card>}
  </div>;
}

// ─── ACHIEVEMENTS ─────────────────────────────────────────────────────────────
function AchievementsScreen({tgId,onBack}){
  const [data,setData]=useState(null);
  useEffect(()=>{
    if(!tgId)return;
    fetch(`${API}/achievements/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData(null));
  },[]);

  if(!data)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text={t("achievements_title2")}/></div>;

  const unlocked=data.achievements.filter(a=>a.unlocked);
  const locked=data.achievements.filter(a=>!a.unlocked);

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{t("gamification_title2")}</Kicker>
    <Hero style={{marginBottom:8}}>{t("achievements_title2")}</Hero>
    <div style={{fontFamily:"monospace",fontSize:12,color:C.muted,marginBottom:20}}>
      {t("unlocked_label")} {data.unlocked_count} / {data.total}
    </div>

    {/* Прогресс-бар */}
    <Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
        <Kicker>{t("progress_title")}</Kicker>
        <span style={{fontFamily:"monospace",fontSize:11,color:C.accent}}>
          {Math.round(data.unlocked_count/data.total*100)}%
        </span>
      </div>
      <ProgressBar pct={Math.round(data.unlocked_count/data.total*100)}/>
    </Card>

    {/* Новые достижения */}
    {data.new?.length>0&&<div style={{marginBottom:16}}>
      {data.new.map((a,i)=>(
        <Card key={i} accent style={{marginBottom:8,padding:"12px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:32}}>{a.emoji}</span>
            <div>
              <div style={{fontSize:11,color:C.accent,fontFamily:"monospace",marginBottom:2}}>{t("new_achievement")}</div>
              <div style={{fontWeight:700,fontSize:15,color:C.text}}>{tField(a,"name")||a.name}</div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>{tField(a,"desc")||a.desc} · +{a.pts} {t("pts_short")}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>}

    {/* Открытые */}
    {unlocked.length>0&&<>
      <Kicker style={{marginBottom:8}}>{t("ach_otkryto")}{unlocked.length})</Kicker>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
        {unlocked.map((a,i)=>(
          <Card key={i} style={{border:`0.5px solid ${C.accent}33`}}>
            <div style={{fontSize:28,marginBottom:6}}>{a.emoji}</div>
            <div style={{fontWeight:600,fontSize:13,color:C.text,marginBottom:3}}>{tField(a,"name")||a.name}</div>
            <div style={{fontSize:11,color:C.muted,lineHeight:1.4,marginBottom:6}}>{tField(a,"desc")||a.desc}</div>
            <div style={{fontFamily:"monospace",fontSize:11,color:C.accent}}>+{a.pts} {t("pts_short")}</div>
            {a.unlocked_at&&<div style={{fontSize:10,color:C.muted,marginTop:4,fontFamily:"monospace"}}>
              {new Date(a.unlocked_at).toLocaleDateString(dateLocale(),{day:"numeric",month:"short"})}
            </div>}
          </Card>
        ))}
      </div>
    </>}

    {/* Заблокированные */}
    {locked.length>0&&<>
      <Kicker style={{marginBottom:8}}>{t("ach_esche_ne_otkryto")}{locked.length})</Kicker>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        {locked.map((a,i)=>(
          <Card key={i} style={{opacity:0.5}}>
            <div style={{fontSize:28,marginBottom:6,filter:"grayscale(1)"}}>🔒</div>
            <div style={{fontWeight:600,fontSize:13,color:C.muted,marginBottom:3}}>{tField(a,"name")||a.name}</div>
            <div style={{fontSize:11,color:C.muted,lineHeight:1.4,marginBottom:6}}>{tField(a,"desc")||a.desc}</div>
            <div style={{fontFamily:"monospace",fontSize:11,color:C.muted}}>+{a.pts} {t("pts_short")}</div>
          </Card>
        ))}
      </div>
    </>}
  </div>;
}

// ── Что нового ──────────────────────────────────────────────────────────────
// Подборка новых функций. Сама всплывает один раз при входе на главный экран —
// после регистрации и согласий, и не поверх перехода по ссылке (приглашение,
// оплата и т.п.). Отметка о показе — на сервере (/api/whats-new), копия в
// localStorage, чтобы не спрашивать сервер на каждом запуске. Открыть заново —
// «Сервисы» → «Что нового». Новая подборка: поменять WN_VERSION (дата выкладки)
// и слайды в whatsNewSlides.
const WN_VERSION="2026-10-25";
const wnKey=tgId=>`gymbot_wn_seen_${tgId||0}`;
function wnLocalSeen(tgId){try{return localStorage.getItem(wnKey(tgId))||"";}catch{return "";}}
function wnStoreSeen(tgId,v){try{localStorage.setItem(wnKey(tgId),v);}catch{}}
function wnMarkSeen(tgId){
  wnStoreSeen(tgId,WN_VERSION);
  if(tgId)fetch(`${API}/whats-new/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:WN_VERSION})}).catch(()=>{});
}
/** Открыта ли Mini App ссылкой, которая сама ведёт на экран: тогда подборку не показываем. */
function startsWithDeepLink(){
  const sp=tg?.initDataUnsafe?.start_param||new URLSearchParams(window.location.search).get("startapp")||"";
  return /^(pw_|fr_|tm_)/.test(sp)||["premium","friends","terms","terms_premium","profile"].includes(sp);
}
function whatsNewSlides(prem){
  const premOn=!!prem?.visible;
  const s=[
    {key:"strength",icon:"⚡",title:t("str_menu"),text:t("wn_str_d").replace("{a}",t("str_lvl_start")).replace("{b}",t("str_lvl_elite")),
     points:[t("wn_str_1"),t("wn_str_2"),t("wn_str_3")],cta:t("wn_str_b"),go:"strength"},
    {key:"food",icon:"🍲",title:t("wn_food_t"),text:t("wn_food_d"),
     points:[t("wn_food_1"),t("wn_food_2"),t("wn_food_3")],cta:t("wn_food_b"),go:"label_scan"},
    {key:"programs",icon:"📋",title:t("prog_menu"),text:t("wn_prog_d"),
     points:[t("wn_prog_1"),t("wn_prog_2"),t(premOn?"wn_prog_3":"wn_prog_3_all")],cta:t("wn_prog_b"),go:"programs"},
    {key:"social",icon:"👥",title:t("soc_menu"),text:t("wn_soc_d"),
     points:[t("wn_soc_1"),t("wn_soc_2"),t("wn_soc_3")],cta:t("wn_soc_b"),go:"social"},
  ];
  if(premOn&&!prem.active){
    const pk=prem.perks||{};
    const points=[];
    if(pk.ai_premium)points.push(t("wn_prem_1").replace("{n}",pk.ai_premium));
    if(pk.food_premium)points.push(t("wn_prem_2").replace("{n}",pk.food_premium));
    points.push(t("wn_prem_3"));
    s.push({key:"premium",icon:"⭐",title:"GymBot Premium",text:t("wn_prem_d"),points,
      cta:prem.trial_available&&prem.trial_days>0?t("wn_prem_trial").replace("{n}",prem.trial_days):t("wn_prem_b"),go:"premium"});
  }
  return s;
}
function WhatsNew({tgId,newUser,onClose,onGo}){
  const [prem]=usePremium(tgId);
  const slides=whatsNewSlides(prem);
  const [i,setI]=useState(0);
  const idx=Math.min(i,slides.length-1);
  const sl=slides[idx];
  const last=idx===slides.length-1;
  const touchX=useRef(null);
  const closeRef=useRef(onClose);
  closeRef.current=onClose;
  useEffect(()=>{
    const prevOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const onKey=e=>{if(e.key==="Escape")closeRef.current();};
    document.addEventListener("keydown",onKey);
    // Системная «Назад» в Telegram закрывает подборку, а не приложение
    const bb=tg?.BackButton;
    let bbOk=false;
    try{bbOk=!!bb&&!!tg?.isVersionAtLeast?.("6.1");}catch{}
    const onBack=()=>closeRef.current();
    if(bbOk){try{bb.onClick(onBack);bb.show();}catch{}}
    return()=>{
      document.body.style.overflow=prevOverflow;
      document.removeEventListener("keydown",onKey);
      if(bbOk){try{bb.offClick(onBack);bb.hide();}catch{}}
    };
  },[]);
  function go(d){
    const n=idx+d;
    if(n<0||n>=slides.length)return;
    setI(n);
    try{tg?.HapticFeedback?.selectionChanged();}catch{}
  }
  return <div role="dialog" aria-modal="true" aria-labelledby="wn-title"
    onTouchStart={e=>{touchX.current=e.touches[0].clientX;}}
    onTouchEnd={e=>{const x0=touchX.current;touchX.current=null;if(x0==null)return;const dx=e.changedTouches[0].clientX-x0;if(dx<-50)go(1);else if(dx>50)go(-1);}}
    style={{position:"fixed",inset:0,zIndex:400,background:C.bg,color:C.text,display:"flex",flexDirection:"column",overflowY:"auto",
      padding:"calc(14px + env(safe-area-inset-top, 0px)) 20px calc(20px + env(safe-area-inset-bottom, 0px))",boxSizing:"border-box"}}>
    <style>{"@keyframes wnIn{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}"}</style>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
      <div style={{fontFamily:"monospace",fontSize:11,letterSpacing:2,color:C.accent}}>{t(newUser?"wn_kicker_new":"wn_kicker")} · {idx+1}/{slides.length}</div>
      <button type="button" onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:13,cursor:"pointer",padding:"10px 0 10px 16px"}}>{t("wn_skip")}</button>
    </div>
    <div key={sl.key} style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",padding:"20px 0 24px",animation:"wnIn .25s ease"}}>
      <div aria-hidden="true" style={{width:84,height:84,borderRadius:24,display:"flex",alignItems:"center",justifyContent:"center",fontSize:42,marginBottom:24,
        background:"rgba(200,255,0,0.08)",border:"0.5px solid rgba(200,255,0,0.35)",boxShadow:"0 0 48px rgba(200,255,0,0.12)"}}>{sl.icon}</div>
      <Hero><span id="wn-title">{sl.title}</span></Hero>
      <div style={{fontSize:15,color:C.text,opacity:0.85,lineHeight:1.55,marginTop:12}}>{sl.text}</div>
      <div style={{marginTop:20,display:"flex",flexDirection:"column",gap:10}}>
        {sl.points.map((p,k)=><div key={k} style={{display:"flex",gap:10,alignItems:"flex-start",fontSize:14,color:C.text,lineHeight:1.45}}>
          <span aria-hidden="true" style={{color:C.accent,fontWeight:700,flexShrink:0}}>✓</span><span>{p}</span>
        </div>)}
      </div>
    </div>
    <div aria-hidden="true" style={{display:"flex",justifyContent:"center",gap:6,marginBottom:16}}>
      {slides.map((s,k)=><span key={s.key} onClick={()=>setI(k)} style={{width:k===idx?22:8,height:8,borderRadius:4,cursor:"pointer",
        background:k===idx?C.accent:C.border,transition:"width .2s"}}/>)}
    </div>
    <Btn accent full onClick={()=>onGo(sl.go)}>{sl.cta}</Btn>
    <Btn full onClick={()=>last?onClose():go(1)} style={{marginTop:10}}>{last?t("wn_done"):t("wn_next")}</Btn>
  </div>;
}

export default function App(){
  function getNav(){const s=window.history.state;return s&&s._g?s:{_g:true,tab:"menu",screen:null,params:{}};}
  const [nav,setNav]=useState(getNav);
  const {tab,screen,params={}}=nav;

  // Профиль с прошлого запуска — чтобы не держать экран загрузки, пока идёт
  // запрос. Свежий придёт в loadUser и заменит его.
  const [user,setUser]=useState(()=>{
    const id=tg?.initDataUnsafe?.user?.id;
    const u=id?swrRead(`${API}/user/${id}`):null;
    return u&&u.telegram_id===id?{...u,_disk:true}:null;
  });
  // Триггер перерисовки при смене языка. Начальное значение берём из того же
  // хранилища, что и LANG_STORE, иначе они разойдутся на первом рендере и
  // каталог будет запрошен не на том языке, на котором рисуется интерфейс.
  // Функцией, а не вызовом: иначе localStorage читался бы на каждом рендере.
  const [lang,setLang]=useState(readStoredLang);
  const [workouts,setWorkouts]=useState(null);
  const [stats,setStats]=useState(null);
  const [exercises,setExercises]=useState(null);
  const [muscleGroups,setMuscleGroups]=useState(null);
  const [plannedRefresh,setPlannedRefresh]=useState(0);
  const [menuRefresh,setMenuRefresh]=useState(0);
  const tgId=tg?.initDataUnsafe?.user?.id;
  // «Что нового»: {newUser} — показать подборку; deepLinked — открыты ссылкой на экран, не мешаем
  const [wn,setWn]=useState(null);
  const wnAsked=useRef(false);
  const deepLinked=useRef(startsWithDeepLink());

  function push(tab,screen,params={}){const s={_g:true,tab,screen,params};window.history.pushState(s,"");setNav(s);}
  function replace(tab,screen,params={}){const s={_g:true,tab,screen,params};window.history.replaceState(s,"");setNav(s);}
  // Номер последнего запроса профиля. Ответы приходят не по порядку: при
  // медленном старте человек успевает сменить язык, и запоздавший первый ответ
  // со старым языком перебил бы новый. Применяем только ответ на последний запрос.
  const loadSeq=useRef(0);
  const loadInflight=useRef(0);
  // Фоновый повтор, пока на экране профиль с диска. Пока предыдущий запрос
  // летит, новый не шлём: иначе на медленной связи (ответ дольше 20 с) каждый
  // повтор отменял бы предыдущий, и свежий профиль не доехал бы никогда.
  function retryUser(){
    if(loadInflight.current>0||document.visibilityState==="hidden")return;
    loadUser();
  }
  function loadUser(){
    if(tgId){
      const my=++loadSeq.current;
      loadInflight.current++;
      fetch(`${API}/user/${tgId}`)
        .then(r=>{
          if(my!==loadSeq.current)return null;
          if(r.status===404){
            swrDrop([`/user/${tgId}`,`/home/${tgId}`]);
            // Пользователь не найден в БД — новая регистрация через Mini App
            setUser({first_name:tg?.initDataUnsafe?.user?.first_name||t("onb_atlet"),ai_requests_today:0,_not_found:true});
            return null;
          }
          if(!r.ok) throw new Error(r.status);
          return r.json();
        })
        // normLang, а не d.lang как есть: в users.lang мог попасть код в другом
        // регистре или "kk" вместо "kz". Тогда интерфейс не нашёл бы такой ключ
        // в T и рисовался бы по-русски, а каталог сервер отдал бы на казахском —
        // вперемешку. Нормализуем в одном месте, у входа.
        .then(d=>{if(d&&my===loadSeq.current){swrWrite(`${API}/user/${tgId}`,d);setUser(d);const lc=normLang(d.lang)||"ru";LANG_STORE.current=lc;storeLang(lc);setLang(lc);}})
        // Нет связи, а профиль уже есть (с диска или от прошлой загрузки) —
        // оставляем его: приложение работает на нём, а не падает в заглушку.
        .catch(()=>{if(my===loadSeq.current)setUser(p=>p&&p.telegram_id===tgId?p:{first_name:tg?.initDataUnsafe?.user?.first_name||t("onb_atlet"),ai_requests_today:0,_error:true});})
        .finally(()=>{loadInflight.current--;});
    } else {
      setUser({first_name:t("onb_atlet"),ai_requests_today:0});
    }
  }

  useEffect(()=>{
    tg?.ready();tg?.expand();
    // Обрабатываем deep link startapp=pw_ID
    const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(window.location.search).get("startapp");
    if(startParam?.startsWith("pw_")){
      const pwId=parseInt(startParam.replace("pw_",""));
      if(pwId)setTimeout(()=>push("workout","planned_detail",{pwId}),500);
    }
    if(startParam?.startsWith("ref_")){
      const refCode=startParam.replace("ref_","");
      if(refCode)sessionStorage.setItem("gymbot_ref_code",refCode);
    }
    if(startParam==="premium"){
      // /premium в боте ведёт сюда
      setTimeout(()=>push("menu","premium",{}),500);
    }
    if(startParam?.startsWith("fr_")||startParam?.startsWith("tm_")){
      // Приглашение в друзья или в команду: обработаем, когда пользователь загрузится
      // (новичок — после регистрации; приглашение другом сервер засчитает и как реферальное).
      const code=startParam.slice(3);
      try{sessionStorage.setItem("gymbot_social",JSON.stringify({type:startParam.slice(0,2),code}));}catch{}
    }
    if(startParam==="friends"){
      setTimeout(()=>push("menu","social",{}),500);
    }
    if(startParam==="terms"||startParam==="terms_premium"){
      // /terms в боте
      setTimeout(()=>push("menu","terms",{section:startParam==="terms_premium"?"premium":null}),500);
    }
    if(startParam==="profile"){
      // Кнопки бота "Создать/Обновить/Изменить профиль" ведут сразу в Mini App
      setTimeout(()=>push("menu","profile",{}),500);
    }
    // Инжектируем CSS для date/time пикеров в тёмной теме
    if(!document.getElementById("gymbot-datepicker-style")){
      const s=document.createElement("style");s.id="gymbot-datepicker-style";
      s.textContent='input[type="date"],input[type="time"]{color-scheme:dark;} input[type="date"]::-webkit-calendar-picker-indicator,input[type="time"]::-webkit-calendar-picker-indicator{filter:invert(1) brightness(0.8) sepia(1) hue-rotate(60deg);cursor:pointer;}';
      document.head.appendChild(s);
    }
    swrSweep(tgId,LANG_STORE.current||"ru");
    loadUser();
    if(!window.history.state?._g)window.history.replaceState({_g:true,tab:"menu",screen:null,params:{}},"");
    function onPop(e){const s=e.state;if(s&&s._g){setNav(s);if(s.tab==="menu"&&!s.screen)setMenuRefresh(r=>r+1);}else{const h={_g:true,tab:"menu",screen:null,params:{}};window.history.replaceState(h,"");setNav(h);}}
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);

  // Профиль с прошлого запуска, а свежий не пришёл (нет связи, сервер
  // выкладывается) — пробуем ещё: при возврате связи, при возврате в приложение
  // и раз в 20 секунд. Без этого экран профиля ждал бы до перезапуска.
  const userFromDisk=!!user?._disk;
  useEffect(()=>{
    if(!userFromDisk)return;
    const again=()=>retryUser();
    window.addEventListener("online",again);
    document.addEventListener("visibilitychange",again);
    const iv=setInterval(again,20000);
    return()=>{window.removeEventListener("online",again);document.removeEventListener("visibilitychange",again);clearInterval(iv);};
  },[userFromDisk]);

  // Каталог упражнений: описание и технику сервер отдаёт уже на нужном языке,
  // поэтому язык входит в адрес запроса, а значит и в ключ кэша. Переключение
  // туда и обратно бесплатно — вторая версия уже лежит в кэше. А вот первая
  // смена языка это полноценный запрос, кэш тут не спасает.
  //
  // Эффект срабатывает дважды, если язык из localStorage не совпал с языком
  // из профиля. И вот что важно: ответ «не на том» языке выбрасывать нельзя.
  // От языка в нём зависят ровно два поля — описание и техника, а названия
  // (они приезжают сразу на четырёх языках), фотографии, видео, сложность и
  // группы мышц одинаковы для любого языка. Если такой ответ отбросить,
  // каталог и выбор упражнений стоят пустыми — без лоадера, просто
  // «0 упражнений» — пока не приедет второй запрос. Поэтому показываем что
  // приехало, и заменяем, когда придёт нужный язык.
  const haveCatalogLang = useRef(null);  // язык данных, которые уже на экране
  const wantCatalogLang = useRef(null);  // язык, который нужен прямо сейчас
  const [catalogRetry,setCatalogRetry]=useState(0);
  const catalogTries = useRef({lang:null,n:0});  // счётчик попыток, свой на каждый язык
  // На экране каталог с прошлого запуска, свежий ещё не приходил. Отдельно от
  // haveCatalogLang: язык у него правильный, но если запрос упадёт, повторять
  // всё равно нужно — иначе сессия так и пройдёт на недельной копии.
  const catalogFromDisk = useRef(false);
  useEffect(()=>{
    const want = lang || "ru";
    wantCatalogLang.current = want;
    const apply=(d,stale)=>{
      indexCatalogNames(d.exercises,d.muscle_groups);
      setExercises(d.exercises||[]);setMuscleGroups(d.muscle_groups||[]);
      // После заглушки оставляем метку пустой, чтобы правильный язык её сменил.
      haveCatalogLang.current = stale ? null : want;
    };
    let timer=null;
    // Тот же язык с прошлого запуска — показываем сразу, свежий заменит
    if(haveCatalogLang.current!==want){
      const cached=swrRead(`${API}/exercises?lang=${encodeURIComponent(want)}&lite=1`);
      if(cached?.exercises?.length){apply(cached,false);catalogFromDisk.current=true;}
    }
    // lite=1: каталог без текстов техники — они почти весь вес ответа, а читают
    // их по одному при открытии карточки (useExerciseText догружает).
    apiGet(`${API}/exercises?lang=${encodeURIComponent(want)}&lite=1`)
      .then(d=>{
        const stale = wantCatalogLang.current !== want;
        // Нужный язык уже на экране — чужой ответ только испортит описания.
        if(stale && haveCatalogLang.current) return;
        apply(d, stale);
        if(!stale) catalogFromDisk.current=false;
      })
      .catch(()=>{
        // Пустой список ставим только если показывать всё равно нечего.
        // Иначе упавший перезапрос при смене языка обнулил бы рабочий каталог.
        setExercises(p=>p||[]);setMuscleGroups(p=>p||[]);
        // А вот это обязательно. Эффект завязан только на язык, и если запрос
        // нужного языка упал (вошёл в лифт в момент переключения), повторить
        // его больше некому: язык уже не меняется, с экрана каталога и обратно
        // запроса нет. Человек остался бы с русскими описаниями под узбекским
        // интерфейсом до перезапуска приложения.
        //
        // Попыток три, и счётчик свой на каждый язык — иначе при недоступном
        // сервере приложение дёргало бы каталог каждые четыре секунды до
        // закрытия, а исчерпав общий лимит, не повторило бы запрос при
        // следующей смене языка.
        const tries = catalogTries.current.lang===want ? catalogTries.current.n : 0;
        if(wantCatalogLang.current===want && (haveCatalogLang.current!==want || catalogFromDisk.current) && tries<3){
          catalogTries.current={lang:want,n:tries+1};
          timer=setTimeout(()=>setCatalogRetry(n=>n+1), 4000);
        }
      });
    return()=>{ if(timer) clearTimeout(timer); };
  },[lang,catalogRetry]);

  useEffect(()=>{
    if(tab==="workout"&&!workouts){
      if(tgId){
      fetch(`${API}/workouts/${tgId}`).then(r=>r.json()).then(d=>{
        setWorkouts(d.workouts||[]);
        // Проверяем активную тренировку в БД
        const active=(d.workouts||[]).find(w=>w.status==="active");
        if(active&&!localStorage.getItem("gymbot_active_workout")){
          // Сохраняем в localStorage для показа баннера
          localStorage.setItem("gymbot_active_workout",JSON.stringify({
            workoutId:active.id,step:4,selExs:[],sets:{},curIdx:0,
            startTime:Date.now(),savedAt:Date.now(),
          }));
        }
      }).catch(()=>setWorkouts([]));
    }
      else setWorkouts([]); // без tgId показываем пустой список вместо вечного лоадера
    }
    if(tab==="progress"&&!stats){
      if(tgId)fetch(`${API}/stats/${tgId}`).then(r=>r.json()).then(setStats).catch(()=>setStats({}));
      else setStats({});
    }
  },[tab]);

  function handleTabChange(t){push(t,null,{});if(t==="menu")setMenuRefresh(r=>r+1);}
  function handleNav(s,p={}){
    if(s==="my_workouts"){push("workout",null,{});return;}
    if(s==="tab_ai"){push("ai",null,{});return;}
    if(s==="repeat_last"){
      if(!tgId)return;
      fetch(`${API}/workouts/${tgId}/last-full`).then(r=>r.json()).then(d=>{
        const ids=(d?.exercises||[]).map(e=>e.exercise_id).filter(Boolean);
        if(!d?.found||!ids.length){window.alert(t("alt_no_last"));return;}
        push(tab,"active_workout",{preselectedExIds:ids});
      }).catch(()=>window.alert(t("home_load_error")));
      return;
    }
    push(tab,s,p);
  }
  // Приглашение в друзья/команду из ссылки — когда человек уже есть и согласия даны
  useEffect(()=>{
    if(!user||user._not_found||!(user.consents?.terms&&user.consents?.basic))return;
    let pending=null;
    try{pending=JSON.parse(sessionStorage.getItem("gymbot_social")||"null");}catch{}
    if(!pending?.code)return;
    try{sessionStorage.removeItem("gymbot_social");}catch{}
    setTimeout(()=>push("menu","social",pending.type==="fr"?{accept:pending.code}:{join:pending.code}),400);
  },[user?.telegram_id,user?._not_found,user?.consents?.terms,user?.consents?.basic]);
  // «Что нового»: один раз за запуск спрашиваем, видел ли человек текущую подборку
  useEffect(()=>{
    if(wnAsked.current||!tgId||!user||user._not_found||user._error||!(user.consents?.terms&&user.consents?.basic))return;
    if(deepLinked.current)return;
    wnAsked.current=true;
    if(wnLocalSeen(tgId)>=WN_VERSION)return;
    fetch(`${API}/whats-new/${tgId}`).then(r=>r.ok?r.json():null).then(d=>{
      if(!d)return;
      if(d.seen&&d.seen>=WN_VERSION){wnStoreSeen(tgId,d.seen);return;}
      setWn({newUser:!!d.new_user});
    }).catch(()=>{});
  },[user?.telegram_id,user?._not_found,user?._error,user?.consents?.terms,user?.consents?.basic]);
  function closeWn(){wnMarkSeen(tgId);setWn(null);}
  const goBack=()=>window.history.back();

  function render(){
    const p=params||{};
    if(screen==="profile")return <ProfileScreen user={user} tgId={tgId} onBack={goBack} onUserUpdated={loadUser} onNav={handleNav}/>;
    if(screen==="more")return <MoreScreen user={user} onNav={handleNav} onBack={goBack}/>;
    if(screen==="alternatives")return <AlternativesScreen tgId={tgId} onNav={handleNav} onBack={goBack}/>;
    if(screen==="training_prefs")return <TrainingPrefsScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="active_workout")return <ActiveWorkoutScreen tgId={tgId} user={user} onUserUpdated={loadUser} exercises={exercises} muscleGroups={muscleGroups} onBack={goBack} onFinish={()=>setWorkouts(null)} onFinishNav={()=>{setPlannedRefresh(r=>r+1);replace("workout",null,{});if(tgId)fetch(`${API}/workouts/${tgId}`).then(r=>r.json()).then(d=>setWorkouts(d.workouts||[])).catch(()=>setWorkouts([]));}} onNav={handleNav} preselectedExIds={p.preselectedExIds||[]} preselectedGroupIds={p.preselectedGroupIds||[]} plannedWorkoutId={p.plannedWorkoutId||null} exerciseTips={p.exerciseTips||{}} programDay={p.programDay??null}/>;
    if(screen==="workout_detail")return <WorkoutDetailScreen workoutId={p.workoutId} tgId={tgId} onBack={goBack}/>;
    if(screen==="my_workouts_detail")return <MyWorkoutsDetailScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="planned_detail")return <PlannedDetailScreen pwId={p.pwId} tgId={tgId} onBack={goBack} exercises={exercises} muscleGroups={muscleGroups} readOnly={p.readOnly||false} onNav={handleNav}/>;
    if(screen==="plan_workout")return <PlanWorkoutScreen tgId={tgId} exercises={exercises} muscleGroups={muscleGroups} onBack={goBack}/>;
    if(screen==="goals")return <GoalsScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="reminders")return <RemindersScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="food_vision")return <FoodVisionScreen tgId={tgId} onBack={goBack} mealType={p.meal_type} onNav={handleNav}/>;
    if(screen==="sport_log")return <SportLogScreen tgId={tgId} onBack={goBack} initialSport={p.initial_sport||null}/>;
    if(screen==="referral")return <ReferralScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="premium")return <PremiumScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="terms")return <TermsScreen tgId={tgId} section={p.section} onBack={goBack}/>;
    if(screen==="strength")return <StrengthScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="programs")return <ProgramsScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="social")return <SocialScreen tgId={tgId} onBack={goBack} accept={p.accept||null} join={p.join||null} tab={p.tab||null}/>;
    if(screen==="program_detail")return <ProgramDetailScreen tgId={tgId} slug={p.slug} onBack={goBack} onNav={handleNav}/>;
    if(screen==="achievements")return <AchievementsScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="leaderboard")return <LeaderboardScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="gamification")return <GamificationScreen tgId={tgId} onBack={goBack} user={user}/>;
    if(screen==="food_search")return <FoodSearchScreen tgId={tgId} onBack={goBack} onNav={handleNav} mealType={p.meal_type}/>;
    if(screen==="label_scan")return <LabelScanScreen tgId={tgId} onBack={goBack} onNav={handleNav} mealType={p.meal_type}/>;
    if(screen==="nutrition")return <NutritionScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="food_guide")return <FoodGuideScreen onBack={goBack}/>;
    if(screen==="measurements")return <MeasurementsScreen onBack={goBack} tgId={tgId}/>;
    if(screen==="checkin")return <CheckinScreen onBack={goBack} tgId={tgId}/>;
    if(screen==="supplements")return <SupplementsScreen onBack={goBack} user={user} onRetry={loadUser}/>;
    if(screen==="rest_timer")return <StandaloneTimer onBack={goBack}/>;
    if(screen==="language")return <LanguageScreen tgId={tgId} user={user} onBack={goBack} onUserUpdated={(code)=>{loadUser();if(code)setLang(code);}}/>;
    if(screen==="support")return <SupportScreen onBack={goBack} tgId={tgId}/>;
    if(screen==="whats_new")return <WhatsNew tgId={tgId} newUser={false} onClose={()=>{wnMarkSeen(tgId);goBack();}} onGo={s=>{wnMarkSeen(tgId);replace("menu",s,{});}}/>;
    if(tab==="menu")return <MenuScreen key={lang+"_"+menuRefresh} user={user} onNav={handleNav} activeWorkout={hasResumableActiveWorkout()}/>;
    if(tab==="workout")return <WorkoutHistoryScreen workouts={workouts} onNav={handleNav} tgId={tgId} refreshToken={plannedRefresh}/>;
    if(tab==="progress")return <ProgressScreen stats={stats} tgId={tgId} onNav={handleNav}/>;
    if(tab==="catalog")return <CatalogScreen exercises={exercises} muscleGroups={muscleGroups} onNav={handleNav}/>;
    if(tab==="ai")return <AIScreen user={user} tgId={tgId} onNav={handleNav} exercises={exercises}/>;
  }

  // Онбординг для новых пользователей
  if(user?._not_found)return<OnboardingScreen tgId={tgId} tgUser={tg?.initDataUnsafe?.user} onComplete={()=>{setUser(null);loadUser();}}/>;
  // Согласие у тех, кто зарегистрировался до его появления: новые дают его
  // в онбординге, а существующие иначе остались бы без отметки навсегда.
  // Профиль не загрузился (нет связи, сервер недоступен). Раньше заглушка без
  // отметок о согласии попадала на экран согласия, и человек думал, что оно
  // слетело, а нажать «Принимаю» без сети всё равно нельзя.
  if(user?._error)return<OfflineScreen onRetry={()=>{setUser(null);loadUser();}}/>;
  if(user&&!(user.consents?.terms&&user.consents?.basic))return<ConsentGateScreen tgId={tgId} onDone={()=>{setUser(null);loadUser();}}/>;
  // Загрузка
  if(!user)return<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:C.bg}}><Loader text={t("loading")}/></div>;

  return <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",position:"relative"}}>
    <div style={{
      position:"fixed",inset:0,zIndex:0,pointerEvents:"none",
      backgroundImage:"url(/gymbot-miniapp/watermark.png)",
      backgroundRepeat:"no-repeat",
      backgroundPosition:"center 30%",
      backgroundSize:"min(420px, 90vw)",
    }}/>
    <div style={{position:"relative",zIndex:1}}>
      {render()}
      <NavBar active={tab} onChange={handleTabChange}/>
      {wn&&tab==="menu"&&!screen&&<WhatsNew tgId={tgId} newUser={wn.newUser} onClose={closeWn} onGo={s=>{closeWn();push("menu",s,{});}}/>}
    </div>
  </div>;
}
