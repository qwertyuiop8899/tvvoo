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

declare module 'node-fetch' {
  const fetch: any;
  export default fetch;
}

// Node ambient globals and core module shims (minimal)
declare var process: any;
declare var __dirname: string;
declare var Buffer: any;
declare var require: any;
declare var module: any;

declare module 'fs' { const x: any; export = x; }
declare module 'path' { const x: any; export = x; }
declare module 'express' {
  const e: any;
  export = e;
  export type Request = any;
  export type Response = any;
  export type NextFunction = any;
}
