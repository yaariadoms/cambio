const socket = io();

let myId = null;
let roomCode = null;
let lastState = null;
let lastModeKey = null;
let selectionBuffer = [];

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);

// ---------- DOM refs ----------
const screens = {
  loading: document.getElementById('screen-loading'),
  landing: document.getElementById('screen-landing'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
};

function showScreen(name) {
  for (const key of Object.keys(screens)) {
    screens[key].hidden = key !== name;
  }
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- Session persistence (survive a page refresh) ----------
function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem('cambio_session'));
  } catch {
    return null;
  }
}
function saveSession(session) {
  sessionStorage.setItem('cambio_session', JSON.stringify(session));
}
function clearSession() {
  sessionStorage.removeItem('cambio_session');
}

// ---------- Landing ----------
const nameInput = document.getElementById('nameInput');
const codeInput = document.getElementById('codeInput');

(function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) codeInput.value = room.toUpperCase();
  const savedName = localStorage.getItem('cambio_name');
  if (savedName) nameInput.value = savedName;
})();

// Runs on the initial connection AND on every automatic reconnect (e.g. a
// brief network drop), so a dropped connection recovers on its own and a
// full page refresh picks the same seat back up via the saved session.
let hasRouted = false;
socket.on('connect', () => {
  const session = getSession();
  if (session && session.roomCode && session.playerId && session.token) {
    if (!hasRouted) showScreen('loading');
    socket.emit('rejoin', session);
  } else if (!hasRouted) {
    showScreen('landing');
  }
  hasRouted = true;
});

document.getElementById('createBtn').addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Player';
  localStorage.setItem('cambio_name', name);
  socket.emit('createRoom', { name });
});

document.getElementById('joinBtn').addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Player';
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    showLandingError('Enter a room code.');
    return;
  }
  localStorage.setItem('cambio_name', name);
  socket.emit('joinRoom', { roomCode: code, name });
});

function showLandingError(msg) {
  const el = document.getElementById('landingError');
  el.textContent = msg;
  el.hidden = false;
}

socket.on('joined', ({ roomCode: code, playerId, token }) => {
  myId = playerId;
  roomCode = code;
  saveSession({ roomCode: code, playerId, token });
  history.replaceState(null, '', `${location.pathname}?room=${code}`);
});

socket.on('rejoinFailed', () => {
  clearSession();
  showScreen('landing');
  toast('Could not rejoin that game — it may have ended.');
});

socket.on('errorMsg', (msg) => toast(msg));

// ---------- Lobby ----------
document.getElementById('copyLinkBtn').addEventListener('click', () => {
  const input = document.getElementById('shareLink');
  input.select();
  navigator.clipboard?.writeText(input.value).catch(() => {});
  toast('Link copied!');
});

document.getElementById('startBtn').addEventListener('click', () => {
  socket.emit('startGame');
});

document.getElementById('playAgainBtn').addEventListener('click', () => {
  socket.emit('playAgain');
});

document.getElementById('addBotBtn').addEventListener('click', () => {
  socket.emit('addBot');
});

const MAX_PLAYERS = 4;

function renderLobby(state) {
  showScreen('lobby');
  document.getElementById('lobbyCode').textContent = state.roomCode;
  document.getElementById('shareLink').value = `${location.origin}/?room=${state.roomCode}`;

  const iAmHost = state.hostId === myId;

  const list = document.getElementById('lobbyPlayers');
  list.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = p.name + (p.id === myId ? ' (you)' : '');
    li.appendChild(label);
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'HOST';
      li.appendChild(tag);
    }
    if (p.isBot) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'BOT';
      li.appendChild(tag);
      if (iAmHost) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-small';
        removeBtn.textContent = 'Remove';
        removeBtn.onclick = () => socket.emit('removeBot', { playerId: p.id });
        li.appendChild(removeBtn);
      }
    }
    list.appendChild(li);
  }

  const startBtn = document.getElementById('startBtn');
  const addBotBtn = document.getElementById('addBotBtn');
  const hint = document.getElementById('lobbyHint');
  if (iAmHost) {
    startBtn.hidden = false;
    startBtn.disabled = state.players.length < 2;
    addBotBtn.hidden = false;
    addBotBtn.disabled = state.players.length >= MAX_PLAYERS;
    hint.hidden = state.players.length >= 2;
    hint.textContent = 'Need at least 2 players to start — add a bot if you’re playing solo.';
  } else {
    startBtn.hidden = true;
    addBotBtn.hidden = true;
    hint.hidden = false;
    hint.textContent = 'Waiting for the host to start…';
  }
}

// ---------- Ephemeral peek: a card flashes face-up briefly, then hides again
// even though the server remembers you know it. Only a fresh reveal (a
// known:false -> known:true transition) triggers the flash. ----------
const PEEK_FLASH_MS = 3500;
const revealUntil = new Map(); // "ownerId#index" -> timestamp
const knownLastSeen = new Set(); // "ownerId#index" known as of the previous render
let peekTimerScheduled = false;

function slotKey(ownerId, index) {
  return ownerId + '#' + index;
}

function processPeekTransitions(state) {
  if (state.phase === 'roundEnd') return; // permanent reveal for scoring, no flash logic
  const knownNow = new Set();
  for (const p of state.players) {
    p.hand.forEach((slot, idx) => {
      if (!slot.known) return;
      const key = slotKey(p.id, idx);
      knownNow.add(key);
      if (!knownLastSeen.has(key)) {
        revealUntil.set(key, Date.now() + PEEK_FLASH_MS);
      }
    });
  }
  knownLastSeen.clear();
  for (const key of knownNow) knownLastSeen.add(key);

  const now = Date.now();
  const stillPending = Array.from(revealUntil.values()).some((t) => t > now);
  if (!peekTimerScheduled && stillPending) {
    peekTimerScheduled = true;
    setTimeout(() => {
      peekTimerScheduled = false;
      if (lastState) renderGame(lastState);
    }, PEEK_FLASH_MS + 60);
  }
}

function isFlashing(ownerId, index) {
  const key = slotKey(ownerId, index);
  const until = revealUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    revealUntil.delete(key);
    return false;
  }
  return true;
}

// ---------- Game rendering ----------
function cardFace(rank, suit) {
  const el = document.createElement('div');
  el.className = 'card ' + (RED_SUITS.has(suit) ? 'red' : 'black');
  el.textContent = rank + SUIT_SYMBOL[suit];
  return el;
}

function cardBack() {
  const el = document.createElement('div');
  el.className = 'card card-back';
  return el;
}

function computeMode(state) {
  if (!state) return 'none';
  if (state.myDrawnCard) return 'swap';
  if (state.pendingPower && state.pendingPower.mine) {
    if (state.pendingPower.type === 'kingPower') return 'kingPower:' + state.pendingPower.stage;
    return 'power:' + state.pendingPower.type;
  }
  if (state.pendingGiveForMe) return 'give';
  if ((state.phase === 'play' || state.phase === 'finalGlue') && state.discardTop) return 'glue';
  return 'none';
}

function isClickable(mode, isMine) {
  switch (mode) {
    case 'swap': return isMine;
    case 'power:peekOwn': return isMine;
    case 'power:peekOpponent': return !isMine;
    case 'power:blindSwap': return true;
    case 'kingPower:start': return true;
    case 'give': return isMine;
    case 'glue': return true;
    default: return false;
  }
}

function inBuffer(playerId, index) {
  return selectionBuffer.some((s) => s.playerId === playerId && s.index === index);
}

function handleCardClick(mode, playerId, index, isMine) {
  if (mode === 'swap') {
    socket.emit('decideSwap', { index });
  } else if (mode === 'power:peekOwn') {
    socket.emit('powerAction', { type: 'peekOwn', index });
  } else if (mode === 'power:peekOpponent') {
    socket.emit('powerAction', { type: 'peekOpponent', targetPlayerId: playerId, index });
  } else if (mode === 'power:blindSwap') {
    addToSelectionBuffer(playerId, index, (sel) => {
      socket.emit('powerAction', {
        type: 'blindSwap',
        aPlayerId: sel[0].playerId, aIndex: sel[0].index,
        bPlayerId: sel[1].playerId, bIndex: sel[1].index,
      });
    });
  } else if (mode === 'kingPower:start') {
    // Toggle into a 1-or-2 card selection instead of auto-firing at a fixed
    // count -- the power bar shows a "Peek selected" button once >=1 is
    // picked, so the player chooses whether to peek just one or two.
    const pos = selectionBuffer.findIndex((s) => s.playerId === playerId && s.index === index);
    if (pos !== -1) selectionBuffer.splice(pos, 1);
    else if (selectionBuffer.length < 2) selectionBuffer.push({ playerId, index });
    renderGame(lastState);
  } else if (mode === 'give') {
    socket.emit('resolveGive', { index });
  } else if (mode === 'glue') {
    socket.emit('attemptGlue', { targetPlayerId: playerId, targetIndex: index });
  }
}

function addToSelectionBuffer(playerId, index, onComplete) {
  if (inBuffer(playerId, index)) return;
  selectionBuffer.push({ playerId, index });
  if (selectionBuffer.length >= 2) {
    const sel = selectionBuffer.slice(0, 2);
    selectionBuffer = [];
    onComplete(sel);
  } else {
    renderGame(lastState); // re-render to show highlight while waiting for 2nd pick
  }
}

// ---------- Stable visual hand slots ----------
// The server keeps each hand as a compact array (a glue splices a card out
// and shifts every later index down). Rendered directly, that makes every
// card after the glued one visibly jump to fill the gap. Instead we keep our
// own per-player mapping of "visual slot -> current server index" that only
// changes the specific slot that was glued (leaving it empty) or grown,
// never reflowing the others -- so cards you didn't touch stay exactly where
// they were.
const visualSlots = new Map(); // playerId -> Array<{serverIndex:number} | null>

function initVisualSlots(state) {
  visualSlots.clear();
  for (const p of state.players) {
    visualSlots.set(p.id, p.hand.map((_, i) => ({ serverIndex: i })));
  }
}

function occupiedCount(playerId) {
  return (visualSlots.get(playerId) || []).filter(Boolean).length;
}

function removeFromVisualSlots(playerId, serverIndex) {
  const slots = visualSlots.get(playerId);
  if (!slots) return;
  const pos = slots.findIndex((s) => s && s.serverIndex === serverIndex);
  if (pos !== -1) slots[pos] = null;
  for (const s of slots) {
    if (s && s.serverIndex > serverIndex) s.serverIndex -= 1;
  }
}

function addToVisualSlots(playerId, newServerIndex) {
  let slots = visualSlots.get(playerId);
  if (!slots) { slots = []; visualSlots.set(playerId, slots); }
  const emptyPos = slots.findIndex((s) => s === null);
  if (emptyPos !== -1) slots[emptyPos] = { serverIndex: newServerIndex };
  else slots.push({ serverIndex: newServerIndex });
}

function getVisualSlots(state, player) {
  return visualSlots.get(player.id) || player.hand.map((_, i) => ({ serverIndex: i }));
}

function makeHandGrid(player, isMine, mode, state) {
  const grid = document.createElement('div');
  grid.className = isMine ? 'hand-grid' : 'opp-grid';
  getVisualSlots(state, player).forEach((vslot) => {
    if (!vslot || !player.hand[vslot.serverIndex]) {
      const empty = document.createElement('div');
      empty.className = 'card card-empty';
      grid.appendChild(empty);
      return;
    }
    const idx = vslot.serverIndex;
    const slot = player.hand[idx];
    let el;
    const permanentReveal = state.phase === 'roundEnd';
    const showFace = slot.known && (permanentReveal || isFlashing(player.id, idx));
    if (showFace) {
      el = cardFace(slot.rank, slot.suit);
      if (!permanentReveal) el.classList.add('peeking');
    } else {
      el = cardBack();
    }
    el.dataset.player = player.id;
    el.dataset.index = String(idx);

    const clickable = (state.phase === 'play' || state.phase === 'finalGlue') && isClickable(mode, isMine);
    if (clickable) {
      el.classList.add('clickable');
      el.addEventListener('click', () => handleCardClick(mode, player.id, idx, isMine));
    }

    // Gluing works anytime a discard exists, on ANY card, regardless of
    // mode -- so a player isn't blocked from chaining more glues just
    // because they owe a give from a previous one. Giving is drag-only
    // as an alternative to the click-to-give fallback above.
    const canGlueDrag = (state.phase === 'play' || state.phase === 'finalGlue') && !!state.discardTop;
    const canGiveDrag = isMine && !!state.pendingGiveForMe;
    // J/Q (blind swap) and King's peek step: pick the pair by dragging one
    // card onto another -- any card, mine or an opponent's, either
    // direction, just never the discard pile.
    const powerPairType = mode === 'power:blindSwap' ? 'blindSwap' : (mode === 'kingPower:start' ? 'kingPower' : null);
    const canPowerPairDrag = !!powerPairType;
    if (canGlueDrag || canGiveDrag || canPowerPairDrag) {
      el.classList.add('draggable-card');
      setupCardDrag(el, player.id, idx, { showFace, rank: slot.rank, suit: slot.suit, canGlueDrag, canGiveDrag, powerPairType, state });
    }

    if (inBuffer(player.id, idx)) el.classList.add('selected');
    grid.appendChild(el);
  });
  return grid;
}

function setupCardDrag(el, playerId, index, opts) {
  el.addEventListener('pointerdown', (e) => {
    if (activeDrag) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const ghost = makeMovableCard({ faceUp: opts.showFace, rank: opts.rank, suit: opts.suit }, rect, 'drag-ghost');
    activeDrag = { kind: 'glue-or-give-drag', ghostEl: ghost, revealed: true };
    moveGhostTo(ghost, e.clientX, e.clientY);

    const onMove = (ev) => moveGhostTo(ghost, ev.clientX, ev.clientY);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!activeDrag || activeDrag.ghostEl !== ghost) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const discardHit = target && target.closest('#discardPile');
      const cardHit = target && target.closest('.card[data-player][data-index]');
      const droppedOnDifferentCard = cardHit && !(cardHit.dataset.player === playerId && cardHit.dataset.index === String(index));
      const oppHit = target && target.closest('.opponent[data-player]');

      if (opts.canGlueDrag && discardHit) {
        socket.emit('attemptGlue', { targetPlayerId: playerId, targetIndex: index });
        settleGhost(ghost, document.getElementById('discardPile').getBoundingClientRect(), () => { activeDrag = null; });
        return;
      }
      if (opts.powerPairType && droppedOnDifferentCard) {
        const bPlayerId = cardHit.dataset.player;
        const bIndex = parseInt(cardHit.dataset.index, 10);
        if (opts.powerPairType === 'blindSwap') {
          socket.emit('powerAction', {
            type: 'blindSwap',
            aPlayerId: playerId, aIndex: index,
            bPlayerId, bIndex,
          });
        } else {
          // King power: dragging card-to-card is the "just switch" option --
          // an immediate blind swap with no peek. Peeking is tap-based instead.
          socket.emit('powerAction', {
            type: 'kingPower', action: 'directSwap',
            a: { playerId, index }, b: { playerId: bPlayerId, index: bIndex },
          });
        }
        settleGhost(ghost, cardHit.getBoundingClientRect(), () => { activeDrag = null; });
        return;
      }
      if (opts.canGiveDrag && oppHit && oppHit.dataset.player === opts.state.pendingGiveToPlayerId) {
        socket.emit('resolveGive', { index });
        settleGhost(ghost, oppHit.getBoundingClientRect(), () => { activeDrag = null; });
        return;
      }
      settleGhost(ghost, el.getBoundingClientRect(), () => { activeDrag = null; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

// King power "decide" stage: the two peeked cards are shown face-up; drag
// either one onto the other to confirm the swap (card-to-card, no buttons).
function setupKingDecideDrag(sourceEl, targetEl, rank, suit) {
  sourceEl.classList.add('draggable-card');
  sourceEl.addEventListener('pointerdown', (e) => {
    if (activeDrag) return;
    e.preventDefault();
    const rect = sourceEl.getBoundingClientRect();
    const ghost = makeMovableCard({ faceUp: true, rank, suit }, rect, 'drag-ghost');
    activeDrag = { kind: 'king-decide-drag', ghostEl: ghost, revealed: true };
    moveGhostTo(ghost, e.clientX, e.clientY);

    const onMove = (ev) => moveGhostTo(ghost, ev.clientX, ev.clientY);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!activeDrag || activeDrag.ghostEl !== ghost) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      if (target && (target === targetEl || targetEl.contains(target))) {
        socket.emit('powerAction', { type: 'kingPower', action: 'decide', swap: true });
        settleGhost(ghost, targetEl.getBoundingClientRect(), () => { activeDrag = null; });
      } else {
        settleGhost(ghost, sourceEl.getBoundingClientRect(), () => { activeDrag = null; });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function describeStatus(state) {
  const cur = state.players.find((p) => p.id === state.currentPlayerId);
  const cambioNote = state.cambioCalledBy
    ? ` — Cambio called by ${state.players.find((p) => p.id === state.cambioCalledBy)?.name || '?'}! Final turns underway.`
    : '';
  if (state.phase === 'roundEnd') return 'Round complete! Check the results.';
  if (state.phase === 'dealing') return 'Memorize your bottom two cards — the game starts in a moment…';
  if (state.phase === 'finalGlue') return 'Last chance to glue before hands are revealed!';
  if (!cur) return 'Waiting…';
  if (cur.id === myId) {
    if (state.myDrawnCard) {
      return `You drew ${state.myDrawnCard.rank}${SUIT_SYMBOL[state.myDrawnCard.suit]} — drag it onto a card to swap${state.myDrawnCard.from === 'deck' ? ', or onto the discard pile to throw it away' : ''}.` + cambioNote;
    }
    if (state.pendingPower && state.pendingPower.mine) {
      const map = {
        peekOwn: 'Tap one of your own cards to peek at it.',
        peekOpponent: "Tap an opponent's card to peek at it.",
        blindSwap: 'Drag any card onto another (yours or an opponent\'s) to blind-swap them.',
      };
      if (state.pendingPower.type === 'kingPower') {
        return state.pendingPower.stage === 'start'
          ? 'King power: tap 1 or 2 cards to peek, or drag one card onto another to blind-swap without looking.'
          : 'King power: drag one peeked card onto the other to swap them, or leave them.';
      }
      return (map[state.pendingPower.type] || 'Resolve your power.') + cambioNote;
    }
    if (state.pendingGiveForMe) return 'Choose one of your cards to give away.' + cambioNote;
    return 'Your turn — press and drag the deck to draw.' + cambioNote;
  }
  return `${cur.name}'s turn.` + cambioNote;
}

function renderGame(state) {
  lastState = state;
  showScreen('game');
  processPeekTransitions(state);
  const mode = computeMode(state);
  const modeKey = mode + JSON.stringify(state.pendingPower) + state.myDrawnCard;
  if (modeKey !== lastModeKey) {
    selectionBuffer = [];
    lastModeKey = modeKey;
  }

  const me = state.players.find((p) => p.id === myId);
  document.getElementById('myName').textContent = me ? me.name + ' (you)' : '';

  // Opponents
  const oppContainer = document.getElementById('opponents');
  oppContainer.innerHTML = '';
  for (const p of state.players) {
    if (p.id === myId) continue;
    const panel = document.createElement('div');
    panel.className = 'opponent' + (p.id === state.currentPlayerId ? ' active-turn' : '') + (!p.connected ? ' disconnected' : '');
    panel.dataset.player = p.id;
    const nameEl = document.createElement('div');
    nameEl.className = 'opp-name';
    nameEl.innerHTML = `${p.name}${p.isBot ? ' (bot)' : ''} <span class="count">(${p.handCount})</span>`;
    panel.appendChild(nameEl);
    if (state.drawnPending && state.currentPlayerId === p.id) {
      // A precise, stable anchor for "the card they're currently holding" --
      // mirrors #drawnCard for me, so animations show exactly where a card
      // they took came from and where a card they discarded came from.
      const marker = document.createElement('div');
      marker.className = 'card card-back opp-drawn-marker';
      marker.dataset.player = p.id;
      panel.appendChild(marker);
    }
    panel.appendChild(makeHandGrid(p, false, mode, state));
    oppContainer.appendChild(panel);
  }

  // Deck / discard piles
  document.getElementById('deckCount').textContent = state.deckCount;
  const discardEl = document.getElementById('discardPile');
  if (state.discardTop) {
    discardEl.className = 'card pile-card ' + (RED_SUITS.has(state.discardTop.suit) ? 'red' : 'black');
    discardEl.textContent = state.discardTop.rank + SUIT_SYMBOL[state.discardTop.suit];
  } else {
    discardEl.className = 'card card-empty pile-card';
    discardEl.textContent = '';
  }

  const canDraw = computeCanDraw(state);
  document.getElementById('deckPile').classList.toggle('disabled', !canDraw || state.deckCount === 0);
  discardEl.classList.toggle('disabled', !canDraw || !state.discardTop);

  // Drawn card holder -- kept as a stable node (never replaced) so the
  // one-time drag listener bound to it in setupDrawnCardDrag stays attached.
  const drawnArea = document.getElementById('drawnArea');
  const drawnHolder = document.getElementById('drawnCard');
  if (state.myDrawnCard) {
    drawnArea.hidden = false;
    drawnHolder.className = 'card ' + (RED_SUITS.has(state.myDrawnCard.suit) ? 'red' : 'black');
    drawnHolder.textContent = state.myDrawnCard.rank + SUIT_SYMBOL[state.myDrawnCard.suit];
  } else {
    drawnArea.hidden = true;
    drawnHolder.className = 'card';
    drawnHolder.textContent = '';
  }

  document.getElementById('statusLine').textContent = describeStatus(state);

  // Decision bar (the drag is primary; button stays as a fallback)
  const decisionBar = document.getElementById('decisionBar');
  decisionBar.hidden = !state.myDrawnCard;
  document.getElementById('discardDrawnBtn').hidden = !(state.myDrawnCard && state.myDrawnCard.from === 'deck');
  document.getElementById('discardDrawnBtn').onclick = () => socket.emit('decideDiscard');

  // Power bar
  const powerBar = document.getElementById('powerBar');
  powerBar.innerHTML = '';
  powerBar.hidden = true;
  if (state.pendingPower && state.pendingPower.mine) {
    powerBar.hidden = false;
    if (state.pendingPower.type === 'kingPower' && state.pendingPower.stage === 'decide') {
      const t = state.pendingPower.targets;
      const label = document.createElement('span');
      label.textContent = 'Peeked two cards — drag one onto the other to swap them, or leave them.';
      powerBar.appendChild(label);
      const cardsRow = document.createElement('div');
      cardsRow.className = 'king-decide-row';
      const elA = cardFace(t[0].rank, t[0].suit);
      const elB = cardFace(t[1].rank, t[1].suit);
      cardsRow.appendChild(elA);
      cardsRow.appendChild(elB);
      powerBar.appendChild(cardsRow);
      setupKingDecideDrag(elA, elB, t[0].rank, t[0].suit);
      setupKingDecideDrag(elB, elA, t[1].rank, t[1].suit);
      const noBtn = document.createElement('button');
      noBtn.className = 'btn btn-secondary';
      noBtn.textContent = 'Leave them (no swap)';
      noBtn.onclick = () => socket.emit('powerAction', { type: 'kingPower', action: 'decide', swap: false });
      powerBar.appendChild(noBtn);
    } else if (state.pendingPower.type === 'kingPower' && state.pendingPower.stage === 'start') {
      const label = document.createElement('span');
      label.textContent = 'Tap 1 or 2 cards to peek, or drag one card onto another to blind-swap without looking.';
      powerBar.appendChild(label);
      if (selectionBuffer.length >= 1) {
        const peekBtn = document.createElement('button');
        peekBtn.className = 'btn btn-secondary';
        peekBtn.textContent = `Peek selected (${selectionBuffer.length})`;
        peekBtn.onclick = () => {
          const sel = selectionBuffer.slice();
          selectionBuffer = [];
          socket.emit('powerAction', { type: 'kingPower', action: 'peek', targets: sel });
        };
        powerBar.appendChild(peekBtn);
      }
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-secondary';
      skipBtn.textContent = 'Skip';
      skipBtn.onclick = () => socket.emit('skipPower');
      powerBar.appendChild(skipBtn);
    } else {
      const label = document.createElement('span');
      const labels = {
        peekOwn: 'Peek at one of your own cards.',
        peekOpponent: "Peek at an opponent's card.",
        blindSwap: 'Drag any card onto another to blind-swap them.',
      };
      label.textContent = labels[state.pendingPower.type] || 'Resolve power.';
      powerBar.appendChild(label);
      const skipBtn = document.createElement('button');
      skipBtn.className = 'btn btn-secondary';
      skipBtn.textContent = 'Skip';
      skipBtn.onclick = () => socket.emit('skipPower');
      powerBar.appendChild(skipBtn);
    }
  }

  // Give bar
  const giveBar = document.getElementById('giveBar');
  giveBar.hidden = !state.pendingGiveForMe;
  if (state.pendingGiveForMe) {
    const owedTo = state.players.find((p) => p.id === state.pendingGiveToPlayerId);
    giveBar.querySelector('span').textContent = `You must give a card to ${owedTo ? owedTo.name : 'them'} — drag one onto their area, or tap one.`;
  }

  // Cambio button
  const cambioBtn = document.getElementById('cambioBtn');
  cambioBtn.hidden = !canDraw || state.cambioCalledBy !== null;
  cambioBtn.onclick = () => {
    if (confirm('Call Cambio? Everyone else gets one more turn, then hands are revealed.')) {
      socket.emit('callCambio');
    }
  };

  // My hand
  const myHandEl = document.getElementById('myHand');
  myHandEl.innerHTML = '';
  if (me) myHandEl.appendChild(makeHandGrid(me, true, mode, state));

  // Log
  const logList = document.getElementById('logList');
  logList.innerHTML = '';
  for (const line of state.log) {
    const div = document.createElement('div');
    div.textContent = line;
    logList.appendChild(div);
  }

  // Round end modal
  const modal = document.getElementById('roundEndModal');
  if (state.phase === 'roundEnd' && state.result) {
    modal.hidden = false;
    const list = document.getElementById('resultList');
    list.innerHTML = '';
    const sorted = [...state.result.scores].sort((a, b) => a.score - b.score);
    for (const s of sorted) {
      const row = document.createElement('div');
      row.className = 'result-row' + (state.result.winners.includes(s.id) ? ' winner' : '');
      const handStr = s.hand.map((c) => c.rank + SUIT_SYMBOL[c.suit]).join(' ');
      row.innerHTML = `<span>${state.result.winners.includes(s.id) ? '🏆 ' : ''}${s.name}${s.id === state.cambioCalledBy ? ' (called Cambio)' : ''} — ${s.score} pts<br><span class="hand-preview">${handStr}</span></span>`;
      list.appendChild(row);
    }
    const iAmHost = state.hostId === myId;
    document.getElementById('playAgainBtn').hidden = !iAmHost;
    document.getElementById('waitHostText').hidden = iAmHost;
  } else {
    modal.hidden = true;
  }
}

// ---------- Drag & drop + flight animations ----------
const FLIGHT_MS = 420;
let activeDrag = null; // { kind, ghostEl, revealed? }
let cachedOwnDrawnCard = null; // last card I legitimately saw drawn, for animating my own swap/discard

function computeCanDraw(state) {
  return !!state && state.phase === 'play' && state.currentPlayerId === myId && !state.myDrawnCard &&
    !(state.pendingPower && state.pendingPower.mine) && !state.pendingGiveForMe;
}

function makeMovableCard({ faceUp, rank, suit }, rect, extraClass) {
  const el = document.createElement('div');
  el.className = 'card ' + extraClass + ' ' + (faceUp ? (RED_SUITS.has(suit) ? 'red' : 'black') : 'card-back');
  if (faceUp) el.textContent = rank + SUIT_SYMBOL[suit];
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  document.body.appendChild(el);
  return el;
}

function moveGhostTo(el, x, y) {
  el.style.left = (x - el.offsetWidth / 2) + 'px';
  el.style.top = (y - el.offsetHeight / 2) + 'px';
}

function settleGhost(el, rect, onDone) {
  el.style.transition = 'left .25s ease, top .25s ease, transform .25s ease';
  el.style.transform = 'none';
  requestAnimationFrame(() => {
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
  });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.remove();
    if (onDone) onDone();
  };
  el.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 400);
}

// A bright, unmissable blink around a card's edge for ~2s so anyone watching
// (including the player it happened to) can immediately spot which card just
// changed -- a new draw swapped in, a blind-swap outcome, a received give.
const BLINK_MS = 2000;
function blinkCard(el) {
  if (!el) return;
  el.classList.remove('just-changed');
  void el.offsetWidth; // force reflow so a re-trigger restarts the animation
  el.classList.add('just-changed');
  setTimeout(() => el.classList.remove('just-changed'), BLINK_MS);
}

function animateFlight({ fromRect, toRect, faceUp, rank, suit, duration = FLIGHT_MS, landOnEl }) {
  if (!fromRect || !toRect) return;
  const ghost = makeMovableCard({ faceUp, rank, suit }, fromRect, 'flight-card');
  ghost.style.transition = 'none';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ghost.style.transition = `left ${duration}ms ease, top ${duration}ms ease`;
      ghost.style.left = toRect.left + 'px';
      ghost.style.top = toRect.top + 'px';
      ghost.style.width = toRect.width + 'px';
      ghost.style.height = toRect.height + 'px';
    });
  });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    ghost.remove();
    // Re-resolve the target NOW rather than using a reference captured back
    // when animateFlight was called: renderGame fully rebuilds the DOM on
    // every state update (an unrelated peek-expiry timer or another
    // player's action can easily fire during this ~600ms flight), which
    // would otherwise silently orphan the blink on a detached old node.
    blinkCard(typeof landOnEl === 'function' ? landOnEl() : landOnEl);
  };
  ghost.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, duration + 200);
}

function getPlayerAnchorRect(playerId) {
  if (playerId === myId) return document.getElementById('myHand').getBoundingClientRect();
  const panel = document.querySelector(`.opponent[data-player="${playerId}"]`);
  return panel ? panel.getBoundingClientRect() : document.getElementById('opponents').getBoundingClientRect();
}

// FLIP-style precision: for slots whose element persists across a render
// (swap/blindSwap don't change hand length), we can use the exact slot rect
// both before (source) and after (destination). For slots that disappear
// (glue removes a card, shifting later indices), only the pre-render rect is
// meaningful, which is why we snapshot every slot's rect right before the
// DOM updates each time a new state arrives.
function getSlotEl(playerId, index) {
  return document.querySelector(`.card[data-player="${playerId}"][data-index="${index}"]`);
}
function getSlotRectNow(playerId, index) {
  const el = getSlotEl(playerId, index);
  return el ? el.getBoundingClientRect() : getPlayerAnchorRect(playerId);
}
function getSlotRectPre(preRects, playerId, index) {
  return preRects.get(playerId + '#' + index) || getPlayerAnchorRect(playerId);
}
function captureAllSlotRects() {
  const map = new Map();
  document.querySelectorAll('.card[data-player][data-index]').forEach((el) => {
    map.set(el.dataset.player + '#' + el.dataset.index, el.getBoundingClientRect());
  });
  document.querySelectorAll('.opp-drawn-marker[data-player]').forEach((el) => {
    map.set('marker#' + el.dataset.player, el.getBoundingClientRect());
  });
  return map;
}

// Precise anchor for "the card an opponent is currently holding" (mirrors my
// own #drawnCard). Falls back to their general panel if the marker isn't
// rendered (e.g. they don't currently have a pending draw).
function getOpponentMarkerElNow(playerId) {
  return document.querySelector(`.opp-drawn-marker[data-player="${playerId}"]`);
}
function getOpponentMarkerRectNow(playerId) {
  const el = getOpponentMarkerElNow(playerId);
  return el ? el.getBoundingClientRect() : null;
}
function getOpponentMarkerRectPre(preRects, playerId) {
  return preRects.get('marker#' + playerId) || null;
}

let lastSeenEventSeq = null;
let lastPhase = null;

function playEvent(evt, state, prevDiscardTop, preRects) {
  const deckRect = document.getElementById('deckPile').getBoundingClientRect();
  const discardRect = document.getElementById('discardPile').getBoundingClientRect();
  const drawnRect = document.getElementById('drawnCard').getBoundingClientRect();

  if (evt.type === 'draw') {
    if (evt.by === myId && activeDrag && !activeDrag.revealed &&
        (activeDrag.kind === 'deck-draw' || activeDrag.kind === 'discard-draw')) {
      // A drag is already showing this card in-hand; just flip it in place.
      if (state.myDrawnCard) {
        activeDrag.ghostEl.className = 'card drag-ghost ' + (RED_SUITS.has(state.myDrawnCard.suit) ? 'red' : 'black');
        activeDrag.ghostEl.textContent = state.myDrawnCard.rank + SUIT_SYMBOL[state.myDrawnCard.suit];
        activeDrag.revealed = true;
      }
      return;
    }
    const fromRect = evt.from === 'deck' ? deckRect : discardRect;
    const landLocator = evt.by === myId ? (() => document.getElementById('drawnCard')) : (() => getOpponentMarkerElNow(evt.by));
    const toRect = evt.by === myId ? drawnRect : (getOpponentMarkerRectNow(evt.by) || getPlayerAnchorRect(evt.by));
    let faceUp = false, rank, suit;
    if (evt.from === 'discard' && prevDiscardTop) {
      faceUp = true; rank = prevDiscardTop.rank; suit = prevDiscardTop.suit;
    } else if (evt.by === myId && state.myDrawnCard) {
      faceUp = true; rank = state.myDrawnCard.rank; suit = state.myDrawnCard.suit;
    }
    // So it's obvious someone just took a card, even before they've decided
    // what to do with it -- not only once it lands in a hand slot.
    animateFlight({ fromRect, toRect, faceUp, rank, suit, landOnEl: landLocator });
    return;
  }

  if (evt.type === 'swap') {
    const skipIncoming = evt.by === myId && activeDrag &&
      (activeDrag.kind === 'swap-settle' || activeDrag.kind === 'discard-settle');
    if (!skipIncoming) {
      let faceUp = false, rank, suit;
      if (evt.by === myId && cachedOwnDrawnCard) {
        faceUp = true; rank = cachedOwnDrawnCard.rank; suit = cachedOwnDrawnCard.suit;
      }
      // The new card lands in the exact slot it was swapped into. It came
      // from my drawn-card holder if it's my swap, or from the opponent's
      // own held-card marker if it's theirs (previously this always used MY
      // drawnCard rect, which was wrong for opponents' swaps).
      const swapFromRect = evt.by === myId ? drawnRect : (getOpponentMarkerRectPre(preRects, evt.by) || getPlayerAnchorRect(evt.by));
      animateFlight({ fromRect: swapFromRect, toRect: getSlotRectNow(evt.by, evt.index), faceUp, rank, suit, landOnEl: () => getSlotEl(evt.by, evt.index) });
    } else {
      // The drag gesture already showed the card settling in; still blink
      // the slot so it's just as easy to spot as any other swap.
      blinkCard(getSlotEl(evt.by, evt.index));
    }
    if (evt.by === myId) cachedOwnDrawnCard = null;
    if (state.discardTop) {
      // The old card visibly came from that exact same slot.
      animateFlight({ fromRect: getSlotRectPre(preRects, evt.by, evt.index), toRect: discardRect, faceUp: true, rank: state.discardTop.rank, suit: state.discardTop.suit });
    }
    return;
  }

  if (evt.type === 'discard') {
    const skip = evt.by === myId && activeDrag && activeDrag.kind === 'discard-settle';
    if (evt.by === myId) cachedOwnDrawnCard = null;
    if (skip) return;
    const fromRect = evt.by === myId ? drawnRect : (getOpponentMarkerRectPre(preRects, evt.by) || getPlayerAnchorRect(evt.by));
    if (state.discardTop) {
      animateFlight({ fromRect, toRect: discardRect, faceUp: true, rank: state.discardTop.rank, suit: state.discardTop.suit });
    }
    return;
  }

  if (evt.type === 'glue') {
    if (state.discardTop) {
      // Flies from the exact slot it was glued from (which may no longer
      // exist post-render, since gluing shrinks the hand) -- hence pre-rects.
      animateFlight({ fromRect: getSlotRectPre(preRects, evt.ownerId, evt.index), toRect: discardRect, faceUp: true, rank: state.discardTop.rank, suit: state.discardTop.suit });
    }
    return;
  }

  if (evt.type === 'glueFail') {
    // Nothing moves -- the card just gets exposed in place as a penalty.
    const el = getSlotEl(evt.ownerId, evt.index);
    if (el) {
      el.classList.add('reveal-wrong');
      setTimeout(() => el.classList.remove('reveal-wrong'), 700);
    }
    return;
  }

  if (evt.type === 'give') {
    const receiver = state.players.find((p) => p.id === evt.to);
    const receiverIndex = receiver ? receiver.handCount - 1 : null;
    animateFlight({
      fromRect: getPlayerAnchorRect(evt.from), toRect: getPlayerAnchorRect(evt.to), faceUp: false,
      landOnEl: receiverIndex === null ? null : () => getSlotEl(evt.to, receiverIndex),
    });
    return;
  }

  if (evt.type === 'blindSwap') {
    if (evt.a.playerId === evt.b.playerId) return;
    const rectAPre = getSlotRectPre(preRects, evt.a.playerId, evt.a.index);
    const rectBPre = getSlotRectPre(preRects, evt.b.playerId, evt.b.index);
    const rectANow = getSlotRectNow(evt.a.playerId, evt.a.index);
    const rectBNow = getSlotRectNow(evt.b.playerId, evt.b.index);
    // Content trades places: what was at A flies to where B now shows it, and vice versa.
    animateFlight({ fromRect: rectAPre, toRect: rectBNow, faceUp: false, landOnEl: () => getSlotEl(evt.b.playerId, evt.b.index) });
    animateFlight({ fromRect: rectBPre, toRect: rectANow, faceUp: false, landOnEl: () => getSlotEl(evt.a.playerId, evt.a.index) });
    return;
  }
}

function setupDeckDrag() {
  const deckEl = document.getElementById('deckPile');
  deckEl.addEventListener('pointerdown', (e) => {
    if (activeDrag) return;
    if (!computeCanDraw(lastState) || lastState.deckCount === 0) return;
    e.preventDefault();
    const rect = deckEl.getBoundingClientRect();
    const ghost = makeMovableCard({ faceUp: false }, rect, 'drag-ghost');
    activeDrag = { kind: 'deck-draw', ghostEl: ghost, revealed: false };
    moveGhostTo(ghost, e.clientX, e.clientY);
    socket.emit('drawFromDeck');

    const onMove = (ev) => moveGhostTo(ghost, ev.clientX, ev.clientY);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!activeDrag || activeDrag.ghostEl !== ghost) return;
      const toRect = document.getElementById('drawnCard').getBoundingClientRect();
      settleGhost(ghost, toRect, () => { activeDrag = null; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function setupDiscardDrag() {
  const discardEl = document.getElementById('discardPile');
  discardEl.addEventListener('pointerdown', (e) => {
    if (activeDrag) return;
    if (!computeCanDraw(lastState) || !lastState.discardTop) return;
    e.preventDefault();
    const rect = discardEl.getBoundingClientRect();
    const { rank, suit } = lastState.discardTop;
    const ghost = makeMovableCard({ faceUp: true, rank, suit }, rect, 'drag-ghost');
    activeDrag = { kind: 'discard-draw', ghostEl: ghost, revealed: true };
    moveGhostTo(ghost, e.clientX, e.clientY);
    socket.emit('drawFromDiscard');

    const onMove = (ev) => moveGhostTo(ghost, ev.clientX, ev.clientY);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!activeDrag || activeDrag.ghostEl !== ghost) return;
      const toRect = document.getElementById('drawnCard').getBoundingClientRect();
      settleGhost(ghost, toRect, () => { activeDrag = null; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

function setupDrawnCardDrag() {
  const drawnEl = document.getElementById('drawnCard');
  drawnEl.addEventListener('pointerdown', (e) => {
    if (activeDrag) return;
    if (!lastState || !lastState.myDrawnCard || lastState.currentPlayerId !== myId) return;
    e.preventDefault();
    const rect = drawnEl.getBoundingClientRect();
    const { rank, suit, from } = lastState.myDrawnCard;
    const ghost = makeMovableCard({ faceUp: true, rank, suit }, rect, 'drag-ghost');
    activeDrag = { kind: 'holding-drawn', ghostEl: ghost, revealed: true };
    moveGhostTo(ghost, e.clientX, e.clientY);
    drawnEl.style.visibility = 'hidden';

    const onMove = (ev) => moveGhostTo(ghost, ev.clientX, ev.clientY);
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      drawnEl.style.visibility = '';
      if (!activeDrag || activeDrag.ghostEl !== ghost) return;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const slotEl = target && target.closest(`.card[data-player="${myId}"][data-index]`);
      const discardHit = target && target.closest('#discardPile');
      if (slotEl) {
        const index = parseInt(slotEl.dataset.index, 10);
        activeDrag = { kind: 'swap-settle', ghostEl: ghost, revealed: true };
        socket.emit('decideSwap', { index });
        settleGhost(ghost, document.getElementById('myHand').getBoundingClientRect(), () => { activeDrag = null; });
      } else if (discardHit && from === 'deck') {
        activeDrag = { kind: 'discard-settle', ghostEl: ghost, revealed: true };
        socket.emit('decideDiscard');
        settleGhost(ghost, document.getElementById('discardPile').getBoundingClientRect(), () => { activeDrag = null; });
      } else {
        settleGhost(ghost, drawnEl.getBoundingClientRect(), () => { activeDrag = null; });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

setupDeckDrag();
setupDiscardDrag();
setupDrawnCardDrag();

socket.on('state', (state) => {
  const prevDiscardTop = lastState ? lastState.discardTop : null;
  const preRects = captureAllSlotRects();
  if (state.myDrawnCard) cachedOwnDrawnCard = state.myDrawnCard;

  if (state.phase === 'lobby') {
    lastState = state;
    renderLobby(state);
    return;
  }

  const ACTIVE_PHASES = new Set(['dealing', 'play']);
  if (ACTIVE_PHASES.has(state.phase) && !ACTIVE_PHASES.has(lastPhase)) {
    // Fresh round (or a reconnect mid-game): don't replay history or
    // treat already-known cards as freshly peeked.
    knownLastSeen.clear();
    revealUntil.clear();
    lastSeenEventSeq = null;
    cachedOwnDrawnCard = null;
    initVisualSlots(state);
  }
  lastPhase = state.phase;

  let newEvents = [];
  const events = state.events || [];
  if (lastSeenEventSeq === null) {
    lastSeenEventSeq = events.length ? events[events.length - 1].seq : 0;
  } else {
    newEvents = events.filter((e) => e.seq > lastSeenEventSeq);
    if (newEvents.length) lastSeenEventSeq = newEvents[newEvents.length - 1].seq;
  }

  // Structural slot changes (a glue/give removing or adding a card) must be
  // applied BEFORE rendering, so the render itself reflects the stable
  // layout. Animations are triggered AFTER rendering, since some need the
  // freshly-rendered DOM (exact destination rects/elements).
  for (const evt of newEvents) applyVisualSlotMutation(evt, state);

  renderGame(state);
  for (const evt of newEvents) playEvent(evt, state, prevDiscardTop, preRects);
});

function applyVisualSlotMutation(evt, state) {
  if (evt.type === 'glue') {
    removeFromVisualSlots(evt.ownerId, evt.index);
  } else if (evt.type === 'give') {
    removeFromVisualSlots(evt.from, evt.index);
    const receiver = state.players.find((p) => p.id === evt.to);
    if (receiver) addToVisualSlots(evt.to, receiver.handCount - 1);
  } else if (evt.type === 'glueFail') {
    const gluer = state.players.find((p) => p.id === evt.by);
    if (gluer && gluer.handCount > occupiedCount(evt.by)) {
      addToVisualSlots(evt.by, gluer.handCount - 1);
    }
  }
}
