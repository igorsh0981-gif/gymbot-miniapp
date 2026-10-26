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
  "43_home_premium_entry": r => all(eq("пункт на главной", r.entry, 1), eq("экран Premium", r.opened, 1)),
  "42_story_on_desktop_goes_to_bot": r => all(eq("запросы", r.share, ["send:555"]), eq("методы Telegram", (r.calls || []).length, 0)),
  // правила использования: раздел Premium с ценами из настроек, вход из «Сервисов»
  "44_premium_terms": r => all(eq("цены", r.prices, 1), eq("пробный", r.trial, 1), eq("возврат", r.refund, 1), eq("отмена", r.cancel, 1)),
  "45_more_terms": r => all(eq("открылись", r.opened, 1), eq("общие положения", r.general, 1)),
  // силовые ранги: общий ранг, шаг до следующего уровня (кг и повторы), сравнение с людьми, без профиля — на профиль
  "46_strength_screen": r => all(eq("общий", r.overall, 1), eq("до следующего", r.next, 1), eq("подход", r.from, 1),
                                 eq("повторы", r.reps, 1), eq("среди людей", r.community, 1), eq("без ранга", r.untracked, 1)),
  "47_strength_missing_profile": r => all(eq("кнопка", r.msg, 1)),
  "48_progress_strength_card": r => all(eq("открыли ранги", r.opened, 1)),
  // сканер этикеток: распознали, порция с упаковки, сохранили с записью в дневник; не этикетка — понятное сообщение
  "49_label_scan": r => all(eq("распознаваний", r.label, 1), eq("название", r.nameVal, "Йогурт питьевой"), eq("итог на порцию", r.total, 1),
                            eq("сохранение", r.save && [r.save.name, r.save.brand, r.save.kcal, r.save.weight_g, r.save.meal_type],
                               ["Йогурт питьевой", "Musaffo", 70, 250, "lunch"])),
  "50_label_not_found": r => all(eq("сообщение", r.msg, 1), eq("сохранений", r.saves, 0)),
  // местная кухня: категория, узбекские названия, порция
  "51_food_search_national_uz": r => all(eq("порция", r.portion, 1), eq("кнопка сканера", r.scanBtn, 1), eq("запрос категории", r.query, 1)),
  // программы: активная со следующим днём, бейджи, старт дня передаёт program_day, закрытая — на Premium
  "52_programs_list": r => all(eq("прогресс", r.progress, 1), eq("следующий день", r.next, 1), eq("premium", r.premium, 1), eq("бесплатно", r.free, 1), eq("мета", r.meta, 1)),
  "53_program_start_day": r => all(eq("повторы в секундах", r.reps, 1), eq("нет в каталоге", r.missing, 1), eq("подпись состава", r.hint, 1),
                                   eq("старт с днём", r.start && [r.start.program_day, r.start.exercise_ids], [1, [101]])),
  "54_program_locked": r => all(eq("на Premium", r.toPremium, 1), eq("стартов", r.starts, 0)),
  // друзья, лента, команды
  "55_social_accept_invite": r => all(eq("до согласия не принимаем", r.acceptsBefore, 0), eq("предпросмотр", r.previews, ["ANNA0002"]),
                                      eq("принят код", r.accepts, ["ANNA0002"]), eq("друг в списке", r.friendRow, 1), eq("приватность", r.privacy, 1)),
  "56_social_feed_like": r => all(eq("отметка", r.likes, [901]), eq("ещё упражнения", r.more, 1), eq("сводка", r.meta, 1), eq("свои — «Вы»", r.you > 0 ? 1 : 0, 1)),
  "57_team_join_board": r => all(eq("вступление", r.joins, ["TEAM0007"]), eq("владелец", r.owner, 1), eq("позвать", r.invite, 1)),
  // «Что нового»: 5 слайдов (с Premium), кнопки «Далее»/«Готово», отметка на сервере и в телефоне, Назад Telegram закрывает,
  // кнопка слайда открывает функцию, второй раз не спрашиваем, поверх ссылки не показываем, пункт в «Сервисах»
  "58_whats_new_tour": r => all(eq("первый слайд", r.first, 1), eq("уровни", r.levels, 1), eq("Назад Telegram", r.bb, true),
                                eq("слайды", r.titles, ["Силовые ранги", "Плов, лагман, самса", "Программы тренировок", "Друзья и команды", "Напомните другу", "Настройки в друзьях", "Друзья — в достижения", "GymBot Premium"]),
                                eq("пробный", r.trialCta, 1), eq("лимиты", r.perks, 1), eq("закрыта", r.dialogAfter, 0),
                                eq("отметка", r.posts, ["2026-10-25d"]), eq("в телефоне", r.ls, "2026-10-25d"), eq("Назад скрыта", r.bbAfter, false)),
  "59_whats_new_cta_opens_feature": r => all(eq("отметка", r.posts, ["2026-10-25d"]), eq("закрыта", r.dialog, 0), eq("экран программ", r.programs > 0 ? 1 : 0, 1), eq("запрос программ", r.programsReq > 0 ? 1 : 0, 1)),
  "60_whats_new_swipe_and_back": r => all(eq("новичку", r.kicker, 1), eq("свайп влево", r.afterLeft, 1), eq("свайп вправо", r.afterRight, 1),
                                         eq("Назад закрыла", r.dialogAfterBack, 0), eq("отметка", r.posts, ["2026-10-25d"])),
  "61_whats_new_not_again": r => all(eq("запросов", r.gets, 0), eq("не показана", r.dialog, 0)),
  "62_whats_new_not_over_deeplink": r => all(eq("запросов", r.gets, 0), eq("не показана", r.dialog, 0), eq("открылся Premium", r.premium, 1)),
  "63_whats_new_from_more_uz": r => all(eq("узбекский", r.kicker, 1), eq("без прокрутки вбок", r.overflow, false), eq("закрыта", r.dialog, 0),
                                       eq("ранги открылись", r.strengthReq > 0 ? 1 : 0, 1), eq("отметка", r.posts, ["2026-10-25d"])),
  // видел прошлую подборку — только новый слайд; напоминание другу: кому можно, текст, ошибки, «не доставлено»
  "64_whats_new_only_new": r => all(eq("три новых слайда", r.only, 1), eq("заголовок", r.title, "Напомните другу"), eq("отметка", r.posts, ["2026-10-25d"]), eq("вкладка друзей", r.friendsTab, 1)),
  "65_friend_nudge": r => all(eq("дней без тренировок", r.idle, 1), eq("давно", r.long, 1), eq("кнопок «Напомнить»", r.buttons, 2), eq("уже напомнили", r.done, 1),
                              eq("кому", r.to, 1), eq("закрылось", r.dialogAfter, 0),
                              eq("отправлено", r.nudges, [{ id: 3, text: "Борис, давно тебя не видно — в субботу в зал? 💪" }])),
  "67_whats_new_friends_settings": r => all(eq("два новых слайда", r.only, 1), eq("заголовок", r.title, "Настройки в друзьях"), eq("отметка", r.posts, ["2026-10-25d"]),
                                           eq("переключатель открыт", r.checked, "true")),
  "68_friends_settings": r => all(eq("друг выключил", r.off, 1), eq("было вкл.", r.before, "true"), eq("стало выкл.", r.after, "false"),
                                  eq("запрос", r.privacy, [{ nudges_allowed: false }]), eq("смен ссылки", r.resets, 2), eq("подтверждений", r.confirms, 2),
                                  eq("текст подтверждения", /Старая ссылка перестанет работать/.test(r.confirmText), true),
                                  eq("новая ссылка", r.link, "https://t.me/GYMASH_bot/gymapp?startapp=fr_NEWC0DE1"), eq("без прокрутки вбок", r.overflow, false)),
  "69_invite_decline": r => all(eq("не принято", r.accepts, 0), eq("карточка закрыта", r.card, 0)),
  "70_team_hidden_member": r => all(eq("скрыл тренировки", r.hidden, 1), eq("без null", r.nullText, 0)),
  "72_whats_new_referral_achievements": r => all(eq("один слайд", r.only, 1), eq("заголовок", r.title, "Друзья — в достижения"),
                                                eq("отметка", r.posts, ["2026-10-25d"]), eq("экран приглашения", r.referral, 1)),
  "73_get_hang_retry": r => all(eq("сначала с диска", r.before, 1), eq("обновился", r.after, 1), eq("два запроса", r.requests, 2)),
  "74_consent_gate_ai_label": r => all(eq("новый текст", r.label, 1), eq("без США", r.usa, 0)),
  "71_referral_pending": r => all(eq("ждёт тренировки", r.pending, 1), eq("начислено", r.plus, 1), eq("шаг 2", r.step, 1)),
  "66_friend_nudge_errors": r => all(eq("окно осталось", r.stillOpen, 1), eq("пустой — нельзя", r.disabled, true), eq("запросы", r.nudges, [3, 5])),
};
