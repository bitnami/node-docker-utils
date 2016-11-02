'use strict';

const _ = require('nami-utils/lodash-extra');
const path = require('path');
const spawnSync = require('child_process').spawnSync;
const strftime = require('strftime');
const nfile = require('nami-utils').file;
const nos = require('nami-utils').os;
const logExec = require('common-utils').logExec;

function _getDummyLogger() {
  return {info: console.log, error: console.error, debug: function() {}};
}

/**
 * Execute command using docker binary
 * @function exec
 * @param {string|Array} command - Command to execute
 * @param {Object} [options] - Options passed to runProgram method
 * @example
 * exec('cp', ['test:/tmp/log', '/tmp/log']);
 */
function exec(command, options) {
  return nos.runProgram('docker', command, options);
}

function _removeContainer(containerId, callback, options) {
  options = _.opts(options, {force: false, logger: _getDummyLogger()});
  const logger = options.logger;
  try {
    exec(`rm ${options.force ? '-f' : ''} ${containerId}`);
    logger.debug('Temporary container successfully deleted');
  } catch (e) {
    logger.error(`Failed to delete container ${e}`);
  }
  if (callback) {
    callback();
  }
}

function _getBinds(mappings) {
  const result = [];
  _.each(mappings, function(containerPath, hostPath) {
    let mode = null;
    if (_.isString(containerPath) || _.isReallyObject(containerPath)) {
      if (_.isReallyObject(containerPath)) {
        mode = containerPath.mode;
        containerPath = containerPath.path;
      }
    } else {
      throw new Error(`Invalid mapping spec ${JSON.stringify(containerPath)}`);
    }
    let bindSpec = `${hostPath}:${containerPath}`;
    if (mode) bindSpec += `:${mode}`;
    result.push('-v', bindSpec);
  });
  return result;
}

function _parseRunOptions(runOptions) {
  const result = [];
  _.each(runOptions, (value, key) => {
    if (value !== false) result.push(`--${key}`);
    if (!_.isNull(value) && !_.isUndefined(value) && value !== true) result.push(value);
  });
  return result;
}
/**
 * Opens a bash shell in a docker image
 * @function shell
 * @param {string} imageId - Container image id
 * @param {Object} [options]
 * @param {string} [options.root] - Path to overlay with the container root directory
 * @param {Object} [options.mappings] - Key-value with the volumes to map. The key should be the host path and its
 * value should be a string for the container path or an object specifying the path and the access mode (rw, ro)
 * @param {Object} [options.runOptions] - Key-value with the docker run command options to use. The key should be
 * the full name of the option and the value should be a string or a boolean if it doesn't have a value
 * @example
 * shell('centos', {
 * root: '/tmp/container-root/',
 * }, {
 *   mappings: {
 *     '/tmp/test': '/tmp/test',
 *     '/tmp/read': {path: '/tmp/read', mod: 'ro'}
 * }, {
 *   runOptions: {
 *     'name': 'my-container',
 *     'privileged': true
 * });
 */
function shell(imageId, options) {
  options = _.opts(options, {root: null, mappings: {}, runOptions: {}});
  options.runOptions = _.opts(options.runOptions, {
    'interactive': true,
    'tty': true
  });
  const runOptions = _parseRunOptions(options.runOptions);
  const mappings = options.mappings;
  if (options.root) {
    _.each(nfile.glob(`${options.root}/*`), function(f) { // If root is given map every directory inside of it
      mappings[f] = path.join('/', path.basename(f));
    });
  }
  const binds = _getBinds(mappings);
  const cmdArgs = ['run'].concat(runOptions, binds);
  cmdArgs.push(imageId, 'bash');
  return spawnSync('docker', cmdArgs, {stdio: 'inherit', shell: true});
}

/**
 * Obtains an image id from a image name
 * @function getImageId
 * @param {string} imageName - Name of the image
 * @returns {string} - Image id
 * @example
 * getImageId('centos');
 * // => 'a8de57517228'
 */
function getImageId(imageName) {
  const res = exec(`images -q ${imageName}`).split('\n')[0];
  return !_.isEmpty(res) ? res : null;
}

/**
 * Obtains a container id from its name
 * @function getContainerId
 * @param {string} name - Name of the container
 * @returns {string} - Container ID
 * @example
 * getContainerId('silly_cori');
 * // => '92b09381df3f'
 */
function getContainerId(name) {
  const res = exec(`ps -aq --filter "name=${name}"`).replace('\n', '');
  return !_.isEmpty(res) ? res : null;
}

function _parseRunCommandArguments(id, cmd, runOptions, mappings) {
  runOptions = _.opts(runOptions, {
    'interactive': null
  });
  const parsedRunOptions = _parseRunOptions(runOptions);
  const binds = _getBinds(mappings);
  return ['run'].concat(binds, parsedRunOptions, id, cmd);
}

/**
 * Run a command in a Docker image
 * @function runInContainerAsync
 * @param {string} id - Container image id
 * @param {string|Array} cmd - Command to execute
 * @param {Function} callback(container, err, data) - Callback to execute after running the command
 * @param {Object} [options]
 * @param {Object} [options.mappings] - Key-value with the volumes to map using the host path as key
 * and a string for the container path or an object specifying the path and the access mode (rw, ro)
 * @param {Object} [options.logger] - Logger to use
 * @param {Object} [options.timeout=10800] - Timeout for the command to run. Three hours by default.
 * Infinity is a valid value
 * @param {Object} [options.exitOnEnd=true] - Exit the current process after finishing
 * @example
 * runInContainerAsync('centos', ['find', '/'], () => {
 *   console.log('Command finished');
 * }, {
 *   mappings: {
 *     '/tmp/test': '/tmp/test',
 *     '/tmp/read': {path: '/tmp/read', mod: 'ro'}
 * });
 */
function runInContainerAsync(id, cmd, callback, options) {
  options = _.opts(options, {
    mappings: [], logger: _getDummyLogger(), timeout: 10800,
    runOptions: {}, exitOnEnd: false
  });
  options.runOptions = _.opts(options.runOptions, {
    'name': strftime('%s')
  });
  const _parseMsg = function(msg) {
    // Avoid multiple '\n'
    msg = _.compact(msg.toString('utf8').split('\n'));
    return msg;
  };
  const onStdout = function(msg) {
    _.each(_parseMsg(msg), line => {
      options.logger.debug(`[docker] ${line}`);
    });
  };
  const onStderr = function(msg) {
    _.each(_parseMsg(msg), line => {
      options.logger.error(`[docker] ${line}`);
    });
  };
  const onExit = function(res) {
    const containerId = getContainerId(options.runOptions.name);
    if (callback) callback({id: containerId}, res);
    _removeContainer(containerId, () => {
      if (options.exitOnEnd) process.exit();
    }, {logger: options.logger, force: true});
  };
  process.on('SIGINT', function() {
    onExit({exitCode: 127});
  });
  const _cmd = _parseRunCommandArguments(id, cmd, options.runOptions, options.mappings);
  const handler = nos.execAsync(`docker ${_cmd.join(' ')}`, {onStdout, onStderr, onExit});
  try {
    handler.wait({timeout: options.timeout, throwOnTimeout: true});
  } catch (e) {
    const containerId = getContainerId(options.runOptions.name);
    _removeContainer(containerId, null, {force: true});
    throw e;
  }
}

/**
 * Run a command in a Docker image synchronously
 * @function runInContainer
 * @param {string} id - Container image id
 * @param {string|Array} cmd - Command to execute
 * @param {Object} [options]
 * @param {Object} [options.mappings] - Key-value with the volumes to map using the host path as key
 * and a string for the container path or an object specifying the path and the access mode (rw, ro)
 * @example
 * runInContainer('centos', ['find', '/'], {
 *   mappings: {
 *     '/tmp/test': '/tmp/test',
 *     '/tmp/read': {path: '/tmp/read', mod: 'ro'}
 * });
 */
function runInContainer(id, cmd, options) {
  options = _.opts(options, {mappings: [], runOptions: {}});
  const _cmd = _parseRunCommandArguments(id, cmd, options.runOptions, options.mappings);
  return exec(_cmd.join(' '), options);
}

/**
 * Pull an image using docker binary
 * @function pull
 * @param {string} image - Image to pull
 * @example
 * pull('centos');
 */
function pull(image) {
  return exec(`pull ${image}`);
}

/**
 * Check if an image exists
 * @function imageExists
 * @param {string} imageName - Name of the image
 * @returns {boolean}
 * @example
 * imageExists('centos');
 * // => true
 */
function imageExists(imageName) {
  return !_.isEmpty(getImageId(imageName));
}

/**
 * Load a docker image from a tar or a tar.gz
 * @function imageExists
 * @param {string} imagePath - Path to the tarball
 * @example
 * loadImage('/tmp/centos.tar.gz');
 */
function loadImage(imagePath) {
  if (!nfile.exists(imagePath)) {
    throw new Error(`Cannot load ${imagePath} as docker image: file does not exist.`);
  }
  if (path.extname(imagePath) === '.gz') {
    logExec('gunzip', imagePath);
    imagePath = imagePath.replace('.gz', '');
  }
  return exec(`load -i ${imagePath}`);
}

/**
 * Build a docker image
 * @function build
 * @param {string} imagePath - Path to the Dockerfile directory
 * @param {string} name - Name of the image
 * @param {Object} [options]
 * @param {string} [options.tag='latest'] - Tag of the image
 * @example
 * build('/tmp/centos/', 'centos', {tag: 'r01'});
 */
function build(imagePath, name, options) {
  options = _.opts(options, {tag: 'latest'});
  return exec(`build -t ${name}:${options.tag} ${imagePath}`);
}

/**
 * Check if Docker daemon is available and running
 * @function verifyConnection
 * @return {boolean}
 */
function verifyConnection() {
  let res = false;
  try {
    exec('ps');
    res = true;
  } catch (e) {
    throw new Error(`Docker is not available: \n${e.message}`);
  }
  return res;
}

module.exports = {
  runInContainer,
  runInContainerAsync,
  shell,
  exec,
  pull,
  loadImage,
  imageExists,
  getImageId,
  getContainerId,
  build,
  verifyConnection
};
