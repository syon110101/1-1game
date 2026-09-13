import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://qrqhqkzqncfyzcrzmltd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rR59AGdR8PF2VvIHc4TbjA_tte7SP3J';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (selector) => document.querySelector(selector);
const lobbyScreen = $('#lobby-screen');
const waitingScreen = $('#waiting-screen');
const gameScreen = $('#game-screen');
const joinButton = $('#join-button');

const playerId = localStorage.getItem('duel_player_id') || crypto.randomUUID();
localStorage.setItem('duel_player_id', playerId);

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
  $('#my-hp').style.width = `${Math.max(0, me.hp)}%`;
  $('#enemy-hp').style.width = `${Math.max(0, enemy?.hp ?? 0)}%`;
  $('#my-hp-text').textContent = `${me.hp} / ${MAX_HP}`;
  $('#enemy-hp-text').textContent = `${enemy?.hp ?? 0} / ${MAX_HP}`;
  $('#my-status').innerHTML = formatStatus(me);
  $('#enemy-status').innerHTML = formatStatus(enemy);
  $('#turn-number').textContent = `턴 ${state.turn}`;
  $('#turn-status').textContent = state.phase === 'finished' ? '전투 종료' : (myAction ? `선택 완료: ${ACTION_LABELS[myAction]} — 상대를 기다리는 중` : '행동을 선택하세요.');
  updateButtons(state);
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
  document.querySelectorAll('[data-action]').forEach(button => {
    let disabled = state.phase === 'finished' || Boolean(myAction) || me.stun > 0 || me.rest > 0;
    if (button.dataset.action === 'advanced' && me.advancedBlock > 0) disabled = true;
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
  if (currentRoom.status === 'playing' || currentRoom.status === 'finished') {
    showGame(currentRoom.game_state);
    startTimer(currentRoom.turn_started_at);
  }
}

async function resetRoomForNewPlayer(existing, name) {
  await supabase.from('game_actions').delete().eq('room_code', existing.room_code);
  const { data, error } = await supabase.from('rooms').update({
    player1_name:name,
    player1_id:playerId,
    player1_seen_at:new Date().toISOString(),
    player2_name:null,
    player2_id:null,
    player2_seen_at:null,
    status:'waiting',
    game_state:null,
    turn:1,
    turn_started_at:null,
    winner_id:null,
    winner_name:null
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
    const nextTurn = state.phase === 'finished' ? state.turn : state.turn + 1;
    state.turn = nextTurn;
    state.lastResult = result.text;
    const { data, error:updateError } = await supabase.from('rooms').update({ game_state:state, status:state.phase === 'finished' ? 'finished' : 'playing', turn:nextTurn, turn_started_at:null, winner_id:state.winnerId, winner_name:state.winnerId ? state.players[state.winnerId].name : null }).eq('room_code',currentRoom.room_code).eq('turn',turn).select().maybeSingle();
    if (updateError) throw updateError;
    if (data) currentRoom = data;
    myAction = null;
  } catch (error) {
    console.error('turn resolve error', error);
  } finally { resolving = false; }
}

function roll(min,max){return Math.floor(Math.random()*(max-min+1))+min;}
function chance(percent){return Math.random()*100<percent;}
function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
function basicDebuffFactor(p){return p.basicDebuff>0?.85:1;}
function rollAttack(p){const luck=clamp(p.luck,0,30),high=30+Math.min(15,luck),normal=50-Math.floor(Math.min(15,luck)*.5),factor=basicDebuffFactor(p),goodNormal=normal*factor,goodHigh=high*factor,r=Math.random()*100;if(r<100-goodNormal-goodHigh)return{damage:0,power:0,kind:'빗나감'};if(r<100-goodHigh)return{damage:roll(5,15),power:10,kind:'일반 공격'};return{damage:roll(16,30),power:23,kind:'강공격'};}
function rollDefense(p){return roll(0,Math.round(20+Math.min(5,p.luck/2)));}
function skillRoll(enemy){let r=Math.random()*100;if(r<20)return'흡혈';r-=20;if(r<15)return'스턴';r-=15;if(r<10)return'혼란';r-=10;if(r<20)return'출혈';r-=20;if(r<10)return'무적';r-=10;if(r<20)return'보호막';return enemy.hp<=30?'처형':'흡혈';}
function advanced(p){if(chance(40))return{success:true,penalty:''};p.advancedBlock=Math.max(p.advancedBlock,2);p.basicDebuff=Math.max(p.basicDebuff,1);const r=Math.random()*100;if(r<30){p.basicDebuff=Math.max(p.basicDebuff,3);return{success:false,penalty:'기본행동 약화 3턴'};}if(r<60){p.rest=Math.max(p.rest,1);return{success:false,penalty:'1턴 휴식'};}if(r<75){p.advancedBlock=Math.max(p.advancedBlock,3);return{success:false,penalty:'고급행동 금지 3턴'};}if(r<85)return{success:false,penalty:'추가 패널티 없음'};p.advancedBlock=0;p.basicDebuff=0;p.rest=0;return{success:false,penalty:'기본 패널티 제거'};}
function applyDamage(p,amount){if(amount<=0||p.invincible>0)return 0;if(p.shield>0)amount=Math.ceil(amount*.5);const dealt=Math.round(amount);p.hp=Math.max(0,p.hp-dealt);return dealt;}
function resolveSkill(p,enemy){const skill=skillRoll(enemy);if(skill==='흡혈'){const raw=roll(0,20),dealt=applyDamage(enemy,raw);p.hp=Math.min(100,p.hp+Math.round(dealt*.8));return`흡혈 ${dealt} 피해, 체력 회복`;}if(skill==='스턴'){enemy.stun=Math.max(enemy.stun,1);return'스턴: 상대의 다음 행동을 막았습니다.';}if(skill==='혼란'){if(!enemy.stun)enemy.confusion=Math.max(enemy.confusion,1);return'혼란: 상대의 다음 행동이 랜덤으로 바뀝니다.';}if(skill==='출혈'){enemy.bleed=roll(5,10);enemy.bleedTurns=3;return`출혈 ${enemy.bleed} 피해가 3턴 지속됩니다.`;}if(skill==='무적'){p.invincible=1;p.shield=0;return'무적: 다음 턴 받는 피해가 0입니다.';}if(skill==='보호막'){p.shield=2;p.invincible=0;return'보호막: 2턴 동안 받는 피해가 50% 감소합니다.';}if(skill==='처형'){if(enemy.hp<=30&&chance(80)){enemy.hp=0;return'처형 성공!';}return'처형 실패';}return'스킬 발동';}
function effectiveAction(p,action){if(!action||p.stun>0||p.rest>0)return null;if(p.confusion>0)return['attack','defend','counter','heal'][roll(0,3)];return action;}
function resolveTurn(state,actions){const ids=Object.keys(state.players),a=state.players[ids[0]],b=state.players[ids[1]],logs=[];const act={[ids[0]]:effectiveAction(a,actions[ids[0]]),[ids[1]]:effectiveAction(b,actions[ids[1]])};for(const id of ids)if(!actions[id])logs.push(`${state.players[id].name}은(는) 시간 초과로 행동하지 못했습니다.`);
  for(const id of ids)if(act[id]==='advanced'){const s=advanced(state.players[id]);logs.push(`${state.players[id].name}: 고급행동 ${s.success?'성공':'실패'}${s.penalty?` (${s.penalty})`:''}`);if(s.success){const enemy=state.players[id===ids[0]?ids[1]:ids[0]];logs.push(`${state.players[id].name}: ${resolveSkill(state.players[id],enemy)}`);}}
  const results={};for(const id of ids){const p=state.players[id];if(act[id]==='attack')results[id]=rollAttack(p);else if(act[id]==='defend')results[id]={damage:rollDefense(p),power:0,kind:'방어'};else if(act[id]==='counter')results[id]={damage:0,power:0,kind:'역공'};else if(act[id]==='heal'){const h=roll(0,20);p.hp=Math.min(100,p.hp+h);if(chance(50)){p.luck=Math.min(100,p.luck+10);p.luckBoostTurns=2;}logs.push(`${p.name}: 회복 ${h}${p.luckBoostTurns?' / 운 +10%':''}`);}}
  for(const id of ids){const enemyId=id===ids[0]?ids[1]:ids[0],enemy=state.players[enemyId],p=state.players[id],r=results[id];if(!r||!r.damage)continue;if(act[enemyId]==='defend'){const d=applyDamage(enemy,Math.max(0,r.damage-results[enemyId].damage));logs.push(`${p.name} ${r.kind} ${r.damage} / ${enemy.name} 방어 ${results[enemyId].damage} → ${d} 피해`);}else if(act[enemyId]==='counter'){const success=chance(clamp(60-r.power/2+enemy.luck/2,0,80));if(success){const d=applyDamage(p,r.damage);logs.push(`${enemy.name} 역공 성공 → ${d} 피해를 되돌렸습니다.`);}else{const d=applyDamage(enemy,Math.round(r.damage*1.1));logs.push(`${enemy.name} 역공 실패 → ${d} 피해`);}}else{const d=applyDamage(enemy,r.damage);logs.push(`${p.name} ${r.kind} → ${d} 피해`);}}
  for(const id of ids){const p=state.players[id];if(p.bleedTurns>0){p.hp=Math.max(0,p.hp-p.bleed);logs.push(`${p.name} 출혈 ${p.bleed} 피해`);p.bleedTurns--;if(!p.bleedTurns)p.bleed=0;}}
  const dead=ids.find(id=>state.players[id].hp<=0);if(dead){state.phase='finished';state.winnerId=ids.find(id=>id!==dead);logs.push(`${state.players[state.winnerId].name} 승리!`);}
  for(const id of ids){const p=state.players[id];for(const k of ['invincible','shield','stun','confusion','advancedBlock','basicDebuff','rest'])if(p[k]>0)p[k]--;if(p.luckBoostTurns>0){p.luckBoostTurns--;if(p.luckBoostTurns===0)p.luck=0;}}
  return{text:logs.join(' ')||'이번 턴에는 변화가 없습니다.'};}

joinButton.addEventListener('click', joinRoom);
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => chooseAction(button.dataset.action)));
$('#room-code').addEventListener('keydown', e => { if(e.key === 'Enter') joinRoom(); });
$('#player-name').addEventListener('keydown', e => { if(e.key === 'Enter') $('#room-code').focus(); });
