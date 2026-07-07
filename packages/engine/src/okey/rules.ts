/** OKEY kural yapılandırması — KAHVE USULÜ düz okey (kullanıcı tarifi, 2026-07):
 *  Ceza BİRİKİR (düşük iyi). Düz bitiş = rakipler +100 ceza, kazanan kendi cezasından -100.
 *  Çifte bitmek 2x, okey atarak bitmek 2x, çift+okey 4x. Gösterge gösteren kendi cezasından -50.
 *  Baraj/sorgu/açma sertlikleri YOK. Maç sonunda EN DÜŞÜK ceza kazanır. */
export interface OkeyYuzbirConfig {
  openingMin: number;       // seri/küt açışı için minimum toplam
  pairOpeningMin: number;   // çift açışı için minimum çift sayısı
  katlamali: boolean;       // masadaki en yüksek açışın bir üstü gerekir
  unopenedPenalty: number;  // hiç açamayan oyuncu cezası
  winnerBonus: number;      // bitiren oyuncu delta'sı (klasik: -101)
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
  scoring: { startScore: 500, base: 100, gosterge: 50, pairsX: 2, okeyX: 2 },
  yuzbir: {
    openingMin: 101,
    pairOpeningMin: 5,
    katlamali: true,
    unopenedPenalty: 202,
    winnerBonus: -101,
    pairPenaltyX: 2,
    okeyFinishX: 2,
    islekDiscardPenalty: 101,
  },
};
