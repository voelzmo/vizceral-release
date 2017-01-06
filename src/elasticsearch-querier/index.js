var elasticsearch = require("elasticsearch");
var util = require('util');

var express = require('express');
var app = express();
var elastic_ip = process.env.ELASTIC_IP;

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
                nodes.push({ name: node.key });
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
                    updated: 1462471847,
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

app.listen(8080, function () {
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
