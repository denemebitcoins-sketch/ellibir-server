/** TAVLA motoru — dış API. 51 ve OKEY motorlarıyla yan yana yaşar (packages/engine/src/tavla). */
export {
  createTavlaGame, startNextGame, applyTavlaMove, autoTavlaMove,
  legalSteps, stepFor, DEFAULT_TAVLA_RULES,
} from './game';
export type {
  TavlaGameState, TavlaPlayer, TavlaMove, TavlaMoveResult, TavlaRuleConfig, TavlaStep,
} from './game';
export { playTavlaBotTurn, bestTavlaStep } from './bot';
