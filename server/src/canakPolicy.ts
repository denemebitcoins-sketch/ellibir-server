export const SPECIAL_FINISH_CHANCE = 0.01;
export const TAVLA_MARS_CHANCE = 0.005;

export function okeyCanakChance(finishKind: string): number {
  return finishKind === 'okey' || finishKind === 'pairs' || finishKind === 'pairsOkey'
    ? SPECIAL_FINISH_CHANCE
    : 0;
}

export function ellibirCanakChance(okeyFinish: boolean, pairFinish: boolean): number {
  return okeyFinish || pairFinish ? SPECIAL_FINISH_CHANCE : 0;
}

export function tavlaCanakChance(mars: boolean): number {
  return mars ? TAVLA_MARS_CHANCE : 0;
}
