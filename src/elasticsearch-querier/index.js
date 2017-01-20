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

    function addOrUpdateNodeInList(nodeIPAddress, listOfNodes) {
        existing_node = listOfNodes.find((n) => { return n.name == nodeIPAddress; })
        if (existing_node === undefined) {
            new_node = {
                name: nodeIPAddress,
                metadata: {},
                renderer: "focusedChild"
            };
            listOfNodes.push(new_node);
        }
    }

    ipsToTags = {};

    nodes = [{
        name: 'INTERNET' // Required... this is the entry node
    }];
    connections = [];

    requestsByNode = getRequestsByNode(elastic_ip);
    requestsByNode.then(function (response) {

        tagsWithIPs = getTagsWithIPs(elastic_ip);
        tagsWithIPs.then(function (response) {
            response.aggregations.nodes.buckets.forEach(function (node) {
                ipsToTags[node.ipAddresses.buckets[0].key] = node.key;
            }, this);
        }).catch(console.trace);

        request_nodes = response.aggregations.nodes.buckets;
        request_nodes.forEach(function (node) {
            // add source node to the node list if not already in it
            nodeIPAddress = node.ipAddresses.buckets[0].key;
            addOrUpdateNodeInList(nodeIPAddress, nodes);

            //add incoming http connections
            node.http_in.sources.buckets.forEach(function (connection) {
                connectionMetrics = connection.transactionStatus.buckets.reduce((metrics, status) => {
                    if (status.key == "OK") {
                        metrics.normal += status.doc_count;
                    } else if (status.key == "Error") {
                        metrics.danger += status.doc_count;
                    } else {
                        console.log(`found unhandled transaction status '${status.key}'`)
                    }
                    return metrics;
                }, { normal: 0, danger: 0 });
                existingConnection = connections.find((c) => { return (c.source == connection.key && c.target == nodeIPAddress); });
                if (existingConnection === undefined) {
                    connections.push({ source: connection.key, target: nodeIPAddress, metrics: connectionMetrics, metadata: { request_type: "http" } });
                }
                // add source node to the node list if not already in it
                addOrUpdateNodeInList(connection.key, nodes);
            }, this);

            //add outgoing http connections
            node.http_out.destinations.buckets.forEach(function (connection) {
                connectionMetrics = connection.transactionStatus.buckets.reduce((metrics, status) => {
                    if (status.key == "OK") {
                        metrics.normal += status.doc_count;
                    } else if (status.key == "Error") {
                        metrics.danger += status.doc_count;
                    } else {
                        console.log(`found unhandled transaction status '${status.key}'`)
                    }
                    return metrics;
                }, { normal: 0, danger: 0 });
                existingConnection = connections.find((c) => { return (c.source == connection.key && c.target == nodeIPAddress); });
                if (existingConnection === undefined) {
                    connections.push({ source: nodeIPAddress, target: connection.key, metrics: connectionMetrics, metadata: { request_type: "http" } });
                }
                // add destination node to the node list if not already in it
                addOrUpdateNodeInList(connection.key, nodes);
            }, this);

            // add incoming generic tcp flow connections
            node.flows.sources.buckets.forEach(function (connection) {
                existingConnection = connections.find((c) => { return (c.source == connection.key && c.target == nodeIPAddress); });
                if (existingConnection === undefined) {
                    connections.push({ source: connection.key, target: nodeIPAddress, metrics: { normal: connection.doc_count }, metadata: { request_type: "flow" } });
                } 
                // add source node to the node list if not already in it
                addOrUpdateNodeInList(connection.key, nodes);
            }, this);


            // add outgoing generic tcp flow connections
            node.flows.destinations.buckets.forEach(function (connection) {
                existingConnection = connections.find((c) => { return (c.source == nodeIPAddress && c.target == connection.key); });
                if (existingConnection === undefined) {
                    connections.push({ source: nodeIPAddress, target: connection.key, metrics: { normal: connection.doc_count }, metadata: { request_type: "flow" } });
                } 
                // add destination node to the node list if not already in it
                addOrUpdateNodeInList(connection.key, nodes);
            }, this);

        }, this);

        addTagsToNodeList(nodes, ipsToTags);

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

function addTagsToNodeList(nodes, ipsToTags) {
    nodes.forEach(function (node) {
        tagForIP = ipsToTags[node.name];
        if (tagForIP !== undefined) {
            node.displayName = tagForIP;
        }
    }, this);
}

function getTagsWithIPs(elastic_ip) {
    var client = elasticsearch.Client({ host: `${elastic_ip}:9200`, apiVersion: "2.3" });

    return client.search({
        index: 'packetbeat-*',
        body: {
            "size": 0,
            "query": {
                "match_all": {}
            },
            "aggregations": {
                "nodes": {
                    "terms": { "field": "tags" },
                    "aggregations": {
                        "ipAddresses": {
                            "terms": { "field": "fields.ip" }
                        }
                    }
                }
            }
        }
    });
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
                        "http_in": {
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
                        },
                        "http_out": {
                            "filter": {
                                "bool": {
                                    "must": [
                                        {
                                            "term": { "type": "http" }
                                        },
                                        {
                                            "term": { "direction": "out" }
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
                                "destinations": {
                                    "terms": {
                                        "field": "ip"
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
