'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

const defaultRouter = createCoreRouter('api::app-user.app-user', {
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

const customRouter = {
  routes: [
    {
      method: 'GET',
      path: '/app-users/:id/contacts',
      handler: 'app-user.contacts',
      config: {
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/app-users/:id/profile-image',
      handler: 'app-user.uploadProfileImage',
      config: {
        policies: ['global::app-api-key'],
        middlewares: [],
      },
    },
  ],
};

module.exports = {
  get prefix() {
    return defaultRouter.prefix;
  },
  get routes() {
    return customRouter.routes.concat(defaultRouter.routes);
  },
};
