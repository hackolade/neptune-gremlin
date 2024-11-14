const { partition } = require('lodash');
const connectionHelper = require('../reverse_engineering/connectionHelper');
const neptuneHelper = require('../shared/awsNeptuneClient');

const applyToInstanceHelper = ({ sshService }) => ({
	async getGremlinClient(connectionInfo) {
		const neptuneInstance = await neptuneHelper.connect({ connectionInfo });
		const clusterInfo = await neptuneInstance.getBucketInfo();
		const info = {
			...connectionInfo,
			host: clusterInfo.ReaderEndpoint,
			port: clusterInfo.Port,
		};
		return await connectionHelper.connect(info, sshService);
	},

	runGremlinQueries(gremlinClient, queries) {
		return Promise.all(
			queries.map(query => {
				return gremlinClient.submit(query);
			}),
		);
	},

	parseScriptStatements(script) {
		const scriptStatements = script.split('\n\n').map(item => item.replace(/\.\s+/g, '.'));
		const [labels, edges] = partition(scriptStatements, statement => statement.startsWith('g.addV'));

		return { labels, edges };
	},
});

module.exports = applyToInstanceHelper;
