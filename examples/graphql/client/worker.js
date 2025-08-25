import { exposeWorkerRxStorage } from 'rxdb-premium/plugins/storage-worker';
import { getRxStorageIndexedDB } from 'rxdb-premium/plugins/storage-indexeddb';

exposeWorkerRxStorage({
    storage: getRxStorageIndexedDB(),
});
