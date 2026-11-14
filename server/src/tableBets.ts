/** Online masa bahisleri — TEK KAYNAK (14.11.2026: 5k-25k). İstemci listeleri, bot nüfusu ve
 *  Supabase bot_population kısıtları (20261114_table_bets_5k_25k.sql) bununla aynı olmalı. */
export const TABLE_BETS: readonly number[] = [5000, 10000, 15000, 20000, 25000];
export const TABLE_BET_MIN = 5000;
export const TABLE_BET_MAX = 25000;
export const TABLE_BET_STEP = 5000;

export function isTableBet(bet: unknown): bet is number {
  return typeof bet === 'number' && Number.isInteger(bet) && TABLE_BETS.includes(bet);
}

/** Bot nüfusu iç doğrulaması: eski (500-5000) ve yeni (5k-25k) aralığı kapsar; plans TABLE_BET_MIN ile açılır.
 *  Supabase bot_population kısıtları bununla aynı (500..25000, 500'ün katı). */
export function isPopulationBet(bet: unknown): bet is number {
  return typeof bet === 'number' && Number.isInteger(bet) && bet >= 500 && bet <= TABLE_BET_MAX && bet % 500 === 0;
}
