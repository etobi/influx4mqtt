#!/usr/bin/env node
var pkg =   require('./package.json');
var config = require('yargs')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('v', 'possible values: "error", "warn", "info", "debug"')
    .describe('n', 'instance name. used as mqtt client id and as prefix for connection-state topic')
    .describe('u', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('h', 'show help')
    .alias({
        'c': 'config',
        'h': 'help',
        'n': 'name',
        'u': 'url',
        'v': 'verbosity',
        'i': 'influx-host',
        'p': 'influx-port',
        'd': 'influx-db'

    })
    .default({
        'u': 'mqtt://127.0.0.1',
        'n': 'influx4mqtt',
        'v': 'info',
        'influx': false,
        'influx-host': '127.0.0.1',
        'influx-port': 8086,
		'influx-username': 'root',
		'influx-password': 'root',
        'influx-db': 'mqtt',
		'subscriptions': ['#'],
		'maxBufferCount': 1000,
		'writeBufferInterval': 10000
    })
    .config('config')
    .version(pkg.name + ' ' + pkg.version + '\n', 'version')
    .help('help')
    .argv;
	
console.log('mqtt connecting', config.url);
var mqtt = require('mqtt')
	.connect(config.url, {
		will: {
			topic: config.name + '/connected',
			payload: '0'
		}
	});
mqtt.publish(config.name + '/connected', '2');

var subscriptions = config.subscriptions;

console.log('connecting InfluxDB', config['influx-host']);
var influx = require('influx')({
    host: config['influx-host'] || '127.0.0.1',
    port: config['influx-port'] || 8086, // optional, default 8086
    protocol: config['influx-protocol'] || 'http', // optional, default 'http'
    username: config['influx-username'] || null,
    password: config['influx-password'] || null,
    database: config['influx-db'] || 'mqtt'
});

var buffer = {};
var bufferCount = 0;
var ignoreRetain = true;

var connected;
mqtt.on('connect', function () {
    connected = true;
    console.log('mqtt connected ' + config.url);

    subscriptions.forEach(function (subs) {
		var topic = subs;
		if (typeof subs == 'object') {
			topic = subs.topic;
		}
        console.log('mqtt subscribe ' + topic);
        mqtt.subscribe(topic);
    });
});


mqtt.on('close', function () {
    if (connected) {
        connected = false;
        console.log('mqtt closed ' + config.url);
    }
});

mqtt.on('error', function () {
    console.error('mqtt error ' + config.url);
});

var matchTopic = function(actualTopic, subscribedTopic) {
	return actualTopic.match(subscribedTopic.replace("+", "[^/]+").replace("#", ".+"));
}

mqtt.on('message', function (topic, payload, msg) {

    if (ignoreRetain && msg.retain) return;

    var timestamp = (new Date()).getTime();

    payload = payload.toString();

	var subscriptionConfig = null;
	subscriptions.forEach(function (subscription) {
		if (typeof subscription == "string" && matchTopic(topic, subscription)) {
			subscriptionConfig = {topic: subscription};
		} else if (typeof subscription == "object" && matchTopic(topic, subscription.topic)) {
			subscriptionConfig = subscription;
		}
	});

    var seriesName = topic;
    var value = payload;
	
	if (value.substr(0, 1) == '{' && subscriptionConfig.key) {
		var json = JSON.parse(value);
		value = json[subscriptionConfig.key];
	}
	
	if (typeof value == 'string' && value.match(/^[0-9]{10}\.[0-9]{3}:[0-9]+(\.[0-9]+)?$/)) {
		var split = value.split(':');
		timestamp = split[0].replace('.', '');
		value = split[1];
	}
	
	var valueFloat = parseFloat(value);

    if (value === true || value === 'true') {
        value = '1.0';
    } else if (value === false || value === 'false') {
        value = '0.0';
    } else if (isNaN(valueFloat)) {
        return; // FIXME do we need strings? Creating a field as string leads to errors when trying to write float on it. Can we expect topics to be of the same type always?
        value = '"' + value + '"';
    } else {
        value = '' + valueFloat;
        if (!value.match(/\./)) value = value + '.0';
    }

    if (!buffer[seriesName]) buffer[seriesName] = [];
    buffer[seriesName].push([{value: value, time: timestamp}]);
    bufferCount += 1;
    if (bufferCount > config.maxBufferCount) write(); 

});

function write() {
    if (!bufferCount) return;
    influx.writeSeries(buffer, {}, function (err, res) {
        if (err) {
			console.error('error', err);
		}
    });
    buffer = {};
    bufferCount = 0;
    ignoreRetain = false;
}

setInterval(write, config.writeBufferInterval); // todo command line param
