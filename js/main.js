import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://qrqhqkzqncfyzcrzmltd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rR59DGdR8PF2VvIHc4TbjA_tte7SP3J';
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  }
);
const $ = (selector) => document.querySelector(selector);
const lobbyScreen = $('#lobby-screen');
const waitingScreen = $('#waiting-screen');
const gameScreen = $('#game-screen');
const joinButton = $('#join-button');

// Some browsers/privacy modes block localStorage. window.name survives a reload
// in the same tab and does not require the Storage API.
function getPlayerId() {
  try {
    if (typeof window.name === 'string' && window.name.startsWith('duel:')) return window.name.slice(5);
    const id = crypto.randomUUID();
    try { window.name = `duel:${id}`; } catch (_) {}
    return id;
  } catch (_) {
    return crypto.randomUUID();
  }
}
const playerId = getPlayerId();

let currentRoom = null;
let roomChannel = null;
let actionChannel = null;
let myAction = null;
let timerInterval = null;
let heartbeatInterval = null;
let lastLoggedTurn = 0;
let resolving = false;

const ROOM_STALE_MS = 20000;
const MAX_HP = 100;
const ACTIONS = ['attack', 'defend', 'counter', 'heal', 'advanced'];
const ACTION_LABELS = { attack:'공격', defend:'방어', counter:'역공', heal:'회복', advanced:'고급행동' };

function makePlayer(id, name) {
  return { id, name, hp:100, luck:0, luckBoostTurns:0, bleed:0, bleedTurns:0, invincible:0, shield:0, stun:0, confusion:0, advancedBlock:0, basicDebuff:0, rest:0 };
}

function initialState(room) {
  return {
    players: {
      [room.player1_id]: makePlayer(room.player1_id, room.player1_name),
      [room.player2_id]: makePlayer(room.player2_id, room.player2_name)
    },
    turn:1,
    phase:'playing',
    winnerId:null,
    lastResult:'전투 시작!'
  };
}

function myPlayer(state) { return state.players[playerId]; }
function enemyPlayer(state) { return Object.values(state.players).find(p => p.id !== playerId); }
function isHost() { return currentRoom?.player1_id === playerId; }
function isStale(timestamp) { return !timestamp || Date.now() - new Date(timestamp).getTime() > ROOM_STALE_MS; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function chance(percent) { return Math.random() * 100 < percent; }

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

function formatStatus(p) {
  if (!p) return '';
  const items = [`운 ${p.luck}%`];
  if (p.bleedTurns) items.push(`출혈 ${p.bleed} (${p.bleedTurns}턴)`);
  if (p.invincible) items.push(`무적 ${p.invincible}턴`);
  if (p.shield) items.push(`보호막 ${p.shield}턴`);
  if (p.stun) items.push(`스턴 ${p.stun}턴`);
  if (p.confusion) items.push(`혼란 ${p.confusion}턴`);
  if (p.advancedBlock) items.push(`고급행동 금지 ${p.advancedBlock}턴`);
  if (p.basicDebuff) items.push(`기본행동 약화 ${p.basicDebuff}턴`);
  if (p.rest) items.push(`휴식 ${p.rest}턴`);
  return items.map(x => `<span class="status">${x}</span>`).join('');
}

function renderState(state) {
  if (!state?.players?.[playerId]) return;
  const me = myPlayer(state), enemy = enemyPlayer(state);
  $('#my-name').textContent = me.name;
  $('#enemy-name').textContent = enemy?.name ?? '상대';
  $('#my-hp').style.width = `${clamp(me.hp,0,100)}%`;
  $('#enemy-hp').style.width = `${clamp(enemy?.hp ?? 0,0,100)}%`;
  $('#my-hp-text').textContent = `${Math.max(0,me.hp)} / ${MAX_HP}`;
  $('#enemy-hp-text').textContent = `${Math.max(0,enemy?.hp ?? 0)} / ${MAX_HP}`;
  $('#my-status').innerHTML = formatStatus(me);
  $('#enemy-status').innerHTML = formatStatus(enemy);
  $('#turn-number').textContent = `턴 ${state.turn}`;
  $('#turn-status').textContent = state.phase === 'finished' ? '전투 종료' : (myAction ? `선택 완료: ${ACTION_LABELS[myAction]} — 상대를 기다리는 중` : '행동을 선택하세요.');
  updateButtons(state);
}

function addLog(text) {
  const log = $('#battle-log-list');
  if (!log || !text) return;
  const p = document.createElement('p');
  p.textContent = text;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
}

function updateButtons(state) {
  const me = myPlayer(state);
  document.querySelectorAll('[data-action]').forEach(button => {
    let disabled = state.phase === 'finished' || Boolean(myAction) || !me || me.stun > 0 || me.rest > 0;
    if (button.dataset.action === 'advanced' && me?.advancedBlock > 0) disabled = true;
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
    if (left <= 0) {
      clearInterval(timerInterval);
      checkForResolution();
    }
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

async function heartbeat() {
  if (!currentRoom?.room_code) return;
  const now = new Date().toISOString();
  let query = supabase.from('rooms').update({
    ...(currentRoom.player1_id === playerId ? { player1_seen_at: now } : {}),
    ...(currentRoom.player2_id === playerId ? { player2_seen_at: now } : {})
  }).eq('room_code', currentRoom.room_code);
  if (currentRoom.player1_id === playerId) query = query.eq('player1_id', playerId);
  else if (currentRoom.player2_id === playerId) query = query.eq('player2_id', playerId);
  const { data, error } = await query.select().maybeSingle();
  if (!error && data) currentRoom = data;
}

function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeat();
  heartbeatInterval = setInterval(heartbeat, 5000);
}

async function ensureGameStarted() {
  if (!currentRoom?.player1_id || !currentRoom?.player2_id) return;
  if (currentRoom.status === 'starting' && isHost() && !currentRoom.game_state) {
    const state = initialState(currentRoom);
    const { data, error } = await supabase.from('rooms').update({ status:'playing', game_state:state, turn:1, turn_started_at:null }).eq('room_code', currentRoom.room_code).select().single();
    if (error) { console.error(error); return; }
    currentRoom = data;
  }
  if (currentRoom.status === 'starting') showWaiting('상대가 입장했습니다. 잠시 후 시작합니다!');
  if ((currentRoom.status === 'playing' || currentRoom.status === 'finished') && currentRoom.game_state) {
    showGame(currentRoom.game_state);
    startTimer(currentRoom.turn_started_at);
  }
}

async function resetRoomForNewPlayer(existing, name) {
  await supabase.from('game_actions').delete().eq('room_code', existing.room_code);
  const { data, error } = await supabase.from('rooms').update({
    player1_name:name, player1_id:playerId, player1_seen_at:new Date().toISOString(),
    player2_name:null, player2_id:null, player2_seen_at:null,
    status:'waiting', game_state:null, turn:1, turn_started_at:null, winner_id:null, winner_name:null
  }).eq('room_code', existing.room_code).select().single();
  if (error) throw error;
  return data;
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
    const now = new Date().toISOString();

    if (!existing) {
      const { data, error } = await supabase.from('rooms').insert({ room_code:roomCode, player1_name:name, player1_id:playerId, player1_seen_at:now, status:'waiting' }).select().single();
      if (error) throw error;
      currentRoom = data;
      showWaiting('상대를 기다리는 중...');
    } else if (existing.status === 'finished') {
      currentRoom = await resetRoomForNewPlayer(existing, name);
      showWaiting('새 대전을 준비하는 중...');
    } else if (existing.player1_id === playerId) {
      const { data, error } = await supabase.from('rooms').update({ player1_name:name, player1_seen_at:now }).eq('room_code', roomCode).select().single();
      if (error) throw error;
      currentRoom = data;
      if (currentRoom.player2_id) await ensureGameStarted(); else showWaiting('상대를 기다리는 중...');
    } else if (existing.player2_id === playerId) {
      const { data, error } = await supabase.from('rooms').update({ player2_name:name, player2_seen_at:now }).eq('room_code', roomCode).select().single();
      if (error) throw error;
      currentRoom = data;
      await ensureGameStarted();
    } else if (isStale(existing.player1_seen_at) && isStale(existing.player2_seen_at)) {
      currentRoom = await resetRoomForNewPlayer(existing, name);
      showWaiting('오래된 방을 정리하고 새 방으로 시작합니다...');
    } else if (!existing.player2_id || isStale(existing.player2_seen_at)) {
      const { data, error } = await supabase.from('rooms').update({ player2_name:name, player2_id:playerId, player2_seen_at:now, status:'starting', game_state:null, turn:1, turn_started_at:null, winner_id:null, winner_name:null }).eq('room_code', roomCode).select().single();
      if (error) throw error;
      currentRoom = data;
      showWaiting('상대가 입장했습니다. 잠시 후 시작합니다!');
    } else {
      return alert('현재 두 명이 플레이 중인 방입니다. 다른 방번호를 사용해주세요.');
    }

    subscribe(roomCode);
    startHeartbeat();
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
  roomChannel = supabase.channel(`room-${roomCode}-${playerId}`).on('postgres_changes', { event:'*', schema:'public', table:'rooms', filter:`room_code=eq.${roomCode}` }, async payload => {
    if (payload.eventType === 'DELETE') return;
    const previousTurn = currentRoom?.game_state?.turn;
    currentRoom = payload.new;
    if (currentRoom.game_state && currentRoom.game_state.turn !== previousTurn) { myAction = null; resolving = false; }
    if (currentRoom.game_state) {
      showGame(currentRoom.game_state);
      startTimer(currentRoom.turn_started_at);
      if (currentRoom.game_state.lastResult && currentRoom.game_state.turn !== lastLoggedTurn) { addLog(currentRoom.game_state.lastResult); lastLoggedTurn = currentRoom.game_state.turn; }
    } else await ensureGameStarted();
  }).subscribe();
  actionChannel = supabase.channel(`actions-${roomCode}-${playerId}`).on('postgres_changes', { event:'INSERT', schema:'public', table:'game_actions', filter:`room_code=eq.${roomCode}` }, async () => { await checkForResolution(); }).subscribe();
}

function rollAttack(p) {
  const luck = clamp(p.luck,0,100);
  const bonus = Math.min(15, luck);
  let high = 30 + bonus;
  let normal = 50 - Math.floor(bonus * 0.5);
  if (p.basicDebuff > 0) { high *= 0.85; normal *= 0.85; }
  const r = Math.random()*100;
  if (r < high) return { power:rand(16,30), label:'강공격' };
  if (r < high + normal) return { power:rand(5,15), label:'일반 공격' };
  return { power:0, label:'빗나감' };
}

function rollDefense(p) {
  const max = Math.round(20 + Math.min(5, p.luck / 2));
  return rand(0,max);
}

function basicDamage(target, amount) {
  if (amount <= 0) return 0;
  if (target.invincible > 0) return 0;
  const reduced = target.shield > 0 ? Math.ceil(amount * 0.5) : amount;
  target.hp = clamp(target.hp - reduced,0,MAX_HP);
  return reduced;
}

function applyHeal(p) {
  const amount = rand(0,12);
  p.hp = clamp(p.hp + amount,0,MAX_HP);
  let text = `${p.name} 회복 ${amount}`;
  if (chance(40)) { p.luck = clamp(p.luck + 10,0,100); p.luckBoostTurns = 2; text += ', 운 상승!'; }
  return text;
}

function skillRoll(enemy) {
  const r = Math.random()*100;
  if (enemy.hp <= 30 && r < 5) return 'execute';
  if (r < 20) return 'vampire';
  if (r < 35) return 'stun';
  if (r < 45) return 'confusion';
  if (r < 65) return 'bleed';
  if (r < 75) return 'invincible';
  return 'shield';
}

function advancedAction(actor, enemy) {
  if (actor.advancedBlock > 0) return `${actor.name}은(는) 고급행동을 사용할 수 없습니다.`;
  if (chance(55)) {
    const skill = skillRoll(enemy);
    if (skill === 'vampire') {
      const dmg = rand(0,20); const dealt = basicDamage(enemy,dmg); const heal = Math.round(dealt*0.8); actor.hp = clamp(actor.hp+heal,0,MAX_HP);
      return `${actor.name} 흡혈 성공! ${enemy.name}에게 ${dealt} 피해, ${heal} 회복`;
    }
    if (skill === 'stun') { enemy.stun = 1; return `${actor.name} 스턴 성공!`; }
    if (skill === 'confusion') { if (enemy.stun <= 0) enemy.confusion = 1; return `${actor.name} 혼란 성공!`; }
    if (skill === 'bleed') { enemy.bleed = rand(5,10); enemy.bleedTurns = 3; return `${actor.name} 출혈 성공!`; }
    if (skill === 'invincible') { actor.invincible = 1; return `${actor.name} 무적 발동!`; }
    if (skill === 'shield') { if (actor.invincible <= 0) actor.shield = 2; return `${actor.name} 보호막 발동!`; }
    if (skill === 'execute') { enemy.hp = 0; return `${actor.name} 처형 성공!`; }
  }
  actor.advancedBlock = 2;
  actor.basicDebuff = Math.max(actor.basicDebuff, 1);
  const r = Math.random()*100;
  if (r < 30) actor.basicDebuff = Math.max(actor.basicDebuff,3);
  else if (r < 60) actor.rest = 1;
  else if (r < 75) actor.advancedBlock = Math.max(actor.advancedBlock,3);
  else if (r >= 90) { actor.basicDebuff=0; actor.rest=0; actor.advancedBlock=0; }
  return `${actor.name} 고급행동 실패! 다음 행동에 불이익이 생깁니다.`;
}

function resolveTurn(state, actionsById) {
  const ids = Object.keys(state.players);
  const a = state.players[ids[0]], b = state.players[ids[1]];
  let logs = [];
  for (const p of [a,b]) {
    if (p.bleedTurns > 0) {
      const dealt = basicDamage(p,p.bleed);
      logs.push(`${p.name} 출혈로 ${dealt} 피해`);
      p.bleedTurns--;
      if (p.bleedTurns <= 0) p.bleed = 0;
    }
  }
  const effective = {};
  for (const id of ids) {
    const p = state.players[id];
    let act = actionsById[id];
    if (p.confusion > 0) { act = ACTIONS[rand(0,3)]; p.confusion--; logs.push(`${p.name}의 혼란으로 행동이 바뀌었습니다.`); }
    if (p.stun > 0) { act = null; p.stun--; logs.push(`${p.name}은(는) 스턴으로 행동하지 못했습니다.`); }
    if (p.rest > 0) { act = null; p.rest--; logs.push(`${p.name}은(는) 휴식 상태입니다.`); }
    effective[id] = act;
  }

  const attackResults = {};
  for (const id of ids) {
    const p = state.players[id];
    const act = effective[id];
    if (act === 'attack') attackResults[id] = rollAttack(p);
  }

  for (const id of ids) {
    const enemyId = id === ids[0] ? ids[1] : ids[0];
    const p = state.players[id], enemy = state.players[enemyId];
    const act = effective[id];
    if (act === 'heal') logs.push(applyHeal(p));
    if (act === 'advanced') logs.push(advancedAction(p,enemy));
    if (act === 'defend') logs.push(`${p.name} 방어 ${rollDefense(p)}`);
  }

  for (const id of ids) {
    const enemyId = id === ids[0] ? ids[1] : ids[0];
    const p = state.players[id], enemy = state.players[enemyId];
    const act = effective[id], enemyAct = effective[enemyId];
    if (enemyAct === 'attack' && attackResults[enemyId]) {
      const ar = attackResults[enemyId];
      if (act === 'defend') {
        const defense = rollDefense(p);
        const dealt = basicDamage(p,Math.max(0,ar.power-defense));
        logs.push(`${enemy.name}의 ${ar.label} → ${p.name} 방어 ${defense}, ${dealt} 피해`);
      } else if (act === 'counter') {
        const success = clamp(60 - ar.power/2 + p.luck/2,0,80);
        if (chance(success)) {
          const dealt = basicDamage(enemy,ar.power);
          logs.push(`${p.name} 역공 성공! ${dealt} 피해`);
        } else {
          const dealt = basicDamage(p,Math.round(ar.power*1.1));
          logs.push(`${p.name} 역공 실패! ${dealt} 피해`);
        }
      } else if (act !== 'advanced' && act !== 'heal' && act !== 'attack') {
        const dealt = basicDamage(p,ar.power);
        logs.push(`${enemy.name}의 ${ar.label} → ${p.name} ${dealt} 피해`);
      }
    }
  }

  if (effective[ids[0]] === 'attack' && effective[ids[1]] === 'attack') {
    for (const id of ids) {
      const enemyId = id === ids[0] ? ids[1] : ids[0];
      const ar = attackResults[id];
      if (ar && ar.power > 0) {
        const dealt = basicDamage(state.players[enemyId],ar.power);
        logs.push(`${state.players[id].name}의 ${ar.label} → ${dealt} 피해`);
      } else logs.push(`${state.players[id].name} 공격 ${ar?.label ?? '없음'}`);
    }
  }

  for (const p of [a,b]) {
    if (p.invincible > 0) p.invincible--;
    if (p.shield > 0) p.shield--;
    if (p.advancedBlock > 0) p.advancedBlock--;
    if (p.basicDebuff > 0) p.basicDebuff--;
    if (p.luckBoostTurns > 0) { p.luckBoostTurns--; if (p.luckBoostTurns === 0) p.luck = Math.max(0,p.luck-10); }
  }

  if (a.hp <= 0 || b.hp <= 0) {
    state.phase = 'finished';
    if (a.hp === b.hp) state.winnerId = null;
    else state.winnerId = a.hp > b.hp ? a.id : b.id;
    logs.push(state.winnerId ? `${state.players[state.winnerId].name} 승리!` : '무승부!');
  }
  return { text: logs.join(' | ') || '이번 턴에는 특별한 일이 없었습니다.' };
}

async function chooseAction(action) {
  if (!ACTIONS.includes(action)) return;
  const state = currentRoom?.game_state;
  if (!state || state.phase === 'finished' || myAction) return;
  const me = myPlayer(state);
  if (!me || me.stun > 0 || me.rest > 0 || (action === 'advanced' && me.advancedBlock > 0)) return;
  myAction = action;
  updateButtons(state);
  $('#turn-status').textContent = `선택 완료: ${ACTION_LABELS[action]} — 상대를 기다리는 중`;
  const { error } = await supabase.from('game_actions').insert({ room_code:currentRoom.room_code, turn:state.turn, player_id:playerId, action });
  if (error) { myAction = null; updateButtons(state); return alert(`행동 전송 오류: ${error.message}`); }
  if (!currentRoom.turn_started_at) {
    const { data, error:timerError } = await supabase.from('rooms').update({ turn_started_at:new Date().toISOString() }).eq('room_code',currentRoom.room_code).is('turn_started_at',null).select().maybeSingle();
    if (timerError) console.error(timerError);
    if (data) currentRoom = data;
  }
  startTimer(currentRoom.turn_started_at ?? new Date().toISOString());
  await checkForResolution();
}

async function checkForResolution() {
  if (!currentRoom?.game_state || currentRoom.game_state.phase === 'finished' || !isHost() || resolving) return;
  const turn = currentRoom.game_state.turn;
  const { data: actions, error } = await supabase.from('game_actions').select('*').eq('room_code',currentRoom.room_code).eq('turn',turn);
  if (error || !actions) return;
  const ids = [currentRoom.player1_id,currentRoom.player2_id];
  const actionMap = Object.fromEntries(actions.map(a => [a.player_id,a.action]));
  const both = ids.every(id => actionMap[id]);
  const timedOut = currentRoom.turn_started_at && Date.now() - new Date(currentRoom.turn_started_at).getTime() >= 5000;
  if (!both && !timedOut) return;
  resolving = true;
  try {
    const state = structuredClone(currentRoom.game_state);
    const actionsById = {};
    ids.forEach(id => actionsById[id] = actionMap[id] ?? null);
    const result = resolveTurn(state, actionsById);
    const currentTurn = turn;
    const nextTurn = state.phase === 'finished' ? state.turn : state.turn + 1;
    state.turn = nextTurn;
    state.lastResult = result.text;
    const { data, error:updateError } = await supabase.from('rooms').update({ game_state:state, status:state.phase === 'finished' ? 'finished' : 'playing', turn:nextTurn, turn_started_at:null, winner_id:state.winnerId, winner_name:state.winnerId ? state.players[state.winnerId].name : null }).eq('room_code',currentRoom.room_code).eq('turn',currentTurn).select().maybeSingle();
    if (updateError) throw updateError;
    if (data) currentRoom = data;
    await supabase.from('game_actions').delete().eq('room_code',currentRoom.room_code).eq('turn',currentTurn);
    myAction = null;
    resolving = false;
    showGame(state);
    startTimer(null);
  } catch (error) {
    console.error(error);
    resolving = false;
  }
}

if (joinButton) joinButton.addEventListener('click', joinRoom);
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => chooseAction(button.dataset.action)));