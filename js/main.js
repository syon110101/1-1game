import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://qrqhqkzqncfyzcrzmltd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rR59AGdR8PF2VvIHc4TbjA_tte7SP3J';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (selector) => document.querySelector(selector);
const lobbyScreen = $('#lobby-screen');
const waitingScreen = $('#waiting-screen');
const gameScreen = $('#game-screen');
const joinButton = $('#join-button');

const playerId = crypto.randomUUID();
let currentRoom = null;
let roomChannel = null;
let actionChannel = null;
let myAction = null;
let timerInterval = null;
let lastLoggedTurn = 0;
let resolving = false;

const MAX_HP = 100;
const ACTIONS = ['attack', 'defend', 'counter', 'heal', 'advanced'];
const ACTION_LABELS = { attack: '공격', defend: '방어', counter: '역공', heal: '회복', advanced: '고급행동' };

function makePlayer(id, name) {
  return {
    id, name, hp: MAX_HP, luck: 0,
    luckBoostTurns: 0,
    bleed: 0, bleedTurns: 0,
    invincible: 0, shield: 0,
    stun: 0, confusion: 0,
    advancedBlock: 0, basicDebuff: 0, rest: 0
  };
}

function initialState(room) {
  return {
    players: {
      [room.player1_id]: makePlayer(room.player1_id, room.player1_name),
      [room.player2_id]: makePlayer(room.player2_id, room.player2_name)
    },
    turn: 1, phase: 'playing', winnerId: null, lastResult: '전투 시작!'
  };
}

function myPlayer(state) { return state.players[playerId]; }
function enemyPlayer(state) {
  const ids = Object.keys(state.players);
  return state.players[ids.find((id) => id !== playerId)];
}
function isHost() { return currentRoom?.player1_id === playerId; }

function showWaiting(message) {
  $('#waiting-room-code').textContent = currentRoom?.room_code ?? $('#room-code').value;
  $('#waiting-status').textContent = message;
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.add('hidden');
  waitingScreen.classList.remove('hidden');
}

function showGame(state) {
  lobbyScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  renderState(state);
}

function renderState(state) {
  if (!state?.players?.[playerId]) return;
  const me = myPlayer(state);
  const enemy = enemyPlayer(state);
  $('#my-name').textContent = me.name;
  $('#enemy-name').textContent = enemy?.name ?? '상대';
  $('#my-hp').style.width = `${Math.max(0, me.hp)}%`;
  $('#enemy-hp').style.width = `${Math.max(0, enemy?.hp ?? 0)}%`;
  $('#my-hp-text').textContent = `${me.hp} / ${MAX_HP}`;
  $('#enemy-hp-text').textContent = `${enemy?.hp ?? 0} / ${MAX_HP}`;
  $('#my-status').innerHTML = formatStatus(me);
  $('#enemy-status').innerHTML = formatStatus(enemy);
  $('#turn-number').textContent = `턴 ${state.turn}`;
  $('#turn-status').textContent = state.phase === 'finished' ? '전투 종료' : (myAction ? '선택 완료 — 상대를 기다리는 중' : '행동을 선택하세요.');
  updateButtons(state);
}

function formatStatus(p) {
  if (!p) return '';
  const items = [`운 ${p.luck}%`];
  if (p.bleedTurns > 0) items.push(`출혈 ${p.bleed} (${p.bleedTurns}턴)`);
  if (p.invincible > 0) items.push(`무적 ${p.invincible}턴`);
  if (p.shield > 0) items.push(`보호막 ${p.shield}턴`);
  if (p.stun > 0) items.push(`스턴 ${p.stun}턴`);
  if (p.confusion > 0) items.push(`혼란 ${p.confusion}턴`);
  if (p.advancedBlock > 0) items.push(`고급행동 금지 ${p.advancedBlock}턴`);
  if (p.basicDebuff > 0) items.push(`기본행동 약화 ${p.basicDebuff}턴`);
  if (p.rest > 0) items.push(`휴식 ${p.rest}턴`);
  return items.map((x) => `<span class="status">${x}</span>`).join('');
}

function addLog(text) {
  const log = $('#battle-log-list');
  const p = document.createElement('p');
  p.textContent = text;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

function updateButtons(state) {
  const me = myPlayer(state);
  document.querySelectorAll('[data-action]').forEach((button) => {
    const action = button.dataset.action;
    let disabled = state.phase === 'finished' || Boolean(myAction) || me.stun > 0 || me.rest > 0;
    if (action === 'advanced' && me.advancedBlock > 0) disabled = true;
    button.disabled = disabled;
  });
}

function startTimer(startedAt) {
  clearInterval(timerInterval);
  if (!startedAt) { $('#timer').textContent = '5'; return; }
  const end = new Date(startedAt).getTime() + 5000;
  const tick = () => {
    const left = Math.max(0, end - Date.now());
    $('#timer').textContent = String(Math.ceil(left / 1000));
    if (left <= 0) { clearInterval(timerInterval); checkForResolution(); }
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

async function ensureGameStarted() {
  if (!currentRoom?.player1_id || !currentRoom?.player2_id) return;
  if (currentRoom.status === 'starting' && isHost() && !currentRoom.game_state) {
    const state = initialState(currentRoom);
    const { data, error } = await supabase.from('rooms').update({ status: 'playing', game_state: state, turn: 1, turn_started_at: null }).eq('room_code', currentRoom.room_code).select().single();
    if (error) { console.error(error); return; }
    currentRoom = data;
  }
  if (currentRoom.status === 'starting') showWaiting('상대가 입장했습니다. 잠시 후 시작합니다!');
  if (currentRoom.status === 'playing' || currentRoom.status === 'finished') {
    showGame(currentRoom.game_state);
    startTimer(currentRoom.turn_started_at);
  }
}

async function joinRoom() {
  const name = $('#player-name').value.trim();
  const roomCode = $('#room-code').value.trim();
  if (!name) return alert('이름을 입력해주세요.');
  if (!/^\d{4}$/.test(roomCode)) return alert('방번호는 4자리 숫자로 입력해주세요.');
  joinButton.disabled = true;
  try {
    const { data: existing, error: findError } = await supabase.from('rooms').select('*').eq('room_code', roomCode).maybeSingle();
    if (findError) throw findError;
    if (!existing) {
      const { data, error } = await supabase.from('rooms').insert({ room_code: roomCode, player1_name: name, player1_id: playerId, status: 'waiting' }).select().single();
      if (error) throw error;
      currentRoom = data;
      showWaiting('상대를 기다리는 중...');
    } else if (existing.player2_id) {
      return alert('이미 두 명이 들어간 방입니다. 다른 방번호를 사용해주세요.');
    } else {
      const { data, error } = await supabase.from('rooms').update({ player2_name: name, player2_id: playerId, status: 'starting' }).eq('room_code', roomCode).is('player2_id', null).select().single();
      if (error) throw error;
      currentRoom = data;
      showWaiting('상대가 입장했습니다. 잠시 후 시작합니다!');
    }
    subscribe(roomCode);
    await ensureGameStarted();
  } catch (error) {
    console.error(error);
    alert(`입장 오류: ${error.message ?? 'Supabase 설정을 확인해주세요.'}`);
  } finally {
    joinButton.disabled = false;
  }
}

function subscribe(roomCode) {
  if (roomChannel) supabase.removeChannel(roomChannel);
  if (actionChannel) supabase.removeChannel(actionChannel);
  roomChannel = supabase.channel(`room-${roomCode}-${playerId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `room_code=eq.${roomCode}` }, async (payload) => {
      if (payload.eventType === 'DELETE') return;
      const previousTurn = currentRoom?.game_state?.turn;
      currentRoom = payload.new;
      if (currentRoom.game_state && currentRoom.game_state.turn !== previousTurn) myAction = null;
      if (currentRoom.game_state) {
        showGame(currentRoom.game_state);
        startTimer(currentRoom.turn_started_at);
        if (currentRoom.game_state.lastResult && currentRoom.game_state.turn !== lastLoggedTurn) {
          addLog(currentRoom.game_state.lastResult);
          lastLoggedTurn = currentRoom.game_state.turn;
        }
      } else await ensureGameStarted();
    })
    .subscribe();

  actionChannel = supabase.channel(`actions-${roomCode}-${playerId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_actions', filter: `room_code=eq.${roomCode}` }, async () => {
      await checkForResolution();
    })
    .subscribe();
}

async function chooseAction(action) {
  const state = currentRoom?.game_state;
  if (!state || state.phase === 'finished' || myAction) return;
  const me = myPlayer(state);
  if (me.stun > 0 || me.rest > 0) return;
  if (action === 'advanced' && me.advancedBlock > 0) return;
  myAction = action;
  updateButtons(state);
  $('#turn-status').textContent = '선택 완료 — 상대를 기다리는 중';
  const { error } = await supabase.from('game_actions').insert({ room_code: currentRoom.room_code, turn: state.turn, player_id: playerId, action });
  if (error) {
    myAction = null;
    updateButtons(state);
    return alert(`행동 전송 오류: ${error.message}`);
  }
  if (!currentRoom.turn_started_at) {
    const { data } = await supabase.from('rooms').update({ turn_started_at: new Date().toISOString() }).eq('room_code', currentRoom.room_code).is('turn_started_at', null).select().maybeSingle();
    if (data) currentRoom = data;
  }
  startTimer(currentRoom.turn_started_at ?? new Date().toISOString());
  await checkForResolution();
}

async function checkForResolution() {
  if (!currentRoom?.game_state || currentRoom.game_state.phase === 'finished' || !isHost() || resolving) return;
  const turn = currentRoom.game_state.turn;
  const { data: actions, error } = await supabase.from('game_actions').select('*').eq('room_code', currentRoom.room_code).eq('turn', turn);
  if (error || !actions) return;
  const ids = [currentRoom.player1_id, currentRoom.player2_id];
  const actionMap = Object.fromEntries(actions.map((a) => [a.player_id, a.action]));
  const both = ids.every((id) => actionMap[id]);
  const timedOut = currentRoom.turn_started_at && Date.now() - new Date(currentRoom.turn_started_at).getTime() >= 5000;
  if (!both && !timedOut) return;
  resolving = true;
  try {
    const state = structuredClone(currentRoom.game_state);
    const actionsById = {};
    for (const id of ids) actionsById[id] = actionMap[id] ?? null;
    const result = resolveTurn(state, actionsById);
    const nextTurn = state.phase === 'finished' ? state.turn : state.turn + 1;
    state.turn = nextTurn;
    state.lastResult = result.text;
    const status = state.phase === 'finished' ? 'finished' : 'playing';
    const { data, error: updateError } = await supabase.from('rooms').update({ game_state: state, status, turn: nextTurn, turn_started_at: null, winner_id: state.winnerId, winner_name: state.winnerId ? state.players[state.winnerId].name : null }).eq('room_code', currentRoom.room_code).eq('turn', turn).select().maybeSingle();
    if (updateError) throw updateError;
    if (data) currentRoom = data;
    myAction = null;
  } catch (error) {
    console.error('turn resolve error', error);
  } finally {
    resolving = false;
  }
}

function roll(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function chance(percent) { return Math.random() * 100 < percent; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function basicDebuffFactor(p) { return p.basicDebuff > 0 ? 0.85 : 1; }

function rollAttack(p) {
  const luck = clamp(p.luck, 0, 30);
  const high = 30 + Math.min(15, luck);
  const normal = 50 - Math.floor(Math.min(15, luck) * 0.5);
  const factor = basicDebuffFactor(p);
  const goodNormal = normal * factor;
  const goodHigh = high * factor;
  const r = Math.random() * 100;
  if (r < 100 - goodNormal - goodHigh) return { damage: 0, power: 0, kind: 'miss' };
  if (r < 100 - goodHigh) return { damage: roll(5, 15), power: 10, kind: 'normal' };
  return { damage: roll(16, 30), power: 23, kind: 'high' };
}

function rollDefense(p) {
  const max = Math.round(20 + Math.min(5, p.luck / 2));
  return roll(0, max);
}

function skillRoll(enemy) {
  let r = Math.random() * 100;
  if (r < 20) return '흡혈'; r -= 20;
  if (r < 15) return '스턴'; r -= 15;
  if (r < 10) return '혼란'; r -= 10;
  if (r < 20) return '출혈'; r -= 20;
  if (r < 10) return '무적'; r -= 10;
  if (r < 20) return '보호막';
  if (enemy.hp <= 30) return '처형';
  return '흡혈';
}

function advanced(p) {
  if (chance(40)) return { success: true };
  p.advancedBlock = Math.max(p.advancedBlock, 2);
  p.basicDebuff = Math.max(p.basicDebuff, 1);
  const r = Math.random() * 100;
  let penalty = '기본 패널티만 적용';
  if (r < 30) { p.basicDebuff = Math.max(p.basicDebuff, 3); penalty = '기본행동 약화 3턴'; }
  else if (r < 60) penalty = '1턴 휴식';
  else if (r < 75) { p.advancedBlock = Math.max(p.advancedBlock, 3); penalty = '고급행동 금지 3턴'; }
  else if (r < 85) penalty = '추가 패널티 없음';
  else { p.advancedBlock = 0; p.basicDebuff = 0; penalty = '패널티 없음'; }
  return { success: false, penalty, rest: r >= 30 && r < 60 };
}

function applyDamage(target, amount) {
  let damage = Math.max(0, Math.round(amount));
  if (target.invincible > 0) damage = 0;
  else if (target.shield > 0) damage = Math.floor(damage * 0.5);
  target.hp = clamp(target.hp - damage, 0, MAX_HP);
  return damage;
}

function resolveTurn(state, actionMap) {
  const ids = [currentRoom.player1_id, currentRoom.player2_id];
  const lines = [`[턴 ${state.turn}]`];
  const original = { [ids[0]]: actionMap[ids[0]], [ids[1]]: actionMap[ids[1]] };
  const effective = {};
  const attacks = {};

  for (const id of ids) {
    const p = state.players[id];
    let a = actionMap[id];
    if (!a) lines.push(`${p.name}: 시간 초과 → 행동 없음 (받는 피해 +20%)`);
    if (p.rest > 0) { a = null; lines.push(`${p.name}: 휴식으로 행동 불가`); }
    else if (p.stun > 0) { a = null; lines.push(`${p.name}: 스턴으로 행동 불가`); }
    else if (p.confusion > 0 && a) { a = ACTIONS[roll(0, ACTIONS.length - 1)]; lines.push(`${p.name}: 혼란으로 ${ACTION_LABELS[a]}로 변경`); }
    effective[id] = a;
  }

  for (const id of ids) {
    if (effective[id] === 'advanced') {
      const p = state.players[id], enemy = state.players[ids.find((x) => x !== id)];
      const result = advanced(p);
      if (result.success) { const skill = skillRoll(enemy); effective[id] = { type: 'skill', name: skill }; lines.push(`${p.name}: 고급행동 성공 → ${skill}`); }
      else { effective[id] = null; if (result.rest) p.rest = 1; lines.push(`${p.name}: 고급행동 실패 → ${result.penalty}`); }
    }
  }

  for (const id of ids) if (effective[id] === 'attack') attacks[id] = rollAttack(state.players[id]);

  for (const id of ids) {
    const enemyId = ids.find((x) => x !== id);
    const p = state.players[id], enemy = state.players[enemyId];
    const action = effective[id];
    const timedOut = !original[id];
    const incomingMultiplier = timedOut ? 1.2 : 1;

    if (action === 'attack') {
      const rollResult = attacks[id];
      let damage = rollResult.damage;
      if (effective[enemyId] === 'defend') {
        const defense = rollDefense(enemy);
        damage = Math.max(0, damage - defense);
        const finalDamage = Math.round(damage * incomingMultiplier);
        applyDamage(enemy, finalDamage);
        lines.push(`${p.name}: 공격 ${rollResult.damage} → ${enemy.name} 방어 ${defense} → ${finalDamage} 피해`);
      } else {
        const finalDamage = Math.round(damage * incomingMultiplier);
        applyDamage(enemy, finalDamage);
        lines.push(`${p.name}: ${rollResult.kind === 'miss' ? '공격 빗나감' : `공격 ${damage}`} → ${enemy.name}에게 ${finalDamage} 피해`);
      }
    }

    if (action === 'counter') {
      if (effective[enemyId] === 'attack') {
        const power = attacks[enemyId]?.power ?? 0;
        const successChance = clamp(60 - power / 2 + p.luck / 2, 0, 80);
        const r = Math.random() * 100;
        if (r < successChance) {
          const damage = attacks[enemyId]?.damage ?? 0;
          const finalDamage = Math.round(damage * incomingMultiplier);
          applyDamage(enemy, finalDamage);
          lines.push(`${p.name}: 역공 성공 (${successChance.toFixed(1)}%) → ${enemy.name}에게 ${finalDamage} 피해`);
        } else if (r < successChance + 20) {
          const damage = attacks[enemyId]?.damage ?? 0;
          const enemyDamage = Math.round(damage * 0.6 * incomingMultiplier);
          const selfDamage = Math.round(damage * 0.6);
          applyDamage(enemy, enemyDamage);
          applyDamage(p, selfDamage);
          lines.push(`${p.name}: 역공 중간 → 서로 ${selfDamage} 피해`);
        } else {
          const damage = attacks[enemyId]?.damage ?? 0;
          const selfDamage = Math.round(damage * 1.1);
          applyDamage(p, selfDamage);
          lines.push(`${p.name}: 역공 실패 → ${selfDamage} 피해 받음`);
        }
      } else lines.push(`${p.name}: 역공 → 상대의 기본 공격이 없어 효과 없음`);
    }

    if (action === 'defend') lines.push(`${p.name}: 방어 태세`);

    if (action === 'heal') {
      const amount = roll(0, 20), before = p.hp;
      p.hp = clamp(p.hp + amount, 0, MAX_HP);
      const healed = p.hp - before;
      if (chance(50)) { p.luck = clamp(p.luck + 10, 0, 100); p.luckBoostTurns = 2; lines.push(`${p.name}: 회복 ${healed} → 운 +10% (다음 2턴)`); }
      else lines.push(`${p.name}: 회복 ${healed}`);
    }

    if (action?.type === 'skill') resolveSkill(action.name, p, enemy, effective[enemyId], lines);
  }

  for (const id of ids) {
    const p = state.players[id];
    if (p.bleedTurns > 0 && p.bleed > 0) {
      const damage = applyDamage(p, p.bleed);
      lines.push(`${p.name}: 출혈 ${damage} 피해`);
    }
  }

  for (const id of ids) tickStatus(state.players[id]);
  for (const id of ids) if (state.players[id].hp <= 0 && !state.winnerId) state.winnerId = ids.find((x) => x !== id);
  if (state.winnerId) { state.phase = 'finished'; lines.push(`🏆 ${state.players[state.winnerId].name} 승리!`); }
  return { text: lines.join(' | ') };
}

function resolveSkill(name, p, enemy, enemyAction, lines) {
  switch (name) {
    case '흡혈': {
      const raw = roll(0, 20);
      const defense = enemyAction === 'defend' ? rollDefense(enemy) : 0;
      const damage = applyDamage(enemy, Math.max(0, raw - Math.floor(defense * 0.5)));
      const heal = Math.round(damage * 0.8);
      p.hp = clamp(p.hp + heal, 0, MAX_HP);
      lines.push(`${p.name}: 흡혈 → ${damage} 피해, ${heal} 회복`);
      break;
    }
    case '스턴': enemy.stun = Math.max(enemy.stun, 1); lines.push(`${p.name}: 스턴 → ${enemy.name} 1턴 행동 불가`); break;
    case '혼란': if (enemy.stun <= 0) { enemy.confusion = Math.max(enemy.confusion, 1); lines.push(`${p.name}: 혼란 → ${enemy.name} 다음 행동 무작위`); } else lines.push(`${p.name}: 혼란 실패 (상대 스턴 중)`); break;
    case '출혈': enemy.bleed = roll(5, 10); enemy.bleedTurns = 3; lines.push(`${p.name}: 출혈 → ${enemy.name} ${enemy.bleed} 피해 × 3턴`); break;
    case '무적': p.shield = 0; p.invincible = Math.max(p.invincible, 1); lines.push(`${p.name}: 무적 → 다음 턴 피해 0`); break;
    case '보호막': p.invincible = 0; p.shield = Math.max(p.shield, 2); lines.push(`${p.name}: 보호막 → 2턴 피해 50% 감소`); break;
    case '처형': if (enemy.hp <= 30 && chance(80)) { enemy.hp = 0; lines.push(`${p.name}: 처형 성공!`); } else lines.push(`${p.name}: 처형 실패`); break;
  }
}

function tickStatus(p) {
  if (p.bleedTurns > 0) p.bleedTurns--;
  if (p.invincible > 0) p.invincible--;
  if (p.shield > 0) p.shield--;
  if (p.stun > 0) p.stun--;
  if (p.confusion > 0) p.confusion--;
  if (p.advancedBlock > 0) p.advancedBlock--;
  if (p.basicDebuff > 0) p.basicDebuff--;
  if (p.rest > 0) p.rest--;
  if (p.luckBoostTurns > 0) { p.luckBoostTurns--; if (p.luckBoostTurns === 0) p.luck = Math.max(0, p.luck - 10); }
}

document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => chooseAction(button.dataset.action)));
joinButton.addEventListener('click', joinRoom);
$('#player-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('#room-code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
