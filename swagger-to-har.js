/**
 * Translates given Swagger 2.0 file to an array of HTTP Archive (HAR) 1.2 Request Object.
 * See more:
 *  - http://swagger.io/specification/
 *  - http://www.softwareishard.com/blog/har-12-spec/#request
 *
 * Example HAR Request Object:
 * "request": {
 *   "method": "GET",
 *   "url": "http://www.example.com/path/?param=value",
 *   "httpVersion": "HTTP/1.1",
 *   "cookies": [],
 *   "headers": [],
 *   "queryString" : [],
 *   "postData" : {},
 *   "headersSize" : 150,
 *   "bodySize" : 0,
 *   "comment" : ""
 *   "_swaggerSettings": {}
 * }
 */
var Instantiator = require("./schema-instantiator.js");

/**
 * Create HAR Request object for path and method pair described in given swagger.
 *
 * @param  {Object} swagger           Swagger document
 * @param  {string} path              Key of the path
 * @param  {string} method            Key of the method
 * @param  {Object} queryParamValues  Optional: Values for the query parameters if present
 * @return {Object}                   HAR Request object
 */
var createHar = function(swagger, path, method, queryParamValues, apiKey) {
  // if the operational parameter is not provided, set it to empty object
  if (typeof queryParamValues === "undefined") {
    queryParamValues = {};
  }

  var baseUrl = getBaseUrl(swagger);

  var har = {
    method: method.toUpperCase(),
    url: baseUrl + path,
    headers: getHeadersArray(swagger, path, method, apiKey),
    queryString: getQueryStrings(swagger, path, method, queryParamValues),
    httpVersion: "HTTP/1.1",
    cookies: [],
    headersSize: 0,
    bodySize: 0,
    // Custom Swagger Settings for Yapstone
    _swaggerSettings: {
      originalMethod: JSON.parse(JSON.stringify(swagger.paths[path][method])),
      path: path,
      pathParams: getPathParams(swagger, path, method),
      requiredHeaderParams: getRequiredHeaderParams(swagger, path, method, apiKey)
    }
  };

  // get payload data, if available:
  var postData = getPayload(swagger, path, method);
  if (postData) har.postData = postData;

  return har;
};

/**
 * Get the payload definition for the given endpoint (path + method) from the
 * given OAI specification. References within the payload definition are
 * resolved.
 *
 * @param  {object} swagger
 * @param  {string} path
 * @param  {string} method
 * @return {object}
 */
var getPayload = function(swagger, path, method) {
  if (typeof swagger.paths[path][method].requestBody !== "undefined" && typeof swagger.paths[path][method].requestBody.content !== "undefined") {
    var contentType = getFirstContentTypeFromContent(swagger.paths[path][method].requestBody.content)
    if(typeof contentType !== 'undefined') {
      return {
        mimeType: contentType,
        text: JSON.stringify(
          Instantiator.instantiate(
            swagger.paths[path][method].requestBody.content[contentType]
              .schema
          )
        )
      };
    }
  }
  return null;
};

/**
 * Get a complete JSON schema from Swagger, where all references ($ref) are
 * resolved. $ref appear:
 * - as properties
 * - as items
 *
 * @param  {[type]} swagger [description]
 * @param  {[type]} schema  [description]
 * @param  {[type]} ref     [description]
 * @return {[type]}         [description]
 */
var getResolvedSchema = function(swagger, schema) {
  if (schema.type === "object") {
    if (typeof schema.properties !== "undefined") {
      for (var propKey in schema.properties) {
        var prop = schema.properties[propKey];
        if (typeof prop["$ref"] === "string" && !/^http/.test(prop["$ref"])) {
          var ref = prop["$ref"].split("/").slice(-1)[0];
          schema.properties[propKey] = swagger.definitions[ref];
        }
        getResolvedSchema(swagger, schema.properties[propKey]);
      }
    }
  } else if (schema.type === "array") {
    if (typeof schema.items !== "undefined") {
      for (var itemKey in schema.items) {
        if (itemKey === "$ref" && !/^http/.test(schema.items[itemKey])) {
          var ref2 = schema.items["$ref"].split("/").slice(-1)[0];
          schema.items = swagger.definitions[ref2];
        }
        getResolvedSchema(swagger, schema.items);
      }
    }
  }
  return schema;
};

/**
 * Gets the base URL constructed from the given swagger.
 *
 * @param  {Object} swagger Swagger document
 * @return {string}         Base URL
 */
var getBaseUrl = function(swagger) {
  if(swagger.servers && swagger.servers.length > 0) {
    return swagger.servers[0].url
  }
};

/**
 * Get array of objects describing the query parameters for a path and method pair
 * described in the given swagger.
 *
 * @param  {Object} swagger Swagger document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @param  {Object} values  Optional: query parameter values to use in the snippet if present
 * @return {array}          List of objects describing the query strings
 */
var getQueryStrings = function(swagger, path, method, values) {
  // Set the optional parameter if it's not provided
  if (typeof values === "undefined") {
    values = {};
  }

  var queryStrings = [];

  if (typeof swagger.paths[path][method].parameters !== "undefined") {
    for (var i in swagger.paths[path][method].parameters) {
      var param = swagger.paths[path][method].parameters[i];
      if (typeof param["$ref"] === "string" && !/^http/.test(param["$ref"])) {
        param = resolveRef(swagger, param["$ref"]);
      }
      if (
        typeof param.in !== "undefined" &&
        param.in.toLowerCase() === "query"
      ) {
        var type = param.in ? param.schema.type : param.type;

        var exampleVal = typeof param.schema && param.schema.example !== 'undefined' ? param.schema.example + "" : undefined

        queryStrings.push({
          name: param.name,
          value: exampleVal ? exampleVal : (typeof values[param.name] === "undefined"
          ? typeof param.default === "undefined"
            ? "SOME_" + type.toUpperCase() + "_VALUE"
            : param.default + ""
          : values[param.name] +
            "")
             /* adding a empty string to convert to string */
        });
      }
    }
  }

  return queryStrings;
};

/**
 * Get an array of objects describing the header for a path and method pair
 * described in the given swagger.
 *
 * @param  {Object} swagger Swagger document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @return {array}          List of objects describing the header
 */
var getHeadersArray = function(swagger, path, method, apiKey) {
  var headers = [];

  var pathObj = swagger.paths[path][method];

  if(pathObj && pathObj.requestBody && pathObj.requestBody.content) {
    var contentType = getFirstContentTypeFromContent(pathObj.requestBody.content)
  } else {
    // Fallback to json
    var contentType = 'application/json'
  }

  // 'accept' header:
  headers.push({
    name: "accept",
    value: contentType
  });

  // 'content-type' header:
  headers.push({
    name: "content-type",
    value: contentType
  });

  // headers defined in path object:
  if (typeof pathObj.parameters !== "undefined") {
    for (var k in pathObj.parameters) {
      var param = pathObj.parameters[k];
      if (
        typeof param.in !== "undefined" &&
        param.in.toLowerCase() === "header" &&
        param.required
      ) if(param.name === 'Authorization' && apiKey) {
        headers.push({
          name: param.name,
          value: 'Bearer ' + apiKey,
          type: param.schema.type
        });
      } else {
        headers.push({
          name: param.name,
          value: param.example
            ? param.example
            : "SOME_" + param.name.toUpperCase() + "_VALUE",
          type: param.schema.type
        });
      }
    }
  }

  return headers;
};

/**
 * Produces array of HAR files for given Swagger document
 *
 * @param  {object}   swagger          A swagger document
 * @param  {Function} callback
 */
var swaggerToHarList = function(swagger) {
  try {
    // determine basePath:
    var baseUrl = getBaseUrl(swagger);

    // iterate Swagger and create har objects:
    var harList = [];
    for (var path in swagger.paths) {
      for (var method in swagger.paths[path]) {
        var url = baseUrl + path;
        var har = createHar(swagger, path, method);
        harList.push({
          method: method.toUpperCase(),
          url: url,
          description:
            swagger.paths[path][method].description ||
            "No description available",
          har: har
        });
      }
    }

    return harList;
  } catch (e) {
    return null;
  }
};

/**
 * Returns the value referenced in the given reference string
 *
 * @param  {object} oai
 * @param  {string} ref A reference string
 * @return {any}
 */
var resolveRef = function(oai, ref) {
  var parts = ref.split("/");

  if (parts.length <= 1) return {}; // = 3

  var recursive = function(obj, index) {
    if (index + 1 < parts.length) {
      // index = 1
      var newCount = index + 1;
      return recursive(obj[parts[index]], newCount);
    } else {
      return obj[parts[index]];
    }
  };
  return recursive(oai, 1);
};

var getPathParams = function(swagger, path, method) {
  // Set the optional parameter if it's not provided
  if (typeof values === "undefined") {
    values = {};
  }

  var pathParams = [];

  if (typeof swagger.paths[path][method].parameters !== "undefined") {
    for (var i in swagger.paths[path][method].parameters) {
      var param = swagger.paths[path][method].parameters[i];
      if (typeof param["$ref"] === "string" && !/^http/.test(param["$ref"])) {
        param = resolveRef(swagger, param["$ref"]);
      }
      if (
        typeof param.in !== "undefined" &&
        param.in.toLowerCase() === "path"
      ) {
        var type = param.in ? param.schema.type : param.type;

        var value = param.example
          ? param.example
          : typeof values[param.name] === "undefined"
          ? typeof param.default === "undefined"
            ? "SOME_" + type.toUpperCase() + "_VALUE"
            : param.default + ""
          : values[param.name] +
            ""; /* adding a empty string to convert to string */

        pathParams.push({
          name: param.name,
          value: value,
          type: param.schema.type
        });
      }
    }
  }

  return pathParams;
};

var getRequiredHeaderParams = function(swagger, path, method, apiKey) {
  var headers = [];

  var pathObj = swagger.paths[path][method];

  // headers defined in path object:
  if (typeof pathObj.parameters !== "undefined") {
    for (var k in pathObj.parameters) {
      var param = pathObj.parameters[k];
      if (
        typeof param.in !== "undefined" &&
        param.in.toLowerCase() === "header" &&
        param.required
      ) {
        if(param.name === 'Authorization' && apiKey) {
          headers.push({
            name: param.name,
            value: apiKey,
            type: param.schema.type
          });
        } else {
          headers.push({
            name: param.name,
            value: param.example
              ? param.example
              : "SOME_" + param.name.toUpperCase() + "_VALUE",
            type: param.schema.type
          });
        }
      }
    }
  }

  return headers;
};

var getFirstContentTypeFromContent = function(contentObj) {
  return Object.keys(contentObj)[0]
}

module.exports = {
  getAll: swaggerToHarList,
  getEndpoint: createHar
};
