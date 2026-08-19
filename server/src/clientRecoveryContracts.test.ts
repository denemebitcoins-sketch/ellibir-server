import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '..');
const desktop = path.resolve(repoRoot, '..');
const candidateUnityRoot = path.resolve(desktop, '51-unity-3agustos-kurtarma-aday-20260806');
const unityRoot = existsSync(candidateUnityRoot) ? candidateUnityRoot : path.resolve(desktop, '51-unity');

function unitySource(rel: string): string {
  return readFileSync(path.resolve(unityRoot, rel), 'utf8');
}

describe('recovered Unity client contracts', () => {
  it('does not auto-create placeholder profiles before mandatory onboarding', () => {
    const splash = unitySource('Assets/Meta/SplashScreen.cs');
    const beta = unitySource('Assets/Meta/Net/BetaWelcomeService.cs');
    const setup = unitySource('Assets/Meta/ProfileSetupScreen.cs');
    const profile = unitySource('Assets/Meta/Net/SupabaseProfile.cs');

    expect(splash).not.toContain('SupabaseProfile.EnsureProfile');
    expect(beta).toContain('ProfileStore.HasCompletedRequiredInfo()');
    expect(setup).toContain('SupabaseProfile.IsNameTaken');
    expect(setup).toContain('SupabaseProfile.PushWithResult');
    expect(setup).toContain('BELİRTMEK İSTEMİYORUM');
    expect(setup).toContain('CheckNameAfterDelay');
    expect(setup).toContain('Bu kullanıcı adı kullanılıyor.');
    expect(profile).not.toContain('fixName');
    expect(profile).not.toContain('İsim çakışması onarıldı');
  });

  it('keeps guest retries on the existing auth identity instead of minting local ghost ids', () => {
    const auth = unitySource('Assets/Meta/Net/SupabaseAuth.cs');
    const userGetter = auth.slice(auth.indexOf('public static string UserId'), auth.indexOf('public static string AccessToken'));

    expect(userGetter).not.toContain('Guid.NewGuid');
    expect(userGetter).not.toContain('SetString(KEY_USER_ID');
    expect(auth).toContain('static bool _signingIn');
    expect(auth).toContain('while (_signingIn');
  });

  it('publishes training presence from the global heartbeat with a wider online cutoff', () => {
    const social = unitySource('Assets/Meta/Net/SupabaseSocial.cs');

    expect(social).toContain('status = "antrenman"');
    expect(social).toContain('51 - Antrenman');
    expect(social).toContain('101 - Antrenman');
    expect(social).toContain('Tavla - Antrenman');
    expect(social).toContain('AddSeconds(-90)');
    expect(social).toContain('status == "antrenman"');
  });

  it('uses rewarded ads for training access and keeps production ad units selected', () => {
    const config = unitySource('Assets/Meta/Monetization/MonetizationConfig.cs');
    const training = unitySource('Assets/Meta/Monetization/TrainingInterstitialService.cs');

    expect(config).toContain('public const bool UseGoogleTestAds = false');
    expect(config).toContain('AndroidRewardedProductionUnit');
    expect(training).toContain('RewardedAd.Load(MonetizationConfig.RewardedUnitId');
    expect(training).toContain('begin_training_rewarded_ad');
    expect(training).toContain('get_training_rewarded_ad_state');
    expect(training).toContain('RefreshAccessState(active =>');
    expect(training).toContain('ShowAccessAdAfterServerCheck');
    expect(training).toContain('begin.error == "active" && begin.remaining_seconds > 0');
    expect(training).not.toContain('grant_training_access');
  });

  it('refreshes training access when the training salon is drawn and exposes a central quick-play button', () => {
    const gate = unitySource('Assets/Meta/TrainingAccessGate.cs');
    const ellibir = unitySource('Assets/Meta/ColyseusLobbyScreen.cs');
    const okey = unitySource('Assets/Meta/OkeyLobbyScreen.cs');
    const tavla = unitySource('Assets/Meta/TavlaLobbyScreen.cs');

    expect(gate).toContain('TrainingInterstitialService.RefreshAccessState(_ => UpdateStatus(label))');
    expect(gate).toContain('"trainingQuickPlay"');
    expect(gate).toContain('new Vector2(470f, 92f)');
    expect(ellibir).toContain('TrainingAccessGate.DrawStatus(Stage, ModernSalonKit.TrainingStatusPosition, QuickPlay)');
    expect(okey).toContain('TrainingAccessGate.DrawStatus(Stage, ModernSalonKit.TrainingStatusPosition, QuickPlay)');
    expect(tavla).toContain('TrainingAccessGate.DrawStatus(Stage, ModernSalonKit.TrainingStatusPosition, QuickPlay)');
  });

  it('shows chip no-cash-value and VAT-included notices in store and info center', () => {
    const shop = unitySource('Assets/Meta/ShopScreen.cs');
    const settings = unitySource('Assets/Meta/SettingsScreen.cs');

    expect(shop).toContain('Çiplerin maddi değeri yoktur');
    expect(shop).toContain('satılamaz, devredilemez ve nakde çevrilemez');
    expect(shop).toContain('Fiyatlara KDV dahildir');
    expect(settings).toContain('Çip ve satın alma');
    expect(settings).toContain('Mağazada gösterilen fiyatlara KDV dahildir');
    expect(settings).toContain('satılamaz, devredilemez ve nakde çevrilemez');
  });

  it('exposes community chat clearing only through the admin RPC with confirmation UI', () => {
    const adminScreen = unitySource('Assets/Meta/AdminPanelScreen.cs');
    const adminApi = unitySource('Assets/Meta/Net/SupabaseAdmin.cs');

    expect(adminScreen).toContain('TabButton("SOHBET"');
    expect(adminScreen).toContain('BuildClearChatConfirm');
    expect(adminScreen).toContain('TOPLULUK SOHBETİNİ TEMİZLE');
    expect(adminScreen).toContain('SupabaseAdmin.ClearLobbyChat');
    expect(adminApi).toContain('/rest/v1/rpc/admin_clear_lobby_chat');
    expect(adminApi).not.toContain('/rest/v1/lobby_chat?');
  });

  it('exposes central chat filter management and routes table chat through the server filter', () => {
    const adminScreen = unitySource('Assets/Meta/AdminPanelScreen.cs');
    const adminApi = unitySource('Assets/Meta/Net/SupabaseAdmin.cs');
    const roomFiles = [
      'src/rooms/EllibirRoom.ts',
      'src/rooms/OkeyRoom.ts',
      'src/rooms/TavlaRoom.ts',
    ].map((rel) => readFileSync(path.resolve(repoRoot, 'server', rel), 'utf8'));

    expect(adminScreen).toContain('YASAKLI KELİMELER');
    expect(adminScreen).toContain('DoAddChatFilterWord');
    expect(adminScreen).toContain('DoDeleteChatFilterWord');
    expect(adminApi).toContain('/rest/v1/rpc/admin_list_chat_filter_words');
    expect(adminApi).toContain('/rest/v1/rpc/admin_upsert_chat_filter_word');
    expect(adminApi).toContain('/rest/v1/rpc/admin_delete_chat_filter_word');
    for (const room of roomFiles) {
      expect(room).toContain('filterChatText');
      expect(room).toContain('text: filtered');
    }
  });

  it('includes claimable daily quests in the daily menu badge state', () => {
    const mainLayout = unitySource('Assets/Meta/MainLayout.cs');
    const sidebar = unitySource('Assets/Meta/SidebarShell.cs');
    const daily = unitySource('Assets/Meta/DailyScreen.cs');
    const quest = unitySource('Assets/Meta/Net/SupabaseQuest.cs');

    expect(quest).toContain('public static int CachedClaimable');
    expect(quest).toContain('progress >= q.target');
    expect(quest).toContain('FetchClaimableCount');
    expect(mainLayout).toContain('SupabaseQuest.CachedClaimable > 0');
    expect(mainLayout).toContain('SupabaseQuest.FetchClaimableCount');
    expect(sidebar).toContain('SupabaseQuest.CachedClaimable > 0');
    expect(sidebar).toContain('SupabaseQuest.FetchClaimableCount');
    expect(sidebar).toContain('RefreshDailyDot');
    expect(daily).toContain('MainLayout.RefreshBadgesNow');
  });

  it('shows a persistent one-time intro overlay in each salon', () => {
    const intro = unitySource('Assets/Meta/SalonIntroOverlay.cs');
    const ellibir = unitySource('Assets/Meta/ColyseusLobbyScreen.cs');
    const okey = unitySource('Assets/Meta/OkeyLobbyScreen.cs');
    const tavla = unitySource('Assets/Meta/TavlaLobbyScreen.cs');

    expect(intro).toContain('public static class SalonIntroOverlay');
    expect(intro).toContain('PlayerPrefs.SetString(Key(salonKey), Epoch)');
    expect(intro).toContain('online-kahvem/salon-intro/');
    expect(intro).toContain('ATLA');
    expect(intro).toContain('ANLADIM');
    expect(ellibir).toContain('SalonIntroOverlay.TryShow(Stage, "51"');
    expect(okey).toContain('SalonIntroOverlay.TryShow(Stage, "okey-" + _variant');
    expect(tavla).toContain('SalonIntroOverlay.TryShow(Stage, "tavla"');
    expect(ellibir).toContain('SalonIntroOverlay.IsOpen(Stage)');
    expect(okey).toContain('SalonIntroOverlay.IsOpen(Stage)');
    expect(tavla).toContain('SalonIntroOverlay.IsOpen(Stage)');
  });

  it('captures only the yazboz group and stamps the share watermark', () => {
    const okey = unitySource('Assets/Meta/OkeyGameClient.cs');
    const share = unitySource('Assets/Meta/YazbozShare.cs');

    expect(okey).toContain('"yzcapture"');
    expect(okey).toContain('YazbozShare.CaptureAndShare(this, capRt');
    expect(okey).not.toContain('YazbozShare.CaptureAndShare(this, (RectTransform)bd.transform');
    expect(share).toContain('Sosyal Oyun Platformu');
    expect(share).toContain('shareWatermark');
    expect(share).toContain('root.transform.SetAsFirstSibling()');
    expect(share).toContain('okText.fontSize = 138');
  });
});
