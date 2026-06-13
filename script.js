// ═══════════════════════════════════════════
//  HALF-HALF HAPPY — v6 (research-backed rebuild)
//
//  Key improvements from analysis:
//  1. Both-thumbs-up gate on assignment
//  2. Appreciation prompt after task completion
//  3. Cognitive vs physical dual fairness bars
//  4. Cognitive load badges per lane
//  5. Cleaner system prompt using all intake data
//  6. Fallback task list if API unavailable
//  7. Simplified intake (4 steps, not 6+)
//  8. Weekly availability built into board
// ═══════════════════════════════════════════

const API_KEY = "hallo";
const MODEL   = "gemini-2.5-flash";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
const STORE   = "hhh_v6";

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
let S = {
  name1: "", name2: "",
  intake: {
    hometype:"", bedrooms:"", bathrooms:"", pets:"", garden:"",
    dailyHours1:{}, dailyHours2:{},
    totalHoursWeek1:0, totalHoursWeek2:0,
    busy1:[], busy2:[],
    commitments1:"", commitments2:"",
    likes1:[], dislikes1:[], skills1:"",
    likes2:[], dislikes2:[], skills2:"",
    balance:"", balanceNote:"",
    pickedTasks:[]
  },
  intakeDone: false,
  tasks: [],
  chatHistory: [],
  view: "week",
  weeklyAvailability: {},
  weeklyConfirmed: {},
  notificationsEnabled: false,
  appreciations: 0  // total sent
};

// ═══════════════════════════════════════════
//  WEIGHTED ROUND-ROBIN ALGORITHM (EF1-fair)
//
//  Core mechanics:
//  1. Apply balance head-start (person doing
//     less historically starts with lower score)
//  2. Sort tasks heaviest-first
//  3. Assign to lowest weighted total
//  4. Apply preference bias (+/- 15 min nudge)
//  5. Respect monthly hours cap
// ═══════════════════════════════════════════
function assignFairly(taskIds) {
  const BALANCE_PENALTY = 60;

  let total1 = weightedTotal("p1");
  let total2 = weightedTotal("p2");

  // Balance head-start: compensate for historical imbalance
  if (S.intake.balance === "p1") total1 += BALANCE_PENALTY;
  else if (S.intake.balance === "p2") total2 += BALANCE_PENALTY;

  // Monthly cap from exact weekly hours
  const cap1 = (S.intake.totalHoursWeek1 || 5) * 60 * 4;
  const cap2 = (S.intake.totalHoursWeek2 || 5) * 60 * 4;

  // Sort heaviest first
  const sorted = taskIds
    .map(id => S.tasks.find(t => t.id === id))
    .filter(Boolean)
    .sort((a, b) => b.effort - a.effort);

  sorted.forEach(task => {
    const cat = taskCategory(task.name);
    const p1Likes    = (S.intake.likes1    || []).includes(cat);
    const p2Likes    = (S.intake.likes2    || []).includes(cat);
    const p1Dislikes = (S.intake.dislikes1 || []).includes(cat);
    const p2Dislikes = (S.intake.dislikes2 || []).includes(cat);

    let score1 = total1;
    let score2 = total2;
    if (p1Likes)    score1 -= 15;
    if (p2Likes)    score2 -= 15;
    if (p1Dislikes) score1 += 15;
    if (p2Dislikes) score2 += 15;

    // Cap enforcement
    const actualTotal1 = total1 - (S.intake.balance === "p1" ? BALANCE_PENALTY : 0);
    const actualTotal2 = total2 - (S.intake.balance === "p2" ? BALANCE_PENALTY : 0);
    const wouldExceed1 = actualTotal1 + task.effort > cap1;
    const wouldExceed2 = actualTotal2 + task.effort > cap2;

    if (wouldExceed1 && !wouldExceed2) {
      task.assignee = "p2"; total2 += task.effort;
    } else if (wouldExceed2 && !wouldExceed1) {
      task.assignee = "p1"; total1 += task.effort;
    } else if (score1 <= score2) {
      task.assignee = "p1"; total1 += task.effort;
    } else {
      task.assignee = "p2"; total2 += task.effort;
    }
  });

  saveState();
  renderBoard();
  updateFairnessBars();
}

function taskCategory(name) {
  const n = name.toLowerCase();
  if (/cook|dinner|meal|food|lunch|breakfast/.test(n)) return "Cooking";
  if (/clean|bathroom|toilet|wipe|scrub/.test(n)) return "Cleaning";
  if (/grocer|shopping|supermarket/.test(n)) return "Groceries";
  if (/laundry|wash|iron|fold/.test(n)) return "Laundry";
  if (/tidy|hoover|vacuum|floor|dust/.test(n)) return "Tidying";
  if (/bill|admin|bank|insurance|budget|finance/.test(n)) return "Admin";
  if (/garden|plant|mow|weed/.test(n)) return "Garden";
  if (/repair|fix|diy|paint/.test(n)) return "DIY";
  return "";
}

function weightedTotal(person) {
  return S.tasks.filter(t => t.assignee === person && !t.done).reduce((s, t) => s + t.effort, 0);
}

function cognitiveTotal(person) {
  return S.tasks.filter(t => t.assignee === person && !t.done && (t.type === "cognitive" || t.type === "both")).reduce((s, t) => s + t.effort, 0);
}

// ═══════════════════════════════════════════
//  BOTH-THUMBS-UP ASSIGNMENT GATE
//  Both partners confirm before tasks are assigned
// ═══════════════════════════════════════════
let pendingAssignIds = [];
let assignConfirms = { p1: false, p2: false };

function requestAssignAll() {
  const unassigned = S.tasks.filter(t => t.assignee === "none").map(t => t.id);
  if (!unassigned.length) { showToast("No unassigned tasks to assign"); return; }

  // Run algorithm to preview
  pendingAssignIds = unassigned;

  // Temporarily assign to build preview
  const tempTasks = JSON.parse(JSON.stringify(S.tasks));
  assignFairly([...unassigned]);
  const preview = buildAssignmentPreview();

  // Restore original state temporarily
  S.tasks = tempTasks;
  saveState();

  // Show confirmation modal
  document.getElementById("assign-preview").textContent = preview;
  document.getElementById("ac-name1").textContent = S.name1;
  document.getElementById("ac-name2").textContent = S.name2;
  document.getElementById("ac-btn1").classList.remove("confirmed");
  document.getElementById("ac-btn2").classList.remove("confirmed");
  document.getElementById("assign-confirm-status").textContent = "Both partners need to confirm";
  assignConfirms = { p1: false, p2: false };

  document.getElementById("assign-modal").classList.remove("hidden");
}

function buildAssignmentPreview() {
  const t1 = pendingAssignIds.map(id => S.tasks.find(t => t.id === id)).filter(t => t && t.assignee !== "none");
  const for1 = t1.filter(t => t.assignee === "p1").length;
  const for2 = t1.filter(t => t.assignee === "p2").length;
  const m1 = weightedTotal("p1");
  const m2 = weightedTotal("p2");
  return `The algorithm will assign ${for1} tasks to ${S.name1} and ${for2} tasks to ${S.name2}, based on your preferences and availability. After this, ${S.name1} will have ${m1} minutes of tasks and ${S.name2} will have ${m2} minutes.`;
}

function confirmAssignment(person) {
  if (person === 1) {
    assignConfirms.p1 = true;
    document.getElementById("ac-btn1").classList.add("confirmed");
    document.getElementById("ac-btn1").textContent = "✓ Confirmed";
  } else {
    assignConfirms.p2 = true;
    document.getElementById("ac-btn2").classList.add("confirmed");
    document.getElementById("ac-btn2").textContent = "✓ Confirmed";
  }

  if (assignConfirms.p1 && assignConfirms.p2) {
    document.getElementById("assign-confirm-status").textContent = "Both confirmed! Assigning now…";
    setTimeout(() => {
      closeAssignModal();
      assignFairly(pendingAssignIds);
      addAIMessage(
        `Tasks assigned! I used the fairness algorithm — heaviest tasks first, preference bias applied, and ${S.intake.balance === "equal" ? "starting from equal footing" : `giving ${S.intake.balance === "p1" ? S.name2 : S.name1} a head-start to compensate for the existing imbalance`}. Check the fairness bars above to see the split.`,
        true,
        ["How was this divided?", "Who has more cognitive tasks?", "Add more tasks"]
      );
    }, 600);
  } else {
    const waiting = assignConfirms.p1 ? S.name2 : S.name1;
    document.getElementById("assign-confirm-status").textContent = `Waiting for ${waiting}…`;
  }
}

function closeAssignModal(e) {
  if (e && e.target !== document.getElementById("assign-modal")) return;
  document.getElementById("assign-modal").classList.add("hidden");
}

// ═══════════════════════════════════════════
//  APPRECIATION PROMPT
//  Shown when a task is marked done —
//  lets the partner send a quick thank-you
// ═══════════════════════════════════════════
let pendingApprecTask = null;

function triggerAppreciationPrompt(task) {
  // Only show for assigned tasks (not self-appreciation)
  if (task.assignee === "none") return;

  pendingApprecTask = task;
  const doer   = task.assignee === "p1" ? S.name1 : S.name2;
  const other  = task.assignee === "p1" ? S.name2 : S.name1;

  document.getElementById("apprec-title").textContent = `${doer} just finished "${task.name}"`;
  document.getElementById("apprec-sub").textContent =
    `${other}, want to send ${doer} a quick appreciation? Research shows this makes a real difference to how fair your partnership feels.`;

  document.getElementById("apprec-modal").classList.remove("hidden");
}

function sendAppreciation(emoji) {
  if (!pendingApprecTask) return;
  S.appreciations = (S.appreciations || 0) + 1;
  const doer = pendingApprecTask.assignee === "p1" ? S.name1 : S.name2;
  saveState();
  closeApprecModal();
  addAIMessage(`${emoji} Appreciation sent to ${doer}! You've shared ${S.appreciations} appreciation${S.appreciations !== 1 ? "s" : ""} in total. That matters more than you might think.`);
}

function closeApprecModal(e) {
  if (e && e.target !== document.getElementById("apprec-modal")) return;
  document.getElementById("apprec-modal").classList.add("hidden");
  pendingApprecTask = null;
}

// ═══════════════════════════════════════════
//  STORAGE
// ═══════════════════════════════════════════
function saveState() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch(e) {}
}
function loadState() {
  try { const r = localStorage.getItem(STORE); if (!r) return false; S = {...S, ...JSON.parse(r)}; return true; } catch(e) { return false; }
}

// ═══════════════════════════════════════════
//  INTAKE CHIP LOGIC
// ═══════════════════════════════════════════
const chipState = {};
const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const pickedTasks = [];

function selectChip(el, key, val) {
  el.closest(".chip-group").querySelectorAll(".chip").forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
  chipState[key] = val;
}
function toggleChip(el, key, val) {
  el.classList.toggle("selected");
  if (!chipState[key]) chipState[key] = [];
  if (el.classList.contains("selected")) { if (!chipState[key].includes(val)) chipState[key].push(val); }
  else chipState[key] = chipState[key].filter(v => v !== val);
}
function updateAvailSummary() {
  DAYS.forEach(d => ["p1","p2"].forEach(p => {
    const sel = document.getElementById(`avail-${p}-${d}`);
    if (!sel) return;
    const h = parseFloat(sel.value) || 0;
    sel.classList.toggle("has-hours", h > 0);
    sel.classList.toggle("no-hours", h === 0);
  }));
  const t1 = DAYS.reduce((s,d) => s + (parseFloat(document.getElementById(`avail-p1-${d}`)?.value)||0), 0);
  const t2 = DAYS.reduce((s,d) => s + (parseFloat(document.getElementById(`avail-p2-${d}`)?.value)||0), 0);
  const best1 = DAYS.filter(d => (parseFloat(document.getElementById(`avail-p1-${d}`)?.value)||0) >= 2).join(", ") || "no long days";
  const best2 = DAYS.filter(d => (parseFloat(document.getElementById(`avail-p2-${d}`)?.value)||0) >= 2).join(", ") || "no long days";
  const el = document.getElementById("avail-summary");
  if (!el) return;
  el.innerHTML = `<div class="avail-summary-item"><span class="avail-summary-name p1">${S.name1||"Person 1"}</span><span class="avail-summary-hrs">${t1}h/week</span><span class="avail-summary-best">Most free: ${best1}</span></div><div class="avail-summary-item"><span class="avail-summary-name p2">${S.name2||"Person 2"}</span><span class="avail-summary-hrs">${t2}h/week</span><span class="avail-summary-best">Most free: ${best2}</span></div>`;
}
function switchTaskTab(group, btn) {
  document.querySelectorAll(".tp-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  ["daily","weekly","monthly"].forEach(g => {
    const el = document.getElementById("tp-"+g);
    if (el) el.classList.toggle("hidden", g !== group);
  });
}
function toggleTaskPick(btn) {
  btn.classList.toggle("selected");
  const name = btn.dataset.name;
  const t = { name, effort: parseInt(btn.dataset.effort)||30, recur: btn.dataset.recur||"weekly", type: btn.dataset.type||"physical" };
  if (btn.classList.contains("selected")) { if (!pickedTasks.find(x => x.name===name)) pickedTasks.push(t); }
  else { const i = pickedTasks.findIndex(x => x.name===name); if (i>-1) pickedTasks.splice(i,1); }
  const el = document.getElementById("tp-count");
  if (el) el.textContent = pickedTasks.length + " task" + (pickedTasks.length!==1?"s":"") + " selected";
}

// ═══════════════════════════════════════════
//  INTAKE NAVIGATION (4 steps + generating)
// ═══════════════════════════════════════════
const TOTAL_STEPS = 5;
let currentStep = 1;

function goToIntake() {
  const n1 = document.getElementById("inp-name1").value.trim();
  const n2 = document.getElementById("inp-name2").value.trim();
  if (!n1 || !n2) { alert("Please enter both names."); return; }
  S.name1 = n1; S.name2 = n2;
  S.tasks = []; S.chatHistory = [];

  // Set names in intake
  ["avail-name1","prefs-name1"].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=n1; });
  ["avail-name2","prefs-name2"].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=n2; });
  document.getElementById("commit-label1").textContent = `${n1}'s commitments (optional)`;
  document.getElementById("commit-label2").textContent = `${n2}'s commitments (optional)`;
  document.getElementById("balance-p1-chip").textContent = n1 + " does more";
  document.getElementById("balance-p2-chip").textContent = n2 + " does more";

  updateAvailSummary();
  showScreen("intake");
  showIntakeStep(1);
}

function intakeNext() {
  if (currentStep < TOTAL_STEPS - 1) {
    currentStep++;
    showIntakeStep(currentStep);
  } else {
    // Step 4 → generating
    collectIntakeData();
    currentStep = TOTAL_STEPS;
    showIntakeStep(TOTAL_STEPS);
    generateTaskList();
  }
}
function intakeBack() {
  if (currentStep > 1 && currentStep < TOTAL_STEPS) { currentStep--; showIntakeStep(currentStep); }
}

function showIntakeStep(n) {
  document.querySelectorAll(".intake-step").forEach(s => s.classList.remove("active"));
  document.getElementById(`step-${n}`).classList.add("active");
  const realSteps = TOTAL_STEPS - 1;
  const pct = ((Math.min(n,realSteps)-1)/(realSteps-1))*100;
  document.getElementById("intake-progress-fill").style.width = pct + "%";
  document.getElementById("intake-step-label").textContent = n >= TOTAL_STEPS ? "" : `Step ${n} of ${realSteps}`;
  document.getElementById("btn-back").style.visibility = (n > 1 && n < TOTAL_STEPS) ? "visible" : "hidden";
  document.getElementById("btn-next").style.display = n < TOTAL_STEPS ? "block" : "none";
}

function collectIntakeData() {
  const g = id => document.getElementById(id)?.value?.trim() || "";
  const dailyHours1 = {}, dailyHours2 = {};
  DAYS.forEach(d => {
    dailyHours1[d] = parseFloat(document.getElementById(`avail-p1-${d}`)?.value)||0;
    dailyHours2[d] = parseFloat(document.getElementById(`avail-p2-${d}`)?.value)||0;
  });
  const totalHours1 = Object.values(dailyHours1).reduce((s,h)=>s+h,0);
  const totalHours2 = Object.values(dailyHours2).reduce((s,h)=>s+h,0);
  S.intake = {
    ...S.intake,
    hometype: chipState.hometype||"", bedrooms: chipState.bedrooms||"",
    bathrooms: chipState.bathrooms||"", pets: chipState.pets||"", garden: chipState.garden||"",
    dailyHours1, dailyHours2,
    totalHoursWeek1: totalHours1, totalHoursWeek2: totalHours2,
    busy1: DAYS.filter(d => dailyHours1[d]===0),
    busy2: DAYS.filter(d => dailyHours2[d]===0),
    commitments1: g("inp-commitments1"), commitments2: g("inp-commitments2"),
    likes1: chipState.likes1||[], dislikes1: chipState.dislikes1||[], skills1: g("inp-skills1"),
    likes2: chipState.likes2||[], dislikes2: chipState.dislikes2||[], skills2: g("inp-skills2"),
    balance: chipState.balance||"", balanceNote: g("inp-balance-note"),
    pickedTasks: [...pickedTasks]
  };
}

// ═══════════════════════════════════════════
//  TASK GENERATION
// ═══════════════════════════════════════════
async function generateTaskList() {
  const barEl = document.getElementById("gen-bar");
  const titleEl = document.getElementById("gen-title");
  const statusEl = document.getElementById("gen-status");
  const steps = [[15,"Analysing your home…"],[35,"Matching to preferences…"],[60,"Running fairness algorithm…"],[85,"Almost ready…"]];
  let si = 0;
  const tick = setInterval(() => { if(si<steps.length){barEl.style.width=steps[si][0]+"%";statusEl.textContent=steps[si][1];si++;}}, 800);

  try {
    const prompt = buildGenerationPrompt();
    const res = await fetch(API_URL, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ contents:[{role:"user",parts:[{text:prompt}]}], generationConfig:{temperature:0.4,maxOutputTokens:2000} })
    });
    clearInterval(tick); barEl.style.width="100%";
    if (!res.ok) throw new Error((await res.json()).error?.message||"API error");
    const data = await res.json();
    parseAndAddTasks(data.candidates?.[0]?.content?.parts?.[0]?.text||"");
  } catch(e) {
    clearInterval(tick); barEl.style.width="100%";
    // Graceful fallback — use picked tasks + sensible defaults
    useFallbackTasks();
    titleEl.textContent = S.tasks.length > 0 ? "Using your selected tasks" : "Using default tasks";
    statusEl.textContent = "AI generation unavailable. Your selected tasks have been loaded.";
  }

  if (S.tasks.length === 0) useFallbackTasks();

  // Run algorithm on all tasks
  assignFairly(S.tasks.map(t => t.id));

  S.intakeDone = true;
  saveState();

  // Show review screen
  showReviewScreen();
}

function buildGenerationPrompt() {
  const i = S.intake;
  return `You are a household task planner. Generate a realistic monthly task list for this couple.

HOME: ${i.hometype||"apartment"}, ${i.bedrooms||"2"} bed, ${i.bathrooms||"1"} bath, pets: ${i.pets||"none"}, garden: ${i.garden||"no"}

${S.name1}: ${i.totalHoursWeek1||5}h/week, days off: ${(i.busy1||[]).join(",")||"none"}, likes: ${(i.likes1||[]).join(",")||"anything"}, dislikes: ${(i.dislikes1||[]).join(",")||"none"}, skills: ${i.skills1||"not set"}, commitments: ${i.commitments1||"none"}
${S.name2}: ${i.totalHoursWeek2||5}h/week, days off: ${(i.busy2||[]).join(",")||"none"}, likes: ${(i.likes2||[]).join(",")||"anything"}, dislikes: ${(i.dislikes2||[]).join(",")||"none"}, skills: ${i.skills2||"not set"}, commitments: ${i.commitments2||"none"}

They pre-selected these tasks:
${(i.pickedTasks||[]).map(t=>`- ${t.name} (${t.effort}min, ${t.recur}, ${t.type})`).join("\n")||"none pre-selected"}

Include ALL pre-selected tasks. Add appropriate additional tasks for this home. Aim for 12-18 total.

Output ONLY JSON:
\`\`\`json
{"tasks":[{"name":"Cook dinner","effort":30,"recur":"daily","assignee":"none","type":"physical"}]}
\`\`\`
assignee always "none". type: physical/cognitive/both. recur: daily/weekly/monthly/once.`;
}

function useFallbackTasks() {
  const picked = S.intake.pickedTasks || [];
  if (picked.length > 0) {
    picked.forEach(t => S.tasks.push(mkTask(t.name,t.effort,t.recur,"none",t.type)));
  } else {
    [
      {name:"Cook dinner",effort:30,recur:"daily",type:"physical"},
      {name:"Grocery shopping",effort:45,recur:"weekly",type:"physical"},
      {name:"Meal planning",effort:20,recur:"weekly",type:"cognitive"},
      {name:"Clean bathroom",effort:40,recur:"weekly",type:"physical"},
      {name:"Hoover floors",effort:25,recur:"weekly",type:"physical"},
      {name:"Do laundry",effort:20,recur:"weekly",type:"physical"},
      {name:"Fold and put away laundry",effort:20,recur:"weekly",type:"physical"},
      {name:"Take out bins",effort:10,recur:"weekly",type:"physical"},
      {name:"Tidy living room",effort:20,recur:"weekly",type:"physical"},
      {name:"Pay bills",effort:20,recur:"monthly",type:"cognitive"},
      {name:"Review household finances",effort:30,recur:"monthly",type:"cognitive"},
    ].forEach(t => S.tasks.push(mkTask(t.name,t.effort,t.recur,"none",t.type)));
  }
}

// ═══════════════════════════════════════════
//  TASK REVIEW SCREEN
// ═══════════════════════════════════════════
function showReviewScreen() {
  const step5 = document.getElementById("step-5");
  if (!step5) { launchFromReview(); return; }

  const iconEl   = step5.querySelector(".generating-icon");
  const titleEl  = document.getElementById("gen-title");
  const subEl    = document.getElementById("gen-sub");
  const progEl   = step5.querySelector(".gen-progress");
  const statEl   = document.getElementById("gen-status");

  if (iconEl)  { iconEl.textContent="✅"; iconEl.classList.remove("generating-icon"); }
  if (titleEl) titleEl.textContent = "Review your tasks";
  if (subEl)   subEl.textContent   = "These are your starting tasks, fairly divided. Remove anything that doesn't apply, add anything missing.";
  if (progEl)  progEl.style.display="none";
  if (statEl)  statEl.style.display="none";

  let html = `<div class="review-list" id="review-list">`;
  S.tasks.forEach(t => {
    const who = t.assignee==="p1" ? S.name1 : t.assignee==="p2" ? S.name2 : "Unassigned";
    const wc  = t.assignee==="p1" ? "p1" : t.assignee==="p2" ? "p2" : "none";
    html += `<div class="review-item" id="rev-${t.id}">
      <div class="review-item-main">
        <span class="review-task-name">${esc(t.name)}</span>
        <div class="review-meta">
          <span class="review-badge ${t.type}">${t.type}</span>
          <span class="review-badge">${t.effort}min</span>
          <span class="review-badge">${t.recur}</span>
          <span class="review-assignee ${wc}">${who}</span>
        </div>
      </div>
      <button class="review-del" onclick="removeReviewTask('${t.id}')">×</button>
    </div>`;
  });
  html += `</div>
  <div class="review-add-row">
    <input type="text" id="review-add-input" class="text-input small" placeholder="Add a task…" onkeydown="if(event.key==='Enter')addReviewTask()" />
    <button class="ghost-btn small" onclick="addReviewTask()">+ Add</button>
  </div>
  <p class="review-count" id="review-count">${S.tasks.length} tasks</p>`;

  const existing = document.getElementById("review-container");
  if (existing) existing.remove();
  const c = document.createElement("div");
  c.id = "review-container";
  c.innerHTML = html;
  step5.appendChild(c);

  const btnNext = document.getElementById("btn-next");
  if (btnNext) { btnNext.textContent="Start planning →"; btnNext.style.display="block"; btnNext.onclick=launchFromReview; }
  const btnBack = document.getElementById("btn-back");
  if (btnBack) btnBack.style.visibility="hidden";
}

function removeReviewTask(id) {
  S.tasks = S.tasks.filter(t => t.id!==id);
  document.getElementById(`rev-${id}`)?.remove();
  document.getElementById("review-count").textContent = S.tasks.length + " tasks";
}

function addReviewTask() {
  const inp = document.getElementById("review-add-input");
  const name = inp?.value?.trim();
  if (!name) return;
  const task = mkTask(name, 30, "weekly", "none", "physical");
  S.tasks.push(task);
  assignFairly([task.id]);
  inp.value = "";
  const list = document.getElementById("review-list");
  if (list) {
    const div = document.createElement("div");
    div.className = "review-item"; div.id = `rev-${task.id}`;
    const who = task.assignee==="p1"?S.name1:task.assignee==="p2"?S.name2:"Unassigned";
    const wc  = task.assignee==="p1"?"p1":task.assignee==="p2"?"p2":"none";
    div.innerHTML = `<div class="review-item-main"><span class="review-task-name">${esc(task.name)}</span><div class="review-meta"><span class="review-badge physical">physical</span><span class="review-badge">30min</span><span class="review-assignee ${wc}">${who}</span></div></div><button class="review-del" onclick="removeReviewTask('${task.id}')">×</button>`;
    list.appendChild(div);
  }
  document.getElementById("review-count").textContent = S.tasks.length + " tasks";
}

function launchFromReview() {
  assignFairly(S.tasks.map(t => t.id));
  saveState();
  launch();
  addAIMessage(
    `Welcome, ${S.name1} and ${S.name2}! 🎉 Your plan is ready — **${S.tasks.length} tasks** divided fairly using preferences, schedules, and ${S.intake.balance==="equal"?"an equal starting point":S.intake.balance==="p1"?`a head-start for ${S.name2} to rebalance`:`a head-start for ${S.name1} to rebalance`}.\n\nCheck the fairness bars up top — they show both time balance and cognitive load. The mental load bar is especially important.\n\nYou can chat with me to swap tasks, add new ones, or ask anything.`,
    true,
    ["Why is it divided this way?", "Who has more mental load?", "How does the algorithm work?"]
  );
}

// ═══════════════════════════════════════════
//  DEMO + LOAD SESSION
// ═══════════════════════════════════════════
function tryDemo() {
  S.name1="Anna"; S.name2="Quinten";
  S.intake = {
    hometype:"apartment", bedrooms:"2", bathrooms:"1", pets:"cat", garden:"balcony",
    dailyHours1:{Mon:1,Tue:0,Wed:2,Thu:0,Fri:1,Sat:3,Sun:2},
    dailyHours2:{Mon:0,Wed:2,Wed:0,Thu:2,Fri:2,Sat:1,Sun:3},
    totalHoursWeek1:9, totalHoursWeek2:10,
    busy1:["Tue","Thu"], busy2:["Mon"],
    commitments1:"yoga Tuesday evenings", commitments2:"works late Mondays",
    likes1:["Cooking","Tidying"], dislikes1:["Groceries"],
    likes2:["Groceries","Admin"], dislikes2:["Cooking"],
    skills1:"fast cleaner", skills2:"good at admin and budget",
    balance:"p1", balanceNote:"Anna has been doing most of the cooking and cleaning for months",
    pickedTasks:[]
  };
  S.tasks = [
    mkTask("Cook dinner",30,"daily","none","physical"),
    mkTask("Grocery shopping",45,"weekly","none","physical"),
    mkTask("Meal planning",20,"weekly","none","cognitive"),
    mkTask("Clean bathroom",40,"weekly","none","physical"),
    mkTask("Hoover floors",25,"weekly","none","physical"),
    mkTask("Do laundry",20,"weekly","none","physical"),
    mkTask("Fold and put away laundry",20,"weekly","none","physical"),
    mkTask("Take out bins",10,"weekly","none","physical"),
    mkTask("Tidy living room",20,"weekly","none","both"),
    mkTask("Pay bills",20,"monthly","none","cognitive"),
    mkTask("Review household finances",30,"monthly","none","cognitive"),
    mkTask("Book vet appointment for cat",15,"monthly","none","cognitive"),
    mkTask("Clean toilet",15,"weekly","none","physical"),
    mkTask("Wipe kitchen surfaces",10,"weekly","none","physical"),
  ];
  S.chatHistory=[]; S.intakeDone=true;
  assignFairly(S.tasks.map(t=>t.id));
  saveState();
  launch();
  addAIMessage(
    `Welcome back, ${S.name1} and ${S.name2}! This is the demo. I've loaded your household profile — ${S.name1} has been doing more, so the algorithm gave ${S.name2} a head-start to rebalance.\n\nCheck both fairness bars: the top one shows time, the bottom one shows **cognitive/mental load** — that's the one that often hides the real imbalance.`,
    true,
    ["Who has more mental load?", "How was this divided?", "Show me an example swap"]
  );
}

function loadSession() {
  if (!loadState() || !S.name1) { alert("No saved session. Please start fresh."); return; }
  if (S.intakeDone) launch();
  else { showScreen("intake"); showIntakeStep(currentStep); }
}

// ═══════════════════════════════════════════
//  LAUNCH
// ═══════════════════════════════════════════
function launch() {
  showScreen("app");
  document.getElementById("fb-name1").textContent   = S.name1;
  document.getElementById("fb-name2").textContent   = S.name2;
  document.getElementById("lane-name1").textContent = S.name1;
  document.getElementById("lane-name2").textContent = S.name2;
  document.getElementById("ab-p1").textContent      = S.name1;
  document.getElementById("ab-p2").textContent      = S.name2;
  document.getElementById("wb-name1").textContent   = S.name1;
  document.getElementById("wb-name2").textContent   = S.name2;
  document.getElementById("export-p1-label").textContent = `Export ${S.name1}'s tasks (.ics)`;
  document.getElementById("export-p2-label").textContent = `Export ${S.name2}'s tasks (.ics)`;
  renderBoard();
  updateFairnessBars();
  checkWeeklyBanner();
  updateNotifButton();
  if (S.chatHistory.length > 0) {
    S.chatHistory.forEach(m => {
      if (m.role==="model") addAIMessage(m.parts[0].text, false);
      else addUserMsg(m.parts[0].text);
    });
  }
}

// ═══════════════════════════════════════════
//  TASK OPERATIONS
// ═══════════════════════════════════════════
function mkTask(name,effort,recur,assignee,type) {
  return { id:"t"+Date.now()+Math.random().toString(36).slice(2,6), name, effort, recur, assignee, type, done:false, createdAt:Date.now() };
}

function toggleDone(id) {
  const t = S.tasks.find(t=>t.id===id);
  if (!t) return;
  const wasUndone = !t.done;
  t.done = !t.done;
  saveState(); renderBoard(); updateFairnessBars();
  // Show appreciation prompt when marking done (not undone)
  if (wasUndone && t.done) {
    setTimeout(() => triggerAppreciationPrompt(t), 400);
  }
}

function deleteTask(id) {
  S.tasks = S.tasks.filter(t=>t.id!==id);
  saveState(); renderBoard(); updateFairnessBars();
}

function setView(v) {
  S.view=v;
  document.getElementById("tab-week").classList.toggle("active",v==="week");
  document.getElementById("tab-month").classList.toggle("active",v==="month");
  renderBoard();
}

// ═══════════════════════════════════════════
//  RENDER BOARD
// ═══════════════════════════════════════════
function renderBoard() {
  const filter = t => S.view==="week" ? ["daily","weekly","once"].includes(t.recur) : true;
  renderLane("tasks-p1",         S.tasks.filter(t=>t.assignee==="p1"&&filter(t)));
  renderLane("tasks-p2",         S.tasks.filter(t=>t.assignee==="p2"&&filter(t)));
  renderLane("tasks-unassigned", S.tasks.filter(t=>t.assignee==="none"&&filter(t)));

  const m1=weightedTotal("p1"), m2=weightedTotal("p2");
  const c1=cognitiveTotal("p1"), c2=cognitiveTotal("p2");
  document.getElementById("lane-score1").textContent = m1+"min";
  document.getElementById("lane-score2").textContent = m2+"min";
  document.getElementById("lane-cog1").textContent   = c1 ? `🧠 ${c1}min` : "";
  document.getElementById("lane-cog2").textContent   = c2 ? `🧠 ${c2}min` : "";
}

function renderLane(id, tasks) {
  const el=document.getElementById(id);
  if (!tasks.length){el.innerHTML="";return;}
  el.innerHTML=tasks.map(taskCardHTML).join("");
  el.querySelectorAll(".task-check").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();toggleDone(b.dataset.id);}));
  el.querySelectorAll(".task-del").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();deleteTask(b.dataset.id);}));
  el.querySelectorAll(".task-card").forEach(c=>c.addEventListener("click",()=>editTask(c.dataset.id)));
}

function taskCardHTML(t) {
  const tc = t.type==="cognitive"?"cog":t.type==="physical"?"phys":"both";
  return `<div class="task-card${t.done?" done":""}" data-id="${t.id}">
    <div class="task-check" data-id="${t.id}"></div>
    <div class="task-body">
      <div class="task-name">${esc(t.name)}</div>
      <div class="task-meta">
        <span class="task-badge ${tc}">${t.type}</span>
        <span class="task-badge">${t.recur}</span>
      </div>
      <div class="task-effort">${t.effort} min</div>
    </div>
    <button class="task-del" data-id="${t.id}">×</button>
  </div>`;
}

// ═══════════════════════════════════════════
//  DUAL FAIRNESS BARS (time + cognitive)
// ═══════════════════════════════════════════
function updateFairnessBars() {
  const m1=weightedTotal("p1"), m2=weightedTotal("p2");
  const c1=cognitiveTotal("p1"), c2=cognitiveTotal("p2");

  const totalM=m1+m2, totalC=c1+c2;
  const pctM = totalM===0?50:Math.round((m1/totalM)*100);
  const pctC = totalC===0?50:Math.round((c1/totalC)*100);

  document.getElementById("fairness-fill").style.width  = pctM+"%";
  document.getElementById("cognitive-fill").style.width = pctC+"%";
}

// ═══════════════════════════════════════════
//  MODAL: ADD / EDIT TASK
// ═══════════════════════════════════════════
let editingId=null, modalAssignee="none", modalType="physical";
function showAddTask() {
  editingId=null;
  document.getElementById("modal-title").textContent="Add task";
  document.getElementById("m-task-name").value="";
  document.getElementById("m-effort").value=30;
  document.getElementById("m-recur").value="weekly";
  setAssignee("none"); setType("physical");
  document.getElementById("modal-overlay").classList.remove("hidden");
  setTimeout(()=>document.getElementById("m-task-name").focus(),50);
}
function editTask(id) {
  const t=S.tasks.find(t=>t.id===id); if(!t) return;
  editingId=id;
  document.getElementById("modal-title").textContent="Edit task";
  document.getElementById("m-task-name").value=t.name;
  document.getElementById("m-effort").value=t.effort;
  document.getElementById("m-recur").value=t.recur;
  setAssignee(t.assignee); setType(t.type);
  document.getElementById("modal-overlay").classList.remove("hidden");
}
function setAssignee(v) { modalAssignee=v; ["p1","p2","none"].forEach(k=>document.getElementById("ab-"+k).classList.toggle("active",k===v)); }
function setType(v) { modalType=v; ["physical","cognitive","both"].forEach(k=>document.getElementById("tb-"+k).classList.toggle("active",k===v)); }
function saveTask() {
  const name=document.getElementById("m-task-name").value.trim(); if(!name) return;
  const effort=parseInt(document.getElementById("m-effort").value)||30;
  const recur=document.getElementById("m-recur").value;
  if (editingId) { const t=S.tasks.find(t=>t.id===editingId); if(t) Object.assign(t,{name,effort,recur,assignee:modalAssignee,type:modalType}); }
  else { S.tasks.push(mkTask(name,effort,recur,modalAssignee,modalType)); }
  saveState(); renderBoard(); updateFairnessBars(); hideModal();
}
function hideModal() { document.getElementById("modal-overlay").classList.add("hidden"); editingId=null; }
function closeModal(e) { if(e.target===document.getElementById("modal-overlay")) hideModal(); }

// ═══════════════════════════════════════════
//  WEEKLY AVAILABILITY BANNER
// ═══════════════════════════════════════════
function getISOWeek(date) {
  const d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));
  const dn=d.getUTCDay()||7; d.setUTCDate(d.getUTCDate()+4-dn);
  const ys=new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d-ys)/86400000)+1)/7);
}
function getCurrentWeekKey() {
  const now=new Date();
  return `${now.getFullYear()}-W${String(getISOWeek(now)).padStart(2,"0")}`;
}
function getWeekDateRange() {
  const now=new Date(), day=now.getDay()||7;
  const mon=new Date(now); mon.setDate(now.getDate()-day+1);
  const sun=new Date(mon); sun.setDate(mon.getDate()+6);
  const fmt=d=>d.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
  return `${fmt(mon)} – ${fmt(sun)}`;
}
function checkWeeklyBanner() {
  const wk=getCurrentWeekKey();
  if (!S.weeklyConfirmed?.[wk]) showWeeklyBanner(wk);
}
function showWeeklyBanner(wk) {
  const banner=document.getElementById("weekly-banner"); if(!banner) return;
  document.getElementById("wb-week-label").textContent=getWeekDateRange();
  const dayToNum={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:0};
  const busy1=(S.intake.busy1||[]).map(d=>dayToNum[d]);
  const busy2=(S.intake.busy2||[]).map(d=>dayToNum[d]);
  const prev=S.weeklyAvailability?.[wk];
  document.querySelectorAll(".wb-day[data-person='1']").forEach(btn=>{
    const dn=dayToNum[btn.dataset.day];
    const isFree=prev?.p1?.includes(btn.dataset.day)??!busy1.includes(dn);
    btn.classList.toggle("free",isFree);
  });
  document.querySelectorAll(".wb-day[data-person='2']").forEach(btn=>{
    const dn=dayToNum[btn.dataset.day];
    const isFree=prev?.p2?.includes(btn.dataset.day)??!busy2.includes(dn);
    btn.classList.toggle("free",isFree);
  });
  banner.classList.remove("hidden");
}
function toggleWbDay(btn) {
  btn.classList.toggle("free");
  btn.classList.toggle("busy",!btn.classList.contains("free"));
}
function confirmWeeklyAvailability() {
  const wk=getCurrentWeekKey();
  const free1=[],free2=[];
  document.querySelectorAll(".wb-day[data-person='1'].free").forEach(b=>free1.push(b.dataset.day));
  document.querySelectorAll(".wb-day[data-person='2'].free").forEach(b=>free2.push(b.dataset.day));
  if (!S.weeklyAvailability) S.weeklyAvailability={};
  if (!S.weeklyConfirmed) S.weeklyConfirmed={};
  S.weeklyAvailability[wk]={p1:free1,p2:free2};
  S.weeklyConfirmed[wk]=true;
  saveState();
  document.getElementById("weekly-banner").classList.add("hidden");
  const s1=free1.length?free1.join(", "):"no free days";
  const s2=free2.length?free2.join(", "):"no free days";
  addAIMessage(`Week confirmed (${getWeekDateRange()}). ${S.name1} is free: ${s1}. ${S.name2} is free: ${s2}. I'll factor this in when you ask me to schedule tasks.`);
  showToast("✓ Availability saved for this week");
}
function getWeeklyAvailabilityForPrompt() {
  const wk=getCurrentWeekKey(), data=S.weeklyAvailability?.[wk];
  if (!data) return "Not set for this week — using intake defaults.";
  return `Week of ${getWeekDateRange()}: ${S.name1} free on ${data.p1?.join(",")||"none"}. ${S.name2} free on ${data.p2?.join(",")||"none"}.`;
}

// ═══════════════════════════════════════════
//  CHAT — SYSTEM PROMPT
//  Full context: everything known is included
// ═══════════════════════════════════════════
function buildSystemPrompt() {
  const i=S.intake;
  const m1=weightedTotal("p1"), m2=weightedTotal("p2");
  const c1=cognitiveTotal("p1"), c2=cognitiveTotal("p2");
  const diff=m1-m2;
  const balanceStatus=Math.abs(diff)<10?"balanced":diff>0?`${S.name1} has ${diff}min more (overloaded)`:` ${S.name2} has ${Math.abs(diff)}min more (overloaded)`;
  const cogStatus=Math.abs(c1-c2)<10?"cognitive load balanced":c1>c2?`${S.name1} has ${c1-c2}min more COGNITIVE load — this is the hidden mental load`:` ${S.name2} has ${c2-c1}min more COGNITIVE load`;

  const taskList=S.tasks.length
    ? S.tasks.map(t=>`  - ${t.name} | ${t.effort}min | ${t.recur} | ${t.type} | ${t.assignee==="p1"?S.name1:t.assignee==="p2"?S.name2:"unassigned"}${t.done?" [done]":""}`).join("\n")
    : "  No tasks yet.";

  const histNote = i.balance==="p1"?`${S.name1} has been doing more (${i.balanceNote||"no details"}). Algorithm compensated.`
    :i.balance==="p2"?`${S.name2} has been doing more (${i.balanceNote||"no details"}). Algorithm compensated.`
    :"Roughly equal historically.";

  return `You are Half-Half Happy — a warm, honest, and practical household task planner.
You know ${S.name1} and ${S.name2} very well. Here is your full briefing:

🏠 HOME: ${i.hometype||"apartment"}, ${i.bedrooms||"2"} bed, ${i.bathrooms||"1"} bath, pets: ${i.pets||"none"}, garden: ${i.garden||"no"}

👤 ${S.name1.toUpperCase()}:
  Available: ${i.totalHoursWeek1||"?"}h/week | Daily: ${i.dailyHours1?Object.entries(i.dailyHours1).map(([d,h])=>`${d}:${h}h`).join(", "):"not set"}
  Commitments: ${i.commitments1||"none"}
  Likes: ${(i.likes1||[]).join(", ")||"not specified"} | Dislikes: ${(i.dislikes1||[]).join(", ")||"none"}
  Skills: ${i.skills1||"not set"}

👤 ${S.name2.toUpperCase()}:
  Available: ${i.totalHoursWeek2||"?"}h/week | Daily: ${i.dailyHours2?Object.entries(i.dailyHours2).map(([d,h])=>`${d}:${h}h`).join(", "):"not set"}
  Commitments: ${i.commitments2||"none"}
  Likes: ${(i.likes2||[]).join(", ")||"not specified"} | Dislikes: ${(i.dislikes2||[]).join(", ")||"none"}
  Skills: ${i.skills2||"not set"}

⚖️ HISTORICAL BALANCE: ${histNote}

📅 THIS WEEK: ${getWeeklyAvailabilityForPrompt()}

📊 CURRENT LOAD:
  Time: ${S.name1}=${m1}min | ${S.name2}=${m2}min | ${balanceStatus}
  Cognitive: ${S.name1}=${c1}min | ${S.name2}=${c2}min | ${cogStatus}
  Appreciations sent this session: ${S.appreciations||0}

📋 TASK LIST:
${taskList}

RULES:
- Warm, specific, use real names. NEVER get cut off — always finish your sentence.
- Keep replies to 3-5 sentences max, then offer 2-3 quick reply buttons.
- Algorithm explanation: EF1 weighted round-robin, ±15min preference bias, hours cap, balance head-start.
- Cognitive load: mention Daminger 2019 when relevant. It shows women carry 67% more cognitive tasks.
- If balance drifts >30min, flag it proactively.
- Appreciations buffer unfairness (Gordon et al. 2022) — mention this occasionally.
- When swapping/adding tasks, output JSON and confirm what changed.

JSON format for task changes:
{"tasks":[{"name":"...","effort":30,"recur":"weekly","assignee":"none","type":"physical"}]}
p1=${S.name1}, p2=${S.name2}, none=unassigned. Types: physical/cognitive/both. Recur: daily/weekly/monthly/once.`;
}

// ═══════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════
async function sendMessage() {
  const input=document.getElementById("chat-input");
  const text=input.value.trim(); if(!text) return;
  input.value=""; input.style.height="auto";
  addUserMsg(text);
  S.chatHistory.push({role:"user",parts:[{text}]});
  document.getElementById("send-btn").disabled=true;
  const tid=showTyping("chat-feed");
  const reply=await callGemini();
  removeTyping(tid);
  document.getElementById("send-btn").disabled=false;
  if (reply) {
    parseAndAddTasks(reply);
    const clean=reply.replace(/```json[\s\S]*?```/g,"").replace(/`{3}[\s\S]*?`{3}/g,"").trim();
    addAIMessage(clean);
    S.chatHistory.push({role:"model",parts:[{text:reply}]});
    saveState();
  }
}

async function callGemini() {
  try {
    // Keep only the last 20 messages to prevent context overflow
    // This stops the chat from getting too long and causing truncation
    const history = S.chatHistory.slice(-20);

    const body={
      system_instruction:{parts:[{text:buildSystemPrompt()}]},
      contents: history,
      generationConfig:{
        temperature: 0.7,
        maxOutputTokens: 2500  // increased from 1200 — was causing cut-off responses
      }
    };
    const res=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if(!res.ok) throw new Error((await res.json()).error?.message||`Error ${res.status}`);
    const data=await res.json();
    // Check if response was cut off (finish_reason === MAX_TOKENS)
    const finishReason = data.candidates?.[0]?.finishReason;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text||"";
    if (finishReason === "MAX_TOKENS" && text) {
      return text + "…";
    }
    return text;
  } catch(e) { addAIMessage("Something went wrong: "+e.message); return null; }
}

function sendQuickReply(text) {
  document.getElementById("chat-input").value=text;
  sendMessage();
}

function parseAndAddTasks(text) {
  const m=text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return;
  try {
    const data=JSON.parse(m[1]);
    if (!data.tasks?.length) return;
    const newIds=[];
    data.tasks.forEach(t=>{
      const task=mkTask(t.name||"Task",parseInt(t.effort)||30,t.recur||"weekly",t.assignee||"none",t.type||"physical");
      S.tasks.push(task); newIds.push(task.id);
    });
    assignFairly(newIds);
  } catch(e) {}
}

// ═══════════════════════════════════════════
//  EXPORT + NOTIFICATIONS
// ═══════════════════════════════════════════
function toggleExportMenu() {
  const menu=document.getElementById("export-menu");
  const isHidden=menu.classList.contains("hidden");
  if (isHidden) {
    menu.classList.remove("hidden");
    setTimeout(()=>document.addEventListener("click",closeExportOnClick,{once:true}),50);
  } else { menu.classList.add("hidden"); }
}
function closeExportOnClick() { document.getElementById("export-menu")?.classList.add("hidden"); }

function exportICS(person) {
  const pName=person==="p1"?S.name1:S.name2;
  const tasks=S.tasks.filter(t=>t.assignee===person);
  if (!tasks.length) { showToast(`${pName} has no assigned tasks`); return; }
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Half-Half Happy//EN","CALSCALE:GREGORIAN","X-WR-CALNAME:Half-Half Happy — "+pName+"'s Tasks"];
  tasks.forEach(t=>{
    const date=new Date(); const ds=`${date.getFullYear()}${String(date.getMonth()+1).padStart(2,"0")}${String(date.getDate()).padStart(2,"0")}`;
    const rrule=t.recur==="daily"?"RRULE:FREQ=DAILY":t.recur==="weekly"?"RRULE:FREQ=WEEKLY":t.recur==="monthly"?"RRULE:FREQ=MONTHLY":null;
    lines.push("BEGIN:VEVENT",`UID:${t.id}@halfhalfhappy`,`DTSTAMP:${ds}T000000Z`,`DTSTART;VALUE=DATE:${ds}`,`DTEND;VALUE=DATE:${ds}`,`SUMMARY:${t.name}`,`DESCRIPTION:${t.effort}min | ${t.type}\\nHalf-Half Happy`);
    if (rrule) lines.push(rrule);
    lines.push("END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  const blob=new Blob([lines.join("\r\n")],{type:"text/calendar"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`hhh-${pName.toLowerCase()}.ics`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
  document.getElementById("export-menu").classList.add("hidden");
  showToast(`✓ Downloaded ${pName}'s calendar file`);
}

let notifScheduled=false;
function setupNotifications() {
  document.getElementById("export-menu").classList.add("hidden");
  if (!("Notification" in window)) { showToast("Notifications not supported in this browser"); return; }
  if (Notification.permission==="granted"&&notifScheduled) { showToast("Reminders already enabled"); return; }
  Notification.requestPermission().then(p=>{
    if (p==="granted") {
      notifScheduled=true; S.notificationsEnabled=true; saveState(); updateNotifButton();
      sendWeeklyNotification();
      showToast("✓ Weekly reminders enabled — every Monday morning");
    } else { showToast("Notifications blocked — check browser settings"); }
  });
}
function sendWeeklyNotification() {
  if (Notification.permission!=="granted") return;
  const m1=weightedTotal("p1"),m2=weightedTotal("p2"),c1=cognitiveTotal("p1"),c2=cognitiveTotal("p2");
  const n=new Notification("Half-Half Happy — Weekly check-in",{
    body:`${S.name1}: ${m1}min (${c1}min cognitive) · ${S.name2}: ${m2}min (${c2}min cognitive)\n${Math.abs(m1-m2)>30?"⚠️ Imbalance detected":"✓ Looking balanced"}`,
    tag:"hhh-weekly"
  });
  n.onclick=()=>{window.focus();n.close();};
}
function updateNotifButton() {
  const lbl=document.getElementById("notif-label");
  if (lbl) lbl.textContent=S.notificationsEnabled&&Notification.permission==="granted"?"🔔 Reminders on (Mondays)":"Enable weekly reminders";
}

// ═══════════════════════════════════════════
//  SPEECH (input only — TTS removed)
// ═══════════════════════════════════════════
let recognition=null;
function toggleMic() {
  if (recognition){recognition.stop();recognition=null;document.getElementById("mic-btn").classList.remove("listening");return;}
  if (!("webkitSpeechRecognition" in window)&&!("SpeechRecognition" in window)){alert("Speech recognition requires Chrome.");return;}
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  recognition=new SR(); recognition.lang="en-GB"; recognition.continuous=false; recognition.interimResults=false;
  document.getElementById("mic-btn").classList.add("listening");
  recognition.onresult=e=>{const t=e.results[0][0].transcript;const inp=document.getElementById("chat-input");inp.value=(inp.value+" "+t).trim();autoResize(inp);};
  recognition.onend=()=>{recognition=null;document.getElementById("mic-btn").classList.remove("listening");sendMessage();};
  recognition.onerror=()=>{recognition=null;document.getElementById("mic-btn").classList.remove("listening");};
  recognition.start();
}

// ═══════════════════════════════════════════
//  CHAT UI HELPERS
// ═══════════════════════════════════════════
function addUserMsg(text) {
  const el=mkDiv("msg user"); el.innerHTML=`<div class="bubble">${esc(text)}</div>`; appendTo("chat-feed",el);
}
function addAIMessage(text,scroll=true,qr=[]) {
  const clean=text.replace(/```json[\s\S]*?```/g,"").replace(/`{3}[\s\S]*?`{3}/g,"").trim();
  const el=mkDiv("msg ai");
  let html=`<div class="bubble">${md(clean)}`;
  if (qr.length) html+=`<div class="quick-replies">`+qr.map(q=>`<button class="qr-btn" onclick="sendQuickReply('${q}')">${q}</button>`).join("")+`</div>`;
  html+=`</div>`; el.innerHTML=html; appendTo("chat-feed",el,scroll);
}
function showTyping(feedId) {
  const id="typ"+Date.now(); const el=mkDiv("msg ai"); el.id=id;
  el.innerHTML=`<div class="bubble typing"><span></span><span></span><span></span></div>`;
  appendTo(feedId,el); return id;
}
function removeTyping(id){const el=document.getElementById(id);if(el)el.remove();}
function appendTo(id,el,scroll=true){const f=document.getElementById(id);if(!f)return;f.appendChild(el);if(scroll)f.scrollTop=f.scrollHeight;}
function mkDiv(cls){const el=document.createElement("div");el.className=cls;return el;}
function md(t){return t.replace(/\*\*(.*?)\*\*/g,"<strong>$1</strong>").replace(/^\*\s(.+)$/gm,"<li>$1</li>").replace(/^-\s(.+)$/gm,"<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>\n?)+/g,m=>`<ul>${m}</ul>`).replace(/\n\n/g,"<br/><br/>").replace(/\n/g," ");}
function esc(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function autoResize(el){el.style.height="auto";el.style.height=Math.min(el.scrollHeight,110)+"px";}
function handleKey(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}}

// ═══════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════
let toastTimer=null;
function showToast(msg) {
  let t=document.getElementById("hhh-toast");
  if (!t){t=document.createElement("div");t.id="hhh-toast";t.className="notif-toast";document.body.appendChild(t);}
  t.textContent=msg; t.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove("show"),4000);
}

// ═══════════════════════════════════════════
//  SCREEN + RESET
// ═══════════════════════════════════════════
function showScreen(name) {
  ["welcome","intake","app"].forEach(s=>{
    const el=document.getElementById("screen-"+s);
    if(el){el.classList.remove("active");el.style.display="none";}
  });
  const t=document.getElementById("screen-"+name);
  if(t){t.style.display="flex";t.classList.add("active");}
}
function resetAll() {
  if (!confirm("Delete all data and start over?")) return;
  localStorage.removeItem(STORE); location.reload();
}

window.addEventListener("load",()=>{
  document.getElementById("screen-intake").style.display="none";
  document.getElementById("screen-app").style.display="none";
});
