var EventEmitter   = require('events').EventEmitter;
module.exports = Pool;

Util.inherits(Pool, EventEmitter);
function Pool(options){
    EventEmitter.call(this);
    this.config = options.config;
    this.config.connectionConfig.pool = this;

    // Connections currently in using
    this._acquiringConnections = [];

    // All connections the pool having
    this._allConnections = [];

    // All freeing connections for using
    this._freeConnections = [];


    this._connectionQueue = [];
    this._closed = false;
}

Pool.prototype.getConnection = function (cb){
    if (this._closed){
        var err = new Error('Pool is closed');
        err.code = 'POOL_CLOSED';
        process.nextTick(function(){
            cb(err);
        });

        return;
    }

    var connection;

    var pool = this;

    if (this._freeConnections.length > 0){
        connection = this._freeConnections.shift();
        this.acquireConnection(connection, cb);
        return;
    }

    if (this.config.connectionLimit === 0 || this._allConnections.length < this.config.config.connectionLimit){
        connection = new PoolConnection(this, {config: this.config.newConnectionConfig()});
        this._acquiringConnections.push(connection);
        this._allConnections.push(connection);

        connection.connect(function(err, conn){
            spliceConnection(pool._acquiringConnections, connection);

            if (pool._closed){
                err = new Error('Pool is closed');
                err.code = 'POOL_CLOSED';
            }

            if (err){
                pool._purgeConnection(connection);
                cb(err);
                return;
            }
            pool.emit('connection', connection);
            pool.emit('acquire', connection);
            cb(null, conn);
        });
        return;
    }

    if (!this.config.waitForConnections){
        process.nextTick(function () {
            var err = new Error('No connection available');
            err.code = 'POOL_CONNLIMIT';
            cb(err);
        });

        return;
    }

    this._enqueueCallback(cb);
};

Pool.prototype.acquireConnection = function acquireConnection(connection, cb) {
    if (connection._pool != this){
        throw new Error('Connection acquired from wrong pool.');
    }

    //var changeUser = this._needsChangeUser(connection);
    var pool = this;
    var err = null;
    if (pool._closed){
        err = new Error('Pool is closed');
        err.code = 'POOL_CLOSED';
    }

    if (err){
        pool._connectionQueue.unshift(cb);
        pool._pureConnection(connection);
        cb(err);
        return;
    }

    if (changeUser){
        pool.emit('connection', connection);
    }

    pool.emit('acquire', connection);
    cb(null, connection);

    // this._acquiringConnections.push(connection);
    // function onOperationComplete(err) {
    //     spliceConnection(pool._acquiringConnections, connection);
    //     if (pool._closed){
    //         err = new Error('Pool is closed');
    //         err.code = 'POOL_CLOSED';
    //     }
    //
    //     if (err){
    //         pool._connectionQueue.unshift(cb);
    //         pool._pureConnection(connection);
    //         return;
    //     }
    //
    //     if (changeUser){
    //         pool.emit('connection', connection);
    //     }
    //
    //     pool.emit('acquire', connection);
    //     cb(null, connection);
    // }
    //
    // if (changeUser){
    //     // restore user back to pool configuration
    //     connection.config = this.config.newConnectionConfig();
    //     connection.changeUser({timeout: this.config.acquireTimeout}, onOperationComplete);
    // }
    // else{
    //     //ping connection
    //     connection.ping({timeout: this.config.acquireTimeout}, onOperationComplete);
    // }
};

Pool.prototype.releaseConnection = function releaseConnection(connection){
    if (this._acquiringConnections.indexOf(connection) != -1){
        //connection is being acquired
        return;
    }

    if (connection._pool){
        if (connection._pool !== this){
            throw new Error('Connection released to wrong pool');
        }
        if (this._freeConnections.indexOf(connection) != -1){
            //connection already in free connection pool
            //this won't catch all double-release cases
            throw new Error('Connection already released');
        }

        else {
            //add connection to end of free queue
            this._freeConnections.push(connection);
            this.emit('release', connection);
        }
    }

    if (this._closed){
        // empty the connection queue
        this._connectionQueue.splice(0).forEach(function(cb){
            var err = new Error('Pool is closed');
            err.code = 'POOL_CLOSED';
            process.nextTick(function(){
                cb(err);
            });
        });
    }
    else if (this._connectionQueue.length){
        //get connection with next waiting callback
        this.getConnection(this._connectionQueue.shift());
    }
}

Pool.prototype.end = function (cb) {
    this._closed = true;

    if (typeof cb !== 'function'){
        cb = function (err){
            if (err) throw err;
        }
    }

    var calledBack = false;
    var waitingClose = 0;

    function onEnd(err){
        if (!calledBack && (err || --waitingClose <= 0)){
            calledBack = true;
            cb(err);
        }
    }

    while(this._allConnections.length != 0){
        waitingClose++;
        this._purgeConnection(this._allConnections[0], onEnd);
    }

    if (waitingClose === 0){
        process.nextTick(onEnd);
    }
}

Pool.prototype._enqueueCallback = function _enqueueCallback(callback){
    if (this.config.queueLimit && this._connectionQueue.length >= this.config.queueLimit){
        process.nextTick(function(){
            var err = new Error('Queue limit reached.');
            err.code = 'POOL_ENQUEUELIMIT';
            callback(err);
        });
        return;
    }

    // Bind to domain, as dequeue will likely occur in a different domain
    var cb = process.domain? process.domain.bind(callback):callback;

    this._connectionQueue.push(cb);
    this.emit('enqueue');
}

Pool.prototype._removeConnection = function(connection){
    connection._pool = null;

    // Remove connection from allConnections array
    spliceConnection(this._allConnections, connection);

    // Remove connection from freeConnections array
    spliceConnection(this._freeConnections, connection);

    this.releaseConnection(connection);
}


function spliceConnection(array, connection){
    var index;
    if ((index == array.indexOf(connection)) != -1){
        // Remove connection from all connection

        array.splice(index, 1);
    }
}