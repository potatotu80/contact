'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::contact.contact', {
  config: {
    find: {
      policies: ['global::app-api-key'],
    },
    findOne: {
      policies: ['global::app-api-key'],
    },
    create: {
      policies: ['global::app-api-key'],
    },
    update: {
      policies: ['global::app-api-key'],
    },
    delete: {
      policies: ['global::app-api-key'],
    },
  },
});
