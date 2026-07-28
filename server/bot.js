const { cardValue, powerFor } = require('./deck');

// A bot only ever acts on card values it legitimately knows via room.knows(),
// same information a human player would have. It never peeks at the real
// (server-internal) hand contents beyond that.
const UNKNOWN_ESTIMATE = 6.5;
const CAMBIO_CALL_THRESHOLD = 4;
const DISCARD_TAKE_THRESHOLD = 3;

function estimateOwnScore(room, botId) {
  const bot = room.getPlayer(botId);
  let total = 0;
  bot.hand.forEach((card, idx) => {
    total += room.knows(botId, botId, idx) ? cardValue(card) : UNKNOWN_ESTIMATE;
  });
  return total;
}

function knownCount(room, botId) {
  return room.getPlayer(botId).hand.filter((_, idx) => room.knows(botId, botId, idx)).length;
}

function worstKnownSlot(room, viewerId, ownerId) {
  let best = null;
  room.getPlayer(ownerId).hand.forEach((card, idx) => {
    if (!room.knows(viewerId, ownerId, idx)) return;
    const v = cardValue(card);
    if (!best || v > best.value) best = { index: idx, value: v };
  });
  return best;
}

function bestKnownSlot(room, viewerId, ownerId) {
  let best = null;
  room.getPlayer(ownerId).hand.forEach((card, idx) => {
    if (!room.knows(viewerId, ownerId, idx)) return;
    const v = cardValue(card);
    if (!best || v < best.value) best = { index: idx, value: v };
  });
  return best;
}

function randomUnknownSlot(room, viewerId, ownerId) {
  const options = [];
  room.getPlayer(ownerId).hand.forEach((_, idx) => {
    if (!room.knows(viewerId, ownerId, idx)) options.push(idx);
  });
  if (!options.length) return null;
  return options[Math.floor(Math.random() * options.length)];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function resolvePendingPower(room, botId) {
  const pending = room.pendingPower;
  if (!pending || pending.playerId !== botId) return;

  if (pending.type === 'peekOwn') {
    const idx = randomUnknownSlot(room, botId, botId);
    if (idx === null) return room.skipPower(botId);
    return room.powerAction(botId, { type: 'peekOwn', index: idx });
  }

  if (pending.type === 'peekOpponent') {
    const candidates = [];
    for (const opp of room.players) {
      if (opp.id === botId) continue;
      const idx = randomUnknownSlot(room, botId, opp.id);
      if (idx !== null) candidates.push({ playerId: opp.id, index: idx });
    }
    if (!candidates.length) return room.skipPower(botId);
    const target = pick(candidates);
    return room.powerAction(botId, { type: 'peekOpponent', targetPlayerId: target.playerId, index: target.index });
  }

  if (pending.type === 'blindSwap') {
    const myWorst = worstKnownSlot(room, botId, botId);
    let bestTarget = null;
    if (myWorst) {
      for (const opp of room.players) {
        if (opp.id === botId) continue;
        const theirBest = bestKnownSlot(room, botId, opp.id);
        if (theirBest && theirBest.value < myWorst.value && (!bestTarget || theirBest.value < bestTarget.value)) {
          bestTarget = { ...theirBest, playerId: opp.id };
        }
      }
    }
    if (myWorst && bestTarget) {
      return room.powerAction(botId, {
        type: 'blindSwap',
        aPlayerId: botId, aIndex: myWorst.index,
        bPlayerId: bestTarget.playerId, bIndex: bestTarget.index,
      });
    }
    return room.skipPower(botId);
  }

  if (pending.type === 'kingPower') {
    if (pending.stage === 'start') {
      const unknownOptions = [];
      const allOptions = [];
      for (const p of room.players) {
        p.hand.forEach((_, idx) => {
          allOptions.push({ playerId: p.id, index: idx });
          if (!room.knows(botId, p.id, idx)) unknownOptions.push({ playerId: p.id, index: idx });
        });
      }
      const pool = unknownOptions.length >= 2 ? unknownOptions.slice() : allOptions.slice();
      const targets = [];
      while (targets.length < 2 && pool.length) {
        const choice = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        if (!targets.some((t) => t.playerId === choice.playerId && t.index === choice.index)) {
          targets.push(choice);
        }
      }
      if (targets.length < 2) return room.skipPower(botId);
      room.powerAction(botId, { type: 'kingPower', action: 'peek', targets });
      // Peeking immediately advances the power into its 'decide' stage;
      // resolve that too now so the bot doesn't leave its turn half-done.
      return resolvePendingPower(room, botId);
    }
    if (pending.stage === 'decide') {
      const [ta, tb] = pending.targets;
      const cardA = room.getPlayer(ta.playerId).hand[ta.index];
      const cardB = room.getPlayer(tb.playerId).hand[tb.index];
      let swap = false;
      if (ta.playerId === botId && tb.playerId !== botId && cardValue(cardA) > cardValue(cardB)) swap = true;
      if (tb.playerId === botId && ta.playerId !== botId && cardValue(cardB) > cardValue(cardA)) swap = true;
      return room.powerAction(botId, { type: 'kingPower', action: 'decide', swap });
    }
  }
}

function runBotTurn(room, botId) {
  const bot = room.getPlayer(botId);
  if (!bot || bot.hand.length === 0) return;

  if (room.cambioCalledBy === null) {
    const estimate = estimateOwnScore(room, botId);
    if (estimate <= CAMBIO_CALL_THRESHOLD && knownCount(room, botId) >= 2) {
      room.callCambio(botId);
      return;
    }
  }

  const discardTop = room.discardPile[room.discardPile.length - 1];
  if (discardTop && cardValue(discardTop) <= DISCARD_TAKE_THRESHOLD) {
    room.drawFromDiscard(botId);
    const worst = worstKnownSlot(room, botId, botId);
    let slot;
    if (worst && worst.value > cardValue(discardTop)) {
      slot = worst.index;
    } else {
      const unknown = randomUnknownSlot(room, botId, botId);
      slot = unknown !== null ? unknown : 0;
    }
    room.decideSwap(botId, Math.min(slot, bot.hand.length - 1));
    return;
  }

  room.drawFromDeck(botId);
  const drawn = room.drawnCard;
  const value = cardValue(drawn);
  const power = powerFor(drawn);
  const worst = worstKnownSlot(room, botId, botId);
  const unknownIdx = randomUnknownSlot(room, botId, botId);

  if (power && value >= 7) {
    room.decideDiscard(botId);
    resolvePendingPower(room, botId);
    return;
  }
  if (worst && worst.value > value) {
    room.decideSwap(botId, worst.index);
    return;
  }
  if (unknownIdx !== null) {
    room.decideSwap(botId, unknownIdx);
    return;
  }
  room.decideDiscard(botId);
  resolvePendingPower(room, botId);
}

module.exports = { runBotTurn };
