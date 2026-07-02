/** OKEY kural yapılandırması — KAHVE USULÜ düz okey (kullanıcı tarifi, 2026-07):
 *  Ceza BİRİKİR (düşük iyi). Düz bitiş = rakipler +100 ceza, kazanan kendi cezasından -100.
 *  Çifte bitmek 2x, okey atarak bitmek 2x, çift+okey 4x. Gösterge gösteren kendi cezasından -50.
 *  Baraj/sorgu/açma sertlikleri YOK. Maç sonunda EN DÜŞÜK ceza kazanır. */
export interface OkeyRuleConfig {
  variant: 'duz' | 'banko' | 'yuzbir'; // mod — şimdilik yalnız 'duz' implement (banko/101 sonra)
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
}

export const DEFAULT_OKEY_RULES: OkeyRuleConfig = {
  variant: 'duz',
  teamMode: false,
  totalEls: 9,             // emniyet tavanı: kimse 0'a inemezse bu kadar el sonunda EN DÜŞÜK kazanır
  turnTimerSeconds: 30,
  scoring: { startScore: 500, base: 100, gosterge: 50, pairsX: 2, okeyX: 2 },
};
