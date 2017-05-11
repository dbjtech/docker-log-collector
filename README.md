# docker log collector

Collect all logs from other docker containers with label dockerLogCollector.logAppName and post the logs to solr server.

## Usage

```
docker run -it -v /var/run/docker.sock:/var/run/docker.sock --link solrContainerNameOrId:solr -e SOLR_PORT=80 -e SOLR_HOST=solr dbjtech/docker-log-collector
```

then start other docker

```
docker run -l dockerLogCollector.logAppName=aNodeJSApp node:alpine node -e "setInterval(()=>console.log(new Date()), 1000)"
```

## Config

Check the following code

```js
const config = _.defaults({
	verbose: process.env.VERBOSE,
	solrHost: process.env.SOLR_HOST,
	solrPort: process.env.SOLR_PORT,
	solrCollectionName: process.env.SOLR_COLLECTION_NAME,
	logHostName: process.env.LOG_HOST_NAME,
	logMaxCount: process.env.LOG_MAX_COUNT,
	logMaxTime: process.env.LOG_MAX_TIME,
}, {
	verbose: false, // print the logs it collects
	solrHost: 'localhost', // solr host
	solrPort: 80, // solr port
	solrCollectionName: 'collection1', // solr collection name
	logHostName: 'UNKNOW_HOST', // machine name set to the doc
	logMaxCount: 1000, // post a doc when collect more than logMaxCount lines
	logMaxTime: 30000, // post a doc when now > lastPostTime + logMaxTime, unit ms
})
```

## Notice

- container run without dockerLogCollector.logAppName label will be ignore
- new created container will be add to the watching list automatically
