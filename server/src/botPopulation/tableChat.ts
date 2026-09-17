export class PopulationTableChat {
  private last = -Infinity;
  private readonly sent = new Set<string>();
  constructor(private readonly now = Date.now, private readonly random = Math.random) {}
  message(match: string, event: 'start'|'finish', humanPresent: boolean): string | null {
    const key = `${match}:${event}`;
    if (!humanPresent || this.sent.has(key) || this.now()-this.last<90000) return null;
    this.sent.add(key);
    if (this.sent.size>8) this.sent.delete(this.sent.values().next().value!);
    this.last=this.now();
    const lines = event==='start' ? ['Iyi oyunlar.','Bol sans.'] : ['Tebrikler.','Guzel oyundu.'];
    return lines[Math.min(lines.length-1,Math.floor(this.random()*lines.length))];
  }
}
