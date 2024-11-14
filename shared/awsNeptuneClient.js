const { head } = require('lodash');
const { NeptuneClient, DescribeDBClustersCommand } = require('@aws-sdk/client-neptune');
const { hckFetchAwsSdkHttpHandler } = require('@hackolade/fetch');

let neptuneInstance = null;

const awsNeptuneClient = {
	connect({ connectionInfo = {} }) {
		if (neptuneInstance) {
			return neptuneInstance;
		}

		const { dbClusterIdentifier, region, accessKeyId, secretAccessKey, sessionToken, queryRequestTimeout } =
			connectionInfo;

		const neptuneClient = new NeptuneClient({
			apiVersion: '2014-10-31',
			region,
			credentials: {
				accessKeyId,
				secretAccessKey,
				sessionToken,
			},
			requestHandler: hckFetchAwsSdkHttpHandler({ requestTimeout: queryRequestTimeout }),
		});

		neptuneInstance = {
			close() {
				neptuneClient.destroy();
			},

			async getCluster() {
				const result = await neptuneClient.send(
					new DescribeDBClustersCommand({ DBClusterIdentifier: dbClusterIdentifier }),
				);
				return head(result.DBClusters);
			},

			async getBucketInfo() {
				let options = {
					name: dbClusterIdentifier,
					'source-region': region,
				};
				const clusterInfo = await this.getCluster();

				if (!clusterInfo) {
					return options;
				}

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
					const promoTier = instance['PromotionTier'];
					return {
						dbInstanceIdentifier: instance['DBInstanceIdentifier'],
						dbInstanceRole: instance['IsClusterWriter'] ? 'Writer' : 'Reader',
						PromotionTier: isNaN(promoTier) ? 'No preference' : `tier-${promoTier}`,
					};
				});

				return options;
			},
		};

		return neptuneInstance;
	},

	close() {
		if (neptuneInstance) {
			neptuneInstance.close();
			neptuneInstance = null;
		}
	},
};

module.exports = awsNeptuneClient;
