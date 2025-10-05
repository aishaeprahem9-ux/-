// DoBucks SPA
// Tables (from provided prompt)
const BASEROW_API = "https://api.baserow.io/api/database/rows";
const TABLES = {
  users: 692997,
  progress: 693348,
  referrals: 693464,
  limits: 693433,
  withdrawals: 693458,
  support: 693480
};

// WARNING: In production, do not ship tokens to client. Provided by user for this demo.
const API_TOKEN = "yiLf7FjjfI0xxwocyQgpYL77ASbuXSeI";

// Points rules
const POINTS_PER_TWO_LEVELS = 10; // => 5 per level
const POINTS_PER_LEVEL = POINTS_PER_TWO_LEVELS / 2; // 5
const DAILY_BASE_CAP = 80; // can boost to 100
const DAILY_MAX_ADS = 10;
const MAX_REFERRALS_PER_DAY = 5;
const BOOST_ADS_REQUIRED = 5;

const WITHDRAW_MIN_POINTS = 1200;
const WITHDRAW_METHODS = ["Vodafone Cash", "Payeer", "Binance"];
const WITHDRAW_FEE = 2; // sample

const TODAY = new Date().toISOString().split("T")[0];

// State
let currentUser = null; // { id, username, balance, Status, HasWithdrawnBefore, Referral code, Blocked on }
let session = { pointsToday: 0, adsToday: 0, cap: DAILY_BASE_CAP, boostUnlocked: false };
let gameState = { name: null, level: 1, timer: null, timeLeft: 15, ringCirc: 0 };

// Elements
const $ = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));

// Auth UI tabs
$$('.tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    $$('.tab').forEach(b=>b.classList.remove('active'));
    $$('.tab-content').forEach(c=>c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// Online banner
function refreshOnlineBanner(){
  const online = navigator.onLine;
  const banner = $('#online-required');
  banner.style.opacity = online ? '1' : '1';
  banner.textContent = online ? '⚠️ التطبيق يتطلب اتصال بالإنترنت' : '🚫 لا يوجد اتصال بالإنترنت';
  document.body.classList.toggle('offline', !online);
}
window.addEventListener('online', refreshOnlineBanner);
window.addEventListener('offline', refreshOnlineBanner);
refreshOnlineBanner();

// Helpers
function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }
function toHex(buffer){
  return Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function sha256(text){
  const enc = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return toHex(hash);
}

async function api(path, { method='GET', body }={}){
  if (!navigator.onLine) throw new Error('offline');
  const res = await fetch(`${BASEROW_API}/${path}`, {
    method,
    headers: {
      'Authorization': `Token ${API_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>res.statusText);
    throw new Error(`API ${method} ${path} failed: ${res.status} ${t}`);
  }
  return res.json();
}

async function listAll(tableId){
  let url = `table/${tableId}/?user_field_names=true`;
  let out = [];
  while (url) {
    if (!navigator.onLine) throw new Error('offline');
    const res = await fetch(`${BASEROW_API}/${url}`, { headers: { 'Authorization': `Token ${API_TOKEN}` } });
    if (!res.ok) throw new Error('listAll failed');
    const data = await res.json();
    out = out.concat(data.results || []);
    url = data.next ? data.next.replace(`${BASEROW_API}/`, '') : null;
  }
  return out;
}

function todayStr(){ return TODAY; }

// Limits and tracking
async function trackAction(userId, action, count=1){
  return api(`table/${TABLES.limits}/?user_field_names=true`, {
    method: 'POST',
    body: { User: userId, Action: action, Date: todayStr(), Count: count }
  });
}

async function getTodayUsage(userId){
  const all = await listAll(TABLES.limits);
  const today = all.filter(r=>r.User === userId && r.Date === todayStr());
  const sum = (name)=> today.filter(r=>r.Action === name).reduce((s,r)=> s + (r.Count || 0), 0);
  return {
    levelPlayed: sum('LevelPlayed'),
    adWatched: sum('AdWatched'),
    referral: sum('Referral')
  };
}

async function computePointsToday(userId){
  const all = await listAll(TABLES.progress);
  const today = all.filter(r=>r.User === userId && r.Date === todayStr());
  // some schemas may not have Date; fallback by ignoring
  const points = today.length ? today.reduce((s,r)=> s + (r['Points Earned'] || 0), 0)
                              : all.filter(r=>r.User === userId).reduce((s,r)=> s + (r['Points Earned'] || 0), 0);
  return points;
}

// Auth
$('#login-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  try {
    const email = $('#login-email').value.trim().toLowerCase();
    const pass = $('#login-password').value;
    const passHash = await sha256(pass);
    const users = await listAll(TABLES.users);
    const user = users.find(u=> u.username === email && u.password === passHash);
    if (!user) throw new Error('❌ بيانات الدخول غير صحيحة');
    currentUser = user;
    await postLoginChecks();
    await enterDashboard();
  } catch(err){
    toast(err.message || 'فشل تسجيل الدخول');
  }
});

$('#register-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  try {
    const name = $('#reg-name').value.trim();
    const email = $('#reg-email').value.trim().toLowerCase();
    const pass = $('#reg-password').value;
    const phone = $('#reg-phone').value.trim();
    const referralInput = $('#reg-referral').value.trim();
    const passHash = await sha256(pass);

    const users = await listAll(TABLES.users);
    if (users.some(u=>u.username === email)) throw new Error('الحساب موجود بالفعل');

    // create user
    let newUser = await api(`table/${TABLES.users}/?user_field_names=true`, {
      method: 'POST',
      body: {
        username: email,
        password: passHash,
        balance: 0,
        Status: 'Active',
        HasWithdrawnBefore: false
      }
    });

    // generate referral code
    const existingCodes = users.map(u=>u['Referral code']).filter(Boolean);
    let code;
    do {
      code = `DOB-${newUser.id}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    } while (existingCodes.includes(code));
    await api(`table/${TABLES.users}/${newUser.id}/?user_field_names=true`, { method:'PATCH', body:{ 'Referral code': code } });

    // optional referral apply
    if (referralInput) {
      const referrer = users.find(u=>u['Referral code'] === referralInput);
      if (referrer) {
        const today = todayStr();
        await api(`table/${TABLES.referrals}/?user_field_names=true`, { method:'POST', body:{
          Referrer: referrer.id, Referred: newUser.id, 'Referral code': referralInput, 'Registered on': today
        }});
        // track referral for referrer
        await trackAction(referrer.id, 'Referral', 1);
        // cap max per day
        const usage = await getTodayUsage(referrer.id);
        if (usage.referral <= MAX_REFERRALS_PER_DAY) {
          await api(`table/${TABLES.users}/${referrer.id}/?user_field_names=true`, { method:'PATCH', body:{ balance: (referrer.balance||0) + 5 } });
        }
      }
    }

    // login user
    currentUser = await api(`table/${TABLES.users}/${newUser.id}/?user_field_names=true`);
    await postLoginChecks();
    await enterDashboard();
  } catch(err){
    toast(err.message || 'تعذر إنشاء الحساب');
  }
});

async function postLoginChecks(){
  // auto-unblock after 24h
  if (currentUser.Status === 'Blocked' && currentUser['Blocked on']) {
    const blockedDate = new Date(currentUser['Blocked on']);
    const hours = (Date.now() - blockedDate.getTime()) / 36e5;
    if (hours >= 24) {
      await api(`table/${TABLES.users}/${currentUser.id}/?user_field_names=true`, { method:'PATCH', body:{ Status:'Active', 'Blocked on': null } });
      currentUser.Status = 'Active';
      currentUser['Blocked on'] = null;
    }
  }

  // refresh usage and adjust caps
  const usage = await getTodayUsage(currentUser.id);
  session.adsToday = usage.adWatched;
  session.boostUnlocked = session.adsToday >= BOOST_ADS_REQUIRED;
  session.cap = session.boostUnlocked ? 100 : DAILY_BASE_CAP;
  session.pointsToday = await computePointsToday(currentUser.id);

  // block if abuse
  if (usage.referral > MAX_REFERRALS_PER_DAY || usage.adWatched > DAILY_MAX_ADS) {
    await api(`table/${TABLES.users}/${currentUser.id}/?user_field_names=true`, { method:'PATCH', body:{ Status:'Blocked', 'Blocked on': todayStr() } });
    currentUser.Status = 'Blocked';
  }
}

async function enterDashboard(){
  if (currentUser.Status !== 'Active') {
    toast('تم حظر الحساب مؤقتًا. حاول لاحقًا');
  }
  $('#auth-section').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  $('#admin-panel-card').classList.toggle('hidden', currentUser.username !== 'dobucksapp@gmail.com');
  await refreshUser();
}

async function refreshUser(){
  // fetch latest
  currentUser = await api(`table/${TABLES.users}/${currentUser.id}/?user_field_names=true`);
  $('#balance').textContent = currentUser.balance || 0;
  $('#points-today').textContent = session.pointsToday;
  $('#daily-cap').textContent = session.cap;
  $('#ads-today').textContent = session.adsToday;
  $('#referral-code').value = currentUser['Referral code'] || '';
  $('#withdraw-btn').disabled = !canWithdraw();
  updateAdsCtaVisibility();
}

$('#copy-ref').addEventListener('click', ()=>{
  const code = $('#referral-code').value;
  navigator.clipboard.writeText(code).then(()=> toast('تم النسخ')).catch(()=>{});
});

function updateAdsCtaVisibility(){
  const used = !!localStorage.getItem(`ads-cta-${todayStr()}`);
  const btn = $('#watch-ads-btn');
  if (btn) btn.classList.toggle('hidden', used);
}

$('#watch-ads-btn').addEventListener('click', async ()=>{
  // Only once per day
  if (localStorage.getItem(`ads-cta-${todayStr()}`)) { return; }
  localStorage.setItem(`ads-cta-${todayStr()}`, '1');
  updateAdsCtaVisibility();
  // require 10 seconds watch
  await showAdModal(10);
  session.adsToday += 1;
  if (!session.boostUnlocked && session.adsToday >= BOOST_ADS_REQUIRED) {
    session.boostUnlocked = true; session.cap = 100;
  }
  $('#ads-today').textContent = session.adsToday;
  $('#daily-cap').textContent = session.cap;
});

$('#withdraw-btn').addEventListener('click', ()=>{
  openModal('طلب سحب', renderWithdrawForm());
});

function canWithdraw(){
  const balance = currentUser.balance || 0;
  const first = !(currentUser.HasWithdrawnBefore || false);
  const referralsAllPromise = listAll(TABLES.referrals); // lazy
  // We'll assume caller awaits refreshUser before read
  return balance >= WITHDRAW_MIN_POINTS && (!first || (first && window.__referralsCountForUser__ >= 3));
}

function renderWithdrawForm(){
  const container = document.createElement('div');
  container.innerHTML = `
    <label>طريقة السحب
      <select id="wd-method">
        ${WITHDRAW_METHODS.map(m=>`<option>${m}</option>`).join('')}
      </select>
    </label>
    <label>المبلغ
      <input id="wd-amount" type="number" min="10" step="1" value="20" />
    </label>
    <div class="note">الحد الأدنى للسحب: ${WITHDRAW_MIN_POINTS} نقطة. رسوم الخدمة: ${WITHDRAW_FEE} نقطة.</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn" id="wd-cancel">إلغاء</button>
      <button class="btn accent" id="wd-confirm">تأكيد</button>
    </div>
  `;
  container.querySelector('#wd-cancel').addEventListener('click', closeModal);
  container.querySelector('#wd-confirm').addEventListener('click', async ()=>{
    const method = container.querySelector('#wd-method').value;
    const amount = Number(container.querySelector('#wd-amount').value || 0);
    const totalDeducted = amount + WITHDRAW_FEE;
    const balance = currentUser.balance || 0;

    // eligibility
    const referralsAll = await listAll(TABLES.referrals);
    const referralsDone = referralsAll.filter(r=>r.Referrer === currentUser.id).length;
    const first = !(currentUser.HasWithdrawnBefore || false);
    const eligible = first ? (balance >= WITHDRAW_MIN_POINTS && referralsDone >= 3)
                           : (balance >= WITHDRAW_MIN_POINTS);

    if (!eligible || balance < totalDeducted) {
      // log support ticket
      await api(`table/${TABLES.support}/?user_field_names=true`, { method:'POST', body:{
        User: currentUser.id,
        Message: `فشل السحب: الشروط غير مكتملة أو الرصيد (${balance}) أقل من المطلوب (${totalDeducted})`,
        'Sent on': todayStr(), Status: 'Open'
      }});
      toast('الشروط غير مكتملة أو الرصيد غير كافٍ');
      return;
    }

    // create withdrawal
    await api(`table/${TABLES.withdrawals}/?user_field_names=true`, { method:'POST', body:{
      User: currentUser.id, Amount: amount, Method: method, Status: 'Pending', 'Requested on': todayStr()
    }});
    await api(`table/${TABLES.users}/${currentUser.id}/?user_field_names=true`, { method:'PATCH', body:{
      balance: balance - totalDeducted, HasWithdrawnBefore: true
    }});
    closeModal();
    await refreshUser();
    toast('تم إرسال طلب السحب. التنفيذ خلال 3 أيام عمل');
  });
  return container;
}

// Modal helpers
function openModal(title, content){
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.textContent = '';
  if (content instanceof Node) body.appendChild(content); else body.innerHTML = content;
  $('#modal').classList.remove('hidden');
}
function closeModal(){ $('#modal').classList.add('hidden'); }
$('#modal-close').addEventListener('click', closeModal);

function toast(msg){
  const div = document.createElement('div');
  div.textContent = msg;
  div.style.position='fixed'; div.style.bottom='16px'; div.style.left='50%'; div.style.transform='translateX(-50%)';
  div.style.background='#111'; div.style.color='#fff'; div.style.padding='10px 14px'; div.style.borderRadius='12px';
  div.style.zIndex='9999';
  document.body.appendChild(div);
  setTimeout(()=> div.remove(), 2500);
}

// Admin
$('#open-admin').addEventListener('click', async ()=>{
  $('#dashboard').classList.add('hidden');
  $('#admin-section').classList.remove('hidden');
  await renderAdmin();
});
$('#close-admin').addEventListener('click', ()=>{
  $('#admin-section').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
});

async function renderAdmin(){
  const users = await listAll(TABLES.users);
  const withdrawals = await listAll(TABLES.withdrawals);
  const div = $('#admin-data');
  div.innerHTML = '';
  const usersCount = document.createElement('div');
  usersCount.textContent = `المستخدمون: ${users.length} | السحوبات: ${withdrawals.length}`;
  div.appendChild(usersCount);

  const list = document.createElement('div');
  list.style.display='grid'; list.style.gap='6px';
  users.forEach(u=>{
    const row = document.createElement('div');
    row.style.display='grid'; row.style.gridTemplateColumns='1fr auto auto'; row.style.alignItems='center';
    row.style.border='1px solid #eee'; row.style.borderRadius='8px'; row.style.padding='6px 8px';
    const left = document.createElement('div');
    left.textContent = `${u.username} | رصيد: ${u.balance||0} | حالة: ${u.Status||'—'}`;
    const blockBtn = document.createElement('button'); blockBtn.className='btn small'; blockBtn.textContent = (u.Status==='Blocked'?'فك الحظر':'حظر');
    blockBtn.onclick = async ()=>{
      if (u.Status==='Blocked') {
        await api(`table/${TABLES.users}/${u.id}/?user_field_names=true`, { method:'PATCH', body:{ Status:'Active', 'Blocked on': null } });
      } else {
        await api(`table/${TABLES.users}/${u.id}/?user_field_names=true`, { method:'PATCH', body:{ Status:'Blocked', 'Blocked on': todayStr() } });
      }
      await renderAdmin();
    };
    const delBtn = document.createElement('button'); delBtn.className='btn small'; delBtn.textContent='تعليق';
    delBtn.onclick = async ()=>{
      await api(`table/${TABLES.users}/${u.id}/?user_field_names=true`, { method:'PATCH', body:{ Status:'Suspended' } });
      await renderAdmin();
    };
    row.append(left, blockBtn, delBtn);
    list.appendChild(row);
  });
  div.appendChild(list);

  $('#export-users').onclick = ()=> exportCSV('users.csv', users);
  $('#export-withdrawals').onclick = ()=> exportCSV('withdrawals.csv', withdrawals);
}

function exportCSV(filename, rows){
  if (!rows || !rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v)=>`"${String(v??'').replace(/"/g,'""')}"`;
  const csv = [headers.join(','), ...rows.map(r=> headers.map(h=>escape(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 5000);
}

// Contact link
$('#contact-link').addEventListener('click', (e)=>{
  e.preventDefault();
  const el = document.createElement('div');
  el.innerHTML = `
    <p>سنقوم بإرسال رسالتك إلى البريد: <strong>dobucksapp@gmail.com</strong></p>
    <label>الرسالة<input id="support-msg" placeholder="اكتب رسالتك" /></label>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
      <button class="btn" id="support-cancel">إلغاء</button>
      <button class="btn primary" id="support-send">إرسال</button>
    </div>
  `;
  el.querySelector('#support-cancel').onclick = closeModal;
  el.querySelector('#support-send').onclick = async ()=>{
    const msg = el.querySelector('#support-msg').value.trim();
    if (!currentUser) return toast('سجّل الدخول أولًا');
    await api(`table/${TABLES.support}/?user_field_names=true`, { method:'POST', body:{
      User: currentUser.id, Message: msg, 'Sent on': todayStr(), Status: 'Open'
    }});
    closeModal(); toast('تم إرسال الرسالة');
  };
  openModal('اتصل بنا', el);
});

// Ad modal
const AD_URL = 'https://viijujyl.com/dc/?blockID=391150&tb=https%3A%2F%2Fexample.com%2F&subID=base44appv1&ref=Do+bucks';
async function showAdModal(requiredSeconds){
  return new Promise(async (resolve)=>{
    const modal = $('#ad-modal');
    modal.classList.remove('hidden');
    const iframe = $('#ad-iframe');
    const doneBtn = $('#ad-done');
    const fallback = modal.querySelector('.ad-fallback');
    const openLink = $('#ad-open'); openLink.href = AD_URL;

    let sec = requiredSeconds;
    doneBtn.disabled = true; doneBtn.textContent = `متابعة (${sec})`;
    const tick = setInterval(()=>{
      sec -= 1; doneBtn.textContent = `متابعة (${sec})`;
      if (sec <= 0) { clearInterval(tick); doneBtn.disabled = false; doneBtn.textContent = 'متابعة'; }
    }, 1000);

    try {
      iframe.src = AD_URL;
      let loaded = false;
      iframe.onload = ()=>{ loaded = true; };
      setTimeout(()=>{ if (!loaded) { fallback.classList.remove('hidden'); } }, 2500);
    } catch{
      fallback.classList.remove('hidden');
    }

    doneBtn.onclick = async ()=>{
      modal.classList.add('hidden');
      iframe.src = 'about:blank';
      await trackAction(currentUser.id, 'AdWatched', 1);
      resolve();
    };
  });
}

// Games engine
const ring = document.querySelector('.progress-ring__circle');
const radius = 45; const circumference = 2 * Math.PI * radius;
ring.style.strokeDasharray = `${circumference} ${circumference}`;
function setRingProgress(p){ // p in [0,1]
  const offset = circumference * (1 - p);
  ring.style.strokeDashoffset = String(offset);
}

async function startLevel(gameName){
  gameState.name = gameName;
  gameState.timeLeft = 15;
  $('#dashboard').classList.add('hidden');
  $('#game-runner').classList.remove('hidden');
  $('#game-title').textContent = labelForGame(gameName);
  $('#game-content').innerHTML = '';
  $('#game-feedback').textContent = '';
  $('#timer-text').textContent = gameState.timeLeft;
  setRingProgress(1);
  renderGameUI(gameName);
  runTimer();
}

function endLevelWin(){
  clearInterval(gameState.timer);
  // after each level, show ad then award points
  showAdModal(5).then(async ()=>{
    const granted = await awardPoints(POINTS_PER_LEVEL);
    $('#game-feedback').textContent = granted>0 ? `+${granted} نقاط` : 'تم بلوغ حد اليوم';
    setTimeout(()=> nextLevel(), 600);
  });
}

function endLevelLose(){
  clearInterval(gameState.timer);
  $('#game-feedback').textContent = '❌ إجابة خاطئة أو انتهى الوقت';
  showAdModal(5).then(()=>{
    setTimeout(()=> nextLevel(), 600);
  });
}

function nextLevel(){
  $('#game-runner').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  refreshUser();
}

function runTimer(){
  clearInterval(gameState.timer);
  const total = 15; let left = total;
  setRingProgress(1);
  $('#timer-text').textContent = left;
  gameState.timer = setInterval(()=>{
    left -= 1; const p = left/total; setRingProgress(p); $('#timer-text').textContent = left;
    if (left <= 0) { clearInterval(gameState.timer); endLevelLose(); }
  }, 1000);
}

function labelForGame(id){
  return {
    'riddles':'ألغاز نصية',
    'guess-number':'تخمين الرقم',
    'math-ops':'تحدي العمليات الحسابية',
    'reverse-words':'عكس الكلمات',
    'sequence':'تسلسل منطقي',
    'quick-sum':'الجمع السريع',
    'reverse-translate':'الترجمة العكسية',
  }[id] || id;
}

// UI to launch games
$$('.game-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> startLevel(btn.dataset.game));
});
$('#back-to-dashboard').addEventListener('click', ()=>{
  clearInterval(gameState.timer); nextLevel();
});

// Rendering per game
function renderGameUI(id){
  const host = $('#game-content');
  const container = document.createElement('div'); container.className='card';
  let input, submit;
  const setQ = (q)=>{ container.innerHTML = `<div style="margin-bottom:8px">${q}</div>`; container.appendChild(input); container.appendChild(submit); };

  if (id === 'guess-number'){
    const secret = Math.floor(Math.random()*90)+10; // 10..99
    input = document.createElement('input'); input.type='number'; input.placeholder='خمن رقمًا 10-99';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    setQ('خمن الرقم الصحيح بين 10 و 99');
    submit.onclick = ()=>{ Number(input.value)===secret ? endLevelWin() : endLevelLose(); };
  }
  else if (id === 'reverse-words'){
    const words = ['دو باكس','تحدي','نجاح','ذكاء','مستقبل','تقنية'];
    const pick = words[Math.floor(Math.random()*words.length)];
    input = document.createElement('input'); input.placeholder='اكتب الكلمة معكوسة';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    setQ(`اعكس الكلمة: ${pick}`);
    submit.onclick = ()=>{ input.value.trim() === [...pick].reverse().join('') ? endLevelWin() : endLevelLose(); };
  }
  else if (id === 'math-ops'){
    const a = Math.floor(Math.random()*20)+1;
    const b = Math.floor(Math.random()*20)+1;
    const ops = ['+','-','*'];
    const op = ops[Math.floor(Math.random()*ops.length)];
    const ans = op==='+'?a+b:op==='-'?a-b:a*b;
    input = document.createElement('input'); input.type='number'; input.placeholder='الإجابة';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    setQ(`احسب: ${a} ${op} ${b}`);
    submit.onclick = ()=>{ Number(input.value)===ans ? endLevelWin() : endLevelLose(); };
  }
  else if (id === 'quick-sum'){
    const arr = Array.from({length:6},()=> Math.floor(Math.random()*15)+1);
    const sum = arr.reduce((s,v)=>s+v,0);
    input = document.createElement('input'); input.type='number'; input.placeholder='المجموع';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    setQ(`اجمع سريعًا: ${arr.join(' + ')}`);
    submit.onclick = ()=>{ Number(input.value)===sum ? endLevelWin() : endLevelLose(); };
  }
  else if (id === 'sequence'){
    const start = Math.floor(Math.random()*5)+1; const step = Math.floor(Math.random()*5)+1; const arr=[start,start+step,start+2*step];
    const next = start+3*step;
    input = document.createElement('input'); input.type='number'; input.placeholder='العدد التالي';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    setQ(`أكمل التسلسل: ${arr.join(', ')} , ?`);
    submit.onclick = ()=>{ Number(input.value)===next ? endLevelWin() : endLevelLose(); };
  }
  else if (id === 'reverse-translate'){
    const dict = [
      ['book','كتاب'], ['apple','تفاحة'], ['sun','شمس'], ['water','ماء'], ['cat','قط'], ['moon','قمر']
    ];
    const [en, ar] = dict[Math.floor(Math.random()*dict.length)];
    input = document.createElement('input'); input.placeholder='اكتب الترجمة بالعربية';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    setQ(`ترجم الكلمة إلى العربية: ${en}`);
    submit.onclick = ()=>{ input.value.trim()===ar ? endLevelWin() : endLevelLose(); };
  }
  else if (id === 'riddles'){
    // pull from questions.json if available
    input = document.createElement('input'); input.placeholder='الإجابة';
    submit = document.createElement('button'); submit.className='btn primary'; submit.textContent='تحقق';
    (async ()=>{
      try {
        const res = await fetch('questions.json', { cache:'no-store' });
        const qs = await res.json();
        const q = qs[Math.floor(Math.random()*qs.length)];
        setQ(q.question);
        submit.onclick = ()=>{ input.value.trim()===q.answer ? endLevelWin() : endLevelLose(); };
      } catch{
        setQ('ما هو الشيء الذي كلما أخذت منه كبر؟');
        submit.onclick = ()=>{ input.value.trim()==='الحفرة' ? endLevelWin() : endLevelLose(); };
      }
    })();
  }

  host.appendChild(container);
}

async function awardPoints(points){
  // compute remaining cap
  const capLeft = Math.max(0, session.cap - session.pointsToday);
  const grant = Math.min(capLeft, points);
  if (grant > 0){
    // record progress
    await api(`table/${TABLES.progress}/?user_field_names=true`, { method:'POST', body:{
      User: currentUser.id, 'Game name': labelForGame(gameState.name), 'Current level': 1, 'Points Earned': grant, Date: todayStr()
    }});
    await api(`table/${TABLES.users}/${currentUser.id}/?user_field_names=true`, { method:'PATCH', body:{ balance: (currentUser.balance||0) + grant } });
    session.pointsToday += grant;
    currentUser.balance = (currentUser.balance||0) + grant;
  }
  await trackAction(currentUser.id, 'LevelPlayed', 1);
  return grant;
}

// Preload referrals count for withdraw eligibility check
(async function preloadReferrals(){
  try {
    const all = await listAll(TABLES.referrals);
    window.__referralsCountForUser__ = 0;
    $('#withdraw-btn').disabled = true;
    const int = setInterval(()=>{
      if (currentUser) {
        window.__referralsCountForUser__ = all.filter(r=>r.Referrer === currentUser.id).length;
        $('#withdraw-btn').disabled = !canWithdraw();
        clearInterval(int);
      }
    }, 300);
  } catch{}
})();
