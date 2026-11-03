import type { Config } from "../config.js";
import type { Db } from "../db/db.js";
import type { SessionSettings } from "../auth/sessions.js";
import type { Throttle } from "../auth/throttle.js";

export interface AppContext {
  db: Db;
  config: Config;
  sessions: SessionSettings;
  loginThrottle: Throttle;
  emailThrottle: Throttle;
  registerThrottle: Throttle;
  /** Injectable clock: every deadline/availability decision goes through it (tests move it). */
  now: () => Date;
}
