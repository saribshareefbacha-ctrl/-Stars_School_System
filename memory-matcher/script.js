/* =====================================================
   Memory Matcher — game logic (Vanilla ES6+)
   -----------------------------------------------------
   Structure:
     1. Constants
     2. DOM references
     3. State
     4. Helpers (shuffle, formatting)
     5. Board building & rendering
     6. Game flow (flip, match check, win)
     7. Timer & stats
     8. Controls & initialisation
   ===================================================== */

'use strict';

/* ---------- 1. Constants ---------- */

/** Symbols used for the pairs — one per pair (8 pairs = 16 cards). */
const SYMBOLS = ['🍋', '🍇', '🍉', '🍑', '🥝', '🍒', '🥑', '🍍'];

const PAIR_COUNT = SYMBOLS.length;      // 8 pairs
const TOTAL_CARDS = PAIR_COUNT * 2;     // 16 cards (4x4 grid)
const MISMATCH_DELAY = 850;             // ms before non-matching cards flip back
const WIN_DELAY = 550;                  // ms before the win overlay appears

/* ---------- 2. DOM references (queried once) ---------- */

const boardEl = document.getElementById('board');
const movesEl = document.getElementById('moves');
const timerEl = document.getElementById('timer');
const pairsEl = document.getElementById('pairs');
const overlayEl = document.getElementById('overlay');
const finalMovesEl = document.getElementById('final-moves');
const finalTimeEl = document.getElementById('final-time');
const restartBtn = document.getElementById('restart');
const newGameBtn = document.getElementById('new-game');
const playAgainBtn = document.getElementById('play-again');

/* ---------- 3. State ---------- */

const state = {
  deck: [],           // current card order (array of symbols)
  firstCard: null,    // first flipped card element
  secondCard: null,   // second flipped card element
  lockBoard: false,   // true while a pair is being evaluated
  moves: 0,
  matchedPairs: 0,
  seconds: 0,
  timerId: null,      // setInterval id, null when the clock is stopped
  started: false      // timer starts on the very first flip
};

/* ---------- 4. Helpers ---------- */

/**
 * Returns a new shuffled array using the Fisher–Yates algorithm.
 * @param {Array} items
 * @returns {Array}
 */
function shuffle(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Builds a shuffled deck containing two of every symbol.
 * @returns {string[]}
 */
function createDeck() {
  return shuffle([...SYMBOLS, ...SYMBOLS]);
}

/**
 * Formats a duration as MM:SS.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ---------- 5. Board building & rendering ---------- */

/**
 * Creates a single card element for the given symbol.
 * @param {string} symbol
 * @param {number} index
 * @returns {HTMLButtonElement}
 */
function createCard(symbol, index) {
  const card = document.createElement('button');
  card.className = 'card';
  card.type = 'button';
  card.dataset.symbol = symbol;
  card.dataset.index = String(index);
  card.setAttribute('aria-label', `Card ${index + 1}, hidden`);

  // Two faces inside a 3D-flipping wrapper.
  card.innerHTML =
    '<span class="card__inner">' +
      '<span class="card__face card__face--back" aria-hidden="true">?</span>' +
      `<span class="card__face card__face--front">${symbol}</span>` +
    '</span>';

  return card;
}

/**
 * Renders the deck into the board in a single DOM write.
 * @param {string[]} deck
 */
function renderBoard(deck) {
  const fragment = document.createDocumentFragment();
  deck.forEach((symbol, index) => fragment.appendChild(createCard(symbol, index)));

  boardEl.textContent = '';       // clear previous cards
  boardEl.appendChild(fragment);  // one reflow instead of 16
}

/* ---------- 6. Game flow ---------- */

/**
 * Handles a click anywhere on the board (event delegation:
 * one listener instead of sixteen).
 * @param {MouseEvent} event
 */
function handleBoardClick(event) {
  const card = event.target.closest('.card');
  if (!card || !boardEl.contains(card)) return;

  flipCard(card);
}

/**
 * Reveals a card if the move is legal, then evaluates the pair.
 * @param {HTMLElement} card
 */
function flipCard(card) {
  // Ignore clicks while checking, on matched cards, or on the same card twice.
  if (state.lockBoard) return;
  if (card.classList.contains('is-matched')) return;
  if (card === state.firstCard) return;
  if (card.classList.contains('is-flipped')) return;

  startTimer();          // no-op if the clock is already running
  revealCard(card);

  if (!state.firstCard) {
    state.firstCard = card;
    return;
  }

  state.secondCard = card;
  state.lockBoard = true;      // block input until the pair resolves
  boardEl.classList.add('is-locked');

  registerMove();
  checkForMatch();
}

/**
 * Applies the flipped visual state and updates accessibility info.
 * @param {HTMLElement} card
 */
function revealCard(card) {
  card.classList.add('is-flipped');
  card.setAttribute('aria-label', `Card ${Number(card.dataset.index) + 1}, ${card.dataset.symbol}`);
}

/** Compares the two flipped cards and routes to match / mismatch. */
function checkForMatch() {
  const isMatch = state.firstCard.dataset.symbol === state.secondCard.dataset.symbol;
  isMatch ? handleMatch() : handleMismatch();
}

/** Locks a matched pair in place and checks for a win. */
function handleMatch() {
  [state.firstCard, state.secondCard].forEach((card) => {
    card.classList.add('is-matched');
    card.setAttribute('aria-disabled', 'true');
  });

  state.matchedPairs += 1;
  pairsEl.textContent = String(state.matchedPairs);

  resetTurn();

  if (state.matchedPairs === PAIR_COUNT) {
    stopTimer();
    setTimeout(showWin, WIN_DELAY);
  }
}

/** Flips a non-matching pair back after a short delay. */
function handleMismatch() {
  const [first, second] = [state.firstCard, state.secondCard];
  first.classList.add('is-wrong');
  second.classList.add('is-wrong');

  setTimeout(() => {
    [first, second].forEach((card) => {
      card.classList.remove('is-flipped', 'is-wrong');
      card.setAttribute('aria-label', `Card ${Number(card.dataset.index) + 1}, hidden`);
    });
    resetTurn();
  }, MISMATCH_DELAY);
}

/** Clears the per-turn selection and unlocks the board. */
function resetTurn() {
  state.firstCard = null;
  state.secondCard = null;
  state.lockBoard = false;
  boardEl.classList.remove('is-locked');
}

/** Shows the congratulation overlay with the final stats. */
function showWin() {
  finalMovesEl.textContent = String(state.moves);
  finalTimeEl.textContent = formatTime(state.seconds);
  overlayEl.hidden = false;
  playAgainBtn.focus();
}

/* ---------- 7. Timer & stats ---------- */

/** Increments and displays the move counter. */
function registerMove() {
  state.moves += 1;
  movesEl.textContent = String(state.moves);
}

/** Starts the clock on the first flip of a game. */
function startTimer() {
  if (state.started) return;

  state.started = true;
  state.timerId = setInterval(() => {
    state.seconds += 1;
    timerEl.textContent = formatTime(state.seconds);
  }, 1000);
}

/** Stops the clock (safe to call repeatedly). */
function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
}

/* ---------- 8. Controls & initialisation ---------- */

/**
 * Resets all counters and the board.
 * @param {boolean} newDeck - true to reshuffle, false to replay the same layout.
 */
function startGame(newDeck = true) {
  stopTimer();

  state.deck = newDeck ? createDeck() : state.deck;
  state.firstCard = null;
  state.secondCard = null;
  state.lockBoard = false;
  state.moves = 0;
  state.matchedPairs = 0;
  state.seconds = 0;
  state.started = false;

  movesEl.textContent = '0';
  pairsEl.textContent = '0';
  timerEl.textContent = formatTime(0);
  overlayEl.hidden = true;
  boardEl.classList.remove('is-locked');

  renderBoard(state.deck);
}

/** Wires up all event listeners once. */
function bindEvents() {
  boardEl.addEventListener('click', handleBoardClick);
  restartBtn.addEventListener('click', () => startGame(false)); // same layout
  newGameBtn.addEventListener('click', () => startGame(true));  // reshuffle
  playAgainBtn.addEventListener('click', () => startGame(true));

  // Pause the clock when the tab is hidden, resume when it returns.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTimer();
    } else if (state.started && !state.timerId && state.matchedPairs < PAIR_COUNT) {
      state.started = false;  // allow startTimer() to restart the interval
      startTimer();
    }
  });
}

// Boot the game.
bindEvents();
startGame(true);
