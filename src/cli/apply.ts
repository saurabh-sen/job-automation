import { parseRunArgs, runAll, type RunOptions } from '../run.js';
import { errMsg } from '../utils.js';

let opts: RunOptions | undefined;
try {
  opts = parseRunArgs(process.argv.slice(2));
} catch (e) {
  console.error(errMsg(e));
  process.exitCode = 2;
}

if (opts) {
  try {
    process.exitCode = await runAll(opts);
  } catch (e) {
    console.error(`Run failed: ${errMsg(e)}`);
    process.exitCode = 1;
  }
}
