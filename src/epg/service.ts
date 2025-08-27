import fetch from 'node-fetch';
import sax from 'sax';
import cron from 'node-cron';
import { EPGIndex, EPGServiceOptions, Programme } from './types';
import { normalizeChannelName } from './nameMap';

export class EPGService {
  private url: string;
  private index: EPGIndex = { byChannel: {}, nowNext: {}, channelNames: {}, nameToIds: {}, updatedAt: 0 };
  private schedule?: any;
  private pruning = { pastMs: 8 * 3600_000, futureMs: 8 * 3600_000 };
  private refreshing = false;

  constructor(opts: EPGServiceOptions) {
    this.url = opts.url;
    const cronSpec = opts.refreshCron || '0 */3 * * *'; // every 3 hours
    const pastH = Math.max(0, Math.floor(opts.prunePastHours ?? 8));
    const futH = Math.max(1, Math.floor(opts.pruneFutureHours ?? 8));
    this.pruning = { pastMs: pastH * 3600_000, futureMs: futH * 3600_000 };
    this.schedule = cron.schedule(cronSpec, () => {
      this.refresh().catch(() => {});
    }, { timezone: 'Europe/Rome' });
  }

  public getIndex(): EPGIndex { return this.index; }

  public async refresh(): Promise<void> {
    if (this.refreshing) return; // guard overlapping
    this.refreshing = true;
    try {
      const res = await fetch(this.url, { timeout: 20000 } as any);
      if (!res.ok) throw new Error(`EPG fetch failed: ${res.status}`);
      const xml = await res.text();
      this.index = this.parse(xml);
      this.index.updatedAt = Date.now();
    } finally {
      this.refreshing = false;
    }
  }

  private parse(xml: string): EPGIndex {
    const parser = sax.parser(true, { trim: true, lowercase: true });
    const byChannel: Record<string, Programme[]> = {};
    const channelNames: Record<string, string[]> = {};
    const now = Date.now();
    const minStart = now - this.pruning.pastMs;
    const maxStop = now + this.pruning.futureMs;

    let curProg: Partial<Programme> | null = null;
    let curText = '';
    let inChannel = false;
    let curChannelId: string | null = null;

    parser.onopentag = (node: any) => {
      const name = node.name;
      curText = '';
      if (name === 'programme') {
        const ch = String((node.attributes as any).channel || '');
        const startRaw = String((node.attributes as any).start || '');
        const stopRaw = String((node.attributes as any).stop || '');
        const start = this.xmltvToMs(startRaw);
        const stop = this.xmltvToMs(stopRaw);
        // prune by time-window early to avoid storing huge arrays
        if (isFinite(start) && isFinite(stop) && stop >= minStart && start <= maxStop) {
          curProg = { channel: ch, start, stop };
        } else {
          curProg = null;
        }
      } else if (name === 'channel') {
        inChannel = true;
        curChannelId = String((node.attributes as any).id || '');
        if (curChannelId && !channelNames[curChannelId]) channelNames[curChannelId] = [];
      }
    };

    parser.ontext = (t: string) => { curText += t; };

    parser.onclosetag = (name: string) => {
      const tag = name.toLowerCase();
      if (tag === 'title' && curProg) {
        curProg.title = (curText || '').trim();
      } else if (tag === 'desc' && curProg) {
        curProg.desc = (curText || '').trim();
      } else if (tag === 'display-name' && inChannel && curChannelId) {
        const t = (curText || '').trim();
        if (t) channelNames[curChannelId].push(t);
      } else if (tag === 'channel') {
        inChannel = false;
        curChannelId = null;
      } else if (tag === 'programme') {
        if (curProg && curProg.channel && typeof curProg.start === 'number' && typeof curProg.stop === 'number') {
          const p = curProg as Programme;
          if (!byChannel[p.channel]) byChannel[p.channel] = [];
          byChannel[p.channel].push(p);
        }
        curProg = null;
      }
      curText = '';
    };

    parser.write(xml).close();

    // Build now/next per-channel with a single pass after sorting per channel (arrays are already pruned)
    const nowNext: EPGIndex['nowNext'] = {};
    for (const [ch, arr] of Object.entries(byChannel)) {
      if (arr.length > 1) arr.sort((a, b) => a.start - b.start);
      let current: Programme | undefined;
      let next: Programme | undefined;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (now >= p.start && now < p.stop) { current = p; next = arr[i + 1]; break; }
        if (p.start > now) { next = p; break; }
      }
      nowNext[ch] = { now: current, next };
    }

    // Build reverse mapping: normalized display name -> candidate tvg-ids
    const nameToIds: Record<string, string[]> = {};
    for (const [id, names] of Object.entries(channelNames)) {
      for (const nm of names) {
        const k = normalizeChannelName(nm);
        if (!k) continue;
        if (!nameToIds[k]) nameToIds[k] = [];
        if (!nameToIds[k].includes(id)) nameToIds[k].push(id);
      }
    }

    return { byChannel, nowNext, channelNames, nameToIds, updatedAt: Date.now() };
  }

  private xmltvToMs(v: string): number {
    // Formats like: 20240917 101500 +0200 or 20240917 101500 +0000, but often without spaces: 20240917101500 +0200
    // We'll parse first 14 digits and then TZ offset if present
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
    if (!m) return Date.now();
    const [_, Y, M, D, h, mnt, s, tz] = m;
    const iso = `${Y}-${M}-${D}T${h}:${mnt}:${s}`;
    const base = new Date(iso + 'Z').getTime();
    if (!tz) return base;
    const sign = tz.startsWith('-') ? -1 : 1;
    const tzh = parseInt(tz.slice(1, 3), 10);
    const tzm = parseInt(tz.slice(3, 5), 10);
    return base - sign * (tzh * 60 + tzm) * 60000; // convert local to UTC ms
  }
}

export function pickTvgIdForName(name: string, candidates: string[]): string | null {
  const norm = normalizeChannelName(name);
  // exact match preferred
  for (const c of candidates) {
    if (normalizeChannelName(c) === norm) return c;
  }
  // fallback: if numbered variants like "X 1" or "X 2", just strip the trailing index and try again
  const stripped = norm.replace(/\s+\d+$/, '');
  for (const c of candidates) {
    if (normalizeChannelName(c).replace(/\s+\d+$/, '') === stripped) return c;
  }
  return candidates[0] || null;
}
