const events = require('events')
const _ = require('lodash')
const es = require('event-stream')
const Dockerode = require('dockerode')
const moment = require('moment-timezone')
const request = require('request-promise')

const config = _.defaults({
	verbose: process.env.VERBOSE,
	solrHost: process.env.SOLR_HOST,
	solrPort: process.env.SOLR_PORT,
	solrCollectionName: process.env.SOLR_COLLECTION_NAME,
	logHostName: process.env.LOG_HOST_NAME,
	logMaxCount: process.env.LOG_MAX_COUNT,
	logMaxTime: process.env.LOG_MAX_TIME,
	watchdogResetTime: process.env.WATCHDOG_RESET_TIME,
}, {
	verbose: false, // print the logs it collects
	solrHost: 'localhost', // solr host
	solrPort: 80, // solr port
	solrCollectionName: 'collection1', // solr collection name
	logHostName: 'UNKNOW_HOST', // machine name set to the doc
	logMaxCount: 1000, // post a doc when collect more than logMaxCount lines
	logMaxTime: 30000, // post a doc when now > lastPostTime + logMaxTime, unit ms
	watchdogResetTime: 0, // close tailer when slient
})

class ContainerTailer extends events.EventEmitter {
	constructor(id, options) {
		super()
		this.id = id
		this.shortId = id.substring(0, 5)
		this.options = _.defaults(options, config)
		this.stream = null
		const t = Number(this.options.watchdogResetTime)
		this.feedWatchdog = t ? _.debounce(this.close, t) : () => {}
	}

	async start() {
		this.docker = new Dockerode()
		const container = this.docker.getContainer(this.id)
		this.stream = await container.logs({ follow: true, stdout: true, stderr: true, tail: 0 })
		this.stream
			.pipe(es.map((data, cb) => cb(null, data.slice(8))))
			.pipe(es.split())
			.pipe(es.map((line, cb) => {
				if (this.isClosed) {
					console.log(`[${this.shortId}]recv data after close`)
				} else {
					this.feedWatchdog()
				}
				this.emit('log', line)
				return cb()
			}))
		const close = this.close.bind(this)
		this.stream.on('error', close)
		this.stream.on('end', close)
		return this
	}

	close(err) {
		if (this.stream) {
			this.stream.destroy()
			this.stream = null
		}
		this.emit('close', err)
		this.removeAllListeners()
	}

	get isClosed() {
		return this.stream === null
	}
}

/*
 * push log to server if condition match.
 * logCache will be cleared after doc submited.
 *
 * options:
 *     logAppName: program name to be indexed
 */
class LogSubmitter extends ContainerTailer {
	constructor(id, options) {
		super(id, options)
		if (!this.options.logAppName) throw new Error('logAppName must set')
		this.logCache = []
		this.lastCommitTime = Date.now()

		this.on('log', (line) => {
			this.submitDebounce(line)
		})
		this.on('close', () => {
			this.submitDebounce(null, true)
		})
	}

	submitDebounce(line, submitAnyway = false) {
		const now = Date.now()
		if (submitAnyway) {
			if (!this.logCache.length) return null
		} else {
			if (!line) return null
			this.logCache.push(line)
			if (this.options.verbose) {
				console.log(`[${this.options.logHostName}][${this.options.logAppName}][${this.shortId}]${line}`)
			}
			if (this.logCache.length < this.options.logMaxCount && now < this.lastCommitTime + this.options.logMaxTime) {
				return null
			}
		}
		// submit
		const doc = {}
		doc.id = now + Math.random()

		const lines = this.logCache.join('\n')
		const count = this.logCache.length
		doc.packet_content = lines
		doc.contentindex = lines

		const tMatch = lines.match(/\d{6} \d{2}:\d{2}:\d{2}/)
		const tMoment = tMatch ? moment.tz(tMatch[0], 'YYMMDD HH:mm:ss', process.env.TZ || 'UTC') : moment()
		doc.dateint = tMoment.unix()

		doc.types = this.options.logAppName
		doc.hostname = this.options.logHostName

		const options = {
			url: `http://${this.options.solrHost}:${this.options.solrPort}/solr/${this.options.solrCollectionName}/update/json`,
			method: 'POST',
			json: [doc],
		}
		this.logCache = []
		this.lastCommitTime = now
		return request(options).then((resp) => {
			console.log(`[${this.options.logHostName}][${this.options.logAppName}][${this.shortId}]${count} docs submit as ${doc.id} ${JSON.stringify(resp)}`)
		}).catch((err) => {
			console.error(`[${this.options.logHostName}][${this.options.logAppName}][${this.shortId}]${count} docs submit as ${doc.id} failed. ${err.message || err}`)
		})
	}
}

const allTasks = {}
let listAndTailContainer
const latc = () => listAndTailContainer().catch(e => console.error(e.message || e))

async function tailAndSubmit(container) {
	if (allTasks[container.Id]) return null
	allTasks[container.Id] = true
	console.log(`tail ${container.Id} ${config.logHostName} ${container.Labels['dockerLogCollector.logAppName']}`)
	const submitter = new LogSubmitter(container.Id, {
		logAppName: container.Labels['dockerLogCollector.logAppName'],
	})
	await submitter.start()
	submitter.on('close', (err) => {
		console.log(`Container ${container.Id} stop.`, err ? err.message : '')
		delete allTasks[container.Id]
		setTimeout(latc, 2000)
	})
	return submitter
}

listAndTailContainer = async function () {
	console.log('listAndTailContainer')
	const docker = new Dockerode()
	const containers = await docker.listContainers({ filters: { label: ['dockerLogCollector.logAppName'] } })
	const tasks = _.map(_.filter(containers, e => e.Labels['dockerLogCollector.logAppName']), e => tailAndSubmit(e).catch(err => console.log(err.message || e)))
	await Promise.all(tasks)
}

async function listernDockerEvents() {
	console.log('waiting docker container')
	const docker = new Dockerode()
	const stream = await docker.getEvents({ filters: { type: ['container'], event: ['start'] } })
	stream.on('data', () => {
		console.log('new container start')
		latc()
	})
}

listernDockerEvents().catch(e => console.error(e.message || e))
latc()
