const jobs = {};
const settings = {
	startupDelay: 1 * 1000, // default 1 second
	maxWait: 5 * 60 * 1000, // specify how long the server could be inactive before another server takes on the master role  (default=5 min)
	log: console.log,
};
const dominatorId = "dominatorId";

const Jobs = {
	collection: new Mongo.Collection("jobs_data"),
	dominatorCollection: new Mongo.Collection("jobs_dominator_3"),
};

Jobs.collection._ensureIndex({name: 1, due: 1, state: 1});

Jobs.configure = function(config) {
	check(config, {
		maxWait: Match.Maybe(Number),
		setServerId: Match.Maybe(Match.OneOf(String, Function)),
		log: Match.Maybe(Match.OneOf(undefined, null, Boolean, Function)),
	});
	Object.assign(settings, config);
	if (settings.log===true) settings.log = console.log;
	settings.log && settings.log('Jobs', 'Jobs.configure', Object.keys(config));
};

Jobs.register = function(newJobs) {
	check(newJobs, Object);
	Object.assign(jobs, newJobs);
	settings.log && settings.log('Jobs', 'Jobs.register', Object.keys(jobs).length, Object.keys(newJobs).join(', '));
};

Jobs.run = function(name, ...args) {
	check(name, String);
	settings.log && settings.log('Jobs', 'Jobs.run', name, ...args);

	var config = args.length && args.pop();
	if (config && !isConfig(config)) {
		args.push(config);
		config = false;
	}
	var error;
	if (config && config.unique) { // If a job is marked as unique, it will only be scheduled if no other job exists with the same arguments
		if (Jobs.count(name, ...args)) error = "Unique job already exists";
	}
	if (config && config.singular) { // If a job is marked as singular, it will only be scheduled if no other job is PENDING with the same arguments
		if (Jobs.countPending(name, ...args)) error = 'Singular job already exists';
	}
	if (error) {
		settings.log && settings.log('Jobs', '  '+error);
		if (config && typeof config.callback =='function') config.callback(error, null);
		return false;
	}
	const jobDoc = {
		name: name,
		arguments: args,
		state: 'pending',
		due: config && getDateFromConfig(config) || new Date(),
		priority: config && config.priority || 0,
		created: new Date(),
	};
	const jobId = Jobs.collection.insert(jobDoc);
	if (jobId) {
		jobDoc._id = jobId;
	} else {
		error = true;
	}

	if (config && typeof config.callback =='function') config.callback(error, jobId && jobDoc);
	return jobDoc;
};

Jobs.execute = function(jobId) {
	check(jobId, String);
	settings.log && settings.log('Jobs', 'Jobs.execute', jobId);
	const job = Jobs.collection.findOne(jobId);
	if (!job) return console.warn('Jobs', 'Jobs.execute', 'JOB NOT FOUND', jobId);
	if (job.state!='pending') return console.warn('Jobs', 'Jobs.execute', 'JOB IS NOT PENDING', job)

	executeJob(job);
}

Jobs.replicate = function(jobId, config) {
	check(jobId, String);
	const date = getDateFromConfig(config);
	const job = Jobs.collection.findOne(jobId);
	if (!job) return console.warn('Jobs', '    Jobs.replicate', 'JOB NOT FOUND', jobId);

	delete job._id;
	job.due = date;
	job.state = 'pending';
	const newJobId = Jobs.collection.insert(job);
	settings.log && settings.log('Jobs', '    Jobs.replicate', jobId, config);
	return newJobId;
};

Jobs.reschedule = function(jobId, config) {
	check(jobId, String);
	const date = getDateFromConfig(config);
	var set = {due: date};
	if (config.priority) set.priority = config.priority;
	const count = Jobs.collection.update({_id: jobId, state: 'pending'}, {$set: set});
	settings.log && settings.log('Jobs', '    Jobs.reschedule', jobId, config, date, count);
	if (typeof config.callback =='function') config.callback(count==0, count);
};

Jobs.remove = function(jobId) {
	var count = Jobs.collection.remove({_id: jobId});
	settings.log && settings.log('Jobs', '    Jobs.remove', jobId, count);
	return count>0;
};

Jobs.clear = function(state, jobName, ...args) {
	const query = {};

	if (state==="*") query.state = {$exists: true};
	else if (typeof state==="string") query.state = state;
	else if (typeof state==="object" && state) query.state = {$in: state}; // && state to allow state=null for default
	else query.state = {$in: ["success", "failure"]};

	if (typeof jobName === "string") query.name = jobName;
	else if (typeof jobName === "object") query.name = {$in: jobName};

	const callback = args.length && typeof args[args.length-1]=='function' ? args.pop() : false;
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];

	const count = Jobs.collection.remove(query);
	settings.log && settings.log('Jobs', 'Jobs.clear', count, query);
	if (typeof callback=='function') callback(null, count);
	return count;
};

Jobs.findOne = function(jobName, ...args) {
	check(jobName, String);
	const query = {name: jobName};
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];
	return Jobs.collection.findOne(query);
};

Jobs.count = function(jobName, ...args) {
	check(jobName, String);
	const query = {name: jobName};
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];
	const count = Jobs.collection.find(query).count();
	return count;
};

Jobs.countPending = function(jobName, ...args) {
	check(jobName, String);
	const query = {
		name: jobName,
		state: 'pending',
	};
	for (var a=0; a<args.length; a++) query["arguments."+a]=args[a];
	const count = Jobs.collection.find(query).count();
	return count;
};

export { Jobs }

/********************************* Controller *********************/

Meteor.startup(function() {
	settings.log && settings.log('Jobs', 'Meteor.startup');
	Jobs.dominatorCollection.remove({_id: {$ne: dominatorId}});
	Meteor.setTimeout(()=>dominator.start(), settings.startupDelay);
})

const dominator = {
	serverId: null,
	lastPing: null,
	pingInterval: null,
	takeControlTimeout: null,
	start() {
		this.serverId = (typeof settings.setServerId == 'string' && settings.setServerId)
			|| (typeof settings.setServerId == 'function' && settings.setServerId())
			|| Random.id();

		Jobs.dominatorCollection.find({_id: dominatorId}).observe({
			changed: (newPing) => this.observer(newPing),
		});

		this.lastPing = Jobs.dominatorCollection.findOne();
		const lastPingIsOld = this.lastPing && this.lastPing.date && this.lastPing.date.valueOf() < new Date().valueOf() - settings.maxWait;
		settings.log && settings.log('Jobs', 'startup', this.serverId, JSON.stringify(this.lastPing), 'isOld='+lastPingIsOld);

		if (!this.lastPing) this.takeControl('no ping')																// fresh installation, no one is in control yet.
		else if (this.lastPing.serverId == this.serverId) this.takeControl('restarted')								// we were in control but have restarted - resume control
		else if (lastPingIsOld) this.takeControl('lastPingIsOld '+this.lastPing.serverId+' '+this.lastPing.date);	// other server lost control - take over
		else this.observer(this.lastPing);																	// another server is recently in control, set a timer to check the ping...
		// else leave other server in control
	},
	observer(newPing) {
		settings.log && settings.log('Jobs', 'dominator.observer', newPing);
		if (this.lastPing && this.lastPing.serverId==this.serverId && newPing.serverId!=this.serverId) {
			// we were in control but another server has taken control
			relinquishControl();
		}
		this.lastPing = newPing;
		if (this.takeControlTimeout) {
			Meteor.clearTimeout(this.takeControlTimeout);
			this.takeControlTimeout = null;
		}
		if (this.lastPing.serverId!=this.serverId) {
			// we're not in control, set a timer to take control in the future...
			this.takeControlTimeout = Meteor.setTimeout(() => {
				// if this timeout isn't cleared then the dominator hasn't been updated recently so we should take control.
				this.takeControl('lastPingIsOld '+this.lastPing.serverId+' '+this.lastPing.date);
			}, settings.maxWait);
		}
	},
	takeControl(reason) {
		settings.log && settings.log('Jobs', 'takeControl', reason);
		this.ping();
		jobObserver.start();
	},
	relinquishControl() {
		settings.log && settings.log('Jobs', 'relinquishControl');
		Meteor.clearInterval(this.pingInterval);
		this.pingInterval = null;
		jobObserver.stop();
	},
	ping() {
		if (!this.pingInterval) this.pingInterval = Meteor.setInterval(()=>this.ping(), settings.maxWait*0.8);
		Jobs.dominatorCollection.upsert({_id: dominatorId}, {
			serverId: this.serverId,
			date: new Date(),
		});
		settings.log && settings.log('Jobs', 'ping', this.lastPing.date);
	},
};

const jobObserver = {
	handle: null,
	jobTimeout: null,
	start() {
		if (!this.handle) this.handle = Jobs.collection.find({state: "pending"}, {limit: 1, sort: {due: 1}, fields: {name: 1, due: 1}}).observe({
			changed: (job) => this.observer('changed', job),
			added: (job) => this.observer('added', job),
		});
		// this will automatically call the observer which will set the timer for the next job.
	},
	stop() {
		if (this.handle) this.handle.stop();
		this.handle = null;
		this.clearTimeout();
	},
	observer(type, nextJob) {
		console.log('Jobs', 'jobsObserver.observer', type, nextJob, nextJob && ((nextJob.due - new Date())/(60*60*1000)).toFixed(2)+'h');
		this.clearTimeout();
		if (nextJob) this.jobTimeout = Meteor.setTimeout(()=>this.executeJobs(), nextJob.due - new Date());
	},
	clearTimeout() {
		if (this.jobTimeout) Meteor.clearTimeout(this.jobTimeout);
		this.jobTimeout = null;
	},
	executeJobs() {
		settings.log && settings.log('Jobs', 'executeJobs');
		this.stop(); // ignore job queue changes while executing jobs. Will restart observer with .start() at end
		try {
			Jobs.collection.find({state: "pending", due: {$lte: new Date()}}, {sort: {due: 1, priority: -1}}).forEach(executeJob);
		} catch(e) {
			console.warn('Jobs', 'executeJobs ERROR');
			console.warn(e);
		}
		this.start();
	}
};

function executeJob(job) {
	settings.log && settings.log('Jobs', '  '+job.name);
	if (typeof jobs[job.name]=='undefined') {
		console.warn('Jobs', 'job does not exist:', job.name);
		setJobState(job._id, 'failed');
		return;
	}
	let action = null;
	const self = {
		document: job,
		replicate: function(config) {
			return Jobs.replicate(job._id, config);
		},
		reschedule: function(config) {
			action = 'reschedule';
			Jobs.reschedule(job._id, config);
		},
		remove: function() {
			action = 'remove';
			Jobs.remove(job._id);
		},
		success: function() {
			action = 'success';
			setJobState(job._id, action);
		},
		failure: function() {
			action = 'failure';
			setJobState(job._id, action);
		},
	};

	try {
		jobs[job.name].apply(self, job.arguments);
		console.log('Jobs', '    Done job', job.name, 'result='+action);
	} catch(e) {
		console.warn('Jobs', 'Error in job', job);
		console.warn(e);
		setJobState(job._id, 'failure');
		action = 'failed'
	}

	if (!action) {
		console.warn('Jobs', 'Job was not resolved with success, failure, reschedule or remove', job);
		setJobState(job._id, 'failure');
	}
}

function setJobState(jobId, state) {
	const count = Jobs.collection.update({_id: jobId}, {$set: {state: state}});
	settings.log && settings.log('Jobs', 'setJobState', jobId, state, count);
}

function getDateFromConfig(config) {
	// https://github.com/msavin/SteveJobs..meteor.jobs.scheduler.queue.background.tasks/blob/031fdf5051b2f2581a47f64ab5b54ffbb6893cf8/package/server/imports/utilities/helpers/date.js
	check(config, Match.ObjectIncluding({
		date: Match.Maybe(Date),
		in: Match.Maybe(Object),
		on: Match.Maybe(Object),
	}));

	var currentDate = config.date || new Date();

	Object.keys(config).forEach(function(key1) {
		if (["in","on"].indexOf(key1) > -1) {
			Object.keys(config[key1]).forEach(function(key2) {
				try {
					const newNumber = Number(config[key1][key2]);
					if (isNaN(newNumber)) {
						console.warn('Jobs', "invalid type was input: " + key1 + "." + key2, newNumber)
					} else {
						let fn = (key2+"s").replace('ss', 's').replace('days','date').replace('years','fullYear');
						fn = fn.charAt(0).toUpperCase() + fn.slice(1);
						currentDate['set'+fn](newNumber + (key1=='in' ? currentDate['get'+fn]() : 0));
						// this is shorthand for:
						//		if key1=='in' currentDate.setMonth(newNumber + currentDate.getMonth())
						//		if key1=='in' currentDate.setMonth(newNumber)
						// where set<Month> & get<Month> are defined by key2
					}
				} catch (e) {
					console.warn('Jobs', "invalid argument was ignored: " + key1 + "." + key2, newNumber, fn);
					console.log(e);
				}
			});
		}
	});
	// settings.log && settings.log('Jobs', 'getDateFromConfig', config, currentDate);
	return currentDate;
}

function isConfig(input) {
	return !!(typeof input=='object' && (input.in || input.on || input.priority || input.date || input.data || input.callback || input.singular || input.unique));
}
