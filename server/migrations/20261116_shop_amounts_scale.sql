-- Online Kahvem - Mağaza miktarları büyütüldü (2026-11-16). Fiyatlar ve ürün kimlikleri AYNI.
-- Çip ×5, elmas ×7,5, VIP günlük ek ödül 10.000→50.000 çip, 5→40 elmas.
-- Canlıdaki fonksiyon tanımları okunur, YALNIZ miktar sabitleri değiştirilir; beklenen bir sabit
-- bulunamazsa exception → tüm işlem geri alınır (canlı tanımın başka kısmı ezilmez).

begin;

do $mig$
declare
  d text;
  before text;
  r record;
begin
  -- 1) finalize_play_purchase: paket miktarları
  select pg_get_functiondef(p.oid) into d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'finalize_play_purchase';
  if d is null then raise exception 'finalize_play_purchase yok'; end if;
  for r in select * from (values
      ($a$'onlinekahvem.chips.100k' then v_chip_delta := 100000;$a$,   $a$'onlinekahvem.chips.100k' then v_chip_delta := 500000;$a$),
      ($a$'onlinekahvem.chips.250k' then v_chip_delta := 250000;$a$,   $a$'onlinekahvem.chips.250k' then v_chip_delta := 1250000;$a$),
      ($a$'onlinekahvem.chips.600k' then v_chip_delta := 600000;$a$,   $a$'onlinekahvem.chips.600k' then v_chip_delta := 3000000;$a$),
      ($a$'onlinekahvem.chips.1500k' then v_chip_delta := 1500000;$a$, $a$'onlinekahvem.chips.1500k' then v_chip_delta := 7500000;$a$),
      ($a$'onlinekahvem.chips.4000k' then v_chip_delta := 4000000;$a$, $a$'onlinekahvem.chips.4000k' then v_chip_delta := 20000000;$a$),
      ($a$'onlinekahvem.diamond.100' then v_diamonds := 100;$a$,       $a$'onlinekahvem.diamond.100' then v_diamonds := 750;$a$),
      ($a$'onlinekahvem.diamond.300' then v_diamonds := 300;$a$,       $a$'onlinekahvem.diamond.300' then v_diamonds := 2250;$a$),
      ($a$'onlinekahvem.diamond.750' then v_diamonds := 750;$a$,       $a$'onlinekahvem.diamond.750' then v_diamonds := 5600;$a$),
      ($a$'onlinekahvem.diamond.1750' then v_diamonds := 1750;$a$,     $a$'onlinekahvem.diamond.1750' then v_diamonds := 13000;$a$),
      ($a$'onlinekahvem.diamond.4000' then v_diamonds := 4000;$a$,     $a$'onlinekahvem.diamond.4000' then v_diamonds := 30000;$a$)
    ) as t(old_txt, new_txt)
  loop
    before := d;
    d := replace(d, r.old_txt, r.new_txt);
    if d = before then raise exception 'finalize_play_purchase: bulunamadı: %', r.old_txt; end if;
  end loop;
  execute d;

  -- 2) claim_daily: VIP günlük ek ödül
  select pg_get_functiondef(p.oid) into d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_daily';
  if d is null then raise exception 'claim_daily yok'; end if;
  for r in select * from (values
      ('v_chips_delta := 10000;',            'v_chips_delta := 50000;'),
      ('v_diamonds_delta := 5;',             'v_diamonds_delta := 40;'),
      ('v_chips_delta := v_chips_delta + 10000;', 'v_chips_delta := v_chips_delta + 50000;'),
      ('v_diamonds_delta := v_diamonds_delta + 5;', 'v_diamonds_delta := v_diamonds_delta + 40;')
    ) as t(old_txt, new_txt)
  loop
    before := d;
    d := replace(d, r.old_txt, r.new_txt);
    if d = before then raise exception 'claim_daily: bulunamadı: %', r.old_txt; end if;
  end loop;
  execute d;
end
$mig$;

commit;
