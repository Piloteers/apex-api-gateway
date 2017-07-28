#!/usr/bin/env node
'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var fs = require('fs');
var path = require('path');
var defaultsDeep = require('lodash.defaultsdeep');
var entries = require('lodash.topairs');
var yargs = require('yargs');
var AWS = require('aws-sdk');
var apigateway = new AWS.APIGateway();

var args = yargs.usage('Usage: $0 <command> [options]').alias('c', 'config').nargs('c', 1).describe('c', 'Apex project JSON file location').command('create <name> [description] [cloneFrom]', 'Create a new REST API on AWS API Gateway', {
  force: {
    alias: 'f',
    describe: 'Force creating REST API overriding existing configuration'
  }
}, create).command('update', 'Update the REST API with the new Swagger definitions', {
  stdout: {
    describe: 'Output swagger to console without deploying'
  }
}, update).help().argv;

function create(_ref) {
  var name = _ref.name,
      _ref$description = _ref.description,
      description = _ref$description === undefined ? null : _ref$description,
      _ref$cloneFrom = _ref.cloneFrom,
      cloneFrom = _ref$cloneFrom === undefined ? '' : _ref$cloneFrom,
      _ref$config = _ref.config,
      config = _ref$config === undefined ? './project.json' : _ref$config,
      force = _ref.force;

  var projectConfig = loadConfig(config);

  if (!force && projectConfig && projectConfig['x-api-gateway'] && projectConfig['x-api-gateway']['rest-api-id']) {
    console.error('A REST API id is already defined the project.json, if you really want to overrid' + 'e this use -f parameter');
    return;
  }

  var params = {
    name: name,
    cloneFrom: cloneFrom,
    description: description
  };
  apigateway.createRestApi(params, function (err, data) {
    if (err) {
      console.log(err, err.stack);
      return;
    }

    var updatedConfig = JSON.stringify(Object.assign({}, projectConfig, _defineProperty({}, 'x-api-gateway', Object.assign({}, projectConfig['x-api-gateway'], { 'rest-api-id': data.id }))), null, 2);

    fs.writeFile(config, updatedConfig, function (err) {
      if (err) throw err;

      console.log('Success! Now you can push your REST API using update command.');
    });
  });
}

function update(_ref2) {
  var config = _ref2.config,
      stdout = _ref2.stdout;

  var projectConfig = loadConfig(config);

  if (!projectConfig['x-api-gateway'] || !projectConfig['x-api-gateway']['rest-api-id']) {
    throw new Error('Missing REST API id, you might want to use create command first.');
  }

  var restApiId = projectConfig['x-api-gateway']['rest-api-id'];

  var renderMethod = function renderMethod(name, _ref3) {
    var _defaultsDeep;

    var description = _ref3.description,
        parameters = _ref3['x-api-gateway'].parameters;

    var template = projectConfig['x-api-gateway']['swagger-func-template'];
    return defaultsDeep((_defaultsDeep = {
      description: description
    }, _defineProperty(_defaultsDeep, 'x-amazon-apigateway-integration', {
      httpMethod: 'post',
      uri: template['x-amazon-apigateway-integration'].uri.replace('{{functionName}}', projectConfig.name + '_' + name)
    }), _defineProperty(_defaultsDeep, 'parameters', parameters), _defaultsDeep), template);
  };

  var renderPaths = function renderPaths(functions) {
    var paths = {};

    functions.map(function (_ref4) {
      var name = _ref4.name,
          definition = _ref4.definition;

      var xapigateway = definition['x-api-gateway'];

      if (!xapigateway) {
        console.log("Skipping non-API function ", name);
        return;
      }

      var path = xapigateway.path,
          method = xapigateway.method;

      if (!path || !method) {
        return;
      }

      console.log("Adding API function ", name);
      paths[path] = paths[path] || {};
      paths[path][method] = renderMethod(name, definition);
    });

    entries(projectConfig['x-api-gateway']['paths']).forEach(function (_ref5) {
      var _ref6 = _slicedToArray(_ref5, 2),
          key = _ref6[0],
          value = _ref6[1];

      var keyPattern = new RegExp('^' + key + '$');
      var matchedPaths = entries(paths).filter(function (_ref7) {
        var _ref8 = _slicedToArray(_ref7, 1),
            path = _ref8[0];

        return keyPattern.test(path);
      });

      matchedPaths.forEach(function (_ref9) {
        var _ref10 = _slicedToArray(_ref9, 2),
            path = _ref10[0],
            pathValue = _ref10[1];

        defaultsDeep(pathValue, value); // paths local mutation seems to be the best
      });
    });

    return paths;
  };

  var functionsDefs = fs.readdirSync(path.join(process.cwd(), './functions')).filter(function (value) {
    return value.substring(0, 1) != ".";
  }).map(function (folder) {
    try {
      var functionDef = require(path.join(process.cwd(), './functions/' + folder + '/function.json'));

      return { name: folder, definition: functionDef };
    } catch (e) {
      return;
    }
  });

  var swagger = {
    "swagger": "2.0",
    "info": {
      "version": new Date().toISOString(),
      "title": projectConfig.name
    },
    "basePath": projectConfig['x-api-gateway'].base_path,
    "schemes": ["https"],
    "paths": renderPaths(functionsDefs),
    "securityDefinitions": projectConfig['x-api-gateway'].securityDefinitions,
    "definitions": projectConfig['x-api-gateway'].definitions,
    "x-amazon-apigateway-request-validator": projectConfig['x-api-gateway']['x-amazon-apigateway-request-validator']
  };

  if (stdout) {
    process.stdout.write(JSON.stringify(swagger, null, 2));
    return;
  }

  console.log('Pushing REST API...');

  var params = {
    body: JSON.stringify(swagger),
    restApiId: restApiId,
    mode: 'overwrite'
  };
  apigateway.putRestApi(params, function (err, data) {
    if (err) {
      console.log(err, err.stack);
      return;
    }

    console.log('Updated API successfully.');
    console.log('Deploying REST API...');

    var params = {
      restApiId: restApiId,
      stageName: projectConfig['x-api-gateway']['stage_name']
    };
    apigateway.createDeployment(params, function (err, data) {
      if (err) {
        console.log(err, err.stack);
        return;
      }

      console.log('API deployed successfully!');
    });
  });
}

function loadConfig() {
  var projectFile = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : './project.json';

  return require(path.join(process.cwd(), projectFile));
}