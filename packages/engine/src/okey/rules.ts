/** DÜZ OKEY kural yapılandırması. Puan değerleri kaynaklarda varyantlı olduğundan
 *  masa ayarı olarak buradan oynanır (51'deki RuleConfig yaklaşımıyla birebir). */
export interface OkeyRuleConfig {
  teamMode: boolean;        // eşli (0&2 vs 1&3, karşılıklı) — puan takıma ortak işler
  totalEls: number;         // maçtaki el sayısı
  turnTimerSeconds: number; // sıra süresi (oda uygular; motor autoMove sağlar)
  startScore: number;       // klasik: 20'den düşme. Puanı biten diskalifiye OLMAZ; maç sonu en yüksek kalan kazanır.
  points: {
    win: number;            // normal bitiş → rakiplerden düşülen
    okeyWin: number;        // son taşı OKEY atarak bitiş
    pairWin: number;        // 7 çift ile bitiş
    pairOkeyWin: number;    // çift + okey atarak
    gosterge: number;       // gösterge tekini gösterme → rakiplerden düşülen
  };
}

export const DEFAULT_OKEY_RULES: OkeyRuleConfig = {
  teamMode: false,
  totalEls: 9,
  turnTimerSeconds: 30,
  startScore: 20,
  points: { win: 2, okeyWin: 4, pairWin: 4, pairOkeyWin: 8, gosterge: 1 },
};
