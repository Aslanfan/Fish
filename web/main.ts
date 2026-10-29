// Local playtest client: you (seat 0) and two bot teammates against three bots. Everything runs in the
// browser; the UI only ever reads your PlayerView, the same thing a server would send you.
import { CARD_SET, FULL_DECK, SET_CARDS, SET_IDS, type Card, type SetId } from "../src/cards";
import {
  applyAction, legalAsks, newGame, teamOf, viewFor,
  type Action, type GameEvent, type GameState, type PlayerView, type Seat,
} from "../src/engine";
import { DeductionBot, DIFFICULTY, type Difficulty } from "../src/bots/deduction";
import { nextBotAction } from "../src/bots/runner";

const HUMAN: Seat = 0;
const NAMES = ["You", "Max", "Iris", "Nora", "Theo", "Otto"];

/**
 * Each ask is shown in two beats: the question (who asked whom for what) and then the answer. `answer` is how
 * long the answer stays up before the next bot moves. `pause` says which answers wait for a tap instead:
 * every one, or only asks for cards in sets you hold.
 */
const PACE: Record<string, { label: string; question: number; answer: number; pause?: "all" | "mine" }> = {
  slow: { label: "slow", question: 2200, answer: 2600 },
  normal: { label: "normal", question: 1400, answer: 1600 },
  fast: { label: "fast", question: 600, answer: 700 },
  step: { label: "step", question: 1400, answer: 1600, pause: "all" },
  mine: { label: "step (my sets)", question: 1400, answer: 1600, pause: "mine" },
};
type Speed = string;

/** Human seats. Just you for now; a shared table would list every human player here. */
const HUMANS: Seat[] = [HUMAN];

/**
 * Which humans the answer on display should wait for before the next bot moves. With "mine": every human
 * but the declarer for a declaration (rare, and it always changes the score), and for an ask only humans who
 * held a card in the asked set (judged from their hand before the ask, so a card just taken still counts).
 */
function waitingOn(): Seat[] {
  const pause = currentPace().pause;
  if (!showing || !pause) return [];
  if (pause === "all") return HUMANS;
  const e = showing.event;
  if (e.type === "declare") return HUMANS.filter((s) => s !== e.by);
  return HUMANS.filter((s) => s !== e.by && viewFor(showing!.before, s).hand.some((c) => CARD_SET[c] === CARD_SET[e.card]));
}

/** The chosen pace, except that "mine" plays like fast once no human has cards left (nothing left for them to do). */
function currentPace(): (typeof PACE)[string] {
  const pace = PACE[settings.speed]!;
  if (pace.pause === "mine" && HUMANS.every((s) => viewFor(state, s).hand.length === 0)) return PACE.fast!;
  return pace;
}

interface Settings { difficulty: Difficulty; speed: Speed; log: "shown" | "hidden" }

function loadSettings(): Settings {
  const fallback: Settings = { difficulty: "normal", speed: "slow", log: "shown" };
  try {
    const saved = JSON.parse(localStorage.getItem("library-settings") ?? "{}");
    return {
      difficulty: saved.difficulty in DIFFICULTY ? saved.difficulty : fallback.difficulty,
      speed: saved.speed in PACE ? saved.speed : fallback.speed,
      log: saved.log === "hidden" ? "hidden" : fallback.log,
    };
  } catch {
    return fallback;
  }
}

function saveSettings(): void {
  try { localStorage.setItem("library-settings", JSON.stringify(settings)); } catch { /* private mode etc. */ }
}

type Shown = Extract<GameEvent, { type: "ask" | "declare" }>;
const shownSet = (e: Shown): SetId => (e.type === "ask" ? CARD_SET[e.card]! : e.setId);

const settings = loadSettings();
let seed = 0;
let state: GameState;
let bots = new Map<Seat, DeductionBot>();
let timer: number | undefined;

/** The ask or declaration on display, and the state just before it (shown while the question is up). */
let showing: null | { event: Shown; before: GameState; stage: "question" | "answer" } = null;
/** Humans who still have to tap Continue before the next bot moves, and the set each pause was about. */
const awaiting = new Map<Seat, SetId>();

const ui = {
  target: null as Seat | null,
  /** The declare sheet: null when closed, setId null while picking a set. */
  declaring: null as null | { setId: SetId | null; assignment: Record<Card, Seat> },
  /** The new-game sheet: a draft of the settings to start with, or null when closed. */
  setup: null as null | Settings,
  message: "",
  logOpen: true,
};

const app = document.getElementById("app")!;

// ---------------------------------------------------------------- names and cards

const SUIT: Record<string, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const isRed = (c: Card) => c === "JKR-R" || c.endsWith("H") || c.endsWith("D");

function cardParts(c: Card): { rank: string; suit: string } {
  if (c.startsWith("JKR")) return { rank: "JK", suit: c === "JKR-R" ? "red" : "black" };
  return { rank: c.slice(0, -1), suit: SUIT[c.slice(-1)]! };
}

function cardText(c: Card): string {
  if (c === "JKR-R") return "red joker";
  if (c === "JKR-B") return "black joker";
  const { rank, suit } = cardParts(c);
  return `${rank}${suit}`;
}

function cardHtml(c: Card, attrs = "", extraClass = ""): string {
  const { rank, suit } = cardParts(c);
  const tag = attrs.includes("data-act") ? "button" : "div";
  const classes = ["card", isRed(c) ? "red" : "", c.startsWith("JKR") ? "joker" : "", extraClass].filter(Boolean).join(" ");
  return `<${tag} class="${classes}" ${attrs}><span class="rank">${rank}</span><span class="suit">${suit}</span></${tag}>`;
}

function setName(id: SetId): string {
  if (id === "EIGHTS") return "8s + jokers";
  const [suit, half] = id.split("-");
  return `${half === "low" ? "Low" : "High"} ${SUIT[suit!]}`;
}

const name = (s: Seat) => NAMES[s]!;
const object = (s: Seat) => (s === HUMAN ? "you" : name(s));
const teamName = (t: number) => (t === teamOf(HUMAN) ? "your team" : "the opponents");

function eventText(e: GameEvent): string {
  switch (e.type) {
    case "ask":
      return `${name(e.by)} asked ${object(e.to)} for the ${cardText(e.card)}: ${e.success ? "got it" : "miss"}.`;
    case "declare":
      return `${name(e.by)} declared ${setName(e.setId)}: ${e.correct ? "correct" : "wrong"}, point to ${teamName(e.awardedTo)}.`;
    case "forced-declaration":
      return e.reason === "one-team-out"
        ? "Only one team has cards left. No more asking: the remaining sets must be declared."
        : "Nobody can ask any more. The remaining sets must be declared.";
    case "game-over":
      return `Game over: ${teamName(e.winner)} won.`;
  }
}

function eventClass(e: GameEvent): string {
  if (e.type === "ask") return e.success ? "hit" : "miss";
  if (e.type === "declare") return e.awardedTo === teamOf(HUMAN) ? "good" : "bad";
  return "";
}

// ---------------------------------------------------------------- game flow

function startGame(): void {
  seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  state = newGame({}, seed);
  buildBots();
  showing = null;
  awaiting.clear();
  ui.target = null;
  ui.declaring = null;
  ui.message = "";
  advance();
}

function buildBots(): void {
  bots = new Map(
    [1, 2, 3, 4, 5].map((s) => [s, new DeductionBot(s, DIFFICULTY[settings.difficulty], (seed + s * 7919) >>> 0)]),
  );
}

function act(action: Action): void {
  const before = state;
  const res = applyAction(state, action);
  if (!res.ok) {
    ui.message = res.error;
    render();
    return;
  }
  state = res.state;
  ui.message = "";
  const event = state.log.slice(before.log.length).find((e): e is Shown => e.type === "ask" || e.type === "declare");
  // Your own asks skip the question beat: you know what you asked.
  if (event) showing = { event, before, stage: event.type === "ask" && event.by !== HUMAN ? "question" : "answer" };
  // Declaring the very set a pause was about answers it: no need to tap Continue as well.
  if (action.type === "declare" && awaiting.get(action.by) === action.setId) awaiting.delete(action.by);

  const v = viewFor(state, HUMAN);
  if (ui.declaring?.setId && !v.remainingSets.includes(ui.declaring.setId)) {
    ui.declaring = null;
    ui.message = "That set was just declared by someone else.";
  }
  if (ui.target !== null && (v.turn !== HUMAN || v.handCounts[ui.target] === 0)) ui.target = null;
  advance();
}

/** Render, then schedule whatever comes next: the answer beat, the next bot move, or nothing (your move). */
function advance(): void {
  window.clearTimeout(timer);
  timer = undefined;
  const pace = currentPace();
  if (showing?.stage === "question") {
    render();
    timer = window.setTimeout(() => { showing!.stage = "answer"; advance(); }, pace.question);
    return;
  }
  // A Continue someone still owes survives their own moves in the meantime (say, declaring while the game
  // waits on them); it only goes when they tap it, the speed stops pausing, or no bot has anything to do.
  const botsToMove = nextBotAction(state, bots) !== null;
  if (!pace.pause || !botsToMove) awaiting.clear();
  else for (const s of waitingOn()) awaiting.set(s, shownSet(showing!.event));
  if (botsToMove && !awaiting.size) timer = window.setTimeout(botMove, showing ? pace.answer : pace.question);
  render();
}

function botMove(): void {
  const action = nextBotAction(state, bots);
  if (action) act(action);
}

// ---------------------------------------------------------------- rendering

/** While a question is up, show the table as it was before the answer, so nothing gives it away. */
const questionUp = () => showing?.stage === "question";

function seatHtml(v: PlayerView, s: Seat): string {
  const us = teamOf(s) === v.team;
  const askable = !questionUp() && v.turn === HUMAN && v.phase === "playing" && !v.mustDeclare && !us && v.handCounts[s]! > 0;
  const e = showing?.event;
  const role = e?.type === "ask" ? (e.by === s ? "asking" : e.to === s ? "asked" : "") : e?.type === "declare" && e.by === s ? "asking" : "";
  const classes = ["seat", us ? "us" : "them", v.turn === s ? "turn" : "", ui.target === s ? "selected" : "", askable ? "askable" : "", role];
  const count = v.handCounts[s]!;
  const body = `<span class="who">${name(s)}</span>
    <span class="count">${count} card${count === 1 ? "" : "s"}</span>
    <span class="role">${s === HUMAN ? "" : us ? "teammate" : "opponent"}</span>`;
  const attrs = `class="${classes.join(" ")}" style="grid-area:s${s}" data-seat-box="${s}"`;
  return askable ? `<button ${attrs} data-act="target" data-seat="${s}">${body}</button>` : `<div ${attrs}>${body}</div>`;
}

function centerHtml(v: PlayerView): string {
  const e = showing?.event;
  const tap = awaiting.has(HUMAN) ? `<button class="continue" data-act="continue">Continue ▸</button>` : "";
  if (e?.type === "ask") {
    const answer = showing!.stage === "question" ? `<span class="verdict wait">…</span>`
      : `<span class="verdict ${e.success ? "hit" : "miss"}">${e.success ? "Got it" : "No"}</span>`;
    return `<div class="center show">
      <div class="line">${name(e.by)} <span class="arrow">→</span> ${name(e.to)}</div>
      ${cardHtml(e.card, "", "big")}
      ${answer}${tap}</div>`;
  }
  if (e?.type === "declare") {
    return `<div class="center show">
      <div class="line">${name(e.by)} declares</div>
      <div class="set-name">${setName(e.setId)}</div>
      <span class="verdict ${e.awardedTo === v.team ? "hit" : "bad"}">${e.correct ? "Correct" : "Wrong"}: point to ${e.awardedTo === v.team ? "you" : "them"}</span>${tap}</div>`;
  }
  const last = v.log.filter((x) => x.type === "forced-declaration").at(-1);
  return `<div class="center">${last ? eventText(last) : "Cards dealt. Good luck!"}${tap}</div>`;
}

function statusText(v: PlayerView): string {
  if (v.phase === "finished") return v.winner === v.team ? "Your team wins!" : "The opponents win.";
  if (v.phase === "forced-declaration") {
    const ourCards = v.handCounts.some((n, s) => n > 0 && teamOf(s) === v.team);
    return ourCards ? "No more asking. Declare your team's remaining sets." : "No more asking. Waiting for the opponents to declare.";
  }
  if (questionUp()) return "";
  if (v.turn !== HUMAN) return `${name(v.turn!)}'s turn…`;
  if (v.mustDeclare) return "You hold only complete sets. Declare them to continue.";
  if (ui.target !== null) return `Ask ${name(ui.target)} for:`;
  return "Your turn. Tap an opponent to ask them for a card.";
}

function askPanelHtml(v: PlayerView): string {
  if (ui.target === null || questionUp()) return "";
  const asks = legalAsks(v).filter((a) => a.to === ui.target);
  const bySet = new Map<SetId, Card[]>();
  for (const id of SET_IDS) {
    const cards = asks.filter((a) => SET_CARDS[id]!.includes(a.card)).map((a) => a.card);
    if (cards.length) bySet.set(id, cards);
  }
  return `<section class="panel ask">
    ${[...bySet].map(([id, cards]) => `<div class="group"><div class="label">${setName(id)}</div>
      <div class="cards">${cards.map((c) => cardHtml(c, `data-act="ask" data-card="${c}" aria-label="Ask for ${cardText(c)}"`)).join("")}</div></div>`).join("")}
    <button class="link" data-act="cancel-ask">Cancel</button>
  </section>`;
}

/** Your hand, with the set being asked about lit up and any card that just moved marked. */
function handHtml(v: PlayerView): string {
  const e = showing?.event.type === "ask" ? showing.event : null;
  const focusSet = e ? CARD_SET[e.card] : null;
  const answered = showing?.stage === "answer";
  const leaving = e && answered && e.success && e.to === HUMAN ? e.card : null; // just taken from you
  const shown = leaving ? [...v.hand, leaving] : v.hand;
  if (!shown.length) return `<section class="hand"><p class="empty">You have no cards left.</p></section>`;

  const mark = (c: Card): string => {
    if (!e || c !== e.card) return "";
    if (c === leaving) return "leaving";
    if (e.to === HUMAN) return "targeted"; // question up: they're asking for this one
    if (answered && e.success && e.by === HUMAN) return "arrived";
    return "";
  };
  const groups = SET_IDS.map((id) => [id, SET_CARDS[id]!.filter((c) => shown.includes(c))] as const).filter(([, cs]) => cs.length);
  return `<section class="hand">
    ${groups.map(([id, cards]) => {
      const complete = cards.length === 6 && !leaving;
      const focus = id === focusSet;
      return `<div class="group${complete ? " complete" : ""}${focus ? " focus" : ""}">
        <div class="label">${setName(id)}${complete ? " · complete" : ""}${focus ? " · being asked about" : ""}</div>
        <div class="cards">${cards.map((c) => cardHtml(c, "", mark(c))).join("")}</div></div>`;
    }).join("")}
  </section>`;
}

/** End of game: everyone's leftover cards, your team first. */
function revealHtml(v: PlayerView): string {
  const hands = v.revealedHands;
  if (!hands || hands.every((h) => !h.length)) return "";
  const seats = [0, 1, 2, 3, 4, 5].sort((a, b) => Number(teamOf(a) !== v.team) - Number(teamOf(b) !== v.team) || a - b);
  return `<section class="reveal">
    <h2>What everyone was holding</h2>
    ${seats.map((s) => {
      const cards = FULL_DECK.filter((c) => hands[s]!.includes(c));
      return `<div class="reveal-row"><span class="who ${teamOf(s) === v.team ? "us" : "them"}">${name(s)}</span>
        <div class="cards">${cards.length ? cards.map((c) => cardHtml(c, "", "small")).join("") : `<span class="none">no cards</span>`}</div></div>`;
    }).join("")}
  </section>`;
}

const DIFFICULTY_HINTS: Record<Difficulty, string> = {
  easy: "Small memory, forgetful, takes risky guesses",
  normal: "Decent memory, occasional lapses",
  hard: "Big memory, rarely slips",
  nightmare: "Remembers everything",
};

function setupSheetHtml(v: PlayerView): string {
  const s = ui.setup;
  if (!s) return "";
  const choices = (key: keyof Settings, options: [string, string][]) => `<div class="choices wrap">${options.map(([value, label]) =>
    `<button class="choice${s[key] === value ? " on" : ""}" data-act="setup" data-key="${key}" data-value="${value}">${label}</button>`).join("")}</div>`;
  const inProgress = v.phase !== "finished";
  return `<div class="sheet-backdrop" data-act="close-setup"></div>
    <section class="sheet" role="dialog" aria-label="New game">
      <h2>New game</h2>
      ${inProgress ? `<p class="hint">Starting a new game ends this one.</p>` : ""}
      <h3>Bots</h3>
      ${choices("difficulty", (Object.keys(DIFFICULTY) as Difficulty[]).map((d) => [d, d]))}
      <p class="hint">${DIFFICULTY_HINTS[s.difficulty]}</p>
      <h3>Speed</h3>
      ${choices("speed", Object.entries(PACE).map(([k, p]) => [k, p.label]))}
      <h3>Game log</h3>
      ${choices("log", [["shown", "shown"], ["hidden", "hidden"]])}
      <button class="primary" data-act="start-game">Start</button>
      <button class="link" data-act="close-setup">${inProgress ? "Back to this game" : "Cancel"}</button>
    </section>`;
}

function declareSheetHtml(v: PlayerView): string {
  const d = ui.declaring;
  if (!d) return "";
  const team = [0, 1, 2, 3, 4, 5].filter((s) => teamOf(s) === v.team);
  let body: string;
  if (d.setId === null) {
    body = `<h2>Declare which set?</h2>
      <p class="hint">Name who on your team holds each card. All correct: your team scores. Any mistake: the opponents score.</p>
      <div class="set-list">${v.remainingSets.map((id) => {
        const held = SET_CARDS[id]!.filter((c) => v.hand.includes(c)).length;
        return `<button class="set-btn" data-act="pick-set" data-set="${id}"><strong>${setName(id)}</strong><span>you hold ${held}</span></button>`;
      }).join("")}</div>`;
  } else {
    const cards = SET_CARDS[d.setId]!;
    const done = cards.every((c) => c in d.assignment);
    body = `<h2>Declare ${setName(d.setId)}</h2>
      <div class="assign">${cards.map((c) => `<div class="row">${cardHtml(c)}
        <div class="choices">${team.map((s) => `<button class="choice${d.assignment[c] === s ? " on" : ""}"
          data-act="assign" data-card="${c}" data-seat="${s}">${name(s)}</button>`).join("")}</div></div>`).join("")}</div>
      <button class="primary" data-act="confirm-declare" ${done ? "" : "disabled"}>Declare</button>`;
  }
  return `<div class="sheet-backdrop" data-act="close-declare"></div>
    <section class="sheet" role="dialog" aria-label="Declare a set">${body}
      <button class="link" data-act="close-declare">Cancel</button></section>`;
}

function render(): void {
  const v = viewFor(questionUp() ? showing!.before : state, HUMAN);
  const us = v.team;
  const canDeclare = !questionUp() && v.phase !== "finished" && v.remainingSets.length > 0;
  const urgent = v.mustDeclare || (v.phase === "forced-declaration" && v.handCounts.some((n, s) => n > 0 && teamOf(s) === us));
  const status = statusText(v);
  // The log only shows what has been answered.
  const log = questionUp() ? showing!.before.log : state.log;
  // Keep the log where the reader left it: following the newest entry if they were at it, otherwise put.
  const oldList = app.querySelector<HTMLElement>(".log ol");
  const logScroll = oldList && oldList.clientHeight ? { top: oldList.scrollTop, atEnd: atLogEnd(oldList) } : null;

  // The settings row sits at the very top, where nothing above it changes size, so it never moves.
  // On wide screens the log gets its own column beside the game (see .with-log in the CSS).
  app.classList.toggle("with-log", settings.log === "shown");
  app.innerHTML = `
    <div class="game">
    <nav class="settings">
      <span>Bots: ${settings.difficulty}</span>
      <label>Speed <select data-setting="speed">
        ${Object.entries(PACE).map(([s, p]) => `<option value="${s}" ${settings.speed === s ? "selected" : ""}>${p.label}</option>`).join("")}
      </select></label>
      <label>Log <select data-setting="log">
        ${(["shown", "hidden"] as const).map((l) => `<option value="${l}" ${settings.log === l ? "selected" : ""}>${l}</option>`).join("")}
      </select></label>
      <button class="link" data-act="open-setup">New game…</button>
    </nav>
    <header class="scores">
      <div class="score us"><span>Your team</span><strong>${v.scores[us]}</strong></div>
      <div class="target">first to ${v.config.setsToWin}</div>
      <div class="score them"><span>Opponents</span><strong>${v.scores[us === 0 ? 1 : 0]}</strong></div>
    </header>
    ${v.declared.length ? `<div class="declared">${v.declared.map((d) =>
      `<span class="chip ${d.awardedTo === us ? "us" : "them"}" title="${d.correct ? "correct" : "wrong"} declaration by ${name(d.by)}">${setName(d.setId)}${d.correct ? "" : " ✗"}</span>`).join("")}</div>` : ""}
    <section class="table">
      <svg class="arrows" aria-hidden="true"></svg>
      ${[1, 2, 3, 4, 5, 0].map((s) => seatHtml(v, s)).join("")}
      ${centerHtml(v)}
    </section>
    <p class="status${v.turn === HUMAN || urgent ? " you" : ""}">${status || "&nbsp;"}</p>
    ${ui.message ? `<p class="message">${ui.message}</p>` : ""}
    ${askPanelHtml(v)}
    ${v.revealedHands?.some((h) => h.length) ? revealHtml(v) : handHtml(v)}
    <div class="actions">
      ${canDeclare ? `<button class="${urgent ? "primary" : "secondary"}" data-act="open-declare">Declare a set</button>` : ""}
      ${v.phase === "finished" ? `<button class="primary" data-act="rematch">Rematch</button>
        <button class="secondary" data-act="open-setup">New game…</button>` : ""}
    </div>
    <footer><span class="seed">game ${seed}</span></footer>
    </div>
    ${settings.log === "shown" ? `<aside class="side"><details class="log" ${ui.logOpen ? "open" : ""}>
      <summary>Game log (${log.length})</summary>
      <div class="log-body">
        <ol>${log.map((e) => `<li class="${eventClass(e)}">${eventText(e)}</li>`).join("")}</ol>
        <button class="jump" data-act="jump-log" hidden>↓ Latest</button>
      </div>
    </details></aside>` : ""}
    ${declareSheetHtml(v)}
    ${setupSheetHtml(v)}`;

  const list = app.querySelector<HTMLElement>(".log ol");
  if (list) {
    list.scrollTop = !logScroll || logScroll.atEnd ? list.scrollHeight : logScroll.top;
    updateJump();
  }
  drawArrow();
}

const atLogEnd = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight < 8;

/** Show "Latest" only while the newest log entry is scrolled out of view. */
function updateJump(): void {
  const list = app.querySelector<HTMLElement>(".log ol");
  const jump = app.querySelector<HTMLElement>(".log .jump");
  if (list && jump) jump.hidden = atLogEnd(list);
}

/** An arrow from the asker's seat to the asked seat, drawn under the centre panel. */
function drawArrow(): void {
  const e = showing?.event;
  const table = app.querySelector<HTMLElement>(".table");
  const svg = app.querySelector<SVGSVGElement>(".arrows");
  if (!table || !svg || e?.type !== "ask") return;
  const box = (s: Seat) => app.querySelector<HTMLElement>(`[data-seat-box="${s}"]`)!.getBoundingClientRect();
  const t = table.getBoundingClientRect();
  const a = box(e.by), b = box(e.to);
  let [x1, y1] = [a.left + a.width / 2 - t.left, a.top + a.height / 2 - t.top];
  let [x2, y2] = [b.left + b.width / 2 - t.left, b.top + b.height / 2 - t.top];
  // Start and end at the edges of the seat boxes rather than their centres.
  const trim = (x: number, y: number, dx: number, dy: number, r: DOMRect) => {
    const k = Math.min(dx ? r.width / 2 / Math.abs(dx) : Infinity, dy ? r.height / 2 / Math.abs(dy) : Infinity);
    return [x + dx * k, y + dy * k] as const;
  };
  const [dx, dy] = [x2 - x1, y2 - y1];
  [x1, y1] = trim(x1, y1, dx, dy, a);
  [x2, y2] = trim(x2, y2, -dx, -dy, b);
  const kind = showing!.stage === "question" ? "wait" : e.success ? "hit" : "miss";
  svg.setAttribute("viewBox", `0 0 ${t.width} ${t.height}`);
  svg.innerHTML = `<defs><marker id="head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" class="head ${kind}"/></marker></defs>
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${kind}" marker-end="url(#head)"/>`;
}

// ---------------------------------------------------------------- input

app.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el || (el as HTMLButtonElement).disabled) return;
  const { act: what, seat, card, set } = el.dataset;
  switch (what) {
    case "target":
      ui.target = ui.target === Number(seat) ? null : Number(seat);
      return render();
    case "cancel-ask":
      ui.target = null;
      return render();
    case "ask":
      return act({ type: "ask", by: HUMAN, to: ui.target!, card: card! });
    case "jump-log": {
      const list = app.querySelector<HTMLElement>(".log ol")!;
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
      return;
    }
    case "continue":
      awaiting.delete(HUMAN);
      return awaiting.size ? render() : botMove();
    case "open-declare":
      ui.declaring = { setId: null, assignment: {} };
      return render();
    case "close-declare":
      ui.declaring = null;
      return render();
    case "pick-set": {
      const hand = viewFor(state, HUMAN).hand;
      ui.declaring = { setId: set!, assignment: Object.fromEntries(SET_CARDS[set!]!.filter((c) => hand.includes(c)).map((c) => [c, HUMAN])) };
      return render();
    }
    case "assign":
      ui.declaring!.assignment[card!] = Number(seat);
      return render();
    case "confirm-declare": {
      const d = ui.declaring!;
      ui.declaring = null;
      return act({ type: "declare", by: HUMAN, setId: d.setId!, assignment: d.assignment });
    }
    case "rematch":
      return startGame();
    case "open-setup":
      // Play pauses while the sheet is open; Cancel picks up where it left off.
      window.clearTimeout(timer);
      ui.setup = { ...settings };
      return render();
    case "setup":
      Object.assign(ui.setup!, { [el.dataset.key!]: el.dataset.value });
      return render();
    case "close-setup":
      ui.setup = null;
      return advance();
    case "start-game":
      Object.assign(settings, ui.setup);
      ui.setup = null;
      saveSettings();
      return startGame();
  }
});

app.addEventListener("change", (ev) => {
  const el = ev.target as HTMLSelectElement;
  if (el.dataset.setting === "speed") {
    settings.speed = el.value as Speed;
  } else if (el.dataset.setting === "log") {
    settings.log = el.value === "hidden" ? "hidden" : "shown";
  }
  saveSettings();
  if (questionUp()) render(); // don't cut the question short
  else advance();
});

// <details> toggle doesn't bubble, so listen in the capture phase to remember whether the log is open.
app.addEventListener("toggle", (ev) => {
  const details = ev.target as HTMLDetailsElement;
  if (!details.matches("details.log")) return;
  ui.logOpen = details.open;
  const list = details.querySelector<HTMLElement>("ol");
  if (details.open && list) list.scrollTop = list.scrollHeight;
  updateJump();
}, true);

// Scroll events don't bubble either.
app.addEventListener("scroll", (ev) => {
  if ((ev.target as HTMLElement).matches?.(".log ol")) updateJump();
}, true);

window.addEventListener("resize", () => drawArrow());

startGame();
