import assert from 'assert';
import config from './config.ts';
import {
    createRxDatabase,
    randomToken,
    RxCollection,
} from '../../plugins/core/index.mjs';

type EventDoc = {
    id: string;
    firstName: string;
    lastName: string;
    age: number;
};

type LatencyStats = {
    count: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
};

type WaveMeasure = {
    overall: LatencyStats;
    worstWave: LatencyStats & { waveIdx: number; };
};

function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sortedValues: number[], p: number): number {
    if (!sortedValues.length) {
        return 0;
    }
    const clamped = Math.max(0, Math.min(1, p));
    const idx = Math.floor(clamped * (sortedValues.length - 1));
    return sortedValues[idx];
}

function summarizeLatencies(values: number[]): LatencyStats {
    const sorted = [...values].sort((a, b) => a - b);
    const total = sorted.reduce((sum, v) => sum + v, 0);
    return {
        count: sorted.length,
        avg: sorted.length ? total / sorted.length : 0,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted[sorted.length - 1] || 0,
    };
}

function generateEvents(count: number): EventDoc[] {
    const items = new Array(count);
    for (let i = 0; i < count; i += 1) {
        items[i] = {
            id: `event-${i}-${Math.random().toString(36).slice(2, 10)}`,
            firstName: `first-${randomInt(1, 100000)}`,
            lastName: `last-${randomInt(1, 100000)}`,
            age: randomInt(0, 150),
        };
    }
    return items;
}

async function measureWaveFirstEmits(
    collection: RxCollection<EventDoc>,
): Promise<WaveMeasure> {
    const waveCount = 10;
    const subscriptionsPerWave = 120;
    const interWavePauseMs = 15;
    const allLatencies: number[] = [];
    const waveStats: (LatencyStats & { waveIdx: number; })[] = [];

    for (let waveIdx = 0; waveIdx < waveCount; waveIdx += 1) {
        const waveTasks: Promise<number>[] = [];
        for (let subIdx = 0; subIdx < subscriptionsPerWave; subIdx += 1) {
            waveTasks.push(
                new Promise((resolve, reject) => {
                    const ageStart = (waveIdx * 11 + subIdx * 3) % 120;
                    const ageEnd = ageStart + 25;
                    const start = performance.now();
                    const query = collection.find({
                        selector: {
                            age: {
                                $gte: ageStart,
                                $lte: ageEnd,
                            },
                        },
                        sort: [{ age: 'asc' }, { id: 'asc' }],
                        limit: 25,
                    });

                    const sub = query.$.subscribe({
                        next: () => {
                            const latency = performance.now() - start;
                            sub.unsubscribe();
                            resolve(latency);
                        },
                        error: (err: unknown) => {
                            sub.unsubscribe();
                            reject(err);
                        },
                    });
                }),
            );
        }

        const waveLatencies = await Promise.all(waveTasks);
        allLatencies.push(...waveLatencies);
        const waveSummary = summarizeLatencies(waveLatencies);
        waveStats.push({
            waveIdx,
            ...waveSummary,
        });

        if (waveIdx < waveCount - 1) {
            await sleep(interWavePauseMs);
        }
    }

    const overall = summarizeLatencies(allLatencies);
    const worstWave = waveStats.reduce((worst, current) =>
        current.max > worst.max ? current : worst,
    );
    return {
        overall,
        worstWave,
    };
}

async function runQueuedWriter(
    collection: RxCollection<EventDoc>,
): Promise<void> {
    const CACHE_WRITE_BULK_SIZE = 250;
    const TOTAL_BATCHES = 100;
    const records: EventDoc[] = [];
    for (let batch = 0; batch < TOTAL_BATCHES; batch += 1) {
        for (let i = 0; i < CACHE_WRITE_BULK_SIZE; i += 1) {
            const idx = batch * CACHE_WRITE_BULK_SIZE + i;
            records.push({
                id: `writer-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
                firstName: `writer-first-${idx}`,
                lastName: `writer-last-${idx}`,
                age: randomInt(0, 150),
            });
        }
    }

    let writeQueue: Promise<any> = Promise.resolve();
    const promises: Promise<void>[] = [];

    while (records.length) {
        const bulkToInsert = records.splice(0, CACHE_WRITE_BULK_SIZE);
        writeQueue = writeQueue.then(() => collection.bulkUpsert(bulkToInsert));
        promises.push(writeQueue);
    }

    await Promise.all(promises);
}

describe('subscription-under-writes-perf.test.ts', () => {
    it('should not let first subscription emissions lag far behind idle when bulkUpsert runs in queue (issue #8444)', async function () {
        this.timeout(300000);

        if (
            config.storage.name.includes('random-delay') ||
            config.storage.name === 'remote' ||
            config.storage.name === 'sqlite-trial'
        ) {
            return;
        }

        const mySchema = {
            version: 0,
            primaryKey: 'id',
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    maxLength: 100,
                },
                firstName: {
                    type: 'string',
                },
                lastName: {
                    type: 'string',
                },
                age: {
                    type: 'integer',
                    minimum: 0,
                    multipleOf: 1,
                    maximum: 150,
                },
            },
            required: ['age'],
            indexes: ['age'],
        };

        const name = randomToken(10);
        const db = await createRxDatabase({
            name,
            storage: config.storage.getStorage(),
            multiInstance: false,
        });

        const initialCount = 30000;

        try {
            const collections = await db.addCollections({
                events: {
                    schema: mySchema,
                },
            });
            const events = collections.events;

            const baseDocs = generateEvents(initialCount);
            const preload = await events.bulkInsert(baseDocs);
            assert.strictEqual(
                preload.error.length,
                0,
                'preload bulkInsert should have no errors',
            );

            const idleResult = await measureWaveFirstEmits(events);

            const writerPromise = runQueuedWriter(events);
            await sleep(20);

            const busyResult = await measureWaveFirstEmits(events);
            await writerPromise;

            const idleWorst = idleResult.worstWave;
            const busyWorst = busyResult.worstWave;
            const idleP95 = idleWorst.p95;
            const busyP95 = busyWorst.p95;
            const ratio = idleP95 > 0 ? busyP95 / idleP95 : busyP95;

            /**
             * Compare worst waves (by max latency inside the wave), not overall:
             * regressions often show up as a few slow first-emissions in one burst
             * while the rest of waves still look fine.
             */
            const maxRatio = 3;
            const maxAbsSlackMs = 400;
            assert.ok(
                busyP95 <= idleP95 * maxRatio + maxAbsSlackMs,
                `Busy worst-wave p95 (${busyP95.toFixed(2)}ms, wave#${busyWorst.waveIdx + 1}, ` +
                    `max=${busyWorst.max.toFixed(2)}ms) exceeds idle worst-wave p95 (${idleP95.toFixed(2)}ms, ` +
                    `wave#${idleWorst.waveIdx + 1}, max=${idleWorst.max.toFixed(2)}ms) by too much ` +
                    `(ratio ${ratio.toFixed(2)}, cap ratio ${maxRatio} + ${maxAbsSlackMs}ms). ` +
                    `Storage=${config.storage.name}`,
            );
        } finally {
            await db.remove();
        }
    });
});
