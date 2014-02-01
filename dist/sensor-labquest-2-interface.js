!function(e){"object"==typeof exports?module.exports=e():"function"==typeof define&&define.amd?define(e):"undefined"!=typeof window?window.sensorLabquest2Interface=e():"undefined"!=typeof global?global.sensorLabquest2Interface=e():"undefined"!=typeof self&&(self.sensorLabquest2Interface=e())}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/*global XDomainRequest */

'use strict';

// datasets[]
//   columns[]
//     id
//     units
//     data[]
//     requestedValuesTimeStamp
//     receivedValuesTimeStamp

var RSVP = require('rsvp');

var EventEmitter2 = require('eventemitter2').EventEmitter2;
var events = new EventEmitter2({
    wildcard: true
});

var urlPrefix = '';
var TIME_LIMIT_IN_MS = 5000;

var isPolling = false;

var datasets;
var datasetsById;
var columnsById;
var sessionChangedEmitted;
var currentSessionID;

function initializeSession() {
    datasets = [];
    datasetsById = Object.create(null);
    columnsById = Object.create(null);
    sessionChangedEmitted = false;
}

// see http://www.html5rocks.com/en/tutorials/cors/
function createCORSRequest(method, relativeUrl) {
    var url = urlPrefix + relativeUrl;
    var xhr = new XMLHttpRequest();

    if ('withCredentials' in xhr) {
        xhr.open(method, url, true);
        xhr.responseType = 'json';
        xhr.setRequestHeader('Accept', 'application/json');
    } else if (typeof XDomainRequest !== 'undefined') {
        // IE8/9's XMLHttpRequest object doesn't support CORS; instead, you have to use an
        // 'XDomainRequest' object
        xhr = new XDomainRequest();
        // we can't set custom headers in IE9
        // see http://blogs.msdn.com/b/ieinternals/archive/2010/05/13/xdomainrequest-restrictions-limitations-and-workarounds.aspx
        xhr.open(method, url);
    } else {
        return null;
    }

    return xhr;
}

var lastStatusTimeStamp = 0;
var isConnected = false;
var isCollecting = false;

// called by timeoutTimer
function connectionTimedOut() {
    events.emit('connectionTimedOut');
    isConnected = false;
}

var timeoutTimer = {
    start: function() {
        this.timerId = setTimeout(connectionTimedOut, TIME_LIMIT_IN_MS);
    },

    reset: function() {
        this.stop();
        this.start();
    },

    stop: function() {
        clearTimeout(this.timerId);
    }
};

var statusIntervalId;

function requestStatus() {
    var xhr = createCORSRequest('GET', '/status');
    // TODO set xhr timeout

    if (!xhr) {
        statusErrored();
        return;
    }

    xhr.onerror = statusErrored;
    xhr.onload = statusLoaded;
    xhr.send();
}

function statusErrored() {
    events.emit('statusErrored');
}

function statusLoaded() {
    var response = this.response || JSON.parse(this.responseText);

    if ( ! isPolling ) {
        return;
    }

    if (response.requestTimeStamp < lastStatusTimeStamp) {
        // stale out-of-order response; drop it like we never got it.
        return;
    }

    if ( ! currentSessionID ) {
        currentSessionID = response.sessionID;
        initializeSession();
    } else if (currentSessionID !== response.sessionID) {
        // Session ID changed on us unexpectedly. Client should probably stop polling, start polling.
        if ( ! sessionChangedEmitted) {
            events.emit('sessionChanged');
            sessionChangedEmitted = true;
        }
        return;
    }

    lastStatusTimeStamp = response.requestTimeStamp;

    timeoutTimer.reset();
    processDatasets(response.sets);
    processColumns(response.columns);

    // TODO liveValue

    isConnected = true;

    events.emit('statusReceived');

    if (isCollecting && ! response.collection.isCollecting) {
        isCollecting = false;
        events.emit('collectionStopped');
    } else if (! isCollecting && response.collection.isCollecting) {
        isCollecting = true;
        events.emit('collectionStarted');
    }
}

// Handle 'datasets' and 'columns' in the response
function processDatasets(sets) {
    Object.keys(sets).forEach(function(setId) {
        if ( ! datasetsById[setId] ) {
            // mind, no datasetAdded is emitted until the second collection because the first
            // dataset always exists
            events.emit('datasetAdded', setId);
            datasetsById[setId] = {
                columns: [],
                id: setId
            };
            datasets.unshift(datasetsById[setId]);
        }
    });
    // make sure the highest-numbered dataset is always datasets[0]
    datasets.sort(function(d1, d2) { return d2.setId-d1.setId; });
}

function processColumns(cols) {
    // looks familiar
    Object.keys(cols).forEach(function(colId) {
        var eventsToEmit = [];
        var columnFromResponse = cols[colId];
        var dataset = datasetsById[columnFromResponse.setID];
        var column = columnsById[colId];

        if ( ! column ) {
            eventsToEmit.push('columnAdded');
            // Remember, the column information can change
            // HOWEVER, assume a column is never removed from one dataset and added to another
            column = columnsById[colId] = {
                id: null,
                units: null,
                receivedValuesTimeStamp: 0,
                requestedValuesTimeStamp: 0,
                data: []
            };
        } else if (column !== dataset.columns[columnFromResponse.position]) {
            eventsToEmit.push('columnMoved');
        }

        dataset.columns[columnFromResponse.position] = column;

        if (column.units && column.units !== columnFromResponse.units) {
            eventsToEmit.push('columnTypeChanged');
        }

        column.units = columnFromResponse.units;
        column.id = colId;

        if (column.requestedValuesTimeStamp < columnFromResponse.valuesTimeStamp) {
            requestData(colId, columnFromResponse.valuesTimeStamp);
            column.requestedValuesTimeStamp = columnFromResponse.valuesTimeStamp;
        }

        eventsToEmit.forEach(function(eventName) {
            events.emit(eventName, colId);
        });
    });

    // Find columns that were removed.
    Object.keys(columnsById).forEach(function(colId) {
        if ( ! cols[colId] ) {
            events.emit('columnRemoved', colId);
            delete columnsById[colId];
        }
    });
}

// Request data if status indicates there's more data
function requestData(colId, timeStamp) {
    var xhr = createCORSRequest('GET', '/columns/' + colId);
    // look, we wouldn't have got here if we didn't support CORS
    xhr.send();

    xhr.onload = function() {
        if ( ! isPolling ) {
            return;
        }
        var response = this.response || JSON.parse(this.responseText);
        var values = response.values;
        var column = columnsById[colId];
        if (timeStamp > column.receivedValuesTimeStamp) {
            column.data.length = 0;
            [].push.apply(column.data, values);
            column.receivedValuesTimeStamp = timeStamp;
            events.emit('data', colId);
        }
    };
}

function promisifyRequest(url) {
    return function() {
        return new RSVP.Promise(function(resolve, reject) {
            var xhr = createCORSRequest('GET', url);
            if ( ! xhr ) {
                reject(new Error("This browser does not appear to support Cross-Origin Resource Sharing"));
            }
            xhr.send();

            // Simply emitting errors isn't quite right because there's no way for the consumer
            // to tie the error to the particular start request
            xhr.onerror = function() {
                reject(this);
            };
            xhr.onload = resolve;
        });
    };
}

module.exports = {

    startPolling: function(address) {
        urlPrefix = 'http://' + address;

        requestStatus();
        isPolling = true;
        isConnected = false;
        timeoutTimer.start();
        statusIntervalId = setInterval(requestStatus, 500);
    },

    stopPolling: function() {
        timeoutTimer.stop();
        clearInterval(statusIntervalId);
        currentSessionID = undefined;
        isPolling = false;
    },

    requestStart: promisifyRequest('/control/start'),

    requestStop: promisifyRequest('/control/stop'),

    on: function() {
        events.on.apply(events, arguments);
    },

    get datasets() {
        return datasets;
    },

    get isConnected() {
        return isPolling && isConnected;
    },

    get isCollecting() {
        return isPolling && isConnected && isCollecting;
    }
};

},{"eventemitter2":3,"rsvp":4}],2:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],3:[function(require,module,exports){
var process=require("__browserify_process");;!function(exports, undefined) {

  var isArray = Array.isArray ? Array.isArray : function _isArray(obj) {
    return Object.prototype.toString.call(obj) === "[object Array]";
  };
  var defaultMaxListeners = 10;

  function init() {
    this._events = {};
    if (this._conf) {
      configure.call(this, this._conf);
    }
  }

  function configure(conf) {
    if (conf) {

      this._conf = conf;

      conf.delimiter && (this.delimiter = conf.delimiter);
      conf.maxListeners && (this._events.maxListeners = conf.maxListeners);
      conf.wildcard && (this.wildcard = conf.wildcard);
      conf.newListener && (this.newListener = conf.newListener);

      if (this.wildcard) {
        this.listenerTree = {};
      }
    }
  }

  function EventEmitter(conf) {
    this._events = {};
    this.newListener = false;
    configure.call(this, conf);
  }

  //
  // Attention, function return type now is array, always !
  // It has zero elements if no any matches found and one or more
  // elements (leafs) if there are matches
  //
  function searchListenerTree(handlers, type, tree, i) {
    if (!tree) {
      return [];
    }
    var listeners=[], leaf, len, branch, xTree, xxTree, isolatedBranch, endReached,
        typeLength = type.length, currentType = type[i], nextType = type[i+1];
    if (i === typeLength && tree._listeners) {
      //
      // If at the end of the event(s) list and the tree has listeners
      // invoke those listeners.
      //
      if (typeof tree._listeners === 'function') {
        handlers && handlers.push(tree._listeners);
        return [tree];
      } else {
        for (leaf = 0, len = tree._listeners.length; leaf < len; leaf++) {
          handlers && handlers.push(tree._listeners[leaf]);
        }
        return [tree];
      }
    }

    if ((currentType === '*' || currentType === '**') || tree[currentType]) {
      //
      // If the event emitted is '*' at this part
      // or there is a concrete match at this patch
      //
      if (currentType === '*') {
        for (branch in tree) {
          if (branch !== '_listeners' && tree.hasOwnProperty(branch)) {
            listeners = listeners.concat(searchListenerTree(handlers, type, tree[branch], i+1));
          }
        }
        return listeners;
      } else if(currentType === '**') {
        endReached = (i+1 === typeLength || (i+2 === typeLength && nextType === '*'));
        if(endReached && tree._listeners) {
          // The next element has a _listeners, add it to the handlers.
          listeners = listeners.concat(searchListenerTree(handlers, type, tree, typeLength));
        }

        for (branch in tree) {
          if (branch !== '_listeners' && tree.hasOwnProperty(branch)) {
            if(branch === '*' || branch === '**') {
              if(tree[branch]._listeners && !endReached) {
                listeners = listeners.concat(searchListenerTree(handlers, type, tree[branch], typeLength));
              }
              listeners = listeners.concat(searchListenerTree(handlers, type, tree[branch], i));
            } else if(branch === nextType) {
              listeners = listeners.concat(searchListenerTree(handlers, type, tree[branch], i+2));
            } else {
              // No match on this one, shift into the tree but not in the type array.
              listeners = listeners.concat(searchListenerTree(handlers, type, tree[branch], i));
            }
          }
        }
        return listeners;
      }

      listeners = listeners.concat(searchListenerTree(handlers, type, tree[currentType], i+1));
    }

    xTree = tree['*'];
    if (xTree) {
      //
      // If the listener tree will allow any match for this part,
      // then recursively explore all branches of the tree
      //
      searchListenerTree(handlers, type, xTree, i+1);
    }

    xxTree = tree['**'];
    if(xxTree) {
      if(i < typeLength) {
        if(xxTree._listeners) {
          // If we have a listener on a '**', it will catch all, so add its handler.
          searchListenerTree(handlers, type, xxTree, typeLength);
        }

        // Build arrays of matching next branches and others.
        for(branch in xxTree) {
          if(branch !== '_listeners' && xxTree.hasOwnProperty(branch)) {
            if(branch === nextType) {
              // We know the next element will match, so jump twice.
              searchListenerTree(handlers, type, xxTree[branch], i+2);
            } else if(branch === currentType) {
              // Current node matches, move into the tree.
              searchListenerTree(handlers, type, xxTree[branch], i+1);
            } else {
              isolatedBranch = {};
              isolatedBranch[branch] = xxTree[branch];
              searchListenerTree(handlers, type, { '**': isolatedBranch }, i+1);
            }
          }
        }
      } else if(xxTree._listeners) {
        // We have reached the end and still on a '**'
        searchListenerTree(handlers, type, xxTree, typeLength);
      } else if(xxTree['*'] && xxTree['*']._listeners) {
        searchListenerTree(handlers, type, xxTree['*'], typeLength);
      }
    }

    return listeners;
  }

  function growListenerTree(type, listener) {

    type = typeof type === 'string' ? type.split(this.delimiter) : type.slice();

    //
    // Looks for two consecutive '**', if so, don't add the event at all.
    //
    for(var i = 0, len = type.length; i+1 < len; i++) {
      if(type[i] === '**' && type[i+1] === '**') {
        return;
      }
    }

    var tree = this.listenerTree;
    var name = type.shift();

    while (name) {

      if (!tree[name]) {
        tree[name] = {};
      }

      tree = tree[name];

      if (type.length === 0) {

        if (!tree._listeners) {
          tree._listeners = listener;
        }
        else if(typeof tree._listeners === 'function') {
          tree._listeners = [tree._listeners, listener];
        }
        else if (isArray(tree._listeners)) {

          tree._listeners.push(listener);

          if (!tree._listeners.warned) {

            var m = defaultMaxListeners;

            if (typeof this._events.maxListeners !== 'undefined') {
              m = this._events.maxListeners;
            }

            if (m > 0 && tree._listeners.length > m) {

              tree._listeners.warned = true;
              console.error('(node) warning: possible EventEmitter memory ' +
                            'leak detected. %d listeners added. ' +
                            'Use emitter.setMaxListeners() to increase limit.',
                            tree._listeners.length);
              console.trace();
            }
          }
        }
        return true;
      }
      name = type.shift();
    }
    return true;
  }

  // By default EventEmitters will print a warning if more than
  // 10 listeners are added to it. This is a useful default which
  // helps finding memory leaks.
  //
  // Obviously not all Emitters should be limited to 10. This function allows
  // that to be increased. Set to zero for unlimited.

  EventEmitter.prototype.delimiter = '.';

  EventEmitter.prototype.setMaxListeners = function(n) {
    this._events || init.call(this);
    this._events.maxListeners = n;
    if (!this._conf) this._conf = {};
    this._conf.maxListeners = n;
  };

  EventEmitter.prototype.event = '';

  EventEmitter.prototype.once = function(event, fn) {
    this.many(event, 1, fn);
    return this;
  };

  EventEmitter.prototype.many = function(event, ttl, fn) {
    var self = this;

    if (typeof fn !== 'function') {
      throw new Error('many only accepts instances of Function');
    }

    function listener() {
      if (--ttl === 0) {
        self.off(event, listener);
      }
      fn.apply(this, arguments);
    }

    listener._origin = fn;

    this.on(event, listener);

    return self;
  };

  EventEmitter.prototype.emit = function() {

    this._events || init.call(this);

    var type = arguments[0];

    if (type === 'newListener' && !this.newListener) {
      if (!this._events.newListener) { return false; }
    }

    // Loop through the *_all* functions and invoke them.
    if (this._all) {
      var l = arguments.length;
      var args = new Array(l - 1);
      for (var i = 1; i < l; i++) args[i - 1] = arguments[i];
      for (i = 0, l = this._all.length; i < l; i++) {
        this.event = type;
        this._all[i].apply(this, args);
      }
    }

    // If there is no 'error' event listener then throw.
    if (type === 'error') {

      if (!this._all &&
        !this._events.error &&
        !(this.wildcard && this.listenerTree.error)) {

        if (arguments[1] instanceof Error) {
          throw arguments[1]; // Unhandled 'error' event
        } else {
          throw new Error("Uncaught, unspecified 'error' event.");
        }
        return false;
      }
    }

    var handler;

    if(this.wildcard) {
      handler = [];
      var ns = typeof type === 'string' ? type.split(this.delimiter) : type.slice();
      searchListenerTree.call(this, handler, ns, this.listenerTree, 0);
    }
    else {
      handler = this._events[type];
    }

    if (typeof handler === 'function') {
      this.event = type;
      if (arguments.length === 1) {
        handler.call(this);
      }
      else if (arguments.length > 1)
        switch (arguments.length) {
          case 2:
            handler.call(this, arguments[1]);
            break;
          case 3:
            handler.call(this, arguments[1], arguments[2]);
            break;
          // slower
          default:
            var l = arguments.length;
            var args = new Array(l - 1);
            for (var i = 1; i < l; i++) args[i - 1] = arguments[i];
            handler.apply(this, args);
        }
      return true;
    }
    else if (handler) {
      var l = arguments.length;
      var args = new Array(l - 1);
      for (var i = 1; i < l; i++) args[i - 1] = arguments[i];

      var listeners = handler.slice();
      for (var i = 0, l = listeners.length; i < l; i++) {
        this.event = type;
        listeners[i].apply(this, args);
      }
      return (listeners.length > 0) || this._all;
    }
    else {
      return this._all;
    }

  };

  EventEmitter.prototype.on = function(type, listener) {

    if (typeof type === 'function') {
      this.onAny(type);
      return this;
    }

    if (typeof listener !== 'function') {
      throw new Error('on only accepts instances of Function');
    }
    this._events || init.call(this);

    // To avoid recursion in the case that type == "newListeners"! Before
    // adding it to the listeners, first emit "newListeners".
    this.emit('newListener', type, listener);

    if(this.wildcard) {
      growListenerTree.call(this, type, listener);
      return this;
    }

    if (!this._events[type]) {
      // Optimize the case of one listener. Don't need the extra array object.
      this._events[type] = listener;
    }
    else if(typeof this._events[type] === 'function') {
      // Adding the second element, need to change to array.
      this._events[type] = [this._events[type], listener];
    }
    else if (isArray(this._events[type])) {
      // If we've already got an array, just append.
      this._events[type].push(listener);

      // Check for listener leak
      if (!this._events[type].warned) {

        var m = defaultMaxListeners;

        if (typeof this._events.maxListeners !== 'undefined') {
          m = this._events.maxListeners;
        }

        if (m > 0 && this._events[type].length > m) {

          this._events[type].warned = true;
          console.error('(node) warning: possible EventEmitter memory ' +
                        'leak detected. %d listeners added. ' +
                        'Use emitter.setMaxListeners() to increase limit.',
                        this._events[type].length);
          console.trace();
        }
      }
    }
    return this;
  };

  EventEmitter.prototype.onAny = function(fn) {

    if(!this._all) {
      this._all = [];
    }

    if (typeof fn !== 'function') {
      throw new Error('onAny only accepts instances of Function');
    }

    // Add the function to the event listener collection.
    this._all.push(fn);
    return this;
  };

  EventEmitter.prototype.addListener = EventEmitter.prototype.on;

  EventEmitter.prototype.off = function(type, listener) {
    if (typeof listener !== 'function') {
      throw new Error('removeListener only takes instances of Function');
    }

    var handlers,leafs=[];

    if(this.wildcard) {
      var ns = typeof type === 'string' ? type.split(this.delimiter) : type.slice();
      leafs = searchListenerTree.call(this, null, ns, this.listenerTree, 0);
    }
    else {
      // does not use listeners(), so no side effect of creating _events[type]
      if (!this._events[type]) return this;
      handlers = this._events[type];
      leafs.push({_listeners:handlers});
    }

    for (var iLeaf=0; iLeaf<leafs.length; iLeaf++) {
      var leaf = leafs[iLeaf];
      handlers = leaf._listeners;
      if (isArray(handlers)) {

        var position = -1;

        for (var i = 0, length = handlers.length; i < length; i++) {
          if (handlers[i] === listener ||
            (handlers[i].listener && handlers[i].listener === listener) ||
            (handlers[i]._origin && handlers[i]._origin === listener)) {
            position = i;
            break;
          }
        }

        if (position < 0) {
          continue;
        }

        if(this.wildcard) {
          leaf._listeners.splice(position, 1);
        }
        else {
          this._events[type].splice(position, 1);
        }

        if (handlers.length === 0) {
          if(this.wildcard) {
            delete leaf._listeners;
          }
          else {
            delete this._events[type];
          }
        }
        return this;
      }
      else if (handlers === listener ||
        (handlers.listener && handlers.listener === listener) ||
        (handlers._origin && handlers._origin === listener)) {
        if(this.wildcard) {
          delete leaf._listeners;
        }
        else {
          delete this._events[type];
        }
      }
    }

    return this;
  };

  EventEmitter.prototype.offAny = function(fn) {
    var i = 0, l = 0, fns;
    if (fn && this._all && this._all.length > 0) {
      fns = this._all;
      for(i = 0, l = fns.length; i < l; i++) {
        if(fn === fns[i]) {
          fns.splice(i, 1);
          return this;
        }
      }
    } else {
      this._all = [];
    }
    return this;
  };

  EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

  EventEmitter.prototype.removeAllListeners = function(type) {
    if (arguments.length === 0) {
      !this._events || init.call(this);
      return this;
    }

    if(this.wildcard) {
      var ns = typeof type === 'string' ? type.split(this.delimiter) : type.slice();
      var leafs = searchListenerTree.call(this, null, ns, this.listenerTree, 0);

      for (var iLeaf=0; iLeaf<leafs.length; iLeaf++) {
        var leaf = leafs[iLeaf];
        leaf._listeners = null;
      }
    }
    else {
      if (!this._events[type]) return this;
      this._events[type] = null;
    }
    return this;
  };

  EventEmitter.prototype.listeners = function(type) {
    if(this.wildcard) {
      var handlers = [];
      var ns = typeof type === 'string' ? type.split(this.delimiter) : type.slice();
      searchListenerTree.call(this, handlers, ns, this.listenerTree, 0);
      return handlers;
    }

    this._events || init.call(this);

    if (!this._events[type]) this._events[type] = [];
    if (!isArray(this._events[type])) {
      this._events[type] = [this._events[type]];
    }
    return this._events[type];
  };

  EventEmitter.prototype.listenersAny = function() {

    if(this._all) {
      return this._all;
    }
    else {
      return [];
    }

  };

  if (typeof define === 'function' && define.amd) {
    define(function() {
      return EventEmitter;
    });
  } else {
    exports.EventEmitter2 = EventEmitter;
  }

}(typeof process !== 'undefined' && typeof process.title !== 'undefined' && typeof exports !== 'undefined' ? exports : window);

},{"__browserify_process":2}],4:[function(require,module,exports){
"use strict";
var Promise = require("./rsvp/promise")["default"];
var EventTarget = require("./rsvp/events")["default"];
var denodeify = require("./rsvp/node")["default"];
var all = require("./rsvp/all")["default"];
var allSettled = require("./rsvp/all_settled")["default"];
var race = require("./rsvp/race")["default"];
var hash = require("./rsvp/hash")["default"];
var rethrow = require("./rsvp/rethrow")["default"];
var defer = require("./rsvp/defer")["default"];
var config = require("./rsvp/config").config;
var configure = require("./rsvp/config").configure;
var map = require("./rsvp/map")["default"];
var resolve = require("./rsvp/resolve")["default"];
var reject = require("./rsvp/reject")["default"];
var filter = require("./rsvp/filter")["default"];
var asap = require("./rsvp/asap")["default"];

config.async = asap; // default async is asap;

function async(callback, arg) {
  config.async(callback, arg);
}

function on() {
  config.on.apply(config, arguments);
}

function off() {
  config.off.apply(config, arguments);
}

// Set up instrumentation through `window.__PROMISE_INTRUMENTATION__`
if (typeof window !== 'undefined' && typeof window.__PROMISE_INSTRUMENTATION__ === 'object') {
  var callbacks = window.__PROMISE_INSTRUMENTATION__;
  configure('instrument', true);
  for (var eventName in callbacks) {
    if (callbacks.hasOwnProperty(eventName)) {
      on(eventName, callbacks[eventName]);
    }
  }
}

exports.Promise = Promise;
exports.EventTarget = EventTarget;
exports.all = all;
exports.allSettled = allSettled;
exports.race = race;
exports.hash = hash;
exports.rethrow = rethrow;
exports.defer = defer;
exports.denodeify = denodeify;
exports.configure = configure;
exports.on = on;
exports.off = off;
exports.resolve = resolve;
exports.reject = reject;
exports.async = async;
exports.map = map;
exports.filter = filter;
},{"./rsvp/all":5,"./rsvp/all_settled":6,"./rsvp/asap":7,"./rsvp/config":8,"./rsvp/defer":9,"./rsvp/events":10,"./rsvp/filter":11,"./rsvp/hash":12,"./rsvp/map":14,"./rsvp/node":15,"./rsvp/promise":16,"./rsvp/race":22,"./rsvp/reject":23,"./rsvp/resolve":24,"./rsvp/rethrow":25}],5:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];

exports["default"] = function all(array, label) {
  return Promise.all(array, label);
};
},{"./promise":16}],6:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];
var isArray = require("./utils").isArray;
var isNonThenable = require("./utils").isNonThenable;

/**
  `RSVP.allSettled` is similar to `RSVP.all`, but instead of implementing
  a fail-fast method, it waits until all the promises have returned and
  shows you all the results. This is useful if you want to handle multiple
  promises' failure states together as a set.

  Returns a promise that is fulfilled when all the given promises have been
  settled. The return promise is fulfilled with an array of the states of
  the promises passed into the `promises` array argument.

  Each state object will either indicate fulfillment or rejection, and
  provide the corresponding value or reason. The states will take one of
  the following formats:

  ```javascript
  { state: 'fulfilled', value: value }
    or
  { state: 'rejected', reason: reason }
  ```

  Example:

  ```javascript
  var promise1 = RSVP.Promise.resolve(1);
  var promise2 = RSVP.Promise.reject(new Error('2'));
  var promise3 = RSVP.Promise.reject(new Error('3'));
  var promises = [ promise1, promise2, promise3 ];

  RSVP.allSettled(promises).then(function(array){
    // array == [
    //   { state: 'fulfilled', value: 1 },
    //   { state: 'rejected', reason: Error },
    //   { state: 'rejected', reason: Error }
    // ]
    // Note that for the second item, reason.message will be "2", and for the
    // third item, reason.message will be "3".
  }, function(error) {
    // Not run. (This block would only be called if allSettled had failed,
    // for instance if passed an incorrect argument type.)
  });
  ```

  @method @allSettled
  @for RSVP
  @param {Array} promises;
  @param {String} label - optional string that describes the promise.
  Useful for tooling.
  @return {Promise} promise that is fulfilled with an array of the settled
  states of the constituent promises.
*/

exports["default"] = function allSettled(entries, label) {
  return new Promise(function(resolve, reject) {
    if (!isArray(entries)) {
      throw new TypeError('You must pass an array to allSettled.');
    }

    var remaining = entries.length;
    var entry;

    if (remaining === 0) {
      resolve([]);
      return;
    }

    var results = new Array(remaining);

    function fulfilledResolver(index) {
      return function(value) {
        resolveAll(index, fulfilled(value));
      };
    }

    function rejectedResolver(index) {
      return function(reason) {
        resolveAll(index, rejected(reason));
      };
    }

    function resolveAll(index, value) {
      results[index] = value;
      if (--remaining === 0) {
        resolve(results);
      }
    }

    for (var index = 0; index < entries.length; index++) {
      entry = entries[index];

      if (isNonThenable(entry)) {
        resolveAll(index, fulfilled(entry));
      } else {
        Promise.cast(entry).then(fulfilledResolver(index), rejectedResolver(index));
      }
    }
  }, label);
};

function fulfilled(value) {
  return { state: 'fulfilled', value: value };
}

function rejected(reason) {
  return { state: 'rejected', reason: reason };
}
},{"./promise":16,"./utils":26}],7:[function(require,module,exports){
var process=require("__browserify_process");"use strict";
exports["default"] = function asap(callback, arg) {
  var length = queue.push([callback, arg]);
  if (length === 1) {
    // If length is 1, that means that we need to schedule an async flush.
    // If additional callbacks are queued before the queue is flushed, they
    // will be processed by this flush that we are scheduling.
    scheduleFlush();
  }
};

var browserGlobal = (typeof window !== 'undefined') ? window : {};
var BrowserMutationObserver = browserGlobal.MutationObserver || browserGlobal.WebKitMutationObserver;

// node
function useNextTick() {
  return function() {
    process.nextTick(flush);
  };
}

function useMutationObserver() {
  var iterations = 0;
  var observer = new BrowserMutationObserver(flush);
  var node = document.createTextNode('');
  observer.observe(node, { characterData: true });

  return function() {
    node.data = (iterations = ++iterations % 2);
  };
}

function useSetTimeout() {
  return function() {
    setTimeout(flush, 1);
  };
}

var queue = [];
function flush() {
  for (var i = 0; i < queue.length; i++) {
    var tuple = queue[i];
    var callback = tuple[0], arg = tuple[1];
    callback(arg);
  }
  queue = [];
}

var scheduleFlush;

// Decide what async method to use to triggering processing of queued callbacks:
if (typeof process !== 'undefined' && {}.toString.call(process) === '[object process]') {
  scheduleFlush = useNextTick();
} else if (BrowserMutationObserver) {
  scheduleFlush = useMutationObserver();
} else {
  scheduleFlush = useSetTimeout();
}
},{"__browserify_process":2}],8:[function(require,module,exports){
"use strict";
var EventTarget = require("./events")["default"];

var config = {
  instrument: false
};

EventTarget.mixin(config);

function configure(name, value) {
  if (name === 'onerror') {
    // handle for legacy users that expect the actual
    // error to be passed to their function added via
    // `RSVP.configure('onerror', someFunctionHere);`
    config.on('error', value);
    return;
  }

  if (arguments.length === 2) {
    config[name] = value;
  } else {
    return config[name];
  }
}

exports.config = config;
exports.configure = configure;
},{"./events":10}],9:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];

/**
  `RSVP.defer` returns an object similar to jQuery's `$.Deferred`.
  `RSVP.defer` should be used when porting over code reliant on `$.Deferred`'s
  interface. New code should use the `RSVP.Promise` constructor instead.

  The object returned from `RSVP.defer` is a plain object with three properties:

  * promise - an `RSVP.Promise`.
  * reject - a function that causes the `promise` property on this object to
    become rejected
  * resolve - a function that causes the `promise` property on this object to
    become fulfilled.

  Example:

   ```javascript
   var deferred = RSVP.defer();

   deferred.resolve("Success!");

   defered.promise.then(function(value){
     // value here is "Success!"
   });
   ```

  @method defer
  @for RSVP
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Object}
 */

exports["default"] = function defer(label) {
  var deferred = { };

  deferred.promise = new Promise(function(resolve, reject) {
    deferred.resolve = resolve;
    deferred.reject = reject;
  }, label);

  return deferred;
};
},{"./promise":16}],10:[function(require,module,exports){
"use strict";
var indexOf = function(callbacks, callback) {
  for (var i=0, l=callbacks.length; i<l; i++) {
    if (callbacks[i] === callback) { return i; }
  }

  return -1;
};

var callbacksFor = function(object) {
  var callbacks = object._promiseCallbacks;

  if (!callbacks) {
    callbacks = object._promiseCallbacks = {};
  }

  return callbacks;
};

/**
  //@module RSVP
  //@class EventTarget
*/
exports["default"] = {

  /**
    `RSVP.EventTarget.mixin` extends an object with EventTarget methods. For
    Example:

    ```javascript
    var object = {};

    RSVP.EventTarget.mixin(object);

    object.on("finished", function(event) {
      // handle event
    });

    object.trigger("finished", { detail: value });
    ```

    `EventTarget.mixin` also works with prototypes:

    ```javascript
    var Person = function() {};
    RSVP.EventTarget.mixin(Person.prototype);

    var yehuda = new Person();
    var tom = new Person();

    yehuda.on("poke", function(event) {
      console.log("Yehuda says OW");
    });

    tom.on("poke", function(event) {
      console.log("Tom says OW");
    });

    yehuda.trigger("poke");
    tom.trigger("poke");
    ```

    @method mixin
    @param {Object} object object to extend with EventTarget methods
    @private
  */
  mixin: function(object) {
    object.on = this.on;
    object.off = this.off;
    object.trigger = this.trigger;
    object._promiseCallbacks = undefined;
    return object;
  },

  /**
    Registers a callback to be executed when `eventName` is triggered

    ```javascript
    object.on('event', function(eventInfo){
      // handle the event
    });

    object.trigger('event');
    ```

    @method on
    @param {String} eventName name of the event to listen for
    @param {Function} callback function to be called when the event is triggered.
    @private
  */
  on: function(eventName, callback) {
    var allCallbacks = callbacksFor(this), callbacks;

    callbacks = allCallbacks[eventName];

    if (!callbacks) {
      callbacks = allCallbacks[eventName] = [];
    }

    if (indexOf(callbacks, callback) === -1) {
      callbacks.push(callback);
    }
  },

  /**
    You can use `off` to stop firing a particular callback for an event:

    ```javascript
    function doStuff() { // do stuff! }
    object.on('stuff', doStuff);

    object.trigger('stuff'); // doStuff will be called

    // Unregister ONLY the doStuff callback
    object.off('stuff', doStuff);
    object.trigger('stuff'); // doStuff will NOT be called
    ```

    If you don't pass a `callback` argument to `off`, ALL callbacks for the
    event will not be executed when the event fires. For example:

    ```javascript
    var callback1 = function(){};
    var callback2 = function(){};

    object.on('stuff', callback1);
    object.on('stuff', callback2);

    object.trigger('stuff'); // callback1 and callback2 will be executed.

    object.off('stuff');
    object.trigger('stuff'); // callback1 and callback2 will not be executed!
    ```

    @method off
    @param {String} eventName event to stop listening to
    @param {Function} callback optional argument. If given, only the function
    given will be removed from the event's callback queue. If no `callback`
    argument is given, all callbacks will be removed from the event's callback
    queue.
    @private

  */
  off: function(eventName, callback) {
    var allCallbacks = callbacksFor(this), callbacks, index;

    if (!callback) {
      allCallbacks[eventName] = [];
      return;
    }

    callbacks = allCallbacks[eventName];

    index = indexOf(callbacks, callback);

    if (index !== -1) { callbacks.splice(index, 1); }
  },

  /**
    Use `trigger` to fire custom events. For example:

    ```javascript
    object.on('foo', function(){
      console.log('foo event happened!');
    });
    object.trigger('foo');
    // 'foo event happened!' logged to the console
    ```

    You can also pass a value as a second argument to `trigger` that will be
    passed as an argument to all event listeners for the event:

    ```javascript
    object.on('foo', function(value){
      console.log(value.name);
    });

    object.trigger('foo', { name: 'bar' });
    // 'bar' logged to the console
    ```

    @method trigger
    @param {String} eventName name of the event to be triggered
    @param {Any} options optional value to be passed to any event handlers for
    the given `eventName`
    @private
  */
  trigger: function(eventName, options) {
    var allCallbacks = callbacksFor(this),
        callbacks, callbackTuple, callback, binding;

    if (callbacks = allCallbacks[eventName]) {
      // Don't cache the callbacks.length since it may grow
      for (var i=0; i<callbacks.length; i++) {
        callback = callbacks[i];

        callback(options);
      }
    }
  }
};
},{}],11:[function(require,module,exports){
"use strict";
var all = require("./all")["default"];
var map = require("./map")["default"];
var isFunction = require("./utils").isFunction;
var isArray = require("./utils").isArray;

/**
 `RSVP.filter` is similar to JavaScript's native `filter` method, except that it
  waits for all promises to become fulfilled before running the `filterFn` on
  each item in given to `promises`. `RSVP.filter` returns a promise that will
  become fulfilled with the result of running `filterFn` on the values the
  promises become fulfilled with.

  For example:

  ```javascript

  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.resolve(2);
  var promise3 = RSVP.resolve(3);

  var filterFn = function(item){
    return item > 1;
  };

  RSVP.filter(promises, filterFn).then(function(result){
    // result is [ 2, 3 ]
  });
  ```

  If any of the `promises` given to `RSVP.filter` are rejected, the first promise
  that is rejected will be given as an argument to the returned promise's
  rejection handler. For example:

  ```javascript
  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.reject(new Error("2"));
  var promise3 = RSVP.reject(new Error("3"));
  var promises = [ promise1, promise2, promise3 ];

  var filterFn = function(item){
    return item > 1;
  };

  RSVP.filter(promises, filterFn).then(function(array){
    // Code here never runs because there are rejected promises!
  }, function(reason) {
    // reason.message === "2"
  });
  ```

  `RSVP.filter` will also wait for any promises returned from `filterFn`.
  For instance, you may want to fetch a list of users then return a subset
  of those users based on some asynchronous operation:

  ```javascript

  var alice = { name: 'alice' };
  var bob   = { name: 'bob' };
  var users = [ alice, bob ];

  var promises = users.map(function(user){
    return RSVP.resolve(user);
  });

  var filterFn = function(user){
    // Here, Alice has permissions to create a blog post, but Bob does not.
    return getPrivilegesForUser(user).then(function(privs){
      return privs.can_create_blog_post === true;
    });
  };
  RSVP.filter(promises, filterFn).then(function(users){
    // true, because the server told us only Alice can create a blog post.
    users.length === 1;
    // false, because Alice is the only user present in `users`
    users[0] === bob;
  });
  ```

  @method filter
  @for RSVP
  @param {Array} promises
  @param {Function} filterFn - function to be called on each resolved value to
  filter the final results.
  @param {String} label optional string describing the promise. Useful for
  tooling.
  @return {Promise}
*/
function filter(promises, filterFn, label) {
  return all(promises, label).then(function(values){
    if (!isArray(promises)) {
      throw new TypeError('You must pass an array to filter.');
    }

    if (!isFunction(filterFn)){
      throw new TypeError("You must pass a function to filter's second argument.");
    }

    return map(promises, filterFn, label).then(function(filterResults){
       var i,
           valuesLen = values.length,
           filtered = [];

       for (i = 0; i < valuesLen; i++){
         if(filterResults[i]) filtered.push(values[i]);
       }
       return filtered;
    });
  });
}

exports["default"] = filter;
},{"./all":5,"./map":14,"./utils":26}],12:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];
var isNonThenable = require("./utils").isNonThenable;
var keysOf = require("./utils").keysOf;

/**
  `RSVP.hash` is similar to `RSVP.all`, but takes an object instead of an array
  for its `promises` argument.

  Returns a promise that is fulfilled when all the given promises have been
  fulfilled, or rejected if any of them become rejected. The returned promise
  is fulfilled with a hash that has the same key names as the `promises` object
  argument. If any of the values in the object are not promises, they will
  simply be copied over to the fulfilled object.

  Example:

  ```javascript
  var promises = {
    myPromise: RSVP.resolve(1),
    yourPromise: RSVP.resolve(2),
    theirPromise: RSVP.resolve(3),
    notAPromise: 4
  };

  RSVP.hash(promises).then(function(hash){
    // hash here is an object that looks like:
    // {
    //   myPromise: 1,
    //   yourPromise: 2,
    //   theirPromise: 3,
    //   notAPromise: 4
    // }
  });
  ````

  If any of the `promises` given to `RSVP.hash` are rejected, the first promise
  that is rejected will be given as the reason to the rejection handler.

  Example:

  ```javascript
  var promises = {
    myPromise: RSVP.resolve(1),
    rejectedPromise: RSVP.reject(new Error("rejectedPromise")),
    anotherRejectedPromise: RSVP.reject(new Error("anotherRejectedPromise")),
  };

  RSVP.hash(promises).then(function(hash){
    // Code here never runs because there are rejected promises!
  }, function(reason) {
    // reason.message === "rejectedPromise"
  });
  ```

  An important note: `RSVP.hash` is intended for plain JavaScript objects that
  are just a set of keys and values. `RSVP.hash` will NOT preserve prototype
  chains.

  Example:

  ```javascript
  function MyConstructor(){
    this.example = RSVP.resolve("Example");
  }

  MyConstructor.prototype = {
    protoProperty: RSVP.resolve("Proto Property")
  };

  var myObject = new MyConstructor();

  RSVP.hash(myObject).then(function(hash){
    // protoProperty will not be present, instead you will just have an
    // object that looks like:
    // {
    //   example: "Example"
    // }
    //
    // hash.hasOwnProperty('protoProperty'); // false
    // 'undefined' === typeof hash.protoProperty
  });
  ```

  @method hash
  @for RSVP
  @param {Object} promises
  @param {String} label - optional string that describes the promise.
  Useful for tooling.
  @return {Promise} promise that is fulfilled when all properties of `promises`
  have been fulfilled, or rejected if any of them become rejected.
*/
exports["default"] = function hash(object, label) {
  return new Promise(function(resolve, reject){
    var results = {};
    var keys = keysOf(object);
    var remaining = keys.length;
    var entry, property;

    if (remaining === 0) {
      resolve(results);
      return;
    }

   function fulfilledTo(property) {
      return function(value) {
        results[property] = value;
        if (--remaining === 0) {
          resolve(results);
        }
      };
    }

    function onRejection(reason) {
      remaining = 0;
      reject(reason);
    }

    for (var i = 0; i < keys.length; i++) {
      property = keys[i];
      entry = object[property];

      if (isNonThenable(entry)) {
        results[property] = entry;
        if (--remaining === 0) {
          resolve(results);
        }
      } else {
        Promise.cast(entry).then(fulfilledTo(property), onRejection);
      }
    }
  });
};
},{"./promise":16,"./utils":26}],13:[function(require,module,exports){
"use strict";
var config = require("./config").config;
var now = require("./utils").now;

exports["default"] = function instrument(eventName, promise, child) {
  // instrumentation should not disrupt normal usage.
  try {
    config.trigger(eventName, {
      guid: promise._guidKey + promise._id,
      eventName: eventName,
      detail: promise._detail,
      childGuid: child && promise._guidKey + child._id,
      label: promise._label,
      timeStamp: now(),
      stack: new Error(promise._label).stack
    });
  } catch(error) {
    setTimeout(function(){
      throw error;
    }, 0);
  }
};
},{"./config":8,"./utils":26}],14:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];
var all = require("./all")["default"];
var isArray = require("./utils").isArray;
var isFunction = require("./utils").isFunction;

/**

 `RSVP.map` is similar to JavaScript's native `map` method, except that it
  waits for all promises to become fulfilled before running the `mapFn` on
  each item in given to `promises`. `RSVP.map` returns a promise that will
  become fulfilled with the result of running `mapFn` on the values the promises
  become fulfilled with.

  For example:

  ```javascript

  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.resolve(2);
  var promise3 = RSVP.resolve(3);
  var promises = [ promise1, promise2, promise3 ];

  var mapFn = function(item){
    return item + 1;
  };

  RSVP.map(promises, mapFn).then(function(result){
    // result is [ 2, 3, 4 ]
  });
  ```

  If any of the `promises` given to `RSVP.map` are rejected, the first promise
  that is rejected will be given as an argument to the returned promise's
  rejection handler. For example:

  ```javascript
  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.reject(new Error("2"));
  var promise3 = RSVP.reject(new Error("3"));
  var promises = [ promise1, promise2, promise3 ];

  var mapFn = function(item){
    return item + 1;
  };

  RSVP.map(promises, mapFn).then(function(array){
    // Code here never runs because there are rejected promises!
  }, function(reason) {
    // reason.message === "2"
  });
  ```

  `RSVP.map` will also wait if a promise is returned from `mapFn`. For example,
  say you want to get all comments from a set of blog posts, but you need
  the blog posts first becuase they contain a url to those comments.

  ```javscript

  var mapFn = function(blogPost){
    // getComments does some ajax and returns an RSVP.Promise that is fulfilled
    // with some comments data
    return getComments(blogPost.comments_url);
  };

  // getBlogPosts does some ajax and returns an RSVP.Promise that is fulfilled
  // with some blog post data
  RSVP.map(getBlogPosts(), mapFn).then(function(comments){
    // comments is the result of asking the server for the comments
    // of all blog posts returned from getBlogPosts()
  });
  ```

  @method map
  @for RSVP
  @param {Array} promises
  @param {Function} mapFn function to be called on each fulfilled promise.
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise} promise that is fulfilled with the result of calling
  `mapFn` on each fulfilled promise or value when they become fulfilled.
   The promise will be rejected if any of the given `promises` become rejected.
*/
exports["default"] = function map(promises, mapFn, label) {
  return all(promises, label).then(function(results){
    if (!isArray(promises)) {
      throw new TypeError('You must pass an array to map.');
    }

    if (!isFunction(mapFn)){
      throw new TypeError("You must pass a function to map's second argument.");
    }


    var resultLen = results.length,
        mappedResults = [],
        i;

    for (i = 0; i < resultLen; i++){
      mappedResults.push(mapFn(results[i]));
    }

    return all(mappedResults, label);
  });
};
},{"./all":5,"./promise":16,"./utils":26}],15:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];

var slice = Array.prototype.slice;

function makeNodeCallbackFor(resolve, reject) {
  return function (error, value) {
    if (error) {
      reject(error);
    } else if (arguments.length > 2) {
      resolve(slice.call(arguments, 1));
    } else {
      resolve(value);
    }
  };
}

/**
  `RSVP.denodeify` takes a "node-style" function and returns a function that
  will return an `RSVP.Promise`. You can use `denodeify` in Node.js or the
  browser when you'd prefer to use promises over using callbacks. For example,
  `denodeify` transforms the following:

  ```javascript
  var fs = require('fs');

  fs.readFile('myfile.txt', function(err, data){
    if (err) return handleError(err);
    handleData(data);
  });
  ```

  into:

  ```javascript
  var fs = require('fs');

  var readFile = RSVP.denodeify(fs.readFile);

  readFile('myfile.txt').then(handleData, handleError);
  ```

  Using `denodeify` makes it easier to compose asynchronous operations instead
  of using callbacks. For example, instead of:

  ```javascript
  var fs = require('fs');
  var log = require('some-async-logger');

  fs.readFile('myfile.txt', function(err, data){
    if (err) return handleError(err);
    fs.writeFile('myfile2.txt', data, function(err){
      if (err) throw err;
      log('success', function(err) {
        if (err) throw err;
      });
    });
  });
  ```

  You can chain the operations together using `then` from the returned promise:

  ```javascript
  var fs = require('fs');
  var denodeify = RSVP.denodeify;
  var readFile = denodeify(fs.readFile);
  var writeFile = denodeify(fs.writeFile);
  var log = denodeify(require('some-async-logger'));

  readFile('myfile.txt').then(function(data){
    return writeFile('myfile2.txt', data);
  }).then(function(){
    return log('SUCCESS');
  }).then(function(){
    // success handler
  }, function(reason){
    // rejection handler
  });
  ```

  @method denodeify
  @for RSVP
  @param {Function} nodeFunc a "node-style" function that takes a callback as
  its last argument. The callback expects an error to be passed as its first
  argument (if an error occurred, otherwise null), and the value from the
  operation as its second argument ("function(err, value){ }").
  @param {Any} binding optional argument for binding the "this" value when
  calling the `nodeFunc` function.
  @return {Function} a function that wraps `nodeFunc` to return an
  `RSVP.Promise`
*/
exports["default"] = function denodeify(nodeFunc, binding) {
  return function()  {
    var nodeArgs = slice.call(arguments), resolve, reject;
    var thisArg = this || binding;

    return new Promise(function(resolve, reject) {
      Promise.all(nodeArgs).then(function(nodeArgs) {
        try {
          nodeArgs.push(makeNodeCallbackFor(resolve, reject));
          nodeFunc.apply(thisArg, nodeArgs);
        } catch(e) {
          reject(e);
        }
      });
    });
  };
};
},{"./promise":16}],16:[function(require,module,exports){
"use strict";
var config = require("./config").config;
var EventTarget = require("./events")["default"];
var instrument = require("./instrument")["default"];
var objectOrFunction = require("./utils").objectOrFunction;
var isFunction = require("./utils").isFunction;
var now = require("./utils").now;
var cast = require("./promise/cast")["default"];
var all = require("./promise/all")["default"];
var race = require("./promise/race")["default"];
var Resolve = require("./promise/resolve")["default"];
var Reject = require("./promise/reject")["default"];

var guidKey = 'rsvp_' + now() + '-';
var counter = 0;

function noop() {}

exports["default"] = Promise;


/**

  Promise objects represent the eventual result of an asynchronous operation. The
  primary way of interacting with a promise is through its `then` method, which
  registers callbacks to receive either a promise’s eventual value or the reason
  why the promise cannot be fulfilled.

  Terminology
  -----------

  - `promise` is an object or function with a `then` method whose behavior conforms to this specification.
  - `thenable` is an object or function that defines a `then` method.
  - `value` is any legal JavaScript value (including undefined, a thenable, or a promise).
  - `exception` is a value that is thrown using the throw statement.
  - `reason` is a value that indicates why a promise was rejected.
  - `settled` the final resting state of a promise, fulfilled or rejected.

  A promise can be in one of three states: pending, fulfilled, or rejected.


  Basic Usage:
  ------------

  ```js
  var promise = new Promise(function(resolve, reject) {
    // on success
    resolve(value);

    // on failure
    reject(reason);
  });

  promise.then(function(value) {
    // on fulfillment
  }, function(reason) {
    // on rejection
  });
  ```

  Advanced Usage:
  ---------------

  Promises shine when abstracting away asynchronous interactions such as
  `XMLHttpRequest`s.

  ```js
  function getJSON(url) {
    return new Promise(function(resolve, reject){
      var xhr = new XMLHttpRequest();

      xhr.open('GET', url);
      xhr.onreadystatechange = handler;
      xhr.responseType = 'json';
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.send();

      function handler() {
        if (this.readyState === this.DONE) {
          if (this.status === 200) {
            resolve(this.response);
          } else {
            reject(new Error("getJSON: `" + url + "` failed with status: [" + this.status + "]");
          }
        }
      };
    });
  }

  getJSON('/posts.json').then(function(json) {
    // on fulfillment
  }, function(reason) {
    // on rejection
  });
  ```

  Unlike callbacks, promises are great composable primitives.

  ```js
  Promise.all([
    getJSON('/posts'),
    getJSON('/comments')
  ]).then(function(values){
    values[0] // => postsJSON
    values[1] // => commentsJSON

    return values;
  });
  ```

  @class Promise
  @param {function}
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @constructor
*/
function Promise(resolver, label) {
  if (!isFunction(resolver)) {
    throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
  }

  if (!(this instanceof Promise)) {
    throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
  }

  this._id = counter++;
  this._label = label;
  this._subscribers = [];

  if (config.instrument) {
    instrument('created', this);
  }

  if (noop !== resolver) {
    invokeResolver(resolver, this);
  }
}

function invokeResolver(resolver, promise) {
  function resolvePromise(value) {
    resolve(promise, value);
  }

  function rejectPromise(reason) {
    reject(promise, reason);
  }

  try {
    resolver(resolvePromise, rejectPromise);
  } catch(e) {
    rejectPromise(e);
  }
}

Promise.cast = cast;
Promise.all = all;
Promise.race = race;
Promise.resolve = Resolve;
Promise.reject = Reject;

var PENDING   = void 0;
var SEALED    = 0;
var FULFILLED = 1;
var REJECTED  = 2;

function subscribe(parent, child, onFulfillment, onRejection) {
  var subscribers = parent._subscribers;
  var length = subscribers.length;

  subscribers[length] = child;
  subscribers[length + FULFILLED] = onFulfillment;
  subscribers[length + REJECTED]  = onRejection;
}

function publish(promise, settled) {
  var child, callback, subscribers = promise._subscribers, detail = promise._detail;

  if (config.instrument) {
    instrument(settled === FULFILLED ? 'fulfilled' : 'rejected', promise);
  }

  for (var i = 0; i < subscribers.length; i += 3) {
    child = subscribers[i];
    callback = subscribers[i + settled];

    invokeCallback(settled, child, callback, detail);
  }

  promise._subscribers = null;
}

Promise.prototype = {
/**
  @property constructor
*/
  constructor: Promise,

  _id: undefined,
  _guidKey: guidKey,
  _label: undefined,

  _state: undefined,
  _detail: undefined,
  _subscribers: undefined,

  _onerror: function (reason) {
    config.trigger('error', reason);
  },

/**

  The primary way of interacting with a promise is through its `then` method,
  which registers callbacks to receive either a promise's eventual value or the
  reason why the promise cannot be fulfilled.

  ```js
  findUser().then(function(user){
    // user is available
  }, function(reason){
    // user is unavailable, and you are given the reason why
  });
  ```

  Chaining
  --------

  The return value of `then` is itself a promise.  This second, "downstream"
  promise is resolved with the return value of the first promise's fulfillment
  or rejection handler, or rejected if the handler throws an exception.

  ```js
  findUser().then(function (user) {
    return user.name;
  }, function (reason) {
    return "default name";
  }).then(function (userName) {
    // If `findUser` fulfilled, `userName` will be the user's name, otherwise it
    // will be `"default name"`
  });

  findUser().then(function (user) {
    throw new Error("Found user, but still unhappy");
  }, function (reason) {
    throw new Error("`findUser` rejected and we're unhappy");
  }).then(function (value) {
    // never reached
  }, function (reason) {
    // if `findUser` fulfilled, `reason` will be "Found user, but still unhappy".
    // If `findUser` rejected, `reason` will be "`findUser` rejected and we're unhappy".
  });
  ```
  If the downstream promise does not specify a rejection handler, rejection reasons will be propagated further downstream.

  ```js
  findUser().then(function (user) {
    throw new PedagogicalException("Upstream error");
  }).then(function (value) {
    // never reached
  }).then(function (value) {
    // never reached
  }, function (reason) {
    // The `PedgagocialException` is propagated all the way down to here
  });
  ```

  Assimilation
  ------------

  Sometimes the value you want to propagate to a downstream promise can only be
  retrieved asynchronously. This can be achieved by returning a promise in the
  fulfillment or rejection handler. The downstream promise will then be pending
  until the returned promise is settled. This is called *assimilation*.

  ```js
  findUser().then(function (user) {
    return findCommentsByAuthor(user);
  }).then(function (comments) {
    // The user's comments are now available
  });
  ```

  If the assimliated promise rejects, then the downstream promise will also reject.

  ```js
  findUser().then(function (user) {
    return findCommentsByAuthor(user);
  }).then(function (comments) {
    // If `findCommentsByAuthor` fulfills, we'll have the value here
  }, function (reason) {
    // If `findCommentsByAuthor` rejects, we'll have the reason here
  });
  ```

  Simple Example
  --------------

  Synchronous Example

  ```javascript
  var result;

  try {
    result = findResult();
    // success
  } catch(reason) {
    // failure
  }
  ```

  Errback Example

  ```js
  findResult(function(result, err){
    if (err) {
      // failure
    } else {
      // success
    }
  });
  ```

  Promise Example;

  ```javascript
  findResult().then(function(result){
    // success
  }, function(reason){
    // failure
  });
  ```

  Advanced Example
  --------------

  Synchronous Example

  ```javascript
  var author, books;

  try {
    author = findAuthor();
    books  = findBooksByAuthor(author);
    // success
  } catch(reason) {
    // failure
  }
  ```

  Errback Example

  ```js

  function foundBooks(books) {

  }

  function failure(reason) {

  }

  findAuthor(function(author, err){
    if (err) {
      failure(err);
      // failure
    } else {
      try {
        findBoooksByAuthor(author, function(books, err) {
          if (err) {
            failure(err);
          } else {
            try {
              foundBooks(books);
            } catch(reason) {
              failure(reason);
            }
          }
        });
      } catch(error) {
        failure(err);
      }
      // success
    }
  });
  ```

  Promise Example;

  ```javascript
  findAuthor().
    then(findBooksByAuthor).
    then(function(books){
      // found books
  }).catch(function(reason){
    // something went wrong
  });
  ```

  @method then
  @param {Function} onFulfilled
  @param {Function} onRejected
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise}
*/
  then: function(onFulfillment, onRejection, label) {
    var promise = this;
    this._onerror = null;

    var thenPromise = new this.constructor(noop, label);

    if (this._state) {
      var callbacks = arguments;
      config.async(function invokePromiseCallback() {
        invokeCallback(promise._state, thenPromise, callbacks[promise._state - 1], promise._detail);
      });
    } else {
      subscribe(this, thenPromise, onFulfillment, onRejection);
    }

    if (config.instrument) {
      instrument('chained', promise, thenPromise);
    }

    return thenPromise;
  },

/**
  `catch` is simply sugar for `then(undefined, onRejection)` which makes it the same
  as the catch block of a try/catch statement.

  ```js
  function findAuthor(){
    throw new Error("couldn't find that author");
  }

  // synchronous
  try {
    findAuthor();
  } catch(reason) {
    // something went wrong
  }

  // async with promises
  findAuthor().catch(function(reason){
    // something went wrong
  });
  ```

  @method catch
  @param {Function} onRejection
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise}
*/
  'catch': function(onRejection, label) {
    return this.then(null, onRejection, label);
  },

/**
  `finally` will be invoked regardless of the promise's fate just as native
  try/catch/finally behaves

  Synchronous example:

  ```js
  findAuthor() {
    if (Math.random() > 0.5) {
      throw new Error();
    }
    return new Author();
  }

  try {
    return findAuthor(); // succeed or fail
  } catch(error) {
    return findOtherAuther();
  } finally {
    // always runs
    // doesn't affect the return value
  }
  ```

  Asynchronous example:

  ```js
  findAuthor().catch(function(reason){
    return findOtherAuther();
  }).finally(function(){
    // author was either found, or not
  });
  ```

  @method finally
  @param {Function} callback
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise}
*/
  'finally': function(callback, label) {
    var constructor = this.constructor;

    return this.then(function(value) {
      return constructor.cast(callback()).then(function(){
        return value;
      });
    }, function(reason) {
      return constructor.cast(callback()).then(function(){
        throw reason;
      });
    }, label);
  }
};

function invokeCallback(settled, promise, callback, detail) {
  var hasCallback = isFunction(callback),
      value, error, succeeded, failed;

  if (hasCallback) {
    try {
      value = callback(detail);
      succeeded = true;
    } catch(e) {
      failed = true;
      error = e;
    }
  } else {
    value = detail;
    succeeded = true;
  }

  if (handleThenable(promise, value)) {
    return;
  } else if (hasCallback && succeeded) {
    resolve(promise, value);
  } else if (failed) {
    reject(promise, error);
  } else if (settled === FULFILLED) {
    resolve(promise, value);
  } else if (settled === REJECTED) {
    reject(promise, value);
  }
}

function handleThenable(promise, value) {
  var then = null,
  resolved;

  try {
    if (promise === value) {
      throw new TypeError("A promises callback cannot return that same promise.");
    }

    if (objectOrFunction(value)) {
      then = value.then;

      if (isFunction(then)) {
        then.call(value, function(val) {
          if (resolved) { return true; }
          resolved = true;

          if (value !== val) {
            resolve(promise, val);
          } else {
            fulfill(promise, val);
          }
        }, function(val) {
          if (resolved) { return true; }
          resolved = true;

          reject(promise, val);
        }, 'derived from: ' + (promise._label || ' unknown promise'));

        return true;
      }
    }
  } catch (error) {
    if (resolved) { return true; }
    reject(promise, error);
    return true;
  }

  return false;
}

function resolve(promise, value) {
  if (promise === value) {
    fulfill(promise, value);
  } else if (!handleThenable(promise, value)) {
    fulfill(promise, value);
  }
}

function fulfill(promise, value) {
  if (promise._state !== PENDING) { return; }
  promise._state = SEALED;
  promise._detail = value;

  config.async(publishFulfillment, promise);
}

function reject(promise, reason) {
  if (promise._state !== PENDING) { return; }
  promise._state = SEALED;
  promise._detail = reason;

  config.async(publishRejection, promise);
}

function publishFulfillment(promise) {
  publish(promise, promise._state = FULFILLED);
}

function publishRejection(promise) {
  if (promise._onerror) {
    promise._onerror(promise._detail);
  }

  publish(promise, promise._state = REJECTED);
}
},{"./config":8,"./events":10,"./instrument":13,"./promise/all":17,"./promise/cast":18,"./promise/race":19,"./promise/reject":20,"./promise/resolve":21,"./utils":26}],17:[function(require,module,exports){
"use strict";
var isArray = require("../utils").isArray;
var isNonThenable = require("../utils").isNonThenable;

/**

  `RSVP.Promise.all` accepts an array of promises, and returns a new promise which
  is fulfilled with an array of fulfillment values for the passed promises, or
  rejected with the reason of the first passed promise to be rejected. It casts all
  elements of the passed iterable to promises as it runs this algorithm.

  Example:

  ```javascript
  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.resolve(2);
  var promise3 = RSVP.resolve(3);
  var promises = [ promise1, promise2, promise3 ];

  RSVP.Promise.all(promises).then(function(array){
    // The array here would be [ 1, 2, 3 ];
  });
  ```

  If any of the `promises` given to `RSVP.all` are rejected, the first promise
  that is rejected will be given as an argument to the returned promises's
  rejection handler. For example:

  Example:

  ```javascript
  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.reject(new Error("2"));
  var promise3 = RSVP.reject(new Error("3"));
  var promises = [ promise1, promise2, promise3 ];

  RSVP.Promise.all(promises).then(function(array){
    // Code here never runs because there are rejected promises!
  }, function(error) {
    // error.message === "2"
  });
  ```

  @method all
  @for RSVP.Promise
  @param {Array} entries array of promises
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise} promise that is fulfilled when all `promises` have been
  fulfilled, or rejected if any of them become rejected.
*/
exports["default"] = function all(entries, label) {

  /*jshint validthis:true */
  var Constructor = this;

  return new Constructor(function(resolve, reject) {
    if (!isArray(entries)) {
      throw new TypeError('You must pass an array to all.');
    }

    var remaining = entries.length;
    var results = new Array(remaining);
    var entry, pending = true;

    if (remaining === 0) {
      resolve(results);
      return;
    }

    function fulfillmentAt(index) {
      return function(value) {
        results[index] = value;
        if (--remaining === 0) {
          resolve(results);
        }
      };
    }

    function onRejection(reason) {
      remaining = 0;
      reject(reason);
    }

    for (var index = 0; index < entries.length; index++) {
      entry = entries[index];
      if (isNonThenable(entry)) {
        results[index] = entry;
        if (--remaining === 0) {
          resolve(results);
        }
      } else {
        Constructor.cast(entry).then(fulfillmentAt(index), onRejection);
      }
    }
  }, label);
};
},{"../utils":26}],18:[function(require,module,exports){
"use strict";
/**

  `RSVP.Promise.cast` coerces its argument to a promise, or returns the
  argument if it is already a promise which shares a constructor with the caster.

  Example:

  ```javascript
  var promise = RSVP.Promise.resolve(1);
  var casted = RSVP.Promise.cast(promise);

  console.log(promise === casted); // true
  ```

  In the case of a promise whose constructor does not match, it is assimilated.
  The resulting promise will fulfill or reject based on the outcome of the
  promise being casted.

  Example:

  ```javascript
  var thennable = $.getJSON('/api/foo');
  var casted = RSVP.Promise.cast(thennable);

  console.log(thennable === casted); // false
  console.log(casted instanceof RSVP.Promise) // true

  casted.then(function(data) {
    // data is the value getJSON fulfills with
  });
  ```

  In the case of a non-promise, a promise which will fulfill with that value is
  returned.

  Example:

  ```javascript
  var value = 1; // could be a number, boolean, string, undefined...
  var casted = RSVP.Promise.cast(value);

  console.log(value === casted); // false
  console.log(casted instanceof RSVP.Promise) // true

  casted.then(function(val) {
    val === value // => true
  });
  ```

  `RSVP.Promise.cast` is similar to `RSVP.Promise.resolve`, but `RSVP.Promise.cast` differs in the
  following ways:

  * `RSVP.Promise.cast` serves as a memory-efficient way of getting a promise, when you
  have something that could either be a promise or a value. RSVP.resolve
  will have the same effect but will create a new promise wrapper if the
  argument is a promise.
  * `RSVP.Promise.cast` is a way of casting incoming thenables or promise subclasses to
  promises of the exact class specified, so that the resulting object's `then` is
  ensured to have the behavior of the constructor you are calling cast on (i.e., RSVP.Promise).

  @method cast
  @for RSVP.Promise
  @param {Object} object to be casted
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise} promise
*/

exports["default"] = function cast(object, label) {
  /*jshint validthis:true */
  var Constructor = this;

  if (object && typeof object === 'object' && object.constructor === Constructor) {
    return object;
  }

  return new Constructor(function(resolve) {
    resolve(object);
  }, label);
};
},{}],19:[function(require,module,exports){
"use strict";
/* global toString */

var isArray = require("../utils").isArray;
var isFunction = require("../utils").isFunction;
var isNonThenable = require("../utils").isNonThenable;

/**
  `RSVP.Promise.race` returns a new promise which is settled in the same way as the
  first passed promise to settle.

  Example:

  ```javascript
  var promise1 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      resolve("promise 1");
    }, 200);
  });

  var promise2 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      resolve("promise 2");
    }, 100);
  });

  RSVP.Promise.race([promise1, promise2]).then(function(result){
    // result === "promise 2" because it was resolved before promise1
    // was resolved.
  });
  ```

  `RSVP.Promise.race` is deterministic in that only the state of the first
  settled promise matters. For example, even if other promises given to the
  `promises` array argument are resolved, but the first settled promise has
  become rejected before the other promises became fulfilled, the returned
  promise will become rejected:

  ```javascript
  var promise1 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      resolve("promise 1");
    }, 200);
  });

  var promise2 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      reject(new Error("promise 2"));
    }, 100);
  });

  RSVP.Promise.race([promise1, promise2]).then(function(result){
    // Code here never runs because there are rejected promises!
  }, function(reason){
    // reason.message === "promise2" because promise 2 became rejected before
    // promise 1 became fulfilled
  });
  ```

  An example real-world use case is implementing timeouts:

  ```javascript
  RSVP.Promise.race([ajax('foo.json'), timeout(5000)])
  ```

  @method race
  @for RSVP.Promise
  @param {Array} promises array of promises to observe
  @param {String} label optional string for describing the promise returned.
  Useful for tooling.
  @return {Promise} a promise which settles in the same way as the first passed
  promise to settle.
*/
exports["default"] = function race(entries, label) {
  /*jshint validthis:true */
  var Constructor = this, entry;

  return new Constructor(function(resolve, reject) {
    if (!isArray(entries)) {
      throw new TypeError('You must pass an array to race.');
    }

    var pending = true;

    function onFulfillment(value) { if (pending) { pending = false; resolve(value); } }
    function onRejection(reason)  { if (pending) { pending = false; reject(reason); } }

    for (var i = 0; i < entries.length; i++) {
      entry = entries[i];
      if (isNonThenable(entry)) {
        pending = false;
        resolve(entry);
        return;
      } else {
        Constructor.cast(entry).then(onFulfillment, onRejection);
      }
    }
  }, label);
};
},{"../utils":26}],20:[function(require,module,exports){
"use strict";
/**
  `RSVP.Promise.reject` returns a promise rejected with the passed `reason`.
  It is shorthand for the following:

  ```javascript
  var promise = new RSVP.Promise(function(resolve, reject){
    reject(new Error('WHOOPS'));
  });

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  var promise = RSVP.Promise.reject(new Error('WHOOPS'));

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  @method reject
  @for RSVP.Promise
  @param {Any} reason value that the returned promise will be rejected with.
  @param {String} label optional string for identifying the returned promise.
  Useful for tooling.
  @return {Promise} a promise rejected with the given `reason`.
*/
exports["default"] = function reject(reason, label) {
  /*jshint validthis:true */
  var Constructor = this;

  return new Constructor(function (resolve, reject) {
    reject(reason);
  }, label);
};
},{}],21:[function(require,module,exports){
"use strict";
/**
  `RSVP.Promise.resolve` returns a promise that will become resolved with the
  passed `value`. It is shorthand for the following:

  ```javascript
  var promise = new RSVP.Promise(function(resolve, reject){
    resolve(1);
  });

  promise.then(function(value){
    // value === 1
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  var promise = RSVP.Promise.resolve(1);

  promise.then(function(value){
    // value === 1
  });
  ```

  @method resolve
  @for RSVP.Promise
  @param {Any} value value that the returned promise will be resolved with
  @param {String} label optional string for identifying the returned promise.
  Useful for tooling.
  @return {Promise} a promise that will become fulfilled with the given
  `value`
*/
exports["default"] = function resolve(value, label) {
  /*jshint validthis:true */
  var Constructor = this;

  return new Constructor(function(resolve, reject) {
    resolve(value);
  }, label);
};
},{}],22:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];

exports["default"] = function race(array, label) {
  return Promise.race(array, label);
};
},{"./promise":16}],23:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];

exports["default"] = function reject(reason, label) {
  return Promise.reject(reason, label);
};
},{"./promise":16}],24:[function(require,module,exports){
"use strict";
var Promise = require("./promise")["default"];

exports["default"] = function resolve(value, label) {
  return Promise.resolve(value, label);
};
},{"./promise":16}],25:[function(require,module,exports){
"use strict";
/**
  `RSVP.rethrow` will rethrow an error on the next turn of the JavaScript event
  loop in order to aid debugging.

  Promises A+ specifies that any exceptions that occur with a promise must be
  caught by the promises implementation and bubbled to the last handler. For
  this reason, it is recommended that you always specify a second rejection
  handler function to `then`. However, `RSVP.rethrow` will throw the exception
  outside of the promise, so it bubbles up to your console if in the browser,
  or domain/cause uncaught exception in Node. `rethrow` will also throw the
  error again so the error can be handled by the promise per the spec.

  ```javascript
  function throws(){
    throw new Error('Whoops!');
  }

  var promise = new RSVP.Promise(function(resolve, reject){
    throws();
  });

  promise.catch(RSVP.rethrow).then(function(){
    // Code here doesn't run because the promise became rejected due to an
    // error!
  }, function (err){
    // handle the error here
  });
  ```

  The 'Whoops' error will be thrown on the next turn of the event loop
  and you can watch for it in your console. You can also handle it using a
  rejection handler given to `.then` or `.catch` on the returned promise.

  @method rethrow
  @for RSVP
  @param {Error} reason reason the promise became rejected.
  @throws Error
*/
exports["default"] = function rethrow(reason) {
  setTimeout(function() {
    throw reason;
  });
  throw reason;
};
},{}],26:[function(require,module,exports){
"use strict";
function objectOrFunction(x) {
  return typeof x === "function" || (typeof x === "object" && x !== null);
}

exports.objectOrFunction = objectOrFunction;function isFunction(x) {
  return typeof x === "function";
}

exports.isFunction = isFunction;function isNonThenable(x) {
  return !objectOrFunction(x);
}

exports.isNonThenable = isNonThenable;function isArray(x) {
  return Object.prototype.toString.call(x) === "[object Array]";
}

exports.isArray = isArray;// Date.now is not available in browsers < IE9
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now#Compatibility
var now = Date.now || function() { return new Date().getTime(); };
exports.now = now;
var keysOf = Object.keys || function(object) {
  var result = [];

  for (var prop in object) {
    result.push(prop);
  }

  return result;
};
exports.keysOf = keysOf;
},{}]},{},[1])
(1)
});
;