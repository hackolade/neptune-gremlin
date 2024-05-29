let neptuneInstance;

const neptuneHelper = {
	connect(aws, info) {
		if (neptuneInstance) {
			return neptuneInstance;
		}

		let awsOptions = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'region'].reduce((options, key) => {
			if (!info[key]) {
				return options;
			}

			return {
				...options,
				[key]: info[key],
			};
		}, {});

		aws.config.update(awsOptions);

		const dbClusterIdentifier = info.dbClusterIdentifier;
		const clusterRegion = info.region;

		const neptune = new aws.Neptune({
			apiVersion: '2014-10-31',
			region: clusterRegion,
		});

		neptuneInstance = {
			async getCluster() {
				const result = await describeDBClusters(neptune, dbClusterIdentifier);

				return result.DBClusters[0];
			},

			async getBucketInfo() {
				let options = {
					name: dbClusterIdentifier,
					'source-region': clusterRegion,
				};
				const clusterInfo = await this.getCluster();

				if (!clusterInfo) {
					return options;
				}
				const dbInstance = clusterInfo['DBClusterMembers'][0];
				options.DBClusterArn = clusterInfo['DBClusterArn'];
				options.Endpoint = clusterInfo['Endpoint'];
				options.ReaderEndpoint = clusterInfo['ReaderEndpoint'];
				options.MultiAZ = clusterInfo['MultiAZ'];
				options.Port = clusterInfo['Port'];
				options.DBParameterGroupName = clusterInfo['DBSubnetGroup'];
				options.DBClusterParameterGroup = clusterInfo['DBClusterParameterGroup'];
				options.DbClusterResourceId = clusterInfo['DbClusterResourceId'];
				options.IAMDatabaseAuthenticationEnabled = clusterInfo['IAMDatabaseAuthenticationEnabled'];
				options.StorageEncrypted = clusterInfo['StorageEncrypted'];
				options.BackupRetentionPeriod = String(clusterInfo['BackupRetentionPeriod']);

				options.dbInstances = clusterInfo['DBClusterMembers'].map(instance => {
					return {
						dbInstanceIdentifier: instance['DBInstanceIdentifier'],
						dbInstanceRole: instance['IsClusterWriter'] ? 'Writer' : 'Reader',
						PromotionTier: isNaN(instance['PromotionTier'])
							? 'No preference'
							: `tier-${instance['PromotionTier']}`,
					};
				});

				return options;
			},
		};

		return neptuneInstance;
	},
	close() {
		if (neptuneInstance) {
			neptuneInstance = null;
		}
	},
};

const describeDBClusters = (neptune, dbClusterIdentifier) => {
	return new Promise((resolve, reject) => {
		neptune.describeDBClusters(
			{
				DBClusterIdentifier: dbClusterIdentifier,
			},
			(err, result) => {
				if (err) {
					reject(err);
				} else {
					resolve(result);
				}
			},
		);
	});
};

const describeDBInstances = (neptune, { dBInstanceIdentifier, dbClusterIdentifier }) => {
	return new Promise((resolve, reject) => {
		const filters = [];

		if (dbClusterIdentifier) {
			filters.push({
				Name: 'db-cluster-id',
				Values: [dbClusterIdentifier],
			});
		}

		neptune.describeDBInstances(
			{
				DBInstanceIdentifier: dBInstanceIdentifier,
				Filters: filters,
			},
			(err, result) => {
				if (err) {
					reject(err);
				} else {
					resolve(result.DBInstances);
				}
			},
		);
	});
};

module.exports = neptuneHelper;
