import { useState, useEffect } from "react";

const tg = window.Telegram?.WebApp;
const API_BASE = "https://web-production-4fe0b.up.railway.app/api";

const COLORS = {
  bg: "#0F0F0F", surface: "#1A1A1A", card: "#222222",
  accent: "#C8FF00", text: "#FFFFFF", muted: "#888888",
  border: "#2A2A2A", danger: "#FF4444", success: "#00CC66",
};

// ─── ATOMS ───────────────────────────────────────────────────────────────────
function Hero({ children }) {
  return <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: -0.5, lineHeight: 1.15, color: COLORS.text, textTransform: "uppercase" }}>{children}</div>;
}
function Kicker({ children }) {
  return <div style={{ fontFamily: "monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>{children}</div>;
}
function Stat({ value, unit }) {
  return <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 18, color: COLORS.accent }}>{value}{unit ? <span style={{ fontSize: 13, color: COLORS.muted }}> {unit}</span> : null}</span>;
}
function Card({ children, accent, onClick, style = {} }) {
  return <div onClick={onClick} style={{ background: COLORS.card, border: `0.5px solid ${accent ? COLORS.accent : COLORS.border}`, borderRadius: 12, padding: "14px 16px", cursor: onClick ? "pointer" : "default", ...style }}>{children}</div>;
}
function Loader({ text = "ЗАГРУЗКА" }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}><div style={{ textAlign: "center" }}><div style={{ fontFamily: "monospace", fontSize: 12, color: COLORS.accent, letterSpacing: 3 }}>{text}</div><div style={{ color: COLORS.muted, fontSize: 24, marginTop: 8 }}>◌</div></div></div>;
}
function BackBtn({ onBack }) {
  return <button onClick={onBack} style={{ background: "none", border: "none", color: COLORS.muted, fontFamily: "monospace", fontSize: 12, letterSpacing: 1, cursor: "pointer", padding: "0 0 16px 0", display: "block" }}>← НАЗАД</button>;
}
function Btn({ children, onClick, accent, disabled, full, danger, style = {} }) {
  return <button onClick={onClick} disabled={disabled} style={{ width: full ? "100%" : "auto", background: accent ? COLORS.accent : danger ? "#FF444422" : COLORS.card, border: `0.5px solid ${accent ? COLORS.accent : danger ? COLORS.danger : COLORS.border}`, borderRadius: 10, padding: "13px 20px", color: accent ? COLORS.bg : danger ? COLORS.danger : COLORS.text, fontWeight: 700, fontSize: 14, letterSpacing: 0.5, textTransform: "uppercase", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, ...style }}>{children}</button>;
}
function Select({ value, onChange, options }) {
  return <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 8, padding: "10px 14px", color: COLORS.text, fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}

// ─── NAVBAR ──────────────────────────────────────────────────────────────────
function NavBar({ active, onChange }) {
  const tabs = [
    { id: "menu", icon: "⊞", label: "Меню" },
    { id: "workout", icon: "▶", label: "Тренировки" },
    { id: "progress", icon: "↗", label: "Прогресс" },
    { id: "catalog", icon: "☰", label: "Каталог" },
    { id: "ai", icon: "●", label: "Тренер" },
  ];
  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: COLORS.surface, borderTop: `0.5px solid ${COLORS.border}`, display: "flex", padding: "8px 0 calc(8px + env(safe-area-inset-bottom))", zIndex: 100 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 0" }}>
          <span style={{ fontSize: 18, color: active === t.id ? COLORS.accent : COLORS.muted }}>{t.icon}</span>
          <span style={{ fontSize: 10, fontFamily: "monospace", letterSpacing: 0.5, color: active === t.id ? COLORS.accent : COLORS.muted }}>{t.label}</span>
        </button>
      ))}
    </div>
  );
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
function MenuScreen({ user, onNavigate }) {
  const streak = user?.streak_days || 0;
  const goalLabels = { lose_weight: "Похудение", gain_muscle: "Набор массы", gain_strength: "Сила", improve_endurance: "Выносливость", stay_healthy: "Здоровье" };
  const quickActions = [
    { label: "Мои тренировки", icon: "☰", screen: "my_workouts" },
    { label: "Питание", icon: "◈", screen: "nutrition" },
    { label: "Каталог продуктов", icon: "🥗", screen: "food_guide" },
    { label: "Замеры тела", icon: "○", screen: "measurements" },
    { label: "Чек-ин", icon: "✓", screen: "checkin" },
    { label: "Добавки", icon: "◆", screen: "supplements" },
    { label: "Язык", icon: "🌐", screen: "language" },
    { label: "Поддержка", icon: "?", screen: "support" },
  ];
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <div style={{ marginBottom: 20 }}>
        {streak > 0 && <div style={{ fontFamily: "monospace", fontSize: 12, color: COLORS.accent, marginBottom: 8 }}>🔥 {streak} {streak === 1 ? "ДЕНЬ" : "ДНЯ"} ПОДРЯД · НЕ СЛЕЙ СЕРИЮ</div>}
        <Hero>О, ТЫ ВЕРНУЛСЯ{user?.first_name ? `, ${user.first_name.split(" ")[0].toUpperCase()}` : ""}</Hero>
        {user?.desired_result && <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 6, fontFamily: "monospace" }}>ЦЕЛЬ · {goalLabels[user.desired_result] || user.desired_result}</div>}
      </div>
      <Btn accent full onClick={() => tg?.sendData(JSON.stringify({ action: "start_workout" }))} style={{ marginBottom: 16 }}>▶ НАЧАТЬ ТРЕНИРОВКУ</Btn>
      <div style={{ fontFamily: "monospace", fontSize: 10, color: COLORS.muted, letterSpacing: 2, marginBottom: 10 }}>БЫСТРЫЙ ДОСТУП</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        {quickActions.map(a => (
          <Card key={a.screen} onClick={() => onNavigate(a.screen)}>
            <div style={{ fontSize: 18, color: COLORS.accent, marginBottom: 4 }}>{a.icon}</div>
            <div style={{ fontSize: 13, color: COLORS.text, fontWeight: 500 }}>{a.label}</div>
          </Card>
        ))}
      </div>
      {user && (
        <div>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: COLORS.muted, letterSpacing: 2, marginBottom: 10 }}>ПРОФИЛЬ</div>
          <Card onClick={() => onNavigate("profile")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.text }}>{user.first_name}</div>
                <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>{user.age} лет · {user.weight} кг · {user.height} см</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, fontFamily: "monospace", color: COLORS.accent }}>{user.fitness_level?.toUpperCase() || "—"}</div>
                <div style={{ fontSize: 10, color: COLORS.muted, marginTop: 2 }}>ИЗМЕНИТЬ →</div>
              </div>
            </div>
            <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginTop: 10, paddingTop: 10, display: "flex", gap: 16 }}>
              <div><div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>ИМТ</div><Stat value={user.bmi || "—"} /></div>
              <div><div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>AI ЗАПРОСОВ</div><Stat value={`${user.ai_requests_today || 0}/5`} /></div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────
function ProfileScreen({ user, tgId, onBack, onUserUpdated }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    age: user?.age || "", weight: user?.weight || "", height: user?.height || "",
    gender: user?.gender || "male", fitness_level: user?.fitness_level || "beginner",
    desired_result: user?.desired_result || "stay_healthy",
  });

  if (!user) return <div style={{ padding: "16px 16px 100px" }}><BackBtn onBack={onBack} /><Loader text="ЗАГРУЗКА ПРОФИЛЯ" /></div>;

  const goalLabels = { lose_weight: "Похудение", gain_muscle: "Набор массы", gain_strength: "Сила", improve_endurance: "Выносливость", stay_healthy: "Здоровье" };
  const levelLabels = { beginner: "Новичок", intermediate: "Средний", advanced: "Продвинутый" };

  async function handleSave() {
    setSaving(true);
    try {
      const body = { age: parseInt(form.age) || undefined, weight: parseFloat(form.weight) || undefined, height: parseInt(form.height) || undefined, gender: form.gender, fitness_level: form.fitness_level, desired_result: form.desired_result };
      const res = await fetch(`${API_BASE}/user/${tgId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) { setSaved(true); setEditing(false); onUserUpdated(); setTimeout(() => setSaved(false), 3000); }
    } catch(e) { alert("Ошибка сохранения"); }
    finally { setSaving(false); }
  }

  const viewRows = [
    { label: "Возраст", value: user.age ? `${user.age} лет` : "—" },
    { label: "Вес", value: user.weight ? `${user.weight} кг` : "—" },
    { label: "Рост", value: user.height ? `${user.height} см` : "—" },
    { label: "ИМТ", value: user.bmi || "—" },
    { label: "Уровень", value: levelLabels[user.fitness_level] || user.fitness_level || "—" },
    { label: "Цель", value: goalLabels[user.desired_result] || user.desired_result || "—" },
    { label: "Язык", value: (user.lang || "ru").toUpperCase() },
    { label: "AI запросов сегодня", value: `${user.ai_requests_today || 0} / 5` },
  ];

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} />
      <Kicker>МОЙ ПРОФИЛЬ</Kicker>
      <Hero>{user.first_name || "Атлет"}</Hero>
      {user.username && <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 4, fontFamily: "monospace" }}>@{user.username}</div>}
      <div style={{ height: 16 }} />

      {saved && <div style={{ background: "#00CC6622", border: `0.5px solid ${COLORS.success}`, borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontFamily: "monospace", fontSize: 12, color: COLORS.success }}>✓ СОХРАНЕНО</div>}

      {!editing ? (
        <>
          <Card style={{ marginBottom: 12 }}>
            {viewRows.map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < viewRows.length - 1 ? `0.5px solid ${COLORS.border}` : "none" }}>
                <span style={{ fontSize: 13, color: COLORS.muted, fontFamily: "monospace" }}>{r.label}</span>
                <span style={{ fontSize: 13, color: COLORS.text, fontWeight: 500 }}>{r.value}</span>
              </div>
            ))}
          </Card>
          {user.allergies?.length > 0 && <div style={{ marginBottom: 12 }}><Kicker>АЛЛЕРГИИ</Kicker><Card>{user.allergies.join(", ")}</Card></div>}
          {user.medical_conditions?.length > 0 && <div style={{ marginBottom: 12 }}><Kicker>ПРОТИВОПОКАЗАНИЯ</Kicker><Card>{user.medical_conditions.join(", ")}</Card></div>}
          <Btn accent full onClick={() => { setForm({ age: user.age || "", weight: user.weight || "", height: user.height || "", gender: user.gender || "male", fitness_level: user.fitness_level || "beginner", desired_result: user.desired_result || "stay_healthy" }); setEditing(true); }}>
            ✏ РЕДАКТИРОВАТЬ ПРОФИЛЬ
          </Btn>
        </>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {[
              { label: "Возраст (лет)", key: "age", type: "number", placeholder: "45" },
              { label: "Вес (кг)", key: "weight", type: "number", placeholder: "86" },
              { label: "Рост (см)", key: "height", type: "number", placeholder: "186" },
            ].map(f => (
              <Card key={f.key}>
                <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>{f.label.toUpperCase()}</div>
                <input type={f.type} value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder}
                  style={{ background: "none", border: "none", color: COLORS.accent, fontSize: 22, fontFamily: "monospace", fontWeight: 700, width: "100%", outline: "none" }} />
              </Card>
            ))}
            <Card>
              <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>ПОЛ</div>
              <Select value={form.gender} onChange={v => setForm(p => ({ ...p, gender: v }))} options={[{ value: "male", label: "Мужской" }, { value: "female", label: "Женский" }]} />
            </Card>
            <Card>
              <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>УРОВЕНЬ</div>
              <Select value={form.fitness_level} onChange={v => setForm(p => ({ ...p, fitness_level: v }))} options={[{ value: "beginner", label: "Новичок" }, { value: "intermediate", label: "Средний" }, { value: "advanced", label: "Продвинутый" }]} />
            </Card>
            <Card>
              <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>ЦЕЛЬ</div>
              <Select value={form.desired_result} onChange={v => setForm(p => ({ ...p, desired_result: v }))} options={[{ value: "lose_weight", label: "Похудение" }, { value: "gain_muscle", label: "Набор массы" }, { value: "gain_strength", label: "Сила" }, { value: "improve_endurance", label: "Выносливость" }, { value: "stay_healthy", label: "Здоровье" }]} />
            </Card>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn full onClick={() => setEditing(false)} style={{ flex: 1 }}>ОТМЕНА</Btn>
            <Btn accent full onClick={handleSave} disabled={saving} style={{ flex: 2 }}>{saving ? "СОХРАНЯЕМ..." : "СОХРАНИТЬ"}</Btn>
          </div>
        </>
      )}
    </div>
  );
}

// ─── WORKOUT ──────────────────────────────────────────────────────────────────
function WorkoutScreen({ workouts }) {
  if (!workouts) return <div style={{ padding: "16px 16px 100px" }}><Loader text="ЗАГРУЗКА ТРЕНИРОВОК" /></div>;
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>ИСТОРИЯ</Kicker>
      <Hero>МОИ ТРЕНИРОВКИ</Hero>
      <div style={{ height: 12 }} />
      <Btn accent full onClick={() => tg?.sendData(JSON.stringify({ action: "start_workout" }))} style={{ marginBottom: 16 }}>▶ НАЧАТЬ ТРЕНИРОВКУ</Btn>
      {workouts.length === 0 ? (
        <Card><div style={{ textAlign: "center", padding: "20px 0" }}><div style={{ fontSize: 32, marginBottom: 8 }}>◎</div><div style={{ color: COLORS.muted, fontSize: 14 }}>Тренировок пока нет</div><div style={{ color: COLORS.accent, fontSize: 13, marginTop: 4, fontFamily: "monospace" }}>НАЧНИ ПЕРВУЮ →</div></div></Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {workouts.map((w, i) => (
            <Card key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <Kicker>{new Date(w.date || w.started_at).toLocaleDateString("ru", { day: "numeric", month: "short" })}</Kicker>
                  <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.text }}>{w.workout_type || "Тренировка"}</div>
                </div>
                <Stat value={w.duration_min || "—"} unit="мин" />
              </div>
              <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginTop: 10, paddingTop: 10, display: "flex", gap: 20 }}>
                <div><div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>ПОДХОДОВ</div><Stat value={w.sets_count || 0} /></div>
                <div><div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>ТОННАЖ</div><Stat value={Math.round((w.total_volume || 0) / 1000 * 10) / 10} unit="т" /></div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────
function ProgressScreen({ stats }) {
  if (!stats) return <div style={{ padding: "16px 16px 100px" }}><Loader text="ЗАГРУЗКА ПРОГРЕССА" /></div>;
  const weekly = stats.weekly_workouts || [];
  const peak = Math.max(...weekly, 1);
  const blocks = " ▁▂▃▄▅▆▇█";
  const spark = weekly.map(v => blocks[Math.min(8, Math.round(8 * v / peak))]).join("");
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>{stats.period_days || 30} ДНЕЙ</Kicker>
      <Hero>{stats.period_days || 30} ДНЕЙ ОГНЯ</Hero>
      <div style={{ height: 16 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        {[{ label: "ТРЕНИРОВОК", value: stats.total_workouts || 0 }, { label: "ПОДХОДОВ", value: stats.total_sets || 0 }, { label: "ТОННАЖ", value: Math.round((stats.total_volume || 0) / 1000 * 10) / 10, unit: "т" }, { label: "СЕРИЯ", value: stats.streak_days || 0, unit: "дн" }].map((s, i) => (
          <Card key={i}><div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 4 }}>{s.label}</div><Stat value={s.value} unit={s.unit} /></Card>
        ))}
      </div>
      {weekly.length > 0 && <Card style={{ marginBottom: 16 }}><Kicker>ПО НЕДЕЛЯМ</Kicker><div style={{ fontFamily: "monospace", fontSize: 22, color: COLORS.accent, letterSpacing: 2, margin: "8px 0" }}>{spark || "нет данных"}</div><div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace" }}>тренировок в неделю</div></Card>}
      {stats.weight_logs?.length > 0 && (
        <Card><Kicker>ДИНАМИКА ВЕСА</Kicker><div style={{ marginTop: 8 }}>
          {stats.weight_logs.slice(-5).map((w, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `0.5px solid ${COLORS.border}` }}>
              <span style={{ fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>{new Date(w.logged_at).toLocaleDateString("ru", { day: "numeric", month: "short" })}</span>
              <Stat value={w.weight} unit="кг" />
            </div>
          ))}
        </div></Card>
      )}
    </div>
  );
}

// ─── CATALOG ──────────────────────────────────────────────────────────────────
function CatalogScreen({ exercises, muscleGroups }) {
  const [activeGroup, setActiveGroup] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const diffColor = { easy: COLORS.success, medium: COLORS.accent, hard: COLORS.danger };
  const diffLabel = { easy: "Лёгкое", medium: "Среднее", hard: "Сложное" };
  const filtered = exercises?.filter(e => (!activeGroup || e.muscle_group_id === activeGroup) && (!search || e.name.toLowerCase().includes(search.toLowerCase()))) || [];

  if (selected) return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={() => setSelected(null)} />
      {selected.photo_url && <img src={selected.photo_url} alt={selected.name} style={{ width: "100%", borderRadius: 12, marginBottom: 14, objectFit: "cover", maxHeight: 220 }} onError={e => e.target.style.display = "none"} />}
      <Kicker>{selected.group_emoji} {selected.group_name?.toUpperCase()}</Kicker>
      <Hero>{selected.name}</Hero>
      <div style={{ height: 12 }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[{ l: "ПОДХОДОВ", v: selected.sets_recommended }, { l: "ПОВТОРЕНИЙ", v: selected.reps_recommended }, { l: "СЛОЖНОСТЬ", v: diffLabel[selected.difficulty] || selected.difficulty }].map((s, i) => (
          <Card key={i} style={{ flex: 1, textAlign: "center" }}><div style={{ fontSize: 9, color: COLORS.muted, fontFamily: "monospace", marginBottom: 4 }}>{s.l}</div><div style={{ fontSize: 14, fontWeight: 700, color: COLORS.accent }}>{s.v || "—"}</div></Card>
        ))}
      </div>
      {selected.description && <Card style={{ marginBottom: 10 }}><Kicker>ОПИСАНИЕ</Kicker><div style={{ fontSize: 14, color: COLORS.text, lineHeight: 1.6, marginTop: 6 }}>{selected.description}</div></Card>}
      {selected.equipment && <Card><Kicker>ОБОРУДОВАНИЕ</Kicker><div style={{ fontSize: 14, color: COLORS.text, marginTop: 4 }}>{selected.equipment}</div></Card>}
    </div>
  );

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>БАЗА ЗНАНИЙ</Kicker><Hero>УПРАЖНЕНИЯ</Hero>
      <div style={{ height: 12 }} />
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="ПОИСК..." style={{ width: "100%", background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 8, padding: "10px 14px", color: COLORS.text, fontSize: 13, fontFamily: "monospace", letterSpacing: 1, boxSizing: "border-box", marginBottom: 12, outline: "none" }} />
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
        <button onClick={() => setActiveGroup(null)} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 20, background: !activeGroup ? COLORS.accent : COLORS.card, color: !activeGroup ? COLORS.bg : COLORS.muted, border: `0.5px solid ${!activeGroup ? COLORS.accent : COLORS.border}`, fontSize: 11, fontFamily: "monospace", cursor: "pointer", fontWeight: 700 }}>ВСЕ</button>
        {muscleGroups?.map(g => <button key={g.id} onClick={() => setActiveGroup(g.id === activeGroup ? null : g.id)} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 20, background: activeGroup === g.id ? COLORS.accent : COLORS.card, color: activeGroup === g.id ? COLORS.bg : COLORS.muted, border: `0.5px solid ${activeGroup === g.id ? COLORS.accent : COLORS.border}`, fontSize: 11, fontFamily: "monospace", cursor: "pointer" }}>{g.emoji} {g.name.toUpperCase()}</button>)}
      </div>
      <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>{filtered.length} УПРАЖНЕНИЙ</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.slice(0, 60).map(ex => (
          <Card key={ex.id} onClick={() => setSelected(ex)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14, color: COLORS.text }}>{ex.name}</div><div style={{ fontSize: 11, color: COLORS.muted, marginTop: 2 }}>{ex.group_emoji} {ex.group_name}</div></div>
              <span style={{ fontSize: 10, fontFamily: "monospace", padding: "2px 6px", borderRadius: 4, background: `${diffColor[ex.difficulty] || COLORS.muted}22`, color: diffColor[ex.difficulty] || COLORS.muted }}>{diffLabel[ex.difficulty] || ex.difficulty}</span>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>{ex.sets_recommended} ПОДХ</div>
              <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>{ex.reps_recommended} ПОВТ</div>
              <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>{ex.equipment}</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── AI ───────────────────────────────────────────────────────────────────────
function AIScreen({ user }) {
  const [question, setQuestion] = useState(""); const [answer, setAnswer] = useState(null); const [loading, setLoading] = useState(false);
  const requestsLeft = 5 - (user?.ai_requests_today || 0);
  const suggestions = ["Сплит на 3 дня под набор массы", "Что есть до и после тренировки", "Техника приседаний со штангой", "Программа для похудения на месяц"];
  async function ask(q) {
    if (!q.trim() || loading) return;
    setLoading(true); setAnswer(null); setQuestion("");
    try { const res = await fetch(`${API_BASE}/ai/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, tg_id: tg?.initDataUnsafe?.user?.id }) }); const data = await res.json(); setAnswer(data.answer || "Нет ответа"); }
    catch { setAnswer("Ошибка соединения. Попробуй позже."); }
    finally { setLoading(false); }
  }
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>AI ТРЕНЕР</Kicker><Hero>ТРЕНЕР НА СВЯЗИ</Hero>
      <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 6, marginBottom: 16, fontFamily: "monospace" }}>ЗАПРОСОВ СЕГОДНЯ ОСТАЛОСЬ · <span style={{ color: COLORS.accent }}>{requestsLeft}</span></div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === "Enter" && ask(question)} placeholder="СПРОСИ ЧТО УГОДНО..." style={{ flex: 1, background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 8, padding: "10px 14px", color: COLORS.text, fontSize: 13, fontFamily: "monospace", letterSpacing: 0.5, outline: "none" }} />
        <button onClick={() => ask(question)} disabled={loading || !question.trim()} style={{ background: COLORS.accent, border: "none", borderRadius: 8, padding: "10px 16px", color: COLORS.bg, fontWeight: 700, fontSize: 14, cursor: "pointer", opacity: loading || !question.trim() ? 0.5 : 1 }}>→</button>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>БЫСТРЫЕ ВОПРОСЫ</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {suggestions.map((s, i) => <button key={i} onClick={() => { setQuestion(s); ask(s); }} style={{ background: COLORS.card, border: `0.5px solid ${COLORS.border}`, borderRadius: 8, padding: "10px 14px", color: COLORS.text, fontSize: 13, cursor: "pointer", textAlign: "left" }}>{s} →</button>)}
        </div>
      </div>
      {loading && <Card><div style={{ textAlign: "center", padding: "16px 0" }}><div style={{ color: COLORS.accent, fontFamily: "monospace", fontSize: 12, letterSpacing: 2 }}>ТРЕНЕР ДУМАЕТ...</div></div></Card>}
      {answer && <Card accent><Kicker>ОТВЕТ ТРЕНЕРА</Kicker><div style={{ fontSize: 14, color: COLORS.text, lineHeight: 1.6, marginTop: 8, whiteSpace: "pre-wrap" }}>{answer}</div><button onClick={() => setAnswer(null)} style={{ marginTop: 12, background: "none", border: "0.5px solid " + COLORS.accent, borderRadius: 8, padding: "8px 16px", color: COLORS.accent, fontSize: 12, fontFamily: "monospace", cursor: "pointer", letterSpacing: 1 }}>+ ЕЩЁ ВОПРОС</button></Card>}
    </div>
  );
}

// ─── NUTRITION ────────────────────────────────────────────────────────────────
function NutritionScreen({ tgId, onBack }) {
  const [data, setData] = useState(null); const [error, setError] = useState(null);
  useEffect(() => {
    if (!tgId) { setError("Войди через Telegram"); return; }
    fetch(`${API_BASE}/nutrition/${tgId}`).then(r => r.json()).then(setData).catch(() => setError("Не удалось загрузить данные"));
  }, []);
  if (error) return <div style={{ padding: "16px 16px 100px" }}><BackBtn onBack={onBack} /><Card><div style={{ color: COLORS.danger, fontFamily: "monospace", fontSize: 13 }}>{error}</div></Card></div>;
  if (!data) return <div style={{ padding: "16px 16px 100px" }}><BackBtn onBack={onBack} /><Loader text="ЗАГРУЗКА ПИТАНИЯ" /></div>;
  const t = data.today_totals || {};
  const kcalPct = Math.min(100, Math.round(((t.kcal || 0) / Math.max(data.target_kcal, 1)) * 100));
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} />
      <Kicker>ПИТАНИЕ СЕГОДНЯ</Kicker><Hero>НУТРИЕНТЫ</Hero>
      <div style={{ height: 16 }} />
      <Card accent style={{ marginBottom: 12 }}>
        <Kicker>КАЛОРИИ</Kicker>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 8 }}><Stat value={t.kcal || 0} unit="ккал" /><span style={{ fontFamily: "monospace", fontSize: 12, color: COLORS.muted }}>цель {data.target_kcal}</span></div>
        <div style={{ background: COLORS.border, borderRadius: 4, height: 6, marginTop: 10 }}><div style={{ width: `${kcalPct}%`, height: "100%", background: kcalPct > 100 ? COLORS.danger : COLORS.accent, borderRadius: 4 }} /></div>
        <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginTop: 4 }}>{kcalPct}% ОТ ЦЕЛИ · TDEE {data.tdee}</div>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        {[{ l: "БЕЛОК", v: t.protein || 0 }, { l: "ЖИРЫ", v: t.fat || 0 }, { l: "УГЛЕВОДЫ", v: t.carb || 0 }].map((m, i) => <Card key={i} style={{ textAlign: "center" }}><div style={{ fontSize: 9, color: COLORS.muted, fontFamily: "monospace", marginBottom: 6 }}>{m.l}</div><Stat value={m.v} unit="г" /></Card>)}
      </div>
      {data.today_logs?.length > 0 ? (
        <><Kicker>ПРИЁМЫ ПИЩИ</Kicker><div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {data.today_logs.map((l, i) => <Card key={i}><div style={{ display: "flex", justifyContent: "space-between" }}><div style={{ fontWeight: 600, fontSize: 14, color: COLORS.text }}>{l.meal_name}</div><Stat value={l.kcal || 0} unit="ккал" /></div><div style={{ display: "flex", gap: 12, marginTop: 6 }}><span style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>Б {l.protein}г</span><span style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>Ж {l.fat}г</span><span style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>У {l.carb}г</span></div></Card>)}
        </div></>
      ) : (
        <Card><div style={{ textAlign: "center", padding: "16px 0", color: COLORS.muted, fontSize: 14 }}>Сегодня записей нет<br /><span style={{ fontSize: 12, fontFamily: "monospace", color: COLORS.accent }}>ДОБАВЬ В БОТЕ →</span></div></Card>
      )}
    </div>
  );
}

// ─── FOOD GUIDE ───────────────────────────────────────────────────────────────
function FoodGuideScreen({ onBack }) {
  const [categories, setCategories] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/food-guide`).then(r => r.json()).then(data => setCategories(data.categories || [])).catch(() => setCategories([]));
  }, []);

  if (selected) return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={() => setSelected(null)} />
      <div style={{ fontSize: 40, marginBottom: 8 }}>{selected.emoji}</div>
      <Kicker>СПРАВОЧНИК ПРОДУКТОВ</Kicker>
      <Hero>{selected.name}</Hero>
      <div style={{ height: 16 }} />
      <Card accent style={{ marginBottom: 10 }}>
        <Kicker>КБЖУ НА 100Г</Kicker>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
          {[{ l: "КАЛОРИИ", v: selected.kcal, u: "ккал" }, { l: "БЕЛОК", v: selected.protein, u: "г" }, { l: "ЖИРЫ", v: selected.fat, u: "г" }, { l: "УГЛЕВОДЫ", v: selected.carb, u: "г" }].map((m, i) => (
            <div key={i}><div style={{ fontSize: 9, color: COLORS.muted, fontFamily: "monospace" }}>{m.l}</div><div style={{ fontSize: 14, fontWeight: 700, color: COLORS.accent, fontFamily: "monospace" }}>{m.v} <span style={{ fontSize: 11, color: COLORS.muted }}>{m.u}</span></div></div>
          ))}
        </div>
      </Card>
      {[
        { label: "⏰ КОГДА ЕСТЬ", value: selected.timing },
        { label: "💡 СОВЕТЫ", value: selected.tips },
        { label: "🏆 ЛУЧШИЕ ПРОДУКТЫ", value: selected.best },
        { label: "✅ СОЧЕТАЕТСЯ С", value: selected.combines },
        { label: "❌ НЕ СОЧЕТАТЬ С", value: selected.avoid },
      ].map((r, i) => (
        <Card key={i} style={{ marginBottom: 8 }}>
          <Kicker>{r.label}</Kicker>
          <div style={{ fontSize: 13, color: COLORS.text, lineHeight: 1.6, marginTop: 4 }}>{r.value}</div>
        </Card>
      ))}
    </div>
  );

  if (!categories) return <div style={{ padding: "16px 16px 100px" }}><BackBtn onBack={onBack} /><Loader text="ЗАГРУЗКА" /></div>;
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} />
      <Kicker>СПРАВОЧНИК</Kicker><Hero>КАТАЛОГ ПРОДУКТОВ</Hero>
      <div style={{ height: 16 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {categories.map((c, i) => (
          <Card key={i} onClick={() => setSelected(c)}>
            <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
              <span style={{ fontSize: 32 }}>{c.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.text }}>{c.name}</div>
                <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 2, fontFamily: "monospace" }}>{c.kcal} ккал · Б {c.protein}г · Ж {c.fat}г · У {c.carb}г</div>
              </div>
              <span style={{ color: COLORS.accent, fontSize: 16 }}>→</span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── MEASUREMENTS ─────────────────────────────────────────────────────────────
function MeasurementsScreen({ onBack }) {
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({ waist: "", hips: "", chest: "", arm: "", thigh: "" });
  const fields = [{ key: "waist", label: "Талия" }, { key: "hips", label: "Бёдра" }, { key: "chest", label: "Грудь" }, { key: "arm", label: "Рука (бицепс)" }, { key: "thigh", label: "Бедро" }];
  function handleSend() {
    if (!Object.values(form).some(v => v)) return;
    tg?.sendData(JSON.stringify({ action: "save_measurements", data: Object.fromEntries(Object.entries(form).filter(([, v]) => v)) }));
    setSent(true);
  }
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} /><Kicker>АНТРОПОМЕТРИЯ</Kicker><Hero>ЗАМЕРЫ ТЕЛА</Hero>
      <div style={{ height: 16 }} />
      {sent ? <Card accent><div style={{ textAlign: "center", padding: "20px 0" }}><div style={{ fontSize: 32, color: COLORS.accent }}>✓</div><div style={{ fontFamily: "monospace", fontSize: 13, color: COLORS.accent, marginTop: 8 }}>ЗАМЕРЫ ОТПРАВЛЕНЫ</div><div style={{ fontSize: 12, color: COLORS.muted, marginTop: 4 }}>Сохранены в боте</div></div></Card> : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {fields.map(f => <Card key={f.key}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontSize: 13, color: COLORS.muted, fontFamily: "monospace", marginBottom: 6 }}>{f.label.toUpperCase()}</div><input type="number" value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} placeholder="0" style={{ background: "none", border: "none", color: COLORS.accent, fontSize: 22, fontFamily: "monospace", fontWeight: 700, width: 80, outline: "none" }} /></div><span style={{ fontFamily: "monospace", fontSize: 14, color: COLORS.muted }}>см</span></div></Card>)}
          </div>
          <Btn accent full onClick={handleSend} disabled={!Object.values(form).some(v => v)}>СОХРАНИТЬ ЗАМЕРЫ</Btn>
          <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace", textAlign: "center", marginTop: 8 }}>Заполни хотя бы одно поле</div>
        </>
      )}
    </div>
  );
}

// ─── CHECKIN ──────────────────────────────────────────────────────────────────
function CheckinScreen({ onBack }) {
  const [sent, setSent] = useState(false);
  const [form, setForm] = useState({ weight: "", energy: 3, sleep: 3, stress: 3, motivation: 3 });
  const sliders = [{ key: "energy", label: "Энергия", lo: "😴", hi: "⚡" }, { key: "sleep", label: "Сон", lo: "😞", hi: "😴✨" }, { key: "stress", label: "Стресс", lo: "😌", hi: "😤" }, { key: "motivation", label: "Мотивация", lo: "😑", hi: "🔥" }];
  function handleSend() { tg?.sendData(JSON.stringify({ action: "save_checkin", data: { ...form, weight: parseFloat(form.weight) || null } })); setSent(true); }
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} /><Kicker>ЕЖЕНЕДЕЛЬНЫЙ</Kicker><Hero>ЧЕК-ИН</Hero>
      <div style={{ height: 16 }} />
      {sent ? <Card accent><div style={{ textAlign: "center", padding: "20px 0" }}><div style={{ fontSize: 32, color: COLORS.accent }}>✓</div><div style={{ fontFamily: "monospace", fontSize: 13, color: COLORS.accent, marginTop: 8 }}>ЧЕК-ИН ОТПРАВЛЕН</div></div></Card> : (
        <>
          <Card style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>ВЕС СЕГОДНЯ (КГ)</div>
            <input type="number" step="0.1" value={form.weight} onChange={e => setForm(p => ({ ...p, weight: e.target.value }))} placeholder="0.0" style={{ background: "none", border: "none", color: COLORS.accent, fontSize: 28, fontFamily: "monospace", fontWeight: 700, width: "100%", outline: "none" }} />
          </Card>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
            {sliders.map(s => <Card key={s.key}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>{s.label.toUpperCase()}</span><span style={{ fontSize: 14, fontFamily: "monospace", color: COLORS.accent, fontWeight: 700 }}>{form[s.key]}/5</span></div><div style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={{ fontSize: 14 }}>{s.lo}</span><input type="range" min={1} max={5} value={form[s.key]} onChange={e => setForm(p => ({ ...p, [s.key]: +e.target.value }))} style={{ flex: 1, accentColor: COLORS.accent }} /><span style={{ fontSize: 14 }}>{s.hi}</span></div></Card>)}
          </div>
          <Btn accent full onClick={handleSend}>ОТПРАВИТЬ ЧЕК-ИН</Btn>
        </>
      )}
    </div>
  );
}

// ─── SUPPLEMENTS ──────────────────────────────────────────────────────────────
function SupplementsScreen({ onBack }) {
  const supps = [
    { name: "Протеин", icon: "🥛", desc: "Восполнение белка. 20–40г после тренировки или в любое время дня." },
    { name: "Креатин моногидрат", icon: "⚡", desc: "Увеличивает силу и мышечную массу. 3–5г в день. Без загрузки." },
    { name: "Омега-3", icon: "🐟", desc: "Противовоспалительный эффект, суставы, сердце. 1–3г EPA+DHA в день." },
    { name: "Витамин D3", icon: "☀️", desc: "Иммунитет, тестостерон, кости. 2000–5000 МЕ в день с едой." },
    { name: "Магний", icon: "💊", desc: "Качество сна, мышечное восстановление. 200–400мг глицината перед сном." },
    { name: "Кофеин", icon: "☕", desc: "Предтрен. Повышает выносливость и силу. 3–6мг/кг за 30 мин до тренировки." },
    { name: "Цинк", icon: "🔩", desc: "Иммунитет, тестостерон, восстановление. 15–30мг в день во время еды." },
    { name: "Коллаген", icon: "🦴", desc: "Суставы и связки. 10г в день с витамином C за 1 час до тренировки." },
  ];
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} /><Kicker>СПРАВОЧНИК</Kicker><Hero>ДОБАВКИ</Hero>
      <div style={{ height: 16 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {supps.map((s, i) => <Card key={i}><div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}><span style={{ fontSize: 24 }}>{s.icon}</span><div><div style={{ fontWeight: 600, fontSize: 15, color: COLORS.text, marginBottom: 4 }}>{s.name}</div><div style={{ fontSize: 13, color: COLORS.muted, lineHeight: 1.5 }}>{s.desc}</div></div></div></Card>)}
      </div>
    </div>
  );
}

// ─── LANGUAGE ─────────────────────────────────────────────────────────────────
function LanguageScreen({ tgId, user, onBack, onUserUpdated }) {
  const [saving, setSaving] = useState(false);
  const langs = [{ code: "ru", label: "🇷🇺 Русский" }, { code: "en", label: "🇬🇧 English" }, { code: "uz", label: "🇺🇿 O'zbek" }];
  async function setLang(code) {
    setSaving(code);
    try {
      await fetch(`${API_BASE}/user/${tgId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lang: code }) });
      onUserUpdated();
      setTimeout(onBack, 500);
    } catch { } finally { setSaving(false); }
  }
  const current = user?.lang || "ru";
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} /><Kicker>НАСТРОЙКИ</Kicker><Hero>ЯЗЫК</Hero>
      <div style={{ height: 16 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {langs.map(l => (
          <Card key={l.code} onClick={() => setLang(l.code)} accent={current === l.code}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 16, color: COLORS.text, fontWeight: current === l.code ? 700 : 400 }}>{l.label}</span>
              {current === l.code && <span style={{ color: COLORS.accent, fontFamily: "monospace", fontSize: 12 }}>✓ ТЕКУЩИЙ</span>}
              {saving === l.code && <span style={{ color: COLORS.muted, fontFamily: "monospace", fontSize: 11 }}>...</span>}
            </div>
          </Card>
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 11, color: COLORS.muted, fontFamily: "monospace", textAlign: "center" }}>
        Изменение языка применяется к боту при следующем запросе
      </div>
    </div>
  );
}

// ─── SUPPORT ──────────────────────────────────────────────────────────────────
function SupportScreen({ onBack }) {
  const [msg, setMsg] = useState(""); const [sent, setSent] = useState(false);
  function handleSend() { if (!msg.trim()) return; tg?.sendData(JSON.stringify({ action: "open_support", message: msg.trim() })); setSent(true); }
  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <BackBtn onBack={onBack} /><Kicker>ОБРАТНАЯ СВЯЗЬ</Kicker><Hero>ПОДДЕРЖКА</Hero>
      <div style={{ height: 16 }} />
      {sent ? <Card accent><div style={{ textAlign: "center", padding: "20px 0" }}><div style={{ fontSize: 32, color: COLORS.accent }}>✓</div><div style={{ fontFamily: "monospace", fontSize: 13, color: COLORS.accent, marginTop: 8 }}>СООБЩЕНИЕ ОТПРАВЛЕНО</div><div style={{ fontSize: 12, color: COLORS.muted, marginTop: 4 }}>Ответим в течение 24 часов</div></div></Card> : (
        <>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: COLORS.muted, fontFamily: "monospace", marginBottom: 10 }}>ОПИШИ ПРОБЛЕМУ ИЛИ ВОПРОС</div>
            <textarea value={msg} onChange={e => setMsg(e.target.value)} placeholder="Напиши здесь..." rows={5} style={{ width: "100%", background: "none", border: "none", color: COLORS.text, fontSize: 14, lineHeight: 1.6, resize: "none", outline: "none", boxSizing: "border-box" }} />
          </Card>
          <Btn accent full onClick={handleSend} disabled={!msg.trim()}>ОТПРАВИТЬ</Btn>
        </>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("menu");
  const [screen, setScreen] = useState(null);
  const [user, setUser] = useState(null);
  const [workouts, setWorkouts] = useState(null);
  const [stats, setStats] = useState(null);
  const [exercises, setExercises] = useState(null);
  const [muscleGroups, setMuscleGroups] = useState(null);

  const tgId = tg?.initDataUnsafe?.user?.id;

  function loadUser() {
    if (tgId) {
      fetch(`${API_BASE}/user/${tgId}`).then(r => r.json()).then(setUser).catch(() => setUser({ first_name: tg?.initDataUnsafe?.user?.first_name || "Атлет", ai_requests_today: 0 }));
    } else {
      setUser({ first_name: "Атлет", ai_requests_today: 0 });
    }
  }

  useEffect(() => {
    tg?.ready(); tg?.expand();
    loadUser();
    fetch(`${API_BASE}/exercises`).then(r => r.json()).then(data => { setExercises(data.exercises || []); setMuscleGroups(data.muscle_groups || []); }).catch(() => { setExercises([]); setMuscleGroups([]); });
  }, []);

  useEffect(() => {
    if (tab === "workout" && !workouts && tgId) {
      fetch(`${API_BASE}/workouts/${tgId}`).then(r => r.json()).then(data => setWorkouts(data.workouts || [])).catch(() => setWorkouts([]));
    }
    if (tab === "progress" && !stats && tgId) {
      fetch(`${API_BASE}/stats/${tgId}`).then(r => r.json()).then(setStats).catch(() => setStats({}));
    }
  }, [tab]);

  function handleTabChange(t) { setTab(t); setScreen(null); }
  function handleNavigate(s) {
    if (s === "start_workout_bot") { tg?.sendData(JSON.stringify({ action: "start_workout" })); return; }
    if (s === "my_workouts") { setTab("workout"); setScreen(null); return; }
    setScreen(s);
  }

  function renderScreen() {
    if (screen === "profile") return <ProfileScreen user={user} tgId={tgId} onBack={() => setScreen(null)} onUserUpdated={loadUser} />;
    if (screen === "nutrition") return <NutritionScreen tgId={tgId} onBack={() => setScreen(null)} />;
    if (screen === "food_guide") return <FoodGuideScreen onBack={() => setScreen(null)} />;
    if (screen === "measurements") return <MeasurementsScreen onBack={() => setScreen(null)} />;
    if (screen === "checkin") return <CheckinScreen onBack={() => setScreen(null)} />;
    if (screen === "supplements") return <SupplementsScreen onBack={() => setScreen(null)} />;
    if (screen === "language") return <LanguageScreen tgId={tgId} user={user} onBack={() => setScreen(null)} onUserUpdated={loadUser} />;
    if (screen === "support") return <SupportScreen onBack={() => setScreen(null)} />;
    if (tab === "menu") return <MenuScreen user={user} onNavigate={handleNavigate} />;
    if (tab === "workout") return <WorkoutScreen workouts={workouts} />;
    if (tab === "progress") return <ProgressScreen stats={stats} />;
    if (tab === "catalog") return <CatalogScreen exercises={exercises} muscleGroups={muscleGroups} />;
    if (tab === "ai") return <AIScreen user={user} />;
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {renderScreen()}
      <NavBar active={tab} onChange={handleTabChange} />
    </div>
  );
}
