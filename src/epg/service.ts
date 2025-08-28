import fetch from 'node-fetch';
import sax, { SAXStream, QualifiedTag } from 'sax';
import { DateTime } from 'luxon';
import cron from 'node-cron';
import { EPGIndex, EPGServiceOptions, Programme } from './types';
import { normalizeChannelName } from './nameMap';

export class EPGService {
  private url: string;
  private index: EPGIndex = { byChannel: {}, nowNext: {}, channelNames: {}, nameToIds: {}, updatedAt: 0 };
  private schedule?: any;
  private fallbackTz?: string;
  private fallbackTzFilter?: (channelId: string) => boolean;

  constructor(opts: EPGServiceOptions) {
  this.url = opts.url;
  this.fallbackTz = opts.fallbackTimeZone;
  this.fallbackTzFilter = opts.fallbackTimeZoneFilter;
    const cronSpec = opts.refreshCron || '0 */10 * * *'; // every 3 hours
    this.schedule = cron.schedule(cronSpec, () => {
      this.refresh().catch(() => {});
    }, { timezone: 'Europe/Rome' });
  }

  public getIndex(): EPGIndex { return this.index; }

  public async refresh(): Promise<void> {
    const res = await fetch(this.url, { timeout: 20000 } as any);
    if (!res.ok) throw new Error(`EPG fetch failed: ${res.status}`);
    const xml = await res.text();
    this.index = this.parse(xml);
    this.index.updatedAt = Date.now();
  }

  private parse(xml: string): EPGIndex {
    const parser = sax.parser(true, { trim: true, lowercase: true });
    const byChannel: Record<string, Programme[]> = {};
    const channelNames: Record<string, string[]> = {};

    let curProg: Partial<Programme> | null = null;
    let curTag: string | null = null;
    let curText: string = '';
    let inChannel = false;
    let curChannelId: string | null = null;

    parser.onopentag = (node: any) => {
      curTag = node.name;
      curText = '';
      if (node.name === 'programme') {
        // attributes: channel, start, stop in xmltv format: YYYYMMDDHHmmss + tz
        const ch = String((node.attributes as any).channel || '');
        const startRaw = String((node.attributes as any).start || '');
        const stopRaw = String((node.attributes as any).stop || '');
        curProg = {
          channel: ch,
          start: this.xmltvToMs(startRaw, ch),
          stop: this.xmltvToMs(stopRaw, ch),
        };
      } else if (node.name === 'channel') {
        inChannel = true;
        curChannelId = String((node.attributes as any).id || '');
        if (curChannelId && !channelNames[curChannelId]) channelNames[curChannelId] = [];
      }
    };

    parser.ontext = (t: string) => {
      curText += t;
    };

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
        if (curProg && typeof curProg.start === 'number' && typeof curProg.stop === 'number' && curProg.channel) {
          const p = curProg as Programme;
          if (!byChannel[p.channel]) byChannel[p.channel] = [];
          byChannel[p.channel].push(p);
        }
        curProg = null;
      }
      curText = '';
      curTag = null;
    };

    parser.write(xml).close();

    // Sort programmes and build now/next table
    const now = Date.now();
    const nowNext: EPGIndex['nowNext'] = {};
    for (const [ch, arr] of Object.entries(byChannel)) {
      arr.sort((a, b) => a.start - b.start);
      // find current and next
      let current: Programme | undefined;
      let next: Programme | undefined;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (now >= p.start && now < p.stop) {
          current = p;
          next = arr[i + 1];
          break;
        }
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

  private xmltvToMs(v: string, channelId?: string): number {
    // XMLTV style: 20240917101500 +0200 or 20240917101500+0200 or no offset.
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
    if (!m) return Date.now();
    const [_, Y, M, D, h, mnt, s, tz] = m;
    const baseISO = `${Y}-${M}-${D}T${h}:${mnt}:${s}`;
    if (tz) {
      // parse with explicit offset -> UTC ms
      const sign = tz.startsWith('-') ? -1 : 1;
      const tzh = parseInt(tz.slice(1, 3), 10);
      const tzm = parseInt(tz.slice(3, 5), 10);
      const offsetMinutes = sign * (tzh * 60 + tzm);
      const dt = DateTime.fromISO(baseISO, { zone: 'utc' }).minus({ minutes: offsetMinutes });
      return dt.toMillis();
    }
    // No offset provided: if configured, treat as local time in fallbackTz
    try {
      if (this.fallbackTz && (!this.fallbackTzFilter || this.fallbackTzFilter(channelId || ''))) {
        const dtLocal = DateTime.fromFormat(`${Y}${M}${D}${h}${mnt}${s}`, 'yyyyLLddHHmmss', { zone: this.fallbackTz });
        if (dtLocal.isValid) return dtLocal.toUTC().toMillis();
      }
    } catch {}
    // Fallback: interpret as UTC
    const dtUtc = DateTime.fromISO(baseISO, { zone: 'utc' });
    return (dtUtc.isValid ? dtUtc.toMillis() : Date.now());
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
