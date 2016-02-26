var stats = require('../voxel-stats');
var ChunkStore = require('../chunk-store');
var mysql = require('mysql');
var debug = false;


var MysqlChunkStore = function(generator, config) {
    var self = this;
    ChunkStore.call(this, generator);
    this.chunkCache = {};
    this.toSave = {};
    this.mysqlPool = mysql.createPool(config);

    setInterval(
        function() {
            self.save();
        },
        100
    );
};
module.exports = MysqlChunkStore;


MysqlChunkStore.prototype.get = function(chunkID) {
    var self = this;
    if (chunkID in this.chunkCache) {
        this.emitter.emit('got', this.chunkCache[ chunkID ]);
        return;
    }

    // Check filesystem
    if (debug) {
        console.log('MysqlChunkStore:get ' + chunkID);
    }
    // Very bad things happen when position doesn't hold numbers
    var position = chunkID.split('|').map(function(value) {
        return Number(value);
    });
    var sql = 'select voxels from chunk where x=? and y=? and z=?';
    this.mysqlPool.query(sql, position, function(error, results) {
        if (error) {
            console.log('Error in chunk fetch query');
            return;
        }
        if (results.length == 0) {
            // File not found, generate it
            chunk = self.generator.get(chunkID);
            if (chunk) {
                self.chunkCache[ chunkID ] = chunk;
                self.toSave[chunkID] = true;
                if (debug) {
                    console.log('MysqlChunkStore::get queueing for saving: ' + chunkID);
                }
                self.emitter.emit('got', chunk);
            } else {
                console.log('no chunk?');
                // For some reason our generator didn't return a chunk
            }
            return;
        } else if (results.length == 1) {
            if (debug) {
                console.log('MysqlChunkStore:got ' + chunkID);
            }
        
            var chunk = {
                position: position,
                chunkID: chunkID,
                voxels: new Uint8Array(results[0].voxels)
            };
            self.chunkCache[chunkID] = chunk;
            self.emitter.emit('got', chunk);
        }
    });
};


// Update chunks if we have them in memory
MysqlChunkStore.prototype.gotChunkChanges = function(chunks) {
    var self = this;
    // No race conditions here for memory store, but database and file might be a different story
    for (var chunkID in chunks) {
        if (chunkID in self.chunkCache) {
            var chunk = self.chunkCache[chunkID];
            var details = chunks[chunkID];
            for (var i = 0; i < details.length; i += 2) {
                var index = details[i];
                var val = details[i + 1];
                var old = chunk.voxels[index];
                chunk.voxels[index] = val;
                if (old) {
                    if (val) {
                        stats.count('blocks.changed');
                    } else {
                        stats.count('blocks.destroyed');
                    }
                } else {
                    stats.count('blocks.created');
                }

            }
            self.toSave[chunkID] = true;
            if (debug) {
                console.log('MysqlChunkStore::gotChunkChanges queueing for saving: ' + chunkID);
            }
        } else {
            // For some reason, chunk not found in this.chunkCache
        }
    }
};


// Call this on a timeout
// Callback gets triggered on success or failure
// Schedule the next timeout afterwards
MysqlChunkStore.prototype.save = function() {
    var i = 0;
    for (var chunkID in this.toSave) {
        if (i > 10) {
            break;
        }
        if (chunkID in this.chunkCache) {
            this.saveVoxels(chunkID);
            delete this.toSave[chunkID];
            i++;
        }
    }
};


MysqlChunkStore.prototype.saveVoxels = function(chunkID) {
    var chunk = this.chunkCache[chunkID];
    var position = chunkID.split('|').map(function(value) {
        return Number(value);
    });
    this.mysqlPool.query(
        'REPLACE INTO chunk SET ?',
        {
            x: position[0],
            y: position[1],
            z: position[2],
            voxels: new Buffer(chunk.voxels),
            updated_ms: Date.now()
        },
        function(error) {
            if (error) {
                console.log('MysqlChunkStore::saveVoxels', error);
            }
        }
    );
};