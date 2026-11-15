// Server Farm Password — runs inside Bedrock Dedicated Server.
// Players who join are frozen behind a black screen and asked for the server password in a form.
// Wrong password too many times, or no answer before the time limit, gets them kicked.
// Lines starting with "MCF_" on the console are read by the web portal.
import { world, system, InputPermissionCategory } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "./config.js";

const TIMEOUT_TICKS = Math.max(15, Number(CONFIG.timeoutSec) || 120) * 20;
const MAX_FAILS = Math.max(1, Number(CONFIG.maxFails) || 5);
const LOCKED_INPUTS = [InputPermissionCategory.Movement, InputPermissionCategory.Camera];
const FREEZE_EFFECTS = [
  ["blindness", 0],
  ["resistance", 255],
  ["weakness", 255],
];

let pin = String(CONFIG.pin ?? "");

/** player.id -> { joinedTick, fails, formOpen, nextPrompt, anchor, dimId, kickReason, nextKick } */
const pending = new Map();
/** player.id of players who entered the right password this session */
const verified = new Set();

function out(tag, ...fields) {
  console.log([`MCF_${tag}`, ...fields.map((f) => String(f).replace(/[\t\r\n]/g, " "))].join("\t"));
}

function attempt(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function setInputs(player, enabled) {
  for (const category of LOCKED_INPUTS) attempt(() => player.inputPermissions.setPermissionCategory(category, enabled));
}

function freeze(player) {
  setInputs(player, false);
  for (const [effect, amplifier] of FREEZE_EFFECTS) {
    attempt(() => player.addEffect(effect, 60, { amplifier, showParticles: false }));
  }
  attempt(() =>
    player.camera.fade({
      fadeTime: { fadeInTime: 0, holdTime: 1.6, fadeOutTime: 0.4 },
      fadeColor: { red: 0, green: 0, blue: 0 },
    })
  );
}

function unfreeze(player) {
  setInputs(player, true);
  for (const [effect] of FREEZE_EFFECTS) attempt(() => player.removeEffect(effect));
}

function begin(player) {
  pending.set(player.id, {
    joinedTick: system.currentTick,
    fails: 0,
    formOpen: false,
    nextPrompt: system.currentTick + 20,
    anchor: { ...player.location },
    dimId: player.dimension.id,
    kickReason: null,
    nextKick: 0,
  });
  freeze(player);
  out("PENDING", player.name);
}

function authorize(player) {
  pending.delete(player.id);
  verified.add(player.id);
  unfreeze(player);
  attempt(() => player.onScreenDisplay.setActionBar("§a인증 완료!"));
  attempt(() => player.sendMessage("§a[서버] 인증되었습니다. 즐거운 시간 되세요!"));
  out("AUTH_OK", player.name);
}

function kick(player, state, reason) {
  state.kickReason = reason;
  state.nextKick = system.currentTick + 100;
  const name = player.name.replace(/"/g, "");
  const kicked = attempt(() => {
    world.getDimension("overworld").runCommand(`kick "${name}" ${reason}`);
    return true;
  });
  // If scripts may not kick on this server, the portal does it from the console.
  out(kicked ? "KICKED" : "KICK", player.name, reason);
}

async function prompt(player, state) {
  state.formOpen = true;
  try {
    const left = MAX_FAILS - state.fails;
    const body =
      state.fails > 0
        ? `§c비밀번호가 틀렸습니다.§r (남은 기회 ${left}회)\n\n비밀번호를 다시 입력하세요.`
        : "이 서버는 비밀번호로 보호되어 있습니다.\n서버 관리자에게 받은 비밀번호를 입력하세요.";
    const form = new ModalFormData().title("서버 비밀번호").textField(body, "비밀번호");
    const res = await form.show(player);
    if (!player.isValid || pending.get(player.id) !== state || state.kickReason) return;
    if (res.canceled) {
      // UserBusy: still loading or another screen is open. UserClosed: they closed it — ask again shortly.
      state.nextPrompt = system.currentTick + 20;
      return;
    }
    const value = String(res.formValues?.[0] ?? "").trim();
    if (!value) {
      state.nextPrompt = system.currentTick + 10;
    } else if (value === pin) {
      authorize(player);
    } else {
      state.fails += 1;
      out("AUTH_FAIL", player.name, state.fails);
      if (state.fails >= MAX_FAILS) kick(player, state, "비밀번호를 여러 번 틀렸습니다.");
      else state.nextPrompt = system.currentTick + 10;
    }
  } catch {
    state.nextPrompt = system.currentTick + 40;
  } finally {
    state.formOpen = false;
  }
}

function tick() {
  if (!CONFIG.enabled) return;
  const now = system.currentTick;
  for (const player of world.getAllPlayers()) {
    if (verified.has(player.id)) continue;
    // Anyone online who is neither verified nor waiting (e.g. after /reload) has to verify.
    if (!pending.has(player.id)) begin(player);
    const state = pending.get(player.id);
    if (state.kickReason) {
      if (now >= state.nextKick) kick(player, state, state.kickReason);
      continue;
    }
    if (now - state.joinedTick > TIMEOUT_TICKS) {
      kick(player, state, "비밀번호 입력 시간이 초과되었습니다.");
      continue;
    }
    freeze(player);
    // Movement is locked through input permissions; this is a fallback in case a client ignores that.
    attempt(() => {
      const l = player.location;
      const a = state.anchor;
      if (player.dimension.id !== state.dimId || (l.x - a.x) ** 2 + (l.z - a.z) ** 2 > 9) {
        player.teleport(a, { dimension: world.getDimension(state.dimId) });
      }
    });
    attempt(() => player.onScreenDisplay.setActionBar("§e비밀번호를 입력해야 플레이할 수 있습니다"));
    if (!state.formOpen && now >= state.nextPrompt) prompt(player, state);
  }
}

// Unverified players can't break, use or interact with anything.
function guard(event) {
  if (event.player && pending.has(event.player.id)) event.cancel = true;
}
world.beforeEvents.playerBreakBlock.subscribe(guard);
world.beforeEvents.playerInteractWithBlock.subscribe(guard);
world.beforeEvents.playerInteractWithEntity.subscribe(guard);
world.beforeEvents.itemUse.subscribe((event) => {
  if (event.source && pending.has(event.source.id)) event.cancel = true;
});

world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn) return;
  if (CONFIG.enabled) begin(player); // restart the timer and anchor once the player has actually spawned
  else unfreeze(player); // protection off: undo anything left over from a protected session
});

world.afterEvents.playerLeave.subscribe(({ playerId }) => {
  pending.delete(playerId);
  verified.delete(playerId);
});

// Commands from the server console only (players' /scriptevent is ignored).
system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.sourceType !== "Server") return;
  if (event.id === "mcf:pin") {
    pin = event.message.trim();
    out("PIN_SET");
  } else if (event.id === "mcf:status") {
    const list = world.getAllPlayers().map((p) => `${p.name}=${pending.has(p.id) ? "pending" : "ok"}`);
    out("STATUS", list.join(","));
  }
});

system.runInterval(tick, 20);
out("READY", CONFIG.enabled ? "on" : "off");
