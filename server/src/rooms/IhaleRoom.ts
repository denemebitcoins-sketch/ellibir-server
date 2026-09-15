import { EllibirRoom } from './EllibirRoom';
import { ihaleRuntime } from '../cardRoomRuntime';

// Only the game rules/view differ. Authentication, seats, social features and lifecycle stay shared.
export class IhaleRoom extends EllibirRoom {
  protected gameKey = 'ihale';
  protected runtime = ihaleRuntime;
}
