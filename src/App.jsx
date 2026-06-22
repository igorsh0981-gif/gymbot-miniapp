import { useState, useEffect } from "react";

const tg = window.Telegram?.WebApp;

const API_BASE = "https://web-production-4fe0b.up.railway.app/api";

const COLORS = {
  bg: "#0F0F0F",
  surface: "#1A1A1A",
  card: "#222222",
  accent: "#C8FF00",
  accentDim: "#8FB300",
  text: "#FFFFFF",
  muted: "#888888",
  border: "#2A2A2A",
  danger: "#FF4444",
  success: "#00CC66",
};

const rule = "─".repeat(16);

function Hero({ children }) {
  return (
    <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: -0.5, lineHeight: 1.15, color: COLORS.text, textTransform: "uppercase" }}>
      {children}
    </div>
  );
}

function Kicker({ children }) {
  return (
    <div style={{ fontFamily: "monospace", fontSize: 11, color: COLORS.muted, letterSpacing: 2, textTransform: "uppercase", marginBottom: 4 }}>
      {children}
    </div>
  );
}

function Stat({ value, unit }) {
  return (
    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 18, color: COLORS.accent }}>
      {value}{unit ? <span style={{ fontSize: 13, color: COLORS.muted }}> {unit}</span> : null}
    </span>
  );
}

function ProgressBar({ done, total, width = 10 }) {
  const t = Math.max(total, 1);
  const filled = Math.round(width * done / t);
  return (
    <span style={{ fontFamily: "monospace", fontSize: 13, color: COLORS.accent }}>
      {"▰".repeat(filled)}
      <span style={{ color: COLORS.border }}>{"▱".repeat(width - filled)}</span>
      <span style={{ color: COLORS.muted, fontSize: 11, marginLeft: 8 }}>{done}/{total}</span>
    </span>
  );
}

function Card({ children, accent, style = {} }) {
  return (
    <div style={{
      background: COLORS.card,
      border: `0.5px solid ${accent ? COLORS.accent : COLORS.border}`,
      borderRadius: 12,
      padding: "14px 16px",
      ...style
    }}>
      {children}
    </div>
  );
}

function NavBar({ active, onChange }) {
  const tabs = [
    { id: "menu", icon: "⊞", label: "Меню" },
    { id: "workout", icon: "▶", label: "Тренировка" },
    { id: "progress", icon: "↗", label: "Прогресс" },
    { id: "catalog", icon: "☰", label: "Каталог" },
    { id: "ai", icon: "●", label: "Тренер" },
  ];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      background: COLORS.surface,
      borderTop: `0.5px solid ${COLORS.border}`,
      display: "flex",
      padding: "8px 0 calc(8px + env(safe-area-inset-bottom))",
      zIndex: 100,
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)} style={{
          flex: 1, background: "none", border: "none", cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
          padding: "4px 0",
        }}>
          <span style={{ fontSize: 18, color: active === t.id ? COLORS.accent : COLORS.muted }}>{t.icon}</span>
          <span style={{ fontSize: 10, fontFamily: "monospace", letterSpacing: 0.5, color: active === t.id ? COLORS.accent : COLORS.muted }}>
            {t.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function MenuScreen({ user }) {
  const streak = user?.streak_days || 0;
  const goal = user?.desired_result;
  const goalLabels = {
    lose_weight: "Похудение", gain_muscle: "Набор массы",
    gain_strength: "Сила", improve_endurance: "Выносливость", stay_healthy: "Здоровье"
  };

  const quickActions = [
    { label: "Начать тренировку", icon: "▶", accent: true, cb: "start_workout" },
    { label: "Мои тренировки", icon: "☰", cb: "my_workouts" },
    { label: "Запланировать", icon: "◷", cb: "plan_workout" },
    { label: "Питание", icon: "◈", cb: "nutrition_menu" },
    { label: "Добавки", icon: "◆", cb: "supplements_menu" },
    { label: "Замеры", icon: "○", cb: "body_measurements" },
    { label: "Чек-ин", icon: "✓", cb: "start_checkin" },
    { label: "Поддержка", icon: "?", cb: "open_support" },
  ];

  function sendToBot(cb) {
    tg?.sendData(JSON.stringify({ action: cb }));
  }

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <div style={{ marginBottom: 20 }}>
        {streak > 0 && (
          <div style={{ fontFamily: "monospace", fontSize: 12, color: COLORS.accent, marginBottom: 8 }}>
            🔥 {streak} {streak === 1 ? "ДЕНЬ" : "ДНЯ"} ПОДРЯД · НЕ СЛЕЙ СЕРИЮ
          </div>
        )}
        <Hero>О, ТЫ ВЕРНУЛСЯ{user?.first_name ? `, ${user.first_name.split(" ")[0].toUpperCase()}` : ""}</Hero>
        {goal && (
          <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 6, fontFamily: "monospace" }}>
            ЦЕЛЬ · {goalLabels[goal] || goal}
          </div>
        )}
      </div>

      <button
        onClick={() => sendToBot("start_workout")}
        style={{
          width: "100%", background: COLORS.accent, border: "none", borderRadius: 12,
          padding: "18px", color: COLORS.bg, fontWeight: 700, fontSize: 18,
          letterSpacing: 1, textTransform: "uppercase", cursor: "pointer", marginBottom: 16,
        }}
      >
        ▶ НАЧАТЬ ТРЕНИРОВКУ
      </button>

      <div style={{ fontFamily: "monospace", fontSize: 10, color: COLORS.muted, letterSpacing: 2, marginBottom: 10 }}>
        БЫСТРЫЙ ДОСТУП
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {quickActions.slice(1).map(a => (
          <Card key={a.cb} style={{ cursor: "pointer" }} onClick={() => sendToBot(a.cb)}>
            <div style={{ fontSize: 18, color: COLORS.accent, marginBottom: 4 }}>{a.icon}</div>
            <div style={{ fontSize: 13, color: COLORS.text, fontWeight: 500 }}>{a.label}</div>
          </Card>
        ))}
      </div>

      {user && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: COLORS.muted, letterSpacing: 2, marginBottom: 10 }}>
            ПРОФИЛЬ
          </div>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.text }}>{user.first_name}</div>
                <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                  {user.age} лет · {user.weight} кг · {user.height} см
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, fontFamily: "monospace", color: COLORS.accent }}>
                  {user.fitness_level?.toUpperCase() || "—"}
                </div>
              </div>
            </div>
            <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginTop: 10, paddingTop: 10, display: "flex", gap: 16 }}>
              <div>
                <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>ИМТ</div>
                <Stat value={user.bmi || "—"} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>AI ЗАПРОСОВ</div>
                <Stat value={`${user.ai_requests_today || 0}/5`} />
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function WorkoutScreen({ workouts }) {
  if (!workouts) return <Loader text="ЗАГРУЗКА ТРЕНИРОВОК" />;

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>ИСТОРИЯ ТРЕНИРОВОК</Kicker>
      <Hero>МОИ ТРЕНИРОВКИ</Hero>
      <div style={{ height: 16 }} />

      {workouts.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>◎</div>
            <div style={{ color: COLORS.muted, fontSize: 14 }}>Тренировок пока нет</div>
            <div style={{ color: COLORS.accent, fontSize: 13, marginTop: 4, fontFamily: "monospace" }}>
              НАЧНИ ПЕРВУЮ →
            </div>
          </div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {workouts.map((w, i) => (
            <Card key={i}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <Kicker>{new Date(w.started_at).toLocaleDateString("ru", { day: "numeric", month: "short" })}</Kicker>
                  <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.text }}>
                    {w.workout_type || "Тренировка"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <Stat value={w.duration_min || "—"} unit="мин" />
                </div>
              </div>
              <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginTop: 10, paddingTop: 10, display: "flex", gap: 20 }}>
                <div>
                  <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>ПОДХОДОВ</div>
                  <Stat value={w.sets_count || 0} />
                </div>
                <div>
                  <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>ТОННАЖ</div>
                  <Stat value={Math.round((w.total_volume || 0) / 1000 * 10) / 10} unit="т" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressScreen({ stats }) {
  if (!stats) return <Loader text="ЗАГРУЗКА ПРОГРЕССА" />;

  const weekly = stats.weekly_workouts || [0, 0, 0, 0];
  const peak = Math.max(...weekly, 1);
  const blocks = " ▁▂▃▄▅▆▇█";
  const spark = weekly.map(v => blocks[Math.min(8, Math.round(8 * v / peak))]).join("");

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>{stats.period_days || 30} ДНЕЙ</Kicker>
      <Hero>{stats.period_days || 30} ДНЕЙ ОГНЯ</Hero>
      <div style={{ height: 16 }} />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        <Card>
          <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 4 }}>ТРЕНИРОВОК</div>
          <Stat value={stats.total_workouts || 0} />
        </Card>
        <Card>
          <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 4 }}>ПОДХОДОВ</div>
          <Stat value={stats.total_sets || 0} />
        </Card>
        <Card>
          <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 4 }}>ТОННАЖ</div>
          <Stat value={Math.round((stats.total_volume || 0) / 1000 * 10) / 10} unit="т" />
        </Card>
        <Card>
          <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 4 }}>СЕРИЯ</div>
          <Stat value={stats.streak_days || 0} unit="дн" />
        </Card>
      </div>

      {weekly.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <Kicker>ПО НЕДЕЛЯМ</Kicker>
          <div style={{ fontFamily: "monospace", fontSize: 22, color: COLORS.accent, letterSpacing: 2, margin: "8px 0" }}>
            {spark}
          </div>
          <div style={{ fontSize: 11, color: COLORS.muted, fontFamily: "monospace" }}>
            тренировок в неделю
          </div>
        </Card>
      )}

      {stats.weight_logs && stats.weight_logs.length > 0 && (
        <Card>
          <Kicker>ДИНАМИКА ВЕСА</Kicker>
          <div style={{ marginTop: 8 }}>
            {stats.weight_logs.slice(-5).map((w, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `0.5px solid ${COLORS.border}` }}>
                <span style={{ fontSize: 12, color: COLORS.muted, fontFamily: "monospace" }}>
                  {new Date(w.logged_at).toLocaleDateString("ru", { day: "numeric", month: "short" })}
                </span>
                <Stat value={w.weight} unit="кг" />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function CatalogScreen({ exercises, muscleGroups }) {
  const [activeGroup, setActiveGroup] = useState(null);
  const [search, setSearch] = useState("");

  const filtered = exercises?.filter(e => {
    const matchGroup = !activeGroup || e.muscle_group_id === activeGroup;
    const matchSearch = !search || e.name.toLowerCase().includes(search.toLowerCase());
    return matchGroup && matchSearch;
  }) || [];

  const diffColor = { easy: COLORS.success, medium: COLORS.accent, hard: COLORS.danger };
  const diffLabel = { easy: "Лёгкое", medium: "Среднее", hard: "Сложное" };

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>БАЗА ЗНАНИЙ</Kicker>
      <Hero>УПРАЖНЕНИЯ</Hero>
      <div style={{ height: 12 }} />

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="ПОИСК..."
        style={{
          width: "100%", background: COLORS.card, border: `0.5px solid ${COLORS.border}`,
          borderRadius: 8, padding: "10px 14px", color: COLORS.text, fontSize: 13,
          fontFamily: "monospace", letterSpacing: 1, boxSizing: "border-box", marginBottom: 12,
          outline: "none",
        }}
      />

      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 8, marginBottom: 12 }}>
        <button
          onClick={() => setActiveGroup(null)}
          style={{
            flexShrink: 0, padding: "6px 12px", borderRadius: 20,
            background: !activeGroup ? COLORS.accent : COLORS.card,
            color: !activeGroup ? COLORS.bg : COLORS.muted,
            border: `0.5px solid ${!activeGroup ? COLORS.accent : COLORS.border}`,
            fontSize: 11, fontFamily: "monospace", cursor: "pointer", fontWeight: 700,
          }}
        >ВСЕ</button>
        {muscleGroups?.map(g => (
          <button
            key={g.id}
            onClick={() => setActiveGroup(g.id === activeGroup ? null : g.id)}
            style={{
              flexShrink: 0, padding: "6px 12px", borderRadius: 20,
              background: activeGroup === g.id ? COLORS.accent : COLORS.card,
              color: activeGroup === g.id ? COLORS.bg : COLORS.muted,
              border: `0.5px solid ${activeGroup === g.id ? COLORS.accent : COLORS.border}`,
              fontSize: 11, fontFamily: "monospace", cursor: "pointer",
            }}
          >{g.emoji} {g.name.toUpperCase()}</button>
        ))}
      </div>

      <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>
        {filtered.length} УПРАЖНЕНИЙ
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.slice(0, 40).map(ex => (
          <Card key={ex.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: COLORS.text }}>{ex.name}</div>
                <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 2 }}>{ex.description}</div>
              </div>
              <div style={{ marginLeft: 8 }}>
                <span style={{
                  fontSize: 10, fontFamily: "monospace", padding: "2px 6px", borderRadius: 4,
                  background: `${diffColor[ex.difficulty]}22`,
                  color: diffColor[ex.difficulty] || COLORS.muted,
                }}>
                  {diffLabel[ex.difficulty] || ex.difficulty}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>
                {ex.sets_recommended} ПОДХ
              </div>
              <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>
                {ex.reps_recommended} ПОВТ
              </div>
              <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace" }}>
                {ex.equipment}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function AIScreen({ user }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [loading, setLoading] = useState(false);
  const requestsLeft = 5 - (user?.ai_requests_today || 0);

  const suggestions = [
    "Сплит на 3 дня под набор массы",
    "Что есть до и после тренировки",
    "Техника приседаний со штангой",
    "Программа для похудения на месяц",
  ];

  async function ask(q) {
    if (!q.trim() || loading) return;
    setLoading(true);
    setAnswer(null);
    setQuestion("");
    try {
      const res = await fetch(`${API_BASE}/ai/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, tg_id: tg?.initDataUnsafe?.user?.id }),
      });
      const data = await res.json();
      setAnswer(data.answer || "Нет ответа");
    } catch {
      setAnswer("Ошибка соединения с тренером. Попробуй позже.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: "16px 16px 100px" }}>
      <Kicker>AI ТРЕНЕР</Kicker>
      <Hero>ТРЕНЕР НА СВЯЗИ</Hero>
      <div style={{ color: COLORS.muted, fontSize: 13, marginTop: 6, marginBottom: 16, fontFamily: "monospace" }}>
        ЗАПРОСОВ СЕГОДНЯ ОСТАЛОСЬ · <span style={{ color: COLORS.accent }}>{requestsLeft}</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => e.key === "Enter" && ask(question)}
          placeholder="СПРОСИ ЧТО УГОДНО..."
          style={{
            flex: 1, background: COLORS.card, border: `0.5px solid ${COLORS.border}`,
            borderRadius: 8, padding: "10px 14px", color: COLORS.text, fontSize: 13,
            fontFamily: "monospace", letterSpacing: 0.5, outline: "none",
          }}
        />
        <button
          onClick={() => ask(question)}
          disabled={loading || !question.trim()}
          style={{
            background: COLORS.accent, border: "none", borderRadius: 8, padding: "10px 16px",
            color: COLORS.bg, fontWeight: 700, fontSize: 14, cursor: "pointer",
            opacity: loading || !question.trim() ? 0.5 : 1,
          }}
        >→</button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginBottom: 8 }}>БЫСТРЫЕ ВОПРОСЫ</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => { setQuestion(s); ask(s); }}
              style={{
                background: COLORS.card, border: `0.5px solid ${COLORS.border}`,
                borderRadius: 8, padding: "10px 14px", color: COLORS.text,
                fontSize: 13, cursor: "pointer", textAlign: "left",
              }}
            >{s} →</button>
          ))}
        </div>
      </div>

      {loading && (
        <Card>
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ color: COLORS.accent, fontFamily: "monospace", fontSize: 12, letterSpacing: 2 }}>
              ТРЕНЕР ДУМАЕТ...
            </div>
          </div>
        </Card>
      )}

      {answer && (
        <Card accent>
          <Kicker>ОТВЕТ ТРЕНЕРА</Kicker>
          <div style={{ fontSize: 14, color: COLORS.text, lineHeight: 1.6, marginTop: 8, whiteSpace: "pre-wrap" }}>
            {answer}
          </div>
          <button
            onClick={() => { setAnswer(null); }}
            style={{
              marginTop: 12, background: "none", border: "0.5px solid " + COLORS.accent,
              borderRadius: 8, padding: "8px 16px", color: COLORS.accent,
              fontSize: 12, fontFamily: "monospace", cursor: "pointer", letterSpacing: 1,
            }}
          >+ ЗАДАТЬ ЕЩЁ ВОПРОС</button>
        </Card>
      )}
    </div>
  );
}

function Loader({ text = "ЗАГРУЗКА" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: COLORS.accent, letterSpacing: 3 }}>{text}</div>
        <div style={{ color: COLORS.muted, fontSize: 24, marginTop: 8 }}>◌</div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("menu");
  const [user, setUser] = useState(null);
  const [workouts, setWorkouts] = useState(null);
  const [stats, setStats] = useState(null);
  const [exercises, setExercises] = useState(null);
  const [muscleGroups, setMuscleGroups] = useState(null);

  useEffect(() => {
    tg?.ready();
    tg?.expand();

    const tgUser = tg?.initDataUnsafe?.user;
    if (tgUser) {
      fetch(`${API_BASE}/user/${tgUser.id}`)
        .then(r => r.json())
        .then(setUser)
        .catch(() => setUser({ first_name: tgUser.first_name, telegram_id: tgUser.id }));
    } else {
      setUser({ first_name: "Атлет", ai_requests_today: 0 });
    }

    fetch(`${API_BASE}/exercises`)
      .then(r => r.json())
      .then(data => { setExercises(data.exercises || []); setMuscleGroups(data.muscle_groups || []); })
      .catch(() => { setExercises([]); setMuscleGroups([]); });
  }, []);

  useEffect(() => {
    if (tab === "workout" && !workouts) {
      const tgUser = tg?.initDataUnsafe?.user;
      if (!tgUser) { setWorkouts([]); return; }
      fetch(`${API_BASE}/workouts/${tgUser.id}`)
        .then(r => r.json())
        .then(data => setWorkouts(data.workouts || []))
        .catch(() => setWorkouts([]));
    }
    if (tab === "progress" && !stats) {
      const tgUser = tg?.initDataUnsafe?.user;
      if (!tgUser) { setStats({}); return; }
      fetch(`${API_BASE}/stats/${tgUser.id}`)
        .then(r => r.json())
        .then(setStats)
        .catch(() => setStats({}));
    }
  }, [tab]);

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.text, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {tab === "menu" && <MenuScreen user={user} />}
      {tab === "workout" && <WorkoutScreen workouts={workouts} />}
      {tab === "progress" && <ProgressScreen stats={stats} />}
      {tab === "catalog" && <CatalogScreen exercises={exercises} muscleGroups={muscleGroups} />}
      {tab === "ai" && <AIScreen user={user} />}
      <NavBar active={tab} onChange={setTab} />
    </div>
  );
}
