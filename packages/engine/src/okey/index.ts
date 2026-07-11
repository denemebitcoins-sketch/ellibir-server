/** OKEY motoru — dış API. 51 motoruyla yan yana yaşar (packages/engine/src/okey). */
export * from './types';
export * from './rules';
export { buildOkeyDeck, dealOkey, identityOf, isOkeyTile, nextRank, makeTileId } from './deck';
export {
  canFinishMelds, canFinishPairs, checkFinish, countIdentities,
  isValidRun, isValidSet, isValidPair, bestGrouping,
} from './melds';
export {
  createOkeyGame, startNextEl, applyOkeyMove, autoOkeyMove, elMultOf,
  beginBankoPhase, chooseBanko, choosePas, resolveBankoPhase, botBankoDecide,
  yuzbirOpeningMin, yuzbirPairOpeningMin, bestYuzbirMeldOpening, bestYuzbirPairOpening, pairGroupsFor,
} from './game';
export type { OkeyGameState, OkeyPlayer, OkeyMove, OkeyMoveResult, OkeyCreateOptions, OkeyPublicMeld } from './game';
export { playOkeyBotTurn } from './bot';
