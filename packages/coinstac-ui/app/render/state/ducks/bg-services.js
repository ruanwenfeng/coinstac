import app from 'ampersand-app';
import { applyAsyncLoading } from './loading';
import { updateConsortia } from './consortia';
import { updateComputations } from './computations';
import { updateProjectStatus } from './projects';
import cloneDeep from 'lodash/cloneDeep';

import {
  computationCompleteNotification,
  computationStartNotification,
  getRunEndNotifier,
  getRunErrorNotifier,
} from '../../utils/notifications';

export const listenToConsortia = (tia) => {
  app.core.pool.listenToConsortia(tia);
};

export const unlistenToConsortia = (tiaIds) => {
  app.core.pool.unlistenToConsortia(tiaIds);
};

/**
 * Joins a computation for which the user was not the initiator on
 * but has a project that should be run on that computation
 *
 * @param {Object} consortium PouchDB document representing consortium
 * @param {string} consortium._id
 * @return {Promise}
 */
export const joinSlaveComputation = (consortium) => {
  return Promise.all([
    /**
     * @todo coinstac-storage-proxy doesn't allow GET requests to
     * `local-consortium-*` databases. Figure out another approach.
     */
    app.core.dbRegistry.get(`local-consortium-${consortium._id}`).all(),
    app.core.dbRegistry.get(`remote-consortium-${consortium._id}`).find({
      selector: {
        complete: false,
      },
    }),
  ])
    .then(([localDocs, remoteDocs]) => {
      const { username } = app.core.auth.getUser();
      const userRunIds = localDocs.reduce((memo, { _id }) => {
        return _id.indexOf(username) > -1 ?
          memo.concat(_id.replace(`-${username}`, '')) :
          memo;
      }, []);

      // filter out already ran (by user) computations
      // done here as find() can't use $nin on _id
      /**
       * @todo This assumes a one-to-one relationship between run IDs and
       * consortium IDs. The approach should change when a consortium
       * permits multiple simultaneous runs.
       */
      const runs = new Map(
        remoteDocs.reduce((memo, { _id: runId, consortiumId }) => {
          return userRunIds.indexOf(runId) < 0 ?
            [...memo, [consortiumId, runId]] :
            memo;
        }, [])
      );

      return Promise.all([
        runs,
        app.core.dbRegistry.get('projects').find({
          selector: {
            consortiumId: {
              $in: Array.from(runs.keys()),
            },
          },
        }),
      ]);
    })
    .then(([runs, projects]) => Promise.all(
      projects.map(({ _id, consortiumId }) => {
        const runId = runs.get(consortiumId);

        if (!runId) {
          throw new Error(`No run ID for consortium ${consortiumId}`);
        }

        const onRunEnd = getRunEndNotifier(consortium);
        const onRunError = getRunErrorNotifier(consortium);

        computationStartNotification(consortium);
        app.core.pool.events.on('run:end', onRunEnd);
        app.core.pool.events.on('error', onRunError);
        app.core.pool.events.once('computation:complete', () => {
          computationCompleteNotification(consortium);
          app.core.pool.events.removeListener('run:end', onRunEnd);
          app.core.pool.events.removeListener('error', onRunError);
        });

        return app.core.computations.joinRun({
          consortiumId,
          projectId: _id,
          runId,
        });
      })
    ));
};

export const addConsortiumComputationListener = (consortium) => {
  return app.core.dbRegistry.get(`remote-consortium-${consortium._id}`)
  .syncEmitter.on('change', () => {
    joinSlaveComputation(consortium);
  });
};

/**
* Sets up the COINSTAC environment once a user is authorized (hence "Private"
* in initPrivateBackgroundServices).  Primarily, this instantiates a
* LocalPipelineRunnerPool kickoff new and existing computation runs
* @returns {function}
*/
export const initPrivateBackgroundServices = applyAsyncLoading(
  function initPrivateBackgroundServices() {
    return (dispatch) => { // eslint-disable-line
      // set background event listeners
      // @NOTE: "change" document shape differences in computations & consortia attributed
      // to different replication configs (e.g. sync both dirs vs sync on dir)
      const tiaDB = app.core.dbRegistry.get('consortia');
      tiaDB.syncEmitter.on('change', (change) => {
        const toUpdate = change.change.docs.map((changed) => {
          const cloned = cloneDeep(changed); // de-ref main memory
          delete cloned._revisions; // gross. pouchy maybe can save the day?
          return cloned;
        });
        updateConsortia({ dispatch, toUpdate, isBg: true });
      });
      const compsDB = app.core.dbRegistry.get('computations');
      compsDB.syncEmitter.on('change', (change) => {
        const toUpdate = change.docs.map((changed) => {
          const cloned = cloneDeep(changed); // de-ref main memory
          delete cloned._revisions; // gross. pouchy maybe can save the day?
          return cloned;
        });
        updateComputations({ dispatch, toUpdate, isBg: true });
      });
      const appUser = app.core.auth.getUser().username;
      app.core.consortia.getUserConsortia(appUser)
      .then(userConsortia => {
        userConsortia.forEach(consortium => {
          // this is called twice, once on startup
          // second time inside change listener
          joinSlaveComputation(consortium);
          addConsortiumComputationListener(consortium);
        });
      });

      /**
       * Listen to project changes and update the renderer's state tree.
       *
       * @todo Refactor into service? Something?
       */
      app.core.projects.initializeListeners((error, { doc, projectId }) => {
        let status;

        if (error) {
          app.logger.error(error);
          app.notifications.push({
            level: 'error',
            message: `Project listener error: ${error.message}`,
          });

          // TODO: attempt to recover?
          throw error;
        }

        if (doc.userErrors.length) {
          status = 'error';
        } else if (doc.complete) {
          status = 'complete';
        } else {
          status = 'active';
        }

        dispatch(updateProjectStatus({ id: projectId, status }));
      });

      return Promise.all([
        tiaDB.all().then((docs) => updateConsortia({ dispatch, toUpdate: docs, isBg: true })),
        compsDB.all().then((docs) => updateComputations({ dispatch, toUpdate: docs, isBg: true })),
      ]);
    };
  }
);

export const teardownPrivateBackgroundServices = applyAsyncLoading(
  function teardownPrivateBackgroundServices() {
    return (dispatch) => app.core.teardown(); // eslint-disable-line
  }
);

/**
 * Run a computation.
 *
 * @param {string} consortiumId Target consortium's ID. coinstac-client-core
 * uses this to determine the computation to run.
 * @param {string} projectId User's project's ID.  coinstac-client-core uses
 * this to retrieve the user's project from the dbRegistry.
 * @returns {Promise}
 */
export const runComputation = applyAsyncLoading(
  function runComputationBackgroundService({ consortiumId, projectId }) {
    return dispatch => {
      // Unfortunately, requires we `get` the document for its label
      app.core.dbRegistry.get('consortia').get(consortiumId)
        .then(consortium => {
          const onRunEnd = getRunEndNotifier(consortium);
          const onRunError = getRunErrorNotifier(consortium);

          computationStartNotification(consortium);
          app.core.pool.events.on('run:end', onRunEnd);
          app.core.pool.events.on('error', onRunError);
          app.core.pool.events.once('computation:complete', () => {
            computationCompleteNotification(consortium);
            app.core.pool.events.removeListener('run:end', onRunEnd);
            app.core.pool.events.removeListener('error', onRunError);
          });

          return app.core.computations.kickoff({ consortiumId, projectId });
        });
    };
  }
);