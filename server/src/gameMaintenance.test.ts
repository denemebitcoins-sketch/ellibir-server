import { describe, expect, it, afterEach } from 'vitest';
import { __setMaintenanceForTest, busyHumanFromEntryError, maintenanceBlock, okeyMaintenanceKey, MAINTENANCE_DEFAULT_MESSAGE } from './gameMaintenance';

afterEach(() => __setMaintenanceForTest(null));

describe('oyun bakım modu', () => {
  it('bakımdaki oyun mesaj döner, açık oyun null', async () => {
    __setMaintenanceForTest({ '51': { on: true, msg: '' }, tavla: { on: false } });
    expect(await maintenanceBlock('51', 'u1')).toBe(MAINTENANCE_DEFAULT_MESSAGE);
    expect(await maintenanceBlock('tavla', 'u1')).toBeNull();
    expect(await maintenanceBlock('ihale', 'u1')).toBeNull();
  });
  it('özel mesaj ve yönetici muafiyeti', async () => {
    __setMaintenanceForTest({ ihale: { on: true, msg: 'Akşam açılacak' } }, ['admin1']);
    expect(await maintenanceBlock('ihale', 'u2')).toBe('Akşam açılacak');
    expect(await maintenanceBlock('ihale', 'admin1')).toBeNull();
  });
  it('okey varyant anahtarları', () => {
    expect(okeyMaintenanceKey('yuzbir')).toBe('101');
    expect(okeyMaintenanceKey('banko')).toBe('bankolu');
    expect(okeyMaintenanceKey('duz')).toBe('klasik');
  });
  it('başka masada süren maç hatasından insanı bulur', () => {
    const msg = 'bot_population_begin_match_http_409:{"code":"23505","details":"Key (kind, participant_id)=(human, aa3992d3-b7b8-43dd-a2d7-70b1ee2e5a2c) already exists.","message":"duplicate key value violates unique constraint \\"match_seats_active_identity_idx\\""}';
    expect(busyHumanFromEntryError(msg)).toBe('aa3992d3-b7b8-43dd-a2d7-70b1ee2e5a2c');
    expect(busyHumanFromEntryError('insufficient_chips')).toBeNull();
  });
});
