/**
 * Main process entry point.
 *
 * This script runs boot scripts in order, wiring up Electron's main process and
 * kicking off the render process (UI).
 */

'use strict';

require('trace');
require('clarify');

Error.stackTraceLimit = 100;

const { compact } = require('lodash'); // eslint-disable-line no-unused-vars
const electron = require('electron');
const ipcPromise = require('ipc-promise');
const mock = require('../../test/e2e/mocks');
const ipcFunctions = require('./utils/ipc-functions');
const runPipelineFunctions = require('./utils/run-pipeline-functions');

const { ipcMain } = electron;

const { EXPIRED_TOKEN, BAD_TOKEN } = require('../render/utils/error-codes');

// if no env set prd
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// Mock file dialogue in testing environment
// Watch the following issue for progress on dialog support
// https://github.com/electron/spectron/issues/94
if (process.env.NODE_ENV === 'test') {
  if (process.env.TEST_INSTANCE) {
    electron.app.setPath('userData', `${electron.app.getPath('userData')}-${process.env.TEST_INSTANCE}`);
  }

  mock(electron.dialog);
}

// Set up root paths
require('../common/utils/add-root-require-path.js');

// Parse and handle CLI flags
const parseCLIInput = require('./utils/boot/parse-cli-input.js');

parseCLIInput();

// Add dev mode specific services
require('./utils/boot/configure-dev-services.js');

// Load the UI
const getWindow = require('./utils/boot/configure-browser-window.js');

// Set up error handling
const logUnhandledError = require('../common/utils/log-unhandled-error.js');
const configureCore = require('./utils/boot/configure-core.js');
const { configureLogger, readInitialLogContents } = require('./utils/boot/configure-logger.js');
const upsertCoinstacUserDir = require('./utils/boot/upsert-coinstac-user-dir.js');
const loadConfig = require('../config.js');
const fileFunctions = require('./services/files.js');

let initializedCore;
// Boot up the main process
loadConfig()
  .then(config => Promise.all([
    config,
    configureLogger(config),
  ]))
  .then(([config, logger]) => {
    const unhandler = logUnhandledError(null, logger);
    process.on('uncaughtException', (err) => {
      try {
        unhandler(err);
      } catch (e) {
        console.error('Logging failure:');// eslint-disable-line no-console
        console.error(e);// eslint-disable-line no-console
        console.error('Thrown error on failure:');// eslint-disable-line no-console
        console.error(err);// eslint-disable-line no-console
      }
    });
    global.config = config;

    const mainWindow = getWindow();
    logger.verbose('main process booted');

    logger.on('log-message', (arg) => {
      mainWindow.webContents.send('log-message', arg);
    });

    ipcMain.on('load-initial-log', async () => {
      const fileContents = await readInitialLogContents(config);
      mainWindow.webContents.send('log-message', { data: fileContents });
    });

    ipcMain.on('clean-remote-pipeline', (event, runId) => {
      if (initializedCore) {
        initializedCore.unlinkFiles(runId)
          .catch((err) => {
            logger.error(err);
            mainWindow.webContents.send('docker-error', {
              err: {
                message: err.message,
                stack: err.stack,
              },
            });
          });
      }
    });

    /**
   * IPC Listener to write logs
   * @param {String} message The message to write out to log
   * @param {String} type The type of log to write out
   */
    ipcMain.on('write-log', (event, { type, message }) => {
      logger[type](`process: render - ${JSON.stringify(message)}`);
    });

    /**
     * IPC Listener to notify token expire
     */
    ipcMain.on(EXPIRED_TOKEN, () => {
      mainWindow.webContents.send(EXPIRED_TOKEN);
    });

    ipcMain.on(BAD_TOKEN, () => {
      logger.error('A bad token was used on a request to the api');

      mainWindow.webContents.send(BAD_TOKEN);
    });

    ipcPromise.on('login-init', ({ userId, appDirectory }) => {
      return initializedCore
        ? Promise.resolve() : configureCore(config, logger, userId, appDirectory || config.get('coinstacHome'))
          .then((c) => {
            initializedCore = c;
            return upsertCoinstacUserDir(c);
          });
    });
    /**
     * [initializedCore description]
     * @type {[type]}
     */
    ipcPromise.on('logout', () => {
      // TODO: hacky way to not get a mqtt reconnn loop
      // a better way would be to make an actual shutdown fn for pipeline
      return new Promise((resolve) => {
        initializedCore.pipelineManager.mqtCon.end(true, () => {
          initializedCore = undefined;
          resolve();
        });
      });
    });
    /**
   * IPC Listener to start pipeline
   * @param {Object} consortium
   * @param {String} consortium.id The id of the consortium starting the pipeline
   * @param {Object[]} consortium.pipelineSteps An array of the steps involved in
   *  this pipeline run according to the consortium
   * @param {String[]} dataMappings Mapping of pipeline variables into data file columns
   * @param {Object} run
   * @param {String} run.id The id of the current run
   * @param {Object[]} run.pipelineSteps An array of the steps involved in this pipeline run
   *  according to the run
   * @return {Promise<String>} Status message
   */
    ipcMain.on('start-pipeline', (event, {
      consortium, dataMappings, pipelineRun,
    }) => {
      const { filesArray, steps } = runPipelineFunctions.parsePipelineInput(pipelineRun.pipelineSnapshot, dataMappings);

      const run = {
        ...pipelineRun,
        pipelineSnapshot: {
          ...pipelineRun.pipelineSnapshot,
          steps,
        },
      };

      const pipeline = run.pipelineSnapshot;

      mainWindow.webContents.send('save-local-run', { run });

      const computationImageList = pipeline.steps
        .map(step => step.computations
          .map(comp => comp.computation.dockerImage))
        .reduce((acc, val) => acc.concat(val), []);

      return initializedCore.dockerManager.pullImagesFromList(computationImageList)
        .then((compStreams) => {
          const streamProms = [];

          compStreams.forEach(({ stream }) => {
            let proxRes;
            let proxRej;

            streamProms.push(new Promise((resolve, reject) => {
              proxRej = reject;
              proxRes = resolve;
            }));
            if (typeof stream.on !== 'function') {
              proxRej(stream.message);
            } else {
              mainWindow.webContents.send('local-pipeline-state-update', {
                run,
                data: { controllerState: 'Downloading required docker images' },
              });

              stream.on('data', (data) => {
                mainWindow.webContents.send('local-pipeline-state-update', {
                  run,
                  data: { controllerState: `Downloading required docker images\n ${data.toString()}` },
                });
              });

              stream.on('end', () => {
                proxRes();
              });

              stream.on('error', (err) => {
                proxRej(err);
              });
            }
          });

          return Promise.all(streamProms);
        })
        .catch((err) => {
          return initializedCore.unlinkFiles(run.id)
            .then(() => {
              mainWindow.webContents.send('local-run-error', {
                consName: consortium.name,
                run: Object.assign(
                  run,
                  {
                    error: {
                      message: err.message,
                      stack: err.stack,
                      error: err.error,
                    },
                    endDate: Date.now(),
                  }
                ),
              });
            });
        })
        .then(() => initializedCore.dockerManager.pruneImages())
        .then(() => {
          logger.verbose('############ Client starting pipeline');

          const pipelineName = pipeline.name
          const consortiumName = consortium.name

          ipcFunctions.sendNotification(
            'Pipeline started',
            `Pipeline ${pipelineName} started on consortia ${consortiumName}`
          )

          return initializedCore.startPipeline(
            null,
            consortium.id,
            pipeline,
            filesArray,
            run.id,
            run.pipelineSteps
          )
            .then(({ pipeline, result }) => {
              // Listen for local pipeline state updates
              pipeline.stateEmitter.on('update', (data) => {
                mainWindow.webContents.send('local-pipeline-state-update', { run, data });
              });

              // Listen for results
              return result.then((results) => {
                logger.verbose('########### Client pipeline done');

                ipcFunctions.sendNotification(
                  'Pipeline finished',
                  `Pipeline ${pipelineName} finished on consortia ${consortiumName}`
                )

                return initializedCore.unlinkFiles(run.id)
                  .then(() => {
                    if (run.type === 'local') {
                      mainWindow.webContents.send('local-run-complete', {
                        consName: consortium.name,
                        run: Object.assign(run, { results, endDate: Date.now() }),
                      });
                    }
                  });
              })
                .catch((error) => {
                  logger.verbose('########### Client pipeline error');
                  logger.verbose(error.message);

                  ipcFunctions.sendNotification(
                    'Pipeline stopped',
                    `Pipeline ${pipelineName} stopped on consortia ${consortiumName}`
                  )

                  return initializedCore.unlinkFiles(run.id)
                    .then(() => {
                      mainWindow.webContents.send('local-run-error', {
                        consName: consortium.name,
                        run: Object.assign(
                          run,
                          {
                            error: {
                              message: error.message,
                              stack: error.stack,
                              error: error.error,
                              input: error.input,
                            },
                            endDate: Date.now(),
                          }
                        ),
                      });
                    });
                });
            })
            .catch((error) => {
              mainWindow.webContents.send('local-run-error', {
                consName: consortium.name,
                run: Object.assign(
                  run,
                  {
                    error: {
                      message: error.message,
                      stack: error.stack,
                      error: error.error,
                    },
                    endDate: Date.now(),
                  }
                ),
              });
            });
        });
    });

    /**
     * IPC Listener to stop pipeline
     * @param {String} pipelineId The id of the pipeline currently running
     * @param {String} runId The id of the pipeline run
     * @return {Promise<String>} Status message
     */
    ipcMain.on('stop-pipeline', (event, { pipelineId, runId }) => {
      try {
        return initializedCore.requestPipelineStop(pipelineId, runId);
      } catch (err) {
        logger.error(err);
        mainWindow.webContents.send('docker-error', {
          err: {
            message: err.message,
            stack: err.stack,
          },
        });
      }
    });

    /**
  * IPC listener to return a list of all local Docker images
  * @return {Promise<String[]>} An array of all local Docker image names
  */
    ipcPromise.on('get-all-images', () => {
      return initializedCore.dockerManager.getImages()
        .then((data) => {
          return data;
        })
        .catch((err) => {
          logger.error(err);
          mainWindow.webContents.send('docker-error', {
            err: {
              message: err.message,
              stack: err.stack,
            },
          });
        });
    });


    /**
  * IPC listener to return status of Docker
  * @return {Promise<boolean[]>} Docker running?
  */
    ipcPromise.on('get-status', () => {
      return initializedCore.dockerManager.getStatus()
        .then((result) => {
          return result;
        })
        .catch((err) => {
          logger.error(err);
          mainWindow.webContents.send('docker-error', {
            err: {
              message: err.message,
              stack: err.stack,
            },
          });
        });
    });

    /**
  * IPC Listener to download a list of computations
  * @param {Object} params
  * @param {String[]} params.computations An array of docker image names
  * @param {String} params.consortiumId ID of the consortium, if relevant,
  *  associated with the computations being retrieved
  * @return {Promise}
  */
    ipcPromise.on('download-comps', (params) => { // eslint-disable-line no-unused-vars
      return initializedCore.dockerManager
        .pullImages(params.computations)
        .then((compStreams) => {
          let streamsComplete = 0;

          compStreams.forEach(({ compId, compName, stream }) => {
            if (typeof stream.on !== 'function') {
              const output = [{
                message: stream.message, status: 'error', statusCode: stream.statusCode, isErr: true,
              }];
              mainWindow.webContents.send('docker-out', { output, compId, compName });
            } else {
              stream.on('data', (data) => {
                let output = compact(data.toString().split('\r\n'));
                output = output.map(JSON.parse);

                mainWindow.webContents.send('docker-out', { output, compId, compName });
              });

              stream.on('end', () => {
                mainWindow.webContents.send('docker-out',
                  {
                    output: [{ id: `${compId}-complete`, status: 'complete' }],
                    compId,
                    compName,
                  });

                streamsComplete += 1;

                if (params.consortiumId && streamsComplete === params.computations.length) {
                  mainWindow.webContents
                    .send('docker-pull-complete', params.consortiumId);
                }
              });

              stream.on('error', (err) => {
                const output = [{
                  message: err.json, status: 'error', statusCode: err.statusCode, isErr: true,
                }];
                mainWindow.webContents.send('docker-out', { output, compId, compName });
              });
            }
          });
        })
        .catch((err) => {
          const output = [{
            message: err.json, status: 'error', statusCode: err.statusCode, isErr: true,
          }];
          mainWindow.webContents.send('docker-out', { output });
        });
    });

    /**
   * IPC Listener to open a dialog in Electron
   * @param {String} org How the files being retrieved are organized
   * @return {String[]} List of file paths being retrieved
  */
    ipcPromise.on('open-dialog', (org) => {
      let filters;
      let properties;
      let postDialogFunc;

      if (org === 'metafile') {
        filters = [{
          name: 'CSV',
          extensions: ['csv', 'txt'],
        }];
        properties = ['openFile'];
        postDialogFunc = ipcFunctions.parseCSVMetafile;
      } else if (org === 'jsonschema') {
        filters = [{
          name: 'JSON Schema',
          extensions: ['json'],
        }];
        properties = ['openFile'];
        postDialogFunc = ipcFunctions.returnFileAsJSON;
      } else if (org === 'directory') {
        properties = ['openDirectory'];
        postDialogFunc = ipcFunctions.manualDirectorySelection;
      } else if (org === 'bundle') {
        filters = [
          {
            name: 'File Types',
            extensions: ['jpeg', 'jpg', 'png', 'nii', 'csv', 'txt', 'rtf', 'gz',  'pickle'],
          },
        ];
        properties = ['openFile', 'multiSelections'];
        postDialogFunc = ipcFunctions.manualFileSelectionMultExt;
      } else {
        filters = [
          {
            name: 'File Types',
            extensions: ['jpeg', 'jpg', 'png', 'nii', 'csv', 'txt', 'rtf', 'gz', 'pickle'],
          },
        ];
        properties = ['openDirectory', 'openFile', 'multiSelections'];
        postDialogFunc = ipcFunctions.manualFileSelection;
      }

      return fileFunctions.showDialog(
        mainWindow,
        filters,
        properties
      )
        .then(({ filePaths }) => postDialogFunc(filePaths, initializedCore))
        .catch((err) => {
          //  Below error happens when File Dialog is cancelled.
          //  Not really an error.
          //  Let's not freak people out.
          if (!err.message.contains("Cannot read property '0' of undefined")) {
            logger.error(err);
            mainWindow.webContents.send('docker-error', {
              err: {
                message: err.message,
                stack: err.stack,
              },
            });
          }
        });
    });
    /**
   * IPC Listener to remove a Docker image
   * @param {String} imgId ID of the image to remove
   */
    ipcPromise.on('remove-image', ({ compId, imgId, imgName }) => {
      return initializedCore.dockerManager.removeImage(imgId)
        .catch((err) => {
          const output = [{
            message: err.message, status: 'error', statusCode: err.statusCode, isErr: true,
          }];
          mainWindow.webContents.send('docker-out', { output, compId, compName: imgName });
        });
    });
  });
