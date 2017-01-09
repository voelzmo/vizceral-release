var elasticsearch = require("elasticsearch");
var util = require('util');

var express = require('express');
var app = express();
var elastic_ip = process.env.ELASTIC_IP;

app.use(function (req, res, next) {

    // Website you wish to allow to connect
    res.setHeader('Access-Control-Allow-Origin', 'http://172.18.105.87:8080');

    // Request methods you wish to allow
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');

    // Request headers you wish to allow
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');

    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader('Access-Control-Allow-Credentials', true);

    // Pass to next layer of middleware
    next();
});

app.get('/query-elasticsearch', function (req, res) {

    data = getElasticsearchData(elastic_ip);
    data.then(function (resp) {
        // console.log(util.inspect(resp.aggregations.destinations.buckets, { depth: null }));
        results = resp.aggregations.destinations.buckets;

        nodes = [{
            name: 'INTERNET' // Required... this is the entry node
        }];
        connections = [];
        results.forEach(function (node) {
            if (nodes.find((n) => { return n.name == node.key; }) === undefined) {
                nodes.push({ name: node.key ,
                metadata: {
                  "streaming": 1
                },
                renderer: "focusedChild"
              });
            }
            node.from.buckets.forEach(function (connection) {
                connections.push({ source: connection.key, target: node.key, metrics: { normal: connection.doc_count } });
                // add both nodes to the node list if they're not already in it
                if (nodes.find((n) => { return n.name == connection.key; }) === undefined) {
                    nodes.push({ name: connection.key });
                }
            }, this);
        }, this);


        vizceral_data = {
            // Which graph renderer to use for this graph (currently only 'global' and 'region')
            renderer: 'global',
            // since the root object is a node, it has a name too.
            name: 'edge',
            // OPTIONAL: The maximum volume seen recently to relatively measure particle density. This 'global' maxVolume is optional because it can be calculated by using all of the required sub-node maxVolumes.
            maxVolume: 100000,
            // list of nodes for this graph
            nodes: [
                {
                    renderer: 'region',
                    layout: 'ltrTree',
                    // OPTIONAL Override the default layout used for the renderer.
                    name: 'marcos-region',
                    // Unix timestamp. Only checked at this level of nodes. Last time the data was updated (Needed because the client could be passed stale data when loaded)
                    updated: Date.now(),
                    metadata: {},
                    // The maximum volume seen recently to relatively measure particle density
                    maxVolume: 100000,
                    nodes: nodes,
                    connections: connections
                }
            ]
        };
        console.log(util.inspect(vizceral_data, { depth: null }));
        res.send(vizceral_data);
    }, function (err) {
        console.trace(err.message);
    });

});

app.listen(8081, function () {
    console.log('Server started');
});

function getElasticsearchData(elastic_ip) {
    var response;

    console.log("starting converter");

    var client = elasticsearch.Client({ host: `${elastic_ip}:9200`, apiVersion: "2.3" });
    // client.ping({
    //     // ping usually has a 3000ms timeout
    //     requestTimeout: Infinity
    // }, function (error) {
    //     if (error) {
    //         console.trace('elasticsearch cluster is down!');
    //     } else {
    //         console.log('All is well');
    //     }
    // });


   return client.search({
        index: 'packetbeat-*',
        body: {
            "size": 0,
            "aggregations": {
                "destinations": {
                    "terms": {
                        "field": "dest.ip"
                    },
                    "aggregations": {
                        "from": {
                            "terms": {
                                "field": "source.ip"
                            }
                        }
                    }
                }
            },
            "query": {
                "bool": {
                    "filter": {
                        "bool": {
                            "must": [
                                {
                                    "range": {
                                        "@timestamp": {
                                            "gt": "now-1h"
                                        }
                                    }
                                },
                                {
                                    "exists": {
                                        "field": "dest.ip"
                                    }
                                }
                            ],
                            "must_not": [
                                {
                                    "term": {
                                        "dest.port": "9200"
                                    }
                                },
                                {
                                    "term": {
                                        "dest.ip": "127.0.0.1"
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        }
    });
}
