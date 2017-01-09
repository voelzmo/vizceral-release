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
    nodes = [{
        name: 'INTERNET' // Required... this is the entry node
    }];
    connections = [];

    incoming_request_data = getIncomingRequests(elastic_ip);
    outgoing_request_data = getOutgoingRequests(elastic_ip);


    Promise.all([incoming_request_data, outgoing_request_data]).then(function (responses) {
        console.log("all promises returned");
        incoming_request_results = responses[0].aggregations.destinations.buckets;
        console.log(`incoming results '${incoming_request_results}'`);
        outgoing_request_results = responses[1].aggregations.sources.buckets;
        console.log(`outgoing results '${outgoing_request_results}'`);
        incoming_request_results.forEach(function (node) {
            // add source node to the node list if not already in it
            existing_node = nodes.find((n) => { return n.name == node.key; })
            if (existing_node === undefined) {
                new_node = {
                    name: node.key,
                    metadata: {},
                    renderer: "focusedChild"
                };
                if (node.tags && node.tags.length > 0) {
                    new_node.displayName = node.tags[0];
                }
                nodes.push(new_node);
            } else {
                if (node.tags && node.tags.length > 0) {
                    existing_node.displayName = node.tags[0];
                }
            }
            node.sources.buckets.forEach(function (connection) {
                connections.push({ source: connection.key, target: node.key, metrics: { normal: connection.doc_count } });
                // add destination node to the node list if not already in it
                if (nodes.find((n) => { return n.name == connection.key; }) === undefined) {
                    nodes.push({ name: connection.key });
                }
            }, this);
        }, this);

        outgoing_request_results.forEach(function (node) {
            // add destination node to the node list if not already in it
            existing_node = nodes.find((n) => { return n.name == node.key; })
            if (existing_node === undefined) {
                new_node = {
                    name: node.key,
                    metadata: {},
                    renderer: "focusedChild"
                };
                if (node.tags && node.tags.length > 0) {
                    new_node.displayName = node.tags[0];
                }
                nodes.push(new_node);
            } else {
                if (node.tags && node.tags.length > 0) {
                    existing_node.displayName = node.tags[0];
                }
            }
            node.destinations.buckets.forEach(function (connection) {

                // we have already added connections from the incoming point of view. Make sure we don't add them from the other side as well.
                if (connections.find((c) => { return c.source == connection.key && c.target == node.key }) === undefined) {
                    connections.push({ source: connection.key, target: node.key, metrics: { normal: connection.doc_count } });
                }

                // add source node to the node list if not already in it
                if (nodes.find((n) => { return n.name == connection.key; }) === undefined) {
                    nodes.push({ name: connection.key });
                }
            }, this);
        }, this);

    }, function (err) {
        console.trace(err.message);
    });

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
                name: 'bosh-region',
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

});

app.listen(8081, function () {
    console.log('Server started');
});

function getIncomingRequests(elastic_ip) {
    var response;

    var client = elasticsearch.Client({ host: `${elastic_ip}:9200`, apiVersion: "2.3" });

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
                        "sources": {
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

function getOutgoingRequests(elastic_ip) {
    var response;

    var client = elasticsearch.Client({ host: `${elastic_ip}:9200`, apiVersion: "2.3" });

    return client.search({
        index: 'packetbeat-*',
        body: {
            "size": 0,
            "aggregations": {
                "sources": {
                    "terms": {
                        "field": "source.ip"
                    },
                    "aggregations": {
                        "destinations": {
                            "terms": {
                                "field": "dest.ip"
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
