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
    expect(training).not.toContain('grant_training_access');
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
