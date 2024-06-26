const connectionHelper = require('../reverse_engineering/connectionHelper');
const neptuneHelper = require('../reverse_engineering/neptuneHelper');

const applyToInstanceHelper = (_, aws, sshService) => ({
	async getGremlinClient(connectionInfo) {
		const neptuneInstance = await neptuneHelper.connect(aws, connectionInfo);
		const clusterInfo = await neptuneInstance.getBucketInfo();
		const info = {
			...connectionInfo,
			host: clusterInfo.ReaderEndpoint,
			port: clusterInfo.Port,
		};
		const connection = await connectionHelper.connect(info, sshService);
		return connection;
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
		const [labels, edges] = _.partition(scriptStatements, statement => statement.startsWith('g.addV'));

		return { labels, edges };
	},
});

module.exports = applyToInstanceHelper;
