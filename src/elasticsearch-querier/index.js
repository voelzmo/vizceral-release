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

    function addOrUpdateNodeInList(node, listOfNodes) {
        existing_node = listOfNodes.find((n) => { return n.displayName == node.key; })
        if (existing_node === undefined) {
            new_node = {
                name: node.key,
                displayName: node.key,
                metadata: {},
                renderer: "focusedChild"
            };
            listOfNodes.push(new_node);
        }
    }

    nodes = [{
        name: 'INTERNET' // Required... this is the entry node
    }];
    connections = [];

    requestsByNode = getRequestsByNode(elastic_ip);
    requestsByNode.then(function (response) {
        request_nodes = response.aggregations.nodes.buckets;
        console.log(util.inspect(request_nodes, { depth: null }));
        request_nodes.forEach(function (node) {
            // add source node to the node list if not already in it
            addOrUpdateNodeInList(node, nodes);

            //add http connections
            node.http.sources.buckets.forEach(function (connection) {
                connectionMetrics = connection.transactionStatus.buckets.reduce((metrics, status) => {
                    if (status.key == "OK") {
                        metrics.normal += status.doc_count;
                    } else if (status.key == "ERROR") {
                        metrics.error += status.doc_count;
                    } else {
                        console.log(`found unhandled transaction status '${status.key}'`)
                    }
                    return metrics;
                }, { normal: 0, error: 0, metadata: { request_type: "http" } });
                connections.push({ source: connection.key, target: node.key, metrics: connectionMetrics });
                // add destination node to the node list if not already in it
                addOrUpdateNodeInList(connection, nodes);
            }, this);

            // add generic tcp flow connections
            node.flows.sources.buckets.forEach(function (connection) {
                existingConnection = connections.find((c) => { return (c.source == connection.key && c.target == node.key); });
                if (existingConnection === undefined) {
                    connections.push({ source: connection.key, target: node.key, metrics: { normal: connection.doc_count, metadata: { request_type: "flow" } } });
                } else {
                    existingConnection.metrics.normal += connection.doc_count;
                }
                // add destination node to the node list if not already in it
                addOrUpdateNodeInList(connection, nodes);
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
        console.log(`data that will be sent to the user '${util.inspect(vizceral_data, { depth: null })}'`);
        res.send(vizceral_data);

    }).catch(console.trace);
});

app.listen(8081, function () {
    console.log('Server started');
});

function getTagForIP(ipAddress, listOfNodes) {
    existing_node = listOfNodes.find((n) => { return n.name == ipAddress; })
}

function getRequestsByNode(elastic_ip) {
    var client = elasticsearch.Client({ host: `${elastic_ip}:9200`, apiVersion: "2.3" });

    return client.search({
        index: 'packetbeat-*',
        body: {
            "size": 0,
            "query": {
                "bool": {
                    "filter": {
                        "bool": {
                            "must": [
                                {
                                    "range": {
                                        "@timestamp": { "gt": "now-1h" }
                                    }
                                }
                            ]
                        }
                    }
                }
            },
            "aggregations": {
                "nodes": {
                    "terms": { "field": "tags" },
                    "aggregations": {
                        "ipAddresses": {
                            "terms": { "field": "fields.ip" }
                        },
                        "flows": {
                            "filter": {
                                "bool": {
                                    "must": [
                                        {
                                            "exists": { "field": "dest.ip" }
                                        },
                                        {
                                            "term": { "type": "flow" }
                                        }
                                    ],
                                    "must_not": [
                                        {
                                            "term": { "dest.port": "9200" }
                                        },
                                        {
                                            "term": { "dest.ip": "127.0.0.1" }
                                        }
                                    ]
                                }
                            },
                            "aggregations": {
                                "sources": {
                                    "terms": { "field": "source.ip" }
                                },
                                "destinations": {
                                    "terms": { "field": "dest.ip" }
                                }
                            }
                        },
                        "http": {
                            "filter": {
                                "bool": {
                                    "must": [
                                        {
                                            "term": { "type": "http" }
                                        },
                                        {
                                            "term": { "direction": "in" }
                                        }
                                    ],
                                    "must_not": [
                                        {
                                            "term": { "ip": "127.0.0.1" }
                                        }
                                    ]
                                }
                            },
                            "aggregations": {
                                "sources": {
                                    "terms": {
                                        "field": "client_ip"
                                    },
                                    "aggregations": {
                                        "transactionStatus": {
                                            "terms": { "field": "status" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}
