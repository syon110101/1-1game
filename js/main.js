// 게임 전체를 시작하는 진입점입니다.
// 실제 방 입장, 실시간 통신, 전투 판정은 다음 단계에서 추가합니다.

const lobbyScreen = document.querySelector('#lobby-screen');
const waitingScreen = document.querySelector('#waiting-screen');
const gameScreen = document.querySelector('#game-screen');
const joinButton = document.querySelector('#join-button');

joinButton.addEventListener('click', () => {
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

  document.querySelector('#waiting-room-code').textContent = roomCode;
  document.querySelector('#waiting-status').textContent = `${name}님, 상대를 기다리는 중...`;

  lobbyScreen.classList.add('hidden');
  waitingScreen.classList.remove('hidden');
});

// 행동 버튼은 이후 전투 시스템과 연결합니다.
document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    console.log('선택한 행동:', button.dataset.action);
  });
});
