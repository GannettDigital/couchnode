var request = require("request").defaults({json:true}),
    qs = require('querystring');

exports.create = function(connection, config, ready) {
    // We aren't using prototype inheritance here for two reasons:
    // 1) even though they may be faster, this constructor won't be called frequently
    // 2) doing it this way means we get better inspectability in the repl, etc.

    function on(event, callback) {
        connection.on(event, callback);
    };

    function _multiGet(keys, callback, spooledCalledback) {
        // Spools multiple gets on the client and hit the callback only once
        var errors = []
            , values = []
            , metas = [],
            callsRemaining;

        function handleValue(err, value, meta) {
            if(callback) {
                callback(err, value, meta);
            }
            if(spooledCalledback) {
                if(err) {
                    errors.push(err);
                }
                values.push(value);
                metas.push(meta);

                callsRemaining--;
                if(callsRemaining == 0) {
                    spooledCalledback(errors.length ? errors : null, values, metas);
                }
            }
        }

        callsRemaining = keys.length;
        connection.get(keys, undefined, getHandler, [handleValue,this]);
    }

    function _singleGet(key, callback, spooledCalledback) {
        // We provide a handler function here to allow for the spooledCallback
        //   to still be called, even for a single get to maintain consistency
        function handleValue(err, value, meta) {
            if(callback) {
                callback(err, value, meta);
            }
            if(spooledCalledback) {
                spooledCalledback(err, value, meta);
            }
        }

        connection.get(key, undefined, getHandler, [handleValue,this]);
    }

    function get(key, callback, spooledCallback) {
        requiredArgs(key, callback);
        if (key instanceof Array) {
            _multiGet.call(this, key, callback, spooledCallback);
        } else {
            _singleGet.call(this, key, callback, spooledCallback);
        }
    };

    function set(key, doc, meta, callback) {
        if (meta instanceof Function) {
            callback = meta;
            meta = {};
        }
        requiredArgs(key, doc, callback);
        connection.set(key, makeDoc(doc), meta.flags, meta.cas, setHandler, [callback,this]);
    };

    function incr(key, meta, callback) {
        if (meta instanceof Function) {
            callback = meta;
            meta = {};
        }

        connection.arithmetic( key,
                    (meta.offset == undefined) ? 1: meta.offset,
                    (meta.defaultValue == undefined) ? 0: meta.defaultValue,
                    (meta.expiry == undefined) ? 0: meta.expiry,
                    meta.cas,
                    arithmeticHandler,
                    [callback,this]);
    };

    function decr(key, meta, callback) {
        if (meta instanceof Function) {
            callback = meta;
            meta = {};
        }

        connection.arithmetic( key,
                    ((meta.offset == undefined) ? 1: meta.offset) *-1,
                    (meta.defaultValue == undefined ) ? 0: meta.defaultValue,
                    (meta.expiry == undefined) ? 0: meta.expiry,
                    meta.cas,
                    arithmeticHandler,
                    [callback,this]);
    }

    function remove(key, meta, callback) {
        if (meta instanceof Function) {
            callback = meta;
            meta = {};
        }
        requiredArgs(key, callback);
        connection.remove(key, meta.cas, deleteHandler, [callback,this]);
    }

    function replace(key, doc, meta, callback) {
        if (meta instanceof Function) {
            callback = meta;
            meta = {};
        }
        requiredArgs(key, doc, callback);
        connection.replace(key, makeDoc(doc), meta.flags, meta.cas, setHandler, [callback,this]);
    };

    function add(key, doc, meta, callback) {
        if (meta instanceof Function) {
            callback = meta;
            meta = {};
        }
        requiredArgs(key, doc, callback);
        connection.add(key, makeDoc(doc), meta.flags, meta.cas, setHandler, [callback,this]);
    };

    function getVersion( ) {
        return connection.getVersion( );
    }

    function strError( errorCode ) {
        return connection.strError( errorCode );
    }

    var viewHosts;

    // todo this function should be triggered on topology change
    function updateClusterMap(callback) {
        var uiHost = connection.getRestUri();
        request("http://"+uiHost+"/pools/"+encodeURIComponent(config.bucket),
            function(err, resp, clusterMap) {
                if (err) {throw(err);}
                viewHosts = clusterMap.nodes.map(function(info) {
                    return info.couchApiBase;
                });
                if (callback) {
                    callback();
                }
            });
    };

    function restHost( )
    {
        // distribute queries across the cluster randomly
        return viewHosts[Math.floor(Math.random() * viewHosts.length)];
    }

    function view(ddoc, name, query, callback) {
        var jsonFields = ["descending", "endkey", "endkey_docid",
            "full_set", "group", "group_level", "inclusive_end",
            "key", "keys", "limit", "on_error", "reduce", "skip",
            "stale", "startkey", "startkey_docid"];

        for (var q in query) {
          if (jsonFields.indexOf(q) != -1) {
            query[q] = JSON.stringify(query[q]);
          }
        }

        var url = restHost() +
            [config.bucket, "_design", ddoc,
                "_view", name].map(encodeURIComponent).join('/') +
                '?' + qs.stringify(query);

        return request(url, function(err,resp,body) {
            restHandler(callback,err,resp,body);
        });
    };

    function createDesignDoc(name, data, callback) {
        var options = {};
        options.url = restHost() +
            [config.bucket, "_design", name].map(encodeURIComponent).join('/');
        options.body = data;

        request.put(options, function(err,resp,body) {
            restHandler(callback,err,resp,body);
        });
    }

    function getDesignDoc(name, callback) {
        var options = {};
        options.url = restHost() +
            [config.bucket, "_design", name].map(encodeURIComponent).join('/');

        request.get(options, function(err,resp,body) {
            restHandler(callback,err,resp,body);
        });
    }

    updateClusterMap(function() {
        ready({
                on : on,
                get : get,
                set : set,
                remove: remove,
                replace : replace,
                add : add,
                view : view,
                incr : incr,
                decr : decr,
                createDesignDoc: createDesignDoc,
                getDesignDoc: getDesignDoc,
                getVersion: getVersion,
                strError: strError
            });
    });
};

function requiredArgs() {
    for (var i = 0; i < arguments.length; i++) {
        if (typeof arguments[i] == 'undefined') {
            throw new ReferenceError("missing required argument")
        }
    };
};

function makeDoc(doc) {
    if (typeof doc == "string") {
        return doc;
    } else {
        return JSON.stringify(doc)
    }
};

function makeError( conn, errorCode ) {
    // Early-out for success
    if( errorCode == 0 ) {
        return null;
    }

    // Build a standard NodeJS Error object with the passed errorCode
    var errObj = new Error( conn.strError(errorCode) );
    errObj.code = errorCode;
    return errObj;
}

function restHandler(callback, error, resp, body) {
    // Ensure the body was parsed as JSON
    try { body = JSON.parse(body) }
    catch (err) { }

    if( error ) {
        // Error talking to server, pass the error on for now
        return callback(error, null);
    } else if( body && body.error ) {
        // This should probably be updated to act differently
        var errObj = new Error(body.error);
        errObj.code = 9999;
        return callback(errObj, null);
    } else {
        if( body.rows ) {
            return callback(null, body.rows);
        } else if( body.results ) {
            return callback(null, body.results);
        } else {
            return callback(null, body);
        }
    }
};

// convert the c-based set callback format to something sane
function setHandler(data, errorCode, key, cas) {
    var error = makeError( data[1], errorCode );
    data[0](error, {id : key, cas : cas});
}

function arithmeticHandler( data, errorCode, key, cas, value ) {
    var error = makeError( data[1], errorCode );
    data[0]( error, key, cas, value );
}

function getHandler(data, errorCode, key, cas, flags, value) {
    // if it looks like it might be JSON, try to parse it
    if (/[\{\[]/.test(value)) {
        try {
            value = JSON.parse(value)
        } catch (e) {
            // console.log("JSON.parse error", e, value)
        }
    }
    var error = makeError( data[1], errorCode );
    data[0](error, value, {id : key, cas: cas, flags : flags});
};

function deleteHandler(data, errorCode, key) {
    var error = makeError( data[1], errorCode );
    data[0](error, {id : key});
}