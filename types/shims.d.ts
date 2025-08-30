declare module 'sax' {
  const sax: any;
  export default sax;
  export type SAXStream = any;
  export type QualifiedTag = any;
}

declare module 'node-cron' {
  const cron: any;
  export default cron;
  export type ScheduledTask = any;
}

// minimal ambient to keep the TS compiler happy when Node types aren't installed
declare var process: any;
declare var __dirname: string;
declare var Buffer: any;

