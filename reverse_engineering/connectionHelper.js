const fs = require('fs');
const gremlin = require('gremlin');

let graphName = 'g';

let connection = null;

const connect = async (info, sshService) => {
	if (connection) {
		return connection;
	}

	let sshTunnel;
	const { options } = await sshService.openTunnel({
		sshAuthMethod: 'IDENTITY_FILE',
		sshTunnelHostname: info.ssh_host,
		sshTunnelPort: info.ssh_port || 22,
		sshTunnelUsername: info.ssh_user || 'ec2-user',
		sshTunnelIdentityFile: info.ssh_key_file,
		sshTunnelPassphrase: info.ssh_key_passphrase,
		host: info.host,
		port: info.port,
		keepAlive: true,
		debug: info.debug,
	});

	info = {
		...info,
		...options,
	};

	const data = await connectToInstance(info);
	connection = createConnection({ ...data, sshService });

	return connection;
};

const close = () => {
	if (connection) {
		connection.close();
		connection = null;
	}
};

const connectToInstance = async info => {
	const host = info.host;
	const port = info.port;
	const clientOptions = {
		traversalSource: graphName,
		rejectUnauthorized: false,
	};
	const uri = `wss://${host}:${port}/gremlin`;
	const client = new gremlin.driver.Client(uri, clientOptions);
	const graphSonClient = new gremlin.driver.Client(uri, {
		...clientOptions,
		reader: createPlainGraphSonReader(),
	});

	await Promise.all([client.open(), graphSonClient.open()]);

	return {
		client,
		graphSonClient,
	};
};

const createPlainGraphSonReader = () => ({
	read(obj) {
		return {
			...obj,
			result: {
				...obj.result,
				data: obj.result?.data?.['@value'],
			},
		};
	},
});

const createConnection = ({ client, graphSonClient, sshService }) => {
	let closed = false;

	return {
		testConnection() {
			if (!client) {
				return Promise.reject(new Error('Connection error'));
			}

			return this.submit(`${graphName}.V()`);
		},

		async submit(query) {
			return client.submit(query);
		},

		async submitGraphson(query) {
			return graphSonClient.submit(query);
		},

		async close() {
			if (client) {
				await client.close();
			}
			if (graphSonClient) {
				await graphSonClient.close();
			}
			if (sshService) {
				await sshService.closeConsumer();
			}

			closed = true;
		},

		closed() {
			return closed;
		},
	};
};

module.exports = {
	connect,
	close,
};
