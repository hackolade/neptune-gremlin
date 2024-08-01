'use strict';

const connectionHelper = require('./connectionHelper');
const convertGraphSonToJsonSchema = require('./convertGraphsonToJsonSchema');
const neptuneHelper = require('./neptuneHelper');
const queryHelper = require('./queryHelper');

module.exports = {
	disconnect: function (connectionInfo, logger, cb, app) {
		connectionHelper.close();
		neptuneHelper.close();
		cb();
	},

	testConnection: async function (connectionInfo, logger, cb, app) {
		try {
			logger.clear();
			logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);

			const neptuneInstance = await neptuneHelper.connect(app.require('aws-sdk'), connectionInfo);
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
			logger.clear();
			logger.log('info', connectionInfo, 'connectionInfo', connectionInfo.hiddenKeys);

			const neptuneInstance = await neptuneHelper.connect(app.require('aws-sdk'), connectionInfo);
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
				_: app.require('lodash'),
				connection,
			});
			const labels = await query.getLabels();
			logger.log('info', { labels, message: 'Labels successfully rertieved' }, 'Get label names');

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

	getDbCollectionsData: async function (data, logger, cb, app) {
		try {
			logger.log('info', data, 'connectionInfo', data.hiddenKeys);
			const async = app.require('async');
			const _ = app.require('lodash');
			const neptuneInstance = await neptuneHelper.connect();
			const connection = await connectionHelper.connect();
			const query = queryHelper({ _, connection });

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
					async,
					_,
				});

				packages.labels.push(labelPackages.map(pack => ({ ...pack, bucketInfo })));
				labels = labelPackages.map(packageData => packageData.collectionName);

				const getLimit = quantity => getSampleDocSize(quantity, recordSamplingSettings);
				let relationshipSchema = await query.getRelationshipSchema(labels, getLimit);
				relationshipSchema = relationshipSchema.filter(data => {
					return labels.indexOf(data.start) !== -1 && labels.indexOf(data.end) !== -1;
				});
				const relationships = await getRelationshipData({
					_,
					async,
					query,
					dbName,
					fieldInference,
					recordSamplingSettings,
					schema: relationshipSchema,
				});

				packages.relationships.push(relationships.map(pack => ({ ...pack, bucketInfo })));
			});

			cb(null, packages.labels, {}, [].concat.apply([], packages.relationships));
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

const isEmptyLabel = (_, documents) => {
	if (!Array.isArray(documents)) {
		return true;
	}

	return documents.reduce((result, doc) => result && _.isEmpty(doc), true);
};

const getTemplate = (_, documents, rootTemplateArray = []) => {
	const template = rootTemplateArray.reduce((template, key) => Object.assign({}, template, { [key]: {} }), {});

	if (!_.isArray(documents)) {
		return template;
	}

	return documents.reduce((tpl, doc) => _.merge(tpl, doc), template);
};

const getNodesData = async ({ _, async, dbName, labels, logger, query, sampling }) => {
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

		const packageData = getLabelPackage({
			includeEmptyCollection: sampling.includeEmptyCollection,
			fieldInference: sampling.fieldInference,
			dbName,
			labelName,
			documents,
			schema,
			template,
			_,
		});

		return packageData;
	});

	const sortedPackages = sortPackagesByLabels(_, labels, packages.filter(Boolean));

	return sortedPackages;
};

const sortPackagesByLabels = (_, labels, packages) => {
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

const getRelationshipData = ({ _, async, query, schema, dbName, recordSamplingSettings, fieldInference }) => {
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
			packageData.documentTemplate = getTemplate(_, documents, template);
		}

		return packageData;
	});
};

const getLabelPackage = ({
	_,
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
		packageData.documentTemplate = getTemplate(_, documents, template);
	}

	if (includeEmptyCollection || !isEmptyLabel(_, documents)) {
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
