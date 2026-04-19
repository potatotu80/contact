'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

const defaultRouter = createCoreRouter('api::app-user.app-user');

const customRouter = {
  routes: [
    {
      method: 'GET',
      path: '/app-users/:id/contacts',
      handler: 'app-user.contacts',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/app-users/:id/profile-image',
      handler: 'app-user.uploadProfileImage',
      config: {
        policies: [],
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
