import fs from "node:fs";
import path from "node:path";

export function createLogger(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function write(level, msg, extra) {
    const details = extra ? { ...extra } : undefined;
    if (details?.err) {
      const err = details.err;
      details.err = err && err.stack ? err.stack : String(err);
    }
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...details });
    console.log(line);
    try {
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5_000_000) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
      fs.appendFileSync(logPath, `${line}\n`);
    } catch (err) {
      console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "log write failed", err: String(err) }));
    }
  }

  return {
    info(msg, extra) {
      write("info", msg, extra);
    },
    warn(msg, extra) {
      write("warn", msg, extra);
    },
    error(msg, extra) {
      write("error", msg, extra);
    },
  };
}
