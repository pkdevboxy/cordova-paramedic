#!/usr/bin/env node

var parseArgs       = require('minimist');
var path            = require('path');
var paramedic       = require('./lib/paramedic');
var ParamedicConfig = require('./lib/ParamedicConfig');

var USAGE           = "Error missing args. \n" +
    "cordova-paramedic --platform PLATFORM --plugin PATH [--justbuild --timeout MSECS --startport PORTNUM --endport PORTNUM --browserify]\n" +
    "`PLATFORM` : the platform id. Currently supports 'ios', 'browser', 'windows', 'android', 'wp8'.\n" +
                    "\tPath to platform can be specified as link to git repo like:\n" +
                    "\twindows@https://github.com/apache/cordova-windows.git\n" +
                    "\tor path to local copied git repo like:\n" +
                    "\twindows@../cordova-windows/\n" +
    "`PATH` : the relative or absolute path to a plugin folder\n" +
                    "\texpected to have a 'tests' folder.\n" +
                    "\tYou may specify multiple --plugin flags and they will all\n" +
                    "\tbe installed and tested together.\n" +
    "`MSECS` : (optional) time in millisecs to wait for tests to pass|fail \n" +
              "\t(defaults to 10 minutes) \n" +
    "`PORTNUM` : (optional) ports to find available and use for posting results from emulator back to paramedic server(default is from 8008 to 8009)\n" +
    "--justbuild : (optional) just builds the project, without running the tests \n" +
    "--browserify : (optional) plugins are browserified into cordova.js \n" +
    "--verbose : (optional) verbose mode. Display more information output\n" +
    "--useTunnel : (optional) use tunneling instead of local address. default is false\n" +
    "--config : (optional) read configuration from paramedic configuration file\n" +
    "--outputDir: (optional) path to save Junit results file & Device logs\n" +
    "--cleanUpAfterRun: (optional) cleans up the application after the run\n" +
    "--logMins: (optional) Windows only - specifies number of minutes to get logs\n" +
    "--tccDb: (optional) iOS only - specifies the path for the TCC.db file to be copied." +
    "--shouldUseSauce: (optional) run tests on Saucelabs\n" +
    "--buildName: (optional) Build name to show in Saucelabs dashboard\n" +
    "--sauceUser: (optional) Saucelabs username\n" +
    "--sauceKey: (optional) Saucelabs access key";

var argv = parseArgs(process.argv.slice(2));
var pathToParamedicConfig = argv.config && path.resolve(argv.config);

if (pathToParamedicConfig || // --config
    argv.platform && argv.plugin) { // or --platform and --plugin

    var paramedicConfig = pathToParamedicConfig ?
        ParamedicConfig.parseFromFile(pathToParamedicConfig):
        ParamedicConfig.parseFromArguments(argv);

    if (argv.plugin) {
        paramedicConfig.setPlugins(argv.plugin);
    }

    if (argv.outputDir) {
        paramedicConfig.setOutputDir(argv.outputDir);
    }

    if (argv.logMins) {
        paramedicConfig.setLogMins(argv.logMins);
    }

    if (argv.tccDb){
        paramedicConfig.setTccDb(argv.tccDb);
    }

    if (argv.platform) {
        paramedicConfig.setPlatform(argv.platform);
    }

    if (argv.action) {
        paramedicConfig.setAction(argv.action);
    }

    if (argv.shouldUseSauce) {
        if (argv.shouldUseSauce === 'false') {
            argv.shouldUseSauce = false;
        }
        paramedicConfig.setShouldUseSauce(argv.shouldUseSauce);
    }

    if (argv.buildName) {
        paramedicConfig.setBuildName(argv.buildName);
    }

    if (argv.sauceUser) {
        paramedicConfig.setSauceUser(argv.sauceUser);
    }

    if (argv.sauceKey) {
        paramedicConfig.setSauceKey(argv.sauceKey);
    }

    if (argv.useTunnel) {
        if (argv.useTunnel === 'false') {
            argv.useTunnel = false;
        }
        paramedicConfig.setUseTunnel(argv.useTunnel);
    }

    paramedic.run(paramedicConfig)
    .catch(function (error) {
        if (error && error.stack) {
            console.error(error.stack);
        } else if (error) {
            console.error(error);
        }
        process.exit(1);
    })
    .done(function(isTestPassed) {
        process.exit(isTestPassed ? 0 : 1);
    });

} else {
    console.log(USAGE);
    process.exit(1);
}
