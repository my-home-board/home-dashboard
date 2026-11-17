const params=new URLSearchParams(location.search);
const requestedMode=params.get("mode");
const forcedTime=params.get("time");
const isLocalPreview=location.protocol==="file:";
const forcedMode=requestedMode || (isLocalPreview ? "morning" : null);

const TZ="Asia/Tokyo";
const TOKYO_STATION={lat:35.6812,lon:139.7671};

const DEFAULT_CALENDAR_ENDPOINT=
  "https://home-dashboard-calendar.s6kyll15g.workers.dev/calendar";

let calendarCache={today:[],tomorrow:[]};

const updateTimes={
  calendar:null,
  weather:null,
  bus:null,
  commute:null,
  health:null
};

function hhmmNow(){
  return new Date().toLocaleTimeString("ja-JP",{
    hour:"2-digit",
    minute:"2-digit",
    hour12:false
  });
}

function markUpdated(key){
  const value=hhmmNow();
  updateTimes[key]=value;

  const ids={
    calendar:"updateCalendar",
    weather:"updateWeather",
    bus:"updateBusTime",
    commute:"updateCommute",
    health:null
  };

  const target=ids[key] ? document.getElementById(ids[key]) : null;
  if(target) target.textContent=value;

  const all=document.getElementById("updateAll");
  if(all) all.textContent=value;
}

/* =========================
   カレンダー
   ========================= */
function normalizeEventArray(value){
  if(Array.isArray(value)) return value;
  if(typeof value!=="string") return [];

  try{
    const parsed=JSON.parse(value);
    if(Array.isArray(parsed)) return parsed;
    if(parsed && typeof parsed==="object") return [parsed];
  }catch(_){}

  return [];
}

function getCookie(name){
  const prefix=name+"=";
  const part=document.cookie.split("; ").find(v=>v.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : "";
}

function setPersistentValue(key,value){
  if(!value) return;

  try{
    localStorage.setItem(key,value);
  }catch(_){}

  document.cookie=
    `${key}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax; Secure`;
}

function calendarConfig(){
  let endpoint="";
  let token="";

  try{
    endpoint=localStorage.getItem("calendarEndpoint") || "";
    token=localStorage.getItem("calendarToken") || "";
  }catch(_){}

  endpoint=endpoint || getCookie("calendarEndpoint") || DEFAULT_CALENDAR_ENDPOINT;
  token=token || getCookie("calendarToken") || "";

  if(endpoint) setPersistentValue("calendarEndpoint",endpoint);
  if(token) setPersistentValue("calendarToken",token);

  return {endpoint,token};
}

function renderCalendar(){
  const key=getMode()==="night" ? nightCalendarKey() : "today";
  const events=normalizeEventArray(calendarCache[key]);
  const box=document.getElementById("events");

  if(!events.length){
    box.innerHTML=
      '<div class="event"><span class="event-time">—</span><span>予定なし</span></div>';
    return;
  }

  const html=events.map(ev=>{
    const time=String(ev?.time ?? "").replace(/[<>]/g,"");
    const rawTitle=String(ev?.title ?? "");
    const title=rawTitle.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const compactClass=rawTitle.length>6 && rawTitle.length<=9 ? " event-compact" : "";
    return `<div class="event"><span class="event-time">${time || "—"}</span><span class="event-title${compactClass}">${title || "予定"}</span></div>`;
  }).join("");
  box.innerHTML=html;
  const nightBox=document.getElementById("nightEvents");
  if(nightBox){
    const tomorrowEvents=normalizeEventArray(calendarCache.tomorrow);
    nightBox.innerHTML=tomorrowEvents.length ? tomorrowEvents.map(ev=>{
      const time=String(ev?.time ?? "").replace(/[<>]/g,"");
      const rawTitle=String(ev?.title ?? "");
      const title=rawTitle.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
      const compactClass=rawTitle.length>6 && rawTitle.length<=9 ? " event-compact" : "";
      return `<div class="event"><span class="event-time">${time || "—"}</span><span class="event-title${compactClass}">${title || "予定"}</span></div>`;
    }).join("") : '<div class="event"><span class="event-time">—</span><span>予定なし</span></div>';
  }
}

async function loadCalendar(){
  const cfg=calendarConfig();

  if(!cfg.token){
    document.getElementById("events").innerHTML=
      '<div class="event"><span class="event-time">—</span><span>カレンダー未設定</span></div>';
    return;
  }

  try{
    const res=await fetch(cfg.endpoint,{
      headers:{Authorization:`Bearer ${cfg.token}`},
      cache:"no-store"
    });

    if(!res.ok) throw new Error(String(res.status));

    calendarCache=await res.json();
    renderCalendar();
    markUpdated("calendar");

  }catch(e){
    document.getElementById("events").innerHTML=
      '<div class="event"><span class="event-time">—</span><span>カレンダー取得エラー</span></div>';
  }
}

if(params.get("setup")==="1"){
  const current=calendarConfig();

  const endpoint=
    prompt("Cloudflare Worker URL",current.endpoint) || current.endpoint;

  const token=
    prompt("CALENDAR_TOKEN を入力",current.token);

  if(endpoint) setPersistentValue("calendarEndpoint",endpoint.trim());
  if(token) setPersistentValue("calendarToken",token.trim());

  const clean=new URL(location.href);
  clean.searchParams.delete("setup");

  history.replaceState(
    null,
    "",
    clean.pathname+
    (clean.searchParams.toString() ? "?"+clean.searchParams.toString() : "")
  );
}


function jpParts(date=new Date()){
  const parts=new Intl.DateTimeFormat("ja-JP",{
    timeZone:TZ,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    weekday:"short",
    hour:"2-digit",
    minute:"2-digit",
    second:"2-digit",
    hour12:false
  }).formatToParts(date);

  return Object.fromEntries(parts.map(p=>[p.type,p.value]));
}

function ymd(date=new Date()){
  const p=jpParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/* =========================
   在宅判定
   ========================= */
let presenceHome=null;

const PRESENCE_CACHE_KEY="dashboardPresenceCache";
const PRESENCE_STALE_MS=10*60*1000;

function presenceEndpoint(){
  const cfg=calendarConfig();
  const base=cfg.endpoint || DEFAULT_CALENDAR_ENDPOINT;

  if(!base) return "";

  if(base.endsWith("/calendar")){
    return base.replace(/\/calendar$/,"/presence");
  }

  return base.replace(/\/$/,"")+"/presence";
}

function savePresenceCache(home){
  try{
    localStorage.setItem(
      PRESENCE_CACHE_KEY,
      JSON.stringify({
        home:home===true,
        checkedAt:Date.now()
      })
    );
  }catch(e){}
}

function restorePresenceCache(){
  try{
    const raw=localStorage.getItem(PRESENCE_CACHE_KEY);
    if(!raw) return false;

    const cached=JSON.parse(raw);

    if(typeof cached.home!=="boolean") return false;
    if(typeof cached.checkedAt!=="number") return false;

    const age=Date.now()-cached.checkedAt;

    if(age<=PRESENCE_STALE_MS){
      presenceHome=cached.home;
      return true;
    }
  }catch(e){}

  return false;
}

async function loadPresence(){
  const cfg=calendarConfig();

  if(!cfg.token){
    presenceHome=false;
    return;
  }

  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),8000);

    const res=await fetch(presenceEndpoint(),{
      method:"GET",
      cache:"no-store",
      headers:{
        Authorization:`Bearer ${cfg.token}`
      },
      signal:controller.signal
    });

    clearTimeout(timeout);

    if(!res.ok) throw new Error(`presence ${res.status}`);

    const data=await res.json();

    presenceHome=data?.home===true;
    savePresenceCache(presenceHome);

  }catch(e){
    if(!restorePresenceCache()){
      presenceHome=false;
    }
  }
}

function getMode(){
  if(forcedMode==="morning" || forcedMode==="night"){
    return forcedMode;
  }

  if(forcedMode==="always"){
    return "morning";
  }

  if(presenceHome!==true){
    return "off";
  }

  const h=+jpParts().hour;

  if(h>=6 && h<9) return "morning";

  /* 0時以降は消灯 */
  if(h>=21 && h<24) return "night";

  return "off";
}

function nightTargetOffset(){
  const h=+jpParts().hour;
  return h>=21 ? 1 : 0;
}

function nightCalendarKey(){
  return nightTargetOffset()===1 ? "tomorrow" : "today";
}

function localDate(offsetDays=0){
  const base=new Date(Date.now()+offsetDays*86400000);
  const p=jpParts(base);

  return new Date(+p.year,+p.month-1,+p.day);
}

function isHoliday(date){
  const p={
    y:date.getFullYear(),
    m:String(date.getMonth()+1).padStart(2,"0"),
    d:String(date.getDate()).padStart(2,"0")
  };

  return HOLIDAYS.has(`${p.y}-${p.m}-${p.d}`);
}

function busType(date){
  const d=date.getDay();

  if(d===0 || isHoliday(date)) return "holiday";
  if(d===6) return "saturday";

  return "weekday";
}

function effectiveMinutes(){
  if(
    forcedTime &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(forcedTime)
  ){
    const [h,m]=forcedTime.split(":").map(Number);
    return h*60+m;
  }

  if(forcedMode==="morning" || forcedMode==="always"){
    return 8*60;
  }

  const p=jpParts();
  return +p.hour*60 + +p.minute;
}

function destinationLabel(dest){
  if(dest==="hospital") return "🏥";
  return "🗼";
}

function updateBus(){
  const now=effectiveMinutes();
  const date=localDate(0);

  const list=BUS[busType(date)]
    .map(([t,dest])=>{
      const [h,m]=t.split(":").map(Number);

      return {
        t,
        dest,
        min:h*60+m
      };
    })
    .filter(x=>x.min>=now);

  const first=list[0];
  const second=list[1];

  if(!first){
    document.getElementById("busTime").textContent="終了";
    document.getElementById("busCount").textContent="";
    document.getElementById("busDestination").textContent="";
    document.getElementById("busNext").textContent="";
    markUpdated("bus");
    return;
  }

  const d1=first.min-now;

  document.getElementById("busTime").textContent=first.t;
  document.getElementById("busDestination").textContent=
    destinationLabel(first.dest);

  const busCount=document.getElementById("busCount");

  busCount.innerHTML=
    d1===0
      ? `<span class="bus-count-value bus-soon">まもなく</span>`
      : `<span class="bus-prefix">あと</span><span class="bus-count-value">${d1}分</span>`;

  if(second){
    const d2=second.min-now;

    document.getElementById("busNext").textContent=
      `次　${second.t}　${destinationLabel(second.dest)}　あと${d2}分`;

  }else{
    document.getElementById("busNext").textContent=
      "この時間帯の次便なし";
  }

  markUpdated("bus");
}


function updateGarbage(offset){
  document.getElementById("garbage").textContent=
    garbageFor(localDate(offset));
}

/* =========================
   ヘルスケア（夜モード）
   ========================= */
let healthCache=null;
function healthEndpoint(){const cfg=calendarConfig();const base=cfg.endpoint||DEFAULT_CALENDAR_ENDPOINT;if(!base)return "";if(base.endsWith("/calendar"))return base.replace(/\/calendar$/,"/health");return base.replace(/\/$/,"")+"/health";}
function renderHealth(){const s=document.getElementById("healthSteps"),d=document.getElementById("healthDistance"),k=document.getElementById("healthKcal"),u=document.getElementById("healthUpdated");if(!s||!d||!k||!u)return;const data=healthCache?.data;if(!data){s.textContent="--";d.textContent="-- km";k.textContent="-- kcal";u.textContent="未取得";return;}s.textContent=Number(data.steps||0).toLocaleString("ja-JP");d.textContent=`${Number(data.distanceKm||0).toFixed(2)} km`;k.textContent=`${Math.round(Number(data.activeKcal||0))} kcal`;if(data.updatedAt){const dt=new Date(data.updatedAt);if(!Number.isNaN(dt.getTime()))u.textContent=dt.toLocaleTimeString("ja-JP",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false})+" 更新";}}
async function loadHealth(){const cfg=calendarConfig();if(!cfg.token)return;try{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);const res=await fetch(healthEndpoint(),{method:"GET",cache:"no-store",headers:{Authorization:`Bearer ${cfg.token}`},signal:controller.signal});clearTimeout(timeout);if(!res.ok)throw new Error(`health ${res.status}`);const j=await res.json();if(j?.ok!==true)throw new Error(j?.error||"health data invalid");healthCache=j;renderHealth();}catch(e){console.warn("[dashboard] health fetch failed:",e);renderHealth();}}

/* =========================
   天気
   ========================= */
function weatherInfo(code){
  if(code===0) return ["☀","晴れ"];
  if([1,2].includes(code)) return ["🌤","晴れ時々くもり"];
  if(code===3) return ["☁","くもり"];
  if([45,48].includes(code)) return ["🌫","霧"];
  if([51,53,55,56,57].includes(code)) return ["🌦","霧雨"];
  if([61,63,65,66,67,80,81,82].includes(code)) return ["🌧","雨"];
  if([71,73,75,77,85,86].includes(code)) return ["🌨","雪"];
  if([95,96,99].includes(code)) return ["⛈","雷雨"];

  return ["",""];
}

const WEATHER_CACHE_KEY="dashboard_weather_cache_v2";
let weatherCache=null;
let weatherRetryTimer=null;
let weatherFailureCount=0;

function restoreWeatherCache(){
  try{
    const saved=
      localStorage.getItem(WEATHER_CACHE_KEY) ||
      localStorage.getItem("dashboard_weather_cache_v1");

    if(!saved) return;

    const parsed=JSON.parse(saved);

    if(!parsed || !parsed.data) return;

/* 3時間以上古い天気は使わない */
if(
  !Number.isFinite(parsed.savedAt) ||
  Date.now()-parsed.savedAt > 3*60*60*1000
){
  return;
}

weatherCache=parsed.data;
renderWeather();

  }catch(e){}
}

function saveWeatherCache(data){
  try{
    localStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({
        savedAt:Date.now(),
        data
      })
    );
  }catch(e){}
}

async function loadWeather(){
  if(weatherRetryTimer){
    clearTimeout(weatherRetryTimer);
    weatherRetryTimer=null;
  }

  try{
    const url=
      `https://api.open-meteo.com/v1/forecast`+
      `?latitude=${TOKYO_STATION.lat}`+
      `&longitude=${TOKYO_STATION.lon}`+
      `&current=temperature_2m,apparent_temperature,weather_code`+
      `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code`+
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max`+
      `&timezone=Asia%2FTokyo`+
      `&forecast_days=2`;

    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);

    const res=await fetch(url,{
      cache:"no-store",
      signal:controller.signal
    });

    clearTimeout(timeout);

    if(!res.ok){
      throw new Error(`weather ${res.status}`);
    }

    const data=await res.json();

    if(!data?.current || !data?.daily || !data?.hourly){
      throw new Error("weather data invalid");
    }

    weatherCache=data;
    weatherFailureCount=0;

    saveWeatherCache(data);
    renderWeather();
    markUpdated("weather");

  }catch(e){
    weatherFailureCount++;

    if(weatherCache){
      renderWeather();

    }else if(weatherFailureCount>=3){
      document.getElementById("weatherMain").textContent=
        "天気取得失敗";

      document.getElementById("weatherDetail").textContent=
        "再接続しています";

      document.getElementById("weatherClothes").textContent="";
      document.getElementById("weatherRain").textContent="";
      document.getElementById("weatherRainStart").textContent="";
    }else{
      document.getElementById("weatherMain").textContent=
        "天気取得中";

      document.getElementById("weatherDetail").textContent=
        "再接続しています";

      document.getElementById("weatherClothes").textContent="";
      document.getElementById("weatherRain").textContent="";
      document.getElementById("weatherRainStart").textContent="";
    }

    weatherRetryTimer=
  setTimeout(()=>{
    weatherRetryTimer=null;

    if(getMode()!=="off"){
      loadWeather();
    }
  },30000);
  }
}

/* 雨が始まる時間 */
function getRainStart(dayIndex){
  const hourly=weatherCache?.hourly;
  const daily=weatherCache?.daily;

  if(!hourly?.time || !daily?.time) return "";

  const targetDate=daily.time[dayIndex];

  /* 朝画面では「もう過ぎた時間」を除外 */
  let currentHour=-1;

  if(dayIndex===0 && getMode()!=="night"){
    currentHour=+jpParts().hour;
  }

  let firstRain=null;

  for(let i=0;i<hourly.time.length;i++){
    const time=hourly.time[i];

    if(!time.startsWith(targetDate)) continue;

    const hour=Number(time.slice(11,13));

    if(currentHour>=0 && hour<currentHour) continue;

    const probability=
      Number(hourly.precipitation_probability?.[i] ?? 0);

    const precipitation=
      Number(hourly.precipitation?.[i] ?? 0);

    const code=
      Number(hourly.weather_code?.[i]);

    const rainCode=[
      51,53,55,56,57,
      61,63,65,66,67,
      80,81,82,
      95,96,99
    ].includes(code);

    const likelyRain=
      precipitation>=0.2 ||
      (precipitation>0 && probability>=50) ||
      (rainCode && probability>=40);

    if(likelyRain){
      firstRain={hour,probability};
      break;
    }
  }

  if(!firstRain) return "";

  return `${firstRain.hour}時ごろから雨`;
}

/* 服装 */
function getClothingAdvice(dayIndex){
  const daily=weatherCache?.daily;
  const hourly=weatherCache?.hourly;

  if(!daily) return "";

  const maxApp=Math.round(
    daily.apparent_temperature_max?.[dayIndex] ??
    daily.temperature_2m_max?.[dayIndex]
  );

  const minApp=Math.round(
    daily.apparent_temperature_min?.[dayIndex] ??
    daily.temperature_2m_min?.[dayIndex]
  );

  const rainProbability=
    Number(
      daily.precipitation_probability_max?.[dayIndex] ?? 0
    );

  /*
   * 朝6〜9時の体感温度を取得。
   * 通勤時に一番低い体感温度を服装判定に使う。
   */
  let morningApp=null;

  if(hourly?.time){
    const targetDate=daily.time?.[dayIndex];
    const morningTemps=[];

    for(let i=0;i<hourly.time.length;i++){
      const time=hourly.time[i];

      if(!time.startsWith(targetDate)) continue;

      const hour=Number(time.slice(11,13));

      if(hour>=6 && hour<=9){
        const value=
          hourly.apparent_temperature?.[i] ??
          hourly.temperature_2m?.[i];

        if(Number.isFinite(Number(value))){
          morningTemps.push(Number(value));
        }
      }
    }

    if(morningTemps.length){
      morningApp=Math.round(Math.min(...morningTemps));
    }
  }

  /*
   * 時間別データが取れない場合だけ
   * 1日の最低体感温度で代用。
   */
  const commuteApp=
    morningApp ?? minApp;

  let advice="";

  /*
   * 朝の通勤時間と日中の暑さを両方見る。
   */
  if(commuteApp>=23){

    advice="👕 半袖でOK";

  }else if(commuteApp>=19){

    if(maxApp>=25){
      advice="👕 半袖＋薄手の羽織り";
    }else{
      advice="👕 長袖がおすすめ";
    }

  }else if(commuteApp>=16){

    if(maxApp>=24){
      advice="👕 半袖＋長袖の羽織り";
    }else{
      advice="👕 長袖＋薄手の羽織り";
    }

  }else if(commuteApp>=12){

    advice="🧥 長袖＋軽い上着";

  }else if(commuteApp>=7){

    advice="🧥 ジャケット・コート";

  }else{

    advice="🧥 しっかり防寒";
  }

  /*
   * 雨で冷えそうな日は補足。
   */
  if(rainProbability>=50 && commuteApp<20){
    advice+="・雨で冷え注意";
  }

  return advice;
}
function renderWeather(){
  if(!weatherCache) return;

  const mode=getMode();
  const idx=
    mode==="night"
      ? nightTargetOffset()
      : 0;

  const current=weatherCache.current;
  const daily=weatherCache.daily;

  const code=
    idx===0
      ? current.weather_code
      : daily.weather_code[idx];

  const [icon]=weatherInfo(code);

  const temp=
    idx===0
      ? Math.round(current.temperature_2m)
      : Math.round(daily.temperature_2m_max[idx]);

  document.getElementById("weatherMain").textContent=
    idx===0
      ? `${icon}  ${temp}°`
      : `${icon}  明日`;

  document.getElementById("weatherDetail").textContent=
    `最高${Math.round(daily.temperature_2m_max[idx])}°　`+
    `最低${Math.round(daily.temperature_2m_min[idx])}°`;

  document.getElementById("weatherClothes").textContent=
    getClothingAdvice(idx);

  document.getElementById("weatherRain").textContent=
    `💧 降水確率 ${daily.precipitation_probability_max[idx]}%`;

  const rainStart=getRainStart(idx);

  document.getElementById("weatherRainStart").textContent=
    rainStart
      ? `🌧 ${rainStart}`
      : "";
}

/* =========================
   運行情報
   ========================= */
function transitEndpoint(){
  const cfg=calendarConfig();
  const base=cfg.endpoint || DEFAULT_CALENDAR_ENDPOINT;

  if(!base) return "";

  if(base.endsWith("/calendar")){
    return base.replace(/\/calendar$/,"/transit");
  }

  return base.replace(/\/$/,"")+"/transit";
}

function busRealtimeEndpoint(){
  const cfg=calendarConfig();
  const base=cfg.endpoint || DEFAULT_CALENDAR_ENDPOINT;

  if(!base) return "";

  if(base.endsWith("/calendar")){
    return base.replace(/\/calendar$/,"/bus");
  }

  return base.replace(/\/$/,"")+"/bus";
}

function compactTransitText(line){
  const text=(line?.text || "").trim();

  if(/運転見合わせ|運転を見合わせ/.test(text)){
    return "運転見合わせ";
  }

  if(/一部.*運休|一部列車.*運休/.test(text)){
    return "一部運休";
  }

  if(/運休/.test(text)){
    return "運休";
  }

  if(/遅れ|遅延/.test(text)){
    const minuteMatches=
      [...text.matchAll(/(\d+)\s*分/g)]
        .map(m=>Number(m[1]))
        .filter(Number.isFinite);

    if(minuteMatches.length){
      return `遅延 ${Math.max(...minuteMatches)}分`;
    }

    return "遅延";
  }

  if(/平常|通常|正常|遅れはありません/.test(text)){
    return "平常";
  }

  return line?.status==="alert"
    ? "運行注意"
    : "情報なし";
}

function setTransitStatus(id,line){
  const el=document.getElementById(id);
  if(!el) return;

  const status=line?.status || "unknown";
  const shortText=compactTransitText(line);

  el.classList.remove(
    "pending",
    "normal",
    "alert",
    "error"
  );

  if(status==="normal"){
    el.classList.add("normal");
    el.innerHTML=
      `<span class="status-dot"></span>${shortText}`;
    return;
  }

  if(status==="alert"){
    el.classList.add("alert");
    el.textContent=shortText;
    return;
  }

  el.classList.add("error");
  el.textContent="情報なし";
}

function setCommutePending(){
  updateTimes.commute=null;

  document.getElementById("commuteUpdated").textContent=
    "取得中";

  document.getElementById("updateCommute").textContent=
    "--:--";

  [
    "toeiBusStatus",
    "yamanoteStatus",
    "keihinTohokuStatus",
    "ginzaStatus"
  ].forEach(id=>{
    const el=document.getElementById(id);

    if(!el) return;

    el.classList.remove(
      "normal",
      "alert",
      "error"
    );

    el.classList.add("pending");
    el.textContent="取得中";
  });
}

function isMorningDataWindow(){
  if(forcedMode==="morning" || forcedMode==="always") return true;
  const h=+jpParts().hour;
  return h>=6 && h<9;
}

async function loadTransit(){
  if(!isMorningDataWindow()) return;
  const cfg=calendarConfig();

  if(!cfg.token){
    document.getElementById("commuteUpdated").textContent=
      "未設定";

    [
      "yamanoteStatus",
      "keihinTohokuStatus",
      "ginzaStatus"
    ].forEach(id=>{
      const el=document.getElementById(id);

      if(!el) return;

      el.classList.remove(
        "normal",
        "alert",
        "pending"
      );

      el.classList.add("error");
      el.textContent="未設定";
    });

    return;
  }

  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);

    const res=await fetch(transitEndpoint(),{
      method:"GET",
      cache:"no-store",
      headers:{
        Authorization:`Bearer ${cfg.token}`
      },
      signal:controller.signal
    });

    clearTimeout(timeout);

    if(!res.ok){
      throw new Error(`transit ${res.status}`);
    }

    const data=await res.json();

    if(data?.ok!==true){
      throw new Error(
        data?.error || "transit data invalid"
      );
    }

    setTransitStatus(
      "yamanoteStatus",
      data.yamanote
    );

    setTransitStatus(
      "keihinTohokuStatus",
      data.keihinTohoku
    );

    setTransitStatus(
      "ginzaStatus",
      data.ginza
    );

    const updated=
      data?.yamanote?.updatedAt ||
      data?.keihinTohoku?.updatedAt ||
      data?.ginza?.updatedAt;

    let label="取得済";

    if(updated){
      const d=new Date(updated);

      if(!Number.isNaN(d.getTime())){
        label=d.toLocaleTimeString("ja-JP",{
          timeZone:TZ,
          hour:"2-digit",
          minute:"2-digit",
          hour12:false
        });
      }
    }

    document.getElementById("commuteUpdated").textContent=
      label;

    markUpdated("commute");

  }catch(e){
    console.warn(
      "[dashboard] transit fetch failed:",
      e
    );

    document.getElementById("commuteUpdated").textContent=
      "一部取得エラー";

    [
      "yamanoteStatus",
      "keihinTohokuStatus",
      "ginzaStatus"
    ].forEach(id=>{
      const el=document.getElementById(id);

      if(!el) return;

      el.classList.remove(
        "normal",
        "alert",
        "pending"
      );

      el.classList.add("error");
      el.textContent="取得エラー";
    });
  }
}

/* =========================
   都バス リアルタイム
   ========================= */
const BUS_RT_CACHE_KEY=
  "dashboard_bus_realtime_cache_v2";

const BUS_RT_STALE_MS=
  5*60*1000;

const BUS_RT_RETRY_DELAYS=[
  5000,
  15000,
  30000
];

let busRealtimeCache=null;
let busRealtimeLastSuccessAt=0;
let busRealtimeRetryTimer=null;
let busRealtimeFailureCount=0;
let busRealtimeInFlight=false;

function saveBusRealtimeCache(data){
  busRealtimeCache=data;
  busRealtimeLastSuccessAt=Date.now();

  try{
    localStorage.setItem(
      BUS_RT_CACHE_KEY,
      JSON.stringify({
        savedAt:busRealtimeLastSuccessAt,
        data
      })
    );
  }catch(e){}
}

function restoreBusRealtimeCache(){
  if(busRealtimeCache) return true;

  try{
    const raw=
      localStorage.getItem(BUS_RT_CACHE_KEY);

    if(!raw) return false;

    const parsed=JSON.parse(raw);

    if(
      !parsed?.data ||
      !Number.isFinite(parsed?.savedAt)
    ){
      return false;
    }

    if(
      Date.now()-parsed.savedAt >
      BUS_RT_STALE_MS
    ){
      return false;
    }

    busRealtimeCache=parsed.data;
    busRealtimeLastSuccessAt=parsed.savedAt;

    setBusRealtimeStatus(busRealtimeCache);

    return true;

  }catch(e){
    return false;
  }
}

function hasFreshBusCache(){
  return !!busRealtimeCache &&
    Number.isFinite(busRealtimeLastSuccessAt) &&
    Date.now()-busRealtimeLastSuccessAt<=
      BUS_RT_STALE_MS;
}

function scheduleBusRealtimeRetry(){
  if(busRealtimeRetryTimer){
    clearTimeout(busRealtimeRetryTimer);
    busRealtimeRetryTimer=null;
  }

  const index=
    Math.min(
      busRealtimeFailureCount-1,
      BUS_RT_RETRY_DELAYS.length-1
    );

  const delay=
    BUS_RT_RETRY_DELAYS[index];

  busRealtimeRetryTimer=
    setTimeout(()=>{
      busRealtimeRetryTimer=null;
      if(isMorningDataWindow()) loadBusRealtime();
    },delay);
}

function setBusRealtimeStatus(data){
  const el=
    document.getElementById("toeiBusStatus");

  if(!el) return;

  el.classList.remove(
    "pending",
    "normal",
    "alert",
    "error"
  );

  if(!data || data.ok!==true){
    el.classList.add("error");
    el.textContent="取得エラー";
    return;
  }

  const next=data.nextBus;

  if(next){
    if(next.position==="at"){
      el.classList.add("alert");
      el.textContent="まもなく";
      return;
    }

    if(
      Number.isFinite(
        next.stopsBeforeMiyagi
      )
    ){
      el.classList.add("normal");
      el.innerHTML=
        `<span class="status-dot"></span>`+
        `あと${next.stopsBeforeMiyagi}停留所`;

      return;
    }
  }

  el.classList.add("normal");
  el.innerHTML=
    `<span class="status-dot"></span>`+
    `接近車両なし`;
}

function showBusRetrying(){
  const el=
    document.getElementById("toeiBusStatus");

  if(!el) return;

  if(hasFreshBusCache()){
    setBusRealtimeStatus(
      busRealtimeCache
    );
    return;
  }

  el.classList.remove(
    "normal",
    "alert",
    "error"
  );

  el.classList.add("pending");
  el.textContent="再取得中";
}

async function loadBusRealtime(){
  if(!isMorningDataWindow()){
    if(busRealtimeRetryTimer){
      clearTimeout(busRealtimeRetryTimer);
      busRealtimeRetryTimer=null;
    }
    busRealtimeFailureCount=0;
    return;
  }

  if(busRealtimeInFlight) return;

  const cfg=calendarConfig();

  if(!cfg.token){
    const el=
      document.getElementById("toeiBusStatus");

    if(el){
      el.classList.remove(
        "normal",
        "alert",
        "pending"
      );

      el.classList.add("error");
      el.textContent="未設定";
    }

    return;
  }

  restoreBusRealtimeCache();

  busRealtimeInFlight=true;

  let timeout=null;

  try{
    const controller=
      new AbortController();

    timeout=
      setTimeout(
        ()=>controller.abort(),
        10000
      );

    const res=await fetch(
      busRealtimeEndpoint(),
      {
        method:"GET",
        cache:"no-store",
        headers:{
          Authorization:
            `Bearer ${cfg.token}`
        },
        signal:controller.signal
      }
    );

    if(!res.ok){
      throw new Error(
        `bus ${res.status}`
      );
    }

    const data=await res.json();

    if(data?.ok!==true){
      throw new Error(
        data?.error ||
        "bus data invalid"
      );
    }

    if(busRealtimeRetryTimer){
      clearTimeout(
        busRealtimeRetryTimer
      );

      busRealtimeRetryTimer=null;
    }

    busRealtimeFailureCount=0;

    saveBusRealtimeCache(data);
    setBusRealtimeStatus(data);

    markUpdated("commute");

  }catch(e){
    busRealtimeFailureCount+=1;

    console.warn(
      `[dashboard] bus fetch failed (${busRealtimeFailureCount})`,
      e?.name || "Error",
      e?.message || e
    );

    showBusRetrying();
    scheduleBusRealtimeRetry();

  }finally{
    if(timeout){
      clearTimeout(timeout);
    }

    busRealtimeInFlight=false;
  }
}

/* =========================
   画面更新
   ========================= */
let lastSeenDate=ymd();

function tick(){
  const p=jpParts();
  const currentDate=ymd();

  if(currentDate!==lastSeenDate){
  lastSeenDate=currentDate;

  if(getMode()!=="off"){
    loadCalendar();
    loadWeather();
  }
}
  document.getElementById("clock").textContent=
    `${p.hour}:${p.minute}`;

  document.getElementById("date").textContent=
    `${+p.month}月${+p.day}日（${p.weekday}）`;

  const mode=getMode();

  document.getElementById("blackout")
    .classList.toggle(
      "hidden",
      mode!=="off"
    );

  const night=mode==="night";

  document.body.classList.toggle("night-mode",night);
  document.getElementById("updateBar").classList.toggle("hidden",night);
  if(night){
    document.getElementById("garbageTitle").textContent="🗑 明日のごみ";
    updateGarbage(nightTargetOffset());
    renderHealth();
  }else{
    document.getElementById("scheduleTitle").textContent="📅 今日の予定";
    document.getElementById("garbageTitle").textContent="🗑 今日のごみ";
    updateGarbage(0);
    updateBus();
  }

  renderWeather();
  renderCalendar();
}

/* =========================
   起動
   ========================= */
setCommutePending();
restoreWeatherCache();
restoreBusRealtimeCache();
restorePresenceCache();

loadPresence().then(()=>{
  tick();

  const mode=getMode();

  if(mode!=="off"){
    loadWeather();
    loadCalendar();
  }

  if(mode==="night"){
    loadHealth();
  }

  if(isMorningDataWindow()){
    loadTransit();
    loadBusRealtime();
  }
});

tick();

if(isLocalPreview && !requestedMode){
  document.getElementById("status").textContent=
    "プレビュー 08:00";
}

setInterval(tick,1000);

/* 天気も表示時間帯だけ10分更新 */
if(getMode()!=="off"){
  loadWeather();
}

setInterval(()=>{
  if(getMode()!=="off"){
    loadWeather();
  }
},10*60*1000);

/* カレンダーは表示時間帯だけ5分更新 */
if(getMode()!=="off"){
  loadCalendar();
}

setInterval(()=>{
  if(getMode()!=="off"){
    loadCalendar();
  }
},5*60*1000);
/* Healthは夜モードで使う時間帯だけ取得 */
if(getMode()==="night"){
  loadHealth();
}

setInterval(()=>{
  if(getMode()==="night"){
    loadHealth();
  }
},60*1000);

if(isMorningDataWindow()){
  loadTransit();
  loadBusRealtime();
}

setInterval(()=>{
  if(isMorningDataWindow()) loadTransit();
},2*60*1000);

setInterval(()=>{
  if(isMorningDataWindow()) loadBusRealtime();
},30*1000);

const calendarSetupButton=
  document.getElementById(
    "calendarSetupButton"
  );

if(calendarSetupButton){
  calendarSetupButton
    .addEventListener(
      "click",
      ()=>{
        const url=
          new URL(location.href);

        url.searchParams.set(
          "setup",
          "1"
        );

        location.href=
          url.toString();
      }
    );
}

document.addEventListener(
  "visibilitychange",
  ()=>{
    if(
      document.visibilityState===
      "visible"
    ){
     if(getMode()!=="off"){
  loadWeather();
  loadCalendar();
}

if(getMode()==="night"){
  loadHealth();
}
      if(isMorningDataWindow()){
        loadTransit();
        loadBusRealtime();
      }
      loadPresence().then(tick);
    }
  }
);

window.addEventListener(
  "online",
  ()=>{
    if(getMode()!=="off"){
  loadWeather();
  loadCalendar();
}

if(getMode()==="night"){
  loadHealth();
}
    if(isMorningDataWindow()){
      loadTransit();
      loadBusRealtime();
    }
    loadPresence().then(tick);
  }
);

/* 在宅判定：
   朝・夜の表示時間付近だけ1分ごとに確認し、
   それ以外の時間は定期チェックを走らせない */
let lastPresenceCheck=0;

setInterval(
  async ()=>{
    const h=+jpParts().hour;
    const m=+jpParts().minute;
    const nowMinutes=h*60+m;

    const nearDisplayTime=
      (nowMinutes>=5*60+50 && nowMinutes<9*60) ||
      (nowMinutes>=20*60+50 && nowMinutes<24*60);

    if(!nearDisplayTime){
      return;
    }

    if(Date.now()-lastPresenceCheck < 60*1000){
      return;
    }

    lastPresenceCheck=Date.now();

    await loadPresence();
    tick();
  },
  60*1000
);
