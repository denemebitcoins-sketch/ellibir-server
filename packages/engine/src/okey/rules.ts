/** OKEY kural yapılandırması — DÜZ OKEY (kullanıcı kuralı, 2026-07):
 *  Kaçtan-düş: herkes masa ayarındaki puandan (20/24/28/30, vars. 24) başlar; 0'a İNEN anında
 *  kazanır, 0'a en yakın 2. olur. Düz bitiş 2, çifte/okey bitiş 4 (×2), çift+okey 8 (×4),
 *  gösterge -1. BANKO/101: biriktirme modeli (0'dan başla, sabit el, en düşük ceza kazanır). */
export interface OkeyYuzbirConfig {
  openingMin: number;       // seri/küt açışı için minimum toplam
  pairOpeningMin: number;   // çift açışı için minimum çift sayısı
  katlamali: boolean;       // masadaki en yüksek açışın bir üstü gerekir
  unopenedPenalty: number;  // hiç açamayan oyuncu cezası
  winnerBonus: number;      // bitiren oyuncu delta'sı (klasik: -101)
  kafaX: number;            // kimse açmadan direkt bitiş çarpanı
  pairPenaltyX: number;     // çift bitiş/çift açmış oyuncu ceza çarpanı
  okeyFinishX: number;      // okey atarak bitiş çarpanı
  islekDiscardPenalty: number; // açık taşlara işleyebilen taş atma cezası
}

export interface OkeyRuleConfig {
  variant: 'duz' | 'banko' | 'yuzbir'; // mod: düz / banko / 101
  teamMode: boolean;        // eşli (0&2 vs 1&3, karşılıklı)
  totalEls: number;         // maçtaki el sayısı
  turnTimerSeconds: number; // sıra süresi (oda uygular; motor autoMove sağlar)
  scoring: {
    startScore: number;     // DÜŞME modeli: herkes bundan başlar; 0'a İNEN maçı kazanır
    base: number;           // düz bitiş birimi (kazanan -base düşer, rakipler +base yükselir)
    gosterge: number;       // gösterge gösteren KENDİ puanından düşer
    pairsX: number;         // çifte bitiş çarpanı
    okeyX: number;          // okey atarak bitiş çarpanı (çift+okey = pairsX*okeyX)
  };
  yuzbir: OkeyYuzbirConfig;
}

export const DEFAULT_OKEY_RULES: OkeyRuleConfig = {
  variant: 'duz',
  teamMode: false,
  totalEls: 9,             // emniyet tavanı: kimse 0'a inemezse bu kadar el sonunda EN DÜŞÜK kazanır
  turnTimerSeconds: 30,
  scoring: { startScore: 24, base: 2, gosterge: 1, pairsX: 2, okeyX: 2 },
  yuzbir: {
    openingMin: 101,
    pairOpeningMin: 5,
    katlamali: true,
    unopenedPenalty: 202,
    winnerBonus: -101,
    kafaX: 2,
    pairPenaltyX: 2,
    okeyFinishX: 2,
    islekDiscardPenalty: 101,
  },
};
