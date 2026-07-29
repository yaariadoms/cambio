const crypto = require('crypto');
const { makeDeck, shuffle, cardValue, powerFor } = require('./deck');

let nextPlayerId = 1;

class Room {
  constructor(code) {
    this.code = code;
    this.players = []; // { id, socketId, name, hand: [card,...], connected }
    this.hostId = null;
    this.phase = 'lobby'; // lobby | play | roundEnd
    this.deck = [];
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.drawnCard = null;
    this.drawnFrom = null; // 'deck' | 'discard'
    this.pendingPower = null; // { type, playerId, ...extra }
    this.pendingGives = []; // { fromPlayerId, toPlayerId }
    this.cambioCalledBy = null;
    this.cambioFinalTurnsRemaining = null;
    this.knowledge = new Map(); // viewerId -> Set('ownerId#index')
    this.log = [];
    this.lastResult = null;
    this.botTurnScheduled = false;
    this.nextBotNumber = 1;
    this.events = []; // structured, viewer-agnostic movement events for animation
    this.eventSeq = 0;
    this.finalGlueScheduled = false; // used by index.js to schedule the delayed endRound()
    this.glueStreakOwner = null; // playerId who currently has exclusive rights to glue the top card
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 50) this.log.shift();
  }

  // Structured events never carry hidden card values (except values already
  // public, like a discard pile top) -- they're safe to broadcast identically
  // to every viewer and are purely a hint for client-side animation.
  addEvent(evt) {
    evt.seq = ++this.eventSeq;
    this.events.push(evt);
    if (this.events.length > 30) this.events.shift();
  }

  addPlayer(socketId, name) {
    const player = {
      id: 'p' + nextPlayerId++,
      socketId,
      token: crypto.randomBytes(16).toString('hex'),
      name: name || 'Player',
      hand: [],
      connected: true,
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  addBot() {
    const player = {
      id: 'p' + nextPlayerId++,
      socketId: null,
      token: null,
      name: `Bot ${this.nextBotNumber++}`,
      hand: [],
      connected: true,
      isBot: true,
    };
    this.players.push(player);
    return player;
  }

  removeBot(playerId) {
    const player = this.getPlayer(playerId);
    if (!player || !player.isBot) throw new Error('Not a bot');
    if (this.phase !== 'lobby') throw new Error('Cannot remove a bot after the game has started');
    this.players = this.players.filter((p) => p.id !== playerId);
  }

  getPlayerBySocket(socketId) {
    return this.players.find((p) => p.socketId === socketId);
  }

  getPlayer(playerId) {
    return this.players.find((p) => p.id === playerId);
  }

  reconnectPlayer(playerId, token, socketId) {
    const player = this.getPlayer(playerId);
    if (!player || player.token !== token) return null;
    player.socketId = socketId;
    player.connected = true;
    this.addLog(`${player.name} reconnected.`);
    return player;
  }

  removeBySocket(socketId) {
    const player = this.getPlayerBySocket(socketId);
    if (!player) return;
    // Keep the player in the room (even in the lobby) so a refresh/reconnect
    // via their token can pick their seat back up; only mark them offline.
    player.connected = false;
    this.addLog(`${player.name} disconnected.`);
  }

  isEmpty() {
    return this.players.length === 0 || this.players.every((p) => !p.connected);
  }

  // ---- knowledge helpers ----
  grantKnowledge(viewerId, ownerId, index) {
    if (!this.knowledge.has(viewerId)) this.knowledge.set(viewerId, new Set());
    this.knowledge.get(viewerId).add(`${ownerId}#${index}`);
  }

  knows(viewerId, ownerId, index) {
    const set = this.knowledge.get(viewerId);
    return !!set && set.has(`${ownerId}#${index}`);
  }

  revealToAll(ownerId, index) {
    for (const p of this.players) this.grantKnowledge(p.id, ownerId, index);
  }

  invalidateSlot(ownerId, index) {
    const key = `${ownerId}#${index}`;
    for (const set of this.knowledge.values()) set.delete(key);
  }

  invalidateFrom(ownerId, fromIndex) {
    const prefix = `${ownerId}#`;
    for (const set of this.knowledge.values()) {
      for (const key of Array.from(set)) {
        if (key.startsWith(prefix)) {
          const idx = parseInt(key.slice(prefix.length), 10);
          if (idx >= fromIndex) set.delete(key);
        }
      }
    }
  }

  // ---- game lifecycle ----
  // Dealing happens in two steps so everyone gets an uninterrupted moment to
  // peek at their own bottom two cards before the starting discard card is
  // revealed and turns begin: startGame() deals and grants the peek, then
  // (after a delay controlled by the caller) beginPlay() flips the first
  // discard card and actually starts play.
  startGame() {
    if (this.players.length < 2) throw new Error('Need at least 2 players');
    // The winner of the previous round leads the next one; the very first
    // round of a fresh game picks randomly so the host isn't always first.
    const previousWinnerId = this.lastResult && this.lastResult.winners && this.lastResult.winners.length
      ? this.lastResult.winners[0]
      : null;

    this.deck = shuffle(makeDeck());
    this.discardPile = [];
    this.knowledge = new Map();
    this.log = [];
    this.pendingGives = [];
    this.pendingPower = null;
    this.drawnCard = null;
    this.drawnFrom = null;
    this.cambioCalledBy = null;
    this.cambioFinalTurnsRemaining = null;
    this.lastResult = null;
    this.events = [];
    this.eventSeq = 0;
    this.finalGlueScheduled = false;
    this.glueStreakOwner = null;

    for (const player of this.players) {
      player.hand = [this.deck.pop(), this.deck.pop(), this.deck.pop(), this.deck.pop()];
    }

    for (const player of this.players) {
      this.grantKnowledge(player.id, player.id, 2);
      this.grantKnowledge(player.id, player.id, 3);
    }

    const winnerIndex = previousWinnerId ? this.players.findIndex((p) => p.id === previousWinnerId) : -1;
    this.currentPlayerIndex = winnerIndex !== -1 ? winnerIndex : Math.floor(Math.random() * this.players.length);
    this.phase = 'dealing';
    this.addLog('Cards dealt. Take a moment to peek at your bottom two cards.');
  }

  beginPlay() {
    if (this.phase !== 'dealing') throw new Error('Not currently dealing');
    this.discardPile.push(this.deck.pop());
    this.phase = 'play';
    this.addLog('Game started.');
    this.skipDeadPlayersIfNeeded();
  }

  currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  reshuffleIfNeeded() {
    if (this.deck.length > 0) return;
    if (this.discardPile.length <= 1) return; // nothing to reshuffle
    const top = this.discardPile.pop();
    this.deck = shuffle(this.discardPile);
    this.discardPile = [top];
    this.addLog('Deck reshuffled from discard pile.');
  }

  assertTurn(playerId) {
    const cur = this.currentPlayer();
    if (!cur || cur.id !== playerId) throw new Error('Not your turn');
  }

  drawFromDeck(playerId) {
    this.assertTurn(playerId);
    if (this.phase !== 'play') throw new Error('Game not active');
    if (this.drawnCard) throw new Error('Already drew a card');
    this.reshuffleIfNeeded();
    if (this.deck.length === 0) throw new Error('No cards left to draw');
    this.drawnCard = this.deck.pop();
    this.drawnFrom = 'deck';
    this.addLog(`${this.currentPlayer().name} drew a card from the deck.`);
    this.addEvent({ type: 'draw', by: playerId, from: 'deck' });
  }

  drawFromDiscard(playerId) {
    this.assertTurn(playerId);
    if (this.phase !== 'play') throw new Error('Game not active');
    if (this.drawnCard) throw new Error('Already drew a card');
    if (this.discardPile.length === 0) throw new Error('Discard pile is empty');
    this.drawnCard = this.discardPile.pop();
    this.drawnFrom = 'discard';
    this.addLog(`${this.currentPlayer().name} took the discard pile card.`);
    this.addEvent({ type: 'draw', by: playerId, from: 'discard' });
  }

  decideSwap(playerId, index) {
    this.assertTurn(playerId);
    if (!this.drawnCard) throw new Error('No card drawn');
    const player = this.getPlayer(playerId);
    if (index < 0 || index >= player.hand.length) throw new Error('Invalid slot');
    const oldCard = player.hand[index];
    player.hand[index] = this.drawnCard;
    this.discardPile.push(oldCard);
    this.glueStreakOwner = null; // a fresh discard is open for anyone to glue first
    this.invalidateSlot(playerId, index);
    this.addLog(`${player.name} swapped in the drawn card.`);
    this.drawnCard = null;
    this.drawnFrom = null;
    this.addEvent({ type: 'swap', by: playerId, index });
    this.finishTurn();
  }

  decideDiscard(playerId) {
    this.assertTurn(playerId);
    if (!this.drawnCard) throw new Error('No card drawn');
    if (this.drawnFrom !== 'deck') throw new Error('Must swap a card taken from the discard pile');
    const card = this.drawnCard;
    // If the card you just drew from the deck matches the discard pile's
    // current top rank, discarding it back is treated as a clean match --
    // no power, even if the rank would normally grant one.
    const previousTop = this.discardPile.length ? this.discardPile[this.discardPile.length - 1] : null;
    const isSelfMatch = !!previousTop && previousTop.rank === card.rank;
    this.discardPile.push(card);
    this.glueStreakOwner = null; // a fresh discard is open for anyone to glue first
    this.drawnCard = null;
    this.drawnFrom = null;
    this.addEvent({ type: 'discard', by: playerId });
    const power = isSelfMatch ? null : powerFor(card);
    if (power) {
      this.pendingPower = { type: power, playerId, stage: 'start' };
      this.addLog(`${this.getPlayer(playerId).name} discarded ${card.rank} and may use its power.`);
    } else if (isSelfMatch) {
      // Matching your freshly-drawn card against the discard pile is a bonus:
      // no power, and instead of ending your turn you get to go again.
      this.addLog(`${this.getPlayer(playerId).name} matched the discard pile with ${card.rank} -- gets another turn!`);
    } else {
      this.addLog(`${this.getPlayer(playerId).name} discarded ${card.rank}.`);
      this.finishTurn();
    }
  }

  skipPower(playerId) {
    if (!this.pendingPower || this.pendingPower.playerId !== playerId) {
      throw new Error('No power to skip');
    }
    this.pendingPower = null;
    this.finishTurn();
  }

  powerAction(playerId, payload) {
    const pending = this.pendingPower;
    if (!pending || pending.playerId !== playerId) throw new Error('No pending power');
    if (pending.type !== payload.type) throw new Error('Power type mismatch');

    if (payload.type === 'peekOwn') {
      const { index } = payload;
      const player = this.getPlayer(playerId);
      if (index < 0 || index >= player.hand.length) throw new Error('Invalid slot');
      this.grantKnowledge(playerId, playerId, index);
      this.addLog(`${player.name} peeked at one of their own cards.`);
      this.pendingPower = null;
      this.finishTurn();
      return;
    }

    if (payload.type === 'peekOpponent') {
      const { targetPlayerId, index } = payload;
      const target = this.getPlayer(targetPlayerId);
      if (!target) throw new Error('Invalid target');
      if (index < 0 || index >= target.hand.length) throw new Error('Invalid slot');
      this.grantKnowledge(playerId, targetPlayerId, index);
      this.addLog(`${this.getPlayer(playerId).name} peeked at one of ${target.name}'s cards.`);
      this.pendingPower = null;
      this.finishTurn();
      return;
    }

    if (payload.type === 'blindSwap') {
      const { aPlayerId, aIndex, bPlayerId, bIndex } = payload;
      const a = this.getPlayer(aPlayerId);
      const b = this.getPlayer(bPlayerId);
      if (!a || !b) throw new Error('Invalid target');
      if (aIndex < 0 || aIndex >= a.hand.length || bIndex < 0 || bIndex >= b.hand.length) {
        throw new Error('Invalid slot');
      }
      if (aPlayerId === bPlayerId && aIndex === bIndex) throw new Error('Cannot swap a card with itself');
      const tmp = a.hand[aIndex];
      a.hand[aIndex] = b.hand[bIndex];
      b.hand[bIndex] = tmp;
      this.invalidateSlot(aPlayerId, aIndex);
      this.invalidateSlot(bPlayerId, bIndex);
      this.addLog(`${this.getPlayer(playerId).name} blind-swapped two cards.`);
      this.addEvent({ type: 'blindSwap', by: playerId, a: { playerId: aPlayerId, index: aIndex }, b: { playerId: bPlayerId, index: bIndex } });
      this.pendingPower = null;
      this.finishTurn();
      return;
    }

    if (payload.type === 'kingPower') {
      // The King is flexible, not a fixed sequence: peek just one card, peek
      // two and then decide whether to swap them, or skip peeking entirely
      // and blind-swap any two cards directly. None of it is mandatory --
      // skipPower always remains available too.
      if (payload.action === 'peek') {
        if (pending.stage !== 'start') throw new Error('Power already resolved');
        const { targets } = payload; // [{playerId, index}] or [{playerId, index}, {playerId, index}]
        if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2) throw new Error('Pick one or two cards');
        const seen = new Set();
        for (const t of targets) {
          const p = this.getPlayer(t.playerId);
          if (!p || t.index < 0 || t.index >= p.hand.length) throw new Error('Invalid slot');
          const key = `${t.playerId}#${t.index}`;
          if (seen.has(key)) throw new Error('Pick two different cards');
          seen.add(key);
        }
        for (const t of targets) this.grantKnowledge(playerId, t.playerId, t.index);
        if (targets.length === 1) {
          this.addLog(`${this.getPlayer(playerId).name} peeked at one card (King power).`);
          this.pendingPower = null;
          this.finishTurn();
        } else {
          this.pendingPower = { type: 'kingPower', playerId, stage: 'decide', targets };
          this.addLog(`${this.getPlayer(playerId).name} peeked at two cards (King power).`);
        }
        return;
      }
      if (payload.action === 'directSwap') {
        // Blind-swap two cards without peeking at either -- only before any peek.
        if (pending.stage !== 'start') throw new Error('Already peeked -- resolve that first');
        const { a, b } = payload;
        const pa = this.getPlayer(a.playerId);
        const pb = this.getPlayer(b.playerId);
        if (!pa || !pb) throw new Error('Invalid target');
        if (a.index < 0 || a.index >= pa.hand.length || b.index < 0 || b.index >= pb.hand.length) {
          throw new Error('Invalid slot');
        }
        if (a.playerId === b.playerId && a.index === b.index) throw new Error('Cannot swap a card with itself');
        const tmp = pa.hand[a.index];
        pa.hand[a.index] = pb.hand[b.index];
        pb.hand[b.index] = tmp;
        this.invalidateSlot(a.playerId, a.index);
        this.invalidateSlot(b.playerId, b.index);
        this.addLog(`${this.getPlayer(playerId).name} blind-swapped two cards (King power).`);
        this.addEvent({ type: 'blindSwap', by: playerId, a, b });
        this.pendingPower = null;
        this.finishTurn();
        return;
      }
      if (payload.action === 'decide') {
        if (pending.stage !== 'decide') throw new Error('Must peek first');
        const { swap } = payload;
        if (swap) {
          const [ta, tb] = pending.targets;
          const a = this.getPlayer(ta.playerId);
          const b = this.getPlayer(tb.playerId);
          const tmp = a.hand[ta.index];
          a.hand[ta.index] = b.hand[tb.index];
          b.hand[tb.index] = tmp;
          // Other viewers lose knowledge of these slots; the acting player already
          // knows both values so their own knowledge of these slots stays valid.
          for (const [viewerId, set] of this.knowledge.entries()) {
            if (viewerId === playerId) continue;
            set.delete(`${ta.playerId}#${ta.index}`);
            set.delete(`${tb.playerId}#${tb.index}`);
          }
          this.addLog(`${this.getPlayer(playerId).name} swapped the two peeked cards.`);
          this.addEvent({ type: 'blindSwap', by: playerId, a: ta, b: tb });
        } else {
          this.addLog(`${this.getPlayer(playerId).name} chose not to swap.`);
        }
        this.pendingPower = null;
        this.finishTurn();
        return;
      }
      throw new Error('Invalid king action');
    }

    throw new Error('Unknown power');
  }

  attemptGlue(playerId, targetPlayerId, targetIndex) {
    if (this.phase !== 'play' && this.phase !== 'finalGlue') throw new Error('Game not active');
    if (this.discardPile.length === 0) throw new Error('Nothing to glue against');
    const gluer = this.getPlayer(playerId);
    const target = this.getPlayer(targetPlayerId);
    if (!gluer || !target) throw new Error('Invalid player');
    if (targetIndex < 0 || targetIndex >= target.hand.length) throw new Error('Invalid slot');
    // Whoever glues the current discard first keeps exclusive rights to keep
    // gluing it (chaining more matches) until a fresh card is discarded.
    if (this.glueStreakOwner !== null && this.glueStreakOwner !== playerId) {
      const owner = this.getPlayer(this.glueStreakOwner);
      throw new Error(`${owner ? owner.name : 'Someone'} is already gluing this card -- wait for a new discard.`);
    }

    const top = this.discardPile[this.discardPile.length - 1];
    const card = target.hand[targetIndex];
    const isMatch = card.rank === top.rank;

    if (!isMatch) {
      this.reshuffleIfNeeded();
      if (this.deck.length > 0) {
        gluer.hand.push(this.deck.pop());
      }
      // A wrong guess exposes the card to the whole table, not just the gluer.
      this.revealToAll(targetPlayerId, targetIndex);
      this.addLog(`${gluer.name} tried to glue but was wrong (it was a ${card.rank}) and drew a penalty card.`);
      this.addEvent({ type: 'glueFail', by: playerId, ownerId: targetPlayerId, index: targetIndex });
      return;
    }

    target.hand.splice(targetIndex, 1);
    this.invalidateFrom(targetPlayerId, targetIndex);
    this.discardPile.push(card);
    this.glueStreakOwner = playerId;
    this.addEvent({ type: 'glue', by: playerId, ownerId: targetPlayerId, index: targetIndex });

    if (targetPlayerId === playerId) {
      this.addLog(`${gluer.name} glued their own ${card.rank}!`);
    } else {
      this.addLog(`${gluer.name} glued ${target.name}'s ${card.rank}!`);
      this.pendingGives.push({ fromPlayerId: playerId, toPlayerId: targetPlayerId });
    }

    this.checkAutoCambio(targetPlayerId);
  }

  resolveGive(playerId, index) {
    const giveIdx = this.pendingGives.findIndex((g) => g.fromPlayerId === playerId);
    if (giveIdx === -1) throw new Error('Nothing to give right now');
    const { toPlayerId } = this.pendingGives[giveIdx];
    const giver = this.getPlayer(playerId);
    const receiver = this.getPlayer(toPlayerId);
    if (index < 0 || index >= giver.hand.length) throw new Error('Invalid slot');
    const [card] = giver.hand.splice(index, 1);
    this.invalidateFrom(playerId, index);
    receiver.hand.push(card);
    this.pendingGives.splice(giveIdx, 1);
    this.addLog(`${giver.name} gave a card to ${receiver.name}.`);
    this.addEvent({ type: 'give', from: playerId, to: toPlayerId, index });
    this.checkAutoCambio(playerId);
  }

  checkAutoCambio(playerId) {
    const player = this.getPlayer(playerId);
    if (player.hand.length === 0 && this.cambioCalledBy === null) {
      this.cambioCalledBy = playerId;
      this.cambioFinalTurnsRemaining = this.players.length - 1;
      this.addLog(`${player.name} has no cards left and automatically calls Cambio!`);
    }
  }

  callCambio(playerId) {
    this.assertTurn(playerId);
    if (this.drawnCard) throw new Error('Cannot call Cambio after drawing');
    if (this.cambioCalledBy !== null) throw new Error('Cambio already called');
    this.cambioCalledBy = playerId;
    this.cambioFinalTurnsRemaining = this.players.length - 1;
    this.addLog(`${this.getPlayer(playerId).name} called Cambio!`);
    this.finishTurn();
  }

  skipDeadPlayersIfNeeded() {
    // Auto-skip a turn if the current player has no cards left, or is
    // currently disconnected and can't act.
    let guard = 0;
    while (this.phase === 'play' && this.currentPlayer() && guard < this.players.length + 1) {
      const cur = this.currentPlayer();
      if (cur.hand.length === 0) {
        this.addLog(`${cur.name} has no cards, turn skipped.`);
      } else if (!cur.connected) {
        this.addLog(`${cur.name} is disconnected, turn skipped.`);
      } else {
        break;
      }
      this.advanceIndexOnly();
      guard++;
    }
  }

  advanceIndexOnly() {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
  }

  finishTurn() {
    const endingPlayerId = this.currentPlayer().id;
    if (this.cambioCalledBy !== null) {
      // The caller's own turn-ending (the call itself) doesn't consume one of
      // the "everyone else gets one more turn" slots.
      if (endingPlayerId !== this.cambioCalledBy) {
        this.cambioFinalTurnsRemaining -= 1;
      }
      if (this.cambioFinalTurnsRemaining <= 0) {
        // Give everyone one last chance to glue against the final discard
        // before hands are revealed. index.js schedules the delayed
        // endRound() call once this phase is set.
        this.phase = 'finalGlue';
        this.addLog('Last chance to glue before hands are revealed!');
        return;
      }
    }
    this.advanceIndexOnly();
    this.skipDeadPlayersIfNeeded();
  }

  endRound() {
    this.phase = 'roundEnd';
    const scores = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.hand.reduce((sum, c) => sum + cardValue(c), 0),
      hand: p.hand.map((c) => ({ rank: c.rank, suit: c.suit })),
    }));
    const minScore = Math.min(...scores.map((s) => s.score));
    let candidates = scores.filter((s) => s.score === minScore).map((s) => s.id);
    if (this.cambioCalledBy && candidates.includes(this.cambioCalledBy) && candidates.length > 1) {
      candidates = candidates.filter((id) => id !== this.cambioCalledBy);
    }
    this.lastResult = {
      scores,
      winners: candidates,
      cambioCalledBy: this.cambioCalledBy,
    };
    this.addLog('Round over! Hands revealed.');
  }

  // ---- personalized view ----
  getStateFor(viewerId) {
    const players = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === this.hostId,
      isBot: !!p.isBot,
      handCount: p.hand.length,
      hand: p.hand.map((card, idx) => {
        const revealed = this.phase === 'roundEnd' || this.knows(viewerId, p.id, idx);
        return revealed ? { known: true, rank: card.rank, suit: card.suit } : { known: false };
      }),
    }));

    const current = this.currentPlayer();

    let myDrawnCard = null;
    if (this.drawnCard && current && current.id === viewerId) {
      myDrawnCard = { rank: this.drawnCard.rank, suit: this.drawnCard.suit, from: this.drawnFrom };
    }

    let pendingPowerView = null;
    if (this.pendingPower) {
      pendingPowerView = {
        type: this.pendingPower.type,
        stage: this.pendingPower.stage,
        mine: this.pendingPower.playerId === viewerId,
        forPlayer: this.pendingPower.playerId,
      };
      if (this.pendingPower.type === 'kingPower' && this.pendingPower.stage === 'decide' && this.pendingPower.playerId === viewerId) {
        pendingPowerView.targets = this.pendingPower.targets.map((t) => {
          const p = this.getPlayer(t.playerId);
          const card = p.hand[t.index];
          return { playerId: t.playerId, index: t.index, rank: card ? card.rank : null, suit: card ? card.suit : null };
        });
      }
    }

    const myPendingGive = this.pendingGives.find((g) => g.fromPlayerId === viewerId) || null;

    return {
      roomCode: this.code,
      phase: this.phase,
      players,
      hostId: this.hostId,
      currentPlayerId: (this.phase === 'dealing' || this.phase === 'finalGlue') ? null : (current ? current.id : null),
      deckCount: this.deck.length,
      discardTop: this.discardPile.length ? { rank: this.discardPile[this.discardPile.length - 1].rank, suit: this.discardPile[this.discardPile.length - 1].suit } : null,
      myDrawnCard,
      drawnPending: !!this.drawnCard,
      pendingPower: pendingPowerView,
      pendingGiveForMe: myPendingGive ? true : false,
      pendingGiveToPlayerId: myPendingGive ? myPendingGive.toPlayerId : null,
      cambioCalledBy: this.cambioCalledBy,
      log: this.log.slice(-15),
      events: this.events.slice(-20),
      result: this.phase === 'roundEnd' ? this.lastResult : null,
    };
  }
}

module.exports = { Room };
