"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.startReplicationDownstream = startReplicationDownstream;
var _rxjs = require("rxjs");
var _rxError = require("../rx-error.js");
var _rxStorageHelper = require("../rx-storage-helper.js");
var _index = require("../plugins/utils/index.js");
var _checkpoint = require("./checkpoint.js");
var _helper = require("./helper.js");
var _metaInstance = require("./meta-instance.js");
/**
 * Writes all documents from the master to the fork.
 * The downstream has two operation modes
 * - Sync by iterating over the checkpoints via downstreamResyncOnce()
 * - Sync by listening to the changestream via downstreamProcessChanges()
 * We need this to be able to do initial syncs
 * and still can have fast event based sync when the client is not offline.
 */
async function startReplicationDownstream(state) {
  console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: startReplicationDownstream: ", state);
  if (state.input.initialCheckpoint && state.input.initialCheckpoint.downstream) {
    var checkpointDoc = await (0, _checkpoint.getLastCheckpointDoc)(state, 'down');
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: startReplicationDownstream checkpointDoc: ", checkpointDoc);
    if (!checkpointDoc) {
      await (0, _checkpoint.setCheckpoint)(state, 'down', state.input.initialCheckpoint.downstream);
    }
  }
  var identifierHash = await state.input.hashFunction(state.input.identifier);
  var replicationHandler = state.input.replicationHandler;

  // used to detect which tasks etc can in it at which order.
  var timer = 0;
  var openTasks = [];
  function addNewTask(task) {
    state.stats.down.addNewTask = state.stats.down.addNewTask + 1;
    var taskWithTime = {
      time: timer++,
      task
    };
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask: ", taskWithTime);
    openTasks.push(taskWithTime);
    state.streamQueue.down = state.streamQueue.down.then(() => {
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask state.streamQueue openTasks: ", openTasks);
      var useTasks = [];
      while (openTasks.length > 0) {
        state.events.active.down.next(true);
        var innerTaskWithTime = (0, _index.ensureNotFalsy)(openTasks.shift());

        /**
         * If the task came in before the last time we started the pull
         * from the master, then we can drop the task.
         */
        if (innerTaskWithTime.time < lastTimeMasterChangesRequested) {
          continue;
        }
        if (innerTaskWithTime.task === 'RESYNC') {
          if (useTasks.length === 0) {
            useTasks.push(innerTaskWithTime.task);
            break;
          } else {
            break;
          }
        }
        useTasks.push(innerTaskWithTime.task);
      }
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask state.streamQueue useTasks: ", useTasks);
      if (useTasks.length === 0) {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask no tasks, returning: ");
        return;
      }
      if (useTasks[0] === 'RESYNC') {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask RESYNC: ", useTasks);
        return downstreamResyncOnce();
      } else {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask() downstreamProcessChanges() : ", useTasks);
        return downstreamProcessChanges(useTasks);
      }
    }).then(() => {
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask() state.events.active.down: false : ");
      state.events.active.down.next(false);
      if (!state.firstSyncDone.down.getValue() && !state.events.canceled.getValue()) {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: addNewTask() state.firstSyncDone.down: true : ");
        state.firstSyncDone.down.next(true);
      }
    });
  }
  addNewTask('RESYNC');

  /**
   * If a write on the master happens, we have to trigger the downstream.
   * Only do this if not canceled yet, otherwise firstValueFrom errors
   * when running on a completed observable.
   */
  if (!state.events.canceled.getValue()) {
    var sub = replicationHandler.masterChangeStream$.pipe((0, _rxjs.mergeMap)(async ev => {
      /**
       * While a push is running, we have to delay all incoming
       * events from the server to not mix up the replication state.
       */
      await (0, _rxjs.firstValueFrom)(state.events.active.up.pipe((0, _rxjs.filter)(s => !s)));
      return ev;
    })).subscribe(task => {
      state.stats.down.masterChangeStreamEmit = state.stats.down.masterChangeStreamEmit + 1;
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: replicationHandler.masterChangeStream$ addNewTask() task: ", task);
      addNewTask(task);
    });
    // unsubscribe when replication is canceled
    (0, _rxjs.firstValueFrom)(state.events.canceled.pipe((0, _rxjs.filter)(canceled => !!canceled))).then(() => {
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: state.events.canceled got cancelled true: ");
      return sub.unsubscribe();
    });
  }

  /**
   * For faster performance, we directly start each write
   * and then await all writes at the end.
   */
  var lastTimeMasterChangesRequested = -1;
  async function downstreamResyncOnce() {
    state.stats.down.downstreamResyncOnce = state.stats.down.downstreamResyncOnce + 1;
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamResyncOnce() start: ", lastTimeMasterChangesRequested);
    if (state.events.canceled.getValue()) {
      return;
    }
    state.checkpointQueue = state.checkpointQueue.then(() => (0, _checkpoint.getLastCheckpointDoc)(state, 'down'));
    var lastCheckpoint = await state.checkpointQueue;
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamResyncOnce() lastCheckpoint: ", lastCheckpoint);
    var promises = [];
    while (!state.events.canceled.getValue()) {
      lastTimeMasterChangesRequested = timer++;
      var downResult = await replicationHandler.masterChangesSince(lastCheckpoint, state.input.pullBatchSize);
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamResyncOnce() loop downResult: ", downResult);
      if (downResult.documents.length === 0) {
        break;
      }
      lastCheckpoint = (0, _rxStorageHelper.stackCheckpoints)([lastCheckpoint, downResult.checkpoint]);
      console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamResyncOnce() loop lastCheckpoint: ", lastCheckpoint);
      promises.push(persistFromMaster(downResult.documents, lastCheckpoint));

      /**
       * By definition we stop pull when the pulled documents
       * do not fill up the pullBatchSize because we
       * can assume that the remote has no more documents.
       */
      if (downResult.documents.length < state.input.pullBatchSize) {
        break;
      }
    }
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamResyncOnce() awaiting all the downResults");
    await Promise.all(promises);
  }
  function downstreamProcessChanges(tasks) {
    state.stats.down.downstreamProcessChanges = state.stats.down.downstreamProcessChanges + 1;
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamProcessChanges() start: ", state.stats.down.downstreamProcessChanges);
    var docsOfAllTasks = [];
    var lastCheckpoint = null;
    tasks.forEach(task => {
      if (task === 'RESYNC') {
        throw new Error('SNH');
      }
      (0, _index.appendToArray)(docsOfAllTasks, task.documents);
      lastCheckpoint = (0, _rxStorageHelper.stackCheckpoints)([lastCheckpoint, task.checkpoint]);
    });
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: downstreamProcessChanges() persistFromMaster(): ", docsOfAllTasks, lastCheckpoint);
    return persistFromMaster(docsOfAllTasks, (0, _index.ensureNotFalsy)(lastCheckpoint));
  }

  /**
   * It can happen that the calls to masterChangesSince() or the changeStream()
   * are way faster then how fast the documents can be persisted.
   * Therefore we merge all incoming downResults into the nonPersistedFromMaster object
   * and process them together if possible.
   * This often bundles up single writes and improves performance
   * by processing the documents in bulks.
   */
  var persistenceQueue = _index.PROMISE_RESOLVE_VOID;
  var nonPersistedFromMaster = {
    docs: {}
  };
  function persistFromMaster(docs, checkpoint) {
    var primaryPath = state.primaryPath;
    state.stats.down.persistFromMaster = state.stats.down.persistFromMaster + 1;
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: persistFromMaster() start: ", state.stats.down.persistFromMaster);

    /**
     * Add the new docs to the non-persistent list
     */
    docs.forEach(docData => {
      var docId = docData[primaryPath];
      nonPersistedFromMaster.docs[docId] = docData;
    });
    nonPersistedFromMaster.checkpoint = checkpoint;

    /**
     * Run in the queue
     * with all open documents from nonPersistedFromMaster.
     */
    console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: persistFromMaster() nonPersistedFromMaster: ", nonPersistedFromMaster);
    persistenceQueue = persistenceQueue.then(() => {
      var downDocsById = nonPersistedFromMaster.docs;
      nonPersistedFromMaster.docs = {};
      var useCheckpoint = nonPersistedFromMaster.checkpoint;
      var docIds = Object.keys(downDocsById);
      if (state.events.canceled.getValue() || docIds.length === 0) {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: persistFromMaster() persistenceQueue no docs to write");
        return _index.PROMISE_RESOLVE_VOID;
      }
      var writeRowsToFork = [];
      var writeRowsToForkById = {};
      var writeRowsToMeta = {};
      var useMetaWriteRows = [];
      return Promise.all([state.input.forkInstance.findDocumentsById(docIds, true), (0, _metaInstance.getAssumedMasterState)(state, docIds)]).then(([currentForkStateList, assumedMasterState]) => {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: persistFromMaster() persistenceQueue currentForkStateList: ", currentForkStateList);
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: persistFromMaster() persistenceQueue assumedMasterState: ", assumedMasterState);
        var currentForkState = new Map();
        currentForkStateList.forEach(doc => currentForkState.set(doc[primaryPath], doc));
        return Promise.all(docIds.map(async docId => {
          var forkStateFullDoc = currentForkState.get(docId);
          var forkStateDocData = forkStateFullDoc ? (0, _helper.writeDocToDocState)(forkStateFullDoc, state.hasAttachments, false) : undefined;
          var masterState = downDocsById[docId];
          var assumedMaster = assumedMasterState[docId];
          if (assumedMaster && forkStateFullDoc && assumedMaster.metaDocument.isResolvedConflict === forkStateFullDoc._rev) {
            /**
             * The current fork state represents a resolved conflict
             * that first must be send to the master in the upstream.
             * All conflicts are resolved by the upstream.
             */
            // return PROMISE_RESOLVE_VOID;
            await state.streamQueue.up;
          }
          var isAssumedMasterEqualToForkState = !assumedMaster || !forkStateDocData ? false : state.input.conflictHandler.isEqual(assumedMaster.docData, forkStateDocData, 'downstream-check-if-equal-0');
          if (!isAssumedMasterEqualToForkState && assumedMaster && assumedMaster.docData._rev && forkStateFullDoc && forkStateFullDoc._meta[state.input.identifier] && (0, _index.getHeightOfRevision)(forkStateFullDoc._rev) === forkStateFullDoc._meta[state.input.identifier]) {
            isAssumedMasterEqualToForkState = true;
          }
          if (forkStateFullDoc && assumedMaster && isAssumedMasterEqualToForkState === false || forkStateFullDoc && !assumedMaster) {
            /**
             * We have a non-upstream-replicated
             * local write to the fork.
             * This means we ignore the downstream of this document
             * because anyway the upstream will first resolve the conflict.
             */
            return _index.PROMISE_RESOLVE_VOID;
          }
          var areStatesExactlyEqual = !forkStateDocData ? false : state.input.conflictHandler.isEqual(masterState, forkStateDocData, 'downstream-check-if-equal-1');
          if (forkStateDocData && areStatesExactlyEqual) {
            /**
             * Document states are exactly equal.
             * This can happen when the replication is shut down
             * unexpected like when the user goes offline.
             *
             * Only when the assumedMaster is different from the forkState,
             * we have to patch the document in the meta instance.
             */
            if (!assumedMaster || isAssumedMasterEqualToForkState === false) {
              useMetaWriteRows.push(await (0, _metaInstance.getMetaWriteRow)(state, forkStateDocData, assumedMaster ? assumedMaster.metaDocument : undefined));
            }
            return _index.PROMISE_RESOLVE_VOID;
          }

          /**
           * All other master states need to be written to the forkInstance
           * and metaInstance.
           */
          var newForkState = Object.assign({}, masterState, forkStateFullDoc ? {
            _meta: (0, _index.flatClone)(forkStateFullDoc._meta),
            _attachments: state.hasAttachments && masterState._attachments ? masterState._attachments : {},
            _rev: (0, _index.getDefaultRevision)()
          } : {
            _meta: {
              lwt: (0, _index.now)()
            },
            _rev: (0, _index.getDefaultRevision)(),
            _attachments: state.hasAttachments && masterState._attachments ? masterState._attachments : {}
          });
          /**
           * If the remote works with revisions,
           * we store the height of the next fork-state revision
           * inside of the documents meta data.
           * By doing so we can filter it out in the upstream
           * and detect the document as being equal to master or not.
           * This is used for example in the CouchDB replication plugin.
           */
          if (masterState._rev) {
            var nextRevisionHeight = !forkStateFullDoc ? 1 : (0, _index.getHeightOfRevision)(forkStateFullDoc._rev) + 1;
            newForkState._meta[state.input.identifier] = nextRevisionHeight;
            if (state.input.keepMeta) {
              newForkState._rev = masterState._rev;
            }
          }
          if (state.input.keepMeta && masterState._meta) {
            newForkState._meta = masterState._meta;
          }
          var forkWriteRow = {
            previous: forkStateFullDoc,
            document: newForkState
          };
          forkWriteRow.document._rev = forkWriteRow.document._rev ? forkWriteRow.document._rev : (0, _index.createRevision)(identifierHash, forkWriteRow.previous);
          writeRowsToFork.push(forkWriteRow);
          writeRowsToForkById[docId] = forkWriteRow;
          writeRowsToMeta[docId] = await (0, _metaInstance.getMetaWriteRow)(state, masterState, assumedMaster ? assumedMaster.metaDocument : undefined);
        }));
      }).then(async () => {
        console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: persistFromMaster() persistenceQueue then writeRowsToFork: ", writeRowsToFork);
        if (writeRowsToFork.length > 0) {
          return state.input.forkInstance.bulkWrite(writeRowsToFork, await state.downstreamBulkWriteFlag).then(forkWriteResult => {
            console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: forkInstance bulkWrite: ", forkWriteResult);
            var success = (0, _rxStorageHelper.getWrittenDocumentsFromBulkWriteResponse)(state.primaryPath, writeRowsToFork, forkWriteResult);
            success.forEach(doc => {
              var docId = doc[primaryPath];
              state.events.processed.down.next(writeRowsToForkById[docId]);
              useMetaWriteRows.push(writeRowsToMeta[docId]);
            });
            var mustThrow;
            forkWriteResult.error.forEach(error => {
              /**
               * We do not have to care about downstream conflict errors here
               * because on conflict, it will be solved locally and result in another write.
               */
              if (error.status === 409) {
                return;
              }
              // other non-conflict errors must be handled
              var throwMe = (0, _rxError.newRxError)('RC_PULL', {
                writeError: error
              });
              state.events.error.next(throwMe);
              mustThrow = throwMe;
            });
            if (mustThrow) {
              throw mustThrow;
            }
          });
        }
      }).then(() => {
        if (useMetaWriteRows.length > 0) {
          return state.input.metaInstance.bulkWrite((0, _helper.stripAttachmentsDataFromMetaWriteRows)(state, useMetaWriteRows), 'replication-down-write-meta').then(metaWriteResult => {
            console.log("[RXDB_" + state.input.forkInstance.collectionName + "_DOWNSTREAM]: metaInstance bulkWrite: ", metaWriteResult);
            metaWriteResult.error.forEach(writeError => {
              state.events.error.next((0, _rxError.newRxError)('RC_PULL', {
                id: writeError.documentId,
                writeError
              }));
            });
          });
        }
      }).then(() => {
        /**
         * For better performance we do not await checkpoint writes,
         * but to ensure order on parallel checkpoint writes,
         * we have to use a queue.
         */
        (0, _checkpoint.setCheckpoint)(state, 'down', useCheckpoint);
      });
    }).catch(unhandledError => state.events.error.next(unhandledError));
    return persistenceQueue;
  }
}
//# sourceMappingURL=downstream.js.map