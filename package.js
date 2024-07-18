Package.describe({
	name: 'wildhart:jobs',
	version: '2.0.0',
	summary: 'Schedule jobs to run at a later time, including multi-server, super efficient',
	git: 'https://github.com/wildhart/meteor.jobs',
	documentation: 'README.md'
});

Package.onUse(function(api) {
	api.versionsFrom(['2.3', '3.0.1']);
	api.use(["typescript", "mongo", "random", "ecmascript", "check"], "server");
	api.mainModule("jobs.ts", "server");
	api.export(["Jobs", "TypedJob"]);
});
