const async = require('async');
const _ = require('lodash');
const connectionHelper = require('./connectionHelper');
const { convertGraphSonToJsonSchema } = require('./convertGraphsonToJsonSchema');
const neptuneHelper = require('../shared/awsNeptuneClient');
const queryHelper = require('./queryHelper');

module.exports = {
	disconnect: function (connectionInfo, logger, cb) {
		connectionHelper.close();
		neptuneHelper.close();
		cb();
	},

	testConnection: async function (connectionInfo, logger, cb, app) {
		try {
			logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);

			const neptuneInstance = await neptuneHelper.connect({ connectionInfo });
			const clusterInfo = await neptuneInstance.getBucketInfo();

			logger.log('info', { clusterInfo, message: 'Successfully connected to AWS' }, 'Test connection');

			const sshService = app.require('@hackolade/ssh-service');
			const info = {
				...connectionInfo,
				host: clusterInfo.ReaderEndpoint,
				port: clusterInfo.Port,
				debug: message => {
					logger.log('info', { message }, 'SSH Debug');
				},
			};
			const connection = await connectionHelper.connect(info, sshService);
			await connection.testConnection();

			logger.log('info', { 'message': 'Successfully connected to Neptune Database' }, 'Test connection');

			this.disconnect(connectionInfo, logger, () => {});

			cb();
		} catch (error) {
			this.disconnect(connectionInfo, logger, () => {});
			logger.log('error', prepareError(error));
			cb({ message: 'Connection error', stack: error.stack });
		}
	},

	getDbCollectionsNames: async function (connectionInfo, logger, cb, app) {
		try {
			logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);

			const neptuneInstance = await neptuneHelper.connect({ connectionInfo });
			const clusterInfo = await neptuneInstance.getBucketInfo();

			logger.log('info', { clusterInfo, message: 'Successfully connected to AWS' }, 'Get label names');

			const sshService = app.require('@hackolade/ssh-service');
			const info = {
				...connectionInfo,
				host: clusterInfo.ReaderEndpoint,
				port: clusterInfo.Port,
				debug: message => {
					logger.log('info', { message }, 'SSH Debug');
				},
			};
			const connection = await connectionHelper.connect(info, sshService);
			const query = queryHelper({
				connection,
			});
			const labels = await query.getLabels();
			logger.log('info', { labels, message: 'Labels successfully retrieved' }, 'Get label names');

			cb(null, [
				{
					dbName: clusterInfo.name,
					dbCollections: labels,
				},
			]);
		} catch (error) {
			logger.log('error', prepareError(error));
			cb(prepareError(error));
		}
	},

	getDbCollectionsData: async function (data, logger, cb) {
		try {
			logger.log('info', data, 'connectionInfo', data.hiddenKeys);

			const neptuneInstance = await neptuneHelper.connect({ connectionInfo: data });
			const connection = await connectionHelper.connect();
			const query = queryHelper({ connection });

			const collections = data.collectionData.collections;
			const dataBaseNames = data.collectionData.dataBaseNames;
			const fieldInference = data.fieldInference;
			const includeEmptyCollection = data.includeEmptyCollection;
			const recordSamplingSettings = data.recordSamplingSettings;
			let packages = {
				labels: [],
				relationships: [],
			};

			const bucketInfo = await neptuneInstance.getBucketInfo();

			await async.map(dataBaseNames, async dbName => {
				let labels = collections[dbName];
				const labelPackages = await getNodesData({
					sampling: {
						recordSamplingSettings,
						fieldInference,
						includeEmptyCollection,
					},
					query,
					dbName,
					labels,
					logger,
				});

				packages.labels.push(labelPackages.map(pack => ({ ...pack, bucketInfo })));
				labels = labelPackages.map(packageData => packageData.collectionName);

				const getLimit = quantity => getSampleDocSize(quantity, recordSamplingSettings);
				let relationshipSchema = await query.getRelationshipSchema(labels, getLimit);
				relationshipSchema = relationshipSchema.filter(data => {
					return labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1;
				});
				const relationships = await getRelationshipData({
					query,
					dbName,
					fieldInference,
					recordSamplingSettings,
					schema: relationshipSchema,
				});

				packages.relationships.push(relationships.map(pack => ({ ...pack, bucketInfo })));
			});

			cb(null, packages.labels, {}, [].concat(...packages.relationships));
		} catch (error) {
			logger.log('error', prepareError(error));
			cb(prepareError(error));
		}
	},
};

const getSampleDocSize = (count, recordSamplingSettings) => {
	if (recordSamplingSettings.active === 'absolute') {
		return Number(recordSamplingSettings.absolute.value);
	}

	const limit = Math.ceil((count * recordSamplingSettings.relative.value) / 100);

	return Math.min(limit, recordSamplingSettings.maxValue);
};

const isEmptyLabel = documents => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = ({ documents, rootTemplateArray = [] }) => {
	const template = rootTemplateArray.reduce((template, key) => ({ ...template, [key]: {} }), {});

	if (!_.isArray(documents)) {
		return template;
	}

	return documents.reduce((tpl, doc) => _.merge(tpl, doc), template);
};

const getNodesData = async ({ dbName, labels, logger, query, sampling }) => {
	const packages = await async.map(labels, async labelName => {
		logger.progress({ message: 'Start sampling data', containerName: dbName, entityName: labelName });

		const quantity = await query.getNodesCount(labelName);

		logger.progress({ message: 'Start getting data from graph', containerName: dbName, entityName: labelName });
		const limit = getSampleDocSize(quantity, sampling.recordSamplingSettings);

		const documents = await query.getNodes(labelName, limit);
		const graphSons = await query.getSchema('V', labelName, limit);
		const schema = getSchema(graphSons);
		const template = [];

		logger.progress({ message: `Data successfully retrieved`, containerName: dbName, entityName: labelName });

		return getLabelPackage({
			includeEmptyCollection: sampling.includeEmptyCollection,
			fieldInference: sampling.fieldInference,
			dbName,
			labelName,
			documents,
			schema,
			template,
		});
	});

	return sortPackagesByLabels({ labels, packages: packages.filter(Boolean) });
};

const sortPackagesByLabels = ({ labels, packages }) => {
	return [...packages].sort((a, b) => {
		const indexA = _.indexOf(labels, a['collectionName']);
		const indexB = _.indexOf(labels, b['collectionName']);
		if (_.isUndefined(indexA)) {
			return 1;
		}
		if (_.isUndefined(indexB)) {
			return -1;
		}

		return indexA - indexB;
	});
};

const getRelationshipData = ({ query, schema, dbName, recordSamplingSettings, fieldInference }) => {
	return async.map(schema, async chain => {
		const quantity = await query.getCountRelationshipsData(chain.start, chain.relationship, chain.end);
		const count = getSampleDocSize(quantity, recordSamplingSettings);
		const documents = await query.getRelationshipData(chain.start, chain.relationship, chain.end, count);
		const graphSons = await query.getSchema('E', chain.relationship, count);
		const schema = getSchema(graphSons);
		const template = [];

		let packageData = {
			dbName,
			parentCollection: chain.start,
			relationshipName: chain.relationship,
			childCollection: chain.end,
			documents,
			validation: {
				jsonSchema: schema,
			},
		};

		if (fieldInference.active === 'field') {
			packageData.documentTemplate = getTemplate({ documents, rootTemplateArray: template });
		}

		return packageData;
	});
};

const getLabelPackage = ({
	dbName,
	labelName,
	documents,
	template,
	schema,
	includeEmptyCollection,
	fieldInference,
}) => {
	let packageData = {
		dbName,
		collectionName: labelName,
		documents,
		views: [],
		emptyBucket: false,
		validation: {
			jsonSchema: schema,
		},
		bucketInfo: {},
	};

	if (fieldInference.active === 'field') {
		packageData.documentTemplate = getTemplate({ documents, rootTemplateArray: template });
	}

	if (includeEmptyCollection || !isEmptyLabel(documents)) {
		return packageData;
	} else {
		return null;
	}
};

const prepareError = error => {
	return {
		message: error.message,
		stack: error.stack,
	};
};

const getSchema = graphSons => {
	return graphSons.reduce(
		(jsonSchema, graphSon) => {
			const schema = convertGraphSonToJsonSchema(graphSon);

			return {
				...jsonSchema,
				properties: {
					...jsonSchema.properties,
					...schema.properties,
				},
			};
		},
		{
			properties: {},
		},
	);
};
