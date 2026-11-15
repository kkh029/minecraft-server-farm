'use strict';
(() => {
  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GB = 1024 ** 3;
  const fmtGB = (b) => (b / GB).toFixed(b / GB >= 100 ? 0 : 1);
  const fmtMem = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
  const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : 0);

  function fmtDuration(ms) {
    const m = Math.floor(ms / 60000);
    if (m < 1) return '방금 시작';
    if (m < 60) return `${m}분째`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}시간 ${m % 60}분째`;
    return `${Math.floor(h / 24)}일 ${h % 24}시간째`;
  }

  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    play: svg('<polygon points="7 4 20 12 7 20 7 4" fill="currentColor"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
    terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
    key: svg('<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 20 3M16 7l3 3M14 9l2 2"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    sliders: svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/>'),
    logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
    plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
    x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    check: svg('<polyline points="20 6 9 17 4 12"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
    share: svg('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>'),
    zap: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  };

  const GAMEMODE = { survival: '서바이벌', creative: '크리에이티브', adventure: '어드벤처' };
  const isJava = (s) => s?.edition === 'java';
  const editionLabel = (s) => (isJava(s) ? `Java ${s.javaVersion}` : 'Bedrock');
  // Same rule as the server: compare dotted release numbers (26.1 > 1.21.11).
  function cmpVersion(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  const javaProtectOk = (v) => Boolean(v) && cmpVersion(v, S?.java?.protectMinVersion || '1.21') >= 0;
  const JAVA_TRIGGER = '/trigger pin set';
  const DIFFICULTY = { peaceful: '평화로움', easy: '쉬움', normal: '보통', hard: '어려움' };
  const STATUS = {
    stopped: { label: '정지됨', cls: 'stopped' },
    preparing: { label: '준비 중', cls: 'busy' },
    starting: { label: '시작하는 중', cls: 'busy' },
    running: { label: '실행 중', cls: 'ok' },
    stopping: { label: '정지하는 중', cls: 'busy' },
    error: { label: '오류', cls: 'danger' },
    orphaned: { label: '연결 끊김', cls: 'orphan' },
  };

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await res.json();
    } catch { /* empty body */ }
    if (res.status === 401 && !url.startsWith('/api/auth')) {
      showAuth('login');
    }
    if (!res.ok) throw new Error(data?.error || `요청에 실패했습니다 (${res.status})`);
    return data;
  }

  function toast(message, type = '') {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    box.appendChild(el);
    if (box.showPopover) {
      // Re-showing moves the popover to the top of the top layer, above any dialog opened since.
      if (box.matches(':popover-open')) box.hidePopover();
      box.showPopover();
    }
    setTimeout(() => {
      el.remove();
      if (!box.childElementCount && box.hidePopover && box.matches(':popover-open')) box.hidePopover();
    }, type === 'error' ? 6000 : 3200);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall back below */ }
    // http:// on a LAN address isn't a secure context, so the Clipboard API is unavailable there.
    const host = document.querySelector('dialog[open]') || document.body;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    host.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* not supported */ }
    ta.remove();
    return ok;
  }

  // Sets innerHTML only when it changed, so live updates don't disturb hover/focus.
  const htmlCache = new WeakMap();
  function patch(el, html) {
    if (htmlCache.get(el) === html) return false;
    el.innerHTML = html;
    htmlCache.set(el, html);
    // Inline style attributes are blocked by the CSP, so widths are applied through the DOM.
    for (const bar of el.querySelectorAll('[data-w]')) bar.style.width = `${bar.dataset.w}%`;
    return true;
  }

  // ---------- auth ----------
  let authMode = 'login';
  let es = null;
  let S = null;

  function showAuth(mode) {
    authMode = mode;
    if (es) {
      es.close();
      es = null;
    }
    $('#app').hidden = true;
    $('#auth').hidden = false;
    const setup = mode === 'setup';
    $('#auth-title').textContent = setup ? '관리자 비밀번호 만들기' : '관리자 로그인';
    $('#auth-desc').textContent = setup
      ? '이 포털을 처음 실행했습니다. 서버를 켜고 끌 수 있는 관리자 비밀번호를 정하세요 (8자 이상).'
      : '포털 관리자 비밀번호를 입력하세요.';
    $('#auth-pw2-wrap').hidden = !setup;
    $('#auth-pw').autocomplete = setup ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = setup ? '시작하기' : '로그인';
    $('#auth-error').hidden = true;
    $('#auth-pw').value = '';
    $('#auth-pw2').value = '';
    $('#auth-pw').focus();
  }

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#auth-pw').value;
    const err = $('#auth-error');
    err.hidden = true;
    try {
      if (authMode === 'setup') {
        if (pw.length < 8) throw new Error('비밀번호는 8자 이상이어야 합니다.');
        if (pw !== $('#auth-pw2').value) throw new Error('비밀번호 확인이 일치하지 않습니다.');
        await api('POST', '/api/auth/setup', { password: pw });
      } else {
        await api('POST', '/api/auth/login', { password: pw });
      }
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  function showApp() {
    $('#auth').hidden = true;
    $('#app').hidden = false;
    connect();
  }

  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('open', () => setConn(true));
    es.addEventListener('state', (e) => {
      S = JSON.parse(e.data);
      setConn(true);
      render();
    });
    es.addEventListener('log', (e) => {
      const { id, lines } = JSON.parse(e.data);
      if (id === consoleId) {
        if (consoleLoading) consoleBuffer.push(...lines);
        else appendLogs(lines);
      }
    });
    es.onerror = async () => {
      setConn(false);
      try {
        const st = await api('GET', '/api/auth/status');
        if (!st.authenticated) showAuth(st.setupRequired ? 'setup' : 'login');
      } catch { /* portal offline; EventSource keeps retrying */ }
    };
  }

  function setConn(on) {
    const el = $('#conn');
    el.className = `conn ${on ? 'on' : 'off'}`;
    el.title = on ? '실시간 연결됨' : '포털과 연결이 끊겼습니다. 다시 연결하는 중…';
  }

  // ---------- rendering ----------
  function render() {
    if (!S) return;
    renderTop();
    renderStats();
    renderBanners();
    renderServers();
    if ($('#dlg-settings').open) renderSettingsLive();
    if ($('#dlg-console').open) renderConsoleMeta();
  }

  const hasBedrock = () => S.servers.some((s) => !isJava(s));

  function renderTop() {
    const chip = $('#bds-chip');
    chip.textContent = S.bds.current ? `BDS ${S.bds.current}` : '서버 프로그램 없음';
    chip.className = `chip${S.bds.current ? '' : ' warn'}`;
    // Without Bedrock servers a missing BDS isn't a problem worth a warning.
    chip.hidden = !S.bds.current && !hasBedrock();
  }

  function sizing(estGB) {
    const total = S.system.totalMem / GB;
    const threads = S.system.threads;
    const reserve = Math.max(2, total * 0.15);
    const est = Math.max(0.25, Number(estGB) || 1.5);
    const memMax = Math.max(1, Math.floor((total - reserve) / est));
    const cpuMax = Math.max(1, Math.floor(threads / 2));
    const hardMax = Math.max(1, Math.min(memMax, threads, 32));
    return { total, threads, reserve, est, memMax, cpuMax, hardMax, recommended: Math.min(memMax, cpuMax, hardMax) };
  }

  function renderStats() {
    const sys = S.system;
    const sl = S.slots;
    const busy = S.servers.filter((s) => ['preparing', 'starting', 'stopping'].includes(s.runtime.status)).length;
    let pips = '';
    for (let i = 0; i < sl.max; i++) pips += `<span class="pip${i < sl.used - busy ? ' on' : i < sl.used ? ' busy' : ''}"></span>`;
    const memUsed = sys.totalMem - sys.freeMem;
    const memPct = pct(memUsed, sys.totalMem);
    const serverMem = S.servers.reduce((a, s) => a + (s.runtime.memBytes || 0), 0);
    const disk = sys.disk;
    const diskPct = disk ? pct(disk.total - disk.free, disk.total) : 0;
    const level = (p) => (p >= 90 ? ' danger' : p >= 75 ? ' warn' : '');
    const auto = S.settings.maxConcurrent === null;

    patch($('#stats'), `
      <div class="stat">
        <div class="stat-label"><span>실행 슬롯</span><span>${sl.used >= sl.max ? '가득 참' : `${sl.max - sl.used}자리 비어 있음`}</span></div>
        <div class="stat-value">${sl.used} <small>/ ${sl.max}</small></div>
        <div class="pips" aria-hidden="true">${pips}</div>
        <div class="stat-sub">권장 ${sl.recommended}대 · 최대 ${sl.hardMax}대${auto ? ' · 자동' : ''}</div>
      </div>
      <div class="stat">
        <div class="stat-label"><span>CPU</span><span>${sys.threads}스레드</span></div>
        <div class="stat-value">${sys.cpuPercent}<small>%</small></div>
        <div class="bar${level(sys.cpuPercent)}"><span data-w="${sys.cpuPercent}"></span></div>
        <div class="stat-sub" title="${esc(sys.cpuModel)}">${esc(sys.cpuModel)}</div>
      </div>
      <div class="stat">
        <div class="stat-label"><span>메모리</span><span>${memPct}%</span></div>
        <div class="stat-value">${fmtGB(memUsed)} <small>/ ${fmtGB(sys.totalMem)} GB</small></div>
        <div class="bar${level(memPct)}"><span data-w="${memPct}"></span></div>
        <div class="stat-sub">${serverMem ? `마인크래프트 서버가 ${fmtMem(serverMem)} 사용 중` : '실행 중인 서버 없음'}</div>
      </div>
      <div class="stat">
        <div class="stat-label"><span>디스크</span><span>${disk ? `${diskPct}%` : ''}</span></div>
        <div class="stat-value">${disk ? `${fmtGB(disk.free)} <small>GB 남음</small>` : '—'}</div>
        <div class="bar${level(diskPct)}"><span data-w="${diskPct}"></span></div>
        <div class="stat-sub">${disk ? `전체 ${fmtGB(disk.total)} GB · 월드는 data 폴더에 저장` : '정보 없음'}</div>
      </div>`);
  }

  function bdsBusy() {
    const t = S.bds.task;
    return Boolean(t && (t.phase === 'download' || t.phase === 'extract'));
  }

  function banner(kind, title, text, actions = '', progress = null) {
    return `<div class="banner ${kind}">
      <div class="banner-text"><b>${title}</b><span class="muted">${text}</span></div>
      ${actions}
      ${progress !== null ? `<div class="bar"><span data-w="${progress}"></span></div>` : ''}
    </div>`;
  }

  // What the firewall check found, as [level, message] — null when there's nothing to say.
  function firewallStatus() {
    const fw = S.firewall;
    if (!fw || !fw.supported) return null;
    if (fw.checking && fw.ok === null) return ['', '방화벽 규칙을 확인하는 중…'];
    if (fw.error) return ['warn', esc(fw.error)];
    if (fw.blocked > 0) {
      return ['warn', `서버 슬롯을 <b>차단</b>하는 방화벽 규칙이 ${fw.blocked}개 있습니다 (확인 창에서 「취소」를 누르면 생깁니다). 프로젝트 폴더의 <code>firewall-setup.bat</code>을 실행하면 정리됩니다.`];
    }
    if (fw.ok === false && fw.missingJava && fw.missingJava === fw.missing) {
      return ['warn', `새로 받은 Java 실행 환경에 대한 Windows 방화벽 규칙이 없어, Java 서버를 켤 때 「액세스 허용」 확인 창이 뜹니다. 프로젝트 폴더의 <code>firewall-setup.bat</code>을 다시 실행하세요 (관리자 권한 필요).`];
    }
    if (fw.ok === false) {
      return ['warn', `Windows 방화벽 규칙이 없어 서버를 처음 켤 때마다 「액세스 허용」 확인 창이 뜹니다. 프로젝트 폴더의 <code>firewall-setup.bat</code>을 한 번 실행하세요 (관리자 권한 필요).`];
    }
    if (fw.ok) return ['ok', '방화벽 규칙이 등록되어 있어 서버를 켤 때 확인 창이 뜨지 않습니다.'];
    return null;
  }

  function renderBanners() {
    const b = S.bds;
    const t = b.task;
    const out = [];
    const fw = firewallStatus();
    if (fw && fw[0] === 'warn') {
      out.push(banner('warn', '방화벽 확인 창이 뜰 수 있습니다', fw[1],
        `<button class="btn" type="button" data-action="fw-check"${S.firewall.checking ? ' disabled' : ''}>${S.firewall.checking ? '확인 중…' : '다시 확인'}</button>`));
    }
    if (bdsBusy()) {
      out.push(t.phase === 'download'
        ? banner('info', `서버 프로그램 BDS ${esc(t.version)} 내려받는 중`, `${t.percent}% · ${t.receivedMB || 0} MB`, '', t.percent)
        : banner('info', `서버 프로그램 BDS ${esc(t.version)} 압축 푸는 중`, '잠시만 기다려 주세요.', '', 100));
    } else if (t && t.phase === 'error') {
      out.push(banner('danger', '서버 프로그램 설치에 실패했습니다', esc(t.error), '<button class="btn" type="button" data-action="open-bds">다시 시도</button>'));
    }
    // BDS only matters once there is a Bedrock server (Java servers bring their own program).
    if (!b.current && !bdsBusy() && hasBedrock()) {
      out.push(banner('warn', '서버 프로그램(BDS)이 설치되어 있지 않습니다',
        'Mojang 공식 Bedrock Dedicated Server를 내려받아야 Bedrock 서버를 실행할 수 있습니다.',
        '<button class="btn primary" type="button" data-action="open-bds">설치하기</button>'));
    } else if (b.updateAvailable && !bdsBusy() && hasBedrock()) {
      out.push(banner('info', `새 Bedrock 서버 버전이 나왔습니다 (${esc(b.latest)})`,
        `지금은 ${esc(b.current)}입니다. 플레이어의 마인크래프트가 업데이트되면 서버도 같은 버전이어야 접속할 수 있어요.`,
        '<button class="btn primary" type="button" data-action="open-bds">업데이트</button>'));
    }
    for (const jt of Object.values(S.java.tasks)) {
      if (jt.phase === 'download' || jt.phase === 'extract') {
        out.push(banner('info', `Java ${esc(jt.version)} 서버 프로그램 준비 중`, esc(javaTaskText(jt)), '', jt.phase === 'download' ? jt.percent : 100));
      }
    }
    patch($('#banners'), out.join(''));
  }

  function javaTaskText(t) {
    if (t.phase === 'extract') return `${t.step}…`;
    return `${t.step} 내려받는 중 ${t.percent}%${t.totalMB ? ` (${t.receivedMB} / ${t.totalMB} MB)` : ''}`;
  }

  function startBlockReason(s) {
    if (isJava(s)) {
      if (!S.java.platformSupported) return '이 운영체제에서는 Java 서버를 실행할 수 없습니다.';
      if (!S.eulaAcceptedAt) return '편집에서 Minecraft EULA에 동의하면 실행할 수 있어요.';
    } else {
      if (!S.bds.current) return '서버 프로그램을 먼저 설치하세요.';
      if (bdsBusy() && S.bds.task.version === S.bds.current) return '서버 프로그램 설치가 끝나면 실행할 수 있어요.';
    }
    if (S.slots.used >= S.slots.max) return `빈 슬롯이 없습니다 (${S.slots.used}/${S.slots.max} 실행 중). 다른 서버를 정지하거나 설정에서 동시 실행 수를 늘리세요.`;
    return null;
  }

  // Java's "서버 주소" field takes host:port in one go.
  const javaAddress = (host, port) => `${host}:${port}`;

  function shareText(s) {
    const r = s.runtime;
    const h = S.hosts;
    if (isJava(s)) {
      const lines = [`[마인크래프트 Java 서버] ${s.name}`, `버전: Java Edition ${s.javaVersion}`];
      if (h.public) lines.push(`서버 주소: ${javaAddress(h.public, s.port)}`, `(같은 와이파이라면 ${javaAddress(h.lan, s.port)})`);
      else lines.push(`서버 주소: ${javaAddress(h.lan, s.port)}`);
      if (r.pin) lines.push(`비밀번호: ${r.pin}`);
      lines.push('', `마인크래프트 런처에서 ${s.javaVersion} 버전으로 실행 → 멀티플레이 → 「서버 추가」에서 서버 주소를 입력하세요.`);
      if (r.pin) lines.push(`접속하면 채팅창(T)을 열고 ${JAVA_TRIGGER} ${r.pin} 을 입력하면 됩니다. (채팅에 뜨는 「여기를 눌러」를 누르면 명령어가 채워져요.)`);
      return lines.join('\n');
    }
    const lines = [`[마인크래프트 서버] ${s.name}`];
    if (h.public) lines.push(`주소: ${h.public}`, `포트: ${s.port}`, `(같은 와이파이라면 주소 ${h.lan})`);
    else lines.push(`주소: ${h.lan}`, `포트: ${s.port}`);
    if (r.pin) lines.push(`비밀번호: ${r.pin}`);
    lines.push('', '마인크래프트 → 플레이 → 서버 → 「서버 추가」에서 주소와 포트를 입력하세요.');
    if (r.pin) lines.push('접속하면 뜨는 창에 비밀번호를 입력하면 됩니다.');
    lines.push('※ 같은 와이파이에서 접속이 안 되면: 아이폰은 설정 → 개인정보 보호 및 보안 → 로컬 네트워크에서 Minecraft를 켜고, 안드로이드는 Minecraft 앱 권한에서 「근처 기기」를 허용하세요.');
    return lines.join('\n');
  }

  function copyRow(label, value, cls = '') {
    return `<dt>${label}</dt><dd class="${cls}">${esc(value)}</dd>
      <button class="icon-btn" type="button" data-copy="${esc(value)}" title="${label} 복사" aria-label="${label} 복사">${ICON.copy}</button>`;
  }

  function connectBlock(s) {
    const r = s.runtime;
    const h = S.hosts;
    let rows;
    let help;
    if (isJava(s)) {
      rows = [copyRow(h.public ? 'LAN 주소' : '서버 주소', javaAddress(h.lan, s.port))];
      if (h.public) rows.push(copyRow('외부 주소', javaAddress(h.public, s.port)));
      if (r.pin) rows.push(copyRow('비밀번호', r.pin, 'pin'));
      help = `런처에서 <b>${esc(s.javaVersion)}</b> 버전으로 실행 → 멀티플레이 → 「서버 추가」에 서버 주소를 넣고 접속하면${r.pin
        ? `, 채팅창(T)에 <code>${JAVA_TRIGGER} ${esc(r.pin)}</code>을 입력하면 됩니다.` : ' 바로 플레이할 수 있어요.'}`;
    } else {
      rows = [copyRow(h.public ? 'LAN 주소' : '주소', h.lan)];
      if (h.public) rows.push(copyRow('외부 주소', h.public));
      rows.push(copyRow('포트', String(s.port)));
      if (r.pin) rows.push(copyRow('비밀번호', r.pin, 'pin'));
      help = `마인크래프트 → 플레이 → 서버 → 「서버 추가」에서 주소와 포트를 넣고 접속하면${r.pin ? ', 뜨는 창에 비밀번호를 입력하면 됩니다.' : ' 바로 플레이할 수 있어요.'}`;
    }
    return `<div class="connect">
      <div class="connect-title"><span>접속 정보</span></div>
      <dl class="kv">${rows.join('')}</dl>
      <div class="connect-actions">
        <button class="btn sm" type="button" data-action="share" data-id="${s.id}">${ICON.share}공유 문구 복사</button>
      </div>
      <p class="connect-help">${help}</p>
    </div>`;
  }

  function playersBlock(s) {
    const list = s.runtime.players;
    if (!list.length) return `<div class="players"><span class="players-label">접속 중 0 / ${s.maxPlayers}</span><span class="muted">아직 아무도 없어요</span></div>`;
    const chips = list.map((p) => (p.verified
      ? `<span class="player" title="인증 완료">${ICON.check}${esc(p.name)}</span>`
      : `<span class="player waiting" title="비밀번호 입력 대기 중">${ICON.clock}${esc(p.name)} · 인증 대기</span>`)).join('');
    return `<div class="players"><span class="players-label">접속 중 ${list.length} / ${s.maxPlayers}</span>${chips}</div>`;
  }

  // Players only type the TCP port; the UDP range matters for port forwarding.
  function portsText(s) {
    if (isJava(s)) return `TCP ${s.port}`;
    if (s.transport === 'raknet') return `UDP ${s.port}, ${s.port + 1}`;
    if (!Number.isInteger(s.udpPortStart)) return `TCP·UDP ${s.port}`;
    return `접속 TCP ${s.port} · 게임 UDP ${s.udpPortStart}-${s.udpPortStart + 15}`;
  }

  // The version a stopped server will run next, and the one it last ran.
  function versionText(s) {
    const r = s.runtime;
    if (isJava(s)) {
      const javaInstalled = S.java.installed.includes(s.javaVersion);
      const next = `Java ${esc(s.javaVersion)}${javaInstalled ? '' : ' (처음 실행할 때 내려받음)'}`;
      return r.installedVersion && r.installedVersion !== s.javaVersion ? `${esc(r.installedVersion)} → 다음 실행 때 ${next}` : next;
    }
    return r.installedVersion && S.bds.current && r.installedVersion !== S.bds.current
      ? `${esc(r.installedVersion)} → 다음 실행 때 ${esc(S.bds.current)}` : esc(r.installedVersion || S.bds.current || '—');
  }

  function cardParts(s) {
    const r = s.runtime;
    const st = STATUS[r.status] || STATUS.stopped;
    const now = Date.now();
    const uptime = r.status === 'running' && r.runningAt ? `<span class="uptime">${fmtDuration(now - r.runningAt)}</span>` : '';
    const head = `
      <div class="card-top"><span class="pill ${st.cls}">${st.label}</span><span class="edition-tag ${isJava(s) ? 'java' : 'bedrock'}">${esc(editionLabel(s))}</span>${uptime}</div>
      <div class="card-title">${esc(s.name)}</div>
      <div class="card-meta">${GAMEMODE[s.gamemode]} · ${DIFFICULTY[s.difficulty]} · 최대 ${s.maxPlayers}명 · 포트 ${s.port}</div>`;

    let body = '';
    const versionNote = !isJava(s) && r.version && S.bds.current && r.version !== S.bds.current
      ? ` · 재시작하면 ${esc(S.bds.current)}로 업데이트` : '';
    const runningVersion = isJava(s)
      ? `Java ${esc(r.version)} · 메모리 최대 ${fmtMem((s.memoryMB || 2048) * 1048576)}`
      : `BDS ${esc(r.version)}${r.slot ? ` · 슬롯 ${r.slot}` : ''}${versionNote}`;
    switch (r.status) {
      case 'running':
        body = connectBlock(s);
        if (!r.protect) {
          body += `<div class="notice warn">${isJava(s) && !javaProtectOk(r.version)
            ? `이 버전(${esc(r.version)})은 비밀번호 보호를 쓸 수 없어 주소를 아는 누구나 접속할 수 있습니다. 화이트리스트를 쓰려면 콘솔에서 <code>whitelist on</code>, <code>whitelist add 이름</code>을 입력하세요.`
            : '비밀번호 보호가 꺼져 있어 주소를 아는 누구나 접속할 수 있습니다.'}</div>`;
        }
        body += playersBlock(s);
        body += `<dl class="details"><dt>메모리</dt><dd>${r.memBytes ? fmtMem(r.memBytes) : '측정 중'}</dd>
          <dt>포트</dt><dd>${portsText(s)}</dd>
          <dt>버전</dt><dd>${runningVersion}</dd></dl>`;
        break;
      case 'orphaned':
        body = connectBlock(s);
        body += `<div class="notice orphan">포털이 다시 시작되기 전부터 돌던 서버라 접속자 목록과 콘솔을 볼 수 없어요.${isJava(s) && r.protect ? ' 이 상태에서는 새로 접속한 사람이 비밀번호를 입력해도 인증되지 않습니다.' : ''} 강제 종료한 뒤 다시 실행하면 정상적으로 관리됩니다.</div>`;
        break;
      case 'preparing':
        body = r.task && r.task.phase !== 'done' && r.task.phase !== 'error'
          ? `<div class="progress-line"><span class="spinner"></span>Java ${esc(r.version)} ${esc(javaTaskText(r.task))}</div>
             <div class="bar"><span data-w="${r.task.phase === 'download' ? r.task.percent : 100}"></span></div>`
          : '<div class="progress-line"><span class="spinner"></span>서버를 켜는 중입니다… 접속 정보가 곧 표시됩니다.</div>';
        break;
      case 'starting':
        body = '<div class="progress-line"><span class="spinner"></span>서버를 켜는 중입니다… 접속 정보가 곧 표시됩니다.</div>';
        break;
      case 'stopping':
        body = '<div class="progress-line"><span class="spinner"></span>월드를 저장하고 정지하는 중입니다…</div>';
        break;
      default: {
        if (r.status === 'error' && r.error) body += `<div class="notice danger">${esc(r.error)}</div>`;
        const password = !s.protect ? '보호 꺼짐 — 누구나 접속 가능'
          : isJava(s) ? `실행할 때마다 새로 발급 · 채팅창에 ${JAVA_TRIGGER} &lt;비밀번호&gt;` : '실행할 때마다 새로 발급';
        body += `<dl class="details">
          <dt>월드</dt><dd>${r.worldExists ? '있음' : '처음 실행할 때 새로 만듭니다'}</dd>
          <dt>비밀번호</dt><dd>${password}</dd>
          <dt>포트</dt><dd>${portsText(s)}</dd>
          ${isJava(s) ? `<dt>메모리</dt><dd>최대 ${fmtMem((s.memoryMB || 2048) * 1048576)}</dd>` : ''}
          ${s.levelSeed ? `<dt>시드</dt><dd class="mono">${esc(s.levelSeed)}</dd>` : ''}
          ${Object.keys(s.extraProperties || {}).length ? `<dt>상세 설정</dt><dd>${Object.keys(s.extraProperties).length}개 변경</dd>` : ''}
          <dt>버전</dt><dd>${versionText(s)}</dd>
        </dl>`;
      }
    }

    const btn = (action, label, icon, cls = '', disabled = false, title = '') =>
      `<button class="btn ${cls}" type="button" data-action="${action}" data-id="${s.id}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${icon}${label}</button>`;
    let foot = '';
    switch (r.status) {
      case 'running':
        foot = btn('stop', '정지', ICON.stop, 'danger') + btn('console', '콘솔', ICON.terminal)
          + (r.protect ? btn('pin', '새 비밀번호', ICON.key) : '');
        break;
      case 'preparing':
      case 'starting':
        foot = btn('stop', '취소', ICON.stop, 'danger') + btn('console', '콘솔', ICON.terminal);
        break;
      case 'stopping':
        foot = btn('kill', '강제 종료', ICON.zap, 'danger') + btn('console', '콘솔', ICON.terminal);
        break;
      case 'orphaned':
        foot = btn('kill', '강제 종료', ICON.zap, 'danger');
        break;
      default: {
        const reason = startBlockReason(s);
        foot = btn('start', r.status === 'error' ? '다시 실행' : '실행', ICON.play, 'primary', Boolean(reason), reason || '')
          + btn('console', '로그', ICON.terminal) + btn('edit', '편집', ICON.edit) + btn('delete', '삭제', ICON.trash, 'ghost');
        if (reason) foot += `<span class="note">${esc(reason)}</span>`;
      }
    }
    return { head, body, foot };
  }

  const cards = new Map();
  function renderServers() {
    const grid = $('#servers');
    const ids = new Set(S.servers.map((s) => s.id));
    for (const [id, el] of cards) {
      if (!ids.has(id)) {
        el.remove();
        cards.delete(id);
      }
    }
    S.servers.forEach((s, i) => {
      let el = cards.get(s.id);
      if (!el) {
        el = document.createElement('article');
        el.innerHTML = '<div class="card-head"></div><div class="card-body"></div><div class="card-foot"></div>';
        cards.set(s.id, el);
      }
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
      el.className = `card is-${s.runtime.status}`;
      const parts = cardParts(s);
      patch(el.querySelector('.card-head'), parts.head);
      patch(el.querySelector('.card-body'), parts.body);
      patch(el.querySelector('.card-foot'), parts.foot);
    });
    $('#empty').hidden = S.servers.length > 0;
    $('#server-count').textContent = S.servers.length || '';
  }

  // ---------- actions ----------
  const serverById = (id) => S?.servers.find((s) => s.id === id);

  async function withBusy(button, fn) {
    if (button) button.disabled = true;
    try {
      await fn();
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
  }

  document.addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const ok = await copyText(copyBtn.dataset.copy);
      toast(ok ? '복사했습니다.' : '복사하지 못했습니다. 직접 선택해서 복사하세요.', ok ? '' : 'error');
      return;
    }
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      closeBtn.closest('dialog').close();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const s = id ? serverById(id) : null;
    switch (action) {
      case 'start':
        return withBusy(btn, () => api('POST', `/api/servers/${id}/start`));
      case 'stop':
        return withBusy(btn, () => api('POST', `/api/servers/${id}/stop`));
      case 'kill':
        if (await confirmBox('강제 종료', '정상 종료를 기다리지 않고 바로 끕니다. 마지막 몇 초간의 진행 상황이 저장되지 않을 수 있어요.', '강제 종료')) {
          return withBusy(btn, () => api('POST', `/api/servers/${id}/kill`));
        }
        return;
      case 'pin':
        if (await confirmBox('새 비밀번호 발급', '이미 인증하고 플레이 중인 사람은 그대로 계속할 수 있고, 새로 접속하는 사람은 새 비밀번호를 입력해야 합니다.', '발급')) {
          return withBusy(btn, async () => {
            const { pin } = await api('POST', `/api/servers/${id}/pin`);
            toast(`새 비밀번호: ${pin}`);
          });
        }
        return;
      case 'share':
        if (s) {
          const ok = await copyText(shareText(s));
          toast(ok ? '친구에게 보낼 접속 안내를 복사했습니다.' : '복사하지 못했습니다.', ok ? '' : 'error');
        }
        return;
      case 'console':
        return openConsole(id);
      case 'edit':
        return openServerForm(id);
      case 'delete':
        if (s && await confirmBox('서버 삭제', `「${esc(s.name)}」 서버를 삭제할까요?<br><br>월드와 설정은 바로 지워지지 않고 <b>data/trash</b> 폴더로 옮겨집니다. 필요하면 그곳에서 복구하거나 직접 지울 수 있어요.`, '삭제', true)) {
          return withBusy(btn, async () => {
            await api('DELETE', `/api/servers/${id}`);
            toast('서버를 삭제했습니다.');
          });
        }
        return;
      case 'kick':
        if (await confirmBox('플레이어 퇴장', `${esc(btn.dataset.name)} 님을 서버에서 내보낼까요?`, '내보내기')) {
          return withBusy(btn, () => api('POST', `/api/servers/${id}/kick`, { name: btn.dataset.name }));
        }
        return;
      case 'open-bds':
        return openSettings(true);
      case 'fw-check':
        return withBusy(btn, async () => {
          const fw = await api('POST', '/api/firewall/check');
          toast(fw.ok ? '방화벽 규칙이 확인되었습니다.' : fw.error || '아직 방화벽 규칙이 없습니다.', fw.ok ? '' : 'error');
        });
      default:
    }
  });

  $('#btn-new').innerHTML = `${ICON.plus}<span>새 서버</span>`;
  $('#btn-new').addEventListener('click', () => openServerForm(null));
  $('#btn-settings').innerHTML = `${ICON.sliders}<span class="label">설정</span>`;
  $('#btn-settings').addEventListener('click', () => openSettings(false));
  $('#btn-logout').innerHTML = `${ICON.logout}<span class="label">로그아웃</span>`;
  $('#btn-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    showAuth('login');
  });
  for (const b of $$('.icon-btn[data-close]')) b.innerHTML = ICON.x;

  // ---------- confirm dialog ----------
  function confirmBox(title, html, okLabel = '확인', danger = false) {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').innerHTML = html;
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // ---------- server form ----------
  const DEFAULTS = { name: '', gamemode: 'survival', difficulty: 'normal', maxPlayers: 10, levelSeed: '', port: '', udpPortStart: '', protect: true, onlineMode: true, allowCheats: false, viewDistance: 32, lanVisibility: false, memoryMB: 2048, javaVersion: '' };
  const EDITION_FORM = {
    bedrock: { viewDistance: 32, viewMin: 6, viewMax: 96, viewNote: '낮을수록 메모리와 CPU를 덜 씁니다. 기본 32.' },
    java: { viewDistance: 10, viewMin: 3, viewMax: 32, viewNote: '3~32. 낮을수록 메모리와 CPU를 덜 씁니다. 기본 10.' },
  };
  let editingId = null;
  let formEdition = 'bedrock';

  // Releases newest first: Mojang's list when it could be fetched, plus whatever is already installed.
  function javaVersionList(current) {
    const set = new Set([...(S.java.releases || []), ...(S.java.installed || [])]);
    if (current) set.add(current);
    return [...set].sort((a, b) => cmpVersion(b, a));
  }

  function fillJavaVersions(select, current) {
    const latest = S.java.latest;
    select.innerHTML = javaVersionList(current).map((v) => {
      const tags = [v === latest ? '최신' : '', S.java.installed.includes(v) ? '받아 둠' : ''].filter(Boolean);
      return `<option value="${esc(v)}">${esc(v)}${tags.length ? ` (${tags.join(', ')})` : ''}</option>`;
    }).join('') || '<option value="">버전 목록을 불러오지 못했습니다</option>';
  }

  // Shows the fields of the chosen edition and the notes that depend on the chosen Java version.
  function applyEdition(edition, { resetDefaults = false } = {}) {
    formEdition = edition;
    const form = $('#server-form');
    const f = form.elements;
    const java = edition === 'java';
    for (const el of $$('[data-edition]', form)) {
      const on = el.dataset.edition === edition;
      el.hidden = !on;
      for (const input of $$('input, select', el)) input.disabled = !on;
    }
    const conf = EDITION_FORM[edition];
    f.viewDistance.min = conf.viewMin;
    f.viewDistance.max = conf.viewMax;
    $('#view-note').textContent = conf.viewNote;
    if (resetDefaults) f.viewDistance.value = conf.viewDistance;
    f.port.placeholder = java ? `자동 (${S.settings.javaPortBase}부터)` : `자동 (${S.settings.portBase}부터)`;
    $('#eula-row').hidden = !java || Boolean(S.eulaAcceptedAt);
    f.agreeEula.disabled = $('#eula-row').hidden;
    $('#edition-note').textContent = editingId
      ? '에디션은 만든 뒤에 바꿀 수 없습니다.'
      : java
        ? 'Java Edition 플레이어(PC 런처)만 접속할 수 있습니다. 휴대폰·콘솔 친구는 Bedrock 서버로 만드세요.'
        : 'Bedrock 플레이어(휴대폰·태블릿·Windows 앱·콘솔)가 접속합니다. PC Java Edition으로는 접속할 수 없습니다.';
    applyJavaVersion();
  }

  function applyJavaVersion() {
    const f = $('#server-form').elements;
    const java = formEdition === 'java';
    const v = f.javaVersion.value;
    const protectOk = !java || javaProtectOk(v);
    f.protect.disabled = !protectOk;
    if (!protectOk) f.protect.checked = false;
    $('#protect-desc').textContent = !protectOk
      ? `— Java ${S.java.protectMinVersion} 이상에서만 쓸 수 있습니다. 이 버전은 화이트리스트(콘솔에서 whitelist add 이름)로 막으세요.`
      : java
        ? `— 실행할 때마다 새 비밀번호를 만들고, 접속한 사람은 채팅창에 ${JAVA_TRIGGER} <비밀번호>를 입력해야 플레이할 수 있습니다.`
        : '— 실행할 때마다 새 비밀번호를 만들고, 접속한 사람은 비밀번호를 입력해야 플레이할 수 있습니다.';
    if (java) {
      const s = editingId ? serverById(editingId) : null;
      const last = s?.runtime.installedVersion;
      const notes = [];
      if (v && !S.java.installed.includes(v)) notes.push('처음 실행할 때 Mojang에서 내려받습니다 (약 150MB, Java 실행 환경 포함).');
      if (last && v && cmpVersion(v, last) < 0 && s?.runtime.worldExists) notes.push(`⚠ 월드가 ${last}에서 실행된 적이 있어 낮은 버전으로는 열 수 없습니다.`);
      else if (last && v && v !== last) notes.push(`월드를 ${v}로 업그레이드합니다 (되돌릴 수 없으니 먼저 백업하세요).`);
      notes.push('플레이어도 런처에서 같은 버전을 골라야 합니다.');
      $('#java-version-note').textContent = notes.join(' ');
    }
  }

  function openServerForm(id) {
    const s = id ? serverById(id) : null;
    editingId = s ? id : null;
    const form = $('#server-form');
    const edition = s ? s.edition || 'bedrock' : formEdition;
    const v = s ? { ...DEFAULTS, ...s } : { ...DEFAULTS, ...EDITION_FORM[edition], name: `서버 ${(S?.servers.length || 0) + 1}`, javaVersion: S.java.latest || '' };
    $('#server-form-title').textContent = s ? '서버 편집' : '새 서버';
    $('#server-form-submit').textContent = s ? '저장' : '만들기';
    fillJavaVersions(form.elements.javaVersion, v.javaVersion);
    for (const el of form.elements) {
      if (!el.name || !(el.name in v)) continue;
      if (el.type === 'checkbox') el.checked = Boolean(v[el.name]);
      else el.value = v[el.name] ?? '';
    }
    for (const radio of $$('input[name="edition"]', form)) {
      radio.checked = radio.value === edition;
      radio.disabled = Boolean(s);
    }
    form.elements.agreeEula.checked = false;
    form.elements.levelSeed.disabled = Boolean(s);
    $('#seed-note').textContent = s ? '시드는 서버를 만들 때만 정할 수 있습니다.' : '월드를 처음 만들 때만 쓰입니다. 비우면 무작위입니다.';
    $('#server-form-error').hidden = true;
    $('#props-search').value = '';
    $('#props-changed').checked = false;
    $('#props-section').open = false;
    applyEdition(edition);
    loadProps(s?.extraProperties || {});
    $('#dlg-server').showModal();
    form.elements.name.focus();
    form.elements.name.select();
  }

  for (const radio of $$('#server-form input[name="edition"]')) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const f = $('#server-form').elements;
      applyEdition(radio.value, { resetDefaults: true });
      f.protect.checked = !f.protect.disabled;
      loadProps(collectPropsIfReady());
    });
  }
  $('#server-form').elements.javaVersion.addEventListener('change', () => {
    const f = $('#server-form').elements;
    const wasDisabled = f.protect.disabled;
    applyJavaVersion();
    if (wasDisabled && !f.protect.disabled) f.protect.checked = true;
    loadProps(collectPropsIfReady());
  });

  // ---------- all server.properties options ----------
  let propsSchema = null;
  let propsReady = false;
  let propsRequest = 0;

  const propsTarget = () => (formEdition === 'java'
    ? { edition: 'java', version: $('#server-form').elements.javaVersion.value }
    : { edition: 'bedrock', version: S?.bds.current });

  function collectPropsIfReady() {
    return propsReady ? collectProps() : (editingId ? serverById(editingId)?.extraProperties || {} : {});
  }

  async function loadProps(values) {
    propsReady = false;
    const req = ++propsRequest;
    const list = $('#props-list');
    $('#props-fixed').innerHTML = '';
    $('#props-count').textContent = '';
    const want = propsTarget();
    try {
      if (!propsSchema || propsSchema.edition !== want.edition || propsSchema.version !== want.version) {
        list.innerHTML = '<p class="props-empty">설정 목록을 불러오는 중…</p>';
        const qs = want.edition === 'java' ? `?edition=java&version=${encodeURIComponent(want.version || '')}` : '';
        const schema = await api('GET', `/api/server-properties${qs}`);
        if (req !== propsRequest) return;
        propsSchema = schema;
      }
    } catch (ex) {
      if (req === propsRequest) list.innerHTML = `<p class="props-empty">${esc(ex.message)}</p>`;
      return;
    }
    if (req !== propsRequest) return;
    renderProps(values);
    propsReady = true;
  }

  function propDefaultText(p) {
    if (p.default === '') return p.optional ? 'BDS 기본값' : '(비어 있음)';
    return p.optionLabels?.[p.default] ? `${p.optionLabels[p.default]} (${p.default})` : p.default;
  }

  function propControl(p, value) {
    const id = `prop-${p.key}`;
    if (p.type === 'bool' || p.type === 'enum') {
      const opts = [`<option value="">기본값 — ${esc(propDefaultText(p))}</option>`]
        .concat((p.type === 'bool' ? ['true', 'false'] : p.options).map((o) =>
          `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(p.optionLabels?.[o] ? `${p.optionLabels[o]} (${o})` : o)}</option>`));
      return `<select id="${esc(id)}" data-prop="${esc(p.key)}">${opts.join('')}</select>`;
    }
    const numeric = ['int', 'float'].includes(p.type);
    return `<input id="${esc(id)}" data-prop="${esc(p.key)}" value="${esc(value ?? '')}" placeholder="기본값: ${esc(propDefaultText(p))}"${numeric ? ' inputmode="decimal"' : ''} autocomplete="off" spellcheck="false">`;
  }

  function renderProps(values) {
    const s = propsSchema;
    const groups = s.groups.map((g) => {
      const rows = s.properties.filter((p) => p.group === g.id).map((p) => {
        const search = `${p.label} ${p.key} ${p.help} ${p.english}`.toLowerCase();
        const range = p.min !== undefined && p.max !== undefined ? ` · 범위 ${p.min}~${p.max}`
          : p.min !== undefined ? ` · ${p.min} 이상` : p.max !== undefined ? ` · ${p.max} 이하` : '';
        return `<div class="prop" data-key="${esc(p.key)}" data-search="${esc(search)}">
          <div class="prop-head"><label for="prop-${esc(p.key)}">${esc(p.label)}</label><span class="prop-badge" hidden>변경됨</span></div>
          ${propControl(p, values[p.key])}
          ${p.help ? `<div class="prop-help">${esc(p.help)}</div>` : ''}
          <div class="prop-meta"><code>${esc(p.key)}</code> · 기본값 ${esc(propDefaultText(p))}${range}</div>
          ${p.warn ? `<div class="prop-warn" hidden>⚠ ${esc(p.warn)}</div>` : ''}
        </div>`;
      });
      return rows.length ? `<section class="prop-group" data-group="${g.id}"><h5>${esc(g.label)}</h5><div class="prop-grid">${rows.join('')}</div></section>` : '';
    });
    $('#props-list').innerHTML = groups.join('');
    const managed = s.fixed.filter((f) => f.kind === 'managed');
    const basic = s.fixed.filter((f) => f.kind === 'basic');
    $('#props-fixed').innerHTML =
      `<div><b>포털이 관리하는 설정</b> — 여기서 바꿀 수 없습니다.</div>${managed.map((f) => `<div><code>${esc(f.key)}</code> · ${esc(f.reason)}</div>`).join('')}`
      + `<div><b>위 기본 설정에서 바꾸는 설정</b>: ${basic.map((f) => `<code>${esc(f.key)}</code>`).join(', ')}</div>`;
    for (const el of $$('[data-prop]', $('#props-list'))) updatePropRow(el);
    updatePropsCount();
  }

  function updatePropRow(el) {
    const row = el.closest('.prop');
    const p = propsSchema.properties.find((x) => x.key === el.dataset.prop);
    const changed = el.value.trim() !== '';
    row.classList.toggle('changed', changed);
    row.querySelector('.prop-badge').hidden = !changed;
    const warn = row.querySelector('.prop-warn');
    if (warn) warn.hidden = !(p.warnWhen && el.value.trim() === p.warnWhen);
  }

  function updatePropsCount() {
    const n = $$('[data-prop]', $('#props-list')).filter((el) => el.value.trim() !== '').length;
    $('#props-count').textContent = n ? `${n}개 변경` : '';
  }

  function filterProps() {
    const q = $('#props-search').value.trim().toLowerCase();
    const onlyChanged = $('#props-changed').checked;
    for (const row of $$('.prop', $('#props-list'))) {
      const match = (!q || row.dataset.search.includes(q)) && (!onlyChanged || row.classList.contains('changed'));
      row.hidden = !match;
    }
    for (const g of $$('.prop-group', $('#props-list'))) g.hidden = !$$('.prop', g).some((r) => !r.hidden);
  }

  $('#props-list').addEventListener('input', (e) => {
    if (!e.target.dataset.prop) return;
    updatePropRow(e.target);
    updatePropsCount();
  });
  $('#props-search').addEventListener('input', () => {
    if ($('#props-search').value) $('#props-section').open = true;
    filterProps();
  });
  $('#props-changed').addEventListener('change', filterProps);

  function collectProps() {
    const out = {};
    for (const el of $$('[data-prop]', $('#props-list'))) {
      const v = el.value.trim();
      if (v !== '') out[el.dataset.prop] = v;
    }
    return out;
  }

  $('#server-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = form.elements;
    const java = formEdition === 'java';
    const body = {
      name: f.name.value,
      gamemode: f.gamemode.value,
      difficulty: f.difficulty.value,
      maxPlayers: Number(f.maxPlayers.value),
      viewDistance: Number(f.viewDistance.value),
      protect: f.protect.checked,
      onlineMode: f.onlineMode.checked,
    };
    if (java) {
      body.javaVersion = f.javaVersion.value;
      body.memoryMB = Number(f.memoryMB.value);
      if (f.agreeEula.checked) body.agreeEula = true;
    } else {
      body.allowCheats = f.allowCheats.checked;
      body.lanVisibility = f.lanVisibility.checked;
      if (f.udpPortStart.value !== '') body.udpPortStart = Number(f.udpPortStart.value);
    }
    if (!editingId) body.edition = formEdition;
    if (f.port.value !== '') body.port = Number(f.port.value);
    if (!editingId) body.levelSeed = f.levelSeed.value;
    // Only send the option list once it has loaded, so a failed load can't wipe saved settings.
    if (propsReady) body.extraProperties = collectProps();
    const err = $('#server-form-error');
    err.hidden = true;
    const submit = $('#server-form-submit');
    submit.disabled = true;
    try {
      if (java && !S.eulaAcceptedAt && !body.agreeEula) throw new Error('Java 서버를 실행하려면 Minecraft EULA에 동의해야 합니다.');
      if (editingId) await api('PATCH', `/api/servers/${editingId}`, body);
      else await api('POST', '/api/servers', body);
      $('#dlg-server').close();
      toast(editingId ? '저장했습니다.' : '서버를 만들었습니다. 「실행」을 누르면 켜집니다.');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      // A rejected option names its key, e.g. "…(tick-distance): …" — show and focus that field.
      const key = ex.message.match(/\(([a-z][a-z0-9.-]*)\)/)?.[1];
      const field = key && $(`[data-prop="${CSS.escape(key)}"]`);
      if (field) {
        $('#props-section').open = true;
        $('#props-search').value = '';
        $('#props-changed').checked = false;
        filterProps();
        field.focus();
        field.scrollIntoView({ block: 'center' });
        toast(ex.message, 'error'); // the error line under the form is out of view once we scroll to the field
      }
    } finally {
      submit.disabled = false;
    }
  });

  // ---------- settings ----------
  function openSettings(scrollToBds) {
    const st = S.settings;
    const sz = sizing(st.estRamPerServerGB);
    const range = $('#max-range');
    range.max = sz.hardMax;
    range.value = st.maxConcurrent ?? sz.recommended;
    $('#max-auto').checked = st.maxConcurrent === null;
    $('#est-ram').value = st.estRamPerServerGB;
    $('#public-host').value = st.publicHost || '';
    $('#port-base').value = st.portBase;
    $('#udp-base').value = st.udpPortBase;
    $('#java-port-base').value = st.javaPortBase;
    $('#java-eula').checked = false;
    fillJavaVersions($('#java-pick'), null);
    $('#java-pick').value = S.java.latest || $('#java-pick').value;
    $('#auth-timeout').value = st.authTimeoutSec;
    $('#auth-fails').value = st.authMaxFails;

    const cands = S.hosts.lanCandidates;
    const options = [`<option value="">자동 (${esc(cands[0]?.address || '감지 실패')})</option>`]
      .concat(cands.map((c) => `<option value="${esc(c.address)}">${esc(c.address)} — ${esc(c.iface)}${c.virtual ? ' (가상)' : ''}</option>`));
    if (st.lanHost && !cands.some((c) => c.address === st.lanHost)) options.push(`<option value="${esc(st.lanHost)}">${esc(st.lanHost)}</option>`);
    $('#lan-host').innerHTML = options.join('');
    $('#lan-host').value = st.lanHost || '';
    $('#settings-error').hidden = true;
    $('#bds-eula').checked = false;
    renderSettingsLive();
    $('#dlg-settings').showModal();
    if (scrollToBds) $('#bds-section').scrollIntoView({ block: 'start' });
  }

  function renderSettingsLive() {
    const sz = sizing($('#est-ram').value);
    const range = $('#max-range');
    const auto = $('#max-auto').checked;
    range.max = sz.hardMax;
    if (auto) range.value = sz.recommended;
    range.disabled = auto;
    $('#max-out').textContent = `${range.value}대`;
    $('#max-scale').innerHTML = `<span>1</span><span class="rec">권장 ${sz.recommended}</span><span>최대 ${sz.hardMax}</span>`;
    const recPos = sz.hardMax > 1 ? ((sz.recommended - 1) / (sz.hardMax - 1)) * 100 : 0;
    $('#max-scale .rec').style.left = `${recPos}%`;
    $('#sizing-text').textContent =
      `RAM ${sz.total.toFixed(0)}GB 중 시스템용 ${sz.reserve.toFixed(1)}GB를 빼고 서버당 ${sz.est}GB로 계산하면 ${sz.memMax}대, `
      + `CPU ${sz.threads}스레드를 서버당 2스레드로 계산하면 ${sz.cpuMax}대입니다. 둘 중 작은 ${sz.recommended}대를 권장합니다.`;
    const running = S.servers.filter((s) => s.runtime.memBytes);
    $('#est-ram-note').textContent = running.length
      ? `지금 실행 중인 서버는 평균 ${fmtMem(running.reduce((a, s) => a + s.runtime.memBytes, 0) / running.length)}를 쓰고 있어요. 접속자가 많고 멀리 탐험할수록 늘어납니다.`
      : '빈 서버는 400MB 정도로 시작하지만, 접속자가 많고 멀리 탐험할수록 1~2GB까지 늘어납니다.';

    const fw = firewallStatus();
    patch($('#fw-status'), fw
      ? `<span>${fw[1]}</span><button class="btn sm" type="button" data-action="fw-check"${S.firewall.checking ? ' disabled' : ''}>다시 확인</button>`
      : '');
    $('#fw-status').className = `fw-status ${fw ? fw[0] : ''}`;
    $('#fw-status').hidden = !fw;

    const b = S.bds;
    const t = b.task;
    const busy = bdsBusy();
    let status = `<div class="bds-status"><div>현재 사용 중: <b>${b.current ? `BDS ${esc(b.current)}` : '설치되지 않음'}</b>`
      + `${b.latest ? ` · 최신: ${esc(b.latest)}${b.updateAvailable ? ' <span class="chip warn">업데이트 있음</span>' : b.current ? ' (최신 버전입니다)' : ''}` : ''}</div>`;
    if (b.latestError) status += `<div class="muted">${esc(b.latestError)}</div>`;
    if (busy) {
      status += `<div>${t.phase === 'download' ? `내려받는 중 ${t.percent}% (${t.receivedMB || 0} MB)` : '압축 푸는 중…'}</div><div class="bar"><span data-w="${t.phase === 'download' ? t.percent : 100}"></span></div>`;
    } else if (t?.phase === 'error') {
      status += `<div class="form-error">${esc(t.error)}</div>`;
    } else if (t?.phase === 'done') {
      status += `<div class="muted">BDS ${esc(t.version)} 준비 완료.</div>`;
    }
    status += '</div>';
    patch($('#bds-status'), status);

    const sel = $('#bds-current');
    const opts = b.installed.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('') || '<option value="">없음</option>';
    if (htmlCache.get(sel) !== opts) {
      sel.innerHTML = opts;
      htmlCache.set(sel, opts);
    }
    if (document.activeElement !== sel) sel.value = b.current || '';
    sel.disabled = b.installed.length < 2;
    const install = $('#bds-install');
    const upToDate = Boolean(b.current && b.latest && b.current === b.latest);
    install.textContent = busy ? '설치 중…' : upToDate ? '최신 버전이 설치되어 있습니다' : b.latest ? `BDS ${b.latest} 내려받기` : '최신 버전 내려받기';
    install.disabled = busy || upToDate || !$('#bds-eula').checked;
    renderJavaSettings();
  }

  function renderJavaSettings() {
    const j = S.java;
    const uses = (v) => S.servers.filter((s) => isJava(s) && s.javaVersion === v).length;
    let html = '<div class="bds-status">';
    if (!j.platformSupported) html += '<div class="form-error">Mojang이 이 운영체제용 Java 실행 환경을 제공하지 않아 Java 서버를 실행할 수 없습니다.</div>';
    html += `<div>최신 릴리스: <b>${j.latest ? `Java Edition ${esc(j.latest)}` : '확인 못 함'}</b> · 고를 수 있는 버전 ${esc(j.minVersion)} 이상 (비밀번호 보호는 ${esc(j.protectMinVersion)} 이상)</div>`;
    if (j.error) html += `<div class="muted">${esc(j.error)}</div>`;
    html += `<div>받아 둔 버전: ${j.installed.length
      ? j.installed.map((v) => `<span class="chip">${esc(v)}${uses(v) ? ` · 서버 ${uses(v)}개` : ''}</span>`).join(' ')
      : '<span class="muted">없음</span>'}</div>`;
    if (j.runtimes.length) {
      html += `<div class="muted">Java 실행 환경: ${j.runtimes.map((r) => `Java ${esc(r.version || r.component)}`).join(', ')}</div>`;
    }
    for (const t of Object.values(j.tasks)) {
      if (t.phase === 'download' || t.phase === 'extract') {
        html += `<div>Java ${esc(t.version)}: ${esc(javaTaskText(t))}</div><div class="bar"><span data-w="${t.phase === 'download' ? t.percent : 100}"></span></div>`;
      } else if (t.phase === 'error') {
        html += `<div class="form-error">Java ${esc(t.version)} 내려받기 실패: ${esc(t.error)}</div>`;
      }
    }
    html += `<div class="muted">${S.eulaAcceptedAt ? `Minecraft EULA 동의함 (${esc(new Date(S.eulaAcceptedAt).toLocaleDateString('ko-KR'))})` : 'Minecraft EULA에 아직 동의하지 않았습니다.'}</div>`;
    html += '</div>';
    patch($('#java-status'), html);
    $('#java-eula-row').hidden = Boolean(S.eulaAcceptedAt);
    const pick = $('#java-pick').value;
    const busy = Boolean(j.tasks[pick] && (j.tasks[pick].phase === 'download' || j.tasks[pick].phase === 'extract'));
    const btn = $('#java-install');
    btn.textContent = busy ? '내려받는 중…' : j.installed.includes(pick) ? '받아 둔 버전입니다' : `Java ${pick} 내려받기`;
    btn.disabled = !pick || busy || j.installed.includes(pick) || !j.platformSupported || (!S.eulaAcceptedAt && !$('#java-eula').checked);
  }

  for (const id of ['#est-ram', '#max-range', '#max-auto', '#bds-eula']) {
    $(id).addEventListener('input', renderSettingsLive);
  }
  $('#java-eula').addEventListener('input', renderJavaSettings);
  $('#java-pick').addEventListener('change', renderJavaSettings);
  $('#java-check').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const v = await api('GET', '/api/java/versions');
    fillJavaVersions($('#java-pick'), $('#java-pick').value);
    toast(`Java Edition 최신 릴리스는 ${v.latest}입니다.`);
  }));
  $('#java-install').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const version = $('#java-pick').value;
    await api('POST', '/api/java/install', { version, agreeEula: $('#java-eula').checked });
    toast(`Java ${version} 내려받기를 시작했습니다.`);
  }));

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#settings-error');
    err.hidden = true;
    try {
      await api('PUT', '/api/settings', {
        estRamPerServerGB: Number($('#est-ram').value),
        maxConcurrent: $('#max-auto').checked ? null : Number($('#max-range').value),
        lanHost: $('#lan-host').value,
        publicHost: $('#public-host').value,
        portBase: Number($('#port-base').value),
        udpPortBase: Number($('#udp-base').value),
        javaPortBase: Number($('#java-port-base').value),
        authTimeoutSec: Number($('#auth-timeout').value),
        authMaxFails: Number($('#auth-fails').value),
      });
      toast('설정을 저장했습니다.');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $('#bds-current').addEventListener('change', (e) => withBusy(null, async () => {
    await api('PUT', '/api/bds/current', { version: e.target.value });
    toast(`이제 BDS ${e.target.value}를 사용합니다. 서버를 다시 실행하면 적용됩니다.`);
  }));
  $('#bds-check').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    const v = await api('GET', '/api/bds/latest');
    toast(v.updateAvailable ? `새 버전 ${v.latest}이 있습니다.` : `최신 버전(${v.latest})을 사용 중입니다.`);
  }));
  $('#bds-install').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
    await api('POST', '/api/bds/install', { agreeEula: $('#bds-eula').checked });
    toast('서버 프로그램 설치를 시작했습니다.');
  }));

  $('#pw-form').addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy(null, async () => {
      await api('POST', '/api/auth/password', { current: $('#pw-current').value, next: $('#pw-next').value });
      $('#pw-current').value = '';
      $('#pw-next').value = '';
      toast('관리자 비밀번호를 바꿨습니다.');
    });
  });

  // ---------- console ----------
  let consoleId = null;
  let consoleSeq = 0;
  let consoleLoading = false;
  let consoleBuffer = [];

  function classify(text) {
    if (text.startsWith('[포털]')) return 'l-portal';
    if (text.startsWith('> ')) return 'l-cmd';
    if (/\[Scripting\] MCF_/.test(text)) return 'l-script';
    // Bedrock: "[… ERROR]", Java: "[Server thread/ERROR]".
    if (/[ /](ERROR|FATAL)\]|Exception|Crash/.test(text)) return 'l-error';
    if (/[ /]WARN\]/.test(text)) return 'l-warn';
    return '';
  }

  function appendLogs(lines) {
    const box = $('#console-log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      if (l.seq <= consoleSeq) continue;
      consoleSeq = l.seq;
      const div = document.createElement('div');
      div.textContent = l.text.length > 600 ? `${l.text.slice(0, 600)} …` : l.text;
      div.className = classify(l.text);
      frag.appendChild(div);
    }
    box.appendChild(frag);
    while (box.childElementCount > 1500) box.firstElementChild.remove();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderConsoleMeta() {
    const s = serverById(consoleId);
    if (!s) {
      $('#dlg-console').close();
      return;
    }
    const r = s.runtime;
    const st = STATUS[r.status] || STATUS.stopped;
    $('#console-title').textContent = s.name;
    patch($('#console-status'), `<span class="pill ${st.cls}">${st.label}</span>`);
    const live = r.status === 'running' || r.status === 'starting';
    const players = r.players.map((p) => `<span class="player${p.verified ? '' : ' waiting'}">${p.verified ? ICON.check : ICON.clock}${esc(p.name)}
        <button class="icon-btn" type="button" data-action="kick" data-id="${s.id}" data-name="${esc(p.name)}" title="내보내기" aria-label="${esc(p.name)} 내보내기">${ICON.x}</button></span>`).join('');
    patch($('#console-players'), live
      ? `<span class="players-label">접속 중 ${r.players.length} / ${s.maxPlayers}</span>${players || '<span class="muted">접속한 플레이어가 없습니다</span>'}`
      : '<span class="muted">서버가 실행 중일 때 명령어를 보낼 수 있습니다. 아래는 마지막 실행의 로그입니다.</span>');
    $('#console-input').disabled = !live;
    $('#console-form button').disabled = !live;
  }

  async function openConsole(id) {
    consoleId = id;
    consoleSeq = 0;
    consoleBuffer = [];
    consoleLoading = true;
    $('#console-log').textContent = '';
    renderConsoleMeta();
    $('#dlg-console').showModal();
    try {
      const { lines } = await api('GET', `/api/servers/${id}/logs`);
      appendLogs(lines);
      appendLogs(consoleBuffer);
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      consoleLoading = false;
      consoleBuffer = [];
    }
    const box = $('#console-log');
    box.scrollTop = box.scrollHeight;
    if (!$('#console-input').disabled) $('#console-input').focus();
  }

  $('#dlg-console').addEventListener('close', () => {
    consoleId = null;
  });

  $('#console-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#console-input');
    const command = input.value.trim();
    if (!command || !consoleId) return;
    withBusy(null, async () => {
      await api('POST', `/api/servers/${consoleId}/command`, { command });
      input.value = '';
    });
  });

  // ---------- boot ----------
  setInterval(() => S && renderServers(), 30000);

  (async () => {
    try {
      const st = await api('GET', '/api/auth/status');
      if (st.setupRequired) showAuth('setup');
      else if (!st.authenticated) showAuth('login');
      else showApp();
    } catch (ex) {
      document.body.textContent = `포털에 연결할 수 없습니다: ${ex.message}`;
    }
  })();
})();
