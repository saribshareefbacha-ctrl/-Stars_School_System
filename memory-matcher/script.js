/* =====================================================
   Memory Matcher — game logic (Vanilla ES6+)
   -----------------------------------------------------
   Structure:
     1. Constants
     2. DOM references
     3. State
     4. Timeout registry (prevents stale callbacks)
     5. Helpers (shuffle, formatting)
     6. Board building & rendering
     7. Game flow (flip, match check, win)
     8. Timer & stats
     9. Controls & initialisation
   ===================================================== */

'use strict';

/* ---------- 1. Constants ---------- */

/** Symbols used for the pairs — one per pair (8 pairs = 16 cards). */
const SYMBOLS = ['🍋', '🍇', '🍉', '🍑', '🥝', '🍒', '🥑', '🍍'];

const PAIR_COUNT = SYMBOLS.length;      // 8 pairs
const TOTAL_CARDS = PAIR_COUNT * 2;     // 16 cards (4x4 grid)
const MISMATCH_DELAY = 850;             // ms before non-matching cards flip back
const WIN_DELAY = 550;                  // ms before the win overlay appears
const TICK_INTERVAL = 250;              // ms between timer samples (drift-free display)

/** Game status values. Flipping is only allowed while PLAYING or IDLE. */
const STATUS = Object.freeze({
  IDLE: 'idle',       // board ready, clock not started yet
  PLAYING: 'playing', // clock running
  WON: 'won'          // all pairs found — board is closed
});

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
  deck: [],            // current card order (array of symbols)
  firstCard: null,     // first flipped card element
  secondCard: null,    // second flipped card element
  lockBoard: false,    // true while a pair is being evaluated
  status: STATUS.IDLE,
  moves: 0,
  matchedPairs: 0
};

/**
 * Timer state. Elapsed time is derived from timestamps rather than counting
 * interval ticks, so a throttled or delayed interval cannot make the clock drift.
 */
const timer = {
  accumulatedMs: 0,   // time banked from previous run segments
  startedAt: null,    // timestamp of the current running segment, null when paused
  intervalId: null,   // display refresh interval
  lastRendered: ''    // last string written to the DOM (avoids redundant writes)
};

/** Monotonic clock; falls back to Date.now() in very old environments. */
const now = () =>
  (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

/* ---------- 4. Timeout registry ---------- */

/**
 * Every deferred callback is registered here so that starting a new game can
 * cancel work scheduled by the previous one. Without this, a pending
 * "flip back" or "show win" callback fires onto a fresh board and corrupts it.
 */
const pendingTimeouts = new Set();

/**
 * setTimeout wrapper that auto-deregisters when it runs.
 * @param {Function} fn
 * @param {number} ms
 */
function delay(fn, ms) {
  const id = setTimeout(() => {
    pendingTimeouts.delete(id);
    fn();
  }, ms);
  pendingTimeouts.add(id);
}

/** Cancels every scheduled callback from the current game. */
function clearPendingTimeouts() {
  pendingTimeouts.forEach(clearTimeout);
  pendingTimeouts.clear();
}

/* ---------- 5. Helpers ---------- */

/**
 * Returns a new shuffled array using the Fisher–Yates algorithm.
 * Every permutation is equally likely: index j is drawn from [0..i] inclusive.
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
 * Builds a shuffled deck containing exactly two of every symbol.
 * @returns {string[]}
 */
function createDeck() {
  const deck = shuffle([...SYMBOLS, ...SYMBOLS]);

  // Guard against a mis-edited SYMBOLS list silently breaking the 4x4 grid.
  if (deck.length !== TOTAL_CARDS) {
    throw new Error(`Deck must contain ${TOTAL_CARDS} cards, received ${deck.length}.`);
  }
  return deck;
}

/**
 * Formats a duration as MM:SS (clamped at 99:59 for display sanity).
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
  const capped = Math.min(totalSeconds, 99 * 60 + 59);
  const minutes = Math.floor(capped / 60);
  const seconds = capped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ---------- 6. Board building & rendering ---------- */

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
  setCardLabel(card, 'hidden');

  // Two faces inside a 3D-flipping wrapper. textContent is used for the symbol
  // so the value is never parsed as markup.
  const inner = document.createElement('span');
  inner.className = 'card__inner';

  const back = document.createElement('span');
  back.className = 'card__face card__face--back';
  back.setAttribute('aria-hidden', 'true');
  back.textContent = '?';

  const front = document.createElement('span');
  front.className = 'card__face card__face--front';
  front.textContent = symbol;

  inner.append(back, front);
  card.appendChild(inner);
  return card;
}

/**
 * Updates a card's accessible name.
 * @param {HTMLElement} card
 * @param {string} description - "hidden", the symbol, or "matched" text.
 */
function setCardLabel(card, description) {
  card.setAttribute('aria-label', `Card ${Number(card.dataset.index) + 1}, ${description}`);
}

/**
 * Renders the deck into the board in a single DOM write.
 * @param {string[]} deck
 */
function renderBoard(deck) {
  const fragment = document.createDocumentFragment();
  deck.forEach((symbol, index) => fragment.appendChild(createCard(symbol, index)));

  boardEl.replaceChildren(fragment); // clear + insert in one operation
}

/* ---------- 7. Game flow ---------- */

/**
 * Handles a click anywhere on the board (event delegation:
 * one listener instead of sixteen).
 * @param {MouseEvent} event
 */
function handleBoardClick(event) {
  const card = event.target.closest('.card');
  if (card && boardEl.contains(card)) flipCard(card);
}

/**
 * Returns true when the given card may legally be flipped right now.
 * @param {HTMLElement} card
 * @returns {boolean}
 */
function canFlip(card) {
  if (state.status === STATUS.WON) return false;   // game is over
  if (state.lockBoard) return false;               // a pair is being checked
  if (card.classList.contains('is-matched')) return false;
  if (card.classList.contains('is-flipped')) return false; // covers "same card twice"
  return true;
}

/**
 * Reveals a card if the move is legal, then evaluates the pair.
 * @param {HTMLElement} card
 */
function flipCard(card) {
  if (!canFlip(card)) return;

  startTimer();   // no-op once the clock is already running
  revealCard(card);

  if (!state.firstCard) {
    state.firstCard = card;
    return;
  }

  state.secondCard = card;
  lockBoard(true);   // block input until the pair resolves

  registerMove();
  checkForMatch();
}

/**
 * Applies the flipped visual state and updates accessibility info.
 * @param {HTMLElement} card
 */
function revealCard(card) {
  card.classList.add('is-flipped');
  setCardLabel(card, card.dataset.symbol);
}

/**
 * Locks or unlocks the board for input.
 * @param {boolean} locked
 */
function lockBoard(locked) {
  state.lockBoard = locked;
  boardEl.classList.toggle('is-locked', locked);
}

/** Compares the two flipped cards and routes to match / mismatch. */
function checkForMatch() {
  if (state.firstCard.dataset.symbol === state.secondCard.dataset.symbol) {
    handleMatch();
  } else {
    handleMismatch();
  }
}

/** Locks a matched pair in place and checks for a win. */
function handleMatch() {
  [state.firstCard, state.secondCard].forEach((card) => {
    card.classList.add('is-matched');
    card.setAttribute('aria-disabled', 'true');
    setCardLabel(card, `${card.dataset.symbol}, matched`);
  });

  state.matchedPairs += 1;
  pairsEl.textContent = String(state.matchedPairs);

  resetTurn();

  if (state.matchedPairs === PAIR_COUNT) endGame();
}

/** Flips a non-matching pair back after a short delay. */
function handleMismatch() {
  // Capture the elements now: state.firstCard/secondCard are cleared before
  // this callback runs, so the closure must not read them later.
  const pair = [state.firstCard, state.secondCard];
  pair.forEach((card) => card.classList.add('is-wrong'));

  delay(() => {
    pair.forEach((card) => {
      card.classList.remove('is-flipped', 'is-wrong');
      setCardLabel(card, 'hidden');
    });
    resetTurn();
  }, MISMATCH_DELAY);
}

/** Clears the per-turn selection and unlocks the board. */
function resetTurn() {
  state.firstCard = null;
  state.secondCard = null;
  lockBoard(false);
}

/** Finishes the game: stop the clock, close the board, show the overlay. */
function endGame() {
  state.status = STATUS.WON;
  stopTimer();
  lockBoard(true);            // no further flips, even behind the overlay
  delay(showWin, WIN_DELAY);
}

/** Shows the congratulation overlay with the final stats. */
function showWin() {
  finalMovesEl.textContent = String(state.moves);
  finalTimeEl.textContent = formatTime(elapsedSeconds());
  overlayEl.hidden = false;
  playAgainBtn.focus();
}

/* ---------- 8. Timer & stats ---------- */

/** Increments and displays the move counter. */
function registerMove() {
  state.moves += 1;
  movesEl.textContent = String(state.moves);
}

/** @returns {number} whole seconds elapsed in the current game. */
function elapsedSeconds() {
  const running = timer.startedAt !== null ? now() - timer.startedAt : 0;
  return Math.floor((timer.accumulatedMs + running) / 1000);
}

/** Writes the clock to the DOM only when the visible value actually changes. */
function renderTimer() {
  const text = formatTime(elapsedSeconds());
  if (text !== timer.lastRendered) {
    timer.lastRendered = text;
    timerEl.textContent = text;
  }
}

/** Starts (or resumes) the clock. Safe to call repeatedly. */
function startTimer() {
  if (timer.startedAt !== null) return;   // already running

  if (state.status === STATUS.IDLE) state.status = STATUS.PLAYING;

  timer.startedAt = now();
  timer.intervalId = setInterval(renderTimer, TICK_INTERVAL);
}

/** Pauses the clock, banking the elapsed time. Safe to call repeatedly. */
function stopTimer() {
  if (timer.startedAt !== null) {
    timer.accumulatedMs += now() - timer.startedAt;
    timer.startedAt = null;
  }
  clearInterval(timer.intervalId);
  timer.intervalId = null;
  renderTimer();
}

/** Clears the clock back to 00:00. */
function resetTimer() {
  stopTimer();
  timer.accumulatedMs = 0;
  timer.lastRendered = '';
  renderTimer();
}

/* ---------- 9. Controls & initialisation ---------- */

/**
 * Starts a game, resetting every counter and clearing scheduled work.
 * @param {boolean} [reshuffle=true] - true for a new layout, false to replay the current one.
 */
function startGame(reshuffle = true) {
  clearPendingTimeouts();   // cancel flip-back / win callbacks from the old game
  resetTimer();

  state.deck = reshuffle || state.deck.length === 0 ? createDeck() : state.deck;
  state.firstCard = null;
  state.secondCard = null;
  state.status = STATUS.IDLE;
  state.moves = 0;
  state.matchedPairs = 0;

  movesEl.textContent = '0';
  pairsEl.textContent = '0';
  overlayEl.hidden = true;
  lockBoard(false);

  renderBoard(state.deck);
}

/** Wires up all event listeners once. */
function bindEvents() {
  boardEl.addEventListener('click', handleBoardClick);
  restartBtn.addEventListener('click', () => startGame(false)); // same layout
  newGameBtn.addEventListener('click', () => startGame(true));  // reshuffle
  playAgainBtn.addEventListener('click', () => startGame(true));

  // Pause the clock while the tab is hidden; elapsed time is banked, so no
  // seconds are lost or invented when the player returns.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (state.status === STATUS.PLAYING) stopTimer();
    } else if (state.status === STATUS.PLAYING) {
      startTimer();
    }
  });
}

// Boot the game.
bindEvents();
startGame(true);
