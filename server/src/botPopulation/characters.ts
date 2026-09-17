export interface CharacterSeed {
  id: string;
  name: string;
  gender: 'e' | 'k';
  cosmetic_vip: boolean;
  avatar_key: string | null;
  initial_chips: number;
}

const female = [
  'Arzu', 'Zeynep', 'Elif', 'Asli', 'Derya', 'Selin', 'Ece', 'Aylin', 'Bahar', 'Ceren',
  'Deniz', 'Ebru', 'Esra', 'Fatma', 'Gamze', 'Gizem', 'Gonca', 'Gul', 'Gulay', 'Hande',
  'Hulya', 'Irem', 'Lale', 'Leyla', 'Melis', 'Merve', 'Nazan', 'Nehir', 'Nermin', 'Nil',
  'Nisan', 'Nur', 'Oya', 'Ozge', 'Pelin', 'Pinar', 'Seda', 'Sedef', 'Selma', 'Serap',
  'Sevgi', 'Sibel', 'Sinem', 'Su', 'Tulay', 'Yasemin', 'Yeliz', 'Yonca', 'Zehra', 'Zumra',
];
const male = [
  'Mithat', 'Mustafa', 'Ahmet', 'Mehmet', 'Ali', 'Baris', 'Berk', 'Burak', 'Can', 'Cem',
  'Cengiz', 'Cihan', 'Emre', 'Engin', 'Erdal', 'Eren', 'Erol', 'Fatih', 'Ferhat', 'Fikret',
  'Hakan', 'Halil', 'Hasan', 'Huseyin', 'Ilker', 'Ismail', 'Kadir', 'Kemal', 'Kerem', 'Levent',
  'Mahmut', 'Mert', 'Metin', 'Murat', 'Necati', 'Oguz', 'Onur', 'Orhan', 'Osman', 'Ozan',
  'Recep', 'Riza', 'Sami', 'Selim', 'Serkan', 'Sinan', 'Tamer', 'Ugur', 'Volkan', 'Yusuf',
];

/** Stable internal IDs, ordinary visible names. Seeding never resets existing balances.
 * Cosmetic VIP is presentation only, never an authorization role or a paid entitlement.
 */
export function initialCharacters(): CharacterSeed[] {
  return [...female, ...male].map((name, index) => ({
    id: `b0700000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name,
    gender: index < female.length ? 'k' : 'e',
    cosmetic_vip: index % 5 === 0,
    avatar_key: index === 0 ? 'arzu-v1' : index === 50 ? 'mithat-v1' : null,
    initial_chips: 100000 + (index * 7919 + 3571) % 200001,
  }));
}
