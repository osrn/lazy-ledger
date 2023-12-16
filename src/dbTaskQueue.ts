import { ObjectId } from "bson";
import { Worker } from "node:worker_threads";
import os from "os";
import { Contracts } from "@solar-network/kernel";
import { IQueueItem, IWorkerJob } from "./interfaces";

// @Container.injectable()
export class DbTaskQueue {
    // @Container.inject(Container.Identifiers.LogService) 
    private readonly logger!: Contracts.Kernel.Logger;

    private workers: any = [];
    private queue: IQueueItem[] = new Array<IQueueItem>();
    private dbpath!: string;

    public constructor(dbpath: string, maxWorkers: number, logger: Contracts.Kernel.Logger) {
        this.logger = logger;
        this.dbpath = dbpath;
        maxWorkers = Math.min(os.cpus().length, maxWorkers);
        // spawn workers
        for (let i = 1; i <= maxWorkers; i++ ) {
            this.spawn(i)
        }
    }

    private spawn(workerNo: number) {
        const workerId = new ObjectId().toHexString();
        const workerName = `dbworker${workerNo}`;
        this.logger.debug(`(LL) Spawning database worker ${workerName}#${workerId}`);
        
        const worker = new Worker(`${__dirname}/dbworker.js`, {
            workerData: { id: workerId, name: workerName, dbpath: this.dbpath },
        });
        let currentTask: IQueueItem|undefined;
        let error: Error|undefined;

        const takeWork = () => {
            if (!currentTask && this.queue.length) {
                // If there's a job in the queue, send it to the worker
                currentTask = this.queue.shift();
                worker.postMessage({type: "run", data: currentTask?.job});
            }
        }

        worker
            .on('online', () => {
                this.logger.debug(`(LL) ${workerName}#${workerId} is online now`);
                this.workers.push({ takeWork });
                takeWork();
            })
            .on('message', (message) => {
                if (message.type === "log") {
                    if (!message.level) message.level = "debug";
                    this.logger[message.level](`(LL)${message.data}`);
                }
                else if (message.type === "result") {
                    // this.logger.debug(`${workerName}#${workerId} returned result:${message.data}`);
                    const result = message.data;
                    currentTask?.resolve(result);
                    currentTask = undefined;
                    takeWork(); // Check if there's more work to do
                }
            })
            .on('error', (err) => {
                this.logger.error(err);
                error = err;
            })
            .on('exit', (code) => {
                this.workers = this.workers.filter(w => w.takeWork !== takeWork);
                if (currentTask) {
                    console.log(error);
                }
                if (code !== 0) {
                    // Worker died, so respawn
                    this.logger.error(`${workerName}#${workerId} died with code ${code}`);
                    currentTask?.reject(error || new Error(`${workerName}#${workerId} died`));
                    this.spawn(workerNo); 
                }
            });
    }

    private drainQueue() {
        for (const worker of this.workers) {
            worker.takeWork();
        }
    }

    public addTask(job: IWorkerJob) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                resolve,
                reject,
                job,
            });
            this.drainQueue();
        });
        
    }
}

