/* =====================================================
   TITAN Platform — app.js (Filter v4.1 FINAL)
   ===================================================== */

/* ================= API KEYS ================= */
// PASTE YOUR REAL KEYS HERE
const GEMINI_API_KEY = "AIzaSyAXjQ-TlpONKsxIDZB1qKVusAXZRiVSzGc";
const OPENAI_API_KEY = "sk-proj-sd8KIsTFKqcF92xIKe8tRgsFf4Q0WAku9JZzIB-H134ahokVGNlCYvblG5HbczMm-VA1ztWr6sT3BlbkFJYtjERdSJX4ciZE2dZavh91JLsXitCXKQlgumDAB-XYXBfWKwlXJa-7baKo9v_itD2BFfcRDT4Az";

/* ================= ENDPOINTS ================= */
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const OPENAI_CHAT_ENDPOINT =
  "https://api.openai.com/v1/chat/completions";

/* ================= STATE ================= */
let chats = JSON.parse(localStorage.getItem("titanChats") || "{}");
let current = null;

/* ================= SAVE ================= */
function save(){
  localStorage.setItem("titanChats", JSON.stringify(chats));
}

/* ================= CHAT CORE ================= */
function newChat(){
  const id = "chat_" + Date.now();
  chats[id] = {
    title: "New Chat",
    messages: [],
    strikes: 0,
    trust: 0
  };
  current = id;
  save();
  renderChats();
  renderLog();
}

function renderChats(){
  const list = document.getElementById("chatList");
  list.innerHTML = "";
  for (const id in chats){
    const d = document.createElement("div");
    d.className = "chat";
    d.textContent = chats[id].title;
    d.onclick = () => {
      current = id;
      renderLog();
    };
    list.appendChild(d);
  }
}

function renderLog(){
  const log = document.getElementById("log");
  log.innerHTML = "";
  if (!current) return;

  chats[current].messages.forEach(m => {
    const div = document.createElement("div");
    div.className = "message " + (m.role === "user" ? "user" : "titan");
    div.textContent = m.text;
    log.appendChild(div);
  });

  log.scrollTop = log.scrollHeight;
}

/* ================= FILTER v4.1 ================= */
const FILTER_RULES = {
  blocked: ["rape", "pedo", "child abuse"],
  hostile: ["dick", "bitch", "asshole", "retard"],
  casual: ["fuck", "shit", "damn"]
};

const SEXUAL_TOPICS = [
  "masturbation",
  "sex",
  "porn",
  "penis",
  "vagina",
  "orgasm",
  "ejaculate"
];

const TRUST = { MAX: 5, MIN: -5 };

function initTrust(id){
  if (chats[id].trust === undefined) chats[id].trust = 0;
}

function changeTrust(id, delta){
  initTrust(id);
  chats[id].trust = Math.max(
    TRUST.MIN,
    Math.min(TRUST.MAX, chats[id].trust + delta)
  );
  save();
}

function getTrust(id){
  initTrust(id);
  return chats[id].trust;
}

function addStrike(id){
  chats[id].strikes = (chats[id].strikes || 0) + 1;
  save();
}

function getStrikes(id){
  return chats[id].strikes || 0;
}

function isContextual(input){
  return (
    input.includes('"') ||
    input.includes("'") ||
    /meaning|define|example|explain|word/i.test(input)
  );
}

function isExplicitlyEducational(input){
  return /what is|define|explain|biology|health|medical/i.test(input);
}

function classifyInput(input, id){
  const t = input.toLowerCase();
  const trust = getTrust(id);

  if (isContextual(input) || isExplicitlyEducational(input)) return "clean";

  for (const w of FILTER_RULES.blocked){
    if (t.includes(w)) return "blocked";
  }

  for (const w of SEXUAL_TOPICS){
    if (t.includes(w)) return "sexual";
  }

  for (const w of FILTER_RULES.hostile){
    if (t.includes(w)) return trust < 1 ? "hostile" : "casual";
  }

  for (const w of FILTER_RULES.casual){
    if (t.includes(w)) return trust < -2 ? "hostile" : "casual";
  }

  return "clean";
}

/* ================= MUTE / SHADOW ================= */
function isMuted(id){
  return chats[id].muteUntil && Date.now() < chats[id].muteUntil;
}

function muteChat(id, seconds){
  chats[id].muteUntil = Date.now() + seconds * 1000;
  save();
}

/* ================= SEND ================= */
async function send(){
  const input = document.getElementById("input");
  if (!current) newChat();

  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  chats[current].messages.push({ role: "user", text });

  // Auto-title chat
  if (chats[current].title === "New Chat"){
    chats[current].title =
      text.slice(0, 30) + (text.length > 30 ? "…" : "");
  }

  renderLog();

  const level = classifyInput(text, current);

  // SHADOW MODE
  if (isMuted(current)) return;

  // BLOCKED
  if (level === "blocked"){
    changeTrust(current, -3);
    addStrike(current);
    chats[current].messages.push({
      role: "titan",
      text: "🚫 Not happening."
    });
    save(); renderLog();
    return;
  }

  // SEXUAL TOPIC
  if (level === "sexual"){
    chats[current].messages.push({
      role: "titan",
      text: "Not getting into sexual topics. Ask something else."
    });
    save(); renderLog();
    return;
  }

  // HOSTILE
  if (level === "hostile"){
    changeTrust(current, -2);
    addStrike(current);

    let msg = "Nah.";
    const s = getStrikes(current);
    if (s === 2) msg = "Chill.";
    if (s === 3) msg = "Last warning.";
    if (s >= 4){
      muteChat(current, 60);
      msg = "Muted. Come back later.";
    }

    chats[current].messages.push({ role: "titan", text: msg });
    save(); renderLog();
    return;
  }

  // CASUAL SWEARING
  if (level === "casual"){
    changeTrust(current, -0.5);
    chats[current].messages.push({
      role: "titan",
      text: "Alright. Get to the point."
    });
    save(); renderLog();
    return;
  }

  // CLEAN INPUT → TRUST RECOVERY
  changeTrust(current, +0.25);

  // AI RESPONSE
  let reply = await think(text);
  if (!reply || typeof reply !== "string"){
    reply = "Say that again.";
  }

  chats[current].messages.push({ role: "titan", text: reply.trim() });
  save(); renderLog();
}

/* ================= THINK ================= */
async function think(prompt){
  let r = await askGemini(prompt);
  if (!r) r = await askChatGPT(prompt);
  if (!r) r = localFallback();
  return r;
}

/* ================= GEMINI ================= */
async function askGemini(prompt){
  if (!GEMINI_API_KEY) return null;
  try{
    const res = await fetch(GEMINI_ENDPOINT,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-goog-api-key":GEMINI_API_KEY
      },
      body:JSON.stringify({
        contents:[{ role:"user", parts:[{text:prompt}] }]
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  }catch{
    return null;
  }
}

/* ================= CHATGPT ================= */
async function askChatGPT(prompt){
  if (!OPENAI_API_KEY) return null;
  try{
    const res = await fetch(OPENAI_CHAT_ENDPOINT,{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Authorization":"Bearer "+OPENAI_API_KEY
      },
      body:JSON.stringify({
        model:"gpt-4.1-mini",
        messages:[{ role:"user", content:prompt }],
        temperature:0.6
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  }catch{
    return null;
  }
}

/* ================= FALLBACK ================= */
function localFallback(){
  const r = [
    "Be specific.",
    "Clarify what you want.",
    "What’s the actual goal?",
    "Give me constraints."
  ];
  return r[Math.floor(Math.random()*r.length)];
}

/* ================= MIC ================= */
let recognition = null;
if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window){
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new R();
  recognition.lang = "en-US";
  recognition.onresult = e => {
    document.getElementById("input").value =
      e.results[0][0].transcript;
  };
}

function startMic(){
  if (!recognition){
    alert("Mic not supported.");
    return;
  }
  recognition.start();
}

/* ================= INIT ================= */
renderChats();
