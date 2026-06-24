import { useState, useEffect, useRef, Fragment } from "react";
import { API, C, Hero, Kicker, Mono, Card, Loader, BackBtn, Btn, ProgressBar } from "./ui";

// ── Компоненты (передаются из App как пропсы) ────────────────────────────────
// C, Btn, Card, Kicker, Hero, Mono, BackBtn, Loader, ProgressBar — из App.jsx

function FoodVisionScreen({tgId,onBack,mealType}){
  const [photo,setPhoto]=useState(null);
  const [preview,setPreview]=useState(null);
  const [result,setResult]=useState(null);
  const [loading,setLoading]=useState(false);
  const [saved,setSaved]=useState(false);
  const [error,setError]=useState(null);
  const inputRef=useRef(null);

  function handleFile(file){
    if(!file)return;
    setPreview(URL.createObjectURL(file));
    setResult(null);setSaved(false);setError(null);
    const reader=new FileReader();
    reader.onload=e=>setPhoto(e.target.result.split(",")[1]);
    reader.readAsDataURL(file);
  }

  async function analyze(){
    if(!photo)return;
    setLoading(true);setError(null);
    try{
      const res=await fetch(`${API}/food/analyze`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({image_base64:photo,tg_id:tgId,save:false})});
      if(!res.ok)throw new Error(res.status);
      setResult(await res.json());
    }catch{setError("Не удалось распознать. Попробуй другое фото.");}
    finally{setLoading(false);}
  }

  async function saveToLog(){
    if(!photo||!result)return;
    setLoading(true);
    try{
      await fetch(`${API}/food/analyze`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({image_base64:photo,tg_id:tgId,save:true,meal_type:mealType||null})});
      setSaved(true);
    }catch{}finally{setLoading(false);}
  }

  const confColor={"high":C.success,"medium":C.warn,"low":C.danger};
  const confLabel={"high":"✅ Высокая","medium":"⚠️ Средняя","low":"❓ Низкая"};

  return(
    <div style={{padding:"16px 16px 100px"}}>
      <BackBtn onBack={onBack}/>
      <Kicker>AI ПИТАНИЕ</Kicker>
      <Hero>ФОТО → КБЖУ</Hero>
      <div style={{color:C.muted,fontSize:13,marginTop:4,marginBottom:20}}>Сфотографируй еду — AI определит калории и БЖУ</div>
      <input ref={inputRef} type="file" accept="image/*"
        onChange={e=>handleFile(e.target.files[0])} style={{display:"none"}}/>
      {!preview?(
        <div onClick={()=>inputRef.current?.click()}
          style={{border:`2px dashed ${C.border}`,borderRadius:16,padding:"48px 20px",
            textAlign:"center",cursor:"pointer",marginBottom:16}}>
          <div style={{fontSize:52,marginBottom:10}}>📷</div>
          <Btn accent full style={{pointerEvents:"none",fontSize:15}}>ДОБАВИТЬ ФОТО</Btn>
        </div>
      ):(
        <div style={{marginBottom:16}}>
          <img src={preview} alt="food" style={{width:"100%",borderRadius:12,maxHeight:240,objectFit:"cover",marginBottom:10}}/>
          <div style={{display:"flex",gap:8}}>
            <Btn full onClick={()=>inputRef.current?.click()} style={{flex:1}}>📷 Другое</Btn>
            {!result&&!loading&&<Btn accent full onClick={analyze} style={{flex:2}}>🔍 АНАЛИЗИРОВАТЬ</Btn>}
          </div>
        </div>
      )}
      {loading&&<Card><div style={{textAlign:"center",padding:"16px 0",color:C.accent,fontFamily:"monospace",fontSize:12,letterSpacing:2}}>AI АНАЛИЗИРУЕТ ФОТО...</div></Card>}
      {error&&<Card><div style={{color:C.danger,fontSize:13,textAlign:"center",padding:"8px 0"}}>{error}</div></Card>}
      {result&&!loading&&(
        <Fragment>
          <Card accent style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div>
                <div style={{fontSize:16,fontWeight:700,color:C.text}}>{result.dish_name}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:2}}>~{result.weight_g} г</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:24,fontWeight:700,color:C.accent}}>{result.calories}</div>
                <div style={{fontSize:11,color:C.muted}}>ккал</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:10}}>
              {[{l:"БЕЛКИ",v:result.protein_g},{l:"ЖИРЫ",v:result.fat_g},{l:"УГЛЕВОДЫ",v:result.carbs_g}].map((m,i)=>(
                <div key={i} style={{textAlign:"center",background:C.bg,borderRadius:8,padding:"8px 4px"}}>
                  <div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{m.l}</div>
                  <Mono size={15}>{m.v} г</Mono>
                </div>
              ))}
            </div>
            <div style={{fontSize:11,color:confColor[result.confidence]||C.muted,fontFamily:"monospace"}}>
              ТОЧНОСТЬ: {confLabel[result.confidence]||result.confidence}
            </div>
            {result.note&&<div style={{fontSize:12,color:C.muted,marginTop:6}}>{result.note}</div>}
          </Card>
          {saved?(
            <div style={{background:"#00CC6622",border:`0.5px solid ${C.success}`,borderRadius:10,
              padding:"12px",fontSize:13,color:C.success,fontFamily:"monospace",textAlign:"center"}}>
              ✓ СОХРАНЕНО В ДНЕВНИК ПИТАНИЯ
            </div>
          ):(
            <div style={{display:"flex",gap:8}}>
              <Btn full onClick={()=>{setResult(null);setPreview(null);setPhoto(null);}} style={{flex:1}}>НОВОЕ ФОТО</Btn>
              <Btn accent full onClick={saveToLog} disabled={loading} style={{flex:2}}>
                {loading?"СОХРАНЯЕМ...":"💾 В ДНЕВНИК"}
              </Btn>
            </div>
          )}
        </Fragment>
      )}
    </div>
  );
}

// ─── NUTRITION ────────────────────────────────────────────────────────────────

function NutritionScreen({tgId,onBack,onNav}){
  const MEALS=[{type:"breakfast",label:"Завтрак",icon:"🌅"},{type:"lunch",label:"Обед",icon:"☀️"},{type:"dinner",label:"Ужин",icon:"🌙"},{type:"snack",label:"Перекус",icon:"🍎"}];
  const WATER_GOAL=8;
  const [data,setData]=useState(null);
  const [error,setError]=useState(null);
  const [viewDate,setViewDate]=useState(()=>new Date().toISOString().split("T")[0]);
  const [adding,setAdding]=useState(null);
  const [saving,setSaving]=useState(false);
  const [form,setForm]=useState({meal_name:"",kcal:"",protein:"",fat:"",carb:""});
  const [glasses,setGlasses]=useState(0);
  const isToday=viewDate===new Date().toISOString().split("T")[0];

  function load(){
    if(!tgId)return;
    const url=isToday?`${API}/nutrition/${tgId}`:`${API}/nutrition/${tgId}/history?date=${viewDate}`;
    fetch(url).then(r=>r.json()).then(d=>{setData(d);const w=(d.today_logs||d.logs||[]).find(l=>l.meal_type==="water");setGlasses(w?.kcal||0);}).catch(()=>setError("Ошибка загрузки"));
  }
  useEffect(()=>{setData(null);load();},[viewDate]);

  const logs=data?.today_logs||data?.logs||[];
  const t=data?.today_totals||data?.totals||{};
  function logsFor(type){return logs.filter(l=>l.meal_type===type);}
  function totalFor(type){const ls=logsFor(type);return{kcal:ls.reduce((s,l)=>s+(l.kcal||0),0),protein:ls.reduce((s,l)=>s+(l.protein||0),0),fat:ls.reduce((s,l)=>s+(l.fat||0),0),carb:ls.reduce((s,l)=>s+(l.carb||0),0)};}

  async function addMeal(){
    if(!form.meal_name.trim()||!form.kcal||!adding)return;
    setSaving(true);
    try{const res=await fetch(`${API}/nutrition/${tgId}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({meal_name:form.meal_name,kcal:parseFloat(form.kcal)||0,protein:parseFloat(form.protein)||0,fat:parseFloat(form.fat)||0,carb:parseFloat(form.carb)||0,meal_type:adding})});if(res.ok){setAdding(null);setForm({meal_name:"",kcal:"",protein:"",fat:"",carb:""});setData(null);load();}}catch{}finally{setSaving(false);}
  }

  async function deleteLog(logId){if(!tgId||!logId)return;try{await fetch(`${API}/nutrition/${tgId}/${logId}`,{method:"DELETE"});setData(null);load();}catch{}}

  async function setWater(g){setGlasses(g);try{await fetch(`${API}/nutrition/${tgId}/water`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({glasses:g})});}catch{}}

  if(error)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Card><div style={{color:C.danger,fontSize:13}}>{error}</div></Card></div>;
  if(!data)return<div style={{padding:"16px 16px 100px"}}><BackBtn onBack={onBack}/><Loader text="ПИТАНИЕ"/></div>;

  const pct=Math.min(100,Math.round(((t.kcal||0)/Math.max(data.target_kcal||2000,1))*100));

  return<div style={{padding:"16px 16px 100px"}}>
    <BackBtn onBack={onBack}/><Kicker>ПИТАНИЕ</Kicker><Hero>ДНЕВНИК</Hero>

    <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,marginBottom:16}}>
      <button onClick={()=>{const d=new Date(viewDate);d.setDate(d.getDate()-1);setViewDate(d.toISOString().split("T")[0]);}} style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"6px 14px",color:C.text,cursor:"pointer",fontSize:16}}>‹</button>
      <div style={{flex:1,textAlign:"center",fontFamily:"monospace",fontSize:12,color:isToday?C.accent:C.muted}}>{isToday?"СЕГОДНЯ":new Date(viewDate+"T12:00:00").toLocaleDateString("ru",{day:"numeric",month:"short"})}</div>
      {!isToday&&<button onClick={()=>setViewDate(new Date().toISOString().split("T")[0])} style={{background:C.card,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"6px 14px",color:C.text,cursor:"pointer",fontSize:16}}>›</button>}
    </div>

    <Card accent style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:8}}>
        <Mono>{t.kcal||0} <span style={{fontSize:13,color:C.muted,fontWeight:400}}>ккал</span></Mono>
        <span style={{fontFamily:"monospace",fontSize:11,color:C.muted}}>цель {data.target_kcal||2000}</span>
      </div>
      <ProgressBar pct={pct}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:10}}>
        {[{l:"Б",v:t.protein||0},{l:"Ж",v:t.fat||0},{l:"У",v:t.carb||0}].map((m,i)=><div key={i} style={{textAlign:"center"}}><div style={{fontSize:9,color:C.muted,fontFamily:"monospace"}}>{m.l} (г)</div><Mono size={13}>{Math.round(m.v)}</Mono></div>)}
      </div>
    </Card>

    <Card style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <Kicker>💧 ВОДА</Kicker>
        <span style={{fontFamily:"monospace",fontSize:11,color:C.muted}}>{glasses}/{WATER_GOAL} стаканов</span>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {Array.from({length:WATER_GOAL},(_,i)=>(
          <button key={i} onClick={()=>isToday&&setWater(i<glasses?i:i+1)} style={{width:36,height:36,borderRadius:8,border:`0.5px solid ${C.border}`,background:i<glasses?"rgba(0,180,255,0.2)":C.card,fontSize:18,cursor:isToday?"pointer":"default"}}>{i<glasses?"💧":"○"}</button>
        ))}
      </div>
    </Card>

    {MEALS.map(meal=>{
      const ml=logsFor(meal.type);const mt=totalFor(meal.type);
      return<Card key={meal.type} style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:ml.length>0?10:0}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:20}}>{meal.icon}</span>
            <div>
              <div style={{fontWeight:600,fontSize:14,color:C.text}}>{meal.label}</div>
              {ml.length>0&&<div style={{fontSize:10,color:C.muted,fontFamily:"monospace"}}>{mt.kcal} ккал · Б{Math.round(mt.protein)} Ж{Math.round(mt.fat)} У{Math.round(mt.carb)}</div>}
            </div>
          </div>
          {isToday&&<div style={{display:"flex",gap:6}}>
            <button onClick={()=>onNav&&onNav("food_vision",{meal_type:meal.type})} style={{background:"none",border:`0.5px solid ${C.border}`,borderRadius:8,padding:"5px 8px",color:C.muted,fontSize:13,cursor:"pointer"}}>📷</button>
            <button onClick={()=>{setAdding(adding===meal.type?null:meal.type);setForm({meal_name:"",kcal:"",protein:"",fat:"",carb:""}); }} style={{background:adding===meal.type?"rgba(200,255,0,0.1)":"none",border:`0.5px solid ${adding===meal.type?C.accent:C.border}`,borderRadius:8,padding:"5px 10px",color:adding===meal.type?C.accent:C.muted,fontSize:12,cursor:"pointer"}}>{adding===meal.type?"✕":"+ добавить"}</button>
          </div>}
        </div>
        {ml.map(l=>(
          <div key={l.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderTop:`0.5px solid ${C.border}`}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13,color:C.text}}>{l.meal_name}</div>
              <div style={{fontSize:10,color:C.muted,fontFamily:"monospace",marginTop:2}}>Б{l.protein}г · Ж{l.fat}г · У{l.carb}г</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <Mono size={13}>{l.kcal} <span style={{fontSize:10,color:C.muted,fontWeight:400}}>ккал</span></Mono>
              {l.id&&isToday&&<button onClick={()=>deleteLog(l.id)} style={{background:"none",border:`0.5px solid ${C.danger}`,borderRadius:6,padding:"2px 7px",color:C.danger,fontSize:11,cursor:"pointer"}}>✕</button>}
            </div>
          </div>
        ))}
        {adding===meal.type&&isToday&&<div style={{marginTop:12,paddingTop:12,borderTop:`0.5px solid ${C.border}`}}>
          <input value={form.meal_name} onChange={e=>setForm(p=>({...p,meal_name:e.target.value}))} placeholder="Название блюда" style={{width:"100%",background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 12px",color:C.text,fontSize:13,outline:"none",marginBottom:8}}/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:10}}>
            {[{k:"kcal",p:"Ккал"},{k:"protein",p:"Белки"},{k:"fat",p:"Жиры"},{k:"carb",p:"Углев"}].map(f=>(
              <input key={f.k} type="number" value={form[f.k]} onChange={e=>setForm(p=>({...p,[f.k]:e.target.value}))} placeholder={f.p} style={{background:C.bg,border:`0.5px solid ${C.border}`,borderRadius:8,padding:"8px 6px",color:C.text,fontSize:12,outline:"none",textAlign:"center"}}/>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn full onClick={()=>setAdding(null)} style={{flex:1}}>ОТМЕНА</Btn>
            <Btn accent full onClick={addMeal} disabled={saving||!form.meal_name.trim()||!form.kcal} style={{flex:2}}>{saving?"СОХРАНЯЕМ...":"ДОБАВИТЬ"}</Btn>
          </div>
        </div>}
      </Card>;
    })}
  </div>;
}



// ── Экспорт ──────────────────────────────────────────────────────────────────
export { FoodVisionScreen, NutritionScreen };
