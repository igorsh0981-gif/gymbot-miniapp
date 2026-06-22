import { useState, useEffect, useRef } from "react";

const tg = window.Telegram?.WebApp;
const API = "https://web-production-4fe0b.up.railway.app/api";

const C = {
  bg:"#0F0F0F", surface:"#1A1A1A", card:"#222222",
  accent:"#C8FF00", text:"#FFFFFF", muted:"#888888",
  border:"#2A2A2A", danger:"#FF4444", success:"#00CC66", warn:"#FFB800",
};

// ─── ATOMS ───────────────────────────────────────────────────────────────────
const Hero = ({children,style={}}) => <div style={{fontWeight:700,fontSize:26,letterSpacing:-0.5,lineHeight:1.15,color:C.text,textTransform:"uppercase",...style}}>{children}</div>;
const Kicker = ({children}) => <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>{children}</div>;
const Mono = ({children,color=C.accent,size=18}) => <span style={{fontFamily:"monospace",fontWeight:700,fontSize:size,color}}>{children}</span>;

function Card({children,accent,danger,onClick,style={},pad="14px 16px"}){
  const border = accent?C.accent:danger?C.danger:C.border;
  return <div onClick={onClick} style={{background:C.card,border:`0.5px solid ${border}`,borderRadius:12,padding:pad,cursor:onClick?"pointer":"default",...style}}>{children}</div>;
}
function Loader({text="ЗАГРУЗКА"}){
  return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"60vh"}}><div style={{textAlign:"center"}}><div style={{fontFamily:"monospace",fontSize:12,color:C.accent,letterSpacing:3}}>{text}</div><div style={{color:C.muted,fontSize:24,marginTop:8}}>◌</div></div></div>;
}
function BackBtn({onBack}){
  return <button onClick={onBack} style={{background:"none",border:"none",color:C.muted,fontFamily:"monospace",fontSize:12,letterSpacing:1,cursor:"pointer",padding:"0 0 16px 0",display:"block"}}>← НАЗАД</button>;
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

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const MEDICAL_OPTIONS=[
  {key:"knee_injury",label:"🦵 Травма колена"},{key:"back_pain",label:"🔙 Боль в спине"},
  {key:"spine_issues",label:"🦴 Позвоночник"},{key:"shoulder_injury",label:"💪 Плечо/ротатор"},
  {key:"heart_disease",label:"❤️ Сердце/сосуды"},{key:"hypertension",label:"🩺 Гипертония"},
  {key:"hernia",label:"⚠️ Грыжа"},{key:"kidney_disease",label:"🫘 Почки"},{key:"diabetes",label:"💉 Диабет"},
];
const ALLERGY_OPTIONS=[
  {key:"lactose",label:"🥛 Лактоза"},{key:"gluten",label:"🌾 Глютен"},
  {key:"nuts",label:"🥜 Орехи"},{key:"soy",label:"🫘 Соя"},
  {key:"fish_oil",label:"🐟 Рыбий жир"},{key:"eggs",label:"🥚 Яйца"},
];
const MEDICAL_LABELS=Object.fromEntries(MEDICAL_OPTIONS.map(o=>[o.key,o.label]));
const ALLERGY_LABELS=Object.fromEntries(ALLERGY_OPTIONS.map(o=>[o.key,o.label]));
const GOAL_LABELS={lose_weight:"Похудение",gain_muscle:"Набор массы",gain_strength:"Сила",improve_endurance:"Выносливость",stay_healthy:"Здоровье"};
const LEVEL_LABELS={beginner:"Новичок",intermediate:"Средний",advanced:"Продвинутый"};
const DIFF_COLOR={easy:C.success,medium:C.accent,hard:C.danger};
const DIFF_LABEL={easy:"Лёгкое",medium:"Среднее",hard:"Сложное"};
const CARDIO_DISTANCE=["бег трусцой","интервальный бег","велосипед на улице","ходьба на беговой дорожке","бег на месте"];
const CARDIO_TIME=["зумба","танцевальная аэробика","степ-аэробика","плавание","кардио на лестнице","велотренажёр","эллиптический тренажёр"];

function cardioType(name=""){
  const n=name.toLowerCase();
  if(CARDIO_DISTANCE.some(c=>n.includes(c)||c.includes(n)))return "distance";
  if(CARDIO_TIME.some(c=>n.includes(c)||c.includes(n)))return "time";
  return null; // силовое
}

// ─── CHECKBOX GROUP ───────────────────────────────────────────────────────────
function CheckboxGroup({options,selected,onChange}){
  const toggle=key=>onChange(selected.includes(key)?selected.filter(k=>k!==key):[...selected,key]);
  return <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
    {options.map(o=>{const a=selected.includes(o.key);return(
      <button key={o.key} onClick={()=>toggle(o.key)} style={{padding:"7px 12px",borderRadius:20,fontSize:12,cursor:"pointer",background:a?C.accent:C.bg,border:`0.5px solid ${a?C.accent:C.border}`,color:a?C.bg:C.muted,fontWeight:a?700:400}}>{o.label}</button>
    );})}
  </div>;
}

// ─── NAVBAR ──────────────────────────────────────────────────────────────────
function NavBar({active,onChange}){
  const tabs=[{id:"menu",icon:"⊞",label:"Меню"},{id:"workout",icon:"▶",label:"Тренировки"},{id:"progress",icon:"↗",label:"Прогресс"},{id:"catalog",icon:"☰",label:"Каталог"},{id:"ai",icon:"●",label:"Тренер"}];
  return <div style={{position:"fixed",bottom:0,left:0,right:0,background:C.surface,borderTop:`0.5px solid ${C.border}`,display:"flex",padding:"8px 0 calc(8px + env(safe-area-inset-bottom))",zIndex:100}}>
    {tabs.map(t=><button key={t.id} onClick={()=>onChange(t.id)} style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,padding:"4px 0"}}>
      <span style={{fontSize:18,color:active===t.id?C.accent:C.muted}}>{t.icon}</span>
      <span style={{fontSize:10,fontFamily:"monospace",letterSpacing:0.5,color:active===t.id?C.accent:C.muted}}>{t.label}</span>
    </button>)}
  </div>;
}

// ─── EXERCISE CARD ────────────────────────────────────────────────────────────
function ExCard({ex,onClick,badge,action}){
  return <Card onClick={onClick} style={{marginBottom:8}}>
    <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
      {ex.photo_url&&<img src={ex.photo_url} alt="" style={{width:56,height:56,borderRadius:8,objectFit:"cover",flexShrink:0}} onError={e=>e.target.style.display="none"}/>}
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{fontWeight:600,fontSize:14,color:C.text,lineHeight:1.3}}>{ex.name}</div>
          {badge&&<Tag color={DIFF_COLOR[ex.difficulty]||C.muted}>{badge}</Tag>}
        </div>
        <div style={{fontSize:11,color:C.muted,marginTop:3}}>{ex.group_emoji} {ex.group_name}</div>
        <div style={{display:"flex",gap:10,marginTop:6}}>
          <span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{ex.sets_recommended} подх</span>
          <span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{ex.reps_recommended} повт</span>
          {ex.equipment&&<span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{ex.equipment}</span>}
        </div>
      </div>
      {action}
    </div>
  </Card>;
}

// ─── MENU ─────────────────────────────────────────────────────────────────────
function MenuScreen({user,onNav}){
  const streak=user?.streak_days||0;
  const actions=[
    {label:"Мои тренировки",icon:"☰",s:"my_workouts_detail"},
    {label:"Запланировать",icon:"📅",s:"plan_workout"},
    {label:"Цели",icon:"🎯",s:"goals"},
    {label:"Напоминания",icon:"🔔",s:"reminders"},
    {label:"Питание",icon:"◈",s:"nutrition"},
    {label:"Каталог продуктов",icon:"🥗",s:"food_guide"},
    {label:"Замеры тела",icon:"○",s:"measurements"},
    {label:"Чек-ин",icon:"✓",s:"checkin"},
    {label:"Добавки",icon:"◆",s:"supplements"},
    {label:"Язык",icon:"🌐",s:"language"},
    {label:"Поддержка",icon:"?",s:"support"},
  ];
  return <div style={{padding:"16px 16px 100px"}}>
    <div style={{marginBottom:20}}>
      {streak>0&&<div style={{fontFamily:"monospace",fontSize:12,color:C.accent,marginBottom:8}}>🔥 {streak} {streak===1?"ДЕНЬ":"ДНЯ"} ПОДРЯД</div>}
      <Hero>О, ТЫ ВЕРНУЛСЯ{user?.first_name?`, ${user.first_name.split(" ")[0].toUpperCase()}`:""}</Hero>
      {user?.desired_result&&<div style={{color:C.muted,fontSize:13,marginTop:6,fontFamily:"monospace"}}>ЦЕЛЬ · {GOAL_LABELS[user.desired_result]||user.desired_result}</div>}
    </div>
    <Btn accent full onClick={()=>onNav("active_workout")} style={{marginBottom:16}}>▶ НАЧАТЬ ТРЕНИРОВКУ</Btn>
    <Kicker>БЫСТРЫЙ ДОСТУП</Kicker>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16,marginTop:8}}>
      {actions.map(a=><Card key={a.s} onClick={()=>onNav(a.s)}>
        <div style={{fontSize:18,color:C.accent,marginBottom:4}}>{a.icon}</div>
        <div style={{fontSize:13,color:C.text,fontWeight:500}}>{a.label}</div>
      </Card>)}
    </div>
    {user&&<><Kicker>ПРОФИЛЬ</Kicker>
      <Card onClick={()=>onNav("profile")} style={{marginTop:8}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontWeight:600,fontSize:15,color:C.text}}>{user.first_name}</div>
            <div style={{fontSize:12,color:C.muted,marginTop:2}}>{user.age} лет · {user.weight} кг · {user.height} см</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:11,fontFamily:"monospace",color:C.accent}}>{user.fitness_level?.toUpperCase()||"—"}</div>
            <div style={{fontSize:10,color:C.muted,marginTop:2}}>ИЗМЕНИТЬ →</div>
          </div>
        </div>
        <div style={{borderTop:`0.5px solid ${C.border}`,marginTop:10,paddingTop:10,display:"flex",gap:16}}>
          <div><div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>ИМТ</div><Mono>{user.bmi||"—"}</Mono></div>
          <div><div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>AI ЗАПРОСОВ</div><Mono>{user.ai_requests_today||0}/5</Mono></div>
        </div>
      </Card>
    </>}
  </div>;
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────
function ProfileScreen({user,tgId,onBack,onUserUpdated}){
  const [editing,setEditing]=useState(false);
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [form,setForm]=useState({age:"",weight:"",height:"",gender:"male",fitness_level:"beginner",desired_result:"stay_healthy",medical_conditions:[],allergies:[]});

  if(!user)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text="ПРОФИЛЬ"/></div>;

  function startEdit(){
    setForm({age:user.age||"",weight:user.weight||"",height:user.height||"",gender:user.gender||"male",fitness_level:user.fitness_level||"beginner",desired_result:user.desired_result||"stay_healthy",
      medical_conditions:(user.medical_conditions||[]).filter(c=>c!=="none"),
      allergies:(user.allergies||[]).filter(a=>a!=="none"),
    });setEditing(true);
  }
  async function handleSave(){
    setSaving(true);
    try{
      const body={age:parseInt(form.age)||undefined,weight:parseFloat(form.weight)||undefined,height:parseInt(form.height)||undefined,
        gender:form.gender,fitness_level:form.fitness_level,desired_result:form.desired_result,
        medical_conditions:form.medical_conditions.length?form.medical_conditions:["none"],
        allergies:form.allergies.length?form.allergies:["none"]};
      const res=await fetch(`${API}/user/${tgId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if(res.ok){setSaved(true);setEditing(false);onUserUpdated();setTimeout(()=>setSaved(false),3000);}
    }catch{}finally{setSaving(false);}
  }

  const medNames=(user.medical_conditions||[]).filter(c=>c!=="none").map(c=>MEDICAL_LABELS[c]||c);
  const algNames=(user.allergies||[]).filter(a=>a!=="none").map(a=>ALLERGY_LABELS[a]||a);
  const rows=[{l:"Возраст",v:user.age?`${user.age} лет`:"—"},{l:"Вес",v:user.weight?`${user.weight} кг`:"—"},{l:"Рост",v:user.height?`${user.height} см`:"—"},{l:"ИМТ",v:user.bmi||"—"},{l:"Уровень",v:LEVEL_LABELS[user.fitness_level]||"—"},{l:"Цель",v:GOAL_LABELS[user.desired_result]||"—"},{l:"Язык",v:(user.lang||"ru").toUpperCase()},{l:"AI сегодня",v:`${user.ai_requests_today||0}/5`}];

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>МОЙ ПРОФИЛЬ</Kicker>
    <Hero>{user.first_name||"Атлет"}</Hero>
    {user.username&&<div style={{color:C.muted,fontSize:13,marginTop:4,fontFamily:"monospace"}}>@{user.username}</div>}
    <div style={{height:16}}/>
    {saved&&<div style={{background:"#00CC6622",border:`0.5px solid ${C.success}`,borderRadius:10,padding:"10px 14px",marginBottom:12,fontFamily:"monospace",fontSize:12,color:C.success}}>✓ СОХРАНЕНО</div>}
    {!editing?<>
      <Card style={{marginBottom:12}}>
        {rows.map((r,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:i<rows.length-1?`0.5px solid ${C.border}`:"none"}}>
          <span style={{fontSize:13,color:C.muted,fontFamily:"monospace"}}>{r.l}</span>
          <span style={{fontSize:13,color:C.text,fontWeight:500}}>{r.v}</span>
        </div>)}
      </Card>
      <div style={{marginBottom:12}}>
        <Kicker>МЕД. ПОКАЗАТЕЛИ / ПРОТИВОПОКАЗАНИЯ</Kicker>
        <Card>{medNames.length>0?<div style={{display:"flex",flexWrap:"wrap",gap:6}}>{medNames.map((n,i)=><Tag key={i} color={C.danger}>{n}</Tag>)}</div>:<span style={{fontSize:13,color:C.muted}}>Не указано</span>}</Card>
      </div>
      <div style={{marginBottom:16}}>
        <Kicker>АЛЛЕРГИИ</Kicker>
        <Card>{algNames.length>0?<div style={{display:"flex",flexWrap:"wrap",gap:6}}>{algNames.map((n,i)=><Tag key={i} color={C.warn}>{n}</Tag>)}</div>:<span style={{fontSize:13,color:C.muted}}>Не указано</span>}</Card>
      </div>
      <Btn accent full onClick={startEdit}>✏ РЕДАКТИРОВАТЬ ПРОФИЛЬ</Btn>
    </>:<>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {[{label:"Возраст (лет)",key:"age",placeholder:"45"},{label:"Вес (кг)",key:"weight",placeholder:"86"},{label:"Рост (см)",key:"height",placeholder:"186"}].map(f=><Card key={f.key}>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{f.label.toUpperCase()}</div>
          <input type="number" value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.placeholder} style={{background:"none",border:"none",color:C.accent,fontSize:22,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/>
        </Card>)}
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ПОЛ</div><Sel value={form.gender} onChange={v=>setForm(p=>({...p,gender:v}))} options={[{value:"male",label:"Мужской"},{value:"female",label:"Женский"}]}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>УРОВЕНЬ</div><Sel value={form.fitness_level} onChange={v=>setForm(p=>({...p,fitness_level:v}))} options={[{value:"beginner",label:"Новичок"},{value:"intermediate",label:"Средний"},{value:"advanced",label:"Продвинутый"}]}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ЦЕЛЬ</div><Sel value={form.desired_result} onChange={v=>setForm(p=>({...p,desired_result:v}))} options={[{value:"lose_weight",label:"Похудение"},{value:"gain_muscle",label:"Набор массы"},{value:"gain_strength",label:"Сила"},{value:"improve_endurance",label:"Выносливость"},{value:"stay_healthy",label:"Здоровье"}]}/></Card>
        <Card>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:10}}>МЕД. ПОКАЗАТЕЛИ / ПРОТИВОПОКАЗАНИЯ</div>
          <CheckboxGroup options={MEDICAL_OPTIONS} selected={form.medical_conditions} onChange={v=>setForm(p=>({...p,medical_conditions:v}))}/>
          {form.medical_conditions.length===0&&<div style={{fontSize:11,color:C.muted,marginTop:8,fontFamily:"monospace"}}>Нет противопоказаний</div>}
        </Card>
        <Card>
          <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:10}}>АЛЛЕРГИИ</div>
          <CheckboxGroup options={ALLERGY_OPTIONS} selected={form.allergies} onChange={v=>setForm(p=>({...p,allergies:v}))}/>
          {form.allergies.length===0&&<div style={{fontSize:11,color:C.muted,marginTop:8,fontFamily:"monospace"}}>Нет аллергий</div>}
        </Card>
      </div>
      <div style={{display:"flex",gap:10}}>
        <Btn full onClick={()=>setEditing(false)} style={{flex:1}}>ОТМЕНА</Btn>
        <Btn accent full onClick={handleSave} disabled={saving} style={{flex:2}}>{saving?"СОХРАНЯЕМ...":"СОХРАНИТЬ"}</Btn>
      </div>
    </>}
  </div>;
}

// ─── WORKOUT HISTORY ──────────────────────────────────────────────────────────
function WorkoutHistoryScreen({workouts,onNav}){
  if(!workouts)return <div style={{padding:"16px 16px 100px"}}><Loader text="ТРЕНИРОВКИ"/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <Kicker>ИСТОРИЯ</Kicker><Hero>МОИ ТРЕНИРОВКИ</Hero>
    <div style={{height:12}}/>
    <Btn accent full onClick={()=>onNav("active_workout")} style={{marginBottom:16}}>▶ НАЧАТЬ ТРЕНИРОВКУ</Btn>
    {workouts.length===0?<Card><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,marginBottom:8}}>◎</div><div style={{color:C.muted,fontSize:14}}>Тренировок пока нет</div><div style={{color:C.accent,fontSize:13,marginTop:4,fontFamily:"monospace"}}>НАЧНИ ПЕРВУЮ →</div></div></Card>:
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {workouts.map(w=><Card key={w.id} onClick={()=>onNav("workout_detail",{workoutId:w.id})}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <Kicker>{new Date(w.date||w.started_at).toLocaleDateString("ru",{day:"numeric",month:"short"})}</Kicker>
            <div style={{fontWeight:600,fontSize:15,color:C.text}}>{w.workout_type||"Тренировка"}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <Mono>{w.sets_count||0}</Mono><span style={{fontSize:11,color:C.muted}}> подх</span>
          </div>
        </div>
        <div style={{borderTop:`0.5px solid ${C.border}`,marginTop:10,paddingTop:10,display:"flex",gap:20}}>
          <div><div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>ТОННАЖ</div><Mono>{Math.round((w.total_volume||0)/1000*10)/10}</Mono><span style={{fontSize:11,color:C.muted}}> т</span></div>
          <div><div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>СТАТУС</div><span style={{fontSize:12,fontFamily:"monospace",color:w.status==="finished"?C.success:C.muted}}>{w.status==="finished"?"✓ ЗАВЕРШЕНА":w.status||"—"}</span></div>
        </div>
        <div style={{marginTop:8,fontSize:11,color:C.accent,fontFamily:"monospace"}}>ОТКРЫТЬ СОСТАВ →</div>
      </Card>)}
    </div>}
  </div>;
}

// ─── WORKOUT DETAIL ───────────────────────────────────────────────────────────
function WorkoutDetailScreen({workoutId,tgId,onBack}){
  const [data,setData]=useState(null);
  useEffect(()=>{
    fetch(`${API}/workout/${workoutId}?tg_id=${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData({exercises:[],status:"error"}));
  },[]);

  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text="ЗАГРУЗКА"/></div>;

  const totalSets=data.exercises?.reduce((s,e)=>s+e.sets.length,0)||0;
  const dateStr=data.date?new Date(data.date).toLocaleDateString("ru",{day:"numeric",month:"long",year:"numeric"}):"—";

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>{dateStr}</Kicker>
    <Hero>СОСТАВ ТРЕНИРОВКИ</Hero>
    <div style={{height:12}}/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
      {[{l:"ПОДХОДОВ",v:totalSets},{l:"ТОННАЖ",v:`${Math.round((data.total_volume||0)/1000*10)/10} т`},{l:"СТАТУС",v:data.status==="finished"?"✓":data.status||"—"}].map((s,i)=><Card key={i} style={{textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div><Mono size={14}>{s.v}</Mono></Card>)}
    </div>

    {data.exercises?.length===0&&<Card><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>Нет записей о подходах</div></Card>}

    {data.exercises?.map((ex,i)=><Card key={i} style={{marginBottom:10}}>
      <div style={{fontWeight:700,fontSize:15,color:C.text,marginBottom:10}}>{i+1}. {ex.name}</div>
      <div style={{display:"grid",gridTemplateColumns:"auto 1fr 1fr 1fr",gap:"4px 12px",alignItems:"center"}}>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>ПХ</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>ВЕС</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>ПОВТ</div>
        <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>RPE</div>
        {ex.sets.map(s=><>
          <Mono key={`n${s.set_number}`} size={13}>{s.set_number}</Mono>
          <Mono key={`w${s.set_number}`} size={13}>{s.weight!=null?`${s.weight} кг`:"—"}</Mono>
          <Mono key={`r${s.set_number}`} size={13}>{s.reps!=null?`${s.reps}`:"—"}</Mono>
          <Mono key={`e${s.set_number}`} size={13} color={C.muted}>{s.rpe||"—"}</Mono>
        </>)}
      </div>
    </Card>)}
  </div>;
}

// ─── ACTIVE WORKOUT ───────────────────────────────────────────────────────────
function ActiveWorkoutScreen({tgId,exercises,muscleGroups,onBack}){
  const STEP={SELECT_GROUP:0,SELECT_EX:1,WARMUP:2,ORDER:3,LOGGING:4,FINISH:5};
  const [step,setStep]=useState(STEP.SELECT_GROUP);
  const [selectedGroup,setSelectedGroup]=useState(null);
  const [selectedExs,setSelectedExs]=useState([]); // [{...ex, order}]
  const [warmupEx,setWarmupEx]=useState(null);
  const [workoutId,setWorkoutId]=useState(null);
  const [currentExIdx,setCurrentExIdx]=useState(0);
  const [sets,setSets]=useState({}); // {exId: [{reps,weight,time,distance,done}]}
  const [startTime]=useState(Date.now());
  const [finished,setFinished]=useState(false);

  const filteredEx=exercises?.filter(e=>!selectedGroup||e.muscle_group_id===selectedGroup)||[];

  function toggleEx(ex){
    setSelectedExs(prev=>{
      const has=prev.find(e=>e.id===ex.id);
      if(has)return prev.filter(e=>e.id!==ex.id);
      return [...prev,{...ex,order:prev.length+1}];
    });
  }
  function moveEx(idx,dir){
    setSelectedExs(prev=>{
      const arr=[...prev];
      const target=idx+dir;
      if(target<0||target>=arr.length)return arr;
      [arr[idx],arr[target]]=[arr[target],arr[idx]];
      return arr.map((e,i)=>({...e,order:i+1}));
    });
  }
  function replaceEx(idx,newEx){
    setSelectedExs(prev=>prev.map((e,i)=>i===idx?{...newEx,order:e.order}:e));
  }

  async function startWorkout(){
    try{
      const res=await fetch(`${API}/workout/start/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({exercise_ids:selectedExs.map(e=>e.id)})});
      const d=await res.json();
      setWorkoutId(d.workout_id);
      const initSets={};
      selectedExs.forEach(e=>{initSets[e.id]=[{reps:"",weight:"",time:"",distance:"",done:false}];});
      setSets(initSets);
      setStep(STEP.LOGGING);
    }catch{alert("Ошибка запуска");}
  }

  async function logSet(ex,setData){
    if(!workoutId)return;
    const setNum=(sets[ex.id]||[]).filter(s=>s.done).length+1;
    await fetch(`${API}/workout/${workoutId}/set?tg_id=${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({exercise_id:ex.id,exercise_name:ex.name,set_number:setNum,reps:parseInt(setData.reps)||null,weight:parseFloat(setData.weight)||null,duration_sec:parseInt(setData.time)||null,distance_km:parseFloat(setData.distance)||null})});
    setSets(prev=>({...prev,[ex.id]:[...( prev[ex.id]||[]).map((s,i)=>i===prev[ex.id].length-1?{...s,done:true}:s),{reps:"",weight:"",time:"",distance:"",done:false}]}));
  }

  async function finishWorkout(){
    const dur=Math.round((Date.now()-startTime)/60000);
    if(workoutId)await fetch(`${API}/workout/${workoutId}/finish?tg_id=${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({duration_minutes:dur})});
    setFinished(true);setStep(STEP.FINISH);
  }

  // FINISH
  if(step===STEP.FINISH)return <div style={{padding:"16px 16px 100px"}}>
    <div style={{textAlign:"center",paddingTop:60}}>
      <div style={{fontSize:60}}>🏆</div>
      <Hero style={{textAlign:"center",marginTop:16}}>ТРЕНИРОВКА ЗАВЕРШЕНА</Hero>
      <div style={{color:C.muted,fontSize:14,marginTop:8}}>Отличная работа!</div>
      <div style={{marginTop:8,fontFamily:"monospace",color:C.accent}}>{Math.round((Date.now()-startTime)/60000)} МИНУТ</div>
      <Btn accent full onClick={onBack} style={{marginTop:32}}>← В МЕНЮ</Btn>
    </div>
  </div>;

  // SELECT GROUP
  if(step===STEP.SELECT_GROUP)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/>
    <Kicker>ШАГ 1 / 4</Kicker><Hero>ГРУППА МЫШЦ</Hero>
    <div style={{height:12}}/>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {muscleGroups?.map(g=><Card key={g.id} onClick={()=>{setSelectedGroup(g.id);setStep(STEP.SELECT_EX);}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><span style={{fontSize:22,marginRight:12}}>{g.emoji}</span><span style={{fontSize:15,fontWeight:600,color:C.text}}>{g.name}</span></div>
          <span style={{color:C.accent}}>→</span>
        </div>
      </Card>)}
      <Card onClick={()=>{setSelectedGroup(null);setStep(STEP.SELECT_EX);}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><span style={{fontSize:22,marginRight:12}}>💪</span><span style={{fontSize:15,fontWeight:600,color:C.text}}>Все упражнения</span></div>
          <span style={{color:C.accent}}>→</span>
        </div>
      </Card>
    </div>
  </div>;

  // SELECT EXERCISES
  if(step===STEP.SELECT_EX){
    const [search,setSearch]=useState("");
    const [replaceIdx,setReplaceIdx]=useState(null);
    const filtered=filteredEx.filter(e=>!search||e.name.toLowerCase().includes(search.toLowerCase()));

    if(replaceIdx!==null)return <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setReplaceIdx(null)}/>
      <Kicker>ЗАМЕНА</Kicker><Hero>ВЫБЕРИ ЗАМЕНУ</Hero>
      <div style={{height:12}}/>
      {filtered.slice(0,30).map(ex=><ExCard key={ex.id} ex={ex} badge={DIFF_LABEL[ex.difficulty]} onClick={()=>{replaceEx(replaceIdx,ex);setReplaceIdx(null);}}/>)}
    </div>;

    return <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setStep(STEP.SELECT_GROUP)}/>
      <Kicker>ШАГ 2 / 4</Kicker><Hero>УПРАЖНЕНИЯ</Hero>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ПОИСК..." style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",boxSizing:"border-box",marginTop:12,marginBottom:12}}/>
      {selectedExs.length>0&&<div style={{marginBottom:12}}>
        <Kicker>ВЫБРАНО ({selectedExs.length})</Kicker>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {selectedExs.map((e,i)=><Tag key={e.id} color={C.accent}>{i+1}. {e.name.split(" ").slice(0,2).join(" ")}</Tag>)}
        </div>
      </div>}
      <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{filtered.length} УПРАЖНЕНИЙ</div>
      {filtered.slice(0,50).map(ex=>{
        const sel=selectedExs.find(e=>e.id===ex.id);
        return <ExCard key={ex.id} ex={ex} badge={DIFF_LABEL[ex.difficulty]}
          action={<button onClick={e=>{e.stopPropagation();toggleEx(ex);}} style={{flexShrink:0,width:32,height:32,borderRadius:8,background:sel?C.accent:C.card,border:`0.5px solid ${sel?C.accent:C.border}`,color:sel?C.bg:C.muted,fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{sel?`${sel.order}`:"+"}</button>}/>;
      })}
      {selectedExs.length>0&&<div style={{position:"sticky",bottom:80,marginTop:12}}>
        <Btn accent full onClick={()=>setStep(STEP.WARMUP)}>ДАЛЕЕ → РАЗМИНКА ({selectedExs.length})</Btn>
      </div>}
    </div>;
  }

  // WARMUP
  if(step===STEP.WARMUP){
    const cardioExs=exercises?.filter(e=>e.muscle_group_id===9)||[];
    return <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={()=>setStep(STEP.SELECT_EX)}/>
      <Kicker>ШАГ 3 / 4</Kicker><Hero>РАЗМИНКА</Hero>
      <div style={{fontSize:13,color:C.muted,marginTop:8,marginBottom:16}}>Выбери кардио-упражнение для разминки (опционально)</div>
      <Btn full onClick={()=>setStep(STEP.ORDER)} style={{marginBottom:12}}>ПРОПУСТИТЬ РАЗМИНКУ</Btn>
      {cardioExs.map(ex=><ExCard key={ex.id} ex={ex}
        action={<button onClick={()=>{setWarmupEx(warmupEx?.id===ex.id?null:ex);}} style={{flexShrink:0,width:32,height:32,borderRadius:8,background:warmupEx?.id===ex.id?C.accent:C.card,border:`0.5px solid ${warmupEx?.id===ex.id?C.accent:C.border}`,color:warmupEx?.id===ex.id?C.bg:C.muted,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{warmupEx?.id===ex.id?"✓":"+"}</button>}/>)}
      <div style={{position:"sticky",bottom:80,marginTop:12}}>
        <Btn accent full onClick={()=>setStep(STEP.ORDER)}>{warmupEx?"РАЗМИНКА: "+warmupEx.name.split(" ").slice(0,2).join(" ")+" →":"ДАЛЕЕ БЕЗ РАЗМИНКИ"}</Btn>
      </div>
    </div>;
  }

  // ORDER/SWAP
  if(step===STEP.ORDER)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setStep(STEP.WARMUP)}/>
    <Kicker>ШАГ 4 / 4</Kicker><Hero>ПОРЯДОК</Hero>
    <div style={{fontSize:13,color:C.muted,marginTop:8,marginBottom:16}}>Перетащи или меняй стрелками. Нажми на имя — заменить упражнение.</div>
    {warmupEx&&<Card accent style={{marginBottom:12}}>
      <div style={{fontSize:12,color:C.accent,fontFamily:"monospace",marginBottom:4}}>🏃 РАЗМИНКА</div>
      <div style={{fontWeight:600,color:C.text}}>{warmupEx.name}</div>
    </Card>}
    <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
      {selectedExs.map((ex,i)=><Card key={ex.id}>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <Mono color={C.accent} size={20}>{i+1}</Mono>
          <div style={{flex:1}} onClick={()=>{/* replace handled below */}}>
            <div style={{fontWeight:600,fontSize:14,color:C.text}}>{ex.name}</div>
            <div style={{fontSize:11,color:C.muted}}>{ex.group_emoji} {ex.group_name}</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            <button onClick={()=>moveEx(i,-1)} disabled={i===0} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:4,color:C.muted,width:28,height:24,cursor:"pointer",fontSize:12}}>↑</button>
            <button onClick={()=>moveEx(i,1)} disabled={i===selectedExs.length-1} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:4,color:C.muted,width:28,height:24,cursor:"pointer",fontSize:12}}>↓</button>
          </div>
        </div>
      </Card>)}
    </div>
    <Btn accent full onClick={startWorkout}>▶ НАЧАТЬ ТРЕНИРОВКУ</Btn>
  </div>;

  // LOGGING
  if(step===STEP.LOGGING){
    const ex=selectedExs[currentExIdx];
    if(!ex)return null;
    const cType=cardioType(ex.name);
    const exSets=sets[ex.id]||[];
    const doneSets=exSets.filter(s=>s.done);
    const curSet=exSets[exSets.length-1]||{};
    const [localSet,setLocalSet]=useState({reps:"",weight:"",time:"",distance:""});

    return <div style={{padding:"16px 16px 100px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <Kicker>{currentExIdx+1} / {selectedExs.length}</Kicker>
        <button onClick={finishWorkout} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:8,padding:"6px 12px",color:C.danger,fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>ЗАВЕРШИТЬ</button>
      </div>
      {ex.photo_url&&<img src={ex.photo_url} alt="" style={{width:"100%",borderRadius:12,marginBottom:12,maxHeight:180,objectFit:"cover"}} onError={e=>e.target.style.display="none"}/>}
      <Kicker>{ex.group_emoji} {ex.group_name}</Kicker>
      <Hero style={{fontSize:20}}>{ex.name}</Hero>
      <div style={{fontSize:12,color:C.muted,marginTop:4,marginBottom:16}}>{ex.sets_recommended} подходов · {ex.reps_recommended} повторений</div>

      {doneSets.length>0&&<Card style={{marginBottom:12}}>
        <Kicker>ВЫПОЛНЕНО</Kicker>
        <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:6}}>
          {doneSets.map((s,i)=><div key={i} style={{textAlign:"center"}}>
            <div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>ПХ {i+1}</div>
            <Mono size={14}>{cType==="distance"?`${s.distance}км`:cType==="time"?`${s.time}с`:`${s.weight}кг×${s.reps}`}</Mono>
          </div>)}
        </div>
      </Card>}

      <Card accent style={{marginBottom:16}}>
        <Kicker>ПОДХОД {doneSets.length+1}</Kicker>
        <div style={{display:"flex",gap:10,marginTop:10}}>
          {cType===null&&<>
            <div style={{flex:1}}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:6}}>ВЕС (КГ)</div><input type="number" value={localSet.weight} onChange={e=>setLocalSet(p=>({...p,weight:e.target.value}))} placeholder="0" style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/></div>
            <div style={{flex:1}}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:6}}>ПОВТОРЕНИЙ</div><input type="number" value={localSet.reps} onChange={e=>setLocalSet(p=>({...p,reps:e.target.value}))} placeholder="0" style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/></div>
          </>}
          {cType==="time"&&<div style={{flex:1}}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:6}}>ВРЕМЯ (СЕК)</div><input type="number" value={localSet.time} onChange={e=>setLocalSet(p=>({...p,time:e.target.value}))} placeholder="0" style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/></div>}
          {cType==="distance"&&<><div style={{flex:1}}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:6}}>ВРЕМЯ (МИН)</div><input type="number" value={localSet.time} onChange={e=>setLocalSet(p=>({...p,time:e.target.value}))} placeholder="0" style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/></div><div style={{flex:1}}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:6}}>ДИСТАНЦИЯ (КМ)</div><input type="number" step="0.1" value={localSet.distance} onChange={e=>setLocalSet(p=>({...p,distance:e.target.value}))} placeholder="0" style={{background:"none",border:"none",color:C.accent,fontSize:26,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/></div></>}
        </div>
      </Card>

      <Btn accent full onClick={async()=>{await logSet(ex,localSet);setLocalSet({reps:"",weight:"",time:"",distance:""});}} style={{marginBottom:10}}>+ ЗАПИСАТЬ ПОДХОД</Btn>
      <div style={{display:"flex",gap:10}}>
        <Btn full onClick={()=>setCurrentExIdx(i=>Math.max(0,i-1))} disabled={currentExIdx===0} style={{flex:1}}>← ПРЕД</Btn>
        <Btn full onClick={()=>setCurrentExIdx(i=>Math.min(selectedExs.length-1,i+1))} disabled={currentExIdx===selectedExs.length-1} style={{flex:1}}>СЛЕД →</Btn>
      </div>
      <div style={{display:"flex",gap:6,marginTop:10,overflowX:"auto",paddingBottom:4}}>
        {selectedExs.map((e,i)=><button key={e.id} onClick={()=>setCurrentExIdx(i)} style={{flexShrink:0,padding:"4px 10px",borderRadius:16,background:i===currentExIdx?C.accent:C.card,border:`0.5px solid ${i===currentExIdx?C.accent:C.border}`,color:i===currentExIdx?C.bg:C.muted,fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>{i+1}</button>)}
      </div>
    </div>;
  }

  return null;
}

// ─── MY WORKOUTS DETAIL ───────────────────────────────────────────────────────
function MyWorkoutsDetailScreen({tgId,onBack,onNav}){
  const [data,setData]=useState(null);
  const [deleting,setDeleting]=useState(null);
  function load(){
    if(!tgId){setData({planned:[],archive:[]});return;}
    fetch(`${API}/planned/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData({planned:[],archive:[]}));
  }
  useEffect(()=>{load();},[]);
  async function del(id){setDeleting(id);try{await fetch(`${API}/planned/${tgId}/${id}`,{method:"DELETE"});load();}catch{}finally{setDeleting(null);};}
  const fmtDt=iso=>{if(!iso)return"—";const d=new Date(iso);return d.toLocaleString("ru",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});};
  const statusColor={scheduled:C.accent,reminded:C.warn,completed:C.success,missed:C.danger};
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>РАСПИСАНИЕ</Kicker><Hero>МОИ ТРЕНИРОВКИ</Hero>
    <div style={{height:16}}/>
    <Kicker>ПРЕДСТОЯЩИЕ</Kicker>
    {data.planned.length===0?<Card style={{marginBottom:16}}><div style={{textAlign:"center",padding:"12px 0",color:C.muted,fontSize:14}}>Нет запланированных тренировок</div></Card>:
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
        <div style={{marginTop:8,fontSize:11,color:C.accent,fontFamily:"monospace"}}>ОТКРЫТЬ СОСТАВ →</div>
      </Card>)}
    </div>}
    {data.archive.length>0&&<><Kicker>АРХИВ</Kicker><div style={{display:"flex",flexDirection:"column",gap:8}}>
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
function PlannedDetailScreen({pwId,tgId,onBack,exercises}){
  const [data,setData]=useState(null);
  const [editing,setEditing]=useState(false);
  const [form,setForm]=useState({title:"",date:"",time:""});
  const [saving,setSaving]=useState(false);

  useEffect(()=>{
    fetch(`${API}/planned/${tgId}/${pwId}`).then(r=>r.json()).then(d=>{setData(d);if(d.planned_datetime){const dt=new Date(d.planned_datetime);setForm({title:d.title||"",date:dt.toISOString().split("T")[0],time:dt.toTimeString().slice(0,5)});}}).catch(()=>setData({exercises:[]}));
  },[]);

  async function save(){
    setSaving(true);
    try{
      const body={title:form.title,planned_datetime:`${form.date}T${form.time}:00`};
      await fetch(`${API}/planned/${tgId}/${pwId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const updated=await fetch(`${API}/planned/${tgId}/${pwId}`).then(r=>r.json());
      setData(updated);setEditing(false);
    }catch{}finally{setSaving(false);}
  }

  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  const dt=data.planned_datetime?new Date(data.planned_datetime).toLocaleString("ru",{day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"}):"—";

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ЗАПЛАНИРОВАННАЯ ТРЕНИРОВКА</Kicker>
    {!editing?<>
      <Hero>{data.title||"Тренировка"}</Hero>
      <div style={{fontSize:13,color:C.accent,fontFamily:"monospace",marginTop:6,marginBottom:16}}>📅 {dt}</div>
      <Btn full onClick={()=>setEditing(true)} style={{marginBottom:16}}>✏ ИЗМЕНИТЬ ДАТУ/НАЗВАНИЕ</Btn>
      {data.exercises?.length===0?<Card><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>Упражнения не выбраны</div></Card>:
      <><Kicker>УПРАЖНЕНИЯ ({data.exercises?.length})</Kicker>
      {data.exercises?.map(ex=><Card key={ex.id} style={{marginBottom:8}}>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <Mono color={C.accent} size={20}>{ex.order}</Mono>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14,color:C.text}}>{ex.name}</div>
            <div style={{fontSize:11,color:C.muted,marginTop:2}}>{ex.group_emoji} {ex.group_name}</div>
            <div style={{display:"flex",gap:10,marginTop:6}}>
              <Tag color={DIFF_COLOR[ex.difficulty]||C.muted}>{DIFF_LABEL[ex.difficulty]}</Tag>
              <span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{ex.sets_recommended}×{ex.reps_recommended}</span>
            </div>
            {ex.description&&<div style={{fontSize:12,color:C.muted,marginTop:6,lineHeight:1.5}}>{ex.description}</div>}
          </div>
        </div>
      </Card>)}</>}
    </>:<>
      <Hero>ИЗМЕНИТЬ</Hero>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginTop:16,marginBottom:16}}>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>НАЗВАНИЕ</div><input value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} style={{background:"none",border:"none",color:C.text,fontSize:16,width:"100%",outline:"none"}}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ДАТА</div><input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} style={{background:"none",border:"none",color:C.accent,fontSize:18,fontFamily:"monospace",fontWeight:700,outline:"none",width:"100%"}}/></Card>
        <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ВРЕМЯ</div><input type="time" value={form.time} onChange={e=>setForm(p=>({...p,time:e.target.value}))} style={{background:"none",border:"none",color:C.accent,fontSize:18,fontFamily:"monospace",fontWeight:700,outline:"none",width:"100%"}}/></Card>
      </div>
      <div style={{display:"flex",gap:10}}><Btn full onClick={()=>setEditing(false)} style={{flex:1}}>ОТМЕНА</Btn><Btn accent full onClick={save} disabled={saving} style={{flex:2}}>{saving?"...":"СОХРАНИТЬ"}</Btn></div>
    </>}
  </div>;
}

// ─── PLAN WORKOUT ─────────────────────────────────────────────────────────────
function PlanWorkoutScreen({tgId,exercises,muscleGroups,onBack}){
  const [step,setStep]=useState(0); // 0=group, 1=exercises, 2=datetime
  const [selGroup,setSelGroup]=useState(null);
  const [selExs,setSelExs]=useState([]);
  const [form,setForm]=useState({title:"",date:"",time:"10:00"});
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);
  const [search,setSearch]=useState("");

  const filtered=(exercises||[]).filter(e=>(!selGroup||e.muscle_group_id===selGroup)&&(!search||e.name.toLowerCase().includes(search.toLowerCase())));
  const toggle=ex=>setSelExs(prev=>prev.find(e=>e.id===ex.id)?prev.filter(e=>e.id!==ex.id):[...prev,ex]);

  async function save(){
    if(!form.date||!form.time)return;
    setSaving(true);
    try{
      const title=form.title||selExs.slice(0,2).map(e=>e.name.split(" ")[0]).join("+")||"Тренировка";
      const res=await fetch(`${API}/planned/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,planned_datetime:`${form.date}T${form.time}:00`,exercise_ids:selExs.map(e=>e.id)})});
      if(res.ok)setSaved(true);
    }catch{}finally{setSaving(false);}
  }

  if(saved)return <div style={{padding:"16px 16px 100px"}}>
    <div style={{textAlign:"center",paddingTop:60}}>
      <div style={{fontSize:48,color:C.accent}}>📅</div>
      <Hero style={{textAlign:"center",marginTop:16}}>ЗАПЛАНИРОВАНО</Hero>
      <div style={{color:C.muted,marginTop:8,fontFamily:"monospace"}}>Бот напомнит за 1 час</div>
      <Btn accent full onClick={onBack} style={{marginTop:32}}>← НАЗАД</Btn>
    </div>
  </div>;

  if(step===0)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ПЛАНИРОВАНИЕ · ШАГ 1</Kicker><Hero>ГРУППА МЫШЦ</Hero>
    <div style={{height:12}}/>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {muscleGroups?.map(g=><Card key={g.id} onClick={()=>{setSelGroup(g.id);setStep(1);}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><span style={{fontSize:22,marginRight:12}}>{g.emoji}</span><span style={{fontSize:15,fontWeight:600,color:C.text}}>{g.name}</span></div><span style={{color:C.accent}}>→</span></div>
      </Card>)}
      <Card onClick={()=>{setSelGroup(null);setStep(1);}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><span style={{fontSize:22,marginRight:12}}>💪</span><span style={{fontSize:15,fontWeight:600,color:C.text}}>Все упражнения</span></div><span style={{color:C.accent}}>→</span></div></Card>
    </div>
  </div>;

  if(step===1)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setStep(0)}/><Kicker>ПЛАНИРОВАНИЕ · ШАГ 2</Kicker><Hero>УПРАЖНЕНИЯ</Hero>
    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ПОИСК..." style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",boxSizing:"border-box",marginTop:12,marginBottom:12}}/>
    {selExs.length>0&&<div style={{marginBottom:12}}><Kicker>ВЫБРАНО ({selExs.length})</Kicker><div style={{display:"flex",flexWrap:"wrap",gap:6}}>{selExs.map((e,i)=><Tag key={e.id} color={C.accent}>{i+1}. {e.name.split(" ").slice(0,2).join(" ")}</Tag>)}</div></div>}
    {filtered.slice(0,50).map(ex=>{const sel=selExs.find(e=>e.id===ex.id);return<ExCard key={ex.id} ex={ex} badge={DIFF_LABEL[ex.difficulty]}
      action={<button onClick={e=>{e.stopPropagation();toggle(ex);}} style={{flexShrink:0,width:32,height:32,borderRadius:8,background:sel?C.accent:C.card,border:`0.5px solid ${sel?C.accent:C.border}`,color:sel?C.bg:C.muted,fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>{sel?`${selExs.indexOf(sel)+1}`:"+"}</button>}/>;
    })}
    {selExs.length>0&&<div style={{position:"sticky",bottom:80,marginTop:12}}><Btn accent full onClick={()=>setStep(2)}>ДАЛЕЕ → ДАТА И ВРЕМЯ</Btn></div>}
  </div>;

  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setStep(1)}/><Kicker>ПЛАНИРОВАНИЕ · ШАГ 3</Kicker><Hero>ДАТА И ВРЕМЯ</Hero>
    <div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
      <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>НАЗВАНИЕ (ОПЦИОНАЛЬНО)</div><input value={form.title} onChange={e=>setForm(p=>({...p,title:e.target.value}))} placeholder={selExs.slice(0,2).map(e=>e.name.split(" ")[0]).join("+")||"Моя тренировка"} style={{background:"none",border:"none",color:C.text,fontSize:16,width:"100%",outline:"none"}}/></Card>
      <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ДАТА</div><input type="date" value={form.date} min={new Date().toISOString().split("T")[0]} onChange={e=>setForm(p=>({...p,date:e.target.value}))} style={{background:"none",border:"none",color:C.accent,fontSize:20,fontFamily:"monospace",fontWeight:700,outline:"none",width:"100%"}}/></Card>
      <Card><div style={{fontSize:11,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ВРЕМЯ</div><input type="time" value={form.time} onChange={e=>setForm(p=>({...p,time:e.target.value}))} style={{background:"none",border:"none",color:C.accent,fontSize:20,fontFamily:"monospace",fontWeight:700,outline:"none",width:"100%"}}/></Card>
    </div>
    <div style={{marginBottom:16}}><Kicker>УПРАЖНЕНИЯ ({selExs.length})</Kicker>{selExs.map((e,i)=><div key={e.id} style={{padding:"6px 0",borderBottom:`0.5px solid ${C.border}`,display:"flex",gap:10}}><Mono color={C.accent} size={13}>{i+1}</Mono><span style={{fontSize:13,color:C.text}}>{e.name}</span></div>)}</div>
    <Btn accent full onClick={save} disabled={saving||!form.date}>{saving?"СОХРАНЯЕМ...":"📅 ЗАПЛАНИРОВАТЬ"}</Btn>
    <div style={{fontSize:11,color:C.muted,fontFamily:"monospace",textAlign:"center",marginTop:8}}>Бот напомнит за 1 час до тренировки</div>
  </div>;
}

// ─── PROGRESS ─────────────────────────────────────────────────────────────────
function ProgressScreen({stats}){
  if(!stats)return <div style={{padding:"16px 16px 100px"}}><Loader text="ПРОГРЕСС"/></div>;
  const weekly=stats.weekly_workouts||[];const peak=Math.max(...weekly,1);
  const blocks=" ▁▂▃▄▅▆▇█";const spark=weekly.map(v=>blocks[Math.min(8,Math.round(8*v/peak))]).join("");
  return <div style={{padding:"16px 16px 100px"}}>
    <Kicker>{stats.period_days||30} ДНЕЙ</Kicker><Hero>{stats.period_days||30} ДНЕЙ ОГНЯ</Hero>
    <div style={{height:16}}/>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
      {[{l:"ТРЕНИРОВОК",v:stats.total_workouts||0},{l:"ПОДХОДОВ",v:stats.total_sets||0},{l:"ТОННАЖ",v:`${Math.round((stats.total_volume||0)/1000*10)/10} т`},{l:"СЕРИЯ",v:`${stats.streak_days||0} дн`}].map((s,i)=><Card key={i}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div><Mono>{s.v}</Mono></Card>)}
    </div>
    {weekly.length>0&&<Card style={{marginBottom:16}}><Kicker>ПО НЕДЕЛЯМ</Kicker><div style={{fontFamily:"monospace",fontSize:22,color:C.accent,letterSpacing:2,margin:"8px 0"}}>{spark||"нет данных"}</div><div style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>тренировок в неделю</div></Card>}
    {stats.weight_logs?.length>0&&<Card><Kicker>ДИНАМИКА ВЕСА</Kicker><div style={{marginTop:8}}>{stats.weight_logs.slice(-5).map((w,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`0.5px solid ${C.border}`}}><span style={{fontSize:12,color:C.muted,fontFamily:"monospace"}}>{new Date(w.logged_at).toLocaleDateString("ru",{day:"numeric",month:"short"})}</span><Mono size={14}>{w.weight} кг</Mono></div>)}</div></Card>}
  </div>;
}

// ─── CATALOG ──────────────────────────────────────────────────────────────────
function CatalogScreen({exercises,muscleGroups}){
  const [activeGroup,setActiveGroup]=useState(null);
  const [search,setSearch]=useState("");
  const [selected,setSelected]=useState(null);
  const filtered=(exercises||[]).filter(e=>(!activeGroup||e.muscle_group_id===activeGroup)&&(!search||e.name.toLowerCase().includes(search.toLowerCase())));

  if(selected)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setSelected(null)}/>
    {selected.photo_url&&<img src={selected.photo_url} alt={selected.name} style={{width:"100%",borderRadius:12,marginBottom:14,objectFit:"cover",maxHeight:220}} onError={e=>e.target.style.display="none"}/>}
    <Kicker>{selected.group_emoji} {selected.group_name?.toUpperCase()}</Kicker><Hero>{selected.name}</Hero>
    <div style={{height:12}}/>
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      {[{l:"ПОДХОДОВ",v:selected.sets_recommended},{l:"ПОВТОРЕНИЙ",v:selected.reps_recommended},{l:"СЛОЖНОСТЬ",v:DIFF_LABEL[selected.difficulty]||selected.difficulty}].map((s,i)=><Card key={i} style={{flex:1,textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:4}}>{s.l}</div><div style={{fontSize:14,fontWeight:700,color:C.accent}}>{s.v||"—"}</div></Card>)}
    </div>
    {selected.description&&<Card style={{marginBottom:10}}><Kicker>ОПИСАНИЕ</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:6}}>{selected.description}</div></Card>}
    {selected.equipment&&<Card><Kicker>ОБОРУДОВАНИЕ</Kicker><div style={{fontSize:14,color:C.text,marginTop:4}}>{selected.equipment}</div></Card>}
  </div>;

  return <div style={{padding:"16px 16px 100px"}}>
    <Kicker>БАЗА ЗНАНИЙ</Kicker><Hero>УПРАЖНЕНИЯ</Hero>
    <div style={{height:12}}/>
    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="ПОИСК..." style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",letterSpacing:1,boxSizing:"border-box",marginBottom:12,outline:"none"}}/>
    <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:8,marginBottom:12}}>
      <button onClick={()=>setActiveGroup(null)} style={{flexShrink:0,padding:"6px 12px",borderRadius:20,background:!activeGroup?C.accent:C.card,color:!activeGroup?C.bg:C.muted,border:`0.5px solid ${!activeGroup?C.accent:C.border}`,fontSize:11,fontFamily:"monospace",cursor:"pointer",fontWeight:700}}>ВСЕ</button>
      {muscleGroups?.map(g=><button key={g.id} onClick={()=>setActiveGroup(g.id===activeGroup?null:g.id)} style={{flexShrink:0,padding:"6px 12px",borderRadius:20,background:activeGroup===g.id?C.accent:C.card,color:activeGroup===g.id?C.bg:C.muted,border:`0.5px solid ${activeGroup===g.id?C.accent:C.border}`,fontSize:11,fontFamily:"monospace",cursor:"pointer"}}>{g.emoji} {g.name.toUpperCase()}</button>)}
    </div>
    <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>{filtered.length} УПРАЖНЕНИЙ</div>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {filtered.slice(0,60).map(ex=><ExCard key={ex.id} ex={ex} badge={DIFF_LABEL[ex.difficulty]} onClick={()=>setSelected(ex)}/>)}
    </div>
  </div>;
}

// ─── AI ───────────────────────────────────────────────────────────────────────
function AIScreen({user}){
  const [q,setQ]=useState("");const [answer,setAnswer]=useState(null);const [loading,setLoading]=useState(false);
  const requestsLeft=5-(user?.ai_requests_today||0);
  const suggs=["Сплит на 3 дня под набор массы","Что есть до и после тренировки","Техника приседаний со штангой","Программа для похудения на месяц"];
  async function ask(question){
    if(!question.trim()||loading)return;
    setLoading(true);setAnswer(null);setQ("");
    try{const res=await fetch(`${API}/ai/ask`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({question,tg_id:tg?.initDataUnsafe?.user?.id})});const d=await res.json();setAnswer(d.answer||"Нет ответа");}
    catch{setAnswer("Ошибка соединения.");}finally{setLoading(false);}
  }
  return <div style={{padding:"16px 16px 100px"}}>
    <Kicker>AI ТРЕНЕР</Kicker><Hero>ТРЕНЕР НА СВЯЗИ</Hero>
    <div style={{color:C.muted,fontSize:13,marginTop:6,marginBottom:16,fontFamily:"monospace"}}>ЗАПРОСОВ ОСТАЛОСЬ · <Mono size={13}>{requestsLeft}</Mono></div>
    <div style={{display:"flex",gap:8,marginBottom:16}}>
      <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&ask(q)} placeholder="СПРОСИ ЧТО УГОДНО..." style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none"}}/>
      <button onClick={()=>ask(q)} disabled={loading||!q.trim()} style={{background:C.accent,border:"none",borderRadius:8,padding:"10px 16px",color:C.bg,fontWeight:700,fontSize:14,cursor:"pointer",opacity:loading||!q.trim()?0.5:1}}>→</button>
    </div>
    <div style={{marginBottom:16}}><div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginBottom:8}}>БЫСТРЫЕ ВОПРОСЫ</div><div style={{display:"flex",flexDirection:"column",gap:6}}>{suggs.map((s,i)=><button key={i} onClick={()=>{setQ(s);ask(s);}} style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,cursor:"pointer",textAlign:"left"}}>{s} →</button>)}</div></div>
    {loading&&<Card><div style={{textAlign:"center",padding:"16px 0"}}><div style={{color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:2}}>ТРЕНЕР ДУМАЕТ...</div></div></Card>}
    {answer&&<Card accent><Kicker>ОТВЕТ ТРЕНЕРА</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:8,whiteSpace:"pre-wrap"}}>{answer}</div><button onClick={()=>setAnswer(null)} style={{marginTop:12,background:"none",border:`0.5px solid ${C.accent}`,borderRadius:8,padding:"8px 16px",color:C.accent,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>+ ЕЩЁ ВОПРОС</button></Card>}
  </div>;
}

// ─── NUTRITION ────────────────────────────────────────────────────────────────
function NutritionScreen({tgId,onBack}){
  const [data,setData]=useState(null);const [error,setError]=useState(null);
  useEffect(()=>{if(!tgId){setError("Войди через Telegram");return;}fetch(`${API}/nutrition/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setError("Ошибка загрузки"));},[]);
  if(error)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Card><div style={{color:C.danger,fontFamily:"monospace",fontSize:13}}>{error}</div></Card></div>;
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text="ПИТАНИЕ"/></div>;
  const t=data.today_totals||{};const pct=Math.min(100,Math.round(((t.kcal||0)/Math.max(data.target_kcal,1))*100));
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ПИТАНИЕ СЕГОДНЯ</Kicker><Hero>НУТРИЕНТЫ</Hero>
    <div style={{height:16}}/>
    <Card accent style={{marginBottom:12}}>
      <Kicker>КАЛОРИИ</Kicker>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginTop:8}}><Mono>{t.kcal||0} <span style={{fontSize:13,color:C.muted,fontWeight:400}}>ккал</span></Mono><span style={{fontFamily:"monospace",fontSize:12,color:C.muted}}>цель {data.target_kcal}</span></div>
      <div style={{marginTop:10}}><ProgressBar pct={pct}/></div>
      <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginTop:4}}>{pct}% ОТ ЦЕЛИ · TDEE {data.tdee}</div>
    </Card>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
      {[{l:"БЕЛОК",v:t.protein||0},{l:"ЖИРЫ",v:t.fat||0},{l:"УГЛЕВОДЫ",v:t.carb||0}].map((m,i)=><Card key={i} style={{textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace",marginBottom:6}}>{m.l}</div><Mono size={14}>{m.v} <span style={{fontSize:11,color:C.muted,fontWeight:400}}>г</span></Mono></Card>)}
    </div>
    {data.today_logs?.length>0?<><Kicker>ПРИЁМЫ ПИЩИ</Kicker><div style={{display:"flex",flexDirection:"column",gap:8,marginTop:8}}>{data.today_logs.map((l,i)=><Card key={i}><div style={{display:"flex",justifyContent:"space-between"}}><div style={{fontWeight:600,fontSize:14,color:C.text}}>{l.meal_name}</div><Mono size={14}>{l.kcal||0} <span style={{fontSize:11,color:C.muted,fontWeight:400}}>ккал</span></Mono></div><div style={{display:"flex",gap:12,marginTop:6}}><span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>Б {l.protein}г</span><span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>Ж {l.fat}г</span><span style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>У {l.carb}г</span></div></Card>)}</div></>:
    <Card><div style={{textAlign:"center",padding:"16px 0",color:C.muted,fontSize:14}}>Сегодня записей нет<br/><span style={{fontSize:12,fontFamily:"monospace",color:C.accent}}>ДОБАВЬ В БОТЕ →</span></div></Card>}
  </div>;
}

// ─── FOOD GUIDE ───────────────────────────────────────────────────────────────
function FoodGuideScreen({onBack}){
  const [cats,setCats]=useState(null);const [sel,setSel]=useState(null);
  useEffect(()=>{fetch(`${API}/food-guide`).then(r=>r.json()).then(d=>setCats(d.categories||[])).catch(()=>setCats([]));},[]);
  if(sel)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setSel(null)}/>
    <div style={{fontSize:40,marginBottom:8}}>{sel.emoji}</div>
    <Kicker>СПРАВОЧНИК ПРОДУКТОВ</Kicker><Hero>{sel.name}</Hero>
    <div style={{height:16}}/>
    <Card accent style={{marginBottom:10}}>
      <Kicker>КБЖУ НА 100Г</Kicker>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
        {[{l:"КАЛОРИИ",v:sel.kcal,u:"ккал"},{l:"БЕЛОК",v:sel.protein,u:"г"},{l:"ЖИРЫ",v:sel.fat,u:"г"},{l:"УГЛЕВОДЫ",v:sel.carb,u:"г"}].map((m,i)=><div key={i}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{m.l}</div><Mono size={14}>{m.v} <span style={{fontSize:11,color:C.muted,fontWeight:400}}>{m.u}</span></Mono></div>)}
      </div>
    </Card>
    {[{label:"⏰ КОГДА ЕСТЬ",value:sel.timing},{label:"💡 СОВЕТЫ",value:sel.tips},{label:"🏆 ЛУЧШИЕ ПРОДУКТЫ",value:sel.best},{label:"✅ СОЧЕТАЕТСЯ С",value:sel.combines},{label:"❌ НЕ СОЧЕТАТЬ",value:sel.avoid}].map((r,i)=><Card key={i} style={{marginBottom:8}}><Kicker>{r.label}</Kicker><div style={{fontSize:13,color:C.text,lineHeight:1.6,marginTop:4}}>{r.value}</div></Card>)}
  </div>;
  if(!cats)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>СПРАВОЧНИК</Kicker><Hero>КАТАЛОГ ПРОДУКТОВ</Hero>
    <div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {cats.map((c,i)=><Card key={i} onClick={()=>setSel(c)}>
        <div style={{display:"flex",gap:14,alignItems:"center"}}>
          <span style={{fontSize:32}}>{c.emoji}</span>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:15,color:C.text}}>{c.name}</div><div style={{fontSize:11,color:C.muted,marginTop:2,fontFamily:"monospace"}}>{c.kcal} ккал · Б {c.protein}г · Ж {c.fat}г · У {c.carb}г</div></div>
          <span style={{color:C.accent,fontSize:16}}>→</span>
        </div>
      </Card>)}
    </div>
  </div>;
}

// ─── SUPPLEMENTS ──────────────────────────────────────────────────────────────
function SupplementsScreen({onBack}){
  const [sel,setSel]=useState(null);
  const supps=[
    {name:"Протеин",icon:"🥛",kcal:"~400",protein:"70-90",fat:"5-10",carb:"5-10",timing:"После тренировки или в любое время дня",dose:"20–40г за приём",tips:"Восполнение белка. Сывороточный — быстрый, казеин — медленный (на ночь)."},
    {name:"Креатин моногидрат",icon:"⚡",kcal:"0",protein:"0",fat:"0",carb:"0",timing:"В любое время, ежедневно",dose:"3–5г/день",tips:"Без загрузки. Результат через 2–4 недели. Запивай водой (250мл)."},
    {name:"Омега-3",icon:"🐟",kcal:"9",protein:"0",fat:"1",carb:"0",timing:"Во время еды",dose:"1–3г EPA+DHA/день",tips:"Противовоспалительный эффект, суставы, сердце. Смотри на EPA+DHA, не общий жир."},
    {name:"Витамин D3",icon:"☀️",kcal:"0",protein:"0",fat:"0",carb:"0",timing:"Утром с жирной едой",dose:"2000–5000 МЕ/день",tips:"Иммунитет, тестостерон, кости. Принимать с K2 (100–200мкг) для усвоения."},
    {name:"Магний",icon:"💊",kcal:"0",protein:"0",fat:"0",carb:"0",timing:"Перед сном",dose:"200–400мг",tips:"Качество сна, мышечное восстановление. Форма: глицинат или малат (не оксид)."},
    {name:"Кофеин",icon:"☕",kcal:"0",protein:"0",fat:"0",carb:"0",timing:"За 30–45 мин до тренировки",dose:"3–6мг/кг веса",tips:"Предтрен. Повышает выносливость и силу. Не принимать после 15:00."},
    {name:"Цинк",icon:"🔩",kcal:"0",protein:"0",fat:"0",carb:"0",timing:"Во время еды или перед сном",dose:"15–30мг/день",tips:"Иммунитет, тестостерон. Не вместе с кальцием — конкурируют за усвоение."},
    {name:"Коллаген",icon:"🦴",kcal:"35",protein:"9",fat:"0",carb:"0",timing:"За 1 час до тренировки с витамином C",dose:"10г/день",tips:"Суставы и связки. Нужен витамин C для синтеза — добавь 100мг."},
  ];
  if(sel)return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={()=>setSel(null)}/>
    <div style={{fontSize:40,marginBottom:8}}>{sel.icon}</div>
    <Kicker>СПОРТИВНЫЕ ДОБАВКИ</Kicker><Hero>{sel.name}</Hero>
    <div style={{height:16}}/>
    <Card accent style={{marginBottom:10}}>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        {[{l:"ДОЗА",v:sel.dose},{l:"ВРЕМЯ",v:sel.timing}].map((s,i)=><div key={i}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{s.l}</div><div style={{fontSize:13,color:C.accent,fontWeight:600,marginTop:2}}>{s.v}</div></div>)}
      </div>
    </Card>
    <Card><Kicker>ОПИСАНИЕ И СОВЕТЫ</Kicker><div style={{fontSize:14,color:C.text,lineHeight:1.6,marginTop:6}}>{sel.tips}</div></Card>
  </div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>СПРАВОЧНИК</Kicker><Hero>ДОБАВКИ</Hero>
    <div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {supps.map((s,i)=><Card key={i} onClick={()=>setSel(s)}>
        <div style={{display:"flex",gap:14,alignItems:"center"}}>
          <span style={{fontSize:32}}>{s.icon}</span>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:15,color:C.text}}>{s.name}</div><div style={{fontSize:11,color:C.muted,marginTop:2,fontFamily:"monospace"}}>{s.dose} · {s.timing.split(",")[0]}</div></div>
          <span style={{color:C.accent,fontSize:16}}>→</span>
        </div>
      </Card>)}
    </div>
  </div>;
}

// ─── MEASUREMENTS / CHECKIN / LANGUAGE / SUPPORT / GOALS / REMINDERS ─────────
function MeasurementsScreen({onBack}){
  const [sent,setSent]=useState(false);const [form,setForm]=useState({waist:"",hips:"",chest:"",arm:"",thigh:""});
  const fields=[{key:"waist",label:"Талия"},{key:"hips",label:"Бёдра"},{key:"chest",label:"Грудь"},{key:"arm",label:"Рука (бицепс)"},{key:"thigh",label:"Бедро"}];
  function send(){if(!Object.values(form).some(v=>v))return;tg?.sendData(JSON.stringify({action:"save_measurements",data:Object.fromEntries(Object.entries(form).filter(([,v])=>v))}));setSent(true);}
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>АНТРОПОМЕТРИЯ</Kicker><Hero>ЗАМЕРЫ ТЕЛА</Hero><div style={{height:16}}/>
    {sent?<Card accent><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,color:C.accent}}>✓</div><div style={{fontFamily:"monospace",fontSize:13,color:C.accent,marginTop:8}}>ЗАМЕРЫ ОТПРАВЛЕНЫ</div></div></Card>:<>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {fields.map(f=><Card key={f.key}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><div><div style={{fontSize:13,color:C.muted,fontFamily:"monospace",marginBottom:6}}>{f.label.toUpperCase()}</div><input type="number" value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder="0" style={{background:"none",border:"none",color:C.accent,fontSize:22,fontFamily:"monospace",fontWeight:700,width:80,outline:"none"}}/></div><span style={{fontFamily:"monospace",fontSize:14,color:C.muted}}>см</span></div></Card>)}
      </div>
      <Btn accent full onClick={send} disabled={!Object.values(form).some(v=>v)}>СОХРАНИТЬ ЗАМЕРЫ</Btn>
    </>}
  </div>;
}

function CheckinScreen({onBack}){
  const [sent,setSent]=useState(false);const [form,setForm]=useState({weight:"",energy:3,sleep:3,stress:3,motivation:3});
  const sliders=[{key:"energy",label:"Энергия",lo:"😴",hi:"⚡"},{key:"sleep",label:"Сон",lo:"😞",hi:"😴✨"},{key:"stress",label:"Стресс",lo:"😌",hi:"😤"},{key:"motivation",label:"Мотивация",lo:"😑",hi:"🔥"}];
  function send(){tg?.sendData(JSON.stringify({action:"save_checkin",data:{...form,weight:parseFloat(form.weight)||null}}));setSent(true);}
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ЕЖЕНЕДЕЛЬНЫЙ</Kicker><Hero>ЧЕК-ИН</Hero><div style={{height:16}}/>
    {sent?<Card accent><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,color:C.accent}}>✓</div><Mono style={{marginTop:8}}>ЧЕК-ИН ОТПРАВЛЕН</Mono></div></Card>:<>
      <Card style={{marginBottom:12}}><div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:8}}>ВЕС СЕГОДНЯ (КГ)</div><input type="number" step="0.1" value={form.weight} onChange={e=>setForm(p=>({...p,weight:e.target.value}))} placeholder="0.0" style={{background:"none",border:"none",color:C.accent,fontSize:28,fontFamily:"monospace",fontWeight:700,width:"100%",outline:"none"}}/></Card>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {sliders.map(s=><Card key={s.key}><div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontSize:12,color:C.muted,fontFamily:"monospace"}}>{s.label.toUpperCase()}</span><Mono size={14}>{form[s.key]}/5</Mono></div><div style={{display:"flex",gap:6,alignItems:"center"}}><span style={{fontSize:14}}>{s.lo}</span><input type="range" min={1} max={5} value={form[s.key]} onChange={e=>setForm(p=>({...p,[s.key]:+e.target.value}))} style={{flex:1,accentColor:C.accent}}/><span style={{fontSize:14}}>{s.hi}</span></div></Card>)}
      </div>
      <Btn accent full onClick={send}>ОТПРАВИТЬ ЧЕК-ИН</Btn>
    </>}
  </div>;
}

function LanguageScreen({tgId,user,onBack,onUserUpdated}){
  const [saving,setSaving]=useState(false);
  const langs=[{code:"ru",label:"🇷🇺 Русский"},{code:"en",label:"🇬🇧 English"},{code:"uz",label:"🇺🇿 O'zbek"}];
  async function setLang(code){setSaving(code);try{await fetch(`${API}/user/${tgId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({lang:code})});onUserUpdated();setTimeout(onBack,500);}catch{}finally{setSaving(false);};}
  const cur=user?.lang||"ru";
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>НАСТРОЙКИ</Kicker><Hero>ЯЗЫК</Hero><div style={{height:16}}/>
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {langs.map(l=><Card key={l.code} onClick={()=>setLang(l.code)} accent={cur===l.code}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:16,color:C.text,fontWeight:cur===l.code?700:400}}>{l.label}</span>{cur===l.code&&<span style={{color:C.accent,fontFamily:"monospace",fontSize:12}}>✓ ТЕКУЩИЙ</span>}{saving===l.code&&<span style={{color:C.muted,fontFamily:"monospace",fontSize:11}}>...</span>}</div>
      </Card>)}
    </div>
  </div>;
}

function SupportScreen({onBack}){
  const [msg,setMsg]=useState("");const [sent,setSent]=useState(false);
  function send(){if(!msg.trim())return;tg?.sendData(JSON.stringify({action:"open_support",message:msg.trim()}));setSent(true);}
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ОБРАТНАЯ СВЯЗЬ</Kicker><Hero>ПОДДЕРЖКА</Hero><div style={{height:16}}/>
    {sent?<Card accent><div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:32,color:C.accent}}>✓</div><div style={{fontFamily:"monospace",fontSize:13,color:C.accent,marginTop:8}}>ОТПРАВЛЕНО</div></div></Card>:<>
      <Card style={{marginBottom:16}}><div style={{fontSize:12,color:C.muted,fontFamily:"monospace",marginBottom:10}}>ОПИШИ ПРОБЛЕМУ</div><textarea value={msg} onChange={e=>setMsg(e.target.value)} rows={5} style={{width:"100%",background:"none",border:"none",color:C.text,fontSize:14,lineHeight:1.6,resize:"none",outline:"none",boxSizing:"border-box"}}/></Card>
      <Btn accent full onClick={send} disabled={!msg.trim()}>ОТПРАВИТЬ</Btn>
    </>}
  </div>;
}

function GoalsScreen({tgId,onBack}){
  const [data,setData]=useState(null);const [adding,setAdding]=useState(false);const [form,setForm]=useState({description:"",target_value:"",unit:"кг",deadline:""});const [saving,setSaving]=useState(false);
  function load(){if(!tgId){setData({goals:[]});return;}fetch(`${API}/goals/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData({goals:[]}));}
  useEffect(()=>{load();},[]);
  async function add(){if(!form.description.trim())return;setSaving(true);try{const res=await fetch(`${API}/goals/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({description:form.description,target_value:parseFloat(form.target_value)||null,unit:form.unit||null,deadline:form.deadline||null,goal_type:"custom"})});if(res.ok){setAdding(false);setForm({description:"",target_value:"",unit:"кг",deadline:""});load();}}catch{}finally{setSaving(false);};}
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text="ЦЕЛИ"/></div>;
  const active=data.goals.filter(g=>!g.is_achieved);const done=data.goals.filter(g=>g.is_achieved);
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ПРОГРЕСС</Kicker><Hero>МОИ ЦЕЛИ</Hero><div style={{height:16}}/>
    {!adding?<Btn accent full onClick={()=>setAdding(true)} style={{marginBottom:16}}>+ ДОБАВИТЬ ЦЕЛЬ</Btn>:
    <Card style={{marginBottom:16}}><Kicker>НОВАЯ ЦЕЛЬ</Kicker><div style={{display:"flex",flexDirection:"column",gap:10,marginTop:8}}>
      <input value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} placeholder="Описание цели..." style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.text,fontSize:14,outline:"none"}}/>
      <div style={{display:"flex",gap:8}}>
        <input type="number" value={form.target_value} onChange={e=>setForm(p=>({...p,target_value:e.target.value}))} placeholder="Цель" style={{flex:2,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.accent,fontSize:14,fontFamily:"monospace",outline:"none"}}/>
        <input value={form.unit} onChange={e=>setForm(p=>({...p,unit:e.target.value}))} placeholder="ед." style={{flex:1,background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.muted,fontSize:14,outline:"none"}}/>
      </div>
      <input type="date" value={form.deadline} onChange={e=>setForm(p=>({...p,deadline:e.target.value}))} style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 12px",color:C.muted,fontSize:13,outline:"none"}}/>
      <div style={{display:"flex",gap:8}}><Btn full onClick={()=>setAdding(false)} style={{flex:1}}>ОТМЕНА</Btn><Btn accent full onClick={add} disabled={saving||!form.description.trim()} style={{flex:2}}>{saving?"...":"СОХРАНИТЬ"}</Btn></div>
    </div></Card>}
    {active.length===0&&!adding&&<Card style={{marginBottom:12}}><div style={{textAlign:"center",padding:"16px 0",color:C.muted}}>Активных целей нет. Поставь первую!</div></Card>}
    {active.map(g=><Card key={g.id} style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><div style={{fontWeight:600,fontSize:14,color:C.text,flex:1}}>{g.description}</div><Mono size={12}>{g.pct}%</Mono></div>
      <div style={{marginBottom:6}}><ProgressBar pct={g.pct}/></div>
      <div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:11,color:C.muted,fontFamily:"monospace"}}>{g.current_value}/{g.target_value} {g.unit}</span>{g.days_left!=null&&<span style={{fontSize:11,color:g.days_left<7?C.danger:C.muted,fontFamily:"monospace"}}>{g.days_left} дн.</span>}</div>
    </Card>)}
    {done.length>0&&<><Kicker style={{marginTop:16}}>ДОСТИГНУТО</Kicker>{done.map(g=><Card key={g.id} style={{marginBottom:8,opacity:0.6}}><div style={{display:"flex",justifyContent:"space-between"}}><span style={{fontSize:14,color:C.success}}>✓ {g.description}</span><Mono size={12} color={C.success}>100%</Mono></div></Card>)}</>}
  </div>;
}

function RemindersScreen({tgId,onBack,onNav}){
  const [data,setData]=useState(null);
  useEffect(()=>{if(!tgId){setData({reminders:[]});return;}fetch(`${API}/reminders/${tgId}`).then(r=>r.json()).then(setData).catch(()=>setData({reminders:[]}));},[]);
  const fmt=iso=>{const d=new Date(iso);return d.toLocaleString("ru",{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});};
  if(!data)return <div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader/></div>;
  return <div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>УВЕДОМЛЕНИЯ</Kicker><Hero>НАПОМИНАНИЯ</Hero><div style={{height:16}}/>
    <Card style={{marginBottom:16}}><div style={{fontSize:13,color:C.muted,lineHeight:1.6}}>🔔 Бот напоминает за <span style={{color:C.accent}}>1 час</span> до тренировки.<br/>Плато-детектор проверяет каждое воскресенье в 10:30.</div></Card>
    <Kicker>БЛИЖАЙШИЕ ТРЕНИРОВКИ</Kicker>
    {data.reminders.length===0?<Card><div style={{textAlign:"center",padding:"16px 0"}}><div style={{color:C.muted,fontSize:14}}>Нет предстоящих тренировок</div><button onClick={()=>onNav("plan_workout")} style={{marginTop:10,background:"none",border:`0.5px solid ${C.accent}`,borderRadius:8,padding:"8px 16px",color:C.accent,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>+ ЗАПЛАНИРОВАТЬ</button></div></Card>:
    <div style={{display:"flex",flexDirection:"column",gap:8}}>{data.reminders.map((r,i)=><Card key={i}><div style={{fontWeight:600,fontSize:14,color:C.text,marginBottom:4}}>{r.title}</div><div style={{fontSize:12,color:C.accent,fontFamily:"monospace"}}>🔔 {fmt(r.dt)}</div></Card>)}</div>}
  </div>;
}

// ─── ROOT ──────────────────────────────────────────────────────────────────────
export default function App(){
  function getNav(){const s=window.history.state;return s&&s._g?s:{_g:true,tab:"menu",screen:null,params:{}};}
  const [nav,setNav]=useState(getNav);
  const {tab,screen,params={}}=nav;

  const [user,setUser]=useState(null);
  const [workouts,setWorkouts]=useState(null);
  const [stats,setStats]=useState(null);
  const [exercises,setExercises]=useState(null);
  const [muscleGroups,setMuscleGroups]=useState(null);
  const tgId=tg?.initDataUnsafe?.user?.id;

  function push(tab,screen,params={}){const s={_g:true,tab,screen,params};window.history.pushState(s,"");setNav(s);}
  function replace(tab,screen,params={}){const s={_g:true,tab,screen,params};window.history.replaceState(s,"");setNav(s);}
  function loadUser(){
    if(tgId)fetch(`${API}/user/${tgId}`).then(r=>r.json()).then(setUser).catch(()=>setUser({first_name:tg?.initDataUnsafe?.user?.first_name||"Атлет",ai_requests_today:0}));
    else setUser({first_name:"Атлет",ai_requests_today:0});
  }

  useEffect(()=>{
    tg?.ready();tg?.expand();
    loadUser();
    fetch(`${API}/exercises`).then(r=>r.json()).then(d=>{setExercises(d.exercises||[]);setMuscleGroups(d.muscle_groups||[]);}).catch(()=>{setExercises([]);setMuscleGroups([]);});
    if(!window.history.state?._g)window.history.replaceState({_g:true,tab:"menu",screen:null,params:{}},"");
    function onPop(e){const s=e.state;if(s&&s._g)setNav(s);else{const h={_g:true,tab:"menu",screen:null,params:{}};window.history.replaceState(h,"");setNav(h);}}
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);

  useEffect(()=>{
    if(tab==="workout"&&!workouts&&tgId)fetch(`${API}/workouts/${tgId}`).then(r=>r.json()).then(d=>setWorkouts(d.workouts||[])).catch(()=>setWorkouts([]));
    if(tab==="progress"&&!stats&&tgId)fetch(`${API}/stats/${tgId}`).then(r=>r.json()).then(setStats).catch(()=>setStats({}));
  },[tab]);

  function handleTabChange(t){push(t,null,{});}
  function handleNav(s,p={}){
    if(s==="my_workouts"){push("workout",null,{});return;}
    push(tab,s,p);
  }
  const goBack=()=>window.history.back();

  function render(){
    const p=params||{};
    if(screen==="profile")return <ProfileScreen user={user} tgId={tgId} onBack={goBack} onUserUpdated={loadUser}/>;
    if(screen==="active_workout")return <ActiveWorkoutScreen tgId={tgId} exercises={exercises} muscleGroups={muscleGroups} onBack={goBack}/>;
    if(screen==="workout_detail")return <WorkoutDetailScreen workoutId={p.workoutId} tgId={tgId} onBack={goBack}/>;
    if(screen==="my_workouts_detail")return <MyWorkoutsDetailScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="planned_detail")return <PlannedDetailScreen pwId={p.pwId} tgId={tgId} onBack={goBack} exercises={exercises}/>;
    if(screen==="plan_workout")return <PlanWorkoutScreen tgId={tgId} exercises={exercises} muscleGroups={muscleGroups} onBack={goBack}/>;
    if(screen==="goals")return <GoalsScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="reminders")return <RemindersScreen tgId={tgId} onBack={goBack} onNav={handleNav}/>;
    if(screen==="nutrition")return <NutritionScreen tgId={tgId} onBack={goBack}/>;
    if(screen==="food_guide")return <FoodGuideScreen onBack={goBack}/>;
    if(screen==="measurements")return <MeasurementsScreen onBack={goBack}/>;
    if(screen==="checkin")return <CheckinScreen onBack={goBack}/>;
    if(screen==="supplements")return <SupplementsScreen onBack={goBack}/>;
    if(screen==="language")return <LanguageScreen tgId={tgId} user={user} onBack={goBack} onUserUpdated={loadUser}/>;
    if(screen==="support")return <SupportScreen onBack={goBack}/>;
    if(tab==="menu")return <MenuScreen user={user} onNav={handleNav}/>;
    if(tab==="workout")return <WorkoutHistoryScreen workouts={workouts} onNav={handleNav}/>;
    if(tab==="progress")return <ProgressScreen stats={stats}/>;
    if(tab==="catalog")return <CatalogScreen exercises={exercises} muscleGroups={muscleGroups}/>;
    if(tab==="ai")return <AIScreen user={user}/>;
  }

  return <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"}}>
    {render()}
    <NavBar active={tab} onChange={handleTabChange}/>
  </div>;
}
