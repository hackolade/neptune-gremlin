const { generateVertices, generateEdges } = require('./gremlinHelper');

function generateContainerScript(data, logger, cb) {
	const { jsonData } = data;
	let { collections, relationships } = data;
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
}

module.exports = {
	generateContainerScript,
};
