export interface Programme {
  channel: string; // tvg-id
  start: number;   // epoch ms
  stop: number;    // epoch ms
  title?: string;
  desc?: string;
}

export interface ChannelNameMap {
  // map of normalized channel name variants -> tvg-id
  [normalizedName: string]: string;
}

export interface EPGIndex {
  // channel id -> programmes sorted by start
  byChannel: Record<string, Programme[]>;
  // quick lookup for now/next by channel
  nowNext: Record<string, { now?: Programme; next?: Programme }>;
  // channel id -> list of display-names from <channel>
  channelNames: Record<string, string[]>;
  // normalized name -> list of channel ids (for reverse lookup)
  nameToIds: Record<string, string[]>;
  // last refresh timestamp
  updatedAt: number;
}

export interface EPGServiceOptions {
  url: string; // XMLTV url
  refreshCron?: string; // cron schedule (default: every 3h)
  // If XMLTV times come without explicit timezone, convert as if they are in this timezone
  fallbackTimeZone?: string; // e.g., 'Europe/Rome'
  // Decide for which channel ids the fallbackTimeZone applies (e.g., only Italian channels)
  fallbackTimeZoneFilter?: (channelId: string) => boolean;
}
