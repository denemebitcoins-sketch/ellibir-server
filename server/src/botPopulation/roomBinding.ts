import { PopulationRoomSession } from './roomSession';
import { ServerError } from '@colyseus/core';
import { PopulationStorage } from './storage';

interface BindableRoom { bindPopulation(storage: PopulationStorage, owner: string, key: string): PopulationRoomSession; }

/** An in-process capability survives Colyseus' shallow option merge. JSON cannot create it. */
export class PopulationRoomBinding {
  session: PopulationRoomSession | null = null;
  constructor(readonly storage: PopulationStorage, readonly owner: string, readonly key: string, readonly bet: number) {
    if (!Number.isInteger(bet) || bet < 500 || bet > 5000 || bet % 500) throw new Error('population_bet_invalid');
  }
  attach(room: BindableRoom): void {
    if (this.session) throw new Error('population_binding_reused');
    this.session = room.bindPopulation(this.storage, this.owner, this.key);
    this.session.acceptNewMatches(false);
  }
}

export function attachPopulationBinding(options: any, room: BindableRoom): void {
  if (options?._populationBinding instanceof PopulationRoomBinding) options._populationBinding.attach(room);
}
export function populationBetOption(options: any): number | undefined {
  return options?._populationBinding instanceof PopulationRoomBinding ? options._populationBinding.bet : undefined;
}
export function requirePopulationClient(session: PopulationRoomSession | null, options: any): void {
  if (session && options?.populationVersion !== 1)
    throw new ServerError(4217, 'Bot masalari icin oyunu 5.7 veya ustune guncelleyin.');
}
