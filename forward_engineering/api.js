const _ = require('lodash');
const { generateVertices, generateEdges } = require('./gremlinHelper');
const reverseEngineeringApi = require('../reverse_engineering/api');
const applyToInstanceHelper = require('./applyToInstanceHelper');

module.exports = {
	generateContainerScript(data, logger, cb) {
		let { collections, relationships, jsonData } = data;
		logger.clear();
		try {
			let resultScript = '';

			collections = collections.map(JSON.parse);
			relationships = relationships.map(JSON.parse);

			const verticesScript = generateVertices(collections, jsonData);
			const edgesScript = generateEdges(collections, relationships, jsonData);

			if (verticesScript) {
				resultScript += verticesScript;
			}

			if (edgesScript) {
				resultScript += '\n\n' + edgesScript;
			}

			cb(null, resultScript);
		} catch (e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');

			cb({ message: e.message, stack: e.stack });
		}
	},

	async applyToInstance(data, logger, cb, app) {
		try {
			const sshService = app.require('@hackolade/ssh-service');
			const { parseScriptStatements, getGremlinClient, runGremlinQueries } = applyToInstanceHelper({
				sshService,
			});

			logger.clear();
			logger.log('info', data, data.hiddenKeys);

			if (!data.script) {
				return cb({ message: 'There is no script to apply' });
			}
			const progress = createLogger(logger, '', '');

			progress('Applying Gremlin script ...');

			const { labels, edges } = parseScriptStatements(data.script);
			const gremlinClient = await getGremlinClient(data);

			progress('Uploading vertices ...');

			await runGremlinQueries(gremlinClient, labels);

			progress('Uploading edges ...');

			await runGremlinQueries(gremlinClient, edges);

			cb();
		} catch (err) {
			logger.log('error', mapError(err));
			cb(mapError(err));
		}
	},

	testConnection(connectionInfo, logger, cb, app) {
		reverseEngineeringApi.testConnection(connectionInfo, logger, cb, app);
	},
};

const createLogger = (logger, containerName, entityName) => message => {
	logger.progress({ message, containerName, entityName });
	logger.log('info', { message }, 'Applying to instance');
};

const mapError = error => {
	return {
		message: error.message,
		stack: error.stack,
	};
};
