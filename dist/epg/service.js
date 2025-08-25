"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EPGService = void 0;
exports.pickTvgIdForName = pickTvgIdForName;
const node_fetch_1 = __importDefault(require("node-fetch"));
const sax_1 = __importDefault(require("sax"));
const node_cron_1 = __importDefault(require("node-cron"));
const nameMap_1 = require("./nameMap");
class EPGService {
    constructor(opts) {
        this.index = { byChannel: {}, nowNext: {}, channelNames: {}, nameToIds: {}, updatedAt: 0 };
        this.url = opts.url;
        const cronSpec = opts.refreshCron || '0 */3 * * *'; // every 3 hours
        this.schedule = node_cron_1.default.schedule(cronSpec, () => {
            this.refresh().catch(() => { });
        }, { timezone: 'Europe/Rome' });
    }
    getIndex() { return this.index; }
    async refresh() {
        const res = await (0, node_fetch_1.default)(this.url, { timeout: 20000 });
        if (!res.ok)
            throw new Error(`EPG fetch failed: ${res.status}`);
        const xml = await res.text();
        this.index = this.parse(xml);
        this.index.updatedAt = Date.now();
    }
    parse(xml) {
        const parser = sax_1.default.parser(true, { trim: true, lowercase: true });
        const byChannel = {};
        const channelNames = {};
        let curProg = null;
        let curTag = null;
        let curText = '';
        let inChannel = false;
        let curChannelId = null;
        parser.onopentag = (node) => {
            curTag = node.name;
            curText = '';
            if (node.name === 'programme') {
                // attributes: channel, start, stop in xmltv format: YYYYMMDDHHmmss + tz
                const ch = String(node.attributes.channel || '');
                const startRaw = String(node.attributes.start || '');
                const stopRaw = String(node.attributes.stop || '');
                curProg = {
                    channel: ch,
                    start: this.xmltvToMs(startRaw),
                    stop: this.xmltvToMs(stopRaw),
                };
            }
            else if (node.name === 'channel') {
                inChannel = true;
                curChannelId = String(node.attributes.id || '');
                if (curChannelId && !channelNames[curChannelId])
                    channelNames[curChannelId] = [];
            }
        };
        parser.ontext = (t) => {
            curText += t;
        };
        parser.onclosetag = (name) => {
            const tag = name.toLowerCase();
            if (tag === 'title' && curProg) {
                curProg.title = (curText || '').trim();
            }
            else if (tag === 'desc' && curProg) {
                curProg.desc = (curText || '').trim();
            }
            else if (tag === 'display-name' && inChannel && curChannelId) {
                const t = (curText || '').trim();
                if (t)
                    channelNames[curChannelId].push(t);
            }
            else if (tag === 'channel') {
                inChannel = false;
                curChannelId = null;
            }
            else if (tag === 'programme') {
                if (curProg && typeof curProg.start === 'number' && typeof curProg.stop === 'number' && curProg.channel) {
                    const p = curProg;
                    if (!byChannel[p.channel])
                        byChannel[p.channel] = [];
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
        const nowNext = {};
        for (const [ch, arr] of Object.entries(byChannel)) {
            arr.sort((a, b) => a.start - b.start);
            // find current and next
            let current;
            let next;
            for (let i = 0; i < arr.length; i++) {
                const p = arr[i];
                if (now >= p.start && now < p.stop) {
                    current = p;
                    next = arr[i + 1];
                    break;
                }
                if (p.start > now) {
                    next = p;
                    break;
                }
            }
            nowNext[ch] = { now: current, next };
        }
        // Build reverse mapping: normalized display name -> candidate tvg-ids
        const nameToIds = {};
        for (const [id, names] of Object.entries(channelNames)) {
            for (const nm of names) {
                const k = (0, nameMap_1.normalizeChannelName)(nm);
                if (!k)
                    continue;
                if (!nameToIds[k])
                    nameToIds[k] = [];
                if (!nameToIds[k].includes(id))
                    nameToIds[k].push(id);
            }
        }
        return { byChannel, nowNext, channelNames, nameToIds, updatedAt: Date.now() };
    }
    xmltvToMs(v) {
        // Formats like: 20240917 101500 +0200 or 20240917 101500 +0000, but often without spaces: 20240917101500 +0200
        // We'll parse first 14 digits and then TZ offset if present
        const m = v.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/);
        if (!m)
            return Date.now();
        const [_, Y, M, D, h, mnt, s, tz] = m;
        const iso = `${Y}-${M}-${D}T${h}:${mnt}:${s}`;
        const base = new Date(iso + 'Z').getTime();
        if (!tz)
            return base;
        const sign = tz.startsWith('-') ? -1 : 1;
        const tzh = parseInt(tz.slice(1, 3), 10);
        const tzm = parseInt(tz.slice(3, 5), 10);
        return base - sign * (tzh * 60 + tzm) * 60000; // convert local to UTC ms
    }
}
exports.EPGService = EPGService;
function pickTvgIdForName(name, candidates) {
    const norm = (0, nameMap_1.normalizeChannelName)(name);
    // exact match preferred
    for (const c of candidates) {
        if ((0, nameMap_1.normalizeChannelName)(c) === norm)
            return c;
    }
    // fallback: if numbered variants like "X 1" or "X 2", just strip the trailing index and try again
    const stripped = norm.replace(/\s+\d+$/, '');
    for (const c of candidates) {
        if ((0, nameMap_1.normalizeChannelName)(c).replace(/\s+\d+$/, '') === stripped)
            return c;
    }
    return candidates[0] || null;
}
