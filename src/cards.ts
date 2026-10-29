export type Card = string; // e.g. "7S", "10H", "AD", "8C", "JKR-R"
export type SetId = string; // e.g. "S-low", "H-high", "EIGHTS"

export const SUITS = ["S", "H", "D", "C"] as const;
const LOW = ["2", "3", "4", "5", "6", "7"] as const;
const HIGH = ["9", "10", "J", "Q", "K", "A"] as const;

/** The two jokers are distinct cards, so each can be asked for individually. */
export const JOKERS = ["JKR-R", "JKR-B"] as const;

export const EIGHTS_SET: SetId = "EIGHTS";

export const SET_CARDS: Record<SetId, readonly Card[]> = {};
export const CARD_SET: Record<Card, SetId> = {};

function defineSet(id: SetId, cards: Card[]): void {
  SET_CARDS[id] = cards;
  for (const c of cards) CARD_SET[c] = id;
}

for (const s of SUITS) {
  defineSet(`${s}-low`, LOW.map((r) => `${r}${s}`));
  defineSet(`${s}-high`, HIGH.map((r) => `${r}${s}`));
}
defineSet(EIGHTS_SET, [...SUITS.map((s) => `8${s}`), ...JOKERS]);

export const SET_IDS: readonly SetId[] = Object.keys(SET_CARDS);
export const FULL_DECK: readonly Card[] = SET_IDS.flatMap((id) => SET_CARDS[id]!);
