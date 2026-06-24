// ui.jsx — общие UI компоненты GymBot Mini App
// Импортируется в App.jsx и модулях (NutritionModule, etc.)
import { useState, useRef, Fragment } from "react";

export const API = "https://web-production-4fe0b.up.railway.app/api";



export const C = {
  bg:"#0F0F0F", surface:"#1A1A1A", card:"#222222",
  accent:"#C8FF00", text:"#FFFFFF", muted:"#888888",
  border:"#2A2A2A", danger:"#FF4444", success:"#00CC66", warn:"#FFB800",
};

// ─── ATOMS ───────────────────────────────────────────────────────────────────
export const Hero = ({children,style={}}) => <div style={{fontWeight:700,fontSize:26,letterSpacing:-0.5,lineHeight:1.15,color:C.text,textTransform:"uppercase",...style}}>{children}</div>;
export const Kicker = ({children}) => <div style={{fontFamily:"monospace",fontSize:11,color:C.muted,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>{children}</div>;
export const Mono = ({children,color=C.accent,size=18}) => <span style={{fontFamily:"monospace",fontWeight:700,fontSize:size,color}}>{children}</span>;

export function Card({children,accent,danger,onClick,style={},pad="14px 16px"}){
  const border = accent?C.accent:danger?C.danger:C.border;
  return <div onClick={onClick} style={{background:C.card,border:`0.5px solid ${border}`,borderRadius:12,padding:pad,cursor:onClick?"pointer":"default",...style}}>{children}</div>;
}
export function Loader({text="ЗАГРУЗКА"}){
  return <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"60vh"}}><div style={{textAlign:"center"}}><div style={{fontFamily:"monospace",fontSize:12,color:C.accent,letterSpacing:3}}>{text}</div><div style={{color:C.muted,fontSize:24,marginTop:8}}>◌</div></div></div>;
}
export function BackBtn({onBack}){
  return <button onClick={onBack} style={{background:"none",border:"none",color:C.muted,fontFamily:"monospace",fontSize:12,letterSpacing:1,cursor:"pointer",padding:"0 0 16px 0",display:"block"}}>← НАЗАД</button>;
}
export function Btn({children,onClick,accent,danger,disabled,full,style={}}){
  const bg=accent?C.accent:danger?"#FF444422":C.card;
  const bc=accent?C.accent:danger?C.danger:C.border;
  const col=accent?C.bg:danger?C.danger:C.text;
  return <button onClick={onClick} disabled={disabled} style={{width:full?"100%":"auto",background:bg,border:`0.5px solid ${bc}`,borderRadius:10,padding:"13px 20px",color:col,fontWeight:700,fontSize:14,letterSpacing:0.5,textTransform:"uppercase",cursor:disabled?"not-allowed":"pointer",opacity:disabled?0.5:1,...style}}>{children}</button>;
}
function Sel({value,onChange,options}){
  return <select value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"10px 14px",color:C.text,fontSize:13,fontFamily:"monospace",outline:"none",boxSizing:"border-box"}}>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
export function Tag({children,color=C.muted,bg}){
  return <span style={{background:bg||`${color}22`,border:`0.5px solid ${color}`,borderRadius:16,padding:"4px 10px",fontSize:12,color,display:"inline-block"}}>{children}</span>;
}
export function ProgressBar({pct,color=C.accent}){
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
export function CheckboxGroup({options,selected,onChange}){
  const toggle=key=>onChange(selected.includes(key)?selected.filter(k=>k!==key):[...selected,key]);
  return <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
    {options.map(o=>{const a=selected.includes(o.key);return(
      <button key={o.key} onClick={()=>toggle(o.key)} style={{padding:"7px 12px",borderRadius:20,fontSize:12,cursor:"pointer",background:a?C.accent:C.bg,border:`0.5px solid ${a?C.accent:C.border}`,color:a?C.bg:C.muted,fontWeight:a?700:400}}>{o.label}</button>
    );})}
  </div>;
}


// ─── REST TIMER (T-01) ────────────────────────────────────────────────────────
function RestTimer({onClose}){
  const PRESETS=[60,90,120,180];
  const [total,setTotal]=useState(90);
  const [left,setLeft]=useState(null); // null = не запущен
  const [running,setRunning]=useState(false);
  const intervalRef=useRef(null);

  function start(sec){
    setTotal(sec);setLeft(sec);setRunning(true);
  }
  function pause(){setRunning(false);}
  function resume(){setRunning(true);}
  function reset(){setRunning(false);setLeft(null);}
  function addTime(sec){setLeft(p=>p!=null?Math.max(0,p+sec):sec);}

  useEffect(()=>{
    if(!running)return;
    intervalRef.current=setInterval(()=>{
      setLeft(p=>{
        if(p<=1){
          setRunning(false);
          if(navigator.vibrate)navigator.vibrate([200,100,200,100,400]);
          // Звуковой сигнал через Web Audio API (работает на iOS и Android)
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
        return p-1;
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
            {done?"✓ ОТДЫХ ЗАВЕРШЁН":left!=null?"ОТДЫХ":"ВЫБЕРИ ВРЕМЯ"}
          </div>
          <div style={{fontSize:36,fontFamily:"monospace",fontWeight:700,color:done?C.success:C.accent,lineHeight:1}}>
            {fmt(left)}
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {left!=null&&!done&&(
            <button onClick={running?pause:resume}
              style={{background:C.accent,border:"none",borderRadius:10,padding:"8px 16px",color:C.bg,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"monospace"}}>
              {running?"⏸ ПАУЗА":"▶ СТАРТ"}
            </button>
          )}
          <button onClick={()=>{reset();onClose();}}
            style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:10,padding:"8px 12px",color:C.muted,fontSize:13,cursor:"pointer"}}>
            ✕
          </button>
        </div>
      </div>

      {left!=null&&!done?(
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>addTime(30)} style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px",color:C.text,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>+30 сек</button>
          <button onClick={()=>addTime(-15)} style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px",color:C.muted,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>−15 сек</button>
          <button onClick={reset} style={{flex:1,background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px",color:C.danger,fontSize:12,fontFamily:"monospace",cursor:"pointer"}}>СБРОС</button>
        </div>
      ):(
        <div style={{display:"flex",gap:6}}>
          {PRESETS.map(s=>(
            <button key={s} onClick={()=>start(s)}
              style={{flex:1,background:done&&total===s?C.success:C.card,border:`0.5px solid ${done&&total===s?C.success:C.border}`,borderRadius:8,padding:"8px 4px",color:done&&total===s?"#fff":C.muted,fontSize:12,fontFamily:"monospace",cursor:"pointer",fontWeight:done&&total===s?700:400}}>
              {s}с
            </button>
          ))}
        </div>
      )}
    </div>
    </Fragment>
  );
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
export function ExCard({ex,onClick,badge,action}){
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
