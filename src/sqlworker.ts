import { Database } from "./database";
import { parentPort, workerData } from "node:worker_threads";
import { msToHuman } from "./utils";
// import {setTimeout} from "node:timers/promises";

if (!workerData.id) throw new Error("Missing worker data parameter: id");
if (!workerData.name) throw new Error("Missing worker data parameter: name");
if (!workerData.dbpath) throw new Error("Missing worker data parameter: dbpath");
if (!workerData.query) throw new Error("Missing worker data parameter: query");

const LP = `(${workerData.name}#${workerData.id})`; // Log prefix
class logger {
    static output(level, logmsg) {
        const message = `${LP} ${logmsg}`;
        parentPort?.postMessage({
            type: "log",
            level,
            data: message,
        });
    }

    // remap our standart levels to solar logger levels
    static fatal = (msg) => this.output("emergency", msg);
    static error = (msg) => this.output("error", msg);
    static warn  = (msg) => this.output("critical", msg);
    static info  = (msg) => this.output("info", msg);
    static log   = (msg) => this.output("info", msg);
    static debug = (msg) => this.output("debug", msg);
    static trace = (msg) => this.output("debug", msg);
}

/**
 * Initialize worker
 */
async function run() {
    // connect to database
    // logger.trace(`connecting to database...`);
    try {
        const sqlite = new Database().init(workerData.dbpath);
        // logger.trace(`running SQL query...`);
        const result = sqlite.prepare(workerData.query).all();
        parentPort?.postMessage({ type: "result", data: result });
    }
    catch (err) {
        throw new Error(`database connection or query execution failed! Error: ${err.stack}`);
    }
}

logger.trace(`starting task...`);
const tick0 = Date.now();
try {
    run();
    logger.trace(`task completed ${msToHuman(Date.now() - tick0)}`);
    process.exit(0);

}
catch(err) {
    throw new Error(err);
};
