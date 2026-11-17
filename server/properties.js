'use strict';
const fs = require('fs');
const path = require('path');
const { BDS_DIR, JAVA_VERSIONS_DIR } = require('./paths');
const { HttpError } = require('./util');

// Every server.properties option, built from the server.properties that ships with the installed BDS version
// (so options added in future versions show up automatically, with Mojang's English description), plus Korean
// names/help and value rules for the options known today. Java Edition: see the second half of this file.

const GROUPS = [
  ['gameplay', '게임플레이'],
  ['players', '플레이어·권한'],
  ['world', '월드·틱 영역'],
  ['performance', '성능'],
  ['network', '네트워크'],
  ['anticheat', '서버 검증 (치트 방지)'],
  ['content', '콘텐츠·로그'],
  ['scripting', '스크립트·디버거'],
  ['misc', '기타'],
];

// Set by the portal itself; shown read-only with the reason.
const MANAGED = {
  'server-port': '서버 편집의 「포트」에서 정합니다.',
  'server-portv6': '포털이 「포트 + 1」로 정합니다.',
  'server-udp-ports': '서버 편집의 「게임용 UDP 시작 포트」에서 정합니다 (16개 범위).',
  transport: '이 BDS 버전에서 플레이어가 접속할 수 있는 방식은 NetherNet뿐입니다.',
  'level-name': '포털이 월드 폴더 이름을 world로 고정합니다.',
  'content-log-console-output-enabled': '비밀번호 스크립트가 포털에 소식을 전하는 데 필요해서 항상 켜 둡니다.',
};

// Options that have their own field in the basic part of the server form.
const BASIC = {
  'server-name': '서버 이름',
  gamemode: '게임 모드',
  difficulty: '난이도',
  'allow-cheats': '치트 허용',
  'max-players': '최대 인원',
  'online-mode': 'Xbox 계정 인증',
  'view-distance': '최대 시야 거리',
  'level-seed': '월드 시드',
  'enable-lan-visibility': 'LAN에 서버 표시',
};

// Where the portal's default differs from the file BDS ships with.
const PORTAL_DEFAULTS = {
  'allow-list': 'false', // the password check protects the server; an empty allow list would lock everyone out
  'default-player-permission-level': 'member',
};

const ON_OFF = { true: '켜기', false: '끄기' };
const VALIDATION_MODES = { disabled: '끄기', observe: '기록만', enforce: '강제' };

const META = {
  'force-gamemode': { group: 'gameplay', type: 'bool', label: '게임 모드 강제', help: '켜면 월드를 만든 뒤 바꾼 게임 모드도 플레이어에게 적용합니다. 끄면 월드를 처음 만들 때의 게임 모드를 유지합니다.' },
  'allow-list': { group: 'players', type: 'bool', label: '허용 목록(allowlist)만 접속', help: '켜면 allowlist.json에 등록된 게이머태그만 들어올 수 있습니다. 콘솔에서 allowlist add <게이머태그>로 추가하세요. 포털은 비밀번호로 보호하므로 기본은 꺼짐입니다.', warnWhen: 'true', warn: '허용 목록에 아무도 없으면 아무도 접속할 수 없습니다.' },
  'default-player-permission-level': { group: 'players', type: 'enum', options: ['visitor', 'member', 'operator'], optionLabels: { visitor: '방문자 (구경만 가능)', member: '멤버', operator: '관리자 (OP)' }, label: '처음 들어온 플레이어의 권한', help: '처음 접속한 플레이어가 받는 권한입니다. 관리자로 두면 누구나 명령어를 쓸 수 있습니다.', warnWhen: 'operator', warn: '모든 새 플레이어가 관리자 권한을 받습니다.' },
  'allow-player-joining': { group: 'players', type: 'bool', label: '플레이어 접속 허용', help: '끄면 스크립트가 따로 허락하지 않는 한 아무도 접속할 수 없습니다.', warnWhen: 'false', warn: '끄면 아무도 접속할 수 없습니다.' },
  'player-idle-timeout': { group: 'players', type: 'int', min: 0, label: '잠수 강퇴 시간 (분)', help: '이 시간 동안 아무것도 하지 않으면 강퇴됩니다. 0이면 강퇴하지 않습니다.' },
  'chat-restriction': { group: 'players', type: 'enum', options: ['None', 'Dropped', 'Disabled'], optionLabels: { None: '제한 없음', Dropped: '메시지 전달 안 함', Disabled: '채팅 기능 끄기' }, label: '채팅 제한', help: '「메시지 전달 안 함」은 채팅이 아무에게도 전달되지 않고, 「채팅 기능 끄기」는 채팅 창 자체를 쓸 수 없습니다.' },
  'disable-player-interaction': { group: 'players', type: 'bool', label: '다른 플레이어 무시', help: '켜면 월드와 상호작용할 때 다른 플레이어를 무시하라고 클라이언트에 알립니다 (서버가 강제하지는 않음).' },
  'disable-custom-skins': { group: 'players', type: 'bool', label: '직접 만든 스킨 금지', help: '마켓플레이스나 게임 기본 에셋이 아닌, 직접 만든 스킨을 쓰지 못하게 합니다.' },
  'disable-persona': { group: 'misc', type: 'bool', label: '페르소나 끄기 (Mojang 내부용)', help: 'Mojang 내부용 설정이라 보통 바꿀 필요가 없습니다.' },
  'texturepack-required': { group: 'content', type: 'bool', label: '리소스 팩 필수', help: '월드에 적용된 리소스 팩을 받아야만 접속할 수 있게 합니다.' },
  'tick-distance': { group: 'world', type: 'int', min: 4, max: 12, label: '시뮬레이션 거리 (청크)', help: '플레이어 주변 몇 청크까지 월드가 움직일지 (작물 성장, 몹, 레드스톤 등). 높을수록 서버 부담이 커집니다.' },
  'persistent-ticking-area-max-count': { group: 'world', type: 'intOrUnlimited', min: 1, max: 2147483647, label: '고정 틱 영역 최대 개수', help: '/tickingarea로 만들 수 있는 고정 영역 수의 한도입니다. unlimited 입력 가능. 줄여도 이미 만든 영역은 남습니다.' },
  'persistent-ticking-area-max-chunks': { group: 'world', type: 'intOrUnlimited', min: 1, max: 2147483647, label: '고정 틱 영역 하나의 최대 청크 수', help: 'unlimited 입력 가능. 줄여도 이미 만든 영역은 남습니다.' },
  'transient-ticking-area-max-chunks': { group: 'world', type: 'intOrUnlimited', min: 1, max: 2147483647, label: '임시 틱 영역 최대 청크 수 (팩별)', help: '애드온(행동 팩)마다 쓸 수 있는 임시 틱 영역 청크 수의 합계 한도입니다. 높이거나 unlimited로 하면 성능과 메모리에 크게 영향을 줄 수 있습니다.' },
  'max-threads': { group: 'performance', type: 'int', min: 0, label: '최대 스레드 수', help: '서버 하나가 쓸 최대 스레드 수입니다. 0이면 가능한 만큼 씁니다. 여러 서버를 동시에 돌린다면 너무 높이지 마세요.' },
  'client-side-chunk-generation-enabled': { group: 'performance', type: 'bool', label: '플레이어 기기에서 먼 청크 그리기', help: '켜면 상호작용 거리 밖의 보이기만 하는 청크를 플레이어 기기가 직접 만들어 서버 부담이 줄어듭니다.' },
  'server-build-radius-ratio': { group: 'performance', type: 'disabledOrRatio', label: '서버가 만들 시야 비율', help: 'Disabled면 서버가 알아서 정합니다. 0.0~1.0을 넣으면 플레이어 시야 중 서버가 만들 비율을 고정합니다 (위 설정이 켜져 있을 때만 의미 있음).' },
  'compression-threshold': { group: 'network', type: 'int', min: 0, max: 65535, label: '압축 최소 크기 (바이트)', help: '이보다 큰 네트워크 데이터만 압축합니다. CPU와 대역폭 사이의 균형을 조절합니다.' },
  'compression-algorithm': { group: 'network', type: 'enum', options: ['zlib', 'snappy'], label: '네트워크 압축 방식', help: 'snappy는 CPU를 덜 쓰고 대역폭을 조금 더 씁니다.' },
  'server-ip': { group: 'network', type: 'ip', label: '서버가 열릴 주소', help: '비우면 모든 네트워크에서 접속을 받습니다 (권장). 특정 IPv4/IPv6 주소에서만 받으려면 입력하세요.' },
  'block-network-ids-are-hashes': { group: 'network', type: 'bool', label: '블록 ID를 해시로 전송', help: '블록 ID를 바뀌지 않는 해시값으로 보냅니다. 보통 그대로 두세요.' },
  'server-authoritative-movement-strict': { group: 'anticheat', type: 'bool', label: '이동 엄격하게 검증', help: '플레이어 위치를 더 엄격하게 확인합니다. 지연이 큰 플레이어는 위치 보정(뒤로 끌려감)을 더 자주 겪습니다.' },
  'server-authoritative-dismount-strict': { group: 'anticheat', type: 'bool', label: '탈것에서 내린 위치 엄격하게 검증' },
  'server-authoritative-entity-interactions-strict': { group: 'anticheat', type: 'bool', label: '엔티티 상호작용 엄격하게 검증', help: '지연이 큰 상황에서 플레이어끼리의 상호작용이 영향을 받을 수 있습니다.' },
  'server-authoritative-entity-attack-request-validation': { group: 'anticheat', type: 'enum', options: ['disabled', 'observe', 'enforce'], optionLabels: VALIDATION_MODES, label: '공격 요청 검증', help: '공격 요청이 들고 있는 아이템의 동작과 맞는지 확인합니다.' },
  'server-authoritative-entity-attack-range-validation': { group: 'anticheat', type: 'enum', options: ['disabled', 'observe', 'enforce'], optionLabels: VALIDATION_MODES, label: '공격 사거리 검증' },
  'server-authoritative-entity-attack-range-tolerance': { group: 'anticheat', type: 'float', min: 0, label: '공격 사거리 허용 오차 (블록)', help: '정상 공격 사거리보다 이만큼 더 먼 공격까지 허용합니다.' },
  'player-position-acceptance-threshold': { group: 'anticheat', type: 'float', min: 0, label: '위치 차이 허용 범위', help: '플레이어 기기와 서버가 생각하는 위치의 차이를 얼마나 허용할지입니다. 높이면 보정이 줄지만 너무 높으면 치트가 쉬워집니다.' },
  'player-movement-action-direction-threshold': { group: 'anticheat', type: 'float', min: 0, max: 1, label: '공격 방향과 시선 일치도', help: '1이면 공격 방향과 바라보는 방향이 정확히 같아야 하고, 0이면 90도까지 달라도 됩니다.' },
  'server-authoritative-block-breaking-pick-range-scalar': { group: 'anticheat', type: 'float', min: 0, label: '블록 부수기 사거리 배율', help: '서버가 블록 부수기를 확인할 때 허용하는 사거리 배율입니다.' },
  'content-log-file-enabled': { group: 'content', type: 'bool', label: '콘텐츠 오류를 파일로 기록', help: '애드온 등의 콘텐츠 오류를 파일로도 남깁니다.' },
  'content-log-level': { group: 'content', type: 'enum', options: ['error', 'warning', 'info', 'verbose'], optionLabels: { error: '오류만', warning: '경고 이상', info: '정보 이상', verbose: '전부 (자세히)' }, label: '콘텐츠 로그 수준' },
  'disable-client-vibrant-visuals': { group: 'misc', type: 'bool', label: 'Vibrant Visuals 대신 다른 그래픽 쓰기', help: '켜면 플레이어 기기에 Vibrant Visuals 대신 그다음 그래픽 설정을 쓰라고 알립니다.' },
  'allow-outbound-script-debugging': { group: 'scripting', type: 'bool', label: '스크립트 디버거: connect 허용' },
  'allow-inbound-script-debugging': { group: 'scripting', type: 'bool', label: '스크립트 디버거: listen 허용' },
  'force-inbound-debug-port': { group: 'scripting', type: 'int', min: 1, max: 65535, label: '디버거 listen 포트' },
  'script-debugger-listen-address': { group: 'scripting', type: 'ip', label: '디버거 listen 주소', help: '기본은 이 PC에서만(127.0.0.1). 다른 주소는 네트워크에 디버깅 권한을 여는 것이므로 passcode가 필요합니다.' },
  'script-debugger-auto-attach': { group: 'scripting', type: 'enum', options: ['disabled', 'connect', 'listen'], optionLabels: { disabled: '안 함', connect: 'connect', listen: 'listen' }, label: '월드 로드 때 디버거 자동 연결' },
  'script-debugger-auto-attach-connect-address': { group: 'scripting', type: 'string', label: '자동 연결 주소 (호스트:포트)' },
  'script-debugger-auto-attach-timeout': { group: 'scripting', type: 'int', min: 0, label: '디버거 연결 대기 시간' },
  'script-debugger-passcode': { group: 'scripting', type: 'string', label: '디버거 passcode' },
  'script-watchdog-enable': { group: 'scripting', type: 'bool', label: '스크립트 감시(watchdog) 사용' },
  'script-watchdog-enable-exception-handling': { group: 'scripting', type: 'bool', label: '감시 예외 처리 이벤트 사용' },
  'script-watchdog-enable-shutdown': { group: 'scripting', type: 'bool', label: '처리 안 된 감시 예외 때 서버 종료' },
  'script-watchdog-hang-exception': { group: 'scripting', type: 'bool', label: '스크립트 멈춤 때 예외 발생' },
  'script-watchdog-hang-threshold': { group: 'scripting', type: 'int', min: 1, label: '멈춤 판정 시간 (ms)' },
  'script-watchdog-spike-threshold': { group: 'scripting', type: 'int', min: 1, label: '순간 지연 경고 기준 (ms)' },
  'script-watchdog-slow-threshold': { group: 'scripting', type: 'int', min: 1, label: '느린 스크립트 경고 기준 (ms)' },
  'script-watchdog-memory-warning': { group: 'scripting', type: 'int', min: 0, max: 2000, label: '스크립트 메모리 경고 (MB)', help: '0이면 경고하지 않습니다.' },
  'script-watchdog-memory-limit': { group: 'scripting', type: 'int', min: 0, max: 2000, label: '스크립트 메모리 한도 (MB)', help: '넘으면 월드를 저장하고 서버를 끕니다. 0이면 한도 없음.' },
  'diagnostics-capture-auto-start': { group: 'misc', type: 'bool', label: '월드 로드 때 진단 기록 시작' },
  'diagnostics-capture-max-files': { group: 'misc', type: 'int', min: 1, label: '진단 기록 파일 최대 개수' },
  'diagnostics-capture-max-file-size': { group: 'misc', type: 'int', min: 1, label: '진단 기록 파일 최대 크기 (바이트)' },
  'sentry-rate-limit-window': { group: 'misc', type: 'int', min: 0, label: '스크립트 오류 보고 제한 시간 (초)', help: '0이면 제한하지 않습니다.' },
  'sentry-max-events-per-window': { group: 'misc', type: 'int', min: 0, label: '제한 시간당 최대 오류 보고 수', help: '0이면 보고하지 않습니다.' },
  'enable-profiler': { group: 'misc', type: 'bool', label: '프로파일러 지원' },
  'enable-editor-network-metrics': { group: 'misc', type: 'bool', label: '에디터 네트워크 지표 수집' },
  'convert-world-to-editor-project': { group: 'misc', type: 'bool', label: '월드를 에디터 프로젝트로 변환', help: 'Editor=true로 실행할 때만 의미가 있습니다. 포털에서는 쓰지 않습니다.' },
};

const PROP_LINE = /^([a-z][a-z0-9.-]*)=(.*)$/;
const COMMENTED_PROP = /^#\s*([a-z][a-z0-9.-]*)=(\S*)\s*$/;

// Reads key/default/description triples. Commented-out "# key=value" lines are optional options (BDS uses its
// built-in default until set); commented lines with prose after the value are examples and are skipped.
function parseTemplate(text) {
  const props = [];
  const seen = new Set();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m = line.match(PROP_LINE);
    if (m && !seen.has(m[1])) {
      cur = { key: m[1], default: m[2].trim(), optional: false, desc: [] };
      seen.add(m[1]);
      props.push(cur);
      continue;
    }
    m = line.match(COMMENTED_PROP);
    if (m) {
      if (seen.has(m[1])) { cur = null; continue; }
      cur = { key: m[1], default: m[2], optional: true, desc: [] };
      seen.add(m[1]);
      props.push(cur);
      continue;
    }
    if (cur && line.startsWith('#')) {
      const text2 = line.replace(/^#\s?/, '').trim();
      if (/^[a-z][a-z0-9.-]*=/.test(text2)) continue; // an example line
      if (text2) cur.desc.push(text2);
    } else if (!line.trim()) {
      cur = null;
    }
  }
  return props;
}

// For options this file has no rules for (new in a later BDS version).
function inferType(p) {
  const allowed = p.desc.find((d) => /^Allowed values:/i.test(d)) || '';
  const quoted = [...allowed.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (/true/.test(allowed) && /false/.test(allowed)) return { type: 'bool' };
  if (p.default === 'true' || p.default === 'false') return { type: 'bool' };
  if (quoted.length >= 2) return { type: 'enum', options: quoted };
  if (/^-?\d+$/.test(p.default)) return { type: 'int' };
  if (/^-?\d*\.\d+$/.test(p.default)) return { type: 'float' };
  return { type: 'string' };
}

const cache = new Map();

function schema(edition, version) {
  if (edition === 'java') return javaSchema(version);
  if (!version) return null;
  if (cache.has(version)) return cache.get(version);
  const file = path.join(BDS_DIR, version, 'server.properties');
  const parsed = parseTemplate(fs.readFileSync(file, 'utf8'));
  const properties = [];
  const fixed = [];
  for (const p of parsed) {
    const english = p.desc.filter((d) => !/^(Allowed values|Default):/i.test(d)).join(' ');
    if (MANAGED[p.key]) { fixed.push({ key: p.key, kind: 'managed', reason: MANAGED[p.key] }); continue; }
    if (BASIC[p.key]) { fixed.push({ key: p.key, kind: 'basic', reason: `기본 설정의 「${BASIC[p.key]}」에서 바꿉니다.` }); continue; }
    const meta = META[p.key] || { group: 'misc', ...inferType(p) };
    properties.push({
      key: p.key,
      default: PORTAL_DEFAULTS[p.key] ?? p.default,
      optional: p.optional,
      type: meta.type,
      options: meta.options,
      optionLabels: meta.optionLabels || (meta.type === 'bool' ? ON_OFF : undefined),
      min: meta.min,
      max: meta.max,
      label: meta.label || p.key,
      help: meta.help || english,
      english,
      group: meta.group || 'misc',
      warnWhen: meta.warnWhen,
      warn: meta.warn,
    });
  }
  const result = { edition: 'bedrock', version, groups: GROUPS.map(([id, label]) => ({ id, label })), properties, fixed };
  cache.set(version, result);
  return result;
}

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

function checkValue(p, value) {
  const bad = (why) => new HttpError(400, `「${p.label}」(${p.key}): ${why}`);
  const num = Number(value);
  const inRange = (n) => (p.min === undefined || n >= p.min) && (p.max === undefined || n <= p.max);
  const range = () => (p.min !== undefined && p.max !== undefined ? `${p.min}~${p.max}` : p.min !== undefined ? `${p.min} 이상` : `${p.max} 이하`);
  switch (p.type) {
    case 'bool':
      if (value !== 'true' && value !== 'false') throw bad('켜기 또는 끄기만 고를 수 있습니다.');
      return value;
    case 'enum':
      if (!p.options.includes(value)) throw bad(`${p.options.join(', ')} 중 하나여야 합니다.`);
      return value;
    case 'intOrUnlimited':
      if (value.toLowerCase() === 'unlimited') return 'unlimited';
    // falls through
    case 'int':
      if (!/^-?\d+$/.test(value) || !inRange(num)) throw bad(`정수${p.min !== undefined || p.max !== undefined ? ` (${range()})` : ''}여야 합니다.`);
      return String(num);
    case 'float':
      if (value === '' || !Number.isFinite(num) || !inRange(num)) throw bad(`숫자${p.min !== undefined || p.max !== undefined ? ` (${range()})` : ''}여야 합니다.`);
      return value;
    case 'disabledOrRatio':
      if (value.toLowerCase() === 'disabled') return 'Disabled';
      if (!Number.isFinite(num) || num < 0 || num > 1) throw bad('Disabled 또는 0.0~1.0 사이 숫자여야 합니다.');
      return value;
    case 'ip':
      if (!IP_LITERAL.test(value)) throw bad('IPv4 또는 IPv6 주소여야 합니다.');
      return value;
    default:
      if (value.length > 200) throw bad('200자 이하로 입력하세요.');
      return value;
  }
}

// Checks user-supplied overrides against the schema of the given server version. Empty values mean "use the
// default" and are dropped, so only real changes are stored.
function validate(edition, version, input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '서버 설정 형식이 올바르지 않습니다.');
  const java = edition === 'java';
  const s = schema(edition, version);
  if (!s) {
    // Nothing to check against yet (Java version not downloaded): only "no changes" can be saved.
    if (Object.values(input).every((v) => String(v ?? '').trim() === '')) return {};
    throw new HttpError(409, java
      ? `Java ${version} 서버 프로그램을 내려받은 뒤에 상세 설정을 바꿀 수 있습니다 (처음 실행할 때 자동으로 받습니다).`
      : '서버 프로그램(BDS)이 설치되어 있어야 상세 설정을 저장할 수 있습니다.');
  }
  const fixed = new Set(s.fixed.map((f) => f.key));
  const byKey = new Map(s.properties.map((p) => [p.key, p]));
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    if (fixed.has(key) || (!java && (MANAGED[key] || BASIC[key]))) throw new HttpError(400, `${key}는 여기서 바꿀 수 없습니다.`);
    const p = byKey.get(key);
    if (!p) throw new HttpError(400, `이 ${java ? 'Java' : 'BDS'} 버전에 없는 설정입니다: ${key}`);
    const value = String(raw ?? '').trim();
    if (/[\r\n]/.test(value)) throw new HttpError(400, `${key}: 줄바꿈은 쓸 수 없습니다.`);
    if (value === '') continue;
    out[key] = checkValue(p, value);
  }
  return out;
}

// ---------- Java Edition ----------
//
// Java servers don't ship a commented server.properties. The installer asks each version's server jar for its
// defaults (--initSettings), so the list matches that version exactly; known options get Korean names here, and
// new ones show up with their key and a type guessed from the default.

const JAVA_GROUPS = [
  ['gameplay', '게임플레이'],
  ['world', '월드 생성'],
  ['players', '플레이어·권한'],
  ['performance', '성능'],
  ['network', '네트워크·채팅'],
  ['resourcepack', '리소스 팩'],
  ['remote', '원격 관리 (RCON·쿼리·관리 서버)'],
  ['misc', '기타'],
];

const JAVA_MANAGED = {
  'server-port': '서버 편집의 「포트」에서 정합니다.',
  'query.port': '포털이 접속 포트와 같은 번호로 정합니다.',
  'level-name': '포털이 월드 폴더 이름을 world로 고정합니다.',
};

const JAVA_BASIC = {
  motd: '서버 이름',
  gamemode: '게임 모드',
  difficulty: '난이도',
  'max-players': '최대 인원',
  'online-mode': '정품 계정 인증',
  'view-distance': '시야 거리',
  'level-seed': '월드 시드',
};

const JAVA_PORTAL_DEFAULTS = {
  // 26.x creates servers with the whitelist on; the password check protects the server instead, and an empty
  // whitelist would keep everyone out.
  'white-list': 'false',
  // The portal sends console commands for the password check; without this every op would see them in chat.
  'broadcast-console-to-ops': 'false',
};

// Never copied from a version's defaults: each server must make its own.
const JAVA_PER_SERVER = new Set(['management-server-secret']);

const PERMISSION_LEVELS = { 1: '1 (스폰 보호 무시)', 2: '2 (명령 블록·대부분 명령)', 3: '3 (강퇴·밴)', 4: '4 (모든 명령)' };

const JAVA_META = {
  pvp: { group: 'gameplay', type: 'bool', label: 'PvP (플레이어끼리 공격)' },
  hardcore: { group: 'gameplay', type: 'bool', label: '하드코어', help: '켜면 난이도가 어려움으로 고정되고, 죽으면 관전 모드가 됩니다.' },
  'force-gamemode': { group: 'gameplay', type: 'bool', label: '게임 모드 강제', help: '켜면 접속할 때마다 기본 게임 모드로 바꿉니다.' },
  'allow-flight': { group: 'gameplay', type: 'bool', label: '비행 허용', help: '끄면 서바이벌에서 공중에 떠 있는 플레이어(비행 핵·모드)를 강퇴합니다. 렉이 심하면 정상 플레이어도 강퇴될 수 있습니다.' },
  'allow-nether': { group: 'gameplay', type: 'bool', label: '네더 허용' },
  'enable-command-block': { group: 'gameplay', type: 'bool', label: '명령 블록 사용' },
  'spawn-animals': { group: 'gameplay', type: 'bool', label: '동물 스폰' },
  'spawn-monsters': { group: 'gameplay', type: 'bool', label: '몬스터 스폰' },
  'spawn-npcs': { group: 'gameplay', type: 'bool', label: '주민 스폰' },
  'spawn-protection': { group: 'gameplay', type: 'int', min: 0, label: '스폰 보호 반경 (블록)', help: '스폰 주변 이 반경 안에서는 OP가 아닌 플레이어가 블록을 부수거나 놓을 수 없습니다. 0이면 끕니다.' },
  'level-type': { group: 'world', type: 'enum', options: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'], optionLabels: { 'minecraft:normal': '기본', 'minecraft:flat': '평지', 'minecraft:large_biomes': '큰 생물 군계', 'minecraft:amplified': '증폭', 'minecraft:single_biome_surface': '단일 생물 군계' }, label: '월드 유형', help: '월드를 처음 만들 때만 쓰입니다.' },
  'generate-structures': { group: 'world', type: 'bool', label: '구조물 생성', help: '마을, 던전 같은 구조물을 만들지 정합니다. 새로 생성되는 지역에만 적용됩니다.' },
  'generator-settings': { group: 'world', type: 'string', label: '월드 생성 설정 (JSON)', help: '평지·단일 생물 군계 월드의 세부 설정입니다.' },
  'max-world-size': { group: 'world', type: 'int', min: 1, max: 29999984, label: '월드 경계 최대 반경 (블록)' },
  'initial-enabled-packs': { group: 'world', type: 'string', label: '처음 켤 데이터 팩', help: '월드를 처음 만들 때만 쓰입니다. 쉼표로 구분합니다.' },
  'initial-disabled-packs': { group: 'world', type: 'string', label: '처음 끌 데이터 팩', help: '월드를 처음 만들 때만 쓰입니다. 쉼표로 구분합니다.' },
  'white-list': { group: 'players', type: 'bool', label: '화이트리스트만 접속', help: '켜면 whitelist.json에 등록된 계정만 들어올 수 있습니다. 콘솔에서 whitelist add <이름>으로 추가하세요. 포털은 비밀번호로 보호하므로 기본은 꺼짐입니다.', warnWhen: 'true', warn: '화이트리스트에 아무도 없으면 아무도 접속할 수 없습니다.' },
  'enforce-whitelist': { group: 'players', type: 'bool', label: '화이트리스트 즉시 적용', help: '켜면 화이트리스트를 다시 불러올 때 목록에 없는 접속자를 바로 내보냅니다.' },
  'op-permission-level': { group: 'players', type: 'enum', options: ['1', '2', '3', '4'], optionLabels: PERMISSION_LEVELS, label: 'OP 권한 단계', help: '/op로 관리자를 지정했을 때 받는 권한 단계입니다.' },
  'function-permission-level': { group: 'players', type: 'enum', options: ['1', '2', '3', '4'], optionLabels: PERMISSION_LEVELS, label: '데이터 팩 함수 권한 단계' },
  'player-idle-timeout': { group: 'players', type: 'int', min: 0, label: '잠수 강퇴 시간 (분)', help: '0이면 강퇴하지 않습니다.' },
  'hide-online-players': { group: 'players', type: 'bool', label: '서버 목록에서 접속자 숨기기' },
  'enforce-secure-profile': { group: 'network', type: 'bool', label: '채팅 서명 필수', help: 'Mojang이 서명한 채팅 키가 있는 계정만 접속하게 합니다. 정품 인증을 껐다면 이것도 끄세요.' },
  'log-ips': { group: 'network', type: 'bool', label: '접속 IP 기록' },
  'prevent-proxy-connections': { group: 'network', type: 'bool', label: '프록시·VPN 접속 막기', help: '정품 인증 서버와 이 서버가 본 접속 주소가 다르면 막습니다.' },
  'rate-limit': { group: 'network', type: 'int', min: 0, label: '초당 패킷 제한', help: '넘으면 강퇴합니다. 0이면 제한 없음.' },
  'network-compression-threshold': { group: 'network', type: 'int', min: -1, label: '압축 최소 크기 (바이트)', help: '-1이면 압축하지 않습니다.' },
  'server-ip': { group: 'network', type: 'ip', label: '서버가 열릴 주소', help: '비우면 모든 네트워크에서 접속을 받습니다 (권장).' },
  'enable-status': { group: 'network', type: 'bool', label: '서버 목록에 상태 표시', help: '끄면 서버 목록에서 오프라인처럼 보입니다 (접속은 가능).' },
  'accepts-transfers': { group: 'network', type: 'bool', label: '다른 서버에서 넘어오는 접속 허용 (/transfer)' },
  'chat-spam-threshold-seconds': { group: 'network', type: 'int', min: 0, label: '채팅 도배 판정 시간 (초)' },
  'command-spam-threshold-seconds': { group: 'network', type: 'int', min: 0, label: '명령어 도배 판정 시간 (초)' },
  'enable-code-of-conduct': { group: 'network', type: 'bool', label: '행동 강령 표시' },
  'text-filtering-config': { group: 'network', type: 'string', label: '채팅 필터 설정' },
  'bug-report-link': { group: 'misc', type: 'string', label: '버그 신고 링크' },
  'simulation-distance': { group: 'performance', type: 'int', min: 3, max: 32, label: '시뮬레이션 거리 (청크)', help: '플레이어 주변 몇 청크까지 몹, 작물, 레드스톤이 움직일지. 높을수록 서버 부담이 커집니다.' },
  'entity-broadcast-range-percentage': { group: 'performance', type: 'int', min: 10, max: 1000, label: '엔티티 표시 거리 (%)' },
  'max-tick-time': { group: 'performance', type: 'int', min: -1, label: '멈춤 판정 시간 (ms)', help: '한 틱이 이보다 오래 걸리면 서버가 멈춘 것으로 보고 종료합니다. -1이면 끕니다.' },
  'max-chained-neighbor-updates': { group: 'performance', type: 'int', label: '연쇄 블록 업데이트 한도' },
  'pause-when-empty-seconds': { group: 'performance', type: 'int', min: 0, label: '빈 서버 일시정지 (초)', help: '아무도 없는 상태가 이만큼 이어지면 월드 시간을 멈춰 CPU를 아낍니다. 0이면 끕니다.' },
  'sync-chunk-writes': { group: 'performance', type: 'bool', label: '청크 저장을 즉시 디스크에 쓰기', help: '끄면 빨라지지만 갑자기 꺼질 때 월드가 손상될 위험이 커집니다.' },
  'region-file-compression': { group: 'performance', type: 'enum', options: ['deflate', 'lz4', 'none'], optionLabels: { deflate: 'deflate (기본, 작은 용량)', lz4: 'lz4 (빠름, 큰 용량)', none: '압축 안 함' }, label: '월드 파일 압축 방식' },
  'use-native-transport': { group: 'performance', type: 'bool', label: 'Linux 네이티브 네트워크 사용' },
  'require-resource-pack': { group: 'resourcepack', type: 'bool', label: '리소스 팩 필수', help: '거절하면 접속할 수 없게 합니다.' },
  'resource-pack': { group: 'resourcepack', type: 'string', label: '리소스 팩 주소 (URL)' },
  'resource-pack-id': { group: 'resourcepack', type: 'string', label: '리소스 팩 UUID' },
  'resource-pack-prompt': { group: 'resourcepack', type: 'string', label: '리소스 팩 안내 문구' },
  'resource-pack-sha1': { group: 'resourcepack', type: 'string', label: '리소스 팩 SHA-1' },
  'enable-rcon': { group: 'remote', type: 'bool', label: 'RCON 켜기', help: '원격으로 콘솔 명령을 보낼 수 있게 합니다. 강한 비밀번호를 정하고, 포트를 인터넷에 열지 마세요.', warnWhen: 'true', warn: 'rcon.password가 약하면 누구나 서버를 조종할 수 있습니다.' },
  'rcon.port': { group: 'remote', type: 'int', min: 1, max: 65535, label: 'RCON 포트', help: '서버마다 다른 번호를 쓰세요.' },
  'rcon.password': { group: 'remote', type: 'string', label: 'RCON 비밀번호' },
  'broadcast-rcon-to-ops': { group: 'remote', type: 'bool', label: 'RCON 명령 결과를 OP에게 보여 주기' },
  'broadcast-console-to-ops': { group: 'remote', type: 'bool', label: '콘솔 명령 결과를 OP에게 보여 주기', help: '포털이 비밀번호 확인을 위해 콘솔 명령을 자주 보내므로 기본은 꺼짐입니다.' },
  'enable-query': { group: 'remote', type: 'bool', label: '쿼리(GameSpy4) 켜기', help: '서버 정보 조회 도구용입니다. 접속 포트와 같은 번호의 UDP를 씁니다.' },
  'enable-jmx-monitoring': { group: 'remote', type: 'bool', label: 'JMX 모니터링' },
  'management-server-enabled': { group: 'remote', type: 'bool', label: '관리 서버(API) 켜기' },
  'management-server-host': { group: 'remote', type: 'string', label: '관리 서버 주소' },
  'management-server-port': { group: 'remote', type: 'int', min: 0, max: 65535, label: '관리 서버 포트', help: '0이면 자동입니다.' },
  'management-server-secret': { group: 'remote', type: 'string', label: '관리 서버 비밀 키', help: '비워 두면 서버가 실행할 때마다 새로 만듭니다.' },
};

function unescapeJava(v) {
  return v.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (m, hex, ch) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' }[ch] ?? ch)));
}

// Escapes a value for a .properties file. Non-ASCII goes in \u form, which every Java version reads.
function escapeJava(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/^ /, '\\ ')
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// key → default value, in file order.
function parseJavaProperties(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[#!]/.test(raw) || !raw.trim()) continue;
    const m = raw.match(/^([A-Za-z0-9_.-]+)\s*[=:]\s?(.*)$/);
    if (m) out.set(m[1], unescapeJava(m[2]));
  }
  return out;
}

function javaTemplatePath(version) {
  return version && /^\d+(\.\d+)+$/.test(version) ? path.join(JAVA_VERSIONS_DIR, version, 'server.properties') : null;
}

function javaSchema(version) {
  const file = javaTemplatePath(version);
  if (!file || !fs.existsSync(file)) return null;
  const key = `java:${version}`;
  if (cache.has(key)) return cache.get(key);
  const defaults = parseJavaProperties(fs.readFileSync(file, 'utf8'));
  const properties = [];
  const fixed = [];
  for (const [k, def] of defaults) {
    if (JAVA_MANAGED[k]) { fixed.push({ key: k, kind: 'managed', reason: JAVA_MANAGED[k] }); continue; }
    if (JAVA_BASIC[k]) { fixed.push({ key: k, kind: 'basic', reason: `기본 설정의 「${JAVA_BASIC[k]}」에서 바꿉니다.` }); continue; }
    const shown = JAVA_PER_SERVER.has(k) ? '' : def;
    const meta = JAVA_META[k] || { group: 'misc', ...inferType({ default: shown, desc: [] }) };
    properties.push({
      key: k,
      default: JAVA_PORTAL_DEFAULTS[k] ?? shown,
      optional: false,
      type: meta.type,
      options: meta.options,
      optionLabels: meta.optionLabels || (meta.type === 'bool' ? ON_OFF : undefined),
      min: meta.min,
      max: meta.max,
      label: meta.label || k,
      help: meta.help || '',
      english: '',
      group: meta.group || 'misc',
      warnWhen: meta.warnWhen,
      warn: meta.warn,
    });
  }
  const result = { edition: 'java', version, groups: JAVA_GROUPS.map(([id, label]) => ({ id, label })), properties, fixed };
  cache.set(key, result);
  return result;
}

module.exports = {
  schema,
  validate,
  parseTemplate,
  parseJavaProperties,
  escapeJava,
  javaTemplatePath,
  MANAGED,
  BASIC,
  PORTAL_DEFAULTS,
  JAVA_PORTAL_DEFAULTS,
  JAVA_PER_SERVER,
};
