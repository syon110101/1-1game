import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const FIX_SUPABASE_URL = 'https://qrqhqkzqncfyzcrzmltd.supabase.co';
const FIX_SUPABASE_KEY = 'sb_publishable_rR59AGdR8PF2VvIHc4TbjA_tte7SP3J';
const fixSupabase = createClient(FIX_SUPABASE_URL, FIX_SUPABASE_KEY);

let fixSelected = false;

function getRoomCode() {
  return document.querySelector('#waiting-room-code')?.textContent?.trim() || '';
}

async function handleBattleAction(action) {
  if (fixSelected) return;

  const roomCode = getRoomCode();
  const myName = document.querySelector('#my-name')?.textContent?.trim();
  if (!/^\d{4}$/.test(roomCode) || !myName) {
    alert('방 정보를 불러오지 못했습니다. 게임에 다시 입장해주세요.');
    return;
  }

  const buttons = document.querySelectorAll('[data-action]');
  fixSelected = true;
  buttons.forEach(button => button.disabled = true);

  try {
    const { data: room, error: roomError } = await fixSupabase
      .from('rooms')
      .select('*')
      .eq('room_code', roomCode)
      .maybeSingle();

    if (roomError) throw roomError;
    if (!room?.game_state) throw new Error('게임 상태를 찾을 수 없습니다.');

    const state = room.game_state;
    const playerId = room.player1_name === myName ? room.player1_id : room.player2_name === myName ? room.player2_id : null;
    if (!playerId || !state.players?.[playerId]) throw new Error('플레이어 정보를 찾을 수 없습니다.');

    const me = state.players[playerId];
    if (state.phase === 'finished') return;
    if (me.stun > 0 || me.rest > 0) return;
    if (action === 'advanced' && me.advancedBlock > 0) return;

    const { error: insertError } = await fixSupabase
      .from('game_actions')
      .insert({ room_code: roomCode, turn: state.turn, player_id: playerId, action });

    if (insertError) {
      if (insertError.code === '23505') throw new Error('이미 이번 턴의 행동을 선택했습니다.');
      throw insertError;
    }

    document.querySelector('#turn-status').textContent = '선택 완료 — 상대를 기다리는 중';

    if (!room.turn_started_at) {
      const startedAt = new Date().toISOString();
      const { error: timerError } = await fixSupabase
        .from('rooms')
        .update({ turn_started_at: startedAt })
        .eq('room_code', roomCode)
        .is('turn_started_at', null);
      if (timerError) console.error('timer update error', timerError);
    }
  } catch (error) {
    console.error('action error', error);
    alert(`행동 선택 오류: ${error.message || '알 수 없는 오류'}`);
    fixSelected = false;
    buttons.forEach(button => button.disabled = false);
  }
}

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => handleBattleAction(button.dataset.action));
});
