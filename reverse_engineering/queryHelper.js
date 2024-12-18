const _ = require('lodash');

module.exports = ({ connection }) => {
	return {
		async getLabels() {
			const response = await connection.submit(`g.V().label().dedup().toList()`);

			return response.toArray();
		},
		async getNodesCount(label) {
			const response = await connection.submit(`g.V().hasLabel('${label}').count().next()`);

			return response.first();
		},

		async getNodes(label, limit = 100) {
			const response = await connection.submit(
				`g.V().hasLabel('${label}').limit(${limit}).valueMap(true).toList()`,
			);

			return response.toArray().map(getItemProperties);
		},

		async getSchema(gremlinElement, label, limit = 100) {
			const response = await connection.submitGraphson(
				`g.${gremlinElement}().hasLabel('${label}').limit(${limit}).valueMap()`,
			);

			return response.toArray();
		},

		async getRelationshipSchema(labels, getLimit) {
			const relationshipPromises = labels.map(async label => {
				const relationshipsCount = await connection.submit(`g.V().hasLabel('${label}').outE().count()`);

				const limit = getLimit(relationshipsCount.toArray()[0]) || 100;

				const relationshipData = await connection.submit(
					`g.V().hasLabel('${label}').outE().limit(${limit}).as('edge').inV().as('end').select('edge', 'end').by(label).dedup().toList()`,
				);

				const relationships = relationshipData.toArray();

				if (_.isEmpty(relationships)) {
					return [];
				}

				return relationships.map(relationshipData => ({
					start: label,
					relationship: relationshipData.get('edge'),
					end: relationshipData.get('end'),
				}));
			});

			return (await Promise.all(relationshipPromises)).flat();
		},

		async getCountRelationshipsData(start, relationship, end) {
			const response = await connection.submit(`g.E().hasLabel('${relationship}').where(
				and(
					outV().label().is(eq('${start}')),
					inV().label().is(eq('${end}'))
				)
			).count().next()`);

			return response.toArray();
		},

		async getRelationshipData(start, relationship, end, limit = 100) {
			const response = await connection.submit(`g.E().hasLabel('${relationship}').where(
					and(
						outV().label().is(eq('${start}')),
						inV().label().is(eq('${end}'))
					)
				).limit(${limit}).valueMap(true).toList()`);

			return response.toArray().map(getItemProperties);
		},
	};
};

const handleMap = map => {
	return Array.from(map).reduce((obj, [key, value]) => {
		if (_.isMap(value)) {
			return Object.assign(obj, { [key]: handleMap(value) });
		}

		return Object.assign(obj, { [key]: value });
	}, {});
};

const getItemProperties = propertiesMap => {
	return Array.from(propertiesMap).reduce((obj, [key, rawValue]) => {
		if (!_.isString(key)) {
			return obj;
		}

		const value = _.isArray(rawValue) ? _.first(rawValue) : rawValue;

		if (_.isMap(value)) {
			return Object.assign(obj, { [key]: handleMap(value) });
		}

		return Object.assign(obj, { [key]: value });
	}, {});
};
