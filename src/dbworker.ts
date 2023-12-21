import { parentPort, workerData } from "node:worker_threads";
// import {setTimeout} from "node:timers/promises";
import SQLite3 from "better-sqlite3";
import { Database } from "./database";
import { msToHuman } from "./utils";
import { IWorkerJob } from "./interfaces";

if (!workerData.id) throw new Error("Missing worker data parameter: id");
if (!workerData.name) throw new Error("Missing worker data parameter: name");
if (!workerData.dbpath) throw new Error("Missing worker data parameter: dbpath");
// if (!workerData.query) throw new Error("Missing worker data parameter: query");

let sqlite: SQLite3.Database;

const LP = `[${workerData.name}#${workerData.id}]`; // Log prefix
class logger {
    static output(level: string, logmsg: string) {
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
function init() {
    // logger.trace(`connecting to database...`);
    try {
        sqlite = new Database().init(workerData.dbpath);
    }
    catch (err) {
        throw new Error(`database connection failed! Error: ${err.stack}`);
    }

}

/**
 * Run worker
 */
function run(query: string) {
    // logger.trace(`running the sql query...`);
    if (!query || query.length === 0) throw new Error(`empty string passed for query`);
    if (!sqlite) throw new Error(`database connection is not initialized`);
    try {
        let queries = query.replace(/\n/g,'') // strip line breaks
                           .replace(/;$/,'') // strip the last ; if exist, to prevent the last array element being empty when split
                           .split(";"); // split into individual SQL statements
        if (queries.length > 1) {
            // passed query contains multiple SQL statements
            logger.trace(`received a multi statement query of (${queries.length} statements)`);
            let i=1;
            for (const q of queries) {
                logger.trace(`running ${i}/${queries.length}: ${q}`);
                const result = sqlite.prepare(q).run();
                logger.trace(`${i}/${queries.length} result: ${JSON.stringify(result)}`);
                i++;
            }
            parentPort?.postMessage({ type: "result", data: "" });
        }
        else {
            const result = sqlite.prepare(query).all();
            parentPort?.postMessage({ type: "result", data: result });
        }
    }
    catch (err) {
        throw new Error(`execution of query ${query} failed! Error: ${err.stack}`);
    }
}

try {
    init();
    logger.debug("initialized");
    parentPort?.on('message', (message) => {
        if (message.type === 'run') {
            const job: IWorkerJob = message.data;
            logger.trace(`starting job ${job.customer}#${job.id}`);
            const tick0 = Date.now();
            try {
                run(job.data);
                logger.trace(`job ${job.customer}#${job.id} completed in ${msToHuman(Date.now() - tick0)}`);
            }
            catch(err) {
                throw new Error(err);
            };
        }
        else if (message.type === 'stop') {
            logger.log("received stop");
            process.exit(0);
        
        }
        else {
            logger.log("command unknown");
        }
    });
}
catch(err) {
    throw new Error(err);
};
