import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// TODO: Supabase 프로젝트를 만든 뒤 아래 두 값을 넣으세요.
const SUPABASE_URL = 'https://qrqhqkzqncfyzcrzmltd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_rR59AGdR8PF2VvIHc4TbjA_tte7SP3J';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const lobbyScreen = document.querySelector('#lobby-screen');
const waitingScreen = document.querySelector('#waiting-screen');
const gameScreen = document.querySelector('#game-screen');
const joinButton = document.querySelector('#join-button');

let playerId = crypto.randomUUID();
let currentRoom = null;

function showWaitingScreen(roomCode, message) {
  document.querySelector('#waiting-room-code').textContent = roomCode;
  document.querySelector('#waiting-status').textContent = message;
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.add('hidden');
  waitingScreen.classList.remove('hidden');
}

function startGame() {
  document.querySelector('#my-name').textContent = currentRoom.player1_id === playerId
    ? currentRoom.player1_name
    : currentRoom.player2_name;

  document.querySelector('#enemy-name').textContent = currentRoom.player1_id === playerId
    ? currentRoom.player2_name
    : currentRoom.player1_name;

  waitingScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  document.querySelector('#battle-log').innerHTML = '<p>전투를 준비하세요.</p>';
}

async function joinRoom() {
  const name = document.querySelector('#player-name').value.trim();
  const roomCode = document.querySelector('#room-code').value.trim();

  if (!name) {
    alert('이름을 입력해주세요.');
    return;
  }

  if (!/^\d{4}$/.test(roomCode)) {
    alert('방번호는 4자리 숫자로 입력해주세요.');
    return;
  }

  joinButton.disabled = true;

  try {
    const { data: existingRoom, error: findError } = await supabase
      .from('rooms')
      .select('*')
      .eq('room_code', roomCode)
      .maybeSingle();

    if (findError) throw findError;

    if (!existingRoom) {
      const { data, error } = await supabase
        .from('rooms')
        .insert({
          room_code: roomCode,
          player1_name: name,
          player1_id: playerId,
          status: 'waiting'
        })
        .select()
        .single();

      if (error) throw error;
      currentRoom = data;
      showWaitingScreen(roomCode, '상대를 기다리는 중...');
      subscribeToRoom(roomCode);
      return;
    }

    if (existingRoom.player2_id) {
      alert('이미 두 명이 들어간 방입니다. 다른 방번호를 사용해주세요.');
      return;
    }

    const { data, error } = await supabase
      .from('rooms')
      .update({
        player2_name: name,
        player2_id: playerId,
        status: 'starting'
      })
      .eq('room_code', roomCode)
      .select()
      .single();

    if (error) throw error;
    currentRoom = data;
    showWaitingScreen(roomCode, '상대가 입장했습니다. 잠시 후 시작합니다!');
    subscribeToRoom(roomCode);
    setTimeout(startGame, 2000);
  } catch (error) {
    console.error(error);
    alert('방에 들어가는 중 오류가 발생했습니다. Supabase 설정을 확인해주세요.');
  } finally {
    joinButton.disabled = false;
  }
}

function subscribeToRoom(roomCode) {
  supabase
    .channel(`room-${roomCode}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'rooms',
        filter: `room_code=eq.${roomCode}`
      },
      (payload) => {
        currentRoom = payload.new;

        if (currentRoom.player1_id && currentRoom.player2_id) {
          showWaitingScreen(roomCode, '상대가 입장했습니다. 잠시 후 시작합니다!');
          setTimeout(startGame, 2000);
        }
      }
    )
    .subscribe();
}

joinButton.addEventListener('click', joinRoom);

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    console.log('선택한 행동:', button.dataset.action);
  });
});
