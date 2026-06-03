// =============================================
//  HALVENS v3
//  - Onboarding: AI interviews each partner
//  - localStorage: never re-do setup
//  - Text-to-speech + Speech-to-text
//  - Chat memory, task list, calendar, fairness bar
// =============================================

const API_KEY = "PASTE_YOUR_GEMINI_API_KEY_HERE";
const MODEL   = "gemini-2.5-flash";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

// =============================================
//  STORAGE KEYS
// =============================================
const STORAGE_KEY = "halvens_v3";

// =============================================
//  APP STATE
//  Loaded from localStorage on startup,
//  saved back after every meaningful change.
// =============================================
let state = {
  // Setup
  name1: "",
  name2: "",
  cal1Base64: null,
  cal2Base64: null,

  // Onboarding progress
  onboardingDone: false,
  onboardingStep: 0,  // 0=person1, 1=person2, 2=shared
  onboardingHistory1: [],
  onboardingHistory2: [],
  onboardingHistoryShared: [],

  // Preferences extracted from onboarding
  prefs1: "",   // plain text summary of person 1's preferences
  prefs2: "",   // plain text summary of person 2's preferences

  // Main chat
  chatHistory: [],

  // Tasks
  tasks: { person1: [], person2: [], unassigned: [] },

  // Calendar
  calendarEvents: [],
  currentYear: new Date().getFullYear(),
  currentMonth: new Date().getMonth(),

  // Fairness score (task count this month)
  score1: 0,
  score2: 0,

  // Speech
  speechEnabled: true
};

// =============================================
//  SPEECH: Text-to-speech
//  Voices load asynchronously on Mac/Chrome.
//  We store the best voice once loaded and reuse it.
// =============================================
let chosenVoice = null;

function loadBestVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return;

  // Priority list — Mac natural voices first, then fallbacks
  // These are the names of the high-quality Neural/Enhanced voices on macOS
  // Exact names from this machine — in order of preference
  const priority = [
    "Shelley (English (United Kingdom))",
    "Karen",
    "Samantha",
    "Moira",
    "Sandy (English (United Kingdom))",
    "Serena",
    "Google UK English Female",
  ];

  for (const name of priority) {
    const v = voices.find(v => v.name === name);
    if (v) { chosenVoice = v; return; }
  }

  // Fallback: any non-Google en-GB or en-AU voice
  const natural = voices.find(v =>
    (v.lang === "en-GB" || v.lang === "en-AU") &&
    !v.name.startsWith("Google") &&
    !["Daniel","Fred","Ralph","Junior","Jester","Bad News","Boing","Bubbles","Organ","Wobble","Zarvox"].includes(v.name)
  );
  if (natural) { chosenVoice = natural; return; }

  // Last resort: any English voice that is not obviously robotic
  chosenVoice = voices.find(v => v.lang.startsWith("en") && !v.name.startsWith("Google")) || voices[0];
}

// Voices load asynchronously — hook into the event
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = loadBestVoice;
}

function speak(text) {
  if (!state.speechEnabled) return;
  if (!window.speechSynthesis) return;

  // Strip markdown and JSON blocks so the AI doesn't read asterisks
  const clean = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/[#*`\[\]]/g, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return;

  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(clean);

  // Use the pre-loaded best voice
  if (chosenVoice) utt.voice = chosenVoice;

  // Natural-sounding settings
  utt.rate  = 0.95;   // slightly slower than default — more natural
  utt.pitch = 1.0;
  utt.lang  = chosenVoice?.lang || "en-GB";

  window.speechSynthesis.speak(utt);
}

function toggleSpeech() {
  state.speechEnabled = !state.speechEnabled;
  const btn = document.getElementById("speech-toggle");
  btn.classList.toggle("active", state.speechEnabled);
  saveState();
}

// =============================================
//  SPEECH: Speech-to-text (Web Speech API)
// =============================================
let recognition = null;
let activeInputId = null;

function toggleMic(context) {
  const inputId = context === "main" ? "chat-input" : "onboarding-input";
  const btnId   = context === "main" ? "mic-btn-main" : "mic-btn-onboarding";

  if (recognition) {
    recognition.stop();
    recognition = null;
    document.getElementById(btnId).classList.remove("listening");
    return;
  }

  if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
    alert("Speech recognition is not supported in this browser. Try Chrome.");
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = "en-GB";
  recognition.continuous = false;
  recognition.interimResults = false;

  document.getElementById(btnId).classList.add("listening");
  activeInputId = inputId;

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    const input = document.getElementById(inputId);
    input.value = (input.value + " " + transcript).trim();
    autoResize(input);
  };

  recognition.onend = () => {
    recognition = null;
    document.getElementById(btnId).classList.remove("listening");
    // Auto-send after speaking
    if (context === "main") sendChatMessage();
    else sendOnboardingMessage();
  };

  recognition.onerror = () => {
    recognition = null;
    document.getElementById(btnId).classList.remove("listening");
  };

  recognition.start();
}

// =============================================
//  STORAGE
// =============================================
function saveState() {
  // Don't save the huge base64 images every time (too large, keep in memory only)
  const toSave = { ...state, cal1Base64: null, cal2Base64: null };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch(e) {
    console.warn("localStorage save failed:", e);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    state = { ...state, ...saved };
    return true;
  } catch(e) {
    return false;
  }
}

// =============================================
//  ENTRY POINTS
// =============================================

// "Continue where you left off" button
function loadExistingSession() {
  const loaded = loadState();
  if (!loaded || !state.name1) {
    alert("No saved session found. Please start fresh.");
    return;
  }
  if (state.onboardingDone) {
    launchApp();
  } else {
    // Resume onboarding
    showScreen("onboarding");
    resumeOnboarding();
  }
}

// "Get started" button
function beginOnboarding() {
  const n1 = document.getElementById("input-name1").value.trim();
  const n2 = document.getElementById("input-name2").value.trim();
  if (!n1 || !n2) { alert("Please enter both names."); return; }

  state.name1 = n1;
  state.name2 = n2;
  state.onboardingStep = 0;
  state.onboardingHistory1 = [];
  state.onboardingHistory2 = [];
  state.onboardingHistoryShared = [];
  saveState();

  showScreen("onboarding");
  startOnboardingStep(0);
}

// =============================================
//  ONBOARDING
//  3 steps: interview person 1, person 2, shared
// =============================================
const ONBOARDING_STEPS = [
  {
    who: (s) => s.name1,
    systemPrompt: (s) => `You are Halvens, a warm and friendly household task planner. 
You are interviewing ${s.name1} to learn their preferences for household tasks.
Ask them naturally, one question at a time, in a conversational way. Be warm and encouraging.
You need to learn:
1. What household tasks they don't mind doing (or even enjoy)
2. What tasks they really dislike
3. How much time per week they roughly have for household tasks
4. Whether they consider themselves good at certain tasks
Keep it light and conversational. After 4-5 exchanges, wrap up warmly and say you have everything you need.
End your final message with exactly: [ONBOARDING_COMPLETE]`,
    startMsg: (s) => `Hi ${s.name1}! I'm Halvens — I'm going to help you and ${s.name2} divide household tasks fairly. Let me start by getting to know you a little. What household tasks do you actually not mind doing — or maybe even enjoy?`
  },
  {
    who: (s) => s.name2,
    systemPrompt: (s) => `You are Halvens, a warm and friendly household task planner.
You have just finished interviewing ${s.name1} and now you are interviewing ${s.name2}.
Their partner's preferences: ${s.prefs1}
Ask ${s.name2} the same kinds of questions — naturally, one at a time, warm and encouraging.
You need to learn:
1. What household tasks they don't mind doing (or even enjoy)
2. What tasks they really dislike
3. How much time per week they roughly have
4. Whether they're good at certain tasks
After 4-5 exchanges, wrap up and say you have everything you need.
End your final message with exactly: [ONBOARDING_COMPLETE]`,
    startMsg: (s) => `Now let me get to know you, ${s.name2}! Same question — what household tasks do you not mind doing, or maybe even enjoy?`
  },
  {
    who: (s) => "both",
    systemPrompt: (s) => `You are Halvens, a warm and friendly household task planner.
You have learned about both partners:
${s.name1}'s preferences: ${s.prefs1}
${s.name2}'s preferences: ${s.prefs2}
Now ask a few quick questions about their SHARED household situation:
1. What tasks need to happen every week without fail?
2. Are there any monthly tasks?
3. Has one person been doing more than their share lately?
Keep it brief and warm. After 3-4 exchanges, wrap up enthusiastically.
End your final message with exactly: [ONBOARDING_COMPLETE]`,
    startMsg: (s) => `Great — now just a few quick questions about your home together. What are the tasks that absolutely have to happen every single week, no matter what?`
  }
];

function startOnboardingStep(step) {
  state.onboardingStep = step;
  const cfg = ONBOARDING_STEPS[step];

  // Update progress dots
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`step-dot-${i+1}`);
    dot.className = "progress-step" + (i < step ? " done" : i === step ? " active" : "");
  }

  // Update "who" label
  const who = cfg.who(state);
  document.getElementById("onboarding-who").textContent =
    who === "both" ? state.name1 + " & " + state.name2 : who;

  // Clear messages
  document.getElementById("onboarding-messages").innerHTML = "";

  // Show first message from AI
  const firstMsg = cfg.startMsg(state);
  addOnboardingAIMessage(firstMsg);
  speak(firstMsg);

  // Init the history for this step with that opening
  const history = getOnboardingHistory();
  history.length = 0;
  history.push({ role: "model", parts: [{ text: firstMsg }] });
}

function resumeOnboarding() {
  const step = state.onboardingStep || 0;
  const cfg = ONBOARDING_STEPS[step];

  // Restore progress dots
  for (let i = 0; i < 3; i++) {
    const dot = document.getElementById(`step-dot-${i+1}`);
    dot.className = "progress-step" + (i < step ? " done" : i === step ? " active" : "");
  }
  const who = cfg.who(state);
  document.getElementById("onboarding-who").textContent =
    who === "both" ? state.name1 + " & " + state.name2 : who;

  // Re-render history
  const history = getOnboardingHistory();
  history.forEach(msg => {
    if (msg.role === "model") addOnboardingAIMessage(msg.parts[0].text);
    else addOnboardingUserMessage(msg.parts[0].text);
  });
}

function getOnboardingHistory() {
  if (state.onboardingStep === 0) return state.onboardingHistory1;
  if (state.onboardingStep === 1) return state.onboardingHistory2;
  return state.onboardingHistoryShared;
}

async function sendOnboardingMessage() {
  const input = document.getElementById("onboarding-input");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.style.height = "auto";

  addOnboardingUserMessage(text);
  const history = getOnboardingHistory();
  history.push({ role: "user", parts: [{ text }] });

  const typingId = showTypingIn("onboarding-messages");
  const reply = await callGeminiOnboarding();
  removeTyping(typingId);

  if (!reply) return;

  // Strip the completion marker before displaying
  const clean = reply.replace("[ONBOARDING_COMPLETE]", "").trim();
  addOnboardingAIMessage(clean);
  speak(clean);
  history.push({ role: "model", parts: [{ text: reply }] });
  saveState();

  // Check if this step is done
  if (reply.includes("[ONBOARDING_COMPLETE]")) {
    await extractPrefsAndAdvance();
  }
}

async function extractPrefsAndAdvance() {
  // Ask Gemini to summarise the preferences in a short paragraph
  const history = getOnboardingHistory();
  const summaryPrompt = `Based on this conversation, write a short 2-3 sentence summary of this person's household task preferences and availability. Be specific. No intro, just the summary.`;

  const summaryBody = {
    contents: [
      ...history,
      { role: "user", parts: [{ text: summaryPrompt }] }
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 200 }
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summaryBody)
    });
    const data = await res.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (state.onboardingStep === 0) state.prefs1 = summary;
    else if (state.onboardingStep === 1) state.prefs2 = summary;
    saveState();
  } catch(e) {
    console.warn("Prefs summary failed:", e);
  }

  // Move to next step or finish
  setTimeout(() => {
    if (state.onboardingStep < 2) {
      startOnboardingStep(state.onboardingStep + 1);
    } else {
      // Onboarding complete — go to calendar upload
      state.onboardingDone = true;
      saveState();
      showScreen("calendar");
      // Update calendar labels
      document.getElementById("cal-label-1").textContent = state.name1 + "'s calendar";
      document.getElementById("cal-label-2").textContent = state.name2 + "'s calendar";
    }
  }, 1200);
}

async function callGeminiOnboarding() {
  const step = state.onboardingStep;
  const cfg = ONBOARDING_STEPS[step];
  const history = getOnboardingHistory();

  try {
    const body = {
      system_instruction: { parts: [{ text: cfg.systemPrompt(state) }] },
      contents: history,
      generationConfig: { temperature: 0.8, maxOutputTokens: 400 }
    };
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error?.message);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch(e) {
    addOnboardingAIMessage("Something went wrong: " + e.message);
    return null;
  }
}

// =============================================
//  CALENDAR UPLOAD
// =============================================
function handleUpload(person, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const base64 = e.target.result.split(",")[1];
    if (person === 1) {
      state.cal1Base64 = base64;
      document.getElementById("upload-label-1").textContent = "✓ " + file.name;
      document.getElementById("upload-area-1").classList.add("has-file");
    } else {
      state.cal2Base64 = base64;
      document.getElementById("upload-label-2").textContent = "✓ " + file.name;
      document.getElementById("upload-area-2").classList.add("has-file");
    }
    const preview = document.getElementById(`preview${person}`);
    preview.src = e.target.result;
    preview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

function finishSetup() {
  launchApp();
}

// =============================================
//  LAUNCH MAIN APP
// =============================================
function launchApp() {
  showScreen("app");

  // Update UI with names
  document.getElementById("score-name1").textContent = state.name1;
  document.getElementById("score-name2").textContent = state.name2;
  document.getElementById("legend-name-1").textContent = state.name1;
  document.getElementById("legend-name-2").textContent = state.name2;
  document.getElementById("chat-subtitle").textContent = state.name1 + " & " + state.name2;

  updateFairnessBar();
  renderCalendar();
  renderTaskList();

  // Restore or start chat
  if (state.chatHistory.length > 0) {
    // Re-render saved chat
    state.chatHistory.forEach(msg => {
      if (msg.role === "model") addChatAIMessage(msg.parts[0].text, false);
      else if (msg.role === "user") addChatUserMessage(msg.parts[0].text);
    });
  } else {
    // First time in main chat — send welcome
    sendWelcomeToMainChat();
  }
}

async function sendWelcomeToMainChat() {
  const calNote = (state.cal1Base64 || state.cal2Base64)
    ? "Calendar screenshots were provided — I can see their schedules."
    : "No calendar screenshots — I'll work with availability described in chat.";

  const welcomeText = `Welcome back! I know ${state.name1} and ${state.name2} well now. ${calNote} What would you like to plan?`;

  // Build parts including calendar images if present
  const parts = [{ text: `Here is the context from our onboarding:\n${state.name1}'s preferences: ${state.prefs1}\n${state.name2}'s preferences: ${state.prefs2}\n\nPlease greet them warmly, confirm you remember their preferences briefly, and ask what they'd like to plan first.` }];

  if (state.cal1Base64) parts.push({ inline_data: { mime_type: "image/jpeg", data: state.cal1Base64 } });
  if (state.cal2Base64) parts.push({ inline_data: { mime_type: "image/jpeg", data: state.cal2Base64 } });

  state.chatHistory.push({ role: "user", parts });

  const typingId = showTypingIn("chat-messages");
  const reply = await callGeminiMain();
  removeTyping(typingId);

  if (reply) {
    state.chatHistory.push({ role: "model", parts: [{ text: reply }] });
    addChatAIMessage(reply);
    parseAndUpdate(reply);
    saveState();
  }
}

// =============================================
//  MAIN CHAT
// =============================================
function buildMainSystemPrompt() {
  return `You are Halvens, a warm, kind, and fair household task planner for a couple.

You know these two people well from their onboarding:
${state.name1}: ${state.prefs1}
${state.name2}: ${state.prefs2}

Your principles:
- Always assign tasks according to preferences when possible — give people tasks they don't mind
- Aim for 50/50 fairness by end of month. Current score: ${state.name1} has done ${state.score1} tasks, ${state.name2} has done ${state.score2} tasks
- If one person is behind, gently catch them up over the next few weeks — don't front-load
- Distinguish recurring tasks (weekly/monthly) from one-offs
- If the week looks busy for someone (from their calendar), give them fewer tasks that week
- Be warm, specific, and use real names
- Remember everything from this conversation — never forget agreed tasks

When tasks change, output a JSON block:
\`\`\`json
{
  "tasks": {
    "person1": [{"text": "...", "recur": "weekly"}],
    "person2": [{"text": "...", "recur": "monthly"}],
    "unassigned": []
  },
  "events": [
    {"date": "2026-06-05", "person": "p1", "text": "Cook dinner"},
    {"date": "2026-06-06", "person": "blocked", "text": "${state.name2} busy"}
  ],
  "score1": 3,
  "score2": 4
}
\`\`\`
Only output JSON when tasks or scores change. Current month: ${state.currentYear}-${String(state.currentMonth+1).padStart(2,"0")}.`;
}

async function sendChatMessage() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.style.height = "auto";
  addChatUserMessage(text);

  state.chatHistory.push({ role: "user", parts: [{ text }] });
  document.getElementById("send-btn").disabled = true;

  const typingId = showTypingIn("chat-messages");
  const reply = await callGeminiMain();
  removeTyping(typingId);
  document.getElementById("send-btn").disabled = false;

  if (reply) {
    state.chatHistory.push({ role: "model", parts: [{ text: reply }] });
    addChatAIMessage(reply);
    parseAndUpdate(reply);
    saveState();
  }
}

async function callGeminiMain() {
  try {
    const body = {
      system_instruction: { parts: [{ text: buildMainSystemPrompt() }] },
      contents: state.chatHistory,
      generationConfig: { temperature: 0.7, maxOutputTokens: 2500 }
    };
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error?.message || `Error ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch(e) {
    addChatAIMessage("Something went wrong: " + e.message);
    return null;
  }
}

// =============================================
//  PARSE AI RESPONSE → update state
// =============================================
function parseAndUpdate(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return;
  try {
    const data = JSON.parse(match[1]);
    if (data.tasks) {
      if (data.tasks.person1)    state.tasks.person1    = data.tasks.person1;
      if (data.tasks.person2)    state.tasks.person2    = data.tasks.person2;
      if (data.tasks.unassigned) state.tasks.unassigned = data.tasks.unassigned;
      renderTaskList();
    }
    if (data.events) {
      data.events.forEach(ev => {
        if (!state.calendarEvents.find(e => e.date === ev.date && e.text === ev.text))
          state.calendarEvents.push(ev);
      });
      renderCalendar();
    }
    if (data.score1 !== undefined) state.score1 = data.score1;
    if (data.score2 !== undefined) state.score2 = data.score2;
    updateFairnessBar();
  } catch(e) {
    // No JSON block this turn — fine
  }
}

// =============================================
//  FAIRNESS BAR
// =============================================
function updateFairnessBar() {
  const total = state.score1 + state.score2;
  const pct = total === 0 ? 50 : Math.round((state.score1 / total) * 100);
  document.getElementById("score-fill").style.width = pct + "%";
}

// =============================================
//  RENDER TASK LIST
// =============================================
function renderTaskList() {
  const el = document.getElementById("task-list-content");
  if (!el) return;
  const { person1, person2, unassigned } = state.tasks;
  if (!person1.length && !person2.length && !unassigned.length) {
    el.innerHTML = `<p class="empty-state">Tasks will appear here as you chat.</p>`;
    return;
  }

  let html = "";
  const section = (title, cls, items, dotCls) => {
    if (!items.length) return "";
    let s = `<div class="task-section"><div class="task-section-title ${cls}">${title}</div>`;
    items.forEach(t => {
      s += `<div class="task-item">
        <span class="task-dot ${dotCls}"></span>
        <span>${t.text}</span>
        ${t.recur ? `<span class="task-recur">${t.recur}</span>` : ""}
      </div>`;
    });
    return s + "</div>";
  };

  html += section(state.name1, "p1", person1, "dot-p1");
  html += section(state.name2, "p2", person2, "dot-p2");
  html += section("unassigned", "shared", unassigned, "");
  el.innerHTML = html;
}

// =============================================
//  RENDER CALENDAR
// =============================================
function renderCalendar() {
  const el = document.getElementById("calendar-grid");
  if (!el) return;
  const { currentYear: y, currentMonth: m } = state;

  document.getElementById("month-label").textContent =
    new Date(y, m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  const firstDay  = new Date(y, m, 1).getDay();
  const offset    = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMo  = new Date(y, m+1, 0).getDate();
  const daysInPrev= new Date(y, m, 0).getDate();
  const today     = new Date();
  const total     = Math.ceil((offset + daysInMo) / 7) * 7;

  const days = ["Mo","Tu","We","Th","Fr","Sa","Su"];
  let html = `<div class="cal-weekdays">` +
    days.map(d => `<div class="cal-weekday">${d}</div>`).join("") +
    `</div><div class="cal-days">`;

  for (let i = 0; i < total; i++) {
    let day, thisMonth = true;
    if (i < offset)                { day = daysInPrev - offset + i + 1; thisMonth = false; }
    else if (i >= offset + daysInMo){ day = i - offset - daysInMo + 1;  thisMonth = false; }
    else                            { day = i - offset + 1; }

    const isToday = thisMonth && today.getDate()===day && today.getMonth()===m && today.getFullYear()===y;
    const dateStr = `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const events  = thisMonth ? state.calendarEvents.filter(e => e.date === dateStr) : [];

    let cls = "cal-day" + (!thisMonth ? " other-month" : "") + (isToday ? " today" : "");
    html += `<div class="${cls}"><div class="day-num">${day}</div><div class="day-tasks">`;
    events.forEach(ev => {
      const c = ev.person==="blocked" ? "blocked" : ev.person==="p1" ? "p1" : "p2";
      html += `<div class="day-task ${c}" title="${ev.text}">${ev.text}</div>`;
    });
    html += `</div></div>`;
  }

  html += "</div>";
  el.innerHTML = html;
}

function changeMonth(dir) {
  state.currentMonth += dir;
  if (state.currentMonth > 11) { state.currentMonth = 0;  state.currentYear++; }
  if (state.currentMonth < 0)  { state.currentMonth = 11; state.currentYear--; }
  renderCalendar();
}

// =============================================
//  CHAT UI HELPERS
// =============================================
function addChatUserMessage(text) {
  const el = document.createElement("div");
  el.className = "chat-message user-message";
  el.innerHTML = `<div class="message-bubble">${esc(text)}</div>`;
  appendTo("chat-messages", el);
}

function addChatAIMessage(text, doSpeak=true) {
  const clean = text.replace(/```json[\s\S]*?```/g, "").trim();
  const el = document.createElement("div");
  el.className = "chat-message ai-message";
  el.innerHTML = `<div class="message-bubble">${md(clean)}</div>`;
  appendTo("chat-messages", el);
  if (doSpeak) speak(clean);
}

function addOnboardingUserMessage(text) {
  const el = document.createElement("div");
  el.className = "chat-message user-message";
  el.innerHTML = `<div class="message-bubble">${esc(text)}</div>`;
  appendTo("onboarding-messages", el);
}

function addOnboardingAIMessage(text) {
  const clean = text.replace("[ONBOARDING_COMPLETE]","").trim();
  const el = document.createElement("div");
  el.className = "chat-message ai-message";
  el.innerHTML = `<div class="message-bubble">${md(clean)}</div>`;
  appendTo("onboarding-messages", el);
}

function appendTo(id, el) {
  const c = document.getElementById(id);
  if (!c) return;
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}

function showTypingIn(containerId) {
  const id = "typing-" + Date.now();
  const el = document.createElement("div");
  el.className = "chat-message ai-message";
  el.id = id;
  el.innerHTML = `<div class="message-bubble typing-indicator"><span></span><span></span><span></span></div>`;
  appendTo(containerId, el);
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// Markdown → HTML
function md(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/^####\s(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s(.+)$/gm, "<h4>$1</h4>")
    .replace(/^\*\s(.+)$/gm, "<li>$1</li>")
    .replace(/^-\s(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, " ");
}

function esc(t) {
  return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 110) + "px";
}

function handleChatKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
}

function handleOnboardingKey(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendOnboardingMessage(); }
}

// =============================================
//  SCREEN MANAGEMENT
// =============================================
function showScreen(name) {
  ["welcome","onboarding","calendar","app"].forEach(s => {
    document.getElementById("screen-" + s).classList.toggle("hidden", s !== name);
  });
}

// =============================================
//  RESET
// =============================================
function resetAll() {
  if (!confirm("This will delete all saved data and start fresh. Are you sure?")) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// =============================================
//  INIT
// =============================================
window.addEventListener("load", () => {
  // Trigger voice loading immediately — they load async on Mac
  if (window.speechSynthesis) {
    loadBestVoice();  // try now in case they're already cached
    window.speechSynthesis.getVoices();  // trigger the async load
  }

  // Check for existing session
  const saved = loadState();
  if (saved && state.name1 && state.onboardingDone) {
    // Show welcome screen but with returning user option prominent
    showScreen("welcome");
  } else {
    showScreen("welcome");
  }
});
