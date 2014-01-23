'use strict';

// Strawman. Build the lower level first.
// ISO better names.
var RSVP = require('rsvp');

var iface = require('./bottom-layer');
var REQUEST_TIME_LIMIT_IN_MS = 5000;

function waitForCollectionStart() {
    // returns a promise that resolves when collection starts or if it is already started
}

function waitForCollectionStop() {

}

function connect() {
    // if we're connected, resolve
    // Q: does it make a lick of sense to turn promises back into a callback-based API?
    // A: NO.

    var removeListeners;

    var promise = new RSVP.Promise(function(resolve, reject) {
        function statusErrored() {
            reject(/* new Error(...)*/);
        }

        function connectionTimedOut() {
            reject(/* new Error(...)*/);
        }

        removeListeners = function() {
            iface.removeListener('statusErrored', statusErrored);
            iface.removeListener('connectionTimedOut', connectionTimedOut);
            iface.removeListener('statusReceived', resolve);
        };

        iface.on('statusErrored', statusErrored);
        iface.on('connectionTimedOut', connectionTimedOut);
        iface.on('statusReceived', resolve);

        iface.startPolling();
    });

    promise.finally(removeListeners);
    return promise;
}

function start() {
    // need to start listening for data and emitting data events
    // need to return information about available sensor types

    return new RSVP.Promise(function(resolve, reject) {

        function done() {
            startTrackingColumns();
            iface.on('data', dataHandler);
            // Because collection may have started before we requested it, the lower level may have
            // data that it considers not new, but which this level has not yet processed.
            dataHandler();
            resolve(getSensorList);
        }

        function rejectForStartTimeout() {
            // TODO: check with lower layer to see if control is disabled
            reject(/* new Error(...); */);
        }

        if ( ! iface.isConnected() ) {
            reject(/* new Error(...) */);
        }

        // Timeout waiting for collection to start. Note that the reject function becomes a no-op
        // once the promise is resolved, so we don't need to cancel this timer on success.
        setTimeout(rejectForStartTimeout, REQUEST_TIME_LIMIT_IN_MS);

        // NO PROMISES.
        // instead, listen for events

        // Assume iface.requestStart makes a request to /start and returns a promise that
        // resolves when the request receives a successful HTTP response.
        // iface.waitForCollectionStart returns a NEW promise that resolves if status is
        // isCollecting: true (isCollecting may ALREADY be true, in which case it the promise
        // resolves "immediately")
        iface.requestStart()   // TODO can the /start request fail because canControl is false?
          .then(waitForCollectionStart)
          .then(done);
    });
}


function stop() {
    // NOTE: All we're doing is requesting stop and waiting for it to actually happen.
    // Stop can also occur without our request, which means

    // TODO: Structurally similar to start(); how to factor?
    return new RSVP.Promise(function(resolve, reject) {

        function rejectForStopTimeout() {
            // TODO: check with lower layer to see if control is disabled
            reject(/* new Error(...); */);
        }

        if ( ! iface.isConnected() ) {
            reject(/* new Error(...) */);
        }

        // Timeout waiting for collection to start. Note that the reject function becomes a no-op
        // once the promise is resolved, so we don't need to cancel this timer on success.
        setTimeout(rejectForStopTimeout, REQUEST_TIME_LIMIT_IN_MS);

        // Rejection signals an error to layer above. However, layer above should handle the 'stop'
        // event rather than simply waiting for resolution of the promise, because 'stop' can happen
        // without our having requested it!
        resolve(iface.requestStop().then(waitForCollectionStop));
    });
}


iface.on('collectionStop', function() {
    iface.removeListener('data', dataHandler);
    events.emit('stop');
});


var nextIndexByColumnId = {};


// after start of collection, only track data from newest dataset.
function startTrackingColumns() {
    nextIndexByColumnId = {};

    var dataset = iface.datasets[0];  // newest dataset
    return dataset.columns.forEach(function(c) {
        nextIndexByColumnId[c.id] = 0;
    });
}

// List of unit types (as reported by LQ2) for each column in the most-recent dataset
function getSensorList() {
    var dataset = iface.datasets[0];  // newest dataset
    return dataset.columns.map(function(c) { return c.type; });
}

function dataHandler() {
    var dataset = iface.datasets[0];
    dataset.columns.forEach(function(c, index) {
        var newData = c.data.slice(nextIndexByColumnId[c.id]);
        nextIndexByColumnId[c.id] = c.data.length;
        events.emit('data.'+index, newData);
    });
}


module.exports = {
    connect: connect,
    start: start,
    stop: stop,
    on: function() {} // TODO
};
