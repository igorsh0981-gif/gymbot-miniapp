// Что должно получиться в каждом сценарии e2e/run.mjs. Функция получает то,
// что вернул сценарий, и отдаёт список расхождений (пустой — всё в порядке).
const eq = (name, got, want) => JSON.stringify(got) === JSON.stringify(want) ? [] : [`${name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`];
const all = (...xs) => xs.flat();

export const CHECKS = {
  // экран подхода: фото, «прошлый раз», подстановка веса
  "01_set_screen": r => all(eq("фото", r.hasPhoto, 1), eq("прошлый раз", r.lastTime, 1), eq("вес", r.weightPrefill, "62.5")),
  "01b_set_screen_scrolled": () => [],
  // шторка техники: открывается, BackButton Telegram, техника догружается пачкой
  "02_sheet": r => all(eq("шторка", r.dialog, 1), eq("BackButton", r.backButtonShown, true), eq("техника", r.techniqueLoaded, true),
                      eq("лёгкий каталог", r.catalogLite, true), (r.batch || []).length >= 1 ? [] : ["нет пакетного запроса техники"]),
  "02b_sheet_closed_by_back": r => all(eq("закрыта", r.dialogAfterBack, 0), eq("BackButton скрыт", r.backButtonHidden, true)),
  "03_photo_missing": r => all(eq("строка вместо фото", r.fallbackRow, 1), eq("битая картинка", r.brokenImg, 0)),
  // офлайн: подход сразу на экране, уходит при возврате связи
  "04_set_offline_queue": r => all(r.instantMs < 1000 ? [] : [`подход появился через ${r.instantMs} мс`], eq("в очереди", r.queued, 1),
                                   eq("очередь пуста", r.afterRetryQueue, 0), eq("сервер получил", r.serverGot, 1),
                                   eq("номер подхода", r.body?.set_number, 2), eq("индикатор ушёл", r.indicatorGone, true)),
  "05_kz": r => all(eq("кнопка", r.setDoneKz, 1), eq("прошлый раз", r.lastTimeKz, 1), eq("группа", r.groupKz, 1)),
  "06_log_then_next": r => all(eq("подстановка после подхода", r.afterLog, ["62.5", "7"]), eq("поля на следующем", r.afterNext, ["", ""]), eq("упражнение", r.nextEx, 2)),
  "07_requests_per_workout": r => all(eq("подходы", r.setsSent, [2, 3]),
                                      eq("каталог за тренировку", r.afterNav?.["GET /exercises"], 1),
                                      eq("прошлый раз пачкой", r.afterNav?.["POST /exercises/{tg}/last-sets-batch"], 1)),
  "08_cancel_after_set": r => all(eq("порядок", r.order, ["set", "cancel"]), eq("подходов", r.sets, 1)),
  "09_double_tap": r => eq("двойное нажатие", r.setsSent, [2]),
  // мгновенный первый кадр с диска
  "10_home_instant_from_disk": r => eq("загрузка на 400 мс", r.loaderAt400, 0),
  "11_home_no_disk_cache": r => eq("загрузка без кэша", r.loaderAt400, 1),
  "12_offline_start_keeps_cached_user": r => all(eq("экран согласия", r.consentGate, 0), eq("меню", r.navBar, 1)),
  "13_health_not_on_disk": r => all(eq("профиль на диске", r.stored, true), eq("здоровье на диске", r.hasMedical, false), eq("согласия на диске", r.hasConsents, true)),
  "14_prime_then_offline_sheet": r => all(eq("пачка", r.batch, ["101,102,103"]), eq("техника без связи", r.shownOffline, 1),
                                          eq("на диске", r.onDisk, 3), eq("лишние запросы", r.singleRequestsWhileOffline, 0)),
  "15_sheet_offline_no_cache": r => all(eq("сообщение о связи", r.offlineMsg, 1), eq("загрузилось после связи", r.loadedAfterOnline, 1)),
  "16_disk_catalog_still_retries": r => all(eq("каталог с диска", r.shownFromDisk, 1), r.catalogRequests >= 2 ? [] : [`повтор каталога: ${r.catalogRequests}`]),
  "17_profile_offline_disk_user": r => all(eq("кнопка повтора", r.retryBtn, 1), r.userReqAfter > r.userReqBefore ? [] : ["профиль не перезапрошен после связи"]),
  "18_sweep_on_start": r => eq("осталось на диске", [...(r.left || [])].sort(), ["/exercises?lang=ru&lite=1", "/home/123456789", "/user/123456789"]),
  "19_catalog_detail_loads_technique": r => all(eq("запрос техники", r.details, [101]), eq("описание", r.descShown, 1)),
  "20_old_saved_workout_primes_from_catalog": r => eq("пачка", r.batch, ["101,102,103"]),
  "21_details_502_no_offline_msg": r => all(eq("ложное «нет связи»", r.offlineMsg, 0), eq("многоточие", r.dots, 0), eq("описание", r.desc, 1)),
  "22_quota_keeps_technique": r => all(eq("техника осталась", (r.keys || []).filter(k => k.includes("/details?lang=ru")).length, 3),
                                       (r.keys || []).includes("/home/123456789") ? [] : ["главный экран не записан"]),
  // закрытая на сервере тренировка
  "26_closed_elsewhere": r => all(eq("пояснение", r.notice, 1), eq("локальная копия", r.localWorkoutId, null), eq("экран подхода", r.setScreen, 0)),
  // сутки по Ташкенту в дневнике питания
  "32_nutrition_tashkent_night": r => all(eq("запросы", r.reqs, ["/nutrition/{tg}", "/nutrition/{tg}/history?date=2026-10-23", "/nutrition/{tg}"]),
                                          eq("подпись вчера", r.dayLabel, 1)),
  // названия упражнений в истории — на языке приложения, дата — местная
  "33_workout_detail_en": r => all(eq("название", r.nameEn, 1), eq("дата", r.date, 1)),
  // разбор тренера потоком; запасной путь — обычный запрос, разбор сохраняется один раз
  "34_finish_review_stream": r => all(eq("запросы", r.aiCalls, ["stream"]), eq("сохранён", r.saved, ["Хорошая работа: жим прибавил 2,5 кг."]), eq("курсор убран", r.cursor, 0)),
  "35_finish_review_fallback": r => all(eq("запросы", r.aiCalls, ["stream", "ask"]), eq("сохранён", r.saved, ["Запасной разбор тренировки."])),
  "36_finish_empty_workout": r => all(eq("разбор не запрашивали", r.aiCalls, []), eq("флаг очереди", r.body?.has_unsent, false), eq("нет «анализирую»", r.analyzing, 0)),
  "30_new_workout_during_slow_check": r => all(eq("пояснение", r.notice, 0), r.localWorkoutId ? [] : ["новая тренировка стёрта"]),
  // без связи при первом запуске — не экран согласия
  "27_offline_first_start": r => all(eq("экран связи", r.offlineShown, 1), eq("экран согласия", r.consent, 0), eq("восстановилось", r.recovered, 1)),
  // лимит распознавания еды
  "28_food_quota_ok": r => all(eq("остаток", r.quotaLine, "Распознаваний на сегодня: 7 из 10"), eq("результат", r.result, 1), eq("сообщение о лимите", r.limitMsg, 0)),
  "29_food_limit_reached": r => all(eq("сообщение о лимите", r.limitMsg, 1), eq("результат", r.result, 0)),
  // Premium: оплата через openInvoice, ожидание продления, пробный период, вход с лимита
  "37_premium_buy_month": r => all(eq("план", r.plan, "month"), eq("счёт", (r.calls || []).map(c => c.slice(0, 2)), [["openInvoice", "https://t.me/$invoice-month"]]),
                                   eq("выгода года", r.save, 1), eq("лимит тренера", r.perks, 1)),
  "38_premium_trial": r => all(eq("запросов", r.trials, 1), eq("кнопка пропала", r.trialBtn, 0)),
  "40_premium_entry_points": r => all(eq("подсказка", r.nudge, 1), eq("экран Premium", r.opened, 1)),
  // карточка тренировки: история и чат через Telegram; старый клиент — в чат с ботом
  "39_finish_share": r => all(eq("запросы", r.share, ["card:77", "prepared:77"]),
                              eq("история", (r.calls || []).filter(c => c[0] === "shareToStory").map(c => [c[1], c[2]?.text]),
                                 [["https://api.test/api/share/img/77.story.ru.1.x.jpg", "Грудь 💪 t.me/GYMASH_bot"]]),
                              eq("чат", (r.calls || []).filter(c => c[0] === "shareMessage").map(c => c[1]), ["prep-1"])),
  "41_workout_detail_share_old_client": r => all(eq("запросы", r.share, ["send:555"]), eq("методы Telegram", (r.calls || []).length, 0)),
};
