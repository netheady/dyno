var Readable = require('stream').Readable;
var _ = require('underscore');
var parallel = require('parallel-stream');

function reduceCapacity(existing, incoming) {
  existing = existing || {};
  existing.TableName = existing.TableName || incoming.TableName;

  if (incoming.CapacityUnits) {
    existing.CapacityUnits = (existing.CapacityUnits || 0) + incoming.CapacityUnits;
  }

  if (incoming.Table) {
    existing.Table = existing.Table ?
      { CapacityUnits: existing.Table.CapacityUnits + incoming.Table.CapacityUnits } :
      { CapacityUnits: incoming.Table.CapacityUnits };
  }

  if (incoming.LocalSecondaryIndexes) {
    existing.LocalSecondaryIndexes = existing.LocalSecondaryIndexes ?
      { CapacityUnits: existing.LocalSecondaryIndexes.CapacityUnits + incoming.LocalSecondaryIndexes.CapacityUnits } :
      { CapacityUnits: incoming.LocalSecondaryIndexes.CapacityUnits };
  }

  if (incoming.GlobalSecondaryIndexes) {
    existing.GlobalSecondaryIndexes = existing.GlobalSecondaryIndexes ?
      { CapacityUnits: existing.GlobalSecondaryIndexes.CapacityUnits + incoming.GlobalSecondaryIndexes.CapacityUnits } :
      { CapacityUnits: incoming.GlobalSecondaryIndexes.CapacityUnits };
  }
}

module.exports = function(client, tableName) {
  var stream = {};

  function readableStream(request, params, options) {
    var readable = new Readable(_({ objectMode: true }).defaults(options));
    var nextRequest = client[request](params);
    var pending = false;
    var items = [];

    readable.Count = 0;
    readable.ScannedCount = 0;

    function makeRequest(request) {
      pending = true;

      request
        .on('error', function(err) { readable.emit('error', err); })
        .on('success', function(response) {
          pending = false;

          readable.Count += response.data.Count;
          readable.ScannedCount += response.data.ScannedCount;
          readable.LastEvaluatedKey = response.data.LastEvaluatedKey;

          if (response.data.ConsumedCapacity) {
            if (!readable.ConsumedCapacity) readable.ConsumedCapacity = {};
            reduceCapacity(readable.ConsumedCapacity, response.data.ConsumedCapacity);
          }

          nextRequest = response.hasNextPage() ? response.nextPage() : false;

          response.data.Items.forEach(function(item) { items.push(item); });
          readable._read();
        }).send();
    }

    readable._read = function() {
      var status = true;
      while (status && items.length) status = readable.push(items.shift());
      if (items.length) return;
      if (!nextRequest) return readable.push(null);
      if (status && !pending) makeRequest(nextRequest);
    };

    return readable;
  }

  stream.query = function(params, options) {
    return readableStream('query', params, options);
  };

  stream.scan = function(params, options) {
    return readableStream('scan', params, options);
  };

  stream.put = function(options) {
    options = options || {};
    var params = { RequestItems: {} };
    params.RequestItems[tableName] = [];

    function batchWrite(params, callback) {
      var request = client.batchWrite(params);
      if (options.retry) request.on('retry', options.retry);

      putStream.requestCount++;
      request.send(function(err, data) {
        if (err) return callback(err);
        if (!Object.keys(data.UnprocessedItems).length) return callback();
        batchWrite({ RequestItems: data.UnprocessedItems }, callback);
      });
    }

    function write(item, enc, callback) {
      params.RequestItems[tableName].push({ PutRequest: { Item: item } });
      if (params.RequestItems[tableName].length !== 25) return callback();

      batchWrite(params, callback);
      params.RequestItems[tableName] = [];
    }

    function flush(callback) {
      if (!params.RequestItems[tableName].length) return callback();
      batchWrite(params, callback);
    }

    var putStream = parallel.writable(write, flush, _(options).extend({ objectMode: true }));
    putStream.requestCount = 0;

    return putStream;
  };

  return stream;
};
