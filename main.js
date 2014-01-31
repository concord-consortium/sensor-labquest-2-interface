/*global XDomainRequest */

'use strict';

// properties
// datasets[]
//   columns[]
//     type
//     id
//     data[]
//     timestamp

var RSVP = require('rsvp');

var EventEmitter2 = require('eventemitter2').EventEmitter2;
var events = new EventEmitter2({
    wildcard: true
});

var datasets = [];
var datasetsById = Object.create(null);
var columnsById = Object.create(null);

var urlPrefix = '';
var TIME_LIMIT_IN_MS = 5000;

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

    if (response.requestTimeStamp < lastStatusTimeStamp) {
        // stale out-of-order response; drop it like we never got it.
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
                id: parseInt(setId, 10)
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
        var columnFromResponse = cols[colId];
        var column = columnsById[colId];
        if ( ! column ) {
            events.emit('columnAdded', colId);
            // Remember, the column information can change
            // HOWEVER, assume a column is never removed from one dataset and added to another
            column = columnsById[colId] = {
                requestedValuesTimeStamp: 0,
                data: []
            };
            // columns helpfully have a 'position' property
            datasetsById[columnFromResponse.setID].columns[columnFromResponse.position] = column;
        }

        if (column.type && column.type !== columnFromResponse.units) {
            events.emit('columnChanged', colId);
        }
        column.type = columnFromResponse.units;
        column.id = parseInt(colId, 10);
        if (column.requestedValuesTimeStamp < columnFromResponse.valuesTimeStamp) {
            requestData(colId);
            // TODO: indicate that we're waiting for data
            column.requestedValuesTimeStamp = columnFromResponse.valuesTimeStamp;
        }
    });

    // TODO: check to see if any columns disappeared
}

// Request data if status indicates there's more data
function requestData(colId) {
    console.log("requesting data for column: ", colId);

    var xhr = createCORSRequest('GET', '/columns/' + colId);
    // look, we wouldn't have got here if we didn't support CORS
    xhr.send();

    xhr.onload = function() {
        var response = this.response || JSON.parse(this.responseText);
        var values = response.values;
        var column = columnsById[colId];
        if (values.length > column.data.length) {
            [].push.apply(column.data, values.slice(column.data.length));
            events.emit('data', column.id);
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
        timeoutTimer.start();
        statusIntervalId = setInterval(requestStatus, 500);
    },

    stopPolling: function() {
        timeoutTimer.stop();
        clearInterval(statusIntervalId);
    },

    requestStart: promisifyRequest('/control/start'),

    requestStop: promisifyRequest('/control/stop'),

    on: function() {
        events.on.apply(events, arguments);
    },

    datasets: datasets,

    isConnected: function() {
        return isConnected;
    }
};
