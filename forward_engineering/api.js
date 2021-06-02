const gremlinHelper = require("./gremlinHelper");
const reverseEngineeringApi = require('../reverse_engineering/api');
const applyToInstanceHelper = require("./applyToInstanceHelper");

module.exports = {
	generateContainerScript(data, logger, cb, app) {
		let { collections, relationships, jsonData, containerData } = data;
		logger.clear();
		try {
			const _ = app.require('lodash');
			const helper = gremlinHelper(_);
			let resultScript = '';

			collections = collections.map(JSON.parse);
			relationships = relationships.map(JSON.parse);

			const verticesScript = helper.generateVertices(collections, jsonData);
			const edgesScript = helper.generateEdges(collections, relationships, jsonData);

			if (verticesScript) {
				resultScript += verticesScript;
			}

			if (edgesScript) {
				resultScript += '\n\n' + edgesScript;
			}

			cb(null, resultScript);
		} catch(e) {
			logger.log('error', { message: e.message, stack: e.stack }, 'Forward-Engineering Error');

			cb({ message: e.message, stack: e.stack });
		}
	},

	async applyToInstance(data, logger, cb, app) {
		try {
			const _ = app.require('lodash');
			const aws = app.require('aws-sdk');
			const helper = applyToInstanceHelper(_, aws);
			logger.clear();
			logger.log('info', data, data.hiddenKeys);

			if (!data.script) {
				return cb({ message: 'There is no script to apply' });
			}
			const progress = createLogger(logger, '', '')

			progress('Applying Gremlin script ...');

			const { labels, edges } = helper.parseScriptStatements(data.script);
			const gremlinClient = await helper.getGremlinClient(data);

			progress('Uploading vertices ...');
			
			await helper.runGremlinQueries(gremlinClient, labels);
			
			progress('Uploading edges ...');

			await helper.runGremlinQueries(gremlinClient, edges);
			
			cb();
		} catch(err) {
			logger.log('error', mapError(err));
			cb(mapError(err));
		}
	},

	testConnection(connectionInfo, logger, cb, app) {
		reverseEngineeringApi.testConnection(connectionInfo, logger, cb, app);
	}
};

const createLogger = (logger, containerName, entityName) => (message) => {
	logger.progress({ message, containerName, entityName });
	logger.log('info', { message }, 'Applying to instance');
};

const mapError = (error) => {
	return {
		message: error.message,
		stack: error.stack
	};
};
