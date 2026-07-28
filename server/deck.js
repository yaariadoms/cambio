const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RED_SUITS = new Set(['H', 'D']);

let nextCardId = 1;

function makeDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({ id: nextCardId++, rank, suit });
    }
  }
  return cards;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function cardValue(card) {
  if (card.rank === 'K') return RED_SUITS.has(card.suit) ? -1 : 13;
  if (card.rank === 'A') return 1;
  if (card.rank === 'J') return 11;
  if (card.rank === 'Q') return 12;
  return parseInt(card.rank, 10);
}

// Power granted only when the card is drawn from the deck and discarded
// directly (not swapped into the player's hand).
function powerFor(card) {
  if (card.rank === '7' || card.rank === '8') return 'peekOwn';
  if (card.rank === '9' || card.rank === '10') return 'peekOpponent';
  if (card.rank === 'J' || card.rank === 'Q') return 'blindSwap';
  if (card.rank === 'K' && !RED_SUITS.has(card.suit)) return 'kingPower';
  return null;
}

module.exports = { makeDeck, shuffle, cardValue, powerFor, RED_SUITS };
