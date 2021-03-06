/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var exec            = require('./utils').exec;
var execPromise     = require('./utils').execPromise;
var shell           = require('shelljs');
var Server          = require('./LocalServer');
var tmp             = require('tmp');
var path            = require('path');
var Q               = require('q');
var fs              = require('fs');
var logger          = require('./utils').logger;
var util            = require('./utils').utilities;
var PluginsManager  = require('./PluginsManager');
var getReporters    = require('./Reporters');
var ParamedicKill   = require('./ParamedicKill');
var ParamedicLog    = require('./ParamedicLog');
var wd              = require('wd');
var SauceLabs       = require('saucelabs');
var ParamediciOSPermissions = require('./ParamediciOSPermissions');
var ParamedicTargetChooser  = require('./ParamedicTargetChooser');
var ParamedicAppUninstall   = require('./ParamedicAppUninstall');

//this will add custom promise chain methods to the driver prototype
require('./appium/helpers/wdHelper');

// Time to wait for initial device connection.
// If device has not connected within this interval the tests are stopped.
var INITIAL_CONNECTION_TIMEOUT = 300000; // 5mins

var SAUCE_HOST = 'ondemand.saucelabs.com';
var SAUCE_PORT = 80;

var applicationsToGrantPermission = [
    'kTCCServiceAddressBook'
];

function ParamedicRunner(config, _callback) {
    this.tempFolder = null;
    this.pluginsManager = null;

    this.config = config;
    this.targetObj = undefined;

    exec.setVerboseLevel(config.isVerbose());
}

ParamedicRunner.prototype.run = function () {
    var self = this;

    this.checkSauceRequirements();

    return Q().then(function () {
        self.createTempProject();
        shell.pushd(self.tempFolder.name);
        self.prepareProjectToRunTests();
        return Server.startServer(self.config.getPorts(), self.config.getExternalServerUrl(), self.config.getUseTunnel());
    })
    .then(function (server) {
        self.server = server;

        self.injectReporters();
        self.subcribeForEvents();

        var connectionUrl = server.getConnectionUrl(self.config.getPlatformId());
        self.writeMedicConnectionUrl(connectionUrl);

        logger.normal('Start running tests at ' + (new Date()).toLocaleTimeString());
        return self.runTests();
    })
    .fin(function (result) {
        logger.normal('Completed tests at ' + (new Date()).toLocaleTimeString());
        // if we do --justbuild  or run on sauce,
        // we should NOT do actions below
        if (self.config.getAction() !== 'build' && !self.config.shouldUseSauce()) {
            self.collectDeviceLogs();
            self.uninstallApp();
            self.killEmulatorProcess();
        }
        self.cleanUpProject();
        return result;
    });
};

ParamedicRunner.prototype.createTempProject = function () {
    this.tempFolder = tmp.dirSync();
    tmp.setGracefulCleanup();
    logger.info('cordova-paramedic: creating temp project at ' + this.tempFolder.name);
    exec('cordova create ' + this.tempFolder.name);
};

ParamedicRunner.prototype.prepareProjectToRunTests = function () {
    this.installPlugins();
    this.setUpStartPage();
    this.installPlatform();
    this.checkPlatformRequirements();
};

ParamedicRunner.prototype.installPlugins = function () {
    logger.info('cordova-paramedic: installing plugins');
    this.pluginsManager = new PluginsManager(this.tempFolder.name, this.storedCWD);
    this.pluginsManager.installPlugins(this.config.getPlugins());
    this.pluginsManager.installTestsForExistingPlugins();

    var additionalPlugins = ['cordova-plugin-test-framework', 'cordova-plugin-device', path.join(__dirname, '../paramedic-plugin')];
    if (this.config.shouldUseSauce() && !this.config.getUseTunnel()) {
        additionalPlugins.push(path.join(__dirname, '../event-cache-plugin'));
    }
    if (this.config.getPlatformId() === 'windows') {
        additionalPlugins.push(path.join(__dirname, '../debug-mode-plugin'));
    }
    if (this.config.getPlatformId() === 'ios') {
        additionalPlugins.push(path.join(__dirname, '../ios-geolocation-permissions-plugin'));
    }

    this.pluginsManager.installPlugins(additionalPlugins);
};

ParamedicRunner.prototype.setUpStartPage = function () {
    logger.normal('cordova-paramedic: setting app start page to test page');
    shell.sed('-i', 'src="index.html"', 'src="cdvtests/index.html"', 'config.xml');
};

ParamedicRunner.prototype.installPlatform = function () {
    logger.info('cordova-paramedic: adding platform : ' + this.config.getPlatform());
    exec('cordova platform add ' + this.config.getPlatform());
};

ParamedicRunner.prototype.checkPlatformRequirements = function () {
    logger.normal('cordova-paramedic: checking requirements for platform ' + this.config.getPlatformId());
    var result = exec('cordova requirements ' + this.config.getPlatformId());

    if (result.code !== 0)
        throw new Error('Platform requirements check has failed!');
};

ParamedicRunner.prototype.setPermissions = function () {
    if(this.config.getPlatformId() === 'ios') {
        logger.info('cordova-paramedic: Setting required permissions.');
        var tccDb = this.config.getTccDb();
        if(tccDb) {
            var appName                 = util.PARAMEDIC_DEFAULT_APP_NAME;
            var paramediciOSPermissions = new ParamediciOSPermissions(appName, tccDb, this.targetObj);
            paramediciOSPermissions.updatePermissions(applicationsToGrantPermission);
        }
    }
};

ParamedicRunner.prototype.injectReporters = function () {
    var self = this;
    var reporters = getReporters(self.config.getOutputDir());

    ['jasmineStarted', 'specStarted', 'specDone',
    'suiteStarted', 'suiteDone', 'jasmineDone'].forEach(function(route) {
        reporters.forEach(function(reporter) {
            if (reporter[route] instanceof Function)
                self.server.on(route, reporter[route].bind(reporter));
        });
    });
};

ParamedicRunner.prototype.subcribeForEvents = function () {
    this.server.on('deviceLog', function (data) {
        logger.verbose('device|console.' + data.type + ': '  + data.msg[0]);
    });

    this.server.on('deviceInfo', function (data) {
        logger.normal('cordova-paramedic: Device info: ' + JSON.stringify(data));
    });
};

ParamedicRunner.prototype.writeMedicConnectionUrl = function(url) {
    logger.normal('cordova-paramedic: writing medic log url to project ' + url);
    fs.writeFileSync(path.join('www','medic.json'), JSON.stringify({logurl:url}));
};

ParamedicRunner.prototype.runTests = function () {
    var self = this;
    if (this.config.shouldUseSauce()) {
        var command = this.getCommandForBuilding();
        logger.normal('cordova-paramedic: running command ' + command);

        return execPromise(command)
        .then(self.runSauceTests.bind(self), function(output) {
            // this trace is automatically available in verbose mode
            // so we check for this flag to not trace twice
            if (!self.config.verbose) {
                logger.normal(output);
            }
            logger.normal('cordova-paramedic: unable to build project; command log is available above');
            throw new Error('Command "' + command + '" failed.');
        });
    } else {
        return self.getCommandForStartingTests()
        .then(function(command) {
            self.setPermissions();
            logger.normal('cordova-paramedic: running command ' + command);

            return execPromise(command);
        })
        .then(function() {
            // skip tests if it was just build
            if (self.shouldWaitForTestResult()) {
                return Q.promise(function(resolve, reject) {
                    // reject if timed out
                    self.waitForConnection().catch(reject);
                    // resolve if got results
                    self.waitForTests().then(resolve);
                });
            }
        }, function(output) {
            // this trace is automatically available in verbose mode
            // so we check for this flag to not trace twice
            if (!self.config.verbose) {
                logger.normal(output);
            }
            logger.normal('cordova-paramedic: unable to run tests; command log is available above');
            throw new Error('Command "' + command + '" failed.');
        });
    }
};

ParamedicRunner.prototype.waitForTests = function () {
    var self = this;
    logger.info('cordova-paramedic: waiting for test results');
    return Q.promise(function(resolve, reject) {

        // time out if connection takes too long
        var ERR_MSG = 'Seems like device not connected to local server in ' + INITIAL_CONNECTION_TIMEOUT / 1000 + ' secs';
        setTimeout(function() {
            if (!self.server.isDeviceConnected()) {
                reject(new Error(ERR_MSG));
            }
        }, INITIAL_CONNECTION_TIMEOUT);

        self.server.on('jasmineDone', function (data) {
            logger.info('cordova-paramedic: tests have been completed');

            var isTestPassed = (data.specResults.specFailed === 0);

            resolve(isTestPassed);
        });

        self.server.on('disconnect', function () {
            reject(new Error('device is disconnected before passing the tests'));
        });
    });
};

ParamedicRunner.prototype.getCommandForStartingTests = function () {
    var self = this;
    var cmd  = 'cordova ' + this.config.getAction() + ' ' + this.config.getPlatformId();
    var paramedicTargetChooser = new ParamedicTargetChooser(this.tempFolder.name, this.config.getPlatformId());

    if(self.config.getAction() === 'build' || (self.config.getPlatformId() === 'windows' && self.config.getArgs().indexOf('appx=8.1-phone') < 0)) {
        //The app is to be run as a store app or just build. So no need to choose a target.
        if (self.config.getArgs()) {
            cmd += ' ' + self.config.getArgs();
        }

        return Q(cmd);
    }

    // For now we always trying to run test app on emulator
    return paramedicTargetChooser.chooseTarget(/*useEmulator=*/true)
    .then(function(targetObj){
        self.targetObj = targetObj;
        cmd += ' --target ' + self.targetObj.target;

        // CB-11472 In case of iOS provide additional '--emulator' flag, otherwise
        // 'cordova run ios --target' would hang waiting for device with name
        // as specified in 'target' in case if any device is physically connected
        if (self.config.getPlatformId() === 'ios') {
            cmd += ' --emulator';
        }

        if (self.config.getArgs()) {
            cmd += ' ' + self.config.getArgs();
        }

        return cmd;
    });
};

ParamedicRunner.prototype.getCommandForBuilding = function () {
    var cmd = 'cordova build ' + this.config.getPlatformId();

    return cmd;
};

ParamedicRunner.prototype.shouldWaitForTestResult = function () {
    var action = this.config.getAction();
    return action === 'run' || action  === 'emulate';
};

ParamedicRunner.prototype.waitForConnection = function () {
    var self = this;

    var ERR_MSG = 'Seems like device not connected to local server in ' + INITIAL_CONNECTION_TIMEOUT / 1000 + ' secs';

    return Q.promise(function(resolve, reject) {
        setTimeout(function () {
            if (!self.server.isDeviceConnected()) {
                reject(new Error(ERR_MSG));
            } else {
                resolve();
            }
        }, INITIAL_CONNECTION_TIMEOUT);
    });
};

ParamedicRunner.prototype.cleanUpProject = function () {
    if (this.config.shouldCleanUpAfterRun()) {
        logger.info('cordova-paramedic: Deleting the application: ' + this.tempFolder.name);
        shell.popd();
        shell.rm('-rf', this.tempFolder.name);
    }
};

ParamedicRunner.prototype.checkSauceRequirements = function () {
    if (this.config.shouldUseSauce()) {
        if (this.config.getPlatformId() !== 'android' && this.config.getPlatformId() !== 'ios') {
            logger.warn('Saucelabs only supports Android and iOS, falling back to testing locally.');
            this.config.setShouldUseSauce(false);
        } else if (!this.config.getSauceKey()) {
            throw new Error('Saucelabs key not set. Please set it via environmental variable ' +
                util.SAUCE_KEY_ENV_VAR + ' or pass it with the --sauceKey parameter.');
        } else if (!this.config.getSauceUser()) {
            throw new Error('Saucelabs user not set. Please set it via environmental variable ' +
                util.SAUCE_USER_ENV_VAR + ' or pass it with the --sauceUser parameter.');
        } else if (!this.shouldWaitForTestResult()) {
            throw new Error('justBuild cannot be used with shouldUseSauce');
        }
    }
};

ParamedicRunner.prototype.packageApp = function () {
    var self = this;
    switch (this.config.getPlatformId()) {
        case 'ios': {
            return Q.promise(function (resolve, reject) {
                var zipCommand = 'zip -r ' + self.getPackageName() + ' ' + self.getBinaryName();
                shell.pushd(self.getPackageFolder());
                console.log('Running command: ' + zipCommand + ' in dir: ' + shell.pwd());
                shell.exec(zipCommand, { silent: true }, function (code, stdout, stderr) {
                    shell.popd();
                    if (code) {
                        reject('zip command returned with error code ' + code);
                    } else {
                        resolve();
                    }
                });
            });
        }
        case 'android':
            break; // don't need to zip the app for Android
        default:
            throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
    }
    return Q.resolve();
};

ParamedicRunner.prototype.uploadApp = function () {
    logger.normal('cordova-paramedic: uploading ' + this.getAppName() + ' to Sauce Storage');

    var sauceUser = this.config.getSauceUser();
    var key       = this.config.getSauceKey();

    var uploadURI     = encodeURI('https://saucelabs.com/rest/v1/storage/' + sauceUser + '/' + this.getAppName() + '?overwrite=true');
    var filePath      = this.getPackagedPath();
    var uploadCommand =
        'curl -u ' + sauceUser + ':' + key +
        ' -X POST -H "Content-Type: application/octet-stream" ' +
        uploadURI + ' --data-binary "@' + filePath + '"';

    return execPromise(uploadCommand);
};

ParamedicRunner.prototype.getPackagedPath = function () {
    return path.join(this.getPackageFolder(), this.getPackageName());
};

ParamedicRunner.prototype.killEmulatorProcess = function () {
    if(this.config.shouldCleanUpAfterRun()){
        logger.info('cordova-paramedic: Killing the emulator process.');
        var paramedicKill = new ParamedicKill(this.config.getPlatformId());
        paramedicKill.kill();
    }
};

ParamedicRunner.prototype.collectDeviceLogs = function () {
    logger.info('Collecting logs for the devices.');
    var outputDir    = this.config.getOutputDir()? this.config.getOutputDir(): this.tempFolder.name;
    var logMins      = this.config.getLogMins()? this.config.getLogMins(): util.DEFAULT_LOG_TIME;
    var paramedicLog = new ParamedicLog(this.config.getPlatformId(), this.tempFolder.name, outputDir, this.targetObj);
    paramedicLog.collectLogs(logMins);
};

ParamedicRunner.prototype.uninstallApp = function () {
    logger.info('Uninstalling the app.');
    var paramedicAppUninstall = new ParamedicAppUninstall(this.tempFolder.name, this.config.getPlatformId());
    paramedicAppUninstall.uninstallApp(this.targetObj,util.PARAMEDIC_DEFAULT_APP_NAME);
};


ParamedicRunner.prototype.getPackageFolder = function () {
    var packageFolder;
    switch (this.config.getPlatformId()) {
        case 'android':
            packageFolder = path.join(this.tempFolder.name, 'platforms/android/build/outputs/apk/');
            break;
        case 'ios':
            packageFolder = path.join(this.tempFolder.name, 'platforms/ios/build/emulator/');
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
    }
    return packageFolder;
};

ParamedicRunner.prototype.getPackageName = function () {
    var packageName;
    switch (this.config.getPlatformId()) {
        case 'ios':
            packageName = 'HelloCordova.zip';
            break;
        case 'android':
            packageName = this.getBinaryName();
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
    }
    return packageName;
};

ParamedicRunner.prototype.getBinaryPath = function () {
    var binaryPath;
    switch (this.config.getPlatformId()) {
        case 'android':
            binaryPath = path.join(this.tempFolder.name, 'platforms/android/build/outputs/apk', this.getBinaryName());
            break;
        case 'ios':
            binaryPath = path.join(this.tempFolder.name, 'platforms/ios/build/emulator/', this.getBinaryName());
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
    }
    return binaryPath;
};

ParamedicRunner.prototype.getBinaryName = function () {
    var binaryName;
    switch (this.config.getPlatformId()) {
        case 'android':
            binaryName = 'android-debug.apk';
            break;
        case 'ios':
            binaryName = 'HelloCordova.app';
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
    }
    return binaryName;
};

ParamedicRunner.prototype.getAppName = function () {
    var appName;
    switch (this.config.getPlatformId()) {
        case 'android':
            appName = 'mobilespec.apk';
            break;
        case 'ios':
            appName = 'HelloCordova.zip';
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
    }
    return appName;
};

ParamedicRunner.prototype.getSauceDetails = function () {
    var self = this;
    var d = Q.defer();

    logger.normal('Getting saucelabs job details...\n');

    var sauce = new SauceLabs({
        username: self.config.getSauceUser(),
        password: self.config.getSauceKey()
    });

    sauce.getJobs(function (err, jobs) {
        for (var job in jobs) {
            if (jobs.hasOwnProperty(job) && jobs[job].name === self.config.getBuildName()) {
                var jobUrl = 'https://saucelabs.com/beta/tests/' + jobs[job].id;
                logger.normal('============================================================================================');
                logger.normal('Job name: ' + jobs[job].name);
                logger.normal('Job ID: ' + jobs[job].id);
                logger.normal('Job URL: ' + jobUrl);
                logger.normal('Video: ' + jobs[job].video_url);
                logger.normal('Appium logs: ' + jobs[job].log_url);
                if (self.config.getPlatformId() === 'android') {
                    logger.normal('Logcat logs: ' + 'https://saucelabs.com/jobs/' + jobs[job].id + '/logcat.log');
                }
                logger.normal('============================================================================================');
                logger.normal('');
                d.resolve();
                break;
            }
        }
        if (d.promise.inspect().state !== 'fulfilled') {
            logger.warn('Can not find saucelabs job. Logs and video will be unavailable.');
            d.resolve();
        }
    });
    return d.promise;
};

ParamedicRunner.prototype.runSauceTests = function () {
    logger.info('cordova-paramedic: running sauce tests');
    var self = this;
    var isTestPassed = false;
    var pollForResults;
    var driver;

    return self.packageApp()
    .then(self.uploadApp.bind(self))
    .then(function() {
        logger.normal('cordova-paramedic: app uploaded; starting tests');

        var user = self.config.getSauceUser();
        var key = self.config.getSauceKey();

        var caps = {
            name: self.config.getBuildName(),
            browserName: '',
            appiumVersion: '1.5.2',
            deviceOrientation: 'portrait',
            deviceType: 'phone',
            idleTimeout: '100', // in seconds
            app: 'sauce-storage:' + self.getAppName()
        };

        switch(self.config.getPlatformId()) {
            case 'android':
                caps.deviceName = 'Android Emulator';
                caps.platformVersion = '4.4';
                caps.platformName = 'Android';
                caps.appPackage = 'io.cordova.hellocordova';
                caps.appActivity = 'io.cordova.hellocordova.MainActivity';
                break;
            case 'ios':
                caps.deviceName = 'iPhone Simulator';
                caps.platformVersion = '9.3';
                caps.platformName = 'iOS';
                caps.autoAcceptAlerts = true;
                break;
            default:
                throw new Error('Unsupported platform for sauce labs testing: ' + this.config.getPlatformId());
        }

        logger.normal('cordova-paramedic: connecting webdriver');

        wd.configureHttp({
            timeout: 3 * 60 * 1000,
            retryDelay: 15000,
            retries: 5
        });

        driver = wd.promiseChainRemote(SAUCE_HOST, SAUCE_PORT, user, key);
        return driver.init(caps);
    })
    .then(function () {
        if (self.config.getUseTunnel()) {
            return driver;
        }
        return driver
        .getWebviewContext()
        .then(function (webview) {
            return driver.context(webview);
        });
    })
    .then(function () {
        logger.normal('cordova-paramedic: connecting to app');

        var isAndroid = self.config.getPlatformId() === 'android';
        if (!self.config.getUseTunnel()) {
            pollForResults = setInterval(function () {
                driver.pollForEvents(isAndroid)
                .then(function (events) {
                    for (var i = 0; i < events.length; i++) {
                        self.server.emit(events[i].eventName, events[i].eventObject);
                    }
                })
                .fail(function (error) {
                    logger.warn('appium: ' + error);
                });
            }, 5000);
        }

        return self.waitForTests();
    })
    .then(function (result) {
        logger.normal('cordova-paramedic: Tests finished');
        isTestPassed = result;
    }, function (error) {
        logger.normal('cordova-paramedic: Tests failed to complete; ending appium session. The error is:\n' + error);
    })
    .fin(function () {
        if (pollForResults) {
            clearInterval(pollForResults);
        }
        return driver.quit();
    })
    .fin(self.getSauceDetails.bind(self))
    .then(function () {
        return isTestPassed;
    });
};

var storedCWD = null;

exports.run = function(paramedicConfig) {

    storedCWD = storedCWD || process.cwd();

    var runner = new ParamedicRunner(paramedicConfig, null);
    runner.storedCWD = storedCWD;

    return runner.run()
    .timeout(paramedicConfig.getTimeout(), 'This test seems to be blocked :: timeout exceeded. Exiting ...');
};
