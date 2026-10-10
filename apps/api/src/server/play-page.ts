export const playPageHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#172421">
  <title>回声档案 · 试炼 01</title>
  <style>
    :root{color-scheme:light;--ink:#182522;--muted:#67716b;--paper:#eee9dd;--chalk:#faf8f2;--line:#d6d0c3;--moss:#35584d;--moss-light:#dbe5d9;--ember:#b5503b;--gold:#b08b48;--shadow:0 18px 50px #17242112}
    *{box-sizing:border-box}body{margin:0;background-color:var(--paper);background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' opacity='.08' filter='url(%23n)'/%3E%3C/svg%3E");color:var(--ink);font:15px/1.5 'Trebuchet MS','Segoe UI',sans-serif}
    button,input,select{font:inherit}button{cursor:pointer}.masthead{height:72px;padding:0 clamp(18px,4vw,56px);display:flex;align-items:center;justify-content:space-between;background:var(--ink);color:#f5f0e5;border-bottom:3px solid var(--gold)}.brand{display:flex;align-items:center;gap:13px}.seal{width:34px;height:34px;border:1px solid #ccb77f;display:grid;place-items:center;color:#d9c58e;font:18px Georgia,serif;transform:rotate(45deg)}.seal span{transform:rotate(-45deg)}.brand-name{font:19px Georgia,serif;letter-spacing:.02em}.brand-sub{margin-left:8px;color:#acb7ad;font:10px/1.2 monospace;letter-spacing:.12em}.mast-right{font:11px monospace;color:#d7c79f;letter-spacing:.12em}.layout{max-width:1240px;margin:0 auto;padding:34px 24px 54px}.eyebrow{font:11px monospace;text-transform:uppercase;letter-spacing:.16em;color:var(--ember)}h1,h2,h3,p{margin-top:0}h1,h2{font-family:Georgia,'Times New Roman',serif;font-weight:400}h1{font-size:clamp(32px,4vw,48px);line-height:1.06;margin:10px 0 10px}h2{font-size:27px;margin-bottom:8px}h3{font-size:15px;margin-bottom:8px}.lede{color:var(--muted);max-width:58ch;margin:0}.rule{height:1px;background:var(--line);margin:23px 0}.auth-wrap{max-width:980px;margin:4vh auto 0;display:grid;grid-template-columns:1.15fr .85fr;min-height:460px;background:var(--chalk);box-shadow:var(--shadow);border:1px solid var(--line)}.auth-art{position:relative;overflow:hidden;background:#20352f;color:#eee9dd;padding:42px;display:flex;flex-direction:column;justify-content:space-between}.auth-art h1{font-size:48px;max-width:8ch}.auth-art p{color:#c7d0c5;max-width:34ch}.map-art{width:min(100%,420px);margin:auto}.map-art path{fill:none;stroke:#c2ac76;stroke-width:1.5;stroke-dasharray:4 7}.map-art rect{fill:#30463e;stroke:#a5a77f;stroke-width:1}.map-art circle{fill:#b5503b;stroke:#eee9dd;stroke-width:2}.map-art text{fill:#f1eadc;font:10px monospace;letter-spacing:1px}.auth-form{padding:42px;align-self:center}.field{display:grid;gap:6px;margin:0 0 16px}.field label{font-size:12px;color:var(--muted)}input,select{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--line);background:#fffefa;color:var(--ink);border-radius:2px}input:focus,select:focus{outline:2px solid #75907b;outline-offset:1px}.button{min-height:42px;border:1px solid var(--ink);padding:9px 15px;background:var(--ink);color:white;border-radius:2px;font-weight:600}.button:hover{background:#2b4039}.button:disabled{cursor:wait;opacity:.55}.button.secondary{background:transparent;color:var(--ink)}.button.secondary:hover{background:var(--moss-light)}.button.ember{background:var(--ember);border-color:var(--ember)}.button-row{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.text-button{border:0;background:none;padding:8px 0;color:var(--moss);text-decoration:underline;text-underline-offset:3px}.notice{min-height:22px;margin:12px 0 0;color:var(--ember);font-size:13px}.shell{display:grid;grid-template-columns:260px minmax(0,1fr);gap:25px;align-items:start}.rail,.surface{background:var(--chalk);border:1px solid var(--line);box-shadow:var(--shadow)}.rail{padding:20px;position:sticky;top:18px}.rail-label{font:10px monospace;letter-spacing:.14em;color:var(--muted)}.identity{font:20px Georgia,serif;margin:5px 0 4px}.release{font:11px monospace;color:var(--muted);overflow-wrap:anywhere}.rail .rule{margin:17px 0}.rail .field{margin-bottom:12px}.main-column{min-width:0}.page-heading{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:21px}.phase-stamp{border:1px solid var(--gold);padding:8px 11px;color:#775d2e;font:11px monospace;white-space:nowrap}.surface{padding:clamp(18px,3vw,30px);margin-bottom:17px}.surface-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.room-id{font:12px monospace;word-break:break-all;color:var(--moss)}.participant-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:20px 0}.participant{min-height:74px;padding:12px;border:1px solid var(--line);background:#f4f0e7}.participant.self{border-color:var(--moss);background:var(--moss-light)}.participant small{display:block;color:var(--muted);font:10px monospace}.participant strong{display:block;margin-top:5px;font-weight:500;overflow-wrap:anywhere}.timer{font:22px Georgia,serif;color:var(--ember)}.play-grid{display:grid;grid-template-columns:minmax(0,1fr) 245px;gap:17px}.sites{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:17px 0}.site{min-height:93px;text-align:left;border:1px solid var(--line);background:#f4f0e7;padding:13px;color:var(--ink)}.site:hover:not(:disabled){border-color:var(--moss);background:var(--moss-light)}.site:disabled{opacity:.48;cursor:not-allowed}.site-number{font:10px monospace;color:var(--ember);display:block;margin-bottom:9px}.candidate{border:1px solid var(--line);background:#f4f0e7;padding:15px;min-height:75px}.candidate b{font:21px Georgia,serif}.candidate small{display:block;color:var(--muted);margin-top:3px}.evidence-list{display:grid;gap:9px}.evidence{padding:13px 15px;border-left:3px solid var(--gold);background:#f4f0e7}.evidence-meta{display:block;margin-bottom:5px;font:10px monospace;color:var(--muted)}.evidence p{margin:0;font:17px/1.45 Georgia,serif}.vote-buttons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0}.vote{min-height:72px;border:1px solid var(--line);background:#f4f0e7;color:var(--ink);font:17px Georgia,serif}.vote:hover{border-color:var(--moss);background:var(--moss-light)}.state-note{padding:14px 16px;background:#e9e4d8;border-left:3px solid var(--gold);color:#4c554e}.hidden{display:none!important}.footer-note{font:11px monospace;color:var(--muted);margin-top:24px}.busy{opacity:.6;pointer-events:none}
    @media(max-width:800px){.layout{padding:22px 14px 40px}.shell{grid-template-columns:1fr}.rail{position:static}.auth-wrap{grid-template-columns:1fr}.auth-art{min-height:280px;padding:27px}.auth-art h1{font-size:38px}.map-art{max-height:150px}.auth-form{padding:28px}.play-grid{grid-template-columns:1fr}.page-heading{align-items:start;flex-direction:column}.participant-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:460px){.masthead{height:62px;padding:0 14px}.brand-name{font-size:16px}.brand-sub{display:none}.mast-right{font-size:9px}.sites{grid-template-columns:1fr}.site{min-height:58px}.vote-buttons{grid-template-columns:1fr}.phase-stamp{white-space:normal}.surface{padding:17px}}
  </style>
  <style>
    .result-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;margin:18px 0;background:var(--line);border:1px solid var(--line)}
    .result-cell{min-width:0;padding:12px;background:var(--chalk)}
    .result-label{display:block;color:var(--muted);font:11px monospace}
    .result-value{display:block;margin-top:4px;font:20px Georgia,serif;overflow-wrap:anywhere}
    .result-explanation{margin:14px 0 0;padding-left:12px;border-left:2px solid var(--moss);color:var(--muted)}
  </style>
</head>
<body>
  <header class="masthead">
    <div class="brand"><div class="seal" aria-hidden="true"><span>回</span></div><div><span class="brand-name">回声档案</span><span class="brand-sub">TRIAL 01 / THE MARK</span></div></div>
    <div class="mast-right">FIELD OFFICE · 01</div>
  </header>
  <main class="layout">
    <section id="auth-screen" class="auth-wrap hidden">
      <div class="auth-art">
        <div><div class="eyebrow" style="color:#d4bd82">封存档案 · 第 01 号</div><h1>有效印记，<br>还是旧闻？</h1><p>四位调查员进入同一场试炼，各自查阅线索，再提交判断。</p></div>
        <svg class="map-art" viewBox="0 0 420 185" role="img" aria-label="三处调查地点的档案地图">
          <path d="M72 113 190 54 333 111M72 113 216 150 333 111"/><rect x="40" y="82" width="66" height="60"/><rect x="178" y="24" width="66" height="60"/><rect x="300" y="81" width="66" height="60"/><circle cx="72" cy="112" r="7"/><circle cx="210" cy="54" r="7"/><circle cx="333" cy="111" r="7"/><text x="52" y="166">SITE 01</text><text x="190" y="105">SITE 02</text><text x="312" y="165">SITE 03</text>
        </svg>
        <div class="brand-sub">TRIAL 1 · FOUR INVESTIGATORS · ONE DECISION</div>
      </div>
      <div class="auth-form">
        <div class="eyebrow">玩家档案</div><h2 id="auth-title">进入档案室</h2>
        <form id="auth-form">
          <label class="field"><span>用户名</span><input id="username" name="username" autocomplete="username" minlength="3" maxlength="32" required></label>
          <label class="field"><span>密码</span><input id="password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></label>
          <div class="button-row"><button class="button" id="auth-submit" type="submit">登录</button><button class="text-button" id="auth-toggle" type="button">创建新档案</button></div>
        </form>
        <p class="notice" id="auth-notice" role="status"></p>
      </div>
    </section>

    <section id="profile-screen" class="hidden">
      <div class="page-heading"><div><div class="eyebrow">调查员登记</div><h1>建立你的档案</h1><p class="lede">这组身份将用于本次试炼。</p></div><span class="phase-stamp">FIELD RECORD · NEW</span></div>
      <section class="surface">
        <form id="profile-form">
          <div class="field"><label for="display-name">调查员姓名</label><input id="display-name" name="displayName" minlength="2" maxlength="20" required></div>
          <div class="play-grid">
            <label class="field">阵营<select id="faction"><option value="faction_1">第一阵营</option><option value="faction_2">第二阵营</option><option value="faction_3">第三阵营</option><option value="faction_4">第四阵营</option><option value="faction_5">第五阵营</option><option value="faction_6">第六阵营</option></select></label>
            <label class="field">存在<select id="power"><option value="power_1">守序</option><option value="power_2">游离</option></select></label>
            <label class="field">职业<select id="profession"><option value="profession_1">记录员</option><option value="profession_2">观察者</option><option value="profession_3">译读者</option><option value="profession_4">巡查员</option><option value="profession_5">档案师</option><option value="profession_6">联络员</option></select></label>
          </div>
          <button class="button" id="profile-submit" type="submit">登记并继续</button>
        </form>
        <p class="notice" id="profile-notice" role="status"></p>
      </section>
    </section>

    <section id="game-screen" class="hidden">
      <div class="shell">
        <aside class="rail">
          <div class="rail-label">当前调查员</div><div class="identity" id="player-name"></div><div class="release" id="release-id"></div>
          <div class="rule"></div>
          <div class="rail-label">加入试炼</div>
          <form id="join-form"><label class="field"><span>房间编号</span><input id="join-room-id" autocomplete="off" spellcheck="false" placeholder="粘贴邀请编号" required></label><button class="button secondary" type="submit">进入房间</button></form>
          <div class="rule"></div><button class="text-button" id="logout-button" type="button">退出档案室</button>
        </aside>
        <div class="main-column">
          <div class="page-heading"><div><div class="eyebrow">试炼 01 · 有效印记</div><h1>现场记录</h1><p class="lede">核对线索，判断本轮有效印记对应的候选。</p></div><span class="phase-stamp" id="phase-stamp">等待建立房间</span></div>
          <section id="lobby-surface" class="surface">
            <div class="surface-head"><div><div class="eyebrow">新建调查</div><h2>召集四位调查员</h2></div><span class="phase-stamp">4 SEATS</span></div>
            <p class="lede">建房后分享房间编号。四人到齐，试炼自动开始。</p>
            <div class="rule"></div><button class="button ember" id="create-room" type="button">建立试炼房间</button>
            <p class="notice" id="lobby-notice" role="status"></p>
          </section>
          <section id="room-surface" class="surface hidden">
            <div class="surface-head"><div><div class="eyebrow">调查房间</div><h2 id="room-title">等待调查员</h2><div class="room-id" id="room-code"></div></div><div class="timer" id="room-timer"></div></div>
            <div class="participant-list" id="participants"></div>
            <section id="waiting-state" class="state-note hidden">房间等待四位调查员确认加入。</section>
            <section id="exploring-state" class="hidden">
              <div class="play-grid"><div><h3>选择调查地点 <span class="eyebrow" id="actions-used"></span></h3><p class="lede">最多查阅两处。卡片只对你本人开放。</p><div class="sites"><button class="site" data-site="site_1"><span class="site-number">SITE 01</span>登记处</button><button class="site" data-site="site_2"><span class="site-number">SITE 02</span>印记库</button><button class="site" data-site="site_3"><span class="site-number">SITE 03</span>街头传闻</button></div></div><div><h3>你的证据卡</h3><div class="evidence-list" id="evidence-list"></div></div></div>
            </section>
            <section id="voting-state" class="hidden">
              <div class="eyebrow">提交判断</div><h2>哪个编号符合有效印记？</h2><div class="vote-buttons"><button class="vote" data-choice="choice_1"><b>K1</b><small>第一候选</small></button><button class="vote" data-choice="choice_2"><b>K2</b><small>第二候选</small></button><button class="vote" data-choice="abstain">弃权</button></div><p class="lede" id="vote-current"></p>
            </section>
            <section id="settling-state" class="state-note hidden">本轮行动已截止，结算正在处理中。</section>
            <section id="failed-state" class="state-note hidden">结算遇到问题，房间仍被保留以等待恢复。</section>
            <section id="completed-state" class="state-note hidden">
              <div class="eyebrow">裁决公开</div><h3>本轮结案</h3>
              <div id="result-details" class="hidden">
                <div class="result-grid">
                  <div class="result-cell"><span class="result-label">最终选择</span><strong id="result-selected" class="result-value"></strong></div>
                  <div class="result-cell"><span class="result-label">正确答案</span><strong id="result-correct" class="result-value"></strong></div>
                  <div class="result-cell"><span class="result-label">K1 票数</span><strong id="result-choice1" class="result-value"></strong></div>
                  <div class="result-cell"><span class="result-label">K2 票数</span><strong id="result-choice2" class="result-value"></strong></div>
                  <div class="result-cell"><span class="result-label">弃权 / 未投</span><strong id="result-abstentions" class="result-value"></strong></div>
                  <div class="result-cell"><span class="result-label">你的积分</span><strong id="result-score" class="result-value"></strong></div>
                </div>
                <p id="result-explanation" class="result-explanation"></p>
              </div>
            </section>
            <section id="cancelled-state" class="state-note hidden">房间已取消。</section>
            <p class="notice" id="room-notice" role="status"></p>
            <div class="footer-note">状态每几秒同步一次 · 可分享房间编号邀请队友</div>
          </section>
        </div>
      </div>
    </section>
  </main>
  <script>
  (() => {
    const $ = (id) => document.getElementById(id);
    const state = { csrf: null, profile: null, release: null, roomId: localStorage.getItem('mud.roomId'), snapshot: null, serverOffset: 0, timer: null, busy: false, registering: false };
    const show = (id) => $(id).classList.remove('hidden');
    const hide = (id) => $(id).classList.add('hidden');
    const message = (id, text) => { $(id).textContent = text || ''; };
    const key = () => crypto.randomUUID();
    async function api(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.body !== undefined) headers.set('content-type', 'application/json');
      if (options.method && options.method !== 'GET') headers.set('x-csrf-token', state.csrf || '');
      if (options.idempotent) headers.set('idempotency-key', key());
      const response = await fetch(path, { ...options, headers, credentials: 'same-origin', body: options.body === undefined ? undefined : JSON.stringify(options.body) });
      const data = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) { const error = new Error(data?.code || 'REQUEST_FAILED'); error.code = data?.code || 'REQUEST_FAILED'; throw error; }
      return data;
    }
    function setScreen(id) { ['auth-screen','profile-screen','game-screen'].forEach(hide); show(id); }
    function setAuthMode(registering) { state.registering = registering; $('auth-title').textContent = registering ? '建立新档案' : '进入档案室'; $('auth-submit').textContent = registering ? '创建并登录' : '登录'; $('auth-toggle').textContent = registering ? '已有账号，返回登录' : '创建新档案'; $('password').autocomplete = registering ? 'new-password' : 'current-password'; message('auth-notice',''); }
    async function boot() {
      try {
        const session = await api('/auth/session'); state.csrf = session.csrfToken;
        if (!session.authenticated) { setScreen('auth-screen'); return; }
        await loadPlayer();
      } catch (error) { setScreen('auth-screen'); message('auth-notice','连接暂不可用：' + error.code); }
    }
    async function loadPlayer() {
      state.release = await api('/gameplay/release');
      try { state.profile = await api('/players/me'); }
      catch (error) {
        if (error.code === 'PLAYER_NOT_FOUND') {
          setScreen('profile-screen');
          $('profile-submit').disabled = !state.release.queryEnabled;
          message('profile-notice', state.release.queryEnabled ? '' : '试炼还未开放，暂不能建立角色。');
          return;
        }
        throw error;
      }
      $('player-name').textContent = state.profile.displayName;
      $('release-id').textContent = state.release.gameplayReleaseId;
      setScreen('game-screen');
      if (!state.release.queryEnabled) { $('create-room').disabled = true; message('lobby-notice','试炼暂未开放，请稍后再来。'); }
      if (state.roomId) { $('join-room-id').value = state.roomId; await openRoom(state.roomId); }
    }
    $('auth-toggle').addEventListener('click', () => setAuthMode(!state.registering));
    $('auth-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const button = $('auth-submit'); button.disabled = true; message('auth-notice','');
      try {
        const path = state.registering ? '/auth/register' : '/auth/login';
        const issued = await api(path, { method: 'POST', body: { username: $('username').value, password: $('password').value } });
        state.csrf = issued.csrfToken;
        await loadPlayer();
      } catch (error) { message('auth-notice', error.code === 'AUTH_INVALID_CREDENTIALS' ? '用户名或密码不正确。' : error.code === 'USERNAME_UNAVAILABLE' ? '这个用户名已被使用。' : '暂时无法进入：' + error.code); }
      finally { button.disabled = false; }
    });
    $('profile-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const button = event.submitter; button.disabled = true; message('profile-notice','');
      try {
        if (!state.release?.queryEnabled) throw new Error('GAMEPLAY_NOT_READY');
        await api('/players', { method: 'POST', idempotent: true, body: { displayName: $('display-name').value, factionId: $('faction').value, powerId: $('power').value, professionId: $('profession').value, gameplayReleaseId: state.release.gameplayReleaseId } });
        await loadPlayer();
      } catch (error) { message('profile-notice','档案暂时未能登记：' + error.code); }
      finally { button.disabled = false; }
    });
    $('logout-button').addEventListener('click', async () => {
      try { await api('/auth/logout', { method: 'POST' }); localStorage.removeItem('mud.roomId'); location.reload(); }
      catch (error) { message('room-notice','退出失败：' + error.code); }
    });
    $('create-room').addEventListener('click', async () => {
      const button = $('create-room'); button.disabled = true; message('lobby-notice','');
      try { const result = await api('/queries', { method: 'POST', idempotent: true, body: { templateId: 'trial_1', gameplayReleaseId: state.release.gameplayReleaseId } }); await openRoom(result.queryId); }
      catch (error) { message('lobby-notice','暂时无法建立房间：' + error.code); }
      finally { button.disabled = false; }
    });
    $('join-form').addEventListener('submit', async (event) => {
      event.preventDefault(); const roomId = $('join-room-id').value.trim(); if (!roomId) return;
      const button = event.submitter; button.disabled = true; message('lobby-notice','');
      try { await api('/query/' + encodeURIComponent(roomId) + '/join', { method: 'POST', idempotent: true, body: {} }); await openRoom(roomId); }
      catch (error) { message('lobby-notice','无法加入：' + error.code); }
      finally { button.disabled = false; }
    });
    async function openRoom(roomId) {
      state.roomId = roomId; localStorage.setItem('mud.roomId', roomId); $('join-room-id').value = roomId;
      show('room-surface'); hide('lobby-surface'); message('room-notice','');
      await refreshRoom();
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(() => refreshRoom().catch(() => {}), 2500);
    }
    async function refreshRoom() {
      if (!state.roomId || state.busy) return;
      const snapshot = await api('/query/' + encodeURIComponent(state.roomId));
      state.snapshot = snapshot; state.serverOffset = Date.parse(snapshot.serverTime) - Date.now();
      renderRoom(snapshot);
    }
    function renderRoom(snapshot) {
      $('room-code').textContent = snapshot.queryId;
      $('room-title').textContent = snapshot.phase === 'waiting' ? '等待调查员到齐' : snapshot.phase === 'exploring' ? '证据搜集阶段' : snapshot.phase === 'voting' ? '裁决阶段' : snapshot.phase === 'completed' ? '试炼已结案' : '试炼处理中';
      $('phase-stamp').textContent = snapshot.phase.toUpperCase().replaceAll('_',' ');
      const participants = $('participants'); participants.replaceChildren();
      for (let i = 0; i < 4; i += 1) {
        const person = snapshot.participants[i]; const slot = document.createElement('div'); slot.className = 'participant' + (person?.isSelf ? ' self' : '');
        const label = document.createElement('small'); label.textContent = person ? (person.isSelf ? '你 · 已加入' : '调查员 · 已加入') : '空席';
        const name = document.createElement('strong'); name.textContent = person?.displayName || '等待加入'; slot.append(label,name); participants.append(slot);
      }
      const remaining = snapshot.deadline ? Math.max(0, Math.ceil((Date.parse(snapshot.deadline) - (Date.now() + state.serverOffset)) / 1000)) : null;
      $('room-timer').textContent = remaining === null ? '' : Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2,'0');
      ['waiting-state','exploring-state','voting-state','settling-state','failed-state','completed-state','cancelled-state'].forEach(hide);
      if (snapshot.phase === 'waiting') show('waiting-state');
      if (snapshot.phase === 'exploring') { show('exploring-state'); renderEvidence(snapshot); }
      if (snapshot.phase === 'voting') { show('voting-state'); $('vote-current').textContent = snapshot.self.voteChoice ? '当前选择：' + snapshot.self.voteChoice : '尚未提交选择'; }
      if (snapshot.phase === 'settling') show('settling-state');
      if (snapshot.phase === 'settlement_failed') show('failed-state');
      if (snapshot.phase === 'completed') {
        show('completed-state');
        if (snapshot.result) {
          const result = snapshot.result;
          const choiceLabel = (choice) => choice === 'choice_1' ? 'K1' : choice === 'choice_2' ? 'K2' : '无人选择';
          $('result-selected').textContent = choiceLabel(result.selectedChoice);
          $('result-correct').textContent = choiceLabel(result.correctChoice);
          $('result-choice1').textContent = String(result.voteCounts.choice1);
          $('result-choice2').textContent = String(result.voteCounts.choice2);
          $('result-abstentions').textContent = result.voteCounts.abstentions + ' / ' + result.voteCounts.notCast;
          $('result-score').textContent = '+' + result.ownScore.awardedDelta + ' · ' + result.ownScore.scoreAfter;
          $('result-explanation').textContent = result.explanationKey === 'trial.explanation.current_mark' ? '选择与本轮有效印记一致的候选。' : '本轮裁决已公开。';
          show('result-details');
        } else {
          hide('result-details');
        }
      }
      if (snapshot.phase === 'cancelled') show('cancelled-state');
    }
    function renderEvidence(snapshot) {
      $('actions-used').textContent = snapshot.self.actionsUsed + ' / 2';
      const explored = new Set(snapshot.self.evidenceCards.map((card) => card.siteId));
      document.querySelectorAll('[data-site]').forEach((button) => { button.disabled = snapshot.self.actionsUsed >= 2 || explored.has(button.dataset.site); });
      const list = $('evidence-list'); list.replaceChildren();
      for (const card of snapshot.self.evidenceCards) {
        const article = document.createElement('article'); article.className = 'evidence';
        const site = document.createElement('span'); site.className = 'evidence-meta'; site.textContent = card.siteId.replace('site_','地点 ') + ' · 私有卡片';
        const text = document.createElement('p'); text.textContent = card.text; article.append(site,text); list.append(article);
      }
      if (!snapshot.self.evidenceCards.length) { const empty = document.createElement('p'); empty.className = 'lede'; empty.textContent = '尚未查阅证据。'; list.append(empty); }
    }
    document.querySelectorAll('[data-site]').forEach((button) => button.addEventListener('click', async () => {
      if (state.busy) return; state.busy = true; button.disabled = true;
      try { await api('/query/' + encodeURIComponent(state.roomId) + '/inspect', { method: 'POST', idempotent: true, body: { actionType: 'inspect', siteId: button.dataset.site } }); await refreshRoom(); }
      catch (error) { message('room-notice','查阅未完成：' + error.code); }
      finally { state.busy = false; }
    }));
    document.querySelectorAll('[data-choice]').forEach((button) => button.addEventListener('click', async () => {
      if (state.busy || !state.snapshot) return; state.busy = true; button.disabled = true;
      try { await api('/query/' + encodeURIComponent(state.roomId) + '/vote', { method: 'POST', idempotent: true, body: { choiceId: button.dataset.choice, expectedVersion: state.snapshot.aggregateVersion } }); await refreshRoom(); }
      catch (error) { message('room-notice','选择未提交：' + error.code); }
      finally { state.busy = false; button.disabled = false; }
    }));
    boot();
  })();
  </script>
</body>
</html>`;
